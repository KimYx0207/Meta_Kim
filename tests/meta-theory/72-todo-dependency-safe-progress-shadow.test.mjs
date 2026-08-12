import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildContinuationPolicyShadowProjection } from "../../scripts/governed-execution/continuation-policy-shadow-adapter.mjs";
import { buildEvidenceTransitionShadowProjection } from "../../scripts/governed-execution/evidence-transition-shadow-adapter.mjs";
import { openDurableRunKernel } from "../../scripts/governed-execution/durable-run-kernel.mjs";
import { runStageRunnerBridge } from "../../scripts/governed-execution/stage-runner-bridge.mjs";
import {
  buildStageDagPacket,
  stageDagGraphDigest,
} from "../../scripts/governed-execution/stage-dag.mjs";
import { buildTodoDependencySafeProgressShadowProjection } from "../../scripts/governed-execution/todo-dependency-safe-progress-shadow-adapter.mjs";
import {
  assertValidTodoDependencySafeProgressShadowResult,
  evaluateTodoDependencySafeProgressShadow,
  TODO_DEPENDENCY_SAFE_PROGRESS_SHADOW_DISPOSITIONS,
} from "../../src/domain/work/todo-dependency-safe-progress-shadow.mjs";

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

const DIGEST = Object.freeze({
  task: digest("task:a03"),
  graph: digest("graph:a03"),
  projection: digest("projection:a03"),
  policy: digest("policy:a03"),
  event: digest("event:a03"),
  evidence: digest("evidence:a03"),
});

function node(nodeId, {
  dependsOn = [],
  effectClass = "read_only_worker",
  stage = "Execution",
  laneKind = "execution_worker",
  mergeNodeId = "stage:execution:merge",
} = {}) {
  return {
    nodeId,
    stage,
    laneKind,
    ownerBindingRef: `owner:${nodeId}`,
    capabilityBindingRef: `capability:${nodeId}`,
    dependsOn,
    effectClass,
    resourceScopes: [`resource:${nodeId}`],
    isolation: "shared_read_only",
    mergeNodeId,
  };
}

function topology(nodes = [
  node("gate", { effectClass: "approval_gate", laneKind: "decision_gate", mergeNodeId: null }),
  node("dep", { mergeNodeId: null }),
  node("candidate", { dependsOn: ["dep"], mergeNodeId: null }),
]) {
  return {
    schemaVersion: "stage-dag-v0.1",
    authority: "config/contracts/core-loop-contract.json",
    graphDigest: DIGEST.graph,
    nodes,
  };
}

function binding(overrides = {}) {
  return {
    runId: "run:m3-a03",
    taskFingerprint: DIGEST.task,
    graphDigest: DIGEST.graph,
    projectionDigest: DIGEST.projection,
    durableCursor: 3,
    headEventHash: DIGEST.event,
    headCheckpointId: "checkpoint:m3-a03",
    policyDigest: DIGEST.policy,
    evaluationRevision: 0,
    ...overrides,
  };
}

function decisionSnapshot({ pending = ["gate"], verified = [], unknown = [] } = {}) {
  const core = {
    pendingDecisionNodeIds: [...pending].sort(),
    verifiedDecisionNodeIds: [...verified].sort(),
    unknownDecisionNodeIds: [...unknown].sort(),
  };
  return { ...core, snapshotDigest: digest(core) };
}

