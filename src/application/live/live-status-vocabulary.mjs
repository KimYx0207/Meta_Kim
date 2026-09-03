/**
 * One status vocabulary for every Live surface.
 *
 * The list surface and the detail surface each read the same stored `status`,
 * and each used to carry its own copy of the vocabulary. A word added to one
 * copy and not the other does not fail loudly: the unknown word falls through to
 * `unknown`, so the same run announced a recorded outcome in the list and "not
 * enough records to judge" once opened. Two answers for one record is worse than
 * either answer alone, because a reader cannot tell which surface to believe.
 *
 * Aliases are consulted before the vocabulary, so a word present in both the
 * alias table and the vocabulary never reaches the vocabulary. `partial` sat in
 * both, which is why adding it to the vocabulary alone changed nothing.
 *
 * Surfaces still own their own gating: a list may require independent completion
 * evidence before it says `completed`, while a detail view reading the artifact
 * directly does not. What they must not own separately is which words exist and
 * what each word tells the reader.
 */

export const LIVE_STATUS_ALIASES = Object.freeze(new Map([
  ["running", "active"],
  ["in_progress", "active"],
  ["in-progress", "active"],
  ["started", "active"],
  ["success", "completed"],
  ["succeeded", "completed"],
  ["pass", "completed"],
  ["passed", "completed"],
  ["done", "completed"],
  ["failure", "failed"],
  ["error", "failed"],
  ["planned_not_executed", "pending"],
  ["pending_execution", "pending"],
  ["selected_not_invoked", "pending"],
  ["skipped", "pending"],
  ["unknown", "in_doubt"],
  ["stale", "in_doubt"],
  ["uncertain", "in_doubt"],
]));

/**
 * `partial`, `superseded`, and `archived_legacy` each name a specific outcome
 * that runs on disk actually record: executed and verified but refused release,
 * ended early because a newer prompt replaced it, and reconciled out of a legacy
 * active state. Leaving them out flattened all three into a sentence claiming
 * nothing was known about runs whose records are exact.
 */
export const LIVE_STATUSES = Object.freeze(new Set([
  "active",
  "completed",
  "pending",
  "failed",
  "blocked",
  "cancelled",
  "session_stopped",
  "archived",
  "partial",
  "superseded",
  "archived_legacy",
  "in_doubt",
]));

/**
 * Outcomes whose display never depends on whether the run is still active. Each
 * surface decides whether it is allowed to reach a given outcome; the wording
 * once it does is shared, so the same record cannot be described two ways.
 */
export const LIVE_TERMINAL_STATUS_DISPLAY = Object.freeze({
  completed: Object.freeze({
    displayState: "completed",
    statusReason: "已找到同一运行、同一任务的可信完成证据。",
  }),
  failed: Object.freeze({
    displayState: "failed",
    statusReason: "已记录可信失败结果。",
  }),
  blocked: Object.freeze({
    displayState: "blocked",
    statusReason: "任务被明确阻塞，尚未完成。",
  }),
  cancelled: Object.freeze({
    displayState: "cancelled",
    statusReason: "任务已取消，不能视为完成。",
  }),
  partial: Object.freeze({
    displayState: "partial",
    statusReason: "执行和验证都有记录，但这次运行没有达到可对外发布的标准。",
  }),
  superseded: Object.freeze({
    displayState: "superseded",
    statusReason: "这次运行被新的任务替代，因此提前结束。",
  }),
  archived_legacy: Object.freeze({
    displayState: "archived_legacy",
    statusReason: "这是早期版本留下的运行记录，已归档，不再更新。",
  }),
});

export function normalizeLiveStatus(value, fallback = "in_doubt") {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase().replace(/\s+/gu, "_");
  const aliased = LIVE_STATUS_ALIASES.get(normalized) || normalized;
  return LIVE_STATUSES.has(aliased) ? aliased : fallback;
}

/**
 * Returns the shared wording for an outcome that needs no gating, or null when
 * the caller still has to decide. Null means "not my decision", never "unknown
 * outcome" — collapsing those two is the failure this module exists to prevent.
 */
export function liveTerminalStatusDisplay(status) {
  return Object.hasOwn(LIVE_TERMINAL_STATUS_DISPLAY, status)
    ? LIVE_TERMINAL_STATUS_DISPLAY[status]
    : null;
}
