import test from "node:test";
import assert from "node:assert/strict";
import { resolveLiveRunOverview, resolveLiveNativeActivity, normalizeLiveExecutionSummary, normalizeLiveRevisionReview, resolveLiveTaskLifecycle, resolveLiveRunTaskLifecycle, liveTaskLifecycleCopy, plainLiveTaskLabel, liveWorkOverviewCopy, serializeLiveRunOverviewResolvers } from "../../src/presentation/live/live-run-overview.mjs";
import { serializeLocalFeedbackResolvers } from "../../src/presentation/live/live-feedback-draft.mjs";
import { renderLiveControlRoomPage } from "../../src/presentation/live/live-control-room-page.mjs";

const at = "2026-10-22T08:00:00Z";
const snapshot = (extra = {}) => ({
  run: { id: "run-current", active: true, displayState: "active", executionEvidenceState: "recorded", title: "完整目标" },
  nodes: [], deliverables: [], toolCalls: [], replay: [], evidence: [], ...extra,
});
const node = (id, extra = {}) => ({ id, kind: "agent", label: id, task: "修订首屏", active: true, displayState: "active", executionState: "executed", ...extra });

test("an absent run has no invented task, result, blocker or activity", () => {
  const result = resolveLiveRunOverview(null);
  assert.equal(result.state, "empty");
  assert.equal(result.task, null);
  assert.deepEqual(result.result, { items: [], declaredCount: 0 });
  assert.equal(result.blocker, null);
  assert.equal(result.activity.item, null);
});

test("current task follows observed execution activity among active same-run nodes", () => {
  const result = resolveLiveRunOverview(snapshot({
    nodes: [node("main", { isMain: true }), node("frontend"), node("planned", { declaredNotStarted: true }), node("foreign", { runId: "other" })],
    toolCalls: [{ id: "tool", runId: "run-current", nodeId: "frontend", name: "shell", state: "completed", endedAt: at }],
  }));
  assert.deepEqual(result.task, { label: "修订首屏", nodeId: "frontend", moreCount: 1 });
  assert.equal(result.activity.item.source, "tool");
});

test("owner-reported tasks remain separate from active execution, native counters and verified completion", () => {
  const report = { runId: "run-current", taskPacketId: "task:reported", ownerAgent: "debugger", resultStatus: "reported_complete",
    summary: "负责人提交了检查结果", reportedAt: at, evidenceLevel: "owner_reported", nativeInvocationVerified: false };
  const reported = node("reported", { runId: "run-current", ownerAgent: "debugger", taskPacketId: report.taskPacketId,
    active: false, status: "in_doubt", displayState: "unknown", executionState: "unreported", ownerReport: report });
  const fixture = snapshot({ nodes: [reported] });
  const result = resolveLiveRunOverview(fixture);
  assert.equal(result.state, "active");
  assert.equal(result.task, null, "a report does not invent a currently executing task");
  assert.equal(result.ownerReported.count, 1);
  assert.equal(result.ownerReported.task.nodeId, "reported");
  assert.equal(result.ownerReported.task.summary, report.summary);
  assert.equal(result.activity.item, null);
  assert.equal(result.execution, null);
  assert.equal(result.result.items.length, 0);
  assert.equal(result.taskLifecycle.state, "completed", "the task result is complete while independent proof remains separate");
  assert.equal(result.taskLifecycle.verificationPendingCount, 1);
  assert.equal(reported.status, "in_doubt");
  assert.equal(reported.executionState, "unreported");
  for (const mutation of [{ runId: "other" }, { taskPacketId: "task:other" }, { ownerAgent: "other" }, { nativeInvocationVerified: true }]) {
    assert.equal(resolveLiveRunOverview(snapshot({ nodes: [{ ...reported, ownerReport: { ...report, ...mutation } }] })).ownerReported, null);
  }
  const withExecution = resolveLiveRunOverview(snapshot({ nodes: [reported, node("actually-running")] }));
  assert.equal(withExecution.task.nodeId, "actually-running");
  assert.equal(withExecution.ownerReported.count, 1);
});

