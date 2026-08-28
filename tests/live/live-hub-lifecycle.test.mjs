import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  ensureLiveHub,
  getLiveHubPaths,
  LIVE_HUB_RUNTIME_IDENTITY_PATHS,
  readReusableLiveHub,
  removeOwnedLiveHubState,
  stopLiveHub,
  validateLiveHubState,
  writeLiveHubState,
} from "../../src/infrastructure/live/live-hub-lifecycle.mjs";

async function withTempHome(run) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-live-hub-"));
  try {
    return await run(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

const address = {
  host: "127.0.0.1",
  port: 43127,
  url: "http://127.0.0.1:43127",
};

test("validates only exact loopback state records", () => {
  const valid = {
    schemaVersion: "meta-kim-live-hub-state-v1",
    instanceId: "11111111-1111-4111-8111-111111111111",
    pid: 42,
    processStartIdentity: "process-start-1",
    packageVersion: "3.0.6",
    packageIdentity: "a".repeat(64),
    profile: "default",
    ...address,
  };
  assert.equal(validateLiveHubState(valid)?.url, address.url);
  assert.equal(validateLiveHubState({ ...valid, host: "0.0.0.0" }), null);
  assert.equal(validateLiveHubState({ ...valid, url: "http://example.com" }), null);
  assert.equal(validateLiveHubState({ ...valid, processStartIdentity: "" }), null);
  for (const invalid of [
    null,
    [],
    { ...valid, schemaVersion: "wrong" },
    { ...valid, port: "not-a-port" },
    { ...valid, port: 0 },
    { ...valid, port: 65_536 },
    { ...valid, pid: 0 },
    { ...valid, pid: 1.5 },
    { ...valid, instanceId: "short" },
    { ...valid, packageVersion: "" },
    { ...valid, packageVersion: "x".repeat(65) },
    { ...valid, packageIdentity: "not-a-digest" },
  ]) {
    assert.equal(validateLiveHubState(invalid), null);
  }
});

test("default health probe binds HTTP health to instance and package identity", async () => withTempHome(async (homeDir) => {
  const instanceId = "77777777-7777-4777-8777-777777777777";
  const packageIdentity = "c".repeat(64);
  let mode = "valid";
  const server = createServer((_request, response) => {
    response.statusCode = mode === "bad-status" ? 503 : 200;
    response.setHeader("content-type", "application/json");
    if (mode === "malformed") response.end("{");
    else if (mode === "oversized") response.end("x".repeat(70 * 1024));
    else response.end(JSON.stringify({
      schemaVersion: "meta-kim-live-hub-health-v1",
      instanceId: mode === "wrong-instance" ? "88888888-8888-4888-8888-888888888888" : instanceId,
      packageIdentity: mode === "wrong-package" ? "d".repeat(64) : packageIdentity,
      profile: mode === "wrong-profile" ? "other-profile" : "health-profile",
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const liveAddress = { host: "127.0.0.1", port, url: `http://127.0.0.1:${port}` };
  await writeLiveHubState({
    homeDir,
    address: liveAddress,
    instanceId,
    pid: process.pid,
    processStartIdentity: "health-identity",
    packageIdentity,
    profile: "health-profile",
  });
  const common = {
    homeDir,
    isProcessAlive: () => true,
    readProcessStartIdentity: () => "health-identity",
  };
  assert.equal((await readReusableLiveHub(common))?.instanceId, instanceId);
  for (const invalidMode of ["bad-status", "wrong-instance", "wrong-package", "wrong-profile", "malformed", "oversized"]) {
    mode = invalidMode;
    assert.equal(await readReusableLiveHub(common), null);
  }
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await readReusableLiveHub(common), null);
}));

test("package identity covers every shipped Live runtime module", async () => {
  const runtimeRoots = [
    "src/domain/live",
    "src/application/live",
    "src/infrastructure/live",
    "src/presentation/live",
    "src/sdk/live",
  ];
  const shipped = [
    "scripts/meta-kim-live.mjs",
    "scripts/project-registry.mjs",
    "scripts/release-state-hardening.mjs",
  ];
  for (const runtimeRoot of runtimeRoots) {
    for (const entry of await readdir(runtimeRoot, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".mjs")) {
        shipped.push(`${runtimeRoot}/${entry.name}`);
      }
    }
  }
  assert.deepEqual([...LIVE_HUB_RUNTIME_IDENTITY_PATHS].sort(), shipped.sort());
});

test("reuses state only when PID identity and matching health instance are proven", async () => withTempHome(async (homeDir) => {
  const instanceId = "22222222-2222-4222-8222-222222222222";
  await writeLiveHubState({
    homeDir,
    address,
    instanceId,
    pid: process.pid,
    processStartIdentity: "identity-2",
  });
  const common = {
    homeDir,
    isProcessAlive: () => true,
    readProcessStartIdentity: () => "identity-2",
  };
  assert.equal((await readReusableLiveHub({ ...common, healthProbe: async () => true }))?.instanceId, instanceId);
  assert.equal(await readReusableLiveHub({ ...common, readProcessStartIdentity: () => "reused-pid", healthProbe: async () => true }), null);
  assert.equal(await readReusableLiveHub({ ...common, healthProbe: async () => false }), null);
}));

test("rejects malformed or symlink-like state input without throwing", async () => withTempHome(async (homeDir) => {
  const { root, statePath } = getLiveHubPaths({ homeDir });
  await mkdir(root, { recursive: true });
  await writeFile(statePath, "{not json", "utf8");
  assert.equal(await readReusableLiveHub({ homeDir }), null);
}));

test("concurrent ensure calls create one daemon and reuse its deep link", async () => withTempHome(async (homeDir) => {
  let spawnCount = 0;
  const identity = "identity-concurrent";
  const spawnProcess = (_command, _args, options) => {
    spawnCount += 1;
    setTimeout(() => {
      void writeLiveHubState({
        homeDir,
        address,
        instanceId: options.env.META_KIM_LIVE_INSTANCE_ID,
        pid: process.pid,
        processStartIdentity: identity,
        packageVersion: options.env.META_KIM_LIVE_PACKAGE_VERSION,
        packageIdentity: options.env.META_KIM_LIVE_PACKAGE_IDENTITY,
      });
    }, 20);
    return { unref() {} };
  };
  const options = {
    packageRoot: path.resolve("."),
    homeDir,
    timeoutMs: 1_500,
    projectRef: "project-a1b2c3d4e5f6",
    runId: "meta-session-1",
    spawnProcess,
    healthProbe: async () => true,
    isProcessAlive: () => true,
    readProcessStartIdentity: () => identity,
  };
  const [first, second] = await Promise.all([ensureLiveHub(options), ensureLiveHub(options)]);
  assert.equal(spawnCount, 1);
  assert.deepEqual(new Set([first.status, second.status]), new Set(["started", "reused"]));
  assert.match(first.deepLink, /projectId=project-a1b2c3d4e5f6/u);
  assert.match(first.deepLink, /runId=meta-session-1/u);
}));

test("owned state cleanup cannot remove another hub instance", async () => withTempHome(async (homeDir) => {
  const instanceId = "33333333-3333-4333-8333-333333333333";
  await writeLiveHubState({
    homeDir,
    address,
    instanceId,
    pid: process.pid,
    processStartIdentity: "identity-3",
  });
  assert.equal(await removeOwnedLiveHubState({ homeDir, instanceId: "44444444-4444-4444-8444-444444444444" }), false);
  assert.equal(await removeOwnedLiveHubState({ homeDir, instanceId }), true);
}));

test("first ensure after an update replaces the verified old-version singleton", async () => withTempHome(async (homeDir) => {
  const identity = "identity-versioned";
  let alive = true;
  let signalCount = 0;
  let spawnCount = 0;
  await writeLiveHubState({
    homeDir,
    address,
    instanceId: "55555555-5555-4555-8555-555555555555",
    pid: process.pid,
    processStartIdentity: identity,
    packageVersion: "0.0.1",
  });
  const result = await ensureLiveHub({
    packageRoot: path.resolve("."),
    homeDir,
    timeoutMs: 1_500,
    healthProbe: async () => true,
    isProcessAlive: () => alive,
    readProcessStartIdentity: () => identity,
    signalProcess: () => {
      signalCount += 1;
      alive = false;
    },
    spawnProcess: (_command, _args, options) => {
      spawnCount += 1;
      alive = true;
      setTimeout(() => {
        void writeLiveHubState({
          homeDir,
          address,
          instanceId: options.env.META_KIM_LIVE_INSTANCE_ID,
          pid: process.pid,
          processStartIdentity: identity,
          packageVersion: options.env.META_KIM_LIVE_PACKAGE_VERSION,
          packageIdentity: options.env.META_KIM_LIVE_PACKAGE_IDENTITY,
        });
      }, 20);
      return { unref() {} };
    },
  });
  assert.equal(signalCount, 1);
  assert.equal(spawnCount, 1);
  assert.equal(result.status, "started");
  assert.notEqual(result.packageVersion, "0.0.1");
}));

test("an alive old-authority Hub with unavailable PID identity fails closed without spawning", async () => withTempHome(async (homeDir) => {
  await writeLiveHubState({
    homeDir,
    address,
    instanceId: "66666666-6666-4666-8666-666666666666",
    pid: process.pid,
    processStartIdentity: "identity-unavailable",
    packageVersion: "0.0.1",
    packageIdentity: "b".repeat(64),
  });
  let spawnCount = 0;
  const result = await ensureLiveHub({
    packageRoot: path.resolve("."),
    homeDir,
    healthProbe: async () => true,
    isProcessAlive: () => true,
    readProcessStartIdentity: () => null,
    spawnProcess: () => {
      spawnCount += 1;
      return { unref() {} };
    },
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "live_hub_identity_unavailable");
  assert.equal(spawnCount, 0);
}));

test("startup timeout terminates the exact child instead of leaving an orphan daemon", async () => withTempHome(async (homeDir) => {
  let exitHandler = null;
  let killCount = 0;
  const child = {
    pid: 4242,
    exitCode: null,
    once(event, handler) {
      if (event === "exit") exitHandler = handler;
    },
    unref() {},
    kill() {
      killCount += 1;
      this.exitCode = 0;
      queueMicrotask(() => exitHandler?.(0));
      return true;
    },
  };
  const result = await ensureLiveHub({
    packageRoot: path.resolve("."),
    homeDir,
    timeoutMs: 40,
    healthProbe: async () => false,
    isProcessAlive: () => false,
    readProcessStartIdentity: () => "identity-timeout",
    spawnProcess: () => child,
  });
  assert.equal(result.reason, "startup_timeout");
  assert.equal(killCount, 1);
}));

test("start lock reports live owners, waits on fresh residue, and recovers stale residue", async () => {
  const packageRoot = path.resolve(".");
  const writeLockOwner = async (homeDir, owner) => {
    const paths = getLiveHubPaths({ homeDir });
    await mkdir(paths.startLockPath, { recursive: true });
    await writeFile(paths.startLockOwnerPath, JSON.stringify(owner), "utf8");
    return paths;
  };

  await withTempHome(async (homeDir) => {
    await writeLockOwner(homeDir, {
      token: "live-owner",
      pid: 4242,
      processStartIdentity: "owner-identity",
      acquiredAt: new Date().toISOString(),
    });
    let spawnCount = 0;
    const result = await ensureLiveHub({
      packageRoot,
      homeDir,
      timeoutMs: 10,
      healthProbe: async () => false,
      isProcessAlive: (pid) => pid === 4242,
      readProcessStartIdentity: () => "owner-identity",
      spawnProcess: () => { spawnCount += 1; return { unref() {} }; },
    });
    assert.equal(result.reason, "start_in_progress");
    assert.equal(spawnCount, 0);
  });

  await withTempHome(async (homeDir) => {
    await writeLockOwner(homeDir, {
      token: "dead-fresh-owner",
      pid: 4243,
      processStartIdentity: "dead-owner",
      acquiredAt: new Date().toISOString(),
    });
    const result = await ensureLiveHub({
      packageRoot,
      homeDir,
      timeoutMs: 10,
      healthProbe: async () => false,
      isProcessAlive: () => false,
      readProcessStartIdentity: () => "caller-identity",
      spawnProcess: () => { throw new Error("must not spawn"); },
    });
    assert.equal(result.reason, "lock_initializing");
  });

  await withTempHome(async (homeDir) => {
    const paths = await writeLockOwner(homeDir, {
      token: "dead-stale-owner",
      pid: 4244,
      processStartIdentity: "dead-owner",
      acquiredAt: "2020-01-01T00:00:00.000Z",
    });
    const old = new Date(Date.now() - 60_000);
    await utimes(paths.startLockPath, old, old);
    let spawnCount = 0;
    const result = await ensureLiveHub({
      packageRoot,
      homeDir,
      timeoutMs: 500,
      healthProbe: async () => true,
      isProcessAlive: () => true,
      readProcessStartIdentity: () => "recovered-identity",
      spawnProcess: (_command, _args, options) => {
        spawnCount += 1;
        setTimeout(() => {
          void writeLiveHubState({
            homeDir,
            address,
            instanceId: options.env.META_KIM_LIVE_INSTANCE_ID,
            pid: process.pid,
            processStartIdentity: "recovered-identity",
            packageVersion: options.env.META_KIM_LIVE_PACKAGE_VERSION,
            packageIdentity: options.env.META_KIM_LIVE_PACKAGE_IDENTITY,
          });
        }, 5);
        return { unref() {} };
      },
    });
    assert.equal(result.status, "started");
    assert.equal(spawnCount, 1);
  });
});

test("stop lifecycle distinguishes absent, signal failure, and timeout", async () => withTempHome(async (homeDir) => {
  assert.deepEqual(await stopLiveHub({
    homeDir,
    isProcessAlive: () => false,
  }), { status: "not_running", stopped: false });

  const instanceId = "99999999-9999-4999-8999-999999999999";
  await writeLiveHubState({
    homeDir,
    address,
    instanceId,
    pid: process.pid,
    processStartIdentity: "stop-identity",
  });
  const common = {
    homeDir,
    instanceId,
    timeoutMs: 20,
    healthProbe: async () => true,
    isProcessAlive: () => true,
    readProcessStartIdentity: () => "stop-identity",
  };
  assert.deepEqual(await stopLiveHub({
    ...common,
    signalProcess: () => { throw new Error("signal denied"); },
  }), { status: "signal_failed", stopped: false });
  assert.deepEqual(await stopLiveHub({
    ...common,
    signalProcess: () => {},
  }), { status: "stop_timeout", stopped: false });
}));

test("a proven matching state uses the fast reuse path without PID inspection", async () => withTempHome(async (homeDir) => {
  let captured = null;
  const first = await ensureLiveHub({
    packageRoot: path.resolve("."),
    homeDir,
    timeoutMs: 500,
    healthProbe: async () => true,
    isProcessAlive: () => true,
    readProcessStartIdentity: () => "fast-identity",
    spawnProcess: (_command, _args, options) => {
      captured = options.env;
      setTimeout(() => {
        void writeLiveHubState({
          homeDir,
          address,
          instanceId: options.env.META_KIM_LIVE_INSTANCE_ID,
          pid: process.pid,
          processStartIdentity: "fast-identity",
          packageVersion: options.env.META_KIM_LIVE_PACKAGE_VERSION,
          packageIdentity: options.env.META_KIM_LIVE_PACKAGE_IDENTITY,
        });
      }, 5);
      return { unref() {} };
    },
  });
  assert.equal(first.status, "started");
  assert.ok(captured.META_KIM_LIVE_PACKAGE_IDENTITY);

  const reused = await ensureLiveHub({
    packageRoot: path.resolve("."),
    homeDir,
    projectRef: "project-a1b2c3d4e5f6",
    runId: "meta-fast-reuse",
    healthProbe: async () => true,
    isProcessAlive: () => { throw new Error("fast path must not inspect PID"); },
    readProcessStartIdentity: () => { throw new Error("fast path must not inspect identity"); },
  });
  assert.equal(reused.status, "reused");
  assert.match(reused.deepLink, /projectId=project-a1b2c3d4e5f6/u);
  assert.match(reused.deepLink, /runId=meta-fast-reuse/u);
}));

test("invalid package roots and incomplete package authority fail before spawning", async () => withTempHome(async (homeDir) => {
  assert.equal((await ensureLiveHub({ packageRoot: "relative", homeDir })).reason, "package_root_required");
  assert.equal((await ensureLiveHub({ packageRoot: path.join(homeDir, "missing"), homeDir })).reason, "launcher_unavailable");

  const incompleteRoot = path.join(homeDir, "incomplete-package");
  await mkdir(path.join(incompleteRoot, "scripts"), { recursive: true });
  await writeFile(path.join(incompleteRoot, "scripts", "meta-kim-live.mjs"), "// launcher\n", "utf8");
  assert.equal((await ensureLiveHub({ packageRoot: incompleteRoot, homeDir })).reason, "package_identity_unavailable");
}));
