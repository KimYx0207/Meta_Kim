import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { buildTaskGoalContract, evaluateTaskOutcome, taskOutcomeDigest } from "../../src/domain/governance/task-outcome.mjs";
import { evaluateGovernedArtifact, evaluateGovernanceFixtures } from "../../scripts/evaluate-governance-outcomes.mjs";

const task = "Choose a practical study schedule within the user's available time.";
const deterministic = [{ id: "schedule", description: "No overlapping sessions", kind: "deterministic" }];

test("cross-domain and adversarial fixtures exercise the actual orchestration builder", async () => {
  const fixtures = JSON.parse(await readFile(new URL("../../config/evals/governance-outcomes.json", import.meta.url), "utf8"));
  const report = evaluateGovernanceFixtures(fixtures);
  assert.equal(report.status, "pass", JSON.stringify(report.cases.filter((entry) => entry.status === "fail")));
  assert.equal(report.liveModelCalls, 0);
  assert.equal(report.liveQualityImprovementProven, false);
});

test("task-specific products stay run-scoped and do not contaminate durable governance policy", () => {
  for (const product of ["Electron", "WPF", "Tauri", "桌面便签"]) {
    const goal = buildTaskGoalContract({ task: `Build an accessible ${product} study tool.` });
    assert.ok(goal.contractFields.outcome.includes(product));
    assert.ok(goal.recommendedGoalText.includes(product));
    assert.ok(!goal.frameworkPolicyText.includes(product));
    assert.equal(goal.taskHash, taskOutcomeDigest(goal.contractFields.outcome));
  }
});

test("goal binding does not pretend that a task-specific verification command has run", () => {
  const goal = buildTaskGoalContract({ task });
  assert.equal(goal.evaluationPlan.status, "planned_not_evaluated");
  assert.equal(evaluateTaskOutcome(goal).status, "incomplete");
  assert.ok(goal.contractFields.verification.every((criterion) => !criterion.includes("npm run meta:")));
  assert.ok(goal.contractFields.completionEvidence.every((criterion) => !criterion.includes("P-10")));
});

test("supplied passing checks are reported without authenticating them as host execution", () => {
  const goal = buildTaskGoalContract({ task, acceptanceCriteria: deterministic });
  const result = evaluateTaskOutcome(goal, [{
    criterionId: "schedule", taskHash: goal.taskHash, acceptanceDigest: goal.acceptanceDigest, verdict: "pass",
    evidenceKind: "deterministic_check", evidenceRef: "test:overlap-check",
  }]);
  assert.equal(result.status, "pass");
  assert.equal(result.executionVerified, false);
  assert.equal(result.nativeInvocationVerified, false);
  assert.equal(result.publicReady, false);
});

test("unknown, absent and malformed observations cannot accidentally pass", () => {
  const goal = buildTaskGoalContract({ task, acceptanceCriteria: deterministic });
  for (const observation of [null, {}, { criterionId: "different" }]) {
    assert.equal(evaluateTaskOutcome(goal, [observation]).status, "fail");
  }
  for (const patch of [{ evidenceRef: "" }, { verdict: "inconclusive" }, { evidenceKind: "projection" }]) {
    const result = evaluateTaskOutcome(goal, [{ criterionId: "schedule", taskHash: goal.taskHash, acceptanceDigest: goal.acceptanceDigest, verdict: "pass", evidenceKind: "deterministic_check", evidenceRef: "test:evidence", ...patch }]);
    assert.equal(result.status, "incomplete");
  }
});

test("empty or duplicate acceptance contracts are rejected rather than vacuously passing", () => {
  assert.throws(() => buildTaskGoalContract({ task: " " }), /non-empty/u);
  assert.throws(() => buildTaskGoalContract({ task, acceptanceCriteria: [...deterministic, ...deterministic] }), /unique/u);
  assert.throws(() => buildTaskGoalContract({ task, acceptanceCriteria: [{ ...deterministic[0], required: false }] }), /required/u);
  assert.throws(() => buildTaskGoalContract({ task, acceptanceCriteria: [{ ...deterministic[0], kind: "unknown" }] }), /known kind/u);
});

test("a tampered goal or observations from another task cannot close the request", () => {
  const goal = buildTaskGoalContract({ task });
  assert.throws(() => evaluateTaskOutcome({ ...goal, taskHash: taskOutcomeDigest("Other task") }), /bound/u);
  assert.throws(() => evaluateGovernedArtifact({
    requestRecord: { task }, intentPacket: { realIntent: "Make the framework pass" }, goalContractPacket: goal,
  }), /same task/u);
});

test("semantic approval needs an accountable reviewer and not merely a schema or model score", () => {
  const goal = buildTaskGoalContract({ task });
  const observation = { criterionId: "user-outcome", taskHash: goal.taskHash, acceptanceDigest: goal.acceptanceDigest, verdict: "pass", evidenceKind: "human_review", evidenceRef: "test:review" };
  assert.equal(evaluateTaskOutcome(goal, [observation]).status, "incomplete");
  assert.equal(evaluateTaskOutcome(goal, [{ ...observation, reviewer: "review-owner" }]).status, "pass");
  assert.equal(evaluateTaskOutcome(goal, [{ ...observation, reviewer: "review-owner", evidenceKind: "model_judge", score: 100 }]).status, "incomplete");
});

test("a separate review agent can assess semantic outcomes without forcing human approval", () => {
  const goal = buildTaskGoalContract({ task });
  const observation = {
    criterionId: "user-outcome", taskHash: goal.taskHash, acceptanceDigest: goal.acceptanceDigest, verdict: "pass",
    evidenceKind: "independent_review", producer: "planner", reviewer: "review-owner", evidenceRef: "test:review-result",
  };
  assert.equal(evaluateTaskOutcome(goal, [observation]).status, "pass");
  assert.equal(evaluateTaskOutcome(goal, [{ ...observation, reviewer: "planner" }]).status, "incomplete");
  assert.equal(evaluateTaskOutcome(goal, [{ ...observation, producer: "" }]).status, "incomplete");
});

test("changed acceptance criteria invalidate prior observations even when the request is unchanged", () => {
  const oldGoal = buildTaskGoalContract({ task, acceptanceCriteria: deterministic });
  const revisedGoal = buildTaskGoalContract({ task, acceptanceCriteria: [{ ...deterministic[0], description: "No overlap and all sessions finish before 18:00" }] });
  const oldEvidence = { criterionId: "schedule", taskHash: oldGoal.taskHash, acceptanceDigest: oldGoal.acceptanceDigest, verdict: "pass", evidenceKind: "deterministic_check", evidenceRef: "test:old-check" };
  assert.equal(evaluateTaskOutcome(revisedGoal, [oldEvidence]).status, "fail");
  assert.throws(() => evaluateTaskOutcome({ ...oldGoal, acceptanceCriteria: revisedGoal.acceptanceCriteria }), /binding mismatch/u);
  assert.throws(() => evaluateTaskOutcome({ ...oldGoal, acceptanceCriteria: [] }), /original acceptance/u);
});
