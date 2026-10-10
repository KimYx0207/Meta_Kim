import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { buildNativeCliEnvironment, buildNativeCliAuthStatusArgs, parseNativeCliAuthStatus } from "./native-cli-auth.mjs";
import { collectNativeCliEventTape } from "./native-cli-event-tape.mjs";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PRODUCER_RECEIPT_SCHEMA_VERSION,
  prepareRuntimeCapabilityAcceptanceStore,
  writeTestOnlyControlledRuntimeCapabilityAcceptanceAttempt,
} from "./runtime-capability-acceptance.mjs";
import { observeClaudeJsonl, observeCodexJsonl } from "./live-acceptance/observe-host-events.mjs";
import { readCodexDesktopEngineeringEvidence, readCodexDesktopSessionEvidence } from "./live-acceptance/read-codex-session-evidence.mjs";
import { runCli } from "./live-acceptance/run-clean-room-live-acceptance.mjs";
import { assertExactMarkerEventLifecycles } from "./live-acceptance/validate-marker-lifecycle.mjs";
import { loadSetupBoundRuntimeExecutable, revalidateRuntimeExecutableIdentity } from "./runtime-executable-binding.mjs";
import { resolveClaudeLiveProviderEnvironmentSync } from "./claude-live-provider-env.mjs";

const SUPPORTED_RUNTIMES = new Set(["claude_code", "codex"]);

/** Run controls constrain probes; they do not authorize provider use or spend. */
export function validateControlledProbeOptions({ runtime, source = "live_controlled", claudeMaxTurns, claudeMaxBudgetUsd, timeoutMs } = {}) {
  const hasClaudeControls = claudeMaxTurns !== undefined || claudeMaxBudgetUsd !== undefined;
  if (hasClaudeControls && runtime !== "claude_code") throw new Error("Claude probe limits require runtime claude_code");
  if ((hasClaudeControls || timeoutMs !== undefined) && !["live_controlled", "native_cli_stream"].includes(source)) throw new Error("Probe limits require source live_controlled or native_cli_stream");
  if (source === "native_cli_stream" && claudeMaxBudgetUsd !== undefined) throw new Error("native_cli_stream does not select API billing or accept an API dollar budget");
  if (claudeMaxTurns !== undefined && (!Number.isInteger(claudeMaxTurns) || claudeMaxTurns < 1 || claudeMaxTurns > 4)) {
    throw new Error("claudeMaxTurns must be an integer from 1 to 4");
  }
  if (claudeMaxBudgetUsd !== undefined && (typeof claudeMaxBudgetUsd !== "number" || !Number.isFinite(claudeMaxBudgetUsd) || claudeMaxBudgetUsd <= 0 || claudeMaxBudgetUsd > 0.10)) {
    throw new Error("claudeMaxBudgetUsd must be finite, greater than 0 and at most 0.10 USD per probe");
  }
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 25_000 || timeoutMs > 300_000)) {
    throw new Error("timeoutMs must be an integer from 25000 to 300000 milliseconds");
  }
  return { claudeMaxTurns, claudeMaxBudgetUsd, timeoutMs };
}
const CODEX_EPHEMERAL_NATIVE_TOOL_CAPABILITIES = new Set([
  "shell",
  "filesystem",
  "apply_patch / edit",
  "engineering_composite",
]);
const PRODUCERS = Object.freeze({
  agent: { id: "meta-kim.live-agent.agent", version: "2.0.0", family: "agent_subagent" },
  subagent: { id: "meta-kim.live-agent.subagent", version: "2.0.0", family: "agent_subagent" },
  shell: { id: "meta-kim.runtime-native-engineering.shell", version: "2.0.0", family: "runtime_tool" },
  filesystem: { id: "meta-kim.runtime-native-engineering.filesystem", version: "2.0.0", family: "runtime_tool" },
  "apply_patch / edit": { id: "meta-kim.runtime-native-engineering.apply-patch-edit", version: "2.0.0", family: "runtime_tool" },
});
const CODEX_DESKTOP_COMPOSITE_PRODUCER = Object.freeze({
  id: "meta-kim.codex-home-sessions.agent-subagent",
  version: "1.0.0",
  family: "agent_subagent",
  compositeFacets: ["agent", "subagent"],
});
const CODEX_ENGINEERING_COMPOSITE_PRODUCER = Object.freeze({
  id: "meta-kim.codex-engineering.shell-filesystem-edit",
  version: "1.0.0",
  family: "runtime_tool",
  compositeFacets: ["shell", "filesystem", "apply_patch / edit"],
});
const CODEX_ENGINEERING_FACETS = Object.freeze(["shell", "filesystem", "apply_patch / edit"]);
const CODEX_DESKTOP_ENGINEERING_PRODUCER = Object.freeze({
  id: "meta-kim.codex-desktop-engineering.shell-filesystem-edit",
  version: "1.0.0",
  family: "runtime_tool",
  compositeFacets: ["shell", "filesystem", "apply_patch / edit"],
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeCodexOption(value, label) {
  if (value == null) return null;
  const normalized = String(value).trim();
  if (!normalized || normalized.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(normalized)) {
    throw new Error(`Codex ${label} must be a non-empty safe CLI value`);
  }
  return normalized;
}

function testOnlyExecutableIdentity(runtime) {
  const realpath = `<test-only:${runtime}>`;
  return {
    realpath,
    sha256: sha256(realpath),
    size: 0,
    bindingSource: "explicit_test_only_executor",
  };
}

function atomicExclusiveWrite(filePath, bytes) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(handle, bytes);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, filePath);
}

function cleanupWorkspaceBestEffort({ workspace, producerRoot, attemptId, completed }) {
  try {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
    return;
  } catch (error) {
    const resolvedWorkspace = path.resolve(workspace);
    const resolvedProducerRoot = path.resolve(producerRoot);
    const relativeWorkspace = path.relative(resolvedProducerRoot, resolvedWorkspace);
    const workspaceIsInsideProducerRoot = relativeWorkspace === "" ||
      (relativeWorkspace !== ".." && !relativeWorkspace.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeWorkspace));
    const cleanupRecord = {
      schemaVersion: "meta-kim-runtime-capability-cleanup-pending-v1",
      attemptId,
      observedAt: new Date().toISOString(),
      // Codex probes use an OS-temp workspace so ancestor project skills cannot
      // be discovered. Preserve an actionable absolute path for that external
      // workspace instead of emitting an unsafe ../../ reference.
      workspace: workspaceIsInsideProducerRoot
        ? relativeWorkspace.replaceAll("\\", "/")
        : resolvedWorkspace,
      workspaceReferenceKind: workspaceIsInsideProducerRoot ? "producer_root_relative" : "external_temp_absolute",
      producerCompleted: completed,
      errorCode: error?.code ?? "unknown",
      retryOnNextMaintenance: true,
    };
    const pendingPath = path.join(producerRoot, "cleanup-pending", `${attemptId}.json`);
    try {
      atomicExclusiveWrite(pendingPath, Buffer.from(`${JSON.stringify(cleanupRecord, null, 2)}\n`, "utf8"));
    } catch {
      // Cleanup is subordinate to host evidence. Never replace a real producer
      // result or its original error with a transient Windows directory lock.
    }
  }
}

function acceptanceWriterFor(testOnly, internalWriter) {
  if (typeof internalWriter === "function") return internalWriter;
  if (testOnly) return writeTestOnlyControlledRuntimeCapabilityAcceptanceAttempt;
  throw new Error("production controlled receipts require the formal runtime produce API");
}

function createControlledProbeWorkspace({ runtime, producerRoot, attemptId, label }) {
  if (runtime === "codex") {
    // A workspace below the repository inherits ancestor project skills/rules.
    // Keep Codex's controlled child outside that discovery tree while leaving
    // receipts and raw evidence under the profile-owned producer root.
    return mkdtempSync(path.join(os.tmpdir(), `meta-kim-codex-${label}-`));
  }
  const workspace = path.join(producerRoot, "workspaces", attemptId);
  mkdirSync(workspace, { recursive: true });
  return workspace;
}

export function selectLiveControlledProducerRoute({ runtime, capabilities = [] } = {}) {
  const requested = Array.isArray(capabilities) ? capabilities : [];
  const exactCodexEngineeringRequest = runtime === "codex" &&
    requested.length === CODEX_ENGINEERING_FACETS.length &&
    new Set(requested).size === CODEX_ENGINEERING_FACETS.length &&
    requested.every((capability) => CODEX_ENGINEERING_FACETS.includes(capability));
  return exactCodexEngineeringRequest ? "codex_engineering_composite" : "capability_specific";
}

