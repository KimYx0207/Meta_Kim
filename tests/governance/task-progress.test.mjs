import assert from "node:assert/strict";
import test from "node:test";
import {
  checkedTaskProgress, projectTaskProgress, recordTaskProgress, recordTaskProgressCorrection,
  taskProgressGoal, taskProgressRoute, taskProgressEvidenceBasis,
} from "../../canonical/runtime-assets/shared/hooks/task-progress.mjs";

const goal = taskProgressGoal({ realIntent: "Deliver a working update", successCriteria: ["Update reaches its target date", "Keep existing data"] });
const packet = { taskPacketId: "update-task", ownerAgent: "backend", capabilityId: "method:update",
  methodCapabilityId: "method:update", weapon: "Run the existing updater", strategyRef: { id: "method:update-v1", sha256: "a".repeat(64) },
  acceptanceCriterionIds: goal.criteria.map((criterion) => criterion.criterionId) };
const basisEvidence = [{ ref: "actual-input.json", sha256: "b".repeat(64) }];
const raw = (attemptId, classification, extra = {}) => ({ attemptId, criterionId: goal.criteria[0].criterionId,
  classification, basisEvidence, resultRef: "actual-result.json", resultDigest: "c".repeat(64), evidenceRefs: ["actual-result.json"],
  ...(classification === "ineffective" ? { failureClass: "execution_failed" } : {}),
  ...(["waiting", "question", "paused", "unresolved"].includes(classification) ? { waitReason: "Actual resource or transport state" } : {}),
  ...(classification === "progress" ? { criterionEvidence: [{ ref: "criterion-evidence.json", sha256: "d".repeat(64) }] } : {}), ...extra });
const record = (ledger, attemptId, classification, extra = {}, task = packet) => recordTaskProgress(ledger, checkedTaskProgress(raw(attemptId, classification, extra), task, goal));

test("real attempt registration, JSON restart and terminal replay do not mint new attempts", () => {
  assert.throws(() => record(undefined, "first", "ineffective"), /started_attempt_required/);
  let ledger = record(undefined, "first", "running").ledger;
  ledger = record(ledger, "first", "ineffective").ledger;
  const restarted = JSON.parse(JSON.stringify(ledger));
  const replay = record(restarted, "first", "ineffective", { evidenceRefs: ["renamed-result.json"], resultRef: "renamed-result.json" });
  assert.equal(replay.changed, false);
  assert.equal(projectTaskProgress(replay.ledger, goal.goalDigest, packet.taskPacketId).terminalAttempts, 1);
  assert.throws(() => record(restarted, "first", "progress"), /attempt_conflict/);
  assert.throws(() => record(restarted, "unknown", "ineffective"), /started_attempt_required/);
});

test("failure labels, weapon prose and evidence file names cannot evade same-basis correction", () => {
  let ledger = record(undefined, "first", "running").ledger;
  ledger = record(ledger, "first", "ineffective").ledger;
  ledger = record(ledger, "second", "running").ledger;
  ledger = record(ledger, "second", "ineffective", { failureClass: "criterion_not_met" }).ledger;
  const projection = projectTaskProgress(ledger, goal.goalDigest, packet.taskPacketId);
  assert.equal(projection.pendingCorrections.length, 1);
  assert.equal(projection.sameBasisIneffectiveCount, 2);
  assert.throws(() => checkedTaskProgress(raw("third", "ineffective", { failureClass: "invented-label-3" }), packet, goal), /failure_class_invalid/);
  const renamed = { ...packet, taskPacketId: "new-label", weapon: "A differently worded description" };
  assert.equal(taskProgressRoute(renamed), taskProgressRoute(packet));
  assert.equal(taskProgressEvidenceBasis([{ ref: "a-new-name.json", sha256: basisEvidence[0].sha256 }]), taskProgressEvidenceBasis(basisEvidence));
  assert.throws(() => recordTaskProgressCorrection(ledger, { goalDigest: goal.goalDigest, oldPacket: packet, replacement: renamed,
    rationale: "Rephrased", evidenceRefs: ["renamed"], basisEvidence }), /unchanged_basis/);
  assert.throws(() => record(ledger, "third", "running"), /correction_required_before_attempt/);
});