test("task lifecycle exposes exactly three primary states and keeps failure and verification as details", () => {
  const runId = "run-current";
  const report = { runId, taskPacketId: "task:one", ownerAgent: "debugger", resultStatus: "reported_complete",
    summary: "完成本项修复", reportedAt: at, evidenceLevel: "owner_reported", nativeInvocationVerified: false };
  const reported = { runId, id: "one", kind: "agent", taskPacketId: report.taskPacketId, ownerAgent: report.ownerAgent,
    active: false, status: "in_doubt", displayState: "unknown", executionState: "unreported", ownerReport: report };
  const cases = [
    [{ status: "pending" }, "not_started", "waiting"],
    [{ status: "running", active: true }, "in_progress", ""],
    [{ status: "completed" }, "completed", ""],
    [{ status: "failed" }, "in_progress", "failed"],
    [{ status: "blocked" }, "in_progress", "blocked"],
    [{ status: "cancelled" }, "in_progress", "cancelled"],
    [{ status: "unknown" }, "in_progress", "unconfirmed"],
    [{ status: "in_doubt", executionState: "executed" }, "in_progress", "result_unconfirmed"],
    [{ status: "completed", declaredNotStarted: true }, "not_started", "not_dispatched"],
  ];
  for (const [input, state, detail] of cases) assert.deepEqual(resolveLiveTaskLifecycle({ runId, ...input }, runId), { state, detail });
  assert.deepEqual(resolveLiveTaskLifecycle(reported, runId), { state: "completed", detail: "verification_pending" });
  assert.equal(resolveLiveTaskLifecycle({ ...reported, active: true }, runId).state, "in_progress", "new active work overrides its old successful report even if the audit status is unchanged");
  assert.equal(resolveLiveTaskLifecycle({ ...reported, active: true, status: "completed", displayState: "active" }, runId).state, "in_progress", "an explicit current active display overrides a stale terminal status");
  for (const resultStatus of ["reported_failed", "reported_blocked"]) assert.equal(resolveLiveTaskLifecycle({ ...reported, ownerReport: { ...report, resultStatus } }, runId).state, "in_progress");
  for (const changed of [{ runId: "other" }, { ownerAgent: "other" }, { taskPacketId: "task:other" }, { nativeInvocationVerified: true }]) {
    assert.equal(resolveLiveTaskLifecycle({ ...reported, ownerReport: { ...report, ...changed } }, runId).state, "in_progress");
  }
  assert.equal(resolveLiveTaskLifecycle({ runId: "other", status: "completed" }, runId).state, "in_progress");
  assert.equal(resolveLiveTaskLifecycle({ status: "completed" }, runId).state, "in_progress", "unbound completion cannot become current-run completion");
  assert.equal(resolveLiveTaskLifecycle({ ...reported, runId: undefined }, runId).state, "completed", "a correctly bound owner report independently supplies run attribution");
  assert.equal(liveTaskLifecycleCopy(resolveLiveTaskLifecycle(reported), "zh").label, "已完成");
  assert.equal(liveTaskLifecycleCopy(resolveLiveTaskLifecycle(reported), "en").label, "Completed");
  assert.match(liveTaskLifecycleCopy(resolveLiveTaskLifecycle(reported), "zh").detail, /独立验证待完成/u);
});

