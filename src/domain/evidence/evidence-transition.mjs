/**
 * Pure shadow evaluator for the M3-A01 evidence-transition vertical.
 *
 * This domain intentionally cannot authorize execution or persist an event.
 * Producer claims and validator assessments are data-only inputs; the domain
 * derives a bounded shadow verdict and non-authoritative event intent from
 * their exact, immutable bindings.
 */

export const EVIDENCE_TRANSITION_SHADOW_SCHEMA_VERSION = "evidence-transition-shadow-v1";
export const EVIDENCE_TRANSITION_SHADOW_VERDICTS = Object.freeze(["allowed", "blocked", "in_doubt"]);

const COMMAND_FIELDS = Object.freeze(["binding", "evidenceClaims", "validatorAssessments", "decisionDependencies", "transitionRequest"]);
const BINDING_FIELDS = Object.freeze(["runId", "taskFingerprint", "graphDigest", "nodeId", "attemptId", "fenceToken", "revision", "policyDigest"]);
const CLAIM_FIELDS = Object.freeze(["claimId", "producerRef", "evidenceType", "subjectRef", "payloadDigest"]);
const ASSESSMENT_FIELDS = Object.freeze(["claimId", "validatorRef", "assessment", "assessmentDigest", "reasonCode"]);
const DECISION_FIELDS = Object.freeze(["decisionId", "revision", "required", "authorityState", "executionAllowed", "evidenceDigest"]);
const TRANSITION_REQUEST_FIELDS = Object.freeze(["proposalId", "fromStage", "toStage", "requiredClaimIds"]);
const RESULT_FIELDS = Object.freeze(["schemaVersion", "kind", "binding", "bindingDigest", "evidenceClaims", "validatorAssessments", "verifiedEvidence", "decisionDependencies", "transitionProposal", "verdict", "eventIntents", "authorization"]);

const ASSESSMENTS = Object.freeze(["verified", "rejected", "in_doubt"]);
const DECISION_AUTHORITY_STATES = Object.freeze(["not_required", "pending", "presented", "host_answer_claimed", "answered_verified", "skipped", "invalidated", "unavailable"]);
const SHA256_REFERENCE_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const OPAQUE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+\-]{0,511}$/u;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,127}$/u;
const MAX_LIST_LENGTH = 256;

function fail(message) { throw new TypeError(`Evidence transition shadow: ${message}`); }

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
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { fail(`${label} must be an inspectable plain own-data record`); }
    if (typeof key !== "string" || descriptor?.enumerable !== true || !("value" in descriptor)) {
      fail(`${label} must contain enumerable string own data properties only`);
    }
    return [key, descriptor.value];
  });
}

function exactRecord(value, fields, label) {
  const entries = ownDataEntries(value, label);
  const values = new Map(entries);
  if (entries.length !== fields.length || entries.some(([key]) => !fields.includes(key))) fail(`${label} must contain exactly the supported fields`);
  for (const field of fields) if (!values.has(field)) fail(`${label}.${field} is required`);
  return Object.fromEntries(fields.map((field) => [field, values.get(field)]));
}

function denseArray(value, label, { min = 0 } = {}) {
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
  if (prototype !== Array.prototype || !lengthDescriptor || !("value" in lengthDescriptor)) fail(`${label} must be a plain dense list`);
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < min || length > MAX_LIST_LENGTH) fail(`${label} length is outside the supported bound`);
  const items = new Map();
  for (const key of keys) {
    if (key === "length") continue;
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { fail(`${label} must be an inspectable dense own-data list`); }
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || descriptor?.enumerable !== true || !("value" in descriptor)) {
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

function opaqueRef(value, label) {
  if (typeof value !== "string" || !OPAQUE_REFERENCE_PATTERN.test(value) || containsSensitiveMaterialMarker(value)) {
    fail(`${label} must be a safe bounded opaque reference`);
  }
  return value;
}

function containsSensitiveMaterialMarker(value) {
  // NFKC handles width/compatibility forms. The small confusable fold covers
  // common Greek/Cyrillic spellings used to smuggle sensitive labels while
  // keeping this pure domain independent of platform-specific Unicode APIs.
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
  // Structured authority references use colon-delimited namespaces. Generic
  // credential heuristics apply only to a single opaque token; provider-
  // specific credential signatures above remain blocked regardless.
  if (value.includes(":") || value.length < 40 || value.length > 512 || !/^[A-Za-z0-9_+.-]+$/u.test(value)) return false;
  const characterClasses = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[_+.-]/u].filter((pattern) => pattern.test(value)).length;
  if (characterClasses < 3) return false;
  const frequencies = new Map();
  for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy >= 4;
}

