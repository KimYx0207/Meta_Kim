import assert from "node:assert/strict";
import test from "node:test";

import { createDecision, presentDecision } from "../../src/domain/decision/decision.mjs";
import { issueNativeDecisionChallenge } from "../../src/domain/decision/native-decision-authority.mjs";
import {
  codexHostCorrelationRef,
  codexRenderedHostPayloadDigest,
  createCodexAppServerDecisionHostAdapter,
  snapshotCodexRequestUserInputRequest,
} from "../../src/adapters/codex/app-server-decision-host-adapter.mjs";

const ISSUED_AT = "2026-08-10T00:01:10.000Z";
const OBSERVED_AT = "2026-08-10T00:01:20.000Z";
const EXPIRES_AT = "2026-08-10T00:02:00.000Z";

function fixtureDecision() {
  return presentDecision(createDecision({
    identity: { runId: "run:codex-app-host", taskFingerprint: "digest:task", decisionKey: "decision:route", scopeRef: "scope:test" },
    routeChangingDimensions: ["scope"],
    evidence: [{ evidenceRef: "evidence:route", digest: "sha256:route" }],
    options: [
      { optionId: "option:preserve", displayRef: "display:preserve", tradeoffRefs: ["tradeoff:low-risk"], evidenceRefs: ["evidence:route"] },
      { optionId: "option:change", displayRef: "display:change", tradeoffRefs: ["tradeoff:more-work"], evidenceRefs: ["evidence:route"] },
    ],
    requirement: { required: true, reasonRef: "reason:branch", evidenceRefs: ["evidence:route"] },
    nativeSurface: { runtime: "codex", surface: "request_user_input", primary: true },
    createdAt: "2026-08-10T00:00:00.000Z",
  }), { at: "2026-08-10T00:01:00.000Z" });
}

function fixtureChallenge(decision = fixtureDecision(), overrides = {}) {
  return issueNativeDecisionChallenge(decision, {
    runtime: "codex",
    surface: "request_user_input",
    challengeRef: "challenge:codex-app-host",
    requestRef: "request:foundation",
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    ...overrides,
  });
}

function presentation(questionOverrides = {}) {
  return {
    question: {
      id: "route_choice",
      header: "Route",
      question: "Choose the route that should continue.",
      options: [
        { optionId: "option:preserve", label: "Preserve", description: "Keep the current route." },
        { optionId: "option:change", label: "Change", description: "Take the new route." },
      ],
      ...questionOverrides,
    },
  };
}

function hostRequest(overrides = {}) {
  const request = {
    id: 41,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      questions: [{
        id: "route_choice",
        header: "Route",
        question: "Choose the route that should continue.",
        options: [
          { label: "Preserve", description: "Keep the current route." },
          { label: "Change", description: "Take the new route." },
        ],
      }],
    },
  };
  return { ...request, ...overrides, params: { ...request.params, ...(overrides.params ?? {}) } };
}

function hostResponse(overrides = {}) {
  return {
    id: 41,
    result: { answers: { route_choice: { answers: ["Preserve"] } } },
    ...overrides,
  };
}

function memoryRepository({ failObserveBeforeWrite = false, failObserveAfterWrite = false } = {}) {
  let record = null;
  let beforeFailureRemaining = failObserveBeforeWrite;
  let afterFailureRemaining = failObserveAfterWrite;
  return {
    async issue(next) {
      if (record) {
        const error = new Error("replay");
        error.code = "NATIVE_HOST_ANSWER_REPOSITORY_REPLAY";
        throw error;
      }
      record = next;
      return record;
    },
    async observe(input) {
      assert.equal(input.expectedRevision, record.revision);
      assert.equal(input.expectedSubstrateDigest, record.substrateDigest);
      assert.equal(input.expectedState, record.state);
      if (beforeFailureRemaining) {
        beforeFailureRemaining = false;
        throw new Error("simulated crash before observe CAS write");
      }
      record = input.record;
      if (afterFailureRemaining) {
        afterFailureRemaining = false;
        throw new Error("simulated crash after observe CAS write");
      }
      return record;
    },
    async read({ substrateRef }) {
      assert.equal(substrateRef, record?.substrateRef);
      return record;
    },
    current() { return record; },
  };
}

