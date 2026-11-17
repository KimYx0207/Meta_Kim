import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { activateSpineState, createInitialState } from "../../canonical/runtime-assets/shared/hooks/spine-state.mjs";
import { agentWorkflowProjectFingerprint } from "../../src/domain/runtime/agent-workflow-decision.mjs";
import { digestAgentHandoffEnvelope } from "../../src/domain/runtime/agent-handoff-envelope.mjs";
import {
  buildAgentHandoffWorkContext, createAgentExecutionBridge,
} from "../../src/application/agent/agent-execution-bridge.mjs";

const RUN_ID = "meta-agent-existing-run";
const CHAT_ID = "01900000-0000-7000-8000-000000000081";
const KEY = "handoff_intake_key_001";
const hex = (character) => character.repeat(64);
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function fakeApprovedHandoff(root, profile = "default") {
  const projectFingerprint = agentWorkflowProjectFingerprint(root, profile);
  const basis = { projectFingerprint, idempotencyKey: KEY, requestId: "request_intake_001",
    planDigest: hex("a"), decisionKey: "human_choice_001", selectedStrategy: "分阶段落地",
    selectionReason: "先验证实际价值再扩大范围" };
  const designDigest = hex("b");
  const envelope = { schemaVersion: "meta-kim-agent-handoff-envelope-v1",
    project: { kind: "server_bound", projectLabel: path.basename(root), projectFingerprint },
    plan: { ...basis, source: "native_read_only_plan_human_selection", resultPreview: "原生只读研究摘要",
      researchEvidenceVerified: false, sourceCompleteness: "bounded_read_only_preview_only" },
    design: { version: 1, designDigest, recordDigest: hex("d"), source: "human_submitted_prd",
      system: { title: "内部经营工具", approval: { state: "approved" } },
      modules: [{ id: "data", approval: { state: "approved" } },
        { id: "ux", approval: { state: "approved" } }] },
    constraints: { nativeHostConfirmationRequired: true, governedRunCreationRequired: true,
      sideEffectApprovalRequired: true, executionAuthorized: false } };
  const handoffDigest = digestAgentHandoffEnvelope(envelope);
  return { schemaVersion: "meta-kim-agent-handoff-v1", status: "prepared",
    executionScope: { kind: "server_bound", projectLabel: path.basename(root), projectFingerprint },
    basis, designVersion: 1, designDigest, handoffDigest, envelope,
    receipt: { handoffKey: "reviewed-handoff", preparedAt: "2026-11-17T01:00:00.000Z", handoffDigest },
    requiresNativeHostConfirmation: true, readyForExecution: false,
    executionAuthorized: false, runId: null };
}

async function createFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-agent-bridge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, ".meta-kim", "state", "default", "governed-executions"), { recursive: true });
  const handoff = fakeApprovedHandoff(root);
  const workflow = { async inspectHandoff() { return handoff; } };
  const service = createAgentExecutionBridge({ projectRoot: root, agentWorkflowService: workflow });
  return { root, handoff, workflow, service };
}

async function registerOfficialRun(fixture, { runtime = "claude", planOnly = false, tamperContext = false,
  recordOrigin = "governed_run", sourceBasis = "transcript_file_verified" } = {}) {
  const state = createInitialState({ activationMode: "hook_observed", driverMode: "hook_observed",
    hookGateMode: "advisory", sourceConversation: {
      runtime, conversationId: CHAT_ID, matchBasis: sourceBasis,
    } });
  state.runId = RUN_ID;
  state.sourceConversation.runId = RUN_ID;
  state.recordOrigin = recordOrigin;
  state.currentStage = "thinking";
  state.stages.critical.status = "completed";
  state.stages.fetch.status = "completed";
  state.stages.thinking.status = "in_progress";
  await activateSpineState(fixture.root, state);
  const context = buildAgentHandoffWorkContext(fixture.handoff, fixture.handoff.basis.projectFingerprint);
  const artifact = { runId: RUN_ID, recordOrigin, workContext: tamperContext
    ? { ...context, contextRevision: `design:${hex("f")}` } : context, ...(planOnly ? { preparation: { status: "needs_thinking" } } : {}) };
  await writeFile(path.join(fixture.root, ".meta-kim", "state", "default", "governed-executions", `${RUN_ID}.json`),
    `${JSON.stringify(artifact)}\n`, { mode: 0o600 });
  return artifact;
}

