/** Validation-only host driver for fixed, bounded read scenarios.
 *
 * Ordinary production requests never import this module. Diagnostics must use
 * the same prepare/resume protocol as the real host, read the actual Fetch
 * inventory, and keep selection, invocation and acceptance separate.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { taskOutcomeDigest } from "../src/domain/governance/task-outcome.mjs";

function diagnosticFacts(task) {
  return {
    schemaVersion: "governance-task-facts-v2", taskHash: taskOutcomeDigest(task),
    intent: { executable: true, userRequestedReview: false, durableLearningRequested: false },
    clarity: { blockingUnknowns: [] },
    evidence: { currentExternalFactsRequired: false, localEvidenceSufficient: true, references: ["evidence:bounded-diagnostic-source-read"] },
    change: { multiStep: false, crossModule: false, dataMigration: false, externalSideEffect: false,
      complexArchitectureChange: false, multipleCapabilities: false, publicInterfaceChange: false,
      complexBusinessLogic: false, dataStructureChange: false, behaviorPreservingInternalOnly: true },
    decision: { reasonableOptionCount: 1, materialDimensions: [], internalImplementationOnly: true },
    security: { auth: false, permission: false, credential: false, secret: false, payment: false,
      production: false, databaseDestructive: false, systemConfiguration: false, highPrivilegeDependency: false, highRiskMcp: false },
    verification: { deterministicChecks: ["check:diagnostic-source-binding"] },
    design: { uncertainty: "clear", coupling: "local", operationalRisk: "low", verification: "direct" },
  };
}

function selectedProvider(preparation, kind, preferredIds) {
  const inventory = preparation.fetchPacket.capabilityDiscovery[kind];
  for (const id of preferredIds) {
    const candidates = inventory.filter(provider => provider.id === id &&
      provider.routeEligible !== false && provider.executionEligible !== false && !provider.cacheEvidenceOnly &&
      (provider.runtime === "codex" || /[\\/]\.codex[\\/]/u.test(provider.sourceRef ?? "")));
    if (!candidates.length) continue;
    assert.equal(candidates.length, 1, `Diagnostic needs one current source for ${id}; ambiguous sources require host selection`);
    assert.match(candidates[0].inventoryRef, /^sha256:[a-f0-9]{64}$/u);
    return structuredClone(candidates[0]);
  }
  throw new Error(`Diagnostic capability unavailable: ${kind} ${preferredIds.join(", ")}`);
}

export async function runDiagnosticReadPlan(run, options, scopes) {
  assert.equal(typeof run, "function");
  assert.ok(Array.isArray(scopes) && scopes.length > 0);
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  for (const scope of scopes) {
    assert.equal(typeof scope, "string");
    assert.ok(!path.isAbsolute(scope) && !scope.split(/[\\/]/u).includes(".."), "Diagnostic scope must remain project-relative");
    await readFile(path.join(projectRoot, scope), "utf8");
  }
  const criticalInput = { taskHash: taskOutcomeDigest(options.task), intentDigest: null, realIntent: options.task,
    successCriteria: scopes.map((scope, index) => ({ id: `diagnostic-source-${index + 1}`,
      condition: `Inspect ${scope} and retain source-bound findings without modifying it.`,
      evidenceRequired: `Current ${scope} bytes and an independently reviewed worker result.` })),
    blockingUnknowns: [], nonGoals: ["No writes, installs, external actions, model calls or fabricated native execution."], evidenceRefs: scopes };
  const governanceTaskFacts = diagnosticFacts(options.task);
  const prepared = await run({ ...options, runId: options.runId + "-fetch", projectRoot, criticalInput, governanceTaskFacts,
    stageRunner: null, invokeCapabilityProbes: false, emitConversationNotice: false, onConversationProgress: null,
    hostInvocationEvidence: [], hostInvocationEvidenceTrusted: false });
  const preparation = JSON.parse(await readFile(prepared.paths.json, "utf8"));
  assert.equal(preparation.artifactKind, "host_preparation");
  assert.equal(preparation.preparation.status, "needs_thinking");
  assert.deepEqual(preparation.workerTaskPackets, []);
  assert.equal(preparation.coreLoop.stageDagPacket, undefined);
  const agent = selectedProvider(preparation, "agents", ["backend", "analysis"]);
  const verificationAgent = selectedProvider(preparation, "agents", ["review", "meta-prism"]);
  const skill = selectedProvider(preparation, "providers", ["get-context", "meta-theory"]);
  const packets = scopes.map((scope, index) => {
    const id = `diagnostic-read-${index + 1}`;
    const todayTask = `Inspect ${scope} and return source-bound findings without editing files.`;
    return { roleInstanceId: id, roleDisplayName: "analysis", todayTask, output: `Evidence report for ${scope}`,
      capabilityNeed: ["bounded source inspection"], evidenceRefs: [scope], scopeFiles: [scope], shardScope: [scope],
      nonGoals: criticalInput.nonGoals, toolRequirements: [], dependsOn: [],
      acceptanceCriterionIds: [criticalInput.successCriteria[index].id],
      verifySteps: [{ id: id + "-check", step: `Read ${scope} and compare the finding with the source`, verify: "Finding matches the source; absent execution stays unverified." }],
      selectionReason: "The diagnostic host selects current discovered read-capable sources for an independent read-only lane.",
      handoffTarget: "review", qualityBar: "Source-bound findings with no invocation or acceptance overclaim.",
      referenceDirection: `Read only ${scope}; the diagnostic exercises protocol and does not certify a professional result.`,
      selectedCapabilityProviders: { agent, verificationAgent, skill }, effectClass: "read_only_worker", taskFacts: diagnosticFacts(todayTask) };
  });
  const thinkingInput = { taskHash: criticalInput.taskHash, intentDigest: null,
    requirementsDigest: preparation.requirementsDiscoveryPacket?.discoveryDigest ?? null, evidenceRefs: scopes,
    intentPacket: criticalInput, fetchPacket: preparation.fetchPacket,
    thinkingPacket: { designFrame: "Fixed diagnostic: independent source reads, explicit owner bindings, no mutation or model invocation.",
      consideredLanes: packets.map(packet => ({ id: packet.roleInstanceId, reason: packet.selectionReason })),
      omittedLanesWithReason: [{ id: "production-delivery", reason: "This diagnostic checks protocol and truth boundaries only." }], workerTaskPackets: packets } };
  return run({ ...options, projectRoot, criticalInput, governanceTaskFacts, thinkingInput, previousPlanChallengeRunId: preparation.runId });
}
