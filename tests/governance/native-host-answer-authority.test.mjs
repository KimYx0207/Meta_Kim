import assert from "node:assert/strict";
import test from "node:test";

import { createDecision, presentDecision } from "../../src/domain/decision/decision.mjs";
import {
  claimNativeDecisionChallenge,
  issueNativeDecisionChallenge,
  nativeDecisionAuthorityGate,
} from "../../src/domain/decision/native-decision-authority.mjs";
import {
  assertValidNativeHostAnswerSubstrate,
  consumeNativeHostReturnObservedClaim,
  expireNativeHostAnswerSubstrate,
  invalidateNativeHostAnswerSubstrate,
  NATIVE_HOST_ANSWER_SUBSTRATE_SCHEMA_VERSION,
  NATIVE_HOST_ANSWER_SUBSTRATE_STATES,
  nativeHostAnswerSubstrateGate,
  recordNativeHostReturnObservedClaim,
  presentNativeHostAnswerSubstrate,
} from "../../src/domain/decision/native-host-answer-authority.mjs";
import { resolveCurrentHostHandoff } from "../../scripts/current-host-execution-authority.mjs";

const PRESENTED_AT = "2026-08-10T00:00:00.000Z";
const ISSUED_AT = "2026-08-10T00:00:10.000Z";
const OBSERVED_AT = "2026-08-10T00:00:20.000Z";
const CONSUMED_AT = "2026-08-10T00:00:21.000Z";
const EXPIRES_AT = "2026-08-10T00:01:00.000Z";
const DIGEST = (character) => `sha256:${character.repeat(64)}`;

function decisionFixture(runtime = "codex", overrides = {}) {
  const surface = runtime === "codex" ? "request_user_input" : "AskUserQuestion";
  return presentDecision(createDecision({
    identity: {
      runId: `run:host-authority-${runtime}`,
      taskFingerprint: `digest:host-authority-${runtime}`,
      decisionKey: "decision:native-route",
      scopeRef: "scope:host-authority",
    },
    routeChangingDimensions: ["scope", "permission"],
    evidence: [{ evidenceRef: "evidence:route", digest: "sha256:route" }],
    options: [
      {
        optionId: "option:preserve",
        displayRef: "display:preserve",
        tradeoffRefs: ["tradeoff:low-risk"],
        evidenceRefs: ["evidence:route"],
      },
      {
        optionId: "option:change",
        displayRef: "display:change",
        tradeoffRefs: ["tradeoff:migration"],
        evidenceRefs: ["evidence:route"],
      },
    ],
    requirement: {
      required: true,
      reasonRef: "reason:native-choice",
      evidenceRefs: ["evidence:route"],
    },
    nativeSurface: { runtime, surface, primary: true },
    createdAt: "2026-08-09T23:59:00.000Z",
    ...overrides,
  }), { at: PRESENTED_AT });
}

function challengeFixture(decision) {
  return issueNativeDecisionChallenge(decision, {
    runtime: decision.nativeSurface.runtime,
    surface: decision.nativeSurface.surface,
    challengeRef: `challenge:${decision.nativeSurface.runtime}-host-authority`,
    requestRef: `request:${decision.nativeSurface.runtime}-host-authority`,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
  });
}

function presentationInput(challenge, overrides = {}) {
  return {
    substrateRef: `substrate:${challenge.runtime}-fixture`,
    runtime: challenge.runtime,
    surface: challenge.surface,
    hostEventClaimRef: `event:${challenge.runtime}-fixture`,
    renderedHostPayloadDigest: DIGEST("a"),
    hostConnectionRef: `connection:${challenge.runtime}-fixture`,
    sessionOrThreadRef: `session:${challenge.runtime}-fixture`,
    turnRef: `turn:${challenge.runtime}-fixture`,
    itemRef: `item:${challenge.runtime}-fixture`,
    toolUseOrRequestRef: `request:${challenge.runtime}-fixture`,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    timeSourceClaimRef: "time:host-issued-fixture",
    ...overrides,
  };
}

