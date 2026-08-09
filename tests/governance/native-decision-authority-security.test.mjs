import assert from "node:assert/strict";
import test from "node:test";

import { createDecision, presentDecision } from "../../src/domain/decision/decision.mjs";
import * as authority from "../../src/domain/decision/native-decision-authority.mjs";

const ISSUED_AT = "2026-08-09T00:01:00.000Z";
const CLAIMED_AT = "2026-08-09T00:02:00.000Z";
const EXPIRES_AT = "2026-08-09T00:04:00.000Z";
const AFTER_EXPIRY = "2026-08-09T00:05:00.000Z";
const SECRET_SENTINEL = "sk-live-structural-secret-123456789";

function presentedDecision(overrides = {}) {
  return presentDecision(createDecision({
    identity: {
      runId: "run:native-authority-security",
      taskFingerprint: "digest:native-authority-security",
      decisionKey: "decision:native-authority-security",
      ...overrides.identity,
    },
    routeChangingDimensions: overrides.routeChangingDimensions ?? ["scope"],
    options: [
      {
        optionId: "option:contained",
        displayRef: "display:contained-route",
        tradeoffRefs: ["tradeoff:lower-risk"],
        evidenceRefs: ["evidence:authority-test"],
      },
      {
        optionId: "option:expanded",
        displayRef: "display:expanded-route",
        tradeoffRefs: ["tradeoff:more-validation"],
        evidenceRefs: ["evidence:authority-test"],
      },
    ],
    recommendation: overrides.recommendation ?? {
      optionId: "option:contained",
      rationaleRef: "reason:contained-route",
      evidenceRefs: ["evidence:authority-test"],
    },
    evidence: [{
      evidenceRef: "evidence:authority-test",
      digest: `digest:${"a".repeat(64)}`,
    }],
    requirement: overrides.requirement ?? {
      required: true,
      reasonRef: "reason:material-route-choice",
      evidenceRefs: ["evidence:authority-test"],
    },
    nativeSurface: {
      runtime: overrides.runtime ?? "codex",
      surface: overrides.surface ?? "request_user_input",
      primary: true,
    },
    createdAt: "2026-08-09T00:00:00.000Z",
  }), { at: ISSUED_AT });
}

function issueInput(overrides = {}) {
  return {
    runtime: "codex",
    surface: "request_user_input",
    challengeRef: "challenge:native-authority-security",
    requestRef: "request:native-authority-security",
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

function issuedChallenge(decision = presentedDecision(), overrides = {}) {
  return authority.issueNativeDecisionChallenge(decision, issueInput(overrides));
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
    selectedOptionId: "option:contained",
    ...overrides,
  };
}

function clone(value) {
  return structuredClone(value);
}

function capturedError(operation) {
  try {
    operation();
  } catch (error) {
    return error;
  }
  assert.fail("expected operation to fail closed");
}

function assertNonAuthorizing(value, label) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /answered_verified|execution(?:Allowed|Authorized)\s*[:=]\s*true/iu, `${label} must not serialize verified authority`);
  if (value?.state) {
    const gate = authority.nativeDecisionAuthorityGate(value);
    assert.equal(gate.executionAllowed, false, `${label} must remain fail-closed`);
    assert.doesNotMatch(gate.state, /answered_verified/iu);
  }
}

test("public authority API exposes no verifier, receipt builder, answered_verified state, or permission grant", () => {
  assert.equal(authority.NATIVE_DECISION_AUTHORITY_SCHEMA_VERSION, "native-decision-authority-v1");
  assert.deepEqual(Object.keys(authority).sort(), [
    "NATIVE_DECISION_AUTHORITY_SCHEMA_VERSION",
    "assertNativeDecisionOpaqueRef",
    "assertValidNativeDecisionChallenge",
    "claimNativeDecisionChallenge",
    "expireNativeDecisionChallenge",
    "invalidateNativeDecisionChallenge",
    "issueNativeDecisionChallenge",
    "nativeDecisionAuthorityGate",
  ]);
  assert.equal(Object.keys(authority).some((name) => /verify|receipt|authorize|grant|answered/i.test(name)), false);

  const decision = presentedDecision();
  const issued = issuedChallenge(decision);
  const claimed = authority.claimNativeDecisionChallenge(decision, issued, claimInput(issued));
  const expired = authority.expireNativeDecisionChallenge(issuedChallenge(decision, {
    challengeRef: "challenge:expiry-case",
    requestRef: "request:expiry-case",
  }), { at: AFTER_EXPIRY });
  const invalidated = authority.invalidateNativeDecisionChallenge(claimed, {
    at: "2026-08-09T00:03:00.000Z",
    reasonRef: "reason:binding-changed",
  });

  assert.deepEqual([issued.state, claimed.state, expired.state, invalidated.state], [
    "issued",
    "host_answer_claimed",
    "expired",
    "invalidated",
  ]);
  for (const [label, value] of Object.entries({ issued, claimed, expired, invalidated })) {
    assertNonAuthorizing(value, label);
  }
});

