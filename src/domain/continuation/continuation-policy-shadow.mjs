/**
 * Pure Phase-2 continuation-policy shadow.
 *
 * The result is advisory only. It cannot resume a run, authorize execution,
 * dispatch work, mutate Todo state, or write kernel/runtime state.
 */

export const CONTINUATION_POLICY_SHADOW_SCHEMA_VERSION = "continuation-policy-shadow-v1";
export const CONTINUATION_POLICY_SHADOW_DISPOSITIONS = Object.freeze(["continue", "wait", "stop", "escalate"]);
export const CONTINUATION_POLICY_SHADOW_REASON_CODES = deepFreeze({
  escalate: [
    "authority_binding_mismatch",
    "projection_integrity_failed",
    "unsupported_projection_schema",
    "required_work_out_of_scope",
    "hard_blocker_requires_route_change",
    "contradictory_authoritative_signals",
    "invalid_shadow_input",
  ],
  stop: [
    "verified_user_stop",
    "authoritative_run_terminal",
    "all_goals_satisfied",
    "repeat_only_no_new_evidence",
    "no_unfinished_goal",
  ],
  wait: [
    "authority_snapshot_currentness_unproven",
    "active_claim_requires_kernel_recheck",
    "unresolved_effect_present",
    "bridge_settlement_incomplete",
    "awaiting_human_decision",
    "human_decision_denied",
    "recoverable_blocker_present",
    "goal_state_unknown",
    "no_executable_work_observed",
    "work_state_unknown",
    "new_evidence_opportunity_unknown",
    "evidence_transition_blocked",
    "evidence_transition_in_doubt",
    "evidence_transition_not_evaluated",
  ],
  continue: [
    "unfinished_goal_executable_in_scope",
    "new_valid_evidence_expected",
    "shadow_evidence_transition_allowed",
  ],
});

const COMMAND_FIELDS = Object.freeze([
  "binding", "authoritySnapshot", "goalAssessment", "workAssessment",
  "evidenceAssessment", "blockerAssessment", "humanDecisionAssessment",
  "scopeAssessment", "repeatAssessment", "controlAssessment", "evidenceTransition",
]);
const BINDING_FIELDS = Object.freeze([
  "runId", "taskFingerprint", "graphDigest", "projectionDigest", "durableCursor",
  "headEventHash", "headCheckpointId", "policyDigest", "evaluationRevision",
]);
const AUTHORITY_FIELDS = Object.freeze([
  "source", "projectionSchemaVersion", "runStatus", "runId", "taskFingerprint",
  "graphDigest", "cursor", "headEventHash", "headCheckpointId", "projectionDigest",
  "eventChainState", "blockingEffectRefs", "activeClaimRefs", "bridgeSettlementState",
  "currentness",
]);
const ASSESSMENT_FIELDS = Object.freeze(["state", "evidenceRefs", "assessmentDigest"]);
const CONTROL_FIELDS = Object.freeze(["state", "controlRef", "evidenceRefs", "assessmentDigest"]);
const EVIDENCE_TRANSITION_FIELDS = Object.freeze([
  "schemaVersion", "resultDigest", "bindingDigest", "evaluationStatus", "verdict",
]);
const RESULT_FIELDS = Object.freeze([
  "schemaVersion", "kind", "binding", "bindingDigest", "authoritySnapshot",
  "goalAssessment", "workAssessment", "evidenceAssessment", "blockerAssessment",
  "humanDecisionAssessment", "scopeAssessment", "repeatAssessment", "controlAssessment",
  "evidenceTransition", "disposition", "eventIntents", "authorization",
]);
const DISPOSITION_FIELDS = Object.freeze(["action", "reasonCodes", "evidenceRefs"]);
const EVENT_INTENT_FIELDS = Object.freeze([
  "kind", "intentDigest", "disposition", "reasonCodesDigest", "persisted", "authoritative", "writeAllowed",
]);
const AUTHORIZATION_FIELDS = Object.freeze([
  "continuationAuthorized", "executionAllowed", "schedulerDispatchAllowed", "todoMutationAllowed",
  "authoritativeWriteAllowed", "eventPersistenceAllowed", "durableCursorAdvanceAllowed",
  "completeNodeAllowed", "runTerminalStatusWriteAllowed", "checkpointMutationAllowed",
  "leaseMutationAllowed", "fenceMutationAllowed", "legacyGateCutoverAllowed",
]);

