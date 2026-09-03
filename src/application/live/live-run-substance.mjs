/**
 * Substance classification for a governed run.
 *
 * A run can be activated and then do nothing at all. That happens often enough
 * to dominate a directory: one full scan of a long-lived project found 994 of
 * 1004 persisted runs sitting at Critical with zero completed stages, and all
 * 1004 carrying zero worker lifecycle records and zero replay events. Read
 * through lifecycle status alone those rows are indistinguishable from runs that
 * did real work and stopped, so the directory read as a wall of identical empty
 * entries.
 *
 * Substance is therefore its own axis, orthogonal to lifecycle status. It
 * answers "did anything happen" and nothing else. It never says a run succeeded,
 * never upgrades `in_doubt`, and never downgrades a run that has any evidence:
 * one real signal is enough to make a run substantive, and no signal can take
 * that back.
 *
 * The service, the hub catalog and the retention planner all read this one
 * definition. Two independent definitions of "substantive" would let the
 * directory and the detail view disagree about the same run.
 */
export const RUN_SUBSTANCE_CLASSES = Object.freeze(["activation_only", "substantive"]);

export const RUN_SUBSTANCE_STAGE_ORDER = Object.freeze([
  "critical",
  "fetch",
  "thinking",
  "execution",
  "review",
  "meta-review",
  "verification",
  "evolution",
]);

export const RUN_SUBSTANCE_SOURCES = Object.freeze([
  "declared_by_status_envelope",
  "derived_from_status_fields",
]);

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function readKey(value, key) {
  const object = plainObject(value);
  return object ? object[key] : undefined;
}

function firstStageKey(record) {
  for (const holder of [record, readKey(record, "run")]) {
    for (const key of ["currentStageKey", "currentStage", "stage"]) {
      const candidate = readKey(holder, key);
      // Stage keys reach the read model in both `Execution` and `execution` form.
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim().toLowerCase();
      }
    }
  }
  return null;
}

function arrayLength(value) {
  return Array.isArray(value) ? value.length : null;
}

/**
 * Count completed stages across both shapes a caller can hold: a status envelope
 * carries a `completed` array, while a raw spine state carries a `stages` map.
 */
function completedStageCount(record) {
  const declared = arrayLength(readKey(record, "completed"));
  if (declared !== null) return declared;
  const stages = plainObject(readKey(record, "stages"));
  if (!stages) return 0;
  return RUN_SUBSTANCE_STAGE_ORDER.filter(
    (stage) => readKey(stages[stage], "status") === "completed",
  ).length;
}

/**
 * A status envelope carries a numeric `stageIndex`; a raw spine state carries
 * only a stage key. Returning `null` rather than `0` keeps "stage unknown"
 * distinguishable from "still at the entry stage".
 */
function stageIndexOf(record) {
  const declared = readKey(record, "stageIndex");
  if (Number.isSafeInteger(declared) && declared > 0) return declared;
  const position = RUN_SUBSTANCE_STAGE_ORDER.indexOf(firstStageKey(record) || "");
  return position < 0 ? null : position + 1;
}

/**
 * Classify one run record.
 *
 * `extra` carries the two signals a status record cannot know about itself:
 * whether a governed-execution artifact exists on disk, and how many replay
 * events it holds. Either one is real output even when the envelope never left
 * Critical, so callers that can see them should pass them.
 */
