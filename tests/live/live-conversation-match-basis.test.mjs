import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CONVERSATION_BINDING_MATCH_BASIS } from "../../canonical/runtime-assets/shared/hooks/conversation-binding.mjs";
import { buildProjectRef } from "../../scripts/project-registry.mjs";
import {
  LIVE_COMPACT_PROJECTION_SCHEMA_VERSION,
  buildLiveCompactProjection,
  buildLiveSnapshot,
} from "../../src/application/live/live-control-room-service.mjs";
import { createLiveHubProjectCatalog } from "../../src/infrastructure/live/live-hub-project-catalog.mjs";
import { createLiveReadRepository } from "../../src/infrastructure/live/live-read-repository.mjs";
import {
  CONVERSATION_MATCH_BASIS,
  conversationLinkRecordView,
  conversationMatchBasisFor,
  conversationMatchBasisRank,
  declaredLinkPlacementForRun,
  normalizeConversationMatchBasis,
} from "../../src/application/live/live-conversation-link-vocabulary.mjs";

/**
 * `matchBasis` answers "how do we know this run belongs to this chat", and it is
 * the only field the binding consumer reads before it refuses to bind
 * (`scripts/governed-execution/host-runtime-provenance.mjs`). It was decided at
 * twelve separate sites across three files, each with a hand-written literal, and
 * the two files did not even use the same words for the same situation.
 *
 * Measured on this repository's own state tree before the change: 5413 records
 * scanned, 3 carried a basis, and all 3 carried `transcript_file_verified` — the
 * value the activation hook writes after it opens the transcript file and matches
 * its identity. Zero records carried any of the six values the display layer
 * emits. Those six exist only as computed output, so the display layer was the
 * only thing deciding provenance, and it decided it by literal.
 *
 * Each guard below records the mutation that reds it. Two of them do not red
 * alone under any mutation, and say so where they stand rather than leaving a
 * reader to assume every green line here is load-bearing.
 */

const REAL_RUN_ID = "meta-run-basis-fixture";
const REAL_CONVERSATION_REF = "b5799d00-ef7a-4882-818d-d9053cacba71";

function artifactWithSourceBasis(matchBasis) {
  return {
    schemaVersion: "governed-execution-v1",
    runId: REAL_RUN_ID,
    status: "running",
    updatedAt: "2026-09-02T10:00:00.000Z",
    sourceRuntime: "claude",
    sourceConversation: {
      runtime: "claude",
      conversationId: REAL_CONVERSATION_REF,
      runId: REAL_RUN_ID,
      ...(matchBasis ? { matchBasis } : {}),
    },
  };
}

test("the basis a run proved on disk survives into its own projection", () => {
  // The paired files this was measured on: the governed artifact for
  // meta-run-75d5dda68ae2-mtjumim7 carried `transcript_file_verified`, and the
  // `.live.json` derived from it carried `exact_metadata`. One run, one chat, two
  // provenance claims on disk, and the stored one was the stronger of the two.
  //
  // Load-bearing, but not alone: replacing the forwarded basis at the
  // `sourceConversation` site with the literal `"exact_metadata"` it used to be
  // reds this and the last two tests together, because all three read that one
  // producer. A coarse mutation redding three guards proves the producer is live,
  // not that each guard carries weight. This one earns its place by failing first
  // and naming the shortest path, not by covering a mutation the others miss.
  const projection = buildLiveCompactProjection(artifactWithSourceBasis("transcript_file_verified"));

  assert.equal(projection.run.verifiedLinks.length, 1, "the fixture must produce a link at all, or the basis assertion below is vacuous");
  assert.equal(
    projection.run.verifiedLinks[0].matchBasis,
    "transcript_file_verified",
    "the hook opened the transcript file and matched its identity; overwriting that with a metadata-only literal loses the only verified provenance the system has",
  );
  // Not independently load-bearing, and kept as a shape guard: `run` and
  // `session` both spread one `conversationLinkProjection` result, so no mutation
  // can red this line while the one above stays green. It fails the day someone
  // computes the two halves separately, which is how they came to disagree in the
  // first place.
  assert.equal(
    projection.session.verifiedLinks[0].matchBasis,
    "transcript_file_verified",
    "the run header and the session row read different halves of one file, so a basis on only one of them puts them on different answers",
  );
});

