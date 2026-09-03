import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CONVERSATION_DISCOVERY_COPY,
  CONVERSATION_DISCOVERY_REASONS,
  CONVERSATION_RUNTIME_ALIASES,
  CONVERSATION_RUNTIME_UNAVAILABLE,
  conversationDiscoveryForRuntime,
  conversationDiscoveryReasonFor,
  conversationLinkRecordView,
  recordConversationRuntime,
} from "../../src/application/live/live-conversation-link-vocabulary.mjs";
import {
  LIVE_COMPACT_PROJECTION_SCHEMA_VERSION,
  buildLiveSnapshot,
} from "../../src/application/live/live-control-room-service.mjs";
import { renderLiveControlRoomPage } from "../../src/presentation/live/live-control-room-page.mjs";

const CATALOG_SOURCE = "src/infrastructure/live/live-hub-project-catalog.mjs";
const SERVICE_SOURCE = "src/application/live/live-control-room-service.mjs";

/**
 * Driven through the producer instead of read out of its source text. This list
 * used to be recovered by slicing the catalog's inline assignment out of the
 * file, which pinned the guard to one literal's formatting and to one of the two
 * surfaces that need the answer — the run header had no such literal to slice,
 * which is exactly how it ended up printing a different sentence for the same
 * run. Sweeping the runtime domain reaches whatever the shared producer actually
 * returns.
 *
 * What the sweep does not reach is a branch keyed on something other than the
 * runtime. The producer takes only the runtime today; a second input would need a
 * second sweep, and saying so here is cheaper than a guard that quietly stops
 * covering the thing it names.
 */
function reasonsTheProducerCanEmit() {
  const runtimes = [
    ...CONVERSATION_RUNTIME_ALIASES.keys(),
    ...CONVERSATION_RUNTIME_ALIASES.values(),
    CONVERSATION_RUNTIME_UNAVAILABLE,
    "a-runtime-from-a-newer-build",
    "",
    null,
    undefined,
  ];
  return runtimes.map((runtime) => conversationDiscoveryForRuntime(runtime).reason);
}

test("the read surface knows exactly the reasons the producer can emit", () => {
  const emitted = reasonsTheProducerCanEmit();

  // A sweep that produced nothing would satisfy a bare deepEqual against an
  // empty enum, and reads identically to a producer that emits nothing.
  assert.ok(emitted.length >= 2, "the producer sweep returned nothing, so every comparison below is vacuous");
  assert.ok(
    emitted.includes("no_safe_runtime_metadata_source"),
    "the reason 86 of 103 real records carry must come out of the producer, not just sit in a list",
  );

  assert.deepEqual(
    [...CONVERSATION_DISCOVERY_REASONS].sort(),
    [...new Set(emitted)].sort(),
    "every reason the producer can emit must be a reason this surface can read",
  );
});

/**
 * The run header and the session list both derive this now, so the shape is a
 * contract rather than one caller's local literal. `runtime` is absent rather
 * than `"unavailable"` when nothing was resolved, because the publisher copies
 * the field only when it is truthy and a reader seeing `runtime: "unavailable"`
 * next to "no tool was recorded" would be reading the same fact twice.
 */
test("the producer names the runtime it reached, and only when it reached one", () => {
  assert.deepEqual(
    conversationDiscoveryForRuntime("claude_code"),
    { state: "metadata_only", runtime: "claude", reason: "run_bound_metadata_only" },
    "a runtime family must be normalized to the printable name before it is recorded",
  );
  assert.deepEqual(
    conversationDiscoveryForRuntime(null),
    { state: "unsupported", reason: "no_safe_runtime_metadata_source" },
  );
  assert.deepEqual(
    conversationDiscoveryForRuntime("a-runtime-from-a-newer-build"),
    conversationDiscoveryForRuntime(null),
    "an unknown name is not a resolved runtime",
  );
  assert.notEqual(
    conversationDiscoveryForRuntime("codex").state,
    conversationDiscoveryForRuntime(null).state,
    "a run that named its tool and one that never did must not carry the same state",
  );
});

