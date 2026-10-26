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
  const keys = ["observedAgentCount", "returnedAgentCount", "unconfirmedAgentCount", "returnedToolCount", "failedToolCount"];
  if (keys.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 4096) || value.returnedAgentCount + value.unconfirmedAgentCount !== value.observedAgentCount || value.failedToolCount > value.returnedToolCount) return null;
  return Object.fromEntries([...keys.map((key) => [key, value[key]]), ["acceptanceState", "unproven"]]);
}

/** Whitelist the server's bounded revision view, never arbitrary fix artifacts. */
export function normalizeLiveRevisionReview(value, runId) {
  const items = (Array.isArray(value?.items) ? value.items : []).slice(0, 64).flatMap((item) => {
    if (item?.runId !== runId || !/^revision:[a-f0-9]{20}$/u.test(item.id || "") || !/^finding:[a-f0-9]{20}$/u.test(item.findingId || "")) return [];
    const state = ["recorded", "pending_verification", "verification_unconfirmed"].includes(item.state) ? item.state : "verification_unconfirmed";
    return [{ id: item.id, runId, findingId: item.findingId, actionId: /^action:[a-f0-9]{20}$/u.test(item.actionId || "") ? item.actionId : null,
      feedbackId: /^feedback:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(item.feedbackId || "") ? item.feedbackId : null,
      findingRef: /^finding:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(item.findingRef || "") ? item.findingRef : null,
      sourceTaskPacketId: /^task:[a-f0-9]{20}$/u.test(item.sourceTaskPacketId || "") ? item.sourceTaskPacketId : null,
      sourceDeliverableId: /^deliverable:[a-f0-9]{24}$/u.test(item.sourceDeliverableId || "") ? item.sourceDeliverableId : null,
      sourceContentVersion: /^sha256:[a-f0-9]{64}$/u.test(item.sourceContentVersion || "") ? item.sourceContentVersion : null,
      taskPacketId: /^task:[a-f0-9]{20}$/u.test(item.taskPacketId || "") ? item.taskPacketId : null,
      deliverableId: /^deliverable:[a-f0-9]{24}$/u.test(item.deliverableId || "") ? item.deliverableId : null,
      summary: overviewText(item.summary), requiredChange: overviewText(item.requiredChange),
      contentVersion: /^sha256:[a-f0-9]{64}$/u.test(item.contentVersion || "") ? item.contentVersion : null, state }];
  });
  return { state: items.length ? "reported" : "not_reported", items };
}

