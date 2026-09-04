/**
 * One vocabulary for why a run has no chat link.
 *
 * The activation hook already decides this and records it: when a binding is
 * refused it writes `conversationLinkRefusal` next to `sourceConversation` in the
 * run status envelope. Every surface downstream then dropped the field, so the
 * panel could say a run had no chat link but never why. "No chat id was saved"
 * and "the transcript file is gone" send a reader to different places, and
 * flattening both into the first sentence makes the second one unreachable.
 *
 * The reasons mirror `CONVERSATION_BINDING_REFUSAL_REASONS` in
 * `canonical/runtime-assets/shared/hooks/conversation-binding.mjs`. `src/` does
 * not import from `canonical/`, so the list is restated here and held to the
 * canonical one by a drift guard in the tests rather than by convention.
 *
 * Copy is the English source string, matching how every other reason map on this
 * surface works: the renderer emits English and `localize` maps it, so a missing
 * translation is a missing `zhText` entry rather than a missing branch here.
 */

export const CONVERSATION_LINK_REFUSAL_REASONS = Object.freeze([
  "runtime_not_identified",
  "conversation_id_not_identified",
  "transcript_path_absent",
  "transcript_path_not_absolute",
  "transcript_identity_mismatch",
  "transcript_file_absent",
  "transcript_file_empty",
]);

const REFUSAL_REASON_SET = new Set(CONVERSATION_LINK_REFUSAL_REASONS);

/**
 * Stored records are untrusted input: a file on disk may carry a reason this
 * build does not know, or a value that is not a string at all. An unknown reason
 * becomes `null` so the surface falls back to the plain "no chat id" sentence
 * instead of printing a raw enum at a reader.
 */
export function normalizeConversationLinkRefusal(value) {
  return typeof value === "string" && REFUSAL_REASON_SET.has(value) ? value : null;
}

/**
 * A refusal only describes an absent link. A run that did bind may still carry a
 * stale reason from an earlier attempt, and showing it next to a verified link
 * would contradict the link itself. The state layer already suppresses that; the
 * read surfaces have to suppress it too, because they read the file, not the
 * writer.
 */
export function conversationLinkRefusalFor(linkState, value) {
  return linkState === "verified" ? null : normalizeConversationLinkRefusal(value);
}

export const CONVERSATION_LINK_REFUSAL_COPY = Object.freeze({
  runtime_not_identified: "The tool that started this run did not identify itself",
  conversation_id_not_identified: "No chat id came through when this run started",
  transcript_path_absent: "The tool did not say where the chat transcript is",
  transcript_path_not_absolute: "The chat transcript path was not a full path",
  transcript_identity_mismatch: "The transcript on record belongs to a different chat",
  transcript_file_absent: "The chat transcript file is no longer on disk",
  transcript_file_empty: "The chat transcript file was empty",
});

export function serializeConversationLinkRefusalCopyForClient() {
  return { ...CONVERSATION_LINK_REFUSAL_COPY };
}

/**
 * How far the lookup got, for runs that carry no refusal at all.
 *
 * A refusal is only written when a binding was attempted, so every record older
 * than that hook has none. The catalog still knows something about those runs:
 * `live-hub-project-catalog.mjs` records whether the run ever named a tool. That
 * distinction is the difference between "there was nowhere to look" and "we only
 * read what the run itself saved", and the generic sentence collapsed both.
 *
 * `conversationDiscoveryForRuntime` below is the only producer of these values, so
 * this list is the producer's own vocabulary rather than a hand-kept copy of a
 * literal stated somewhere else.
 */
export const CONVERSATION_DISCOVERY_REASONS = Object.freeze([
  "no_safe_runtime_metadata_source",
  "run_bound_metadata_only",
]);

const DISCOVERY_REASON_SET = new Set(CONVERSATION_DISCOVERY_REASONS);

export const CONVERSATION_DISCOVERY_COPY = Object.freeze({
  no_safe_runtime_metadata_source: "No tool was recorded for this run, so there is no chat to look up",
  run_bound_metadata_only: "Only the run record was checked, not the tool chat history",
});

