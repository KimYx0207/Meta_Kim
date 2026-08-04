import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import {
  PROCESS_SIGNAL_TIMEOUT_MS,
  inspectWindowsEndpointListener,
  isEndpointNotListening,
  parseWindowsNetstatListeners,
  resolveWindowsVenvProcessExpectation,
  resolveTrustedWindowsSystemDirectory,
  resolveTrustedWindowsSystemTool,
  stopVerifiedEndpointProcess,
  verifyMemoryListenerIdentity,
} from "../../scripts/mcp-memory-process-control.mjs";

const endpoint = { hostname: "127.0.0.1", port: "8123" };
const executablePath = resolve("fixture", "Python312", "python.exe");
const launcherPath = resolve("fixture", "candidate", "Scripts", "memory.exe");
const identity = {
  platform: "win32",
  pid: 42,
  startIdentity: "start-1",
  listenerHost: endpoint.hostname,
  listenerPort: endpoint.port,
  executablePath,
  argv: [
    executablePath,
    launcherPath,
    "server",
    "--http",
    "--http-host",
    endpoint.hostname,
    "--http-port",
    endpoint.port,
  ],
};

describe("MCP memory endpoint process control", () => {
  test("Windows process signalling allows real taskkill latency without becoming unbounded", () => {
    assert.equal(PROCESS_SIGNAL_TIMEOUT_MS, 30_000);
  });

  test("Windows system tools resolve from OS-loaded modules and kernel alias", (context) => {
    if (platform() !== "win32") {
      context.skip("Windows-only loaded-module trust anchor");
      return;
    }
    const system32 = resolveTrustedWindowsSystemDirectory();
    assert.ok(system32);
    for (const [segments, expectedName] of [
      [["netstat.exe"], "netstat.exe"],
      [["taskkill.exe"], "taskkill.exe"],
      [["WindowsPowerShell", "v1.0", "powershell.exe"], "powershell.exe"],
    ]) {
      const tool = resolveTrustedWindowsSystemTool(segments);
      assert.ok(tool);
      assert.equal(tool.toLowerCase().startsWith(system32.toLowerCase()), true);
      assert.equal(tool.toLowerCase().endsWith(expectedName), true);
    }
  });

  test("forged SystemRoot tools are never selected or spawned", (context) => {
    if (platform() !== "win32") {
      context.skip("Windows-only forged environment regression");
      return;
    }
    const fakeRoot = mkdtempSync(join(tmpdir(), "meta-kim-fake-systemroot-"));
    const fakeSystem32 = join(fakeRoot, "System32");
    const fakePowerShellDir = join(fakeSystem32, "WindowsPowerShell", "v1.0");
    const previous = {
      SystemRoot: process.env.SystemRoot,
      windir: process.env.windir,
      ComSpec: process.env.ComSpec,
    };
    try {
      mkdirSync(fakePowerShellDir, { recursive: true });
      for (const fakeTool of [
        join(fakeSystem32, "netstat.exe"),
        join(fakeSystem32, "taskkill.exe"),
        join(fakePowerShellDir, "powershell.exe"),
      ]) writeFileSync(fakeTool, "attacker-tool");
      process.env.SystemRoot = fakeRoot;
      process.env.windir = fakeRoot;
      process.env.ComSpec = join(fakeSystem32, "cmd.exe");

      const trustedNetstat = resolveTrustedWindowsSystemTool(["netstat.exe"]);
      assert.ok(trustedNetstat);
      assert.equal(trustedNetstat.toLowerCase().startsWith(fakeRoot.toLowerCase()), false);

      const commands = [];
      const inspection = inspectWindowsEndpointListener({ hostname: "localhost", port: 8000 }, {
        run: (command) => {
          commands.push(command);
          return { status: null, stdout: "", error: { code: "ETIMEDOUT" } };
        },
      });
      assert.equal(inspection.kind, "identity_unavailable");
      assert.equal(commands.length, 1);
      assert.equal(commands.some((command) => (
        String(command).toLowerCase().startsWith(fakeRoot.toLowerCase())
      )), false);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  test("loaded kernel module directory disagreement fails closed", () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-loaded-module-mismatch-"));
    try {
      const first = join(root, "one");
      const second = join(root, "two");
      mkdirSync(first, { recursive: true });
      mkdirSync(second, { recursive: true });
      const kernel32 = join(first, "KERNEL32.DLL");
      const ntdll = join(second, "ntdll.dll");
      writeFileSync(kernel32, "kernel32");
      writeFileSync(ntdll, "ntdll");
      assert.equal(resolveTrustedWindowsSystemDirectory({
        reportProvider: () => ({ sharedObjects: [kernel32, ntdll] }),
        kernelSystem32Path: first,
      }), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Windows netstat parser accepts IPv4 and IPv6 listeners for one PID and ignores adjacent ports", () => {
    const parsed = parseWindowsNetstatListeners([
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    127.0.0.1:8000         0.0.0.0:0              LISTENING       4312",
      "  TCP    [::1]:8000             [::]:0                 LISTENING       4312",
      "  TCP    127.0.0.1:18000        0.0.0.0:0              LISTENING       9999",
      "  TCP    127.0.0.1:8001         0.0.0.0:0              LISTENING       9998",
      "  TCP    127.0.0.1:8000         127.0.0.1:50000        ESTABLISHED     7777",
    ].join("\r\n"), "8000");
    assert.deepEqual(parsed, {
      ok: true,
      pid: 4312,
      listenerHosts: ["127.0.0.1", "::1"],
      listenerPort: "8000",
    });
  });

  test("Windows netstat parser fails closed when one endpoint has multiple listener PIDs", () => {
    const parsed = parseWindowsNetstatListeners([
      "  TCP    127.0.0.1:8000         0.0.0.0:0              LISTENING       4312",
      "  TCP    [::1]:8000             [::]:0                 LISTENING       4313",
    ].join("\r\n"), 8000);
    assert.deepEqual(parsed, {
      ok: false,
      reason: "ambiguous_listener_pids",
      pids: [4312, 4313],
    });
  });

  test("Windows inspection uses fixed native tools, exact PID, and bounded child timeouts", () => {
    const calls = [];
    const listenerPid = 4312;
    const run = (command, args, options) => {
      calls.push({ command, args, options });
      if (calls.length === 1) {
        return {
          status: 0,
          stdout: [
            `  TCP    127.0.0.1:8000         0.0.0.0:0              LISTENING       ${listenerPid}`,
            `  TCP    [::1]:8000             [::]:0                 LISTENING       ${listenerPid}`,
          ].join("\r\n"),
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          pid: listenerPid,
          executablePath,
          commandLine: `"${executablePath}" "${launcherPath}" server --http --http-host localhost --http-port 8000`,
          startIdentity: "start-real",
        }),
      };
    };
    const result = inspectWindowsEndpointListener({ hostname: "localhost", port: 8000 }, {
      run,
      netstatPath: "C:\\Windows\\System32\\netstat.exe",
      powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      discoveryTimeoutMs: 4_000,
      processQueryTimeoutMs: 12_000,
    });
    assert.equal(result.pid, listenerPid);
    assert.deepEqual(result.listenerHosts, ["127.0.0.1", "::1"]);
    assert.deepEqual(calls[0].args, ["-ano", "-p", "tcp"]);
    assert.equal(calls[0].options.timeout, 4_000);
    assert.match(calls[1].args.at(-1), /Get-Process -Id 4312/u);
    assert.match(calls[1].args.at(-1), /ReadCommandLine\(4312\)/u);
    assert.doesNotMatch(calls[1].args.at(-1), /Get-CimInstance|Get-NetTCPConnection/u);
    assert.equal(calls[1].options.timeout, 12_000);
  });

  test("Windows inspection fails closed when netstat or targeted process query times out", () => {
    const timedOut = { status: null, stdout: "", error: { code: "ETIMEDOUT" } };
    let calls = 0;
    const discoveryTimeout = inspectWindowsEndpointListener({ hostname: "localhost", port: 8000 }, {
      netstatPath: "C:\\Windows\\System32\\netstat.exe",
      powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      run: (_command, _args, options) => {
        calls += 1;
        assert.ok(options.timeout > 0);
        return timedOut;
      },
    });
    assert.equal(discoveryTimeout.kind, "identity_unavailable");
    assert.equal(discoveryTimeout.reason, "listener_discovery_failed");
    assert.equal(calls, 1);

    calls = 0;
    const processTimeout = inspectWindowsEndpointListener({ hostname: "localhost", port: 8000 }, {
      netstatPath: "C:\\Windows\\System32\\netstat.exe",
      powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      run: (_command, _args, options) => {
        calls += 1;
        assert.ok(options.timeout > 0);
        if (calls === 1) {
          return {
            status: 0,
            stdout: "TCP 127.0.0.1:8000 0.0.0.0:0 LISTENING 4312",
          };
        }
        return timedOut;
      },
    });
    assert.equal(processTimeout.kind, "identity_unavailable");
    assert.equal(processTimeout.reason, "process_query_failed");
    assert.equal(processTimeout.pid, 4312);
    assert.equal(calls, 2);
  });

  test("authoritative empty netstat is distinct from unreadable listener identity", () => {
    const notListening = inspectWindowsEndpointListener({ hostname: "localhost", port: 8000 }, {
      netstatPath: "C:\\Windows\\System32\\netstat.exe",
      powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      run: () => ({ status: 0, stdout: "Active Connections\r\n" }),
    });
    assert.equal(isEndpointNotListening(notListening), true);

    let calls = 0;
    const unknown = inspectWindowsEndpointListener({ hostname: "localhost", port: 8000 }, {
      netstatPath: "C:\\Windows\\System32\\netstat.exe",
      powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      run: () => {
        calls += 1;
        return calls === 1
          ? { status: 0, stdout: "TCP 127.0.0.1:8000 0.0.0.0:0 LISTENING 4312" }
          : { status: 0, stdout: "not-json" };
      },
    });
    assert.equal(isEndpointNotListening(unknown), false);
    assert.equal(unknown.kind, "identity_unavailable");
    assert.equal(unknown.reason, "process_query_parse_failed");
  });

  test("identity requires endpoint PID, start identity, executable realpath, and exact argv", () => {
    assert.equal(verifyMemoryListenerIdentity(identity, {
      executablePath,
      launcherPath,
      host: endpoint.hostname,
      port: endpoint.port,
    }).verified, true);
    assert.equal(verifyMemoryListenerIdentity({ ...identity, startIdentity: null }, {
      executablePath,
      launcherPath,
      host: endpoint.hostname,
      port: endpoint.port,
    }).verified, false);
    assert.equal(verifyMemoryListenerIdentity({ ...identity, argv: identity.argv.with(6, "9999") }, {
      executablePath,
      launcherPath,
      host: endpoint.hostname,
      port: endpoint.port,
    }).verified, false);
  });

  test("real Windows chain accepts base Python listener plus exact candidate memory launcher", () => {
    const result = verifyMemoryListenerIdentity({
      ...identity,
      listenerHost: "127.0.0.1",
      argv: [
        executablePath,
        launcherPath,
        "server",
        "--http",
        "--http-host",
        "localhost",
        "--http-port",
        "8000",
      ],
      listenerPort: "8000",
    }, {
      platform: "win32",
      executablePath,
      launcherPath,
      host: "localhost",
      port: "8000",
    });
    assert.equal(result.verified, true);
    assert.equal(result.evidence.executablePath, executablePath);
    assert.equal(result.evidence.launcherPath, launcherPath);
  });

  test("outer memory.exe listener and non-candidate launcher are both rejected", () => {
    assert.equal(verifyMemoryListenerIdentity({
      ...identity,
      executablePath: launcherPath,
      argv: [launcherPath, "server", "--http", ...identity.argv.slice(4)],
    }, {
      executablePath,
      launcherPath,
      host: endpoint.hostname,
      port: endpoint.port,
    }).reason, "executable_mismatch");

    assert.equal(verifyMemoryListenerIdentity({
      ...identity,
      argv: [executablePath, resolve("attacker", "memory.exe"), ...identity.argv.slice(2)],
    }, {
      executablePath,
      launcherPath,
      host: endpoint.hostname,
      port: endpoint.port,
    }).reason, "launcher_argv_slot_mismatch");
  });

  test("listener host and port must match independently of argv", () => {
    const expected = {
      executablePath,
      launcherPath,
      host: endpoint.hostname,
      port: endpoint.port,
    };
    assert.equal(verifyMemoryListenerIdentity({
      ...identity,
      listenerHost: "0.0.0.0",
    }, expected).reason, "listener_host_mismatch");
    assert.equal(verifyMemoryListenerIdentity({
      ...identity,
      listenerPort: "9999",
    }, expected).reason, "listener_port_mismatch");
  });

  test("Windows venv expectation resolves one trusted base Python from pyvenv.cfg", () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-process-identity-"));
    try {
      const baseDir = join(root, "Python312");
      const venvDir = join(root, "candidate");
      const scriptsDir = join(venvDir, "Scripts");
      const basePython = join(baseDir, "python.exe");
      const memoryBin = join(scriptsDir, "memory.exe");
      mkdirSync(baseDir, { recursive: true });
      mkdirSync(scriptsDir, { recursive: true });
      writeFileSync(basePython, "base-python");
      writeFileSync(memoryBin, "launcher");
      writeFileSync(
        join(venvDir, "pyvenv.cfg"),
        `home = ${baseDir}\nexecutable = ${basePython}\n`,
      );

      const expected = resolveWindowsVenvProcessExpectation(memoryBin);
      assert.equal(expected.expectedExecutablePath, resolve(basePython));
      assert.equal(expected.expectedLauncherPath, resolve(memoryBin));

      writeFileSync(
        join(venvDir, "pyvenv.cfg"),
        `home = ${join(root, "different-python")}\nexecutable = ${basePython}\n`,
      );
      assert.equal(resolveWindowsVenvProcessExpectation(memoryBin), null);

      const otherBaseDir = join(root, "different-python");
      mkdirSync(otherBaseDir, { recursive: true });
      writeFileSync(join(otherBaseDir, "python.exe"), "different-base-python");
      assert.equal(resolveWindowsVenvProcessExpectation(memoryBin), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("nested Windows venv executable is accepted only when its own home proves the same base Python", () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-nested-process-identity-"));
    try {
      const baseDir = join(root, "Python312");
      const oldVenv = join(root, "memory-venv");
      const candidateVenv = join(root, "candidate");
      const basePython = join(baseDir, "python.exe");
      const oldPython = join(oldVenv, "Scripts", "python.exe");
      const candidatePython = join(candidateVenv, "Scripts", "python.exe");
      const memoryBin = join(candidateVenv, "Scripts", "memory.exe");
      for (const dir of [baseDir, dirname(oldPython), dirname(candidatePython)]) {
        mkdirSync(dir, { recursive: true });
      }
      for (const file of [basePython, oldPython, candidatePython, memoryBin]) {
        writeFileSync(file, file);
      }
      writeFileSync(join(oldVenv, "pyvenv.cfg"), `home = ${baseDir}\n`);
      writeFileSync(
        join(candidateVenv, "pyvenv.cfg"),
        `home = ${baseDir}\nexecutable = ${oldPython}\n`,
      );

      const expected = resolveWindowsVenvProcessExpectation(memoryBin);
      assert.equal(expected.expectedExecutablePath, resolve(basePython));
      assert.deepEqual(new Set(expected.expectedExecutablePaths), new Set([
        resolve(basePython),
        resolve(oldPython),
        resolve(candidatePython),
      ]));

      writeFileSync(join(oldVenv, "pyvenv.cfg"), `home = ${join(root, "other-base")}\n`);
      assert.equal(resolveWindowsVenvProcessExpectation(memoryBin), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("base Python layout resolves only same-root python.exe and exact Scripts memory.exe", () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-base-python-identity-"));
    try {
      const scriptsDir = join(root, "Scripts");
      const basePython = join(root, "python.exe");
      const memoryBin = join(scriptsDir, "memory.exe");
      mkdirSync(scriptsDir, { recursive: true });
      writeFileSync(basePython, "base-python");
      writeFileSync(memoryBin, "memory-launcher");

      const expected = resolveWindowsVenvProcessExpectation(memoryBin);
      assert.equal(expected.runtimeLayout, "base_python");
      assert.equal(expected.expectedExecutablePath, resolve(basePython));
      assert.deepEqual(expected.expectedExecutablePaths, [resolve(basePython)]);
      assert.equal(expected.expectedLauncherPath, resolve(memoryBin));

      const verification = verifyMemoryListenerIdentity({
        kind: "listening",
        pid: 9123,
        startIdentity: "base-start",
        listenerHost: "127.0.0.1",
        listenerPort: "8000",
        executablePath: basePython,
        argv: [
          basePython,
          memoryBin,
          "server",
          "--http",
          "--http-host",
          "localhost",
          "--http-port",
          "8000",
        ],
      }, {
        executablePath: expected.expectedExecutablePath,
        executablePaths: expected.expectedExecutablePaths,
        launcherPath: expected.expectedLauncherPath,
        host: "localhost",
        port: "8000",
      });
      assert.equal(verification.verified, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("base Python layout rejects attacker nesting, wrong root, and linked Scripts directory", () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-base-python-attack-"));
    try {
      const basePython = join(root, "python.exe");
      writeFileSync(basePython, "base-python");

      const nestedMemory = join(root, "attacker", "Scripts", "memory.exe");
      mkdirSync(dirname(nestedMemory), { recursive: true });
      writeFileSync(nestedMemory, "nested-launcher");
      assert.equal(resolveWindowsVenvProcessExpectation(nestedMemory), null);

      const wrongRoot = join(root, "wrong-root");
      const wrongRootMemory = join(wrongRoot, "Scripts", "memory.exe");
      mkdirSync(dirname(wrongRootMemory), { recursive: true });
      writeFileSync(wrongRootMemory, "wrong-root-launcher");
      assert.equal(resolveWindowsVenvProcessExpectation(wrongRootMemory), null);

      const linkedRoot = join(root, "linked-root");
      const realScripts = join(root, "real-scripts");
      mkdirSync(linkedRoot, { recursive: true });
      mkdirSync(realScripts, { recursive: true });
      writeFileSync(join(linkedRoot, "python.exe"), "linked-base-python");
      writeFileSync(join(realScripts, "memory.exe"), "linked-launcher");
      symlinkSync(realScripts, join(linkedRoot, "Scripts"), "junction");
      assert.equal(
        resolveWindowsVenvProcessExpectation(join(linkedRoot, "Scripts", "memory.exe")),
        null,
      );

      const wrongName = join(root, "Scripts", "memory-copy.exe");
      mkdirSync(dirname(wrongName), { recursive: true });
      writeFileSync(wrongName, "wrong-name");
      assert.equal(resolveWindowsVenvProcessExpectation(wrongName), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("POSIX launcher must occupy the shebang argv slot and attacker argv is rejected", () => {
    const interpreter = resolve("fixture", "python");
    const launcher = resolve("fixture", "memory");
    const expected = {
      platform: "linux",
      executablePath: interpreter,
      launcherPath: launcher,
      host: endpoint.hostname,
      port: endpoint.port,
    };
    const valid = {
      ...identity,
      platform: "linux",
      listenerHost: endpoint.hostname,
      executablePath: interpreter,
      argv: [interpreter, launcher, ...identity.argv.slice(2)],
    };
    assert.equal(verifyMemoryListenerIdentity(valid, expected).verified, true);
    assert.equal(verifyMemoryListenerIdentity({
      ...valid,
      argv: [interpreter, resolve("attacker", "wrapper"), ...identity.argv.slice(2), launcher],
    }, expected).verified, false);
  });

  test("insufficient identity evidence fails closed without signalling", async () => {
    const signals = [];
    const result = await stopVerifiedEndpointProcess({
      endpoint,
      expectedExecutablePath: executablePath,
      inspect: () => ({
        ...identity,
        executablePath: resolve("other", "memory.exe"),
        argv: [
          resolve("other", "memory.exe"),
          launcherPath,
          ...identity.argv.slice(2),
        ],
      }),
      expectedLauncherPath: launcherPath,
      signal: (...args) => { signals.push(args); return true; },
    });
    assert.equal(result.ok, false);
    assert.equal(signals.length, 0);
  });

  test("only explicit not_listening is released; null or unknown identity fails closed", async () => {
    const noListener = await stopVerifiedEndpointProcess({
      endpoint,
      expectedExecutablePath: executablePath,
      expectedLauncherPath: launcherPath,
      inspect: () => ({ kind: "not_listening", reason: "not_listening" }),
      signal: () => assert.fail("must not signal without a listener"),
    });
    assert.deepEqual(noListener, {
      ok: true,
      stopped: false,
      reason: "not_listening",
    });

    for (const inspection of [
      null,
      { kind: "identity_unavailable", reason: "process_query_failed", pid: 42 },
    ]) {
      const signals = [];
      const result = await stopVerifiedEndpointProcess({
        endpoint,
        expectedExecutablePath: executablePath,
        expectedLauncherPath: launcherPath,
        inspect: () => inspection,
        signal: (...args) => { signals.push(args); return true; },
      });
      assert.equal(result.ok, false);
      assert.equal(result.stopped, false);
      assert.equal(signals.length, 0);
    }
  });

  test("identity loss after graceful signal is not treated as endpoint release", async () => {
    let inspections = 0;
    const signals = [];
    const result = await stopVerifiedEndpointProcess({
      endpoint,
      expectedExecutablePath: executablePath,
      expectedLauncherPath: launcherPath,
      graceMs: 1,
      pollMs: 1,
      sleep: async () => {},
      inspect: () => {
        inspections += 1;
        return inspections <= 2
          ? identity
          : { kind: "identity_unavailable", reason: "process_query_failed", pid: 42 };
      },
      signal: (pid, options) => { signals.push({ pid, ...options }); return true; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "process_query_failed");
    assert.deepEqual(signals, [{ pid: 42, force: false }]);
  });

  test("Windows graceful command failure force-stops only the same revalidated listener", async () => {
    let inspections = 0;
    const signals = [];
    const result = await stopVerifiedEndpointProcess({
      endpoint,
      expectedExecutablePath: executablePath,
      expectedLauncherPath: launcherPath,
      platformName: "win32",
      pollMs: 1,
      sleep: async () => {},
      inspect: () => {
        inspections += 1;
        return inspections >= 4
          ? { kind: "not_listening", reason: "not_listening" }
          : identity;
      },
      signal: (pid, options) => {
        signals.push({ pid, ...options });
        return options.force;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.forced, true);
    assert.deepEqual(signals, [
      { pid: 42, force: false },
      { pid: 42, force: true },
    ]);
  });

  test("Windows graceful command failure refuses force after PID reuse or unknown identity", async () => {
    for (const replacement of [
      { ...identity, startIdentity: "start-reused" },
      { kind: "identity_unavailable", reason: "process_query_failed", pid: 42 },
      null,
    ]) {
      let inspections = 0;
      const signals = [];
      const result = await stopVerifiedEndpointProcess({
        endpoint,
        expectedExecutablePath: executablePath,
        expectedLauncherPath: launcherPath,
        platformName: "win32",
        inspect: () => {
          inspections += 1;
          return inspections <= 2 ? identity : replacement;
        },
        signal: (pid, options) => {
          signals.push({ pid, ...options });
          return false;
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.stopped, false);
      assert.deepEqual(signals, [{ pid: 42, force: false }]);
      if (replacement?.startIdentity === "start-reused") {
        assert.equal(result.reason, "force_revalidation_failed");
      }
    }
  });

  test("Windows force timeout-after-success is accepted only after authoritative release", async () => {
    let inspections = 0;
    const signals = [];
    const result = await stopVerifiedEndpointProcess({
      endpoint,
      expectedExecutablePath: executablePath,
      expectedLauncherPath: launcherPath,
      platformName: "win32",
      graceMs: 1,
      forceWaitMs: 3,
      pollMs: 1,
      sleep: async () => {},
      inspect: () => {
        inspections += 1;
        return inspections >= 5
          ? { kind: "not_listening", reason: "not_listening" }
          : identity;
      },
      signal: (pid, options) => {
        signals.push({ pid, ...options });
        return !options.force;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.forced, true);
    assert.deepEqual(signals, [
      { pid: 42, force: false },
      { pid: 42, force: true },
    ]);
  });

  test("Windows failed force waits the full window for delayed authoritative release", async () => {
    let inspections = 0;
    const sleeps = [];
    const result = await stopVerifiedEndpointProcess({
      endpoint,
      expectedExecutablePath: executablePath,
      expectedLauncherPath: launcherPath,
      platformName: "win32",
      graceMs: 1,
      forceWaitMs: 3,
      pollMs: 1,
      sleep: async (ms) => { sleeps.push(ms); },
      inspect: () => {
        inspections += 1;
        return inspections >= 7
          ? { kind: "not_listening", reason: "not_listening" }
          : identity;
      },
      signal: (_pid, options) => !options.force,
    });
    assert.equal(result.ok, true);
    assert.equal(result.forced, true);
    assert.equal(inspections, 7);
    assert.deepEqual(sleeps, [1, 1, 1, 1]);
  });

  test("Windows failed force reports failure only after same listener survives the full window", async () => {
    let inspections = 0;
    const sleeps = [];
    const result = await stopVerifiedEndpointProcess({
      endpoint,
      expectedExecutablePath: executablePath,
      expectedLauncherPath: launcherPath,
      platformName: "win32",
      graceMs: 1,
      forceWaitMs: 3,
      pollMs: 1,
      sleep: async (ms) => { sleeps.push(ms); },
      inspect: () => {
        inspections += 1;
        return identity;
      },
      signal: (_pid, options) => !options.force,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "force_signal_failed");
    assert.equal(inspections, 7);
    assert.deepEqual(sleeps, [1, 1, 1, 1]);
  });

  test("Windows successful force waits for slow endpoint release", async () => {
    let inspections = 0;
    const signals = [];
    const result = await stopVerifiedEndpointProcess({
      endpoint,
      expectedExecutablePath: executablePath,
      expectedLauncherPath: launcherPath,
      platformName: "win32",
      graceMs: 1,
      forceWaitMs: 3,
      pollMs: 1,
      sleep: async () => {},
      inspect: () => {
        inspections += 1;
        return inspections >= 7
          ? { kind: "not_listening", reason: "not_listening" }
          : identity;
      },
      signal: (pid, options) => {
        signals.push({ pid, ...options });
        return true;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.forced, true);
    assert.deepEqual(signals, [
      { pid: 42, force: false },
      { pid: 42, force: true },
    ]);
  });

  test("Windows failed force rejects a surviving or unreadable listener", async () => {
    for (const afterForce of [
      identity,
      { kind: "identity_unavailable", reason: "process_query_failed", pid: 42 },
      null,
    ]) {
      let inspections = 0;
      const signals = [];
      const result = await stopVerifiedEndpointProcess({
        endpoint,
        expectedExecutablePath: executablePath,
        expectedLauncherPath: launcherPath,
        platformName: "win32",
        graceMs: 1,
        forceWaitMs: 2,
        pollMs: 1,
        sleep: async () => {},
        inspect: () => {
          inspections += 1;
          return inspections >= 5 ? afterForce : identity;
        },
        signal: (pid, options) => {
          signals.push({ pid, ...options });
          return !options.force;
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.stopped, false);
      assert.deepEqual(signals, [
        { pid: 42, force: false },
        { pid: 42, force: true },
      ]);
      if (afterForce === identity) assert.equal(result.reason, "force_signal_failed");
      else assert.equal(result.reason, afterForce?.reason || "post_force_inspection_unavailable");
    }
  });

  test("POSIX graceful signal failure retains fail-closed behavior without force", async () => {
    const signals = [];
    const result = await stopVerifiedEndpointProcess({
      endpoint,
      expectedExecutablePath: executablePath,
      expectedLauncherPath: launcherPath,
      platformName: "linux",
      inspect: () => identity,
      signal: (pid, options) => {
        signals.push({ pid, ...options });
        return false;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "graceful_signal_failed");
    assert.deepEqual(signals, [{ pid: 42, force: false }]);
  });

  test("force occurs only after timeout and same-process revalidation", async () => {
    let inspections = 0;
    const signals = [];
    const result = await stopVerifiedEndpointProcess({
      endpoint,
      expectedExecutablePath: executablePath,
      expectedLauncherPath: launcherPath,
      graceMs: 1,
      pollMs: 1,
      sleep: async () => {},
      inspect: () => {
        inspections += 1;
        return inspections >= 5
          ? { kind: "not_listening", reason: "not_listening" }
          : identity;
      },
      signal: (pid, options) => { signals.push({ pid, ...options }); return true; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.forced, true);
    assert.deepEqual(signals, [
      { pid: 42, force: false },
      { pid: 42, force: true },
    ]);
  });

  test("PID reuse or changed start identity blocks force", async () => {
    let inspections = 0;
    const signals = [];
    const result = await stopVerifiedEndpointProcess({
      endpoint,
      expectedExecutablePath: executablePath,
      expectedLauncherPath: launcherPath,
      graceMs: 1,
      pollMs: 1,
      sleep: async () => {},
      inspect: () => {
        inspections += 1;
        return inspections <= 2 ? identity : { ...identity, startIdentity: "start-2" };
      },
      signal: (pid, options) => { signals.push({ pid, ...options }); return true; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "force_revalidation_failed");
    assert.deepEqual(signals, [{ pid: 42, force: false }]);
  });

  test("setup contains no broad process-name kill", () => {
    const setup = readFileSync(resolve(import.meta.dirname, "..", "..", "setup.mjs"), "utf8");
    assert.doesNotMatch(setup, /taskkill[^\n]*\/IM|pkill\s+-f|Get-Process\s+-Name\s+memory|tasklist[^\n]*memory\.exe/iu);
  });

  test("process control contains no broad process-name kill", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "..", "..", "scripts", "mcp-memory-process-control.mjs"),
      "utf8",
    );
    assert.doesNotMatch(source, /taskkill[^\n]*\/IM|pkill\s+-f|Get-Process\s+-Name\s+memory|tasklist[^\n]*memory\.exe/iu);
  });
});
