import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildTaskGoalContract, taskOutcomeDigest } from "../../src/domain/governance/task-outcome.mjs";
import { normalizeRequirementsDiscovery, normalizeProductDesign, projectDesignWorkerTasks, evaluateProductOutcomeReview, projectProductReview } from "../../scripts/governed-execution/product-design.mjs";
import { buildPlanChallengeState, selectReadyDecisionFrontier } from "../../scripts/governed-execution/plan-challenge-policy.mjs";
import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";
import { intentDialogueDigest } from "../../scripts/governed-execution/intent-dialogue.mjs";

const task = "Run meta-theory: inspect package.json and produce a durable report of the exact package name. Do not modify source files.";
const goal = buildTaskGoalContract({ task });
const dialogue = { taskHash: taskOutcomeDigest(task), intentDigest: null, status: "not_supplied", acceptanceCriteria: goal.acceptanceCriteria, settledDecisionRefs: [] };
const question = (id, resolutionClass = "material_user_decision", dependsOn = []) => ({ questionId: id, question: `Which concrete ${id} outcome?`, questionTarget: "wrong_goal_risk", decisionImpact: `Changes ${id} delivery`, impactPriority: 80, dependsOn, evidenceRefs: ["fixture:context"], resolutionClass, recommendedAnswer: "Keep the existing behavior", recommendationRationale: "Current project evidence supports it", options: [{ label: "Keep existing", tradeoff: "Maintains compatibility with a narrower scope" }, { label: "Replace", tradeoff: "Adds migration work and changes behavior" }] });
const discoveryInput = (items) => ({ schemaVersion: 1, taskHash: dialogue.taskHash, intentDigest: null, evidenceRefs: ["fixture:context"], decisionItems: items });
const response = (questionId, sequence, extra = {}) => ({ questionId, sequence, status: "answered", userAnswer: `Answer ${questionId}`, trusted: true, binding: `plan-challenge-response:${questionId}`, selectionBinding: `plan-challenge-selection:${questionId}`, evidenceRefs: ["requirementsDiscoveryPacket.evidenceRefs[0]"], ...extra });
function designInput() {
  return { schemaVersion: 1, taskHash: dialogue.taskHash, intentDigest: null, acceptanceDigest: goal.acceptanceDigest, designId: "package-inspection", revision: 1, mode: "delivery", sourceRefs: ["package.json"], settledDecisionRefs: [], domainTerms: [], userJourneys: [], artifactFlow: [],
    taskSlices: [{ id: "package-report", outcome: task, capabilityNeed: ["read package metadata"], scopeFiles: ["package.json"], inputRefs: ["package.json"], criterionIds: ["user-outcome"], dependsOn: [], journeyRefs: [], decisionRefs: [], deliverables: [{ id: "report", description: "Exact package name report", consumer: "User checking the package" }], verification: [{ criterionId: "user-outcome", procedure: "Compare the report to package.json", expectedEvidence: "Exact current package name" }], completionDemo: "Read the exact package name with its source", methodInputs: { currentSystem: "Existing package metadata" } }] };
}

test("PD-00 requirements discovery precedes design and exposes only dependency-ready material questions", () => {
  const input = discoveryInput([question("fact", "discoverable_fact"), question("format", "material_user_decision", ["fact"]), question("audience"), question("routine", "routine_design_decision")]);
  const discovery = normalizeRequirementsDiscovery({ input, dialogue });
  const first = buildPlanChallengeState({ task: "Help determine a product direction", decisionItems: discovery.decisionItems });
  assert.deepEqual(first.readyDecisionFrontier.map((item) => item.questionId), ["audience"]);
  assert.equal(first.pendingFactRequests[0].questionId, "fact");
  assert.equal(first.unresolvedQuestions.find((item) => item.questionId === "routine").status, "answered");
  assert.equal(first.planChallengeState.executionAllowed, false);
  const second = buildPlanChallengeState({ task: "Help determine a product direction", decisionItems: discovery.decisionItems, resolvedFacts: [{ questionId: "fact", value: "Current source confirms local storage", evidenceRefs: ["fixture:source"] }], settledDecisions: [{ decisionId: "audience", value: "One local user", evidenceRefs: ["fixture:synthetic-answer"] }] });
  assert.deepEqual(second.readyDecisionFrontier.map((item) => item.questionId), ["format"]);
  assert.equal(second.unresolvedQuestions.find((item) => item.questionId === "audience").resolutionSource, "existing_settled_decision");
  assert.throws(() => normalizeRequirementsDiscovery({ input: discoveryInput([{ ...question("bad"), userAnswer: "fake user" }]), dialogue }), /cannot assert userAnswer/);
});

