import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildProjectRef } from "../../scripts/project-registry.mjs";
import { buildLiveSnapshot } from "../../src/application/live/live-control-room-service.mjs";
import { liveTerminalStatusDisplay } from "../../src/application/live/live-status-vocabulary.mjs";
import { createLiveHubProjectCatalog } from "../../src/infrastructure/live/live-hub-project-catalog.mjs";

const OBSERVED_AT = "2026-09-01T10:01:00.000Z";
const RECORDED_OUTCOMES = ["partial", "superseded", "archived_legacy"];

function artifactWithStatus(runId, status) {
  return {
    schemaVersion: "governed-execution-v1",
    runId,
    status,
    updatedAt: "2026-09-01T10:00:00.000Z",
  };
}

function runDisplayFor(status) {
  const snapshot = buildLiveSnapshot({
    governedArtifact: artifactWithStatus(`meta-run-status-vocab-${status}`, status),
    observedAt: OBSERVED_AT,
  });
  return { displayState: snapshot.run.displayState, statusReason: snapshot.run.statusReason };
}

/**
 * The list surface and the detail surface read the same stored `status` through
 * two separate vocabularies. When only one of them knows a word, the same run
 * announces one outcome in the list and a different one once opened, which is a
 * worse failure than either answer alone: a reader cannot tell which surface to
 * believe. `partial` additionally has to survive the alias table, because an
 * alias is consulted before the vocabulary and silently rewrites the word.
 */
test("a run refused release, replaced, or archived from a legacy state keeps its own display state", () => {
  for (const status of RECORDED_OUTCOMES) {
    const { displayState } = runDisplayFor(status);
    assert.equal(
      displayState,
      status,
      `stored status ${status} must reach the detail surface instead of collapsing`,
    );
  }
});

test("each of the three outcomes states why, rather than sharing one sentence", () => {
  const reasons = RECORDED_OUTCOMES.map(
    (status) => runDisplayFor(status).statusReason,
  );
  for (const reason of reasons) {
    assert.equal(typeof reason, "string");
    assert.ok(reason.length > 0, "every display state owes the reader a reason");
    assert.doesNotMatch(
      reason,
      /现有记录不足以判断/u,
      "a recorded outcome must not be described as an absence of records",
    );
  }
  assert.equal(new Set(reasons).size, 3, "three distinct outcomes need three distinct sentences");
});

/**
 * A word absent from the vocabulary does not fail loudly: it falls through to
 * `unknown`, which is indistinguishable from a record that genuinely says
 * nothing. Keeping this assertion means the fallback still works for words the
 * system really has no opinion about, so widening the vocabulary above cannot be
 * mistaken for widening it to everything.
 */
test("a status the system has no opinion about still falls back to unknown", () => {
  const { displayState } = runDisplayFor("not_a_recorded_outcome");
  assert.equal(displayState, "unknown");
});

async function catalogSessionFor(t, status) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), `meta-kim-status-${status}-`));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const stateDir = path.join(projectRoot, ".meta-kim", "state", "default", "governed-executions");
  await mkdir(path.join(projectRoot, ".git"));
  await mkdir(stateDir, { recursive: true });
  const runId = `meta-run-vocab-${status}`;
  await writeFile(
    path.join(stateDir, `${runId}.json`),
    JSON.stringify(artifactWithStatus(runId, status)),
    "utf8",
  );

  const sessions = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [{
      projectRef: buildProjectRef({ repoPath: projectRoot }),
      repoRoot: projectRoot,
      displayName: path.basename(projectRoot),
      updatedAt: "2026-09-01T10:00:00.000Z",
    }],
    now: () => Date.parse(OBSERVED_AT),
  }).listSessions(buildProjectRef({ repoPath: projectRoot }));

  assert.equal(sessions.length, 1, "the fixture writes exactly one readable artifact");
  return sessions[0];
}

/**
 * The list and the detail panel each hold their own copy of this vocabulary, so a
 * word can be taught to one and not the other without anything failing. Comparing
 * the two constant tables would only prove they look alike; this compares what a
 * reader actually sees on both surfaces for the same file on disk, which stays
 * true however either surface chooses to store its words.
 */
test("the list and the detail panel describe the same record the same way", async (t) => {
  for (const status of RECORDED_OUTCOMES) {
    const shared = liveTerminalStatusDisplay(status);
    const session = await catalogSessionFor(t, status);
    const detail = runDisplayFor(status);
    assert.deepEqual(
      { displayState: session.displayState, statusReason: session.statusReason },
      shared,
      `the list surface drifted from the shared wording for ${status}`,
    );
    assert.deepEqual(
      detail,
      shared,
      `the detail surface drifted from the shared wording for ${status}`,
    );
  }
});

/**
 * `skipped` and `planned_not_executed` are words the runner really writes, and the
 * shared alias table rewrites both to `pending`. The list surface used to carry an
 * alias table without them, so a run whose record says plainly that it never ran
 * was described as one the system cannot judge — a claim about the records rather
 * than about the run. Both surfaces reading one alias table makes them agree on
 * the more accurate answer.
 */
test("a run recorded as never executed reads as unreported, not as unjudgeable", async (t) => {
  for (const status of ["skipped", "planned_not_executed"]) {
    const session = await catalogSessionFor(t, status);
    assert.equal(
      session.displayState,
      "unreported",
      `a record stating ${status} says the run did not execute, not that nothing is known`,
    );
    assert.doesNotMatch(
      session.statusReason,
      /现有记录不足以判断/u,
      `${status} is an exact record, so it must not be reported as an absence of records`,
    );
  }
});