function replayingHostConnection({ request = hostRequest(), response = hostResponse() } = {}) {
  let acknowledged = false;
  let ackCount = 0;
  const port = {
    hostConnectionRef: "host:codex-app-server",
    async takeRequestUserInput() {
      return { request, timeSourceClaimRef: "time-source:request-observed" };
    },
    async takeResponse() {
      return { response, at: OBSERVED_AT, timeSourceClaimRef: "time-source:return-observed" };
    },
    async ackResponse() {
      acknowledged = true;
      ackCount += 1;
    },
  };
  return { port, acknowledged: () => acknowledged, ackCount: () => ackCount };
}

function fixtureAdapter({ request = hostRequest(), response = hostResponse(), repository = memoryRepository(), transport = replayingHostConnection({ request, response }) } = {}) {
  const hostConnection = transport.port;
  const repositoryPort = {
    issue: (record) => repository.issue(record),
    observe: (input) => repository.observe(input),
    read: (input) => repository.read(input),
  };
  return { adapter: createCodexAppServerDecisionHostAdapter({ hostConnection, repository: repositoryPort }), repository, hostConnection, transport };
}

function observe(adapter, overrides = {}) {
  const decision = fixtureDecision();
  return adapter.observeRequiredDecision({
    decision,
    issuedChallenge: fixtureChallenge(decision),
    expectedBinding: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" },
    presentation: presentation(),
    ...overrides,
  });
}

test("binds the actual app-server request and response to a digest-only non-authorizing substrate", async () => {
  const request = hostRequest();
  const { adapter, repository } = fixtureAdapter({ request });
  const result = await observe(adapter);

  assert.equal(result.challenge.state, "host_answer_claimed");
  assert.equal(result.challenge.selectedOptionId, "option:preserve");
  assert.equal(result.substrate.state, "host_return_observed");
  assert.equal(result.substrate.renderedHostPayloadDigest, codexRenderedHostPayloadDigest(request));
  assert.equal(result.substrate.hostConnectionRef, "host:codex-app-server");
  assert.equal(result.substrate.sessionOrThreadRef, codexHostCorrelationRef("codex-thread", "thread-1"));
  assert.equal(result.substrate.turnRef, codexHostCorrelationRef("codex-turn", "turn-1"));
  assert.equal(result.substrate.itemRef, codexHostCorrelationRef("codex-item", "item-1"));
  assert.equal(result.substrate.toolUseOrRequestRef, codexHostCorrelationRef("codex-json-rpc-request", 41));
  assert.equal(result.repositoryCas.expectedSubstrateDigest, result.substrate.substrateDigest);
  assert.equal(result.executionAllowed, false);
  assert.equal(result.status, "non_authorizing_host_return_observation");
  assert.equal(result.gate.executionAllowed, false);
  assert.equal(result.gate.blockedReason, "native_host_return_observed_not_verified");
  assert.deepEqual(repository.current(), result.substrate);
  assert.doesNotMatch(JSON.stringify(result.substrate), /Choose the route|Preserve|current route/u);
});

test("rejects JSON-RPC request-id, thread, turn, and item mismatches", async () => {
  const mismatches = [
    { request: hostRequest(), response: hostResponse({ id: "41" }), expected: {} },
    { request: hostRequest({ params: { threadId: "thread-other" } }), response: hostResponse(), expected: {} },
    { request: hostRequest({ params: { turnId: "turn-other" } }), response: hostResponse(), expected: {} },
    { request: hostRequest({ params: { itemId: "item-other" } }), response: hostResponse(), expected: {} },
  ];
  for (const fixture of mismatches) {
    const { adapter } = fixtureAdapter(fixture);
    await assert.rejects(() => observe(adapter), /request id|thread, turn, or item binding/u);
  }
});

