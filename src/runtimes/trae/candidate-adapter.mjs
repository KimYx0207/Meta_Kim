/**
 * Trae beta compatibility is a packed structural planning surface only.
 *
 * The adapter accepts an explicit probe record and returns a conservative
 * plan.  It never discovers Trae, invokes a model or process, reads or writes
 * configuration, or starts/calls an MCP server.  Missing facts stay unknown
 * and keep the plan fail-closed.
 */

export const CANDIDATE_RUNTIME_ADAPTER_SCHEMA_VERSION = "candidate-runtime-adapter-v1";

const RUNTIME_ID = "trae";
const TIER = "beta_compatibility";
const PLAN_MODE = "plan_only";

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

// These are the documented surfaces we can describe without treating a UI
// control or a remembered catalog entry as a stable runtime contract.
const CAPABILITY_NAMES = Object.freeze([
  "instructions",
  "rules",
  "skills",
  "agents",
  "modes",
  "mcp",
  "commands",
  "memory",
  "hooks",
]);

const CAPABILITY_ALIASES = Object.freeze({
  instruction_context: "instructions",
  skill_workflow: "skills",
  agent_mode: "agents",
  mcp_tooling: "mcp",
  memory_context: "memory",
  hook_automation: "hooks",
});

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
const FORBIDDEN_RESULT_KEYS = new Set([
  "rawOutput",
  "rawModelOutput",
  "prompt",
  "response",
  "stdout",
  "stderr",
  "credential",
  "credentials",
  "secret",
  "token",
  "apiKey",
]);

function fail(message) {
  throw new TypeError(`Trae candidate runtime adapter: ${message}`);
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
  if (values.length !== value.length || values.some((_, index) => !Object.hasOwn(value, String(index)))) {
    fail(`${label} must be dense`);
  }
  return values;
}