const AUTHORITY_SOURCE = "stage_runner_bridge_existing_authority_projection";
const SUPPORTED_PROJECTION_SCHEMA_VERSION = "durable-governed-run-projection-v0.1";
const EVIDENCE_TRANSITION_SCHEMA_VERSION = "evidence-transition-shadow-v1";
const SHA256_REFERENCE_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const OPAQUE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+\-]{0,511}$/u;
const MAX_LIST_LENGTH = 256;

const STATE_VALUES = Object.freeze({
  goalAssessment: ["unfinished", "satisfied", "unknown"],
  workAssessment: ["executable_candidate_present", "none", "unknown"],
  evidenceAssessment: ["new_valid_evidence_expected", "none_expected", "unknown"],
  blockerAssessment: ["none", "recoverable", "hard", "unknown"],
  humanDecisionAssessment: ["not_required", "pending", "answered_verified", "denied", "unknown"],
  scopeAssessment: ["inside", "outside", "unknown"],
  repeatAssessment: ["novel", "repeat_only", "unknown"],
  controlAssessment: ["none", "stop_verified", "continue_verified", "unknown"],
});

function fail(message) {
  throw new TypeError(`Continuation policy shadow: ${message}`);
}

function ownDataEntries(value, label) {
  let prototype;
  let keys;
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a plain Object.prototype record`);
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail(`${label} must be an inspectable plain own-data record`);
  }
  if (prototype !== Object.prototype) fail(`${label} must be a plain Object.prototype record`);
  return keys.map((key) => {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail(`${label} must be an inspectable plain own-data record`);
    }
    if (typeof key !== "string" || descriptor?.enumerable !== true || !("value" in descriptor)) {
      fail(`${label} must contain enumerable string own data properties only`);
    }
    return [key, descriptor.value];
  });
}

function exactRecord(value, fields, label) {
  const entries = ownDataEntries(value, label);
  const values = new Map(entries);
  if (entries.length !== fields.length || entries.some(([key]) => !fields.includes(key))) {
    fail(`${label} must contain exactly the supported fields`);
  }
  for (const field of fields) if (!values.has(field)) fail(`${label}.${field} is required`);
  return Object.fromEntries(fields.map((field) => [field, values.get(field)]));
}

function denseArray(value, label) {
  let prototype;
  let keys;
  let lengthDescriptor;
  try {
    if (!Array.isArray(value)) fail(`${label} must be a plain Array.prototype list`);
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    fail(`${label} must be an inspectable dense own-data list`);
  }
  if (prototype !== Array.prototype || !lengthDescriptor || !("value" in lengthDescriptor)) {
    fail(`${label} must be a plain dense list`);
  }
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_LIST_LENGTH) {
    fail(`${label} length is outside the supported bound`);
  }
  const items = new Map();
  for (const key of keys) {
    if (key === "length") continue;
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail(`${label} must be an inspectable dense own-data list`);
    }
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)
      || descriptor?.enumerable !== true || !("value" in descriptor)) {
      fail(`${label} must contain enumerable numeric own data properties only`);
    }
    items.set(key, descriptor.value);
  }
  if (items.size !== length) fail(`${label} must not contain sparse entries`);
  return Array.from({ length }, (_, index) => {
    const key = String(index);
    if (!items.has(key)) fail(`${label} must not contain sparse entries`);
    return items.get(key);
  });
}

function containsSensitiveMaterialMarker(value) {
  const normalized = value.normalize("NFKC")
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/gu, "-")
    .replace(/[\u2024\uFE52\uFF0E]/gu, ".");
  const folded = normalized.toLowerCase()
    .replace(/[аα]/gu, "a").replace(/[еε]/gu, "e").replace(/[іι]/gu, "i")
    .replace(/[оο]/gu, "o").replace(/[рρ]/gu, "p").replace(/[сϲ]/gu, "c")
    .replace(/[ѕ]/gu, "s").replace(/[тτ]/gu, "t").replace(/[υу]/gu, "u")
    .replace(/[хχ]/gu, "x").replace(/[κ]/gu, "k").replace(/[ν]/gu, "v");
  const compact = folded.replace(/[^a-z0-9]/gu, "");
  const tokens = folded.split(/[^a-z0-9]+/gu).filter(Boolean);
  if (/(?:https?|ftp|file):|www\./u.test(folded) || /[\\/]/u.test(folded)) return true;
  if (/(?:secret|password|passwd|credential|privatekey|apikey|accesstoken|refreshtoken|bearertoken)/u.test(compact)) return true;
  if (tokens.some((token) => ["raw", "path", "url", "token", "secret", "credential", "password", "privatekey", "bearer"].includes(token))) return true;
  if (/^sk(?:proj|ant|live|test)?[a-z0-9]{16,}$/u.test(compact)) return true;
  if (/^(?:akia|asia)[a-z0-9]{16}$/u.test(compact)) return true;
  if (/^gh[pousr][a-z0-9]{20,}$/u.test(compact)) return true;
  if (/^(?:xox[baprs]|ai?za)[a-z0-9]{20,}$/u.test(compact)) return true;
  if (/^(?:rk|pk|sk)(?:live|test)[a-z0-9]{16,}$/u.test(compact)) return true;
  if (/^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}$/u.test(normalized)) return true;
  return looksLikeHighEntropyCredential(normalized);
}

function looksLikeHighEntropyCredential(value) {
  if (value.includes(":") || value.length < 40 || value.length > 512 || !/^[A-Za-z0-9_+.-]+$/u.test(value)) return false;
  const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[_+.-]/u].filter((pattern) => pattern.test(value)).length;
  if (classes < 3) return false;
  const frequencies = new Map();
  for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy >= 4;
}

function opaqueRef(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !OPAQUE_REFERENCE_PATTERN.test(value) || containsSensitiveMaterialMarker(value)) {
    fail(`${label} must be a safe bounded opaque reference`);
  }
  return value;
}

function digestRef(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !SHA256_REFERENCE_PATTERN.test(value)) fail(`${label} must be a strict sha256 reference`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative safe integer`);
  return value;
}

