import test from "node:test";
import assert from "node:assert/strict";
import { resolveLiveRunOverview, resolveLiveNativeActivity, normalizeLiveExecutionSummary, normalizeLiveRevisionReview, serializeLiveRunOverviewResolvers } from "../../src/presentation/live/live-run-overview.mjs";
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
  const summary = { observedAgentCount: 3, returnedAgentCount: 1, activeAgentCount: 2, returnedToolCount: 4, failedToolCount: 1, acceptanceState: "unproven", completedCount: 999 };
  assert.equal(normalizeLiveExecutionSummary(summary).completedCount, undefined);
  assert.equal(resolveLiveRunOverview(snapshot({ run: { id: "r", observationKind: "native_execution", executionSummary: summary } })).execution.returnedAgentCount, 1);
  assert.equal(normalizeLiveExecutionSummary({ ...summary, activeAgentCount: 10 }), null);
  assert.equal(normalizeLiveExecutionSummary({ ...summary, acceptanceState: "accepted" }), null);
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
  const row = { id: "revision:" + "a".repeat(20), runId: "r", findingId: "finding:" + "b".repeat(20), actionId: "action:" + "c".repeat(20), state: "pending_verification", fixArtifact: "C:/private/file", summary: "<script>" };
  const normalized = normalizeLiveRevisionReview({ items: [row, { ...row, runId: "other" }] }, "r");
  assert.equal(normalized.items.length, 1);
  assert.equal(normalized.items[0].fixArtifact, undefined);
  assert.doesNotMatch(JSON.stringify(normalized), /private|script/u);
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
