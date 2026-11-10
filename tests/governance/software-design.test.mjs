import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildTaskGoalContract } from "../../src/domain/governance/task-outcome.mjs";
import { normalizeProductDesign, projectDesignWorkerTasks, verifyTaskDesignContext } from "../../scripts/governed-execution/product-design.mjs";
import { buildReadOnlyWorkerPrompt } from "../../scripts/governed-execution/stage-runner-bridge.mjs";

const task = "Design a registration tool with a public signup and an organizer list";
const goal = buildTaskGoalContract({ task });
const dialogue = { taskHash: goal.taskHash, intentDigest: null, settledDecisionRefs: [{ decisionId: "signup-policy", value: "Immediate registration", evidenceRefs: ["fixture:user-choice"] }] };
function designInput() {
  const slice = (id, dependsOn = []) => ({ id, outcome: `Deliver ${id}`, capabilityNeed: [`${id} implementation`],
    scopeFiles: [`${id}.mjs`], inputRefs: ["package.json"], criterionIds: ["user-outcome"], dependsOn,
    dependencyReasons: dependsOn.map(taskId => ({ taskId, reason: "Consume its current interface and verified artifact" })),
    completionDemo: `Operate ${id}`, deliverables: [{ id, description: `Working ${id}`, consumer: "Product user" }],
    verification: [{ criterionId: "user-outcome", procedure: `Operate ${id} with valid and invalid input`, expectedEvidence: "Observed state and output" }] });
  const module = (id, taskIds, decisionRefs = []) => ({ id, purpose: `${id} user outcome`, journeyRefs: [], decisionRefs, interfaceRefs: [], stateRefs: [], taskIds,
    acceptanceCriterionIds: ["user-outcome"], states: [{ name: "empty", behavior: `Explain how to start ${id}` }, { name: "error", behavior: `Recover ${id} input without losing it` }],
    businessRules: [`${id} records preserve their identity`], implementationNotes: `${id} private implementation detail`, removalCandidates: [] });
  return { schemaVersion: 1, taskHash: goal.taskHash, intentDigest: null, acceptanceDigest: goal.acceptanceDigest,
    designId: "registration", revision: 1, mode: "delivery", sourceRefs: ["package.json"], settledDecisionRefs: ["signup-policy"],
    userJourneys: [], taskSlices: [slice("signup"), slice("admin"), slice("integration", ["signup", "admin"])],
    softwareDesign: { schemaVersion: 1, architecture: { id: "registration-system", revision: 1, summary: "Public registration with a separate organizer view",
      decisionRefs: [], technologyChoices: [{ id: "runtime", name: "existing Node runtime", version: "fixture-current", rationale: "Reuse existing project tooling", evidenceRefs: ["package.json"] }],
      constraints: [{ id: "identity", requirement: "A repeated submission preserves one registration", verification: "Submit the same client request twice" }], moduleIds: ["signup", "admin"] },
      modules: [module("signup", ["signup", "integration"], ["signup-policy"]), module("admin", ["admin"])] } };
}
const normalize = input => normalizeProductDesign({ input, dialogue, goalContract: goal });

test("two-level software design binds one PRD and hands only the relevant module to its worker", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-software-design-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"registration-fixture"}');
  const design = normalize(designInput());
  assert.equal(design.readiness, "structure_ready_not_reviewed");
  const packets = projectDesignWorkerTasks({ design, runId: "registration-v1", projectRoot: root,
    templates: design.taskSlices.map(() => ({ ownerAgent: "fixture:implementation", workOrderReadiness: "ready" })) });
  assert.deepEqual(packets[0].designContext.softwareDesign.modules.map(module => module.id), ["signup"]);
  assert.equal(packets[0].designContext.softwareDesign.architecture.id, "registration-system");
  const prompt = buildReadOnlyWorkerPrompt({ runId: "registration-v1", runtime: "codex", node: { nodeId: "signup" }, packet: packets[0] });
  assert.ok(prompt.includes("signup private implementation detail"));
  assert.ok(prompt.includes("Immediate registration"), "A module decision carries its actual settled value, not just its ID");
  assert.equal(packets[1].designContext.decisions.length, 0, "Unrelated module decisions stay out of this worker");
  assert.ok(!prompt.includes("admin private implementation detail"));
  await verifyTaskDesignContext({ packet: packets[0], projectRoot: root });
  packets[0].designContext.softwareDesign.architecture.technologyChoices[0].version = "forged";
  await assert.rejects(verifyTaskDesignContext({ packet: packets[0], projectRoot: root }), /digest|binding/);
});

