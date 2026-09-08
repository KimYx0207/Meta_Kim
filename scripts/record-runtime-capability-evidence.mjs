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
  validateRuntimeCapabilityClaims,
  validateRuntimeEvidenceLedger,
} from "./runtime-capability-evidence.mjs";

export const REPO_PROJECTION_LEDGER_PATH = "config/runtime-capability-evidence.json";
export const RUNTIME_CAPABILITY_MATRIX_PATH = "config/runtime-capability-matrix.json";
const MATRIX_PATH = RUNTIME_CAPABILITY_MATRIX_PATH;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Roll every review freshness binding to an explicit date, across BOTH real
 * config files the 3.0.9 freshness gates read:
 *
 * - config/runtime-capability-matrix.json: `matrix.lastReviewedAt` and each
 *   capability row's `reviewState.lastReviewedAt` (validated at
 *   runtime-capability-evidence.mjs:372 and :426)
 * - config/runtime-capability-evidence.json: every `conservative_review`
 *   observation's `observedAt` (validated at :435)
 *
 * Rolling only one file leaves the other half of the staleness issues red —
 * the matrix carries the large majority of the bindings.
 *
 * Per-row `rationale` values are preserved: each capability row records why it
 * was judged conservative, and a single blanket sentence must not overwrite
 * 120 distinct rationales. The mandatory `--rationale` (the maintainer's
 * statement of what this re-review actually checked) is only filled into rows
 * whose rationale is missing or blank.
 *
 * Like the digest recorder, this is an explicit maintainer action, never a
 * silent read-time fallback. A future or non-calendar date is refused.
 */
export function rollReviewFreshness({ matrix, ledger }, { date, rationale, now }) {
  if (!ISO_DATE_RE.test(String(date ?? ""))) {
    throw new Error(`--date must be YYYY-MM-DD, got: ${JSON.stringify(date)}`);
  }
  const rolled = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(rolled.getTime()) || rolled.toISOString().slice(0, 10) !== date) {
    throw new Error(`--date is not a real calendar date: ${date}`);
  }
  const nowMs = now ? Date.parse(now) : Date.now();
  if (Number.isNaN(nowMs)) throw new Error(`--now is not an ISO timestamp: ${now}`);
  if (rolled.getTime() > nowMs + 24 * 60 * 60 * 1000) {
    throw new Error(`--date is in the future: ${date}`);
  }
  const cleanRationale = String(rationale ?? "").trim();
  if (cleanRationale.length < 8) {
    throw new Error(
      "--rationale is required (>= 8 chars) and must name what the re-review actually checked",
    );
  }

  const updates = [];

  const nextMatrix = structuredClone(matrix);
  if (!nextMatrix || typeof nextMatrix !== "object") {
    throw new Error("matrix is required (config/runtime-capability-matrix.json)");
  }
  if (nextMatrix.lastReviewedAt !== undefined) {
    if (nextMatrix.lastReviewedAt !== date) {
      updates.push({
        file: MATRIX_PATH,
        id: "matrix",
        field: "lastReviewedAt",
        from: nextMatrix.lastReviewedAt ?? null,
        to: date,
      });
    }
    nextMatrix.lastReviewedAt = date;
  }
  const walkRows = (node) => {
    if (Array.isArray(node)) {
      for (const entry of node) walkRows(entry);
      return;
    }
    if (!node || typeof node !== "object") return;
    const review = node.reviewState;
    if (review && typeof review === "object") {
      if (review.lastReviewedAt !== date) {
        updates.push({
          file: MATRIX_PATH,
          id: node.id ?? node.capability ?? "(row)",
          field: "reviewState.lastReviewedAt",
          from: review.lastReviewedAt ?? null,
          to: date,
        });
      }
      review.lastReviewedAt = date;
      if (!String(review.rationale ?? "").trim()) {
        review.rationale = cleanRationale;
      }
    }
    for (const value of Object.values(node)) walkRows(value);
  };
  walkRows(nextMatrix.platforms ?? {});

  if (!ledger || typeof ledger !== "object" || !Array.isArray(ledger.observations)) {
    throw new Error("ledger is required (config/runtime-capability-evidence.json)");
  }
  const nextLedger = structuredClone(ledger);
  for (const observation of nextLedger.observations) {
    if (observation?.observationClass !== "conservative_review") continue;
    if (observation.observedAt !== date) {
      updates.push({
        file: REPO_PROJECTION_LEDGER_PATH,
        id: observation.id,
        field: "observedAt",
        from: observation.observedAt ?? null,
        to: date,
      });
    }
    observation.observedAt = date;
  }

  return { matrix: nextMatrix, ledger: nextLedger, updates };
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
    const matrixPath = path.join(REPO_ROOT, RUNTIME_CAPABILITY_MATRIX_PATH);
    let pair;
    try {
      pair = {
        matrix: JSON.parse(readFileSync(matrixPath, "utf8")),
        ledger: JSON.parse(source),
      };
      pair = rollReviewFreshness(pair, { date, rationale });
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    const trailingNewline = source.endsWith("\n") ? "\n" : "";
    const renderedLedger = `${collapseDigestBindings(JSON.stringify(pair.ledger, null, 2))}${trailingNewline}`;
    const renderedMatrix = `${JSON.stringify(pair.matrix, null, 2)}\n`;
    for (const update of pair.updates) {
      const from = update.from ?? "absent";
      process.stdout.write(`${update.file} ${update.id} ${update.field}: ${from} -> ${update.to}\n`);
    }
    // Rolling reviews repairs freshness only; any other ledger/matrix problem
    // must stay failing rather than be written over by this tool.
    const { issues } = validateRuntimeCapabilityClaims(pair.matrix, pair.ledger);
    const freshnessIssues = issues.filter(
      (issue) =>
        issue.includes("must be current, non-future, and fresh") ||
        issue.includes("must bind fresh conservative_review evidence") ||
        issue.includes("reviewState must be fresh, non-future, and explicit"),
    );
    if (issues.length > 0) {
      process.stderr.write(
        `ledger/matrix still invalid after rolling reviews:\n- ${issues.join("\n- ")}\n`,
      );
      return 1;
    }
    if (freshnessIssues.length > 0) {
      process.stderr.write(
        `freshness issues survived the roll; refusing to write:\n- ${freshnessIssues.join("\n- ")}\n`,
      );
      return 1;
    }
    if (renderedLedger !== source) writeFileSync(ledgerPath, renderedLedger);
    const matrixSource = readFileSync(matrixPath, "utf8");
    if (renderedMatrix !== matrixSource) writeFileSync(matrixPath, renderedMatrix);
    process.stdout.write(
      `rolled ${pair.updates.length} review binding(s) to ${date} across ${RUNTIME_CAPABILITY_MATRIX_PATH} and ${REPO_PROJECTION_LEDGER_PATH}\n`,
    );
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
