import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { buildLeaseClaimAuthorityShadowProjection } from "../../scripts/governed-execution/lease-claim-authority-shadow-adapter.mjs";
import { openDurableRunKernel } from "../../scripts/governed-execution/durable-run-kernel.mjs";
import { runStageRunnerBridge } from "../../scripts/governed-execution/stage-runner-bridge.mjs";
import { buildStageDagPacket } from "../../scripts/governed-execution/stage-dag.mjs";
import {
  assertValidLeaseClaimAuthorityShadowResult,
  evaluateLeaseClaimAuthorityShadow,
} from "../../src/domain/claims/lease-claim-authority-shadow.mjs";

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

const AUTHORIZATION_FIELDS = [
  "claimAllowed", "takeoverAllowed", "heartbeatAllowed", "releaseAllowed",
  "coordinatorMutationAllowed", "nodeMutationAllowed", "fenceMutationAllowed",
  "retryAllowed", "reconcileAllowed", "schedulerDispatchAllowed", "executionAllowed",
  "eventPersistenceAllowed", "cursorAdvanceAllowed", "checkpointMutationAllowed",
  "completeNodeAllowed", "terminalStatusWriteAllowed", "legacyGateCutoverAllowed",
  "authoritativeWriteAllowed",
];

function binding(overrides = {}) {
  return {
    runId: "run:m3-a05",
    taskFingerprint: digest("task:m3-a05"),
    graphDigest: digest("graph:m3-a05"),
    projectionDigest: digest("projection:m3-a05"),
    durableCursor: 7,
    headEventHash: digest("event:m3-a05"),
    headCheckpointId: "checkpoint:m3-a05",
    policyDigest: digest("policy:m3-a05"),
    evaluationRevision: 0,
    ...overrides,
  };
}

function claimRecord(nodeId, {
  runId = "run:m3-a05",
  fenceToken = 91,
  leaseExpiresAtMs = 2_000,
  latestClaimEventSeq = 7,
} = {}) {
  const core = {
    runId,
    nodeId,
    attemptRefDigest: digest(`attempt:${nodeId}`),
    ownerRefDigest: digest(`owner:${nodeId}`),
    fenceToken,
    leaseExpiresAtMs,
    latestClaimEventSeq,
    latestClaimEventHash: digest(`claim-event:${nodeId}`),
  };
  return { ...core, recordDigest: digest(core) };
}

function command({
  topologyNodeIds = ["node:a"],
  claimRecords = [],
  completedNodeIds = [],
  blockingEffectNodeIds = [],
  inDoubtNodeIds = [],
  runStatus = "active",
  eventChainState = "verified",
  currentness = "fresh_bound_same_settlement",
  trustedObservedAtMs = 1_000,
  bindingOverrides = {},
  authorityOverrides = {},
} = {}) {
  const bound = binding(bindingOverrides);
  const sortedClaims = [...claimRecords].sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const blockingState = {
    completedNodeIds: [...completedNodeIds].sort(),
    blockingEffectNodeIds: [...blockingEffectNodeIds].sort(),
    inDoubtNodeIds: [...inDoubtNodeIds].sort(),
  };
  const trustedCore = {
    source: "stage_runner_bridge_wall_clock_capture",
    projectionDigest: bound.projectionDigest,
    cursor: bound.durableCursor,
    headEventHash: bound.headEventHash,
    headCheckpointId: bound.headCheckpointId,
    trustedObservedAtMs,
  };
  const authorityCore = {
    source: "stage_runner_bridge_existing_durable_authority_snapshot",
    projectionSchemaVersion: "durable-governed-run-projection-v0.1",
    runStatus,
    runId: bound.runId,
    taskFingerprint: bound.taskFingerprint,
    graphDigest: bound.graphDigest,
    projectionDigest: bound.projectionDigest,
    cursor: bound.durableCursor,
    headEventHash: bound.headEventHash,
    headCheckpointId: bound.headCheckpointId,
    eventChainState,
    currentness,
    topologyNodeIds: [...topologyNodeIds].sort(),
    completedNodeIds: blockingState.completedNodeIds,
    blockingEffectNodeIds: blockingState.blockingEffectNodeIds,
    inDoubtNodeIds: blockingState.inDoubtNodeIds,
    claimSetDigest: digest(sortedClaims),
    blockingStateDigest: digest(blockingState),
    trustedObservedAtMs,
    trustedObservedAtDigest: digest(trustedCore),
    ...authorityOverrides,
  };
  return {
    binding: bound,
    authoritySnapshot: { ...authorityCore, snapshotDigest: digest(authorityCore) },
    claimRecords: sortedClaims,
    coordinatorObservation: {
      state: "not_exposed_by_current_snapshot",
      reasonCode: "coordinator_authority_not_exposed",
      projectionOnly: true,
      authoritative: false,
    },
  };
}

