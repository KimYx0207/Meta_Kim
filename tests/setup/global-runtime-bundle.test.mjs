import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
const NPM_CLI_PATH = process.env.npm_execpath ?? path.join(
  path.dirname(process.execPath),
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js",
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
  const packed = requireSuccess("candidate npm pack", run(
    process.execPath,
    [NPM_CLI_PATH, "pack", "--json", "--pack-destination", packDir],
    { cwd: REPO_ROOT },
  ));
  const packResult = JSON.parse(packed.stdout);
  assert.ok(Array.isArray(packResult) && packResult[0]?.filename);
  requireSuccess("candidate tgz extraction", run(
    "tar",
    ["-xf", path.join(packDir, packResult[0].filename), "-C", extractDir],
    { cwd: REPO_ROOT },
  ));
  const workspace = path.join(extractDir, "package");
  assert.ok(existsSync(path.join(workspace, "scripts", "sync-global-meta-theory.mjs")));
  assert.equal(existsSync(path.join(workspace, ".git")), false);
  return { installDir, workspace };
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
    requireSuccess(
      "packed setup runtime launch inventory rebind",
      runRuntimeLaunchRebind(candidate.workspace, runtime),
    );
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

    const candidateManifestPath = path.join(candidate.workspace, "package.json");
    const nextManifest = JSON.parse(readFileSync(candidateManifestPath, "utf8"));
    nextManifest.version = `${ORIGINAL_MANIFEST.version}-runtime-bundle-test`;
    writeFileSync(candidateManifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
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
    nextManifest.version = ORIGINAL_MANIFEST.version;
    writeFileSync(candidateManifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
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

    const candidateManifestPath = path.join(candidate.workspace, "package.json");
    const nextManifest = JSON.parse(readFileSync(candidateManifestPath, "utf8"));
    nextManifest.version = `${ORIGINAL_MANIFEST.version}-runtime-cas-test`;
    writeFileSync(candidateManifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
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
