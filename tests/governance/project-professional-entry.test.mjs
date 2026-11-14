import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { copyProjectCapability } from "../../scripts/project-capability-copy.mjs";
import { productDesignDigest } from "../../scripts/governed-execution/product-design.mjs";
import { buildReadOnlyWorkerPrompt } from "../../scripts/governed-execution/stage-runner-bridge.mjs";
import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";
import { fixtureCritical, fixtureReadWorkOrder, fixtureThinkingInput, refreshFixtureSourcePins } from "../helpers/host-reasoning-fixture.mjs";
import { createProjectProfessionalFixture, persistProjectProfessionalFixture } from "../helpers/project-professional-fixture.mjs";
import { localProtocolFixtureTaskFacts } from "../helpers/task-design-facts.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const write = (root, ref, value) => { const file = path.join(root, ref); mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); return { ref, contentDigest: "sha256:" + sha(readFileSync(file)) }; };

test("an unrelated approved project owner cannot fulfill a required professional role while independent preparation continues", async t => {
  const fixture = createGovernanceRuntimeFixtureScope(t); refreshFixtureSourcePins(fixture);
  const unrelated = createProjectProfessionalFixture(fixture.repoRoot);
  const { runMetaTheoryGovernedExecution: run } = await fixture.import("scripts/run-meta-theory-governed-execution.mjs");
  const task = "Produce the maintenance escalation brief.";
  const criticalInput = fixtureCritical({ task, successCriteria: ["Escalation decisions retain the equipment evidence"] });
  const base = { task, runtime: "codex", projectRoot: fixture.repoRoot, stateDir: "tmp/role-required", dbPath: "tmp/role-required.sqlite", criticalInput,
    governanceTaskFacts: localProtocolFixtureTaskFacts(task), projectCapabilityMutationMode: "read_only" };
  const prepared = await run({ ...base, runId: "role-required-fetch" });
  const owner = prepared.fetchPacket.capabilityDiscovery.agents.find(item => item.id === unrelated.id && item.source === "project_runtime_agent_inventory");
  persistProjectProfessionalFixture(fixture.repoRoot, owner, unrelated);
  const delivery = fixtureReadWorkOrder(prepared, { id: "maintenance", todayTask: task, output: "Maintenance brief", criterionIds: ["user-outcome"], taskFacts: base.governanceTaskFacts, selectedProviders: { agent: owner } });
  delete delivery.projectCapabilityIntent;
  const preparation = fixtureReadWorkOrder(prepared, { id: "inspect", todayTask: task, output: "Source diagnosis", criterionIds: ["user-outcome"], taskFacts: base.governanceTaskFacts });
  const dependent = { ...structuredClone(preparation), roleInstanceId: "dependent", dependsOn: [delivery.roleInstanceId] };
  const thinkingInput = fixtureThinkingInput(prepared, { criticalInput, workOrders: () => [delivery, preparation, dependent] });
  thinkingInput.thinkingPacket.projectCapabilityRequirements = [{ projectId: "maintenance", role: "maintenance-planner", baseComponentId: "backend", baseComponentVersion: "fixture",
    domainEvidenceRefs: [unrelated.rules.ref], responsibilities: ["Own maintenance escalation"], boundaries: ["Keep equipment evidence"], projectDelta: ["Do not reuse package-maintainer; maintain the duty-technician escalation boundary in maintenance-planner"],
    reuseConditions: ["Current equipment responsibilities"], targetPath: ".codex/agents/maintenance-planner.toml", requiredInputs: [unrelated.rules.ref], toolRequirements: [], acceptance: ["Escalation retains equipment evidence"] }];
  let invoked = 0;
  const result = await run({ ...base, runId: "role-required-plan", previousPlanChallengeRunId: prepared.runId, thinkingInput,
    stageRunner: { enabled: true, evidenceKind: "explicit_protocol_test_double", invokeWorker: async () => {
      invoked++; throw new Error("Preparation dispatch observed by test double; no model or user outcome is claimed");
    } } });
  assert.deepEqual(result.workerTaskPackets.map(packet => packet.roleInstanceId), ["inspect"]);
  assert.equal(result.workerTaskPackets[0].workOrderReadiness, "ready");
  assert.equal(invoked, 1, "The independent preparation must reach the existing executor, not merely appear ready in JSON");
  assert.equal(result.projectCustomizationPacket.decisions[0].decision, "create_project_local_capability", "Mentioning an unrelated owner in a refusal is not a role binding");
  assert.equal(result.projectCustomizationPacket.decisions[0].projectCandidateChecked.matched, false);
  assert.ok(result.sourceArtifacts.orchestrationReport.designRouteEvidence.find(item => item.sliceId === "maintenance").capabilityGapPacket.missing.includes("required_project_role_unavailable:maintenance-planner"));
});

