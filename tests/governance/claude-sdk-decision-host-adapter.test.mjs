import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createDecision,
  presentDecision,
} from "../../src/domain/decision/decision.mjs";
import { issueNativeDecisionChallenge } from "../../src/domain/decision/native-decision-authority.mjs";
import {
  createClaudeSdkDecisionHostAdapter,
  digestClaudeRenderedAskUserQuestion,
} from "../../src/adapters/claude/sdk-decision-host-adapter.mjs";

const ISSUED_AT = "2026-08-10T00:01:00.000Z";
const RETURNED_AT = "2026-08-10T00:01:10.000Z";
const EXPIRES_AT = "2026-08-10T00:02:00.000Z";

function presentedDecision(runId = "run:claude-sdk-host") {
  const identitySuffix = runId.replaceAll(":", "-");
  return presentDecision(createDecision({
    identity: {
      runId,
      taskFingerprint: `digest:${identitySuffix}`,
      decisionKey: `decision:${identitySuffix}`,
      scopeRef: `scope:${identitySuffix}`,
    },
    routeChangingDimensions: ["scope"],
    evidence: [{ evidenceRef: "evidence:claude-sdk-host", digest: "digest:claude-sdk-host" }],
    options: [
      {
        optionId: "option:recommended",
        displayRef: "display:recommended",
        tradeoffRefs: ["tradeoff:contained"],
        evidenceRefs: ["evidence:claude-sdk-host"],
      },
      {
        optionId: "option:alternative",
        displayRef: "display:alternative",
        tradeoffRefs: ["tradeoff:expanded"],
        evidenceRefs: ["evidence:claude-sdk-host"],
      },
    ],
    recommendation: {
      optionId: "option:recommended",
      rationaleRef: "reason:claude-sdk-host",
      evidenceRefs: ["evidence:claude-sdk-host"],
    },
    requirement: {
      required: true,
      reasonRef: "reason:route-changing",
      evidenceRefs: ["evidence:claude-sdk-host"],
    },
    nativeSurface: { runtime: "claude", surface: "AskUserQuestion", primary: true },
    createdAt: "2026-08-10T00:00:00.000Z",
  }), { at: "2026-08-10T00:00:30.000Z" });
}

function issuedChallenge(decision, suffix = "claude-sdk-host") {
  return issueNativeDecisionChallenge(decision, {
    runtime: "claude",
    surface: "AskUserQuestion",
    challengeRef: `challenge:${suffix}`,
    requestRef: `request:${suffix}`,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
  });
}

function memoryRepository() {
  const records = new Map();
  const hostEvents = new Set();
  const replay = (message) => Object.assign(new Error(message), { code: "NATIVE_HOST_ANSWER_REPOSITORY_REPLAY" });
  return {
    issue(record) {
      if (records.has(record.substrateRef)) throw replay("replay");
      const hostEvent = [
        record.runtime,
        record.surface,
        record.hostConnectionRef,
        record.sessionOrThreadRef,
        record.turnRef,
        record.itemRef,
        record.toolUseOrRequestRef,
      ].join("\u0000");
      if (hostEvents.has(hostEvent)) throw replay("host event replay");
      hostEvents.add(hostEvent);
      records.set(record.substrateRef, record);
      return record;
    },
    observe({ record, expectedRevision, expectedSubstrateDigest, expectedState }) {
      const current = records.get(record.substrateRef);
      if (!current || current.revision !== expectedRevision || current.substrateDigest !== expectedSubstrateDigest || current.state !== expectedState) {
        throw new Error("CAS mismatch");
      }
      records.set(record.substrateRef, record);
      return record;
    },
    read({ substrateRef }) {
      const record = records.get(substrateRef);
      if (!record) throw new Error("not found");
      return record;
    },
    records,
  };
}

