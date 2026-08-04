import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildDurableMetaKimMcpServer,
  buildPortableMetaKimMcpServer,
  mcpDefinitionFingerprint,
  mergeClaudeUserMcpConfig,
  removeExactManagedMcpFragment,
  resolveDurableMetaKimRuntimeLayout,
  resolvePortableMetaKimPackageIdentity,
} from "../../scripts/global-runtime-mcp.mjs";
import {
  GLOBAL_PROJECTION_OWNER_SYNC_RUNTIMES,
  globalAgentProjectionFileName,
  globalProjectionIsOwnedBy,
  resolveGlobalAgentProjectionTargets,
  resolveRuntimeProfilesFromManifest,
} from "../../scripts/meta-kim-sync-config.mjs";
import {
  canonicalGlobalOnlyProjectionContent,
  canRetireGlobalOnlyProjection,
} from "../../scripts/sync-runtimes.mjs";
import {
  manifestFileEntryMatches,
  readManifest,
} from "../../scripts/install-manifest.mjs";
import { recordSetupRuntimeExecutableBindings } from "../../scripts/runtime-executable-binding.mjs";

const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const PACKAGE_MANIFEST = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
const DISTRIBUTION = JSON.parse(readFileSync(path.join(REPO_ROOT, "config", "distribution.json"), "utf8"));
const SYNC_MANIFEST = JSON.parse(readFileSync(path.join(REPO_ROOT, "config", "sync.json"), "utf8"));
const RUNTIME_PROFILES = resolveRuntimeProfilesFromManifest(SYNC_MANIFEST);
const GLOBAL_AGENT_TARGETS = resolveGlobalAgentProjectionTargets(
  RUNTIME_PROFILES,
  SYNC_MANIFEST.supportedTargets,
);
const GLOBAL_AGENT_TARGET_IDS = GLOBAL_AGENT_TARGETS.map((target) => target.targetId);
const PACKAGE_IDENTITY = resolvePortableMetaKimPackageIdentity(PACKAGE_MANIFEST, DISTRIBUTION);
const LEGACY_MCP_SUFFIX = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "canonical", "runtime-assets", "claude", "mcp.json"), "utf8"),
).mcpServers["meta-kim-runtime"].args[0].replace(/^__REPO_ROOT__[\\/]/u, "");

function runSync(root, args, extraEnv = {}) {
  const runtimeEnv = {};
  for (const profile of Object.values(RUNTIME_PROFILES)) {
    const runtimeHome = path.join(root, profile.activation.defaultHomeDir);
    for (const envKey of profile.activation.envKeys) runtimeEnv[envKey] = runtimeHome;
  }
  if (args.includes("--check")) {
    const targetsArg = args[args.indexOf("--targets") + 1] ?? "";
    const launchTargets = targetsArg
      .split(",")
      .filter((target) => ["claude", "codex"].includes(target));
    if (launchTargets.length > 0) {
      recordSetupRuntimeExecutableBindings({
        roots: [root],
        targets: launchTargets,
        pathResolver: () => process.execPath,
        versionRunner: () => ({ status: 0, stdout: "test-runtime 1.0.0\n", stderr: "" }),
      });
    }
  }
  return spawnSync(process.execPath, ["scripts/sync-global-meta-theory.mjs", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      ...runtimeEnv,
      META_KIM_CLAUDE_USER_CONFIG: path.join(root, ".claude.json"),
      ...extraEnv,
    },
  });
}

function runRuntimeSync(root, args, extraEnv = {}) {
  const runtimeEnv = {};
  for (const profile of Object.values(RUNTIME_PROFILES)) {
    const runtimeHome = path.join(root, profile.activation.defaultHomeDir);
    for (const envKey of profile.activation.envKeys) runtimeEnv[envKey] = runtimeHome;
  }
  return spawnSync(process.execPath, ["scripts/sync-runtimes.mjs", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      ...runtimeEnv,
      ...extraEnv,
    },
  });
}

function syncRuntimeOwnedAssetTypes(targetIds, { withGlobalHooks = true } = {}) {
  const assetTypes = new Set();
  for (const targetId of targetIds) {
    const profile = RUNTIME_PROFILES[targetId];
    for (const assetType of profile.projection.assetTypes) {
      if (assetType === "hooks" && !withGlobalHooks) continue;
      if (
        globalProjectionIsOwnedBy(
          profile,
          assetType,
          GLOBAL_PROJECTION_OWNER_SYNC_RUNTIMES,
        )
      ) {
        assetTypes.add(assetType);
      }
    }
  }
  return [...assetTypes].sort();
}

