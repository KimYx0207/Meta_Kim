import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  buildPlanChallengeState,
  planChallengeAuthorizationBinding,
} from "../../scripts/governed-execution/plan-challenge-policy.mjs";
import { evaluateRouteExecutionGate } from "../../scripts/runtime-execution-gate.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname.slice(1));

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

function ordinaryResponse(question, sequence) {
  return {
    questionId: question.questionId,
    status: "answered",
    userAnswer: "caller supplied answer",
    trusted: true,
    binding: `plan-challenge-response:${question.questionId}`,
    selectionBinding: `plan-challenge-selection:${question.questionId}`,
    sequence,
    historical: false,
    evidenceRefs: [`caller:answer:${sequence}`],
  };
}

test("reviewer PoC: real subjective redesign keeps native choice above fast_path", () => {
  const stdout = execFileSync(
    process.execPath,
    [
      "scripts/select-execution-route.mjs",
      "--task",
      "Redesign this landing page to feel premium.",
      "--runtime",
      "codex",
      "--os",
      "windows",
      "--json",
    ],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.entryClassification.path, "fast_path");
  assert.equal(result.entryChoiceDecision.choicePolicy, "must_ask");
  assert.equal(result.routeExecutionGate.applies, true);
  assert.equal(result.routeExecutionGate.handoffStatus, "awaiting_native_choice");
  assert.equal(result.routeExecutionGate.canEnterExecution, false);
});

test("reviewer PoC: packaged plan challenge can be satisfied but cannot self-authorize", () => {
  const task = "请先压力测试这个生产发布方案，确认后发布到生产环境。";
  const responses = [];
  let result = buildPlanChallengeState({ task, requestedSideEffectActions: ["external_release"] });
  while (result.planChallengeState.selectedQuestionId) {
    for (const response of responses) response.historical = true;
    responses.push(ordinaryResponse(result.planChallengeState.currentQuestion, responses.length + 1));
    result = buildPlanChallengeState({
      task,
      requestedSideEffectActions: ["external_release"],
      responses,
    });
  }
  result = buildPlanChallengeState({
    task,
    requestedSideEffectActions: ["external_release"],
    responses,
    sharedUnderstandingConfirmed: {
      trusted: true,
      binding: "plan-challenge-understanding-confirmation",
      evidenceRefs: ["caller:understanding"],
    },
    executionAuthorization: {
      state: "authorized",
      trusted: true,
      binding: planChallengeAuthorizationBinding(["external_release"]),
      scopeActions: ["external_release"],
      evidenceRefs: ["caller:authorization"],
    },
  });
  assert.equal(result.planChallengeState.planChallengeSatisfied, true);
  assert.equal(result.planChallengeState.phase, "plan_challenge_satisfied");
  assert.equal(result.planChallengeState.executionAllowed, false);
  assert.notEqual(result.planChallengeState.executionAuthorization.state, "authorized");
  assert.equal(result.planChallengeState.decisionEvidence.every((item) => item.trusted === false), true);
});

test("reviewer PoC: explicit non-executable truth blocks even without acceptance history", () => {
  const blocked = evaluateRouteExecutionGate({
    runtime: "codex",
    taskShape: "default_executable",
    effectiveMatrix: matrixWith({ routeEligibility: "not_executable", acceptanceState: "not_run" }),
  });
  assert.equal(blocked.routeCompatible, false);
  assert.equal(blocked.handoffStatus, "blocked");
  assert.equal(blocked.allowed, false);

  const handoff = evaluateRouteExecutionGate({
    runtime: "codex",
    taskShape: "default_executable",
    effectiveMatrix: matrixWith({ routeEligibility: "executable", acceptanceState: "not_run" }),
  });
  assert.equal(handoff.routeCompatible, true, handoff.blockers.join("\n"));
  assert.equal(handoff.handoffStatus, "ready_for_host_handoff");
  assert.equal(handoff.allowed, false);
  assert.match(handoff.checks.flatMap((item) => item.advisories).join("\n"), /advisory|does not authorize|unavailable/iu);
});

test("reviewer PoC: CLI summary never derives pre-host authority from a legacy frame", () => {
  const source = readFileSync(path.join(repoRoot, "scripts/run-meta-theory-governed-execution.mjs"), "utf8");
  assert.doesNotMatch(
    source,
    /executionAllowed:\s*\n?\s*report\.preDecisionOptionFrame\?\.planChallengeState\?\.executionAllowed/iu,
  );
});
