#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCodexHooksJson, buildCursorHooksJson } from "./runtime-hook-mapping.mjs";
import { buildCodexProjectHooksJson, buildCursorProjectHooksJson } from "./sync-runtimes.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (relative) => JSON.parse(await readFile(path.join(repoRoot, relative), "utf8"));
const readText = async (relative) => readFile(path.join(repoRoot, relative), "utf8");
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const [contract, providers, skills, packageJson, source, claudeSettings] = await Promise.all([
  readJson("config/contracts/planning-continuity-contract.json"),
  readJson("config/capability-index/provider-registry.json"),
  readJson("config/skills.json"),
  readJson("package.json"),
  readText("canonical/runtime-assets/shared/hooks/planning-continuity.mjs"),
  readJson("canonical/runtime-assets/claude/settings.json"),
]);

assert(contract.id === "meta-kim-planning-continuity", "planning continuity contract id mismatch");
assert(contract.owner === "meta-conductor", "planning continuity must have one conductor owner");
assert(contract.initialization?.overwriteExisting === false, "existing files must be preserved");
assert(contract.recovery?.requiresCurrentAttestation === true, "recovery must require attestation");
assert(contract.recovery?.neverAutoInjectedFiles?.includes("findings.md"), "findings must not be injected");
assert(contract.completionGate?.maxBlockingAttempts === 2, "stop gate must be bounded");
assert(contract.runtimeSupport?.cursor?.claimUntilVerified === "blocked", "Cursor must stay blocked");
assert(contract.runtimeSupport?.openclaw?.claimUntilVerified === "blocked", "OpenClaw must stay blocked");
assert(contract.absenceAcceptance?.networkFallbackAbsent === true, "absence gate must reject network fallback");
assert(contract.dependencyPolicy?.deletionRequiresUserAuthorization === true, "deletion requires user authority");

for (const token of [
  "initializePlanningContinuity", "attestPlanningContinuity", "resumePlanningContinuity",
  "inspectPlanningContinuity", "checkpointPlanningContinuity", "claimPlanningCompletion",
  "evaluateStopGate", "withFileLock", "atomicWriteJson", "planning_runtime_adapter_unavailable",
]) assert(source.includes(token), `planning source missing ${token}`);
assert(!/OthmanAdi|planning-with-files/iu.test(source), "first-party runtime names external source");
assert(!/node:(?:http|https|child_process)|\bfetch\s*\(/u.test(source), "planning runtime has network/process fallback");

const provider = providers.providers?.find((item) => item.id === "hook-meta-kim-planning-continuity");
assert(provider?.sourceOfTruth === "canonical/runtime-assets/shared/hooks/planning-continuity.mjs", "provider authority mismatch");
for (const runtime of ["cursor", "openclaw"]) {
  assert(provider.runtimeAdapters?.[runtime]?.status === "blocked", `${runtime} must be blocked`);
  assert(provider.runtimeAdapters?.[runtime]?.activationEvent == null, `${runtime} must not claim activation`);
}
for (const runtime of ["claude_code", "codex"]) {
  assert(provider.runtimeAdapters?.[runtime]?.status === "partial", `${runtime} support must remain partial`);
  assert(provider.degradation?.statusByRuntime?.[runtime] === "needs_probe", `${runtime} degradation truth mismatch`);
}
assert(!provider.mappings.runtimeTargets.includes("cursor"), "Cursor entered provider runtime targets");
assert(!provider.activationEvents.some((event) => /^[a-z]/u.test(event)), "Cursor lifecycle events remain claimed");

assert(
  !skills.skills?.some((skill) => skill.id === "planning-with-files"),
  "retired external planning dependency remains installable",
);

const claudeText = JSON.stringify(claudeSettings);
for (const event of ["user-prompt", "session-start", "post-tool", "pre-compact", "stop"]) {
  assert(claudeText.includes(`--event ${event} --runtime claude`), `Claude mapping missing ${event}`);
}

for (const config of [buildCodexHooksJson(), buildCodexProjectHooksJson()]) {
  const text = JSON.stringify(config);
  for (const event of ["user-prompt", "session-start", "post-tool", "pre-compact", "stop"]) {
    assert(text.includes(`--event ${event} --runtime codex`), `Codex mapping missing ${event}`);
  }
  assert(config.hooks.PostToolUse?.some((entry) => JSON.stringify(entry).includes("planning-continuity.mjs")), "Codex PostToolUse missing");
}

for (const config of [buildCursorHooksJson(), buildCursorProjectHooksJson()]) {
  assert(!JSON.stringify(config).includes("planning-continuity.mjs"), "Cursor falsely wires planning continuity");
}
assert(buildCursorProjectHooksJson().hooks.postToolUse.every((entry) => entry.command && entry.matcher && !entry.hooks), "Cursor postToolUse shape is invalid");
assert(packageJson.scripts?.["meta:planning:validate"], "package script missing");

console.log("planning continuity valid");
