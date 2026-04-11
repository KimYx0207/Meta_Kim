#!/usr/bin/env node
/**
 * Global sync: canonical meta-theory skill + Meta_Kim Claude runtime hook assets into runtime homes.
 * Flags: --check, --print-targets, --skip-global-hooks (skip Claude hooks copy + settings merge).
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  canonicalRuntimeAssetsDir,
  canonicalSkillRoot,
  resolveTargetContext,
} from "./meta-kim-sync-config.mjs";

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

const runtimeSpecs = {
  claude: {
    label: "Claude Code",
    envKeys: ["META_KIM_CLAUDE_HOME", "CLAUDE_HOME"],
    defaultDirName: ".claude",
    requiredMarkers: ["skills"],
    preferredMarkers: ["settings.json", "agents"],
  },
  openclaw: {
    label: "OpenClaw",
    envKeys: ["META_KIM_OPENCLAW_HOME", "OPENCLAW_HOME"],
    defaultDirName: ".openclaw",
    requiredMarkers: ["skills"],
    preferredMarkers: ["openclaw.json", "config.yaml"],
  },
  codex: {
    label: "Codex",
    envKeys: ["META_KIM_CODEX_HOME", "CODEX_HOME"],
    defaultDirName: ".codex",
    requiredMarkers: ["skills"],
    preferredMarkers: ["config.toml", "commands"],
  },
  cursor: {
    label: "Cursor",
    envKeys: ["META_KIM_CURSOR_HOME", "CURSOR_HOME"],
    defaultDirName: ".cursor",
    requiredMarkers: ["skills"],
    preferredMarkers: ["mcp.json", "agents"],
  },
};
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

async function hasRequiredMarkers(candidateDir, spec) {
  const checks = await Promise.all(
    spec.requiredMarkers.map((marker) =>
      pathExists(path.join(candidateDir, marker)),
    ),
  );
  return checks.every(Boolean);
}

async function countPreferredMarkers(candidateDir, spec) {
  const checks = await Promise.all(
    spec.preferredMarkers.map((marker) =>
      pathExists(path.join(candidateDir, marker)),
    ),
  );
  return checks.filter(Boolean).length;
}

function uniquePaths(paths) {
  return [...new Set(paths.map((entry) => path.resolve(entry)))];
}

async function findNestedRuntimeHome(spec) {
  const homeDir = path.resolve(os.homedir());
  const candidates = [
    path.join(homeDir, spec.defaultDirName),
    path.join(homeDir, ".config", spec.defaultDirName.replace(/^\./, "")),
    path.join(homeDir, ".config", spec.defaultDirName),
  ];

  let bestMatch = null;

  for (const candidate of uniquePaths(candidates)) {
    if (!(await pathExists(candidate))) {
      continue;
    }
    if (!(await hasRequiredMarkers(candidate, spec))) {
      continue;
    }
    const score = await countPreferredMarkers(candidate, spec);
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { dir: candidate, score };
    }
  }

  return bestMatch?.dir ?? null;
}

async function resolveRuntimeHome(spec) {
  for (const key of spec.envKeys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) {
      return {
        dir: path.resolve(value.trim()),
        source: `env:${key}`,
      };
    }
  }

  const discovered = await findNestedRuntimeHome(spec);
  if (discovered) {
    return {
      dir: discovered,
      source:
        discovered ===
        path.join(path.resolve(os.homedir()), spec.defaultDirName)
          ? "default"
          : "search",
    };
  }

  return {
    dir: path.join(path.resolve(os.homedir()), spec.defaultDirName),
    source: "fallback",
  };
}

async function resolveTargets() {
  const targetContext = await resolveTargetContext(cliArgs);
  runtimeHomes = {
    claude: await resolveRuntimeHome(runtimeSpecs.claude),
    openclaw: await resolveRuntimeHome(runtimeSpecs.openclaw),
    codex: await resolveRuntimeHome(runtimeSpecs.codex),
    cursor: await resolveRuntimeHome(runtimeSpecs.cursor),
  };

  selectedTargetIds = [...targetContext.activeTargets];

  allowedRoots = Object.values(runtimeHomes).map(({ dir }) =>
    path.resolve(dir),
  );

  activeTargets = selectedTargetIds.map((targetId) => ({
    targetId,
    label: `${runtimeSpecs[targetId].label} global skill`,
    dir: path.join(runtimeHomes[targetId].dir, "skills", "meta-theory"),
  }));

  cleanupTargets = [
    {
      label: "legacy OpenClaw flat skill",
      dir: path.join(runtimeHomes.openclaw.dir, "skills", "meta-theory.md"),
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

async function copyCanonicalSkill(targetDir) {
  assertHomeBound(targetDir);
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.cp(sourceDir, targetDir, { recursive: true, force: true });
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

function isMetaKimManagedHookCommand(command) {
  if (typeof command !== "string") {
    return false;
  }
  return (
    command.includes("hooks/meta-kim/") || command.includes("hooks\\meta-kim\\")
  );
}

function hookCommandNode(absScriptPath) {
  return `node ${JSON.stringify(absScriptPath)}`;
}

/** Hook blocks matching Meta_Kim canonical runtime asset for Claude settings (absolute script paths). */
function buildMetaKimHooksTemplate(absHooksDir) {
  const cmd = (name) => ({
    type: "command",
    command: hookCommandNode(path.join(absHooksDir, name)),
  });

  return {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [
          cmd("block-dangerous-bash.mjs"),
          cmd("pre-git-push-confirm.mjs"),
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: "Edit|Write",
        hooks: [
          cmd("post-format.mjs"),
          cmd("post-typecheck.mjs"),
          cmd("post-console-log-warn.mjs"),
        ],
      },
    ],
    SubagentStart: [
      {
        matcher: "*",
        hooks: [cmd("subagent-context.mjs")],
      },
    ],
    Stop: [
      {
        matcher: "*",
        hooks: [
          cmd("stop-console-log-audit.mjs"),
          cmd("stop-completion-guard.mjs"),
        ],
      },
    ],
  };
}

