import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildTaskGoalContract } from "../../src/domain/governance/task-outcome.mjs";
import { evaluateProductOutcomeReview } from "../../scripts/governed-execution/product-design.mjs";

async function fixture(t, target = 2) {
  const root = await mkdtemp(path.join(os.tmpdir(), "numeric-revision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = '["event-1"]';
  await writeFile(path.join(root, "events.json"), bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const goal = buildTaskGoalContract({ task: "Count events", acceptanceCriteria: [{ id: "measured", description: "Enough events", kind: "deterministic", required: true,
    measurement: { kind: "count", unit: "events", scope: "selected data", conditions: "same fixture", comparison: "gte", target } }] });
  const artifact = { runId: "run", goalContractPacket: goal, workerTaskPackets: [{ taskPacketId: "counter", acceptanceCriterionIds: ["measured"] }] };
  const input = { schemaVersion: 1, taskHash: goal.taskHash, intentDigest: null, acceptanceDigest: goal.acceptanceDigest, runId: "run", designDigest: null, reviewRef: "fixture:review",
    artifactSnapshots: [{ ref: "events.json", sha256, producerTaskId: "counter" }],
    observations: [{ criterionId: "measured", taskHash: goal.taskHash, acceptanceDigest: goal.acceptanceDigest, evidenceKind: "deterministic_check", evidenceRef: "events.json", verdict: "fail", artifactRefs: ["events.json"],
      measurement: { unit: "events", scope: "selected data", conditions: "same fixture", samples: [{ id: "sample", eventIds: ["event-1"], evidenceRef: "events.json", evidenceDigest: sha256 }] } }],
    revisionRequests: [{ taskId: "counter", criterionId: "measured", returnToStage: "Execution", finding: "One event does not meet the accepted result", requiredChange: "Repair the measured result", evidenceRefs: ["events.json"] }] };
  return { root, artifact, input, evaluate: (value = input) => evaluateProductOutcomeReview({ input: value, artifact, projectRoot: root }) };
}

test("valid numeric target failure enters targeted repair with its original evidence", async t => {
  const f = await fixture(t);
  const result = await f.evaluate();
  assert.equal(result.status, "fail");
  assert.equal(result.outcomeEvaluation.results[0].reason, "numeric_target_not_met");
  assert.equal(result.nextAction.action, "revise");
  assert.deepEqual(result.nextAction.taskIds, ["counter"]);
});

test("measured pass with a valid reported semantic failure can be repaired", async t => {
  const f = await fixture(t, 1);
  const result = await f.evaluate();
  assert.equal(result.outcomeEvaluation.results[0].reason, "measured_target_and_reported_assessment");
  assert.equal(result.nextAction.action, "revise");
});

test("numeric repair rejects forged bytes, wrong task, stale acceptance and another task's criterion", async t => {
  const f = await fixture(t);
  for (const mutate of [
    value => { value.artifactSnapshots[0].sha256 = "a".repeat(64); },
    value => { value.observations[0].measurement.samples[0].evidenceDigest = "a".repeat(64); },
    value => { value.taskHash = "b".repeat(64); },
    value => { value.acceptanceDigest = "b".repeat(64); },
    value => { value.runId = "older-run"; },
    value => { value.revisionRequests[0].taskId = "unassigned"; },
  ]) {
    const changed = structuredClone(f.input); mutate(changed);
    await assert.rejects(f.evaluate(changed));
  }
});

test("missing measurement samples remain missing evidence, not an authorized repair", async t => {
  const f = await fixture(t);
  f.input.observations[0].measurement.samples = [];
  await assert.rejects(f.evaluate(), /valid current criterion observation|invalid/i);
});
