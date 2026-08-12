import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildSchedulerAuthorityReuseShadowPlan } from "../../scripts/governed-execution/scheduler-authority-reuse-shadow-adapter.mjs";
import { openDurableRunKernel } from "../../scripts/governed-execution/durable-run-kernel.mjs";
import { runStageRunnerBridge } from "../../scripts/governed-execution/stage-runner-bridge.mjs";
import {
  buildStageDagPacket,
  selectMaximalSafeReadySet,
  stageLaneNodeId,
} from "../../scripts/governed-execution/stage-dag.mjs";
import {
  assertValidSchedulerAuthorityReuseShadowResult,
  buildSchedulerAuthorityReuseShadowResult,
} from "../../src/domain/scheduling/scheduler-authority-reuse-shadow.mjs";
import { evaluateTodoDependencySafeProgressShadow } from "../../src/domain/work/todo-dependency-safe-progress-shadow.mjs";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

function lane(laneId, overrides = {}) {
  return {
    laneId,
    laneKind: "execution_worker",
    ownerBindingRef: `owner:${laneId}`,
    capabilityBindingRef: `capability:${laneId}`,
    dependsOn: [],
    effectClass: "read_only_worker",
    resourceScopes: [`file:${laneId}.mjs`],
    isolation: "shared_read_only",
    status: "planned_not_invoked",
    ...overrides,
  };
}

function selectorDag() {
  const aId = stageLaneNodeId("Execution", "a");
  return buildStageDagPacket({
    stageOrder: ["Execution"],
    stageLanes: {
      Execution: [
        lane("a", { effectClass: "project_write", resourceScopes: ["file:shared.mjs"] }),
        lane("b", { effectClass: "project_write", resourceScopes: ["file:shared.mjs"] }),
        lane("c", { dependsOn: [aId] }),
      ],
    },
    runtimeCapacity: 2,
  });
}

function planDag() {
  return buildStageDagPacket({
    stageOrder: ["Execution"],
    stageLanes: { Execution: [lane("candidate")] },
    runtimeCapacity: 1,
  });
}

function topologyFromDag(stageDagPacket) {
  return {
    schemaVersion: stageDagPacket.schemaVersion,
    authority: "config/contracts/core-loop-contract.json",
    graphDigest: `sha256:${stageDagPacket.graphDigest}`,
    nodes: stageDagPacket.nodes.map((node) => ({
      nodeId: node.nodeId,
      stage: node.stage,
      laneKind: node.laneKind,
      ownerBindingRef: node.ownerBindingRef,
      capabilityBindingRef: node.capabilityBindingRef,
      dependsOn: [...node.dependsOn],
      effectClass: node.effectClass,
      resourceScopes: [...node.resourceScopes],
      isolation: node.isolation,
      mergeNodeId: node.mergeNodeId,
    })),
  };
}

function a03Binding(stageDagPacket, overrides = {}) {
  return {
    runId: "run:m3-a04",
    taskFingerprint: digest("task:m3-a04"),
    graphDigest: `sha256:${stageDagPacket.graphDigest}`,
    projectionDigest: digest("projection:m3-a04"),
    durableCursor: 4,
    headEventHash: digest("event:m3-a04"),
    headCheckpointId: "checkpoint:m3-a04",
    policyDigest: digest("policy:m3-a04"),
    evaluationRevision: 0,
    ...overrides,
  };
}

function decisionSnapshot() {
  const core = {
    pendingDecisionNodeIds: [],
    verifiedDecisionNodeIds: [],
    unknownDecisionNodeIds: [],
  };
  return { ...core, snapshotDigest: digest(core) };
}

