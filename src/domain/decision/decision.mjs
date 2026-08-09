/**
 * Pure, non-authorizing Decision Domain v1.
 *
 * Host returns are represented only as bounded claims. Verified answers and
 * execution authorization deliberately belong to the later authority layer.
 */

export const DECISION_SCHEMA_VERSION = "decision-domain-v1";
export const DECISION_STATUSES = Object.freeze(["pending", "presented", "host_answer_claimed", "skipped", "invalidated"]);
export const ROUTE_CHANGING_DIMENSIONS = Object.freeze(["scope", "risk_or_cost", "owner", "runtime_or_os", "dependency", "acceptance", "permission", "non_goal", "read_only_branch"]);

/** Exact host surfaces allowed to create a non-authorizing claim. */
export const HOST_ANSWER_CLAIM_ADAPTERS = Object.freeze({
  codex_request_user_input: Object.freeze({ runtime: "codex", surface: "request_user_input" }),
  claude_AskUserQuestion: Object.freeze({ runtime: "claude", surface: "AskUserQuestion" }),
});
// Compatibility name for consumers that only need the closed adapter registry.
export const HOST_RECEIPT_ADAPTERS = HOST_ANSWER_CLAIM_ADAPTERS;

const LEGAL_TRANSITIONS = Object.freeze({
  pending: new Set(["presented", "skipped", "invalidated"]),
  presented: new Set(["host_answer_claimed", "skipped", "invalidated"]),
  host_answer_claimed: new Set(["invalidated"]),
  skipped: new Set(["invalidated"]),
  invalidated: new Set(),
});
const OPAQUE_REFERENCE_PATTERN = /^(?:[a-z][a-z0-9_-]{1,31}):[a-z0-9][a-z0-9._/-]{0,95}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SHA256_REFERENCE_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SECRETISH_OPAQUE_PAYLOAD = /(?:^|[._/-])(?:secret|token|password|credential|bearer|key|api[._-]?key|access[._-]?key|private[._-]?key|client[._-]?secret|auth(?:orization)?)(?:$|[._/-])|(?:^|[._/-])(?:sk|rk|pk|ghp|gho|ghu|ghs|github_pat|xox[abopr]|akia|aiza|eyj)(?:[._/-]|$)|(?:^|[._/-])(?:sk|rk|pk)-[a-z0-9_-]{8,}(?:$|[._/-])|(?:^|[._/-])(?:ghp|gho|ghu|ghs)_[a-z0-9]{12,}(?:$|[._/-])|(?:^|[._/-])github_pat_[a-z0-9_]{12,}(?:$|[._/-])|(?:^|[._/-])xox[abopr]-[a-z0-9-]{12,}(?:$|[._/-])|(?:^|[._/-])akia[0-9a-z]{16}(?:$|[._/-])|(?:^|[._/-])aiza[a-z0-9_-]{20,}(?:$|[._/-])|(?:^|[._/-])eyj[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}(?:$|[._/-])/u;
const IDENTITY_FIELDS = Object.freeze(["runId", "taskFingerprint", "decisionKey", "scopeRef"]);
const DECISION_FIELDS = Object.freeze(["schemaVersion", "decisionId", "decisionType", "identity", "status", "routeChangingDimensions", "options", "recommendation", "evidence", "requirement", "nativeSurface", "hostAnswerClaim", "invalidation", "revision", "createdAt", "updatedAt", "events"]);
const CREATE_FIELDS = Object.freeze(["identity", "decisionType", "routeChangingDimensions", "options", "recommendation", "evidence", "requirement", "nativeSurface", "createdAt"]);
const CLAIM_FIELDS = Object.freeze(["kind", "source", "runtime", "surface", "decisionId", "revision", "requestRef", "claimRef", "optionSetDigest", "evidenceSetDigest", "issuedAt", "expiresAt", "claimedAt", "selectedOptionId", "answerDigest"]);

