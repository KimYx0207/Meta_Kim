import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentWorkflowService } from "../../src/application/agent/agent-workflow-service.mjs";

const REQUEST = { goal: "Build an ecommerce service and propose tradeoffs", hostId: "claude",
  idempotencyKey: "design-test-20261117-a1" };

function sampleSystem(goal = "A two-level enterprise PRD") {
  return { title: "Cross-border commerce", goal, architecture: "Event-driven modules with explicit contracts",
    techStack: "Node.js, PostgreSQL, queue", acceptance: ["Audit all human decisions"] };
}

function sampleModule(id, dependencies = []) {
  return { id, title: `Module ${id}`, objective: `${id} handles a business capability`,
    inputContract: ["request with idempotency key"], outputContract: ["validated response"],
    boundaries: ["No external side effects before approval"],
    acceptance: ["Deterministic contract test"], dependencies };
}

function sampleDesign() {
  return { system: sampleSystem(), modules: [sampleModule("research"),
    sampleModule("selection", ["research"]), sampleModule("delivery", ["selection"]), sampleModule("audit")] };
}

async function fixture(t, decisionAction = "adopt") {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "meta-agent-design-"));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const nativeReceipts = new Map();
  let starts = 0;
  const native = {
    getHosts: async () => ({ schemaVersion: "meta-kim-agent-hosts-v1", hosts: [], executionAllowed: true }),
    start: async ({ idempotencyKey }) => {
      starts++;
      nativeReceipts.set(idempotencyKey, { status: "completed", resultPreview: "方案 A / 方案 B" });
      return { status: "accepted", requestId: "native", runId: null };
    },
    inspect: ({ idempotencyKey }) => nativeReceipts.get(idempotencyKey) ?? { status: "unknown" },
    close: () => {},
  };
  const create = () => createAgentWorkflowService({ projectRoot, agentStartService: native });
  const service = create();
  await service.start(REQUEST);
  const plan = await service.inspect({ idempotencyKey: REQUEST.idempotencyKey });
  const decision = await service.recordDecision({ idempotencyKey: REQUEST.idempotencyKey,
    requestId: plan.requestId, planDigest: plan.planDigest, action: decisionAction,
    feedback: decisionAction === "revise" ? "More options" : "",
    decisionKey: "design-decision-20261117-a1",
    ...(decisionAction === "adopt" && { selectedStrategy: "B: human gate",
      selectionReason: "Keep human control over sensitive decisions" }) });
  const basis = { idempotencyKey: REQUEST.idempotencyKey, requestId: plan.requestId,
    planDigest: plan.planDigest, decisionKey: decision.decision.decisionKey };
  return { service, create, basis, projectRoot, starts: () => starts };
}

function submit(basis) {
  return { ...basis, action: "submit", mutationKey: "design-submit-20261117-a1",
    expectedVersion: 0, design: sampleDesign() };
}

function mutation(basis, action, expectedVersion, attrs = {}) {
  return { ...basis, action, expectedVersion,
    mutationKey: `design-${action}-${expectedVersion}-idempotent`, ...attrs };
}

async function approveAll(f) {
  await f.service.recordDesign(submit(f.basis));
  let version = 1;
  for (const target of [{ kind: "system" }, { kind: "module", moduleId: "research" },
    { kind: "module", moduleId: "selection" }, { kind: "module", moduleId: "delivery" },
    { kind: "module", moduleId: "audit" }]) {
    await f.service.recordDesign(mutation(f.basis, "approve", version++, { target }));
  }
  return f.service.inspectDesign({ idempotencyKey: f.basis.idempotencyKey });
}

test("B2 exists only after a real B1 adoption bound to the exact plan and decision", async (t) => {
  const f = await fixture(t, "reject");
  const unavailable = f.service.inspectDesign({ idempotencyKey: REQUEST.idempotencyKey });
  assert.equal(unavailable.status, "blocked");
  assert.equal(unavailable.reason, "agent_plan_not_adopted");
  assert.equal(unavailable.readyForExecution, false);
  assert.equal(unavailable.system, null);
  assert.equal(unavailable.modules.length, 0);
  assert.throws(() => f.service.recordDesign(submit(f.basis)),
    { code: "AGENT_REQUEST_CONFLICT", reason: "agent_plan_not_adopted" });
  assert.equal(f.starts(), 1, "B2 never starts a native client");
});

