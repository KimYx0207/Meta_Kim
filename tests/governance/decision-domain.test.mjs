import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHostAnswerClaim,
  claimEvidenceTier,
  claimHostAnswer,
  createDecision,
  DECISION_STATUSES,
  decisionExecutionGate,
  deriveDecisionId,
  HOST_RECEIPT_ADAPTERS,
  invalidateDecision,
  isLegalDecisionTransition,
  materialDecisionChanges,
  presentDecision,
  assertValidDecision,
  transitionDecision,
} from "../../src/domain/decision/decision.mjs";
import {
  buildCardPlanPacketDecisionProjection,
  buildPreDecisionOptionFrameProjection,
  buildRouteGateDecisionProjection,
} from "../../src/domain/decision/legacy-decision-projection.mjs";

const CREATED_AT = "2026-08-09T00:00:00.000Z";
const PRESENTED_AT = "2026-08-09T00:01:00.000Z";
const CLAIMED_AT = "2026-08-09T00:02:00.000Z";

function fixture(overrides = {}) {
  return {
    identity: {
      runId: "run:decision-domain-42",
      taskFingerprint: "digest:task-decision-domain",
      decisionKey: "decision:compatibility-path",
      scopeRef: "scope:api-v1",
    },
    routeChangingDimensions: ["scope", "acceptance"],
    evidence: [
      { evidenceRef: "evidence:callers", digest: "sha256:callers" },
      { evidenceRef: "evidence:migration", digest: "sha256:migration" },
    ],
    options: [
      {
        optionId: "option:preserve",
        displayRef: "display:preserve-compatibility",
        tradeoffRefs: ["tradeoff:maintenance"],
        evidenceRefs: ["evidence:callers"],
      },
      {
        optionId: "option:remove",
        displayRef: "display:remove-endpoint",
        tradeoffRefs: ["tradeoff:migration"],
        evidenceRefs: ["evidence:callers", "evidence:migration"],
      },
    ],
    recommendation: {
      optionId: "option:preserve",
      rationaleRef: "rationale:safest-compatibility",
      evidenceRefs: ["evidence:callers"],
    },
    requirement: {
      required: true,
      reasonRef: "reason:route-choice-required",
      evidenceRefs: ["evidence:callers"],
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

function claim(decision, overrides = {}) {
  return buildHostAnswerClaim(decision, {
    source: "codex_request_user_input",
    requestRef: "request:decision-domain-42",
    claimRef: "claim:decision-domain-42",
    issuedAt: "2026-08-09T00:01:30.000Z",
    expiresAt: "2026-08-09T00:02:30.000Z",
    claimedAt: CLAIMED_AT,
    selectedOptionId: "option:preserve",
    answerDigest: "digest:host-answer",
    ...overrides,
  });
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertNoAuthority(value) {
  if (Array.isArray(value)) {
    value.forEach(assertNoAuthority);
    return;
  }
  if (value && typeof value === "object") {
    assert.equal(Object.hasOwn(value, "nativeAgentType"), false);
    assert.equal(Object.hasOwn(value, "answered"), false);
    Object.values(value).forEach(assertNoAuthority);
  }
}

test("v1 has no public answer or execution-authorizing API", async () => {
  const module = await import("../../src/domain/decision/decision.mjs");
  assert.equal(Object.hasOwn(module, "answerDecision"), false);
  assert.equal(Object.hasOwn(module, "buildHostReturnedReceipt"), false);
  assert.equal(DECISION_STATUSES.includes("answered"), false);

  const presented = presentDecision(createDecision(fixture()), { at: PRESENTED_AT });
  const claimed = claimHostAnswer(presented, { at: CLAIMED_AT, claim: claim(presented) });

  assert.equal(claimed.status, "host_answer_claimed");
  assert.equal(claimEvidenceTier(claimed), "host_answer_claimed");
  assert.equal(decisionExecutionGate(claimed).executionAllowed, false);
  assert.equal(decisionExecutionGate(claimed).blockedReason, "host_answer_claimed_not_verified");
  assertNoAuthority(claimed);
});

test("only legal claim-state transitions are permitted", () => {
  const pending = createDecision(fixture());
  const presented = presentDecision(pending, { at: PRESENTED_AT });

  assert.equal(isLegalDecisionTransition("presented", "host_answer_claimed"), true);
  assert.equal(isLegalDecisionTransition("host_answer_claimed", "invalidated"), true);
  assert.equal(isLegalDecisionTransition("pending", "host_answer_claimed"), false);
  assert.equal(isLegalDecisionTransition("host_answer_claimed", "presented"), false);
  assert.throws(() => claimHostAnswer(pending, { at: CLAIMED_AT, claim: {} }), /illegal transition/i);
  assert.throws(() => transitionDecision(presented, {
    toStatus: "host_answer_claimed",
    at: CLAIMED_AT,
  }), /requires claimHostAnswer|illegal/i);
  assert.throws(() => transitionDecision(presented, {
    toStatus: "answered",
    at: CLAIMED_AT,
  }), /illegal/i);
});

test("allowlisted Codex and Claude returns make only bound, non-authorizing claims", () => {
  const codexPresented = presentDecision(createDecision(fixture()), { at: PRESENTED_AT });
  const codexClaim = claim(codexPresented);
  const codexClaimed = claimHostAnswer(codexPresented, { at: CLAIMED_AT, claim: codexClaim });
  assert.equal(codexClaim.runtime, HOST_RECEIPT_ADAPTERS.codex_request_user_input.runtime);
  assert.equal(codexClaim.surface, HOST_RECEIPT_ADAPTERS.codex_request_user_input.surface);
  assert.equal(codexClaimed.hostAnswerClaim.claimRef, "claim:decision-domain-42");
  assert.equal(decisionExecutionGate(codexClaimed).executionAllowed, false);

  const claudePresented = presentDecision(createDecision(fixture({
    identity: { ...fixture().identity, runId: "run:decision-domain-claude" },
    nativeSurface: { runtime: "claude", surface: "AskUserQuestion", primary: true },
  })), { at: PRESENTED_AT });
  const claudeClaim = claim(claudePresented, {
    source: "claude_AskUserQuestion",
    requestRef: "request:claude-42",
    claimRef: "claim:claude-42",
  });
  const claudeClaimed = claimHostAnswer(claudePresented, { at: CLAIMED_AT, claim: claudeClaim });
  assert.equal(claudeClaimed.status, "host_answer_claimed");
  assert.equal(decisionExecutionGate(claudeClaimed).executionAllowed, false);
});

test("unknown, Unicode-lookalike, stale, and replayed claims fail closed", () => {
  const presented = presentDecision(createDecision(fixture()), { at: PRESENTED_AT });

  for (const source of ["unknown_host", "codex_request_user_input\uFF43li", "CODEX_REQUEST_USER_INPUT", "report"]) {
    assert.throws(() => claim(presented, { source }), /source|adapter|host/i, source);
  }

  const validClaim = claim(presented);
  const otherPresented = presentDecision(createDecision(fixture({
    identity: { ...fixture().identity, runId: "run:decision-domain-other" },
  })), { at: PRESENTED_AT });
  assert.throws(() => claimHostAnswer(otherPresented, { at: CLAIMED_AT, claim: validClaim }), /bind|claim/i);

  for (const forged of [
    { ...validClaim, decisionId: otherPresented.decisionId },
    { ...validClaim, revision: validClaim.revision + 1 },
    { ...validClaim, optionSetDigest: "0".repeat(64) },
    { ...validClaim, evidenceSetDigest: "1".repeat(64) },
    { ...validClaim, selectedOptionId: "option:invented" },
    { ...validClaim, claimedAt: "2026-08-09T00:01:29.000Z" },
    { ...validClaim, claimedAt: "2026-08-09T00:02:31.000Z" },
  ]) {
    assert.throws(() => claimHostAnswer(presented, { at: forged.claimedAt, claim: forged }), /claim|bind|option|window|timestamp/i);
  }
});

test("Decision identity is deterministic under canonical ordering and material changes invalidate it", () => {
  const base = fixture();
  const reordered = fixture({
    identity: Object.fromEntries(Object.entries(base.identity).reverse()),
    routeChangingDimensions: [...base.routeChangingDimensions].reverse(),
    evidence: [...base.evidence].reverse(),
    options: [...base.options].reverse(),
  });
  const decision = createDecision(base);
  assert.equal(decision.decisionId, createDecision(reordered).decisionId);
  assert.equal(deriveDecisionId({ identity: base.identity }), deriveDecisionId({ identity: reordered.identity }));

  const changedEvidence = [...decision.evidence, { evidenceRef: "evidence:rollout", digest: "sha256:rollout" }];
  assert.deepEqual(materialDecisionChanges(decision, { evidence: changedEvidence }).sort(), ["evidence"]);
  const invalidated = invalidateDecision(presentDecision(decision, { at: PRESENTED_AT }), {
    at: "2026-08-09T00:03:00.000Z",
    reasonRef: "reason:material-evidence-change",
    evidence: changedEvidence,
  });
  assert.equal(invalidated.decisionId, decision.decisionId);
  assert.equal(invalidated.status, "invalidated");
  assert.equal(decisionExecutionGate(invalidated).executionAllowed, false);
});

test("only opaque references are persisted; raw prompts, secrets, and free text reject", () => {
  const rawPrompt = "Please choose the best path and retain this user prompt.";
  const secret = "Authorization: Bearer sk-live-should-not-be-stored";

  for (const candidate of [
    fixture({ identity: { ...fixture().identity, rawPrompt } }),
    fixture({ options: fixture().options.map((option) => option.optionId === "option:preserve"
      ? { ...option, displayRef: rawPrompt }
      : option) }),
    fixture({ evidence: [{ evidenceRef: "evidence:secret", digest: secret }] }),
    fixture({ evidence: [{ evidenceRef: "evidence:callers", digest: "sha256:callers", summary: rawPrompt }] }),
  ]) {
    assert.throws(() => createDecision(candidate), /opaque|reference|supported|digest/i);
  }

  const decision = createDecision(fixture());
  assert.doesNotMatch(JSON.stringify(decision), /Please choose|Authorization|sk-live/i);
});

test("prefixed opaque references cannot smuggle secret-shaped values", () => {
  const presented = presentDecision(createDecision(fixture()), { at: PRESENTED_AT });
  const prefixedSecrets = [
    "claim:sk-live-abcdef123456",
    "digest:bearer-token-value",
    "evidence:api-key-assignment",
    "reason:password-assignment",
    "display:token-assignment",
    "claim:SK-LIVE-ABCDEF123456",
    "claim:\uFF53\uFF4b-live-abcdef123456",
  ];

  for (const secretRef of prefixedSecrets) {
    assert.throws(() => buildHostAnswerClaim(presented, {
      source: "codex_request_user_input",
      requestRef: secretRef,
      claimRef: secretRef,
      issuedAt: "2026-08-09T00:01:30.000Z",
      expiresAt: "2026-08-09T00:02:30.000Z",
      claimedAt: CLAIMED_AT,
      selectedOptionId: "option:preserve",
      answerDigest: secretRef,
    }), /secret|opaque|reference|digest/i, secretRef);
  }

  for (const persistedSecret of prefixedSecrets) {
    assert.throws(() => createDecision(fixture({
      evidence: [{ evidenceRef: "evidence:callers", digest: persistedSecret }],
    })), /secret|opaque|reference|digest/i, persistedSecret);
  }

  const sha256Ref = `sha256:${"a".repeat(64)}`;
  const accepted = createDecision(fixture({
    evidence: [{ evidenceRef: "evidence:callers", digest: sha256Ref }],
    options: [
      { optionId: "option:preserve", displayRef: "display:preserve", tradeoffRefs: ["tradeoff:maintenance"], evidenceRefs: ["evidence:callers"] },
      { optionId: "option:remove", displayRef: "display:remove", tradeoffRefs: ["tradeoff:migration"], evidenceRefs: ["evidence:callers"] },
    ],
    recommendation: { optionId: "option:preserve", rationaleRef: "rationale:preserve", evidenceRefs: ["evidence:callers"] },
    requirement: { required: true, reasonRef: "reason:choice", evidenceRefs: ["evidence:callers"] },
  }));
  assert.equal(accepted.evidence[0].digest, sha256Ref);
});

test("schema rejects unknown, prototype-only, tampered history, and invalidation fields", () => {
  assert.throws(() => createDecision({ ...fixture(), injected: true }), /supported/i);
  assert.throws(() => createDecision(Object.create(fixture())), /plain|Object\.prototype/i);
  assert.throws(() => createDecision(Object.assign(Object.create(null), fixture())), /plain|Object\.prototype/i);

  const decision = createDecision(fixture());
  const forgedHistory = copy(decision);
  forgedHistory.events.push({ type: "host_answer_claimed", at: CLAIMED_AT });
  assert.throws(() => assertValidDecision(forgedHistory), /claim|history|revision/i);

  const invalidated = invalidateDecision(presentDecision(decision, { at: PRESENTED_AT }), {
    at: "2026-08-09T00:03:00.000Z",
    reasonRef: "reason:material-evidence-change",
    evidence: [...decision.evidence, { evidenceRef: "evidence:changed", digest: "sha256:changed" }],
  });
  const forgedInvalidation = copy(invalidated);
  forgedInvalidation.invalidation.changed = ["owner"];
  assert.throws(() => assertValidDecision(forgedInvalidation), /invalidation|changed/i);
});

test("legacy projections retain one claim identity and cannot answer or authorize", () => {
  const presented = presentDecision(createDecision(fixture()), { at: PRESENTED_AT });
  const claimed = claimHostAnswer(presented, { at: CLAIMED_AT, claim: claim(presented) });
  const card = buildCardPlanPacketDecisionProjection(claimed);
  const frame = buildPreDecisionOptionFrameProjection(claimed);
  const route = buildRouteGateDecisionProjection(claimed);

  for (const projection of [card, frame, route]) {
    const boundary = projection.decisionDomain ?? projection;
    assert.equal(boundary.decisionId, claimed.decisionId);
    assert.equal(boundary.projectionOnly, true);
    assert.equal(boundary.cannotAnswerDecision, true);
    assert.equal(boundary.cannotAuthorizeExecution, true);
    assertNoAuthority(projection);
  }
  assert.equal(card.hostAnswerClaimRef, claimed.hostAnswerClaim.claimRef);
  assert.equal(frame.unresolvedQuestions[0].userAnswer, null);
  assert.equal(frame.executionAllowed, false);
  assert.equal(route.executionAllowed, false);
  assert.equal(route.blockedReason, "host_answer_claimed_not_verified");
});
