import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentWorkflowService } from "../../src/application/agent/agent-workflow-service.mjs";

const TASK_KEY = "handoff-request-20261117-a1";

function design() {
  return { system: { title: "Human-gated commerce system", goal: "Produce reliable commerce workflows",
    architecture: "Research -> human select -> delivery", techStack: "Node.js + PostgreSQL",
    acceptance: ["System review completed"] }, modules: [
    { id: "research", title: "Research", objective: "Find referenced evidence", inputContract: ["User intent"],
      outputContract: ["Source options"], boundaries: [], acceptance: ["Sources identified"], dependencies: [] },
    { id: "delivery", title: "Delivery", objective: "Produce design output", inputContract: ["Selected sources"],
      outputContract: ["Design packet"], boundaries: ["No native execution"],
      acceptance: ["Human reviewed"], dependencies: ["research"] },
  ] };
}

async function setup(t, approve = true) {
  const root = mkdtempSync(path.join(tmpdir(), "meta-agent-handoff-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let launches = 0;
  const native = { getHosts: async () => ({ schemaVersion: "meta-kim-agent-hosts-v1", hosts: [], executionAllowed: true }),
    start: async () => { launches++; return { status: "accepted", requestId: "native", runId: null }; },
    inspect: () => ({ status: "completed", resultPreview: "有 A 与 B 两个方向；关键节点由人确认。" }), close: () => {} };
  const create = () => createAgentWorkflowService({ projectRoot: root, agentStartService: native });
  const service = create();
  const initial = service.inspectHandoff({ idempotencyKey: TASK_KEY });
  assert.equal(initial.status, "blocked");
  assert.equal(initial.reason, "agent_plan_not_adopted");
  await service.start({ goal: "Prepare a governed handoff without execution", hostId: "claude", idempotencyKey: TASK_KEY });
  const plan = await service.inspect({ idempotencyKey: TASK_KEY });
  const decision = await service.recordDecision({ idempotencyKey: TASK_KEY,
    requestId: plan.requestId, planDigest: plan.planDigest, decisionKey: "handoff-decision-20261117-a1",
    action: "adopt", selectedStrategy: "方案 B", selectionReason: "保留人工审批" });
  const basis = { idempotencyKey: TASK_KEY, requestId: plan.requestId, planDigest: plan.planDigest,
    decisionKey: decision.decision.decisionKey };
  assert.equal(service.inspectHandoff({ idempotencyKey: TASK_KEY }).reason, "design_not_started");
  const submitted = service.recordDesign({ ...basis, action: "submit", expectedVersion: 0,
    mutationKey: "handoff-design-submit-a1", design: design() });
  assert.equal(submitted.version, 1);
  assert.equal(service.inspectHandoff({ idempotencyKey: TASK_KEY }).reason, "design_review_incomplete");
  if (approve) {
    let version = 1;
    for (const target of [{ kind: "system" }, { kind: "module", moduleId: "research" },
      { kind: "module", moduleId: "delivery" }]) {
      service.recordDesign({ ...basis, action: "approve", expectedVersion: version,
        mutationKey: `handoff-approve-${version++}-20261117`, target });
    }
  }
  return { root, create, service, basis, launches: () => launches };
}

function command(f, packet, handoffKey = "handoff-prepare-20261117-a1") {
  return { ...f.basis, handoffKey, designVersion: packet.designVersion, designDigest: packet.designDigest };
}

test("handoff seals only fully approved human PRD and real B1 project identity", async (t) => {
  const f = await setup(t);
  const preview = f.service.inspectHandoff({ idempotencyKey: TASK_KEY });
  assert.equal(preview.status, "eligible");
  assert.match(preview.handoffDigest, /^[a-f0-9]{64}$/u);
  assert.equal(preview.envelope.project.projectFingerprint, preview.executionScope.projectFingerprint);
  assert.equal(preview.envelope.plan.planDigest, f.basis.planDigest);
  assert.equal(preview.envelope.plan.selectedStrategy, "方案 B");
  assert.equal(preview.envelope.design.system.title, "Human-gated commerce system");
  assert.equal(preview.envelope.design.modules.length, 2);
  assert.equal(preview.envelope.plan.researchEvidenceVerified, false);
  assert.equal(preview.envelope.plan.sourceCompleteness, "bounded_read_only_preview_only");
  assert.equal(preview.envelope.constraints.governedRunCreationRequired, true);
  assert.equal(preview.readyForExecution, false);
  assert.equal(preview.executionAuthorized, false);
  assert.equal(preview.runId, null);
  assert.equal(preview.receipt, null);

  assert.throws(() => f.service.prepareHandoff({ ...command(f, preview), designVersion: 1 }),
    { code: "AGENT_REQUEST_CONFLICT", reason: "agent_handoff_design_version_conflict" });
  assert.throws(() => f.service.prepareHandoff({ ...command(f, preview), planDigest: "a".repeat(64) }),
    { code: "AGENT_REQUEST_CONFLICT", reason: "agent_handoff_plan_decision_mismatch" });
  assert.throws(() => f.service.prepareHandoff({ ...command(f, preview), designDigest: "f".repeat(64) }),
    { code: "AGENT_REQUEST_CONFLICT", reason: "agent_handoff_design_version_conflict" });
  assert.throws(() => f.service.prepareHandoff({ ...command(f, preview), projectId: "evil" }), TypeError);

  const prepared = f.service.prepareHandoff(command(f, preview));
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.receipt.handoffDigest, preview.handoffDigest);
  assert.equal(prepared.receipt.handoffKey, "handoff-prepare-20261117-a1");
  assert.equal(prepared.history.length, 1);
  assert.equal(prepared.runId, null);
  assert.equal(prepared.executionAuthorized, false);
  assert.equal(f.launches(), 1, "handoff preparation never calls the native client");
  assert.equal(f.service.prepareHandoff(command(f, preview)).history.length, 1, "same handoffKey replays");
  assert.throws(() => f.service.prepareHandoff({ ...command(f, preview), handoffKey: "handoff-prepare-20261117-a1",
    designVersion: 2 }), { code: "AGENT_REQUEST_CONFLICT", reason: "agent_handoff_key_conflict" });

  const recovered = f.create().inspectHandoff({ idempotencyKey: TASK_KEY });
  assert.equal(recovered.status, "prepared");
  assert.equal(recovered.receipt.handoffDigest, prepared.receipt.handoffDigest);
  assert.equal(f.launches(), 1);
});

test("a revised design invalidates old static handoff and requires review + fresh seal", async (t) => {
  const f = await setup(t);
  const original = f.service.inspectHandoff({ idempotencyKey: TASK_KEY });
  f.service.prepareHandoff(command(f, original));
  const changed = f.service.recordDesign({ ...f.basis, action: "revise_module",
    expectedVersion: 4, mutationKey: "handoff-revise-module-20261117-a1",
    module: { ...design().modules[0], objective: "Updated research process" } });
  assert.equal(changed.version, 5);
  const afterChange = f.service.inspectHandoff({ idempotencyKey: TASK_KEY });
  assert.equal(afterChange.status, "blocked");
  assert.equal(afterChange.reason, "design_review_incomplete");
  assert.equal(afterChange.previousProposalStale, true);
  assert.equal(afterChange.history.length, 1);
  assert.equal(afterChange.handoffDigest, null);
  assert.throws(() => f.service.prepareHandoff(command(f, original, "handoff-new-stale-20261117")),
    { code: "AGENT_REQUEST_CONFLICT", reason: "agent_handoff_design_not_fully_approved" });
  f.service.recordDesign({ ...f.basis, action: "approve", expectedVersion: 5,
    mutationKey: "handoff-reapprove-research-a1", target: { kind: "module", moduleId: "research" } });
  f.service.recordDesign({ ...f.basis, action: "approve", expectedVersion: 6,
    mutationKey: "handoff-reapprove-delivery-a1", target: { kind: "module", moduleId: "delivery" } });
  const newCandidate = f.service.inspectHandoff({ idempotencyKey: TASK_KEY });
  assert.equal(newCandidate.status, "stale");
  assert.notEqual(newCandidate.handoffDigest, original.handoffDigest);
  assert.equal(newCandidate.designVersion, 7);
  assert.throws(() => f.service.prepareHandoff(command(f, original, "handoff-new-stale-20261117")),
    { code: "AGENT_REQUEST_CONFLICT", reason: "agent_handoff_design_version_conflict" });
  const latest = f.service.prepareHandoff(command(f, newCandidate, "handoff-new-version-20261117"));
  assert.equal(latest.status, "prepared");
  assert.equal(latest.history.length, 2);
  assert.equal(latest.receipt.handoffDigest, newCandidate.handoffDigest);
  assert.equal(latest.runId, null);
  assert.equal(f.launches(), 1);
});

test("handoff preparation shares B2 design CAS lock and cannot bypass review", async (t) => {
  const f = await setup(t);
  const candidate = f.service.inspectHandoff({ idempotencyKey: TASK_KEY });
  const lock = path.join(f.root, ".meta-kim", "state", "default", "agent-workflow",
    `${TASK_KEY}.design-lock`);
  mkdirSync(lock);
  assert.throws(() => f.service.prepareHandoff(command(f, candidate)),
    { code: "AGENT_REQUEST_CONFLICT", reason: "agent_handoff_design_busy_or_in_doubt" });
  rmdirSync(lock);
  const prepared = f.service.prepareHandoff(command(f, candidate));
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.history.length, 1);
  const unreviewed = await setup(t, false);
  const blocked = unreviewed.service.inspectHandoff({ idempotencyKey: TASK_KEY });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.envelope, null);
  assert.throws(() => unreviewed.service.prepareHandoff({ ...unreviewed.basis,
    handoffKey: "unapproved-20261117-handoff", designVersion: 1, designDigest: "f".repeat(64) }),
  { code: "AGENT_REQUEST_CONFLICT", reason: "agent_handoff_design_not_fully_approved" });
});
