import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveExistingManagedProjectCandidates } from "../../scripts/existing-managed-projects.mjs";
import { buildI18N } from "../../config/i18n/setup-strings.mjs";
import { createProjectionPackageBoundary, STABLE_PROJECT_DEPLOYMENTS_ENV } from "../../src/infrastructure/installer/projection-package-boundary.mjs";

const declaredTargets = JSON.parse(readFileSync(new URL("../../config/sync.json", import.meta.url), "utf8")).supportedTargets;

function tempDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeManifest(root, activeTargets = ["claude"]) {
  const manifestPath = path.join(root, ".meta-kim", "state", "default", "project-bootstrap.json");
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: "meta-kim-project-bootstrap-v0.1",
    activeTargets,
    managedFiles: [{ relPath: ".claude/hooks/example.mjs", contentHash: "a".repeat(64) }],
  }, null, 2)}\n`);
}

test("valid projects continue while stale registry and invalid saved targets are reported", () => {
  const valid = tempDir("meta-kim-managed-valid-");
  const invalidTargets = tempDir("meta-kim-managed-invalid-targets-");
  const missing = path.join(os.tmpdir(), `meta-kim-missing-${Date.now()}`);
  try {
    writeManifest(valid, ["claude", "codex"]);
    writeManifest(invalidTargets, ["unsupported-runtime"]);
    const result = resolveExistingManagedProjectCandidates([
      { targetDir: valid, source: "saved_project_dirs" },
      { targetDir: missing, source: "project_registry" },
      { targetDir: invalidTargets, source: "saved_project_dirs" },
    ]);
    assert.deepEqual(result.deployments, [{ targetDir: path.resolve(valid), activeTargets: ["claude", "codex"], source: "saved_project_dirs" }]);
    assert.deepEqual(result.rejected.map(({ source, reason }) => ({ source, reason })), [
      { source: "project_registry", reason: "target_missing" },
      { source: "saved_project_dirs", reason: "invalid_active_targets" },
    ]);
  } finally {
    rmSync(valid, { recursive: true, force: true });
    rmSync(invalidTargets, { recursive: true, force: true });
  }
});

test("explicit invalid target is rejected and manifest Junction is never followed", () => {
  const explicit = tempDir("meta-kim-explicit-invalid-");
  const outside = tempDir("meta-kim-manifest-outside-");
  try {
    writeManifest(outside, ["codex"]);
    symlinkSync(path.join(outside, ".meta-kim"), path.join(explicit, ".meta-kim"), process.platform === "win32" ? "junction" : "dir");
    const result = resolveExistingManagedProjectCandidates([{ targetDir: explicit, source: "explicit_project_dirs" }]);
    assert.equal(result.deployments.length, 0);
    assert.deepEqual(result.rejected[0], { targetDir: path.resolve(explicit), source: "explicit_project_dirs", reason: "unsafe_manifest_path" });
  } finally {
    rmSync(explicit, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("an unmanaged current working directory is optional and produces no warning", () => {
  const cwd = tempDir("meta-kim-unmanaged-cwd-");
  try {
    assert.deepEqual(
      resolveExistingManagedProjectCandidates([{ targetDir: cwd, source: "current_working_directory" }]),
      { deployments: [], rejected: [] },
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("all four locales explain rejected targets and the repair action", () => {
  const locales = buildI18N({ MIN_NODE_VERSION: "20.0.0" });
  for (const locale of ["en", "zh-CN", "ja-JP", "ko-KR"]) {
    const copy = locales[locale];
    assert.equal(typeof copy.managedProjectRejectedHeading, "function");
    assert.equal(typeof copy.managedProjectRejectedDetail, "function");
    assert.ok(copy.managedProjectRejectedRepair.length > 20);
    assert.ok(copy.managedProjectRejectedReasons.invalid_active_targets);
    assert.ok(copy.managedProjectRejectedSources.explicit_project_dirs);
  }
  assert.match(locales.en.globalManagedProjectRefreshInfo(2), /This operation/);
  assert.doesNotMatch(locales.en.globalManagedProjectRefreshInfo(2), /This update/);
});

test("existing project refresh accepts every declared target and respects an explicit narrower scope", t => {
  const root = tempDir("meta-kim-managed-all-targets-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeManifest(root, declaredTargets);
  const candidate = { targetDir: root, source: "current_working_directory" };
  assert.deepEqual(resolveExistingManagedProjectCandidates([candidate]), {
    deployments: [{ ...candidate, activeTargets: declaredTargets }], rejected: [],
  });
  const restricted = resolveExistingManagedProjectCandidates([candidate], { supportedTargets: ["claude", "codex"] });
  assert.equal(restricted.deployments.length, 0);
  assert.equal(restricted.rejected[0].reason, "invalid_active_targets");
});

test("stable package handoff keeps all declared project targets and rejects a changed manifest", t => {
  const root = tempDir("meta-kim-managed-handoff-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeManifest(root, declaredTargets);
  const boundary = createProjectionPackageBoundary({
    packageRoot: path.resolve(import.meta.dirname, "../.."), callerCwd: root, homeRoot: root,
    env: { [STABLE_PROJECT_DEPLOYMENTS_ENV]: JSON.stringify([{ targetDir: root, activeTargets: declaredTargets }]) },
    managedProjectManifestRelPath: ".meta-kim/state/default/project-bootstrap.json",
    normalizeTargets: targets => [...new Set(targets ?? [])],
  });
  const authority = { packageRoot: path.join(root, "stable-package") };
  const resolution = boundary.readStableProjectDeploymentHandoff(authority);
  assert.equal(resolution.deployments.length, 1);
  assert.deepEqual(resolution.deployments[0].activeTargets, declaredTargets);
  writeManifest(root, ["claude"]);
  assert.throws(() => boundary.readStableProjectDeploymentHandoff(authority), /targets changed before execution/u);
});
