import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { normalizeWorkContext, workBindingFor, assertWorkContextMatches, bindWorkerWorkContext,
  normalizeWorkOutcome, projectWorkReceipt } from "../../src/domain/governance/work-context.mjs";
import { buildMethodDeliveryEnvelope, methodDeliveryMatches, buildMethodInvocationContext } from "../../scripts/governed-execution/method-delivery.mjs";
import { projectWorkflowWorkerResults } from "../../scripts/governed-execution/worker-result-projection.mjs";
import { buildReadOnlyWorkerPrompt } from "../../scripts/governed-execution/stage-runner-bridge.mjs";
import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";
import { FIXTURE_DIAGNOSTIC_PROVIDERS, refreshFixtureSourcePins } from "../helpers/host-reasoning-fixture.mjs";
import { runDiagnosticReadPlan } from "../../scripts/diagnostic-host-protocol.mjs";

const context = () => ({ schemaVersion: "kim-work-context-v1", organizationRef: "company:kim", workRef: "work:onboarding",
  contextRevision: "revision:2", scopeRef: "scope:operations", sourceRefs: ["record:brief:2"],
  acceptedArtifactRefs: ["artifact:brief:v1"], decisionRefs: ["decision:approved-v1"] });
const observation = (workContext = context(), runId = "run-current") => ({ schemaVersion: "kim-work-outcome-v1", runId,
  workBinding: workBindingFor(workContext), adopted: { status: "accepted", artifactRefs: ["artifact:brief:v1"], decisionRef: "decision:approved-v1" },
  knowledgeReuse: [{ sourceRef: "knowledge:old-policy", disposition: "not_applicable" }] });

test("Work is optional, reference-only, and rejects malformed or changed context before reuse", () => {
  assert.equal(normalizeWorkContext(null), null);
  const plain = { runId: "old-run", executionResult: { actualWorkerExecution: false } };
  assert.equal(projectWorkReceipt(plain), plain, "the default artifact shape is unchanged");
  assert.throws(() => normalizeWorkContext({}), /schemaVersion/);
  assert.throws(() => normalizeWorkContext({ ...context(), permissions: ["publish"] }), /not part/);
  assert.throws(() => normalizeWorkContext({ ...context(), sourceRefs: ["x", "x"] }), /unique/);
  const original = context(), normalized = normalizeWorkContext(original);
  original.sourceRefs.push("later mutation");
  assert.deepEqual(normalized.sourceRefs, ["record:brief:2"]);
  assertWorkContextMatches(context(), normalized);
  for (const changed of [{ organizationRef: "another-company" }, { workRef: "another-work" },
    { contextRevision: "revision:3" }, { scopeRef: "scope:other" }, { sourceRefs: ["record:brief:3"] }]) {
    assert.throws(() => assertWorkContextMatches(context(), { ...context(), ...changed }), /differs/);
  }
  assert.throws(() => assertWorkContextMatches(context(), null), /differs/);
});

