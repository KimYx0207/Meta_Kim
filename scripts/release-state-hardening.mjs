import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const OWN_PROCESS_IDENTITY_CACHE = new Map();

export const RELEASE_STATE_DURABILITY = Object.freeze({
  crashRecovery: "hash_bound_atomic_replace",
  fileDataFlush: "fsync_before_publish",
  parentDirectoryFlush:
    process.platform === "win32"
      ? "unsupported_by_node_on_windows"
      : "best_effort_fsync_when_filesystem_supports_directory_handles",
  universalPowerLossDurability: false,
  note:
    "Atomic/hash-bound records support process-crash recovery. File data is flushed before publication; parent-directory flush is used only where Node exposes reliable directory handles. No universal power-loss guarantee is claimed.",
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function sanitizeUserVisibleText(value, { roots = [] } = {}) {
  let text = String(value ?? "");
  for (const root of roots) {
    if (typeof root !== "string" || !root) continue;
    text = text.replace(new RegExp(escapeRegExp(path.resolve(root)), "giu"), "<path>");
  }
  text = text
    .replace(/[A-Za-z]:[\\/][^\r\n]*/gu, "<path>")
    .replace(/\\\\[^\\/\r\n]+[\\/][^\r\n]*/gu, "<path>")
    .replace(/(^|[\s("'=])\/(?!\/)[^\r\n]*/gu, "$1<path>");
  return text;
}

export function getProcessStartIdentity(pid, {
  platform = process.platform,
  runCommand = spawnSync,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const cacheKey = `${platform}:${pid}`;
  const cacheable = pid === process.pid && platform === process.platform && runCommand === spawnSync;
  if (cacheable && OWN_PROCESS_IDENTITY_CACHE.has(cacheKey)) {
    return OWN_PROCESS_IDENTITY_CACHE.get(cacheKey);
  }
  try {
    if (platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closeParen = stat.lastIndexOf(")");
      const fieldsAfterComm = stat.slice(closeParen + 2).trim().split(/\s+/u);
      const startTicks = fieldsAfterComm[19];
      const identity = /^\d+$/u.test(startTicks || "") ? `linux-proc-startticks:${startTicks}` : null;
      if (cacheable) OWN_PROCESS_IDENTITY_CACHE.set(cacheKey, identity);
      return identity;
    }
    if (platform === "win32") {
      const script = [
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop`,
        "if ($null -ne $p) { [Console]::Out.Write($p.CreationDate.ToUniversalTime().Ticks) }",
      ].join("; ");
      const result = runCommand(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", windowsHide: true, timeout: 5_000 },
      );
      const ticks = String(result?.stdout ?? "").trim();
      const identity = result?.status === 0 && /^\d+$/u.test(ticks)
        ? `windows-creation-ticks:${ticks}`
        : null;
      if (cacheable) OWN_PROCESS_IDENTITY_CACHE.set(cacheKey, identity);
      return identity;
    }
    if (platform === "darwin") {
      const result = runCommand(
        "ps",
        ["-o", "lstart=", "-p", String(pid)],
        { encoding: "utf8", timeout: 5_000 },
      );
      const started = String(result?.stdout ?? "").trim().replace(/\s+/gu, " ");
      const identity = result?.status === 0 && started ? `darwin-ps-lstart:${started}` : null;
      if (cacheable) OWN_PROCESS_IDENTITY_CACHE.set(cacheKey, identity);
      return identity;
    }
  } catch {
    // A missing reliable identity makes lock recovery fail safe for a live PID.
  }
  return null;
}

export function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

export function lockOwnerAppearsLive(owner) {
  if (!processIsAlive(owner?.pid)) return false;
  if (typeof owner?.processStartIdentity !== "string" || !owner.processStartIdentity) {
    return true;
  }
  const observed = getProcessStartIdentity(owner.pid);
  return observed == null || observed === owner.processStartIdentity;
}

export function flushFile(handle) {
  fsyncSync(handle);
}

export function flushParentDirectory(filePath) {
  if (process.platform === "win32") return false;
  let handle;
  try {
    handle = openSync(path.dirname(filePath), "r");
    fsyncSync(handle);
    return true;
  } catch (error) {
    if (["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error?.code)) return false;
    throw error;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}
