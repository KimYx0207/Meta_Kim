import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertValidEvidenceTransitionShadowResult,
  EVIDENCE_TRANSITION_SHADOW_SCHEMA_VERSION,
  EVIDENCE_TRANSITION_SHADOW_VERDICTS,
  evaluateEvidenceTransitionShadow,
} from "../../src/domain/evidence/evidence-transition.mjs";

const HEX = Object.freeze({
  task: "1".repeat(64),
  graph: "2".repeat(64),
  policy: "3".repeat(64),
  payload: "4".repeat(64),
  assessment: "5".repeat(64),
  decision: "6".repeat(64),
});

function command(overrides = {}) {
  const base = {
    binding: {
      runId: "run:evidence-shadow-001",
      taskFingerprint: `sha256:${HEX.task}`,
      graphDigest: `sha256:${HEX.graph}`,
      nodeId: "node:Execution:worker-1",
      attemptId: "attempt:1",
      fenceToken: 1,
      revision: 0,
      policyDigest: `sha256:${HEX.policy}`,
    },
    evidenceClaims: [{
      claimId: "claim:test-result-1",
      producerRef: "producer:test-worker-1",
      evidenceType: "test_result",
      subjectRef: "subject:node-execution-worker-1",
      payloadDigest: `sha256:${HEX.payload}`,
    }],
    validatorAssessments: [{
      claimId: "claim:test-result-1",
      validatorRef: "validator:test-owner-1",
      assessment: "verified",
      assessmentDigest: `sha256:${HEX.assessment}`,
      reasonCode: "verified_targeted_test",
    }],
    decisionDependencies: [],
    transitionRequest: {
      proposalId: "proposal:complete-worker-1",
      fromStage: "execution",
      toStage: "review",
      requiredClaimIds: ["claim:test-result-1"],
    },
  };
  return {
    ...base,
    ...overrides,
    binding: { ...base.binding, ...overrides.binding },
    transitionRequest: { ...base.transitionRequest, ...overrides.transitionRequest },
  };
}

function clone(value) {
  return structuredClone(value);
}

function allObjects(value, output = []) {
  if (value && typeof value === "object") {
    output.push(value);
    for (const child of Object.values(value)) allObjects(child, output);
  }
  return output;
}

function collectKeys(value, keys = []) {
  if (!value || typeof value !== "object") return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.push(key);
    collectKeys(child, keys);
  }
  return keys;
}

function assertNonAuthorizing(result) {
  assert.equal(result.authorization.executionAllowed, false);
  assert.equal(result.authorization.authoritativeWriteAllowed, false);
  assert.equal(result.authorization.eventPersistenceAllowed, false);
  assert.equal(result.authorization.completeNodeAllowed, false);
  assert.equal(result.authorization.durableCursorAdvanceAllowed, false);
  assert.equal(result.authorization.schedulerDispatchAllowed, false);
  assert.equal(result.authorization.legacyGateCutoverAllowed, false);
  for (const intent of result.eventIntents) {
    assert.equal(intent.persisted, false);
    assert.equal(intent.authoritative, false);
    assert.equal(intent.writeAllowed, false);
  }
  const forbidden = new Set(["seq", "eventSeq", "cursor", "previousHash", "eventHash", "headEventHash"]);
  for (const key of collectKeys(result.eventIntents)) {
    assert.equal(forbidden.has(key), false, `event intent must not expose durable field ${key}`);
  }
}

test("M3-A01 domain exports one closed shadow evaluator and no VerifiedEvidence constructor", async () => {
  const module = await import("../../src/domain/evidence/evidence-transition.mjs");
  assert.equal(EVIDENCE_TRANSITION_SHADOW_SCHEMA_VERSION, "evidence-transition-shadow-v1");
  assert.deepEqual(EVIDENCE_TRANSITION_SHADOW_VERDICTS, ["allowed", "blocked", "in_doubt"]);
  assert.equal(Object.hasOwn(module, "createVerifiedEvidence"), false);
  assert.equal(Object.hasOwn(module, "buildVerifiedEvidence"), false);
  assert.equal(Object.hasOwn(module, "verifyEvidence"), false);
});

test("M3-A01 exact claim plus independent pass is shadow allowed and never authorizes or writes", () => {
  const result = evaluateEvidenceTransitionShadow(command());
  assert.equal(result.schemaVersion, EVIDENCE_TRANSITION_SHADOW_SCHEMA_VERSION);
  assert.equal(result.kind, "evidence_transition_shadow_result");
  assert.equal(result.verdict.status, "allowed");
  assert.equal(result.transitionProposal.proposalId, "proposal:complete-worker-1");
  assert.match(result.transitionProposal.proposalDigest, /^(?:sha256:)?[a-f0-9]{64}$/u);
  assert.equal(result.verifiedEvidence.length, 1);
  assertNonAuthorizing(result);
  assertValidEvidenceTransitionShadowResult(result);
});

