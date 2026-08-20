/**
 * ZCode beta compatibility is intentionally a packed structural planning surface.
 *
 * This module is data-only.  It must not discover a local ZCode installation,
 * invoke a command, read or write a configuration file, start an MCP server,
 * or spend model/API quota.  A caller has to supply an explicit, already
 * observed probe fact record.  The adapter only turns those facts into a
 * conservative plan that can be reviewed before any future promotion work.
 */

export const CANDIDATE_RUNTIME_ADAPTER_SCHEMA_VERSION = "candidate-runtime-adapter-v1";

const RUNTIME_ID = "zcode";
const TIER = "beta_compatibility";
const HEADLESS_PLAN_MODE = "plan";
const FORBIDDEN_HEADLESS_MODES = Object.freeze(["build", "edit", "yolo"]);

const AUTHORIZATION_FIELDS = Object.freeze([
  "modelInvocationAllowed",
  "processSpawnAllowed",
  "globalConfigWriteAllowed",
  "userConfigOverwriteAllowed",
  "mcpAutoStartAllowed",
  "hookClaimAllowed",
  "formalRuntimePromotionAllowed",
]);

const RESULT_FIELDS = Object.freeze([
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

const CAPABILITY_NAMES = Object.freeze(["headless", "hooks", "mcp"]);
const STATUS_VALUES = Object.freeze([
  "verified",
  "unverified",
  "unknown",
  "unsupported",
  "not_observed",
]);
const CONFIG_AUTHORITY_VALUES = Object.freeze([
  "user_owned",
  "unknown",
  "not_observed",
]);

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+\-/]{0,255}$/u;
const SECRET_KEY = /(?:secret|password|passwd|credential|token|api[_-]?key|private[_-]?key|bearer|raw[_-]?(?:prompt|output|model)|stdout|stderr)/iu;
const SECRET_VALUE = /(?:^|[\s:._/\\-])(?:sk|rk|pk|ak|gh[pousr]|github_pat|xox[baprs]|ya29)[_-][A-Za-z0-9_-]{8,}/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function fail(message) {
  throw new TypeError(`ZCode candidate runtime adapter: ${message}`);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataEntries(value, label) {
  if (!isPlainRecord(value)) fail(`${label} must be a plain record`);
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail(`${label} must be inspectable`);
  }
  return keys.map((key) => {
    if (typeof key !== "string") fail(`${label} cannot contain symbol keys`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      fail(`${label} must contain enumerable own data properties only`);
    }
    if (SECRET_KEY.test(key)) fail(`${label}.${key} is sensitive material`);
    return [key, descriptor.value];
  });
}

function exactRecord(value, fields, label) {
  const entries = ownDataEntries(value, label);
  const allowed = new Set(fields);
  if (entries.length !== fields.length || entries.some(([key]) => !allowed.has(key))) {
    fail(`${label} must contain exactly: ${fields.join(", ")}`);
  }
  const map = new Map(entries);
  if (fields.some((field) => !map.has(field))) fail(`${label} is incomplete`);
  return Object.fromEntries(fields.map((field) => [field, map.get(field)]));
}

function denseArray(value, label, { max = 64, min = 0 } = {}) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(`${label} must be a plain array`);
  }
  if (value.length < min || value.length > max) fail(`${label} has an invalid length`);
  const keys = Reflect.ownKeys(value);
  const values = [];
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
      fail(`${label} must be dense and contain numeric own data only`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      fail(`${label} must contain data properties only`);
    }
    values[Number(key)] = descriptor.value;
  }
  if (values.length !== value.length || values.some((_, index) => !Object.hasOwn(value, String(index)))) fail(`${label} must be dense`);
  return values;
}

function text(value, label, { max = 512 } = {}) {
  if (typeof value !== "string") fail(`${label} must be a string`);
  const normalized = value.normalize("NFKC");
  if (normalized.length < 1 || normalized.length > max || CONTROL_CHARACTER.test(normalized)) {
    fail(`${label} must be bounded text`);
  }
  if (SECRET_VALUE.test(normalized)) fail(`${label} contains sensitive material`);
  return normalized;
}

function identifier(value, label) {
  const normalized = text(value, label, { max: 256 });
  if (!SAFE_IDENTIFIER.test(normalized)) fail(`${label} must be a safe identifier`);
  return normalized;
}

function status(value, label) {
  if (typeof value !== "string" || !STATUS_VALUES.includes(value)) {
    fail(`${label} must be one of ${STATUS_VALUES.join(", ")}`);
  }
  return value;
}

