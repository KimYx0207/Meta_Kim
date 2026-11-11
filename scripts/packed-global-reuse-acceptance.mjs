import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { taskOutcomeDigest } from "../src/domain/governance/task-outcome.mjs";

export const PACKED_REUSE_REVIEWER = "acceptance-global-reuse-reviewer";

function discoveredProvider(preparation, fixture, kind, env) {
  const discovery = preparation.fetchPacket.capabilityDiscovery;
  const records = kind === "agent" ? discovery.agents : discovery.providers;
  const expand = value => value?.startsWith("~/") ? path.join(env.HOME, value.slice(2)) : value;
  const candidates = records.filter(provider => {
    if (provider.id !== fixture.id || provider.routeEligible === false || provider.executionEligible === false || provider.cacheEvidenceOnly) return false;
    const sourceRef = expand(provider.sourceRef);
    if (!sourceRef) return false;
    const source = path.isAbsolute(sourceRef) ? sourceRef : path.resolve(expand(provider.sourceRoot) ?? env.HOME, sourceRef);
    return path.resolve(source) === path.resolve(fixture.source);
  });
  assert.equal(candidates.length, 1, `Expected exactly one actual Fetch binding for ${fixture.id}; found ${candidates.length}`);
  assert.match(candidates[0].inventoryRef, /^sha256:[a-f0-9]{64}$/u);
  return structuredClone(candidates[0]);
}