test("generic caller proof, trusted flags, and CLI/env/card/report/artifact fields cannot mint authority", () => {
  const decision = presentedDecision();
  const forbiddenFields = [
    "trusted",
    "verified",
    "answered_verified",
    "executionAllowed",
    "executionAuthorized",
    "hostProof",
    "hostReceipt",
    "receiptBuilder",
    "source",
    "sessionRef",
    "eventId",
    "env",
    "cli",
    "card",
    "report",
    "artifact",
    "observerArtifactPath",
    "observerArtifactSha256",
  ];

  for (const field of forbiddenFields) {
    const error = capturedError(() => authority.issueNativeDecisionChallenge(decision, {
      ...issueInput(),
      [field]: `${field}:${SECRET_SENTINEL}`,
    }));
    assert.match(error.message, /unsupported fields|record/u, field);
    assert.doesNotMatch(error.message, new RegExp(SECRET_SENTINEL, "u"), `${field} error must not echo caller material`);
  }

  const challenge = issuedChallenge(decision);
  for (const field of forbiddenFields) {
    const error = capturedError(() => authority.claimNativeDecisionChallenge(decision, challenge, {
      ...claimInput(challenge),
      [field]: `${field}:${SECRET_SENTINEL}`,
    }));
    assert.match(error.message, /unsupported fields|record/u, field);
    assert.doesNotMatch(error.message, new RegExp(SECRET_SENTINEL, "u"), `${field} error must not echo caller material`);
  }
  assertNonAuthorizing(challenge, "untrusted caller challenge");
});

test("cross challenge, run, decision, revision, option-set, evidence-set, and runtime replay fail closed", () => {
  const decision = presentedDecision();
  const challenge = issuedChallenge(decision);
  const otherChallenge = issuedChallenge(decision, {
    challengeRef: "challenge:other",
    requestRef: "request:other",
  });
  const otherDecision = presentedDecision({
    identity: {
      runId: "run:native-authority-other",
      taskFingerprint: "digest:native-authority-other",
      decisionKey: "decision:native-authority-other",
    },
  });

  const substitutions = [
    { challengeRef: otherChallenge.challengeRef },
    { challengeDigest: otherChallenge.challengeDigest },
    { requestRef: otherChallenge.requestRef },
    { runId: otherDecision.identity.runId },
    { decisionId: otherDecision.decisionId },
    { presentedRevision: challenge.presentedRevision + 1 },
    { optionSetDigest: `sha256:${"b".repeat(64)}` },
    { evidenceSetDigest: `sha256:${"c".repeat(64)}` },
    { presentationDigest: `sha256:${"d".repeat(64)}` },
    { runtime: "claude", surface: "AskUserQuestion" },
    { runtime: "codex", surface: "AskUserQuestion" },
    { selectedOptionId: "option:not-present" },
  ];

  for (const substitution of substitutions) {
    assert.throws(
      () => authority.claimNativeDecisionChallenge(decision, challenge, claimInput(challenge, substitution)),
      /bind|surface|option|challenge/u,
      JSON.stringify(substitution),
    );
  }
  assert.throws(
    () => authority.claimNativeDecisionChallenge(otherDecision, challenge, claimInput(challenge)),
    /bind|Decision/u,
    "a challenge must not replay across Decisions or runs",
  );
});

test("challenge cannot replay across presentation semantics hidden behind the same Decision identity and content sets", () => {
  const original = presentedDecision();
  const semanticTwin = presentedDecision({
    routeChangingDimensions: ["risk_or_cost"],
    requirement: {
      required: false,
      reasonRef: "reason:optional-cost-choice",
      evidenceRefs: ["evidence:authority-test"],
    },
    recommendation: {
      optionId: "option:expanded",
      rationaleRef: "reason:expanded-route",
      evidenceRefs: ["evidence:authority-test"],
    },
  });

  assert.equal(semanticTwin.decisionId, original.decisionId, "attack fixture must retain the same Decision identity");
  assert.equal(semanticTwin.revision, original.revision, "attack fixture must retain the same presented revision");
  assert.deepEqual(semanticTwin.options, original.options, "attack fixture must retain the same option set");
  assert.deepEqual(semanticTwin.evidence, original.evidence, "attack fixture must retain the same evidence set");
  assert.notDeepEqual(semanticTwin.routeChangingDimensions, original.routeChangingDimensions);
  assert.notDeepEqual(semanticTwin.requirement, original.requirement);
  assert.notDeepEqual(semanticTwin.recommendation, original.recommendation);

  const originalChallenge = issuedChallenge(original);
  assert.throws(
    () => authority.assertValidNativeDecisionChallenge(originalChallenge, semanticTwin),
    /presentation|bind|Decision/u,
    "a challenge must bind the exact route, requirement, and recommendation presentation semantics",
  );
  assert.throws(
    () => authority.claimNativeDecisionChallenge(semanticTwin, originalChallenge, claimInput(originalChallenge)),
    /presentation|bind|Decision/u,
    "a semantically different Decision must not consume another presentation's challenge",
  );
});

