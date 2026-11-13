import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  attestPlanningContinuity, initializePlanningContinuity, inspectPlanningContinuity,
  planningContextLimits, readPlanningPage,
} from "../../canonical/runtime-assets/shared/hooks/planning-continuity.mjs";

const sourceRoot = path.resolve(import.meta.dirname, "../../canonical/runtime-assets/shared/hooks");
const digest = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-planning-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".git"));
  const projected = path.join(root, "projected-hook");
  await mkdir(projected);
  // Execute the independently copied Hook with only its existing dependency
  // closure: output configuration must not depend on repository-only files.
  for (const file of ["planning-continuity.mjs", "project-root.mjs", "spine-state-utils.mjs"]) {
    await copyFile(path.join(sourceRoot, file), path.join(projected, file));
  }
  const input = { options: { projectRoot: root, runtime: "codex", runId: "large-plan" } };
  const initialized = await initializePlanningContinuity(input);
  const env = { ...process.env };
  for (const key of ["META_KIM_PLANNING_CONTEXT_LIMITS", "CLAUDE_PROJECT_DIR", "META_KIM_PROJECT_ROOT", "META_KIM_PLANNING_RUN_ID"]) delete env[key];
  return {
    root, input, authority: initialized.context.authority,
    cli(command, args = [], extraEnv = {}) {
      const result = spawnSync(process.execPath, [path.join(projected, "planning-continuity.mjs"), command,
        "--project-root", root, "--runtime", "codex", "--run-id", "large-plan", ...args],
      { cwd: root, env: { ...env, ...extraEnv }, input: "{}", encoding: "utf8", maxBuffer: 256 * 1024 });
      assert.equal(result.error, undefined, result.error?.message);
      return { ...result, value: result.stdout ? JSON.parse(result.stdout) : null };
    },
    async setFiles(files) {
      for (const [file, content] of Object.entries(files)) await writeFile(path.join(root, file), content);
      assert.equal((await attestPlanningContinuity({ options: { ...input.options, ownerReview: true } })).status, "attested");
    },
  };
}

test("multi-megabyte plans keep CLI and new ledger events bounded without losing any completion condition", async (t) => {
  const f = await fixture(t);
  const files = {
    "task_plan.md": `# Plan\n${Array.from({ length: 10000 }, (_, i) => `- [ ] module-${i}: ${"接口与验收🧭 ".repeat(16)}`).join("\n")}\n`,
    "findings.md": `# Findings\n${"PRIVATE_FINDINGS_ONLY_ON_EXPLICIT_READ\n".repeat(60000)}`,
    "progress.md": `${"- Current status: historical step\n".repeat(10000)}- 当前状态：MODULE-9500-ACTIVE\n- 下一步行动：核验支付重试🧭\n`,
  };
  await f.setFiles(files);
  const inspected = await inspectPlanningContinuity(f.input);
  assert.equal(inspected.records.find((r) => r.file === "findings.md").content, files["findings.md"], "library callers retain the complete source");
  assert.equal(inspected.completion.checklist.open.length, 10000);
  for (const command of ["doctor", "resume", "stop"]) {
    const result = f.cli(command);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(Buffer.byteLength(result.stdout) < 24000);
    assert.equal(result.value.output.schemaVersion, "meta-kim-planning-cli-v1");
    assert.equal(result.value.completion.checklist.total, 10000);
    assert.equal(result.value.completion.checklist.openCount, 10000);
    assert.equal(result.value.completion.eligible, false);
    assert.equal(result.value.completion.checklistClosed, false);
    assert.doesNotMatch(result.stdout, /PRIVATE_FINDINGS_ONLY_ON_EXPLICIT_READ/u);
    if (command !== "stop") assert.match(result.value.projection, /MODULE-9500-ACTIVE/u);
    else assert.equal(result.value.status, "block");
  }
  const complete = f.cli("complete", ["--verification-passed", "--summary-closed"]);
  assert.equal(complete.status, 2);
  assert.ok(complete.value.issues.includes("open_checklist_items"));
  const authorityText = await readFile(f.authority, "utf8");
  assert.ok(Buffer.byteLength(authorityText) < 24000, "one Stop must not persist 10,000 checklist texts again");
  const stop = JSON.parse(authorityText).ledger.events.find((event) => event.event === "stop_block");
  assert.equal(stop.completion.checklist.openCount, 10000);
  assert.equal(stop.completion.checklist.open, undefined);
  for (const [file, original] of Object.entries(files)) assert.equal(digest(await readFile(path.join(f.root, file))), digest(original));
});