/** Exercise the actual two-call host protocol without executing any worker/model. */
export function runPackedGlobalReusePlanning({ installedPackageRoot, roots, env, fixtures, task, runId, artifactDir, stateDir, dbPath, timeoutMs }) {
  const inputs = path.join(artifactDir, "host-inputs");
  mkdirSync(inputs, { recursive: true });
  const put = (name, value) => {
    const file = path.join(inputs, name);
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return file;
  };
  const sourceSelection = put("source-selection.json", {
    purpose: "Disposable packed acceptance: plan copy-free reuse of existing local global sources",
    sources: fixtures.map(({ type, id, source }) => ({ type, id, source })),
    nativeInvocationClaimed: false,
  });
  const evidenceRefs = [path.relative(roots.projectDir, sourceSelection).split(path.sep).join("/")];
  const critical = {
    taskHash: taskOutcomeDigest(task), intentDigest: null, realIntent: task,
    successCriteria: [{
      id: "global-reuse-without-copy",
      condition: "All three requested global capabilities resolve to use_global_directly, with no project copies or ownership entries.",
      evidenceRequired: "Actual discovered source bindings, project customization decisions and unchanged project capability paths/manifest.",
    }],
    blockingUnknowns: [],
    nonGoals: ["No model execution, capability edits, external writes or native invocation claims"], evidenceRefs,
  };
  const facts = {
    schemaVersion: "governance-task-facts-v2", taskHash: critical.taskHash,
    intent: { executable: true, userRequestedReview: false, durableLearningRequested: false },
    clarity: { blockingUnknowns: [] },
    evidence: { currentExternalFactsRequired: false, localEvidenceSufficient: true, references: ["evidence:packed-global-reuse-source-selection"] },
    change: {
      multiStep: false, crossModule: false, dataMigration: false, externalSideEffect: false,
      complexArchitectureChange: false, multipleCapabilities: true, publicInterfaceChange: false,
      complexBusinessLogic: false, dataStructureChange: false, behaviorPreservingInternalOnly: true,
    },
    decision: { reasonableOptionCount: 1, materialDimensions: [], internalImplementationOnly: true },
    security: {
      auth: false, permission: false, credential: false, secret: false, payment: false,
      production: false, databaseDestructive: false, systemConfiguration: false,
      highPrivilegeDependency: false, highRiskMcp: false,
    },
    verification: { deterministicChecks: ["check:actual-global-binding", "check:no-project-copy", "check:no-project-ownership-entry"] },
    design: { uncertainty: "clear", coupling: "local", operationalRisk: "low", verification: "direct" },
  };
  const criticalFile = put("critical.json", critical);
  const factsFile = put("task-facts.json", facts);
  const args = [
    "--task", task, "--state-dir", stateDir, "--artifact-dir", artifactDir, "--db", dbPath,
    "--runtime", "codex", "--os", "auto", "--output-language", "zh-CN", "--no-emit-conversation-notice",
    "--critical-input", criticalFile, "--governance-task-facts-input", factsFile,
  ];
  const invoke = (id, extra = []) => {
    const result = spawnSync(process.execPath, [path.join(installedPackageRoot, "scripts/run-meta-theory-governed-execution.mjs"), ...args, "--run-id", id, ...extra], {
      cwd: roots.projectDir, env, timeout: timeoutMs, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true,
    });
    assert.equal(result.status, 0, `Actual governed packed reuse ${id}: ${result.error?.message ?? result.stderr ?? result.stdout}`);
    return JSON.parse(readFileSync(path.join(artifactDir, `${id}.json`), "utf8"));
  };
  const preparation = invoke(`${runId}-fetch`);
  assert.equal(preparation.artifactKind, "host_preparation");
  assert.equal(preparation.preparation.status, "needs_thinking");
  assert.deepEqual(preparation.workerTaskPackets, []);
  assert.match(preparation.fetchPacket.capabilityDiscovery.inventoryDigest, /^[a-f0-9]{64}$/u);
  const selectedCapabilityProviders = Object.fromEntries(fixtures.map(fixture => [
    fixture.type, discoveredProvider(preparation, fixture, fixture.type === "agent" ? "agent" : "provider", env),
  ]));
  selectedCapabilityProviders.verificationAgent = discoveredProvider(preparation, {
    id: PACKED_REUSE_REVIEWER, source: path.join(roots.codexHome, "agents", `${PACKED_REUSE_REVIEWER}.toml`),
  }, "agent", env);
  const workOrder = {
    roleInstanceId: "global-reuse-source-review", roleDisplayName: "review", todayTask: task,
    output: "A source-bound plan for the three existing global capabilities with no project materialization",
    capabilityNeed: ["Inspect existing global capability bindings and preserve copy-free reuse"],
    evidenceRefs, scopeFiles: evidenceRefs, shardScope: evidenceRefs, nonGoals: critical.nonGoals,
    toolRequirements: [], dependsOn: [], acceptanceCriterionIds: ["global-reuse-without-copy"],
    verifySteps: [{
      id: "copy-free-reuse", step: "Compare the requested global sources, customization decisions, project paths and ownership manifest",
      verify: "All three exact source identities use_global_directly; no project capability copy or ownership entry appears",
    }],
    selectionReason: "The test host selects the three exact disposable global sources supplied by this acceptance case and a distinct discovered reviewer.",
    handoffTarget: PACKED_REUSE_REVIEWER,
    qualityBar: "Current source-bound planning only; no invented native execution evidence",
    referenceDirection: "Use only the actual Fetch records and local source-selection input; preserve project/user-owned files.",
    selectedCapabilityProviders, effectClass: "read_only_worker", taskFacts: facts,
  };
  const thinkingFile = put("thinking.json", {
    taskHash: critical.taskHash, intentDigest: null,
    requirementsDigest: preparation.requirementsDiscoveryPacket?.discoveryDigest ?? null,
    evidenceRefs, intentPacket: critical, fetchPacket: preparation.fetchPacket,
    thinkingPacket: {
      designFrame: "Explicit test-host judgment for copy-free reuse of three known disposable local capabilities; no worker invocation is asserted.",
      consideredLanes: [{ id: workOrder.roleInstanceId, reason: workOrder.selectionReason }],
      omittedLanesWithReason: [{ id: "capability-materialization", reason: "The requested capabilities already exist globally and no iteration is requested." }],
      workerTaskPackets: [workOrder],
    },
  });
  const artifact = invoke(runId, ["--thinking-input", thinkingFile, "--previous-plan-challenge-run", preparation.runId]);
  const gate = artifact.selectedExecutionRoute?.routeExecutionGate;
  assert.equal(gate?.routeCompatible, true, JSON.stringify(gate));
  assert.equal(gate.canHandoffToHost, true, JSON.stringify(gate));
  assert.equal(gate.handoffStatus, "ready_for_host_handoff");
  assert.equal(artifact.workerTaskPackets.length, 1);
  assert.equal(artifact.workerTaskPackets[0].roleInstanceId, workOrder.roleInstanceId);
  assert.equal(artifact.workerTaskPackets[0].workOrderReadiness, "ready");
  assert.equal(artifact.machineExecution.status, "blocked");
  assert.deepEqual(artifact.machineExecution.calls, []);
  assert.equal(artifact.machineExecution.publicReady, false);
  return artifact;
}
