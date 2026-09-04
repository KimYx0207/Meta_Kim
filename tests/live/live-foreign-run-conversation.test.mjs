import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildProjectRef } from "../../scripts/project-registry.mjs";
import { buildLiveCompactProjection } from "../../src/application/live/live-control-room-service.mjs";
import { createLiveHubProjectCatalog } from "../../src/infrastructure/live/live-hub-project-catalog.mjs";

/**
 * One question — "which run does this chat reference name?" — answered by two
 * readers with different key lists and different tolerance for a malformed value.
 *
 * The session list and the run panel both read a run's `sourceConversation`. The
 * run panel used to resolve the reference's run id through the live run-id format
 * gate over three key names; the session list read two raw paths and accepted
 * whatever string it found. Where the two readers disagreed, one surface said 未关联
 * and the other said 已确认 for one file on disk, and neither was reporting a
 * different fact — they were reporting different readers. Both now go through
 * `conversationRecordRunId`, and the guards below hold that single reader's key
 * list and tolerance in place.
 *
 * Each guard below was proved load-bearing by deleting the code it covers and
 * measuring which tests turn red:
 *
 * - Neutering the service's foreign-run branch (`else` -> `if (false)`) reds all
 *   four tests here and no basis test. Every case in this file sits downstream of
 *   that one branch, which is why tests 3 and 4 need their own mutations to earn
 *   their place rather than riding along on it.
 * - Dropping `governedRunId` from `CONVERSATION_RUN_ID_PATHS` reds only test 3,
 *   on its first assertion: both readers then read past the alias, the reference
 *   reads as unclaimed, and unclaimed is the one shape that reads as confirmed.
 *   This replaces an earlier claim here about reverting the catalog to a narrower
 *   `sourceRunId(source)` reader, which named a mutation site that no longer
 *   exists — the two readers now share one key list, so the divergence this test
 *   was written against can only be reintroduced in that list.
 * - Re-adding a format gate inside `conversationRecordRunId` reds only test 4.
 *   Measured, not reasoned: 548 tests, 1 red, and it is this file's fourth.
 * - Deleting the verifying/unproven clamp in `conversationMatchBasisFor` reds
 *   test 2 together with `live-conversation-match-basis.test.mjs`'s "a candidate
 *   link cannot borrow a verifying basis from its stored record". No mutation
 *   reds test 2 alone, and that overlap is kept deliberately: this file's path is
 *   the one a producer reaches today — the activation hook writes
 *   `sourceConversation.matchBasis`, and 3 real records on this repository carry
 *   `transcript_file_verified` — while the basis test covers the candidate-array
 *   path, which measured 0 producers of 5413 records.
 */

const RUN_ID = "meta-run-foreign-ref";

function artifactWithSource(source) {
  return {
    schemaVersion: "governed-execution-v1",
    runId: RUN_ID,
    status: "running",
    updatedAt: "2026-09-02T10:00:00.000Z",
    sourceRuntime: "claude",
    sourceConversation: { runtime: "claude", ...source },
  };
}

async function catalogSessionFor(t, artifact) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "meta-kim-foreign-ref-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(path.join(projectRoot, ".git"), { recursive: true });
  const executionRoot = path.join(projectRoot, ".meta-kim", "state", "default", "governed-executions");
  await mkdir(executionRoot, { recursive: true });
  await writeFile(path.join(executionRoot, `${RUN_ID}.json`), JSON.stringify(artifact), "utf8");

  const projectRef = buildProjectRef({ repoPath: projectRoot });
  const sessions = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [{
      projectRef,
      repoRoot: projectRoot,
      displayName: path.basename(projectRoot),
      updatedAt: "2026-09-02T10:00:00.000Z",
    }],
    now: () => Date.parse("2026-09-02T10:01:00.000Z"),
  }).listSessions(projectRef);

  const session = sessions.find((item) => item.runId === RUN_ID);
  assert.ok(session, "the catalog must see the artifact, or every comparison below is vacuous");
  return session;
}

