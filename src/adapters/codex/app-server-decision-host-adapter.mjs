/**
 * Codex app-server boundary for native Decision return observations.
 *
 * The injected connection is a narrow host capability, not independent proof
 * that Codex or a human produced a verified answer. This adapter snapshots the
 * actual `item/tool/requestUserInput` JSON-RPC exchange, emits digest-only
 * bindings, and must remain non-authorizing.
 */

import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import { assertValidDecision } from "../../domain/decision/decision.mjs";
import {
  claimNativeDecisionChallenge,
} from "../../domain/decision/native-decision-authority.mjs";
import {
  assertValidNativeHostAnswerSubstrate,
  nativeHostAnswerSubstrateGate,
  presentNativeHostAnswerSubstrate,
  recordNativeHostReturnObservedClaim,
} from "../../domain/decision/native-host-answer-authority.mjs";

export const CODEX_APP_SERVER_REQUEST_USER_INPUT_METHOD = "item/tool/requestUserInput";

const REQUEST_FIELDS = Object.freeze(["id", "method", "params"]);
const PARAM_FIELDS = Object.freeze(["threadId", "turnId", "itemId", "questions", "autoResolutionMs"]);
const QUESTION_FIELDS = Object.freeze(["id", "header", "question", "options", "isOther", "isSecret"]);
const OPTION_FIELDS = Object.freeze(["label", "description"]);

function fail(message) {
  throw new TypeError(`Codex app-server Decision host adapter: ${message}`);
}

function rejectProxy(value, label) {
  if (value && ["object", "function"].includes(typeof value) && utilTypes.isProxy(value)) fail(`${label} must not be a Proxy`);
}

function plainRecord(value, label) {
  rejectProxy(value, label);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain Object.prototype record`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || descriptor?.enumerable !== true || !("value" in descriptor)) {
      fail(`${label} must contain enumerable string own data properties only`);
    }
  }
  return value;
}

function recordSnapshot(value, label, allowed, required = allowed) {
  plainRecord(value, label);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => !allowed.includes(key))) fail(`${label} contains unsupported fields`);
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${label} is missing a required field`);
  return Object.fromEntries(keys.map((key) => [key, Object.getOwnPropertyDescriptor(value, key).value]));
}

function denseArray(value, label) {
  rejectProxy(value, label);
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(`${label} must be a plain dense array`);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor?.value;
  if (!("value" in (lengthDescriptor ?? {})) || !Number.isSafeInteger(length) || length < 0) fail(`${label} has an invalid length`);
  const output = new Array(length);
  let entries = 0;
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length || descriptor?.enumerable !== true || !("value" in descriptor)) {
      fail(`${label} must contain enumerable numeric own data properties only`);
    }
    output[Number(key)] = descriptor.value;
    entries += 1;
  }
  if (entries !== length) fail(`${label} must not contain sparse entries`);
  return output;
}

function boundedString(value, label, maximum = 1024) {
  if (typeof value !== "string" || !value || value.length > maximum || value !== value.normalize("NFKC")) {
    fail(`${label} must be a bounded normalized string`);
  }
  return value;
}

function requestId(value) {
  if (typeof value === "string") return boundedString(value, "request.id", 256);
  if (!Number.isSafeInteger(value)) fail("request.id must be a string or safe integer");
  return value;
}

function snapshotOption(value, label) {
  const current = recordSnapshot(value, label, OPTION_FIELDS);
  return Object.freeze({
    label: boundedString(current.label, `${label}.label`, 512),
    description: boundedString(current.description, `${label}.description`, 2048),
  });
}