test("hand-forged claimed terminal state must bind its selected option and event to the original Decision", () => {
  const decision = presentedDecision();
  const issued = issuedChallenge(decision);
  const forgedOptionId = "option:forged-outside-decision";
  const forged = clone(issued);
  forged.state = "host_answer_claimed";
  forged.claimedAt = CLAIMED_AT;
  forged.selectedOptionId = forgedOptionId;
  forged.events.push({
    state: "host_answer_claimed",
    at: CLAIMED_AT,
    selectedOptionId: forgedOptionId,
  });

  assert.throws(
    () => authority.assertValidNativeDecisionChallenge(forged, decision),
    /selected option|Decision|claim|history/u,
    "a self-consistent terminal claim cannot select an option outside the bound Decision",
  );

  const validClaim = authority.claimNativeDecisionChallenge(decision, issued, claimInput(issued));
  const terminalOptionTamper = clone(validClaim);
  terminalOptionTamper.selectedOptionId = "option:expanded";
  assert.throws(
    () => authority.assertValidNativeDecisionChallenge(terminalOptionTamper, decision),
    /claim|history|selected option/u,
    "terminal selectedOptionId must equal the selectedOptionId in its claim event",
  );

  const terminalTimeTamper = clone(validClaim);
  terminalTimeTamper.claimedAt = "2026-08-09T00:02:30.000Z";
  assert.throws(
    () => authority.assertValidNativeDecisionChallenge(terminalTimeTamper, decision),
    /claim|history/u,
    "terminal claimedAt must equal the timestamp in its claim event",
  );

  const eventOptionTamper = clone(validClaim);
  eventOptionTamper.events[1].selectedOptionId = "option:expanded";
  assert.throws(
    () => authority.assertValidNativeDecisionChallenge(eventOptionTamper, decision),
    /claim|history|selected option/u,
    "claim event selectedOptionId must equal the terminal selectedOptionId",
  );
});

test("duplicate, stale, inverted, expired, and invalidated consumption never grants permission", () => {
  const decision = presentedDecision();
  assert.throws(
    () => authority.issueNativeDecisionChallenge(decision, issueInput({ issuedAt: EXPIRES_AT, expiresAt: ISSUED_AT })),
    /window|expiry/u,
  );

  const issued = issuedChallenge(decision);
  for (const claimedAt of ["2026-08-09T00:00:59.000Z", AFTER_EXPIRY]) {
    assert.throws(
      () => authority.claimNativeDecisionChallenge(decision, issued, claimInput(issued, { claimedAt })),
      /expiry|binding/u,
    );
  }
  assert.throws(() => authority.expireNativeDecisionChallenge(issued, { at: CLAIMED_AT }), /expire|expiry/u);

  const firstClaim = authority.claimNativeDecisionChallenge(decision, issued, claimInput(issued));
  const replayFromOriginal = authority.claimNativeDecisionChallenge(decision, issued, claimInput(issued));
  assert.equal(replayFromOriginal.state, "host_answer_claimed");
  assertNonAuthorizing(firstClaim, "first structural claim");
  assertNonAuthorizing(replayFromOriginal, "duplicate structural claim");
  assert.throws(
    () => authority.claimNativeDecisionChallenge(decision, firstClaim, claimInput(firstClaim)),
    /eligible|issued/u,
    "a consumed challenge object cannot be consumed again",
  );

  const expired = authority.expireNativeDecisionChallenge(issued, { at: AFTER_EXPIRY });
  assert.throws(() => authority.claimNativeDecisionChallenge(decision, expired, claimInput(expired)), /eligible|issued/u);
  assertNonAuthorizing(expired, "expired challenge");

  const invalidated = authority.invalidateNativeDecisionChallenge(issued, {
    at: CLAIMED_AT,
    reasonRef: "reason:cancelled",
  });
  assert.throws(() => authority.claimNativeDecisionChallenge(decision, invalidated, claimInput(invalidated)), /eligible|issued/u);
  assert.throws(() => authority.invalidateNativeDecisionChallenge(invalidated, {
    at: "2026-08-09T00:03:00.000Z",
    reasonRef: "reason:again",
  }), /legal|transition/u);
  assertNonAuthorizing(invalidated, "invalidated challenge");
});