test("portable MCP strategy contains no machine or repository path", () => {
  assert.equal(PACKAGE_IDENTITY.packageName, PACKAGE_MANIFEST.name);
  assert.equal(PACKAGE_IDENTITY.packageVersion, PACKAGE_MANIFEST.version);
  assert.match(PACKAGE_IDENTITY.packageSpec, new RegExp(`v${PACKAGE_MANIFEST.version.replaceAll(".", "\\.")}$`, "u"));
  assert.deepEqual(buildPortableMetaKimMcpServer(PACKAGE_IDENTITY, "linux"), {
    type: "stdio",
    command: "npx",
    args: ["--yes", PACKAGE_IDENTITY.packageSpec, PACKAGE_IDENTITY.cliName, "mcp", "serve"],
    env: {},
  });
  assert.deepEqual(buildPortableMetaKimMcpServer(PACKAGE_IDENTITY, "win32"), {
    type: "stdio",
    command: "npx.cmd",
    args: ["--yes", PACKAGE_IDENTITY.packageSpec, PACKAGE_IDENTITY.cliName, "mcp", "serve"],
    env: {},
  });
  for (const platform of ["win32", "linux", "darwin"]) {
    const rendered = JSON.stringify(buildPortableMetaKimMcpServer(PACKAGE_IDENTITY, platform));
    assert.doesNotMatch(rendered, /[A-Za-z]:[\\/]|Users[\\/]|__REPO_ROOT__|REPLACE_WITH_REPO_ROOT/);
  }
});

