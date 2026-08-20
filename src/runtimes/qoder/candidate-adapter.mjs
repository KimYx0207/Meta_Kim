/**
 * Qoder CLI beta compatibility is intentionally a packed structural planning
 * surface.
 *
 * This module is data-only. It accepts an explicit probe-fact envelope and
 * returns a reviewable plan. It never discovers a local Qoder installation,
 * starts qodercli, calls a model, reads or writes configuration, starts MCP,
 * or spends model/API quota. The plan is not a Qoder runtime projection.
 */

export const CANDIDATE_RUNTIME_ADAPTER_SCHEMA_VERSION = "candidate-runtime-adapter-v1";

const RUNTIME_ID = "qoder";
const TIER = "beta_compatibility";
const PLAN_MODE = "plan";
const PLAN_COMMAND = Object.freeze(["qodercli", "--permission-mode", PLAN_MODE]);
const FORBIDDEN_MODES = Object.freeze([
  "accept_edits",
  "auto",
  "bypass_permissions",
  "dangerously_skip_permissions",
  "dont_ask",
  "yolo",
]);

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

// These are documented extension surfaces, not claims of native Meta_Kim
// support. A missing surface is represented as unknown and keeps the plan
// fail-closed.
const CAPABILITY_NAMES = Object.freeze([
  "rules",
  "skills",
  "agents",
  "commands",
  "hooks",
  "mcp",
]);

