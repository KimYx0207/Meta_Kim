import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { platform } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

export const PROCESS_DISCOVERY_TIMEOUT_MS = 5_000;
export const WINDOWS_PROCESS_QUERY_TIMEOUT_MS = 8_000;
export const PROCESS_SIGNAL_TIMEOUT_MS = 30_000;

function normalizePath(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  return platform() === "win32" ? normalized.toLowerCase() : normalized;
}

function safeRealpath(filePath) {
  try {
    return existsSync(filePath) ? realpathSync(filePath) : null;
  } catch {
    return null;
  }
}

function isPlainDirectory(dirPath) {
  try {
    const metadata = lstatSync(dirPath);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function trustedRegularFile(filePath) {
  try {
    const metadata = lstatSync(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
    return realpathSync(filePath);
  } catch {
    return null;
  }
}

export function resolveTrustedWindowsSystemDirectory({
  reportProvider = () => process.report?.getReport?.(),
  kernelSystem32Path = String.raw`\\?\GLOBALROOT\SystemRoot\System32`,
} = {}) {
  try {
    const sharedObjects = reportProvider()?.sharedObjects;
    if (!Array.isArray(sharedObjects)) return null;
    const loadedModules = new Map();
    for (const modulePath of sharedObjects) {
      const moduleName = basename(String(modulePath || "")).toLowerCase();
      if (moduleName !== "kernel32.dll" && moduleName !== "ntdll.dll") continue;
      const trustedModule = trustedRegularFile(modulePath);
      if (!trustedModule || basename(trustedModule).toLowerCase() !== moduleName) return null;
      loadedModules.set(moduleName, trustedModule);
    }
    if (!loadedModules.has("kernel32.dll") || !loadedModules.has("ntdll.dll")) return null;
    const kernel32Dir = dirname(loadedModules.get("kernel32.dll"));
    const ntdllDir = dirname(loadedModules.get("ntdll.dll"));
    if (!pathEquals(kernel32Dir, ntdllDir) || !isPlainDirectory(kernel32Dir)) return null;

    const kernelAliasDir = existsSync(kernelSystem32Path)
      ? realpathSync.native(kernelSystem32Path)
      : null;
    if (!kernelAliasDir || !pathEquals(kernelAliasDir, kernel32Dir)) return null;
    return kernel32Dir;
  } catch {
    return null;
  }
}

export function resolveTrustedWindowsSystemTool(relativeSegments, options = {}) {
  try {
    if (
      !Array.isArray(relativeSegments) ||
      relativeSegments.length === 0 ||
      relativeSegments.some((segment) => (
        !segment || segment === "." || segment === ".." || /[\\/]/u.test(segment)
      ))
    ) return null;
    const system32 = resolveTrustedWindowsSystemDirectory(options);
    if (!system32) return null;
    let cursor = system32;
    for (const segment of relativeSegments.slice(0, -1)) {
      cursor = join(cursor, segment);
      if (!isPlainDirectory(cursor)) return null;
    }
    const candidate = trustedRegularFile(join(cursor, relativeSegments.at(-1)));
    if (!candidate) return null;
    const rel = relative(system32, candidate);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
    return candidate;
  } catch {
    return null;
  }
}

function pathEquals(left, right) {
  return Boolean(left && right) && normalizePath(left) === normalizePath(right);
}

function authorityPathEquals(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  return pathEquals(left, right);
}

function authorityPath(value) {
  if (typeof value !== "string" || !isAbsolute(value)) return null;
  return safeRealpath(value) ?? value;
}

function authorityPythonCommand(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.command === "string" && Array.isArray(value.args)) {
    return value.command;
  }
  return null;
}

/**
 * Validate the local Meta_Kim ownership evidence before a live listener may
 * be signalled.  The manifest flag is produced by setup after it verifies the
 * complete boot-artifact ownership chain; the active state binds that chain
 * to the exact runtime, interpreter, and database selected for this endpoint.
 */
export function verifyMcpMemoryRuntimeAuthority(
  authority,
  {
    memoryBin,
    pythonPath,
    databasePath,
  } = {},
) {
  if (!authority || typeof authority !== "object") {
    return { verified: false, reason: "runtime_authority_missing" };
  }
  if (authority.manifest?.verified !== true) {
    return {
      verified: false,
      reason: authority.manifest?.reason || "runtime_manifest_authority_missing",
    };
  }
  const active = authority.activeState;
  if (
    !active ||
    active.schemaVersion !== "meta-kim-mcp-memory-active-runtime-v1"
  ) {
    return { verified: false, reason: "active_runtime_state_invalid" };
  }
  const expectedMemoryBin = authorityPath(memoryBin);
  const activeMemoryBin = authorityPath(active.memoryBin);
  if (!expectedMemoryBin || !activeMemoryBin || !authorityPathEquals(activeMemoryBin, expectedMemoryBin)) {
    return { verified: false, reason: "active_runtime_memory_bin_mismatch" };
  }
  const expectedPython = authorityPath(authorityPythonCommand(pythonPath));
  const activePython = authorityPath(active.pythonPath);
  if (!expectedPython || !activePython || !authorityPathEquals(activePython, expectedPython)) {
    return { verified: false, reason: "active_runtime_python_mismatch" };
  }
  const expectedDatabase = authorityPath(databasePath);
  const activeDatabase = authorityPath(active.databasePath);
  if (
    !expectedDatabase ||
    !activeDatabase ||
    !authorityPathEquals(activeDatabase, expectedDatabase)
  ) {
    return { verified: false, reason: "active_runtime_database_mismatch" };
  }
  return {
    verified: true,
    evidence: {
      manifest: true,
      activeState: true,
      runtime: true,
    },
  };
}

function stripConfigValue(value) {
  const trimmed = String(value || "").trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readTrustedVenvConfig(venvDir) {
  try {
    const configPath = join(venvDir, "pyvenv.cfg");
    const metadata = lstatSync(configPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
    const config = readFileSync(configPath, "utf8");
    return {
      executable: stripConfigValue(config.match(/^executable\s*=\s*(.+)$/imu)?.[1]),
      home: stripConfigValue(config.match(/^home\s*=\s*(.+)$/imu)?.[1]),
    };
  } catch {
    return null;
  }
}

function basePythonFromVenvHome(config) {
  if (!config?.home || !isAbsolute(config.home)) return null;
  return trustedRegularFile(join(config.home, "python.exe"));
}

function isVenvPythonForBase(pythonPath, expectedBasePython) {
  try {
    const trustedPython = trustedRegularFile(pythonPath);
    if (!trustedPython || !expectedBasePython) return false;
    if (pathEquals(trustedPython, expectedBasePython)) return true;
    const scriptsDir = dirname(trustedPython);
    if (normalizePath(relative(dirname(scriptsDir), trustedPython)) !== "scripts/python.exe") {
      return false;
    }
    const nestedConfig = readTrustedVenvConfig(dirname(scriptsDir));
    return pathEquals(basePythonFromVenvHome(nestedConfig), expectedBasePython);
  } catch {
    return false;
  }
}

export function resolveWindowsVenvProcessExpectation(memoryBin) {
  try {
    if (!isAbsolute(memoryBin)) return null;
    const launcherInput = String(memoryBin);
    const scriptsDir = dirname(launcherInput);
    const venvDir = dirname(scriptsDir);
    if (!isPlainDirectory(venvDir) || !isPlainDirectory(scriptsDir)) return null;
    const launcherPath = trustedRegularFile(launcherInput);
    if (!launcherPath) return null;
    const launcherRel = normalizePath(relative(venvDir, launcherInput));
    if (launcherRel !== "scripts/memory.exe") return null;

    const config = readTrustedVenvConfig(venvDir);
    if (!config) {
      if (existsSync(join(venvDir, "pyvenv.cfg"))) return null;
      const basePython = trustedRegularFile(join(venvDir, "python.exe"));
      if (!basePython) return null;
      return {
        expectedExecutablePath: basePython,
        expectedExecutablePaths: [basePython],
        expectedLauncherPath: launcherPath,
        runtimeLayout: "base_python",
      };
    }
    const basePython = basePythonFromVenvHome(config);
    if (!basePython) return null;
    const configuredExecutable = config?.executable && isAbsolute(config.executable)
      ? trustedRegularFile(config.executable)
      : null;
    if (
      configuredExecutable &&
      !isVenvPythonForBase(configuredExecutable, basePython)
    ) return null;
    const venvPython = trustedRegularFile(join(scriptsDir, "python.exe"));
    if (venvPython && !isVenvPythonForBase(venvPython, basePython)) return null;
    const candidates = [basePython, configuredExecutable, venvPython].filter(Boolean);
    const uniqueCandidates = [...new Map(
      candidates.map((candidate) => [normalizePath(candidate), candidate]),
    ).values()];
    return {
      expectedExecutablePath: basePython,
      expectedExecutablePaths: uniqueCandidates,
      expectedLauncherPath: launcherPath,
      runtimeLayout: "venv",
    };
  } catch {
    return null;
  }
}

export function parseCommandLine(commandLine) {
  const args = [];
  const pattern = /"((?:\\.|[^"])*)"|'([^']*)'|(\S+)/gu;
  for (const match of String(commandLine || "").matchAll(pattern)) {
    args.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/\\"/g, '"'));
  }
  return args;
}

function hasSingleExactArgPair(argv, flag, value) {
  const values = argv.flatMap((entry, index) => (
    entry === flag && index + 1 < argv.length ? [argv[index + 1]] : []
  ));
  return values.length === 1 && values[0] === String(value);
}

function listenerHostMatches(actualHost, expectedHost) {
  const actual = String(actualHost || "").trim().toLowerCase().replace(/^\[|\]$/gu, "");
  const expected = String(expectedHost || "").trim().toLowerCase().replace(/^\[|\]$/gu, "");
  if (!actual || !expected) return false;
  if (actual === expected) return true;
  const loopbacks = new Set(["localhost", "127.0.0.1", "::1"]);
  return loopbacks.has(actual) && loopbacks.has(expected);
}

export function verifyMemoryListenerIdentity(identity, expected) {
  if (identity?.kind === "not_listening") {
    return { verified: false, reason: "listener_not_present" };
  }
  if (identity?.kind === "identity_unavailable") {
    return { verified: false, reason: identity.reason || "listener_identity_unavailable" };
  }
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 0) {
    return { verified: false, reason: "listener_pid_missing" };
  }
  if (!identity.startIdentity) {
    return { verified: false, reason: "start_identity_missing" };
  }
  if (String(identity.listenerPort ?? "") !== String(expected.port)) {
    return { verified: false, reason: "listener_port_mismatch" };
  }
  const listenerHosts = Array.isArray(identity.listenerHosts)
    ? identity.listenerHosts
    : identity.listenerHosts
      ? [identity.listenerHosts]
      : [identity.listenerHost];
  if (
    listenerHosts.length === 0 ||
    listenerHosts.some((host) => !listenerHostMatches(host, expected.host))
  ) {
    return { verified: false, reason: "listener_host_mismatch" };
  }
  const executable = safeRealpath(identity.executablePath) ?? identity.executablePath;
  const expectedExecutables = [
    ...(Array.isArray(expected.executablePaths) ? expected.executablePaths : []),
    expected.executablePath,
  ]
    .filter(Boolean)
    .map((candidate) => safeRealpath(candidate) ?? candidate);
  const argv = Array.isArray(identity.argv) ? identity.argv : [];
  if (!executable || !expectedExecutables.some((candidate) => pathEquals(executable, candidate))) {
    return { verified: false, reason: "executable_mismatch" };
  }
  if (!pathEquals(safeRealpath(argv[0]) ?? argv[0], executable)) {
    return { verified: false, reason: "executable_argv_slot_mismatch" };
  }
  if (expected.launcherPath) {
    const expectedLauncher = safeRealpath(expected.launcherPath) ?? expected.launcherPath;
    const argvLauncher = safeRealpath(argv[1]) ?? argv[1];
    if (!expectedLauncher || !pathEquals(argvLauncher, expectedLauncher)) {
      return { verified: false, reason: "launcher_argv_slot_mismatch" };
    }
  }
  if (!hasSingleExactArgPair(argv, "--http-host", expected.host)) {
    return { verified: false, reason: "host_argv_mismatch" };
  }
  if (!hasSingleExactArgPair(argv, "--http-port", expected.port)) {
    return { verified: false, reason: "port_argv_mismatch" };
  }
  if (!argv.some((entry, index) => entry === "server" && argv[index + 1] === "--http")) {
    return { verified: false, reason: "server_argv_mismatch" };
  }
  return {
    verified: true,
    evidence: {
      pid: identity.pid,
      startIdentity: identity.startIdentity,
      executablePath: executable,
      launcherPath: expected.launcherPath ?? null,
      host: expected.host,
      port: String(expected.port),
    },
  };
}

