/**
 * DeepSeek Harness beta compatibility adapter.
 *
 * This module is deliberately a planning-only boundary.  It does not import
 * a Harness package, inspect the host, start ACP, invoke a model, or write
 * configuration.  A caller supplies explicit probe facts and receives a
 * frozen, non-authorizing packed structural compatibility plan.  It is not
 * live-certified and ACP remains an automation seam rather than a full UI.
 */

export const CANDIDATE_RUNTIME_ADAPTER_SCHEMA_VERSION =
  "candidate-runtime-adapter-v1";
export const DEEPSEEK_HARNESS_RUNTIME_ID = "deepseek-harness";

const RESULT_FIELDS = [
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
];

const INPUT_FIELDS = ["runtimeId", "version", "features", "evidenceRefs"];
const FEATURE_FIELDS = ["plugin", "preset", "acp"];
const ACP_FEATURE_FIELDS = [
  "automation",
  "ui",
  "configuration",
  "mcp",
  "replay",
];
const REQUIRED_PROJECTION_FACTS = [
  "version",
  "feature:plugin",
  "feature:preset",
  "feature:acp.automation",
];
const PROBE_FIELDS = [
  "source",
  "version",
  "versionKnown",
  "features",
  "missingFacts",
  "factsComplete",
  "evidenceRefs",
];
const PROBE_FEATURE_FIELDS = ["plugin", "preset", "acp"];
const PROBE_ACP_FIELDS = ACP_FEATURE_FIELDS;
const CAPABILITY_FIELDS = [
  "releaseState",
  "breakingChangeRisk",
  "plugin",
  "preset",
  "acp",
  "formalProjectionClaimed",
  "nativeRuntimeClaimed",
  "liveAcceptanceClaimed",
  "overallStatus",
];
const CAPABILITY_ACP_FIELDS = [
  "automation",
  "ui",
  "configuration",
  "mcp",
  "replay",
  "scope",
  "fullRuntimeUiClaimed",
  "nativeRuntimeClaimed",
];
const CAPABILITY_ITEM_FIELDS = ["observed", "status", "claimable"];
const PROJECTION_FIELDS = [
  "targetRuntime",
  "integrationMode",
  "formalProjection",
  "optInRequired",
  "enabledByDefault",
  "plugin",
  "preset",
  "versionGate",
  "capabilityGate",
  "acp",
  "blocked",
  "blockedReasons",
  "applyAllowed",
  "writeAllowed",
];
const PROJECTION_OPT_IN_FIELDS = ["enabled", "optInRequired"];
const PROJECTION_PRESET_FIELDS = ["id", "enabled", "optInRequired"];
const PROJECTION_VERSION_FIELDS = ["required", "version", "satisfied"];
const PROJECTION_CAPABILITY_FIELDS = [
  "requiredFacts",
  "satisfied",
  "missingFacts",
];
const PROJECTION_ACP_FIELDS = [
  "enabled",
  "mode",
  "fullRuntimeUi",
  "configuration",
  "mcp",
  "replay",
];
const INVOCATION_FIELDS = [
  "mode",
  "modelInvocationAllowed",
  "processSpawnAllowed",
  "acpAutomationAllowed",
  "acpAutomationUse",
  "nativeRuntimeClaimed",
  "liveRuntimeClaimed",
  "requiresInstalledRuntime",
  "requiresNetwork",
  "requiresCredentials",
  "consumesQuota",
];
const CONFIGURATION_FIELDS = [
  "mode",
  "globalConfigWriteAllowed",
  "userConfigOverwriteAllowed",
  "mcpAutoStartAllowed",
  "hookClaimAllowed",
  "formalRuntimePromotionAllowed",
  "pluginPresetOptInRequired",
  "generatedRuntimeProjection",
  "canonicalTemplateOnly",
];
const AUTHORIZATION_FIELDS = [
  "modelInvocationAllowed",
  "processSpawnAllowed",
  "globalConfigWriteAllowed",
  "userConfigOverwriteAllowed",
  "mcpAutoStartAllowed",
  "hookClaimAllowed",
  "formalRuntimePromotionAllowed",
];

const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,63}$/u;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@/+~?#%=-]{0,511}$/u;
const FORBIDDEN_TEXT =
  /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|bearer|credential|password|passwd|private[_-]?key|refresh[_-]?token|secret|session[_-]?id|message[_-]?id|raw[_-]?output|stdout|stderr|(?:sk|rk|pk|pat|gh[pousr]|github_pat|xox[baprs]|npm|akia|asia|aiza)[_-])/iu;
