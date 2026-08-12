/**
 * enforce-agent-dispatch.mjs — Meta_Kim Spine PreToolUse guard.
 *
 * Responsibilities:
 *   1. Spine-active runs: gate execution tools only on key behavior evidence:
 *      intent, Fetch evidence, Thinking route/loadout, and memory strategy.
 *   2. Meta-agent readonly enforcement: even when spine is inactive (or skipped),
 *      a caller identified as a meta-* agent must not directly mutate the
 *      workspace via Edit / Write / MultiEdit / NotebookEdit / Bash. They must
 *      dispatch down to an execution worker instead.
 *   3. Capability-first gate: Agent dispatches at or after the execution stage
 *      require a prior capability search recorded in spine state. This keeps
 *      capability-first discovery without requiring every optional packet
 *      field to be complete inside the hook.
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
 *   META_KIM_HOOK_RUNTIME or --runtime claude|codex|cursor
 *     Override runtime detection for cross-runtime deny() output schema.
 *     Accepted values: "claude" | "codex" | "cursor". If unset, the hook
 *     checks explicit CLI args, then inspects process.argv[1] for ".codex/",
 *     ".cursor/", or ".claude/", and falls back to Claude.
 *
 *   CLAUDE_SUBAGENT_TYPE
 *     Runtime-injected hint for the current subagent's type. When this starts
 *     with "meta-" we treat the caller as a meta-agent without further parsing.
 */

