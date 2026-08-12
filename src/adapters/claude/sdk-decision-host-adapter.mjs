/**
 * Claude host-owned Decision observation adapter.
 *
 * The injected port is the only component allowed to talk to the active
 * Claude SDK or a deferred `claude -p` session. Caller JSON, environment
 * variables, hooks, cards, and reports never enter this boundary. The adapter
 * persists digest-only presentation/return claims and is intentionally unable
 * to authorize execution.
 */

import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import { assertNativeDecisionOpaqueRef } from "../../domain/decision/native-decision-authority.mjs";
import {
  assertValidNativeHostAnswerSubstrate,
  nativeHostAnswerSubstrateGate,
  presentNativeHostAnswerSubstrate,
  recordNativeHostReturnObservedClaim,
} from "../../domain/decision/native-host-answer-authority.mjs";
import {
  claimClaudeAskUserQuestionReturn,
  prepareClaudeAskUserQuestion,
  prepareDeferredClaudeAskUserQuestionHandoff,
} from "./native-decision-surface-adapter.mjs";

const RUNTIME = "claude";
const SURFACE = "AskUserQuestion";
const CONTEXT_FIELDS = Object.freeze(["hostConnectionRef", "sessionRef", "turnRef", "itemRef"]);
const PRESENTATION_FIELDS = Object.freeze([
  ...CONTEXT_FIELDS,
  "tool_use_id",
  "issuedAt",
  "expiresAt",
  "timeSourceClaimRef",
  "renderedAskUserQuestion",
]);
const DEFERRED_PRESENTATION_FIELDS = Object.freeze([...PRESENTATION_FIELDS, "deferredCallId"]);
const RETURN_FIELDS = Object.freeze([
  ...CONTEXT_FIELDS,
  "tool_use_id",
  "at",
  "timeSourceClaimRef",
  "selectedOptionId",
]);
const DEFERRED_RETURN_FIELDS = Object.freeze([...RETURN_FIELDS, "deferredCallId"]);

function fail(message) {
  throw new TypeError(`Claude SDK Decision host adapter: ${message}`);
}

function plainRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a non-Proxy Object.prototype record`);
  }
  const keys = Reflect.ownKeys(value);
  const entries = [];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || descriptor?.enumerable !== true || !("value" in descriptor)) {
      fail(`${label} must contain enumerable string own data properties only`);
    }
    entries.push([key, descriptor.value]);
  }
  return { keys, snapshot: Object.freeze(Object.fromEntries(entries)) };
}

function exactKeys(value, expected, label) {
  const record = plainRecord(value, label);
  const actual = [...record.keys].sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    fail(`${label} must contain exactly the supported fields`);
  }
  return record.snapshot;
}

function denseArray(value, label) {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(`${label} must be a non-Proxy plain dense array`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < 0 || lengthDescriptor?.enumerable !== false || !("value" in lengthDescriptor)) {
    fail(`${label} must have an ordinary data length`);
  }
  const expected = [...Array.from({ length }, (_, index) => String(index)), "length"];
  const actual = Reflect.ownKeys(value);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} must contain only dense numeric own entries`);
  }
  return Object.freeze(Array.from({ length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      fail(`${label} must contain enumerable data entries only`);
    }
    return descriptor.value;
  }));
}

function dataSnapshot(value, label, ancestors = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") fail(`${label} contains unsupported data`);
  if (ancestors.has(value)) fail(`${label} must not contain cycles`);
  ancestors.add(value);
  let snapshot;
  if (Array.isArray(value)) {
    snapshot = denseArray(value, label).map((item, index) => dataSnapshot(item, `${label}[${index}]`, ancestors));
  } else {
    const record = plainRecord(value, label);
    snapshot = Object.fromEntries(record.keys.map((key) => [
      key,
      dataSnapshot(Object.getOwnPropertyDescriptor(record.snapshot, key).value, `${label}.${key}`, ancestors),
    ]));
  }
  ancestors.delete(value);
  return snapshot;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

/** Return a digest of the exact data-only AskUserQuestion payload. */
export function digestClaudeRenderedAskUserQuestion(value) {
  const snapshot = dataSnapshot(value, "rendered AskUserQuestion payload");
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(snapshot))).digest("hex")}`;
}

function opaque(value, label) {
  try {
    return assertNativeDecisionOpaqueRef(value);
  } catch {
    fail(`${label} must be a safe opaque reference`);
  }
}

function timestamp(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${label} must be a canonical ISO-8601 UTC timestamp`);
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) fail(`${label} must be a canonical ISO-8601 UTC timestamp`);
  return value;
}

