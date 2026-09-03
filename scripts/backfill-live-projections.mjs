#!/usr/bin/env node
/**
 * Explicit entry point for rebuilding compact live projections.
 *
 * A projection is a pure fold of its governed-execution artifact, so a file written
 * before the builder learned a field keeps serving the old shape forever — the panel
 * shows a run as missing data that its artifact has always carried. Rebuilding is a
 * housekeeping operation the user asks for, never an install or update side effect.
 *
 * Reporting is the default. A pass only writes when `--apply` is passed, and even
 * then the bytes it replaces go to a reversible backup batch whose restore path is
 * printed.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  applyLiveProjectionBackfill,
  planLiveProjectionBackfill,
} from "../src/infrastructure/live/live-projection-backfill.mjs";

const args = process.argv.slice(2);

function optionValue(flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  return typeof value === "string" && !value.startsWith("--") ? value : null;
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node scripts/backfill-live-projections.mjs [options]

Rebuilds compact live projections under .meta-kim/state/<profile>/governed-executions/
from the governed-execution artifacts they were folded from, so a projection written
by an older builder stops serving a shape the artifact no longer matches.

Options:
  --project <dir>    Project root to scan (default: current directory)
  --profile <name>   State profile (default: default)
  --policy <file>    Policy file (default: config/live/projection-backfill.json)
  --max-runs <n>     Narrow the pass below the policy bound
  --apply            Rewrite stale projections
  --json             Print the machine-readable plan or result
  -h, --help         Show this message

Without --apply nothing is written; the pass only reports what it would rebuild.
Artifacts are inputs and are never written. A projection whose artifact is missing
or unreadable is reported and left in place — it is never rebuilt from a guess and
never deleted. The pointer's projection digest is refreshed only when it already
names the file that was rebuilt, so the reader keeps serving the projection instead
of silently falling back to the raw artifact.
Policy lives in config/live/projection-backfill.json.`);
  process.exit(0);
}

function positiveIntegerOption(flag) {
  const value = optionValue(flag);
  if (value === null) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.error(`${flag} expects a positive integer, received ${value}`);
    process.exit(2);
  }
  return parsed;
}

const projectRoot = path.resolve(optionValue("--project") ?? process.cwd());
const policyFile = optionValue("--policy");
const profile = optionValue("--profile") ?? undefined;
const maxRuns = positiveIntegerOption("--max-runs");
const apply = args.includes("--apply");

let plan;
try {
  plan = await planLiveProjectionBackfill({
    projectRoot,
    profile,
    maxRuns,
    configUrl: policyFile ? pathToFileURL(path.resolve(policyFile)) : undefined,
  });
} catch (error) {
  // An unresolvable root would otherwise surface as an empty plan, which reads
  // exactly like "every projection is already current".
  if (error?.code === "LIVE_PROJECTION_BACKFILL_NO_PROJECT_ROOT") {
    console.error(`${projectRoot} is not a Meta_Kim project root; nothing was scanned.`);
    process.exit(2);
  }
  throw error;
}

const result = apply ? await applyLiveProjectionBackfill(plan) : null;

if (args.includes("--json")) {
  console.log(JSON.stringify(apply ? { plan, result } : plan, null, 2));
} else {
  const { counts, entries, candidateRunCount, omittedRunCount } = plan;
  console.log(
    `profile ${plan.profile} · scanned ${entries.length} of ${candidateRunCount} projection(s)`,
  );
  console.log(
    `needs backfill ${counts.needs_backfill} · up to date ${counts.up_to_date} · artifact missing ${counts.artifact_missing} · artifact unreadable ${counts.artifact_unreadable} · projection unreadable ${counts.projection_unreadable} · rebuild failed ${counts.rebuild_failed}`,
  );
  if (omittedRunCount > 0) {
    console.log(
      `${omittedRunCount} projection(s) were left out of this pass by the run bound; rerun to continue`,
    );
  }
  for (const entry of entries) {
    if (entry.status !== "needs_backfill") continue;
    const changes = [
      entry.addedKeys.length > 0 ? `+${entry.addedKeys.join(",")}` : null,
      entry.removedKeys.length > 0 ? `-${entry.removedKeys.join(",")}` : null,
      entry.changedKeys.length > 0 ? `~${entry.changedKeys.join(",")}` : null,
    ].filter(Boolean);
    console.log(
      `  ${entry.runId}${entry.isPointerTarget ? " (serving now)" : ""} ${changes.join(" ") || "byte differences only"}`,
    );
  }
  for (const entry of entries) {
    if (entry.status === "needs_backfill" || entry.status === "up_to_date") continue;
    console.log(`  ${entry.runId} ${entry.status}: ${entry.error} — left in place`);
  }

  if (!apply) {
    console.log("reported only; rerun with --apply to rebuild the stale projections");
  } else {
    console.log(`rebuilt ${result.applied} projection(s)`);
    if (result.restoreFrom) {
      console.log(`replaced bytes saved to ${result.restoreFrom}`);
    }
    for (const written of result.written) {
      if (written.pointerOutcome === "pointer_updated") {
        console.log(`  ${written.runId}: pointer digest refreshed`);
      }
    }
    if (result.prunedBackupBatches.length > 0) {
      console.log(
        `dropped ${result.prunedBackupBatches.length} backup batch(es) beyond the retained-pass count`,
      );
    }
    console.log(result.ownershipBoundary);
    for (const entry of result.failed) {
      console.error(`failed ${entry.runId}: ${entry.reason}`);
    }
  }
}

process.exitCode = result && result.failed.length > 0 ? 1 : 0;
