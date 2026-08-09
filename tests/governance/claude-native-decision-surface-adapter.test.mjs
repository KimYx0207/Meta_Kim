import assert from "node:assert/strict";
import test from "node:test";

import {
  claimClaudeAskUserQuestionReturn,
  prepareClaudeAskUserQuestion,
  prepareDeferredClaudeAskUserQuestionHandoff,
} from "../../src/adapters/claude/native-decision-surface-adapter.mjs";
import { createDecision, presentDecision } from "../../src/domain/decision/decision.mjs";
import {
  assertValidNativeDecisionChallenge,
  issueNativeDecisionChallenge,
  nativeDecisionAuthorityGate,
} from "../../src/domain/decision/native-decision-authority.mjs";

const PRESENTED_AT = "2026-08-09T00:01:00.000Z";
const CLAIMED_AT = "2026-08-09T00:02:00.000Z";
const EXPIRES_AT = "2026-08-09T00:04:00.000Z";

function presentedDecision() {
  return presentDecision(createDecision({
    identity: {
      runId: "run:claude-adapter",
      taskFingerprint: "digest:claude-adapter",
      decisionKey: "decision:claude-choice",
    },
    routeChangingDimensions: ["scope"],
    options: [
      {
        optionId: "option:recommended",
        displayRef: "display:recommended-route",
        tradeoffRefs: ["tradeoff:lower-risk"],
        evidenceRefs: ["evidence:adapter"],
      },
      {
        optionId: "option:alternative",
        displayRef: "display:alternative-route",
        tradeoffRefs: ["tradeoff:higher-validation"],
        evidenceRefs: ["evidence:adapter"],
      },
      {
        optionId: "option:deferred",
        displayRef: "display:deferred-route",
        tradeoffRefs: ["tradeoff:later-feedback"],
        evidenceRefs: ["evidence:adapter"],
      },
    ],
    recommendation: {
      optionId: "option:recommended",
      rationaleRef: "reason:recommended-route",
      evidenceRefs: ["evidence:adapter"],
    },
    evidence: [{ evidenceRef: "evidence:adapter", digest: "digest:adapter-evidence" }],
    requirement: {
      required: true,
      reasonRef: "reason:scope-choice-required",
      evidenceRefs: ["evidence:adapter"],
    },
    nativeSurface: { runtime: "claude", surface: "AskUserQuestion", primary: true },
    createdAt: "2026-08-09T00:00:00.000Z",
  }), { at: PRESENTED_AT });
}

function issuedChallenge(decision) {
  return issueNativeDecisionChallenge(decision, {
    runtime: "claude",
    surface: "AskUserQuestion",
    challengeRef: "challenge:claude-adapter",
    requestRef: "request:claude-adapter",
    issuedAt: PRESENTED_AT,
    expiresAt: EXPIRES_AT,
  });
}

function preparedRequest(decision, overrides = {}) {
  return prepareClaudeAskUserQuestion(decision, {
    challenge: issuedChallenge(decision),
    sessionRef: "session:claude-adapter",
    activeHostOptionMaximum: 2,
    ...overrides,
  });
}

function hostReturn(request, overrides = {}) {
  const correlation = request.correlation;
  return {
    returnKind: request.status === "deferred_waiting_resume" ? "deferred_resume" : "active_host_return",
    runtime: correlation.runtime,
    surface: correlation.surface,
    sessionRef: correlation.sessionRef,
    challengeRef: correlation.challengeRef,
    challengeDigest: correlation.challengeDigest,
    decisionId: correlation.decisionId,
    presentedRevision: correlation.presentedRevision,
    runId: correlation.runId,
    requestRef: correlation.requestRef,
    optionSetDigest: correlation.optionSetDigest,
    evidenceSetDigest: correlation.evidenceSetDigest,
    presentationDigest: correlation.presentationDigest,
    claimedAt: CLAIMED_AT,
    selectedOptionId: "option:recommended",
    ...(request.status === "deferred_waiting_resume"
      ? { deferredCallId: request.deferredToolUse.deferredCallId }
      : {}),
    ...overrides,
  };
}