test("B2 human design is durable, immutable per version, project/plan-bound, and idempotent", async (t) => {
  const f = await fixture(t);
  const initial = f.service.inspectDesign({ idempotencyKey: REQUEST.idempotencyKey });
  assert.equal(initial.status, "not_started");
  assert.equal(initial.version, 0);
  assert.equal(initial.basis.decisionKey, f.basis.decisionKey);
  const first = f.service.recordDesign(submit(f.basis));
  assert.equal(first.status, "draft");
  assert.equal(first.version, 1);
  assert.equal(first.modules.length, 4);
  assert.match(first.designDigest, /^[a-f0-9]{64}$/u);
  assert.equal(first.system.approval.state, "pending");
  assert.equal(first.executionAuthorized, false);
  assert.equal(first.reviewComplete, false);
  assert.equal(first.readyForExecution, false);
  assert.equal(first.source, "human_submitted_prd");
  assert.equal(f.starts(), 1);

  const replay = f.service.recordDesign(submit(f.basis));
  assert.equal(replay.replayed, true);
  assert.equal(replay.replayVersion, 1);
  assert.equal(replay.version, 1);
  assert.throws(() => f.service.recordDesign({ ...submit(f.basis),
    design: { ...sampleDesign(), system: sampleSystem("Changed without key rotation") } }),
  { code: "AGENT_REQUEST_CONFLICT", reason: "agent_design_mutation_key_conflict" });
  assert.throws(() => f.service.recordDesign({ ...submit(f.basis),
    mutationKey: "design-other-key-20261117", expectedVersion: 0 }),
  { code: "AGENT_REQUEST_CONFLICT", reason: "agent_design_version_conflict" });
  assert.throws(() => f.service.recordDesign({ ...submit(f.basis), planDigest: "1".repeat(64) }),
  { code: "AGENT_REQUEST_CONFLICT", reason: "agent_design_decision_basis_mismatch" });
  assert.throws(() => f.service.recordDesign({ ...submit(f.basis), requestId: "different-request" }),
  { code: "AGENT_REQUEST_CONFLICT", reason: "agent_design_decision_basis_mismatch" });
  assert.throws(() => f.service.recordDesign({ ...submit(f.basis), decisionKey: "wrong-decision-20261117" }),
  { code: "AGENT_REQUEST_CONFLICT", reason: "agent_design_decision_basis_mismatch" });

  const restored = f.create().inspectDesign({ idempotencyKey: REQUEST.idempotencyKey });
  assert.equal(restored.version, 1);
  assert.equal(restored.designDigest, first.designDigest);
  assert.deepEqual(restored.modules, first.modules);
});

test("design dependency DAG rejects missing modules, cycles, and incomplete contracts", async (t) => {
  const f = await fixture(t);
  const original = submit(f.basis);
  for (const broken of [
    { ...sampleDesign(), modules: [sampleModule("a", ["missing"])] },
    { ...sampleDesign(), modules: [sampleModule("a", ["b"]), sampleModule("b", ["a"])] },
    { ...sampleDesign(), modules: [sampleModule("repeat"), sampleModule("repeat")] },
    { ...sampleDesign(), modules: [{ ...sampleModule("a"), inputContract: [] }] },
    { ...sampleDesign(), modules: [] },
  ]) {
    assert.throws(() => f.service.recordDesign({ ...original, design: broken }), TypeError);
  }
  assert.equal(f.service.inspectDesign({ idempotencyKey: REQUEST.idempotencyKey }).version, 0);
});