test("a stored basis weaker than the evidence at hand does not win", () => {
  // The other direction, and the reason blanket forwarding is wrong. This
  // fixture's own declared basis is `exact_metadata`, but the record's run id
  // equals the run's, which is a stronger fact than "the metadata matched".
  // Forwarding here would be a downgrade written by a passthrough layer.
  //
  // Reds alone when `conversationMatchBasisFor` returns the stored value
  // unconditionally, i.e. when the rank comparison is dropped for blanket
  // forwarding.
  const artifact = {
    ...artifactWithSourceBasis(null),
    conversationLinks: [{
      runId: REAL_RUN_ID,
      conversationRef: "session:declared-weaker",
      sourceRuntime: "claude",
      verified: true,
      matchBasis: "exact_metadata",
    }],
  };
  const projection = buildLiveCompactProjection(artifact);
  const link = projection.run.verifiedLinks.find((item) => item.conversationRef === "session:declared-weaker");

  assert.ok(link, "the declared link must survive, or the assertion below tests nothing");
  assert.equal(
    link.matchBasis,
    "exact_run_id",
    "the record's run id matching this run is a stronger fact than its own weaker stored label",
  );
});

test("a candidate link cannot borrow a verifying basis from its stored record", () => {
  // No producer in this repository writes a basis into a candidate array today —
  // measured 0 of 5413 records. This closes the trap before a writer opens it:
  // position in the candidate array is the declaration that nothing was proven,
  // and a candidate labelled `transcript_file_verified` contradicts the array it
  // is stored in. A reader resolves that contradiction by trusting the label.
  //
  // Reds alone when the verifying/unproven clamp inside
  // `conversationMatchBasisFor` is deleted.
  const artifact = {
    ...artifactWithSourceBasis(null),
    conversationCandidates: [{
      conversationRef: "session:borrowed-standing",
      sourceRuntime: "claude",
      matchBasis: "transcript_file_verified",
    }],
  };
  const projection = buildLiveCompactProjection(artifact);
  const link = projection.run.candidateLinks.find((item) => item.conversationRef === "session:borrowed-standing");

  assert.ok(link, "the candidate must survive, or the assertion below tests nothing");
  assert.notEqual(
    link.matchBasis,
    "transcript_file_verified",
    "an unproven candidate must not present itself with the basis reserved for a transcript that was actually opened",
  );
});

test("an unknown stored basis falls back instead of reaching a reader", () => {
  assert.equal(normalizeConversationMatchBasis("transcript_file_verified"), "transcript_file_verified");
  assert.equal(normalizeConversationMatchBasis("a_basis_from_a_newer_build"), null);
  assert.equal(normalizeConversationMatchBasis(""), null);
  assert.equal(normalizeConversationMatchBasis(null), null);
  assert.equal(normalizeConversationMatchBasis({ matchBasis: "exact_run_id" }), null);
  assert.equal(normalizeConversationMatchBasis(["exact_run_id"]), null);

  // An unknown value must rank below every known one rather than compare as
  // equal. Ranking it as unknown-but-equal would let it survive a max() against
  // a real basis and print a raw enum at a reader.
  //
  // Reds alone when the unknown rank is moved to the strong end of the scale.
  for (const known of CONVERSATION_MATCH_BASIS) {
    assert.ok(
      conversationMatchBasisRank("a_basis_from_a_newer_build") > conversationMatchBasisRank(known),
      `an unknown basis must rank weaker than ${known}`,
    );
  }
  assert.equal(
    conversationMatchBasisFor("a_basis_from_a_newer_build", "metadata_candidate"),
    "metadata_candidate",
    "an unrecognised stored value must not be forwarded to a reader",
  );
});

