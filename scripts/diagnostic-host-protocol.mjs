/** Validation-only host driver for fixed, bounded read scenarios.
 *
 * Ordinary production requests never import this module. Diagnostics must use
 * the same prepare/resume protocol as the real host, read the actual Fetch
 * inventory, and keep selection, invocation and acceptance separate.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { taskOutcomeDigest } from "../src/domain/governance/task-outcome.mjs";
import { GOVERNANCE_OWNERS } from "./governance-lib.mjs";

const DEFAULT_PROVIDERS = Object.freeze(JSON.parse(
  readFileSync(new URL("../config/diagnostic-read-plan.json", import.meta.url), "utf8"),
));

function unavailable(detail) {
  const error = new Error(`Diagnostic environment unavailable: ${detail}`);
  error.code = "DIAGNOSTIC_ENVIRONMENT_UNAVAILABLE";
  throw error;
}

function diagnosticProviderSelection(options) {
  const configured = options.diagnosticProviders ??
    (process.env.META_KIM_DIAGNOSTIC_PROVIDERS ? JSON.parse(process.env.META_KIM_DIAGNOSTIC_PROVIDERS) : {});
  const selection = { ...DEFAULT_PROVIDERS, ...configured };
  if (!configured.runtime && options.runtime && options.runtime !== "auto") selection.runtime = options.runtime;
  assert.equal(typeof selection.runtime, "string", "Diagnostic provider selection requires a runtime");
  for (const kind of ["agent", "verificationAgent", "skill"]) {
    assert.ok(typeof selection[kind]?.id === "string" && selection[kind].id.trim(), `Diagnostic ${kind} selection requires an explicit source id`);
    assert.ok(selection[kind].sourceRef === undefined || typeof selection[kind].sourceRef === "string", `Diagnostic ${kind} sourceRef must be a string`);
  }
  return selection;
}

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

function selectedProvider(preparation, kind, selected, runtime) {
  const discovery = preparation.fetchPacket?.capabilityDiscovery;
  if (discovery?.context?.runtime !== runtime) unavailable(`Fetch runtime does not match selected runtime ${runtime}`);
  const inventory = discovery[kind] ?? [];
  const sameRef = (left, right) => left?.replaceAll("\\", "/") === right?.replaceAll("\\", "/");
  const matches = inventory.filter(provider => provider.id === selected.id &&
    (selected.sourceRef === undefined || sameRef(provider.sourceRef, selected.sourceRef)));
  if (kind === "agents" && (GOVERNANCE_OWNERS.includes(selected.id) || matches.some(provider => provider.layer === "governance"))) {
    unavailable(`governance role ${selected.id} cannot be a diagnostic execution or verification owner`);
  }
  const candidates = matches.filter(provider => {
    if (provider.routeEligible === false || provider.executionEligible === false || provider.executionBlock === true || provider.cacheEvidenceOnly) return false;
    const declaredRuntime = provider.runtime ?? provider.platformId;
    if (declaredRuntime) return declaredRuntime === runtime;
    if (provider.source === "dependency_agent_contract") {
      // This contract is a run-scoped planning binding from this runtime's
      // actual Fetch. Preserve needs_probe/not_invoked; it is not a native agent.
      return provider.layer === "execution" && provider.ownerBindingMode === "run_scoped_owner_contract" && Boolean(provider.ownerContract);
    }
    return String(provider.sourceRef ?? "").replaceAll("\\", "/").includes(`/.${runtime}/`);
  });
  if (!candidates.length) unavailable(`current ${runtime} ${kind} source ${selected.id} was not discovered`);
  if (candidates.length !== 1) unavailable(`ambiguous ${selected.id} sources require an explicit sourceRef`);
  assert.match(candidates[0].inventoryRef, /^sha256:[a-f0-9]{64}$/u);
  return structuredClone(candidates[0]);
}

export async function runDiagnosticReadPlan(run, options, scopes) {
  assert.equal(typeof run, "function");
  assert.ok(Array.isArray(scopes) && scopes.length > 0);
  const selection = diagnosticProviderSelection(options);
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
  const prepared = await run({ ...options, runtime: selection.runtime, runId: options.runId + "-fetch", projectRoot, criticalInput, governanceTaskFacts,
    stageRunner: null, invokeCapabilityProbes: false, emitConversationNotice: false, onConversationProgress: null,
    hostInvocationEvidence: [], hostInvocationEvidenceTrusted: false });
  const preparation = JSON.parse(await readFile(prepared.paths.json, "utf8"));
  assert.equal(preparation.artifactKind, "host_preparation");
  assert.equal(preparation.preparation.status, "needs_thinking");
  assert.deepEqual(preparation.workerTaskPackets, []);
  assert.equal(preparation.coreLoop.stageDagPacket, undefined);
  const agent = selectedProvider(preparation, "agents", selection.agent, selection.runtime);
  const verificationAgent = selectedProvider(preparation, "agents", selection.verificationAgent, selection.runtime);
  const skill = selectedProvider(preparation, "providers", selection.skill, selection.runtime);
  if (agent.id === verificationAgent.id || agent.inventoryRef === verificationAgent.inventoryRef || agent.sourceRef === verificationAgent.sourceRef) {
    unavailable("diagnostic execution and verification need distinct current sources");
  }
  const packets = scopes.map((scope, index) => {
    const id = `diagnostic-read-${index + 1}`;
    const todayTask = `Inspect ${scope} and return source-bound findings without editing files.`;
    return { roleInstanceId: id, roleDisplayName: "analysis", todayTask, output: `Evidence report for ${scope}`,
      capabilityNeed: ["bounded source inspection"], evidenceRefs: [scope], scopeFiles: [scope], shardScope: [scope],
      nonGoals: criticalInput.nonGoals, toolRequirements: [], dependsOn: [],
      acceptanceCriterionIds: [criticalInput.successCriteria[index].id],
      verifySteps: [{ id: id + "-check", step: `Read ${scope} and compare the finding with the source`, verify: "Finding matches the source; absent execution stays unverified." }],
      selectionReason: "The diagnostic host selects current discovered read-capable sources for an independent read-only lane.",
      handoffTarget: verificationAgent.id, qualityBar: "Source-bound findings with no invocation or acceptance overclaim.",
      referenceDirection: `Read only ${scope}; the diagnostic exercises protocol and does not certify a professional result.`,
      selectedCapabilityProviders: { agent, verificationAgent, skill }, effectClass: "read_only_worker", taskFacts: diagnosticFacts(todayTask) };
  });
  const thinkingInput = { taskHash: criticalInput.taskHash, intentDigest: null,
    requirementsDigest: preparation.requirementsDiscoveryPacket?.discoveryDigest ?? null, evidenceRefs: scopes,
    intentPacket: criticalInput, fetchPacket: preparation.fetchPacket,
    thinkingPacket: { designFrame: "Fixed diagnostic: independent source reads, explicit owner bindings, no mutation or model invocation.",
      consideredLanes: packets.map(packet => ({ id: packet.roleInstanceId, reason: packet.selectionReason })),
      omittedLanesWithReason: [{ id: "production-delivery", reason: "This diagnostic checks protocol and truth boundaries only." }], workerTaskPackets: packets } };
  const result = await run({ ...options, runtime: selection.runtime, projectRoot, criticalInput, governanceTaskFacts, thinkingInput, previousPlanChallengeRunId: preparation.runId });
  assert.notEqual(result.artifactKind, "host_preparation", "Diagnostic Thinking did not resume the prepared run; execution fields are not available");
  return result;
}
