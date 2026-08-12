/**
 * Pure, fail-closed substrate record for a claimed native host answer lifecycle.
 *
 * This module binds a presented Decision and its native challenge to the exact
 * host request/connection references supplied by a runtime adapter. These
 * references and time-source claims are structurally bound, not authenticated
 * here. Observing or consuming a host return remains a non-authorizing audit
 * claim: this domain exposes no verified-answer state and grants no permission.
 * A runtime adapter must construct claims from already parsed connection
 * bytes; arbitrary caller objects (including proxies) never become host proof.
 */

import { assertValidDecision } from "./decision.mjs";
import {
  assertNativeDecisionOpaqueRef,
  assertValidNativeDecisionChallenge,
} from "./native-decision-authority.mjs";

export const NATIVE_HOST_ANSWER_SUBSTRATE_SCHEMA_VERSION = "native-host-answer-substrate-v1";
export const NATIVE_HOST_ANSWER_SUBSTRATE_STATES = Object.freeze([
  "presented",
  "host_return_observed",
  "consumed",
  "expired",
  "invalidated",
]);

const SUBSTRATE_FIELDS = Object.freeze([
  "schemaVersion", "kind", "state", "revision", "substrateRef", "substrateDigest",
  "decisionId", "presentedRevision", "runId", "challengeRef", "challengeDigest",
  "runtime", "surface", "hostEventClaimRef", "hostEventClaimDigest", "renderedHostPayloadDigest", "hostConnectionRef",
  "sessionOrThreadRef", "turnRef", "itemRef", "toolUseOrRequestRef",
  "issuedAt", "expiresAt", "presentationTimeSourceClaimRef", "hostReturnObservedClaimDigest",
  "observedAt", "observationTimeSourceClaimRef", "consumedAt",
  "consumptionTimeSourceClaimRef", "consumerRef", "expiredAt", "expiryTimeSourceClaimRef",
  "invalidatedAt", "invalidationTimeSourceClaimRef", "invalidationReasonRef", "events",
]);
const PRESENT_FIELDS = Object.freeze([
  "substrateRef", "runtime", "surface", "hostEventClaimRef", "renderedHostPayloadDigest", "hostConnectionRef",
  "sessionOrThreadRef", "turnRef", "itemRef", "toolUseOrRequestRef", "issuedAt",
  "expiresAt", "timeSourceClaimRef",
]);
const OBSERVE_FIELDS = Object.freeze([
  "substrateRef", "substrateDigest", "decisionId", "presentedRevision", "runId",
  "challengeRef", "challengeDigest", "runtime", "surface", "hostEventClaimRef", "hostEventClaimDigest", "renderedHostPayloadDigest",
  "hostConnectionRef", "sessionOrThreadRef", "turnRef", "itemRef",
  "toolUseOrRequestRef", "issuedAt", "expiresAt", "at", "timeSourceClaimRef",
  "hostReturnObservedClaimDigest",
]);
const NATIVE_SURFACES = Object.freeze({ codex: "request_user_input", claude: "AskUserQuestion" });
const SHA256_REFERENCE_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const DECISION_ID_PATTERN = /^decision-[a-f0-9]{64}$/u;

function fail(message) { throw new TypeError(`Native host answer substrate: ${message}`); }

function recordEntries(value, label) {
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
  const entries = [];
  for (const key of keys) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { fail(`${label} must be an inspectable plain own-data record`); }
    if (typeof key !== "string" || descriptor?.enumerable !== true || !("value" in descriptor)) {
      fail(`${label} must contain enumerable string own data properties only`);
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function recordSnapshot(value, label) {
  return Object.fromEntries(recordEntries(value, label));
}

function exactKeys(value, allowed, label) {
  const entries = recordEntries(value, label);
  const keys = entries.map(([key]) => key);
  if (keys.some((key) => !allowed.includes(key))) fail(`${label} contains unsupported fields`);
  const values = new Map(entries);
  for (const key of allowed) if (!values.has(key)) fail(`${label} is missing required fields`);
  return Object.fromEntries(allowed.map((key) => [key, values.get(key)]));
}

function strictArray(value, label) {
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
  if (prototype !== Array.prototype) fail(`${label} must be a plain Array.prototype list`);
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
    fail(`${label} must have a data length`);
  }
  const length = lengthDescriptor.value;
  const entries = [];
  for (const key of keys) {
    if (key === "length") continue;
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { fail(`${label} must be an inspectable dense own-data list`); }
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || descriptor?.enumerable !== true || !("value" in descriptor)) {
      fail(`${label} must contain enumerable numeric own data properties only`);
    }
    entries.push([key, descriptor.value]);
  }
  if (entries.length !== length) fail(`${label} must not contain sparse entries`);
  const values = new Map(entries);
  return Array.from({ length }, (_, index) => {
    const key = String(index);
    if (!values.has(key)) fail(`${label} must not contain sparse entries`);
    return values.get(key);
  });
}