test("an open item beyond the projected prefix still prevents completion and drift still refuses resume", async (t) => {
  const f = await fixture(t);
  const plan = `# Plan\n${"- [x] completed earlier module\n".repeat(10000)}- [ ] LAST_MODULE_NOT_FINISHED\n`;
  await f.setFiles({ "task_plan.md": plan });
  const summary = f.cli("doctor");
  assert.equal(summary.value.completion.checklist.total, 10001);
  assert.equal(summary.value.completion.checklist.openCount, 1);
  assert.equal(summary.value.completion.checklist.closedCount, 10000);
  assert.equal(summary.value.completion.eligible, false);
  assert.equal(f.cli("complete", ["--verification-passed", "--summary-closed"]).status, 2);
  await writeFile(path.join(f.root, "task_plan.md"), `${plan}- [ ] changed after attestation\n`);
  const drift = f.cli("resume");
  assert.equal(drift.status, 2);
  assert.ok(drift.value.issues.includes("attestation_hash_drift"));
  assert.equal(drift.value.projection, undefined);
});

test("explicit pages are lossless across Unicode boundaries and refuse a changed or unbound continuation", async (t) => {
  const f = await fixture(t);
  const original = "# 证据🧭\r\n长行：甲🧭乙🚀丙👩‍💻丁\n\"quoted\"\\tail\n";
  await f.setFiles({ "findings.md": original });
  const first = f.cli("read", ["--file", "findings.md", "--length", "7"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.value.output.mode, "file_page");
  let combined = first.value.content;
  let next = first.value.nextRead;
  while (next) {
    const page = await readPlanningPage({ options: { ...f.input.options, ...next } });
    assert.equal(page.status, "read");
    assert.doesNotMatch(page.content, /[\uD800-\uDFFF]/u);
    assert.equal(page.range.start, next.offset);
    combined += page.content;
    next = page.nextRead;
  }
  assert.equal(combined, original);
  const cursor = first.value.nextRead;
  await assert.rejects(readPlanningPage({ options: { ...f.input.options, file: "findings.md", offset: cursor.offset } }), /sha256_required/u);
  await writeFile(path.join(f.root, "findings.md"), `${original}new evidence\n`);
  const changed = f.cli("read", ["--file", cursor.file, "--offset", String(cursor.offset), "--length", "7", "--sha256", cursor.sha256]);
  assert.equal(changed.status, 2);
  assert.ok(changed.value.issues.includes("planning_page_source_changed"));
  // Reading drift for diagnosis is allowed, but never repairs its attestation.
  assert.equal(f.cli("read", ["--file", "findings.md", "--length", "7"]).value.attestationCurrent, false);
  assert.equal(f.cli("resume").status, 2);
});

test("central limits are validated, configurable in a copied Hook, and byte overflow is explicit", async (t) => {
  const f = await fixture(t);
  for (const value of [0, -1, NaN, Infinity, 1e12, "5000"]) {
    assert.throws(() => planningContextLimits({ contextLimits: { projectionChars: value } }), /context_limit_invalid/u);
  }
  for (const key of ["unknown", "constructor", "toString", "__proto__"]) {
    assert.throws(() => planningContextLimits({ contextLimits: JSON.parse(`{"${key}":123}`) }), /context_limit_invalid/u);
  }
  assert.throws(() => planningContextLimits({ contextLimits: "[]" }), /context_limits_invalid_object/u);
  const limits = { projectionChars: 900, projectionLines: 10, previewItems: 0, pageChars: 12, cliBytes: 4096 };
  const configured = f.cli("doctor", [], { META_KIM_PLANNING_CONTEXT_LIMITS: JSON.stringify(limits) });
  assert.equal(configured.status, 0, configured.stderr);
  assert.ok(Buffer.byteLength(configured.stdout) <= 4096);
  assert.equal(configured.value.output.limits.pageChars, 12);
  assert.equal(configured.value.completion.checklist.openCount, 5);
  await f.setFiles({ "findings.md": "🧭".repeat(5000) });
  const refused = f.cli("read", ["--file", "findings.md", "--context-limits", JSON.stringify({ cliBytes: 4096 })]);
  assert.equal(refused.status, 2);
  assert.ok(Buffer.byteLength(refused.stdout) <= 4096);
  assert.equal(refused.value.content, undefined);
  assert.match(JSON.stringify(refused.value.issues), /reduce_length/u);
  const invalid = f.cli("doctor", ["--context-limits", '{"cliBytes":0}']);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
});