function normalizeContext(value, label = "host context") {
  const context = exactKeys(value, CONTEXT_FIELDS, label);
  return Object.freeze(Object.fromEntries(CONTEXT_FIELDS.map((field) => [field, opaque(context[field], `${label}.${field}`)])));
}

function sameContext(actual, expected, label) {
  for (const field of CONTEXT_FIELDS) {
    if (actual[field] !== expected[field]) fail(`${label}.${field} does not match the active host context`);
  }
}

function normalizePresentation(value, context, deferred) {
  const fields = deferred ? DEFERRED_PRESENTATION_FIELDS : PRESENTATION_FIELDS;
  const input = exactKeys(value, fields, deferred ? "deferred host presentation" : "active host presentation");
  const normalizedContext = normalizeContext(Object.fromEntries(CONTEXT_FIELDS.map((field) => [field, input[field]])), "host presentation context");
  sameContext(normalizedContext, context, "host presentation context");
  const toolUseId = opaque(input.tool_use_id, "host presentation.tool_use_id");
  const normalized = {
    ...normalizedContext,
    tool_use_id: toolUseId,
    issuedAt: timestamp(input.issuedAt, "host presentation.issuedAt"),
    expiresAt: timestamp(input.expiresAt, "host presentation.expiresAt"),
    timeSourceClaimRef: opaque(input.timeSourceClaimRef, "host presentation.timeSourceClaimRef"),
    renderedAskUserQuestion: dataSnapshot(input.renderedAskUserQuestion, "host presentation.renderedAskUserQuestion"),
  };
  if (deferred) {
    normalized.deferredCallId = opaque(input.deferredCallId, "host presentation.deferredCallId");
    if (normalized.deferredCallId !== toolUseId) fail("deferredCallId must exactly match the deferred tool_use_id");
  }
  return Object.freeze(normalized);
}

function normalizeReturn(value, binding, deferred) {
  const fields = deferred ? DEFERRED_RETURN_FIELDS : RETURN_FIELDS;
  const input = exactKeys(value, fields, deferred ? "deferred host return" : "active host return");
  const context = normalizeContext(Object.fromEntries(CONTEXT_FIELDS.map((field) => [field, input[field]])), "host return context");
  sameContext(context, binding, "host return context");
  const toolUseId = opaque(input.tool_use_id, "host return.tool_use_id");
  if (toolUseId !== binding.tool_use_id) fail("host return tool_use_id does not match its presentation");
  if (deferred) {
    const deferredCallId = opaque(input.deferredCallId, "host return.deferredCallId");
    if (deferredCallId !== binding.deferredCallId || deferredCallId !== toolUseId) {
      fail("deferred resume does not match its deferred call");
    }
  }
  return Object.freeze({
    ...context,
    tool_use_id: toolUseId,
    ...(deferred ? { deferredCallId: binding.deferredCallId } : {}),
    at: timestamp(input.at, "host return.at"),
    timeSourceClaimRef: opaque(input.timeSourceClaimRef, "host return.timeSourceClaimRef"),
    selectedOptionId: opaque(input.selectedOptionId, "host return.selectedOptionId"),
  });
}

function digestObservedReturn(value) {
  return digestClaudeRenderedAskUserQuestion(value);
}

