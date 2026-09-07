import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as cleanRoom from "../../scripts/live-acceptance/run-clean-room-live-acceptance.mjs";
import { buildIsolatedUserHomeEnv } from "../../scripts/isolated-user-home-env.mjs";

const sourceWorkspace = path.resolve(import.meta.dirname, "../..");
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

test("real bootstrap keeps its source distinct from the project and is stable on the next dry-run", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-clean-room-project-source-"));
  const workspace = path.join(root, "project");
  const home = path.join(root, "home");
  mkdirSync(home);
  try {
    // The target starts with the same package guide, as a packed project copy
    // does. Bootstrap must read the fixed source, not its own edited output.
    const packageSeed = path.join(root, "package-seed");
    mkdirSync(packageSeed);
    cpSync(path.join(sourceWorkspace, "AGENTS.md"), path.join(packageSeed, "AGENTS.md"));
    cpSync(path.join(sourceWorkspace, "package.json"), path.join(packageSeed, "package.json"));
    await cleanRoom.copyCleanRoomProject({ sourceWorkspace: packageSeed, workspace });
    const copiedGuide = hash(path.join(workspace, "AGENTS.md"));
    await assert.rejects(cleanRoom.copyCleanRoomProject({ sourceWorkspace: packageSeed, workspace }), /already exists/u);
    assert.equal(hash(path.join(workspace, "AGENTS.md")), copiedGuide, "existing target must not be overwritten");
    const sourceBefore = hash(path.join(sourceWorkspace, "AGENTS.md"));
    const result = await cleanRoom.initializeCleanRoomProject({
      sourceWorkspace, workspace, runtimeTarget: "codex",
      env: buildIsolatedUserHomeEnv(home), timeoutMs: 120_000,
    });
    assert.equal(result.bootstrap.status, 0, `${result.bootstrap.stdout}\n${result.bootstrap.stderr}`);
    assert.equal(result.projectionVerification.status, 0, `${result.projectionVerification.stdout}\n${result.projectionVerification.stderr}`);
    assert.ok(result.projectionVerification.managedFileCount > 0);
    assert.equal(hash(path.join(sourceWorkspace, "AGENTS.md")), sourceBefore);
    const manifest = JSON.parse(readFileSync(path.join(workspace, ".meta-kim/state/default/project-bootstrap.json"), "utf8"));
    for (const file of manifest.managedFiles) assert.equal(hash(path.join(workspace, file.relPath)), file.contentHash, file.relPath);
    const repeated = await cleanRoom.initializeCleanRoomProject({
      sourceWorkspace, workspace, runtimeTarget: "codex",
      env: buildIsolatedUserHomeEnv(home), timeoutMs: 120_000,
    });
    assert.equal(repeated.bootstrap.status, 0, repeated.bootstrap.stderr);
    assert.equal(repeated.projectionVerification.status, 0, repeated.projectionVerification.stderr);
    assert.equal(hash(path.join(sourceWorkspace, "AGENTS.md")), sourceBefore);
    t.diagnostic(`real bootstrap apply/dry-run twice: pending=0; managedFiles=${manifest.managedFiles.length}; source AGENTS unchanged`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
