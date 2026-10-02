import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createPosixGuardedCommandRunner,
  runCommandWithIgnoredStdin,
} from "../../scripts/eval-process-runner.mjs";

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

function fakePosixChild() {
  const child = new EventEmitter();
  child.pid = 424_242;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

function exitFakeChild(child, code = 0, signal = null) {
  child.exitCode = code;
  child.signalCode = signal;
  child.emit("exit", code, signal);
}

function closeFakeChild(child, code = 0, signal = null) {
  exitFakeChild(child, code, signal);
  child.stdout.end();
  child.stderr.end();
  child.emit("close", code, signal);
}

function noSuchGroup() {
  return Object.assign(new Error("No such process group"), { code: "ESRCH" });
}

describe("cross-platform process runner contract", () => {
  for (const scenario of [
    { name: "nonzero root exit with denied probe", trigger: "command_exit", failure: "probe", code: 7 },
    { name: "signaled root with denied group signal", trigger: "command_exit", failure: "signal", code: null, signal: "SIGTERM" },
    { name: "successful root with surviving group", trigger: "command_exit", failure: "survivor", code: 0 },
    { name: "timeout with surviving group", trigger: "timeout", failure: "survivor" },
    { name: "abort with denied probe", trigger: "aborted", failure: "probe" },
    { name: "output limit with denied group signal", trigger: "output_limit", failure: "signal" },
  ]) {
    test(`POSIX ${scenario.name} never publishes verified cleanup`, async () => {
      const child = fakePosixChild();
      const controller = new AbortController();
      const signals = [];
      const runner = createPosixGuardedCommandRunner({
        graceMs: 5,
        cleanupTimeoutMs: 5,
        spawn: (_file, _args, options) => {
          assert.equal(options.detached, true);
          queueMicrotask(() => {
            child.stderr.write("token=cleanup-secret");
            if (scenario.trigger === "command_exit") closeFakeChild(child, scenario.code, scenario.signal ?? null);
            if (scenario.trigger === "aborted") controller.abort();
            if (scenario.trigger === "output_limit") child.stdout.write(Buffer.alloc(256));
          });
          return child;
        },
        kill: (pid, signal) => {
          assert.equal(pid, -child.pid, "must never fall back to the root PID or an unrelated process");
          signals.push(signal);
          if (scenario.failure === "probe" || (scenario.failure === "signal" && signal !== 0)) {
            throw Object.assign(new Error("Permission denied"), { code: "EPERM" });
          }
          if (signal === "SIGTERM" && scenario.trigger !== "command_exit") closeFakeChild(child, 23);
          return true;
        },
      });
      try {
        const error = await expectRejected(runner("fixture", [], {
          timeout: scenario.trigger === "timeout" ? 5 : 1000,
          signal: controller.signal,
          outputLimitBytes: 128,
        }));
        assert.equal(error.code, "META_KIM_COMMAND_CLEANUP_FAILED");
        assert.equal(error.ownedProcessGroupCleanupVerified, false);
        assert.equal(error.ownedProcessGroupCleanupFailure, true);
        assert.equal(error.ownedProcessGroupCleanupReason, `${scenario.trigger}_cleanup_failed`);
        assert.equal(error.ownedProcessGroupScope, "posix_detached_process_group");
        assert.match(error.stderr, /token=<REDACTED>/u);
        assertNoWholeTreeClaim(error);
        if (scenario.failure === "survivor") {
          assert.ok(signals.includes("SIGKILL"));
          assert.equal(error.cause.code, "META_KIM_POSIX_PROCESS_GROUP_CLEANUP_FAILED");
          assert.equal(error.cause.ownedProcessGroupCleanupReason, "posix_process_group_exit_unverified");
        } else {
          assert.equal(error.cause.code, "EPERM");
          assert.ok(!signals.includes("SIGKILL"));
        }
      } finally {
        child.stdout.destroy();
        child.stderr.destroy();
      }
    });
  }

  for (const trigger of ["command_exit", "timeout", "aborted"]) {
    test(`POSIX late output limit preserves the ${trigger} outcome priority`, async () => {
      const child = fakePosixChild();
      const controller = new AbortController();
      let groupGone = false;
      const runner = createPosixGuardedCommandRunner({
        spawn: () => {
          queueMicrotask(() => {
            if (trigger === "command_exit") exitFakeChild(child);
            if (trigger === "aborted") controller.abort();
          });
          return child;
        },
        kill: (pid, signal) => {
          assert.equal(pid, -child.pid);
          if (groupGone) throw noSuchGroup();
          if (signal === "SIGTERM") {
            child.stdout.write(Buffer.alloc(256, 120));
            groupGone = true;
            closeFakeChild(child);
          }
          return true;
        },
      });
      const error = await expectRejected(runner("fixture", [], {
        timeout: trigger === "timeout" ? 5 : 1000,
        signal: controller.signal,
        outputLimitBytes: 16,
        tailBytes: 8,
      }));
      assert.equal(error.code, {
        command_exit: "META_KIM_COMMAND_OUTPUT_LIMIT_EXCEEDED",
        timeout: "META_KIM_COMMAND_TIMEOUT",
        aborted: "META_KIM_COMMAND_ABORTED",
      }[trigger]);
      assert.equal(error.stdoutMetadata.limitExceeded, true);
      assert.equal(error.ownedProcessGroupCleanupVerified, true);
      assert.equal(error.ownedProcessGroupCleanupFailure, false);
      assertNoWholeTreeClaim(error);
    });
  }

  test("POSIX absence is terminal and an unclosed output stream fails closed", async () => {
    const child = fakePosixChild();
    let probes = 0;
    const runner = createPosixGuardedCommandRunner({
      cleanupTimeoutMs: 5,
      spawn: () => {
        queueMicrotask(() => exitFakeChild(child));
        return child;
      },
      kill: (pid, signal) => {
        assert.equal(pid, -child.pid);
        assert.equal(signal, 0);
        probes += 1;
        throw noSuchGroup();
      },
    });
    try {
      const error = await expectRejected(runner("fixture", []));
      assert.equal(probes, 1, "an absent group ID must not be signaled or probed again");
      assert.equal(error.code, "META_KIM_COMMAND_CLEANUP_FAILED");
      assert.equal(error.ownedProcessGroupCleanupVerified, false);
      assert.equal(error.ownedProcessGroupCleanupFailure, true);
      assert.equal(error.cause.ownedProcessGroupCleanupReason, "posix_process_close_unverified");
      assert.equal(child.stdout.destroyed, true);
      assert.equal(child.stderr.destroyed, true);
      assertNoWholeTreeClaim(error);
    } finally {
      closeFakeChild(child);
    }
  });

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
    assert.equal(error.ownedProcessGroupCleanupFailure, false);
    assert.equal(error.ownedProcessGroupCleanupReason, null);
    assert.equal(
      error.ownedProcessGroupScope,
      process.platform === "win32"
        ? "windows_job_object_owned_process_group"
        : "posix_detached_process_group",
    );
    assertNoWholeTreeClaim(error);
  });
});