/**
 * Takes the discovery block as the record gives it: a string where an object
 * belongs, or a reason from a newer build, both become `null` so the surface
 * falls back to the plain sentence instead of printing a raw enum. A verified
 * link suppresses the reason for the same purpose a refusal is suppressed —
 * explaining why a link could not be found next to the link itself is a
 * contradiction the reader has to resolve.
 */
export function conversationDiscoveryReasonFor(linkState, discovery) {
  if (linkState === "verified") return null;
  if (!discovery || typeof discovery !== "object" || Array.isArray(discovery)) return null;
  return typeof discovery.reason === "string" && DISCOVERY_REASON_SET.has(discovery.reason)
    ? discovery.reason
    : null;
}

export function serializeConversationDiscoveryCopyForClient() {
  return { ...CONVERSATION_DISCOVERY_COPY };
}

/**
 * One table for which tool names this surface is allowed to print, and one reader
 * for where a record keeps that name.
 *
 * The name lives in more than one place because more than one producer writes it:
 * the activation hook writes `sourceConversation.runtime`, the governed runner
 * writes `requestRecord.runtimeContext.runtimeFamily`, and a compact projection
 * writes `sourceRuntime`. The session list and the run header used to read
 * different subsets of that list, so the same run was named "Codex" in one place
 * and "no runtime recorded" in the other. Neither surface owns the answer, so the
 * lookup order lives here and both read it.
 */
export const CONVERSATION_RUNTIME_ALIASES = Object.freeze(new Map([
  ["claude", "claude"],
  ["claude-code", "claude"],
  ["claude_code", "claude"],
  ["codex", "codex"],
  ["cursor", "cursor"],
  ["openclaw", "openclaw"],
  ["open-claw", "openclaw"],
]));

export const CONVERSATION_RUNTIME_UNAVAILABLE = "unavailable";

/**
 * A runtime family is not yet a printable source label: `claude_code` names the
 * same producer as `claude`, and an unknown or absent value must read as
 * unavailable rather than reach a reader raw.
 */
export function conversationRuntimeFamily(value) {
  return CONVERSATION_RUNTIME_ALIASES.get(String(value ?? "").trim().toLowerCase()) ||
    CONVERSATION_RUNTIME_UNAVAILABLE;
}

/**
 * How far a chat lookup could reach for a run, derived from the one fact that
 * decides it: whether the record named a tool at all.
 *
 * This used to be an inline ternary in the session-list producer, and the run
 * header had no equivalent at all — so the same run said "only the run record was
 * checked" in the list and "no chat id was saved for this run" in its own header.
 * Measured on the real repository at the time: 42 of 46 rows disagreed with
 * themselves. Deriving it here means the run projection and the session row get
 * the same answer from the same input instead of each remembering to compute it.
 *
 * A verified link is not filtered out here. Suppressing the reason belongs to the
 * read surface (`conversationDiscoveryReasonFor`), because a stored record can
 * carry a link this build has to re-derive standing for, and a producer that
 * withheld the reason would leave that surface with nothing to fall back to.
 */
export function conversationDiscoveryForRuntime(sourceRuntime) {
  const runtime = conversationRuntimeFamily(sourceRuntime);
  return runtime === CONVERSATION_RUNTIME_UNAVAILABLE
    ? { state: "unsupported", reason: "no_safe_runtime_metadata_source" }
    : { state: "metadata_only", runtime, reason: "run_bound_metadata_only" };
}

const RUNTIME_RECORD_PATHS = Object.freeze([
  ["sourceConversation", "runtime"],
  ["sourceConversation", "provider"],
  ["conversation", "runtime"],
  ["sourceRuntime"],
  ["runtimeFamily"],
  ["runtime"],
  ["provider"],
  ["run", "runtime"],
  ["run", "sourceRuntime"],
  ["session", "runtime"],
  ["requestRecord", "runtimeContext", "runtimeFamily"],
  ["coreLoop", "requestRecord", "runtimeContext", "runtimeFamily"],
]);

function readPath(record, keys) {
  let cursor = record;
  for (const key of keys) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/**
 * Resolves the one tool name a stored record proves, checking chat-scoped
 * evidence before the run's own runtime family so a record that names both keeps
 * the tool the chat was actually bound in. Returns `unavailable` when no path
 * holds a known family, which is the same answer every surface already prints for
 * a record that never named its tool.
 */
export function recordConversationRuntime(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return CONVERSATION_RUNTIME_UNAVAILABLE;
  }
  for (const keys of RUNTIME_RECORD_PATHS) {
    const family = conversationRuntimeFamily(readPath(record, keys));
    if (family !== CONVERSATION_RUNTIME_UNAVAILABLE) return family;
  }
  return CONVERSATION_RUNTIME_UNAVAILABLE;
}