test("MCP merge migrates proven legacy entry and preserves unrelated config", () => {
  const portable = buildDurableMetaKimMcpServer(process.execPath, path.join(path.parse(process.execPath).root, "managed", "meta-kim.mjs"));
  const base = {
    auth: { retained: true },
    mcpServers: {
      user: { command: "user-tool", env: { TOKEN: "preserve" } },
      meta_kim_runtime: {
        command: "node",
        args: ["/old/location/scripts/mcp/meta-runtime-server.mjs"],
      },
    },
  };
  const result = mergeClaudeUserMcpConfig(
    base,
    {
      canonicalName: "meta-kim-runtime",
      portableDefinition: portable,
      identity: PACKAGE_IDENTITY,
      legacyScriptSuffix: LEGACY_MCP_SUFFIX,
    },
  );
  assert.deepEqual(result.collisions, []);
  assert.equal(result.config.auth.retained, true);
  assert.equal(result.config.mcpServers.user.env.TOKEN, "preserve");
  assert.equal(result.config.mcpServers.meta_kim_runtime, undefined);
  assert.deepEqual(result.config.mcpServers["meta-kim-runtime"], portable);

  const wrappedLegacy = mergeClaudeUserMcpConfig({
    mcpServers: {
      meta_kim_runtime: {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", "node", `/retired/${LEGACY_MCP_SUFFIX.replaceAll("\\", "/")}`],
      },
    },
  }, {
    canonicalName: "meta-kim-runtime",
    portableDefinition: portable,
    identity: PACKAGE_IDENTITY,
    legacyScriptSuffix: LEGACY_MCP_SUFFIX,
  });
  assert.deepEqual(wrappedLegacy.collisions, []);
  assert.equal(wrappedLegacy.config.mcpServers.meta_kim_runtime, undefined);
  assert.deepEqual(wrappedLegacy.config.mcpServers["meta-kim-runtime"], portable);

  const absoluteNodeWrappedLegacy = mergeClaudeUserMcpConfig({
    mcpServers: {
      meta_kim_runtime: {
        type: "stdio",
        command: "cmd",
        args: [
          "/c",
          "C:/Program Files/nodejs/node.exe",
          `C:/Users/previous-user/Desktop/Meta_Kim/${LEGACY_MCP_SUFFIX.replaceAll("\\", "/")}`,
        ],
      },
    },
  }, {
    canonicalName: "meta-kim-runtime",
    portableDefinition: portable,
    identity: PACKAGE_IDENTITY,
    legacyScriptSuffix: LEGACY_MCP_SUFFIX,
  });
  assert.deepEqual(absoluteNodeWrappedLegacy.collisions, []);
  assert.equal(absoluteNodeWrappedLegacy.config.mcpServers.meta_kim_runtime, undefined);
  assert.deepEqual(absoluteNodeWrappedLegacy.config.mcpServers["meta-kim-runtime"], portable);

  const wrappedCurrentDefinition = {
    type: portable.type,
    command: "cmd",
    args: ["/c", portable.command, ...portable.args],
    env: {},
  };
  const wrappedCurrent = mergeClaudeUserMcpConfig({
    auth: { retained: true },
    mcpServers: {
      user: { command: "user-tool", env: { TOKEN: "preserve" } },
      "meta-kim-runtime": wrappedCurrentDefinition,
    },
  }, {
    canonicalName: "meta-kim-runtime",
    portableDefinition: portable,
    identity: PACKAGE_IDENTITY,
    legacyScriptSuffix: LEGACY_MCP_SUFFIX,
  });
  assert.deepEqual(wrappedCurrent.collisions, []);
  assert.equal(wrappedCurrent.config.auth.retained, true);
  assert.equal(wrappedCurrent.config.mcpServers.user.env.TOKEN, "preserve");
  assert.equal(wrappedCurrent.canonicalEquivalent, true);
  assert.deepEqual(
    wrappedCurrent.config.mcpServers["meta-kim-runtime"],
    wrappedCurrentDefinition,
  );

  const priorManaged = buildDurableMetaKimMcpServer(
    process.execPath,
    path.join(path.parse(process.execPath).root, "managed", "prior", "meta-kim.mjs"),
  );
  const wrappedPriorManaged = {
    ...priorManaged,
    command: "cmd.exe",
    args: ["/d", "/s", "/c", priorManaged.command, ...priorManaged.args],
  };
  const migratedManagedWrapper = mergeClaudeUserMcpConfig({
    mcpServers: { "meta-kim-runtime": wrappedPriorManaged },
  }, {
    canonicalName: "meta-kim-runtime",
    portableDefinition: portable,
    identity: PACKAGE_IDENTITY,
    legacyScriptSuffix: LEGACY_MCP_SUFFIX,
    managedFingerprints: new Set([mcpDefinitionFingerprint(priorManaged)]),
  });
  assert.deepEqual(migratedManagedWrapper.collisions, []);
  assert.equal(migratedManagedWrapper.canonicalEquivalent, false);
  assert.deepEqual(migratedManagedWrapper.config.mcpServers["meta-kim-runtime"], portable);

  const unownedManagedWrapper = mergeClaudeUserMcpConfig({
    mcpServers: { "meta-kim-runtime": wrappedPriorManaged },
  }, {
    canonicalName: "meta-kim-runtime",
    portableDefinition: portable,
    identity: PACKAGE_IDENTITY,
    legacyScriptSuffix: LEGACY_MCP_SUFFIX,
  });
  assert.deepEqual(unownedManagedWrapper.collisions, ["meta-kim-runtime"]);

  const driftedManagedWrapper = structuredClone(wrappedPriorManaged);
  driftedManagedWrapper.args.push("--user-change");
  const blockedDriftedManagedWrapper = mergeClaudeUserMcpConfig({
    mcpServers: { "meta-kim-runtime": driftedManagedWrapper },
  }, {
    canonicalName: "meta-kim-runtime",
    portableDefinition: portable,
    identity: PACKAGE_IDENTITY,
    legacyScriptSuffix: LEGACY_MCP_SUFFIX,
    managedFingerprints: new Set([mcpDefinitionFingerprint(priorManaged)]),
  });
  assert.deepEqual(blockedDriftedManagedWrapper.collisions, ["meta-kim-runtime"]);

  const fingerprint = mcpDefinitionFingerprint(portable);
  const removed = removeExactManagedMcpFragment(result.config, "meta-kim-runtime", fingerprint);
  assert.equal(removed.removed, true);
  assert.ok(removed.config.mcpServers.user);
  const drifted = structuredClone(result.config);
  drifted.mcpServers["meta-kim-runtime"].args.push("--user-change");
  assert.equal(removeExactManagedMcpFragment(drifted, "meta-kim-runtime", fingerprint).removed, false);
});

