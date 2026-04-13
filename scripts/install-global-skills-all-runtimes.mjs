#!/usr/bin/env node
/**
 * Cross-runtime install: clone the same third-party skill repos into
 * ~/.claude/skills, ~/.codex/skills, and ~/.openclaw/skills (plus optional
 * `claude plugin install …` for bundles that ship as official CC plugins).
 *
 * Flags:
 *   --update          git pull / re-clone skill dirs
 *   --dry-run         print actions only
 *   --plugins-only    only run `claude plugin install` (no git clones)
 *   --skip-plugins    skip `claude plugin install` even if defaults apply
 *
 * Env (optional): META_KIM_CLAUDE_HOME, CLAUDE_HOME, META_KIM_CODEX_HOME,
 * CODEX_HOME, META_KIM_OPENCLAW_HOME, OPENCLAW_HOME
 */

import { execFileSync, execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  detectPython310,
  extractPipShowVersion,
  readProcessText,
  runPythonModule,
} from "./graphify-runtime.mjs";
import {
  resolveManifestSkillSubdir,
  shouldUseCliShell,
} from "./install-platform-config.mjs";
import {
  buildGitHubTarballUrl,
  classifyGitInstallFailure,
  shouldUseArchiveFallback,
} from "./install-error-classifier.mjs";
import {
  detectLegacySubdirInstall,
  sanitizeInstalledSkillTree,
} from "./install-skill-sanitizer.mjs";
import { fileURLToPath } from "node:url";
import {
  resolveTargetContext,
  resolveRuntimeHomeDir,
} from "./meta-kim-sync-config.mjs";
import { t } from "./meta-kim-i18n.mjs";

// ── ANSI colors (matching setup.mjs) ─────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

// Deep amber colors matching setup.mjs logo
const AMBER = "\x1b[38;2;160;120;60m";
const AMBER_BRIGHT = "\x1b[38;2;200;160;80m";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const updateMode = process.argv.includes("--update");
const dryRun = process.argv.includes("--dry-run");
const pluginsOnly = process.argv.includes("--plugins-only");
const skipPlugins =
  process.argv.includes("--skip-plugins") ||
  process.argv.includes("--no-plugins");
const cliArgs = process.argv.slice(2);
const installFailures = [];
const archiveFallbacks = [];
const repairedInstallRoots = [];
const sanitizedSkillIssues = [];

/**
 * Load skills manifest from shared config (single source of truth)
 * Same as setup.mjs - ensures consistency across all installation paths
 */
function loadSkillsManifest() {
  const manifestPath = path.join(repoRoot, "config", "skills.json");
  try {
    const raw = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(raw);

    // Allow env var override
    const skillOwner =
      process.env.META_KIM_SKILL_OWNER || manifest.skillOwner || "KimYx0207";

    // Transform manifest to script’s format
    const skillRepos = [];
    const claudePluginSpecs = [];

    for (const skill of manifest.skills) {
      const repo = skill.repo.replace("${skillOwner}", skillOwner);
      const fullUrl = `https://github.com/${repo}.git`;

      const subdir = resolveManifestSkillSubdir(skill, os.platform());

      skillRepos.push({
        id: skill.id,
        repo: fullUrl,
        ...(subdir ? { subdir } : {}),
        targets: skill.targets || ["claude", "codex", "openclaw"],
      });

      if (skill.claudePlugin) {
        claudePluginSpecs.push(skill.claudePlugin);
      }
    }

    return { skillRepos, claudePluginSpecs };
  } catch (err) {
    console.warn(`${C.yellow}⚠${C.reset} ${t.failManifestLoad(err.message)}`);
    return { skillRepos: [], claudePluginSpecs: [] };
  }
}

const { skillRepos: SKILL_REPOS, claudePluginSpecs: CLAUDE_PLUGIN_SPECS } =
  loadSkillsManifest();

