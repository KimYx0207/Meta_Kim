/**
 * enforce-agent-dispatch.mjs — Meta_Kim Spine PreToolUse guard.
 *
 * Responsibilities:
 *   1. Spine-active runs: gate execution tools until the right meta-agents have
 *      been dispatched per stage requirements.
 *   2. Meta-agent readonly enforcement: even when spine is inactive (or skipped),
 *      a caller identified as a meta-* agent must not directly mutate the
 *      workspace via Edit / Write / MultiEdit / NotebookEdit / Bash. They must
 *      dispatch down to an execution worker instead.
 *   3. Capability-first gate: Agent dispatches at or after the execution stage
 *      require a prior capability search recorded in spine state. Forces the
 *      capability-first discovery contract instead of hardcoded agent names.
 *   4. Read-only inspection fast-path (EB-002, v2.3.1): during Critical /
 *      Fetch / Review / Meta-Review / Verification stages, Bash commands that
 *      match the stage's read-only whitelist can bypass the stage-requirements
 *      check. Critical / Fetch use a narrower inspection list; verifier stages
 *      allow validation commands such as `npm run meta:check` and `node --check`.
 *      Commands not on the whitelist still fall through to existing checks.
 *
 * Two-gate disconnect (intentional contract — read carefully):
 *
 *   META_KIM_META_ENFORCEMENT_MODE        (meta-readonly gate)
 *     Default: "progressive" — warn for 7 days, then block
 *     Rationale: meta-agents existed before this contract was added,
 *                grace period lets teams migrate without breakage
 *
 *   META_KIM_CAPABILITY_GATE              (capability-first gate)
 *     Default: "progressive"
 *     Rationale: aligned with meta-readonly mode pattern for consistency;
 *                operators set =block to enforce immediately, =off to disable
 *
 * Override knobs (precedence order):
 *   META_KIM_HOOK_SKIP                  → skip hook entirely (debug)
 *   META_KIM_META_ENFORCEMENT_MODE     → meta-readonly gate mode
 *   META_KIM_META_ENFORCEMENT_GRACE_DAYS → meta-readonly grace days (default 7)
 *   META_KIM_CAPABILITY_GATE           → capability-first gate mode (warn|block|progressive|off)
 *   META_KIM_CAPABILITY_GATE_GRACE_DAYS → capability gate grace days (default 7)
 *   META_KIM_HOOK_RUNTIME              → optional override of runtime detection
 *
 * Environment knobs:
 *   META_KIM_HOOK_SKIP
 *     Truthy ("1", "true", any non-empty non-"empty"/"0"/"false") -> skip hook.
 *
 *   META_KIM_META_ENFORCEMENT_MODE  (controls meta-* readonly enforcement)
 *     "warn"
 *         Log to stderr and allow the tool call. Use for soft rollout.
 *     "block"
 *         Deny outright when a meta-* caller attempts mutation. Final state.
 *     "progressive" (default)
 *         For the first META_KIM_META_ENFORCEMENT_GRACE_DAYS (default 7) days
 *         since the run started, behave as "warn"; afterwards behave as
 *         "block". Lets teams adopt the new contract without breakage.
 *
 *   META_KIM_META_ENFORCEMENT_GRACE_DAYS
 *     Integer day count for the progressive grace window. Default 7.
 *
 *   META_KIM_CAPABILITY_GATE  (controls capability-first gate on Agent dispatch)
 *     "warn"               — log to stderr and allow.
 *     "block"              — deny Agent dispatch in execution / review / meta_review
 *                            / verification / evolution when
 *                            fetchRecord.capabilitySearchPerformed !== true.
 *     "progressive" (default)
 *                          — For the first META_KIM_CAPABILITY_GATE_GRACE_DAYS
 *                            (default 7) days since the run started, behave as
 *                            "warn"; afterwards behave as "block". Mirrors the
 *                            meta-readonly progressive rollout.
 *     "off"                — skip the gate entirely (not recommended).
 *
 *   META_KIM_CAPABILITY_GATE_GRACE_DAYS
 *     Integer day count for the capability-gate progressive grace window. Default 7.
 *
 *   META_KIM_HOOK_RUNTIME
 *     Override runtime detection for cross-runtime deny() output schema.
 *     Accepted values: "claude" | "codex" | "cursor". If unset, the hook
 *     inspects process.argv[1] for ".codex/", ".cursor/", or ".claude/"
 *     and falls back to Claude.
 *
 *   CLAUDE_SUBAGENT_TYPE
 *     Runtime-injected hint for the current subagent's type. When this starts
 *     with "meta-" we treat the caller as a meta-agent without further parsing.
 */