function configAuthority(value, label) {
  if (typeof value !== "string" || !CONFIG_AUTHORITY_VALUES.includes(value)) {
    fail(`${label} must be one of ${CONFIG_AUTHORITY_VALUES.join(", ")}`);
  }
  return value;
}

function boolean(value, label) {
  if (typeof value !== "boolean") fail(`${label} must be boolean`);
  return value;
}

function uniqueSortedStrings(value, label, options = {}) {
  const values = denseArray(value, label, options).map((item, index) => text(item, `${label}[${index}]`, { max: 256 }));
  if (new Set(values).size !== values.length) fail(`${label} must not contain duplicates`);
  return [...values].sort((left, right) => left.localeCompare(right));
}

function normalizeStatusFact(value, label) {
  if (!isPlainRecord(value)) fail(`${label} must be a plain record`);
  const entries = ownDataEntries(value, label);
  const allowed = new Set(["status", "verified", "observed", "supported", "observedModes", "modes", "configAuthority", "evidenceRefs"]);
  if (entries.some(([key]) => !allowed.has(key))) fail(`${label} contains an unsupported field`);
  const raw = Object.fromEntries(entries);
  const hasStatus = Object.hasOwn(raw, "status");
  const hasVerified = Object.hasOwn(raw, "verified");
  const hasObserved = Object.hasOwn(raw, "observed");
  if (!hasStatus && !hasVerified && !hasObserved) fail(`${label} must state an explicit observed status`);
  if (hasStatus && (hasVerified || hasObserved)) fail(`${label} must use status or boolean observation, not both`);

  let normalizedStatus;
  if (hasStatus) {
    normalizedStatus = status(raw.status, `${label}.status`);
  } else {
    const fact = hasVerified ? boolean(raw.verified, `${label}.verified`) : boolean(raw.observed, `${label}.observed`);
    normalizedStatus = fact ? "verified" : "unverified";
  }

  if (Object.hasOwn(raw, "supported")) {
    const supported = boolean(raw.supported, `${label}.supported`);
    if (supported && normalizedStatus !== "verified") {
      fail(`${label}.supported cannot claim support without verified evidence`);
    }
  }

  const modesValue = raw.observedModes ?? raw.modes ?? [];
  const observedModes = uniqueSortedStrings(modesValue, `${label}.observedModes`);
  const evidenceRefs = Object.hasOwn(raw, "evidenceRefs")
    ? uniqueSortedStrings(raw.evidenceRefs, `${label}.evidenceRefs`)
    : [];
  const result = { status: normalizedStatus, observedModes, evidenceRefs };
  if (Object.hasOwn(raw, "configAuthority")) {
    result.configAuthority = configAuthority(raw.configAuthority, `${label}.configAuthority`);
  }
  return result;
}

function normalizeProbeFacts(probeFacts) {
  if (!isPlainRecord(probeFacts)) fail("probeFacts must be a plain record");
  const entries = ownDataEntries(probeFacts, "probeFacts");
  const allowed = new Set([
    "runtimeId",
    "probeId",
    "evidenceRefs",
    "capabilities",
    "headless",
    "hooks",
    "mcp",
    "source",
  ]);
  if (entries.some(([key]) => !allowed.has(key))) fail("probeFacts contains an unsupported field");
  const raw = Object.fromEntries(entries);
  if (raw.runtimeId !== RUNTIME_ID) fail("probeFacts.runtimeId must be zcode");
  const probeId = identifier(raw.probeId, "probeFacts.probeId");
  const evidenceRefs = uniqueSortedStrings(raw.evidenceRefs, "probeFacts.evidenceRefs", { min: 1 });
  const hasNested = Object.hasOwn(raw, "capabilities");
  const hasFlat = ["headless", "hooks", "mcp"].some((key) => Object.hasOwn(raw, key));
  if (hasNested === hasFlat) fail("probeFacts must provide either capabilities or flat capability facts");

  let capabilities;
  if (hasNested) {
    const nested = exactRecord(raw.capabilities, CAPABILITY_NAMES, "probeFacts.capabilities");
    capabilities = Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, normalizeStatusFact(nested[name], `probeFacts.capabilities.${name}`)]));
  } else {
    if (!["headless", "hooks", "mcp"].every((key) => Object.hasOwn(raw, key))) {
      fail("flat probeFacts must contain headless, hooks, and mcp facts");
    }
    capabilities = Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, normalizeStatusFact(raw[name], `probeFacts.${name}`)]));
  }

  const source = Object.hasOwn(raw, "source") ? identifier(raw.source, "probeFacts.source") : "explicit_probe_facts";
  return {
    runtimeId: RUNTIME_ID,
    probeId,
    source,
    evidenceRefs,
    capabilities,
  };
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function authorization() {
  return Object.fromEntries(AUTHORIZATION_FIELDS.map((field) => [field, false]));
}

