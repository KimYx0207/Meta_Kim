import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createPosixGuardedCommandRunner,
  createBoundedByteCapture,
  createWindowsGuardedCommandRunner,
  DEFAULT_COMMAND_OUTPUT_LIMIT_BYTES,
  DEFAULT_COMMAND_OUTPUT_TAIL_BYTES,
  DEFAULT_WINDOWS_LAUNCHER_OUTPUT_LIMIT_BYTES,
  redactProcessDiagnostic,
  WINDOWS_PROCESS_CLEANUP_TIMEOUT_MS,
} from "../../scripts/eval-process-runner.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFakeChild() {
  const child = new EventEmitter();
  child.pid = 424_242;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal = "SIGTERM") => {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    queueMicrotask(() => closeFakeChild(child, null, signal));
    return true;
  };
  return child;
}

function closeFakeChild(child, code, signal = null) {
  child.exitCode = code;
  child.signalCode = signal;
  child.stdin.destroy();
  child.stdout.end();
  child.stderr.end();
  child.emit("close", code, signal);
}

function windowsResult(values = {}) {
  return JSON.stringify({
    schemaVersion: "meta-kim-windows-job-process-runner-v1",
    verified: true,
    reason: "process_exited_job_drained",
    childExitCode: 0,
    activeProcesses: 0,
    stopRequested: false,
    failureOperation: null,
    win32Error: null,
    ...values,
  });
}

function assertNoWholeTreeClaim(value) {
  assert.equal(Object.hasOwn(value, "processTreeCleanupVerified"), false);
  assert.equal(value.processTreeCleanupClaim, "not_claimed");
  assert.equal(
    value.processTreeCleanupBoundary,
    "out_of_job_process_creation_not_covered",
  );
}

async function expectRejected(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("Expected guarded command to reject");
}

