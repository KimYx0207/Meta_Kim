import assert from "node:assert/strict";
import test from "node:test";

import { createDecision, presentDecision } from "../../src/domain/decision/decision.mjs";
import {
  claimCodexNativeDecisionSurfaceReturn,
  prepareCodexNativeDecisionSurface,
} from "../../src/adapters/codex/native-decision-surface-adapter.mjs";

const PRESENTED_AT = "2026-08-09T00:01:00.000Z";
const ISSUED_AT = "2026-08-09T00:01:10.000Z";
const CLAIMED_AT = "2026-08-09T00:01:20.000Z";
const EXPIRES_AT = "2026-08-09T00:02:00.000Z";

function decision() {
  return presentDecision(createDecision({
    identity: { runId: "run:codex-adapter", taskFingerprint: "digest:task", decisionKey: "decision:route", scopeRef: "scope:test" },
    routeChangingDimensions: ["scope"],
    evidence: [{ evidenceRef: "evidence:route", digest: "sha256:route" }],
    options: [
      { optionId: "option:preserve", displayRef: "display:preserve", tradeoffRefs: ["tradeoff:low-risk"], evidenceRefs: ["evidence:route"] },
      { optionId: "option:change", displayRef: "display:change", tradeoffRefs: ["tradeoff:more-work"], evidenceRefs: ["evidence:route"] },
    ],
    requirement: { required: true, reasonRef: "reason:branch", evidenceRefs: ["evidence:route"] },
    nativeSurface: { runtime: "codex", surface: "request_user_input", primary: true },
    createdAt: "2026-08-09T00:00:00.000Z",
  }), { at: PRESENTED_AT });
}

function activeSchema(overrides = {}) {
  return {
    runtime: "codex",
    surface: "request_user_input",
    questions: { min: 1, max: 1 },
    optionsPerQuestion: { min: 2, max: 4 },
    textLimits: { header: 20, question: 80, optionLabel: 30, optionDescription: 80 },
    ...overrides,
  };
}

function prepare(overrides = {}) {
  return prepareCodexNativeDecisionSurface({
    decision: decision(),
    challengeRef: "challenge:codex-choice",
    activeSchema: activeSchema(),
    requestRef: "request:codex-choice",
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    presentation: {
      questions: [{
        header: "Route",
        question: "Choose a route.",
        options: [
          { optionId: "option:preserve", label: "Preserve", description: "Keep the current route." },
          { optionId: "option:change", label: "Change", description: "Take the new route." },
        ],
      }],
    },
    ...overrides,
  });
}

function returned(prepared, overrides = {}) {
  return {
    runtime: "codex",
    surface: "request_user_input",
    challengeRef: prepared.challenge.challengeRef,
    challengeDigest: prepared.challenge.challengeDigest,
    decisionId: prepared.challenge.decisionId,
    presentedRevision: prepared.challenge.presentedRevision,
    runId: prepared.challenge.runId,
    requestRef: prepared.challenge.requestRef,
    optionSetDigest: prepared.challenge.optionSetDigest,
    evidenceSetDigest: prepared.challenge.evidenceSetDigest,
    presentationDigest: prepared.challenge.presentationDigest,
    claimedAt: CLAIMED_AT,
    selectedOptionId: "option:preserve",
    ...overrides,
  };
}

