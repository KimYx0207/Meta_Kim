import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  assertProjectionPackageWriteBoundary,
  findAuthoritativeGlobalProjectionPackage,
  materializeGlobalProjectionPackage,
  packageContentClosure,
  projectionPackageWriteBoundaryFindings,
  recordGlobalProjectionPackage,
  resolveGlobalProjectionPackageLayout,
  runWithCleanup,
  runGlobalProjectionPackageChild,
  sanitizeProjectionPackageEnvironment,
  withProjectionDigestLock,
} from "../../scripts/global-projection-package-store.mjs";
import {
  CATEGORIES,
  createEmpty,
  directoryClosureSync,
  fileIntegritySync,
  manifestPathFor,
  openRecorder,
  readManifest,
  writeManifest,
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

async function waitForMarker(markerPath, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(markerPath) && Date.now() < deadline) await delay(20);
  assert.equal(existsSync(markerPath), true, `timed out waiting for ${markerPath}`);
}

function waitForChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function portableRelative(from, target) {
  return path.relative(from, target).replaceAll("\\", "/");
}

test("stable projection write boundary resolves missing descendants and directory links", async () => {
  await withFixture(async ({ root }) => {
    const storeRoot = path.join(root, "store");
    const packageRoot = path.join(storeRoot, "meta-kim", "2.9.20", "digest", "bundle");
    const outsideRoot = path.join(root, "outside");
    const aliasRoot = path.join(outsideRoot, "package-alias");
    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(outsideRoot, { recursive: true });
    symlinkSync(packageRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    const verifiedPackage = { packageRoot, storeRoot };

    const findings = await projectionPackageWriteBoundaryFindings(
      verifiedPackage,
      [path.join(aliasRoot, "not-created", "state.json"), outsideRoot],
    );
    assert.equal(findings.length, 2);
    assert.deepEqual(
      findings.map((finding) => finding.kind).sort(),
      ["package_root", "projection_store"],
    );
    assert.equal(findings.every((finding) => finding.targetPath.includes("package-alias")), true);

    await assert.rejects(
      assertProjectionPackageWriteBoundary(
        verifiedPackage,
        [path.join(storeRoot, "future", "write.json")],
        { operation: "test write" },
      ),
      /overlaps projection_store/u,
    );
    assert.equal(
      await assertProjectionPackageWriteBoundary(
        verifiedPackage,
        [path.join(outsideRoot, "ordinary-project")],
      ),
      true,
    );
  });
});

test("stable child environment drops inherited project deployment handoff data", () => {
  const sanitized = sanitizeProjectionPackageEnvironment({
    PATH: process.env.PATH ?? "",
    MeTa_KiM_StAbLe_PrOjEcT_DePlOyMeNtS_JsOn: "poisoned",
  });
  assert.equal(
    Object.keys(sanitized).some((key) =>
      key.toLowerCase() === "meta_kim_stable_project_deployments_json"
    ),
    false,
  );
});

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

test("recording a stable package retires only superseded package authority entries", async () => {
  await withFixture(async ({ root, homeRoot, sourceRoot, env }) => {
    const verified = await materializeGlobalProjectionPackage({
      sourceRoot,
      homeRoot,
      env,
    });
    const staleRoot = path.join(
      root,
      "npm-cache",
      "_npx",
      "stale-origin",
      "node_modules",
      "meta-kim",
    );
    const staleEntries = manifestFor(verified).entries.map((entry) => ({
      ...entry,
      path: entry.path.replace(verified.digestDir, staleRoot),
    }));
    const unrelatedPath = path.join(root, "unrelated-sync-owned.txt");
    const otherOwnerPath = path.join(root, "other-owner-bundle.txt");
    writeFileSync(unrelatedPath, "unrelated\n", "utf8");
    writeFileSync(otherOwnerPath, "other owner\n", "utf8");
    const seeded = createEmpty({
      scope: "project",
      repoRoot: root,
      metaKimVersion: verified.packageVersion,
    });
    seeded.entries = [
      ...staleEntries,
      {
        path: unrelatedPath,
        category: CATEGORIES.C,
        source: "sync-global-meta-theory",
        purpose: "unrelated-global-setting",
        kind: "file",
        ownershipClass: "install_projection",
        ...fileIntegritySync(unrelatedPath),
      },
      {
        path: otherOwnerPath,
        category: CATEGORIES.C,
        source: "another-owner",
        purpose: BUNDLE_PURPOSE,
        kind: "file",
        ownershipClass: "install_projection",
        ...fileIntegritySync(otherOwnerPath),
      },
    ];
    const manifestPath = manifestPathFor("project", root);
    writeManifest(manifestPath, seeded);

    const recorder = openRecorder({
      scope: "project",
      repoRoot: root,
      metaKimVersion: verified.packageVersion,
    });
    await recordGlobalProjectionPackage(recorder, verified);
    const flushed = await recorder.flush();
    assert.equal(flushed.ok, true, flushed.error);

    const updated = readManifest(manifestPath);
    assert.equal(
      updated.entries.some((entry) => entry.path.startsWith(staleRoot)),
      false,
    );
    for (const expected of manifestFor(verified).entries) {
      assert.equal(
        updated.entries.some((entry) =>
          entry.path === expected.path && entry.purpose === expected.purpose
        ),
        true,
        `missing current authority ${expected.purpose}`,
      );
    }
    assert.equal(
      updated.entries.some((entry) => entry.path === unrelatedPath),
      true,
    );
    assert.equal(
      updated.entries.some((entry) => entry.path === otherOwnerPath),
      true,
    );
  });
});

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
    assert.equal(
      readdirSync(layout.versionRoot).some((name) =>
        name.startsWith(".projection-package-quarantine-")
      ),
      false,
      "a complete but untrusted digest must fail closed instead of being quarantined and replaced",
    );
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
    const privateRuntimeRootsBefore = privateNpmRuntimeRoots();

    await packageContentClosure(sourceRoot, { env, homeRoot });
    assert.deepEqual(
      readdirSync(homeRoot).sort(),
      homeBefore,
      "the read-only package closure probe must not persist npm state in HOME",
    );
    assert.deepEqual(
      privateNpmRuntimeRoots(),
      privateRuntimeRootsBefore,
      "the read-only closure probe must not leak a private npm runtime",
    );

    await materializeGlobalProjectionPackage({ sourceRoot, homeRoot, env });
    assert.deepEqual(
      readdirSync(homeRoot).filter((name) => name !== ".meta-kim").sort(),
      homeBefore,
      "materialization may write only its projection store beneath HOME",
    );
    assert.deepEqual(
      privateNpmRuntimeRoots(),
      privateRuntimeRootsBefore,
      "materialization must remove only the private npm runtime it created",
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

test("an incomplete same-digest directory is quarantined without deleting its evidence", async () => {
  await withFixture(async ({ homeRoot, sourceRoot, env }) => {
    const first = await materializeGlobalProjectionPackage({
      sourceRoot,
      homeRoot,
      env,
    });
    const sentinelName = "preserve-incomplete-evidence.txt";
    writeFileSync(path.join(first.digestDir, sentinelName), "preserve me\n", "utf8");
    rmSync(first.receiptPath, { force: true });

    const repaired = await materializeGlobalProjectionPackage({
      sourceRoot,
      homeRoot,
      env,
    });
    assert.equal(repaired.digestDir, first.digestDir);
    assert.equal(existsSync(repaired.receiptPath), true);
    const quarantines = readdirSync(repaired.versionRoot).filter((name) =>
      name.startsWith(`.projection-package-quarantine-${repaired.packageTarballSha256.slice(0, 12)}-`)
    );
    assert.equal(quarantines.length, 1);
    assert.equal(
      readFileSync(path.join(repaired.versionRoot, quarantines[0], sentinelName), "utf8"),
      "preserve me\n",
    );
  });
});

test("a stale dead-owner digest lock is quarantined with its evidence", async () => {
  await withFixture(async ({ root, homeRoot, sourceRoot, packageManifest, env }) => {
    const digest = packedDigest(sourceRoot, path.join(root, "lock-pack"), env);
    const layout = resolveGlobalProjectionPackageLayout({
      homeRoot,
      packageName: packageManifest.name,
      packageVersion: packageManifest.version,
      packageTarballSha256: digest,
    });
    const lockName = `.projection-package-lock-${digest.slice(0, 24)}`;
    const lockDir = path.join(layout.versionRoot, lockName);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      path.join(lockDir, "owner.json"),
      `${JSON.stringify({ token: "stale-owner", pid: 2_147_483_647 })}\n`,
      "utf8",
    );
    writeFileSync(path.join(lockDir, "stale-lock-evidence.txt"), "preserve lock\n", "utf8");
    const oldTime = new Date(Date.now() - 60_000);
    utimesSync(lockDir, oldTime, oldTime);

    const verified = await materializeGlobalProjectionPackage({
      sourceRoot,
      homeRoot,
      env,
    });
    assert.equal(existsSync(verified.receiptPath), true);
    assert.equal(existsSync(lockDir), false);
    const quarantines = readdirSync(layout.versionRoot).filter((name) =>
      name.startsWith(`.projection-package-lock-quarantine-${digest.slice(0, 24)}-`)
    );
    assert.equal(quarantines.length, 1);
    assert.equal(
      readFileSync(
        path.join(layout.versionRoot, quarantines[0], "stale-lock-evidence.txt"),
        "utf8",
      ),
      "preserve lock\n",
    );
  });
});

test("concurrent same-digest materialization leaves one complete verified winner", async () => {
  await withFixture(async ({ homeRoot, sourceRoot, env }) => {
    const [first, second] = await Promise.all([
      materializeGlobalProjectionPackage({ sourceRoot, homeRoot, env }),
      materializeGlobalProjectionPackage({ sourceRoot, homeRoot, env }),
    ]);
    assert.equal(second.digestDir, first.digestDir);
    assert.equal(second.packageRoot, first.packageRoot);
    assert.equal(existsSync(first.receiptPath), true);
    assert.deepEqual(readdirSync(first.versionRoot), [first.packageTarballSha256]);
  });
});

test("two processes share one digest barrier and release it after a failed operation", async () => {
  await withFixture(async ({ root, homeRoot, sourceRoot, env }) => {
    const verified = await materializeGlobalProjectionPackage({
      sourceRoot,
      homeRoot,
      env,
    });
    const workerPath = path.join(root, "projection-lock-worker.mjs");
    const moduleUrl = new URL(
      "../../scripts/global-projection-package-store.mjs",
      import.meta.url,
    ).href;
    writeFileSync(
      workerPath,
      [
        `import { existsSync, writeFileSync } from "node:fs";`,
        `import { resolveGlobalProjectionPackageLayout, withProjectionDigestLock } from ${JSON.stringify(moduleUrl)};`,
        `const [mode, homeRoot, version, digest, enteredPath, acquiredPath, releasePath, errorPath] = process.argv.slice(2);`,
        `const layout = resolveGlobalProjectionPackageLayout({ homeRoot, packageName: "meta-kim", packageVersion: version, packageTarballSha256: digest });`,
        `try {`,
        `  await withProjectionDigestLock(layout, async () => {`,
        `    writeFileSync(enteredPath, "entered\\n");`,
        `    if (mode === "hold") while (!existsSync(releasePath)) await new Promise((resolve) => setTimeout(resolve, 20));`,
        `    writeFileSync(acquiredPath, "acquired\\n");`,
        `  }, { homeRoot });`,
        `} catch (error) { writeFileSync(errorPath, String(error?.message ?? error)); process.exitCode = 1; }`,
      ].join("\n"),
      "utf8",
    );
    const firstEntered = path.join(root, "first-entered");
    const firstAcquired = path.join(root, "first-acquired");
    const secondEntered = path.join(root, "second-entered");
    const secondAcquired = path.join(root, "second-acquired");
    const releaseFirst = path.join(root, "release-first");
    const firstError = path.join(root, "first-error");
    const secondError = path.join(root, "second-error");
    const spawnWorker = (mode, entered, acquired, errorPath) => spawn(
      process.execPath,
      [
        workerPath,
        mode,
        homeRoot,
        verified.packageVersion,
        verified.packageTarballSha256,
        entered,
        acquired,
        releaseFirst,
        errorPath,
      ],
      { stdio: "ignore", windowsHide: true },
    );

    let first;
    let second;
    try {
      first = spawnWorker("hold", firstEntered, firstAcquired, firstError);
      await waitForMarker(firstEntered);
      second = spawnWorker("probe", secondEntered, secondAcquired, secondError);
      await delay(200);
      assert.equal(existsSync(secondEntered), false, "second process crossed the digest barrier");
      writeFileSync(releaseFirst, "release\\n", "utf8");
      await waitForMarker(firstAcquired);
      await waitForMarker(secondEntered);
      await waitForMarker(secondAcquired);
      assert.equal(existsSync(firstError), false);
      assert.equal(existsSync(secondError), false);
      assert.deepEqual(await Promise.all([waitForChild(first), waitForChild(second)]), [
        { code: 0, signal: null },
        { code: 0, signal: null },
      ]);
    } finally {
      for (const child of [first, second]) {
        if (child && child.exitCode === null) child.kill();
      }
    }

    await assert.rejects(
      withProjectionDigestLock(
        verified,
        async () => { throw new Error("operation failed"); },
        { homeRoot },
      ),
      /operation failed/u,
    );
    const afterFailure = await withProjectionDigestLock(
      verified,
      async () => "reacquired",
      { homeRoot },
    );
    assert.equal(afterFailure, "reacquired");
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
