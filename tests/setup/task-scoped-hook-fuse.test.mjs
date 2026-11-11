import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createInitialState } from "../../canonical/runtime-assets/shared/hooks/spine-state.mjs";
import {
  checkedTaskProgress, projectTaskProgress, recordTaskProgress,
  recordTaskProgressCorrection, taskProgressGoal,
} from "../../canonical/runtime-assets/shared/hooks/task-progress.mjs";
import { copyHookClosure } from "../helpers/hook-fixture.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const critical = { realIntent: "Repair the report while documentation continues", successCriteria: ["Report agrees with supplied records"] };
const goal = taskProgressGoal(critical);
const packet = { taskPacketId: "report-task", ownerAgent: "analyst", capabilityId: "report",
  strategyRef: { id: "report-v1", sha256: "a".repeat(64) }, dependsOn: [],
  acceptanceCriterionIds: goal.criteria.map(({ criterionId }) => criterionId) };
const basisEvidence = [{ ref: "input.json", sha256: "b".repeat(64) }];

function observe(ledger, task, attemptId, classification, basis = basisEvidence) {
  return recordTaskProgress(ledger, checkedTaskProgress({ attemptId, classification,
    criterionId: goal.criteria[0].criterionId, basisEvidence: basis,
    resultRef: `${attemptId}.json`, resultDigest: "c".repeat(64), evidenceRefs: [`${attemptId}.json`],
    ...(classification === "ineffective" ? { failureClass: "criterion_not_met" } : {}),
    ...(classification === "progress" ? { criterionEvidence: [{ ref: "measured-result.json", sha256: "d".repeat(64) }] } : {}),
  }, task, goal)).ledger;
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "meta-task-fuse-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hooks = join(root, "hooks");
  mkdirSync(hooks);
  copyHookClosure(repoRoot, hooks, ["enforce-agent-dispatch.mjs"]);
  const stateDir = join(root, ".meta-kim/state/default/spine");
  mkdirSync(stateDir, { recursive: true });
  const state = { ...createInitialState(), criticalRecord: critical, currentStage: "execution",
    workerTaskPackets: [packet, { ...packet, taskPacketId: "documentation-task" }] };
  const run = (payload, overrides = {}) => {
    writeFileSync(join(stateDir, "spine-state.json"), JSON.stringify(state));
    const env = { ...process.env };
    for (const key of ["META_KIM_HOOK_SKIP", "META_KIM_SPINE_STATE_DIR", "META_KIM_META_ENFORCEMENT_MODE", "CLAUDE_SUBAGENT_TYPE"]) delete env[key];
    const result = spawnSync(process.execPath, [join(hooks, "enforce-agent-dispatch.mjs")], {
      cwd: root, input: JSON.stringify(payload), encoding: "utf8", timeout: 10_000,
      env: { ...env, META_KIM_HOOK_RUNTIME: "claude", META_KIM_CAPABILITY_GATE: "progressive", ...overrides },
    });
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  return { state, run };
}

test("an old run does not turn the default role advisory into a calendar-based deny", (t) => {
  const { state, run } = fixture(t);
  state.runStartTimestamp = "2000-01-01T00:00:00.000Z";
  const result = run({ tool_name: "Edit", tool_input: { file_path: "report.md" } }, {
    CLAUDE_SUBAGENT_TYPE: "meta-warden", META_KIM_META_ENFORCEMENT_GRACE_DAYS: "0",
  });
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /meta-readonly:warn/);
  const strict = run({ tool_name: "Edit", tool_input: { file_path: "report.md" } }, {
    CLAUDE_SUBAGENT_TYPE: "meta-warden", META_KIM_META_ENFORCEMENT_MODE: "block",
  });
  assert.match(strict.stdout, /permissionDecision.*deny/);
});

