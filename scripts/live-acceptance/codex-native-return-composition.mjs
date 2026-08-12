/**
 * Codex-only composition seam for consuming one process-local binding inside
 * the app-server request_user_input return/ack interval.
 *
 * This module deliberately does not promote the shared durable substrate to
 * authority. The transient binding-receipt closure is created only by the
 * hostConnection.waitForNativeReturn callback, recorded before transport ack,
 * never returned, and never written to JSON. A new process has no receipt and
 * must re-prompt instead of recovering authority from the repository. This
 * injectable seam never executes an action and is permanently non-authorizing.
 *
 * The hostConnection contract must be implemented inside the trusted Codex
 * client integration. A fake or standalone client can test protocol shape but
 * proves only transport observation, not Codex Desktop UI or human identity.
 */

import { createHash } from "node:crypto";

import {
  codexHostCorrelationRef,
  createCodexAppServerDecisionHostAdapter,
  snapshotCodexRequestUserInputRequest,
} from "../../src/adapters/codex/app-server-decision-host-adapter.mjs";

export const CODEX_NATIVE_RETURN_REPROMPT_REQUIRED = "CODEX_NATIVE_RETURN_REPROMPT_REQUIRED";

const HOST_FIELDS = Object.freeze([
  "hostConnectionRef",
  "takeRequestUserInput",
  "waitForNativeReturn",
  "ackResponse",
]);
const REPOSITORY_FIELDS = Object.freeze(["issue", "observe", "read"]);

function fail(message, code = "CODEX_NATIVE_RETURN_COMPOSITION_INVALID") {
  const error = new TypeError(`Codex native-return composition: ${message}`);
  error.code = code;
  throw error;
}

function plainRecord(value, label, allowedFields) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain record`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowedFields.includes(key))) {
    fail(`${label} contains unsupported fields`);
  }
  for (const field of allowedFields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      fail(`${label}.${field} must be an enumerable own data property`);
    }
  }
  return Object.fromEntries(allowedFields.map((field) => [field, Object.getOwnPropertyDescriptor(value, field).value]));
}

function boundedString(value, label, maximum = 512) {
  if (typeof value !== "string" || !value || value.length > maximum || value !== value.normalize("NFKC")) {
    fail(`${label} must be a bounded normalized string`);
  }
  return value;
}

function capabilityPort(value, label, fields) {
  const current = plainRecord(value, label, fields);
  for (const field of fields.filter((entry) => entry !== "hostConnectionRef")) {
    if (typeof current[field] !== "function") fail(`${label}.${field} must be a function capability`);
  }
  return Object.freeze(current);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex")}`;
}

function eventIdentity(request, hostConnectionRef) {
  const snapshot = snapshotCodexRequestUserInputRequest(request);
  const binding = Object.freeze({
    hostConnectionRef,
    sessionOrThreadRef: codexHostCorrelationRef("codex-thread", snapshot.params.threadId),
    turnRef: codexHostCorrelationRef("codex-turn", snapshot.params.turnId),
    itemRef: codexHostCorrelationRef("codex-item", snapshot.params.itemId),
    toolUseOrRequestRef: codexHostCorrelationRef("codex-json-rpc-request", snapshot.id),
  });
  const substrateRef = digest({
    runtime: "codex",
    surface: "request_user_input",
    ...binding,
  });
  return Object.freeze({ request: snapshot, substrateRef });
}

function actionBinding(value, expectedScopeRef) {
  const binding = plainRecord(value, "actionBinding", ["actionRef", "scopeRef"]);
  const normalized = Object.freeze({
    actionRef: boundedString(binding.actionRef, "actionBinding.actionRef"),
    scopeRef: boundedString(binding.scopeRef, "actionBinding.scopeRef"),
  });
  if (normalized.scopeRef !== expectedScopeRef) fail("actionBinding.scopeRef must exactly match Decision identity.scopeRef");
  return normalized;
}

function selectedOptionId(responseEvent, presentation) {
  const response = responseEvent?.response;
  const question = presentation?.question;
  const questionId = question?.id;
  const labels = response?.result?.answers?.[questionId]?.answers;
  if (!Array.isArray(labels) || labels.length !== 1 || typeof labels[0] !== "string") {
    fail("native return does not contain one selected label");
  }
  const matches = question.options.filter((option) => option.label === labels[0]);
  if (matches.length !== 1) fail("native return label does not map to exactly one optionId");
  return boundedString(matches[0].optionId, "selectedOptionId", 128);
}

