import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIsolatedUserHomeEnv } from "../../scripts/isolated-user-home-env.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

function sorted(values) {
  return [...values].sort();
}

test("install scope verification proves global/project target boundaries", () => {
  const callerHome = mkdtempSync(path.join(os.tmpdir(), "meta-kim-scope-caller-home-"));
  let summary;
  try {
    const result = spawnSync(process.execPath, ["scripts/verify-install-scope-matrix.mjs"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 720_000,
      windowsHide: true,
      env: buildIsolatedUserHomeEnv(callerHome),
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    summary = JSON.parse(result.stdout);
    assert.equal(
      existsSync(path.join(callerHome, ".meta-kim", "global", "project-registry.sqlite")),
      false,
      "verification project cases must not register temporary projects in the caller home",
    );
  } finally {
    rmSync(callerHome, { recursive: true, force: true });
  }
  assert.equal(summary.ok, true);
  assert.equal(summary.schemaVersion, "meta-kim-install-scope-verification-v0.1");
  assert.equal(summary.globalResults[0].status, "pass");
  assert.deepEqual(summary.classification.globalLayer.defaultTargets, ["claude", "codex"]);
  assert.deepEqual(summary.classification.projectLayer.defaultTargets, ["claude", "codex"]);
  assert.deepEqual(
    sorted(summary.classification.globalLayer.platformSupportTiers.formalProjectionTargets),
    ["claude", "codex", "cursor", "openclaw"],
  );
  assert.deepEqual(
    sorted(
      summary.classification.globalLayer.platformSupportTiers
        .nonDefaultFormalProjectionTargets,
    ),
    ["cursor", "openclaw"],
  );
  assert.deepEqual(
    sorted(summary.classification.globalLayer.platformSupportTiers.dependencyInstallTargets),
    ["antigravity", "codebuddy", "gemini", "joycode", "opencode", "qwen", "zed"],
  );
  assert.deepEqual(
    sorted(summary.classification.globalLayer.platformSupportTiers.candidateProbeTargets),
    ["cline", "continue", "kiro", "qoder", "roo-code", "trae", "windsurf"],
  );
  assert.match(
    summary.classification.globalLayer.platformSupportTiers.boundary,
    /formal Meta_Kim projection targets/,
  );

  const globalById = new Map(summary.globalResults.map((entry) => [entry.id, entry]));
  assert.equal(globalById.get("global-default-claude-codex").status, "pass");
  assert.equal(globalById.get("global-default-claude-codex").checks.cursorHomeUntouched, true);
  assert.equal(globalById.get("global-default-claude-codex").checks.openclawHomeUntouched, true);
  assert.equal(globalById.get("global-default-claude-codex").checks.codexGlobalHooksJson, true);
  assert.equal(globalById.get("global-all-formal-targets").status, "pass");
  assert.equal(globalById.get("global-all-formal-targets").checks.cursorSkill, true);
  assert.equal(globalById.get("global-all-formal-targets").checks.openclawSkill, true);
  assert.equal(globalById.get("global-all-formal-targets").checks.codexGlobalHooksJson, true);
  assert.equal(globalById.get("global-all-formal-targets").checks.cursorHomeUntouched, undefined);
  assert.equal(globalById.get("global-all-formal-targets").checks.openclawHomeUntouched, undefined);

  const byId = new Map(summary.projectResults.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("project-claude").status, "pass");
  assert.deepEqual(byId.get("project-claude").unexpectedPresent, []);
  assert.equal(byId.get("project-codex").status, "pass");
  assert.deepEqual(byId.get("project-codex").unexpectedPresent, []);
  assert.equal(byId.get("project-cursor").status, "pass");
  assert.equal(byId.get("project-openclaw").status, "pass");
  assert.equal(byId.get("project-default-claude-codex").status, "pass");
  assert.equal(byId.get("project-default-claude-codex").targetCreatedByDryRun, false);
  assert.equal(byId.get("project-default-claude-codex").postApplyDryRunStatus, "ready");
  assert.equal(byId.get("project-default-claude-codex").postApplyRequiresConfirmation, false);
  assert.equal(byId.get("project-default-claude-codex").postApplyPendingCount, 0);
  assert.equal(byId.get("project-default-claude-codex").postApplyProjectWrites, 0);
  assert.deepEqual(byId.get("project-default-claude-codex").manifestTargets, [
    "claude",
    "codex",
  ]);
  assert.deepEqual(byId.get("project-default-claude-codex").unexpectedPresent, []);
});
