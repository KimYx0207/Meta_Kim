import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import {
  buildProjectRef,
  detectProjectRegistryEntry,
  ensureGovernedLiveProjectRegistration,
  getProjectRegistryPaths,
  joinProjectRegistry,
  listJoinedProjectRegistryEntries,
  readProjectRegistryEntry,
  repairEphemeralProjectRegistryEntries,
  skipProjectRegistry,
} from "../../scripts/project-registry.mjs";
import { importDatabaseSync } from "../../scripts/sqlite-runtime.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

describe("project registry", () => {
  test("unknown project resolves to prompt_join with machine-global registry path", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-home-"));
    const repoPath = path.join(homeDir, "workspaces", "alpha");

    const paths = getProjectRegistryPaths({ homeDir });
    assert.equal(
      paths.projectRegistryPath,
      path.join(homeDir, ".meta-kim", "global", "project-registry.sqlite"),
    );

    const status = await detectProjectRegistryEntry({ homeDir, repoPath });
    assert.equal(status.registryStatus, "prompt_join");
    assert.equal(status.known, false);
    assert.equal(status.projectRef, buildProjectRef({ repoPath }));
  });

  test("joinProjectRegistry persists joined projects, platform rows, and source rows", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-home-"));
    const repoPath = path.join(homeDir, "workspaces", "beta");

    const joined = await joinProjectRegistry({
      homeDir,
      repoPath,
      runtimeFamily: "codex",
      sourceType: "meta_architecture",
      sourceRef: "meta-kim-runtime",
    });
    assert.equal(joined.registryStatus, "joined");

    const detected = await detectProjectRegistryEntry({
      homeDir,
      repoPath,
      runtimeFamily: "codex",
    });
    assert.equal(detected.registryStatus, "known");
    assert.equal(detected.known, true);

    const entry = await readProjectRegistryEntry({ homeDir, repoPath });
    assert.equal(entry.project.projectRef, buildProjectRef({ repoPath }));
    assert.equal(entry.project.enrollmentStatus, "joined");
    assert.equal(entry.platforms.length, 1);
    assert.equal(entry.platforms[0].platform, "codex");
    assert.equal(entry.platforms[0].status, "active");
    assert.equal(entry.sources.length, 1);
    assert.equal(entry.sources[0].sourceType, "meta_architecture");
    assert.equal(entry.sources[0].sourceRef, "meta-kim-runtime");
  });

  test("skipProjectRegistry persists a no-join decision", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-home-"));
    const repoPath = path.join(homeDir, "workspaces", "gamma");

    const skipped = await skipProjectRegistry({ homeDir, repoPath });
    assert.equal(skipped.registryStatus, "skipped");

    const detected = await detectProjectRegistryEntry({ homeDir, repoPath });
    assert.equal(detected.registryStatus, "skipped");
    assert.equal(detected.known, false);
  });

  test("governed Live auto-joins unknown projects but preserves an explicit skip", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-live-registry-"));
    try {
      const joinedPath = path.join(homeDir, "workspaces", "joined-live");
      const skippedPath = path.join(homeDir, "workspaces", "skipped-live");
      const joined = await ensureGovernedLiveProjectRegistration({
        homeDir,
        repoPath: joinedPath,
        sourceRef: "test-live",
      });
      assert.equal(joined.registryStatus, "joined");
      assert.equal((await detectProjectRegistryEntry({ homeDir, repoPath: joinedPath })).known, true);

      await skipProjectRegistry({ homeDir, repoPath: skippedPath });
      const skipped = await ensureGovernedLiveProjectRegistration({ homeDir, repoPath: skippedPath });
      assert.equal(skipped.registryStatus, "skipped");
      assert.equal(skipped.known, false);

      const detached = await ensureGovernedLiveProjectRegistration({
        homeDir,
        preferredProjectRef: "project-a1b2c3d4e5f6",
      });
      assert.equal(detached.projectRef, "project-a1b2c3d4e5f6");
      assert.equal(detached.registryStatus, "not_applicable");
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  test(
    "Windows path casing reuses one stable project row",
    { skip: process.platform !== "win32" },
    async () => {
      const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-home-"));
      const repoPath = path.join(homeDir, "workspaces", "CaseStableProject");

      const first = await joinProjectRegistry({
        homeDir,
        repoPath,
        runtimeFamily: "codex",
      });
      const second = await joinProjectRegistry({
        homeDir,
        repoPath: repoPath.toUpperCase(),
        runtimeFamily: "claude",
      });

      assert.equal(second.projectRef, first.projectRef);
      const entry = await readProjectRegistryEntry({ homeDir, repoPath });
      assert.equal(entry.project.projectRef, first.projectRef);
      assert.deepEqual(
        entry.platforms.map((item) => item.platform),
        ["claude", "codex"],
      );
    },
  );

  test("repair dry-run and apply remove only exact missing temp bootstrap rows", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-repair-home-"));
    const eligible = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-repair-eligible-"));
    const existingTemp = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-repair-existing-"));
    const sourceMismatch = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-repair-source-"));
    const outsideMissing = path.join(
      path.dirname(os.tmpdir()),
      `meta-kim-outside-temp-${process.pid}-${Date.now()}`,
    );
    try {
      await joinProjectRegistry({
        homeDir,
        repoPath: eligible,
        sourceType: "project_bootstrap",
        sourceRef: "setup-project-bootstrap",
      });
      await joinProjectRegistry({
        homeDir,
        repoPath: existingTemp,
        sourceType: "project_bootstrap",
        sourceRef: "setup-project-bootstrap",
      });
      await joinProjectRegistry({
        homeDir,
        repoPath: sourceMismatch,
        sourceType: "project_bootstrap",
        sourceRef: "manual-project-bootstrap",
      });
      await joinProjectRegistry({
        homeDir,
        repoPath: outsideMissing,
        sourceType: "project_bootstrap",
        sourceRef: "setup-project-bootstrap",
      });
      await fs.rm(eligible, { recursive: true, force: true });
      await fs.rm(sourceMismatch, { recursive: true, force: true });

      const dryRun = await repairEphemeralProjectRegistryEntries({ homeDir });
      assert.equal(dryRun.mode, "dry-run");
      assert.equal(dryRun.eligibleCount, 1);
      assert.equal(dryRun.candidates[0].repoRoot, path.resolve(eligible));
      assert.equal(dryRun.deletedCount, 0);
      assert.equal(dryRun.backup, null);
      assert.deepEqual(
        new Set(dryRun.skipped.map((entry) => entry.reason)),
        new Set(["target_still_exists", "source_mismatch", "outside_os_temp_root"]),
      );
      assert.equal((await listJoinedProjectRegistryEntries({ homeDir })).length, 4);

      const applied = await repairEphemeralProjectRegistryEntries({ homeDir, apply: true });
      assert.equal(applied.mode, "apply");
      assert.equal(applied.transaction, "committed");
      assert.equal(applied.deletedCount, 1);
      assert.equal(applied.backup.quickCheck, "ok");
      assert.ok(applied.backup.bytes > 0);
      await fs.access(applied.backup.path);
      assert.equal(await readProjectRegistryEntry({ homeDir, repoPath: eligible }), null);
      assert.notEqual(
        await readProjectRegistryEntry({ homeDir, repoPath: existingTemp }),
        null,
      );
      assert.notEqual(
        await readProjectRegistryEntry({ homeDir, repoPath: sourceMismatch }),
        null,
      );
      assert.notEqual(
        await readProjectRegistryEntry({ homeDir, repoPath: outsideMissing }),
        null,
      );

      const DatabaseSync = await importDatabaseSync();
      const backupDb = new DatabaseSync(applied.backup.path, { readOnly: true });
      try {
        const backupRow = backupDb
          .prepare("SELECT project_ref AS projectRef FROM projects WHERE project_ref = ?")
          .get(buildProjectRef({ repoPath: eligible }));
        assert.equal(backupRow.projectRef, buildProjectRef({ repoPath: eligible }));
      } finally {
        backupDb.close();
      }
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      await fs.rm(eligible, { recursive: true, force: true });
      await fs.rm(existingTemp, { recursive: true, force: true });
      await fs.rm(sourceMismatch, { recursive: true, force: true });
    }
  });

  test("repair rolls back every deletion when an apply transaction fails", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-repair-rollback-home-"));
    const first = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-repair-rollback-a-"));
    const second = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-repair-rollback-b-"));
    try {
      for (const repoPath of [first, second]) {
        await joinProjectRegistry({
          homeDir,
          repoPath,
          sourceType: "project_bootstrap",
          sourceRef: "setup-project-bootstrap",
        });
        await fs.rm(repoPath, { recursive: true, force: true });
      }

      let failure;
      try {
        await repairEphemeralProjectRegistryEntries({
          homeDir,
          apply: true,
          onDeleteStep: ({ index }) => {
            if (index === 0) throw new Error("injected repair failure");
          },
        });
      } catch (error) {
        failure = error;
      }
      assert.match(failure?.message ?? "", /injected repair failure/);
      assert.equal(failure.transaction, "rolled_back");
      assert.equal(failure.backup.quickCheck, "ok");
      await fs.access(failure.backup.path);
      assert.equal((await listJoinedProjectRegistryEntries({ homeDir })).length, 2);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      await fs.rm(first, { recursive: true, force: true });
      await fs.rm(second, { recursive: true, force: true });
    }
  });

  test("repair CLI is dry-run by default and rejects conflicting mutation flags", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-repair-cli-home-"));
    try {
      const dryRun = spawnSync(
        process.execPath,
        ["scripts/repair-project-registry.mjs", "--home-dir", homeDir],
        { cwd: repoRoot, encoding: "utf8", windowsHide: true },
      );
      assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
      const compact = JSON.parse(dryRun.stdout);
      assert.equal(compact.mode, "dry-run");
      assert.equal(
        compact.registryExists,
        false,
        "dry-run must not create an absent registry",
      );
      assert.deepEqual(compact.candidateSample, []);
      assert.equal(compact.candidates, undefined);
      assert.equal(compact.fullPacketFlag, "--verbose");

      const verbose = spawnSync(
        process.execPath,
        ["scripts/repair-project-registry.mjs", "--verbose", "--home-dir", homeDir],
        { cwd: repoRoot, encoding: "utf8", windowsHide: true },
      );
      assert.equal(verbose.status, 0, verbose.stderr || verbose.stdout);
      assert.deepEqual(JSON.parse(verbose.stdout).candidates, []);

      const conflict = spawnSync(
        process.execPath,
        ["scripts/repair-project-registry.mjs", "--dry-run", "--apply", "--home-dir", homeDir],
        { cwd: repoRoot, encoding: "utf8", windowsHide: true },
      );
      assert.equal(conflict.status, 1);
      assert.match(conflict.stderr, /mutually exclusive/);

      const help = spawnSync(
        process.execPath,
        ["scripts/repair-project-registry.mjs", "--help"],
        { cwd: repoRoot, encoding: "utf8", windowsHide: true },
      );
      assert.equal(help.status, 0, help.stderr || help.stdout);
      assert.match(help.stdout, /--verbose/);
      assert.match(help.stdout, /--sample-size/);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });
});