function enumValue(value, allowed, label) {
  if (typeof value !== "string" || !allowed.includes(value)) fail(`${label} is unsupported`);
  return value;
}

function canonicalCompare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

function sortedUniqueRefs(value, label) {
  const refs = denseArray(value, label).map((item, index) => opaqueRef(item, `${label}[${index}]`));
  if (new Set(refs).size !== refs.length) fail(`${label} must not contain duplicates`);
  return refs.sort(canonicalCompare);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(canonicalCompare).map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function canonicalJson(value) { return JSON.stringify(canonical(value)); }

// Pure ECMAScript SHA-256 preserves the no-Node/no-I/O domain boundary.
function sha256(value) {
  const bytes = new TextEncoder().encode(String(value));
  const bitLength = BigInt(bytes.length) * 8n;
  const paddedLength = ((bytes.length + 9 + 63) >> 6) << 6;
  const message = new Uint8Array(paddedLength);
  message.set(bytes);
  message[bytes.length] = 0x80;
  for (let index = 0; index < 8; index += 1) {
    message[paddedLength - 1 - index] = Number((bitLength >> BigInt(index * 8)) & 0xffn);
  }
  const constants = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  let hash = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const rotate = (word, bits) => (word >>> bits) | (word << (32 - bits));
  for (let offset = 0; offset < message.length; offset += 64) {
    const words = new Uint32Array(64);
    for (let index = 0; index < 16; index += 1) {
      const point = offset + index * 4;
      words[index] = ((message[point] << 24) | (message[point + 1] << 16) | (message[point + 2] << 8) | message[point + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotate(words[index - 15], 7) ^ rotate(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotate(words[index - 2], 17) ^ rotate(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choose + constants[index] + words[index]) >>> 0;
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    hash = hash.map((word, index) => (word + [a,b,c,d,e,f,g,h][index]) >>> 0);
  }
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}

function digest(value) { return `sha256:${sha256(canonicalJson(value))}`; }

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function normalizeBinding(value) {
  const binding = exactRecord(value, BINDING_FIELDS, "binding");
  return {
    runId: opaqueRef(binding.runId, "binding.runId"),
    taskFingerprint: digestRef(binding.taskFingerprint, "binding.taskFingerprint"),
    graphDigest: digestRef(binding.graphDigest, "binding.graphDigest"),
    projectionDigest: digestRef(binding.projectionDigest, "binding.projectionDigest"),
    durableCursor: nonNegativeInteger(binding.durableCursor, "binding.durableCursor"),
    headEventHash: digestRef(binding.headEventHash, "binding.headEventHash", { nullable: true }),
    headCheckpointId: opaqueRef(binding.headCheckpointId, "binding.headCheckpointId", { nullable: true }),
    policyDigest: digestRef(binding.policyDigest, "binding.policyDigest"),
    evaluationRevision: nonNegativeInteger(binding.evaluationRevision, "binding.evaluationRevision"),
  };
}

function normalizeAuthoritySnapshot(value) {
  const snapshot = exactRecord(value, AUTHORITY_FIELDS, "authoritySnapshot");
  return {
    source: enumValue(snapshot.source, [AUTHORITY_SOURCE], "authoritySnapshot.source"),
    projectionSchemaVersion: opaqueRef(snapshot.projectionSchemaVersion, "authoritySnapshot.projectionSchemaVersion"),
    runStatus: enumValue(snapshot.runStatus, ["active", "completed", "failed", "blocked"], "authoritySnapshot.runStatus"),
    runId: opaqueRef(snapshot.runId, "authoritySnapshot.runId"),
    taskFingerprint: digestRef(snapshot.taskFingerprint, "authoritySnapshot.taskFingerprint"),
    graphDigest: digestRef(snapshot.graphDigest, "authoritySnapshot.graphDigest"),
    cursor: nonNegativeInteger(snapshot.cursor, "authoritySnapshot.cursor"),
    headEventHash: digestRef(snapshot.headEventHash, "authoritySnapshot.headEventHash", { nullable: true }),
    headCheckpointId: opaqueRef(snapshot.headCheckpointId, "authoritySnapshot.headCheckpointId", { nullable: true }),
    projectionDigest: digestRef(snapshot.projectionDigest, "authoritySnapshot.projectionDigest"),
    eventChainState: enumValue(snapshot.eventChainState, ["verified", "failed", "unknown"], "authoritySnapshot.eventChainState"),
    blockingEffectRefs: sortedUniqueRefs(snapshot.blockingEffectRefs, "authoritySnapshot.blockingEffectRefs"),
    activeClaimRefs: sortedUniqueRefs(snapshot.activeClaimRefs, "authoritySnapshot.activeClaimRefs"),
    bridgeSettlementState: enumValue(snapshot.bridgeSettlementState, ["settled", "failed", "incomplete", "unknown"], "authoritySnapshot.bridgeSettlementState"),
    currentness: enumValue(snapshot.currentness, ["bound_same_bridge_settlement", "active_claim_present", "unresolved_effect_present", "unproven"], "authoritySnapshot.currentness"),
  };
}

function normalizeAssessment(value, name) {
  const assessment = exactRecord(value, ASSESSMENT_FIELDS, name);
  const normalized = {
    state: enumValue(assessment.state, STATE_VALUES[name], `${name}.state`),
    evidenceRefs: sortedUniqueRefs(assessment.evidenceRefs, `${name}.evidenceRefs`),
  };
  const assessmentDigest = digestRef(assessment.assessmentDigest, `${name}.assessmentDigest`);
  if (assessmentDigest !== digest(normalized)) fail(`${name}.assessmentDigest does not match its canonical assessment`);
  return { ...normalized, assessmentDigest };
}

function normalizeControlAssessment(value) {
  const assessment = exactRecord(value, CONTROL_FIELDS, "controlAssessment");
  const state = enumValue(assessment.state, STATE_VALUES.controlAssessment, "controlAssessment.state");
  const controlRef = opaqueRef(assessment.controlRef, "controlAssessment.controlRef", { nullable: true });
  if (["stop_verified", "continue_verified"].includes(state) && controlRef === null) {
    fail("controlAssessment.controlRef is required for verified control");
  }
  if (["none", "unknown"].includes(state) && controlRef !== null) {
    fail("controlAssessment.controlRef must be null without verified control");
  }
  if (["stop_verified", "continue_verified"].includes(state)
    && !/^(?:host-decision|plan-challenge):/u.test(controlRef)) {
    fail("controlAssessment verified control requires a verified host-decision or plan-challenge reference");
  }
  const normalized = {
    state,
    controlRef,
    evidenceRefs: sortedUniqueRefs(assessment.evidenceRefs, "controlAssessment.evidenceRefs"),
  };
  const assessmentDigest = digestRef(assessment.assessmentDigest, "controlAssessment.assessmentDigest");
  if (assessmentDigest !== digest(normalized)) fail("controlAssessment.assessmentDigest does not match its canonical assessment");
  return { ...normalized, assessmentDigest };
}

function normalizeEvidenceTransition(value) {
  const transition = exactRecord(value, EVIDENCE_TRANSITION_FIELDS, "evidenceTransition");
  const normalized = {
    schemaVersion: enumValue(transition.schemaVersion, [EVIDENCE_TRANSITION_SCHEMA_VERSION], "evidenceTransition.schemaVersion"),
    resultDigest: digestRef(transition.resultDigest, "evidenceTransition.resultDigest"),
    bindingDigest: digestRef(transition.bindingDigest, "evidenceTransition.bindingDigest"),
    evaluationStatus: enumValue(transition.evaluationStatus, ["evaluated", "not_evaluated_missing_normalized_input", "not_evaluated_invalid_normalized_input"], "evidenceTransition.evaluationStatus"),
    verdict: enumValue(transition.verdict, ["allowed", "blocked", "in_doubt"], "evidenceTransition.verdict"),
  };
  if (normalized.evaluationStatus !== "evaluated" && normalized.verdict !== "in_doubt") {
    fail("evidenceTransition not-evaluated status must have an in_doubt verdict");
  }
  return normalized;
}

function bindingMatchesAuthority(binding, authority) {
  return binding.runId === authority.runId
    && binding.taskFingerprint === authority.taskFingerprint
    && binding.graphDigest === authority.graphDigest
    && binding.projectionDigest === authority.projectionDigest
    && binding.durableCursor === authority.cursor
    && binding.headEventHash === authority.headEventHash
    && binding.headCheckpointId === authority.headCheckpointId;
}

function collectEvidenceRefs(command) {
  const refs = [
    ...command.authoritySnapshot.blockingEffectRefs,
    ...command.authoritySnapshot.activeClaimRefs,
    ...command.goalAssessment.evidenceRefs,
    ...command.workAssessment.evidenceRefs,
    ...command.evidenceAssessment.evidenceRefs,
    ...command.blockerAssessment.evidenceRefs,
    ...command.humanDecisionAssessment.evidenceRefs,
    ...command.scopeAssessment.evidenceRefs,
    ...command.repeatAssessment.evidenceRefs,
    ...command.controlAssessment.evidenceRefs,
  ];
  if (command.controlAssessment.controlRef !== null) refs.push(command.controlAssessment.controlRef);
  return [...new Set(refs)].sort(canonicalCompare);
}

function orderedReasons(action, selected) {
  const selectedSet = new Set(selected);
  return CONTINUATION_POLICY_SHADOW_REASON_CODES[action].filter((reason) => selectedSet.has(reason));
}

function deriveDisposition(command) {
  const { binding, authoritySnapshot: authority } = command;
  const escalate = [];
  if (!bindingMatchesAuthority(binding, authority)) escalate.push("authority_binding_mismatch");
  if (authority.eventChainState === "failed" || authority.bridgeSettlementState === "failed") escalate.push("projection_integrity_failed");
  if (authority.projectionSchemaVersion !== SUPPORTED_PROJECTION_SCHEMA_VERSION) escalate.push("unsupported_projection_schema");
  if (command.scopeAssessment.state === "outside") escalate.push("required_work_out_of_scope");
  if (command.blockerAssessment.state === "hard") escalate.push("hard_blocker_requires_route_change");
  if (authority.runStatus === "active" && command.goalAssessment.state === "unfinished" && command.workAssessment.state === "none") {
    escalate.push("contradictory_authoritative_signals");
  }
  if (authority.runStatus !== "active" && (authority.activeClaimRefs.length > 0 || authority.currentness === "active_claim_present")) {
    escalate.push("contradictory_authoritative_signals");
  }
  if (escalate.length > 0) return { action: "escalate", reasonCodes: orderedReasons("escalate", escalate) };

  const stop = [];
  if (command.controlAssessment.state === "stop_verified") stop.push("verified_user_stop");
  const cleanAuthoritativeTerminal = ["completed", "failed", "blocked"].includes(authority.runStatus)
    && authority.eventChainState === "verified"
    && authority.bridgeSettlementState === "settled"
    && authority.currentness === "bound_same_bridge_settlement";
  if (cleanAuthoritativeTerminal) stop.push("authoritative_run_terminal");
  if (command.goalAssessment.state === "satisfied") stop.push("all_goals_satisfied", "no_unfinished_goal");
  if (command.repeatAssessment.state === "repeat_only" && command.evidenceAssessment.state === "none_expected") {
    stop.push("repeat_only_no_new_evidence");
  }
  if (stop.length > 0) return { action: "stop", reasonCodes: orderedReasons("stop", stop) };

  const wait = [];
  if (authority.currentness !== "bound_same_bridge_settlement") wait.push("authority_snapshot_currentness_unproven");
  if (authority.activeClaimRefs.length > 0 || authority.currentness === "active_claim_present") wait.push("active_claim_requires_kernel_recheck");
  if (authority.blockingEffectRefs.length > 0 || authority.currentness === "unresolved_effect_present") wait.push("unresolved_effect_present");
  if (authority.bridgeSettlementState !== "settled") wait.push("bridge_settlement_incomplete");
  if (command.humanDecisionAssessment.state === "pending") wait.push("awaiting_human_decision");
  if (command.humanDecisionAssessment.state === "denied") wait.push("human_decision_denied");
  if (command.blockerAssessment.state === "recoverable") wait.push("recoverable_blocker_present");
  if (command.goalAssessment.state === "unknown") wait.push("goal_state_unknown");
  if (command.workAssessment.state === "none") wait.push("no_executable_work_observed");
  if (command.workAssessment.state === "unknown") wait.push("work_state_unknown");
  if (["unknown", "none_expected"].includes(command.evidenceAssessment.state)) wait.push("new_evidence_opportunity_unknown");
  if (command.repeatAssessment.state === "repeat_only") wait.push("new_evidence_opportunity_unknown");
  if (command.evidenceTransition.evaluationStatus !== "evaluated") wait.push("evidence_transition_not_evaluated");
  else if (command.evidenceTransition.verdict === "blocked") wait.push("evidence_transition_blocked");
  else if (command.evidenceTransition.verdict === "in_doubt") wait.push("evidence_transition_in_doubt");
  if (authority.eventChainState !== "verified") wait.push("authority_snapshot_currentness_unproven");
  if (command.blockerAssessment.state === "unknown"
    || command.humanDecisionAssessment.state === "unknown"
    || command.scopeAssessment.state === "unknown"
    || command.repeatAssessment.state === "unknown"
    || command.controlAssessment.state === "unknown") {
    wait.push("authority_snapshot_currentness_unproven");
  }
  if (wait.length > 0) return { action: "wait", reasonCodes: orderedReasons("wait", wait) };

  return {
    action: "continue",
    reasonCodes: [...CONTINUATION_POLICY_SHADOW_REASON_CODES.continue],
  };
}

function normalizeCommand(command) {
  const input = exactRecord(command, COMMAND_FIELDS, "command");
  return {
    binding: normalizeBinding(input.binding),
    authoritySnapshot: normalizeAuthoritySnapshot(input.authoritySnapshot),
    goalAssessment: normalizeAssessment(input.goalAssessment, "goalAssessment"),
    workAssessment: normalizeAssessment(input.workAssessment, "workAssessment"),
    evidenceAssessment: normalizeAssessment(input.evidenceAssessment, "evidenceAssessment"),
    blockerAssessment: normalizeAssessment(input.blockerAssessment, "blockerAssessment"),
    humanDecisionAssessment: normalizeAssessment(input.humanDecisionAssessment, "humanDecisionAssessment"),
    scopeAssessment: normalizeAssessment(input.scopeAssessment, "scopeAssessment"),
    repeatAssessment: normalizeAssessment(input.repeatAssessment, "repeatAssessment"),
    controlAssessment: normalizeControlAssessment(input.controlAssessment),
    evidenceTransition: normalizeEvidenceTransition(input.evidenceTransition),
  };
}

function commandFromResult(result) {
  return Object.fromEntries(COMMAND_FIELDS.map((field) => [field, result[field]]));
}

function validateResultOnlyFields(snapshot) {
  digestRef(snapshot.bindingDigest, "result.bindingDigest");
  const disposition = exactRecord(snapshot.disposition, DISPOSITION_FIELDS, "result.disposition");
  const action = enumValue(disposition.action, CONTINUATION_POLICY_SHADOW_DISPOSITIONS, "result.disposition.action");
  const reasons = denseArray(disposition.reasonCodes, "result.disposition.reasonCodes");
  for (const [index, reason] of reasons.entries()) {
    enumValue(reason, CONTINUATION_POLICY_SHADOW_REASON_CODES[action], `result.disposition.reasonCodes[${index}]`);
  }
  sortedUniqueRefs(disposition.evidenceRefs, "result.disposition.evidenceRefs");

  const intents = denseArray(snapshot.eventIntents, "result.eventIntents");
  if (intents.length !== 1) fail("result.eventIntents must contain exactly one shadow observation");
  const intent = exactRecord(intents[0], EVENT_INTENT_FIELDS, "result.eventIntents[0]");
  enumValue(intent.kind, ["continuation_shadow_observed"], "result.eventIntents[0].kind");
  digestRef(intent.intentDigest, "result.eventIntents[0].intentDigest");
  enumValue(intent.disposition, CONTINUATION_POLICY_SHADOW_DISPOSITIONS, "result.eventIntents[0].disposition");
  digestRef(intent.reasonCodesDigest, "result.eventIntents[0].reasonCodesDigest");
  for (const field of ["persisted", "authoritative", "writeAllowed"]) {
    if (intent[field] !== false) fail(`result.eventIntents[0].${field} must be false`);
  }

  const authorization = exactRecord(snapshot.authorization, AUTHORIZATION_FIELDS, "result.authorization");
  for (const field of AUTHORIZATION_FIELDS) {
    if (authorization[field] !== false) fail(`result.authorization.${field} must be false`);
  }
}

export function evaluateContinuationPolicyShadow(command) {
  const normalized = normalizeCommand(command);
  const bindingDigest = digest(normalized.binding);
  const derived = deriveDisposition(normalized);
  const disposition = {
    action: derived.action,
    reasonCodes: derived.reasonCodes,
    evidenceRefs: collectEvidenceRefs(normalized),
  };
  const reasonCodesDigest = digest(disposition.reasonCodes);
  const eventIntents = [{
    kind: "continuation_shadow_observed",
    intentDigest: digest({ bindingDigest, disposition: disposition.action, reasonCodesDigest }),
    disposition: disposition.action,
    reasonCodesDigest,
    persisted: false,
    authoritative: false,
    writeAllowed: false,
  }];
  const authorization = {
    continuationAuthorized: false,
    executionAllowed: false,
    schedulerDispatchAllowed: false,
    todoMutationAllowed: false,
    authoritativeWriteAllowed: false,
    eventPersistenceAllowed: false,
    durableCursorAdvanceAllowed: false,
    completeNodeAllowed: false,
    runTerminalStatusWriteAllowed: false,
    checkpointMutationAllowed: false,
    leaseMutationAllowed: false,
    fenceMutationAllowed: false,
    legacyGateCutoverAllowed: false,
  };
  return deepFreeze({
    schemaVersion: CONTINUATION_POLICY_SHADOW_SCHEMA_VERSION,
    kind: "continuation_policy_shadow_result",
    ...normalized,
    bindingDigest,
    disposition,
    eventIntents,
    authorization,
  });
}

export function assertValidContinuationPolicyShadowResult(result) {
  const snapshot = exactRecord(result, RESULT_FIELDS, "result");
  if (snapshot.schemaVersion !== CONTINUATION_POLICY_SHADOW_SCHEMA_VERSION
    || snapshot.kind !== "continuation_policy_shadow_result") {
    fail("result schemaVersion or kind is invalid");
  }
  validateResultOnlyFields(snapshot);
  const expected = evaluateContinuationPolicyShadow(commandFromResult(snapshot));
  if (canonicalJson(snapshot) !== canonicalJson(expected)) {
    fail("result does not match its canonical derived shadow evaluation");
  }
  return result;
}
