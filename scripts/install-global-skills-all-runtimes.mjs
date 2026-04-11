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

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveTargetContext } from "./meta-kim-sync-config.mjs";
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

    // findskill platform-specific subdir
    const findskillSubdir = os.platform() === "win32" ? "windows" : "original";

    // Transform manifest to script’s format
    const skillRepos = [];
    const claudePluginSpecs = [];

    for (const skill of manifest.skills) {
      const repo = skill.repo.replace("${skillOwner}", skillOwner);
      const fullUrl = `https://github.com/${repo}.git`;

      let subdir = skill.subdir;
      // Handle subdir with platform mapping
      if (skill.subdirTemplate === "{platform}" && skill.subdirMapping) {
        subdir =
          skill.subdirMapping[os.platform()] || skill.subdirMapping.default;
      }

      skillRepos.push({
        id: skill.id,
        repo: fullUrl,
        ...(subdir && { subdir }),
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

function runtimeDir(envKeys, fallbackName) {
  for (const key of envKeys) {
    const v = process.env[key];
    if (typeof v === "string" && v.trim()) {
      return path.resolve(v.trim());
    }
  }
  return path.join(os.homedir(), fallbackName);
}

function resolveHomes() {
  return {
    claude: runtimeDir(["META_KIM_CLAUDE_HOME", "CLAUDE_HOME"], ".claude"),
    codex: runtimeDir(["META_KIM_CODEX_HOME", "CODEX_HOME"], ".codex"),
    openclaw: runtimeDir(
      ["META_KIM_OPENCLAW_HOME", "OPENCLAW_HOME"],
      ".openclaw",
    ),
  };
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

function runGit(args, opts = {}) {
  if (dryRun) {
    console.log(t.dryRun(`git ${args.join(" ")}`));
    return;
  }
  execFileSync("git", args, { stdio: "inherit", ...opts });
}

async function installGitSkill(targetDir, repoUrl) {
  assertUnderHome(targetDir);
  if (await pathExists(targetDir)) {
    if (updateMode) {
      if (dryRun) {
        console.log(t.dryRun(`update ${targetDir}`));
        return;
      }
      try {
        runGit(["-C", targetDir, "pull", "--ff-only"]);
        console.log(`${C.green}✓${C.reset} ${t.okUpdated(targetDir)}`);
      } catch {
        console.warn(`${C.yellow}⚠${C.reset} ${t.warnPullFailed(targetDir)}`);
        await fs.rm(targetDir, { recursive: true, force: true });
        runGit(["clone", "--depth", "1", repoUrl, targetDir]);
        console.log(`${C.green}✓${C.reset} ${t.okCloned(targetDir)}`);
      }
    } else {
      console.log(
        `${C.yellow}⊘${C.reset} ${C.dim}${t.skipExists(targetDir)}${C.reset}`,
      );
    }
    return;
  }
  if (dryRun) {
    console.log(t.dryRun(`clone ${repoUrl} -> ${targetDir}`));
    return;
  }
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  runGit(["clone", "--depth", "1", repoUrl, targetDir]);
  console.log(`${C.green}✓${C.reset} ${t.okCloned(targetDir)}`);
}

async function installGitSkillFromSubdir(targetDir, repoUrl, subdirPath) {
  assertUnderHome(targetDir);
  if ((await pathExists(targetDir)) && !updateMode) {
    console.log(
      `${C.yellow}⊘${C.reset} ${C.dim}${t.skipExists(targetDir)}${C.reset}`,
    );
    return;
  }

  if (dryRun) {
    console.log(
      t.dryRun(`sparse install ${repoUrl} (${subdirPath}) -> ${targetDir}`),
    );
    return;
  }

  if ((await pathExists(targetDir)) && updateMode) {
    await fs.rm(targetDir, { recursive: true, force: true });
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-skill-"));
  try {
    runGit([
      "clone",
      "--depth",
      "1",
      "--filter=blob:none",
      "--sparse",
      repoUrl,
      tmp,
    ]);
    runGit(["sparse-checkout", "set", subdirPath], { cwd: tmp });
    const src = path.join(tmp, ...subdirPath.split("/").filter(Boolean));
    if (!(await pathExists(src))) {
      throw new Error(`Sparse checkout path missing after clone: ${src}`);
    }
    await fs.mkdir(path.dirname(targetDir), { recursive: true });
    await fs.cp(src, targetDir, { recursive: true, force: true });
    console.log(
      `${C.green}✓${C.reset} ${t.okBasename(path.basename(targetDir), targetDir)}`,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function installSkillCreator(targetBaseSkills) {
  const id = "skill-creator";
  const targetDir = path.join(targetBaseSkills, id);
  assertUnderHome(targetDir);

  if ((await pathExists(targetDir)) && !updateMode) {
    console.log(
      `${C.yellow}⊘${C.reset} ${C.dim}${t.skipExists(targetDir)}${C.reset}`,
    );
    return;
  }

  if (dryRun) {
    console.log(t.dryRun(`sparse install skill-creator -> ${targetDir}`));
    return;
  }

  if ((await pathExists(targetDir)) && updateMode) {
    await fs.rm(targetDir, { recursive: true, force: true });
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-skill-"));
  try {
    runGit(
      [
        "clone",
        "--depth",
        "1",
        "--filter=blob:none",
        "--sparse",
        "https://github.com/anthropics/skills.git",
        tmp,
      ],
      { cwd: undefined },
    );
    runGit(["sparse-checkout", "set", "skills/skill-creator"], { cwd: tmp });
    await fs.mkdir(targetBaseSkills, { recursive: true });
    await fs.cp(path.join(tmp, "skills", "skill-creator"), targetDir, {
      recursive: true,
      force: true,
    });
    console.log(
      `${C.green}✓${C.reset} ${t.okBasename("skill-creator", targetDir)}`,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function installAllSkillsForRuntime(label, skillsRoot, runtimeId) {
  console.log(`\n${C.bold}${AMBER}--- ${label}: ${skillsRoot} ---${C.reset}`);
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
      await installGitSkillFromSubdir(targetDir, spec.repo, spec.subdir);
    } else {
      await installGitSkill(targetDir, spec.repo);
    }
  }
  await installSkillCreator(skillsRoot);
}

function installClaudePlugins() {
  if (skipPlugins || CLAUDE_PLUGIN_SPECS.length === 0) {
    return;
  }
  console.log(
    `\n${C.bold}${AMBER}--- Claude Code plugins (user scope) ---${C.reset}`,
  );
  const r = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (r.status !== 0) {
    console.warn(`${C.yellow}⚠${C.reset} ${t.warnClaNotFound}`);
    return;
  }

  // Detect already-installed plugins so we skip re-installing them.
  // "claude plugin install" always exits 0 (even if already installed),
  // so we must check the plugin list first.
  const listOut = spawnSync("claude", ["plugins", "list", "--json"], {
    encoding: "utf8",
    shell: os.platform() === "win32",
  });
  let installedNames = new Set();
  if (listOut.status === 0 && listOut.stdout) {
    try {
      const plugins = JSON.parse(listOut.stdout);
      if (Array.isArray(plugins)) {
        for (const p of plugins) {
          // Plugin objects may have "name" or "id"; normalize to bare name.
          const name = (p.name || p.id || "").split("@")[0].trim();
          if (name) installedNames.add(name);
        }
      }
    } catch {
      // If JSON parse fails, fall through to blind install.
    }
  }

  for (const spec of CLAUDE_PLUGIN_SPECS) {
    // Extract bare name from spec like "superpowers@claude-plugins-official"
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
      shell: os.platform() === "win32",
    });
    if (p.status !== 0) {
      console.warn(
        `${C.yellow}⚠${C.reset} ${t.warnPluginFailed(spec, p.status)}`,
      );
    }
  }
}

async function main() {
  const { activeTargets } = await resolveTargetContext(cliArgs);
  const homes = resolveHomes();

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
  }

  if (activeTargets.includes("claude")) {
    installClaudePlugins();
  }

  // Optional: graphify (code knowledge graph)
  if (!pluginsOnly) {
    console.log(`\n${C.bold}${AMBER}--- Python Tools (optional) ---${C.reset}`);
    const pyCmd = ["python3", "python"].find((cmd) => {
      try {
        const r = spawnSync(cmd, ["--version"], {
          encoding: "utf8",
          shell: os.platform() === "win32",
        });
        if (r.status === 0) {
          const m = (r.stdout || "").match(/Python (\d+)\.(\d+)/);
          return m && (+m[1] > 3 || (+m[1] === 3 && +m[2] >= 10));
        }
      } catch {
        /* not found */
      }
      return false;
    });

    if (!pyCmd) {
      console.log(t.pythonNotFoundGraphify);
      console.log(t.pythonInstallHintGraphify);
    } else {
      // Check if graphify already installed via pip show (more reliable than --version)
      const pipCmd = pyCmd === "python3" ? "pip3" : "pip";
      const pipShow = spawnSync(pipCmd, ["show", "graphifyy"], {
        encoding: "utf8",
        shell: os.platform() === "win32",
      });
      if (pipShow.status === 0) {
        const versionMatch = (pipShow.stdout || "").match(/Version:\s*(.+)/);
        const version = versionMatch ? versionMatch[1].trim() : "unknown";
        console.log(t.skipGraphifyInstalled(version));
      } else {
        console.log(t.installingGraphify);
        const pipResult = spawnSync(pipCmd, ["install", "graphifyy"], {
          stdio: "pipe",
          shell: os.platform() === "win32",
        });
        if (pipResult.status === 0) {
          // Register Claude skill silently
          spawnSync(pyCmd, ["-m", "graphify", "claude", "install"], {
            stdio: "pipe",
            shell: os.platform() === "win32",
          });
          console.log(t.okGraphifyInstalled);
        } else {
          console.warn(`${C.yellow}⚠${C.reset} ${t.warnGraphifyPipFailed}`);
        }
      }
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
