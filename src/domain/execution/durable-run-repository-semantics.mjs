export const DURABLE_RUN_REPOSITORY_SEMANTICS_SCHEMA_VERSION =
  "durable-run-repository-semantics-v1";

export const DURABLE_RUN_REPOSITORY_REQUIRED_METHODS = Object.freeze([
  "createRun",
  "forkRun",
  "appendEvent",
  "claimRunCoordinator",
  "heartbeatRunCoordinator",
  "releaseRunCoordinator",
  "setRunTerminalStatus",
  "getEvents",
  "verifyEventChain",
  "claimNode",
  "heartbeatNode",
  "completeNode",
  "failNode",
  "resumeRun",
  "prepareEffect",
  "markEffectDispatchStarted",
  "markUnresolvedEffectsInDoubt",
  "reconcileEffect",
  "reuseCompletedEffect",
  "recordTraversedEdge",
  "getCheckpointLineage",
  "projectRun",
  "replayRun",
  "close",
]);

export const DURABLE_RUN_REPOSITORY_INVARIANTS = Object.freeze({
  executionTruth: "governed_events_and_current_head",
  transactionMode: "sqlite_begin_immediate",
  eventOrdering: "per_run_monotonic_cursor",
  eventIdentity: "append_only_exact_idempotency",
  concurrency: "cursor_and_version_compare_and_set",
  checkpoint: "immutable_event_bound_projection",
  claim: "owner_attempt_lease_and_fence_bound",
  effect: "unresolved_effects_block_completion",
  dualWriteAllowed: false,
  projectionMayAuthorizeExecution: false,
});
