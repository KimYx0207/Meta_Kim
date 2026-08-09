/**
 * Pure Codex request_user_input adapter.
 *
 * This module prepares a transient host payload and turns an already-normalized
 * host selection into the Decision domain's deliberately non-authorizing
 * `host_answer_claimed` transition. It never invokes a host tool, reads host
 * state, persists a prompt/answer, or mints a verification receipt.
 */

import { assertValidDecision } from "../../domain/decision/decision.mjs";
import {
  assertNativeDecisionOpaqueRef,
  assertValidNativeDecisionChallenge,
  claimNativeDecisionChallenge,
  issueNativeDecisionChallenge,
  nativeDecisionAuthorityGate,
} from "../../domain/decision/native-decision-authority.mjs";

const RUNTIME = "codex";
const SURFACE = "request_user_input";

function fail(message) { throw new TypeError(`Codex native decision surface: ${message}`); }
function plainRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain record`);
  }
  const ownKeys = Reflect.ownKeys(value);
  const snapshot = {};
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index];
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || descriptor?.enumerable !== true || !("value" in descriptor)) {
      fail(`${label} must contain enumerable string data properties only; accessors are unsupported`);
    }
    Object.defineProperty(snapshot, key, { value: descriptor.value, enumerable: true, writable: false, configurable: false });
  }
  return Object.freeze(snapshot);
}

function exactKeys(value, keys, label) {
  const snapshot = plainRecord(value, label);
  const allowed = new Set(keys);
  const ownKeys = Reflect.ownKeys(snapshot);
  for (let index = 0; index < ownKeys.length; index += 1) {
    if (!allowed.has(ownKeys[index])) fail(`${label} contains an unsupported field`);
  }
  return snapshot;
}

function strictPlainDenseArray(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(`${label} must be a strict plain array`);
  }
  const ownKeys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
    fail(`${label} must have a valid data length`);
  }
  const length = lengthDescriptor.value;
  const snapshot = new Array(length);
  let numericKeyCount = 0;
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index];
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
      fail(`${label} must contain only dense numeric entries`);
    }
    const numericIndex = Number(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (numericIndex >= length || descriptor?.enumerable !== true || !("value" in descriptor)) {
      fail(`${label} must contain only enumerable data entries`);
    }
    Object.defineProperty(snapshot, key, { value: descriptor.value, enumerable: true, writable: false, configurable: false });
    numericKeyCount += 1;
  }
  if (numericKeyCount !== length) fail(`${label} must not contain sparse entries`);
  return Object.freeze(snapshot);
}

function integer(value, label, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} must be an integer at least ${minimum}`);
  return value;
}

function range(value, label, { minimum = 0 } = {}) {
  const current = exactKeys(value, ["min", "max"], label);
  const min = integer(current.min, `${label}.min`, { minimum });
  const max = integer(current.max, `${label}.max`, { minimum });
  if (min > max) fail(`${label} must have min <= max`);
  return { min, max };
}

function activeSchema(value) {
  const current = exactKeys(value, ["runtime", "surface", "questions", "optionsPerQuestion", "textLimits"], "activeSchema");
  if (current.runtime !== RUNTIME || current.surface !== SURFACE) fail("activeSchema must describe the active Codex request_user_input surface");
  const textLimits = exactKeys(current.textLimits, ["header", "question", "optionLabel", "optionDescription"], "activeSchema.textLimits");
  return {
    runtime: RUNTIME,
    surface: SURFACE,
    questions: range(current.questions, "activeSchema.questions", { minimum: 1 }),
    optionsPerQuestion: range(current.optionsPerQuestion, "activeSchema.optionsPerQuestion", { minimum: 1 }),
    textLimits: {
      header: integer(textLimits.header, "activeSchema.textLimits.header", { minimum: 1 }),
      question: integer(textLimits.question, "activeSchema.textLimits.question", { minimum: 1 }),
      optionLabel: integer(textLimits.optionLabel, "activeSchema.textLimits.optionLabel", { minimum: 1 }),
      optionDescription: integer(textLimits.optionDescription, "activeSchema.textLimits.optionDescription", { minimum: 1 }),
    },
  };
}

function boundedText(value, label, maximum) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) fail(`${label} exceeds the active schema capability`);
  return value;
}

function presentation(value, decision, schema) {
  const current = exactKeys(value, ["questions"], "presentation");
  const questions = strictPlainDenseArray(current.questions, "presentation.questions");
  if (questions.length < schema.questions.min || questions.length > schema.questions.max) {
    fail("presentation.questions does not fit the active schema capability");
  }
  if (questions.length !== 1) fail("one Decision must map to exactly one Codex question");
  const question = exactKeys(questions[0], ["header", "question", "options"], "presentation.questions[0]");
  const inputOptions = strictPlainDenseArray(question.options, "presentation.questions[0].options");
  if (inputOptions.length < schema.optionsPerQuestion.min || inputOptions.length > schema.optionsPerQuestion.max) {
    fail("presentation option count does not fit the active schema capability");
  }
  const expected = new Set();
  for (let index = 0; index < decision.options.length; index += 1) expected.add(decision.options[index].optionId);
  const optionIds = new Set();
  const options = new Array(inputOptions.length);
  for (let index = 0; index < inputOptions.length; index += 1) {
    const option = exactKeys(inputOptions[index], ["optionId", "label", "description"], `presentation.questions[0].options[${index}]`);
    const optionId = assertNativeDecisionOpaqueRef(option.optionId);
    if (!expected.has(optionId) || optionIds.has(optionId)) fail("presentation options must exactly map to Decision options");
    optionIds.add(optionId);
    options[index] = {
      optionId,
      label: boundedText(option.label, `presentation.questions[0].options[${index}].label`, schema.textLimits.optionLabel),
      description: boundedText(option.description, `presentation.questions[0].options[${index}].description`, schema.textLimits.optionDescription),
    };
  }
  if (optionIds.size !== expected.size) fail("presentation options must exactly map to Decision options");
  const rendered = {
    questions: Object.freeze([Object.freeze({
      header: boundedText(question.header, "presentation.questions[0].header", schema.textLimits.header),
      question: boundedText(question.question, "presentation.questions[0].question", schema.textLimits.question),
      options: Object.freeze(options),
    })]),
  };
  validateRenderedPresentation(rendered, decision, schema);
  return rendered;
}

