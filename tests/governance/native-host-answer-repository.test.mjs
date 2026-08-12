import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import {
  createNativeHostAnswerRepository,
  NATIVE_HOST_ANSWER_REPOSITORY_SCHEMA_VERSION,
} from "../../src/data/repositories/native-host-answer-repository.mjs";
import {
  consumeNativeHostReturnObservedClaim,
  expireNativeHostAnswerSubstrate,
  invalidateNativeHostAnswerSubstrate,
  recordNativeHostReturnObservedClaim,
  presentNativeHostAnswerSubstrate,
} from "../../src/domain/decision/native-host-answer-authority.mjs";
import {
  claimNativeDecisionChallenge,
  issueNativeDecisionChallenge,
} from "../../src/domain/decision/native-decision-authority.mjs";
import { createDecision, presentDecision } from "../../src/domain/decision/decision.mjs";

const CREATED_AT = "2026-08-10T00:00:00.000Z";
const PRESENTED_AT = "2026-08-10T00:00:30.000Z";
const ISSUED_AT = "2026-08-10T00:01:00.000Z";
const OBSERVED_AT = "2026-08-10T00:01:30.000Z";
const CONSUMED_AT = "2026-08-10T00:01:45.000Z";
const EXPIRES_AT = "2026-08-10T00:02:00.000Z";
const DIGEST = (character) => `sha256:${character.repeat(64)}`;

function tempProfile(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-host-answer-repository-"));
  const profileRoot = path.join(root, "profile");
  mkdirSync(profileRoot);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, profileRoot };
}

function fixtureIdentity(suffix = "primary") {
  const decision = presentDecision(createDecision({
    identity: {
      runId: `run:native-choice-${suffix}`,
      taskFingerprint: `digest:native-choice-${suffix}`,
      decisionKey: `decision:native-choice-${suffix}`,
      scopeRef: `scope:native-choice-${suffix}`,
    },
    routeChangingDimensions: ["scope"],
    evidence: [{ evidenceRef: "evidence:host-contract", digest: DIGEST("1") }],
    options: [
      {
        optionId: "option:keep",
        displayRef: "display:keep",
        tradeoffRefs: ["tradeoff:safe"],
        evidenceRefs: ["evidence:host-contract"],
      },
      {
        optionId: "option:change",
        displayRef: "display:change",
        tradeoffRefs: ["tradeoff:scope"],
        evidenceRefs: ["evidence:host-contract"],
      },
    ],
    recommendation: {
      optionId: "option:keep",
      rationaleRef: "rationale:bounded",
      evidenceRefs: ["evidence:host-contract"],
    },
    requirement: {
      required: true,
      reasonRef: "reason:route-changing",
      evidenceRefs: ["evidence:host-contract"],
    },
    nativeSurface: { runtime: "codex", surface: "request_user_input", primary: true },
    createdAt: CREATED_AT,
  }), { at: PRESENTED_AT });
  const challenge = issueNativeDecisionChallenge(decision, {
    runtime: "codex",
    surface: "request_user_input",
    challengeRef: `challenge:native-choice-${suffix}`,
    requestRef: `request:native-choice-${suffix}`,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
  });
  const authority = presentNativeHostAnswerSubstrate(decision, challenge, {
    substrateRef: `substrate:${suffix}-nonce`,
    runtime: "codex",
    surface: "request_user_input",
    hostEventClaimRef: `event:${suffix}`,
    renderedHostPayloadDigest: DIGEST("2"),
    hostConnectionRef: `connection:${suffix}`,
    sessionOrThreadRef: `thread:${suffix}`,
    turnRef: `turn:${suffix}`,
    itemRef: `item:${suffix}`,
    toolUseOrRequestRef: `request:${suffix}`,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    timeSourceClaimRef: `clock:presentation-${suffix}`,
  });
  return { decision, challenge, authority };
}

function claimedChallenge(decision, challenge) {
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
    selectedOptionId: "option:keep",
  });
}

function observedAuthority(fixture) {
  const claimed = claimedChallenge(fixture.decision, fixture.challenge);
  const authority = fixture.authority;
  return recordNativeHostReturnObservedClaim(fixture.decision, claimed, authority, {
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
    timeSourceClaimRef: "clock:observation",
    hostReturnObservedClaimDigest: DIGEST("3"),
  });
}

