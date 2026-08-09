/**
 * Pure, transient Claude Code AskUserQuestion adapter.
 *
 * It prepares an issued shared-domain challenge for the active host and can
 * bind an exact active return or deferred resume to that challenge. The result
 * remains a non-authorizing host claim; this module never invokes hooks, reads
 * environment or IO state, persists raw prompt/answer text, or permits work.
 */

import { assertValidDecision } from "../../domain/decision/decision.mjs";
import {
  assertNativeDecisionOpaqueRef,
  assertValidNativeDecisionChallenge,
  claimNativeDecisionChallenge,
} from "../../domain/decision/native-decision-authority.mjs";

const SCHEMA_VERSION = "claude-native-decision-surface-adapter-v1";
const RUNTIME = "claude";
const SURFACE = "AskUserQuestion";
const PREPARE_FIELDS = Object.freeze(["challenge", "sessionRef", "activeHostOptionMaximum"]);
const RETURN_FIELDS = Object.freeze([
  "returnKind",
  "runtime",
  "surface",
  "sessionRef",
  "challengeRef",
  "challengeDigest",
  "decisionId",
  "presentedRevision",
  "runId",
  "requestRef",
  "optionSetDigest",
  "evidenceSetDigest",
  "presentationDigest",
  "claimedAt",
  "selectedOptionId",
]);

function fail(message) {
  throw new TypeError(`Claude native decision surface: ${message}`);
}

function plainRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be an Object.prototype record`);
  }
  const keys = Reflect.ownKeys(value);
  const entries = [];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || descriptor?.enumerable !== true || !("value" in descriptor)) {
      fail(`${label} must contain enumerable string data own keys only`);
    }
    entries.push([key, descriptor.value]);
  }
  return { keys, snapshot: Object.freeze(Object.fromEntries(entries)) };
}

function exactKeys(value, keys, label) {
  const record = plainRecord(value, label);
  const actual = [...record.keys].sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} must contain exactly the supported fields`);
  }
  return record.snapshot;
}

