import assert from "node:assert/strict";
import test from "node:test";

import { createDecision, presentDecision } from "../../src/domain/decision/decision.mjs";
import { issueNativeDecisionChallenge } from "../../src/domain/decision/native-decision-authority.mjs";
import {
  CODEX_NATIVE_RETURN_REPROMPT_REQUIRED,
  createCodexNativeReturnComposition,
} from "../../scripts/live-acceptance/codex-native-return-composition.mjs";
import {
  buildScriptedRequestUserInputResponse,
  redactProbeDiagnostic,
  snapshotTransportRequest,
} from "../../scripts/live-acceptance/probe-codex-request-user-input-app-server.mjs";

const ISSUED_AT = "2026-08-10T05:00:10.000Z";
const OBSERVED_AT = "2026-08-10T05:00:20.000Z";
const EXPIRES_AT = "2026-08-10T05:01:00.000Z";

function decision() {
  return presentDecision(createDecision({
    identity: { runId: "run:composition", taskFingerprint: "digest:task", decisionKey: "decision:route", scopeRef: "scope:deploy" },
    routeChangingDimensions: ["scope"],
    evidence: [{ evidenceRef: "evidence:route", digest: "sha256:route" }],
    options: [
      { optionId: "option:keep", displayRef: "display:keep", tradeoffRefs: ["tradeoff:safe"], evidenceRefs: ["evidence:route"] },
      { optionId: "option:change", displayRef: "display:change", tradeoffRefs: ["tradeoff:work"], evidenceRefs: ["evidence:route"] },
    ],
    requirement: { required: true, reasonRef: "reason:branch", evidenceRefs: ["evidence:route"] },
    nativeSurface: { runtime: "codex", surface: "request_user_input", primary: true },
    createdAt: "2026-08-10T05:00:00.000Z",
  }), { at: "2026-08-10T05:00:05.000Z" });
}

function command() {
  const current = decision();
  return {
    decision: current,
    issuedChallenge: issueNativeDecisionChallenge(current, {
      runtime: "codex",
      surface: "request_user_input",
      challengeRef: "challenge:composition",
      requestRef: "request:composition",
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
    }),
    expectedBinding: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" },
    presentation: {
      question: {
        id: "route_choice",
        header: "Route",
        question: "Choose the route.",
        options: [
          { optionId: "option:keep", label: "Keep", description: "Keep current route." },
          { optionId: "option:change", label: "Change", description: "Change route." },
        ],
      },
    },
    actionBinding: { actionRef: "action:deploy", scopeRef: "scope:deploy" },
  };
}

function request() {
  return {
    id: 71,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      questions: [{
        id: "route_choice",
        header: "Route",
        question: "Choose the route.",
        options: [
          { label: "Keep", description: "Keep current route." },
          { label: "Change", description: "Change route." },
        ],
      }],
    },
  };
}

function response() {
  return {
    id: 71,
    result: { answers: { route_choice: { answers: ["Keep"] } } },
  };
}

function memoryRepository({ events = [] } = {}) {
  let record = null;
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
      record = input.record;
      return record;
    },
    async read({ substrateRef }) {
      events.push("repository_read");
      if (!record || record.substrateRef !== substrateRef) {
        const error = new Error("not found");
        error.code = "NATIVE_HOST_ANSWER_REPOSITORY_NOT_FOUND";
        throw error;
      }
      return record;
    },
  };
}

function host({ ackFailures = 0, duplicateCallback = false } = {}) {
  let ackCount = 0;
  let callbackCount = 0;
  let failures = ackFailures;
  return {
    port: {
      hostConnectionRef: "host:codex-app-server-live-callback",
      async takeRequestUserInput() {
        return { request: request(), timeSourceClaimRef: "time:request" };
      },
      async waitForNativeReturn({ requestId, onReturn }) {
        assert.equal(requestId, 71);
        callbackCount += 1;
        onReturn({ response: response(), at: OBSERVED_AT, timeSourceClaimRef: "time:return" });
        if (duplicateCallback) onReturn({ response: response(), at: OBSERVED_AT, timeSourceClaimRef: "time:return" });
      },
      async ackResponse() {
        ackCount += 1;
        if (failures > 0) {
          failures -= 1;
          throw new Error("ack failed");
        }
      },
    },
    ackCount: () => ackCount,
    callbackCount: () => callbackCount,
  };
}

function composition({ repository = memoryRepository(), transport = host() } = {}) {
  return {
    subject: createCodexNativeReturnComposition({ hostConnection: transport.port, repository }),
    repository,
    transport,
  };
}

test("records one exact action/scope binding before ack and exports no capability or authority", async () => {
  const order = [];
  const transport = host();
  const originalAck = transport.port.ackResponse;
  transport.port.ackResponse = async (input) => {
    order.push("ack");
    return originalAck(input);
  };
  const repository = memoryRepository({ events: order });
  const { subject } = composition({ transport, repository });
  const result = await subject.observeRequiredDecisionTransport(command());

  assert.equal(order.at(-1), "ack");
  assert.ok(order.includes("repository_read"));
  assert.equal(result.status, "transport_observed_binding_receipt_recorded");
  assert.equal(result.evidenceClass, "transport_observed");
  assert.equal(result.executionAllowed, false);
  assert.equal(result.humanVerified, false);
  assert.equal(result.currentHostAuthority, false);
  assert.equal(result.bindingReceipt.status, "recorded_before_ack");
  assert.equal(result.authorityBoundary, "injectable_transport_seam_permanently_non_authorizing");
  assert.doesNotMatch(JSON.stringify(result), /capability|Choose the route|Keep current/u);
  assert.equal(Object.hasOwn(result.bindingReceipt, "selectedOptionId"), false);
});

