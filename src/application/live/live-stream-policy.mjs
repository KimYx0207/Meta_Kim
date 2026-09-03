/**
 * How long the Live control room waits on the network, and how long a hidden tab
 * keeps its event stream.
 *
 * A browser permits roughly six simultaneous connections per origin, and a
 * Server-Sent Events stream occupies one for the lifetime of the tab. Several
 * control room tabs therefore consume the whole allowance, and the next page's
 * snapshot `fetch` is queued rather than refused: it does not fail, so no error
 * handler runs, so the page keeps showing "Loading the selected run..." with no
 * expiry. Measured on this machine, the same request answered in 13ms from Node
 * while the browser reported a duration above 100 seconds.
 *
 * Neither half of the fix works alone. A timeout without the suspend turns a
 * hang into an honest message that never resolves, because the tabs holding the
 * connections never let go. A suspend without the timeout leaves the reader
 * watching a spinner during the grace period with nothing on screen that says
 * why. `normalizeLiveStreamPolicy` therefore also rejects a grace that is not
 * shorter than the timeout, which is the ordering that makes the pair work.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LIVE_STREAM_POLICY_SCHEMA_VERSION = "meta-kim-live-stream-policy-v1";

export const LIVE_STREAM_POLICY_CONFIG_URL = new URL(
  "../../../config/live/stream-policy.json",
  import.meta.url,
);

function fail(message, code = "LIVE_STREAM_POLICY_INVALID") {
  const error = new TypeError(`Live stream policy: ${message}`);
  error.code = code;
  throw error;
}

function positiveNumber(value, label) {
  if (!Number.isFinite(value) || value <= 0) fail(`${label} must be a positive number`);
  return value;
}

function nonNegativeNumber(value, label) {
  if (!Number.isFinite(value) || value < 0) fail(`${label} must be a non-negative number`);
  return value;
}

/** Validate and freeze a raw stream-policy document. */
export function normalizeLiveStreamPolicy(raw) {
  if (!raw || typeof raw !== "object") fail("document must be an object");
  if (raw.schemaVersion !== LIVE_STREAM_POLICY_SCHEMA_VERSION) {
    fail(
      `schemaVersion must be ${LIVE_STREAM_POLICY_SCHEMA_VERSION}`,
      "LIVE_STREAM_POLICY_SCHEMA_MISMATCH",
    );
  }
  const snapshotRequestTimeoutMs = positiveNumber(
    raw.snapshotRequestTimeoutMs,
    "snapshotRequestTimeoutMs",
  );
  const hiddenSuspendGraceMs = nonNegativeNumber(raw.hiddenSuspendGraceMs, "hiddenSuspendGraceMs");
  if (hiddenSuspendGraceMs >= snapshotRequestTimeoutMs) {
    fail(
      `hiddenSuspendGraceMs ${hiddenSuspendGraceMs} must be shorter than snapshotRequestTimeoutMs `
        + `${snapshotRequestTimeoutMs}, or a waiting tab reports a saturated origin before the hidden `
        + "tabs holding it have released anything",
      "LIVE_STREAM_POLICY_GRACE_NOT_SHORTER",
    );
  }
  return Object.freeze({
    schemaVersion: raw.schemaVersion,
    snapshotRequestTimeoutMs,
    hiddenSuspendGraceMs,
  });
}

/** Read and validate the shipped stream-policy document. */
export function loadLiveStreamPolicy(configUrl = LIVE_STREAM_POLICY_CONFIG_URL) {
  const raw = JSON.parse(readFileSync(fileURLToPath(configUrl), "utf8"));
  return normalizeLiveStreamPolicy(raw);
}

/**
 * The two waits the inlined client script needs. The description and policy notes
 * stay on the server: they exist to be read by whoever changes the numbers, and
 * shipping them would put prose the reader never sees into every response.
 */
export function serializeLiveStreamPolicyForClient(policy) {
  return {
    snapshotRequestTimeoutMs: policy.snapshotRequestTimeoutMs,
    hiddenSuspendGraceMs: policy.hiddenSuspendGraceMs,
  };
}