function dataSnapshot(value, label, ancestors = new WeakSet()) {
  if (!value || typeof value !== "object") return value;
  if (ancestors.has(value)) fail(`${label} must not contain cycles`);
  ancestors.add(value);
  let snapshot;
  if (Array.isArray(value)) {
    snapshot = strictArray(value, label).map((item) => dataSnapshot(item, `${label} item`, ancestors));
  } else {
    snapshot = Object.fromEntries(recordEntries(value, label).map(([key, item]) => [key, dataSnapshot(item, `${label}.${key}`, ancestors)]));
  }
  ancestors.delete(value);
  return snapshot;
}

function timestamp(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a canonical ISO-8601 UTC timestamp`);
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) fail(`${label} must be a canonical ISO-8601 UTC timestamp`);
  return { value, epoch };
}

function digestRef(value, label) {
  if (typeof value !== "string" || !SHA256_REFERENCE_PATTERN.test(value)) fail(`${label} must be a strict sha256 reference`);
  return value;
}

function decisionId(value) {
  if (typeof value !== "string" || !DECISION_ID_PATTERN.test(value)) fail("decisionId must be a Decision identifier");
  return value;
}

function revision(value, label = "revision") {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative safe integer`);
  return value;
}

function nativeSurface(runtime, surface) {
  if (typeof runtime !== "string" || NATIVE_SURFACES[runtime] !== surface) fail("runtime and surface must be an exact registered native pair");
  return { runtime, surface };
}

function opaqueRef(value) { return assertNativeDecisionOpaqueRef(value); }

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function canonicalJson(value) { return JSON.stringify(canonical(value)); }

// Pure ECMAScript SHA-256 keeps this domain free of a Node/runtime dependency.
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

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function decisionOrFail(value) {
  try {
    const snapshot = dataSnapshot(value, "Decision");
    assertValidDecision(snapshot);
    return deepFreeze(snapshot);
  } catch {
    fail("Decision must be valid and contain data properties only");
  }
}

function challengeOrFail(value, decision) {
  try {
    const snapshot = dataSnapshot(value, "challenge");
    return assertValidNativeDecisionChallenge(snapshot, decision);
  } catch {
    fail("challenge must be valid, data-only, and bound to the Decision");
  }
}

function immutableBinding(substrate) {
  return {
    schemaVersion: substrate.schemaVersion,
    kind: substrate.kind,
    substrateRef: substrate.substrateRef,
    decisionId: substrate.decisionId,
    presentedRevision: substrate.presentedRevision,
    runId: substrate.runId,
    challengeRef: substrate.challengeRef,
    challengeDigest: substrate.challengeDigest,
    runtime: substrate.runtime,
    surface: substrate.surface,
    hostEventClaimRef: substrate.hostEventClaimRef,
    hostEventClaimDigest: substrate.hostEventClaimDigest,
    renderedHostPayloadDigest: substrate.renderedHostPayloadDigest,
    hostConnectionRef: substrate.hostConnectionRef,
    sessionOrThreadRef: substrate.sessionOrThreadRef,
    turnRef: substrate.turnRef,
    itemRef: substrate.itemRef,
    toolUseOrRequestRef: substrate.toolUseOrRequestRef,
    issuedAt: substrate.issuedAt,
    expiresAt: substrate.expiresAt,
    presentationTimeSourceClaimRef: substrate.presentationTimeSourceClaimRef,
  };
}

function hostEventClaimBinding(substrate) {
  return {
    runtime: substrate.runtime,
    surface: substrate.surface,
    hostEventClaimRef: substrate.hostEventClaimRef,
    hostConnectionRef: substrate.hostConnectionRef,
    sessionOrThreadRef: substrate.sessionOrThreadRef,
    turnRef: substrate.turnRef,
    itemRef: substrate.itemRef,
    toolUseOrRequestRef: substrate.toolUseOrRequestRef,
  };
}