/** Coordination state never authorizes a native running or completion claim. */
export function normalizeLiveGovernance(value, runId) {
  if (!value || value.runId !== runId || value.evidenceLevel !== "durable_lifecycle"
    || typeof value.active !== "boolean" || !["active", "inactive"].includes(value.state)
    || value.active !== (value.state === "active")) return null;
  return { runId, active: value.active, state: value.state, currentStage: overviewText(value.currentStage), evidenceLevel: "durable_lifecycle" };
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

/** A bound owner's report is distinct from native execution and verification. */
export function normalizeLiveOwnerReport(node, runId = node?.runId) {
  const report = node?.ownerReport;
  const taskId = overviewText(node?.taskPacketId);
  const owner = overviewText(node?.ownerAgent || node?.agent || node?.owner);
  const boundRun = overviewText(runId);
  if (!report || typeof report !== "object" || Array.isArray(report) || node.isMain === true
    || !["agent", "worker"].includes(overviewState(node.kind)) || !boundRun || !taskId || !owner
    || (node.runId && node.runId !== boundRun) || report.runId !== boundRun || report.taskPacketId !== taskId
    || report.ownerAgent !== owner || report.evidenceLevel !== "owner_reported" || report.nativeInvocationVerified !== false
    || !["reported_complete", "reported_failed", "reported_blocked"].includes(report.resultStatus)
    || !overviewText(report.summary)) return null;
  return { runId: boundRun, taskPacketId: taskId, ownerAgent: owner, resultStatus: report.resultStatus,
    summary: overviewText(report.summary), reportedAt: overviewTimestamp(report.reportedAt),
    evidenceLevel: "owner_reported", nativeInvocationVerified: false };
}

/** Retain only an exactly bound native child return, never a spawn acknowledgement. */
export function normalizeLiveNativeTaskReturn(node, runId = node?.runId) {
  const boundRun = overviewText(runId);
  const taskPacketId = overviewText(node?.taskPacketId);
  const nodeId = overviewText(node?.id);
  if (!node || node.isMain === true || !["agent", "worker"].includes(overviewState(node.kind))
    || !boundRun || !taskPacketId || !nodeId || (node.runId && node.runId !== boundRun)
    || node.executionState !== "executed" || node.active === true
    || [node.status, node.displayState].some((state) => ["active", "running", "live"].includes(overviewState(state)))) return null;
  const candidates = [node.nativeReturnEvidence, ...(Array.isArray(node.workerExecutionEvidence) ? node.workerExecutionEvidence.slice(0, 256) : [])];
  const records = candidates.flatMap((record) => {
    if (!record || record.runId !== boundRun || record.taskPacketId !== taskPacketId || record.nodeId !== nodeId
      || record.evidenceKind !== "native_host_observation" || record.sourceKind !== "codex_desktop_native_session"
      || record.executionObserved !== true || record.synthetic !== false
      || typeof record.sourceEventId !== "string" || record.sourceEventId !== overviewText(record.sourceEventId)
      || !/^.+:return$/u.test(record.sourceEventId) || typeof record.sourceDigest !== "string" || !/^[a-f0-9]{64}$/iu.test(record.sourceDigest)) return [];
    const observedAt = overviewTimestamp(record.observedAt);
    if (!observedAt || [node.firstAt, node.lastAt, node.startedAt, node.timing?.startedAt, node.timing?.completedAt]
      .map(overviewTimestamp).some((time) => time && time > observedAt)) return [];
    return [{ runId: boundRun, taskPacketId, nodeId, evidenceKind: "native_host_observation", sourceKind: "codex_desktop_native_session",
      executionObserved: true, synthetic: false, sourceEventId: record.sourceEventId, observedAt, sourceDigest: record.sourceDigest.toLowerCase() }];
  });
  records.sort((left, right) => right.observedAt.localeCompare(left.observedAt) || left.sourceEventId.localeCompare(right.sourceEventId));
  return records[0] || null;
}

/** Present task progress independently of execution provenance and acceptance. */
export function resolveLiveTaskLifecycle(node, runId = node?.runId) {
  if (!node || typeof node !== "object" || (node.runId && runId && node.runId !== runId)) return { state: "in_progress", detail: "unconfirmed" };
  const status = overviewState(node.status);
  const displayState = overviewState(node.displayState);
  const states = [displayState, status];
  if (node.declaredNotStarted === true || node.executionState === "not_executed" || states.includes("planned")) return { state: "not_started", detail: "not_dispatched" };
  if (states.some((state) => ["failed", "blocked", "cancelled"].includes(state))) {
    return { state: "in_progress", detail: states.find((state) => ["failed", "blocked", "cancelled"].includes(state)) };
  }
  // A currently executing revision takes precedence over an older result.
  if (node.executionState === "executing" || ["running", "active", "live"].includes(displayState) || (node.active === true && !states.includes("completed"))
    || (["running", "active", "live"].includes(status) && displayState !== "completed")) return { state: "in_progress", detail: node.observedOnly === true ? "observed" : "" };
  const report = normalizeLiveOwnerReport(node, runId);
  if (report) return report.resultStatus === "reported_complete"
    ? { state: "completed", detail: "verification_pending" }
    : { state: "in_progress", detail: report.resultStatus === "reported_failed" ? "failed" : "blocked" };
  if (normalizeLiveNativeTaskReturn(node, runId)) return { state: "completed", detail: "result_unconfirmed" };
  if (states.includes("completed")) return runId && !node.runId
    ? { state: "in_progress", detail: "unconfirmed" } : { state: "completed", detail: "" };
  if (node.executionState === "executed") return { state: "in_progress", detail: "result_unconfirmed" };
  if (states.some((state) => ["unknown", "unreported", "in_doubt", "archived_legacy", "superseded"].includes(state))) return { state: "in_progress", detail: "unconfirmed" };
  if (states.some((state) => ["pending", "queued", "declared", "not_started"].includes(state))) return { state: "not_started", detail: "waiting" };
  return { state: "in_progress", detail: states.some((state) => ["running", "active", "live"].includes(state)) ? "" : "unconfirmed" };
}

/** Reuse one task boundary in the run summary and its three-column board. */
export function liveRunTaskNodes(snapshot) {
  const runId = overviewText(snapshot?.run?.id || snapshot?.run?.runId);
  return (Array.isArray(snapshot?.nodes) ? snapshot.nodes : []).filter((node) => node && node.isMain !== true
    && ["agent", "worker"].includes(overviewState(node.kind)) && (!node.runId || node.runId === runId));
}

/** Root and organization rows do not turn seven finished work items into eight. */
export function resolveLiveRunTaskLifecycle(snapshot) {
  const run = snapshot?.run;
  const runId = overviewText(run?.id || run?.runId);
  const nodes = liveRunTaskNodes(snapshot);
  const tasks = nodes.map((node) => resolveLiveTaskLifecycle(node, runId));
  const counts = { totalCount: tasks.length, completedCount: tasks.filter((task) => task.state === "completed").length,
    notStartedCount: tasks.filter((task) => task.state === "not_started").length,
    inProgressCount: tasks.filter((task) => task.state === "in_progress").length,
    verificationPendingCount: tasks.filter((task) => task.detail === "verification_pending").length };
  if (!runId) return { state: "not_started", detail: "no_tasks", ...counts };
  const states = [overviewState(run.displayState), overviewState(run.status)];
  if (states.includes("planned") || run.executionEvidenceState === "structural_planning_only") return { state: "not_started", detail: "not_dispatched", ...counts };
  const failure = states.find((state) => ["failed", "blocked", "cancelled"].includes(state));
  if (failure) return { state: "in_progress", detail: failure, ...counts };
  if (run.observationKind === "native_execution" && run.active === true) return { state: "in_progress", detail: "unfinished", ...counts };
  if (tasks.length) {
    if (counts.completedCount === counts.totalCount) return { state: "completed", detail: counts.verificationPendingCount ? "verification_pending"
      : tasks.some((task) => task.detail === "result_unconfirmed") ? "result_unconfirmed" : "", ...counts };
    if (counts.notStartedCount === counts.totalCount) return { state: "not_started", detail: "waiting", ...counts };
    return { state: "in_progress", detail: tasks.find((task) => ["failed", "blocked", "cancelled"].includes(task.detail))?.detail || "unfinished", ...counts };
  }
  const lifecycle = resolveLiveTaskLifecycle({ ...run, runId }, runId);
  return { ...lifecycle, detail: lifecycle.detail || "no_tasks", ...counts };
}

/** The visible main node shares the run's task aggregate without rewriting audit status. */
export function resolveLiveNodeTaskLifecycle(node, snapshot) {
  const runId = overviewText(snapshot?.run?.id || snapshot?.run?.runId);
  if (node?.isMain === true && runId && (!node.runId || node.runId === runId)
    && (Array.isArray(snapshot.nodes) ? snapshot.nodes : []).some((item) => item?.id === node.id && item.isMain === true)) return resolveLiveRunTaskLifecycle(snapshot);
  return resolveLiveTaskLifecycle(node, runId || node?.runId);
}

/** One bilingual vocabulary for badges, overview, header and workspace columns. */
export function liveTaskLifecycleCopy(lifecycle, language = "zh") {
  const copy = {
    zh: { not_started: "未开始", in_progress: "进行中", completed: "已完成", not_dispatched: "尚未派发", waiting: "等待开始",
      verification_pending: "执行者已完成，独立验证待完成", failed: "执行失败，仍需处理", blocked: "工作受阻，等待处理", cancelled: "执行已取消，尚未完成",
      result_unconfirmed: "执行已返回，结果待确认", unconfirmed: "缺少执行记录，状态待确认", unfinished: "还有工作未完成", no_tasks: "尚无工作项记录", native_unconfirmed: "原生执行证据尚未确认。", observed: "已观察到执行", inspect: "查看任务" },
    en: { not_started: "Not started", in_progress: "In progress", completed: "Completed", not_dispatched: "Not dispatched", waiting: "Waiting to start",
      verification_pending: "Worker finished; independent verification pending", failed: "Execution failed; action required", blocked: "Work blocked; action required", cancelled: "Execution cancelled; work unfinished",
      result_unconfirmed: "Execution returned; outcome unconfirmed", unconfirmed: "Execution record missing; status unconfirmed", unfinished: "Work remains unfinished", no_tasks: "No work-item records yet", native_unconfirmed: "Native execution evidence is unconfirmed.", observed: "Execution observed", inspect: "Inspect task" },
  };
  const selected = copy[language === "zh" || language === "zh-CN" ? "zh" : "en"];
  return { label: selected[lifecycle?.state] || selected.in_progress, detail: selected[lifecycle?.detail] || "", inspect: selected.inspect,
    progress: Number.isSafeInteger(lifecycle?.totalCount) && lifecycle.totalCount > 0
      ? (selected === copy.zh ? "任务完成 " : "Tasks completed ") + lifecycle.completedCount + "/" + lifecycle.totalCount : "" };
}

/** Ordinary task copy stays separate from the technical record's vocabulary. */
export function liveWorkOverviewCopy(language = "zh") {
  const copy = {
    zh: { current: "本次工作", completed: "已做的工作", work: "工作清单", details: "详细记录", inspect: "查看详细记录", more: "查看其余", items: "项",
      waiting: "等待安排工作", unavailable: "工作清单尚未保存", noFiles: "未附可打开的文件", output: "打开成果", feedback: "我有修改意见",
      attention: "需要处理", activity: "最近活动", unknownTime: "活动时间未记录", latest: "最近记录 · ", measurements: "输出计量", partial: "仅包含已观察到的记录。", nativeCurrent: "本次对话的工作" },
    en: { current: "Current work", completed: "Work completed", work: "Work list", details: "Details", inspect: "View details", more: "Show remaining", items: "items",
      waiting: "Waiting for work to be scheduled", unavailable: "The work list was not saved", noFiles: "No attached files", output: "Open output", feedback: "Request a change",
      attention: "Needs attention", activity: "Recent activity", unknownTime: "Activity time not recorded", latest: "Latest timed record · ", measurements: "Output measured", partial: "Only observed records are included.", nativeCurrent: "Work in this chat" },
  };
  return copy[language === "zh" || language === "zh-CN" ? "zh" : "en"];
}

/** Explain legacy Chinese technical labels without translating user prose/code. */
export function plainLiveTaskLabel(value, language = "zh") {
  const source = typeof value === "string" ? value.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/gu, " ").trim() : "";
  if (!source || ["governed execution", "untitled task", "untitled run", "unidentified run"].includes(source.toLowerCase())) return liveWorkOverviewCopy(language).current;
  const zh = language === "zh" || language === "zh-CN";
  if (!zh) return source;
  // Literal identities must survive both terminology changes and abbreviation.
  // Only a legacy scope header before Chinese Hook prose is a glossary entry.
  const literalText = /路径|目录|文件/u.test(source) ? source
    : source.replace(/^project\/global\/user(?=[ \t]+(?:Hook|hook)[ \t]{0,2}\p{Script=Han})/u, "");
  const literal = ["`", "'", '"', "“", "”", "‘", "’", "/", "\\", "(", ")", "[", "]", "{", "}", "<", ">", "="].some((marker) => literalText.includes(marker))
    || /\b[\w-]+(?:\.[\w-]+)+\b/u.test(literalText) || /\bHookPrompt\b/iu.test(literalText)
    || /\b(?:npm|npx|node|git|python3?|pwsh|powershell|bash|sh|curl|uv|pnpm|yarn|bun|cargo|docker)\s+[\w@.-]/iu.test(literalText)
    || /\b[\w-]+\s+--?[\w-]/u.test(literalText) || /\b(?:return|const|let|var|function|class|import|export|await)\b/u.test(literalText);
  if (literal) return source;
  const terms = { turn: "对话回合", run: "任务", CAS: "版本检查", provider: "能力来源", runtime: "运行环境", Hook: "触发脚本", hook: "触发脚本" };
  const mixedTerm = /(\p{Script=Han}[ \t]{0,2})(turn|run|CAS|provider|runtime|Hook|hook)\b(?![ \t]+[A-Za-z])|\b(turn|run|CAS|provider|runtime|Hook|hook)(?=[ \t]{0,2}\p{Script=Han})/gu;
  const legacy = mixedTerm.test(source) || /\bproject\/global\/user\b|有界发现证据|持久草稿|各宿主|交付[^。！？\n]{0,40}对账/u.test(source);
  mixedTerm.lastIndex = 0;
  if (!legacy) return source;
  const plain = source.replace(/\bproject\/global\/user\b/gu, "项目/全局/用户")
    .replace(mixedTerm, (_match, prefix, afterChinese, beforeChinese) => (prefix || "") + terms[afterChinese || beforeChinese])
    .replace(/宿主/gu, "运行工具").replace(/终态/gu, "结束状态").replace(/对账/gu, "核对交付")
    .replace(/有界发现证据/gu, "检索记录").replace(/持久草稿/gu, "保存草稿");
  const first = plain.split(/(?:[。！？!?]\s*|[.;]\s+|\r?\n)/u, 1)[0].trim();
  return first.length > 88 ? first.slice(0, 87) + "…" : first;
}

