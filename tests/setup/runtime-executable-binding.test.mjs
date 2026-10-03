import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  discoverRuntimeExecutablePaths,
  loadSetupBoundRuntimeExecutable,
  readSetupRuntimeLaunchInventory,
  recordSetupRuntimeExecutableBindings,
  resolveSetupRuntimeLaunchInventoryRoots,
} from "../../scripts/runtime-executable-binding.mjs";
import { installStep, summarizeInstallStatus } from "../../scripts/install-status-semantics.mjs";

const setupSource = readFileSync(path.resolve(import.meta.dirname, "../../setup.mjs"), "utf8");

function executable(root, name, content = name) {
  const file = path.join(root, `${name}.exe`);
  writeFileSync(file, `${content}\n`, "utf8");
  return file;
}

function npmShim(root, name) {
  const discovered = path.join(root, name);
  const shim = path.join(root, `${name}.cmd`);
  const jsEntry = path.join(root, "node_modules", "@fixture", name, "bin", `${name}.js`);
  mkdirSync(path.dirname(jsEntry), { recursive: true });
  writeFileSync(discovered, "#!/bin/sh\n", "utf8");
  writeFileSync(jsEntry, "process.exitCode = 0;\n", "utf8");
  writeFileSync(shim, `@ECHO off\r\nSET dp0=%~dp0\r\n"node"  "%dp0%\\node_modules\\@fixture\\${name}\\bin\\${name}.js" %*\r\n`, "utf8");
  return { discovered, shim, jsEntry };
}