function promptFor(capability, runtime, nonce, marker) {
  const common = `This is a bounded Meta_Kim runtime capability probe ${nonce}. Capability marker: ${marker}. Do only the requested action inside the current temporary workspace and then stop.`;
  if (capability === "agent") {
    if (runtime === "codex") return `${common} First discover the current host's native spawn_agent capability and its actual schema. If it is deferred, use the exposed native tool-search capability to load it before calling it. Then call the discovered native spawn_agent exactly once. Require the child to inherit the current model and reasoning effort without overrides; never select a different model. Give that child the exact task of returning ${marker} as its entire final response. Only after spawn_agent returns a child id, call the native wait operation for that child until it reports completed. Never call wait before spawn_agent, do not use a legacy substitute for the current host's native capability, and do not imitate either action with ordinary text.`;
    return `${common} Use the runtime's native agent/subagent tool exactly once and wait for its successful completion. Require the child to return exactly the complete capability marker ${marker} as its entire final response; the nonce alone is not sufficient.`;
  }
  if (capability === "subagent") {
    if (runtime === "codex") return `${common} First discover the current host's native spawn_agent capability and its actual schema. If it is deferred, use the exposed native tool-search capability to load it before calling it. Then call the discovered native spawn_agent exactly once. Require the child to inherit the current model and reasoning effort without overrides; never select a different model. Give that child the exact task of returning ${marker} as its entire final response. Only after spawn_agent returns a child id, call the native wait operation for that child until it reports completed. Never call wait before spawn_agent, do not use a legacy substitute for the current host's native capability, and do not imitate either action with ordinary text.`;
    return `${common} Spawn exactly one native child subagent and wait for its successful completion. Require the child to return exactly the complete capability marker ${marker} as its entire final response; the nonce alone is not sufficient.`;
  }
  if (capability === "shell") return `${common} Use the native shell tool to create meta-kim-probe.txt containing exactly shell-${marker}.`;
  if (capability === "filesystem") return `${common} Use the runtime's native file-reading capability to read meta-kim-probe.txt and report its exact existing content ${marker}; do not edit it.`;
  if (capability === "apply_patch / edit") {
    if (runtime === "claude_code") {
      return `${common} First call the native Read tool to read meta-kim-probe.txt. Then call the native Edit tool exactly once with old_string exactly before-${marker} and new_string exactly after-${marker}. Do not call Write or any other write tool. When Edit completes, meta-kim-probe.txt must contain exactly one line, after-${marker}, followed by a newline. Do not keep the before marker and do not add any other text.`;
    }
    return `${common} First use the native file-reading capability to read meta-kim-probe.txt. Then use the runtime's native edit/apply-patch capability to replace the entire file contents. When the edit completes, meta-kim-probe.txt must contain exactly one line, after-${marker}, followed by a newline. Do not keep the before marker and do not add any other text.`;
  }
  throw new Error(`no controlled producer exists for capability ${capability}`);
}

export function codexLiveInvocationArgs({
  workspace,
  argsPrefix = [],
  platform = process.platform,
  model = null,
  reasoningEffort = null,
  ephemeral = false,
}) {
  const hostSandboxFlavor = platform === "win32" ? ["-c", "windows.sandbox=unelevated"] : [];
  const modelValue = normalizeCodexOption(model, "model");
  const reasoningEffortValue = normalizeCodexOption(reasoningEffort, "reasoning effort");
  return [
    ...argsPrefix,
    "exec", "--json",
    ...(ephemeral ? ["--ephemeral"] : []),
    "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
    ...(modelValue ? ["-m", modelValue] : []),
    ...(reasoningEffortValue ? ["-c", `model_reasoning_effort="${reasoningEffortValue}"`] : []),
    // Native capability probes need only their explicit marker task. CODEX_HOME
    // alone does not isolate ~/.agents/skills or ancestor project instructions.
    // These flags affect this child invocation only, never the user's config.
    "--enable", "skip_host_skill_discovery",
    "-c", "project_doc_max_bytes=0",
    ...hostSandboxFlavor,
    "-s", "workspace-write",
    "-C", workspace,
    "-",
  ];
}

function commandFor(runtime, workspace, capability, executableIdentity = null, {
  codexModel = null,
  codexReasoningEffort = null,
  claudeMaxTurns,
  claudeMaxBudgetUsd,
} = {}) {
  const argsPrefix = executableIdentity?.argsPrefix ?? [];
  if (runtime === "codex") return {
    command: executableIdentity?.realpath ?? "test-only-codex",
    args: codexLiveInvocationArgs({
      workspace,
      argsPrefix,
      model: codexModel,
      reasoningEffort: codexReasoningEffort,
      ephemeral: CODEX_EPHEMERAL_NATIVE_TOOL_CAPABILITIES.has(capability),
    }),
    observer: observeCodexJsonl,
  };
  // Allowed-tool grants must name the tool the host actually exposes: Windows
  // Claude Code exposes PowerShell (not Bash) as the shell tool, and newer
  // hosts name the subagent tool Task. Listing both keeps dontAsk from
  // declining the probe's natural choice; eventMatches stays surface-regex
  // based, so evidence binding is unaffected.
  const claudeTool = capability === "shell"
    ? "Bash,PowerShell"
    : capability === "filesystem"
      ? "Read"
      : capability === "apply_patch / edit"
        ? "Read,Edit"
        : "Agent,Task";
  return {
    command: executableIdentity?.realpath ?? "test-only-claude",
    // No `--tools`: Claude Code 2.1.236 resolves `--tools <name>` to an empty
    // tool set (live-verified: init event tools:[]), leaving the probe model
    // with no tool to run. `--allowedTools` carries the permission grant and
    // the marker/workspace assertions bind the evidence to one capability.
    args: [...argsPrefix,
      "--setting-sources", "",
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--strict-mcp-config",
      "--mcp-config", path.join(workspace, "meta-kim-empty-mcp.json"),
      "--permission-mode", "dontAsk",
      "--no-session-persistence",
      "--allowedTools", claudeTool,
      ...(claudeMaxTurns !== undefined ? ["--max-turns", String(claudeMaxTurns)] : []),
      ...(claudeMaxBudgetUsd !== undefined ? ["--max-budget-usd", String(claudeMaxBudgetUsd)] : []),
    ],
    observer: observeClaudeJsonl,
  };
}

// This source consumes only a newly spawned official CLI's structured stdout.
// Authentication remains inside that CLI: no credential or session-file access.
export function nativeCliStreamInvocationArgs({ runtime, workspace, capability, argsPrefix = [], codexModel, codexReasoningEffort, claudeMaxTurns = 4, marker, platform = process.platform } = {}) {
  if (runtime === "codex") return codexLiveInvocationArgs({ workspace, argsPrefix, model: codexModel,
    reasoningEffort: codexReasoningEffort, ephemeral: true }).filter((arg) => arg !== "--ignore-rules");
  if (runtime !== "claude_code") throw new Error("unsupported native CLI runtime");
  const configured = commandFor(runtime, workspace, capability, { argsPrefix }, { claudeMaxTurns });
  const required = ["agent", "subagent"].includes(capability) ? ["Agent", "Task"]
    : capability === "shell" ? [platform === "win32" ? "PowerShell" : "Bash"] : capability === "filesystem" ? ["Read"] : ["Read", "Edit"];
  const disabled = ["Bash", "PowerShell", "Read", "Edit", "Write", "Agent", "Task", "WebSearch", "WebFetch", "Skill", "mcp__*"].filter((tool) => !required.includes(tool));
  const exactPath = "./meta-kim-probe.txt";
  let allowed = required.map((tool) => ["Read", "Edit"].includes(tool) ? `${tool}(${exactPath})` : tool).join(",");
  if (capability === "shell") {
    if (!/^META_KIM_CAPABILITY_SHELL_[0-9a-f-]{36}$/u.test(marker ?? "")) throw new Error("native shell permission requires the fresh capability marker");
    allowed = platform === "win32"
      ? `PowerShell(Set-Content -LiteralPath meta-kim-probe.txt -Value 'shell-${marker}' -NoNewline -Encoding ascii)`
      : `Bash(printf '%s' 'shell-${marker}' > meta-kim-probe.txt)`;
  }
  configured.args[configured.args.indexOf("--allowedTools") + 1] = allowed;
  return [...configured.args, "--safe-mode", "--disallowedTools", disabled.join(","), ...(["agent", "subagent"].includes(capability) ? ["--forward-subagent-text"] : [])];
}