test("seven completed task results finish the displayed lifecycle without finishing audit or unfinished work", () => {
  const runId = "run-current";
  const tasks = Array.from({ length: 7 }, (_, index) => {
    const taskPacketId = "task:" + index;
    return { id: "worker-" + index, runId, taskPacketId, kind: "worker", ownerAgent: "debugger", status: "in_doubt", displayState: "unknown", active: false,
      executionState: "unreported", ownerReport: { runId, taskPacketId, ownerAgent: "debugger", resultStatus: "reported_complete", summary: "本项完成",
        reportedAt: at, evidenceLevel: "owner_reported", nativeInvocationVerified: false } };
  });
  const fixture = snapshot({ nodes: [{ id: "root", kind: "agent", isMain: true, active: true, status: "active" },
    { id: "group", kind: "stage", status: "pending" }, ...tasks],
    run: { id: runId, active: true, status: "in_doubt", governance: { runId, active: true, state: "active", evidenceLevel: "durable_lifecycle" } } });
  const before = JSON.stringify(fixture);
  const lifecycle = resolveLiveRunTaskLifecycle(fixture);
  assert.deepEqual(lifecycle, { state: "completed", detail: "verification_pending", totalCount: 7, completedCount: 7, notStartedCount: 0, inProgressCount: 0, verificationPendingCount: 7 });
  assert.equal(liveTaskLifecycleCopy(lifecycle, "zh").progress, "任务完成 7/7");
  assert.equal(resolveLiveRunOverview(fixture).state, "active", "the raw run/audit selector is preserved");
  assert.equal(JSON.stringify(fixture), before, "display selectors never rewrite task history or evidence");
  for (const extra of [{ runId, kind: "agent", status: "pending" }, { runId, kind: "agent", status: "active", active: true },
    { runId, kind: "agent", status: "failed" }, { kind: "worker", status: "completed" }]) {
    assert.notEqual(resolveLiveRunTaskLifecycle({ ...fixture, nodes: [...fixture.nodes, extra] }).state, "completed");
  }
  assert.equal(resolveLiveRunTaskLifecycle({ ...fixture, nodes: [...fixture.nodes, { kind: "worker", runId: "other", status: "pending" }] }).state, "completed");
  assert.equal(resolveLiveRunTaskLifecycle({ ...fixture, run: { ...fixture.run, executionEvidenceState: "structural_planning_only" } }).state, "not_started");
  for (const status of ["failed", "blocked", "cancelled"]) {
    const result = resolveLiveRunTaskLifecycle({ ...fixture, run: { ...fixture.run, displayState: "unknown", status } });
    assert.equal(result.state, "in_progress");
    assert.equal(result.detail, status);
  }
  assert.notEqual(resolveLiveRunTaskLifecycle({ run: { id: runId }, nodes: [] }).state, "completed");
  assert.equal(resolveLiveRunTaskLifecycle({ run: { id: runId, status: "completed" }, nodes: [] }).state, "completed", "a server-recorded terminal run needs no invented task count");
  assert.equal(resolveLiveRunTaskLifecycle({ run: { id: runId, status: "pending" }, nodes: [{ kind: "worker", runId, status: "pending" }] }).state, "not_started");
});

test("ordinary task labels use a finite glossary and preserve unfamiliar wording", () => {
  assert.equal(plainLiveTaskLabel("Governed execution", "zh"), "本次工作");
  assert.equal(plainLiveTaskLabel("", "en"), "Current work");
  assert.equal(plainLiveTaskLabel("同run带CAS返工，provider与runtime核对。第二句保留在原始详情"), "同任务带版本检查返工，能力来源与运行环境核对");
  assert.equal(plainLiveTaskLabel("project/global/user Hook与turn终态对账"), "项目/全局/用户 触发脚本与对话回合结束状态核对交付");
  assert.equal(plainLiveTaskLabel("保留 AcmeSDK v2.1 的用户原话"), "保留 AcmeSDK v2.1 的用户原话");
  assert.equal(plainLiveTaskLabel("有界发现证据与持久草稿"), "检索记录与保存草稿");
  assert.equal(plainLiveTaskLabel("x".repeat(100)), "x".repeat(100));
  assert.equal(plainLiveTaskLabel("旧turn终态" + "检查".repeat(60)).length, 88);
  assert.equal(liveWorkOverviewCopy("en").completed, "Work completed");
  const client = new Function(serializeLiveRunOverviewResolvers() + "; return plainLiveTaskLabel;")();
  assert.equal(client("旧turn终态检查"), plainLiveTaskLabel("旧turn终态检查"));
});

test("task label glossary preserves natural English in both languages", () => {
  for (const language of ["zh", "en"]) {
    for (const title of ["Run tests", "Turn on dark mode", "Write user stories"]) assert.equal(plainLiveTaskLabel(title, language), title);
    assert.equal(plainLiveTaskLabel("请 Run tests", language), "请 Run tests");
  }
});

test("task label glossary preserves complete prose and quoted field names", () => {
  const client = new Function(serializeLiveRunOverviewResolvers() + "; return plainLiveTaskLabel;")();
  const titles = [
    "Run tests. Then review the output",
    "Review the user stories and explain what changed. " + Array(6).fill("Keep the original wording.").join(" "),
    '检查字段 "runtime版本"',
    "检查字段 'run状态'",
    "保留“provider名称”和‘turn编号’字段",
  ];
  for (const language of ["zh", "en"]) for (const title of titles) {
    assert.equal(plainLiveTaskLabel(title, language), title);
    assert.equal(client(title, language), title);
  }
});

test("task label glossary preserves literal paths, code, filenames and names in mixed titles", () => {
  const titles = [
    "检查turn与 `npm run tests` 命令",
    "检查run与 C:/projects/provider/run.js 文件",
    String.raw`检查turn与 C:\projects\provider\run.js 文件`,
    "检查runtime与 /usr/local/bin/run 路径",
    "检查provider与 ./src/run 路径",
    "检查turn与 https://example.test/run?user=kim&provider=one 链接",
    "检查run与 user.config.json 文件",
    "检查turn与 HookPrompt 专名",
    "检查run与 npm run test 命令",
    "检查turn与 run(provider) 代码",
  ];
  for (const language of ["zh", "en"]) for (const title of titles) assert.equal(plainLiveTaskLabel(title, language), title);
  assert.equal(plainLiveTaskLabel("完成财务对账", "zh"), "完成财务对账", "ordinary domain words do not enter a runtime glossary");
});

