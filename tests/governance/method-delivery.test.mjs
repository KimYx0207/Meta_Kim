import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildMethodInvocationContext, assertMethodInputsReady, buildMethodDeliveryEnvelope, methodDeliveryMatches } from "../../scripts/governed-execution/method-delivery.mjs";
import { projectWorkflowWorkerResults } from "../../scripts/governed-execution/worker-result-projection.mjs";
import { runStageRunnerBridge } from "../../scripts/governed-execution/stage-runner-bridge.mjs";
import { buildStageDagPacket } from "../../scripts/governed-execution/stage-dag.mjs";

const packet = () => ({ taskPacketId: "draft", ownerAgent: "writer", executionMode: "primary_execution", scopeFiles: ["draft.md"],
  acceptanceCriterionIds: ["no-cases"], acceptanceCriteria: ["Do not include examples"],
  intentBinding: { taskHash: "task-hash", intentDigest: "intent-digest", confirmedOutcome: "Rewrite source into a concise article", constraints: { forbidden: ["examples"] },
    acceptanceCriteria: [{ id: "no-cases", description: "Do not include examples" }] },
  designBinding: { designDigest: "design-v1" } });

const method = { methodStatus: "structured_method_loaded", capabilityId: "kim-service:writer", method: { steps: ["Read supplied source"], acceptance: ["Follow user constraints"] },
  inputContract: { type: "object", additionalProperties: false, required: ["goal", "currentSystem", "constraints", "acceptanceCriteria", "handoffContext"], properties: {
    goal: { type: "string" }, currentSystem: { type: ["object", "string"] }, constraints: { type: "object" }, runtimeBindings: { type: "array" },
    acceptanceCriteria: { type: "array", minItems: 1, items: { type: "object", required: ["id", "condition", "evidenceRequired"] } },
    handoffContext: { type: "object", required: ["taskId", "upstreamArtifacts", "permittedActions", "resourceLeases"] },
  } }, outputContract: { type: "object", deliveryFormat: "conceptual-human-delivery", required: ["draft"] } };

test("method inputs reuse exact goal and criteria, keep unknown facts missing and cannot grant capabilities", () => {
  const worker = packet();
  worker.methodInputs = { handoffContext: { permittedActions: ["publish"], resourceLeases: [{ resource: "production" }] },
    runtimeBindings: [{ slot: "write", state: "available" }] };
  const missing = buildMethodInvocationContext({ method, packet: worker });
  assert.equal(missing.status, "needs_input");
  assert.deepEqual(missing.missingInputFields, ["currentSystem"]);
  assert.throws(() => assertMethodInputsReady(missing), /currentSystem/u);
  assert.deepEqual(missing.inputs.runtimeBindings, []);
  assert.deepEqual(missing.inputs.handoffContext.resourceLeases, []);
  assert.doesNotMatch(missing.inputs.handoffContext.permittedActions.join(), /publish/u);
  worker.methodInputs.currentSystem = { source: "draft.md", observed: "Existing article has three sections" };
  const ready = buildMethodInvocationContext({ method, packet: worker });
  assert.equal(ready.status, "ready");
  assert.equal(ready.inputs.goal, worker.intentBinding.confirmedOutcome);
  assert.equal(ready.inputs.acceptanceCriteria[0].id, "no-cases");
  assert.equal(ready.inputs.acceptanceCriteria[0].condition, "Do not include examples");
  assert.deepEqual(ready.context.designBinding, worker.designBinding);
  assert.doesNotThrow(() => assertMethodInputsReady(ready));
});

test("required nested inputs are diagnosed and legacy prose components remain explicit compatibility", () => {
  const custom = { ...method, inputContract: { type: "object", required: ["materials"], properties: {
    materials: { type: "object", required: ["sourceRef"], properties: { sourceRef: { type: "string" } } },
  } } };
  const worker = { ...packet(), methodInputs: { materials: {} } };
  const result = buildMethodInvocationContext({ method: custom, packet: worker });
  assert.deepEqual(result.missingInputFields, ["materials.sourceRef"]);
  const legacy = buildMethodInvocationContext({ method: { ...custom, method: null, methodStatus: "legacy_agent_text_only" }, packet: worker });
  assert.equal(legacy.status, "legacy_compatible");
  assert.deepEqual(legacy.missingInputFields, ["materials.sourceRef"]);
  assert.doesNotThrow(() => assertMethodInputsReady(legacy));
});