test("system/dependency approvals obey the DAG and every approval uses version CAS", async (t) => {
  const f = await fixture(t);
  await f.service.recordDesign(submit(f.basis));
  assert.throws(() => f.service.recordDesign(mutation(f.basis, "approve", 1,
    { target: { kind: "module", moduleId: "selection" } })),
  { code: "AGENT_REQUEST_CONFLICT", reason: "agent_design_dependencies_not_approved" });
  const approvedSystem = f.service.recordDesign(mutation(f.basis, "approve", 1,
    { target: { kind: "system" } }));
  assert.equal(approvedSystem.system.approval.state, "approved");
  assert.equal(approvedSystem.system.approval.version, 2);
  assert.throws(() => f.service.recordDesign(mutation(f.basis, "approve", 1,
    { target: { kind: "module", moduleId: "audit" }, mutationKey: "stale-cas-20261117-a1" })),
  { code: "AGENT_REQUEST_CONFLICT", reason: "agent_design_version_conflict" });
  assert.throws(() => f.service.recordDesign(mutation(f.basis, "approve", 2,
    { target: { kind: "module", moduleId: "selection" } })),
  { code: "AGENT_REQUEST_CONFLICT", reason: "agent_design_dependencies_not_approved" });
  const afterResearch = f.service.recordDesign(mutation(f.basis, "approve", 2,
    { target: { kind: "module", moduleId: "research" } }));
  assert.equal(afterResearch.version, 3);
  const afterSelection = f.service.recordDesign(mutation(f.basis, "approve", 3,
    { target: { kind: "module", moduleId: "selection" } }));
  assert.equal(afterSelection.modules.find((module) => module.id === "selection").approval.version, 4);
  const afterDelivery = f.service.recordDesign(mutation(f.basis, "approve", 4,
    { target: { kind: "module", moduleId: "delivery" } }));
  assert.equal(afterDelivery.version, 5);
  const all = f.service.recordDesign(mutation(f.basis, "approve", 5,
    { target: { kind: "module", moduleId: "audit" } }));
  assert.equal(all.status, "approved");
  assert.equal(all.reviewComplete, true);
  assert.equal(all.readyForExecution, false, "design approval is not code execution authority");
  assert.equal(f.starts(), 1);
});

test("module-only revision invalidates its downstream approvals, preserves independent modules and history", async (t) => {
  const f = await fixture(t);
  const all = await approveAll(f);
  assert.equal(all.version, 6);
  assert.equal(all.status, "approved");
  assert.throws(() => f.service.recordDesign(mutation(f.basis, "revise_module", 6,
    { module: { ...sampleModule("research", ["delivery"]), objective: "Introduce a cycle" },
      mutationKey: "revise-cycle-20261117-a1" })),
  { code: "AGENT_REQUEST_CONFLICT", reason: "agent_design_dependency_cycle_or_missing" });
  assert.equal(f.service.inspectDesign({ idempotencyKey: REQUEST.idempotencyKey }).version, 6);
  const revise = mutation(f.basis, "revise_module", 6, { module: {
    ...sampleModule("selection", ["research"]), objective: "New selection policy with human gates" } });
  const revised = f.service.recordDesign(revise);
  assert.equal(revised.version, 7);
  assert.deepEqual(revised.mutation.changedNodeIds, ["selection"]);
  assert.deepEqual(revised.mutation.invalidatedModuleIds, ["delivery"]);
  assert.equal(revised.modules.find((module) => module.id === "research").approval.state, "approved");
  assert.equal(revised.modules.find((module) => module.id === "audit").approval.state, "approved");
  assert.equal(revised.modules.find((module) => module.id === "selection").approval.state, "invalidated");
  assert.equal(revised.modules.find((module) => module.id === "delivery").approval.state, "invalidated");
  assert.notEqual(revised.designDigest, all.designDigest);
  assert.equal(revised.readyForExecution, false);
  const prior = f.service.inspectDesign({ idempotencyKey: REQUEST.idempotencyKey, version: 6 });
  assert.equal(prior.status, "approved");
  assert.equal(prior.currentVersion, 7);
  assert.equal(prior.historical, true);
  assert.equal(prior.modules.find((module) => module.id === "delivery").approval.state, "approved");
  assert.equal(prior.history.length, 7);
  const stored = f.create().inspectDesign({ idempotencyKey: REQUEST.idempotencyKey });
  assert.equal(stored.version, 7);
  assert.equal(stored.modules.find((module) => module.id === "delivery").approval.reason, "upstream_changed");
  assert.equal(f.starts(), 1);
});