function denseArray(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(`${label} must be a plain dense array`);
  }
  const actualKeys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < 0 || lengthDescriptor?.enumerable !== false || !("value" in lengthDescriptor)) {
    fail(`${label} must have one ordinary array length data property`);
  }
  const expectedKeys = [...Array.from({ length }, (_, index) => String(index)), "length"];
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    fail(`${label} must contain only dense numeric own entries`);
  }
  const snapshot = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      fail(`${label} must contain enumerable data entries only`);
    }
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function activeHostMaximum(value) {
  if (!Number.isSafeInteger(value) || value < 2) {
    fail("activeHostOptionMaximum must be an integer of at least two meaningful options");
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function immutableCopy(value) {
  return deepFreeze(structuredClone(value));
}

function orderedOptions(decision) {
  const recommended = decision.recommendation?.optionId ?? null;
  return [...decision.options].sort((left, right) => {
    if (left.optionId === recommended) return -1;
    if (right.optionId === recommended) return 1;
    return left.optionId.localeCompare(right.optionId);
  });
}

function optionPayload(option) {
  return Object.freeze({
    optionId: option.optionId,
    displayRef: option.displayRef,
    tradeoffRefs: Object.freeze([...option.tradeoffRefs]),
    evidenceRefs: Object.freeze([...option.evidenceRefs]),
  });
}

function questionPayload(decision, challenge, selectedOptions) {
  return Object.freeze([Object.freeze({
    questionRef: decision.requirement.reasonRef,
    challengeRef: challenge.challengeRef,
    recommendedOptionId: decision.recommendation?.optionId ?? null,
    options: Object.freeze(selectedOptions.map(optionPayload)),
  })]);
}

function exactOpaqueArray(actual, expected, label) {
  const snapshot = denseArray(actual, label);
  if (snapshot.length !== expected.length) fail(`${label} does not exactly match the Decision presentation`);
  for (let index = 0; index < expected.length; index += 1) {
    const normalized = assertNativeDecisionOpaqueRef(snapshot[index]);
    if (normalized !== expected[index]) fail(`${label} does not exactly match the Decision presentation`);
  }
  return snapshot;
}

function questionsFor(value, decision, challenge) {
  const questions = denseArray(value, "askUserQuestion.questions");
  if (questions.length !== 1) fail("one Decision must map to exactly one AskUserQuestion question");
  const question = exactKeys(questions[0], ["questionRef", "challengeRef", "recommendedOptionId", "options"], "askUserQuestion.questions[0]");
  if (assertNativeDecisionOpaqueRef(question.questionRef) !== decision.requirement.reasonRef ||
      assertNativeDecisionOpaqueRef(question.challengeRef) !== challenge.challengeRef ||
      question.recommendedOptionId !== (decision.recommendation?.optionId ?? null)) {
    fail("AskUserQuestion question does not exactly map to the Decision challenge");
  }
  if (question.recommendedOptionId !== null) assertNativeDecisionOpaqueRef(question.recommendedOptionId);

  const options = denseArray(question.options, "askUserQuestion.questions[0].options");
  const allOptions = orderedOptions(decision);
  if (options.length < Math.min(2, allOptions.length) || options.length > allOptions.length) {
    fail("AskUserQuestion options do not fit the Decision presentation");
  }
  const selectedOptions = allOptions.slice(0, options.length);
  for (let index = 0; index < selectedOptions.length; index += 1) {
    const actual = exactKeys(options[index], ["optionId", "displayRef", "tradeoffRefs", "evidenceRefs"], `askUserQuestion.questions[0].options[${index}]`);
    const expected = selectedOptions[index];
    if (assertNativeDecisionOpaqueRef(actual.optionId) !== expected.optionId ||
        assertNativeDecisionOpaqueRef(actual.displayRef) !== expected.displayRef) {
      fail("AskUserQuestion option does not exactly map to the Decision presentation");
    }
    exactOpaqueArray(actual.tradeoffRefs, expected.tradeoffRefs, `askUserQuestion.questions[0].options[${index}].tradeoffRefs`);
    exactOpaqueArray(actual.evidenceRefs, expected.evidenceRefs, `askUserQuestion.questions[0].options[${index}].evidenceRefs`);
  }
  return { allOptions, selectedOptions, questions: questionPayload(decision, challenge, selectedOptions) };
}

function presentationFor(askUserQuestion, omittedOptionIds, decision, challenge) {
  const payload = exactKeys(askUserQuestion, ["questions"], "askUserQuestion");
  const presentation = questionsFor(payload.questions, decision, challenge);
  exactOpaqueArray(
    omittedOptionIds,
    presentation.allOptions.slice(presentation.selectedOptions.length).map((option) => option.optionId),
    "omittedOptionIds",
  );
  return presentation;
}

function correlationFor(challenge, sessionRef) {
  return Object.freeze({
    decisionId: challenge.decisionId,
    presentedRevision: challenge.presentedRevision,
    runId: challenge.runId,
    runtime: challenge.runtime,
    surface: challenge.surface,
    sessionRef,
    requestRef: challenge.requestRef,
    challengeRef: challenge.challengeRef,
    challengeDigest: challenge.challengeDigest,
    optionSetDigest: challenge.optionSetDigest,
    evidenceSetDigest: challenge.evidenceSetDigest,
    presentationDigest: challenge.presentationDigest,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
  });
}

function sameCorrelation(actual, expected) {
  const snapshot = exactKeys(actual, Object.keys(expected), "correlation");
  if (Object.keys(expected).some((key) => snapshot[key] !== expected[key])) {
    fail("correlation does not exactly match its shared-domain challenge");
  }
  return expected;
}

function preparedRequest(value, decision) {
  assertValidDecision(decision);
  const prepared = exactKeys(value, [
    "schemaVersion",
    "status",
    "runtime",
    "surface",
    "executionAllowed",
    "challenge",
    "correlation",
    "askUserQuestion",
    "omittedOptionIds",
  ], "prepared request");
  if (prepared.schemaVersion !== SCHEMA_VERSION || prepared.status !== "ready_for_active_host" || prepared.runtime !== RUNTIME || prepared.surface !== SURFACE || prepared.executionAllowed !== false) {
    fail("prepared request is not a transient non-authorizing Claude request");
  }
  const challenge = immutableCopy(prepared.challenge);
  assertValidNativeDecisionChallenge(challenge, decision);
  if (challenge.state !== "issued") fail("prepared request challenge must remain issued");
  const correlationInput = plainRecord(prepared.correlation, "correlation").snapshot;
  const sessionRef = assertNativeDecisionOpaqueRef(correlationInput.sessionRef);
  const correlation = correlationFor(challenge, sessionRef);
  sameCorrelation(correlationInput, correlation);
  const presentation = presentationFor(prepared.askUserQuestion, prepared.omittedOptionIds, decision, challenge);
  return { challenge, correlation, questions: presentation.questions, deferredCallId: null };
}

function deferredRequest(value, decision) {
  const deferred = exactKeys(value, [
    "schemaVersion",
    "status",
    "runtime",
    "surface",
    "executionAllowed",
    "challenge",
    "correlation",
    "deferredToolUse",
  ], "deferred request");
  if (deferred.schemaVersion !== SCHEMA_VERSION || deferred.status !== "deferred_waiting_resume" || deferred.runtime !== RUNTIME || deferred.surface !== SURFACE || deferred.executionAllowed !== false) {
    fail("deferred request is not a pending non-authorizing Claude handoff");
  }
  const challenge = immutableCopy(deferred.challenge);
  assertValidNativeDecisionChallenge(challenge, decision);
  if (challenge.state !== "issued") fail("deferred request challenge must remain issued");
  const correlationInput = plainRecord(deferred.correlation, "correlation").snapshot;
  const sessionRef = assertNativeDecisionOpaqueRef(correlationInput.sessionRef);
  const correlation = correlationFor(challenge, sessionRef);
  sameCorrelation(correlationInput, correlation);
  const deferredToolUse = exactKeys(deferred.deferredToolUse, ["name", "deferredCallId", "questions"], "deferredToolUse");
  if (deferredToolUse.name !== SURFACE) fail("deferred tool surface must be AskUserQuestion");
  const presentation = questionsFor(deferredToolUse.questions, decision, challenge);
  return {
    challenge,
    correlation,
    questions: presentation.questions,
    deferredCallId: assertNativeDecisionOpaqueRef(deferredToolUse.deferredCallId),
  };
}

function requestState(value, decision) {
  const request = plainRecord(value, "request").snapshot;
  if (request.status === "ready_for_active_host") return preparedRequest(request, decision);
  if (request.status === "deferred_waiting_resume") return deferredRequest(request, decision);
  fail("request must be ready for the active host or waiting for an exact resume");
}

/**
 * Prepare opaque AskUserQuestion payload data for one issued challenge. The
 * active host supplies its current option maximum; Meta_Kim defines no cap.
 */
export function prepareClaudeAskUserQuestion(decision, input = {}) {
  assertValidDecision(decision);
  const preparedInput = exactKeys(input, PREPARE_FIELDS, "prepare input");
  const challenge = immutableCopy(preparedInput.challenge);
  assertValidNativeDecisionChallenge(challenge, decision);
  if (challenge.state !== "issued" || challenge.runtime !== RUNTIME || challenge.surface !== SURFACE) {
    fail("prepare input requires an issued Claude AskUserQuestion challenge");
  }
  const sessionRef = assertNativeDecisionOpaqueRef(preparedInput.sessionRef);
  const maximum = activeHostMaximum(preparedInput.activeHostOptionMaximum);
  const allOptions = orderedOptions(decision);
  const selectedOptions = allOptions.slice(0, maximum);
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    status: "ready_for_active_host",
    runtime: RUNTIME,
    surface: SURFACE,
    executionAllowed: false,
    challenge,
    correlation: correlationFor(challenge, sessionRef),
    askUserQuestion: Object.freeze({ questions: questionPayload(decision, challenge, selectedOptions) }),
    omittedOptionIds: Object.freeze(allOptions.slice(selectedOptions.length).map((option) => option.optionId)),
  });
}