function cas(record, current) {
  return {
    record,
    expectedRevision: current.revision,
    expectedSubstrateDigest: current.substrateDigest,
    expectedState: current.state,
  };
}

function allJsonText(directoryPath) {
  const values = [];
  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    const item = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) values.push(allJsonText(item));
    else if (entry.isFile() && entry.name.endsWith(".json")) values.push(readFileSync(item, "utf8"));
  }
  return values.join("\n");
}

function runChild(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr, pid: child.pid }));
  });
}

test("repository persists immutable digest-bound revisions and exact single-use state", (t) => {
  const { profileRoot } = tempProfile(t);
  const repository = createNativeHostAnswerRepository({ profileRoot });
  const fixture = fixtureIdentity();

  const issued = repository.issue(fixture.authority);
  assert.equal(issued.state, "presented");
  assert.equal(Object.isFrozen(issued), true);
  assert.throws(() => repository.issue(fixture.authority), (error) => error.code === "NATIVE_HOST_ANSWER_REPOSITORY_REPLAY");

  const observed = observedAuthority(fixture);
  assert.deepEqual(repository.observe(cas(observed, issued)), observed);
  const consumed = consumeNativeHostReturnObservedClaim(observed, {
    at: CONSUMED_AT,
    timeSourceClaimRef: "clock:consumption",
    consumerRef: "consumer:decision-domain",
  });
  assert.deepEqual(repository.consume(cas(consumed, observed)), consumed);
  assert.deepEqual(repository.read({ substrateRef: issued.substrateRef }), consumed);
  assert.throws(() => repository.consume(cas(consumed, observed)), (error) => error.code === "NATIVE_HOST_ANSWER_REPOSITORY_CAS_MISMATCH");

  const identityDirectories = readdirSync(repository.paths.recordsDir);
  assert.equal(identityDirectories.length, 1);
  assert.match(identityDirectories[0], /^[a-f0-9]{64}$/u);
  const revisions = readdirSync(path.join(repository.paths.recordsDir, identityDirectories[0]));
  assert.deepEqual(revisions.sort(), ["000000000000.json", "000000000001.json", "000000000002.json"]);
  const persisted = allJsonText(repository.paths.root);
  assert.match(persisted, new RegExp(NATIVE_HOST_ANSWER_REPOSITORY_SCHEMA_VERSION, "u"));
  assert.doesNotMatch(persisted, /raw prompt|raw answer|super-secret|selected answer text/iu);
});

