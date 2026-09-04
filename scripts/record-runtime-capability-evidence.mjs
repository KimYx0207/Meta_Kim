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
  const ledgerPath = path.join(REPO_ROOT, REPO_PROJECTION_LEDGER_PATH);
  const source = readFileSync(ledgerPath, "utf8");
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