test("task label glossary preserves relative scope-like paths outside legacy metadata headers", () => {
  const titles = [
    "检查路径 project/global/user",
    "检查目录 project/global/user",
    "检查文件 project/global/user",
    "检查 project/global/user",
    "project/global/user",
    "project/global/user hook路径检查",
    "project/global/user Hook目录检查",
    "project/global/user hook文件检查",
    "检查 `project/global/user`",
    "npm run project/global/user",
  ];
  const client = new Function(serializeLiveRunOverviewResolvers() + "; return plainLiveTaskLabel;")();
  for (const language of ["zh", "en"]) for (const title of titles) {
    assert.equal(plainLiveTaskLabel(title, language), title);
    assert.equal(client(title, language), title);
  }
  assert.equal(plainLiveTaskLabel("project/global/user hook与turn终态对账", "zh"), "项目/全局/用户 触发脚本与对话回合结束状态核对交付");
});

test("available results require a valid same-run opaque descriptor", () => {
  const result = resolveLiveRunOverview(snapshot({ deliverables: [
    { id: "declared", runId: "run-current", kind: "html", availability: "declared", label: "仅有路径" },
    { id: "saved", runId: "run-current", kind: "html", availability: "available", label: "页面", url: "https://untrusted.invalid/", path: "C:/private" },
    { id: "wrong", runId: "other", kind: "html", availability: "available", label: "其他运行" },
  ] }));
  assert.equal(result.result.declaredCount, 1);
  assert.equal(result.result.items.length, 1);
  assert.equal(result.result.items[0].id, "saved");
  assert.equal("url" in result.result.items[0], false);
  assert.equal("path" in result.result.items[0], false);
  assert.equal("latest" in result.result, false);
});

test("run updates, heartbeat, planning and queued tool time do not become activity", () => {
  const result = resolveLiveRunOverview(snapshot({
    run: { id: "run-current", active: true, displayState: "active", updatedAt: "2099-01-01T00:00:00Z" },
    sessionInfo: { updatedAt: "2099-01-02T00:00:00Z", activity: "heartbeat" },
    toolCalls: [{ id: "queued", state: "queued", name: "not invoked", startedAt: "2099-01-01T00:00:00Z" }],
    replay: [{ id: "heartbeat", type: "heartbeat", at }, { id: "planning", type: "task_planned", at }],
  }));
  assert.equal(result.activity.item, null);
});

test("activity uses the most recent valid execution timestamp and reports undated records", () => {
  const result = resolveLiveRunOverview(snapshot({ toolCalls: [
    { id: "bad", state: "completed", name: "undated", endedAt: "not a date", updatedAt: "2099-01-01T00:00:00Z" },
    { id: "old", state: "completed", name: "old", endedAt: at },
    { id: "new", state: "completed", name: "new", endedAt: "2026-10-22T09:00:00Z" },
    { id: "foreign", state: "completed", runId: "other", name: "wrong run", endedAt: "2099-01-01T00:00:00Z" },
    { id: "synthetic", synthetic: true, state: "completed", name: "synthetic", endedAt: "2099-01-01T00:00:00Z" },
  ] }));
  assert.equal(result.activity.item.label, "new");
  assert.equal(result.activity.item.at, "2026-10-22T09:00:00.000Z");
  assert.equal(result.activity.undatedCount, 1);
});

test("missing, invalid and timezone-free activity times stay unknown", () => {
  for (const endedAt of [null, "", "bad", "2099-01-01", "2026-10-22T09:00:00", "2026-02-30T09:00:00Z", "2026-10-22T25:00:00Z"]) {
    const result = resolveLiveRunOverview(snapshot({ toolCalls: [{ id: "call", state: "returned", name: "shell", endedAt }] }));
    assert.equal(result.activity.item.at, null);
    assert.equal(result.activity.undatedCount, 1);
  }
});

