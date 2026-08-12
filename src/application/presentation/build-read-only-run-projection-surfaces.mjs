import { normalizeReadOnlyRunAuthoritySnapshot } from "../../data/projections/read-only-run-authority-snapshot.mjs";
import { assertValidReadOnlyRunProjectionModel, buildReadOnlyRunProjectionModel } from "../../domain/presentation/read-only-run-projection-surfaces.mjs";
import { renderReadOnlyRunSurfaces } from "../../presentation/run-surfaces/read-only-run-surface-renderers.mjs";

/** The only orchestration point: validate trusted input, build the canonical model, render copies. */
export function buildReadOnlyRunProjectionSurfaces({ authoritySnapshot, copy, statusColumnMap }) {
  const model = assertValidReadOnlyRunProjectionModel(buildReadOnlyRunProjectionModel({ authoritySnapshot: normalizeReadOnlyRunAuthoritySnapshot(authoritySnapshot) }));
  const surfaces = renderReadOnlyRunSurfaces({ model, copy, statusColumnMap });
  return Object.freeze({ model, surfaces });
}
