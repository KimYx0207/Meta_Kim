import assert from "node:assert/strict";
import test from "node:test";

import {
  CANDIDATE_RUNTIME_ADAPTER_SCHEMA_VERSION,
  assertValidDeepSeekHarnessCandidateRuntimePlan,
  buildDeepSeekHarnessCandidateRuntimePlan,
} from "../../src/runtimes/deepseek-harness/candidate-adapter.mjs";

const COMPLETE_PROBE_FACTS = {
  runtimeId: "deepseek-harness",
  version: "0.1.0-preview",
  features: {
    plugin: true,
    preset: true,
    acp: {
      automation: true,
      ui: false,
      configuration: false,
      mcp: false,
      replay: false,
    },
  },
  evidenceRefs: ["probe:deepseek-harness:version", "probe:deepseek-harness:acp"],
};

function assertDeepFrozen(value) {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

test("DeepSeek Harness candidate plan is complete only from explicit facts", () => {
  const plan = buildDeepSeekHarnessCandidateRuntimePlan(COMPLETE_PROBE_FACTS);

  assert.equal(plan.schemaVersion, CANDIDATE_RUNTIME_ADAPTER_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(plan), [
    "schemaVersion",
    "runtimeId",
    "tier",
    "formalProjection",
    "probe",
    "capabilityAssessment",
    "projectionPlan",
    "invocationPolicy",
    "configurationPolicy",
    "authorization",
  ]);
  assert.equal(plan.runtimeId, "deepseek-harness");
  assert.equal(plan.tier, "beta_compatibility");
  assert.equal(plan.formalProjection, false);
  assert.equal(plan.probe.version, "0.1.0-preview");
  assert.equal(plan.probe.factsComplete, true);
  assert.equal(plan.projectionPlan.integrationMode, "opt_in_plugin_preset");
  assert.equal(plan.projectionPlan.enabledByDefault, false);
  assert.equal(plan.projectionPlan.plugin.enabled, false);
  assert.equal(plan.projectionPlan.preset.enabled, false);
  assert.equal(
    plan.capabilityAssessment.acp.scope,
    "automation_transport_only_not_full_runtime_ui",
  );
  assert.equal(plan.capabilityAssessment.acp.nativeRuntimeClaimed, false);
  assert.equal(plan.invocationPolicy.modelInvocationAllowed, false);
  assert.equal(plan.invocationPolicy.processSpawnAllowed, false);
  assert.equal(plan.invocationPolicy.liveRuntimeClaimed, false);
  assert.equal(plan.configurationPolicy.globalConfigWriteAllowed, false);
  assert.equal(plan.configurationPolicy.userConfigOverwriteAllowed, false);
  assert.equal(plan.configurationPolicy.mcpAutoStartAllowed, false);
  assertValidDeepSeekHarnessCandidateRuntimePlan(plan);
  assertDeepFrozen(plan);
});

test("missing version or feature facts fail closed without inventing claims", () => {
  const plan = buildDeepSeekHarnessCandidateRuntimePlan({
    features: {
      plugin: true,
      preset: true,
      acp: { automation: true },
    },
  });

  assert.equal(plan.probe.version, null);
  assert.equal(plan.probe.versionKnown, false);
  assert.equal(plan.probe.features.acp.ui, null);
  assert.equal(plan.probe.features.acp.configuration, null);
  assert.equal(plan.probe.factsComplete, false);
  assert.equal(plan.projectionPlan.blocked, true);
  assert.equal(plan.projectionPlan.applyAllowed, false);
  assert.equal(plan.projectionPlan.writeAllowed, false);
  assert.equal(plan.capabilityAssessment.overallStatus, "blocked_missing_or_incomplete_probe_facts");
  assertValidDeepSeekHarnessCandidateRuntimePlan(plan);
});

test("ACP is a structural seam and never a native UI or live-runtime claim", () => {
  const plan = buildDeepSeekHarnessCandidateRuntimePlan(COMPLETE_PROBE_FACTS);

  assert.equal(plan.projectionPlan.acp.enabled, false);
  assert.equal(plan.projectionPlan.acp.fullRuntimeUi, false);
  assert.equal(plan.projectionPlan.acp.configuration, false);
  assert.equal(plan.projectionPlan.acp.mcp, false);
  assert.equal(plan.projectionPlan.acp.replay, false);
  assert.equal(plan.invocationPolicy.acpAutomationAllowed, false);
  assert.equal(plan.invocationPolicy.acpAutomationUse, "structural_seam_only");
  assert.equal(plan.capabilityAssessment.formalProjectionClaimed, false);
  assert.equal(plan.capabilityAssessment.nativeRuntimeClaimed, false);
  assert.equal(plan.capabilityAssessment.liveAcceptanceClaimed, false);
});

test("candidate authorization is exact, deterministic, and always false", () => {
  const first = buildDeepSeekHarnessCandidateRuntimePlan(COMPLETE_PROBE_FACTS);
  const reorderedFacts = structuredClone(COMPLETE_PROBE_FACTS);
  reorderedFacts.evidenceRefs.reverse();
  const second = buildDeepSeekHarnessCandidateRuntimePlan(reorderedFacts);
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first.authorization), [
    "modelInvocationAllowed",
    "processSpawnAllowed",
    "globalConfigWriteAllowed",
    "userConfigOverwriteAllowed",
    "mcpAutoStartAllowed",
    "hookClaimAllowed",
    "formalRuntimePromotionAllowed",
  ]);
  assert.ok(Object.values(first.authorization).every((value) => value === false));

  const forged = structuredClone(first);
  forged.authorization.modelInvocationAllowed = true;
  assert.throws(
    () => assertValidDeepSeekHarnessCandidateRuntimePlan(forged),
    /must be false/u,
  );
  assert.throws(
    () => buildDeepSeekHarnessCandidateRuntimePlan({
      ...COMPLETE_PROBE_FACTS,
      evidenceRefs: ["probe:duplicate", "probe:duplicate"],
    }),
    /must be unique/u,
  );
});

