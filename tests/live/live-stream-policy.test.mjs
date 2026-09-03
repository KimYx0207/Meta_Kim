import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_STREAM_POLICY_SCHEMA_VERSION,
  loadLiveStreamPolicy,
  normalizeLiveStreamPolicy,
  serializeLiveStreamPolicyForClient,
} from "../../src/application/live/live-stream-policy.mjs";
import { renderLiveControlRoomPage } from "../../src/presentation/live/live-control-room-page.mjs";

function clientScriptOf(html) {
  const start = html.lastIndexOf("<script>");
  const end = html.indexOf("</script>", start);
  assert.ok(start >= 0 && end > start, "rendered page must contain a client script");
  return html.slice(start + "<script>".length, end);
}

test("the shipped stream-policy document validates and orders its two waits", () => {
  const policy = loadLiveStreamPolicy();

  assert.equal(policy.schemaVersion, LIVE_STREAM_POLICY_SCHEMA_VERSION);
  assert.ok(policy.snapshotRequestTimeoutMs > 0, "a request with no timeout is the spinner that never ends");
  assert.ok(policy.hiddenSuspendGraceMs >= 0);

  // The ordering is the whole mechanism, not a tidy coincidence. A hidden tab
  // releases its stream after the grace period; a visible tab gives up on its
  // snapshot after the timeout. If the grace were the longer of the two, the
  // visible tab would report a saturated origin while the tabs that saturated it
  // were still holding their sockets, so the report would be true and useless.
  assert.ok(
    policy.hiddenSuspendGraceMs < policy.snapshotRequestTimeoutMs,
    "a hidden tab must release its connection before a visible tab gives up waiting for one",
  );
});

test("an unordered or missing wait is unrepresentable", () => {
  const base = loadLiveStreamPolicy();

  for (const broken of [undefined, 0, -1, "8000", Number.NaN]) {
    assert.throws(
      () => normalizeLiveStreamPolicy({ ...base, snapshotRequestTimeoutMs: broken }),
      /snapshotRequestTimeoutMs must be a positive number/u,
      `snapshotRequestTimeoutMs ${String(broken)} must be rejected`,
    );
  }
  for (const broken of [undefined, -1, "0", Number.NaN]) {
    assert.throws(
      () => normalizeLiveStreamPolicy({ ...base, hiddenSuspendGraceMs: broken }),
      /hiddenSuspendGraceMs must be a non-negative number/u,
      `hiddenSuspendGraceMs ${String(broken)} must be rejected`,
    );
  }
  assert.throws(
    () => normalizeLiveStreamPolicy({ ...base, hiddenSuspendGraceMs: base.snapshotRequestTimeoutMs }),
    (error) => error.code === "LIVE_STREAM_POLICY_GRACE_NOT_SHORTER",
  );
});

test("the client takes both waits from config instead of carrying its own", () => {
  const html = renderLiveControlRoomPage();
  const script = clientScriptOf(html);
  const policy = loadLiveStreamPolicy();

  assert.ok(
    script.includes(JSON.stringify(serializeLiveStreamPolicyForClient(policy))),
    "the stream policy literal must come from config",
  );
  assert.match(script, /STREAM_POLICY\.snapshotRequestTimeoutMs/u);
  assert.match(script, /STREAM_POLICY\.hiddenSuspendGraceMs/u);
});

test("the snapshot request is bounded, and a timeout is told apart from a superseded request", () => {
  const script = clientScriptOf(renderLiveControlRoomPage());

  // Both paths abort the same controller, so `AbortError` alone cannot tell them
  // apart. The superseded path must stay silent -- a newer selection is already
  // rendering -- while the timeout path must replace the loading copy. Sharing
  // one branch is how the page came to sit on "Loading the selected run..."
  // forever: the fetch was starved, nothing threw, and nothing ever repainted.
  assert.match(
    script,
    /setTimeout\(\(\) => \{\s*snapshotTimedOut = true;\s*\w+\.abort\(\);\s*\}, STREAM_POLICY\.snapshotRequestTimeoutMs\)/u,
    "the snapshot fetch must arm an abort from the configured timeout",
  );
  const timeoutBranch = script.match(/if \(snapshotTimedOut\)[\s\S]{0,900}?if \(error\?\.name === "AbortError"\) return;/u);
  assert.ok(timeoutBranch, "the timeout branch must be checked before the silent superseded-request return");
  assert.match(script, /clearTimeout\(snapshotRequestTimer\)/u, "the timer must be cleared on every exit");
});

test("a starved origin is reported in both locales instead of rendering as a spinner", () => {
  const html = renderLiveControlRoomPage();
  const script = clientScriptOf(html);

  assert.match(script, /"The snapshot request timed out\./u);
  assert.match(
    script,
    /"The snapshot request timed out[^"]*":\s*"快照请求超时/u,
    "the timeout copy must be translated, or the Chinese page falls back to English silently",
  );
});

test("a hidden tab releases the connection it is not reading", () => {
  const script = clientScriptOf(renderLiveControlRoomPage());

  // Six background tabs holding six streams starve the seventh page's snapshot
  // fetch, because the six-per-origin connection limit counts the streams too.
  // Suspending a stream nobody is watching is what makes a newly opened control
  // room able to load at all.
  assert.match(script, /addEventListener\("visibilitychange"/u);
  assert.match(
    script,
    /setTimeout\(\(\) => \{[\s\S]{0,300}if \(!document\.hidden\) return;\s*disconnectEvents\(\);[\s\S]{0,200}\}, STREAM_POLICY\.hiddenSuspendGraceMs\)/u,
    "the stream must be dropped only after the grace period and only while still hidden",
  );
  // What happens on the way back — reconnect, refresh, and catch the run list up
  // — is asserted by running the handler in live-visibility-resume.test.mjs. A
  // second copy of that expectation as source text here would pass against any
  // rearrangement of the same line and fail against a harmless one.
});