const FORBIDDEN_RESULT_KEYS = new Set([
  "rawOutput",
  "stdout",
  "stderr",
  "message",
  "messageId",
  "sessionId",
  "credential",
  "credentials",
  "apiKey",
  "accessToken",
  "refreshToken",
  "authorization",
]);

function fail(message) {
  throw new TypeError(`DeepSeek Harness candidate plan: ${message}`);
}

function ownDataEntries(value, label) {
  let prototype;
  let keys;
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail(`${label} must be a plain record`);
    }
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail(`${label} must be an inspectable plain record`);
  }
  if (prototype !== Object.prototype) fail(`${label} must be a plain record`);
  return keys.map((key) => {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail(`${label} must be inspectable`);
    }
    if (
      typeof key !== "string" ||
      descriptor?.enumerable !== true ||
      !("value" in descriptor)
    ) {
      fail(`${label} must contain enumerable string own data only`);
    }
    return [key, descriptor.value];
  });
}

function exactRecord(value, fields, label, { allowMissing = false } = {}) {
  const entries = ownDataEntries(value, label);
  const supported = new Set(fields);
  if (entries.some(([key]) => !supported.has(key))) {
    fail(`${label} contains an unsupported field`);
  }
  if (!allowMissing && entries.length !== fields.length) {
    fail(`${label} must contain exactly the supported fields`);
  }
  const map = new Map(entries);
  if (!allowMissing) {
    for (const field of fields) {
      if (!map.has(field)) fail(`${label} is incomplete`);
    }
  }
  return Object.fromEntries(
    fields.map((field) => [field, map.has(field) ? map.get(field) : undefined]),
  );
}

function denseArray(value, label, maxLength = 64) {
  let prototype;
  let keys;
  let length;
  try {
    if (!Array.isArray(value)) fail(`${label} must be a plain list`);
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
    length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  } catch {
    fail(`${label} must be inspectable`);
  }
  if (
    prototype !== Array.prototype ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > maxLength
  ) {
    fail(`${label} must be a bounded plain list`);
  }
  const values = new Map();
  for (const key of keys) {
    if (key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
      descriptor?.enumerable !== true ||
      !("value" in descriptor)
    ) {
      fail(`${label} must contain dense numeric own data only`);
    }
    values.set(key, descriptor.value);
  }
  if (values.size !== length) fail(`${label} must be dense`);
  return Array.from({ length }, (_, index) => values.get(String(index)));
}

function safeText(value, label, pattern, maxLength = 512) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    !pattern.test(value) ||
    FORBIDDEN_TEXT.test(value)
  ) {
    fail(`${label} is not a safe bounded fact`);
  }
  return value;
}

function safeNullableVersion(value, label) {
  if (value === null || value === undefined) return null;
  return safeText(value, label, SAFE_VERSION, 64);
}

