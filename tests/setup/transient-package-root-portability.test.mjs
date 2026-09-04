import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  runGlobalProjectionPackageChild,
  verifyGlobalProjectionPackage,
} from "../../scripts/global-projection-package-store.mjs";
import { recordSetupRuntimeExecutableBindings } from "../../scripts/runtime-executable-binding.mjs";
import { tarExtractCommand } from "../../scripts/tar-extract-command.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const PACKAGE_MANIFEST = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
);
const COMMAND_NAMES = [
  "meta-theory-report.md",
  "meta-theory-verify.md",
  "meta-theory.md",
];
const HOOK_NAMES = [...new Set(
  ["shared", "claude"].flatMap((runtime) => readdirSync(
    path.join(REPO_ROOT, "canonical", "runtime-assets", runtime, "hooks"),
    { withFileTypes: true },
  )
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .map((entry) => entry.name)),
)].sort();
const STORE_PURPOSE = "primary-runtime-global-projection-package-runtime-bundle";
const RECEIPT_SCHEMA = "meta-kim-global-projection-package-v1";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeForSearch(value) {
  const normalized = String(value).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function assertSuccessful(result, label) {
  assert.equal(
    result.error,
    undefined,
    `${label} could not start: ${result.error?.stack ?? result.error}`,
  );
  assert.equal(
    result.status,
    0,
    `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function resolveNpmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);
  const resolved = candidates.find((candidate) => path.isAbsolute(candidate) && existsSync(candidate));
  assert.ok(resolved, `Unable to locate npm-cli.js; checked:\n${candidates.join("\n")}`);
  return resolved;
}

function deleteEnvironmentKeysCaseInsensitive(env, keys) {
  const blocked = new Set(keys.map((key) => key.toLowerCase()));
  for (const key of Object.keys(env)) {
    if (blocked.has(key.toLowerCase())) delete env[key];
  }
  return env;
}

function isolatedEnvironment(layout) {
  const env = {
    ...process.env,
    HOME: layout.home,
    USERPROFILE: layout.home,
    APPDATA: path.join(layout.home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(layout.home, "AppData", "Local"),
    XDG_CACHE_HOME: path.join(layout.home, ".cache"),
    XDG_CONFIG_HOME: path.join(layout.home, ".config"),
    XDG_DATA_HOME: path.join(layout.home, ".local", "share"),
    TMP: layout.temp,
    TEMP: layout.temp,
    TMPDIR: layout.temp,
    CLAUDE_CONFIG_DIR: layout.claudeHome,
    CLAUDE_HOME: layout.claudeHome,
    META_KIM_CLAUDE_HOME: layout.claudeHome,
    META_KIM_CLAUDE_USER_CONFIG: layout.claudeUserConfig,
    CODEX_HOME: layout.codexHome,
    META_KIM_CODEX_HOME: layout.codexHome,
    NPM_CONFIG_CACHE: layout.npmCache,
    npm_config_cache: layout.npmCache,
    NPM_CONFIG_PREFIX: layout.npmPrefix,
    npm_config_prefix: layout.npmPrefix,
    NPM_CONFIG_USERCONFIG: layout.npmUserConfig,
    npm_config_userconfig: layout.npmUserConfig,
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_OFFLINE: "true",
    npm_config_offline: "true",
    NO_COLOR: "1",
    META_KIM_WITH_GLOBAL_HOOKS: "1",
  };
  deleteEnvironmentKeysCaseInsensitive(env, [
    "META_KIM_REPO_ROOT",
    "CLAUDE_PROJECT_DIR",
    "INIT_CWD",
    "META_KIM_PACKAGE_ROOT",
    "NODE_OPTIONS",
    "npm_execpath",
    "npm_node_execpath",
    "npm_config_globalconfig",
    "NPM_CONFIG_GLOBALCONFIG",
  ]);
  if (process.platform === "win32") {
    // Windows environment lookup is case-insensitive. Keep the mixed-case key
    // so the transient parent resolves correctly while proving the stable
    // child strips every case variant before it renders durable projections.
    env.MeTa_KiM_RePo_RoOt = layout.origin;
  } else {
    env.META_KIM_REPO_ROOT = layout.origin;
    env.MeTa_KiM_RePo_RoOt = layout.poisonedRepoRoot;
  }
  return env;
}

function makeLayout(root) {
  const home = path.join(root, "user-home");
  const npmCache = path.join(root, "custom-cache");
  return {
    root,
    home,
    claudeHome: path.join(home, ".claude"),
    codexHome: path.join(home, ".codex"),
    claudeUserConfig: path.join(home, ".claude.json"),
    npmCache,
    npmPrefix: path.join(root, "npm-prefix"),
    npmUserConfig: path.join(root, "isolated.npmrc"),
    temp: path.join(root, "temp"),
    cwd: path.join(root, "ordinary-cwd"),
    pack: path.join(root, "pack"),
    extract: path.join(root, "extract"),
    poisonedRepoRoot: path.join(root, "poisoned-mixed-case-repo-root"),
    origin: path.join(
      npmCache,
      "_npx",
      "p138-transient-candidate",
      "node_modules",
      PACKAGE_MANIFEST.name,
    ),
  };
}

function seedUserOwnedRuntimeState(layout) {
  const userHook = path.join(layout.home, "user-owned-hook.mjs");
  const userCommand = "user-owned-command-content\n";
  const claudeUserConfig = `${JSON.stringify({
    userOwned: { preserve: true },
    mcpServers: { user: { command: "user-owned-mcp" } },
  }, null, 2)}\n`;
  writeFileSync(userHook, "process.exit(0);\n", "utf8");
  writeFileSync(layout.claudeUserConfig, claudeUserConfig, "utf8");

  for (const runtimeHome of [layout.claudeHome, layout.codexHome]) {
    const commands = path.join(runtimeHome, "commands");
    mkdirSync(commands, { recursive: true });
    writeFileSync(path.join(commands, "user-owned.md"), userCommand, "utf8");
  }

  const userHookCommand = `\"${process.execPath}\" \"${userHook}\"`;
  writeFileSync(
    path.join(layout.claudeHome, "settings.json"),
    `${JSON.stringify({
      userOwned: { preserve: true },
      hooks: {
        UserPromptSubmit: [{
          matcher: "user-only",
          hooks: [{ type: "command", command: userHookCommand }],
        }],
      },
    }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(layout.codexHome, "hooks.json"),
    `${JSON.stringify({
      userOwned: { preserve: true },
      hooks: {
        Stop: [{
          matcher: "user-only",
          hooks: [{ type: "command", command: userHookCommand }],
        }],
      },
    }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(layout.codexHome, "config.toml"),
    "[user_owned]\npreserve = true\n",
    "utf8",
  );
  writeFileSync(path.join(layout.cwd, "user-owned.txt"), "ordinary cwd sentinel\n", "utf8");
  return { userCommand, userHookCommand, claudeUserConfig };
}

function packCandidate(layout, env) {
  const result = spawnSync(
    process.execPath,
    [
      resolveNpmCliPath(),
      "pack",
      REPO_ROOT,
      "--ignore-scripts",
      "--pack-destination",
      layout.pack,
    ],
    {
      cwd: layout.cwd,
      env,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  assertSuccessful(result, "isolated npm pack");
  const archives = readdirSync(layout.pack).filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 1, `expected one candidate archive, found ${archives.length}`);
  const archive = path.join(layout.pack, archives[0]);
  const extraction = tarExtractCommand(archive, layout.extract);
  const extract = spawnSync(extraction.command, extraction.args, {
    cwd: extraction.cwd,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  assertSuccessful(extract, "candidate tar extraction");
  mkdirSync(path.dirname(layout.origin), { recursive: true });
  renameSync(path.join(layout.extract, "package"), layout.origin);

  // A real npx install provides dependencies next to/under the package. The
  // junction is only fixture plumbing: production still sees the packed
  // candidate at the real _npx/<id>/node_modules/meta-kim path.
  symlinkSync(
    path.join(REPO_ROOT, "node_modules"),
    path.join(layout.origin, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  mkdirSync(path.join(layout.origin, ".git"), { recursive: true });
  writeFileSync(path.join(layout.origin, ".git", "cache-origin-sentinel"), "not a checkout\n");

  // This regression is intentionally network-free. The global sync/check
  // route exercised here uses Node built-ins and package-internal modules; the
  // full production dependency closure is covered by the packed acceptance
  // suite. Removing dependency declarations prevents an empty isolated npm
  // content cache from turning this portability test into a registry test.
  const fixtureManifestPath = path.join(layout.origin, "package.json");
  const fixtureManifest = JSON.parse(readFileSync(fixtureManifestPath, "utf8"));
  fixtureManifest.dependencies = {};
  writeFileSync(fixtureManifestPath, `${JSON.stringify(fixtureManifest, null, 2)}\n`, "utf8");
  return archive;
}

function runGlobalSync(scriptPath, layout, env, extraArgs = []) {
  return runGlobalSyncArgs(scriptPath, layout, env, [
    ...extraArgs,
    "--targets",
    "claude,codex",
    "--with-global-hooks",
    "--skip-durable-mcp",
  ]);
}

function runGlobalSyncArgs(scriptPath, layout, env, args) {
  return spawnSync(
    process.execPath,
    [scriptPath, ...args],
    {
      cwd: layout.cwd,
      env,
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
}

function prepareLayout(layout) {
  for (const directory of [
    layout.home,
    layout.claudeHome,
    layout.codexHome,
    layout.npmCache,
    layout.npmPrefix,
    layout.temp,
    layout.cwd,
    layout.pack,
    layout.extract,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(layout.npmUserConfig, "audit=false\nfund=false\noffline=true\n", "utf8");
}

function snapshotTree(root) {
  const snapshot = {};
  const walk = (current, relative = "") => {
    for (const name of readdirSync(current).sort()) {
      const absolute = path.join(current, name);
      const childRelative = path.posix.join(...relative.split(path.sep).filter(Boolean), name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        snapshot[childRelative] = { kind: "symlink", target: readlinkSync(absolute) };
      } else if (stat.isDirectory()) {
        snapshot[childRelative] = { kind: "dir" };
        walk(absolute, path.join(relative, name));
      } else if (stat.isFile()) {
        snapshot[childRelative] = { kind: "file", ...fileProof(absolute) };
      }
    }
  };
  walk(root);
  return snapshot;
}

function readGlobalManifest(layout) {
  const manifestPath = path.join(layout.home, ".meta-kim", "install-manifest.json");
  assert.equal(existsSync(manifestPath), true, "global manifest must exist");
  return { manifestPath, manifest: JSON.parse(readFileSync(manifestPath, "utf8")) };
}

function countClosureEntries(directoryPath) {
  let count = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      count += 1;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(path.join(current, entry.name));
      }
    }
  };
  walk(directoryPath);
  return count;
}

function projectionStoreFromManifest(layout) {
  const { manifestPath, manifest } = readGlobalManifest(layout);
  const entryFor = (purpose) => manifest.entries.find(
    (entry) => entry.source === "sync-global-meta-theory" && entry.purpose === purpose,
  );
  const bundleEntry = entryFor(STORE_PURPOSE);
  const receiptEntry = entryFor(`${STORE_PURPOSE}:receipt`);
  const packageEntry = entryFor(`${STORE_PURPOSE}:package-manifest`);
  const cliEntry = entryFor(`${STORE_PURPOSE}:cli`);
  const syncEntry = entryFor(`${STORE_PURPOSE}:sync-script`);
  for (const [label, entry] of Object.entries({
    bundleEntry,
    receiptEntry,
    packageEntry,
    cliEntry,
    syncEntry,
  })) {
    assert.ok(entry, `global manifest is missing ${label}`);
  }

  const receipt = JSON.parse(readFileSync(receiptEntry.path, "utf8"));
  assert.equal(receipt.schemaVersion, RECEIPT_SCHEMA);
  assert.equal(receipt.packageName, PACKAGE_MANIFEST.name);
  assert.equal(receipt.packageVersion, PACKAGE_MANIFEST.version);
  assert.match(receipt.packageTarballSha256, /^[a-f0-9]{64}$/u);
  assert.equal(receipt.bundleRelativePath, "bundle");
  assert.ok(Array.isArray(receipt.firstPartyFiles));
  assert.ok(receipt.firstPartyFiles.length > 0);
  assert.match(receipt.firstPartyClosure?.sha256, /^[a-f0-9]{64}$/u);
  assert.ok(receipt.firstPartyClosure?.entryCount > 0);
  assert.equal(typeof receipt.packageRootRelative, "string");
  assert.ok(receipt.packageRootRelative.length > 0);
  assert.ok(receipt.bundleClosure && typeof receipt.bundleClosure === "object");
  assert.ok(receipt.keyFiles && typeof receipt.keyFiles === "object");

  const receiptDir = path.dirname(receiptEntry.path);
  const packageRoot = path.resolve(receiptDir, receipt.packageRootRelative);
  const normalizedReceiptPath = normalizeForSearch(receiptEntry.path);
  assert.ok(
    normalizedReceiptPath.includes(`/${PACKAGE_MANIFEST.version}/${receipt.packageTarballSha256}/`),
    "stable projection package path must be keyed by exact version and tgz digest",
  );
  assert.equal(path.resolve(packageEntry.path), path.join(packageRoot, "package.json"));
  assert.equal(path.resolve(syncEntry.path), path.join(packageRoot, "scripts", "sync-global-meta-theory.mjs"));
  assert.equal(path.resolve(bundleEntry.path), receiptDir);
  assert.equal(existsSync(cliEntry.path), true);
  assert.equal(existsSync(packageRoot), true);
  assert.match(receipt.bundleClosure.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(
    receipt.bundleClosure.entryCount,
    countClosureEntries(path.join(receiptDir, receipt.bundleRelativePath)),
    "receipt bundle closure must describe the complete on-disk bundle",
  );
  assert.match(bundleEntry.directoryClosureSha256, /^[a-f0-9]{64}$/u);
  assert.equal(
    bundleEntry.directoryClosureEntryCount,
    countClosureEntries(receiptDir),
    "manifest closure must describe the complete version+digest directory",
  );
  assert.deepEqual(
    readdirSync(path.dirname(receiptDir)).filter((name) => !name.startsWith(".projection-package-staged-")),
    [receipt.packageTarballSha256],
    "a repeated sync must reuse the same digest directory",
  );
  for (const [key, expectedPath] of Object.entries({
    packageManifest: packageEntry.path,
    publicCli: cliEntry.path,
    globalSyncScript: syncEntry.path,
  })) {
    const recorded = receipt.keyFiles[key];
    assert.ok(recorded, `receipt is missing keyFiles.${key}`);
    const filePath = path.resolve(receiptDir, recorded.relativePath);
    assert.equal(filePath, path.resolve(expectedPath));
    assert.deepEqual(fileProof(filePath), {
      size: recorded.size,
      sha256: recorded.sha256,
    });
  }

  return {
    manifestPath,
    manifest,
    bundleEntry,
    receiptEntry,
    receipt,
    packageRoot,
    syncScript: syncEntry.path,
  };
}

function fileProof(filePath) {
  const bytes = readFileSync(filePath);
  return { size: bytes.byteLength, sha256: sha256(bytes) };
}

function projectionProof(layout, store) {
  const files = [
    store.receiptEntry.path,
    store.syncScript,
    path.join(store.packageRoot, "package.json"),
    path.join(layout.claudeHome, "settings.json"),
    path.join(layout.codexHome, "hooks.json"),
    path.join(layout.codexHome, "config.toml"),
    ...COMMAND_NAMES.flatMap((name) => [
      path.join(layout.claudeHome, "commands", name),
      path.join(layout.codexHome, "commands", name),
    ]),
    ...HOOK_NAMES.flatMap((name) => [
      path.join(layout.claudeHome, "hooks", "meta-kim", name),
      path.join(layout.codexHome, "hooks", "meta-kim", name),
    ]),
  ];
  return Object.fromEntries(
    files.sort().map((filePath) => [normalizeForSearch(filePath), fileProof(filePath)]),
  );
}

function assertManifestFileIntegrity(manifest) {
  const fileEntries = manifest.entries.filter((entry) => entry.kind === "file");
  assert.ok(fileEntries.length > 0, "manifest must own file projections");
  for (const entry of fileEntries) {
    assert.equal(existsSync(entry.path), true, `manifest file is missing: ${entry.path}`);
    const proof = fileProof(entry.path);
    assert.equal(entry.size, proof.size, `manifest size mismatch: ${entry.path}`);
    assert.equal(entry.sha256, proof.sha256, `manifest sha256 mismatch: ${entry.path}`);
  }
}

function referencedAbsolutePaths(text) {
  const paths = new Set();
  const quotedFile = /["']((?:[A-Za-z]:[\\/]|\/)[^"'\r\n]+?\.(?:mjs|js))["']/gu;
  const packageRoot = /--package-root\s+(?:"([^"]+)"|'([^']+)'|([^\s"']+))/gu;
  for (const match of text.matchAll(quotedFile)) paths.add(match[1]);
  for (const match of text.matchAll(packageRoot)) paths.add(match[1] ?? match[2] ?? match[3]);
  return [...paths];
}

function assertNoTransientReferences(textByLabel, layout, stablePackageRoot) {
  const forbidden = [
    layout.origin,
    layout.npmCache,
    layout.poisonedRepoRoot,
    REPO_ROOT,
  ].map(normalizeForSearch);
  const stable = normalizeForSearch(stablePackageRoot);
  let stableReferenceCount = 0;
  let absoluteReferenceCount = 0;
  for (const [label, text] of Object.entries(textByLabel)) {
    const normalized = normalizeForSearch(text);
    for (const forbiddenRoot of forbidden) {
      assert.equal(
        normalized.includes(forbiddenRoot),
        false,
        `${label} persisted transient package/cache root ${forbiddenRoot}`,
      );
    }
    if (normalized.includes(stable)) stableReferenceCount += 1;
    for (const referencedPath of referencedAbsolutePaths(text)) {
      absoluteReferenceCount += 1;
      assert.equal(
        existsSync(referencedPath),
        true,
        `${label} references missing absolute executable/package root: ${referencedPath}`,
      );
    }
  }
  assert.ok(stableReferenceCount >= 6, "runtime projections must reference the stable package root");
  assert.ok(absoluteReferenceCount > 0, "runtime projections must expose absolute executable references");
}

function readBackRuntimeState(layout, store, userState) {
  const textByLabel = {
    manifest: readFileSync(store.manifestPath, "utf8"),
    receipt: readFileSync(store.receiptEntry.path, "utf8"),
    "claude-user-config": readFileSync(layout.claudeUserConfig, "utf8"),
    "claude-settings": readFileSync(path.join(layout.claudeHome, "settings.json"), "utf8"),
    "codex-hooks": readFileSync(path.join(layout.codexHome, "hooks.json"), "utf8"),
    "codex-config": readFileSync(path.join(layout.codexHome, "config.toml"), "utf8"),
  };
  for (const runtime of ["claude", "codex"]) {
    const runtimeHome = runtime === "claude" ? layout.claudeHome : layout.codexHome;
    for (const name of COMMAND_NAMES) {
      textByLabel[`${runtime}-command:${name}`] = readFileSync(
        path.join(runtimeHome, "commands", name),
        "utf8",
      );
    }
    const hookDir = path.join(runtimeHome, "hooks", "meta-kim");
    for (const name of HOOK_NAMES) {
      textByLabel[`${runtime}-hook:${name}`] = readFileSync(path.join(hookDir, name), "utf8");
    }
    assert.equal(
      readFileSync(path.join(runtimeHome, "commands", "user-owned.md"), "utf8"),
      userState.userCommand,
      `${runtime} user command must be preserved byte-for-byte`,
    );
  }

  const claudeSettings = JSON.parse(textByLabel["claude-settings"]);
  const codexHooks = JSON.parse(textByLabel["codex-hooks"]);
  assert.equal(textByLabel["claude-user-config"], userState.claudeUserConfig);
  assert.equal(claudeSettings.userOwned?.preserve, true);
  assert.equal(codexHooks.userOwned?.preserve, true);
  assert.ok(
    claudeSettings.hooks?.UserPromptSubmit?.some(
      (block) => block.matcher === "user-only" && block.hooks?.some(
        (hook) => hook.type === "command" && hook.command === userState.userHookCommand,
      ),
    ),
    "Claude settings must preserve the exact user-owned Hook command semantics",
  );
  assert.ok(
    codexHooks.hooks?.Stop?.some(
      (block) => block.matcher === "user-only" && block.hooks?.some(
        (hook) => hook.type === "command" && hook.command === userState.userHookCommand,
      ),
    ),
    "Codex hooks must preserve the exact user-owned Hook command semantics",
  );
  assert.match(textByLabel["codex-config"], /\[user_owned\]\s+preserve\s*=\s*true/u);

  assertNoTransientReferences(textByLabel, layout, store.packageRoot);
  assertManifestFileIntegrity(store.manifest);
}

function assertOrdinaryCwdUnchanged(layout) {
  const entries = readdirSync(layout.cwd, { withFileTypes: true });
  assert.deepEqual(entries.map((entry) => entry.name), ["user-owned.txt"]);
  assert.equal(entries[0].isFile(), true);
  assert.equal(readFileSync(path.join(layout.cwd, "user-owned.txt"), "utf8"), "ordinary cwd sentinel\n");
}

test("global projections survive deletion of a real transient npx package root", { timeout: 420_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-p138-portability-"));
  const layout = makeLayout(root);
  try {
    prepareLayout(layout);
    const userState = seedUserOwnedRuntimeState(layout);
    // A normal setup run records this read-only drift descriptor before global
    // sync. This lifecycle deliberately invokes the lower-level sync script,
    // so seed the same production prerequisite inside the isolated home. Node
    // is used as a stable existing executable; the descriptor has no execution
    // authority and is unrelated to the package-root behavior under test.
    recordSetupRuntimeExecutableBindings({
      roots: [layout.home],
      targets: ["claude", "codex"],
      pathResolver: () => process.execPath,
    });
    const env = isolatedEnvironment(layout);
    packCandidate(layout, env);

    const transientScript = path.join(layout.origin, "scripts", "sync-global-meta-theory.mjs");
    const first = runGlobalSync(transientScript, layout, env);
    assertSuccessful(first, "first transient global sync");
    const firstStore = projectionStoreFromManifest(layout);
    const firstProof = projectionProof(layout, firstStore);

    const second = runGlobalSync(transientScript, layout, env);
    assertSuccessful(second, "idempotent transient global sync");
    const secondStore = projectionStoreFromManifest(layout);
    assert.equal(secondStore.receiptEntry.path, firstStore.receiptEntry.path);
    assert.equal(secondStore.packageRoot, firstStore.packageRoot);
    assert.deepEqual(projectionProof(layout, secondStore), firstProof);

    assert.equal(lstatSync(layout.origin).isDirectory(), true);
    assert.equal(existsSync(path.join(layout.origin, ".git")), true);
    rmSync(layout.npmCache, { recursive: true, force: true });
    assert.equal(existsSync(layout.origin), false, "transient npx origin must actually be deleted");
    assert.equal(existsSync(layout.npmCache), false, "the entire custom npm cache must be deleted");

    const freshStore = projectionStoreFromManifest(layout);
    assert.equal(freshStore.packageRoot, firstStore.packageRoot);
    assert.equal(existsSync(freshStore.syncScript), true);
    const verifiedStablePackage = await verifyGlobalProjectionPackage(
      path.dirname(freshStore.receiptEntry.path),
      {
        homeRoot: layout.home,
        expectedPackageName: PACKAGE_MANIFEST.name,
        expectedPackageVersion: PACKAGE_MANIFEST.version,
        expectedPackageTarballSha256: freshStore.receipt.packageTarballSha256,
        expectedFirstPartyClosure: freshStore.receipt.firstPartyClosure,
      },
    );
    const freshCheck = await runGlobalProjectionPackageChild(
      verifiedStablePackage,
      [
        "--check",
        "--targets",
        "claude,codex",
        "--with-global-hooks",
        "--skip-durable-mcp",
      ],
      { env, sourceRoot: layout.origin },
    );
    assertSuccessful(freshCheck, "fresh global --check from stable projection package");

    readBackRuntimeState(layout, freshStore, userState);
    assertOrdinaryCwdUnchanged(layout);
    assert.equal(statSync(freshStore.packageRoot).isDirectory(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check with only legacy authority and a dirty current source is read-only and cannot pass", { timeout: 180_000 }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-p138-check-authority-"));
  const layout = makeLayout(root);
  try {
    prepareLayout(layout);
    packCandidate(layout, isolatedEnvironment(layout));
    const dirtyCommand = path.join(
      layout.origin,
      "canonical",
      "runtime-assets",
      "claude",
      "commands",
      "meta-theory.md",
    );
    writeFileSync(dirtyCommand, `${readFileSync(dirtyCommand, "utf8")}\nDIRTY CURRENT SOURCE\n`, "utf8");

    const legacyDigestDir = path.join(
      layout.home,
      ".meta-kim",
      "runtime",
      "projection-packages",
      PACKAGE_MANIFEST.name,
      PACKAGE_MANIFEST.version,
      "b".repeat(64),
    );
    mkdirSync(legacyDigestDir, { recursive: true });
    const manifestPath = path.join(layout.home, ".meta-kim", "install-manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      scope: "global",
      metaKimVersion: PACKAGE_MANIFEST.version,
      entries: [{
        path: legacyDigestDir,
        category: "C",
        source: "sync-global-meta-theory",
        purpose: "cross-runtime-global-projection-package-bundle",
        kind: "dir",
      }],
    }, null, 2)}\n`, "utf8");
    const homeBefore = snapshotTree(layout.home);
    const cwdBefore = snapshotTree(layout.cwd);

    const result = runGlobalSyncArgs(
      path.join(layout.origin, "scripts", "sync-global-meta-theory.mjs"),
      layout,
      isolatedEnvironment(layout),
      ["--check", "--targets", "claude,codex", "--with-global-hooks", "--skip-durable-mcp"],
    );
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /authority.*missing|missing.*authority/iu);
    assert.deepEqual(snapshotTree(layout.home), homeBefore);
    assert.deepEqual(snapshotTree(layout.cwd), cwdBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid targets fail before projection package materialization and write nothing", { timeout: 180_000 }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-p138-invalid-target-"));
  const layout = makeLayout(root);
  try {
    prepareLayout(layout);
    packCandidate(layout, isolatedEnvironment(layout));
    const homeBefore = snapshotTree(layout.home);
    const cwdBefore = snapshotTree(layout.cwd);
    const result = runGlobalSyncArgs(
      path.join(layout.origin, "scripts", "sync-global-meta-theory.mjs"),
      layout,
      isolatedEnvironment(layout),
      ["--targets", "claude,not-a-runtime", "--with-global-hooks", "--skip-durable-mcp"],
    );
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /unknown|unsupported|invalid.*target/iu);
    assert.deepEqual(snapshotTree(layout.home), homeBefore);
    assert.deepEqual(snapshotTree(layout.cwd), cwdBefore);
    assert.equal(
      existsSync(path.join(layout.home, ".meta-kim", "runtime", "projection-packages")),
      false,
    );
    assert.equal(existsSync(path.join(layout.home, ".meta-kim", "install-manifest.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed candidate materialization failure preserves runtime, manifest, and cwd bytes", { timeout: 180_000 }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-p138-materialize-failure-"));
  const layout = makeLayout(root);
  try {
    prepareLayout(layout);
    const userState = seedUserOwnedRuntimeState(layout);
    assert.ok(userState);
    const manifestPath = path.join(layout.home, ".meta-kim", "install-manifest.json");
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, "{\"userOwned\":true}\n", "utf8");
    packCandidate(layout, isolatedEnvironment(layout));
    const candidateManifestPath = path.join(layout.origin, "package.json");
    const candidateManifest = JSON.parse(readFileSync(candidateManifestPath, "utf8"));
    candidateManifest.name = "../malformed-candidate";
    writeFileSync(candidateManifestPath, `${JSON.stringify(candidateManifest, null, 2)}\n`, "utf8");
    const homeBefore = snapshotTree(layout.home);
    const cwdBefore = snapshotTree(layout.cwd);

    const result = runGlobalSync(
      path.join(layout.origin, "scripts", "sync-global-meta-theory.mjs"),
      layout,
      isolatedEnvironment(layout),
    );
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /unsafe projection package name|malformed-candidate/iu);
    assert.deepEqual(snapshotTree(layout.home), homeBefore);
    assert.deepEqual(snapshotTree(layout.cwd), cwdBefore);
    assert.equal(readFileSync(manifestPath, "utf8"), "{\"userOwned\":true}\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("npx npm_execpath and PATH poison cannot execute or create a global manifest", { timeout: 180_000 }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-p138-npm-poison-"));
  const layout = makeLayout(root);
  try {
    prepareLayout(layout);
    const poisonBin = path.join(
      root,
      "poison-cache",
      "_npx",
      "attacker",
      "node_modules",
      ".bin",
    );
    const poisonCli = path.join(poisonBin, "poison-npm.cjs");
    const markerPath = path.join(root, "poison-npm-executed.txt");
    mkdirSync(poisonBin, { recursive: true });
    writeFileSync(
      poisonCli,
      `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "EXECUTED\\n");\n`,
      "utf8",
    );
    if (process.platform === "win32") {
      writeFileSync(
        path.join(poisonBin, "npm.cmd"),
        `@"${process.execPath}" "${poisonCli}" %*\r\n`,
        "utf8",
      );
    } else {
      const poisonNpm = path.join(poisonBin, "npm");
      writeFileSync(
        poisonNpm,
        `#!/bin/sh\n"${process.execPath}" "${poisonCli}" "$@"\n`,
        "utf8",
      );
      chmodSync(poisonNpm, 0o755);
    }
    const env = isolatedEnvironment(layout);
    deleteEnvironmentKeysCaseInsensitive(env, [
      "META_KIM_REPO_ROOT",
      "META_KIM_PACKAGE_ROOT",
      "PATH",
      "npm_execpath",
      "npm_node_execpath",
    ]);
    env.PATH = poisonBin;
    env.nPm_ExEcPaTh = poisonCli;

    const result = runGlobalSyncArgs(
      path.join(REPO_ROOT, "scripts", "sync-global-meta-theory.mjs"),
      layout,
      env,
      ["--targets", "claude,codex", "--with-global-hooks", "--skip-durable-mcp"],
    );
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(existsSync(markerPath), false);
    assert.equal(
      existsSync(path.join(layout.home, ".meta-kim", "runtime", "projection-packages")),
      false,
    );
    assert.equal(existsSync(path.join(layout.home, ".meta-kim", "install-manifest.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor and OpenClaw-only sync does not require npm or create the primary store", { timeout: 180_000 }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-p138-non-primary-targets-"));
  const layout = makeLayout(root);
  try {
    prepareLayout(layout);
    const emptyPath = path.join(root, "no-executables");
    mkdirSync(emptyPath, { recursive: true });
    const env = isolatedEnvironment(layout);
    deleteEnvironmentKeysCaseInsensitive(env, [
      "META_KIM_REPO_ROOT",
      "META_KIM_PACKAGE_ROOT",
      "PATH",
      "npm_execpath",
      "npm_node_execpath",
    ]);
    env.PATH = emptyPath;

    const result = runGlobalSyncArgs(
      path.join(REPO_ROOT, "scripts", "sync-global-meta-theory.mjs"),
      layout,
      env,
      ["--targets", "cursor,openclaw", "--skip-durable-mcp"],
    );
    assertSuccessful(result, "Cursor/OpenClaw-only sync without npm");
    assert.equal(
      existsSync(path.join(layout.home, ".meta-kim", "runtime", "projection-packages")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
