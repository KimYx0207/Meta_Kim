/**
 * Which host produced this governed run, and is there a live chat to attach it to.
 *
 * Both answers used to be wrong in the same record. The runner normalized its
 * route runtime with a hardcoded `"codex"` fallback and then recorded that value
 * as the producer, so every run started from a Claude Code session was filed
 * under Codex and the Live panel named the wrong tool for all of them. The chat
 * question was never asked at all: the activation hook writes a verified
 * `sourceConversation` into spine state, and the runner already imported the
 * spine reader for worker bindings, but no code path ever read that field — so no
 * governed run could be linked to the session it came from and every row read
 * "unlinked".
 *
 * The two questions are kept apart here because they have different failure
 * modes:
 *   - provenance: which host this record came from. A default is a lie, so an
 *     unproven host is `unavailable`.
 *   - route target: which runtime the route plans against. Route selection only
 *     supports codex and claude, so it keeps its default and stays in the
 *     orchestration evidence where planning belongs.
 */

import {
  bindSourceConversation,
  sanitizeStateProfile,
} from "../../canonical/runtime-assets/shared/hooks/spine-state.mjs";
import {
  CONVERSATION_RUNTIME_UNAVAILABLE,
  conversationRuntimeFamily,
} from "../../src/application/live/live-conversation-link-vocabulary.mjs";

/**
 * One table for the environment variables that prove which host is running.
 *
 * `stage-runner-bridge.mjs` already knew this exact list: it strips these from a
 * child environment so a nested runtime cannot inherit the outer host's
 * identity. Provenance needs the same facts with the runtime attached, so the
 * table lives here and the bridge derives its strip list from it. Two copies
 * diverge the moment a host adds a variable — the bridge would keep leaking a
 * marker that detection still trusts as identity.
 */
export const HOST_RUNTIME_ENV_MARKERS = Object.freeze([
  Object.freeze({ runtime: "claude", envName: "CLAUDECODE" }),
  Object.freeze({ runtime: "claude", envName: "CLAUDE_CODE_ENTRYPOINT" }),
  Object.freeze({ runtime: "codex", envName: "CODEX_THREAD_ID" }),
  Object.freeze({ runtime: "codex", envName: "CODEX_PERMISSION_PROFILE" }),
]);

export const HOST_RUNTIME_ENV_MARKER_NAMES = Object.freeze(
  HOST_RUNTIME_ENV_MARKERS.map((marker) => marker.envName),
);

/**
 * The chat id the host exports into every process it starts.
 *
 * Deliberately a separate table from the runtime markers even though both are
 * inherited env vars, because the two are read for different questions and only
 * one of them is safe as identity. A session id outlives its session: a daemon
 * started from a chat that has since ended still exports that id. If this name
 * sat in `HOST_RUNTIME_ENV_MARKERS`, `detectHostRuntimeFromEnv` would read a
 * dead session's id as proof of the host family, which is the same staleness
 * hazard moved into provenance — and provenance has no refusal field to carry
 * the doubt, so the record would state it as fact.
 *
 * Both tables are inherited, so the child-environment strip list is the union.
 */
export const HOST_SESSION_ENV_MARKERS = Object.freeze([
  Object.freeze({ runtime: "claude", envName: "CLAUDE_CODE_SESSION_ID" }),
]);

export const HOST_SESSION_ENV_MARKER_NAMES = Object.freeze(
  HOST_SESSION_ENV_MARKERS.map((marker) => marker.envName),
);

export const HOST_INHERITED_ENV_NAMES = Object.freeze([
  ...HOST_RUNTIME_ENV_MARKER_NAMES,
  ...HOST_SESSION_ENV_MARKER_NAMES,
]);

export const HOST_RUNTIME_PROVENANCE_BASIS = Object.freeze([
  "declared_runtime_flag",
  "live_spine_binding",
  "revived_host_session_binding",
  "host_env_marker",
  "conflicting_host_env_markers",
  "no_host_env_marker",
]);

/**
 * Which route proved the chat, recorded so a reader can tell them apart.
 *
 * The revived route is real but weaker evidence than a live one, and a link that
 * cannot be distinguished from a proven link is the failure this module exists to
 * prevent. Reusing one name for both would erase exactly that distinction.
 */
export const SPINE_CONVERSATION_BINDING_BASIS = Object.freeze([
  "live_spine_binding",
  "revived_host_session_binding",
]);

/**
 * A deactivated spine run may still be revived when the host is provably the
 * same chat, but only for a stop that is a session boundary. `evolution_completed`
 * is the run's own lifecycle finishing, not the session pausing, so it never
 * revives.
 */