function fail(message) { throw new TypeError(`Decision domain: ${message}`); }
function hasOwn(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain Object.prototype record`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || Object.getOwnPropertyDescriptor(value, key)?.enumerable !== true) {
      fail(`${label} must contain enumerable string own keys only`);
    }
  }
  return value;
}

function exactKeys(value, allowed, label) {
  plainObject(value, label);
  for (const key of Reflect.ownKeys(value)) if (!allowed.includes(key)) fail(`${label}.${key} is not supported`);
}

function opaqueReference(value, label) {
  if (typeof value !== "string") fail(`${label} must be a bounded lowercase opaque reference or digest`);
  const normalized = value.normalize("NFKC").trim();
  const payload = normalized.includes(":") ? normalized.slice(normalized.indexOf(":") + 1) : "";
  if (value !== normalized || normalized.length > 128 || !OPAQUE_REFERENCE_PATTERN.test(normalized) ||
      (!SHA256_REFERENCE_PATTERN.test(normalized) && SECRETISH_OPAQUE_PAYLOAD.test(payload))) {
    fail(`${label} must be a bounded lowercase opaque reference or digest`);
  }
  return normalized;
}

function timestamp(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a canonical ISO-8601 UTC timestamp`);
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) fail(`${label} must be a canonical ISO-8601 UTC timestamp`);
  return { value, epoch };
}

function canonicalCompare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort(canonicalCompare).map((key) => [key, canonicalize(value[key])]));
  return value;
}
function canonicalJson(value) { return JSON.stringify(canonicalize(value)); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

// Pure ECMAScript SHA-256: deterministic bindings without a Node/runtime import.
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
    for (let index = 0; index < 16; index += 1) { const p = offset + index * 4; words[index] = ((message[p] << 24) | (message[p + 1] << 16) | (message[p + 2] << 8) | message[p + 3]) >>> 0; }
    for (let index = 16; index < 64; index += 1) { const s0 = rotate(words[index - 15],7)^rotate(words[index - 15],18)^(words[index - 15]>>>3); const s1 = rotate(words[index - 2],17)^rotate(words[index - 2],19)^(words[index - 2]>>>10); words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0; }
    let [a,b,c,d,e,f,g,h] = hash;
    for (let index = 0; index < 64; index += 1) { const s1 = rotate(e,6)^rotate(e,11)^rotate(e,25); const choose = (e&f)^(~e&g); const t1 = (h+s1+choose+constants[index]+words[index])>>>0; const s0 = rotate(a,2)^rotate(a,13)^rotate(a,22); const majority = (a&b)^(a&c)^(b&c); const t2 = (s0+majority)>>>0; h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0; }
    hash = hash.map((word, index) => (word + [a,b,c,d,e,f,g,h][index]) >>> 0);
  }
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}
function digest(value) { return sha256(canonicalJson(value)); }

function normalizeArray(value, label, { min = 0, allowed = null } = {}) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const normalized = [...new Set(value.map((item, index) => opaqueReference(item, `${label}[${index}]`)))].sort(canonicalCompare);
  if (normalized.length < min) fail(`${label} must contain at least ${min} item(s)`);
  if (allowed && normalized.some((item) => !allowed.includes(item))) fail(`${label} contains an unsupported value`);
  return normalized;
}

function normalizeEnumArray(value, label, allowed, { min = 0 } = {}) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const normalized = [...new Set(value.map((item, index) => {
    if (typeof item !== "string" || !allowed.includes(item)) fail(`${label}[${index}] is unsupported`);
    return item;
  }))].sort(canonicalCompare);
  if (normalized.length < min) fail(`${label} must contain at least ${min} item(s)`);
  return normalized;
}

function normalizeIdentity(value) {
  exactKeys(value, IDENTITY_FIELDS, "identity");
  const normalized = Object.fromEntries(IDENTITY_FIELDS.filter((key) => value[key] != null).map((key) => [key, opaqueReference(value[key], `identity.${key}`)]));
  if (Object.keys(normalized).length === 0) fail("identity requires at least one opaque reference");
  return normalized;
}

