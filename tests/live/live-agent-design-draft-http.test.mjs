import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentWorkflowService } from "../../src/application/agent/agent-workflow-service.mjs";
import { createLiveControlRoomServer } from "../../src/infrastructure/live/live-control-room-server.mjs";

const design = { system: { title: "Commerce portal", goal: "Human controlled design",
  architecture: "Audited module graph", techStack: "Node.js with PostgreSQL", acceptance: ["Reviews visible"] },
modules: [{ id: "research", title: "Research", objective: "Gather requirements",
  inputContract: ["User request"], outputContract: ["Design evidence"], boundaries: [],
  acceptance: ["Traceable evidence"], dependencies: [] }] };

function workspaceConfig(html) {
  const match = html.match(/<script type="application\/json" id="live-workspace-config">([^<]+)<\/script>/u);
  assert.ok(match);
  return JSON.parse(match[1]);
}

test("authenticated B2 design draft endpoint starts read-only once and binds completed design to human PRD", async (t) => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "meta-live-native-b2-"));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const receipts = new Map();
  let nativeLaunches = 0;
  const native = {
    getHosts: async () => ({ schemaVersion: "meta-kim-agent-hosts-v1", hosts: [], executionAllowed: true }),
    start: async () => ({ status: "accepted", requestId: "native-plan", runId: null }),
    inspect: () => ({ status: "completed", resultPreview: "B: human gated" }),
    startDesignDraft: async ({ idempotencyKey }) => {
      nativeLaunches += 1;
      receipts.set(idempotencyKey, { status: "completed", design });
      return { status: "accepted", runId: null };
    },
    inspectDesignDraft: ({ idempotencyKey }) => receipts.get(idempotencyKey) ?? { status: "unknown" },
    close: () => {},
  };
  const service = createAgentWorkflowService({ projectRoot, agentStartService: native });
  const server = createLiveControlRoomServer({ projectRoot, port: 0, globalHub: false,
    enableAgentStart: true, service: { getSnapshot: async () => null }, agentStartService: service });
  t.after(() => server.close());
  const { url } = await server.start();
  const config = workspaceConfig(await (await fetch(url)).text());
  const auth = { [config.controlHeader]: config.controlToken };
  const headers = { ...auth, origin: url, "content-type": "application/json" };
  const request = { goal: "Build commerce product with key human decisions", hostId: "claude",
    idempotencyKey: "b2-native-http-request-20261117" };
  const post = (route, body, overrides = {}) => fetch(`${url}/api/agent/${route}`, { method: "POST",
    headers: { ...headers, ...overrides }, body: JSON.stringify(body) });
  assert.equal((await post("start", request)).status, 200);
  const plan = await (await fetch(`${url}/api/agent/requests?idempotencyKey=${request.idempotencyKey}`,
    { headers: auth })).json();
  const decision = { idempotencyKey: request.idempotencyKey,
    requestId: plan.requestId, planDigest: plan.planDigest, action: "adopt",
    decisionKey: "b2-native-http-decision-20261117",
    selectedStrategy: "B: human gated", selectionReason: "Preserve critical human approvals" };
  assert.equal((await post("decisions", decision)).status, 200);
  const basis = { idempotencyKey: request.idempotencyKey, requestId: plan.requestId,
    planDigest: plan.planDigest, decisionKey: decision.decisionKey };
  const route = `${url}/api/agent/design-drafts?idempotencyKey=${request.idempotencyKey}`;
  const unstarted = await (await fetch(route, { headers: auth })).json();
  assert.equal(unstarted.status, "not_started");
  assert.equal(unstarted.basis.decisionKey, basis.decisionKey);
  assert.equal(unstarted.nativeEvidenceVerified, false);
  const startDraft = { ...basis, draftKey: "b2-http-native-draft-20261117" };
  assert.equal((await fetch(route)).status, 403);
  assert.equal((await post("design-drafts", startDraft, { origin: "https://untrusted.example" })).status, 403);
  assert.equal((await post("design-drafts", startDraft, { "content-type": "text/plain" })).status, 403);
  assert.equal((await post("design-drafts", { ...startDraft, projectId: "foreign" })).status, 409);
  assert.equal((await post("design-drafts", { ...startDraft, decisionKey: "mismatch-decision-20261117" })).status, 200);
  assert.equal(nativeLaunches, 0);
  assert.equal((await fetch(`${url}/api/agent/design-drafts`, { method: "PUT", headers: auth })).status, 405);
  const accepted = await (await post("design-drafts", startDraft)).json();
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.runId, null);
  const completed = await (await fetch(route, { headers: auth })).json();
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.design, design);
  assert.match(completed.draftDigest, /^[a-f0-9]{64}$/u);
  assert.equal(completed.draftSource, "native_readonly_unverified");
  assert.equal(completed.nativeEvidenceVerified, false);
  assert.equal(completed.executionAuthorized, false);
  assert.equal(nativeLaunches, 1);
  assert.equal((await (await post("design-drafts", startDraft)).json()).status, "completed");
  assert.equal(nativeLaunches, 1);
  const submitted = await (await post("designs", { ...basis,
    action: "submit", mutationKey: "b2-http-sourced-submit-20261117",
    expectedVersion: 0, sourceDraftDigest: completed.draftDigest, design })).json();
  assert.equal(submitted.status, "draft");
  assert.equal(submitted.sourceDraftDigest, completed.draftDigest);
  assert.equal(submitted.system.approval.state, "pending");
  assert.equal(submitted.executionAuthorized, false);
  assert.equal(submitted.runId, null);
});

test("ordinary Live observer does not expose B2 native draft creation", async (t) => {
  const server = createLiveControlRoomServer({ port: 0, service: { getSnapshot: async () => null } });
  t.after(() => server.close());
  const { url } = await server.start();
  assert.equal((await fetch(`${url}/api/agent/design-drafts`)).status, 403);
  assert.equal((await fetch(`${url}/api/agent/design-drafts`, { method: "POST",
    headers: { origin: url, "content-type": "application/json" }, body: "{}" })).status, 403);
});