function snapshotQuestion(value, label) {
  const current = recordSnapshot(value, label, QUESTION_FIELDS, ["id", "header", "question"]);
  const isOther = current.isOther ?? false;
  const isSecret = current.isSecret ?? false;
  if (typeof isOther !== "boolean" || typeof isSecret !== "boolean") fail(`${label} flags must be booleans`);
  if (isSecret) fail(`${label} cannot request secret input for a required Decision`);
  if (!Object.prototype.hasOwnProperty.call(current, "options") || current.options === null) fail(`${label}.options is required`);
  const inputOptions = denseArray(current.options, `${label}.options`);
  if (inputOptions.length < 2) fail(`${label}.options must contain at least two choices`);
  const options = inputOptions.map((option, index) => snapshotOption(option, `${label}.options[${index}]`));
  const output = {
    id: boundedString(current.id, `${label}.id`, 256),
    header: boundedString(current.header, `${label}.header`, 512),
    question: boundedString(current.question, `${label}.question`, 4096),
    options: Object.freeze(options),
  };
  if (Object.prototype.hasOwnProperty.call(current, "isOther")) output.isOther = isOther;
  if (Object.prototype.hasOwnProperty.call(current, "isSecret")) output.isSecret = false;
  return Object.freeze(output);
}

/**
 * Snapshot an actual app-server request without invoking accessors or retaining
 * caller-owned mutable objects.
 *
 * @param {unknown} value Actual host request envelope.
 * @returns {Readonly<object>} Frozen data-only request snapshot.
 */
export function snapshotCodexRequestUserInputRequest(value) {
  const request = recordSnapshot(value, "request", REQUEST_FIELDS);
  if (request.method !== CODEX_APP_SERVER_REQUEST_USER_INPUT_METHOD) fail("request.method is not item/tool/requestUserInput");
  const params = recordSnapshot(request.params, "request.params", PARAM_FIELDS, ["threadId", "turnId", "itemId", "questions"]);
  if (Object.prototype.hasOwnProperty.call(params, "autoResolutionMs") && params.autoResolutionMs !== null) {
    fail("required Decisions cannot use host auto-resolution");
  }
  const inputQuestions = denseArray(params.questions, "request.params.questions");
  if (inputQuestions.length !== 1) fail("one required Decision must map to exactly one host question");
  const questions = Object.freeze(inputQuestions.map((question, index) => snapshotQuestion(question, `request.params.questions[${index}]`)));
  const normalizedParams = Object.freeze({
    threadId: boundedString(params.threadId, "request.params.threadId", 256),
    turnId: boundedString(params.turnId, "request.params.turnId", 256),
    itemId: boundedString(params.itemId, "request.params.itemId", 256),
    questions,
    ...(Object.prototype.hasOwnProperty.call(params, "autoResolutionMs") ? { autoResolutionMs: null } : {}),
  });
  return Object.freeze({ id: requestId(request.id), method: request.method, params: normalizedParams });
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

/**
 * Return a stable SHA-256 reference for a data-only value.
 *
 * @param {unknown} value A value already owned by this adapter.
 * @returns {string} `sha256:<lowercase hex>`.
 */
function codexAppServerCanonicalDigest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex")}`;
}

/**
 * Digest the questions exactly as rendered by the actual pending host request.
 * Optional-field presence is preserved, so payload tampering changes the digest.
 *
 * @param {unknown} request Actual host request envelope.
 * @returns {string} Canonical rendered-host-payload digest.
 */
export function codexRenderedHostPayloadDigest(request) {
  return codexAppServerCanonicalDigest(snapshotCodexRequestUserInputRequest(request).params.questions);
}

/**
 * Map a raw host correlation value to an opaque exact-value digest reference.
 * The type tag prevents string `1` from colliding with numeric `1`.
 *
 * @param {string} kind Stable correlation kind.
 * @param {string|number} value Raw host correlation value.
 * @returns {string} Digest-shaped opaque reference.
 */
export function codexHostCorrelationRef(kind, value) {
  boundedString(kind, "correlation kind", 64);
  if (typeof value !== "string" && !Number.isSafeInteger(value)) fail("host correlation value must be a string or safe integer");
  return codexAppServerCanonicalDigest({ kind, valueType: typeof value, value });
}