function a03Result(stageDagPacket = planDag(), {
  completedNodeIds = [],
  activeClaimNodeIds = [],
  unresolvedEffectNodeIds = [],
  inDoubtNodeIds = [],
  action = "continue",
} = {}) {
  const binding = a03Binding(stageDagPacket);
  return evaluateTodoDependencySafeProgressShadow({
    binding,
    topology: topologyFromDag(stageDagPacket),
    executionSnapshot: {
      projectionDigest: binding.projectionDigest,
      eventChainState: "verified",
      currentness: "bound_same_bridge_settlement",
      completedNodeIds,
      activeClaimNodeIds,
      unresolvedEffectNodeIds,
      inDoubtNodeIds,
    },
    decisionSnapshot: decisionSnapshot(),
    evidenceTransition: {
      schemaVersion: "evidence-transition-shadow-v1",
      resultDigest: digest("a01-result"),
      bindingDigest: digest("a01-binding"),
      evaluationStatus: "evaluated",
      verdict: "allowed",
      blockedDecisionIds: [],
      reasonCodes: [],
    },
    continuation: {
      schemaVersion: "continuation-policy-shadow-v1",
      resultDigest: digest("a02-result"),
      bindingDigest: digest(binding),
      evaluationStatus: "evaluated",
      action,
      reasonCodes: action === "continue" ? ["unfinished_goal_executable_in_scope"] : ["active_claim_present"],
    },
  });
}

function a03Projection(result) {
  return {
    schemaVersion: "todo-dependency-safe-progress-shadow-adapter-v1",
    mode: "shadow_only",
    evaluationStatus: "evaluated",
    disposition: result.disposition.action,
    result,
    authority: {
      projectsTodoTruth: false,
      writesTodo: false,
      writesKernel: false,
      writesEvents: false,
      selectsSchedulerReadySet: false,
      dispatchesScheduler: false,
      claimsNode: false,
      changesLease: false,
      changesFence: false,
      advancesCursor: false,
      changesCheckpoint: false,
      completesNode: false,
      terminatesRun: false,
      projectionOnly: true,
    },
  };
}

function freshSnapshot(result, overrides = {}) {
  const core = {
    source: "upstream_durable_kernel_projection_owner",
    runId: result.binding.runId,
    taskFingerprint: result.binding.taskFingerprint,
    graphDigest: result.binding.graphDigest,
    projectionDigest: result.binding.projectionDigest,
    cursor: result.binding.durableCursor,
    headEventHash: result.binding.headEventHash,
    headCheckpointId: result.binding.headCheckpointId,
    runStatus: "active",
    eventChainState: "verified",
    completedNodeIds: [...result.executionSnapshot.completedNodeIds],
    activeClaimNodeIds: [...result.executionSnapshot.activeClaimNodeIds],
    unresolvedEffectNodeIds: [...result.executionSnapshot.unresolvedEffectNodeIds],
    inDoubtNodeIds: [...result.executionSnapshot.inDoubtNodeIds],
    currentness: "fresh_bound_for_shadow_selection",
    ...overrides,
  };
  return { ...core, snapshotDigest: digest(core) };
}

function adapterFixture({ result = null, freshOverrides = {}, context = {} } = {}) {
  const authoritativeStageDagPacket = planDag();
  const canonicalA03 = result ?? a03Result(authoritativeStageDagPacket);
  return {
    authoritativeStageDagPacket,
    freshExecutionHeadSnapshot: freshSnapshot(canonicalA03, freshOverrides),
    todoDependencySafeProgressShadowProjection: a03Projection(canonicalA03),
    trustedSelectionContext: { stage: null, capacity: 1, ...context },
  };
}

function commandFromResult(result, overrides = {}) {
  return {
    binding: result.binding,
    freshHeadBinding: result.freshHeadBinding,
    advisoryBinding: result.advisoryBinding,
    executionAssessment: result.executionAssessment,
    selectorInput: result.selectorInput,
    selectorOutput: result.selectorOutput,
    ...overrides,
  };
}

