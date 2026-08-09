/**
 * Pure fail-closed native Decision challenge domain.
 *
 * A challenge is a bounded host-return record. It deliberately never permits
 * execution; a later, separately governed layer must make any such decision.
 */

import { assertValidDecision } from "./decision.mjs";

export const NATIVE_DECISION_AUTHORITY_SCHEMA_VERSION = "native-decision-authority-v1";

const STATES = Object.freeze(["issued", "host_answer_claimed", "expired", "invalidated"]);
const CHALLENGE_FIELDS = Object.freeze([
  "schemaVersion", "kind", "state", "challengeRef", "challengeDigest", "decisionId",
  "presentedRevision", "runId", "runtime", "surface", "requestRef", "optionSetDigest",
  "evidenceSetDigest", "presentationDigest", "issuedAt", "expiresAt", "claimedAt", "selectedOptionId",
  "expiredAt", "invalidatedAt", "invalidationReasonRef", "events",
]);
const OPAQUE_REFERENCE_PATTERN = /^(?:[a-z][a-z0-9_-]{1,31}):[a-z0-9][a-z0-9._/-]{0,95}$/u;
const SHA256_REFERENCE_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const DECISION_ID_PATTERN = /^decision-[a-f0-9]{64}$/u;
const SECRETISH_OPAQUE_PAYLOAD = /(?:^|[._/-])(?:secret|token|password|credential|bearer|key|api[._-]?key|access[._-]?key|private[._-]?key|client[._-]?secret|auth(?:orization)?)(?:$|[._/-])|(?:^|[._/-])(?:sk|rk|pk|ghp|gho|ghu|ghs|github_pat|xox[abopr]|akia|aiza|eyj)(?:[._/-]|$)|(?:^|[._/-])(?:sk|rk|pk)-[a-z0-9_-]{8,}(?:$|[._/-])|(?:^|[._/-])(?:ghp|gho|ghu|ghs)_[a-z0-9]{12,}(?:$|[._/-])|(?:^|[._/-])github_pat_[a-z0-9_]{12,}(?:$|[._/-])|(?:^|[._/-])xox[abopr]-[a-z0-9-]{12,}(?:$|[._/-])|(?:^|[._/-])akia[0-9a-z]{16}(?:$|[._/-])|(?:^|[._/-])aiza[a-z0-9_-]{20,}(?:$|[._/-])|(?:^|[._/-])eyj[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}(?:$|[._/-])/u;
// Persistence hygiene only; this is not a complete high-entropy secret detector.
const SENSITIVE_SEMANTIC_PAYLOAD = /(?:raw|prompt|answer|error|stack|trace|secret|password|token|credential|bearer|access|private|clientsecret|apikey|auth(?!ority)|key)/u;
const NATIVE_SURFACES = Object.freeze({
  codex: "request_user_input",
  claude: "AskUserQuestion",
});

function fail(message) { throw new TypeError(`Native Decision authority: ${message}`); }

function plainRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain Object.prototype record`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || descriptor?.enumerable !== true || !("value" in descriptor)) {
      fail(`${label} must contain enumerable string own data properties only`);
    }
  }
  return value;
}

function exactKeys(value, allowed, label) {
  plainRecord(value, label);
  if (Reflect.ownKeys(value).some((key) => !allowed.includes(key))) fail(`${label} contains unsupported fields`);
  for (const key of allowed) if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${label} is missing required fields`);
  return Object.fromEntries(allowed.map((key) => [key, Object.getOwnPropertyDescriptor(value, key).value]));
}

function strictArray(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(`${label} must be a plain Array.prototype list`);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) fail(`${label} must have a data length`);
  const length = lengthDescriptor.value;
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || descriptor?.enumerable !== true || !("value" in descriptor)) {
      fail(`${label} must contain enumerable numeric own data properties only`);
    }
  }
  if (Object.keys(value).length !== length) fail(`${label} must not contain sparse entries`);
  return Array.from({ length }, (_, index) => Object.getOwnPropertyDescriptor(value, String(index)).value);
}

