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
  expectedIntegrity = null,
  requireManifestEntriesAbsent = false,
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

  if (expectedIntegrity !== null) {
    const expectedByPath = new Map();
    for (const item of Array.isArray(expectedIntegrity) ? expectedIntegrity : []) {
      if (!item || typeof item.path !== "string") continue;
      expectedByPath.set(physicalPathKey(item.path, platformName), item);
    }
    const changedBeforeRecord = snapshots.filter(({ entry, snapshot }) => {
      const expected = expectedByPath.get(physicalPathKey(entry.path, platformName));
      return !expected ||
        typeof expected.physicalPath !== "string" ||
        expected.size !== snapshot.size ||
        expected.sha256 !== snapshot.sha256 ||
        expected.dev !== snapshot.dev ||
        expected.ino !== snapshot.ino ||
        physicalPathKey(expected.physicalPath, platformName) !==
          physicalPathKey(snapshot.physicalPath, platformName);
    }).map(({ entry }) => `${entry.path}:identity_or_bytes_changed`);
    if (
      expectedByPath.size !== descriptors.length ||
      changedBeforeRecord.length > 0
    ) {
      return {
        ok: false,
        status: "boot_artifacts_changed_before_recording",
        error: `MCP Memory boot artifacts changed before ownership could be recorded: ${changedBeforeRecord.join("; ") || "incomplete expected integrity"}`,
        changed: changedBeforeRecord,
      };
    }
  }

  let recorder;
  try {
    recorder = recorderFactory({
      scope: "global",
      metaKimVersion,
      ...(requireManifestEntriesAbsent
        ? {
            requireExistingValidManifest: true,
            expectedAbsentPaths: descriptors.map((entry) => entry.path),
          }
        : {}),
    });
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

function renderCurrentWindowsHealthProbe(healthUrl) {
  return (
    `function Test-MetaKimMemoryHealth {\r\n` +
    `  $handler = $null\r\n` +
    `  $client = $null\r\n` +
    `  $response = $null\r\n` +
    `  try {\r\n` +
    `    $handler = [System.Net.Http.HttpClientHandler]::new()\r\n` +
    `    $handler.UseProxy = $false\r\n` +
    `    $client = [System.Net.Http.HttpClient]::new($handler)\r\n` +
    `    $client.Timeout = [System.TimeSpan]::FromSeconds(3)\r\n` +
    `    $response = $client.GetAsync(${psSingleQuote(healthUrl)}).GetAwaiter().GetResult()\r\n` +
    `    $statusCode = [int]$response.StatusCode\r\n` +
    `    $payload = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json\r\n` +
    `    return ($statusCode -ge 200 -and $statusCode -lt 300 -and $payload.status -eq "healthy")\r\n` +
    `  } catch { return $false }\r\n` +
    `  finally {\r\n` +
    `    if ($response) { $response.Dispose() }\r\n` +
    `    if ($client) { $client.Dispose() }\r\n` +
    `    if ($handler) { $handler.Dispose() }\r\n` +
    `  }\r\n` +
    `}\r\n`
  );
}

function renderHistoricalWindowsHealthProbeV1(healthUrl) {
  return (
    `function Test-MetaKimMemoryHealth {\r\n` +
    `  try {\r\n` +
    `    $response = Invoke-WebRequest -Uri ${psSingleQuote(healthUrl)} -UseBasicParsing -TimeoutSec 3\r\n` +
    `    $payload = $response.Content | ConvertFrom-Json\r\n` +
    `    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300 -and $payload.status -eq "healthy")\r\n` +
    `  } catch { return $false }\r\n` +
    `}\r\n`
  );
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
    renderCurrentWindowsHealthProbe(healthUrl) +
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

/** Render the exact pre-proxy-bypass Windows template shipped before v2.9.26. */
export function renderHistoricalWindowsMcpMemoryPowerShellBytesV1(options = {}) {
  const current = renderCurrentWindowsMcpMemoryPowerShellBytes(options).toString("utf8");
  const currentProbe = renderCurrentWindowsHealthProbe(options.healthUrl);
  const historicalProbe = renderHistoricalWindowsHealthProbeV1(options.healthUrl);
  const first = current.indexOf(currentProbe);
  if (first < 0 || current.indexOf(currentProbe, first + currentProbe.length) >= 0) {
    throw new Error("current Windows MCP Memory health probe template is not unique");
  }
  return Buffer.from(
    `${current.slice(0, first)}${historicalProbe}${current.slice(first + currentProbe.length)}`,
    "utf8",
  );
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

function parseWindowsPowerShellBindings(bytes, homeRoot, { historicalV1 = false } = {}) {
  const text = decodeStrictCrLf(bytes, { bom: true });
  if (!text) return null;
  const lines = text.slice(0, -2).split("\r\n");
  const expectedLineCount = historicalV1 ? 86 : 99;
  if (lines.length !== expectedLineCount || lines.some((line) => !line)) return null;
  const sqlitePath = quotedPowerShellValue(lines[7], "$env:MCP_MEMORY_SQLITE_PATH = '");
  const endpointUrl = quotedPowerShellValue(lines[8], "$env:MCP_MEMORY_URL = '");
  const port = quotedPowerShellValue(lines[9], "$env:META_KIM_MEMORY_PORT = '");
  const hostname = quotedPowerShellValue(lines[10], "$env:MCP_HTTP_HOST = '");
  const httpPort = quotedPowerShellValue(lines[11], "$env:MCP_HTTP_PORT = '");
  const memoryBin = quotedPowerShellValue(lines[12], "$memoryBin = '");
  const failureMessage = quotedPowerShellValue(lines[13], "$failureMessage = '");
  const lockDir = quotedPowerShellValue(lines[17], "$lockDir = '");
  const healthUrl = quotedPowerShellValue(
    lines[historicalV1 ? 22 : 29],
    historicalV1
      ? "    $response = Invoke-WebRequest -Uri '"
      : "    $response = $client.GetAsync('",
    historicalV1
      ? "' -UseBasicParsing -TimeoutSec 3"
      : "').GetAwaiter().GetResult()",
  );
  let endpoint;
  try {
    endpoint = new URL(endpointUrl);
  } catch {
    return null;
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
  ) return null;
  const render = historicalV1
    ? renderHistoricalWindowsMcpMemoryPowerShellBytesV1
    : renderCurrentWindowsMcpMemoryPowerShellBytes;
  if (!bytes.equals(render({
    memoryBin,
    databasePath: sqlitePath,
    endpointUrl,
    healthUrl,
    hostname,
    port,
    failureMessage,
    lockDir,
  }))) return null;
  return {
    memoryBin,
    databasePath: sqlitePath,
    endpointUrl,
    healthUrl,
    hostname,
    port,
    failureMessage,
    lockDir,
  };
}

function isCurrentWindowsPowerShell(bytes, homeRoot) {
  return Boolean(parseWindowsPowerShellBindings(bytes, homeRoot));
}

function isHistoricalWindowsPowerShellV1(bytes, homeRoot) {
  return Boolean(parseWindowsPowerShellBindings(bytes, homeRoot, { historicalV1: true }));
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
    if (isCurrentWindowsPowerShell(bytes, home)) return "current-windows-powershell";
    return isHistoricalWindowsPowerShellV1(bytes, home)
      ? "historical-windows-powershell-proxy-v1"
      : null;
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
      dev: snapshot.dev,
      ino: snapshot.ino,
      physicalPath: snapshot.physicalPath,
    });
  }
  const signatures = new Set(findings.map((finding) => finding.recoverySignature));
  return findings.filter((finding) =>
    finding.recoverySignature !== "legacy-windows-command" ||
    signatures.has("legacy-windows-startup-vbs")
  );
}

