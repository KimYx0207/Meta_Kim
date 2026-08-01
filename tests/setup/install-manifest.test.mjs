import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  rmSync,
  utimesSync,
} from "node:fs";
import path from "node:path";

import {
  CATEGORIES,
  CATEGORY_LABELS,
  MANIFEST_LOCK_STALE_MS,
  SCHEMA_VERSION,
  TOML_MUTATION_JOURNAL_LIMIT,
  createEmpty,
  fileIntegritySync,
  listByCategory,
  manifestFileEntryMatches,
  manifestPathFor,
  openRecorder,
  readManifest,
  record,
  removeByPath,
  validate,
  writeManifest,
  writeManifestAtomic,
} from "../../scripts/install-manifest.mjs";
import {
  invertCodexConfigMutations,
  planCodexAppNativeControls,
} from "../../scripts/codex-config-merge.mjs";

function withTmpDir(body) {
  const dir = mkdtempSync(path.join(tmpdir(), "meta-kim-manifest-"));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("install-manifest schema + helpers", () => {
  test("createEmpty sets schemaVersion and required fields for global scope", () => {
    const manifest = createEmpty({
      scope: "global",
      metaKimVersion: "2.0.13",
    });
    assert.equal(manifest.schemaVersion, SCHEMA_VERSION);
    assert.equal(manifest.scope, "global");
    assert.equal(manifest.metaKimVersion, "2.0.13");
    assert.ok(manifest.createdAt);
    assert.ok(manifest.updatedAt);
    assert.deepEqual(manifest.entries, []);
    assert.equal(manifest.repoRoot, undefined);
  });

  test("createEmpty includes repoRoot when scope is project", () => {
    const manifest = createEmpty({
      scope: "project",
      repoRoot: "/repo/path",
      metaKimVersion: "2.0.13",
    });
    assert.equal(manifest.scope, "project");
    assert.equal(manifest.repoRoot, "/repo/path");
  });

  test("record appends a new entry and stamps installedAt", () => {
    const base = createEmpty({ scope: "global", metaKimVersion: "x" });
    const next = record(base, {
      path: "/a/b.mjs",
      category: CATEGORIES.B,
      source: "sync",
      purpose: "hook",
      kind: "file",
    });
    assert.equal(next.entries.length, 1);
    assert.ok(next.entries[0].installedAt);
    assert.equal(next.entries[0].path, "/a/b.mjs");
  });

  test("record merges on matching (path,purpose) key", () => {
    const base = createEmpty({ scope: "global", metaKimVersion: "x" });
    const first = record(base, {
      path: "/a.mjs",
      category: CATEGORIES.B,
      source: "sync",
      purpose: "hook",
      kind: "file",
      size: 100,
    });
    const second = record(first, {
      path: "/a.mjs",
      category: CATEGORIES.B,
      source: "sync",
      purpose: "hook",
      kind: "file",
      size: 200,
      sha256: "deadbeef",
    });
    assert.equal(second.entries.length, 1);
    assert.equal(second.entries[0].size, 200);
    assert.equal(second.entries[0].sha256, "deadbeef");
  });

  test("record does NOT merge when purpose differs at same path", () => {
    const base = createEmpty({ scope: "global", metaKimVersion: "x" });
    const first = record(base, {
      path: "/settings.json",
      category: CATEGORIES.C,
      purpose: "settings-merge",
      kind: "settings-merge",
    });
    const second = record(first, {
      path: "/settings.json",
      category: CATEGORIES.C,
      purpose: "mcp-server",
      kind: "mcp-server",
    });
    assert.equal(second.entries.length, 2);
  });

  test("removeByPath drops the matching entry, leaves others", () => {
    let manifest = createEmpty({ scope: "global", metaKimVersion: "x" });
    manifest = record(manifest, {
      path: "/a",
      category: CATEGORIES.A,
      purpose: "p",
      kind: "dir",
    });
    manifest = record(manifest, {
      path: "/b",
      category: CATEGORIES.A,
      purpose: "p",
      kind: "dir",
    });
    const after = removeByPath(manifest, "/a");
    assert.equal(after.entries.length, 1);
    assert.equal(after.entries[0].path, "/b");
  });

  test("removeByPath with purpose only drops matching purpose", () => {
    let manifest = createEmpty({ scope: "global", metaKimVersion: "x" });
    manifest = record(manifest, {
      path: "/shared",
      category: CATEGORIES.C,
      purpose: "settings-merge",
      kind: "settings-merge",
    });
    manifest = record(manifest, {
      path: "/shared",
      category: CATEGORIES.C,
      purpose: "mcp-server",
      kind: "mcp-server",
    });
    const after = removeByPath(manifest, "/shared", "settings-merge");
    assert.equal(after.entries.length, 1);
    assert.equal(after.entries[0].purpose, "mcp-server");
  });

  test("validate catches malformed entries", () => {
    const bad = {
      schemaVersion: 1,
      scope: "global",
      entries: [{ path: "", category: "Z" }],
    };
    const result = validate(bad);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length >= 2);
  });

  test("validate rejects wrong schemaVersion", () => {
    const bad = {
      schemaVersion: 999,
      scope: "global",
      entries: [],
    };
    const result = validate(bad);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("schemaVersion")));
  });

  test("validate and readManifest reject malformed TOML ownership journals", () => {
    withTmpDir((dir) => {
      const manifestPath = path.join(dir, "install-manifest.json");
      const validEntry = {
        path: path.join(dir, ".codex", "config.toml"),
        category: CATEGORIES.C,
        source: "sync-global-meta-theory",
        purpose: "codex-global-config-choice-surface-and-app-native-controls",
        kind: "toml-fragment-merge",
        installedAt: new Date().toISOString(),
        tomlMutationJournal: [{
          kind: "replace",
          locator: {
            table: "features",
            key: "default_mode_request_user_input",
          },
          beforeFragment: "default_mode_request_user_input = false",
          afterFragment: "default_mode_request_user_input = true",
        }],
      };
      const validManifest = {
        ...createEmpty({ scope: "global", metaKimVersion: "x" }),
        entries: [validEntry],
      };
      assert.deepEqual(validate(validManifest), { ok: true });

      const invalidCases = [
        {
          label: "empty journal",
          mutate(entry) {
            entry.tomlMutationJournal = [];
          },
          expected: /non-empty array/u,
        },
        {
          label: "journal limit",
          mutate(entry) {
            entry.tomlMutationJournal = Array.from(
              { length: TOML_MUTATION_JOURNAL_LIMIT + 1 },
              (_, index) => ({
                kind: "insert",
                locator: { table: "features", key: `managed_${index}` },
                beforeFragment: "",
                afterFragment: `managed_${index} = true\n`,
              }),
            );
          },
          expected: /exceeds/u,
        },
        {
          label: "mutation field",
          mutate(entry) {
            entry.tomlMutationJournal[0].offset = 12;
          },
          expected: /unsupported fields: offset/u,
        },
        {
          label: "locator field",
          mutate(entry) {
            entry.tomlMutationJournal[0].locator.line = 7;
          },
          expected: /locator has unsupported fields: line/u,
        },
        {
          label: "non-normalized chain",
          mutate(entry) {
            entry.tomlMutationJournal.push({
              kind: "replace",
              locator: {
                table: "features",
                key: "default_mode_request_user_input",
              },
              beforeFragment: "default_mode_request_user_input = true",
              afterFragment: "default_mode_request_user_input = false # next",
            });
          },
          expected: /must already be normalized/u,
        },
        {
          label: "legacy merge field",
          mutate(entry) {
            entry.mergedHookCommands = ["default_mode_request_user_input"];
          },
          expected: /mergedHookCommands is forbidden/u,
        },
        {
          label: "unrelated ownership field",
          mutate(entry) {
            entry.sha256 = "0".repeat(64);
          },
          expected: /sha256 is not allowed/u,
        },
        {
          label: "required metadata",
          mutate(entry) {
            delete entry.purpose;
          },
          expected: /purpose missing/u,
        },
      ];

      for (const invalidCase of invalidCases) {
        const invalidManifest = structuredClone(validManifest);
        invalidCase.mutate(invalidManifest.entries[0]);
        const result = validate(invalidManifest);
        assert.equal(result.ok, false, invalidCase.label);
        assert.match(result.errors.join("; "), invalidCase.expected, invalidCase.label);
      }

      const persistedInvalid = structuredClone(validManifest);
      persistedInvalid.entries[0].mergedSettingsKeys = ["features"];
      writeFileSync(manifestPath, `${JSON.stringify(persistedInvalid, null, 2)}\n`);
      assert.equal(readManifest(manifestPath), null);
    });
  });

  test("listByCategory returns all 9 category keys", () => {
    const m = createEmpty({ scope: "global", metaKimVersion: "x" });
    const grouped = listByCategory(m);
    assert.deepEqual(
      Object.keys(grouped).sort(),
      Object.keys(CATEGORY_LABELS).sort(),
    );
    for (const v of Object.values(grouped)) assert.deepEqual(v, []);
  });

  test("listByCategory groups entries correctly", () => {
    let m = createEmpty({ scope: "global", metaKimVersion: "x" });
    m = record(m, {
      path: "/x",
      category: CATEGORIES.A,
      purpose: "a",
      kind: "dir",
    });
    m = record(m, {
      path: "/y",
      category: CATEGORIES.A,
      purpose: "b",
      kind: "dir",
    });
    m = record(m, {
      path: "/z",
      category: CATEGORIES.I,
      purpose: "pip",
      kind: "pip-package",
    });
    const g = listByCategory(m);
    assert.equal(g.A.length, 2);
    assert.equal(g.I.length, 1);
    assert.equal(g.B.length, 0);
  });

  test("manifestPathFor returns deterministic paths", () => {
    const gp = manifestPathFor("global");
    assert.ok(gp.endsWith(path.join(".meta-kim", "install-manifest.json")));
    const pp = manifestPathFor("project", "/fake/repo");
    assert.equal(
      pp,
      path.join("/fake/repo", ".meta-kim", "install-manifest.json"),
    );
  });

  test("manifestPathFor throws on project without repoRoot", () => {
    assert.throws(() => manifestPathFor("project"));
  });

  test("manifestPathFor throws on unknown scope", () => {
    assert.throws(() => manifestPathFor("weird"));
  });

  test("readManifest returns null when file missing", () => {
    withTmpDir((dir) => {
      const missing = path.join(dir, "does-not-exist.json");
      assert.equal(readManifest(missing), null);
    });
  });

  test("writeManifest + readManifest round-trips", () => {
    withTmpDir((dir) => {
      const file = path.join(dir, "install-manifest.json");
      let manifest = createEmpty({ scope: "global", metaKimVersion: "2.0.13" });
      manifest = record(manifest, {
        path: "/a/b.mjs",
        category: CATEGORIES.B,
        purpose: "global-hook",
        kind: "file",
        size: 123,
      });
      writeManifest(file, manifest);
      assert.equal(existsSync(file), true);
      const roundTripped = readManifest(file);
      assert.ok(roundTripped);
      assert.equal(roundTripped.scope, "global");
      assert.equal(roundTripped.entries.length, 1);
      assert.equal(roundTripped.entries[0].size, 123);
    });
  });

  test("readManifest returns null when JSON is corrupt", () => {
    withTmpDir((dir) => {
      const file = path.join(dir, "install-manifest.json");
      writeFileSync(file, "not json");
      assert.equal(readManifest(file), null);
    });
  });

  test("readManifest returns null when schemaVersion is wrong", () => {
    withTmpDir((dir) => {
      const file = path.join(dir, "install-manifest.json");
      writeFileSync(
        file,
        JSON.stringify({ schemaVersion: 999, scope: "global", entries: [] }),
      );
      assert.equal(readManifest(file), null);
    });
  });

  test("writeManifest bumps updatedAt but preserves createdAt", async () => {
    await withTmpDir(async (dir) => {
      const file = path.join(dir, "install-manifest.json");
      const initial = createEmpty({ scope: "global", metaKimVersion: "x" });
      const firstWrite = writeManifest(file, initial);
      await new Promise((r) => setTimeout(r, 15));
      const secondWrite = writeManifest(file, firstWrite);
      assert.equal(secondWrite.createdAt, firstWrite.createdAt);
      assert.notEqual(secondWrite.updatedAt, firstWrite.updatedAt);
      const onDisk = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(onDisk.createdAt, firstWrite.createdAt);
    });
  });

  test("recordFile captures exact size and sha256 for safe ownership", () => {
    withTmpDir((dir) => {
      const managedFile = path.join(dir, "managed.mjs");
      writeFileSync(managedFile, "export default true;\n");
      const recorder = openRecorder({
        scope: "project",
        repoRoot: dir,
        metaKimVersion: "x",
      });
      recorder.recordFile(managedFile, {
        category: CATEGORIES.E,
        source: "sync-runtimes",
        purpose: "project-hook",
        ownershipClass: "install_projection",
        runtimeTarget: "codex",
      });
      recorder.flush();
      const entry = readManifest(manifestPathFor("project", dir)).entries[0];
      assert.deepEqual(
        { size: entry.size, sha256: entry.sha256 },
        fileIntegritySync(managedFile),
      );
      assert.equal(entry.ownershipClass, "install_projection");
      assert.equal(entry.runtimeTarget, "codex");
      assert.equal(manifestFileEntryMatches(entry), true);
    });
  });

  test("recordTomlFragmentMerge records only actual mutations and closes a cross-update locator chain", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "meta-kim-toml-journal-"));
    try {
      const configPath = path.join(dir, ".codex", "config.toml");
      mkdirSync(path.dirname(configPath), { recursive: true });
      const options = {
        category: CATEGORIES.G,
        source: "sync-global-meta-theory",
        purpose: "codex-global-config-choice-surface-and-app-native-controls",
      };
      const noOp = openRecorder({ scope: "project", repoRoot: dir });
      noOp.recordTomlFragmentMerge(configPath, [], options);
      const noOpResult = await noOp.flush();
      assert.equal(noOpResult.ok, true, noOpResult.error);
      assert.equal(noOpResult.changed, false);
      assert.equal(readManifest(manifestPathFor("project", dir)), null);

      const sourceA = path.join(dir, "marketplace-a");
      const sourceB = path.join(dir, "marketplace-b");
      const original = [
        "[features]",
        "default_mode_request_user_input = true",
        "js_repl = true",
        "",
        "[windows]",
        'sandbox = "unelevated"',
        "",
        '[plugins."browser@openai-bundled"]',
        "enabled = true",
        "",
        '[plugins."chrome@openai-bundled"]',
        "enabled = true",
        "",
        '[plugins."computer-use@openai-bundled"]',
        "enabled = true",
        "",
        "[marketplaces.openai-bundled]",
        'source_type = "local"',
        "source = 'fixture-original'",
        "",
      ].join("\n");
      const firstPlan = planCodexAppNativeControls(original, {
        platformName: "win32",
        windowsAppsRoots: [],
        bundledMarketplaceSource: sourceA,
        pathExists: (candidate) => candidate === sourceA,
      });
      writeFileSync(configPath, firstPlan.text);
      const first = openRecorder({ scope: "project", repoRoot: dir });
      first.recordTomlFragmentMerge(configPath, firstPlan.mutations, options);
      const firstResult = await first.flush();
      assert.equal(firstResult.ok, true, firstResult.error);
      const firstEntry = readManifest(manifestPathFor("project", dir)).entries[0];
      assert.equal(firstEntry.kind, "toml-fragment-merge");

      const secondPlan = planCodexAppNativeControls(firstPlan.text, {
        platformName: "win32",
        windowsAppsRoots: [],
        bundledMarketplaceSource: sourceB,
        pathExists: (candidate) => candidate === sourceB,
      });
      writeFileSync(configPath, secondPlan.text);
      const second = openRecorder({ scope: "project", repoRoot: dir });
      second.recordTomlFragmentMerge(configPath, secondPlan.mutations, options);
      const secondResult = await second.flush();
      assert.equal(secondResult.ok, true, secondResult.error);
      const secondEntry = readManifest(manifestPathFor("project", dir)).entries[0];
      assert.equal(secondEntry.tomlMutationJournal.length, 1);
      assert.equal(
        invertCodexConfigMutations(
          secondPlan.text,
          secondEntry.tomlMutationJournal,
        ),
        original,
      );

      const drifted = secondPlan.text.replace(sourceB, path.join(dir, "user-source"));
      const thirdPlan = planCodexAppNativeControls(drifted, {
        platformName: "win32",
        windowsAppsRoots: [],
        bundledMarketplaceSource: sourceA,
        pathExists: (candidate) => candidate === sourceA,
      });
      writeFileSync(configPath, thirdPlan.text);
      const discontinuous = openRecorder({ scope: "project", repoRoot: dir });
      discontinuous.recordTomlFragmentMerge(
        configPath,
        thirdPlan.mutations,
        options,
      );
      const discontinuousResult = await discontinuous.flush();
      assert.equal(discontinuousResult.ok, false);
      assert.match(discontinuousResult.error, /Non-contiguous Codex config mutation chain/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("flush cannot report success when a file ownership record lacks integrity", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "meta-kim-manifest-failure-"));
    try {
      const recorder = openRecorder({ scope: "project", repoRoot: dir });
      recorder.recordFile(path.join(dir, "missing.mjs"), {
        category: CATEGORIES.E,
        source: "sync-runtimes",
        ownershipClass: "install_projection",
      });
      const result = await recorder.flush();
      assert.equal(result.ok, false);
      assert.match(result.error, /cannot record file integrity/);
      assert.equal(existsSync(manifestPathFor("project", dir)), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("openRecorder replaceSources drops stale source entries only", () => {
    withTmpDir((dir) => {
      let manifest = createEmpty({
        scope: "project",
        repoRoot: dir,
        metaKimVersion: "x",
      });
      manifest = record(manifest, {
        path: path.join(dir, ".codex", "old.toml"),
        category: CATEGORIES.G,
        source: "sync-runtimes",
        purpose: "project-settings",
        kind: "file",
      });
      manifest = record(manifest, {
        path: path.join(dir, ".git", "hooks", "post-commit"),
        category: CATEGORIES.I,
        source: "setup",
        purpose: "graphify-git-hook",
        kind: "file",
      });
      writeManifest(manifestPathFor("project", dir), manifest);

      const recorder = openRecorder({
        scope: "project",
        repoRoot: dir,
        replaceSources: ["sync-runtimes"],
      });
      const newFile = path.join(dir, ".codex", "new.toml");
      mkdirSync(path.dirname(newFile), { recursive: true });
      writeFileSync(newFile, "enabled = true\n");
      recorder.recordFile(newFile, {
        category: CATEGORIES.G,
        source: "sync-runtimes",
        purpose: "project-settings",
      });
      recorder.flush();

      const next = readManifest(manifestPathFor("project", dir));
      assert.deepEqual(
        next.entries.map((entry) => entry.path).sort(),
        [
          path.join(dir, ".codex", "new.toml"),
          path.join(dir, ".git", "hooks", "post-commit"),
        ].sort(),
      );
    });
  });

  test("default recorder preserves ownership for runtime targets not selected this run", () => {
    withTmpDir((dir) => {
      const openclawFile = path.join(dir, "openclaw", "skills", "meta-theory", "SKILL.md");
      mkdirSync(path.dirname(openclawFile), { recursive: true });
      writeFileSync(openclawFile, "openclaw projection\n");
      let manifest = createEmpty({ scope: "project", repoRoot: dir, metaKimVersion: "x" });
      const openclawIntegrity = fileIntegritySync(openclawFile);
      manifest = record(manifest, {
        path: openclawFile,
        category: CATEGORIES.D,
        source: "sync-runtimes",
        purpose: "project-skill",
        kind: "file",
        ownershipClass: "install_projection",
        runtimeTarget: "openclaw",
        ...openclawIntegrity,
      });
      writeManifest(manifestPathFor("project", dir), manifest);

      const codexFile = path.join(dir, ".codex", "hooks", "managed.mjs");
      mkdirSync(path.dirname(codexFile), { recursive: true });
      writeFileSync(codexFile, "codex projection\n");
      const recorder = openRecorder({ scope: "project", repoRoot: dir });
      recorder.recordFile(codexFile, {
        category: CATEGORIES.E,
        source: "sync-runtimes",
        purpose: "project-hook",
        ownershipClass: "install_projection",
        runtimeTarget: "codex",
      });
      recorder.flush();

      const next = readManifest(manifestPathFor("project", dir));
      assert.equal(next.entries.some((entry) => entry.path === openclawFile), true);
      assert.equal(next.entries.some((entry) => entry.path === codexFile), true);
    });
  });

  test("concurrent recorders merge distinct writes and CAS rollback preserves the other writer", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "meta-kim-manifest-cas-"));
    try {
      const firstFile = path.join(dir, "first.mjs");
      const secondFile = path.join(dir, "second.mjs");
      writeFileSync(firstFile, "first\n");
      writeFileSync(secondFile, "second\n");
      const first = openRecorder({ scope: "project", repoRoot: dir });
      const second = openRecorder({ scope: "project", repoRoot: dir });
      first.recordFile(firstFile, {
        category: CATEGORIES.E,
        source: "sync-global-meta-theory",
        purpose: "first-writer",
      });
      second.recordFile(secondFile, {
        category: CATEGORIES.E,
        source: "sync-runtimes",
        purpose: "second-writer",
      });

      const [firstFlush, secondFlush] = await Promise.all([
        first.flush(),
        second.flush(),
      ]);
      assert.equal(firstFlush.ok, true, firstFlush.error);
      assert.equal(secondFlush.ok, true, secondFlush.error);
      const merged = readManifest(manifestPathFor("project", dir));
      assert.equal(merged.entries.length, 2);
      assert.equal(merged.entries.every((entry) => manifestFileEntryMatches(entry)), true);

      const rollback = await first.rollback();
      assert.equal(rollback.ok, true, rollback.error);
      const afterRollback = readManifest(manifestPathFor("project", dir));
      assert.deepEqual(
        afterRollback.entries.map((entry) => entry.path),
        [secondFile],
      );
      assert.equal(
        existsSync(`${manifestPathFor("project", dir)}.lock`),
        false,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rollback restores forgotten entries, removes promoted replacements, and preserves other writers", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "meta-kim-manifest-forget-rollback-"));
    try {
      const staleFile = path.join(dir, "stale-authority.mjs");
      const replacementFile = path.join(dir, "stable-authority.mjs");
      const concurrentFile = path.join(dir, "concurrent.mjs");
      const purpose = "projection-package:cli";
      writeFileSync(staleFile, "stale\n");
      writeFileSync(replacementFile, "stable\n");
      writeFileSync(concurrentFile, "concurrent\n");

      const seed = openRecorder({ scope: "project", repoRoot: dir });
      seed.recordFile(staleFile, {
        category: CATEGORIES.C,
        source: "sync-global-meta-theory",
        purpose,
      });
      assert.equal((await seed.flush()).ok, true);

      const replacement = openRecorder({ scope: "project", repoRoot: dir });
      replacement.forget(staleFile, purpose);
      replacement.recordFile(replacementFile, {
        category: CATEGORIES.C,
        source: "sync-global-meta-theory",
        purpose,
      });
      const promoted = await replacement.flush();
      assert.equal(promoted.ok, true, promoted.error);

      const otherWriter = openRecorder({ scope: "project", repoRoot: dir });
      otherWriter.recordFile(concurrentFile, {
        category: CATEGORIES.E,
        source: "sync-runtimes",
        purpose: "concurrent-writer",
      });
      assert.equal((await otherWriter.flush()).ok, true);

      const rolledBack = await replacement.rollback();
      assert.equal(rolledBack.ok, true, rolledBack.error);
      const restored = readManifest(manifestPathFor("project", dir));
      assert.equal(restored.entries.some((entry) => entry.path === staleFile), true);
      assert.equal(
        restored.entries.some((entry) => entry.path === replacementFile),
        false,
      );
      assert.equal(
        restored.entries.some((entry) => entry.path === concurrentFile),
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("forget rollback fails closed when another writer recreates the retired key", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "meta-kim-manifest-forget-rollback-cas-"));
    try {
      const staleFile = path.join(dir, "stale-authority.mjs");
      const purpose = "projection-package:cli";
      writeFileSync(staleFile, "stale\n");

      const seed = openRecorder({ scope: "project", repoRoot: dir });
      seed.recordFile(staleFile, {
        category: CATEGORIES.C,
        source: "sync-global-meta-theory",
        purpose,
      });
      assert.equal((await seed.flush()).ok, true);

      const retirement = openRecorder({ scope: "project", repoRoot: dir });
      retirement.forget(staleFile, purpose);
      assert.equal((await retirement.flush()).ok, true);

      writeFileSync(staleFile, "concurrent replacement\n");
      const concurrent = openRecorder({ scope: "project", repoRoot: dir });
      concurrent.recordFile(staleFile, {
        category: CATEGORIES.C,
        source: "sync-global-meta-theory",
        purpose,
      });
      assert.equal((await concurrent.flush()).ok, true);

      const rolledBack = await retirement.rollback();
      assert.equal(rolledBack.ok, false);
      assert.match(rolledBack.error, /entry changed concurrently/u);
      const retained = readManifest(manifestPathFor("project", dir));
      assert.equal(
        retained.entries.find((entry) => entry.path === staleFile)?.sha256,
        fileIntegritySync(staleFile).sha256,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stale same-key TOML appends fail closed and can be retried without losing either journal", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "meta-kim-manifest-toml-cas-"));
    try {
      const configPath = path.join(dir, ".codex", "config.toml");
      mkdirSync(path.dirname(configPath), { recursive: true });
      const options = {
        category: CATEGORIES.G,
        source: "sync-global-meta-theory",
        purpose: "codex-global-config-choice-surface-and-app-native-controls",
      };
      const original = [
        "[features]",
        "default_mode_request_user_input = false",
        "js_repl = true",
        "managed_alpha = false",
        "managed_beta = false",
        "",
      ].join("\n");
      const basePlan = planCodexAppNativeControls(original, {
        platformName: "linux",
      });
      writeFileSync(configPath, basePlan.text);
      const baseRecorder = openRecorder({ scope: "project", repoRoot: dir });
      baseRecorder.recordTomlFragmentMerge(
        configPath,
        basePlan.mutations,
        options,
      );
      const baseFlush = await baseRecorder.flush();
      assert.equal(baseFlush.ok, true, baseFlush.error);

      const first = openRecorder({ scope: "project", repoRoot: dir });
      const second = openRecorder({ scope: "project", repoRoot: dir });
      const alphaMutation = {
        kind: "replace",
        locator: { table: "features", key: "managed_alpha" },
        beforeFragment: "managed_alpha = false",
        afterFragment: "managed_alpha = true",
      };
      const betaMutation = {
        kind: "replace",
        locator: { table: "features", key: "managed_beta" },
        beforeFragment: "managed_beta = false",
        afterFragment: "managed_beta = true",
      };
      writeFileSync(
        configPath,
        basePlan.text
          .replace(alphaMutation.beforeFragment, alphaMutation.afterFragment)
          .replace(betaMutation.beforeFragment, betaMutation.afterFragment),
      );
      first.recordTomlFragmentMerge(configPath, [alphaMutation], options);
      second.recordTomlFragmentMerge(configPath, [betaMutation], options);

      const firstFlush = await first.flush();
      assert.equal(firstFlush.ok, true, firstFlush.error);
      const secondFlush = await second.flush();
      assert.equal(secondFlush.ok, false);
      assert.match(secondFlush.error, /entry changed concurrently/u);
      const afterConflict = readManifest(manifestPathFor("project", dir));
      const conflictLocators = afterConflict.entries[0].tomlMutationJournal.map(
        (mutation) => mutation.locator.key,
      );
      assert.ok(conflictLocators.includes("managed_alpha"));
      assert.equal(conflictLocators.includes("managed_beta"), false);

      const retry = openRecorder({ scope: "project", repoRoot: dir });
      retry.recordTomlFragmentMerge(configPath, [betaMutation], options);
      const retryFlush = await retry.flush();
      assert.equal(retryFlush.ok, true, retryFlush.error);
      const finalEntry = readManifest(
        manifestPathFor("project", dir),
      ).entries[0];
      assert.equal(
        invertCodexConfigMutations(
          readFileSync(configPath, "utf8"),
          finalEntry.tomlMutationJournal,
        ),
        original,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stale same-key forget cannot retire a concurrently upgraded TOML journal", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "meta-kim-manifest-forget-cas-"));
    try {
      const configPath = path.join(dir, ".codex", "config.toml");
      const manifestPath = manifestPathFor("project", dir);
      const purpose = "codex-global-config-choice-surface-and-app-native-controls";
      mkdirSync(path.dirname(configPath), { recursive: true });
      const original = [
        "[features]",
        "default_mode_request_user_input = false",
        "js_repl = true",
        "",
      ].join("\n");
      const planned = planCodexAppNativeControls(original, {
        platformName: "linux",
      });
      writeFileSync(configPath, planned.text);
      let legacyManifest = createEmpty({
        scope: "project",
        repoRoot: dir,
        metaKimVersion: "legacy",
      });
      legacyManifest = record(legacyManifest, {
        path: configPath,
        category: CATEGORIES.G,
        source: "sync-global-meta-theory",
        purpose,
        kind: "settings-merge",
        mergedHookCommands: ["default_mode_request_user_input"],
      });
      writeManifest(manifestPath, legacyManifest);

      const staleForget = openRecorder({ scope: "project", repoRoot: dir });
      const upgrade = openRecorder({ scope: "project", repoRoot: dir });
      staleForget.forget(configPath, purpose);
      upgrade.recordTomlFragmentMerge(configPath, planned.mutations, {
        category: CATEGORIES.G,
        source: "sync-global-meta-theory",
        purpose,
      });
      const upgradeFlush = await upgrade.flush();
      assert.equal(upgradeFlush.ok, true, upgradeFlush.error);

      const forgetFlush = await staleForget.flush();
      assert.equal(forgetFlush.ok, false);
      assert.match(forgetFlush.error, /entry changed concurrently/u);
      const retained = readManifest(manifestPath);
      assert.equal(retained.entries.length, 1);
      assert.equal(retained.entries[0].kind, "toml-fragment-merge");
      assert.equal(
        Object.hasOwn(retained.entries[0], "mergedHookCommands"),
        false,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stale crashed-writer lock is reclaimed from owner metadata", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "meta-kim-manifest-stale-lock-"));
    try {
      const managedFile = path.join(dir, "managed.mjs");
      writeFileSync(managedFile, "managed\n");
      const manifestPath = manifestPathFor("project", dir);
      mkdirSync(path.dirname(manifestPath), { recursive: true });
      const lockPath = `${manifestPath}.lock`;
      const staleDate = new Date(Date.now() - MANIFEST_LOCK_STALE_MS - 1000);
      writeFileSync(lockPath, `${JSON.stringify({
        schemaVersion: 1,
        token: "crashed-writer",
        pid: 2147483647,
        hostname: "unreachable-test-host",
        createdAt: staleDate.toISOString(),
      })}\n`);
      utimesSync(lockPath, staleDate, staleDate);

      const recorder = openRecorder({ scope: "project", repoRoot: dir });
      recorder.recordFile(managedFile, {
        category: CATEGORIES.E,
        source: "sync-runtimes",
        purpose: "stale-lock-recovery",
      });
      const result = await recorder.flush();
      assert.equal(result.ok, true, result.error);
      assert.equal(existsSync(lockPath), false);
      assert.equal(readManifest(manifestPath).entries.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("atomic manifest promotion retries transient Windows rename failures without residue", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "meta-kim-manifest-rename-"));
    try {
      const manifestPath = path.join(dir, "install-manifest.json");
      const manifest = createEmpty({ scope: "global", metaKimVersion: "x" });
      let attempts = 0;
      const updated = await writeManifestAtomic(manifestPath, manifest, {
        renameRetryAttempts: 4,
        wait: async () => {},
        renameFile(sourcePath, targetPath) {
          attempts += 1;
          if (attempts < 3) {
            const error = new Error("simulated Windows sharing violation");
            error.code = "EPERM";
            throw error;
          }
          renameSync(sourcePath, targetPath);
        },
      });
      assert.equal(attempts, 3);
      assert.equal(readManifest(manifestPath).updatedAt, updated.updatedAt);
      assert.deepEqual(
        readdirSync(dir).filter((name) => name.endsWith(".tmp")),
        [],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
