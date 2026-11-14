import assert from "node:assert/strict";
import test from "node:test";
import { buildPlanChallengeState } from "../../scripts/governed-execution/plan-challenge-policy.mjs";
import { taskOutcomeDigest } from "../../src/domain/governance/task-outcome.mjs";
import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";
import { fixtureCritical, fixtureReadWorkOrder, fixtureThinkingInput, refreshFixtureSourcePins } from "../helpers/host-reasoning-fixture.mjs";
import { localProtocolFixtureTaskFacts } from "../helpers/task-design-facts.mjs";

test("assessed pre-order experience scope does not become a purchase commitment and actual purchase still needs authorization", () => {
  const task = "先把选款到下单前的体验做好";
  const actionScope = { taskHash: taskOutcomeDigest(task), actions: [], evidenceRefs: ["task:assessed-pre-order-scope"] };
  const plan = buildPlanChallengeState({ task, actionScope });
  assert.deepEqual(plan.planChallengeState.sideEffectActions, []);
  assert.equal(plan.planChallengeState.authorizationRequired, false);
  const purchase = buildPlanChallengeState({ task, actionScope, requestedSideEffectActions: ["purchase_commitment"] });
  assert.ok(purchase.planChallengeState.sideEffectActions.includes("purchase_commitment"));
  assert.equal(purchase.planChallengeState.authorizationRequired, true);
  assert.equal(purchase.planChallengeState.executionAllowed, false);
  assert.throws(() => buildPlanChallengeState({ task, actionScope: { ...actionScope, taskHash: "0".repeat(64) } }), /task scope binding/u);
});

test("ordinary host entry consumes current action scope for pre-order design without changing the original words", async t => {
  const fixture = createGovernanceRuntimeFixtureScope(t); refreshFixtureSourcePins(fixture);
  const { runMetaTheoryGovernedExecution: run } = await fixture.import("scripts/run-meta-theory-governed-execution.mjs");
  const task = "先把选款到下单前的体验做好";
  const criticalInput = fixtureCritical({ task, successCriteria: ["People can choose a garment before making a purchase"], nonGoals: ["No actual ordering, payment or purchase"] });
  const base = { task, runtime: "codex", projectRoot: fixture.repoRoot, stateDir: "tmp/pre-order-scope", dbPath: "tmp/pre-order-scope.sqlite", criticalInput,
    governanceTaskFacts: localProtocolFixtureTaskFacts(task) };
  const prepared = await run({ ...base, runId: "pre-order-fetch" });
  const order = fixtureReadWorkOrder(prepared, { id: "scope-diagnosis", todayTask: task, output: "Scope findings for the pre-order experience", criterionIds: ["user-outcome"], taskFacts: base.governanceTaskFacts });
  const result = await run({ ...base, runId: "pre-order-thinking", previousPlanChallengeRunId: prepared.runId,
    thinkingInput: fixtureThinkingInput(prepared, { criticalInput, workOrders: () => [order] }) });
  assert.deepEqual(result.preDecisionOptionFrame.planChallengeState.sideEffectActions, []);
  assert.equal(result.preDecisionOptionFrame.planChallengeState.authorizationRequired, false);
  assert.notEqual(result.preDecisionOptionFrame.planChallengeState.pendingUserChoice.status, "required_not_invoked");
  assert.equal(result.workerTaskPackets[0].workOrderReadiness, "ready");
  assert.equal(result.coreLoop.requestRecord.entryClassification.governedEntry, true,
    "Current task-bound host work assessment must replace a low-signal vocabulary default");
  assert.equal(result.coreLoop.requestRecord.entryClassification.triggerReason, "current_host_assessed_work");
  assert.equal(result.coreLoop.requestRecord.entryClassification.lexicalClassification.taskClassification, "unclassified_low_signal");
});
