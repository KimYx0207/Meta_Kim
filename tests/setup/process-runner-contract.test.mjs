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
  for (const deniedSignal of [0, "SIGTERM", "SIGKILL"]) {
    for (const followup of ["gone", "denied", "exists", "invalid"]) {
      test(`POSIX ${deniedSignal} EPERM then ${followup} permits only bounded read-only group observation`, { timeout: 2000 }, async () => {
        const child = fakePosixChild();
        const permissionError = Object.assign(new Error("Permission denied"), { code: "EPERM", syscall: "kill" });
        const invalidError = Object.assign(new Error("Invalid signal target"), { code: "EINVAL" });
        const calls = [];
        let deniedAt = -1;
        let absenceObserved = false;
        const runner = createPosixGuardedCommandRunner({
          graceMs: 5,
          cleanupTimeoutMs: 100,
          spawn: () => {
            queueMicrotask(() => closeFakeChild(child, 7));
            return child;
          },
          kill: (pid, signal) => {
            assert.equal(absenceObserved, false, "ESRCH must be terminal");
            assert.equal(pid, -child.pid);
            calls.push(signal);
            if (deniedAt < 0) {
              if (signal === deniedSignal) {
                deniedAt = calls.length - 1;
                throw permissionError;
              }
              return true;
            }
            assert.equal(signal, 0, "no further TERM/KILL or root-PID fallback after EPERM");
            if (followup === "gone") {
              absenceObserved = true;
              throw noSuchGroup();
            }
            if (followup === "denied") throw permissionError;
            if (followup === "invalid") throw invalidError;
            return true;
          },
        });
        const error = await expectRejected(runner("fixture", []));
        assert.ok(deniedAt >= 0);
        assert.ok(calls.slice(deniedAt + 1).every((signal) => signal === 0));
        if (followup === "gone") {
          assert.equal(error.code, "META_KIM_CHILD_COMMAND_FAILED");
          assert.equal(error.exitCode, 7);
          assert.equal(error.ownedProcessGroupCleanupVerified, true);
          assert.equal(error.ownedProcessGroupCleanupFailure, false);
        } else {
          assert.equal(error.code, "META_KIM_COMMAND_CLEANUP_FAILED");
          assert.equal(error.ownedProcessGroupCleanupVerified, false);
          assert.equal(error.ownedProcessGroupCleanupFailure, true);
          assert.equal(error.cause, followup === "invalid" ? invalidError : permissionError);
        }
        assertNoWholeTreeClaim(error);
      });
    }
  }

  test("POSIX non-permission signaling errors fail immediately without another probe", async () => {
    const child = fakePosixChild();
    const invalidError = Object.assign(new Error("Invalid target"), { code: "EINVAL" });
    let calls = 0;
    const runner = createPosixGuardedCommandRunner({
      spawn: () => {
        queueMicrotask(() => closeFakeChild(child));
        return child;
      },
      kill: (pid, signal) => {
        assert.equal(pid, -child.pid);
        assert.equal(signal, 0);
        calls += 1;
        throw invalidError;
      },
    });
    const error = await expectRejected(runner("fixture", []));
    assert.equal(calls, 1);
    assert.equal(error.cause, invalidError);
    assert.equal(error.ownedProcessGroupCleanupVerified, false);
    assert.equal(error.ownedProcessGroupCleanupFailure, true);
    assertNoWholeTreeClaim(error);
  });

  test("POSIX EPERM observation retains the original group deadline", async (context) => {
    context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    const flush = async () => {
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    };
    const child = fakePosixChild();
    const permissionError = Object.assign(new Error("Permission denied"), { code: "EPERM" });
    const calls = [];
    let denied = false;
    let settled = false;
    const runner = createPosixGuardedCommandRunner({
      graceMs: 20,
      cleanupTimeoutMs: 40,
      spawn: () => {
        queueMicrotask(() => closeFakeChild(child, 7));
        return child;
      },
      kill: (pid, signal) => {
        assert.equal(pid, -child.pid);
        calls.push({ signal, at: Date.now() });
        if (denied) assert.equal(signal, 0);
        if (denied || signal === "SIGKILL") {
          denied = true;
          throw permissionError;
        }
        return true;
      },
    });
    const completion = expectRejected(runner("fixture", [])).then((error) => {
      settled = true;
      return error;
    });
    await flush();
    context.mock.timers.tick(20);
    await flush();
    assert.ok(denied);
    assert.equal(settled, false);
    context.mock.timers.tick(20);
    await flush();
    context.mock.timers.tick(19);
    await flush();
    assert.equal(settled, false);
    context.mock.timers.tick(1);
    await flush();
    assert.equal(settled, true, "EPERM must not restart the original 20 + 40ms group budget");
    const error = await completion;
    assert.equal(error.cause, permissionError);
    assert.equal(error.ownedProcessGroupCleanupVerified, false);
    assert.ok(calls.every(({ at }) => at < 60));
    assertNoWholeTreeClaim(error);
  });

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