test("software design rejects orphan modules, tasks, decisions, versions and acceptance references", () => {
  for (const mutate of [
    input => input.softwareDesign.architecture.moduleIds.push("ghost"),
    input => input.softwareDesign.modules[0].taskIds.push("ghost"),
    input => input.softwareDesign.modules[0].decisionRefs.push("unsettled"),
    input => delete input.softwareDesign.architecture.technologyChoices[0].version,
    input => input.softwareDesign.modules[0].acceptanceCriterionIds.push("unassigned"),
    input => input.softwareDesign.modules[1].taskIds.splice(0),
    input => input.softwareDesign.modules[0].states.push({ name: "error", behavior: "duplicate" }),
  ]) {
    const input = designInput(); mutate(input); assert.throws(() => normalize(input), TypeError);
  }
});

test("a changed module invalidates its tasks and dependents while preserving independent reuse candidates", () => {
  const input = designInput();
  input.revision = 2;
  input.revisionContext = { previousRunId: "registration-v1", previousDesignDigest: "a".repeat(64), changeEvidenceRefs: ["fixture:new-business-rule"], changedModuleIds: ["signup"],
    reuseCandidates: [{ taskId: "admin", artifactRef: "admin.mjs", sha256: "b".repeat(64), reason: "Does not consume the changed signup rule" }] };
  const design = normalize(input);
  assert.deepEqual(design.revisionImpact.affectedTaskIds, ["integration", "signup"]);
  assert.equal(design.revisionImpact.reuseCandidates[0].status, "requires_current_binding_and_review");
  input.revisionContext.reuseCandidates[0].taskId = "integration";
  assert.throws(() => normalize(input), /affected reuse/);
});

test("shared architecture changes affect all modules and decision changes follow their actual consumers", () => {
  const input = designInput();
  input.revisionContext = { previousRunId: "registration-v1", previousDesignDigest: "a".repeat(64), changeEvidenceRefs: ["fixture:change"], changedArchitectureIds: ["registration-system"] };
  assert.deepEqual(normalize(input).revisionImpact.affectedTaskIds, ["admin", "integration", "signup"]);
  delete input.revisionContext.changedArchitectureIds;
  input.revisionContext.changedDecisionIds = ["signup-policy"];
  assert.deepEqual(normalize(input).revisionImpact.affectedTaskIds, ["integration", "signup"]);
  input.revisionContext.changedModuleIds = ["unknown"];
  assert.throws(() => normalize(input), /Changed modules/);
});


test("architecture exploration precedes detailed modules and cannot become a delivery plan", () => {
  const input = designInput();
  input.mode = "exploration"; input.taskSlices = [];
  input.softwareDesign.modules = []; input.softwareDesign.architecture.moduleIds = [];
  assert.equal(normalize(input).readiness, "design_incomplete");
  input.softwareDesign.modules = [{ id: "future-signup", purpose: "Let attendees register" }];
  input.softwareDesign.architecture.moduleIds = ["future-signup"];
  assert.equal(normalize(input).softwareDesign.modules[0].purpose, "Let attendees register");
  input.mode = "delivery";
  assert.throws(() => normalize(input), /implementation approach|Module tasks|acceptance/);
});


test("implicit interface consumers and shared-state owners cannot escape a module boundary", () => {
  for (const kind of ["interface", "state"]) {
    const input = designInput();
    if (kind === "interface") input.interfaces = [{ id: "registrations", producerTaskId: "signup", consumerTaskIds: ["admin"], contract: "Read registrations without mutating their identities" }];
    else input.sharedState = [{ id: "registrations", ownerTaskId: "signup", consumerTaskIds: ["admin"], description: "Current registration identities" }];
    assert.throws(() => normalize(input), /outside its declared boundary/);
    for (const module of input.softwareDesign.modules) module[kind === "interface" ? "interfaceRefs" : "stateRefs"] = ["registrations"];
    const design = normalize(input);
    const packets = projectDesignWorkerTasks({ design, runId: "bounded", templates: design.taskSlices.map(() => ({ workOrderReadiness: "ready" })) });
    assert.ok(packets[0].designContext[kind === "interface" ? "interfaces" : "sharedState"].some(item => item.id === "registrations"));
  }
});


test("a decision consumed only by a task still invalidates that task and its dependents", () => {
  const input = designInput();
  input.softwareDesign.modules[0].decisionRefs = [];
  input.taskSlices[0].decisionRefs = ["signup-policy"];
  input.revisionContext = { previousRunId: "registration-v1", previousDesignDigest: "a".repeat(64), changeEvidenceRefs: ["fixture:policy-revision"], changedDecisionIds: ["signup-policy"] };
  assert.deepEqual(normalize(input).revisionImpact.affectedTaskIds, ["integration", "signup"]);
});