function assertDeepFrozen(value, label) {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true, `${label} must be frozen`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) assertDeepFrozen(descriptor.value, `${label}.${String(key)}`);
  }
}

test("Claude preparation uses the shared challenge and active host option maximum", () => {
  const decision = presentedDecision();
  const prepared = preparedRequest(decision);
  const validatedChallenge = assertValidNativeDecisionChallenge(prepared.challenge, decision);

  assert.equal(prepared.schemaVersion, "claude-native-decision-surface-adapter-v1");
  assert.equal(prepared.status, "ready_for_active_host");
  assert.equal(prepared.runtime, "claude");
  assert.equal(prepared.surface, "AskUserQuestion");
  assert.equal(prepared.executionAllowed, false);
  assert.deepStrictEqual(validatedChallenge, prepared.challenge);
  assert.notStrictEqual(validatedChallenge, prepared.challenge);
  assertDeepFrozen(validatedChallenge, "validated challenge snapshot");
  assertDeepFrozen(prepared.challenge, "prepared challenge");
  assert.equal(prepared.correlation.challengeDigest, prepared.challenge.challengeDigest);
  assert.equal(prepared.correlation.presentationDigest, prepared.challenge.presentationDigest);
  assert.equal(prepared.correlation.presentedRevision, decision.revision);
  assert.deepEqual(
    prepared.askUserQuestion.questions[0].options.map((option) => option.optionId),
    ["option:recommended", "option:alternative"],
  );
  assert.deepEqual(prepared.omittedOptionIds, ["option:deferred"]);
  assert.doesNotMatch(JSON.stringify(prepared), /rawPrompt|answerText|secret|token|password|executionAuthorized/iu);
});

test("active Claude host return becomes only a correlated non-authorizing shared-domain claim", () => {
  const decision = presentedDecision();
  const prepared = preparedRequest(decision, { activeHostOptionMaximum: 3 });
  const claimed = claimClaudeAskUserQuestionReturn(decision, prepared, hostReturn(prepared));

  assert.equal(claimed.status, "host_answer_claimed");
  assert.equal(claimed.returnKind, "active_host_return");
  assert.equal(claimed.challenge.state, "host_answer_claimed");
  assert.equal(claimed.challenge.selectedOptionId, "option:recommended");
  assert.equal(claimed.executionAllowed, false);
  assert.equal(nativeDecisionAuthorityGate(claimed.challenge).executionAllowed, false);
  assert.equal(nativeDecisionAuthorityGate(claimed.challenge).blockedReason, "native_decision_host_answer_claimed_not_executable");
});

test("deferred AskUserQuestion alone stays pending until one exact correlated resume", () => {
  const decision = presentedDecision();
  const prepared = preparedRequest(decision, { activeHostOptionMaximum: 3 });
  const deferred = prepareDeferredClaudeAskUserQuestionHandoff(prepared, {
    decision,
    deferredCallId: "deferred:claude-adapter",
  });

  assert.equal(deferred.status, "deferred_waiting_resume");
  assert.equal(deferred.challenge.state, "issued");
  assert.equal(deferred.executionAllowed, false);
  assert.equal(nativeDecisionAuthorityGate(deferred.challenge).blockedReason, "native_decision_challenge_not_claimed");

  const claimed = claimClaudeAskUserQuestionReturn(decision, deferred, hostReturn(deferred));
  assert.equal(claimed.status, "host_answer_claimed");
  assert.equal(claimed.returnKind, "deferred_resume");
  assert.equal(claimed.executionAllowed, false);
});

