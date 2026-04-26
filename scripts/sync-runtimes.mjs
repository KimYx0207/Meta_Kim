import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  buildMetaKimHooksTemplate,
  mergeGlobalMetaKimHooksIntoSettings,
  mergeRepoClaudeSettings,
} from "./claude-settings-merge.mjs";
import {
  canonicalAgentsDir,
  canonicalRuntimeAssetsDir,
  canonicalSkillPath,
  canonicalSkillReferencesDir,
  repoRoot,
  resolveTargetContext,
  parseScopeArg,
  assertHomeBound,
  resolveRuntimeProjection,
  resolveRuntimeAllowedRoots,
} from "./meta-kim-sync-config.mjs";
import { t } from "./meta-kim-i18n.mjs";
import { CATEGORIES, openRecorder } from "./install-manifest.mjs";

const cliArgs = process.argv.slice(2);
const checkOnly = process.argv.includes("--check");
const jsonMode = process.argv.includes("--json");

// Captures "will be written" entries whenever writeGeneratedFile runs under
// --check. Populated even when not in --json mode so callers get deterministic
// planning data; consumers just ignore it when they do not need it.
const staleFiles = [];

// Recorder is lazily opened in main() when scope includes "project" so every
// write point (writeGeneratedFile / writeGeneratedJson) can record through
// this shared holder without plumbing a recorder arg through every build fn.
// Failures are swallowed — a manifest glitch must never break sync itself.
let manifestRecorder = null;
function recordSafe(fn) {
  if (!manifestRecorder) return;
  try {
    fn(manifestRecorder);
  } catch {
    /* recorder never breaks sync */
  }
}

/**
 * Map a sync write target to a project manifest category (D..H / G).
 * Returns null when the path is outside the repo or not one of the known
 * projection roots — those writes stay unrecorded rather than polluting
 * the manifest with ambiguous entries.
 *
 * Category semantics (see install-manifest.mjs CATEGORY_LABELS):
 *   D = Project runtime skills   (.claude/skills, .codex/skills, ...)
 *   E = Project runtime hooks    (.claude/hooks/*.mjs)
 *   F = Project runtime agents   (.claude/agents, .codex/agents, .cursor/agents)
 *   G = Project settings + MCP   (.claude/settings.json, .mcp.json, .codex/*.toml)
 */
export function inferProjectCategory(filePath, rootDir = repoRoot) {
  if (typeof filePath !== "string" || !filePath) return null;
  const rel = path.relative(rootDir, filePath).replace(/\\/g, "/");
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  if (rel === ".claude/settings.json" || rel === ".mcp.json") {
    return CATEGORIES.G;
  }
  if (rel.startsWith(".claude/hooks/")) return CATEGORIES.E;
  if (
    rel.startsWith(".claude/agents/") ||
    rel.startsWith(".codex/agents/") ||
    rel.startsWith(".cursor/agents/")
  ) {
    return CATEGORIES.F;
  }
  if (
    rel.startsWith(".claude/skills/") ||
    rel.startsWith(".codex/skills/") ||
    rel.startsWith(".cursor/skills/") ||
    rel.startsWith(".agents/skills/") ||
    rel.startsWith("openclaw/skills/") ||
    rel.startsWith("openclaw/workspaces/")
  ) {
    return CATEGORIES.D;
  }
  if (rel === "openclaw/openclaw.template.json" || rel.startsWith(".codex/")) {
    return CATEGORIES.G;
  }
  return null;
}

export function inferProjectPurpose(category) {
  switch (category) {
    case CATEGORIES.D:
      return "project-skill";
    case CATEGORIES.E:
      return "project-hook";
    case CATEGORIES.F:
      return "project-agent";
    case CATEGORIES.G:
      return "project-settings";
    default:
      return null;
  }
}

/**
 * Safely read a canonical source file. Returns null if the file is missing
 * (e.g. when running via npx with a stale or incomplete cached package).
 */
async function tryReadCanonical(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    console.warn(t.canonicalMissingWarn(filePath));
    return null;
  }
}

// ── Scope-aware projection directories ───────────────────────────────

/**
 * Resolve projection base dir for a runtime.
 * project → repoRoot, global → runtime home dir
 */
function getProjectionBase(scope, runtimeId) {
  return resolveRuntimeProjection(runtimeId, scope).baseDir;
}

/**
 * Resolve projection directories based on scope.
 * Returns an object with all paths needed for sync.
 */
function resolveProjectionDirs(scope) {
  const claude = resolveRuntimeProjection("claude", scope);
  const codex = resolveRuntimeProjection("codex", scope);
  const openclaw = resolveRuntimeProjection("openclaw", scope);
  const cursor = resolveRuntimeProjection("cursor", scope);
  const globalScope = scope === "global";

  return {
    // Claude Code
    claudeAgentsProjectionDir: claude.agentsDir,
    claudeSkillProjectionRoot: claude.skillRoot,
    claudeHooksProjectionDir: claude.hooksDir,
    claudeSettingsProjectionPath: claude.settingsFile,
    claudeMcpProjectionPath: claude.mcpFile,

    // Codex
    codexSkillRoot: codex.skillRoot,
    codexLegacySkillFile: globalScope ? null : codex.legacySkillFile,
    codexLegacySkillReferencesDir: globalScope
      ? null
      : codex.legacySkillReferencesDir,
    codexUsesDirectorySkill: true,
    codexAgentsDir: codex.agentsDir,
    codexProjectSkillRoot: globalScope ? null : codex.projectSkillRoot,
    codexConfigExamplePath: codex.configExampleFile,

    // OpenClaw
    openclawWorkspaceDir: openclaw.workspaceDir,
    openclawDisplayWorkspaceDir: openclaw.displayWorkspaceDir,
    openclawSkillRoot: openclaw.skillRoot,
    openclawLegacySkillFile: globalScope ? null : openclaw.legacySkillFile,
    openclawLegacySkillReferencesDir: globalScope
      ? null
      : openclaw.legacySkillReferencesDir,
    openclawTemplateConfigPath: openclaw.templateConfigFile,

    // Cursor
    cursorAgentsDir: cursor.agentsDir,
    cursorSkillRoot: cursor.skillRoot,
    cursorMcpPath: cursor.mcpFile,

    // Allowed roots for safety assertion
    allowedRoots: resolveRuntimeAllowedRoots(scope),

    displayPaths: {
      claudeAgents: claude.display.agentsDir,
      claudeSkill: claude.display.skillRoot,
      claudeHooks: claude.display.hooksDir,
      claudeSettings: claude.display.settingsFile,
      claudeMcp: claude.display.mcpFile,
      codexAgents: codex.display.agentsDir,
      codexSkills: codex.display.skillRoot,
      codexProjectSkills: globalScope ? null : ".agents/skills",
      codexConfig: codex.display.configExampleFile,
      openclawWorkspaces: globalScope
        ? openclaw.baseDir
        : "openclaw/workspaces",
      openclawTemplate: openclaw.display.templateConfigFile,
      openclawSkills: openclaw.display.skillRoot,
      cursorAgents: cursor.display.agentsDir,
      cursorSkill: cursor.display.skillRoot,
      cursorMcp: cursor.display.mcpFile,
    },
  };
}

