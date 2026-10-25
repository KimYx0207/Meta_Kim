import process from "node:process";
import { readJsonFromStdin } from "./utils.mjs";
import { readSpineStateIncludingInactive, terminalizeSpineState } from "./spine-state.mjs";
import { resolveVerifiedSourceConversation } from "./conversation-binding.mjs";

// Generic Codex/Cursor Stop entrypoint. Runtime-neutral lifecycle transitions
// live in spine-state.mjs; Claude Code keeps its own independent entrypoint.

const payload = await readJsonFromStdin();

const cwd = process.cwd();

try {
  const state = await readSpineStateIncludingInactive(cwd);
  if (!state) {
    process.exit(0);
  }

  // A project's spine may belong to another chat or to the parent of a worker
  // that shares its cwd. Stop is a turn event, not authority over that chat.
  if (state.sourceConversation?.conversationId) {
    const bound = resolveVerifiedSourceConversation(payload, { runtime: state.sourceConversation.runtime });
    if (bound.conversation?.conversationId !== state.sourceConversation.conversationId
      || (payload?.run_id && payload.run_id !== state.runId)) {
      process.stderr.write("[spine-cleanup] preserved another or unverified conversation's run\n");
      process.exit(0);
    }
  }

  const evolutionCompleted =
    state.deactivationReason === "evolution_completed" ||
    state.stages?.evolution?.status === "completed";
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
      `[spine-cleanup] skipped stale stop request, reason=${result.reason || "authoritative_state_changed"}\n`,
    );
    process.exit(0);
  }
  if (evolutionCompleted) {
    process.stderr.write(
      `[spine-cleanup] evolution completed, run=${result.runId || "unknown"} terminalized before spine state removal\n`,
    );
  } else {
    process.stderr.write(
      `[spine-cleanup] spine deactivated at stage=${state.currentStage}, agents dispatched=${state.dispatchedAgents?.length || 0}\n`,
    );
  }
} catch {
  // Non-critical: never block session stop
}

process.exit(0);
