/**
 * Coordinate the stable-package handoff required before global setup writes.
 *
 * This application use case owns only workflow decisions. Node process,
 * filesystem, package-store, and environment details are supplied by the
 * projection-package boundary.
 */

function requireArray(value, field) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array`);
  }
  return value;
}

function requireBoundary(boundary) {
  for (const method of [
    "detectExecutingStablePackage",
    "materializeStablePackage",
    "launchStableSetup",
  ]) {
    if (typeof boundary?.[method] !== "function") {
      throw new TypeError(`projection package boundary is missing ${method}()`);
    }
  }
  return boundary;
}

export function buildStableGlobalSetupArgs({
  mode,
  activeTargets,
  skillIds,
  language,
  withGlobalHooks = false,
  saveProjectDirs = false,
}) {
  if (mode !== "install" && mode !== "update") {
    throw new TypeError("stable global setup mode must be install or update");
  }
  const targets = requireArray(activeTargets, "activeTargets");
  const skills = requireArray(skillIds, "skillIds");
  if (targets.length === 0) {
    throw new TypeError("stable global setup requires at least one runtime target");
  }
  if (typeof language !== "string" || language.length === 0) {
    throw new TypeError("stable global setup language is required");
  }
  return [
    ...(mode === "update" ? ["--update"] : []),
    "--silent",
    "--lang",
    language,
    "--scope",
    "global",
    "--targets",
    targets.join(","),
    "--skills",
    skills.join(","),
    ...(withGlobalHooks ? ["--with-global-hooks"] : []),
    ...(saveProjectDirs ? ["--save-project-dirs"] : []),
  ];
}

export function mergeDelegatedGlobalSetupResult(
  result,
  rejectedManagedProjects = [],
) {
  const rejected = requireArray(
    rejectedManagedProjects,
    "rejectedManagedProjects",
  );
  const explicitRejected = rejected.filter(
    (item) => item?.source === "explicit_project_dirs",
  );
  const failedSteps = [
    ...(result?.failedSteps ?? []),
    ...explicitRejected.map((item) => ({
      id: `rejected managed project: ${item.targetDir}`,
    })),
  ];
  return {
    ...result,
    status: failedSteps.length > 0 ? "failed" : result.status,
    exitCode: failedSteps.length > 0 ? 1 : result.exitCode,
    failedSteps,
    rejectedManagedProjects: rejected,
  };
}

export async function ensureStableGlobalProjectionPackage(
  {
    currentAuthority = null,
    mode,
    activeTargets,
    skillIds = [],
    deployments = [],
    rejectedManagedProjects = [],
    language,
    withGlobalHooks = false,
    saveProjectDirs = false,
  },
  boundary,
) {
  const port = requireBoundary(boundary);
  const executingAuthority = await port.detectExecutingStablePackage();
  if (executingAuthority) {
    return Object.freeze({
      executingAuthority,
      delegatedResult: null,
    });
  }
  if (currentAuthority) {
    throw new Error(
      "The executing stable projection package changed before global setup",
    );
  }

  const stablePackage = await port.materializeStablePackage();
  const args = buildStableGlobalSetupArgs({
    mode,
    activeTargets,
    skillIds,
    language,
    withGlobalHooks,
    saveProjectDirs,
  });
  const exitCode = await port.launchStableSetup(stablePackage, {
    args,
    deployments: requireArray(deployments, "deployments"),
    fallbackTargets: activeTargets,
  });
  const delegatedResult = mergeDelegatedGlobalSetupResult(
    {
      status: exitCode === 0 ? "complete" : "failed",
      exitCode,
      failedSteps: exitCode === 0 ? [] : [{ id: "stable global setup" }],
      delegatedToStableProjectionPackage: true,
    },
    rejectedManagedProjects,
  );
  return Object.freeze({
    executingAuthority: null,
    delegatedResult,
  });
}
