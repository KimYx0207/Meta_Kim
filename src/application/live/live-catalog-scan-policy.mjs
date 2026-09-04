/**
 * How the Hub reads the registered project list, and how long it may reuse what
 * it read.
 *
 * The catalog is one object covering every registered project, and building it
 * walks each project's governed-run directory. Measured in-process on this
 * machine, 19 projects holding 47 discoverable runs cost 1614ms and then 1657ms
 * on two consecutive calls — there was no reuse between them, and the control
 * room asks for the catalog on first paint and again on every project or run
 * switch, so the reader waits out the whole walk each time.
 *
 * The wait is not a busy event loop: a concurrent `/api/health` answered in 1ms
 * while a catalog request was 1619ms into its work. It is file I/O over
 * independent directories, which is why the numbers here are the fix.
 * `projectScanConcurrency` overlaps the independent walks; `cacheTtlMs` lets the
 * next request reuse a list that was just built; `staleWhileRevalidateMs` covers
 * the gap the freshness window cannot, because clicks arrive further apart than
 * any window short enough to call current. They are refused rather than clamped
 * when they fall outside what the Hub can act on, because a silently corrected
 * value reads back as the value that was asked for.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LIVE_CATALOG_SCAN_SCHEMA_VERSION = "meta-kim-live-catalog-scan-v1";

export const LIVE_CATALOG_SCAN_CONFIG_URL = new URL(
  "../../../config/live/catalog-scan.json",
  import.meta.url,
);

function fail(message, code = "LIVE_CATALOG_SCAN_INVALID") {
  const error = new TypeError(`Live catalog scan policy: ${message}`);
  error.code = code;
  throw error;
}

/** Validate and freeze a raw catalog-scan document. */
export function normalizeLiveCatalogScanPolicy(raw) {
  if (!raw || typeof raw !== "object") fail("document must be an object");
  if (raw.schemaVersion !== LIVE_CATALOG_SCAN_SCHEMA_VERSION) {
    fail(
      `schemaVersion must be ${LIVE_CATALOG_SCAN_SCHEMA_VERSION}`,
      "LIVE_CATALOG_SCAN_SCHEMA_MISMATCH",
    );
  }
  if (!Number.isSafeInteger(raw.cacheTtlMs) || raw.cacheTtlMs <= 0) {
    fail(
      "cacheTtlMs must be a positive integer; a window that can never contain a "
        + "second request is a cache the catalog endpoint never reads, which is how "
        + "the reader ended up paying the full project walk for every click",
      "LIVE_CATALOG_SCAN_TTL_INVALID",
    );
  }
  if (!Number.isSafeInteger(raw.staleWhileRevalidateMs) || raw.staleWhileRevalidateMs < 0) {
    fail(
      "staleWhileRevalidateMs must be an integer of at least 0; a window nobody "
        + "chose would decide how old a list the reader is shown",
      "LIVE_CATALOG_SCAN_STALE_WINDOW_INVALID",
    );
  }
  if (!Number.isSafeInteger(raw.projectScanConcurrency) || raw.projectScanConcurrency < 1) {
    fail(
      "projectScanConcurrency must be an integer of at least 1",
      "LIVE_CATALOG_SCAN_CONCURRENCY_INVALID",
    );
  }
  return Object.freeze({
    schemaVersion: raw.schemaVersion,
    cacheTtlMs: raw.cacheTtlMs,
    staleWhileRevalidateMs: raw.staleWhileRevalidateMs,
    projectScanConcurrency: raw.projectScanConcurrency,
  });
}

/** Read and validate the shipped catalog-scan document. */
export function loadLiveCatalogScanPolicy(configUrl = LIVE_CATALOG_SCAN_CONFIG_URL) {
  const raw = JSON.parse(readFileSync(fileURLToPath(configUrl), "utf8"));
  return normalizeLiveCatalogScanPolicy(raw);
}