function hostClaim(decision, challenge, overrides = {}) {
  return claimNativeDecisionChallenge(decision, challenge, {
    runtime: challenge.runtime,
    surface: challenge.surface,
    challengeRef: challenge.challengeRef,
    challengeDigest: challenge.challengeDigest,
    decisionId: challenge.decisionId,
    presentedRevision: challenge.presentedRevision,
    runId: challenge.runId,
    requestRef: challenge.requestRef,
    optionSetDigest: challenge.optionSetDigest,
    evidenceSetDigest: challenge.evidenceSetDigest,
    presentationDigest: challenge.presentationDigest,
    claimedAt: OBSERVED_AT,
    selectedOptionId: "option:preserve",
    ...overrides,
  });
}

function observationInput(authority, overrides = {}) {
  return {
    substrateRef: authority.substrateRef,
    substrateDigest: authority.substrateDigest,
    decisionId: authority.decisionId,
    presentedRevision: authority.presentedRevision,
    runId: authority.runId,
    challengeRef: authority.challengeRef,
    challengeDigest: authority.challengeDigest,
    runtime: authority.runtime,
    surface: authority.surface,
    hostEventClaimRef: authority.hostEventClaimRef,
    hostEventClaimDigest: authority.hostEventClaimDigest,
    renderedHostPayloadDigest: authority.renderedHostPayloadDigest,
    hostConnectionRef: authority.hostConnectionRef,
    sessionOrThreadRef: authority.sessionOrThreadRef,
    turnRef: authority.turnRef,
    itemRef: authority.itemRef,
    toolUseOrRequestRef: authority.toolUseOrRequestRef,
    issuedAt: authority.issuedAt,
    expiresAt: authority.expiresAt,
    at: OBSERVED_AT,
    timeSourceClaimRef: "time:host-return-fixture",
    hostReturnObservedClaimDigest: DIGEST("b"),
    ...overrides,
  };
}

function presentedAuthority(runtime = "codex") {
  const decision = decisionFixture(runtime);
  const challenge = challengeFixture(decision);
  const authority = presentNativeHostAnswerSubstrate(
    decision,
    challenge,
    presentationInput(challenge),
  );
  return { decision, challenge, authority };
}

function observedAuthority(runtime = "codex") {
  const fixture = presentedAuthority(runtime);
  const claimedChallenge = hostClaim(fixture.decision, fixture.challenge);
  const authority = recordNativeHostReturnObservedClaim(
    fixture.decision,
    claimedChallenge,
    fixture.authority,
    observationInput(fixture.authority),
  );
  return { ...fixture, claimedChallenge, authority };
}

function clone(value) {
  return structuredClone(value);
}