test("MCP merge blocks non-plain maps, unknown canonical collisions, and loose legacy lookalikes", () => {
  const portable = buildDurableMetaKimMcpServer(process.execPath, path.join(path.parse(process.execPath).root, "managed", "meta-kim.mjs"));
  const options = {
    canonicalName: "meta-kim-runtime",
    portableDefinition: portable,
    identity: PACKAGE_IDENTITY,
    legacyScriptSuffix: LEGACY_MCP_SUFFIX,
  };
  assert.throws(() => mergeClaudeUserMcpConfig({ mcpServers: [] }, options), /plain JSON object/u);
  assert.deepEqual(
    mergeClaudeUserMcpConfig({ mcpServers: { "meta-kim-runtime": { command: "user-tool" } } }, options).collisions,
    ["meta-kim-runtime"],
  );
  assert.deepEqual(
    mergeClaudeUserMcpConfig({ mcpServers: { meta_kim_runtime: {
      command: "node",
      args: ["--extra", "/old/scripts/mcp/meta-runtime-server.mjs"],
    } } }, options).collisions,
    ["meta_kim_runtime"],
  );
  for (const args of [
    ["/c", "node", `/retired/${LEGACY_MCP_SUFFIX.replaceAll("\\", "/")}`, "&", "calc"],
    ["/c", "node", `/retired/${LEGACY_MCP_SUFFIX.replaceAll("\\", "/")}&calc`],
    ["/c", `node /retired/${LEGACY_MCP_SUFFIX.replaceAll("\\", "/")}`],
  ]) {
    assert.deepEqual(
      mergeClaudeUserMcpConfig({ mcpServers: { meta_kim_runtime: {
        command: "cmd",
        args,
      } } }, options).collisions,
      ["meta_kim_runtime"],
    );
  }
  for (const nodeCommand of [
    "C:/Program Files/nodejs/node.exe&calc.exe",
    "C:/Program Files/nodejs/not-node.exe",
    "relative/path/node.exe",
  ]) {
    assert.deepEqual(
      mergeClaudeUserMcpConfig({ mcpServers: { meta_kim_runtime: {
        command: "cmd",
        args: ["/c", nodeCommand, `/retired/${LEGACY_MCP_SUFFIX.replaceAll("\\", "/")}`],
      } } }, options).collisions,
      ["meta_kim_runtime"],
    );
  }

  for (const args of [
    ["/c", portable.command, ...portable.args, "--extra"],
    ["/c", portable.command, `${portable.args[0]}.user-change`, ...portable.args.slice(1)],
    ["/c", `${portable.command} ${portable.args.join(" ")}`],
  ]) {
    assert.deepEqual(
      mergeClaudeUserMcpConfig({ mcpServers: { "meta-kim-runtime": {
        type: portable.type,
        command: "cmd.exe",
        args,
        env: {},
      } } }, options).collisions,
      ["meta-kim-runtime"],
    );
  }
});