export function runSubstance(record, extra = {}) {
  const declared = RUN_SUBSTANCE_CLASSES.includes(readKey(record, "substanceClass"))
    ? readKey(record, "substanceClass")
    : null;
  const completedStages = completedStageCount(record);
  const workerRecords = arrayLength(readKey(record, "workerLifecycle")) ?? 0;
  // A declared worker task packet is real recorded output: the graph derives one
  // queued lifecycle record from each of them, so a run that declared any has
  // more than an activation receipt.
  const declaredWorkerPackets = arrayLength(readKey(record, "workerTaskPackets")) ?? 0;
  const stageIndex = stageIndexOf(record);
  const blockedOn = readKey(record, "blockedOn");
  const recordedBlocker = typeof blockedOn === "string" && blockedOn.trim() !== "";
  const artifactPresent = readKey(extra, "artifactPresent") === true;
  const declaredEventCount = readKey(extra, "eventCount");
  const eventCount = Number.isSafeInteger(declaredEventCount) && declaredEventCount > 0
    ? declaredEventCount
    : 0;
  const substantive =
    declared === "substantive" ||
    completedStages > 0 ||
    workerRecords > 0 ||
    declaredWorkerPackets > 0 ||
    (stageIndex !== null && stageIndex > 1) ||
    recordedBlocker ||
    artifactPresent ||
    eventCount > 0;
  return Object.freeze({
    substanceClass: substantive ? "substantive" : "activation_only",
    substanceSource: declared ? "declared_by_status_envelope" : "derived_from_status_fields",
    substanceSignals: Object.freeze({
      completedStages,
      workerRecords,
      declaredWorkerPackets,
      stageIndex,
      advancedBeyondEntryStage: stageIndex !== null && stageIndex > 1,
      recordedBlocker,
      artifactPresent,
      eventCount,
    }),
  });
}

/** Ordering weight for "substantive runs first". Higher sorts earlier. */
export function runSubstanceRank(substanceClass) {
  return substanceClass === "substantive" ? 1 : 0;
}

/**
 * Workers a record can prove it dispatched, or `null` when it declares nothing to
 * count. Absent and zero are different observations: a reader shown `0` concludes
 * the run dispatched nobody, which is a claim only a declared-but-empty collection
 * can support. Callers must keep `null` absent from their output rather than
 * defaulting it, or a mistyped field name upstream becomes indistinguishable from
 * a run that genuinely had no workers.
 *
 * Schema-version-1 artifacts are the reason this is its own reader. They carry
 * worker packets and carry no `nodes` collection at all, so a count derived from
 * nodes alone reports them as silent when their worker roster is right there —
 * measured at 16 of 44 rows on this project's own directory.
 *
 * The count means "workers this run dispatched", not "workers that reported
 * back", and the sources are read in that order rather than reconciled. A run
 * that dispatched four and heard from two has four task packets and two result
 * packets; publishing two would render the two silent workers as though they had
 * never existed, and those are exactly the ones a governance reader is looking
 * for. Overstating a roster is visible as workers with no result; understating it
 * is invisible, which is the failure this panel already had.
 */
export function runWorkerCount(record) {
  for (const readSource of WORKER_ROSTER_SOURCES) {
    const count = readSource(record);
    if (count !== null) return count;
  }
  return null;
}

/**
 * Ordered by how completely each collection describes the dispatched roster.
 * Task packets and lifecycle records carry one entry per worker; result packets
 * carry one per worker that reported, so they answer a narrower question and are
 * consulted only when no roster-shaped collection was declared.
 */
const WORKER_ROSTER_SOURCES = Object.freeze([
  (record) => arrayLength(readKey(record, "workerTaskPackets")),
  (record) => arrayLength(readKey(record, "workerLifecycle")),
  (record) => arrayLength(readKey(record, "workerResultPackets")),
  (record) => workerNodeCount(record),
]);

/**
 * A compact projection has no worker packets; its roster is the agent nodes. The
 * main thread node is the dispatcher rather than a dispatched worker, so counting
 * it would report one worker for a run that dispatched none.
 *
 * Nodes that declare no kind at all cannot be split into workers and scaffolding,
 * so the collection stays unread rather than resolving to a zero that would claim
 * the run dispatched nobody.
 */
function workerNodeCount(record) {
  const nodes = readKey(record, "nodes");
  if (!Array.isArray(nodes)) return null;
  if (nodes.length && !nodes.some((node) => typeof readKey(node, "kind") === "string")) return null;
  return nodes.filter(
    (node) => readKey(node, "kind") === "agent" && readKey(node, "isMain") !== true,
  ).length;
}