function safeEvidenceRefs(value) {
  if (value === undefined) return [];
  const refs = denseArray(value, "probeFacts.evidenceRefs", 32);
  const normalized = refs.map((ref, index) =>
    safeText(ref, `probeFacts.evidenceRefs[${index}]`, SAFE_REFERENCE, 512),
  );
  if (new Set(normalized).size !== normalized.length) {
    fail("probeFacts.evidenceRefs must be unique");
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}

function triState(value, label) {
  if (value === undefined || value === null || value === "unknown") return null;
  if (typeof value !== "boolean") fail(`${label} must be boolean or unknown`);
  return value;
}

function normalizeFeatures(value) {
  if (value === undefined || value === null) {
    return {
      plugin: null,
      preset: null,
      acp: Object.fromEntries(ACP_FEATURE_FIELDS.map((field) => [field, null])),
    };
  }
  const featureRecord = exactRecord(value, FEATURE_FIELDS, "probeFacts.features", {
    allowMissing: true,
  });
  const acp =
    featureRecord.acp === undefined || featureRecord.acp === null
      ? Object.fromEntries(ACP_FEATURE_FIELDS.map((field) => [field, null]))
      : exactRecord(featureRecord.acp, ACP_FEATURE_FIELDS, "probeFacts.features.acp", {
          allowMissing: true,
        });
  return {
    plugin: triState(featureRecord.plugin, "probeFacts.features.plugin"),
    preset: triState(featureRecord.preset, "probeFacts.features.preset"),
    acp: Object.fromEntries(
      ACP_FEATURE_FIELDS.map((field) => [
        field,
        triState(acp[field], `probeFacts.features.acp.${field}`),
      ]),
    ),
  };
}

function normalizeProbeFacts(value) {
  const input = exactRecord(value, INPUT_FIELDS, "probeFacts", {
    allowMissing: true,
  });
  if (
    input.runtimeId !== undefined &&
    input.runtimeId !== DEEPSEEK_HARNESS_RUNTIME_ID
  ) {
    fail("probeFacts.runtimeId must identify DeepSeek Harness");
  }
  const version = safeNullableVersion(input.version, "probeFacts.version");
  const features = normalizeFeatures(input.features);
  const evidenceRefs = safeEvidenceRefs(input.evidenceRefs);
  return { version, features, evidenceRefs };
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function featureStatus(value) {
  return value === null ? "unknown" : value ? "observed" : "observed_absent";
}

function capabilityItem(value) {
  return {
    observed: value,
    status: featureStatus(value),
    claimable: false,
  };
}

function missingFacts({ version, features }) {
  const missing = [];
  if (version === null) missing.push("version");
  if (features.plugin === null) missing.push("feature:plugin");
  if (features.preset === null) missing.push("feature:preset");
  for (const field of ACP_FEATURE_FIELDS) {
    if (features.acp[field] === null) missing.push(`feature:acp.${field}`);
  }
  return missing;
}

function buildCapabilityAssessment(features, factsMissing) {
  const acp = Object.fromEntries(
    ACP_FEATURE_FIELDS.map((field) => [field, capabilityItem(features.acp[field])]),
  );
  return {
    releaseState: "developer_preview_breaking_changes_possible",
    breakingChangeRisk: "developer_preview",
    plugin: capabilityItem(features.plugin),
    preset: capabilityItem(features.preset),
    acp: {
      ...acp,
      scope: "automation_transport_only_not_full_runtime_ui",
      fullRuntimeUiClaimed: false,
      nativeRuntimeClaimed: false,
    },
    formalProjectionClaimed: false,
    nativeRuntimeClaimed: false,
    liveAcceptanceClaimed: false,
    overallStatus:
      factsMissing.length === 0
        ? "structural_candidate_facts_complete"
        : "blocked_missing_or_incomplete_probe_facts",
  };
}

function buildProjectionPlan(version, features, factsMissing) {
  const requiredFacts = [...REQUIRED_PROJECTION_FACTS];
  const requiredFactsSatisfied =
    version !== null &&
    features.plugin === true &&
    features.preset === true &&
    features.acp.automation === true;
  const blockedReasons = [...factsMissing];
  if (features.plugin === false) blockedReasons.push("plugin_not_observed_supported");
  if (features.preset === false) blockedReasons.push("preset_not_observed_supported");
  if (features.acp.automation === false) {
    blockedReasons.push("acp_automation_seam_not_observed_supported");
  }
  const uniqueBlockedReasons = [...new Set(blockedReasons)];
  return {
    targetRuntime: DEEPSEEK_HARNESS_RUNTIME_ID,
    integrationMode: "opt_in_plugin_preset",
    formalProjection: false,
    optInRequired: true,
    enabledByDefault: false,
    plugin: { enabled: false, optInRequired: true },
    preset: {
      id: "meta-kim-deepseek-harness-candidate",
      enabled: false,
      optInRequired: true,
    },
    versionGate: {
      required: true,
      version,
      satisfied: version !== null,
    },
    capabilityGate: {
      requiredFacts,
      satisfied: requiredFactsSatisfied,
      missingFacts: uniqueBlockedReasons,
    },
    acp: {
      enabled: false,
      mode: "automation_transport_only",
      fullRuntimeUi: false,
      configuration: false,
      mcp: false,
      replay: false,
    },
    blocked: !requiredFactsSatisfied,
    blockedReasons: uniqueBlockedReasons,
    applyAllowed: false,
    writeAllowed: false,
  };
}

function expectedProjectionGate(probe) {
  const requiredFacts = [...REQUIRED_PROJECTION_FACTS];
  const satisfied =
    probe.version !== null &&
    probe.features.plugin === true &&
    probe.features.preset === true &&
    probe.features.acp.automation === true;
  const reasons = [...probe.missingFacts];
  if (probe.features.plugin === false) reasons.push("plugin_not_observed_supported");
  if (probe.features.preset === false) reasons.push("preset_not_observed_supported");
  if (probe.features.acp.automation === false) {
    reasons.push("acp_automation_seam_not_observed_supported");
  }
  return {
    requiredFacts,
    satisfied,
    missingFacts: [...new Set(reasons)],
  };
}

function buildInvocationPolicy() {
  return {
    mode: "structural_plan_only",
    modelInvocationAllowed: false,
    processSpawnAllowed: false,
    acpAutomationAllowed: false,
    acpAutomationUse: "structural_seam_only",
    nativeRuntimeClaimed: false,
    liveRuntimeClaimed: false,
    requiresInstalledRuntime: false,
    requiresNetwork: false,
    requiresCredentials: false,
    consumesQuota: false,
  };
}

function buildConfigurationPolicy() {
  return {
    mode: "preserve_user_configuration",
    globalConfigWriteAllowed: false,
    userConfigOverwriteAllowed: false,
    mcpAutoStartAllowed: false,
    hookClaimAllowed: false,
    formalRuntimePromotionAllowed: false,
    pluginPresetOptInRequired: true,
    generatedRuntimeProjection: false,
    canonicalTemplateOnly: true,
  };
}

function buildAuthorization() {
  return Object.fromEntries(AUTHORIZATION_FIELDS.map((field) => [field, false]));
}

function assertNoForbiddenData(value, seen = new Set()) {
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && FORBIDDEN_TEXT.test(value)) {
      fail("result contains forbidden secret-like text");
    }
    return;
  }
  if (seen.has(value)) fail("result must not contain cycles");
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_RESULT_KEYS.has(key)) {
      // authorization is the one intentional exception; its values are
      // checked separately and never contain a secret payload.
      if (key !== "authorization") fail("result contains forbidden raw data");
    }
    assertNoForbiddenData(child, seen);
  }
  seen.delete(value);
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") fail(`${label} must be boolean`);
  return value;
}

