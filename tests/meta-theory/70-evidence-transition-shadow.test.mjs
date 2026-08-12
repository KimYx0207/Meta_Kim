import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildEvidenceTransitionShadowProjection } from "../../scripts/governed-execution/evidence-transition-shadow-adapter.mjs";
import { openDurableRunKernel } from "../../scripts/governed-execution/durable-run-kernel.mjs";
import { runStageRunnerBridge } from "../../scripts/governed-execution/stage-runner-bridge.mjs";
import {
  buildStageDagPacket,
  stageDagGraphDigest,
  stageLaneNodeId,
} from "../../scripts/governed-execution/stage-dag.mjs";

const DIGEST = Object.freeze({
  task: `sha256:${"1".repeat(64)}`,
  policy: `sha256:${"2".repeat(64)}`,
  payload: `sha256:${"3".repeat(64)}`,
  assessment: `sha256:${"4".repeat(64)}`,
});

function lane() {
  return {
    laneId: "shadow-worker",
    laneKind: "execution_worker",
    ownerBindingRef: "owner:test-worker",
    capabilityBindingRef: "capability:read-only-test",
    effectClass: "read_only_worker",
    resourceScopes: ["file:package.json"],
    isolation: "shared_read_only",
    status: "planned_not_invoked",
  };
}

function packet() {
  return {
    taskPacketId: "shadow-worker",
    ownerAgent: "test-automator",
    description: "Read package metadata",
    output: "observed package metadata",
    dependsOn: [],
    executionMode: "primary_execution",
    externalWriteBoundary: false,
  };
}

function dag({ stageOrder = ["Execution", "Review"] } = {}) {
  return buildStageDagPacket({
    stageOrder,
    stageLanes: {
      Execution: [lane()],
      ...Object.fromEntries(stageOrder.filter((stage) => stage !== "Execution").map((stage) => [stage, []])),
    },
    runtimeCapacity: 1,
  });
}

function normalizedShadowInput({ runId = "run-shadow-adapter", graphDigest = "5".repeat(64) } = {}) {
  return {
    binding: {
      runId,
      taskFingerprint: DIGEST.task,
      graphDigest: graphDigest.startsWith("sha256:") ? graphDigest : `sha256:${graphDigest}`,
      nodeId: "node:Execution:shadow-worker",
      attemptId: "attempt:1",
      fenceToken: 1,
      revision: 0,
      policyDigest: DIGEST.policy,
    },
    evidenceClaims: [{
      claimId: "claim:targeted-test",
      producerRef: "producer:test-worker",
      evidenceType: "test_result",
      subjectRef: "subject:execution-node",
      payloadDigest: DIGEST.payload,
    }],
    validatorAssessments: [{
      claimId: "claim:targeted-test",
      validatorRef: "validator:test-owner",
      assessment: "verified",
      assessmentDigest: DIGEST.assessment,
      reasonCode: "independent_check_passed",
    }],
    decisionDependencies: [],
    transitionRequest: {
      proposalId: "proposal:execution-to-review",
      fromStage: "execution",
      toStage: "review",
      requiredClaimIds: ["claim:targeted-test"],
    },
  };
}

function bridgeShadowInput(overrides = {}) {
  const normalized = normalizedShadowInput();
  const bridgeInput = {
    policyDigest: normalized.binding.policyDigest,
    evidenceClaims: normalized.evidenceClaims,
    validatorAssessments: normalized.validatorAssessments,
    decisionDependencies: normalized.decisionDependencies,
    transitionRequest: normalized.transitionRequest,
  };
  return {
    ...bridgeInput,
    ...overrides,
    transitionRequest: {
      ...bridgeInput.transitionRequest,
      ...overrides.transitionRequest,
    },
  };
}