function text(value, label, { max = 512, allowEmpty = false } = {}) {
  if (typeof value !== "string") fail(`${label} must be a string`);
  const normalized = value.normalize("NFKC");
  if ((!allowEmpty && normalized.length < 1) || normalized.length > max || CONTROL_CHARACTER.test(normalized)) {
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

function sortedTexts(value, label, options = {}) {
  const values = denseArray(value, label, options).map((item, index) =>
    text(item, `${label}[${index}]`, { max: 512 }),
  );
  if (new Set(values).size !== values.length) fail(`${label} must not contain duplicates`);
  return [...values].sort((left, right) => left.localeCompare(right));
}

function normalizeStatusFact(value, label, capabilityName) {
  if (!isPlainRecord(value)) fail(`${label} must be a plain record`);
  const entries = ownDataEntries(value, label);
  const allowed = new Set([
    "status",
    "verified",
    "observed",
    "supported",
    "observedPaths",
    "paths",
    "observedFormats",
    "formats",
    "observedModes",
    "modes",
    "transportTypes",
    "transports",
    "configAuthority",
    "evidenceRefs",
  ]);
  if (entries.some(([key]) => !allowed.has(key))) fail(`${label} contains an unsupported field`);
  const raw = Object.fromEntries(entries);
  const hasStatus = Object.hasOwn(raw, "status");
  const hasVerified = Object.hasOwn(raw, "verified");
  const hasObserved = Object.hasOwn(raw, "observed");
  if (!hasStatus && !hasVerified && !hasObserved) fail(`${label} must state an explicit observed status`);
  if (hasStatus && (hasVerified || hasObserved)) fail(`${label} must use status or boolean observation, not both`);

  const normalizedStatus = hasStatus
    ? status(raw.status, `${label}.status`)
    : (boolean(hasVerified ? raw.verified : raw.observed, `${label}.${hasVerified ? "verified" : "observed"}`)
      ? "verified"
      : "unverified");
  if (Object.hasOwn(raw, "supported") && boolean(raw.supported, `${label}.supported`) && normalizedStatus !== "verified") {
    fail(`${label}.supported cannot claim support without verified evidence`);
  }

  const paths = sortedTexts(raw.observedPaths ?? raw.paths ?? [], `${label}.observedPaths`);
  const formats = sortedTexts(raw.observedFormats ?? raw.formats ?? [], `${label}.observedFormats`);
  const modes = sortedTexts(raw.observedModes ?? raw.modes ?? [], `${label}.observedModes`);
  const transports = sortedTexts(raw.transportTypes ?? raw.transports ?? [], `${label}.transportTypes`);
  const evidenceRefs = Object.hasOwn(raw, "evidenceRefs")
    ? sortedTexts(raw.evidenceRefs, `${label}.evidenceRefs`)
    : [];
  const defaultAuthority = capabilityName === "mcp" ? "unknown" : "not_observed";
  return {
    status: normalizedStatus,
    observedPaths: paths,
    observedFormats: formats,
    observedModes: modes,
    transportTypes: transports,
    configAuthority: Object.hasOwn(raw, "configAuthority")
      ? configAuthority(raw.configAuthority, `${label}.configAuthority`)
      : defaultAuthority,
    evidenceRefs,
  };
}

function canonicalCapabilityName(name, label) {
  const canonical = CAPABILITY_NAMES.includes(name) ? name : CAPABILITY_ALIASES[name];
  if (!canonical) fail(`${label} is not a supported Trae capability`);
  return canonical;
}

function normalizeCapabilityRecords(value, label) {
  if (!isPlainRecord(value)) fail(`${label} must be a plain record`);
  const entries = ownDataEntries(value, label);
  const records = new Map();
  for (const [rawName, rawFact] of entries) {
    const name = canonicalCapabilityName(rawName, `${label}.${rawName}`);
    if (records.has(name)) fail(`${label} contains duplicate capability aliases for ${name}`);
    records.set(name, rawFact);
  }
  return records;
}

function normalizeProbeFacts(probeFacts) {
  if (!isPlainRecord(probeFacts)) fail("probeFacts must be a plain record");
  const entries = ownDataEntries(probeFacts, "probeFacts");
  const allowed = new Set([
    "runtimeId",
    "probeId",
    "evidenceRefs",
    "capabilities",
    ...CAPABILITY_NAMES,
    ...Object.keys(CAPABILITY_ALIASES),
    "source",
  ]);
  if (entries.some(([key]) => !allowed.has(key))) fail("probeFacts contains an unsupported field");
  const raw = Object.fromEntries(entries);
  if (Object.hasOwn(raw, "runtimeId") && raw.runtimeId !== RUNTIME_ID) fail("probeFacts.runtimeId must be trae");
  const probeId = identifier(raw.probeId, "probeFacts.probeId");
  const evidenceRefs = sortedTexts(raw.evidenceRefs, "probeFacts.evidenceRefs", { min: 1 });
  const nested = Object.hasOwn(raw, "capabilities") ? normalizeCapabilityRecords(raw.capabilities, "probeFacts.capabilities") : new Map();
  const flat = new Map();
  for (const name of [...CAPABILITY_NAMES, ...Object.keys(CAPABILITY_ALIASES)]) {
    if (Object.hasOwn(raw, name)) {
      const canonical = canonicalCapabilityName(name, `probeFacts.${name}`);
      if (flat.has(canonical)) fail(`probeFacts contains duplicate capability aliases for ${canonical}`);
      flat.set(canonical, raw[name]);
    }
  }
  if (nested.size > 0 && flat.size > 0) fail("probeFacts must use capabilities or flat capability facts, not both");
  const provided = nested.size > 0 ? nested : flat;
  if (provided.size === 0) fail("probeFacts must provide capability facts");
  const capabilities = Object.fromEntries(
    CAPABILITY_NAMES.map((name) => [
      name,
      normalizeStatusFact(
        provided.get(name) ?? { status: "not_observed" },
        `probeFacts.capabilities.${name}`,
        name,
      ),
    ]),
  );
  const source = Object.hasOwn(raw, "source")
    ? identifier(raw.source, "probeFacts.source")
    : "explicit_probe_facts";
  return { runtimeId: RUNTIME_ID, probeId, source, evidenceRefs, capabilities };
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

function assessmentFor(name, fact) {
  const assessment = {
    status: fact.status,
    observedPaths: fact.observedPaths,
    observedFormats: fact.observedFormats,
    observedModes: fact.observedModes,
    transportTypes: fact.transportTypes,
    userConfigOwnership: fact.configAuthority,
    observedSurface: fact.status === "verified",
  };
  if (name === "mcp") {
    assessment.mergePlan = "preserve_user_merge_plan_only";
    assessment.configPathClaim = "unknown";
    assessment.configFormatClaim = "unknown";
  }
  if (name === "hooks" || name === "commands") {
    assessment.claim = "not_claimed";
    assessment.supported = false;
  }
  if (name === "agents") {
    assessment.nativeRuntimeClaimed = false;
  }
  return assessment;
}

function buildPlanFromFacts(facts) {
  const allVerified = CAPABILITY_NAMES.every((name) => facts.capabilities[name].status === "verified");
  const capabilityAssessment = { status: allVerified ? "bounded_beta_facts" : "fail_closed" };
  for (const name of CAPABILITY_NAMES) capabilityAssessment[name] = assessmentFor(name, facts.capabilities[name]);

  return {
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
    capabilityAssessment,
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
      mode: PLAN_MODE,
      modelInvocation: "forbidden",
      processSpawn: "forbidden",
      commandExecution: "forbidden",
      mcpToolInvocation: "forbidden",
      observedModes: facts.capabilities.modes.observedModes,
      modeSelection: "structural_facts_only",
      hooks: "not_claimed",
      mcpAutoStart: false,
      consumesQuota: false,
    },
    configurationPolicy: {
      mode: "preserve_user_merge_plan_only",
      readExistingConfig: false,
      writeConfig: false,
      overwriteWholeFile: false,
      mcp: {
        action: "preserve_user_entries_and_add_only_missing_candidate_entries",
        configPathClaim: "unknown",
        configFormatClaim: "unknown",
        writeConfig: false,
        replacement: false,
        autoStart: false,
      },
    },
    authorization: authorization(),
  };
}

function assertBooleanField(value, label) {
  if (typeof value !== "boolean") fail(`${label} must be boolean`);
}

function assertExactString(value, expected, label) {
  if (value !== expected) fail(`${label} must be ${expected}`);
}

function assertStringArray(value, expected, label) {
  const actual = sortedTexts(value, label);
  const normalizedExpected = [...expected].sort((left, right) => left.localeCompare(right));
  if (actual.length !== normalizedExpected.length || actual.some((item, index) => item !== normalizedExpected[index])) {
    fail(`${label} is not canonical`);
  }
}

function assertNoForbiddenData(value, seen = new Set()) {
  if (typeof value === "string") {
    if (SECRET_VALUE.test(value)) fail("result contains sensitive material");
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) fail("result must not contain cycles");
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_RESULT_KEYS.has(key)) fail("result contains forbidden raw data");
    assertNoForbiddenData(child, seen);
  }
  seen.delete(value);
}

