/**
 * Re-record the repository digests that the runtime capability evidence ledger
 * binds for each runtime projection.
 *
 * `repo_projection` observations prove that a claim was derived from specific
 * repository sources by pinning their SHA-256. That makes the pin correct and
 * also makes it perishable: any edit to `setup.mjs`, `scripts/sync-runtimes.mjs`,
 * or `scripts/runtime-hook-mapping.mjs` invalidates the ledger, and every global
 * sync then exits non-zero. Re-recording is therefore an explicit maintainer
 * action, run after the source change is intended — never a silent read-time
 * fallback, which would destroy the evidence value of the pin.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  digestRepositorySource,
  repositorySourcePath,
  validateRuntimeEvidenceLedger,
} from "./runtime-capability-evidence.mjs";

export const REPO_PROJECTION_LEDGER_PATH = "config/runtime-capability-evidence.json";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Roll every review freshness binding in the ledger to an explicit date.
 *
 * The freshness gates added in 3.0.9 (conservative_review observations and
 * reviewState.lastReviewedAt) expire after `staleAfterDays` (default 30), so a
 * healthy ledger still starts failing every validation until a human re-reviews
 * the projection sources and re-dates the ledger. Doing that by hand means
 * editing scattered dates across `matrix.lastReviewedAt`, each capability row's
 * `reviewState`, and every `conservative_review` observation — easy to miss one.
 *
 * Like the digest recorder, this is an explicit maintainer action, never a
 * silent read-time fallback: the mandatory `--rationale` names what the
 * re-review actually checked, and a future date is refused.
 */
export function rollConservativeReviews(ledger, { date, rationale }) {
  if (!ISO_DATE_RE.test(String(date ?? ""))) {
    throw new Error(`--date must be YYYY-MM-DD, got: ${JSON.stringify(date)}`);
  }
  const rolled = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(rolled.getTime()) || rolled.toISOString().slice(0, 10) !== date) {
    throw new Error(`--date is not a real calendar date: ${date}`);
  }
  if (rolled.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
    throw new Error(`--date is in the future: ${date}`);
  }
  if (!rationale || !rationale.trim() || rationale.trim().length < 8) {
    throw new Error(
      "--rationale is required (>= 8 chars) and must name what the re-review actually checked",
    );
  }

  const next = structuredClone(ledger);
  const updates = [];
  const touched = (id, field, from) => {
    if (from !== date) updates.push({ id, field, from: from ?? null, to: date });
  };

  if (next.matrix?.lastReviewedAt !== undefined) {
    touched("matrix", "lastReviewedAt", next.matrix.lastReviewedAt);
    next.matrix.lastReviewedAt = date;
  }

  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    if (!node || typeof node !== "object") return;
    const review = node.reviewState;
    if (review && typeof review === "object") {
      touched(node.id ?? "(row)", "reviewState.lastReviewedAt", review.lastReviewedAt);
      review.lastReviewedAt = date;
      review.rationale = rationale.trim();
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(next.matrix ?? {});

  for (const observation of next.observations ?? []) {
    if (observation?.observationClass !== "conservative_review") continue;
    touched(observation.id, "observedAt", observation.observedAt);
    observation.observedAt = date;
  }

  return { ledger: next, updates };
}

export function recordRepoProjectionDigests(ledger) {
  const next = structuredClone(ledger);
  const updates = [];

  for (const observation of next.observations ?? []) {
    if (observation?.observationClass !== "repo_projection") continue;
    const artifacts = Array.isArray(observation.sourceArtifacts) ? [...observation.sourceArtifacts] : [];

    for (const ref of observation.sourceRefs ?? []) {
      const sourcePath = repositorySourcePath(ref);
      if (!sourcePath) {
        throw new Error(
          `${observation.id} names a projection source outside the repository evidence allowlist: ${ref}`,
        );
      }
      const sha256 = digestRepositorySource(sourcePath).toLowerCase();
      const index = artifacts.findIndex((entry) => entry?.path === ref);
      const existing = index >= 0 ? artifacts[index] : null;
      if (existing?.sha256?.toLowerCase() === sha256 && existing.digestKind === "sha256") continue;

      updates.push({
        observationId: observation.id,
        path: ref,
        from: existing?.sha256 ?? null,
        to: sha256,
      });
      const recorded = { path: ref, digestKind: "sha256", sha256 };
      if (index >= 0) artifacts[index] = { ...existing, ...recorded };
      else artifacts.push(recorded);
    }

    observation.sourceArtifacts = artifacts;
  }

  return { ledger: next, updates };
}

