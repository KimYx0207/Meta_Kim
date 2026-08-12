import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildContinuationPolicyShadowProjection } from "../../scripts/governed-execution/continuation-policy-shadow-adapter.mjs";
import { buildEvidenceTransitionShadowProjection } from "../../scripts/governed-execution/evidence-transition-shadow-adapter.mjs";
import { openDurableRunKernel } from "../../scripts/governed-execution/durable-run-kernel.mjs";
import { runStageRunnerBridge } from "../../scripts/governed-execution/stage-runner-bridge.mjs";
import { buildStageDagPacket } from "../../scripts/governed-execution/stage-dag.mjs";
import {
  assertValidContinuationPolicyShadowResult,
  CONTINUATION_POLICY_SHADOW_DISPOSITIONS,
  evaluateContinuationPolicyShadow,
} from "../../src/domain/continuation/continuation-policy-shadow.mjs";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

const DIGEST = Object.freeze({
  task: digest("task"),
  graph: digest("graph"),
  projection: digest("projection"),
  policy: digest("policy"),
  event: digest("event"),
  payload: digest("payload"),
});

function assessment(state, evidenceRefs = []) {
  const normalized = { state, evidenceRefs: [...evidenceRefs].sort() };
  return { ...normalized, assessmentDigest: digest(normalized) };
}

function controlAssessment(state = "none", controlRef = null, evidenceRefs = []) {
  const normalized = { state, controlRef, evidenceRefs: [...evidenceRefs].sort() };
  return { ...normalized, assessmentDigest: digest(normalized) };
}

function baseCommand(overrides = {}) {
  const authoritySnapshot = {
    source: "stage_runner_bridge_existing_authority_projection",
    projectionSchemaVersion: "durable-governed-run-projection-v0.1",
    runStatus: "active",
    runId: "run:m3-a02",
    taskFingerprint: DIGEST.task,
    graphDigest: DIGEST.graph,
    cursor: 4,
    headEventHash: DIGEST.event,
    headCheckpointId: "checkpoint:m3-a02",
    projectionDigest: DIGEST.projection,
    eventChainState: "verified",
    blockingEffectRefs: [],
    activeClaimRefs: [],
    bridgeSettlementState: "settled",
    currentness: "bound_same_bridge_settlement",
    ...overrides.authoritySnapshot,
  };
  const command = {
    binding: {
      runId: authoritySnapshot.runId,
      taskFingerprint: authoritySnapshot.taskFingerprint,
      graphDigest: authoritySnapshot.graphDigest,
      projectionDigest: authoritySnapshot.projectionDigest,
      durableCursor: authoritySnapshot.cursor,
      headEventHash: authoritySnapshot.headEventHash,
      headCheckpointId: authoritySnapshot.headCheckpointId,
      policyDigest: DIGEST.policy,
      evaluationRevision: 0,
      ...overrides.binding,
    },
    authoritySnapshot,
    goalAssessment: assessment("unfinished"),
    workAssessment: assessment("executable_candidate_present"),
    evidenceAssessment: assessment("new_valid_evidence_expected"),
    blockerAssessment: assessment("none"),
    humanDecisionAssessment: assessment("not_required"),
    scopeAssessment: assessment("inside"),
    repeatAssessment: assessment("novel"),
    controlAssessment: controlAssessment(),
    evidenceTransition: {
      schemaVersion: "evidence-transition-shadow-v1",
      resultDigest: digest("a01-result"),
      bindingDigest: digest("a01-binding"),
      evaluationStatus: "evaluated",
      verdict: "allowed",
    },
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (!["binding", "authoritySnapshot"].includes(key)) command[key] = value;
  }
  return command;
}