const CAPABILITY_ALIASES = Object.freeze({
  rules: Object.freeze(["rules", "instructions"]),
  skills: Object.freeze(["skills"]),
  agents: Object.freeze(["agents", "modes"]),
  commands: Object.freeze(["commands"]),
  hooks: Object.freeze(["hooks"]),
  mcp: Object.freeze(["mcp"]),
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

function fail(message) {
  throw new TypeError(`Qoder candidate runtime adapter: ${message}`);
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

function denseArray(value, label, { max = 128, min = 0 } = {}) {
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
  if (
    values.length !== value.length ||
    values.some((_, index) => !Object.hasOwn(value, String(index)))
  ) fail(`${label} must be dense`);
  return values;
}

function text(value, label, { max = 512 } = {}) {
  if (typeof value !== "string") fail(`${label} must be a string`);
  const normalized = value.normalize("NFKC");
  if (
    normalized.length < 1 ||
    normalized.length > max ||
    CONTROL_CHARACTER.test(normalized)
  ) fail(`${label} must be bounded text`);
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
  const values = denseArray(value, label, options).map((item, index) =>
    text(item, `${label}[${index}]`, { max: 512 }),
  );
  if (new Set(values).size !== values.length) fail(`${label} must not contain duplicates`);
  return [...values].sort((left, right) => left.localeCompare(right));
}

function normalizeStatusFact(value, label) {
  if (!isPlainRecord(value)) fail(`${label} must be a plain record`);
  const entries = ownDataEntries(value, label);
  const allowed = new Set([
    "status",
    "verified",
    "observed",
    "supported",
    "observedModes",
    "modes",
    "observedPaths",
    "paths",
    "evidenceRefs",
    "configAuthority",
  ]);
  if (entries.some(([key]) => !allowed.has(key))) {
    fail(`${label} contains an unsupported field`);
  }
  const raw = Object.fromEntries(entries);
  const hasStatus = Object.hasOwn(raw, "status");
  const hasVerified = Object.hasOwn(raw, "verified");
  const hasObserved = Object.hasOwn(raw, "observed");
  if (!hasStatus && !hasVerified && !hasObserved) {
    fail(`${label} must state an explicit observed status`);
  }
  if (hasStatus && (hasVerified || hasObserved)) {
    fail(`${label} must use status or boolean observation, not both`);
  }

  const normalizedStatus = hasStatus
    ? status(raw.status, `${label}.status`)
    : (hasVerified ? boolean(raw.verified, `${label}.verified`) : boolean(raw.observed, `${label}.observed`))
      ? "verified"
      : "unverified";
  if (Object.hasOwn(raw, "supported")) {
    const supported = boolean(raw.supported, `${label}.supported`);
    if (supported && normalizedStatus !== "verified") {
      fail(`${label}.supported cannot claim support without verified evidence`);
    }
  }

  const modeValue = raw.observedModes ?? raw.modes ?? [];
  const pathValue = raw.observedPaths ?? raw.paths ?? [];
  const observedModes = uniqueSortedStrings(modeValue, `${label}.observedModes`);
  const observedPaths = uniqueSortedStrings(pathValue, `${label}.observedPaths`);
  const evidenceRefs = Object.hasOwn(raw, "evidenceRefs")
    ? uniqueSortedStrings(raw.evidenceRefs, `${label}.evidenceRefs`)
    : [];
  const result = { status: normalizedStatus, observedModes, observedPaths, evidenceRefs };
  if (Object.hasOwn(raw, "configAuthority")) {
    result.configAuthority = configAuthority(
      raw.configAuthority,
      `${label}.configAuthority`,
    );
  }
  return result;
}

function unknownCapability() {
  return { status: "unknown", observedModes: [], observedPaths: [], evidenceRefs: [] };
}

function normalizeCapabilities(value) {
  if (!isPlainRecord(value)) fail("probeFacts.capabilities must be a plain record");
  const entries = ownDataEntries(value, "probeFacts.capabilities");
  const knownInputNames = new Set(Object.values(CAPABILITY_ALIASES).flat());
  if (entries.some(([key]) => !knownInputNames.has(key))) {
    fail("probeFacts.capabilities contains an unsupported field");
  }
  const raw = Object.fromEntries(entries);
  const result = {};
  for (const name of CAPABILITY_NAMES) {
    const inputName = CAPABILITY_ALIASES[name].find((candidate) => Object.hasOwn(raw, candidate));
    result[name] = inputName
      ? normalizeStatusFact(raw[inputName], `probeFacts.capabilities.${inputName}`)
      : unknownCapability();
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
    "rules",
    "instructions",
    "skills",
    "agents",
    "modes",
    "commands",
    "hooks",
    "mcp",
    "source",
  ]);
  if (entries.some(([key]) => !allowed.has(key))) {
    fail("probeFacts contains an unsupported field");
  }
  const raw = Object.fromEntries(entries);
  if (raw.runtimeId !== RUNTIME_ID) fail("probeFacts.runtimeId must be qoder");
  const probeId = identifier(raw.probeId, "probeFacts.probeId");
  const evidenceRefs = uniqueSortedStrings(raw.evidenceRefs, "probeFacts.evidenceRefs", {
    min: 1,
  });
  const hasNested = Object.hasOwn(raw, "capabilities");
  const hasFlat = [
    "rules",
    "instructions",
    "skills",
    "agents",
    "modes",
    "commands",
    "hooks",
    "mcp",
  ].some((key) => Object.hasOwn(raw, key));
  if (hasNested && hasFlat) {
    fail("probeFacts must provide capabilities or flat capability facts, not both");
  }
  if (!hasNested && !hasFlat) {
    fail("probeFacts must provide capabilities or flat capability facts");
  }
  const flat = hasFlat
    ? Object.fromEntries(
      CAPABILITY_NAMES.map((name) => {
        const inputName = CAPABILITY_ALIASES[name].find((candidate) => Object.hasOwn(raw, candidate));
        return [name, inputName ? raw[inputName] : unknownCapability()];
      }),
    )
    : null;
  const capabilities = hasNested ? normalizeCapabilities(raw.capabilities) : normalizeCapabilities(flat);
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

const DOCUMENTED_SURFACE_MAP = Object.freeze({
  rules: Object.freeze({
    project: Object.freeze(["AGENTS.md", "AGENTS.local.md", ".qoder/rules/**/*.md"]),
    user: Object.freeze(["~/.qoder/AGENTS.md", "~/.qoder/rules/**/*.md"]),
  }),
  skills: Object.freeze({
    project: ".qoder/skills/{skill-name}/SKILL.md",
    user: "~/.qoder/skills/{skill-name}/SKILL.md",
  }),
  agents: Object.freeze({
    project: ".qoder/agents/{agent}.md",
    user: "~/.qoder/agents/{agent}.md",
    transient: "qodercli --agents <json>",
  }),
  commands: Object.freeze({
    project: ".qoder/commands/{command-name}.md",
    user: "~/.qoder/commands/{command-name}.md",
    invocation: "/{command-name}",
  }),
  configuration: Object.freeze({
    user: "~/.qoder/settings.json",
    project: ".qoder/settings.json",
    local: ".qoder/settings.local.json",
    mcpAlternative: ".mcp.json",
  }),
});

function capabilityAssessment(facts) {
  const anyUnverified = CAPABILITY_NAMES.some(
    (name) => facts.capabilities[name].status !== "verified",
  );
  const assessDocumented = (name) => ({
    status: facts.capabilities[name].status,
    observedModes: facts.capabilities[name].observedModes,
    observedPaths: facts.capabilities[name].observedPaths,
    claim: "documented_surface_only",
  });
  return {
    status: anyUnverified ? "fail_closed" : "bounded_beta_facts",
    rules: assessDocumented("rules"),
    skills: assessDocumented("skills"),
    agents: assessDocumented("agents"),
    commands: assessDocumented("commands"),
    hooks: {
      status: facts.capabilities.hooks.status,
      claim: "not_claimed",
      supported: false,
      observedPaths: facts.capabilities.hooks.observedPaths,
    },
    mcp: {
      status: facts.capabilities.mcp.status,
      mergePlan: "preserve_user_merge_plan_only",
      userConfigOwnership: facts.capabilities.mcp.configAuthority ?? "unknown",
      observedMcpSurface: facts.capabilities.mcp.status === "verified",
      observedPaths: facts.capabilities.mcp.observedPaths,
    },
  };
}

function buildPlanFromFacts(facts) {
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
    capabilityAssessment: capabilityAssessment(facts),
    projectionPlan: {
      status: "beta_compatibility_only",
      formalProjection: false,
      syncEligible: false,
      installEligible: false,
      integrationMode: "opt_in_rules_skills_plugin_plan",
      canonicalTemplate: "opt_in_beta_structural_adapter_only",
      documentedSurfaceMap: DOCUMENTED_SURFACE_MAP,
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
      headlessMode: PLAN_MODE,
      headlessCommand: PLAN_COMMAND,
      forbiddenHeadlessModes: FORBIDDEN_MODES,
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
  if (
    actual.length !== normalizedExpected.length ||
    actual.some((item, index) => item !== normalizedExpected[index])
  ) fail(`${label} is not canonical`);
}

function assertCapabilityAssessment(assessment, capabilities) {
  const current = exactRecord(
    assessment,
    ["status", ...CAPABILITY_NAMES],
    "result.capabilityAssessment",
  );
  const expectedStatus = CAPABILITY_NAMES.some(
    (name) => capabilities[name].status !== "verified",
  ) ? "fail_closed" : "bounded_beta_facts";
  assertExactString(current.status, expectedStatus, "result.capabilityAssessment.status");
  for (const name of ["rules", "skills", "agents", "commands"]) {
    const item = exactRecord(
      current[name],
      ["status", "observedModes", "observedPaths", "claim"],
      `result.capabilityAssessment.${name}`,
    );
    status(item.status, `result.capabilityAssessment.${name}.status`);
    if (item.status !== capabilities[name].status) {
      fail(`${name} assessment status is not bound to probe facts`);
    }
    assertStringArray(item.observedModes, capabilities[name].observedModes, `${name}.observedModes`);
    assertStringArray(item.observedPaths, capabilities[name].observedPaths, `${name}.observedPaths`);
    assertExactString(item.claim, "documented_surface_only", `${name}.claim`);
  }
  const hooks = exactRecord(
    current.hooks,
    ["status", "claim", "supported", "observedPaths"],
    "result.capabilityAssessment.hooks",
  );
  status(hooks.status, "result.capabilityAssessment.hooks.status");
  if (hooks.status !== capabilities.hooks.status) fail("hook status is not bound to probe facts");
  assertExactString(hooks.claim, "not_claimed", "result.capabilityAssessment.hooks.claim");
  assertBooleanField(hooks.supported, "result.capabilityAssessment.hooks.supported");
  if (hooks.supported !== false) fail("hook support must not be claimed");
  assertStringArray(hooks.observedPaths, capabilities.hooks.observedPaths, "hooks.observedPaths");
  const mcp = exactRecord(
    current.mcp,
    ["status", "mergePlan", "userConfigOwnership", "observedMcpSurface", "observedPaths"],
    "result.capabilityAssessment.mcp",
  );
  status(mcp.status, "result.capabilityAssessment.mcp.status");
  if (mcp.status !== capabilities.mcp.status) fail("MCP status is not bound to probe facts");
  assertExactString(mcp.mergePlan, "preserve_user_merge_plan_only", "result.capabilityAssessment.mcp.mergePlan");
  configAuthority(mcp.userConfigOwnership, "result.capabilityAssessment.mcp.userConfigOwnership");
  if (mcp.userConfigOwnership !== (capabilities.mcp.configAuthority ?? "unknown")) {
    fail("MCP config ownership is not bound to probe facts");
  }
  assertBooleanField(mcp.observedMcpSurface, "result.capabilityAssessment.mcp.observedMcpSurface");
  if (mcp.observedMcpSurface !== (mcp.status === "verified")) {
    fail("MCP assessment is not fail-closed");
  }
  assertStringArray(mcp.observedPaths, capabilities.mcp.observedPaths, "mcp.observedPaths");
}

function assertValidProjectionPlan(value) {
  const projection = exactRecord(
    value,
    [
      "status",
      "formalProjection",
      "syncEligible",
      "installEligible",
      "integrationMode",
      "canonicalTemplate",
      "documentedSurfaceMap",
      "managedPaths",
      "promotionRequires",
    ],
    "result.projectionPlan",
  );
  assertExactString(projection.status, "beta_compatibility_only", "result.projectionPlan.status");
  for (const field of ["formalProjection", "syncEligible", "installEligible"]) {
    assertBooleanField(projection[field], `result.projectionPlan.${field}`);
    if (projection[field] !== false) fail(`result.projectionPlan.${field} must be false`);
  }
  assertExactString(projection.integrationMode, "opt_in_rules_skills_plugin_plan", "result.projectionPlan.integrationMode");
  assertExactString(projection.canonicalTemplate, "opt_in_beta_structural_adapter_only", "result.projectionPlan.canonicalTemplate");
  if (JSON.stringify(projection.documentedSurfaceMap) !== JSON.stringify(DOCUMENTED_SURFACE_MAP)) {
    fail("result.projectionPlan.documentedSurfaceMap is not canonical");
  }
  assertStringArray(projection.managedPaths, [], "result.projectionPlan.managedPaths");
  assertStringArray(projection.promotionRequires, [
    "packed_structural_adapter_verification",
    "official_path_and_config_contract",
    "merge_safe_install_update_uninstall_policy",
    "separate_live_acceptance",
  ], "result.projectionPlan.promotionRequires");
}

function assertValidInvocationPolicy(value) {
  const invocation = exactRecord(
    value,
    [
      "mode",
      "modelInvocation",
      "processSpawn",
      "headlessMode",
      "headlessCommand",
      "forbiddenHeadlessModes",
      "yolo",
      "hooks",
      "mcpAutoStart",
    ],
    "result.invocationPolicy",
  );
  assertExactString(invocation.mode, "plan_only", "result.invocationPolicy.mode");
  assertExactString(invocation.modelInvocation, "forbidden", "result.invocationPolicy.modelInvocation");
  assertExactString(invocation.processSpawn, "forbidden", "result.invocationPolicy.processSpawn");
  assertExactString(invocation.headlessMode, PLAN_MODE, "result.invocationPolicy.headlessMode");
  const command = denseArray(invocation.headlessCommand, "result.invocationPolicy.headlessCommand");
  if (JSON.stringify(command) !== JSON.stringify(PLAN_COMMAND)) {
    fail("headless command must force qodercli --permission-mode plan");
  }
  assertStringArray(invocation.forbiddenHeadlessModes, FORBIDDEN_MODES, "result.invocationPolicy.forbiddenHeadlessModes");
  assertBooleanField(invocation.yolo, "result.invocationPolicy.yolo");
  if (invocation.yolo !== false) fail("yolo must be false");
  assertExactString(invocation.hooks, "not_claimed", "result.invocationPolicy.hooks");
  assertBooleanField(invocation.mcpAutoStart, "result.invocationPolicy.mcpAutoStart");
  if (invocation.mcpAutoStart !== false) fail("MCP auto-start must be false");
}

function assertValidConfigurationPolicy(value) {
  const configuration = exactRecord(
    value,
    ["mode", "readExistingConfig", "writeConfig", "overwriteWholeFile", "mcp"],
    "result.configurationPolicy",
  );
  assertExactString(configuration.mode, "preserve_user_merge_plan_only", "result.configurationPolicy.mode");
  for (const field of ["readExistingConfig", "writeConfig", "overwriteWholeFile"]) {
    assertBooleanField(configuration[field], `result.configurationPolicy.${field}`);
    if (configuration[field] !== false) fail(`result.configurationPolicy.${field} must be false`);
  }
  const mcp = exactRecord(
    configuration.mcp,
    ["action", "replacement", "autoStart"],
    "result.configurationPolicy.mcp",
  );
  assertExactString(mcp.action, "preserve_user_entries_and_add_only_missing_candidate_entries", "result.configurationPolicy.mcp.action");
  for (const field of ["replacement", "autoStart"]) {
    assertBooleanField(mcp[field], `result.configurationPolicy.mcp.${field}`);
    if (mcp[field] !== false) fail(`result.configurationPolicy.mcp.${field} must be false`);
  }
}

function assertValidAuthorization(value) {
  const auth = exactRecord(value, AUTHORIZATION_FIELDS, "result.authorization");
  for (const field of AUTHORIZATION_FIELDS) {
    assertBooleanField(auth[field], `result.authorization.${field}`);
    if (auth[field] !== false) fail("candidate plan authorization must always be false");
  }
}

/**
 * Validate a candidate plan without granting any permission. The validator
 * accepts a cloned plan for review/tests, but never repairs or mutates it.
 */
export function assertValidQoderCandidateRuntimePlan(result) {
  const current = exactRecord(result, RESULT_FIELDS, "result");
  assertExactString(current.schemaVersion, CANDIDATE_RUNTIME_ADAPTER_SCHEMA_VERSION, "result.schemaVersion");
  assertExactString(current.runtimeId, RUNTIME_ID, "result.runtimeId");
  assertExactString(current.tier, TIER, "result.tier");
  assertBooleanField(current.formalProjection, "result.formalProjection");
  if (current.formalProjection !== false) fail("result.formalProjection must be false");

  const probe = exactRecord(
    current.probe,
    ["runtimeId", "probeId", "source", "evidenceRefs", "capabilities"],
    "result.probe",
  );
  assertExactString(probe.runtimeId, RUNTIME_ID, "result.probe.runtimeId");
  identifier(probe.probeId, "result.probe.probeId");
  identifier(probe.source, "result.probe.source");
  uniqueSortedStrings(probe.evidenceRefs, "result.probe.evidenceRefs", { min: 1 });
  const capabilities = exactRecord(probe.capabilities, CAPABILITY_NAMES, "result.probe.capabilities");
  for (const name of CAPABILITY_NAMES) {
    const fact = normalizeStatusFact(capabilities[name], `result.probe.capabilities.${name}`);
    if (JSON.stringify(fact) !== JSON.stringify(capabilities[name])) {
      fail(`result.probe.capabilities.${name} is not canonical`);
    }
  }

  assertCapabilityAssessment(current.capabilityAssessment, capabilities);
  assertValidProjectionPlan(current.projectionPlan);
  assertValidInvocationPolicy(current.invocationPolicy);
  assertValidConfigurationPolicy(current.configurationPolicy);
  assertValidAuthorization(current.authorization);
  return result;
}

/** Build a deterministic, deeply frozen, beta structural Qoder plan. */
export function buildQoderCandidateRuntimePlan(probeFacts) {
  const facts = normalizeProbeFacts(probeFacts);
  const result = buildPlanFromFacts(facts);
  assertValidQoderCandidateRuntimePlan(result);
  return deepFreeze(result);
}

export const QODER_CANDIDATE_AUTHORIZATION_FIELDS = AUTHORIZATION_FIELDS;
export const QODER_CANDIDATE_CAPABILITY_NAMES = CAPABILITY_NAMES;
