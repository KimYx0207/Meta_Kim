import process from "node:process";
import { readJsonFromStdin } from "./utils.mjs";
import { readSpineStateIncludingInactive, terminalizeSpineState } from "./spine-state.mjs";

// Generic Codex/Cursor Stop entrypoint. Runtime-neutral lifecycle transitions
// live in spine-state.mjs; Claude Code keeps its own independent entrypoint.

await readJsonFromStdin();

const cwd = process.cwd();

try {
  const state = await readSpineStateIncludingInactive(cwd);
  if (!state) {
    process.exit(0);
  }

  const evolutionCompleted =
    state.deactivationReason === "evolution_completed" ||
    state.stages?.evolution?.status === "completed";
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