test("CAS rejects cross-session substitution, stale digest, and wrong state", (t) => {
  const { profileRoot } = tempProfile(t);
  const repository = createNativeHostAnswerRepository({ profileRoot });
  const fixture = fixtureIdentity("binding");
  const issued = repository.issue(fixture.authority);
  const observed = observedAuthority(fixture);

  const forgedSession = structuredClone(observed);
  forgedSession.sessionOrThreadRef = "thread:other-session";
  assert.throws(() => repository.observe(cas(forgedSession, issued)), /domain validation/i);
  assert.throws(() => repository.observe({
    ...cas(observed, issued),
    expectedSubstrateDigest: DIGEST("9"),
  }), (error) => error.code === "NATIVE_HOST_ANSWER_REPOSITORY_CAS_MISMATCH");
  assert.throws(() => repository.observe({
    ...cas(observed, issued),
    expectedState: "host_return_observed",
  }), (error) => error.code === "NATIVE_HOST_ANSWER_REPOSITORY_CAS_MISMATCH");

  const alternateAuthority = presentNativeHostAnswerSubstrate(fixture.decision, fixture.challenge, {
    substrateRef: issued.substrateRef,
    runtime: issued.runtime,
    surface: issued.surface,
    hostEventClaimRef: "event:alternate",
    renderedHostPayloadDigest: issued.renderedHostPayloadDigest,
    hostConnectionRef: "connection:alternate",
    sessionOrThreadRef: "thread:alternate",
    turnRef: "turn:alternate",
    itemRef: "item:alternate",
    toolUseOrRequestRef: "request:alternate",
    issuedAt: issued.issuedAt,
    expiresAt: issued.expiresAt,
    timeSourceClaimRef: issued.presentationTimeSourceClaimRef,
  });
  const alternateObserved = recordNativeHostReturnObservedClaim(
    fixture.decision,
    claimedChallenge(fixture.decision, fixture.challenge),
    alternateAuthority,
    {
      substrateRef: alternateAuthority.substrateRef,
      substrateDigest: alternateAuthority.substrateDigest,
      decisionId: alternateAuthority.decisionId,
      presentedRevision: alternateAuthority.presentedRevision,
      runId: alternateAuthority.runId,
      challengeRef: alternateAuthority.challengeRef,
      challengeDigest: alternateAuthority.challengeDigest,
      runtime: alternateAuthority.runtime,
      surface: alternateAuthority.surface,
      hostEventClaimRef: alternateAuthority.hostEventClaimRef,
      hostEventClaimDigest: alternateAuthority.hostEventClaimDigest,
      renderedHostPayloadDigest: alternateAuthority.renderedHostPayloadDigest,
      hostConnectionRef: alternateAuthority.hostConnectionRef,
      sessionOrThreadRef: alternateAuthority.sessionOrThreadRef,
      turnRef: alternateAuthority.turnRef,
      itemRef: alternateAuthority.itemRef,
      toolUseOrRequestRef: alternateAuthority.toolUseOrRequestRef,
      issuedAt: alternateAuthority.issuedAt,
      expiresAt: alternateAuthority.expiresAt,
      at: OBSERVED_AT,
      timeSourceClaimRef: "clock:alternate",
      hostReturnObservedClaimDigest: DIGEST("6"),
    },
  );
  assert.throws(
    () => repository.observe(cas(alternateObserved, issued)),
    /immutable binding/i,
  );
  assert.equal(repository.read({ substrateRef: issued.substrateRef }).state, "presented");
});

test("challenge identity is unique even when authority and host context change", (t) => {
  const { profileRoot } = tempProfile(t);
  const repository = createNativeHostAnswerRepository({ profileRoot });
  const fixture = fixtureIdentity("challenge-unique");
  repository.issue(fixture.authority);
  const replay = presentNativeHostAnswerSubstrate(fixture.decision, fixture.challenge, {
    substrateRef: "substrate:challenge-unique-second",
    runtime: "codex",
    surface: "request_user_input",
    hostEventClaimRef: "event:challenge-unique-second",
    renderedHostPayloadDigest: DIGEST("7"),
    hostConnectionRef: "connection:second",
    sessionOrThreadRef: "thread:second",
    turnRef: "turn:second",
    itemRef: "item:second",
    toolUseOrRequestRef: "request:second",
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    timeSourceClaimRef: "clock:second",
  });
  assert.throws(() => repository.issue(replay), (error) => error.code === "NATIVE_HOST_ANSWER_REPOSITORY_REPLAY");
});

test("one host event cannot be relabeled and replayed under a new challenge", (t) => {
  const { profileRoot } = tempProfile(t);
  const repository = createNativeHostAnswerRepository({ profileRoot });
  const fixture = fixtureIdentity("event-replay");
  repository.issue(fixture.authority);
  const nextChallenge = issueNativeDecisionChallenge(fixture.decision, {
    runtime: "codex",
    surface: "request_user_input",
    challengeRef: "challenge:event-replay-second",
    requestRef: "request:event-replay-second",
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
  });
  const replay = presentNativeHostAnswerSubstrate(fixture.decision, nextChallenge, {
    substrateRef: "substrate:event-replay-second",
    runtime: "codex",
    surface: "request_user_input",
    hostEventClaimRef: "event:event-replay-relabeled",
    renderedHostPayloadDigest: DIGEST("8"),
    hostConnectionRef: fixture.authority.hostConnectionRef,
    sessionOrThreadRef: fixture.authority.sessionOrThreadRef,
    turnRef: fixture.authority.turnRef,
    itemRef: fixture.authority.itemRef,
    toolUseOrRequestRef: fixture.authority.toolUseOrRequestRef,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    timeSourceClaimRef: "clock:event-replay-second",
  });
  assert.throws(
    () => repository.issue(replay),
    (error) => error.code === "NATIVE_HOST_ANSWER_REPOSITORY_REPLAY" && /host event/i.test(error.message),
  );
});

