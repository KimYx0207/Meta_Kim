import process from "node:process";
import { readJsonFromStdin } from "./utils.mjs";
import {
  activateSpineState,
  isSameVerifiedSourceConversation,
  readSpineStateIncludingInactive,
  terminalizeSpineState,
} from "./spine-state.mjs";
import { resolveVerifiedSourceConversation } from "./conversation-binding.mjs";

// Claude Code Stop entrypoint. Keep this runtime-facing adapter independent
// from the generic Codex/Cursor entrypoint: only the lifecycle implementation
// in spine-state.mjs is shared across runtimes.

const payload = await readJsonFromStdin();

const cwd = process.cwd();

try {
  let state = await readSpineStateIncludingInactive(cwd);
  if (!state) {
    process.exit(0);
  }

  const { conversation } = resolveVerifiedSourceConversation(payload, { runtime: "claude" });
  if (state.sourceConversation?.conversationId) {
    if (!isSameVerifiedSourceConversation(state, conversation)
      || (payload?.run_id && payload.run_id !== state.runId)) {
      process.stderr.write("[spine-cleanup] preserved another or unverified conversation's run\n");
      process.exit(0);
    }
  }

  const evolutionCompleted =
    state.deactivationReason === "evolution_completed" ||
    state.stages?.evolution?.status === "completed";
  if (!evolutionCompleted && state.active && payload?.hook_event_name === "Stop"
    && state.stageRuntimeControl?.activationMode === "hook_observed" && conversation
    && (!payload?.run_id || payload.run_id === state.runId)) {
    const nativeHint = state.stageRuntimeControl?.nativeSessionHint;
    if (!state.sourceConversation && nativeHint?.runtime === "claude") {
      if (nativeHint.sessionId !== conversation.conversationId.toLowerCase()) process.exit(0);
      const expectedRunId = state.runId;
      await activateSpineState(cwd, state, { refreshExisting: true, expectedRunId, verifiedConversation: conversation });
      state = await readSpineStateIncludingInactive(cwd);
      if (!state?.active || state.runId !== expectedRunId) process.exit(0);
    }
    if (isSameVerifiedSourceConversation(state, conversation)) {
      process.stderr.write("[spine-cleanup] preserved the verified Claude task across its turn boundary\n");
      process.exit(0);
    }
  }
  if (!evolutionCompleted && Number.isSafeInteger(state.hostCheckpointRevision) && state.hostCheckpointRevision > 0) {
    process.stderr.write("[spine-cleanup] preserved the host task across its turn boundary\n");
    process.exit(0);
  }
  const result = await terminalizeSpineState(cwd, {
    expectedRunId: state.runId,
    reason: evolutionCompleted ? "evolution_completed" : "session_stop",
    removeStateFile: evolutionCompleted,
  });
  if (!result.terminalized) {
    process.stderr.write(
      `[spine-cleanup] skipped stale Claude Stop request, reason=${result.reason || "authoritative_state_changed"}\n`,
    );
    process.exit(0);
  }
  if (evolutionCompleted) {
    process.stderr.write(
      `[spine-cleanup] Claude evolution completed, run=${result.runId || "unknown"} terminalized before spine state removal\n`,
    );
  } else {
    process.stderr.write(
      `[spine-cleanup] Claude spine deactivated at stage=${state.currentStage}, agents dispatched=${state.dispatchedAgents?.length || 0}\n`,
    );
  }
} catch {
  // Stop cleanup is advisory and must never prevent Claude Code shutdown.
}

process.exit(0);