test("global sync derives every supported Agent projection from runtime profiles", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-global-assets-"));
  try {
    assert.equal(
      RUNTIME_PROFILES.cursor.projection.globalAgentProjection.supported,
      true,
    );
    assert.ok(GLOBAL_AGENT_TARGET_IDS.includes("cursor"));
    mkdirSync(path.join(root, ".claude"), { recursive: true });
    const canonicalIds = readdirSync(path.join(REPO_ROOT, "canonical", "agents"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -3))
      .sort();
    const legacyAgentDir = path.join(root, ".claude", "agents");
    mkdirSync(legacyAgentDir, { recursive: true });
    const legacyAgentContent = `---\nname: ${canonicalIds[0]}\n---\nMeta_Kim GOVERNANCE LAYER AGENT legacy projection\n`;
    const legacyAgentPath = path.join(legacyAgentDir, `${canonicalIds[0]}.md`);
    writeFileSync(
      legacyAgentPath,
      legacyAgentContent,
    );
    mkdirSync(path.join(root, ".meta-kim"), { recursive: true });
    writeFileSync(path.join(root, ".meta-kim", "install-manifest.json"), `${JSON.stringify({
      schemaVersion: 1,
      scope: "global",
      metaKimVersion: PACKAGE_MANIFEST.version,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      entries: [{
        path: legacyAgentPath,
        category: "A",
        source: "sync-global-meta-theory",
        purpose: `claude-global-agent:${canonicalIds[0]}`,
        kind: "file",
        size: Buffer.byteLength(legacyAgentContent),
        sha256: createHash("sha256").update(legacyAgentContent).digest("hex"),
        installedAt: new Date().toISOString(),
      }],
    }, null, 2)}\n`);
    writeFileSync(path.join(root, ".claude.json"), `${JSON.stringify({
      keep: true,
      mcpServers: {
        user: { command: "user-tool", env: { AUTH: "preserve" } },
        meta_kim_runtime: { command: "node", args: ["C:/old/scripts/mcp/meta-runtime-server.mjs"] },
      },
    })}\n`);
    const first = runSync(root, ["--targets", GLOBAL_AGENT_TARGET_IDS.join(",")]);
    assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);

    for (const target of GLOBAL_AGENT_TARGETS) {
      const agentDir = path.join(
        root,
        RUNTIME_PROFILES[target.targetId].activation.defaultHomeDir,
        target.agentsDir,
      );
      assert.deepEqual(
        readdirSync(agentDir)
          .filter((name) => name.endsWith(target.fileExtension))
          .map((name) => name.slice(0, -target.fileExtension.length))
          .sort(),
        canonicalIds,
        `${target.targetId} must project every canonical Agent declared by its runtime profile`,
      );
      assert.ok(
        readFileSync(
          path.join(
            agentDir,
            globalAgentProjectionFileName(target, canonicalIds[0]),
          ),
          "utf8",
        ).length > 0,
      );
    }
    const agentBackupRoot = path.join(root, ".claude", ".meta-kim", "backups", "agent");
    assert.ok(readdirSync(agentBackupRoot).length > 0);
    const config = JSON.parse(readFileSync(path.join(root, ".claude.json"), "utf8"));
    assert.equal(config.keep, true);
    assert.equal(config.mcpServers.user.env.AUTH, "preserve");
    assert.equal(config.mcpServers.meta_kim_runtime, undefined);
    const managed = config.mcpServers["meta-kim-runtime"];
    assert.ok(managed);
    const layout = resolveDurableMetaKimRuntimeLayout(root, PACKAGE_IDENTITY, PACKAGE_MANIFEST);
    assert.deepEqual(managed, layout.definition);
    assert.ok(readFileSync(layout.packageManifestPath, "utf8"));
    const selfTest = spawnSync(process.execPath, [layout.cliPath, "mcp", "self-test"], {
      cwd: layout.packageRoot,
      encoding: "utf8",
    });
    assert.equal(selfTest.status, 0, selfTest.stderr);
    assert.match(selfTest.stdout, /"ok":\s*true/u);

    const check = runSync(root, [
      "--check",
      "--targets",
      GLOBAL_AGENT_TARGET_IDS.join(","),
    ]);
    assert.equal(check.status, 0, `${check.stderr}\n${check.stdout}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("global writers have profile-owned disjoint write sets and preserve unselected target records", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-global-owner-ledger-"));
  try {
    const targetIds = [...SYNC_MANIFEST.supportedTargets];
    const globalSync = runSync(root, ["--targets", targetIds.join(",")]);
    assert.equal(globalSync.status, 0, `${globalSync.stderr}\n${globalSync.stdout}`);
    const manifestPath = path.join(root, ".meta-kim", "install-manifest.json");
    const beforeRuntimeSync = readManifest(manifestPath);
    assert.ok(beforeRuntimeSync);
    const syncGlobalPaths = new Set(
      beforeRuntimeSync.entries
        .filter((entry) => entry.source === "sync-global-meta-theory")
        .map((entry) => path.resolve(entry.path)),
    );
    assert.ok(syncGlobalPaths.size > 0);

    const globalAssets = syncRuntimeOwnedAssetTypes(targetIds);
    const runtimeSync = runRuntimeSync(root, [
      "--scope",
      "global",
      "--targets",
      targetIds.join(","),
      "--global-assets",
      globalAssets.join(","),
    ]);
    assert.equal(runtimeSync.status, 0, `${runtimeSync.stderr}\n${runtimeSync.stdout}`);

    const afterRuntimeSync = readManifest(manifestPath);
    assert.ok(afterRuntimeSync);
    const runtimeEntries = afterRuntimeSync.entries.filter(
      (entry) => entry.source === "sync-runtimes",
    );
    assert.ok(runtimeEntries.length > 0);
    for (const targetId of targetIds) {
      assert.equal(
        runtimeEntries.some((entry) => entry.runtimeTarget === targetId),
        true,
        `${targetId} must retain at least one sync-runtimes-owned global projection`,
      );
    }
    assert.equal(
      runtimeEntries.every(
        (entry) =>
          entry.ownershipClass === "install_projection" &&
          manifestFileEntryMatches(entry),
      ),
      true,
      "every sync-runtimes file record must carry current hash and size truth",
    );
    const runtimePaths = new Set(runtimeEntries.map((entry) => path.resolve(entry.path)));
    assert.deepEqual(
      [...runtimePaths].filter((entryPath) => syncGlobalPaths.has(entryPath)),
      [],
      "sync-global-meta-theory and sync-runtimes must not own the same global path",
    );
    for (const entryPath of syncGlobalPaths) {
      assert.equal(
        afterRuntimeSync.entries.some(
          (entry) =>
            entry.source === "sync-global-meta-theory" &&
            path.resolve(entry.path) === entryPath,
        ),
        true,
        "sync-runtimes merge must preserve sync-global-meta-theory records",
      );
    }
    assert.equal(
      runtimeEntries.some((entry) =>
        /[\\/]agents[\\/]/u.test(entry.path),
      ),
      false,
      "profile-owned global Agent projections must never be re-owned by sync-runtimes",
    );

    const openclawRecord = runtimeEntries.find(
      (entry) => entry.runtimeTarget === "openclaw",
    );
    assert.ok(openclawRecord);
    const cursorAssets = syncRuntimeOwnedAssetTypes(["cursor"]);
    const cursorOnly = runRuntimeSync(root, [
      "--scope",
      "global",
      "--targets",
      "cursor",
      "--global-assets",
      cursorAssets.join(","),
    ]);
    assert.equal(cursorOnly.status, 0, `${cursorOnly.stderr}\n${cursorOnly.stdout}`);
    assert.equal(
      readManifest(manifestPath).entries.some(
        (entry) =>
          entry.path === openclawRecord.path &&
          entry.purpose === openclawRecord.purpose,
      ),
      true,
      "a selected-target sync must retain other runtime ownership records",
    );

    const rawBeforeCheck = readFileSync(manifestPath, "utf8");
    const check = runRuntimeSync(root, [
      "--check",
      "--scope",
      "global",
      "--targets",
      targetIds.join(","),
      "--global-assets",
      globalAssets.join(","),
    ]);
    assert.equal(check.status, 0, `${check.stderr}\n${check.stdout}`);
    assert.equal(readFileSync(manifestPath, "utf8"), rawBeforeCheck);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("global runtime projection reports partial failure when ownership persistence fails", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-global-owner-failure-"));
  try {
    const targetIds = [...SYNC_MANIFEST.supportedTargets];
    const globalAssets = syncRuntimeOwnedAssetTypes(targetIds);
    const result = runRuntimeSync(
      root,
      [
        "--scope",
        "global",
        "--targets",
        targetIds.join(","),
        "--global-assets",
        globalAssets.join(","),
      ],
      { META_KIM_TEST_FAIL_SYNC_RUNTIMES_MANIFEST: "1" },
    );
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /partial.*install manifest/is);
    assert.equal(
      readManifest(path.join(root, ".meta-kim", "install-manifest.json")),
      null,
    );
    assert.equal(
      readdirSync(root).some((name) => name.endsWith(".lock")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("global agent collision is preserved and blocks sync", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-global-agent-collision-"));
  try {
    const agentDir = path.join(root, ".claude", "agents");
    mkdirSync(agentDir, { recursive: true });
    const canonicalName = readdirSync(path.join(REPO_ROOT, "canonical", "agents"))
      .find((name) => name.endsWith(".md"));
    const target = path.join(agentDir, canonicalName);
    writeFileSync(target, "Meta_Kim GOVERNANCE LAYER AGENT but user owned\n");
    const result = runSync(root, ["--targets", "claude"]);
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(target, "utf8"), "Meta_Kim GOVERNANCE LAYER AGENT but user owned\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hook check ignores event key order while retaining strict hook array order", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-global-hook-order-"));
  try {
    const sync = runSync(root, ["--targets", "claude", "--with-global-hooks"]);
    assert.equal(sync.status, 0, `${sync.stderr}\n${sync.stdout}`);
    const settingsPath = path.join(root, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    settings.hooks = Object.fromEntries(Object.entries(settings.hooks).reverse());
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    const reordered = runSync(root, ["--check", "--targets", "claude", "--with-global-hooks"]);
    assert.equal(reordered.status, 0, `${reordered.stderr}\n${reordered.stdout}`);

    settings.hooks.Stop[0].hooks.reverse();
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    const hookOrderChanged = runSync(root, ["--check", "--targets", "claude", "--with-global-hooks"]);
    assert.notEqual(hookOrderChanged.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex hook check ignores object key order while retaining strict array order", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-codex-hook-order-"));
  try {
    const sync = runSync(root, ["--targets", "codex", "--with-global-hooks"]);
    assert.equal(sync.status, 0, `${sync.stderr}\n${sync.stdout}`);
    const hooksPath = path.join(root, ".codex", "hooks.json");
    const config = JSON.parse(readFileSync(hooksPath, "utf8"));
    config.hooks = Object.fromEntries(Object.entries(config.hooks).reverse());
    writeFileSync(hooksPath, `${JSON.stringify(config, null, 2)}\n`);
    const reordered = runSync(root, ["--check", "--targets", "codex", "--with-global-hooks"]);
    assert.equal(reordered.status, 0, `${reordered.stderr}\n${reordered.stdout}`);

    const arrays = [];
    const collectArrays = (value) => {
      if (Array.isArray(value)) {
        if (value.length > 1) arrays.push(value);
        value.forEach(collectArrays);
      } else if (value && typeof value === "object") {
        Object.values(value).forEach(collectArrays);
      }
    };
    collectArrays(config.hooks);
    const ordered = arrays.find((items) => JSON.stringify(items) !== JSON.stringify([...items].reverse()));
    assert.ok(ordered, "Codex Hook fixture needs a non-symmetric multi-item array");
    ordered.reverse();
    writeFileSync(hooksPath, `${JSON.stringify(config, null, 2)}\n`);
    const hookOrderChanged = runSync(root, ["--check", "--targets", "codex", "--with-global-hooks"]);
    assert.notEqual(hookOrderChanged.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI MCP self-test routes through the package-local server", () => {
  const result = spawnSync(process.execPath, ["bin/meta-kim.mjs", "mcp", "self-test"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"ok":\s*true/);
});

test("global-only retirement accepts either exact manifest ownership or exact current canonical bytes", () => {
  assert.equal(canRetireGlobalOnlyProjection({
    manifestMatches: true,
    actualContent: "historical generated bytes",
    expectedContent: null,
  }), true);
  assert.equal(canRetireGlobalOnlyProjection({
    manifestMatches: false,
    actualContent: "current canonical bytes",
    expectedContent: "current canonical bytes",
  }), true);
  assert.equal(canRetireGlobalOnlyProjection({
    manifestMatches: false,
    actualContent: "user drift",
    expectedContent: "current canonical bytes",
  }), false);
});

test("global-only canonical retirement mapping follows runtime profiles instead of runtime names", async () => {
  const agent = {
    id: "meta-future",
    raw: "future runtime canonical Agent bytes\n",
  };
  const profiles = {
    "future-runtime": {
      projection: {
        outputPaths: {
          agentsDir: ".future-runtime/governance-agents",
          capabilityIndexDir: ".future-runtime/capability-map",
        },
        globalAgentProjection: {
          supported: true,
          renderer: "canonical_markdown",
          fileExtension: ".future",
        },
      },
    },
  };
  const expected = await canonicalGlobalOnlyProjectionContent(
    path.join(REPO_ROOT, ".future-runtime", "governance-agents", "meta-future.future"),
    [agent],
    { rootDir: REPO_ROOT, profiles },
  );
  assert.equal(expected, agent.raw);
  assert.equal(
    await canonicalGlobalOnlyProjectionContent(
      path.join(REPO_ROOT, ".future-runtime", "capability-map", "meta-kim-capabilities.json"),
      [agent],
      { rootDir: REPO_ROOT, profiles },
    ),
    readFileSync(
      path.join(REPO_ROOT, "config", "capability-index", "meta-kim-capabilities.json"),
      "utf8",
    ),
  );
  assert.equal(
    await canonicalGlobalOnlyProjectionContent(
      path.join(REPO_ROOT, ".future-runtime", "governance-agents", "unknown.future"),
      [agent],
      { rootDir: REPO_ROOT, profiles },
    ),
    null,
  );
});