function parseLocalEndpoint(value) {
  const endpoint = String(value || "");
  const bracketed = endpoint.match(/^\[([^[]+)\]:(\d+)$/u);
  if (bracketed) return { host: bracketed[1], port: bracketed[2] };
  const plain = endpoint.match(/^(.*):(\d+)$/u);
  return plain ? { host: plain[1], port: plain[2] } : null;
}

export function parseWindowsNetstatListeners(output, expectedPort) {
  const requestedPort = String(Number(expectedPort));
  if (!/^\d+$/u.test(requestedPort)) {
    return { ok: false, reason: "invalid_port" };
  }
  const listeners = [];
  for (const rawLine of String(output || "").split(/\r?\n/u)) {
    const fields = rawLine.trim().split(/\s+/u);
    if (fields.length < 5 || fields[0]?.toUpperCase() !== "TCP") continue;
    if (fields.at(-2)?.toUpperCase() !== "LISTENING") continue;
    const local = parseLocalEndpoint(fields[1]);
    const pid = Number(fields.at(-1));
    if (
      !local ||
      String(Number(local.port)) !== requestedPort ||
      !Number.isInteger(pid) ||
      pid <= 0
    ) continue;
    listeners.push({ pid, host: local.host });
  }
  if (listeners.length === 0) return { ok: false, reason: "not_listening" };
  const pids = [...new Set(listeners.map(({ pid }) => pid))];
  if (pids.length !== 1) {
    return { ok: false, reason: "ambiguous_listener_pids", pids };
  }
  return {
    ok: true,
    pid: pids[0],
    listenerHosts: [...new Set(listeners.map(({ host }) => host))],
    listenerPort: requestedPort,
  };
}

function inspectionUnavailable(reason, evidence = {}) {
  return { kind: "identity_unavailable", reason, ...evidence };
}

function inspectionNotListening(reason = "not_listening") {
  return { kind: "not_listening", reason };
}

export function isEndpointNotListening(inspection) {
  return inspection?.kind === "not_listening";
}

export function isEndpointListenerIdentity(inspection) {
  return inspection?.kind === "listening" || (
    !inspection?.kind && Number.isInteger(inspection?.pid) && inspection.pid > 0
  );
}

export function inspectWindowsEndpointListener(
  { port },
  {
    run = spawnSync,
    netstatPath = resolveTrustedWindowsSystemTool(["netstat.exe"]),
    powershellPath = resolveTrustedWindowsSystemTool([
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ]),
    discoveryTimeoutMs = PROCESS_DISCOVERY_TIMEOUT_MS,
    processQueryTimeoutMs = WINDOWS_PROCESS_QUERY_TIMEOUT_MS,
  } = {},
) {
  if (!netstatPath || !powershellPath) {
    return inspectionUnavailable("system_process_tool_unavailable");
  }
  const listenerResult = run(netstatPath, ["-ano", "-p", "tcp"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: discoveryTimeoutMs,
  });
  if (
    listenerResult.error ||
    listenerResult.status !== 0 ||
    typeof listenerResult.stdout !== "string"
  ) return inspectionUnavailable("listener_discovery_failed");
  const listener = parseWindowsNetstatListeners(listenerResult.stdout, port);
  if (!listener.ok) {
    if (listener.reason === "not_listening") return inspectionNotListening();
    return inspectionUnavailable(listener.reason, { pids: listener.pids ?? [] });
  }

  const script = [
    `$ErrorActionPreference='Stop'`,
    `$source=@'`,
    `using System;`,
    `using System.ComponentModel;`,
    `using System.Runtime.InteropServices;`,
    `public static class MetaKimNativeProcessProbe {`,
    `  [StructLayout(LayoutKind.Sequential)]`,
    `  private struct UnicodeString { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }`,
    `  [DllImport("kernel32.dll", SetLastError=true)]`,
    `  private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);`,
    `  [DllImport("kernel32.dll")]`,
    `  private static extern bool CloseHandle(IntPtr handle);`,
    `  [DllImport("ntdll.dll")]`,
    `  private static extern int NtQueryInformationProcess(IntPtr processHandle, int infoClass, IntPtr info, int infoLength, out int returnLength);`,
    `  public static string ReadCommandLine(int processId) {`,
    `    IntPtr handle = OpenProcess(0x1000, false, processId);`,
    `    if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());`,
    `    IntPtr buffer = IntPtr.Zero;`,
    `    try {`,
    `      int length;`,
    `      NtQueryInformationProcess(handle, 60, IntPtr.Zero, 0, out length);`,
    `      if (length <= Marshal.SizeOf(typeof(UnicodeString))) throw new InvalidOperationException("command line unavailable");`,
    `      buffer = Marshal.AllocHGlobal(length);`,
    `      int status = NtQueryInformationProcess(handle, 60, buffer, length, out length);`,
    `      if (status != 0) throw new InvalidOperationException("NtQueryInformationProcess failed: " + status);`,
    `      UnicodeString value = (UnicodeString)Marshal.PtrToStructure(buffer, typeof(UnicodeString));`,
    `      return Marshal.PtrToStringUni(value.Buffer, value.Length / 2);`,
    `    } finally {`,
    `      if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);`,
    `      CloseHandle(handle);`,
    `    }`,
    `  }`,
    `}`,
    `'@`,
    `Add-Type -TypeDefinition $source -Language CSharp`,
    `$p=Get-Process -Id ${listener.pid} -ErrorAction Stop`,
    `$commandLine=[MetaKimNativeProcessProbe]::ReadCommandLine(${listener.pid})`,
    `[pscustomobject]@{pid=[int]$p.Id;executablePath=$p.Path;commandLine=$commandLine;startIdentity=[string]$p.StartTime.ToUniversalTime().Ticks}|ConvertTo-Json -Compress`,
  ].join("\n");
  const result = run(powershellPath, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: processQueryTimeoutMs,
  });
  if (
    result.error ||
    result.status !== 0 ||
    typeof result.stdout !== "string" ||
    !result.stdout.trim()
  ) {
    return inspectionUnavailable("process_query_failed", {
      pid: listener.pid,
      listenerHosts: listener.listenerHosts,
      listenerPort: listener.listenerPort,
    });
  }
  try {
    const parsed = JSON.parse(result.stdout.trim().replace(/^\uFEFF/u, ""));
    if (Number(parsed.pid) !== listener.pid) {
      return inspectionUnavailable("process_query_pid_mismatch", {
        pid: listener.pid,
        listenerHosts: listener.listenerHosts,
        listenerPort: listener.listenerPort,
      });
    }
    return {
      ...parsed,
      kind: "listening",
      pid: listener.pid,
      listenerHosts: listener.listenerHosts,
      listenerPort: listener.listenerPort,
      argv: parseCommandLine(parsed.commandLine),
    };
  } catch {
    return inspectionUnavailable("process_query_parse_failed", {
      pid: listener.pid,
      listenerHosts: listener.listenerHosts,
      listenerPort: listener.listenerPort,
    });
  }
}

function linuxStartIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    return stat.slice(close + 2).split(/\s+/u)[19] || null;
  } catch {
    return null;
  }
}

function inspectLinuxListener({ hostname, port }) {
  const result = spawnSync("ss", ["-ltnp", `sport = :${port}`], {
    encoding: "utf8",
    shell: false,
    timeout: PROCESS_DISCOVERY_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) {
    return inspectionUnavailable("listener_discovery_failed");
  }
  const pid = Number(result.stdout.match(/pid=(\d+)/u)?.[1]);
  if (!Number.isInteger(pid) || pid <= 0) {
    return /\bLISTEN\b/u.test(result.stdout)
      ? inspectionUnavailable("listener_pid_unavailable")
      : inspectionNotListening();
  }
  try {
    const executablePath = realpathSync(`/proc/${pid}/exe`);
    const argv = readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0").filter(Boolean);
    return {
      kind: "listening",
      pid,
      listenerHost: hostname,
      listenerPort: String(port),
      executablePath,
      argv,
      startIdentity: linuxStartIdentity(pid),
    };
  } catch {
    return inspectionUnavailable("process_query_failed", {
      pid,
      listenerHost: hostname,
      listenerPort: String(port),
    });
  }
}

function inspectDarwinListener({ hostname, port }) {
  const listener = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], {
    encoding: "utf8",
    shell: false,
    timeout: PROCESS_DISCOVERY_TIMEOUT_MS,
  });
  if (listener.error) return inspectionUnavailable("listener_discovery_failed");
  if (listener.status !== 0) {
    return !listener.stdout?.trim() && !listener.stderr?.trim()
      ? inspectionNotListening()
      : inspectionUnavailable("listener_discovery_failed");
  }
  const pid = Number(listener.stdout.match(/^p(\d+)$/mu)?.[1]);
  if (!Number.isInteger(pid) || pid <= 0) {
    return listener.stdout.trim()
      ? inspectionUnavailable("listener_pid_unavailable")
      : inspectionNotListening();
  }
  const readField = (field) => spawnSync("ps", ["-ww", "-p", String(pid), "-o", `${field}=`], {
    encoding: "utf8",
    shell: false,
    timeout: PROCESS_DISCOVERY_TIMEOUT_MS,
  });
  const started = readField("lstart");
  const executable = readField("comm");
  const command = readField("command");
  if ([started, executable, command].some((result) => (
    result.error || result.status !== 0 || !result.stdout.trim()
  ))) {
    return inspectionUnavailable("process_query_failed", {
      pid,
      listenerHost: hostname,
      listenerPort: String(port),
    });
  }
  const commandLine = command.stdout.trim();
  const argv = parseCommandLine(commandLine);
  return {
    kind: "listening",
    pid,
    listenerHost: hostname,
    listenerPort: String(port),
    startIdentity: started.stdout.trim(),
    executablePath: safeRealpath(executable.stdout.trim()) ?? executable.stdout.trim(),
    argv,
  };
}