function observation(result, nodeId) {
  return result.claimObservations.find((item) => item.nodeId === nodeId);
}

function assertDeepFrozen(value) {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

function recursiveKeys(value, output = []) {
  if (!value || typeof value !== "object") return output;
  for (const [key, child] of Object.entries(value)) {
    output.push(key);
    recursiveKeys(child, output);
  }
  return output;
}

test("74 — clean authority produces one sanitized no-claim observation per topology node", () => {
  const result = evaluateLeaseClaimAuthorityShadow(command({ topologyNodeIds: ["node:b", "node:a"] }));
  assert.equal(result.schemaVersion, "lease-claim-authority-shadow-v1");
  assert.equal(result.kind, "lease_claim_authority_shadow_result");
  assert.equal(result.disposition.state, "observed");
  assert.deepEqual(result.claimObservations.map((item) => item.nodeId), ["node:a", "node:b"]);
  assert.ok(result.claimObservations.every((item) => item.state === "no_claim_observed"));
  assert.equal(result.summary.topologyNodeCount, 2);
  assert.equal(result.summary.noClaimCount, 2);
  assertValidLeaseClaimAuthorityShadowResult(result);
});

test("74 — all five per-node states follow the frozen precedence", () => {
  const nodes = ["node:none", "node:active", "node:expired", "node:effect", "node:doubt"];
  const result = evaluateLeaseClaimAuthorityShadow(command({
    topologyNodeIds: nodes,
    claimRecords: [
      claimRecord("node:active", { leaseExpiresAtMs: 1_001 }),
      claimRecord("node:expired", { leaseExpiresAtMs: 1_000 }),
    ],
    blockingEffectNodeIds: ["node:effect"],
    inDoubtNodeIds: ["node:doubt"],
  }));
  assert.equal(observation(result, "node:none").state, "no_claim_observed");
  assert.equal(observation(result, "node:active").state, "active_unexpired_observed");
  assert.equal(observation(result, "node:expired").state, "expired_requires_kernel_recheck");
  assert.equal(observation(result, "node:effect").state, "blocked_by_unresolved_effect");
  assert.equal(observation(result, "node:doubt").state, "in_doubt");
  assert.equal(result.disposition.state, "in_doubt");
});

test("74 — active, expired, and blocking observations wait and never authorize takeover", () => {
  for (const fixture of [
    { claimRecords: [claimRecord("node:a", { leaseExpiresAtMs: 1_001 })], expected: "active_unexpired_observed" },
    { claimRecords: [claimRecord("node:a", { leaseExpiresAtMs: 1_000 })], expected: "expired_requires_kernel_recheck" },
    { blockingEffectNodeIds: ["node:a"], expected: "blocked_by_unresolved_effect" },
  ]) {
    const result = evaluateLeaseClaimAuthorityShadow(command(fixture));
    assert.equal(result.disposition.state, "wait");
    assert.equal(observation(result, "node:a").state, fixture.expected);
    assert.equal(result.authorization.claimAllowed, false);
    assert.equal(result.authorization.takeoverAllowed, false);
  }
});

test("74 — clean terminal is terminal while terminal or completed claims are in_doubt", () => {
  const terminal = evaluateLeaseClaimAuthorityShadow(command({ runStatus: "completed" }));
  assert.equal(terminal.disposition.state, "terminal");
  assert.ok(terminal.disposition.reasonCodes.includes("authoritative_run_terminal"));

  const terminalClaim = evaluateLeaseClaimAuthorityShadow(command({
    runStatus: "completed",
    claimRecords: [claimRecord("node:a")],
  }));
  assert.equal(terminalClaim.disposition.state, "in_doubt");
  assert.equal(observation(terminalClaim, "node:a").state, "in_doubt");
  assert.ok(observation(terminalClaim, "node:a").reasonCodes.includes("terminal_claim_conflict"));

  const completedClaim = evaluateLeaseClaimAuthorityShadow(command({
    completedNodeIds: ["node:a"],
    claimRecords: [claimRecord("node:a")],
  }));
  assert.equal(completedClaim.disposition.state, "in_doubt");
  assert.ok(observation(completedClaim, "node:a").reasonCodes.includes("completed_claim_conflict"));
});

test("74 — binding, integrity, and currentness failures are globally in_doubt", () => {
  for (const fixture of [
    { authorityOverrides: { runId: "run:other" } },
    { eventChainState: "failed" },
    { currentness: "unproven" },
  ]) {
    const result = evaluateLeaseClaimAuthorityShadow(command(fixture));
    assert.equal(result.disposition.state, "in_doubt");
    assert.equal(result.authorization.claimAllowed, false);
  }
});

test("74 — cross-run, unknown-node, and duplicate claim conflicts never disappear", () => {
  const fixtures = [
    [claimRecord("node:a", { runId: "run:other" })],
    [claimRecord("node:unknown")],
    [claimRecord("node:a"), claimRecord("node:a", { fenceToken: 92 })],
  ];
  for (const claimRecords of fixtures) {
    const result = evaluateLeaseClaimAuthorityShadow(command({ claimRecords }));
    assert.equal(result.disposition.state, "in_doubt");
    assert.equal(result.authorization.claimAllowed, false);
  }
});

test("74 — raw observed time, fence, expiry, owner, and attempt values never enter result", () => {
  const rawFence = 987_654_321;
  const rawExpiry = 1_234_567_890;
  const rawObservedAt = 1_000;
  const result = evaluateLeaseClaimAuthorityShadow(command({
    trustedObservedAtMs: rawObservedAt,
    claimRecords: [claimRecord("node:a", { fenceToken: rawFence, leaseExpiresAtMs: rawExpiry })],
  }));
  const keys = recursiveKeys(result);
  for (const forbidden of ["trustedObservedAtMs", "fenceToken", "leaseExpiresAtMs", "leaseOwner", "attemptId"]) {
    assert.equal(keys.includes(forbidden), false, forbidden);
  }
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(String(rawFence)), false);
  assert.equal(serialized.includes(String(rawExpiry)), false);
  assert.equal(serialized.includes(`:${rawObservedAt},`), false);
  assert.match(observation(result, "node:a").fenceRefDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(observation(result, "node:a").leaseWindowDigest, /^sha256:[a-f0-9]{64}$/u);
});

test("74 — coordinator remains explicitly not exposed and cannot be forged", () => {
  const result = evaluateLeaseClaimAuthorityShadow(command());
  assert.deepEqual(result.coordinatorObservation, {
    state: "not_exposed_by_current_snapshot",
    reasonCode: "coordinator_authority_not_exposed",
    projectionOnly: true,
    authoritative: false,
  });
  const forged = command();
  forged.coordinatorObservation.state = "active";
  assert.throws(() => evaluateLeaseClaimAuthorityShadow(forged));
});

test("74 — result is deterministic, deeply frozen, and all exact 18 permissions are false", () => {
  const first = evaluateLeaseClaimAuthorityShadow(command());
  const second = evaluateLeaseClaimAuthorityShadow(command());
  assert.deepEqual(first, second);
  assertDeepFrozen(first);
  assert.deepEqual(Object.keys(first.authorization), AUTHORIZATION_FIELDS);
  assert.ok(Object.values(first.authorization).every((value) => value === false));
  const forged = structuredClone(first);
  forged.authorization.takeoverAllowed = true;
  assert.throws(() => assertValidLeaseClaimAuthorityShadowResult(forged));
});

test("74 — malformed records, arrays, digests, accessors, and secrets fail closed", () => {
  const unknown = { ...command(), rawLease: 1 };
  assert.throws(() => evaluateLeaseClaimAuthorityShadow(unknown));
  const sparse = command();
  sparse.authoritySnapshot.topologyNodeIds = ["node:a", "node:b"];
  delete sparse.authoritySnapshot.topologyNodeIds[1];
  assert.throws(() => evaluateLeaseClaimAuthorityShadow(sparse));
  const accessor = command();
  Object.defineProperty(accessor.binding, "runId", { enumerable: true, get: () => "run:forged" });
  assert.throws(() => evaluateLeaseClaimAuthorityShadow(accessor));
  const secret = command({ bindingOverrides: { runId: "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789" } });
  assert.throws(() => evaluateLeaseClaimAuthorityShadow(secret));
});

test("74 — adapter missing and invalid input envelopes are bounded and non-authorizing", () => {
  for (const input of [null, undefined, { claimRecords: [] }, { observedAtMs: Date.now() }]) {
    const envelope = buildLeaseClaimAuthorityShadowProjection(input, {});
    assert.match(envelope.evaluationStatus, /^not_evaluated_/u);
    assert.equal(envelope.disposition, "in_doubt");
    assert.equal(envelope.result, null);
    assert.equal(envelope.authority.projectionOnly, true);
    assert.ok(Object.entries(envelope.authority).every(([key, value]) => value === (key === "projectionOnly")));
  }
});

function bridgeLane() {
  return {
    laneId: "claim-worker",
    laneKind: "execution_worker",
    ownerBindingRef: "owner:claim-worker",
    capabilityBindingRef: "capability:claim-worker",
    dependsOn: [],
    effectClass: "read_only_worker",
    resourceScopes: ["file:package.json"],
    isolation: "shared_read_only",
    status: "planned_not_invoked",
  };
}

function assessment(state) {
  const core = { state, evidenceRefs: [] };
  return { ...core, assessmentDigest: digest(core) };
}

function bridgeA01Input() {
  return {
    policyDigest: digest("bridge-policy:a05"),
    evidenceClaims: [{
      claimId: "claim:bridge-a05",
      producerRef: "producer:bridge-a05",
      evidenceType: "test_result",
      subjectRef: "subject:bridge-a05",
      payloadDigest: digest("bridge-payload:a05"),
    }],
    validatorAssessments: [{
      claimId: "claim:bridge-a05",
      validatorRef: "validator:bridge-a05",
      assessment: "verified",
      assessmentDigest: digest("bridge-assessment:a05"),
      reasonCode: "independent_check_passed",
    }],
    decisionDependencies: [],
    transitionRequest: {
      proposalId: "proposal:bridge-a05",
      fromStage: "execution",
      toStage: "review",
      requiredClaimIds: ["claim:bridge-a05"],
    },
  };
}

function bridgeA02Input() {
  const controlCore = { state: "none", controlRef: null, evidenceRefs: [] };
  return {
    policyDigest: digest("bridge-policy:a05"),
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

async function bridgeVariant(withLeaseClaim) {
  const runId = "m3-a05-bridge-parity";
  const stageDagPacket = buildStageDagPacket({
    stageOrder: ["Execution", "Review"],
    stageLanes: { Execution: [bridgeLane()], Review: [] },
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
        taskPacketId: "claim-worker",
        ownerAgent: "test-automator",
        description: "Observe lease claim shadow parity",
        output: "lease claim shadow parity observed",
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
      schedulerAuthorityReuseShadow: {},
      ...(withLeaseClaim ? { leaseClaimAuthorityShadow: {} } : {}),
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
    const resume = kernel.resumeRun({ runId, graphDigest: stageDagPacket.graphDigest, taskFingerprint });
    return {
      result,
      stageDagPacket,
      projection,
      resume,
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
    };
  } finally {
    kernel.close();
  }
}

test("74 — bridge A/B and valid adapter preserve durable truth and enforce same-head/time authority", async () => {
  const baseline = await bridgeVariant(false);
  const enabled = await bridgeVariant(true);
  assert.equal(Object.hasOwn(baseline.result, "leaseClaimAuthorityProjection"), false);
  assert.equal(Object.hasOwn(enabled.result, "leaseClaimAuthorityProjection"), true);
  assert.deepEqual(enabled.legacy, baseline.legacy);
  assert.equal(JSON.stringify(enabled.events).includes("leaseClaimAuthority"), false);
  assert.equal(JSON.stringify(enabled.projection).includes("leaseClaimAuthority"), false);

  const shadow = enabled.result.leaseClaimAuthorityProjection;
  assert.equal(shadow.evaluationStatus, "evaluated");
  assert.equal(shadow.disposition, "observed");
  assert.equal(shadow.result.coordinatorObservation.state, "not_exposed_by_current_snapshot");
  assert.ok(Object.values(shadow.result.authorization).every((value) => value === false));
  assert.equal(recursiveKeys(shadow.result).includes("trustedObservedAtMs"), false);
  assert.deepEqual(shadow.result.claimObservations.map((item) => item.nodeId), enabled.stageDagPacket.nodes.map((node) => node.nodeId).sort());

  const options = {
    authoritativeStageDagPacket: enabled.stageDagPacket,
    authoritativeExecutionSnapshot: {
      durableRunProjection: enabled.projection,
      durableResume: enabled.resume,
    },
    schedulerAuthorityReuseShadowProjection: enabled.result.schedulerAuthorityReuseShadowProjection,
    trustedObservationContext: {
      source: "stage_runner_bridge_wall_clock_capture",
      observedAtMs: 1_000,
    },
  };
  const direct = buildLeaseClaimAuthorityShadowProjection({}, options);
  assert.equal(direct.evaluationStatus, "evaluated");
  assert.equal(direct.disposition, "observed");

  const stale = structuredClone(options);
  stale.authoritativeExecutionSnapshot.durableResume.cursor += 1;
  const staleProjection = buildLeaseClaimAuthorityShadowProjection({}, stale);
  assert.equal(staleProjection.disposition, "in_doubt");
  assert.equal(staleProjection.result.authorityBinding.currentness, "unproven");
  assert.equal(staleProjection.result.authorization.claimAllowed, false);
  const wrongTimeSource = structuredClone(options);
  wrongTimeSource.trustedObservationContext.source = "caller_clock";
  assert.equal(buildLeaseClaimAuthorityShadowProjection({}, wrongTimeSource).result, null);
  for (const observedAtMs of [-1, 1.5, "1000", Number.MAX_SAFE_INTEGER + 1]) {
    const invalidTime = structuredClone(options);
    invalidTime.trustedObservationContext.observedAtMs = observedAtMs;
    assert.equal(buildLeaseClaimAuthorityShadowProjection({}, invalidTime).result, null);
  }
});

test("74 — new source rejects the legacy projection schema, API, raw retention, and Domain crypto", () => {
  const domainPath = "src/domain/claims/lease-claim-authority-shadow.mjs";
  const adapterPath = "scripts/governed-execution/lease-claim-authority-shadow-adapter.mjs";
  assert.equal(existsSync("config/contracts/lease-claim-authority-projection-contract.json"), false);
  assert.equal(existsSync("src/domain/claims/lease-claim-authority-projection.mjs"), false);
  const domain = readFileSync(domainPath, "utf8");
  const adapter = readFileSync(adapterPath, "utf8");
  for (const source of [domain, adapter]) {
    assert.doesNotMatch(source, /lease-claim-authority-projection-v1|buildLeaseClaimAuthorityProjectionResult/u);
    assert.doesNotMatch(source, /\b(?:projectRun|resumeRun|claimNode|heartbeatNode|claimRunCoordinator|heartbeatRunCoordinator|releaseRunCoordinator|completeNode|failNode|prepareEffect|markEffectDispatchStarted|markUnresolvedEffectsInDoubt|reconcileEffect|reuseCompletedEffect|appendEvent|setRunTerminalStatus|selectMaximalSafeReadySet|executeNativeReadySet|executeLangGraphReadySet|setInterval)\s*\(/u);
    assert.doesNotMatch(source, /\b(?:TaskCreate|TaskUpdate|TodoWrite)\b/u);
  }
  assert.doesNotMatch(domain, /node:crypto|createHash/u);
  assert.doesNotMatch(domain, /claimLeaseSnapshot|schedulerPlanBinding/u);
  const bridge = readFileSync("scripts/governed-execution/stage-runner-bridge.mjs", "utf8");
  const a05Block = bridge.slice(
    bridge.indexOf("let leaseClaimExecutionSnapshot"),
    bridge.indexOf("let runtimeHealthRegistryBinding", bridge.indexOf("let leaseClaimExecutionSnapshot")),
  );
  assert.equal((a05Block.match(/Date\.now\s*\(/gu) ?? []).length, 1);
  assert.doesNotMatch(a05Block, /\b(?:claimNode|heartbeatNode|claimRunCoordinator|heartbeatRunCoordinator|releaseRunCoordinator|completeNode|failNode|prepareEffect|appendEvent|setRunTerminalStatus|selectMaximalSafeReadySet|executeNativeReadySet|executeLangGraphReadySet)\s*\(/u);
});

test("74 — machine contract freezes exact scheme 1 and defers A06", () => {
  const contract = JSON.parse(readFileSync("config/contracts/lease-claim-authority-shadow-contract.json", "utf8"));
  assert.equal(contract.domainContract.api, "evaluateLeaseClaimAuthorityShadow(command)");
  assert.deepEqual(contract.domainContract.commandExactFields, [
    "binding", "authoritySnapshot", "claimRecords", "coordinatorObservation",
  ]);
  assert.equal(contract.authoritySnapshot.exactFields.length, 21);
  assert.equal(contract.resultSchema.claimObservations.stateValues.length, 5);
  assert.deepEqual(contract.resultSchema.disposition.stateValues, ["observed", "wait", "terminal", "in_doubt"]);
  assert.deepEqual(contract.resultSchema.authorization.exactFields, AUTHORIZATION_FIELDS);
  assert.equal(contract.acceptance.rawFenceExpiryOwnerAttemptAndObservedAtNotRetained, true);
  assert.equal(contract.acceptance.m3A06NotStarted, true);
});