function buildPlanFromFacts(facts) {
  const headlessFact = facts.capabilities.headless;
  const hooksFact = facts.capabilities.hooks;
  const mcpFact = facts.capabilities.mcp;
  const headlessVerified = headlessFact.status === "verified";
  const mcpVerified = mcpFact.status === "verified";
  const anyUnverified = CAPABILITY_NAMES.some((name) => facts.capabilities[name].status !== "verified");

  const result = {
    schemaVersion: CANDIDATE_RUNTIME_ADAPTER_SCHEMA_VERSION,
    runtimeId: RUNTIME_ID,
    tier: TIER,
    formalProjection: false,
    probe: {
      runtimeId: RUNTIME_ID,
      probeId: facts.probeId,
      source: facts.source,
      evidenceRefs: facts.evidenceRefs,
      capabilities: facts.capabilities,
    },
    capabilityAssessment: {
       status: anyUnverified ? "fail_closed" : "bounded_beta_facts",
      headless: {
        status: headlessFact.status,
        observedModes: headlessFact.observedModes,
        planModeOnly: true,
        observedHeadlessSurface: headlessVerified,
      },
      hooks: {
        status: hooksFact.status,
        claim: "not_claimed",
        supported: false,
      },
      mcp: {
        status: mcpFact.status,
        mergePlan: "preserve_user_merge_plan_only",
        userConfigOwnership: mcpFact.configAuthority ?? "unknown",
        observedMcpSurface: mcpVerified,
      },
    },
    projectionPlan: {
       status: "beta_compatibility_only",
      formalProjection: false,
      syncEligible: false,
      installEligible: false,
       canonicalTemplate: "opt_in_beta_structural_adapter_only",
      managedPaths: [],
      promotionRequires: [
         "packed_structural_adapter_verification",
         "official_path_and_config_contract",
        "merge_safe_install_update_uninstall_policy",
        "separate_live_acceptance",
      ],
    },
    invocationPolicy: {
      mode: "plan_only",
      modelInvocation: "forbidden",
      processSpawn: "forbidden",
      headlessMode: HEADLESS_PLAN_MODE,
      headlessCommand: ["zcode", "--mode", HEADLESS_PLAN_MODE],
      forbiddenHeadlessModes: FORBIDDEN_HEADLESS_MODES,
      yolo: false,
      hooks: "not_claimed",
      mcpAutoStart: false,
    },
    configurationPolicy: {
      mode: "preserve_user_merge_plan_only",
      readExistingConfig: false,
      writeConfig: false,
      overwriteWholeFile: false,
      mcp: {
        action: "preserve_user_entries_and_add_only_missing_candidate_entries",
        replacement: false,
        autoStart: false,
      },
    },
    authorization: authorization(),
  };
  return result;
}

function assertBooleanField(value, label) {
  if (typeof value !== "boolean") fail(`${label} must be boolean`);
}

function assertExactString(value, expected, label) {
  if (value !== expected) fail(`${label} must be ${expected}`);
}

function assertStringArray(value, expected, label) {
  const actual = uniqueSortedStrings(value, label);
  const normalizedExpected = [...expected].sort((left, right) => left.localeCompare(right));
  if (actual.length !== normalizedExpected.length || actual.some((item, index) => item !== normalizedExpected[index])) {
    fail(`${label} is not canonical`);
  }
}

/**
 * Validate a candidate plan without granting any permission.  The validator
 * accepts a cloned plan for review/tests, but never repairs or mutates it.
 */
