import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function resolveWindowsCmdShim(cmdPath) {
  const source = readFileSync(cmdPath, "utf8");
  const targetPattern = /"%(?:dp0%|~dp0)[\\/]([^"\r\n]+?\.(?:exe|com|cjs|mjs|js))"\s+%\*/giu;
  let match;
  let target = null;
  while ((match = targetPattern.exec(source)) !== null) {
    target = path.resolve(path.dirname(cmdPath), match[1]);
  }
  if (!target && /^npm(?:\.cmd)?$/iu.test(path.basename(cmdPath))) {
    target = path.join(path.dirname(cmdPath), "node_modules", "npm", "bin", "npm-cli.js");
  }
  if (!target || !existsSync(target)) return null;
  if (/\.(?:exe|com)$/iu.test(target)) {
    return { command: target, argsPrefix: [] };
  }
  return { command: process.execPath, argsPrefix: [target] };
}

export function resolveWindowsCliInvocation(
  command,
  args = [],
  { env = process.env, pathValue = null } = {},
) {
  const commandText = String(command);
  const hasPath = path.win32.isAbsolute(commandText) || /[\\/]/u.test(commandText);
  const searchDirs = hasPath
    ? [""]
    : String(pathValue ?? env.PATH ?? env.Path ?? "")
        .split(";")
        .map((entry) => entry.replace(/^"|"$/gu, "").trim())
        .filter(Boolean);
  const extensions = path.win32.extname(commandText)
    ? [""]
    : [".exe", ".com", ".cmd", ".bat"];
  for (const directory of searchDirs) {
    for (const extension of extensions) {
      const candidate = hasPath
        ? `${commandText}${extension}`
        : path.join(directory, `${commandText}${extension}`);
      if (!existsSync(candidate)) continue;
      if (/\.(?:exe|com)$/iu.test(candidate)) {
        return { command: candidate, args: [...args], source: "native_executable" };
      }
      if (/\.(?:cmd|bat)$/iu.test(candidate)) {
        const shim = resolveWindowsCmdShim(candidate);
        if (shim) {
          return {
            command: shim.command,
            args: [...shim.argsPrefix, ...args],
            source: "node_or_native_shim_without_cmd",
          };
        }
      }
    }
  }
  throw new Error(`No shell-free Windows executable or supported Node shim found for ${commandText}`);
}

export function resolveCliInvocation(command, args = [], options = {}) {
  if (process.platform === "win32") {
    return resolveWindowsCliInvocation(command, args, options);
  }
  return { command, args: [...args], source: "path_executable" };
}

export async function spawnCli(
  command,
  args,
  {
    cwd,
    env = process.env,
    input = "",
    timeoutMs = 300_000,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  } = {},
) {
  const invocation = resolveCliInvocation(command, args, { env });
  const startedAt = new Date();
  const startedHr = process.hrtime.bigint();
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let outputLimitExceeded = false;
    let timer = null;
    const finish = (status, signal, error = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const endedAt = new Date();
      const durationMs = Math.max(
        1,
        Number(process.hrtime.bigint() - startedHr) / 1_000_000,
      );
      resolve({
        status,
        signal,
        error,
        stdout,
        stderr,
        timedOut,
        outputLimitExceeded,
        command: invocation.command,
        args: invocation.args,
        launchSource: invocation.source,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs,
      });
    };
    let child;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd,
        env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      finish(null, null, error);
      return;
    }
    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > maxOutputBytes) {
        outputLimitExceeded = true;
        child.kill();
        return current;
      }
      return next;
    };
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => finish(null, null, error));
    child.on("close", (status, signal) => finish(status, signal));
    child.stdin.on("error", () => {});
    child.stdin.end(String(input ?? ""));
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    timer.unref?.();
  });
}
