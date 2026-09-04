import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  ensureLiveHub,
  getLiveHubPaths,
  LIVE_HUB_DEFAULT_PORT,
  LIVE_HUB_RUNTIME_IDENTITY_PATHS,
  readReusableLiveHub,
  removeOwnedLiveHubState,
  stopLiveHub,
  validateLiveHubState,
  writeLiveHubState,
} from "../../src/infrastructure/live/live-hub-lifecycle.mjs";

test("uses one stable default browser entry port", () => {
  assert.equal(LIVE_HUB_DEFAULT_PORT, 4331);
});

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

// Startup budget for the cases whose assertion is the resulting status, not the
// timing. Their spawn stubs report ready within milliseconds, so any expiry here
// is scheduler contention rather than the behavior under test: the same wait was
// measured at 15.6s inside the parallel suite against 0.7s when run alone. Cases
// that assert an expiry keep their own small explicit budgets.
const STARTUP_BUDGET_THAT_MUST_NOT_EXPIRE_MS = 30_000;

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

/**
 * Directory membership is a lower bound on the identity set, not its definition.
 * The upper bound belongs to tests/live/live-package-closure.test.mjs, which
 * derives what the daemon executes and what shipped code loads; the daemon
 * legitimately reaches data-layer and shared-domain modules that no "live"
 * directory contains, so asserting equality here would make the correct list
 * illegal. What only this test can catch is a new module dropped into one of
 * these directories and never hashed.
 */
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
  assert.ok(shipped.length >= 20, `negative control: the derived lower bound collapsed to ${shipped.length} entries`);
  const hashed = new Set(LIVE_HUB_RUNTIME_IDENTITY_PATHS);
  const unhashed = shipped.filter((entry) => !hashed.has(entry)).sort();
  assert.deepEqual(
    unhashed,
    [],
    `shipped Live runtime module missing from the package identity:\n${unhashed.join("\n")}`,
  );
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
  assert.equal(await readReusableLiveHub({ ...common, healthProbe: async () => false }), null);
  // Reuse only ever talks to the hub over loopback, and the health probe already
  // binds that endpoint to this instanceId, so reuse does not pay for the PID
  // creation-time query. Callers that ask for PID-level proof still get it.
  assert.equal(
    (await readReusableLiveHub({
      ...common,
      readProcessStartIdentity: () => "reused-pid",
      healthProbe: async () => true,
    }))?.instanceId,
    instanceId,
  );
  assert.equal(
    await readReusableLiveHub({
      ...common,
      requireProcessIdentity: true,
      readProcessStartIdentity: () => "reused-pid",
      healthProbe: async () => true,
    }),
    null,
  );
}));

test("stop refuses to signal a PID whose creation identity no longer matches", async () => withTempHome(async (homeDir) => {
  const instanceId = "22222222-2222-4222-8222-222222222223";
  await writeLiveHubState({
    homeDir,
    address,
    instanceId,
    pid: process.pid,
    processStartIdentity: "identity-3",
  });
  const common = {
    homeDir,
    instanceId,
    isProcessAlive: () => true,
    healthProbe: async () => true,
  };
  const signalled = [];
  // A recycled PID that answers the health endpoint must never be signalled:
  // stopping is the one path that acts on the PID itself.
  const recycled = await stopLiveHub({
    ...common,
    readProcessStartIdentity: () => "reused-pid",
    signalProcess: (pid) => signalled.push(pid),
  });
  assert.equal(recycled.stopped, false);
  assert.equal(recycled.status, "not_running");
  assert.deepEqual(signalled, []);

  // An unobtainable identity is equally not proof, so it must not authorise a kill.
  const unavailable = await stopLiveHub({
    ...common,
    readProcessStartIdentity: () => null,
    signalProcess: (pid) => signalled.push(pid),
  });
  assert.equal(unavailable.stopped, false);
  assert.deepEqual(signalled, []);

  // A matching identity does authorise the signal.
  await stopLiveHub({
    ...common,
    timeoutMs: 50,
    readProcessStartIdentity: () => "identity-3",
    signalProcess: (pid) => signalled.push(pid),
  });
  assert.deepEqual(signalled, [process.pid]);
}));

