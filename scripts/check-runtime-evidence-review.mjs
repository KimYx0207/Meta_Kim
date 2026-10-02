#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RUNTIME_REVIEW_STALE_AFTER_DAYS,
  validateRuntimeCapabilityClaims,
} from "./runtime-capability-evidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY_MS = 86_400_000;

// Read-only maintenance signal. It never rolls dates, changes claims, invokes
// providers, or converts a passing documentation review into live acceptance.
export function checkRuntimeEvidenceReview(matrix, ledger, { now = new Date().toISOString(), warningDays = 7 } = {}) {
  if (!Number.isFinite(Date.parse(now))) throw new TypeError("now must be a valid timestamp");
  if (!Number.isInteger(warningDays) || warningDays < 0 || warningDays > RUNTIME_REVIEW_STALE_AFTER_DAYS) {
    throw new TypeError("warningDays must be an integer within the review window");
  }
  const issues = validateRuntimeCapabilityClaims(matrix, ledger, { now });
  if (issues.length) return { status: "invalid", issueCount: issues.length, daysRemaining: null };
  const dates = [matrix.lastReviewedAt];
  for (const platform of matrix.platforms) {
    for (const row of platform.capabilities) dates.push(row.reviewState.lastReviewedAt);
  }
  for (const observation of ledger.observations) {
    if (observation.observationClass === "conservative_review") dates.push(observation.observedAt);
  }
  const oldest = Math.min(...dates.map((date) => Date.parse(date)));
  // Match the validator's integer-day age and strictly-greater-than TTL.
  const ageDays = Math.floor((Date.parse(now) - oldest) / DAY_MS);
  const daysRemaining = RUNTIME_REVIEW_STALE_AFTER_DAYS - ageDays;
  return { status: daysRemaining <= warningDays ? "due_soon" : "current", issueCount: 0, daysRemaining };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const matrix = JSON.parse(readFileSync(path.join(root, "config/runtime-capability-matrix.json"), "utf8"));
    const ledger = JSON.parse(readFileSync(path.join(root, "config/runtime-capability-evidence.json"), "utf8"));
    const result = checkRuntimeEvidenceReview(matrix, ledger);
    console.log(JSON.stringify(result));
    if (result.status !== "current") {
      console.error("Runtime evidence needs maintainer review. Check current official docs, repository pins and available host probes; keep unavailable claims conservative. Only then use meta:runtime:evidence:roll-review with an explicit date and rationale. This check never rewrites evidence.");
      process.exitCode = 1;
    }
  } catch {
    console.error("Runtime evidence review check failed safely; inspect the canonical evidence files and run meta:runtime:validate.");
    process.exitCode = 1;
  }
}