test("detects rendered payload tampering before repository issue", async () => {
  for (const request of [
    hostRequest({ params: { questions: [{ ...hostRequest().params.questions[0], question: "Tampered prompt" }] } }),
    hostRequest({ params: { questions: [{ ...hostRequest().params.questions[0], options: [{ label: "Forged", description: "Wrong" }, hostRequest().params.questions[0].options[1]] }] } }),
  ]) {
    const repository = memoryRepository();
    const { adapter } = fixtureAdapter({ request, repository });
    await assert.rejects(() => observe(adapter), /does not match the Decision presentation/u);
    assert.equal(repository.current(), null);
  }
});

test("repository identity blocks the same host event from being rebound to another challenge", async () => {
  const repository = memoryRepository();
  const transport = replayingHostConnection();
  const first = fixtureAdapter({ repository, transport });
  await observe(first.adapter);

  const second = fixtureAdapter({ repository, transport });
  const decision = fixtureDecision();
  await assert.rejects(() => second.adapter.observeRequiredDecision({
    decision,
    issuedChallenge: fixtureChallenge(decision, { challengeRef: "challenge:different" }),
    expectedBinding: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" },
    presentation: presentation(),
  }), /another Decision challenge|exact native Decision challenge/u);
});

test("rejects accessors and proxies without invoking caller code", async () => {
  let getterCalls = 0;
  const request = hostRequest();
  Object.defineProperty(request.params, "threadId", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "thread-1";
    },
  });
  const accessorFixture = fixtureAdapter({ request });
  await assert.rejects(() => observe(accessorFixture.adapter), /data properties/u);
  assert.equal(getterCalls, 0);

  const proxyFixture = fixtureAdapter({ request: new Proxy(hostRequest(), {}) });
  await assert.rejects(() => observe(proxyFixture.adapter), /Proxy/u);

  const connection = fixtureAdapter().hostConnection;
  assert.throws(
    () => createCodexAppServerDecisionHostAdapter({
      hostConnection: new Proxy(connection, {}),
      repository: { issue() {}, observe() {}, read() {} },
    }),
    /Proxy/u,
  );

  const proxiedMethodConnection = {
    ...connection,
    takeResponse: new Proxy(connection.takeResponse, {}),
  };
  assert.throws(
    () => createCodexAppServerDecisionHostAdapter({
      hostConnection: proxiedMethodConnection,
      repository: { issue() {}, observe() {}, read() {} },
    }),
    /Proxy/u,
  );
});

test("unacknowledged responses replay across crashes before and after observe CAS", async () => {
  for (const repository of [
    memoryRepository({ failObserveBeforeWrite: true }),
    memoryRepository({ failObserveAfterWrite: true }),
  ]) {
    const transport = replayingHostConnection();
    const first = fixtureAdapter({ repository, transport });
    await assert.rejects(() => observe(first.adapter), /simulated crash/u);
    assert.equal(transport.acknowledged(), false, "response must not be acked before durable observation exists");

    const restarted = fixtureAdapter({ repository, transport });
    const recovered = await observe(restarted.adapter);
    assert.equal(recovered.substrate.state, "host_return_observed");
    assert.equal(recovered.executionAllowed, false);
    assert.equal(transport.acknowledged(), true);
    assert.equal(transport.ackCount(), 1);
  }
});

test("records a host-presented Other affordance but accepts only one known option label", async () => {
  const question = { ...hostRequest().params.questions[0], isOther: true };
  const request = hostRequest({ params: { questions: [question] } });
  const successful = fixtureAdapter({ request });
  const result = await observe(successful.adapter, { presentation: presentation({ isOther: true }) });

  assert.equal(snapshotCodexRequestUserInputRequest(request).params.questions[0].isOther, true);
  assert.equal(result.challenge.selectedOptionId, "option:preserve");
  assert.equal(result.executionAllowed, false);
  assert.equal(result.gate.executionAllowed, false);

  for (const answer of ["Other", "a freeform route", "Unknown"]) {
    const repository = memoryRepository();
    const { adapter } = fixtureAdapter({
      request,
      response: hostResponse({ result: { answers: { route_choice: { answers: [answer] } } } }),
      repository,
    });
    await assert.rejects(
      () => observe(adapter, { presentation: presentation({ isOther: true }) }),
      /unknown or freeform answer/u,
    );
    assert.equal(JSON.stringify(repository.current()).includes(answer), false);
  }

  for (const answers of [[], ["Preserve", "Change"]]) {
    const repository = memoryRepository();
    const { adapter } = fixtureAdapter({
      request,
      response: hostResponse({ result: { answers: { route_choice: { answers } } } }),
      repository,
    });
    await assert.rejects(
      () => observe(adapter, { presentation: presentation({ isOther: true }) }),
      /must contain one selected option label/u,
    );
    assert.equal(repository.current()?.state, "presented");
  }
});

