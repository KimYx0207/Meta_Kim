import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";

import {
  CATEGORIES,
  CATEGORY_LABELS,
  SCHEMA_VERSION,
  createEmpty,
  listByCategory,
  manifestPathFor,
  readManifest,
  record,
  removeByPath,
  validate,
  writeManifest,
} from "../../scripts/install-manifest.mjs";

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
});
