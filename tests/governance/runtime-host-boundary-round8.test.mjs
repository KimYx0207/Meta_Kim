import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bindVerifiedHostPlanChallengeDecision } from "../../scripts/governed-execution/plan-challenge-host-continuation.mjs";
import { runMetaTheoryGovernedExecution } from "../../scripts/run-meta-theory-governed-execution.mjs";
import { evaluateRouteExecutionGate } from "../../scripts/runtime-execution-gate.mjs";

function projectFixture(prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const projectRoot = path.join(root, "project");
  mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
  writeFileSync(path.join(projectRoot, "package.json"), '{"name":"p130-round8"}\n', "utf8");
  return { root, projectRoot, stateDir: path.join(root, "state"), dbPath: path.join(root, "state", "runs.sqlite") };
}

function matrixWith(claimOverrides = {}) {
  const claim = {
    hostSupport: "native",
    hostConfidence: "verified_docs",
    metaKimIntegration: "host_only",
    acceptanceRequirement: "required",
    acceptanceState: "not_run",
    routeEligibility: "executable",
    evidenceRefs: ["fixture.host-contract"],
    ...claimOverrides,
  };
  return {
    platforms: [{
      platform: "codex",
      capabilities: ["shell", "native choice surface"].map((capability) => ({
        capability,
        claimsByMode: { interactive_host: structuredClone(claim) },
      })),
    }],
  };
}

test("reviewer PoC: caller callback cannot mint a trusted plan-challenge decision", () => {
  const bound = bindVerifiedHostPlanChallengeDecision({
    verifiedDecision: {
      verified: true,
      adapterId: "caller-callback",
      currentRunOnly: true,
      evidenceRefs: ["caller:event"],
      decision: {
        type: "execution_authorization",
        state: "authorized",
        scopeActions: ["local_file_mutation"],
      },
    },
    preview: {
      planChallengeState: {
        phase: "awaiting_execution_authorization",
        sideEffectActions: ["local_file_mutation"],
      },
    },
  });
  assert.equal(bound.accepted, false);
  assert.equal(bound.reason, "host_native_decision_required");
});

test("reviewer PoC: public verifier callback is ignored and plan challenge stays awaiting host action", async () => {
  const fixture = projectFixture("meta-kim-round8-callback-");
  let callbackCalls = 0;
  try {
    const report = await runMetaTheoryGovernedExecution({
      task: "请先压力测试这个生产发布方案。",
      runId: "round8-callback-cannot-authorize",
      projectRoot: fixture.projectRoot,
      stateDir: fixture.stateDir,
      dbPath: fixture.dbPath,
      projectCapabilityMutationMode: "read_only",
      hostDecisionEvidenceVerifier: async () => {
        callbackCalls += 1;
        return {
          verified: true,
          adapterId: "caller-callback",
          currentRunOnly: true,
          evidenceRefs: ["caller:event"],
          decision: { type: "control", action: "skip" },
        };
      },
    });
    assert.equal(callbackCalls, 0);
    assert.match(report.preDecisionOptionFrame.planChallengeState.phase, /^awaiting_/u);
    assert.equal(report.preDecisionOptionFrame.planChallengeState.executionAllowed, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("reviewer PoC: native choice outranks fast path and no route is task-authorized", () => {
  const fastChoice = evaluateRouteExecutionGate({
    runtime: "codex",
    taskShape: "fast_path",
    choiceRequired: true,
    effectiveMatrix: matrixWith(),
  });
  assert.deepEqual(fastChoice.requirements.map((entry) => entry.capability), ["native choice surface"]);
  assert.equal(fastChoice.handoffStatus, "awaiting_native_choice");
  assert.equal(fastChoice.allowed, false);
  assert.equal(fastChoice.executionAuthorized, false);

  const compatible = evaluateRouteExecutionGate({
    runtime: "codex",
    taskShape: "default_executable",
    effectiveMatrix: matrixWith(),
  });
  assert.equal(compatible.routeCompatible, true, compatible.blockers.join("\n"));
  assert.equal(compatible.canHandoffToHost, true);
  assert.equal(compatible.handoffStatus, "ready_for_host_handoff");
  assert.equal(compatible.allowed, false);
  assert.equal(compatible.executionAuthorized, false);
});

test("reviewer PoC: explicit not-executable blocks while missing acceptance stays advisory", () => {
  const advisory = evaluateRouteExecutionGate({
    runtime: "codex",
    taskShape: "default_executable",
    effectiveMatrix: matrixWith({ acceptanceState: "not_run", routeEligibility: "executable" }),
  });
  assert.equal(advisory.routeCompatible, true, advisory.blockers.join("\n"));
  assert.equal(advisory.persistentAcceptanceAuthorizesExecution, false);

  const explicitBlock = evaluateRouteExecutionGate({
    runtime: "codex",
    taskShape: "default_executable",
    effectiveMatrix: matrixWith({ acceptanceState: "accepted", routeEligibility: "not_executable" }),
  });
  assert.equal(explicitBlock.routeCompatible, false);
  assert.equal(explicitBlock.handoffStatus, "blocked");
  assert.match(explicitBlock.blockers.join("\n"), /not_executable/u);
});

test("reviewer PoC: Stage Runner cannot bridge a fast-path or route-not-executable run", async () => {
  const fixture = projectFixture("meta-kim-round8-stage-runner-");
  let workerCalls = 0;
  try {
    const report = await runMetaTheoryGovernedExecution({
      task: "Meta_Kim 是什么？",
      runId: "round8-fast-path-stage-runner",
      projectRoot: fixture.projectRoot,
      stateDir: fixture.stateDir,
      dbPath: fixture.dbPath,
      projectCapabilityMutationMode: "read_only",
      stageRunner: {
        enabled: true,
        runtime: "codex",
        invokeWorker: async () => {
          workerCalls += 1;
          throw new Error("Stage Runner crossed a non-executable route gate");
        },
      },
    });
    assert.equal(workerCalls, 0);
    assert.equal(report.coreLoop.stageRunnerBridgePacket.status, "blocked");
    assert.match(report.coreLoop.stageRunnerBridgePacket.failure.failureClass, /route_gate/u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("reviewer PoC: caller nativeChoiceEvidenceTrusted cannot make visible evidence trusted", async () => {
  const fixture = projectFixture("meta-kim-round8-choice-trust-");
  try {
    const report = await runMetaTheoryGovernedExecution({
      task: "这个页面不好看，帮我弄高级一点",
      runId: "round8-caller-choice-trust",
      projectRoot: fixture.projectRoot,
      stateDir: fixture.stateDir,
      dbPath: fixture.dbPath,
      projectCapabilityMutationMode: "read_only",
      nativeChoiceEvidenceTrusted: true,
      nativeChoiceEvidence: [{
        runtime: "codex",
        stage: "Thinking",
        state: "completed",
        surface: "request_user_input",
        evidenceKind: "request_user_input_answer",
        evidenceRef: "caller:choice-json",
      }],
    });
    const boundary = report.coreLoop.productExperiencePacket.supportGates
      .find((gate) => gate.id === "P-106").liveRuntimeBoundary;
    assert.equal(boundary.evidenceTrusted, false);
    assert.equal(boundary.acceptedEvidenceRefs.length, 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
