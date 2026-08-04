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
    return { launcher: target, jsEntry: null, argsPrefix: [] };
  }
  const localNode = path.join(path.dirname(cmdPath), "node.exe");
  const launcher = existsSync(localNode) ? localNode : process.execPath;
  return { launcher, jsEntry: target, argsPrefix: [target] };
}

function windowsSearchDirectories(commandText, pathValue) {
  const hasPath = path.win32.isAbsolute(commandText) || /[\\/]/u.test(commandText);
  return {
    hasPath,
    directories: hasPath
      ? [""]
      : String(pathValue ?? "")
          .split(";")
          .map((entry) => entry.replace(/^"|"$/gu, "").trim())
          .filter(Boolean),
  };
}

export function resolveWindowsCliLaunchDescriptor(
  command,
  { env = process.env, pathValue = null } = {},
) {
  const commandText = String(command);
  const { hasPath, directories } = windowsSearchDirectories(
    commandText,
    pathValue ?? env.PATH ?? env.Path ?? "",
  );
  const extensions = path.win32.extname(commandText)
    ? [""]
    : ["", ".exe", ".com", ".cmd", ".bat"];
  for (const directory of directories) {
    const candidates = extensions
      .map((extension) => hasPath
        ? `${commandText}${extension}`
        : path.join(directory, `${commandText}${extension}`))
      .filter((candidate) => existsSync(candidate));
    if (candidates.length === 0) continue;
    const discoveredEntry = candidates[0];
    const native = candidates.find((candidate) => /\.(?:exe|com)$/iu.test(candidate));
    if (native) {
      return {
        platform: "win32",
        source: "native_executable",
        discoveredEntry,
        shim: null,
        launcher: native,
        jsEntry: null,
        argsPrefix: [],
      };
    }
    for (const candidate of candidates) {
      if (!/\.(?:cmd|bat)$/iu.test(candidate)) continue;
      const shim = resolveWindowsCmdShim(candidate);
      if (!shim) continue;
      return {
        platform: "win32",
        source: "node_or_native_shim_without_cmd",
        discoveredEntry,
        shim: candidate,
        launcher: shim.launcher,
        jsEntry: shim.jsEntry,
        argsPrefix: [...shim.argsPrefix],
      };
    }
  }
  throw new Error(`No shell-free Windows executable or supported Node shim found for ${commandText}`);
}

export function resolveWindowsCliInvocation(
  command,
  args = [],
  { env = process.env, pathValue = null } = {},
) {
  const launchDescriptor = resolveWindowsCliLaunchDescriptor(command, { env, pathValue });
  return {
    command: launchDescriptor.launcher,
    args: [...launchDescriptor.argsPrefix, ...args],
    source: launchDescriptor.source,
    launchDescriptor,
  };
}

export function resolveNpmCliJsPath({
  env = process.env,
  nodeExecutable = process.execPath,
  platform = process.platform,
  pathValue = null,
} = {}) {
  const candidates = [
    env.npm_execpath,
    path.join(path.dirname(nodeExecutable), "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(path.dirname(nodeExecutable), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);
  if (platform === "win32") {
    try {
      const descriptor = resolveWindowsCliLaunchDescriptor("npm", {
        env,
        pathValue: pathValue ?? env.PATH ?? env.Path ?? "",
      });
      if (descriptor.jsEntry) candidates.push(descriptor.jsEntry);
    } catch {
      // Keep the direct Node-layout candidates authoritative when PATH has no
      // supported npm shim. The final error below remains deterministic.
    }
  }
  const resolved = [...new Set(candidates)]
    .find((candidate) => path.isAbsolute(candidate) && existsSync(candidate));
  if (resolved) return resolved;
  throw new Error("Unable to resolve npm-cli.js from the active Node installation or PATH.");
}

export function resolveCliInvocation(command, args = [], options = {}) {
  if (process.platform === "win32") {
    return resolveWindowsCliInvocation(command, args, options);
  }
  return {
    command,
    args: [...args],
    source: "path_executable",
    launchDescriptor: {
      platform: process.platform,
      source: "path_executable",
      discoveredEntry: command,
      shim: null,
      launcher: command,
      jsEntry: null,
      argsPrefix: [],
    },
  };
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
    signal = null,
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
    let childError = null;
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
        signal: signal ?? undefined,
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
    child.on("error", (error) => {
      childError = error;
      if (!child.pid) finish(null, null, error);
    });
    child.on("close", (status, signal) => finish(status, signal, childError));
    child.stdin.on("error", () => {});
    child.stdin.end(String(input ?? ""));
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    timer.unref?.();
  });
}
