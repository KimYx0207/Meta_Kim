import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { directoryClosureSync } from "../../scripts/install-manifest.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

test("legacy runtime-purpose receipts remain installed only with an exact closure", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "meta-kim-dependency-lifecycle-"));
  const profile = `dependency-lifecycle-${path.basename(home)}`;
  const profileDir = path.join(repoRoot, ".meta-kim", "state", profile);
  try {
    const skillRoot = path.join(home, ".codex", "skills", "goalpro");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(path.join(skillRoot, "SKILL.md"), "---\nname: goalpro\ndescription: Managed fixture.\n---\n");
    const closure = directoryClosureSync(skillRoot);
    const manifestDir = path.join(home, ".meta-kim");
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(path.join(manifestDir, "install-manifest.json"), `${JSON.stringify({
      schemaVersion: 1,
      scope: "global",
      metaKimVersion: "3.0.3",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      entries: [{
        path: skillRoot,
        category: "A",
        source: "sync-global-meta-theory",
        purpose: "codex-global-skill",
        kind: "dir",
        installedAt: "2026-01-01T00:00:00.000Z",
        directoryClosureSha256: closure.sha256,
        directoryClosureEntryCount: closure.entryCount,
      }],
    }, null, 2)}\n`);

    const result = spawnSync(
      process.execPath,
      ["scripts/discover-dependency-capabilities.mjs", "--json", "--check"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          META_KIM_PROFILE: profile,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const index = JSON.parse(result.stdout);
    const provider = index.discoveredDependencyProjects.find((item) => item.id === "goalpro");
    assert.equal(provider.lifecycleState, "installed_provider");
    assert.equal(provider.ownershipReceipt.ownershipReceipt.purpose, "codex-global-skill");
    assert.equal(provider.ownershipReceipt.digest, closure.sha256);
    assert.doesNotMatch(JSON.stringify(index), new RegExp(home.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"));
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
