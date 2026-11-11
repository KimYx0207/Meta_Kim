/**
 * First-party inspection guidance; no log text becomes an executable remedy.
 * Method references (no upstream code or runtime dependency):
 * https://github.com/garrytan/gbrain/blob/dbf51462356df95812156de4529af97a11e40f59/docs/protocol/AGENT_OPERATOR_v1.md
 * https://github.com/garrytan/gstack/blob/0ead11c8e20a82e249f36c3abf89599dfe602324/devex-review/SKILL.md
 */
export function buildCodexRecoveryGuidance(report) {
  const findings = [];
  const add = (code, severity, summary, actionId, description, expected) => findings.push({
    code,
    severity,
    summary,
    nextAction: { id: actionId, readOnly: true, description },
    verification: { readOnly: true, expected },
  });
  const invalidLog = report.malformedLineCount > 0;
  const failureObserved = report.turn.failed || report.conclusion.processExitFailure ||
    report.conclusion.fatalErrorCount > 0;
  const completionMarkers = report.turn.completed && report.turn.exitReceipt.observed &&
    report.turn.exitReceipt.success && !invalidLog && !failureObserved;

  if (invalidLog) add(
    "CODEX_LOG_PARSE_INCOMPLETE", "warning",
    "Some log lines could not be parsed; missing evidence does not establish an operation failure.",
    "inspect_original_log",
    "Preserve the original log and inspect the reported malformed line numbers. Obtain a complete export before making a run-level judgment.",
    ["replacement log parses without losing the original source", "relevant events are bound to the affected run and turn"],
  );
  if (failureObserved) add(
    "CODEX_RUNTIME_FAILURE_OBSERVED", "error",
    "The file contains a failed turn, a fatal marker or a nonzero process exit; earlier effects may still have completed.",
    "inspect_failed_operation",
    "Find the affected run, turn and operation in the original host record, then reconcile its status and receipts before choosing a scoped correction.",
    ["failure is bound to the affected operation", "existing effects and active attempts are accounted for", "correction addresses an observed failure without repeating completed effects"],
  );
  if (completionMarkers) add(
    "CODEX_COMPLETION_MARKERS_UNBOUND", "info",
    "Turn completion and successful exit markers are present, but this file-level replay does not join them to one run or operation.",
    "verify_completion_receipts",
    "Inspect the host's run and operation receipts and the existing deliverable. Preserve completed work; do not rerun it merely to recover missing display events.",
    ["completion and exit belong to the affected run and turn", "existing deliverable satisfies its acceptance criteria"],
  );
  else if (!invalidLog && !failureObserved) add(
    "CODEX_OUTCOME_UNRESOLVED", "warning",
    "A complete outcome and exit receipt have not been established; the operation may be running, completed or partly applied.",
    "reconcile_operation_outcome",
    "Query the original host or authoritative operation state using its existing identifier. Inspect completed receipts and in-flight work before considering another attempt.",
    ["affected run, turn and operation are identified", "authoritative status distinguishes active, completed, failed and partly applied work"],
  );
  if (report.eventStream.lagWarningCount > 0 || report.eventStream.droppedEventCount > 0) add(
    "CODEX_EVENT_STREAM_LAG", "warning",
    "Event delivery lag or dropped events were observed; these markers alone do not establish the task outcome.",
    "inspect_host_event_receipts",
    "Compare the original host record and operation receipts with the visible event stream. Recover the missing status display without replaying completed actions.",
    ["event gaps are distinguished from operation failure", "any completion claim has bound operation evidence"],
  );
  if (report.skillBudget.warningCount > 0) add(
    "CODEX_SKILL_METADATA_BUDGET", "warning",
    "The host reported omitted or shortened skill metadata; this does not establish a cause for a turn or transport failure.",
    "inspect_skill_inventory",
    "Compare the host-visible skill inventory with the skills needed for the current task. Identify redundant or oversized descriptions and their owners before selecting a narrower loadout.",
    ["required skills remain discoverable in a fresh host observation", "any inventory correction preserves user-owned skills and settings"],
  );
  if (report.runtimeDiagnostics.capabilityDefinitionWarningCount > 0) add(
    "CODEX_CAPABILITY_DEFINITION_WARNING", "warning",
    "An invalid or duplicate agent definition was reported; this item alone is not a fatal process result.",
    "inspect_definition_ownership",
    "Locate the reported definition in the capability inventory, check its declared owner and schema errors, and choose that owner's repair route.",
    ["the affected definition passes the host schema check", "unrelated and user-owned definitions remain intact"],
  );
  if (report.runtimeDiagnostics.deprecationWarningCount > 0) add(
    "CODEX_DEPRECATION_WARNING", "warning",
    "The host reported a deprecated setting or surface; this item alone does not justify restarting the task.",
    "inspect_runtime_migration",
    "Check the installed host version and its documented migration for the named setting before changing configuration.",
    ["the replacement is supported by the installed host", "a read-only configuration check confirms the resulting setting"],
  );
  if (report.runtimeDiagnostics.otherItemErrorCount > 0) add(
    "CODEX_ITEM_ERROR_OBSERVED", "warning",
    "An item-level error needs inspection; successful turn markers alone do not prove that item's outcome.",
    "inspect_affected_item",
    "Match the item to its operation and inspect its receipt. Keep independent work moving while resolving the affected item.",
    ["the affected item's status and any side effects are reconciled", "task acceptance accounts for the item's actual result"],
  );

  return {
    schemaVersion: "codex-diagnostic-recovery-v1",
    diagnosticOnly: true,
    runTurnBound: false,
    primaryCode: findings[0].code,
    findings,
    commandSource: "none_first_party_inspection_guidance_only",
    independentWork: "continue_within_current_scope",
    retryPolicy: {
      mode: completionMarkers ? "verify_completion_without_replay" : "reconcile_before_retry",
      automaticRetryAllowed: false,
      replayCompletedEffects: false,
      outcomeReconciliationRequired: true,
      requiredEvidence: [
        "affected_run_turn_and_operation_binding",
        "authoritative_operation_status_and_existing_receipts",
        "no_active_attempt_and_no_completed_effect_to_replay",
        failureObserved
          ? "corrected_failure_basis_and_current_scope_authorization"
          : "confirmed_remaining_work_and_current_scope_authorization",
      ],
    },
  };
}
