import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentWorkflowService } from "../../src/application/agent/agent-workflow-service.mjs";

const request = { goal: "Build audited cross-border enterprise commerce",
  hostId: "claude", idempotencyKey: "b2-draft-request-20261117" };
const design = () => ({ system: {
  title: "Enterprise commerce", goal: "Deliver an audited commerce workflow",
  architecture: "Service boundaries and dependency DAG", techStack: "Node.js with PostgreSQL",
  acceptance: ["Human can inspect every approval"] },
modules: [{ id: "research", title: "Evidence intake", objective: "Ingest source material",
  inputContract: ["Trusted user brief"], outputContract: ["Traceable evidence"], boundaries: [],
  acceptance: ["Inputs are auditable"], dependencies: [] },
{ id: "review", title: "Human review", objective: "Record human choices",
  inputContract: ["Evidence list"], outputContract: ["Approved choice"], boundaries: ["No execution"],
  acceptance: ["Decision preserved"], dependencies: ["research"] }] });

async function setup(t, { nativeStatus = "completed", action = "adopt" } = {}) {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "meta-native-b2-"));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const receipts = new Map();
  const calls = [];
  const native = {
    getHosts: async () => ({ schemaVersion: "meta-kim-agent-hosts-v1", hosts: [], executionAllowed: true }),
    start: async () => ({ status: "accepted", requestId: "native-plan", runId: null }),
    inspect: () => ({ status: "completed", resultPreview: "A: immediate / B: human review" }),
    startDesignDraft: async (input) => {
      calls.push(input);
      receipts.set(input.idempotencyKey, { status: nativeStatus,
        ...(nativeStatus === "completed" && { design: design() }),
        ...(nativeStatus === "failed" && { reason: "client_timeout" }) });
      return { status: "accepted", requestId: "native-design", runId: null, selectedHostId: "claude" };
    },
    inspectDesignDraft: ({ idempotencyKey }) => receipts.get(idempotencyKey) ?? { status: "unknown" },
    close: () => {},
  };
  const create = () => createAgentWorkflowService({ projectRoot, agentStartService: native });
  const service = create();
  await service.start(request);
  const plan = await service.inspect({ idempotencyKey: request.idempotencyKey });
  const decision = await service.recordDecision({ idempotencyKey: request.idempotencyKey,
    requestId: plan.requestId, planDigest: plan.planDigest,
    action, decisionKey: "b2-draft-decision-20261117",
    ...(action === "adopt" && { selectedStrategy: "B: human approvals", selectionReason: "Protect production" }),
  });
  const basis = { idempotencyKey: request.idempotencyKey, requestId: plan.requestId,
    planDigest: plan.planDigest, decisionKey: decision.decision.decisionKey };
  const start = (draftKey = "b2-draft-attempt-20261117", overrides = {}) => service.startDesignDraft({
    ...basis, draftKey, ...overrides,
  });
  return { service, create, calls, receipts, basis, start, projectRoot };
}

test("after adopted B1, native B2 draft is content-addressed, persists, and never becomes approval", async (t) => {
  const f = await setup(t);
  const empty = await f.service.inspectDesignDraft({ idempotencyKey: request.idempotencyKey });
  assert.equal(empty.status, "not_started");
  assert.deepEqual(empty.basis, { projectFingerprint: empty.basis.projectFingerprint,
    ...f.basis, selectedStrategy: "B: human approvals", selectionReason: "Protect production" });
  const accepted = await f.start();
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.runId, null);
  assert.equal(accepted.executionAuthorized, false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].goal, request.goal);
  assert.equal(f.calls[0].selectedStrategy, "B: human approvals");
  assert.equal(f.calls[0].selectionReason, "Protect production");
  assert.equal(f.calls[0].planDigest, f.basis.planDigest);
  const snapshot = await f.service.inspectDesignDraft({ idempotencyKey: request.idempotencyKey });
  assert.equal(snapshot.status, "completed");
  assert.deepEqual(snapshot.design, design());
  assert.match(snapshot.draftDigest, /^[a-f0-9]{64}$/u);
  assert.equal(snapshot.draftSource, "native_readonly_unverified");
  assert.equal(snapshot.nativeEvidenceVerified, false);
  assert.equal(snapshot.executionAuthorized, false);
  assert.equal(snapshot.runId, null);
  const replay = await f.start();
  assert.equal(replay.status, "completed");
  assert.equal(f.calls.length, 1, "same draft key must not dispatch twice");
  const restored = await f.create().inspectDesignDraft({ idempotencyKey: request.idempotencyKey });
  assert.equal(restored.status, "completed");
  assert.equal(restored.draftDigest, snapshot.draftDigest);
  assert.deepEqual(restored.design, snapshot.design);
  assert.equal(f.service.inspectDesign({ idempotencyKey: request.idempotencyKey }).status, "not_started",
    "Native-generated PRD is not a human-approved B2 design");
});