function stripMetaKimHookEntriesFromBlocks(blocks) {
  return blocks
    .map((block) => ({
      ...block,
      hooks: (block.hooks || []).filter(
        (h) => !isMetaKimManagedHookCommand(h.command || ""),
      ),
    }))
    .filter((block) => (block.hooks || []).length > 0);
}

function mergeHookMatcherBlocks(existing, additions) {
  const result = structuredClone(existing);
  for (const addBlock of additions) {
    const idx = result.findIndex((b) => b.matcher === addBlock.matcher);
    if (idx === -1) {
      result.push(structuredClone(addBlock));
      continue;
    }
    const cmds = new Set(
      (result[idx].hooks || []).map((h) => h.command).filter(Boolean),
    );
    for (const h of addBlock.hooks || []) {
      if (!cmds.has(h.command)) {
        if (!result[idx].hooks) {
          result[idx].hooks = [];
        }
        result[idx].hooks.push(h);
        cmds.add(h.command);
      }
    }
  }
  return result;
}

function mergeMetaKimHooksIntoSettings(settings, template) {
  const next = { ...settings };
  if (!next.hooks) {
    next.hooks = {};
  }
  const hooks = { ...next.hooks };

  for (const [event, additionBlocks] of Object.entries(template)) {
    const cleaned = stripMetaKimHookEntriesFromBlocks(hooks[event] || []);
    hooks[event] = mergeHookMatcherBlocks(cleaned, additionBlocks);
  }

  next.hooks = hooks;
  return next;
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
}

async function syncClaudeGlobalSettingsHooks() {
  const absHooks = globalMetaKimHooksDir();
  const settingsPath = path.join(runtimeHomes.claude.dir, "settings.json");
  assertHomeBound(settingsPath);

  const template = buildMetaKimHooksTemplate(absHooks);
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

  const merged = mergeMetaKimHooksIntoSettings(base, template);
  const out = `${JSON.stringify(merged, null, 2)}\n`;
  const prev = (await pathExists(settingsPath))
    ? await fs.readFile(settingsPath, "utf8")
    : null;

  if (prev === out) {
    console.log(
      `Claude Code settings hooks already up to date: ${settingsPath}`,
    );
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

  process.exitCode = failed ? 1 : 0;
}

async function runSync() {
  // Leading newline to separate from parent's progress message
  console.log("");
  if (!(await pathExists(sourceSkillFile))) {
    throw new Error(`Missing canonical skill source: ${sourceSkillFile}`);
  }

  for (const target of cleanupTargets) {
    const removed = await removeIfExists(target.dir);
    if (removed) {
      console.log(
        `${C.green}✓${C.reset} ${C.dim}Removed ${target.label}: ${target.dir}${C.reset}`,
      );
    }
  }

  for (const target of activeTargets) {
    await copyCanonicalSkill(target.dir);
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
