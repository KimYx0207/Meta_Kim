import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildStableGlobalSetupArgs,
  ensureStableGlobalProjectionPackage,
  mergeDelegatedGlobalSetupResult,
} from "../../src/application/installer/ensure-stable-global-projection-package.mjs";
import {
  createProjectionPackageBoundary,
  STABLE_PROJECT_DEPLOYMENTS_ENV,
} from "../../src/infrastructure/installer/projection-package-boundary.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const CONTRACT_PATH = path.join(
  REPO_ROOT,
  "config",
  "contracts",
  "setup-runtime-installer-decomposition-contract.json",
);
const APPLICATION_PATH = path.join(
  REPO_ROOT,
  "src",
  "application",
  "installer",
  "ensure-stable-global-projection-package.mjs",
);
const INFRASTRUCTURE_PATH = path.join(
  REPO_ROOT,
  "src",
  "infrastructure",
  "installer",
  "projection-package-boundary.mjs",
);
const SETUP_PATH = path.join(REPO_ROOT, "setup.mjs");

function input(overrides = {}) {
  return {
    currentAuthority: null,
    mode: "install",
    activeTargets: ["claude", "codex"],
    skillIds: ["meta-theory"],
    deployments: [
      { targetDir: "D:/projects/one", activeTargets: ["claude"] },
    ],
    rejectedManagedProjects: [],
    language: "zh-CN",
    withGlobalHooks: true,
    saveProjectDirs: false,
    ...overrides,
  };
}

test("A10 machine contract fixes the bounded installer decomposition and lifecycle invariants", () => {
  const contract = JSON.parse(readFileSync(CONTRACT_PATH, "utf8"));
  assert.equal(contract.schemaVersion, "meta-kim-setup-runtime-installer-decomposition-v1");
  assert.equal(contract.phase, "M3-A10");
  assert.equal(
    contract.layerRules.dependencyDirection,
    "setup composition root -> application use case + infrastructure adapter -> legacy store authority",
  );
  for (const invariant of [
    "scopeSemanticsUnchanged",
    "globalOnlySemanticsUnchanged",
    "projectBootstrapMergeDeltaUnchanged",
    "runtimeSedimentedProjectCopyPreserved",
    "unknownAndUserOwnedContentPreserved",
    "manifestOwnershipUnchanged",
    "immutablePackageStoreLayoutAndReceiptUnchanged",
    "helpStatusDoctorDoNotMaterialize",
    "checkRemainsReadOnly",
    "installAndUpdateMaterializeBeforePersistentGlobalWrites",
    "stableChildUsesShellFalse",
    "uninstallExactOwnershipSemanticsUnchanged",
    "noSecondPackageStore",
    "noSecondInstallManifest",
  ]) {
    assert.equal(contract.behavioralInvariants[invariant], true, invariant);
  }
});

test("application use case keeps a verified executing package and performs no delegation", async () => {
  const calls = [];
  const authority = Object.freeze({ packageRoot: "D:/stable/meta-kim" });
  const boundary = {
    async detectExecutingStablePackage() {
      calls.push("detect");
      return authority;
    },
    async materializeStablePackage() {
      calls.push("materialize");
      throw new Error("must not materialize");
    },
    launchStableSetup() {
      calls.push("launch");
      throw new Error("must not launch");
    },
  };

  const result = await ensureStableGlobalProjectionPackage(input(), boundary);
  assert.deepEqual(result, {
    executingAuthority: authority,
    delegatedResult: null,
  });
  assert.deepEqual(calls, ["detect"]);
});

test("application use case materializes and delegates once with exact stable arguments", async () => {
  const calls = [];
  const stablePackage = Object.freeze({
    packageRoot: "D:/stable/meta-kim",
    storeRoot: "D:/stable",
  });
  const boundary = {
    async detectExecutingStablePackage() {
      calls.push("detect");
      return null;
    },
    async materializeStablePackage() {
      calls.push("materialize");
      return stablePackage;
    },
    launchStableSetup(receivedPackage, command) {
      calls.push(["launch", receivedPackage, command]);
      return 0;
    },
  };

  const command = input({
    mode: "update",
    saveProjectDirs: true,
    rejectedManagedProjects: [
      { targetDir: "D:/explicit-rejected", source: "explicit_project_dirs" },
      { targetDir: "D:/saved-rejected", source: "saved_project_dirs" },
    ],
  });
  const result = await ensureStableGlobalProjectionPackage(command, boundary);

  assert.equal(result.executingAuthority, null);
  assert.equal(result.delegatedResult.status, "failed");
  assert.equal(result.delegatedResult.exitCode, 1);
  assert.deepEqual(result.delegatedResult.failedSteps, [
    { id: "rejected managed project: D:/explicit-rejected" },
  ]);
  assert.deepEqual(result.delegatedResult.rejectedManagedProjects, command.rejectedManagedProjects);
  assert.deepEqual(calls.slice(0, 2), ["detect", "materialize"]);
  assert.deepEqual(calls[2], [
    "launch",
    stablePackage,
    {
      args: [
        "--update",
        "--silent",
        "--lang",
        "zh-CN",
        "--scope",
        "global",
        "--targets",
        "claude,codex",
        "--skills",
        "meta-theory",
        "--with-global-hooks",
        "--save-project-dirs",
      ],
      deployments: command.deployments,
      fallbackTargets: command.activeTargets,
    },
  ]);
});