function assertValidCapabilityAssessment(value, capabilities) {
  const fields = ["status", ...CAPABILITY_NAMES];
  const assessment = exactRecord(value, fields, "result.capabilityAssessment");
  const expectedStatus = CAPABILITY_NAMES.every((name) => capabilities[name].status === "verified")
    ? "bounded_beta_facts"
    : "fail_closed";
  assertExactString(assessment.status, expectedStatus, "result.capabilityAssessment.status");
  for (const name of CAPABILITY_NAMES) {
    const current = exactRecord(
      assessment[name],
      [
        "status",
        "observedPaths",
        "observedFormats",
        "observedModes",
        "transportTypes",
        "userConfigOwnership",
        "observedSurface",
        ...(name === "mcp" ? ["mergePlan", "configPathClaim", "configFormatClaim"] : []),
        ...(name === "hooks" || name === "commands" ? ["claim", "supported"] : []),
        ...(name === "agents" ? ["nativeRuntimeClaimed"] : []),
      ],
      `result.capabilityAssessment.${name}`,
    );
    const fact = capabilities[name];
    assertExactString(current.status, fact.status, `result.capabilityAssessment.${name}.status`);
    assertStringArray(current.observedPaths, fact.observedPaths, `result.capabilityAssessment.${name}.observedPaths`);
    assertStringArray(current.observedFormats, fact.observedFormats, `result.capabilityAssessment.${name}.observedFormats`);
    assertStringArray(current.observedModes, fact.observedModes, `result.capabilityAssessment.${name}.observedModes`);
    assertStringArray(current.transportTypes, fact.transportTypes, `result.capabilityAssessment.${name}.transportTypes`);
    configAuthority(current.userConfigOwnership, `result.capabilityAssessment.${name}.userConfigOwnership`);
    assertExactString(current.userConfigOwnership, fact.configAuthority, `result.capabilityAssessment.${name}.userConfigOwnership`);
    assertBooleanField(current.observedSurface, `result.capabilityAssessment.${name}.observedSurface`);
    if (current.observedSurface !== (fact.status === "verified")) fail(`${name} assessment is not fail-closed`);
    if (name === "mcp") {
      assertExactString(current.mergePlan, "preserve_user_merge_plan_only", `result.capabilityAssessment.${name}.mergePlan`);
      assertExactString(current.configPathClaim, "unknown", `result.capabilityAssessment.${name}.configPathClaim`);
      assertExactString(current.configFormatClaim, "unknown", `result.capabilityAssessment.${name}.configFormatClaim`);
    }
    if (name === "hooks" || name === "commands") {
      assertExactString(current.claim, "not_claimed", `result.capabilityAssessment.${name}.claim`);
      if (current.supported !== false) fail(`${name} support must not be claimed`);
    }
    if (name === "agents") {
      if (current.nativeRuntimeClaimed !== false) fail("native agent support must not be claimed");
    }
  }
}