test("measured task failure opens only its fuse while read-only diagnosis and independent edits continue", (t) => {
  const { state, run } = fixture(t);
  const edit = (taskPacketId) => ({ tool_name: "Edit", tool_input: { taskPacketId, file_path: "report.md" } });
  state.taskProgressLedger = observe(undefined, packet, "trial-one", "running");
  state.taskProgressLedger = observe(state.taskProgressLedger, packet, "trial-one", "ineffective");
  assert.equal(run(edit(packet.taskPacketId)).stdout, "", "one result still allows the bounded follow-up attempt");
  state.taskProgressLedger = observe(state.taskProgressLedger, packet, "trial-two", "running");
  state.taskProgressLedger = observe(state.taskProgressLedger, packet, "trial-two", "ineffective");
  assert.match(run(edit(packet.taskPacketId)).stdout, /Task progress correction required/);
  assert.equal(run(edit("documentation-task")).stdout, "");
  assert.equal(run({ tool_name: "Bash", tool_input: { taskPacketId: packet.taskPacketId, command: "git status --short" } }).stdout, "");
  assert.match(run({ tool_name: "Bash", tool_input: { taskPacketId: packet.taskPacketId, command: "git status --short; rm report.md" } }).stdout, /Task progress correction required/);

  const replacement = { ...packet, logicalTaskPacketId: packet.taskPacketId, taskPacketId: "report-task-v2",
    strategyRef: { id: "report-v2", sha256: "e".repeat(64) } };
  state.taskProgressLedger = recordTaskProgressCorrection(state.taskProgressLedger, {
    goalDigest: goal.goalDigest, oldPacket: packet, replacement, rationale: "Use the corrected input mapping",
    evidenceRefs: ["reviewed-mapping.json"], basisEvidence,
  });
  state.taskCorrectionHistory = [{ previousPacket: packet }];
  state.workerTaskPackets[0] = replacement;
  assert.equal(run(edit(replacement.taskPacketId)).stdout, "");
  assert.match(run(edit(packet.taskPacketId)).stdout, /old work order has been replaced/);
  assert.equal(run({ tool_name: "Bash", tool_input: { taskPacketId: packet.taskPacketId, command: "git diff --stat" } }).stdout, "");
});

test("inspectable canary state comes from actual results, preserves one in-flight attempt and reopens after failed recovery", () => {
  const inspect = (ledger) => projectTaskProgress(ledger, goal.goalDigest, packet.taskPacketId).circuit;
  assert.equal(inspect(undefined).state, "canary");
  let ledger = observe(undefined, packet, "one", "running");
  assert.equal(inspect(ledger).activeAttempts, 1);
  assert.throws(() => observe(ledger, packet, "overlap", "running"), /active_attempt_exists/);
  ledger = observe(ledger, packet, "one", "ineffective");
  ledger = observe(ledger, packet, "two", "running");
  ledger = observe(ledger, packet, "two", "ineffective");
  assert.equal(inspect(ledger).state, "open");
  const replacement = { ...packet, logicalTaskPacketId: packet.taskPacketId, taskPacketId: "report-task-v2",
    strategyRef: { id: "report-v2", sha256: "e".repeat(64) } };
  ledger = recordTaskProgressCorrection(ledger, { goalDigest: goal.goalDigest, oldPacket: packet, replacement,
    rationale: "Reviewed a different strategy", evidenceRefs: ["review.json"], basisEvidence });
  assert.equal(inspect(ledger).state, "recovery_trial");
  for (const attempt of ["recovery-one", "recovery-two"]) {
    ledger = observe(ledger, replacement, attempt, "running");
    ledger = observe(ledger, replacement, attempt, "ineffective");
  }
  assert.equal(inspect(ledger).state, "open");
  assert.equal(inspect(ledger).automaticRollback, false);
});