function fixturePort(overrides = {}) {
  const state = {
    submitted: null,
    activeReads: 0,
    deferredResumes: 0,
    activeAcks: 0,
    deferredAcks: 0,
  };
  const context = {
    hostConnectionRef: "host-connection:claude-sdk",
    sessionRef: "session:claude-sdk",
    turnRef: "turn:claude-sdk",
    itemRef: "item:claude-sdk",
  };
  const presentation = (payload, deferred) => {
    state.submitted = payload;
    return {
      ...context,
      tool_use_id: deferred ? "tool:claude-deferred" : "tool:claude-active",
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      timeSourceClaimRef: "time-source-claim:presentation",
      renderedAskUserQuestion: payload,
      ...(deferred ? { deferredCallId: "tool:claude-deferred" } : {}),
      ...(deferred ? overrides.deferredPresentation : overrides.activePresentation),
    };
  };
  const returned = (deferred) => ({
    ...context,
    tool_use_id: deferred ? "tool:claude-deferred" : "tool:claude-active",
    at: RETURNED_AT,
    timeSourceClaimRef: "time-source-claim:return",
    selectedOptionId: "option:recommended",
    ...(deferred ? { deferredCallId: "tool:claude-deferred" } : {}),
    ...(deferred ? overrides.deferredReturn : overrides.activeReturn),
  });
  return {
    state,
    getCurrentContext() { return overrides.context ?? context; },
    presentActiveAskUserQuestion(payload) { return presentation(payload, false); },
    readActiveAskUserQuestionReturn() {
      state.activeReads += 1;
      if (typeof overrides.activeRead === "function") return overrides.activeRead(state.activeReads, () => returned(false));
      return Object.prototype.hasOwnProperty.call(overrides, "activeResult") ? overrides.activeResult : returned(false);
    },
    presentDeferredAskUserQuestion(payload) { return presentation(payload, true); },
    resumeDeferredAskUserQuestion() {
      state.deferredResumes += 1;
      if (typeof overrides.deferredResume === "function") return overrides.deferredResume(state.deferredResumes, () => returned(true));
      return Object.prototype.hasOwnProperty.call(overrides, "deferredResult") ? overrides.deferredResult : returned(true);
    },
    ackActiveAskUserQuestionReturn() {
      state.activeAcks += 1;
      if (typeof overrides.activeAck === "function") return overrides.activeAck(state.activeAcks);
    },
    ackDeferredAskUserQuestionReturn() {
      state.deferredAcks += 1;
      if (typeof overrides.deferredAck === "function") return overrides.deferredAck(state.deferredAcks);
    },
  };
}

function command(decision, challenge) {
  return { decision, challenge, activeHostOptionMaximum: 4 };
}

function resumeCommand(decision, challenge, substrateRef) {
  return { decision, challenge, substrateRef, activeHostOptionMaximum: 4 };
}

test("active Claude SDK return binds the actual rendered payload and exact host context without granting execution", async () => {
  const decision = presentedDecision();
  const challenge = issuedChallenge(decision);
  const repository = memoryRepository();
  const hostPort = fixturePort();
  const adapter = createClaudeSdkDecisionHostAdapter({ hostPort, repository });

  const result = await adapter.active(command(decision, challenge));

  assert.equal(result.status, "non_authorizing_host_return_observation");
  assert.equal(result.returnKind, "active_host_return");
  assert.equal(result.substrate.renderedHostPayloadDigest, digestClaudeRenderedAskUserQuestion(hostPort.state.submitted));
  assert.equal(result.substrate.sessionOrThreadRef, "session:claude-sdk");
  assert.equal(result.substrate.toolUseOrRequestRef, "tool:claude-active");
  assert.equal(result.substrate.substrateRef, result.substrate.hostEventClaimRef);
  assert.equal(result.substrate.state, "host_return_observed");
  assert.equal(result.challenge.state, "host_answer_claimed");
  assert.equal(result.gate.executionAllowed, false);
  assert.equal(result.executionAllowed, false);
  assert.equal(hostPort.state.activeAcks, 1);
  assert.doesNotMatch(JSON.stringify(result), /rawPrompt|rawAnswer|secret/iu);
});

test("active-only host ports do not need deferred capabilities", async () => {
  const decision = presentedDecision();
  const challenge = issuedChallenge(decision);
  const complete = fixturePort();
  const activeOnly = {
    getCurrentContext: complete.getCurrentContext,
    presentActiveAskUserQuestion: complete.presentActiveAskUserQuestion,
    readActiveAskUserQuestionReturn: complete.readActiveAskUserQuestionReturn,
    ackActiveAskUserQuestionReturn: complete.ackActiveAskUserQuestionReturn,
  };
  const adapter = createClaudeSdkDecisionHostAdapter({ hostPort: activeOnly, repository: memoryRepository() });
  const observed = await adapter.active(command(decision, challenge));
  assert.equal(observed.status, "non_authorizing_host_return_observation");
  await assert.rejects(adapter.defer(command(decision, challenge)), /presentDeferredAskUserQuestion/u);
});