test("the display vocabulary can read the one basis the activation hook writes", () => {
  // Two hand-kept lists drift, and this pair drifts silently: a basis the hook
  // writes but this list omits normalizes to null, falls back to a weaker
  // literal, and reads as "we only matched metadata" — the same output as a run
  // whose transcript was never opened.
  //
  // No mutation inside `src/` reds this one: it watches a value defined in
  // `canonical/`, which this suite does not own and cannot break from here. It is
  // a tripwire on the other file, not evidence about this one, and its two rank
  // lines overlap with the ordering the tests above already exercise.
  assert.ok(
    CONVERSATION_MATCH_BASIS.length >= 6,
    "an empty or truncated vocabulary would make every comparison here vacuous",
  );
  assert.ok(
    CONVERSATION_MATCH_BASIS.includes(CONVERSATION_BINDING_MATCH_BASIS),
    "the basis a real successful binding records must be readable by the surface that displays it",
  );
  assert.ok(
    conversationMatchBasisRank(CONVERSATION_BINDING_MATCH_BASIS) < conversationMatchBasisRank("exact_metadata"),
    "opening the transcript file and matching its identity is a stronger fact than the run record naming a chat",
  );
  assert.ok(
    conversationMatchBasisRank("exact_run_id") < conversationMatchBasisRank("exact_metadata"),
    "a link whose own run id equals this run's is a stronger fact than metadata alone",
  );
});

test("the basis survives into the compact record and back out of it", async (t) => {
  // This is the file the wrong value was actually observed in. Raw artifact reads
  // are capped, so for a run past the cap the compact projection is the only
  // record left — the basis has to survive being written into it and read back,
  // not just survive the pass that builds it.
  //
  // Load-bearing, and measured, but never alone. Two mutations red it, and each
  // takes something else down with it. Putting `exact_metadata` at the front of the
  // vocabulary reds this on its basis line, along with the two rank guards above
  // that state the order directly. Deleting the `linkState === "verified"` read
  // from `declaredLinkPlacementForRun` reds this on its vacuity line — the
  // compact's entries carry no per-entry verified flag, so that stamp is the only
  // thing keeping them out of the candidate array — and reds the self-read guard
  // below at the same time.
  //
  // Recorded because it was wrong here before: restoring the catalog's old
  // positional ladder at the `conversationLinks` branch does *not* red this one.
  // The measurement is in that mutation's own log — this fixture's stored basis is
  // `transcript_file_verified`, which outranks anything the ladder derives, so the
  // rank comparison keeps it and this stays green while only the self-read guard
  // below fails.
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "meta-kim-basis-compact-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(path.join(projectRoot, ".git"), { recursive: true });
  const executionRoot = path.join(projectRoot, ".meta-kim", "state", "default", "governed-executions");
  await mkdir(executionRoot, { recursive: true });

  const compact = buildLiveCompactProjection(artifactWithSourceBasis("transcript_file_verified"));
  await writeFile(path.join(executionRoot, `${REAL_RUN_ID}.live.json`), JSON.stringify(compact), "utf8");

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

  const session = sessions.find((item) => item.runId === REAL_RUN_ID);
  assert.ok(session, "the compact-only run must be readable, or the assertion below is vacuous");
  assert.equal(session.verifiedLinks.length, 1, "the compact's own link must survive the read, or the assertion below is vacuous");
  assert.equal(
    session.verifiedLinks[0].matchBasis,
    "transcript_file_verified",
    "a run past the raw read cap has only this file left, so a basis lost on the way in or out is lost for good",
  );
});

test("both derivations name the same basis for one artifact in hand", async (t) => {
  // The session list and the run panel are built by different files. They each
  // decided this field with their own literals, and they did not share a
  // vocabulary: one called a foreign-run link `foreign_run_metadata_candidate`
  // and the other had no word for it at all. Same artifact, two answers.
  //
  // Scope, because the name used to overclaim: this hands the service the artifact
  // directly, so it compares the two *derivations* on one input. It does not
  // compare the two *read chains* — the panel's real entrypoint is
  // `createLiveReadRepository.readArtifact`, which this never calls, and which
  // opens `<id>.live.json` before `<id>.json`. Whether the two surfaces open the
  // same file at all is a separate question, owned by the two read-chain guards at
  // the end of this file. Measured: before those were added, nothing in
  // `tests/live/` paired a real `readArtifact` with this field.
  //
  // Reds alone when `discoverRunBoundConversations` — the catalog's default
  // discovery provider, not merely an injection point — goes back to stamping
  // `exact_run_id` over whatever the record proved.
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "meta-kim-basis-parity-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(path.join(projectRoot, ".git"), { recursive: true });
  const executionRoot = path.join(projectRoot, ".meta-kim", "state", "default", "governed-executions");
  await mkdir(executionRoot, { recursive: true });

  const artifact = artifactWithSourceBasis("transcript_file_verified");
  await writeFile(path.join(executionRoot, `${REAL_RUN_ID}.json`), JSON.stringify(artifact), "utf8");

  const projectRef = buildProjectRef({ repoPath: projectRoot });
  const entry = {
    projectRef,
    repoRoot: projectRoot,
    displayName: path.basename(projectRoot),
    updatedAt: "2026-09-02T10:00:00.000Z",
  };
  const sessions = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [entry],
    now: () => Date.parse("2026-09-02T10:01:00.000Z"),
  }).listSessions(projectRef);

  const fromCatalog = sessions.find((session) => session.runId === REAL_RUN_ID);
  assert.ok(fromCatalog, "the catalog must see the artifact, or the comparison below is vacuous");
  assert.equal(fromCatalog.verifiedLinks.length, 1, "the catalog must produce a link, or the comparison below is vacuous");

  const fromService = buildLiveCompactProjection(artifact);
  assert.equal(
    fromCatalog.verifiedLinks[0].matchBasis,
    fromService.run.verifiedLinks[0].matchBasis,
    "one artifact, two derivations: a basis decided separately in each is how the same run gets two provenance claims",
  );
  assert.equal(
    fromCatalog.verifiedLinks[0].matchBasis,
    "transcript_file_verified",
    "agreeing on a wrong answer is not parity; both must forward what the record proved",
  );
});

