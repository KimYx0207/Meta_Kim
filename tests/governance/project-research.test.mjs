import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectProjectContext } from "../../scripts/governed-execution/project-context.mjs";
import { normalizeResearchEvidence, persistResearchEvidence, researchForTask, readTaskResearchEvidence } from "../../scripts/governed-execution/research-records.mjs";
import { normalizeProductDesign, projectDesignWorkerTasks } from "../../scripts/governed-execution/product-design.mjs";
import { buildTaskGoalContract } from "../../src/domain/governance/task-outcome.mjs";
import { buildReadOnlyWorkerPrompt, prepareReadOnlyRuntimeInvocation } from "../../scripts/governed-execution/stage-runner-bridge.mjs";
import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";
import { hostCriticalGoalCriteria, sameHostCriticalMeaning } from "../../scripts/governed-execution/intent-dialogue.mjs";
import { evaluateProductOutcomeReview } from "../../scripts/governed-execution/product-design.mjs";
import { createHash } from "node:crypto";

const observedAt = "2026-01-01T00:00:00Z";
function researchInput(taskHash = "task") {
  return { schemaVersion: 1, taskHash, intentDigest: null, required: true,
    topics: [{ id: "design", question: "Which design fits?", keywords: ["product discovery"], decisionRefs: [], sourceIds: ["one", "two", "three"],
      queries: ["web", "github"].map(channel => ({ keyword: "product discovery", channel, query: "product discovery", observedAt })) }],
    sources: ["one", "two", "three"].map(id => ({ id, kind: "github", url: `https://github.com/example/${id}`, observedAt,
      stars: 100, revision: "a".repeat(40), relevance: "Dependency-aware product decisions", findings: `Finding ${id}`, adaptation: "Use evidence records; retain the existing eight stages" })) };
}
test("legacy design input preserves the exact pre-research HEAD digest", () => {
  const goal = buildTaskGoalContract({ task: "Inspect package metadata and report it" });
  const dialogue = { taskHash: goal.taskHash, intentDigest: null, settledDecisionRefs: [] };
  const input = { schemaVersion: 1, taskHash: goal.taskHash, intentDigest: null, acceptanceDigest: goal.acceptanceDigest,
    designId: "inspection", revision: 1, mode: "delivery", sourceRefs: ["package.json"],
    taskSlices: [{ id: "report", outcome: "Report package metadata", capabilityNeed: ["read metadata"], scopeFiles: ["package.json"], inputRefs: [], criterionIds: ["user-outcome"], dependsOn: [], completionDemo: "Read the metadata report", deliverables: [{ id: "report", description: "Package report", consumer: "User" }], verification: [{ criterionId: "user-outcome", procedure: "Compare metadata", expectedEvidence: "Exact metadata" }] }] };
  const design = normalizeProductDesign({ input, dialogue, goalContract: goal });
  // Compared with the actual HEAD module at 18b60bab, not a reconstructed normalizer.
  assert.equal(design.designDigest, "22ab5fd5c7172f8cfee2871a2fbd6a0459e43fbe3b84a583516d0271bf33ce56");
  assert.equal(Object.hasOwn(design.taskSlices[0], "researchRefs"), false);
});
test("bounded project context distinguishes new roots and existing multi-language modules without executing scripts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-project-"));
  try {
    assert.equal((await inspectProjectContext({ projectRoot: root })).lifecycle, "new_project");
    await mkdir(path.join(root, "frontend")); await mkdir(path.join(root, "backend"));
    await writeFile(path.join(root, "frontend/package.json"), JSON.stringify({ version: "2.4.1", scripts: { build: "DO_NOT_EXECUTE" }, devDependencies: { typescript: "~5.7" }, dependencies: { react: "^19" } }));
    await writeFile(path.join(root, "backend/pyproject.toml"), '[project]\nname = "backend"\nversion = "1.2"\n');
    const result = await inspectProjectContext({ projectRoot: root });
    assert.equal(result.lifecycle, "existing_project"); assert.equal(result.stagePosition, "before_critical");
    assert.equal(result.modules.length, 2); assert.equal(result.nextStage, "Critical");
    assert.ok(result.sources.every(source => /^[a-f0-9]{64}$/.test(source.sha256)));
    assert.ok(result.modules.some(module => module.directory === "backend"));
    const bounded = await inspectProjectContext({ projectRoot: root, maxDirectories: 1 });
    assert.ok(bounded.limitations.length > 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("research counts only topic-linked matching repositories and reports source, freshness and keyword gaps", () => {
  const normalize = input => normalizeResearchEvidence({ input, taskHash: "task", now: Date.parse("2026-11-04") });
  const input = researchInput(); assert.equal(normalize(input).readiness, "ready");
  const unknown = structuredClone(input); unknown.topics[0].sourceIds.push("unknown");
  assert.throws(() => normalize(unknown), /unknown source/);
  const gap = structuredClone(input); gap.topics[0].queries.pop(); gap.sources[0].expiresAt = "2026-02-01"; gap.sources[1].stars = 99;
  const result = normalize(gap);
  assert.ok(result.gaps.includes("research_source_expired:one"));
  assert.ok(result.gaps.includes("matching_github_repositories_below_three"));
  assert.ok(result.gaps.some(value => value.startsWith("keyword_query_missing:")));
  const unrelated = structuredClone(input); unrelated.topics[0].sourceIds = ["one"];
  assert.equal(normalize(unrelated).matchingRepositoryCount, 1);
  const repeated = structuredClone(input); repeated.topics[0].queries.push(repeated.topics[0].queries[0]);
  assert.equal(normalize(repeated).topics[0].queries.length, 2);
});
test("immutable research survives a later turn; selected task evidence reaches the actual worker prompt and can be reread", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-research-"));
  try {
    const goal = buildTaskGoalContract({ task: "Inspect package metadata and report it" });
    const dialogue = { taskHash: goal.taskHash, intentDigest: null, settledDecisionRefs: [] };
    const research = await persistResearchEvidence({ research: normalizeResearchEvidence({ input: researchInput(goal.taskHash), taskHash: goal.taskHash }), projectRoot: root, outputDir: path.join(root, "records") });
    const stored = JSON.parse(await readFile(path.resolve(root, research.recordRef), "utf8"));
    const later = normalizeResearchEvidence({ input: stored, taskHash: goal.taskHash });
    assert.equal(later.digest, research.digest);
    const input = { schemaVersion: 1, taskHash: goal.taskHash, intentDigest: null, acceptanceDigest: goal.acceptanceDigest,
      designId: "inspection", revision: 1, mode: "delivery", sourceRefs: ["package.json"], researchRefs: ["one"],
      taskSlices: [{ id: "report", outcome: "Report package metadata", capabilityNeed: ["read metadata"], scopeFiles: ["package.json"], inputRefs: [], researchRefs: ["one"], criterionIds: ["user-outcome"], dependsOn: [], completionDemo: "Read the metadata report", deliverables: [{ id: "report", description: "Package report", consumer: "User" }], verification: [{ criterionId: "user-outcome", procedure: "Compare metadata", expectedEvidence: "Exact metadata" }] }] };
    const design = normalizeProductDesign({ input, dialogue, goalContract: goal, research, requireResearch: true });
    const [packet] = projectDesignWorkerTasks({ design, runId: "run", research, templates: [{ ownerAgent: "reader", workOrderReadiness: "ready" }] });
    assert.equal(packet.researchEvidence.length, 1);
    const prompt = buildReadOnlyWorkerPrompt({ runId: "run", runtime: "codex", node: { nodeId: "node" }, packet });
    assert.ok(prompt.includes("Finding one")); assert.ok(!prompt.includes("Finding two"));
    const preparation = { runtime: "codex", workspaceRoot: root, packet, prompt, env: {} };
    assert.equal((await prepareReadOnlyRuntimeInvocation(preparation)).command, "codex");
    await assert.rejects(prepareReadOnlyRuntimeInvocation({ ...preparation, packet: { ...packet, intentBinding: { taskHash: "wrong-task", intentDigest: null } } }), /current task and intent/);
    const readOptions = { projectRoot: root, evidence: packet.researchEvidence, taskHash: goal.taskHash, intentDigest: null };
    assert.equal((await readTaskResearchEvidence(readOptions))[0].id, "one");
    await assert.rejects(readTaskResearchEvidence({ ...readOptions, taskHash: "wrong-task" }), /current task and intent/);
    await assert.rejects(readTaskResearchEvidence({ ...readOptions, intentDigest: "wrong-intent" }), /current task and intent/);
    await assert.rejects(persistResearchEvidence({ research, projectRoot: root, outputDir: path.dirname(root) }), /trusted project/);
    await assert.rejects(readTaskResearchEvidence({ ...readOptions, evidence: [{ ...packet.researchEvidence[0], recordRef: "../outside.json" }] }), /trusted project/);
    await symlink(path.join(root, "records"), path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(readTaskResearchEvidence({ ...readOptions, evidence: [{ ...packet.researchEvidence[0], recordRef: packet.researchEvidence[0].recordRef.replace("records/", "linked/") }] }), /trusted project/);
    const expiring = researchInput(goal.taskHash); expiring.sources[0].expiresAt = "2026-02-01";
    const expiringRecord = await persistResearchEvidence({ research: normalizeResearchEvidence({ input: expiring, taskHash: goal.taskHash, now: Date.parse("2026-01-10") }), projectRoot: root, outputDir: path.join(root, "records") });
    await assert.rejects(readTaskResearchEvidence({ ...readOptions, evidence: researchForTask({ research: expiringRecord, sourceIds: ["one"] }), now: Date.parse("2026-11-04") }), /expired/);
    await assert.rejects(prepareReadOnlyRuntimeInvocation({ ...preparation, packet: { ...packet, researchEvidence: researchForTask({ research: expiringRecord, sourceIds: ["one"] }) } }), /expired/);
    const changed = structuredClone(packet.researchEvidence); changed[0].summary = "forged";
    await assert.rejects(readTaskResearchEvidence({ ...readOptions, evidence: changed }), /summary differs/);
    await assert.rejects(prepareReadOnlyRuntimeInvocation({ ...preparation, packet: { ...packet, researchEvidence: changed } }), /summary differs/);
    await writeFile(path.resolve(root, research.recordRef), "changed");
    await assert.rejects(readTaskResearchEvidence(readOptions), /bytes changed/);
    assert.throws(() => researchForTask({ research, sourceIds: ["unknown"] }), /unknown/);
    assert.equal(normalizeProductDesign({ input, dialogue, goalContract: goal, requireResearch: true, research: { ...research, gaps: ["missing"] } }).readiness, "research_incomplete");
    const noBinding = structuredClone(input); delete noBinding.taskSlices[0].researchRefs;
    assert.ok(normalizeProductDesign({ input: noBinding, dialogue, goalContract: goal, research, requireResearch: true }).researchBinding.gaps.some(gap => gap.startsWith("task_research_binding_missing")));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("the ordinary runner records old-project context before Critical and pauses full design for missing research", async t => {
  const fixture = createGovernanceRuntimeFixtureScope(t);
  const { runMetaTheoryGovernedExecution } = await fixture.import("scripts/run-meta-theory-governed-execution.mjs");
  const task = "Create a complete design for the requested product";
  const goal = buildTaskGoalContract({ task });
  const initial = await runMetaTheoryGovernedExecution({ task, runId: "project-critical-before-research", stateDir: path.resolve("tmp/research-state"), dbPath: path.resolve("tmp/research.sqlite"), designRequired: true });
  assert.equal(initial.hostInvocationRequestPacket.nextAction.stage, "Critical");
  assert.equal(initial.hostInvocationRequestPacket.nextAction.action, "produce_current_critical_understanding");
  assert.deepEqual(initial.workerTaskPackets, []);
  const result = await runMetaTheoryGovernedExecution({ task, runId: "project-research-missing", stateDir: path.resolve("tmp/research-state"), dbPath: path.resolve("tmp/research.sqlite"),
    designRequired: true, criticalInput: { taskHash: goal.taskHash, intentDigest: null, realIntent: task, evidenceRefs: ["fixture:request"], blockingUnknowns: [], nonGoals: [], successCriteria: ["Review a complete evidence-backed PRD"] } });
  assert.equal(result.projectContextPacket.stagePosition, "before_critical");
  assert.equal(result.projectContextPacket.lifecycle, "existing_project");
  assert.equal(result.hostInvocationRequestPacket.nextAction.stage, "Fetch");
  assert.ok(result.hostInvocationRequestPacket.nextAction.researchGaps.includes("required_research_missing"));
  assert.deepEqual(result.workerTaskPackets, []);
});
test("Critical numerical criteria preserve their rule, and real outcome review rejects forged sample hashes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-measured-"));
  try {
    const measurement = { kind: "count", unit: "events", scope: "selected data", conditions: "same fixture", comparison: "gte", target: 1 };
    const critical = { successCriteria: [{ id: "measured", condition: "At least one event", evidenceRequired: "Saved event log", measurement }], nonGoals: [], blockingUnknowns: [] };
    const acceptanceCriteria = hostCriticalGoalCriteria({ task: "Count events", critical });
    assert.deepEqual(acceptanceCriteria[0].measurement, measurement);
    assert.equal(sameHostCriticalMeaning(critical, { ...critical, successCriteria: [{ ...critical.successCriteria[0], measurement: { ...measurement, target: 2 } }] }), false);
    const goal = buildTaskGoalContract({ task: "Count events", acceptanceCriteria });
    await writeFile(path.join(root, "events.json"), '["event-1"]');
    const sha256 = createHash("sha256").update(await readFile(path.join(root, "events.json"))).digest("hex");
    const artifact = { runId: "run", goalContractPacket: goal, workerTaskPackets: [{ taskPacketId: "counter", acceptanceCriterionIds: ["measured"] }] };
    const input = { schemaVersion: 1, taskHash: goal.taskHash, intentDigest: null, acceptanceDigest: goal.acceptanceDigest, runId: "run", designDigest: null, reviewRef: "fixture:review",
      artifactSnapshots: [{ ref: "events.json", sha256, producerTaskId: "counter" }], observations: [{ criterionId: "measured", taskHash: goal.taskHash, acceptanceDigest: goal.acceptanceDigest,
        evidenceKind: "deterministic_check", evidenceRef: "events.json", verdict: "pass", artifactRefs: ["events.json"],
        measurement: { unit: "events", scope: "selected data", conditions: "same fixture", samples: [{ id: "sample", eventIds: ["event-1"], evidenceRef: "events.json", evidenceDigest: "a".repeat(64) }] } }] };
    await assert.rejects(evaluateProductOutcomeReview({ input, artifact, projectRoot: root }), /current reviewed artifact snapshot/);
    input.observations[0].measurement.samples[0].evidenceDigest = sha256;
    assert.equal((await evaluateProductOutcomeReview({ input, artifact, projectRoot: root })).status, "pass");
  } finally { await rm(root, { recursive: true, force: true }); }
});
