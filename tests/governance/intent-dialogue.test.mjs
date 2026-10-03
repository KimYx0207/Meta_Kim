import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { intentDialogueDigest, prepareIntentDialogue, bindIntentToWorkerTasks, routeCandidateOptions } from "../../scripts/governed-execution/intent-dialogue.mjs";
import { taskOutcomeDigest } from "../../src/domain/governance/task-outcome.mjs";
import { evaluateGovernedArtifact } from "../../scripts/evaluate-governance-outcomes.mjs";
import { createGovernanceRuntimeFixture } from "../helpers/governance-runtime-fixture.mjs";
import { buildPlanChallengeState, runMetaTheoryGovernedExecution } from "../../scripts/run-meta-theory-governed-execution.mjs";

const task = "Implement a local CSV report with a deterministic check; preserve the current project.";
function confirmed(strategy = "fast_usable") {
  const intent = {
    taskHash: taskOutcomeDigest(task), outcome: "A usable local CSV report",
    constraints: { deliveryStrategy: strategy, externalEffects: "none" },
    acceptanceCriteria: [{ id: "csv-report", description: "CSV output matches the provided sample", kind: "deterministic", required: true }],
    settledDecisions: [{ decisionId: "output-format", value: "Keep CSV output", evidenceRefs: ["conversation:format-choice"] }],
    evidenceRefs: ["conversation:confirmed-goal"],
  };
  const understanding = { trusted: true, binding: "plan-challenge-understanding-confirmation",
    taskHash: intent.taskHash, intentDigest: intentDialogueDigest(intent), evidenceRefs: [...intent.evidenceRefs] };
  return { intent, understanding };
}
function dialogue(strategy) {
  const { intent, understanding } = confirmed(strategy);
  return prepareIntentDialogue({ task, confirmedIntent: intent, sharedUnderstandingConfirmed: understanding });
}
const implementationSkill = { id: "csv-implementation", type: "skills", sourceRef: "inventory:csv-implementation", description: "Implement local CSV reports" };
const architectureSkill = { id: "extension-design", type: "skills", sourceRef: "inventory:extension-design", description: "Architecture and extension boundaries for maintainable tools", runtime: "codex" };
const tool = { id: "exec_command", type: "runtimeTools", sourceRef: "host:exec-command" };
const worker = {
  taskPacketId: "csv-backend", roleDisplayName: "backend", executionMode: "primary_execution", todayTask: "Write the CSV report",
  skillLoadout: [implementationSkill], toolLoadout: [tool], capabilityBindings: { skills: [implementationSkill], tools: [tool] },
};
const routeResult = { recommendedRoute: { id: "local-development", runtime: "codex", selectedCapabilityProviders: { skill: implementationSkill, intentArchitecture: architectureSkill },
  intentDirectionSelection: { applies: true, selectionPolicy: "capability_need_runtime_match", status: "selected_not_invoked", selectedProvider: architectureSkill } },
  ownerDiscoveryPacket: { candidateReusableCapabilityProviders: [architectureSkill] } };

test("confirmed direction changes the actual selected discovered skill loadout without inventing tools", () => {
  const fast = bindIntentToWorkerTasks({ workerTaskPackets: [worker], routeResult, dialogue: dialogue("fast_usable") })[0];
  const extensible = bindIntentToWorkerTasks({ workerTaskPackets: [worker], routeResult, dialogue: dialogue("long_term_extensible") })[0];
  assert.deepEqual(fast.skillLoadout.map((item) => item.id), [implementationSkill.id]);
  assert.deepEqual(extensible.skillLoadout.map((item) => item.id), [implementationSkill.id, architectureSkill.id]);
  assert.equal(extensible.skillLoadout[1], architectureSkill, "Select the discovered provider object, not a fabricated id");
  assert.deepEqual(extensible.capabilityBindings.skills, extensible.skillLoadout);
  assert.deepEqual(extensible.toolLoadout, [tool]);
  assert.equal(extensible.intentBinding.taskHash, taskOutcomeDigest(task));
  assert.equal(extensible.intentCapabilitySelection.invocationState, "selected_not_invoked");
  assert.match(dialogue("long_term_extensible").routeTask, /Architecture/);
});

