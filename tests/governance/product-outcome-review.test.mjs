import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { buildTaskGoalContract } from "../../src/domain/governance/task-outcome.mjs";
import { evaluateProductOutcomeReview, projectProductReview } from "../../scripts/governed-execution/product-design.mjs";

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-outcome-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = "Current test deliverable\n";
  await writeFile(path.join(root, "report.txt"), bytes);
  const goal = buildTaskGoalContract({ task: "Deliver an accurate source report", acceptanceCriteria: [{ id: "required", description: "Correct report", kind: "semantic", required: true }, { id: "optional", description: "Additional examples", kind: "semantic", required: false }] });
  const artifact = { runId: "review-run", status: "completed", goalContractPacket: goal,
    workerTaskPackets: [{ taskPacketId: "producer", acceptanceCriterionIds: ["required", "optional"] }],
    machineExecution: { status: "completed", nextAction: { action: "complete", stage: "Evolution" } },
    workerResults: [{ taskPacketId: "producer", status: "pass" }],
    reviewPacket: { status: "pass", qualityGate: "pass", findings: [] },
    verificationPacket: { status: "pass", checks: [{ id: "historical-check", status: "pass" }] },
    summaryPacket: { status: "completed", publicReady: true, accepted: true } };
  const input = { schemaVersion: 1, runId: artifact.runId, taskHash: goal.taskHash, intentDigest: null, acceptanceDigest: goal.acceptanceDigest, designDigest: null, reviewRef: "fixture:independent-review", artifactSnapshots: [{ ref: "report.txt", producerTaskId: "producer", sha256: createHash("sha256").update(bytes).digest("hex") }],
    observations: goal.acceptanceCriteria.map(c => ({ criterionId: c.id, taskHash: goal.taskHash, intentDigest: null, acceptanceDigest: goal.acceptanceDigest, evidenceKind: "independent_review", producer: "test-producer", reviewer: "test-reviewer", verdict: "pass", evidenceRef: "fixture:review-" + c.id, artifactRefs: ["report.txt"] })) };
  return { root, artifact, input, evaluate: current => evaluateProductOutcomeReview({ input: current, artifact, projectRoot: root }) };
}

test("required failure without a diagnosis requests revision planning and overrides stale completion", async t => {
  const { artifact, input, evaluate } = await setup(t);
  input.observations[0].verdict = "fail";
  const review = await evaluate(input);
  assert.equal(review.nextAction.action, "prepare_revision");
  assert.deepEqual(review.nextAction.criterionIds, ["required"]);
  assert.deepEqual(review.revisionRequests, [], "No invented diagnosis");
  const projected = projectProductReview(artifact, review);
  assert.equal(projected.reviewPacket.nextAction.action, "prepare_revision");
  assert.equal(projected.reviewPacket.revisionNeeded, true);
  assert.notEqual(projected.verificationPacket.status, "pass");
  assert.equal(projected.summaryPacket.accepted, false);
  assert.equal(projected.summaryPacket.publicReady, false);
  assert.deepEqual(projected.machineExecution, artifact.machineExecution, "Immutable execution receipt retained");
  assert.deepEqual(projected.workerResults, artifact.workerResults);
  assert.deepEqual(projected.verificationPacket.checks, artifact.verificationPacket.checks, "Mechanical rows retained as historical facts");
});

test("current concrete revision wins over an unrelated old machine next action", async t => {
  const { artifact, input, evaluate } = await setup(t);
  input.observations[0].verdict = "fail";
  input.revisionRequests = [{ taskId: "producer", criterionId: "required", returnToStage: "Fetch", finding: "Evidence contradicts the report", requiredChange: "Read the current file and repair its name", evidenceRefs: ["report.txt"] }];
  const projected = projectProductReview(artifact, await evaluate(input));
  assert.equal(projected.reviewPacket.nextAction.action, "revise");
  assert.equal(projected.reviewPacket.nextAction.stage, "Fetch");
});

test("optional failure keeps optional status and does not block the required outcome", async t => {
  const { artifact, input, evaluate } = await setup(t);
  input.observations[1].verdict = "fail";
  const review = await evaluate(input);
  assert.equal(review.status, "pass");
  assert.equal(review.nextAction.action, "continue_verification");
  assert.equal(review.coveredTaskCriteria.find(row => row.criterionId === "optional").required, false);
  assert.equal(projectProductReview(artifact, review).reviewPacket.revisionNeeded, false);
});

test("a later passing review clears obsolete outcome failures but keeps unrelated findings and verification pending", async t => {
  const { artifact, input, evaluate } = await setup(t);
  const failedInput = structuredClone(input); failedInput.observations[0].verdict = "fail";
  failedInput.revisionRequests = [{ taskId: "producer", criterionId: "required", returnToStage: "Execution", finding: "Incorrect report", requiredChange: "Correct report", evidenceRefs: ["report.txt"] }];
  const failed = projectProductReview(artifact, await evaluate(failedInput));
  failed.reviewPacket.findings.push({ findingId: "unrelated", status: "open", finding: "Existing independent review issue" });
  const passing = projectProductReview(failed, await evaluate({ ...input, reviewRef: "fixture:new-review" }));
  assert.deepEqual(passing.reviewPacket.findings.map(f => f.findingId), ["unrelated"]);
  assert.equal(passing.reviewPacket.revisionNeeded, true);
  assert.notEqual(passing.verificationPacket.status, "pass");
  assert.equal(passing.summaryPacket.publicReady, false);
});

