import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { buildRuntimeHealthProjection } from "../../scripts/governed-execution/runtime-health-projection-adapter.mjs";
import { openDurableRunKernel } from "../../scripts/governed-execution/durable-run-kernel.mjs";
import { executeNativeReadySet } from "../../scripts/governed-execution/ready-set-adapters.mjs";
import { runStageRunnerBridge } from "../../scripts/governed-execution/stage-runner-bridge.mjs";
import { buildStageDagPacket } from "../../scripts/governed-execution/stage-dag.mjs";
import {
  RUNTIME_HEALTH_DISPOSITIONS,
  RUNTIME_HEALTH_PROJECTION_SCHEMA_VERSION,
  RUNTIME_HEALTH_STATUSES,
  assertValidRuntimeHealthProjectionResult,
  evaluateRuntimeHealthProjection,
} from "../../src/domain/runtime/runtime-health-projection.mjs";

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

const HEALTH_STATUSES = [
  "responsive_at_observation",
  "unresponsive_at_observation_deadline",
  "unavailable_at_observation",
  "failed_at_observation",
  "not_observed",
  "in_doubt",
];

const DISPOSITIONS = ["observed", "degraded", "not_observed", "in_doubt"];

const AUTHORIZATION_FIELDS = [
  "currentLivenessClaimAllowed",
  "schedulerDispatchAllowed",
  "executionAllowed",
  "claimAllowed",
  "takeoverAllowed",
  "heartbeatAllowed",
  "releaseAllowed",
  "coordinatorMutationAllowed",
  "nodeMutationAllowed",
  "leaseMutationAllowed",
  "fenceMutationAllowed",
  "retryAllowed",
  "quotaMutationAllowed",
  "quotaConsumptionAllowed",
  "eventPersistenceAllowed",
  "cursorAdvanceAllowed",
  "checkpointMutationAllowed",
  "completeNodeAllowed",
  "terminalStatusWriteAllowed",
  "legacyGateCutoverAllowed",
  "authoritativeWriteAllowed",
];

const EXCLUDED_SIGNAL_NAMES = [
  "leaseClaimHeartbeat",
  "openClawScheduledHeartbeat",
  "presenceProbe",
  "installOrConfigPresence",
  "persistedCapabilityAcceptance",
];

function registry({ runtimeId = "codex", runtimeMode = "native_cli" } = {}) {
  const core = {
    runtimeId,
    runtimeMode,
    catalogDigest: digest(`catalog:${runtimeId}`),
    capabilityMatrixDigest: digest(`capability-matrix:${runtimeId}`),
    evidenceLedgerDigest: digest(`evidence-ledger:${runtimeId}`),
  };
  return { ...core, registryDigest: digest(core) };
}

function binding(runtimeRegistryBinding, overrides = {}) {
  return {
    runId: "run:m3-a06",
    taskFingerprint: digest("task:m3-a06"),
    graphDigest: digest("graph:m3-a06"),
    projectionDigest: digest("projection:m3-a06"),
    durableCursor: 8,
    headEventHash: digest("event:m3-a06"),
    headCheckpointId: "checkpoint:m3-a06",
    runtimeRegistryDigest: runtimeRegistryBinding.registryDigest,
    policyDigest: digest("policy:m3-a06"),
    evaluationRevision: 0,
    ...overrides,
  };
}

function observation({
  runtimeId = "codex",
  runtimeMode = "native_cli",
  source = "stage_runner_bridge_native_invocation",
  currentRun = true,
  nativeInvocationObserved = true,
  invocationStatus = "pass",
  failureClass = "none",
  startedAt = 1_000,
  endedAt = 1_001,
  observedAt = 1_002,
  evidenceRefDigest = digest(`runtime-evidence:${runtimeId}`),
} = {}) {
  const core = {
    source,
    runtimeId,
    runtimeMode,
    currentRun,
    nativeInvocationObserved,
    invocationStatus,
    failureClass,
    startedAt,
    endedAt,
    observedAt,
    evidenceRefDigest,
  };
  return { ...core, observationDigest: digest(core) };
}

