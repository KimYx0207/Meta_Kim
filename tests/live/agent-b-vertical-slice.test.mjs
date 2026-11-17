import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { setImmediate } from "node:timers/promises";

import { createAgentStartService } from "../../src/application/agent/agent-start-service.mjs";
import { createAgentWorkflowService } from "../../src/application/agent/agent-workflow-service.mjs";
import { createLiveControlRoomServer } from "../../src/infrastructure/live/live-control-room-server.mjs";

function nativePlan(projectRoot, onLaunch) {
  return createAgentStartService({ projectRoot, enabled: true,
    environment: { PATH: process.env.PATH, CODEX_TOKEN: "private-token-must-never-leave" },
    probe: (command) => command === "claude"
      ? { status: "detected", version: "2.1.319 (Claude Code)" }
      : { status: "not_found", version: null },
    launch: onLaunch,
  });
}

async function openApp(projectRoot, onLaunch) {
  const agentStartService = createAgentWorkflowService({ projectRoot,
    agentStartService: nativePlan(projectRoot, onLaunch) });
  const server = createLiveControlRoomServer({ projectRoot, port: 0, globalHub: false,
    enableAgentStart: true, workspaceEnabled: true,
    service: { getSnapshot: async () => null }, agentStartService });
  const { url } = await server.start();
  const html = await (await fetch(url)).text();
  const configMatch = html.match(/<script type="application\/json" id="live-workspace-config">([^<]+)<\/script>/u);
  assert.ok(configMatch, "real page must embed the private workspace authentication contract");
  const config = JSON.parse(configMatch[1]);
  const auth = { [config.controlHeader]: config.controlToken };
  const headers = { ...auth, origin: url, "content-type": "application/json" };
  return { server, url, auth, headers };
}

test("full B1 vertical slice: real localhost HTTP, auto native plan adapter, decision, restart and project isolation", async (t) => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "meta-kim-b-vertical-a-"));
  const otherProject = mkdtempSync(path.join(tmpdir(), "meta-kim-b-vertical-b-"));
  t.after(() => { rmSync(projectRoot, { recursive: true, force: true });
    rmSync(otherProject, { recursive: true, force: true }); });
  const invocations = [];
  const planned = async (command, args, options) => {
    invocations.push({ command, args, options });
    return { status: 0, stdout: JSON.stringify({ result:
      "方案 A：先做单项目试点；方案 B：按模块阶段交付；方案 C：一次完整重构。推荐方案 B，须人工选定。" }) };
  };
  const app = await openApp(projectRoot, planned);
  t.after(async () => { await app.server.close(); });
  const hosts = await (await fetch(`${app.url}/api/agent/hosts`, { headers: app.auth })).json();
  assert.equal(hosts.recommendedHostId, "claude");
  assert.equal(hosts.executionScope.kind, "server_bound");
  const task = { goal: "比较现有工作流的三个可行方案，并等待用户选择", hostId: "auto",
    idempotencyKey: "vertical-b-plan-20261117" };
  const starting = await fetch(`${app.url}/api/agent/start`, { method: "POST", headers: app.headers,
    body: JSON.stringify(task) });
  assert.equal(starting.status, 200);
  const accepted = await starting.json();
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.selectedHostId, "claude");
  assert.equal(accepted.runId, null);
  assert.equal(accepted.executionAuthorized, false);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].command, "claude");
  assert.equal(invocations[0].options.env.CODEX_TOKEN, undefined);
  assert.deepEqual(invocations[0].args.slice(2, 6), ["--permission-mode", "plan", "--permission-prompts", "none"]);

  const receiptUrl = new URL(`${app.url}/api/agent/requests`);
  receiptUrl.searchParams.set("idempotencyKey", task.idempotencyKey);
  let receipt;
  for (let i = 0; i < 12; i += 1) {
    receipt = await (await fetch(receiptUrl, { headers: app.auth })).json();
    if (receipt.status === "completed") break;
    await setImmediate();
  }
  assert.equal(receipt.status, "completed");
  assert.match(receipt.resultPreview, /方案 B/u);
  assert.match(receipt.planDigest, /^[a-f0-9]{64}$/u);
  assert.equal(receipt.decision.state, "awaiting_human");
  const decision = { idempotencyKey: task.idempotencyKey, requestId: receipt.requestId,
    planDigest: receipt.planDigest, action: "adopt", decisionKey: "vertical-b-decision-20261117",
    selectedStrategy: "方案 B：分阶段交付", selectionReason: "范围可控，能分阶段复核。" };
  const decisionResponse = await fetch(`${app.url}/api/agent/decisions`, { method: "POST", headers: app.headers,
    body: JSON.stringify(decision) });
  assert.equal(decisionResponse.status, 200);
  const decided = await decisionResponse.json();
  assert.equal(decided.decision.state, "adopted_for_design");
  assert.equal(decided.decision.alternativesVerified, false);
  assert.equal(decided.executionAuthorized, false);
  assert.equal(invocations.length, 1, "choosing a strategy is not a native execution command");

  await app.server.close();
  const reopened = await openApp(projectRoot, () => { throw new Error("Restart must not relaunch a native CLI"); });
  t.after(async () => { await reopened.server.close(); });
  const sameUrl = new URL(`${reopened.url}/api/agent/requests`);
  sameUrl.searchParams.set("idempotencyKey", task.idempotencyKey);
  const restored = await (await fetch(sameUrl, { headers: reopened.auth })).json();
  assert.equal(restored.status, "completed");
  assert.equal(restored.decision.selectedStrategy, decision.selectedStrategy);
  assert.equal(restored.decision.selectionReason, decision.selectionReason);
  assert.equal(restored.planDigest, receipt.planDigest);
  assert.equal(restored.runId, null);
  const duplicate = await (await fetch(`${reopened.url}/api/agent/start`, { method: "POST",
    headers: reopened.headers, body: JSON.stringify(task) })).json();
  assert.equal(duplicate.status, "accepted");
  assert.equal(duplicate.requestId, receipt.requestId);
  assert.equal(invocations.length, 1);

  const isolated = await openApp(otherProject, () => { throw new Error("Other project may not use this receipt"); });
  t.after(async () => { await isolated.server.close(); });
  const unknownUrl = new URL(`${isolated.url}/api/agent/requests`);
  unknownUrl.searchParams.set("idempotencyKey", task.idempotencyKey);
  const unknown = await (await fetch(unknownUrl, { headers: isolated.auth })).json();
  assert.equal(unknown.status, "unknown");
  assert.notEqual(unknown.executionScope.projectFingerprint, receipt.executionScope.projectFingerprint);
});
