import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  mcpDefinitionFingerprint,
  resolveDurableMetaKimRuntimeLayout,
  resolvePortableMetaKimPackageIdentity,
} from "../../scripts/global-runtime-mcp.mjs";
import { tarExtractCommand } from "../../scripts/tar-extract-command.mjs";
import { resolveCliInvocation } from "../../scripts/runtime-cli-invocation.mjs";
import { readSetupRuntimeLaunchInventory } from "../../scripts/runtime-executable-binding.mjs";

const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const DISTRIBUTION = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "config", "distribution.json"), "utf8"),
);
const ORIGINAL_MANIFEST = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
);
const ORIGINAL_IDENTITY = resolvePortableMetaKimPackageIdentity(
  ORIGINAL_MANIFEST,
  DISTRIBUTION,
);
const SYNC_TIMEOUT_MS = 300_000;
const SERIAL_TEST_OPTIONS = { concurrency: false };
const GLOBAL_SYNC_SOURCE = readFileSync(
  path.join(REPO_ROOT, "scripts", "sync-global-meta-theory.mjs"),
  "utf8",
);

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout ?? SYNC_TIMEOUT_MS,
    ...options,
  });
}

function requireSuccess(label, result) {
  assert.equal(
    result.status,
    0,
    `${label} failed\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`,
  );
  return result;
}

test("durable MCP materialization reuses the verified projection bundle without a third npm install", () => {
  assert.match(
    GLOBAL_SYNC_SOURCE,
    /copyDurableMcpRuntimeFromProjectionAuthority\([\s\S]*executingProjectionPackage\.bundleDir/u,
  );
  assert.match(GLOBAL_SYNC_SOURCE, /fs\.cp\([\s\S]*dereference:\s*true/u);
  assert.match(
    GLOBAL_SYNC_SOURCE,
    /sourcePackageSha256\s*=\s*executingProjectionPackage\.packageTarballSha256/u,
  );
});

function preparePackedCandidate(testRoot) {
  const installDir = path.join(testRoot, "candidate-package");
  const packDir = path.join(installDir, "pack");
  const extractDir = path.join(installDir, "extract");
  mkdirSync(packDir, { recursive: true });
  mkdirSync(extractDir, { recursive: true });
  const npm = resolveCliInvocation("npm", ["pack", "--json", "--pack-destination", packDir]);
  const packed = requireSuccess("candidate npm pack", run(
    npm.command,
    npm.args,
    { cwd: REPO_ROOT },
  ));
  // Successful prepack diagnostics can precede npm's final JSON array. The
  // lifecycle gate remains enabled and its nonzero exit is checked above.
  const jsonBoundary = packed.stdout.lastIndexOf("\n[");
  const packResult = JSON.parse(jsonBoundary < 0 ? packed.stdout : packed.stdout.slice(jsonBoundary));
  assert.ok(Array.isArray(packResult) && packResult[0]?.filename);
  const extraction = tarExtractCommand(path.join(packDir, packResult[0].filename), extractDir);
  requireSuccess("candidate tgz extraction", run(
    extraction.command,
    extraction.args,
    { cwd: extraction.cwd },
  ));
  const workspace = path.join(extractDir, "package");
  assert.ok(existsSync(path.join(workspace, "scripts", "sync-global-meta-theory.mjs")));
  assert.equal(existsSync(path.join(workspace, ".git")), false);
  return { installDir, workspace };
}

function setPackedFixtureVersion(workspace, version) {
  const manifestPath = path.join(workspace, "package.json");
  const lockPath = path.join(workspace, "npm-shrinkwrap.json");
  const baselinePath = path.join(workspace, "config", "dependency-baseline.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const originalBaseline = structuredClone(baseline);
  const originalLock = structuredClone(lock);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
  assert.equal(baseline.npm.sha256, sha256(readFileSync(lockPath)));
  manifest.version = version;
  lock.version = version;
  lock.packages[""].version = version;
  const lockBytes = `${JSON.stringify(lock, null, 2)}\n`;
  baseline.npm.sha256 = sha256(lockBytes);
  assert.deepEqual(
    { ...lock, version: originalLock.version, packages: {
      ...lock.packages, "": { ...lock.packages[""], version: originalLock.packages[""].version },
    } },
    originalLock,
  );
  assert.deepEqual(
    { ...baseline, npm: { ...baseline.npm, sha256: originalBaseline.npm.sha256 } },
    originalBaseline,
  );
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(lockPath, lockBytes);
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  return manifest;
}

function isolatedRuntime(testRoot, label) {
  const userHome = path.join(testRoot, label);
  const claudeHome = path.join(userHome, ".claude");
  const claudeConfig = path.join(userHome, ".claude.json");
  mkdirSync(claudeHome, { recursive: true });
  return {
    claudeConfig,
    claudeHome,
    userHome,
    env: {
      ...process.env,
      HOME: userHome,
      USERPROFILE: userHome,
      META_KIM_CLAUDE_HOME: claudeHome,
      META_KIM_CLAUDE_USER_CONFIG: claudeConfig,
    },
  };
}

function runGlobalSync(workspace, runtime, extraEnv = {}) {
  return run(
    process.execPath,
    [path.join(workspace, "scripts", "sync-global-meta-theory.mjs"), "--targets", "claude"],
    {
      cwd: runtime.userHome,
      env: { ...runtime.env, ...extraEnv },
    },
  );
}

function runGlobalSyncWithoutDurableMcp(workspace, runtime) {
  return run(
    process.execPath,
    [
      path.join(workspace, "scripts", "sync-global-meta-theory.mjs"),
      "--targets",
      "claude",
      "--skip-durable-mcp",
    ],
    {
      cwd: runtime.userHome,
      env: runtime.env,
    },
  );
}

function runGlobalCheck(workspace, runtime) {
  return run(
    process.execPath,
    [path.join(workspace, "scripts", "sync-global-meta-theory.mjs"), "--check", "--targets", "claude"],
    {
      cwd: runtime.userHome,
      env: runtime.env,
    },
  );
}

function runRuntimeLaunchRebind(workspace, runtime) {
  return run(
    process.execPath,
    [
      path.join(workspace, "setup.mjs"),
      "--rebind-runtime-launch",
      "--targets",
      "claude",
      "--scope",
      "global",
    ],
    {
      cwd: runtime.userHome,
      env: runtime.env,
    },
  );
}

function prepareVersionOnlyRuntimeFixture(binDir) {
  // This executable proves only inventory discovery and fingerprinting. It
  // refuses every operation except --version and cannot invoke a model.
  const version = "Meta_Kim version-only binding fixture 0.0.0";
  const body = `if (process.argv.length !== 3 || process.argv[2] !== "--version") { process.stderr.write("Version-only fixture refuses execution.\\n"); process.exitCode = 64; } else { console.log(${JSON.stringify(version)}); }\n`;
  const commandPath = path.join(binDir, process.platform === "win32" ? "claude.cmd" : "claude");
  if (process.platform === "win32") {
    writeFileSync(path.join(binDir, "claude-fixture.cjs"), body);
    writeFileSync(commandPath, '@ECHO off\r\n"node" "%~dp0\\claude-fixture.cjs" %*\r\n');
  } else {
    writeFileSync(commandPath, `#!/usr/bin/env node\n${body}`);
    chmodSync(commandPath, 0o755);
  }
  return { commandPath, version };
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function treeFingerprint(root) {
  const entries = [];
  function walk(current, relative = "") {
    for (const name of readdirSync(current).sort()) {
      const absolute = path.join(current, name);
      const childRelative = path.join(relative, name).replaceAll("\\", "/");
      const stat = statSync(absolute);
      if (stat.isDirectory()) {
        entries.push(`d:${childRelative}`);
        walk(absolute, childRelative);
      } else {
        entries.push(`f:${childRelative}:${stat.size}:${sha256(readFileSync(absolute))}`);
      }
    }
  }
  walk(root);
  return sha256(entries.join("\n"));
}

function listFilesIfPresent(root) {
  if (!existsSync(root)) return [];
  const files = [];
  function walk(current, relative = "") {
    for (const name of readdirSync(current).sort()) {
      const absolute = path.join(current, name);
      const childRelative = path.join(relative, name).replaceAll("\\", "/");
      if (statSync(absolute).isDirectory()) walk(absolute, childRelative);
      else files.push(childRelative);
    }
  }
  walk(root);
  return files;
}

function historicalClaudeAgentFixture() {
  const catalog = JSON.parse(readFileSync(
    path.join(REPO_ROOT, "config", "migrations", "global-agent-projection-fingerprints.json"),
    "utf8",
  ));
  for (const projection of catalog.projections ?? []) {
    if (projection.targetId !== "claude") continue;
    const sourceFile = `canonical/agents/${projection.agentId}.md`;
    const current = readFileSync(path.join(REPO_ROOT, sourceFile), "utf8");
    const revisions = run("git", ["log", "--format=%H", "--", sourceFile], {
      cwd: REPO_ROOT,
    });
    if (revisions.status !== 0) continue;
    for (const revision of revisions.stdout.split(/\r?\n/u).filter(Boolean)) {
      const shown = run("git", ["show", `${revision}:${sourceFile}`], { cwd: REPO_ROOT });
      if (shown.status !== 0 || shown.stdout === current) continue;
      if (projection.fingerprints.includes(sha256(shown.stdout))) {
        return { agentId: projection.agentId, current, historical: shown.stdout };
      }
    }
  }
  throw new Error("No catalog-backed historical Claude Agent projection is available for migration proof.");
}

function assertMcpTransport(server, runtime) {
  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "global-runtime-bundle-test", version: "1.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_meta_runtime_capabilities", arguments: {} },
    },
  ];
  const result = run(server.command, server.args, {
    cwd: runtime.userHome,
    env: { ...runtime.env, ...(server.env ?? {}) },
    input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    timeout: 60_000,
  });
  requireSuccess("durable MCP transport", result);
  const responses = String(result.stdout ?? "")
    .split(/\r?\n/u)
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line));
  const tools = responses.find((response) => response.id === 2)?.result?.tools ?? [];
  assert.ok(tools.some((tool) => tool.name === "get_meta_runtime_capabilities"));
  const call = responses.find((response) => response.id === 3);
  assert.ok(call?.result && !call.error, "durable MCP tool call must succeed");
}