test("ordinary entry derives project roles without creation keywords, materializes reviewed source, reloads and reuses its actual rules", async t => {
  const fixture = createGovernanceRuntimeFixtureScope(t); refreshFixtureSourcePins(fixture);
  for (const runtime of [".codex", ".claude"]) rmSync(path.join(fixture.home, runtime, "skills/create-agent"), { recursive: true });
  const refresh = fixture.run(["scripts/discover-global-capabilities.mjs", "--runtime-inventory-only"]);
  assert.equal(refresh.status, 0, refresh.stderr || refresh.stdout);
  const { runMetaTheoryGovernedExecution: run } = await fixture.import("scripts/run-meta-theory-governed-execution.mjs");
  const task = "先把设备故障分级到交接前的安排做好";
  const id = "maintenance-planner";
  const instructions = "Own this maintenance project's technician triage and escalation review. Preserve equipment identifiers; review the local fault-severity ladder before assigning any response. Demand an evidence link for every maintenance recommendation.";
  const rules = write(fixture.repoRoot, "project-methods/maintenance-rules.md", "Escalate high-temperature alarms to the duty technician; preserve equipment ID and the observed reading. Record uncertainty before assigning a response.");
  const requirement = { projectId: "maintenance", role: id, baseComponentId: "backend", baseComponentVersion: "disposable-fixture-v1",
    domainEvidenceRefs: [rules.ref], responsibilities: ["Own technician triage and escalation"], boundaries: ["Keep equipment identity and observed readings"],
    projectDelta: "Apply the local fault-severity and duty-technician responsibilities to every maintenance recommendation.", reuseConditions: ["Current source and fault-severity ladder remain unchanged"],
    targetPath: `.codex/agents/${id}.toml`, requiredInputs: [rules.ref], toolRequirements: [], acceptance: ["Recommendations retain equipment ID, reading and evidence"] };
  const criticalInput = fixtureCritical({ task, successCriteria: ["Maintenance decisions preserve equipment ID and escalation evidence"] });
  const research = { schemaVersion: 2, taskHash: criticalInput.taskHash, intentDigest: null, required: false,
    sources: [{ id: "maintenance-guide", kind: "official", url: "https://example.com/disposable-maintenance-guidance", observedAt: "2026-01-01T00:00:00Z",
      relevance: "Synthetic protocol source for this test", findings: "Escalation retains equipment ID and reading", adaptation: "Protocol fixture only; no external source was fetched" }],
    topics: [{ id: "triage-route", question: "Which maintenance triage method fits?", keywords: ["triage"], queries: [], sourceIds: ["maintenance-guide"], decisionRefs: [],
      decisionImpact: "Defines maintenance escalation", status: "resolved", conclusion: "Preserve the verified local severity ladder",
      decisionContext: { alternatives: [{ id: "local-ladder", mechanism: "Use the project severity ladder", tradeoffs: ["Needs a maintained duty roster"], sourceIds: ["maintenance-guide"] }],
        selectedAlternativeId: "local-ladder", selectionRationale: "The supplied project source defines this responsibility", stopReason: "The bounded fixture question is covered",
        compatibility: [{ component: "maintenance-guide", version: "fixture-1", conditions: "For the supplied test source only", status: "supported", sourceIds: ["maintenance-guide"] }],
        remainingUnknowns: [{ id: "roster", question: "Who is on duty next month?", impact: "Requires a future roster refresh", blocking: false }] } }] };
  const base = { task, runtime: "codex", projectRoot: fixture.repoRoot, stateDir: "tmp/project-professional", dbPath: "tmp/project-professional.sqlite", criticalInput,
    requirementsDiscoveryInput: { schemaVersion: 1, taskHash: criticalInput.taskHash, intentDigest: null, evidenceRefs: [rules.ref], decisionItems: [], research },
    governanceTaskFacts: localProtocolFixtureTaskFacts(task) };
  const prepared = await run({ ...base, runId: "professional-fetch" });
  const creator = prepared.fetchPacket.capabilityDiscovery.providers.find(provider =>
    provider.id === "create-agent" && provider.source === "repo_canonical_capability_index");
  assert.ok(creator, "The ordinary entry must discover its real first-party creation method");
  const prep = fixtureReadWorkOrder(prepared, { id: "source-inspection", todayTask: "Inspect the supplied maintenance evidence and prepare the local professional source", output: "Project source preparation findings", criterionIds: ["user-outcome"], taskFacts: base.governanceTaskFacts,
    selectedProviders: { agentCreation: creator } });
  prep.projectCapabilityIntent.purpose = "capability_preparation";
  prep.taskFacts = localProtocolFixtureTaskFacts(prep.todayTask);
  const delivery = fixtureReadWorkOrder(prepared, { id: "maintenance-brief", todayTask: task, output: "A maintenance planning brief", criterionIds: ["user-outcome"], taskFacts: base.governanceTaskFacts });
  delete delivery.projectCapabilityIntent;
  const thinking = fixtureThinkingInput(prepared, { criticalInput, workOrders: () => [prep, delivery] });
  thinking.thinkingPacket.projectCapabilityRequirements = [requirement];
  const blocked = await run({ ...base, runId: "professional-missing", previousPlanChallengeRunId: prepared.runId, thinkingInput: thinking });
  assert.equal(blocked.projectCustomizationPacket.decisions[0].decision, "create_project_local_capability");
  assert.ok(blocked.projectCustomizationPacket.execution.results.some(result => result.reason === "creator_output_required"));
  assert.equal(blocked.workerTaskPackets.length, 1, "Unrelated preparation remains available while professional delivery is missing");
  assert.equal(blocked.workerTaskPackets[0].roleInstanceId, prep.roleInstanceId);
  assert.equal(blocked.workerTaskPackets[0].workOrderReadiness, "ready");

  // Explicit test-host authored source and review fixture; no model invocation
  // or autonomous professional-quality result is inferred from this evidence.
  const sourceRef = write(fixture.repoRoot, `tmp/prepared-${id}.toml`, `name = "${id}"\ndescription = "Maintenance project planner"\ndeveloper_instructions = ${JSON.stringify(instructions)}\n`).ref;
  const preview = copyProjectCapability({ projectDir: fixture.repoRoot, runtime: "codex", type: "agent", id, source: path.join(fixture.repoRoot, sourceRef), mode: "create" });
  const contentDigest = "sha256:" + sha(JSON.stringify(preview.capability.files.map(({ relPath, baselineHash }) => ({ relPath, baselineHash })).sort((a,b) => a.relPath.localeCompare(b.relPath))));
  const evidence = write(fixture.repoRoot, `tmp/${id}-authorship.json`, { evidenceClass: "test-host-authored-protocol-fixture", sourceRef, rules, nativeInvocationVerified: false });
  const artifact = { requestedCapability: id, capabilityType: "agent", runtime: "codex", projectRoot: fixture.repoRoot, sourceRef,
    creatorProviderId: creator.id, creatorMethodRef: path.join(fixture.repoRoot, "canonical/skills/meta-theory/references", creator.sourceRef), evidenceRefs: [evidence.ref], contentDigest,
    professionalRequirementDigest: "sha256:" + productDesignDigest(requirement) };
  const review = write(fixture.repoRoot, `tmp/${id}-review.json`, { ...artifact, status: "approved", evidenceClass: "fixture_review_not_user_or_native_acceptance" });
  artifact.review = { status: "approved", approvalRef: review.ref, contentDigest };
  const created = await run({ ...base, runId: "professional-created", previousPlanChallengeRunId: prepared.runId, thinkingInput: thinking,
    projectCapabilityCreationArtifacts: [artifact] });
  assert.equal(created.projectCustomizationPacket.execution.appliedCount, 1, JSON.stringify(created.projectCustomizationPacket.execution.results));
  assert.equal(readFileSync(path.join(fixture.repoRoot, requirement.targetPath), "utf8"), readFileSync(path.join(fixture.repoRoot, sourceRef), "utf8"));
  const refetched = await run({ ...base, runId: "professional-refetch" });
  const owner = refetched.fetchPacket.capabilityDiscovery.agents.find(candidate => candidate.id === id && candidate.source === "project_runtime_agent_inventory");
  assert.ok(owner, "Actual newly written native project source must be rediscovered");
  persistProjectProfessionalFixture(fixture.repoRoot, owner, { id, rules, instructions });
  const ownedOrder = fixtureReadWorkOrder(refetched, { id: delivery.roleInstanceId, todayTask: task, output: delivery.output, criterionIds: ["user-outcome"], taskFacts: base.governanceTaskFacts,
    selectedProviders: { agent: owner } });
  delete ownedOrder.projectCapabilityIntent;
  ownedOrder.researchRefs = ["maintenance-guide"];
  const ownedThinking = fixtureThinkingInput(refetched, { criticalInput, workOrders: () => [ownedOrder] });
  ownedThinking.thinkingPacket.projectCapabilityRequirements = [requirement];
  for (const runId of ["professional-ready", "professional-reuse"]) {
    const result = await run({ ...base, runId, previousPlanChallengeRunId: refetched.runId, thinkingInput: ownedThinking });
    const packet = result.workerTaskPackets[0]; assert.ok(packet, JSON.stringify(result.capabilityGapPacket));
    assert.equal(packet.workOrderReadiness, "ready");
    assert.equal(packet.projectCapabilityBinding.status, "project_owned_ready");
    assert.equal(result.projectCustomizationPacket.execution.appliedCount, 0);
    assert.equal(result.projectCustomizationPacket.decision, "reuse_project_capability");
    for (const message of [packet.runtimeInvocationPlan.message, packet.runtimeInvocationPlan.followupTaskTemplate.message]) {
      const view = JSON.parse(message); assert.match(view.projectCapabilityBinding.ownerSource.content, /technician triage/u);
      assert.match(view.projectCapabilityBinding.materials[0].content, /high-temperature alarms/u);
      assert.equal(view.researchEvidence[0].decisionContexts[0].context.selectedAlternativeId, "local-ladder");
      assert.equal(view.researchEvidence[0].decisionContexts[0].context.compatibility[0].version, "fixture-1");
    }
    const prompt = buildReadOnlyWorkerPrompt({ runId, runtime: "codex", node: { nodeId: "bounded-professional" }, packet });
    assert.match(prompt, /technician triage/u); assert.match(prompt, /high-temperature alarms/u);
    assert.match(prompt, /local-ladder/u); assert.match(prompt, /Who is on duty next month/u);
    if (runId === "professional-reuse") {
      writeFileSync(path.join(fixture.repoRoot, requirement.targetPath), "Changed local identity without review");
      assert.throws(() => buildReadOnlyWorkerPrompt({ runId, runtime: "codex", node: { nodeId: "bounded-professional" }, packet }), /source changed before delivery|agent_profile_reference_digest_mismatch/u);
    }
  }
});