function dataSnapshot(value, label, ancestors = new WeakSet()) {
  if (!value || typeof value !== "object") return value;
  if (ancestors.has(value)) fail(`${label} must not contain cycles`);
  ancestors.add(value);
  let snapshot;
  if (Array.isArray(value)) {
    const items = strictArray(value, label);
    snapshot = items.map((item) => dataSnapshot(item, `${label} item`, ancestors));
  } else {
    plainRecord(value, label);
    snapshot = Object.fromEntries(Reflect.ownKeys(value).map((key) => [key, dataSnapshot(Object.getOwnPropertyDescriptor(value, key).value, `${label} field`, ancestors)]));
  }
  ancestors.delete(value);
  return snapshot;
}

/**
 * Assert that a value is a normalized, bounded opaque reference. Strict
 * `sha256:<64 lowercase hex>` values are the sole digest-shaped exception to
 * secret-payload rejection.
 *
 * @param {unknown} value Candidate opaque reference.
 * @returns {string} The accepted, unchanged reference.
 */
export function assertNativeDecisionOpaqueRef(value) {
  const normalized = typeof value === "string" ? value.normalize("NFKC").trim() : null;
  const payload = normalized?.includes(":") ? normalized.slice(normalized.indexOf(":") + 1) : "";
  const semanticPayload = payload.normalize("NFKC").toLowerCase().replace(/[._/-]+/gu, "");
  if (typeof value !== "string" || value !== normalized || normalized.length > 128 || !OPAQUE_REFERENCE_PATTERN.test(normalized) ||
      (!SHA256_REFERENCE_PATTERN.test(normalized) && (SECRETISH_OPAQUE_PAYLOAD.test(payload) || SENSITIVE_SEMANTIC_PAYLOAD.test(semanticPayload)))) {
    fail("opaque reference must be a bounded lowercase reference or strict digest");
  }
  return normalized;
}

function sha256Reference(value, label) {
  if (typeof value !== "string" || !SHA256_REFERENCE_PATTERN.test(value)) fail(`${label} must be a strict sha256 reference`);
  return value;
}

function decisionId(value, label) {
  if (typeof value !== "string" || !DECISION_ID_PATTERN.test(value)) fail(`${label} must be a Decision identifier`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a canonical ISO-8601 UTC timestamp`);
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) fail(`${label} must be a canonical ISO-8601 UTC timestamp`);
  return { value, epoch };
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative safe integer`);
  return value;
}

function nativeSurface(runtime, surface, label) {
  if (typeof runtime !== "string" || NATIVE_SURFACES[runtime] !== surface) fail(`${label} must be an exact registered native surface`);
  return { runtime, surface };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function canonicalJson(value) { return JSON.stringify(canonical(value)); }

// Pure ECMAScript SHA-256; no runtime or Node capability is imported.
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
    for (let index = 16; index < 64; index += 1) { const s0 = rotate(words[index - 15], 7) ^ rotate(words[index - 15], 18) ^ (words[index - 15] >>> 3); const s1 = rotate(words[index - 2], 17) ^ rotate(words[index - 2], 19) ^ (words[index - 2] >>> 10); words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0; }
    let [a,b,c,d,e,f,g,h] = hash;
    for (let index = 0; index < 64; index += 1) { const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25); const choose = (e & f) ^ (~e & g); const t1 = (h + s1 + choose + constants[index] + words[index]) >>> 0; const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22); const majority = (a & b) ^ (a & c) ^ (b & c); const t2 = (s0 + majority) >>> 0; h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0; }
    hash = hash.map((word, index) => (word + [a,b,c,d,e,f,g,h][index]) >>> 0);
  }
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}

function digestReference(value) { return `sha256:${sha256(canonicalJson(value))}`; }

function decisionPresentationDigest(decision) {
  return digestReference({
    decisionType: decision.decisionType,
    routeChangingDimensions: decision.routeChangingDimensions,
    options: decision.options,
    recommendation: decision.recommendation,
    evidence: decision.evidence,
    requirement: decision.requirement,
    nativeSurface: decision.nativeSurface,
  });
}

