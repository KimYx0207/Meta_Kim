import assert from "node:assert/strict";
import test from "node:test";
import { projectWorkflowWorkerResults } from "../../scripts/governed-execution/worker-result-projection.mjs";
import path from "node:path";
import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";
import { buildLiveCompactProjection, buildLiveSnapshot } from "../../src/application/live/live-control-room-service.mjs";

test("public workflow keeps the matching observed result instead of rebuilding a plan", () => {
  const observed = { runId: "run-a", taskPacketId: "task-a", ownerAgent: "backend", status: "executed", resultKind: "native_read_only_worker_result", output: { text: "actual bounded result" } };
  const input = { runId: "run-a", workerTaskPackets: [{ taskPacketId: "task-a", ownerAgent: "backend" }],
    plannedResults: [{ taskPacketId: "task-a", status: "planned_not_executed" }], executionResults: [observed] };
  assert.deepEqual(projectWorkflowWorkerResults(input), [observed]);
  assert.equal(projectWorkflowWorkerResults(input)[0].status, "executed", "execution must not mint task acceptance");
  for (const changes of [{ runId: "run-b" }, { taskPacketId: "task-b" }, { ownerAgent: "other-owner" }, { resultKind: "synthetic_read_only_worker_result" }]) {
    assert.deepEqual(projectWorkflowWorkerResults({ ...input, executionResults: [{ ...observed, ...changes }] }), input.plannedResults);
  }
});

test("real routed workflow construction keeps task identity and preserves observed output", async (t) => {
  const fixture = createGovernanceRuntimeFixtureScope(t, { graph: true });
  const { runMetaTheoryGovernedExecution, buildWorkflowContractPackets } = await fixture.import("scripts/run-meta-theory-governed-execution.mjs");
  const out = path.join(fixture.root, "result-projection");
  const report = await runMetaTheoryGovernedExecution({ task: "Run meta-theory: inspect package.json and report the exact package name and version. Do not modify files.",
    runId: "worker-projection-integration", stateDir: out, artifactDir: out, dbPath: path.join(out, "runs.sqlite"),
    projectRoot: fixture.repoRoot, projectCapabilityMutationMode: "read_only" });
  const coreLoop = structuredClone(report.coreLoop);
  const selected = coreLoop.thinkingPacket.workerTaskPackets[0];
  const observed = { ...coreLoop.executionResult.workerResultPackets[0], runId: report.runId, taskPacketId: selected.taskPacketId,
    status: "executed", resultKind: "native_read_only_worker_result", evidenceKind: "native_read_only_stage_runner", output: { text: "Fixture observed output" } };
  observed.workerExecutionEvidence.push({ runId: report.runId, taskPacketId: selected.taskPacketId, status: "executed", runtimeProcessInvoked: true, synthetic: false });
  coreLoop.executionResult.actualWorkerExecution = true;
  coreLoop.executionResult.executionClosure = "run_scoped_worker_executed";
  coreLoop.executionResult.workerResultPackets[0] = observed;
  const construct = () => buildWorkflowContractPackets({ runId: report.runId, task: report.task, artifactStatus: report.status,
    orchestrationReport: report.sourceArtifacts.orchestrationReport, coreLoop, runtimeEvidence: report.runtimeProjectionEvidence,
    writebackFlow: report.wardenWritebackFlow, cardPlanPacket: report.cardPlanPacket,
    businessFlowBlueprintPacket: report.businessFlowBlueprintPacket, governanceRequirementPlan: report.governanceRequirementPlanPacket });
  const actual = construct();
  assert.ok(actual.workerTaskPackets.some((packet) => packet.taskPacketId === observed.taskPacketId));
  assert.equal(actual.workerResultPackets.find((result) => result.taskPacketId === observed.taskPacketId).output.text, "Fixture observed output");
  const projection = buildLiveCompactProjection({ ...report, ...actual, executionResult: coreLoop.executionResult, recordOrigin: "acceptance_fixture" });
  const snapshot = buildLiveSnapshot({ governedArtifact: projection });
  assert.ok(snapshot.nodes.some((node) => node.executionState === "executed" && node.status === "in_doubt"), JSON.stringify({ execution: snapshot.run?.executionEvidenceState, nodes: snapshot.nodes.map((node) => ({ kind: node.kind, state: node.status, exec: node.executionState, task: node.taskPacketId })) }));
  assert.ok(snapshot.deliverables.some((item) => item.kind === "text"), "actual constructed output must reach the public opening surface");
  observed.runId = "another-run";
  assert.equal(construct().workerResultPackets.find((result) => result.taskPacketId === selected.taskPacketId).status, "planned_not_executed");
});