test("human-edited B2 submit can prove its source draft, preserving provenance over revisions and restart", async (t) => {
  const f = await setup(t);
  await f.start();
  const draft = await f.service.inspectDesignDraft({ idempotencyKey: request.idempotencyKey });
  const modified = { ...design(), system: { ...design().system,
    architecture: "Human revised modular DAG with explicit audit gate" } };
  const commit = { ...f.basis, action: "submit", expectedVersion: 0,
    mutationKey: "b2-native-sourced-submit-20261117", sourceDraftDigest: draft.draftDigest,
    design: modified };
  const first = f.service.recordDesign(commit);
  assert.equal(first.version, 1);
  assert.equal(first.status, "draft");
  assert.equal(first.sourceDraftDigest, draft.draftDigest);
  assert.equal(first.draftSource, "native_readonly_unverified");
  assert.equal(first.nativeEvidenceVerified, false);
  assert.notEqual(first.designDigest, draft.draftDigest, "human edits are distinct from native source");
  assert.equal(f.service.recordDesign(commit).replayed, true);
  assert.throws(() => f.service.recordDesign({ ...commit,
    mutationKey: "b2-invalid-source-20261117", sourceDraftDigest: "0".repeat(64) }),
  { code: "AGENT_REQUEST_CONFLICT", reason: "agent_design_source_draft_mismatch" });
  assert.throws(() => f.service.recordDesign({ ...commit,
    mutationKey: "b2-malformed-source-20261117", sourceDraftDigest: "this-is-not-sha256" }),
  { code: "AGENT_REQUEST_CONFLICT", reason: "agent_design_source_draft_mismatch" });
  const approve = f.service.recordDesign({ ...f.basis, action: "approve", expectedVersion: 1,
    mutationKey: "b2-native-sourced-approve-20261117", target: { kind: "system" } });
  assert.equal(approve.version, 2);
  assert.equal(approve.sourceDraftDigest, draft.draftDigest);
  const restored = f.create().inspectDesign({ idempotencyKey: request.idempotencyKey });
  assert.equal(restored.sourceDraftDigest, draft.draftDigest);
  assert.equal(restored.draftSource, "native_readonly_unverified");
  assert.equal(restored.history.length, 2);
});

test("unadopted plan, forged basis, and crashed in-flight draft fail closed without a second native launch", async (t) => {
  const rejected = await setup(t, { action: "reject" });
  assert.equal((await rejected.service.inspectDesignDraft({ idempotencyKey: request.idempotencyKey })).status, "blocked");
  assert.equal((await rejected.start()).reason, "agent_plan_not_adopted");
  assert.equal(rejected.calls.length, 0);

  const f = await setup(t, { nativeStatus: "running" });
  assert.equal((await f.start("b2-draft-crash-20261117", { decisionKey: "forged-decision-key-1234" })).reason,
    "agent_draft_basis_invalid");
  assert.equal(f.calls.length, 0);
  await f.start("b2-draft-crash-20261117");
  assert.equal(f.calls.length, 1);
  const restored = f.create();
  const unknown = await restored.inspectDesignDraft({ idempotencyKey: request.idempotencyKey });
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.recoveryState, "in_doubt");
  assert.equal(unknown.reason, "native_draft_outcome_not_confirmed");
  const duplicate = await restored.startDesignDraft({ ...f.basis, draftKey: "b2-draft-crash-20261117" });
  assert.equal(duplicate.status, "unknown");
  assert.equal(f.calls.length, 1);
  const newAttempt = await restored.startDesignDraft({ ...f.basis, draftKey: "b2-draft-retry-20261117" });
  assert.equal(newAttempt.status, "blocked");
  assert.equal(newAttempt.reason, "agent_draft_prior_outcome_in_doubt");
  assert.equal(f.calls.length, 1);
});

