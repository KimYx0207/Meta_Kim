#!/usr/bin/env node
/**
 * Explicit entry point for governed-run directory compaction.
 *
 * `.meta-kim/state/<profile>/runs/` is user-owned project state, so compacting it
 * is a housekeeping operation the user asks for, never an install or update side
 * effect. Reporting is the default: a pass only moves records when `--apply` is
 * passed, and even then records go to a reversible backup batch whose restore
 * path is printed.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadLiveRunRetentionPolicy,
  normalizeLiveRunRetentionPolicy,
} from "../src/application/live/live-run-retention.mjs";
import { applyRunRetention } from "../src/infrastructure/live/live-run-retention-store.mjs";

const BACKUP_RETAINED_PASSES_CEILING = 100;
const DRAIN_PASS_LIMIT = 200;

const args = process.argv.slice(2);

function optionValue(flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  return typeof value === "string" && !value.startsWith("--") ? value : null;
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node scripts/compact-governed-runs.mjs [options]

Compacts activation-only governed-run records under .meta-kim/state/<profile>/runs/.
Runs that advanced a stage, recorded a worker, produced an artifact, or are the
active authority are protected regardless of age.

Options:
  --project <dir>   Project root to compact (default: current directory)
  --policy <file>   Retention policy file (default: config/live/run-retention.json)
  --apply           Move pruned records into a reversible backup batch
  --until-done      Repeat passes until nothing is left to prune (implies --apply)
  --json            Print the machine-readable result instead of a summary
  -h, --help        Show this message

Without --apply nothing is moved; the pass only reports what it would do.
A single pass is bounded by maxPrunePerPass. --until-done drains a backlog in one
command and retains every backup batch it creates, so the whole drain stays
reversible; delete .meta-kim/state/<profile>/retention-backups once satisfied.
Policy lives in config/live/run-retention.json.`);
  process.exit(0);
}

const projectRoot = path.resolve(optionValue("--project") ?? process.cwd());
const policyFile = optionValue("--policy");
const untilDone = args.includes("--until-done");
const apply = untilDone || args.includes("--apply");

const basePolicy = () =>
  policyFile
    ? loadLiveRunRetentionPolicy(pathToFileURL(path.resolve(policyFile)))
    : loadLiveRunRetentionPolicy();

/**
 * A drain runs several bounded passes back to back. The steady-state policy only
 * retains the newest few backup batches, which would silently discard the earliest
 * batches of the same drain, so a drain raises that retention to the schema
 * ceiling and reports where the batches are instead.
 */
const drainPolicy = () =>
  normalizeLiveRunRetentionPolicy({
    ...basePolicy(),
    backupRetainedPasses: BACKUP_RETAINED_PASSES_CEILING,
  });

const passPolicy = () => (untilDone ? drainPolicy() : basePolicy());

const passes = [];
let result = await applyRunRetention(projectRoot, { apply, policy: passPolicy() });
passes.push(result);

if (untilDone) {
  while (result.counts.prune > 0 && passes.length < DRAIN_PASS_LIMIT) {
    result = await applyRunRetention(projectRoot, { apply: true, policy: drainPolicy() });
    passes.push(result);
  }
}

const totals = passes.reduce(
  (acc, pass) => ({
    moved: acc.moved + pass.moved.length,
    failed: acc.failed + pass.failed.length,
  }),
  { moved: 0, failed: 0 },
);

if (args.includes("--json")) {
  console.log(JSON.stringify(untilDone ? { passes, totals } : result, null, 2));
} else {
  const { counts, scanned, profile } = result;
  console.log(`profile ${profile} · scanned ${scanned} run records · ${passes.length} pass(es)`);
  console.log(
    `prune ${counts.prune} · keep ${counts.keep} · protected ${counts.protected} · unclassified ${counts.unclassified} · deferred ${counts.deferred}`,
  );
  if (!apply) {
    console.log("reported only; rerun with --apply to move the pruned records");
  } else {
    console.log(`moved ${totals.moved} records to ${path.dirname(result.restoreFrom)}`);
    if (result.removedBackupBatches?.length > 0) {
      console.log(`dropped ${result.removedBackupBatches.length} backup batches beyond the retained-pass count`);
    }
  }
  for (const pass of passes) {
    for (const entry of pass.failed) console.error(`failed ${entry.runId}: ${entry.reason}`);
  }
  if (counts.deferred > 0) {
    console.log(
      `${counts.deferred} records were deferred by maxPrunePerPass; rerun, or use --until-done to drain in one command`,
    );
  }
  if (untilDone && passes.length >= DRAIN_PASS_LIMIT && counts.prune > 0) {
    console.error(`drain stopped at the ${DRAIN_PASS_LIMIT}-pass safety limit with ${counts.prune} still prunable`);
  }
}

process.exitCode = totals.failed > 0 ? 1 : 0;