test("Unicode, lookalike, secret-shaped, and raw references reject without echo while sha256 stays valid", () => {
  const unsafe = [
    `request:${SECRET_SENTINEL}`,
    "request:token-production",
    "request:api-key-live",
    "request:authorization-bearer",
    "request:github_pat_abcdefghijklmnopqrstuvwxyz",
    "request:xoxb-123456789012-abcdefghijkl",
    "request:ｅvidence",
    "request:tokеn-production",
    " Request:something ",
    "raw user answer text",
  ];
  for (const value of unsafe) {
    const error = capturedError(() => authority.assertNativeDecisionOpaqueRef(value));
    assert.match(error.message, /opaque reference/u);
    assert.equal(error.message.includes(value), false, "rejection must not echo caller content");
  }
  const digest = `sha256:${"d".repeat(64)}`;
  assert.equal(authority.assertNativeDecisionOpaqueRef(digest), digest);

  const decision = presentedDecision();
  for (const requestRef of unsafe) {
    const error = capturedError(() => authority.issueNativeDecisionChallenge(decision, issueInput({ requestRef })));
    assert.equal(error.message.includes(requestRef), false, "issue error must not echo unsafe reference");
  }
  assert.doesNotMatch(JSON.stringify(issuedChallenge(decision)), /sk-live|token-production|api-key-live|raw user answer/iu);
});

test("semantic opaque-ref hygiene rejects compact secrets and raw runtime material without blocking generated refs", () => {
  const sensitiveRefs = [
    "request:password123456789",
    "request:supersecretvalue",
    "request:raw-answer-delete-production",
    "request:internal-error-stacktrace",
    "request:PASSWORD123456789",
    "request:SUPERSECRETVALUE",
    "request:RAW-ANSWER-DELETE-PRODUCTION",
    "request:Internal-Error-StackTrace",
    "request:ｐａｓｓｗｏｒｄ１２３４５６７８９",
    "request:ｓｕｐｅｒｓｅｃｒｅｔｖａｌｕｅ",
    "request:ｒａｗ－ａｎｓｗｅｒ－ｄｅｌｅｔｅ－ｐｒｏｄｕｃｔｉｏｎ",
    "request:ｉｎｔｅｒｎａｌ－ｅｒｒｏｒ－ｓｔａｃｋｔｒａｃｅ",
  ];
  for (const value of sensitiveRefs) {
    const error = capturedError(() => authority.assertNativeDecisionOpaqueRef(value));
    assert.match(error.message, /opaque reference/u);
    assert.equal(error.message.includes(value), false, "semantic hygiene error must not echo caller material");
  }

  const generatedRefs = [
    "request:m3p2-run-20260809",
    "challenge:decision-option-01",
    "evidence:repo-file-123",
    "claim:generated-abcdef123456",
    "policy:authority-boundary",
  ];
  for (const value of generatedRefs) {
    assert.equal(authority.assertNativeDecisionOpaqueRef(value), value);
  }

  const strictDigest = `sha256:${"e".repeat(64)}`;
  assert.equal(authority.assertNativeDecisionOpaqueRef(strictDigest), strictDigest);
  assert.throws(
    () => authority.assertNativeDecisionOpaqueRef(`sha256:${"E".repeat(64)}`),
    /opaque reference/u,
    "uppercase hex must not weaken the strict sha256 exception",
  );
});