test("node feedback is a durable, version-bound revision request; only dependent approvals are invalidated", async (t) => {
  const f = await fixture(t);
  const approved = await approveAll(f);
  const request = mutation(f.basis, "request_revision", approved.version, {
    mutationKey: "review-selection-20261117-a1",
    target: { kind: "module", moduleId: "selection" },
    feedback: "补充跨渠道库存冲突时的判定逻辑与人工回退路径。",
  });
  const reviewing = f.service.recordDesign(request);
  assert.equal(reviewing.version, 7);
  assert.equal(reviewing.status, "reviewing");
  assert.equal(reviewing.reviewComplete, false);
  assert.equal(reviewing.readyForExecution, false);
  assert.equal(reviewing.executionAuthorized, false);
  assert.equal(reviewing.designDigest, approved.designDigest, "review note alone must not rewrite the PRD body");
  assert.deepEqual(reviewing.mutation.changedNodeIds, ["selection"]);
  assert.deepEqual(reviewing.mutation.invalidatedModuleIds, ["delivery"]);
  assert.equal(reviewing.system.approval.state, "approved");
  assert.equal(reviewing.modules.find((item) => item.id === "research").approval.state, "approved");
  assert.equal(reviewing.modules.find((item) => item.id === "audit").approval.state, "approved");
  assert.equal(reviewing.modules.find((item) => item.id === "selection").approval.state, "invalidated");
  assert.equal(reviewing.modules.find((item) => item.id === "delivery").approval.state, "invalidated");
  assert.deepEqual(reviewing.pendingReviewNotes, [{ noteId: request.mutationKey,
    target: request.target, sourceVersion: 6, feedback: request.feedback,
    at: reviewing.history.at(-1).recordedAt }]);
  assert.deepEqual(reviewing.history.at(-1).reviewNote, reviewing.pendingReviewNotes[0]);
  assert.throws(() => f.service.recordDesign(mutation(f.basis, "approve", 7,
    { target: { kind: "module", moduleId: "selection" } })),
  { code: "AGENT_REQUEST_CONFLICT", reason: "agent_design_unresolved_feedback" });
  const replay = f.service.recordDesign(request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.replayVersion, 7);
  assert.equal(replay.version, 7);
  assert.throws(() => f.service.recordDesign({ ...request, feedback: "changed with same key" }),
    { code: "AGENT_REQUEST_CONFLICT", reason: "agent_design_mutation_key_conflict" });

  const changed = f.service.recordDesign(mutation(f.basis, "revise_module", 7, {
    module: { ...sampleModule("selection", ["research"]),
      objective: "Resolve cross-channel inventory conflicts with a human fallback" },
  }));
  assert.equal(changed.version, 8);
  assert.deepEqual(changed.pendingReviewNotes, []);
  assert.deepEqual(changed.history.at(-1).resolvedReviewNoteIds, [request.mutationKey]);
  assert.deepEqual(changed.history.at(-2).reviewNote, reviewing.pendingReviewNotes[0],
    "immutable history must retain resolved feedback");
  const history = f.service.inspectDesign({ idempotencyKey: f.basis.idempotencyKey, version: 7 });
  assert.equal(history.pendingReviewNotes.length, 1);
  const restored = f.create().inspectDesign({ idempotencyKey: f.basis.idempotencyKey });
  assert.equal(restored.version, 8);
  assert.deepEqual(restored.pendingReviewNotes, []);
  const reapproved = f.service.recordDesign(mutation(f.basis, "approve", 8,
    { target: { kind: "module", moduleId: "selection" } }));
  assert.equal(reapproved.modules.find((item) => item.id === "selection").approval.state, "approved");
  assert.equal(reapproved.modules.find((item) => item.id === "delivery").approval.state, "invalidated");
  assert.equal(f.starts(), 1, "node feedback must never launch another native host");
});

test("system feedback blocks approval until a real system revision and rejects unsafe or stale payloads", async (t) => {
  const f = await fixture(t);
  await approveAll(f);
  for (const feedback of [" ", "x".repeat(2_001), "unsafe\u0000payload"]) {
    assert.throws(() => f.service.recordDesign(mutation(f.basis, "request_revision", 6,
      { mutationKey: "invalid-system-note-20261117", target: { kind: "system" }, feedback })), TypeError);
  }
  assert.throws(() => f.service.recordDesign(mutation(f.basis, "request_revision", 6,
    { mutationKey: "unknown-node-20261117", target: { kind: "module", moduleId: "unknown" }, feedback: "Fix it" })),
  { code: "AGENT_REQUEST_CONFLICT", reason: "agent_design_module_not_found" });
  assert.equal(f.service.inspectDesign({ idempotencyKey: f.basis.idempotencyKey }).version, 6);
  const note = f.service.recordDesign(mutation(f.basis, "request_revision", 6,
    { mutationKey: "system-note-20261117", target: { kind: "system" },
      feedback: "安全边界需要补充数据隔离与回滚条件。" }));
  assert.equal(note.version, 7);
  assert.equal(note.system.approval.state, "invalidated");
  assert.equal(note.modules.every((module) => module.approval.state === "invalidated"), true);
  assert.equal(note.pendingReviewNotes.length, 1);
  assert.throws(() => f.service.recordDesign(mutation(f.basis, "approve", 7,
    { target: { kind: "system" } })),
  { code: "AGENT_REQUEST_CONFLICT", reason: "agent_design_unresolved_feedback" });
  assert.throws(() => f.service.recordDesign(mutation(f.basis, "request_revision", 6,
    { mutationKey: "stale-system-note-20261117", target: { kind: "system" }, feedback: "Stale" })),
  { code: "AGENT_REQUEST_CONFLICT", reason: "agent_design_version_conflict" });
  const revised = f.service.recordDesign(mutation(f.basis, "revise_system", 7,
    { system: sampleSystem("Updated system boundaries and rollback acceptance") }));
  assert.equal(revised.version, 8);
  assert.deepEqual(revised.pendingReviewNotes, []);
  assert.deepEqual(revised.history.at(-1).resolvedReviewNoteIds, ["system-note-20261117"]);
  assert.equal(revised.reviewComplete, false);
  assert.equal(revised.executionAuthorized, false);
});