test("pending factual dependency cannot claim the plan satisfied or demand a user answer", () => {
  const state = buildPlanChallengeState({ task: "Read current settings", decisionItems: [question("fact", "discoverable_fact"), question("decision", "material_user_decision", ["fact"])], sharedUnderstandingConfirmed: { trusted: true, binding: "plan-challenge-understanding-confirmation", evidenceRefs: ["fixture:understanding"] } });
  assert.equal(state.planChallengeState.phase, "awaiting_fact_discovery");
  assert.equal(state.planChallengeState.planChallengeSatisfied, false);
  assert.deepEqual(selectReadyDecisionFrontier(state.unresolvedQuestions), []);
});

test("one turn accepts its initial independent frontier but not newly unlocked successors", () => {
  const input = { task: "Read bounded requirements facts", decisionItems: [question("one"), question("two"), question("three", "material_user_decision", ["one"])] };
  const batch = buildPlanChallengeState({ ...input, responses: [response("one", 1), response("two", 2), response("three", 3)] });
  assert.deepEqual(batch.unresolvedQuestions.map((item) => [item.questionId, item.status]), [["one", "answered"], ["two", "answered"], ["three", "open"]]);
  assert.deepEqual(batch.planChallengeState.decisionEvidence.filter((item) => item.kind === "question_response").map((item) => item.sequence), [1, 2]);
  const next = buildPlanChallengeState({ ...input, responses: [response("one", 1, { historical: true }), response("two", 2, { historical: true }), response("three", 3)] });
  assert.equal(next.unresolvedQuestions.find((item) => item.questionId === "three").status, "answered");
  const invalid = buildPlanChallengeState({ ...input, responses: [response("one", 1, { selectionBinding: "another-question" }), response("two", 2), response("one", 2)] });
  assert.equal(invalid.unresolvedQuestions.find((item) => item.questionId === "one").status, "open");
  assert.equal(invalid.unresolvedQuestions.find((item) => item.questionId === "two").status, "answered");
  const interleaved = buildPlanChallengeState({ ...input, responses: [response("two", 1), response("one", 2, { historical: true }), response("three", 3)] });
  assert.equal(interleaved.unresolvedQuestions.find((item) => item.questionId === "three").status, "open", "Later claimed history cannot unlock a same-turn successor");
});

test("artifact consumers require a real direct or transitive producer dependency", () => {
  const input = designInput();
  input.taskSlices.push({ ...structuredClone(input.taskSlices[0]), id: "intermediate" }, { ...structuredClone(input.taskSlices[0]), id: "consumer" });
  input.artifactFlow = [{ id: "source-to-report", producerTaskId: "package-report", consumerTaskIds: ["consumer"], terminalArtifactRef: "report.md", sourceArtifactRefs: ["package.json"], scopeEvidenceRefs: ["fixture:source"], criterionIds: ["user-outcome"] }];
  assert.throws(() => normalizeProductDesign({ input, dialogue, goalContract: goal }), /consumer must depend/);
  input.taskSlices[2].dependsOn = ["package-report"];
  input.taskSlices[2].dependencyReasons = [{ taskId: "package-report", reason: "Consumes its verified source report" }];
  assert.equal(normalizeProductDesign({ input, dialogue, goalContract: goal }).readiness, "structure_ready_not_reviewed");
  input.taskSlices[1].dependsOn = ["package-report"];
  input.taskSlices[1].dependencyReasons = [{ taskId: "package-report", reason: "Transforms the source report" }];
  input.taskSlices[2].dependsOn = ["intermediate"];
  input.taskSlices[2].dependencyReasons = [{ taskId: "intermediate", reason: "Consumes the transformed report" }];
  assert.equal(normalizeProductDesign({ input, dialogue, goalContract: goal }).readiness, "structure_ready_not_reviewed");
  input.artifactFlow[0].consumerTaskIds = ["package-report"];
  assert.throws(() => normalizeProductDesign({ input, dialogue, goalContract: goal }), /consumer must depend/);
});

