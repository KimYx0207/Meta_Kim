import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { inspectProjectRelations } from "../../src/infrastructure/project/project-relations.mjs";
import { inspectProjectContext } from "../../scripts/governed-execution/project-context.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-source-map-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { start: "node src/main.mjs" } }));
  await writeFile(path.join(root, "src/main.mjs"), 'import { value } from "./value.mjs";\nconsole.log(value);\n');
  await writeFile(path.join(root, "src/value.mjs"), 'export const value = 1;\n');
  return root;
}

test("current source references locate callers, bind dirty bytes and never authorize deletion", async t => {
  const root = await fixture(t);
  const before = await inspectProjectRelations({ projectRoot: root, focusPaths: ["src/value.mjs"] });
  assert.deepEqual(before.relations.map(edge => [edge.from, edge.to, edge.line]), [["src/main.mjs", "src/value.mjs", 1]]);
  assert.equal(before.candidateStatus[0].observedInboundCount, 1);
  assert.equal(before.candidateStatus[0].automaticDeletionAllowed, false);
  await writeFile(path.join(root, "src/value.mjs"), 'export const value = 2;\n');
  const after = await inspectProjectRelations({ projectRoot: root, focusPaths: ["src/value.mjs"] });
  assert.notEqual(after.snapshotDigest, before.snapshotDigest);
  assert.notEqual(after.sourceBindings.find(file => file.path === "src/value.mjs").sha256,
    before.sourceBindings.find(file => file.path === "src/value.mjs").sha256);
  const context = await inspectProjectContext({ projectRoot: root, focusPaths: ["src/value.mjs"] });
  assert.equal(context.relatedCode.digest, after.digest, "The ordinary project preparation consumes the same current source map");
});

test("partial scans, computed imports and unreferenced files remain review-needed", async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, "src/main.mjs"), 'const plugin = await import(process.env.PLUGIN);\n');
  const result = await inspectProjectRelations({ projectRoot: root, focusPaths: ["src/value.mjs"] });
  assert.equal(result.candidateStatus[0].observedInboundCount, 0);
  assert.equal(result.candidateStatus[0].deletionReadiness, "requires_usage_and_entrypoint_review");
  assert.ok(result.limitations.some(item => item.includes("computed_import")));
  const partial = await inspectProjectRelations({ projectRoot: root, focusPaths: ["src/value.mjs"], maxFiles: 1 });
  assert.ok(partial.limitations.includes("file_scan_partial"));
  assert.equal(partial.sourceBindings[0].path, "src/value.mjs", "Focus is read before unrelated files under the budget");
  assert.equal(partial.candidateStatus[0].automaticDeletionAllowed, false);
});

test("Git NUL status preserves spaces and rename sources, and source links are not read", async t => {
  const root = await fixture(t);
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git(["init", "-q"]); git(["add", "."]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  git(["mv", "src/value.mjs", "src/value renamed.mjs"]);
  const newPath = process.platform === "win32" ? "src/new module.mjs" : "src/new\nmodule.mjs";
  await writeFile(path.join(root, newPath), 'export const fresh = true;');
  try { await symlink(path.join(root, "src/main.mjs"), path.join(root, "src/link.mjs")); }
  catch (error) { if (error.code !== "EPERM") throw error; t.diagnostic("Symlink creation unavailable on this host"); }
  const context = await inspectProjectContext({ projectRoot: root });
  assert.ok(context.worktree.changedPaths.includes("src/value renamed.mjs"));
  assert.ok(context.worktree.changedPaths.includes("src/value.mjs"));
  assert.ok(context.worktree.changedPaths.includes(newPath));
  assert.ok(!context.relatedCode.sourceBindings.some(file => file.path === "src/link.mjs"));
  assert.ok(!context.relatedCode.sourceBindings.some(file => file.path.startsWith("../")));
  assert.equal(context.worktree.status, "observed");
});


test("a requested directory is read before unrelated files under a tight budget", async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, "a-unrelated.mjs"), "export const unrelated = true;");
  const result = await inspectProjectRelations({ projectRoot: root, focusPaths: ["src"], maxFiles: 1 });
  assert.equal(result.scannedFileCount, 1);
  assert.equal(result.sourceBindings[0].path, "src/main.mjs");
  assert.ok(result.limitations.includes("file_scan_partial"));
});
