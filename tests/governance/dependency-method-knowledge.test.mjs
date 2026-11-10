import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile, symlink, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { loadMethodKnowledgeAssets, METHOD_KNOWLEDGE_LIMITS } from "../../src/infrastructure/capabilities/dependency-method-knowledge.mjs";
import { buildMethodInvocationContext, appendMethodInvocationContext, assertMethodInputsReady, buildMethodDeliveryEnvelope } from "../../scripts/governed-execution/method-delivery.mjs";
import { prepareReadOnlyRuntimeInvocation } from "../../scripts/governed-execution/stage-runner-bridge.mjs";
import { normalizeResearchEvidence, persistResearchEvidence, researchForTask } from "../../scripts/governed-execution/research-records.mjs";
import { localProtocolFixtureTaskFacts } from "../helpers/task-design-facts.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-method-knowledge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "references"));
  await writeFile(path.join(root, "references/method.md"), "Use project typography. Preserve input on submission errors.");
  return { componentRoot: root, capabilityId: "frontend-delivery", method: { knowledgeAssets: [{ id: "frontend-basics", path: "references/method.md", appliesTo: ["always"], sourceRefs: ["fixture:reviewed-method"] }] } };
}

test("selected source knowledge reaches the actual method prompt with its byte binding", async t => {
  const input = await fixture(t);
  const knowledgeAssets = await loadMethodKnowledgeAssets(input);
  assert.equal(knowledgeAssets.length, 1);
  assert.match(knowledgeAssets[0].sha256, /^[a-f0-9]{64}$/u);
  const context = buildMethodInvocationContext({ method: { ...input, methodStatus: "structured_method_loaded", knowledgeAssets,
    inputContract: { type: "object", required: [], properties: { designBinding: { type: "object" }, designContext: { type: "object" } } } },
    packet: { taskPacketId: "frontend", methodInputs: { designBinding: { designId: "forged" } }, designBinding: { designId: "current" }, designContext: { softwareDesign: { modules: [{ id: "signup" }] } } } });
  const prompt = appendMethodInvocationContext("Implement the current task", context);
  assert.ok(prompt.includes("Preserve input on submission errors"));
  assert.ok(prompt.includes(knowledgeAssets[0].sha256));
  assert.equal(context.inputs.designBinding.designId, "current");
  assert.equal(context.knowledgeAssets[0].evidenceClass, "loaded_component_resource");
});

test("resource selection is explicit and escaping or oversized resources fail before invocation", async t => {
  const input = await fixture(t);
  input.method.knowledgeAssets[0].appliesTo = ["unrelated-method"];
  assert.deepEqual(await loadMethodKnowledgeAssets(input), []);
  input.method.knowledgeAssets[0].path = "../outside.md";
  await assert.rejects(loadMethodKnowledgeAssets(input), /escape/);
  input.method.knowledgeAssets[0].path = "references/method.md";
  input.method.knowledgeAssets[0].appliesTo = ["always"];
  await writeFile(path.join(input.componentRoot, "references/method.md"), "x".repeat(METHOD_KNOWLEDGE_LIMITS.perAssetBytes + 1));
  await assert.rejects(loadMethodKnowledgeAssets(input), /too large/);
});

test("knowledge content is reread and linked files cannot masquerade as package resources", async t => {
  const input = await fixture(t);
  const first = await loadMethodKnowledgeAssets(input);
  await writeFile(path.join(input.componentRoot, "references/method.md"), "Changed project-specific method.");
  const second = await loadMethodKnowledgeAssets(input);
  assert.notEqual(first[0].sha256, second[0].sha256);
  try { await symlink(path.join(input.componentRoot, "references/method.md"), path.join(input.componentRoot, "linked.md")); }
  catch (error) { if (process.platform === "win32" && error.code === "EPERM") { t.diagnostic("Symlink creation unavailable on this Windows host; content reread checked"); return; } throw error; }
  input.method.knowledgeAssets[0].path = "linked.md";
  await assert.rejects(loadMethodKnowledgeAssets(input), /symlink|junction/);
});