function a01Input({ assessmentState = "verified", runId = "run:m3-a02" } = {}) {
  return {
    binding: {
      runId,
      taskFingerprint: DIGEST.task,
      graphDigest: DIGEST.graph,
      nodeId: "stage:execution:merge",
      attemptId: "attempt:m3-a02:1",
      fenceToken: 1,
      revision: 0,
      policyDigest: DIGEST.policy,
    },
    evidenceClaims: [{
      claimId: "claim:m3-a02",
      producerRef: "producer:execution",
      evidenceType: "test_result",
      subjectRef: "subject:execution",
      payloadDigest: DIGEST.payload,
    }],
    validatorAssessments: [{
      claimId: "claim:m3-a02",
      validatorRef: "validator:independent",
      assessment: assessmentState,
      assessmentDigest: digest(`assessment:${assessmentState}`),
      reasonCode: `assessment_${assessmentState}`,
    }],
    decisionDependencies: [],
    transitionRequest: {
      proposalId: "proposal:execution-review",
      fromStage: "execution",
      toStage: "review",
      requiredClaimIds: ["claim:m3-a02"],
    },
  };
}

function a01Projection(options) {
  return buildEvidenceTransitionShadowProjection(a01Input(options));
}

function adapterInput(overrides = {}) {
  return {
    policyDigest: DIGEST.policy,
    evaluationRevision: 0,
    goalAssessment: assessment("unfinished"),
    workAssessment: assessment("executable_candidate_present"),
    evidenceAssessment: assessment("new_valid_evidence_expected"),
    blockerAssessment: assessment("none"),
    humanDecisionAssessment: assessment("not_required"),
    scopeAssessment: assessment("inside"),
    repeatAssessment: assessment("novel"),
    controlAssessment: controlAssessment(),
    ...overrides,
  };
}

function authoritySnapshot(overrides = {}) {
  return baseCommand({ authoritySnapshot: overrides }).authoritySnapshot;
}

function adapterProjection({ input = adapterInput(), authority = authoritySnapshot(), evidence = a01Projection() } = {}) {
  return buildContinuationPolicyShadowProjection(input, {
    authoritativeSnapshot: authority,
    evidenceTransitionShadowProjection: evidence,
  });
}

