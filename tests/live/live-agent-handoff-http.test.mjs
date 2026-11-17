import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentWorkflowService } from "../../src/application/agent/agent-workflow-service.mjs";
import { createLiveControlRoomServer } from "../../src/infrastructure/live/live-control-room-server.mjs";

function configFromHtml(html) {
  const match = html.match(/<script type="application\/json" id="live-workspace-config">([^<]+)<\/script>/u);
  assert.ok(match);
  return JSON.parse(match[1]);
}

test("Live handoff API only prepares a content-addressed human PRD packet", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "meta-live-handoff-http-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let nativeStarts = 0;
  const native = { getHosts: async () => ({ schemaVersion: "meta-kim-agent-hosts-v1", hosts: [], executionAllowed: true }),
    start: async () => { nativeStarts++; return { status: "accepted", requestId: "native", runId: null }; },
    inspect: () => ({ status: "completed", resultPreview: "方案 B：人工关键节点" }), close: () => {} };
  const service = createAgentWorkflowService({ projectRoot: root, agentStartService: native });
  const server = createLiveControlRoomServer({ projectRoot: root, globalHub: false, port: 0,
    enableAgentStart: true, service: { getSnapshot: async () => null }, agentStartService: service });
  t.after(() => server.close());
  const { url } = await server.start();
  const cfg = configFromHtml(await (await fetch(url)).text());
  const auth = { [cfg.controlHeader]: cfg.controlToken };
  const headers = { ...auth, origin: url, "content-type": "application/json" };
  const key = "handoff-http-20261117-a1";
  const started = await fetch(`${url}/api/agent/start`, { method: "POST", headers,
    body: JSON.stringify({ goal: "Prepare handoff preview", hostId: "claude", idempotencyKey: key }) });
  assert.equal(started.status, 200);
  const plan = await (await fetch(`${url}/api/agent/requests?idempotencyKey=${key}`, { headers: auth })).json();
  const decisionKey = "handoff-http-decision-a1";
  assert.equal((await fetch(`${url}/api/agent/decisions`, { method: "POST", headers,
    body: JSON.stringify({ idempotencyKey: key, requestId: plan.requestId, planDigest: plan.planDigest,
      action: "adopt", decisionKey, selectedStrategy: "B", selectionReason: "Human review" }) })).status, 200);
  const basis = { idempotencyKey: key, requestId: plan.requestId, planDigest: plan.planDigest, decisionKey };
  const draft = await fetch(`${url}/api/agent/designs`, { method: "POST", headers,
    body: JSON.stringify({ ...basis, action: "submit", mutationKey: "handoff-http-design-a1",
      expectedVersion: 0, design: { system: { title: "System", goal: "Safe workflow",
        architecture: "One module", techStack: "Node.js", acceptance: ["Human signed review"] },
      modules: [{ id: "module1", title: "Module", objective: "Review design",
        inputContract: ["Input"], outputContract: ["Output"], boundaries: [],
        acceptance: ["Output reviewed"], dependencies: [] }] } }) });
  assert.equal(draft.status, 200);
  const handoffUrl = `${url}/api/agent/handoff?idempotencyKey=${key}`;
  const blocked = await (await fetch(handoffUrl, { headers: auth })).json();
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.reason, "design_review_incomplete");
  for (const [expectedVersion, target, mutationKey] of [
    [1, { kind: "system" }, "handoff-http-system-a1"],
    [2, { kind: "module", moduleId: "module1" }, "handoff-http-module-a1"],
  ]) {
    const response = await fetch(`${url}/api/agent/designs`, { method: "POST", headers,
      body: JSON.stringify({ ...basis, action: "approve", target, mutationKey, expectedVersion }) });
    assert.equal(response.status, 200);
  }
  const candidate = await (await fetch(handoffUrl, { headers: auth })).json();
  assert.equal(candidate.status, "eligible");
  assert.equal(candidate.envelope.project.projectFingerprint, candidate.executionScope.projectFingerprint);
  assert.equal(candidate.envelope.design.modules.length, 1);
  assert.equal(candidate.readyForExecution, false);
  const payload = { ...basis, designVersion: candidate.designVersion,
    designDigest: candidate.designDigest, handoffKey: "handoff-http-preparation-a1" };
  const post = (body, overrides = {}) => fetch(`${url}/api/agent/handoff`, {
    method: "POST", headers: { ...headers, ...overrides }, body: JSON.stringify(body),
  });
  assert.equal((await fetch(handoffUrl)).status, 403);
  assert.equal((await post(payload, { origin: "https://external.example" })).status, 403);
  assert.equal((await post(payload, { "content-type": "text/plain" })).status, 403);
  assert.equal((await post({ ...payload, designVersion: 2 })).status, 409);
  assert.equal((await post({ ...payload, projectId: "another-project" })).status, 400);
  assert.equal((await fetch(`${url}/api/agent/handoff`, { method: "PUT", headers: auth })).status, 405);
  const prepared = await post(payload);
  assert.equal(prepared.status, 200);
  const receipt = await prepared.json();
  assert.equal(receipt.status, "prepared");
  assert.equal(receipt.receipt.handoffDigest, candidate.handoffDigest);
  assert.equal(receipt.requiresNativeHostConfirmation, true);
  assert.equal(receipt.readyForExecution, false);
  assert.equal(receipt.executionAuthorized, false);
  assert.equal(receipt.runId, null);
  assert.equal(nativeStarts, 1);
  assert.equal((await (await post(payload)).json()).history.length, 1);
  assert.equal((await (await fetch(handoffUrl, { headers: auth })).json()).status, "prepared");
});

test("ordinary read-only Live denies handoff inspection and preparation", async (t) => {
  const server = createLiveControlRoomServer({ port: 0, service: { getSnapshot: async () => null } });
  t.after(() => server.close());
  const { url } = await server.start();
  assert.equal((await fetch(`${url}/api/agent/handoff`)).status, 403);
  assert.equal((await fetch(`${url}/api/agent/handoff`, { method: "POST", headers: {
    origin: url, "content-type": "application/json",
  }, body: "{}" })).status, 403);
});
