import { buildReadOnlyRunProjectionSurfaces } from "../../src/application/presentation/build-read-only-run-projection-surfaces.mjs";

const AUTHORITY = Object.freeze({ projectionOnly: true, authoritative: false, authoritativeWriteAllowed: false, eventPersistenceAllowed: false, executionAllowed: false, schedulerDispatchAllowed: false, claimAllowed: false, leaseMutationAllowed: false, cursorAdvanceAllowed: false, checkpointMutationAllowed: false, completeNodeAllowed: false, terminalStatusWriteAllowed: false, todoMutationAllowed: false, decisionBypassAllowed: false, evidenceBypassAllowed: false, legacyGateCutoverAllowed: false });
function plainExact(value, fields) { return value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).every((key) => typeof key === "string") && Object.keys(value).sort().join("|") === [...fields].sort().join("|") && Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => descriptor.enumerable === true && "value" in descriptor); }
function envelope(evaluationStatus, result) { return Object.freeze({ schemaVersion: "read-only-run-projection-surfaces-adapter-v1", mode: "read_only", evaluationStatus, disposition: result ? result.model.status : "in_doubt", result, authority: AUTHORITY }); }

export function buildReadOnlyRunProjectionSurfacesAdapter(normalizedInput = {}, options = {}) {
  if (!plainExact(normalizedInput, []) || !plainExact(options, ["authoritySnapshot", "copy", "statusColumnMap"])) return envelope("not_evaluated_invalid_input", null);
  try { return envelope("evaluated", buildReadOnlyRunProjectionSurfaces(options)); }
  catch { return envelope("not_evaluated_invalid_authority_snapshot", null); }
}