test("B1/B2 handoff yields only advisory work context, never a Run ID or execution authority", async t => {
  const f = await createFixture(t);
  const result = await f.service.prepare({ idempotencyKey: KEY });
  assert.equal(result.status, "awaiting_verified_native_run");
  assert.equal(result.runId, null);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.nativeInvocationVerified, false);
  assert.equal(result.sourceEvidenceVerified, false);
  assert.equal(result.workContext.contextRevision, `handoff:${f.handoff.handoffDigest}`);
  assert.equal(result.workContext.decisionRefs[0], `agent-decision:${f.handoff.basis.decisionKey}`);
  assert.equal(result.workContext.acceptedArtifactRefs[0], `design:sha256:${f.handoff.designDigest}`);
  assert.equal(result.workContext.acceptedArtifactRefs[1], `handoff:sha256:${f.handoff.handoffDigest}`);
});

test("digest drift in a prepared B2 receipt is rejected without native Run admission", async t => {
  const f = await createFixture(t);
  f.handoff.envelope.plan.resultPreview = "修改后的研究结论";
  const result = await f.service.prepare({ idempotencyKey: KEY });
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "agent_handoff_binding_invalid");
  assert.equal(result.runId, null);
});

test("missing, stale or cross-project B2 approval cannot prepare an execution handoff", async t => {
  const f = await createFixture(t);
  assert.equal((await f.service.prepare({ idempotencyKey: "bad" })).reason, "agent_request_key_invalid");
  f.handoff.status = "stale";
  assert.equal((await f.service.prepare({ idempotencyKey: KEY })).reason, "agent_handoff_stale");
  f.handoff.status = "prepared";
  f.handoff.envelope = undefined;
  assert.equal((await f.service.prepare({ idempotencyKey: KEY })).reason, "agent_handoff_binding_invalid");
  f.handoff.envelope = fakeApprovedHandoff(f.root).envelope;
  f.handoff.envelope.design.modules[0].approval.state = "pending";
  assert.equal((await f.service.prepare({ idempotencyKey: KEY })).reason, "agent_handoff_binding_invalid");
  f.handoff.envelope.design.modules[0].approval.state = "approved";
  f.handoff.basis.projectFingerprint = digest("another-project");
  assert.equal((await f.service.prepare({ idempotencyKey: KEY })).reason, "agent_handoff_binding_invalid");
});

test("an invented run ID or a planning artifact cannot satisfy the existing governed Run authority", async t => {
  const f = await createFixture(t);
  assert.equal((await f.service.bindExistingRun({ idempotencyKey: KEY, runId: "invented" })).reason,
    "governed_current_run_not_verified");
  await registerOfficialRun(f, { planOnly: true });
  assert.equal((await f.service.bindExistingRun({ idempotencyKey: KEY, runId: RUN_ID })).reason,
    "governed_run_artifact_unavailable");
});

test("actual spine-bound and Work-bound host may receive B2 as design handoff, not write permission", async t => {
  const f = await createFixture(t);
  await registerOfficialRun(f);
  const result = await f.service.bindExistingRun({ idempotencyKey: KEY, runId: RUN_ID });
  assert.equal(result.status, "bound_for_native_design_publication", JSON.stringify(result));
  assert.equal(result.runId, RUN_ID);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.nativeInvocationVerified, false);
  assert.equal(result.publicReady, false);
  assert.equal(result.nativeHostBinding, "existing_spine_transcript_file_verified");
  assert.match(result.nextAction, /publishDesign/);
});

test("a different immutable Work context is rejected even if its runId is valid", async t => {
  const f = await createFixture(t);
  await registerOfficialRun(f, { tamperContext: true });
  const result = await f.service.bindExistingRun({ idempotencyKey: KEY, runId: RUN_ID });
  assert.equal(result.reason, "governed_run_work_context_mismatch");
});

test("an unapproved runtime cannot be confused with an authorized native host", async t => {
  const f = await createFixture(t);
  await registerOfficialRun(f, { runtime: "codex" });
  const result = await f.service.bindExistingRun({ idempotencyKey: KEY, runId: RUN_ID });
  assert.equal(result.reason, "personal_codex_token_not_authorized");
});

test("fixture and demo Runs cannot claim authoritative native execution", async t => {
  const f = await createFixture(t);
  await registerOfficialRun(f, { recordOrigin: "acceptance_fixture" });
  const result = await f.service.bindExistingRun({ idempotencyKey: KEY, runId: RUN_ID });
  assert.equal(result.reason, "governed_current_run_not_verified");
});