function assertNullableBoolean(value, label) {
  if (value !== null) assertBoolean(value, label);
  return value;
}

function assertFeatureProjection(value, label) {
  const item = exactRecord(value, CAPABILITY_ITEM_FIELDS, label);
  assertNullableBoolean(item.observed, `${label}.observed`);
  if (item.status !== featureStatus(item.observed)) fail(`${label}.status is inconsistent`);
  if (item.claimable !== false) fail(`${label}.claimable must be false`);
}

function assertValidProbe(value) {
  const probe = exactRecord(value, PROBE_FIELDS, "result.probe");
  if (probe.source !== "explicit_probe_facts") fail("result.probe.source is invalid");
  const version = safeNullableVersion(probe.version, "result.probe.version");
  if (probe.versionKnown !== (version !== null)) fail("result.probe.versionKnown is inconsistent");
  const features = exactRecord(probe.features, PROBE_FEATURE_FIELDS, "result.probe.features");
  const acp = exactRecord(features.acp, PROBE_ACP_FIELDS, "result.probe.features.acp");
  assertNullableBoolean(features.plugin, "result.probe.features.plugin");
  assertNullableBoolean(features.preset, "result.probe.features.preset");
  for (const field of ACP_FEATURE_FIELDS) {
    assertNullableBoolean(acp[field], `result.probe.features.acp.${field}`);
  }
  const missing = denseArray(probe.missingFacts, "result.probe.missingFacts");
  for (const reason of missing) safeText(reason, "result.probe.missingFacts[]", SAFE_REFERENCE, 128);
  if (new Set(missing).size !== missing.length) fail("result.probe.missingFacts must be unique");
  const expectedMissing = missingFacts({ version, features });
  if (JSON.stringify(missing) !== JSON.stringify(expectedMissing)) {
    fail("result.probe.missingFacts are inconsistent");
  }
  if (probe.factsComplete !== (missing.length === 0)) fail("result.probe.factsComplete is inconsistent");
  const refs = safeEvidenceRefs(probe.evidenceRefs);
  if (JSON.stringify(refs) !== JSON.stringify(probe.evidenceRefs)) fail("result.probe.evidenceRefs are invalid");
  return { version, features, missingFacts: missing };
}

