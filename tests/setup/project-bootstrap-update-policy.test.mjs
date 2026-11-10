import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { classifyProjectProjectionUpdate } from "../../scripts/project-bootstrap-update-policy.mjs";
import { buildIsolatedUserHomeEnv } from "../../scripts/isolated-user-home-env.mjs";
import { applyNativeSkillPaths, buildPortableSkillContent } from "../../scripts/native-runtime-projection.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const setupPath = path.join(repoRoot, "setup.mjs");
function codexSkillProjection() {
  const canonical = readFileSync(path.join(repoRoot, "canonical", "skills", "meta-theory", "SKILL.md"), "utf8");
  return Buffer.from(buildPortableSkillContent(applyNativeSkillPaths(canonical, "codex")));
}
const testUserHome = mkdtempSync(
  path.join(os.tmpdir(), "meta-kim-bootstrap-policy-home-"),
);

after(() => {
  rmSync(testUserHome, { recursive: true, force: true });
});

function runBootstrap(args, options = {}) {
  const { env: envOverrides, ...execOptions } = options;
  return execFileSync(process.execPath, [setupPath, ...args], {
    cwd: repoRoot,
    stdio: "pipe",
    ...execOptions,
    env: buildIsolatedUserHomeEnv(testUserHome, envOverrides),
  });
}

test("three-hash policy distinguishes managed merge/delta refresh, protected project copies, and unknown ownership", () => {
  const oldHash = "a".repeat(64);
  const newHash = "b".repeat(64);
  assert.equal(classifyProjectProjectionUpdate({ exists: true, currentHash: oldHash, sourceHash: newHash, previousManifestEntry: { contentHash: oldHash } }).action, "replace");
  assert.equal(classifyProjectProjectionUpdate({ exists: true, currentHash: "c".repeat(64), sourceHash: newHash, previousManifestEntry: { contentHash: oldHash } }).action, "conflict");
  assert.deepEqual(
    classifyProjectProjectionUpdate({
      exists: true,
      currentHash: "c".repeat(64),
      sourceHash: newHash,
      previousManifestEntry: { contentHash: oldHash },
      managedProjectionUpdate: "replace_with_transaction_backup",
    }),
    {
      action: "replace",
      ownership: "manifest_managed",
      reason: "managed_projection_merge_delta_refresh",
      oldInstalledHash: oldHash,
      localDriftBackedUp: true,
    },
  );
  assert.equal(classifyProjectProjectionUpdate({ exists: true, currentHash: oldHash, sourceHash: newHash, previousManifestEntry: null }).action, "conflict");
  assert.equal(classifyProjectProjectionUpdate({ exists: true, currentHash: oldHash, sourceHash: newHash, previousManifestEntry: { contentHash: oldHash }, protectedProjectCapability: true }).action, "unchanged");
});

test("real bootstrap writes the portable canonical projection and a meta-kim Junction blocks all outside writes", () => {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-bootstrap-content-"));
  const outsideRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-bootstrap-outside-"));
  try {
    runBootstrap(["--project-bootstrap", "--targets", "codex", "--project-dir", projectRoot, "--apply", "--json"]);
    assert.deepEqual(
      readFileSync(path.join(projectRoot, ".agents", "skills", "meta-theory", "SKILL.md")),
      codexSkillProjection(),
    );

    const blockedRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-bootstrap-junction-"));
    try {
      symlinkSync(outsideRoot, path.join(blockedRoot, ".meta-kim"), process.platform === "win32" ? "junction" : "dir");
      assert.throws(() => runBootstrap(["--project-bootstrap", "--targets", "codex", "--project-dir", blockedRoot, "--apply", "--json"]));
      assert.equal(existsSync(path.join(outsideRoot, "state")), false);
      assert.equal(existsSync(path.join(outsideRoot, "backups")), false);
      assert.equal(existsSync(path.join(outsideRoot, "transactions")), false);
    } finally {
      rmSync(blockedRoot, { recursive: true, force: true });
    }

    const linkedParent = mkdtempSync(path.join(os.tmpdir(), "meta-kim-bootstrap-parent-link-"));
    const linkedRoot = path.join(linkedParent, "linked-root");
    const linkedProject = path.join(linkedRoot, "new-project");
    try {
      symlinkSync(outsideRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
      assert.throws(() => runBootstrap(["--project-bootstrap", "--targets", "codex", "--project-dir", linkedProject, "--apply", "--json"]));
      assert.equal(existsSync(path.join(outsideRoot, "new-project")), false);
    } finally {
      rmSync(linkedParent, { recursive: true, force: true });
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test("configured merge/delta replaces a manifest-managed projection but preserves unknown and sedimented files", () => {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-bootstrap-conflict-"));
  try {
    runBootstrap(["--project-bootstrap", "--targets", "codex", "--project-dir", projectRoot, "--apply", "--json"]);
    const conflictPath = path.join(projectRoot, ".agents", "skills", "meta-theory", "SKILL.md");
    const repairPath = path.join(projectRoot, ".codex", "hooks", "project-root.mjs");
    const stalePath = path.join(projectRoot, ".codex", "skills", "stale", "SKILL.md");
    writeFileSync(conflictPath, "# user change\n", "utf8");
    rmSync(repairPath, { force: true });
    mkdirSync(path.dirname(stalePath), { recursive: true });
    writeFileSync(stalePath, "# stale\n", "utf8");
    const manifestPath = path.join(projectRoot, ".meta-kim", "state", "default", "project-bootstrap.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const staleHash = createHash("sha256").update(readFileSync(stalePath)).digest("hex");
    manifest.managedFiles.push({ relPath: ".codex/skills/stale/SKILL.md", contentHash: staleHash });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    runBootstrap(["--project-bootstrap", "--targets", "codex", "--project-dir", projectRoot, "--apply", "--json"]);
    assert.deepEqual(
      readFileSync(conflictPath),
      codexSkillProjection(),
      "manifest-managed projection must refresh to the current package source",
    );
    assert.equal(existsSync(repairPath), true, "missing managed file must be repaired in the same transaction");
    assert.equal(existsSync(stalePath), false, "exact manifest-owned stale residue must be retired");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