function substrateEvent(value, index) {
  const initial = recordSnapshot(value, `events[${index}]`);
  const state = initial.state;
  if (!NATIVE_HOST_ANSWER_SUBSTRATE_STATES.includes(state)) fail("event state is unsupported");
  const fields = state === "presented" ? ["state", "at", "timeSourceClaimRef"]
    : state === "host_return_observed" ? ["state", "at", "timeSourceClaimRef", "hostReturnObservedClaimDigest"]
      : state === "consumed" ? ["state", "at", "timeSourceClaimRef", "consumerRef"]
        : state === "invalidated" ? ["state", "at", "timeSourceClaimRef", "reasonRef"]
          : ["state", "at", "timeSourceClaimRef"];
  const event = exactKeys(initial, fields, `events[${index}]`);
  const normalized = { state, at: timestamp(event.at, `events[${index}].at`).value, timeSourceClaimRef: opaqueRef(event.timeSourceClaimRef) };
  if (state === "host_return_observed") normalized.hostReturnObservedClaimDigest = digestRef(event.hostReturnObservedClaimDigest, `events[${index}].hostReturnObservedClaimDigest`);
  if (state === "consumed") normalized.consumerRef = opaqueRef(event.consumerRef);
  if (state === "invalidated") normalized.reasonRef = opaqueRef(event.reasonRef);
  return normalized;
}

function validateHistory(substrate) {
  const events = strictArray(substrate.events, "substrate.events").map(substrateEvent);
  if (events.length < 1 || events.length > 3 || events[0].state !== "presented") fail("substrate history must begin with one presentation and remain bounded");
  if (events[0].at !== substrate.issuedAt || events[0].timeSourceClaimRef !== substrate.presentationTimeSourceClaimRef) fail("presentation event does not match issuance time-source claim");
  const issued = timestamp(substrate.issuedAt, "substrate.issuedAt").epoch;
  const expires = timestamp(substrate.expiresAt, "substrate.expiresAt").epoch;
  let previous = issued;
  let state = "presented";
  for (let index = 1; index < events.length; index += 1) {
    const event = events[index];
    const current = timestamp(event.at, `events[${index}].at`).epoch;
    if (current < previous) fail("substrate history must be chronological");
    const legal = state === "presented" ? ["host_return_observed", "expired", "invalidated"]
      : state === "host_return_observed" ? ["consumed", "expired", "invalidated"] : [];
    if (!legal.includes(event.state)) fail("substrate history contains an illegal transition");
    if (["host_return_observed", "consumed"].includes(event.state) && (current < issued || current >= expires)) fail("host return lifecycle event must occur inside the validity window");
    if (event.state === "expired" && current < expires) fail("expiry cannot precede the expiry boundary");
    previous = current;
    state = event.state;
  }
  if (state !== substrate.state || substrate.revision !== events.length - 1) fail("substrate state or revision does not match history");
  const last = events.at(-1);
  const observed = events.find((event) => event.state === "host_return_observed");
  const consumed = events.find((event) => event.state === "consumed");
  const expired = events.find((event) => event.state === "expired");
  const invalidated = events.find((event) => event.state === "invalidated");
  const pairs = [
    ["hostReturnObservedClaimDigest", observed?.hostReturnObservedClaimDigest ?? null], ["observedAt", observed?.at ?? null],
    ["observationTimeSourceClaimRef", observed?.timeSourceClaimRef ?? null], ["consumedAt", consumed?.at ?? null],
    ["consumptionTimeSourceClaimRef", consumed?.timeSourceClaimRef ?? null], ["consumerRef", consumed?.consumerRef ?? null],
    ["expiredAt", expired?.at ?? null], ["expiryTimeSourceClaimRef", expired?.timeSourceClaimRef ?? null],
    ["invalidatedAt", invalidated?.at ?? null], ["invalidationTimeSourceClaimRef", invalidated?.timeSourceClaimRef ?? null],
    ["invalidationReasonRef", invalidated?.reasonRef ?? null],
  ];
  if (pairs.some(([field, expected]) => substrate[field] !== expected)) fail("substrate lifecycle fields do not match history");
  if (substrate.state === "presented" && events.length !== 1) fail("presented substrate carries later lifecycle events");
  if (substrate.state === "host_return_observed" && events.length !== 2) fail("observed substrate history length is invalid");
  if (["expired", "invalidated"].includes(substrate.state) && ![2, 3].includes(events.length)) fail("substrate terminal history length is invalid");
  if (substrate.state === "consumed" && (events.length !== 3 || last.state !== "consumed")) fail("consumed substrate must follow one observed host-return claim");
  return events;
}