test("a stop with no named instance refuses instead of signalling whatever is recorded", async () => withTempHome(async (homeDir) => {
  // `instanceId` defaulted to null and the ownership check was written as
  // `instanceId && state.instanceId !== instanceId`, so omitting the argument
  // short-circuited the comparison entirely: naming the owner was the opt-in
  // branch and forgetting it stopped whichever Hub happened to be recorded.
  // The package exports `./*`, so every importer of this primitive inherited
  // that default, and the CLI restart path was already calling it that way.
  const instanceId = "33333333-3333-4333-8333-333333333334";
  await writeLiveHubState({
    homeDir,
    address,
    instanceId,
    pid: process.pid,
    processStartIdentity: "omit-identity",
  });
  const common = {
    homeDir,
    timeoutMs: 20,
    healthProbe: async () => true,
    isProcessAlive: () => true,
    readProcessStartIdentity: () => "omit-identity",
  };
  const signalled = [];
  const signalProcess = (pid) => signalled.push(pid);

  const omitted = await stopLiveHub({ ...common, signalProcess });
  assert.equal(omitted.stopped, false);
  assert.equal(
    omitted.status,
    "instance_authority_required",
    "an unnamed stop must refuse rather than choose its own target",
  );
  assert.deepEqual(signalled, [], "no PID may be signalled without a named or explicitly waived owner");

  // Omitting the owner and naming the wrong owner must not answer alike, or the
  // refusal above would be indistinguishable from an ordinary miss.
  const wrong = await stopLiveHub({
    ...common,
    instanceId: "44444444-4444-4444-8444-444444444445",
    signalProcess,
  });
  assert.equal(wrong.status, "not_running");
  assert.deepEqual(signalled, []);

  // A caller that really means "replace whichever singleton is recorded" — what
  // a person typing --restart is asking for — says so and is served.
  const waived = await stopLiveHub({ ...common, allowAnyInstance: true, signalProcess });
  assert.equal(waived.status, "stop_timeout", "the waiver authorises the signal; this stub never exits");
  assert.deepEqual(signalled, [process.pid]);

  // A matching named owner is served with no waiver at all.
  const named = await stopLiveHub({ ...common, instanceId, signalProcess });
  assert.equal(named.status, "stop_timeout");
  assert.deepEqual(signalled, [process.pid, process.pid]);
}));

