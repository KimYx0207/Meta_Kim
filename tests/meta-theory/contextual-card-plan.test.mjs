import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { insertHighCostCardPauses, projectContextualCardPlan } from "../../scripts/governed-execution/contextual-card-plan.mjs";
import { taskOutcomeDigest } from "../../src/domain/governance/task-outcome.mjs";
import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";
import { fixtureCritical, refreshFixtureSourcePins } from "../helpers/host-reasoning-fixture.mjs";
import { readOnlyFixtureTaskFacts } from "../helpers/task-design-facts.mjs";

const catalog = Object.entries({
  clarify: "low", "shrink-scope": "low", options: "mid", execute: "high", verify: "mid",
  fix: "mid", rollback: "high", risk: "high", nudge: "low", pause: "zero",
}).map(([id, cost]) => ({ id, cost }));

const options = [{ label: "Keep the existing workflow" }, { label: "Replace it with a new workflow" }];
const question = (questionId, overrides = {}) => ({
  questionId, resolutionClass: "material_user_decision", status: "open", dependsOn: [],
  question: `Choose ${questionId}`, impactPriority: 50, options, ...overrides,
});
function project({ questions = [], challenge = {}, report = {}, evidence = {}, frame = {} } = {}) {
  return projectContextualCardPlan({
    orchestrationReport: { workerTaskPackets: [], capabilityGaps: [], reviewResult: { status: "pass" }, ...report },
    runtimeEvidence: { results: [], ...evidence }, cardTypeCatalog: catalog,
    preDecisionOptionFrame: { unresolvedQuestions: questions, planChallengeState: challenge, ...frame },
  });
}

test("a clear authorized task continues without inventing questions, nudges or pauses", () => {
  const result = project({ report: { workerTaskPackets: [{ taskPacketId: "work" }],
    fetchEvidence: { capabilityInventory: [{ id: "one" }, { id: "two" }, { id: "three" }] },
    summaryPacket: { nextAction: "Continue the authorized task" } },
  evidence: { results: [{ strictReleasePass: true }] } });
  assert.deepEqual(result.activeOrder, ["execute", "verify"]);
  assert.deepEqual(result.pauseReasons, []);
  assert.equal(result.selectedQuestionId, null);
  assert.equal(result.context.userNextStepNeeded, false);
  assert.equal(result.rejoinCondition, "no_pause_required");
});

test("answered and skipped questions are not reopened by stale presentation pointers", () => {
  const result = project({ questions: [question("answered", { status: "answered", userAnswer: "Keep" }),
    question("skipped", { status: "skipped" })],
  frame: { readyDecisionFrontier: [question("answered")],
    planChallengeState: { active: true, phase: "awaiting_user_answer", selectedQuestionId: "answered" } } });
  assert.equal(result.selectedQuestionId, null);
  assert.deepEqual(result.activeOrder, []);
  assert.equal(result.choiceSuppressionReason, "already_known");
});

test("only one dependency-ready material decision is surfaced and answers are retained", () => {
  const questions = [question("direction"), question("detail", { dependsOn: ["direction"], impactPriority: 100 })];
  const before = structuredClone(questions);
  const first = project({ questions });
  assert.equal(first.selectedQuestionId, "direction", "A dependent high-impact question cannot jump ahead");
  assert.deepEqual(first.activeOrder, ["options", "pause"]);
  assert.deepEqual(first.pauseReasons, ["user_decision_window"]);
  assert.equal(first.questionEvidenceRef, "preDecisionOptionFrame.unresolvedQuestions[0]");
  assert.deepEqual(questions, before, "Projection must not mutate the authoritative question ledger");

  const answeredDirection = { ...questions[0], status: "answered", userAnswer: "Keep existing" };
  const second = project({ questions: [answeredDirection, questions[1]] });
  assert.equal(second.selectedQuestionId, "detail");
  assert.deepEqual(second.activeOrder, ["options", "pause"]);
  const complete = project({ questions: [answeredDirection, { ...questions[1], status: "answered", userAnswer: "Keep" }] });
  assert.deepEqual(complete.activeOrder, []);
  assert.equal(complete.context.userDecisionNeeded, false);
});

test("discoverable facts and routine design choices stay with the host until the material frontier is ready", () => {
  const fact = question("source-version", { resolutionClass: "discoverable_fact" });
  const routine = question("internal-owner", { resolutionClass: "routine_design_decision", impactPriority: 100 });
  const decision = question("compatibility", { dependsOn: [fact.questionId] });
  const pending = project({ questions: [fact, routine, decision] });
  assert.deepEqual(pending.activeOrder, []);
  assert.equal(pending.choiceSuppressionReason, "verification_pending");
  const ready = project({ questions: [{ ...fact, status: "answered", userAnswer: "Verified source" }, routine, decision] });
  assert.equal(ready.selectedQuestionId, "compatibility");
  assert.deepEqual(ready.activeOrder, ["options", "pause"]);
});

test("an unresolved material question without alternatives uses one clarify card", () => {
  const result = project({ questions: [question("acceptance", { options: [] }), question("later", { impactPriority: 10 })] });
  assert.equal(result.selectedQuestionId, "acceptance");
  assert.deepEqual(result.activeOrder, ["clarify", "pause"]);
  assert.equal(result.context.optionsNeeded, false);
  assert.equal(result.context.userNextStepNeeded, false, "A question does not also need a duplicate nudge");
});

