import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildMethodInvocationContext, appendMethodInvocationContext, assertMethodInputsReady, buildMethodDeliveryEnvelope, methodDeliveryMatches } from "../../scripts/governed-execution/method-delivery.mjs";
import { projectWorkflowWorkerResults } from "../../scripts/governed-execution/worker-result-projection.mjs";
import { runStageRunnerBridge } from "../../scripts/governed-execution/stage-runner-bridge.mjs";
import { buildStageDagPacket } from "../../scripts/governed-execution/stage-dag.mjs";
import { readOnlyFixtureTaskFacts } from "../helpers/task-design-facts.mjs";
import { productDesignDigest } from "../../scripts/governed-execution/product-design.mjs";

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
  } }, outputContract: { type: "object", deliveryFormat: "conceptual-human-delivery", required: ["draft"], properties: { draft: { type: "string" } } } };

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

test("selected professional criteria reach the worker with evidence requirements and cannot accept their own result", () => {
  const check = { id: "source-bound-draft", field: "draft", criterion: "Every factual claim is supported by the supplied source and matches its scope",
    rejectWhen: "A claim goes beyond the supplied material", verificationMethod: "source_check",
    evidenceRequired: ["Actual draft text", "Source passage for each factual claim"], blocking: true };
  const source = { ...method, method: { ...method.method, expertise: { contractGuidance: [
    { capabilityId: "writer", outputChecks: [check] },
    { capabilityId: "unselected", outputChecks: [{ ...check, id: "unrelated-check" }] },
  ] } } };
  const worker = { ...packet(), methodInputs: { currentSystem: "Supplied article" } };
  const context = buildMethodInvocationContext({ method: source, packet: worker });
  assert.equal(context.outputReview.standardStatus, "complete_contract");
  assert.deepEqual(context.outputReview.checks.map(item => item.id), ["source-bound-draft"]);
  assert.deepEqual(context.outputReview.checks[0].evidenceRequired, check.evidenceRequired);
  assert.equal(context.outputReview.checks[0].evidenceStatus, "not_observed");
  assert.equal(context.outputReview.professionalEffect, "not_evaluated");
  const prompt = appendMethodInvocationContext("Write the current article", context);
  assert.ok(prompt.includes(check.rejectWhen));
  assert.match(prompt, /blocking failure or missing evidence cannot be offset/);
  const reported = buildMethodDeliveryEnvelope({ runId: "quality", packet: worker, outputText: JSON.stringify({
    status: "pass", qualityScore: 100, criterionResults: [{ id: check.id, status: "pass", evidenceRefs: ["claimed.md"], scope: "whole output" }],
  }) });
  assert.deepEqual(reported.criterionResults, [], "A source standard cannot silently become a host-assigned acceptance criterion");
  assert.equal(reported.acceptanceStatus, "pending_independent_review");
  assert.equal(reported.userOutcomeAccepted, false);
});

test("legacy and partly declared professional standards are delivered as incomplete, never filled in as evaluated", () => {
  const legacy = { field: "draft", criterion: "Source-backed claims", rejectWhen: "Invented claims" };
  const source = { ...method, method: { ...method.method, expertise: { contractGuidance: [{ capabilityId: "writer", outputChecks: [legacy] }] } } };
  const context = buildMethodInvocationContext({ method: source, packet: packet() });
  assert.equal(context.outputReview.standardStatus, "legacy_incomplete");
  assert.deepEqual(context.outputReview.checks[0].missingStandardFields, ["id", "verificationMethod", "evidenceRequired", "blocking"]);
  assert.equal(Object.hasOwn(context.outputReview.checks[0], "blocking"), false);
  assert.equal(Object.hasOwn(context.outputReview.checks[0], "id"), false);
  const incomplete = structuredClone(source);
  incomplete.method.expertise.contractGuidance[0].outputChecks[0] = { ...legacy, id: "draft-source", verificationMethod: "word_count", evidenceRequired: [], blocking: true };
  assert.equal(buildMethodInvocationContext({ method: incomplete, packet: packet() }).outputReview.standardStatus, "legacy_incomplete");
  assert.equal(buildMethodInvocationContext({ method, packet: packet() }).outputReview.standardStatus, "legacy_incomplete");
});

test("external standards cannot claim complete coverage by omitting required output fields or making every check advisory", () => {
  const check = { id: "draft-grounding", field: "draft", criterion: "Claims match supplied evidence", rejectWhen: "Invented claim",
    verificationMethod: "source_check", evidenceRequired: ["Source and actual draft"], blocking: true };
  const source = { ...method, outputContract: { ...method.outputContract, required: ["draft", "limitations"],
    properties: { draft: { type: "string" }, limitations: { type: "array" } } },
    method: { ...method.method, expertise: { contractGuidance: [{ capabilityId: "writer", outputChecks: [check] }] } } };
  const worker = { ...packet(), methodInputs: { currentSystem: "Supplied article" } };
  const review = () => buildMethodInvocationContext({ method: source, packet: worker });
  let context = review();
  assert.equal(context.status, "ready", "An incomplete external standard remains usable within the host task");
  assert.equal(context.outputReview.standardStatus, "legacy_incomplete");
  assert.deepEqual(context.outputReview.standardDiagnostics, [{ code: "required_output_field_without_check", field: "limitations" }]);
  assert.deepEqual(context.context.acceptanceCriterionIds, worker.acceptanceCriterionIds, "Missing source standards do not manufacture host criteria");
  const checks = source.method.expertise.contractGuidance[0].outputChecks;
  checks.push({ ...check, id: "limitations-coverage", field: "limitations" });
  assert.equal(review().outputReview.standardStatus, "complete_contract");
  for (const item of checks) item.blocking = false;
  assert.ok(review().outputReview.standardDiagnostics.some(item => item.code === "no_blocking_output_check"));
  assert.equal(review().outputReview.standardStatus, "legacy_incomplete");
  checks[0].blocking = true;
  checks.push({ ...check, id: "duplicate-draft" });
  assert.ok(review().outputReview.standardDiagnostics.some(item => item.code === "duplicate_output_field" && item.field === "draft"));
  checks[2].field = "undeclaredOutput";
  assert.ok(review().outputReview.standardDiagnostics.some(item => item.code === "undeclared_output_field"));
  checks.pop(); delete source.outputContract.properties;
  context = review();
  assert.ok(context.outputReview.standardDiagnostics.some(item => item.code === "output_contract_properties_unavailable"));
  assert.equal(context.outputReview.acceptanceStatus, "pending_independent_review");
  assert.equal(context.outputReview.professionalEffect, "not_evaluated");
  assert.ok(context.outputReview.checks.every(item => item.evidenceStatus === "not_observed"));
});