function assertDeepFrozen(value) {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

function bridgeDag() {
  return buildStageDagPacket({
    stageOrder: ["Execution", "Review"],
    stageLanes: {
      Execution: [{
        laneId: "continuation-worker",
        laneKind: "execution_worker",
        ownerBindingRef: "owner:test-worker",
        capabilityBindingRef: "capability:read-only-test",
        effectClass: "read_only_worker",
        resourceScopes: ["file:package.json"],
        isolation: "shared_read_only",
        status: "planned_not_invoked",
      }],
      Review: [],
    },
    runtimeCapacity: 1,
  });
}

function bridgePacket() {
  return {
    taskPacketId: "continuation-worker",
    ownerAgent: "test-automator",
    description: "Read package metadata",
    output: "observed package metadata",
    dependsOn: [],
    executionMode: "primary_execution",
    externalWriteBoundary: false,
  };
}

function bridgeEvidenceInput() {
  const input = a01Input();
  return {
    policyDigest: input.binding.policyDigest,
    evidenceClaims: input.evidenceClaims,
    validatorAssessments: input.validatorAssessments,
    decisionDependencies: input.decisionDependencies,
    transitionRequest: input.transitionRequest,
  };
}

async function runBridgeVariant({ runId, withContinuation }) {
  const kernel = await openDurableRunKernel();
  try {
    const result = await runStageRunnerBridge({
      runId,
      runtime: "codex",
      stageDagPacket: bridgeDag(),
      workerTaskPackets: [bridgePacket()],
      workspaceRoot: process.cwd(),
      durable: {
        enabled: true,
        kernel,
        mode: "create",
        taskFingerprint: `task:${runId}`,
        ownerId: `owner:${runId}`,
        leaseMs: 10_000,
      },
      evidenceTransitionShadow: bridgeEvidenceInput(),
      ...(withContinuation ? { continuationPolicyShadow: adapterInput() } : {}),
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
    };
  } finally {
    kernel.close();
  }
}

function legacyBridgeSnapshot(run) {
  return {
    status: run.result.status,
    nodeRecords: run.result.nodeRecords.map(({ nodeId, status, outputSha256, failureClass }) => ({
      nodeId,
      status,
      outputSha256: outputSha256 ?? null,
      failureClass: failureClass ?? null,
    })),
    workerResults: run.result.workerResults.map(({ status, outputSha256, rawOutputSha256 }) => ({
      status,
      outputSha256,
      rawOutputSha256,
    })),
    eventTypes: run.events.map((event) => event.eventType),
    eventCount: run.events.length,
    cursor: run.projection.cursor,
    completedNodeIds: run.projection.completedNodes.map((record) => record.nodeId),
    checkpointCount: new Set(run.projection.completedNodes.map((record) => record.checkpointId)).size,
  };
}

test("71 — canonical policy exposes and produces all four advisory dispositions", () => {
  assert.deepEqual(CONTINUATION_POLICY_SHADOW_DISPOSITIONS, ["continue", "wait", "stop", "escalate"]);
  const cases = [
    [baseCommand(), "continue"],
    [baseCommand({ humanDecisionAssessment: assessment("pending") }), "wait"],
    [baseCommand({ authoritySnapshot: { runStatus: "completed" } }), "stop"],
    [baseCommand({ scopeAssessment: assessment("outside") }), "escalate"],
  ];
  for (const [command, expected] of cases) {
    const result = evaluateContinuationPolicyShadow(command);
    assert.equal(result.disposition.action, expected);
    assertValidContinuationPolicyShadowResult(result);
  }
});

test("71 — continue requires every positive precondition and never grants authorization", () => {
  const continued = evaluateContinuationPolicyShadow(baseCommand());
  assert.equal(continued.disposition.action, "continue");
  assert.deepEqual(continued.disposition.reasonCodes, [
    "unfinished_goal_executable_in_scope",
    "new_valid_evidence_expected",
    "shadow_evidence_transition_allowed",
  ]);
  assert.ok(Object.values(continued.authorization).every((value) => value === false));
  assert.equal(continued.eventIntents[0].persisted, false);
  assert.equal(continued.eventIntents[0].authoritative, false);
  assert.equal(continued.eventIntents[0].writeAllowed, false);

  const negativeControls = [
    baseCommand({ authoritySnapshot: { currentness: "unproven" } }),
    baseCommand({ authoritySnapshot: { bridgeSettlementState: "incomplete" } }),
    baseCommand({ authoritySnapshot: { eventChainState: "unknown" } }),
    baseCommand({ blockerAssessment: assessment("recoverable") }),
    baseCommand({ humanDecisionAssessment: assessment("pending") }),
    baseCommand({ evidenceTransition: { ...baseCommand().evidenceTransition, verdict: "blocked" } }),
  ];
  for (const command of negativeControls) {
    assert.notEqual(evaluateContinuationPolicyShadow(command).disposition.action, "continue");
  }
});

test("71 — active claims and unproven currentness wait without caller-time or resumable shortcuts", () => {
  const activeClaim = evaluateContinuationPolicyShadow(baseCommand({
    authoritySnapshot: {
      activeClaimRefs: ["claim:active"],
      currentness: "active_claim_present",
    },
  }));
  assert.equal(activeClaim.disposition.action, "wait");
  assert.ok(activeClaim.disposition.reasonCodes.includes("active_claim_requires_kernel_recheck"));

  const unproven = evaluateContinuationPolicyShadow(baseCommand({
    authoritySnapshot: { currentness: "unproven" },
  }));
  assert.equal(unproven.disposition.action, "wait");
  assert.ok(unproven.disposition.reasonCodes.includes("authority_snapshot_currentness_unproven"));

  for (const unknownField of ["resumable", "now", "observedAtMs", "leaseExpiresAtMs"]) {
    const command = baseCommand();
    command.authoritySnapshot[unknownField] = unknownField === "resumable" ? true : 0;
    assert.throws(() => evaluateContinuationPolicyShadow(command), /exactly the supported fields/iu);
  }
});

test("71 — active claim blocks continue while preserving escalate then stop then wait priority", () => {
  const activeClaimAuthority = {
    activeClaimRefs: ["claim:active"],
    currentness: "active_claim_present",
  };
  const ordinary = evaluateContinuationPolicyShadow(baseCommand({
    authoritySnapshot: activeClaimAuthority,
  }));
  assert.equal(ordinary.disposition.action, "wait");
  assert.notEqual(ordinary.disposition.action, "continue");

  const verifiedStop = evaluateContinuationPolicyShadow(baseCommand({
    authoritySnapshot: activeClaimAuthority,
    controlAssessment: controlAssessment(
      "stop_verified",
      "host-decision:stop-with-active-claim",
      ["host-decision:stop-with-active-claim"],
    ),
  }));
  assert.equal(verifiedStop.disposition.action, "stop");
  assert.notEqual(verifiedStop.disposition.action, "continue");

  const integrityFailure = evaluateContinuationPolicyShadow(baseCommand({
    authoritySnapshot: {
      ...activeClaimAuthority,
      eventChainState: "failed",
    },
  }));
  assert.equal(integrityFailure.disposition.action, "escalate");
  assert.notEqual(integrityFailure.disposition.action, "continue");
});

test("71 — integrity, binding, and scope conflicts escalate while terminal and completed goals stop", () => {
  const cases = [
    [baseCommand({ authoritySnapshot: { eventChainState: "failed" } }), "escalate", "projection_integrity_failed"],
    [baseCommand({ binding: { projectionDigest: digest("forged") } }), "escalate", "authority_binding_mismatch"],
    [baseCommand({ scopeAssessment: assessment("outside") }), "escalate", "required_work_out_of_scope"],
    [baseCommand({ authoritySnapshot: { runStatus: "completed" } }), "stop", "authoritative_run_terminal"],
    [baseCommand({ goalAssessment: assessment("satisfied") }), "stop", "all_goals_satisfied"],
    [baseCommand({ repeatAssessment: assessment("repeat_only"), evidenceAssessment: assessment("none_expected") }), "stop", "repeat_only_no_new_evidence"],
  ];
  for (const [command, action, reason] of cases) {
    const result = evaluateContinuationPolicyShadow(command);
    assert.equal(result.disposition.action, action);
    assert.ok(result.disposition.reasonCodes.includes(reason));
  }
});

test("71 — verified stop is advisory; stop-save, compaction, and transcript text cannot mint it", () => {
  for (const controlRef of ["host-decision:stop-1", "plan-challenge:stopped-by-user-1"]) {
    const stopped = evaluateContinuationPolicyShadow(baseCommand({
      controlAssessment: controlAssessment("stop_verified", controlRef, [controlRef]),
    }));
    assert.equal(stopped.disposition.action, "stop");
    assert.ok(stopped.disposition.reasonCodes.includes("verified_user_stop"));
    assert.equal(stopped.authorization.runTerminalStatusWriteAllowed, false);
  }
  for (const state of ["stop_verified", "continue_verified"]) {
    for (const controlRef of [
      "stop-save:continue",
      "compaction:continue",
      "transcript:stop",
      "local-continuity:continue",
    ]) {
      assert.throws(
        () => evaluateContinuationPolicyShadow(baseCommand({
          controlAssessment: controlAssessment(state, controlRef, [controlRef]),
        })),
        /verified host-decision or plan-challenge/iu,
      );
    }
  }
});

test("71 — terminal stop requires a clean verified and current bridge settlement", () => {
  for (const runStatus of ["completed", "failed", "blocked"]) {
    const clean = evaluateContinuationPolicyShadow(baseCommand({ authoritySnapshot: { runStatus } }));
    assert.equal(clean.disposition.action, "stop", runStatus);
    assert.ok(clean.disposition.reasonCodes.includes("authoritative_run_terminal"));
  }

  for (const authority of [
    { runStatus: "completed", eventChainState: "failed" },
    { runStatus: "failed", bridgeSettlementState: "failed" },
  ]) {
    const result = evaluateContinuationPolicyShadow(baseCommand({ authoritySnapshot: authority }));
    assert.equal(result.disposition.action, "escalate");
    assert.ok(result.disposition.reasonCodes.includes("projection_integrity_failed"));
  }

  for (const authority of [
    { runStatus: "completed", currentness: "unproven" },
    { runStatus: "failed", bridgeSettlementState: "incomplete" },
    { runStatus: "blocked", bridgeSettlementState: "unknown" },
  ]) {
    const result = evaluateContinuationPolicyShadow(baseCommand({ authoritySnapshot: authority }));
    assert.equal(result.disposition.action, "wait");
    assert.equal(result.disposition.reasonCodes.includes("authoritative_run_terminal"), false);
  }
});

test("71 — A01 blocked, in_doubt, and not-evaluated projections wait; allowed remains non-authorizing", () => {
  const allowed = adapterProjection();
  assert.equal(allowed.evaluationStatus, "evaluated");
  assert.equal(allowed.disposition, "continue");
  assert.ok(Object.values(allowed.result.authorization).every((value) => value === false));

  const blocked = adapterProjection({ evidence: a01Projection({ assessmentState: "rejected" }) });
  assert.equal(blocked.evaluationStatus, "evaluated");
  assert.equal(blocked.disposition, "wait");
  assert.ok(blocked.result.disposition.reasonCodes.includes("evidence_transition_blocked"));

  const inDoubt = adapterProjection({ evidence: a01Projection({ assessmentState: "in_doubt" }) });
  assert.equal(inDoubt.evaluationStatus, "evaluated");
  assert.equal(inDoubt.disposition, "wait");
  assert.ok(inDoubt.result.disposition.reasonCodes.includes("evidence_transition_in_doubt"));

  const missing = adapterProjection({ evidence: buildEvidenceTransitionShadowProjection(null) });
  assert.equal(missing.evaluationStatus, "evaluated");
  assert.equal(missing.disposition, "wait");
  assert.ok(missing.result.disposition.reasonCodes.includes("evidence_transition_not_evaluated"));
});

test("71 — adapter binds A01 to the durable snapshot and rejects injected time, action, authorization, or secrets", () => {
  const mismatched = adapterProjection({ evidence: a01Projection({ runId: "run:other" }) });
  assert.equal(mismatched.evaluationStatus, "not_evaluated_invalid_normalized_input");
  assert.equal(mismatched.disposition, "escalate");
  assert.equal(mismatched.result, null);

  const secret = "sk-live-m3-a02-do-not-retain";
  for (const [field, value] of [
    ["now", 1],
    ["leaseExpiresAtMs", 0],
    ["action", "continue"],
    ["authorization", { executionAllowed: true }],
    ["rawOutput", secret],
  ]) {
    const projection = adapterProjection({ input: { ...adapterInput(), [field]: value } });
    assert.equal(projection.evaluationStatus, "not_evaluated_invalid_normalized_input");
    assert.equal(projection.disposition, "escalate");
    assert.equal(projection.result, null);
    assert.equal(JSON.stringify(projection).includes(secret), false);
    assert.equal(JSON.stringify(projection).includes(field), false);
  }
});

test("71 — A01 envelope claims cannot override its validated canonical result", () => {
  const canonicalBlocked = a01Projection({ assessmentState: "rejected" });
  assert.equal(canonicalBlocked.result.verdict.status, "blocked");

  const forgedAllowed = {
    ...canonicalBlocked,
    evaluationStatus: "evaluated",
    verdict: "allowed",
  };
  const resultOverride = adapterProjection({ evidence: forgedAllowed });
  assert.equal(resultOverride.evaluationStatus, "not_evaluated_invalid_normalized_input");
  assert.equal(resultOverride.disposition, "escalate");
  assert.equal(resultOverride.result, null);

  const nullAllowed = {
    ...buildEvidenceTransitionShadowProjection(null),
    evaluationStatus: "evaluated",
    verdict: "allowed",
  };
  const missingResult = adapterProjection({ evidence: nullAllowed });
  assert.equal(missingResult.evaluationStatus, "not_evaluated_invalid_normalized_input");
  assert.equal(missingResult.disposition, "escalate");
  assert.equal(missingResult.result, null);

  for (const evidence of [
    { ...a01Projection(), schemaVersion: "forged-schema-v99" },
    { ...a01Projection(), mode: "authoritative" },
    { ...a01Projection(), authority: { ...a01Projection().authority, gatesExecution: true } },
  ]) {
    const rejected = adapterProjection({ evidence });
    assert.equal(rejected.evaluationStatus, "not_evaluated_invalid_normalized_input");
    assert.equal(rejected.disposition, "escalate");
    assert.equal(rejected.result, null);
  }
});

test("71 — A01 policy binding mismatch cannot recommend continuation", () => {
  const mismatched = adapterProjection({
    input: adapterInput({ policyDigest: digest("different-policy") }),
  });
  assert.equal(mismatched.evaluationStatus, "not_evaluated_invalid_normalized_input");
  assert.equal(mismatched.disposition, "escalate");
  assert.equal(mismatched.result, null);
});

test("71 — sparse arrays, accessors, proxies, unknown fields, and prototype pollution fail closed", () => {
  const sparse = baseCommand();
  sparse.goalAssessment.evidenceRefs = new Array(1);
  assert.throws(() => evaluateContinuationPolicyShadow(sparse), /dense|sparse/iu);

  const accessor = baseCommand();
  Object.defineProperty(accessor, "binding", { enumerable: true, get: () => baseCommand().binding });
  assert.throws(() => evaluateContinuationPolicyShadow(accessor), /own data properties/iu);

  const proxied = new Proxy(baseCommand(), { ownKeys: () => { throw new Error("secret proxy trap"); } });
  assert.throws(() => evaluateContinuationPolicyShadow(proxied), /inspectable plain own-data record/iu);

  const unknown = baseCommand();
  unknown.executionAllowed = true;
  assert.throws(() => evaluateContinuationPolicyShadow(unknown), /exactly the supported fields/iu);

  const polluted = Object.assign(Object.create({ executionAllowed: true }), baseCommand());
  assert.throws(() => evaluateContinuationPolicyShadow(polluted), /plain Object\.prototype record/iu);

  const arrayAttacks = [
    (array) => { array.extra = "forged"; },
    (array) => { array[Symbol("forged")] = "forged"; },
    (array) => Object.defineProperty(array, "0", { enumerable: true, get: () => "evidence:forged" }),
  ];
  for (const attack of arrayAttacks) {
    const command = baseCommand({ goalAssessment: assessment("unfinished", ["evidence:valid"]) });
    attack(command.goalAssessment.evidenceRefs);
    assert.throws(() => evaluateContinuationPolicyShadow(command), /dense|own data|supported|field/iu);
  }

  const oversized = baseCommand({
    authoritySnapshot: { activeClaimRefs: Array.from({ length: 257 }, (_, index) => `claim:${index}`) },
  });
  assert.throws(() => evaluateContinuationPolicyShadow(oversized), /outside the supported bound/iu);
});

test("71 — output is deterministic, deeply frozen, and reason order is stable", () => {
  const command = baseCommand({
    authoritySnapshot: {
      currentness: "active_claim_present",
      activeClaimRefs: ["claim:z", "claim:a"],
      blockingEffectRefs: ["effect:b"],
      bridgeSettlementState: "incomplete",
    },
    humanDecisionAssessment: assessment("pending", ["decision:z", "decision:a"]),
  });
  const first = evaluateContinuationPolicyShadow(command);
  const second = evaluateContinuationPolicyShadow(structuredClone(command));
  assert.deepEqual(first, second);
  assert.deepEqual(first.disposition.reasonCodes, [
    "authority_snapshot_currentness_unproven",
    "active_claim_requires_kernel_recheck",
    "unresolved_effect_present",
    "bridge_settlement_incomplete",
    "awaiting_human_decision",
  ]);
  assertDeepFrozen(first);
});

test("71 — source boundary forbids kernel reads, mutations, scheduler calls, and M3-P3 cutover", () => {
  const adapter = readFileSync("scripts/governed-execution/continuation-policy-shadow-adapter.mjs", "utf8");
  const domain = readFileSync("src/domain/continuation/continuation-policy-shadow.mjs", "utf8");
  for (const source of [adapter, domain]) {
    assert.doesNotMatch(source, /\b(?:projectRun|resumeRun|completeNode|appendEvent|claimNode|heartbeatNode|setRunTerminalStatus|selectMaximalSafeReadySet)\s*\(/u);
    assert.doesNotMatch(source, /\b(?:M3-P3|legacyGateCutover)\s*(?:=|\(|: true)/u);
  }
  assert.match(adapter, /projectionOnly:\s*true/u);
  assert.match(adapter, /terminatesRun:\s*false/u);
});

test("71 — contract invalid-envelope fields match the actual bounded adapter envelope", () => {
  const contract = JSON.parse(
    readFileSync("config/contracts/continuation-policy-shadow-contract.json", "utf8"),
  );
  const invalid = adapterProjection({ input: { ...adapterInput(), action: "continue" } });
  assert.deepEqual(
    Object.keys(invalid),
    contract.adapterContract.envelopeExactFields,
  );
  assert.equal(contract.adapterContract.invalidInputEnvelope.evaluationStatus, invalid.evaluationStatus);
  assert.equal(contract.adapterContract.invalidInputEnvelope.disposition, invalid.disposition);
  assert.equal(contract.adapterContract.invalidInputEnvelope.result, invalid.result);
  assert.equal(
    Object.hasOwn(contract.adapterContract.invalidInputEnvelope, "reasonCodes"),
    false,
  );
  assert.deepEqual(
    contract.commandSchema.binding.bindingGroups.a01AndDurableAuthorityFields,
    ["runId", "taskFingerprint", "graphDigest", "policyDigest"],
  );
  assert.deepEqual(
    contract.commandSchema.binding.bindingGroups.durableSnapshotFields,
    ["projectionDigest", "durableCursor", "headEventHash", "headCheckpointId"],
  );
  assert.equal(
    contract.commandSchema.binding.bindingGroups.callerAssessmentRevisionField,
    "evaluationRevision",
  );
  assert.match(
    contract.commandSchema.binding.exactBindingRule,
    /evaluationRevision is only the caller assessment revision/iu,
  );
});

test("71 — bridge A/B shadow toggle preserves legacy events, cursor, checkpoints, nodes, and outputs", async () => {
  const runId = "m3-a02-bridge-parity";
  const baseline = await runBridgeVariant({ runId, withContinuation: false });
  const enabled = await runBridgeVariant({ runId, withContinuation: true });

  assert.equal(Object.hasOwn(baseline.result, "continuationPolicyShadowProjection"), false);
  assert.equal(Object.hasOwn(enabled.result, "continuationPolicyShadowProjection"), true);
  const shadow = enabled.result.continuationPolicyShadowProjection;
  assert.equal(shadow.evaluationStatus, "evaluated");
  assert.ok(["continue", "wait", "stop"].includes(shadow.disposition));
  assert.ok(Object.values(shadow.result.authorization).every((value) => value === false));
  assert.deepEqual(legacyBridgeSnapshot(enabled), legacyBridgeSnapshot(baseline));
  assert.equal(JSON.stringify(enabled.events).includes("continuationPolicyShadow"), false);
  assert.equal(JSON.stringify(enabled.projection.completedNodes).includes("continuationPolicyShadow"), false);
});
