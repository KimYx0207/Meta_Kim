import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  recordRepoProjectionDigests,
  REPO_PROJECTION_LEDGER_PATH,
} from "../../scripts/record-runtime-capability-evidence.mjs";
import { validateRuntimeEvidenceLedger } from "../../scripts/runtime-capability-evidence.mjs";

/**
 * The repo-projection observations bind a SHA-256 of the very scripts that render
 * each runtime projection, so editing one of those scripts invalidates the ledger
 * and every global sync exits non-zero until the digest is re-recorded. Keeping
 * that a manual chore means an ordinary source edit silently breaks install; the
 * recorder makes it an explicit maintainer action instead.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function committedLedger() {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, REPO_PROJECTION_LEDGER_PATH), "utf8"));
}

test("the committed ledger binds the current digest of every projection source", () => {
  const { issues } = validateRuntimeEvidenceLedger(committedLedger());
  assert.deepEqual(
    issues.filter((issue) => issue.includes("SHA-256")),
    [],
    "a stale projection digest blocks global sync with an opaque exit code",
  );
});

test("recording is a no-op once the ledger already matches the sources", () => {
  const { updates } = recordRepoProjectionDigests(committedLedger());
  assert.deepEqual(updates, []);
});

test("recording repairs a drifted digest and reports exactly what changed", () => {
  const ledger = committedLedger();
  const observation = ledger.observations.find((entry) => entry.observationClass === "repo_projection");
  const artifact = observation.sourceArtifacts.find((entry) => entry.path.endsWith(".mjs"));
  const original = artifact.sha256;
  artifact.sha256 = "0".repeat(64);

  const { ledger: recorded, updates } = recordRepoProjectionDigests(ledger);
  assert.deepEqual(updates, [
    { observationId: observation.id, path: artifact.path, from: "0".repeat(64), to: original },
  ]);

  const repaired = recorded.observations
    .find((entry) => entry.id === observation.id)
    .sourceArtifacts.find((entry) => entry.path === artifact.path);
  assert.equal(repaired.sha256, original);
  assert.equal(repaired.digestKind, "sha256");
});

test("recording does not mutate the ledger it was given", () => {
  const ledger = committedLedger();
  const before = JSON.stringify(ledger);
  recordRepoProjectionDigests(ledger);
  assert.equal(JSON.stringify(ledger), before);
});

test("recording refuses a source that does not resolve inside the repository", () => {
  const ledger = committedLedger();
  const observation = ledger.observations.find((entry) => entry.observationClass === "repo_projection");
  observation.sourceRefs = [...observation.sourceRefs, "../outside-the-repo.mjs"];

  assert.throws(
    () => recordRepoProjectionDigests(ledger),
    /outside-the-repo\.mjs/u,
    "a digest must never be invented for a path the validator would reject",
  );
});

test("recording adds a missing binding instead of leaving the source unproven", () => {
  const ledger = committedLedger();
  const observation = ledger.observations.find((entry) => entry.observationClass === "repo_projection");
  const dropped = observation.sourceArtifacts[0].path;
  observation.sourceArtifacts = observation.sourceArtifacts.filter((entry) => entry.path !== dropped);

  const { ledger: recorded, updates } = recordRepoProjectionDigests(ledger);
  assert.equal(updates.some((update) => update.path === dropped && update.from === null), true);
  assert.equal(
    recorded.observations
      .find((entry) => entry.id === observation.id)
      .sourceArtifacts.some((entry) => entry.path === dropped),
    true,
  );
});