// ── Canonical source paths (scope-independent) ──────────────────

const canonicalClaudeHooksDir = path.join(
  canonicalRuntimeAssetsDir,
  "claude",
  "hooks",
);
const canonicalClaudeSettingsPath = path.join(
  canonicalRuntimeAssetsDir,
  "claude",
  "settings.json",
);
const canonicalClaudeMcpPath = path.join(
  canonicalRuntimeAssetsDir,
  "claude",
  "mcp.json",
);
const canonicalCodexConfigExamplePath = path.join(
  canonicalRuntimeAssetsDir,
  "codex",
  "config.toml.example",
);
const canonicalOpenClawTemplatePath = path.join(
  canonicalRuntimeAssetsDir,
  "openclaw",
  "openclaw.template.json",
);

const preferredOrder = [
  "meta-warden",
  "meta-genesis",
  "meta-artisan",
  "meta-sentinel",
  "meta-librarian",
  "meta-conductor",
  "meta-prism",
  "meta-scout",
];

function parseFrontmatter(raw, filePath) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`${filePath} is missing YAML frontmatter.`);
  }

  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      throw new Error(`${filePath} has an invalid frontmatter line: ${line}`);
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }

  return { data, body: match[2].trimStart() };
}

function extractTitle(body, fallback) {
  const match = body.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

function extractSummary(body, fallback) {
  const match = body.match(/^>\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

function roleFromTitle(title, fallback) {
  const parts = title.split(":");
  return parts.length > 1 ? parts.slice(1).join(":").trim() : fallback;
}

function sortAgents(agents) {
  return [...agents].sort((left, right) => {
    const leftIndex = preferredOrder.indexOf(left.id);
    const rightIndex = preferredOrder.indexOf(right.id);

    if (leftIndex === -1 && rightIndex === -1) {
      return left.id.localeCompare(right.id);
    }
    if (leftIndex === -1) {
      return 1;
    }
    if (rightIndex === -1) {
      return -1;
    }
    return leftIndex - rightIndex;
  });
}

function parseAgentPresentation(agent) {
  const titleMatch = agent.title.match(
    /^(.*?)(?::\s*(.*?))?(?:\s+([^\s]+))?$/u,
  );
  const displayName = titleMatch?.[1]?.trim() || agent.id;
  const localizedRole = titleMatch?.[2]?.trim() || agent.description;
  const emoji = titleMatch?.[3]?.trim() || "🤖";

  return {
    displayName,
    localizedRole,
    emoji,
  };
}

function buildBootstrap(agent) {
  const { displayName, localizedRole } = parseAgentPresentation(agent);

  return `# BOOTSTRAP.md - ${agent.id}

This workspace already ships Meta_Kim meta-architecture assets; do not invent a persona from scratch.

## Cold-start order

1. Read \`IDENTITY.md\` — confirm you are \`${displayName}\` and your role is ${localizedRole}.
2. Read \`SOUL.md\` — boundaries and quality bar.
3. Read \`TOOLS.md\` and \`AGENTS.md\` — decide what to delegate.
4. Update \`USER.md\` only when the user explicitly asks for long-lived context.

## First reply

- One sentence: what you own (and only that).
- Do not absorb other meta agents' responsibilities.
- Escalate cross-boundary conflicts to \`meta-warden\`.
`;
}

function buildIdentity(agent) {
  const { displayName, localizedRole, emoji } = parseAgentPresentation(agent);

  return `# IDENTITY.md - ${agent.id}

- **Name:** ${displayName}
- **Creature:** Meta_Kim meta agent
- **Vibe:** Focused, minimal, clear boundaries; primary job: ${localizedRole}
- **Emoji:** ${emoji}
- **Avatar:** 

## Identity Notes

- Agent ID: \`${agent.id}\`
- Core role: ${agent.description}
- Canonical source: \`${agent.sourceFile}\`
`;
}

function buildUser() {
  return `# USER.md - About Your Human

- **Name:**
- **What to call them:**
- **Pronouns:** _(optional)_
- **Timezone:**
- **Notes:**

## Context

Record this user's long-term preferences for Meta_Kim work; do not store unrelated private data.
`;
}

function buildBoot(agent) {
  const { displayName } = parseAgentPresentation(agent);

  return `# BOOT.md - ${agent.id}

After the OpenClaw gateway starts, run one-time boot checks in this order when needed.

1. Confirm the workspace path and that \`IDENTITY.md\`, \`SOUL.md\`, \`TOOLS.md\`, and \`AGENTS.md\` are readable.
2. Do not message the user proactively; act only when the boot task explicitly requires it.
3. If you see role-boundary conflicts, record them in \`MEMORY.md\` under open questions — do not rewrite persona on your own.
4. If you are \`${displayName}\`, keep boot checks inside your own boundary only.
`;
}

function buildMemory(agent) {
  return `# MEMORY.md - ${agent.id}

Store information that stays true across sessions.

## Do record

- Stable user preferences
- Recurring architecture decisions
- Confirmed boundary interpretations
- Risk constraints that keep applying

## Do not record

- One-off task state
- Ephemeral command output
- Unconfirmed guesses
- Personal data unrelated to Meta_Kim
`;
}

async function loadAgents() {
  const files = (await fs.readdir(canonicalAgentsDir))
    .filter((file) => file.endsWith(".md"))
    .sort();

  const agents = [];
  for (const file of files) {
    const filePath = path.join(canonicalAgentsDir, file);
    const raw = await fs.readFile(filePath, "utf8");
    const { data, body } = parseFrontmatter(raw, filePath);

    if (!data.name || !data.description) {
      throw new Error(
        `${filePath} must define frontmatter name and description.`,
      );
    }

    agents.push({
      id: data.name,
      description: data.description,
      sourceFile: path.relative(repoRoot, filePath).replace(/\\/g, "/"),
      title: extractTitle(body, data.name),
      summary: extractSummary(body, data.description),
      role: roleFromTitle(extractTitle(body, data.name), data.description),
      raw,
      body: body.trim(),
    });
  }

  return sortAgents(agents);
}

function buildWorkspaceDirectory(agents) {
  const rows = agents
    .map(
      (agent) => `| \`${agent.id}\` | ${agent.title} | ${agent.description} |`,
    )
    .join("\n");

  return `# AGENTS.md - Meta_Kim Team Directory

This file is generated from \`canonical/agents/*.md\` by \`npm run sync:runtimes\`.

Use the smallest agent whose boundary matches the task. Escalate to \`meta-warden\` when the task spans multiple agent boundaries.

Important: this file lists only the Meta_Kim team. It is not the full OpenClaw registry. If the user asks how many agents exist, which agents are currently registered, or who can collaborate right now, query the live runtime registry first instead of answering from this file alone.

| Agent ID | Name | Responsibility |
| --- | --- | --- |
${rows}
`;
}

function buildSoul(agent) {
  return `# SOUL.md - ${agent.id}

Generated from \`${agent.sourceFile}\`. Edit the canonical source first, then run \`npm run sync:runtimes\`.

## Runtime Notes

- You are running inside OpenClaw.
- Read the local \`AGENTS.md\` before delegating with \`sessions_send\`.
- \`AGENTS.md\` only lists the Meta_Kim team, not the full OpenClaw registry.
- When the user asks which agents exist, how many agents exist, or who can collaborate right now, query the live runtime registry first through \`agents_list\`. If that tool is unavailable, fall back to an explicit runtime command and state the result source.
- Stay inside your own responsibility boundary unless the user explicitly asks you to coordinate broader work.
- An optional local research note may exist at \`docs/meta.md\`, but public runtime behavior must not depend on it.

${agent.body}
`;
}

function buildHeartbeat(agent) {
  return `# HEARTBEAT.md - ${agent.id}

Default heartbeat policy:

- If there is no explicit scheduled work, respond with \`HEARTBEAT_OK\`.
- Do not create autonomous tasks or self-assign missions by default.
- Only act proactively after the deployment owner adds concrete heartbeat tasks below.

## Deployment Tasks

- None by default.
`;
}

function buildTools(agent, agents) {
  const teammates = agents
    .filter((item) => item.id !== agent.id)
    .map((item) => `- \`${item.id}\`: ${item.description}`)
    .join("\n");

  return `# TOOLS.md - ${agent.id}

Auto-generated by \`npm run sync:runtimes\`. Edit templates in \`scripts/sync-runtimes.mjs\`, then re-sync.

## OpenClaw runtime conventions

- Read \`SOUL.md\` and \`AGENTS.md\` in this directory first.
- For collaboration, prefer OpenClaw native agent-to-agent routing.
- \`AGENTS.md\` lists the Meta_Kim team only — it is not the full OpenClaw registry.
- When the user asks for agent counts, names, or who can collaborate, call \`agents_list\` first; if unavailable, use an explicit command and state the source.
- Shared skill: \`../../skills/meta-theory/SKILL.md\` (directory under \`openclaw/skills/\`, not duplicated per workspace).
- Do not absorb other agents' duties; delegate or escalate to \`meta-warden\` when out of scope.

## Teammates

${teammates || "- None"}
`;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function loadSkillReferences() {
  const entries = await fs.readdir(canonicalSkillReferencesDir, {
    withFileTypes: true,
  });
  const files = entries.filter((entry) => entry.isFile());

  return Promise.all(
    files.map(async (file) => ({
      name: file.name,
      content: await fs.readFile(
        path.join(canonicalSkillReferencesDir, file.name),
        "utf8",
      ),
    })),
  );
}

function escapeTomlBasicMultiline(value) {
  return value.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
}

function buildCodexAgentInstructions(agent) {
  return [
    `You are the Codex custom agent mirror of Meta_Kim agent \`${agent.id}\`.`,
    `Primary responsibility: ${agent.description}`,
    "Stay inside your own responsibility boundary.",
    "If the task crosses agent boundaries, hand the decision back to the parent session or recommend the correct sibling meta agent.",
    "Use the portable meta-theory skill when it helps, but do not claim ownership of another agent's deliverable.",
    "",
    agent.body.trim(),
  ].join("\n");
}

function buildCodexAgent(agent) {
  const instructions = escapeTomlBasicMultiline(
    buildCodexAgentInstructions(agent),
  );

  return `name = "${agent.id}"
description = "${agent.description.replace(/"/g, '\\"')}"
developer_instructions = """
${instructions}
"""
`;
}

/**
 * Build a Cursor-compatible agent Markdown file.
 * Cursor agents live in .cursor/agents/*.md — plain Markdown, no YAML frontmatter.
 */
function buildCursorAgent(agent) {
  return `# ${agent.title}

> ${agent.summary}

<!-- Generated from ${agent.sourceFile} by npm run sync:runtimes. Edit canonical source first. -->

You are the Cursor agent mirror of Meta_Kim agent \`${agent.id}\`.
Primary responsibility: ${agent.description}

Stay inside your own responsibility boundary.
If the task crosses agent boundaries, hand the decision back to the parent session or recommend the correct sibling meta agent.
Use the portable meta-theory skill when it helps, but do not claim ownership of another agent's deliverable.

---

${agent.body}
`;
}

function buildCodexSkillMetadata() {
  return `interface:
  display_name: "Meta Theory"
  short_description: "Meta_Kim cross-runtime meta-theory and collaboration method"
policy:
  allow_implicit_invocation: true
dependencies:
  mcp_servers:
    - meta_kim_runtime
`;
}

async function writeGeneratedFile(filePath, nextContent) {
  let currentContent = null;
  try {
    currentContent = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  if (currentContent === nextContent) {
    return { changed: false };
  }

  if (checkOnly) {
    staleFiles.push({
      path: filePath,
      category: inferProjectCategory(filePath),
      action: currentContent === null ? "create" : "update",
    });
    return { changed: true };
  }

  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, nextContent, "utf8");
  const category = inferProjectCategory(filePath);
  if (category) {
    recordSafe((rec) =>
      rec.recordFile(filePath, {
        source: "sync-runtimes",
        purpose: inferProjectPurpose(category),
        category,
      }),
    );
  }
  return { changed: true };
}

async function writeGeneratedJson(filePath, value) {
  const nextContent = `${JSON.stringify(value, null, 2)}\n`;
  return writeGeneratedFile(filePath, nextContent);
}

async function removeGeneratedPath(filePath) {
  if (!filePath) return { changed: false };

  let exists = false;
  try {
    await fs.access(filePath);
    exists = true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  if (!exists) return { changed: false };

  if (checkOnly) {
    staleFiles.push({
      path: filePath,
      category: inferProjectCategory(filePath),
      action: "delete",
    });
    return { changed: true };
  }

  await fs.rm(filePath, { recursive: true, force: true });
  return { changed: true };
}

// ── Runtime skill path substitution ─────────────────────────────────────
// The canonical SKILL.md and its references use canonical/ paths.
// During sync, these are substituted to runtime-specific paths so that
// the skill works correctly in each runtime projection.
//
// IMPORTANT: These rules must match the actual synced directory structure.
// When the sync config (meta-kim-sync-config.mjs) changes, these rules
// MUST be updated to match.

/**
 * Build a path substitution map for a given runtime target.
 * canonical/ paths are replaced with the runtime's actual projection paths.
 * @param {"claude"|"codex"|"openclaw"|"cursor"} targetId
 * @returns {{pattern:RegExp, replacement:string}[]}
 */
function buildRuntimeSkillMap(targetId) {
  const maps = {
    claude: [
      // Skill references: canonical/ → runtime-specific for Claude
      {
        pattern: /canonical\/skills\/meta-theory\/references\//g,
        replacement: ".claude/skills/meta-theory/references/",
      },
      // Agent definitions: canonical/ → runtime-specific for Claude
      { pattern: /canonical\/agents\//g, replacement: ".claude/agents/" },
      // Hook files: stay in .claude/hooks/ (no canonical equivalent)
      { pattern: /\.claude\/hooks\//g, replacement: ".claude/hooks/" },
      // Capability index: stays in .claude/capability-index/
      {
        pattern: /\.claude\/capability-index\//g,
        replacement: ".claude/capability-index/",
      },
      // Legacy .claude/skills/ references in canonical source → canonical/skills/ (normalize to canonical/)
      { pattern: /\.claude\/skills\//g, replacement: "canonical/skills/" },
    ],
    codex: [
      // Skill references: canonical/ → .codex/skills/meta-theory/references/
      {
        pattern: /canonical\/skills\/meta-theory\/references\//g,
        replacement: ".codex/skills/meta-theory/references/",
      },
      // Skill root: canonical/skills/ → .codex/skills/
      { pattern: /canonical\/skills\//g, replacement: ".codex/skills/" },
      // Agent definitions: canonical/ → .codex/agents/
      { pattern: /canonical\/agents\//g, replacement: ".codex/agents/" },
      // Hooks: Codex doesn't have hooks — strip to safe fallback
      { pattern: /\.claude\/hooks\//g, replacement: ".codex/" },
      // Capability index: preserve subdirectory structure
      {
        pattern: /\.claude\/capability-index\//g,
        replacement: ".codex/capability-index/",
      },
      // Legacy .claude/skills/ references in source → platform-specific path
      { pattern: /\.claude\/skills\//g, replacement: ".codex/skills/" },
    ],
    openclaw: [
      // Skill references: canonical/ → openclaw/skills/meta-theory/references/
      {
        pattern: /canonical\/skills\/meta-theory\/references\//g,
        replacement: "openclaw/skills/meta-theory/references/",
      },
      // Skill root: canonical/skills/ → openclaw/skills/
      { pattern: /canonical\/skills\//g, replacement: "openclaw/skills/" },
      // Agent definitions: OpenClaw uses workspace-per-agent model.
      // Each workspace has AGENTS.md containing all agent definitions.
      {
        pattern: /canonical\/agents\//g,
        replacement: "openclaw/workspaces/{workspace}/AGENTS.md#",
      },
      // Hooks: OpenClaw doesn't have hooks — strip
      { pattern: /\.claude\/hooks\//g, replacement: "openclaw/" },
      // Capability index: preserve subdirectory structure
      {
        pattern: /\.claude\/capability-index\//g,
        replacement: "openclaw/capability-index/",
      },
      // Legacy .claude/skills/ references in source → platform-specific path
      { pattern: /\.claude\/skills\//g, replacement: "openclaw/skills/" },
    ],
    cursor: [
      // Skill references: canonical/ → .cursor/skills/meta-theory/references/
      {
        pattern: /canonical\/skills\/meta-theory\/references\//g,
        replacement: ".cursor/skills/meta-theory/references/",
      },
      // Skill root: canonical/skills/ → .cursor/skills/
      { pattern: /canonical\/skills\//g, replacement: ".cursor/skills/" },
      // Agent definitions: canonical/ → .cursor/agents/
      { pattern: /canonical\/agents\//g, replacement: ".cursor/agents/" },
      // Hooks: Cursor doesn't have hooks
      { pattern: /\.claude\/hooks\//g, replacement: ".cursor/" },
      // Capability index: preserve subdirectory structure
      {
        pattern: /\.claude\/capability-index\//g,
        replacement: ".cursor/capability-index/",
      },
      // Legacy .claude/skills/ references in source → platform-specific path
      { pattern: /\.claude\/skills\//g, replacement: ".cursor/skills/" },
    ],
  };

  return maps[targetId] || maps.claude;
}

/**
 * Apply runtime-specific path substitutions to skill content.
 * @param {string} content - The skill file content
 * @param {"claude"|"codex"|"openclaw"|"cursor"} targetId
 * @returns {string}
 */
function applyRuntimePaths(content, targetId) {
  const rules = buildRuntimeSkillMap(targetId);
  let result = content;
  for (const { pattern, replacement } of rules) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

async function syncClaudeProjection(
  dirs,
  agents,
  portableSkill,
  skillReferences,
  changedFiles,
) {
  const {
    claudeAgentsProjectionDir,
    claudeSkillProjectionRoot,
    claudeHooksProjectionDir,
    claudeSettingsProjectionPath,
    claudeMcpProjectionPath,
    displayPaths,
  } = dirs;

  for (const agent of agents) {
    if (
      (
        await writeGeneratedFile(
          path.join(claudeAgentsProjectionDir, `${agent.id}.md`),
          agent.raw,
        )
      ).changed
    ) {
      changedFiles.push(`${displayPaths.claudeAgents}/${agent.id}.md`);
    }
  }

  if (
    (
      await writeGeneratedFile(
        path.join(claudeSkillProjectionRoot, "SKILL.md"),
        applyRuntimePaths(portableSkill, "claude"),
      )
    ).changed
  ) {
    changedFiles.push(`${displayPaths.claudeSkill}/SKILL.md`);
  }

  for (const reference of skillReferences) {
    if (
      (
        await writeGeneratedFile(
          path.join(claudeSkillProjectionRoot, "references", reference.name),
          reference.content,
        )
      ).changed
    ) {
      changedFiles.push(
        `${displayPaths.claudeSkill}/references/${reference.name}`,
      );
    }
  }

  const hookEntries = (
    await fs.readdir(canonicalClaudeHooksDir, { withFileTypes: true })
  )
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const hookEntry of hookEntries) {
    const hookContent = await fs.readFile(
      path.join(canonicalClaudeHooksDir, hookEntry.name),
      "utf8",
    );
    if (
      (
        await writeGeneratedFile(
          path.join(claudeHooksProjectionDir, hookEntry.name),
          hookContent,
        )
      ).changed
    ) {
      changedFiles.push(`${displayPaths.claudeHooks}/${hookEntry.name}`);
    }
  }

  const [settingsContent, mcpContent] = await Promise.all([
    fs.readFile(canonicalClaudeSettingsPath, "utf8"),
    fs.readFile(canonicalClaudeMcpPath, "utf8"),
  ]);

  // Merge into existing settings.json — never blind overwrite (project + global).
  const inRepoRoot = claudeSettingsProjectionPath.includes(repoRoot);
  let finalSettingsContent;
  const canonicalParsed = JSON.parse(settingsContent);

  if (inRepoRoot) {
    let base = {};
    try {
      const prev = await fs.readFile(claudeSettingsProjectionPath, "utf8");
      base = JSON.parse(prev);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    const canonCopy = structuredClone(canonicalParsed);
    // Keep relative paths — do NOT rewrite to absolute (breaks cross-machine portability)
    const merged = mergeRepoClaudeSettings(base, canonCopy);
    finalSettingsContent = `${JSON.stringify(merged, null, 2)}\n`;
  } else {
    let base = {};
    try {
      const prev = await fs.readFile(claudeSettingsProjectionPath, "utf8");
      base = JSON.parse(prev);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    const template = buildMetaKimHooksTemplate(".claude/hooks");
    const merged = mergeGlobalMetaKimHooksIntoSettings(base, template);
    finalSettingsContent = `${JSON.stringify(merged, null, 2)}\n`;
  }

  if (
    (
      await writeGeneratedFile(
        claudeSettingsProjectionPath,
        finalSettingsContent,
      )
    ).changed
  ) {
    changedFiles.push(displayPaths.claudeSettings);
  }
  if (
    claudeMcpProjectionPath &&
    (await writeGeneratedFile(claudeMcpProjectionPath, mcpContent)).changed
  ) {
    changedFiles.push(displayPaths.claudeMcp);
  }
}

async function main() {
  // ── Help ────────────────────────────────────────────────────────
  if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
    console.log(`Usage: node sync-runtimes.mjs [options]

Options:
  --scope <project|global|both>  Write projection to repo (default: project)
  --targets <ids>                 Comma-separated runtime IDs (claude,codex,openclaw)
  --lang <code>                   Messages: en | zh-CN | ja-JP | ko-KR (aliases: zh, ja, ko)
  --check                        Show what would be synced without writing
  --help, -h                     Show this help

Scopes:
  project  Write to repo-local directories (.claude/, .codex/, openclaw/)
  global  Write directly to runtime home dirs (${resolveRuntimeHomeDir("claude")}, etc.)
  both    Write to both locations

Examples:
  node sync-runtimes.mjs                        # project scope (default)
  node sync-runtimes.mjs --scope global        # write to ~/.claude, ~/.codex, ~/.openclaw
  node sync-runtimes.mjs --scope global --targets claude  # Claude Code only, global
  node sync-runtimes.mjs --check                # preview changes
`);
    return;
  }

  const scope = parseScopeArg(cliArgs);
  const { cliTargets, supportedTargets } = await resolveTargetContext(cliArgs);
  const selectedTargets = cliTargets.length > 0 ? cliTargets : supportedTargets;
  const dirs = resolveProjectionDirs(scope);
  const agents = await loadAgents();
  const teamDirectory = buildWorkspaceDirectory(agents);
  const portableSkill = await tryReadCanonical(canonicalSkillPath);
  if (!portableSkill) return [];
  const skillReferences = await loadSkillReferences();
  const changedFiles = [];

  // Safety assertion: all writes must stay within allowedRoots
  if (!checkOnly) {
    assertHomeBound(dirs.claudeAgentsProjectionDir, dirs.allowedRoots);
    if (dirs.claudeMcpProjectionPath) {
      assertHomeBound(dirs.claudeMcpProjectionPath, dirs.allowedRoots);
    }
  }

  // Open project install manifest recorder. Only record when writes actually
  // hit the repo (not in --check mode, and only when scope includes project).
  // Global-scope sync is recorded separately by sync-global-meta-theory.mjs.
  if (!checkOnly && (scope === "project" || scope === "both")) {
    manifestRecorder = openRecorder({
      scope: "project",
      repoRoot,
      metaKimVersion: process.env.META_KIM_VERSION ?? null,
    });
  }

  if (selectedTargets.includes("claude")) {
    await syncClaudeProjection(
      dirs,
      agents,
      portableSkill,
      skillReferences,
      changedFiles,
    );
  }

  if (selectedTargets.includes("openclaw")) {
    const dp = dirs.displayPaths;

    for (const agent of agents) {
      const workspaceDir = dirs.openclawWorkspaceDir(agent.id);
      const writes = await Promise.all([
        writeGeneratedFile(
          path.join(workspaceDir, "BOOT.md"),
          buildBoot(agent),
        ),
        writeGeneratedFile(
          path.join(workspaceDir, "BOOTSTRAP.md"),
          buildBootstrap(agent),
        ),
        writeGeneratedFile(
          path.join(workspaceDir, "IDENTITY.md"),
          buildIdentity(agent),
        ),
        writeGeneratedFile(
          path.join(workspaceDir, "MEMORY.md"),
          buildMemory(agent),
        ),
        writeGeneratedFile(path.join(workspaceDir, "USER.md"), buildUser()),
        writeGeneratedFile(
          path.join(workspaceDir, "SOUL.md"),
          buildSoul(agent),
        ),
        writeGeneratedFile(path.join(workspaceDir, "AGENTS.md"), teamDirectory),
        writeGeneratedFile(
          path.join(workspaceDir, "HEARTBEAT.md"),
          buildHeartbeat(agent),
        ),
        writeGeneratedFile(
          path.join(workspaceDir, "TOOLS.md"),
          buildTools(agent, agents),
        ),
      ]);

      if (writes.some((result) => result.changed)) {
        changedFiles.push(dirs.openclawDisplayWorkspaceDir(agent.id));
      }
    }

    // Gracefully handle missing openclaw.template.json (can happen when running
    // via npx with an older cached package version that doesn't include it)
    let templateConfig = null;
    const templateRaw = await tryReadCanonical(canonicalOpenClawTemplatePath);
    if (templateRaw) {
      templateConfig = JSON.parse(templateRaw);
    }

    if (
      templateConfig !== null &&
      (
        await writeGeneratedJson(
          dirs.openclawTemplateConfigPath,
          templateConfig,
        )
      ).changed
    ) {
      changedFiles.push(dp.openclawTemplate);
    }
    if ((await removeGeneratedPath(dirs.openclawLegacySkillFile)).changed) {
      changedFiles.push("openclaw/skills/meta-theory.md");
    }
    if (
      (await removeGeneratedPath(dirs.openclawLegacySkillReferencesDir)).changed
    ) {
      changedFiles.push("openclaw/skills/references");
    }
    if (
      (
        await writeGeneratedFile(
          path.join(dirs.openclawSkillRoot, "SKILL.md"),
          applyRuntimePaths(portableSkill, "openclaw"),
        )
      ).changed
    ) {
      changedFiles.push(`${dp.openclawSkills}/SKILL.md`);
    }
    for (const reference of skillReferences) {
      if (
        (
          await writeGeneratedFile(
            path.join(dirs.openclawSkillRoot, "references", reference.name),
            applyRuntimePaths(reference.content, "openclaw"),
          )
        ).changed
      ) {
        changedFiles.push(`${dp.openclawSkills}/references/${reference.name}`);
      }
    }
  }

  if (selectedTargets.includes("codex")) {
    const dp = dirs.displayPaths;

    if ((await removeGeneratedPath(dirs.codexLegacySkillFile)).changed) {
      changedFiles.push(".codex/skills/meta-theory.md");
    }
    if (
      (await removeGeneratedPath(dirs.codexLegacySkillReferencesDir)).changed
    ) {
      changedFiles.push(".codex/skills/references");
    }

    if (
      (
        await writeGeneratedFile(
          path.join(dirs.codexSkillRoot, "SKILL.md"),
          applyRuntimePaths(portableSkill, "codex"),
        )
      ).changed
    ) {
      changedFiles.push(`${dp.codexSkills}/SKILL.md`);
    }
    for (const reference of skillReferences) {
      if (
        (
          await writeGeneratedFile(
            path.join(dirs.codexSkillRoot, "references", reference.name),
            applyRuntimePaths(reference.content, "codex"),
          )
        ).changed
      ) {
        changedFiles.push(`${dp.codexSkills}/references/${reference.name}`);
      }
    }
    if (dirs.codexProjectSkillRoot && dp.codexProjectSkills) {
      if (
        (
          await writeGeneratedFile(
            path.join(dirs.codexProjectSkillRoot, "SKILL.md"),
            applyRuntimePaths(portableSkill, "codex"),
          )
        ).changed
      ) {
        changedFiles.push(`${dp.codexProjectSkills}/meta-theory/SKILL.md`);
      }
      if (
        (
          await writeGeneratedFile(
            path.join(dirs.codexProjectSkillRoot, "agents", "openai.yaml"),
            buildCodexSkillMetadata(),
          )
        ).changed
      ) {
        changedFiles.push(
          `${dp.codexProjectSkills}/meta-theory/agents/openai.yaml`,
        );
      }
      for (const reference of skillReferences) {
        if (
          (
            await writeGeneratedFile(
              path.join(
                dirs.codexProjectSkillRoot,
                "references",
                reference.name,
              ),
              applyRuntimePaths(reference.content, "codex"),
            )
          ).changed
        ) {
          changedFiles.push(
            `${dp.codexProjectSkills}/meta-theory/references/${reference.name}`,
          );
        }
      }
    }
    const codexConfigExample = await tryReadCanonical(
      canonicalCodexConfigExamplePath,
    );
    if (
      codexConfigExample &&
      (
        await writeGeneratedFile(
          dirs.codexConfigExamplePath,
          codexConfigExample,
        )
      ).changed
    ) {
      changedFiles.push(dp.codexConfig);
    }

    for (const agent of agents) {
      if (
        (
          await writeGeneratedFile(
            path.join(dirs.codexAgentsDir, `${agent.id}.toml`),
            buildCodexAgent(agent),
          )
        ).changed
      ) {
        changedFiles.push(`${dp.codexAgents}/${agent.id}.toml`);
      }
    }
  }

  // ── Cursor sync ───────────────────────────────────────────────
  if (selectedTargets.includes("cursor")) {
    const dp = dirs.displayPaths;

    // Agent projections (.cursor/agents/*.md)
    for (const agent of agents) {
      if (
        (
          await writeGeneratedFile(
            path.join(dirs.cursorAgentsDir, `${agent.id}.md`),
            buildCursorAgent(agent),
          )
        ).changed
      ) {
        changedFiles.push(`${dp.cursorAgents}/${agent.id}.md`);
      }
    }

    // Skill projections (.cursor/skills/meta-theory/)
    if (
      (
        await writeGeneratedFile(
          path.join(dirs.cursorSkillRoot, "SKILL.md"),
          applyRuntimePaths(portableSkill, "cursor"),
        )
      ).changed
    ) {
      changedFiles.push(`${dp.cursorSkill}/SKILL.md`);
    }
    for (const reference of skillReferences) {
      if (
        (
          await writeGeneratedFile(
            path.join(dirs.cursorSkillRoot, "references", reference.name),
            applyRuntimePaths(reference.content, "cursor"),
          )
        ).changed
      ) {
        changedFiles.push(`${dp.cursorSkill}/references/${reference.name}`);
      }
    }

    // MCP config (.cursor/mcp.json) — reuse Claude's MCP template
    if (dirs.cursorMcpPath) {
      const mcpContent = await tryReadCanonical(canonicalClaudeMcpPath);
      if (
        mcpContent &&
        (await writeGeneratedFile(dirs.cursorMcpPath, mcpContent)).changed
      ) {
        changedFiles.push(dp.cursorMcp);
      }
    }
  }

  if (checkOnly && jsonMode) {
    const byCategory = staleFiles.reduce((acc, f) => {
      const k = f.category || "unknown";
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    const byAction = staleFiles.reduce((acc, f) => {
      acc[f.action] = (acc[f.action] || 0) + 1;
      return acc;
    }, {});
    process.stdout.write(
      `${JSON.stringify(
        {
          scope,
          targets: selectedTargets,
          total: staleFiles.length,
          byCategory,
          byAction,
          staleFiles,
        },
        null,
        2,
      )}\n`,
    );
    if (staleFiles.length > 0) process.exitCode = 1;
    return;
  }

  if (checkOnly && changedFiles.length > 0) {
    console.error(t.syncRuntimesCheckStale);
    for (const file of changedFiles) {
      console.error(t.syncRuntimesCheckStaleLine(file));
    }
    process.exitCode = 1;
    return;
  }

  if (checkOnly) {
    console.log(t.syncRuntimesCheckOk);
    return;
  }

  const normalizeDisplayPath = (value) =>
    String(value ?? "").replace(/\\/g, "/");
  const hasDisplayPrefix = (targetPath, prefix) => {
    if (!prefix) {
      return false;
    }
    const normalizedTarget = normalizeDisplayPath(targetPath);
    const normalizedPrefix = normalizeDisplayPath(prefix);
    return (
      normalizedTarget === normalizedPrefix ||
      normalizedTarget.startsWith(`${normalizedPrefix}/`)
    );
  };

  const openclawWorkspacePrefix =
    scope === "global"
      ? normalizeDisplayPath(dirs.openclawWorkspaceDir(""))
      : normalizeDisplayPath(dirs.displayPaths.openclawWorkspaces);

  const layerCounts = {
    claudeAgents: changedFiles.filter((f) =>
      hasDisplayPrefix(f, dirs.displayPaths.claudeAgents),
    ).length,
    claudeSkill: changedFiles.filter((f) =>
      hasDisplayPrefix(f, dirs.displayPaths.claudeSkill),
    ).length,
    claudeHooks: changedFiles.filter((f) =>
      hasDisplayPrefix(f, dirs.displayPaths.claudeHooks),
    ).length,
    claudeSettings: changedFiles.filter(
      (f) =>
        normalizeDisplayPath(f) ===
        normalizeDisplayPath(dirs.displayPaths.claudeSettings),
    ).length,
    claudeMcp: changedFiles.filter(
      (f) =>
        dirs.displayPaths.claudeMcp &&
        normalizeDisplayPath(f) ===
          normalizeDisplayPath(dirs.displayPaths.claudeMcp),
    ).length,
    codexAgents: changedFiles.filter((f) =>
      hasDisplayPrefix(f, dirs.displayPaths.codexAgents),
    ).length,
    codexSkill: changedFiles.filter((f) =>
      hasDisplayPrefix(f, dirs.displayPaths.codexSkills),
    ).length,
    codexProjectSkill: changedFiles.filter((f) =>
      hasDisplayPrefix(f, dirs.displayPaths.codexProjectSkills),
    ).length,
    codexConfig: changedFiles.filter(
      (f) =>
        normalizeDisplayPath(f) ===
        normalizeDisplayPath(dirs.displayPaths.codexConfig),
    ).length,
    openclawWorkspace: changedFiles.filter((f) =>
      normalizeDisplayPath(f).startsWith(openclawWorkspacePrefix),
    ).length,
    openclawSkill: changedFiles.filter((f) =>
      hasDisplayPrefix(f, dirs.displayPaths.openclawSkills),
    ).length,
    openclawTemplate: changedFiles.filter(
      (f) =>
        normalizeDisplayPath(f) ===
        normalizeDisplayPath(dirs.displayPaths.openclawTemplate),
    ).length,
    cursorAgents: changedFiles.filter((f) =>
      hasDisplayPrefix(f, dirs.displayPaths.cursorAgents),
    ).length,
    cursorSkill: changedFiles.filter((f) =>
      hasDisplayPrefix(f, dirs.displayPaths.cursorSkill),
    ).length,
    cursorMcp: changedFiles.filter(
      (f) =>
        normalizeDisplayPath(f) ===
        normalizeDisplayPath(dirs.displayPaths.cursorMcp),
    ).length,
  };

  const teamSize = agents.length;
  const groups = [
    {
      name: t.runtimeGroupClaude,
      entries: [
        {
          label: dirs.displayPaths.claudeAgents,
          count: layerCounts.claudeAgents,
          summaryKind: "agents",
        },
        {
          label: dirs.displayPaths.claudeSkill,
          count: layerCounts.claudeSkill,
          summaryKind: "files",
        },
        {
          label: dirs.displayPaths.claudeHooks,
          count: layerCounts.claudeHooks,
          summaryKind: "files",
        },
        {
          label: dirs.displayPaths.claudeSettings,
          count: layerCounts.claudeSettings,
          summaryKind: "files",
        },
        {
          label: dirs.displayPaths.claudeMcp,
          count: layerCounts.claudeMcp,
          summaryKind: "files",
        },
      ],
    },
    {
      name: t.runtimeGroupCodex,
      entries: [
        {
          label: dirs.displayPaths.codexAgents,
          count: layerCounts.codexAgents,
          summaryKind: "agents",
        },
        {
          label: dirs.displayPaths.codexSkills,
          count: layerCounts.codexSkill,
          summaryKind: "files",
        },
        {
          label: dirs.displayPaths.codexProjectSkills,
          count: layerCounts.codexProjectSkill,
          summaryKind: "files",
        },
        {
          label: dirs.displayPaths.codexConfig,
          count: layerCounts.codexConfig,
          summaryKind: "files",
        },
      ],
    },
    {
      name: t.runtimeGroupOpenclaw,
      entries: [
        {
          label: dirs.displayPaths.openclawWorkspaces,
          count: layerCounts.openclawWorkspace,
          summaryKind: "workspaces",
        },
        {
          label: dirs.displayPaths.openclawSkills,
          count: layerCounts.openclawSkill,
          summaryKind: "files",
        },
        {
          label: dirs.displayPaths.openclawTemplate,
          count: layerCounts.openclawTemplate,
          summaryKind: "files",
        },
      ],
    },
    {
      name: t.runtimeGroupCursor,
      entries: [
        {
          label: dirs.displayPaths.cursorAgents,
          count: layerCounts.cursorAgents,
          summaryKind: "agents",
        },
        {
          label: dirs.displayPaths.cursorSkill,
          count: layerCounts.cursorSkill,
          summaryKind: "files",
        },
        {
          label: dirs.displayPaths.cursorMcp,
          count: layerCounts.cursorMcp,
          summaryKind: "files",
        },
      ],
    },
  ];

  // Dynamic path column width: base on the longest active label so short
  // entries (e.g. ".mcp.json") do not trail a wall of spaces. Bounded below
  // so single-entry runs still have breathing room, and above so pathological
  // long paths do not push detail off-screen.
  const activeLabels = groups.flatMap((g) =>
    g.entries.filter((e) => e.label && e.count > 0).map((e) => String(e.label)),
  );
  const longestLabel = activeLabels.reduce(
    (max, label) => Math.max(max, label.length),
    0,
  );
  const pathColWidth = Math.max(16, Math.min(longestLabel + 2, 60));
  console.log("");
  console.log(t.syncRuntimesSummaryTitle);
  console.log(t.syncRuntimesSummaryIntro);
  console.log("");

  for (const group of groups) {
    const activeEntries = group.entries.filter(
      (entry) => entry.label && entry.count > 0,
    );
    if (activeEntries.length === 0) {
      continue;
    }
    console.log(`${group.name}`);
    for (const entry of activeEntries) {
      const pathCol = String(entry.label).padEnd(pathColWidth);
      let detail = "";
      if (entry.summaryKind === "agents") {
        detail = t.syncDetailAgents(entry.count, teamSize);
      } else if (entry.summaryKind === "workspaces") {
        detail = t.syncDetailWorkspaces(entry.count, teamSize);
      } else {
        detail = t.syncDetailFiles(entry.count);
      }
      console.log(`${pathCol} ${detail}`);
    }
    console.log("");
  }

  console.log(t.syncScopeLine(scope, selectedTargets.join(", ")));

  if (manifestRecorder) {
    const result = await manifestRecorder.flush();
    if (result.ok) {
      console.log(`✓ ${t.syncInstallManifestOk(result.path, result.entries)}`);
    }
  }
}

if (
  import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` ||
  process.argv[1]?.endsWith("sync-runtimes.mjs")
) {
  await main();
}