/**
 * The header reads `snapshot.run`, and the field simply was not there: the
 * session list computed its own discovery block while the run projection carried
 * none, so 42 of 46 rows measured on this repository said "only the run record
 * was checked" in the list and "no chat id was saved for this run" in the header
 * of the same run. Every path that can produce `snapshot.run` is exercised here,
 * because each one builds the run object separately — a durable-only record, a
 * governed artifact, and a stored compact projection read back off disk.
 */
test("every snapshot path carries the discovery reason the run header prints", () => {
  const observedAt = "2026-08-24T10:00:03.000Z";
  // Read through optional access so an omitted field fails on the assertion that
  // names the defect. Reaching into it directly throws a TypeError instead, which
  // reads to the next maintainer as a broken test rather than a missing sentence.
  const headerReason = (snapshot) => snapshot.run.conversationDiscovery?.reason ?? null;
  const durable = (runId, extra) => buildLiveSnapshot({
    durableStatus: { runId, updatedAt: "2026-08-24T10:00:00.000Z", status: "active", ...extra },
    observedAt,
  });

  assert.equal(
    headerReason(durable("meta-discovery-claude", { sourceRuntime: "claude" })),
    "run_bound_metadata_only",
    "the run projection dropped the reason, so the header falls back to the generic sentence",
  );
  assert.equal(
    headerReason(durable("meta-discovery-silent", {})),
    "no_safe_runtime_metadata_source",
    "a run that never named a tool must say so rather than fall back to the generic sentence",
  );

  const fromArtifact = buildLiveSnapshot({
    governedArtifact: {
      runId: "meta-discovery-artifact",
      updatedAt: "2026-08-24T10:00:00.000Z",
      status: "running",
      sourceRuntime: "codex",
      events: [{ sequence: 1, timestamp: "2026-08-24T10:00:01.000Z", stage: "Execution", status: "running" }],
    },
    observedAt,
  });
  assert.equal(headerReason(fromArtifact), "run_bound_metadata_only");
  assert.deepEqual(
    fromArtifact.session.conversationDiscovery,
    fromArtifact.run.conversationDiscovery,
    "the run header and the session row of one snapshot must not disagree about the same run",
  );

  // A stored projection is re-derived rather than trusted, so a file written by a
  // build that had no such field still reaches the header with one.
  const fromStoredCompact = buildLiveSnapshot({
    governedArtifact: {
      schemaVersion: LIVE_COMPACT_PROJECTION_SCHEMA_VERSION,
      run: { runId: "meta-discovery-compact", status: "running", sourceRuntime: "cursor", updatedAt: "2026-08-24T10:00:00.000Z" },
      nodes: [],
    },
    observedAt,
  });
  assert.deepEqual(
    fromStoredCompact.run.conversationDiscovery,
    { state: "metadata_only", runtime: "cursor", reason: "run_bound_metadata_only" },
    "a compact projection read back off disk lost the field, so the header fell back to the generic sentence",
  );
  assert.deepEqual(
    fromStoredCompact.session.conversationDiscovery,
    fromStoredCompact.run.conversationDiscovery,
  );
});

test("every discovery reason says something the generic sentence does not", () => {
  for (const reason of CONVERSATION_DISCOVERY_REASONS) {
    const copy = CONVERSATION_DISCOVERY_COPY[reason];
    assert.equal(typeof copy, "string", `${reason} has no copy, so it would print as a raw enum`);
    assert.ok(copy.length > 12, `${reason} copy is too short to tell a reader where to look`);
    assert.ok(!copy.includes("_"), `${reason} copy still reads like an identifier rather than a sentence`);
  }

  assert.equal(
    new Set(Object.values(CONVERSATION_DISCOVERY_COPY)).size,
    CONVERSATION_DISCOVERY_REASONS.length,
    "two reasons sharing one sentence make the distinction unreadable",
  );
});

