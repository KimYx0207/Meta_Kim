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
function runHook(prompt, { existing = false, skill = false } = {}) {
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
    writeFileSync(path.join(root, "meta-kim-post-copy.mjs"),
      'import {writeFileSync} from "node:fs";writeFileSync("post-copy-called.txt","called");\n');
    const payload = { hook_event_name: "UserPromptSubmit", prompt,
      ...(skill ? { tool_name: "Skill", tool_input: { skill: "meta-theory" } } : {}) };
    const result = spawnSync(process.execPath, [path.join(hookDir, "activate-meta-theory-spine.mjs")], {
      cwd: root, input: JSON.stringify(payload), encoding: "utf8", timeout: 10_000, windowsHide: true,
      env: { ...process.env, CLAUDE_PROJECT_DIR: "", META_KIM_PACKAGE_ROOT: "", META_KIM_POST_COPY_AUTO: "",
        META_KIM_SPINE_STATE_DIR: ".meta-kim/state/test/spine", META_KIM_HOOK_RUNTIME: "codex", META_KIM_LIVE_AUTO: "off" },
    });
    assert.equal(result.status, 0, result.stderr);
    return { before, after: fileSnapshot(path.join(root, ".meta-kim")),
      state: existsSync(spine) ? JSON.parse(readFileSync(spine, "utf8")) : null,
      postCopy: existsSync(path.join(root, "post-copy-called.txt")), stdout: result.stdout };
  } finally {
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(tmpdir()), "meta-kim-entry-query-")));
    rmSync(root, { recursive: true, force: true });
  }
}

test("pure definition questions do not create tasks, run post-copy or emit startup context", () => {
  for (const prompt of queryCases) {
    const classification = classifyMetaTheoryEntry(prompt);
    assert.equal(classification.path, "fast_path", prompt);
    assert.equal(classification.governedEntry, false, prompt);
    const result = runHook(prompt);
    assert.equal(result.state, null, prompt);
    assert.equal(result.postCopy, false, prompt);
    assert.deepEqual(result.after, result.before, prompt);
    assert.equal(result.stdout, "", prompt);
  }
});

test("a definition question preserves an existing task and its files byte for byte", () => {
  for (const prompt of queryCases) {
    const result = runHook(prompt, { existing: true });
    assert.deepEqual(result.after, result.before, prompt);
    assert.equal(result.state.runId, "original-task", prompt);
    assert.equal(result.state.currentStage, "Execution", prompt);
    assert.equal(result.postCopy, false, prompt);
  }
});

test("subsequent real work and explicit governance still enter Critical without minting execution", () => {
  for (const prompt of executionCases) {
    assert.equal(classifyMetaTheoryEntry(prompt).governedEntry, true, prompt);
    const result = runHook(prompt);
    assert.equal(result.state?.active, true, prompt);
    assert.equal(result.state?.currentStage, "critical", prompt);
    assert.equal(result.state?.stages?.execution?.status, "pending", prompt);
    assert.equal(result.postCopy, true, prompt);
  }
  const explicitSkill = runHook(queryCases[0], { skill: true });
  assert.equal(explicitSkill.state?.active, true);
  assert.equal(explicitSkill.state?.currentStage, "critical");
});
