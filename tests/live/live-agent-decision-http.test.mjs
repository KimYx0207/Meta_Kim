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

test("B-path decisions have exact local token, same-origin JSON, and durable hash binding", async (t) => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "meta-live-decision-http-"));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const current = new Map();
  let nativeStarts = 0;
  const native = {
    getHosts: async () => ({ schemaVersion: "meta-kim-agent-hosts-v1", executionAllowed: true,
      hosts: [{ id: "claude", label: "Claude Code", launchSupported: true }] }),
    start: async (input) => {
      nativeStarts++;
      current.set(input.idempotencyKey, { status: "completed", resultPreview: "需人工决定方案 B。" });
      return { status: "accepted", requestId: "native-local", runId: null };
    },
    inspect: ({ idempotencyKey }) => current.get(idempotencyKey) ?? { status: "unknown" },
    close: () => {},
  };
  const service = createAgentWorkflowService({ projectRoot, agentStartService: native });
  const control = createLiveControlRoomServer({ port: 0, projectRoot, globalHub: false,
    enableAgentStart: true, service: { getSnapshot: async () => null }, agentStartService: service });
  t.after(() => control.close());
  const { url } = await control.start();
  const config = extractWorkspaceConfig(await (await fetch(url)).text());
  const auth = { [config.controlHeader]: config.controlToken };
  const headers = { ...auth, origin: url, "content-type": "application/json" };
  const request = { goal: "Compare options and stop before implementation", hostId: "claude",
    idempotencyKey: "workflow-http-20261117-a1" };

  const hosts = await (await fetch(`${url}/api/agent/hosts`, { headers: auth })).json();
  assert.equal(hosts.executionScope.kind, "server_bound");
  const accepted = await fetch(`${url}/api/agent/start`, { method: "POST", headers, body: JSON.stringify(request) });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).executionAuthorized, false);
  assert.equal(nativeStarts, 1);
  const uri = new URL(`${url}/api/agent/requests`);
  uri.searchParams.set("idempotencyKey", request.idempotencyKey);
  const receipt = await (await fetch(uri, { headers: auth })).json();
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.decision.state, "awaiting_human");
  assert.ok(receipt.planDigest);
  const decision = { idempotencyKey: request.idempotencyKey, requestId: receipt.requestId,
    planDigest: receipt.planDigest, action: "adopt", feedback: "方案 B。",
    decisionKey: "decision-http-20261117-a1", selectedStrategy: "方案 B",
    selectionReason: "关键节点需要人工确认" };
  const post = (body, overrides = {}) => fetch(`${url}/api/agent/decisions`, { method: "POST",
    headers: { ...headers, ...overrides }, body: JSON.stringify(body) });
  assert.equal((await post(decision, { origin: "https://other.example" })).status, 403);
  assert.equal((await post(decision, { "content-type": "text/plain" })).status, 403);
  assert.equal((await fetch(`${url}/api/agent/decisions`, { method: "GET", headers: auth })).status, 405);
  assert.equal((await fetch(`${url}/api/agent/decisions`, { method: "POST",
    headers: { origin: url, "content-type": "application/json" }, body: JSON.stringify(decision) })).status, 403);
  assert.equal((await post({ ...decision, planDigest: "0".repeat(64) })).status, 409);
  assert.equal((await post({ ...decision, selectedStrategy: "" })).status, 400);
  assert.equal((await post({ ...decision, selectionReason: "" })).status, 400);
  const recorded = await post(decision);
  assert.equal(recorded.status, 200);
  const result = await recorded.json();
  assert.equal(result.status, "recorded");
  assert.equal(result.decision.state, "adopted_for_design");
  assert.equal(result.decision.selectedStrategy, "方案 B");
  assert.equal(result.decision.alternativesVerified, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.runId, null);
  assert.deepEqual(await (await post(decision)).json(), result);
  const after = await (await fetch(uri, { headers: auth })).json();
  assert.equal(after.decision.state, "adopted_for_design");
  assert.equal(after.status, "completed");
  assert.equal(nativeStarts, 1, "decision endpoints must not launch a client");
});

test("normal Live observers never expose the decision route", async (t) => {
  const server = createLiveControlRoomServer({ port: 0, service: { getSnapshot: async () => null } });
  t.after(() => server.close());
  const { url } = await server.start();
  const result = await fetch(`${url}/api/agent/decisions`, { method: "POST", headers: {
    origin: url, "content-type": "application/json",
  }, body: "{}" });
  assert.equal(result.status, 403);
  assert.equal((await result.json()).error, "agent_entry_not_enabled");
});