function matchDecisionAndChallenge(substrate, decision, challenge) {
  if (decision.status !== "presented" || substrate.decisionId !== decision.decisionId || substrate.presentedRevision !== decision.revision || substrate.runId !== decision.identity.runId) {
    fail("substrate does not bind the current presented Decision");
  }
  if (substrate.challengeRef !== challenge.challengeRef || substrate.challengeDigest !== challenge.challengeDigest || substrate.decisionId !== challenge.decisionId ||
      substrate.presentedRevision !== challenge.presentedRevision || substrate.runId !== challenge.runId || substrate.runtime !== challenge.runtime || substrate.surface !== challenge.surface ||
      substrate.issuedAt !== challenge.issuedAt || substrate.expiresAt !== challenge.expiresAt) {
    fail("substrate does not bind the exact native Decision challenge");
  }
}

function nextSubstrate(substrate, patch, event) {
  return assertValidNativeHostAnswerSubstrate({
    ...substrate,
    ...patch,
    revision: substrate.revision + 1,
    events: [...substrate.events, event],
  });
}

/** Record a caller-supplied presentation claim for one exact issued challenge. */
export function presentNativeHostAnswerSubstrate(decision, issuedChallenge, input) {
  const currentDecision = decisionOrFail(decision);
  const challenge = challengeOrFail(issuedChallenge, currentDecision);
  const command = exactKeys(input, PRESENT_FIELDS, "present input");
  if (currentDecision.status !== "presented" || challenge.state !== "issued") fail("presentation requires a presented Decision and issued challenge");
  const host = nativeSurface(command.runtime, command.surface);
  const issuedAt = timestamp(command.issuedAt, "present input.issuedAt");
  const expiresAt = timestamp(command.expiresAt, "present input.expiresAt");
  if (issuedAt.epoch >= expiresAt.epoch || command.issuedAt !== challenge.issuedAt || command.expiresAt !== challenge.expiresAt || host.runtime !== challenge.runtime || host.surface !== challenge.surface) {
    fail("presentation must reuse the exact challenge surface and validity window");
  }
  const substrate = {
    schemaVersion: NATIVE_HOST_ANSWER_SUBSTRATE_SCHEMA_VERSION,
    kind: "native_host_answer_substrate",
    state: "presented",
    revision: 0,
    substrateRef: opaqueRef(command.substrateRef),
    substrateDigest: null,
    decisionId: currentDecision.decisionId,
    presentedRevision: currentDecision.revision,
    runId: opaqueRef(currentDecision.identity.runId),
    challengeRef: challenge.challengeRef,
    challengeDigest: challenge.challengeDigest,
    runtime: host.runtime,
    surface: host.surface,
    hostEventClaimRef: opaqueRef(command.hostEventClaimRef),
    hostEventClaimDigest: null,
    renderedHostPayloadDigest: digestRef(command.renderedHostPayloadDigest, "present input.renderedHostPayloadDigest"),
    hostConnectionRef: opaqueRef(command.hostConnectionRef),
    sessionOrThreadRef: opaqueRef(command.sessionOrThreadRef),
    turnRef: opaqueRef(command.turnRef),
    itemRef: opaqueRef(command.itemRef),
    toolUseOrRequestRef: opaqueRef(command.toolUseOrRequestRef),
    issuedAt: issuedAt.value,
    expiresAt: expiresAt.value,
    presentationTimeSourceClaimRef: opaqueRef(command.timeSourceClaimRef),
    hostReturnObservedClaimDigest: null,
    observedAt: null,
    observationTimeSourceClaimRef: null,
    consumedAt: null,
    consumptionTimeSourceClaimRef: null,
    consumerRef: null,
    expiredAt: null,
    expiryTimeSourceClaimRef: null,
    invalidatedAt: null,
    invalidationTimeSourceClaimRef: null,
    invalidationReasonRef: null,
    events: [{ state: "presented", at: issuedAt.value, timeSourceClaimRef: opaqueRef(command.timeSourceClaimRef) }],
  };
  substrate.hostEventClaimDigest = digestReference(hostEventClaimBinding(substrate));
  substrate.substrateDigest = digestReference(immutableBinding(substrate));
  return assertValidNativeHostAnswerSubstrate(substrate, currentDecision, challenge);
}