test("active return redelivery recovers crashes after issue and after observe before ack", async () => {
  const decision = presentedDecision();
  const challenge = issuedChallenge(decision);
  const repository = memoryRepository();
  const hostPort = fixturePort({
    activeRead(attempt, result) {
      if (attempt === 1) throw new Error("crash after issue before return observation");
      return result();
    },
    activeAck(attempt) {
      if (attempt === 1) throw new Error("crash after observe before ack");
    },
  });
  const adapter = createClaudeSdkDecisionHostAdapter({ hostPort, repository });

  await assert.rejects(adapter.active(command(decision, challenge)), /crash after issue/u);
  assert.equal([...repository.records.values()][0].state, "presented");

  await assert.rejects(adapter.active(command(decision, challenge)), /crash after observe/u);
  assert.equal([...repository.records.values()][0].state, "host_return_observed");

  const recovered = await adapter.active(command(decision, challenge));
  assert.equal(recovered.status, "non_authorizing_host_return_observation");
  assert.equal(recovered.substrate.state, "host_return_observed");
  assert.equal(hostPort.state.activeReads, 3);
  assert.equal(hostPort.state.activeAcks, 2);
});

test("deferred presentation and return redelivery converge across restart points", async () => {
  const decision = presentedDecision();
  const challenge = issuedChallenge(decision);
  const repository = memoryRepository();
  const hostPort = fixturePort({
    deferredResume(attempt, result) {
      if (attempt === 1) throw new Error("crash after deferred issue");
      return result();
    },
    deferredAck(attempt) {
      if (attempt === 1) throw new Error("crash after deferred observe");
    },
  });
  const adapter = createClaudeSdkDecisionHostAdapter({ hostPort, repository });

  const first = await adapter.defer(command(decision, challenge));
  const replayedPresentation = await adapter.defer(command(decision, challenge));
  assert.equal(replayedPresentation.substrate.substrateRef, first.substrate.substrateRef);
  assert.equal(replayedPresentation.substrate.state, "presented");

  await assert.rejects(adapter.resume(resumeCommand(decision, challenge, first.substrate.substrateRef)), /crash after deferred issue/u);
  await assert.rejects(adapter.resume(resumeCommand(decision, challenge, first.substrate.substrateRef)), /crash after deferred observe/u);
  assert.equal(repository.read({ substrateRef: first.substrate.substrateRef }).state, "host_return_observed");

  const recovered = await adapter.resume(resumeCommand(decision, challenge, first.substrate.substrateRef));
  assert.equal(recovered.status, "non_authorizing_host_return_observation");
  assert.equal(hostPort.state.deferredResumes, 3);
  assert.equal(hostPort.state.deferredAcks, 2);
});

test("active and deferred return redelivery recover an observe CAS crash before acknowledgement", async () => {
  for (const mode of ["active", "deferred"]) {
    const decision = presentedDecision(`run:cas-crash-${mode}`);
    const challenge = issuedChallenge(decision, `cas-crash-${mode}`);
    const repository = memoryRepository();
    const observe = repository.observe;
    let failObserve = true;
    repository.observe = (input) => {
      if (failObserve) {
        failObserve = false;
        throw new Error("injected observe CAS crash");
      }
      return observe(input);
    };
    const hostPort = fixturePort();
    const adapter = createClaudeSdkDecisionHostAdapter({ hostPort, repository });

    if (mode === "active") {
      await assert.rejects(adapter.active(command(decision, challenge)), /observe CAS crash/u);
      assert.equal([...repository.records.values()][0].state, "presented");
      const recovered = await adapter.active(command(decision, challenge));
      assert.equal(recovered.substrate.state, "host_return_observed");
      assert.equal(hostPort.state.activeAcks, 1);
    } else {
      const pending = await adapter.defer(command(decision, challenge));
      await assert.rejects(adapter.resume(resumeCommand(decision, challenge, pending.substrate.substrateRef)), /observe CAS crash/u);
      assert.equal(repository.read({ substrateRef: pending.substrate.substrateRef }).state, "presented");
      const recovered = await adapter.resume(resumeCommand(decision, challenge, pending.substrate.substrateRef));
      assert.equal(recovered.substrate.state, "host_return_observed");
      assert.equal(hostPort.state.deferredAcks, 1);
    }
  }
});

test("non-replay repository issue failures never trigger recovery reads", async () => {
  const decision = presentedDecision();
  const challenge = issuedChallenge(decision);
  let reads = 0;
  const failure = Object.assign(new Error("disk unavailable"), { code: "NATIVE_HOST_ANSWER_REPOSITORY_IO" });
  const repository = {
    issue() { throw failure; },
    observe() { throw new Error("must not observe"); },
    read() { reads += 1; throw new Error("must not recover"); },
  };
  const adapter = createClaudeSdkDecisionHostAdapter({ hostPort: fixturePort(), repository });
  await assert.rejects(adapter.active(command(decision, challenge)), (error) => error === failure);
  assert.equal(reads, 0);
});

