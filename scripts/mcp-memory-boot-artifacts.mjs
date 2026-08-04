import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { openRecorder } from "./install-manifest.mjs";

export const MCP_MEMORY_BOOT_ARTIFACT_SOURCE = "setup.mjs:mcp-memory-boot-artifacts";
export const MCP_MEMORY_BOOT_ARTIFACT_CATEGORY = "B";
export const MCP_MEMORY_BOOT_ARTIFACT_KIND = "file";
export const MCP_MEMORY_BOOT_ARTIFACT_OWNERSHIP_CLASS = "install_projection";
export const MCP_MEMORY_BOOT_ARTIFACT_RUNTIME_TARGET = null;

function platformPath(platformName) {
  if (platformName === "win32") return path.win32;
  if (["darwin", "linux"].includes(platformName)) return path.posix;
  throw new Error(`unsupported MCP Memory boot platform: ${platformName}`);
}

function assertAbsoluteHome(homeRoot, platformName) {
  const pathApi = platformPath(platformName);
  if (typeof homeRoot !== "string" || !pathApi.isAbsolute(homeRoot)) {
    throw new Error("MCP Memory boot artifact homeRoot must be absolute");
  }
  return pathApi.normalize(homeRoot);
}

function physicalPathKey(value, platformName) {
  const normalized = platformPath(platformName).normalize(value);
  return platformName === "win32" ? normalized.toLowerCase() : normalized;
}

function pathAtOrWithin(rootPath, candidatePath, platformName) {
  const pathApi = platformPath(platformName);
  const relativePath = pathApi.relative(rootPath, candidatePath);
  return relativePath === "" || (
    !pathApi.isAbsolute(relativePath) &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${pathApi.sep}`)
  );
}

function requirePlainPhysicalDirectory(directoryPath, platformName, { lstat, realpath }) {
  const stats = lstat(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${directoryPath}:unsafe_directory_type`);
  }
  const physicalPath = realpath(directoryPath);
  if (
    typeof physicalPath !== "string" ||
    physicalPathKey(physicalPath, platformName) !== physicalPathKey(directoryPath, platformName)
  ) {
    throw new Error(`${directoryPath}:linked_directory_ancestor`);
  }
  return platformPath(platformName).normalize(physicalPath);
}

/**
 * Capture one boot artifact only when its complete lexical path is also its
 * physical path. This inspection is deliberately host-native: emulated path
 * syntax cannot prove filesystem ownership.
 */
export function snapshotMcpMemoryBootArtifactFile({
  filePath,
  homeRoot,
  platformName = process.platform,
  readFile = readFileSync,
  lstat = lstatSync,
  realpath = (targetPath) => realpathSync.native(targetPath),
} = {}) {
  if (platformName !== process.platform) {
    throw new Error("MCP Memory boot artifact filesystem inspection requires the host platform");
  }
  const pathApi = platformPath(platformName);
  const home = assertAbsoluteHome(homeRoot, platformName);
  if (typeof filePath !== "string" || !pathApi.isAbsolute(filePath)) {
    throw new Error("MCP Memory boot artifact filePath must be absolute");
  }
  const lexicalPath = pathApi.normalize(filePath);
  if (!pathAtOrWithin(home, lexicalPath, platformName)) {
    throw new Error(`${lexicalPath}:outside_home`);
  }

  const homePhysicalPath = requirePlainPhysicalDirectory(home, platformName, {
    lstat,
    realpath,
  });
  const parentPath = pathApi.dirname(lexicalPath);
  const parentRelativePath = pathApi.relative(home, parentPath);
  let cursor = home;
  if (parentRelativePath) {
    for (const component of parentRelativePath.split(pathApi.sep).filter(Boolean)) {
      cursor = pathApi.join(cursor, component);
      requirePlainPhysicalDirectory(cursor, platformName, { lstat, realpath });
    }
  }

  const before = lstat(lexicalPath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`${lexicalPath}:not_regular_file`);
  }
  const physicalPath = realpath(lexicalPath);
  if (
    typeof physicalPath !== "string" ||
    physicalPathKey(physicalPath, platformName) !== physicalPathKey(lexicalPath, platformName)
  ) {
    throw new Error(`${lexicalPath}:linked_file`);
  }
  const normalizedPhysicalPath = pathApi.normalize(physicalPath);
  if (!pathAtOrWithin(homePhysicalPath, normalizedPhysicalPath, platformName)) {
    throw new Error(`${lexicalPath}:physical_path_outside_home`);
  }

  const bytes = readFile(lexicalPath);
  if (!Buffer.isBuffer(bytes)) {
    throw new Error(`${lexicalPath}:read_did_not_return_buffer`);
  }
  const after = lstat(lexicalPath);
  if (!after.isFile() || after.isSymbolicLink()) {
    throw new Error(`${lexicalPath}:concurrent_type_change`);
  }
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    bytes.length !== before.size ||
    bytes.length !== after.size
  ) {
    throw new Error(`${lexicalPath}:concurrent_change`);
  }
  return {
    bytes,
    size: bytes.length,
    sha256: sha256(bytes),
    dev: after.dev,
    ino: after.ino,
    physicalPath: normalizedPhysicalPath,
    homePhysicalPath,
  };
}

