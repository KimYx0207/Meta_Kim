import { renameSync } from "node:fs";
import process from "node:process";

export const WINDOWS_TRANSIENT_RENAME_CODES = Object.freeze([
  "EACCES",
  "EBUSY",
  "EPERM",
]);

function synchronousWait(delayMs) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

/**
 * Retry only Windows' documented transient directory-lock failures.
 * Persistent and non-lock errors remain fail-closed.
 */
export function renameWithTransientRetry(
  source,
  target,
  {
    rename = renameSync,
    platform = process.platform,
    attempts = 6,
    initialDelayMs = 50,
    wait = synchronousWait,
  } = {},
) {
  const maxAttempts = Number.isInteger(attempts) && attempts > 0 ? attempts : 1;
  const retryable = new Set(WINDOWS_TRANSIENT_RENAME_CODES);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      rename(source, target);
      return;
    } catch (error) {
      if (
        platform !== "win32" ||
        !retryable.has(error?.code) ||
        attempt === maxAttempts
      ) {
        throw error;
      }
      wait(Math.min(initialDelayMs * (2 ** (attempt - 1)), 800));
    }
  }
}

/**
 * Async counterpart for promise-based filesystem workflows.
 */
export async function renameWithTransientRetryAsync(
  source,
  target,
  {
    rename,
    platform = process.platform,
    attempts = 6,
    initialDelayMs = 50,
    wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  } = {},
) {
  if (typeof rename !== "function") {
    throw new TypeError("rename must be a function");
  }
  const maxAttempts = Number.isInteger(attempts) && attempts > 0 ? attempts : 1;
  const retryable = new Set(WINDOWS_TRANSIENT_RENAME_CODES);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (
        platform !== "win32" ||
        !retryable.has(error?.code) ||
        attempt === maxAttempts
      ) {
        throw error;
      }
      await wait(Math.min(initialDelayMs * (2 ** (attempt - 1)), 800));
    }
  }
}
