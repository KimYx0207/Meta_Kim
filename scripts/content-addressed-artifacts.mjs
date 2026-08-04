import { existsSync } from "node:fs";
import { createHash } from "node:crypto";

function canonicalize(value, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("content-addressed input must contain finite numbers");
    }
    return value;
  }
  if (typeof value === "bigint" || typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError("content-addressed input contains an unsupported value");
  }
  if (seen.has(value)) {
    throw new TypeError("content-addressed input must not be cyclic");
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalize(item, seen));
    }

    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError("content-addressed input must contain plain objects");
    }
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key], seen)]),
    );
  } finally {
    seen.delete(value);
  }
}

/** Serialize equivalent JSON-like inputs identically without copying payload files. */
export function stableSerialize(value) {
  return JSON.stringify(canonicalize(value, new Set()));
}

/** Return a stable SHA-256 address for a logical artifact input or metadata record. */
export function contentDigest(value) {
  return createHash("sha256").update(stableSerialize(value), "utf8").digest("hex");
}

/**
 * Find a completed artifact that can be reused for an exact logical input.
 * Only small metadata is inspected; the existing artifact is never copied or
 * read. Missing, incomplete, or conflicting records are preserved for review.
 */
export function findReusableContentAddressedArtifact(records, {
  inputDigest,
  isAvailable = existsSync,
} = {}) {
  if (!Array.isArray(records) || typeof inputDigest !== "string" || inputDigest.length === 0) {
    return null;
  }

  for (const record of records) {
    if (!record || typeof record !== "object" || record.inputDigest !== inputDigest || record.status !== "complete") {
      continue;
    }
    if (typeof record.outputPath !== "string" || record.outputPath.length === 0 || typeof record.contentDigest !== "string") {
      continue;
    }
    if (isAvailable(record.outputPath)) {
      return { ...record, reused: true };
    }
  }
  return null;
}

/**
 * Collapse exact duplicate metadata records while retaining conflicting
 * records. This only returns metadata and performs no file deletion.
 */
export function deduplicateContentAddressedRecords(records) {
  if (!Array.isArray(records)) {
    throw new TypeError("content-addressed records must be an array");
  }

  const seen = new Set();
  const deduplicated = [];
  for (const record of records) {
    const key = record && typeof record === "object"
      ? stableSerialize([
        record.inputDigest ?? null,
        record.contentDigest ?? null,
        record.outputPath ?? null,
        record.status ?? null,
      ])
      : stableSerialize([record]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduplicated.push(record);
  }
  return deduplicated;
}