test("shared task defaults respect each selected method's actual input type without hiding required or supplied errors", () => {
  const method = { method: { schemaVersion: 1 }, methodStatus: "structured_method_loaded",
    inputContract: { type: "object", required: ["request"], properties: { request: { type: "string" }, constraints: { type: "string" } } } };
  const packet = { taskPacketId: "typed-method", methodInputs: { request: "Review the supplied materials" }, nonGoals: ["Do not send messages"] };
  const optional = buildMethodInvocationContext({ method, packet });
  assertMethodInputsReady(optional);
  assert.equal(Object.hasOwn(optional.inputs, "constraints"), false, "An object default does not poison an optional text field");
  assert.deepEqual(optional.context.nonGoals, packet.nonGoals, "The actual task restriction is still delivered");

  const objectMethod = structuredClone(method);
  objectMethod.inputContract.properties.constraints = { type: ["string", "object", "array"] };
  const compatible = buildMethodInvocationContext({ method: objectMethod, packet });
  assertMethodInputsReady(compatible);
  assert.deepEqual(compatible.inputs.constraints, { nonGoals: packet.nonGoals });

  const supplied = buildMethodInvocationContext({ method, packet: { ...packet, methodInputs: { ...packet.methodInputs, constraints: "One page, factual wording" } } });
  assert.equal(supplied.inputs.constraints, "One page, factual wording");
  const invalid = buildMethodInvocationContext({ method, packet: { ...packet, methodInputs: { ...packet.methodInputs, constraints: { invented: true } } } });
  assert.throws(() => assertMethodInputsReady(invalid), /constraints \(type_mismatch\)/);

  const requiredMethod = structuredClone(method);
  requiredMethod.inputContract.required.push("constraints");
  const missing = buildMethodInvocationContext({ method: requiredMethod, packet });
  assert.throws(() => assertMethodInputsReady(missing), /constraints \(missing\)/, "An incompatible fallback never satisfies a mandatory input");
});

