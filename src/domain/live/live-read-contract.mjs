import path from "node:path";

/** Shared read limits and identities, independent of storage and HTTP. */
export const LIVE_MAX_JSON_BYTES = 8 * 1024 * 1024;
// A meta- prefix is conventional, not required by the governed run contract.
export const LIVE_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function isLiveRunId(value) {
  return typeof value === "string" && LIVE_RUN_ID_PATTERN.test(value);
}

export function normalizeLiveRunId(value) {
  return isLiveRunId(value) ? value : null;
}

export function isPathInside(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