function normalizeEvidence(value) {
  if (!Array.isArray(value)) fail("evidence must be an array");
  const references = new Set();
  const normalized = value.map((item, index) => {
    exactKeys(item, ["evidenceRef", "digest"], `evidence[${index}]`);
    const evidenceRef = opaqueReference(item.evidenceRef, `evidence[${index}].evidenceRef`);
    if (references.has(evidenceRef)) fail(`evidence contains duplicate reference ${evidenceRef}`);
    references.add(evidenceRef);
    return { evidenceRef, digest: opaqueReference(item.digest, `evidence[${index}].digest`) };
  });
  return normalized.sort((left, right) => canonicalCompare(left.evidenceRef, right.evidenceRef));
}

function normalizeOptions(value, evidenceRefs) {
  if (!Array.isArray(value) || value.length < 2) fail("options must contain at least two options");
  const ids = new Set();
  const normalized = value.map((item, index) => {
    exactKeys(item, ["optionId", "displayRef", "tradeoffRefs", "evidenceRefs"], `options[${index}]`);
    const optionId = opaqueReference(item.optionId, `options[${index}].optionId`);
    if (ids.has(optionId)) fail(`options contains duplicate optionId ${optionId}`);
    ids.add(optionId);
    const refs = normalizeArray(item.evidenceRefs, `options[${index}].evidenceRefs`);
    if (refs.some((ref) => !evidenceRefs.has(ref))) fail(`options[${index}].evidenceRefs must refer to evidence`);
    return { optionId, displayRef: opaqueReference(item.displayRef, `options[${index}].displayRef`), tradeoffRefs: normalizeArray(item.tradeoffRefs, `options[${index}].tradeoffRefs`, { min: 1 }), evidenceRefs: refs };
  });
  return normalized.sort((left, right) => canonicalCompare(left.optionId, right.optionId));
}

function normalizeRequirement(value, evidenceRefs) {
  exactKeys(value, ["required", "reasonRef", "evidenceRefs"], "requirement");
  if (typeof value.required !== "boolean") fail("requirement.required must be a boolean");
  const refs = normalizeArray(value.evidenceRefs, "requirement.evidenceRefs");
  if (refs.some((ref) => !evidenceRefs.has(ref))) fail("requirement.evidenceRefs must refer to evidence");
  return { required: value.required, reasonRef: opaqueReference(value.reasonRef, "requirement.reasonRef"), evidenceRefs: refs };
}

function normalizeRecommendation(value, optionIds, evidenceRefs) {
  if (value == null) return null;
  exactKeys(value, ["optionId", "rationaleRef", "evidenceRefs"], "recommendation");
  const optionId = opaqueReference(value.optionId, "recommendation.optionId");
  if (!optionIds.has(optionId)) fail("recommendation.optionId must refer to an option");
  const refs = normalizeArray(value.evidenceRefs, "recommendation.evidenceRefs", { min: 1 });
  if (refs.some((ref) => !evidenceRefs.has(ref))) fail("recommendation.evidenceRefs must refer to evidence");
  return { optionId, rationaleRef: opaqueReference(value.rationaleRef, "recommendation.rationaleRef"), evidenceRefs: refs };
}

function normalizeNativeSurface(value) {
  if (value == null) return null;
  exactKeys(value, ["runtime", "surface", "primary"], "nativeSurface");
  if (typeof value.primary !== "boolean") fail("nativeSurface.primary must be a boolean");
  if (typeof value.runtime !== "string" || typeof value.surface !== "string" ||
      !Object.values(HOST_ANSWER_CLAIM_ADAPTERS).some((adapterValue) => adapterValue.runtime === value.runtime && adapterValue.surface === value.surface)) {
    fail("nativeSurface must be an exact registered host surface");
  }
  return { runtime: value.runtime, surface: value.surface, primary: value.primary };
}

function optionSetDigest(decision) { return digest(decision.options); }
function evidenceSetDigest(decision) { return digest(decision.evidence); }
function adapter(source) {
  if (typeof source !== "string" || !hasOwn(HOST_ANSWER_CLAIM_ADAPTERS, source)) fail("claim.source must be an exact registered host adapter");
  return { source, ...HOST_ANSWER_CLAIM_ADAPTERS[source] };
}

