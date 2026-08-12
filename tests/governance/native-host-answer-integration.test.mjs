import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  claimClaudeAskUserQuestionReturn,
  prepareClaudeAskUserQuestion,
} from "../../src/adapters/claude/native-decision-surface-adapter.mjs";
import {
  createClaudeSdkDecisionHostAdapter,
  digestClaudeRenderedAskUserQuestion,
} from "../../src/adapters/claude/sdk-decision-host-adapter.mjs";
import {
  CODEX_APP_SERVER_REQUEST_USER_INPUT_METHOD,
  codexRenderedHostPayloadDigest,
  createCodexAppServerDecisionHostAdapter,
} from "../../src/adapters/codex/app-server-decision-host-adapter.mjs";
import {
  claimCodexNativeDecisionSurfaceReturn,
  prepareCodexNativeDecisionSurface,
} from "../../src/adapters/codex/native-decision-surface-adapter.mjs";
import { createNativeHostAnswerRepository } from "../../src/data/repositories/native-host-answer-repository.mjs";
import { createDecision, presentDecision } from "../../src/domain/decision/decision.mjs";
import {
  issueNativeDecisionChallenge,
  nativeDecisionAuthorityGate,
} from "../../src/domain/decision/native-decision-authority.mjs";
import {
  consumeNativeHostReturnObservedClaim,
  expireNativeHostAnswerSubstrate,
  invalidateNativeHostAnswerSubstrate,
  nativeHostAnswerSubstrateGate,
  recordNativeHostReturnObservedClaim,
  presentNativeHostAnswerSubstrate,
} from "../../src/domain/decision/native-host-answer-authority.mjs";

const PRESENTED_AT = "2026-08-10T01:00:00.000Z";
const ISSUED_AT = "2026-08-10T01:00:10.000Z";
const RETURNED_AT = "2026-08-10T01:00:20.000Z";
const CONSUMED_AT = "2026-08-10T01:00:21.000Z";
const EXPIRES_AT = "2026-08-10T01:01:00.000Z";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

function decisionFixture(runtime) {
  const surface = runtime === "codex" ? "request_user_input" : "AskUserQuestion";
  return presentDecision(createDecision({
    identity: {
      runId: `run:fake-${runtime}-integration`,
      taskFingerprint: `digest:fake-${runtime}-integration`,
      decisionKey: "decision:integration-route",
      scopeRef: "scope:integration-fixture",
    },
    routeChangingDimensions: ["scope"],
    evidence: [{ evidenceRef: "evidence:integration", digest: "sha256:integration" }],
    options: [
      {
        optionId: "option:preserve",
        displayRef: "display:preserve",
        tradeoffRefs: ["tradeoff:low-risk"],
        evidenceRefs: ["evidence:integration"],
      },
      {
        optionId: "option:change",
        displayRef: "display:change",
        tradeoffRefs: ["tradeoff:more-work"],
        evidenceRefs: ["evidence:integration"],
      },
    ],
    recommendation: {
      optionId: "option:preserve",
      rationaleRef: "reason:lower-risk",
      evidenceRefs: ["evidence:integration"],
    },
    requirement: {
      required: true,
      reasonRef: "reason:branching-route",
      evidenceRefs: ["evidence:integration"],
    },
    nativeSurface: { runtime, surface, primary: true },
    createdAt: "2026-08-10T00:59:00.000Z",
  }), { at: PRESENTED_AT });
}

function codexPrepared(decision) {
  return prepareCodexNativeDecisionSurface({
    decision,
    challengeRef: "challenge:fake-codex-integration",
    activeSchema: {
      runtime: "codex",
      surface: "request_user_input",
      questions: { min: 1, max: 1 },
      optionsPerQuestion: { min: 2, max: 3 },
      textLimits: {
        header: 20,
        question: 80,
        optionLabel: 30,
        optionDescription: 80,
      },
    },
    requestRef: "request:fake-codex-integration",
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    presentation: {
      questions: [{
        header: "Route",
        question: "Choose the integration route.",
        options: [
          {
            optionId: "option:preserve",
            label: "Preserve",
            description: "Keep the current route.",
          },
          {
            optionId: "option:change",
            label: "Change",
            description: "Take the changed route.",
          },
        ],
      }],
    },
  });
}

function claudePrepared(decision) {
  const challenge = issueNativeDecisionChallenge(decision, {
    runtime: "claude",
    surface: "AskUserQuestion",
    challengeRef: "challenge:fake-claude-integration",
    requestRef: "request:fake-claude-integration",
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
  });
  return prepareClaudeAskUserQuestion(decision, {
    challenge,
    sessionRef: "session:fake-claude-integration",
    activeHostOptionMaximum: 3,
  });
}