export function assertValidZCodeCandidateRuntimePlan(result) {
  const current = exactRecord(result, RESULT_FIELDS, "result");
  assertExactString(current.schemaVersion, CANDIDATE_RUNTIME_ADAPTER_SCHEMA_VERSION, "result.schemaVersion");
  assertExactString(current.runtimeId, RUNTIME_ID, "result.runtimeId");
  assertExactString(current.tier, TIER, "result.tier");
  assertBooleanField(current.formalProjection, "result.formalProjection");
  if (current.formalProjection !== false) fail("result.formalProjection must be false");

  const probe = exactRecord(current.probe, ["runtimeId", "probeId", "source", "evidenceRefs", "capabilities"], "result.probe");
  assertExactString(probe.runtimeId, RUNTIME_ID, "result.probe.runtimeId");
  identifier(probe.probeId, "result.probe.probeId");
  identifier(probe.source, "result.probe.source");
  uniqueSortedStrings(probe.evidenceRefs, "result.probe.evidenceRefs", { min: 1 });
  const capabilityRecords = exactRecord(probe.capabilities, CAPABILITY_NAMES, "result.probe.capabilities");
  for (const name of CAPABILITY_NAMES) normalizeStatusFact(capabilityRecords[name], `result.probe.capabilities.${name}`);

  const assessment = exactRecord(current.capabilityAssessment, ["status", "headless", "hooks", "mcp"], "result.capabilityAssessment");
   if (!["fail_closed", "bounded_beta_facts"].includes(assessment.status)) fail("result.capabilityAssessment.status is invalid");
  const expectedAssessmentStatus = CAPABILITY_NAMES.some((name) => capabilityRecords[name].status !== "verified")
    ? "fail_closed"
     : "bounded_beta_facts";
  if (assessment.status !== expectedAssessmentStatus) fail("result.capabilityAssessment.status is not bound to probe facts");
  const headlessAssessment = exactRecord(assessment.headless, ["status", "observedModes", "planModeOnly", "observedHeadlessSurface"], "result.capabilityAssessment.headless");
  status(headlessAssessment.status, "result.capabilityAssessment.headless.status");
  if (headlessAssessment.status !== capabilityRecords.headless.status) fail("headless assessment status is not bound to probe facts");
  assertStringArray(headlessAssessment.observedModes, capabilityRecords.headless.observedModes, "result.capabilityAssessment.headless.observedModes");
  assertBooleanField(headlessAssessment.planModeOnly, "result.capabilityAssessment.headless.planModeOnly");
  assertBooleanField(headlessAssessment.observedHeadlessSurface, "result.capabilityAssessment.headless.observedHeadlessSurface");
  if (headlessAssessment.planModeOnly !== true || headlessAssessment.observedHeadlessSurface !== (headlessAssessment.status === "verified")) fail("headless assessment is not fail-closed");
  const hookAssessment = exactRecord(assessment.hooks, ["status", "claim", "supported"], "result.capabilityAssessment.hooks");
  status(hookAssessment.status, "result.capabilityAssessment.hooks.status");
  if (hookAssessment.status !== capabilityRecords.hooks.status) fail("hook assessment status is not bound to probe facts");
  assertExactString(hookAssessment.claim, "not_claimed", "result.capabilityAssessment.hooks.claim");
  assertBooleanField(hookAssessment.supported, "result.capabilityAssessment.hooks.supported");
  if (hookAssessment.supported !== false) fail("hook support must not be claimed");
  const mcpAssessment = exactRecord(assessment.mcp, ["status", "mergePlan", "userConfigOwnership", "observedMcpSurface"], "result.capabilityAssessment.mcp");
  status(mcpAssessment.status, "result.capabilityAssessment.mcp.status");
  if (mcpAssessment.status !== capabilityRecords.mcp.status) fail("MCP assessment status is not bound to probe facts");
  assertExactString(mcpAssessment.mergePlan, "preserve_user_merge_plan_only", "result.capabilityAssessment.mcp.mergePlan");
  configAuthority(mcpAssessment.userConfigOwnership, "result.capabilityAssessment.mcp.userConfigOwnership");
  if (mcpAssessment.userConfigOwnership !== (capabilityRecords.mcp.configAuthority ?? "unknown")) fail("MCP config ownership is not bound to probe facts");
  assertBooleanField(mcpAssessment.observedMcpSurface, "result.capabilityAssessment.mcp.observedMcpSurface");
  if (mcpAssessment.observedMcpSurface !== (mcpAssessment.status === "verified")) fail("MCP assessment is not fail-closed");

  const projection = exactRecord(current.projectionPlan, ["status", "formalProjection", "syncEligible", "installEligible", "canonicalTemplate", "managedPaths", "promotionRequires"], "result.projectionPlan");
   assertExactString(projection.status, "beta_compatibility_only", "result.projectionPlan.status");
  for (const field of ["formalProjection", "syncEligible", "installEligible"]) {
    assertBooleanField(projection[field], `result.projectionPlan.${field}`);
    if (projection[field] !== false) fail(`result.projectionPlan.${field} must be false`);
  }
   assertExactString(projection.canonicalTemplate, "opt_in_beta_structural_adapter_only", "result.projectionPlan.canonicalTemplate");
  assertStringArray(projection.managedPaths, [], "result.projectionPlan.managedPaths");
  assertStringArray(projection.promotionRequires, [
     "packed_structural_adapter_verification",
     "official_path_and_config_contract",
    "merge_safe_install_update_uninstall_policy",
    "separate_live_acceptance",
  ], "result.projectionPlan.promotionRequires");

  const invocation = exactRecord(current.invocationPolicy, ["mode", "modelInvocation", "processSpawn", "headlessMode", "headlessCommand", "forbiddenHeadlessModes", "yolo", "hooks", "mcpAutoStart"], "result.invocationPolicy");
  assertExactString(invocation.mode, "plan_only", "result.invocationPolicy.mode");
  assertExactString(invocation.modelInvocation, "forbidden", "result.invocationPolicy.modelInvocation");
  assertExactString(invocation.processSpawn, "forbidden", "result.invocationPolicy.processSpawn");
  assertExactString(invocation.headlessMode, HEADLESS_PLAN_MODE, "result.invocationPolicy.headlessMode");
  assertStringArray(invocation.headlessCommand, ["zcode", "--mode", HEADLESS_PLAN_MODE], "result.invocationPolicy.headlessCommand");
  // Command order is semantically important even though other string lists
  // are canonicalized for deterministic validation.
  if (JSON.stringify(invocation.headlessCommand) !== JSON.stringify(["zcode", "--mode", HEADLESS_PLAN_MODE])) fail("headless command must force --mode plan");
  assertStringArray(invocation.forbiddenHeadlessModes, FORBIDDEN_HEADLESS_MODES, "result.invocationPolicy.forbiddenHeadlessModes");
  assertBooleanField(invocation.yolo, "result.invocationPolicy.yolo");
  if (invocation.yolo !== false) fail("yolo must be false");
  assertExactString(invocation.hooks, "not_claimed", "result.invocationPolicy.hooks");
  assertBooleanField(invocation.mcpAutoStart, "result.invocationPolicy.mcpAutoStart");
  if (invocation.mcpAutoStart !== false) fail("MCP auto-start must be false");

  const configuration = exactRecord(current.configurationPolicy, ["mode", "readExistingConfig", "writeConfig", "overwriteWholeFile", "mcp"], "result.configurationPolicy");
  assertExactString(configuration.mode, "preserve_user_merge_plan_only", "result.configurationPolicy.mode");
  for (const field of ["readExistingConfig", "writeConfig", "overwriteWholeFile"]) {
    assertBooleanField(configuration[field], `result.configurationPolicy.${field}`);
    if (configuration[field] !== false) fail(`result.configurationPolicy.${field} must be false`);
  }
  const mcpConfiguration = exactRecord(configuration.mcp, ["action", "replacement", "autoStart"], "result.configurationPolicy.mcp");
  assertExactString(mcpConfiguration.action, "preserve_user_entries_and_add_only_missing_candidate_entries", "result.configurationPolicy.mcp.action");
  for (const field of ["replacement", "autoStart"]) {
    assertBooleanField(mcpConfiguration[field], `result.configurationPolicy.mcp.${field}`);
    if (mcpConfiguration[field] !== false) fail(`result.configurationPolicy.mcp.${field} must be false`);
  }

  const auth = exactRecord(current.authorization, AUTHORIZATION_FIELDS, "result.authorization");
  for (const field of AUTHORIZATION_FIELDS) {
    assertBooleanField(auth[field], `result.authorization.${field}`);
    if (auth[field] !== false) fail("candidate plan authorization must always be false");
  }
  return result;
}

/** Build a deterministic, deeply frozen, beta structural ZCode plan. */
export function buildZCodeCandidateRuntimePlan(probeFacts) {
  const facts = normalizeProbeFacts(probeFacts);
  const result = buildPlanFromFacts(facts);
  assertValidZCodeCandidateRuntimePlan(result);
  return deepFreeze(result);
}

export const ZCODE_CANDIDATE_AUTHORIZATION_FIELDS = AUTHORIZATION_FIELDS;
