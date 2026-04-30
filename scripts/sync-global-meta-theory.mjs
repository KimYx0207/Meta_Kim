#!/usr/bin/env node
/**
 * Global sync: canonical meta-theory skill + Meta_Kim Claude runtime hook assets into runtime homes.
 * Flags: --check, --print-targets, --skip-global-hooks (skip Claude hooks copy + settings merge).
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  buildMetaKimHooksTemplate,
  mergeGlobalMetaKimHooksIntoSettings,
} from "./claude-settings-merge.mjs";
import {
  canonicalRuntimeAssetsDir,
  canonicalSkillRoot,
  resolveTargetContext,
  resolveRuntimeHomeInfo,
} from "./meta-kim-sync-config.mjs";
import { CATEGORIES, openRecorder } from "./install-manifest.mjs";

// Recorder is lazily opened in runSync(); helpers record through this holder
// so we do not have to thread recorder arg through every sync function.
let manifestRecorder = null;
function recordSafe(fn) {
  if (!manifestRecorder) return;
  try {
    fn(manifestRecorder);
  } catch {
    /* recorder never breaks sync */
  }
}

// ANSI colors matching setup.mjs
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  amber: "\x1b[38;2;160;120;60m",
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const sourceDir = canonicalSkillRoot;
const sourceSkillFile = path.join(sourceDir, "SKILL.md");

const checkOnly = process.argv.includes("--check");
const printTargetsOnly = process.argv.includes("--print-targets");
const skipGlobalHooks = process.argv.includes("--skip-global-hooks");
const cliArgs = process.argv.slice(2);

const repoHooksDir = path.join(canonicalRuntimeAssetsDir, "claude", "hooks");
const codexMetaTheoryCommandSource = path.join(
  canonicalRuntimeAssetsDir,
  "codex",
  "commands",
  "meta-theory.md",
);

let runtimeHomes = {};
let allowedRoots = [];
let activeTargets = [];
let cleanupTargets = [];
let selectedTargetIds = [];