test("worker transport and returned envelopes cannot project another Work's output", () => {
  const workContext = context();
  const [packet] = bindWorkerWorkContext([{ taskPacketId: "worker-a", ownerAgent: "analysis", scopeFiles: ["package.json"] }], workContext);
  const envelope = buildMethodDeliveryEnvelope({ runId: "run-current", packet, outputText: "actual output v2" });
  const prompt = buildReadOnlyWorkerPrompt({ runId: "run-current", runtime: "codex", node: { nodeId: "execution-a" }, packet });
  assert.ok(prompt.includes(packet.workBinding.contextDigest));
  assert.ok(prompt.includes("scope:operations"));
  for (const ref of [...workContext.sourceRefs, ...workContext.acceptedArtifactRefs, ...workContext.decisionRefs]) assert.ok(prompt.includes(ref), `worker prompt must receive the actual business reference: ${ref}`);
  const method = buildMethodInvocationContext({ packet, method: { method: {}, inputContract: { type: "object", properties: { workContext: { type: "object" } } }, outputContract: {} } });
  assert.deepEqual(method.context.workContext, workContext);
  assert.deepEqual(method.inputs.workContext, workContext);
  const result = { runId: "run-current", taskPacketId: packet.taskPacketId, ownerAgent: packet.ownerAgent,
    workBinding: packet.workBinding, status: "executed", resultKind: "native_read_only_worker_result", output: { text: "actual output v2", deliveryEnvelope: envelope } };
  const input = { runId: "run-current", workerTaskPackets: [packet], executionResults: [result],
    plannedResults: [{ taskPacketId: packet.taskPacketId, status: "planned_not_executed" }] };
  assert.equal(projectWorkflowWorkerResults(input)[0].status, "executed");
  const wrongBinding = workBindingFor({ ...workContext, workRef: "work:unrelated" });
  assert.equal(methodDeliveryMatches({ envelope: { ...envelope, workBinding: wrongBinding }, runId: "run-current", packet, outputText: "actual output v2" }), false);
  for (const workBinding of [null, wrongBinding, workBindingFor({ ...workContext, contextRevision: "revision:1" })]) {
    assert.deepEqual(projectWorkflowWorkerResults({ ...input, executionResults: [{ ...result, workBinding }] }), input.plannedResults);
  }
});

test("produced, technical verification, historical adoption and business effect remain independent", () => {
  const workContext = context();
  const [packet] = bindWorkerWorkContext([{ taskPacketId: "worker-a", ownerAgent: "analysis" }], workContext);
  const artifact = { runId: "run-current", workContext, workerTaskPackets: [packet],
    executionResult: { workerResultPackets: [{ runId: "run-current", taskPacketId: packet.taskPacketId, ownerAgent: packet.ownerAgent,
      workBinding: packet.workBinding, status: "executed", resultKind: "native_read_only_worker_result", output: { text: "v2" } }] },
    outcomeReviewPacket: { reviewRef: "review:v2", outcomeEvaluation: { status: "pass" } },
    evolutionWritebackPacket: { writebackDecision: "none", writebacks: [] } };
  const baseline = projectWorkReceipt(artifact);
  assert.equal(baseline.workReceipt.produced.status, "produced");
  assert.equal(baseline.workReceipt.verified.status, "passed");
  assert.equal(baseline.workReceipt.adopted.status, "unknown");
  assert.equal(baseline.workReceipt.effect.status, "unknown");
  const observed = projectWorkReceipt(artifact, observation());
  assert.deepEqual(observed.workReceipt.adopted.artifactRefs, ["artifact:brief:v1"], "the prior accepted version is not replaced by the newest output");
  assert.equal(observed.workReceipt.adopted.decisionRef, "decision:approved-v1", "the host may reference an earlier approval without asking again");
  assert.equal(observed.workReceipt.adopted.reason, "unknown");
  assert.equal(observed.workReceipt.knowledgeReuse[0].disposition, "not_applicable");
  assert.equal(observed.evolutionWritebackPacket.workFeedback.status, "candidate_only");
  assert.equal(observed.evolutionWritebackPacket.writebackDecision, "none");
  assert.deepEqual(observed.evolutionWritebackPacket.writebacks, []);
  const failed = projectWorkReceipt({ ...artifact, outcomeReviewPacket: { reviewRef: "review:failure", outcomeEvaluation: { status: "fail" } } });
  assert.equal(failed.evolutionWritebackPacket.workFeedback.candidates[0].kind, "technical_verification");
  assert.equal(failed.workReceipt.effect.status, "unknown");
  for (const changes of [{ runId: "prior-run" }, { workBinding: workBindingFor({ ...workContext, workRef: "another-work" }) },
    { workBinding: workBindingFor({ ...workContext, contextRevision: "revision:1" }) }]) {
    assert.throws(() => normalizeWorkOutcome({ ...observation(), ...changes }, { runId: artifact.runId, workContext }), /Work context:/);
  }
  const multiline = "第一行：沿用旧版。\n第二行：本轮只观察业务反馈。";
  assert.equal(normalizeWorkOutcome({ ...observation(), adopted: { ...observation().adopted, reason: multiline } }, { runId: artifact.runId, workContext }).adopted.reason, multiline);
});

