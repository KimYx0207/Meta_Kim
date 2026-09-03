import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildProjectRef } from "../../scripts/project-registry.mjs";
import { mergeConversationLinkBuckets } from "../../src/application/live/live-conversation-link-vocabulary.mjs";
import { buildLiveCompactProjection } from "../../src/application/live/live-control-room-service.mjs";
import { createLiveHubProjectCatalog } from "../../src/infrastructure/live/live-hub-project-catalog.mjs";

/**
 * One chat reference described twice in one record, folded by three functions that
 * each wrote the fold differently.
 *
 * The run panel kept one `seen` set across both buckets, so whichever description
 * was read first won and every later one was dropped — including a stronger one
 * that lands in the other bucket. The session list folded each bucket separately
 * with a `Map`, so the last description won, and then dropped candidates that the
 * verified bucket already held. The client-side normalizer folded each bucket
 * first-wins and then applied the same cross-bucket filter. Three wordings of one
 * rule, and two of them decide by arrival order.
 *
 * Arrival order is the part that makes this a defect rather than a preference: the
 * two readers enumerate the same record's descriptions in different orders, so an
 * order-dependent fold lets them reach different answers about one file. Measured
 * before the fix, on the artifact test 1 builds: the run panel reported
 * `candidate` with no verified link, the session list reported `verified` with
 * `exact_run_id`. Same file, opposite answers, and neither surface was reading a
 * different fact.
 *
 * The fold is now one owner that decides by evidence instead of by order: within a
 * bucket the strongest basis survives, a reference the verified bucket holds is
 * never also a candidate, and neither outcome depends on which description arrived
 * first.
 */

const RUN_ID = "meta-run-dedupe-parity";
const REF = "b5799d00-ef7a-4882-818d-d9053cacba71";

function link(matchBasis, extra = {}) {
  return { sourceRuntime: "claude", conversationRef: REF, matchBasis, ...extra };
}

test("one chat described as this run's and as another run's reads the same on both surfaces", async (t) => {
  // Reachable from an ordinary record, which is why this is the first guard: the
  // run's own `sourceConversation` names a different run — a foreign claim about
  // this chat — while its `conversationLinks` entry names this run and proves it.
  // Both descriptions are about the same chat, so the fold has to pick one, and
  // before the fix the run panel picked the foreign claim purely because it was
  // read first.
  const artifact = {
    schemaVersion: "governed-execution-v1",
    runId: RUN_ID,
    status: "running",
    updatedAt: "2026-09-02T10:00:00.000Z",
    sourceRuntime: "claude",
    sourceConversation: { runtime: "claude", conversationId: REF, runId: "meta-run-someone-elses-work" },
    conversationLinks: [{ runtime: "claude", conversationId: REF, runId: RUN_ID, matchBasis: "exact_run_id" }],
  };

  const service = buildLiveCompactProjection(artifact).run;

  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "meta-kim-dedupe-parity-"));
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

  const shape = (surface) => ({
    state: surface.conversationLinkState,
    verified: surface.verifiedLinks.map((item) => item.matchBasis),
    candidates: surface.candidateLinks.map((item) => item.matchBasis),
  });

  assert.deepEqual(
    shape(session),
    shape(service),
    "one file cannot read as this run's confirmed chat in the list and as somebody else's chat in the panel",
  );
  assert.deepEqual(
    shape(service),
    { state: "verified", verified: ["exact_run_id"], candidates: [] },
    "hardcoded, not read off either surface: an expectation taken from one of them would agree with whichever order it happened to read, which is the bug",
  );
});

test("the surviving basis does not depend on which description arrived first", () => {
  const strongFirst = mergeConversationLinkBuckets([link("exact_run_id"), link("metadata_candidate")], []);
  const weakFirst = mergeConversationLinkBuckets([link("metadata_candidate"), link("exact_run_id")], []);

  assert.equal(strongFirst.verified.length, 1, "two descriptions of one chat are still one link");
  assert.deepEqual(weakFirst.verified, strongFirst.verified, "arrival order is not evidence");
  assert.equal(
    strongFirst.verified[0].matchBasis,
    "exact_run_id",
    "the fold keeps what was proven, not what was read first or last",
  );
});

test("an unrankable basis never survives against one this build can read", () => {
  // A file written by a newer build can name a basis this one cannot rank. Ranking
  // it as unknown-and-weakest is what keeps it from winning the comparison; the
  // alternative is a reader shown a raw enum it has no copy for.
  const merged = mergeConversationLinkBuckets([link("basis_from_a_newer_build"), link("exact_metadata")], []);

  assert.equal(merged.verified.length, 1);
  assert.equal(merged.verified[0].matchBasis, "exact_metadata");
});

test("a description that only has the title contributes it instead of losing it", () => {
  // Provenance and display text are different fields. Picking the stronger
  // description wholesale drops a title only the weaker one carried, which leaves a
  // row showing a bare id next to a link the record could name.
  const merged = mergeConversationLinkBuckets(
    [link("metadata_candidate", { conversationTitle: "Weekly triage" }), link("exact_run_id")],
    [],
  );

  assert.equal(merged.verified[0].matchBasis, "exact_run_id", "the stronger basis still wins");
  assert.equal(merged.verified[0].conversationTitle, "Weekly triage", "a field the winner does not carry is not evidence to discard");
});

test("a chat the verified bucket holds is not also offered as a candidate", () => {
  const merged = mergeConversationLinkBuckets([link("exact_run_id")], [link("title_time_project_similarity")]);

  assert.equal(merged.verified.length, 1);
  assert.deepEqual(merged.candidates, [], "offering a confirmed chat as a maybe asks the reader to resolve a contradiction the fold already can");
});

test("buckets that are not arrays fold to empty instead of throwing", () => {
  // Both callers read these off a file on disk, where a value can be a string, a
  // number, or absent. Throwing here is how one malformed record takes down the
  // whole session list.
  assert.deepEqual(mergeConversationLinkBuckets(null, undefined), { verified: [], candidates: [] });
  assert.deepEqual(mergeConversationLinkBuckets("verified", 7), { verified: [], candidates: [] });
});
