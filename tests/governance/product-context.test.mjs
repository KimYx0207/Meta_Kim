import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { buildTaskGoalContract } from "../../src/domain/governance/task-outcome.mjs";
import { normalizeProductDesign, projectDesignWorkerTasks, verifyTaskDesignContext, deriveDesignRevisionImpact, productDesignDigest } from "../../scripts/governed-execution/product-design.mjs";
import { buildReadOnlyWorkerPrompt, prepareReadOnlyRuntimeInvocation } from "../../scripts/governed-execution/stage-runner-bridge.mjs";
import { normalizeResearchEvidence, persistResearchEvidence, researchForTask, readTaskResearchEvidence } from "../../scripts/governed-execution/research-records.mjs";
import { readOnlyFixtureTaskFacts } from "../helpers/task-design-facts.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const observedAt = "2026-01-01T00:00:00Z";
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-product-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "original.txt"), "Preserve this original text.");
  const goal = buildTaskGoalContract({ task: "Review the original text, without a quiz or knowledge platform" });
  const dialogue = { taskHash: goal.taskHash, intentDigest: null, settledDecisionRefs: [{ decisionId: "preserve-original", value: "ORIGINAL_DECISION", evidenceRefs: ["fixture:user-choice"] }] };
  const slice = (id, extra = {}) => ({ id, outcome: "Read the original text", taskFacts: readOnlyFixtureTaskFacts("Read the original text"), capabilityNeed: ["read text"], scopeFiles: ["original.txt"], inputRefs: ["original.txt"], criterionIds: ["user-outcome"], dependsOn: [], journeyRefs: ["review"], decisionRefs: ["preserve-original"], completionDemo: "Original is readable", deliverables: [{ id: `${id}-result`, description: "Original review", consumer: "Reader" }], verification: [{ criterionId: "user-outcome", procedure: "Compare source", expectedEvidence: "Original preserved" }], ...extra });
  const option = { id: "direct-review", mechanism: "Open the supplied original directly", scenario: "Review original", userFlow: ["Open original", "Read original"], benefits: ["No transformation"], costs: ["Reader reviews manually"], failureConditions: ["Original unavailable"], unknowns: [], evidenceRefs: ["fixture:user"] };
  const input = { schemaVersion: 1, taskHash: goal.taskHash, intentDigest: null, acceptanceDigest: goal.acceptanceDigest, designId: "review", revision: 1, mode: "delivery", sourceRefs: ["original.txt", "unrelated-not-loaded.txt"], settledDecisionRefs: ["preserve-original"],
    solutionOptions: [option], selectedOptionId: option.id, selectionRationale: "SELECTION_REASON_KEEP_ORIGINAL",
    domainTerms: [{ id: "original", term: "Original", definition: "SHARED_ORIGINAL_DEFINITION" }, { id: "unrelated", term: "Unrelated", definition: "UNRELATED_GLOSSARY" }],
    userJourneys: [{ id: "review", audience: "Reader", motivation: "Review original", steps: [{ action: "Open original", feedback: "COMPLETE_USER_FEEDBACK", result: "Original remains intact" }], rules: ["NEVER_REPLACE_WITH_QUIZ"], failureRecovery: ["Return to the same original"] }, { id: "other", audience: "Other user", motivation: "Other goal", steps: [{ action: "Other", feedback: "UNRELATED_JOURNEY", result: "Other result" }] }],
    sharedState: [{ id: "document", description: "SHARED_DOCUMENT_STATE", ownerTaskId: "read", consumerTaskIds: ["present"] }],
    interfaces: [{ id: "reader-view", producerTaskId: "read", consumerTaskIds: ["present"], contract: { text: "original text", failure: "SOURCE_UNAVAILABLE" } }],
    taskSlices: [slice("read", { stateRefs: ["document"], interfaceRefs: ["reader-view"], domainTermRefs: ["original"] }), slice("present", { dependsOn: ["read"], dependencyReasons: [{ taskId: "read", reason: "Uses original" }], stateRefs: ["document"], interfaceRefs: ["reader-view"], domainTermRefs: ["original"] })], artifactFlow: [] };
  const normalize = source => normalizeProductDesign({ input: source, dialogue, goalContract: goal });
  const project = design => projectDesignWorkerTasks({ design, runId: "run", projectRoot: root, templates: design.taskSlices.map(() => ({ ownerAgent: "fixture-reader", workOrderReadiness: "ready", nonGoals: ["Never replace original with a quiz"] })) });
  return { root, goal, dialogue, input, normalize, project };
}
function evidence(taskHash = "task", kind = "official") {
  return { schemaVersion: 2, taskHash, intentDigest: null, required: true,
    topics: [{ id: "mechanism", question: "Can the original format be preserved?", decisionImpact: "Choose original review rather than transformation", status: "resolved", conclusion: "Use the original format", keywords: ["original format"], sourceIds: ["source"], queries: [], decisionRefs: [] }],
    sources: [{ id: "source", kind, url: kind === "github" ? "https://github.com/example/format" : "https://example.org/format", observedAt, relevance: "Exact specified format", findings: "Preserve the original", adaptation: "No implementation framework required", ...(kind === "github" ? { stars: 3, revision: "a".repeat(40) } : {}) }] };
}
test("the actual invocation plan carries the selected product mechanism, whole relevant journey and shared contracts", async t => {
  const f = await fixture(t); const [packet] = f.project(f.normalize(f.input));
  const prompt = buildReadOnlyWorkerPrompt({ runId: "run", runtime: "codex", node: { nodeId: "node" }, packet });
  const actual = await prepareReadOnlyRuntimeInvocation({ runtime: "codex", workspaceRoot: f.root, packet, prompt, env: {} });
  for (const text of ["Open the supplied original directly", "SELECTION_REASON_KEEP_ORIGINAL", "COMPLETE_USER_FEEDBACK", "NEVER_REPLACE_WITH_QUIZ", "SHARED_DOCUMENT_STATE", "SHARED_ORIGINAL_DEFINITION", "ORIGINAL_DECISION", "SOURCE_UNAVAILABLE"]) assert.ok(actual.input.includes(text), text);
  for (const text of ["UNRELATED_GLOSSARY", "UNRELATED_JOURNEY", "unrelated-not-loaded.txt"]) assert.ok(!actual.input.includes(text), text);
  assert.equal(packet.designContext.designDigest, packet.designBinding.designDigest);
  assert.ok(actual.input.includes("Never replace original with a quiz"));
});
test("one feasible product option is valid; relabelled tools with identical experience are not alternatives", async t => {
  const f = await fixture(t); assert.equal(f.normalize(f.input).solutionOptions.length, 1);
  const duplicate = structuredClone(f.input);
  duplicate.solutionOptions.push({ ...structuredClone(duplicate.solutionOptions[0]), id: "another-model", mechanism: "Use model B and database B" });
  assert.throws(() => f.normalize(duplicate), /not distinct product options/);
});
test("delivery with real product alternatives cannot proceed without a selected mechanism and reason", async t => {
  const f = await fixture(t);
  f.input.solutionOptions.push({ id: "paper-review", mechanism: "Review a printed copy of the unchanged original", scenario: "Review original",
    userFlow: ["Prepare an unchanged printout", "Review the original on paper"], benefits: ["Review without a screen"], costs: ["Printing and paper"], failureConditions: ["Printer unavailable"], unknowns: [], evidenceRefs: ["fixture:alternative"] });
  delete f.input.selectedOptionId; delete f.input.selectionRationale;
  assert.throws(() => f.normalize(f.input), /Delivery requires a selected product option and rationale/);
  const exploration = f.normalize({ ...f.input, mode: "exploration" });
  assert.equal(exploration.solutionOptions.length, 2);
  assert.equal(exploration.readiness, "design_incomplete");
  assert.ok(f.project(exploration).every(packet => packet.workOrderReadiness === "incomplete"));
});
test("a bounded clear change can use the existing work order without product options or research", () => {
  const packet = { taskPacketId: "small", ownerAgent: "editor", todayTask: "Correct this label", scopeFiles: ["label.txt"] };
  assert.equal(projectDesignWorkerTasks({ design: null, templates: [packet] })[0], packet);
  const prompt = buildReadOnlyWorkerPrompt({ runId: "small", runtime: "codex", node: { nodeId: "small" }, packet });
  assert.ok(prompt.includes("Correct this label")); assert.ok(!prompt.includes('"solutionOptions"'));
});
test("dependency text beyond both old preview and result limits arrives complete with a labelled preview", () => {
  const outputText = "x".repeat(18000) + "NECESSARY_SHARED_STATE_AT_END";
  const prompt = buildReadOnlyWorkerPrompt({ runId: "run", runtime: "codex", node: { nodeId: "node" }, packet: {}, upstreamResults: [{ taskPacketId: "upstream", outputText, outputTextComplete: true, outputSha256: hash(outputText) }] });
  assert.ok(prompt.includes("NECESSARY_SHARED_STATE_AT_END")); assert.ok(prompt.includes('"previewTruncated":true'));
  assert.throws(() => buildReadOnlyWorkerPrompt({ runId: "run", runtime: "codex", node: {}, packet: {}, upstreamResults: [{ outputText, outputSha256: hash(outputText) }] }), /unknown legacy completeness/);
  assert.throws(() => buildReadOnlyWorkerPrompt({ runId: "run", runtime: "codex", node: {}, packet: {}, upstreamResults: [{ outputText: "partial", outputTextTruncated: true }] }), /truncated/);
});
test("changed, missing and unsafe design sources stop actual invocation preparation", async t => {
  const f = await fixture(t); const [packet] = f.project(f.normalize(f.input));
  await writeFile(path.join(f.root, "original.txt"), "Changed after design");
  await assert.rejects(prepareReadOnlyRuntimeInvocation({ runtime: "codex", workspaceRoot: f.root, packet, prompt: "task", env: {} }), /changed/);
  const missing = structuredClone(f.input); missing.taskSlices[0].inputRefs = ["missing.txt"];
  const [missingPacket] = f.project(f.normalize(missing)); assert.equal(missingPacket.workOrderReadiness, "incomplete");
  await assert.rejects(verifyTaskDesignContext({ packet: missingPacket, projectRoot: f.root }), /unavailable/);
  missing.taskSlices[0].inputRefs = ["../outside.txt"];
  assert.equal(f.project(f.normalize(missing))[0].designContext.sourceBindings[0].status, "unavailable");
});
test("context tampering, a different design revision and legacy tasks cannot silently bypass current binding", async t => {
  const f = await fixture(t); const [packet] = f.project(f.normalize(f.input));
  await verifyTaskDesignContext({ packet, projectRoot: f.root });
  const changed = structuredClone(packet); changed.designContext.journeys[0].rules = ["Replace original with quiz"];
  await assert.rejects(verifyTaskDesignContext({ packet: changed, projectRoot: f.root }), /digest/);
  const { digest, authority, ...changedContent } = changed.designContext;
  changed.designContext.digest = productDesignDigest(changedContent);
  await assert.rejects(verifyTaskDesignContext({ packet: changed, projectRoot: f.root }), /digest/);
  const wrongVersion = structuredClone(packet); wrongVersion.designBinding.revision = 2;
  await assert.rejects(verifyTaskDesignContext({ packet: wrongVersion, projectRoot: f.root }), /binding/);
  const legacy = structuredClone(packet); delete legacy.designContext;
  await assert.rejects(verifyTaskDesignContext({ packet: legacy, projectRoot: f.root }), /migration/);
  await verifyTaskDesignContext({ packet: f.project(f.normalize(f.input))[0], projectRoot: f.root });
});
test("a current upstream artifact must match its actual producer and bytes", async t => {
  const f = await fixture(t); f.input.taskSlices[1].inputRefs = ["result.txt"];
  f.input.artifactFlow = [{ id: "result", producerTaskId: "read", consumerTaskIds: ["present"], terminalArtifactRef: "result.txt", sourceArtifactRefs: ["original.txt"], scopeEvidenceRefs: ["fixture:original"], criterionIds: ["user-outcome"] }];
  const [, packet] = f.project(f.normalize(f.input));
  await assert.rejects(verifyTaskDesignContext({ packet, projectRoot: f.root }), /current producer evidence/);
  await writeFile(path.join(f.root, "result.txt"), "Produced original");
  const upstreamResults = [{ taskPacketId: "run-design-read", status: "completed", deliveryEnvelope: { reportedArtifactRefs: [{ ref: "result.txt", sha256: hash("Produced original") }] } }];
  await verifyTaskDesignContext({ packet, projectRoot: f.root, upstreamResults });
  await writeFile(path.join(f.root, "result.txt"), "Changed");
  await assert.rejects(verifyTaskDesignContext({ packet, projectRoot: f.root, upstreamResults }), /changed/);
});
test("decision-backed official, paper, product and low-star sources need no universal repository quota", () => {
  for (const kind of ["official", "paper", "product", "case", "web", "github"]) {
    const result = normalizeResearchEvidence({ input: evidence("task", kind), taskHash: "task" });
    assert.equal(result.readiness, "ready", kind); assert.deepEqual(result.gaps, []);
  }
});
test("inaccessible, conflicting, expired and unknown-reference evidence stays an explicit gap", () => {
  for (const status of ["unresolved", "conflicting"]) {
    const input = evidence(); input.topics[0].status = status;
    assert.ok(normalizeResearchEvidence({ input, taskHash: "task" }).gaps.includes(`decision_evidence_${status}:mechanism`));
  }
  const inaccessible = evidence(); inaccessible.topics[0].status = "unresolved"; inaccessible.topics[0].sourceIds = []; inaccessible.sources = [];
  assert.ok(normalizeResearchEvidence({ input: inaccessible, taskHash: "task" }).gaps.includes("topic_sources_missing:mechanism"));
  const expired = evidence(); expired.sources[0].expiresAt = "2026-02-01";
  assert.ok(normalizeResearchEvidence({ input: expired, taskHash: "task" }).gaps.includes("research_source_expired:source"));
  const unknown = evidence(); unknown.topics[0].sourceIds = ["unknown"];
  assert.throws(() => normalizeResearchEvidence({ input: unknown, taskHash: "task" }), /unknown source/);
});
test("explicit user research counts are preserved and cannot be invented without evidence", () => {
  const input = evidence("task", "github");
  input.constraints = { evidenceRefs: ["fixture:explicit-user-request"], minimumGithubRepositories: 3, minimumObservedStars: 100, requiredChannels: ["github"] };
  const result = normalizeResearchEvidence({ input, taskHash: "task" });
  assert.ok(result.gaps.includes("explicit_minimum_github_repositories_unmet"));
  assert.ok(result.gaps.includes("explicit_star_floor_unmet:source"));
  assert.ok(result.gaps.some(gap => gap.startsWith("keyword_query_missing")));
  delete input.constraints.evidenceRefs;
  assert.throws(() => normalizeResearchEvidence({ input, taskHash: "task" }), /user evidence/);
});
test("legacy research is read-only and migrates to a reviewed successor without rewriting its bytes", async t => {
  const f = await fixture(t); const old = evidence(f.goal.taskHash); old.schemaVersion = 1;
  delete old.topics[0].decisionImpact; delete old.topics[0].status; delete old.topics[0].conclusion;
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  old.digest = hash(JSON.stringify(canonical(old)));
  const bytes = JSON.stringify(old, null, 2) + "\n";
  await mkdir(path.join(f.root, "records")); const ref = "records/legacy.json";
  await writeFile(path.join(f.root, ref), bytes);
  const legacyEvidence = [{ sourceId: "source", recordRef: ref, recordSha256: hash(bytes), researchDigest: old.digest }];
  await assert.rejects(readTaskResearchEvidence({ projectRoot: f.root, evidence: legacyEvidence, taskHash: f.goal.taskHash, intentDigest: null }), /current decision review/);
  const migration = normalizeResearchEvidence({ input: old, taskHash: f.goal.taskHash });
  assert.equal(migration.schemaVersion, 2); assert.ok(migration.gaps.some(gap => gap.startsWith("legacy_topic_decision_review_required")));
  const current = await persistResearchEvidence({ research: normalizeResearchEvidence({ input: evidence(f.goal.taskHash), taskHash: f.goal.taskHash }), outputDir: path.join(f.root, "records"), projectRoot: f.root });
  assert.equal((await readTaskResearchEvidence({ projectRoot: f.root, evidence: researchForTask({ research: current, sourceIds: ["source"] }), taskHash: f.goal.taskHash, intentDigest: null }))[0].id, "source");
  assert.equal(await readFile(path.join(f.root, ref), "utf8"), bytes);
});
test("a changed decision updates only its actual dependent slices", async t => {
  const f = await fixture(t); f.input.taskSlices.push({ ...structuredClone(f.input.taskSlices[0]), id: "independent", dependsOn: [] });
  f.input.revisionContext = { previousRunId: "old", previousDesignDigest: "old-digest", changeEvidenceRefs: ["fixture:new-choice"], directlyAffectedTaskIds: ["read"], reuseCandidates: [{ previousTaskId: "independent", artifactRef: "independent.txt", sha256: "a".repeat(64), reason: "No changed input or dependency" }] };
  const design = f.normalize(f.input); const impact = deriveDesignRevisionImpact(design);
  assert.deepEqual(impact.affectedTaskIds, ["present", "read"]); assert.equal(impact.reuseCandidates[0].previousTaskId, "independent");
});
test("each projected subtask keeps its own current depth and sensitive verification needs", async t => {
  const f = await fixture(t);
  f.input.taskSlices[1].dependsOn = [];
  f.input.taskSlices[1].taskFacts = readOnlyFixtureTaskFacts(f.input.taskSlices[1].outcome, { uncertainty: "focused_unknown" });
  const [clear, focused] = f.project(f.normalize(f.input));
  assert.equal(clear.taskFacts.design.uncertainty, "clear");
  assert.equal(focused.taskFacts.design.uncertainty, "focused_unknown");
  assert.equal(clear.taskFactsSubject, clear.todayTask);
  assert.equal((await prepareReadOnlyRuntimeInvocation({ runtime: "codex", workspaceRoot: f.root, packet: clear, prompt: "original", env: {} })).command, "codex");
  await assert.rejects(prepareReadOnlyRuntimeInvocation({ runtime: "codex", workspaceRoot: f.root, packet: focused, prompt: "original", env: {} }), /current_subtask_decision_evidence_required/);
  f.input.taskSlices[0].taskFacts = readOnlyFixtureTaskFacts(f.input.taskSlices[0].outcome, { operationalRisk: "sensitive" });
  const [sensitive] = f.project(f.normalize(f.input));
  await assert.rejects(prepareReadOnlyRuntimeInvocation({ runtime: "codex", workspaceRoot: f.root, packet: sensitive, prompt: "original", env: {} }), /sensitive_verification/);
  sensitive.handoffTarget = "fixture-independent-review";
  assert.equal((await prepareReadOnlyRuntimeInvocation({ runtime: "codex", workspaceRoot: f.root, packet: sensitive, prompt: "original", env: {} })).command, "codex");
  f.input.taskSlices[0].taskFacts.taskHash = "f".repeat(64);
  assert.throws(() => f.normalize(f.input), /another task/);
});