test("a current review invalidates every current public-ready and run-summary projection", async t => {
  const { artifact, input, evaluate } = await setup(t);
  artifact.publicReadyDecision = { publicReady: true, status: "pass", userOutcomeAccepted: true, blockedBy: [] };
  artifact.defaultRuntimePath = { status: "completed", workerResultPackets: artifact.workerResults };
  artifact.runReport = { status: "completed", runId: artifact.runId };
  artifact.coreLoop = { publicReadyDecision: structuredClone(artifact.publicReadyDecision),
    verificationPacket: structuredClone(artifact.verificationPacket), reviewPacket: structuredClone(artifact.reviewPacket) };
  input.observations[0].verdict = "fail";
  const source = structuredClone(artifact);
  const current = projectProductReview(artifact, await evaluate(input));
  for (const decision of [current.publicReadyDecision, current.coreLoop.publicReadyDecision]) {
    assert.equal(decision.publicReady, false);
    assert.equal(decision.userOutcomeAccepted, false);
    assert.notEqual(decision.status, "pass");
  }
  assert.equal(current.defaultRuntimePath.status, current.status);
  assert.equal(current.runReport.status, current.status);
  assert.deepEqual(current.defaultRuntimePath.workerResultPackets, source.workerResults);
  assert.deepEqual(current.coreLoop.verificationPacket.checks, source.coreLoop.verificationPacket.checks);
  assert.deepEqual(artifact, source, "The committed source and historical receipts are not rewritten");
});

test("an exact current machine correction retains unresolved scopes without skipping an earlier review stage", async t => {
  const { artifact, input, evaluate } = await setup(t);
  const failedInput = structuredClone(input); failedInput.observations[0].verdict = "fail";
  failedInput.revisionRequests = [{ taskId: "producer", criterionId: "required", returnToStage: "Thinking", finding: "Incorrect report", requiredChange: "Replace the disputed evidence", evidenceRefs: ["report.txt"] }];
  const failedReview = await evaluate(failedInput);
  const prior = projectProductReview(artifact, failedReview);
  const partialReview = await evaluate({ ...input, reviewRef: "fixture:optional-only", observations: input.observations.slice(1) });
  prior.machineExecution = { runId: artifact.runId, status: "waiting", outcome: structuredClone(partialReview.outcomeEvaluation),
    nextAction: { action: "revise", stage: "Thinking", revisionRequests: failedReview.revisionRequests.map(request => ({ ...request, reviewDigest: failedReview.reviewDigest })) } };
  const partial = projectProductReview(prior, partialReview);
  assert.equal(partial.reviewPacket.nextAction.stage, "Thinking");
  assert.match(partial.summaryPacket.nextAction, /Replace the disputed evidence/u);
  assert.equal(partial.reviewPacket.revisionNeeded, true);
  assert.ok(partial.reviewPacket.findings.some(finding => finding.criterionId === "required"));
  const earlierInput = structuredClone(failedInput); earlierInput.revisionRequests[0].returnToStage = "Critical";
  const earlier = await evaluate(earlierInput);
  prior.machineExecution.outcome = structuredClone(earlier.outcomeEvaluation);
  assert.equal(projectProductReview(prior, earlier).reviewPacket.nextAction.stage, "Critical");
  prior.machineExecution.runId = "other-run";
  assert.equal(projectProductReview(prior, partialReview).reviewPacket.nextAction.action, "obtain_missing_outcome_evidence");
  const executionInput = structuredClone(failedInput); executionInput.revisionRequests[0].returnToStage = "Execution";
  const executionReview = await evaluate(executionInput);
  prior.machineExecution = { runId: artifact.runId, outcome: structuredClone(executionReview.outcomeEvaluation), nextAction: {
    action: "revise", stage: "Thinking", reason: "completed_task_requires_revision_design",
    revisionRequests: executionReview.revisionRequests.map(request => ({ ...request, reviewDigest: executionReview.reviewDigest })) } };
  assert.equal(projectProductReview(prior, executionReview).reviewPacket.nextAction.stage, "Thinking",
    "The current digest-bound completed-task correction is retained before another Execution");
});

test("same outcome bytes cannot let an old machine diagnosis replace the current same-scope review", async t => {
  const { artifact, input, evaluate } = await setup(t);
  input.observations[0].verdict = "fail";
  input.revisionRequests = [{ taskId: "producer", criterionId: "required", returnToStage: "Thinking", finding: "Old diagnosis", requiredChange: "Old change", evidenceRefs: ["report.txt"] }];
  const previous = await evaluate(input);
  artifact.machineExecution = { runId: artifact.runId, status: "waiting", outcome: structuredClone(previous.outcomeEvaluation),
    nextAction: { action: "revise", stage: "Thinking", revisionRequests: previous.revisionRequests.map(request => ({ ...request, reviewDigest: previous.reviewDigest })) } };
  const changed = structuredClone(input); changed.reviewRef = "fixture:revised-diagnosis";
  changed.revisionRequests[0].requiredChange = "Current evidenced change";
  const current = await evaluate(changed);
  assert.deepEqual(current.outcomeEvaluation, previous.outcomeEvaluation);
  const projected = projectProductReview(artifact, current);
  assert.match(projected.summaryPacket.nextAction, /Current evidenced change/u);
  assert.doesNotMatch(projected.summaryPacket.nextAction, /Old change/u);
});
