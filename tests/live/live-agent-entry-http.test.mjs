import assert from "node:assert/strict";
import test from "node:test";

import { createLiveControlRoomServer } from "../../src/infrastructure/live/live-control-room-server.mjs";

function fakeService() {
  const calls = [];
  const hostPayload = {
    schemaVersion: "meta-kim-agent-hosts-v1",
    executionAllowed: true,
    hosts: [{ id: "claude", label: "Claude Code", available: true, launchSupported: true }],
  };
  return {
    calls,
    close: async () => { calls.push({ action: "close" }); },
    getHosts: async () => hostPayload,
    start: async (body) => { calls.push({ action: "start", body }); return { status: "accepted", requestId: "request-1", runId: null }; },
    inspect: async (body) => { calls.push({ action: "inspect", body }); return { schemaVersion: "meta-kim-agent-request-v1", status: "accepted", requestId: "request-1", runId: null }; },
  };
}

function extractAgentConfig(html) {
  const match = html.match(/<script type="application\/json" id="live-workspace-config">([^<]+)<\/script>/u);
  assert.ok(match, "Live page must expose its normalized, local-only workspace configuration");
  return JSON.parse(match[1]);
}

test("Agent entry shares Meta Live but must be explicitly enabled, even with an injected launcher", async (t) => {
  const fake = fakeService();
  const controller = createLiveControlRoomServer({
    port: 0,
    service: { getSnapshot: async () => null },
    agentStartService: fake,
  });
  t.after(() => controller.close());
  const { url } = await controller.start();
  const health = await (await fetch(`${url}/api/health`)).json();
  assert.equal(health.agentEntry.enabled, false);

  const html = await (await fetch(url)).text();
  const config = extractAgentConfig(html);
  assert.equal(config.agentEntryEnabled, false);
  const response = await fetch(`${url}/api/agent/hosts`, {
    headers: { [config.controlHeader]: config.controlToken },
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "agent_entry_not_enabled");
  assert.deepEqual(fake.calls, []);
});

test("Agent start is same-origin, token-bound, idempotency-aware and project-bound", async (t) => {
  const fake = fakeService();
  const controller = createLiveControlRoomServer({
    port: 0,
    projectRoot: process.cwd(),
    globalHub: false,
    enableAgentStart: true,
    service: { getSnapshot: async () => null },
    agentStartService: fake,
  });
  t.after(() => controller.close());
  const { url } = await controller.start();
  assert.equal((await (await fetch(`${url}/api/health`)).json()).agentEntry.enabled, true);
  const config = extractAgentConfig(await (await fetch(url)).text());
  assert.equal(config.agentEntryEnabled, true);

  const headers = { [config.controlHeader]: config.controlToken };
  assert.equal((await fetch(`${url}/api/agent/hosts`)).status, 403);
  assert.equal((await fetch(`${url}/api/agent/hosts`, { headers: { ...headers, origin: "https://external.invalid" } })).status, 403);
  const hosts = await (await fetch(`${url}/api/agent/hosts`, { headers })).json();
  assert.equal(hosts.hosts[0].id, "claude");

  const goodBody = { goal: "Create an accessible landing page", hostId: "claude", idempotencyKey: "8bd10db2-b41b-4477-921e-a1b170b11789" };
  const post = (body, overrides = {}) => fetch(`${url}/api/agent/start`, {
    method: "POST",
    headers: { ...headers, origin: url, "content-type": "application/json", ...overrides },
    body: JSON.stringify(body),
  });
  assert.equal((await fetch(`${url}/api/agent/start`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(goodBody) })).status, 403);
  assert.equal((await post(goodBody, { origin: "https://external.invalid" })).status, 403);
  assert.equal((await post({ ...goodBody, projectId: "arbitrary-unverified-project" })).status, 409);
  assert.equal((await post(goodBody, { "content-type": "text/plain" })).status, 403);
  assert.deepEqual(fake.calls, [], "no invalid request should reach the native launcher");

  const accepted = await post(goodBody);
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { status: "accepted", requestId: "request-1", runId: null });
  assert.deepEqual(fake.calls[0], { action: "start", body: goodBody });

  const query = new URL(`${url}/api/agent/requests`);
  query.searchParams.set("idempotencyKey", goodBody.idempotencyKey);
  const receipt = await fetch(query, { headers });
  assert.equal(receipt.status, 200);
  assert.deepEqual(await receipt.json(), { schemaVersion: "meta-kim-agent-request-v1", status: "accepted", requestId: "request-1", runId: null });
  assert.deepEqual(fake.calls[1], { action: "inspect", body: { idempotencyKey: goodBody.idempotencyKey } });
});
