import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyMetaTheoryEntry } from "../../scripts/meta-theory-entry-classifier.mjs";
import { copyHookClosure } from "../helpers/hook-fixture.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const queryCases = [
  "What does it mean to fix code?",
  "What does updating a config file mean?",
  "What does it mean to write a test?",
  "What does it mean to publish a release?",
  "What does it mean to delete production data?",
  "What does it mean to update a project?",
  "What does it mean to create parallel agents?",
  "What does it mean to fix code？",
  "What happens if one deletes production data?",
  "Do not delete production data",
  "不要删除生产数据文件",
];
const executionCases = [
  "What does it mean to fix code? Then please update the config file.",
  "What does it mean to fix code and please update the config file?",
  "What does it mean to fix code and could you update the config file?",
  "What does it mean to fix code？请修改 README 文件",
  "What does it mean to fix code，帮我修改 README 文件",
  "What does it mean to fix code 然后帮我修改 README 文件",
  "删除是什么意思？帮我删除生产数据文件",
  "What does it mean to delete data? Please delete the production database file.",
  "Could you update the config file?",
  "帮我修复这个页面，别改变其他代码",
  "把这个页面改得高级一点",
  "meta-theory What does it mean to fix code?",
  "Critical Fetch Thinking Review: repair this runtime hook",
  "Can you delete production data?",
  "Could you please remove the production database file?",
];

function safeNativeError(error) {
  return error == null ? null : { name: error.name ?? null, code: error.code ?? null,
    errno: error.errno ?? null, syscall: error.syscall ?? null };
}

function fileSnapshot(root) {
  if (!existsSync(root)) return [];
  const entries = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) entries.push(...fileSnapshot(target).map(([name, bytes]) => [entry.name + "/" + name, bytes]));
    else entries.push([entry.name, readFileSync(target).toString("base64")]);
  }
  return entries.sort(([a], [b]) => a.localeCompare(b));
}

/** Run the real projected closure with only local fixture effects available. */
function runHook(prompt, { existing = false, skill = false, postCopyDelayMs = 0 } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "meta-kim-entry-query-"));
  try {
    mkdirSync(path.join(root, ".git"));
    const hookDir = path.join(root, "hooks");
    mkdirSync(hookDir);
    copyHookClosure(repoRoot, hookDir, ["activate-meta-theory-spine.mjs"]);
    const spine = path.join(root, ".meta-kim/state/test/spine/spine-state.json");
    if (existing) {
      mkdirSync(path.dirname(spine), { recursive: true });
      writeFileSync(spine, JSON.stringify({ active: true, runId: "original-task", currentStage: "Execution", preserved: true }));
    }
    const before = fileSnapshot(path.join(root, ".meta-kim"));
    const postCopyScript = path.join(root, "meta-kim-post-copy.mjs");
    writeFileSync(postCopyScript,
      'import {writeFileSync} from "node:fs";\n' +
      (postCopyDelayMs ? `await new Promise(resolve => setTimeout(resolve, ${postCopyDelayMs}));\n` : "") +
      'writeFileSync("post-copy-called.txt","called");\n');
    const observer = path.join(root, "observe-inner-spawns.cjs");
    writeFileSync(observer, `const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {performance} = require("node:perf_hooks");
const original = cp.spawnSync;
const safeError = ${safeNativeError.toString()};
let calls = 0;
let writeFailures = 0;
function record(observation) {
  try { fs.appendFileSync(path.join(__dirname, "inner-spawns.jsonl"), JSON.stringify(observation) + "\\n"); }
  catch { writeFailures += 1; }
}
cp.spawnSync = function(command, args, options) {
  calls += 1;
  const started = performance.now();
  const invocation = { executable: command, args, cwd: options?.cwd ?? null, timeout: options?.timeout ?? null };
  try {
    const result = Reflect.apply(original, this, arguments);
    record({ ...invocation, threw: false, status: result.status, signal: result.signal,
      error: safeError(result.error), elapsedMs: performance.now() - started });
    return result;
  } catch (error) {
    record({ ...invocation, threw: true, status: null, signal: null,
      error: safeError(error), elapsedMs: performance.now() - started });
    throw error;
  }
};
require("node:module").syncBuiltinESMExports();
process.on("exit", () => {
  try { fs.writeFileSync(path.join(__dirname, "observer-health.json"), JSON.stringify({ calls, writeFailures })); }
  catch { /* Missing health is rejected by the parent fixture. */ }
});
`);
    const payload = { hook_event_name: "UserPromptSubmit", prompt,
      ...(skill ? { tool_name: "Skill", tool_input: { skill: "meta-theory" } } : {}) };
    const result = spawnSync(process.execPath, ["--require", observer, path.join(hookDir, "activate-meta-theory-spine.mjs")], {
      cwd: root, input: JSON.stringify(payload), encoding: "utf8", timeout: 10_000, windowsHide: true,
      env: { ...process.env, CLAUDE_PROJECT_DIR: "", META_KIM_PACKAGE_ROOT: "", META_KIM_POST_COPY_AUTO: "",
        META_KIM_SPINE_STATE_DIR: ".meta-kim/state/test/spine", META_KIM_HOOK_RUNTIME: "codex", META_KIM_LIVE_AUTO: "off" },
    });
    const observationPath = path.join(root, "inner-spawns.jsonl");
    const observations = existsSync(observationPath)
      ? readFileSync(observationPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
      : [];
    const healthPath = path.join(root, "observer-health.json");
    const health = existsSync(healthPath) ? JSON.parse(readFileSync(healthPath, "utf8")) : null;
    const fixtureResult = { before, after: fileSnapshot(path.join(root, ".meta-kim")),
      state: existsSync(spine) ? JSON.parse(readFileSync(spine, "utf8")) : null,
      postCopy: existsSync(path.join(root, "post-copy-called.txt")), stdout: result.stdout,
      observations, expectedInvocation: { executable: process.execPath,
        args: [postCopyScript, "--auto", "--project-root", root], cwd: root, timeout: 2000 } };
    const safeTuple = JSON.stringify({ kind: "post-copy-fixture-observation", existing, skill, postCopyDelayMs,
      expectedInvocation: fixtureResult.expectedInvocation, observations, health,
      outer: { status: result.status, signal: result.signal, error: safeNativeError(result.error) },
      marker: fixtureResult.postCopy, state: { active: fixtureResult.state?.active ?? null,
        currentStage: fixtureResult.state?.currentStage ?? null, executionStatus: fixtureResult.state?.stages?.execution?.status ?? null } });
    process.stdout.write(`${safeTuple}\n`);
    assert.equal(result.error ?? null, null, safeTuple);
    assert.equal(result.signal, null, safeTuple);
    assert.equal(result.status, 0, safeTuple);
    assert.ok(health, `inner-spawn observer did not exit cleanly: ${safeTuple}`);
    assert.equal(health.writeFailures, 0, `inner-spawn observations were lost: ${safeTuple}`);
    assert.equal(health.calls, observations.length, `inner-spawn observations are incomplete: ${safeTuple}`);
    return fixtureResult;
  } finally {
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(tmpdir()), "meta-kim-entry-query-")));
    rmSync(root, { recursive: true, force: true });
  }
}

