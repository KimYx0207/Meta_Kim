export const READ_ONLY_RUN_CANONICAL_PROJECTION_IDS = Object.freeze([
  "M3-A01", "M3-A02", "M3-A03", "M3-A04", "M3-A05", "M3-A06", "M3-A07",
]);

export const READ_ONLY_RUN_EVALUATION_STATUSES = Object.freeze([
  "evaluated", "not_evaluated", "in_doubt",
]);

export const READ_ONLY_RUN_PROJECTION_AUTHORIZATION_FIELDS = Object.freeze([
  "authoritativeWriteAllowed", "eventPersistenceAllowed", "executionAllowed",
  "schedulerDispatchAllowed", "claimAllowed", "leaseMutationAllowed",
  "cursorAdvanceAllowed", "checkpointMutationAllowed", "completeNodeAllowed",
  "terminalStatusWriteAllowed", "todoMutationAllowed", "decisionBypassAllowed",
  "evidenceBypassAllowed", "legacyGateCutoverAllowed",
]);

const SENSITIVE = /(?:sk[-_](?:proj|live)|api[-_]?key|access[-_]?token|bearer|password|secret|xox[baprs]-|gh[pousr]_|AKIA[0-9A-Z]{8,}|eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,})/iu;
const HIGH_ENTROPY = /^(?=.{40,}$)(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9])[A-Za-z0-9_-]+$/u;
const LOCAL_PATH = /(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp|var|etc)(?:\/|$)|\.\.[\\/])/u;

export function containsReadOnlyRunSensitiveMaterial(value) {
  if (typeof value !== "string") return false;
  const normalized = value.normalize("NFKC");
  return SENSITIVE.test(normalized) || HIGH_ENTROPY.test(normalized) || LOCAL_PATH.test(normalized);
}