function digestRef(value, label) {
  if (typeof value !== "string" || !SHA256_REFERENCE_PATTERN.test(value)) fail(`${label} must be a strict sha256 reference`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative safe integer`);
  return value;
}

function booleanValue(value, label) {
  if (typeof value !== "boolean") fail(`${label} must be a boolean`);
  return value;
}

function sortedUniqueRefs(value, label, { min = 0 } = {}) {
  const refs = denseArray(value, label, { min }).map((item, index) => opaqueRef(item, `${label}[${index}]`));
  if (new Set(refs).size !== refs.length) fail(`${label} must not contain duplicates`);
  return refs.sort(canonicalCompare);
}

function canonicalCompare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort(canonicalCompare).map((key) => [key, canonical(value[key])]));
  return value;
}
function canonicalJson(value) { return JSON.stringify(canonical(value)); }

// Pure ECMAScript SHA-256 keeps the domain independent of Node and runtimes.
function sha256(value) {
  const bytes = new TextEncoder().encode(String(value));
  const bitLength = BigInt(bytes.length) * 8n;
  const paddedLength = ((bytes.length + 9 + 63) >> 6) << 6;
  const message = new Uint8Array(paddedLength);
  message.set(bytes); message[bytes.length] = 0x80;
  for (let index = 0; index < 8; index += 1) message[paddedLength - 1 - index] = Number((bitLength >> BigInt(index * 8)) & 0xffn);
  const constants = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  let hash = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const rotate = (word, bits) => (word >>> bits) | (word << (32 - bits));
  for (let offset = 0; offset < message.length; offset += 64) {
    const words = new Uint32Array(64);
    for (let index = 0; index < 16; index += 1) { const point = offset + index * 4; words[index] = ((message[point] << 24) | (message[point + 1] << 16) | (message[point + 2] << 8) | message[point + 3]) >>> 0; }
    for (let index = 16; index < 64; index += 1) { const s0 = rotate(words[index - 15], 7) ^ rotate(words[index - 15], 18) ^ (words[index - 15] >>> 3); const s1 = rotate(words[index - 2], 17) ^ rotate(words[index - 2], 19) ^ (words[index - 2] >>> 10); words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0; }
    let [a,b,c,d,e,f,g,h] = hash;
    for (let index = 0; index < 64; index += 1) { const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25); const choose = (e & f) ^ (~e & g); const t1 = (h + s1 + choose + constants[index] + words[index]) >>> 0; const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22); const majority = (a & b) ^ (a & c) ^ (b & c); const t2 = (s0 + majority) >>> 0; h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0; }
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
    nodeId: opaqueRef(binding.nodeId, "binding.nodeId"),
    attemptId: opaqueRef(binding.attemptId, "binding.attemptId"),
    fenceToken: nonNegativeInteger(binding.fenceToken, "binding.fenceToken"),
    revision: nonNegativeInteger(binding.revision, "binding.revision"),
    policyDigest: digestRef(binding.policyDigest, "binding.policyDigest"),
  };
}

function normalizeClaims(value) {
  const ids = new Set();
  return denseArray(value, "evidenceClaims").map((item, index) => {
    const claim = exactRecord(item, CLAIM_FIELDS, `evidenceClaims[${index}]`);
    const normalized = {
      claimId: opaqueRef(claim.claimId, `evidenceClaims[${index}].claimId`),
      producerRef: opaqueRef(claim.producerRef, `evidenceClaims[${index}].producerRef`),
      evidenceType: opaqueRef(claim.evidenceType, `evidenceClaims[${index}].evidenceType`),
      subjectRef: opaqueRef(claim.subjectRef, `evidenceClaims[${index}].subjectRef`),
      payloadDigest: digestRef(claim.payloadDigest, `evidenceClaims[${index}].payloadDigest`),
    };
    if (ids.has(normalized.claimId)) fail("evidenceClaims must not contain duplicate claimId values");
    ids.add(normalized.claimId);
    return { ...normalized, claimDigest: digest(normalized) };
  }).sort((left, right) => canonicalCompare(left.claimId, right.claimId));
}

function normalizeAssessments(value, claimIds) {
  const pairs = new Set();
  return denseArray(value, "validatorAssessments").map((item, index) => {
    const assessment = exactRecord(item, ASSESSMENT_FIELDS, `validatorAssessments[${index}]`);
    const normalized = {
      claimId: opaqueRef(assessment.claimId, `validatorAssessments[${index}].claimId`),
      validatorRef: opaqueRef(assessment.validatorRef, `validatorAssessments[${index}].validatorRef`),
      assessment: assessment.assessment,
      assessmentDigest: digestRef(assessment.assessmentDigest, `validatorAssessments[${index}].assessmentDigest`),
      reasonCode: assessment.reasonCode,
    };
    if (!claimIds.has(normalized.claimId)) fail("validatorAssessments must refer to an evidence claim");
    if (!ASSESSMENTS.includes(normalized.assessment)) fail("validatorAssessments assessment is unsupported");
    if (typeof normalized.reasonCode !== "string" || !REASON_CODE_PATTERN.test(normalized.reasonCode) || containsSensitiveMaterialMarker(normalized.reasonCode)) {
      fail("validatorAssessments reasonCode is invalid");
    }
    const pair = `${normalized.claimId}\u0000${normalized.validatorRef}`;
    if (pairs.has(pair)) fail("validatorAssessments must not duplicate a claim and validator pair");
    pairs.add(pair);
    return normalized;
  }).sort((left, right) => canonicalCompare(`${left.claimId}\u0000${left.validatorRef}`, `${right.claimId}\u0000${right.validatorRef}`));
}

function normalizeDecisions(value) {
  const ids = new Set();
  return denseArray(value, "decisionDependencies").map((item, index) => {
    const decision = exactRecord(item, DECISION_FIELDS, `decisionDependencies[${index}]`);
    const normalized = {
      decisionId: opaqueRef(decision.decisionId, `decisionDependencies[${index}].decisionId`),
      revision: nonNegativeInteger(decision.revision, `decisionDependencies[${index}].revision`),
      required: booleanValue(decision.required, `decisionDependencies[${index}].required`),
      authorityState: decision.authorityState,
      executionAllowed: booleanValue(decision.executionAllowed, `decisionDependencies[${index}].executionAllowed`),
      evidenceDigest: digestRef(decision.evidenceDigest, `decisionDependencies[${index}].evidenceDigest`),
    };
    if (!DECISION_AUTHORITY_STATES.includes(normalized.authorityState)) fail("decisionDependencies authorityState is unsupported");
    if (normalized.executionAllowed && normalized.authorityState !== "answered_verified") fail("only answered_verified decision authority may claim executionAllowed");
    if (ids.has(normalized.decisionId)) fail("decisionDependencies must not contain duplicate decisionId values");
    ids.add(normalized.decisionId);
    return normalized;
  }).sort((left, right) => canonicalCompare(left.decisionId, right.decisionId));
}

function normalizeTransitionRequest(value) {
  const request = exactRecord(value, TRANSITION_REQUEST_FIELDS, "transitionRequest");
  const fromStage = opaqueRef(request.fromStage, "transitionRequest.fromStage");
  const toStage = opaqueRef(request.toStage, "transitionRequest.toStage");
  if (fromStage === toStage) fail("transitionRequest stages must differ");
  return {
    proposalId: opaqueRef(request.proposalId, "transitionRequest.proposalId"),
    fromStage,
    toStage,
    requiredClaimIds: sortedUniqueRefs(request.requiredClaimIds, "transitionRequest.requiredClaimIds", { min: 1 }),
  };
}

function deriveVerifiedEvidence(claims, assessments) {
  const byClaim = new Map();
  for (const assessment of assessments) {
    const list = byClaim.get(assessment.claimId) ?? [];
    list.push(assessment);
    byClaim.set(assessment.claimId, list);
  }
  return claims.flatMap((claim) => {
    const independent = (byClaim.get(claim.claimId) ?? []).filter((item) => item.validatorRef !== claim.producerRef);
    const verified = independent.filter((item) => item.assessment === "verified");
    const adverse = independent.some((item) => item.assessment !== "verified");
    if (verified.length === 0 || adverse) return [];
    const validatorRefs = verified.map((item) => item.validatorRef).sort(canonicalCompare);
    const assessmentDigests = verified.map((item) => item.assessmentDigest).sort(canonicalCompare);
    const evidenceBinding = { claimId: claim.claimId, claimDigest: claim.claimDigest, validatorRefs, assessmentDigests };
    return [{
      kind: "verified_evidence_shadow",
      ...evidenceBinding,
      evidenceDigest: digest(evidenceBinding),
      truthEstablished: false,
      hostAuthority: false,
      shadowOnly: true,
      authoritative: false,
    }];
  });
}

function deriveVerdict(requiredClaimIds, claims, assessments, verifiedEvidence, decisions) {
  const claimById = new Map(claims.map((claim) => [claim.claimId, claim]));
  const verifiedIds = new Set(verifiedEvidence.map((evidence) => evidence.claimId));
  const independentByClaim = new Map();
  for (const assessment of assessments) {
    const producerRef = claimById.get(assessment.claimId)?.producerRef;
    if (assessment.validatorRef === producerRef) continue;
    const list = independentByClaim.get(assessment.claimId) ?? [];
    list.push(assessment);
    independentByClaim.set(assessment.claimId, list);
  }
  const rejectedClaimIds = requiredClaimIds.filter((claimId) => (independentByClaim.get(claimId) ?? []).some((item) => item.assessment === "rejected"));
  const missingClaimIds = requiredClaimIds.filter((claimId) => !claimById.has(claimId));
  const unassessedClaimIds = requiredClaimIds.filter((claimId) => claimById.has(claimId) && (independentByClaim.get(claimId) ?? []).length === 0);
  const unresolvedClaimIds = requiredClaimIds.filter((claimId) => !verifiedIds.has(claimId) && !rejectedClaimIds.includes(claimId));
  const verifiedClaimIds = requiredClaimIds.filter((claimId) => verifiedIds.has(claimId));
  const blockedDecisionIds = decisions.filter((decision) => decision.required && decision.executionAllowed !== true).map((decision) => decision.decisionId);
  let status;
  const reasonCodes = [];
  if (rejectedClaimIds.length > 0 || missingClaimIds.length > 0 || unassessedClaimIds.length > 0 || blockedDecisionIds.length > 0) {
    status = "blocked";
    if (rejectedClaimIds.length > 0) reasonCodes.push("required_evidence_rejected");
    if (missingClaimIds.length > 0) reasonCodes.push("required_evidence_claim_missing");
    if (unassessedClaimIds.length > 0) reasonCodes.push("required_evidence_unassessed");
    if (blockedDecisionIds.length > 0) reasonCodes.push("required_decision_not_authorized");
  } else if (unresolvedClaimIds.length > 0) {
    status = "in_doubt";
    reasonCodes.push("required_evidence_unresolved");
  } else {
    status = "allowed";
    reasonCodes.push("all_required_shadow_evidence_verified");
  }
  return { status, reasonCodes, verifiedClaimIds, unresolvedClaimIds, rejectedClaimIds, blockedDecisionIds };
}

function commandFromResult(result) {
  return {
    binding: result.binding,
    evidenceClaims: result.evidenceClaims.map(({ claimDigest: _claimDigest, ...claim }) => claim),
    validatorAssessments: result.validatorAssessments,
    decisionDependencies: result.decisionDependencies,
    transitionRequest: {
      proposalId: result.transitionProposal.proposalId,
      fromStage: result.transitionProposal.fromStage,
      toStage: result.transitionProposal.toStage,
      requiredClaimIds: result.transitionProposal.requiredClaimIds,
    },
  };
}

export function evaluateEvidenceTransitionShadow(command) {
  const input = exactRecord(command, COMMAND_FIELDS, "command");
  const binding = normalizeBinding(input.binding);
  const bindingDigest = digest(binding);
  const evidenceClaims = normalizeClaims(input.evidenceClaims);
  const validatorAssessments = normalizeAssessments(input.validatorAssessments, new Set(evidenceClaims.map((claim) => claim.claimId)));
  const decisionDependencies = normalizeDecisions(input.decisionDependencies);
  const transitionRequest = normalizeTransitionRequest(input.transitionRequest);
  const verifiedEvidence = deriveVerifiedEvidence(evidenceClaims, validatorAssessments);
  const proposalBinding = {
    ...transitionRequest,
    bindingDigest,
    evidenceSetDigest: digest({ evidenceClaims, validatorAssessments, verifiedEvidence }),
    decisionSetDigest: digest(decisionDependencies),
    policyDigest: binding.policyDigest,
  };
  const transitionProposal = { ...proposalBinding, proposalDigest: digest(proposalBinding) };
  const verdict = deriveVerdict(transitionRequest.requiredClaimIds, evidenceClaims, validatorAssessments, verifiedEvidence, decisionDependencies);
  const eventBinding = { proposalDigest: transitionProposal.proposalDigest, verdictStatus: verdict.status };
  const eventIntents = [{
    kind: "shadow_verdict_observed",
    intentDigest: digest(eventBinding),
    ...eventBinding,
    persisted: false,
    authoritative: false,
    writeAllowed: false,
  }];
  const authorization = {
    executionAllowed: false,
    authoritativeWriteAllowed: false,
    eventPersistenceAllowed: false,
    completeNodeAllowed: false,
    durableCursorAdvanceAllowed: false,
    schedulerDispatchAllowed: false,
    legacyGateCutoverAllowed: false,
  };
  return deepFreeze({
    schemaVersion: EVIDENCE_TRANSITION_SHADOW_SCHEMA_VERSION,
    kind: "evidence_transition_shadow_result",
    binding,
    bindingDigest,
    evidenceClaims,
    validatorAssessments,
    verifiedEvidence,
    decisionDependencies,
    transitionProposal,
    verdict,
    eventIntents,
    authorization,
  });
}

export function assertValidEvidenceTransitionShadowResult(result) {
  const snapshot = exactRecord(result, RESULT_FIELDS, "result");
  if (snapshot.schemaVersion !== EVIDENCE_TRANSITION_SHADOW_SCHEMA_VERSION || snapshot.kind !== "evidence_transition_shadow_result") fail("result schemaVersion or kind is invalid");
  const expected = evaluateEvidenceTransitionShadow(commandFromResult(snapshot));
  if (canonicalJson(snapshot) !== canonicalJson(expected)) fail("result does not match its canonical derived shadow evaluation");
  return result;
}
