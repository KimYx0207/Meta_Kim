import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { liveSelectionForRegistration, liveCurrentRunPresentation } from "../../scripts/meta-kim-live.mjs";
import { detectProjectRegistryEntry, joinProjectRegistry } from "../../scripts/project-registry.mjs";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "bin", "meta-kim.mjs");

test("an unavailable native turn never labels or automatically opens a historical project view as the current task", () => {
  const projectLink = "http://127.0.0.1:4331/?projectId=project-current";
  const waiting = liveCurrentRunPresentation({ nativeBinding: { threadId: "11111111-1111-4111-8111-111111111111" }, deepLink: projectLink });
  assert.equal(waiting.currentRunState, "awaiting_native_turn");
  assert.equal(waiting.currentTaskLink, null);
  assert.equal(waiting.autoOpenAllowed, false);
  assert.match(waiting.notice, /当前任务链接暂不可用/u);
  const explicit = liveCurrentRunPresentation({ runId: "meta-current", deepLink: projectLink + "&runId=meta-current" });
  assert.equal(explicit.currentRunState, "selected");
  assert.equal(explicit.currentTaskLink, projectLink + "&runId=meta-current");
  assert.equal(explicit.autoOpenAllowed, true);
  assert.equal(liveCurrentRunPresentation({ deepLink: projectLink }).currentRunState, "not_requested");
});

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

test("live CLI is discoverable and describes its read-only loopback boundary", () => {
  const rootHelp = runCli(["--help"]);
  assert.equal(rootHelp.status, 0, rootHelp.stderr);
  assert.match(rootHelp.stdout, /meta-kim live/u);
  assert.match(rootHelp.stdout, /--profile <name>/u);

  const liveHelp = runCli(["live", "--help"]);
  assert.equal(liveHelp.status, 0, liveHelp.stderr);
  assert.match(liveHelp.stdout, /loopback|127\.0\.0\.1/iu);
  assert.match(liveHelp.stdout, /read-only/iu);
  assert.match(liveHelp.stdout, /--no-open/u);
  assert.match(liveHelp.stdout, /--enable-control/u);
  assert.match(liveHelp.stdout, /plan-only|control|risk/iu);
});

test("live CLI rejects an invalid port without starting a server", () => {
  const result = runCli(["live", "--port", "not-a-port"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /port/iu);
});

test("Live selection keeps project and run for newly joined and already known registrations", () => {
  const projectRef = "project-a1b2c3d4e5f6";
  const runId = "meta-run-selection";
  for (const registration of [
    { registryStatus: "joined", known: true, projectRef },
    { registryStatus: "known", known: true, projectRef },
  ]) {
    assert.deepEqual(liveSelectionForRegistration(registration, runId), { projectRef, runId });
    assert.deepEqual(liveSelectionForRegistration(registration), { projectRef, runId: null });
  }
});

test("Live selection does not trust skipped, undecided, absent, or contradictory registrations", () => {
  const projectRef = "project-a1b2c3d4e5f6";
  const unavailable = { projectRef: null, runId: null };
  for (const registryStatus of ["skipped", "prompt_join", "not_applicable", "unknown", "", undefined]) {
    for (const known of [true, false, undefined]) {
      assert.deepEqual(liveSelectionForRegistration({ registryStatus, known, projectRef }, "meta-run-selection"), unavailable);
    }
  }
  for (const registration of [null, undefined, {}, { registryStatus: "known", known: false, projectRef }, { registryStatus: "known", projectRef }]) {
    assert.deepEqual(liveSelectionForRegistration(registration, "meta-run-selection"), unavailable);
  }
});

test("an existing joined registry row retains the same Live deep-link selection after detection", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-live-selection-"));
  try {
    const repoPath = path.join(homeDir, "existing-project");
    const joined = await joinProjectRegistry({ homeDir, repoPath, runtimeFamily: "codex", sourceRef: "live-selection-test" });
    const detected = await detectProjectRegistryEntry({ homeDir, repoPath, runtimeFamily: "codex" });
    assert.equal(joined.registryStatus, "joined");
    assert.equal(detected.registryStatus, "known");
    assert.equal(detected.known, true);
    const expected = { projectRef: joined.projectRef, runId: "meta-run-existing-project" };
    assert.deepEqual(liveSelectionForRegistration(joined, expected.runId), expected);
    assert.deepEqual(liveSelectionForRegistration(detected, expected.runId), expected);
    assert.deepEqual(await detectProjectRegistryEntry({ homeDir, repoPath, runtimeFamily: "codex" }), detected, "selection never rewrites registry status");
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("published package closes over every Live source layer", () => {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  for (const entry of [
    "src/domain/live/live-continuation-command.mjs",
    "src/domain/live/live-share-artifact.mjs",
    "src/application/live/build-live-share-artifact.mjs",
    "src/application/live/live-control-room-service.mjs",
    "src/application/live/plan-live-continuation.mjs",
    "src/infrastructure/live/live-continuation-command-store.mjs",
    "src/infrastructure/live/live-control-room-server.mjs",
    "src/infrastructure/live/live-hub-lifecycle.mjs",
    "src/infrastructure/live/live-hub-project-catalog.mjs",
    "src/infrastructure/live/live-read-repository.mjs",
    "src/infrastructure/live/live-runtime-adapter-registry.mjs",
    "src/presentation/live/live-control-room-page.mjs",
    "src/presentation/live/render-live-share-card.mjs",
    "src/sdk/live/common.mjs",
    "src/sdk/live/evidence-card.mjs",
    "src/sdk/live/index.mjs",
    "src/sdk/live/replay-theme.mjs",
    "src/sdk/live/runtime-adapter.mjs",
  ]) {
    assert.ok(packageJson.files.includes(entry), `missing package file entry: ${entry}`);
  }
});