test("a state write cannot hide another live Hub behind its own record", async () => withTempHome(async (homeDir) => {
  // The only writer validated shape — a loopback address and a well-formed
  // instance id — and then overwrote the record unconditionally. Writing while
  // a different process was still serving the port left that process alive,
  // still holding the port, and no longer named anywhere: every later stop
  // signalled the newly recorded PID, so the real listener could not be stopped
  // at all. The distinguishing measurement is two different live PIDs, whereas a
  // crash leaves a record whose PID is dead.
  const incumbent = {
    instanceId: "55555555-5555-4555-8555-555555555556",
    pid: 424_242,
    processStartIdentity: "incumbent-identity",
  };
  const seams = {
    isProcessAlive: (pid) => pid === incumbent.pid,
    readProcessStartIdentity: (pid) => (pid === incumbent.pid ? incumbent.processStartIdentity : null),
  };
  await writeLiveHubState({ homeDir, address, ...incumbent, ...seams });

  await assert.rejects(
    () => writeLiveHubState({
      homeDir,
      address,
      instanceId: "66666666-6666-4666-8666-666666666667",
      pid: process.pid,
      processStartIdentity: "intruder-identity",
      ...seams,
    }),
    /already serving/u,
    "a write must not orphan a Hub that is still alive under another instance id",
  );
  assert.equal(
    JSON.parse(await readFile(getLiveHubPaths({ homeDir }).statePath, "utf8")).instanceId,
    incumbent.instanceId,
    "the incumbent record must survive the refused write",
  );

  // The incumbent rewriting its own record is the normal daemon path and stays
  // allowed, so the guard cannot be satisfied by simply never writing twice.
  assert.equal(
    (await writeLiveHubState({ homeDir, address, ...incumbent, ...seams })).instanceId,
    incumbent.instanceId,
  );

  // A record whose process is gone is residue, not an owner: recovery must not
  // be blocked, or a crashed Hub would wedge the port name forever. Liveness has
  // to carry this on its own, because the identity probe below is allowed to
  // answer "unknown" and unknown must not read as "gone".
  const recovered = await writeLiveHubState({
    homeDir,
    address,
    instanceId: "77777777-7777-4777-8777-777777777778",
    pid: process.pid,
    processStartIdentity: "recovery-identity",
    isProcessAlive: () => false,
    readProcessStartIdentity: () => null,
  });
  assert.equal(recovered.instanceId, "77777777-7777-4777-8777-777777777778");

  // A live PID whose creation identity no longer matches the record is a reused
  // PID, not the recorded Hub, so it must not block recovery either.
  await writeLiveHubState({ homeDir, address, ...incumbent, ...seams });
  const reusedPid = await writeLiveHubState({
    homeDir,
    address,
    instanceId: "88888888-8888-4888-8888-888888888889",
    pid: process.pid,
    processStartIdentity: "reused-identity",
    isProcessAlive: () => true,
    readProcessStartIdentity: () => "some-other-process",
  });
  assert.equal(reusedPid.instanceId, "88888888-8888-4888-8888-888888888889");

  // The identity probe shells out to PowerShell on Windows and reads /proc on
  // Linux, so it returns null whenever that query fails, times out, or the
  // platform has no implementation. Reading null as "a different process" would
  // switch this guard off exactly when the machine is under load, and the record
  // it silently orphaned is the only way to reach the running Hub. The rest of
  // this module already resolves the same ambiguity the same way:
  // readReusableLiveHub reports `identity_unavailable` instead of `absent`, and
  // lockOwnerAppearsLive keeps the owner.
  await writeLiveHubState({ homeDir, address, ...incumbent, ...seams });
  await assert.rejects(
    () => writeLiveHubState({
      homeDir,
      address,
      instanceId: "99999999-9999-4999-8999-99999999999a",
      pid: process.pid,
      processStartIdentity: "probe-failed-identity",
      isProcessAlive: (pid) => pid === incumbent.pid,
      readProcessStartIdentity: () => null,
    }),
    /already serving/u,
    "an unreadable creation identity must not be read as proof the incumbent is gone",
  );

  // A process re-registering itself under a new instance id owns the port it is
  // about to record, so there is no other Hub to orphan. Without this the daemon
  // could not rewrite its own record after re-listening.
  const selfIdentity = "self-registering-identity";
  await writeLiveHubState({
    homeDir,
    address,
    instanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
    pid: process.pid,
    processStartIdentity: selfIdentity,
    isProcessAlive: () => true,
    readProcessStartIdentity: () => selfIdentity,
  });
  const reregistered = await writeLiveHubState({
    homeDir,
    address,
    instanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc",
    pid: process.pid,
    processStartIdentity: selfIdentity,
    isProcessAlive: () => true,
    readProcessStartIdentity: () => selfIdentity,
  });
  assert.equal(reregistered.instanceId, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc");
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
    portOccupiedProbe: async () => false,
    spawnProcess: () => child,
  });
  assert.equal(result.reason, "startup_timeout");
  assert.equal(killCount, 1);
}));

// The harness timeout must outlast the startup budget configured below, otherwise a
// loaded machine trips the harness clock before the assertion can judge the result.
test("Windows-sized startup fuse accepts a daemon that becomes healthy just after two seconds", { timeout: 20_000 }, async () => withTempHome(async (homeDir) => {
  const identity = "slow-windows-start";
  const child = {
    pid: 4245,
    exitCode: null,
    once() {},
    off() {},
    unref() {},
  };
  const startedAt = Date.now();
  const result = await ensureLiveHub({
    packageRoot: path.resolve("."),
    homeDir,
    timeoutMs: 8_000,
    healthProbe: async () => {
      await new Promise((resolve) => setTimeout(resolve, 175));
      return true;
    },
    isProcessAlive: () => true,
    readProcessStartIdentity: () => identity,
    spawnProcess: (_command, _args, options) => {
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
      }, 1_900);
      return child;
    },
  });
  assert.equal(result.status, "started");
  assert.ok(Date.now() - startedAt >= 2_000, "startup proof must cross the former two-second fuse");
}));

