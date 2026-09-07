import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  digestRepositorySource,
  repositorySourcePath,
} from "../../scripts/runtime-capability-evidence.mjs";
import {
  REFRESH_PINS_SCRIPT,
  RUNTIME_CAPABILITY_EVIDENCE_PATH,
  refreshRuntimeEvidencePins,
  renderRuntimeEvidenceLedger,
} from "../../scripts/refresh-runtime-evidence-pins.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The repo_projection pins are the only perishable part of the evidence
 * ledger: editing a pinned source silently invalidates the ledger. The
 * refresh command turns that into one official, reviewable action.
 *
 * Fixtures start from the committed ledger, then recompute every repo pin so
 * the test stays deterministic no matter which sources the working tree is
 * currently editing. Exactly one pin is then corrupted, and the command must
 * repair that pin and nothing else.
 */
function buildFixture(root, { corrupt } = {}) {
  const committed = JSON.parse(readFileSync(
    path.join(REPO_ROOT, RUNTIME_CAPABILITY_EVIDENCE_PATH),
    "utf8",
  ));
  const target = committed.observations.find((entry) =>
    entry.observationClass === "repo_projection" &&
    entry.sourceArtifacts.some((artifact) => artifact.path === corrupt),
  );
  assert.ok(target, `fixture must pin ${corrupt}`);
  for (const observation of committed.observations) {
    if (observation.observationClass !== "repo_projection") continue;
    for (const artifact of observation.sourceArtifacts) {
      const sourcePath = repositorySourcePath(artifact.path);
      assert.ok(sourcePath, `pinned source must resolve: ${artifact.path}`);
      artifact.sha256 = digestRepositorySource(sourcePath).toLowerCase();
    }
  }
  const corruptedBefore = target.sourceArtifacts.find(
    (artifact) => artifact.path === corrupt,
  );
  const originalSha256 = corruptedBefore.sha256;
  corruptedBefore.sha256 = "0".repeat(64);
  const fixturePath = path.join(root, "runtime-capability-evidence.json");
  writeFileSync(fixturePath, `${renderRuntimeEvidenceLedger(committed)}`, "utf8");
  return { fixturePath, committed, originalSha256, observationId: target.id };
}

function runRefresh(args) {
  return spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, REFRESH_PINS_SCRIPT), ...args],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 },
  );
}

test("refresh repairs a deliberately wrong pin and changes nothing else", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-pins-refresh-"));
  try {
    const { fixturePath, committed, originalSha256, observationId } =
      buildFixture(root, { corrupt: "setup.mjs" });
    const before = readFileSync(fixturePath, "utf8");

    const result = runRefresh(["--file", fixturePath]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(`${observationId}  setup\\.mjs  0{64} -> ${originalSha256}`));

    const after = readFileSync(fixturePath, "utf8");
    const parsedAfter = JSON.parse(after);

    // Structure and field order survive untouched; only the corrupted pin moved.
    const expectedLedger = structuredClone(committed);
    expectedLedger.observations
      .find((entry) => entry.id === observationId)
      .sourceArtifacts.find((artifact) => artifact.path === "setup.mjs").sha256 = originalSha256;
    assert.deepEqual(parsedAfter, expectedLedger);
    assert.equal(
      after,
      before.replaceAll("0".repeat(64), originalSha256),
      "the written file must differ from the input only in the repaired pin",
    );

    // --check is clean after a refresh.
    const check = runRefresh(["--file", fixturePath, "--check"]);
    assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
    assert.match(check.stdout, /pins are current/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--check reports drift without writing and exits 1", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-pins-check-"));
  try {
    const { fixturePath, observationId, originalSha256 } =
      buildFixture(root, { corrupt: "setup.mjs" });
    const before = readFileSync(fixturePath, "utf8");

    const check = runRefresh(["--file", fixturePath, "--check"]);
    assert.equal(check.status, 1, `${check.stdout}\n${check.stderr}`);
    assert.match(check.stdout, new RegExp(`${observationId}  setup\\.mjs  0{64} -> ${originalSha256}`));
    assert.equal(readFileSync(fixturePath, "utf8"), before, "--check must not write");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed JSON fails closed with a clear error and no partial write", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-pins-malformed-"));
  try {
    const fixturePath = path.join(root, "runtime-capability-evidence.json");
    const malformed = `{"observations": [ {"id": "x", oops\n`;
    writeFileSync(fixturePath, malformed, "utf8");

    for (const extraArgs of [[], ["--check"]]) {
      const result = runRefresh(["--file", fixturePath, ...extraArgs]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /is not valid JSON/u);
      assert.match(result.stderr, /nothing was written/iu);
      assert.equal(readFileSync(fixturePath, "utf8"), malformed);
      assert.equal(readdirSync(root).length, 1, "no temporary files may survive a failed run");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pinned source outside the repository allowlist fails closed", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-pins-allowlist-"));
  try {
    const { fixturePath, committed } = buildFixture(root, { corrupt: "setup.mjs" });
    committed.observations
      .find((entry) => entry.observationClass === "repo_projection")
      .sourceArtifacts.push({ path: "outside/allowlist.txt", digestKind: "sha256", sha256: "0".repeat(64) });
    writeFileSync(fixturePath, renderRuntimeEvidenceLedger(committed), "utf8");
    const before = readFileSync(fixturePath, "utf8");

    const result = runRefresh(["--file", fixturePath]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside the repository evidence allowlist/u);
    assert.equal(readFileSync(fixturePath, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-repo_projection observations never trigger a recompute", () => {
  const ledger = {
    observations: [
      {
        id: "official.docs.example",
        observationClass: "official_docs",
        sourceArtifacts: [
          { path: "setup.mjs", digestKind: "sha256", sha256: "0".repeat(64) },
        ],
      },
    ],
  };
  const { ledger: next, changes } = refreshRuntimeEvidencePins(ledger);
  assert.deepEqual(changes, []);
  assert.deepEqual(next, ledger);
});
