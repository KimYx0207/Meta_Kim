import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, rmdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentWorkflowService } from "../../src/application/agent/agent-workflow-service.mjs";

const REQUEST = {
  goal: "Create a pragmatic B-path workflow and explain alternatives.",
  hostId: "claude",
  idempotencyKey: "meta-agent-review-20261117-a1",
};

function fixture(t) {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "meta-agent-workflow-"));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const current = new Map();
  let launches = 0;
  const native = {
    getHosts: async () => ({ schemaVersion: "meta-kim-agent-hosts-v1", hosts: [], executionAllowed: true }),
    start: async ({ idempotencyKey, hostId }) => {
      launches++;
      current.set(idempotencyKey, { status: "running" });
      return { status: "accepted", requestId: "native-only", runId: null,
        ...(hostId === "auto" && { selectedHostId: "gemini" }) };
    },
    inspect: ({ idempotencyKey }) => current.get(idempotencyKey) ?? { status: "unknown" },
    close: () => {},
  };
  return {
    projectRoot,
    current,
    native,
    launchCount: () => launches,
    create: () => createAgentWorkflowService({ projectRoot, agentStartService: native }),
  };
}

test("B path persists native read-only plan and hash-bound human adoption across restart", async (t) => {
  const f = fixture(t);
  const service = f.create();
  const hosts = await service.getHosts();
  assert.equal(hosts.executionScope.kind, "server_bound");
  assert.equal(hosts.executionScope.projectLabel, path.basename(f.projectRoot));
  const first = await service.start(REQUEST);
  assert.equal(first.status, "accepted");
  assert.equal(first.runId, null);
  assert.equal(first.executionAuthorized, false);
  assert.equal(f.launchCount(), 1);

  const progress = await service.inspect({ idempotencyKey: REQUEST.idempotencyKey });
  assert.equal(progress.status, "running");
  assert.equal(progress.decision.state, "not_ready");
  assert.equal(progress.planDigest, undefined);

  f.current.set(REQUEST.idempotencyKey, { status: "completed", resultPreview: "方案 A 与 B；建议 B，在设计阶段人工确认。" });
  const ready = await service.inspect({ idempotencyKey: REQUEST.idempotencyKey });
  assert.equal(ready.status, "completed");
  assert.equal(ready.decision.state, "awaiting_human");
  assert.match(ready.planDigest, /^[a-f0-9]{64}$/u);
  assert.equal(ready.executionAuthorized, false);
  assert.equal(ready.resultPreview, "方案 A 与 B；建议 B，在设计阶段人工确认。");

  const decisionInput = {
    idempotencyKey: REQUEST.idempotencyKey,
    requestId: ready.requestId,
    planDigest: ready.planDigest,
    action: "adopt",
    feedback: "采用 B 方案；设计稿仍要复核。",
    decisionKey: "decision-20261117-a1",
    selectedStrategy: "方案 B：关键节点人工确认",
    selectionReason: "让自动化负责研究与制作，关键决定由用户拍板。",
  };
  const decided = await service.recordDecision(decisionInput);
  assert.equal(decided.status, "recorded");
  assert.equal(decided.decision.state, "adopted_for_design");
  assert.equal(decided.decision.selectedStrategy, decisionInput.selectedStrategy);
  assert.equal(decided.decision.selectionReason, decisionInput.selectionReason);
  assert.equal(decided.decision.alternativesVerified, false);
  assert.equal(decided.executionAuthorized, false);
  assert.equal(decided.runId, null);
  const same = await service.recordDecision(decisionInput);
  assert.deepEqual(same, decided, "same decisionKey and payload is idempotent");
  await assert.rejects(service.recordDecision({ ...decisionInput, decisionKey: "decision-conflict-2" }),
    { code: "AGENT_REQUEST_CONFLICT", reason: "agent_decision_already_recorded" });
  await assert.rejects(service.recordDecision({ ...decisionInput, selectedStrategy: "方案 A" }),
    { code: "AGENT_REQUEST_CONFLICT", reason: "agent_decision_already_recorded" });

  const restarted = f.create();
  const preserved = await restarted.inspect({ idempotencyKey: REQUEST.idempotencyKey });
  assert.equal(preserved.status, "completed");
  assert.equal(preserved.planDigest, ready.planDigest);
  assert.deepEqual(preserved.decision, decided.decision);
  assert.equal(preserved.executionAuthorized, false);
  assert.equal((await restarted.start(REQUEST)).status, "accepted");
  assert.equal(f.launchCount(), 1, "restart or replay must not launch again");
});

test("restart after incomplete handoff is explicitly in doubt and cannot replay", async (t) => {
  const f = fixture(t);
  const running = f.create();
  const first = await running.start(REQUEST);
  const newProcess = f.create();
  const receipt = await newProcess.inspect({ idempotencyKey: REQUEST.idempotencyKey });
  assert.equal(receipt.status, "unknown");
  assert.equal(receipt.recoveryState, "in_doubt");
  assert.equal(receipt.requestId, first.requestId);
  const repeated = await newProcess.start(REQUEST);
  assert.equal(repeated.status, "blocked");
  assert.equal(repeated.reason, "agent_request_in_doubt");
  assert.equal(f.launchCount(), 1);
  assert.equal((await newProcess.inspect({ idempotencyKey: "invalid" })).status, "unknown");
});