import process from "node:process";
import { join, normalize } from "node:path";
import { readJsonFromStdin, extractFilePath } from "./utils.mjs";
import { isReadOnlyBash, classifyBashCommand } from "./bash-readonly-whitelist.mjs";
import {
  readSpineState,
  checkCapabilityNodeBindings,
  checkPreExecutionReadiness,
  isExecutionTool,
  isReadOnlyTool,
  recordDispatch,
  writeSpineState,
  checkStageRequirements,
  checkChoiceSurfaceGate,
  STAGE_META_AGENT_MAP,
  extractMetaAgentName,
  recordSkippedHook,
  getGovernanceFlow,
} from "./spine-state.mjs";
import {
  getSkipRule,
  hasSimpleKeyword,
  recordSkip,
  formatSkipReason,
  getHookImpact,
  SKIP_DECISION,
} from "./skip-reminder.mjs";

const cwd = process.cwd();
const payload = await readJsonFromStdin();
const toolName = payload?.tool_name ?? "";
const toolInput = payload?.tool_input ?? {};

const SPINE_STATE_DIR =
  process.env.META_KIM_SPINE_STATE_DIR || ".meta-kim/state/default/spine";
const targetPath = extractFilePath(payload) || "";

function isSpineStateWrite() {
  // Windows paths are case-insensitive: comparing the lowercased, normalized
  // suffix prevents a meta-agent from sneaking writes via mixed case such as
  // "Spine-State.JSON".
  const normalized = normalize(targetPath || "").toLowerCase();
  const spineFile = normalize("spine-state.json").toLowerCase();
  if (normalized.endsWith(spineFile)) return true;
  // Also reject anything under a ".../spine/..." segment so adjacent ledger
  // files do not become a back door.
  return /[\\/]spine[\\/]/.test(normalized);
}

function isPlanningFile() {
  const planningFiles = ["task_plan.md", "findings.md", "progress.md"];
  if (planningFiles.some((f) => targetPath.endsWith(f))) return true;
  const cmd = (toolInput?.command || "").toLowerCase();
  return planningFiles.some((f) => cmd.includes(f.toLowerCase()));
}

/**
 * Detect which runtime is hosting this hook so that deny() can emit the right
 * payload schema. Priority:
 *   1. META_KIM_HOOK_RUNTIME env var (explicit override).
 *   2. Inspect process.argv[1] for a runtime-specific path segment, using
 *      path.sep so the check works on both POSIX and Windows.
 *   3. Default to "claude".
 *
 * @returns {"claude" | "codex" | "cursor"}
 */
export function detectHookRuntime() {
  const override = (process.env.META_KIM_HOOK_RUNTIME || "").toLowerCase().trim();
  if (override === "claude" || override === "codex" || override === "cursor") {
    return override;
  }

  const scriptPath = normalize(process.argv[1] || "");
  const sep = process.platform === "win32" ? "\\" : "/";
  // Build cross-OS segment matchers. Lower-case both sides to be safe on
  // Windows where path casing is unreliable.
  const lowered = scriptPath.toLowerCase();
  const codexSeg = `${sep}.codex${sep}`.toLowerCase();
  const cursorSeg = `${sep}.cursor${sep}`.toLowerCase();
  const claudeSeg = `${sep}.claude${sep}`.toLowerCase();

  // Also check forward-slash variants because Node sometimes preserves the
  // invocation path verbatim on Windows.
  if (lowered.includes(codexSeg) || lowered.includes("/.codex/")) return "codex";
  if (lowered.includes(cursorSeg) || lowered.includes("/.cursor/")) return "cursor";
  if (lowered.includes(claudeSeg) || lowered.includes("/.claude/")) return "claude";

  return "claude";
}

function deny(reason) {
  const runtime = detectHookRuntime();
  const message = `[Meta_Kim Spine] ${reason}`;

  if (runtime === "cursor") {
    // Cursor hook contract: JSON on stdout with permission/user_message/agent_message,
    // plus exit code 2 and stderr text for older shells.
    process.stdout.write(
      JSON.stringify({
        permission: "deny",
        user_message: message,
        agent_message: message,
      }),
    );
    process.stderr.write(`${message}\n`);
    return 2;
  }

  // Claude and Codex share the hookSpecificOutput JSON contract.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: message,
      },
    }),
  );
  return 0;
}

