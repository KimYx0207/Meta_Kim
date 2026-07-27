import http from "node:http";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { platform } from "node:os";
import { resolveTrustedWindowsSystemTool } from "./mcp-memory-process-control.mjs";

export const MCP_MEMORY_SQLITE_PACKAGE = "mcp-memory-service[sqlite]==11.5.5";
export const MCP_MEMORY_COLD_START_TIMEOUT_MS = 300_000;
export const MCP_MEMORY_HEALTH_POLL_INTERVAL_MS = 1_500;
export const MCP_MEMORY_DEPENDENCY_PROBE =
  "import onnxruntime, tokenizers";
export const WINDOWS_APP_LOCAL_CRT_DLLS = Object.freeze([
  "concrt140.dll",
  "msvcp140.dll",
  "msvcp140_1.dll",
  "msvcp140_2.dll",
  "msvcp140_atomic_wait.dll",
  "msvcp140_codecvt_ids.dll",
  "vccorlib140.dll",
  "vcruntime140.dll",
  "vcruntime140_1.dll",
  "vcruntime140_threads.dll",
]);

export const PYTHON_MEMORY_HEALTH_PROBE = [
  "import json, sys, urllib.request",
  "ok = False",
  "try:",
  "    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))",
  "    with opener.open(sys.argv[1], timeout=3) as response:",
  "        payload = json.load(response)",
  "        ok = 200 <= response.status < 300 and payload.get('status') == 'healthy'",
  "except Exception:",
  "    ok = False",
  "raise SystemExit(0 if ok else 1)",
].join("\n");

export function planMcpMemoryReconciliation({
  existingInstalled,
  inUpdateMode,
}) {
  return {
    previouslyInstalled: Boolean(existingInstalled),
    shouldStopBeforeInstall: Boolean(existingInstalled && inUpdateMode),
    installArgs: [
      "-m",
      "pip",
      "install",
      ...(inUpdateMode ? ["--upgrade"] : []),
      MCP_MEMORY_SQLITE_PACKAGE,
    ],
    verifyArgs: ["-c", MCP_MEMORY_DEPENDENCY_PROBE],
  };
}

export function executeMcpMemoryReconciliation({
  python,
  plan,
  runPython,
  repairDependencyProbe = null,
}) {
  const installResult = runPython(python, plan.installArgs);
  if (installResult.status !== 0) {
    return {
      ok: false,
      stage: "install",
      code: "mcp_memory_install_failed",
      processResult: installResult,
    };
  }

  const verifyResult = runPython(python, plan.verifyArgs);
  if (verifyResult.status !== 0) {
    if (repairDependencyProbe) {
      const repaired = repairDependencyProbe({
        python,
        verifyArgs: plan.verifyArgs,
        initialProbeResult: verifyResult,
      });
      if (repaired?.ok && repaired.processResult?.status === 0) {
        return {
          ok: true,
          stage: "verified_after_windows_app_local_crt",
          code: "mcp_memory_verified_after_windows_app_local_crt",
          processResult: repaired.processResult,
          repairEvidence: repaired.evidence,
        };
      }
      return {
        ok: false,
        stage: "dependency_probe",
        code: "mcp_memory_dependency_probe_failed",
        processResult: repaired?.processResult ?? verifyResult,
        initialProbeResult: verifyResult,
        repairEvidence: repaired?.evidence,
        repairReason: repaired?.reason ?? "windows_app_local_crt_repair_failed",
      };
    }
    return {
      ok: false,
      stage: "dependency_probe",
      code: "mcp_memory_dependency_probe_failed",
      processResult: verifyResult,
    };
  }

  return { ok: true, stage: "verified", processResult: verifyResult };
}

function numericVersionParts(value) {
  return String(value || "").split(/[^0-9]+/u).filter(Boolean).map(Number);
}