test("Windows locator failure or empty output discovers actual supported PATH files in directory and extension order", (context) => {
  if (process.platform !== "win32") return context.skip("Windows executable discovery");
  const root = mkdtempSync(path.join(tmpdir(), "meta-kim-runtime-path-fallback-"));
  try {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    mkdirSync(first); mkdirSync(second);
    const firstShim = npmShim(first, "codex");
    const firstNative = executable(first, "codex", "broken native candidate");
    const secondShim = npmShim(second, "codex");
    const env = { PATH: `${first};${second};${first}`, PATHEXT: ".PS1;.EXE;.CMD" };
    const expected = [firstShim.discovered, firstNative, firstShim.shim, secondShim.discovered, secondShim.shim];
    for (const result of [{ status: 1, stdout: "" }, { status: 0, stdout: "\r\n" }]) {
      assert.deepEqual(discoverRuntimeExecutablePaths("codex", { env, locatorRunner: () => result }), expected);
    }
    assert.deepEqual(discoverRuntimeExecutablePaths("codex", { env, locatorRunner: () => ({ status: 0, stdout: secondShim.shim + "\n" }) }), [secondShim.shim]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows fallback refuses empty, relative, rooted-relative, and unsupported executable discovery", (context) => {
  if (process.platform !== "win32") return context.skip("Windows executable discovery");
  const root = mkdtempSync(path.join(tmpdir(), "meta-kim-runtime-path-negative-"));
  try {
    writeFileSync(path.join(root, "codex.ps1"), "unsupported\n");
    writeFileSync(path.join(root, "codex"), "extensionless file without supported companion\n");
    const options = { env: { PATH: `;.;relative;\\;C:relative;${root}`, PATHEXT: ".PS1;.VBS" }, locatorRunner: () => ({ status: 1, stdout: "" }) };
    assert.deepEqual(discoverRuntimeExecutablePaths("codex", options), []);
    assert.deepEqual(discoverRuntimeExecutablePaths("../codex", options), []);
    assert.deepEqual(discoverRuntimeExecutablePaths("missing-runtime", options), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("non-Windows failed locator stays unavailable and successful which output is preserved", () => {
  const env = { PATH: "C:\\bin", PATHEXT: ".EXE" };
  assert.deepEqual(discoverRuntimeExecutablePaths("codex", { platform: "linux", env, locatorRunner: () => ({ status: 1, stdout: "/ignored\n" }) }), []);
  assert.deepEqual(discoverRuntimeExecutablePaths("codex", { platform: "linux", env, locatorRunner: () => ({ status: 0, stdout: "/first/codex\n/second/codex\n" }) }), ["/first/codex", "/second/codex"]);
});

test("default Windows binding probes real Node shims, selects the later usable executable, and rejects drift", { concurrency: false }, (context) => {
  if (process.platform !== "win32") return context.skip("Windows real Node shim binding");
  const root = mkdtempSync(path.join(tmpdir(), "meta-kim-runtime-real-shim-binding-"));
  const keys = Object.keys(process.env).filter(key => /^path$/iu.test(key));
  const original = new Map(keys.map(key => [key, process.env[key]]));
  if (!keys.length) keys.push("PATH");
  try {
    const brokenDir = path.join(root, "broken"); const usableDir = path.join(root, "usable");
    mkdirSync(brokenDir); mkdirSync(usableDir);
    const broken = npmShim(brokenDir, "codex"); const usable = npmShim(usableDir, "codex");
    writeFileSync(broken.jsEntry, "process.stderr.write('fixture broken version probe\\n'); process.exitCode=1;\n");
    writeFileSync(usable.jsEntry, "if(process.argv[2]!=='--version')process.exitCode=2;else console.log('fixture-codex 2.0.0');\n");
    for (const key of keys) process.env[key] = [brokenDir, usableDir].join(path.delimiter);
    const recorded = recordSetupRuntimeExecutableBindings({ roots: [root], targets: ["codex"] });
    assert.equal(recorded.bindings.codex.version, "fixture-codex 2.0.0");
    assert.equal(recorded.bindings.codex.launchDescriptor.jsEntry.realpath, realpathSync.native(usable.jsEntry));
    const loaded = loadSetupBoundRuntimeExecutable({ projectRoot: root, globalRoot: path.join(root, "unused"), runtime: "codex" });
    assert.equal(loaded.launchDescriptor.jsEntry.realpath, realpathSync.native(usable.jsEntry));
    writeFileSync(usable.jsEntry, "console.log('changed after binding');\n");
    assert.throws(() => loadSetupBoundRuntimeExecutable({ projectRoot: root, globalRoot: path.join(root, "unused"), runtime: "codex" }), /identity changed|JS entry identity changed/u);
  } finally {
    for (const key of keys) { if (original.get(key) === undefined) delete process.env[key]; else process.env[key] = original.get(key); }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows setup inventory records the shell-free launch descriptor actually used by version and producer calls", (context) => {
  if (process.platform !== "win32") return context.skip("Windows npm shim launch descriptor");
  const root = mkdtempSync(path.join(tmpdir(), "meta-kim-runtime-launch-descriptor-"));
  try {
    const fixture = npmShim(root, "codex");
    const versionCalls = [];
    recordSetupRuntimeExecutableBindings({
      roots: [root],
      profile: "fixture",
      targets: ["codex"],
      pathResolver: () => fixture.discovered,
      versionRunner: (launcher, args) => {
        versionCalls.push({ launcher, args });
        return { status: 0, stdout: "codex-cli 1.0.0\n", stderr: "" };
      },
    });
    const inventory = readSetupRuntimeLaunchInventory({ root, profile: "fixture", runtimes: ["codex"] });
    const binding = inventory.bindings.codex;
    assert.equal(inventory.schemaVersion, "meta-kim-runtime-launch-inventory-v2");
    assert.equal(inventory.executionAuthority, false);
    assert.equal(inventory.purpose, "setup_inventory_and_drift_detection");
    assert.equal(binding.executionAuthority, false);
    assert.equal(binding.launchDescriptor.discoveredEntry.realpath, fixture.discovered);
    assert.equal(binding.launchDescriptor.shim.realpath, fixture.shim);
    assert.equal(binding.launchDescriptor.launcher.realpath, process.execPath);
    assert.equal(binding.launchDescriptor.jsEntry.realpath, fixture.jsEntry);
    assert.deepEqual(binding.launchDescriptor.argsPrefix, [fixture.jsEntry]);
    for (const component of ["discoveredEntry", "shim", "launcher", "jsEntry"]) {
      assert.match(binding.launchDescriptor[component].sha256, /^[a-f0-9]{64}$/u);
      assert.equal(Number.isSafeInteger(binding.launchDescriptor[component].size), true);
    }
    assert.deepEqual(versionCalls, [{ launcher: process.execPath, args: [fixture.jsEntry, "--version"] }]);
    const loaded = loadSetupBoundRuntimeExecutable({
      projectRoot: root,
      globalRoot: path.join(root, "unused-global"),
      profile: "fixture",
      runtime: "codex",
      pathResolver: () => fixture.discovered,
    });
    assert.equal(loaded.realpath, process.execPath);
    assert.deepEqual(loaded.argsPrefix, [fixture.jsEntry]);
    assert.equal(loaded.executionAuthority, false);
    assert.match(loaded.trustBoundary, /not a same-user trust root|does not eliminate TOCTOU/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fresh install/update binding recorder refreshes selected runtimes and preserves unselected bindings", () => {
  const root = mkdtempSync(path.join(tmpdir(), "meta-kim-runtime-binding-"));
  try {
    const claude = executable(root, "claude", "claude-v1");
    const codex = executable(root, "codex", "codex-v1");
    const resolve = (name) => ({ claude, codex })[name] ?? null;
    const versionRunner = (file) => ({ status: 0, stdout: `${path.basename(file)} 1.0.0\n`, stderr: "" });
    recordSetupRuntimeExecutableBindings({ roots: [root], profile: "fixture", targets: ["claude", "codex"], pathResolver: resolve, versionRunner });
    const manifestPath = path.join(root, ".meta-kim", "state", "fixture", "runtime-capability-producers", "host-executable-bindings.json");
    const installed = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.deepEqual(Object.keys(installed.bindings).sort(), ["claude_code", "codex"]);
    const retainedClaude = installed.bindings.claude_code;

    writeFileSync(codex, "codex-v2\n", "utf8");
    recordSetupRuntimeExecutableBindings({ roots: [root], profile: "fixture", targets: ["codex"], pathResolver: resolve, versionRunner });
    const updated = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.deepEqual(updated.bindings.claude_code, retainedClaude);
    assert.notEqual(updated.bindings.codex.launchDescriptor.launcher.sha256, installed.bindings.codex.launchDescriptor.launcher.sha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("binding recorder skips broken candidates and records the first shell-free version probe that succeeds", () => {
  const root = mkdtempSync(path.join(tmpdir(), "meta-kim-runtime-binding-candidates-"));
  try {
    const stale = path.join(root, "missing-codex.exe");
    const broken = executable(root, "broken-codex", "broken");
    const usable = executable(root, "usable-codex", "usable");
    const calls = [];
    const result = recordSetupRuntimeExecutableBindings({
      roots: [root],
      profile: "fixture",
      targets: ["codex"],
      pathResolver: () => [stale, broken, usable],
      versionRunner: (launcher) => {
        calls.push(launcher);
        return launcher === usable
          ? { status: 0, stdout: "codex 2.0.0\n", stderr: "" }
          : { status: 1, stdout: "", stderr: "broken shim" };
      },
    });
    assert.deepEqual(calls, [broken, usable]);
    assert.equal(result.bindings.codex.launchDescriptor.launcher.realpath, usable);
    assert.equal(result.bindings.codex.version, "codex 2.0.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("binding loader finds the stored descriptor after a stale or mismatched earlier PATH candidate", () => {
  const root = mkdtempSync(path.join(tmpdir(), "meta-kim-runtime-loader-candidates-"));
  try {
    const stale = path.join(root, "missing-codex.exe");
    const other = executable(root, "other-codex", "other");
    const stored = executable(root, "stored-codex", "stored");
    recordSetupRuntimeExecutableBindings({
      roots: [root],
      profile: "fixture",
      targets: ["codex"],
      pathResolver: () => stored,
      versionRunner: () => ({ status: 0, stdout: "codex 2.0.0\n", stderr: "" }),
    });
    const loaded = loadSetupBoundRuntimeExecutable({
      projectRoot: root,
      globalRoot: path.join(root, "unused-global"),
      profile: "fixture",
      runtime: "codex",
      pathResolver: () => [stale, other, stored],
    });
    assert.equal(loaded.realpath, stored);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production PATH locator skips a broken first candidate and reloads the usable second candidate", { concurrency: false }, () => {
  // Use the same project boundary for Node file writes and the external PATH
  // locator. A sandbox can expose its OS temp directory only to the Node child.
  const fixtureParent = path.resolve(import.meta.dirname, "../../tmp");
  mkdirSync(fixtureParent, { recursive: true });
  const root = mkdtempSync(path.join(fixtureParent, "meta-kim-runtime-default-locator-"));
  const brokenDir = path.join(root, "broken-bin");
  const usableDir = path.join(root, "usable-bin");
  const executableName = process.platform === "win32" ? "codex.exe" : "codex";
  const broken = path.join(brokenDir, executableName);
  const usable = path.join(usableDir, executableName);
  // Node test workers can preserve both PATH and Path. Windows child process
  // environment folding must see the fixture path through either spelling.
  const pathKeys = process.platform === "win32"
    ? Object.keys(process.env).filter((key) => /^path$/iu.test(key))
    : ["PATH"];
  const originalPaths = new Map(pathKeys.map((key) => [key, process.env[key]]));
  if (pathKeys.length === 0) pathKeys.push("PATH");
  try {
    mkdirSync(brokenDir, { recursive: true });
    mkdirSync(usableDir, { recursive: true });
    writeFileSync(broken, process.platform === "win32" ? "broken\n" : "#!/bin/sh\nexit 1\n", "utf8");
    writeFileSync(usable, process.platform === "win32" ? "usable\n" : "#!/bin/sh\nexit 0\n", "utf8");
    if (process.platform !== "win32") {
      chmodSync(broken, 0o755);
      chmodSync(usable, 0o755);
    }
    const fixturePath = [brokenDir, usableDir, ...new Set(originalPaths.values())].filter(Boolean).join(path.delimiter);
    for (const key of pathKeys) process.env[key] = fixturePath;

    const brokenRealpath = realpathSync.native(broken);
    const usableRealpath = realpathSync.native(usable);
    const calls = [];
    const recorded = recordSetupRuntimeExecutableBindings({
      roots: [root],
      profile: "fixture",
      targets: ["codex"],
      versionRunner: (launcher) => {
        calls.push(launcher);
        return launcher === usableRealpath
          ? { status: 0, stdout: "codex 2.0.0\n", stderr: "" }
          : { status: 1, stdout: "", stderr: "broken candidate" };
      },
    });

    assert.deepEqual(calls, [brokenRealpath, usableRealpath]);
    assert.equal(recorded.bindings.codex.launchDescriptor.discoveredEntry.realpath, usableRealpath);
    assert.equal(recorded.bindings.codex.launchDescriptor.launcher.realpath, usableRealpath);

    const loaded = loadSetupBoundRuntimeExecutable({
      projectRoot: root,
      globalRoot: path.join(root, "unused-global"),
      profile: "fixture",
      runtime: "codex",
    });
    assert.equal(loaded.realpath, usableRealpath);
  } finally {
    for (const key of pathKeys) {
      const original = originalPaths.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("binding recorder aggregates candidate diagnostics when every probe fails", () => {
  const root = mkdtempSync(path.join(tmpdir(), "meta-kim-runtime-binding-errors-"));
  try {
    const stale = path.join(root, "missing-codex.exe");
    const broken = executable(root, "broken-codex", "broken");
    assert.throws(
      () => recordSetupRuntimeExecutableBindings({
        roots: [root],
        targets: ["codex"],
        pathResolver: () => [stale, broken],
        versionRunner: () => ({ status: 1, stdout: "", stderr: "unsupported version" }),
      }),
      (error) => {
        assert.match(error.message, /no usable PATH candidate/u);
        assert.match(error.message, /missing-codex\.exe/u);
        assert.match(error.message, /broken-codex\.exe/u);
        assert.match(error.message, /unsupported version/u);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup binding roots accept managed deployment records and remain absolute", () => {
  const root = mkdtempSync(path.join(tmpdir(), "meta-kim-runtime-binding-roots-"));
  const homeRoot = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  mkdirSync(homeRoot);
  mkdirSync(projectRoot);
  try {
    assert.deepEqual(
      resolveSetupRuntimeLaunchInventoryRoots({
        installScope: "global",
        deployments: [{ targetDir: projectRoot, activeTargets: ["claude", "codex"] }],
        homeRoot,
        callerCwd: projectRoot,
      }),
      [homeRoot, projectRoot],
    );
    assert.deepEqual(
      resolveSetupRuntimeLaunchInventoryRoots({
        installScope: "project",
        deployments: [],
        homeRoot,
        callerCwd: projectRoot,
      }),
      [projectRoot],
    );
    assert.throws(
      () => resolveSetupRuntimeLaunchInventoryRoots({
        installScope: "global",
        deployments: [{ targetDir: "relative-project" }],
        homeRoot,
        callerCwd: projectRoot,
      }),
      /root must be absolute/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("producer binding loader uses the exact project profile before isolated global fallback", () => {
  const root = mkdtempSync(path.join(tmpdir(), "meta-kim-runtime-binding-profile-"));
  const projectRoot = path.join(root, "project");
  const globalRoot = path.join(root, "global-home");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(globalRoot, { recursive: true });
  try {
    const projectCodex = executable(root, "project-codex", "project");
    const globalCodex = executable(root, "global-codex", "global");
    recordSetupRuntimeExecutableBindings({
      roots: [projectRoot], profile: "selected", targets: ["codex"],
      pathResolver: () => projectCodex,
      versionRunner: () => ({ status: 0, stdout: "project 1.0.0", stderr: "" }),
    });
    recordSetupRuntimeExecutableBindings({
      roots: [globalRoot], profile: "selected", targets: ["codex"],
      pathResolver: () => globalCodex,
      versionRunner: () => ({ status: 0, stdout: "global 1.0.0", stderr: "" }),
    });
    assert.equal(loadSetupBoundRuntimeExecutable({ projectRoot, globalRoot, profile: "selected", runtime: "codex", pathResolver: () => projectCodex }).realpath, projectCodex);
    writeFileSync(projectCodex, "damaged-after-setup\n", "utf8");
    assert.throws(
      () => loadSetupBoundRuntimeExecutable({ projectRoot, globalRoot, profile: "selected", runtime: "codex", pathResolver: () => globalCodex }),
      /project runtime launch binding.*changed|project runtime launch binding.*invalid/iu,
    );
    const emptyProject = path.join(root, "empty-project");
    mkdirSync(emptyProject, { recursive: true });
    assert.equal(loadSetupBoundRuntimeExecutable({ projectRoot: emptyProject, globalRoot, profile: "selected", runtime: "codex", pathResolver: () => globalCodex }).realpath, globalCodex);
    assert.throws(() => loadSetupBoundRuntimeExecutable({ projectRoot: emptyProject, globalRoot, profile: "other", runtime: "codex", pathResolver: () => globalCodex }), /unavailable/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a valid project inventory without the requested target falls back to the global target", () => {
  const root = mkdtempSync(path.join(tmpdir(), "meta-kim-runtime-binding-target-fallback-"));
  const projectRoot = path.join(root, "project");
  const globalRoot = path.join(root, "global-home");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(globalRoot, { recursive: true });
  try {
    const claude = executable(root, "project-claude", "project-claude");
    const codex = executable(root, "global-codex", "global-codex");
    recordSetupRuntimeExecutableBindings({ roots: [projectRoot], profile: "selected", targets: ["claude"], pathResolver: () => claude, versionRunner: () => ({ status: 0, stdout: "claude 1", stderr: "" }) });
    recordSetupRuntimeExecutableBindings({ roots: [globalRoot], profile: "selected", targets: ["codex"], pathResolver: () => codex, versionRunner: () => ({ status: 0, stdout: "codex 1", stderr: "" }) });
    const loaded = loadSetupBoundRuntimeExecutable({ projectRoot, globalRoot, profile: "selected", runtime: "codex", pathResolver: () => codex });
    assert.equal(loaded.realpath, codex);
    assert.equal(loaded.inventoryScope, "global");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing executable and manifest write failure fail the required setup binding step", () => {
  const root = mkdtempSync(path.join(tmpdir(), "meta-kim-runtime-binding-failure-"));
  try {
    assert.throws(() => recordSetupRuntimeExecutableBindings({ roots: [root], targets: ["codex"], pathResolver: () => null }), /unavailable/u);
    const blockedRoot = path.join(root, "blocked-root");
    mkdirSync(blockedRoot, { recursive: true });
    writeFileSync(path.join(blockedRoot, ".meta-kim"), "not a directory\n", "utf8");
    const codex = executable(root, "codex-write-failure");
    assert.throws(() => recordSetupRuntimeExecutableBindings({
      roots: [blockedRoot], targets: ["codex"], pathResolver: () => codex,
      versionRunner: () => ({ status: 0, stdout: "codex 1.0.0", stderr: "" }),
    }));
    assert.match(setupSource, /function refreshRuntimeExecutableBindings[\s\S]*?catch \(error\)[\s\S]*?return false;/u);
    assert.equal((setupSource.match(/installStep\("runtime executable bindings", runtimeBindingsOk\)/gu) ?? []).length, 2);
    const requiredFailure = summarizeInstallStatus([installStep("runtime executable bindings", false)]);
    assert.equal(requiredFailure.status, "failed");
    assert.equal(requiredFailure.exitCode, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the final global check reads back every selected Claude Code or Codex launch descriptor without execution", () => {
  const source = readFileSync(path.resolve(import.meta.dirname, "../../scripts/sync-global-meta-theory.mjs"), "utf8");
  assert.match(source, /readSetupRuntimeLaunchInventory/u);
  assert.match(source, /selectedTargetIds\.includes\("claude"\)/u);
  assert.match(source, /selectedTargetIds\.includes\("codex"\)/u);
  assert.match(source, /runtimes:\s*group\.map\(\(entry\) => entry\.runtime\)/u);
  assert.match(source, /executionAuthority === false/u);
  const runCheckSource = source.slice(
    source.indexOf("async function runCheck()"),
    source.indexOf("async function restoreFileSnapshot"),
  );
  assert.match(runCheckSource, /checkSelectedRuntimeLaunchInventories\(\)/u);
  assert.doesNotMatch(
    runCheckSource,
    /if \(withGlobalHooks[^)]*\)[\s\S]*checkSelectedRuntimeLaunchInventories\(\)/u,
  );
  assert.doesNotMatch(source, /recordSetupRuntimeExecutableBindings/u);
  const validationSource = setupSource.slice(
    setupSource.indexOf("async function validateInstalledArtifacts"),
    setupSource.indexOf("function printInstallResult"),
  );
  assert.match(validationSource, /checkGlobalRuntimeSync\(globalValidationTargets\)/u);
  const globalCheckSource = setupSource.slice(
    setupSource.indexOf("function checkGlobalRuntimeSync"),
    setupSource.indexOf("function checkManifestProjectionAuthority"),
  );
  assert.match(
    globalCheckSource,
    /metaTheoryGlobalSyncArgs\(selectedTargets, setupWithGlobalHooks\)/u,
  );
  const producerSource = readFileSync(path.resolve(import.meta.dirname, "../../scripts/runtime-capability-producers.mjs"), "utf8");
  assert.match(producerSource, /const argsPrefix = executableIdentity\?\.argsPrefix \?\? \[\]/u);
  assert.match(producerSource, /request\.executableIdentity\?\.argsPrefix \?\? \[\][\s\S]*"--version"/u);
});