function decisionOrFail(decision) {
  try {
    const snapshot = dataSnapshot(decision, "Decision");
    assertValidDecision(snapshot);
    return deepFreeze(snapshot);
  } catch {
    fail("Decision must be valid and contain data properties only");
  }
}

function challengeBinding(challenge) {
  return {
    schemaVersion: challenge.schemaVersion,
    kind: challenge.kind,
    challengeRef: challenge.challengeRef,
    decisionId: challenge.decisionId,
    presentedRevision: challenge.presentedRevision,
    runId: challenge.runId,
    runtime: challenge.runtime,
    surface: challenge.surface,
    requestRef: challenge.requestRef,
    optionSetDigest: challenge.optionSetDigest,
    evidenceSetDigest: challenge.evidenceSetDigest,
    presentationDigest: challenge.presentationDigest,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
  };
}

function challengeEvent(value, index) {
  const initial = plainRecord(value, `events[${index}]`);
  const state = Object.getOwnPropertyDescriptor(initial, "state")?.value;
  if (!STATES.includes(state)) fail("challenge event state is unsupported");
  const expected = state === "host_answer_claimed" ? ["state", "at", "selectedOptionId"] : state === "invalidated" ? ["state", "at", "reasonRef"] : ["state", "at"];
  const event = exactKeys(initial, expected, `events[${index}]`);
  const at = timestamp(event.at, `events[${index}].at`).value;
  if (state === "host_answer_claimed") return { state, at, selectedOptionId: assertNativeDecisionOpaqueRef(event.selectedOptionId) };
  if (state === "invalidated") return { state, at, reasonRef: assertNativeDecisionOpaqueRef(event.reasonRef) };
  return { state, at };
}

function validateHistory(challenge) {
  const sourceEvents = strictArray(challenge.events, "challenge.events");
  if (sourceEvents.length < 1 || sourceEvents.length > 3) fail("challenge must contain a bounded event history");
  const events = sourceEvents.map(challengeEvent);
  if (events[0].state !== "issued" || events[0].at !== challenge.issuedAt) fail("challenge history must begin with issuance");
  const issuedAt = timestamp(challenge.issuedAt, "challenge.issuedAt").epoch;
  const expiresAt = timestamp(challenge.expiresAt, "challenge.expiresAt").epoch;
  let previous = timestamp(events[0].at, "events[0].at").epoch;
  for (let index = 1; index < events.length; index += 1) {
    const current = timestamp(events[index].at, `events[${index}].at`).epoch;
    if (current < previous) fail("challenge history must be chronological");
    if (events[index].state === "host_answer_claimed" && (current < issuedAt || current >= expiresAt)) fail("challenge claim must occur inside its validity window");
    if (events[index].state === "expired" && current < expiresAt) fail("challenge expiry event cannot precede its expiry boundary");
    previous = current;
  }
  const last = events.at(-1);
  if (last.state !== challenge.state) fail("challenge state must match its final history event");
  if (challenge.state === "issued") {
    if (events.length !== 1 || challenge.claimedAt !== null || challenge.selectedOptionId !== null || challenge.expiredAt !== null || challenge.invalidatedAt !== null || challenge.invalidationReasonRef !== null) fail("issued challenge carries terminal data");
  } else if (challenge.state === "host_answer_claimed") {
    if (events.length !== 2 || challenge.claimedAt !== last.at || challenge.selectedOptionId !== last.selectedOptionId || challenge.expiredAt !== null || challenge.invalidatedAt !== null || challenge.invalidationReasonRef !== null) fail("claimed challenge does not match history");
  } else if (challenge.state === "expired") {
    if (events.length !== 2 || challenge.expiredAt !== last.at || challenge.claimedAt !== null || challenge.selectedOptionId !== null || challenge.invalidatedAt !== null || challenge.invalidationReasonRef !== null) fail("expired challenge does not match history");
  } else {
    const claimed = events.find((event) => event.state === "host_answer_claimed");
    if (![2, 3].includes(events.length) || challenge.invalidatedAt !== last.at || challenge.invalidationReasonRef !== last.reasonRef || challenge.expiredAt !== null ||
        (claimed ? (challenge.claimedAt !== claimed.at || challenge.selectedOptionId !== claimed.selectedOptionId) : (challenge.claimedAt !== null || challenge.selectedOptionId !== null))) fail("invalidated challenge does not match history");
  }
  return events;
}