function assertDeepFrozen(value) {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

test("73 — eligibleNodeIds null preserves the existing selector result exactly", () => {
  const dag = selectorDag();
  const implicit = selectMaximalSafeReadySet(dag, { stage: "Execution", capacity: 2 });
  const explicit = selectMaximalSafeReadySet(dag, { stage: "Execution", capacity: 2, eligibleNodeIds: null });
  assert.deepEqual(explicit, implicit);
});

test("73 — eligibility only restricts; dependency readiness is never manufactured", () => {
  const dag = selectorDag();
  const bId = stageLaneNodeId("Execution", "b");
  const cId = stageLaneNodeId("Execution", "c");
  const result = selectMaximalSafeReadySet(dag, {
    stage: "Execution",
    capacity: 2,
    eligibleNodeIds: [bId, cId],
  });
  assert.deepEqual(result.candidateNodeIds, [bId]);
  assert.deepEqual(result.readyNodeIds, [bId]);
  assert.deepEqual(result.deferredNodeIds, []);
  assert.equal(JSON.stringify(result).includes(cId), false);
});

test("73 — existing conflict, capacity, and deterministic maximal-set rules still own selection", () => {
  const dag = selectorDag();
  const eligible = [stageLaneNodeId("Execution", "b"), stageLaneNodeId("Execution", "a")];
  const first = selectMaximalSafeReadySet(dag, { stage: "Execution", capacity: 2, eligibleNodeIds: eligible });
  const reordered = selectMaximalSafeReadySet(dag, { stage: "Execution", capacity: 2, eligibleNodeIds: [...eligible].reverse() });
  assert.deepEqual(first, reordered);
  assert.equal(first.readyNodeIds.length, 1);
  assert.equal(first.deferredNodeIds.length, 1);
});

test("73 — selector rejects unknown, duplicate, sparse, and empty eligibility lists", () => {
  const dag = selectorDag();
  const known = stageLaneNodeId("Execution", "a");
  const sparse = [known, known];
  delete sparse[1];
  for (const eligibleNodeIds of [["unknown"], [known, known], sparse, []]) {
    assert.throws(() => selectMaximalSafeReadySet(dag, { eligibleNodeIds }));
  }
});

test("73 — adapter accepts only exact empty normalized input and trusted capacity", () => {
  const options = adapterFixture();
  const accepted = buildSchedulerAuthorityReuseShadowPlan({}, options);
  assert.equal(accepted.evaluationStatus, "evaluated");
  for (const normalizedInput of [null, { stage: "Execution" }, { capacity: 1 }, { candidateNodeIds: [] }, { binding: {} }]) {
    const rejected = buildSchedulerAuthorityReuseShadowPlan(normalizedInput, options);
    assert.match(rejected.evaluationStatus, /^not_evaluated_/u);
    assert.equal(rejected.result, null);
  }
  for (const capacity of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const rejected = buildSchedulerAuthorityReuseShadowPlan({}, adapterFixture({ context: { capacity } }));
    assert.equal(rejected.evaluationStatus, "not_evaluated_invalid_normalized_input");
  }
});

test("73 — canonical A03 candidates are restriction-only and selector is invoked once", () => {
  const envelope = buildSchedulerAuthorityReuseShadowPlan({}, adapterFixture());
  assert.equal(envelope.evaluationStatus, "evaluated");
  assert.equal(envelope.selectorInvoked, true);
  assert.equal(envelope.disposition, "planned");
  assert.deepEqual(envelope.result.selectorInput.eligibleNodeIds, envelope.result.advisoryBinding.candidateNodeIds);
  assert.deepEqual(envelope.result.plan.plannedNodeIds, envelope.result.selectorOutput.readyNodeIds);
  assert.equal(envelope.result.selectorAuthority.invocationCount, 1);
  assert.equal(envelope.result.authorization.schedulerDispatchAllowed, false);
  assertValidSchedulerAuthorityReuseShadowResult(envelope.result);
});

test("73 — null selector stage may derive DAG stage; explicit stage must match exactly", () => {
  const derived = buildSchedulerAuthorityReuseShadowPlan({}, adapterFixture());
  assert.equal(derived.result.selectorInput.stage, null);
  assert.equal(derived.result.selectorOutput.stage, "Execution");

  const explicit = buildSchedulerAuthorityReuseShadowPlan({}, adapterFixture({ context: { stage: "Execution" } }));
  assert.equal(explicit.result.selectorInput.stage, "Execution");
  assert.equal(explicit.result.selectorOutput.stage, "Execution");
  const forgedOutput = structuredClone(explicit.result.selectorOutput);
  forgedOutput.stage = "Review";
  const outputCore = { ...forgedOutput };
  delete outputCore.outputDigest;
  forgedOutput.outputDigest = digest(outputCore);
  const rejected = buildSchedulerAuthorityReuseShadowResult(commandFromResult(explicit.result, { selectorOutput: forgedOutput }));
  assert.equal(rejected.plan.status, "in_doubt");
  assert.deepEqual(rejected.plan.reasonCodes, ["selector_output_identity_mismatch"]);
});

test("73 — active claims, blocking effects, and non-candidate A03 dispositions never invoke selector", () => {
  for (const variant of [
    { activeClaimNodeIds: [stageLaneNodeId("Execution", "candidate")], action: "wait" },
    { unresolvedEffectNodeIds: [stageLaneNodeId("Execution", "candidate")], action: "wait" },
  ]) {
    const dag = planDag();
    const result = a03Result(dag, variant);
    const envelope = buildSchedulerAuthorityReuseShadowPlan({}, adapterFixture({ result }));
    assert.equal(envelope.selectorInvoked, false);
    assert.equal(envelope.result.plan.status, "blocked");
    assert.deepEqual(envelope.result.plan.plannedNodeIds, []);
    assert.equal(envelope.result.selectorAuthority.invocationCount, 0);
  }
  const waiting = a03Result(planDag(), { action: "wait" });
  const envelope = buildSchedulerAuthorityReuseShadowPlan({}, adapterFixture({ result: waiting }));
  assert.equal(envelope.selectorInvoked, false);
  assert.notEqual(envelope.result?.plan.status, "planned");
});

test("73 — fresh cursor, event, checkpoint, and projection mismatches require full revalidation", () => {
  for (const freshOverrides of [
    { cursor: 5 },
    { headEventHash: digest("changed-event") },
    { headCheckpointId: "checkpoint:changed" },
    { projectionDigest: digest("changed-projection") },
  ]) {
    const envelope = buildSchedulerAuthorityReuseShadowPlan({}, adapterFixture({ freshOverrides }));
    assert.equal(envelope.selectorInvoked, false);
    assert.equal(envelope.disposition, "revalidation_required");
    assert.equal(envelope.result.plan.dispatchRequiresFreshRevalidation, true);
  }
});

test("73 — all four fresh execution-set drifts require canonical revalidation", () => {
  const candidate = stageLaneNodeId("Execution", "candidate");
  for (const [field, reasonCode] of [
    ["completedNodeIds", "fresh_completed_set_changed"],
    ["activeClaimNodeIds", "fresh_claim_state_changed"],
    ["unresolvedEffectNodeIds", "fresh_effect_state_changed"],
    ["inDoubtNodeIds", "fresh_in_doubt_state_changed"],
  ]) {
    const envelope = buildSchedulerAuthorityReuseShadowPlan({}, adapterFixture({
      freshOverrides: { [field]: [candidate] },
    }));
    assert.equal(envelope.selectorInvoked, false);
    assert.equal(envelope.disposition, "revalidation_required");
    assert.ok(envelope.result.plan.reasonCodes.includes(reasonCode));
  }
});

test("73 — unproven currentness, failed chain, inactive run, and in-doubt head fail closed", () => {
  for (const [freshOverrides, expected] of [
    [{ currentness: "unproven" }, "blocked"],
    [{ eventChainState: "failed" }, "blocked"],
    [{ runStatus: "failed" }, "blocked"],
  ]) {
    const envelope = buildSchedulerAuthorityReuseShadowPlan({}, adapterFixture({ freshOverrides }));
    assert.equal(envelope.selectorInvoked, false);
    assert.equal(envelope.disposition, expected);
    assert.deepEqual(envelope.result.plan.plannedNodeIds, []);
  }
  const candidate = stageLaneNodeId("Execution", "candidate");
  const inDoubtResult = a03Result(planDag(), { inDoubtNodeIds: [candidate], action: "wait" });
  const inDoubt = buildSchedulerAuthorityReuseShadowPlan({}, adapterFixture({ result: inDoubtResult }));
  assert.equal(inDoubt.selectorInvoked, false);
  assert.equal(inDoubt.disposition, "in_doubt");
  assert.deepEqual(inDoubt.result.plan.plannedNodeIds, []);
});

test("73 — selector output identity, partition, and eligibility are canonical and fail closed", () => {
  const planned = buildSchedulerAuthorityReuseShadowPlan({}, adapterFixture()).result;
  for (const mutate of [
    (output) => { output.capacity = 2; },
    (output) => { output.readyNodeIds = ["caller:forged"]; output.candidateNodeIds = ["caller:forged"]; },
    (output) => { output.deferredNodeIds = [...output.readyNodeIds]; },
  ]) {
    const output = structuredClone(planned.selectorOutput);
    mutate(output);
    const core = { ...output };
    delete core.outputDigest;
    output.outputDigest = digest(core);
    const result = buildSchedulerAuthorityReuseShadowResult(commandFromResult(planned, { selectorOutput: output }));
    assert.equal(result.plan.status, "in_doubt");
    assert.deepEqual(result.plan.plannedNodeIds, []);
  }
});

test("73 — every plan status keeps all 18 permissions false and is non-dispatching", () => {
  const planned = buildSchedulerAuthorityReuseShadowPlan({}, adapterFixture()).result;
  const commands = [
    commandFromResult(planned),
    commandFromResult(planned, {
      advisoryBinding: { ...planned.advisoryBinding, candidateNodeIds: [] },
      selectorInput: null,
      selectorOutput: null,
    }),
    commandFromResult(planned, {
      freshHeadBinding: (() => {
        const core = { ...planned.freshHeadBinding, cursor: planned.freshHeadBinding.cursor + 1 };
        delete core.snapshotDigest;
        return { ...core, snapshotDigest: digest(core) };
      })(),
      selectorInput: null,
      selectorOutput: null,
    }),
    commandFromResult(planned, {
      executionAssessment: { ...planned.executionAssessment, runStatus: "failed" },
      selectorInput: null,
      selectorOutput: null,
    }),
    commandFromResult(planned, {
      advisoryBinding: { ...planned.advisoryBinding, bindingDigest: digest("wrong-binding") },
      selectorInput: null,
      selectorOutput: null,
    }),
  ];
  const results = commands.map(buildSchedulerAuthorityReuseShadowResult);
  assert.deepEqual(new Set(results.map((result) => result.plan.status)), new Set([
    "planned", "empty", "revalidation_required", "blocked", "in_doubt",
  ]));
  for (const result of results) {
    assert.equal(Object.keys(result.authorization).length, 18);
    assert.ok(Object.values(result.authorization).every((value) => value === false));
    assert.equal(result.plan.dispatchRequiresFreshRevalidation, true);
    assert.equal(result.eventIntents[0].persisted, false);
    assert.equal(result.eventIntents[0].writeAllowed, false);
  }
});

test("73 — result is deterministic, deeply frozen, and validator rejects forged dispatch truth", () => {
  const first = buildSchedulerAuthorityReuseShadowPlan({}, adapterFixture()).result;
  const second = buildSchedulerAuthorityReuseShadowPlan({}, adapterFixture()).result;
  assert.deepEqual(first, second);
  assertDeepFrozen(first);
  const forged = structuredClone(first);
  forged.authorization.schedulerDispatchAllowed = true;
  assert.throws(() => assertValidSchedulerAuthorityReuseShadowResult(forged));
  forged.authorization.schedulerDispatchAllowed = false;
  forged.plan.plannedNodeIds.push("caller:dispatched");
  assert.throws(() => assertValidSchedulerAuthorityReuseShadowResult(forged));
});

test("73 — secret-shaped caller data is bounded and never retained", () => {
  const secret = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
  const rejected = buildSchedulerAuthorityReuseShadowPlan({ stage: secret }, adapterFixture());
  assert.equal(rejected.result, null);
  assert.equal(JSON.stringify(rejected).includes(secret), false);

  const options = adapterFixture();
  const core = { ...options.freshExecutionHeadSnapshot, runId: secret };
  delete core.snapshotDigest;
  options.freshExecutionHeadSnapshot = { ...core, snapshotDigest: digest(core) };
  const freshRejected = buildSchedulerAuthorityReuseShadowPlan({}, options);
  assert.equal(freshRejected.result, null);
  assert.equal(JSON.stringify(freshRejected).includes(secret), false);
});

function assessment(state) {
  const core = { state, evidenceRefs: [] };
  return { ...core, assessmentDigest: digest(core) };
}

function bridgeA01Input() {
  return {
    policyDigest: digest("bridge-policy:a04"),
    evidenceClaims: [{
      claimId: "claim:bridge-a04",
      producerRef: "producer:bridge-a04",
      evidenceType: "test_result",
      subjectRef: "subject:bridge-a04",
      payloadDigest: digest("bridge-payload:a04"),
    }],
    validatorAssessments: [{
      claimId: "claim:bridge-a04",
      validatorRef: "validator:bridge-a04",
      assessment: "verified",
      assessmentDigest: digest("bridge-assessment:a04"),
      reasonCode: "independent_check_passed",
    }],
    decisionDependencies: [],
    transitionRequest: {
      proposalId: "proposal:bridge-a04",
      fromStage: "execution",
      toStage: "review",
      requiredClaimIds: ["claim:bridge-a04"],
    },
  };
}

function bridgeA02Input() {
  const controlCore = { state: "none", controlRef: null, evidenceRefs: [] };
  return {
    policyDigest: digest("bridge-policy:a04"),
    evaluationRevision: 0,
    goalAssessment: assessment("unfinished"),
    workAssessment: assessment("executable_candidate_present"),
    evidenceAssessment: assessment("new_valid_evidence_expected"),
    blockerAssessment: assessment("none"),
    humanDecisionAssessment: assessment("not_required"),
    scopeAssessment: assessment("inside"),
    repeatAssessment: assessment("novel"),
    controlAssessment: { ...controlCore, assessmentDigest: digest(controlCore) },
  };
}

async function bridgeVariant(withScheduler) {
  const runId = "m3-a04-bridge-parity";
  const stageDagPacket = buildStageDagPacket({
    stageOrder: ["Execution", "Review"],
    stageLanes: { Execution: [lane("bridge-worker")], Review: [] },
    runtimeCapacity: 1,
  });
  const taskFingerprint = `task:${runId}`;
  const kernel = await openDurableRunKernel();
  try {
    const result = await runStageRunnerBridge({
      runId,
      runtime: "codex",
      stageDagPacket,
      workerTaskPackets: [{
        taskPacketId: "bridge-worker",
        ownerAgent: "test-automator",
        description: "Observe scheduler shadow parity",
        output: "scheduler shadow parity observed",
        dependsOn: [],
        executionMode: "primary_execution",
        externalWriteBoundary: false,
      }],
      workspaceRoot: process.cwd(),
      durable: {
        enabled: true,
        kernel,
        mode: "create",
        taskFingerprint,
        ownerId: `owner:${runId}`,
        leaseMs: 10_000,
      },
      evidenceTransitionShadow: bridgeA01Input(),
      continuationPolicyShadow: bridgeA02Input(),
      todoDependencySafeProgressShadow: {},
      ...(withScheduler ? { schedulerAuthorityReuseShadow: {} } : {}),
      evidenceKind: "test_double",
      invokeWorker: async ({ runtime }) => ({
        status: "pass",
        runtime,
        exitCode: 0,
        startedAt: "2026-08-11T00:00:00.000Z",
        endedAt: "2026-08-11T00:00:00.001Z",
        durationMs: 1,
        sessionId: `session:${runId}`,
        messageId: `message:${runId}`,
        outputText: "meta-kim",
        outputSha256: "a".repeat(64),
        rawOutputSha256: "b".repeat(64),
        hostEventCount: 1,
        toolEventCount: 1,
        stderrTail: "",
      }),
    });
    const projection = kernel.projectRun(runId);
    const events = kernel.getEvents(runId);
    const resume = kernel.resumeRun({
      runId,
      graphDigest: stageDagPacket.graphDigest,
      taskFingerprint,
    });
    return {
      result,
      legacy: {
        status: result.status,
        stageDagPacket: result.stageDagPacket,
        nodeRecords: result.nodeRecords.map(({ nodeId, status, outputSha256 }) => ({ nodeId, status, outputSha256 })),
        workerResults: result.workerResults.map(({ status, outputSha256, rawOutputSha256 }) => ({ status, outputSha256, rawOutputSha256 })),
        eventTypes: events.map((event) => event.eventType),
        cursor: projection.cursor,
        checkpointIds: projection.completedNodes.map((record) => record.checkpointId),
        completedNodeIds: projection.completedNodes.map((record) => record.nodeId),
        activeClaims: resume.activeClaims,
        blockingEffects: resume.blockingEffects,
      },
      events,
      projection,
    };
  } finally {
    kernel.close();
  }
}

test("73 — bridge A/B toggle preserves events, cursor, checkpoints, claims, nodes, and outputs", async () => {
  const baseline = await bridgeVariant(false);
  const enabled = await bridgeVariant(true);
  assert.equal(Object.hasOwn(baseline.result, "schedulerAuthorityReuseShadowProjection"), false);
  assert.equal(Object.hasOwn(enabled.result, "schedulerAuthorityReuseShadowProjection"), true);
  assert.deepEqual(enabled.legacy, baseline.legacy);
  assert.equal(JSON.stringify(enabled.events).includes("schedulerAuthorityReuseShadow"), false);
  assert.equal(JSON.stringify(enabled.projection).includes("schedulerAuthorityReuseShadow"), false);
  const shadow = enabled.result.schedulerAuthorityReuseShadowProjection;
  assert.equal(shadow.evaluationStatus, "evaluated");
  assert.equal(shadow.selectorInvoked, true);
  assert.equal(shadow.disposition, "planned");
  assert.equal(shadow.result.selectorAuthority.invocationCount, 1);
  assert.ok(Object.values(shadow.result.authorization).every((value) => value === false));
});

test("73 — adapter has one selector authority and no executor, kernel, or copied scheduler", () => {
  const source = readFileSync("scripts/governed-execution/scheduler-authority-reuse-shadow-adapter.mjs", "utf8");
  assert.equal((source.match(/import\s*\{[^}]*\bselectMaximalSafeReadySet\b[^}]*\}\s*from\s*["']\.\/stage-dag\.mjs["']/gsu) ?? []).length, 1);
  assert.equal((source.match(/\bselectMaximalSafeReadySet\s*\(/gu) ?? []).length, 1);
  assert.doesNotMatch(source, /\b(?:executeNativeReadySet|createLangGraphReadySetExecutor|resolveReadySetExecutor|validateReadySetAdapterResult|readySetSettlementsToNodeResults)\b/u);
  assert.doesNotMatch(source, /\b(?:claimNode|heartbeatNode|completeNode|failNode|prepareEffect|appendEvent|resumeRun|projectRun|setRunTerminalStatus)\s*\(/u);
  assert.doesNotMatch(source, /\b(?:nodesConflict|scopesConflict|selectMaximumCompatibleCandidateIndexes)\b/u);
  assert.doesNotMatch(source, /\b(?:M3-P3|legacyGateCutover)\s*(?:=|\(|: true)/u);
});

test("73 — contract matches production schema, null-stage compatibility, and deferred M3-P3", () => {
  const contract = JSON.parse(readFileSync("config/contracts/scheduler-authority-reuse-shadow-contract.json", "utf8"));
  assert.deepEqual(contract.adapterContract.normalizedInput.exactFields, []);
  assert.equal(contract.resultSchema.exactTopLevelFields.includes("executionAssessment"), true);
  assert.deepEqual(contract.resultSchema.executionAssessment.exactFields, [
    "runStatus", "eventChainState", "currentness", "completedNodeIds",
    "activeClaimNodeIds", "unresolvedEffectNodeIds", "inDoubtNodeIds",
    "advisoryCompletedNodeIds", "advisoryActiveClaimNodeIds",
    "advisoryUnresolvedEffectNodeIds", "advisoryInDoubtNodeIds", "advisoryDisposition",
  ]);
  assert.match(contract.resultSchema.selectorOutput.stageIdentityRule, /selectorInput\.stage is null/u);
  assert.equal(contract.acceptance.allFiveStatusesKeepAll18AuthorizationValuesFalse, true);
  assert.equal(contract.verificationInvariants.plannedNeverMeansDispatched, true);
  assert.equal(contract.m3P3Boundary.mayStartDuringM3A04, false);
});