function descriptor(id, artifactPath, purpose) {
  return Object.freeze({
    id,
    path: artifactPath,
    source: MCP_MEMORY_BOOT_ARTIFACT_SOURCE,
    purpose,
    category: MCP_MEMORY_BOOT_ARTIFACT_CATEGORY,
    kind: MCP_MEMORY_BOOT_ARTIFACT_KIND,
    ownershipClass: MCP_MEMORY_BOOT_ARTIFACT_OWNERSHIP_CLASS,
    runtimeTarget: MCP_MEMORY_BOOT_ARTIFACT_RUNTIME_TARGET,
  });
}

/** Resolve the complete current boot chain without reading or writing it. */
export function resolveMcpMemoryBootArtifactDescriptors({ homeRoot, platformName = process.platform } = {}) {
  const home = assertAbsoluteHome(homeRoot, platformName);
  const pathApi = platformPath(platformName);
  const metaKim = pathApi.join(home, ".meta-kim");
  if (platformName === "win32") {
    const startup = pathApi.join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
    return [
      descriptor("windows-powershell", pathApi.join(metaKim, "mcp-memory-start.ps1"), "mcp-memory-boot:windows-powershell"),
      descriptor("windows-command", pathApi.join(metaKim, "mcp-memory-start.cmd"), "mcp-memory-boot:windows-command"),
      descriptor("windows-startup", pathApi.join(startup, "mcp-memory-silent.vbs"), "mcp-memory-boot:windows-startup"),
    ];
  }
  if (platformName === "darwin") {
    return [
      descriptor("macos-command", pathApi.join(metaKim, "mcp-memory-start.sh"), "mcp-memory-boot:macos-command"),
      descriptor("macos-launch-agent", pathApi.join(home, "Library", "LaunchAgents", "com.meta-kim.mcp-memory-service.plist"), "mcp-memory-boot:macos-launch-agent"),
    ];
  }
  return [
    descriptor("linux-command", pathApi.join(metaKim, "mcp-memory-start.sh"), "mcp-memory-boot:linux-command"),
    descriptor("linux-autostart", pathApi.join(home, ".config", "autostart", "mcp-memory-service.desktop"), "mcp-memory-boot:linux-autostart"),
  ];
}