function hostEventIdentity(binding, renderedHostPayloadDigest, deferred) {
  return Object.freeze({
    domain: deferred ? "claude-deferred-AskUserQuestion-host-event-v1" : "claude-active-AskUserQuestion-host-event-v1",
    runtime: RUNTIME,
    surface: SURFACE,
    hostConnectionRef: binding.hostConnectionRef,
    sessionOrThreadRef: binding.sessionRef,
    turnRef: binding.turnRef,
    itemRef: binding.itemRef,
    toolUseOrRequestRef: deferred ? binding.deferredCallId : binding.tool_use_id,
    renderedHostPayloadDigest,
  });
}

function deriveHostIdentity(binding, renderedHostPayloadDigest, deferred) {
  const hostEventClaimRef = digestClaudeRenderedAskUserQuestion(hostEventIdentity(binding, renderedHostPayloadDigest, deferred));
  return { hostEventClaimRef, substrateRef: hostEventClaimRef };
}

function requiredMethods(value, names, label) {
  const record = plainRecord(value, label);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(record.snapshot, name);
    if (!descriptor || typeof descriptor.value !== "function") fail(`${label}.${name} must be an own data function`);
  }
  return record.snapshot;
}

function requiredMethod(value, name, label) {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor) || typeof descriptor.value !== "function") {
    fail(`${label}.${name} must be an own data function`);
  }
  return descriptor.value;
}

async function resolveHostResult(candidate, label) {
  if (candidate && typeof candidate === "object" && utilTypes.isProxy(candidate)) {
    fail(`${label} must not return a Proxy`);
  }
  return candidate instanceof Promise ? await candidate : candidate;
}

function challengeHostReturn(challenge, binding, returned, deferred) {
  return {
    returnKind: deferred ? "deferred_resume" : "active_host_return",
    runtime: RUNTIME,
    surface: SURFACE,
    sessionRef: returned.sessionRef,
    challengeRef: challenge.challengeRef,
    challengeDigest: challenge.challengeDigest,
    decisionId: challenge.decisionId,
    presentedRevision: challenge.presentedRevision,
    runId: challenge.runId,
    requestRef: challenge.requestRef,
    optionSetDigest: challenge.optionSetDigest,
    evidenceSetDigest: challenge.evidenceSetDigest,
    presentationDigest: challenge.presentationDigest,
    claimedAt: returned.at,
    selectedOptionId: returned.selectedOptionId,
    ...(deferred ? { deferredCallId: binding.deferredCallId } : {}),
  };
}

function repositoryObserveInput(record, previous) {
  return {
    record,
    expectedRevision: previous.revision,
    expectedSubstrateDigest: previous.substrateDigest,
    expectedState: previous.state,
  };
}

function assertRecoveredSubstrate(substrate, decision, challenge, binding, renderedHostPayloadDigest, deferred) {
  const current = assertValidNativeHostAnswerSubstrate(substrate, decision, challenge);
  if (!["presented", "host_return_observed"].includes(current.state)) fail("persisted host event is no longer observable");
  const identity = deriveHostIdentity(binding, renderedHostPayloadDigest, deferred);
  const exact = {
    substrateRef: identity.substrateRef,
    hostEventClaimRef: identity.hostEventClaimRef,
    runtime: RUNTIME,
    surface: SURFACE,
    renderedHostPayloadDigest,
    hostConnectionRef: binding.hostConnectionRef,
    sessionOrThreadRef: binding.sessionRef,
    turnRef: binding.turnRef,
    itemRef: binding.itemRef,
    toolUseOrRequestRef: deferred ? binding.deferredCallId : binding.tool_use_id,
    issuedAt: binding.issuedAt,
    expiresAt: binding.expiresAt,
    presentationTimeSourceClaimRef: binding.timeSourceClaimRef,
  };
  if (Object.entries(exact).some(([field, expected]) => current[field] !== expected)) {
    fail("persisted substrate does not match the exact redelivered Claude host event");
  }
  return current;
}