function assertProjectionOnly(projection) {
  assert.equal(projection.schemaVersion, "evidence-transition-shadow-adapter-v1");
  assert.equal(projection.mode, "shadow_only");
  assert.deepEqual(projection.authority, {
    gatesExecution: false,
    writesKernel: false,
    writesEvents: false,
    completesNode: false,
    advancesCursor: false,
    projectionOnly: true,
  });
  if (projection.result) {
    assert.equal(projection.result.authorization.executionAllowed, false);
    assert.equal(projection.result.authorization.eventPersistenceAllowed, false);
    assert.equal(projection.result.authorization.completeNodeAllowed, false);
    for (const intent of projection.result.eventIntents) {
      assert.deepEqual(Object.keys(intent).sort(), [
        "authoritative",
        "intentDigest",
        "kind",
        "persisted",
        "proposalDigest",
        "verdictStatus",
        "writeAllowed",
      ]);
      assert.equal(intent.persisted, false);
      assert.equal(intent.authoritative, false);
      assert.equal(intent.writeAllowed, false);
    }
  }
}

test("70 — adapter evaluates only explicit normalized evidence and remains projection-only", () => {
  const projection = buildEvidenceTransitionShadowProjection(normalizedShadowInput());
  assert.equal(projection.evaluationStatus, "evaluated");
  assert.equal(projection.verdict, "allowed");
  assert.equal(projection.result.verdict.status, "allowed");
  assertProjectionOnly(projection);

  for (const inferredOnly of [
    { status: "completed" },
    { stdout: "done" },
    { markdown: "All tests passed" },
    { toolCall: "Task" },
    { hostAnswerState: "host_answer_claimed" },
  ]) {
    const rejected = buildEvidenceTransitionShadowProjection(inferredOnly);
    assert.equal(rejected.evaluationStatus, "not_evaluated_invalid_normalized_input");
    assert.equal(rejected.verdict, "in_doubt");
    assert.equal(rejected.result, null);
    assertProjectionOnly(rejected);
  }
});

test("70 — missing or invalid input returns bounded in_doubt without leaking errors, secrets, paths, or URLs", () => {
  const missing = buildEvidenceTransitionShadowProjection();
  assert.equal(missing.evaluationStatus, "not_evaluated_missing_normalized_input");
  assert.equal(missing.verdict, "in_doubt");
  assert.equal(missing.result, null);
  assertProjectionOnly(missing);

  const secret = "sk-live-shadow-adapter-must-not-leak";
  const windowsPath = "C:\\Users\\Kim\\private\\evidence.txt";
  const url = "https://example.invalid/private-evidence";
  const invalid = normalizedShadowInput();
  invalid.evidenceClaims[0].producerRef = `${secret}:${windowsPath}:${url}`;
  const projection = buildEvidenceTransitionShadowProjection(invalid);
  assert.equal(projection.evaluationStatus, "not_evaluated_invalid_normalized_input");
  assert.equal(projection.verdict, "in_doubt");
  assert.equal(projection.result, null);
  const serialized = JSON.stringify(projection);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(windowsPath), false);
  assert.equal(serialized.includes(url), false);
  assert.doesNotMatch(serialized, /error|stack|message/iu);
  assert.ok(serialized.length < 1_000, "invalid diagnostics must remain bounded");
  assertProjectionOnly(projection);
});

