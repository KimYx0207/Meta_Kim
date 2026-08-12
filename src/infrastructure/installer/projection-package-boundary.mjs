import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import {
  materializeGlobalProjectionPackage,
  projectionPackageWriteBoundaryFindings,
  sanitizeProjectionPackageEnvironment,
  verifyExecutingGlobalProjectionPackage,
} from "../../../scripts/global-projection-package-store.mjs";
import { resolveExistingManagedProjectCandidates } from "../../../scripts/existing-managed-projects.mjs";

export const STABLE_PROJECT_DEPLOYMENTS_ENV =
  "META_KIM_STABLE_PROJECT_DEPLOYMENTS_JSON";

function pathKey(value, platformName) {
  const resolved = path.resolve(value);
  return platformName === "win32" ? resolved.toLowerCase() : resolved;
}

function requireTargets(normalizeTargets, value, message) {
  const targets = normalizeTargets(value);
  if (targets.length === 0) throw new Error(message);
  return targets;
}

export function createProjectionPackageBoundary({
  packageRoot,
  callerCwd,
  homeRoot = os.homedir(),
  env = process.env,
  managedProjectManifestRelPath,
  normalizeTargets,
  processExecPath = process.execPath,
  spawnSyncImpl = spawnSync,
  platformName = process.platform,
}) {
  if (typeof normalizeTargets !== "function") {
    throw new TypeError("normalizeTargets must be a function");
  }
  if (
    typeof managedProjectManifestRelPath !== "string" ||
    managedProjectManifestRelPath.length === 0
  ) {
    throw new TypeError("managedProjectManifestRelPath is required");
  }
  const sourceRoot = path.resolve(packageRoot);
  const resolvedCallerCwd = path.resolve(callerCwd);
  const resolvedHomeRoot = path.resolve(homeRoot);
  const storeRoot = path.join(
    resolvedHomeRoot,
    ".meta-kim",
    "runtime",
    "projection-packages",
  );

  async function detectExecutingStablePackage() {
    const verified = await verifyExecutingGlobalProjectionPackage({
      packageRoot: sourceRoot,
      homeRoot: resolvedHomeRoot,
    });
    if (verified) return verified;
    const findings = await projectionPackageWriteBoundaryFindings(
      { packageRoot: storeRoot, storeRoot },
      [sourceRoot],
    );
    if (findings.length > 0) {
      throw new Error(
        "An unverified package inside the projection store cannot execute setup",
      );
    }
    return null;
  }

  function readStableProjectDeploymentHandoff(authority) {
    if (!authority) return null;
    const raw = env[STABLE_PROJECT_DEPLOYMENTS_ENV];
    if (!raw) return null;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Stable project deployment handoff is not valid JSON");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("Stable project deployment handoff must be an array");
    }
    const expectedByPath = new Map();
    const candidates = parsed.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("Stable project deployment handoff entry is invalid");
      }
      if (
        typeof entry.targetDir !== "string" ||
        !path.isAbsolute(entry.targetDir)
      ) {
        throw new Error("Stable project deployment handoff target must be absolute");
      }
      const targetDir = path.resolve(entry.targetDir);
      const activeTargets = requireTargets(
        normalizeTargets,
        entry.activeTargets,
        "Stable project deployment handoff targets are empty",
      );
      const key = pathKey(targetDir, platformName);
      if (expectedByPath.has(key)) {
        throw new Error(
          "Stable project deployment handoff contains a duplicate target",
        );
      }
      expectedByPath.set(key, activeTargets);
      return { targetDir, source: "stable_projection_handoff" };
    });
    const resolution = resolveExistingManagedProjectCandidates(candidates, {
      manifestRelPath: managedProjectManifestRelPath,
    });
    for (const deployment of resolution.deployments) {
      const expectedTargets = expectedByPath.get(
        pathKey(deployment.targetDir, platformName),
      ) ?? [];
      if (
        expectedTargets.length !== deployment.activeTargets.length ||
        expectedTargets.some(
          (target, index) => target !== deployment.activeTargets[index],
        )
      ) {
        throw new Error(
          `Stable project deployment targets changed before execution: ${deployment.targetDir}`,
        );
      }
    }
    if (
      resolution.deployments.length + resolution.rejected.length !==
      candidates.length
    ) {
      throw new Error(
        "Stable project deployment handoff resolution is incomplete",
      );
    }
    if (resolution.rejected.length > 0) {
      const first = resolution.rejected[0];
      throw new Error(
        `Stable project deployment changed before execution: ${first.targetDir} (${first.reason})`,
      );
    }
    return resolution;
  }

  async function materializeStablePackage() {
    return await materializeGlobalProjectionPackage({
      sourceRoot,
      homeRoot: resolvedHomeRoot,
      env,
    });
  }

  async function launchStableSetup(
    stablePackage,
    { args, deployments = [], fallbackTargets = [] },
  ) {
    const childEnv = sanitizeProjectionPackageEnvironment(env, {
      sourceRoot,
      storeRoot: stablePackage.storeRoot,
    });
    childEnv.META_KIM_REPO_ROOT = stablePackage.packageRoot;
    childEnv.META_KIM_CALLER_CWD = resolvedCallerCwd;
    childEnv[STABLE_PROJECT_DEPLOYMENTS_ENV] = JSON.stringify(
      deployments.map((deployment) => ({
        targetDir: path.resolve(
          typeof deployment === "string"
            ? deployment
            : deployment.targetDir,
        ),
        activeTargets: typeof deployment === "string"
          ? requireTargets(
            normalizeTargets,
            fallbackTargets,
            "Stable project deployment fallback targets are empty",
          )
          : requireTargets(
            normalizeTargets,
            deployment.activeTargets,
            "Stable project deployment targets are empty",
          ),
      })),
    );
    const result = spawnSyncImpl(
      processExecPath,
      [path.join(stablePackage.packageRoot, "setup.mjs"), ...args],
      {
        cwd: stablePackage.packageRoot,
        env: childEnv,
        stdio: "inherit",
        shell: false,
        windowsHide: true,
      },
    );
    if (result.error) throw result.error;
    if (result.signal) {
      throw new Error(`Stable global setup terminated by signal ${result.signal}`);
    }
    return Number.isInteger(result.status) ? result.status : 1;
  }

  async function verifyExecutingIntegrity(authority) {
    if (!authority) return true;
    const verified = await verifyExecutingGlobalProjectionPackage({
      packageRoot: sourceRoot,
      homeRoot: resolvedHomeRoot,
    });
    return Boolean(verified);
  }

  return Object.freeze({
    storeBoundary: Object.freeze({ packageRoot: storeRoot, storeRoot }),
    detectExecutingStablePackage,
    readStableProjectDeploymentHandoff,
    materializeStablePackage,
    launchStableSetup,
    verifyExecutingIntegrity,
  });
}
