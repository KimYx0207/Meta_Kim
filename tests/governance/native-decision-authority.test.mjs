import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNativeDecisionOpaqueRef,
  assertValidNativeDecisionChallenge,
  claimNativeDecisionChallenge,
  expireNativeDecisionChallenge,
  invalidateNativeDecisionChallenge,
  issueNativeDecisionChallenge,
  NATIVE_DECISION_AUTHORITY_SCHEMA_VERSION,
  nativeDecisionAuthorityGate,
} from "../../src/domain/decision/native-decision-authority.mjs";
import {
  createDecision,
  presentDecision,
} from "../../src/domain/decision/decision.mjs";

const CREATED_AT = "2026-08-09T00:00:00.000Z";
const PRESENTED_AT = "2026-08-09T00:01:00.000Z";
const ISSUED_AT = "2026-08-09T00:01:30.000Z";
const EXPIRES_AT = "2026-08-09T00:02:30.000Z";
const CLAIMED_AT = "2026-08-09T00:02:00.000Z";

function decisionFixture(overrides = {}) {
  return {
    identity: {
      runId: "run:native-authority-42",
      taskFingerprint: "digest:native-authority-task",
      decisionKey: "decision:native-choice",
      scopeRef: "scope:native-authority",
    },
    routeChangingDimensions: ["scope", "permission"],
    evidence: [
      { evidenceRef: "evidence:caller-map", digest: "sha256:caller-map" },
      { evidenceRef: "evidence:risk-map", digest: "sha256:risk-map" },
    ],
    options: [
      {
        optionId: "option:preserve",
        displayRef: "display:preserve",
        tradeoffRefs: ["tradeoff:maintenance"],
        evidenceRefs: ["evidence:caller-map"],
      },
      {
        optionId: "option:migrate",
        displayRef: "display:migrate",
        tradeoffRefs: ["tradeoff:migration"],
        evidenceRefs: ["evidence:caller-map", "evidence:risk-map"],
      },
    ],
    recommendation: {
      optionId: "option:preserve",
      rationaleRef: "rationale:compatibility",
      evidenceRefs: ["evidence:caller-map"],
    },
    requirement: {
      required: true,
      reasonRef: "reason:native-choice-required",
      evidenceRefs: ["evidence:caller-map"],
    },
    nativeSurface: {
      runtime: "codex",
      surface: "request_user_input",
      primary: true,
    },
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function presentedDecision(overrides = {}) {
  return presentDecision(createDecision(decisionFixture(overrides)), { at: PRESENTED_AT });
}

function issue(decision, overrides = {}) {
  return issueNativeDecisionChallenge(decision, {
    runtime: "codex",
    surface: "request_user_input",
    challengeRef: "challenge:native-authority-42",
    requestRef: "request:native-authority-42",
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    ...overrides,
  });
}

function claimInput(challenge, overrides = {}) {
  return {
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
    claimedAt: CLAIMED_AT,
    selectedOptionId: "option:preserve",
    ...overrides,
  };
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

test("issuance requires the exact current presented Decision and native surface", () => {
  const pending = createDecision(decisionFixture());
  assert.throws(() => issue(pending), /presented Decision/i);

  const presented = presentDecision(pending, { at: PRESENTED_AT });
  const challenge = issue(presented);

  assert.equal(challenge.schemaVersion, NATIVE_DECISION_AUTHORITY_SCHEMA_VERSION);
  assert.equal(challenge.state, "issued");
  assert.equal(challenge.decisionId, presented.decisionId);
  assert.equal(challenge.presentedRevision, presented.revision);
  assert.equal(challenge.runId, presented.identity.runId);
  assert.equal(challenge.runtime, presented.nativeSurface.runtime);
  assert.equal(challenge.surface, presented.nativeSurface.surface);
  assert.match(challenge.optionSetDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(challenge.evidenceSetDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(challenge.presentationDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(challenge.issuedAt, ISSUED_AT);
  assert.equal(challenge.expiresAt, EXPIRES_AT);
  assert.equal(Object.isFrozen(challenge), true);
  assert.equal(Object.isFrozen(challenge.events), true);
  const validated = assertValidNativeDecisionChallenge(challenge, presented);
  assert.notEqual(validated, challenge);
  assert.deepEqual(validated, challenge);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.events), true);
  assert.equal(Object.isFrozen(validated.events[0]), true);

  assert.throws(() => issue(presented, { runtime: "claude", surface: "AskUserQuestion" }), /surface.*match/i);
  assert.throws(() => issue(presented, { surface: "AskUserQuestion" }), /registered native surface/i);
  assert.throws(() => issue(presented, { issuedAt: "2026-08-09T00:00:59.999Z" }), /window/i);
  assert.throws(() => issue(presented, { issuedAt: EXPIRES_AT }), /window/i);
});

test("Codex and Claude issuance produce deterministic canonical bindings", () => {
  const codex = presentedDecision();
  assert.deepEqual(issue(codex), issue(codex));

  const reordered = presentedDecision({
    identity: Object.fromEntries(Object.entries(decisionFixture().identity).reverse()),
    routeChangingDimensions: [...decisionFixture().routeChangingDimensions].reverse(),
    evidence: [...decisionFixture().evidence].reverse(),
    options: [...decisionFixture().options].reverse(),
  });
  assert.equal(issue(reordered).challengeDigest, issue(codex).challengeDigest);

  const claude = presentedDecision({
    identity: { ...decisionFixture().identity, runId: "run:native-authority-claude" },
    nativeSurface: { runtime: "claude", surface: "AskUserQuestion", primary: true },
  });
  const claudeChallenge = issue(claude, {
    runtime: "claude",
    surface: "AskUserQuestion",
    challengeRef: "challenge:native-authority-claude",
    requestRef: "request:native-authority-claude",
  });
  assert.equal(claudeChallenge.runtime, "claude");
  assert.equal(claudeChallenge.surface, "AskUserQuestion");
  assert.equal(nativeDecisionAuthorityGate(claudeChallenge).executionAllowed, false);
});

test("an issued challenge can record one exact current host claim but never authorize execution", () => {
  const decision = presentedDecision();
  const issued = issue(decision);
  const claimed = claimNativeDecisionChallenge(decision, issued, claimInput(issued));

  assert.equal(claimed.state, "host_answer_claimed");
  assert.equal(claimed.claimedAt, CLAIMED_AT);
  assert.equal(claimed.selectedOptionId, "option:preserve");
  assert.equal(claimed.presentationDigest, issued.presentationDigest);
  assert.equal(claimed.events.length, 2);
  assert.equal(nativeDecisionAuthorityGate(issued).executionAllowed, false);
  assert.equal(nativeDecisionAuthorityGate(claimed).executionAllowed, false);
  assert.equal(nativeDecisionAuthorityGate(claimed).blockedReason, "native_decision_host_answer_claimed_not_executable");

  assert.throws(() => claimNativeDecisionChallenge(decision, claimed, claimInput(claimed)), /not eligible/i);
  assert.throws(() => expireNativeDecisionChallenge(claimed, { at: EXPIRES_AT }), /cannot expire/i);
});

test("stale, before-issued, expired, duplicate, and replayed claims fail closed", () => {
  const decision = presentedDecision();
  const issued = issue(decision);

  for (const claimedAt of [
    "2026-08-09T00:01:29.000Z",
    EXPIRES_AT,
    "2026-08-09T00:02:31.000Z",
  ]) {
    assert.throws(() => claimNativeDecisionChallenge(decision, issued, claimInput(issued, { claimedAt })), /exactly match|binding/i);
  }

  const expired = expireNativeDecisionChallenge(issued, { at: EXPIRES_AT });
  assert.equal(expired.state, "expired");
  assert.equal(nativeDecisionAuthorityGate(expired).executionAllowed, false);
  assert.throws(() => claimNativeDecisionChallenge(decision, expired, claimInput(expired)), /not eligible/i);
  assert.throws(() => expireNativeDecisionChallenge(expired, { at: "2026-08-09T00:03:00.000Z" }), /cannot expire/i);
  assert.throws(() => expireNativeDecisionChallenge(issued, { at: "2026-08-09T00:02:29.999Z" }), /before.*expiry/i);
});

test("cross-decision, revision, runtime, surface, option, evidence, and request mismatches fail", () => {
  const decision = presentedDecision();
  const issued = issue(decision);
  const otherDecision = presentedDecision({
    identity: { ...decisionFixture().identity, runId: "run:native-authority-other" },
  });

  assert.throws(() => claimNativeDecisionChallenge(otherDecision, issued, claimInput(issued)), /bind.*Decision/i);

  for (const forged of [
    { decisionId: otherDecision.decisionId },
    { presentedRevision: issued.presentedRevision + 1 },
    { runId: "run:native-authority-other" },
    { runtime: "claude", surface: "AskUserQuestion" },
    { surface: "AskUserQuestion" },
    { challengeRef: "challenge:forged" },
    { challengeDigest: `sha256:${"0".repeat(64)}` },
    { requestRef: "request:forged" },
    { optionSetDigest: `sha256:${"1".repeat(64)}` },
    { evidenceSetDigest: `sha256:${"2".repeat(64)}` },
    { presentationDigest: `sha256:${"3".repeat(64)}` },
    { selectedOptionId: "option:invented" },
  ]) {
    assert.throws(() => claimNativeDecisionChallenge(decision, issued, claimInput(issued, forged)), /exactly match|registered native surface|selected option/i);
  }
});

test("invalidation is terminal, chronological, and remains non-authorizing", () => {
  const decision = presentedDecision();
  const issued = issue(decision);
  const invalidatedIssued = invalidateNativeDecisionChallenge(issued, {
    at: "2026-08-09T00:02:01.000Z",
    reasonRef: "reason:decision-changed",
  });
  assert.equal(invalidatedIssued.state, "invalidated");
  assert.equal(nativeDecisionAuthorityGate(invalidatedIssued).executionAllowed, false);
  assert.throws(() => invalidateNativeDecisionChallenge(invalidatedIssued, {
    at: "2026-08-09T00:02:02.000Z",
    reasonRef: "reason:duplicate",
  }), /legal single transition/i);

  const claimed = claimNativeDecisionChallenge(decision, issued, claimInput(issued));
  const invalidatedClaim = invalidateNativeDecisionChallenge(claimed, {
    at: "2026-08-09T00:02:01.000Z",
    reasonRef: "reason:evidence-changed",
  });
  assert.equal(invalidatedClaim.events.length, 3);
  assert.equal(invalidatedClaim.selectedOptionId, "option:preserve");
  assert.equal(nativeDecisionAuthorityGate(invalidatedClaim).executionAllowed, false);
  assert.throws(() => invalidateNativeDecisionChallenge(issued, {
    at: "2026-08-09T00:01:29.000Z",
    reasonRef: "reason:before-issuance",
  }), /legal single transition/i);
});

test("the authority module exports no verified-answer or execution-authorizing surface", async () => {
  const module = await import("../../src/domain/decision/native-decision-authority.mjs");
  for (const forbidden of [
    "answerDecision",
    "verifyAnswer",
    "authorizeExecution",
    "issueExecutionAuthority",
    "answered_verified",
  ]) {
    assert.equal(Object.hasOwn(module, forbidden), false, forbidden);
  }

  const decision = presentedDecision();
  const issued = issue(decision);
  const claimed = claimNativeDecisionChallenge(decision, issued, claimInput(issued));
  const expired = expireNativeDecisionChallenge(issued, { at: EXPIRES_AT });
  const invalidated = invalidateNativeDecisionChallenge(issued, {
    at: "2026-08-09T00:02:01.000Z",
    reasonRef: "reason:invalidated",
  });
  for (const challenge of [issued, claimed, expired, invalidated]) {
    assert.equal(nativeDecisionAuthorityGate(challenge).executionAllowed, false);
    assert.doesNotMatch(JSON.stringify(challenge), /answered_verified|executionAllowed/i);
  }
});

test("raw prompt, raw answer, secrets, Unicode, and unknown fields never enter authority state", () => {
  const decision = presentedDecision();
  const validIssue = {
    runtime: "codex",
    surface: "request_user_input",
    challengeRef: "challenge:native-authority-42",
    requestRef: "request:native-authority-42",
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
  };
  for (const extra of [
    { rawPrompt: "retain this prompt" },
    { rawAnswer: "approve everything" },
    { secret: "sk-live-abcdef123456" },
  ]) {
    assert.throws(() => issueNativeDecisionChallenge(decision, { ...validIssue, ...extra }), /unsupported fields/i);
  }

  for (const value of [
    "claim:sk-live-abcdef123456",
    "request:bearer-token-value",
    "request:api-key-assignment",
    "request:password-assignment",
    "request:token-assignment",
    "claim:SK-LIVE-ABCDEF123456",
    "claim:\uFF53\uFF4B-live-abcdef123456",
  ]) {
    assert.throws(() => assertNativeDecisionOpaqueRef(value), /opaque reference/i, value);
  }

  const issued = issue(decision);
  assert.throws(() => claimNativeDecisionChallenge(decision, issued, {
    ...claimInput(issued),
    rawAnswer: "option:preserve",
  }), /unsupported fields/i);
  assert.doesNotMatch(JSON.stringify(issued), /retain this prompt|approve everything|sk-live/i);
});

test("prototype, symbol, hidden, sparse, and tampered canonical state fail closed", () => {
  const decision = presentedDecision();
  const inherited = Object.create({
    runtime: "codex",
    surface: "request_user_input",
    challengeRef: "challenge:inherited",
    requestRef: "request:inherited",
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
  });
  assert.throws(() => issueNativeDecisionChallenge(decision, inherited), /plain Object\.prototype/i);

  const symbolInput = {
    runtime: "codex",
    surface: "request_user_input",
    challengeRef: "challenge:symbol",
    requestRef: "request:symbol",
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    [Symbol("hidden")]: true,
  };
  assert.throws(
    () => issueNativeDecisionChallenge(decision, symbolInput),
    /enumerable string own data properties only/i,
  );

  const hiddenInput = {
    runtime: "codex",
    surface: "request_user_input",
    challengeRef: "challenge:hidden",
    requestRef: "request:hidden",
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
  };
  Object.defineProperty(hiddenInput, "rawPrompt", { value: "hidden", enumerable: false });
  assert.throws(
    () => issueNativeDecisionChallenge(decision, hiddenInput),
    /enumerable string own data properties only/i,
  );

  const issued = issue(decision);
  for (const tamper of [
    { decisionId: `decision-${"0".repeat(64)}` },
    { presentedRevision: issued.presentedRevision + 1 },
    { challengeDigest: `sha256:${"0".repeat(64)}` },
    { optionSetDigest: `sha256:${"1".repeat(64)}` },
    { evidenceSetDigest: `sha256:${"2".repeat(64)}` },
    { presentationDigest: `sha256:${"3".repeat(64)}` },
  ]) {
    assert.throws(() => assertValidNativeDecisionChallenge({ ...copy(issued), ...tamper }, decision), /binding|bind/i);
  }

  const sparseEvents = copy(issued);
  sparseEvents.events.length = 2;
  assert.throws(() => assertValidNativeDecisionChallenge(sparseEvents), /sparse entries/i);
});

test("strict sha256 opaque references remain valid", () => {
  const sha256Ref = `sha256:${"a".repeat(64)}`;
  assert.equal(assertNativeDecisionOpaqueRef(sha256Ref), sha256Ref);

  const decision = presentedDecision();
  const challenge = issue(decision, {
    challengeRef: sha256Ref,
    requestRef: `sha256:${"b".repeat(64)}`,
  });
  assert.equal(challenge.challengeRef, sha256Ref);
  const validated = assertValidNativeDecisionChallenge(challenge, decision);
  assert.notEqual(validated, challenge);
  assert.deepEqual(validated, challenge);
  assert.equal(Object.isFrozen(validated), true);
});
