/**
 * Wait budgets for the Meta_Kim Live singleton hub.
 *
 * The hub is spawned as a detached child that indexes every governed run
 * artifact before it publishes its state file, so the time-to-ready is a
 * property of the project and the machine rather than a constant the launcher
 * can know in advance. Three consecutive fresh starts on a 256-run project took
 * 2175ms, 2368ms and 4175ms.
 *
 * An earlier series on the same project read 5889ms to 15574ms and is what first
 * moved this fuse out of code. Those samples timed the launcher rather than the
 * child: each 75ms poll then ran a Windows process creation-time query costing
 * 1867-5020ms, so a hub that was ready at two seconds went unnoticed for several
 * more and the 5000ms budget then in force reported `startup_timeout`. They are
 * kept here as the reason the fuse is configurable, not as a bound on the child.
 *
 * A generous ceiling is safe: a child that dies is detected from its exit code,
 * not from this budget, so raising the ceiling delays nothing in the failure
 * case. It only bounds how long a *live but slow* child is given.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LIVE_HUB_LIFECYCLE_SCHEMA_VERSION = "meta-kim-live-hub-lifecycle-v1";

export const LIVE_HUB_LIFECYCLE_CONFIG_URL = new URL(
  "../../../config/live/hub-lifecycle.json",
  import.meta.url,
);

function fail(message, code = "LIVE_HUB_LIFECYCLE_INVALID") {
  const error = new TypeError(`Live hub lifecycle: ${message}`);
  error.code = code;
  throw error;
}

function budgetMs(value, label) {
  if (!Number.isInteger(value) || value <= 0) fail(`${label} must be a positive integer of milliseconds`);
  if (value > 600_000) fail(`${label} must stay under ten minutes; a launcher that never gives up is a hang`);
  return value;
}

/** Validate and freeze a raw hub-lifecycle document. */
export function normalizeLiveHubLifecycleBudget(raw) {
  if (!raw || typeof raw !== "object") fail("document must be an object");
  if (raw.schemaVersion !== LIVE_HUB_LIFECYCLE_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${LIVE_HUB_LIFECYCLE_SCHEMA_VERSION}`, "LIVE_HUB_LIFECYCLE_SCHEMA_MISMATCH");
  }
  const startupBudgetMs = budgetMs(raw.startupBudgetMs, "startupBudgetMs");
  const hookAutostartBudgetMs = budgetMs(raw.hookAutostartBudgetMs, "hookAutostartBudgetMs");
  const stopBudgetMs = budgetMs(raw.stopBudgetMs, "stopBudgetMs");
  // Stopping waits for a process to exit; starting waits for it to finish
  // indexing. A stop budget that exceeds the start budget means a restart
  // spends longer tearing the old hub down than bringing the new one up, which
  // reads to the user as a hang with no output.
  if (stopBudgetMs > startupBudgetMs) {
    fail("stopBudgetMs must not exceed startupBudgetMs", "LIVE_HUB_LIFECYCLE_BUDGETS_INVERTED");
  }
  // The hook starts the hub opportunistically alongside a governed run, so its
  // fuse must stay shorter than the budget granted to an explicit request.
  if (hookAutostartBudgetMs > startupBudgetMs) {
    fail("hookAutostartBudgetMs must not exceed startupBudgetMs", "LIVE_HUB_LIFECYCLE_BUDGETS_INVERTED");
  }
  return Object.freeze({
    schemaVersion: raw.schemaVersion,
    startupBudgetMs,
    hookAutostartBudgetMs,
    stopBudgetMs,
  });
}

/** Read and validate the shipped hub-lifecycle document. */
export function loadLiveHubLifecycleBudget(configUrl = LIVE_HUB_LIFECYCLE_CONFIG_URL) {
  const filePath = fileURLToPath(configUrl);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`cannot read ${filePath}: ${error.message}`, "LIVE_HUB_LIFECYCLE_UNREADABLE");
  }
  return normalizeLiveHubLifecycleBudget(parsed);
}