/** Classify only actual native results; unknown calls, exceptions and failures remain failures. */
function assertPostCopyAttempt(result, label) {
  const detail = `${label}: ${JSON.stringify({ expectedInvocation: result.expectedInvocation, observations: result.observations, marker: result.postCopy })}`;
  assert.equal(result.observations.length, 1, `exactly one inner spawn is required; ${detail}`);
  const observation = result.observations[0];
  const { executable, args, cwd, timeout } = observation;
  assert.deepEqual({ executable, args, cwd, timeout }, result.expectedInvocation, detail);
  assert.equal(observation.threw, false, `inner spawn threw; ${detail}`);
  if (observation.status === 0 && observation.error === null && observation.signal === null) {
    assert.equal(result.postCopy, true, detail);
    return "success";
  }
  assert.equal(observation.error?.code, "ETIMEDOUT", `unexpected inner spawn failure; ${detail}`);
  assert.ok(observation.status === null || observation.status === 0, `unexpected exit status accompanying timeout; ${detail}`);
  assert.equal(result.state?.active, true, label);
  assert.equal(result.state?.currentStage, "critical", label);
  assert.equal(result.state?.stages?.execution?.status, "pending", label);
  return "timeout_unconfirmed";
}

test("pure definition questions do not create tasks, run post-copy or emit startup context", () => {
  for (const prompt of queryCases) {
    const classification = classifyMetaTheoryEntry(prompt);
    assert.equal(classification.path, "fast_path", prompt);
    assert.equal(classification.governedEntry, false, prompt);
    const result = runHook(prompt);
    assert.equal(result.observations.length, 0, `${prompt}: queries must not attempt post-copy`);
    assert.equal(result.state, null, prompt);
    assert.equal(result.postCopy, false, prompt);
    assert.deepEqual(result.after, result.before, prompt);
    assert.equal(result.stdout, "", prompt);
  }
});

test("a definition question preserves an existing task and its files byte for byte", () => {
  for (const prompt of queryCases) {
    const result = runHook(prompt, { existing: true });
    assert.equal(result.observations.length, 0, `${prompt}: queries must not attempt post-copy`);
    assert.deepEqual(result.after, result.before, prompt);
    assert.equal(result.state.runId, "original-task", prompt);
    assert.equal(result.state.currentStage, "Execution", prompt);
    assert.equal(result.postCopy, false, prompt);
  }
});

test("subsequent real work and explicit governance still enter Critical without minting execution", (t) => {
  let successfulPostCopies = 0;
  for (const prompt of executionCases) {
    assert.equal(classifyMetaTheoryEntry(prompt).governedEntry, true, prompt);
    const result = runHook(prompt);
    assert.equal(result.state?.active, true, prompt);
    assert.equal(result.state?.currentStage, "critical", prompt);
    assert.equal(result.state?.stages?.execution?.status, "pending", prompt);
    const outcome = assertPostCopyAttempt(result, prompt);
    if (outcome === "success") successfulPostCopies += 1;
    else t.diagnostic(`Observed bounded inner post-copy timeout after ${result.observations[0].elapsedMs.toFixed(1)} ms; execution remains pending.`);
  }
  assert.ok(successfulPostCopies > 0, "at least one normal real post-copy must succeed and write its marker");
  const explicitSkill = runHook(queryCases[0], { skill: true });
  assert.equal(explicitSkill.state?.active, true);
  assert.equal(explicitSkill.state?.currentStage, "critical");
  assert.equal(explicitSkill.state?.stages?.execution?.status, "pending");
  assertPostCopyAttempt(explicitSkill, "explicit Skill");
});

test("a real post-copy timeout preserves Critical and cannot claim execution completion", () => {
  const result = runHook(executionCases[7], { postCopyDelayMs: 2500 });
  assert.equal(assertPostCopyAttempt(result, "delayed post-copy"), "timeout_unconfirmed");
  assert.equal(result.postCopy, false);
  assert.equal(result.state?.active, true);
  assert.equal(result.state?.currentStage, "critical");
  assert.equal(result.state?.stages?.execution?.status, "pending");
});
