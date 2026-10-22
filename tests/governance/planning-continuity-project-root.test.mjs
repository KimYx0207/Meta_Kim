import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  initializePlanningContinuity,
  inspectPlanningContinuity,
  resumePlanningContinuity,
} from "../../canonical/runtime-assets/shared/hooks/planning-continuity.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-kim-planning-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const outside = path.join(root, "project-sibling");
  const empty = path.join(root, "empty");
  await Promise.all([mkdir(project), mkdir(outside), mkdir(empty)]);
  const input = (projectRoot, planRoot = ".") => ({
    options: { projectRoot, cwd: empty, planRoot, runtime: "codex", runId: "linked-project" },
  });
  return { root, project, outside, input };
}

// POSIX uses real directory symlinks; Windows also verifies junctions even on
// hosts where unprivileged directory symlink creation is unavailable.
for (const type of process.platform === "win32" ? ["dir", "junction"] : ["dir"]) {
  test(`planning continuity canonicalizes a linked project root (${type})`, async (t) => {
    const { root, project, outside, input } = await fixture(t);
    const alias = path.join(root, "alias");
    try {
      await symlink(project, alias, type);
    } catch (error) {
      if (process.platform === "win32" && type === "dir" && ["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.skip(`directory symlink creation unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.equal((await lstat(alias)).isSymbolicLink(), true);
    const initialized = await initializePlanningContinuity(input(alias));
    assert.equal(initialized.status, "initialized_attested");
    assert.equal(initialized.context.projectRoot, await realpath(project));
    assert.equal((await resumePlanningContinuity(input(alias))).status, "resumed");
    const canonical = await inspectPlanningContinuity(input(project));
    assert.equal(canonical.context.key, initialized.context.key);
    assert.equal(canonical.context.authority, initialized.context.authority);

    // Model /var -> /private/var with an alias in an ancestor component.
    const child = path.join(project, "child");
    await mkdir(child);
    const nested = await initializePlanningContinuity(input(path.join(alias, "child"), "plans/new"));
    assert.equal(nested.context.projectRoot, await realpath(child));
    assert.equal(nested.context.planRoot, await realpath(path.join(child, "plans/new")));

    for (const planRoot of [outside, "../project-sibling", "../project-sibling/new"]) {
      await assert.rejects(initializePlanningContinuity(input(alias, planRoot)), /planning_root_outside_project/u);
      assert.deepEqual(await readdir(outside), []);
    }
    await symlink(outside, path.join(project, "escape"), type);
    await assert.rejects(initializePlanningContinuity(input(alias, "escape/new")), /planning_root_symlink_escape/u);
    assert.deepEqual(await readdir(outside), []);

    const absent = path.join(root, "absent-target");
    await symlink(absent, path.join(project, "broken-plan"), type);
    await assert.rejects(initializePlanningContinuity(input(alias, "broken-plan/new")), /planning_root_symlink_escape/u);
    await symlink(absent, path.join(root, "broken-project"), type);
    await assert.rejects(initializePlanningContinuity(input(path.join(root, "broken-project"))), /trusted_project_root_not_found/u);
    await assert.rejects(lstat(absent), { code: "ENOENT" });
  });
}

test("missing project and plan roots fail closed, while init creates safe missing plans", async (t) => {
  const { root, project, input } = await fixture(t);
  const missingProject = path.join(root, "missing-project");
  await assert.rejects(initializePlanningContinuity(input(missingProject)), /trusted_project_root_not_found/u);
  await assert.rejects(lstat(missingProject), { code: "ENOENT" });
  await assert.rejects(inspectPlanningContinuity(input(project, "missing-plan")), /planning_root_missing/u);
  await assert.rejects(lstat(path.join(project, "missing-plan")), { code: "ENOENT" });
  assert.equal((await initializePlanningContinuity(input(project, "missing-plan"))).status, "initialized_attested");
});

test("saved locations require exact authority identity and remain safe relative paths", async (t) => {
  const { project, outside, input } = await fixture(t);
  const initialized = await initializePlanningContinuity(input(project, "plans/current"));
  const implicit = input(project);
  delete implicit.options.planRoot;
  const original = await readFile(initialized.context.authority, "utf8");
  const state = JSON.parse(original);
  for (const [field, value, reason] of [
    ["schemaVersion", "unknown", /schema_version_mismatch/u],
    ["projectRootDigest", "different-project", /project_binding_mismatch/u],
    ["runtime", "claude_code", /runtime_binding_mismatch/u],
    ["runIdentifierDigest", "different-run", /run_binding_mismatch/u],
    ["runKey", "different-key", /run_key_mismatch/u],
    ["planRootRelative", "../project-sibling/new", /planning_root_outside_project/u],
    ["planRootRelative", outside, /planning_root_binding_invalid/u],
    ["planRootRelative", path.join(project, "plans/current"), /planning_root_binding_invalid/u],
    ["planRootRelative", null, /planning_root_binding_invalid/u],
  ]) {
    const corrupt = JSON.stringify({ ...state, [field]: value });
    await writeFile(initialized.context.authority, corrupt);
    await assert.rejects(resumePlanningContinuity(implicit), reason);
    await assert.rejects(initializePlanningContinuity(implicit), reason);
    assert.equal(await readFile(initialized.context.authority, "utf8"), corrupt);
    assert.deepEqual(await readdir(outside), []);
  }
  await writeFile(initialized.context.authority, original);
  assert.equal((await resumePlanningContinuity(implicit)).context.planRootSource, "authority");
  // Nearby projects and other runs are not candidates for implicit recovery.
  const other = input(outside);
  delete other.options.planRoot;
  assert.ok((await resumePlanningContinuity(other)).issues.includes("authority_missing"));
  const otherRun = { options: { ...implicit.options, runId: "other-run" } };
  assert.ok((await resumePlanningContinuity(otherRun)).issues.includes("authority_missing"));
  const otherRuntime = { options: { ...implicit.options, runtime: "claude" } };
  assert.ok((await resumePlanningContinuity(otherRuntime)).issues.includes("authority_missing"));
});

for (const type of process.platform === "win32" ? ["dir", "junction"] : ["dir"]) {
  test(`an implicit saved plan refuses a replaced directory (${type})`, async (t) => {
    const { project, outside, input } = await fixture(t);
    const initialized = await initializePlanningContinuity(input(project, "plans/current"));
    const implicit = input(project);
    delete implicit.options.planRoot;
    const original = await readFile(initialized.context.authority, "utf8");
    await rm(path.join(project, "plans/current"), { recursive: true, force: true });
    try {
      await symlink(outside, path.join(project, "plans/current"), type);
    } catch (error) {
      if (process.platform === "win32" && type === "dir" && ["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.skip(`directory symlink creation unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(resumePlanningContinuity(implicit), /planning_root_symlink_escape/u);
    await assert.rejects(initializePlanningContinuity(implicit), /planning_root_symlink_escape/u);
    assert.equal(await readFile(initialized.context.authority, "utf8"), original);
    assert.deepEqual(await readdir(outside), []);
  });
}