function normalizeClaim(value, decision, { expectedRevision, claimedAt, presentedAt } = {}) {
  exactKeys(value, CLAIM_FIELDS, "hostAnswerClaim");
  if (value.kind !== "host_answer_claimed") fail("hostAnswerClaim.kind must be host_answer_claimed");
  const host = adapter(value.source);
  if (value.runtime !== host.runtime || value.surface !== host.surface) fail("claim runtime and surface must match its registry adapter");
  if (decision.nativeSurface && (host.runtime !== decision.nativeSurface.runtime || host.surface !== decision.nativeSurface.surface)) fail("claim adapter must match the decision native surface");
  if (value.decisionId !== decision.decisionId || value.revision !== expectedRevision) fail("claim must bind the presented decision identity and revision");
  if (value.optionSetDigest !== optionSetDigest(decision) || value.evidenceSetDigest !== evidenceSetDigest(decision)) fail("claim must bind the current option and evidence digests");
  const issued = timestamp(value.issuedAt, "hostAnswerClaim.issuedAt");
  const expires = timestamp(value.expiresAt, "hostAnswerClaim.expiresAt");
  const claimed = timestamp(value.claimedAt, "hostAnswerClaim.claimedAt");
  if (issued.epoch >= expires.epoch || claimed.epoch < issued.epoch || claimed.epoch > expires.epoch) fail("claim is outside its issued window");
  if (presentedAt && issued.epoch < timestamp(presentedAt, "presentedAt").epoch) fail("claim predates presentation");
  if (claimedAt && claimed.value !== claimedAt) fail("claim timestamp must equal its transition timestamp");
  const selectedOptionId = opaqueReference(value.selectedOptionId, "hostAnswerClaim.selectedOptionId");
  if (!decision.options.some((option) => option.optionId === selectedOptionId)) fail("claim selectedOptionId must refer to an option");
  return { kind: "host_answer_claimed", source: host.source, runtime: host.runtime, surface: host.surface, decisionId: decision.decisionId, revision: expectedRevision, requestRef: opaqueReference(value.requestRef, "hostAnswerClaim.requestRef"), claimRef: opaqueReference(value.claimRef, "hostAnswerClaim.claimRef"), optionSetDigest: optionSetDigest(decision), evidenceSetDigest: evidenceSetDigest(decision), issuedAt: issued.value, expiresAt: expires.value, claimedAt: claimed.value, selectedOptionId, answerDigest: opaqueReference(value.answerDigest, "hostAnswerClaim.answerDigest") };
}

function normalizeEvent(value, index) {
  exactKeys(value, ["type", "at", "reasonRef", "changed"], `events[${index}]`);
  const type = value.type;
  if (!["created", "presented", "host_answer_claimed", "skipped", "invalidated"].includes(type)) fail(`events[${index}].type is unsupported`);
  const at = timestamp(value.at, `events[${index}].at`).value;
  if (["created", "presented", "host_answer_claimed"].includes(type)) {
    if (hasOwn(value, "reasonRef") || hasOwn(value, "changed")) fail(`events[${index}] cannot carry metadata`);
    return { type, at };
  }
  if (!hasOwn(value, "reasonRef")) fail(`events[${index}].reasonRef is required`);
  const reasonRef = opaqueReference(value.reasonRef, `events[${index}].reasonRef`);
  if (type === "skipped") { if (hasOwn(value, "changed")) fail(`events[${index}].changed is only valid for invalidation`); return { type, at, reasonRef }; }
  if (!hasOwn(value, "changed")) fail(`events[${index}].changed is required`);
  return { type, at, reasonRef, changed: normalizeEnumArray(value.changed, `events[${index}].changed`, ["options", "evidence"], { min: 1 }) };
}

