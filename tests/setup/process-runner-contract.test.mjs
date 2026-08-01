import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { runCommandWithIgnoredStdin } from "../../scripts/eval-process-runner.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

async function expectRejected(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("Expected guarded command to reject");
}

function assertNoWholeTreeClaim(value) {
  assert.equal(Object.hasOwn(value, "processTreeCleanupVerified"), false);
  assert.equal(value.processTreeCleanupClaim, "not_claimed");
  assert.equal(
    value.processTreeCleanupBoundary,
    "out_of_job_process_creation_not_covered",
  );
}

describe("cross-platform process runner contract", () => {
  test("caller redaction composes before mandatory host and credential redaction", async () => {
    assert.equal(typeof spawnSync, "function");
    const emitted = [
      "CUSTOM_MARKER",
      repoRoot,
      os.homedir(),
      "token=output-secret-token",
    ].join(" ");
    const error = await expectRejected(
      runCommandWithIgnoredStdin(
        process.execPath,
        ["-e", `console.error(${JSON.stringify(emitted)}); process.exit(7);`],
        {
          commandDisplay: "CUSTOM_MARKER token=display-secret-token",
          redactText: (value) => value.replaceAll("CUSTOM_MARKER", "<CALLER>"),
          timeout: 10_000,
        },
      ),
    );

    assert.equal(error.code, "META_KIM_CHILD_COMMAND_FAILED");
    assert.equal(error.exitCode, 7);
    assert.match(error.command, /<CALLER>/u);
    assert.match(error.command, /token=<REDACTED>/u);
    assert.match(error.stderr, /<CALLER>/u);
    assert.match(error.stderr, /<REPO>/u);
    assert.match(error.stderr, /<HOME>/u);
    assert.match(error.stderr, /token=<REDACTED>/u);
    assert.doesNotMatch(
      `${error.command}\n${error.stderr}`,
      /CUSTOM_MARKER|output-secret-token|display-secret-token/u,
    );
    assert.equal(error.ownedProcessGroupCleanupVerified, true);
    assertNoWholeTreeClaim(error);
  });
});