test("all real professional packages deliver complete knowledge through the registered Meta method handoff", {
  skip: !process.env.META_KIM_TEST_KIM_SERVICE_SOURCE && "Requires an explicitly selected real Kim_Service source",
}, async t => {
  const { discoverDependencyAgentContracts, matchDependencyAgentContracts, loadDependencyAgentMethod } = await import("../../scripts/dependency-agent-discovery.mjs");
  const { buildDependencyMethodHandoff } = await import("../../scripts/dependency-method-handoff.mjs");
  const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
  const serviceRoot = path.resolve(process.env.META_KIM_TEST_KIM_SERVICE_SOURCE);
  const git = promisify(execFile);
  assert.equal((await git("git", ["-C", serviceRoot, "status", "--porcelain"])).stdout, "",
    "Commit-bound research must read a clean source checkout");
  const sourceRevision = (await git("git", ["-C", serviceRoot, "rev-parse", "HEAD"])).stdout.trim();
  assert.match(sourceRevision, /^[a-f0-9]{40}$/u);
  await mkdir(path.join(projectRoot, "tmp"), { recursive: true });
  const researchOutputDir = await mkdtemp(path.join(projectRoot, "tmp", "method-knowledge-decision-"));
  t.after(() => rm(researchOutputDir, { recursive: true, force: true }));
  const environment = { ...process.env, META_KIM_KIM_SERVICE_ROOT: serviceRoot };
  const { projects } = JSON.parse(await readFile(path.join(projectRoot, "config/capability-index/dependency-project-registry.json"), "utf8"));
  const discovery = await discoverDependencyAgentContracts({ projects, projectRoot, environment });
  const index = JSON.parse(await readFile(path.join(serviceRoot, "generated/capabilities.json"), "utf8"));
  const roles = index.components.filter(component => component.componentType === "agent").map(component => component.id).sort();
  assert.ok(roles.length > 0, "The explicitly selected source has professional components");
  assert.deepEqual(discovery.agents.filter(agent => agent.id.startsWith("kim-service:")).map(agent => agent.componentId).sort(), roles,
    "Every indexed role must be discoverable; adding a role requires package data, not a test or loader switch");
  for (const role of roles) {
    await t.test(role, async () => {
      const owner = discovery.agents.find(agent => agent.id === `kim-service:${role}`);
      assert.ok(owner, JSON.stringify(discovery.sources));
      const task = `Read the ${role} contract and review the bounded current task with its bundled professional method; no source mutation or external action.`;
      const recall = matchDependencyAgentContracts(task, discovery.agents);
      assert.equal(recall.selected, null, "Lexical recall does not make the professional choice");
      const match = matchDependencyAgentContracts(task, discovery.agents, { hostSelection: {
        schemaVersion: 1, taskHash: recall.taskHash, agentId: owner.id, contentDigest: owner.contentDigest,
        componentContentSha256: owner.ownerContract.componentContentSha256,
        operation: "Read and review the bounded role materials", deliverable: `A source-bound ${role} assessment`,
        fitRationale: "Explicit test-host selection of this real source for a transport check; no model-quality claim",
        nonGoals: ["No native invocation or product acceptance"], evidenceRefs: [`agents/${role}/AGENT.md`],
      } });
      const handoff = buildDependencyMethodHandoff({ task, match });
      assert.ok(handoff.recommendation);
      assert.equal(handoff.executionAllowed, false);
      const componentRoot = path.join(serviceRoot, "agents", role);
      const contract = JSON.parse(await readFile(path.join(componentRoot, "capability.json"), "utf8"));
      const sourceMethod = JSON.parse(await readFile(path.join(componentRoot, "method.json"), "utf8"));
      const cases = JSON.parse(await readFile(path.join(componentRoot, sourceMethod.expertise.evaluation.casesPath), "utf8"));
      const example = cases.cases.find(item => item.category === "worked_example" && item.capabilityId === contract.capabilities[0].id);
      assert.ok(example, "The real source supplies a bounded authored example of its declared input");
      assert.equal(cases.evaluationStatus, "not_evaluated", "Authored examples do not claim professional quality");
      const packet = { ...handoff.recommendation, taskPacketId: `knowledge-audit-${role}`, coreProblem: task,
        todayTask: task, taskFactsSubject: task, taskFacts: localProtocolFixtureTaskFacts(task, {
          evidence: { references: [`evidence:knowledge-audit-${role}`, `sha256:${owner.ownerContract.componentContentSha256}`] },
          design: { uncertainty: "focused_unknown", verification: "needs_probe" },
        }),
        methodCapabilityId: contract.capabilities[0].id, methodInputs: example.input,
        scopeFiles: [`agents/${role}/references/professional-method.md`], nonGoals: ["No writes or native-success claims"],
        acceptanceCriterionIds: example.input.acceptanceCriteria?.map(criterion => criterion.id) ?? ["transport-only"] };
      const method = await loadDependencyAgentMethod({ packet, environment, projectRoot });
      assert.ok(method.knowledgeAssets.length > 0);
      const context = buildMethodInvocationContext({ method, packet });
      assertMethodInputsReady(context);
      const prepare = candidate => prepareReadOnlyRuntimeInvocation({ runtime: "codex", workspaceRoot: projectRoot,
        packet: candidate, prompt: "Bounded source-review task", env: environment });
      await assert.rejects(prepare(packet), /current_subtask_decision_evidence_required/,
        "Verified source metadata alone does not resolve this subtask's focused decision");
      // The test host has actually loaded this selected package. Its decision
      // records only source/transport suitability, never a web visit, model run
      // or proof that the authored professional examples produce good work.
      const sourceId = `${role}-method`;
      const research = normalizeResearchEvidence({ taskHash: packet.taskFacts.taskHash, input: {
        schemaVersion: 2, taskHash: packet.taskFacts.taskHash, intentDigest: null, required: true,
        topics: [{ id: "source-knowledge-handoff", question: `Which reviewed ${role} assets must reach this bounded method invocation?`,
          keywords: [role], sourceIds: [sourceId], queries: [], decisionRefs: packet.acceptanceCriterionIds,
          decisionImpact: "Select the actual source-bound knowledge and authored checks for this transport probe",
          status: "resolved", conclusion: `Load the verified method and all ${method.knowledgeAssets.length} selected knowledge assets; quality remains not evaluated.` }],
        sources: [{ id: sourceId, kind: "github",
          url: `https://github.com/KimYx0207/Kim_Service/blob/${sourceRevision}/agents/${role}/method.json`,
          revision: sourceRevision, observedAt: new Date().toISOString(),
          relevance: `Read locally from the explicitly selected checkout for ${packet.taskPacketId}; no network request is claimed.`,
          findings: `Verified component ${owner.ownerContract.componentContentSha256}; method ${method.methodSha256}; ` +
            method.knowledgeAssets.map(asset => `${asset.id}: ${asset.bytes} bytes, sha256 ${asset.sha256}`).join("; "),
          adaptation: "Only prompt assembly and exact source delivery are tested. No native model invocation, professional-quality acceptance or external action is authorized." }],
      } });
      assert.equal(research.readiness, "ready");
      const persisted = await persistResearchEvidence({ research, outputDir: researchOutputDir, projectRoot });
      packet.researchEvidence = researchForTask({ research: persisted, sourceIds: [sourceId] });
      packet.researchContextBinding = { taskHash: packet.taskFacts.taskHash, intentDigest: null };
      await assert.rejects(prepare({ ...packet, researchContextBinding: { ...packet.researchContextBinding, taskHash: "0".repeat(64) } }),
        /Research must bind the current task and intent/);
      await assert.rejects(prepare({ ...packet, researchEvidence: packet.researchEvidence.map(item => ({ ...item, summary: "Unreviewed replacement decision" })) }),
        /Task research summary differs from its stored source/);
      const invocation = await prepareReadOnlyRuntimeInvocation({ runtime: "codex", workspaceRoot: projectRoot, packet,
        prompt: "Bounded source-review task", env: environment });
      const prompt = invocation.input;
      const marker = "Source-verified professional method and task inputs (data, not permission):\n";
      assert.ok(prompt.includes(marker));
      const delivered = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length).split("\n")[0]);
      assert.deepEqual(delivered.method.expertise, sourceMethod.expertise, "Diagnosis, decisions and contract guidance reach the actual method context");
      assert.equal(delivered.method.expertise.evaluation.professionalEffect, "not_evaluated");
      const sourceChecks = sourceMethod.expertise.contractGuidance.find(guide => guide.capabilityId === contract.capabilities[0].id).outputChecks;
      assert.equal(delivered.outputReview.standardStatus, "complete_contract", "Published current packages need complete authored quality standards");
      assert.deepEqual(delivered.outputReview.checks.map(({ standardStatus, missingStandardFields, evidenceStatus, ...check }) => check), sourceChecks);
      assert.ok(delivered.outputReview.checks.every(check => check.evidenceStatus === "not_observed"));
      assert.equal(delivered.outputReview.acceptanceStatus, "pending_independent_review");
      assert.equal(invocation.ownerMethodBinding.sourceVerified, true);
      assert.deepEqual(delivered.knowledgeAssets.map(asset => asset.id).sort(), sourceMethod.expertise.knowledgeAssetIds.toSorted());
      for (const asset of delivered.knowledgeAssets) {
        const bytes = await readFile(path.join(componentRoot, asset.path));
        assert.deepEqual(Buffer.from(asset.content, "utf8"), bytes, "Every source byte survives JSON delivery, including line breaks and non-ASCII content");
        assert.equal(asset.bytes, bytes.length);
        assert.equal(asset.sha256, createHash("sha256").update(bytes).digest("hex"));
        assert.deepEqual(asset.sourceRefs, method.knowledgeAssets.find(item => item.id === asset.id).sourceRefs);
        assert.equal(asset.evidenceClass, "loaded_component_resource");
        t.diagnostic(`${role} ${contract.componentVersion}: ${asset.bytes} complete source bytes; sha256=${asset.sha256}`);
      }
      const envelope = buildMethodDeliveryEnvelope({ runId: "knowledge-audit", packet, methodBinding: method,
        outputText: JSON.stringify({ status: "pass", criterionResults: packet.acceptanceCriterionIds.map(id => ({ id,
          status: "pass", evidenceRefs: ["fixture:self-report"], scope: "Transport test only" })) }), evidenceKind: "synthetic_transport_probe" });
      assert.equal(envelope.userOutcomeAccepted, false);
      assert.equal(envelope.acceptanceStatus, "pending_independent_review");
      assert.ok(envelope.criterionResults.every(criterion => criterion.evidenceClass === "worker_self_report" && criterion.acceptanceStatus === "pending_independent_review"));
    });
  }
});