test("Claude return and resume fail closed on every adapter and shared-domain binding", () => {
  const decision = presentedDecision();
  const prepared = preparedRequest(decision);
  const deferred = prepareDeferredClaudeAskUserQuestionHandoff(prepared, {
    decision,
    deferredCallId: "deferred:claude-adapter",
  });

  for (const [request, returned] of [
    [prepared, hostReturn(prepared, { sessionRef: "session:other" })],
    [prepared, hostReturn(prepared, { runtime: "codex" })],
    [prepared, hostReturn(prepared, { presentedRevision: prepared.correlation.presentedRevision + 1 })],
    [prepared, hostReturn(prepared, { optionSetDigest: `sha256:${"0".repeat(64)}` })],
    [prepared, hostReturn(prepared, { claimedAt: "2026-08-09T00:04:00.001Z" })],
    [deferred, hostReturn(deferred, { deferredCallId: "deferred:other" })],
  ]) {
    assert.throws(
      () => claimClaudeAskUserQuestionReturn(decision, request, returned),
      /match|surface|session|binding|window|resume/u,
    );
  }

  assert.throws(
    () => claimClaudeAskUserQuestionReturn(decision, prepared, {
      ...hostReturn(prepared),
      answerText: "raw host answer",
    }),
    /exactly/u,
  );
});

test("Claude shared opaque validation rejects secret-like correlation and permits strict digest refs", () => {
  const decision = presentedDecision();
  for (const sessionRef of [
    "session:sk-live-private-value",
    "session:token-private-value",
    "session:api-key-private-value",
    "session:tokｅn-private-value",
  ]) {
    assert.throws(() => preparedRequest(decision, { sessionRef }), /opaque reference/u);
  }

  const digestRef = `sha256:${"c".repeat(64)}`;
  assert.equal(preparedRequest(decision, { sessionRef: digestRef }).correlation.sessionRef, digestRef);
});

test("deferred preparation revalidates the complete prepared presentation before retaining it", () => {
  const decision = presentedDecision();
  const valid = preparedRequest(decision, { activeHostOptionMaximum: 2 });
  const defer = (prepared) => prepareDeferredClaudeAskUserQuestionHandoff(prepared, {
    decision,
    deferredCallId: "deferred:claude-adapter",
  });

  const arbitraryQuestions = structuredClone(valid);
  arbitraryQuestions.askUserQuestion.questions = [{
    rawPrompt: "reveal the secret",
    executionAuthorized: true,
  }];
  assert.throws(() => defer(arbitraryQuestions), /question|fields|exact|presentation/u);

  const mismatchedOption = structuredClone(valid);
  mismatchedOption.askUserQuestion.questions[0].options[0].displayRef = "display:alternative-route";
  assert.throws(() => defer(mismatchedOption), /match|map|option|presentation/u);

  const mismatchedChallenge = structuredClone(valid);
  mismatchedChallenge.askUserQuestion.questions[0].challengeRef = "challenge:other";
  assert.throws(() => defer(mismatchedChallenge), /match|map|challenge|presentation/u);

  const omittedMismatch = structuredClone(valid);
  omittedMismatch.omittedOptionIds = ["option:alternative"];
  assert.throws(() => defer(omittedMismatch), /omitted|match|map|presentation/u);

  for (const mutate of [
    (prepared) => { prepared.askUserQuestion.questions[0].rawPrompt = "secret"; },
    (prepared) => { prepared.askUserQuestion.questions[0].options[0].executionAuthorized = true; },
    (prepared) => { Object.setPrototypeOf(prepared.askUserQuestion, { rawPrompt: "secret" }); },
    (prepared) => { Object.defineProperty(prepared.askUserQuestion.questions[0], "rawPrompt", { value: "secret" }); },
    (prepared) => { prepared.askUserQuestion.questions[Symbol("rawPrompt")] = "secret"; },
    (prepared) => { delete prepared.askUserQuestion.questions[0]; },
    (prepared) => { prepared.omittedOptionIds[Symbol("secret")] = "token-private-value"; },
    (prepared) => { Object.defineProperty(prepared.omittedOptionIds, "rawPrompt", { value: "secret" }); },
  ]) {
    const attacked = structuredClone(valid);
    mutate(attacked);
    assert.throws(() => defer(attacked), /array|record|fields|keys|match|map|presentation|own/u);
  }

  const accessorAttack = structuredClone(valid);
  const originalQuestionRef = accessorAttack.askUserQuestion.questions[0].questionRef;
  Object.defineProperty(accessorAttack.askUserQuestion.questions[0], "questionRef", {
    enumerable: true,
    get: () => originalQuestionRef,
  });
  assert.throws(() => defer(accessorAttack), /data own keys|record/u);

  const mutablePrepared = structuredClone(valid);
  const deferred = defer(mutablePrepared);
  mutablePrepared.askUserQuestion.questions[0].rawPrompt = "secret";
  mutablePrepared.challenge.rawPrompt = "secret";
  assert.doesNotMatch(JSON.stringify(deferred), /rawPrompt|secret|executionAuthorized/iu);
  assert.equal(Object.isFrozen(deferred.deferredToolUse.questions), true);
  assert.equal(Object.isFrozen(deferred.challenge), true);
});