function assertManifestIdentity(runtime, layout, definition) {
  const manifest = JSON.parse(
    readFileSync(path.join(runtime.userHome, ".meta-kim", "install-manifest.json"), "utf8"),
  );
  const bundleEntry = manifest.entries.find(
    (entry) => entry.kind === "dir" && entry.purpose === "claude-global-mcp-runtime-bundle",
  );
  assert.equal(path.resolve(bundleEntry?.path ?? ""), path.resolve(layout.bundleDir));

  const tracked = new Map([
    ["package-manifest", layout.packageManifestPath],
    ["cli", layout.cliPath],
    ["server", layout.serverPath],
  ]);
  for (const [label, filePath] of tracked) {
    const entry = manifest.entries.find(
      (candidate) => candidate.purpose === `claude-global-mcp-runtime-bundle:${label}`,
    );
    const content = readFileSync(filePath);
    assert.equal(path.resolve(entry?.path ?? ""), path.resolve(filePath));
    assert.equal(entry?.size, content.byteLength);
    assert.equal(entry?.sha256, sha256(content));
  }

  const mcpEntry = manifest.entries.find(
    (entry) => entry.kind === "mcp-server" && entry.mcpServerName === "meta-kim-runtime",
  );
  assert.equal(path.resolve(mcpEntry?.path ?? ""), path.resolve(runtime.claudeConfig));
  assert.equal(mcpEntry?.mcpServerFingerprint, mcpDefinitionFingerprint(definition));
}