test("a confirmed link and an unknown reason both suppress the discovery sentence", () => {
  assert.equal(
    conversationDiscoveryReasonFor("verified", { reason: "run_bound_metadata_only" }),
    null,
    "a verified link must not explain why it could not be found",
  );
  assert.equal(
    conversationDiscoveryReasonFor("unlinked", { reason: "run_bound_metadata_only" }),
    "run_bound_metadata_only",
  );
  assert.equal(conversationDiscoveryReasonFor("candidate", { reason: "no_safe_runtime_metadata_source" }), "no_safe_runtime_metadata_source");
  assert.equal(conversationDiscoveryReasonFor("unlinked", { reason: "a_reason_from_a_newer_build" }), null);
  assert.equal(conversationDiscoveryReasonFor("unlinked", { reason: 7 }), null);
  assert.equal(conversationDiscoveryReasonFor("unlinked", null), null);
  assert.equal(conversationDiscoveryReasonFor("unlinked", "run_bound_metadata_only"), null);
});

test("the shipped page carries both languages for every discovery reason", () => {
  const html = renderLiveControlRoomPage();
  for (const reason of CONVERSATION_DISCOVERY_REASONS) {
    const english = CONVERSATION_DISCOVERY_COPY[reason];
    assert.ok(html.includes(english), `${reason} copy never reaches the client script, so the reason cannot be shown`);

    // `zhText.get(text) || text` returns the English source when an entry is
    // missing, so an absent translation ships as English rather than failing.
    const zhEntry = new RegExp(`"${english.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}":\\s*"([^"]+)"`, "u").exec(html);
    assert.ok(zhEntry, `${reason} has no zhText entry, so Chinese readers fall back to English`);
    assert.ok(/[一-鿿]/u.test(zhEntry[1]), `${reason} zhText entry is not Chinese: ${zhEntry[1]}`);
  }
});

/**
 * The two surfaces that print a run's tool used to keep their own alias table and
 * their own idea of where a record stores the name. The catalog read the governed
 * runner's `requestRecord.runtimeContext.runtimeFamily`; the service read only
 * `sourceRuntime`. So one run appeared as "Codex" in the session list and "no
 * runtime recorded" in its own header, and nothing failed.
 */
test("only the shared vocabulary decides which runtimes these surfaces may print", () => {
  for (const file of [SERVICE_SOURCE, CATALOG_SOURCE]) {
    const source = readFileSync(file, "utf8");
    assert.equal(
      /\["claude[-_]code",\s*"claude"\]/u.test(source),
      false,
      `${file} restates the runtime alias table, so the two surfaces can disagree again`,
    );
    assert.ok(
      source.includes("recordConversationRuntime"),
      `${file} does not read the runtime through the shared reader`,
    );
  }
});

/**
 * The array a link was stored in is the declaration of its standing, because the
 * compact projection records no per-entry verified flag. The stamp used to be
 * written before the spread, so a stored `linkState` on an entry inside
 * `run.verifiedLinks` outranked the array it came from and the stamp became a
 * no-op for exactly those entries — three call sites treat `linkState` as one way
 * a link counts as verified, so such an entry would drop out of the verified set
 * and the row would go back to saying no chat was ever linked.
 *
 * No producer here writes a per-entry `linkState`: the two writers of that array
 * emit a fixed five-key shape, and a repository-wide search finds the stamp as
 * the only assignment. This reader takes arbitrary stored records by contract,
 * so the case is reachable through the export even though no writer reaches it.
 */
test("standing comes from the array a link was stored in, not from a stored label", () => {
  const view = conversationLinkRecordView({
    run: {
      verifiedLinks: [
        { conversationRef: "chat-stamped", sourceRuntime: "claude" },
        { conversationRef: "chat-mislabelled", sourceRuntime: "claude", linkState: "candidate" },
      ],
    },
  });

  assert.equal(view.conversationLinks.length, 2, "the reader dropped an entry, so the comparison below proves nothing");
  assert.deepEqual(
    view.conversationLinks.map((entry) => entry.linkState),
    ["verified", "verified"],
    "a stored label beat the array the link was found in, so a proven link reads as unverified",
  );
});