test("both derivations agree when the stored reference names no run at all", async (t) => {
  // The parity guard above uses a fixture whose `sourceConversation` carries
  // `runId`, so it only ever exercises the branch where the run ids can be
  // compared. The silent shape — a chat block that names no run — is the older
  // and more common one on disk, and it is where the two readers had written the
  // same rule differently: the run panel compared with `declared === runId` and
  // the session list with `runId && declared === runId`. Both call sites happen to
  // prove a non-empty run id first, so neither wording ever printed a wrong
  // answer; what was missing was anything holding them to one answer as they were
  // edited. That is what this covers.
  //
  // Same scope limit as the guard above, and the same reason its name changed:
  // the service side here is handed the artifact, not a path, so this is a
  // derivation-parity guard and not a read-chain one.
  //
  // Silence is not a missing fact here: the block sits inside the run's own
  // record, so it is that run's first-party claim about itself, and the link stays
  // verified. Demoting it would put every record written before the `runId` field
  // existed back on the "no chat link" sentence.
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "meta-kim-basis-silent-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(path.join(projectRoot, ".git"), { recursive: true });
  const executionRoot = path.join(projectRoot, ".meta-kim", "state", "default", "governed-executions");
  await mkdir(executionRoot, { recursive: true });

  const artifact = artifactWithSourceBasis(null);
  delete artifact.sourceConversation.runId;
  assert.equal(
    artifact.sourceConversation.runId,
    undefined,
    "the fixture must carry no run claim, or this exercises the compared branch the guard above already owns",
  );
  await writeFile(path.join(executionRoot, `${REAL_RUN_ID}.json`), JSON.stringify(artifact), "utf8");

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

  const fromCatalog = sessions.find((session) => session.runId === REAL_RUN_ID);
  assert.ok(fromCatalog, "the catalog must see the artifact, or every comparison below is vacuous");
  const fromService = buildLiveCompactProjection(artifact);
  assert.equal(fromCatalog.verifiedLinks.length, 1, "the session list must keep a silent reference linked");
  assert.equal(fromService.run.verifiedLinks.length, 1, "the run panel must keep a silent reference linked");

  assert.equal(
    fromCatalog.verifiedLinks[0].matchBasis,
    fromService.run.verifiedLinks[0].matchBasis,
    "one artifact, two derivations: a basis worded separately in each reader is how the same run gets two provenance claims",
  );
  // Hardcoded rather than read off either surface: an expectation taken from one
  // of them would agree with whatever both happen to say, including a run-id match
  // neither of them performed.
  assert.equal(
    fromCatalog.verifiedLinks[0].matchBasis,
    "exact_metadata",
    "nothing compared a run id here, so claiming a run-id match overstates what was read",
  );
});