function resolveHomes() {
  return {
    claude: resolveRuntimeHomeDir("claude"),
    codex: resolveRuntimeHomeDir("codex"),
    openclaw: resolveRuntimeHomeDir("openclaw"),
    cursor: resolveRuntimeHomeDir("cursor"),
  };
}

function resolveCompatibilitySkillRoots(runtimeId, primarySkillsRoot) {
  if (runtimeId !== "codex") {
    return [];
  }

  const legacyCodexSkillsRoot = path.join(os.homedir(), ".agents", "skills");
  if (path.resolve(legacyCodexSkillsRoot) === path.resolve(primarySkillsRoot)) {
    return [];
  }

  return [legacyCodexSkillsRoot];
}

function assertUnderHome(resolved) {
  const home = path.resolve(os.homedir());
  const abs = path.resolve(resolved);
  if (abs !== home && !abs.startsWith(`${home}${path.sep}`)) {
    throw new Error(`Refusing to write outside user home: ${abs}`);
  }
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function isEmptyDir(dirPath) {
  try {
    const entries = await fs.readdir(dirPath);
    return entries.length === 0;
  } catch {
    return false;
  }
}

async function createSiblingStagingDir(targetDir, label = "staged") {
  const parentDir = path.dirname(targetDir);
  await fs.mkdir(parentDir, { recursive: true });
  return fs.mkdtemp(
    path.join(parentDir, `${path.basename(targetDir)}.${label}-`),
  );
}

function isWindowsLockError(error) {
  const code = error?.code || "";
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

async function replaceTargetDir(targetDir, stagedDir) {
  const parentDir = path.dirname(targetDir);
  const targetExists = await pathExists(targetDir);

  // No existing target — simple rename, always safe
  if (!targetExists) {
    await fs.rename(stagedDir, targetDir);
    return;
  }

  // Existing target — try atomic rename via backup
  const backupDir = path.join(
    parentDir,
    `${path.basename(targetDir)}.backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  let oldMoved = false;

  try {
    await fs.rename(targetDir, backupDir);
    oldMoved = true;
  } catch (error) {
    if (!isWindowsLockError(error)) throw error;
    // Target directory locked (Windows EPERM/EBUSY) — keep old in place,
    // fall through to copy-overwrite fallback
  }

  if (oldMoved) {
    try {
      await fs.rename(stagedDir, targetDir);
      await fs.rm(backupDir, { recursive: true, force: true });
      return;
    } catch (error) {
      // Restore old target before falling back
      if (!(await pathExists(targetDir)) && (await pathExists(backupDir))) {
        await fs.rename(backupDir, targetDir).catch(() => {});
      }
      if (!isWindowsLockError(error)) throw error;
      // Fall through to copy fallback
    }
  }

  // Copy fallback: Windows locks may prevent directory rename but allow
  // file-level deletes.  Clear the target first so stale old files don't
  // mix with the new sparse-checkout content.
  try {
    const entries = await fs.readdir(targetDir);
    for (const entry of entries) {
      await fs
        .rm(path.join(targetDir, entry), { recursive: true, force: true })
        .catch(() => {});
    }
  } catch {
    // Best-effort cleanup — locked entries will remain but cp force overwrites
  }
  await fs.mkdir(targetDir, { recursive: true });
  await fs.cp(stagedDir, targetDir, { recursive: true, force: true });
  await fs.rm(stagedDir, { recursive: true, force: true });
  if (oldMoved) {
    await fs.rm(backupDir, { recursive: true, force: true });
  }
}

async function repairManagedSkillTarget({
  skillId,
  targetDir,
  subdirPath,
  allowDelete = true,
}) {
  if (!(await pathExists(targetDir))) {
    return { repaired: false };
  }

  const isLegacySubdirInstall = await detectLegacySubdirInstall(
    targetDir,
    subdirPath,
  );
  if (!isLegacySubdirInstall) {
    return { repaired: false };
  }

  repairedInstallRoots.push({
    skillId,
    targetDir,
    subdirPath,
    action: allowDelete ? "reinstall" : "sanitize_only",
  });

  if (!allowDelete) {
    return { repaired: false, legacyDetected: true };
  }

  console.warn(
    `${C.yellow}⚠${C.reset} ${t.warnRepairLegacyLayout(skillId, targetDir)}`,
  );
  if (dryRun) {
    console.log(
      t.dryRun(`Replace malformed install during reinstall: ${targetDir}`),
    );
  }
  return { repaired: true, legacyDetected: true };
}

async function sanitizeManagedSkillTarget(skillId, targetDir) {
  if (!(await pathExists(targetDir))) {
    return;
  }

  const result = await sanitizeInstalledSkillTree(targetDir, { dryRun });
  if (result.quarantined === 0) {
    return;
  }

  sanitizedSkillIssues.push({
    skillId,
    targetDir,
    ...result,
  });

  for (const issue of result.invalidFiles) {
    const detail = path.relative(targetDir, issue.filePath).replace(/\\/g, "/");
    if (dryRun) {
      console.warn(
        `${C.yellow}⚠${C.reset} ${t.warnQuarantineDryRun(skillId, detail)}`,
      );
      continue;
    }

    console.warn(
      `${C.yellow}⚠${C.reset} ${t.warnQuarantined(skillId, detail)}`,
    );
  }
}

async function sanitizeCompatibilityRoots(runtimeId, primarySkillsRoot, spec) {
  const extraRoots = resolveCompatibilitySkillRoots(
    runtimeId,
    primarySkillsRoot,
  );
  for (const extraRoot of extraRoots) {
    const targetDir = path.join(extraRoot, spec.id);
    if (!(await pathExists(targetDir))) {
      continue;
    }

    // Detect legacy full-repo clone or stale empty directory
    const isLegacy =
      spec.subdir && (await detectLegacySubdirInstall(targetDir, spec.subdir));
    const targetEmpty = await isEmptyDir(targetDir);
    if (isLegacy || targetEmpty) {
      // Reinstall with proper sparse checkout — installGitSkillFromSubdir
      // handles its own repairManagedSkillTarget + replaceTargetDir logic
      console.warn(
        `${C.yellow}⚠${C.reset} ${t.warnRepairLegacySharedRoot(targetDir)}`,
      );
      if (spec.subdir) {
        await installGitSkillFromSubdir(
          spec.id,
          targetDir,
          spec.repo,
          spec.subdir,
        );
      } else {
        await installGitSkill(spec.id, targetDir, spec.repo);
      }
    } else {
      await sanitizeManagedSkillTarget(spec.id, targetDir);
    }
  }
}

function runGit(args, opts = {}) {
  if (dryRun) {
    console.log(t.dryRun(`git ${args.join(" ")}`));
    return { status: 0, stdout: "", stderr: "" };
  }
  const maxRetries = opts.retries ?? 3;
  const skillLabel = opts.skillLabel || args.join(" ");
  for (let attempt = 1; ; attempt++) {
    const spawnOpts = {
      encoding: "utf8",
      shell: false,
      stdio: "pipe",
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    };
    const result = spawnSync("git", args, spawnOpts);
    if (result.status === 0) {
      if (!opts.cwd) {
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
      }
      return result;
    }
    const error = new Error(`git ${args.join(" ")} failed`);
    error.status = result.status;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    const category = classifyGitInstallFailure(error);
    const isRetryable =
      category === "tls_transport" || category === "proxy_network";
    if (!isRetryable || attempt >= maxRetries) {
      if (!opts.cwd) {
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
      }
      throw error;
    }
    const delay = attempt * 2000;
    console.warn(
      `${C.yellow}⚠${C.reset} ${t.warnGitRetry(skillLabel, attempt, maxRetries, delay)}`,
    );
    spawnSync("sleep", [delay / 1000], { shell: true, stdio: "pipe" });
  }
}

function recordInstallFailure(details) {
  installFailures.push(details);
}

async function extractArchiveInto(targetDir, archivePath, subdirPath) {
  const extractDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "meta-kim-archive-"),
  );
  try {
    if (dryRun) {
      console.log(t.dryRun(`tar -xzf ${archivePath} -C ${extractDir}`));
    } else {
      // Use relative archive name + cwd to avoid Windows tar
      // misinterpreting "C:\path" as a remote host (colon syntax).
      execFileSync(
        "tar",
        ["-xzf", path.basename(archivePath), "-C", extractDir],
        {
          cwd: path.dirname(archivePath),
          stdio: "pipe",
        },
      );
    }

    const entries = await fs.readdir(extractDir, { withFileTypes: true });
    const rootEntry = entries.find((entry) => entry.isDirectory());
    if (!rootEntry) {
      throw new Error(
        `Archive extraction produced no root directory: ${archivePath}`,
      );
    }

    const rootDir = path.join(extractDir, rootEntry.name);
    const sourceDir = subdirPath
      ? path.join(rootDir, ...subdirPath.split("/").filter(Boolean))
      : rootDir;
    if (!(await pathExists(sourceDir))) {
      throw new Error(`Archive fallback missing subdir: ${sourceDir}`);
    }

    await fs.mkdir(path.dirname(targetDir), { recursive: true });
    await fs.cp(sourceDir, targetDir, { recursive: true, force: true });
  } finally {
    await fs.rm(extractDir, { recursive: true, force: true });
  }
}

async function installViaArchiveFallback({
  skillId,
  targetDir,
  displayTargetDir = targetDir,
  repoUrl,
  subdirPath,
  category,
  failureText,
}) {
  const archiveUrl = buildGitHubTarballUrl(repoUrl);
  if (!archiveUrl) {
    throw new Error(
      `Archive fallback only supports GitHub HTTPS remotes: ${repoUrl}`,
    );
  }

  const response = await fetch(archiveUrl, {
    headers: {
      "user-agent": "meta-kim/2.0",
      accept: "application/vnd.github+json",
    },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(
      `Archive fallback HTTP ${response.status} for ${archiveUrl}`,
    );
  }

  const archivePath = path.join(
    os.tmpdir(),
    `meta-kim-${Date.now()}-${path.basename(targetDir)}.tar.gz`,
  );
  try {
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(archivePath, buffer);
    await extractArchiveInto(targetDir, archivePath, subdirPath);
    archiveFallbacks.push({ skillId, targetDir: displayTargetDir, category });
    console.warn(
      `${C.yellow}⚠${C.reset} ${t.warnArchiveFallback(skillId, category)}`,
    );
    console.log(
      `${C.green}✓${C.reset} ${t.okArchiveInstalled(displayTargetDir)}`,
    );
  } catch (error) {
    recordInstallFailure({
      skillId,
      targetDir: displayTargetDir,
      repoUrl,
      category,
      failureText,
      fallback: "archive",
      reason: error.message,
    });
    console.warn(
      `${C.yellow}⚠${C.reset} ${t.warnArchiveFailed(skillId, category, error.message)}`,
    );
  } finally {
    await fs.rm(archivePath, { force: true });
  }
}

async function handleGitFailure({
  skillId,
  targetDir,
  displayTargetDir = targetDir,
  repoUrl,
  subdirPath,
  error,
}) {
  const category = classifyGitInstallFailure(error);
  const failureText = [error?.message, error?.stderr, error?.stdout]
    .filter(Boolean)
    .join("\n");

  if (shouldUseArchiveFallback(category)) {
    await installViaArchiveFallback({
      skillId,
      targetDir,
      displayTargetDir,
      repoUrl,
      subdirPath,
      category,
      failureText,
    });
    return;
  }

  recordInstallFailure({
    skillId,
    targetDir: displayTargetDir,
    repoUrl,
    category,
    failureText,
    fallback: "none",
    reason: error?.message || String(error),
  });
  console.warn(
    `${C.yellow}⚠${C.reset} ${t.warnGitInstallFailed(skillId, category)}`,
  );
}

async function installGitSkill(skillId, targetDir, repoUrl) {
  assertUnderHome(targetDir);
  await repairManagedSkillTarget({ skillId, targetDir });
  const targetExists = await pathExists(targetDir);
  const targetEmpty = targetExists && (await isEmptyDir(targetDir));
  if (targetExists && !targetEmpty) {
    if (updateMode) {
      if (dryRun) {
        console.log(t.dryRun(`update ${targetDir}`));
      } else {
        try {
          runGit(["-C", targetDir, "pull", "--ff-only"], {
            skillLabel: `pull ${skillId}`,
          });
          console.log(`${C.green}✓${C.reset} ${t.okUpdated(targetDir)}`);
        } catch {
          console.warn(`${C.yellow}⚠${C.reset} ${t.warnPullFailed(targetDir)}`);
          const stagedDir = await createSiblingStagingDir(targetDir);
          try {
            try {
              runGit(["clone", "--depth", "1", repoUrl, stagedDir], {
                skillLabel: `clone ${skillId}`,
              });
            } catch (error) {
              await handleGitFailure({
                skillId,
                targetDir: stagedDir,
                displayTargetDir: targetDir,
                repoUrl,
                error,
              });
            }

            if (
              (await pathExists(stagedDir)) &&
              !(await isEmptyDir(stagedDir))
            ) {
            }
          } catch (error) {
            console.warn(
              `${C.yellow}⚠${C.reset} ${t.warnReplaceFailed(skillId, targetDir, error.message)}`,
            );
          } finally {
            await fs.rm(stagedDir, { recursive: true, force: true });
          }
        }
      }
    } else {
      console.log(
        `${C.yellow}⊘${C.reset} ${C.dim}${t.skipExists(targetDir)}${C.reset}`,
      );
    }
    await sanitizeManagedSkillTarget(skillId, targetDir);
    return;
  }
  if (dryRun) {
    console.log(t.dryRun(`clone ${repoUrl} -> ${targetDir}`));
  } else {
    await fs.mkdir(path.dirname(targetDir), { recursive: true });
    try {
      runGit(["clone", "--depth", "1", repoUrl, targetDir], {
        skillLabel: `clone ${skillId}`,
      });
      console.log(`${C.green}✓${C.reset} ${t.okCloned(targetDir)}`);
    } catch (error) {
      await handleGitFailure({
        skillId,
        targetDir,
        repoUrl,
        error,
      });
    }
  }
  await sanitizeManagedSkillTarget(skillId, targetDir);
}

async function installGitSkillFromSubdir(
  skillId,
  targetDir,
  repoUrl,
  subdirPath,
) {
  assertUnderHome(targetDir);
  const repairResult = await repairManagedSkillTarget({
    skillId,
    targetDir,
    subdirPath,
  });
  const targetExists = await pathExists(targetDir);
  const targetEmpty = targetExists && (await isEmptyDir(targetDir));
  const shouldReplaceExisting =
    updateMode || repairResult.legacyDetected || targetEmpty;

  if (targetExists && !shouldReplaceExisting) {
    console.log(
      `${C.yellow}⊘${C.reset} ${C.dim}${t.skipExists(targetDir)}${C.reset}`,
    );
    await sanitizeManagedSkillTarget(skillId, targetDir);
    return;
  }

  if (dryRun) {
    console.log(
      t.dryRun(`sparse install ${repoUrl} (${subdirPath}) -> ${targetDir}`),
    );
    return;
  }

  const stagedTargetDir = await createSiblingStagingDir(targetDir);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-skill-"));
  try {
    try {
      runGit(
        [
          "clone",
          "--depth",
          "1",
          "--filter=blob:none",
          "--sparse",
          repoUrl,
          tmp,
        ],
        { skillLabel: `clone ${skillId}` },
      );
      runGit(["sparse-checkout", "set", subdirPath], {
        cwd: tmp,
        skillLabel: `checkout ${skillId}`,
      });
      const src = path.join(tmp, ...subdirPath.split("/").filter(Boolean));
      if (!(await pathExists(src))) {
        throw new Error(`Sparse checkout path missing after clone: ${src}`);
      }
      await fs.cp(src, stagedTargetDir, { recursive: true, force: true });
    } catch (error) {
      await handleGitFailure({
        skillId,
        targetDir: stagedTargetDir,
        displayTargetDir: targetDir,
        repoUrl,
        subdirPath,
        error,
      });
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }

  if (
    (await pathExists(stagedTargetDir)) &&
    !(await isEmptyDir(stagedTargetDir))
  ) {
    await replaceTargetDir(targetDir, stagedTargetDir);
    console.log(
      `${C.green}✓${C.reset} ${t.okBasename(path.basename(targetDir), targetDir)}`,
    );
  }

  await fs.rm(stagedTargetDir, { recursive: true, force: true });
  await sanitizeManagedSkillTarget(skillId, targetDir);
}

async function installSkillCreator(targetBaseSkills) {
  const id = "skill-creator";
  const targetDir = path.join(targetBaseSkills, id);
  await installGitSkillFromSubdir(
    id,
    targetDir,
    "https://github.com/anthropics/skills.git",
    "skills/skill-creator",
  );
}

async function installAllSkillsForRuntime(label, skillsRoot, runtimeId) {
  console.log(
    `\n${C.bold}${AMBER}${t.skillsHeader(label, skillsRoot)}${C.reset}`,
  );
  assertUnderHome(skillsRoot);
  if (!dryRun) {
    await fs.mkdir(skillsRoot, { recursive: true });
  }

  for (const spec of SKILL_REPOS) {
    if (spec.targets && !spec.targets.includes(runtimeId)) {
      console.log(
        `${C.yellow}⊘${C.reset} ${C.dim}${t.skipNotApplicable(spec.id, runtimeId)}${C.reset}`,
      );
      continue;
    }
    const targetDir = path.join(skillsRoot, spec.id);
    if (spec.subdir) {
      await installGitSkillFromSubdir(
        spec.id,
        targetDir,
        spec.repo,
        spec.subdir,
      );
    } else {
      await installGitSkill(spec.id, targetDir, spec.repo);
    }
    await sanitizeCompatibilityRoots(runtimeId, skillsRoot, spec);
  }
  const hasManifestSkillCreator = SKILL_REPOS.some(
    (spec) => spec.id === "skill-creator",
  );
  if (!hasManifestSkillCreator) {
    await installSkillCreator(skillsRoot);
  }
}

function installClaudePlugins() {
  if (skipPlugins || CLAUDE_PLUGIN_SPECS.length === 0) {
    return;
  }
  console.log(`\n${C.bold}${AMBER}${t.pluginsHeader}${C.reset}`);

  // Probe which claude invocation method works.
  // Windows edge-case: a broken npm .cmd shim may shadow a working
  // standalone .exe.  We try direct spawn first (skips .cmd), then
  // shell spawn (finds .cmd).  Whichever works is reused below.
  const isWin = os.platform() === "win32";
  const useShell = shouldUseCliShell(isWin);

  let claudeShellOpt = false;
  let claudeFound = false;

  // Strategy 1: direct spawn (finds .exe, skips broken .cmd shims on Windows)
  const direct = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (direct.status === 0) {
    claudeShellOpt = false;
    claudeFound = true;
  }

  // Strategy 2: shell spawn (finds .cmd wrappers for npm installs)
  if (!claudeFound && useShell) {
    const viaShell = spawnSync("claude", ["--version"], {
      encoding: "utf8",
      shell: true,
    });
    if (viaShell.status === 0) {
      claudeShellOpt = true;
      claudeFound = true;
    }
  }

  if (!claudeFound) {
    console.warn(`${C.yellow}⚠${C.reset} ${t.warnClaNotFound}`);
    return;
  }

  // Detect already-installed plugins so we skip re-installing them.
  const listOut = spawnSync("claude", ["plugins", "list", "--json"], {
    encoding: "utf8",
    shell: claudeShellOpt,
  });
  let installedNames = new Set();
  if (listOut.status === 0 && listOut.stdout) {
    try {
      const plugins = JSON.parse(listOut.stdout);
      if (Array.isArray(plugins)) {
        for (const p of plugins) {
          const name = (p.name || p.id || "").split("@")[0].trim();
          if (name) installedNames.add(name);
        }
      }
    } catch {
      // If JSON parse fails, fall through to blind install.
    }
  }

  for (const spec of CLAUDE_PLUGIN_SPECS) {
    const bareName = spec.split("@")[0];
    if (installedNames.has(bareName)) {
      console.log(
        `${C.yellow}⊘${C.reset} ${C.dim}${t.skipAlreadyInstalled(bareName)}${C.reset}`,
      );
      continue;
    }
    if (dryRun) {
      console.log(t.dryRun(`claude plugin install ${spec}`));
      continue;
    }
    console.log(`${C.cyan}→${C.reset} ${t.installingPlugin(spec)}`);
    const p = spawnSync("claude", ["plugin", "install", spec], {
      stdio: "inherit",
      shell: claudeShellOpt,
    });
    if (p.status !== 0) {
      console.warn(
        `${C.yellow}⚠${C.reset} ${t.warnPluginFailed(spec, p.status)}`,
      );
    }
  }
}

// ── Legacy artifact cleanup ──────────────────────────────────

/**
 * Detect and remove known legacy directory structures left by older
 * versions of Meta_Kim install scripts. Runs automatically during
 * every install/update so all users benefit.
 *
 * Known patterns:
 *   1. Nested runtime dir: ~/.claude/.claude/, ~/.codex/.codex/, etc.
 *      (caused by old global-sync writing project-level structure into
 *      the runtime home dir)
 *   2. Stale meta-kim install: ~/.claude/meta-kim/
 *      (old install artifact from pre-2.0 setup)
 */
async function cleanupLegacyGlobalArtifacts(homes) {
  const cleaned = [];

  // Pattern 1: nested runtime dir inside its own home
  // e.g. ~/.claude/.claude/, ~/.codex/.codex/, ~/.openclaw/.openclaw/, ~/.cursor/.cursor/
  for (const [runtimeId, homeDir] of Object.entries(homes)) {
    const runtimeDirName = path.basename(homeDir); // e.g. ".claude"
    const nestedDir = path.join(homeDir, runtimeDirName);
    if (await pathExists(nestedDir)) {
      console.warn(`${C.yellow}⚠${C.reset} ${t.warnRemovingObsoleteDir}`);
      console.warn(
        `${C.dim}  ${nestedDir}${C.reset} — ${t.warnNestedCopyNotUsed(runtimeId)}`,
      );
      if (!dryRun) {
        await fs.rm(nestedDir, { recursive: true, force: true });
      }
      cleaned.push(nestedDir);
    }
  }

  // Pattern 2: stale meta-kim install artifact inside Claude home
  const metaKimLegacy = path.join(homes.claude, "meta-kim");
  if (await pathExists(metaKimLegacy)) {
    console.warn(`${C.yellow}⚠${C.reset} ${t.warnRemovingObsoleteDir}`);
    console.warn(
      `${C.dim}  ${metaKimLegacy}${C.reset} — ${t.warnPre2Artifact}`,
    );
    if (!dryRun) {
      await fs.rm(metaKimLegacy, { recursive: true, force: true });
    }
    cleaned.push(metaKimLegacy);
  }

  if (cleaned.length > 0) {
    console.log(`${C.green}✓${C.reset} ${t.okRemovedObsolete(cleaned.length)}`);
    console.log(`${C.dim}  ${t.noteSettingsNotAffected}${C.reset}`);
  }
}

async function main() {
  const { activeTargets } = await resolveTargetContext(cliArgs);
  const homes = resolveHomes();

  // Clean up known legacy artifacts before any install operations
  await cleanupLegacyGlobalArtifacts(homes);

  if (!pluginsOnly) {
    if (activeTargets.includes("claude")) {
      await installAllSkillsForRuntime(
        "Claude Code skills",
        path.join(homes.claude, "skills"),
        "claude",
      );
    }
    if (activeTargets.includes("codex")) {
      await installAllSkillsForRuntime(
        "Codex skills",
        path.join(homes.codex, "skills"),
        "codex",
      );
    }
    if (activeTargets.includes("openclaw")) {
      await installAllSkillsForRuntime(
        "OpenClaw skills",
        path.join(homes.openclaw, "skills"),
        "openclaw",
      );
    }
    if (activeTargets.includes("cursor")) {
      await installAllSkillsForRuntime(
        "Cursor skills",
        path.join(homes.cursor, "skills"),
        "cursor",
      );
    }
  }

  if (activeTargets.includes("claude")) {
    installClaudePlugins();
  }

  // Optional: graphify (code knowledge graph)
  if (!pluginsOnly) {
    console.log(`\n${C.bold}${AMBER}${t.pythonToolsOptionalHeader}${C.reset}`);
    const python = detectPython310();

    if (!python) {
      console.log(t.pythonNotFoundGraphify);
      console.log(t.pythonInstallHintGraphify);
    } else {
      // Check if graphify already installed via pip show (more reliable than --version)
      const pipShow = runPythonModule(python, [
        "-m",
        "pip",
        "show",
        "graphifyy",
      ]);
      if (pipShow.status === 0) {
        const version =
          extractPipShowVersion(readProcessText(pipShow)) ?? "unknown";
        console.log(t.skipGraphifyInstalled(version));
      } else {
        console.log(t.installingGraphify);
        const pipResult = runPythonModule(
          python,
          ["-m", "pip", "install", "graphifyy"],
          undefined,
          { stdio: "pipe" },
        );
        if (pipResult.status === 0) {
          // Register Claude skill silently
          runPythonModule(
            python,
            ["-m", "graphify", "claude", "install"],
            undefined,
            { stdio: "pipe" },
          );
          console.log(t.okGraphifyInstalled);
        } else {
          console.warn(`${C.yellow}⚠${C.reset} ${t.warnGraphifyPipFailed}`);
        }
      }
    }
  }

  // Print failure summary if any skills failed
  if (installFailures.length > 0) {
    console.log(
      `\n${C.yellow}${C.bold}${t.summaryInstallFailures(installFailures.length)}${C.reset}`,
    );
    for (const failure of installFailures) {
      const category = failure.category || "unknown";
      console.log(
        `  ${C.red}✗${C.reset} ${failure.skillId} → ${category} (${failure.targetDir})`,
      );
    }
  }
  if (archiveFallbacks.length > 0) {
    console.log(
      `\n${C.yellow}${t.summaryArchiveFallbacks(archiveFallbacks.length)}${C.reset}`,
    );
    for (const fb of archiveFallbacks) {
      console.log(
        `  ${C.yellow}⚠${C.reset} ${fb.skillId} used archive fallback (${fb.category})`,
      );
    }
  }

  if (repairedInstallRoots.length > 0) {
    console.log(
      `\n${C.yellow}${t.summaryRepairedOrFlagged(repairedInstallRoots.length)}${C.reset}`,
    );
    for (const repair of repairedInstallRoots) {
      console.log(
        `  ${C.yellow}⚠${C.reset} ${repair.skillId} -> ${repair.action} (${repair.targetDir})`,
      );
    }
  }
  if (sanitizedSkillIssues.length > 0) {
    console.log(
      `\n${C.yellow}${t.summaryQuarantined(sanitizedSkillIssues.reduce((sum, item) => sum + item.quarantined, 0))}${C.reset}`,
    );
    for (const item of sanitizedSkillIssues) {
      console.log(
        `  ${C.yellow}⚠${C.reset} ${item.skillId} -> ${item.quarantined} file(s) in ${item.targetDir}`,
      );
    }
  }

  console.log(`\n${t.done}`);
  console.log(t.noteCodexOpenclaw);
  console.log(t.activeTargets(activeTargets));
  console.log(t.metaKimRoot(repoRoot));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