test("revoke and system revision invalidate approvals without automatically altering module designs", async (t) => {
  const f = await fixture(t);
  await approveAll(f);
  const revoked = f.service.recordDesign(mutation(f.basis, "revoke", 6,
    { target: { kind: "module", moduleId: "research" } }));
  assert.equal(revoked.version, 7);
  assert.equal(revoked.modules.find((module) => module.id === "research").approval.state, "revoked");
  assert.equal(revoked.modules.find((module) => module.id === "selection").approval.state, "invalidated");
  assert.equal(revoked.modules.find((module) => module.id === "delivery").approval.state, "invalidated");
  assert.equal(revoked.modules.find((module) => module.id === "audit").approval.state, "approved");
  const systemRevision = f.service.recordDesign(mutation(f.basis, "revise_system", 7,
    { system: sampleSystem("More rigorous organizational boundaries") }));
  assert.equal(systemRevision.version, 8);
  assert.equal(systemRevision.system.approval.state, "invalidated");
  assert.equal(systemRevision.modules.find((module) => module.id === "audit").approval.state, "invalidated");
  assert.equal(systemRevision.modules.find((module) => module.id === "research").objective,
    sampleModule("research").objective, "revisions only mark invalidations; content is stable");
  assert.equal(f.starts(), 1);
});

test("stale/exclusive design locks fail closed; only one mutation wins", async (t) => {
  const f = await fixture(t);
  await f.service.recordDesign(submit(f.basis));
  const lockPath = path.join(f.projectRoot, ".meta-kim", "state", "default", "agent-workflow",
    `${REQUEST.idempotencyKey}.design-lock`);
  mkdirSync(lockPath);
  assert.throws(() => f.service.recordDesign(mutation(f.basis, "approve", 1,
    { target: { kind: "system" } })),
  { code: "AGENT_REQUEST_CONFLICT", reason: "agent_design_busy_or_in_doubt" });
  rmdirSync(lockPath);
  const first = f.service.recordDesign(mutation(f.basis, "approve", 1,
    { target: { kind: "system" } }));
  assert.equal(first.version, 2);
  const concurrent = f.create();
  assert.throws(() => concurrent.recordDesign(mutation(f.basis, "approve", 1,
    { target: { kind: "module", moduleId: "audit" }, mutationKey: "new-cas-20261117-a1" })),
  { code: "AGENT_REQUEST_CONFLICT", reason: "agent_design_version_conflict" });
  assert.equal(concurrent.inspectDesign({ idempotencyKey: REQUEST.idempotencyKey }).version, 2);
});

test("immutable human design versions detect a changed artifact before serving it", async (t) => {
  const f = await fixture(t);
  const initial = f.service.recordDesign(submit(f.basis));
  assert.equal(initial.version, 1);
  const file = path.join(f.projectRoot, ".meta-kim", "state", "default", "agent-workflow",
    `${REQUEST.idempotencyKey}.design`, "v000001.json");
  const stored = JSON.parse(readFileSync(file, "utf8"));
  stored.content.system.goal = "A changed goal that is not in the original review record";
  writeFileSync(file, JSON.stringify(stored), "utf8");
  assert.throws(() => f.service.inspectDesign({ idempotencyKey: REQUEST.idempotencyKey }),
    { code: "AGENT_REQUEST_CONFLICT", reason: "agent_design_integrity_failed" });
  assert.throws(() => f.create().recordDesign(mutation(f.basis, "approve", 1,
    { target: { kind: "system" } })),
  { code: "AGENT_REQUEST_CONFLICT", reason: "agent_design_integrity_failed" });
});