/**
 * Test-only native host port fixture. It proves adapter/domain composition,
 * never a real Codex or Claude host E2E. The payload digest is computed from
 * the exact object this fixture receives, not from a caller-authored digest.
 */
function createFakeNativeHostPortFixture(runtime) {
  const surface = runtime === "codex" ? "request_user_input" : "AskUserQuestion";
  const payloads = [];
  return Object.freeze({
    fixtureKind: "fake_native_host_port_not_real_e2e",
    present(payload) {
      const snapshot = structuredClone(payload);
      payloads.push(snapshot);
      return Object.freeze({
        renderedHostPayloadDigest: digest(snapshot),
        hostConnectionRef: `connection:fake-${runtime}-fixture`,
        sessionOrThreadRef: `session:fake-${runtime}-fixture`,
        turnRef: `turn:fake-${runtime}-fixture`,
        itemRef: `item:fake-${runtime}-fixture`,
        toolUseOrRequestRef: `request:fake-${runtime}-fixture`,
        timeSourceClaimRef: `clock:fake-${runtime}-presentation`,
      });
    },
    returnSelection(prepared) {
      const challenge = prepared.challenge;
      const hostReturn = runtime === "codex"
        ? {
            runtime,
            surface,
            challengeRef: challenge.challengeRef,
            challengeDigest: challenge.challengeDigest,
            decisionId: challenge.decisionId,
            presentedRevision: challenge.presentedRevision,
            runId: challenge.runId,
            requestRef: challenge.requestRef,
            optionSetDigest: challenge.optionSetDigest,
            evidenceSetDigest: challenge.evidenceSetDigest,
            presentationDigest: challenge.presentationDigest,
            claimedAt: RETURNED_AT,
            selectedOptionId: "option:preserve",
          }
        : {
            returnKind: "active_host_return",
            runtime,
            surface,
            sessionRef: prepared.correlation.sessionRef,
            challengeRef: challenge.challengeRef,
            challengeDigest: challenge.challengeDigest,
            decisionId: challenge.decisionId,
            presentedRevision: challenge.presentedRevision,
            runId: challenge.runId,
            requestRef: challenge.requestRef,
            optionSetDigest: challenge.optionSetDigest,
            evidenceSetDigest: challenge.evidenceSetDigest,
            presentationDigest: challenge.presentationDigest,
            claimedAt: RETURNED_AT,
            selectedOptionId: "option:preserve",
          };
      return Object.freeze({
        normalizedSelection: Object.freeze(hostReturn),
        hostReturnObservedClaimDigest: digest({
          runtime,
          surface,
          connection: `connection:fake-${runtime}-fixture`,
          session: `session:fake-${runtime}-fixture`,
          turn: `turn:fake-${runtime}-fixture`,
          item: `item:fake-${runtime}-fixture`,
          request: `request:fake-${runtime}-fixture`,
          selectedOptionId: "option:preserve",
          returnedAt: RETURNED_AT,
        }),
        timeSourceClaimRef: `clock:fake-${runtime}-return`,
      });
    },
    get presentedPayloads() {
      return structuredClone(payloads);
    },
  });
}

function authorityPresentationInput(runtime, challenge, hostPresentation, overrides = {}) {
  return {
    substrateRef: `substrate:fake-${runtime}-integration`,
    runtime,
    surface: challenge.surface,
    hostEventClaimRef: `event:fake-${runtime}-integration`,
    renderedHostPayloadDigest: hostPresentation.renderedHostPayloadDigest,
    hostConnectionRef: hostPresentation.hostConnectionRef,
    sessionOrThreadRef: hostPresentation.sessionOrThreadRef,
    turnRef: hostPresentation.turnRef,
    itemRef: hostPresentation.itemRef,
    toolUseOrRequestRef: hostPresentation.toolUseOrRequestRef,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    timeSourceClaimRef: hostPresentation.timeSourceClaimRef,
    ...overrides,
  };
}

function observationInput(authority, hostReturn, overrides = {}) {
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
    at: RETURNED_AT,
    timeSourceClaimRef: hostReturn.timeSourceClaimRef,
    hostReturnObservedClaimDigest: hostReturn.hostReturnObservedClaimDigest,
    ...overrides,
  };
}

function cas(record, expected) {
  return {
    record,
    expectedRevision: expected.revision,
    expectedSubstrateDigest: expected.substrateDigest,
    expectedState: expected.state,
  };
}