/** Deferred tool use is a pending handoff only; it never claims an answer. */
export function prepareDeferredClaudeAskUserQuestionHandoff(prepared, input = {}) {
  const deferredInput = exactKeys(input, ["decision", "deferredCallId"], "deferred handoff input");
  const current = preparedRequest(prepared, deferredInput.decision);
  const deferredCallId = assertNativeDecisionOpaqueRef(deferredInput.deferredCallId);
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    status: "deferred_waiting_resume",
    runtime: RUNTIME,
    surface: SURFACE,
    executionAllowed: false,
    challenge: current.challenge,
    correlation: current.correlation,
    deferredToolUse: Object.freeze({
      name: SURFACE,
      deferredCallId,
      questions: current.questions,
    }),
  });
}

/**
 * Bind one exact active-host return or deferred resume to the issued shared
 * challenge. The returned challenge is still permanently non-authorizing.
 */
export function claimClaudeAskUserQuestionReturn(decision, request, hostReturn = {}) {
  assertValidDecision(decision);
  const current = requestState(request, decision);
  const deferred = current.deferredCallId !== null;
  const returned = exactKeys(hostReturn, deferred ? [...RETURN_FIELDS, "deferredCallId"] : RETURN_FIELDS, "host return");
  const expectedKind = deferred ? "deferred_resume" : "active_host_return";
  if (returned.returnKind !== expectedKind || returned.runtime !== RUNTIME || returned.surface !== SURFACE) {
    fail("host return kind or native surface does not match the request state");
  }
  const sessionRef = assertNativeDecisionOpaqueRef(returned.sessionRef);
  if (sessionRef !== current.correlation.sessionRef) fail("host return session does not match the request");
  if (deferred && assertNativeDecisionOpaqueRef(returned.deferredCallId) !== current.deferredCallId) {
    fail("deferred resume does not match its deferred call");
  }
  const claimed = claimNativeDecisionChallenge(decision, current.challenge, {
    runtime: returned.runtime,
    surface: returned.surface,
    challengeRef: returned.challengeRef,
    challengeDigest: returned.challengeDigest,
    decisionId: returned.decisionId,
    presentedRevision: returned.presentedRevision,
    runId: returned.runId,
    requestRef: returned.requestRef,
    optionSetDigest: returned.optionSetDigest,
    evidenceSetDigest: returned.evidenceSetDigest,
    presentationDigest: returned.presentationDigest,
    claimedAt: returned.claimedAt,
    selectedOptionId: returned.selectedOptionId,
  });
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    status: "host_answer_claimed",
    runtime: RUNTIME,
    surface: SURFACE,
    returnKind: returned.returnKind,
    correlation: current.correlation,
    challenge: claimed,
    executionAllowed: false,
  });
}