test("native returned events and explicit same-run execution evidence are observations", () => {
  const result = resolveLiveRunOverview(snapshot({
    replay: [{ id: "returned", eventType: "command_returned", label: "shell", activityState: "executed", at }],
    evidence: [{ id: "evidence", runId: "run-current", executionObserved: true, evidenceKind: "native_host_observation", label: "执行证据", observedAt: "2026-10-22T10:00:00Z" }],
  }));
  assert.equal(result.activity.item.label, "执行证据");
  assert.equal(result.activity.item.source, "evidence");
});

test("host replay names need execution kind/stage provenance and cannot override a declared worker", () => {
  const event = { id: "host", eventType: "AgentEvent", kind: "agent", stage: "execution", status: "completed", executionObserved: true, nodeId: "worker", label: "agent invocation", at };
  assert.equal(resolveLiveRunOverview(snapshot({ replay: [event] })).activity.item?.id, "host");
  for (const excluded of [{ kind: "stage" }, { stage: "thinking" }, { proofValid: false }, { synthetic: true }, { status: "planned" }, { executionObserved: false }, { executionObserved: undefined }]) {
    assert.equal(resolveLiveRunOverview(snapshot({ replay: [{ ...event, ...excluded }] })).activity.item, null, JSON.stringify(excluded));
  }
  assert.equal(resolveLiveRunOverview(snapshot({ nodes: [node("worker", { declaredNotStarted: true })], replay: [event] })).activity.item, null);
});

test("an explicit observation without raw state does not inherit a queued display fallback", () => {
  const result = resolveLiveRunOverview(snapshot({ toolCalls: [{ id: "observed", name: "shell", executionObserved: true, activityState: "", state: "queued", activityAt: at }] }));
  assert.equal(result.activity.item.label, "shell");
  assert.equal(result.activity.item.at, "2026-10-22T08:00:00.000Z");
});

test("planned records suppress contradictory execution rows and blockers", () => {
  const result = resolveLiveRunOverview(snapshot({
    run: { id: "run-current", active: true, executionEvidenceState: "structural_planning_only" },
    nodes: [node("claimed"), node("blocked", { displayState: "blocked", statusReason: "计划中的原因" })],
    toolCalls: [{ id: "call", state: "completed", name: "shell", endedAt: at }],
  }));
  assert.equal(result.state, "planned");
  assert.equal(result.task, null);
  assert.equal(result.activity.item, null);
  assert.equal(result.blocker, null);
});

test("inactive historical and completed runs never revive a current worker", () => {
  for (const displayState of ["unreported", "archived_legacy", "completed", "active"]) {
    const result = resolveLiveRunOverview(snapshot({ run: { id: "run-current", active: false, displayState }, nodes: [node("stale-worker")] }));
    assert.equal(result.task, null);
    assert.equal(result.state, displayState === "completed" ? "completed" : "historical");
  }
});

test("governance activity remains distinct from native execution and cannot revive a stopped run", () => {
  const run = { id: "run-current", active: false, displayState: "unknown", governance: { runId: "run-current", active: true, state: "active", currentStage: "execution", evidenceLevel: "durable_lifecycle" } };
  const result = resolveLiveRunOverview(snapshot({ run, nodes: [node("stale-worker")] }));
  assert.equal(result.state, "governance_active");
  assert.equal(result.task, null);
  assert.equal(result.activity.item, null);
  for (const governance of [{ ...run.governance, runId: "other" }, { ...run.governance, active: false }, { ...run.governance, evidenceLevel: "caller_claim" }]) {
    assert.equal(resolveLiveRunOverview(snapshot({ run: { ...run, governance } })).state, "historical");
  }
});

test("blockers preserve the reported reason and do not substitute task descriptions", () => {
  const result = resolveLiveRunOverview(snapshot({ nodes: [node("blocked", { displayState: "blocked", active: false, summary: "任务说明不是阻塞原因", statusReason: "" })] }));
  assert.equal(result.blocker.kind, "blocked");
  assert.equal(result.blocker.label, "");
  assert.equal(result.blocker.nodeId, "blocked");
  const status = resolveLiveRunOverview(snapshot({ run: { id: "run-current", displayState: "in_doubt", active: false, statusReason: "结果尚未验收" } }));
  assert.equal(status.blocker.kind, "status");
  assert.equal(status.blocker.label, "结果尚未验收");
});

test("malformed optional collections and scalar entries remain bounded empty observations", () => {
  assert.doesNotThrow(() => resolveLiveRunOverview(snapshot({ toolCalls: [null, 3], replay: [null, "x"], evidence: [null, false], nodes: [null], deliverables: "x" })));
});

