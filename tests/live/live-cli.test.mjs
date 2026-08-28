import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "bin", "meta-kim.mjs");

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
