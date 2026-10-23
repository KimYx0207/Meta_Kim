import assert from "node:assert/strict";
import test from "node:test";
import { buildRouteDrivenWorkerTasks } from "../../scripts/run-meta-theory-governed-execution.mjs";
import { bindIntentToWorkerTasks, buildIntentCriterionCoverage } from "../../scripts/governed-execution/intent-dialogue.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createGovernanceRuntimeFixture } from "../helpers/governance-runtime-fixture.mjs";
import { buildFanoutSafetyPacket } from "../../scripts/governed-execution/fanout-policy.mjs";
import { buildReadOnlyWorkerPrompt } from "../../scripts/governed-execution/stage-runner-bridge.mjs";
import { validateArtifact } from "../../scripts/validate-run-artifact.mjs";

const criteria = [
  { id: "contract", description: "Preserve the API contract", kind: "semantic", required: true },
  { id: "client", description: "Client consumes the exact contract", kind: "semantic", required: true },
];
const dialogue = { taskHash: "test-task", status: "host_provided_understanding", outcome: "A compatible client", constraints: { forbidden: ["add case studies"], nonGoals: ["change author introduction"] }, acceptanceCriteria: criteria, settledDecisionRefs: [], deliveryStrategy: null };
function route(lanes, drafts = []) {
  return { recommendedRoute: { id: "fixture", owner: "backend", verificationOwner: "review", parallelExecutionLanes: lanes }, workerTaskPacketDrafts: drafts };
}
function lane(laneId, path, overrides = {}) {
  return { laneId, roleDisplayName: "backend", purpose: `Inspect ${path}`, scopeFiles: [path], shardScope: [path], dependsOn: [], parallelGroup: "design", acceptanceCriterionIds: [laneId], safetyEvidence: { status: "proven", shardScope: [path], mutationPolicy: "read_only", workspaceIsolation: "shared_workspace_read_only", externalWritePolicy: "forbidden", collisionPolicy: "no_overlap" }, ...overrides };
}
test("route work orders preserve exact paths, policies and dependency references", () => {
  const selected = route([
    lane("contract", "api/API Contract.json"),
    lane("client", "src/Client.ts", { dependsOn: ["contract"], safetyEvidence: { status: "unproven", mutationPolicy: "scoped_local_writes_only", workspaceIsolation: "unproven", externalWritePolicy: "unproven", collisionPolicy: "unproven" } }),
  ]);
  const packets = buildRouteDrivenWorkerTasks({ runId: "run", routeResult: selected, task: "Inspect API contract then client" });
  assert.deepEqual(packets.map(p => p.scopeFiles), [["api/API Contract.json"], ["src/Client.ts"]]);
  assert.deepEqual(packets[1].dependsOn, ["run-contract"]);
  assert.equal(packets[1].workspaceIsolation, "unproven");
  assert.equal(packets[1].externalWritePolicy, "unproven");
  assert.deepEqual(packets[0].acceptanceCriterionIds, ["contract"]);
  assert.equal(buildFanoutSafetyPacket(packets).safeForParallelFanout, false);
});
test("draft scope is preserved and missing scope never becomes a route URI", () => {
  const selected = route([lane("contract", "ignored", { scopeFiles: undefined, shardScope: undefined, safetyEvidence: undefined }), { laneId: "unknown" }], [{ roleInstanceId: "contract", scopeFiles: ["Docs/Design Notes.md"], shardScope: ["Docs/Design Notes.md"], workspaceIsolation: "isolated_worktree", mutationPolicy: "read_only", externalWritePolicy: "forbidden", collisionPolicy: "no_overlap" }]);
  const packets = buildRouteDrivenWorkerTasks({ runId: "run", routeResult: selected, task: "Inspect" });
  assert.deepEqual(packets[0].scopeFiles, ["Docs/Design Notes.md"]);
  assert.deepEqual(packets[1].scopeFiles, []);
  assert.equal(packets[1].workspaceIsolation, "unproven");
});
test("multiple workers own only assigned goal criteria, with all constraints retained in the actual handoff", () => {
  const selected = route([lane("contract", "api/Contract.json"), lane("client", "src/Client.ts")]);
  const packets = bindIntentToWorkerTasks({ workerTaskPackets: buildRouteDrivenWorkerTasks({ runId: "run", routeResult: selected, task: "Inspect" }), routeResult: selected, dialogue });
  assert.ok(packets[0].acceptanceCriteria.includes(criteria[0].description));
  assert.ok(!packets[0].acceptanceCriteria.includes(criteria[1].description));
  assert.deepEqual(packets[0].intentBinding.acceptanceCriteria, criteria, "Global context remains visible without claiming local ownership");
  assert.ok(packets[0].nonGoals.includes("add case studies"));
  const prompt = buildReadOnlyWorkerPrompt({ runId: "run", runtime: "codex", node: { nodeId: "node" }, packet: packets[0] });
  assert.match(prompt, /User constraints and non-goals take precedence over generic Skill or method recommendations/);
  assert.match(prompt, /add case studies/);
  assert.match(prompt, /acceptanceCriterionIds/);
});
test("unassigned criteria are not claimed by every worker and a sole primary owner can own the outcome", () => {
  const packet = { executionMode: "primary_execution", roleDisplayName: "backend", acceptanceCriteria: [], taskPacketId: "one", handoffTarget: "review" };
  const many = bindIntentToWorkerTasks({ workerTaskPackets: [packet, { ...packet, taskPacketId: "two" }], routeResult: {}, dialogue });
  assert.deepEqual(many[0].acceptanceCriteria, []);
  assert.equal(buildIntentCriterionCoverage({ workerTaskPackets: many, dialogue }).status, "incomplete");
  const one = bindIntentToWorkerTasks({ workerTaskPackets: [packet], routeResult: {}, dialogue });
  assert.deepEqual(one[0].acceptanceCriterionIds, ["contract", "client"]);
  assert.equal(buildIntentCriterionCoverage({ workerTaskPackets: one, dialogue }).status, "assigned_not_verified");
});