function assertValidCapabilityAssessment(value, probe) {
  const assessment = exactRecord(value, CAPABILITY_FIELDS, "result.capabilityAssessment");
  if (assessment.releaseState !== "developer_preview_breaking_changes_possible") fail("release state is invalid");
  if (assessment.breakingChangeRisk !== "developer_preview") fail("breaking-change risk is invalid");
  assertFeatureProjection(assessment.plugin, "result.capabilityAssessment.plugin");
  assertFeatureProjection(assessment.preset, "result.capabilityAssessment.preset");
  if (assessment.plugin.observed !== probe.features.plugin || assessment.preset.observed !== probe.features.preset) {
    fail("plugin/preset assessment is not bound to probe facts");
  }
  const acp = exactRecord(assessment.acp, CAPABILITY_ACP_FIELDS, "result.capabilityAssessment.acp");
  for (const field of ACP_FEATURE_FIELDS) {
    assertFeatureProjection(acp[field], `result.capabilityAssessment.acp.${field}`);
    if (acp[field].observed !== probe.features.acp[field]) fail(`ACP ${field} assessment is not bound to probe facts`);
  }
  if (acp.scope !== "automation_transport_only_not_full_runtime_ui") fail("ACP scope is invalid");
  if (acp.fullRuntimeUiClaimed !== false || acp.nativeRuntimeClaimed !== false) fail("ACP native/UI claim is invalid");
  if (assessment.formalProjectionClaimed !== false || assessment.nativeRuntimeClaimed !== false || assessment.liveAcceptanceClaimed !== false) {
    fail("capability assessment contains a live or formal claim");
  }
  const expectedStatus = probe.version !== null && Object.values(probe.features.acp).every((entry) => entry !== null) &&
    probe.features.plugin !== null && probe.features.preset !== null
    ? "structural_candidate_facts_complete"
    : "blocked_missing_or_incomplete_probe_facts";
  if (assessment.overallStatus !== expectedStatus) fail("capability assessment status is inconsistent");
}

function assertValidProjectionPlan(value, probe) {
  const projection = exactRecord(value, PROJECTION_FIELDS, "result.projectionPlan");
  if (projection.targetRuntime !== DEEPSEEK_HARNESS_RUNTIME_ID) fail("projection target is invalid");
  if (projection.integrationMode !== "opt_in_plugin_preset") fail("projection mode is invalid");
  if (projection.formalProjection !== false || projection.optInRequired !== true || projection.enabledByDefault !== false) {
    fail("projection opt-in or formal state is invalid");
  }
  const plugin = exactRecord(projection.plugin, PROJECTION_OPT_IN_FIELDS, "result.projectionPlan.plugin");
  const preset = exactRecord(projection.preset, PROJECTION_PRESET_FIELDS, "result.projectionPlan.preset");
  if (plugin.enabled !== false || plugin.optInRequired !== true || preset.enabled !== false || preset.optInRequired !== true) {
    fail("projection plugin/preset must remain opt-in");
  }
  safeText(preset.id, "result.projectionPlan.preset.id", SAFE_REFERENCE, 128);
  const versionGate = exactRecord(projection.versionGate, PROJECTION_VERSION_FIELDS, "result.projectionPlan.versionGate");
  if (versionGate.required !== true || versionGate.satisfied !== (probe.version !== null)) fail("version gate is invalid");
  if (versionGate.version !== probe.version) fail("version gate does not bind to probe facts");
  const capabilityGate = exactRecord(projection.capabilityGate, PROJECTION_CAPABILITY_FIELDS, "result.projectionPlan.capabilityGate");
  const requiredFacts = denseArray(capabilityGate.requiredFacts, "result.projectionPlan.capabilityGate.requiredFacts");
  const missingFacts = denseArray(capabilityGate.missingFacts, "result.projectionPlan.capabilityGate.missingFacts");
  for (const fact of [...requiredFacts, ...missingFacts]) safeText(fact, "result.projectionPlan.capabilityGate.fact", SAFE_REFERENCE, 128);
  const expectedGate = expectedProjectionGate(probe);
  if (JSON.stringify(requiredFacts) !== JSON.stringify(expectedGate.requiredFacts)) {
    fail("projection capability required facts are not canonical");
  }
  if (capabilityGate.satisfied !== expectedGate.satisfied) {
    fail("projection capability satisfaction is not bound to probe facts");
  }
  if (JSON.stringify(missingFacts) !== JSON.stringify(expectedGate.missingFacts)) {
    fail("projection capability missing facts are not bound to probe facts");
  }
  if (projection.blocked !== !expectedGate.satisfied) {
    fail("projection blocked state is not bound to capability satisfaction");
  }
  const acp = exactRecord(projection.acp, PROJECTION_ACP_FIELDS, "result.projectionPlan.acp");
  if (acp.enabled !== false || acp.mode !== "automation_transport_only" || acp.fullRuntimeUi !== false || acp.configuration !== false || acp.mcp !== false || acp.replay !== false) {
    fail("ACP projection must stay structural and disabled");
  }
  assertBoolean(projection.blocked, "result.projectionPlan.blocked");
  const blockedReasons = denseArray(projection.blockedReasons, "result.projectionPlan.blockedReasons");
  if (JSON.stringify(blockedReasons) !== JSON.stringify(expectedGate.missingFacts)) {
    fail("projection blocked reasons are not canonical");
  }
  if (projection.applyAllowed !== false || projection.writeAllowed !== false) fail("projection writes are not allowed");
}