test("enumerable accessors cannot change challenge or event state during validation and gating", () => {
  const decision = presentedDecision();
  const issued = issuedChallenge(decision);

  function stateSwitchingChallenge() {
    const candidate = clone(issued);
    let reads = 0;
    Object.defineProperty(candidate, "state", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return reads <= 4 ? "issued" : "answered_verified";
      },
    });
    return { candidate, readCount: () => reads };
  }

  const validationAttack = stateSwitchingChallenge();
  const validationError = capturedError(() => authority.assertValidNativeDecisionChallenge(validationAttack.candidate, decision));
  assert.match(validationError.message, /accessor|data propert|own key|record/u);
  assert.equal(validationAttack.readCount(), 0, "validation must reject an accessor without invoking it");
  assert.doesNotMatch(validationError.message, /answered_verified/u, "validation error must not echo accessor output");

  const gateAttack = stateSwitchingChallenge();
  const gateError = capturedError(() => authority.nativeDecisionAuthorityGate(gateAttack.candidate));
  assert.match(gateError.message, /accessor|data propert|own key|record/u);
  assert.equal(gateAttack.readCount(), 0, "gate validation must reject an accessor without invoking it");
  assert.doesNotMatch(gateError.message, /answered_verified/u, "gate error must not echo accessor output");

  const eventAttack = clone(issued);
  let eventReads = 0;
  Object.defineProperty(eventAttack.events[0], "state", {
    enumerable: true,
    configurable: true,
    get() {
      eventReads += 1;
      return eventReads === 1 ? "issued" : "answered_verified";
    },
  });
  const eventError = capturedError(() => authority.assertValidNativeDecisionChallenge(eventAttack, decision));
  assert.match(eventError.message, /accessor|data propert|own key|record/u);
  assert.equal(eventReads, 0, "nested event validation must reject an accessor without invoking it");
  assert.doesNotMatch(eventError.message, /answered_verified/u, "event error must not echo accessor output");

  const nestedAttack = clone(issued);
  let nestedReads = 0;
  const issuedEvents = nestedAttack.events;
  Object.defineProperty(nestedAttack, "events", {
    enumerable: true,
    configurable: true,
    get() {
      nestedReads += 1;
      return issuedEvents;
    },
  });
  const nestedError = capturedError(() => authority.assertValidNativeDecisionChallenge(nestedAttack, decision));
  assert.match(nestedError.message, /accessor|data propert|own key|record/u);
  assert.equal(nestedReads, 0, "nested collection accessor must be rejected without invocation");

  const echoAttack = clone(issued);
  Object.defineProperty(echoAttack, "state", {
    enumerable: true,
    configurable: true,
    get() {
      throw new Error(`getter-${SECRET_SENTINEL}`);
    },
  });
  const echoError = capturedError(() => authority.assertValidNativeDecisionChallenge(echoAttack, decision));
  assert.doesNotMatch(echoError.message, new RegExp(SECRET_SENTINEL, "u"), "accessor rejection must not expose thrown raw values");
});

test("prototype, symbol, non-enumerable, sparse-array, and history tampering are rejected", () => {
  const decision = presentedDecision();
  const customPrototype = Object.assign(Object.create({ inherited: true }), issueInput());
  assert.throws(() => authority.issueNativeDecisionChallenge(decision, customPrototype), /plain Object\.prototype record/u);

  const nullPrototype = Object.assign(Object.create(null), issueInput());
  assert.throws(() => authority.issueNativeDecisionChallenge(decision, nullPrototype), /plain Object\.prototype record/u);

  const symbolExtra = issueInput();
  symbolExtra[Symbol("authority")] = true;
  assert.throws(() => authority.issueNativeDecisionChallenge(decision, symbolExtra), /enumerable string own (?:data properties|keys)/u);

  const hiddenExtra = issueInput();
  Object.defineProperty(hiddenExtra, "trusted", { value: true, enumerable: false });
  assert.throws(() => authority.issueNativeDecisionChallenge(decision, hiddenExtra), /enumerable string own (?:data properties|keys)/u);

  const issued = issuedChallenge(decision);
  const prototypeChallenge = Object.assign(Object.create({ executionAllowed: true }), clone(issued));
  assert.throws(() => authority.assertValidNativeDecisionChallenge(prototypeChallenge), /plain Object\.prototype record/u);

  const symbolChallenge = clone(issued);
  symbolChallenge[Symbol("answered_verified")] = true;
  assert.throws(() => authority.assertValidNativeDecisionChallenge(symbolChallenge), /enumerable string own (?:data properties|keys)/u);

  const hiddenChallenge = clone(issued);
  Object.defineProperty(hiddenChallenge, "executionAllowed", { value: true, enumerable: false });
  assert.throws(() => authority.assertValidNativeDecisionChallenge(hiddenChallenge), /enumerable string own (?:data properties|keys)/u);

  const sparseHistory = clone(issued);
  sparseHistory.events = new Array(2);
  sparseHistory.events[0] = clone(issued.events[0]);
  assert.throws(() => authority.assertValidNativeDecisionChallenge(sparseHistory), /sparse|history/u);

  const forgedHistory = clone(issued);
  forgedHistory.events[0].state = "host_answer_claimed";
  forgedHistory.events[0].selectedOptionId = "option:contained";
  assert.throws(() => authority.assertValidNativeDecisionChallenge(forgedHistory), /history|issuance|binding/u);
});