import process from "node:process";
import { join, normalize } from "node:path";
import { readJsonFromStdin, extractFilePath } from "./utils.mjs";
import {
  isReadOnlyBash,
  classifyBashCommand,
  __internals as bashReadonlyInternals,
} from "./bash-readonly-whitelist.mjs";
import {
  readSpineState,
  checkCapabilityNodeBindings,
  checkPreExecutionReadiness,
  isExecutionTool,
  isReadOnlyTool,
  recordDispatch,
  writeSpineState,
  checkChoiceSurfaceGate,
  isHookObservedState,
  STAGE_META_AGENT_MAP,
  extractMetaAgentName,
  recordSkippedHook,
  getGovernanceFlow,
  evaluateFanoutGate,
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
const PLANNING_FILES = ["task_plan.md", "findings.md", "progress.md"];
const READ_ONLY_CONTROL_PLANE_TOOLS = new Set([
  "TaskList",
  "TaskGet",
  "TaskOutput",
]);
const MUTATING_CONTROL_PLANE_TOOLS = new Set([
  "EnterPlanMode",
  "ExitPlanMode",
  "TaskStop",
  "TaskCreate",
  "TaskUpdate",
  "TodoWrite",
]);
const CONTROL_PLANE_TOOLS = new Set([
  ...READ_ONLY_CONTROL_PLANE_TOOLS,
  ...MUTATING_CONTROL_PLANE_TOOLS,
]);

function normalizeHookPath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return normalize(raw.replace(/^["']|["']$/g, ""))
    .replace(/\\/g, "/")
    .toLowerCase();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function touchesSpineStatePath(value) {
  const normalized = normalizeHookPath(value);
  if (!normalized) return false;
  const stateDir = normalizeHookPath(SPINE_STATE_DIR);
  return (
    normalized.endsWith("spine-state.json") ||
    normalized.includes(`${stateDir}/`) ||
    /(^|\/)spine\//.test(normalized)
  );
}

function isSpineStateWrite() {
  // Windows paths are case-insensitive: comparing the lowercased, normalized
  // suffix prevents a meta-agent from sneaking writes via mixed case such as
  // "Spine-State.JSON".
  if (touchesSpineStatePath(targetPath)) return true;
  // Also allow anything under a ".../spine/..." segment so adjacent ledger
  // files do not become a back door.
  return isApplyPatchSpineStateWrite() || isBashSpineStateWrite();
}

function isApplyPatchSpineStateWrite() {
  if (String(toolName).toLowerCase() !== "apply_patch") return false;
  const patch = String(toolInput?.patch || payload?.patch || "");
  if (!patch.trim()) return false;

  const touchedPaths = [];
  const pathHeaderPattern =
    /^\*\*\* (?:Add File|Update File|Delete File|Move to):\s+(.+)$/gm;
  for (const match of patch.matchAll(pathHeaderPattern)) {
    touchedPaths.push(match[1].trim());
  }

  return (
    touchedPaths.length > 0 && touchedPaths.every(touchesSpineStatePath)
  );
}

function isBashSpineStateWrite() {
  if (toolName !== "Bash") return false;
  const command = String(toolInput?.command || "");
  if (!command.trim()) return false;

  const spinePathVariables = collectSpinePathVariables(command);
  const segments = bashReadonlyInternals
    .splitSegments(command)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (!segments.length) return false;

  let sawSpineWrite = false;
  for (const segment of segments) {
    if (isReadOnlyBash(segment)) {
      continue;
    }
    if (isSafeSpineStatePrepSegment(segment, spinePathVariables)) {
      continue;
    }
    if (!isSpineStateWriteSegment(segment, spinePathVariables)) {
      return false;
    }
    sawSpineWrite = true;
  }

  return sawSpineWrite;
}

function collectSpinePathVariables(command) {
  const variables = new Set();
  const normalized = String(command || "").replace(/\\/g, "/");
  const psAssignment =
    /\$([A-Za-z_][\w]*)\s*=\s*["']([^"']*(?:spine-state\.json|\/spine\/)[^"']*)["']/gi;
  for (const match of normalized.matchAll(psAssignment)) {
    if (touchesSpineStatePath(match[2])) variables.add(match[1]);
  }

  const jsAssignment =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*["']([^"']*(?:spine-state\.json|\/spine\/)[^"']*)["']/gi;
  for (const match of normalized.matchAll(jsAssignment)) {
    if (touchesSpineStatePath(match[2])) variables.add(match[1]);
  }

  const jsPathJoinAssignment =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:path\.)?(?:join|resolve)\s*\([^;]*spine-state\.json[^;]*\)/gi;
  for (const match of normalized.matchAll(jsPathJoinAssignment)) {
    variables.add(match[1]);
  }

  return variables;
}

function hasShellWritePrimitive(segment) {
  return /(^|[\s|;&])(?:set-content|out-file|add-content|new-item|remove-item|move-item|copy-item)\b|[>]{1,2}/i.test(
    segment,
  );
}

function isSafeSpineStatePrepSegment(segment, spinePathVariables) {
  const trimmed = segment.trim();
  if (!trimmed || hasShellWritePrimitive(trimmed)) return false;
  if (/^\$[A-Za-z_][\w]*$/.test(trimmed)) return true;
  if (/^add-member\b/i.test(trimmed) && /fetchrecord/i.test(trimmed)) {
    return true;
  }
  if (/^\$[A-Za-z_][\w]*\s*=/.test(trimmed)) {
    if (touchesSpineStatePath(trimmed)) return true;
    for (const variableName of spinePathVariables) {
      const variablePattern = new RegExp(`\\$${escapeRegExp(variableName)}\\b`, "i");
      if (variablePattern.test(trimmed)) return true;
    }
    return /\b(?:get-content|gc|convertfrom-json|convertto-json)\b/i.test(
      trimmed,
    );
  }
  return false;
}

function isSpineStateWriteSegment(segment, spinePathVariables = new Set()) {
  const writesSpine =
    shellWriteTargetsSpineState(segment) ||
    segmentWritesToSpineVariable(segment, spinePathVariables);

  if (hasShellWritePrimitive(segment)) {
    return writesSpine;
  }

  return isNodeRepairOnlyFetchRecordWrite(segment);
}

function shellWriteTargetsSpineState(segment) {
  if (!hasShellWritePrimitive(segment)) return false;
  const normalized = segment.replace(/\\/g, "/");
  const spineTarget = `[^"'\\s;&|]*(?:spine-state\\.json|/spine(?:/|$)[^"'\\s;&|]*)`;
  const explicitPath = new RegExp(
    `(?:^|[\\s;&|])(?:-Path|-LiteralPath|-Destination|-FilePath)\\s+["']?${spineTarget}(?=["'\\s;&|]|$)`,
    "i",
  );
  const positionalPath = new RegExp(
    `(?:^|[\\s;&|])(?:set-content|out-file|add-content|new-item|remove-item)\\s+["']?${spineTarget}(?=["'\\s;&|]|$)`,
    "i",
  );
  const redirectionPath = new RegExp(
    `[>]{1,2}\\s*["']?${spineTarget}(?=["'\\s;&|]|$)`,
    "i",
  );
  return (
    explicitPath.test(normalized) ||
    positionalPath.test(normalized) ||
    redirectionPath.test(normalized)
  );
}

function segmentWritesToSpineVariable(segment, spinePathVariables) {
  for (const variableName of spinePathVariables) {
    const psVariable = new RegExp(`\\$${escapeRegExp(variableName)}\\b`, "i");
    const jsVariable = new RegExp(`\\b${escapeRegExp(variableName)}\\b`, "i");
    if (
      hasShellWritePrimitive(segment) &&
      psVariable.test(segment)
    ) {
      return true;
    }
    if (/writeFileSync\s*\(/i.test(segment) && jsVariable.test(segment)) {
      return true;
    }
  }
  return false;
}

function isNodeRepairOnlyFetchRecordWrite(segment) {
  const stripped = bashReadonlyInternals
    .stripEnvPrefix(segment.trim())
    .join(" ");
  const normalized = stripped.replace(/\\/g, "/").toLowerCase();
  if (!/^(?:node|node\.exe)(?:\s|$)/.test(normalized)) return false;
  if (!nodeWriteFileSyncTargetsSpineState(stripped)) return false;
  if (!normalized.includes("writefilesync")) return false;
  if (!normalized.includes("fetchrecord")) return false;
  if (!normalized.includes("repaironly")) return false;
  if (!normalized.includes("executionclearance")) return false;
  return /executionclearance\s*[:=]\s*false/i.test(stripped);
}

function nodeWriteFileSyncTargetsSpineState(scriptText) {
  const normalized = scriptText.replace(/\\/g, "/");
  if (
    /writeFileSync\s*\(\s*["'][^"']*spine-state\.json["']/i.test(normalized)
  ) {
    return true;
  }

  const spinePathVariables = new Set();
  const literalAssignmentPattern =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*["']([^"']*spine-state\.json)["']/gi;
  for (const match of normalized.matchAll(literalAssignmentPattern)) {
    spinePathVariables.add(match[1]);
  }

  const pathJoinAssignmentPattern =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:path\.)?(?:join|resolve)\s*\([^;]*spine-state\.json[^;]*\)/gi;
  for (const match of normalized.matchAll(pathJoinAssignmentPattern)) {
    spinePathVariables.add(match[1]);
  }

  for (const variableName of spinePathVariables) {
    const escaped = escapeRegExp(variableName);
    const writePattern = new RegExp(
      `writeFileSync\\s*\\(\\s*${escaped}\\s*,`,
      "i",
    );
    if (writePattern.test(normalized)) {
      return true;
    }
  }

  return false;
}

function isPlanningFile() {
  if (touchesPlanningSurfacePath(targetPath)) return true;
  if (toolName !== "Bash") return false;
  return isBashPlanningFileWrite(String(toolInput?.command || ""));
}

function touchesPlanningFilePath(value) {
  return touchesPlanningSurfacePath(value);
}

function touchesPlanningSurfacePath(value) {
  const normalized = normalizeHookPath(value);
  if (!normalized) return false;
  return (
    PLANNING_FILES.some((file) => normalized.endsWith(file)) ||
    /(^|\/)\.claude\/plans\/[^/]+\.md$/.test(normalized)
  );
}

function shellPlanningSurfaceTargetPattern() {
  const planningFileAlternatives = PLANNING_FILES.map(escapeRegExp).join("|");
  return (
    `[^"'\\s;&|]*(?:(?:${planningFileAlternatives})|` +
    `(?:\\.claude/plans/[^"'\\s;&|]+\\.md))`
  );
}

function isBashPlanningFileWrite(command) {
  if (!command.trim()) return false;
  const segments = bashReadonlyInternals
    .splitSegments(command)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (!segments.length) return false;

  let sawPlanningWrite = false;
  for (const segment of segments) {
    if (isReadOnlyBash(segment)) {
      continue;
    }
    if (!isPlanningFileWriteSegment(segment)) {
      return false;
    }
    sawPlanningWrite = true;
  }
  return sawPlanningWrite;
}

function isPlanningFileWriteSegment(segment) {
  if (!hasShellWritePrimitive(segment)) return false;
  const normalized = segment.replace(/\\/g, "/");
  const planningTarget = shellPlanningSurfaceTargetPattern();
  const explicitPath = new RegExp(
    `(?:^|[\\s;&|])(?:-Path|-LiteralPath|-Destination|-FilePath)\\s+["']?${planningTarget}(?=["'\\s;&|]|$)`,
    "i",
  );
  const positionalPath = new RegExp(
    `(?:^|[\\s;&|])(?:set-content|out-file|add-content|new-item|remove-item)\\s+["']?${planningTarget}(?=["'\\s;&|]|$)`,
    "i",
  );
  const redirectionPath = new RegExp(
    `[>]{1,2}\\s*["']?${planningTarget}(?=["'\\s;&|]|$)`,
    "i",
  );
  return (
    explicitPath.test(normalized) ||
    positionalPath.test(normalized) ||
    redirectionPath.test(normalized)
  );
}

function matchesStageReadOnlyCommand(command, prefixes) {
  const segments = bashReadonlyInternals
    .splitSegments(command)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (!segments.length || !prefixes.length) return false;

  let matchedVerifierSegment = false;
  for (const segment of segments) {
    const matchedPrefix = prefixes.find((prefix) => segment.startsWith(prefix));
    const matchesVerifier = !!matchedPrefix;
    if (matchesVerifier) {
      if (
        /^(npm|pnpm|yarn)\s/.test(segment) &&
        !isSafeVerifierScriptInvocation(segment)
      ) {
        return false;
      }
      matchedVerifierSegment = true;
      continue;
    }
    if (isReadOnlyBash(segment)) {
      continue;
    }
    return false;
  }

  return matchedVerifierSegment;
}

const SAFE_VERIFIER_SCRIPT_NAME =
  /(^|:)(test|check|verify|validate|lint|typecheck)(:|$)/i;

function isSafeVerifierScriptInvocation(segment) {
  const trimmed = segment.trim();
  if (/^npm\s+test(?:\s|$)/i.test(trimmed)) return true;
  if (/^pnpm\s+test(?:\s|$)/i.test(trimmed)) return true;
  if (/^yarn\s+test(?:\s|$)/i.test(trimmed)) return true;

  const patterns = [
    /^npm\s+run\s+([^\s]+)/i,
    /^pnpm\s+run\s+([^\s]+)/i,
    /^pnpm\s+([^\s-][^\s]*)/i,
    /^yarn\s+([^\s]+)/i,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (!match) continue;
    const scriptName = match[1];
    if (SAFE_VERIFIER_SCRIPT_NAME.test(scriptName)) {
      return true;
    }
  }

  return false;
}

const FETCH_TRANSITION_READ_ONLY_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LSPO",
  "WebFetch",
  "WebSearch",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
]);

function normalizedBashSegments(command) {
  return bashReadonlyInternals
    .splitSegments(command)
    .map((segment) =>
      bashReadonlyInternals
        .stripEnvPrefix(segment.trim())
        .join(" ")
        .toLowerCase(),
    )
    .filter(Boolean);
}

function isFetchEvidenceBash(command) {
  const cmd = (command || "").trim();
  if (!isReadOnlyBash(cmd)) return false;

  return normalizedBashSegments(cmd).some((segment) => {
    if (
      segment.startsWith("git status") ||
      segment.startsWith("git diff") ||
      segment.startsWith("git rev-parse") ||
      segment.startsWith("rg ") ||
      segment.startsWith("rg --files") ||
      segment.startsWith("grep ") ||
      segment.startsWith("egrep ") ||
      segment.startsWith("fgrep ") ||
      segment.startsWith("find ") ||
      segment.startsWith("ls tests") ||
      segment.startsWith("ls canonical") ||
      segment.startsWith("cat package.json") ||
      segment.startsWith("head package.json") ||
      segment.startsWith("tail package.json") ||
      segment.startsWith("get-childitem") ||
      segment.startsWith("get-content") ||
      segment.startsWith("select-string")
    ) {
      return true;
    }
    return false;
  });
}

function shouldAdvanceCriticalToFetch(state, toolName, input) {
  if (!state?.active || state.currentStage !== "critical") return false;
  if (isPlanningFile()) return true;

  if (FETCH_TRANSITION_READ_ONLY_TOOLS.has(toolName)) {
    return true;
  }

  if (toolName !== "Bash") return false;
  const cmd = (input?.command || "").trim();
  if (isFetchEvidenceBash(cmd)) return true;
  const fetchInspectionPrefixes =
    STAGE_META_AGENT_MAP.fetch?.readOnlyInspectionCommands || [];
  return matchesStageReadOnlyCommand(cmd, fetchInspectionPrefixes);
}

/**
 * Detect which runtime is hosting this hook so that deny() can emit the right
 * payload schema. Priority:
 *   1. META_KIM_HOOK_RUNTIME env var (explicit override).
 *   2. --runtime / --meta-kim-hook-runtime CLI arg (projected hook config).
 *   3. Inspect process.argv[1] for a runtime-specific path segment, using
 *      path.sep so the check works on both POSIX and Windows.
 *   4. Default to "claude".
 *
 * @returns {"claude" | "codex" | "cursor"}
 */
export function detectHookRuntime() {
  const override = (process.env.META_KIM_HOOK_RUNTIME || "").toLowerCase().trim();
  if (override === "claude" || override === "codex" || override === "cursor") {
    return override;
  }

  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = String(process.argv[i] || "").toLowerCase().trim();
    const next = String(process.argv[i + 1] || "").toLowerCase().trim();
    const inlineRuntime =
      arg.startsWith("--runtime=")
        ? arg.slice("--runtime=".length)
        : arg.startsWith("--meta-kim-hook-runtime=")
          ? arg.slice("--meta-kim-hook-runtime=".length)
          : "";
    const value =
      inlineRuntime ||
      (arg === "--runtime" || arg === "--meta-kim-hook-runtime" ? next : "");
    if (value === "claude" || value === "codex" || value === "cursor") {
      return value;
    }
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

function resolvedHookLanguage(state) {
  const candidates = [
    state?.stageRuntimeControl?.userLanguage,
    state?.latestUserInputLanguage,
    state?.outputLanguage,
    process.env.META_KIM_OUTPUT_LANGUAGE,
    process.env.LANG,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "en";
}

function isZh(state) {
  return /^zh/i.test(resolvedHookLanguage(state));
}

function observedModeNotice(state) {
  if (isZh(state)) {
    return (
      "[Meta_Kim] 提醒：当前是自动触发的观察态。Hook 不会把自己当阶段驱动器反复拦截普通本地修改；" +
      "删除、Git、GitHub API、安装或发布由运行时/用户意图处理；公示和严格验收仍看 managed runner 的 Fetch、Thinking、fileChangeFactCard 和 executionLease。"
    );
  }
  return (
    "[Meta_Kim] Notice: auto-triggered observed mode is active. The hook will not act as the " +
    "stage driver or hard-block commands by class; delete, Git, GitHub API, install, and publish " +
    "commands remain runtime/user-intent concerns, while release/public-ready claims still require " +
    "the managed runner to record Fetch, Thinking, fileChangeFactCard, and executionLease."
  );
}

const EXACT_AGENT_DISPATCH_TOOLS = Object.freeze({
  claude: new Set(["Agent", "Task"]),
  codex: new Set([
    "Agent",
    "spawn_agent",
    "followup_task",
    "collaboration.spawn_agent",
    "collaboration.followup_task",
  ]),
  cursor: new Set(["Agent", "Task", "spawn_agent"]),
});

function isAgentDispatchTool(name) {
  const runtime = detectHookRuntime();
  const trustedTools = EXACT_AGENT_DISPATCH_TOOLS[runtime];
  return trustedTools?.has(String(name ?? "")) === true;
}

function normalizedDispatchToolName(name) {
  return String(name ?? "").split(/[.:/]/u).at(-1);
}

const CODEX_OWNER_BINDING_MODES = new Set([
  "native_custom_agent",
  "run_scoped_owner_contract",
]);

function boundedCodexIdentity(value) {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 128 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? value.trim()
    : null;
}

function codexOwnerBindingClaim(envelope) {
  const modeCandidates = [envelope?.ownerBindingMode].filter((value) => value != null);
  const agentTypeCandidates = [envelope?.nativeAgentType].filter((value) => value != null);
  const normalizedModes = [...new Set(modeCandidates.map((value) => String(value).trim()))];
  const normalizedAgentTypes = [
    ...new Set(agentTypeCandidates.map((value) => boundedCodexIdentity(value))),
  ];
  if (
    normalizedModes.length !== 1 ||
    normalizedModes.length > 1 ||
    normalizedModes.some((mode) => !CODEX_OWNER_BINDING_MODES.has(mode)) ||
    normalizedAgentTypes.includes(null) ||
    normalizedAgentTypes.length > 1
  ) {
    return { valid: false, mode: null, nativeAgentType: null };
  }
  return {
    valid: true,
    mode: normalizedModes[0] ?? null,
    nativeAgentType: normalizedAgentTypes[0] ?? null,
  };
}

function codexOwnerBindingFromHostInput(input, envelope) {
  const hasAgentType = Object.prototype.hasOwnProperty.call(input ?? {}, "agent_type");
  const nativeAgentType = hasAgentType ? boundedCodexIdentity(input.agent_type) : null;
  if (hasAgentType && !nativeAgentType) {
    return {
      met: false,
      mode: null,
      nativeAgentType: null,
      missing: ["valid host agent_type when the field is present"],
    };
  }
  const mode = nativeAgentType ? "native_custom_agent" : "run_scoped_owner_contract";
  const claim = codexOwnerBindingClaim(envelope);
  const missing = [];
  if (!claim.valid) missing.push("valid and unambiguous owner binding mode claim");
  if (!claim.mode) missing.push("explicit ownerBindingMode");
  if (claim.mode && claim.mode !== mode) {
    missing.push(`claimed owner binding mode matching actual host schema (${mode})`);
  }
  if (claim.nativeAgentType && claim.nativeAgentType !== nativeAgentType) {
    missing.push("claimed nativeAgentType matching the actual host agent_type");
  }
  if (claim.nativeAgentType && mode !== "native_custom_agent") {
    missing.push("nativeAgentType claim only when host agent_type is present");
  }
  if (mode === "native_custom_agent" && envelope?.ownerAgent !== nativeAgentType) {
    missing.push("ownerAgent matching the actual host agent_type");
  }
  if (mode === "native_custom_agent") {
    const ownerDefinition = envelope?.ownerDefinition;
    if (
      ownerDefinition?.format !== "codex_custom_agent_toml" ||
      ownerDefinition?.nativeCustomAgentEligible !== true ||
      ownerDefinition?.nativeAgentName !== nativeAgentType
    ) {
      missing.push("validated Codex TOML ownerDefinition matching agent_type");
    }
    if (!/\.toml$/iu.test(String(envelope?.ownerSource ?? ownerDefinition?.sourceRef ?? ""))) {
      missing.push("Codex TOML ownerSource for native_custom_agent");
    }
  }
  if (mode === "run_scoped_owner_contract" && claim.nativeAgentType) {
    missing.push("nativeAgentType omitted for run_scoped_owner_contract");
  }
  return {
    met: missing.length === 0,
    mode,
    nativeAgentType,
    claimedMode: claim.mode,
    missing,
  };
}

function validateMetaKimBinding(candidate, envelope) {
  const fields = [
    "runId", "family", "providerId", "bindingRef", "taskPacketId",
    "roleInstanceId", "occurredAt", "evidenceKind",
  ];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  if (Object.keys(candidate).sort().join("|") !== fields.sort().join("|")) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(candidate.runId ?? "")) return false;
  if (candidate.family !== "agent_subagent" || candidate.evidenceKind !== "spawn_agent_result") return false;
  if (
    !candidate.providerId ||
    !candidate.bindingRef ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(candidate.occurredAt ?? "") ||
    !Number.isFinite(Date.parse(candidate.occurredAt))
  ) return false;
  if (!String(candidate.bindingRef).includes(`${candidate.runId}:agent_subagent:${candidate.providerId}`)) return false;
  return candidate.taskPacketId === envelope.taskPacketId &&
    candidate.roleInstanceId === envelope.roleInstanceId &&
    String(candidate.providerId).endsWith(`:${envelope.ownerAgent}`);
}

function checkCodexWorkerInvocationEnvelope(input, tool) {
  const normalizedTool = normalizedDispatchToolName(tool);
  if (!new Set(["spawn_agent", "followup_task"]).has(normalizedTool)) {
    return { met: true, missing: [] };
  }
  if (normalizedTool === "followup_task" && (typeof input?.target !== "string" || !input.target.trim())) {
    return { met: false, missing: ["followup_task target runtime instance id"] };
  }
  const raw = input?.message;
  if (typeof raw !== "string" || !raw.trim()) {
    return { met: false, missing: ["clear-text Codex worker invocation envelope"] };
  }
  if (/^gAAAAA[A-Za-z0-9_-]{20,}={0,2}$/u.test(raw.trim())) {
    return { met: false, missing: ["verifiable owner binding; encrypted message cannot be inspected by the hook"] };
  }
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return { met: false, missing: ["valid JSON Codex worker invocation envelope"] };
  }
  const missing = [];
  if (envelope?.schemaVersion !== "codex-native-worker-invocation-v0.2") missing.push("schemaVersion v0.2");
  for (const field of ["taskPacketId", "roleDisplayName", "roleInstanceId", "ownerAgent", "ownerSource"]) {
    if (typeof envelope?.[field] !== "string" || !envelope[field].trim()) missing.push(field);
  }
  if (envelope?.ownerKind !== "agent") missing.push("ownerKind=agent");
  if (!envelope?.capabilityLoadout || typeof envelope.capabilityLoadout !== "object" || Array.isArray(envelope.capabilityLoadout)) {
    missing.push("capabilityLoadout");
  }
  if (!envelope?.coordination || typeof envelope.coordination !== "object" || !envelope.coordination.mergeOwner) {
    missing.push("coordination.mergeOwner");
  }
  if (!validateMetaKimBinding(envelope?.metaKimBinding, envelope)) missing.push("strict metaKimBinding");
  const ownerBinding = codexOwnerBindingFromHostInput(input, envelope);
  missing.push(...ownerBinding.missing);
  return { met: missing.length === 0, missing, envelope, ownerBinding };
}

function checkCodexEnvelopeAgainstState(envelope, state, ownerBinding = null) {
  const packets = Array.isArray(state?.workerTaskPackets) ? state.workerTaskPackets : [];
  const packet = packets.find((candidate) => candidate?.taskPacketId === envelope?.taskPacketId);
  if (!packet) return { met: false, missing: ["matching state workerTaskPacket"] };
  const missing = [];
  const expectedOwnerSource = packet.ownerSource ?? packet.codexSpawnBinding?.ownerSource ?? null;
  if (packet.ownerAgent !== envelope.ownerAgent) missing.push("ownerAgent matching workerTaskPacket");
  if (packet.roleInstanceId !== envelope.roleInstanceId) missing.push("roleInstanceId matching workerTaskPacket");
  if (packet.roleDisplayName !== envelope.roleDisplayName) missing.push("roleDisplayName matching workerTaskPacket");
  if (!expectedOwnerSource || expectedOwnerSource !== envelope.ownerSource) missing.push("ownerSource matching discovered provider");
  if (packet.mergeOwner !== envelope.coordination?.mergeOwner) missing.push("mergeOwner matching workerTaskPacket");
  if ((packet.parallelGroup ?? null) !== (envelope.coordination?.parallelGroup ?? null)) {
    missing.push("parallelGroup matching workerTaskPacket");
  }
  if ((packet.weapon ?? null) !== (envelope.capabilityLoadout?.weapon ?? null)) {
    missing.push("weapon matching workerTaskPacket");
  }
  if ((packet.dependency ?? null) !== (envelope.capabilityLoadout?.dependency ?? null)) {
    missing.push("dependency matching workerTaskPacket");
  }
  if (
    ownerBinding?.mode === "native_custom_agent" &&
    packet.ownerAgent !== ownerBinding.nativeAgentType
  ) {
    missing.push("native host agent_type matching workerTaskPacket ownerAgent");
  }
  return { met: missing.length === 0, missing };
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

function checkThinkingIndependentLanes(state) {
  const packets = Array.isArray(state?.workerTaskPackets)
    ? state.workerTaskPackets
    : [];
  const dispatchMode = state?.stageRuntimeControl?.dispatchMode;
  const fanoutClaimed = ["fan_out_ready", "fan_out_in_progress"].includes(dispatchMode);
  if (!fanoutClaimed && packets.length < 2) return { met: true, missing: [] };

  const missing = [];
  if (state?.fetchRecord?.capabilitySearchPerformed !== true) {
    missing.push("real Fetch capability discovery");
  }
  const thinkingStatus = state?.stages?.thinking?.status;
  const stageIndex = [
    "critical", "fetch", "thinking", "execution", "review",
    "meta_review", "verification", "evolution",
  ].indexOf(String(state?.currentStage || "").toLowerCase());
  if (thinkingStatus !== "completed" && stageIndex < 3) {
    missing.push("Thinking completed");
  }
  if (packets.length < 2) missing.push("at least two workerTaskPackets");

  const groups = new Map();
  for (const packet of packets) {
    for (const field of [
      "taskPacketId", "ownerAgent", "roleInstanceId", "parallelGroup", "mergeOwner",
    ]) {
      if (!packet?.[field]) missing.push(`${field} on every fan-out workerTaskPacket`);
    }
    if (!Array.isArray(packet?.shardScope) || packet.shardScope.length === 0) {
      missing.push("non-empty shardScope on every fan-out workerTaskPacket");
    }
    const group = groups.get(packet?.parallelGroup) ?? [];
    group.push(packet);
    groups.set(packet?.parallelGroup, group);
  }
  const independentGroup = [...groups.values()].some((group) => {
    if (group.length < 2) return false;
    const taskIds = new Set(group.map((packet) => packet.taskPacketId));
    const scopes = new Set();
    return group.every((packet) => {
      const dependencies = Array.isArray(packet.dependsOn) ? packet.dependsOn : [];
      if (dependencies.some((dependency) => taskIds.has(
        typeof dependency === "string" ? dependency : dependency?.taskPacketId,
      ))) return false;
      for (const scope of packet.shardScope ?? []) {
        const normalizedScope = String(scope).toLowerCase().replaceAll("\\", "/");
        if (scopes.has(normalizedScope)) return false;
        scopes.add(normalizedScope);
      }
      return true;
    });
  });
  if (!independentGroup) {
    missing.push("two collision-free dependency-independent lanes in one parallelGroup");
  }
  return { met: missing.length === 0, missing: [...new Set(missing)] };
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
 * Infer the caller's identity only from runtime-injected evidence.
 * dispatchChain is historical governance state, not proof that the latest
 * dispatched owner is making the current tool call. Using it as caller identity
 * can falsely warn or block the main thread's ordinary project changes.
 *
 * @returns {{ name: string|null, source: string }}
 */
function inferCallerIdentity() {
  const envHint = process.env.CLAUDE_SUBAGENT_TYPE;
  if (envHint && typeof envHint === "string" && envHint.trim()) {
    return { name: envHint.trim(), source: "env" };
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

function describeGracedMode(modeRaw, graceDaysEnvVar, defaultGraceDays, state) {
  const effectiveMode = resolveGracedMode(modeRaw, graceDaysEnvVar, defaultGraceDays, state);
  if (modeRaw === "warn" || modeRaw === "block" || modeRaw === "off") {
    return `effective: "${effectiveMode}"; graceDaysRemaining: n/a`;
  }

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
    return `effective: "${effectiveMode}"; graceDaysRemaining: unknown; graceDays: ${graceDays}; anchor: missing`;
  }
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) {
    return `effective: "${effectiveMode}"; graceDaysRemaining: unknown; graceDays: ${graceDays}; anchor: invalid`;
  }
  const elapsedDays = (Date.now() - startedMs) / (1000 * 60 * 60 * 24);
  const graceDaysRemaining = Math.max(0, Math.ceil(graceDays - elapsedDays));
  return `effective: "${effectiveMode}"; graceDaysRemaining: ${graceDaysRemaining}; graceDays: ${graceDays}`;
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
    process.stderr.write(
      `[meta-kim] META_KIM_HOOK_SKIP active — governance hooks bypassed (source=env_var)\n`,
    );
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
    const caller = inferCallerIdentity();
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
    toolInput?.task_name ||
    toolInput?.agent_type ||
    "unknown";
  const metaName = extractMetaAgentName(
    toolInput?.description,
    [toolInput?.prompt, toolInput?.message, toolInput?.agent_type]
      .filter(Boolean)
      .join(" "),
  );

  if (isHookObservedState(state)) {
    const updated = recordDispatch(state, agentDesc, metaName, toolInput);
    const control = updated?.stageRuntimeControl || {};
    if (!control.observedNoticeEmittedAt) {
      process.stderr.write(`${observedModeNotice(updated)}\n`);
      updated.stageRuntimeControl = {
        ...control,
        observedNoticeEmittedAt: new Date().toISOString(),
        observedNoticePolicy: "emit_once_per_active_state",
      };
    }
    await writeSpineState(cwd, updated);
    process.exit(0);
  }

  const executionDispatchIntent = isExecutionDispatchIntent(toolInput, metaName);

  if (
    !state.queryBypass &&
    ["critical", "fetch", "thinking"].includes(state.currentStage) &&
    executionDispatchIntent
  ) {
    const independentLaneGate = checkThinkingIndependentLanes(state);
    if (!independentLaneGate.met) {
      exitAfterDeny(
        `Thinking fan-out readiness violation: Agent execution dispatch requires real Fetch evidence and proven independent lanes. ` +
          `Missing: ${independentLaneGate.missing.join(", ")}.`,
      );
    }
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

    const gateExempt = discoveryStages.has(stage);

    if (capabilityGateModeRaw !== "off" && !gateExempt) {
      const independentLaneGate = checkThinkingIndependentLanes(state);
      if (!independentLaneGate.met) {
        exitAfterDeny(
          `Thinking fan-out readiness violation: Agent execution dispatch requires proven independent lanes. ` +
            `Missing: ${independentLaneGate.missing.join(", ")}.`,
        );
      }
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
        const graceStatus = describeGracedMode(
          capabilityGateModeRaw,
          "META_KIM_CAPABILITY_GATE_GRACE_DAYS",
          7,
          state,
        );

        const reason =
          `Capability-first violation: fetchRecord.capabilitySearchPerformed must be true ` +
          `before Agent dispatch in stage "${stage}". Search config/capability-index/ + ` +
          `canonical/agents/ first, then update spine state fetchRecord. ` +
          `Capability gate mode: "${capabilityGateModeRaw}" (${graceStatus}; default is "progressive"). ` +
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

      if (executionDispatchIntent) {
        const choiceSurfaceGate = checkChoiceSurfaceGate(state);
        if (!choiceSurfaceGate.met) {
          exitAfterDeny(
            `${choiceSurfaceGate.reason} Missing: ${choiceSurfaceGate.missing.join(", ")}.`,
          );
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
        toolInput?.subagent_type,
        JSON.stringify(toolInput?.items || []),
      ]
        .filter(Boolean)
        .join(" ");
      const matchedTaskPacket = (state?.workerTaskPackets || []).find(
        (packet) =>
          packet?.taskPacketId && dispatchText.includes(packet.taskPacketId) ||
          packet?.roleInstanceId && dispatchText.includes(packet.roleInstanceId),
      );
      if (!matchedTaskPacket && (state?.workerTaskPackets || []).length > 1) {
        process.stderr.write(
          "\n[Meta_Kim capability-gate:warn] Agent dispatch did not cite a " +
            "workerTaskPackets taskPacketId or roleInstanceId. Multiple worker " +
            "nodes exist, so Review should verify traceability, but the hook " +
            "will not block when minimum owner/loadout evidence is present.\n",
        );
      }

      const dispatchTarget =
        metaName ||
        toolInput?.agent_type ||
        toolInput?.subagent_type ||
        toolInput?.type ||
        "";
      if (
        matchedTaskPacket &&
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

  if (detectHookRuntime() === "codex" && !state.queryBypass) {
    const envelopeGate = checkCodexWorkerInvocationEnvelope(toolInput, toolName);
    if (!envelopeGate.met) {
      exitAfterDeny(
        `Codex owner-binding evidence is malformed or unverifiable; dispatch stays blocked until inspectable binding evidence is supplied. ` +
          `Missing: ${envelopeGate.missing.join(", ")}. task_name and followup target are runtime instance labels, not owner identity.`,
      );
    }
    if (envelopeGate.envelope) {
      const stateBindingGate = checkCodexEnvelopeAgainstState(
        envelopeGate.envelope,
        state,
        envelopeGate.ownerBinding,
      );
      if (!stateBindingGate.met) {
        exitAfterDeny(
          `Codex owner-binding evidence does not match the Thinking worker packet. ` +
            `Missing: ${stateBindingGate.missing.join(", ")}.`,
        );
      }
    }
  }

  const updated = recordDispatch(state, agentDesc, metaName, toolInput);
  await writeSpineState(cwd, updated);
  process.exit(0);
}

// queryBypass is a pure read-only route. Mutating host control-plane tools must
// cross that boundary before the general control-plane allow; TaskList,
// TaskGet, and TaskOutput remain available as read-only inspection surfaces.
if (state.queryBypass && MUTATING_CONTROL_PLANE_TOOLS.has(toolName)) {
  exitAfterDeny(
    "queryBypass is limited to pure read-only inspection; mutating control-plane tools are denied.",
  );
}

// Passive control-plane tools, including task/todo bookkeeping, are allowed.
// Bookkeeping never records an Agent dispatch and therefore cannot satisfy or
// bypass the separate Agent-dispatch gates above; sequencing quality belongs
// to the dispatcher, Review, and validators rather than a repeated Hook deny.
if (CONTROL_PLANE_TOOLS.has(toolName)) {
  process.exit(0);
}

// AskUserQuestion: always allow — it is a read-only UI surface, and
// PreToolUse hooks strip its return data (anthropics/claude-code#12031).
// Bypassing hook processing here prevents the stripping bug.
if (toolName === "AskUserQuestion") {
  process.exit(0);
}

// Read-only tools: always allow
if (isReadOnlyTool(toolName)) {
  process.exit(0);
}

// Query bypass skips orchestration confirmation only. It remains read-only.
if (state.queryBypass) {
  // Deadlock breaker: the spine-state file itself must always be writable.
  // Otherwise clearing queryBypass (which requires writing spine-state.json)
  // becomes impossible once queryBypass is on. Scoped strictly to
  // spine-state.json / the spine/ dir via isSpineStateWrite().
  if (isSpineStateWrite()) {
    process.exit(0);
  }
  if (toolName === "Bash" && isReadOnlyBash((toolInput?.command || "").trim())) {
    process.exit(0);
  }
  exitAfterDeny(
    "queryBypass is limited to pure read-only inspection; mutation or state-changing tools are denied.",
  );
}

// Local execution tools are not stage drivers. Critical / Fetch / Thinking and
// later stage evidence still govern Agent dispatch and public-ready claims, but
// they must never block or warn on ordinary project edits or local commands.
if (isExecutionTool(toolName)) {
  if (isSpineStateWrite()) {
    process.exit(0);
  }

  // Meta-agent readonly enforcement (covers Bash/Edit/Write/MultiEdit/NotebookEdit).
  // This runs before the planning-file exemption so that a meta-* caller cannot,
  // for example, push hand-crafted Bash through the planning-file shortcut.
  // Spine-state writes are the deadlock breaker and stay exempt above.
  const caller = inferCallerIdentity();
  if (caller.name && isMetaAgent(caller.name)) {
    enforceMetaReadonly(toolName, toolInput, state, caller);
    // warn-mode falls through; block-mode already exited.
  }
  process.exit(0);
}

process.exit(0);
