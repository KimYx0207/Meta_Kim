#!/usr/bin/env node

/**
 * Official maintainer command to refresh the `repo_projection` SHA-256 pins in
 * the runtime capability evidence ledger (issue #61).
 *
 * `repo_projection` observations pin the exact bytes of the repository sources
 * that justify each runtime projection claim. Those pins are deliberately
 * perishable: editing `setup.mjs`, `scripts/sync-runtimes.mjs`,
 * `scripts/runtime-hook-mapping.mjs`, or the canonical runtime assets
 * invalidates the ledger until the pins are refreshed as an explicit
 * maintainer action. This command is that action.
 *
 * Modes:
 *   node scripts/refresh-runtime-evidence-pins.mjs           repair and write
 *   node scripts/refresh-runtime-evidence-pins.mjs --check   report only;
 *                                                             exit 1 on drift
 *   --file <path>   operate on an explicit ledger file instead of
 *                   config/runtime-capability-evidence.json (used by tests)
 *
 * The ledger is never rewritten speculatively: malformed JSON, missing
 * observations, unknown digest kinds, and pinned sources outside the
 * repository evidence allowlist all fail closed with no write. Writes are
 * atomic (temp file + rename with transient-lock retry), preserve non-pin
 * fields structurally, and render the ledger in the repository's standard format.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  digestRepositorySource,
  repositorySourcePath,
} from "./runtime-capability-evidence.mjs";
import { renameWithTransientRetry } from "./transient-rename.mjs";

export const RUNTIME_CAPABILITY_EVIDENCE_PATH =
  "config/runtime-capability-evidence.json";
export const REFRESH_PINS_SCRIPT = "scripts/refresh-runtime-evidence-pins.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Recompute every repo_projection pin from the current working-tree sources.
 * Returns the next ledger plus a change list of
 * { observationId, path, from, to } for every pin that moved. Every other
 * observation class and every other field stays structurally untouched.
 */
export function refreshRuntimeEvidencePins(ledger) {
  if (!ledger || typeof ledger !== "object" || !Array.isArray(ledger.observations)) {
    throw new Error("runtime capability evidence must be an object with an observations array");
  }
  const next = structuredClone(ledger);
  const changes = [];
  for (const observation of next.observations) {
    if (observation?.observationClass !== "repo_projection") continue;
    const observationId = observation.id ?? "<unknown observation>";
    if (!Array.isArray(observation.sourceArtifacts)) {
      throw new Error(`${observationId} repo_projection observation must declare a sourceArtifacts array`);
    }
    for (const artifact of observation.sourceArtifacts) {
      if (!artifact || typeof artifact.path !== "string" || artifact.path.length === 0) {
        throw new Error(`${observationId} has a sourceArtifacts entry without a path`);
      }
      if (artifact.digestKind !== "sha256") {
        throw new Error(
          `${observationId} pins ${artifact.path} with unsupported digestKind ${JSON.stringify(artifact.digestKind ?? null)}`,
        );
      }
      const sourcePath = repositorySourcePath(artifact.path);
      if (!sourcePath) {
        throw new Error(`${observationId} pins a source outside the repository evidence allowlist: ${artifact.path}`);
      }
      const sha256 = digestRepositorySource(sourcePath).toLowerCase();
      const previous = typeof artifact.sha256 === "string"
        ? artifact.sha256.toLowerCase()
        : null;
      if (previous === sha256) continue;
      changes.push({ observationId, path: artifact.path, from: previous, to: sha256 });
      artifact.sha256 = sha256;
    }
  }
  return { ledger: next, changes };
}

// The ledger keeps each digest binding on one line so a reviewer sees exactly
// which hash moved; `JSON.stringify` alone would expand every binding to four
// lines and bury real changes under formatting ones. This mirrors the
// rendering convention of scripts/record-runtime-capability-evidence.mjs.
export function renderRuntimeEvidenceLedger(ledger, { trailingNewline = true } = {}) {
  const rendered = JSON.stringify(ledger, null, 2).replace(
    /\{\n\s+"path": ("(?:[^"\\]|\\.)*"),\n\s+"digestKind": ("(?:[^"\\]|\\.)*"),\n\s+"sha256": ("(?:[^"\\]|\\.)*")\n\s+\}/gu,
    (_binding, sourcePath, digestKind, sha256) =>
      `{ "path": ${sourcePath}, "digestKind": ${digestKind}, "sha256": ${sha256} }`,
  );
  return trailingNewline ? `${rendered}\n` : rendered;
}

function writeLedgerAtomically(ledgerPath, rendered) {
  const temporary = path.join(
    path.dirname(ledgerPath),
    `.${path.basename(ledgerPath)}.${randomUUID()}.tmp`,
  );
  writeFileSync(temporary, rendered, "utf8");
  try {
    renameWithTransientRetry(temporary, ledgerPath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function main(argv = []) {
  const checkOnly = argv.includes("--check");
  const fileIndex = argv.indexOf("--file");
  const ledgerPath = fileIndex >= 0 && argv[fileIndex + 1]
    ? path.resolve(argv[fileIndex + 1])
    : path.join(REPO_ROOT, RUNTIME_CAPABILITY_EVIDENCE_PATH);

  let source;
  try {
    source = readFileSync(ledgerPath, "utf8");
  } catch (error) {
    process.stderr.write(`runtime capability evidence is unavailable (${ledgerPath}): ${error.code ?? error.message}\nNothing was written.\n`);
    return 1;
  }
  let ledger;
  try {
    ledger = JSON.parse(source);
  } catch (error) {
    process.stderr.write(`${ledgerPath} is not valid JSON: ${error.message}\nNothing was written.\n`);
    return 1;
  }

  let refreshed;
  try {
    refreshed = refreshRuntimeEvidencePins(ledger);
  } catch (error) {
    process.stderr.write(`${error.message}\nNothing was written.\n`);
    return 1;
  }

  if (refreshed.changes.length === 0) {
    process.stdout.write(`runtime capability evidence repo_projection pins are current (${ledgerPath})\n`);
    return 0;
  }

  for (const change of refreshed.changes) {
    process.stdout.write(`${change.observationId}  ${change.path}  ${change.from ?? "(absent)"} -> ${change.to}\n`);
  }
  if (checkOnly) {
    process.stderr.write(`${refreshed.changes.length} repo_projection pin(s) drifted; run npm run meta:runtime:evidence:refresh-pins\n`);
    return 1;
  }

  writeLedgerAtomically(ledgerPath, renderRuntimeEvidenceLedger(refreshed.ledger, {
    trailingNewline: source.endsWith("\n"),
  }));
  process.stdout.write(`refreshed ${refreshed.changes.length} repo_projection pin(s) in ${ledgerPath}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