function compareNumericVersions(left, right) {
  const a = numericVersionParts(left);
  const b = numericVersionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function readWindowsDllVersion(filePath) {
  const powershellPath = resolveTrustedWindowsSystemTool([
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  ]);
  if (!powershellPath) return null;
  const escaped = String(filePath).replace(/'/g, "''");
  const result = spawnSync(powershellPath, [
    "-NoProfile",
    "-Command",
    `(Get-Item -LiteralPath '${escaped}').VersionInfo.FileVersion`,
  ], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function safeDirectories(parent, readdir = readdirSync) {
  try {
    return readdir(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function pathInside(parent, candidate) {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function windowsPathKey(filePath) {
  return resolve(filePath).replace(/\\/gu, "/").toLowerCase();
}

function resolveLifecyclePowerShell({
  powershellPath,
  resolveSystemTool = resolveTrustedWindowsSystemTool,
  fileExists = existsSync,
  lstat = lstatSync,
  realpath = realpathSync,
}) {
  const selected = powershellPath ?? resolveSystemTool([
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  ]);
  if (!selected || !isAbsolute(selected)) return null;
  try {
    const metadata = lstat(selected);
    if (!fileExists(selected) || !metadata.isFile() || metadata.isSymbolicLink()) return null;
    return realpath(selected);
  } catch { return null; }
}
const MICROSOFT_TRUSTED_ROOT_THUMBPRINTS = new Set([
  "8F43288AD272F3103B6FB1428485EA3014C0BCFE",
  "3B1EFD3A66EA28B16697394703A72CA340A05BD5",
]);
const MICROSOFT_COMPONENT_CA_THUMBPRINTS = new Set([
  "2F5540201B5799E6A3E2131C3D05753D23879FE0",
]);

export function recordWindowsSourceFileIdentities({
  filePaths,
  powershellPath,
  resolveSystemTool = resolveTrustedWindowsSystemTool,
  runPowerShell = spawnSync,
  fileExists = existsSync,
  lstat = lstatSync,
  realpath = realpathSync,
} = {}) {
  if (!Array.isArray(filePaths) || filePaths.length === 0 || filePaths.length > 64) {
    return { ok: false, reason: "source_identity_targets_invalid" };
  }
  const trustedPowerShell = resolveLifecyclePowerShell({
    powershellPath, resolveSystemTool, fileExists, lstat, realpath,
  });
  if (!trustedPowerShell) return { ok: false, reason: "trusted_system_powershell_missing" };
  const payload = Buffer.from(JSON.stringify({ filePaths }), "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -TypeDefinition @'",
    "using System; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;",
    "public static class MetaKimSourceIdentity {",
    "  [StructLayout(LayoutKind.Sequential)] public struct Info { public uint FileAttributes; public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime; public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime; public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime; public uint VolumeSerialNumber; public uint FileSizeHigh; public uint FileSizeLow; public uint NumberOfLinks; public uint FileIndexHigh; public uint FileIndexLow; }",
    "  [DllImport(\"kernel32.dll\", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);",
    "  static Info Get(SafeFileHandle h) { Info i; if(!GetFileInformationByHandle(h,out i)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); if((i.FileAttributes & 0x400)!=0) throw new InvalidOperationException(\"source_reparse_point\"); return i; }",
    "  public static string Identity(SafeFileHandle h) { var i=Get(h); return i.VolumeSerialNumber.ToString(\"X8\")+\":\"+i.FileIndexHigh.ToString(\"X8\")+i.FileIndexLow.ToString(\"X8\"); }",
    "}",
    "'@",
    `$data=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json`,
    "$streams=@();$records=@()",
    "try{",
    "  for($i=0;$i -lt $data.filePaths.Count;$i++){",
    "    $stream=[IO.File]::Open([string]$data.filePaths[$i],[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)",
    "    $streams+=$stream",
    "    $identity=[MetaKimSourceIdentity]::Identity($stream.SafeFileHandle)",
    "    $sha=[Security.Cryptography.SHA256]::Create()",
    "    try{$hash=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}",
    "    if([MetaKimSourceIdentity]::Identity($stream.SafeFileHandle) -ne $identity){throw 'source_identity_changed_during_discovery'}",
    "    $records += [pscustomobject]@{index=$i;identity=$identity;sha256=$hash}",
    "  }",
    "  [pscustomobject]@{ok=$true;records=@($records)}|ConvertTo-Json -Compress",
    "}finally{foreach($stream in $streams){if($stream){$stream.Dispose()}}}",
  ].join("\n");
  try {
    const result = runPowerShell(trustedPowerShell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
    });
    const parsed = result.status === 0
      ? JSON.parse(String(result.stdout || "").replace(/^\uFEFF/u, ""))
      : null;
    const records = Array.isArray(parsed?.records)
      ? parsed.records
      : parsed?.records && typeof parsed.records === "object"
        ? [parsed.records]
        : [];
    if (
      parsed?.ok !== true || records.length !== filePaths.length ||
      !records.every((record, index) => (
        record?.index === index && /^[A-F0-9]{8}:[A-F0-9]{16}$/u.test(record.identity) &&
        /^[a-f0-9]{64}$/u.test(record.sha256)
      ))
    ) return { ok: false, reason: "source_identity_probe_failed" };
    return { ok: true, records };
  } catch { return { ok: false, reason: "source_identity_probe_failed" }; }
}

export function verifyWindowsMicrosoftAuthenticode({
  filePaths,
  powershellPath,
  resolveSystemTool = resolveTrustedWindowsSystemTool,
  runPowerShell = spawnSync,
  fileExists = existsSync,
  lstat = lstatSync,
  realpath = realpathSync,
} = {}) {
  if (
    !Array.isArray(filePaths) ||
    filePaths.length !== WINDOWS_APP_LOCAL_CRT_DLLS.length ||
    !filePaths.every((filePath, index) => (
      basename(filePath).toLowerCase() === WINDOWS_APP_LOCAL_CRT_DLLS[index]
    ))
  ) {
    return { ok: false, reason: "authenticode_targets_missing" };
  }
  const trustedPowerShell = resolveLifecyclePowerShell({
    powershellPath, resolveSystemTool, fileExists, lstat, realpath,
  });
  if (!trustedPowerShell) return { ok: false, reason: "trusted_system_powershell_missing" };
  const quotedPaths = filePaths
    .map((filePath) => `'${String(filePath).replace(/'/gu, "''")}'`)
    .join(",");
  const script = [
    "$ErrorActionPreference='Stop'",
    "Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop",
    `$paths=@(${quotedPaths})`,
    "$results=@()",
    "for($i=0;$i -lt $paths.Count;$i++){",
    "  $signature=Get-AuthenticodeSignature -LiteralPath $paths[$i]",
    "  $chain=[Security.Cryptography.X509Certificates.X509Chain]::new()",
    "  $chain.ChainPolicy.RevocationMode=[Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck",
    "  $chainValid=$signature.SignerCertificate -and $chain.Build($signature.SignerCertificate)",
    "  $elements=@($chain.ChainElements|ForEach-Object{$_.Certificate.Thumbprint})",
    "  $rootThumbprint=if($elements.Count){$elements[$elements.Count-1]}else{''}",
    "  $intermediateThumbprints=if($elements.Count -gt 2){@($elements[1..($elements.Count-2)])}else{@()}",
    "  $results += [pscustomobject]@{index=$i;status=[string]$signature.Status;subject=[string]$signature.SignerCertificate.Subject;thumbprint=[string]$signature.SignerCertificate.Thumbprint;chainValid=[bool]$chainValid;rootThumbprint=[string]$rootThumbprint;intermediateThumbprints=$intermediateThumbprints}",
    "}",
    "@($results)|ConvertTo-Json -Compress",
  ].join("\n");
  let signatures;
  try {
    const result = runPowerShell(trustedPowerShell, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ], { encoding: "utf8", windowsHide: true });
    signatures = result.status === 0
      ? JSON.parse(String(result.stdout || "").replace(/^\uFEFF/u, ""))
      : null;
  } catch { signatures = null; }
  if (!Array.isArray(signatures) || signatures.length !== filePaths.length) {
    return { ok: false, reason: "authenticode_probe_failed" };
  }
  const microsoftSigner = /(?:^|,\s*)O=Microsoft Corporation(?:,|$)/iu;
  const valid = signatures.every((signature, index) => {
    const intermediateThumbprints = Array.isArray(signature?.intermediateThumbprints)
      ? signature.intermediateThumbprints
      : typeof signature?.intermediateThumbprints === "string"
        ? [signature.intermediateThumbprints]
        : [];
    return (
      signature?.index === index &&
      signature.status === "Valid" &&
      microsoftSigner.test(String(signature.subject || "")) &&
      signature.chainValid === true &&
      MICROSOFT_TRUSTED_ROOT_THUMBPRINTS.has(String(signature.rootThumbprint || "").toUpperCase()) &&
      intermediateThumbprints.some((thumbprint) => (
        MICROSOFT_COMPONENT_CA_THUMBPRINTS.has(String(thumbprint || "").toUpperCase())
      )) &&
      typeof signature.thumbprint === "string" &&
      signature.thumbprint.length > 0
    );
  });
  const evidence = signatures.map((signature, index) => ({
    dllName: WINDOWS_APP_LOCAL_CRT_DLLS[index],
    status: signature?.status ?? "Missing",
    signerThumbprintDigest: signature?.thumbprint
      ? createHash("sha256").update(String(signature.thumbprint)).digest("hex")
      : undefined,
    rootThumbprintDigest: signature?.rootThumbprint
      ? createHash("sha256").update(String(signature.rootThumbprint)).digest("hex")
      : undefined,
  }));
  return valid
    ? { ok: true, reason: "microsoft_authenticode_valid", evidence }
    : { ok: false, reason: "microsoft_authenticode_invalid", evidence };
}

export function runWindowsLockedDependencyProbe({
  python,
  verifyArgs,
  sourcePaths,
  expectedSourceIdentities,
  executionPaths,
  expectedExecutionIdentities,
  targetPaths,
  directoryPaths,
  powershellPath,
  resolveSystemTool = resolveTrustedWindowsSystemTool,
  runPowerShell = spawnSync,
  fileExists = existsSync,
  lstat = lstatSync,
  realpath = realpathSync,
} = {}) {
  if (
    !Array.isArray(sourcePaths) ||
    !Array.isArray(targetPaths) ||
    sourcePaths.length !== WINDOWS_APP_LOCAL_CRT_DLLS.length ||
    !Array.isArray(expectedSourceIdentities) ||
    expectedSourceIdentities.length !== sourcePaths.length ||
    !expectedSourceIdentities.every((record, index) => (
      record?.index === index && /^[A-F0-9]{8}:[A-F0-9]{16}$/u.test(record.identity) &&
      /^[a-f0-9]{64}$/u.test(record.sha256)
    )) ||
    !Array.isArray(executionPaths) || executionPaths.length === 0 ||
    !Array.isArray(expectedExecutionIdentities) ||
    expectedExecutionIdentities.length !== executionPaths.length ||
    !expectedExecutionIdentities.every((record, index) => (
      record?.index === index && /^[A-F0-9]{8}:[A-F0-9]{16}$/u.test(record.identity) &&
      /^[a-f0-9]{64}$/u.test(record.sha256)
    )) ||
    targetPaths.length !== sourcePaths.length ||
    !Array.isArray(directoryPaths) ||
    directoryPaths.length === 0
  ) return { ok: false, reason: "locked_probe_inputs_invalid" };
  const trustedPowerShell = resolveLifecyclePowerShell({
    powershellPath, resolveSystemTool, fileExists, lstat, realpath,
  });
  if (!trustedPowerShell) return { ok: false, reason: "trusted_system_powershell_missing" };
  const launcher = typeof python === "string"
    ? { command: python, args: [] }
    : { command: python?.command, args: python?.args ?? [] };
  if (!launcher.command || !isAbsolute(launcher.command)) {
    return { ok: false, reason: "locked_probe_python_untrusted" };
  }
  let trustedLauncher;
  try {
    const metadata = lstat(launcher.command);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("launcher link");
    trustedLauncher = realpath(launcher.command);
  } catch { return { ok: false, reason: "locked_probe_python_untrusted" }; }
  if (!executionPaths.some((filePath) => windowsPathKey(filePath) === windowsPathKey(trustedLauncher))) {
    return { ok: false, reason: "locked_probe_python_not_bound" };
  }
  const payload = Buffer.from(JSON.stringify({
    pythonCommand: trustedLauncher,
    pythonArgs: launcher.args,
    verifyArgs,
    sourcePaths,
    expectedSourceIdentities,
    executionPaths,
    expectedExecutionIdentities,
    targetPaths,
    directoryPaths,
    trustedRoots: [...MICROSOFT_TRUSTED_ROOT_THUMBPRINTS],
    trustedIntermediates: [...MICROSOFT_COMPONENT_CA_THUMBPRINTS],
  }), "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    "Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop",
    "Add-Type -TypeDefinition @'",
    "using System; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;",
    "public static class MetaKimDirectoryLock {",
    "  [StructLayout(LayoutKind.Sequential)] public struct Info { public uint FileAttributes; public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime; public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime; public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime; public uint VolumeSerialNumber; public uint FileSizeHigh; public uint FileSizeLow; public uint NumberOfLinks; public uint FileIndexHigh; public uint FileIndexLow; }",
    "  [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);",
    "  [DllImport(\"kernel32.dll\", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);",
    "  public static SafeFileHandle Open(string path) { var h=CreateFile(path,0x80,1,IntPtr.Zero,3,0x02200000,IntPtr.Zero); if(h.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); return h; }",
    "  public static string Identity(SafeFileHandle h) { Info i; if(!GetFileInformationByHandle(h,out i)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); if((i.FileAttributes & 0x400)!=0) throw new InvalidOperationException(\"locked_directory_reparse_point\"); return i.VolumeSerialNumber.ToString(\"X8\")+\":\"+i.FileIndexHigh.ToString(\"X8\")+i.FileIndexLow.ToString(\"X8\"); }",
    "}",
    "'@",
    `$data=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json`,
    "$directoryHandles=@();$directoryIdentities=@();$sourceStreams=@();$sourceIdentities=@();$executionStreams=@();$executionIdentities=@();$targetStreams=@();$targetIdentities=@();$sourceHashes=@();$signatures=@();$created=@()",
    "$success=$false",
    "$result=$null",
    "try{",
    "  foreach($path in $data.directoryPaths){$handle=[MetaKimDirectoryLock]::Open([string]$path);$directoryHandles+=$handle;$directoryIdentities+=[MetaKimDirectoryLock]::Identity($handle)}",
    "  foreach($path in $data.sourcePaths){$sourceStreams += [IO.File]::Open([string]$path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)}",
    "  for($i=0;$i -lt $sourceStreams.Count;$i++){",
    "    $sourceIdentity=[MetaKimDirectoryLock]::Identity($sourceStreams[$i].SafeFileHandle)",
    "    if($sourceIdentity -ne [string]$data.expectedSourceIdentities[$i].identity){throw 'locked_source_identity_mismatch'}",
    "    $sourceIdentities+=$sourceIdentity",
    "    $sourceStreams[$i].Position=0",
    "    $sha=[Security.Cryptography.SHA256]::Create()",
    "    try{$sourceHashes+=([BitConverter]::ToString($sha.ComputeHash($sourceStreams[$i]))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}",
    "    if([string]$sourceHashes[$i] -ne [string]$data.expectedSourceIdentities[$i].sha256){throw 'locked_source_hash_mismatch'}",
    "  }",
    "  foreach($path in $data.executionPaths){$executionStreams += [IO.File]::Open([string]$path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)}",
    "  for($i=0;$i -lt $executionStreams.Count;$i++){",
    "    $executionIdentity=[MetaKimDirectoryLock]::Identity($executionStreams[$i].SafeFileHandle)",
    "    if($executionIdentity -ne [string]$data.expectedExecutionIdentities[$i].identity){throw 'locked_execution_identity_mismatch'}",
    "    $executionIdentities+=$executionIdentity",
    "    $executionStreams[$i].Position=0",
    "    $sha=[Security.Cryptography.SHA256]::Create()",
    "    try{$executionHash=([BitConverter]::ToString($sha.ComputeHash($executionStreams[$i]))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}",
    "    if($executionHash -ne [string]$data.expectedExecutionIdentities[$i].sha256){throw 'locked_execution_hash_mismatch'}",
    "  }",
    "  for($i=0;$i -lt $data.targetPaths.Count;$i++){",
    "    $sourceStreams[$i].Position=0",
    "    $writer=$null;$bridge=$null",
    "    try{",
    "      $writer=[IO.File]::Open([string]$data.targetPaths[$i],[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite)",
    "      $created += [string]$data.targetPaths[$i]",
    "      $sourceStreams[$i].CopyTo($writer);$writer.Flush($true)",
    "      $bridge=[IO.File]::Open([string]$data.targetPaths[$i],[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)",
    "      $writer.Dispose();$writer=$null",
    "      $target=[IO.File]::Open([string]$data.targetPaths[$i],[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)",
    "      $bridge.Dispose();$bridge=$null",
    "      $targetStreams+=$target",
    "      $targetIdentities+=[MetaKimDirectoryLock]::Identity($target.SafeFileHandle)",
    "    }finally{if($writer){$writer.Dispose()};if($bridge){$bridge.Dispose()}}",
    "  }",
    "  for($i=0;$i -lt $targetStreams.Count;$i++){",
    "    $targetStreams[$i].Position=0",
    "    $sha=[Security.Cryptography.SHA256]::Create()",
    "    try{$actual=([BitConverter]::ToString($sha.ComputeHash($targetStreams[$i]))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}",
    "    if($actual -ne [string]$sourceHashes[$i]){throw 'locked_hash_mismatch'}",
    "  }",
    "  for($i=0;$i -lt $data.targetPaths.Count;$i++){",
    "    $signature=Get-AuthenticodeSignature -LiteralPath ([string]$data.sourcePaths[$i])",
    "    $chain=[Security.Cryptography.X509Certificates.X509Chain]::new()",
    "    $chain.ChainPolicy.RevocationMode=[Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck",
    "    $chainValid=$signature.SignerCertificate -and $chain.Build($signature.SignerCertificate)",
    "    $elements=@($chain.ChainElements|ForEach-Object{$_.Certificate.Thumbprint})",
    "    $root=if($elements.Count){[string]$elements[$elements.Count-1]}else{''}",
    "    $intermediates=if($elements.Count -gt 2){@($elements[1..($elements.Count-2)])}else{@()}",
    "    $rootOk=@($data.trustedRoots) -contains $root",
    "    $intermediateOk=@($intermediates|Where-Object{@($data.trustedIntermediates) -contains $_}).Count -gt 0",
    "    if($signature.Status -ne 'Valid' -or -not $chainValid -or -not $rootOk -or -not $intermediateOk){throw 'locked_authenticode_invalid'}",
    "    $signatures += [pscustomobject]@{index=$i;status='Valid';thumbprint=[string]$signature.SignerCertificate.Thumbprint;rootThumbprint=$root}",
    "  }",
    "  for($i=0;$i -lt $sourceStreams.Count;$i++){if([MetaKimDirectoryLock]::Identity($sourceStreams[$i].SafeFileHandle) -ne [string]$sourceIdentities[$i]){throw 'locked_source_identity_changed'}}",
    "  for($i=0;$i -lt $executionStreams.Count;$i++){if([MetaKimDirectoryLock]::Identity($executionStreams[$i].SafeFileHandle) -ne [string]$executionIdentities[$i]){throw 'locked_execution_identity_changed'}}",
    "  for($i=0;$i -lt $targetStreams.Count;$i++){if([MetaKimDirectoryLock]::Identity($targetStreams[$i].SafeFileHandle) -ne [string]$targetIdentities[$i]){throw 'locked_target_identity_changed'}}",
    "  for($i=0;$i -lt $directoryHandles.Count;$i++){if([MetaKimDirectoryLock]::Identity($directoryHandles[$i]) -ne [string]$directoryIdentities[$i]){throw 'locked_directory_identity_changed'}}",
    "  $invokeArgs=@($data.pythonArgs)+@($data.verifyArgs)",
    "  $output=(& ([string]$data.pythonCommand) @invokeArgs 2>&1|Out-String)",
    "  if($LASTEXITCODE -ne 0){throw 'locked_dependency_probe_failed'}",
    "  for($i=0;$i -lt $sourceStreams.Count;$i++){if([MetaKimDirectoryLock]::Identity($sourceStreams[$i].SafeFileHandle) -ne [string]$sourceIdentities[$i]){throw 'locked_source_identity_changed'}}",
    "  for($i=0;$i -lt $executionStreams.Count;$i++){if([MetaKimDirectoryLock]::Identity($executionStreams[$i].SafeFileHandle) -ne [string]$executionIdentities[$i]){throw 'locked_execution_identity_changed'}}",
    "  for($i=0;$i -lt $targetStreams.Count;$i++){if([MetaKimDirectoryLock]::Identity($targetStreams[$i].SafeFileHandle) -ne [string]$targetIdentities[$i]){throw 'locked_target_identity_changed'}}",
    "  $success=$true",
    "  $result=[pscustomobject]@{locked=$true;status=0;reason='locked_dependency_probe_verified';output=$output;signatures=$signatures}",
    "}catch{",
    "  $result=[pscustomobject]@{locked=$false;status=-1;reason=[string]$_.Exception.Message;output=''}",
    "}finally{",
    "  foreach($stream in $targetStreams){if($stream){$stream.Dispose()}};foreach($stream in $executionStreams){if($stream){$stream.Dispose()}};foreach($stream in $sourceStreams){if($stream){$stream.Dispose()}};foreach($handle in $directoryHandles){if($handle){$handle.Dispose()}}",
    "  if(-not $success){foreach($path in $created){Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue}}",
    "}",
    "$result|ConvertTo-Json -Compress",
  ].join("\n");
  let parsed;
  try {
    const result = runPowerShell(trustedPowerShell, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ], { encoding: "utf8", windowsHide: true });
    parsed = result.status === 0
      ? JSON.parse(String(result.stdout || "").replace(/^\uFEFF/u, ""))
      : null;
  } catch { parsed = null; }
  if (!parsed || parsed.locked !== true) {
    return { ok: false, reason: parsed?.reason ?? "locked_dependency_probe_unavailable" };
  }
  return {
    ok: parsed.status === 0,
    reason: parsed.reason,
    processResult: { status: parsed.status, stdout: parsed.output ?? "", stderr: "" },
    signatures: Array.isArray(parsed.signatures)
      ? parsed.signatures.map((signature, index) => ({
        dllName: WINDOWS_APP_LOCAL_CRT_DLLS[index],
        status: signature.status,
        signerThumbprintDigest: createHash("sha256").update(String(signature.thumbprint)).digest("hex"),
        rootThumbprintDigest: createHash("sha256").update(String(signature.rootThumbprint)).digest("hex"),
      }))
      : undefined,
  };
}

export function resolveWindowsProgramFilesRoots({
  platformName = platform(),
  powershellPath,
  resolveSystemTool = resolveTrustedWindowsSystemTool,
  runPowerShell = spawnSync,
  fileExists = existsSync,
  lstat = lstatSync,
  realpath = realpathSync,
} = {}) {
  if (platformName !== "win32") return { ok: false, reason: "windows_only_program_files_resolution" };
  const trustedPowerShell = resolveLifecyclePowerShell({
    powershellPath, resolveSystemTool, fileExists, lstat, realpath,
  });
  if (!trustedPowerShell) return { ok: false, reason: "trusted_system_powershell_missing" };
  const script = [
    "$ErrorActionPreference='Stop'",
    "$roots=[ordered]@{",
    "  programFiles=[Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)",
    "  programFilesX86=[Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)",
    "}",
    "$roots|ConvertTo-Json -Compress",
  ].join("\n");
  let parsed;
  try {
    const result = runPowerShell(trustedPowerShell, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ], { encoding: "utf8", windowsHide: true });
    parsed = result.status === 0
      ? JSON.parse(String(result.stdout || "").replace(/^\uFEFF/u, ""))
      : null;
  } catch { parsed = null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "os_program_files_resolution_failed" };
  }
  const trustRoot = (rootPath) => {
    if (typeof rootPath !== "string" || !isAbsolute(rootPath)) return null;
    try {
      const metadata = lstat(rootPath);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) return null;
      return realpath(rootPath);
    } catch { return null; }
  };
  const programFiles = trustRoot(parsed.programFiles);
  const programFilesX86 = trustRoot(parsed.programFilesX86);
  if (!programFiles && !programFilesX86) {
    return { ok: false, reason: "os_program_files_roots_untrusted" };
  }
  return { ok: true, programFiles, programFilesX86 };
}

export function verifyPrivateRecoveryRoot({
  directoryPath,
  platformName = platform(),
  powershellPath,
  resolveSystemTool = resolveTrustedWindowsSystemTool,
  runPowerShell = spawnSync,
  fileExists = existsSync,
  lstat = lstatSync,
  realpath = realpathSync,
} = {}) {
  let trustedPath;
  try {
    const metadata = lstat(directoryPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("root link");
    trustedPath = realpath(directoryPath);
    if (platformName !== "win32") {
      return (metadata.mode & 0o077) === 0
        ? { ok: true, trustedPath }
        : { ok: false, reason: "recovery_root_broad_permissions" };
    }
  } catch { return { ok: false, reason: "recovery_root_untrusted" }; }
  const trustedPowerShell = resolveLifecyclePowerShell({
    powershellPath, resolveSystemTool, fileExists, lstat, realpath,
  });
  if (!trustedPowerShell) return { ok: false, reason: "trusted_system_powershell_missing" };
  const escaped = trustedPath.replace(/'/gu, "''");
  const script = [
    "$ErrorActionPreference='Stop'",
    "Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop",
    `$acl=Get-Acl -LiteralPath '${escaped}'`,
    "$broadSids=@('S-1-1-0','S-1-5-32-545','S-1-5-11')",
    "$writeMask=[int][System.Security.AccessControl.FileSystemRights]::Write -bor [int][System.Security.AccessControl.FileSystemRights]::Modify -bor [int][System.Security.AccessControl.FileSystemRights]::FullControl -bor [int][System.Security.AccessControl.FileSystemRights]::Delete -bor [int][System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [int][System.Security.AccessControl.FileSystemRights]::TakeOwnership",
    "$unsafe=@($acl.Access|Where-Object{$sid=$null;try{$sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{};$_.AccessControlType -eq 'Allow' -and $broadSids -contains $sid -and (([int]$_.FileSystemRights -band $writeMask) -ne 0)})",
    "$ownerSid=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
    "$currentSid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$ownerTrusted=$ownerSid -in @($currentSid,'S-1-5-18','S-1-5-32-544')",
    "[pscustomobject]@{safe=($unsafe.Count -eq 0 -and $ownerTrusted);ownerSid=$ownerSid}|ConvertTo-Json -Compress",
  ].join("\n");
  try {
    const result = runPowerShell(trustedPowerShell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
    });
    const parsed = result.status === 0 ? JSON.parse(String(result.stdout || "")) : null;
    return parsed?.safe === true
      ? { ok: true, trustedPath, ownerDigest: createHash("sha256").update(parsed.ownerSid).digest("hex") }
      : { ok: false, reason: "recovery_root_broad_permissions" };
  } catch { return { ok: false, reason: "recovery_root_acl_probe_failed" }; }
}

export function discoverLatestVisualStudioCrtBundle({
  programFiles,
  programFilesX86,
  readDllVersion = readWindowsDllVersion,
  readdir = readdirSync,
  fileExists = existsSync,
  realpath = realpathSync,
  lstat = lstatSync,
  runVswhere = spawnSync,
  resolveProgramFilesRoots = resolveWindowsProgramFilesRoots,
  recordSourceIdentities = platform() === "win32" ? recordWindowsSourceFileIdentities : null,
} = {}) {
  const optionsWereInjected = programFiles !== undefined || programFilesX86 !== undefined;
  const osRoots = optionsWereInjected ? null : resolveProgramFilesRoots();
  const rawProgramRoots = [
    { kind: "program_files", path: programFiles ?? osRoots?.programFiles },
    { kind: "program_files_x86", path: programFilesX86 ?? osRoots?.programFilesX86 },
  ].filter(({ path }) => path);

  const trustedDirectory = (directoryPath, boundary = null) => {
    try {
      if (!fileExists(directoryPath)) return null;
      const metadata = lstat(directoryPath);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) return null;
      const trustedPath = realpath(directoryPath);
      return boundary && !pathInside(boundary, trustedPath) ? null : trustedPath;
    } catch {
      return null;
    }
  };
  const programRootByPath = new Map();
  for (const rawRoot of rawProgramRoots) {
    const trustedRoot = trustedDirectory(rawRoot.path);
    if (!trustedRoot) continue;
    const key = windowsPathKey(trustedRoot);
    const existing = programRootByPath.get(key);
    if (existing) existing.kinds.add(rawRoot.kind);
    else programRootByPath.set(key, { path: trustedRoot, kinds: new Set([rawRoot.kind]) });
  }

  const instanceRootByPath = new Map();
  const addInstanceRoot = (instancePath, boundary = null) => {
    const trustedInstance = trustedDirectory(instancePath, boundary);
    if (!trustedInstance) return;
    instanceRootByPath.set(windowsPathKey(trustedInstance), trustedInstance);
  };
  for (const programRoot of programRootByPath.values()) {
    const visualStudioRoot = trustedDirectory(
      join(programRoot.path, "Microsoft Visual Studio"),
      programRoot.path,
    );
    if (!visualStudioRoot) continue;
    for (const visualStudioVersion of safeDirectories(visualStudioRoot, readdir)) {
      const versionRoot = trustedDirectory(join(visualStudioRoot, visualStudioVersion), visualStudioRoot);
      if (!versionRoot) continue;
      for (const edition of safeDirectories(versionRoot, readdir)) {
        addInstanceRoot(join(versionRoot, edition), visualStudioRoot);
      }
    }

    if (!programRoot.kinds.has("program_files_x86")) continue;
    const installerRoot = trustedDirectory(join(visualStudioRoot, "Installer"), visualStudioRoot);
    if (!installerRoot) continue;
    const vswherePath = join(installerRoot, "vswhere.exe");
    let trustedVswhere;
    try {
      const metadata = lstat(vswherePath);
      if (!fileExists(vswherePath) || !metadata.isFile() || metadata.isSymbolicLink()) continue;
      trustedVswhere = realpath(vswherePath);
    } catch { continue; }
    if (!pathInside(installerRoot, trustedVswhere)) continue;
    let installations;
    try {
      const result = runVswhere(trustedVswhere, ["-products", "*", "-format", "json"], {
        encoding: "utf8",
        windowsHide: true,
      });
      installations = result.status === 0
        ? JSON.parse(String(result.stdout || "").replace(/^\uFEFF/u, ""))
        : null;
    } catch { installations = null; }
    if (!Array.isArray(installations)) continue;
    for (const installation of installations) {
      const installationPath = installation?.installationPath;
      if (
        typeof installationPath !== "string" ||
        !isAbsolute(installationPath) ||
        installationPath.split(/[\\/]/u).includes("..")
      ) continue;
      addInstanceRoot(installationPath);
    }
  }

  const candidates = [];
  for (const instanceRoot of instanceRootByPath.values()) {
    const vcRoot = trustedDirectory(join(instanceRoot, "VC"), instanceRoot);
    const redistRoot = vcRoot && trustedDirectory(join(vcRoot, "Redist"), instanceRoot);
    const msvcRoot = redistRoot && trustedDirectory(join(redistRoot, "MSVC"), instanceRoot);
    if (!msvcRoot) continue;
    for (const msvcVersion of safeDirectories(msvcRoot, readdir)) {
        const msvcVersionRoot = trustedDirectory(join(msvcRoot, msvcVersion), instanceRoot);
        if (!msvcVersionRoot) continue;
        const x64Root = trustedDirectory(join(msvcVersionRoot, "x64"), instanceRoot);
        if (!x64Root) continue;
        for (const bundleName of safeDirectories(x64Root, readdir)) {
          if (!/^Microsoft\.VC\d+\.CRT$/u.test(bundleName)) continue;
          const bundlePath = join(x64Root, bundleName);
          let trustedBundle;
          try {
            if (lstat(bundlePath).isSymbolicLink()) continue;
            trustedBundle = realpath(bundlePath);
          } catch { continue; }
          if (!pathInside(instanceRoot, trustedBundle)) continue;
          const files = WINDOWS_APP_LOCAL_CRT_DLLS.map((name) => join(trustedBundle, name));
          let filesAreTrusted = false;
          try {
            filesAreTrusted = files.every((filePath) => (
              fileExists(filePath) &&
              lstat(filePath).isFile() &&
              !lstat(filePath).isSymbolicLink() &&
              pathInside(trustedBundle, realpath(filePath))
            ));
          } catch {}
          if (!filesAreTrusted) continue;
          const versions = files.map(readDllVersion);
          if (versions.some((version) => !version) || new Set(versions).size !== 1) continue;
          candidates.push({
            bundlePath: trustedBundle,
            bundleName,
            msvcVersion,
            dllVersion: versions[0],
            files,
          });
        }
    }
  }
  candidates.sort((left, right) => (
    compareNumericVersions(right.dllVersion, left.dllVersion) ||
    compareNumericVersions(right.msvcVersion, left.msvcVersion)
  ));
  if (candidates.length === 0) {
    return { ok: false, reason: "complete_same_version_x64_crt_bundle_not_found" };
  }
  const selected = candidates[0];
  if (!recordSourceIdentities) return { ok: true, ...selected };
  const identityResult = recordSourceIdentities({ filePaths: selected.files });
  if (!identityResult?.ok) {
    return { ok: false, reason: identityResult?.reason ?? "source_identity_probe_failed" };
  }
  return { ok: true, ...selected, sourceIdentities: identityResult.records };
}

export function resolveWindowsCandidateExecutionChain({
  python,
  candidateDir,
  lstat = lstatSync,
  realpath = realpathSync,
  readFile = readFileSync,
  recordFileIdentities = recordWindowsSourceFileIdentities,
} = {}) {
  const launcher = typeof python === "string"
    ? { command: python, args: [] }
    : { command: python?.command, args: python?.args ?? [] };
  try {
    const trustedCandidate = realpath(candidateDir);
    const scriptsPath = join(trustedCandidate, "Scripts");
    const candidatePythonPath = join(scriptsPath, "python.exe");
    const candidateMemoryBin = join(scriptsPath, "memory.exe");
    const pyvenvPath = join(trustedCandidate, "pyvenv.cfg");
    for (const directoryPath of [trustedCandidate, scriptsPath]) {
      const metadata = lstat(directoryPath);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("execution directory link");
    }
    for (const filePath of [candidatePythonPath, candidateMemoryBin, pyvenvPath]) {
      const metadata = lstat(filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new Error("execution file link");
    }
    const trustedCandidatePython = realpath(candidatePythonPath);
    const trustedCandidateMemoryBin = realpath(candidateMemoryBin);
    if (!launcher.command || windowsPathKey(realpath(launcher.command)) !== windowsPathKey(trustedCandidatePython)) {
      throw new Error("candidate python mismatch");
    }
    const config = readFile(pyvenvPath, "utf8");
    const rawHome = config.match(/^home\s*=\s*(.+)$/imu)?.[1]?.trim().replace(/^(?:"(.*)"|'(.*)')$/u, "$1$2");
    if (!rawHome || !isAbsolute(rawHome)) throw new Error("venv home missing");
    const basePythonPath = join(rawHome, "python.exe");
    const baseMetadata = lstat(basePythonPath);
    if (!baseMetadata.isFile() || baseMetadata.isSymbolicLink() || baseMetadata.nlink !== 1) {
      throw new Error("base python untrusted");
    }
    const trustedPyvenvPath = realpath(pyvenvPath);
    const trustedBasePython = realpath(basePythonPath);
    const executionPaths = [...new Map(
      [trustedCandidatePython, trustedCandidateMemoryBin, trustedPyvenvPath, trustedBasePython]
        .map((filePath) => [windowsPathKey(filePath), filePath]),
    ).values()];
    const identityResult = recordFileIdentities({ filePaths: executionPaths });
    if (!identityResult?.ok || identityResult.records?.length !== executionPaths.length) {
      return { ok: false, reason: identityResult?.reason ?? "execution_identity_probe_failed" };
    }
    return {
      ok: true,
      executionPaths,
      expectedExecutionIdentities: identityResult.records,
      directoryPaths: [trustedCandidate, scriptsPath, dirname(trustedBasePython)],
      candidateMemoryBin: trustedCandidateMemoryBin,
    };
  } catch { return { ok: false, reason: "candidate_execution_chain_untrusted" }; }
}

export function repairWindowsCandidateOnnxRuntime({
  python,
  candidateDir,
  verifyArgs,
  platformName = platform(),
  discoverBundle = discoverLatestVisualStudioCrtBundle,
  realpath = realpathSync,
  lstat = lstatSync,
  runLockedDependencyProbe = runWindowsLockedDependencyProbe,
  recordSourceIdentities = recordWindowsSourceFileIdentities,
  resolveExecutionChain = resolveWindowsCandidateExecutionChain,
}) {
  if (platformName !== "win32") return { ok: false, reason: "windows_only_repair" };
  const bundle = discoverBundle();
  if (!bundle?.ok) return { ok: false, reason: bundle?.reason ?? "crt_bundle_not_found", evidence: bundle };
  let capiPath;
  let trustedCandidate;
  const candidateDirectoryPaths = [];
  const rawCandidate = resolve(candidateDir);
  const rawCapiPath = resolve(rawCandidate, "Lib", "site-packages", "onnxruntime", "capi");
  try {
    const candidateMetadata = lstat(rawCandidate);
    if (!candidateMetadata.isDirectory() || candidateMetadata.isSymbolicLink()) throw new Error("candidate link");
    trustedCandidate = realpath(rawCandidate);
    let current = rawCandidate;
    candidateDirectoryPaths.push(rawCandidate);
    for (const segment of relative(rawCandidate, rawCapiPath).split(/[\\/]/u).filter(Boolean)) {
      current = join(current, segment);
      const metadata = lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("capi chain link");
      candidateDirectoryPaths.push(current);
    }
    capiPath = realpath(rawCapiPath);
  } catch { return { ok: false, reason: "candidate_runtime_untrusted" }; }
  if (!pathInside(trustedCandidate, capiPath)) {
    return { ok: false, reason: "onnxruntime_capi_outside_candidate" };
  }
  const sourcePaths = WINDOWS_APP_LOCAL_CRT_DLLS.map((dllName) => join(bundle.bundlePath, dllName));
  const sourceIdentityResult = Array.isArray(bundle.sourceIdentities)
    ? { ok: true, records: bundle.sourceIdentities }
    : recordSourceIdentities({ filePaths: sourcePaths });
  if (
    !sourceIdentityResult?.ok ||
    !Array.isArray(sourceIdentityResult.records) ||
    sourceIdentityResult.records.length !== sourcePaths.length
  ) return { ok: false, reason: sourceIdentityResult?.reason ?? "source_identity_probe_failed" };
  const lockedDirectoryPaths = [];
  const lockedDirectoryKeys = new Set();
  const addTrustedAncestorChain = (leafPath) => {
    const chain = [];
    let current = resolve(leafPath);
    while (true) {
      chain.push(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (const directoryPath of chain.reverse()) {
      const metadata = lstat(directoryPath);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("directory chain link");
      const canonicalPath = realpath(directoryPath);
      if (windowsPathKey(canonicalPath) !== windowsPathKey(directoryPath)) {
        throw new Error("directory chain redirect");
      }
      const key = windowsPathKey(canonicalPath);
      if (!lockedDirectoryKeys.has(key)) {
        lockedDirectoryKeys.add(key);
        lockedDirectoryPaths.push(canonicalPath);
      }
    }
  };
  try {
    for (const directoryPath of [...candidateDirectoryPaths, bundle.bundlePath]) {
      addTrustedAncestorChain(directoryPath);
    }
  } catch { return { ok: false, reason: "runtime_parent_chain_untrusted" }; }
  const targets = WINDOWS_APP_LOCAL_CRT_DLLS.map((dllName) => ({
    dllName,
    sourcePath: join(bundle.bundlePath, dllName),
    targetPath: join(capiPath, dllName),
  }));
  for (const { targetPath } of targets) {
    try {
      lstat(targetPath);
      return { ok: false, reason: "windows_app_local_crt_target_exists" };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        return { ok: false, reason: "windows_app_local_crt_target_inspection_failed" };
      }
    }
  }
  const executionChain = resolveExecutionChain({
    python,
    candidateDir: trustedCandidate,
    lstat,
    realpath,
    recordFileIdentities: recordSourceIdentities,
  });
  if (!executionChain?.ok) {
    return { ok: false, reason: executionChain?.reason ?? "candidate_execution_chain_untrusted" };
  }
  try {
    for (const directoryPath of executionChain.directoryPaths) addTrustedAncestorChain(directoryPath);
  } catch { return { ok: false, reason: "runtime_parent_chain_untrusted" }; }
  const retry = runLockedDependencyProbe({
    python,
    verifyArgs,
    sourcePaths: targets.map(({ sourcePath }) => sourcePath),
    expectedSourceIdentities: sourceIdentityResult.records,
    executionPaths: executionChain.executionPaths,
    expectedExecutionIdentities: executionChain.expectedExecutionIdentities,
    targetPaths: targets.map(({ targetPath }) => targetPath),
    directoryPaths: lockedDirectoryPaths,
  });
  if (!retry?.ok) {
    return {
      ok: false,
      reason: retry?.reason ?? "locked_dependency_probe_failed",
      processResult: retry?.processResult,
      evidence: {
        sourceKind: "visual_studio_official_redist",
        bundleName: bundle.bundleName,
        msvcVersion: bundle.msvcVersion,
        dllVersion: bundle.dllVersion,
        copiedDlls: [],
        signatures: retry?.signatures,
        reason: retry?.reason ?? "locked_dependency_probe_failed",
      },
    };
  }
  return {
    ok: true,
    reason: "windows_app_local_crt_verified",
    processResult: retry.processResult,
    evidence: {
      sourceKind: "visual_studio_official_redist",
      bundleName: bundle.bundleName,
      msvcVersion: bundle.msvcVersion,
      dllVersion: bundle.dllVersion,
      copiedDlls: WINDOWS_APP_LOCAL_CRT_DLLS,
      signatures: retry.signatures,
      reason: "windows_app_local_crt_verified",
    },
  };
}

export function buildInitialMemoryServiceEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  delete env.HF_HUB_OFFLINE;
  delete env.TRANSFORMERS_OFFLINE;
  return {
    ...env,
    MCP_ALLOW_ANONYMOUS_ACCESS: "true",
    MCP_MEMORY_ONNX_ALLOW_DOWNLOAD: "1",
    MCP_MEMORY_ALLOW_HASH_EMBEDDINGS: "0",
    MCP_MEMORY_USE_ONNX: "1",
  };
}

export function buildBootMemoryServiceEnv(baseEnv = {}) {
  return {
    ...baseEnv,
    MCP_ALLOW_ANONYMOUS_ACCESS: "true",
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    MCP_MEMORY_ONNX_ALLOW_DOWNLOAD: "0",
    MCP_MEMORY_ALLOW_HASH_EMBEDDINGS: "0",
    MCP_MEMORY_USE_ONNX: "1",
  };
}

export function firstStartLogPaths(homeDir) {
  const logDir = join(homeDir, ".meta-kim");
  return {
    logDir,
    stdoutLog: join(logDir, "mcp-memory-first-start.out.log"),
    stderrLog: join(logDir, "mcp-memory-first-start.err.log"),
  };
}

export function observeMemoryServiceChild(child) {
  const state = {
    spawnError: null,
    exited: child?.exitCode !== null && child?.exitCode !== undefined,
    exitCode: child?.exitCode ?? null,
    signal: child?.signalCode ?? null,
  };
  child?.once?.("error", (error) => {
    state.spawnError = error;
  });
  child?.once?.("exit", (code, signal) => {
    state.exited = true;
    state.exitCode = code;
    state.signal = signal;
  });
  return state;
}

export function probeMcpMemoryHealth(
  healthUrl,
  { get = http.get, requestTimeoutMs = 3_000 } = {},
) {
  return new Promise((resolve) => {
    const req = get(healthUrl, { timeout: requestTimeoutMs }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        const status = res.statusCode ?? 500;
        if (status < 200 || status >= 300) {
          resolve(false);
          return;
        }
        try {
          resolve(JSON.parse(body)?.status === "healthy");
        } catch {
          resolve(false);
        }
      });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

export async function waitForMcpMemoryHealth({
  probeHealth,
  childState = null,
  timeoutMs = MCP_MEMORY_COLD_START_TIMEOUT_MS,
  pollIntervalMs = MCP_MEMORY_HEALTH_POLL_INTERVAL_MS,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  allowLauncherExit = false,
}) {
  const startedAt = now();
  while (true) {
    if (await probeHealth()) return { healthy: true, reason: "healthy" };
    if (childState?.spawnError) {
      return { healthy: false, reason: "spawn_error" };
    }
    if (childState?.exited && !allowLauncherExit) {
      return {
        healthy: false,
        reason: "early_exit",
        exitCode: childState.exitCode,
        signal: childState.signal,
      };
    }

    const elapsedMs = now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      return { healthy: false, reason: "health_timeout" };
    }
    await sleep(Math.min(pollIntervalMs, timeoutMs - elapsedMs));
  }
}

export function pythonMemoryHealthProbeArgs(healthUrl) {
  return ["-c", PYTHON_MEMORY_HEALTH_PROBE, healthUrl];
}

export function endpointStartLockName(endpoint) {
  const host = String(endpoint.hostname).replace(/[^a-z0-9.-]/giu, "_");
  return `mcp-memory-${host}-${endpoint.port}.lock`;
}

function atomicWriteJson(filePath, payload) {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

function readLockOwner(ownerPath) {
  return JSON.parse(readFileSync(ownerPath, "utf8").replace(/^\uFEFF/u, ""));
}

function readProcessStartIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform() === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      return stat.slice(close + 2).split(/\s+/u)[19] || null;
    } catch {
      return null;
    }
  }
  if (platform() === "darwin") {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() || null : null;
  }
  if (platform() === "win32") {
    const powershellPath = resolveTrustedWindowsSystemTool([
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ]);
    if (!powershellPath) return null;
    const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`;
    const result = spawnSync(powershellPath, ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
    });
    return result.status === 0 ? result.stdout.trim() || null : null;
  }
  return null;
}

const CURRENT_PROCESS_START_IDENTITY = readProcessStartIdentity(process.pid);

function defaultOwnerAlive(owner) {
  if (!Number.isInteger(owner?.ownerPid) || owner.ownerPid <= 0) return false;
  if (!owner.ownerStartIdentity) return false;
  if (owner.ownerPid === process.pid) {
    return Boolean(
      CURRENT_PROCESS_START_IDENTITY &&
      owner.ownerStartIdentity === CURRENT_PROCESS_START_IDENTITY,
    );
  }
  const actualStartIdentity = readProcessStartIdentity(owner.ownerPid);
  return Boolean(actualStartIdentity && actualStartIdentity === owner.ownerStartIdentity);
}

export function acquireEndpointStartLock({
  endpoint,
  lockRoot,
  ttlMs = 360_000,
  now = Date.now,
  ownerPid = process.pid,
  ownerStartIdentity = CURRENT_PROCESS_START_IDENTITY,
  isOwnerAlive = defaultOwnerAlive,
}) {
  mkdirSync(lockRoot, { recursive: true });
  const lockPath = join(lockRoot, endpointStartLockName(endpoint));
  const ownerPath = join(lockPath, "owner.json");
  const token = randomUUID();
  const claim = () => {
    mkdirSync(lockPath);
    const acquiredAt = now();
    atomicWriteJson(ownerPath, {
      schemaVersion: "meta-kim-mcp-memory-start-lock-v1",
      token,
      ownerPid,
      ownerStartIdentity,
      endpoint: endpoint.endpointUrl,
      acquiredAt,
      expiresAt: acquiredAt + ttlMs,
    });
    return { acquired: true, lockPath, ownerPath, token };
  };
  try {
    return claim();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  let existing = null;
  try {
    existing = readLockOwner(ownerPath);
  } catch {
    let ageMs = 0;
    try {
      ageMs = Math.max(0, now() - statSync(lockPath).mtimeMs);
    } catch {
      return { acquired: false, reason: "lock_owner_unreadable", lockPath };
    }
    if (ageMs < ttlMs) {
      return { acquired: false, reason: "lock_owner_initializing", lockPath };
    }
  }
  if (existing && isOwnerAlive(existing)) {
    return { acquired: false, reason: "lock_owner_alive", lockPath, owner: existing };
  }
  if (existing && (!Number.isFinite(existing.expiresAt) || existing.expiresAt > now())) {
    return { acquired: false, reason: "lock_held", lockPath, owner: existing };
  }

  const stalePath = `${lockPath}.stale.${token}`;
  try {
    renameSync(lockPath, stalePath);
    const acquired = claim();
    rmSync(stalePath, { recursive: true, force: true });
    return acquired;
  } catch {
    return { acquired: false, reason: "stale_lock_takeover_failed", lockPath };
  }
}

export function releaseEndpointStartLock(lock) {
  if (!lock?.acquired) return false;
  try {
    const owner = readLockOwner(lock.ownerPath);
    if (owner.token !== lock.token) return false;
    rmSync(lock.lockPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export async function withEndpointStartLock({
  endpoint,
  lockRoot,
  probeHealth,
  start,
  acquire = acquireEndpointStartLock,
  release = releaseEndpointStartLock,
}) {
  const lock = acquire({ endpoint, lockRoot });
  if (!lock.acquired) return { ok: false, started: false, reason: lock.reason };
  try {
    if (await probeHealth()) {
      return { ok: true, started: false, reason: "already_healthy_after_lock" };
    }
    return await start();
  } finally {
    release(lock);
  }
}