test("terminal native failure supports explicit retry with a new key, never automatic key reuse", async (t) => {
  const f = await setup(t, { nativeStatus: "failed" });
  await f.start("b2-draft-failed-20261117");
  const first = await f.service.inspectDesignDraft({ idempotencyKey: request.idempotencyKey });
  assert.equal(first.status, "failed");
  assert.equal(first.reason, "client_timeout");
  await f.start("b2-draft-failed-20261117");
  assert.equal(f.calls.length, 1);
  await f.start("b2-draft-retry-20261117");
  assert.equal(f.calls.length, 2);
  const newest = await f.service.inspectDesignDraft({ idempotencyKey: request.idempotencyKey });
  assert.equal(newest.draftKey, "b2-draft-retry-20261117");
  assert.equal(newest.status, "failed");
});

test("two adopted project requests may use the same draftKey without sharing native invocation or receipt", async (t) => {
  const f = await setup(t);
  const draftKey = "b2-shared-key-across-tasks";
  await f.start(draftKey);
  const first = await f.service.inspectDesignDraft({ idempotencyKey: request.idempotencyKey });
  const secondRequest = { goal: "Build another independent commerce module", hostId: "claude",
    idempotencyKey: "b2-other-task-20261117" };
  await f.service.start(secondRequest);
  const secondPlan = await f.service.inspect({ idempotencyKey: secondRequest.idempotencyKey });
  await f.service.recordDecision({ idempotencyKey: secondRequest.idempotencyKey,
    requestId: secondPlan.requestId, planDigest: secondPlan.planDigest,
    decisionKey: "b2-other-decision-20261117", action: "adopt",
    selectedStrategy: "A: self-service", selectionReason: "Independent scope" });
  const secondBasis = { idempotencyKey: secondRequest.idempotencyKey,
    requestId: secondPlan.requestId, planDigest: secondPlan.planDigest,
    decisionKey: "b2-other-decision-20261117" };
  const secondStart = await f.service.startDesignDraft({ ...secondBasis, draftKey });
  assert.equal(secondStart.status, "accepted");
  const second = await f.service.inspectDesignDraft({ idempotencyKey: secondRequest.idempotencyKey });
  assert.equal(second.status, "completed");
  assert.equal(f.calls.length, 2);
  assert.notEqual(f.calls[0].idempotencyKey, f.calls[1].idempotencyKey);
  assert.notEqual(first.draftDigest, second.draftDigest, "different human B1 decisions bind different artifacts");
});

test("B1 auto-host without trusted selected host identity cannot silently dispatch B2 to another CLI", async (t) => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "meta-auto-identity-b2-"));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  let draftStarts = 0;
  const native = {
    getHosts: async () => ({ hosts: [], executionAllowed: false }),
    start: async () => ({ status: "accepted", runId: null }),
    inspect: () => ({ status: "completed", resultPreview: "A or B" }),
    startDesignDraft: async () => { draftStarts++; return { status: "accepted" }; },
    inspectDesignDraft: () => ({ status: "unknown" }),
    close: () => {},
  };
  const service = createAgentWorkflowService({ projectRoot, agentStartService: native });
  const intake = { ...request, hostId: "auto", idempotencyKey: "b2-auto-identity-request-20261117" };
  await service.start(intake);
  const plan = await service.inspect({ idempotencyKey: intake.idempotencyKey });
  const decisionKey = "b2-auto-identity-decision-20261117";
  await service.recordDecision({ idempotencyKey: intake.idempotencyKey,
    requestId: plan.requestId, planDigest: plan.planDigest, action: "adopt", decisionKey,
    selectedStrategy: "B: human decisions", selectionReason: "Require provenance" });
  const blocked = await service.startDesignDraft({ idempotencyKey: intake.idempotencyKey,
    requestId: plan.requestId, planDigest: plan.planDigest, decisionKey,
    draftKey: "b2-auto-identity-draft-20261117" });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.reason, "agent_selected_native_host_unavailable");
  assert.equal(draftStarts, 0);
});