function baseCommand(overrides = {}) {
  const commandBinding = binding(overrides.binding);
  const command = {
    binding: commandBinding,
    topology: topology(),
    executionSnapshot: {
      projectionDigest: commandBinding.projectionDigest,
      eventChainState: "verified",
      currentness: "bound_same_bridge_settlement",
      completedNodeIds: ["dep"],
      activeClaimNodeIds: [],
      unresolvedEffectNodeIds: [],
      inDoubtNodeIds: [],
    },
    decisionSnapshot: decisionSnapshot(),
    evidenceTransition: {
      schemaVersion: "evidence-transition-shadow-v1",
      resultDigest: DIGEST.evidence,
      bindingDigest: digest("a01-binding"),
      evaluationStatus: "evaluated",
      verdict: "blocked",
      blockedDecisionIds: ["gate"],
      reasonCodes: ["required_decision_not_authorized"],
    },
    continuation: {
      schemaVersion: "continuation-policy-shadow-v1",
      resultDigest: digest("a02-result"),
      bindingDigest: digest(commandBinding),
      evaluationStatus: "evaluated",
      action: "wait",
      reasonCodes: ["awaiting_human_decision"],
    },
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (key === "binding") continue;
    command[key] = value;
  }
  return command;
}

function workItem(result, nodeId) {
  return result.workItems.find((item) => item.nodeId === nodeId);
}