test("a registered serial trial does not need a second independent lane, and its successor still waits for the prerequisite result", (t) => {
  const { state, run } = fixture(t);
  const first = { ...packet, progressPolicyId: "task-progress-v1", weapon: "Read the supplied records" };
  const second = { ...first, taskPacketId: "summary-task", dependsOn: [first.taskPacketId] };
  state.workerTaskPackets = [first, second];
  state.fetchRecord = { capabilitySearchPerformed: true, capabilityMatches: [{ id: "report" }] };
  state.memoryMode = "project_only";
  state.reviewStandard = "Compare the report to supplied records";
  state.taskProgressLedger = observe(undefined, first, "first-trial", "running");
  const dispatch = (taskPacketId) => ({ tool_name: "Agent", tool_input: {
    taskPacketId, agent_type: "analyst", description: `Review ${taskPacketId}`,
  } });
  assert.equal(run(dispatch(first.taskPacketId)).stdout, "");
  state.workerLifecycle = [{ runId: state.runId, taskPacketId: "other-worker", status: "active" }];
  assert.match(run(dispatch(first.taskPacketId)).stdout, /Thinking fan-out readiness violation/,
    "another real active worker prevents the serial-trial fast path");
  state.workerLifecycle = [];
  const registered = state.taskProgressLedger;
  state.taskProgressLedger = observe(registered, second, "concurrent-task", "running");
  assert.match(run(dispatch(first.taskPacketId)).stdout, /Thinking fan-out readiness violation/,
    "another registered task attempt also prevents the serial-trial fast path");
  delete state.taskProgressLedger;
  assert.match(run(dispatch(first.taskPacketId)).stdout, /Thinking fan-out readiness violation/,
    "a label alone is not a registered serial trial");
  state.taskProgressLedger = registered;
  state.taskProgressLedger = observe(state.taskProgressLedger, first, "first-trial", "progress");
  state.taskProgressLedger = observe(state.taskProgressLedger, second, "summary-trial", "running");
  assert.match(run(dispatch(second.taskPacketId)).stdout, /prerequisite/);
  state.workerResultPackets = [{ taskPacketId: first.taskPacketId, ownerAgent: first.ownerAgent,
    resultStatus: "reported_complete", progressObservations: [{ criterionId: goal.criteria[0].criterionId, classification: "progress" }] }];
  assert.equal(run(dispatch(second.taskPacketId)).stdout, "");
  state.stageRuntimeControl.dispatchMode = "fan_out_ready";
  assert.match(run(dispatch(second.taskPacketId)).stdout, /Thinking fan-out readiness violation/);
});

test("multiple criterion observations for one task attempt remain one serial trial", (t) => {
  const { state, run } = fixture(t);
  state.criticalRecord = { ...critical, successCriteria: [...critical.successCriteria, "Retain source attribution"] };
  const multiGoal = taskProgressGoal(state.criticalRecord);
  const first = { ...packet, progressPolicyId: "task-progress-v1", weapon: "Read the supplied records",
    acceptanceCriterionIds: multiGoal.criteria.map(({ criterionId }) => criterionId) };
  state.workerTaskPackets = [first, { ...first, taskPacketId: "summary-task", dependsOn: [first.taskPacketId] }];
  state.fetchRecord = { capabilitySearchPerformed: true, capabilityMatches: [{ id: "report" }] };
  state.memoryMode = "project_only";
  state.reviewStandard = "Compare the report and attribution to supplied records";
  for (const { criterionId } of multiGoal.criteria) {
    state.taskProgressLedger = recordTaskProgress(state.taskProgressLedger, checkedTaskProgress({
      attemptId: "one-multi-criterion-trial", criterionId, classification: "running", basisEvidence,
      evidenceRefs: ["trial-input.json"],
    }, first, multiGoal)).ledger;
  }
  assert.equal(projectTaskProgress(state.taskProgressLedger, multiGoal.goalDigest, first.taskPacketId).circuit.activeAttempts, 1);
  assert.equal(run({ tool_name: "Agent", tool_input: { taskPacketId: first.taskPacketId,
    agent_type: "analyst", description: `Review ${first.taskPacketId}` } }).stdout, "");
});
