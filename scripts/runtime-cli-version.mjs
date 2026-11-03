import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";

// Cold CLI startup on the maintainer host has taken 4–7 seconds. Keep the
// shared limit above that observed range while still bounding every probe.
export const DEFAULT_RUNTIME_CLI_VERSION_TIMEOUT_MS = 10_000;

function executableHeader(file) {
  const fd = openSync(file, "r"), bytes = Buffer.alloc(64 * 1024);
  try { return bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0)); }
  finally { closeSync(fd); }
}

function windowsMounted(file, mountInfo) {
  const decode = value => value.replace(/\\([0-7]{3})/gu, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
  return mountInfo.split("\n").some(line => {
    const [before, after] = line.split(" - ");
    if (!after || !/\b(?:drvfs|aname=drvfs)\b/iu.test(after)) return false;
    const mount = decode(before.split(" ")[4] ?? "");
    return mount && (file === mount || file.startsWith(mount.endsWith("/") ? mount : mount + "/"));
  });
}

function launchesWindowsExecutable(script) {
  const lines=script.split(/\r?\n/u).map(line=>line.trim()).filter(line=>line && !/^(?:#|echo(?:\s|$)|printf(?:\s|$))/u.test(line));
  const prefix="^(?:(?:[A-Za-z_][A-Za-z0-9_]*=\\S+)\\s+)*(?:exec\\s+)?";
  const command=new RegExp(prefix+"(?:\"[^\"]+\\.exe\"|'[^']+\\.exe'|[^\\s\"']+\\.exe)(?:\\s|$)","iu");
  if(lines.some(line=>command.test(line)))return true;
  const assigned=lines.map(line=>line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"\r\n]+\.exe"|'[^'\r\n]+\.exe'|[^\s]+\.exe)$/iu)?.[1]).filter(Boolean);
  return assigned.some(name=>lines.some(line=>new RegExp(prefix+`["']?\\$(?:${name}|\\{${name}\\})["']?(?:\\s|$)`,"u").test(line)));
}

/** Inspect the file actually selected from PATH, not WSL environment claims. */
export function runtimeCliProbeEligibility(file, { platform = process.platform, mountInfo } = {}) {
  const physical = realpathSync(file), header = executableHeader(physical);
  const pe = header.length >= 2 && header[0] === 0x4d && header[1] === 0x5a;
  if (platform !== "win32") {
    if (pe || /\.(?:exe|com|cmd|bat|ps1)$/iu.test(physical)) return { eligible:false, reason:"windows_executable_on_posix", physical };
    if (header.subarray(0, 2).toString() === "#!") {
      const script = header.toString("utf8");
      if (launchesWindowsExecutable(script)) return { eligible:false, reason:"windows_launcher_on_posix", physical };
      if (platform === "linux") {
        const mounts = mountInfo ?? (existsSync("/proc/self/mountinfo") ? readFileSync("/proc/self/mountinfo", "utf8") : "");
        if (windowsMounted(physical, mounts) && (existsSync(physical + ".cmd") || existsSync(physical + ".exe"))) {
          return { eligible:false, reason:"windows_mounted_shim", physical };
        }
      }
    }
  } else if (pe) {
    const peOffset = header.length >= 64 ? header.readUInt32LE(60) : header.length;
    const subsystemOffset = peOffset + 24 + 68;
    if (subsystemOffset + 2 > header.length || header.toString("binary", peOffset, peOffset + 4) !== "PE\0\0") {
      return { eligible:false, reason:"unrecognized_pe_executable", physical };
    }
    const subsystem = header.readUInt16LE(subsystemOffset);
    if (subsystem !== 3) return { eligible:false, reason:subsystem === 2 ? "gui_executable" : "non_console_executable", physical };
  }
  return { eligible:true, physical };
}

/** The default version execution path for detection and identity recording. */
export function runRuntimeCliVersion(launcher, args, descriptor, { env=process.env, cwd=process.cwd(),
  platform=process.platform, timeoutMs=DEFAULT_RUNTIME_CLI_VERSION_TIMEOUT_MS } = {}) {
  const components=[launcher,descriptor?.discoveredEntry,descriptor?.shim,descriptor?.jsEntry]
    .filter(Boolean).map(value=>typeof value === "string" ? value : value.realpath);
  for(const file of new Set(components)) {
    const checked=runtimeCliProbeEligibility(file,{platform});
    if(!checked.eligible)return {status:null,stdout:"",stderr:`Runtime CLI version probe refused: ${checked.reason}`,unprobed:true};
  }
  return spawnSync(launcher,args,{cwd,env,encoding:"utf8",windowsHide:true,shell:false,
    timeout:timeoutMs,killSignal:"SIGKILL",maxBuffer:64*1024});
}