test("a run reading back its own projection does not upgrade its own provenance", async (t) => {
  // Measured, on the ordinary shape: a run with both `<id>.json` and
  // `<id>.live.json` on disk — the common case, since the second is written from
  // the first. The catalog reads both, and `conversationLinkRecordView` folds the
  // compact's own `verifiedLinks` back into `conversationLinks`, stamping
  // `linkState: "verified"` on each entry it took out of a verified array. The
  // compact stores no per-entry run id, so what came out was "stamped verified,
  // names no run" — and the reader turned that into `exact_thread_id`, a thread-id
  // comparison nothing here performs. The entry has no run id to compare, let
  // alone a thread id. A position or a flag proves standing ("this was already
  // accepted"); it never supplies a basis ("here is what we matched on").
  //
  // Observed before the fix, for a reference naming no run: session row
  // `exact_thread_id`, run panel `exact_metadata`. One file, two claims, and the
  // louder one invented. It stayed hidden because `conversationMatchBasisFor`
  // keeps whichever of stored and derived ranks higher, so a record carrying
  // `transcript_file_verified` or `exact_run_id` masked it; only the silent shape
  // diverged. The two guards above each write one file, never both, so neither
  // reaches this fold.
  //
  // Two mutations red this one and nothing else in the file, on two different
  // assertions: restoring `exact_thread_id` as the derived basis for a stamped
  // entry with no run id, and restoring the catalog's old positional ladder at its
  // `conversationLinks` branch. That second shape is where the defect was found,
  // and this is the only guard in the file that catches it.
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "meta-kim-basis-selfread-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(path.join(projectRoot, ".git"), { recursive: true });
  const executionRoot = path.join(projectRoot, ".meta-kim", "state", "default", "governed-executions");
  await mkdir(executionRoot, { recursive: true });

  const artifact = artifactWithSourceBasis(null);
  delete artifact.sourceConversation.runId;
  const compact = buildLiveCompactProjection(artifact);
  await writeFile(path.join(executionRoot, `${REAL_RUN_ID}.json`), JSON.stringify(artifact), "utf8");
  await writeFile(path.join(executionRoot, `${REAL_RUN_ID}.live.json`), JSON.stringify(compact), "utf8");

  // The fold is the input this guards, so its shape is asserted rather than
  // assumed: an entry the reader will see as verified while carrying nothing to
  // compare. `strictEqual` on the absence deliberately — a loose check would also
  // pass if the field were present and null, which is a different record.
  const folded = conversationLinkRecordView(compact).conversationLinks;
  assert.ok(folded.length > 0, "the compact must fold its own links back, or every assertion below is vacuous");
  assert.equal(folded[0].linkState, "verified", "the fold must stamp standing, or this exercises the unverified branch instead");
  assert.strictEqual(folded[0].runId, undefined, "the folded entry must name no run, or this exercises the compared branch the guard above owns");

  // The load-bearing pair, asserted on the owner rather than on a surface: the
  // catalog dedupes these entries against the ones derived from
  // `sourceConversation`, so which one reaches the screen depends on a dedupe
  // policy this test is not about. Restoring `exact_thread_id` as the derived value
  // for a stamped entry with no run id reds the second line here and nothing else
  // in this file.
  const placement = declaredLinkPlacementForRun(folded[0], REAL_RUN_ID);
  assert.equal(placement.proven, true, "an entry taken out of a verified array keeps its standing");
  assert.equal(
    placement.derivedBasis,
    "exact_metadata",
    "a verified stamp says this link was already accepted; it does not say a thread id was compared, and nothing here has one to compare",
  );

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

  const fromCatalog = sessions.find((session) => session.runId === REAL_RUN_ID);
  assert.ok(fromCatalog, "the catalog must see both files, or the comparison below is vacuous");
  assert.equal(fromCatalog.verifiedLinks.length, 1, "one chat reference read from two files is still one link");
  assert.equal(
    fromCatalog.verifiedLinks[0].matchBasis,
    compact.run.verifiedLinks[0].matchBasis,
    "the run's own projection is not new evidence about the run, so reading it back must not change what the row claims",
  );
  assert.equal(
    fromCatalog.verifiedLinks[0].matchBasis,
    "exact_metadata",
    "hardcoded, not read off either surface: an expectation taken from one of them would agree with a match neither performed",
  );
});

/**
 * Both surfaces through their real entrypoints, which is the half every guard
 * above leaves out. Each one hands the service an artifact it already holds, so
 * they compare two derivations over one input in memory. In production the panel
 * does not hold an artifact — it asks `createLiveReadRepository.readArtifact` for
 * one, and that walks `<id>.live.json` before `<id>.json` and returns the first
 * hit (`live-read-repository.mjs:448-462`, and the same order again at `:424-438`).
 * So which file each surface opens is part of the behaviour, and nothing in
 * `tests/live/` paired that read with this field: `readArtifact` appears only in
 * `live-boundaries.test.mjs` asserting run-id identity and path escape, and every
 * one of the ~50 `buildLiveSnapshot` calls in the suite is handed a hand-written
 * artifact.
 */