function validateHistory(decision) {
  if (!Array.isArray(decision.events) || decision.events.length === 0) fail("decision.events must contain history");
  const events = decision.events.map(normalizeEvent);
  if (events[0].type !== "created" || events[0].at !== timestamp(decision.createdAt, "decision.createdAt").value) fail("history must begin with the created timestamp");
  let status = "pending"; let previous = timestamp(events[0].at, "events[0].at").epoch; let presentedAt = null; let claimIndex = null;
  for (let index = 1; index < events.length; index += 1) {
    const event = events[index]; const current = timestamp(event.at, `events[${index}].at`).epoch;
    if (current < previous || !isLegalDecisionTransition(status, event.type)) fail("decision history is not chronological and legal");
    previous = current; status = event.type;
    if (event.type === "presented") presentedAt = event.at;
    if (event.type === "host_answer_claimed") claimIndex = index;
  }
  if (decision.revision !== events.length - 1 || decision.status !== status || timestamp(decision.updatedAt, "decision.updatedAt").value !== events.at(-1).at) fail("decision revision, status, and update timestamp must match history");
  return { events, presentedAt, claimIndex };
}

function normalizeInvalidation(value, event) {
  exactKeys(value, ["at", "reasonRef", "changed", "nextOptionsDigest", "nextEvidenceDigest"], "invalidation");
  const normalized = { at: timestamp(value.at, "invalidation.at").value, reasonRef: opaqueReference(value.reasonRef, "invalidation.reasonRef"), changed: normalizeEnumArray(value.changed, "invalidation.changed", ["options", "evidence"], { min: 1 }), nextOptionsDigest: value.nextOptionsDigest, nextEvidenceDigest: value.nextEvidenceDigest };
  if (!SHA256_PATTERN.test(normalized.nextOptionsDigest) || !SHA256_PATTERN.test(normalized.nextEvidenceDigest)) fail("invalidation digests must be SHA-256 hex");
  if (!event || normalized.at !== event.at || normalized.reasonRef !== event.reasonRef || canonicalJson(normalized.changed) !== canonicalJson(event.changed)) fail("invalidation must match its event");
  return normalized;
}

function normalizeMaterialInputs(decision, input) {
  const evidence = normalizeEvidence(input.evidence ?? decision.evidence);
  return { evidence, options: normalizeOptions(input.options ?? decision.options, new Set(evidence.map((item) => item.evidenceRef))) };
}

export function deriveDecisionId({ identity, decisionType = "decision:route-choice" } = {}) {
  const normalizedIdentity = normalizeIdentity(identity);
  return `decision-${digest({ schemaVersion: DECISION_SCHEMA_VERSION, decisionType: opaqueReference(decisionType, "decisionType"), identity: normalizedIdentity })}`;
}

export function createDecision(input = {}) {
  exactKeys(input, CREATE_FIELDS, "createDecision input");
  const identity = normalizeIdentity(input.identity);
  const decisionType = opaqueReference(input.decisionType ?? "decision:route-choice", "decisionType");
  const dimensions = normalizeEnumArray(input.routeChangingDimensions, "routeChangingDimensions", ROUTE_CHANGING_DIMENSIONS, { min: 1 });
  const evidence = normalizeEvidence(input.evidence); const evidenceRefs = new Set(evidence.map((item) => item.evidenceRef));
  const options = normalizeOptions(input.options, evidenceRefs);
  const requirement = normalizeRequirement(input.requirement, evidenceRefs);
  const recommendation = normalizeRecommendation(input.recommendation ?? null, new Set(options.map((option) => option.optionId)), evidenceRefs);
  const nativeSurface = normalizeNativeSurface(input.nativeSurface ?? null);
  const createdAt = timestamp(input.createdAt, "createdAt").value;
  return { schemaVersion: DECISION_SCHEMA_VERSION, decisionId: deriveDecisionId({ identity, decisionType }), decisionType, identity, status: "pending", routeChangingDimensions: dimensions, options, recommendation, evidence, requirement, nativeSurface, hostAnswerClaim: null, invalidation: null, revision: 0, createdAt, updatedAt: createdAt, events: [{ type: "created", at: createdAt }] };
}

export function isLegalDecisionTransition(fromStatus, toStatus) { return LEGAL_TRANSITIONS[fromStatus]?.has(toStatus) === true; }