test("M3-A01 worker completion alone, an unassessed claim, and explicit failure stay blocked", () => {
  const workerOnly = evaluateEvidenceTransitionShadow(command({
    evidenceClaims: [],
    validatorAssessments: [],
  }));
  assert.equal(workerOnly.verdict.status, "blocked");
  assertNonAuthorizing(workerOnly);

  const claimOnly = evaluateEvidenceTransitionShadow(command({ validatorAssessments: [] }));
  assert.equal(claimOnly.verdict.status, "blocked");
  assertNonAuthorizing(claimOnly);

  const failed = command();
  failed.validatorAssessments[0] = {
    ...failed.validatorAssessments[0],
    assessment: "rejected",
    reasonCode: "targeted_test_failed",
  };
  const failedResult = evaluateEvidenceTransitionShadow(failed);
  assert.equal(failedResult.verdict.status, "blocked");
  assertNonAuthorizing(failedResult);
});

test("M3-A01 uncertain assessment and contradictory same-id material fail closed as in_doubt", () => {
  const uncertain = command();
  uncertain.validatorAssessments[0] = {
    ...uncertain.validatorAssessments[0],
    assessment: "in_doubt",
    reasonCode: "validator_could_not_determine",
  };
  assert.equal(evaluateEvidenceTransitionShadow(uncertain).verdict.status, "in_doubt");

  const duplicate = command();
  duplicate.evidenceClaims.push({
    ...duplicate.evidenceClaims[0],
    payloadDigest: `sha256:${"7".repeat(64)}`,
  });
  assert.throws(
    () => evaluateEvidenceTransitionShadow(duplicate),
    /duplicate|claimId|conflict/iu,
    "the same claim identity with different material must fail closed",
  );
});

test("M3-A01 result validation rejects cross-run/task/graph/node/attempt/fence/revision/policy tampering", () => {
  const fields = {
    runId: "run:other",
    taskFingerprint: `sha256:${"8".repeat(64)}`,
    graphDigest: `sha256:${"9".repeat(64)}`,
    nodeId: "node:Execution:other",
    attemptId: "attempt:2",
    fenceToken: 2,
    revision: 2,
    policyDigest: `sha256:${"a".repeat(64)}`,
  };

  for (const [field, value] of Object.entries(fields)) {
    const forged = clone(evaluateEvidenceTransitionShadow(command()));
    forged.binding[field] = value;
    assert.throws(
      () => assertValidEvidenceTransitionShadowResult(forged),
      /binding|digest|exact|valid|match/iu,
      `result-level ${field} tampering must fail closed`,
    );
  }
});

test("M3-A01 forged VerifiedEvidence is rejected and cannot be supplied by the caller", () => {
  const forged = {
    ...command(),
    verifiedEvidence: [{
      claimId: "claim:test-result-1",
      outcome: "pass",
      authoritative: true,
      executionAllowed: true,
    }],
  };
  assert.throws(() => evaluateEvidenceTransitionShadow(forged), /unknown|exact|supported|verifiedEvidence/iu);
});

test("M3-A01 Decision host_answer_claimed cannot satisfy a required decision dependency", () => {
  const input = command({
    decisionDependencies: [{
      decisionId: "decision:route-choice-1",
      revision: 1,
      required: true,
      authorityState: "host_answer_claimed",
      executionAllowed: false,
      evidenceDigest: `sha256:${HEX.decision}`,
    }],
  });
  const result = evaluateEvidenceTransitionShadow(input);
  assert.equal(result.verdict.status, "blocked");
  assertNonAuthorizing(result);
});