test("expire and invalidate persist caller-trusted time evidence and reject terminal replay", (t) => {
  const { profileRoot } = tempProfile(t);
  const repository = createNativeHostAnswerRepository({ profileRoot });
  const expiryFixture = fixtureIdentity("expiry");
  const expiryIssued = repository.issue(expiryFixture.authority);
  const expired = expireNativeHostAnswerSubstrate(expiryIssued, {
    at: EXPIRES_AT,
    timeSourceClaimRef: "clock:expiry-boundary",
  });
  repository.expire(cas(expired, expiryIssued));
  assert.equal(repository.read({ substrateRef: expired.substrateRef }).expiryTimeSourceClaimRef, "clock:expiry-boundary");
  assert.throws(() => repository.expire(cas(expired, expiryIssued)), (error) => error.code === "NATIVE_HOST_ANSWER_REPOSITORY_CAS_MISMATCH");

  const invalidationFixture = fixtureIdentity("invalidation");
  const invalidationIssued = repository.issue(invalidationFixture.authority);
  const invalidated = invalidateNativeHostAnswerSubstrate(invalidationIssued, {
    at: OBSERVED_AT,
    timeSourceClaimRef: "clock:invalidation",
    reasonRef: "reason:host-disconnected",
  });
  repository.invalidate(cas(invalidated, invalidationIssued));
  assert.equal(repository.read({ substrateRef: invalidated.substrateRef }).state, "invalidated");
});

test("two processes racing the same consume CAS produce exactly one stored winner", async (t) => {
  const { profileRoot, root } = tempProfile(t);
  const repository = createNativeHostAnswerRepository({ profileRoot, lockTimeoutMs: 2_000 });
  const fixture = fixtureIdentity("concurrent");
  const issued = repository.issue(fixture.authority);
  const observed = observedAuthority(fixture);
  repository.observe(cas(observed, issued));
  const consumed = consumeNativeHostReturnObservedClaim(observed, {
    at: CONSUMED_AT,
    timeSourceClaimRef: "clock:concurrent-consume",
    consumerRef: "consumer:concurrent",
  });
  const inputPath = path.join(root, "consume-input.json");
  writeFileSync(inputPath, JSON.stringify(cas(consumed, observed)), "utf8");
  const moduleUrl = pathToFileURL(path.resolve("src/data/repositories/native-host-answer-repository.mjs")).href;
  const childScript = `
    import { readFileSync } from "node:fs";
    const { createNativeHostAnswerRepository } = await import(process.argv[1]);
    const repository = createNativeHostAnswerRepository({ profileRoot: process.argv[2], lockTimeoutMs: 2000 });
    try { repository.consume(JSON.parse(readFileSync(process.argv[3], "utf8"))); process.stdout.write("won"); }
    catch (error) { process.stdout.write(error.code || "failed"); process.exitCode = 2; }
  `;
  const results = await Promise.all([
    runChild(childScript, [moduleUrl, profileRoot, inputPath]),
    runChild(childScript, [moduleUrl, profileRoot, inputPath]),
  ]);
  assert.deepEqual(results.map((result) => result.code).sort(), [0, 2]);
  assert.equal(results.filter((result) => result.stdout === "won").length, 1);
  assert.equal(results.filter((result) => result.stdout.includes("CAS_MISMATCH")).length, 1);
  assert.equal(repository.read({ substrateRef: consumed.substrateRef }).state, "consumed");
});

test("a partial unpublished revision from an interrupted writer cannot occupy the final revision", (t) => {
  const { profileRoot } = tempProfile(t);
  const repository = createNativeHostAnswerRepository({ profileRoot });
  const fixture = fixtureIdentity("crash-reopen");
  const issued = repository.issue(fixture.authority);
  const observed = observedAuthority(fixture);
  repository.observe(cas(observed, issued));
  const identity = readdirSync(repository.paths.recordsDir)[0];
  const partial = path.join(
    repository.paths.recordsDir,
    identity,
    "000000000002.json.999.11111111-1111-4111-8111-111111111111.tmp",
  );
  writeFileSync(partial, "{partial", "utf8");
  const reopened = createNativeHostAnswerRepository({ profileRoot });
  assert.deepEqual(reopened.read({ substrateRef: observed.substrateRef }), observed);
  const consumed = consumeNativeHostReturnObservedClaim(observed, {
    at: CONSUMED_AT,
    timeSourceClaimRef: "clock:crash-consume",
    consumerRef: "consumer:crash-test",
  });
  reopened.consume(cas(consumed, observed));
  assert.deepEqual(reopened.read({ substrateRef: consumed.substrateRef }), consumed);
});