export function assertValidDecision(decision) {
  exactKeys(decision, DECISION_FIELDS, "decision");
  if (decision.schemaVersion !== DECISION_SCHEMA_VERSION || !DECISION_STATUSES.includes(decision.status) || !Number.isInteger(decision.revision) || decision.revision < 0) fail("decision has an invalid schema version, status, or revision");
  const identity = normalizeIdentity(decision.identity); const decisionType = opaqueReference(decision.decisionType, "decision.decisionType");
  if (decision.decisionId !== deriveDecisionId({ identity, decisionType })) fail("decisionId does not match identity");
  const dimensions = normalizeEnumArray(decision.routeChangingDimensions, "decision.routeChangingDimensions", ROUTE_CHANGING_DIMENSIONS, { min: 1 });
  const evidence = normalizeEvidence(decision.evidence); const evidenceRefs = new Set(evidence.map((item) => item.evidenceRef)); const options = normalizeOptions(decision.options, evidenceRefs); const requirement = normalizeRequirement(decision.requirement, evidenceRefs); const recommendation = normalizeRecommendation(decision.recommendation, new Set(options.map((option) => option.optionId)), evidenceRefs); const nativeSurface = normalizeNativeSurface(decision.nativeSurface);
  if (canonicalJson({ dimensions, evidence, options, requirement, recommendation, nativeSurface }) !== canonicalJson({ dimensions: decision.routeChangingDimensions, evidence: decision.evidence, options: decision.options, requirement: decision.requirement, recommendation: decision.recommendation, nativeSurface: decision.nativeSurface })) fail("decision values must be canonical");
  const history = validateHistory(decision);
  if (history.claimIndex == null && decision.hostAnswerClaim !== null) fail("only claimed history may retain a host answer claim");
  if (history.claimIndex != null && !decision.hostAnswerClaim) fail("claim history requires a host answer claim");
  if (decision.hostAnswerClaim) normalizeClaim(decision.hostAnswerClaim, decision, { expectedRevision: history.claimIndex - 1, claimedAt: history.events[history.claimIndex].at, presentedAt: history.presentedAt });
  const invalidationEvent = history.events.find((event) => event.type === "invalidated");
  if (decision.status === "invalidated") { if (!decision.invalidation) fail("invalidated decisions require details"); normalizeInvalidation(decision.invalidation, invalidationEvent); } else if (decision.invalidation !== null) fail("only invalidated decisions may retain invalidation details");
  if (decision.status === "skipped" && requirement.required) fail("required decisions cannot be skipped");
  return decision;
}

function action(value, keys, label) { exactKeys(value, keys, label); return value; }

export function buildHostAnswerClaim(decision, input = {}) {
  assertValidDecision(decision); if (decision.status !== "presented") fail("claims require a presented decision");
  action(input, ["source", "requestRef", "claimRef", "issuedAt", "expiresAt", "claimedAt", "selectedOptionId", "answerDigest"], "buildHostAnswerClaim input");
  const host = adapter(input.source);
  if (decision.nativeSurface && (host.runtime !== decision.nativeSurface.runtime || host.surface !== decision.nativeSurface.surface)) fail("claim adapter must match native surface");
  const issued = timestamp(input.issuedAt, "issuedAt"); const expires = timestamp(input.expiresAt, "expiresAt"); const claimed = timestamp(input.claimedAt, "claimedAt");
  if (issued.epoch < timestamp(decision.updatedAt, "decision.updatedAt").epoch || issued.epoch >= expires.epoch || claimed.epoch < issued.epoch || claimed.epoch > expires.epoch) fail("claim timing is invalid");
  const selectedOptionId = opaqueReference(input.selectedOptionId, "selectedOptionId"); if (!decision.options.some((option) => option.optionId === selectedOptionId)) fail("selectedOptionId must refer to an option");
  return Object.freeze({ kind: "host_answer_claimed", source: host.source, runtime: host.runtime, surface: host.surface, decisionId: decision.decisionId, revision: decision.revision, requestRef: opaqueReference(input.requestRef, "requestRef"), claimRef: opaqueReference(input.claimRef, "claimRef"), optionSetDigest: optionSetDigest(decision), evidenceSetDigest: evidenceSetDigest(decision), issuedAt: issued.value, expiresAt: expires.value, claimedAt: claimed.value, selectedOptionId, answerDigest: opaqueReference(input.answerDigest, "answerDigest") });
}

