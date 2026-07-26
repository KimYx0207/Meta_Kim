param(
  [Parameter(Mandatory = $true)][int]$RootPid,
  [Parameter(Mandatory = $true)][string]$ReadyPath,
  [Parameter(Mandatory = $true)][string]$StopPath,
  [Parameter(Mandatory = $true)][string]$ResultPath
)

$ErrorActionPreference = 'Stop'

$toolhelpSource = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class MetaKimToolhelpProcessTree
{
    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    public sealed class Entry
    {
        public int Pid { get; set; }
        public int ParentPid { get; set; }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    public static Entry[] Snapshot()
    {
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == INVALID_HANDLE_VALUE)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        try
        {
            var result = new List<Entry>();
            var entry = new PROCESSENTRY32();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (!Process32FirstW(snapshot, ref entry))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            do
            {
                result.Add(new Entry
                {
                    Pid = unchecked((int)entry.th32ProcessID),
                    ParentPid = unchecked((int)entry.th32ParentProcessID),
                });
                entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            }
            while (Process32NextW(snapshot, ref entry));

            return result.ToArray();
        }
        finally
        {
            CloseHandle(snapshot);
        }
    }
}
'@

Add-Type -TypeDefinition $toolhelpSource -Language CSharp
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Get-ProcessStartTicks([int]$ProcessId) {
  try {
    return [System.Diagnostics.Process]::GetProcessById($ProcessId).StartTime.ToUniversalTime().Ticks
  } catch {
    return $null
  }
}

function Test-SameProcess([int]$ProcessId, [long]$ExpectedStartTicks) {
  $actual = Get-ProcessStartTicks $ProcessId
  return $null -ne $actual -and $actual -eq $ExpectedStartTicks
}

function Add-Descendants($Snapshot, [System.Collections.Generic.HashSet[int]]$KnownIds) {
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($entry in $Snapshot) {
      if ($KnownIds.Contains([int]$entry.ParentPid) -and -not $KnownIds.Contains([int]$entry.Pid)) {
        [void]$KnownIds.Add([int]$entry.Pid)
        $changed = $true
      }
    }
  }
}

function Write-GuardResult([bool]$Verified, [string]$Reason, [int]$TrackedCount, [int]$SurvivorCount) {
  $payload = [ordered]@{
    schemaVersion = 'meta-kim-windows-process-tree-guard-v1'
    verified = $Verified
    reason = $Reason
    trackedCount = $TrackedCount
    survivorCount = $SurvivorCount
  } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($ResultPath, $payload, $utf8NoBom)
}

$rootStartTicks = Get-ProcessStartTicks $RootPid
if ($null -eq $rootStartTicks) {
  Write-GuardResult $false 'root_not_found_before_guard_ready' 0 0
  exit 2
}

$knownIds = [System.Collections.Generic.HashSet[int]]::new()
[void]$knownIds.Add($RootPid)
$identities = @{}
$identities[[string]$RootPid] = [long]$rootStartTicks

# Prove Toolhelp32 works before the parent releases the gated evaluator.
$initialSnapshot = [MetaKimToolhelpProcessTree]::Snapshot()
Add-Descendants $initialSnapshot $knownIds
[System.IO.File]::WriteAllText($ReadyPath, 'ready', $utf8NoBom)

while ((Test-SameProcess $RootPid $rootStartTicks) -and -not (Test-Path -LiteralPath $StopPath)) {
  $liveSnapshot = [MetaKimToolhelpProcessTree]::Snapshot()
  Add-Descendants $liveSnapshot $knownIds
  foreach ($processId in @($knownIds)) {
    if (-not $identities.ContainsKey([string]$processId)) {
      $ticks = Get-ProcessStartTicks $processId
      if ($null -ne $ticks) {
        $identities[[string]$processId] = [long]$ticks
      }
    }
  }
  Start-Sleep -Milliseconds 100
}

for ($pass = 0; $pass -lt 12; $pass += 1) {
  $snapshot = [MetaKimToolhelpProcessTree]::Snapshot()
  Add-Descendants $snapshot $knownIds
  foreach ($processId in @($knownIds)) {
    if (-not $identities.ContainsKey([string]$processId)) {
      $ticks = Get-ProcessStartTicks $processId
      if ($null -ne $ticks) {
        $identities[[string]$processId] = [long]$ticks
      }
    }
  }

  # Stop the root first so it cannot create more children while descendants
  # are being drained. PID + start-time checks prevent PID-reuse termination.
  $orderedIds = @($RootPid) + @($knownIds | Where-Object { $_ -ne $RootPid })
  foreach ($processId in $orderedIds) {
    $key = [string]$processId
    if (-not $identities.ContainsKey($key)) { continue }
    if (-not (Test-SameProcess $processId ([long]$identities[$key]))) { continue }
    try {
      [System.Diagnostics.Process]::GetProcessById($processId).Kill()
    } catch {
      # A process that exited between identity verification and Kill is clean.
    }
  }
  Start-Sleep -Milliseconds 125
}

$finalSnapshot = [MetaKimToolhelpProcessTree]::Snapshot()
Add-Descendants $finalSnapshot $knownIds
$survivors = @()
foreach ($processId in @($knownIds)) {
  $key = [string]$processId
  if (-not $identities.ContainsKey($key)) {
    $ticks = Get-ProcessStartTicks $processId
    if ($null -ne $ticks) {
      $identities[$key] = [long]$ticks
    }
  }
  if ($identities.ContainsKey($key) -and (Test-SameProcess $processId ([long]$identities[$key]))) {
    $survivors += $processId
  }
}

$verified = $survivors.Count -eq 0
$resultReason = 'survivors_detected'
if ($verified) { $resultReason = 'process_tree_terminated' }
Write-GuardResult $verified $resultReason $knownIds.Count $survivors.Count
if (-not $verified) { exit 2 }