test("prose and structured role output preserve actual bytes, while self-report cannot accept the task", () => {
  const worker = packet();
  const prose = buildMethodDeliveryEnvelope({ runId: "run", packet: worker, outputText: "The revised article is ready for review." });
  assert.equal(prose.deliveryFormat, "conceptual-human-delivery");
  assert.equal(prose.userOutcomeAccepted, false);
  const outputText = JSON.stringify({ status: "completed", userOutcomeAccepted: true, artifactRefs: [{ ref: "made-up.md", sha256: "claimed", kind: "document" }],
    criterionResults: [{ id: "no-cases", status: "pass", scope: "article", evidenceRefs: ["made-up.md"] },
      { id: "unknown-id", status: "pass", scope: "all", evidenceRefs: [] }] });
  const result = buildMethodDeliveryEnvelope({ runId: "run", packet: worker, outputText });
  assert.equal(result.reportedStatus, "completed");
  assert.equal(result.acceptanceStatus, "pending_independent_review");
  assert.equal(result.userOutcomeAccepted, false);
  assert.equal(result.reportedArtifactRefs[0].verified, false);
  assert.equal(result.criterionResults.length, 1);
  assert.equal(result.criterionResults[0].evidenceClass, "worker_self_report");
  assert.deepEqual(result.diagnostics, ["invalid_or_unassigned_self_report_criterion"]);
  assert.equal(methodDeliveryMatches({ envelope: result, runId: "run", packet: worker, outputText }), true);
  for (const changed of [{ ...worker, taskPacketId: "other" }, { ...worker, designBinding: { designDigest: "v2" } },
    { ...worker, intentBinding: { ...worker.intentBinding, intentDigest: "different" } }]) {
    assert.equal(methodDeliveryMatches({ envelope: result, runId: "run", packet: changed, outputText }), false);
  }
  assert.equal(methodDeliveryMatches({ envelope: result, runId: "run", packet: worker, outputText: "changed" }), false);
});

test("workflow projection rejects a stale design delivery without replacing the planned result", () => {
  const worker = packet();
  const envelope = buildMethodDeliveryEnvelope({ runId: "run", packet: worker, outputText: "actual body" });
  const planned = { taskPacketId: "draft", status: "planned" };
  const observed = { taskPacketId: "draft", runId: "run", ownerAgent: "writer", resultKind: "native_read_only_worker_result", output: { text: "actual body", deliveryEnvelope: envelope } };
  assert.equal(projectWorkflowWorkerResults({ runId: "run", workerTaskPackets: [worker], plannedResults: [planned], executionResults: [observed] })[0].output.deliveryEnvelope, envelope);
  const stale = { ...worker, designBinding: { designDigest: "new-design" } };
  assert.deepEqual(projectWorkflowWorkerResults({ runId: "run", workerTaskPackets: [stale], plannedResults: [planned], executionResults: [observed] }), [planned]);
});

test("existing durable node output preserves delivery and resume cannot rebind it to another design", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "method-delivery-durable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = packet();
  const dag = buildStageDagPacket({ stageOrder: ["Execution"], runtimeCapacity: 1, stageLanes: { Execution: [{ laneId: "draft", laneKind: "execution_worker",
    ownerBindingRef: "owner:draft", capabilityBindingRef: "capability:draft", effectClass: "read_only_worker", resourceScopes: ["file:draft.md"], isolation: "shared_read_only", status: "planned_not_invoked" }] } });
  let calls = 0;
  const options = { runId: "durable-method-delivery", runtime: "codex", stageDagPacket: dag, workerTaskPackets: [worker], workspaceRoot: root,
    invokeWorker: async () => { calls++; return { status: "pass", outputText: "The article itself, with no claimed acceptance." }; },
    durable: { enabled: true, mode: "create", dbPath: path.join(root, "runs.sqlite"), taskFingerprint: "same-task-design" } };
  const first = await runStageRunnerBridge(options);
  assert.equal(first.status, "pass");
  assert.equal(first.workerResults[0].deliveryEnvelope.designDigest, "design-v1");
  const resumed = await runStageRunnerBridge({ ...options, durable: { ...options.durable, mode: "resume" } });
  assert.equal(calls, 1);
  assert.equal(resumed.workerResults[0].deliveryEnvelope.observationOrigin, "durable_history");
  assert.equal(resumed.workerResults[0].deliveryEnvelope.acceptanceStatus, "pending_independent_review");
  await assert.rejects(runStageRunnerBridge({ ...options, workerTaskPackets: [{ ...worker, designBinding: { designDigest: "changed-design" } }],
    durable: { ...options.durable, mode: "resume" } }), /Durable delivery does not match/u);
  assert.equal(calls, 1);
});