function nativeCliStreamExecutor(request) {
  const env = buildNativeCliEnvironment(request.runtime);
  const run = (args, extra = {}) => spawnSync(request.command, args, {
    cwd: request.workspace, env, shell: false, windowsHide: true, encoding: "utf8",
    timeout: 30_000, maxBuffer: 64 * 1024, ...extra,
  });
  revalidateRuntimeExecutableIdentity(request.executableIdentity);
  const prefix = request.executableIdentity?.argsPrefix ?? [];
  const version = run([...prefix, "--version"]);
  assertRuntimeHostInvocationSuccess(request.runtime, "native CLI version preflight", version);
  const runtimeVersion = String(version.stdout ?? "").trim();
  if (!runtimeVersion || runtimeVersion.length > 256 || /[\r\n]/u.test(runtimeVersion)) throw new Error("native CLI version identity is invalid");
  const help = run([...prefix, "--help"]);
  const helpText = String(help.stdout ?? "");
  assertRuntimeHostInvocationSuccess(request.runtime, "native CLI help preflight", help);
  if (request.runtime === "claude_code" && !["--safe-mode", "--no-session-persistence", "--forward-subagent-text"].every((flag) => helpText.includes(flag))) {
    throw new Error("native CLI lacks the required bounded stream flags");
  }
  const authArgs = buildNativeCliAuthStatusArgs(request.runtime, prefix);
  // Match the actual invocation's empty optional settings; CLI credential storage
  // and managed policy remain in place and are never read by this producer.
  if (request.runtime === "claude_code") authArgs.splice(prefix.length, 0, "--setting-sources", "", "--safe-mode");
  const authResult = run(authArgs);
  assertRuntimeHostInvocationSuccess(request.runtime, "native CLI auth-status preflight", authResult);
  const authObservation = parseNativeCliAuthStatus(request.runtime, authResult);
  const result = run(request.args, { input: request.prompt, timeout: request.timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  revalidateRuntimeExecutableIdentity(request.executableIdentity);
  return { ...result, runtimeVersion, authObservation, executableIdentity: request.executableIdentity,
    runtimeIsolation: "official_cli_existing_login_fresh_workspace_structured_stream" };
}

function productionExecutorSelected(executor) {
  return executor === productionExecutor || executor === nativeCliStreamExecutor;
}

function evidenceFromResult(result, request, marker) {
  if (request.source !== "native_cli_stream") return { rawBytes: Buffer.from(String(result?.stdout ?? ""), "utf8"), capture: null };
  assertRuntimeHostInvocationSuccess(request.runtime, "native CLI bounded probe", result);
  if (result.authObservation?.kind !== "official_existing_login" || result.authObservation.runtime !== request.runtime ||
      result.authObservation.provider !== (request.runtime === "codex" ? "chatgpt" : "firstParty")) {
    throw new Error("native CLI probe lacks verified official existing-login provenance");
  }
  const tape = collectNativeCliEventTape(String(result.stdout ?? ""), {
    runtime: request.runtime, capability: request.capability, workspace: request.workspace, marker,
  });
  return { rawBytes: Buffer.from(tape.text, "utf8"), capture: tape.capture };
}

function safeChildDiagnostic(value) {
  if (value == null) return null;
  const text = String(value);
  return /^[A-Z][A-Z0-9_]{0,63}$/u.test(text) ? text : "unknown";
}

export function runtimeHostInvocationError(runtime, phase, result) {
  const exitCode = Number.isInteger(result?.status) ? result.status : null;
  const signal = safeChildDiagnostic(result?.signal ?? result?.error?.signal);
  const childErrorCode = safeChildDiagnostic(result?.error?.code);
  const errno = Number.isSafeInteger(result?.error?.errno) ? result.error.errno : null;
  // Node's syscall may append the absolute executable path. Keep only a known
  // operation token; never retain paths, argv, error.message, stdout or stderr.
  const syscallToken = typeof result?.error?.syscall === "string" ? result.error.syscall.split(/\s/u, 1)[0] : null;
  const syscall = syscallToken == null ? null : ["spawn", "spawnSync", "execFile", "execFileSync", "fork", "uv_spawn"].includes(syscallToken) ? syscallToken : "unknown";
  const error = new Error(
    `${runtime} ${phase} failed: exit=${exitCode ?? "unknown"}; signal=${signal ?? "none"}; errorCode=${childErrorCode ?? "none"}; errno=${errno ?? "unknown"}; syscall=${syscall ?? "none"}`,
  );
  error.exitCode = exitCode;
  error.status = exitCode;
  error.code = childErrorCode;
  error.errno = errno;
  error.syscall = syscall;
  error.signal = signal;
  error.childErrorCode = childErrorCode;
  // Keep the conventional bounded diagnostic name used by release evidence.
  error.errorCode = childErrorCode;
  return error;
}

export function assertRuntimeHostInvocationSuccess(runtime, phase, result) {
  if (!result || result.status !== 0 || result.signal != null || result.error != null) {
    throw runtimeHostInvocationError(runtime, phase, result);
  }
  return result;
}

function cleanupIsolatedCodexRuntimeHome(isolatedRuntimeHome, {
  remove = rmSync,
  exists = existsSync,
} = {}) {
  try {
    remove(isolatedRuntimeHome, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  } catch {
    const copiedAuth = path.join(isolatedRuntimeHome, "auth.json");
    try {
      remove(copiedAuth, { force: true, maxRetries: 8, retryDelay: 125 });
    } catch {
      // Checked below; a retained auth copy is a hard security failure.
    }
    if (exists(copiedAuth)) throw new Error("codex isolated auth cleanup failed");
  }
}

function setCaseInsensitiveEnvironmentValue(env, name, value) {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === name.toLowerCase()) delete env[key];
  }
  env[name] = value;
}

function removeCaseInsensitiveEnvironmentValue(env, name) {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === name.toLowerCase()) delete env[key];
  }
}

function isolatedCodexChildEnvironment(inheritedEnv, isolatedRuntimeHome, { mkdir = mkdirSync } = {}) {
  const isolatedTemp = path.join(isolatedRuntimeHome, "tmp");
  // Node and Windows resolve TEMP/TMP before the child starts. Create the
  // temp root while the isolated home still exists so a missing subdirectory
  // cannot make the real CLI fall back to the host temp tree.
  mkdir(isolatedTemp, { recursive: true });
  const env = { ...inheritedEnv };
  for (const [name, value] of [
    ["HOME", isolatedRuntimeHome],
    ["USERPROFILE", isolatedRuntimeHome],
    ["APPDATA", path.join(isolatedRuntimeHome, "AppData", "Roaming")],
    ["LOCALAPPDATA", path.join(isolatedRuntimeHome, "AppData", "Local")],
    ["TMP", isolatedTemp],
    ["TEMP", isolatedTemp],
    ["XDG_CONFIG_HOME", path.join(isolatedRuntimeHome, ".config")],
    ["XDG_DATA_HOME", path.join(isolatedRuntimeHome, ".local", "share")],
    ["XDG_CACHE_HOME", path.join(isolatedRuntimeHome, ".cache")],
    ["CODEX_HOME", isolatedRuntimeHome],
    ["CODEX_SKILLS_DIR", path.join(isolatedRuntimeHome, "skills")],
  ]) setCaseInsensitiveEnvironmentValue(env, name, value);
  const windowsHome = path.win32.normalize(isolatedRuntimeHome);
  const windowsParts = path.win32.parse(windowsHome);
  const driveRoot = /^([A-Za-z]:)\\$/u.exec(windowsParts.root);
  const uncRoot = /^(\\\\[^\\]+\\[^\\]+)\\$/u.exec(windowsParts.root);
  if (driveRoot) {
    setCaseInsensitiveEnvironmentValue(env, "HOMEDRIVE", driveRoot[1]);
    setCaseInsensitiveEnvironmentValue(env, "HOMEPATH", windowsHome.slice(driveRoot[1].length) || path.win32.sep);
  } else if (uncRoot) {
    setCaseInsensitiveEnvironmentValue(env, "HOMEDRIVE", uncRoot[1]);
    setCaseInsensitiveEnvironmentValue(env, "HOMEPATH", windowsHome.slice(uncRoot[1].length) || path.win32.sep);
  } else {
    // Never leave a real Windows drive/home pair behind if a test or a
    // non-Windows host supplies a POSIX temporary path.
    removeCaseInsensitiveEnvironmentValue(env, "HOMEDRIVE");
    removeCaseInsensitiveEnvironmentValue(env, "HOMEPATH");
  }
  return env;
}