function matchesDecision(challenge, decision, events) {
  if (decision.status !== "presented" || !decision.identity.runId || challenge.decisionId !== decision.decisionId || challenge.presentedRevision !== decision.revision ||
      challenge.runId !== decision.identity.runId || challenge.runtime !== decision.nativeSurface?.runtime || challenge.surface !== decision.nativeSurface?.surface ||
      challenge.optionSetDigest !== digestReference(decision.options) || challenge.evidenceSetDigest !== digestReference(decision.evidence) ||
      challenge.presentationDigest !== decisionPresentationDigest(decision)) {
    fail("challenge does not exactly bind the presented Decision");
  }
  const claimEvent = events.find((event) => event.state === "host_answer_claimed");
  if (claimEvent && (challenge.claimedAt !== claimEvent.at || challenge.selectedOptionId !== claimEvent.selectedOptionId ||
      !decision.options.some((option) => option.optionId === claimEvent.selectedOptionId))) {
    fail("challenge claim does not exactly bind a current Decision option");
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function nextChallenge(challenge, patch, event) {
  const next = {
    ...challenge,
    ...patch,
    events: [...challenge.events, event],
  };
  return assertValidNativeDecisionChallenge(next);
}

/**
 * Issue a frozen challenge only for the exact current presented Decision.
 *
 * @param {object} decision Valid presented Decision domain object.
 * @param {object} input Host binding data.
 * @returns {object} Frozen, non-executable challenge.
 */
export function issueNativeDecisionChallenge(decision, input) {
  const currentDecision = decisionOrFail(decision);
  const command = exactKeys(input, ["runtime", "surface", "challengeRef", "requestRef", "issuedAt", "expiresAt"], "issue input");
  if (currentDecision.status !== "presented" || !currentDecision.identity.runId) fail("challenge issuance requires a presented Decision with run identity");
  const host = nativeSurface(command.runtime, command.surface, "issue input");
  if (host.runtime !== currentDecision.nativeSurface?.runtime || host.surface !== currentDecision.nativeSurface?.surface) fail("challenge surface must match the presented Decision");
  const issued = timestamp(command.issuedAt, "issue input.issuedAt");
  const expires = timestamp(command.expiresAt, "issue input.expiresAt");
  if (issued.epoch < Date.parse(currentDecision.updatedAt) || issued.epoch >= expires.epoch) fail("challenge issuance window is invalid");
  const challenge = {
    schemaVersion: NATIVE_DECISION_AUTHORITY_SCHEMA_VERSION,
    kind: "native_decision_challenge",
    state: "issued",
    challengeRef: assertNativeDecisionOpaqueRef(command.challengeRef),
    challengeDigest: null,
    decisionId: currentDecision.decisionId,
    presentedRevision: currentDecision.revision,
    runId: currentDecision.identity.runId,
    runtime: host.runtime,
    surface: host.surface,
    requestRef: assertNativeDecisionOpaqueRef(command.requestRef),
    optionSetDigest: digestReference(currentDecision.options),
    evidenceSetDigest: digestReference(currentDecision.evidence),
    presentationDigest: decisionPresentationDigest(currentDecision),
    issuedAt: issued.value,
    expiresAt: expires.value,
    claimedAt: null,
    selectedOptionId: null,
    expiredAt: null,
    invalidatedAt: null,
    invalidationReasonRef: null,
    events: [{ state: "issued", at: issued.value }],
  };
  challenge.challengeDigest = digestReference(challengeBinding(challenge));
  return assertValidNativeDecisionChallenge(challenge, currentDecision);
}

/**
 * Validate challenge shape, integrity binding, event history, and optionally
 * its exact presented Decision binding.
 *
 * @param {object} challenge Candidate challenge.
 * @param {object} [decision] Current presented Decision to bind.
 * @returns {object} The validated challenge.
 */
export function assertValidNativeDecisionChallenge(challenge, decision) {
  const source = exactKeys(challenge, CHALLENGE_FIELDS, "challenge");
  if (source.schemaVersion !== NATIVE_DECISION_AUTHORITY_SCHEMA_VERSION || source.kind !== "native_decision_challenge" || !STATES.includes(source.state)) fail("challenge has an unsupported schema, kind, or state");
  const normalized = {
    schemaVersion: source.schemaVersion,
    kind: source.kind,
    state: source.state,
    challengeRef: assertNativeDecisionOpaqueRef(source.challengeRef),
    challengeDigest: sha256Reference(source.challengeDigest, "challenge.challengeDigest"),
    decisionId: decisionId(source.decisionId, "challenge.decisionId"),
    presentedRevision: integer(source.presentedRevision, "challenge.presentedRevision"),
    runId: assertNativeDecisionOpaqueRef(source.runId),
    ...nativeSurface(source.runtime, source.surface, "challenge"),
    requestRef: assertNativeDecisionOpaqueRef(source.requestRef),
    optionSetDigest: sha256Reference(source.optionSetDigest, "challenge.optionSetDigest"),
    evidenceSetDigest: sha256Reference(source.evidenceSetDigest, "challenge.evidenceSetDigest"),
    presentationDigest: sha256Reference(source.presentationDigest, "challenge.presentationDigest"),
    issuedAt: timestamp(source.issuedAt, "challenge.issuedAt"),
    expiresAt: timestamp(source.expiresAt, "challenge.expiresAt"),
  };
  if (normalized.issuedAt.epoch >= normalized.expiresAt.epoch || source.challengeDigest !== digestReference(challengeBinding(source))) fail("challenge binding or expiry window is invalid");
  const normalizedNullable = {};
  for (const field of ["claimedAt", "expiredAt", "invalidatedAt"]) normalizedNullable[field] = source[field] === null ? null : timestamp(source[field], `challenge.${field}`).value;
  for (const field of ["selectedOptionId", "invalidationReasonRef"]) normalizedNullable[field] = source[field] === null ? null : assertNativeDecisionOpaqueRef(source[field]);
  const events = validateHistory(source);
  const snapshot = {
    ...source,
    ...normalized,
    issuedAt: normalized.issuedAt.value,
    expiresAt: normalized.expiresAt.value,
    ...normalizedNullable,
    events,
  };
  if (decision !== undefined) {
    const currentDecision = decisionOrFail(decision);
    matchesDecision(snapshot, currentDecision, events);
  }
  return deepFreeze(snapshot);
}

/**
 * Record one exact host selection against an unexpired issued challenge.
 *
 * @param {object} decision Current presented Decision.
 * @param {object} challenge Issued challenge.
 * @param {object} input Returned host binding and selected option.
 * @returns {object} Frozen claimed challenge; still non-executable.
 */
export function claimNativeDecisionChallenge(decision, challenge, input) {
  const currentDecision = decisionOrFail(decision);
  const currentChallenge = assertValidNativeDecisionChallenge(challenge, currentDecision);
  const command = exactKeys(input, ["runtime", "surface", "challengeRef", "challengeDigest", "decisionId", "presentedRevision", "runId", "requestRef", "optionSetDigest", "evidenceSetDigest", "presentationDigest", "claimedAt", "selectedOptionId"], "claim input");
  if (currentChallenge.state !== "issued" || currentDecision.status !== "presented") fail("challenge is not eligible for a host claim");
  const host = nativeSurface(command.runtime, command.surface, "claim input");
  const claimed = timestamp(command.claimedAt, "claim input.claimedAt");
  if (claimed.epoch < Date.parse(currentChallenge.issuedAt) || claimed.epoch >= Date.parse(currentChallenge.expiresAt) ||
      host.runtime !== currentChallenge.runtime || host.surface !== currentChallenge.surface || command.challengeRef !== currentChallenge.challengeRef || command.challengeDigest !== currentChallenge.challengeDigest ||
      command.decisionId !== currentChallenge.decisionId || command.presentedRevision !== currentChallenge.presentedRevision || command.runId !== currentChallenge.runId || command.requestRef !== currentChallenge.requestRef ||
      command.optionSetDigest !== currentChallenge.optionSetDigest || command.evidenceSetDigest !== currentChallenge.evidenceSetDigest || command.presentationDigest !== currentChallenge.presentationDigest) fail("host claim does not exactly match its challenge binding");
  const selectedOptionId = assertNativeDecisionOpaqueRef(command.selectedOptionId);
  if (!currentDecision.options.some((option) => option.optionId === selectedOptionId)) fail("host claim selected option is not present in the Decision");
  return nextChallenge(currentChallenge, {
    state: "host_answer_claimed",
    claimedAt: claimed.value,
    selectedOptionId,
  }, { state: "host_answer_claimed", at: claimed.value, selectedOptionId });
}

/**
 * Transition an issued challenge to expired at or after its expiry boundary.
 *
 * @param {object} challenge Issued challenge.
 * @param {object} input Expiry timestamp.
 * @returns {object} Frozen expired challenge.
 */
export function expireNativeDecisionChallenge(challenge, input) {
  const currentChallenge = assertValidNativeDecisionChallenge(challenge);
  const command = exactKeys(input, ["at"], "expire input");
  const at = timestamp(command.at, "expire input.at");
  if (currentChallenge.state !== "issued" || at.epoch < Date.parse(currentChallenge.expiresAt)) fail("challenge cannot expire before its expiry boundary");
  return nextChallenge(currentChallenge, { state: "expired", expiredAt: at.value }, { state: "expired", at: at.value });
}

/**
 * Invalidate an issued or claimed challenge once, preserving its history.
 *
 * @param {object} challenge Current non-terminal challenge.
 * @param {object} input Invalidation timestamp and opaque reason reference.
 * @returns {object} Frozen invalidated challenge.
 */
export function invalidateNativeDecisionChallenge(challenge, input) {
  const currentChallenge = assertValidNativeDecisionChallenge(challenge);
  const command = exactKeys(input, ["at", "reasonRef"], "invalidate input");
  const at = timestamp(command.at, "invalidate input.at");
  const reasonRef = assertNativeDecisionOpaqueRef(command.reasonRef);
  if (!["issued", "host_answer_claimed"].includes(currentChallenge.state) || at.epoch < Date.parse(currentChallenge.events.at(-1).at)) fail("challenge invalidation is not a legal single transition");
  return nextChallenge(currentChallenge, {
    state: "invalidated",
    invalidatedAt: at.value,
    invalidationReasonRef: reasonRef,
  }, { state: "invalidated", at: at.value, reasonRef });
}

/**
 * Return the only domain gate supplied by this module. It is permanently
 * fail-closed for every challenge state.
 *
 * @param {object} challenge Valid challenge.
 * @returns {{decisionId: string, presentedRevision: number, state: string, executionAllowed: false, blockedReason: string}}
 */
export function nativeDecisionAuthorityGate(challenge) {
  const currentChallenge = assertValidNativeDecisionChallenge(challenge);
  const blockedReason = currentChallenge.state === "expired" ? "native_decision_challenge_expired" : currentChallenge.state === "invalidated" ? "native_decision_challenge_invalidated" : currentChallenge.state === "host_answer_claimed" ? "native_decision_host_answer_claimed_not_executable" : "native_decision_challenge_not_claimed";
  return Object.freeze({ decisionId: currentChallenge.decisionId, presentedRevision: currentChallenge.presentedRevision, state: currentChallenge.state, executionAllowed: false, blockedReason });
}
