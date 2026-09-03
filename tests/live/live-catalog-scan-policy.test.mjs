import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_CATALOG_SCAN_CONFIG_URL,
  LIVE_CATALOG_SCAN_SCHEMA_VERSION,
  loadLiveCatalogScanPolicy,
  normalizeLiveCatalogScanPolicy,
} from "../../src/application/live/live-catalog-scan-policy.mjs";

function validDocument(overrides = {}) {
  return {
    schemaVersion: LIVE_CATALOG_SCAN_SCHEMA_VERSION,
    cacheTtlMs: 2000,
    staleWhileRevalidateMs: 60_000,
    projectScanConcurrency: 8,
    ...overrides,
  };
}

test("the shipped catalog scan policy states both waits the reader pays", () => {
  const policy = loadLiveCatalogScanPolicy();
  assert.equal(policy.schemaVersion, LIVE_CATALOG_SCAN_SCHEMA_VERSION);
  assert.ok(
    policy.cacheTtlMs > 0,
    "a zero cache would put the whole project walk in front of every click, which is the defect this file exists to hold",
  );
  assert.ok(
    policy.projectScanConcurrency > 1,
    "one lane is a serial loop; the shipped value has to be the parallel one or the file changes nothing",
  );
  // A freshness window alone does not help someone clicking around the panel:
  // measured on this machine the walk still costs ~900ms, and ordinary clicks
  // arrive 5-15s apart, so every one of them fell outside a 2s window and paid
  // the walk again. The window a reader is served from has to cover that cadence.
  assert.ok(
    policy.cacheTtlMs + policy.staleWhileRevalidateMs >= 15_000,
    "the served window has to outlast the gap between two human clicks, or the reader waits out a fresh walk each time",
  );
  assert.ok(
    LIVE_CATALOG_SCAN_CONFIG_URL.href.endsWith("config/live/catalog-scan.json"),
    "the policy has to read the shipped document, not a copy of the numbers",
  );
});

test("the catalog scan policy refuses a document it cannot act on", () => {
  assert.throws(() => normalizeLiveCatalogScanPolicy(null), /must be an object/u);
  assert.throws(
    () => normalizeLiveCatalogScanPolicy(validDocument({ schemaVersion: "meta-kim-live-catalog-scan-v0" })),
    (error) => error.code === "LIVE_CATALOG_SCAN_SCHEMA_MISMATCH",
  );
  // Zero is the shape of the bug: a TTL that can never be inside its window is a
  // cache that is never read, and the endpoint then walks every project per click.
  assert.throws(
    () => normalizeLiveCatalogScanPolicy(validDocument({ cacheTtlMs: 0 })),
    /cacheTtlMs must be a positive integer/u,
  );
  assert.throws(
    () => normalizeLiveCatalogScanPolicy(validDocument({ cacheTtlMs: 1500.5 })),
    /cacheTtlMs must be a positive integer/u,
  );
  assert.throws(
    () => normalizeLiveCatalogScanPolicy(validDocument({ projectScanConcurrency: 0 })),
    /projectScanConcurrency must be an integer of at least 1/u,
  );
  assert.throws(
    () => normalizeLiveCatalogScanPolicy(validDocument({ projectScanConcurrency: "8" })),
    /projectScanConcurrency must be an integer of at least 1/u,
  );
  // Zero is a legal answer here — it means "serve nothing stale" — but a missing
  // or negative window is not, because the reader would be served a list from a
  // window nobody chose.
  assert.throws(
    () => normalizeLiveCatalogScanPolicy(validDocument({ staleWhileRevalidateMs: undefined })),
    /staleWhileRevalidateMs must be an integer of at least 0/u,
  );
  assert.throws(
    () => normalizeLiveCatalogScanPolicy(validDocument({ staleWhileRevalidateMs: -1 })),
    /staleWhileRevalidateMs must be an integer of at least 0/u,
  );
  assert.equal(
    normalizeLiveCatalogScanPolicy(validDocument({ staleWhileRevalidateMs: 0 })).staleWhileRevalidateMs,
    0,
    "turning the stale window off has to stay expressible, or the only way back to strict freshness is editing code",
  );
});

test("a normalized catalog scan policy carries only the three numbers, frozen", () => {
  const policy = normalizeLiveCatalogScanPolicy(validDocument({
    description: "prose for whoever changes the numbers",
    policyNotes: { cacheTtlMs: "why" },
  }));
  assert.deepEqual(
    Object.keys(policy).sort(),
    ["cacheTtlMs", "projectScanConcurrency", "schemaVersion", "staleWhileRevalidateMs"],
  );
  assert.equal(Object.isFrozen(policy), true);
});
