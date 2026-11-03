import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { discoverRuntimeExecutablePaths } from "./runtime-executable-binding.mjs";
import { resolveWindowsCliLaunchDescriptor } from "./runtime-cli-invocation.mjs";
import { runtimeCliProbeEligibility, runRuntimeCliVersion, DEFAULT_RUNTIME_CLI_VERSION_TIMEOUT_MS } from "./runtime-cli-version.mjs";
export { runtimeCliProbeEligibility } from "./runtime-cli-version.mjs";

/** A bounded, shell-free version probe; failure is absence of probe evidence. */
export function probeRuntimeCli(name, { env = process.env, cwd = process.cwd(), timeoutMs = DEFAULT_RUNTIME_CLI_VERSION_TIMEOUT_MS,
  platform = process.platform } = {}) {
  if (!/^[a-z0-9][a-z0-9_-]*$/iu.test(name)) throw new TypeError("Runtime CLI name must be a simple command name");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("CLI probe timeout must be positive milliseconds");
  const deadline = Date.now() + timeoutMs;
  const boundedSpawn = (command, args, options = {}) => spawnSync(command, args, {
    ...options, cwd, env, shell:false, windowsHide:true, encoding:"utf8", maxBuffer:64 * 1024,
    timeout:Math.max(1, deadline - Date.now()), killSignal:"SIGKILL",
  });
  const candidates = discoverRuntimeExecutablePaths(name, { platform, env, locatorRunner:(command, args, options) => {
    const result = boundedSpawn(command, args, options);
    // where.exe may use a legacy Windows code page. A path decoded with the
    // wrong encoding must use existing direct PATH discovery, not a broken name.
    if (platform === "win32" && result.status === 0 && String(result.stdout ?? "").split(/\r?\n/u)
      .filter(Boolean).some(file => !existsSync(file.trim()))) return { ...result, status:1, stdout:"" };
    return result;
  } });
  let reason = candidates.length ? "no_eligible_cli" : "not_found";
  for (const candidate of candidates) {
    if (Date.now() >= deadline) return { status:"unprobed", version:null, reason:"timeout" };
    try {
      if (!path.isAbsolute(candidate) || !statSync(candidate).isFile()) continue;
      const entry = runtimeCliProbeEligibility(candidate, { platform });
      if (!entry.eligible) { reason=entry.reason; continue; }
      const descriptor = platform === "win32" ? resolveWindowsCliLaunchDescriptor(candidate, { env })
        : { launcher:entry.physical, argsPrefix:[] };
      const result = runRuntimeCliVersion(descriptor.launcher, [...descriptor.argsPrefix, "--version"], descriptor,
        { env, cwd, platform, timeoutMs:Math.max(1, deadline - Date.now()) });
      if (result.error?.code === "ETIMEDOUT") return { status:"unprobed", version:null, reason:"timeout", executablePath:entry.physical };
      const version = result.status === 0 ? String(result.stdout ?? "").split(/\r?\n/u)[0].trim() : "";
      if (version) return { status:"detected", version, executablePath:entry.physical };
      reason = result.error?.code ?? "version_probe_failed";
    } catch (error) {
      // A vanished/unreadable PATH entry does not hide a later usable CLI.
      reason = error.code ?? error.message;
    }
  }
  return { status:Date.now() >= deadline || candidates.length ? "unprobed" : "not_found", version:null,
    reason:Date.now() >= deadline ? "timeout" : reason };
}
