import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { normalizeProductDesign, normalizeProjectCapabilityRequirements, productDesignDigest, projectDesignWorkerTasks } from "../../scripts/governed-execution/product-design.mjs";
import { buildTaskGoalContract } from "../../src/domain/governance/task-outcome.mjs";

test("a project's professional capability and experience requirements reach the worker under the same design digest", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-professional-context-")); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "project.md"), "Maintenance staff record inspection and escalate unsafe equipment to a supervisor.");
  const goal = buildTaskGoalContract({ task: "Design the maintenance workflow" });
  const input = { schemaVersion: 1, taskHash: goal.taskHash, intentDigest: null, acceptanceDigest: goal.acceptanceDigest, designId: "maintenance", revision: 1,
    mode: "delivery", sourceRefs: ["project.md"], taskSlices: [{ id: "workflow", outcome: "Document the inspection and escalation workflow",
      capabilityNeed: ["industrial maintenance design"], scopeFiles: ["project.md"], criterionIds: ["user-outcome"], dependsOn: [], completionDemo: "A technician can identify the next action and escalation owner",
      deliverables: [{ id: "workflow", description: "Maintenance workflow", consumer: "Technician" }], verification: [{ criterionId: "user-outcome", procedure: "Replay a failed inspection", expectedEvidence: "The workflow names the supervisor and preserves the inspection record" }], projectCapabilityRefs: ["maintenance-designer"] }],
    projectCapabilityRequirements: [{ projectId: "maintenance", baseComponentId: "product-architect", baseComponentVersion: "0.3.0", role: "maintenance-designer",
      domainEvidenceRefs: ["project.md"], responsibilities: ["Maintenance escalation"], boundaries: ["Technician does not approve unsafe equipment"], projectDelta: "Bind the technician/supervisor boundary and inspection recovery",
      reuseConditions: ["The inspection responsibility remains current"], targetPath: ".codex/agents/maintenance-designer.toml", requiredInputs: ["Current maintenance procedures"], toolRequirements: ["read"], acceptance: ["A failed inspection retains its record and names the responsible supervisor"] }],
    projectExperience: { schemaVersion: 1, projectId: "maintenance", revision: 1, layers: [{ level: "domain", source: { ref: "project.md", version: "1" }, rules: [{ id: "escalation", target: "failed-inspection", kind: "visible_information", requirement: "Show the escalation owner", verification: "Observe the failure state" }] }], tasks: [] } };
  const dialogue = { taskHash: goal.taskHash, intentDigest: null, settledDecisionRefs: [] };
  const design = normalizeProductDesign({ input, dialogue, goalContract: goal });
  const [worker] = projectDesignWorkerTasks({ design, runId: "first", templates: [{ workOrderReadiness: "ready" }], projectRoot: root });
  assert.deepEqual(worker.designContext.projectCapabilityRequirements, input.projectCapabilityRequirements);
  assert.deepEqual(worker.designContext.projectExperience, input.projectExperience);
  const arrayDelta = structuredClone(input.projectCapabilityRequirements); arrayDelta[0].projectDelta = [arrayDelta[0].projectDelta, "Keep retained inspection evidence visible"];
  assert.deepEqual(normalizeProjectCapabilityRequirements(arrayDelta), arrayDelta);
  assert.equal(productDesignDigest(normalizeProjectCapabilityRequirements(arrayDelta)), productDesignDigest(arrayDelta), "Cross-repository array deltas retain their exact authority and digest");
  const scoped = structuredClone(input);
  scoped.projectExperience.tasks = [{ id: "inspection", actor: "Technician", goal: "Record inspection", successCondition: "Escalation owner is visible" },
    { id: "inventory", actor: "Storekeeper", goal: "Count parts", successCondition: "Recorded count matches physical stock" }];
  scoped.taskSlices[0].experienceTaskIds = ["inspection"];
  const scopedDesign = normalizeProductDesign({ input: scoped, dialogue, goalContract: goal });
  const [scopedWorker] = projectDesignWorkerTasks({ design: scopedDesign, runId: "scoped", templates: [{ workOrderReadiness: "ready" }], projectRoot: root });
  assert.deepEqual(scopedWorker.designContext.applicableExperienceTaskIds, ["inspection"]);
  scoped.taskSlices[0].experienceTaskIds = ["unknown-task"];
  assert.throws(() => normalizeProductDesign({ input: scoped, dialogue, goalContract: goal }), /unknown project experience task/u);
  const changed = structuredClone(input); changed.projectExperience.layers[0].rules[0].requirement = "Show the escalation owner and retained inspection record";
  const next = normalizeProductDesign({ input: changed, dialogue, goalContract: goal });
  assert.notEqual(next.designDigest, design.designDigest, "Project-specific professional rules are part of the accepted design binding, not an unbound sidecar");
  const unknown = structuredClone(input); unknown.taskSlices[0].projectCapabilityRefs = ["nonexistent-specialist"];
  assert.throws(() => normalizeProductDesign({ input: unknown, dialogue, goalContract: goal }), /project capability/u);
});