test("a sole review worker owns the requested review deliverable without claiming it verified", () => {
  const selected = route([lane("audit", "src/Report.md", { roleDisplayName: "review", acceptanceCriterionIds: undefined })]);
  const packets = bindIntentToWorkerTasks({ workerTaskPackets: buildRouteDrivenWorkerTasks({ runId: "audit", routeResult: selected, task: "Review the report" }), routeResult: selected, dialogue });
  assert.equal(packets[0].executionMode, "verification_execution");
  assert.equal(packets[0].criterionAssignmentSource, "sole_verification_outcome_owner");
  assert.deepEqual(packets[0].acceptanceCriterionIds, ["contract", "client"]);
  assert.equal(buildIntentCriterionCoverage({ workerTaskPackets: packets, dialogue }).status, "assigned_not_verified");
  assert.equal(packets[0].handoffContract.requiredConstraintReview.status, "required_not_reviewed");
});

test("actual generated plan preserves worker dependencies and passes the artifact schema without claiming missing criterion coverage", (t) => {
  const fixture = createGovernanceRuntimeFixture(t);
  const script = `
    import { runMetaTheoryGovernedExecution } from './scripts/run-meta-theory-governed-execution.mjs';
    import { intentDialogueDigest } from './scripts/governed-execution/intent-dialogue.mjs';
    import { taskOutcomeDigest } from './src/domain/governance/task-outcome.mjs';
    import path from 'node:path';
    import { createHash } from 'node:crypto';
    const task = 'Run meta-theory. First inspect the API contract in src/api/Contract.json; then use the API contract findings to review src/client/Types.ts; finally review tests/client.test.ts against those findings.';
    const intent = { taskHash: taskOutcomeDigest(task), outcome: task, constraints: { forbidden: ['add case studies'] }, acceptanceCriteria: ${JSON.stringify(criteria)}, evidenceRefs: ['fixture:user-task'] };
    let invocations = 0;
    const stageRunner = { enabled: true, capacity: 2, durableDbPath: path.resolve('tmp/work-order-durable.sqlite'), invokeWorker: async () => {
      invocations++;
      const outputText = 'Injected callback for transport testing only; no native or semantic acceptance claim.';
      return { status: 'pass', outputText, outputSha256: createHash('sha256').update(outputText).digest('hex'), runtimeProcessInvoked: false, durationMs: 1 };
    } };
    const options = { task, confirmedIntent: intent, sharedUnderstandingConfirmed: { trusted: true, binding: 'plan-challenge-understanding-confirmation', taskHash: intent.taskHash, intentDigest: intentDialogueDigest(intent), evidenceRefs: intent.evidenceRefs }, stateDir: path.resolve('tmp/work-order'), dbPath: path.resolve('tmp/work-order.sqlite'), projectCapabilityMutationMode: 'read_only', stageRunner };
    const first = await runMetaTheoryGovernedExecution({ ...options, runId: 'work-order-plan', taskCriterionAssignments: { taskHash: intent.taskHash, intentDigest: intentDialogueDigest(intent), assignments: [] } });
    const producers = first.workerTaskPackets;
    if (invocations !== 0 || first.stageRunnerBridgePacket.failure.failureClass !== 'work_order_design_incomplete') throw new Error('Unassigned required criteria reached execution');
    if (producers.length < 2) throw new Error('Fixture must select multiple workers');
    const assignments = { taskHash: intent.taskHash, intentDigest: intentDialogueDigest(intent), assignments: [
      { roleInstanceId: producers[0].roleInstanceId, criterionIds: ['contract'] },
      { roleInstanceId: producers[1].roleInstanceId, criterionIds: ['client'] },
    ] };
    await runMetaTheoryGovernedExecution({ ...options, runId: 'assigned-work-order-plan', taskCriterionAssignments: assignments });
    if (invocations !== 3) throw new Error('Assigned exact three-step plan did not invoke its three injected callbacks: ' + invocations);
    const resume = { ...options, runId: 'assigned-work-order-plan', stageRunner: { ...stageRunner, durableMode: 'resume' }, taskCriterionAssignments: assignments };
    await runMetaTheoryGovernedExecution(resume);
    if (invocations !== 3) throw new Error('Materialized resume invoked workers again');
    const changed = { ...assignments, assignments: assignments.assignments.map((entry, index) => ({ ...entry, criterionIds: [index ? 'contract' : 'client'] })) };
    let changedRejected = false;
    try { await runMetaTheoryGovernedExecution({ ...resume, taskCriterionAssignments: changed }); } catch (error) { changedRejected = /fingerprint|identity/.test(error.message); }
    if (!changedRejected) throw new Error('Changed allocation reused a materialized run');
    for (const [index, bad] of [
      { ...assignments, taskHash: 'wrong-task' },
      { ...assignments, assignments: [{ roleInstanceId: 'unknown-task', criterionIds: ['contract'] }] },
      { ...assignments, assignments: [{ roleInstanceId: producers[0].roleInstanceId, criterionIds: ['unknown-goal'] }] },
    ].entries()) {
      let rejected = false;
      try { await runMetaTheoryGovernedExecution({ ...resume, taskCriterionAssignments: bad }); }
      catch (error) { rejected = /criterion|goal|fingerprint|identity/.test(error.message); }
      if (!rejected) throw new Error('Invalid task/criterion assignment accepted: ' + index);
    }
  `;
  const generated = fixture.run(["--input-type=module", "--eval", script]);
  assert.equal(generated.status, 0, generated.stderr);
  const file = path.join(fixture.repoRoot, "tmp/work-order/work-order-plan.json");
  const artifact = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(artifact.workerTaskPackets.length, 3, "Confirmed outcome and constraint prose must not become extra executable actions");
  assert.deepEqual(artifact.workerTaskPackets.map(packet => packet.scopeFiles), [["src/api/Contract.json"], ["src/client/Types.ts"], ["tests/client.test.ts"]]);
  assert.deepEqual(artifact.workerTaskPackets.map(packet => packet.dependsOn), [[], [artifact.workerTaskPackets[0].taskPacketId], [artifact.workerTaskPackets[0].taskPacketId, artifact.workerTaskPackets[1].taskPacketId]]);
  for (const packet of artifact.workerTaskPackets) {
    const board = artifact.orchestrationTaskBoardPacket.tasks.find((entry) => entry.taskId === packet.taskPacketId);
    assert.deepEqual(board.dependsOn, packet.dependsOn);
    assert.ok(packet.nonGoals.includes("add case studies"));
    assert.equal(packet.handoffContract.requiredConstraintReview.status, "required_not_reviewed");
    assert.ok(packet.scopeFiles.every((file) => !file.startsWith("route://")));
  }
  assert.equal(artifact.businessFlowBlueprintPacket.criterionCoverage.status, "incomplete");
  assert.equal(artifact.businessFlowBlueprintPacket.coverageJudgment, "incomplete");
  const validated = fixture.run(["scripts/validate-run-artifact.mjs", file]);
  assert.equal(validated.status, 0, validated.stderr);
  const assignedFile = path.join(fixture.repoRoot, "tmp/work-order/assigned-work-order-plan.json");
  const assigned = JSON.parse(readFileSync(assignedFile, "utf8"));
  assert.equal(assigned.businessFlowBlueprintPacket.criterionCoverage.status, "assigned_not_verified");
  assert.ok(assigned.businessFlowBlueprintPacket.criterionCoverage.rows.every(row => row.producerTaskIds.length === 1));
  assert.equal(assigned.summaryPacket.publicReady, false);
  const assignedValidated = fixture.run(["scripts/validate-run-artifact.mjs", assignedFile]);
  assert.equal(assignedValidated.status, 0, assignedValidated.stderr);
  const contract = JSON.parse(readFileSync(path.join(fixture.repoRoot, "config/contracts/workflow-contract.json"), "utf8"));
  const incomplete = structuredClone(assigned);
  Object.assign(incomplete.workerTaskPackets[0], { scopeFiles: [], shardScope: [], workOrderReadiness: "incomplete", finalizationGate: "blocked_before_host_handoff", workspaceIsolation: "unproven", collisionPolicy: "unproven", safetyEvidence: { status: "unproven" } });
  assert.doesNotThrow(() => validateArtifact(contract, incomplete));
  incomplete.workerTaskPackets[0].workOrderReadiness = "ready";
  assert.throws(() => validateArtifact(contract, incomplete), /scopeFiles|unproven/);
});
