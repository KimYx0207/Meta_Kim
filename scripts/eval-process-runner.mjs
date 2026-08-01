import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

export const DEFAULT_COMMAND_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_COMMAND_OUTPUT_TAIL_BYTES = 2 * 1024;
export const DEFAULT_WINDOWS_LAUNCHER_OUTPUT_LIMIT_BYTES =
  DEFAULT_COMMAND_OUTPUT_LIMIT_BYTES;
export const WINDOWS_PROCESS_CLEANUP_TIMEOUT_MS = 30_000;
export const PROCESS_TREE_CLEANUP_CLAIM = "not_claimed";
export const PROCESS_TREE_CLEANUP_BOUNDARY =
  "out_of_job_process_creation_not_covered";

const defaultWindowsLauncherPath = path.join(
  __dirname,
  "windows-job-process-runner.ps1",
);
const activeChildren = new Map();
let cleanupInFlight = null;

function asPositiveInteger(value, fallback, label) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return resolved;
}

function asBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return Buffer.from(String(chunk ?? ""), "utf8");
}

function utf8SequenceLength(byte) {
  if ((byte & 0x80) === 0) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 0;
}

/**
 * Decode a byte slice without manufacturing U+FFFD merely because a bounded
 * prefix or tail begins/ends in the middle of a UTF-8 code point.
 */
function decodeUtf8BoundarySafe(buffer) {
  if (buffer.length === 0) return "";

  let start = 0;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
    start += 1;
  }
  if (start >= buffer.length) return "";

  let end = buffer.length;
  let lead = end - 1;
  while (lead >= start && (buffer[lead] & 0xc0) === 0x80) {
    lead -= 1;
  }
  if (lead >= start) {
    const expected = utf8SequenceLength(buffer[lead]);
    const available = end - lead;
    if (expected > 1 && available < expected) {
      end = lead;
    }
  }

  return buffer.subarray(start, end).toString("utf8");
}

/**
 * Build a byte-bounded stream collector with a digest over the complete byte
 * stream and a separately bounded raw tail for diagnostics.
 *
 * @param {{maxBytes?: number, tailBytes?: number, streamName?: string,
 *   onLimit?: (snapshot: object) => void}} options
 */
export function createBoundedByteCapture(options = {}) {
  const maxBytes = asPositiveInteger(
    options.maxBytes,
    DEFAULT_COMMAND_OUTPUT_LIMIT_BYTES,
    "maxBytes",
  );
  const tailBytes = asPositiveInteger(
    options.tailBytes,
    DEFAULT_COMMAND_OUTPUT_TAIL_BYTES,
    "tailBytes",
  );
  const streamName = String(options.streamName ?? "output");
  const prefixChunks = [];
  const hash = crypto.createHash("sha256");
  let rawTail = Buffer.alloc(0);
  let bytesSeen = 0;
  let bytesCaptured = 0;
  let limitExceeded = false;
  let limitCallbackCalled = false;

  function metadata() {
    return {
      streamName,
      bytesSeen,
      bytesCaptured,
      tailBytesCaptured: rawTail.length,
      maxBytes,
      limitExceeded,
      sha256: hash.copy().digest("hex"),
    };
  }

  function snapshot() {
    const prefix =
      prefixChunks.length === 0
        ? Buffer.alloc(0)
        : Buffer.concat(prefixChunks, bytesCaptured);
    return {
      text: decodeUtf8BoundarySafe(prefix),
      tailText: decodeUtf8BoundarySafe(rawTail),
      metadata: metadata(),
    };
  }

  function append(chunk) {
    const buffer = asBuffer(chunk);
    if (buffer.length === 0) {
      return { limitExceeded, justExceeded: false };
    }

    hash.update(buffer);
    bytesSeen += buffer.length;

    const remaining = maxBytes - bytesCaptured;
    if (remaining > 0) {
      const captured = buffer.subarray(0, Math.min(remaining, buffer.length));
      prefixChunks.push(Buffer.from(captured));
      bytesCaptured += captured.length;
    }

    if (buffer.length >= tailBytes) {
      rawTail = Buffer.from(buffer.subarray(buffer.length - tailBytes));
    } else {
      const combined = Buffer.concat([rawTail, buffer]);
      rawTail = Buffer.from(
        combined.subarray(Math.max(0, combined.length - tailBytes)),
      );
    }

    const justExceeded = !limitExceeded && bytesSeen > maxBytes;
    if (justExceeded) {
      limitExceeded = true;
      if (!limitCallbackCalled && typeof options.onLimit === "function") {
        limitCallbackCalled = true;
        options.onLimit(snapshot());
      }
    }
    return { limitExceeded, justExceeded };
  }

  return {
    append,
    snapshot,
    get limitExceeded() {
      return limitExceeded;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function childOutcome(child) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    child.once("error", (error) =>
      finish({ error, code: null, signal: null }),
    );
    child.once("close", (code, signal) => finish({ error: null, code, signal }));
  });
}