/** Validate exact shape, immutable digest, lifecycle history, and optional source bindings. */
export function assertValidNativeHostAnswerSubstrate(value, decision, challenge) {
  const source = exactKeys(value, SUBSTRATE_FIELDS, "substrate");
  if (source.schemaVersion !== NATIVE_HOST_ANSWER_SUBSTRATE_SCHEMA_VERSION || source.kind !== "native_host_answer_substrate" || !NATIVE_HOST_ANSWER_SUBSTRATE_STATES.includes(source.state)) {
    fail("substrate has an unsupported schema, kind, or state");
  }
  const normalized = {
    ...source,
    revision: revision(source.revision),
    substrateRef: opaqueRef(source.substrateRef),
    substrateDigest: digestRef(source.substrateDigest, "substrate.substrateDigest"),
    decisionId: decisionId(source.decisionId),
    presentedRevision: revision(source.presentedRevision, "presentedRevision"),
    runId: opaqueRef(source.runId),
    challengeRef: opaqueRef(source.challengeRef),
    challengeDigest: digestRef(source.challengeDigest, "substrate.challengeDigest"),
    ...nativeSurface(source.runtime, source.surface),
    hostEventClaimRef: opaqueRef(source.hostEventClaimRef),
    hostEventClaimDigest: digestRef(source.hostEventClaimDigest, "substrate.hostEventClaimDigest"),
    renderedHostPayloadDigest: digestRef(source.renderedHostPayloadDigest, "substrate.renderedHostPayloadDigest"),
    hostConnectionRef: opaqueRef(source.hostConnectionRef),
    sessionOrThreadRef: opaqueRef(source.sessionOrThreadRef),
    turnRef: opaqueRef(source.turnRef),
    itemRef: opaqueRef(source.itemRef),
    toolUseOrRequestRef: opaqueRef(source.toolUseOrRequestRef),
    issuedAt: timestamp(source.issuedAt, "substrate.issuedAt").value,
    expiresAt: timestamp(source.expiresAt, "substrate.expiresAt").value,
    presentationTimeSourceClaimRef: opaqueRef(source.presentationTimeSourceClaimRef),
  };
  if (normalized.hostEventClaimDigest !== digestReference(hostEventClaimBinding(normalized)) || Date.parse(normalized.issuedAt) >= Date.parse(normalized.expiresAt) || normalized.substrateDigest !== digestReference(immutableBinding(normalized))) fail("substrate immutable binding, claimed host-event binding, or validity window is invalid");
  for (const field of ["hostReturnObservedClaimDigest"]) normalized[field] = source[field] === null ? null : digestRef(source[field], `substrate.${field}`);
  for (const field of ["observedAt", "consumedAt", "expiredAt", "invalidatedAt"]) normalized[field] = source[field] === null ? null : timestamp(source[field], `substrate.${field}`).value;
  for (const field of ["observationTimeSourceClaimRef", "consumptionTimeSourceClaimRef", "consumerRef", "expiryTimeSourceClaimRef", "invalidationTimeSourceClaimRef", "invalidationReasonRef"]) {
    normalized[field] = source[field] === null ? null : opaqueRef(source[field]);
  }
  normalized.events = validateHistory(normalized);
  if ((decision === undefined) !== (challenge === undefined)) fail("Decision and challenge bindings must be supplied together");
  if (decision !== undefined) {
    const currentDecision = decisionOrFail(decision);
    const currentChallenge = challengeOrFail(challenge, currentDecision);
    matchDecisionAndChallenge(normalized, currentDecision, currentChallenge);
  }
  return deepFreeze(normalized);
}

/** Record a digest-only host-return observation claim against the exact claimed challenge. */
export function recordNativeHostReturnObservedClaim(decision, claimedChallenge, substrate, input) {
  const currentDecision = decisionOrFail(decision);
  const challenge = challengeOrFail(claimedChallenge, currentDecision);
  const current = assertValidNativeHostAnswerSubstrate(substrate, currentDecision, challenge);
  const command = exactKeys(input, OBSERVE_FIELDS, "observe input");
  if (current.state !== "presented" || challenge.state !== "host_answer_claimed") fail("host-return observation claim requires a presented substrate and claimed challenge");
  for (const field of OBSERVE_FIELDS.slice(0, -3)) {
    if (command[field] !== current[field]) fail(`observe input.${field} does not match substrate binding`);
  }
  const at = timestamp(command.at, "observe input.at");
  if (at.epoch < Date.parse(current.issuedAt) || at.epoch >= Date.parse(current.expiresAt)) fail("host return observation is outside the validity window");
  const timeSourceClaimRef = opaqueRef(command.timeSourceClaimRef);
  const hostReturnObservedClaimDigest = digestRef(command.hostReturnObservedClaimDigest, "observe input.hostReturnObservedClaimDigest");
  return nextSubstrate(current, {
    state: "host_return_observed",
    hostReturnObservedClaimDigest,
    observedAt: at.value,
    observationTimeSourceClaimRef: timeSourceClaimRef,
  }, { state: "host_return_observed", at: at.value, timeSourceClaimRef, hostReturnObservedClaimDigest });
}

