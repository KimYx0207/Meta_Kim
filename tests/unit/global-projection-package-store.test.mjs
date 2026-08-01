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
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  findAuthoritativeGlobalProjectionPackage,
  materializeGlobalProjectionPackage,
  packageContentClosure,
  resolveGlobalProjectionPackageLayout,
  runWithCleanup,
  runGlobalProjectionPackageChild,
} from "../../scripts/global-projection-package-store.mjs";
import {
  CATEGORIES,
  directoryClosureSync,
  fileIntegritySync,
} from "../../scripts/install-manifest.mjs";

const RECEIPT_SCHEMA = "meta-kim-global-projection-package-v1";
const BUNDLE_PURPOSE = "primary-runtime-global-projection-package-runtime-bundle";

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

async function withFixture(body) {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-projection-store-unit-"));
  const homeRoot = path.join(root, "home");
  const sourceRoot = path.join(root, "source");
  const npmCache = path.join(root, "npm-cache");
  const npmPrefix = path.join(root, "npm-prefix");
  const tempRoot = path.join(root, "temp");
  mkdirSync(homeRoot, { recursive: true });
  mkdirSync(npmCache, { recursive: true });
  mkdirSync(npmPrefix, { recursive: true });
  mkdirSync(tempRoot, { recursive: true });
  mkdirSync(path.join(sourceRoot, "bin"), { recursive: true });
  mkdirSync(path.join(sourceRoot, "scripts"), { recursive: true });
  mkdirSync(path.join(sourceRoot, "assets"), { recursive: true });
  const packageManifest = {
    name: "meta-kim",
    version: "9.9.9-test",
    type: "module",
    bin: { "meta-kim": "bin/meta-kim.mjs" },
    files: ["assets/", "bin/", "scripts/**/*.mjs"],
    dependencies: {},
  };
  writeFileSync(
    path.join(sourceRoot, "package.json"),
    `${JSON.stringify(packageManifest, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(path.join(sourceRoot, "bin", "meta-kim.mjs"), "process.exit(0);\n", "utf8");
  writeFileSync(path.join(sourceRoot, "README.md"), "fixture root readme\n", "utf8");
  writeFileSync(
    path.join(sourceRoot, "scripts", "sync-global-meta-theory.mjs"),
    "process.exit(0);\n",
    "utf8",
  );
  writeFileSync(
    path.join(sourceRoot, "scripts", "README.md"),
    "fixture scripts readme\n",
    "utf8",
  );
  writeFileSync(
    path.join(sourceRoot, "assets", "non-key.txt"),
    "fixture non-key first-party content\n",
    "utf8",
  );
  const env = {
    ...process.env,
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    TMP: tempRoot,
    TEMP: tempRoot,
    TMPDIR: tempRoot,
    NPM_CONFIG_CACHE: npmCache,
    npm_config_cache: npmCache,
    NPM_CONFIG_PREFIX: npmPrefix,
    npm_config_prefix: npmPrefix,
    NPM_CONFIG_OFFLINE: "true",
    npm_config_offline: "true",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
  };
  try {
    return await body({ root, homeRoot, sourceRoot, packageManifest, env });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function privateNpmRuntimeRoots() {
  return readdirSync(os.tmpdir())
    .filter((name) => name.startsWith("meta-kim-npm-runtime-"))
    .sort();
}

function packedDigest(sourceRoot, destinationRoot, env) {
  mkdirSync(destinationRoot, { recursive: true });
  const result = spawnSync(
    process.execPath,
    [resolveNpmCliPath(), "pack", sourceRoot, "--ignore-scripts", "--pack-destination", destinationRoot],
    { cwd: sourceRoot, env, encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const archives = readdirSync(destinationRoot).filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 1);
  return sha256(readFileSync(path.join(destinationRoot, archives[0])));
}

function portableRelative(from, target) {
  return path.relative(from, target).replaceAll("\\", "/");
}

function firstPartySnapshot(packageRoot) {
  const filePaths = [];
  const walk = (currentPath, relativeParent = "") => {
    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = `${relativeParent}/${entry.name}`.replace(/^\//u, "");
      if (entry.isDirectory()) walk(absolutePath, relativePath);
      else if (entry.isFile()) filePaths.push(relativePath.replaceAll("\\", "/"));
    }
  };
  walk(packageRoot);
  filePaths.sort((left, right) => left.localeCompare(right));
  const entries = filePaths.map((relativePath) => {
    const bytes = readFileSync(path.join(packageRoot, ...relativePath.split("/")));
    return { path: relativePath, size: bytes.length, sha256: sha256(bytes) };
  });
  return {
    filePaths,
    closure: {
      entryCount: entries.length,
      sha256: sha256(Buffer.from(JSON.stringify(entries), "utf8")),
    },
  };
}

function writeSelfSignedPoison(layout, markerPath) {
  const cliPath = path.join(layout.packageRoot, "bin", "meta-kim.mjs");
  mkdirSync(path.dirname(layout.packageManifestPath), { recursive: true });
  mkdirSync(path.dirname(cliPath), { recursive: true });
  mkdirSync(path.dirname(layout.syncScriptPath), { recursive: true });
  writeFileSync(
    layout.packageManifestPath,
    `${JSON.stringify({
      name: layout.packageName,
      version: layout.packageVersion,
      type: "module",
      bin: { "meta-kim": "bin/meta-kim.mjs" },
    }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(cliPath, "process.exit(0);\n", "utf8");
  writeFileSync(
    layout.syncScriptPath,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(markerPath)}, "POISON EXECUTED\\n");\n`,
    "utf8",
  );
  const keyFiles = {};
  for (const [role, filePath] of Object.entries({
    packageManifest: layout.packageManifestPath,
    publicCli: cliPath,
    globalSyncScript: layout.syncScriptPath,
  })) {
    keyFiles[role] = {
      relativePath: portableRelative(layout.digestDir, filePath),
      ...fileIntegritySync(filePath),
    };
  }
  const firstParty = firstPartySnapshot(layout.packageRoot);
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA,
    packageName: layout.packageName,
    packageVersion: layout.packageVersion,
    packageTarballSha256: layout.packageTarballSha256,
    firstPartyFiles: firstParty.filePaths,
    firstPartyClosure: firstParty.closure,
    bundleRelativePath: "bundle",
    packageRootRelative: portableRelative(layout.digestDir, layout.packageRoot),
    bundleClosure: directoryClosureSync(layout.bundleDir),
    keyFiles,
  };
  writeFileSync(layout.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

function manifestFor(verified) {
  const fileEntry = (purpose, filePath) => ({
    path: filePath,
    category: CATEGORIES.C,
    source: "sync-global-meta-theory",
    purpose,
    kind: "file",
    ownershipClass: "install_projection",
    ...fileIntegritySync(filePath),
  });
  const closure = directoryClosureSync(verified.digestDir);
  return {
    schemaVersion: 1,
    scope: "global",
    metaKimVersion: verified.packageVersion,
    entries: [
      {
        path: verified.digestDir,
        category: CATEGORIES.C,
        source: "sync-global-meta-theory",
        purpose: BUNDLE_PURPOSE,
        kind: "dir",
        ownershipClass: "install_projection",
        directoryClosureSha256: closure.sha256,
        directoryClosureEntryCount: closure.entryCount,
      },
      fileEntry(`${BUNDLE_PURPOSE}:receipt`, verified.receiptPath),
      fileEntry(`${BUNDLE_PURPOSE}:package-manifest`, verified.packageManifestPath),
      fileEntry(`${BUNDLE_PURPOSE}:cli`, verified.cliPath),
      fileEntry(`${BUNDLE_PURPOSE}:sync-script`, verified.syncScriptPath),
    ],
  };
}

test("a self-signed pre-existing digest package is rejected and never executed", async () => {
  await withFixture(async ({ root, homeRoot, sourceRoot, packageManifest, env }) => {
    const packageTarballSha256 = packedDigest(sourceRoot, path.join(root, "pack"), env);
    const layout = resolveGlobalProjectionPackageLayout({
      homeRoot,
      packageName: packageManifest.name,
      packageVersion: packageManifest.version,
      packageTarballSha256,
    });
    const markerPath = path.join(root, "poison-executed.txt");
    writeSelfSignedPoison(layout, markerPath);

    let returnedPackage = null;
    let materializeError = null;
    try {
      returnedPackage = await materializeGlobalProjectionPackage({
        sourceRoot,
        homeRoot,
        env,
      });
    } catch (error) {
      materializeError = error;
    }
    if (returnedPackage) {
      await runGlobalProjectionPackageChild(returnedPackage, [], { env });
    }
    assert.ok(materializeError, "pre-existing self-signed digest must not become executable authority");
    assert.equal(existsSync(markerPath), false, "poisoned sync script must never execute");
  });
});

test("missing real npm discovery fails before creating projection store state", async () => {
  await withFixture(async ({ root, homeRoot, sourceRoot, env }) => {
    const emptyPath = path.join(root, "no-executables");
    mkdirSync(emptyPath, { recursive: true });
    const noNpmEnv = { ...env, PATH: emptyPath, Path: emptyPath };
    delete noNpmEnv.npm_execpath;
    delete noNpmEnv.NPM_EXECPATH;
    const sourceManifestBefore = readFileSync(path.join(sourceRoot, "package.json"));
    const homeBefore = readdirSync(homeRoot);

    await assert.rejects(
      materializeGlobalProjectionPackage({
        sourceRoot,
        homeRoot,
        env: noNpmEnv,
      }),
      /npm|executable|enoent/iu,
    );
    assert.deepEqual(readdirSync(homeRoot), homeBefore);
    assert.deepEqual(
      readFileSync(path.join(sourceRoot, "package.json")),
      sourceManifestBefore,
    );
  });
});

test("cleanup contract: npm lifecycle leaves HOME unchanged outside the store and removes its private runtime", async () => {
  await withFixture(async ({ homeRoot, sourceRoot, env }) => {
    const homeBefore = readdirSync(homeRoot).sort();
    assert.deepEqual(privateNpmRuntimeRoots(), []);

    await packageContentClosure(sourceRoot, { env, homeRoot });
    assert.deepEqual(
      readdirSync(homeRoot).sort(),
      homeBefore,
      "the read-only package closure probe must not persist npm state in HOME",
    );
    assert.deepEqual(privateNpmRuntimeRoots(), []);

    await materializeGlobalProjectionPackage({ sourceRoot, homeRoot, env });
    assert.deepEqual(
      readdirSync(homeRoot).filter((name) => name !== ".meta-kim").sort(),
      homeBefore,
      "materialization may write only its projection store beneath HOME",
    );
    assert.deepEqual(
      privateNpmRuntimeRoots(),
      [],
      "materialization must remove its private npm cache and temp root",
    );
  });
});

test("cleanup contract: operation and cleanup failures preserve both causes", async () => {
  const operationError = new Error("operation failed");
  const cleanupError = new Error("cleanup failed");
  await assert.rejects(
    runWithCleanup(
      async () => { throw operationError; },
      async () => { throw cleanupError; },
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [operationError, cleanupError]);
      return true;
    },
  );
  await assert.rejects(
    runWithCleanup(
      async () => "completed",
      async () => { throw cleanupError; },
    ),
    (error) => error === cleanupError,
  );
});

test("cleanup contract: successful materialization leaves no stage or swallowed stage cleanup", async () => {
  await withFixture(async ({ homeRoot, sourceRoot, env }) => {
    const verified = await materializeGlobalProjectionPackage({
      sourceRoot,
      homeRoot,
      env,
    });
    assert.equal(
      readdirSync(verified.versionRoot).some((name) =>
        name.startsWith(".projection-package-staged-")
      ),
      false,
    );
    const productionSource = readFileSync(
      new URL("../../scripts/global-projection-package-store.mjs", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(productionSource, /\.catch\(\(\) => \{\}\)/u);
  });
});

test("an exact same-digest materialization retry reuses the verified staged package", async () => {
  await withFixture(async ({ homeRoot, sourceRoot, env }) => {
    const first = await materializeGlobalProjectionPackage({
      sourceRoot,
      homeRoot,
      env,
    });
    const firstClosure = directoryClosureSync(first.digestDir);
    const second = await materializeGlobalProjectionPackage({
      sourceRoot,
      homeRoot,
      env,
    });
    assert.equal(second.digestDir, first.digestDir);
    assert.equal(second.packageRoot, first.packageRoot);
    assert.deepEqual(directoryClosureSync(second.digestDir), firstClosure);
    assert.deepEqual(readdirSync(first.versionRoot), [first.packageTarballSha256]);
  });
});

test("npm pack truth includes an implicit root README and excludes an unmatched nested README", async () => {
  await withFixture(async ({ homeRoot, sourceRoot, env }) => {
    const verified = await materializeGlobalProjectionPackage({
      sourceRoot,
      homeRoot,
      env,
    });
    assert.ok(
      verified.receipt.firstPartyFiles.includes("README.md"),
      "npm's implicit root README must be recorded",
    );
    assert.equal(
      verified.receipt.firstPartyFiles.includes("scripts/README.md"),
      false,
      "an unmatched nested README must remain outside npm pack truth",
    );
    const before = await packageContentClosure(sourceRoot, { env, homeRoot });
    writeFileSync(
      path.join(sourceRoot, "scripts", "README.md"),
      "fixture scripts readme changed\n",
      "utf8",
    );
    const afterExcludedChange = await packageContentClosure(sourceRoot, {
      env,
      homeRoot,
    });
    assert.deepEqual(afterExcludedChange, before);
    writeFileSync(
      path.join(sourceRoot, "README.md"),
      "fixture implicit root readme changed\n",
      "utf8",
    );
    const afterImplicitChange = await packageContentClosure(sourceRoot, {
      env,
      homeRoot,
    });
    assert.notDeepEqual(afterImplicitChange, afterExcludedChange);
  });
});

test("partially self-consistent manifest and receipt cannot hide stable first-party drift", async () => {
  await withFixture(async ({ homeRoot, sourceRoot, env }) => {
    const verified = await materializeGlobalProjectionPackage({
      sourceRoot,
      homeRoot,
      env,
    });
    const manifest = manifestFor(verified);
    const driftedFile = path.join(verified.packageRoot, "assets", "non-key.txt");
    assert.equal(existsSync(driftedFile), true, "fixture must exercise a non-key first-party file");
    writeFileSync(driftedFile, "DRIFTED STABLE FIRST-PARTY CONTENT\n", "utf8");

    const receipt = JSON.parse(readFileSync(verified.receiptPath, "utf8"));
    receipt.bundleClosure = directoryClosureSync(verified.bundleDir);
    writeFileSync(verified.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    const receiptEntry = manifest.entries.find((entry) =>
      entry.purpose === `${BUNDLE_PURPOSE}:receipt`
    );
    Object.assign(receiptEntry, fileIntegritySync(verified.receiptPath));
    const bundleEntry = manifest.entries.find((entry) => entry.purpose === BUNDLE_PURPOSE);
    const currentDigestClosure = directoryClosureSync(verified.digestDir);
    bundleEntry.directoryClosureSha256 = currentDigestClosure.sha256;
    bundleEntry.directoryClosureEntryCount = currentDigestClosure.entryCount;
    assert.deepEqual(
      receipt.bundleClosure,
      directoryClosureSync(verified.bundleDir),
      "receipt bundle closure is deliberately refreshed to isolate first-party truth",
    );

    const authority = await findAuthoritativeGlobalProjectionPackage(manifest, {
      homeRoot,
      expectedPackageName: verified.packageName,
      expectedPackageVersion: verified.packageVersion,
      expectedFirstPartyClosure: verified.firstPartyClosure,
    });
    assert.equal(authority, null);
  });
});

test("mixed-case NODE_OPTIONS cannot execute preload code during materialization", async () => {
  await withFixture(async ({ root, homeRoot, sourceRoot, env }) => {
    const markerPath = path.join(root, "node-options-executed.txt");
    const preloadPath = path.join(root, "poison-preload.cjs");
    writeFileSync(
      preloadPath,
      `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "EXECUTED\\n");\n`,
      "utf8",
    );
    const poisonedEnv = {};
    for (const [key, value] of Object.entries(env)) {
      if (key.toLowerCase() !== "node_options") poisonedEnv[key] = value;
    }
    poisonedEnv.NoDe_OpTiOnS = `--require=${preloadPath}`;

    await materializeGlobalProjectionPackage({
      sourceRoot,
      homeRoot,
      env: poisonedEnv,
    });
    assert.equal(existsSync(markerPath), false);
  });
});

test("Windows authority lookup accepts manifest paths whose case differs only lexically", {
  skip: process.platform !== "win32",
}, async () => {
  await withFixture(async ({ homeRoot, sourceRoot, env }) => {
    const verified = await materializeGlobalProjectionPackage({
      sourceRoot,
      homeRoot,
      env,
    });
    const manifest = manifestFor(verified);
    for (const entry of manifest.entries) {
      entry.path = entry.path.replace(/projection-packages/iu, "PrOjEcTiOn-PaCkAgEs");
    }
    const authority = await findAuthoritativeGlobalProjectionPackage(manifest, {
      homeRoot,
      expectedPackageName: "meta-kim",
      expectedPackageVersion: verified.packageVersion,
      expectedFirstPartyClosure: await packageContentClosure(sourceRoot, {
        env,
        homeRoot,
      }),
    });
    assert.ok(authority);
    assert.equal(authority.packageRoot.toLowerCase(), verified.packageRoot.toLowerCase());
  });
});