test("active observation rejects session, tool, rendered digest, revision, and time mismatches", async () => {
  const cases = [
    { activeReturn: { sessionRef: "session:other" } },
    { activeReturn: { tool_use_id: "tool:other" } },
    { activePresentation: { renderedAskUserQuestion: { questions: [] } } },
    { activeReturn: { at: EXPIRES_AT } },
  ];
  for (const [index, overrides] of cases.entries()) {
    const decision = presentedDecision();
    const challenge = issuedChallenge(decision);
    const adapter = createClaudeSdkDecisionHostAdapter({ hostPort: fixturePort(overrides), repository: memoryRepository() });
    await assert.rejects(adapter.active(command(decision, challenge)), /match|different|window|validity/u);
  }

  const decision = presentedDecision();
  const challenge = structuredClone(issuedChallenge(decision));
  challenge.presentedRevision += 1;
  const adapter = createClaudeSdkDecisionHostAdapter({ hostPort: fixturePort(), repository: memoryRepository() });
  await assert.rejects(adapter.active(command(decision, challenge)), /challenge|Decision|bind|valid/u);
});

test("deferred claude -p call remains pending until one same-session same-call resume", async () => {
  const decision = presentedDecision();
  const challenge = issuedChallenge(decision);
  const repository = memoryRepository();
  const hostPort = fixturePort();
  const adapter = createClaudeSdkDecisionHostAdapter({ hostPort, repository });

  const pending = await adapter.defer(command(decision, challenge));
  assert.equal(pending.status, "deferred_waiting_resume");
  assert.equal(pending.substrate.state, "presented");
  assert.equal(pending.gate.executionAllowed, false);
  assert.equal(hostPort.state.deferredResumes, 0);

  const observed = await adapter.resume(resumeCommand(decision, challenge, pending.substrate.substrateRef));
  assert.equal(observed.status, "non_authorizing_host_return_observation");
  assert.equal(observed.returnKind, "deferred_resume");
  assert.equal(observed.substrate.state, "host_return_observed");
  assert.equal(observed.executionAllowed, false);

  const replayed = await adapter.resume(resumeCommand(decision, challenge, pending.substrate.substrateRef));
  assert.equal(replayed.status, "non_authorizing_host_return_observation");
  assert.equal(hostPort.state.deferredResumes, 2, "durable redelivery must converge on the same observation");
  assert.equal(hostPort.state.deferredAcks, 2, "acknowledgement is retried idempotently after durable observation");
});

test("same host event cannot be rebound to a different Decision challenge", async () => {
  const repository = memoryRepository();
  const firstDecision = presentedDecision("run:host-event-first");
  const secondDecision = presentedDecision("run:host-event-second");
  const first = createClaudeSdkDecisionHostAdapter({ hostPort: fixturePort(), repository });
  const second = createClaudeSdkDecisionHostAdapter({ hostPort: fixturePort(), repository });
  const initial = await first.defer(command(firstDecision, issuedChallenge(firstDecision, "host-event-first")));
  assert.equal(initial.substrate.substrateRef, initial.substrate.hostEventClaimRef);
  await assert.rejects(
    second.defer(command(secondDecision, issuedChallenge(secondDecision, "host-event-second"))),
    /replay/u,
  );
});

test("resume validates the stored substrate against supplied Decision and challenge before host side effects", async () => {
  const decision = presentedDecision();
  const challenge = issuedChallenge(decision);
  const hostPort = fixturePort();
  const adapter = createClaudeSdkDecisionHostAdapter({ hostPort, repository: memoryRepository() });
  const pending = await adapter.defer(command(decision, challenge));
  const attacked = structuredClone(challenge);
  attacked.challengeRef = "challenge:other";

  await assert.rejects(
    adapter.resume(resumeCommand(decision, attacked, pending.substrate.substrateRef)),
    /challenge|bind|valid/u,
  );
  assert.equal(hostPort.state.deferredResumes, 0);

  await assert.rejects(
    adapter.resume(resumeCommand(decision, challenge, "substrate:raw-private-locator")),
    (error) => !String(error).includes("raw-private-locator"),
  );
  assert.equal(hostPort.state.deferredResumes, 0);
});