test("70 — adapter has no kernel mutation, scheduler, filesystem, or network capability", () => {
  const source = readFileSync(
    "scripts/governed-execution/evidence-transition-shadow-adapter.mjs",
    "utf8",
  );
  assert.doesNotMatch(source, /durable-run-kernel|appendEvent|completeNode|failNode|claimNode|setRunTerminalStatus|selectMaximalSafeReadySet|applyStageRunnerBridgeResult/u);
  assert.doesNotMatch(source, /\bfrom\s*["']node:(?:fs|child_process|net|http|https|dns|tls|dgram|sqlite)/u);
});

async function runDurableVariant({ runId, evidenceTransitionShadow, stageDagPacket = dag() }) {
  const kernel = await openDurableRunKernel();
  const taskFingerprint = `task:${runId}`;
  try {
    const options = {
      runId,
      runtime: "codex",
      stageDagPacket,
      workerTaskPackets: [packet()],
      workspaceRoot: process.cwd(),
      durable: {
        enabled: true,
        kernel,
        mode: "create",
        taskFingerprint,
        ownerId: `owner:${runId}`,
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
        sessionId: "session:m3-a01-shadow-parity",
        messageId: "message:m3-a01-shadow-parity",
        outputText: "meta-kim",
        outputSha256: "a".repeat(64),
        rawOutputSha256: "b".repeat(64),
        hostEventCount: 1,
        toolEventCount: 1,
        stderrTail: "",
      }),
    };
    if (evidenceTransitionShadow !== undefined) {
      options.evidenceTransitionShadow = evidenceTransitionShadow;
    }
    const result = await runStageRunnerBridge(options);
    return {
      result,
      projection: kernel.projectRun(runId),
      events: kernel.getEvents(runId),
    };
  } finally {
    kernel.close();
  }
}

function legacySnapshot(run) {
  return {
    bridgeStatus: run.result.status,
    nodeRecords: run.result.nodeRecords.map((record) => ({
      nodeId: record.nodeId,
      status: record.status,
      outputSha256: record.outputSha256 ?? null,
      failureClass: record.failureClass ?? null,
    })),
    workerResults: run.result.workerResults.map((record) => ({
      status: record.status,
      outputSha256: record.outputSha256,
      rawOutputSha256: record.rawOutputSha256,
    })),
    completedNodes: run.projection.completedNodes.map((record) => ({
      nodeId: record.nodeId,
      status: record.status,
      // The nested digest is the semantic completeNode input digest. The
      // record-level digest also covers timing metadata and is intentionally
      // different across isolated executions.
      outputSha256: record.output?.outputSha256 ?? record.outputSha256 ?? null,
    })),
    eventTypes: run.events.map((event) => event.eventType),
    eventCount: run.events.length,
    checkpointCount: new Set(run.projection.completedNodes.map((record) => record.checkpointId)).size,
  };
}

test("70 — bridge shadow on/off preserves legacy terminal, checkpoint, output digest, and event-count truth", async () => {
  const runId = "m3-a01-shadow-parity";
  const baseline = await runDurableVariant({ runId });
  const enabled = await runDurableVariant({
    runId,
    evidenceTransitionShadow: bridgeShadowInput(),
  });

  assert.equal(Object.hasOwn(baseline.result, "evidenceTransitionShadowProjection"), false);
  assert.equal(Object.hasOwn(enabled.result, "evidenceTransitionShadowProjection"), true);
  assert.equal(enabled.result.evidenceTransitionShadowProjection.verdict, "allowed");
  assertProjectionOnly(enabled.result.evidenceTransitionShadowProjection);
  const derivedBinding = enabled.result.evidenceTransitionShadowProjection.result.binding;
  assert.equal(derivedBinding.runId, runId);
  assert.match(derivedBinding.taskFingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(
    derivedBinding.graphDigest,
    `sha256:${enabled.result.stageDagPacket.graphDigest}`,
  );
  assert.equal(derivedBinding.nodeId, "stage:execution:merge");
  assert.match(derivedBinding.attemptId, /^m3-a01-shadow-parity:[a-f0-9]{16}:attempt:1$/u);
  assert.equal(derivedBinding.fenceToken, 1);
  assert.equal(derivedBinding.revision, 0);
  assert.equal(derivedBinding.policyDigest, DIGEST.policy);
  assert.deepEqual(legacySnapshot(enabled), legacySnapshot(baseline));
  assert.equal(
    JSON.stringify(enabled.projection.completedNodes).includes("evidenceTransitionShadow"),
    false,
    "shadow packet must not enter completeNode checkpoint output",
  );
  assert.equal(enabled.events.some((event) => /Evidence|Shadow|TransitionProposed/u.test(event.eventType)), false);
});

test("70 — bridge derives authority binding and rejects caller binding forgery or non-authoritative stage transitions", async () => {
  const forgedBindingFields = {
    runId: "run:forged",
    taskFingerprint: `sha256:${"8".repeat(64)}`,
    graphDigest: `sha256:${"9".repeat(64)}`,
    nodeId: "stage:fetch:merge",
    attemptId: "attempt:forged",
    fenceToken: 999,
    revision: 999,
    policyDigest: `sha256:${"a".repeat(64)}`,
  };
  const cases = [
    ...Object.entries(forgedBindingFields).map(([field, value]) => ({
      label: `forged-${field}`,
      input: { ...bridgeShadowInput(), binding: { [field]: value } },
    })),
    {
      label: "wrong-fetch-thinking-edge",
      input: bridgeShadowInput({ transitionRequest: { fromStage: "fetch", toStage: "thinking" } }),
    },
    {
      label: "wrong-execution-verification-edge",
      input: bridgeShadowInput({ transitionRequest: { fromStage: "execution", toStage: "verification" } }),
    },
    {
      label: "case-shifted-edge",
      input: bridgeShadowInput({ transitionRequest: { fromStage: "Execution", toStage: "Review" } }),
    },
  ];

  const results = await Promise.all(cases.map(({ label, input }) => runDurableVariant({
    runId: `m3-a01-${label}`,
    evidenceTransitionShadow: input,
  })));

  for (let index = 0; index < cases.length; index += 1) {
    const projection = results[index].result.evidenceTransitionShadowProjection;
    assert.equal(projection.verdict, "in_doubt", cases[index].label);
    assertProjectionOnly(projection);
  }
});

test("70 — bridge requires the digest-covered authoritative Execution to Review DAG edge", async () => {
  const onlyExecution = dag({ stageOrder: ["Execution"] });
  const nonAdjacent = dag({ stageOrder: ["Execution", "Meta-Review", "Review"] });
  const missingDependency = structuredClone(dag());
  for (const node of missingDependency.nodes.filter((candidate) => candidate.stage === "Review")) {
    node.dependsOn = node.dependsOn.filter((nodeId) => nodeId !== "stage:execution:merge");
  }
  missingDependency.graphDigest = stageDagGraphDigest(missingDependency);

  const cases = [
    ["only-execution", onlyExecution],
    ["non-adjacent-review", nonAdjacent],
    ["review-without-execution-merge-dependency", missingDependency],
  ];
  const results = await Promise.all(cases.map(([label, stageDagPacket]) => runDurableVariant({
    runId: `m3-a01-topology-${label}`,
    evidenceTransitionShadow: bridgeShadowInput(),
    stageDagPacket,
  })));
  for (let index = 0; index < cases.length; index += 1) {
    const projection = results[index].result.evidenceTransitionShadowProjection;
    assert.equal(projection.verdict, "in_doubt", cases[index][0]);
    assertProjectionOnly(projection);
  }

  const mismatchedDigest = structuredClone(dag());
  mismatchedDigest.graphDigest = "f".repeat(64);
  await assert.rejects(
    runDurableVariant({
      runId: "m3-a01-topology-digest-mismatch",
      evidenceTransitionShadow: bridgeShadowInput(),
      stageDagPacket: mismatchedDigest,
    }),
    /graphDigest|digest.*match|does not match/iu,
  );
});

test("70 — failed worker result cannot receive an allowed shadow projection", async () => {
  const kernel = await openDurableRunKernel();
  const stageDagPacket = dag();
  try {
    const result = await runStageRunnerBridge({
      runId: "m3-a01-shadow-worker-failed",
      runtime: "codex",
      stageDagPacket,
      workerTaskPackets: [packet()],
      workspaceRoot: process.cwd(),
      durable: {
        enabled: true,
        kernel,
        mode: "create",
        taskFingerprint: "task:m3-a01-shadow-worker-failed",
        ownerId: "owner:m3-a01-shadow-worker-failed",
        leaseMs: 10_000,
      },
      evidenceTransitionShadow: bridgeShadowInput(),
      evidenceKind: "test_double",
      invokeWorker: async () => ({
        status: "failed",
        durationMs: 1,
        outputText: "worker failed",
        outputSha256: "c".repeat(64),
        failureClass: "negative_control",
      }),
    });
    if (Object.hasOwn(result, "evidenceTransitionShadowProjection")) {
      assert.notEqual(result.evidenceTransitionShadowProjection.verdict, "allowed");
      assertProjectionOnly(result.evidenceTransitionShadowProjection);
    }
  } finally {
    kernel.close();
  }
});

test("70 — bridge source keeps shadow outside the durable kernel authority boundary", () => {
  const source = readFileSync("scripts/governed-execution/stage-runner-bridge.mjs", "utf8");
  assert.match(source, /buildEvidenceTransitionShadowProjection/u);
  assert.match(source, /evidenceTransitionShadowProjection/u);
  assert.doesNotMatch(
    source,
    /completeNode\s*\(\s*[^)]*evidenceTransitionShadow|appendEvent\s*\(\s*[^)]*evidenceTransitionShadow/su,
  );
  assert.equal(stageLaneNodeId("Execution", "shadow-worker").includes("shadow-worker"), true);
});
