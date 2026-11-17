import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentWorkflowService } from "../../src/application/agent/agent-workflow-service.mjs";
import { createLiveControlRoomServer } from "../../src/infrastructure/live/live-control-room-server.mjs";

function extractWorkspaceConfig(html) {
  const serialized = html.match(/<script type="application\/json" id="live-workspace-config">([^<]+)<\/script>/u);
  assert.ok(serialized);
  return JSON.parse(serialized[1]);
}

test("opt-in Live B2 supports authenticated two-level PRD review with history, not execution", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "meta-live-agent-design-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const native = {
    getHosts: async () => ({ schemaVersion: "meta-kim-agent-hosts-v1", hosts: [], executionAllowed: true }),
    start: async () => ({ status: "accepted", requestId: "native", runId: null }),
    inspect: () => ({ status: "completed", resultPreview: "方案 B：关键节点人工确认" }),
    close: () => {},
  };
  const service = createAgentWorkflowService({ projectRoot: root, agentStartService: native });
  const server = createLiveControlRoomServer({ projectRoot: root, port: 0, globalHub: false,
    enableAgentStart: true, service: { getSnapshot: async () => null }, agentStartService: service });
  t.after(() => server.close());
  const { url } = await server.start();
  const config = extractWorkspaceConfig(await (await fetch(url)).text());
  const auth = { [config.controlHeader]: config.controlToken };
  const headers = { ...auth, origin: url, "content-type": "application/json" };
  const request = { goal: "Set B decision with versioned design review", hostId: "claude",
    idempotencyKey: "design-http-20261117-a1" };
  const start = await fetch(`${url}/api/agent/start`, { method: "POST", headers, body: JSON.stringify(request) });
  assert.equal(start.status, 200);
  const planUrl = new URL(`${url}/api/agent/requests`);
  planUrl.searchParams.set("idempotencyKey", request.idempotencyKey);
  const plan = await (await fetch(planUrl, { headers: auth })).json();
  const decision = { idempotencyKey: request.idempotencyKey, requestId: plan.requestId,
    planDigest: plan.planDigest, action: "adopt", decisionKey: "design-http-decision-a1",
    selectedStrategy: "方案 B", selectionReason: "关键权限由人工决定" };
  assert.equal((await fetch(`${url}/api/agent/decisions`, { method: "POST", headers,
    body: JSON.stringify(decision) })).status, 200);
  const designUrl = new URL(`${url}/api/agent/designs`);
  designUrl.searchParams.set("idempotencyKey", request.idempotencyKey);
  const first = await (await fetch(designUrl, { headers: auth })).json();
  assert.equal(first.status, "not_started");
  assert.equal(first.version, 0);
  assert.equal(first.basis.decisionKey, decision.decisionKey);

  const payload = { idempotencyKey: request.idempotencyKey, requestId: plan.requestId,
    planDigest: plan.planDigest, decisionKey: decision.decisionKey, action: "submit",
    mutationKey: "design-http-mutation-a1", expectedVersion: 0,
    design: { system: { title: "Cross-border commerce", goal: "Improve operational workflows",
      architecture: "Service modules and explicit dependencies", techStack: "Node.js with PostgreSQL",
      acceptance: ["Human approval recorded"] },
    modules: [{ id: "research", title: "Research", objective: "Discover source evidence",
      inputContract: ["User brief"], outputContract: ["Evidence list"], boundaries: [],
      acceptance: ["Source list reviewed"], dependencies: [] },
    { id: "delivery", title: "Delivery", objective: "Prepare human review",
      inputContract: ["Evidence"], outputContract: ["Design packet"], boundaries: ["No deployment"],
      acceptance: ["Reviewed packet"], dependencies: ["research"] }] } };
  const post = (body, overrides = {}) => fetch(`${url}/api/agent/designs`, {
    method: "POST", headers: { ...headers, ...overrides }, body: JSON.stringify(body),
  });
  assert.equal((await fetch(`${url}/api/agent/designs`, { method: "GET" })).status, 403);
  assert.equal((await post(payload, { origin: "https://external.example" })).status, 403);
  assert.equal((await post(payload, { "content-type": "text/plain" })).status, 403);
  assert.equal((await post({ ...payload, projectId: "outside-root" })).status, 400);
  assert.equal((await post({ ...payload, planDigest: "0".repeat(64) })).status, 409);
  assert.equal((await fetch(`${url}/api/agent/designs`, { method: "DELETE", headers: auth })).status, 405);
  const committed = await post(payload);
  assert.equal(committed.status, 200);
  const draft = await committed.json();
  assert.equal(draft.status, "draft");
  assert.equal(draft.version, 1);
  assert.equal(draft.modules.length, 2);
  assert.equal(draft.source, "human_submitted_prd");
  assert.equal(draft.executionAuthorized, false);
  assert.equal(draft.readyForExecution, false);
  const replay = await (await post(payload)).json();
  assert.equal(replay.replayed, true);
  assert.equal(replay.version, 1);

  const approved = await post({ idempotencyKey: request.idempotencyKey, requestId: plan.requestId,
    planDigest: plan.planDigest, decisionKey: decision.decisionKey, action: "approve",
    mutationKey: "design-http-approve-system-a1", expectedVersion: 1, target: { kind: "system" } });
  assert.equal(approved.status, 200);
  const reviewing = await approved.json();
  assert.equal(reviewing.status, "reviewing");
  assert.equal(reviewing.system.approval.state, "approved");
  assert.equal(reviewing.readyForExecution, false);
  const nodeFeedback = { idempotencyKey: request.idempotencyKey, requestId: plan.requestId,
    planDigest: plan.planDigest, decisionKey: decision.decisionKey,
    action: "request_revision", mutationKey: "design-http-system-feedback-a1",
    expectedVersion: 2, target: { kind: "system" },
    feedback: "系统权限边界需补充多租户数据隔离。" };
  assert.equal((await post({ ...nodeFeedback, feedback: "" })).status, 400);
  assert.equal((await post({ ...nodeFeedback, feedback: "x".repeat(2_001) })).status, 400);
  const feedbackResponse = await post(nodeFeedback);
  assert.equal(feedbackResponse.status, 200);
  const feedback = await feedbackResponse.json();
  assert.equal(feedback.version, 3);
  assert.equal(feedback.system.approval.state, "invalidated");
  assert.equal(feedback.pendingReviewNotes.length, 1);
  assert.equal(feedback.pendingReviewNotes[0].feedback, nodeFeedback.feedback);
  assert.equal(feedback.pendingReviewNotes[0].sourceVersion, 2);
  assert.equal(feedback.history.at(-1).reviewNote.noteId, nodeFeedback.mutationKey);
  assert.equal(feedback.executionAuthorized, false);
  const replayFeedback = await (await post(nodeFeedback)).json();
  assert.equal(replayFeedback.replayed, true);
  assert.equal(replayFeedback.version, 3);
  assert.equal((await post({ ...nodeFeedback, mutationKey: "design-http-stale-feedback-a1" })).status, 409);
  assert.equal((await post({ ...nodeFeedback, mutationKey: "design-http-approve-after-note-a1",
    action: "approve", expectedVersion: 3, target: { kind: "system" } })).status, 409);
  const revisionResponse = await post({ ...payload, action: "revise_system", expectedVersion: 3,
    mutationKey: "design-http-resolve-feedback-a1", design: undefined,
    system: { ...payload.design.system, architecture: "Service modules and tenancy-isolated permissions" } });
  assert.equal(revisionResponse.status, 200);
  const revised = await revisionResponse.json();
  assert.equal(revised.version, 4);
  assert.equal(revised.pendingReviewNotes.length, 0);
  assert.deepEqual(revised.history.at(-1).resolvedReviewNoteIds, [nodeFeedback.mutationKey]);
  designUrl.searchParams.delete("version");
  const restoredLatest = await (await fetch(designUrl, { headers: auth })).json();
  assert.equal(restoredLatest.version, 4);
  assert.equal(restoredLatest.pendingReviewNotes.length, 0);
  assert.equal((await post({ ...payload, mutationKey: "design-http-stale-cas-a1" })).status, 409);
  designUrl.searchParams.set("version", "1");
  const historical = await (await fetch(designUrl, { headers: auth })).json();
  assert.equal(historical.version, 1);
  assert.equal(historical.currentVersion, 4);
  assert.equal(historical.historical, true);
  assert.equal(historical.system.approval.state, "pending");
  assert.equal((await fetch(`${url}/api/agent/designs?idempotencyKey=${request.idempotencyKey}&version=0`,
    { headers: auth })).status, 400);
});

test("ordinary Live mode never exposes human design writes", async (t) => {
  const server = createLiveControlRoomServer({ port: 0, service: { getSnapshot: async () => null } });
  t.after(() => server.close());
  const { url } = await server.start();
  assert.equal((await fetch(`${url}/api/agent/designs`)).status, 403);
  assert.equal((await fetch(`${url}/api/agent/designs`, { method: "POST",
    headers: { origin: url, "content-type": "application/json" }, body: "{}" })).status, 403);
});