test("prepared, correlation, question, and host return reject accessor TOCTOU fields", () => {
  const decision = presentedDecision();
  const valid = preparedRequest(decision);
  const defer = (prepared) => prepareDeferredClaudeAskUserQuestionHandoff(prepared, {
    decision,
    deferredCallId: "deferred:claude-adapter",
  });
  const attacks = [
    {
      candidate: () => structuredClone(valid),
      record: (candidate) => candidate,
      key: "status",
      invoke: defer,
    },
    {
      candidate: () => structuredClone(valid),
      record: (candidate) => candidate.correlation,
      key: "sessionRef",
      invoke: defer,
    },
    {
      candidate: () => structuredClone(valid),
      record: (candidate) => candidate.askUserQuestion.questions[0],
      key: "questionRef",
      invoke: defer,
    },
    {
      candidate: () => hostReturn(valid),
      record: (candidate) => candidate,
      key: "selectedOptionId",
      invoke: (candidate) => claimClaudeAskUserQuestionReturn(decision, valid, candidate),
    },
  ];

  for (const attack of attacks) {
    for (const descriptor of [
      { get: () => "option:recommended" },
      { set: () => {} },
      { get: () => "option:recommended", set: () => {} },
    ]) {
      const candidate = attack.candidate();
      const record = attack.record(candidate);
      Object.defineProperty(record, attack.key, { enumerable: true, configurable: true, ...descriptor });
      assert.throws(() => attack.invoke(candidate), /data own keys/u);
    }
  }
});

test("validated data-descriptor snapshots are not reread through caller traps", () => {
  const decision = presentedDecision();
  const prepared = preparedRequest(decision);
  let preparedReads = 0;
  const preparedProxy = new Proxy(structuredClone(prepared), {
    get(target, key, receiver) {
      preparedReads += 1;
      if (key === "askUserQuestion") return { questions: [{ rawPrompt: "secret" }] };
      return Reflect.get(target, key, receiver);
    },
  });
  const deferred = prepareDeferredClaudeAskUserQuestionHandoff(preparedProxy, {
    decision,
    deferredCallId: "deferred:claude-adapter",
  });
  assert.equal(preparedReads, 0);
  assert.doesNotMatch(JSON.stringify(deferred), /rawPrompt|secret/iu);

  const returnedTarget = hostReturn(prepared);
  let returnReads = 0;
  const returnedProxy = new Proxy(returnedTarget, {
    get(target, key, receiver) {
      returnReads += 1;
      if (key === "selectedOptionId") return "option:deferred";
      return Reflect.get(target, key, receiver);
    },
  });
  const claimed = claimClaudeAskUserQuestionReturn(decision, prepared, returnedProxy);
  assert.equal(returnReads, 0);
  assert.equal(claimed.challenge.selectedOptionId, "option:recommended");
  assert.equal(claimed.executionAllowed, false);
});