function sameCanonical(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function expectedPresentation(value) {
  const current = recordSnapshot(value, "presentation", ["question"]);
  const question = recordSnapshot(
    current.question,
    "presentation.question",
    ["id", "header", "question", "options", "isOther"],
    ["id", "header", "question", "options"],
  );
  if (Object.prototype.hasOwnProperty.call(question, "isOther") && typeof question.isOther !== "boolean") {
    fail("presentation.question.isOther must be a boolean");
  }
  const options = denseArray(question.options, "presentation.question.options");
  if (options.length < 2) fail("presentation must contain at least two options");
  const optionIds = new Set();
  const hostOptions = options.map((value, index) => {
    const option = recordSnapshot(value, `presentation.question.options[${index}]`, ["optionId", "label", "description"]);
    const optionId = boundedString(option.optionId, `presentation.question.options[${index}].optionId`, 128);
    if (optionIds.has(optionId)) fail("presentation optionIds must be unique");
    optionIds.add(optionId);
    return { optionId, hostOption: snapshotOption({ label: option.label, description: option.description }, `presentation.question.options[${index}]`) };
  });
  return Object.freeze({
    questionId: boundedString(question.id, "presentation.question.id", 256),
    hostQuestion: Object.freeze({
      id: question.id,
      header: boundedString(question.header, "presentation.question.header", 512),
      question: boundedString(question.question, "presentation.question.question", 4096),
      options: Object.freeze(hostOptions.map((entry) => entry.hostOption)),
      ...(Object.prototype.hasOwnProperty.call(question, "isOther") ? { isOther: question.isOther } : {}),
    }),
    optionIds: Object.freeze(hostOptions.map((entry) => entry.optionId)),
  });
}

function normalizeResponse(value, pendingRequest, presentation) {
  const response = recordSnapshot(value, "response", ["id", "result"]);
  if (response.id !== pendingRequest.id || typeof response.id !== typeof pendingRequest.id) fail("response.id does not match the pending request id");
  const result = recordSnapshot(response.result, "response.result", ["answers"]);
  const answers = plainRecord(result.answers, "response.result.answers");
  const answerKeys = Reflect.ownKeys(answers);
  if (answerKeys.length !== 1 || answerKeys[0] !== presentation.questionId) fail("response answers do not match the pending question id");
  const answer = recordSnapshot(Object.getOwnPropertyDescriptor(answers, answerKeys[0]).value, "response.result.answers entry", ["answers"]);
  const selections = denseArray(answer.answers, "response.result.answers entry.answers");
  if (selections.length !== 1 || typeof selections[0] !== "string") fail("required Decision response must contain one selected option label");
  const selectedIndex = presentation.hostQuestion.options.findIndex((option) => option.label === selections[0]);
  if (selectedIndex < 0) fail("response selected an unknown or freeform answer");
  if (presentation.hostQuestion.options.some((option, index) => index !== selectedIndex && option.label === selections[0])) {
    fail("presentation option labels must be unique for host normalization");
  }
  const snapshot = Object.freeze({ id: response.id, result: Object.freeze({ answers: Object.freeze({
    [presentation.questionId]: Object.freeze({ answers: Object.freeze([selections[0]]) }),
  }) }) });
  return Object.freeze({ selectedOptionId: presentation.optionIds[selectedIndex], snapshot });
}

function assertActualRequestMatchesExpected(request, expected, presentation) {
  if (request.params.threadId !== expected.threadId || request.params.turnId !== expected.turnId || request.params.itemId !== expected.itemId) {
    fail("actual host request does not match the expected thread, turn, or item binding");
  }
  const actual = request.params.questions[0];
  const normalizedActual = {
    id: actual.id,
    header: actual.header,
    question: actual.question,
    options: actual.options,
    ...(Object.prototype.hasOwnProperty.call(actual, "isOther") ? { isOther: actual.isOther } : {}),
  };
  if (!sameCanonical(normalizedActual, presentation.hostQuestion)) fail("actual rendered host question does not match the Decision presentation");
}

function exactPort(value, label, fields) {
  const port = recordSnapshot(value, label, fields);
  for (const field of fields.filter((key) => key !== "hostConnectionRef")) {
    rejectProxy(port[field], `${label}.${field}`);
    if (typeof port[field] !== "function") fail(`${label}.${field} must be a function capability`);
  }
  return Object.freeze(port);
}

function requestEvent(value) {
  const event = recordSnapshot(value, "host request event", ["request", "timeSourceClaimRef"]);
  return Object.freeze({
    request: snapshotCodexRequestUserInputRequest(event.request),
    timeSourceClaimRef: boundedString(event.timeSourceClaimRef, "host request event.timeSourceClaimRef", 128),
  });
}

function responseEvent(value, pendingRequest, presentation) {
  const event = recordSnapshot(value, "host response event", ["response", "at", "timeSourceClaimRef"]);
  const normalized = normalizeResponse(event.response, pendingRequest, presentation);
  return Object.freeze({
    ...normalized,
    at: boundedString(event.at, "host response event.at", 64),
    timeSourceClaimRef: boundedString(event.timeSourceClaimRef, "host response event.timeSourceClaimRef", 128),
  });
}

function expectedBinding(value) {
  const current = recordSnapshot(value, "expectedBinding", ["threadId", "turnId", "itemId"]);
  return Object.freeze({
    threadId: boundedString(current.threadId, "expectedBinding.threadId", 256),
    turnId: boundedString(current.turnId, "expectedBinding.turnId", 256),
    itemId: boundedString(current.itemId, "expectedBinding.itemId", 256),
  });
}

function assertPresentationOptionsMatchDecision(presentation, decision) {
  const expected = decision.options.map((option) => option.optionId).sort();
  const actual = [...presentation.optionIds].sort();
  if (!sameCanonical(actual, expected)) fail("presentation optionIds must exactly match the Decision options");
}

function challengeClaimInput(challenge, selectedOptionId, claimedAt) {
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
    claimedAt,
    selectedOptionId,
  };
}

