import { normalizeLiveDeliverables } from "./live-feedback-draft.mjs";

/** Keep overview copy bounded; callers render these values through textContent. */
function overviewText(value) {
  return typeof value === "string" ? value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 240) : "";
}

/** Compare explicit event states without treating a planned row as execution. */
function overviewState(value) {
  return overviewText(value).replace(/([a-z])([A-Z])/gu, "$1_$2").toLowerCase().replace(/[\s-]+/gu, "_");
}

/** A missing raw state must not inherit the page's queued display fallback. */
function overviewActivityState(record) {
  return overviewState(Object.prototype.hasOwnProperty.call(record, "activityState") ? record.activityState : record.state || record.status);
}

/** Native return counters never share the accepted-completion counter. */
export function normalizeLiveExecutionSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.acceptanceState !== "unproven") return null;
  const keys = ["observedAgentCount", "returnedAgentCount", "activeAgentCount", "returnedToolCount", "failedToolCount"];
  if (keys.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 4096) || value.returnedAgentCount + value.activeAgentCount !== value.observedAgentCount || value.failedToolCount > value.returnedToolCount) return null;
  return Object.fromEntries([...keys.map((key) => [key, value[key]]), ["acceptanceState", "unproven"]]);
}

/** Whitelist the server's bounded revision view, never arbitrary fix artifacts. */
export function normalizeLiveRevisionReview(value, runId) {
  const items = (Array.isArray(value?.items) ? value.items : []).slice(0, 64).flatMap((item) => {
    if (item?.runId !== runId || !/^revision:[a-f0-9]{20}$/u.test(item.id || "") || !/^finding:[a-f0-9]{20}$/u.test(item.findingId || "")) return [];
    const state = ["recorded", "pending_verification", "verification_unconfirmed", "verified"].includes(item.state) ? item.state : "verification_unconfirmed";
    return [{ id: item.id, runId, findingId: item.findingId, actionId: /^action:[a-f0-9]{20}$/u.test(item.actionId || "") ? item.actionId : null,
      taskPacketId: /^task:[a-f0-9]{20}$/u.test(item.taskPacketId || "") ? item.taskPacketId : null,
      deliverableId: /^deliverable:[a-f0-9]{24}$/u.test(item.deliverableId || "") ? item.deliverableId : null,
      contentVersion: /^sha256:[a-f0-9]{64}$/u.test(item.contentVersion || "") ? item.contentVersion : null, state }];
  });
  return { state: items.length ? "reported" : "not_reported", items };
}

/** Offer an explicit same-project navigation; never merge this into a plan. */
export function resolveLiveNativeActivity(project, currentRunId, projectId) {
  if (!project || !projectId || project.projectId !== projectId) return null;
  return (Array.isArray(project.sessions) ? project.sessions : []).find((session) => session?.runId !== currentRunId && session.observationKind === "native_execution" && session.sourceRuntime === "codex" && session.conversationLinkState === "verified" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(session.conversationRef || "") && new RegExp("^native-codex-" + session.conversationRef + "-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$", "u").test(session.runId || "")) || null;
}

/** Only a parseable, explicitly supplied timestamp can order observed activity. */
function overviewTimestamp(value) {
  const text = overviewText(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/u);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "0", offsetHour = "0", offsetMinute = "0"] = match.map((part, index) => index ? Number(part ?? 0) : part);
  const monthDays = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1] || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** Host replay's display mapping needs its independent actual-invocation fact. */
function overviewHostExecutionEvent(record, snapshot) {
  const kinds = { agent_event: "agent", tool_started: "tool_start", tool_finished: "tool_end", host_failure: "failure" };
  const kind = kinds[overviewState(record.eventType || record.type || record.kind)];
  if (!kind || record.executionObserved !== true || overviewState(record.kind) !== kind || overviewState(record.stage || record.chapter) !== "execution" || record.proofValid === false) return false;
  const node = (Array.isArray(snapshot.nodes) ? snapshot.nodes : []).find((item) => item?.id === record.nodeId);
  return node?.declaredNotStarted !== true;
}