function profile(t, name) {
  const root = mkdtempSync(path.join(tmpdir(), `meta-kim-fake-host-${name}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function repositoryPort(repository) {
  return {
    issue: repository.issue,
    observe: repository.observe,
    read: repository.read,
  };
}

function createFakeCodexAppServerPortFixture({ failFirstAck = false } = {}) {
  const request = {
    id: "request-user-input-fixture-1",
    method: CODEX_APP_SERVER_REQUEST_USER_INPUT_METHOD,
    params: {
      threadId: "thread-fixture-1",
      turnId: "turn-fixture-1",
      itemId: "item-fixture-1",
      questions: [{
        id: "route-fixture",
        header: "Route",
        question: "Choose the integration route.",
        options: [
          { label: "Preserve", description: "Keep the current route." },
          { label: "Change", description: "Take the changed route." },
        ],
      }],
    },
  };
  const acknowledgements = [];
  let ackAttempts = 0;
  return {
    fixtureKind: "fake_codex_app_server_port_not_real_e2e",
    request,
    get acknowledgements() {
      return structuredClone(acknowledgements);
    },
    connection: {
      hostConnectionRef: "connection:fake-codex-app-server",
      takeRequestUserInput: async () => ({
        request: structuredClone(request),
        timeSourceClaimRef: "clock:fake-codex-request",
      }),
      takeResponse: async ({ requestId }) => ({
        response: {
          id: requestId,
          result: {
            answers: {
              "route-fixture": { answers: ["Preserve"] },
            },
          },
        },
        at: RETURNED_AT,
        timeSourceClaimRef: "clock:fake-codex-response",
      }),
      ackResponse: async (binding) => {
        ackAttempts += 1;
        if (failFirstAck && ackAttempts === 1) {
          throw new Error("fake ack interruption after repository CAS");
        }
        acknowledgements.push(structuredClone(binding));
      },
    },
  };
}

function createFakeClaudeSdkPortFixture({ failFirstRead = false, failFirstAck = false } = {}) {
  const context = {
    hostConnectionRef: "connection:fake-claude-sdk",
    sessionRef: "session:fake-claude-sdk",
    turnRef: "turn:fake-claude-sdk",
    itemRef: "item:fake-claude-sdk",
  };
  const activeToolUseId = "request:fake-claude-active";
  const deferredToolUseId = "deferred:fake-claude-resume";
  let deferredPayload = null;
  let activeReadAttempts = 0;
  let activeAckAttempts = 0;
  const activeAcknowledgements = [];
  const deferredAcknowledgements = [];
  const presentation = (payload, toolUseId, deferred = false) => ({
    ...context,
    tool_use_id: toolUseId,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    timeSourceClaimRef: `clock:fake-claude-${deferred ? "deferred" : "active"}-request`,
    renderedAskUserQuestion: structuredClone(payload),
    ...(deferred ? { deferredCallId: toolUseId } : {}),
  });
  const returned = (toolUseId, deferred = false) => ({
    ...context,
    tool_use_id: toolUseId,
    at: RETURNED_AT,
    timeSourceClaimRef: `clock:fake-claude-${deferred ? "resume" : "active"}-response`,
    selectedOptionId: "option:preserve",
    ...(deferred ? { deferredCallId: toolUseId } : {}),
  });
  return {
    fixtureKind: "fake_claude_sdk_port_not_real_e2e",
    get activeAcknowledgements() {
      return structuredClone(activeAcknowledgements);
    },
    get deferredAcknowledgements() {
      return structuredClone(deferredAcknowledgements);
    },
    port: {
      getCurrentContext: async () => structuredClone(context),
      presentActiveAskUserQuestion: async (payload) => presentation(payload, activeToolUseId),
      readActiveAskUserQuestionReturn: async () => {
        activeReadAttempts += 1;
        if (failFirstRead && activeReadAttempts === 1) {
          throw new Error("fake interruption after issue before active return persistence");
        }
        return returned(activeToolUseId);
      },
      ackActiveAskUserQuestionReturn: async (binding) => {
        activeAckAttempts += 1;
        if (failFirstAck && activeAckAttempts === 1) {
          throw new Error("fake interruption after active observe CAS before ack");
        }
        activeAcknowledgements.push(structuredClone(binding));
      },
      presentDeferredAskUserQuestion: async (payload) => {
        deferredPayload = structuredClone(payload);
        return presentation(payload, deferredToolUseId, true);
      },
      resumeDeferredAskUserQuestion: async () => {
        assert.ok(deferredPayload, "fake deferred port must receive a presentation before resume");
        return returned(deferredToolUseId, true);
      },
      ackDeferredAskUserQuestionReturn: async (binding) => {
        deferredAcknowledgements.push(structuredClone(binding));
      },
    },
  };
}

function runFakeHostFlow(runtime, profileRoot) {
  const decision = decisionFixture(runtime);
  const prepared = runtime === "codex" ? codexPrepared(decision) : claudePrepared(decision);
  const port = createFakeNativeHostPortFixture(runtime);
  const renderedPayload = runtime === "codex" ? prepared.payload : prepared.askUserQuestion;
  const hostPresentation = port.present(renderedPayload);
  const presented = presentNativeHostAnswerSubstrate(
    decision,
    prepared.challenge,
    authorityPresentationInput(runtime, prepared.challenge, hostPresentation),
  );
  const repository = createNativeHostAnswerRepository({ profileRoot });
  repository.issue(presented);
  const hostReturn = port.returnSelection(prepared);
  const claimed = runtime === "codex"
    ? claimCodexNativeDecisionSurfaceReturn({
        decision,
        challenge: prepared.challenge,
        returnedSelection: hostReturn.normalizedSelection,
      })
    : claimClaudeAskUserQuestionReturn(
        decision,
        prepared,
        hostReturn.normalizedSelection,
      );
  const observed = recordNativeHostReturnObservedClaim(
    decision,
    claimed.challenge,
    presented,
    observationInput(presented, hostReturn),
  );
  repository.observe(cas(observed, presented));
  return {
    decision,
    prepared,
    port,
    hostPresentation,
    hostReturn,
    claimed,
    presented,
    observed,
    repository,
  };
}

test("Codex app-server adapter observes one exact fake JSON-RPC request/response and persists only a non-authorizing substrate", async (t) => {
  const root = profile(t, "codex-app-server-adapter");
  const repository = createNativeHostAnswerRepository({ profileRoot: root });
  const fixture = createFakeCodexAppServerPortFixture();
  const decision = decisionFixture("codex");
  const issuedChallenge = codexPrepared(decision).challenge;
  const adapter = createCodexAppServerDecisionHostAdapter({
    hostConnection: fixture.connection,
    repository: {
      issue: repository.issue,
      observe: repository.observe,
      read: repository.read,
    },
  });
  const result = await adapter.observeRequiredDecision({
    decision,
    issuedChallenge,
    expectedBinding: {
      threadId: "thread-fixture-1",
      turnId: "turn-fixture-1",
      itemId: "item-fixture-1",
    },
    presentation: {
      question: {
        id: "route-fixture",
        header: "Route",
        question: "Choose the integration route.",
        options: [
          {
            optionId: "option:preserve",
            label: "Preserve",
            description: "Keep the current route.",
          },
          {
            optionId: "option:change",
            label: "Change",
            description: "Take the changed route.",
          },
        ],
      },
    },
  });

  assert.equal(fixture.fixtureKind, "fake_codex_app_server_port_not_real_e2e");
  assert.equal(result.substrate.renderedHostPayloadDigest, codexRenderedHostPayloadDigest(fixture.request));
  assert.equal(result.substrate.state, "host_return_observed");
  assert.equal(result.substrate.substrateRef, result.substrate.hostEventClaimRef);
  assert.equal(result.gate.executionAllowed, false);
  assert.equal(result.executionAllowed, false);
  assert.equal(fixture.acknowledgements.length, 1);
  assert.equal(repository.read({ substrateRef: result.substrate.substrateRef }).state, "host_return_observed");
  assert.doesNotMatch(JSON.stringify(result), /answered_verified|executionAllowed\s*:\s*true/iu);
});

test("Claude SDK adapter active and deferred fake ports retain exact rendered payloads and remain non-authorizing", async (t) => {
  const hostEventClaimRefs = [];
  for (const mode of ["active", "deferred"]) {
    const root = profile(t, `claude-sdk-${mode}`);
    const repository = createNativeHostAnswerRepository({ profileRoot: root });
    const fixture = createFakeClaudeSdkPortFixture();
    const decision = decisionFixture("claude");
    const challenge = claudePrepared(decision).challenge;
    const adapter = createClaudeSdkDecisionHostAdapter({
      hostPort: fixture.port,
      repository: repositoryPort(repository),
    });
    const input = {
      decision,
      challenge,
      activeHostOptionMaximum: 3,
    };
    let result;
    if (mode === "active") {
      result = await adapter.active(input);
    } else {
      const deferred = await adapter.defer(input);
      result = await adapter.resume({
        ...input,
        substrateRef: deferred.substrate.substrateRef,
      });
    }

    assert.equal(fixture.fixtureKind, "fake_claude_sdk_port_not_real_e2e");
    assert.equal(result.status, "non_authorizing_host_return_observation");
    assert.equal(result.substrate.state, "host_return_observed");
    assert.equal(result.substrate.substrateRef, result.substrate.hostEventClaimRef);
    hostEventClaimRefs.push(result.substrate.hostEventClaimRef);
    assert.equal(result.gate.executionAllowed, false);
    assert.equal(result.executionAllowed, false);
    assert.match(result.substrate.renderedHostPayloadDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(
      result.substrate.renderedHostPayloadDigest,
      digestClaudeRenderedAskUserQuestion(
        prepareClaudeAskUserQuestion(decision, {
          challenge,
          sessionRef: "session:fake-claude-sdk",
          activeHostOptionMaximum: 3,
        }).askUserQuestion,
      ),
    );
    assert.equal(
      repository.read({ substrateRef: result.substrate.substrateRef }).state,
      "host_return_observed",
    );
    assert.equal(
      mode === "active"
        ? fixture.activeAcknowledgements.length
        : fixture.deferredAcknowledgements.length,
      1,
    );
  }
  assert.notEqual(
    hostEventClaimRefs[0],
    hostEventClaimRefs[1],
    "active and deferred Claude host event claims must be domain-separated",
  );
});

test("Claude active fake-port redelivery converges after issue, return, and observe-CAS interruptions", async (t) => {
  for (const failurePoint of [
    "after_issue_before_return",
    "after_return_before_cas",
    "after_cas_before_ack",
  ]) {
    const root = profile(t, `claude-recovery-${failurePoint}`);
    const repository = createNativeHostAnswerRepository({ profileRoot: root });
    const fixture = createFakeClaudeSdkPortFixture({
      failFirstRead: failurePoint === "after_issue_before_return",
      failFirstAck: failurePoint === "after_cas_before_ack",
    });
    let failObserve = failurePoint === "after_return_before_cas";
    const recoveryRepositoryPort = {
      issue: repository.issue,
      observe: (input) => {
        if (failObserve) {
          failObserve = false;
          throw new Error("fake interruption after Claude return before observe CAS");
        }
        return repository.observe(input);
      },
      read: repository.read,
    };
    const decision = decisionFixture("claude");
    const challenge = claudePrepared(decision).challenge;
    const input = { decision, challenge, activeHostOptionMaximum: 3 };
    const first = createClaudeSdkDecisionHostAdapter({
      hostPort: fixture.port,
      repository: recoveryRepositoryPort,
    });
    await assert.rejects(
      () => first.active(input),
      /fake interruption/u,
    );

    const reopened = createClaudeSdkDecisionHostAdapter({
      hostPort: fixture.port,
      repository: recoveryRepositoryPort,
    });
    const recovered = await reopened.active(input);
    assert.equal(recovered.status, "non_authorizing_host_return_observation");
    assert.equal(recovered.substrate.state, "host_return_observed");
    assert.equal(recovered.executionAllowed, false);
    assert.equal(fixture.activeAcknowledgements.length, 1);
  }
});

test("Codex unacknowledged fake responses converge after failures before CAS and after CAS before ack", async (t) => {
  for (const failurePoint of ["before_cas", "after_cas_before_ack"]) {
    const root = profile(t, `codex-recovery-${failurePoint}`);
    const repository = createNativeHostAnswerRepository({ profileRoot: root });
    const fixture = createFakeCodexAppServerPortFixture({
      failFirstAck: failurePoint === "after_cas_before_ack",
    });
    let failObserve = failurePoint === "before_cas";
    const repositoryFixturePort = {
      issue: repository.issue,
      observe: (input) => {
        if (failObserve) {
          failObserve = false;
          throw new Error("fake interruption before repository CAS");
        }
        return repository.observe(input);
      },
      read: repository.read,
    };
    const decision = decisionFixture("codex");
    const issuedChallenge = codexPrepared(decision).challenge;
    const input = {
      decision,
      issuedChallenge,
      expectedBinding: {
        threadId: "thread-fixture-1",
        turnId: "turn-fixture-1",
        itemId: "item-fixture-1",
      },
      presentation: {
        question: {
          id: "route-fixture",
          header: "Route",
          question: "Choose the integration route.",
          options: [
            {
              optionId: "option:preserve",
              label: "Preserve",
              description: "Keep the current route.",
            },
            {
              optionId: "option:change",
              label: "Change",
              description: "Take the changed route.",
            },
          ],
        },
      },
    };
    const firstAdapter = createCodexAppServerDecisionHostAdapter({
      hostConnection: fixture.connection,
      repository: repositoryFixturePort,
    });
    await assert.rejects(
      () => firstAdapter.observeRequiredDecision(input),
      /fake interruption|fake ack interruption/u,
    );

    const reopenedAdapter = createCodexAppServerDecisionHostAdapter({
      hostConnection: fixture.connection,
      repository: repositoryFixturePort,
    });
    const recovered = await reopenedAdapter.observeRequiredDecision(input);
    assert.equal(recovered.status, "non_authorizing_host_return_observation");
    assert.equal(recovered.substrate.state, "host_return_observed");
    assert.equal(recovered.executionAllowed, false);
    assert.equal(fixture.acknowledgements.length, 1);
  }
});

test("Codex adapter derives the same host-event substrateRef across different Decision challenges", async () => {
  const decision = decisionFixture("codex");
  const firstChallenge = codexPrepared(decision).challenge;
  const secondChallenge = issueNativeDecisionChallenge(decision, {
    runtime: "codex",
    surface: "request_user_input",
    challengeRef: "challenge:fake-codex-second-binding",
    requestRef: "request:fake-codex-second-binding",
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
  });
  const observedRecords = [];
  const recordingRepository = {
    issue: (record) => record,
    observe: ({ record }) => {
      observedRecords.push(record);
      return record;
    },
    read: () => {
      throw new Error("recording fixture has no prior record");
    },
  };
  const inputFor = (issuedChallenge) => ({
    decision,
    issuedChallenge,
    expectedBinding: {
      threadId: "thread-fixture-1",
      turnId: "turn-fixture-1",
      itemId: "item-fixture-1",
    },
    presentation: {
      question: {
        id: "route-fixture",
        header: "Route",
        question: "Choose the integration route.",
        options: [
          {
            optionId: "option:preserve",
            label: "Preserve",
            description: "Keep the current route.",
          },
          {
            optionId: "option:change",
            label: "Change",
            description: "Take the changed route.",
          },
        ],
      },
    },
  });

  for (const challenge of [firstChallenge, secondChallenge]) {
    const fixture = createFakeCodexAppServerPortFixture();
    const adapter = createCodexAppServerDecisionHostAdapter({
      hostConnection: fixture.connection,
      repository: recordingRepository,
    });
    await adapter.observeRequiredDecision(inputFor(challenge));
  }
  assert.equal(observedRecords.length, 2);
  assert.notEqual(observedRecords[0].challengeDigest, observedRecords[1].challengeDigest);
  assert.equal(observedRecords[0].substrateRef, observedRecords[1].substrateRef);
  assert.equal(observedRecords[0].hostEventClaimRef, observedRecords[1].hostEventClaimRef);
  assert.equal(observedRecords[0].hostEventClaimDigest, observedRecords[1].hostEventClaimDigest);
});

test("fake Codex and Claude host ports bind the exact rendered payload and claimed host-context refs without claiming real E2E", (t) => {
  for (const runtime of ["codex", "claude"]) {
    const root = profile(t, runtime);
    const flow = runFakeHostFlow(runtime, root);
    const renderedPayload = runtime === "codex"
      ? flow.prepared.payload
      : flow.prepared.askUserQuestion;
    assert.equal(flow.port.fixtureKind, "fake_native_host_port_not_real_e2e");
    assert.equal(flow.port.presentedPayloads.length, 1);
    assert.equal(flow.presented.renderedHostPayloadDigest, digest(renderedPayload));
    assert.equal(flow.presented.hostConnectionRef, `connection:fake-${runtime}-fixture`);
    assert.equal(flow.presented.sessionOrThreadRef, `session:fake-${runtime}-fixture`);
    assert.equal(flow.presented.toolUseOrRequestRef, `request:fake-${runtime}-fixture`);
    assert.equal(flow.observed.hostReturnObservedClaimDigest, flow.hostReturn.hostReturnObservedClaimDigest);
    assert.equal(nativeDecisionAuthorityGate(flow.claimed.challenge).executionAllowed, false);
    assert.equal(nativeHostAnswerSubstrateGate(flow.observed).executionAllowed, false);

    const consumed = consumeNativeHostReturnObservedClaim(flow.observed, {
      at: CONSUMED_AT,
      timeSourceClaimRef: `clock:fake-${runtime}-consume`,
      consumerRef: `consumer:fake-${runtime}-integration`,
    });
    flow.repository.consume(cas(consumed, flow.observed));
    const reopened = createNativeHostAnswerRepository({ profileRoot: root });
    assert.equal(reopened.read({ substrateRef: consumed.substrateRef }).state, "consumed");
    assert.equal(nativeHostAnswerSubstrateGate(consumed).executionAllowed, false);
    assert.doesNotMatch(JSON.stringify(consumed), /answered_verified|executionAllowed|rawAnswer/iu);
  }
});

test("payload or host-context substitution fails even after a valid fake host return", (t) => {
  const flow = runFakeHostFlow("codex", profile(t, "payload-substitution"));
  for (const mismatch of [
    { renderedHostPayloadDigest: digest({ forged: true }) },
    { hostConnectionRef: "connection:forged-fixture" },
    { sessionOrThreadRef: "session:forged-fixture" },
    { turnRef: "turn:forged-fixture" },
    { itemRef: "item:forged-fixture" },
    { toolUseOrRequestRef: "request:forged-fixture" },
  ]) {
    assert.throws(
      () => recordNativeHostReturnObservedClaim(
        flow.decision,
        flow.claimed.challenge,
        flow.presented,
        observationInput(flow.presented, flow.hostReturn, mismatch),
      ),
      /does not match (?:authority|substrate) binding/u,
    );
  }
});

test("durable replay protection rejects a self-consistent public rebind with the same substrateRef", (t) => {
  const root = profile(t, "self-consistent-rebind");
  const decision = decisionFixture("codex");
  const prepared = codexPrepared(decision);
  const port = createFakeNativeHostPortFixture("codex");
  const firstPresentation = port.present(prepared.payload);
  const first = presentNativeHostAnswerSubstrate(
    decision,
    prepared.challenge,
    authorityPresentationInput("codex", prepared.challenge, firstPresentation),
  );
  const repository = createNativeHostAnswerRepository({ profileRoot: root });
  repository.issue(first);

  const rebound = presentNativeHostAnswerSubstrate(
    decision,
    prepared.challenge,
    authorityPresentationInput("codex", prepared.challenge, {
      ...firstPresentation,
      renderedHostPayloadDigest: digest({ different: "rendered payload" }),
      hostConnectionRef: "connection:rebound-fixture",
    }),
  );
  assert.notEqual(rebound.substrateDigest, first.substrateDigest);
  assert.throws(
    () => repository.issue(rebound),
    (error) => error.code === "NATIVE_HOST_ANSWER_REPOSITORY_REPLAY",
  );
});

test("one native challenge/request/host context cannot be duplicated under a different substrateRef", (t) => {
  const root = profile(t, "duplicate-context");
  const decision = decisionFixture("codex");
  const prepared = codexPrepared(decision);
  const port = createFakeNativeHostPortFixture("codex");
  const hostPresentation = port.present(prepared.payload);
  const first = presentNativeHostAnswerSubstrate(
    decision,
    prepared.challenge,
    authorityPresentationInput("codex", prepared.challenge, hostPresentation),
  );
  const duplicate = presentNativeHostAnswerSubstrate(
    decision,
    prepared.challenge,
    authorityPresentationInput("codex", prepared.challenge, hostPresentation, {
      substrateRef: "substrate:fake-codex-duplicate",
    }),
  );
  const repository = createNativeHostAnswerRepository({ profileRoot: root });
  repository.issue(first);
  assert.throws(
    () => repository.issue(duplicate),
    (error) => error.code === "NATIVE_HOST_ANSWER_REPOSITORY_REPLAY",
  );
});

test("the same claimed host event cannot be replayed under a different Decision challenge", (t) => {
  const root = profile(t, "cross-challenge-event-replay");
  const firstDecision = decisionFixture("codex");
  const secondDecision = presentDecision(createDecision({
    identity: {
      runId: "run:fake-codex-cross-challenge",
      taskFingerprint: "digest:fake-codex-cross-challenge",
      decisionKey: "decision:cross-challenge-route",
      scopeRef: "scope:integration-fixture",
    },
    routeChangingDimensions: ["scope"],
    evidence: [{ evidenceRef: "evidence:integration", digest: "sha256:integration" }],
    options: [
      {
        optionId: "option:preserve",
        displayRef: "display:preserve",
        tradeoffRefs: ["tradeoff:low-risk"],
        evidenceRefs: ["evidence:integration"],
      },
      {
        optionId: "option:change",
        displayRef: "display:change",
        tradeoffRefs: ["tradeoff:more-work"],
        evidenceRefs: ["evidence:integration"],
      },
    ],
    requirement: {
      required: true,
      reasonRef: "reason:branching-route",
      evidenceRefs: ["evidence:integration"],
    },
    nativeSurface: { runtime: "codex", surface: "request_user_input", primary: true },
    createdAt: "2026-08-10T00:59:00.000Z",
  }), { at: PRESENTED_AT });
  const firstChallenge = codexPrepared(firstDecision).challenge;
  const secondChallenge = issueNativeDecisionChallenge(secondDecision, {
    runtime: "codex",
    surface: "request_user_input",
    challengeRef: "challenge:fake-codex-cross-challenge",
    requestRef: "request:fake-codex-cross-challenge",
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
  });
  const port = createFakeNativeHostPortFixture("codex");
  const hostPresentation = port.present(codexPrepared(firstDecision).payload);
  const first = presentNativeHostAnswerSubstrate(
    firstDecision,
    firstChallenge,
    authorityPresentationInput("codex", firstChallenge, hostPresentation),
  );
  const replay = presentNativeHostAnswerSubstrate(
    secondDecision,
    secondChallenge,
    authorityPresentationInput("codex", secondChallenge, hostPresentation, {
      substrateRef: "substrate:fake-codex-cross-challenge",
    }),
  );
  assert.notEqual(first.challengeDigest, replay.challengeDigest);
  assert.equal(first.hostEventClaimDigest, replay.hostEventClaimDigest);
  const repository = createNativeHostAnswerRepository({ profileRoot: root });
  repository.issue(first);
  assert.throws(
    () => repository.issue(replay),
    (error) => error.code === "NATIVE_HOST_ANSWER_REPOSITORY_REPLAY",
  );
});

test("competing integration consumers produce one durable CAS winner across reopened repository handles", async (t) => {
  const root = profile(t, "competing-consumers");
  const flow = runFakeHostFlow("claude", root);
  const next = consumeNativeHostReturnObservedClaim(flow.observed, {
    at: CONSUMED_AT,
    timeSourceClaimRef: "clock:fake-competing-consume",
    consumerRef: "consumer:fake-competing",
  });
  const first = createNativeHostAnswerRepository({ profileRoot: root });
  const second = createNativeHostAnswerRepository({ profileRoot: root });
  const attempts = await Promise.allSettled([
    Promise.resolve().then(() => first.consume(cas(next, flow.observed))),
    Promise.resolve().then(() => second.consume(cas(next, flow.observed))),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
  assert.equal(
    createNativeHostAnswerRepository({ profileRoot: root })
      .read({ substrateRef: flow.observed.substrateRef }).state,
    "consumed",
  );
});

test("observed authority can durably expire or invalidate, and neither terminal path authorizes", (t) => {
  for (const transition of ["expire", "invalidate"]) {
    const root = profile(t, `observed-${transition}`);
    const flow = runFakeHostFlow("codex", root);
    const terminal = transition === "expire"
      ? expireNativeHostAnswerSubstrate(flow.observed, {
          at: EXPIRES_AT,
          timeSourceClaimRef: "clock:fake-expiry",
        })
      : invalidateNativeHostAnswerSubstrate(flow.observed, {
          at: CONSUMED_AT,
          timeSourceClaimRef: "clock:fake-invalidation",
          reasonRef: "reason:fake-host-closed",
        });
    flow.repository[transition](cas(terminal, flow.observed));
    const persisted = createNativeHostAnswerRepository({ profileRoot: root })
      .read({ substrateRef: terminal.substrateRef });
    assert.equal(persisted.state, transition === "expire" ? "expired" : "invalidated");
    assert.equal(nativeHostAnswerSubstrateGate(persisted).executionAllowed, false);
  }
});

test("public substrate and repository exports contain no verifier, trusted-answer, answered, or authorizer API", async () => {
  const substrateModule = await import("../../src/domain/decision/native-host-answer-authority.mjs");
  const repositoryModule = await import("../../src/data/repositories/native-host-answer-repository.mjs");
  const exportsText = [...Object.keys(substrateModule), ...Object.keys(repositoryModule)].join("\n");
  assert.doesNotMatch(exportsText, /verify|answered|trustedAnswer|authoriz(?:e|ation)/iu);
  assert.equal(Object.hasOwn(substrateModule, "answered_verified"), false);
  assert.equal(Object.hasOwn(substrateModule, "verifyNativeHostAnswer"), false);
  assert.equal(Object.hasOwn(substrateModule, "authorizeExecution"), false);

  const sourceText = [
    readFileSync(new URL("../../src/domain/decision/native-host-answer-authority.mjs", import.meta.url), "utf8"),
    readFileSync(new URL("../../src/data/repositories/native-host-answer-repository.mjs", import.meta.url), "utf8"),
    readFileSync(new URL("../../src/adapters/codex/app-server-decision-host-adapter.mjs", import.meta.url), "utf8"),
    readFileSync(new URL("../../src/adapters/claude/sdk-decision-host-adapter.mjs", import.meta.url), "utf8"),
  ].join("\n");
  assert.doesNotMatch(sourceText, /state\s*[:=]\s*["']answered_verified["']/iu);
  assert.doesNotMatch(sourceText, /executionAllowed\s*:\s*true/iu);
  assert.doesNotMatch(sourceText, /process\.exit(?:Code)?\s*=/u);
  assert.doesNotMatch(sourceText, /process\.exit\s*\(/u);
  assert.doesNotMatch(sourceText, /process\.env\.[A-Z0-9_]*(?:CRASH|FAIL|INTERRUPT)/u);
});

test("host payload public helpers reject trapping Proxy inputs with bounded adapter errors", () => {
  const hostile = new Proxy({}, {
    getPrototypeOf() {
      throw new Error("trap-secret-get-prototype");
    },
    ownKeys() {
      throw new Error("trap-secret-own-keys");
    },
    getOwnPropertyDescriptor() {
      throw new Error("trap-secret-descriptor");
    },
  });
  for (const invoke of [
    () => codexRenderedHostPayloadDigest(hostile),
    () => digestClaudeRenderedAskUserQuestion(hostile),
  ]) {
    assert.throws(invoke, (error) => {
      assert.match(error.message, /Proxy/u);
      assert.doesNotMatch(error.message, /trap-secret/u);
      return true;
    });
  }
});