function registerActiveChild(child, label, stop) {
  const key = Symbol(label);
  activeChildren.set(key, { child, label, stop });
  const unregister = () => activeChildren.delete(key);
  child.once("close", unregister);
  child.once("error", unregister);
  return unregister;
}

/** Publish cleanup truth for only the runner-owned process group. */
function attachOwnedProcessGroupTruth(
  target,
  { verified, failure = false, reason = null, survivorCount = null, scope },
) {
  target.ownedProcessGroupCleanupVerified = verified;
  target.ownedProcessGroupCleanupFailure = failure;
  target.ownedProcessGroupCleanupReason = reason;
  target.ownedProcessGroupSurvivorCount = survivorCount;
  target.ownedProcessGroupScope = scope;
  target.processTreeCleanupClaim = PROCESS_TREE_CLEANUP_CLAIM;
  target.processTreeCleanupBoundary = PROCESS_TREE_CLEANUP_BOUNDARY;
  return target;
}

function cleanupFailure(
  error,
  code,
  reason,
  scope = "runner_owned_process_group",
) {
  const wrapped = new Error("Owned process-group cleanup could not be verified", {
    cause: error,
  });
  wrapped.code = code;
  return attachOwnedProcessGroupTruth(wrapped, {
    verified: false,
    failure: true,
    reason,
    scope,
  });
}