test("a nudge reflects only an existing pending host action and explicit stops do not ask again", () => {
  const challenge = { active: true, phase: "awaiting_understanding_confirmation",
    pendingUserChoice: { status: "required_not_invoked", question: {
      binding: "plan-challenge-understanding-confirmation", displayText: "Confirm the changed outcome" } } };
  const pending = project({ challenge });
  assert.deepEqual(pending.activeOrder, ["nudge", "pause"]);
  assert.equal(pending.rejoinCondition, "after_current_user_decision");
  assert.deepEqual(project({ challenge: { ...challenge, pendingUserChoice: { status: "not_required" } } }).activeOrder, []);
  assert.deepEqual(project({ questions: [question("pending")], challenge: { ...challenge, stopRequested: true } }).activeOrder, []);
});

test("runtime risk still preempts ordinary work without making unrelated questions", () => {
  const result = project({ report: { workerTaskPackets: [{ taskPacketId: "work" }], capabilityGaps: [{ blocked: true }] },
    evidence: { results: [{ strictReleasePass: false }] } });
  assert.deepEqual(result.activeOrder, ["risk", "execute", "verify", "rollback"]);
  assert.equal(result.context.runtimeRisk, true);
  assert.equal(result.context.highCostActiveBeforePause, 2);
  assert.deepEqual(result.pauseReasons, [], "Three total high-cost cards are not three consecutive cards");
});

test("the third consecutive high-cost card inserts a presentation pause before the next card", () => {
  const consecutive = insertHighCostCardPauses(["risk", "execute", "rollback", "verify"], catalog);
  assert.deepEqual(consecutive.activeOrder, ["risk", "execute", "rollback", "pause", "verify"]);
  assert.equal(consecutive.maximumConsecutiveHighCost, 3);
  assert.deepEqual(consecutive.pauseReasons, ["high_cost_control_window"]);
  const separated = insertHighCostCardPauses(["risk", "verify", "execute", "fix", "rollback"], catalog);
  assert.deepEqual(separated.pauseReasons, []);
  assert.equal(separated.maximumConsecutiveHighCost, 1);
});

test("a presentation pause resets the streak and never modifies execution authority", () => {
  const input = { orchestrationReport: { workerTaskPackets: [], capabilityGaps: [], reviewResult: { status: "pass" },
    selectedExecutionRoute: { routeExecutionGate: { canHandoffToHost: false } } }, runtimeEvidence: { results: [] },
  preDecisionOptionFrame: { unresolvedQuestions: [question("scope")], planChallengeState: { executionAllowed: false } },
  cardTypeCatalog: catalog };
  const snapshot = structuredClone(input);
  projectContextualCardPlan(input);
  assert.deepEqual(input, snapshot);
  const repeated = insertHighCostCardPauses(["risk", "execute", "rollback", "risk", "execute", "rollback"], catalog);
  assert.deepEqual(repeated.activeOrder, ["risk", "execute", "rollback", "pause", "risk", "execute", "rollback", "pause"]);
});

test("the real preparation entry exposes a material card only after its source fact is resolved", async (t) => {
  const fixture = createGovernanceRuntimeFixtureScope(t);
  refreshFixtureSourcePins(fixture);
  const { runMetaTheoryGovernedExecution } = await fixture.import("scripts/run-meta-theory-governed-execution.mjs");
  const task = "Run meta-theory: inspect package.json and produce a durable report of its current compatibility; do not change source files.";
  const sourceFact = { questionId: "source-version", question: "Which source version is installed?",
    resolutionClass: "discoverable_fact", impactPriority: 50, dependsOn: [],
    questionTarget: "wrong_goal_risk", decisionImpact: "Changes compatibility advice", evidenceRefs: ["fixture:source"],
    recommendedAnswer: "Keep existing", recommendationRationale: "Preserves the known workflow",
    options: [{ label: "Keep existing", tradeoff: "Preserves compatibility" }, { label: "Replace", tradeoff: "Requires migration" }] };
  const decision = { ...sourceFact, questionId: "compatibility", resolutionClass: "material_user_decision", dependsOn: [sourceFact.questionId] };
  const input = { task, stateDir: path.resolve("tmp/contextual-cards"), dbPath: path.resolve("tmp/contextual-cards.sqlite"),
    projectCapabilityMutationMode: "read_only", designRequired: true,
    criticalInput: fixtureCritical({ task, successCriteria: [task] }), governanceTaskFacts: readOnlyFixtureTaskFacts(task),
    requirementsDiscoveryInput: { schemaVersion: 1, taskHash: taskOutcomeDigest(task), intentDigest: null,
      evidenceRefs: ["fixture:source"], decisionItems: [sourceFact, decision] } };
  const pending = await runMetaTheoryGovernedExecution({ ...input, runId: "cards-before-fact" });
  assert.deepEqual(project({ frame: pending.preDecisionOptionFrame }).activeOrder, []);
  assert.deepEqual(pending.preDecisionOptionFrame.readyDecisionFrontier, []);
  assert.equal(pending.preDecisionOptionFrame.pendingFactRequests[0].questionId, sourceFact.questionId);

  const resolved = await runMetaTheoryGovernedExecution({ ...input, runId: "cards-after-fact",
    requirementsDiscoveryInput: { ...input.requirementsDiscoveryInput,
      resolvedFacts: [{ questionId: sourceFact.questionId, value: "Current source inspected", evidenceRefs: ["fixture:source"] }] } });
  const cards = project({ frame: resolved.preDecisionOptionFrame });
  assert.equal(cards.selectedQuestionId, decision.questionId);
  assert.deepEqual(cards.activeOrder, ["options", "pause"]);
  assert.equal(resolved.hostInvocationRequestPacket.executionAllowed, false,
    "Projecting a card is not native choice completion or worker permission");
});