// The ledger keeps each digest binding on one line so a reviewer sees exactly
// which hash moved. `JSON.stringify` would expand every binding to four lines and
// bury eight real changes under fifty formatting ones. A binding this pattern
// does not recognize simply stays expanded, so the worst case is noise.
function collapseDigestBindings(json) {
  return json.replace(
    /\{\n\s+"path": ("(?:[^"\\]|\\.)*"),\n\s+"digestKind": ("(?:[^"\\]|\\.)*"),\n\s+"sha256": ("(?:[^"\\]|\\.)*")\n\s+\}/gu,
    (_binding, sourcePath, digestKind, sha256) =>
      `{ "path": ${sourcePath}, "digestKind": ${digestKind}, "sha256": ${sha256} }`,
  );
}

function main(argv) {
  const checkOnly = argv.includes("--check");
  const rollReview = argv.includes("--roll-review");
  const ledgerPath = path.join(REPO_ROOT, REPO_PROJECTION_LEDGER_PATH);
  const source = readFileSync(ledgerPath, "utf8");

  if (rollReview) {
    const value = (name) => {
      const equals = argv.find((entry) => entry.startsWith(`${name}=`));
      if (equals) return equals.slice(name.length + 1);
      const index = argv.indexOf(name);
      return index >= 0 ? argv[index + 1] : undefined;
    };
    const date = value("--date") ?? new Date().toISOString().slice(0, 10);
    const rationale = value("--rationale");
    let rolled;
    try {
      rolled = rollConservativeReviews(JSON.parse(source), { date, rationale });
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    const trailingNewline = source.endsWith("\n") ? "\n" : "";
    const rendered = `${collapseDigestBindings(JSON.stringify(rolled.ledger, null, 2))}${trailingNewline}`;
    for (const update of rolled.updates) {
      process.stdout.write(`${update.id} ${update.field}: ${update.from ?? "absent"} -> ${update.to}\n`);
    }
    if (rendered === source) {
      process.stdout.write(`review bindings already rolled to ${date} (${REPO_PROJECTION_LEDGER_PATH})\n`);
      return 0;
    }
    const { issues } = validateRuntimeEvidenceLedger(rolled.ledger);
    if (issues.length > 0) {
      process.stderr.write(`ledger still invalid after rolling reviews:\n- ${issues.join("\n- ")}\n`);
      return 1;
    }
    writeFileSync(ledgerPath, rendered);
    process.stdout.write(`rolled ${rolled.updates.length} review binding(s) to ${date}\n`);
    return 0;
  }

  const { ledger, updates } = recordRepoProjectionDigests(JSON.parse(source));
  const trailingNewline = source.endsWith("\n") ? "\n" : "";
  const rendered = `${collapseDigestBindings(JSON.stringify(ledger, null, 2))}${trailingNewline}`;

  for (const update of updates) {
    const from = update.from ? `${update.from.slice(0, 12)}…` : "absent";
    process.stdout.write(`${update.observationId} ${update.path}: ${from} -> ${update.to.slice(0, 12)}…\n`);
  }

  if (checkOnly) {
    if (updates.length === 0) {
      process.stdout.write(`runtime capability evidence digests are current (${REPO_PROJECTION_LEDGER_PATH})\n`);
      return 0;
    }
    process.stderr.write(`${updates.length} projection digest(s) are stale; run npm run meta:runtime:evidence:record\n`);
    return 1;
  }

  if (rendered === source) {
    process.stdout.write(`runtime capability evidence digests are current (${REPO_PROJECTION_LEDGER_PATH})\n`);
    return 0;
  }

  // Re-recording repairs digests only. Anything else wrong with the ledger must
  // stay failing rather than be written over by this tool.
  const { issues } = validateRuntimeEvidenceLedger(ledger);
  if (issues.length > 0) {
    process.stderr.write(`ledger still invalid after re-recording digests:\n- ${issues.join("\n- ")}\n`);
    return 1;
  }

  writeFileSync(ledgerPath, rendered);
  process.stdout.write(`recorded ${updates.length} projection digest(s)\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