function observeInput(substrate, response) {
  return {
    substrateRef: substrate.substrateRef,
    substrateDigest: substrate.substrateDigest,
    decisionId: substrate.decisionId,
    presentedRevision: substrate.presentedRevision,
    runId: substrate.runId,
    challengeRef: substrate.challengeRef,
    challengeDigest: substrate.challengeDigest,
    runtime: substrate.runtime,
    surface: substrate.surface,
    hostEventClaimRef: substrate.hostEventClaimRef,
    hostEventClaimDigest: substrate.hostEventClaimDigest,
    renderedHostPayloadDigest: substrate.renderedHostPayloadDigest,
    hostConnectionRef: substrate.hostConnectionRef,
    sessionOrThreadRef: substrate.sessionOrThreadRef,
    turnRef: substrate.turnRef,
    itemRef: substrate.itemRef,
    toolUseOrRequestRef: substrate.toolUseOrRequestRef,
    issuedAt: substrate.issuedAt,
    expiresAt: substrate.expiresAt,
    at: response.at,
    timeSourceClaimRef: response.timeSourceClaimRef,
    hostReturnObservedClaimDigest: codexAppServerCanonicalDigest(response.snapshot),
  };
}

function assertPersistedSubstrateMatches(value, expected, decision, challenge, allowedStates) {
  const stored = assertValidNativeHostAnswerSubstrate(value, decision, challenge);
  if (!allowedStates.includes(stored.state)) fail("repository returned an unexpected substrate state");
  const immutableFields = [
    "schemaVersion", "kind", "substrateRef", "substrateDigest", "decisionId", "presentedRevision", "runId",
    "challengeRef", "challengeDigest", "runtime", "surface", "hostEventClaimRef", "hostEventClaimDigest",
    "renderedHostPayloadDigest", "hostConnectionRef", "sessionOrThreadRef", "turnRef", "itemRef",
    "toolUseOrRequestRef", "issuedAt", "expiresAt", "presentationTimeSourceClaimRef",
  ];
  if (immutableFields.some((field) => stored[field] !== expected[field])) {
    fail("repository returned a substrate with a different immutable host binding");
  }
  return stored;
}