test("prepares only a bounded active-schema payload and shared opaque challenge", () => {
  const prepared = prepare();
  assert.deepEqual(prepared.payload.questions, [{
    header: "Route",
    question: "Choose a route.",
    options: [
      { label: "Preserve", description: "Keep the current route." },
      { label: "Change", description: "Take the new route." },
    ],
  }]);
  assert.equal(prepared.challenge.runtime, "codex");
  assert.equal(prepared.challenge.surface, "request_user_input");
  assert.equal(prepared.challenge.state, "issued");
  assert.equal(prepared.executionAllowed, false);
  assert.match(prepared.challenge.challengeDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(prepared.challenge.optionSetDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(prepared.challenge.evidenceSetDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(prepared.challenge), /Choose|Preserve|current route/u);
  assert.throws(() => prepare({ activeSchema: activeSchema({ optionsPerQuestion: { min: 2, max: 1 } }) }), /schema capability|min <= max/u);
  assert.throws(() => prepare({ activeSchema: activeSchema({ optionsPerQuestion: { min: 2, max: 2 } }), presentation: { questions: [{ header: "Route", question: "Choose a route.", options: [{ optionId: "option:preserve", label: "Preserve", description: "Keep current." }, { optionId: "option:change", label: "Change", description: "New route." }, { optionId: "option:invented", label: "Invented", description: "Wrong." }] }] } }), /schema capability|exactly map/u);
});

test("presentation arrays reject method override injection before it can forge mapped options", () => {
  let overrideCalled = false;
  const validOptions = [
    { optionId: "option:preserve", label: "Preserve", description: "Keep current." },
    { optionId: "option:change", label: "Change", description: "Take new route." },
  ];
  Object.defineProperty(validOptions, "map", {
    enumerable: true,
    value(callback) {
      overrideCalled = true;
      callback(validOptions[0], 0, validOptions);
      callback(validOptions[1], 1, validOptions);
      return [{ optionId: "option:injected", label: "Injected", description: "Forged output." }];
    },
  });
  assert.throws(() => prepare({
    presentation: { questions: [{ header: "Route", question: "Choose a route.", options: validOptions }] },
  }), /plain|array|numeric|supported|method/u);
  assert.equal(overrideCalled, false, "validation must reject before invoking an overridden instance method");

  const questions = [{
    header: "Route",
    question: "Choose a route.",
    options: [
      { optionId: "option:preserve", label: "Preserve", description: "Keep current." },
      { optionId: "option:change", label: "Change", description: "Take new route." },
    ],
  }];
  Object.defineProperty(questions, "map", { enumerable: false, value: () => [] });
  assert.throws(() => prepare({ presentation: { questions } }), /plain|array|numeric|supported|method/u);
});

test("presentation arrays reject symbols, hidden extras, custom prototypes, accessors, and sparse entries", () => {
  function cleanQuestions() {
    return [{
      header: "Route",
      question: "Choose a route.",
      options: [
        { optionId: "option:preserve", label: "Preserve", description: "Keep current." },
        { optionId: "option:change", label: "Change", description: "Take new route." },
      ],
    }];
  }
  const candidates = [];

  const symbolExtra = cleanQuestions();
  symbolExtra[Symbol("extra")] = true;
  candidates.push(symbolExtra);

  const hiddenExtra = cleanQuestions();
  Object.defineProperty(hiddenExtra[0].options, "hidden", { enumerable: false, value: true });
  candidates.push(hiddenExtra);

  const customPrototype = cleanQuestions();
  Object.setPrototypeOf(customPrototype[0].options, Object.create(Array.prototype));
  candidates.push(customPrototype);

  const accessorIndex = cleanQuestions();
  const firstOption = accessorIndex[0].options[0];
  Object.defineProperty(accessorIndex[0].options, "0", { enumerable: true, get: () => firstOption });
  candidates.push(accessorIndex);

  const sparseOptions = cleanQuestions();
  sparseOptions[0].options = new Array(2);
  sparseOptions[0].options[0] = { optionId: "option:preserve", label: "Preserve", description: "Keep current." };
  candidates.push(sparseOptions);

  for (let index = 0; index < candidates.length; index += 1) {
    assert.throws(() => prepare({ presentation: { questions: candidates[index] } }), /array|dense|numeric|enumerable|data|sparse/u);
  }
});

test("prepare input and presentation records reject accessors without invoking them", () => {
  let inputGetterCalls = 0;
  const prepareInput = {
    decision: decision(),
    challengeRef: "challenge:codex-choice",
    activeSchema: activeSchema(),
    requestRef: "request:codex-choice",
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    presentation: {
      questions: [{
        header: "Route",
        question: "Choose a route.",
        options: [
          { optionId: "option:preserve", label: "Preserve", description: "Keep current." },
          { optionId: "option:change", label: "Change", description: "Take new route." },
        ],
      }],
    },
  };
  Object.defineProperty(prepareInput, "requestRef", {
    enumerable: true,
    get() {
      inputGetterCalls += 1;
      return "request:codex-choice";
    },
  });
  assert.throws(() => prepareCodexNativeDecisionSurface(prepareInput), /accessor|data propert|plain record/u);
  assert.equal(inputGetterCalls, 0);

  let presentationGetterCalls = 0;
  const questions = prepareInput.presentation.questions;
  const hostilePresentation = {};
  Object.defineProperty(hostilePresentation, "questions", {
    enumerable: true,
    get() {
      presentationGetterCalls += 1;
      return questions;
    },
  });
  assert.throws(() => prepare({ presentation: hostilePresentation }), /accessor|data propert|plain record/u);
  assert.equal(presentationGetterCalls, 0);
});

test("returnedSelection rejects accessor TOCTOU without invoking caller code", () => {
  const prepared = prepare();
  const selection = returned(prepared);
  let getterCalls = 0;
  Object.defineProperty(selection, "selectedOptionId", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return getterCalls === 1 ? "option:preserve" : "option:injected";
    },
  });
  assert.throws(() => claimCodexNativeDecisionSurfaceReturn({
    decision: decision(),
    challenge: prepared.challenge,
    returnedSelection: selection,
  }), /accessor|data propert|plain record/u);
  assert.equal(getterCalls, 0);
});