test("ordinary runner binds Work through preparation, workers, appended outcomes and readback without re-execution", async t => {
  const fixture = createGovernanceRuntimeFixtureScope(t, { graph: true });
  refreshFixtureSourcePins(fixture);
  const { runMetaTheoryGovernedExecution: run, readGovernedExecutionRun } = await fixture.import("scripts/run-meta-theory-governed-execution.mjs");
  const out = path.join(fixture.root, "work-context");
  const task = "Inspect package.json and report the package name. Do not modify files.";
  const options = { task, runId: "company-work", workContext: context(), diagnosticProviders: FIXTURE_DIAGNOSTIC_PROVIDERS,
    stateDir: out, artifactDir: out, dbPath: path.join(out, "runs.sqlite"), projectRoot: fixture.repoRoot, projectCapabilityMutationMode: "read_only" };
  const report = await runDiagnosticReadPlan(run, options, ["package.json"]);
  assert.equal(report.workReceipt.produced.status, "not_produced");
  assert.equal(report.workReceipt.adopted.status, "unknown");
  assert.ok(report.workerTaskPackets.length);
  for (const packet of report.workerTaskPackets) assert.deepEqual(packet.workBinding, workBindingFor(context()));
  for (const result of report.executionResult.workerResultPackets) assert.deepEqual(result.workBinding, workBindingFor(context()));
  const prep = JSON.parse(readFileSync(path.join(out, "company-work-fetch.json"), "utf8"));
  assert.deepEqual(prep.workContext, context());
  assert.ok(prep.hostInvocationRequestPacket.nextAction.inputRefs.includes("workContext"));
  const executionPath = path.join(out, "company-work.json");
  const executionBytes = readFileSync(executionPath, "utf8");
  const validated = fixture.run(["scripts/validate-run-artifact.mjs", executionPath]);
  assert.equal(validated.status, 0, validated.stderr || validated.stdout);
  const appended = await run({ ...options, workOutcome: observation(context(), report.runId) });
  assert.equal(appended.workReceipt.adopted.status, "accepted");
  assert.equal(appended.workReceipt.adopted.source, "host_provided_not_independently_verified");
  assert.equal(appended.workReceipt.produced.status, "not_produced", "a business observation cannot manufacture worker execution");
  assert.equal(readFileSync(executionPath, "utf8"), executionBytes, "execution evidence remains immutable");
  const validatedObservation = fixture.run(["scripts/validate-run-artifact.mjs", appended.paths.json]);
  assert.equal(validatedObservation.status, 0, validatedObservation.stderr || validatedObservation.stdout);
  const read = await readGovernedExecutionRun({ runId: report.runId, artifactDir: out, projectRoot: fixture.repoRoot });
  assert.deepEqual(read.artifact.workReceipt, appended.workReceipt);
  for (const workContext of [null, { ...context(), workRef: "another-work" }, { ...context(), contextRevision: "revision:3" }, { ...context(), sourceRefs: ["changed-in-place"] }]) {
    await assert.rejects(run({ ...options, workContext }), /Work context:/);
  }
  await assert.rejects(run({ ...options, runId: "new-run", previousPlanChallengeRunId: "company-work-fetch", workContext: { ...context(), workRef: "another-work" } }), /Work context:/);
  await assert.rejects(run({ ...options, workOutcome: { ...observation(context(), report.runId), runId: "older-run" } }), /current explicit runId/);
  const contextPath = path.join(out, "context-input.json"), outcomePath = path.join(out, "outcome-input.json");
  writeFileSync(contextPath, JSON.stringify(context()));
  writeFileSync(outcomePath, JSON.stringify({ ...observation(context(), report.runId), adopted: { status: "rejected", artifactRefs: [], decisionRef: "decision:not-used" } }));
  const cli = fixture.run(["scripts/run-meta-theory-governed-execution.mjs", "--task", task, "--run-id", report.runId,
    "--artifact-dir", out, "--work-context-input", contextPath, "--work-outcome-input", outcomePath]);
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  assert.equal(JSON.parse(cli.stdout).workReceipt.adopted.status, "rejected");
  assert.equal(readFileSync(executionPath, "utf8"), executionBytes);
  const reviewedRef = "tmp/work-review.txt";
  const reviewedText = "Independent fixture review material";
  writeFileSync(path.join(fixture.repoRoot, reviewedRef), reviewedText);
  const goal = report.goalContractPacket;
  const outcomeReviewInput = { schemaVersion: 1, runId: report.runId, taskHash: goal.taskHash,
    intentDigest: goal.intentBinding?.intentDigest ?? null, acceptanceDigest: goal.acceptanceDigest, designDigest: null,
    reviewRef: "review:work-current", artifactSnapshots: [{ ref: reviewedRef,
      sha256: createHash("sha256").update(reviewedText).digest("hex"), producerTaskId: report.workerTaskPackets[0].taskPacketId }],
    observations: goal.acceptanceCriteria.map(criterion => ({ criterionId: criterion.id, artifactRefs: [reviewedRef],
      taskHash: goal.taskHash, intentDigest: goal.intentBinding?.intentDigest ?? null, acceptanceDigest: goal.acceptanceDigest,
      evidenceKind: "independent_review", verdict: "pass", producer: "fixture-producer", reviewer: "fixture-reviewer", evidenceRef: "review:work-current-bytes" })) };
  const reviewed = await run({ ...options, criticalInput: prep.intentPacket, outcomeReviewInput });
  assert.equal(reviewed.workReceipt.verified.status, "passed");
  assert.equal(reviewed.workReceipt.adopted.status, "rejected");
  assert.notEqual(reviewed.paths.json, appended.paths.json, "a later Review receives a distinct combined Work projection");
  assert.deepEqual(JSON.parse(readFileSync(reviewed.paths.json, "utf8")).workReceipt, reviewed.workReceipt,
    "the returned file path must contain the same current review and business observation as the API result");
  const reviewedRead = await readGovernedExecutionRun({ runId: report.runId, artifactDir: out, projectRoot: fixture.repoRoot });
  assert.deepEqual(JSON.parse(readFileSync(reviewedRead.paths.json, "utf8")).workReceipt, reviewedRead.artifact.workReceipt);
  assert.equal(readFileSync(executionPath, "utf8"), executionBytes);
  const unbound = await runDiagnosticReadPlan(run, { ...options, runId: "ordinary-run", workContext: null }, ["package.json"]);
  assert.equal(Object.hasOwn(unbound, "workReceipt"), false);
  assert.ok(unbound.workerTaskPackets.every(packet => !Object.hasOwn(packet, "workBinding")));
});