test("native return counters remain independent of acceptance and malformed counters cannot add completion", () => {
  const summary = { observedAgentCount: 3, returnedAgentCount: 1, unconfirmedAgentCount: 2, returnedToolCount: 4, failedToolCount: 1, acceptanceState: "unproven", completedCount: 999 };
  assert.equal(normalizeLiveExecutionSummary(summary).completedCount, undefined);
  assert.equal(resolveLiveRunOverview(snapshot({ run: { id: "r", observationKind: "native_execution", executionSummary: summary } })).execution.returnedAgentCount, 1);
  assert.equal(normalizeLiveExecutionSummary({ ...summary, unconfirmedAgentCount: 10 }), null);
  assert.equal(normalizeLiveExecutionSummary({ ...summary, acceptanceState: "accepted" }), null);
  assert.equal(normalizeLiveExecutionSummary({ ...summary, unconfirmedAgentCount: undefined, activeAgentCount: 2 }), null, "missing return is not active execution");
});

test("the native activity shortcut requires the selected project and server-owned exact conversation shape", () => {
  const thread = "11111111-1111-4111-8111-111111111111";
  const native = { runId: `native-codex-${thread}-22222222-2222-4222-8222-222222222222`, observationKind: "native_execution", sourceRuntime: "codex", conversationLinkState: "verified", conversationRef: thread };
  assert.equal(resolveLiveNativeActivity({ projectId: "p", sessions: [native] }, "old-plan", "p"), native);
  assert.equal(resolveLiveNativeActivity({ projectId: "other", sessions: [native] }, "old-plan", "p"), null);
  assert.equal(resolveLiveNativeActivity({ projectId: "p", sessions: [native] }, native.runId, "p"), null);
  for (const changed of [{ observationKind: "planned" }, { conversationLinkState: "candidate" }, { conversationRef: "<script>" }, { runId: "other-run" }]) assert.equal(resolveLiveNativeActivity({ projectId: "p", sessions: [{ ...native, ...changed }] }, "old-plan", "p"), null);
});

test("revision descriptors accept only same-run opaque bindings and discard arbitrary fix payloads", () => {
  const row = { id: "revision:" + "a".repeat(20), runId: "r", findingId: "finding:" + "b".repeat(20), actionId: "action:" + "c".repeat(20), state: "pending_verification", fixArtifact: "C:/private/file<script>", summary: "目录遗漏章节", requiredChange: "补齐目录并检查跳转" };
  const normalized = normalizeLiveRevisionReview({ items: [row, { ...row, runId: "other" }] }, "r");
  assert.equal(normalized.items.length, 1);
  assert.equal(normalized.items[0].fixArtifact, undefined);
  assert.doesNotMatch(JSON.stringify(normalized), /private|script/u);
  assert.equal(normalized.items[0].summary, row.summary);
  assert.equal(normalized.items[0].requiredChange, row.requiredChange);
  assert.equal(normalizeLiveRevisionReview({ items: [{ ...row, state: "verified" }] }, "r").items[0].state, "verification_unconfirmed");
});

test("serialized browser selectors match the imported implementation", () => {
  const client = new Function(serializeLocalFeedbackResolvers() + "\n" + serializeLiveRunOverviewResolvers() + "; return resolveLiveRunOverview;")();
  const fixture = snapshot({ nodes: [node("frontend")], toolCalls: [{ id: "call", state: "completed", name: "shell", endedAt: at }] });
  assert.deepEqual(client(fixture), resolveLiveRunOverview(fixture));
});

test("the actual page places the compact overview before the graph and uses the safe result/feedback path", () => {
  const html = renderLiveControlRoomPage();
  assert.ok(html.indexOf('<section class="run-overview"') < html.indexOf('<section class="workspace-grid"'));
  assert.match(html, /link\.href = deliverableOpenHref\(available\)/u);
  assert.match(html, /feedback\.addEventListener\("click", \(\) => openOverviewFeedback\(available\)\)/u);
  assert.match(html, /coverage\.outputMeasuredNodeCount \+ "\/" \+ coverage\.nodeCount/u);
  assert.match(html, /formatLiveTokenCount\(node\.outputTokens, currentLanguage\)/u);
  assert.match(html, /meta\.append\(tokens\)/u);
  assert.doesNotMatch(html, /if \(node\.outputTokens\) meta\.append/u);
  const client = html.match(/<script>\s*([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(client);
  assert.doesNotThrow(() => new Function(client));
});