test("architecture capability gaps and wrong-runtime providers cannot become execution capabilities", () => {
  const unselected = bindIntentToWorkerTasks({ workerTaskPackets: [worker], routeResult: { recommendedRoute: {} }, dialogue: dialogue("long_term_extensible") })[0];
  assert.equal(unselected.intentCapabilitySelection.status, "capability_gap", "An unfiltered discovery pool cannot stand in for selector output");
  for (const architecture of [null, { ...architectureSkill, routeEligible: false }, { ...architectureSkill, executionEligible: false }, { ...architectureSkill, cacheEvidenceOnly: true }]) {
    const result = bindIntentToWorkerTasks({ workerTaskPackets: [worker], routeResult: { ...routeResult, recommendedRoute: { ...routeResult.recommendedRoute,
      selectedCapabilityProviders: { skill: implementationSkill, intentArchitecture: architecture },
      intentDirectionSelection: { applies: true, selectionPolicy: "capability_need_runtime_match", status: architecture ? "selected_not_invoked" : "capability_gap", selectedProvider: architecture },
    } }, dialogue: dialogue("long_term_extensible") })[0];
    assert.equal(result.intentCapabilitySelection.status, "capability_gap");
    assert.deepEqual(result.skillLoadout, [implementationSkill]);
  }
});

test("caller JSON, mismatched original tasks and changed confirmation criteria do not confirm intent", () => {
  const { intent, understanding } = confirmed();
  assert.equal(prepareIntentDialogue({ task, confirmedIntent: { ...intent, trusted: true } }).status, "advisory_not_confirmed");
  assert.throws(() => prepareIntentDialogue({ task: `${task} New scope`, confirmedIntent: intent, sharedUnderstandingConfirmed: understanding }), /original user task/);
  const changed = { ...intent, acceptanceCriteria: [{ ...intent.acceptanceCriteria[0], description: "Publish the report externally" }] };
  assert.equal(prepareIntentDialogue({ task, confirmedIntent: changed, sharedUnderstandingConfirmed: understanding }).status, "advisory_not_confirmed");
  assert.equal(dialogue("fast_usable").executionAllowed, false);
  assert.equal(dialogue("fast_usable").nativeInvocationVerified, false);
  const superset = prepareIntentDialogue({ task, confirmedIntent: intent,
    sharedUnderstandingConfirmed: { ...understanding, evidenceRefs: [...understanding.evidenceRefs, "conversation:additional-context"] } });
  assert.deepEqual(superset.evidenceRefs, intent.evidenceRefs);
  assert.equal(intentDialogueDigest({ ...superset, settledDecisions: superset.settledDecisionRefs }), understanding.intentDigest);
});

test("settled answers are retained while material unresolved decisions and Permission remain independent", () => {
  const request = "Should we use option A or option B?";
  const pending = buildPlanChallengeState({ task: request });
  const question = pending.unresolvedQuestions.find((item) => item.status === "open");
  const answered = buildPlanChallengeState({ task: request,
    responses: [{ questionId: question.questionId, sequence: 1, status: "answered", userAnswer: "Use option A", trusted: true,
      binding: `plan-challenge-response:${question.questionId}`, selectionBinding: `plan-challenge-selection:${question.questionId}`, evidenceRefs: ["conversation:route-answer"] }],
    sharedUnderstandingConfirmed: { trusted: true, binding: "plan-challenge-understanding-confirmation", evidenceRefs: ["conversation:understanding"] } });
  const resumed = buildPlanChallengeState({ task: request, priorChallengeState: { ...answered, trusted: true } });
  assert.equal(resumed.unresolvedQuestions.find((item) => item.questionId === question.questionId).status, "answered");
  assert.equal(resumed.planChallengeState.pendingUserChoice.status, "not_required");
  assert.equal(resumed.planChallengeState.executionAllowed, false);
  const material = buildPlanChallengeState({ task: request, sharedUnderstandingConfirmed: confirmed().understanding });
  assert.equal(material.planChallengeState.pendingUserChoice.status, "required_not_invoked", "Understanding cannot answer a pending route choice");
  assert.equal(material.planChallengeState.executionAllowed, false);
  const local = buildPlanChallengeState({ task: "Implement and test code for a local CSV report, preserving all current files." });
  assert.equal(local.planChallengeState.active, false);
  assert.ok(local.planChallengeState.sideEffectActions.includes("local_file_mutation"));
  assert.deepEqual(local.planChallengeState.executionAuthorization.scopeActions, []);
  assert.equal(local.planChallengeState.executionAuthorization.scopeCoversActions, false);
  assert.equal(local.planChallengeState.executionAuthorization.state, "not_required");
  assert.equal(local.planChallengeState.executionAllowed, false);
});