describe("bounded evaluator output capture", () => {
  test("keeps the production byte and cleanup defaults exact", () => {
    assert.equal(DEFAULT_COMMAND_OUTPUT_LIMIT_BYTES, 8 * 1024 * 1024);
    assert.equal(DEFAULT_COMMAND_OUTPUT_TAIL_BYTES, 2 * 1024);
    assert.equal(DEFAULT_WINDOWS_LAUNCHER_OUTPUT_LIMIT_BYTES, 8 * 1024 * 1024);
    assert.equal(WINDOWS_PROCESS_CLEANUP_TIMEOUT_MS, 30_000);
  });

  test("redacts repository, home, and credential diagnostics by default", () => {
    const repoWslPath = repoRoot.replace(
      /^([A-Za-z]):[\\/]/u,
      (_match, drive) => `/mnt/${drive.toLowerCase()}/`,
    ).replaceAll("\\", "/");
    const homeWslPath = os.homedir().replace(
      /^([A-Za-z]):[\\/]/u,
      (_match, drive) => `/mnt/${drive.toLowerCase()}/`,
    ).replaceAll("\\", "/");
    const diagnostic = [
      repoRoot,
      os.homedir(),
      repoWslPath,
      homeWslPath,
      "token=plain-secret-token",
      "authorization=Bearer bearer-secret-token",
      "Authorization: Basic dXNlcjpwbGFpbi1zZWNyZXQ=",
      "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
      "auth=plain-auth-secret",
      "auth=Bearer short-auth-secret",
      "ANTHROPIC_AUTH_TOKEN=Basic dXNzaG9ydA==",
      "ANTHROPIC_API_KEY=anthropic-plain-secret",
      "OPENAI_API_KEY='openai-plain-secret'",
      "AWS_SECRET_ACCESS_KEY=aws-plain-secret",
      '{"token":"json-plain-secret"}',
      '{"authorization":"Bearer quoted-auth-secret"}',
      String.raw`{"password":"prefix\"escaped-secret-suffix"}`,
      '--anthropic-api-key "cli secret with spaces"',
      "--openai-auth-token Bearer short-cli-secret",
      "sk-1234567890abcdef",
    ].join(" ");
    const redacted = redactProcessDiagnostic(diagnostic);

    assert.match(redacted, /<REPO>/u);
    assert.match(redacted, /<HOME>/u);
    assert.doesNotMatch(
      redacted,
      /plain-secret-token|bearer-secret-token|dXNlcjpwbGFpbi1zZWNyZXQ|abcdefghijklmnopqrstuvwxyz0123456789|plain-auth-secret|short-auth-secret|dXNzaG9ydA|anthropic-plain-secret|openai-plain-secret|aws-plain-secret|json-plain-secret|quoted-auth-secret|escaped-secret-suffix|cli secret with spaces|short-cli-secret|sk-1234567890abcdef/u,
    );
    assert.doesNotMatch(redacted, /\/mnt\/[a-z]\//iu);
    assert.match(redacted, /<REDACTED>/u);
  });

  test("does not redact unrelated words that merely contain a secret suffix", () => {
    const diagnostic = "monkey=banana tokenizer=enabled secretariat=office";
    assert.equal(redactProcessDiagnostic(diagnostic), diagnostic);
  });

  test("redacts synthetic Windows and WSL roots without changing similar prefixes", () => {
    const repositoryPath = String.raw`D:\work\Meta_Kim`;
    const homePath = String.raw`C:\Users\Kim`;
    const diagnostic = [
      repositoryPath,
      "D:/work/Meta_Kim/subdir",
      "/mnt/d/work/Meta_Kim/subdir",
      homePath,
      "/mnt/c/Users/Kim/file.txt",
      String.raw`C:\Users\Kimberly`,
      String.raw`D:\work\Meta_Kim-copy`,
    ].join(" ");
    const redacted = redactProcessDiagnostic(diagnostic, {
      repositoryPath,
      homePath,
    });

    assert.match(redacted, /<REPO> <REPO>\/subdir <REPO>\/subdir/u);
    assert.match(redacted, /<HOME> <HOME>\/file\.txt/u);
    assert.match(redacted, /C:\\Users\\Kimberly/u);
    assert.match(redacted, /D:\\work\\Meta_Kim-copy/u);
  });

  test("clears a losing POSIX timeout after the child outcome wins", async () => {
    const child = createFakeChild();
    const runner = createPosixGuardedCommandRunner({
      spawn: (_file, _args, options) => {
        assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
        queueMicrotask(() => closeFakeChild(child, 0));
        return child;
      },
    });

    const result = await runner("fixture", [], { timeout: 5 });
    await delay(20);
    assert.equal(result.ownedProcessGroupCleanupVerified, true);
    assert.equal(result.ownedProcessGroupScope, "posix_detached_process_group");
    assertNoWholeTreeClaim(result);
  });

  test("Windows outcome wins even when verified result reading crosses the timeout", async () => {
    let guardDir = null;
    let spawnArgs = null;
    let spawnOptions = null;
    const child = createFakeChild();
    const fileSystem = {
      async mkdtemp(prefix) {
        guardDir = await fs.mkdtemp(prefix);
        return guardDir;
      },
      writeFile: (...args) => fs.writeFile(...args),
      async readFile(...args) {
        await delay(30);
        return fs.readFile(...args);
      },
      rm: (...args) => fs.rm(...args),
    };
    const runner = createWindowsGuardedCommandRunner({
      fs: fileSystem,
      launcherPath: "fixture-launcher.ps1",
      spawn: (_file, args, options) => {
        spawnArgs = args;
        spawnOptions = options;
        const resultPath = args[args.indexOf("-ResultPath") + 1];
        void fs.writeFile(resultPath, windowsResult(), "utf8").then(() => {
          closeFakeChild(child, 0);
        });
        return child;
      },
    });

    try {
      const result = await runner("fixture.exe", [], { timeout: 5 });
      assert.deepEqual(spawnOptions.stdio, ["pipe", "pipe", "pipe"]);
      assert.equal(spawnArgs[spawnArgs.indexOf("-OwnerPid") + 1], String(process.pid));
      assert.equal(result.ownedProcessGroupCleanupVerified, true);
      assert.equal(
        result.ownedProcessGroupScope,
        "windows_job_object_owned_process_group",
      );
      assertNoWholeTreeClaim(result);
    } finally {
      if (guardDir) await fs.rm(guardDir, { recursive: true, force: true });
    }
  });

  test("Windows success requires a consistent verified tuple and clean launcher exit", async () => {
    const cases = [
      {
        name: "out-of-range result counters",
        result: {
          childExitCode: -1,
          activeProcesses: 0x1_0000_0000,
        },
        launcherCode: 0,
        launcherSignal: null,
        expectedCode: "META_KIM_WINDOWS_PROCESS_RUNNER_RESULT_CORRUPT",
        expectedReason: "launcher_result_schema_invalid",
        expectedCleanupVerified: false,
      },
      {
        name: "verified failure diagnostics",
        result: {
          verified: true,
          reason: "create_job_failed",
          childExitCode: 0,
          activeProcesses: 0,
          failureOperation: "CreateJobObjectW",
          win32Error: 5,
        },
        launcherCode: 0,
        launcherSignal: null,
        expectedCode: "META_KIM_WINDOWS_PROCESS_RUNNER_RESULT_UNVERIFIED",
        expectedReason: "launcher_verified_result_inconsistent",
        expectedCleanupVerified: false,
      },
      {
        name: "launcher nonzero with child nonzero",
        result: { childExitCode: 23 },
        launcherCode: 2,
        launcherSignal: null,
        expectedCode: "META_KIM_WINDOWS_JOB_PROCESS_GROUP_LAUNCHER_EARLY_EXIT",
        expectedReason: "launcher_exit_mismatch_after_verified_result",
        expectedCleanupVerified: false,
      },
      {
        name: "launcher signal after verified result",
        result: { childExitCode: 0 },
        launcherCode: null,
        launcherSignal: "SIGTERM",
        expectedCode: "META_KIM_WINDOWS_JOB_PROCESS_GROUP_LAUNCHER_EARLY_EXIT",
        expectedReason: "launcher_exit_mismatch_after_verified_result",
        expectedCleanupVerified: false,
      },
      {
        name: "child nonzero with launcher zero",
        result: { childExitCode: 23 },
        launcherCode: 0,
        launcherSignal: null,
        expectedCode: "META_KIM_CHILD_COMMAND_FAILED",
        expectedReason: null,
        expectedCleanupVerified: true,
        expectedExitCode: 23,
      },
    ];

    for (const fixture of cases) {
      let guardDir = null;
      const child = createFakeChild();
      const runner = createWindowsGuardedCommandRunner({
        launcherPath: "fixture-launcher.ps1",
        spawn: (_file, args) => {
          const resultPath = args[args.indexOf("-ResultPath") + 1];
          void fs
            .writeFile(resultPath, windowsResult(fixture.result), "utf8")
            .then(() =>
              closeFakeChild(
                child,
                fixture.launcherCode,
                fixture.launcherSignal,
              ),
            );
          return child;
        },
        fs: {
          async mkdtemp(prefix) {
            guardDir = await fs.mkdtemp(prefix);
            return guardDir;
          },
          writeFile: (...args) => fs.writeFile(...args),
          readFile: (...args) => fs.readFile(...args),
          rm: (...args) => fs.rm(...args),
        },
      });

      try {
        const error = await expectRejected(runner("fixture.exe", []));
        assert.equal(error.code, fixture.expectedCode, fixture.name);
        assert.equal(
          error.ownedProcessGroupCleanupReason,
          fixture.expectedReason,
          fixture.name,
        );
        assert.equal(
          error.ownedProcessGroupCleanupVerified,
          fixture.expectedCleanupVerified,
          fixture.name,
        );
        assert.equal(error.exitCode, fixture.expectedExitCode, fixture.name);
        if (fixture.name === "verified failure diagnostics") {
          assert.equal(Object.hasOwn(error, "launcherFailureOperation"), false);
          assert.equal(Object.hasOwn(error, "launcherWin32Error"), false);
        }
        assertNoWholeTreeClaim(error);
      } finally {
        if (guardDir) await fs.rm(guardDir, { recursive: true, force: true });
      }
    }
  });

  test("Windows control winners reject nonzero or signaled launcher outcomes before verified cleanup", async () => {
    for (const launcherOutcome of [
      { code: 2, signal: null },
      { code: null, signal: "SIGTERM" },
    ]) {
      let guardDir = null;
      let resultPath = null;
      let stopPath = null;
      const child = createFakeChild();
      const runner = createWindowsGuardedCommandRunner({
        launcherPath: "fixture-launcher.ps1",
        spawn: (_file, args) => {
          resultPath = args[args.indexOf("-ResultPath") + 1];
          stopPath = args[args.indexOf("-StopPath") + 1];
          return child;
        },
        fs: {
          async mkdtemp(prefix) {
            guardDir = await fs.mkdtemp(prefix);
            return guardDir;
          },
          async writeFile(filePath, ...args) {
            await fs.writeFile(filePath, ...args);
            if (filePath === stopPath) {
              await fs.writeFile(resultPath, windowsResult(), "utf8");
              closeFakeChild(
                child,
                launcherOutcome.code,
                launcherOutcome.signal,
              );
            }
          },
          readFile: (...args) => fs.readFile(...args),
          rm: (...args) => fs.rm(...args),
        },
      });

      try {
        const error = await expectRejected(
          runner("fixture.exe", [], { timeout: 1 }),
        );
        assert.equal(
          error.code,
          "META_KIM_WINDOWS_JOB_PROCESS_GROUP_LAUNCHER_EARLY_EXIT",
        );
        assert.equal(
          error.ownedProcessGroupCleanupReason,
          "launcher_exit_mismatch_after_verified_result",
        );
        assert.equal(error.ownedProcessGroupCleanupVerified, false);
        assert.equal(error.ownedProcessGroupCleanupFailure, true);
        assertNoWholeTreeClaim(error);
      } finally {
        if (guardDir) await fs.rm(guardDir, { recursive: true, force: true });
      }
    }
  });

  test("temp cleanup failure preserves the existing owned-group primary error", async () => {
    let guardDir = null;
    const child = createFakeChild();
    const fileSystem = {
      async mkdtemp(prefix) {
        guardDir = await fs.mkdtemp(prefix);
        return guardDir;
      },
      writeFile: (...args) => fs.writeFile(...args),
      readFile: (...args) => fs.readFile(...args),
      async rm() {
        throw new Error("fixture rm denied");
      },
    };
    const runner = createWindowsGuardedCommandRunner({
      fs: fileSystem,
      launcherPath: "fixture-launcher.ps1",
      spawn: (_file, args) => {
        const resultPath = args[args.indexOf("-ResultPath") + 1];
        void fs
          .writeFile(
            resultPath,
            windowsResult({
              verified: false,
              reason: "survivors_detected",
              activeProcesses: 1,
            }),
            "utf8",
          )
          .then(() => closeFakeChild(child, 0));
        return child;
      },
    });

    try {
      const error = await expectRejected(runner("fixture.exe", []));
      assert.equal(
        error.code,
        "META_KIM_WINDOWS_PROCESS_RUNNER_RESULT_UNVERIFIED",
      );
      assert.equal(error.ownedProcessGroupCleanupFailure, true);
      assert.equal(error.ownedProcessGroupCleanupReason, "survivors_detected");
      assert.equal(error.ownedProcessGroupSurvivorCount, 1);
      assert.equal(error.runnerControlDirectoryRetained, true);
      assert.deepEqual(error.secondaryCleanupFailures, [
        {
          code: "META_KIM_RUNNER_CONTROL_DIRECTORY_CLEANUP_FAILED",
          reason: "runner_temp_cleanup_failed",
        },
      ]);
      assertNoWholeTreeClaim(error);
    } finally {
      if (guardDir) await fs.rm(guardDir, { recursive: true, force: true });
    }
  });

  test("control-directory cleanup failure preserves verified owned-group truth", async () => {
    let guardDir = null;
    const child = createFakeChild();
    const runner = createWindowsGuardedCommandRunner({
      launcherPath: "fixture-launcher.ps1",
      spawn: (_file, args) => {
        const resultPath = args[args.indexOf("-ResultPath") + 1];
        void fs
          .writeFile(
            resultPath,
            windowsResult({ childExitCode: 23 }),
            "utf8",
          )
          .then(() => closeFakeChild(child, 0));
        return child;
      },
      fs: {
        async mkdtemp(prefix) {
          guardDir = await fs.mkdtemp(prefix);
          return guardDir;
        },
        writeFile: (...args) => fs.writeFile(...args),
        readFile: (...args) => fs.readFile(...args),
        async rm() {
          throw new Error("fixture control-directory cleanup denied");
        },
      },
    });

    try {
      const error = await expectRejected(runner("fixture.exe", []));
      assert.equal(error.code, "META_KIM_CHILD_COMMAND_FAILED");
      assert.equal(error.exitCode, 23);
      assert.equal(error.ownedProcessGroupCleanupVerified, true);
      assert.equal(error.ownedProcessGroupCleanupFailure, false);
      assert.equal(error.ownedProcessGroupCleanupReason, null);
      assert.equal(error.ownedProcessGroupSurvivorCount, null);
      assert.equal(error.launcherStillAlive, false);
      assert.equal(error.runnerControlDirectoryRetained, true);
      assert.deepEqual(error.secondaryCleanupFailures, [
        {
          code: "META_KIM_RUNNER_CONTROL_DIRECTORY_CLEANUP_FAILED",
          reason: "runner_temp_cleanup_failed",
        },
      ]);
      assertNoWholeTreeClaim(error);
    } finally {
      if (guardDir) await fs.rm(guardDir, { recursive: true, force: true });
    }
  });

  test("Windows launcher diagnostics expose only fixed safe classifications", async () => {
    const privateMarker = "PRIVATE command --token secret C:/private/spec.json";
    const cases = [
      {
        result: {
          verified: false,
          reason: "launcher_native_compile_failed",
          activeProcesses: -1,
          failureOperation: "compile_native_bridge",
          win32Error: null,
          detail: privateMarker,
          cleanupFailure: privateMarker,
        },
        expectedReason: "launcher_native_compile_failed",
        expectedOperation: "compile_native_bridge",
        expectedWin32Error: undefined,
      },
      {
        result: {
          verified: false,
          reason: "create_job_failed",
          activeProcesses: -1,
          failureOperation: "CreateJobObjectW",
          win32Error: 5,
          detail: privateMarker,
          cleanupFailure: privateMarker,
        },
        expectedReason: "create_job_failed",
        expectedOperation: "CreateJobObjectW",
        expectedWin32Error: 5,
      },
      {
        result: {
          verified: false,
          reason: privateMarker,
          activeProcesses: -1,
          failureOperation: privateMarker,
          win32Error: -1,
          detail: privateMarker,
          cleanupFailure: privateMarker,
        },
        expectedReason: "launcher_result_reason_unrecognized",
        expectedOperation: undefined,
        expectedWin32Error: undefined,
      },
      ...[
        "owner_process_exited_job_terminated",
        "process_exited_job_drained",
        "stop_requested_job_terminated",
      ].map((reason) => ({
        result: {
          verified: false,
          reason,
          activeProcesses: -1,
          failureOperation: null,
          win32Error: null,
        },
        expectedReason: "launcher_result_reason_unrecognized",
        expectedOperation: undefined,
        expectedWin32Error: undefined,
      })),
    ];

    for (const fixture of cases) {
      let guardDir = null;
      const child = createFakeChild();
      const runner = createWindowsGuardedCommandRunner({
        launcherPath: "fixture-launcher.ps1",
        spawn: (_file, args) => {
          const resultPath = args[args.indexOf("-ResultPath") + 1];
          void fs
            .writeFile(resultPath, windowsResult(fixture.result), "utf8")
            .then(() => closeFakeChild(child, 2));
          return child;
        },
        fs: {
          async mkdtemp(prefix) {
            guardDir = await fs.mkdtemp(prefix);
            return guardDir;
          },
          writeFile: (...args) => fs.writeFile(...args),
          readFile: (...args) => fs.readFile(...args),
          rm: (...args) => fs.rm(...args),
        },
      });

      try {
        const error = await expectRejected(
          runner("PRIVATE command --token secret", ["C:/private/spec.json"]),
        );
        assert.equal(
          error.code,
          "META_KIM_WINDOWS_PROCESS_RUNNER_RESULT_UNVERIFIED",
        );
        assert.equal(
          error.ownedProcessGroupCleanupReason,
          fixture.expectedReason,
        );
        assert.equal(
          error.launcherFailureOperation,
          fixture.expectedOperation,
        );
        assert.equal(error.launcherWin32Error, fixture.expectedWin32Error);
        assert.equal(error.ownedProcessGroupSurvivorCount, null);
        assert.equal(Object.hasOwn(error, "detail"), false);
        assert.equal(Object.hasOwn(error, "cleanupFailure"), false);
        assert.equal(Object.hasOwn(error, "result"), false);
        assertNoWholeTreeClaim(error);
        assert.doesNotMatch(JSON.stringify(error), /PRIVATE|secret|spec\.json/u);
      } finally {
        if (guardDir) await fs.rm(guardDir, { recursive: true, force: true });
      }
    }
  });

  test("reassembles split UTF-8 input and hashes the exact byte stream", () => {
    const payload = Buffer.from("start 😀 end", "utf8");
    const emojiOffset = Buffer.from("start ", "utf8").length;
    const capture = createBoundedByteCapture({
      maxBytes: payload.length,
      tailBytes: 8,
      streamName: "stdout",
    });

    assert.deepEqual(capture.append(payload.subarray(0, emojiOffset + 2)), {
      limitExceeded: false,
      justExceeded: false,
    });
    assert.deepEqual(capture.append(payload.subarray(emojiOffset + 2)), {
      limitExceeded: false,
      justExceeded: false,
    });

    const snapshot = capture.snapshot();
    assert.equal(snapshot.text, "start 😀 end");
    assert.equal(snapshot.metadata.streamName, "stdout");
    assert.equal(snapshot.metadata.bytesSeen, payload.length);
    assert.equal(snapshot.metadata.bytesCaptured, payload.length);
    assert.equal(snapshot.metadata.limitExceeded, false);
    assert.equal(snapshot.metadata.sha256, sha256(payload));
  });

  test("caps retained bytes, keeps a bounded tail, and never exposes broken UTF-8", () => {
    const payload = Buffer.from("AB😀CD", "utf8");
    const limitEvents = [];
    const capture = createBoundedByteCapture({
      maxBytes: 4,
      tailBytes: 4,
      streamName: "stderr",
      onLimit: (event) => limitEvents.push(event),
    });

    assert.deepEqual(capture.append(payload.subarray(0, 3)), {
      limitExceeded: false,
      justExceeded: false,
    });
    assert.deepEqual(capture.append(payload.subarray(3, 6)), {
      limitExceeded: true,
      justExceeded: true,
    });
    assert.deepEqual(capture.append(payload.subarray(6)), {
      limitExceeded: true,
      justExceeded: false,
    });

    const snapshot = capture.snapshot();
    assert.equal(capture.limitExceeded, true);
    assert.equal(limitEvents.length, 1);
    assert.equal(snapshot.metadata.streamName, "stderr");
    assert.equal(snapshot.metadata.bytesSeen, payload.length);
    assert.ok(snapshot.metadata.bytesCaptured <= snapshot.metadata.maxBytes);
    assert.ok(snapshot.metadata.tailBytesCaptured <= 4);
    assert.equal(snapshot.metadata.maxBytes, 4);
    assert.equal(snapshot.metadata.limitExceeded, true);
    assert.equal(snapshot.metadata.sha256, sha256(payload));
    assert.doesNotMatch(snapshot.text, /\uFFFD/u);
    assert.doesNotMatch(snapshot.tailText, /\uFFFD/u);
  });
});