function sameArtifactPath(left, right, platformName) {
  const pathApi = platformPath(platformName);
  const normalize = (value) => {
    const normalized = pathApi.normalize(value);
    return platformName === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

/** Validate only ownership identity; byte integrity remains the uninstaller's responsibility. */
export function isExactMcpMemoryBootManifestIdentity(entry, { homeRoot, platformName = process.platform } = {}) {
  if (!entry || typeof entry !== "object") return false;
  const match = resolveMcpMemoryBootArtifactDescriptors({ homeRoot, platformName })
    .find((candidate) => typeof entry.path === "string" && sameArtifactPath(entry.path, candidate.path, platformName));
  return Boolean(
    match &&
    entry.source === match.source &&
    entry.purpose === match.purpose &&
    entry.category === match.category &&
    entry.kind === match.kind &&
    entry.ownershipClass === match.ownershipClass &&
    entry.runtimeTarget === match.runtimeTarget
  );
}

/**
 * Record the complete generated boot chain in the global install manifest.
 * This function snapshots physical paths and exact bytes first, then records
 * that integrity evidence and propagates every recording or persistence failure.
 */
export async function recordMcpMemoryBootArtifactOwnership({
  homeRoot,
  platformName = process.platform,
  metaKimVersion,
  canAutoStart = true,
  recorderFactory = openRecorder,
  readFile = readFileSync,
  lstat = lstatSync,
  realpath = (targetPath) => realpathSync.native(targetPath),
} = {}) {
  if (canAutoStart === false) {
    return {
      ok: true,
      status: "not_applicable_remote_endpoint",
      descriptors: [],
      manifestPath: null,
    };
  }
  const descriptors = resolveMcpMemoryBootArtifactDescriptors({ homeRoot, platformName });
  const incomplete = [];
  const snapshots = [];
  for (const entry of descriptors) {
    try {
      snapshots.push({
        entry,
        snapshot: snapshotMcpMemoryBootArtifactFile({
          filePath: entry.path,
          homeRoot,
          platformName,
          readFile,
          lstat,
          realpath,
        }),
      });
    } catch (error) {
      incomplete.push(`${entry.path}:${error?.code ?? error?.message ?? "unreadable"}`);
    }
  }
  if (incomplete.length > 0) {
    return {
      ok: false,
      status: "boot_artifacts_incomplete",
      error: `MCP Memory boot artifact chain is incomplete: ${incomplete.join("; ")}`,
      incomplete,
    };
  }

  let recorder;
  try {
    recorder = recorderFactory({ scope: "global", metaKimVersion });
    for (const { entry, snapshot } of snapshots) {
      recorder.recordFile(entry.path, {
        source: entry.source,
        purpose: entry.purpose,
        category: entry.category,
        kind: entry.kind,
        size: snapshot.size,
        sha256: snapshot.sha256,
        ownershipClass: entry.ownershipClass,
        runtimeTarget: entry.runtimeTarget,
      });
    }
  } catch (error) {
    return {
      ok: false,
      status: "manifest_record_failed",
      error: `MCP Memory boot artifact ownership could not be recorded: ${error?.message ?? String(error)}`,
    };
  }

  let flushed;
  try {
    flushed = await recorder.flush();
  } catch (error) {
    return {
      ok: false,
      status: "manifest_flush_failed",
      error: `MCP Memory boot artifact ownership manifest could not be persisted: ${error?.message ?? String(error)}`,
    };
  }
  if (!flushed?.ok) {
    return {
      ok: false,
      status: "manifest_flush_failed",
      error: `MCP Memory boot artifact ownership manifest could not be persisted: ${flushed?.error ?? "unknown recorder failure"}`,
    };
  }
  const changedAfterRecord = [];
  for (const { entry, snapshot } of snapshots) {
    try {
      const current = snapshotMcpMemoryBootArtifactFile({
        filePath: entry.path,
        homeRoot,
        platformName,
        readFile,
        lstat,
        realpath,
      });
      if (
        current.dev !== snapshot.dev ||
        current.ino !== snapshot.ino ||
        current.size !== snapshot.size ||
        current.sha256 !== snapshot.sha256 ||
        physicalPathKey(current.physicalPath, platformName) !==
          physicalPathKey(snapshot.physicalPath, platformName)
      ) {
        changedAfterRecord.push(`${entry.path}:identity_or_bytes_changed`);
      }
    } catch (error) {
      changedAfterRecord.push(
        `${entry.path}:${error?.code ?? error?.message ?? "unreadable"}`,
      );
    }
  }
  if (changedAfterRecord.length > 0) {
    return {
      ok: false,
      status: "boot_artifacts_changed_during_recording",
      error: `MCP Memory boot artifacts changed while ownership was being persisted: ${changedAfterRecord.join("; ")}`,
      changed: changedAfterRecord,
      manifestPath: flushed.path ?? null,
    };
  }
  return {
    ok: true,
    status: "recorded",
    descriptors,
    manifestPath: flushed.path ?? null,
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function windowsRecoveryPaths(homeRoot) {
  const descriptors = resolveMcpMemoryBootArtifactDescriptors({ homeRoot, platformName: "win32" });
  const byId = new Map(descriptors.map((entry) => [entry.id, entry.path]));
  const startup = path.win32.dirname(byId.get("windows-startup"));
  return {
    powershell: byId.get("windows-powershell"),
    command: byId.get("windows-command"),
    startupVbs: byId.get("windows-startup"),
    legacyCommand: path.win32.join(startup, "mcp-memory-start.cmd"),
  };
}

const CURRENT_WINDOWS_BOOT_ENV = Object.freeze({
  MCP_ALLOW_ANONYMOUS_ACCESS: "true",
  HF_HUB_OFFLINE: "1",
  TRANSFORMERS_OFFLINE: "1",
  MCP_MEMORY_ONNX_ALLOW_DOWNLOAD: "0",
  MCP_MEMORY_ALLOW_HASH_EMBEDDINGS: "0",
  MCP_MEMORY_USE_ONNX: "1",
});

function psSingleQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function assertRendererText(value, label) {
  if (typeof value !== "string" || !value || /[\r\n]/u.test(value)) {
    throw new Error(`${label} must be non-empty single-line text`);
  }
  return value;
}

/** Render the exact current generated Windows PowerShell boot bytes. */
export function renderCurrentWindowsMcpMemoryPowerShellBytes({
  memoryBin,
  databasePath,
  endpointUrl,
  healthUrl,
  hostname,
  port,
  failureMessage,
  lockDir,
  bootEnv = CURRENT_WINDOWS_BOOT_ENV,
} = {}) {
  for (const [key, expected] of Object.entries(CURRENT_WINDOWS_BOOT_ENV)) {
    if (bootEnv?.[key] !== expected) throw new Error(`unsupported Windows MCP Memory boot env: ${key}`);
  }
  for (const [label, value] of Object.entries({
    memoryBin,
    databasePath,
    endpointUrl,
    healthUrl,
    hostname,
    port: String(port ?? ""),
    failureMessage,
    lockDir,
  })) assertRendererText(value, label);
  const content =
    `$ErrorActionPreference = "SilentlyContinue"\r\n` +
    `$env:MCP_ALLOW_ANONYMOUS_ACCESS = "${bootEnv.MCP_ALLOW_ANONYMOUS_ACCESS}"\r\n` +
    `$env:HF_HUB_OFFLINE = "${bootEnv.HF_HUB_OFFLINE}"\r\n` +
    `$env:TRANSFORMERS_OFFLINE = "${bootEnv.TRANSFORMERS_OFFLINE}"\r\n` +
    `$env:MCP_MEMORY_ONNX_ALLOW_DOWNLOAD = "${bootEnv.MCP_MEMORY_ONNX_ALLOW_DOWNLOAD}"\r\n` +
    `$env:MCP_MEMORY_ALLOW_HASH_EMBEDDINGS = "${bootEnv.MCP_MEMORY_ALLOW_HASH_EMBEDDINGS}"\r\n` +
    `$env:MCP_MEMORY_USE_ONNX = "${bootEnv.MCP_MEMORY_USE_ONNX}"\r\n` +
    `$env:MCP_MEMORY_SQLITE_PATH = ${psSingleQuote(databasePath)}\r\n` +
    `$env:MCP_MEMORY_URL = ${psSingleQuote(endpointUrl)}\r\n` +
    `$env:META_KIM_MEMORY_PORT = ${psSingleQuote(String(port))}\r\n` +
    `$env:MCP_HTTP_HOST = ${psSingleQuote(hostname)}\r\n` +
    `$env:MCP_HTTP_PORT = ${psSingleQuote(String(port))}\r\n` +
    `$memoryBin = ${psSingleQuote(memoryBin)}\r\n` +
    `$failureMessage = ${psSingleQuote(failureMessage)}\r\n` +
    `$logDir = Join-Path $env:USERPROFILE ".meta-kim"\r\n` +
    `$stdoutLog = Join-Path $logDir "mcp-memory.out.log"\r\n` +
    `$stderrLog = Join-Path $logDir "mcp-memory.err.log"\r\n` +
    `$lockDir = ${psSingleQuote(lockDir)}\r\n` +
    `$lockAcquired = $false\r\n` +
    `$lockToken = [guid]::NewGuid().ToString("n")\r\n` +
    `function Test-MetaKimMemoryHealth {\r\n` +
    `  try {\r\n` +
    `    $response = Invoke-WebRequest -Uri ${psSingleQuote(healthUrl)} -UseBasicParsing -TimeoutSec 3\r\n` +
    `    $payload = $response.Content | ConvertFrom-Json\r\n` +
    `    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300 -and $payload.status -eq "healthy")\r\n` +
    `  } catch { return $false }\r\n` +
    `}\r\n` +
    `function Remove-MetaKimOwnedLock {\r\n` +
    `  try {\r\n` +
    `    $owner = Get-Content -LiteralPath (Join-Path $lockDir "owner.json") -Raw | ConvertFrom-Json\r\n` +
    `    if ([string]$owner.token -eq $lockToken) { Remove-Item -LiteralPath $lockDir -Recurse -Force }\r\n` +
    `  } catch {}\r\n` +
    `}\r\n` +
    `try {\r\n` +
    `  New-Item -ItemType Directory -Path $lockDir -ErrorAction Stop | Out-Null\r\n` +
    `  $lockAcquired = $true\r\n` +
    `  $owner = @{ schemaVersion = "meta-kim-mcp-memory-start-lock-v1"; token = $lockToken; ownerPid = $PID; ownerStartIdentity = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString("o"); acquiredAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); expiresAt = [DateTimeOffset]::UtcNow.AddMinutes(6).ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress\r\n` +
    `  Set-Content -LiteralPath (Join-Path $lockDir "owner.json") -Value $owner -Encoding UTF8\r\n` +
    `} catch {\r\n` +
    `  try {\r\n` +
    `    $existingOwner = Get-Content -LiteralPath (Join-Path $lockDir "owner.json") -Raw | ConvertFrom-Json\r\n` +
    `    $ownerAlive = $false\r\n` +
    `    try { $ownerProcess = Get-Process -Id ([int]$existingOwner.ownerPid) -ErrorAction Stop; $ownerAlive = ($ownerProcess.StartTime.ToUniversalTime().ToString("o") -eq [string]$existingOwner.ownerStartIdentity) } catch {}\r\n` +
    `    if (-not $ownerAlive -and [int64]$existingOwner.expiresAt -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) {\r\n` +
    `      $staleDir = "$lockDir.stale.$PID"\r\n` +
    `      Move-Item -LiteralPath $lockDir -Destination $staleDir -ErrorAction Stop\r\n` +
    `      New-Item -ItemType Directory -Path $lockDir -ErrorAction Stop | Out-Null\r\n` +
    `      Remove-Item -LiteralPath $staleDir -Recurse -Force\r\n` +
    `      $lockAcquired = $true\r\n` +
    `      $owner = @{ schemaVersion = "meta-kim-mcp-memory-start-lock-v1"; token = $lockToken; ownerPid = $PID; ownerStartIdentity = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString("o"); acquiredAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); expiresAt = [DateTimeOffset]::UtcNow.AddMinutes(6).ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress\r\n` +
    `      Set-Content -LiteralPath (Join-Path $lockDir "owner.json") -Value $owner -Encoding UTF8\r\n` +
    `    }\r\n` +
    `  } catch {\r\n` +
    `    try {\r\n` +
    `      $lockMtime = [DateTimeOffset]((Get-Item -LiteralPath $lockDir).LastWriteTimeUtc)\r\n` +
    `      $lockAge = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $lockMtime.ToUnixTimeMilliseconds()\r\n` +
    `      if ($lockAge -ge 360000) {\r\n` +
    `        $staleDir = "$lockDir.stale.$PID"\r\n` +
    `        Move-Item -LiteralPath $lockDir -Destination $staleDir -ErrorAction Stop\r\n` +
    `        New-Item -ItemType Directory -Path $lockDir -ErrorAction Stop | Out-Null\r\n` +
    `        Remove-Item -LiteralPath $staleDir -Recurse -Force\r\n` +
    `        $lockAcquired = $true\r\n` +
    `        $owner = @{ schemaVersion = "meta-kim-mcp-memory-start-lock-v1"; token = $lockToken; ownerPid = $PID; ownerStartIdentity = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString("o"); acquiredAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); expiresAt = [DateTimeOffset]::UtcNow.AddMinutes(6).ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress\r\n` +
    `        Set-Content -LiteralPath (Join-Path $lockDir "owner.json") -Value $owner -Encoding UTF8\r\n` +
    `      }\r\n` +
    `    } catch {}\r\n` +
    `  }\r\n` +
    `  if (-not $lockAcquired) {\r\n` +
    `    if (Test-MetaKimMemoryHealth) { exit 0 }\r\n` +
    `    Add-Content -LiteralPath $stderrLog -Value $failureMessage -Encoding UTF8\r\n` +
    `    exit 1\r\n` +
    `  }\r\n` +
    `}\r\n` +
    `if (Test-MetaKimMemoryHealth) { Remove-MetaKimOwnedLock; exit 0 }\r\n` +
    `try {\r\n` +
    `  Start-Process -FilePath $memoryBin -ArgumentList @("server", "--http", "--http-host", ${psSingleQuote(hostname)}, "--http-port", ${psSingleQuote(String(port))}) -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog\r\n` +
    `} catch {}\r\n` +
    `$healthy = $false\r\n` +
    `for ($i = 0; $i -lt 150; $i++) {\r\n` +
    `  Start-Sleep -Seconds 2\r\n` +
    `  if (Test-MetaKimMemoryHealth) { $healthy = $true; break }\r\n` +
    `}\r\n` +
    `if (-not $healthy) {\r\n` +
    `  Add-Content -LiteralPath $stderrLog -Value $failureMessage -Encoding UTF8\r\n` +
    `}\r\n` +
    `if ($lockAcquired) { Remove-MetaKimOwnedLock }\r\n`;
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, "utf8")]);
}

/** Render the exact current generated Windows CMD boot bytes. */
export function renderCurrentWindowsMcpMemoryCommandBytes({ powershellPath } = {}) {
  assertRendererText(powershellPath, "powershellPath");
  return Buffer.from(
    `@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${powershellPath}"\r\n`,
    "utf8",
  );
}

/** Render the exact current generated Windows Startup VBS bytes. */
export function renderCurrentWindowsMcpMemoryStartupVbsBytes({ commandPath } = {}) {
  assertRendererText(commandPath, "commandPath");
  return Buffer.from(
    `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run """${commandPath}""", 0, False\r\n`,
    "utf8",
  );
}

function decodeStrictCrLf(bytes, { bom = false } = {}) {
  const text = bytes.toString("utf8");
  if (bom !== text.startsWith("\uFEFF")) return null;
  const body = bom ? text.slice(1) : text;
  if (!body.endsWith("\r\n") || body.replaceAll("\r\n", "").includes("\n")) return null;
  return body;
}

function parseWindowsVbs(bytes, expectedPaths) {
  if (bytes.equals(renderCurrentWindowsMcpMemoryStartupVbsBytes({ commandPath: expectedPaths.command }))) {
    return "current-windows-startup-vbs";
  }
  const text = decodeStrictCrLf(bytes);
  if (!text) return null;
  const match = /^Set WshShell = CreateObject\("WScript\.Shell"\)\r\nWshShell\.Run """([^"\r\n]+)""", 0, False\r\n$/u.exec(text);
  if (!match || !path.win32.isAbsolute(match[1])) return null;
  if (sameArtifactPath(match[1], expectedPaths.legacyCommand, "win32")) return "legacy-windows-startup-vbs";
  return null;
}

function isCurrentWindowsCommand(bytes, expectedPaths) {
  return bytes.equals(renderCurrentWindowsMcpMemoryCommandBytes({ powershellPath: expectedPaths.powershell }));
}

function isLegacyWindowsCommand(bytes) {
  const text = decodeStrictCrLf(bytes);
  if (!text) return false;
  const match = /^@echo off\r\nset MCP_ALLOW_ANONYMOUS_ACCESS=true\r\n"([^"\r\n]+)" server --http\r\n$/u.exec(text);
  return Boolean(
    match &&
    path.win32.isAbsolute(match[1]) &&
    path.win32.basename(match[1]).toLowerCase() === "memory.exe"
  );
}