test("deferred resume rejects cross-session and cross-call returns", async () => {
  for (const [index, deferredReturn] of [
    { sessionRef: "session:other" },
    { deferredCallId: "tool:other" },
    { tool_use_id: "tool:other" },
  ].entries()) {
    const decision = presentedDecision();
    const challenge = issuedChallenge(decision);
    const repository = memoryRepository();
    const adapter = createClaudeSdkDecisionHostAdapter({ hostPort: fixturePort({ deferredReturn }), repository });
    const pending = await adapter.defer(command(decision, challenge));
    const substrateRef = pending.substrate.substrateRef;
    await assert.rejects(adapter.resume(resumeCommand(decision, challenge, substrateRef)), /session|deferred|tool_use_id|match/u);
    assert.equal(repository.read({ substrateRef }).state, "presented");
  }
});

test("empty, stripped, and rejected-looking host results remain unobserved", async () => {
  const invalidResults = [
    null,
    {
      hostConnectionRef: "host-connection:claude-sdk",
      sessionRef: "session:claude-sdk",
      turnRef: "turn:claude-sdk",
      itemRef: "item:claude-sdk",
      tool_use_id: "tool:claude-active",
      at: RETURNED_AT,
      timeSourceClaimRef: "time-source-claim:return",
    },
    {
      hostConnectionRef: "host-connection:claude-sdk",
      sessionRef: "session:claude-sdk",
      turnRef: "turn:claude-sdk",
      itemRef: "item:claude-sdk",
      tool_use_id: "tool:claude-active",
      at: RETURNED_AT,
      timeSourceClaimRef: "time-source-claim:return",
      selectedOptionId: "option:recommended",
      rejected: true,
    },
  ];
  for (const [index, activeResult] of invalidResults.entries()) {
    const decision = presentedDecision();
    const challenge = issuedChallenge(decision);
    const repository = memoryRepository();
    const adapter = createClaudeSdkDecisionHostAdapter({ hostPort: fixturePort({ activeResult }), repository });
    await assert.rejects(adapter.active(command(decision, challenge)), /record|fields|supported/u);
    assert.equal([...repository.records.values()][0].state, "presented");
  }
});

test("accessors, Proxies, sparse payloads, and secret-like refs fail without trap execution or persistence", async () => {
  const decision = presentedDecision();
  const challenge = issuedChallenge(decision);
  let getterReads = 0;
  const accessorContext = {
    hostConnectionRef: "host-connection:claude-sdk",
    turnRef: "turn:claude-sdk",
    itemRef: "item:claude-sdk",
  };
  Object.defineProperty(accessorContext, "sessionRef", {
    enumerable: true,
    get() { getterReads += 1; return "session:claude-sdk"; },
  });
  const accessorAdapter = createClaudeSdkDecisionHostAdapter({
    hostPort: fixturePort({ context: accessorContext }),
    repository: memoryRepository(),
  });
  await assert.rejects(accessorAdapter.active(command(decision, challenge)), /data properties/u);
  assert.equal(getterReads, 0);

  const proxyResult = new Proxy({}, { get() { throw new Error("must not read Proxy"); } });
  const proxyAdapter = createClaudeSdkDecisionHostAdapter({ hostPort: fixturePort({ activeResult: proxyResult }), repository: memoryRepository() });
  await assert.rejects(proxyAdapter.active(command(decision, challenge)), /Proxy/u);

  const secretAdapter = createClaudeSdkDecisionHostAdapter({
    hostPort: fixturePort({ context: {
      hostConnectionRef: "host-connection:claude-sdk",
      sessionRef: "session:sk-live-private-value",
      turnRef: "turn:claude-sdk",
      itemRef: "item:claude-sdk",
    } }),
    repository: memoryRepository(),
  });
  await assert.rejects(secretAdapter.active(command(decision, challenge)), /safe opaque/u);

  const sparse = [];
  sparse.length = 1;
  assert.throws(() => digestClaudeRenderedAskUserQuestion({ questions: sparse }), /dense/u);
});

test("existing Hook bypass still exits before intercepting AskUserQuestion", () => {
  const source = readFileSync("canonical/runtime-assets/claude/hooks/enforce-agent-dispatch.mjs", "utf8");
  const bypass = source.indexOf('if (toolName === "AskUserQuestion")');
  const readOnly = source.indexOf("if (isReadOnlyTool(toolName))", bypass);
  assert.ok(bypass > 0, "AskUserQuestion bypass must remain present");
  assert.ok(readOnly > bypass, "AskUserQuestion must bypass further PreToolUse processing before generic handling");
  assert.match(source.slice(bypass, readOnly), /process\.exit\(0\)/u);
});