test("waits and questions do not count as failed executions or block an independent task", () => {
  let ledger;
  for (const classification of ["waiting", "question", "paused"]) ledger = record(ledger, classification, classification).ledger;
  const projection = projectTaskProgress(ledger, goal.goalDigest, packet.taskPacketId);
  assert.equal(projection.terminalAttempts, 0);
  assert.equal(projection.correctionsTriggered, 0);
  ledger = record(ledger, "actual-running", "running").ledger;
  assert.throws(() => record(ledger, "duplicate-worker", "running"), /active_attempt_exists/);
  const other = { ...packet, taskPacketId: "independent-task" };
  assert.equal(record(ledger, "independent-running", "running", {}, other).changed, true);
});

test("unresolved transport closes its lifecycle once without becoming outcome failure or retry authority", () => {
  let ledger = record(undefined, "transport", "running").ledger;
  ledger = record(ledger, "transport", "unresolved").ledger;
  const projection = projectTaskProgress(ledger, goal.goalDigest, packet.taskPacketId);
  assert.equal(projection.terminalAttempts, 0);
  assert.equal(projection.ineffectiveAttempts, 0);
  assert.equal(projection.unresolvedAttempts, 1);
  assert.equal(projection.ignoredObservations, 0);
  const waitingOnly = record(undefined, "resource-wait", "waiting").ledger;
  assert.equal(projectTaskProgress(waitingOnly, goal.goalDigest, packet.taskPacketId).ignoredObservations, 1);
  assert.equal(record(ledger, "transport", "unresolved").changed, false);
  assert.throws(() => record(ledger, "transport", "ineffective"), /attempt_conflict/);
  // Admission/recovery is owned by the kernel, not this projection. A separately admitted ID can be recorded.
  assert.equal(record(ledger, "separately-admitted", "running").changed, true);
});

test("one multi-criterion execution remains one attempt and only fresh criterion evidence can report progress", () => {
  let ledger;
  for (const criterion of goal.criteria) ledger = record(ledger, "multi", "running", { criterionId: criterion.criterionId }).ledger;
  assert.throws(() => record(ledger, "multi", "progress", { criterionEvidence: basisEvidence }), /new_criterion_evidence_required/);
  for (const criterion of goal.criteria) ledger = record(ledger, "multi", "progress", { criterionId: criterion.criterionId }).ledger;
  assert.equal(projectTaskProgress(ledger, goal.goalDigest, packet.taskPacketId).terminalAttempts, 1);
  assert.equal(projectTaskProgress(ledger, goal.goalDigest, packet.taskPacketId).progressAttempts, 1);
});

test("current criteria are unique and route identity includes actual capability and strategy", () => {
  assert.throws(() => taskProgressGoal({ realIntent: "x", successCriteria: ["same", " same "] }), /duplicate_goal_criterion/);
  assert.throws(() => taskProgressGoal({ realIntent: "x", successCriteria: [{ id: "one", description: "A" }, { id: "one", description: "B" }] }), /duplicate_goal_criterion/);
  assert.throws(() => checkedTaskProgress(raw("one", "running"), { ...packet, capabilityId: undefined }, goal), /stable_route_required/);
  assert.notEqual(taskProgressRoute({ ...packet, strategyRef: { ...packet.strategyRef, id: "method:update-v2" } }), taskProgressRoute(packet));
  assert.notEqual(taskProgressRoute({ ...packet, capabilityId: "method:other" }), taskProgressRoute(packet));
});

test("generated dependency contexts scope active counters while preserving old attempt dedupe", () => {
  let ledger = record(undefined, "historical", "running").ledger;
  ledger = record(ledger, "historical", "ineffective").ledger;
  const rebound = { ...packet, progressContextId: "new-upstream-context" };
  assert.equal(projectTaskProgress(ledger, goal.goalDigest, packet.taskPacketId, rebound.progressContextId).terminalAttempts, 0);
  assert.throws(() => record(ledger, "historical", "running", {}, rebound), /attempt_conflict/);
  ledger = record(ledger, "fresh", "running", {}, rebound).ledger;
  ledger = record(ledger, "fresh", "ineffective", {}, rebound).ledger;
  const current = projectTaskProgress(ledger, goal.goalDigest, packet.taskPacketId, rebound.progressContextId);
  assert.equal(current.contextId, rebound.progressContextId);
  assert.equal(current.counterScope, "current_dependency_context");
  assert.equal(current.sameBasisIneffectiveCount, 1);
  assert.equal(current.pendingCorrections.length, 0);
  assert.equal(projectTaskProgress(ledger, goal.goalDigest, packet.taskPacketId).ineffectiveAttempts, 1);
  assert.equal(ledger.observations.length, 2, "both real attempt identities remain available in history");
});