function rePrompt(message) {
  fail(message, CODEX_NATIVE_RETURN_REPROMPT_REQUIRED);
}

function processLocalReceipt(binding) {
  const receipt = Object.create(null);
  Object.defineProperties(receipt, {
    binding: { value: binding, enumerable: false },
    processBrand: { value: Symbol("codex-native-return-receipt"), enumerable: false },
    toJSON: {
      value() { fail("process-local receipt cannot be serialized"); },
      enumerable: false,
    },
  });
  return Object.freeze(receipt);
}

/**
 * Compose the shared non-authorizing adapter with a process-local one-shot
 * binding-receipt recorder. No callback token crosses this API boundary.
 *
 * @param {object} ports
 * @param {object} ports.hostConnection Trusted in-process Codex client port.
 * `waitForNativeReturn({requestId,onReturn})` must invoke `onReturn` from the
 * actual client return callback and resolve only after that callback finishes.
 * @param {object} ports.repository Durable audit/CAS repository.
 * @returns {{observeRequiredDecisionTransport(input: object): Promise<object>, retryPendingAck(): Promise<object>}}
 */
export function createCodexNativeReturnComposition(ports) {
  const current = plainRecord(ports, "ports", ["hostConnection", "repository"]);
  const hostConnection = capabilityPort(current.hostConnection, "hostConnection", HOST_FIELDS);
  const repository = capabilityPort(current.repository, "repository", REPOSITORY_FIELDS);
  const hostConnectionRef = boundedString(hostConnection.hostConnectionRef, "hostConnection.hostConnectionRef", 128);

  // These receipts are intentionally process-local. They permit an ack retry
  // after the binding was recorded, but disappear on restart.
  const processReceipts = new Map();
  let command = null;
  let active = null;
  let completedBindingSummary = null;

  const composedConnection = Object.freeze({
    hostConnectionRef,
    async takeRequestUserInput() {
      if (!command || active) fail("no unique Decision command is ready for a host request");
      const event = await hostConnection.takeRequestUserInput();
      const identity = eventIdentity(event?.request, hostConnectionRef);
      let existing = null;
      try {
        existing = await repository.read({ substrateRef: identity.substrateRef });
      } catch (error) {
        if (error?.code !== "NATIVE_HOST_ANSWER_REPOSITORY_NOT_FOUND") throw error;
      }
      if (existing && !processReceipts.has(identity.substrateRef)) {
        rePrompt("durable host observation has no current-process binding receipt; a fresh host prompt is required");
      }
      active = {
        ...identity,
        existing,
        binding: command.binding,
        presentation: command.input.presentation,
        recordReceipt: null,
        responseEvent: null,
      };
      return event;
    },
    async takeResponse({ requestId }) {
      if (!active || active.request.id !== requestId || typeof active.request.id !== typeof requestId) {
        fail("native return request id does not match the active host request");
      }
      let callbackCount = 0;
      let returnedEvent = null;
      await hostConnection.waitForNativeReturn(Object.freeze({
        requestId,
        onReturn(responseEvent) {
          callbackCount += 1;
          if (callbackCount !== 1) fail("native return callback must fire exactly once");
          returnedEvent = responseEvent;
          active.responseEvent = responseEvent;
          if (!processReceipts.has(active.substrateRef)) {
            let recorded = false;
            // The callback-bound recorder closure is neither returned nor
            // persisted; it can record this binding once before any ack.
            active.recordReceipt = async (ack) => {
              if (recorded) rePrompt("the transient binding receipt was already recorded");
              recorded = true;
              const selected = selectedOptionId(responseEvent, active.presentation);
              const durable = await repository.read({ substrateRef: active.substrateRef });
              if (durable.state !== "host_return_observed" || durable.hostReturnObservedClaimDigest !== ack.hostReturnObservedClaimDigest) {
                fail("durable observation does not match the transient native return");
              }
              const executionBinding = Object.freeze({
                actionRef: active.binding.actionRef,
                scopeRef: active.binding.scopeRef,
                decisionId: durable.decisionId,
                runId: durable.runId,
                challengeRef: durable.challengeRef,
                substrateRef: active.substrateRef,
                hostReturnObservedClaimDigest: ack.hostReturnObservedClaimDigest,
                selectedOptionId: selected,
              });
              const receipt = processLocalReceipt(executionBinding);
              processReceipts.set(active.substrateRef, receipt);
              return receipt;
            };
          }
        },
      }));
      if (callbackCount !== 1 || !returnedEvent) fail("waitForNativeReturn resolved without one native return callback");
      return returnedEvent;
    },
    async ackResponse(ack) {
      if (!active || ack?.requestId !== active.request.id || ack?.substrateRef !== active.substrateRef) {
        fail("ack does not match the active native return");
      }
      let receipt = processReceipts.get(active.substrateRef) ?? null;
      if (!receipt) {
        if (typeof active.recordReceipt !== "function") rePrompt("no current-process native return receipt recorder exists");
        receipt = await active.recordReceipt(ack);
      }
      // The binding receipt is recorded before transport ack. If ack fails,
      // the process-local receipt allows ack-only retry without re-running the
      // native return callback. No external action is executed here.
      active.pendingAck = ack;
      active.receipt = receipt;
      await hostConnection.ackResponse(ack);
      completedBindingSummary = Object.freeze({
        actionRef: receipt.binding.actionRef,
        scopeRef: receipt.binding.scopeRef,
        substrateRef: receipt.binding.substrateRef,
      });
      processReceipts.delete(active.substrateRef);
      active.recordReceipt = null;
      active.responseEvent = null;
      active.receipt = null;
      active = null;
      return Object.freeze({
        ...completedBindingSummary,
        status: "binding_receipt_recorded_before_ack",
      });
    },
  });

  const adapter = createCodexAppServerDecisionHostAdapter({
    hostConnection: composedConnection,
    repository,
  });

  return Object.freeze({
    async retryPendingAck() {
      if (command || !active?.pendingAck || !active?.receipt) {
        fail("no process-local ack retry is pending");
      }
      const pending = active;
      await hostConnection.ackResponse(pending.pendingAck);
      const summary = Object.freeze({
        actionRef: pending.receipt.binding.actionRef,
        scopeRef: pending.receipt.binding.scopeRef,
        substrateRef: pending.receipt.binding.substrateRef,
      });
      processReceipts.delete(pending.substrateRef);
      pending.recordReceipt = null;
      pending.responseEvent = null;
      pending.receipt = null;
      active = null;
      return Object.freeze({
        status: "ack_retried_without_binding_rerecord",
        ...summary,
        executionAllowed: false,
        humanVerified: false,
        currentHostAuthority: false,
      });
    },
    async observeRequiredDecisionTransport(input) {
      if (command || active) fail("a composed Decision is already in flight");
      if (!input || typeof input !== "object" || Array.isArray(input)) fail("input must be a record");
      const keys = Reflect.ownKeys(input);
      const allowed = ["decision", "issuedChallenge", "expectedBinding", "presentation", "actionBinding"];
      if (keys.some((key) => typeof key !== "string" || !allowed.includes(key)) || allowed.some((key) => !Object.hasOwn(input, key))) {
        fail("input must contain exactly the Decision command and actionBinding");
      }
      const binding = actionBinding(input.actionBinding, input.decision?.identity?.scopeRef);
      const adapterInput = Object.freeze({
        decision: input.decision,
        issuedChallenge: input.issuedChallenge,
        expectedBinding: input.expectedBinding,
        presentation: input.presentation,
      });
      command = Object.freeze({ input: adapterInput, binding });
      try {
        const observation = await adapter.observeRequiredDecision(adapterInput);
        const summary = completedBindingSummary;
        if (!summary || summary.substrateRef !== observation.substrate.substrateRef) {
          rePrompt("native return completed without a current-process binding summary");
        }
        return Object.freeze({
          ...observation,
          status: "transport_observed_binding_receipt_recorded",
          bindingReceipt: Object.freeze({
            status: "recorded_before_ack",
            actionRef: summary.actionRef,
            scopeRef: summary.scopeRef,
            substrateRef: summary.substrateRef,
          }),
          executionAllowed: false,
          humanVerified: false,
          currentHostAuthority: false,
          authorityBoundary: "injectable_transport_seam_permanently_non_authorizing",
          evidenceClass: "transport_observed",
        });
      } finally {
        command = null;
        completedBindingSummary = null;
      }
    },
  });
}