export function inspectEndpointListener(endpoint, options = {}) {
  if (platform() === "win32") return inspectWindowsEndpointListener(endpoint, options);
  if (platform() === "darwin") return inspectDarwinListener(endpoint);
  return inspectLinuxListener(endpoint);
}

export function signalEndpointProcess(pid, { force = false } = {}) {
  if (platform() === "win32") {
    const args = ["/PID", String(pid), ...(force ? ["/F"] : [])];
    const taskkillPath = resolveTrustedWindowsSystemTool(["taskkill.exe"]);
    if (!taskkillPath) return false;
    const result = spawnSync(taskkillPath, args, {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: PROCESS_SIGNAL_TIMEOUT_MS,
    });
    return !result.error && result.status === 0;
  }
  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

export async function stopVerifiedEndpointProcess({
  endpoint,
  expectedExecutablePath,
  expectedExecutablePaths = null,
  expectedLauncherPath = null,
  expectedPythonPath = null,
  expectedDatabasePath = null,
  runtimeAuthority = null,
  resolveRuntimeAuthority = null,
  requireRuntimeAuthority = false,
  platformName = platform(),
  inspect = inspectEndpointListener,
  signal = signalEndpointProcess,
  graceMs = 5_000,
  forceWaitMs = 5_000,
  pollMs = 100,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const expected = {
    platform: platformName,
    executablePath: expectedExecutablePath,
    executablePaths: expectedExecutablePaths,
    launcherPath: expectedLauncherPath,
    host: endpoint.hostname,
    port: endpoint.port,
  };
  const checkRuntimeAuthority = () => {
    if (!requireRuntimeAuthority) return { verified: true };
    let authority = runtimeAuthority;
    try {
      if (typeof resolveRuntimeAuthority === "function") {
        authority = resolveRuntimeAuthority();
      }
    } catch {
      authority = null;
    }
    return verifyMcpMemoryRuntimeAuthority(authority, {
      memoryBin: expectedLauncherPath,
      pythonPath: expectedPythonPath,
      databasePath: expectedDatabasePath,
    });
  };
  const initial = inspect(endpoint);
  if (isEndpointNotListening(initial)) {
    return { ok: true, stopped: false, reason: "not_listening" };
  }
  if (!isEndpointListenerIdentity(initial)) {
    return {
      ok: false,
      stopped: false,
      reason: initial?.reason || "listener_inspection_unavailable",
    };
  }
  const verification = verifyMemoryListenerIdentity(initial, expected);
  if (!verification.verified) return { ok: false, stopped: false, reason: verification.reason };
  const beforeGraceful = inspect(endpoint);
  if (!isEndpointListenerIdentity(beforeGraceful)) {
    return {
      ok: false,
      stopped: false,
      reason: isEndpointNotListening(beforeGraceful)
        ? "listener_changed_before_graceful_signal"
        : beforeGraceful?.reason || "graceful_revalidation_unavailable",
      evidence: verification.evidence,
    };
  }
  const gracefulVerification = verifyMemoryListenerIdentity(beforeGraceful, expected);
  if (
    !gracefulVerification.verified ||
    beforeGraceful.pid !== initial.pid ||
    beforeGraceful.startIdentity !== initial.startIdentity
  ) {
    return { ok: false, stopped: false, reason: "graceful_revalidation_failed", evidence: verification.evidence };
  }
  const authorityBeforeGracefulSignal = checkRuntimeAuthority();
  if (!authorityBeforeGracefulSignal.verified) {
    return {
      ok: false,
      stopped: false,
      reason: authorityBeforeGracefulSignal.reason,
      evidence: verification.evidence,
    };
  }
  const gracefulSignalled = signal(initial.pid, { force: false });
  let beforeForce;
  if (!gracefulSignalled) {
    if (platformName !== "win32") {
      return { ok: false, stopped: false, reason: "graceful_signal_failed", evidence: verification.evidence };
    }
    const afterFailedGraceful = inspect(endpoint);
    if (isEndpointNotListening(afterFailedGraceful)) {
      return { ok: true, stopped: true, forced: false, evidence: verification.evidence };
    }
    if (!isEndpointListenerIdentity(afterFailedGraceful)) {
      return {
        ok: false,
        stopped: false,
        reason: afterFailedGraceful?.reason || "failed_graceful_revalidation_unavailable",
        evidence: verification.evidence,
      };
    }
    beforeForce = afterFailedGraceful;
  } else {
    const attempts = Math.max(1, Math.ceil(graceMs / pollMs));
    for (let index = 0; index < attempts; index += 1) {
      await sleep(pollMs);
      const current = inspect(endpoint);
      if (isEndpointNotListening(current)) {
        return { ok: true, stopped: true, forced: false, evidence: verification.evidence };
      }
      if (!isEndpointListenerIdentity(current)) {
        return {
          ok: false,
          stopped: false,
          reason: current?.reason || "post_graceful_inspection_unavailable",
          evidence: verification.evidence,
        };
      }
    }
    beforeForce = inspect(endpoint);
  }

  if (!isEndpointListenerIdentity(beforeForce)) {
    return {
      ok: false,
      stopped: false,
      reason: isEndpointNotListening(beforeForce)
        ? "listener_changed_before_force_signal"
        : beforeForce?.reason || "force_revalidation_unavailable",
      evidence: verification.evidence,
    };
  }
  const forceVerification = verifyMemoryListenerIdentity(beforeForce, expected);
  if (
    !forceVerification.verified ||
    beforeForce.pid !== initial.pid ||
    beforeForce.startIdentity !== initial.startIdentity
  ) {
    return { ok: false, stopped: false, reason: "force_revalidation_failed", evidence: verification.evidence };
  }
  const authorityBeforeForceSignal = checkRuntimeAuthority();
  if (!authorityBeforeForceSignal.verified) {
    return {
      ok: false,
      stopped: false,
      reason: authorityBeforeForceSignal.reason,
      evidence: verification.evidence,
    };
  }
  const forceSignalled = signal(initial.pid, { force: true });
  if (!forceSignalled && platformName !== "win32") {
    return { ok: false, stopped: false, reason: "force_signal_failed", evidence: verification.evidence };
  }
  const forceAttempts = platformName === "win32"
    ? Math.max(1, Math.ceil(forceWaitMs / pollMs))
    : 1;
  for (let index = 0; index < forceAttempts; index += 1) {
    await sleep(pollMs);
    const afterForce = inspect(endpoint);
    if (isEndpointNotListening(afterForce)) {
      return { ok: true, stopped: true, forced: true, evidence: verification.evidence };
    }
    if (!isEndpointListenerIdentity(afterForce)) {
      return {
        ok: false,
        stopped: false,
        reason: afterForce?.reason || "post_force_inspection_unavailable",
        evidence: verification.evidence,
      };
    }
    const afterForceVerification = verifyMemoryListenerIdentity(afterForce, expected);
    if (
      !afterForceVerification.verified ||
      afterForce.pid !== initial.pid ||
      afterForce.startIdentity !== initial.startIdentity
    ) {
      return {
        ok: false,
        stopped: false,
        reason: "post_force_listener_changed",
        evidence: verification.evidence,
      };
    }
  }
  return {
    ok: false,
    stopped: false,
    reason: forceSignalled ? "listener_survived_force" : "force_signal_failed",
    evidence: verification.evidence,
  };
}