test("a chat reference naming another run is shown as a candidate, not dropped", async (t) => {
  const artifact = artifactWithSource({
    conversationId: "b5799d00-ef7a-4882-818d-d9053cacba71",
    runId: "meta-run-someone-elses-work",
  });

  const service = buildLiveCompactProjection(artifact).run;
  const session = await catalogSessionFor(t, artifact);

  assert.equal(
    service.candidateLinks.length,
    1,
    "the run panel dropped the reference with no refusal reason, so the panel reports 未关联 for a chat id the record plainly carries",
  );
  assert.equal(
    service.candidateLinks[0].matchBasis,
    "foreign_run_metadata_candidate",
    "a reference whose own run id names a different run is exactly this basis, and the weaker generic label loses why it is only a candidate",
  );
  assert.equal(service.verifiedLinks.length, 0, "a reference belonging to another run must not read as confirmed");
  assert.equal(service.conversationLinkState, "candidate");

  assert.deepEqual(
    { state: session.conversationLinkState, verified: session.verifiedLinks.length, candidates: session.candidateLinks.length },
    { state: service.conversationLinkState, verified: service.verifiedLinks.length, candidates: service.candidateLinks.length },
    "the list row and the run panel read one file, so a reference present in one and absent from the other is a reader difference reported as a fact",
  );
  assert.equal(
    session.candidateLinks[0].matchBasis,
    service.candidateLinks[0].matchBasis,
    "both surfaces must name the same reason the link is only a candidate",
  );
});

test("a stored verified basis does not travel onto another run's reference", async (t) => {
  const artifact = artifactWithSource({
    conversationId: "b5799d00-ef7a-4882-818d-d9053cacba71",
    runId: "meta-run-someone-elses-work",
    matchBasis: "transcript_file_verified",
  });

  const service = buildLiveCompactProjection(artifact).run;
  const session = await catalogSessionFor(t, artifact);

  assert.equal(service.candidateLinks.length, 1, "the reference must survive, or the assertion below is vacuous");
  assert.equal(
    service.candidateLinks[0].matchBasis,
    "foreign_run_metadata_candidate",
    "the transcript was opened and matched for a different run, so forwarding that standing here would claim this run was proven when nothing about it was",
  );
  assert.equal(
    session.candidateLinks[0].matchBasis,
    service.candidateLinks[0].matchBasis,
    "one file, one answer",
  );
});

test("both surfaces read the same key when a reference names its run", async (t) => {
  // The divergence this was written against: the run panel resolved the reference
  // over `runId`, `governedRunId`, and `sessionRunId` while the session list read
  // `runId` and `run.runId`, so a record using the governed alias was foreign to
  // one reader and unclaimed by the other — and "unclaimed" is what promotes it to
  // confirmed. Both readers now share `CONVERSATION_RUN_ID_PATHS`, so the guard
  // holds the key list itself: drop the alias from it and the first assertion below
  // goes red.
  //
  // No producer writes this shape today: both writers of `governedRunId` put it
  // in a delivery-bundle lifecycle record and a clean-room acceptance result,
  // neither of which is a chat reference. The key is still load-bearing, because
  // the shared reader lists it as a name it will honour — a key treated as
  // meaningful in one place and read past in another is the divergence, whether or
  // not a writer has reached it yet.
  const artifact = artifactWithSource({
    conversationId: "b5799d00-ef7a-4882-818d-d9053cacba71",
    governedRunId: "meta-run-someone-elses-work",
  });

  const service = buildLiveCompactProjection(artifact).run;
  const session = await catalogSessionFor(t, artifact);

  assert.equal(
    session.verifiedLinks.length,
    0,
    "the session row read past the alias and presented another run's chat as this run's confirmed chat",
  );
  assert.deepEqual(
    { state: session.conversationLinkState, verified: session.verifiedLinks.length, candidates: session.candidateLinks.length },
    { state: service.conversationLinkState, verified: service.verifiedLinks.length, candidates: service.candidateLinks.length },
    "the two readers disagree about which run this reference names, and the surfaces report that as two different facts",
  );
});

test("a malformed run id is still a claim that the reference belongs elsewhere", async (t) => {
  // The run panel used to resolve the reference's run id through the live run-id
  // format gate, so a value that did not match the pattern came back as no value at
  // all — indistinguishable from a record that never named a run, which is the one
  // case that reads as confirmed. The shared reader accepts any non-empty string,
  // and re-adding a format gate inside it reds this test and only this test.
  const artifact = artifactWithSource({
    conversationId: "b5799d00-ef7a-4882-818d-d9053cacba71",
    runId: "not a run id",
  });

  const service = buildLiveCompactProjection(artifact).run;
  const session = await catalogSessionFor(t, artifact);

  assert.equal(
    service.verifiedLinks.length,
    0,
    "an unparseable run id was treated as an absent one, so a reference that declares it belongs elsewhere reads as this run's confirmed chat",
  );
  assert.deepEqual(
    { state: session.conversationLinkState, verified: session.verifiedLinks.length, candidates: session.candidateLinks.length },
    { state: service.conversationLinkState, verified: service.verifiedLinks.length, candidates: service.candidateLinks.length },
    "one reader accepted the malformed value as a foreign claim and the other discarded it, so the same file reads confirmed on one surface and candidate on the other",
  );
});