/** Native task aliases are identifiers; role captions never invent task intent. */
export function liveTaskDisplayLabel(node, language = "zh") {
  if (!node || typeof node !== "object") return plainLiveTaskLabel("", language);
  if (node.nativeTaskCaption || node.nativeTaskOrdinal) {
    const captions = { explorer: ["问题排查", "Investigation"], "javascript-pro": ["代码实现", "Code implementation"],
      "code-reviewer": ["代码检查", "Code review"], "ui-ux-designer": ["页面设计", "Page design"], "meta-prism": ["质量检查", "Quality review"],
      subtask: ["子任务", "Subtask"] };
    const caption = Object.prototype.hasOwnProperty.call(captions, node.nativeTaskCaption) ? captions[node.nativeTaskCaption] : captions.subtask;
    const ordinal = Number.isSafeInteger(node.nativeTaskOrdinal) && node.nativeTaskOrdinal > 0 && node.nativeTaskOrdinal <= 4096 ? " " + node.nativeTaskOrdinal : "";
    return caption[language === "zh" || language === "zh-CN" ? 0 : 1] + ordinal;
  }
  return plainLiveTaskLabel(node.task || node.label, language);
}

/** Explain only the known native placeholder; a saved user title stays intact. */
export function liveRunDisplayTitle(run, language = "zh") {
  if (run?.observationKind === "native_execution" && run.title === "当前 Codex 真实执行记录") return liveWorkOverviewCopy(language).nativeCurrent;
  return typeof run?.title === "string" && run.title ? run.title : plainLiveTaskLabel("", language);
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
export function resolveLiveRunOverview(snapshot, language = "zh") {
  const run = snapshot?.run;
  if (!run || !overviewText(run.id || run.runId)) return { state: "empty", taskLifecycle: resolveLiveRunTaskLifecycle(snapshot), task: null, result: { items: [], declaredCount: 0 }, blocker: null, activity: { item: null, undatedCount: 0 } };
  const runId = overviewText(run.id || run.runId);
  const state = overviewState(run.displayState || run.status);
  const planned = state === "planned" || run.executionEvidenceState === "structural_planning_only";
  const active = !planned && run.active === true;
  const governance = normalizeLiveGovernance(run.governance, runId);
  const nodes = (Array.isArray(snapshot.nodes) ? snapshot.nodes : []).filter((node) => node && !["stage", "chapter", "stage_summary", "workflow"].includes(overviewState(node.kind)) && (!node.runId || node.runId === runId));
  const activity = planned ? { item: null, undatedCount: 0 } : overviewExecutionActivity(snapshot, runId);
  const activeNodes = active ? nodes.filter((node) => !node.declaredNotStarted && node.executionState !== "not_executed"
    && (node.active === true || ["active", "running"].includes(overviewState(node.displayState || node.status)))) : [];
  activeNodes.sort((left, right) => Number(right.id === activity.item?.nodeId) - Number(left.id === activity.item?.nodeId) || Number(left.isMain === true) - Number(right.isMain === true) || overviewText(left.id).localeCompare(overviewText(right.id)));
  const current = activeNodes[0];
  const ownerReports = nodes.flatMap((node) => {
    const report = normalizeLiveOwnerReport(node, runId);
    return report ? [{ node, report }] : [];
  }).sort((left, right) => String(right.report.reportedAt || "").localeCompare(String(left.report.reportedAt || ""))
    || overviewText(left.node.id).localeCompare(overviewText(right.node.id)));
  const reported = ownerReports[0];
  const blockers = planned ? [] : nodes.filter((node) => ["blocked", "failed"].includes(overviewState(node.displayState || node.status)) && !node.declaredNotStarted);
  blockers.sort((left, right) => overviewText(left.id).localeCompare(overviewText(right.id)));
  const blocked = blockers[0];
  const runBlocked = ["blocked", "failed"].includes(state);
  const deliverables = normalizeLiveDeliverables(snapshot.deliverables, runId);
  return {
    state: planned ? "planned" : active ? "active" : state === "completed" ? "completed" : runBlocked ? "blocked" : governance?.active ? "governance_active" : "historical",
    taskLifecycle: resolveLiveRunTaskLifecycle(snapshot),
    governance,
    task: current ? { label: liveTaskDisplayLabel(current, language), nodeId: overviewText(current.id), moreCount: activeNodes.length - 1 } : null,
    ownerReported: reported ? { count: ownerReports.length, task: { label: liveTaskDisplayLabel(reported.node, language),
      nodeId: overviewText(reported.node.id), summary: reported.report.summary, reportedAt: reported.report.reportedAt } } : null,
    result: { items: deliverables.filter((item) => item.availability === "available"), declaredCount: deliverables.filter((item) => item.availability === "declared").length },
    blocker: blocked ? { kind: "blocked", label: overviewText(blocked.statusReason), nodeLabel: liveTaskDisplayLabel(blocked, language), nodeId: overviewText(blocked.id), moreCount: blockers.length - 1 }
      : runBlocked ? { kind: "blocked", label: overviewText(run.statusReason), nodeLabel: "", nodeId: "", moreCount: 0 }
        : overviewText(run.statusReason) ? { kind: "status", label: overviewText(run.statusReason), nodeLabel: "", nodeId: "", moreCount: 0 } : null,
    activity,
    execution: run.observationKind === "native_execution" ? normalizeLiveExecutionSummary(run.executionSummary) : null,
    revisionReview: normalizeLiveRevisionReview(snapshot.revisionReview, runId),
  };
}

/** Ship the same tested selectors into the dependency-free page. */
export function serializeLiveRunOverviewResolvers() {
  return [overviewText, overviewState, overviewActivityState, normalizeLiveExecutionSummary, normalizeLiveRevisionReview, normalizeLiveGovernance, resolveLiveNativeActivity, overviewTimestamp, normalizeLiveOwnerReport, normalizeLiveNativeTaskReturn, resolveLiveTaskLifecycle, liveRunTaskNodes, resolveLiveRunTaskLifecycle, resolveLiveNodeTaskLifecycle, liveTaskLifecycleCopy, liveWorkOverviewCopy, plainLiveTaskLabel, liveTaskDisplayLabel, liveRunDisplayTitle, overviewHostExecutionEvent, overviewExecutionActivity, resolveLiveRunOverview]
    .map((resolver) => resolver.toString()).join("\n");
}