async function bothReadSurfaces(t, { storedBasis, projectionBasis }) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "meta-kim-basis-readpath-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(path.join(projectRoot, ".git"), { recursive: true });
  const executionRoot = path.join(projectRoot, ".meta-kim", "state", "default", "governed-executions");
  await mkdir(executionRoot, { recursive: true });

  const stored = artifactWithSourceBasis(storedBasis);
  const built = buildLiveCompactProjection(stored);
  // A projection written by an older build, reproduced by replacing only the basis
  // it recorded. Every other field stays as the current writer emitted it, so the
  // file still survives the read-back sanitizer and the divergence cannot be an
  // artefact of a malformed fixture.
  const staleHalf = (half) => ({
    ...half,
    verifiedLinks: half.verifiedLinks.map((link, index) => (index === 0 ? { ...link, matchBasis: projectionBasis } : link)),
  });
  const compact = projectionBasis
    ? { ...built, run: staleHalf(built.run), session: staleHalf(built.session) }
    : built;

  await writeFile(path.join(executionRoot, `${REAL_RUN_ID}.json`), JSON.stringify(stored), "utf8");
  await writeFile(path.join(executionRoot, `${REAL_RUN_ID}.live.json`), JSON.stringify(compact), "utf8");

  const read = await createLiveReadRepository({ projectRoot, profile: "default" }).readArtifact(REAL_RUN_ID);
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

  return {
    onDisk: compact,
    read,
    panel: read ? buildLiveSnapshot({ governedArtifact: read, observedAt: "2026-09-02T10:01:00.000Z" }) : null,
    row: sessions.find((session) => session.runId === REAL_RUN_ID) || null,
  };
}

test("both read surfaces name the same basis when each opens the file it really opens", async (t) => {
  // The ordinary shape: both files on disk, the compact written from the raw one
  // by the current writer. Measured on this repository's own state tree, this is
  // the shape that agrees — the run whose two files were written by this build
  // reports `transcript_file_verified` on the session row and on the run panel.
  //
  // Two mutations were run against this test, and they split its assertions:
  //
  // Reducing `conversationMatchBasisFor` to return the derived value
  // unconditionally reds the hardcoded assertion below, along with three guards
  // further up — coarse, but it proves that assertion is load-bearing rather than
  // decorative. It does *not* red the parity assertion, and the reason is worth
  // recording because it is the assertion's own blind spot: this fixture writes
  // the compact through the real writer, so a derivation mutation both freezes the
  // mutated value into the projection and makes the catalog re-derive that same
  // value. Measured under that mutation, both surfaces reported `exact_run_id` —
  // wrong in the same direction, which is precisely the case a parity assertion
  // cannot see. Only a mutation that moves one surface and not the other can red
  // it, and those live in the two files another owner holds during this run
  // (`live-control-room-service.mjs` folds the projection back at `:2405-2408`,
  // `live-hub-project-catalog.mjs` derives the row). So the parity assertion here
  // is not independently proven.
  //
  // Putting `<id>.json` ahead of `<id>.live.json` in `readArtifact` reds this test
  // at the schema precondition below, not at either load-bearing assertion: in
  // this shape both files carry the same basis, so parity cannot tell which one
  // was opened. That is what the next guard is for.
  const { read, panel, row } = await bothReadSurfaces(t, {
    storedBasis: "transcript_file_verified",
    projectionBasis: null,
  });

  assert.ok(read, "the panel's own read entrypoint must return an artifact, or every assertion below is vacuous");
  assert.equal(
    read.schemaVersion,
    LIVE_COMPACT_PROJECTION_SCHEMA_VERSION,
    "the read chain must have picked the compact projection, or this exercises the raw-artifact branch and says nothing about the file the panel really opens",
  );
  assert.ok(panel, "the snapshot must be built, or every assertion below is vacuous");
  assert.ok(row, "the catalog must see the run, or the comparison below is vacuous");
  assert.equal(panel.run.verifiedLinks.length, 1, "the panel must produce a link, or the comparison below is vacuous");
  assert.equal(row.verifiedLinks.length, 1, "the row must produce a link, or the comparison below is vacuous");

  assert.equal(
    panel.run.verifiedLinks[0].matchBasis,
    row.verifiedLinks[0].matchBasis,
    "two entrypoints, two candidate chains, one run: a basis that differs by which file a surface happened to open is a provenance claim the run never made",
  );
  // Hardcoded rather than read off either surface: a parity assertion alone is
  // green when both surfaces are wrong in the same direction.
  assert.equal(
    panel.run.verifiedLinks[0].matchBasis,
    "transcript_file_verified",
    "the hook opened the transcript file and matched its identity, and a projection written from that record must not report less",
  );
});