test("symlink or junction roots, record redirection, and root escape fail closed", (t) => {
  const { profileRoot, root } = tempProfile(t);
  const outside = path.join(root, "outside");
  mkdirSync(outside);
  const alias = path.join(root, "profile-alias");
  symlinkSync(profileRoot, alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => createNativeHostAnswerRepository({ profileRoot: alias }), /non-link|reparse|junction/i);
  assert.throws(() => createNativeHostAnswerRepository({ profileRoot: path.join(profileRoot, "..", "missing") }), /does not exist/i);

  const repository = createNativeHostAnswerRepository({ profileRoot });
  rmdirSync(repository.paths.recordsDir);
  symlinkSync(outside, repository.paths.recordsDir, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => repository.issue(fixtureIdentity("redirect").authority), /ordinary non-link|reparse|junction/i);
});

test("oversized records and trapping public inputs fail with bounded repository errors", (t) => {
  const { profileRoot } = tempProfile(t);
  const repository = createNativeHostAnswerRepository({ profileRoot });
  const issued = repository.issue(fixtureIdentity("bounded-input").authority);
  const identity = readdirSync(repository.paths.recordsDir)[0];
  const recordPath = path.join(repository.paths.recordsDir, identity, "000000000000.json");
  writeFileSync(recordPath, "x".repeat(256 * 1024 + 1), "utf8");
  assert.throws(() => repository.read({ substrateRef: issued.substrateRef }), /bounded record size/i);

  const trap = new Proxy({}, {
    getPrototypeOf() { throw new Error("trap-secret-must-not-leak"); },
  });
  assert.throws(
    () => createNativeHostAnswerRepository({ profileRoot: profileRoot }).issue(trap),
    (error) => !String(error.message).includes("trap-secret-must-not-leak") && /domain validation/i.test(error.message),
  );
});

test("stale-lock recovery never steals a live owner and preserves recovered evidence", (t) => {
  const { profileRoot } = tempProfile(t);
  const repository = createNativeHostAnswerRepository({
    profileRoot,
    lockTimeoutMs: 0,
  });
  const lockPath = path.join(repository.paths.root, "write.lock");
  writeFileSync(lockPath, JSON.stringify({
    schemaVersion: "native-host-answer-repository-lock-v1",
    token: "11111111-1111-4111-8111-111111111111",
    pid: process.pid,
    processStartRef: DIGEST("4"),
    createdAt: "2000-01-01T00:00:00.000Z",
  }), "utf8");
  assert.throws(() => repository.read({ substrateRef: "substrate:missing" }), (error) => error.code === "NATIVE_HOST_ANSWER_REPOSITORY_BUSY");
  rmSync(lockPath);

  const dead = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
  assert.equal(dead.status, 0);
  writeFileSync(lockPath, JSON.stringify({
    schemaVersion: "native-host-answer-repository-lock-v1",
    token: "22222222-2222-4222-8222-222222222222",
    pid: Number(dead.stdout.trim()),
    processStartRef: DIGEST("5"),
    createdAt: new Date().toISOString(),
  }), "utf8");
  assert.throws(() => repository.read({ substrateRef: "substrate:missing" }), (error) => error.code === "NATIVE_HOST_ANSWER_REPOSITORY_NOT_FOUND");
  assert.equal(readdirSync(path.join(repository.paths.root, "stale-locks")).length, 1);

  writeFileSync(lockPath, "malformed", "utf8");
  const past = new Date(Date.now() - 60_000);
  utimesSync(lockPath, past, past);
  assert.throws(() => repository.read({ substrateRef: "substrate:missing" }), (error) => error.code === "NATIVE_HOST_ANSWER_REPOSITORY_BUSY");
  assert.equal(readdirSync(path.join(repository.paths.root, "stale-locks")).length, 1);
});
