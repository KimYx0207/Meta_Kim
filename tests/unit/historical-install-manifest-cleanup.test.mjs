import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  classifyExactHistoricalHookSourceEntry,
  pruneExactHistoricalHookSourceEntries,
  selectExactHistoricalHookSourceEntries,
} from "../../scripts/historical-install-manifest-cleanup.mjs";

function entry(root, overrides = {}) {
  return {
    path: join(root, "meta-kim-hook-source-old", "claude", "hooks", "enforce.mjs"),
    category: "A",
    source: "sync-global-meta-theory",
    purpose: "claude-global-hook",
    runtimeTarget: "claude",
    ...overrides,
  };
}

test("selects only exact, missing historical hook-source test assets", () => {
  const root = mkdtempSync(join(tmpdir(), "meta-kim-manifest-selector-"));
  try {
    const manifest = {
      entries: [
        entry(root),
        entry(root, {
          path: join(root, "meta-kim-hook-source-old", "codex", "hooks", "pretool.mjs"),
          category: "B",
          source: "sync-runtimes",
          purpose: "codex-global-hooks-dir",
          runtimeTarget: "codex",
        }),
        entry(root, { purpose: "user-global-hook" }),
        entry(root, { source: "manual-edit" }),
        entry(root, { path: join(root, "user-created", "claude", "hooks", "keep.mjs") }),
        entry(root, { path: join(root, "meta-kim-hook-source-old", "windows", "hooks", "keep.mjs") }),
      ],
    };

    const selected = selectExactHistoricalHookSourceEntries(manifest, { tempRoot: root });
    assert.deepEqual(selected.map(({ index }) => index), [0, 1]);
    assert.equal(manifest.entries.length, 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves user drift and assets that still exist", () => {
  const root = mkdtempSync(join(tmpdir(), "meta-kim-manifest-preserve-"));
  try {
    const existingPath = join(root, "meta-kim-hook-source-old", "claude", "hooks", "enforce.mjs");
    mkdirSync(dirname(existingPath), { recursive: true });
    writeFileSync(existingPath, "user or recovered content\n", "utf8");

    const classification = classifyExactHistoricalHookSourceEntry(entry(root), { tempRoot: root });
    assert.equal(classification.matched, false);
    assert.equal(classification.reason, "path_still_exists_or_is_unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruning is pure and stable for repeated historical cleanup planning", () => {
  const root = mkdtempSync(join(tmpdir(), "meta-kim-manifest-pure-"));
  try {
    const manifest = {
      schemaVersion: 1,
      entries: [
        entry(root),
        entry(root, { path: join(root, "user-created", "keep.json"), source: "user" }),
      ],
    };
    const before = JSON.stringify(manifest);
    const first = pruneExactHistoricalHookSourceEntries(manifest, { tempRoot: root });
    const second = pruneExactHistoricalHookSourceEntries(manifest, { tempRoot: root });

    assert.equal(JSON.stringify(manifest), before);
    assert.equal(first.removedEntries.length, 1);
    assert.equal(first.manifest.entries.length, 1);
    assert.deepEqual(first.manifest, second.manifest);
    assert.deepEqual(first.removedEntries, second.removedEntries);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