export function claimHostAnswer(decision, input = {}) {
  assertValidDecision(decision); action(input, ["at", "claim"], "claimHostAnswer input");
  const at = timestamp(input.at, "at").value;
  if (!isLegalDecisionTransition(decision.status, "host_answer_claimed")) fail(`illegal transition ${decision.status} -> host_answer_claimed`);
  const next = clone(decision); next.status = "host_answer_claimed"; next.updatedAt = at; next.revision += 1; next.hostAnswerClaim = normalizeClaim(input.claim, decision, { expectedRevision: decision.revision, claimedAt: at, presentedAt: decision.updatedAt }); next.events.push({ type: "host_answer_claimed", at }); assertValidDecision(next); return next;
}

export function transitionDecision(decision, input = {}) {
  assertValidDecision(decision); action(input, ["toStatus", "at", "reasonRef"], "transitionDecision input");
  const toStatus = input.toStatus; const at = timestamp(input.at, "at").value;
  if (!isLegalDecisionTransition(decision.status, toStatus) || toStatus === "host_answer_claimed") fail("transition is illegal or requires claimHostAnswer");
  if (toStatus === "skipped") { if (decision.requirement.required) fail("required decisions cannot be skipped"); opaqueReference(input.reasonRef, "reasonRef"); }
  const next = clone(decision); next.status = toStatus; next.updatedAt = at; next.revision += 1; next.events.push(toStatus === "skipped" ? { type: toStatus, at, reasonRef: opaqueReference(input.reasonRef, "reasonRef") } : { type: toStatus, at }); assertValidDecision(next); return next;
}

export function presentDecision(decision, input = {}) { action(input, ["at"], "presentDecision input"); return transitionDecision(decision, { toStatus: "presented", at: input.at }); }
export function skipDecision(decision, input = {}) { action(input, ["at", "reasonRef"], "skipDecision input"); return transitionDecision(decision, { toStatus: "skipped", at: input.at, reasonRef: input.reasonRef }); }

export function materialDecisionChanges(decision, input = {}) {
  assertValidDecision(decision); action(input, ["options", "evidence"], "materialDecisionChanges input");
  const proposed = normalizeMaterialInputs(decision, input); const changed = [];
  if (canonicalJson(proposed.options) !== canonicalJson(decision.options)) changed.push("options"); if (canonicalJson(proposed.evidence) !== canonicalJson(decision.evidence)) changed.push("evidence"); return changed;
}

export function invalidateDecision(decision, input = {}) {
  assertValidDecision(decision); action(input, ["at", "reasonRef", "options", "evidence"], "invalidateDecision input");
  const at = timestamp(input.at, "at").value; const reasonRef = opaqueReference(input.reasonRef, "reasonRef"); const proposed = normalizeMaterialInputs(decision, input); const changed = materialDecisionChanges(decision, proposed);
  if (changed.length === 0 || !isLegalDecisionTransition(decision.status, "invalidated")) fail("invalidation requires material change and a legal transition");
  const next = clone(decision); next.status = "invalidated"; next.updatedAt = at; next.revision += 1; next.invalidation = { at, reasonRef, changed, nextOptionsDigest: digest(proposed.options), nextEvidenceDigest: digest(proposed.evidence) }; next.events.push({ type: "invalidated", at, reasonRef, changed }); assertValidDecision(next); return next;
}

export function claimEvidenceTier(decision) { assertValidDecision(decision); return decision.status === "host_answer_claimed" && decision.hostAnswerClaim ? "host_answer_claimed" : "none"; }

/** v1 is intentionally non-authorizing: only M3-P2 may produce executionAllowed=true. */
export function decisionExecutionGate(decision) {
  assertValidDecision(decision);
  return { decisionId: decision.decisionId, required: decision.requirement.required, status: decision.status, executionAllowed: false, evidenceTier: claimEvidenceTier(decision), blockedReason: decision.status === "invalidated" ? "decision_invalidated_by_material_change" : decision.status === "host_answer_claimed" ? "host_answer_claimed_not_verified" : "decision_authority_not_verified" };
}