test("stop persists despite broken or mismatched Work input and never returns another Work's content", async t => {
  const fixture = createGovernanceRuntimeFixtureScope(t, { graph: true });
  const { runMetaTheoryGovernedExecution: run } = await fixture.import("scripts/run-meta-theory-governed-execution.mjs");
  const out = path.join(fixture.root, "work-stop");
  const options = { task: "Inspect the current project", runId: "work-stop", workContext: context(), stateDir: out, artifactDir: out,
    projectRoot: fixture.repoRoot, projectCapabilityMutationMode: "read_only" };
  const prepared = await run(options);
  assert.deepEqual(prepared.workContext, context());
  const stopped = await run({ ...options, planChallengeControl: "summarize_stop", workContext: { ...context(), workRef: "another-work" } });
  assert.equal(stopped.status, "stopped_by_user");
  assert.equal(stopped.workContextStatus, "conflict_not_reused");
  assert.equal(Object.hasOwn(stopped, "workContext"), false);
  assert.equal(Object.hasOwn(stopped, "coreLoop"), false);
  const invalid = await run({ ...options, planChallengeControl: "summarize_stop", workContext: {} });
  assert.equal(invalid.status, "stopped_by_user");
  const restored = await run(options);
  assert.equal(restored.status, "stopped_by_user");
  assert.deepEqual(restored.workContext, context());
  await assert.rejects(run({ ...options, workContext: { ...context(), workRef: "another-work" } }), /Work context:/);
});