/** Consume one observed return once at the domain state-machine layer. */
export function consumeNativeHostReturnObservedClaim(substrate, input) {
  const current = assertValidNativeHostAnswerSubstrate(substrate);
  const command = exactKeys(input, ["at", "timeSourceClaimRef", "consumerRef"], "consume input");
  const at = timestamp(command.at, "consume input.at");
  if (current.state !== "host_return_observed" || at.epoch < Date.parse(current.observedAt) || at.epoch >= Date.parse(current.expiresAt)) fail("substrate is not eligible for in-window single consumption");
  const timeSourceClaimRef = opaqueRef(command.timeSourceClaimRef);
  const consumerRef = opaqueRef(command.consumerRef);
  return nextSubstrate(current, {
    state: "consumed",
    consumedAt: at.value,
    consumptionTimeSourceClaimRef: timeSourceClaimRef,
    consumerRef,
  }, { state: "consumed", at: at.value, timeSourceClaimRef, consumerRef });
}

/** Expire a presented or observed record at or after its exclusive boundary. */
export function expireNativeHostAnswerSubstrate(substrate, input) {
  const current = assertValidNativeHostAnswerSubstrate(substrate);
  const command = exactKeys(input, ["at", "timeSourceClaimRef"], "expire input");
  const at = timestamp(command.at, "expire input.at");
  if (!["presented", "host_return_observed"].includes(current.state) || at.epoch < Date.parse(current.expiresAt)) fail("substrate cannot expire from this state or before its expiry boundary");
  const timeSourceClaimRef = opaqueRef(command.timeSourceClaimRef);
  return nextSubstrate(current, {
    state: "expired",
    expiredAt: at.value,
    expiryTimeSourceClaimRef: timeSourceClaimRef,
  }, { state: "expired", at: at.value, timeSourceClaimRef });
}

/** Invalidate a presented or observed record once, preserving bounded history. */
export function invalidateNativeHostAnswerSubstrate(substrate, input) {
  const current = assertValidNativeHostAnswerSubstrate(substrate);
  const command = exactKeys(input, ["at", "timeSourceClaimRef", "reasonRef"], "invalidate input");
  const at = timestamp(command.at, "invalidate input.at");
  if (!["presented", "host_return_observed"].includes(current.state) || at.epoch < Date.parse(current.events.at(-1).at)) fail("substrate cannot be invalidated from this state or before its latest event");
  const timeSourceClaimRef = opaqueRef(command.timeSourceClaimRef);
  const reasonRef = opaqueRef(command.reasonRef);
  return nextSubstrate(current, {
    state: "invalidated",
    invalidatedAt: at.value,
    invalidationTimeSourceClaimRef: timeSourceClaimRef,
    invalidationReasonRef: reasonRef,
  }, { state: "invalidated", at: at.value, timeSourceClaimRef, reasonRef });
}

/** Every v1 state remains non-authorizing until an external real host verifier exists. */
export function nativeHostAnswerSubstrateGate(substrate) {
  const current = assertValidNativeHostAnswerSubstrate(substrate);
  const blockedReason = current.state === "presented" ? "native_host_return_not_observed"
    : current.state === "host_return_observed" ? "native_host_return_observed_not_verified"
      : current.state === "consumed" ? "native_host_return_consumed_not_verified"
        : current.state === "expired" ? "native_host_answer_substrate_expired"
          : "native_host_answer_substrate_invalidated";
  return Object.freeze({
    substrateRef: current.substrateRef,
    decisionId: current.decisionId,
    presentedRevision: current.presentedRevision,
    state: current.state,
    revision: current.revision,
    executionAllowed: false,
    blockedReason,
  });
}