test("a link declared outside the verified array keeps the standing it was stored with", () => {
  const view = conversationLinkRecordView({
    conversationLinks: [{ conversationRef: "chat-declared", sourceRuntime: "codex", linkState: "candidate" }],
  });

  assert.equal(view.conversationLinks.length, 1);
  assert.equal(
    view.conversationLinks[0].linkState,
    "candidate",
    "the positional stamp leaked onto a list whose position declares nothing",
  );
});

test("the shared reader resolves the tool from every place a producer records it", () => {
  assert.equal(recordConversationRuntime({ requestRecord: { runtimeContext: { runtimeFamily: "codex" } } }), "codex");
  assert.equal(
    recordConversationRuntime({ coreLoop: { requestRecord: { runtimeContext: { runtimeFamily: "claude_code" } } } }),
    "claude",
    "a runtime family is not yet a printable label",
  );
  assert.equal(recordConversationRuntime({ run: { runtime: "cursor" } }), "cursor");
  assert.equal(
    recordConversationRuntime({
      sourceConversation: { runtime: "cursor" },
      requestRecord: { runtimeContext: { runtimeFamily: "codex" } },
    }),
    "cursor",
    "the chat the run was bound in outranks the runtime that produced the record",
  );
  // The runner records the host it proved as `sourceRuntime` and keeps the route
  // it plans against in `requestRecord.runtimeContext`. Both are written on the
  // same artifact, and the planning one used to be a hardcoded default — so
  // reading it first is what filed every Claude Code run under Codex.
  assert.equal(
    recordConversationRuntime({
      sourceRuntime: "claude",
      requestRecord: { runtimeContext: { runtimeFamily: "codex" } },
    }),
    "claude",
    "the proven host must outrank the runtime the route was planned against",
  );
  assert.equal(recordConversationRuntime({ runtime: "a-runtime-from-a-newer-build" }), "unavailable");
  assert.equal(recordConversationRuntime({ requestRecord: "runtimeContext" }), "unavailable");
  assert.equal(recordConversationRuntime(null), "unavailable");
  assert.equal(recordConversationRuntime("codex"), "unavailable", "a bare string is not a record");
});

test("a stored discovery standing never outranks the one derived from the runtime", () => {
  // This field does reach disk: of the six stored projections on this repository,
  // one carries it and five predate it. So the stored value is a snapshot of one
  // build's opinion, and the vocabulary it was written against can be corrected
  // later. If a reader trusted it, a run whose tool is plainly recorded would keep
  // printing "no tool was recorded" forever, and the only way to fix that row
  // would be to rewrite the file — the neighbouring test covers the absent case,
  // this one covers the present-and-wrong case, which is the one that survives.
  const staleOpinion = { state: "unsupported", reason: "no_safe_runtime_metadata_source" };
  const stored = {
    schemaVersion: LIVE_COMPACT_PROJECTION_SCHEMA_VERSION,
    run: {
      runId: "meta-discovery-stale-opinion",
      status: "running",
      sourceRuntime: "cursor",
      updatedAt: "2026-08-24T10:00:00.000Z",
      conversationDiscovery: staleOpinion,
    },
    nodes: [],
  };

  const derived = conversationDiscoveryForRuntime("cursor");
  assert.notDeepEqual(
    derived,
    staleOpinion,
    "the fixture's stored value now matches what the runtime derives, so this test can no longer tell the two apart",
  );

  const snapshot = buildLiveSnapshot({ governedArtifact: stored, observedAt: "2026-08-24T10:00:03.000Z" });
  assert.deepEqual(
    snapshot.run.conversationDiscovery,
    derived,
    "a stored standing outranked the runtime, so a row corrected in code keeps printing the old answer off disk",
  );
  assert.deepEqual(
    snapshot.session.conversationDiscovery,
    derived,
    "the session row still trusts the stored standing, so one run disagrees with its own header",
  );
});

