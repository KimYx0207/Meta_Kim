import { spawn } from "node:child_process";

// Fixed transport limits. The caller must still verify the reviewed source,
// route, receipt and exit-code/status binding before accepting any result.
export const CALCULATION_PROCESS_TIMEOUT_MS = 10000;
export const CALCULATION_PROCESS_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const TERMINATION_GRACE_MS = 250;

/** Send bounded, already-validated materials through a real asynchronous pipe.
 * Explicit EOF avoids relying on a synchronous writer while a bounded Python
 * read waits for the end of its input. Resolve after close, before removing the
 * caller's reviewed snapshot. This is a direct-child transport, not a sandbox.
 */
export function runCalculationProcess({ command, args, cwd, env, input }) {
  return new Promise((resolve) => {
    let child, processError, stdinError, timedOut = false, closed = false;
    let stdinFinished = false, outputBytes = 0, terminationTimer;
    const stdout = [], stderr = [];
    const stop = () => {
      if (!child || closed) return;
      child.kill("SIGTERM");
      terminationTimer ??= setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, TERMINATION_GRACE_MS);
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      processError ??= Object.assign(new Error("Calculation process timed out"), { code: "ETIMEDOUT" });
      stop();
    }, CALCULATION_PROCESS_TIMEOUT_MS);
    const finish = (status, signal) => {
      if (closed) return;
      closed = true;
      clearTimeout(deadline);
      clearTimeout(terminationTimer);
      // A reviewed tool may reject a malformed request before consuming it.
      // Only exit 2 can carry that EPIPE onward, and the caller must still check
      // the complete invalid_input receipt. Never accept an incomplete success.
      const earlyRejection = status === 2 && stdinError?.code === "EPIPE";
      if (stdinError && !earlyRejection) processError ??= stdinError;
      if (!processError && !signal && !stdinFinished && !earlyRejection) {
        processError = Object.assign(new Error("Calculation input did not finish"), { code: "ERR_CALCULATION_STDIN_INCOMPLETE" });
      }
      resolve({ pid: child?.pid, status, signal, error: processError, timedOut,
        stdinFinished, stdinErrorCode: stdinError?.code ?? null,
        stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    };
    try {
      child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      processError = error;
      finish(null, null);
      return;
    }
    child.once("error", (error) => { processError ??= error; });
    child.once("close", finish);
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on("data", (chunk) => {
        if (processError) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = CALCULATION_PROCESS_MAX_OUTPUT_BYTES - outputBytes;
        if (bytes.length > remaining) {
          if (remaining > 0) chunks.push(bytes.subarray(0, remaining));
          outputBytes = CALCULATION_PROCESS_MAX_OUTPUT_BYTES;
          processError = Object.assign(new Error("Calculation output exceeds its byte limit"), { code: "ENOBUFS" });
          stop();
          return;
        }
        chunks.push(bytes);
        outputBytes += bytes.length;
      });
      stream.once("error", (error) => { processError ??= error; stop(); });
    }
    child.stdin.once("finish", () => { stdinFinished = true; });
    child.stdin.once("error", (error) => {
      stdinError = error;
      if (error.code !== "EPIPE") { processError ??= error; stop(); }
    });
    try { child.stdin.end(input); }
    catch (error) { stdinError = error; processError ??= error; stop(); }
  });
}