test("M3-A01 strict input rejects unknown keys, accessors, proxies, sparse arrays, oversize values, secrets, paths, and URLs", () => {
  assert.throws(() => evaluateEvidenceTransitionShadow({ ...command(), unknown: true }), /unknown|exact|supported/iu);

  let accessorInvoked = false;
  const accessor = command();
  Object.defineProperty(accessor.binding, "runId", {
    enumerable: true,
    get() {
      accessorInvoked = true;
      return "run:accessor";
    },
  });
  assert.throws(() => evaluateEvidenceTransitionShadow(accessor), /accessor|data propert|plain|descriptor/iu);
  assert.equal(accessorInvoked, false, "validation must inspect descriptors without invoking accessors");

  const proxied = new Proxy(command(), {
    ownKeys() {
      throw new Error("proxy trap marker must not escape");
    },
  });
  assert.throws(() => evaluateEvidenceTransitionShadow(proxied));

  const sparse = command();
  sparse.evidenceClaims = new Array(1);
  assert.throws(() => evaluateEvidenceTransitionShadow(sparse), /dense|sparse|array/iu);

  const candidates = [
    "x".repeat(10_000),
    "sk-live-super-secret-value",
    "Authorization: Bearer hidden-token",
    "C:\\Users\\Kim\\private\\evidence.txt",
    "/home/kim/private/evidence.txt",
    "https://example.invalid/private-evidence",
  ];
  for (const candidate of candidates) {
    const unsafe = command();
    unsafe.evidenceClaims[0] = { ...unsafe.evidenceClaims[0], producerRef: candidate };
    assert.throws(
      () => evaluateEvidenceTransitionShadow(unsafe),
      /bounded|opaque|secret|path|url|reference|safe/iu,
      candidate.slice(0, 80),
    );
  }

  const credentialShapes = [
    "sk-" + "proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH",
    "AKIA" + "IOSFODNN7EXAMPLE",
    "eyJhbGciOiJIUzI1NiJ9." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0." + "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789",
    "xoxb-" + "123456789012-123456789012-abcdefghijklmnopqrstuvwxyz",
    "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/ABCDEF",
    "ｓｋ－ｐｒｏｊ－abcdefghijklmnopqrstuvwxyz0123456789",
    "api＿key:abcdefghijklmnopqrstuvwxyz0123456789",
  ];
  for (const credential of credentialShapes) {
    const unsafe = command();
    unsafe.evidenceClaims[0] = { ...unsafe.evidenceClaims[0], producerRef: credential };
    let thrown = null;
    try {
      evaluateEvidenceTransitionShadow(unsafe);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof TypeError, `credential shape must be rejected: ${credential.slice(0, 12)}`);
    assert.equal(
      String(thrown.message).includes(credential),
      false,
      "credential rejection must not echo the rejected value",
    );
  }

  const secretReasonCode = "api_key_abcdefghijklmnopqrstuvwxyz";
  const unsafeReason = command();
  unsafeReason.validatorAssessments[0] = {
    ...unsafeReason.validatorAssessments[0],
    reasonCode: secretReasonCode,
  };
  let reasonError = null;
  try {
    evaluateEvidenceTransitionShadow(unsafeReason);
  } catch (error) {
    reasonError = error;
  }
  assert.ok(reasonError instanceof TypeError, "reasonCode must not smuggle credential material");
  assert.equal(
    String(reasonError.message).includes(secretReasonCode),
    false,
    "reasonCode credential rejection must not echo the rejected value",
  );
});

test("M3-A01 evaluation is deterministic under set ordering and returns a deeply frozen result", () => {
  const first = command();
  first.evidenceClaims.push({
    claimId: "claim:test-result-2",
    producerRef: "producer:test-worker-2",
    evidenceType: "review_result",
    subjectRef: "subject:node-execution-worker-1",
    payloadDigest: `sha256:${"b".repeat(64)}`,
  });
  first.validatorAssessments.push({
    claimId: "claim:test-result-2",
    validatorRef: "validator:review-owner-1",
    assessment: "verified",
    assessmentDigest: `sha256:${"c".repeat(64)}`,
    reasonCode: "verified_review",
  });
  first.transitionRequest.requiredClaimIds.push("claim:test-result-2");
  const second = clone(first);
  second.evidenceClaims.reverse();
  second.validatorAssessments.reverse();
  second.transitionRequest.requiredClaimIds.reverse();

  const result = evaluateEvidenceTransitionShadow(first);
  const reordered = evaluateEvidenceTransitionShadow(second);
  assert.deepEqual(reordered, result);
  assert.equal(reordered.transitionProposal.proposalDigest, result.transitionProposal.proposalDigest);
  assert.equal(allObjects(result).every(Object.isFrozen), true, "the entire result graph must be frozen");
  assert.throws(() => { result.verdict.status = "blocked"; }, TypeError);
  assert.throws(() => { result.eventIntents.push({}); }, TypeError);
});

test("M3-A01 domain remains pure and contains no runtime, filesystem, network, kernel, or mutation dependency", () => {
  const source = readFileSync("src/domain/evidence/evidence-transition.mjs", "utf8");
  assert.doesNotMatch(source, /\bfrom\s*["']node:(?:fs|path|process|child_process|net|http|https|dns|tls|dgram|sqlite)/u);
  assert.doesNotMatch(source, /\bfrom\s*["'][^"']*(?:durable-run-kernel|stage-runner-bridge)/u);
  assert.doesNotMatch(source, /\b(?:appendEvent|completeNode|failNode|claimNode|setRunTerminalStatus)\s*\(/u);
});