function assertRecoveredObservation(substrate, returned) {
  const digest = digestObservedReturn(returned);
  if (substrate.state !== "host_return_observed" ||
      substrate.hostReturnObservedClaimDigest !== digest ||
      substrate.observedAt !== returned.at ||
      substrate.observationTimeSourceClaimRef !== returned.timeSourceClaimRef) {
    fail("redelivered Claude host return does not match the durable observation claim");
  }
  return substrate;
}

/**
 * Build an adapter over one host-owned Claude connection and one atomic
 * repository. The port methods are intentionally narrow and runtime-specific.
 */
export function createClaudeSdkDecisionHostAdapter(input = {}) {
  const options = exactKeys(input, ["hostPort", "repository"], "adapter input");
  const { hostPort, repository } = options;
  const host = requiredMethods(hostPort, ["getCurrentContext"], "hostPort");
  const store = requiredMethods(repository, ["issue", "observe", "read"], "repository");

  async function prepare(decision, challenge, activeHostOptionMaximum) {
    const context = normalizeContext(await resolveHostResult(host.getCurrentContext(), "hostPort.getCurrentContext"));
    const request = prepareClaudeAskUserQuestion(decision, {
      challenge,
      sessionRef: context.sessionRef,
      activeHostOptionMaximum,
    });
    return { context, request };
  }

  async function observeReturn({ decision, challenge, request, binding, substrate, deferred }) {
    const readReturn = requiredMethod(
      host,
      deferred ? "resumeDeferredAskUserQuestion" : "readActiveAskUserQuestionReturn",
      "hostPort",
    );
    const invocation = deferred
      ? readReturn(Object.freeze({
        hostConnectionRef: binding.hostConnectionRef,
        sessionRef: binding.sessionRef,
        turnRef: binding.turnRef,
        itemRef: binding.itemRef,
        tool_use_id: binding.tool_use_id,
        deferredCallId: binding.deferredCallId,
      }))
      : readReturn(Object.freeze({
        hostConnectionRef: binding.hostConnectionRef,
        sessionRef: binding.sessionRef,
        turnRef: binding.turnRef,
        itemRef: binding.itemRef,
        tool_use_id: binding.tool_use_id,
      }));
    const rawReturn = await resolveHostResult(invocation, deferred ? "hostPort.resumeDeferredAskUserQuestion" : "hostPort.readActiveAskUserQuestionReturn");
    const returned = normalizeReturn(rawReturn, binding, deferred);
    const claimed = claimClaudeAskUserQuestionReturn(decision, request, challengeHostReturn(challenge, binding, returned, deferred));
    let stored;
    if (substrate.state === "host_return_observed") {
      stored = assertRecoveredObservation(substrate, returned);
    } else {
      const observation = recordNativeHostReturnObservedClaim(
        decision,
        claimed.challenge,
        substrate,
        observedClaimInput(substrate, binding, returned),
      );
      stored = await store.observe(repositoryObserveInput(observation, substrate));
      assertRecoveredObservation(stored, returned);
    }
    const gate = nativeHostAnswerSubstrateGate(stored);
    if (gate.executionAllowed !== false || gate.state !== "host_return_observed") fail("repository did not retain the observed non-authorizing substrate");
    const ack = requiredMethod(
      host,
      deferred ? "ackDeferredAskUserQuestionReturn" : "ackActiveAskUserQuestionReturn",
      "hostPort",
    );
    await resolveHostResult(ack(Object.freeze({
      substrateRef: stored.substrateRef,
      hostConnectionRef: binding.hostConnectionRef,
      sessionRef: binding.sessionRef,
      turnRef: binding.turnRef,
      itemRef: binding.itemRef,
      tool_use_id: binding.tool_use_id,
      ...(deferred ? { deferredCallId: binding.deferredCallId } : {}),
      hostReturnObservedClaimDigest: stored.hostReturnObservedClaimDigest,
    })), deferred ? "hostPort.ackDeferredAskUserQuestionReturn" : "hostPort.ackActiveAskUserQuestionReturn");
    return Object.freeze({
      status: "non_authorizing_host_return_observation",
      runtime: RUNTIME,
      surface: SURFACE,
      returnKind: deferred ? "deferred_resume" : "active_host_return",
      challenge: claimed.challenge,
      substrate: stored,
      gate,
      executionAllowed: false,
    });
  }

  async function active(input = {}) {
    const command = exactKeys(input, ["decision", "challenge", "activeHostOptionMaximum"], "active input");
    const { context, request } = await prepare(command.decision, command.challenge, command.activeHostOptionMaximum);
    const presentActive = requiredMethod(host, "presentActiveAskUserQuestion", "hostPort");
    const rawPresentation = await resolveHostResult(presentActive(request.askUserQuestion), "hostPort.presentActiveAskUserQuestion");
    const binding = normalizePresentation(rawPresentation, context, false);
    const expectedDigest = digestClaudeRenderedAskUserQuestion(request.askUserQuestion);
    const actualDigest = digestClaudeRenderedAskUserQuestion(binding.renderedAskUserQuestion);
    if (actualDigest !== expectedDigest) fail("active host rendered a different AskUserQuestion payload");
    const substrate = await presentAndIssue(command.decision, command.challenge, binding, actualDigest, false);
    return observeReturn({ decision: command.decision, challenge: command.challenge, request, binding, substrate, deferred: false });
  }

  async function defer(input = {}) {
    const command = exactKeys(input, ["decision", "challenge", "activeHostOptionMaximum"], "defer input");
    const { context, request: activeRequest } = await prepare(command.decision, command.challenge, command.activeHostOptionMaximum);
    const presentDeferred = requiredMethod(host, "presentDeferredAskUserQuestion", "hostPort");
    const rawPresentation = await resolveHostResult(presentDeferred(activeRequest.askUserQuestion), "hostPort.presentDeferredAskUserQuestion");
    const binding = normalizePresentation(rawPresentation, context, true);
    const request = prepareDeferredClaudeAskUserQuestionHandoff(activeRequest, {
      decision: command.decision,
      deferredCallId: binding.deferredCallId,
    });
    const expectedDigest = digestClaudeRenderedAskUserQuestion(activeRequest.askUserQuestion);
    const actualDigest = digestClaudeRenderedAskUserQuestion(binding.renderedAskUserQuestion);
    if (actualDigest !== expectedDigest) fail("deferred host rendered a different AskUserQuestion payload");
    const substrate = await presentAndIssue(command.decision, command.challenge, binding, actualDigest, true);
    if (substrate.state === "host_return_observed") {
      return observeReturn({ decision: command.decision, challenge: command.challenge, request, binding, substrate, deferred: true });
    }
    const gate = nativeHostAnswerSubstrateGate(substrate);
    return Object.freeze({
      status: "deferred_waiting_resume",
      runtime: RUNTIME,
      surface: SURFACE,
      deferredCallId: binding.deferredCallId,
      challenge: command.challenge,
      substrate,
      gate,
      executionAllowed: false,
    });
  }

  // substrateRef is only a repository continuation locator here. The stored
  // substrate, Decision, challenge, rendered digest, and deferred host-event
  // identity are all revalidated before the host resume capability is called.
  async function resume(input = {}) {
    const command = exactKeys(input, ["decision", "challenge", "substrateRef", "activeHostOptionMaximum"], "resume input");
    const substrate = await store.read({ substrateRef: opaque(command.substrateRef, "resume input.substrateRef") });
    assertValidNativeHostAnswerSubstrate(substrate, command.decision, command.challenge);
    const gate = nativeHostAnswerSubstrateGate(substrate);
    if (!["presented", "host_return_observed"].includes(gate.state) || gate.executionAllowed !== false) fail("deferred substrate is no longer observable");
    const context = normalizeContext({
      hostConnectionRef: substrate.hostConnectionRef,
      sessionRef: substrate.sessionOrThreadRef,
      turnRef: substrate.turnRef,
      itemRef: substrate.itemRef,
    }, "stored deferred context");
    const activeRequest = prepareClaudeAskUserQuestion(command.decision, {
      challenge: command.challenge,
      sessionRef: context.sessionRef,
      activeHostOptionMaximum: command.activeHostOptionMaximum,
    });
    const request = prepareDeferredClaudeAskUserQuestionHandoff(activeRequest, {
      decision: command.decision,
      deferredCallId: substrate.toolUseOrRequestRef,
    });
    const expectedDigest = digestClaudeRenderedAskUserQuestion(activeRequest.askUserQuestion);
    if (expectedDigest !== substrate.renderedHostPayloadDigest) fail("stored deferred payload digest does not match the Decision presentation");
    const binding = Object.freeze({
      ...context,
      tool_use_id: substrate.toolUseOrRequestRef,
      deferredCallId: substrate.toolUseOrRequestRef,
      issuedAt: substrate.issuedAt,
      expiresAt: substrate.expiresAt,
      timeSourceClaimRef: substrate.presentationTimeSourceClaimRef,
    });
    const identity = deriveHostIdentity(binding, substrate.renderedHostPayloadDigest, true);
    if (identity.substrateRef !== substrate.substrateRef || identity.hostEventClaimRef !== substrate.hostEventClaimRef) {
      fail("stored substrate is not the exact deferred Claude host event");
    }
    return observeReturn({ decision: command.decision, challenge: command.challenge, request, binding, substrate, deferred: true });
  }

  async function presentAndIssue(decision, challenge, binding, renderedHostPayloadDigest, deferred) {
    const identity = deriveHostIdentity(binding, renderedHostPayloadDigest, deferred);
    const record = presentNativeHostAnswerSubstrate(decision, challenge, {
      substrateRef: identity.substrateRef,
      runtime: RUNTIME,
      surface: SURFACE,
      hostEventClaimRef: identity.hostEventClaimRef,
      renderedHostPayloadDigest,
      hostConnectionRef: binding.hostConnectionRef,
      sessionOrThreadRef: binding.sessionRef,
      turnRef: binding.turnRef,
      itemRef: binding.itemRef,
      toolUseOrRequestRef: binding.tool_use_id,
      issuedAt: binding.issuedAt,
      expiresAt: binding.expiresAt,
      timeSourceClaimRef: binding.timeSourceClaimRef,
    });
    let stored;
    try {
      stored = await store.issue(record);
    } catch (issueError) {
      if (issueError?.code !== "NATIVE_HOST_ANSWER_REPOSITORY_REPLAY") throw issueError;
      let recovered;
      try {
        recovered = await store.read({ substrateRef: identity.substrateRef });
      } catch {
        throw issueError;
      }
      stored = assertRecoveredSubstrate(recovered, decision, challenge, binding, renderedHostPayloadDigest, deferred);
    }
    const gate = nativeHostAnswerSubstrateGate(stored);
    if (gate.executionAllowed !== false || !["presented", "host_return_observed"].includes(gate.state)) fail("repository did not retain an observable non-authorizing substrate");
    return stored;
  }

  return Object.freeze({ active, defer, resume });
}

function observedClaimInput(substrate, binding, returned) {
  return {
    substrateRef: substrate.substrateRef,
    substrateDigest: substrate.substrateDigest,
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
    hostConnectionRef: binding.hostConnectionRef,
    sessionOrThreadRef: binding.sessionRef,
    turnRef: binding.turnRef,
    itemRef: binding.itemRef,
    toolUseOrRequestRef: binding.tool_use_id,
    issuedAt: substrate.issuedAt,
    expiresAt: substrate.expiresAt,
    at: returned.at,
    timeSourceClaimRef: returned.timeSourceClaimRef,
    hostReturnObservedClaimDigest: digestObservedReturn(returned),
  };
}