test("design retains full task and method inputs without permission or self-certified invocation", () => {
  const design = normalizeProductDesign({ input: designInput(), dialogue, goalContract: goal });
  const [worker] = projectDesignWorkerTasks({ design, runId: "run", templates: [{ ownerAgent: "discovered-review", workOrderReadiness: "ready", mutationPolicy: "read_only", finalizationGate: "host_action_required" }] });
  assert.equal(worker.coreProblem, task);
  assert.deepEqual(worker.scopeFiles, ["package.json"]);
  assert.deepEqual(worker.methodInputs, { currentSystem: "Existing package metadata" });
  assert.equal(worker.designBinding.designDigest, design.designDigest);
  assert.equal(worker.workOrderReadiness, "ready");
  assert.equal(design.nativeInvocationVerified, false);
  assert.throws(() => normalizeProductDesign({ input: { ...designInput(), nativeInvocationVerified: true }, dialogue, goalContract: goal }), /cannot assert/);
  const bad = designInput(); bad.taskSlices[0].ownerAgent = "injected-owner";
  assert.throws(() => normalizeProductDesign({ input: bad, dialogue, goalContract: goal }), /cannot assert ownerAgent/);
});

test("design change invalidates downstream tasks and retains unrelated reuse only as candidates", () => {
  const input = designInput();
  input.taskSlices.push({ ...structuredClone(input.taskSlices[0]), id: "consumer", dependsOn: ["package-report"], dependencyReasons: [{ taskId: "package-report", reason: "Consumes its exact metadata" }] });
  input.taskSlices.push({ ...structuredClone(input.taskSlices[0]), id: "independent" });
  input.revisionContext = { previousRunId: "old", previousDesignDigest: "old-design", changeEvidenceRefs: ["fixture:new-decision"], directlyAffectedTaskIds: ["package-report"], reuseCandidates: [{ previousTaskId: "independent", artifactRef: "unchanged.md", sha256: "a".repeat(64), reason: "No dependency, input or criterion changed" }] };
  const design = normalizeProductDesign({ input, dialogue, goalContract: goal });
  assert.deepEqual(design.revisionImpact.affectedTaskIds, ["consumer", "package-report"]);
  assert.equal(design.revisionImpact.reuseCandidates[0].status, "requires_current_binding_and_review");
  assert.throws(() => projectDesignWorkerTasks({ design, runId: "old", templates: [] }), /new run/);
  input.revisionContext.reuseCandidates[0].previousTaskId = "consumer";
  assert.throws(() => normalizeProductDesign({ input, dialogue, goalContract: goal }), /affected reuse/);
});

test("review checks current artifact bytes, produces actionable revision and never self-certifies invocation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-product-review-")); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "report.md"), "A prohibited case study.");
  const bytes = createHash("sha256").update("A prohibited case study.").digest("hex");
  const artifact = { runId: "review-run", goalContractPacket: goal, workerTaskPackets: [{ taskPacketId: "task-one", acceptanceCriterionIds: ["user-outcome"] }], reviewPacket: { findings: [] } };
  const input = { schemaVersion: 1, runId: "review-run", taskHash: goal.taskHash, intentDigest: null, acceptanceDigest: goal.acceptanceDigest, designDigest: null, reviewRef: "fixture:independent-review", artifactSnapshots: [{ ref: "report.md", sha256: bytes, producerTaskId: "task-one" }], observations: [{ criterionId: "user-outcome", artifactRefs: ["report.md"], taskHash: goal.taskHash, acceptanceDigest: goal.acceptanceDigest, evidenceKind: "independent_review", verdict: "fail", producer: "producer-instance", reviewer: "review-instance", evidenceRef: "fixture:report-line-one" }], revisionRequests: [{ taskId: "task-one", criterionId: "user-outcome", returnToStage: "Execution", finding: "Report contains an unwanted case study", requiredChange: "Rewrite as concepts only and check the reading copy", evidenceRefs: ["fixture:report-line-one"] }] };
  const review = await evaluateProductOutcomeReview({ input, artifact, projectRoot: root });
  const projected = projectProductReview(artifact, review);
  assert.equal(review.status, "fail");
  assert.equal(review.nativeInvocationVerified, false);
  assert.equal(projected.reviewPacket.findings[0].taskPacketId, "task-one");
  assert.equal(projected.reviewPacket.revisionNeeded, true);
  await writeFile(path.join(root, "report.md"), "Changed since review");
  await assert.rejects(evaluateProductOutcomeReview({ input, artifact, projectRoot: root }), /changed since review/);
});