test("a basis frozen into the compact projection is what the run panel reads, and nothing re-derives it", async (t) => {
  // This is the shape the divergence was measured on, and it is a decided cost
  // rather than a defect this file claims is fixed. `readArtifact` returns the
  // compact projection, and the compact carries no `sourceConversation` — so on
  // this path `conversationMatchBasisFor` is never reached at all. The panel is
  // not losing a rank comparison; there is no comparison, because there is no
  // second input to compare against. A weak value written once by an older build
  // is therefore permanent for this surface, while the session list reads both
  // files and folds its way back to the stronger one.
  //
  // Measured scale before deciding not to change the read order: 1 of 26 records
  // in this project diverges, both surfaces report state `verified`, and only the
  // provenance word differs. Re-deriving would cost the raw file on every panel
  // load, and putting `<id>.json` first would put an uncapped read ahead of the
  // capped one, which is the guarantee `LIVE_MAX_COMPACT_JSON_BYTES` exists to
  // give. Whoever reds this guard by changing that order should weigh those two
  // costs deliberately rather than read it as a regression.
  //
  // The two assertions below are proven unequally, and the weaker case is stated
  // rather than left to look covered:
  //
  // Reducing `conversationMatchBasisFor` to return the derived value
  // unconditionally reds the session-list assertion at the end — the row stops
  // reaching what the run proved. It leaves the frozen-value assertion green,
  // measured: the panel still reported `exact_metadata`, because a value already
  // written into the projection is not touched by changing the derivation.
  //
  // That is the frozen-value assertion's real shape: it guards the *absence* of a
  // re-derivation on this path, and no deletion can red an absence. Putting
  // `<id>.json` first in `readArtifact` reds this test at the chat-block
  // precondition below instead, because the raw record carries the block — so
  // execution never reaches the frozen-value line. The only mutation that would
  // red it is *adding* re-derivation, which is the behavior change weighed and
  // declined above. Recorded as not independently proven, not as covered.
  const { onDisk, read, panel, row } = await bothReadSurfaces(t, {
    storedBasis: "transcript_file_verified",
    projectionBasis: "exact_metadata",
  });

  assert.equal(
    onDisk.run.verifiedLinks[0].matchBasis,
    "exact_metadata",
    "the fixture must really declare the weaker basis, or this exercises the agreeing shape the guard above already owns",
  );
  assert.ok(read, "the panel's own read entrypoint must return an artifact, or every assertion below is vacuous");
  // `strictEqual` on the absence deliberately: a loose check would also pass with
  // the field present and null, which is a record that carries a chat block and
  // says nothing about it — a different input, and one the derivation does reach.
  assert.strictEqual(
    read.sourceConversation,
    undefined,
    "the compact must carry no chat block, or the panel has an input to derive from and this stops being the no-comparison path",
  );
  assert.ok(panel, "the snapshot must be built, or every assertion below is vacuous");
  assert.ok(row, "the catalog must see the run, or the comparison below is vacuous");
  assert.equal(panel.run.verifiedLinks.length, 1, "the panel must produce a link, or the assertion below is vacuous");
  assert.equal(row.verifiedLinks.length, 1, "the row must produce a link, or the assertion below is vacuous");

  assert.equal(
    panel.run.verifiedLinks[0].matchBasis,
    "exact_metadata",
    "the panel forwards whatever the projection froze, because on this path there is no second input and therefore no comparison to win",
  );
  assert.equal(
    row.verifiedLinks[0].matchBasis,
    "transcript_file_verified",
    "the session list opens the raw record too, so it still reaches what the run actually proved",
  );
});