test("requires the presentation to record the exact host isOther fact", async () => {
  const hostOtherQuestion = { ...hostRequest().params.questions[0], isOther: true };
  const cases = [
    {
      request: hostRequest({ params: { questions: [hostOtherQuestion] } }),
      expectedPresentation: presentation(),
    },
    {
      request: hostRequest(),
      expectedPresentation: presentation({ isOther: true }),
    },
    {
      request: hostRequest({ params: { questions: [{ ...hostRequest().params.questions[0], isOther: false }] } }),
      expectedPresentation: presentation({ isOther: true }),
    },
  ];
  for (const fixture of cases) {
    const repository = memoryRepository();
    const { adapter } = fixtureAdapter({ request: fixture.request, repository });
    await assert.rejects(
      () => observe(adapter, { presentation: fixture.expectedPresentation }),
      /does not match the Decision presentation/u,
    );
    assert.equal(repository.current(), null);
  }
});

test("blocks secret mode and unknown answers without persisting the raw answer", async () => {
  const question = { ...hostRequest().params.questions[0], isSecret: true };
  const secretModeRepository = memoryRepository();
  const secretModeFixture = fixtureAdapter({
    request: hostRequest({ params: { questions: [question] } }),
    repository: secretModeRepository,
  });
  await assert.rejects(() => observe(secretModeFixture.adapter), /secret input/u);
  assert.equal(secretModeRepository.current(), null);

  const repository = memoryRepository();
  const secret = "sk-live-raw-secret-answer";
  const { adapter } = fixtureAdapter({ response: hostResponse({ result: { answers: { route_choice: { answers: [secret] } } } }), repository });
  await assert.rejects(() => observe(adapter), /unknown or freeform answer/u);
  assert.equal(JSON.stringify(repository.current()).includes(secret), false);
});

test("canonical renderer is stable across key order and sensitive to actual optional-field presence", () => {
  const request = hostRequest();
  const reordered = {
    params: {
      questions: request.params.questions.map((question) => ({
        options: question.options.map((option) => ({ description: option.description, label: option.label })),
        question: question.question,
        header: question.header,
        id: question.id,
      })),
      itemId: request.params.itemId,
      turnId: request.params.turnId,
      threadId: request.params.threadId,
    },
    method: request.method,
    id: request.id,
  };
  assert.equal(codexRenderedHostPayloadDigest(request), codexRenderedHostPayloadDigest(reordered));
  const explicitDefaults = hostRequest({ params: { questions: [{ ...hostRequest().params.questions[0], isOther: false, isSecret: false }] } });
  assert.notEqual(codexRenderedHostPayloadDigest(request), codexRenderedHostPayloadDigest(explicitDefaults));
  assert.deepEqual(snapshotCodexRequestUserInputRequest(request), request);
});

test("public digest surface accepts only schema-bound host requests or scalar correlation values", async () => {
  const module = await import("../../src/adapters/codex/app-server-decision-host-adapter.mjs");
  assert.equal(Object.hasOwn(module, "codexAppServerCanonicalDigest"), false);
  assert.throws(() => codexRenderedHostPayloadDigest(new Proxy(hostRequest(), {})), /Proxy/u);
  assert.throws(() => codexHostCorrelationRef("codex-thread", { value: "thread-1" }), /string or safe integer/u);
});
