/** Read-only HookPrompt diagnostics. No hook or preference code is executed. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { collectHookRegistrations } from "./hook-registration-diagnostics.mjs";
import { buildHookPromptAdapterSource } from "./runtime-hook-mapping.mjs";
import { getHookPromptDiagnosticsCopy } from "./meta-kim-i18n.mjs";

const normalize = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const validMode = (value) => ["full", "summary"].includes(value);

// Complete, reviewed installed HookPrompt component snapshots. These identify
// supported static display contracts, not provenance or successful execution.
// The portable test snapshots and their audit notes live in
// tests/fixtures/hookprompt-supported/. No synthetic fixture hash is accepted.
// Normalize physical CRLF/LF only; any other source change stays unknown until
// the complete implementation and entrypoint are reviewed again.
const sourceFingerprint = (text) => sha(text.replace(/\r\n/gu, "\n"));
const SUPPORTED_INNER = "7d7161b4e4c9cf7efbd6db8e7e99b5e03468bfceec91bc4b4fbe77aa8b63a361";
const SUPPORTED_SHIMS = new Map([
  ["4e6258bf5eb4fd031c5f3ce1da22516e82bd1ea17ca679dbf23e0018646ce021", "user-prompt-submit.cjs"],
  ["b6e81f42f26c5cc9ed4aec33dee660434579b2b6da09cf5c6b852df73ea3d4f3", "../../.claude/hooks/user-prompt-submit.cjs"],
]);

function safeRead(file, maximum = 256 * 1024) {
  let descriptor;
  try {
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || normalize(realpathSync(file)) !== normalize(file)) return { status: "linked_or_nonfile" };
    if (before.size > maximum) return { status: "oversized" };
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink > 1 || opened.ino !== before.ino || opened.dev !== before.dev || opened.size > maximum) return { status: "changed_or_oversized" };
    const buffer = Buffer.alloc(maximum + 1);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (length > maximum) return { status: "oversized" };
    const bytes = buffer.subarray(0, length);
    return { status: "read", text: bytes.toString("utf8"), sha256: sha(bytes) };
  } catch (error) { return { status: error.code === "ENOENT" ? "missing" : "unreadable" }; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function safeJson(file, maximum) {
  const read = safeRead(file, maximum);
  if (read.status !== "read") return read;
  try { return { status: "read", value: JSON.parse(read.text) }; }
  catch { return { status: "malformed" }; }
}

function sourceCandidates(entry, environment) {
  const hookDir = path.dirname(entry);
  return [path.join(hookDir, "user-prompt-submit.js"), path.join(hookDir, "hookprompt/user-prompt-submit.js"),
    path.join(hookDir, "../skills/hookprompt/.codex/hooks/user-prompt-submit.js"),
    path.join(hookDir, "../skills/hookprompt/.claude/hooks/user-prompt-submit.js"),
    path.join(environment.HOME || environment.USERPROFILE || "", ".claude/hooks/user-prompt-submit.js")];
}

function inspectInner(file, source) {
  let implementationFile = file, implementation = source;
  const relativeImplementation = source.status === "read" ? SUPPORTED_SHIMS.get(sourceFingerprint(source.text)) : null;
  if (relativeImplementation) {
    implementationFile = path.resolve(path.dirname(file), relativeImplementation);
    implementation = safeRead(implementationFile);
  }
  const modeBranch = implementation.status === "read" && sourceFingerprint(implementation.text) === SUPPORTED_INNER;
  return { implementationFile, implementationStatus: implementation.status, implementationSha256: implementation.sha256 || null,
    innerDefault: modeBranch ? "summary" : "unknown", modeBranchRecognized: Boolean(modeBranch) };
}

function inspectRegistration(row, runtime, settingsPath, baseDirectory, environment) {
  if (!row.script) return { sourceStatus: "unknown_command", sourceFile: null, effectiveMode: "unknown", sourceOrigin: "unknown", sourceVersion: "unknown" };
  const entryScript = path.resolve(baseDirectory, row.script);
  const entry = safeRead(entryScript);
  const adapter = path.basename(entryScript) === "hookprompt-adapter.mjs";
  const adapterRecognized = adapter && entry.status === "read" && entry.text.replace(/\r\n/gu, "\n") === buildHookPromptAdapterSource(runtime);
  let sourceFile = entryScript, source = entry;
  if (adapter) {
    sourceFile = null;
    source = { status: adapterRecognized ? "missing" : "unrecognized_adapter" };
    if (adapterRecognized) for (const candidate of sourceCandidates(entryScript, environment)) {
      const inspected = safeRead(candidate);
      // Match the adapter's first existing candidate; a rejected/linked first
      // file must not be silently replaced by a later healthy source.
      if (inspected.status !== "missing") { sourceFile = candidate; source = inspected; break; }
    }
  }
  const inner = sourceFile ? inspectInner(sourceFile, source) : { innerDefault: "unknown", modeBranchRecognized: false };
  const preferencePath = adapter ? path.join(path.dirname(entryScript), "hookprompt-display.json") : null;
  const preference = adapterRecognized ? safeJson(preferencePath, 4096) : { status: "not_applicable" };
  const preferenceStatus = preference.status === "read" && !validMode(preference.value?.mode) ? "invalid_mode" : preference.status;
  const envMode = validMode(environment.HOOKPROMPT_DISPLAY_MODE) ? environment.HOOKPROMPT_DISPLAY_MODE : null;
  const adjacentMode = preferenceStatus === "read" ? preference.value.mode : null;
  const requestedMode = envMode || adjacentMode;
  const modeSource = envMode ? "environment" : adjacentMode ? "adjacent_preference" : "inner_default";
  const effectiveMode = source.status === "read" && inner.modeBranchRecognized && (!adapter || adapterRecognized)
    ? requestedMode || inner.innerDefault : "unknown";
  return { event: row.event, settingsPath, entryScript, entryStatus: entry.status, entrySha256: entry.sha256 || null,
    adapterRecognized, sourceFile, sourceStatus: source.status, sourceSha256: source.sha256 || null,
    // A dependency registry entry is not evidence for the installed bytes.
    sourceOrigin: "unknown", sourceVersion: "unknown", ...inner, effectiveMode, requestedMode, modeSource,
    preferencePath, preferenceStatus, modeEvidence: inner.modeBranchRecognized ? "reviewed_source_fingerprint" : "unproven_inner_behavior" };
}

export function collectHookPromptDiagnostics({ projectRoot = process.cwd(), scope = "both", environment = process.env, homes = {} } = {}) {
  const runtimes = [];
  for (const runtime of ["claude", "codex", "cursor", "openclaw"]) {
    const runtimeHome = homes[runtime] || environment[`META_KIM_${runtime.toUpperCase()}_HOME`] || environment[`${runtime.toUpperCase()}_HOME`] || path.join(os.homedir(), "." + runtime);
    for (const targetScope of scope === "both" ? ["global", "project"] : [scope]) {
      const base = targetScope === "global" ? runtimeHome : path.join(projectRoot, "." + runtime);
      const settingsPath = path.join(base, runtime === "claude" ? "settings.json" : runtime === "openclaw" ? "openclaw.json" : "hooks.json");
      const settings = safeJson(settingsPath, 1024 * 1024);
      if (runtime === "openclaw") {
        runtimes.push({ runtime, scope: targetScope, settingsPath, settingsStatus: settings.status, state: "declarative_only", hooks: [] });
        continue;
      }
      const promptEvent = runtime === "cursor" ? "beforeSubmitPrompt" : "UserPromptSubmit";
      const registrations = collectHookRegistrations(settings.value?.hooks).filter((row) => row.event === promptEvent && /(?:hookprompt-adapter\.mjs|user-prompt-submit\.(?:js|cjs))/iu.test(row.command));
      const hooks = registrations.map((row) => inspectRegistration(row, runtime, settingsPath, targetScope === "project" ? projectRoot : runtimeHome, environment));
      runtimes.push({ runtime, scope: targetScope, settingsPath, settingsStatus: settings.status,
        state: hooks.length > 1 ? "multiple" : hooks.length ? "registered" : settings.status === "read" ? "missing" : "unknown", hooks });
    }
  }
  return { schemaVersion: 1, readOnly: true, environmentScope: "current_process_not_running_host", precedence: ["HOOKPROMPT_DISPLAY_MODE", "adjacent hookprompt-display.json", "inner default"], runtimes };
}

export function renderHookPromptDiagnostics(report, language = "zh-CN") {
  const copy = getHookPromptDiagnosticsCopy(language);
  const lines = [copy.title, `  ${copy.precedence}`];
  for (const runtime of report?.runtimes || []) {
    const label = `${runtime.runtime}/${runtime.scope}`;
    if (!runtime.hooks.length) {
      lines.push(`  ${label}: ${copy.noEntry} (${runtime.state}; ${runtime.settingsStatus})`);
      continue;
    }
    if (runtime.hooks.length > 1) lines.push(`  ${label}: ${copy.multipleEntries}`);
    for (const hook of runtime.hooks) {
      const modeSource = copy.modeSource(hook.modeSource);
      lines.push(`  ${label}: ${copy.display}=${hook.effectiveMode} (${modeSource}${hook.requestedMode ? `; ${copy.requested}=${hook.requestedMode}` : ""})`);
      lines.push(`    ${copy.source}: ${hook.sourceFile || "unknown"} [${hook.sourceStatus}]`);
      if (hook.implementationFile && hook.implementationFile !== hook.sourceFile) lines.push(`    ${copy.implementation}: ${hook.implementationFile}`);
      lines.push(`    ${copy.provenance}: ${hook.sourceOrigin} / ${hook.sourceVersion}; SHA256=${hook.implementationSha256 || hook.sourceSha256 || "unknown"}`);
      if (hook.preferencePath) lines.push(`    ${copy.preference}: ${hook.preferencePath} [${hook.preferenceStatus}]`);
    }
  }
  return lines.join("\n");
}