test("actual runner consumes discovery before design and later review without replaying Execution", async (t) => {
  const fixture = createGovernanceRuntimeFixtureScope(t);
  const { runMetaTheoryGovernedExecution, readGovernedExecutionRun } = await fixture.import("scripts/run-meta-theory-governed-execution.mjs");
  const base = { task, stateDir: path.resolve("tmp/product"), dbPath: path.resolve("tmp/product.sqlite"), projectCapabilityMutationMode: "read_only" };
  const discovery = await runMetaTheoryGovernedExecution({ ...base, runId: "requirements-before-design", designRequired: true, requirementsDiscoveryInput: discoveryInput([question("audience")]) });
  assert.equal(discovery.productDesignPacket, null);
  assert.equal(discovery.designRequirementPacket.status, "thinking_handoff_required");
  assert.equal(discovery.preDecisionOptionFrame.readyDecisionFrontier[0].questionId, "audience");
  assert.equal(discovery.stageRunnerBridgePacket, null);
  const discoveryValidation = fixture.run(["scripts/validate-run-artifact.mjs", discovery.paths.json]);
  assert.equal(discoveryValidation.status, 0, discoveryValidation.stderr || discoveryValidation.stdout);
  const factItems = [question("fact", "discoverable_fact"), question("audience", "material_user_decision", ["fact"])];
  const factRun = await runMetaTheoryGovernedExecution({ ...base, runId: "facts-pending", designRequired: true, requirementsDiscoveryInput: discoveryInput(factItems) });
  assert.equal(factRun.preDecisionOptionFrame.planChallengeState.phase, "awaiting_fact_discovery");
  const resolvedDiscovery = { ...discoveryInput(factItems), resolvedFacts: [{ questionId: "fact", value: "Existing source is local", evidenceRefs: ["package.json"] }] };
  const answeredRun = await runMetaTheoryGovernedExecution({ ...base, runId: "facts-resolved", previousPlanChallengeRunId: factRun.runId, designRequired: true, requirementsDiscoveryInput: resolvedDiscovery, planChallengeResponses: [response("audience", 1, { taskHash: dialogue.taskHash, intentDigest: null })] });
  assert.equal(answeredRun.taskFingerprint, factRun.taskFingerprint);
  assert.notEqual(answeredRun.requirementsDiscoveryPacket.discoveryDigest, factRun.requirementsDiscoveryPacket.discoveryDigest);
  assert.equal(answeredRun.preDecisionOptionFrame.unresolvedQuestions.find((item) => item.questionId === "audience").status, "answered");
  const expandedDiscovery = { ...resolvedDiscovery, decisionItems: [...factItems, question("reading-mode", "material_user_decision", ["audience"])] };
  const continued = await runMetaTheoryGovernedExecution({ ...base, runId: "requirements-expanded", previousPlanChallengeRunId: answeredRun.runId, designRequired: true, requirementsDiscoveryInput: expandedDiscovery, priorChallengeState: { ...answeredRun.preDecisionOptionFrame, taskHash: dialogue.taskHash, intentDigest: null, trusted: true } });
  assert.equal(continued.taskFingerprint, factRun.taskFingerprint);
  assert.equal(continued.preDecisionOptionFrame.unresolvedQuestions.find((item) => item.questionId === "audience").status, "answered");
  assert.deepEqual(continued.preDecisionOptionFrame.readyDecisionFrontier.map((item) => item.questionId), ["reading-mode"]);
  assert.equal(continued.preDecisionOptionFrame.planChallengeState.decisionEvidence.find((item) => item.kind === "question_response").historical, true);
  const { loadPlanChallengeContinuationCandidate, bindVerifiedHostPlanChallengeDecision } = await fixture.import("scripts/governed-execution/plan-challenge-host-continuation.mjs");
  const candidateOptions = { artifactPath: factRun.paths.json, previousRunId: factRun.runId, taskFingerprint: factRun.taskFingerprint, taskHash: dialogue.taskHash, intentDigest: null };
  const candidate = await loadPlanChallengeContinuationCandidate(candidateOptions);
  assert.equal(candidate.planChallengeState.phase, "awaiting_fact_discovery");
  assert.equal(candidate.trusted, undefined, "Disk validation never becomes host authorization");
  await assert.rejects(loadPlanChallengeContinuationCandidate({ ...candidateOptions, intentDigest: "changed-intent" }), /intent binding mismatch/);
  assert.equal(bindVerifiedHostPlanChallengeDecision({ verifiedDecision: { trusted: true }, continuationCandidate: candidate }).accepted, false);
  const confirmedIntent = { taskHash: dialogue.taskHash, outcome: task, evidenceRefs: ["fixture:host-conversation"], settledDecisions: [{ decisionId: "audience", value: "One local user", evidenceRefs: ["fixture:existing-user-decision"] }] };
  const intentDigest = intentDialogueDigest(confirmedIntent);
  const settledRun = await runMetaTheoryGovernedExecution({ ...base, runId: "requirements-settled-host", designRequired: true, confirmedIntent,
    sharedUnderstandingConfirmed: { trusted: true, binding: "plan-challenge-understanding-confirmation", taskHash: dialogue.taskHash, intentDigest, evidenceRefs: confirmedIntent.evidenceRefs },
    requirementsDiscoveryInput: { ...discoveryInput([question("audience"), question("routine", "routine_design_decision"), question("format", "material_user_decision", ["audience"])]), intentDigest } });
  assert.equal(settledRun.preDecisionOptionFrame.intentBinding.status, "host_provided_understanding");
  const settledAudience = settledRun.preDecisionOptionFrame.unresolvedQuestions.find((item) => item.questionId === "audience");
  assert.equal(settledAudience.resolutionSource, "existing_settled_decision");
  assert.deepEqual(settledAudience.answerEvidenceRefs, ["preDecisionOptionFrame.intentBinding.settledDecisionRefs[0].evidenceRefs[0]"]);
  const settledValidation = fixture.run(["scripts/validate-run-artifact.mjs", settledRun.paths.json]);
  assert.equal(settledValidation.status, 0, settledValidation.stderr || settledValidation.stdout);
  const first = await runMetaTheoryGovernedExecution({ ...base, runId: "product-design-run", designInput: designInput() });
  await assert.rejects(loadPlanChallengeContinuationCandidate({ artifactPath: first.paths.json, previousRunId: first.runId, taskFingerprint: first.taskFingerprint, taskHash: dialogue.taskHash, intentDigest: null }), /cannot resume terminal phase/);
  assert.equal(first.workerTaskPackets.length, 1);
  assert.equal(first.workerTaskPackets[0].designBinding.sliceId, "package-report");
  assert.equal(first.workerTaskPackets[0].workOrderReadiness, "ready");
  assert.deepEqual(first.workerTaskPackets[0].methodInputs, designInput().taskSlices[0].methodInputs);
  const designValidation = fixture.run(["scripts/validate-run-artifact.mjs", first.paths.json]);
  assert.equal(designValidation.status, 0, designValidation.stderr || designValidation.stdout);
  const original = await readFile(first.paths.json, "utf8");
  await writeFile("tmp/final-report.md", "Source-bound package name report");
  const hash = createHash("sha256").update("Source-bound package name report").digest("hex");
  const currentGoal = first.goalContractPacket;
  const review = { schemaVersion: 1, runId: first.runId, taskHash: currentGoal.taskHash, intentDigest: null, acceptanceDigest: currentGoal.acceptanceDigest, designDigest: first.productDesignPacket.designDigest, reviewRef: "fixture:review", artifactSnapshots: [{ ref: "tmp/final-report.md", sha256: hash, producerTaskId: first.workerTaskPackets[0].taskPacketId }], observations: [{ criterionId: "user-outcome", artifactRefs: ["tmp/final-report.md"], taskHash: currentGoal.taskHash, acceptanceDigest: currentGoal.acceptanceDigest, evidenceKind: "independent_review", verdict: "pass", producer: "fixture-producer", reviewer: "fixture-reviewer", evidenceRef: "fixture:assessment" }] };
  const reviewed = await runMetaTheoryGovernedExecution({ ...base, runId: first.runId, designInput: designInput(), outcomeReviewInput: review });
  assert.equal(reviewed.traceEvalControlPlane.outcomeEvaluation.status, "pass");
  assert.equal(reviewed.outcomeReviewPacket.nativeInvocationVerified, false);
  assert.equal(await readFile(first.paths.json, "utf8"), original);
  assert.equal(reviewed.stageRunnerBridgePacket, null);
  assert.notEqual(reviewed.paths.json, first.paths.json);
  const latestAfterReview = JSON.parse(await readFile(first.paths.latest, "utf8"));
  const liveAfterReview = await readFile(reviewed.paths.liveProjection);
  assert.equal(latestAfterReview.runId, first.runId);
  assert.equal(latestAfterReview.liveProjectionSha256, createHash("sha256").update(liveAfterReview).digest("hex"));
  assert.equal(latestAfterReview.liveProjectionBytes, liveAfterReview.length);
  const reopened = await readGovernedExecutionRun({ runId: first.runId, stateDir: base.stateDir });
  assert.equal(reopened.artifact.outcomeReviewPacket.status, "pass");
  let calls = 0;
  const stageRunner = { enabled: true, capacity: 1, durableDbPath: path.resolve("tmp/design-durable.sqlite"), invokeWorker: async () => {
    calls++;
    const outputText = "Synthetic transport test only; not a native or semantic success claim.";
    return { status: "pass", outputText, outputSha256: createHash("sha256").update(outputText).digest("hex"), runtimeProcessInvoked: false, durationMs: 1 };
  } };
  const executed = await runMetaTheoryGovernedExecution({ ...base, runId: "design-durable", designInput: designInput(), stageRunner });
  assert.equal(executed.stageRunnerBridgePacket.status, "pass", JSON.stringify({ failure: executed.stageRunnerBridgePacket.failure, gate: executed.stageRunnerBridgePacket.routeExecutionGate }));
  assert.equal(calls, 1);
  const newerLatest = await readFile(first.paths.latest, "utf8");
  await runMetaTheoryGovernedExecution({ ...base, runId: first.runId, designInput: designInput(), outcomeReviewInput: review });
  assert.equal(await readFile(first.paths.latest, "utf8"), newerLatest, "Reviewing an older run leaves the newer latest pointer unchanged");
  const durableReview = { ...review, runId: executed.runId, artifactSnapshots: [{ ...review.artifactSnapshots[0], producerTaskId: executed.workerTaskPackets[0].taskPacketId }] };
  const resume = { ...base, runId: executed.runId, designInput: designInput(), stageRunner: { ...stageRunner, durableMode: "resume" } };
  const resumed = await runMetaTheoryGovernedExecution({ ...resume, outcomeReviewInput: durableReview });
  assert.equal(resumed.outcomeReviewPacket.status, "pass");
  assert.equal(calls, 1, "Attaching review never replays a committed worker");
  const resumedAgain = await runMetaTheoryGovernedExecution(resume);
  assert.equal(resumedAgain.outcomeReviewPacket.status, "pass");
  assert.equal(calls, 1);
  const changed = designInput(); changed.revision++;
  await assert.rejects(runMetaTheoryGovernedExecution({ ...resume, designInput: changed }), /fingerprint|identity/);
  await writeFile("tmp/requirements.json", JSON.stringify(discoveryInput([question("audience")])));
  const cli = fixture.run(["scripts/run-meta-theory-governed-execution.mjs", "--task", task, "--run-id", "cli-requirements", "--state-dir", "tmp/cli-product", "--db", "tmp/cli-product.sqlite", "--requirements-discovery-input", "tmp/requirements.json", "--design-required", "--read-only"]);
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
});