async function raceOutcomeWithTimeout(outcomePromise, timeoutMs) {
  let timeoutId = null;
  try {
    return await Promise.race([
      outcomePromise.then((outcome) => ({ timedOut: false, outcome })),
      new Promise((resolve) => {
        timeoutId = setTimeout(
          () => resolve({ timedOut: true, outcome: null }),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function waitForOutcome(
  outcomePromise,
  timeoutMs,
  failureCode,
  reason,
  scope = "runner_owned_process_group",
) {
  const result = await raceOutcomeWithTimeout(outcomePromise, timeoutMs);
  if (result.timedOut) {
    throw cleanupFailure(null, failureCode, reason, scope);
  }
  return result.outcome;
}

function childIsRunning(child) {
  return Boolean(
    child?.pid && child.exitCode === null && child.signalCode === null,
  );
}

async function forceStopLauncher(
  launcher,
  outcomePromise,
  timeoutMs = 5_000,
) {
  if (!childIsRunning(launcher)) return outcomePromise;
  const killRequested = launcher.kill("SIGKILL");
  if (!killRequested && childIsRunning(launcher)) {
    const error = cleanupFailure(
      null,
      "META_KIM_WINDOWS_PROCESS_LAUNCHER_FORCE_STOP_FAILED",
      "launcher_force_stop_rejected",
      "windows_job_object_owned_process_group",
    );
    error.launcherStillAlive = true;
    throw error;
  }
  try {
    return await waitForOutcome(
      outcomePromise,
      timeoutMs,
      "META_KIM_WINDOWS_PROCESS_LAUNCHER_FORCE_STOP_FAILED",
      "launcher_force_stop_exit_unverified",
      "windows_job_object_owned_process_group",
    );
  } catch (error) {
    error.launcherStillAlive = childIsRunning(launcher);
    throw error;
  }
}

async function stopPosixProcessGroup(child, outcomePromise, graceMs = 5_000) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;

  const signalGroup = (signal) => {
    let lastError = null;
    for (const target of [-child.pid, child.pid]) {
      try {
        process.kill(target, signal);
        return;
      } catch (error) {
        lastError = error;
        if (error?.code === "ESRCH") return;
      }
    }
    throw lastError;
  };

  signalGroup("SIGTERM");
  const graceful = await raceOutcomeWithTimeout(outcomePromise, graceMs);
  if (!graceful.timedOut) return;

  signalGroup("SIGKILL");
  await waitForOutcome(
    outcomePromise,
    5_000,
    "META_KIM_POSIX_PROCESS_GROUP_CLEANUP_FAILED",
    "posix_process_group_exit_unverified",
    "posix_detached_process_group",
  );
}

function replacePathVariants(text, targetPath, replacement) {
  if (!targetPath) return text;
  const pathText = String(targetPath);
  const isWindowsDrivePath = /^[A-Za-z]:[\\/]/u.test(pathText);
  const resolvedPath = isWindowsDrivePath
    ? path.win32.resolve(pathText)
    : path.resolve(pathText);
  const variants = new Set([
    resolvedPath,
    resolvedPath.replaceAll("\\", "/"),
    resolvedPath.replaceAll("/", "\\"),
  ]);
  const windowsDrivePath = resolvedPath.match(/^([A-Za-z]):[\\/](.*)$/u);
  if (windowsDrivePath) {
    variants.add(
      `/mnt/${windowsDrivePath[1].toLowerCase()}/${windowsDrivePath[2].replaceAll("\\", "/")}`,
    );
  }
  let redacted = text;
  for (const variant of [...variants].sort((a, b) => b.length - a.length)) {
    if (!variant) continue;
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    redacted = redacted.replace(
      new RegExp(`${escaped}(?![A-Za-z0-9_.-])`, "giu"),
      replacement,
    );
  }
  return redacted;
}

const CREDENTIAL_KEY = String.raw`(?:api[_-]?key|secret[_-]?access[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|token|secret|password|passwd|credential|auth)`;
const QUOTED_CREDENTIAL_VALUE = String.raw`(?:(?:"(?:\\.|[^"\\\r\n])*")|(?:'(?:\\.|[^'\\\r\n])*'))`;
const BARE_CREDENTIAL_VALUE = String.raw`[^\s,;}\]]+`;
const SCHEMED_BARE_CREDENTIAL_VALUE = String.raw`(?:(?:bearer|basic)\s+)?${BARE_CREDENTIAL_VALUE}`;
const CREDENTIAL_ASSIGNMENT = new RegExp(
  String.raw`(^|[^A-Za-z0-9])((?:["']?)(?:(?:[A-Za-z0-9]+[_-])+)?${CREDENTIAL_KEY}(?:["']?)\s*[:=]\s*)(${QUOTED_CREDENTIAL_VALUE}|${SCHEMED_BARE_CREDENTIAL_VALUE})`,
  "gimu",
);
const AUTHORIZATION_ASSIGNMENT = new RegExp(
  String.raw`(^|[^A-Za-z0-9])((?:["']?)authorization(?:["']?)\s*[:=]\s*)(${QUOTED_CREDENTIAL_VALUE}|${SCHEMED_BARE_CREDENTIAL_VALUE})`,
  "gimu",
);
const CLI_CREDENTIAL_FLAG = new RegExp(
  String.raw`(--?(?:(?:[A-Za-z0-9]+[_-])+)?${CREDENTIAL_KEY}\s+)(${QUOTED_CREDENTIAL_VALUE}|${SCHEMED_BARE_CREDENTIAL_VALUE})`,
  "gimu",
);
const BARE_BEARER_CREDENTIAL = new RegExp(
  String.raw`\b(bearer\s+)(${BARE_CREDENTIAL_VALUE})`,
  "gimu",
);

function replaceAssignmentValue(text, pattern) {
  return text.replace(pattern, (_match, boundary, assignment, rawValue) => {
    const quote = rawValue.startsWith('"') || rawValue.startsWith("'")
      ? rawValue[0]
      : "";
    return `${boundary}${assignment}${quote}<REDACTED>${quote}`;
  });
}

function redactCredentialAssignments(text) {
  return replaceAssignmentValue(
    replaceAssignmentValue(text, AUTHORIZATION_ASSIGNMENT),
    CREDENTIAL_ASSIGNMENT,
  );
}

/** Redact host paths and credential-like values from process diagnostics. */
export function redactProcessDiagnostic(
  value,
  { repositoryPath = repoRoot, homePath = os.homedir() } = {},
) {
  let redacted = String(value ?? "");
  redacted = replacePathVariants(redacted, repositoryPath, "<REPO>");
  redacted = replacePathVariants(redacted, homePath, "<HOME>");
  redacted = redactCredentialAssignments(redacted)
    .replace(
      CLI_CREDENTIAL_FLAG,
      "$1<REDACTED>",
    )
    .replace(
      BARE_BEARER_CREDENTIAL,
      "$1<REDACTED>",
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{12,})\b/g,
      "<REDACTED>",
    );
  return redacted;
}

function redactor(options) {
  return (value) => {
    let callerRedacted = String(value ?? "");
    try {
      if (typeof options.redactText === "function") {
        callerRedacted = String(options.redactText(callerRedacted));
      }
    } catch {
      return "<command-output-redaction-failed>";
    }
    return redactProcessDiagnostic(callerRedacted);
  };
}

function commandLabel(file, args, options) {
  const raw = typeof options.commandDisplay === "string" && options.commandDisplay.trim()
    ? options.commandDisplay.trim()
    : `${file} ${args.map(String).join(" ")}`;
  return redactor(options)(raw);
}

function outputSnapshots(stdoutCapture, stderrCapture) {
  return {
    stdout: stdoutCapture.snapshot(),
    stderr: stderrCapture.snapshot(),
  };
}

function attachOutput(error, snapshots, options, diagnosticTailOnly = false) {
  const redact = redactor(options);
  error.stdout = redact(
    diagnosticTailOnly ? snapshots.stdout.tailText : snapshots.stdout.text,
  );
  error.stderr = redact(
    diagnosticTailOnly ? snapshots.stderr.tailText : snapshots.stderr.text,
  );
  error.stdoutMetadata = snapshots.stdout.metadata;
  error.stderrMetadata = snapshots.stderr.metadata;
  error.processTreeCleanupClaim ??= PROCESS_TREE_CLEANUP_CLAIM;
  error.processTreeCleanupBoundary ??= PROCESS_TREE_CLEANUP_BOUNDARY;
  return error;
}

function outputLimitError(
  command,
  snapshots,
  options,
  cleanupVerified,
  cleanupScope,
) {
  const streams = [snapshots.stdout, snapshots.stderr]
    .filter((snapshot) => snapshot.metadata.limitExceeded)
    .map((snapshot) => snapshot.metadata.streamName);
  const error = new Error(
    `Command output exceeded the byte limit: ${command} (${streams.join(", ")})`,
  );
  error.code = "META_KIM_COMMAND_OUTPUT_LIMIT_EXCEEDED";
  error.command = command;
  error.outputLimitStreams = streams;
  attachOwnedProcessGroupTruth(error, {
    verified: cleanupVerified,
    scope: cleanupScope,
  });
  return attachOutput(error, snapshots, options, true);
}

function commandFailureError(command, outcome, snapshots, options) {
  const suffix = outcome.signal ? ` (signal: ${outcome.signal})` : "";
  const error = new Error(`Command failed: ${command}${suffix}`);
  error.code = "META_KIM_CHILD_COMMAND_FAILED";
  error.command = command;
  error.exitCode = outcome.code;
  error.signal = outcome.signal;
  return attachOutput(error, snapshots, options);
}

export function createPosixGuardedCommandRunner(dependencies = {}) {
  const spawnImpl = dependencies.spawn ?? spawn;
  return async function posixGuardedCommand(file, args, options = {}) {
  const command = commandLabel(file, args, options);
  const control = deferred();
  let controlReason = null;
  let controlOpen = true;
  const requestControl = (reason) => {
    if (!controlOpen || controlReason) return;
    controlReason = reason;
    control.resolve(reason);
  };
  const outputLimitBytes = asPositiveInteger(
    options.outputLimitBytes,
    DEFAULT_COMMAND_OUTPUT_LIMIT_BYTES,
    "outputLimitBytes",
  );
  const tailBytes = asPositiveInteger(
    options.tailBytes,
    DEFAULT_COMMAND_OUTPUT_TAIL_BYTES,
    "tailBytes",
  );
  const stdoutCapture = createBoundedByteCapture({
    maxBytes: outputLimitBytes,
    tailBytes,
    streamName: "stdout",
    onLimit: () => requestControl("output_limit"),
  });
  const stderrCapture = createBoundedByteCapture({
    maxBytes: outputLimitBytes,
    tailBytes,
    streamName: "stderr",
    onLimit: () => requestControl("output_limit"),
  });
  const child = spawnImpl(file, args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const outcomePromise = childOutcome(child);
  const stop = () => stopPosixProcessGroup(child, outcomePromise);
  registerActiveChild(child, command, stop);
  child.stdout?.on("data", (chunk) => stdoutCapture.append(chunk));
  child.stderr?.on("data", (chunk) => stderrCapture.append(chunk));

  let timeoutId = null;
  if (Number.isFinite(options.timeout) && options.timeout > 0) {
    timeoutId = setTimeout(() => requestControl("timeout"), options.timeout);
  }
  const abortHandler = () => requestControl("aborted");
  options.signal?.addEventListener("abort", abortHandler, { once: true });

  try {
    const first = await Promise.race([
      outcomePromise.then((outcome) => ({ type: "outcome", outcome })),
      control.promise.then((reason) => ({ type: "control", reason })),
    ]);
    controlOpen = false;
    if (first.type === "outcome") {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      options.signal?.removeEventListener("abort", abortHandler);
    }
    const winningControlReason =
      first.type === "control" ? first.reason : null;
    let outcome = first.outcome;
    if (first.type === "control") {
      try {
        await stop();
        outcome = await outcomePromise;
      } catch (error) {
        throw cleanupFailure(
          error,
          "META_KIM_COMMAND_CLEANUP_FAILED",
          `${first.reason}_cleanup_failed`,
          "posix_detached_process_group",
        );
      }
    }

    const snapshots = outputSnapshots(stdoutCapture, stderrCapture);
    if (winningControlReason === "output_limit") {
      throw outputLimitError(
        command,
        snapshots,
        options,
        true,
        "posix_detached_process_group",
      );
    }
    if (winningControlReason === "timeout") {
      const error = new Error(
        `Command timed out after ${options.timeout}ms: ${command}`,
      );
      error.code = "META_KIM_COMMAND_TIMEOUT";
      error.command = command;
      error.timeoutMs = options.timeout;
      attachOwnedProcessGroupTruth(error, {
        verified: true,
        scope: "posix_detached_process_group",
      });
      throw attachOutput(error, snapshots, options);
    }
    if (winningControlReason === "aborted") {
      const error = new Error(`Command aborted: ${command}`);
      error.code = "META_KIM_COMMAND_ABORTED";
      error.command = command;
      attachOwnedProcessGroupTruth(error, {
        verified: true,
        scope: "posix_detached_process_group",
      });
      throw attachOutput(error, snapshots, options);
    }
    if (outcome.error) {
      const error = new Error(`Command launch failed: ${command}`);
      error.code = "META_KIM_CHILD_COMMAND_LAUNCH_FAILED";
      error.command = command;
      error.systemCode = outcome.error?.code ?? null;
      throw attachOutput(error, snapshots, options);
    }
    if (outcome.code !== 0) {
      throw commandFailureError(command, outcome, snapshots, options);
    }
    return attachOwnedProcessGroupTruth({
      stdout: snapshots.stdout.text,
      stderr: snapshots.stderr.text,
      stdoutMetadata: snapshots.stdout.metadata,
      stderrMetadata: snapshots.stderr.metadata,
    }, {
      verified: true,
      scope: "posix_detached_process_group",
    });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", abortHandler);
  }
  };
}

export const runPosixGuardedCommand = createPosixGuardedCommandRunner();

async function readWindowsResult(resultPath, fileSystem = fs) {
  let raw;
  try {
    raw = await fileSystem.readFile(resultPath, "utf8");
  } catch (error) {
    const wrapped = cleanupFailure(
      error,
      "META_KIM_WINDOWS_JOB_PROCESS_GROUP_LAUNCHER_EARLY_EXIT",
      "launcher_result_missing",
      "windows_job_object_owned_process_group",
    );
    wrapped.message =
      "Windows process launcher exited without a verified result";
    throw wrapped;
  }

  let result;
  try {
    result = JSON.parse(raw);
  } catch (error) {
    throw cleanupFailure(
      error,
      "META_KIM_WINDOWS_PROCESS_RUNNER_RESULT_CORRUPT",
      "launcher_result_corrupt",
      "windows_job_object_owned_process_group",
    );
  }

  const shapeValid =
    result?.schemaVersion === "meta-kim-windows-job-process-runner-v1" &&
    typeof result?.verified === "boolean" &&
    typeof result?.reason === "string" &&
    (result.childExitCode === null ||
      Number.isSafeInteger(result.childExitCode)) &&
    Number.isSafeInteger(result?.activeProcesses) &&
    typeof result?.stopRequested === "boolean";
  if (!shapeValid) {
    throw cleanupFailure(
      null,
      "META_KIM_WINDOWS_PROCESS_RUNNER_RESULT_CORRUPT",
      "launcher_result_schema_invalid",
      "windows_job_object_owned_process_group",
    );
  }
  if (result.verified !== true || result.activeProcesses !== 0) {
    const error = cleanupFailure(
      null,
      "META_KIM_WINDOWS_PROCESS_RUNNER_RESULT_UNVERIFIED",
      result.reason || "launcher_result_unverified",
      "windows_job_object_owned_process_group",
    );
    error.ownedProcessGroupSurvivorCount = result.activeProcesses;
    throw error;
  }
  return result;
}

/**
 * Create the Windows Job Object runner. Dependency injection keeps process
 * lifecycle tests on the same production state machine.
 */
export function createWindowsGuardedCommandRunner(dependencies = {}) {
  const spawnImpl = dependencies.spawn ?? spawn;
  const fileSystem = dependencies.fs ?? fs;
  const cleanupTimeoutMs = asPositiveInteger(
    dependencies.cleanupTimeoutMs,
    WINDOWS_PROCESS_CLEANUP_TIMEOUT_MS,
    "cleanupTimeoutMs",
  );
  const forceStopTimeoutMs = asPositiveInteger(
    dependencies.forceStopTimeoutMs,
    5_000,
    "forceStopTimeoutMs",
  );
  const canonicalLauncherPath =
    dependencies.launcherPath ?? defaultWindowsLauncherPath;

  return async function windowsGuardedCommand(file, args, options = {}) {
    const command = commandLabel(file, args, options);
    const launcherPath = options.launcherPath ?? canonicalLauncherPath;
    const guardDir = await fileSystem.mkdtemp(
      path.join(os.tmpdir(), "meta-kim-job-process-runner-"),
    );
    const specPath = path.join(guardDir, "spec.json");
    const stopPath = path.join(guardDir, "stop");
    const resultPath = path.join(guardDir, "result.json");
    const outputLimitBytes = asPositiveInteger(
      options.outputLimitBytes,
      DEFAULT_WINDOWS_LAUNCHER_OUTPUT_LIMIT_BYTES,
      "outputLimitBytes",
    );
    const tailBytes = asPositiveInteger(
      options.tailBytes,
      DEFAULT_COMMAND_OUTPUT_TAIL_BYTES,
      "tailBytes",
    );
    const control = deferred();
    let controlReason = null;
    let controlOpen = true;
    const requestControl = (reason) => {
      if (!controlOpen || controlReason) return;
      controlReason = reason;
      control.resolve(reason);
    };
    const stdoutCapture = createBoundedByteCapture({
      maxBytes: outputLimitBytes,
      tailBytes,
      streamName: "stdout",
      onLimit: () => requestControl("output_limit"),
    });
    const stderrCapture = createBoundedByteCapture({
      maxBytes: outputLimitBytes,
      tailBytes,
      streamName: "stderr",
      onLimit: () => requestControl("output_limit"),
    });
    let launcher = null;
    let outcomePromise = null;
    let timeoutId = null;
    let primaryError = null;
    let returnValue = null;

    try {
      await fileSystem.writeFile(
        specPath,
        `${JSON.stringify({
          file: String(file),
          args: args.map(String),
          cwd: options.cwd ? path.resolve(options.cwd) : process.cwd(),
        })}\n`,
        "utf8",
      );
      launcher = spawnImpl(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          launcherPath,
          "-SpecPath",
          specPath,
          "-StopPath",
          stopPath,
          "-ResultPath",
          resultPath,
          "-OwnerPid",
          String(process.pid),
        ],
        {
          cwd: options.cwd,
          env: options.env,
          windowsHide: true,
          // Keep the write side open for the launcher's supervisor lease. The
          // launcher treats EOF as owner death; ChildProcess close releases it.
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      outcomePromise = childOutcome(launcher);
      launcher.stdout?.on("data", (chunk) => stdoutCapture.append(chunk));
      launcher.stderr?.on("data", (chunk) => stderrCapture.append(chunk));

      const requestStopAndVerify = async () => {
        await fileSystem.writeFile(stopPath, "stop\n", "utf8");
        try {
          await waitForOutcome(
            outcomePromise,
            cleanupTimeoutMs,
            "META_KIM_WINDOWS_JOB_PROCESS_GROUP_DRAIN_FAILED",
            "launcher_exit_unverified",
            "windows_job_object_owned_process_group",
          );
        } catch (waitError) {
          try {
            await forceStopLauncher(
              launcher,
              outcomePromise,
              forceStopTimeoutMs,
            );
          } catch (forceStopError) {
            attachOwnedProcessGroupTruth(forceStopError, {
              verified: false,
              failure: true,
              reason:
                forceStopError.ownedProcessGroupCleanupReason ??
                "launcher_force_stop_failed",
              scope: "windows_job_object_owned_process_group",
            });
            throw forceStopError;
          }
          const error = cleanupFailure(
            waitError,
            "META_KIM_WINDOWS_JOB_PROCESS_GROUP_DRAIN_FAILED",
            "launcher_force_stopped_after_cleanup_timeout",
            "windows_job_object_owned_process_group",
          );
          error.launcherForcedStop = true;
          attachOwnedProcessGroupTruth(error, {
            verified: false,
            failure: true,
            reason: "launcher_force_stopped_after_cleanup_timeout",
            scope: "windows_job_object_owned_process_group",
          });
          throw error;
        }
        return readWindowsResult(resultPath, fileSystem);
      };
      registerActiveChild(launcher, command, requestStopAndVerify);

      if (Number.isFinite(options.timeout) && options.timeout > 0) {
        timeoutId = setTimeout(() => requestControl("timeout"), options.timeout);
      }
      const abortHandler = () => requestControl("aborted");
      options.signal?.addEventListener("abort", abortHandler, { once: true });

      try {
        const first = await Promise.race([
          outcomePromise.then((outcome) => ({ type: "outcome", outcome })),
          control.promise.then((reason) => ({ type: "control", reason })),
        ]);
        controlOpen = false;
        if (first.type === "outcome") {
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          options.signal?.removeEventListener("abort", abortHandler);
        }
        const winningControlReason =
          first.type === "control" ? first.reason : null;
        let outcome = first.outcome;
        let result;
        if (first.type === "control") {
          result = await requestStopAndVerify();
          outcome = await outcomePromise;
        } else {
          result = await readWindowsResult(resultPath, fileSystem);
        }
        const snapshots = outputSnapshots(stdoutCapture, stderrCapture);

        if (winningControlReason === "output_limit") {
          throw outputLimitError(
            command,
            snapshots,
            options,
            true,
            "windows_job_object_owned_process_group",
          );
        }
        if (winningControlReason === "timeout") {
          const error = new Error(
            `Command timed out after ${options.timeout}ms: ${command}`,
          );
          error.code = "META_KIM_COMMAND_TIMEOUT";
          error.command = command;
          error.timeoutMs = options.timeout;
          attachOwnedProcessGroupTruth(error, {
            verified: true,
            scope: "windows_job_object_owned_process_group",
          });
          throw attachOutput(error, snapshots, options);
        }
        if (winningControlReason === "aborted") {
          const error = new Error(`Command aborted: ${command}`);
          error.code = "META_KIM_COMMAND_ABORTED";
          error.command = command;
          attachOwnedProcessGroupTruth(error, {
            verified: true,
            scope: "windows_job_object_owned_process_group",
          });
          throw attachOutput(error, snapshots, options);
        }
        if (outcome.error) throw outcome.error;
        if (outcome.code !== 0 && result.childExitCode === 0) {
          const error = cleanupFailure(
            null,
            "META_KIM_WINDOWS_JOB_PROCESS_GROUP_LAUNCHER_EARLY_EXIT",
            "launcher_nonzero_after_zero_child_exit",
            "windows_job_object_owned_process_group",
          );
          throw attachOutput(error, snapshots, options);
        }
        if (result.childExitCode !== 0) {
          const error = commandFailureError(
            command,
            { code: result.childExitCode, signal: null },
            snapshots,
            options,
          );
          attachOwnedProcessGroupTruth(error, {
            verified: true,
            scope: "windows_job_object_owned_process_group",
          });
          throw error;
        }
        returnValue = attachOwnedProcessGroupTruth({
          stdout: snapshots.stdout.text,
          stderr: snapshots.stderr.text,
          stdoutMetadata: snapshots.stdout.metadata,
          stderrMetadata: snapshots.stderr.metadata,
        }, {
          verified: true,
          scope: "windows_job_object_owned_process_group",
        });
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        options.signal?.removeEventListener("abort", abortHandler);
      }
    } catch (error) {
      primaryError = error;
      if (launcher && outcomePromise && childIsRunning(launcher)) {
        try {
          await fileSystem.writeFile(stopPath, "stop\n", "utf8");
          if (primaryError.launcherStillAlive === true) {
            await forceStopLauncher(
              launcher,
              outcomePromise,
              forceStopTimeoutMs,
            );
          } else {
            try {
              await waitForOutcome(
                outcomePromise,
                cleanupTimeoutMs,
                "META_KIM_WINDOWS_JOB_PROCESS_GROUP_DRAIN_FAILED",
                "finally_launcher_exit_unverified",
                "windows_job_object_owned_process_group",
              );
              await readWindowsResult(resultPath, fileSystem);
            } catch (waitError) {
              await forceStopLauncher(
                launcher,
                outcomePromise,
                forceStopTimeoutMs,
              );
              throw waitError;
            }
          }
        } catch (cleanupError) {
          primaryError = cleanupFailure(
            cleanupError,
            "META_KIM_WINDOWS_JOB_PROCESS_GROUP_FINAL_CLEANUP_FAILED",
            "finally_launcher_cleanup_failed",
            "windows_job_object_owned_process_group",
          );
        }
      }
    }

    if (childIsRunning(launcher)) {
      primaryError ??= cleanupFailure(
        null,
        "META_KIM_WINDOWS_PROCESS_LAUNCHER_FORCE_STOP_FAILED",
        "launcher_still_alive_control_directory_retained",
        "windows_job_object_owned_process_group",
      );
      primaryError.launcherStillAlive = true;
      primaryError.runnerControlDirectoryRetained = true;
    } else {
      try {
        await fileSystem.rm(guardDir, { recursive: true, force: true });
      } catch (error) {
        const tempCleanupError = new Error(
          "Runner control-directory cleanup failed",
          { cause: error },
        );
        tempCleanupError.code = "META_KIM_RUNNER_CONTROL_DIRECTORY_CLEANUP_FAILED";
        tempCleanupError.runnerControlDirectoryRetained = true;
        if (primaryError) {
          primaryError.runnerControlDirectoryRetained = true;
          primaryError.secondaryCleanupFailures = [
            ...(primaryError.secondaryCleanupFailures ?? []),
            {
              code: tempCleanupError.code,
              reason: "runner_temp_cleanup_failed",
            },
          ];
        } else {
          primaryError = tempCleanupError;
        }
      }
    }
    if (primaryError) {
      const snapshots = outputSnapshots(stdoutCapture, stderrCapture);
      if (!primaryError.stdoutMetadata || !primaryError.stderrMetadata) {
        attachOutput(
          primaryError,
          snapshots,
          options,
          primaryError.code === "META_KIM_COMMAND_OUTPUT_LIMIT_EXCEEDED",
        );
      }
      if (
        primaryError.ownedProcessGroupCleanupFailure === true &&
        primaryError.ownedProcessGroupCleanupVerified !== true
      ) {
        attachOwnedProcessGroupTruth(primaryError, {
          verified: false,
          failure: true,
          reason:
            primaryError.ownedProcessGroupCleanupReason ??
            "cleanup_unverified",
          survivorCount:
            primaryError.ownedProcessGroupSurvivorCount ??
            null,
          scope:
            primaryError.ownedProcessGroupScope ??
            "windows_job_object_owned_process_group",
        });
      }
      throw primaryError;
    }
    return returnValue;
  };
}

export const runWindowsGuardedCommand = createWindowsGuardedCommandRunner();

/** Run a command with ignored stdin and runner-owned process-group cleanup. */
export async function runCommandWithIgnoredStdin(file, args, options = {}) {
  if (process.platform === "win32") {
    return runWindowsGuardedCommand(file, args, options);
  }
  return runPosixGuardedCommand(file, args, options);
}

/** Stop every runner-owned process and propagate cleanup failures after all settle. */
export async function cleanupActiveChildren(reason = "cleanup") {
  if (cleanupInFlight) return cleanupInFlight;
  cleanupInFlight = (async () => {
    const entries = [...activeChildren.values()];
    const results = await Promise.all(
      entries.map(async (entry) => {
        try {
          await entry.stop(reason);
          return null;
        } catch (error) {
          return cleanupFailure(
            error,
            "META_KIM_ACTIVE_CHILD_CLEANUP_FAILED",
            `active_child_cleanup_failed:${entry.label}`,
          );
        }
      }),
    );
    const failures = results.filter(Boolean);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Failed to clean ${failures.length} active child process(es)`,
      );
    }
  })();
  try {
    await cleanupInFlight;
  } finally {
    cleanupInFlight = null;
  }
}

/** Install fail-closed SIGINT/SIGTERM cleanup for runner-owned processes. */
export function installSignalCleanup({ log = () => {} } = {}) {
  const handleSignal = (signal) => {
    void cleanupActiveChildren(`received ${signal}`).then(
      () => {
        process.exitCode = 130;
        process.exit();
      },
      (error) => {
        log(`Signal cleanup failed: ${error.message}`);
        process.exitCode = 1;
        process.exit();
      },
    );
  };
  process.once("SIGINT", () => handleSignal("SIGINT"));
  process.once("SIGTERM", () => handleSignal("SIGTERM"));
}