export function isolatedClaudeProbeEnvironment(providerEnv, controlledHome, { mkdir = mkdirSync } = {}) {
  if (!path.isAbsolute(controlledHome)) throw new Error("controlled Claude home must be absolute");
  const env = isolatedCodexChildEnvironment(providerEnv, controlledHome, { mkdir });
  removeCaseInsensitiveEnvironmentValue(env, "CODEX_HOME");
  removeCaseInsensitiveEnvironmentValue(env, "CODEX_SKILLS_DIR");
  setCaseInsensitiveEnvironmentValue(env, "TMPDIR", path.join(controlledHome, "tmp"));
  for (const [name, value] of [
    ["CLAUDE_CONFIG_DIR", path.join(controlledHome, ".claude")],
    ["CLAUDE_HOME", controlledHome],
    ["CLAUDE_SKILLS_DIR", path.join(controlledHome, ".claude", "skills")],
  ]) setCaseInsensitiveEnvironmentValue(env, name, value);
  for (const name of ["APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "CLAUDE_CONFIG_DIR"]) mkdir(env[name], { recursive: true });
  return env;
}

export function withRuntimeIsolation(request, callback, {
  tempRoot = os.tmpdir(),
  sourceRuntimeHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  inheritedEnv = process.env,
  mkdtemp = mkdtempSync,
  mkdir = mkdirSync,
  exists = existsSync,
  copyFile = copyFileSync,
  remove = rmSync,
} = {}) {
  let isolatedRuntimeHome = null;
  let env = inheritedEnv;
  try {
    if (request.runtime === "claude_code") {
      env = resolveClaudeLiveProviderEnvironmentSync();
      if (request.claudeMaxTurns !== undefined || request.claudeMaxBudgetUsd !== undefined) {
        // Resolve the authorized provider first, then isolate writable CLI
        // state without copying settings, auth files, or changing token type.
        env = isolatedClaudeProbeEnvironment(env, path.join(request.workspace, "controlled-cli-home"), { mkdir });
      }
    } else if (request.runtime === "codex") {
      // Keep setup in this try/finally: auth absence or copy failure must still
      // remove the temporary home created for this invocation.
      isolatedRuntimeHome = mkdtemp(path.join(tempRoot, "meta-kim-codex-probe-"));
      const authSource = path.join(sourceRuntimeHome, "auth.json");
      const authTarget = path.join(isolatedRuntimeHome, "auth.json");
      if (!exists(authSource)) throw new Error("codex auth.json is required for the isolated native probe");
      copyFile(authSource, authTarget);
      env = isolatedCodexChildEnvironment(inheritedEnv, isolatedRuntimeHome, { mkdir });
    }
    return callback({ env, isolatedRuntimeHome });
  } finally {
    if (isolatedRuntimeHome) cleanupIsolatedCodexRuntimeHome(isolatedRuntimeHome, { remove, exists });
  }
}

function productionExecutor(request) {
  return withRuntimeIsolation(request, ({ env }) => {
    revalidateRuntimeExecutableIdentity(request.executableIdentity);
    const version = runCli(request.command, [...(request.executableIdentity?.argsPrefix ?? []), "--version"], { cwd: request.workspace, env, timeoutMs: 30_000 });
    if (version.status !== 0 || !String(version.stdout ?? version.stderr ?? "").trim()) {
      throw runtimeHostInvocationError(request.runtime, "version probe", version);
    }
    const result = runCli(request.command, request.args, {
      cwd: request.workspace,
      env,
      input: request.prompt,
      timeoutMs: request.timeoutMs,
    });
    revalidateRuntimeExecutableIdentity(request.executableIdentity);
    return {
      ...result,
      runtimeVersion: String(version.stdout ?? version.stderr).trim().split(/\r?\n/u)[0],
      runtimeIsolation: request.runtime === "codex" ? "ephemeral_auth_home_and_rules_isolated"
        : (request.claudeMaxTurns !== undefined || request.claudeMaxBudgetUsd !== undefined) ? "controlled_workspace_home_trusted_provider_env_only" : "empty_setting_sources_strict_mcp_current_auth",
      executableIdentity: request.executableIdentity,
    };
  });
}

function eventMatches(runtime, capability, event, rawText, marker) {
  const surface = String(event.hostSurface ?? event.providerId ?? "").toLowerCase();
  const lines = String(rawText).split(/\r?\n/u);
  const sourceText = (event.sourceLines ?? []).map((line) => lines[line - 1] ?? "").join("\n");
  if (["agent", "subagent"].includes(capability)) {
    const exactMarkerDigest = sha256(marker);
    return event.family === "agent_subagent" &&
      /agent|task|spawn/u.test(surface) &&
      Boolean(event.childSessionId) &&
      event.resultTextSha256 === exactMarkerDigest;
  }
  if (!sourceText.includes(marker)) return false;
  if (capability === "shell") return event.family === "runtime_tool" && /bash|shell|command/u.test(surface);
  if (capability === "filesystem") {
    return event.family === "runtime_tool" && (runtime === "codex"
      ? /shell|command/u.test(surface) && /\b(?:get-content|cat|type|read)\b/iu.test(sourceText) && !/(?:>|set-content|out-file|remove-item|del\b|rm\b)/iu.test(sourceText)
      : /^(read|glob|grep)$/u.test(surface));
  }
  if (capability === "apply_patch / edit") {
    return event.family === "runtime_tool" && (runtime === "codex" ? /file_change|apply_patch|patch/u.test(surface) : /edit|write|patch/u.test(surface));
  }
  return false;
}

function assertWorkspaceOutcome(workspace, capability, marker) {
  if (["agent", "subagent"].includes(capability)) return;
  const file = path.join(workspace, "meta-kim-probe.txt");
  if (!existsSync(file)) throw new Error(`${capability} probe did not leave the bounded workspace artifact`);
  const text = readFileSync(file, "utf8").trim();
  const expected = capability === "shell" ? `shell-${marker}` : capability === "filesystem" ? marker : `after-${marker}`;
  if (text !== expected) throw new Error(`${capability} probe workspace outcome mismatch`);
}

export function runtimeCapabilityProducerRegistry() {
  return structuredClone({
    ...PRODUCERS,
    codexDesktopAgentSubagent: CODEX_DESKTOP_COMPOSITE_PRODUCER,
    codexEngineeringComposite: CODEX_ENGINEERING_COMPOSITE_PRODUCER,
    codexDesktopEngineering: CODEX_DESKTOP_ENGINEERING_PRODUCER,
  });
}

/** Attests one explicitly selected Codex Desktop engineering tool chain. */
export async function runCodexDesktopEngineeringSessionProducer({
  projectRoot,
  profile,
  codexHome,
  threadId,
  marker,
  workspacePath,
  sinceMs,
  reader = readCodexDesktopEngineeringEvidence,
  _acceptanceWriter = null,
  attemptBase = `${new Date().toISOString().replace(/[-:.]/gu, "")}-${randomUUID()}`,
} = {}) {
  const canonicalCodexHome = path.join(os.homedir(), ".codex");
  if (reader === readCodexDesktopEngineeringEvidence && codexHome) {
    if (path.resolve(codexHome) !== path.resolve(canonicalCodexHome)) throw new Error("Codex Desktop engineering producer can read only canonical ~/.codex");
  }
  const paths = prepareRuntimeCapabilityAcceptanceStore({ projectRoot, profile });
  const producerRoot = path.join(paths.profileRoot, "runtime-capability-producers");
  const trustedWorkspaces = path.resolve(producerRoot, "workspaces");
  const resolvedWorkspace = path.resolve(workspacePath);
  const relativeWorkspace = path.relative(trustedWorkspaces, resolvedWorkspace);
  if (relativeWorkspace === "" || relativeWorkspace === ".." || relativeWorkspace.startsWith(`..${path.sep}`) || path.isAbsolute(relativeWorkspace)) {
    throw new Error("Codex Desktop engineering workspace must be inside the controlled producer workspaces root");
  }
  const evidence = await reader({ codexHome: reader === readCodexDesktopEngineeringEvidence ? canonicalCodexHome : codexHome, threadId, marker, workspacePath: resolvedWorkspace, sinceMs });
  const probeFile = path.join(resolvedWorkspace, "meta-kim-probe.txt");
  if (!existsSync(probeFile) || readFileSync(probeFile, "utf8").trimEnd() !== `after-${marker}`) {
    throw new Error("Codex Desktop engineering final workspace outcome mismatch");
  }
  const nonce = String(marker).match(/META_KIM_CAPABILITY_ENGINEERING_([0-9a-f-]{36})$/u)?.[1];
  if (!nonce || evidence.sourceCategory !== "codex_desktop_sessions") throw new Error("Codex Desktop engineering evidence binding is invalid");
  const artifactsDir = path.join(producerRoot, "artifacts");
  const receiptsDir = path.join(producerRoot, "receipts");
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(receiptsDir, { recursive: true });
  const rawPath = path.join(artifactsDir, `${attemptBase}-desktop-engineering.jsonl`);
  const rawBytes = Buffer.from(evidence.parentSessionText, "utf8");
  atomicExclusiveWrite(rawPath, rawBytes);
  const eventBindings = {
    shell: [evidence.events.shell.eventId],
    filesystem: [evidence.events.filesystemBefore.eventId, evidence.events.filesystemAfter.eventId],
    "apply_patch / edit": [evidence.events.patchAdd.eventId, evidence.events.patchUpdate.eventId],
  };
  const lifecycle = {
    allowlisted: true,
    lifecycleId: evidence.lifecycleId,
    facets: ["shell", "filesystem", "apply_patch / edit"],
    sourceCategory: evidence.sourceCategory,
    markerDigest: evidence.markerDigest,
    observedAt: evidence.observedAt,
    threadId: evidence.threadId,
    workspaceDigest: evidence.workspaceDigest,
    workspaceRef: path.relative(paths.profileRoot, resolvedWorkspace).replaceAll("\\", "/"),
    eventBindings,
    orderedEventIds: [evidence.events.shell.eventId, evidence.events.patchAdd.eventId, evidence.events.filesystemBefore.eventId, evidence.events.patchUpdate.eventId, evidence.events.filesystemAfter.eventId],
    beforeContentSha256: sha256(`before-${marker}\n`),
    finalContentSha256: sha256(`after-${marker}\n`),
    parentSessionRef: evidence.parentSessionRef,
    parentSnapshotSize: evidence.parentSnapshotSize,
    parentFragmentDigest: evidence.parentFragmentDigest,
    parentSourceLines: evidence.parentSourceLines,
  };
  const allEvents = Object.values(evidence.events);
  const results = [];
  for (const capability of lifecycle.facets) {
    const attemptId = `${attemptBase}-${capability.replace(/[^a-z0-9]+/giu, "-").replace(/^-|-$/gu, "")}`;
    const correlationId = randomUUID();
    const selectedEvents = eventBindings[capability].map((id) => allEvents.find((event) => event.eventId === id));
    const request = { runtime: "codex", capability, mode: "interactive_host", sourceCategory: evidence.sourceCategory, threadId, lifecycleId: evidence.lifecycleId };
    const result = { status: 0, signal: null, stdoutSha256: sha256(rawBytes), stderrSha256: sha256("") };
    const receiptWithoutHash = {
      schemaVersion: PRODUCER_RECEIPT_SCHEMA_VERSION,
      attestationAuthority: "controlled_producer",
      producer: CODEX_DESKTOP_ENGINEERING_PRODUCER,
      testOnly: reader !== readCodexDesktopEngineeringEvidence,
      runtime: "codex",
      runtimeVersion: String(evidence.cliVersion ?? "").trim(),
      capability,
      mode: "interactive_host",
      attemptId,
      correlationId,
      observedAt: evidence.observedAt,
      outcome: "pass",
      hostInvocation: { runtimeIsolation: "codex_desktop_current_session", request, requestDigest: sha256(JSON.stringify(request)), result, resultDigest: sha256(JSON.stringify(result)), exitCode: 0, signal: null },
      capabilityNonce: nonce,
      capabilityMarker: marker,
      compositeLifecycle: { ...lifecycle, facet: capability },
      eventEvidence: selectedEvents,
      rawArtifact: { path: path.relative(paths.profileRoot, rawPath).replaceAll("\\", "/"), sha256: sha256(rawBytes) },
      workspaceOutcome: { kind: "bounded_file", contentSha256: lifecycle.finalContentSha256 },
      flags: { fixture: false, recoveredFromTimeout: false, blockedFromRelease: false },
      failureClass: null,
    };
    const receipt = { ...receiptWithoutHash, recordHash: sha256(JSON.stringify(receiptWithoutHash)) };
    const receiptPath = path.join(receiptsDir, `${attemptId}.json`);
    atomicExclusiveWrite(receiptPath, Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8"));
    const acceptance = acceptanceWriterFor(receipt.testOnly, _acceptanceWriter)({ projectRoot: paths.projectRoot, profile: paths.profile, receiptPath, runtime: "codex", capability, mode: "interactive_host", attemptId, correlationId });
    results.push({ capability, receipt, receiptPath, acceptance });
  }
  return { rawPath, evidence, results };
}

function sourceTextForEvent(rawText, event) {
  const lines = String(rawText).split(/\r?\n/u);
  return (event.sourceLines ?? []).map((line) => lines[line - 1] ?? "").join("\n");
}

function eventStartLine(event) {
  return Math.min(...(event.sourceLines ?? []).filter(Number.isSafeInteger));
}

function pathIsEngineeringProbeTarget(candidate, workspace) {
  if (typeof candidate !== "string" || !candidate.trim() || typeof workspace !== "string" || !workspace.trim()) return false;
  const candidateText = candidate.trim();
  const workspaceText = workspace.trim();
  const windowsPath = /^[A-Za-z]:[\\/]/u.test(candidateText) || /^\\\\/u.test(candidateText) || /^[A-Za-z]:[\\/]/u.test(workspaceText);
  const pathApi = windowsPath ? path.win32 : path;
  const expected = pathApi.normalize(pathApi.resolve(workspaceText, "meta-kim-engineering-probe.txt"));
  const actual = pathApi.normalize(pathApi.isAbsolute(candidateText)
    ? pathApi.resolve(candidateText)
    : pathApi.resolve(workspaceText, candidateText));
  return (windowsPath ? actual.toLowerCase() : actual) === (windowsPath ? expected.toLowerCase() : expected);
}

function nativeFileChangeTargetsEngineeringProbe(source, workspace) {
  const completedFileChanges = String(source).split(/\r?\n/u).flatMap((line) => {
    try {
      const record = JSON.parse(line);
      return record?.type === "item.completed" && record.item?.type === "file_change"
        ? [record.item]
        : [];
    } catch {
      return [];
    }
  });
  if (completedFileChanges.length !== 1) return false;
  const changes = completedFileChanges[0]?.changes;
  return Array.isArray(changes) && changes.length === 1 && pathIsEngineeringProbeTarget(changes[0]?.path, workspace);
}

function selectCodexEngineeringEvents(rawText, marker, workspace) {
  const events = observeCodexJsonl(rawText).filter((event) => ["completed", "returned"].includes(event.resultStatus));
  const described = events.map((event) => ({ event, source: sourceTextForEvent(rawText, event) }));
  const filePattern = /meta-kim-engineering-probe\.txt/iu;
  const writes = described.filter(({ event, source }) =>
    event.family === "runtime_tool" && /shell|command/u.test(String(event.hostSurface ?? "").toLowerCase()) &&
    filePattern.test(source) && /set-content|out-file|writealltext|(?:^|\s)>/iu.test(source) && source.includes(`before-${marker}`));
  const reads = described.filter(({ event, source }) =>
    event.family === "runtime_tool" && /shell|command/u.test(String(event.hostSurface ?? "").toLowerCase()) &&
    filePattern.test(source) && /get-content|readalltext|\bcat\b|\btype\b/iu.test(source) &&
    !/set-content|out-file|writealltext|(?:^|\s)>/iu.test(source));
  const edits = described.filter(({ event, source }) => {
    if (event.family !== "runtime_tool") return false;
    const surface = String(event.hostSurface ?? "").toLowerCase();
    // Codex's native file_change event binds the changed path and lifecycle,
    // but does not echo the edited contents. Marker binding comes from the
    // ordered native reads around this event and the final workspace check;
    // do not replace the file_change event with either of those observations.
    const nativeFileChange = /file_change/u.test(surface) && nativeFileChangeTargetsEngineeringProbe(source, workspace);
    const markerBoundPatch = /apply_patch|patch|edit/u.test(surface) && filePattern.test(source) &&
      source.includes(`before-${marker}`) && source.includes(`after-${marker}`);
    return nativeFileChange || markerBoundPatch;
  });
  const beforeReads = reads.filter(({ source }) => source.includes(`before-${marker}`) && !source.includes(`after-${marker}`));
  const afterReads = reads.filter(({ source }) => source.includes(`after-${marker}`));
  if (writes.length !== 1 || beforeReads.length !== 1 || edits.length !== 1 || afterReads.length !== 1) {
    throw new Error("Codex engineering composite did not expose one exact write/read/edit/final-read chain");
  }
  const selected = {
    shell: writes[0].event,
    filesystemBefore: beforeReads[0].event,
    edit: edits[0].event,
    filesystemAfter: afterReads[0].event,
  };
  const order = [selected.shell, selected.filesystemBefore, selected.edit, selected.filesystemAfter].map(eventStartLine);
  if (order.some((line) => !Number.isFinite(line)) || order.some((line, index) => index > 0 && line <= order[index - 1])) {
    throw new Error("Codex engineering composite event order is invalid");
  }
  if (new Set(Object.values(selected).map((event) => event.eventId)).size !== 4) {
    throw new Error("Codex engineering composite events are not distinct");
  }
  return selected;
}

function assertCodexEngineeringToolsNotDeclined(rawText) {
  for (const line of String(rawText).split(/\r?\n/u)) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const item = record?.item;
    if (
      record?.type === "item.completed" && ["command_execution", "file_change"].includes(item?.type) &&
      (["declined", "failed", "cancelled"].includes(item?.status) || (Number.isInteger(item?.exit_code) && item.exit_code !== 0))
    ) throw new Error(`Codex engineering composite host tool was ${item.status ?? `exit_${item.exit_code}`}`);
  }
}

function engineeringPrompt(marker, nativeStream = false) {
  const readCommand = nativeStream && process.platform !== "win32" ? "cat" : "Get-Content";
  return `This is one bounded Meta_Kim Codex engineering capability probe. Work only in the current temporary workspace. Use exactly this sequence and do not combine steps:\n` +
    `1. Invoke the native shell tool once to create meta-kim-engineering-probe.txt containing exactly before-${marker} with no trailing newline.\n` +
    `2. Invoke the native shell tool once with a read-only ${readCommand} command to read that file and observe exactly before-${marker}.\n` +
    `3. Invoke the native apply_patch tool once to replace before-${marker} with after-${marker}. Do not edit through the shell.\n` +
    `4. Invoke the native shell tool once with a read-only ${readCommand} command to read the final file and observe exactly one line, after-${marker}, followed by one LF.\n` +
    `Then stop. Do not perform any other file, shell, or edit operation.`;
}

/**
 * Runs one Codex host invocation and emits three receipts over four ordered,
 * distinct host events. The shared raw artifact is accepted only through the
 * matching composite lifecycle schema.
 */
export function runCodexCompositeEngineeringProducer({
  projectRoot,
  profile,
  timeoutMs = 300_000,
  codexModel = null,
  codexReasoningEffort = null,
  executor = productionExecutor,
  source = "live_controlled",
  _acceptanceWriter = null,
  attemptBase = `${new Date().toISOString().replace(/[-:.]/gu, "")}-${randomUUID()}`,
} = {}) {
  if (source === "native_cli_stream" && executor === productionExecutor) executor = nativeCliStreamExecutor;
  const paths = prepareRuntimeCapabilityAcceptanceStore({ projectRoot, profile });
  const producerRoot = path.join(paths.profileRoot, "runtime-capability-producers");
  const workspace = createControlledProbeWorkspace({
    runtime: "codex",
    producerRoot,
    attemptId: `${attemptBase}-engineering`,
    label: "engineering",
  });
  const artifactsDir = path.join(producerRoot, "artifacts");
  const receiptsDir = path.join(producerRoot, "receipts");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(receiptsDir, { recursive: true });
  const nonce = randomUUID();
  const marker = `META_KIM_CAPABILITY_ENGINEERING_${nonce}`;
  const prompt = engineeringPrompt(marker, source === "native_cli_stream");
  const executableIdentity = productionExecutorSelected(executor)
    ? loadSetupBoundRuntimeExecutable({ projectRoot: paths.projectRoot, profile: paths.profile, runtime: "codex" })
    : testOnlyExecutableIdentity("codex");
  const command = commandFor("codex", workspace, "engineering_composite", executableIdentity, { codexModel, codexReasoningEffort });
  if (source === "native_cli_stream") command.args = nativeCliStreamInvocationArgs({ runtime: "codex", workspace, capability: "engineering_composite", argsPrefix: executableIdentity.argsPrefix ?? [], codexModel, codexReasoningEffort });
  const request = { source, runtime: "codex", capability: "engineering_composite", mode: "interactive_host", workspace, command: command.command, args: command.args, prompt, timeoutMs, executableIdentity };
  let completed = false;
  try {
    const result = executor(request);
    const { rawBytes, capture } = evidenceFromResult(result, request, marker);
    const rawPath = path.join(artifactsDir, `${attemptBase}-engineering.jsonl`);
    atomicExclusiveWrite(rawPath, rawBytes);
    if (!result || result.status !== 0) throw runtimeHostInvocationError("codex", "engineering composite host invocation", result);
    const rawText = rawBytes.toString("utf8");
    assertCodexEngineeringToolsNotDeclined(rawText);
    const selected = selectCodexEngineeringEvents(rawText, marker, workspace);
    const probeFile = path.join(workspace, "meta-kim-engineering-probe.txt");
    if (!existsSync(probeFile) || readFileSync(probeFile, "utf8") !== `after-${marker}\n`) {
      throw new Error("Codex engineering composite final workspace outcome mismatch");
    }
    const observedAt = new Date().toISOString();
    const lifecycleId = `${attemptBase}:${nonce}`;
    const eventBindings = {
      shell: [selected.shell.eventId],
      filesystem: [selected.filesystemBefore.eventId, selected.filesystemAfter.eventId],
      "apply_patch / edit": [selected.edit.eventId],
    };
    const lifecycle = {
      allowlisted: true,
      lifecycleId,
      facets: ["shell", "filesystem", "apply_patch / edit"],
      sourceCategory: "codex_single_host_invocation",
      markerDigest: sha256(marker),
      observedAt,
      eventBindings,
      orderedEventIds: [selected.shell.eventId, selected.filesystemBefore.eventId, selected.edit.eventId, selected.filesystemAfter.eventId],
      beforeContentSha256: sha256(`before-${marker}`),
      finalContentSha256: sha256(`after-${marker}\n`),
    };
    const requestRecord = { ...(source === "native_cli_stream" ? { source, workspace, timeoutMs } : {}), runtime: "codex", capability: "engineering_composite", mode: "interactive_host", command: path.basename(command.command), args: command.args, promptSha256: sha256(prompt) };
    const resultRecord = { status: result.status, signal: result.signal ?? null, stdoutSha256: capture?.rawStdoutSha256 ?? sha256(rawBytes), stderrSha256: sha256(String(result.stderr ?? "")) };
    const byId = new Map(Object.values(selected).map((event) => [event.eventId, event]));
    const results = [];
    for (const capability of lifecycle.facets) {
      const attemptId = `${attemptBase}-${capability.replace(/[^a-z0-9]+/giu, "-").replace(/^-|-$/gu, "")}`;
      const correlationId = randomUUID();
      const eventEvidence = eventBindings[capability].map((eventId) => {
        const event = byId.get(eventId);
        return {
          eventId: event.eventId,
          family: event.family,
          hostSurface: event.hostSurface,
          providerId: event.providerId,
          resultStatus: event.resultStatus,
          inputDigest: event.inputDigest,
          outputDigest: event.outputDigest,
          sessionId: event.sessionId ?? null,
          childSessionId: null,
          sourceLines: event.sourceLines ?? [],
          facet: capability,
        };
      });
      const receiptWithoutHash = {
        schemaVersion: PRODUCER_RECEIPT_SCHEMA_VERSION,
        attestationAuthority: "controlled_producer",
        producer: CODEX_ENGINEERING_COMPOSITE_PRODUCER,
        testOnly: !productionExecutorSelected(executor),
        runtime: "codex",
        runtimeVersion: String(result.runtimeVersion ?? "").trim(),
        capability,
        mode: "interactive_host",
        attemptId,
        correlationId,
        observedAt,
        outcome: "pass",
        hostInvocation: {
          runtimeIsolation: result.runtimeIsolation ?? (productionExecutorSelected(executor) ? "ephemeral_auth_home_and_rules_isolated" : "test_injected"),
          request: requestRecord,
          requestDigest: sha256(JSON.stringify(requestRecord)),
          result: resultRecord,
          resultDigest: sha256(JSON.stringify(resultRecord)),
          exitCode: result.status,
          signal: result.signal ?? null,
          ...(capture ? { executableIdentity: result.executableIdentity ?? executableIdentity } : {}),
        },
        capabilityNonce: nonce,
        capabilityMarker: marker,
        compositeLifecycle: { ...lifecycle, facet: capability },
        eventEvidence,
        ...(capture ? { streamCapture: capture, authObservation: result.authObservation } : {}),
        rawArtifact: { path: path.relative(paths.profileRoot, rawPath).replaceAll("\\", "/"), sha256: sha256(rawBytes) },
        workspaceOutcome: { kind: "bounded_file", contentSha256: lifecycle.finalContentSha256 },
        flags: { fixture: false, recoveredFromTimeout: false, blockedFromRelease: false },
        failureClass: null,
      };
      const receipt = { ...receiptWithoutHash, recordHash: sha256(JSON.stringify(receiptWithoutHash)) };
      const receiptPath = path.join(receiptsDir, `${attemptId}.json`);
      atomicExclusiveWrite(receiptPath, Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8"));
      const acceptance = acceptanceWriterFor(receipt.testOnly, _acceptanceWriter)({ projectRoot: paths.projectRoot, profile: paths.profile, receiptPath, runtime: "codex", capability, mode: "interactive_host", attemptId, correlationId });
      results.push({ capability, receipt, receiptPath, acceptance });
    }
    completed = true;
    return { rawPath, marker, results };
  } finally {
    cleanupWorkspaceBestEffort({ workspace, producerRoot, attemptId: `${attemptBase}-engineering`, completed });
  }
}

/**
 * Converts one genuine Codex Desktop spawn lifecycle into its two distinct
 * capability facets. Both receipts intentionally bind the same parent slice;
 * acceptance permits that reuse only for this exact agent/subagent pair.
 */
export async function runCodexDesktopSessionCapabilityProducer({
  projectRoot,
  profile,
  codexHome,
  threadId,
  childSessionId,
  marker,
  sinceMs,
  capabilities = ["agent", "subagent"],
  reader = readCodexDesktopSessionEvidence,
  _acceptanceWriter = null,
  attemptBase = `${new Date().toISOString().replace(/[-:.]/gu, "")}-${randomUUID()}`,
} = {}) {
  const selected = [...new Set(capabilities)];
  if (selected.length === 0 || selected.some((entry) => !["agent", "subagent"].includes(entry))) {
    throw new Error("Codex Desktop session producer supports only agent and subagent facets");
  }
  const canonicalCodexHome = path.join(os.homedir(), ".codex");
  if (reader === readCodexDesktopSessionEvidence && codexHome) {
    if (path.resolve(codexHome) !== path.resolve(canonicalCodexHome)) throw new Error("Codex Desktop producer can read only canonical ~/.codex");
  }
  const evidence = await reader({ codexHome: reader === readCodexDesktopSessionEvidence ? canonicalCodexHome : codexHome, threadId, childSessionId, marker, sinceMs });
  if (evidence.sourceCategory !== "codex_home_sessions") throw new Error("Codex Desktop session source category mismatch");
  const nonce = String(marker).match(/META_KIM_CAPABILITY_SUBAGENT_([0-9a-f-]{36})$/u)?.[1];
  if (!nonce) throw new Error("Codex Desktop session marker is invalid");
  const paths = prepareRuntimeCapabilityAcceptanceStore({ projectRoot, profile });
  const producerRoot = path.join(paths.profileRoot, "runtime-capability-producers");
  const artifactsDir = path.join(producerRoot, "artifacts");
  const receiptsDir = path.join(producerRoot, "receipts");
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(receiptsDir, { recursive: true });
  const rawPath = path.join(artifactsDir, `${attemptBase}-agent-subagent.jsonl`);
  const parentLineCount = evidence.parentSessionText.trimEnd().split(/\r?\n/u).length;
  const rawBytes = Buffer.from(`${evidence.parentSessionText}${evidence.childFragmentText}`, "utf8");
  atomicExclusiveWrite(rawPath, rawBytes);
  const observedAt = evidence.observedAt;
  const lifecycle = {
    allowlisted: true,
    lifecycleId: evidence.lifecycleId,
    facets: ["agent", "subagent"],
    sourceCategory: evidence.sourceCategory,
    threadId: evidence.threadId,
    childSessionId: evidence.childSessionId,
    eventId: evidence.eventId,
    markerDigest: evidence.markerDigest,
    observedAt: evidence.observedAt,
    parentSessionRef: evidence.parentSessionRef,
    childSessionRef: evidence.childSessionRef,
    parentSnapshotSize: evidence.parentSnapshotSize,
    childSnapshotSize: evidence.childSnapshotSize,
    parentFragmentDigest: evidence.parentFragmentDigest,
    childFragmentDigest: evidence.childFragmentDigest,
    parentSourceLines: evidence.parentSourceLines,
    childSourceLines: evidence.childSourceLines,
    childAgentPath: evidence.childAgentPath,
    parentAgentPath: evidence.parentAgentPath,
    rawCompositeDigest: sha256(rawBytes),
    facetBindings: {
      agent: { eventId: evidence.eventId, sourceLines: evidence.nativeInvocation.sourceLines.filter((line) => line !== Math.max(...evidence.nativeInvocation.sourceLines)).sort((a, b) => a - b) },
      subagent: { eventId: `${evidence.childSessionId}:task_complete`, sourceLines: [parentLineCount + 2, parentLineCount + 3] },
    },
  };
  const results = [];
  for (const capability of selected) {
    const attemptId = `${attemptBase}-${capability}`;
    const correlationId = randomUUID();
    const request = {
      runtime: "codex",
      capability,
      mode: "interactive_host",
      sourceCategory: evidence.sourceCategory,
      threadId: evidence.threadId,
      childSessionId: evidence.childSessionId,
      lifecycleId: evidence.lifecycleId,
    };
    const result = {
      status: 0,
      signal: null,
      stdoutSha256: sha256(rawBytes),
      stderrSha256: sha256(""),
    };
    const receiptWithoutHash = {
      schemaVersion: PRODUCER_RECEIPT_SCHEMA_VERSION,
      attestationAuthority: "controlled_producer",
      producer: CODEX_DESKTOP_COMPOSITE_PRODUCER,
      testOnly: reader !== readCodexDesktopSessionEvidence,
      runtime: "codex",
      runtimeVersion: String(evidence.cliVersion ?? "").trim(),
      capability,
      mode: "interactive_host",
      attemptId,
      correlationId,
      observedAt,
      outcome: "pass",
      hostInvocation: {
        runtimeIsolation: "codex_desktop_current_session",
        request,
        requestDigest: sha256(JSON.stringify(request)),
        result,
        resultDigest: sha256(JSON.stringify(result)),
        exitCode: 0,
        signal: null,
      },
      capabilityNonce: nonce,
      capabilityMarker: marker,
      compositeLifecycle: { ...lifecycle, facet: capability },
      eventEvidence: [capability === "agent" ? {
        eventId: lifecycle.facetBindings.agent.eventId,
        family: "agent_subagent",
        hostSurface: "collaboration.spawn_agent",
        providerId: "collaboration.spawn_agent",
        resultStatus: "accepted",
        inputDigest: evidence.nativeInvocation.inputDigest,
        outputDigest: sha256(lifecycle.facetBindings.agent.sourceLines.map((line) => rawBytes.toString("utf8").split(/\r?\n/u)[line - 1] ?? "").join("\n")),
        sessionId: evidence.threadId,
        childSessionId: evidence.childSessionId,
        sourceLines: lifecycle.facetBindings.agent.sourceLines,
        completionBoundary: "parent_spawn_accepted_and_started",
        facet: "agent",
      } : {
        eventId: lifecycle.facetBindings.subagent.eventId,
        family: "agent_subagent",
        hostSurface: "codex.child.task_complete",
        providerId: "codex.child.task_complete",
        resultStatus: "completed",
        inputDigest: evidence.markerDigest,
        outputDigest: evidence.childFragmentDigest,
        sessionId: evidence.childSessionId,
        childSessionId: evidence.childSessionId,
        sourceLines: lifecycle.facetBindings.subagent.sourceLines,
        completionBoundary: "child_final_and_task_complete",
        facet: "subagent",
      }],
      rawArtifact: {
        path: path.relative(paths.profileRoot, rawPath).replaceAll("\\", "/"),
        sha256: sha256(rawBytes),
      },
      workspaceOutcome: { kind: "host_event_only", contentSha256: null },
      flags: { fixture: false, recoveredFromTimeout: false, blockedFromRelease: false },
      failureClass: null,
    };
    const receipt = { ...receiptWithoutHash, recordHash: sha256(JSON.stringify(receiptWithoutHash)) };
    const receiptPath = path.join(receiptsDir, `${attemptId}.json`);
    atomicExclusiveWrite(receiptPath, Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8"));
    const acceptance = acceptanceWriterFor(receipt.testOnly, _acceptanceWriter)({
      projectRoot: paths.projectRoot,
      profile: paths.profile,
      receiptPath,
      runtime: "codex",
      capability,
      mode: "interactive_host",
      attemptId,
      correlationId,
    });
    results.push({ capability, receipt, receiptPath, acceptance });
  }
  return { rawPath, evidence, results };
}

export function runControlledRuntimeCapabilityProducer({
  projectRoot,
  profile,
  runtime,
  capability,
  mode = "interactive_host",
  timeoutMs = 300_000,
  codexModel = null,
  codexReasoningEffort = null,
  claudeMaxTurns,
  claudeMaxBudgetUsd,
  executor = productionExecutor,
  source = "live_controlled",
  _acceptanceWriter = null,
  preserveWorkspace = false,
  attemptId = `${new Date().toISOString().replace(/[-:.]/gu, "")}-${randomUUID()}`,
  correlationId = randomUUID(),
} = {}) {
  if (source === "native_cli_stream" && executor === productionExecutor) executor = nativeCliStreamExecutor;
  if (!SUPPORTED_RUNTIMES.has(runtime)) throw new Error("controlled producers support only claude_code and codex");
  if (mode !== "interactive_host") throw new Error("controlled producers currently support only interactive_host");
  validateControlledProbeOptions({ source, runtime, claudeMaxTurns, claudeMaxBudgetUsd, timeoutMs });
  const producer = PRODUCERS[capability];
  if (!producer) throw new Error(`no controlled producer exists for capability ${capability}`);
  const paths = prepareRuntimeCapabilityAcceptanceStore({ projectRoot, profile });
  const producerRoot = path.join(paths.profileRoot, "runtime-capability-producers");
  const workspace = createControlledProbeWorkspace({ runtime, producerRoot, attemptId, label: capability.replace(/[^a-z0-9]+/giu, "-").toLowerCase() });
  const artifactsDir = path.join(producerRoot, "artifacts");
  const receiptsDir = path.join(producerRoot, "receipts");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(receiptsDir, { recursive: true });
  const nonce = randomUUID();
  const marker = `META_KIM_CAPABILITY_${capability.replace(/[^a-z0-9]+/giu, "_").toUpperCase()}_${nonce}`;
  if (capability === "filesystem") writeFileSync(path.join(workspace, "meta-kim-probe.txt"), `${marker}\n`, "utf8");
  if (capability === "apply_patch / edit") writeFileSync(path.join(workspace, "meta-kim-probe.txt"), `before-${marker}\n`, "utf8");
  if (runtime === "claude_code") writeFileSync(path.join(workspace, "meta-kim-empty-mcp.json"), '{"mcpServers":{}}\n', "utf8");
  const executableIdentity = productionExecutorSelected(executor)
    ? loadSetupBoundRuntimeExecutable({ projectRoot: paths.projectRoot, profile: paths.profile, runtime })
    : testOnlyExecutableIdentity(runtime);
  const command = commandFor(runtime, workspace, capability, executableIdentity, { codexModel, codexReasoningEffort, claudeMaxTurns, claudeMaxBudgetUsd });
  if (source === "native_cli_stream") command.args = nativeCliStreamInvocationArgs({ runtime, workspace, capability, argsPrefix: executableIdentity.argsPrefix ?? [], codexModel, codexReasoningEffort, claudeMaxTurns, marker });
  let prompt = promptFor(capability, runtime, nonce, marker);
  if (source === "native_cli_stream" && runtime === "claude_code" && ["agent", "subagent"].includes(capability)) {
    prompt += " Use only the built-in general-purpose child in the foreground. Do not set a model, permission mode, agent name, or custom role. Do not request background execution. The child must use no tools and return only the marker.";
  }
  if (source === "native_cli_stream" && runtime === "claude_code" && capability === "shell") {
    const fixedCommand = process.platform === "win32"
      ? `Set-Content -LiteralPath meta-kim-probe.txt -Value 'shell-${marker}' -NoNewline -Encoding ascii`
      : `printf '%s' 'shell-${marker}' > meta-kim-probe.txt`;
    prompt += ` Run exactly this single command without adding arguments or other operations: ${fixedCommand}`;
  }
  const request = { source, runtime, capability, mode, workspace, command: command.command, args: command.args, prompt, timeoutMs, executableIdentity, claudeMaxTurns, claudeMaxBudgetUsd };
  let result;
  let completed = false;
  try {
    result = executor(request);
    const rawPath = path.join(artifactsDir, `${attemptId}.jsonl`);
    const { rawBytes, capture } = evidenceFromResult(result, request, marker);
    atomicExclusiveWrite(rawPath, rawBytes);
    if (!result || result.status !== 0) throw runtimeHostInvocationError(runtime, `${producer.id} host invocation`, result);
    const rawText = rawBytes.toString("utf8");
    const events = command.observer(rawText);
    assertExactMarkerEventLifecycles(rawText, marker);
    const matched = events.filter((event) => eventMatches(runtime, capability, event, rawText, marker) && ["completed", "returned"].includes(event.resultStatus));
    if (matched.length === 0) throw new Error(`${producer.id} did not observe a capability-specific completed host event`);
    assertWorkspaceOutcome(workspace, capability, marker);
    if (source === "native_cli_stream" && !["agent", "subagent"].includes(capability)) {
      const expectedBytes = capability === "shell" ? `shell-${marker}` : capability === "filesystem" ? `${marker}\n` : `after-${marker}\n`;
      if (readFileSync(path.join(workspace, "meta-kim-probe.txt"), "utf8") !== expectedBytes) {
        throw new Error("native CLI probe file bytes do not match the exact bounded outcome");
      }
    }
    const observedAt = new Date().toISOString();
    const receiptWithoutHash = {
      schemaVersion: PRODUCER_RECEIPT_SCHEMA_VERSION,
      attestationAuthority: "controlled_producer",
      producer,
      testOnly: !productionExecutorSelected(executor),
      runtime,
      runtimeVersion: String(result.runtimeVersion ?? "").trim(),
      capability,
      mode,
      attemptId,
      correlationId,
      observedAt,
      outcome: "pass",
      hostInvocation: {
        runtimeIsolation: result.runtimeIsolation ?? (productionExecutorSelected(executor) ? "runtime_native_isolation" : "test_injected"),
        request: { ...(source === "native_cli_stream" ? { source, workspace } : {}), runtime, capability, mode, command: path.basename(command.command), args: command.args, promptSha256: sha256(prompt), timeoutMs },
        requestDigest: sha256(JSON.stringify({ ...(source === "native_cli_stream" ? { source, workspace } : {}), runtime, capability, mode, command: path.basename(command.command), args: command.args, promptSha256: sha256(prompt), timeoutMs })),
        result: { status: result.status, signal: result.signal ?? null, stdoutSha256: capture?.rawStdoutSha256 ?? sha256(rawBytes), stderrSha256: sha256(String(result.stderr ?? "")) },
        resultDigest: sha256(JSON.stringify({ status: result.status, signal: result.signal ?? null, stdoutSha256: capture?.rawStdoutSha256 ?? sha256(rawBytes), stderrSha256: sha256(String(result.stderr ?? "")) })),
        exitCode: result.status,
        signal: result.signal ?? null,
        executableIdentity: result.executableIdentity ?? executableIdentity,
      },
      capabilityNonce: nonce,
      capabilityMarker: marker,
      eventEvidence: matched.map((event) => ({
        eventId: event.eventId,
        family: event.family,
        hostSurface: event.hostSurface,
        providerId: event.providerId,
        resultStatus: event.resultStatus,
        inputDigest: event.inputDigest,
        outputDigest: event.outputDigest,
        sessionId: event.sessionId ?? null,
        childSessionId: event.childSessionId ?? null,
        resultTextSha256: event.resultTextSha256 ?? null,
        resultSourceLines: event.resultSourceLines ?? [],
        lifecycleEvidence: event.lifecycleEvidence ?? null,
        completionBoundary: event.completionBoundary ?? null,
        activityCompletionObserved: event.activityCompletionObserved === true,
        sourceLines: event.sourceLines ?? [],
      })),
      ...(capture ? { streamCapture: capture, authObservation: result.authObservation } : {}),
      rawArtifact: {
        path: path.relative(paths.profileRoot, rawPath).replaceAll("\\", "/"),
        sha256: sha256(rawBytes),
      },
      workspaceOutcome: ["agent", "subagent"].includes(capability)
        ? { kind: "host_event_only", contentSha256: null }
        : { kind: "bounded_file", contentSha256: sha256(readFileSync(path.join(workspace, "meta-kim-probe.txt"))) },
      flags: { fixture: false, recoveredFromTimeout: false, blockedFromRelease: false },
      failureClass: null,
    };
    const receipt = { ...receiptWithoutHash, recordHash: sha256(JSON.stringify(receiptWithoutHash)) };
    const receiptPath = path.join(receiptsDir, `${attemptId}.json`);
    atomicExclusiveWrite(receiptPath, Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8"));
    const acceptance = acceptanceWriterFor(receipt.testOnly, _acceptanceWriter)({
      projectRoot: paths.projectRoot,
      profile: paths.profile,
      receiptPath,
      runtime,
      capability,
      mode,
      attemptId,
      correlationId,
    });
    completed = true;
    return { receipt, receiptPath, rawPath, acceptance };
  } finally {
    if (!preserveWorkspace) cleanupWorkspaceBestEffort({ workspace, producerRoot, attemptId, completed });
  }
}

export async function produceRuntimeCapabilityWithAcceptanceWriter(options, acceptanceWriter) {
  if (typeof acceptanceWriter !== "function") throw new Error("internal controlled acceptance writer is required");
  const probeOptions = validateControlledProbeOptions(options);
  const common = {
    projectRoot: options.projectRoot,
    profile: options.profile,
    source: options.source,
    _acceptanceWriter: acceptanceWriter,
    codexModel: options.codexModel,
    codexReasoningEffort: options.codexReasoningEffort,
    ...probeOptions,
  };
  if (options.source === "codex_desktop_agent_subagent") {
    if (options.runtime !== "codex") throw new Error("Codex Desktop agent source supports only codex");
    return runCodexDesktopSessionCapabilityProducer({
      ...common,
      threadId: options.threadId,
      childSessionId: options.childSessionId,
      marker: options.marker,
      sinceMs: options.sinceMs,
      capabilities: options.capabilities,
    });
  }
  if (options.source === "codex_desktop_engineering") {
    if (options.runtime !== "codex") throw new Error("Codex Desktop engineering source supports only codex");
    return runCodexDesktopEngineeringSessionProducer({
      ...common,
      threadId: options.threadId,
      marker: options.marker,
      sinceMs: options.sinceMs,
      workspacePath: options.workspacePath,
    });
  }
  if (options.source === "native_cli_stream") {
    const requested = options.capabilities ?? [];
    if (!Array.isArray(requested) || requested.length === 0 || new Set(requested).size !== requested.length ||
        requested.some((capability) => !Object.hasOwn(PRODUCERS, capability))) throw new Error("native CLI capabilities must be a nonempty unique supported set");
    const results = [];
    // Native file-change JSON binds paths, not contents. Keep the existing
    // ordered write/read/edit/read composite to prove all three engineering facets.
    const engineering = requested.filter((capability) => CODEX_ENGINEERING_FACETS.includes(capability));
    if (options.runtime === "codex" && engineering.length && engineering.length !== 3) {
      throw new Error("native Codex engineering proof requires shell,filesystem,apply_patch / edit together");
    }
    for (const capability of requested.filter((capability) => options.runtime !== "codex" || !CODEX_ENGINEERING_FACETS.includes(capability))) {
      results.push(runControlledRuntimeCapabilityProducer({ ...common, runtime: options.runtime, capability }));
    }
    if (options.runtime === "codex" && engineering.length) {
      results.push(...runCodexCompositeEngineeringProducer({ ...common, timeoutMs: options.timeoutMs }).results);
    }
    return { results };
  }
  if (options.source === "live_controlled") {
    if (selectLiveControlledProducerRoute(options) === "codex_engineering_composite") {
      const produced = runCodexCompositeEngineeringProducer({
        ...common,
        timeoutMs: options.timeoutMs,
      });
      return { results: produced.results };
    }
    const results = [];
    for (const capability of options.capabilities ?? []) {
      results.push(runControlledRuntimeCapabilityProducer({ ...common, runtime: options.runtime, capability }));
    }
    return { results };
  }
  throw new Error("unsupported controlled production source");
}