test("validator binds projection gates to the current probe facts", () => {
  const baseline = buildDeepSeekHarnessCandidateRuntimePlan(COMPLETE_PROBE_FACTS);
  const mutations = [
    (plan) => {
      plan.projectionPlan.capabilityGate.requiredFacts = ["version"];
    },
    (plan) => {
      plan.projectionPlan.capabilityGate.satisfied = false;
    },
    (plan) => {
      plan.projectionPlan.capabilityGate.missingFacts = ["forged:fact"];
    },
    (plan) => {
      plan.projectionPlan.blocked = true;
    },
    (plan) => {
      plan.projectionPlan.blockedReasons = ["forged:reason"];
    },
  ];

  for (const mutate of mutations) {
    const forged = structuredClone(baseline);
    mutate(forged);
    assert.throws(
      () => assertValidDeepSeekHarnessCandidateRuntimePlan(forged),
      /projection (?:capability|required|blocked)/u,
    );
  }
});

test("strict facts reject unknown fields, accessors, secrets, and raw output", () => {
  assert.throws(
    () => buildDeepSeekHarnessCandidateRuntimePlan({ ...COMPLETE_PROBE_FACTS, rawOutput: "model" }),
    TypeError,
  );
  assert.throws(
    () => buildDeepSeekHarnessCandidateRuntimePlan({
      ...COMPLETE_PROBE_FACTS,
      features: { ...COMPLETE_PROBE_FACTS.features, unknown: true },
    }),
    TypeError,
  );
  const accessorFacts = { ...COMPLETE_PROBE_FACTS };
  Object.defineProperty(accessorFacts, "version", {
    enumerable: true,
    get: () => "0.1.0-preview",
  });
  assert.throws(() => buildDeepSeekHarnessCandidateRuntimePlan(accessorFacts), TypeError);
  assert.throws(
    () => buildDeepSeekHarnessCandidateRuntimePlan({
      ...COMPLETE_PROBE_FACTS,
      version: "sk-live-012345678901234567890123456789",
    }),
    TypeError,
  );
});