function assertDeepFrozen(value) {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

test("72 — authoritative topology derives one exact non-authoritative work item per node", () => {
  const command = baseCommand();
  const result = evaluateTodoDependencySafeProgressShadow(command);
  assert.equal(result.workItems.length, command.topology.nodes.length);
  assert.deepEqual(
    result.workItems.map((item) => item.nodeId).sort(),
    command.topology.nodes.map((item) => item.nodeId).sort(),
  );
  for (const item of result.workItems) {
    const source = command.topology.nodes.find((candidate) => candidate.nodeId === item.nodeId);
    assert.equal(item.workItemId, item.nodeId);
    assert.equal(item.projectionOnly, true);
    assert.equal(item.authoritative, false);
    for (const field of [
      "stage", "laneKind", "ownerBindingRef", "capabilityBindingRef", "dependsOn",
      "effectClass", "resourceScopes", "isolation", "mergeNodeId",
    ]) assert.deepEqual(item[field], source[field], field);
  }
  assertValidTodoDependencySafeProgressShadowResult(result);
});

test("72 — caller workItems and forged result cardinality cannot enter canonical truth", () => {
  const injected = { ...baseCommand(), workItems: [{ workItemId: "caller" }] };
  assert.throws(() => evaluateTodoDependencySafeProgressShadow(injected), /exactly the supported fields/iu);

  const canonicalResult = evaluateTodoDependencySafeProgressShadow(baseCommand());
  for (const mutate of [
    (result) => result.workItems.push(structuredClone(result.workItems[0])),
    (result) => result.workItems.pop(),
    (result) => { result.workItems[0].workItemId = "caller:forged"; },
    (result) => { result.workItems[0].dependsOn = ["caller:forged"]; },
  ]) {
    const forged = structuredClone(canonicalResult);
    mutate(forged);
    assert.throws(() => assertValidTodoDependencySafeProgressShadowResult(forged));
  }
});

test("72 — completed, waiting dependency, and dependency-ready candidate statuses follow execution facts", () => {
  const safe = evaluateTodoDependencySafeProgressShadow(baseCommand());
  assert.equal(workItem(safe, "dep").status, "completed");
  assert.equal(workItem(safe, "candidate").status, "safe_independent_candidate");

  const waitingCommand = baseCommand();
  waitingCommand.executionSnapshot.completedNodeIds = [];
  const waiting = evaluateTodoDependencySafeProgressShadow(waitingCommand);
  assert.equal(workItem(waiting, "candidate").status, "waiting_dependency");

  const continueCommand = baseCommand();
  continueCommand.continuation = {
    ...continueCommand.continuation,
    action: "continue",
    reasonCodes: ["unfinished_goal_executable_in_scope"],
  };
  const ready = evaluateTodoDependencySafeProgressShadow(continueCommand);
  assert.equal(workItem(ready, "candidate").status, "dependency_ready_candidate");
  assert.equal(ready.disposition.action, "candidates_available");
  assert.equal(ready.authorization.schedulerDispatchAllowed, false);
});

test("72 — decision-only wait proves only candidates with no pending decision ancestor", () => {
  const independent = evaluateTodoDependencySafeProgressShadow(baseCommand());
  assert.equal(independent.disposition.action, "safe_independent_candidates_available");
  const proof = independent.safeIndependentCandidates.find((item) => item.nodeId === "candidate");
  assert.ok(proof);
  assert.equal(proof.workItemId, proof.nodeId);
  assert.deepEqual(proof.transitiveDependencyNodeIds, ["dep"]);
  assert.deepEqual(proof.intersectingDecisionNodeIds, []);
  assert.equal(proof.decisionIndependenceProven, true);
  assert.equal(independent.authorization.executionAllowed, false);

  const dependentTopology = topology([
    node("gate", { effectClass: "approval_gate", laneKind: "decision_gate", mergeNodeId: null }),
    node("candidate", { dependsOn: ["gate"], mergeNodeId: null }),
  ]);
  const dependent = evaluateTodoDependencySafeProgressShadow(baseCommand({
    topology: dependentTopology,
    executionSnapshot: {
      ...baseCommand().executionSnapshot,
      completedNodeIds: [],
    },
  }));
  assert.equal(workItem(dependent, "candidate").status, "waiting_decision");
  assert.equal(dependent.safeIndependentCandidates.some((item) => item.nodeId === "candidate"), false);
});

test("72 — unbound, unknown, or global Decision applicability never proves independence", () => {
  const unboundCommand = baseCommand();
  unboundCommand.evidenceTransition = {
    ...unboundCommand.evidenceTransition,
    blockedDecisionIds: ["decision:global"],
  };
  const unbound = evaluateTodoDependencySafeProgressShadow(unboundCommand);
  assert.equal(unbound.disposition.action, "in_doubt");
  assert.equal(unbound.safeIndependentCandidates.length, 0);

  const unknownCommand = baseCommand({
    decisionSnapshot: decisionSnapshot({ pending: [], unknown: ["gate"] }),
  });
  const unknown = evaluateTodoDependencySafeProgressShadow(unknownCommand);
  assert.equal(unknown.disposition.action, "in_doubt");
  assert.equal(unknown.safeIndependentCandidates.length, 0);
});

test("72 — decision-only wait without an exactly blocked approval gate cannot vacuously prove independence", () => {
  const command = baseCommand();
  command.evidenceTransition = {
    ...command.evidenceTransition,
    blockedDecisionIds: [],
    reasonCodes: ["required_evidence_rejected"],
  };
  command.continuation = {
    ...command.continuation,
    reasonCodes: ["evidence_transition_blocked"],
  };
  const result = evaluateTodoDependencySafeProgressShadow(command);
  assert.notEqual(result.disposition.action, "safe_independent_candidates_available");
  assert.equal(result.safeIndependentCandidates.length, 0);
  assert.notEqual(workItem(result, "candidate").status, "safe_independent_candidate");
});

test("72 — stop and escalate suppress candidates and remain fully advisory", () => {
  for (const [action, reasonCodes, expected] of [
    ["stop", ["authoritative_run_terminal"], "stop"],
    ["escalate", ["authority_binding_mismatch"], "escalate"],
  ]) {
    const command = baseCommand();
    command.continuation = { ...command.continuation, action, reasonCodes };
    const result = evaluateTodoDependencySafeProgressShadow(command);
    assert.equal(result.disposition.action, expected);
    assert.equal(result.safeIndependentCandidates.length, 0);
    assert.ok(Object.values(result.authorization).every((value) => value === false));
  }
});

test("72 — claims, effects, in-doubt state, and unproven currentness block candidates without time inference", () => {
  const cases = [
    ["activeClaimNodeIds", ["candidate"], "waiting_active_claim"],
    ["unresolvedEffectNodeIds", ["candidate"], "waiting_unresolved_effect"],
    ["inDoubtNodeIds", ["candidate"], "in_doubt"],
  ];
  for (const [field, value, status] of cases) {
    const command = baseCommand();
    command.executionSnapshot[field] = value;
    const result = evaluateTodoDependencySafeProgressShadow(command);
    assert.equal(workItem(result, "candidate").status, status);
    assert.equal(result.safeIndependentCandidates.some((item) => item.nodeId === "candidate"), false);
  }

  const unprovenCommand = baseCommand();
  unprovenCommand.executionSnapshot.currentness = "unproven";
  const unproven = evaluateTodoDependencySafeProgressShadow(unprovenCommand);
  assert.equal(unproven.disposition.action, "wait");
  assert.equal(unproven.safeIndependentCandidates.length, 0);

  for (const forbidden of ["resumable", "now", "leaseExpiresAtMs"]) {
    const command = baseCommand();
    command.executionSnapshot[forbidden] = forbidden === "resumable" ? true : 0;
    assert.throws(() => evaluateTodoDependencySafeProgressShadow(command), /exactly the supported fields/iu);
  }
});

test("72 — approval gates and external writes never become safe-independent candidates", () => {
  const command = baseCommand({
    topology: topology([
      node("gate", { effectClass: "approval_gate", laneKind: "decision_gate", mergeNodeId: null }),
      node("dep", { mergeNodeId: null }),
      node("external", { effectClass: "external_write", dependsOn: ["dep"], mergeNodeId: null }),
    ]),
  });
  const result = evaluateTodoDependencySafeProgressShadow(command);
  assert.equal(result.safeIndependentCandidates.some((item) => item.nodeId === "gate"), false);
  assert.equal(result.safeIndependentCandidates.some((item) => item.nodeId === "external"), false);
  assert.equal(workItem(result, "external").status, "suppressed_by_run_disposition");
});

test("72 — topology, execution, and continuation binding conflicts fail closed", () => {
  const graphMismatch = baseCommand({ binding: { graphDigest: digest("other-graph") } });
  graphMismatch.continuation.bindingDigest = digest(graphMismatch.binding);
  assert.equal(evaluateTodoDependencySafeProgressShadow(graphMismatch).disposition.action, "escalate");

  const projectionMismatch = baseCommand();
  projectionMismatch.binding.projectionDigest = digest("other-projection");
  projectionMismatch.continuation.bindingDigest = digest(projectionMismatch.binding);
  assert.equal(evaluateTodoDependencySafeProgressShadow(projectionMismatch).disposition.action, "escalate");

  const replay = baseCommand();
  replay.binding.runId = "run:replay";
  assert.equal(evaluateTodoDependencySafeProgressShadow(replay).disposition.action, "escalate");
});

test("72 — cycles, missing dependencies, duplicate nodes, and malformed digests are rejected", () => {
  const cases = [
    topology([node("a", { dependsOn: ["b"] }), node("b", { dependsOn: ["a"] })]),
    topology([node("a", { dependsOn: ["missing"] })]),
    topology([node("a"), node("a")]),
  ];
  for (const value of cases) {
    assert.throws(() => evaluateTodoDependencySafeProgressShadow(baseCommand({ topology: value })));
  }
  const malformed = baseCommand();
  malformed.topology.graphDigest = "not-a-digest";
  assert.throws(() => evaluateTodoDependencySafeProgressShadow(malformed), /sha256/iu);
});

test("72 — strict records, arrays, secrets, and prototype attacks fail closed", () => {
  const callerBoard = { ...baseCommand(), dispatchBoard: [{ nodeId: "caller" }] };
  assert.throws(() => evaluateTodoDependencySafeProgressShadow(callerBoard), /exactly the supported fields/iu);

  const sparse = baseCommand();
  sparse.topology.nodes[0].dependsOn = new Array(1);
  assert.throws(() => evaluateTodoDependencySafeProgressShadow(sparse), /sparse/iu);

  const accessor = baseCommand();
  Object.defineProperty(accessor, "binding", { enumerable: true, get: () => binding() });
  assert.throws(() => evaluateTodoDependencySafeProgressShadow(accessor), /own data/iu);

  const proxy = new Proxy(baseCommand(), { ownKeys: () => { throw new Error("secret"); } });
  assert.throws(() => evaluateTodoDependencySafeProgressShadow(proxy), /inspectable/iu);

  const polluted = Object.assign(Object.create({ schedulerDispatchAllowed: true }), baseCommand());
  assert.throws(() => evaluateTodoDependencySafeProgressShadow(polluted), /plain Object\.prototype record/iu);

  const secret = baseCommand();
  secret.topology.nodes[0].resourceScopes = ["sk-live-this-must-not-be-retained-1234567890"];
  assert.throws(() => evaluateTodoDependencySafeProgressShadow(secret), /safe bounded topology value/iu);
});

test("72 — provider tokens, JWTs, high-entropy credentials, and Unicode confusables are rejected without echo", () => {
  const secrets = [
    "eyJhbGciOiJIUzI1NiJ9." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0." + "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    "sk-" + "proj-abcdefghijklmnopqrstuvwxyz0123456789",
    "AKIA" + "ABCDEFGHIJKLMNOP",
    "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789AB",
    "xoxb-" + "123456789012-123456789012-abcdefghijklmnopqrstuvwx",
    "AIza" + "SyABCDEFGHIJKLMNOPQRSTUVWXYZ1234567",
    "sk_" + "live_abcdefghijklmnopqrstuvwxyz012345",
    "aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY3zA5bC7dE9fG1hJ3",
    "ѕk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
  ];
  for (const secret of secrets) {
    for (const field of ["ownerBindingRef", "capabilityBindingRef", "resourceScopes"]) {
      const command = baseCommand();
      command.topology.nodes[0][field] = field === "resourceScopes" ? [`file:${secret}`] : secret;
      let caught;
      try {
        evaluateTodoDependencySafeProgressShadow(command);
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof TypeError, `${field}:${secret.slice(0, 8)}`);
      assert.equal(String(caught.message).includes(secret), false);
      assert.equal(JSON.stringify({ name: caught.name, message: caught.message }).includes(secret), false);
    }
  }

  const safe = baseCommand();
  safe.topology.nodes[0].resourceScopes = ["file:src/domain/work/module.mjs"];
  assert.doesNotThrow(() => evaluateTodoDependencySafeProgressShadow(safe));
});

test("72 — result is deterministic, deeply frozen, and all 18 permissions are false", () => {
  const first = evaluateTodoDependencySafeProgressShadow(baseCommand());
  const second = evaluateTodoDependencySafeProgressShadow(structuredClone(baseCommand()));
  assert.deepEqual(first, second);
  assert.equal(Object.keys(first.authorization).length, 18);
  assert.ok(Object.values(first.authorization).every((value) => value === false));
  assert.equal(first.eventIntents[0].persisted, false);
  assert.equal(first.eventIntents[0].authoritative, false);
  assert.equal(first.eventIntents[0].writeAllowed, false);
  assertDeepFrozen(first);
  assert.deepEqual(TODO_DEPENDENCY_SAFE_PROGRESS_SHADOW_DISPOSITIONS, [
    "candidates_available", "safe_independent_candidates_available", "wait",
    "stop", "escalate", "in_doubt",
  ]);
});

test("72 — contract and production agree on topology authority and replay boundary", () => {
  const contract = JSON.parse(readFileSync(
    "config/contracts/todo-dependency-safe-progress-shadow-contract.json",
    "utf8",
  ));
  assert.equal(contract.commandSchema.topology.sourcePacket, "coreLoop.stageDagPacket");
  assert.equal(contract.commandSchema.topology.authority, "config/contracts/core-loop-contract.json");
  assert.equal(topology().authority, contract.commandSchema.topology.authority);
  assert.deepEqual(contract.commandSchema.binding.antiReplayExactFields, contract.commandSchema.binding.exactFields);
  assert.ok(
    contract.safeIndependentPolicy.allRequired.includes(
      "evidenceTransition.blockedDecisionIds.length > 0",
    ),
  );
  assert.equal(contract.acceptance.unknownOrGlobalDecisionApplicabilityBlocksSafeIndependent, true);
  assert.equal(contract.acceptance.fullBindingMismatchBlocksReplay, true);
});

test("72 — adapter source has no Todo, ready-set, scheduler, or kernel mutation capability", () => {
  const source = readFileSync("scripts/governed-execution/todo-dependency-safe-progress-shadow-adapter.mjs", "utf8");
  assert.doesNotMatch(source, /TaskCreate|TaskUpdate|TodoWrite/u);
  assert.doesNotMatch(source, /\b(?:selectMaximalSafeReadySet|claimNode|heartbeatNode|completeNode|failNode|prepareEffect|appendEvent|resumeRun|projectRun|setRunTerminalStatus)\s*\(/u);
  assert.doesNotMatch(source, /\b(?:M3-P3|legacyGateCutover)\s*(?:=|\(|: true)/u);
  assert.match(source, /selectsSchedulerReadySet:\s*false/u);
  assert.match(source, /dispatchesScheduler:\s*false/u);
  assert.match(source, /projectionOnly:\s*true/u);
});

function bridgeLane() {
  return {
    laneId: "todo-worker",
    laneKind: "execution_worker",
    ownerBindingRef: "owner:test-worker",
    capabilityBindingRef: "capability:read-only-test",
    effectClass: "read_only_worker",
    resourceScopes: ["file:package.json"],
    isolation: "shared_read_only",
    status: "planned_not_invoked",
  };
}

function bridgePacket() {
  return {
    taskPacketId: "todo-worker",
    ownerAgent: "test-automator",
    description: "Read package metadata",
    output: "observed package metadata",
    dependsOn: [],
    executionMode: "primary_execution",
    externalWriteBoundary: false,
  };
}

function bridgeDag() {
  return buildStageDagPacket({
    stageOrder: ["Execution", "Review"],
    stageLanes: { Execution: [bridgeLane()], Review: [] },
    runtimeCapacity: 1,
  });
}

function assessment(state, evidenceRefs = []) {
  const normalized = { state, evidenceRefs: [...evidenceRefs].sort() };
  return { ...normalized, assessmentDigest: digest(normalized) };
}

function controlAssessment() {
  const normalized = { state: "none", controlRef: null, evidenceRefs: [] };
  return { ...normalized, assessmentDigest: digest(normalized) };
}

function bridgeA01Input() {
  return {
    policyDigest: digest("bridge-policy"),
    evidenceClaims: [{
      claimId: "claim:bridge",
      producerRef: "producer:bridge",
      evidenceType: "test_result",
      subjectRef: "subject:bridge",
      payloadDigest: digest("bridge-payload"),
    }],
    validatorAssessments: [{
      claimId: "claim:bridge",
      validatorRef: "validator:bridge",
      assessment: "verified",
      assessmentDigest: digest("bridge-assessment"),
      reasonCode: "independent_check_passed",
    }],
    decisionDependencies: [],
    transitionRequest: {
      proposalId: "proposal:bridge",
      fromStage: "execution",
      toStage: "review",
      requiredClaimIds: ["claim:bridge"],
    },
  };
}

function bridgeA02Input() {
  return {
    policyDigest: digest("bridge-policy"),
    evaluationRevision: 0,
    goalAssessment: assessment("unfinished"),
    workAssessment: assessment("executable_candidate_present"),
    evidenceAssessment: assessment("new_valid_evidence_expected"),
    blockerAssessment: assessment("none"),
    humanDecisionAssessment: assessment("not_required"),
    scopeAssessment: assessment("inside"),
    repeatAssessment: assessment("novel"),
    controlAssessment: controlAssessment(),
  };
}

async function runBridgeVariant({ runId, withTodo }) {
  const kernel = await openDurableRunKernel();
  const stageDagPacket = bridgeDag();
  const taskFingerprint = `task:${runId}`;
  try {
    const result = await runStageRunnerBridge({
      runId,
      runtime: "codex",
      stageDagPacket,
      workerTaskPackets: [bridgePacket()],
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
      ...(withTodo ? { todoDependencySafeProgressShadow: {} } : {}),
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
    return {
      result,
      projection: kernel.projectRun(runId),
      events: kernel.getEvents(runId),
      resume: kernel.resumeRun({
        runId,
        graphDigest: stageDagPacket.graphDigest,
        taskFingerprint,
      }),
      stageDagPacket,
    };
  } finally {
    kernel.close();
  }
}

function legacySnapshot(run) {
  return {
    status: run.result.status,
    stageDagPacket: run.result.stageDagPacket,
    nodeRecords: run.result.nodeRecords.map(({ nodeId, status, outputSha256 }) => ({ nodeId, status, outputSha256 })),
    workerResults: run.result.workerResults.map(({ status, outputSha256, rawOutputSha256 }) => ({ status, outputSha256, rawOutputSha256 })),
    eventTypes: run.events.map((event) => event.eventType),
    eventCount: run.events.length,
    cursor: run.projection.cursor,
    checkpointIds: run.projection.completedNodes.map((record) => record.checkpointId),
    completedNodeIds: run.projection.completedNodes.map((record) => record.nodeId),
  };
}

test("72 — bridge A/B toggle and compatibility-board rejection preserve DAG and durable truth", async () => {
  const runId = "m3-a03-bridge-parity";
  const baseline = await runBridgeVariant({ runId, withTodo: false });
  const enabled = await runBridgeVariant({ runId, withTodo: true });
  assert.equal(Object.hasOwn(baseline.result, "todoDependencySafeProgressShadowProjection"), false);
  assert.equal(Object.hasOwn(enabled.result, "todoDependencySafeProgressShadowProjection"), true);
  const shadow = enabled.result.todoDependencySafeProgressShadowProjection;
  assert.equal(shadow.evaluationStatus, "evaluated");
  assert.ok(Object.values(shadow.result.authorization).every((value) => value === false));
  assert.deepEqual(legacySnapshot(enabled), legacySnapshot(baseline));
  assert.equal(JSON.stringify(enabled.events).includes("todoDependencySafeProgressShadow"), false);
  assert.equal(JSON.stringify(enabled.projection.completedNodes).includes("todoDependencySafeProgressShadow"), false);

  const boardDrift = buildTodoDependencySafeProgressShadowProjection(
    { dispatchBoard: [{ nodeId: "caller-extra" }] },
    {
      authoritativeTopology: enabled.stageDagPacket,
      authoritativeExecutionSnapshot: {
        durableRunProjection: enabled.projection,
        durableResume: enabled.resume,
        nodeRecords: enabled.result.nodeRecords.map(({ nodeId, status }) => ({ nodeId, status })),
      },
      evidenceTransitionShadowProjection: enabled.result.evidenceTransitionShadowProjection,
      continuationPolicyShadowProjection: enabled.result.continuationPolicyShadowProjection,
    },
  );
  assert.equal(boardDrift.evaluationStatus, "not_evaluated_invalid_normalized_input");
  assert.equal(boardDrift.result, null);
});

test("72 — adapter rejects cross-run canonical A01 replay and topology digest forgery", async () => {
  const enabled = await runBridgeVariant({ runId: "m3-a03-adapter-replay", withTodo: true });
  const authority = {
    authoritativeTopology: enabled.stageDagPacket,
    authoritativeExecutionSnapshot: {
      durableRunProjection: enabled.projection,
      durableResume: enabled.resume,
      nodeRecords: enabled.result.nodeRecords.map(({ nodeId, status }) => ({ nodeId, status })),
    },
    continuationPolicyShadowProjection: enabled.result.continuationPolicyShadowProjection,
  };

  const a02Binding = enabled.result.continuationPolicyShadowProjection.result.binding;
  const replayA01 = buildEvidenceTransitionShadowProjection({
    binding: {
      runId: "run:replayed-a01",
      taskFingerprint: a02Binding.taskFingerprint,
      graphDigest: a02Binding.graphDigest,
      nodeId: "stage:execution:merge",
      attemptId: "attempt:replay",
      fenceToken: 1,
      revision: 0,
      policyDigest: a02Binding.policyDigest,
    },
    evidenceClaims: [],
    validatorAssessments: [],
    decisionDependencies: [],
    transitionRequest: {
      proposalId: "proposal:replay",
      fromStage: "execution",
      toStage: "review",
      requiredClaimIds: [],
    },
  });
  const replayed = buildTodoDependencySafeProgressShadowProjection({}, {
    ...authority,
    evidenceTransitionShadowProjection: replayA01,
  });
  assert.equal(replayed.evaluationStatus, "not_evaluated_invalid_normalized_input");
  assert.equal(replayed.disposition, "escalate");
  assert.equal(replayed.result, null);

  const originalA01 = enabled.result.evidenceTransitionShadowProjection.result;
  const substitutedA01 = buildEvidenceTransitionShadowProjection({
    binding: {
      ...originalA01.binding,
      attemptId: "attempt:substituted-canonical-result",
    },
    evidenceClaims: originalA01.evidenceClaims.map(({ claimDigest: _claimDigest, ...claim }) => claim),
    validatorAssessments: originalA01.validatorAssessments,
    decisionDependencies: originalA01.decisionDependencies,
    transitionRequest: {
      proposalId: originalA01.transitionProposal.proposalId,
      fromStage: originalA01.transitionProposal.fromStage,
      toStage: originalA01.transitionProposal.toStage,
      requiredClaimIds: originalA01.transitionProposal.requiredClaimIds,
    },
  });
  assert.equal(substitutedA01.evaluationStatus, "evaluated");
  const substituted = buildTodoDependencySafeProgressShadowProjection({}, {
    ...authority,
    evidenceTransitionShadowProjection: substitutedA01,
  });
  assert.equal(substituted.evaluationStatus, "not_evaluated_invalid_normalized_input");
  assert.equal(substituted.disposition, "escalate");
  assert.equal(substituted.result, null);

  const forgedDag = structuredClone(enabled.stageDagPacket);
  forgedDag.graphDigest = "f".repeat(64);
  assert.notEqual(stageDagGraphDigest(forgedDag), forgedDag.graphDigest);
  const forged = buildTodoDependencySafeProgressShadowProjection({}, {
    ...authority,
    authoritativeTopology: forgedDag,
    evidenceTransitionShadowProjection: enabled.result.evidenceTransitionShadowProjection,
  });
  assert.equal(forged.evaluationStatus, "not_evaluated_invalid_normalized_input");
  assert.equal(forged.result, null);

  const secretValue = "sk-proj-adapter-bounded-failure-abcdefghijklmnopqrstuvwxyz";
  const secretDag = structuredClone(enabled.stageDagPacket);
  secretDag.nodes[0].ownerBindingRef = secretValue;
  secretDag.graphDigest = stageDagGraphDigest(secretDag);
  const bounded = buildTodoDependencySafeProgressShadowProjection({}, {
    ...authority,
    authoritativeTopology: secretDag,
    evidenceTransitionShadowProjection: enabled.result.evidenceTransitionShadowProjection,
  });
  assert.equal(bounded.evaluationStatus, "not_evaluated_invalid_normalized_input");
  assert.equal(bounded.disposition, "escalate");
  assert.equal(bounded.result, null);
  assert.equal(JSON.stringify(bounded).includes(secretValue), false);
});