function validateRenderedPresentation(rendered, decision, schema) {
  const questions = strictPlainDenseArray(rendered.questions, "rendered.questions");
  if (questions.length !== 1 || questions.length < schema.questions.min || questions.length > schema.questions.max) {
    fail("rendered question count does not fit the active schema capability");
  }
  const expected = new Set();
  for (let index = 0; index < decision.options.length; index += 1) expected.add(decision.options[index].optionId);
  for (let questionIndex = 0; questionIndex < questions.length; questionIndex += 1) {
    const options = strictPlainDenseArray(questions[questionIndex].options, `rendered.questions[${questionIndex}].options`);
    if (options.length < schema.optionsPerQuestion.min || options.length > schema.optionsPerQuestion.max || options.length !== expected.size) {
      fail("rendered option count does not exactly match the Decision");
    }
    const seen = new Set();
    for (let optionIndex = 0; optionIndex < options.length; optionIndex += 1) {
      const optionId = assertNativeDecisionOpaqueRef(options[optionIndex].optionId);
      if (!expected.has(optionId) || seen.has(optionId)) fail("rendered optionIds do not exactly match the Decision");
      seen.add(optionId);
    }
    if (seen.size !== expected.size) fail("rendered optionIds do not exactly match the Decision");
  }
  return rendered;
}

function hostPayload(rendered, decision, schema) {
  validateRenderedPresentation(rendered, decision, schema);
  const questions = new Array(rendered.questions.length);
  for (let questionIndex = 0; questionIndex < rendered.questions.length; questionIndex += 1) {
    const renderedQuestion = rendered.questions[questionIndex];
    const options = new Array(renderedQuestion.options.length);
    for (let optionIndex = 0; optionIndex < renderedQuestion.options.length; optionIndex += 1) {
      const option = renderedQuestion.options[optionIndex];
      options[optionIndex] = Object.freeze({ label: option.label, description: option.description });
    }
    questions[questionIndex] = Object.freeze({
      header: renderedQuestion.header,
      question: renderedQuestion.question,
      options: Object.freeze(options),
    });
  }
  strictPlainDenseArray(questions, "payload.questions");
  for (let index = 0; index < questions.length; index += 1) strictPlainDenseArray(questions[index].options, `payload.questions[${index}].options`);
  return Object.freeze({ questions: Object.freeze(questions) });
}

/**
 * Prepare a transient request_user_input payload. `payload` is display data for
 * the host only; the returned shared challenge contains opaque refs and
 * digests, never prompt or option text.
 */
export function prepareCodexNativeDecisionSurface(input = {}) {
  const current = exactKeys(input, ["decision", "challengeRef", "activeSchema", "requestRef", "issuedAt", "expiresAt", "presentation"], "prepare input");
  assertValidDecision(current.decision);
  const decision = current.decision;
  if (decision.status !== "presented") fail("only a presented Decision may be prepared");
  if (decision.nativeSurface?.runtime !== RUNTIME || decision.nativeSurface?.surface !== SURFACE) fail("Decision must require Codex request_user_input");
  const schema = activeSchema(current.activeSchema);
  const rendered = presentation(current.presentation, decision, schema);
  const currentChallenge = issueNativeDecisionChallenge(decision, {
    runtime: RUNTIME,
    surface: SURFACE,
    challengeRef: assertNativeDecisionOpaqueRef(current.challengeRef),
    requestRef: assertNativeDecisionOpaqueRef(current.requestRef),
    issuedAt: current.issuedAt,
    expiresAt: current.expiresAt,
  });
  assertValidNativeDecisionChallenge(currentChallenge, decision);
  return Object.freeze({
    executionAllowed: false,
    payload: hostPayload(rendered, decision, schema),
    challenge: currentChallenge,
  });
}

/**
 * Normalize a host-returned selected option into a non-authorizing claim.
 * The caller supplies no raw answer: only the selected Decision option and the
 * original challenge. This remains non-executable even when every binding
 * matches.
 */
export function claimCodexNativeDecisionSurfaceReturn(input = {}) {
  const current = exactKeys(input, ["decision", "challenge", "returnedSelection"], "claim input");
  assertValidDecision(current.decision);
  const decision = current.decision;
  if (decision.status !== "presented") fail("only a presented Decision may receive a host claim");
  assertValidNativeDecisionChallenge(current.challenge, decision);
  const returnedSelection = exactKeys(current.returnedSelection, ["runtime", "surface", "challengeRef", "challengeDigest", "decisionId", "presentedRevision", "runId", "requestRef", "optionSetDigest", "evidenceSetDigest", "presentationDigest", "claimedAt", "selectedOptionId"], "returnedSelection");
  const selected = {
    ...returnedSelection,
    selectedOptionId: assertNativeDecisionOpaqueRef(returnedSelection.selectedOptionId),
  };
  const claimedChallenge = claimNativeDecisionChallenge(decision, current.challenge, selected);
  return Object.freeze({
    executionAllowed: false,
    challenge: claimedChallenge,
    authority: nativeDecisionAuthorityGate(claimedChallenge),
  });
}