function assertValidInvocationPolicy(value) {
  const policy = exactRecord(value, INVOCATION_FIELDS, "result.invocationPolicy");
  if (policy.mode !== "structural_plan_only" || policy.acpAutomationUse !== "structural_seam_only") fail("invocation mode is invalid");
  for (const field of [
    "modelInvocationAllowed",
    "processSpawnAllowed",
    "acpAutomationAllowed",
    "nativeRuntimeClaimed",
    "liveRuntimeClaimed",
    "requiresInstalledRuntime",
    "requiresNetwork",
    "requiresCredentials",
    "consumesQuota",
  ]) {
    if (policy[field] !== false) fail(`invocation policy ${field} must be false`);
  }
}

function assertValidConfigurationPolicy(value) {
  const policy = exactRecord(value, CONFIGURATION_FIELDS, "result.configurationPolicy");
  if (policy.mode !== "preserve_user_configuration") fail("configuration policy mode is invalid");
  for (const field of [
    "globalConfigWriteAllowed",
    "userConfigOverwriteAllowed",
    "mcpAutoStartAllowed",
    "hookClaimAllowed",
    "formalRuntimePromotionAllowed",
    "generatedRuntimeProjection",
  ]) {
    if (policy[field] !== false) fail(`configuration policy ${field} must be false`);
  }
  if (policy.pluginPresetOptInRequired !== true || policy.canonicalTemplateOnly !== true) fail("configuration policy boundary is invalid");
}

export function buildDeepSeekHarnessCandidateRuntimePlan(probeFacts) {
  const normalized = normalizeProbeFacts(probeFacts);
  const missing = missingFacts(normalized);
  const probe = {
    source: "explicit_probe_facts",
    version: normalized.version,
    versionKnown: normalized.version !== null,
    features: normalized.features,
    missingFacts: missing,
    factsComplete: missing.length === 0,
    evidenceRefs: normalized.evidenceRefs,
  };
  return deepFreeze({
    schemaVersion: CANDIDATE_RUNTIME_ADAPTER_SCHEMA_VERSION,
    runtimeId: DEEPSEEK_HARNESS_RUNTIME_ID,
     tier: "beta_compatibility",
    formalProjection: false,
    probe,
    capabilityAssessment: buildCapabilityAssessment(normalized.features, missing),
    projectionPlan: buildProjectionPlan(normalized.version, normalized.features, missing),
    invocationPolicy: buildInvocationPolicy(),
    configurationPolicy: buildConfigurationPolicy(),
    authorization: buildAuthorization(),
  });
}

export function assertValidDeepSeekHarnessCandidateRuntimePlan(result) {
  const plan = exactRecord(result, RESULT_FIELDS, "result");
  if (plan.schemaVersion !== CANDIDATE_RUNTIME_ADAPTER_SCHEMA_VERSION) fail("schema version is invalid");
  if (plan.runtimeId !== DEEPSEEK_HARNESS_RUNTIME_ID || plan.tier !== "beta_compatibility") fail("candidate identity is invalid");
  if (plan.formalProjection !== false) fail("candidate plan cannot claim formal projection");
  const normalizedProbe = assertValidProbe(plan.probe);
  assertValidCapabilityAssessment(plan.capabilityAssessment, normalizedProbe);
  assertValidProjectionPlan(plan.projectionPlan, normalizedProbe);
  assertValidInvocationPolicy(plan.invocationPolicy);
  assertValidConfigurationPolicy(plan.configurationPolicy);
  const authorization = exactRecord(plan.authorization, AUTHORIZATION_FIELDS, "result.authorization");
  for (const field of AUTHORIZATION_FIELDS) {
    if (authorization[field] !== false) fail(`authorization ${field} must be false`);
  }
  assertNoForbiddenData(result);
  return result;
}