test("ack retry in the same process reuses only the private binding receipt", async () => {
  const repository = memoryRepository();
  const transport = host({ ackFailures: 1 });
  const { subject } = composition({ repository, transport });
  await assert.rejects(() => subject.observeRequiredDecisionTransport(command()), /ack failed/u);
  const recovered = await subject.retryPendingAck();
  assert.equal(recovered.executionAllowed, false);
  assert.equal(transport.ackCount(), 2);
  assert.equal(transport.callbackCount(), 1);
});

test("successful ack destroys the receipt and same-event replay requires a fresh prompt", async () => {
  const repository = memoryRepository();
  const transport = host();
  const { subject } = composition({ repository, transport });
  await subject.observeRequiredDecisionTransport(command());
  await assert.rejects(
    () => subject.observeRequiredDecisionTransport(command()),
    (error) => error.code === CODEX_NATIVE_RETURN_REPROMPT_REQUIRED,
  );
  assert.equal(transport.callbackCount(), 1, "replay must fail before another return callback");
  assert.equal(transport.ackCount(), 1, "replay must not reuse the destroyed receipt for ack");
});

test("restart loses the transient capability and requires re-prompt from an observed durable record", async () => {
  const repository = memoryRepository();
  const firstTransport = host({ ackFailures: 1 });
  const first = composition({ repository, transport: firstTransport });
  await assert.rejects(() => first.subject.observeRequiredDecisionTransport(command()), /ack failed/u);

  const restarted = composition({ repository, transport: host() });
  await assert.rejects(
    () => restarted.subject.observeRequiredDecisionTransport(command()),
    (error) => error.code === CODEX_NATIVE_RETURN_REPROMPT_REQUIRED,
  );
});

test("scope mismatch and duplicate return callbacks fail closed", async () => {
  const mismatched = command();
  mismatched.actionBinding = { actionRef: "action:deploy", scopeRef: "scope:other" };
  await assert.rejects(
    () => composition().subject.observeRequiredDecisionTransport(mismatched),
    /exactly match Decision identity.scopeRef/u,
  );

  await assert.rejects(
    () => composition({ transport: host({ duplicateCallback: true }) }).subject.observeRequiredDecisionTransport(command()),
    /exactly once/u,
  );
});

test("real-process probe response builder accepts only an exact rendered option and remains data-only", () => {
  const built = buildScriptedRequestUserInputResponse(request(), "Keep");
  assert.deepEqual(built, response());
  assert.throws(() => buildScriptedRequestUserInputResponse(request(), "Forged"), /not present/u);
  assert.doesNotMatch(JSON.stringify(built), /executionAllowed|currentHostAuthority|humanVerified/u);
  const withNativeOther = request();
  withNativeOther.params.questions[0].isOther = true;
  assert.equal(snapshotTransportRequest(withNativeOther).params.questions[0].isOther, true);
  assert.deepEqual(buildScriptedRequestUserInputResponse(withNativeOther, "Keep"), response());
});

test("probe diagnostics redact secrets, providers, and absolute user paths", () => {
  const diagnostic = redactProbeDiagnostic([
    "Authorization: Bearer live.secret-token",
    "api_key=sk-secret",
    "password=hunter2",
    "provider=minimax",
    "C:\\Users\\Kim\\.codex\\sessions\\raw.jsonl",
    "/home/kim/.codex/sessions/raw.jsonl",
    "raw answer UltraSecretChoice",
  ].join("\n"), ["UltraSecretChoice"]);
  assert.doesNotMatch(diagnostic, /live\.secret|sk-secret|hunter2|minimax|Users\\Kim|\/home\/kim|UltraSecretChoice/u);
  assert.match(diagnostic, /<redacted>|<redacted-path>/u);
});

test("probe request snapshot rejects active caller objects and boundedness attacks", () => {
  let getterCalls = 0;
  const accessor = request();
  Object.defineProperty(accessor.params, "threadId", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "thread-1";
    },
  });
  assert.throws(() => snapshotTransportRequest(accessor), /data properties/u);
  assert.equal(getterCalls, 0);

  assert.throws(() => snapshotTransportRequest(new Proxy(request(), {})), /Proxy/u);

  const withToJson = request();
  Object.defineProperty(withToJson, "toJSON", { enumerable: false, value() { return {}; } });
  assert.throws(() => snapshotTransportRequest(withToJson), /enumerable string own data properties/u);

  const extra = request();
  extra.callerTrusted = true;
  assert.throws(() => snapshotTransportRequest(extra), /unsupported fields/u);

  const sparse = request();
  sparse.params.questions[0].options = new Array(2);
  sparse.params.questions[0].options[0] = { label: "Keep", description: "Keep current route." };
  assert.throws(() => snapshotTransportRequest(sparse), /sparse entries/u);

  const cycle = request();
  cycle.params.questions[0].options[0].self = cycle.params.questions[0].options[0];
  assert.throws(() => snapshotTransportRequest(cycle), /unsupported fields/u);

  const tooMany = request();
  tooMany.params.questions[0].options = Array.from({ length: 65 }, (_, index) => ({
    label: `Option ${index}`,
    description: "bounded",
  }));
  assert.throws(() => snapshotTransportRequest(tooMany), /safety limit/u);

  const tooLarge = request();
  tooLarge.params.questions[0].options = Array.from({ length: 40 }, (_, index) => ({
    label: `Option ${index}`,
    description: "x".repeat(2_000),
  }));
  assert.throws(() => snapshotTransportRequest(tooLarge), /byte limit/u);
});
