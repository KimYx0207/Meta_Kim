import assert from "node:assert/strict";
import { test } from "node:test";
import { renameWithTransientRetry } from "../../scripts/transient-rename.mjs";

function errorWithCode(code) {
  return Object.assign(new Error(code), { code });
}

test("retries bounded Windows transient rename failures", () => {
  let calls = 0;
  const waits = [];
  renameWithTransientRetry("source", "target", {
    rename() {
      calls += 1;
      if (calls < 3) throw errorWithCode("EPERM");
    },
    platform: "win32",
    wait: (delayMs) => waits.push(delayMs),
  });

  assert.equal(calls, 3);
  assert.deepEqual(waits, [50, 100]);
});

test("does not retry non-lock failures or non-Windows failures", () => {
  for (const scenario of [
    { platform: "win32", code: "ENOENT" },
    { platform: "linux", code: "EPERM" },
  ]) {
    let calls = 0;
    assert.throws(
      () => renameWithTransientRetry("source", "target", {
        rename() {
          calls += 1;
          throw errorWithCode(scenario.code);
        },
        platform: scenario.platform,
        wait: () => assert.fail("unexpected wait"),
      }),
      { code: scenario.code },
    );
    assert.equal(calls, 1);
  }
});

test("rethrows the final Windows lock error after the finite attempt limit", () => {
  let calls = 0;
  const waits = [];
  assert.throws(
    () => renameWithTransientRetry("source", "target", {
      rename() {
        calls += 1;
        throw errorWithCode("EBUSY");
      },
      platform: "win32",
      attempts: 4,
      wait: (delayMs) => waits.push(delayMs),
    }),
    { code: "EBUSY" },
  );
  assert.equal(calls, 4);
  assert.deepEqual(waits, [50, 100, 200]);
});