function exitAfterDeny(reason) {
  process.exit(deny(reason));
}

function isAgentDispatchTool(name) {
  return name === "Agent" || name === "spawn_agent";
}

function dispatchIntentText(input) {
  return [
    input?.description,
    input?.prompt,
    input?.message,
    input?.agent_type,
    input?.subagent_type,
    JSON.stringify(input?.items || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function isExecutionDispatchIntent(input, metaName) {
  if (metaName && isMetaAgent(metaName)) return false;

  const target = String(
    input?.agent_type || input?.subagent_type || input?.type || "",
  )
    .toLowerCase()
    .trim();
  const executionTargets = new Set([
    "backend",
    "frontend",
    "worker",
    "test",
    "verify",
  ]);
  if (executionTargets.has(target)) return true;

  const text = dispatchIntentText(input);
  return /\b(implement|write|create|build|test|fix|debug|execute|run|generate|produce|code)\b/i.test(
    text,
  );
}

/**
 * Check if an agent is a meta-agent (governance layer)
 * Meta-agents are identified by the "meta-" prefix in their name
 * They should NOT be used for direct execution work
 *
 * @param {string} agentName - The agent name to check
 * @returns {boolean} - true if this is a meta-agent
 */
function isMetaAgent(agentName) {
  if (!agentName || typeof agentName !== "string") return false;
  const lowerName = agentName.toLowerCase();
  // Check for meta- prefix in various formats
  return (
    lowerName.startsWith("meta-") ||
    lowerName.includes("meta-warden") ||
    lowerName.includes("meta-prism") ||
    lowerName.includes("meta-conductor") ||
    lowerName.includes("meta-genesis") ||
    lowerName.includes("meta-artisan") ||
    lowerName.includes("meta-sentinel") ||
    lowerName.includes("meta-librarian") ||
    lowerName.includes("meta-scout") ||
    lowerName.includes("meta-chrysalis")
  );
}

/**
 * Emit a warning if a meta-agent is being dispatched for execution work
 *
 * @param {string} agentName - The agent being dispatched
 * @param {string} stage - Current stage
 */
function warnMetaAgentExecution(agentName, stage) {
  const warning = `\n⚠️  [Meta_Kim] WARNING: Meta-agent "${agentName}" may be used for execution work in stage "${stage}"\n` +
    `Meta-agents (layer='meta') are for governance coordination only.\n` +
    `They should NOT perform direct execution tasks like writing code or running tests.\n` +
    `Use governance meta owners plus run-scoped matchedCapabilities/capabilityBindings for public Meta_Kim execution capability.\n` +
    `If this is governance work (coordination, review, synthesis), you may ignore this warning.\n`;

  process.stderr.write(warning);
}

/**
 * Infer the caller's identity (which agent is making the current tool call).
 * Priority order:
 *   1. CLAUDE_SUBAGENT_TYPE environment variable (runtime-injected).
 *   2. Latest entry in spine state's dispatchChain (most recently dispatched
 *      owner for the current stage).
 *   3. Conservative fallback: null. The caller treats null as "unknown" and
 *      degrades to warn-mode so that legitimate user activity is not blocked
 *      by a parsing miss.
 *
 * @param {object|null} state
 * @returns {{ name: string|null, source: string }}
 */
function inferCallerIdentity(state) {
  const envHint = process.env.CLAUDE_SUBAGENT_TYPE;
  if (envHint && typeof envHint === "string" && envHint.trim()) {
    return { name: envHint.trim(), source: "env" };
  }

  const chain = state?.dispatchChain;
  const stage = state?.currentStage;
  if (chain && stage && Array.isArray(chain[stage]) && chain[stage].length) {
    // The most recently appended entry is the active owner for this stage.
    const latest = chain[stage][chain[stage].length - 1];
    if (latest) return { name: latest, source: "spine_chain" };
  }

  // Walk back through all stages, newest first, as a secondary signal.
  if (chain && typeof chain === "object") {
    const stages = Object.keys(chain);
    for (let i = stages.length - 1; i >= 0; i--) {
      const list = chain[stages[i]];
      if (Array.isArray(list) && list.length) {
        return { name: list[list.length - 1], source: "spine_chain_walk" };
      }
    }
  }

  return { name: null, source: "unknown" };
}

/**
 * Resolve a gate's effective mode when the raw value is "progressive".
 *
 * Shared by both the meta-readonly gate (META_KIM_META_ENFORCEMENT_MODE) and
 * the capability-first gate (META_KIM_CAPABILITY_GATE), so they apply the same
 * grace-window semantics:
 *
 *   - During the first `defaultGraceDays` days since the run started, return
 *     "warn" (soft rollout).
 *   - After the grace window expires, return "block" (final state).
 *   - If no run-start anchor is available, return "warn" conservatively.
 *
 * The grace-days value can be overridden via the env var named by
 * `graceDaysEnvVar`. Non-finite or negative overrides fall back to the
 * provided default.
 *
 * @param {string} modeRaw - Already-lowercased mode value (e.g. "progressive").
 *                           Callers should pass the raw env value normalized to
 *                           lowercase + trimmed.
 * @param {string} graceDaysEnvVar - Name of the env var holding the override
 *                                    grace-day count.
 * @param {number} defaultGraceDays - Default grace days when the env var is
 *                                    unset or invalid.
 * @param {object|null} state - Spine state (used to read run-start timestamps).
 * @returns {"warn" | "block"}
 */
function resolveGracedMode(modeRaw, graceDaysEnvVar, defaultGraceDays, state) {
  if (modeRaw === "warn") return "warn";
  if (modeRaw === "block") return "block";

  // progressive (or unknown) → time-bounded warn → block transition.
  const graceDaysRaw = parseInt(
    process.env[graceDaysEnvVar] || String(defaultGraceDays),
    10,
  );
  const graceDays =
    Number.isFinite(graceDaysRaw) && graceDaysRaw >= 0
      ? graceDaysRaw
      : defaultGraceDays;

  const startedAt =
    state?.runStartTimestamp || state?.triggeredAt || state?.startedAt || null;
  if (!startedAt) {
    // No anchor: be conservative and warn.
    return "warn";
  }
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) {
    process.stderr.write(
      `\n⚠️  [Meta_Kim graced-mode] invalid runStartTimestamp ${JSON.stringify(startedAt)}; degrading to warn\n`,
    );
    return "warn";
  }
  const elapsedDays = (Date.now() - startedMs) / (1000 * 60 * 60 * 24);
  return elapsedDays < graceDays ? "warn" : "block";
}

/**
 * Decide which enforcement mode is active right now.
 *
 *   warn        -> log + allow
 *   block       -> deny
 *   progressive -> warn during grace window, block after
 *
 * Returns the resolved mode string: "warn" or "block".
 */
function resolveEnforcementMode(state) {
  const raw = (process.env.META_KIM_META_ENFORCEMENT_MODE || "progressive")
    .toLowerCase()
    .trim();

  return resolveGracedMode(
    raw,
    "META_KIM_META_ENFORCEMENT_GRACE_DAYS",
    7,
    state,
  );
}

/**
 * Enforce meta-* readonly contract for execution tools.
 *
 * Edit / Write / MultiEdit / NotebookEdit / MCP-write → deny (meta cannot
 *   directly mutate the workspace; it must dispatch downward).
 * Bash → allow if isReadOnlyBash(command) is true; otherwise apply mode.
 *
 * Calls process.exit(0) after writing a deny payload. Returns true if the
 * caller should stop processing (because we already emitted output and exited),
 * false otherwise.
 *
 * @param {string} toolName
 * @param {object} input
 * @param {object|null} state
 * @param {{ name: string|null, source: string }} caller
 */
function enforceMetaReadonly(toolName, input, state, caller) {
  const callerLabel = caller.name || "unknown-meta-caller";

  // Bash: classify first; read-only commands pass through silently.
  if (toolName === "Bash") {
    const command = input?.command || "";
    const verdict = classifyBashCommand(command);
    if (verdict.readOnly) return false; // safe, fall through

    const mode = resolveEnforcementMode(state);
    const reasonText =
      `Meta-agent "${callerLabel}" attempted to run a non-read-only Bash command. ` +
      `Reason: ${verdict.reason}. Offending segment: ${verdict.segment || command}. ` +
      `Meta-agents must dispatch to an execution worker (e.g. Agent tool) instead of running mutating commands directly.`;

    if (mode === "warn") {
      process.stderr.write(`\n⚠️  [Meta_Kim meta-readonly:warn] ${reasonText}\n`);
      return false; // allow
    }
    exitAfterDeny(reasonText);
  }

  // Any direct file-mutation tool is denied for meta-* callers.
  const mutationTools = new Set([
    "Edit",
    "Write",
    "MultiEdit",
    "NotebookEdit",
    "apply_patch",
  ]);
  if (mutationTools.has(toolName)) {
    const mode = resolveEnforcementMode(state);
    const reasonText =
      `Meta-agent "${callerLabel}" attempted to use ${toolName} directly. ` +
      `Meta-agents must dispatch this work to an execution worker via the Agent tool ` +
      `(e.g. dispatch to a frontend/backend/test specialist) instead of editing files themselves.`;
    if (mode === "warn") {
      process.stderr.write(`\n⚠️  [Meta_Kim meta-readonly:warn] ${reasonText}\n`);
      return false;
    }
    exitAfterDeny(reasonText);
  }

  // MCP write-like operations: best-effort heuristic — anything with create/update/
  // delete/write/push in the tool name from MCP namespaces.
  if (
    typeof toolName === "string" &&
    /(create|update|delete|write|push|publish|merge|patch|put)/i.test(toolName) &&
    /^mcp__/i.test(toolName)
  ) {
    const mode = resolveEnforcementMode(state);
    const reasonText =
      `Meta-agent "${callerLabel}" attempted MCP mutation via ${toolName}. ` +
      `Dispatch to an execution agent instead.`;
    if (mode === "warn") {
      process.stderr.write(`\n⚠️  [Meta_Kim meta-readonly:warn] ${reasonText}\n`);
      return false;
    }
    exitAfterDeny(reasonText);
  }

  return false;
}

/**
 * Determine if this hook should be skipped based on configuration and context
 * Checks (in priority order):
 * 1. META_KIM_HOOK_SKIP environment variable (explicit user override)
 * 2. Simple mode flag in spine state
 * 3. Simple keywords in prompt (auto-detection)
 * 4. Governance flow rules (PRIN-ST: configuration-based)
 *
 * @param {object} state - Current spine state
 * @param {string} userPrompt - User's prompt for analysis
 * @returns {object} - { shouldSkip: boolean, reason: string, source: string }
 */
function shouldSkipHook(state, userPrompt) {
  const hookName = "enforce-agent-dispatch";
  const envSkip = process.env.META_KIM_HOOK_SKIP;

  // Priority 1: Explicit environment variable (user override)
  if (envSkip && envSkip !== "empty" && envSkip !== "0" && envSkip !== "false") {
    return {
      shouldSkip: true,
      reason: formatSkipReason("env_var"),
      source: "env_var",
    };
  }

  // Priority 2: Auto-detect simple keywords in prompt
  if (hasSimpleKeyword(userPrompt)) {
    return {
      shouldSkip: true,
      reason: formatSkipReason("keyword"),
      source: "keyword",
    };
  }

  // Priority 4: Governance flow rules (PRIN-ST configuration)
  const governanceFlow = getGovernanceFlow(state);
  const skipDecision = getSkipRule(hookName, governanceFlow);

  if (skipDecision === SKIP_DECISION.SKIP) {
    return {
      shouldSkip: true,
      reason: formatSkipReason("governance_flow", governanceFlow),
      source: "governance_flow",
    };
  }

  return { shouldSkip: false, reason: "", source: null };
}

let state = await readSpineState(cwd);

if (!state && isSpineStateWrite()) {
  process.exit(0);
}

// Extract user prompt for skip detection
const userPrompt = payload?.invocation?.prompt || payload?.prompt || "";

// Check if hook should be skipped (skip-reminder module)
if (state && state.active) {
  const skipDecision = shouldSkipHook(state, userPrompt);

  if (skipDecision.shouldSkip) {
    // Output reminder to stderr
    recordSkip(
      "enforce-agent-dispatch",
      skipDecision.reason,
      getHookImpact("enforce-agent-dispatch"),
    );

    // Record to spine state for audit trail
    state = recordSkippedHook(state, "enforce-agent-dispatch", skipDecision.reason);
    await writeSpineState(cwd, state);

    process.exit(0); // Skip hook execution
  }
}

// Even when spine is inactive or unset, the meta-* readonly contract still
// applies: a meta agent must never directly mutate the workspace, regardless
// of spine state. We attempt to identify the caller and, if it is a meta-*
// agent invoking an execution tool, route through enforceMetaReadonly().
//
// This is the fix for the "spine-inactive escape hatch" — without it, every
// restriction would evaporate as soon as the spine deactivated.
if (!state || !state.active) {
  if (isExecutionTool(toolName)) {
    const caller = inferCallerIdentity(state);
    if (caller.name && isMetaAgent(caller.name)) {
      enforceMetaReadonly(toolName, toolInput, state, caller);
      // If enforceMetaReadonly chose warn-mode, fall through to exit(0) below.
    }
  }
  process.exit(0);
}

// Agent dispatch tools: record dispatch + track dispatch chain.
// Claude calls this capability `Agent`; Codex exposes it as `spawn_agent`.
if (isAgentDispatchTool(toolName)) {
  const agentDesc =
    toolInput?.description ||
    toolInput?.message?.substring(0, 80) ||
    toolInput?.prompt?.substring(0, 80) ||
    toolInput?.agent_type ||
    "unknown";
  const metaName = extractMetaAgentName(
    toolInput?.description,
    [toolInput?.prompt, toolInput?.message, toolInput?.agent_type]
      .filter(Boolean)
      .join(" "),
  );

  if (
    !state.queryBypass &&
    ["critical", "fetch", "thinking"].includes(state.currentStage) &&
    isExecutionDispatchIntent(toolInput, metaName)
  ) {
    const readinessGate = checkPreExecutionReadiness(state);
    if (!readinessGate.met) {
      exitAfterDeny(
        `Pre-execution readiness violation: design-time packets must be complete before execution dispatch. ` +
          `Missing: ${readinessGate.missing.join(", ")}.`,
      );
    }
  }

  // Check if a meta-agent is being dispatched for execution work
  // Warn if in execution stage and dispatching a meta-agent
  if (metaName && isMetaAgent(metaName)) {
    const stage = state.currentStage;
    // Warn in execution stage or if description suggests execution work
    const execKeywords = [
      "implement", "write", "create", "build", "test", "fix", "debug",
      "execute", "run", "generate", "produce", "code", "验收"
    ];
    const isExecWork = execKeywords.some(kw =>
      (agentDesc + " " + (toolInput?.prompt || "")).toLowerCase().includes(kw)
    );

    if (stage === "execution" && isExecWork) {
      warnMetaAgentExecution(metaName, stage);
    }
  }

  // Capability-first gate: at or after the execution stage, dispatching an
  // Agent requires evidence that a capability search was performed. Discovery
  // happens during critical / fetch / thinking, so those stages are exempt.
  // queryBypass runs are also exempt because they intentionally
  // skip the regulated dispatch flow.
  if (!state.queryBypass) {
    const stage = state.currentStage;
    const discoveryStages = new Set(["critical", "fetch", "thinking"]);
    const capabilityGateModeRaw = (
      process.env.META_KIM_CAPABILITY_GATE || "progressive"
    )
      .toLowerCase()
      .trim();

    if (capabilityGateModeRaw !== "off" && !discoveryStages.has(stage)) {
      const performed = state?.fetchRecord?.capabilitySearchPerformed === true;
      if (!performed) {
        // Resolve the effective mode. For "warn" / "block" this is a passthrough;
        // for "progressive" (the default) this returns "warn" during the
        // grace window and "block" afterwards, mirroring the meta-readonly gate.
        const effectiveMode = resolveGracedMode(
          capabilityGateModeRaw,
          "META_KIM_CAPABILITY_GATE_GRACE_DAYS",
          7,
          state,
        );

        const reason =
          `Capability-first violation: fetchRecord.capabilitySearchPerformed must be true ` +
          `before Agent dispatch in stage "${stage}". Search config/capability-index/ + ` +
          `canonical/agents/ first, then update spine state fetchRecord. ` +
          `Capability gate mode: "${capabilityGateModeRaw}" (effective: "${effectiveMode}"; ` +
          `default is "progressive"). ` +
          `Override with META_KIM_CAPABILITY_GATE=block (immediate), =warn (log only), ` +
          `or =off (disabled, not recommended).`;

        if (effectiveMode === "warn") {
          process.stderr.write(
            `\n⚠️  [Meta_Kim capability-gate:warn] ${reason}\n`,
          );
        } else {
          exitAfterDeny(reason);
        }
      }

      const readinessGate = checkPreExecutionReadiness(state);
      if (!readinessGate.met) {
        exitAfterDeny(
          `Pre-execution readiness violation: design-time packets must be complete before execution dispatch. ` +
            `Missing: ${readinessGate.missing.join(", ")}.`,
        );
      }

      const nodeBindingGate = checkCapabilityNodeBindings(state);
      if (!nodeBindingGate.met) {
        exitAfterDeny(
          `Capability node binding violation: ${nodeBindingGate.reason} ` +
            `Missing: ${nodeBindingGate.missing.join(", ")}.`,
        );
      }

      const dispatchText = [
        agentDesc,
        toolInput?.prompt,
        toolInput?.description,
        toolInput?.message,
        toolInput?.agent_type,
        JSON.stringify(toolInput?.items || []),
      ]
        .filter(Boolean)
        .join(" ");
      const matchedTaskPacket = (state?.workerTaskPackets || []).find(
        (packet) =>
          packet?.taskPacketId && dispatchText.includes(packet.taskPacketId) ||
          packet?.roleInstanceId && dispatchText.includes(packet.roleInstanceId),
      );
      if (!matchedTaskPacket) {
        exitAfterDeny(
          "Capability node binding violation: Agent dispatch in execution or later " +
            "must cite a workerTaskPackets[].taskPacketId or roleInstanceId so the " +
            "dispatch can be traced to a capability-matched task node.",
        );
      }

      const dispatchTarget =
        metaName ||
        toolInput?.agent_type ||
        toolInput?.subagent_type ||
        toolInput?.type ||
        "";
      if (
        typeof dispatchTarget === "string" &&
        dispatchTarget.startsWith("meta-") &&
        matchedTaskPacket.ownerAgent !== dispatchTarget
      ) {
        exitAfterDeny(
          `Capability node binding violation: dispatch target "${dispatchTarget}" ` +
            `does not match worker task ownerAgent "${matchedTaskPacket.ownerAgent}" ` +
            `for ${matchedTaskPacket.taskPacketId}.`,
        );
      }
    }
  }

  const updated = recordDispatch(state, agentDesc, metaName, toolInput);
  await writeSpineState(cwd, updated);
  process.exit(0);
}

// Task tools: always allow
if (
  toolName === "TaskCreate" ||
  toolName === "TaskUpdate" ||
  toolName === "TaskList" ||
  toolName === "TaskGet" ||
  toolName === "TaskOutput" ||
  toolName === "TaskStop"
) {
  process.exit(0);
}

// Read-only tools: always allow
if (isReadOnlyTool(toolName)) {
  process.exit(0);
}

// Query bypass skips orchestration confirmation only. It remains read-only.
if (state.queryBypass) {
  if (toolName === "Bash" && isReadOnlyBash((toolInput?.command || "").trim())) {
    process.exit(0);
  }
  exitAfterDeny(
    "queryBypass is limited to pure read-only inspection; mutation or state-changing tools are denied.",
  );
}

// Execution tools: enforce dispatch chain
if (isExecutionTool(toolName)) {
  // Meta-agent readonly enforcement (covers Bash/Edit/Write/MultiEdit/NotebookEdit).
  // This runs BEFORE the spine-state-write / planning-file exemptions so that a
  // meta-* caller cannot, for example, push hand-crafted Bash through the
  // planning-file shortcut. Spine-state writes themselves are still exempt
  // only for non-meta callers (they fall through this guard untouched).
  const caller = inferCallerIdentity(state);
  if (caller.name && isMetaAgent(caller.name)) {
    enforceMetaReadonly(toolName, toolInput, state, caller);
    // warn-mode falls through; block-mode already exited.
  }

  if (isSpineStateWrite() || isPlanningFile()) {
    process.exit(0);
  }

  const choiceSurfaceGate = checkChoiceSurfaceGate(state);
  if (!choiceSurfaceGate.met) {
    exitAfterDeny(
      `${choiceSurfaceGate.reason} Missing: ${choiceSurfaceGate.missing.join(", ")}.`,
    );
  }

  const stage = state.currentStage;
  const stageOrder = [
    "critical",
    "fetch",
    "thinking",
    "execution",
    "review",
    "meta_review",
    "verification",
    "evolution",
  ];
  const currentIdx = stageOrder.indexOf(stage);
  const execIdx = stageOrder.indexOf("execution");


  // Read-only inspection must remain available even when execution readiness is
  // incomplete; otherwise the operator cannot inspect state to return upstream.
  if (
    toolName === "Bash" &&
    !state.queryBypass
  ) {
    const stageConfig = STAGE_META_AGENT_MAP[stage];
    const cmd = (toolInput?.command || "").trim();
    const stageWhitelist = [
      ...(stageConfig?.readOnlyVerifierCommands || []),
      ...(stageConfig?.readOnlyInspectionCommands || []),
    ];
    const allowedByStage = stageWhitelist.some((prefix) => cmd.startsWith(prefix));
    if (allowedByStage || isReadOnlyBash(cmd)) {
      process.exit(0);
    }
  }

  if (
    currentIdx >= execIdx &&
    !state.queryBypass
  ) {
    const nodeBindingGate = checkCapabilityNodeBindings(state);
    if (!nodeBindingGate.met) {
      exitAfterDeny(
        `Capability node binding violation: ${nodeBindingGate.reason} ` +
          `Missing: ${nodeBindingGate.missing.join(", ")}.`,
      );
    }
  }


  // Pre-execution stages: block + check meta-agent requirements
  // Exception: critical stage is for setup (spine state + planning files), defer checks
  if (currentIdx < execIdx && stage !== "critical") {
    const req = checkStageRequirements(state);
    const stageInfo = STAGE_META_AGENT_MAP[stage];
    const label = stageInfo?.label || stage;

    if (!req.met) {
      exitAfterDeny(
        `Stage "${label}" requires: ${req.missing.join(", ")}. ` +
          `Dispatch them via Agent tool (description must contain the meta-agent name). ` +
          `Dispatch chain so far: ${JSON.stringify(state.dispatchChain || {})}`,
      );
    } else {
      exitAfterDeny(
        `You are in stage "${label}". Complete this stage before executing. ` +
          `Dispatch chain: ${JSON.stringify(state.dispatchChain || {})}`,
      );
    }
  }

  // Critical stage: allow only spine-state/planning-file writes and read-only
  // inspection. Warden is an escalation owner, not a mandatory setup dispatch.
  // Skip ALL checks if spine is inactive (allows normal work after session ends)
  if (stage === "critical" && currentIdx < execIdx) {
    if (isSpineStateWrite() || isPlanningFile()) {
      process.exit(0); // Allow spine state and planning file writes during critical
    }
    // If spine is inactive, skip critical stage requirements (normal work mode)
    if (!state.active) {
      process.exit(0);
    }
    // For other execution tools in critical with active spine, check requirements
    const req = checkStageRequirements(state);
    if (!req.met) {
      const stageInfo = STAGE_META_AGENT_MAP[stage];
      exitAfterDeny(
        `Stage "${stageInfo?.label || stage}" requires: ${req.missing.join(", ")}. ` +
          `Dispatch them via Agent tool (description must contain the meta-agent name). ` +
          `Dispatch chain so far: ${JSON.stringify(state.dispatchChain || {})}`,
      );
    }
    exitAfterDeny(
      "Critical stage is for scope clarification and read-only inspection. " +
        "Complete Critical, Fetch, and Thinking before mutation. " +
        "Allowed now: spine state writes, planning files, and read-only inspection. " +
        `Dispatch chain so far: ${JSON.stringify(state.dispatchChain || {})}`,
    );
  }

  // Execution stage: require at least one agent dispatch
  if (stage === "execution" && state.dispatchedAgents.length === 0) {
    exitAfterDeny(
      "Execution stage requires at least one agent dispatch via Agent tool. " +
        "Dispatch a specialist first. Violation: self-execution without delegation.",
    );
  }

  // Post-execution stages: require correct meta-agent
  if (currentIdx >= execIdx && stage !== "execution") {
    const req = checkStageRequirements(state);
    if (!req.met) {
      const stageInfo = STAGE_META_AGENT_MAP[stage];
      exitAfterDeny(
        `Stage "${stageInfo?.label || stage}" requires: ${req.missing.join(", ")}. ` +
          `Dispatch them via Agent tool first. ` +
          `Dispatch chain: ${JSON.stringify(state.dispatchChain || {})}`,
      );
    }
  }
}

process.exit(0);