/** Select actual same-run observations; run/session update times are never read. */
function overviewExecutionActivity(snapshot, runId) {
  const candidates = [];
  const add = (record, source, label, detail, times) => {
    if (!record || record.synthetic === true || (record.runId && record.runId !== runId)) return;
    const state = overviewActivityState(record);
    if (["queued", "pending", "planned", "declared", "not_executed"].includes(state)) return;
    const timestamps = times.map(overviewTimestamp).filter(Boolean).sort();
    candidates.push({ source, id: overviewText(record.id), nodeId: overviewText(record.nodeId),
      label: overviewText(label), detail: overviewText(detail), at: timestamps.at(-1) || null });
  };
  for (const record of Array.isArray(snapshot.toolCalls) ? snapshot.toolCalls : []) {
    if (!record || typeof record !== "object") continue;
    const state = overviewActivityState(record);
    if (record.executionObserved === true || ["running", "active", "completed", "failed", "returned", "executed", "observed"].includes(state)) {
      const times = Array.isArray(record.activityTimestamps) ? record.activityTimestamps
        : [record.activityAt, record.startedAt, record.endedAt, record.completedAt, record.occurredAt, record.at, record.timestamp];
      add(record, "tool", record.name || record.toolName, record.summary, times);
    }
  }
  const events = Array.isArray(snapshot.replay) ? snapshot.replay : snapshot.replay?.events;
  const hostTypes = new Set(["agent_event", "tool_started", "tool_finished", "host_failure"]);
  const executionTypes = new Set(["tool_started", "tool_returned", "tool_completed", "tool_failed", "tool_call_started", "tool_call_completed", "tool_call_failed", "command_started", "command_returned", "command_completed", "command_failed", "agent_spawned", "agent_returned", "agent_completed", "worker_started", "worker_completed", "execution_started", "execution_completed"]);
  for (const record of Array.isArray(events) ? events : []) {
    if (!record || typeof record !== "object") continue;
    const type = overviewState(record.eventType || record.type || record.kind);
    const observed = hostTypes.has(type) ? overviewHostExecutionEvent(record, snapshot)
      : record.executionObserved === true || executionTypes.has(type);
    if (observed) {
      add(record, "event", record.label || record.type, record.summary, [record.at, record.timestamp, record.occurredAt]);
    }
  }
  for (const record of Array.isArray(snapshot.evidence) ? snapshot.evidence : []) {
    if (!record || typeof record !== "object") continue;
    if (record.executionObserved === true && record.runId === runId && !overviewState(record.evidenceKind).includes("structural")) {
      add(record, "evidence", record.label, record.detail || record.summary, [record.at, record.observedAt, record.occurredAt]);
    }
  }
  const dated = candidates.filter((item) => item.at).sort((left, right) => right.at.localeCompare(left.at) || left.id.localeCompare(right.id));
  const undated = candidates.filter((item) => !item.at).sort((left, right) => left.id.localeCompare(right.id));
  return { item: dated[0] || undated[0] || null, undatedCount: undated.length };
}

/**
 * Summarize the selected snapshot without adding completion or availability truth.
 * A descriptor marked declared stays out of available results; array order never
 * claims a result is newest. Inactive historical rows cannot become current work.
 */
export function resolveLiveRunOverview(snapshot) {
  const run = snapshot?.run;
  if (!run || !overviewText(run.id || run.runId)) return { state: "empty", task: null, result: { items: [], declaredCount: 0 }, blocker: null, activity: { item: null, undatedCount: 0 } };
  const runId = overviewText(run.id || run.runId);
  const state = overviewState(run.displayState || run.status);
  const planned = state === "planned" || run.executionEvidenceState === "structural_planning_only";
  const active = !planned && run.active === true;
  const nodes = (Array.isArray(snapshot.nodes) ? snapshot.nodes : []).filter((node) => node && !["stage", "chapter", "stage_summary", "workflow"].includes(overviewState(node.kind)) && (!node.runId || node.runId === runId));
  const activity = planned ? { item: null, undatedCount: 0 } : overviewExecutionActivity(snapshot, runId);
  const activeNodes = active ? nodes.filter((node) => !node.declaredNotStarted && node.executionState !== "not_executed"
    && (node.active === true || ["active", "running"].includes(overviewState(node.displayState || node.status)))) : [];
  activeNodes.sort((left, right) => Number(right.id === activity.item?.nodeId) - Number(left.id === activity.item?.nodeId) || Number(left.isMain === true) - Number(right.isMain === true) || overviewText(left.id).localeCompare(overviewText(right.id)));
  const current = activeNodes[0];
  const blockers = planned ? [] : nodes.filter((node) => ["blocked", "failed"].includes(overviewState(node.displayState || node.status)) && !node.declaredNotStarted);
  blockers.sort((left, right) => overviewText(left.id).localeCompare(overviewText(right.id)));
  const blocked = blockers[0];
  const runBlocked = ["blocked", "failed"].includes(state);
  const deliverables = normalizeLiveDeliverables(snapshot.deliverables, runId);
  return {
    state: planned ? "planned" : active ? "active" : state === "completed" ? "completed" : runBlocked ? "blocked" : "historical",
    task: current ? { label: overviewText(current.task) || overviewText(current.label), nodeId: overviewText(current.id), moreCount: activeNodes.length - 1 } : null,
    result: { items: deliverables.filter((item) => item.availability === "available"), declaredCount: deliverables.filter((item) => item.availability === "declared").length },
    blocker: blocked ? { kind: "blocked", label: overviewText(blocked.statusReason), nodeLabel: overviewText(blocked.label), nodeId: overviewText(blocked.id), moreCount: blockers.length - 1 }
      : runBlocked ? { kind: "blocked", label: overviewText(run.statusReason), nodeLabel: "", nodeId: "", moreCount: 0 }
        : overviewText(run.statusReason) ? { kind: "status", label: overviewText(run.statusReason), nodeLabel: "", nodeId: "", moreCount: 0 } : null,
    activity,
    execution: run.observationKind === "native_execution" ? normalizeLiveExecutionSummary(run.executionSummary) : null,
    revisionReview: normalizeLiveRevisionReview(snapshot.revisionReview, runId),
  };
}

/** Ship the same tested selectors into the dependency-free page. */
export function serializeLiveRunOverviewResolvers() {
  return [overviewText, overviewState, overviewActivityState, normalizeLiveExecutionSummary, normalizeLiveRevisionReview, resolveLiveNativeActivity, overviewTimestamp, overviewHostExecutionEvent, overviewExecutionActivity, resolveLiveRunOverview]
    .map((resolver) => resolver.toString()).join("\n");
}