test("exact binding turns only a normalized option into a non-authorizing claim", () => {
  const prepared = prepare();
  const result = claimCodexNativeDecisionSurfaceReturn({
    decision: decision(),
    challenge: prepared.challenge,
    returnedSelection: returned(prepared),
  });
  assert.equal(result.challenge.state, "host_answer_claimed");
  assert.equal(result.challenge.selectedOptionId, "option:preserve");
  assert.equal(result.executionAllowed, false);
  assert.equal(result.authority.executionAllowed, false);
  assert.equal(result.authority.blockedReason, "native_decision_host_answer_claimed_not_executable");
  assert.equal(Object.hasOwn(result, "receipt"), false);
  assert.equal(Object.hasOwn(result, "executionAuthorized"), false);
  assert.doesNotMatch(JSON.stringify(result), /Choose a route|Keep the current route/u);
});

test("forged, stale, mismatched, and raw-answer returns fail closed", () => {
  const prepared = prepare();
  for (const overrides of [
    { requestRef: "request:other" },
    { challengeDigest: `sha256:${"b".repeat(64)}` },
    { presentedRevision: prepared.challenge.presentedRevision + 1 },
    { optionSetDigest: `sha256:${"c".repeat(64)}` },
    { selectedOptionId: "option:invented" },
    { claimedAt: "2026-08-09T00:02:01.000Z" },
  ]) {
    assert.throws(() => claimCodexNativeDecisionSurfaceReturn({ decision: decision(), challenge: prepared.challenge, returnedSelection: returned(prepared, overrides) }), /binding|option|expiry|claim/i);
  }
  assert.throws(() => claimCodexNativeDecisionSurfaceReturn({
    decision: decision(),
    challenge: prepared.challenge,
    returnedSelection: { ...returned(prepared), rawAnswer: "I choose preserve" },
  }), /unsupported field/u);
});

test("secret-shaped or Unicode-normalized correlation refs reject without echoing input", () => {
  for (const requestRef of [
    "request:sk-live-abcdef123456",
    "request:bearer-token-value",
    "request:api-key-value",
    "request:\uFF53\uFF4b-live-abcdef123456",
  ]) {
    assert.throws(() => prepare({ requestRef }), (error) => {
      assert.match(error.message, /bounded lowercase reference|strict digest/u);
      assert.equal(error.message.includes(requestRef), false);
      return true;
    });
  }
  assert.doesNotThrow(() => prepare({ requestRef: `sha256:${"d".repeat(64)}` }));
});

test("adapter has no host invocation, receipt, environment, CLI, or persistence API", async () => {
  const module = await import("../../src/adapters/codex/native-decision-surface-adapter.mjs");
  for (const forbidden of ["invokeRequestUserInput", "mintReceipt", "verifyReceipt", "readEnvironment", "readCli", "writeArtifact"]) {
    assert.equal(Object.hasOwn(module, forbidden), false, forbidden);
  }
});
