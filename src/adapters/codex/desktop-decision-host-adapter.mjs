import { createHash, randomUUID } from "node:crypto";
import { prepareCodexNativeDecisionSurface } from "./native-decision-surface-adapter.mjs";
import { assertNativeDecisionOpaqueRef, claimNativeDecisionChallenge } from "../../domain/decision/native-decision-authority.mjs";
import { presentNativeHostAnswerSubstrate, assertValidNativeHostAnswerSubstrate,
  recordNativeHostReturnObservedClaim, consumeNativeHostReturnObservedClaim } from "../../domain/decision/native-host-answer-authority.mjs";

const adapters = new WeakSet();
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
const correlation = (kind, value) => digest({ kind, value });
const pending = (reason) => ({ status: "pending", reason, executionAllowed: false, originAuthenticatedByLibrary: false });
const observeFields = ["substrateRef", "substrateDigest", "decisionId", "presentedRevision", "runId", "challengeRef", "challengeDigest",
  "runtime", "surface", "hostEventClaimRef", "hostEventClaimDigest", "renderedHostPayloadDigest", "hostConnectionRef",
  "sessionOrThreadRef", "turnRef", "itemRef", "toolUseOrRequestRef", "issuedAt", "expiresAt"];

/** Parse only the observed official read_thread shape, never a model's answer object. */
function readerSnapshot(event, threadId, hostId) {
  if (event.tool !== "mcp__codex_app__read_thread" || typeof event.callRef !== "string" || !event.callRef ||
      typeof event.rawRef !== "string" || !event.rawRef || event.arguments?.threadId !== threadId || event.arguments.hostId !== hostId ||
      !Number.isFinite(Date.parse(event.observedAt)) || event.result?.isError === true || event.result?.content?.length !== 1 ||
      event.result.content[0].type !== "text" || typeof event.result.content[0].text !== "string") {
    throw new TypeError("A current host official read_thread tool return and its original call context are required");
  }
  const body = JSON.parse(event.result.content[0].text);
  if (body?.schemaVersion !== 1 || body.thread?.id !== threadId || body.thread.hostId !== hostId ||
      body.page?.order !== "newest_first" || !Array.isArray(body.turns) || body.turns.some((turn) =>
        !turn || typeof turn !== "object" || typeof turn.id !== "string" || !Array.isArray(turn.items))) {
    throw new TypeError("Unsupported or mismatched Desktop thread return");
  }
  return { event: structuredClone(event), body, digest: digest(event.result) };
}

function questionText(prepared) {
  const question = prepared.presentation.questions[0];
  return `${question.question}\n${question.options.map((option) => `- ${option.label}`).join("\n")}`;
}

// Unrecognized historical data has no relation to this question. Only parsing
// failures are ignored here; validation after an exact call/index match is not.
function parseUnassociatedJson(text) {
  try { return JSON.parse(text); }
  catch (error) { if (error instanceof SyntaxError) return undefined; throw error; }
}

/**
 * The readThread capability must be supplied by the trusted current host from
 * its actual official tool call. File names, call-ref strings and JSON cannot
 * authenticate that origin. This adapter creates durable non-authorizing
 * observations, never a process-local native-return receipt or an RPC event.
 * exchange has immutable read/write ports for this run's owned private files.
 */