test("the fixed project ledger records native auto-host evidence, never guesses a fallback", async (t) => {
  const f = fixture(t);
  const service = f.create();
  const input = { ...REQUEST, hostId: "auto" };
  const accepted = await service.start(input);
  assert.equal(accepted.selectedHostId, "gemini");
  assert.equal(accepted.executionScope.kind, "server_bound");
  const live = await service.inspect({ idempotencyKey: REQUEST.idempotencyKey });
  assert.equal(live.requestedHostId, "auto");
  assert.equal(live.selectedHostId, "gemini");
  const restarted = f.create();
  const restored = await restarted.inspect({ idempotencyKey: REQUEST.idempotencyKey });
  assert.equal(restored.selectedHostId, "gemini");
  assert.equal(restored.recoveryState, "in_doubt");
  assert.equal(f.launchCount(), 1);
});

test("decisions require authentic completed preview, exact digest, and revision feedback", async (t) => {
  const f = fixture(t);
  const service = f.create();
  const first = await service.start(REQUEST);
  const basis = {
    idempotencyKey: REQUEST.idempotencyKey,
    requestId: first.requestId,
    planDigest: "f".repeat(64),
    action: "revise",
    decisionKey: "revision-20261117-a1",
  };
  await assert.rejects(service.recordDecision({ ...basis, feedback: "具体需要改的内容" }),
    { code: "AGENT_REQUEST_CONFLICT" });
  f.current.set(REQUEST.idempotencyKey, { status: "completed", resultPreview: "请确认细节" });
  const ready = await service.inspect({ idempotencyKey: REQUEST.idempotencyKey });
  await assert.rejects(service.recordDecision({ ...basis, feedback: "修改细节" }),
    { code: "AGENT_REQUEST_CONFLICT" });
  await assert.rejects(service.recordDecision({ ...basis, planDigest: ready.planDigest, feedback: "   " }), TypeError);
  const saved = await service.recordDecision({ ...basis, planDigest: ready.planDigest, feedback: "补充对比数据" });
  assert.equal(saved.decision.state, "revision_requested");
  assert.equal(saved.decision.feedback, "补充对比数据");
  assert.equal(saved.executionAuthorized, false);
});

test("adoption requires named strategy and rationale; exclusive decision lock prevents overwrite", async (t) => {
  const f = fixture(t);
  const service = f.create();
  await service.start(REQUEST);
  f.current.set(REQUEST.idempotencyKey, { status: "completed", resultPreview: "A: 全自动；B: 关键节点人工确认" });
  const receipt = await service.inspect({ idempotencyKey: REQUEST.idempotencyKey });
  const input = { idempotencyKey: REQUEST.idempotencyKey, requestId: receipt.requestId,
    planDigest: receipt.planDigest, action: "adopt", decisionKey: "choice-20261117-a1",
    feedback: "", selectedStrategy: "方案 B", selectionReason: "高风险节点保留人工判断" };
  await assert.rejects(service.recordDecision({ ...input, selectedStrategy: "" }), TypeError);
  await assert.rejects(service.recordDecision({ ...input, selectionReason: " " }), TypeError);
  await assert.rejects(service.recordDecision({ ...input, selectedStrategy: "A".repeat(181) }), TypeError);
  await assert.rejects(service.recordDecision({ ...input, planDigest: "a".repeat(64) }),
    { code: "AGENT_REQUEST_CONFLICT" });

  const lockPath = path.join(f.projectRoot, ".meta-kim", "state", "default", "agent-workflow",
    `${REQUEST.idempotencyKey}.decision-lock`);
  mkdirSync(lockPath);
  await assert.rejects(service.recordDecision(input),
    { code: "AGENT_REQUEST_CONFLICT", reason: "agent_decision_busy_or_in_doubt" });
  rmdirSync(lockPath);
  const stored = await service.recordDecision(input);
  assert.equal(stored.decision.selectedStrategy, "方案 B");
  const other = f.create();
  await assert.rejects(other.recordDecision({ ...input, decisionKey: "choice-20261117-b2", selectedStrategy: "方案 A" }),
    { code: "AGENT_REQUEST_CONFLICT", reason: "agent_decision_already_recorded" });
  assert.equal((await other.recordDecision(input)).decision.selectionReason, input.selectionReason);
});

test("a reused idempotency key cannot change host, goal, or project scope", async (t) => {
  const f = fixture(t);
  const service = f.create();
  await service.start(REQUEST);
  const conflicting = await service.start({ ...REQUEST, goal: "Different task" });
  assert.equal(conflicting.reason, "idempotency_conflict");
  assert.equal(f.launchCount(), 1);
  assert.equal((await service.start({ ...REQUEST, projectId: "other" })).reason, "invalid_request");
  const otherRoot = mkdtempSync(path.join(tmpdir(), "meta-agent-other-"));
  t.after(() => rmSync(otherRoot, { recursive: true, force: true }));
  const otherService = createAgentWorkflowService({ projectRoot: otherRoot, agentStartService: f.native });
  const unknown = await otherService.inspect({ idempotencyKey: REQUEST.idempotencyKey });
  assert.equal(unknown.status, "unknown");
  assert.notEqual(unknown.executionScope.projectFingerprint,
    (await service.inspect({ idempotencyKey: REQUEST.idempotencyKey })).executionScope.projectFingerprint);
});

test("workflow refuses symlinked state paths instead of writing outside project", (t) => {
  const f = fixture(t);
  const outside = mkdtempSync(path.join(tmpdir(), "meta-agent-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  mkdirSync(path.join(outside, "state"));
  symlinkSync(outside, path.join(f.projectRoot, ".meta-kim"), "dir");
  assert.throws(() => f.create(), /symlinks/u);
  assert.equal(f.launchCount(), 0);
});