/** Validate a Trae plan without mutating it or granting any permission. */
export function assertValidTraeCandidateRuntimePlan(result) {
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
  sortedTexts(probe.evidenceRefs, "result.probe.evidenceRefs", { min: 1 });
  const capabilityRecords = exactRecord(probe.capabilities, CAPABILITY_NAMES, "result.probe.capabilities");
  for (const name of CAPABILITY_NAMES) normalizeStatusFact(capabilityRecords[name], `result.probe.capabilities.${name}`, name);
  assertValidCapabilityAssessment(current.capabilityAssessment, capabilityRecords);

  const projection = exactRecord(
    current.projectionPlan,
    ["status", "formalProjection", "syncEligible", "installEligible", "canonicalTemplate", "managedPaths", "promotionRequires"],
    "result.projectionPlan",
  );
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

  const invocation = exactRecord(
    current.invocationPolicy,
    ["mode", "modelInvocation", "processSpawn", "commandExecution", "mcpToolInvocation", "observedModes", "modeSelection", "hooks", "mcpAutoStart", "consumesQuota"],
    "result.invocationPolicy",
  );
  assertExactString(invocation.mode, PLAN_MODE, "result.invocationPolicy.mode");
  for (const field of ["modelInvocation", "processSpawn", "commandExecution", "mcpToolInvocation"]) {
    assertExactString(invocation[field], "forbidden", `result.invocationPolicy.${field}`);
  }
  assertStringArray(invocation.observedModes, capabilityRecords.modes.observedModes, "result.invocationPolicy.observedModes");
  assertExactString(invocation.modeSelection, "structural_facts_only", "result.invocationPolicy.modeSelection");
  assertExactString(invocation.hooks, "not_claimed", "result.invocationPolicy.hooks");
  assertBooleanField(invocation.mcpAutoStart, "result.invocationPolicy.mcpAutoStart");
  assertBooleanField(invocation.consumesQuota, "result.invocationPolicy.consumesQuota");
  if (invocation.mcpAutoStart !== false || invocation.consumesQuota !== false) fail("invocation policy grants side effects");

  const configuration = exactRecord(current.configurationPolicy, ["mode", "readExistingConfig", "writeConfig", "overwriteWholeFile", "mcp"], "result.configurationPolicy");
  assertExactString(configuration.mode, "preserve_user_merge_plan_only", "result.configurationPolicy.mode");
  for (const field of ["readExistingConfig", "writeConfig", "overwriteWholeFile"]) {
    assertBooleanField(configuration[field], `result.configurationPolicy.${field}`);
    if (configuration[field] !== false) fail(`result.configurationPolicy.${field} must be false`);
  }
  const mcpConfiguration = exactRecord(configuration.mcp, ["action", "configPathClaim", "configFormatClaim", "writeConfig", "replacement", "autoStart"], "result.configurationPolicy.mcp");
  assertExactString(mcpConfiguration.action, "preserve_user_entries_and_add_only_missing_candidate_entries", "result.configurationPolicy.mcp.action");
  assertExactString(mcpConfiguration.configPathClaim, "unknown", "result.configurationPolicy.mcp.configPathClaim");
  assertExactString(mcpConfiguration.configFormatClaim, "unknown", "result.configurationPolicy.mcp.configFormatClaim");
  for (const field of ["writeConfig", "replacement", "autoStart"]) {
    assertBooleanField(mcpConfiguration[field], `result.configurationPolicy.mcp.${field}`);
    if (mcpConfiguration[field] !== false) fail(`MCP configuration policy ${field} must be false`);
  }

  const auth = exactRecord(current.authorization, AUTHORIZATION_FIELDS, "result.authorization");
  for (const field of AUTHORIZATION_FIELDS) {
    assertBooleanField(auth[field], `result.authorization.${field}`);
    if (auth[field] !== false) fail("candidate plan authorization must always be false");
  }
  assertNoForbiddenData(result);
  return result;
}

/** Build a deterministic, deeply frozen, beta structural Trae plan. */
export function buildTraeCandidateRuntimePlan(probeFacts) {
  const facts = normalizeProbeFacts(probeFacts);
  const result = buildPlanFromFacts(facts);
  assertValidTraeCandidateRuntimePlan(result);
  return deepFreeze(result);
}

export const TRAE_CANDIDATE_AUTHORIZATION_FIELDS = AUTHORIZATION_FIELDS;