test("route options describe actual discovered routes rather than fabricated validator choices", () => {
  const options = routeCandidateOptions({ recommendedRoute: { id: "csv-local", owner: "backend", weapon: "exec_command", score: 90 }, rankedRoutes: [{ id: "csv-local", owner: "backend", weapon: "exec_command", score: 90, blockedReasons: [] }] });
  assert.equal(options.length, 1);
  assert.equal(options[0].optionId, "csv-local");
  assert.equal(options[0].whatChanges, "exec_command");
});

test("real runner consumes one bound intent across goal, worker and blueprint without granting execution", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "meta-kim-intent-dialogue-"));
  t.after(async () => { assert.equal(path.dirname(temp), path.resolve(os.tmpdir())); await rm(temp, { recursive: true, force: true }); });
  const { intent, understanding } = confirmed();
  const result = await runMetaTheoryGovernedExecution({ task, confirmedIntent: intent, sharedUnderstandingConfirmed: understanding,
    runId: "intent-dialogue-confirmed", stateDir: temp, dbPath: path.join(temp, "runs.sqlite"), projectCapabilityMutationMode: "read_only" });
  const artifact = JSON.parse(await readFile(path.join(temp, "intent-dialogue-confirmed.json"), "utf8"));
  assert.equal(artifact.intentPacket.realIntent, intent.outcome);
  assert.equal(artifact.coreLoop.intentPacket.realIntent, intent.outcome);
  assert.equal(artifact.coreLoop.goalContractPacket.taskHash, intent.taskHash);
  assert.equal(artifact.coreLoop.goalContractPacket.contractFields.outcome, task, "Outcome assessment stays bound to the original request");
  assert.equal(artifact.coreLoop.goalContractPacket.confirmedOutcome, intent.outcome);
  assert.equal(artifact.intentPacket.successCriteria, intent.acceptanceCriteria[0].description);
  assert.equal(artifact.businessFlowBlueprintPacket.intentBinding.intentDigest, understanding.intentDigest);
  for (const packet of artifact.workerTaskPackets) {
    assert.equal(packet.intentBinding.intentDigest, understanding.intentDigest);
    assert.equal(packet.capabilityBindings.intentBinding.taskHash, intent.taskHash);
  }
  assert.equal(artifact.coreLoop.traceEvalControlPlane.outcomeEvaluation.status, "incomplete");
  assert.equal(evaluateGovernedArtifact(artifact).status, "incomplete");
  assert.ok(result, "Runner returns its artifact summary");
});