test("a real child exit fails quickly and distinguishes an occupied fixed port", async () => withTempHome(async (homeDir) => {
  const makeExitedChild = () => {
    const handlers = new Map();
    const child = {
      pid: 4246,
      exitCode: null,
      once(event, handler) { handlers.set(event, handler); },
      off(event, handler) { if (handlers.get(event) === handler) handlers.delete(event); },
      unref() {},
      kill() { this.exitCode = 1; return true; },
    };
    setTimeout(() => {
      child.exitCode = 1;
      handlers.get("exit")?.(1, null);
    }, 10);
    return child;
  };
  const base = {
    packageRoot: path.resolve("."),
    homeDir,
    timeoutMs: 5_000,
    healthProbe: async () => false,
    isProcessAlive: () => false,
    readProcessStartIdentity: () => "exited-child",
    spawnProcess: makeExitedChild,
  };
  const startedAt = Date.now();
  const exited = await ensureLiveHub({ ...base, port: 43128, portOccupiedProbe: async () => false });
  assert.equal(exited.reason, "daemon_exited_before_ready");
  // The invariant is that a dead child is noticed by its exit event rather than by the
  // startup budget expiring, so the bound stays well inside timeoutMs above instead of
  // pinning an absolute wall clock that a loaded machine cannot meet.
  assert.ok(Date.now() - startedAt < 2_500, "child exit must not wait for the full startup timeout");

  const occupied = await ensureLiveHub({ ...base, port: 43129, portOccupiedProbe: async () => true });
  assert.equal(occupied.reason, "port_in_use");
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
      timeoutMs: STARTUP_BUDGET_THAT_MUST_NOT_EXPIRE_MS,
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
    // No Hub is recorded at all, so no owner is nameable; this asserts absence,
    // not ownership, and must not be answered by the authority gate.
    allowAnyInstance: true,
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
    timeoutMs: STARTUP_BUDGET_THAT_MUST_NOT_EXPIRE_MS,
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

test("a differing profile alone never terminates the running singleton", async () => withTempHome(async (homeDir) => {
  // A profile is a data scope, not a stale build. Treating it like a version
  // mismatch let any run that happened to carry META_KIM_PROFILE kill the Hub
  // someone was watching and replace it with one serving an empty scope — the
  // observed case was a throwaway probe profile taking over port 4331.
  let spawnCount = 0;
  let signalCount = 0;
  let hubProcessAlive = true;
  const base = {
    packageRoot: path.resolve("."),
    homeDir,
    timeoutMs: STARTUP_BUDGET_THAT_MUST_NOT_EXPIRE_MS,
    healthProbe: async () => true,
    isProcessAlive: () => hubProcessAlive,
    readProcessStartIdentity: () => "profile-identity",
  };
  const spawnProcess = (_command, _args, options) => {
    spawnCount += 1;
    hubProcessAlive = true;
    setTimeout(() => {
      void writeLiveHubState({
        homeDir,
        address,
        instanceId: options.env.META_KIM_LIVE_INSTANCE_ID,
        pid: process.pid,
        processStartIdentity: "profile-identity",
        packageVersion: options.env.META_KIM_LIVE_PACKAGE_VERSION,
        packageIdentity: options.env.META_KIM_LIVE_PACKAGE_IDENTITY,
        profile: options.env.META_KIM_PROFILE,
      });
    }, 5);
    return { unref() {} };
  };
  const signalProcess = () => {
    signalCount += 1;
    hubProcessAlive = false;
  };

  const started = await ensureLiveHub({ ...base, profile: "default", spawnProcess, signalProcess });
  assert.equal(started.status, "started");
  assert.equal(spawnCount, 1);

  const refused = await ensureLiveHub({ ...base, profile: "probe-profile", spawnProcess, signalProcess });
  assert.equal(refused.status, "unavailable");
  assert.equal(refused.reason, "profile_in_use");
  assert.equal(signalCount, 0, "the running Hub must survive a profile-only mismatch");
  assert.equal(spawnCount, 1, "no replacement Hub may be spawned for a profile-only mismatch");

  // Refusing before the start lock is what makes the answer immediate. Behind a
  // live foreign lock the takeover path can only wait out the startup budget and
  // then blame the lock, which reads as "someone is starting a Hub" for a
  // situation that is already decided.
  const lockPaths = getLiveHubPaths({ homeDir });
  await mkdir(lockPaths.startLockPath, { recursive: true });
  await writeFile(lockPaths.startLockOwnerPath, JSON.stringify({
    token: "another-starter",
    pid: process.pid,
    processStartIdentity: "profile-identity",
    acquiredAt: new Date().toISOString(),
  }), "utf8");
  const refusedBehindLock = await ensureLiveHub({ ...base, profile: "probe-profile", spawnProcess, signalProcess });
  assert.equal(refusedBehindLock.reason, "profile_in_use", "a decided refusal must not queue behind a starter");
  assert.equal(spawnCount, 1);
  await rm(lockPaths.startLockPath, { recursive: true, force: true });

  // The same mismatch is a legitimate takeover when a caller asks for it by
  // name, which is what the CLI does when a person passes --profile.
  const takeover = await ensureLiveHub({
    ...base,
    profile: "probe-profile",
    allowProfileTakeover: true,
    spawnProcess,
    signalProcess,
  });
  assert.equal(takeover.status, "started");
  assert.equal(takeover.profile, "probe-profile");
  assert.equal(signalCount, 1);
  assert.equal(spawnCount, 2);

  // The decision is re-made under the lock because the Hub can change between
  // the two inspections. Here the first inspection sees a stale build — a
  // legitimate takeover — and by the time the lock is held the stale process is
  // gone and a current Hub on another profile owns the port.
  await writeLiveHubState({
    homeDir,
    address,
    instanceId: "77777777-7777-4777-8777-777777777777",
    pid: process.pid,
    processStartIdentity: "profile-identity",
    packageVersion: "0.0.1",
    packageIdentity: takeover.packageIdentity,
    profile: "default",
  });
  let probes = 0;
  const raced = await ensureLiveHub({
    ...base,
    profile: "probe-profile",
    spawnProcess,
    signalProcess,
    healthProbe: async () => {
      probes += 1;
      if (probes === 1) {
        await writeLiveHubState({
          homeDir,
          address,
          instanceId: "88888888-8888-4888-8888-888888888888",
          pid: process.pid,
          processStartIdentity: "profile-identity",
          packageVersion: takeover.packageVersion,
          packageIdentity: takeover.packageIdentity,
          profile: "default",
        });
      }
      return true;
    },
  });
  assert.equal(raced.reason, "profile_in_use", "the decision must be re-made against the Hub the lock protects");
  assert.equal(signalCount, 1, "no Hub may be signalled once the profile turns out to be the only difference");
  assert.equal(spawnCount, 2);
}));

test("an autostart keeps a same-version Hub that another package root started", async () => withTempHome(async (homeDir) => {
  // The identity digest covers the package root path as well as the file bytes,
  // so a Hub started from a source tree and a Hub started from an installed
  // release never match, in either direction. Reading that difference as "the
  // running build is old" made the hook — which is pinned to the installed root
  // by --package-root — terminate the source-tree Hub its user was watching on
  // the next prompt. Only a strictly older declared version is provably stale.
  let spawnCount = 0;
  let signalCount = 0;
  let hubProcessAlive = true;
  const base = {
    packageRoot: path.resolve("."),
    homeDir,
    timeoutMs: STARTUP_BUDGET_THAT_MUST_NOT_EXPIRE_MS,
    healthProbe: async () => true,
    isProcessAlive: () => hubProcessAlive,
    readProcessStartIdentity: () => "build-identity",
  };
  const spawnProcess = (_command, _args, options) => {
    spawnCount += 1;
    hubProcessAlive = true;
    setTimeout(() => {
      void writeLiveHubState({
        homeDir,
        address,
        instanceId: options.env.META_KIM_LIVE_INSTANCE_ID,
        pid: process.pid,
        processStartIdentity: "build-identity",
        packageVersion: options.env.META_KIM_LIVE_PACKAGE_VERSION,
        packageIdentity: options.env.META_KIM_LIVE_PACKAGE_IDENTITY,
      });
    }, 5);
    return { unref() {} };
  };
  const signalProcess = () => {
    signalCount += 1;
    hubProcessAlive = false;
  };

  const started = await ensureLiveHub({ ...base, spawnProcess, signalProcess });
  assert.equal(started.status, "started");

  const matched = await ensureLiveHub({ ...base, spawnProcess, signalProcess });
  assert.equal(matched.status, "reused");
  assert.equal(matched.buildMatch, "expected", "a reuse the caller's own build answered must say so");

  // An exact match normally leaves through the fast path, so the trailing return
  // site answers a match only when the first probe misses — a Hub still becoming
  // healthy. Left unproven, that site could name the caller's own build for
  // whatever the slow path happened to find.
  let slowProbeCount = 0;
  const slowMatched = await ensureLiveHub({
    ...base,
    healthProbe: async () => {
      slowProbeCount += 1;
      return slowProbeCount > 1;
    },
    spawnProcess,
    signalProcess,
  });
  assert.equal(slowMatched.status, "reused");
  assert.equal(slowMatched.buildMatch, "expected", "a match proven past the fast path must not read as foreign");
  assert.equal(spawnCount, 1, "a Hub that answers on the second probe must not be replaced");

  const foreignRootState = {
    homeDir,
    address,
    instanceId: "99999999-9999-4999-8999-999999999999",
    pid: process.pid,
    processStartIdentity: "build-identity",
    packageVersion: started.packageVersion,
    packageIdentity: "f".repeat(64),
  };
  await writeLiveHubState(foreignRootState);

  const kept = await ensureLiveHub({ ...base, spawnProcess, signalProcess });
  assert.equal(kept.status, "reused", "a healthy same-version Hub must be reused, not replaced");
  assert.equal(kept.instanceId, foreignRootState.instanceId);
  // Keeping a Hub whose build could not be matched and reusing the caller's own
  // build returned byte-identical envelopes, so no surface could report that the
  // port was answering from code the caller never built.
  assert.equal(kept.buildMatch, "foreign", "a kept foreign build must not read as an exact match");
  assert.equal(signalCount, 0, "an autostart must not signal a Hub it cannot prove is stale");
  assert.equal(spawnCount, 1, "no replacement Hub may be spawned for an unordered build difference");

  // A Hub declaring a newer version is the same unordered case seen from the
  // other side: replacing it would silently downgrade what the user is watching.
  await writeLiveHubState({ ...foreignRootState, packageVersion: "999.0.0" });
  const newerKept = await ensureLiveHub({ ...base, spawnProcess, signalProcess });
  assert.equal(newerKept.status, "reused", "a newer Hub must not be downgraded by an older autostart");
  assert.equal(newerKept.buildMatch, "foreign");
  assert.equal(signalCount, 0);
  assert.equal(spawnCount, 1);

  // A wrong data scope is not fixed by keeping the process alive: reusing this
  // Hub would answer the run with another profile's records. The scope question
  // is therefore decided before the unordered build difference, which is the one
  // case where keeping and refusing are not the same answer.
  await writeLiveHubState({ ...foreignRootState, profile: "probe-profile" });
  const wrongScope = await ensureLiveHub({ ...base, spawnProcess, signalProcess });
  assert.equal(wrongScope.status, "unavailable");
  assert.equal(wrongScope.reason, "profile_in_use", "a foreign build on another profile must refuse, not be reused");
  assert.equal(signalCount, 0);
  assert.equal(spawnCount, 1);
  await writeLiveHubState(foreignRootState);

  // The same difference is a legitimate replacement when a caller asks for it by
  // name, which is what the CLI does when a person restarts the Hub.
  const replaced = await ensureLiveHub({
    ...base,
    allowBuildTakeover: true,
    spawnProcess,
    signalProcess,
  });
  assert.equal(replaced.status, "started");
  assert.equal(signalCount, 1);
  assert.equal(spawnCount, 2);
}));

test("a foreign build found under the start lock is reported as kept, not as a match", async () => withTempHome(async (homeDir) => {
  // The re-decision under the lock has its own return site, and it answered
  // "reused" for a kept foreign build and for an exact match alike. A caller that
  // reads only the status cannot tell which build is now serving it.
  let spawnCount = 0;
  let signalCount = 0;
  let hubProcessAlive = true;
  const base = {
    packageRoot: path.resolve("."),
    homeDir,
    timeoutMs: STARTUP_BUDGET_THAT_MUST_NOT_EXPIRE_MS,
    healthProbe: async () => true,
    isProcessAlive: () => hubProcessAlive,
    readProcessStartIdentity: () => "relock-identity",
  };
  const spawnProcess = (_command, _args, options) => {
    spawnCount += 1;
    hubProcessAlive = true;
    setTimeout(() => {
      void writeLiveHubState({
        homeDir,
        address,
        instanceId: options.env.META_KIM_LIVE_INSTANCE_ID,
        pid: process.pid,
        processStartIdentity: "relock-identity",
        packageVersion: options.env.META_KIM_LIVE_PACKAGE_VERSION,
        packageIdentity: options.env.META_KIM_LIVE_PACKAGE_IDENTITY,
      });
    }, 5);
    return { unref() {} };
  };
  const signalProcess = () => {
    signalCount += 1;
    hubProcessAlive = false;
  };

  const started = await ensureLiveHub({ ...base, spawnProcess, signalProcess });
  assert.equal(started.status, "started");

  // A strictly older declared version is the only provable staleness, so this
  // state is what makes the first inspection plan a replacement and take the
  // lock. What the lock then protects is a different Hub.
  const staleState = {
    homeDir,
    address,
    instanceId: "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    pid: process.pid,
    processStartIdentity: "relock-identity",
    packageVersion: "0.0.1",
    packageIdentity: started.packageIdentity,
  };
  const relockAgainst = async (replacement) => {
    await writeLiveHubState(staleState);
    let probes = 0;
    return ensureLiveHub({
      ...base,
      spawnProcess,
      signalProcess,
      healthProbe: async () => {
        probes += 1;
        if (probes === 1) await writeLiveHubState(replacement);
        return true;
      },
    });
  };

  const keptUnderLock = await relockAgainst({
    ...staleState,
    instanceId: "bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    packageVersion: started.packageVersion,
    packageIdentity: "e".repeat(64),
  });
  assert.equal(keptUnderLock.status, "reused");
  assert.equal(
    keptUnderLock.instanceId,
    "bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "the decision must be re-made against the Hub the lock protects",
  );
  assert.equal(keptUnderLock.buildMatch, "foreign", "a build the lock could not match must not read as a match");
  assert.equal(signalCount, 0);
  assert.equal(spawnCount, 1);

  const matchedUnderLock = await relockAgainst({
    ...staleState,
    instanceId: "ccccccc1-cccc-4ccc-8ccc-cccccccccccc",
    packageVersion: started.packageVersion,
    packageIdentity: started.packageIdentity,
  });
  assert.equal(matchedUnderLock.status, "reused");
  assert.equal(
    matchedUnderLock.buildMatch,
    "expected",
    "the same return site must report a match when the build under the lock does match",
  );
  assert.equal(signalCount, 0);
  assert.equal(spawnCount, 1);
}));

test("invalid package roots and incomplete package authority fail before spawning", async () => withTempHome(async (homeDir) => {
  assert.equal((await ensureLiveHub({ packageRoot: "relative", homeDir })).reason, "package_root_required");
  assert.equal((await ensureLiveHub({ packageRoot: path.join(homeDir, "missing"), homeDir })).reason, "launcher_unavailable");

  const incompleteRoot = path.join(homeDir, "incomplete-package");
  await mkdir(path.join(incompleteRoot, "scripts"), { recursive: true });
  await writeFile(path.join(incompleteRoot, "scripts", "meta-kim-live.mjs"), "// launcher\n", "utf8");
  assert.equal((await ensureLiveHub({ packageRoot: incompleteRoot, homeDir })).reason, "package_identity_unavailable");
}));

test("refuses a junctioned Live Hub root without writing outside the home", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-live-hub-home-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-live-hub-outside-"));
  try {
    await mkdir(path.join(homeDir, ".meta-kim"), { recursive: true });
    await symlink(outsideDir, path.join(homeDir, ".meta-kim", "live"), process.platform === "win32" ? "junction" : "dir");

    await assert.rejects(() => writeLiveHubState({
      homeDir,
      address,
      instanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      pid: process.pid,
      processStartIdentity: "junction-test",
    }), /plain directory|symlink|junction/iu);
    await assert.rejects(() => ensureLiveHub({
      packageRoot: path.resolve("."),
      homeDir,
      timeoutMs: 100,
      healthProbe: async () => false,
    }), /plain directory|symlink|junction/iu);
    assert.deepEqual(await readdir(outsideDir), []);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});