function verifySuccessfulDurableBundleLifecycle() {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-runtime-bundle-"));
  try {
    const candidate = preparePackedCandidate(testRoot);
    const runtime = isolatedRuntime(testRoot, "runtime-home");
    requireSuccess("first packed global sync", runGlobalSync(candidate.workspace, runtime));

    const layout = resolveDurableMetaKimRuntimeLayout(
      runtime.userHome,
      ORIGINAL_IDENTITY,
      ORIGINAL_MANIFEST,
      process.execPath,
      "claude",
    );
    const firstConfigRaw = readFileSync(runtime.claudeConfig, "utf8");
    const firstConfig = JSON.parse(firstConfigRaw);
    const server = firstConfig.mcpServers?.["meta-kim-runtime"];
    assert.deepEqual(server, layout.definition);
    assert.equal(server.command, process.execPath);
    assert.deepEqual(server.args, [layout.cliPath, "mcp", "serve"]);
    assert.doesNotMatch(JSON.stringify(server), /(?:^|[\\/])npx(?:\.cmd)?(?:$|["\\/])/iu);
    for (const forbidden of [REPO_ROOT, candidate.workspace, candidate.installDir]) {
      assert.equal(
        JSON.stringify(server).includes(forbidden),
        false,
        `MCP registration leaked ephemeral source path: ${forbidden}`,
      );
    }
    assert.ok(existsSync(layout.packageManifestPath));
    assert.ok(existsSync(layout.cliPath));
    assert.ok(existsSync(layout.serverPath));
    assert.equal(
      readdirSync(path.dirname(layout.bundleDir)).some((name) =>
        name.startsWith(".meta-kim-runtime-staged-")),
      false,
      "successful sync left a staging directory",
    );
    assertManifestIdentity(runtime, layout, server);

    const firstBundleFingerprint = treeFingerprint(layout.bundleDir);
    const backupRoot = path.join(runtime.userHome, ".meta-kim", "backups", "mcp-runtime");
    const firstBackups = listFilesIfPresent(backupRoot);
    requireSuccess("second packed global sync", runGlobalSync(candidate.workspace, runtime));
    const fixtureBin = path.join(runtime.userHome, "version-only-cli-fixture");
    mkdirSync(fixtureBin);
    const callerPath = runtime.env.PATH ?? runtime.env.Path ?? "";
    const envWithoutPath = Object.fromEntries(Object.entries(runtime.env).filter(([key]) => !/^path$/iu.test(key)));
    runtime.env = { ...envWithoutPath, PATH: fixtureBin };
    const inventoryPath = path.join(runtime.userHome, ".meta-kim/state/default/runtime-capability-producers/host-executable-bindings.json");
    const inventoryBefore = existsSync(inventoryPath) ? readFileSync(inventoryPath, "utf8") : null;
    const unavailable = runRuntimeLaunchRebind(candidate.workspace, runtime);
    assert.notEqual(unavailable.status, 0, "missing host executable must not create a successful binding");
    assert.match(`${unavailable.stdout}\n${unavailable.stderr}`, /selected runtime executable is unavailable: claude/u);
    assert.equal(existsSync(inventoryPath) ? readFileSync(inventoryPath, "utf8") : null, inventoryBefore);
    const versionFixture = prepareVersionOnlyRuntimeFixture(fixtureBin);
    runtime.env = { ...envWithoutPath, PATH: [fixtureBin, path.dirname(process.execPath), callerPath].join(path.delimiter) };
    requireSuccess(
      "packed setup runtime launch inventory rebind",
      runRuntimeLaunchRebind(candidate.workspace, runtime),
    );
    const inventory = readSetupRuntimeLaunchInventory({ root: runtime.userHome, runtimes: ["claude_code"] });
    assert.equal(inventory.executionAuthority, false);
    assert.equal(inventory.bindings.claude_code.executionAuthority, false);
    assert.equal(inventory.bindings.claude_code.version, versionFixture.version);
    assert.equal(inventory.bindings.claude_code.launchDescriptor.discoveredEntry.realpath, realpathSync.native(versionFixture.commandPath));
    assert.equal(
      treeFingerprint(layout.bundleDir),
      firstBundleFingerprint,
      "idempotent sync must preserve the exact durable bundle closure",
    );
    assert.equal(readFileSync(runtime.claudeConfig, "utf8"), firstConfigRaw);
    assert.deepEqual(
      listFilesIfPresent(backupRoot),
      firstBackups,
      "idempotent sync must not displace an already exact bundle into backups",
    );

    const wrappedServer = {
      ...server,
      command: "cmd",
      args: ["/c", server.command, ...server.args],
    };
    const wrappedConfig = JSON.parse(firstConfigRaw);
    wrappedConfig.mcpServers["meta-kim-runtime"] = wrappedServer;
    const wrappedConfigRaw = `${JSON.stringify(wrappedConfig, null, 2)}\n`;
    writeFileSync(runtime.claudeConfig, wrappedConfigRaw, "utf8");
    requireSuccess(
      "Claude-normalized exact Windows wrapper check",
      runGlobalCheck(candidate.workspace, runtime),
    );
    requireSuccess(
      "Claude-normalized exact Windows wrapper sync",
      runGlobalSync(candidate.workspace, runtime),
    );
    assert.equal(readFileSync(runtime.claudeConfig, "utf8"), wrappedConfigRaw);
    assertManifestIdentity(runtime, layout, wrappedServer);

    const unknownBundleFile = path.join(layout.bundleDir, "user-added-runtime-file.txt");
    writeFileSync(unknownBundleFile, "preserve\n", "utf8");
    const drifted = runGlobalSync(candidate.workspace, runtime);
    assert.notEqual(drifted.status, 0, "bundle closure drift must block replacement");
    assert.match(`${drifted.stdout ?? ""}\n${drifted.stderr ?? ""}`, /unowned durable MCP runtime/iu);
    assert.equal(readFileSync(unknownBundleFile, "utf8"), "preserve\n");
    rmSync(unknownBundleFile, { force: true });

    rmSync(candidate.installDir, { recursive: true, force: true });
    assert.equal(existsSync(candidate.workspace), false);
    const selfTest = run(server.command, [layout.cliPath, "mcp", "self-test"], {
      cwd: runtime.userHome,
      env: runtime.env,
      timeout: 60_000,
    });
    requireSuccess("durable MCP self-test after source deletion", selfTest);
    assert.match(selfTest.stdout, /"ok"\s*:\s*true/u);
    assertMcpTransport(server, runtime);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
}

function verifyDurableBundleRollbackFailures() {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-runtime-rollback-"));
  try {
    const candidate = preparePackedCandidate(testRoot);
    const runtime = isolatedRuntime(testRoot, "runtime-home");
    requireSuccess("seed packed global sync", runGlobalSync(candidate.workspace, runtime));

    const oldLayout = resolveDurableMetaKimRuntimeLayout(
      runtime.userHome,
      ORIGINAL_IDENTITY,
      ORIGINAL_MANIFEST,
    );
    const oldBundleFingerprint = treeFingerprint(oldLayout.bundleDir);
    const oldConfigRaw = readFileSync(runtime.claudeConfig, "utf8");
    const manifestPath = path.join(runtime.userHome, ".meta-kim", "install-manifest.json");
    const oldManifestRaw = readFileSync(manifestPath, "utf8");
    const backupRoot = path.join(runtime.userHome, ".meta-kim", "backups", "mcp-runtime");
    const oldBackups = listFilesIfPresent(backupRoot);

    const nextManifest = setPackedFixtureVersion(
      candidate.workspace,
      `${ORIGINAL_MANIFEST.version}-runtime-bundle-test`,
    );
    const nextIdentity = resolvePortableMetaKimPackageIdentity(nextManifest, DISTRIBUTION);
    const nextLayout = resolveDurableMetaKimRuntimeLayout(
      runtime.userHome,
      nextIdentity,
      nextManifest,
    );

    for (const failurePoint of ["pack", "install", "candidate_lock", "rename", "manifest", "post_rename_verify"]) {
      const failed = runGlobalSync(candidate.workspace, runtime, {
        META_KIM_TEST_FAIL_DURABLE_MCP_AT: failurePoint,
      });
      assert.notEqual(failed.status, 0, `${failurePoint} fault injection unexpectedly passed`);
      const failureOutput = `${failed.stdout ?? ""}\n${failed.stderr ?? ""}`;
      if (failurePoint === "candidate_lock") {
        assert.match(failureOutput, /candidate lock does not match the packed source digest/iu);
      } else {
        assert.match(
          failureOutput,
          new RegExp(`Injected durable MCP ${failurePoint} failure`, "iu"),
        );
      }
      if (failurePoint === "manifest") {
        assert.match(
          `${failed.stdout ?? ""}\n${failed.stderr ?? ""}`,
          /global sync is partial[\s\S]*rerun the same sync command/iu,
        );
      }
      assert.equal(existsSync(nextLayout.bundleDir), false, `${failurePoint} left a new bundle`);
      assert.equal(treeFingerprint(oldLayout.bundleDir), oldBundleFingerprint);
      assert.equal(readFileSync(runtime.claudeConfig, "utf8"), oldConfigRaw);
      assert.equal(readFileSync(manifestPath, "utf8"), oldManifestRaw);
      assert.deepEqual(
        listFilesIfPresent(backupRoot),
        oldBackups,
        `${failurePoint} changed durable bundle backups`,
      );
      assert.equal(
        readdirSync(path.dirname(nextLayout.bundleDir)).some((name) =>
          name.startsWith(".meta-kim-runtime-staged-")),
        false,
        `${failurePoint} left a staging directory`,
      );
    }

    // A same-version candidate can still differ during development. This lane
    // exercises the actual displacement path rather than a new version dir.
    setPackedFixtureVersion(candidate.workspace, ORIGINAL_MANIFEST.version);
    const candidateCliPath = path.join(candidate.workspace, ORIGINAL_MANIFEST.bin[ORIGINAL_IDENTITY.cliName]);
    writeFileSync(
      candidateCliPath,
      `${readFileSync(candidateCliPath, "utf8")}\n// same-version rollback candidate\n`,
      "utf8",
    );
    const displacedFailure = runGlobalSync(candidate.workspace, runtime, {
      META_KIM_TEST_FAIL_DURABLE_MCP_AT: "post_rename_verify",
    });
    assert.notEqual(displacedFailure.status, 0);
    assert.match(
      `${displacedFailure.stdout ?? ""}\n${displacedFailure.stderr ?? ""}`,
      /Injected durable MCP post_rename_verify failure/iu,
    );
    assert.equal(treeFingerprint(oldLayout.bundleDir), oldBundleFingerprint);
    assert.equal(readFileSync(runtime.claudeConfig, "utf8"), oldConfigRaw);
    assert.equal(readFileSync(manifestPath, "utf8"), oldManifestRaw);
    assert.deepEqual(listFilesIfPresent(backupRoot), oldBackups);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
}

function verifyLockedSameVersionBundleUsesImmutableAuthority() {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-runtime-locked-"));
  try {
    const candidate = preparePackedCandidate(testRoot);
    const runtime = isolatedRuntime(testRoot, "runtime-home");
    requireSuccess("seed packed global sync", runGlobalSync(candidate.workspace, runtime));

    const legacyLayout = resolveDurableMetaKimRuntimeLayout(
      runtime.userHome,
      ORIGINAL_IDENTITY,
      ORIGINAL_MANIFEST,
    );
    const legacyFingerprint = treeFingerprint(legacyLayout.bundleDir);
    const candidateCliPath = path.join(
      candidate.workspace,
      ORIGINAL_MANIFEST.bin[ORIGINAL_IDENTITY.cliName],
    );
    writeFileSync(
      candidateCliPath,
      `${readFileSync(candidateCliPath, "utf8")}\n// locked same-version candidate\n`,
      "utf8",
    );

    const updated = runGlobalSync(candidate.workspace, runtime, {
      META_KIM_TEST_FAIL_DURABLE_MCP_AT: "locked_rename",
    });
    requireSuccess("locked same-version packed global sync", updated);
    assert.match(
      `${updated.stdout ?? ""}\n${updated.stderr ?? ""}`,
      /switched future launches to the exact immutable projection package/iu,
    );
    assert.equal(treeFingerprint(legacyLayout.bundleDir), legacyFingerprint);

    const config = JSON.parse(readFileSync(runtime.claudeConfig, "utf8"));
    assert.deepEqual(config.mcpServers["meta-kim-runtime"].env, { META_KIM_RUNTIME_FAMILY: "claude" });
    const cliPath = config.mcpServers["meta-kim-runtime"].args[0];
    const portableCliPath = cliPath.replaceAll("\\", "/");
    assert.ok(
      portableCliPath.includes(
        `/projection-packages/meta-kim/${ORIGINAL_MANIFEST.version}/`,
      ),
    );
    assert.match(portableCliPath, /\/[a-f0-9]{64}\/bundle\//u);
    assert.ok(existsSync(cliPath));
    requireSuccess(
      "immutable-authority idempotent sync after locked update",
      runGlobalSync(candidate.workspace, runtime),
    );
    assert.equal(treeFingerprint(legacyLayout.bundleDir), legacyFingerprint);

    // A prior manifest-owned registration of this same immutable authority
    // must gain the binding without moving back to the locked legacy bundle.
    const oldConfig = structuredClone(config);
    oldConfig.mcpServers["meta-kim-runtime"].env = {};
    writeFileSync(runtime.claudeConfig, JSON.stringify(oldConfig));
    const manifestPath = path.join(runtime.userHome, ".meta-kim", "install-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const record = manifest.entries.find((entry) => entry.kind === "mcp-server" && entry.mcpServerName === "meta-kim-runtime");
    record.mcpServerFingerprint = mcpDefinitionFingerprint(oldConfig.mcpServers["meta-kim-runtime"]);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    requireSuccess("bind legacy immutable-authority registration", runGlobalSync(candidate.workspace, runtime));
    assert.deepEqual(JSON.parse(readFileSync(runtime.claudeConfig, "utf8")), config);
    assert.equal(treeFingerprint(legacyLayout.bundleDir), legacyFingerprint);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
}

function verifyPackedHistoricalAgentCatalogMigration() {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-packed-agent-migration-"));
  try {
    const candidate = preparePackedCandidate(testRoot);
    const runtime = isolatedRuntime(testRoot, "runtime-home");
    const fixture = historicalClaudeAgentFixture();
    const target = path.join(runtime.claudeHome, "agents", `${fixture.agentId}.md`);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, fixture.historical, "utf8");
    assert.equal(
      existsSync(path.join(runtime.userHome, ".meta-kim", "install-manifest.json")),
      false,
    );

    requireSuccess(
      "catalog-backed packed historical Agent migration",
      runGlobalSyncWithoutDurableMcp(candidate.workspace, runtime),
    );
    assert.equal(readFileSync(target, "utf8"), fixture.current);
    const backupRoot = path.join(runtime.claudeHome, ".meta-kim", "backups", "agent");
    assert.ok(listFilesIfPresent(backupRoot).length > 0);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
}

function verifyConcurrentEditsBlockRollback() {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-runtime-cas-"));
  try {
    const candidate = preparePackedCandidate(testRoot);
    const manifestRuntime = isolatedRuntime(testRoot, "manifest-config-runtime");
    const lateRuntime = isolatedRuntime(testRoot, "late-bundle-runtime");
    requireSuccess("seed manifest/config CAS runtime", runGlobalSync(candidate.workspace, manifestRuntime));
    requireSuccess("seed late/bundle CAS runtime", runGlobalSync(candidate.workspace, lateRuntime));

    const nextManifest = setPackedFixtureVersion(
      candidate.workspace,
      `${ORIGINAL_MANIFEST.version}-runtime-cas-test`,
    );
    const nextIdentity = resolvePortableMetaKimPackageIdentity(nextManifest, DISTRIBUTION);

    const manifestOldRaw = readFileSync(
      path.join(manifestRuntime.userHome, ".meta-kim", "install-manifest.json"),
      "utf8",
    );
    const manifestLayout = resolveDurableMetaKimRuntimeLayout(
      manifestRuntime.userHome,
      nextIdentity,
      nextManifest,
    );
    const configConcurrent = runGlobalSync(candidate.workspace, manifestRuntime, {
      META_KIM_TEST_FAIL_DURABLE_MCP_AT: "manifest",
      META_KIM_TEST_CONCURRENT_DURABLE_MCP_EDIT: "config",
    });
    assert.notEqual(configConcurrent.status, 0);
    assert.match(
      `${configConcurrent.stdout ?? ""}\n${configConcurrent.stderr ?? ""}`,
      /global sync is partial[\s\S]*rollback_incomplete[\s\S]*config changed concurrently/iu,
    );
    const concurrentConfig = JSON.parse(readFileSync(manifestRuntime.claudeConfig, "utf8"));
    assert.equal(concurrentConfig.userConcurrentEdit?.preserve, true);
    assert.equal(
      concurrentConfig.mcpServers["meta-kim-runtime"].args[0],
      manifestLayout.cliPath,
    );
    assert.ok(existsSync(manifestLayout.bundleDir));
    assert.equal(
      readFileSync(path.join(manifestRuntime.userHome, ".meta-kim", "install-manifest.json"), "utf8"),
      manifestOldRaw,
    );

    const lateManifestPath = path.join(lateRuntime.userHome, ".meta-kim", "install-manifest.json");
    const lateOldManifestRaw = readFileSync(lateManifestPath, "utf8");
    const lateLayout = resolveDurableMetaKimRuntimeLayout(
      lateRuntime.userHome,
      nextIdentity,
      nextManifest,
    );
    const bundleConcurrent = runGlobalSync(candidate.workspace, lateRuntime, {
      META_KIM_TEST_FAIL_DURABLE_MCP_AT: "late",
      META_KIM_TEST_CONCURRENT_DURABLE_MCP_EDIT: "bundle",
    });
    assert.notEqual(bundleConcurrent.status, 0);
    assert.match(
      `${bundleConcurrent.stdout ?? ""}\n${bundleConcurrent.stderr ?? ""}`,
      /global sync is partial[\s\S]*rollback_incomplete[\s\S]*bundle changed concurrently/iu,
    );
    assert.equal(
      readFileSync(path.join(lateLayout.bundleDir, "user-concurrent-runtime-file.txt"), "utf8"),
      "preserve concurrent bundle edit\n",
    );
    const lateConfig = JSON.parse(readFileSync(lateRuntime.claudeConfig, "utf8"));
    assert.equal(lateConfig.mcpServers["meta-kim-runtime"].args[0], lateLayout.cliPath);
    assert.notEqual(readFileSync(lateManifestPath, "utf8"), lateOldManifestRaw);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
}

function durableBundleLedger(runtime) {
  const manifest = JSON.parse(
    readFileSync(path.join(runtime.userHome, ".meta-kim", "install-manifest.json"), "utf8"),
  );
  return manifest.entries
    .filter((entry) => String(entry.purpose ?? "").startsWith("claude-global-mcp-runtime-bundle"))
    .map((entry) => `${entry.purpose} ${path.relative(runtime.userHome, entry.path)}`)
    .sort();
}

function expectedDurableBundleLedger(runtime, layouts) {
  return layouts.flatMap((layout) => [
    ["claude-global-mcp-runtime-bundle", layout.bundleDir],
    ["claude-global-mcp-runtime-bundle:package-manifest", layout.packageManifestPath],
    ["claude-global-mcp-runtime-bundle:cli", layout.cliPath],
    ["claude-global-mcp-runtime-bundle:server", layout.serverPath],
  ]).map(([purpose, target]) => `${purpose} ${path.relative(runtime.userHome, target)}`).sort();
}

function verifySupersededDurableBundlesAreRetired() {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-runtime-retire-"));
  try {
    const candidate = preparePackedCandidate(testRoot);
    const runtime = isolatedRuntime(testRoot, "runtime-home");
    const layouts = [];
    const syncVersion = (suffix, extraEnv = {}) => {
      const manifest = setPackedFixtureVersion(
        candidate.workspace,
        suffix ? `${ORIGINAL_MANIFEST.version}-retire-test.${suffix}` : ORIGINAL_MANIFEST.version,
      );
      const layout = resolveDurableMetaKimRuntimeLayout(
        runtime.userHome,
        resolvePortableMetaKimPackageIdentity(manifest, DISTRIBUTION),
        manifest,
        process.execPath,
        "claude",
      );
      if (!layouts.some((known) => known.bundleDir === layout.bundleDir)) layouts.push(layout);
      const result = requireSuccess(
        `packed global sync ${manifest.version}`,
        runGlobalSync(candidate.workspace, runtime, extraEnv),
      );
      assert.deepEqual(
        JSON.parse(readFileSync(runtime.claudeConfig, "utf8")).mcpServers["meta-kim-runtime"],
        layout.definition,
        "the Claude MCP entry must launch the bundle of the version just synced",
      );
      return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    };
    const bundleParent = () => path.dirname(layouts[0].bundleDir);
    const assertBundles = (expected, message) => {
      assert.deepEqual(
        readdirSync(bundleParent()).sort(),
        expected.map((layout) => path.basename(layout.bundleDir)).sort(),
        message,
      );
      assert.deepEqual(
        durableBundleLedger(runtime),
        expectedDurableBundleLedger(runtime, expected),
        `${message} (install manifest)`,
      );
    };

    syncVersion(null);
    const [first] = layouts;
    const firstOutput = syncVersion(1);
    const [, second] = layouts;
    assertBundles([first, second], "the version replaced by the latest update stays as the previous bundle");
    assert.doesNotMatch(firstOutput, /superseded durable MCP bundle/iu);

    const secondOutput = syncVersion(2);
    const [, , third] = layouts;
    assertBundles([second, third], "an update keeps only the current and the previous bundle");
    assert.match(secondOutput, /Removed 1 superseded durable MCP bundle\(s\)/u);

    // A manifest write failure during retirement leaves the committed update
    // and every bundle exactly as they were.
    const secondFingerprint = treeFingerprint(second.bundleDir);
    const failedOutput = syncVersion(3, { META_KIM_TEST_FAIL_DURABLE_MCP_AT: "retire_manifest" });
    const [, , , fourth] = layouts;
    assert.match(failedOutput, /Superseded durable MCP bundles were kept: Injected durable MCP retire_manifest failure/u);
    assertBundles([second, third, fourth], "a failed retirement restores the staged bundle and its manifest entries");
    assert.equal(treeFingerprint(second.bundleDir), secondFingerprint);

    // Bundles that carry a user file, or that the Claude configuration still
    // mentions, are not the installer's to delete.
    const userFile = path.join(second.bundleDir, "user-added-runtime-file.txt");
    writeFileSync(userFile, "preserve\n", "utf8");
    const pinnedConfig = JSON.parse(readFileSync(runtime.claudeConfig, "utf8"));
    pinnedConfig.mcpServers["user-pinned-runtime"] = {
      type: "stdio",
      command: process.execPath,
      args: [third.cliPath, "mcp", "serve"],
    };
    writeFileSync(runtime.claudeConfig, `${JSON.stringify(pinnedConfig, null, 2)}\n`, "utf8");
    const protectedOutput = syncVersion(4);
    const [, , , , fifth] = layouts;
    assertBundles([second, third, fourth, fifth], "user-modified and still-referenced bundles are preserved");
    assert.equal(readFileSync(userFile, "utf8"), "preserve\n");
    assert.match(protectedOutput, /Kept superseded durable MCP bundle\(s\)/u);
    assert.match(protectedOutput, /its contents differ from the recorded install/u);
    assert.match(protectedOutput, /the Claude MCP configuration still refers to it/u);
    assert.doesNotMatch(protectedOutput, /Removed \d+ superseded/u);
    assert.deepEqual(
      JSON.parse(readFileSync(runtime.claudeConfig, "utf8")).mcpServers["user-pinned-runtime"],
      pinnedConfig.mcpServers["user-pinned-runtime"],
    );

    // Once those reasons are gone, a same-version sync retires the backlog
    // that earlier updates left behind. A bundle whose manifest record predates
    // directory closures cannot be proven free of user files, so it stays.
    rmSync(userFile, { force: true });
    const unpinnedConfig = JSON.parse(readFileSync(runtime.claudeConfig, "utf8"));
    delete unpinnedConfig.mcpServers["user-pinned-runtime"];
    writeFileSync(runtime.claudeConfig, `${JSON.stringify(unpinnedConfig, null, 2)}\n`, "utf8");
    const manifestPath = path.join(runtime.userHome, ".meta-kim", "install-manifest.json");
    const legacyManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const legacyRecord = legacyManifest.entries.find((entry) =>
      entry.kind === "dir" && path.resolve(entry.path) === path.resolve(third.bundleDir));
    assert.match(legacyRecord.directoryClosureSha256, /^[a-f0-9]{64}$/u);
    delete legacyRecord.directoryClosureSha256;
    delete legacyRecord.directoryClosureEntryCount;
    writeFileSync(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`, "utf8");
    const backlogOutput = syncVersion(4);
    assertBundles([third, fourth, fifth], "a same-version sync retires the provable backlog only");
    assert.match(backlogOutput, /Removed 1 superseded durable MCP bundle\(s\)/u);
    assert.match(backlogOutput, /the manifest holds no content record for it/u);
    const selfTest = requireSuccess(
      "current durable MCP self-test after retirement",
      run(process.execPath, [fifth.cliPath, "mcp", "self-test"], {
        cwd: runtime.userHome,
        env: runtime.env,
        timeout: 60_000,
      }),
    );
    assert.match(selfTest.stdout, /"ok"\s*:\s*true/u);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
}

function claudeProfileRuntime(userHome, profileName) {
  const claudeHome = path.join(userHome, "profiles", profileName);
  mkdirSync(claudeHome, { recursive: true });
  const env = {
    ...process.env,
    HOME: userHome,
    USERPROFILE: userHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    META_KIM_CLAUDE_HOME: claudeHome,
  };
  delete env.META_KIM_CLAUDE_USER_CONFIG;
  return {
    claudeConfig: path.join(claudeHome, ".claude.json"),
    claudeHome,
    userHome,
    env,
  };
}

function syncPackedVersion(candidate, runtime, runtimeBaseDir, suffix, extraEnv = {}) {
  const manifest = setPackedFixtureVersion(
    candidate.workspace,
    suffix ? `${ORIGINAL_MANIFEST.version}-retire-test.${suffix}` : ORIGINAL_MANIFEST.version,
  );
  const layout = resolveDurableMetaKimRuntimeLayout(
    runtimeBaseDir,
    resolvePortableMetaKimPackageIdentity(manifest, DISTRIBUTION),
    manifest,
    process.execPath,
    "claude",
  );
  const result = requireSuccess(
    `packed global sync ${manifest.version}`,
    runGlobalSync(candidate.workspace, runtime, extraEnv),
  );
  assert.deepEqual(
    JSON.parse(readFileSync(runtime.claudeConfig, "utf8")).mcpServers["meta-kim-runtime"],
    layout.definition,
    "the Claude MCP entry must launch the bundle of the version just synced",
  );
  return { layout, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

function verifySharedStoreKeepsBundlesOtherProfilesReference() {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-runtime-profiles-"));
  try {
    const candidate = preparePackedCandidate(testRoot);
    const userHome = path.join(testRoot, "runtime-home");
    const profileA = claudeProfileRuntime(userHome, "a");
    const profileB = claudeProfileRuntime(userHome, "b");
    // Both profiles share a parent directory, so they share one runtime store
    // while each keeps its own Claude MCP configuration.
    const storeBase = path.join(userHome, "profiles");
    const { layout: pinnedByA } = syncPackedVersion(candidate, profileA, storeBase, null);
    syncPackedVersion(candidate, profileB, storeBase, 1);
    const { output } = syncPackedVersion(candidate, profileB, storeBase, 2);
    assert.ok(
      existsSync(pinnedByA.cliPath),
      `a bundle another profile still launches must stay installed\n${output}`,
    );
    assert.deepEqual(
      JSON.parse(readFileSync(profileA.claudeConfig, "utf8")).mcpServers["meta-kim-runtime"],
      pinnedByA.definition,
    );
    assert.match(output, /the Claude MCP configuration still refers to it/u);
    assert.doesNotMatch(output, /Removed \d+ superseded/u);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
}

function verifyBundleEditedDuringRetirementIsPreserved() {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-runtime-retire-race-"));
  try {
    const candidate = preparePackedCandidate(testRoot);
    const runtime = isolatedRuntime(testRoot, "runtime-home");
    const { layout: first } = syncPackedVersion(candidate, runtime, runtime.userHome, null);
    const { layout: second } = syncPackedVersion(candidate, runtime, runtime.userHome, 1);
    const firstFingerprint = treeFingerprint(first.bundleDir);
    // The hook adds a user file after the closure check and before the rename.
    const { layout: third, output } = syncPackedVersion(candidate, runtime, runtime.userHome, 2, {
      META_KIM_TEST_CONCURRENT_DURABLE_MCP_EDIT: "pre_retire_rename",
    });
    const userFile = path.join(first.bundleDir, "user-concurrent-runtime-file.txt");
    assert.equal(
      existsSync(userFile) && readFileSync(userFile, "utf8"),
      "preserve concurrent bundle edit\n",
      `a file added while the bundle was being retired must survive\n${output}`,
    );
    rmSync(userFile, { force: true });
    assert.equal(treeFingerprint(first.bundleDir), firstFingerprint);
    assert.deepEqual(
      readdirSync(path.dirname(first.bundleDir)).sort(),
      [first, second, third].map((layout) => path.basename(layout.bundleDir)).sort(),
      "no staged retirement directory is left behind",
    );
    assert.deepEqual(
      durableBundleLedger(runtime),
      expectedDurableBundleLedger(runtime, [first, second, third]),
      "the drifted bundle keeps its install manifest records",
    );
    assert.match(output, /its contents changed while it was being retired/u);
    assert.doesNotMatch(output, /Removed \d+ superseded/u);

    // A change that lands after the manifest already forgot the bundle leaves
    // the directory in place as unknown content instead of deleting it.
    const { layout: fourth, output: lateOutput } = syncPackedVersion(
      candidate,
      runtime,
      runtime.userHome,
      3,
      { META_KIM_TEST_CONCURRENT_DURABLE_MCP_EDIT: "pre_retire_delete" },
    );
    for (const layout of [first, second]) {
      assert.equal(
        readFileSync(path.join(layout.bundleDir, "user-concurrent-runtime-file.txt"), "utf8"),
        "preserve concurrent bundle edit\n",
        `a file added after the manifest flush must survive\n${lateOutput}`,
      );
    }
    assert.deepEqual(
      readdirSync(path.dirname(first.bundleDir)).sort(),
      [first, second, third, fourth].map((layout) => path.basename(layout.bundleDir)).sort(),
      "the late-drifted bundles return to their own paths",
    );
    assert.deepEqual(
      durableBundleLedger(runtime),
      expectedDurableBundleLedger(runtime, [third, fourth]),
      "the manifest no longer claims the late-drifted bundles",
    );
    assert.match(lateOutput, /its contents changed while it was being retired; kept at /u);
    assert.doesNotMatch(lateOutput, /Removed \d+ superseded/u);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
}

function verifyUnrestorableDriftedBundleIsForgottenAndKept() {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-runtime-retire-restore-"));
  try {
    const candidate = preparePackedCandidate(testRoot);
    const runtime = isolatedRuntime(testRoot, "runtime-home");
    const { layout: first } = syncPackedVersion(candidate, runtime, runtime.userHome, null);
    const { layout: second } = syncPackedVersion(candidate, runtime, runtime.userHome, 1);
    // The bundle drifts before the rename and the rename back then fails.
    const { layout: third, output } = syncPackedVersion(candidate, runtime, runtime.userHome, 2, {
      META_KIM_TEST_CONCURRENT_DURABLE_MCP_EDIT: "pre_retire_rename",
      META_KIM_TEST_FAIL_DURABLE_MCP_AT: "retire_restore",
    });
    const bundleParent = path.dirname(first.bundleDir);
    const strandedNames = readdirSync(bundleParent)
      .filter((name) => name.startsWith(".meta-kim-runtime-retired-"));
    assert.equal(strandedNames.length, 1, `the drifted bundle stays at its staged path\n${output}`);
    assert.equal(existsSync(first.bundleDir), false);
    assert.equal(
      readFileSync(path.join(bundleParent, strandedNames[0], "user-concurrent-runtime-file.txt"), "utf8"),
      "preserve concurrent bundle edit\n",
      `the file added during retirement must survive\n${output}`,
    );
    assert.deepEqual(
      durableBundleLedger(runtime),
      expectedDurableBundleLedger(runtime, [second, third]),
      "the manifest must not keep claiming a path that no longer exists",
    );
    assert.match(output, /could not be moved back; it is kept at .*; move it back to .* manually/u);
    assert.doesNotMatch(output, /Removed \d+ superseded/u);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
}

test(
  "packed sync materializes an idempotent source-independent durable MCP bundle",
  SERIAL_TEST_OPTIONS,
  verifySuccessfulDurableBundleLifecycle,
);

test(
  "pack, install, rename, manifest, and post-rename verification failures preserve the previous bundle and MCP transaction",
  SERIAL_TEST_OPTIONS,
  verifyDurableBundleRollbackFailures,
);

test(
  "a locked same-version MCP bundle switches future launches to immutable package authority without killing the running bundle",
  SERIAL_TEST_OPTIONS,
  verifyLockedSameVersionBundleUsesImmutableAuthority,
);

test(
  "real tgz without Git metadata migrates an exact catalog-backed historical Agent",
  SERIAL_TEST_OPTIONS,
  verifyPackedHistoricalAgentCatalogMigration,
);

test(
  "manifest and late failures preserve concurrent config or bundle edits instead of rolling them back",
  SERIAL_TEST_OPTIONS,
  verifyConcurrentEditsBlockRollback,
);

test(
  "updates retire superseded durable MCP bundles and keep the current, the previous, user-modified and still-referenced ones",
  SERIAL_TEST_OPTIONS,
  verifySupersededDurableBundlesAreRetired,
);

test(
  "profiles that share a runtime store keep the bundles any of their Claude MCP configurations launch",
  SERIAL_TEST_OPTIONS,
  verifySharedStoreKeepsBundlesOtherProfilesReference,
);

test(
  "a bundle edited between the retirement check and its removal is restored with its manifest records",
  SERIAL_TEST_OPTIONS,
  verifyBundleEditedDuringRetirementIsPreserved,
);

test(
  "a drifted bundle that cannot be moved back is dropped from the manifest and kept in place",
  SERIAL_TEST_OPTIONS,
  verifyUnrestorableDriftedBundleIsForgottenAndKept,
);