test("real runner retains bound dialogue history and rejects a prior task's settled answer", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "meta-kim-intent-history-"));
  t.after(async () => { assert.equal(path.dirname(temp), path.resolve(os.tmpdir())); await rm(temp, { recursive: true, force: true }); });
  const request = "Should we use option A or option B? Read-only comparison without file changes.";
  const first = await runMetaTheoryGovernedExecution({ task: request, runId: "intent-history-first", stateDir: temp, dbPath: path.join(temp, "runs.sqlite"), projectCapabilityMutationMode: "read_only" });
  const prior = { ...first.preDecisionOptionFrame, trusted: true };
  const question = prior.unresolvedQuestions.find((item) => item.questionId === "plan-challenge-route-selection");
  assert.ok(question);
  const taskHash = taskOutcomeDigest(request);
  const response = { questionId: question.questionId, sequence: 1, status: "answered", userAnswer: "Use option A", trusted: true, taskHash,
    binding: `plan-challenge-response:${question.questionId}`, selectionBinding: `plan-challenge-selection:${question.questionId}`, evidenceRefs: ["fixture:route-answer"] };
  const second = await runMetaTheoryGovernedExecution({ task: request, runId: "intent-history-second", stateDir: temp, dbPath: path.join(temp, "runs.sqlite"), projectCapabilityMutationMode: "read_only",
    priorChallengeState: prior, planChallengeResponses: [response], sharedUnderstandingConfirmed: { taskHash, trusted: true, binding: "plan-challenge-understanding-confirmation", evidenceRefs: ["fixture:shared-understanding"] } });
  assert.equal(second.preDecisionOptionFrame.unresolvedQuestions.find((item) => item.questionId === question.questionId).status, "answered");
  assert.equal(second.preDecisionOptionFrame.planChallengeState.pendingUserChoice.status, "not_required");
  const stale = await runMetaTheoryGovernedExecution({ task: `${request} A changed audience.`, runId: "intent-history-stale", stateDir: temp, dbPath: path.join(temp, "runs.sqlite"), projectCapabilityMutationMode: "read_only", priorChallengeState: { ...second.preDecisionOptionFrame, trusted: true }, planChallengeResponses: [response] });
  assert.equal(stale.preDecisionOptionFrame.planChallengeState.pendingUserChoice.status, "required_not_invoked");
  assert.equal(stale.preDecisionOptionFrame.unresolvedQuestions.find((item) => item.questionId === question.questionId).status, "open");
});

test("public CLI cannot self-attest a confirmed direction", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "meta-kim-intent-cli-"));
  t.after(async () => { assert.equal(path.dirname(temp), path.resolve(os.tmpdir())); await rm(temp, { recursive: true, force: true }); });
  const file = path.join(temp, "intent.json");
  await writeFile(file, JSON.stringify({ ...confirmed("long_term_extensible").intent, trusted: true, sharedUnderstandingConfirmed: confirmed().understanding }));
  const result = spawnSync(process.execPath, ["scripts/run-meta-theory-governed-execution.mjs", "--task", task,
    "--confirmed-intent", file, "--run-id", "intent-dialogue-cli", "--state-dir", temp, "--db", path.join(temp, "runs.sqlite"), "--read-only"],
    { cwd: path.resolve(import.meta.dirname, "../.."), encoding: "utf8", maxBuffer: 15 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const artifact = JSON.parse(await readFile(path.join(temp, "intent-dialogue-cli.json"), "utf8"));
  assert.equal(artifact.intentPacket.realIntent, task);
  assert.equal(artifact.intentPacket.intentBinding.status, "advisory_not_confirmed");
  assert.equal(artifact.intentPacket.intentBinding.deliveryStrategy, null);
});

