import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverDependencyAgentContracts } from "../../scripts/dependency-agent-discovery.mjs";
import { fixtureCritical, fixtureInventoryProvider, runWithFixtureHostThinking } from "./host-reasoning-fixture.mjs";
import { readOnlyFixtureTaskFacts } from "./task-design-facts.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const digest = value => createHash("sha256").update(value).digest("hex");

/** Capture only fixture server startup, before any calculation materials are
 * sent. Keep at most 8 KiB, report it only on failed connection, and never use
 * this diagnostic helper for transports carrying real user materials. */
export async function connectFixtureMcpWithDiagnostics(client, transport) {
  const limit = 8192;
  let tail = Buffer.alloc(0);
  const stderr = transport.stderr;
  const capture = chunk => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    tail = bytes.length >= limit
      ? Buffer.from(bytes.subarray(bytes.length - limit))
      : Buffer.concat([tail.subarray(Math.max(0, tail.length + bytes.length - limit)), bytes]);
  };
  stderr?.on("data", capture);
  try {
    await client.connect(transport);
  } catch (error) {
    const diagnostic = tail.toString("utf8").trim() || "<no startup stderr captured>";
    throw new Error(`Fixture MCP connection failed: ${error.message}\nServer startup stderr (last ${limit} bytes):\n${diagnostic}`, { cause: error });
  } finally {
    stderr?.removeListener("data", capture);
    stderr?.resume();
  }
}

/** Failure diagnostics contain machine status only, never receipts or materials. */
export function fixtureCalculationDiagnostics(value) {
  return JSON.stringify({ status: value?.status, code: value?.code, toolInvoked: value?.toolInvoked,
    gate: value?.gate ? { handoffStatus: value.gate.handoffStatus, blockedBy: value.gate.blockedBy } : undefined,
  }).slice(0, 4096);
}

/** Test-host judgment is explicit at each call site. Only the source binding is
 * obtained mechanically from the real configured dependency; no lexical choice,
 * semantic quality result, user approval or native invocation is manufactured. */
export async function fixtureCalculationAssessment({ task, dependencyRoot, ownerId, operation, deliverable,
  fitRationale, nonGoals, runtime = "codex", projectRoot = repoRoot }) {
  const { projects } = JSON.parse(await readFile(path.join(repoRoot, "config/capability-index/dependency-project-registry.json"), "utf8"));
  const discovery = await discoverDependencyAgentContracts({ projects, projectRoot,
    environment: { ...process.env, META_KIM_KIM_SERVICE_ROOT: dependencyRoot } });
  const owners = discovery.agents.filter(owner => owner.id === ownerId);
  assert.equal(owners.length, 1, JSON.stringify(discovery.sources));
  const owner = owners[0];
  return { schemaVersion: 1, runtime, taskHash: digest(task), agentId: owner.id, contentDigest: owner.contentDigest,
    componentContentSha256: owner.ownerContract.componentContentSha256, operation, deliverable, fitRationale,
    nonGoals, evidenceRefs: [owner.sourceRef] };
}

/** Run the actual Critical -> Fetch -> host Thinking protocol. The caller names
 * the intended operation and owner; providers come from this run's Fetch. Keep
 * the resulting inputs on options so a durable resume uses the same decision. */
export async function runWithCalculationHostThinking(run, options, { ownerId, operation, deliverable, fitRationale, nonGoals }) {
  if (options.thinkingInput) return run(options);
  const criticalInput = fixtureCritical({ task: options.task, successCriteria: [deliverable], nonGoals });
  return runWithFixtureHostThinking(async current => {
    if (current.thinkingInput) Object.assign(options, { criticalInput: current.criticalInput,
      governanceTaskFacts: current.governanceTaskFacts, thinkingInput: current.thinkingInput,
      previousPlanChallengeRunId: current.previousPlanChallengeRunId });
    return run(current);
  }, options, { criticalInput, governanceTaskFacts: readOnlyFixtureTaskFacts(options.task), workOrders: preparation => {
    const owners = preparation.fetchPacket.capabilityDiscovery.agents.filter(owner => owner.id === ownerId);
    assert.equal(owners.length, 1, "The selected calculation owner must be present in current Fetch");
    const owner = structuredClone(owners[0]);
    assert.equal(owner.source, "dependency_agent_contract");
    assert.equal(owner.ownerContract.capabilities.length, 1, "Fixture requires an explicit unique method");
    return [{ roleInstanceId: "material-analysis", roleDisplayName: "analysis", todayTask: operation, output: deliverable,
      capabilityNeed: [operation], evidenceRefs: [owner.sourceRef], scopeFiles: [],
      shardScope: ["input-sha256:" + digest(options.dependencyCalculationInput.inputJson)],
      nonGoals, toolRequirements: [], dependsOn: [], acceptanceCriterionIds: ["user-outcome"],
      verifySteps: [{ id: "material-result", step: "Compare every computed row and unknown against the supplied inputs and current receipt",
        verify: "Preserve raw materials, exact computed values and missing evidence; never invent a professional or native acceptance" }],
      selectionReason: fitRationale, handoffTarget: "review", qualityBar: "Exact receipt and declared evidence gaps, with no external action",
      referenceDirection: "Read the selected source contract and complete provided materials; use actual helper output only.",
      selectedCapabilityProviders: { agent: owner, verificationAgent: fixtureInventoryProvider(preparation, "review"),
        skill: fixtureInventoryProvider(preparation, "get-context", "providers") },
      methodCapabilityId: owner.ownerContract.capabilities[0].id,
      effectClass: "read_only_worker", taskFacts: readOnlyFixtureTaskFacts(operation) }];
  } });
}