const REVIVABLE_DEACTIVATION_REASONS = Object.freeze(["session_stop"]);

/**
 * Why a live spine run did not hand its chat to this governed run.
 *
 * These are diagnostics for the run record, deliberately separate from
 * `CONVERSATION_LINK_REFUSAL_REASONS`: that vocabulary explains a *binding
 * attempt the host made* and has reader-facing copy, while these explain that
 * this runner had no live binding to inherit. Mapping "the session already ended"
 * onto a transcript-verification reason would put a sentence in front of a reader
 * that describes something nobody tried.
 */
export const SPINE_CONVERSATION_BINDING_REFUSALS = Object.freeze([
  "no_spine_state",
  "spine_run_inactive",
  "spine_profile_mismatch",
  "spine_conversation_unlinked",
  "spine_conversation_unverified_basis",
  "spine_conversation_host_session_absent",
  "spine_conversation_host_session_mismatch",
  "governed_run_id_missing",
]);

function envValue(env, name) {
  const raw = env[name];
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Markers from two hosts cannot attribute a run: launching Claude Code from a
 * Codex session leaves the outer host's variables in the environment, so the
 * intersection is evidence of nesting, not of identity.
 */
export function detectHostRuntimeFromEnv(env = process.env) {
  const source = env && typeof env === "object" ? env : {};
  const present = HOST_RUNTIME_ENV_MARKERS.filter(
    (marker) => envValue(source, marker.envName) !== "",
  );
  const observedMarkers = Object.freeze(present.map((marker) => marker.envName));
  const runtimes = [...new Set(present.map((marker) => marker.runtime))];
  if (runtimes.length === 1) {
    return {
      runtime: conversationRuntimeFamily(runtimes[0]),
      basis: "host_env_marker",
      observedMarkers,
    };
  }
  return {
    runtime: CONVERSATION_RUNTIME_UNAVAILABLE,
    basis: runtimes.length > 1 ? "conflicting_host_env_markers" : "no_host_env_marker",
    observedMarkers,
  };
}

/**
 * The chat id this process was started under, or null.
 *
 * Never routed into runtime detection: the presence of this variable says a chat
 * id was inherited, not that the chat is still open, so it cannot stand in as
 * proof of the host family. Its only use is equality against a chat the host
 * already verified.
 */
export function detectHostSessionConversationId(env = process.env) {
  const source = env && typeof env === "object" ? env : {};
  for (const marker of HOST_SESSION_ENV_MARKERS) {
    const value = envValue(source, marker.envName);
    if (value !== "") return value;
  }
  return null;
}

/**
 * Precedence, strongest evidence first:
 *   1. an explicit runtime from the caller — the only way to record a run
 *      produced on behalf of a host this process is not running under;
 *   2. a live spine binding — written by the host's own activation hook after it
 *      verified its transcript file, which is proof, not a hint;
 *   3. env markers — last, because they survive nested launches.
 * An unknown name is not evidence and falls through instead of reaching a reader.
 */
export function resolveGovernedRunProvenance({
  declaredRuntime = null,
  spineRuntime = null,
  spineBindingBasis = null,
  env = process.env,
} = {}) {
  // The spine route reports which of its own routes proved the chat. Labelling a
  // revived binding `live_spine_binding` here would put the overstatement in the
  // one field that has no refusal beside it to carry the doubt.
  const spineBasis = SPINE_CONVERSATION_BINDING_BASIS.includes(spineBindingBasis)
    ? spineBindingBasis
    : "live_spine_binding";
  for (const [value, basis] of [
    [declaredRuntime, "declared_runtime_flag"],
    [spineRuntime, spineBasis],
  ]) {
    const family = conversationRuntimeFamily(value);
    if (family !== CONVERSATION_RUNTIME_UNAVAILABLE) {
      return { sourceRuntime: family, basis, observedMarkers: Object.freeze([]) };
    }
  }
  const detected = detectHostRuntimeFromEnv(env);
  return {
    sourceRuntime: detected.runtime,
    basis: detected.basis,
    observedMarkers: detected.observedMarkers,
  };
}

/**
 * Mirrors the profile precedence the spine reader routes with, minus its final
 * fallback to the state file's own profile. Using the state's value as the
 * expectation would compare it with itself, and the drift this check exists to
 * catch is exactly a state file whose recorded profile is not the profile this
 * run writes under.
 */
export function governedRunStateProfile(env = process.env) {
  const source = env && typeof env === "object" ? env : {};
  return sanitizeStateProfile(
    envValue(source, "META_KIM_PROFILE") || envValue(source, "META_KIM_STATE_PROFILE"),
  );
}

function refuseSpineBinding(refusal) {
  return {
    linked: false,
    refusal,
    bindingBasis: null,
    sourceRuntime: null,
    sourceConversation: null,
    spineRunId: null,
  };
}

/**
 * Which route, if any, is allowed to lend this spine run's chat.
 *
 * An active run lends it outright. A deactivated one may still lend it, because
 * Claude Code's `Stop` hook fires at every turn boundary rather than at session
 * end — so a spine terminalized with `session_stop` routinely belongs to a chat
 * that is still open, and refusing all of them left every governed run after the
 * first turn boundary permanently unlinked.
 *
 * Reviving needs a second, independent fact: the chat id this process inherited
 * from the host has to be the very chat the host verified. That is an equality
 * check against one recorded id, not a search — nothing here ranks candidates or
 * picks a nearest match.
 *
 * What it still cannot prove is that the chat is open, because a chat id outlives
 * its session. The residual case is a long-lived process holding a dead chat's id
 * while that same chat is still the most recent activation on disk; it is narrowed
 * by the equality check and declared on the record through `bindingBasis` rather
 * than hidden behind the live route's name.
 */
function spineBindingRoute(spineState, recordedConversationId, hostSessionId) {
  if (spineState.active === true) return { basis: "live_spine_binding" };
  if (!REVIVABLE_DEACTIVATION_REASONS.includes(spineState.deactivationReason)) {
    return { refusal: "spine_run_inactive" };
  }
  if (typeof hostSessionId !== "string" || !hostSessionId.trim()) {
    return { refusal: "spine_conversation_host_session_absent" };
  }
  if (hostSessionId.trim().toLowerCase() !== String(recordedConversationId).toLowerCase()) {
    return { refusal: "spine_conversation_host_session_mismatch" };
  }
  return { basis: "revived_host_session_binding" };
}

/**
 * A link is only inherited from a binding that belongs to this profile, was
 * verified by the host, and is either still live or provably the chat this
 * process is running under. Nothing here searches for a chat: a nearest-timestamp
 * or only-one-candidate guess produces a record that is indistinguishable from a
 * proven link, and the panel has no way to tell a reader which one it is looking
 * at. Transcript-file age is not consulted for the same reason — a session idle
 * for hours is still the live session, so recency answers a different question
 * than the one being asked.
 */
export function resolveSpineConversationBinding({
  spineState = null,
  runId = null,
  runProfile = "default",
  hostSessionId = null,
} = {}) {
  if (!spineState || typeof spineState !== "object") return refuseSpineBinding("no_spine_state");
  if (sanitizeStateProfile(spineState.profile) !== sanitizeStateProfile(runProfile)) {
    return refuseSpineBinding("spine_profile_mismatch");
  }
  const candidate = spineState.sourceConversation;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return refuseSpineBinding("spine_conversation_unlinked");
  }
  // An unstamped chat record reads as verified for every run on the read
  // surface, so a governed run without an id cannot be given a link at all.
  if (typeof runId !== "string" || !runId.trim()) {
    return refuseSpineBinding("governed_run_id_missing");
  }
  const route = spineBindingRoute(spineState, candidate.conversationId, hostSessionId);
  if (route.refusal) return refuseSpineBinding(route.refusal);

  // Spine state files the chat under the *spine* run id. The canonical
  // normalizer refuses to restamp a foreign run id — it returns null — so a
  // verbatim copy lands on the read surface as another run's candidate rather
  // than as this run's link. Rebinding under the governed id keeps the same
  // chat, and the spine id is preserved beside it as the audit trail of which
  // activation proved it.
  const { runId: spineRunId, ...chat } = candidate;
  const bound = bindSourceConversation({ runId }, chat, {
    sourceRuntime: spineState.sourceRuntime,
  });
  if (bound.conversationLinkState !== "verified") {
    return refuseSpineBinding("spine_conversation_unlinked");
  }
  // The canonical normalizer drops a `matchBasis` outside its whitelist, so an
  // absent basis here is the whitelist's own verdict rather than a second copy
  // of it.
  if (!bound.sourceConversation.matchBasis) {
    return refuseSpineBinding("spine_conversation_unverified_basis");
  }
  return {
    linked: true,
    refusal: null,
    bindingBasis: route.basis,
    sourceRuntime: conversationRuntimeFamily(bound.sourceRuntime),
    sourceConversation: bound.sourceConversation,
    spineRunId: typeof spineRunId === "string" ? spineRunId : null,
  };
}
