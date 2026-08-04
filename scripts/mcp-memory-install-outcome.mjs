import {
  INSTALL_STEP_CLASSIFICATION,
  INSTALL_STEP_OUTCOME,
  installStep,
} from "./install-status-semantics.mjs";

export const MCP_MEMORY_INSTALL_OUTCOME = Object.freeze({
  OWNERSHIP_FAILURE: "mcp_memory_boot_ownership_failed",
});

/** Build the MCP Memory aggregate step without weakening ownership failures. */
export function mcpMemoryInstallStep(id, outcome) {
  if (outcome === MCP_MEMORY_INSTALL_OUTCOME.OWNERSHIP_FAILURE) {
    return installStep(id, false, INSTALL_STEP_CLASSIFICATION.CRITICAL);
  }
  return installStep(
    id,
    outcome === undefined ? INSTALL_STEP_OUTCOME.SKIPPED : outcome,
    INSTALL_STEP_CLASSIFICATION.OPTIONAL,
  );
}
