import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const SYNC_SCRIPT = path.join(REPO_ROOT, "scripts", "sync-global-meta-theory.mjs");

test("stale skill aliases are classified before realpath enforcement", async () => {
  const source = await readFile(SYNC_SCRIPT, "utf8");
  const helperStart = source.indexOf("async function backupAndRemoveStaleSkillAlias");
  const helperEnd = source.indexOf("\nasync function ", helperStart + 1);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = source.slice(helperStart, helperEnd);

  const classifyAt = helper.indexOf("await isStaleMetaKimSkillAlias(target)");
  const enforceAt = helper.indexOf("await assertRealHomeBound(target.dir)");
  assert.ok(classifyAt >= 0, "cleanup must classify a stale alias");
  assert.ok(enforceAt > classifyAt, "realpath enforcement must follow classification");
});

test("global sync does not swallow stale-alias backup failures", async () => {
  const source = await readFile(SYNC_SCRIPT, "utf8");
  const runSync = source.slice(source.indexOf("async function runSync"));
  const loopStart = runSync.indexOf("for (const target of staleSkillCleanupTargets)");
  const loopEnd = runSync.indexOf(
    'if (selectedTargetIds.includes("claude") && withGlobalHooks)',
    loopStart,
  );
  assert.ok(loopStart >= 0 && loopEnd > loopStart);
  const cleanupLoop = runSync.slice(loopStart, loopEnd);

  assert.match(cleanupLoop, /await backupAndRemoveStaleSkillAlias\(target\)/u);
  assert.doesNotMatch(cleanupLoop, /\bcatch\b|Skipped stale skill alias cleanup/u);
});

test("runtime symlinks and junctions are not ordinary directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-kim-stale-alias-policy-"));
  try {
    const target = path.join(root, "runtime-skill");
    const alias = path.join(root, "shared-skill");
    await mkdir(target, { recursive: true });
    await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");

    const stat = await lstat(alias);
    assert.equal(stat.isDirectory(), false);
    assert.equal(stat.isSymbolicLink(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
