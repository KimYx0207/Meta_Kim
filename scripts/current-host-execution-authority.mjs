/**
 * The governed Node runner is not the Claude Code or Codex host. It can assess
 * route compatibility and request the next host action, but it cannot mint
 * current-task authority from callbacks, environment variables, or JSON.
 */
export function resolveCurrentHostHandoff({
  routeCompatible,
  choiceRequired = false,
  blockedReasons = [],
} = {}) {
  if (routeCompatible !== true) {
    return {
      handoffStatus: "blocked",
      hostAction: "none",
      executionAuthorized: false,
      blockedReasons: [...blockedReasons],
    };
  }
  if (choiceRequired) {
    return {
      handoffStatus: "awaiting_native_choice",
      hostAction: "invoke_native_choice_surface",
      executionAuthorized: false,
      blockedReasons: [],
    };
  }
  return {
    handoffStatus: "ready_for_host_handoff",
    hostAction: "host_action_required",
    executionAuthorized: false,
    blockedReasons: [],
  };
}
