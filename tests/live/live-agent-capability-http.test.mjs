import assert from "node:assert/strict";
import test from "node:test";

import { createLiveControlRoomServer } from "../../src/infrastructure/live/live-control-room-server.mjs";

function agentStartStub() {
  const calls = [];
  return {
    calls,
    close: async () => {},
    getHosts: async () => ({ schemaVersion: "meta-kim-agent-hosts-v1", executionAllowed: false, hosts: [] }),
    getProfessionalDirectory: async () => { calls.push("directory"); return { status: "verified_local", agents: [
      { id: "kim-service:product-listing-writer", label: "商品详情页专业方法",
        registrationState: "verified_source_only", invocationState: "not_observed" },
    ] }; },
    getNativeDirectory: async () => { calls.push("native_directory"); return {
      scanScope: "server_host",
      nativeHosts: [{ id: "codex", label: "Codex CLI", status: "detected",
        available: true, launchSupported: false,
        launchPolicy: "not_authorized", blockedReason: "personal_codex_token_not_authorized" }],
      nativeCapabilities: [{ key: "codex:project:mcp:reviewed-server",
        id: "reviewed-server", label: "reviewed-server", hostId: "codex", kind: "mcp",
        source: "project_native_config", registrationState: "configured_only",
        loadState: "unknown", invocationState: "not_observed" }],
    }; },
    start: async () => { calls.push("start"); throw new Error("not launched"); },
    inspect: async () => { calls.push("inspect"); throw new Error("not inspected"); },
  };
}

function pageToken(html) {
  const match = html.match(/<script type="application\/json" id="live-workspace-config">([^<]+)<\/script>/u);
  assert.ok(match);
  const config = JSON.parse(match[1]);
  return { [config.controlHeader]: config.controlToken };
}

test("capability directory is GET-only and token-bound, without launching an Agent", async (t) => {
  const launcher = agentStartStub();
  const sidecar = createLiveControlRoomServer({
    port: 0,
    projectRoot: process.cwd(),
    enableAgentStart: true,
    service: { getSnapshot: async () => null },
    agentStartService: launcher,
  });
  t.after(() => sidecar.close());
  const { url } = await sidecar.start();
  const headers = pageToken(await (await fetch(url)).text());

  assert.equal((await fetch(`${url}/api/agent/capabilities`)).status, 403);
  const wrongMethod = await fetch(`${url}/api/agent/capabilities`, { method: "POST", headers });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET");
  assert.equal((await fetch(`${url}/api/agent/capabilities`, {
    headers: { ...headers, origin: "https://external.invalid" },
  })).status, 403);

  const response = await fetch(`${url}/api/agent/capabilities`, { headers });
  assert.equal(response.status, 200);
  const catalog = await response.json();
  assert.equal(catalog.source, "repository_registry");
  assert.equal(catalog.evidenceLevel, "registered_only");
  assert.equal(catalog.observedRuntime, false);
  assert.equal(catalog.agents.length, 9);
  assert.equal(catalog.counts.callableSkillPackages, 2);
  assert.equal(catalog.counts.skillReferences, 23);
  assert.equal(catalog.counts.hooks, 35);
  assert.equal(catalog.counts.mcpTools, 7);
  assert.equal(catalog.counts.subagents, null);
  assert.deepEqual(catalog.subagents, []);
  assert.equal(catalog.professionalSourceStatus, "verified_local");
  assert.equal(catalog.counts.professionalAgents, 1);
  assert.equal(catalog.professionalAgents[0].invocationState, "not_observed");
  assert.equal(catalog.scanScope, "server_host");
  assert.equal(catalog.counts.nativeHosts, 1);
  assert.equal(catalog.counts.nativeCapabilities, 1);
  assert.equal(catalog.nativeHosts[0].id, "codex");
  assert.equal(catalog.nativeHosts[0].launchSupported, false);
  assert.equal(catalog.nativeHosts[0].blockedReason, "personal_codex_token_not_authorized");
  assert.equal(catalog.nativeCapabilities[0].loadState, "unknown");
  assert.equal(catalog.nativeCapabilities[0].invocationState, "not_observed");
  assert.ok(catalog.agents.every((entry) => entry.invocationState === "not_observed"));
  assert.deepEqual(launcher.calls, ["directory", "native_directory"],
    "catalog read requests only safe inventory services, without dispatching a native Agent");
  assert.equal(JSON.stringify(catalog).includes("CODEX_TOKEN"), false);
});

test("ordinary read-only Live Hub never publishes private capability directory", async (t) => {
  const sidecar = createLiveControlRoomServer({ port: 0, service: { getSnapshot: async () => null } });
  t.after(() => sidecar.close());
  const { url } = await sidecar.start();
  const headers = pageToken(await (await fetch(url)).text());
  const response = await fetch(`${url}/api/agent/capabilities`, { headers });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "agent_entry_not_enabled");
});