function quotedPowerShellValue(line, prefix, suffix = "'") {
  if (!line.startsWith(prefix) || !line.endsWith(suffix)) return null;
  const raw = line.slice(prefix.length, -suffix.length);
  if (!raw || /(^|[^'])'(?!')/u.test(raw)) return null;
  return raw.replaceAll("''", "'");
}

function isCurrentWindowsPowerShell(bytes, homeRoot) {
  const text = decodeStrictCrLf(bytes, { bom: true });
  if (!text) return false;
  const lines = text.slice(0, -2).split("\r\n");
  if (lines.length !== 86 || lines.some((line) => !line)) return false;
  const sqlitePath = quotedPowerShellValue(lines[7], "$env:MCP_MEMORY_SQLITE_PATH = '");
  const endpointUrl = quotedPowerShellValue(lines[8], "$env:MCP_MEMORY_URL = '");
  const port = quotedPowerShellValue(lines[9], "$env:META_KIM_MEMORY_PORT = '");
  const hostname = quotedPowerShellValue(lines[10], "$env:MCP_HTTP_HOST = '");
  const httpPort = quotedPowerShellValue(lines[11], "$env:MCP_HTTP_PORT = '");
  const memoryBin = quotedPowerShellValue(lines[12], "$memoryBin = '");
  const failureMessage = quotedPowerShellValue(lines[13], "$failureMessage = '");
  const lockDir = quotedPowerShellValue(lines[17], "$lockDir = '");
  const healthUrl = quotedPowerShellValue(
    lines[22],
    "    $response = Invoke-WebRequest -Uri '",
    "' -UseBasicParsing -TimeoutSec 3",
  );
  let endpoint;
  try {
    endpoint = new URL(endpointUrl);
  } catch {
    return false;
  }
  const endpointPort = endpoint.port || (endpoint.protocol === "https:" ? "443" : "80");
  const expectedHealthUrl = new URL("/api/health", endpoint).toString();
  if (
    !sqlitePath || !path.win32.isAbsolute(sqlitePath) ||
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
    endpointUrl !== endpoint.toString().replace(/\/$/u, "") ||
    !/^\d{1,5}$/u.test(port ?? "") || Number(port) < 1 || Number(port) > 65535 ||
    port !== httpPort || port !== endpointPort || hostname !== endpoint.hostname ||
    healthUrl !== expectedHealthUrl ||
    !memoryBin || !path.win32.isAbsolute(memoryBin) ||
    path.win32.basename(memoryBin).toLowerCase() !== "memory.exe" ||
    !failureMessage?.includes(healthUrl) ||
    !failureMessage.includes("MCP_ALLOW_ANONYMOUS_ACCESS=true memory server --http") ||
    !lockDir || !path.win32.isAbsolute(lockDir) ||
    !sameArtifactPath(path.win32.dirname(lockDir), path.win32.join(homeRoot, ".meta-kim", "locks"), "win32")
  ) return false;
  return bytes.equals(renderCurrentWindowsMcpMemoryPowerShellBytes({
    memoryBin,
    databasePath: sqlitePath,
    endpointUrl,
    healthUrl,
    hostname,
    port,
    failureMessage,
    lockDir,
  }));
}

/** Classify one exact Windows candidate from bytes; no target is required to exist. */
export function classifyMcpMemoryBootRecoveryFile({ filePath, bytes, homeRoot, platformName = process.platform } = {}) {
  if (platformName !== "win32" || !Buffer.isBuffer(bytes)) return null;
  const home = assertAbsoluteHome(homeRoot, platformName);
  const expected = windowsRecoveryPaths(home);
  if (sameArtifactPath(filePath, expected.startupVbs, "win32")) {
    return parseWindowsVbs(bytes, expected);
  }
  if (sameArtifactPath(filePath, expected.command, "win32")) {
    return isCurrentWindowsCommand(bytes, expected) ? "current-windows-command" : null;
  }
  if (sameArtifactPath(filePath, expected.powershell, "win32")) {
    return isCurrentWindowsPowerShell(bytes, home) ? "current-windows-powershell" : null;
  }
  if (sameArtifactPath(filePath, expected.legacyCommand, "win32")) {
    return isLegacyWindowsCommand(bytes) ? "legacy-windows-command" : null;
  }
  return null;
}

/** Collect signature-proven recovery findings without mutating the filesystem. */
export function collectMcpMemoryBootRecoveryFindings({
  homeRoot,
  platformName = process.platform,
  readFile = readFileSync,
  lstat = lstatSync,
  realpath = (targetPath) => realpathSync.native(targetPath),
} = {}) {
  const home = assertAbsoluteHome(homeRoot, platformName);
  if (platformName !== "win32") return [];
  const expected = windowsRecoveryPaths(home);
  const candidates = [expected.powershell, expected.command, expected.startupVbs, expected.legacyCommand];
  const findings = [];
  for (const filePath of candidates) {
    let snapshot;
    try {
      snapshot = snapshotMcpMemoryBootArtifactFile({
        filePath,
        homeRoot: home,
        platformName,
        readFile,
        lstat,
        realpath,
      });
    } catch {
      continue;
    }
    const recoverySignature = classifyMcpMemoryBootRecoveryFile({
      filePath,
      bytes: snapshot.bytes,
      homeRoot: home,
      platformName,
    });
    if (!recoverySignature) continue;
    findings.push({
      path: filePath,
      category: MCP_MEMORY_BOOT_ARTIFACT_CATEGORY,
      kind: MCP_MEMORY_BOOT_ARTIFACT_KIND,
      source: "scan",
      purpose: `mcp-memory-boot-recovery:${recoverySignature}`,
      recoverySignature,
      size: snapshot.size,
      sha256: snapshot.sha256,
      physicalPath: snapshot.physicalPath,
    });
  }
  const signatures = new Set(findings.map((finding) => finding.recoverySignature));
  return findings.filter((finding) =>
    finding.recoverySignature !== "legacy-windows-command" ||
    signatures.has("legacy-windows-startup-vbs")
  );
}

/**
 * Find only boot launchers that are guaranteed to fail at login: an exact
 * Meta_Kim Startup VBS whose exact command target no longer exists. Healthy
 * chains and standalone command files are deliberately outside this repair.
 */
export function collectOrphanMcpMemoryBootLaunchers({
  homeRoot,
  platformName = process.platform,
  pathExists = existsSync,
  ...inspection
} = {}) {
  const home = assertAbsoluteHome(homeRoot, platformName);
  if (platformName !== "win32") return [];
  const expected = windowsRecoveryPaths(home);
  const findings = collectMcpMemoryBootRecoveryFindings({
    homeRoot: home,
    platformName,
    ...inspection,
  });
  return findings.filter((finding) => {
    if (finding.recoverySignature === "current-windows-startup-vbs") {
      return !pathExists(expected.command);
    }
    if (finding.recoverySignature === "legacy-windows-startup-vbs") {
      return !pathExists(expected.legacyCommand);
    }
    return false;
  });
}

/**
 * Automatically remove only signature-proven orphan launchers. Each file is
 * re-snapshotted before and after an atomic sibling quarantine rename so a
 * concurrent or linked-path change is restored instead of deleted.
 */
export function repairOrphanMcpMemoryBootLaunchers({
  homeRoot,
  platformName = process.platform,
  rename = renameSync,
  unlink = unlinkSync,
  pathExists = existsSync,
  randomId = randomUUID,
} = {}) {
  const home = assertAbsoluteHome(homeRoot, platformName);
  if (platformName !== process.platform) {
    return { ok: true, status: "not_applicable", repaired: [] };
  }
  if (platformName !== "win32") {
    return { ok: true, status: "not_applicable", repaired: [] };
  }
  const findings = collectOrphanMcpMemoryBootLaunchers({
    homeRoot: home,
    platformName,
    pathExists,
  });
  if (findings.length === 0) return { ok: true, status: "no_action", repaired: [] };

  const repaired = [];
  for (const finding of findings) {
    let quarantinePath = null;
    try {
      const before = snapshotMcpMemoryBootArtifactFile({
        filePath: finding.path,
        homeRoot: home,
        platformName,
      });
      if (before.sha256 !== finding.sha256 || before.size !== finding.size) {
        throw new Error(`${finding.path}:changed_before_quarantine`);
      }
      quarantinePath = `${finding.path}.meta-kim-orphan-${process.pid}-${randomId()}`;
      if (pathExists(quarantinePath)) throw new Error(`${quarantinePath}:quarantine_exists`);
      rename(finding.path, quarantinePath);
      const quarantined = snapshotMcpMemoryBootArtifactFile({
        filePath: quarantinePath,
        homeRoot: home,
        platformName,
      });
      if (quarantined.sha256 !== finding.sha256 || quarantined.size !== finding.size) {
        throw new Error(`${finding.path}:changed_during_quarantine`);
      }
      unlink(quarantinePath);
      repaired.push({
        path: finding.path,
        recoverySignature: finding.recoverySignature,
        sha256: finding.sha256,
        size: finding.size,
      });
    } catch (error) {
      if (quarantinePath && pathExists(quarantinePath) && !pathExists(finding.path)) {
        try { rename(quarantinePath, finding.path); } catch { /* preserve failure evidence below */ }
      }
      return {
        ok: false,
        status: "repair_failed",
        repaired,
        error: error?.message ?? String(error),
      };
    }
  }
  return { ok: true, status: "repaired", repaired };
}