export function createCodexDesktopDecisionHostAdapter({ repository, exchange, readThread, assertCurrent,
  hostConnectionRef, now = () => new Date().toISOString() }) {
  if (typeof readThread !== "function" || typeof assertCurrent !== "function" || typeof exchange?.read !== "function" ||
      typeof exchange?.write !== "function" || typeof repository?.consume !== "function" || typeof hostConnectionRef !== "string") {
    throw new TypeError("Desktop decisions require current host, private exchange and existing CAS repository ports");
  }
  assertNativeDecisionOpaqueRef(hostConnectionRef);
  const read = async (binding, decision, stage) => {
    await assertCurrent({ binding, decision });
    const stored = await exchange.read(binding.bindingDigest, stage);
    if (stored && (stored.bindingDigest !== binding.bindingDigest || stored.decisionId !== decision.decisionId ||
        stored.decisionRevision !== decision.revision || stored.hostConnectionRef !== hostConnectionRef)) {
      throw new Error("Desktop exchange belongs to another current decision or host");
    }
    return stored;
  };
  const write = (binding, decision, stage, value) => exchange.write(binding.bindingDigest, stage, {
    runId: binding.runId, bindingDigest: binding.bindingDigest, decisionId: decision.decisionId, decisionRevision: decision.revision, hostConnectionRef, ...value });
  const adapter = Object.freeze({
    /** Fresh prepare alone may ask once; replay is pending and must only observe. */
    async prepare({ binding, decision, hostContext, activeSchema, presentation, expiresAt }) {
      const existing = await read(binding, decision, "prepared");
      if (existing) return { ...pending("desktop_question_already_prepared_do_not_resend"), mayAsk: false };
      const baseline = readerSnapshot(await readThread({ threadId: hostContext.threadId, hostId: hostContext.hostId }), hostContext.threadId, hostContext.hostId);
      const turns = baseline.body.turns.filter((turn) => turn.id === hostContext.turnId);
      if (turns.length !== 1 || baseline.body.turns[0].id !== hostContext.turnId) {
        return { ...pending("current_presentation_turn_not_visible_in_reader_baseline"), mayAsk: false };
      }
      if (turns[0].error) throw new Error("Current Desktop presentation turn has an error");
      const issuedAt = now();
      if (Date.parse(baseline.event.observedAt) > Date.parse(issuedAt)) throw new Error("Reader baseline is newer than preparation");
      const nonce = randomUUID();
      const prepared = prepareCodexNativeDecisionSurface({ decision, activeSchema, presentation,
        challengeRef: correlation("desktop-challenge", nonce), requestRef: correlation("desktop-request", nonce), issuedAt, expiresAt });
      const result = await write(binding, decision, "prepared", { hostContext, presentation, ...prepared,
        baseline, baselineCallIds: turns[0].items.filter((item) => item?.type === "agentMessage" && /^call_/u.test(item.id)).map((item) => item.id) });
      return { status: "prepared", mayAsk: result.created, payload: result.created ? prepared.payload : undefined,
        privateRef: result.ref, privateDigest: result.digest, executionAllowed: false, originAuthenticatedByLibrary: false };
    },

    /** Register the one new native ask as seen by the actual official reader. */
    async recordPresented({ binding, decision }) {
      const prepared = await read(binding, decision, "prepared");
      if (!prepared) return pending("desktop_prepare_required");
      const old = await read(binding, decision, "presented");
      if (old) return { ...pending("desktop_question_pending"), substrateRef: old.substrateRef };
      const snapshot = readerSnapshot(await readThread(prepared.hostContext), prepared.hostContext.threadId, prepared.hostContext.hostId);
      if (snapshot.event.callRef === prepared.baseline.event.callRef || Date.parse(snapshot.event.observedAt) < Date.parse(prepared.challenge.issuedAt)) {
        return pending("fresh_post_ask_reader_required");
      }
      const turns = snapshot.body.turns.filter((turn) => turn.id === prepared.hostContext.turnId);
      if (turns.some((turn) => turn.error)) throw new Error("Current Desktop question turn has an error");
      const candidates = turns.flatMap((turn) => turn.items.filter((item) => item?.type === "agentMessage" && item.phase === "final_answer" &&
        typeof item.id === "string" && /^call_/u.test(item.id) && !prepared.baselineCallIds.includes(item.id) && item.text === questionText(prepared)));
      if (candidates.length !== 1) return pending(candidates.length ? "desktop_presentation_ambiguous_do_not_resend" : "new_native_question_not_observed_do_not_resend");
      const callId = candidates[0].id;
      const identity = { hostConnectionRef, threadId: prepared.hostContext.threadId, questionTurnId: prepared.hostContext.turnId, callId, questionIndex: 0 };
      const substrateRef = digest(identity);
      const substrate = presentNativeHostAnswerSubstrate(decision, prepared.challenge, { substrateRef, runtime: "codex", surface: "request_user_input",
        hostEventClaimRef: substrateRef, renderedHostPayloadDigest: digest(prepared.payload.questions), hostConnectionRef,
        sessionOrThreadRef: correlation("desktop-thread", identity.threadId), turnRef: correlation("desktop-question-turn", identity.questionTurnId),
        itemRef: correlation("desktop-question-item", [callId, 0]), toolUseOrRequestRef: correlation("desktop-call", callId),
        issuedAt: prepared.challenge.issuedAt, expiresAt: prepared.challenge.expiresAt, timeSourceClaimRef: correlation("desktop-presentation-read", snapshot.event.callRef) });
      let stored;
      try { stored = await repository.issue(substrate); }
      catch (error) {
        if (error.code !== "NATIVE_HOST_ANSWER_REPOSITORY_REPLAY") throw error;
        stored = await repository.read({ substrateRef });
        if (stored.substrateDigest !== substrate.substrateDigest) throw new Error("Native question is already bound to another challenge");
      }
      await write(binding, decision, "presented", { ...identity, substrateRef, snapshot });
      return { ...pending("desktop_question_pending"), substrateRef: stored.substrateRef };
    },

    /** A later turn can observe the original exact call/index; it never asks. */
    async observe({ binding, decision }) {
      const prepared = await read(binding, decision, "prepared");
      const presented = await read(binding, decision, "presented");
      if (!prepared || !presented) return pending("desktop_registered_presentation_required");
      const previous = await read(binding, decision, "observed");
      if (previous) return { status: "observed", executionAllowed: false };
      const snapshot = readerSnapshot(await readThread(prepared.hostContext), prepared.hostContext.threadId, prepared.hostContext.hostId);
      const questionTurn = snapshot.body.turns.findIndex((turn) => turn.id === presented.questionTurnId);
      const questionItem = questionTurn < 0 ? -1 : snapshot.body.turns[questionTurn].items.findIndex((item) => item?.type === "agentMessage" &&
        item.id === presented.callId && item.phase === "final_answer" && item.text === questionText(prepared));
      if (questionItem < 0) return pending("registered_native_question_not_visible");
      if (snapshot.body.turns[questionTurn].error) throw new Error("Registered Desktop question turn has an error");
      const matches = [];
      for (const [turnIndex, turn] of snapshot.body.turns.entries()) for (const [itemIndex, item] of turn.items.entries()) {
        if (item?.type !== "userMessage" || !Array.isArray(item.content)) continue;
        for (const part of item.content) {
          if (part?.type !== "text" || typeof part.text !== "string") continue;
          const wrapper = /^<send_user_message_question_reply>([\s\S]*)<\/send_user_message_question_reply>$/u.exec(part.text);
          if (!wrapper) continue;
          const replies = parseUnassociatedJson(wrapper[1]);
          if (!Array.isArray(replies)) continue;
          for (const reply of replies) {
            if (!reply || typeof reply !== "object" || Array.isArray(reply) || typeof reply.questionItemId !== "string") continue;
            const key = parseUnassociatedJson(reply.questionItemId);
            if (!Array.isArray(key) || key.length !== 3 || key[0] !== "request_user_input_async" || key[1] !== presented.callId || key[2] !== 0) continue;
            if (turn.error) throw new Error("Current Desktop reply turn has an error");
            if (reply.question !== prepared.presentation.questions[0].question || typeof reply.answer !== "string" ||
                turnIndex > questionTurn || turnIndex === questionTurn && itemIndex <= questionItem) throw new Error("Native answer does not match its current question or ordering");
            const options = prepared.presentation.questions[0].options.filter((option) => option.label === reply.answer);
            if (options.length !== 1) return pending("native_answer_is_not_one_explicit_current_option");
            matches.push({ selectedOptionId: options[0].optionId, replyTurnId: turn.id, replyItemId: item.id, reply });
          }
        }
      }
      if (matches.length !== 1) return pending(matches.length ? "native_reply_ambiguous" : "native_reply_pending");
      const answer = matches[0];
      const at = now();
      const challenge = prepared.challenge;
      const claimed = claimNativeDecisionChallenge(decision, challenge, { ...Object.fromEntries([
        "runtime", "surface", "challengeRef", "challengeDigest", "decisionId", "presentedRevision", "runId", "requestRef",
        "optionSetDigest", "evidenceSetDigest", "presentationDigest"].map((key) => [key, challenge[key]])), claimedAt: at, selectedOptionId: answer.selectedOptionId });
      const substrate = assertValidNativeHostAnswerSubstrate(await repository.read({ substrateRef: presented.substrateRef }), decision, claimed);
      const claimDigest = digest({ presentation: presented.substrateRef, ...answer, rawDigest: snapshot.digest, readerCall: snapshot.event.callRef });
      if (substrate.state === "presented") {
        const observed = recordNativeHostReturnObservedClaim(decision, claimed, substrate, {
          ...Object.fromEntries(observeFields.map((key) => [key, substrate[key]])), at,
          timeSourceClaimRef: correlation("desktop-reply-read", snapshot.event.callRef), hostReturnObservedClaimDigest: claimDigest });
        await repository.observe({ record: observed, expectedRevision: substrate.revision, expectedSubstrateDigest: substrate.substrateDigest, expectedState: "presented" });
      } else if (!["host_return_observed", "consumed"].includes(substrate.state) || substrate.hostReturnObservedClaimDigest !== claimDigest) {
        throw new Error("Desktop reply conflicts with the existing observation");
      }
      await write(binding, decision, "observed", { answer, challenge: claimed, claimDigest, snapshot });
      return { status: "observed", executionAllowed: false, originAuthenticatedByLibrary: false };
    },

    /** Revalidate durable current bindings, then consume through the existing CAS. */
    async consume({ binding, decision }) {
      let observed = await read(binding, decision, "observed");
      if (!observed) {
        const result = await adapter.observe({ binding, decision });
        if (result.status !== "observed") return result;
        observed = await read(binding, decision, "observed");
      }
      const presented = await read(binding, decision, "presented");
      const record = assertValidNativeHostAnswerSubstrate(await repository.read({ substrateRef: presented.substrateRef }), decision, observed.challenge);
      if (record.hostReturnObservedClaimDigest !== observed.claimDigest) throw new Error("Stored Desktop reply digest mismatch");
      let current = record;
      if (record.state === "host_return_observed") {
        current = await repository.consume({ record: consumeNativeHostReturnObservedClaim(record, { at: now(),
          timeSourceClaimRef: correlation("desktop-consume", binding.bindingDigest), consumerRef: `consumer:${binding.bindingDigest}` }),
        expectedRevision: record.revision, expectedSubstrateDigest: record.substrateDigest, expectedState: "host_return_observed" });
      }
      if (current.state !== "consumed" || current.consumerRef !== `consumer:${binding.bindingDigest}`) return pending("current_desktop_reply_not_consumed");
      return { status: "consumed", state: "consumed", selectedOptionId: observed.answer.selectedOptionId, substrateRef: current.substrateRef,
        observedClaimDigest: current.hostReturnObservedClaimDigest, answerEvidenceRef: observed.snapshot.event.rawRef,
        questionTurnRef: correlation("desktop-question-turn", presented.questionTurnId), replyTurnRef: correlation("desktop-reply-turn", observed.answer.replyTurnId),
        executionAllowed: false, originAuthenticatedByLibrary: false };
    },
  });
  adapters.add(adapter);
  return adapter;
}

export const isCodexDesktopDecisionHostAdapter = (adapter) => adapters.has(adapter);
