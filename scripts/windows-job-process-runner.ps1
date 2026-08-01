param(
  [Parameter(Mandatory = $true)][string]$SpecPath,
  [Parameter(Mandatory = $true)][string]$StopPath,
  [Parameter(Mandatory = $true)][string]$ResultPath,
  [Parameter(Mandatory = $true)][int]$OwnerPid,
  [long]$OwnerStartTimeTicks = 0
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$schemaVersion = 'meta-kim-windows-job-process-runner-v1'

function Write-RunnerResult([hashtable]$Values) {
  $payload = [ordered]@{
    schemaVersion = $schemaVersion
    verified = [bool]$Values.verified
    reason = [string]$Values.reason
    childExitCode = $Values.childExitCode
    activeProcesses = [long]$Values.activeProcesses
    stopRequested = [bool]$Values.stopRequested
    failureOperation = $Values.failureOperation
    win32Error = $Values.win32Error
    detail = $Values.detail
    cleanupFailure = $Values.cleanupFailure
  } | ConvertTo-Json -Compress

  [System.IO.File]::WriteAllText($ResultPath, $payload, $utf8NoBom)
}

$fallbackResult = @{
  verified = $false
  reason = 'launcher_initialization_failed'
  childExitCode = $null
  activeProcesses = -1
  stopRequested = (Test-Path -LiteralPath $StopPath)
  failureOperation = 'launcher_initialization'
  win32Error = $null
  detail = $null
  cleanupFailure = $null
}

try {
  if ($OwnerPid -le 0) {
    throw 'OwnerPid must be a positive process identifier.'
  }
  if ($OwnerStartTimeTicks -lt 0) {
    throw 'OwnerStartTimeTicks must be zero or a positive UTC DateTime tick value.'
  }

  if (-not (Test-Path -LiteralPath $SpecPath -PathType Leaf)) {
    throw "Spec file does not exist: $SpecPath"
  }

  $spec = Get-Content -Raw -LiteralPath $SpecPath | ConvertFrom-Json
  $propertyNames = @($spec.PSObject.Properties.Name)
  if (-not ($propertyNames -contains 'file') -or [string]::IsNullOrWhiteSpace([string]$spec.file)) {
    throw 'Spec property "file" must be a non-empty string.'
  }
  if (-not ($propertyNames -contains 'args') -or $null -eq $spec.args -or $spec.args -isnot [System.Array]) {
    throw 'Spec property "args" must be an array of strings.'
  }
  if (-not ($propertyNames -contains 'cwd') -or [string]::IsNullOrWhiteSpace([string]$spec.cwd)) {
    throw 'Spec property "cwd" must be a non-empty string.'
  }

  $file = [string]$spec.file
  $arguments = New-Object System.Collections.Generic.List[string]
  foreach ($argument in $spec.args) {
    if ($null -eq $argument -or $argument -isnot [string]) {
      throw 'Every spec.args entry must be a non-null string.'
    }
    [void]$arguments.Add([string]$argument)
  }

  $workingDirectory = [System.IO.Path]::GetFullPath([string]$spec.cwd)
  if (-not [System.IO.Directory]::Exists($workingDirectory)) {
    throw "Spec working directory does not exist: $workingDirectory"
  }

  $nativeSource = @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace MetaKim
{
    /// <summary>
    /// Runs one Windows process inside a private Job Object and proves that the
    /// job is empty before returning a successful supervision result.
    /// </summary>
    public static class WindowsJobProcessRunner
    {
        private const uint CREATE_SUSPENDED = 0x00000004;
        private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        private const uint STARTF_USESTDHANDLES = 0x00000100;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private const uint DUPLICATE_SAME_ACCESS = 0x00000002;
        private const uint SYNCHRONIZE = 0x00100000;
        private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000;
        private const uint FILE_TYPE_PIPE = 0x00000003;
        private const int STD_INPUT_HANDLE = -10;
        private const int ERROR_HANDLE_EOF = 38;
        private const int ERROR_BROKEN_PIPE = 109;
        private const int ERROR_NO_DATA = 232;
        private const int ERROR_PIPE_NOT_CONNECTED = 233;
        private const uint GENERIC_READ = 0x80000000;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint OPEN_EXISTING = 3;
        private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
        private const uint WAIT_OBJECT_0 = 0x00000000;
        private const uint WAIT_TIMEOUT = 0x00000102;
        private const uint WAIT_FAILED = 0xFFFFFFFF;
        private const uint INVALID_RESUME_RESULT = 0xFFFFFFFF;
        private const uint STOP_EXIT_CODE = 1;
        private const int ERROR_INSUFFICIENT_BUFFER = 122;
        private const int POLL_INTERVAL_MS = 50;
        private const int DRAIN_TIMEOUT_MS = 15000;
        private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);
        private static readonly UIntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST =
            new UIntPtr(0x00020002);

        private enum JobObjectInformationClass
        {
            JobObjectBasicAccountingInformation = 1,
            JobObjectExtendedLimitInformation = 9
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SecurityAttributes
        {
            public int Length;
            public IntPtr SecurityDescriptor;
            [MarshalAs(UnmanagedType.Bool)]
            public bool InheritHandle;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct StartupInfo
        {
            public int Size;
            public IntPtr Reserved;
            public IntPtr Desktop;
            public IntPtr Title;
            public uint X;
            public uint Y;
            public uint XSize;
            public uint YSize;
            public uint XCountChars;
            public uint YCountChars;
            public uint FillAttribute;
            public uint Flags;
            public short ShowWindow;
            public short Reserved2Size;
            public IntPtr Reserved2;
            public IntPtr StandardInput;
            public IntPtr StandardOutput;
            public IntPtr StandardError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct StartupInfoEx
        {
            public StartupInfo StartupInfo;
            public IntPtr AttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessInformation
        {
            public IntPtr Process;
            public IntPtr Thread;
            public uint ProcessId;
            public uint ThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct FileTime
        {
            public uint LowDateTime;
            public uint HighDateTime;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectBasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectExtendedLimitInformation
        {
            public JobObjectBasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectBasicAccountingInformation
        {
            public long TotalUserTime;
            public long TotalKernelTime;
            public long ThisPeriodTotalUserTime;
            public long ThisPeriodTotalKernelTime;
            public uint TotalPageFaultCount;
            public uint TotalProcesses;
            public uint ActiveProcesses;
            public uint TotalTerminatedProcesses;
        }

        private sealed class KernelHandle : SafeHandleZeroOrMinusOneIsInvalid
        {
            public KernelHandle()
                : base(true)
            {
            }

            public KernelHandle(IntPtr handle)
                : base(true)
            {
                SetHandle(handle);
            }

            protected override bool ReleaseHandle()
            {
                return CloseHandle(handle);
            }
        }

        private sealed class JobHandle : SafeHandleZeroOrMinusOneIsInvalid
        {
            public JobHandle()
                : base(true)
            {
            }

            protected override bool ReleaseHandle()
            {
                return CloseHandle(handle);
            }
        }

        private sealed class NativeFailure : Exception
        {
            public NativeFailure(string reason, string operation, int errorCode)
                : base(operation + " failed with Win32 error " + errorCode + ": " +
                    new Win32Exception(errorCode).Message)
            {
                Reason = reason;
                Operation = operation;
                ErrorCode = errorCode;
            }

            public string Reason { get; private set; }
            public string Operation { get; private set; }
            public int ErrorCode { get; private set; }
        }

        private sealed class LauncherFailure : Exception
        {
            public LauncherFailure(string reason, string operation, string detail)
                : base(detail)
            {
                Reason = reason;
                Operation = operation;
            }

            public string Reason { get; private set; }
            public string Operation { get; private set; }
        }

        private sealed class OwnerStdinLease
        {
            private readonly KernelHandle input;
            private readonly KernelHandle closedEvent;
            private volatile int state;
            private volatile int readError;

            private OwnerStdinLease(KernelHandle inputHandle, KernelHandle eventHandle)
            {
                input = inputHandle;
                closedEvent = eventHandle;
            }

            public static OwnerStdinLease Start()
            {
                IntPtr source = GetStdHandle(STD_INPUT_HANDLE);
                if (source == IntPtr.Zero || source == INVALID_HANDLE_VALUE)
                {
                    int error = Marshal.GetLastWin32Error();
                    throw new NativeFailure(
                        "owner_stdin_lease_unavailable",
                        "GetStdHandle(stdin)",
                        error == 0 ? 6 : error);
                }
                uint fileType = GetFileType(source);
                if (fileType != FILE_TYPE_PIPE)
                {
                    throw new LauncherFailure(
                        "owner_stdin_lease_not_pipe",
                        "GetFileType(stdin)",
                        "Wrapper stdin must be an owned pipe kept open by the supervisor.");
                }

                IntPtr duplicate;
                IntPtr currentProcess = GetCurrentProcess();
                if (!DuplicateHandle(
                    currentProcess,
                    source,
                    currentProcess,
                    out duplicate,
                    0,
                    false,
                    DUPLICATE_SAME_ACCESS))
                {
                    throw LastError(
                        "duplicate_owner_stdin_lease_failed",
                        "DuplicateHandle(stdin)");
                }

                KernelHandle inputHandle = new KernelHandle(duplicate);
                KernelHandle eventHandle = CreateEventW(
                    IntPtr.Zero,
                    true,
                    false,
                    null);
                if (eventHandle == null || eventHandle.IsInvalid)
                {
                    inputHandle.Dispose();
                    throw LastError(
                        "create_owner_stdin_lease_event_failed",
                        "CreateEventW");
                }

                OwnerStdinLease lease = new OwnerStdinLease(
                    inputHandle,
                    eventHandle);
                lease.ProbeOpen();
                Thread reader = new Thread(lease.ReadUntilEof);
                reader.IsBackground = true;
                reader.Name = "MetaKimOwnerStdinLease";
                reader.Start();
                return lease;
            }

            public bool IsClosed()
            {
                if (state == 2)
                {
                    throw new NativeFailure(
                        "read_owner_stdin_lease_failed",
                        "ReadFile(ownerStdinLease)",
                        readError);
                }
                if (state == 1)
                {
                    return true;
                }
                uint wait = WaitForSingleObject(closedEvent, 0);
                if (wait == WAIT_TIMEOUT)
                {
                    return false;
                }
                if (wait == WAIT_FAILED)
                {
                    throw LastError(
                        "wait_owner_stdin_lease_failed",
                        "WaitForSingleObject(ownerStdinLease)");
                }
                if (wait != WAIT_OBJECT_0)
                {
                    throw new LauncherFailure(
                        "wait_owner_stdin_lease_unexpected_status",
                        "WaitForSingleObject(ownerStdinLease)",
                        "Unexpected owner stdin lease wait status: " + wait);
                }
                if (state == 2)
                {
                    throw new NativeFailure(
                        "read_owner_stdin_lease_failed",
                        "ReadFile(ownerStdinLease)",
                        readError);
                }
                return true;
            }

            public void ProbeOpen()
            {
                if (state != 0)
                {
                    return;
                }
                uint available;
                if (!PeekNamedPipe(
                    input.DangerousGetHandle(),
                    IntPtr.Zero,
                    0,
                    IntPtr.Zero,
                    out available,
                    IntPtr.Zero))
                {
                    int error = Marshal.GetLastWin32Error();
                    if (IsLeaseClosedError(error))
                    {
                        state = 1;
                        SetEvent(closedEvent);
                        return;
                    }
                    throw new NativeFailure(
                        "probe_owner_stdin_lease_failed",
                        "PeekNamedPipe(ownerStdinLease)",
                        error);
                }
            }

            private void ReadUntilEof()
            {
                byte[] buffer = new byte[64];
                while (true)
                {
                    uint bytesRead;
                    bool read = ReadFile(
                        input.DangerousGetHandle(),
                        buffer,
                        (uint)buffer.Length,
                        out bytesRead,
                        IntPtr.Zero);
                    if (!read)
                    {
                        int error = Marshal.GetLastWin32Error();
                        if (IsLeaseClosedError(error))
                        {
                            state = 1;
                        }
                        else
                        {
                            readError = error;
                            state = 2;
                        }
                        SetEvent(closedEvent);
                        return;
                    }
                    if (bytesRead == 0)
                    {
                        state = 1;
                        SetEvent(closedEvent);
                        return;
                    }
                }
            }

            private static bool IsLeaseClosedError(int error)
            {
                return error == ERROR_HANDLE_EOF ||
                    error == ERROR_BROKEN_PIPE ||
                    error == ERROR_NO_DATA ||
                    error == ERROR_PIPE_NOT_CONNECTED;
            }
        }

        /// <summary>Structured result returned to the PowerShell transport.</summary>
        public sealed class RunnerResult
        {
            public bool Verified { get; set; }
            public string Reason { get; set; }
            public long? ChildExitCode { get; set; }
            public long ActiveProcesses { get; set; }
            public bool StopRequested { get; set; }
            public string FailureOperation { get; set; }
            public int? Win32Error { get; set; }
            public string Detail { get; set; }
            public string CleanupFailure { get; set; }
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern JobHandle CreateJobObjectW(
            IntPtr jobAttributes,
            string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(
            JobHandle job,
            JobObjectInformationClass informationClass,
            ref JobObjectExtendedLimitInformation information,
            uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool QueryInformationJobObject(
            JobHandle job,
            JobObjectInformationClass informationClass,
            out JobObjectBasicAccountingInformation information,
            uint informationLength,
            IntPtr returnLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AssignProcessToJobObject(
            JobHandle job,
            KernelHandle process);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateJobObject(JobHandle job, uint exitCode);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateProcessW(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref StartupInfoEx startupInfo,
            out ProcessInformation processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(KernelHandle thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(KernelHandle handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetExitCodeProcess(KernelHandle process, out uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateProcess(KernelHandle process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern KernelHandle OpenProcess(
            uint desiredAccess,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
            uint processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint GetProcessId(KernelHandle process);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentProcessId();

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetProcessTimes(
            KernelHandle process,
            out FileTime creationTime,
            out FileTime exitTime,
            out FileTime kernelTime,
            out FileTime userTime);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint GetFileType(IntPtr handle);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern KernelHandle CreateEventW(
            IntPtr eventAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool manualReset,
            [MarshalAs(UnmanagedType.Bool)] bool initialState,
            string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetEvent(KernelHandle eventHandle);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ReadFile(
            IntPtr file,
            byte[] buffer,
            uint bytesToRead,
            out uint bytesRead,
            IntPtr overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool PeekNamedPipe(
            IntPtr pipe,
            IntPtr buffer,
            uint bufferSize,
            IntPtr bytesRead,
            out uint totalBytesAvailable,
            IntPtr bytesLeftThisMessage);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetStdHandle(int standardHandle);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DuplicateHandle(
            IntPtr sourceProcess,
            IntPtr sourceHandle,
            IntPtr targetProcess,
            out IntPtr targetHandle,
            uint desiredAccess,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
            uint options);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            ref SecurityAttributes securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint SearchPathW(
            string path,
            string fileName,
            string extension,
            int bufferLength,
            StringBuilder buffer,
            out IntPtr filePart);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool InitializeProcThreadAttributeList(
            IntPtr attributeList,
            int attributeCount,
            uint flags,
            ref UIntPtr size);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UpdateProcThreadAttribute(
            IntPtr attributeList,
            uint flags,
            UIntPtr attribute,
            IntPtr value,
            UIntPtr size,
            IntPtr previousValue,
            IntPtr returnSize);

        [DllImport("kernel32.dll")]
        private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

        /// <summary>
        /// Launches and supervises one process. The inherited environment is the
        /// wrapper environment; stdin is NUL and stdout/stderr are restricted to
        /// inheritable duplicates of the wrapper standard handles.
        /// </summary>
        public static RunnerResult Run(
            string file,
            string[] arguments,
            string workingDirectory,
            string stopPath,
            int ownerPid,
            long expectedOwnerStartTimeTicks)
        {
            RunnerResult result = new RunnerResult
            {
                Verified = false,
                Reason = "launcher_failed",
                ChildExitCode = null,
                ActiveProcesses = -1,
                StopRequested = File.Exists(stopPath)
            };

            JobHandle job = null;
            KernelHandle process = null;
            KernelHandle thread = null;
            KernelHandle owner = null;
            OwnerStdinLease ownerLease = null;
            bool jobConfigured = false;
            bool processAssigned = false;
            bool ownerExited = false;

            try
            {
                ownerLease = OwnerStdinLease.Start();
                if (ownerLease.IsClosed())
                {
                    throw new LauncherFailure(
                        "owner_stdin_lease_closed_before_child_creation",
                        "ReadFile(ownerStdinLease)",
                        "The supervisor stdin lease closed before child creation.");
                }
                owner = OpenAndVerifyOwner(
                    ownerPid,
                    expectedOwnerStartTimeTicks);
                if (IsProcessExited(owner, "owner"))
                {
                    throw new LauncherFailure(
                        "owner_process_exited_before_child_creation",
                        "WaitForSingleObject(owner)",
                        "The owner process exited before child creation.");
                }
                if (ownerLease.IsClosed())
                {
                    throw new LauncherFailure(
                        "owner_stdin_lease_closed_before_child_creation",
                        "ReadFile(ownerStdinLease)",
                        "The supervisor stdin lease closed before child creation.");
                }

                string executablePath = ResolveExecutablePath(
                    file,
                    workingDirectory);
                job = CreateJobObjectW(IntPtr.Zero, null);
                if (job == null || job.IsInvalid)
                {
                    throw LastError("create_job_failed", "CreateJobObjectW");
                }

                JobObjectExtendedLimitInformation limits =
                    new JobObjectExtendedLimitInformation();
                limits.BasicLimitInformation.LimitFlags =
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if (!SetInformationJobObject(
                    job,
                    JobObjectInformationClass.JobObjectExtendedLimitInformation,
                    ref limits,
                    (uint)Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation))))
                {
                    throw LastError(
                        "set_kill_on_job_close_failed",
                        "SetInformationJobObject");
                }
                jobConfigured = true;

                ProcessInformation nativeProcess = CreateSuspendedProcess(
                    executablePath,
                    arguments,
                    workingDirectory);
                process = new KernelHandle(nativeProcess.Process);
                thread = new KernelHandle(nativeProcess.Thread);

                if (!AssignProcessToJobObject(job, process))
                {
                    throw LastError(
                        "assign_process_to_job_failed",
                        "AssignProcessToJobObject");
                }
                processAssigned = true;

                result.StopRequested = File.Exists(stopPath);
                ownerExited = IsProcessExited(owner, "owner") ||
                    ownerLease.IsClosed();
                if (!result.StopRequested && !ownerExited)
                {
                    uint previousSuspendCount = ResumeThread(thread);
                    if (previousSuspendCount == INVALID_RESUME_RESULT)
                    {
                        throw LastError("resume_thread_failed", "ResumeThread");
                    }
                    if (previousSuspendCount != 1)
                    {
                        throw new LauncherFailure(
                            "resume_thread_unexpected_suspend_count",
                            "ResumeThread",
                            "ResumeThread returned an unexpected suspend count: " +
                            previousSuspendCount);
                    }
                }

                bool rootExited = false;
                while (!rootExited && !result.StopRequested && !ownerExited)
                {
                    ownerExited = IsProcessExited(owner, "owner") ||
                        ownerLease.IsClosed();
                    if (ownerExited)
                    {
                        break;
                    }
                    result.StopRequested = File.Exists(stopPath);
                    if (result.StopRequested)
                    {
                        break;
                    }

                    uint waitResult = WaitForSingleObject(process, POLL_INTERVAL_MS);
                    if (waitResult == WAIT_OBJECT_0)
                    {
                        rootExited = true;
                        break;
                    }
                    if (waitResult == WAIT_FAILED)
                    {
                        throw LastError(
                            "wait_for_process_failed",
                            "WaitForSingleObject");
                    }
                    if (waitResult != WAIT_TIMEOUT)
                    {
                        throw new LauncherFailure(
                            "wait_for_process_unexpected_status",
                            "WaitForSingleObject",
                            "WaitForSingleObject returned an unexpected status: " +
                            waitResult);
                    }

                }

                result.StopRequested =
                    result.StopRequested || File.Exists(stopPath);
                ownerExited = ownerExited ||
                    IsProcessExited(owner, "owner") ||
                    ownerLease.IsClosed();

                if (ownerExited)
                {
                    TerminateJobOrThrow(
                        job,
                        "terminate_job_after_owner_exit_failed");
                }
                else if (result.StopRequested)
                {
                    TerminateJobOrThrow(job, "terminate_job_after_stop_failed");
                }
                else
                {
                    result.ChildExitCode = GetProcessExitCode(process);
                    uint activeBeforeDrain = QueryActiveProcesses(job);
                    result.ActiveProcesses = activeBeforeDrain;
                    if (activeBeforeDrain > 0)
                    {
                        TerminateJobOrThrow(
                            job,
                            "terminate_remaining_job_members_failed");
                    }
                }

                result.ActiveProcesses = DrainJob(job);
                result.ChildExitCode = GetProcessExitCode(process);
                ownerExited = ownerExited ||
                    IsProcessExited(owner, "owner") ||
                    ownerLease.IsClosed();

                uint finalActive = QueryActiveProcesses(job);
                result.ActiveProcesses = finalActive;
                if (finalActive != 0)
                {
                    throw new LauncherFailure(
                        "job_not_empty_after_drain",
                        "QueryInformationJobObject",
                        "Job verification completed with active processes: " +
                        finalActive);
                }

                result.Verified = true;
                result.Reason = ownerExited
                    ? "owner_process_exited_job_terminated"
                    : result.StopRequested
                        ? "stop_requested_job_terminated"
                        : "process_exited_job_drained";
                return result;
            }
            catch (NativeFailure failure)
            {
                result.Reason = failure.Reason;
                result.FailureOperation = failure.Operation;
                result.Win32Error = failure.ErrorCode;
                result.Detail = failure.Message;
                return result;
            }
            catch (LauncherFailure failure)
            {
                result.Reason = failure.Reason;
                result.FailureOperation = failure.Operation;
                result.Detail = failure.Message;
                return result;
            }
            catch (Exception failure)
            {
                result.Reason = "launcher_internal_failure";
                result.FailureOperation = "managed_launcher";
                result.Detail = failure.GetType().FullName + ": " + failure.Message;
                return result;
            }
            finally
            {
                if (!result.Verified)
                {
                    result.StopRequested = result.StopRequested || File.Exists(stopPath);
                    string cleanupFailure = TryFailClosedCleanup(
                        job,
                        process,
                        processAssigned);
                    result.CleanupFailure = cleanupFailure;
                    if (job != null && !job.IsInvalid && jobConfigured)
                    {
                        try
                        {
                            result.ActiveProcesses = QueryActiveProcesses(job);
                        }
                        catch (Exception queryError)
                        {
                            result.ActiveProcesses = -1;
                            string queryFailure =
                                queryError.GetType().FullName + ": " +
                                queryError.Message;
                            result.CleanupFailure =
                                String.IsNullOrEmpty(result.CleanupFailure)
                                    ? queryFailure
                                    : result.CleanupFailure + "; " + queryFailure;
                        }
                    }
                }

                if (thread != null)
                {
                    thread.Dispose();
                }
                if (process != null)
                {
                    process.Dispose();
                }
                if (owner != null)
                {
                    owner.Dispose();
                }
                if (job != null)
                {
                    job.Dispose();
                }
            }
        }

        private static KernelHandle OpenAndVerifyOwner(
            int ownerPid,
            long expectedStartTimeTicks)
        {
            if (ownerPid <= 0 || (uint)ownerPid == GetCurrentProcessId())
            {
                throw new LauncherFailure(
                    "owner_process_identity_invalid",
                    "OpenProcess(owner)",
                    "OwnerPid must identify a positive process other than the launcher.");
            }

            KernelHandle owner = OpenProcess(
                SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                false,
                unchecked((uint)ownerPid));
            if (owner == null || owner.IsInvalid)
            {
                throw LastError("open_owner_process_failed", "OpenProcess(owner)");
            }

            try
            {
                uint actualPid = GetProcessId(owner);
                if (actualPid == 0)
                {
                    throw LastError(
                        "query_owner_process_id_failed",
                        "GetProcessId(owner)");
                }
                if (actualPid != unchecked((uint)ownerPid))
                {
                    throw new LauncherFailure(
                        "owner_process_identity_mismatch",
                        "GetProcessId(owner)",
                        "The retained owner handle did not match OwnerPid.");
                }

                FileTime creation;
                FileTime exit;
                FileTime kernel;
                FileTime user;
                if (!GetProcessTimes(owner, out creation, out exit, out kernel, out user))
                {
                    throw LastError(
                        "query_owner_process_times_failed",
                        "GetProcessTimes(owner)");
                }
                long actualStartTimeTicks = FileTimeToUtcTicks(creation);
                if (expectedStartTimeTicks > 0 &&
                    actualStartTimeTicks != expectedStartTimeTicks)
                {
                    throw new LauncherFailure(
                        "owner_process_start_time_mismatch",
                        "GetProcessTimes(owner)",
                        "The retained owner handle creation time did not match " +
                        "OwnerStartTimeTicks.");
                }
                return owner;
            }
            catch
            {
                owner.Dispose();
                throw;
            }
        }

        private static long FileTimeToUtcTicks(FileTime fileTime)
        {
            ulong value = ((ulong)fileTime.HighDateTime << 32) |
                fileTime.LowDateTime;
            if (value > Int64.MaxValue)
            {
                throw new LauncherFailure(
                    "owner_process_start_time_invalid",
                    "GetProcessTimes(owner)",
                    "Owner creation FILETIME exceeded Int64 range.");
            }
            return DateTime.FromFileTimeUtc((long)value).Ticks;
        }

        private static bool IsProcessExited(KernelHandle process, string label)
        {
            uint wait = WaitForSingleObject(process, 0);
            if (wait == WAIT_OBJECT_0)
            {
                return true;
            }
            if (wait == WAIT_TIMEOUT)
            {
                return false;
            }
            if (wait == WAIT_FAILED)
            {
                throw LastError(
                    "wait_for_" + label + "_process_failed",
                    "WaitForSingleObject(" + label + ")");
            }
            throw new LauncherFailure(
                "wait_for_" + label + "_process_unexpected_status",
                "WaitForSingleObject(" + label + ")",
                "Unexpected process wait status: " + wait);
        }

        private static string ResolveExecutablePath(
            string file,
            string workingDirectory)
        {
            if (String.IsNullOrWhiteSpace(file))
            {
                throw new LauncherFailure(
                    "executable_path_invalid",
                    "ResolveExecutablePath",
                    "Executable file must not be empty.");
            }

            bool hasDirectoryPart = file.IndexOf('\\') >= 0 ||
                file.IndexOf('/') >= 0;
            if (Path.IsPathRooted(file) || hasDirectoryPart)
            {
                string candidate = Path.IsPathRooted(file)
                    ? Path.GetFullPath(file)
                    : Path.GetFullPath(Path.Combine(workingDirectory, file));
                if (!File.Exists(candidate) &&
                    String.IsNullOrEmpty(Path.GetExtension(candidate)))
                {
                    candidate += ".exe";
                }
                if (!File.Exists(candidate))
                {
                    throw new LauncherFailure(
                        "executable_path_not_found",
                        "ResolveExecutablePath",
                        "Explicit executable path does not exist: " + candidate);
                }
                return candidate;
            }

            if (file.IndexOf(':') >= 0)
            {
                throw new LauncherFailure(
                    "executable_path_invalid",
                    "ResolveExecutablePath",
                    "Drive-relative executable paths are not allowed.");
            }

            string safeSearchPath = BuildAbsoluteSearchPath();
            StringBuilder resolved = new StringBuilder(32768);
            IntPtr filePart;
            uint length = SearchPathW(
                safeSearchPath,
                file,
                ".exe",
                resolved.Capacity,
                resolved,
                out filePart);
            if (length == 0)
            {
                throw LastError(
                    "resolve_executable_failed",
                    "SearchPathW");
            }
            if (length >= resolved.Capacity)
            {
                resolved = new StringBuilder(checked((int)length + 1));
                length = SearchPathW(
                    safeSearchPath,
                    file,
                    ".exe",
                    resolved.Capacity,
                    resolved,
                    out filePart);
                if (length == 0 || length >= resolved.Capacity)
                {
                    throw LastError(
                        "resolve_executable_failed",
                        "SearchPathW");
                }
            }

            string absolute = Path.GetFullPath(resolved.ToString());
            if (!Path.IsPathRooted(absolute) || !File.Exists(absolute))
            {
                throw new LauncherFailure(
                    "resolved_executable_invalid",
                    "SearchPathW",
                    "SearchPathW did not return an existing absolute executable.");
            }
            return absolute;
        }

        private static string BuildAbsoluteSearchPath()
        {
            string rawPath = Environment.GetEnvironmentVariable("PATH") ?? String.Empty;
            string[] entries = rawPath.Split(Path.PathSeparator);
            StringBuilder safe = new StringBuilder();
            foreach (string rawEntry in entries)
            {
                string entry = Environment.ExpandEnvironmentVariables(
                    rawEntry.Trim().Trim('"'));
                if (String.IsNullOrWhiteSpace(entry) || !Path.IsPathRooted(entry))
                {
                    continue;
                }
                string absolute;
                try
                {
                    absolute = Path.GetFullPath(entry);
                }
                catch
                {
                    continue;
                }
                if (!Directory.Exists(absolute))
                {
                    continue;
                }
                if (safe.Length > 0)
                {
                    safe.Append(Path.PathSeparator);
                }
                safe.Append(absolute);
            }
            if (safe.Length == 0)
            {
                throw new LauncherFailure(
                    "safe_executable_search_path_empty",
                    "BuildAbsoluteSearchPath",
                    "PATH contained no existing absolute directories.");
            }
            return safe.ToString();
        }

        private static ProcessInformation CreateSuspendedProcess(
            string file,
            string[] arguments,
            string workingDirectory)
        {
            if (String.IsNullOrWhiteSpace(file))
            {
                throw new ArgumentException("Executable file must not be empty.", "file");
            }

            string commandText = BuildCommandLine(file, arguments);
            if (commandText.Length > 32766)
            {
                throw new LauncherFailure(
                    "command_line_too_long",
                    "BuildCommandLine",
                    "The Windows command line exceeds 32766 characters.");
            }

            KernelHandle standardInput = null;
            KernelHandle standardOutput = null;
            KernelHandle standardError = null;
            IntPtr attributeList = IntPtr.Zero;
            IntPtr handleList = IntPtr.Zero;

            try
            {
                SecurityAttributes security = new SecurityAttributes
                {
                    Length = Marshal.SizeOf(typeof(SecurityAttributes)),
                    SecurityDescriptor = IntPtr.Zero,
                    InheritHandle = true
                };
                IntPtr nullInput = CreateFileW(
                    "NUL",
                    GENERIC_READ,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    ref security,
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    IntPtr.Zero);
                if (nullInput == INVALID_HANDLE_VALUE)
                {
                    throw LastError("open_null_stdin_failed", "CreateFileW(NUL)");
                }
                standardInput = new KernelHandle(nullInput);

                standardOutput = DuplicateStandardHandle(
                    -11,
                    "duplicate_stdout_failed",
                    "DuplicateHandle(stdout)");
                standardError = DuplicateStandardHandle(
                    -12,
                    "duplicate_stderr_failed",
                    "DuplicateHandle(stderr)");

                IntPtr[] inheritedHandles = new IntPtr[]
                {
                    standardInput.DangerousGetHandle(),
                    standardOutput.DangerousGetHandle(),
                    standardError.DangerousGetHandle()
                };
                handleList = Marshal.AllocHGlobal(IntPtr.Size * inheritedHandles.Length);
                Marshal.Copy(inheritedHandles, 0, handleList, inheritedHandles.Length);

                UIntPtr attributeListSize = UIntPtr.Zero;
                bool initialResult = InitializeProcThreadAttributeList(
                    IntPtr.Zero,
                    1,
                    0,
                    ref attributeListSize);
                int initialError = Marshal.GetLastWin32Error();
                if (initialResult || initialError != ERROR_INSUFFICIENT_BUFFER ||
                    attributeListSize == UIntPtr.Zero)
                {
                    throw new NativeFailure(
                        "initialize_attribute_list_failed",
                        "InitializeProcThreadAttributeList(size)",
                        initialError);
                }

                attributeList = Marshal.AllocHGlobal(
                    checked((int)attributeListSize.ToUInt64()));
                if (!InitializeProcThreadAttributeList(
                    attributeList,
                    1,
                    0,
                    ref attributeListSize))
                {
                    throw LastError(
                        "initialize_attribute_list_failed",
                        "InitializeProcThreadAttributeList");
                }
                if (!UpdateProcThreadAttribute(
                    attributeList,
                    0,
                    PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                    handleList,
                    new UIntPtr((uint)(IntPtr.Size * inheritedHandles.Length)),
                    IntPtr.Zero,
                    IntPtr.Zero))
                {
                    throw LastError(
                        "update_handle_list_failed",
                        "UpdateProcThreadAttribute");
                }

                StartupInfoEx startup = new StartupInfoEx();
                startup.StartupInfo.Size = Marshal.SizeOf(typeof(StartupInfoEx));
                startup.StartupInfo.Flags = STARTF_USESTDHANDLES;
                startup.StartupInfo.StandardInput = inheritedHandles[0];
                startup.StartupInfo.StandardOutput = inheritedHandles[1];
                startup.StartupInfo.StandardError = inheritedHandles[2];
                startup.AttributeList = attributeList;

                ProcessInformation processInformation;
                StringBuilder mutableCommandLine = new StringBuilder(commandText);
                if (!CreateProcessW(
                    file,
                    mutableCommandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT,
                    IntPtr.Zero,
                    workingDirectory,
                    ref startup,
                    out processInformation))
                {
                    throw LastError("create_process_failed", "CreateProcessW");
                }

                return processInformation;
            }
            finally
            {
                if (attributeList != IntPtr.Zero)
                {
                    DeleteProcThreadAttributeList(attributeList);
                    Marshal.FreeHGlobal(attributeList);
                }
                if (handleList != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(handleList);
                }
                if (standardError != null)
                {
                    standardError.Dispose();
                }
                if (standardOutput != null)
                {
                    standardOutput.Dispose();
                }
                if (standardInput != null)
                {
                    standardInput.Dispose();
                }
            }
        }

        private static KernelHandle DuplicateStandardHandle(
            int standardHandleId,
            string reason,
            string operation)
        {
            IntPtr source = GetStdHandle(standardHandleId);
            if (source == IntPtr.Zero || source == INVALID_HANDLE_VALUE)
            {
                int error = Marshal.GetLastWin32Error();
                if (error == 0)
                {
                    error = 6;
                }
                throw new NativeFailure(reason, "GetStdHandle", error);
            }

            IntPtr duplicate;
            IntPtr currentProcess = GetCurrentProcess();
            if (!DuplicateHandle(
                currentProcess,
                source,
                currentProcess,
                out duplicate,
                0,
                true,
                DUPLICATE_SAME_ACCESS))
            {
                throw LastError(reason, operation);
            }
            return new KernelHandle(duplicate);
        }

        private static string BuildCommandLine(string file, string[] arguments)
        {
            StringBuilder command = new StringBuilder();
            command.Append(QuoteCommandLineArgument(file));
            if (arguments != null)
            {
                foreach (string argument in arguments)
                {
                    if (argument == null)
                    {
                        throw new ArgumentException(
                            "Command arguments must not contain null.",
                            "arguments");
                    }
                    command.Append(' ');
                    command.Append(QuoteCommandLineArgument(argument));
                }
            }
            return command.ToString();
        }

        private static string QuoteCommandLineArgument(string argument)
        {
            if (argument.Length == 0)
            {
                return "\"\"";
            }
            if (argument.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '\"' }) < 0)
            {
                return argument;
            }

            StringBuilder quoted = new StringBuilder();
            quoted.Append('\"');
            int backslashes = 0;
            foreach (char character in argument)
            {
                if (character == '\\')
                {
                    backslashes++;
                    continue;
                }
                if (character == '\"')
                {
                    quoted.Append('\\', backslashes * 2 + 1);
                    quoted.Append('\"');
                    backslashes = 0;
                    continue;
                }
                quoted.Append('\\', backslashes);
                backslashes = 0;
                quoted.Append(character);
            }
            quoted.Append('\\', backslashes * 2);
            quoted.Append('\"');
            return quoted.ToString();
        }

        private static uint QueryActiveProcesses(JobHandle job)
        {
            JobObjectBasicAccountingInformation accounting;
            if (!QueryInformationJobObject(
                job,
                JobObjectInformationClass.JobObjectBasicAccountingInformation,
                out accounting,
                (uint)Marshal.SizeOf(typeof(JobObjectBasicAccountingInformation)),
                IntPtr.Zero))
            {
                throw LastError("query_job_failed", "QueryInformationJobObject");
            }
            return accounting.ActiveProcesses;
        }

        private static long DrainJob(JobHandle job)
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(DRAIN_TIMEOUT_MS);
            uint active = QueryActiveProcesses(job);
            while (active != 0 && DateTime.UtcNow < deadline)
            {
                Thread.Sleep(POLL_INTERVAL_MS);
                active = QueryActiveProcesses(job);
            }
            if (active != 0)
            {
                throw new LauncherFailure(
                    "job_drain_timeout",
                    "QueryInformationJobObject",
                    "Timed out waiting for the Job Object to become empty; active=" +
                    active);
            }
            return active;
        }

        private static long GetProcessExitCode(KernelHandle process)
        {
            uint exitCode;
            if (!GetExitCodeProcess(process, out exitCode))
            {
                throw LastError("get_exit_code_failed", "GetExitCodeProcess");
            }
            return exitCode;
        }

        private static void TerminateJobOrThrow(JobHandle job, string reason)
        {
            if (!TerminateJobObject(job, STOP_EXIT_CODE))
            {
                throw LastError(reason, "TerminateJobObject");
            }
        }

        private static string TryFailClosedCleanup(
            JobHandle job,
            KernelHandle process,
            bool processAssigned)
        {
            try
            {
                if (processAssigned && job != null && !job.IsInvalid)
                {
                    if (!TerminateJobObject(job, STOP_EXIT_CODE))
                    {
                        int error = Marshal.GetLastWin32Error();
                        return "TerminateJobObject cleanup failed with Win32 error " +
                            error + ": " + new Win32Exception(error).Message;
                    }
                    return null;
                }

                if (process != null && !process.IsInvalid)
                {
                    uint waitResult = WaitForSingleObject(process, 0);
                    if (waitResult == WAIT_TIMEOUT &&
                        !TerminateProcess(process, STOP_EXIT_CODE))
                    {
                        int error = Marshal.GetLastWin32Error();
                        return "TerminateProcess cleanup failed with Win32 error " +
                            error + ": " + new Win32Exception(error).Message;
                    }
                }
            }
            catch (Exception cleanupError)
            {
                return cleanupError.GetType().FullName + ": " + cleanupError.Message;
            }
            return null;
        }

        private static NativeFailure LastError(string reason, string operation)
        {
            return new NativeFailure(reason, operation, Marshal.GetLastWin32Error());
        }
    }
}
'@

  Add-Type -TypeDefinition $nativeSource -Language CSharp
  $nativeResult = [MetaKim.WindowsJobProcessRunner]::Run(
    $file,
    $arguments.ToArray(),
    $workingDirectory,
    [System.IO.Path]::GetFullPath($StopPath),
    $OwnerPid,
    $OwnerStartTimeTicks
  )

  $result = @{
    verified = $nativeResult.Verified
    reason = $nativeResult.Reason
    childExitCode = $nativeResult.ChildExitCode
    activeProcesses = $nativeResult.ActiveProcesses
    stopRequested = $nativeResult.StopRequested
    failureOperation = $nativeResult.FailureOperation
    win32Error = $nativeResult.Win32Error
    detail = $nativeResult.Detail
    cleanupFailure = $nativeResult.CleanupFailure
  }
  Write-RunnerResult $result
  if ($nativeResult.Verified) {
    exit 0
  }
  exit 2
} catch {
  $fallbackResult.reason = 'launcher_initialization_failed'
  $fallbackResult.detail = $_.Exception.GetType().FullName + ': ' + $_.Exception.Message
  try {
    Write-RunnerResult $fallbackResult
  } catch {
    [Console]::Error.WriteLine(
      'Meta_Kim Windows Job launcher could not write its failure result: ' +
      $_.Exception.Message
    )
  }
  exit 2
}