test("presentation binds the exact Decision, challenge, claimed host-context refs, time window, and rendered payload digest", () => {
  for (const runtime of ["codex", "claude"]) {
    const { decision, challenge, authority } = presentedAuthority(runtime);
    assert.equal(authority.schemaVersion, NATIVE_HOST_ANSWER_SUBSTRATE_SCHEMA_VERSION);
    assert.deepEqual(NATIVE_HOST_ANSWER_SUBSTRATE_STATES, [
      "presented",
      "host_return_observed",
      "consumed",
      "expired",
      "invalidated",
    ]);
    assert.equal(authority.state, "presented");
    assert.equal(authority.decisionId, decision.decisionId);
    assert.equal(authority.challengeDigest, challenge.challengeDigest);
    assert.equal(authority.hostEventClaimRef, `event:${runtime}-fixture`);
    assert.match(authority.hostEventClaimDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(authority.renderedHostPayloadDigest, DIGEST("a"));
    assert.equal(authority.hostConnectionRef, `connection:${runtime}-fixture`);
    assert.equal(authority.sessionOrThreadRef, `session:${runtime}-fixture`);
    assert.equal(authority.presentationTimeSourceClaimRef, "time:host-issued-fixture");
    assert.match(authority.substrateDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(Object.isFrozen(authority), true);
    assert.deepEqual(assertValidNativeHostAnswerSubstrate(authority, decision, challenge), authority);
    assert.equal(nativeHostAnswerSubstrateGate(authority).executionAllowed, false);
  }
});

test("one digest-only observed-return claim can be consumed once while every substrate and legacy gate remains false", () => {
  const { authority: observed, claimedChallenge } = observedAuthority();
  assert.equal(observed.state, "host_return_observed");
  assert.equal(observed.hostReturnObservedClaimDigest, DIGEST("b"));
  assert.equal(Object.hasOwn(observed, "rawAnswer"), false);
  assert.equal(nativeHostAnswerSubstrateGate(observed).executionAllowed, false);
  assert.equal(nativeDecisionAuthorityGate(claimedChallenge).executionAllowed, false);

  const consumed = consumeNativeHostReturnObservedClaim(observed, {
    at: CONSUMED_AT,
    timeSourceClaimRef: "time:consume-fixture",
    consumerRef: "consumer:execution-gate-fixture",
  });
  assert.equal(consumed.state, "consumed");
  assert.equal(consumed.revision, 2);
  assert.equal(consumed.hostReturnObservedClaimDigest, observed.hostReturnObservedClaimDigest);
  assert.equal(nativeHostAnswerSubstrateGate(consumed).executionAllowed, false);
  assert.equal(resolveCurrentHostHandoff({ routeCompatible: true }).executionAuthorized, false);
  assert.throws(
    () => consumeNativeHostReturnObservedClaim(consumed, {
      at: CONSUMED_AT,
      timeSourceClaimRef: "time:duplicate-consume",
      consumerRef: "consumer:duplicate",
    }),
    /not eligible|single consumption/u,
  );
  assert.doesNotMatch(JSON.stringify(consumed), /answered_verified|executionAllowed|executionAuthorized/iu);
});

test("replay and cross-runtime, session, request, decision, revision, option, payload, and host-return mismatches fail closed", () => {
  const { decision, challenge, authority } = presentedAuthority();
  const claimed = hostClaim(decision, challenge);
  const otherDecision = decisionFixture("codex", {
    identity: {
      ...decision.identity,
      runId: "run:host-authority-other",
    },
  });

  assert.throws(
    () => recordNativeHostReturnObservedClaim(otherDecision, claimed, authority, observationInput(authority)),
    /Decision|bind/u,
  );

  for (const mismatch of [
    { runtime: "claude", surface: "AskUserQuestion" },
    { sessionOrThreadRef: "session:other" },
    { turnRef: "turn:other" },
    { itemRef: "item:other" },
    { toolUseOrRequestRef: "request:other" },
    { decisionId: `decision-${"0".repeat(64)}` },
    { presentedRevision: authority.presentedRevision + 1 },
    { challengeDigest: DIGEST("c") },
    { hostEventClaimRef: "event:other" },
    { hostEventClaimDigest: DIGEST("9") },
    { renderedHostPayloadDigest: DIGEST("d") },
    { hostReturnObservedClaimDigest: DIGEST("e") },
  ]) {
    const candidate = observationInput(authority, mismatch);
    if (Object.hasOwn(mismatch, "hostReturnObservedClaimDigest")) {
      assert.equal(
        recordNativeHostReturnObservedClaim(decision, claimed, authority, candidate).hostReturnObservedClaimDigest,
        mismatch.hostReturnObservedClaimDigest,
        "a different raw host return is allowed only through its explicit digest",
      );
      continue;
    }
    assert.throws(
      () => recordNativeHostReturnObservedClaim(decision, claimed, authority, candidate),
      /match|surface|binding/u,
    );
  }

  assert.throws(
    () => hostClaim(decision, challenge, { selectedOptionId: "option:invented" }),
    /selected option/u,
  );
});

test("a bounded time-source claim is required at every transition and the validity window is half-open", () => {
  const { decision, challenge, authority } = presentedAuthority();
  const claimed = hostClaim(decision, challenge);
  for (const at of ["2026-08-10T00:00:09.999Z", EXPIRES_AT]) {
    assert.throws(
      () => recordNativeHostReturnObservedClaim(
        decision,
        claimed,
        authority,
        observationInput(authority, { at }),
      ),
      /validity window/u,
    );
  }
  assert.throws(
    () => recordNativeHostReturnObservedClaim(
      decision,
      claimed,
      authority,
      observationInput(authority, { timeSourceClaimRef: "" }),
    ),
    /opaque reference/u,
  );

  const expired = expireNativeHostAnswerSubstrate(authority, {
    at: EXPIRES_AT,
    timeSourceClaimRef: "time:expiry-fixture",
  });
  assert.equal(expired.state, "expired");
  assert.equal(nativeHostAnswerSubstrateGate(expired).executionAllowed, false);
  assert.throws(
    () => recordNativeHostReturnObservedClaim(decision, claimed, expired, observationInput(expired)),
    /presented (?:authority|substrate)/u,
  );
});

test("invalidation is terminal before and after observation and preserves non-authorizing history", () => {
  const presented = presentedAuthority();
  const invalidatedPresented = invalidateNativeHostAnswerSubstrate(presented.authority, {
    at: OBSERVED_AT,
    timeSourceClaimRef: "time:invalidation-fixture",
    reasonRef: "reason:decision-superseded",
  });
  assert.equal(invalidatedPresented.state, "invalidated");
  assert.equal(nativeHostAnswerSubstrateGate(invalidatedPresented).executionAllowed, false);

  const observed = observedAuthority();
  const invalidatedObserved = invalidateNativeHostAnswerSubstrate(observed.authority, {
    at: CONSUMED_AT,
    timeSourceClaimRef: "time:invalidation-after-observe",
    reasonRef: "reason:host-session-ended",
  });
  assert.equal(invalidatedObserved.state, "invalidated");
  assert.equal(invalidatedObserved.hostReturnObservedClaimDigest, DIGEST("b"));
  assert.throws(
    () => consumeNativeHostReturnObservedClaim(invalidatedObserved, {
      at: CONSUMED_AT,
      timeSourceClaimRef: "time:consume-invalidated",
      consumerRef: "consumer:invalidated",
    }),
    /not eligible/u,
  );
});

test("raw prompt, raw answer, secrets, and unknown authority fields are rejected without persistence", () => {
  const { decision, challenge } = presentedAuthority();
  for (const extra of [
    { rawPrompt: "Approve production" },
    { rawAnswer: "yes" },
    { secret: "sk-live-abcdef123456" },
    { executionAllowed: true },
  ]) {
    assert.throws(
      () => presentNativeHostAnswerSubstrate(
        decision,
        challenge,
        { ...presentationInput(challenge), ...extra },
      ),
      /unsupported fields/u,
    );
  }
  assert.throws(
    () => presentNativeHostAnswerSubstrate(
      decision,
      challenge,
      presentationInput(challenge, { hostConnectionRef: "connection:sk-live-abcdef123456" }),
    ),
    /opaque reference/u,
  );
  assert.throws(
    () => presentNativeHostAnswerSubstrate(
      decision,
      challenge,
      presentationInput(challenge, { hostEventClaimRef: "event:secret-private-value" }),
    ),
    /opaque reference/u,
  );
});

test("accessor, symbol, proxy, and sparse hostile inputs never execute caller getters or bypass data-only validation", () => {
  const { decision, challenge, authority } = presentedAuthority();
  const accessorInput = presentationInput(challenge);
  let getterCalls = 0;
  Object.defineProperty(accessorInput, "hostConnectionRef", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "connection:accessor";
    },
  });
  assert.throws(
    () => presentNativeHostAnswerSubstrate(decision, challenge, accessorInput),
    /data properties/u,
  );
  assert.equal(getterCalls, 0);

  const symbolInput = presentationInput(challenge);
  symbolInput[Symbol("rawAnswer")] = "yes";
  assert.throws(
    () => presentNativeHostAnswerSubstrate(decision, challenge, symbolInput),
    /unsupported fields|data properties/u,
  );

  let proxyGets = 0;
  const proxied = new Proxy(presentationInput(challenge), {
    get(target, property, receiver) {
      proxyGets += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.doesNotThrow(() => presentNativeHostAnswerSubstrate(decision, challenge, proxied));
  assert.equal(proxyGets, 0);

  const sparse = clone(authority);
  sparse.events.length = 2;
  assert.throws(
    () => assertValidNativeHostAnswerSubstrate(sparse),
    /sparse entries/u,
  );
});

test("tampering any immutable host binding or lifecycle digest invalidates the authority snapshot", () => {
  const { authority } = observedAuthority();
  for (const mutation of [
    { substrateDigest: DIGEST("f") },
    { hostEventClaimRef: "event:forged" },
    { hostEventClaimDigest: DIGEST("e") },
    { renderedHostPayloadDigest: DIGEST("c") },
    { hostConnectionRef: "connection:forged" },
    { sessionOrThreadRef: "session:forged" },
    { toolUseOrRequestRef: "request:forged" },
    { hostReturnObservedClaimDigest: DIGEST("d") },
  ]) {
    assert.throws(
      () => assertValidNativeHostAnswerSubstrate({ ...clone(authority), ...mutation }),
      /binding|history|invalid/u,
    );
  }
});