/**
 * Create a one-exchange-at-a-time Codex app-server adapter.
 *
 * `hostConnection` possession is only an injected capability boundary. The
 * resulting record remains a non-authorizing observation substrate. The
 * repository is a narrow CAS port, keeping Runtime -> Data dependencies out of
 * this module.
 *
 * @param {object} ports Injected host and repository ports.
 * @param {object} ports.hostConnection Data-only capability with
 * `hostConnectionRef`, `takeRequestUserInput`, `takeResponse`, and
 * `ackResponse`. The transport contract must redeliver an unacknowledged
 * response and make acknowledgement idempotent; this adapter acknowledges only
 * after the matching observation is durable.
 * @param {object} ports.repository CAS capability with `issue`, `observe`, and
 * digest-validating `read` for crash recovery.
 * @returns {{observeRequiredDecision(input: object): Promise<object>}}
 */
export function createCodexAppServerDecisionHostAdapter(ports) {
  const current = recordSnapshot(ports, "adapter ports", ["hostConnection", "repository"]);
  const hostConnection = exactPort(current.hostConnection, "hostConnection", ["hostConnectionRef", "takeRequestUserInput", "takeResponse", "ackResponse"]);
  const repository = exactPort(current.repository, "repository", ["issue", "observe", "read"]);
  const hostConnectionRef = boundedString(hostConnection.hostConnectionRef, "hostConnection.hostConnectionRef", 128);
  let inFlight = false;

  return Object.freeze({
    /**
     * Observe one required Decision exchange and atomically persist its
     * presented -> host_return_observed substrate transition.
     *
     * @param {object} input Decision, issued challenge, expected host context,
     * and option-id-bearing presentation.
     * @returns {Promise<object>} Digest-only, permanently non-authorizing result.
     */
    async observeRequiredDecision(input) {
      if (inFlight) fail("a host request is already in flight on this adapter");
      inFlight = true;
      try {
        const command = recordSnapshot(input, "observeRequiredDecision input", ["decision", "issuedChallenge", "expectedBinding", "presentation"]);
        assertValidDecision(command.decision);
        if (command.decision.status !== "presented" || command.decision.nativeSurface?.runtime !== "codex" || command.decision.nativeSurface?.surface !== "request_user_input" || command.decision.requirement.required !== true) {
          fail("only a required presented Codex request_user_input Decision may be observed");
        }
        const expected = expectedBinding(command.expectedBinding);
        const presentation = expectedPresentation(command.presentation);
        assertPresentationOptionsMatchDecision(presentation, command.decision);

        const hostRequest = requestEvent(await hostConnection.takeRequestUserInput());
        assertActualRequestMatchesExpected(hostRequest.request, expected, presentation);
        const renderedHostPayloadDigest = codexAppServerCanonicalDigest(hostRequest.request.params.questions);
        const toolUseOrRequestRef = codexHostCorrelationRef("codex-json-rpc-request", hostRequest.request.id);
        const binding = Object.freeze({
          hostConnectionRef,
          sessionOrThreadRef: codexHostCorrelationRef("codex-thread", hostRequest.request.params.threadId),
          turnRef: codexHostCorrelationRef("codex-turn", hostRequest.request.params.turnId),
          itemRef: codexHostCorrelationRef("codex-item", hostRequest.request.params.itemId),
          toolUseOrRequestRef,
          renderedHostPayloadDigest,
        });
        const hostEventClaimRef = codexAppServerCanonicalDigest({
          runtime: "codex",
          surface: "request_user_input",
          hostConnectionRef: binding.hostConnectionRef,
          sessionOrThreadRef: binding.sessionOrThreadRef,
          turnRef: binding.turnRef,
          itemRef: binding.itemRef,
          toolUseOrRequestRef: binding.toolUseOrRequestRef,
        });
        // Repository identity is the challenge-independent host event identity.
        // The Decision challenge remains an immutable binding inside the stored
        // substrate but cannot make the same host event unique a second time.
        const substrateRef = hostEventClaimRef;
        const presented = presentNativeHostAnswerSubstrate(command.decision, command.issuedChallenge, {
          substrateRef,
          runtime: "codex",
          surface: "request_user_input",
          hostEventClaimRef,
          ...binding,
          issuedAt: command.issuedChallenge?.issuedAt,
          expiresAt: command.issuedChallenge?.expiresAt,
          timeSourceClaimRef: hostRequest.timeSourceClaimRef,
        });
        let storedPresented;
        try {
          storedPresented = assertPersistedSubstrateMatches(
            await repository.issue(presented),
            presented,
            command.decision,
            command.issuedChallenge,
            ["presented"],
          );
        } catch (error) {
          if (error?.code !== "NATIVE_HOST_ANSWER_REPOSITORY_REPLAY") throw error;
          const recovered = assertPersistedSubstrateMatches(
            await repository.read({ substrateRef }),
            presented,
            command.decision,
            command.issuedChallenge,
            ["presented", "host_return_observed"],
          );
          if (recovered.challengeRef !== presented.challengeRef || recovered.challengeDigest !== presented.challengeDigest ||
              recovered.decisionId !== presented.decisionId || recovered.presentedRevision !== presented.presentedRevision) {
            fail("the host event was already bound to another Decision challenge");
          }
          if (!["presented", "host_return_observed"].includes(recovered.state)) fail("the persisted host event is no longer observable");
          storedPresented = recovered;
        }

        const hostResponse = responseEvent(await hostConnection.takeResponse({ requestId: hostRequest.request.id }), hostRequest.request, presentation);
        const claimedChallenge = claimNativeDecisionChallenge(
          command.decision,
          command.issuedChallenge,
          challengeClaimInput(command.issuedChallenge, hostResponse.selectedOptionId, hostResponse.at),
        );
        const hostReturnObservedClaimDigest = codexAppServerCanonicalDigest(hostResponse.snapshot);
        let storedObserved;
        let repositoryCas;
        if (storedPresented.state === "presented") {
          const observed = recordNativeHostReturnObservedClaim(
            command.decision,
            claimedChallenge,
            storedPresented,
            observeInput(storedPresented, hostResponse),
          );
          const observeCasInput = Object.freeze({
            record: observed,
            expectedRevision: storedPresented.revision,
            expectedSubstrateDigest: storedPresented.substrateDigest,
            expectedState: "presented",
          });
          storedObserved = assertPersistedSubstrateMatches(
            await repository.observe(observeCasInput),
            observed,
            command.decision,
            claimedChallenge,
            ["host_return_observed"],
          );
          if (storedObserved.hostReturnObservedClaimDigest !== observed.hostReturnObservedClaimDigest ||
              storedObserved.observedAt !== observed.observedAt ||
              storedObserved.observationTimeSourceClaimRef !== observed.observationTimeSourceClaimRef) {
            fail("repository returned a different host-return observation claim");
          }
          repositoryCas = Object.freeze({
            expectedRevision: observeCasInput.expectedRevision,
            expectedSubstrateDigest: observeCasInput.expectedSubstrateDigest,
            expectedState: observeCasInput.expectedState,
          });
        } else {
          if (storedPresented.hostReturnObservedClaimDigest !== hostReturnObservedClaimDigest) {
            fail("redelivered host response does not match the persisted observation claim");
          }
          storedObserved = storedPresented;
          repositoryCas = Object.freeze({
            expectedRevision: storedPresented.revision,
            expectedSubstrateDigest: storedPresented.substrateDigest,
            expectedState: storedPresented.state,
          });
        }
        await hostConnection.ackResponse(Object.freeze({
          requestId: hostRequest.request.id,
          substrateRef,
          hostReturnObservedClaimDigest,
        }));
        const gate = nativeHostAnswerSubstrateGate(storedObserved);
        return Object.freeze({
          status: "non_authorizing_host_return_observation",
          challenge: claimedChallenge,
          substrate: storedObserved,
          gate,
          repositoryCas,
          executionAllowed: false,
        });
      } finally {
        inFlight = false;
      }
    },
  });
}
