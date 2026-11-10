import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { taskOutcomeDigest } from "../../src/domain/governance/task-outcome.mjs";
import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";
import { fixtureCritical, refreshFixtureSourcePins } from "../helpers/host-reasoning-fixture.mjs";
import { readOnlyFixtureTaskFacts } from "../helpers/task-design-facts.mjs";

test("artifact validation rejects a premature decision and hidden fact request in the actual packet fields", async (t) => {
  const fixture = createGovernanceRuntimeFixtureScope(t);
  refreshFixtureSourcePins(fixture);
  const { runMetaTheoryGovernedExecution } = await fixture.import("scripts/run-meta-theory-governed-execution.mjs");
  const initialTask = "Should we build report A or report B? Compare the current package without changing files.";
  const initial = await runMetaTheoryGovernedExecution({ task: initialTask, runId: "initial-before-critical",
    stateDir: path.resolve("tmp/initial-frontier"), dbPath: path.resolve("tmp/initial-frontier.sqlite"), projectCapabilityMutationMode: "read_only" });
  assert.deepEqual(initial.preDecisionOptionFrame.unresolvedQuestions, [], "Lexical possibilities do not become actual host questions");
  assert.equal(initial.preDecisionOptionFrame.planChallengeState.selectedQuestionId, null);
  assert.equal(initial.preDecisionOptionFrame.planChallengeState.currentQuestion, null);
  assert.equal(initial.preDecisionOptionFrame.planChallengeState.pendingUserChoice.status, "not_required");
  assert.equal(initial.hostInvocationRequestPacket.nextAction.action, "produce_current_critical_understanding");
  const initialCheck = fixture.run(["scripts/validate-run-artifact.mjs", initial.paths.json]);
  assert.equal(initialCheck.status, 0, initialCheck.stderr || initialCheck.stdout);
  const task = "Run meta-theory: inspect package.json and produce a durable report of the exact package name. Do not modify source files.";
  const question = (id, resolutionClass, dependsOn = []) => ({
    questionId: id, question: `Which ${id} outcome?`, questionTarget: "wrong_goal_risk",
    decisionImpact: "Changes the deliverable", impactPriority: 80, dependsOn,
    evidenceRefs: ["fixture:source"], resolutionClass, recommendedAnswer: "Keep existing",
    recommendationRationale: "Preserves the known workflow",
    options: [{ label: "Keep existing", tradeoff: "Preserves compatibility" }, { label: "Replace", tradeoff: "Requires migration" }],
  });
  const artifact = await runMetaTheoryGovernedExecution({
    task, runId: "frontier-validation", stateDir: path.resolve("tmp/frontier"),
    dbPath: path.resolve("tmp/frontier.sqlite"), projectCapabilityMutationMode: "read_only",
    designRequired: true, criticalInput: fixtureCritical({ task, successCriteria: [task] }), governanceTaskFacts: readOnlyFixtureTaskFacts(task),
    requirementsDiscoveryInput: { schemaVersion: 1, taskHash: taskOutcomeDigest(task), intentDigest: null,
      evidenceRefs: ["fixture:source"], decisionItems: [question("fact", "discoverable_fact"), question("choice", "material_user_decision", ["fact"])] },
  });
  const original = JSON.parse(await readFile(artifact.paths.json, "utf8"));
  const valid = fixture.run(["scripts/validate-run-artifact.mjs", artifact.paths.json]);
  assert.equal(valid.status, 0, valid.stderr || valid.stdout);
  assert.equal(JSON.parse(valid.stdout).artifactKind, "host_preparation");
  for (const [name, mutate, reason] of [
    ["premature-choice", (packet) => { packet.readyDecisionFrontier = [{ questionId: "choice" }]; }, /readyDecisionFrontier/],
    ["hidden-fact", (packet) => { packet.pendingFactRequests = []; }, /pendingFactRequests/],
    ["missing-frontier", (packet) => { delete packet.readyDecisionFrontier; }, /readyDecisionFrontier/],
    ["missing-fact-ledger", (packet) => { delete packet.pendingFactRequests; }, /pendingFactRequests/],
  ]) {
    const altered = structuredClone(original);
    mutate(altered.preDecisionOptionFrame);
    const file = path.join(path.dirname(artifact.paths.json), `${name}.json`);
    await writeFile(file, JSON.stringify(altered));
    const result = fixture.run(["scripts/validate-run-artifact.mjs", file]);
    assert.notEqual(result.status, 0, `${name} must fail validation`);
    assert.match(result.stderr + result.stdout, reason);
  }
  for (const [name, mutate, reason] of [
    ["changed-binding", artifact => { artifact.preparation.bindingDigest = "0".repeat(64); }, /Critical binding digest mismatch/],
    ["changed-frame-intent", artifact => { artifact.preDecisionOptionFrame.intentBinding.outcome = "Unconfirmed replacement outcome"; }, /decision frame.*intent binding/],
    ["invented-workers", artifact => { artifact.workerTaskPackets = [{ taskPacketId: "invented" }]; }, /must not contain formal workers/],
    ["invented-dag", artifact => { artifact.coreLoop.stageDagPacket = { nodes: [] }; }, /must not contain formal workers/],
  ]) {
    const altered = structuredClone(original);
    mutate(altered);
    const file = path.join(path.dirname(artifact.paths.json), `${name}.json`);
    await writeFile(file, JSON.stringify(altered));
    const result = fixture.run(["scripts/validate-run-artifact.mjs", file]);
    assert.notEqual(result.status, 0, `${name} must fail validation`);
    assert.match(result.stderr + result.stdout, reason);
  }
  const markdown = await readFile(artifact.paths.markdown, "utf8");
  try {
    await writeFile(artifact.paths.markdown, markdown + "Unbound appended instructions.\n");
    const changedPair = fixture.run(["scripts/validate-run-artifact.mjs", artifact.paths.json]);
    assert.notEqual(changedPair.status, 0);
    assert.match(changedPair.stderr + changedPair.stdout, /paired markdown digest mismatch/);
  } finally { await writeFile(artifact.paths.markdown, markdown); }
  const { loadPlanChallengeContinuationCandidate } = await fixture.import("scripts/governed-execution/plan-challenge-host-continuation.mjs");
  const continuation = { artifactPath: artifact.paths.json, previousRunId: artifact.runId,
    taskFingerprint: artifact.taskFingerprint, taskHash: taskOutcomeDigest(task), intentDigest: null };
  assert.equal((await loadPlanChallengeContinuationCandidate(continuation)).planChallengeState.phase, "awaiting_fact_discovery");
  await assert.rejects(loadPlanChallengeContinuationCandidate({ ...continuation,
    artifactPath: path.join(path.dirname(artifact.paths.json), "hidden-fact.json") }), /pendingFactRequests/,
  "Continuation reads use the same validator rather than trusting a stored partial frame");
  const resolved = await runMetaTheoryGovernedExecution({
    task, runId: "resolved-frontier-validation", stateDir: path.resolve("tmp/frontier"),
    dbPath: path.resolve("tmp/frontier.sqlite"), projectCapabilityMutationMode: "read_only",
    designRequired: true, criticalInput: fixtureCritical({ task, successCriteria: [task] }), governanceTaskFacts: readOnlyFixtureTaskFacts(task),
    requirementsDiscoveryInput: { schemaVersion: 1, taskHash: taskOutcomeDigest(task), intentDigest: null,
      evidenceRefs: ["fixture:source"],
      decisionItems: [question("fact", "discoverable_fact"), question("routine", "routine_design_decision"), question("choice", "material_user_decision", ["fact"])],
      resolvedFacts: [{ questionId: "fact", value: "Source is package.json", evidenceRefs: ["fixture:source"] }] },
  });
  const resolvedOriginal = JSON.parse(await readFile(resolved.paths.json, "utf8"));
  const resolvedCheck = fixture.run(["scripts/validate-run-artifact.mjs", resolved.paths.json]);
  assert.equal(resolvedCheck.status, 0, resolvedCheck.stderr || resolvedCheck.stdout);
  for (const [name, mutate, reason] of [
    ["changed-fact-answer", (packet) => { packet.unresolvedQuestions.find((q) => q.questionId === "fact").userAnswer = "Invented source"; }, /dynamic answer/],
    ["routine-as-user-choice", (packet) => { packet.unresolvedQuestions.find((q) => q.questionId === "routine").resolutionClass = "material_user_decision"; }, /routine recommendation/],
  ]) {
    const altered = structuredClone(resolvedOriginal);
    mutate(altered.preDecisionOptionFrame);
    const file = path.join(path.dirname(resolved.paths.json), `${name}.json`);
    await writeFile(file, JSON.stringify(altered));
    const result = fixture.run(["scripts/validate-run-artifact.mjs", file]);
    assert.notEqual(result.status, 0, `${name} must fail validation`);
    assert.match(result.stderr + result.stdout, reason);
  }
});
