/** Translate documented native hook protocols to the existing governance core. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GEMINI_EVENTS = Object.freeze({ SessionStart: "SessionStart", BeforeAgent: "UserPromptSubmit", BeforeTool: "PreToolUse", AfterTool: "PostToolUse", AfterAgent: "Stop" });
const ZCODE_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]);
const GEMINI_TOOLS = Object.freeze({ read_file: "Read", read_many_files: "Read", list_directory: "Glob", glob: "Glob", grep_search: "Grep", run_shell_command: "Bash", write_file: "Write", replace: "Edit", activate_skill: "Skill", google_web_search: "WebSearch", web_fetch: "WebFetch" });

export function normalizeNativeHookPayload(runtime, event, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Hook payload must be an object");
  const canonicalEvent = runtime === "gemini" ? GEMINI_EVENTS[event] : runtime === "zcode" && ZCODE_EVENTS.has(event) ? event : null;
  if (!canonicalEvent) throw new Error(`Unsupported native hook ${runtime}:${event}`);
  const input = structuredClone(payload.tool_input ?? payload.toolInput ?? {});
  if (runtime === "gemini" && typeof input.file_path !== "string" && typeof input.path === "string") input.file_path = input.path;
  const nativeName = payload.tool_name ?? payload.toolName ?? "";
  const name = runtime === "gemini" ? GEMINI_TOOLS[nativeName] ?? nativeName : nativeName;
  // A host-provided agent identity is only a routing hint. Neither this adapter
  // nor a transient transcript grants durable completion or live acceptance.
  return { ...payload, runtime, hook_event_name: canonicalEvent, tool_name: name, tool_input: input };
}

export function translateNativeHookOutput(runtime, event, output = {}) {
  const specific = output.hookSpecificOutput ?? {};
  const reason = specific.permissionDecisionReason ?? output.reason ?? output.stopReason;
  const denied = specific.permissionDecision === "deny" || output.decision === "block" || output.decision === "deny";
  const additionalContext = specific.additionalContext ?? output.additionalContext ?? output.systemMessage;
  if (runtime === "gemini") {
    return {
      ...(denied && event !== "SessionStart" ? { decision: "deny", reason: reason || "Meta_Kim governance requires review." } : {}),
      ...(additionalContext ? { hookSpecificOutput: { additionalContext } } : {}),
    };
  }
  if (runtime !== "zcode") throw new Error(`Unsupported native runtime ${runtime}`);
  if (denied && event === "PreToolUse") {
    return { hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: reason || "Meta_Kim governance requires review.", ...(additionalContext ? { additionalContext } : {}) } };
  }
  return {
    ...(denied && event === "Stop" ? { decision: "block", reason: reason || "Meta_Kim verification is incomplete." } : {}),
    ...(denied && event === "UserPromptSubmit" ? { continue: false, reason: reason || "Meta_Kim needs a material decision." } : {}),
    ...(additionalContext ? { hookSpecificOutput: { hookEventName: event, additionalContext } } : {}),
  };
}

function argumentValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

export function runNativeHook(argv = process.argv.slice(2), raw = readFileSync(0, "utf8")) {
  const runtime = argumentValue(argv, "--runtime");
  const event = argumentValue(argv, "--event");
  const packageRoot = argumentValue(argv, "--package-root");
  if (!packageRoot || !path.isAbsolute(packageRoot)) throw new Error("A durable absolute package root is required");
  const payload = normalizeNativeHookPayload(runtime, event, raw.trim() ? JSON.parse(raw) : {});
  if (payload.hook_event_name === "SessionStart") {
    return translateNativeHookOutput(runtime, event, { additionalContext:
      `Meta_Kim is available through the meta-theory skill. Use references/runtime-${runtime}.md for native tools and paths. Continue the existing governed task through its pending host handoff; do not invent prior decisions, worker completion or live verification. Package: ${packageRoot}` });
  }
  const script = payload.hook_event_name === "PreToolUse"
    ? path.join(packageRoot, "canonical", "runtime-assets", "claude", "hooks", "enforce-agent-dispatch.mjs")
    : path.join(packageRoot, "canonical", "runtime-assets", "shared", "hooks", "activate-meta-theory-spine.mjs");
  const result = spawnSync(process.execPath, [script, "--runtime", runtime, "--package-root", packageRoot], {
    cwd: typeof payload.cwd === "string" ? payload.cwd : process.cwd(),
    input: JSON.stringify(payload), encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024,
    env: { ...process.env, META_KIM_HOOK_RUNTIME: runtime },
    windowsHide: true,
  });
  if (result.error || (result.status !== 0 && result.status !== 2)) {
    throw new Error(`Governance hook failed (${result.error?.code ?? result.status ?? "unknown"}); no acceptance claim recorded`);
  }
  let output = {};
  if (result.stdout?.trim()) output = JSON.parse(result.stdout);
  if (result.status === 2 && !Object.keys(output).length) output = { decision: "deny", reason: result.stderr?.trim() || "Governance hook denied this action." };
  return translateNativeHookOutput(runtime, event, output);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(runNativeHook())}\n`); }
  catch (error) { process.stderr.write(`[Meta_Kim native adapter] ${error.message}\n`); process.exitCode = 1; }
}