test("explicit unknown values remain null only where the source contract permits null", () => {
  const custom = { ...method, inputContract: { type: "object", required: ["versions"], properties: {
    versions: { type: "array", items: { type: "object", required: ["name", "version"], properties: {
      name: { type: "string" }, version: { type: ["string", "null"] },
    } } },
  } } };
  const worker = { ...packet(), methodInputs: { versions: [{ name: "Unexamined runtime", version: null }] } };
  const current = buildMethodInvocationContext({ method: custom, packet: worker });
  assert.doesNotThrow(() => assertMethodInputsReady(current));
  assert.equal(current.inputs.versions[0].version, null, "Structural readiness cannot invent an observed runtime version");
  for (const version of [undefined, 123]) {
    const invalid = buildMethodInvocationContext({ method: custom, packet: { ...worker, methodInputs: { versions: [{ name: "Runtime", version }] } } });
    assert.throws(() => assertMethodInputsReady(invalid), /versions\[0\]\.version/);
  }
  const requiredName = buildMethodInvocationContext({ method: custom, packet: { ...worker, methodInputs: { versions: [{ name: null, version: null }] } } });
  assert.throws(() => assertMethodInputsReady(requiredName), /versions\[0\]\.name/);
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
  assert.equal(result.criterionResults[0].evidenceStatus, "reported_unverified");
  assert.deepEqual(result.diagnostics, ["invalid_or_unassigned_self_report_criterion"]);
  const withoutEvidence = buildMethodDeliveryEnvelope({ runId: "run", packet: worker, outputText: JSON.stringify({
    criterionResults: [{ id: "no-cases", status: "pass", scope: "article", evidenceRefs: [] }],
  }) });
  assert.equal(withoutEvidence.criterionResults[0].status, "pass", "Preserve the worker's claim rather than laundering it into an observation");
  assert.equal(withoutEvidence.criterionResults[0].evidenceStatus, "not_observed");
  assert.deepEqual(withoutEvidence.diagnostics, ["self_report_pass_without_evidence"]);
  assert.equal(withoutEvidence.userOutcomeAccepted, false);
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
  worker.todayTask = "Read the supplied article and return a concise draft without examples";
  worker.taskFactsSubject = worker.todayTask;
  worker.taskFacts = readOnlyFixtureTaskFacts(worker.todayTask);
  // Explicit bounded test-host context, not a historical design digest pasted
  // onto a new task. No external source or user approval is asserted here.
  const withCurrentDesign = (packet, designDigest) => {
    const content = { taskPacketId: packet.taskPacketId, taskHash: packet.intentBinding.taskHash,
      intentDigest: packet.intentBinding.intentDigest, designId: "article-design", revision: 1,
      sliceId: "draft", designDigest, sourceBindings: [] };
    const digest = productDesignDigest(content);
    return { ...packet, designContext: { ...content, digest, authority: "synthetic_test_host" },
      designBinding: { designId: content.designId, revision: content.revision, sliceId: content.sliceId, designDigest, contextDigest: digest } };
  };
  const currentWorker = withCurrentDesign(worker, "design-v1");
  const dag = buildStageDagPacket({ stageOrder: ["Execution"], runtimeCapacity: 1, stageLanes: { Execution: [{ laneId: "draft", laneKind: "execution_worker",
    ownerBindingRef: "owner:draft", capabilityBindingRef: "capability:draft", effectClass: "read_only_worker", resourceScopes: ["file:draft.md"], isolation: "shared_read_only", status: "planned_not_invoked" }] } });
  let calls = 0;
  const options = { runId: "durable-method-delivery", runtime: "codex", stageDagPacket: dag, workerTaskPackets: [currentWorker], workspaceRoot: root,
    invokeWorker: async () => { calls++; return { status: "pass", outputText: "The article itself, with no claimed acceptance." }; },
    durable: { enabled: true, mode: "create", dbPath: path.join(root, "runs.sqlite"), taskFingerprint: "same-task-design" } };
  const first = await runStageRunnerBridge(options);
  assert.equal(first.status, "pass");
  assert.equal(first.workerResults[0].deliveryEnvelope.designDigest, "design-v1");
  const resumed = await runStageRunnerBridge({ ...options, durable: { ...options.durable, mode: "resume" } });
  assert.equal(calls, 1);
  assert.equal(resumed.workerResults[0].deliveryEnvelope.observationOrigin, "durable_history");
  assert.equal(resumed.workerResults[0].deliveryEnvelope.acceptanceStatus, "pending_independent_review");
  await assert.rejects(runStageRunnerBridge({ ...options, workerTaskPackets: [withCurrentDesign(worker, "changed-design")],
    durable: { ...options.durable, mode: "resume" } }), /Durable delivery does not match/u);
  assert.equal(calls, 1);
});