function sameSnapshotIdentity(expected, actual, platformName) {
  return Boolean(
    expected && actual &&
    expected.size === actual.size &&
    expected.sha256 === actual.sha256 &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    typeof expected.physicalPath === "string" &&
    typeof actual.physicalPath === "string" &&
    physicalPathKey(expected.physicalPath, platformName) ===
      physicalPathKey(actual.physicalPath, platformName)
  );
}

function exactObjectKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expectedKeys].sort());
}

/**
 * Adopt only the complete pre-proxy-bypass Windows boot chain. The caller must
 * already have verified the live listener identity and health. This function
 * independently binds the historical bytes to the active runtime state and
 * uses a manifest compare-and-swap precondition so an existing owner or a
 * concurrent claim can never be overwritten.
 */
export async function adoptHistoricalWindowsMcpMemoryBootArtifactOwnership({
  homeRoot,
  platformName = process.platform,
  metaKimVersion,
  manifestEntries,
  expectedMemoryBin,
  expectedPythonPaths = [],
  endpoint,
  expectedLockDir,
  recorderFactory = openRecorder,
  readFile = readFileSync,
  lstat = lstatSync,
  realpath = (targetPath) => realpathSync.native(targetPath),
} = {}) {
  const fail = (reason, extra = {}) => ({ ok: false, status: reason, reason, ...extra });
  if (platformName !== "win32" || platformName !== process.platform) {
    return fail("historical_boot_adoption_not_applicable");
  }
  const home = assertAbsoluteHome(homeRoot, platformName);
  const descriptors = resolveMcpMemoryBootArtifactDescriptors({ homeRoot: home, platformName });
  if (!Array.isArray(manifestEntries)) return fail("historical_boot_manifest_invalid");
  if (manifestEntries.some((entry) =>
    descriptors.some((descriptor) =>
      typeof entry?.path === "string" && sameArtifactPath(entry.path, descriptor.path, platformName)
    )
  )) return fail("historical_boot_manifest_path_already_owned");

  const findings = collectMcpMemoryBootRecoveryFindings({
    homeRoot: home,
    platformName,
    readFile,
    lstat,
    realpath,
  });
  const requiredSignatures = new Set([
    "historical-windows-powershell-proxy-v1",
    "current-windows-command",
    "current-windows-startup-vbs",
  ]);
  const actualSignatures = new Set(findings.map((finding) => finding.recoverySignature));
  if (
    findings.length !== requiredSignatures.size ||
    [...requiredSignatures].some((signature) => !actualSignatures.has(signature))
  ) return fail("historical_boot_chain_unverified");

  const expectedPaths = windowsRecoveryPaths(home);
  const powerShellFinding = findings.find((finding) =>
    finding.recoverySignature === "historical-windows-powershell-proxy-v1"
  );
  let powerShellSnapshot;
  let stateSnapshot;
  let active;
  try {
    powerShellSnapshot = snapshotMcpMemoryBootArtifactFile({
      filePath: expectedPaths.powershell,
      homeRoot: home,
      platformName,
      readFile,
      lstat,
      realpath,
    });
    if (!sameSnapshotIdentity(powerShellFinding, powerShellSnapshot, platformName)) {
      return fail("historical_boot_chain_changed_during_verification");
    }
    const statePath = path.win32.join(home, ".meta-kim", "mcp-memory-active-runtime.json");
    stateSnapshot = snapshotMcpMemoryBootArtifactFile({
      filePath: statePath,
      homeRoot: home,
      platformName,
      readFile,
      lstat,
      realpath,
    });
    active = JSON.parse(stateSnapshot.bytes.toString("utf8"));
  } catch (error) {
    return fail("historical_active_runtime_state_unreadable", {
      error: error?.message ?? String(error),
    });
  }

  const bindings = parseWindowsPowerShellBindings(
    powerShellSnapshot.bytes,
    home,
    { historicalV1: true },
  );
  const activeKeys = [
    "schemaVersion",
    "runtimeDir",
    "pythonPath",
    "memoryBin",
    "databasePath",
    "activatedAt",
  ];
  if (
    !bindings ||
    !exactObjectKeys(active, activeKeys) ||
    active.schemaVersion !== "meta-kim-mcp-memory-active-runtime-v1" ||
    typeof active.activatedAt !== "string" ||
    !Number.isFinite(Date.parse(active.activatedAt)) ||
    ![active.runtimeDir, active.pythonPath, active.memoryBin, active.databasePath]
      .every((candidate) => typeof candidate === "string" && path.win32.isAbsolute(candidate)) ||
    typeof expectedMemoryBin !== "string" ||
    !path.win32.isAbsolute(expectedMemoryBin) ||
    typeof expectedLockDir !== "string" ||
    !path.win32.isAbsolute(expectedLockDir)
  ) return fail("historical_active_runtime_state_invalid");

  const runtimeDir = path.win32.normalize(active.runtimeDir);
  const initialRuntimeDir = path.win32.join(home, ".meta-kim", "memory-venv");
  const transactionalRuntimeRoot = path.win32.join(home, ".meta-kim", "memory-runtimes");
  const runtimeName = path.win32.basename(runtimeDir);
  const allowedRuntimeLayout =
    sameArtifactPath(runtimeDir, initialRuntimeDir, platformName) ||
    (
      sameArtifactPath(path.win32.dirname(runtimeDir), transactionalRuntimeRoot, platformName) &&
      /^update-\d{13}-\d{1,10}$/u.test(runtimeName)
    );
  const expectedRuntimeMemoryBin = path.win32.join(runtimeDir, "Scripts", "memory.exe");
  const expectedRuntimePython = path.win32.join(runtimeDir, "Scripts", "python.exe");
  if (
    !allowedRuntimeLayout ||
    !sameArtifactPath(active.memoryBin, expectedRuntimeMemoryBin, platformName) ||
    !sameArtifactPath(active.pythonPath, expectedRuntimePython, platformName) ||
    !sameArtifactPath(active.memoryBin, bindings.memoryBin, platformName) ||
    !sameArtifactPath(active.databasePath, bindings.databasePath, platformName) ||
    !sameArtifactPath(active.memoryBin, expectedMemoryBin, platformName) ||
    bindings.endpointUrl !== endpoint?.endpointUrl ||
    bindings.healthUrl !== endpoint?.healthUrl ||
    bindings.hostname !== endpoint?.hostname ||
    bindings.port !== String(endpoint?.port ?? "") ||
    !sameArtifactPath(bindings.lockDir, expectedLockDir, platformName)
  ) return fail("historical_active_runtime_binding_mismatch");

  let memorySnapshot;
  let pythonSnapshot;
  try {
    memorySnapshot = snapshotMcpMemoryBootArtifactFile({
      filePath: active.memoryBin,
      homeRoot: home,
      platformName,
      readFile,
      lstat,
      realpath,
    });
    pythonSnapshot = snapshotMcpMemoryBootArtifactFile({
      filePath: active.pythonPath,
      homeRoot: home,
      platformName,
      readFile,
      lstat,
      realpath,
    });
    snapshotMcpMemoryBootArtifactFile({
      filePath: active.databasePath,
      homeRoot: home,
      platformName,
      readFile,
      lstat,
      realpath,
    });
  } catch (error) {
    return fail("historical_active_runtime_files_unsafe", {
      error: error?.message ?? String(error),
    });
  }
  const trustedPythonPaths = new Set(
    expectedPythonPaths
      .filter((candidate) => typeof candidate === "string" && path.win32.isAbsolute(candidate))
      .map((candidate) => physicalPathKey(candidate, platformName)),
  );
  if (
    physicalPathKey(memorySnapshot.physicalPath, platformName) !==
      physicalPathKey(expectedMemoryBin, platformName) ||
    !trustedPythonPaths.has(physicalPathKey(pythonSnapshot.physicalPath, platformName))
  ) return fail("historical_active_runtime_process_binding_mismatch");

  const ownership = await recordMcpMemoryBootArtifactOwnership({
    homeRoot: home,
    platformName,
    metaKimVersion,
    expectedIntegrity: findings,
    requireManifestEntriesAbsent: true,
    recorderFactory,
    readFile,
    lstat,
    realpath,
  });
  if (!ownership.ok) {
    return fail(ownership.status ?? "historical_boot_manifest_adoption_failed", {
      error: ownership.error,
    });
  }

  try {
    const activeAfter = snapshotMcpMemoryBootArtifactFile({
      filePath: path.win32.join(home, ".meta-kim", "mcp-memory-active-runtime.json"),
      homeRoot: home,
      platformName,
      readFile,
      lstat,
      realpath,
    });
    if (!sameSnapshotIdentity(stateSnapshot, activeAfter, platformName)) {
      return fail("historical_active_runtime_state_changed_during_adoption");
    }
  } catch (error) {
    return fail("historical_active_runtime_state_changed_during_adoption", {
      error: error?.message ?? String(error),
    });
  }
  return {
    ok: true,
    status: "historical_boot_chain_adopted",
    manifestPath: ownership.manifestPath,
    descriptors,
  };
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