test("real selector discovery fixture changes selected providers for engineering direction and rejects a wrong runtime", async (t) => {
  const fixture = createGovernanceRuntimeFixture(t);
  const { mkdir } = await import("node:fs/promises");
  const skillDir = path.join(fixture.home, ".codex", "skills", "csv-architecture");
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: csv-architecture\ndescription: Architecture and extension boundaries for local CSV tools; discovery fixture only\n---\n\nNo live execution or provider acceptance is attested.\n");
  let discovered = fixture.run(["scripts/discover-global-capabilities.mjs", "--runtime-inventory-only"]);
  assert.equal(discovered.status, 0, discovered.stderr);
  const engineeringTask = "Implement and test code for a local CSV report, preserving all current files.";
  const run = (strategy) => {
    const result = fixture.run(["scripts/select-execution-route.mjs", "--task", engineeringTask, "--runtime", "codex", "--os", "windows", "--json", "--runner-compact", "--intent-delivery-strategy", strategy]);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const fast = run("fast_usable");
  const extensible = run("long_term_extensible");
  const nonEngineering = fixture.run(["scripts/select-execution-route.mjs", "--task", "Analyze a scientific hypothesis and test it against the supplied observations.", "--runtime", "codex", "--os", "windows", "--json", "--runner-compact", "--intent-delivery-strategy", "long_term_extensible"]);
  assert.equal(nonEngineering.status, 0, nonEngineering.stderr);
  assert.ok(JSON.parse(nonEngineering.stdout).rankedRoutes.every((route) => route.intentDirectionSelection.applies === false), "Testing an idea does not require software architecture");
  assert.ok(fast.recommendedRoute, "Fixture discovers an existing implementation route");
  assert.ok(extensible.recommendedRoute, "Fixture discovers an existing extensible route");
  assert.equal(fast.recommendedRoute.selectedCapabilityProviders?.intentArchitecture, undefined);
  assert.equal(extensible.recommendedRoute.selectedCapabilityProviders.intentArchitecture.id, "csv-architecture");
  assert.equal(extensible.recommendedRoute.intentDirectionSelection.status, "selected_not_invoked");
  assert.ok(extensible.recommendedRoute.intentDirectionSelection.candidates.some((candidate) => candidate.id === "csv-architecture" && candidate.matchedTerms.includes("architecture")));
  // Exercise the copied real runner against the same discovery fixture. The
  // understanding input is fixture state, not a native answer receipt.
  const script = `
    import { runMetaTheoryGovernedExecution } from "./scripts/run-meta-theory-governed-execution.mjs";
    import { intentDialogueDigest } from "./scripts/governed-execution/intent-dialogue.mjs";
    import { taskOutcomeDigest } from "./src/domain/governance/task-outcome.mjs";
    import path from "node:path";
    const task = ${JSON.stringify(engineeringTask)};
    const intent = { taskHash: taskOutcomeDigest(task), outcome: "A local CSV report", constraints: { deliveryStrategy: "long_term_extensible" }, evidenceRefs: ["fixture:confirmed-goal"] };
    await runMetaTheoryGovernedExecution({ task, confirmedIntent: intent, sharedUnderstandingConfirmed: { trusted: true, binding: "plan-challenge-understanding-confirmation", taskHash: intent.taskHash, intentDigest: intentDialogueDigest(intent), evidenceRefs: intent.evidenceRefs }, runId: "intent-fixture-extensible", stateDir: path.resolve("tmp/intent-run"), dbPath: path.resolve("tmp/intent-run.sqlite"), projectCapabilityMutationMode: "read_only" });
  `;
  const runner = fixture.run(["--input-type=module", "--eval", script]);
  assert.equal(runner.status, 0, runner.stderr);
  const artifact = JSON.parse(await readFile(path.join(fixture.repoRoot, "tmp", "intent-run", "intent-fixture-extensible.json"), "utf8"));
  const implementation = artifact.workerTaskPackets.find((packet) => packet.intentCapabilitySelection.selectedProviders.length);
  assert.ok(implementation, "Actual discovered design capability reaches a real worker task packet");
  assert.ok(implementation.capabilityBindings.skills.some((skill) => skill.id === "csv-architecture"));
  assert.ok(artifact.businessFlowBlueprintPacket.requiredLanes.some((lane) => lane.capabilityBindings.some((binding) => binding.bindingRef === "csv-architecture")));
  assert.equal(artifact.coreLoop.traceEvalControlPlane.outcomeEvaluation.status, "incomplete");
  const validated = fixture.run(["scripts/validate-run-artifact.mjs", path.join("tmp", "intent-run", "intent-fixture-extensible.json")]);
  assert.equal(validated.status, 0, validated.stderr);
  const wrongRuntimeDir = path.join(fixture.home, ".claude", "skills", "csv-architecture");
  await mkdir(wrongRuntimeDir, { recursive: true });
  // Remove only the exact fixture file, preserving the fixture-owned directory.
  await rm(path.join(skillDir, "SKILL.md"));
  await writeFile(path.join(wrongRuntimeDir, "SKILL.md"), "---\nname: csv-architecture\ndescription: Architecture and extension boundaries; Claude discovery fixture only\n---\n\nNo native invocation evidence.\n");
  discovered = fixture.run(["scripts/discover-global-capabilities.mjs", "--runtime-inventory-only"]);
  assert.equal(discovered.status, 0, discovered.stderr);
  const wrongRuntime = run("long_term_extensible");
  assert.equal(wrongRuntime.recommendedRoute, null, "A wrong-runtime architecture candidate cannot satisfy the confirmed direction");
  assert.equal(wrongRuntime.capabilityGapDetected, true);
});
