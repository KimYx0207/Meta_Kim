import path from "node:path";

export const SETUP_NODE_CHILD = Object.freeze({
  GLOBAL_SKILLS_INSTALLER: "global-skills-installer",
  GLOBAL_META_THEORY_SYNC: "global-meta-theory-sync",
  RUNTIME_SYNC: "runtime-sync",
  CAPABILITY_DISCOVERY: "capability-discovery",
  PROJECT_VALIDATION: "project-validation",
});

const SETUP_NODE_CHILD_CONTRACTS = Object.freeze({
  [SETUP_NODE_CHILD.GLOBAL_SKILLS_INSTALLER]: Object.freeze({
    scriptRelative: "scripts/install-global-skills-all-runtimes.mjs",
    languageOption: true,
  }),
  [SETUP_NODE_CHILD.GLOBAL_META_THEORY_SYNC]: Object.freeze({
    scriptRelative: "scripts/sync-global-meta-theory.mjs",
    languageOption: false,
  }),
  [SETUP_NODE_CHILD.RUNTIME_SYNC]: Object.freeze({
    scriptRelative: "scripts/sync-runtimes.mjs",
    languageOption: true,
  }),
  [SETUP_NODE_CHILD.CAPABILITY_DISCOVERY]: Object.freeze({
    scriptRelative: "scripts/discover-global-capabilities.mjs",
    languageOption: true,
  }),
  [SETUP_NODE_CHILD.PROJECT_VALIDATION]: Object.freeze({
    scriptRelative: "scripts/validate-project.mjs",
    languageOption: true,
  }),
});

function normalizeTargetList(targets) {
  return Array.isArray(targets) ? targets.join(",") : String(targets);
}

export function buildGlobalSkillsInstallerArgs({
  targets,
  skillIds = [],
  update = false,
  preferLocalDependencies = false,
  skipInventoryRefresh = false,
  retireAbsorbed = false,
} = {}) {
  const args = [];
  if (update) args.push("--update");
  if (preferLocalDependencies) args.push("--prefer-local-dependencies");
  if (skipInventoryRefresh) args.push("--skip-inventory-refresh");
  if (retireAbsorbed) args.push("--retire-absorbed");
  args.push(
    "--targets",
    normalizeTargetList(targets),
    "--skills",
    Array.isArray(skillIds) ? skillIds.join(",") : String(skillIds),
  );
  return args;
}

export function buildGlobalMetaTheorySyncArgs({
  targets,
  withGlobalHooks = false,
} = {}) {
  const targetList = normalizeTargetList(targets);
  const args = ["--targets", targetList];
  if (
    withGlobalHooks &&
    targetList
      .split(",")
      .map((target) => target.trim())
      .some((target) => ["claude", "codex", "cursor", "gemini", "zcode"].includes(target))
  ) {
    args.push("--with-global-hooks");
  }
  return args;
}

/**
 * Build child-script arguments from an explicit CLI capability contract.
 *
 * Callers opt in by providing `language`. Scripts that do not declare a
 * language option receive only their own arguments, so strict parsers keep
 * rejecting unsupported flags.
 */
export function buildNodeScriptArgs(extraArgs = [], childCli = {}) {
  if (Array.isArray(childCli)) {
    throw new TypeError(
      "buildNodeScriptArgs child CLI contract must be an object; legacy langArgs arrays are not supported",
    );
  }
  const { language = null } = childCli;
  const languageArgs = language ? ["--lang", String(language)] : [];
  return [...languageArgs, ...extraArgs];
}

/**
 * Build a safe spawnSync payload for invoking Node.js scripts.
 *
 * We intentionally force shell=false on every platform. On Windows,
 * `shell:true` breaks absolute Node paths that contain spaces, e.g.
 * `C:\\Program Files\\nodejs\\node.exe`, and cmd.exe truncates them to
 * `C:\\Program`.
 */
export function buildNodeScriptSpawn(
  nodeExecPath,
  projectDir,
  scriptRelative,
  extraArgs = [],
  childCli = {},
) {
  const paths = path.win32.isAbsolute(projectDir) && !path.posix.isAbsolute(projectDir) ? path.win32 : path;
  return {
    command: nodeExecPath,
    args: [
      paths.join(projectDir, scriptRelative),
      ...buildNodeScriptArgs(extraArgs, childCli),
    ],
    options: {
      cwd: projectDir,
      stdio: "inherit",
      shell: false,
    },
  };
}

/** Build an invocation from setup's explicit child CLI capability registry. */
export function buildSetupNodeChildSpawn(
  nodeExecPath,
  projectDir,
  childId,
  extraArgs = [],
  language = null,
) {
  const contract = SETUP_NODE_CHILD_CONTRACTS[childId];
  if (!contract) {
    throw new Error(`Unknown setup child contract: ${childId}`);
  }
  return buildNodeScriptSpawn(
    nodeExecPath,
    projectDir,
    contract.scriptRelative,
    extraArgs,
    contract.languageOption ? { language } : {},
  );
}