test("application use case fails closed when an established stable authority disappears", async () => {
  let materializeCalls = 0;
  const boundary = {
    async detectExecutingStablePackage() {
      return null;
    },
    async materializeStablePackage() {
      materializeCalls += 1;
      return {};
    },
    launchStableSetup() {
      return 0;
    },
  };
  await assert.rejects(
    ensureStableGlobalProjectionPackage(
      input({ currentAuthority: { packageRoot: "D:/stable/meta-kim" } }),
      boundary,
    ),
    /changed before global setup/u,
  );
  assert.equal(materializeCalls, 0);
});

test("infrastructure boundary sanitizes and launches the immutable setup child without a shell", async () => {
  const launches = [];
  const packageRoot = path.join(REPO_ROOT, "transient-origin");
  const stableRoot = path.join(REPO_ROOT, "stable-store", "meta-kim");
  const boundary = createProjectionPackageBoundary({
    packageRoot,
    callerCwd: path.join(REPO_ROOT, "caller"),
    homeRoot: path.join(REPO_ROOT, "test-home"),
    env: {
      PATH: process.env.PATH ?? "",
      npm_config_cache: "D:/must-not-leak",
      META_KIM_REPO_ROOT: "D:/must-not-leak",
      USER_SENTINEL: "preserve",
    },
    managedProjectManifestRelPath:
      ".meta-kim/state/default/project-bootstrap.json",
    normalizeTargets: (targets) => [...new Set(targets ?? [])].sort(),
    processExecPath: process.execPath,
    spawnSyncImpl(command, args, options) {
      launches.push({ command, args, options });
      return { status: 0, signal: null, error: null };
    },
  });

  const exitCode = await boundary.launchStableSetup(
    { packageRoot: stableRoot, storeRoot: path.dirname(stableRoot) },
    {
      args: ["--silent", "--scope", "global"],
      deployments: [
        {
          targetDir: path.join(REPO_ROOT, "project-one"),
          activeTargets: ["codex", "claude", "codex"],
        },
      ],
      fallbackTargets: ["claude"],
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(launches.length, 1);
  const [launch] = launches;
  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.args, [
    path.join(stableRoot, "setup.mjs"),
    "--silent",
    "--scope",
    "global",
  ]);
  assert.equal(launch.options.cwd, stableRoot);
  assert.equal(launch.options.shell, false);
  assert.equal(launch.options.windowsHide, true);
  assert.equal(launch.options.env.USER_SENTINEL, "preserve");
  assert.equal(launch.options.env.npm_config_cache, undefined);
  assert.equal(launch.options.env.META_KIM_REPO_ROOT, stableRoot);
  const handoff = JSON.parse(
    launch.options.env[STABLE_PROJECT_DEPLOYMENTS_ENV],
  );
  assert.deepEqual(handoff, [
    {
      targetDir: path.resolve(REPO_ROOT, "project-one"),
      activeTargets: ["claude", "codex"],
    },
  ]);
  assert.equal(boundary.readStableProjectDeploymentHandoff(null), null);
});

test("stable argument and rejected-project result semantics remain deterministic", () => {
  assert.deepEqual(
    buildStableGlobalSetupArgs({
      mode: "install",
      activeTargets: ["cursor"],
      skillIds: [],
      language: "en",
      withGlobalHooks: false,
      saveProjectDirs: false,
    }),
    [
      "--silent",
      "--lang",
      "en",
      "--scope",
      "global",
      "--targets",
      "cursor",
      "--skills",
      "",
    ],
  );
  assert.deepEqual(
    mergeDelegatedGlobalSetupResult(
      { status: "failed", exitCode: 1, failedSteps: [{ id: "child" }] },
      [{ targetDir: "D:/saved", source: "saved_project_dirs" }],
    ),
    {
      status: "failed",
      exitCode: 1,
      failedSteps: [{ id: "child" }],
      rejectedManagedProjects: [
        { targetDir: "D:/saved", source: "saved_project_dirs" },
      ],
    },
  );
});

test("source boundaries keep setup as facade and retain one package-store authority", () => {
  const application = readFileSync(APPLICATION_PATH, "utf8");
  const infrastructure = readFileSync(INFRASTRUCTURE_PATH, "utf8");
  const setup = readFileSync(SETUP_PATH, "utf8");

  assert.doesNotMatch(application, /from\s+["']node:/u);
  assert.doesNotMatch(application, /scripts\/global-projection-package-store/u);
  assert.match(
    infrastructure,
    /scripts\/global-projection-package-store\.mjs/u,
  );
  assert.match(
    setup,
    /src\/application\/installer\/ensure-stable-global-projection-package\.mjs/u,
  );
  assert.match(
    setup,
    /src\/infrastructure\/installer\/projection-package-boundary\.mjs/u,
  );
  assert.doesNotMatch(setup, /async function handOffGlobalSetupIfNeeded\(/u);
  assert.doesNotMatch(setup, /function stableGlobalSetupArgs\(/u);
  assert.doesNotMatch(setup, /function mergeDelegatedGlobalSetupResult\(/u);
  assert.doesNotMatch(setup, /async function stableProjectionPackageIntegrityOk\(/u);
});