function excludedSignals(overrides = {}) {
  return Object.fromEntries(EXCLUDED_SIGNAL_NAMES.map((name) => {
    const present = overrides[name] === true;
    return [name, {
      present,
      evidenceDigest: present ? digest(`excluded:${name}`) : null,
      provesRuntimeHealth: false,
    }];
  }));
}

function command({
  runtimeId = "codex",
  runtimeMode = "native_cli",
  observationOverrides = {},
  bindingOverrides = {},
  excludedOverrides = {},
  registryOverrides = {},
} = {}) {
  const runtimeRegistryBinding = registry({ runtimeId, runtimeMode, ...registryOverrides });
  return {
    binding: binding(runtimeRegistryBinding, bindingOverrides),
    runtimeRegistryBinding,
    trustedObservation: observation({ runtimeId, runtimeMode, ...observationOverrides }),
    excludedSignalContext: excludedSignals(excludedOverrides),
  };
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

test("75 — frozen exports and a trusted native pass produce only a point-in-time responsive observation", () => {
  assert.equal(RUNTIME_HEALTH_PROJECTION_SCHEMA_VERSION, "runtime-health-projection-v1");
  assert.deepEqual(RUNTIME_HEALTH_STATUSES, HEALTH_STATUSES);
  assert.deepEqual(RUNTIME_HEALTH_DISPOSITIONS, DISPOSITIONS);
  const result = evaluateRuntimeHealthProjection(command());
  assert.equal(result.schemaVersion, "runtime-health-projection-v1");
  assert.equal(result.kind, "runtime_health_projection_result");
  assert.equal(result.health.status, "responsive_at_observation");
  assert.equal(result.health.lastSeenAt, 1_001);
  assert.equal(result.health.temporalScope, "point_in_time_observation_only");
  assert.equal(
    result.runtimeObservation.lastSeenAtBindingDigest,
    digest({
      observationDigest: result.runtimeObservation.observationDigest,
      lastSeenAt: result.health.lastSeenAt,
    }),
  );
  assert.equal(result.health.currentLivenessClaimed, false);
  assert.equal(result.health.projectionOnly, true);
  assert.equal(result.health.authoritative, false);
  assert.equal(result.disposition.state, "observed");
  assertValidRuntimeHealthProjectionResult(result);
});

test("75 — all six statuses and all four dispositions follow the frozen mapping", () => {
  const fixtures = [
    [{}, "responsive_at_observation", "observed"],
    [{ invocationStatus: "timeout", failureClass: "runtime_safety_timeout" }, "unresponsive_at_observation_deadline", "degraded"],
    [{ invocationStatus: "launch_failed", failureClass: "runtime_launch_failed" }, "unavailable_at_observation", "degraded"],
    [{ invocationStatus: "nonzero_exit", failureClass: "runtime_nonzero_exit" }, "failed_at_observation", "degraded"],
    [{
      source: "none",
      nativeInvocationObserved: false,
      invocationStatus: "not_invoked",
      failureClass: "not_applicable",
      startedAt: null,
      endedAt: null,
      observedAt: null,
      evidenceRefDigest: null,
    }, "not_observed", "not_observed"],
    [{ invocationStatus: "conflict", failureClass: "unknown" }, "in_doubt", "in_doubt"],
  ];
  const seenStatuses = new Set();
  const seenDispositions = new Set();
  for (const [observationOverrides, status, disposition] of fixtures) {
    const result = evaluateRuntimeHealthProjection(command({ observationOverrides }));
    assert.equal(result.health.status, status);
    assert.equal(result.disposition.state, disposition);
    seenStatuses.add(result.health.status);
    seenDispositions.add(result.disposition.state);
  }
  assert.deepEqual([...seenStatuses], HEALTH_STATUSES);
  assert.deepEqual([...seenDispositions], DISPOSITIONS);
});

test("75 — every settled failure class maps consistently and never authorizes retry", () => {
  for (const [invocationStatus, failureClass, expected] of [
    ["parse_failed", "runtime_parse_failed", "failed_at_observation"],
    ["output_limit", "runtime_output_limit", "failed_at_observation"],
    ["nonzero_exit", "runtime_nonzero_exit", "failed_at_observation"],
    ["final_message_missing", "final_message_missing", "failed_at_observation"],
  ]) {
    const result = evaluateRuntimeHealthProjection(command({
      observationOverrides: { invocationStatus, failureClass },
    }));
    assert.equal(result.health.status, expected);
    assert.equal(result.disposition.state, "degraded");
    assert.equal(result.authorization.retryAllowed, false);
    assert.equal(result.authorization.executionAllowed, false);
  }
});

test("75 — compatibility and injected-callback modes stay not_observed for Cursor/OpenClaw-style projections", () => {
  for (const fixture of [
    { runtimeId: "cursor", runtimeMode: "compatibility_projection", failureClass: "not_applicable" },
    { runtimeId: "openclaw", runtimeMode: "compatibility_projection", failureClass: "not_applicable" },
    { runtimeId: "codex", runtimeMode: "injected_callback", failureClass: "injected_callback" },
  ]) {
    const result = evaluateRuntimeHealthProjection(command({
      runtimeId: fixture.runtimeId,
      runtimeMode: fixture.runtimeMode,
      observationOverrides: {
        source: "none",
        nativeInvocationObserved: false,
        invocationStatus: "not_invoked",
        failureClass: fixture.failureClass,
        startedAt: null,
        endedAt: null,
        observedAt: null,
        evidenceRefDigest: null,
      },
    }));
    assert.equal(result.health.status, "not_observed");
    assert.equal(result.health.lastSeenAt, null);
    assert.equal(result.health.currentLivenessClaimed, false);
  }
});

test("75 — excluded heartbeats, presence, install, and acceptance signals never become health authority", () => {
  const result = evaluateRuntimeHealthProjection(command({
    runtimeId: "openclaw",
    runtimeMode: "compatibility_projection",
    observationOverrides: {
      source: "none",
      nativeInvocationObserved: false,
      invocationStatus: "not_invoked",
      failureClass: "not_applicable",
      startedAt: null,
      endedAt: null,
      observedAt: null,
      evidenceRefDigest: null,
    },
    excludedOverrides: Object.fromEntries(EXCLUDED_SIGNAL_NAMES.map((name) => [name, true])),
  }));
  assert.equal(result.health.status, "not_observed");
  assert.ok(result.health.reasonCodes.includes("excluded_signals_not_health_authority"));
  for (const signal of Object.values(result.excludedSignals)) {
    assert.equal(signal.present, true);
    assert.equal(signal.provesRuntimeHealth, false);
  }
  assert.equal(result.authorization.heartbeatAllowed, false);
});

test("75 — cross-runtime, replay, future, and internally conflicting observations fail closed", () => {
  const crossRuntime = command();
  crossRuntime.trustedObservation.runtimeId = "claude";
  crossRuntime.trustedObservation.observationDigest = digest(Object.fromEntries(
    Object.entries(crossRuntime.trustedObservation).filter(([key]) => key !== "observationDigest"),
  ));
  const replay = command({ observationOverrides: { currentRun: false } });
  const future = command({
    observationOverrides: {
      startedAt: 1_000,
      endedAt: 1_003,
      observedAt: 1_002,
    },
  });
  const conflict = command({
    observationOverrides: { invocationStatus: "pass", failureClass: "runtime_nonzero_exit" },
  });
  for (const fixture of [crossRuntime, replay, future, conflict]) {
    const result = evaluateRuntimeHealthProjection(fixture);
    assert.equal(result.health.status, "in_doubt");
    assert.equal(result.disposition.state, "in_doubt");
    assert.equal(result.health.currentLivenessClaimed, false);
    assert.ok(Object.values(result.authorization).every((value) => value === false));
  }
});

test("75 — results are deterministic, deeply frozen, and all exact 21 permissions are false", () => {
  const first = evaluateRuntimeHealthProjection(command());
  const second = evaluateRuntimeHealthProjection(command());
  assert.deepEqual(first, second);
  assertDeepFrozen(first);
  assert.deepEqual(Object.keys(first.authorization), AUTHORIZATION_FIELDS);
  assert.ok(Object.values(first.authorization).every((value) => value === false));
  const forged = structuredClone(first);
  forged.authorization.quotaConsumptionAllowed = true;
  assert.throws(() => assertValidRuntimeHealthProjectionResult(forged));
});

test("75 — validator rejects forged responsive health even after intent digest recomputation", () => {
  const forged = structuredClone(evaluateRuntimeHealthProjection(command()));
  forged.runtimeObservation = {
    ...forged.runtimeObservation,
    source: "none",
    currentRun: false,
    nativeInvocationObserved: false,
    invocationStatus: "not_invoked",
    failureClass: "not_applicable",
    evidenceRefDigest: null,
  };
  forged.eventIntents[0].intentDigest = digest({
    bindingDigest: forged.bindingDigest,
    runtimeObservation: forged.runtimeObservation,
    health: forged.health,
    excludedSignals: forged.excludedSignals,
    disposition: forged.disposition,
  });
  assert.throws(
    () => assertValidRuntimeHealthProjectionResult(forged),
    /observed health contradicts runtime observation/u,
  );
});

test("75 — changing lastSeenAt and recomputing the event intent cannot forge observation time", () => {
  const forged = structuredClone(evaluateRuntimeHealthProjection(command()));
  forged.health.lastSeenAt += 1;
  forged.eventIntents[0].intentDigest = digest({
    bindingDigest: forged.bindingDigest,
    runtimeObservation: forged.runtimeObservation,
    health: forged.health,
    excludedSignals: forged.excludedSignals,
    disposition: forged.disposition,
  });
  assert.throws(
    () => assertValidRuntimeHealthProjectionResult(forged),
    /last-seen binding is invalid/u,
  );
});

test("75 — raw invocation fields are sanitized and malformed or secret-like commands fail closed", () => {
  const result = evaluateRuntimeHealthProjection(command());
  const keys = recursiveKeys(result);
  for (const forbidden of ["startedAt", "endedAt", "rawOutput", "stdout", "stderr", "sessionId", "messageId"]) {
    assert.equal(keys.includes(forbidden), false, forbidden);
  }
  assert.equal(result.health.lastSeenAt, 1_001);

  const unknown = { ...command(), rawOutput: "secret" };
  assert.throws(() => evaluateRuntimeHealthProjection(unknown));
  const accessor = command();
  Object.defineProperty(accessor.binding, "runId", { enumerable: true, get: () => "run:forged" });
  assert.throws(() => evaluateRuntimeHealthProjection(accessor));
  const secret = command({
    observationOverrides: { runtimeId: "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789" },
  });
  assert.throws(() => evaluateRuntimeHealthProjection(secret));
  for (const shortCredential of ["sk-live-x", "api-key-x", "provider-access-token-x"]) {
    let rejectedError = null;
    let rejectedResult = null;
    try {
      rejectedResult = evaluateRuntimeHealthProjection(command({
        observationOverrides: { runtimeId: shortCredential },
      }));
    } catch (error) {
      rejectedError = error;
    }
    assert.equal(rejectedResult, null);
    assert.ok(rejectedError instanceof TypeError);
    assert.equal(
      JSON.stringify({ result: rejectedResult, error: String(rejectedError) }).includes(shortCredential),
      false,
      "rejected credentials must not echo through an error or result",
    );
  }
});

test("75 — adapter missing and invalid inputs are bounded, sanitized, and non-authorizing", () => {
  for (const input of [null, undefined, { trustedObservation: {} }, { quota: 1 }]) {
    const envelope = buildRuntimeHealthProjection(input, {});
    assert.match(envelope.evaluationStatus, /^not_evaluated_/u);
    assert.equal(envelope.disposition, "in_doubt");
    assert.equal(envelope.result, null);
    assert.deepEqual(Object.keys(envelope.authority), [
      "projectsRuntimeHealth",
      "claimsCurrentLiveness",
      "writesKernel",
      "writesEvents",
      "dispatchesRuntime",
      "claimsNode",
      "takesOverClaim",
      "retriesRuntime",
      "consumesQuota",
      "mutatesQuota",
      "projectionOnly",
    ]);
    assert.ok(Object.entries(envelope.authority).every(([key, value]) => value === (key === "projectionOnly")));
  }
});

function bridgeLane() {
  return {
    laneId: "health-worker",
    laneKind: "execution_worker",
    ownerBindingRef: "owner:health-worker",
    capabilityBindingRef: "capability:health-worker",
    dependsOn: [],
    effectClass: "read_only_worker",
    resourceScopes: ["file:package.json"],
    isolation: "shared_read_only",
    status: "planned_not_invoked",
  };
}

function bridgeAssessment(state) {
  const core = { state, evidenceRefs: [] };
  return { ...core, assessmentDigest: digest(core) };
}

function bridgeEvidenceTransitionInput() {
  return {
    policyDigest: digest("bridge-policy:a06"),
    evidenceClaims: [{
      claimId: "claim:bridge-a06",
      producerRef: "producer:bridge-a06",
      evidenceType: "test_result",
      subjectRef: "subject:bridge-a06",
      payloadDigest: digest("bridge-payload:a06"),
    }],
    validatorAssessments: [{
      claimId: "claim:bridge-a06",
      validatorRef: "validator:bridge-a06",
      assessment: "verified",
      assessmentDigest: digest("bridge-assessment:a06"),
      reasonCode: "independent_check_passed",
    }],
    decisionDependencies: [],
    transitionRequest: {
      proposalId: "proposal:bridge-a06",
      fromStage: "execution",
      toStage: "review",
      requiredClaimIds: ["claim:bridge-a06"],
    },
  };
}

function bridgeContinuationInput() {
  const controlCore = { state: "none", controlRef: null, evidenceRefs: [] };
  return {
    policyDigest: digest("bridge-policy:a06"),
    evaluationRevision: 0,
    goalAssessment: bridgeAssessment("unfinished"),
    workAssessment: bridgeAssessment("executable_candidate_present"),
    evidenceAssessment: bridgeAssessment("new_valid_evidence_expected"),
    blockerAssessment: bridgeAssessment("none"),
    humanDecisionAssessment: bridgeAssessment("not_required"),
    scopeAssessment: bridgeAssessment("inside"),
    repeatAssessment: bridgeAssessment("novel"),
    controlAssessment: { ...controlCore, assessmentDigest: digest(controlCore) },
  };
}

async function bridgeVariant(withRuntimeHealth) {
  const runId = "m3-a06-bridge-parity";
  const stageDagPacket = buildStageDagPacket({
    stageOrder: ["Execution", "Review"],
    stageLanes: { Execution: [bridgeLane()], Review: [] },
    runtimeCapacity: 1,
  });
  const taskFingerprint = `task:${runId}`;
  const kernel = await openDurableRunKernel();
  let invocationCount = 0;
  try {
    const result = await runStageRunnerBridge({
      runId,
      runtime: "codex",
      stageDagPacket,
      workerTaskPackets: [{
        taskPacketId: "health-worker",
        ownerAgent: "test-automator",
        description: "Observe runtime health projection parity",
        output: "runtime health projection parity observed",
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
      evidenceTransitionShadow: bridgeEvidenceTransitionInput(),
      continuationPolicyShadow: bridgeContinuationInput(),
      todoDependencySafeProgressShadow: {},
      schedulerAuthorityReuseShadow: {},
      leaseClaimAuthorityShadow: {},
      ...(withRuntimeHealth ? { runtimeHealthProjection: {} } : {}),
      evidenceKind: "test_double",
      invokeWorker: async ({ runtime }) => {
        invocationCount += 1;
        return {
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
        };
      },
    });
    const projection = kernel.projectRun(runId);
    const events = kernel.getEvents(runId);
    const resume = kernel.resumeRun({ runId, graphDigest: stageDagPacket.graphDigest, taskFingerprint });
    return {
      result,
      projection,
      events,
      resume,
      invocationCount,
      legacy: {
        status: result.status,
        nodeRecords: result.nodeRecords.map(({ nodeId, status, outputSha256, failureClass }) => ({
          nodeId, status, outputSha256: outputSha256 ?? null, failureClass: failureClass ?? null,
        })),
        workerResults: result.workerResults.map(({ status, outputSha256, rawOutputSha256 }) => ({
          status, outputSha256, rawOutputSha256,
        })),
        eventTypes: events.map((event) => event.eventType),
        cursor: projection.cursor,
        checkpointIds: projection.completedNodes.map((record) => record.checkpointId),
        completedNodeIds: projection.completedNodes.map((record) => record.nodeId),
        activeClaims: resume.activeClaims,
        blockingEffects: resume.blockingEffects,
      },
    };
  } finally {
    kernel.close();
  }
}

test("75 — bridge runtime-health opt-in is projection-only and preserves all durable execution truth", async () => {
  const baseline = await bridgeVariant(false);
  const enabled = await bridgeVariant(true);

  assert.equal(Object.hasOwn(baseline.result, "runtimeHealthProjection"), false);
  assert.equal(Object.hasOwn(enabled.result, "runtimeHealthProjection"), true);
  assert.deepEqual(enabled.legacy, baseline.legacy);
  assert.equal(baseline.invocationCount, 1);
  assert.equal(enabled.invocationCount, 1, "health projection must not cause a second worker execution");
  assert.equal(enabled.invocationCount, enabled.result.workerResults.length);
  assert.equal(JSON.stringify(enabled.events).includes("runtimeHealth"), false);
  assert.equal(JSON.stringify(enabled.projection).includes("runtimeHealth"), false);

  const health = enabled.result.runtimeHealthProjection;
  assert.equal(health.evaluationStatus, "evaluated");
  assert.equal(health.result.health.status, "not_observed");
  assert.equal(health.result.runtimeObservation.runtimeMode, "injected_callback");
  assert.equal(health.result.authorization.executionAllowed, false);
  assert.equal(health.authority.dispatchesRuntime, false);
  assert.equal(health.authority.projectionOnly, true);
});

test("75 — native-mode durable resume with zero current-run attempts stays not_observed", async () => {
  const runId = "m3-a06-native-resume-zero-attempts";
  const taskFingerprint = `task:${runId}`;
  const stageDagPacket = buildStageDagPacket({
    stageOrder: ["Execution", "Review"],
    stageLanes: { Execution: [bridgeLane()], Review: [] },
    runtimeCapacity: 1,
  });
  const workerTaskPackets = [{
    taskPacketId: "health-worker",
    ownerAgent: "test-automator",
    description: "Settle the durable node before native resume",
    output: "durable node settled",
    dependsOn: [],
    executionMode: "primary_execution",
    externalWriteBoundary: false,
  }];
  const kernel = await openDurableRunKernel();
  let resumeReadySetCalls = 0;
  try {
    const first = await runStageRunnerBridge({
      runId,
      runtime: "codex",
      stageDagPacket,
      workerTaskPackets,
      workspaceRoot: process.cwd(),
      durable: {
        enabled: true,
        kernel,
        mode: "create",
        taskFingerprint,
        ownerId: `owner:${runId}:create`,
        leaseMs: 10_000,
      },
      evidenceKind: "test_double",
      invokeWorker: async ({ runtime }) => ({
        status: "pass",
        runtime,
        exitCode: 0,
        startedAt: "2026-08-11T00:00:00.000Z",
        endedAt: "2026-08-11T00:00:00.001Z",
        durationMs: 1,
        outputText: "settled",
        outputSha256: "c".repeat(64),
        rawOutputSha256: "d".repeat(64),
        hostEventCount: 1,
        toolEventCount: 1,
        stderrTail: "",
      }),
    });
    assert.equal(first.status, "pass");

    const resumed = await runStageRunnerBridge({
      runId,
      runtime: "codex",
      stageDagPacket,
      workerTaskPackets,
      workspaceRoot: process.cwd(),
      durable: {
        enabled: true,
        kernel,
        mode: "resume",
        taskFingerprint,
        ownerId: `owner:${runId}:resume`,
        leaseMs: 10_000,
      },
      evidenceTransitionShadow: bridgeEvidenceTransitionInput(),
      continuationPolicyShadow: bridgeContinuationInput(),
      todoDependencySafeProgressShadow: {},
      schedulerAuthorityReuseShadow: {},
      leaseClaimAuthorityShadow: {},
      runtimeHealthProjection: {},
      executeReadySet: async () => {
        resumeReadySetCalls += 1;
        throw new Error("completed durable nodes must not reach a runtime adapter");
      },
    });

    assert.equal(resumed.status, "pass");
    assert.equal(resumeReadySetCalls, 0);
    assert.equal(resumed.workerResults.length, 1, "resume may project prior output without a current invocation");
    const observation = resumed.runtimeHealthProjection.result.runtimeObservation;
    assert.equal(observation.runtimeMode, "native_cli");
    assert.equal(observation.nativeInvocationObserved, false);
    assert.equal(observation.invocationStatus, "not_invoked");
    assert.equal(resumed.runtimeHealthProjection.result.health.status, "not_observed");
  } finally {
    kernel.close();
  }
});

test("75 — native-mode preflight rejection records zero attempts and cannot become health", async () => {
  const runId = "m3-a06-native-preflight-zero-attempts";
  const taskFingerprint = `task:${runId}`;
  const stageDagPacket = buildStageDagPacket({
    stageOrder: ["Execution", "Review"],
    stageLanes: { Execution: [bridgeLane()], Review: [] },
    runtimeCapacity: 1,
  });
  const kernel = await openDurableRunKernel();
  let readySetCalls = 0;
  try {
    const result = await runStageRunnerBridge({
      runId,
      runtime: "codex",
      stageDagPacket,
      workerTaskPackets: [{
        taskPacketId: "health-worker",
        ownerAgent: "test-automator",
        description: "Reject side-effect work before runtime invocation",
        output: "must remain unexecuted",
        dependsOn: [],
        executionMode: "primary_execution",
        externalWriteBoundary: true,
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
      evidenceTransitionShadow: bridgeEvidenceTransitionInput(),
      continuationPolicyShadow: bridgeContinuationInput(),
      todoDependencySafeProgressShadow: {},
      schedulerAuthorityReuseShadow: {},
      leaseClaimAuthorityShadow: {},
      runtimeHealthProjection: {},
      timeoutMs: 1_000,
      readySetTimeoutMs: 1_000,
      executeReadySet: async (options) => {
        readySetCalls += 1;
        return executeNativeReadySet(options);
      },
    });

    assert.equal(result.status, "failed");
    assert.equal(result.failure.failureClass, "read_only_bridge_rejected_side_effect_task");
    assert.equal(readySetCalls, 1, "the local ready-set controller may run once");
    assert.equal(result.workerResults.length, 0);
    assert.equal(result.runtimeHealthProjection.evaluationStatus, "not_evaluated_invalid_normalized_input");
    assert.equal(result.runtimeHealthProjection.disposition, "in_doubt");
    assert.equal(result.runtimeHealthProjection.result, null);
    assert.equal(result.runtimeHealthProjection.authority.dispatchesRuntime, false);
    assert.equal(result.runtimeHealthProjection.authority.claimsCurrentLiveness, false);
  } finally {
    kernel.close();
  }
});

test("75 — source boundaries forbid a second heartbeat, lease, scheduler, durable, or quota authority", () => {
  const domainPath = "src/domain/runtime/runtime-health-projection.mjs";
  const adapterPath = "scripts/governed-execution/runtime-health-projection-adapter.mjs";
  assert.equal(existsSync(domainPath), true);
  assert.equal(existsSync(adapterPath), true);
  const domain = readFileSync(domainPath, "utf8");
  const adapter = readFileSync(adapterPath, "utf8");
  const forbiddenCall = /\b(?:projectRun|resumeRun|claimNode|heartbeatNode|claimRunCoordinator|heartbeatRunCoordinator|releaseRunCoordinator|completeNode|failNode|prepareEffect|markEffectDispatchStarted|markUnresolvedEffectsInDoubt|reconcileEffect|reuseCompletedEffect|appendEvent|setRunTerminalStatus|selectMaximalSafeReadySet|executeNativeReadySet|executeLangGraphReadySet|consumeQuota|mutateQuota|reserveQuota|setInterval)\s*\(/u;
  for (const source of [domain, adapter]) {
    assert.doesNotMatch(source, forbiddenCall);
    assert.doesNotMatch(source, /\b(?:TaskCreate|TaskUpdate|TodoWrite)\b/u);
  }
  assert.doesNotMatch(domain, /\b(?:Date\.now|Date\.parse)\s*\(/u);
  assert.doesNotMatch(domain, /node:(?:fs|crypto|net|http|https)|from\s+["'][^"']*(?:durable-run-kernel|stage-dag|ready-set)/u);
});

test("75 — machine contract freezes the exact A06 scheme and keeps A07 quota out", () => {
  const contract = JSON.parse(readFileSync("config/contracts/runtime-health-projection-contract.json", "utf8"));
  assert.equal(contract.domainContract.api, "evaluateRuntimeHealthProjection(command)");
  assert.deepEqual(contract.domainContract.commandExactFields, [
    "binding", "runtimeRegistryBinding", "trustedObservation", "excludedSignalContext",
  ]);
  assert.deepEqual(contract.trustedObservation.exactFields, [
    "source", "runtimeId", "runtimeMode", "currentRun", "nativeInvocationObserved",
    "invocationStatus", "failureClass", "startedAt", "endedAt", "observedAt",
    "evidenceRefDigest", "observationDigest",
  ]);
  assert.deepEqual(contract.statusModel.values, HEALTH_STATUSES);
  assert.deepEqual(contract.resultSchema.exactTopLevelFields, [
    "schemaVersion", "kind", "binding", "bindingDigest", "runtimeObservation",
    "health", "excludedSignals", "disposition", "eventIntents", "authorization",
  ]);
  assert.deepEqual(contract.resultSchema.runtimeObservationExactFields, [
    "source", "runtimeId", "runtimeMode", "currentRun", "nativeInvocationObserved",
    "invocationStatus", "failureClass", "evidenceRefDigest", "observationDigest",
    "lastSeenAtBindingDigest",
  ]);
  assert.match(contract.resultSchema.lastSeenAtBindingDigestRule, /internal-consistency binding only/u);
  assert.deepEqual(contract.resultSchema.authorization.exactFields, AUTHORIZATION_FIELDS);
  assert.equal(contract.resultSchema.authorization.exactFields.length, 21);
  assert.equal(contract.bridgeAuthorityRules.observedAtCapturedExactlyOnce, true);
  assert.equal(contract.bridgeAuthorityRules.consumesOrMutatesQuota, false);
  assert.equal(contract.acceptance.m3A07NotStarted, true);
  assert.ok(contract.nonGoals.includes("M3-A07 execution"));
});