function assertHomeBound(targetPath) {
  const resolved = path.resolve(targetPath);
  const isAllowed = allowedRoots.some(
    (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`),
  );
  if (!isAllowed) {
    throw new Error(
      `Refusing to write outside the configured runtime homes: ${resolved}`,
    );
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveTargets() {
  const targetContext = await resolveTargetContext(cliArgs);
  runtimeHomes = {
    claude: resolveRuntimeHomeInfo("claude"),
    openclaw: resolveRuntimeHomeInfo("openclaw"),
    codex: resolveRuntimeHomeInfo("codex"),
    cursor: resolveRuntimeHomeInfo("cursor"),
  };

  selectedTargetIds = [...targetContext.activeTargets];

  allowedRoots = Object.values(runtimeHomes).map(({ dir }) =>
    path.resolve(dir),
  );

  activeTargets = selectedTargetIds.map((targetId) => ({
    targetId,
    label: `${targetContext.profiles[targetId]?.label ?? targetId} global skill`,
    dir: path.join(runtimeHomes[targetId].dir, "skills", "meta-theory"),
  }));

  cleanupTargets = [
    {
      label: "legacy Claude Code flat skill",
      dir: path.join(runtimeHomes.claude.dir, "skills", "meta-theory.md"),
    },
    {
      label: "legacy Codex flat skill",
      dir: path.join(runtimeHomes.codex.dir, "skills", "meta-theory.md"),
    },
    {
      label: "legacy OpenClaw flat skill",
      dir: path.join(runtimeHomes.openclaw.dir, "skills", "meta-theory.md"),
    },
    {
      label: "legacy Cursor flat skill",
      dir: path.join(runtimeHomes.cursor.dir, "skills", "meta-theory.md"),
    },
  ];
}

async function* walkFiles(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath);
      continue;
    }
    if (entry.isFile()) {
      yield fullPath;
    }
  }
}

async function fingerprintDir(rootDir) {
  if (!(await pathExists(rootDir))) {
    return null;
  }

  const filePaths = [];
  for await (const filePath of walkFiles(rootDir)) {
    filePaths.push(filePath);
  }
  filePaths.sort((left, right) => left.localeCompare(right));

  const hash = createHash("sha256");
  for (const filePath of filePaths) {
    const relativePath = path.relative(rootDir, filePath).replace(/\\/g, "/");
    hash.update(relativePath);
    hash.update("\n");
    hash.update(await fs.readFile(filePath));
    hash.update("\n");
  }

  return {
    fileCount: filePaths.length,
    hash: hash.digest("hex"),
  };
}

async function copyCanonicalSkill(targetDir, targetId) {
  assertHomeBound(targetDir);
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.cp(sourceDir, targetDir, { recursive: true, force: true });
  recordSafe((rec) =>
    rec.recordDir(targetDir, {
      source: "sync-global-meta-theory",
      purpose: `${targetId ?? "runtime"}-global-skill`,
      category: CATEGORIES.A,
    }),
  );
}

async function copyCodexMetaTheoryCommand() {
  const commandsDir = path.join(runtimeHomes.codex.dir, "commands");
  const targetPath = path.join(commandsDir, "meta-theory.md");
  assertHomeBound(targetPath);
  if (!(await pathExists(codexMetaTheoryCommandSource))) {
    throw new Error(
      `Missing canonical Codex command source: ${codexMetaTheoryCommandSource}`,
    );
  }
  await fs.mkdir(commandsDir, { recursive: true });
  await fs.copyFile(codexMetaTheoryCommandSource, targetPath);
  recordSafe((rec) =>
    rec.recordFile(targetPath, {
      source: "sync-global-meta-theory",
      purpose: "codex-global-command",
      category: CATEGORIES.A,
    }),
  );
  return targetPath;
}

async function removeIfExists(targetPath) {
  assertHomeBound(targetPath);
  if (!(await pathExists(targetPath))) {
    return false;
  }
  await fs.rm(targetPath, { recursive: true, force: true });
  return true;
}

function globalMetaKimHooksDir() {
  return path.join(runtimeHomes.claude.dir, "hooks", "meta-kim");
}

async function copyCanonicalHooksToGlobal() {
  const dest = globalMetaKimHooksDir();
  assertHomeBound(dest);
  if (!(await pathExists(repoHooksDir))) {
    throw new Error(`Missing canonical hooks source: ${repoHooksDir}`);
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rm(dest, { recursive: true, force: true });
  await fs.cp(repoHooksDir, dest, { recursive: true, force: true });
  recordSafe((rec) =>
    rec.recordDir(dest, {
      source: "sync-global-meta-theory",
      purpose: "claude-global-hooks-dir",
      category: CATEGORIES.B,
    }),
  );
  try {
    const entries = await fs.readdir(dest, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      recordSafe((rec) =>
        rec.recordFile(path.join(dest, entry.name), {
          source: "sync-global-meta-theory",
          purpose: "claude-global-hook",
          category: CATEGORIES.B,
        }),
      );
    }
  } catch {
    /* directory iteration best-effort */
  }
}

async function syncClaudeGlobalSettingsHooks() {
  const absHooks = globalMetaKimHooksDir();
  const settingsPath = path.join(runtimeHomes.claude.dir, "settings.json");
  assertHomeBound(settingsPath);

  const template = buildMetaKimHooksTemplate(absHooks);
  const recordSettingsMerge = () => {
    recordSafe((rec) => {
      const managedCommands = [];
      for (const blocks of Object.values(template)) {
        for (const block of blocks ?? []) {
          for (const h of block.hooks ?? []) {
            if (h?.command) managedCommands.push(h.command);
          }
        }
      }
      rec.recordSettingsMerge(settingsPath, managedCommands, {
        source: "sync-global-meta-theory",
        purpose: "claude-global-settings-merge",
        category: CATEGORIES.C,
      });
    });
  };

  let base = {};
  if (await pathExists(settingsPath)) {
    const raw = await fs.readFile(settingsPath, "utf8");
    try {
      base = JSON.parse(raw);
    } catch {
      throw new Error(
        `Invalid JSON in ${settingsPath}; fix or move aside before sync.`,
      );
    }
  }

  if (base.disableAllHooks === true) {
    console.warn(
      "Warning: ~/.claude/settings.json has disableAllHooks=true — Meta_Kim hook entries were merged but will not run until disabled.",
    );
  }

  const merged = mergeGlobalMetaKimHooksIntoSettings(base, template);
  const out = `${JSON.stringify(merged, null, 2)}\n`;
  const prev = (await pathExists(settingsPath))
    ? await fs.readFile(settingsPath, "utf8")
    : null;

  if (prev === out) {
    console.log(
      `Claude Code settings hooks already up to date: ${settingsPath}`,
    );
    recordSettingsMerge();
    return;
  }

  if (prev !== null) {
    const bak = `${settingsPath}.meta-kim.bak`;
    assertHomeBound(bak);
    await fs.copyFile(settingsPath, bak);
    console.log(`Backed up previous settings to ${bak}`);
  }

  await fs.writeFile(settingsPath, out, "utf8");
  console.log(`Merged Meta_Kim hooks into ${settingsPath}`);
  recordSettingsMerge();
}

async function runCheck() {
  const sourceFingerprint = await fingerprintDir(sourceDir);
  let failed = false;

  for (const target of activeTargets) {
    const targetFingerprint = await fingerprintDir(target.dir);
    const inSync =
      targetFingerprint !== null &&
      sourceFingerprint !== null &&
      targetFingerprint.hash === sourceFingerprint.hash &&
      targetFingerprint.fileCount === sourceFingerprint.fileCount;
    console.log(
      `${inSync ? `${C.green}✓${C.reset}` : `${C.yellow}⊘${C.reset}`} ${C.dim}${target.label}: ${target.dir}${C.reset}`,
    );
    if (!inSync) {
      failed = true;
    }
  }

  for (const target of cleanupTargets) {
    const exists = await pathExists(target.dir);
    console.log(
      `${exists ? `${C.yellow}⊘${C.reset}` : `${C.green}✓${C.reset}`} ${C.dim}${target.label}: ${target.dir}${C.reset}`,
    );
    if (exists) {
      failed = true;
    }
  }

  if (selectedTargetIds.includes("claude") && !skipGlobalHooks) {
    const repoHooksFp = await fingerprintDir(repoHooksDir);
    const globalHooksPath = globalMetaKimHooksDir();
    const globalHooksFp = await fingerprintDir(globalHooksPath);
    const hooksInSync =
      repoHooksFp !== null &&
      globalHooksFp !== null &&
      repoHooksFp.hash === globalHooksFp.hash &&
      repoHooksFp.fileCount === globalHooksFp.fileCount;
    console.log(
      `${hooksInSync ? `${C.green}✓${C.reset}` : `${C.yellow}⊘${C.reset}`} ${C.dim}Claude Code global hooks (meta-kim): ${globalHooksPath}${C.reset}`,
    );
    if (!hooksInSync) {
      failed = true;
    }
  }

  if (selectedTargetIds.includes("codex")) {
    const commandPath = path.join(
      runtimeHomes.codex.dir,
      "commands",
      "meta-theory.md",
    );
    const sourceRaw = await fs.readFile(codexMetaTheoryCommandSource, "utf8");
    const targetRaw = (await pathExists(commandPath))
      ? await fs.readFile(commandPath, "utf8")
      : null;
    const commandInSync = targetRaw === sourceRaw;
    console.log(
      `${commandInSync ? `${C.green}✓${C.reset}` : `${C.yellow}⊘${C.reset}`} ${C.dim}Codex /meta-theory command: ${commandPath}${C.reset}`,
    );
    if (!commandInSync) {
      failed = true;
    }
  }

  process.exitCode = failed ? 1 : 0;
}

async function runSync() {
  // Leading newline to separate from parent's progress message
  console.log("");
  if (!(await pathExists(sourceSkillFile))) {
    throw new Error(`Missing canonical skill source: ${sourceSkillFile}`);
  }
  manifestRecorder = openRecorder({
    scope: "global",
    metaKimVersion: process.env.META_KIM_VERSION ?? null,
    replaceSources: ["sync-global-meta-theory"],
  });

  for (const target of cleanupTargets) {
    const removed = await removeIfExists(target.dir);
    if (removed) {
      console.log(
        `${C.green}✓${C.reset} ${C.dim}Removed ${target.label}: ${target.dir}${C.reset}`,
      );
    }
  }

  for (const target of activeTargets) {
    await copyCanonicalSkill(target.dir, target.targetId);
    console.log(
      `${C.green}✓${C.reset} ${C.dim}Synced ${target.label}: ${target.dir}${C.reset}`,
    );
  }

  if (selectedTargetIds.includes("claude") && !skipGlobalHooks) {
    await copyCanonicalHooksToGlobal();
    console.log(
      `${C.green}✓${C.reset} ${C.dim}Synced Claude Code global hooks: ${globalMetaKimHooksDir()}${C.reset}`,
    );
    await syncClaudeGlobalSettingsHooks();
  } else {
    console.log(
      `${C.yellow}⊘${C.reset} ${C.dim}Skipped Claude Code global hooks.${C.reset}`,
    );
  }

  if (selectedTargetIds.includes("codex")) {
    const commandPath = await copyCodexMetaTheoryCommand();
    console.log(
      `${C.green}✓${C.reset} ${C.dim}Synced Codex /meta-theory command: ${commandPath}${C.reset}`,
    );
  }

  if (manifestRecorder) {
    const result = await manifestRecorder.flush();
    if (result.ok) {
      console.log(
        `${C.green}✓${C.reset} ${C.dim}Install manifest: ${result.path} (${result.entries} entries)${C.reset}`,
      );
    }
  }
}

function printTargets() {
  console.log("Resolved runtime homes:");
  console.log(
    `- Claude Code: ${runtimeHomes.claude.dir} (${runtimeHomes.claude.source})`,
  );
  console.log(
    `- OpenClaw: ${runtimeHomes.openclaw.dir} (${runtimeHomes.openclaw.source})`,
  );
  console.log(
    `- Codex: ${runtimeHomes.codex.dir} (${runtimeHomes.codex.source})`,
  );
  console.log(
    `- Cursor: ${runtimeHomes.cursor.dir} (${runtimeHomes.cursor.source})`,
  );
  console.log("");
  console.log("Resolved active targets:");
  for (const target of activeTargets) {
    console.log(`- ${target.label}: ${target.dir}`);
  }
  console.log("");
  console.log("Environment overrides:");
  console.log("- META_KIM_CLAUDE_HOME or CLAUDE_HOME");
  console.log("- META_KIM_OPENCLAW_HOME or OPENCLAW_HOME");
  console.log("- META_KIM_CODEX_HOME or CODEX_HOME");
  console.log("- META_KIM_CURSOR_HOME or CURSOR_HOME");
  console.log("");
  console.log("Codex slash command (when codex is an active target):");
  console.log(
    `- ${path.join(runtimeHomes.codex.dir, "commands", "meta-theory.md")}`,
  );
  console.log("");
  console.log("Claude Code hooks (unless --skip-global-hooks):");
  console.log(`- Scripts: ${globalMetaKimHooksDir()}`);
  console.log(
    `- Merged into: ${path.join(runtimeHomes.claude.dir, "settings.json")}`,
  );
}

async function main() {
  await resolveTargets();
  if (printTargetsOnly) {
    printTargets();
    return;
  }
  if (checkOnly) {
    await runCheck();
    return;
  }
  await runSync();
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