/**
 * Which run a stored conversation reference claims to belong to, read raw.
 *
 * Two readers used to answer this one question. The run panel resolved it through
 * the live run-id format gate over `runId`, `governedRunId`, and `sessionRunId`;
 * the session list read `runId` and `run.runId` and took whatever string it found.
 * Measured through both surfaces on six reference shapes, four disagreed: a
 * reference naming another run was dropped entirely by one surface and shown as a
 * candidate by the other; one naming another run through the governed alias was
 * dropped by the first and presented as *confirmed* by the second; one whose run
 * id did not match the id format was presented as confirmed by the first and a
 * candidate by the second. Neither surface was reporting a different fact. They
 * were reporting different readers.
 *
 * The format gate is deliberately absent here. A value this build cannot parse is
 * still the record stating the chat belongs somewhere else, and resolving that to
 * `null` makes it indistinguishable from a record that never named a run — which
 * is the one case that reads as confirmed.
 */
const CONVERSATION_RUN_ID_PATHS = Object.freeze([
  ["runId"],
  ["governedRunId"],
  ["sessionRunId"],
  ["run", "runId"],
]);

export function conversationRecordRunId(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  for (const keys of CONVERSATION_RUN_ID_PATHS) {
    const value = readPath(record, keys);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Superseded by `conversationLinkPlacementForRun`, which answers the array and the
 * derived basis in one call. Removed rather than left exported: it had no callers
 * while the same rule was inlined in both readers, so it was a third wording of a
 * rule that already existed twice — an answer waiting to be called and to drift
 * from the two that were actually running.
 */

/**
 * How strongly a run is known to belong to a chat, strongest first.
 *
 * This is the field the binding consumer reads before it refuses to bind, and it
 * was decided by hand-written literal at twelve sites across two files. The two
 * files did not share words: one called a link whose run id belongs to a
 * different run `foreign_run_metadata_candidate`, the other had no name for that
 * case because it dropped the link instead. Same file on disk, two answers.
 *
 * Measured on this repository's state tree: of 5413 records, 3 carried a basis
 * and all 3 carried `transcript_file_verified`, the value the activation hook
 * writes after it opens the transcript file and matches its identity. None
 * carried any of the six the display layer emits, because those six only ever
 * existed as computed output. For the one run whose artifact and compact
 * projection both survive, the artifact said `transcript_file_verified` and the
 * projection derived from it said `exact_metadata` — the stored basis was the
 * stronger of the two and was overwritten by the weaker one, then persisted.
 *
 * Neither blanket rule is right, and two fixtures already in the suite pin the
 * two directions: one declares `transcript_file_verified` and is discarded, so
 * forwarding is required; another declares `exact_metadata` on a link whose run
 * id equals the run's, so forwarding would be a downgrade. The rule is therefore
 * the stronger of stored and derived, which is why this is an ordering and not a
 * set.
 *
 * The verifying/unproven split is not invented here — it is where each value was
 * already being pushed. The first five went into the verified array at every
 * site, the last three into the candidate array.
 */
export const CONVERSATION_MATCH_BASIS = Object.freeze([
  "transcript_file_verified",
  "host_reported_binding",
  "exact_run_id",
  "exact_thread_id",
  "exact_metadata",
  "foreign_run_metadata_candidate",
  "metadata_candidate",
  "title_time_project_similarity",
]);

const MATCH_BASIS_RANK = new Map(CONVERSATION_MATCH_BASIS.map((basis, index) => [basis, index]));
const MATCH_BASIS_UNKNOWN_RANK = CONVERSATION_MATCH_BASIS.length;
const MATCH_BASIS_VERIFYING = new Set(CONVERSATION_MATCH_BASIS.slice(0, 5));
const MATCH_BASIS_WEAKEST = CONVERSATION_MATCH_BASIS[CONVERSATION_MATCH_BASIS.length - 1];

/**
 * Stored records are untrusted input for the same reason refusals are: a file
 * written by a newer build may name a basis this one cannot rank. Such a value
 * becomes `null` so a caller falls back to what it derived, rather than printing
 * a raw enum at a reader or letting an unrankable string win a comparison.
 */
export function normalizeConversationMatchBasis(value) {
  return typeof value === "string" && MATCH_BASIS_RANK.has(value) ? value : null;
}

/**
 * Lower is stronger. An unknown value ranks below every known one instead of
 * comparing as equal, so it can never survive the comparison in
 * `conversationMatchBasisFor`.
 */
export function conversationMatchBasisRank(value) {
  const rank = typeof value === "string" ? MATCH_BASIS_RANK.get(value) : undefined;
  return rank === undefined ? MATCH_BASIS_UNKNOWN_RANK : rank;
}

/**
 * Resolves the basis a reader sees from what the record stored and what the
 * caller could prove at hand, taking whichever is stronger.
 *
 * A stored verifying basis cannot be forwarded onto a link the caller derived as
 * unproven. Position in the candidate array is the caller's declaration that
 * nothing was proven, and a candidate labelled `transcript_file_verified`
 * contradicts the array holding it — a contradiction a reader resolves by
 * trusting the label. No producer writes a basis into a candidate array today
 * (measured 0 of 5413), so this closes the trap before a writer opens it.
 */
export function conversationMatchBasisFor(stored, derived) {
  const atHand = normalizeConversationMatchBasis(derived) ?? MATCH_BASIS_WEAKEST;
  const declared = normalizeConversationMatchBasis(stored);
  if (!declared) return atHand;
  if (!MATCH_BASIS_VERIFYING.has(atHand) && MATCH_BASIS_VERIFYING.has(declared)) return atHand;
  return conversationMatchBasisRank(declared) < conversationMatchBasisRank(atHand) ? declared : atHand;
}

function conversationLinkKey(link) {
  return `${link.sourceRuntime}:${link.conversationRef}`;
}

/**
 * Folds repeated descriptions of one chat into one link per bucket, deciding by
 * evidence rather than by arrival order.
 *
 * One record can describe the same chat more than once — its `sourceConversation`
 * and an entry in its `conversationLinks` array can both name it, with different
 * provenance. Three readers folded that differently: the run panel kept one `seen`
 * set across both buckets so the first description won and dropped every later one
 * including stronger ones from the other bucket, the session list folded per bucket
 * with a `Map` so the last one won, and the client normalizer folded first-wins per
 * bucket. Two of the three decided by order, and the two surface readers enumerate
 * a record's descriptions in different orders — so one file read `candidate` in the
 * panel and `verified` in the list, with neither reading a different fact.
 *
 * Order independence is the property that makes them agree, so the fold is defined
 * without reference to position: the strongest basis survives within a bucket, and
 * a reference the verified bucket holds is never also offered as a candidate.
 * Fields the winner does not carry are taken from the description that did, because
 * a title is display text rather than provenance and dropping it leaves a row
 * showing a bare id the record could have named.
 */
export function mergeConversationLinkBuckets(verifiedLinks, candidateLinks) {
  const collapse = (links) => {
    const byKey = new Map();
    for (const link of Array.isArray(links) ? links : []) {
      if (!link || typeof link !== "object" || Array.isArray(link)) continue;
      const key = conversationLinkKey(link);
      const held = byKey.get(key);
      if (!held) {
        byKey.set(key, link);
        continue;
      }
      const linkWins = conversationMatchBasisRank(link.matchBasis) < conversationMatchBasisRank(held.matchBasis);
      byKey.set(key, linkWins ? { ...held, ...link } : { ...link, ...held });
    }
    return [...byKey.values()];
  };
  const verified = collapse(verifiedLinks);
  const verifiedKeys = new Set(verified.map(conversationLinkKey));
  return {
    verified,
    candidates: collapse(candidateLinks).filter((link) => !verifiedKeys.has(conversationLinkKey(link))),
  };
}

/**
 * Which array a run's reference to a chat belongs in, and the basis to derive for
 * it — one answer, because the two used to be decided separately in two readers
 * that wrote the same rule differently.
 *
 * A `sourceConversation` nested inside a run's own record is a first-party claim
 * by that run about itself, the same way `status` is: it does not have to repeat
 * the run id to be about the run. So silence about the run id is the producer's
 * normal shape, not a missing fact, and the reference stays verified. Demoting it
 * to a candidate would push records written before that field existed back onto
 * the "no chat link" sentence, which is the opposite of what this surface needs.
 * A run id naming a *different* run is the one contradiction, and that reference
 * is still shown — as a foreign candidate, because naming another run is a fact
 * about the reference rather than a reason to display nothing.
 *
 * This is a consolidation, not a repair of an observed symptom. The run panel
 * wrote the comparison as `declared === runId` and the session list wrote it as
 * `runId && declared === runId`; the unguarded form derives `exact_run_id` from
 * two absent values when the run id is exactly `null`, so the two would name
 * different provenance for one file. Measured: both call sites prove a non-empty
 * run id before reaching here (`buildLiveCompactProjection` throws on a falsy
 * one, `durableOnlySnapshot` returns early), so no surface ever printed it. The
 * point of one owner is that the next caller cannot pick the wrong wording.
 *
 * The array and the basis are returned together because a caller holding two
 * separate answers can put a record in the verified array while deriving a
 * candidate-level basis for it; the catalog derived one basis up front and then
 * chose an array below it.
 */
export function conversationLinkPlacementForRun(record, runId) {
  const safe = record && typeof record === "object" && !Array.isArray(record) ? record : null;
  if (!safe) return { proven: false, derivedBasis: "metadata_candidate" };
  const declared = conversationRecordRunId(safe);
  const comparable = Boolean(declared && runId);
  if (comparable && declared !== runId) return { proven: false, derivedBasis: "foreign_run_metadata_candidate" };
  return { proven: true, derivedBasis: comparable ? "exact_run_id" : "exact_metadata" };
}

/**
 * The same answer for an entry stored inside a links array, where standing can
 * also come from a flag or from the array the entry was found in.
 *
 * The reachable bug this closes: an entry that is stamped verified but carries no
 * run id used to derive `exact_thread_id`, which says a thread id was compared.
 * Nothing compares one here — the entry has no run id to compare, let alone a
 * thread id. Position and flags prove *standing* ("this was already accepted"),
 * never a *basis* ("here is what we matched on"), and a display layer must not
 * name evidence stronger than what it read.
 *
 * Measured, because the two facts needed to reach it are both ordinary. A run
 * with an artifact and a compact projection on disk — the common shape, since the
 * projection is written from the artifact — has its own compact folded back in by
 * `conversationLinkRecordView`, which stamps `linkState: "verified"` on entries it
 * found in a verified array. The compact stores no per-entry run id, so the fold
 * produced exactly that shape, and for a reference naming no run the session row
 * said `exact_thread_id` while the run panel said `exact_metadata`: one file, two
 * provenance claims, and the louder one invented. It stayed hidden because the
 * rank comparison in `conversationMatchBasisFor` masks it whenever the stored
 * basis is stronger — a record carrying `transcript_file_verified` or
 * `exact_run_id` agreed, and only the silent shape diverged.
 *
 * `exact_thread_id` keeps its place in the vocabulary: a hook may still write it
 * after actually matching a thread id, and this file has to be able to read and
 * rank a stored one. What changed is that nothing derives it from an absence.
 *
 * The run-id comparison is guarded the same way as the placement above, and for
 * the same measured reason: the session list wrote `expectedRunId && linked &&
 * linked !== expectedRunId` and the run panel wrote `Boolean(declared) &&
 * declared !== runId`, which disagree only when the run's own id is falsy, and
 * both call sites prove a non-empty run id first.
 */
export function declaredLinkPlacementForRun(record, runId) {
  const safe = record && typeof record === "object" && !Array.isArray(record) ? record : null;
  if (!safe) return { proven: false, derivedBasis: "metadata_candidate" };
  const declared = conversationRecordRunId(safe);
  if (declared && runId) {
    return declared === runId
      ? { proven: true, derivedBasis: "exact_run_id" }
      : { proven: false, derivedBasis: "foreign_run_metadata_candidate" };
  }
  const stampedVerified = safe.verified === true || safe.matchState === "verified" || safe.linkState === "verified";
  return stampedVerified
    ? { proven: true, derivedBasis: "exact_metadata" }
    : { proven: false, derivedBasis: "metadata_candidate" };
}

/**
 * Where each kind of stored record keeps its conversation fields.
 *
 * Two kinds of file describe one run: the governed artifact carries these at the
 * top level, and the compact live projection nests them under `run` with
 * different names. The runtime name already had `["run", "sourceRuntime"]` in the
 * table above, so a compact-only run printed the right tool while reporting
 * 未关联 for a link its own record proved — the reader looked for the links at a
 * depth the compact never uses. That is not a rare shape: raw reads are capped,
 * and a run whose artifact is past the cap has nothing but the compact left.
 *
 * The candidate list stays separate from the verified one because position is the
 * declaration in both kinds — the artifact's own producer derives its state from
 * which array a link landed in, and so does the compact's. Folding them together
 * and re-deriving from a per-entry flag would demote every compact link to a
 * candidate, since the projection stores no such flag.
 *
 * Only the projection's arrays are verified by position. The artifact's
 * `conversationLinks` mixes proven and unproven entries and is sorted by the
 * per-entry flag downstream, so stamping standing onto those would promote every
 * candidate a discovery pass ever recorded.
 */
const CONVERSATION_LINK_RECORD_PATHS = Object.freeze({
  sourceConversation: Object.freeze([["sourceConversation"], ["run", "sourceConversation"]]),
  conversationLinkRefusal: Object.freeze([
    ["conversationLinkRefusal"],
    ["run", "conversationLinkRefusal"],
    ["session", "conversationLinkRefusal"],
  ]),
  declaredLinks: Object.freeze([["conversationLinks"], ["runtimeConversationLinks"]]),
  linksVerifiedByPosition: Object.freeze([["run", "verifiedLinks"], ["session", "verifiedLinks"]]),
  candidates: Object.freeze([
    ["conversationCandidates"],
    ["candidateConversationLinks"],
    ["run", "candidateLinks"],
    ["session", "candidateLinks"],
  ]),
});

function firstRecordValue(record, paths, accept) {
  for (const keys of paths) {
    const value = readPath(record, keys);
    if (accept(value)) return value;
  }
  return null;
}

function collectRecordLinks(record, paths) {
  return paths.flatMap((keys) => {
    const value = readPath(record, keys);
    return Array.isArray(value) ? value.filter((entry) => entry && typeof entry === "object") : [];
  });
}

/**
 * Normalizes one stored record of either kind into the top-level conversation
 * vocabulary, so a caller merging several records never has to know which file
 * each one came from. Link standing is stamped from the array a link was stored
 * in: the compact projection records no per-entry verified flag, and inferring
 * one from its absence is what turned proven links into candidates.
 *
 * The stamp is written after the spread, not before it. Spreading last let a
 * stored `linkState` on an entry inside `run.verifiedLinks` outrank the array it
 * was found in, which makes the stamp a no-op for exactly those entries and
 * sends them back to the unlinked sentence. No producer in this repository
 * writes a per-entry `linkState` today — both writers of that array emit a fixed
 * five-key shape — so this ordering closes the trap before a new writer opens
 * it rather than repairing an observed row.
 */
export function conversationLinkRecordView(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { sourceConversation: null, conversationLinkRefusal: null, conversationLinks: [], conversationCandidates: [] };
  }
  return {
    sourceConversation: firstRecordValue(
      record,
      CONVERSATION_LINK_RECORD_PATHS.sourceConversation,
      (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value),
    ),
    conversationLinkRefusal: firstRecordValue(
      record,
      CONVERSATION_LINK_RECORD_PATHS.conversationLinkRefusal,
      (value) => typeof value === "string" && value.trim() !== "",
    ),
    conversationLinks: [
      ...collectRecordLinks(record, CONVERSATION_LINK_RECORD_PATHS.declaredLinks),
      ...collectRecordLinks(record, CONVERSATION_LINK_RECORD_PATHS.linksVerifiedByPosition)
        .map((entry) => ({ ...entry, linkState: "verified" })),
    ],
    conversationCandidates: collectRecordLinks(record, CONVERSATION_LINK_RECORD_PATHS.candidates),
  };
}
