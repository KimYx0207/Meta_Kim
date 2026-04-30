/**
 * Meta_Kim 跨平台能力发现器 v2
 *
 * 功能：
 * 1. 扫描4个平台的全局能力（agents/skills/hooks/plugins/commands）
 * 2. 使用直接文件遍历而不是glob，更可靠
 * 3. 生成统一的能力索引
 * 4. 支持 Claude Code / OpenClaw / Codex / Cursor
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ensureProfileState } from "./meta-kim-local-state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const CANONICAL_CAPABILITY_INDEX = "config/capability-index/meta-kim-capabilities.json";
const LOCAL_GLOBAL_INVENTORY =
  ".meta-kim/state/{profile}/capability-index/global-capabilities.json";

// ========== 平台定义 ==========

const PLATFORMS = {
  claudeCode: {
    name: "Claude Code",
    baseDir: () => path.join(os.homedir(), ".claude"),
    // 每个类型的扫描函数
    scanners: {
      agents: async (baseDir) =>
        scanMarkdownFiles(path.join(baseDir, "agents")),
      skills: async (baseDir) => scanSkillFiles(path.join(baseDir, "skills")),
      hooks: async (baseDir) => scanHookFiles(path.join(baseDir, "hooks")),
      plugins: async (baseDir) =>
        scanPluginFiles(path.join(baseDir, "plugins")),
      commands: async (baseDir) =>
        scanCommandFiles(path.join(baseDir, "commands")),
    },
  },
  openclaw: {
    name: "OpenClaw",
    baseDir: () => path.join(os.homedir(), ".openclaw"),
    scanners: {
      agents: async (baseDir) => scanOpenClawAgents(baseDir),
      skills: async (baseDir) => scanOpenClawSkills(baseDir),
      hooks: async (baseDir) => scanHookFiles(path.join(baseDir, "hooks")),
      commands: async (baseDir) =>
        scanCommandFiles(path.join(baseDir, "commands")),
    },
  },
  codex: {
    name: "Codex",
    baseDir: () => path.join(os.homedir(), ".codex"),
    scanners: {
      agents: async (baseDir) =>
        scanTomlFilesRecursive(path.join(baseDir, "agents")),
      skills: async (baseDir) =>
        scanSkillFilesRecursive(path.join(baseDir, "skills")),
      commands: async (baseDir) =>
        scanCommandFiles(path.join(baseDir, "commands")),
    },
  },
  cursor: {
    name: "Cursor",
    baseDir: () => path.join(os.homedir(), ".cursor"),
    scanners: {
      agents: async (baseDir) => scanMarkdownFiles(path.join(baseDir, "agents")),
      skills: async (baseDir) => scanCursorSkills(baseDir),
      plugins: async (baseDir) =>
        scanPluginFiles(path.join(baseDir, "plugins")),
    },
  },
};

// ========== 通用扫描函数 ==========

async function* walkDir(dir, maxDepth = 10) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === "downloads" ||
        entry.name === "dist" ||
        entry.name === "build"
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        const depth =
          fullPath.split(path.sep).length - dir.split(path.sep).length;
        if (depth < maxDepth) {
          yield* walkDir(fullPath, maxDepth);
        }
      } else if (entry.isFile()) {
        yield fullPath;
      }
    }
  } catch {
    // 目录不存在或无权限访问
  }
}

async function scanMarkdownFiles(dir) {
  const results = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const filePath = path.join(dir, entry.name);
        const stat = await fs.stat(filePath);
        results.push({
          id: entry.name.replace(/\.md$/, ""),
          path: filePath,
          size: stat.size,
          modified: stat.mtime,
        });
      }
    }
  } catch {}
  return results;
}

async function scanMarkdownFilesRecursive(dir) {
  const results = [];
  for await (const filePath of walkDir(dir, 5)) {
    if (filePath.endsWith(".md")) {
      const stat = await fs.stat(filePath);
      const relPath = path.relative(dir, filePath);
      const id = relPath.replace(/\.md$/, "").replace(/\\/g, "/");
      results.push({
        id,
        path: filePath,
        relativePath: relPath,
        size: stat.size,
        modified: stat.mtime,
      });
    }
  }
  return results;
}

async function scanTomlFiles(dir) {
  const results = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".toml")) {
        const filePath = path.join(dir, entry.name);
        const stat = await fs.stat(filePath);
        results.push({
          id: entry.name.replace(/\.toml$/, ""),
          path: filePath,
          size: stat.size,
          modified: stat.mtime,
        });
      }
    }
  } catch {}
  return results;
}

async function scanTomlFilesRecursive(dir) {
  const results = [];
  for await (const filePath of walkDir(dir, 5)) {
    if (filePath.endsWith(".toml")) {
      const stat = await fs.stat(filePath);
      const relPath = path.relative(dir, filePath);
      const id = relPath.replace(/\.toml$/, "").replace(/\\/g, "/");
      results.push({
        id,
        path: filePath,
        relativePath: relPath,
        size: stat.size,
        modified: stat.mtime,
      });
    }
  }
  return results;
}

async function scanOpenClawAgents(baseDir) {
  const results = [];
  const configPath = path.join(baseDir, "openclaw.json");
  const seen = new Set();

  try {
    const content = await fs.readFile(configPath, "utf8");
    const config = JSON.parse(content);
    const list = config?.agents?.list ?? [];

    for (const agent of list) {
      if (!agent?.id || seen.has(agent.id)) {
        continue;
      }

      const workspacePath =
        typeof agent.workspace === "string" && agent.workspace.trim()
          ? agent.workspace
          : path.join(baseDir, `workspace-${agent.id}`);

      let stat = null;
      try {
        stat = await fs.stat(workspacePath);
      } catch {}

      results.push({
        id: agent.id,
        path: workspacePath,
        size: stat?.size ?? 0,
        modified: stat?.mtime ?? new Date(0),
        metadata: {
          name: agent.name || agent.id,
          model: agent.model || "unknown",
          workspace: workspacePath,
          source: "openclaw.json",
          default: Boolean(agent.default),
        },
      });
      seen.add(agent.id);
    }
  } catch {}

  // Fall back to scanning workspace-* directories for loose/unlisted agents.
  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("workspace-")) {
        continue;
      }

      const agentId = entry.name.replace(/^workspace-/, "");
      if (!agentId || seen.has(agentId)) {
        continue;
      }

      const workspacePath = path.join(baseDir, entry.name);
      const soulPath = path.join(workspacePath, "SOUL.md");
      const stat = await fs.stat(workspacePath);
      const metadata = {
        name: agentId,
        workspace: workspacePath,
        source: "workspace-scan",
      };

      try {
        const soulContent = await fs.readFile(soulPath, "utf8");
        const title = soulContent.match(/^#\s+(.+)$/m)?.[1]?.trim();
        if (title) {
          metadata.name = title;
        }
      } catch {}

      results.push({
        id: agentId,
        path: workspacePath,
        size: stat.size,
        modified: stat.mtime,
        metadata,
      });
      seen.add(agentId);
    }
  } catch {}

  return results.sort((left, right) => left.id.localeCompare(right.id));
}

async function scanSkillFiles(dir) {
  const results = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillDir = path.join(dir, entry.name);
        const skillMdPath = path.join(skillDir, "SKILL.md");
        try {
          const stat = await fs.stat(skillMdPath);
          results.push({
            id: entry.name,
            path: skillMdPath,
            size: stat.size,
            modified: stat.mtime,
          });
        } catch {
          // SKILL.md 不存在，跳过
        }
      }
    }
  } catch {}
  return results;
}

async function scanSkillFilesRecursive(dir) {
  const results = [];
  for await (const filePath of walkDir(dir, 6)) {
    if (path.basename(filePath) !== "SKILL.md") {
      continue;
    }

    const stat = await fs.stat(filePath);
    const relPath = path.relative(dir, filePath);
    const skillRoot = path.dirname(relPath);
    const normalizedRoot =
      skillRoot === "." ? "" : skillRoot.replace(/\\/g, "/");
    const id = normalizedRoot || "SKILL";

    results.push({
      id,
      path: filePath,
      relativePath: relPath,
      size: stat.size,
      modified: stat.mtime,
    });
  }
  return results;
}

async function mergeCapabilityLists(...lists) {
  const byPath = new Map();
  for (const list of lists) {
    for (const item of list) {
      byPath.set(item.path, item);
    }
  }
  return Array.from(byPath.values()).sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

async function scanOpenClawSkills(baseDir) {
  return mergeCapabilityLists(
    await scanSkillFilesRecursive(path.join(baseDir, "skills")),
    await scanSkillFilesRecursive(path.join(os.homedir(), ".agents", "skills")),
  );
}

async function scanCursorSkills(baseDir) {
  return mergeCapabilityLists(
    await scanSkillFilesRecursive(path.join(baseDir, "skills")),
    await scanSkillFilesRecursive(path.join(baseDir, "skills-cursor")),
  );
}

async function scanHookFiles(dir) {
  const results = [];

  // Only scan physical hook script files in the hooks directory.
  // Meta_Kim's capability index records what hooks Meta_Kim manages
  // (i.e., the physical .js/.py/.sh files under the hooks directory).
  // Hook commands defined inside third-party skill SKILL.md files are
  // governed by their respective skill repositories, not by Meta_Kim.
  for await (const filePath of walkDir(dir, 3)) {
    if (
      filePath.endsWith(".js") ||
      filePath.endsWith(".mjs") ||
      filePath.endsWith(".py") ||
      filePath.endsWith(".sh")
    ) {
      const stat = await fs.stat(filePath);
      const relPath = path.relative(dir, filePath);
      const id = relPath.replace(/\\/g, "/");
      results.push({
        id,
        path: filePath,
        relativePath: relPath,
        size: stat.size,
        modified: stat.mtime,
      });
    }
  }

  return results;
}

async function scanPluginFiles(dir) {
  const results = [];

  // 扫描 installed_plugins.json
  try {
    const installedPath = path.join(dir, "installed_plugins.json");
    const content = await fs.readFile(installedPath, "utf8");
    const installed = JSON.parse(content);
    for (const [pluginId, info] of Object.entries(installed.plugins || {})) {
      results.push({
        id: pluginId,
        path: info.path || dir,
        metadata: info,
      });
    }
  } catch {}

  // 扫描 repos 目录
  const reposDir = path.join(dir, "repos");
  try {
    const entries = await fs.readdir(reposDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const pluginDir = path.join(reposDir, entry.name);
        const packageJsonPath = path.join(pluginDir, "package.json");
        try {
          const content = await fs.readFile(packageJsonPath, "utf8");
          const pkg = JSON.parse(content);
          const stat = await fs.stat(pluginDir);
          results.push({
            id: entry.name,
            path: pluginDir,
            metadata: {
              name: pkg.name,
              version: pkg.version,
              description: pkg.description,
            },
            size: stat.size,
            modified: stat.mtime,
          });
        } catch {
          // 没有 package.json，仍然记录目录
          results.push({
            id: entry.name,
            path: pluginDir,
          });
        }
      }
    }
  } catch {}

  return results;
}

async function scanCommandFiles(dir) {
  const results = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const commandDir = path.join(dir, entry.name);
        // 查找 command.md 或 SKILL.md
        const commandMdPath = path.join(commandDir, "command.md");
        const skillMdPath = path.join(commandDir, "SKILL.md");
        let foundPath = null;
        try {
          await fs.access(commandMdPath);
          foundPath = commandMdPath;
        } catch {
          try {
            await fs.access(skillMdPath);
            foundPath = skillMdPath;
          } catch {}
        }
        if (foundPath) {
          const stat = await fs.stat(foundPath);
          results.push({
            id: entry.name,
            path: foundPath,
            size: stat.size,
            modified: stat.mtime,
          });
        }
      }
    }
  } catch {}
  return results;
}

// ========== Agent 元数据提取 ==========

async function extractAgentMetadata(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");

    // 提取 YAML frontmatter
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (frontmatterMatch) {
      const metadata = {};
      for (const line of frontmatterMatch[1].split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const colonIndex = trimmed.indexOf(":");
        if (colonIndex > 0) {
          const key = trimmed.slice(0, colonIndex).trim();
          let value = trimmed.slice(colonIndex + 1).trim();
          if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
          ) {
            value = value.slice(1, -1);
          }
          metadata[key] = value;
        }
      }
      return metadata;
    }

    // 提取标题
    const titleMatch = content.match(/^#\s+(.+)$/m);
    if (titleMatch) {
      return { title: titleMatch[1].trim() };
    }
  } catch {}
  return {};
}

async function extractCodexAgentMetadata(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const metadata = {};

    // 解析 TOML-style key = "value"
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^(\w+)\s*=\s*["'](.+?)["']/);
      if (match) {
        metadata[match[1]] = match[2];
      }
    }

    return metadata;
  } catch {}
  return {};
}

async function extractSkillMetadata(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");

    // YAML frontmatter
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (frontmatterMatch) {
      const metadata = {};
      for (const line of frontmatterMatch[1].split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const colonIndex = trimmed.indexOf(":");
        if (colonIndex > 0) {
          const key = trimmed.slice(0, colonIndex).trim();
          let value = trimmed.slice(colonIndex + 1).trim();
          if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
          ) {
            value = value.slice(1, -1);
          }
          metadata[key] = value;
        }
      }
      return metadata;
    }
  } catch {}
  return {};
}

// ========== 平台扫描 ==========

async function scanPlatform(platformId, platform) {
  const baseDir = platform.baseDir();
  const result = {
    platform: platform.name,
    platformId,
    baseDir,
    capabilities: {
      agents: [],
      skills: [],
      hooks: [],
      plugins: [],
      commands: [],
    },
    errors: [],
  };

  // 检查平台目录是否存在
  try {
    await fs.access(baseDir);
  } catch {
    result.errors.push(`Platform directory not found: ${baseDir}`);
    return result;
  }

  // 扫描每种能力类型
  for (const [type, scanner] of Object.entries(platform.scanners)) {
    try {
      const items = await scanner(baseDir);
      for (const item of items) {
        try {
          const capability = {
            id: item.id,
            type,
            platform: platform.name,
            platformId,
            path: item.path,
            size: item.size,
            modified: item.modified,
          };

          if (item.relativePath) {
            capability.relativePath = item.relativePath;
          }

          if (item.metadata) {
            capability.metadata = item.metadata;
          }

          // Pass through hook fields from skill hook extraction
          if (type === "hooks") {
            if (item.command !== undefined) {
              capability.command = item.command;
            }
            if (item.available !== undefined) {
              capability.available = item.available;
            }
            if (item.unavailableReason) {
              capability.unavailableReason = item.unavailableReason;
            }
            if (item.fromSkill) {
              capability.fromSkill = item.fromSkill;
            }
            if (item.hookEvent) {
              capability.hookEvent = item.hookEvent;
            }
          }

          // Extract specific-type metadata
          if (type === "agents") {
            if (item.path.endsWith(".md")) {
              capability.metadata = {
                ...capability.metadata,
                ...(await extractAgentMetadata(item.path)),
              };
            } else if (item.path.endsWith(".toml")) {
              capability.metadata = {
                ...capability.metadata,
                ...(await extractCodexAgentMetadata(item.path)),
              };
            }
          } else if (type === "skills" && item.path.endsWith("SKILL.md")) {
            capability.metadata = {
              ...capability.metadata,
              ...(await extractSkillMetadata(item.path)),
            };
          }

          result.capabilities[type].push(capability);
        } catch (error) {
          result.errors.push(`Error processing ${item.path}: ${error.message}`);
        }
      }
    } catch (error) {
      result.errors.push(`Error scanning ${type}: ${error.message}`);
    }
  }

  return result;
}

// ========== 索引构建 ==========

async function collectRepoCanonicalCapabilities() {
  const agents = await scanMarkdownFiles(path.join(repoRoot, "canonical", "agents"));
  const skills = await scanSkillFiles(path.join(repoRoot, "canonical", "skills"));
  const skillReferences = await scanMarkdownFilesRecursive(
    path.join(repoRoot, "canonical", "skills", "meta-theory", "references"),
  );
  const sharedHooks = await scanHookFiles(
    path.join(repoRoot, "canonical", "runtime-assets", "shared", "hooks"),
  );
  const claudeHooks = await scanHookFiles(
    path.join(repoRoot, "canonical", "runtime-assets", "claude", "hooks"),
  );
  const openclawHooks = await scanHookFiles(
    path.join(repoRoot, "canonical", "runtime-assets", "openclaw", "hooks"),
  );

  const toRepoCapability = (item, type, namespace) => ({
    id: item.id,
    type,
    namespace,
    path: path.relative(repoRoot, item.path).replace(/\\/g, "/"),
    relativePath: item.relativePath?.replace(/\\/g, "/"),
    size: item.size,
    modified: item.modified,
  });

  return {
    agents: agents.map((item) => toRepoCapability(item, "agents", "canonical")),
    skills: [
      ...skills.map((item) => toRepoCapability(item, "skills", "canonical")),
      ...skillReferences.map((item) =>
        toRepoCapability(item, "skills", "canonical-reference"),
      ),
    ],
    hooks: [...sharedHooks, ...claudeHooks, ...openclawHooks].map((item) =>
      toRepoCapability(item, "hooks", "canonical-runtime-assets"),
    ),
    plugins: [],
    commands: [],
  };
}

async function buildRepoCapabilityIndex() {
  const capabilities = await collectRepoCanonicalCapabilities();
  const index = {
    generatedAt: new Date().toISOString(),
    registryName: "meta-kim-capabilities",
    scope: "repo-canonical",
    canonicalProjection: CANONICAL_CAPABILITY_INDEX,
    canonicalSource: CANONICAL_CAPABILITY_INDEX,
    localGlobalInventory: LOCAL_GLOBAL_INVENTORY,
    mirroredTo: [
      ".claude/capability-index/meta-kim-capabilities.json",
      ".codex/capability-index/meta-kim-capabilities.json",
      "openclaw/capability-index/meta-kim-capabilities.json",
      ".cursor/capability-index/meta-kim-capabilities.json",
    ],
    fetchOrder: [
      "repo canonical capability index",
      "runtime mirror",
      "local global inventory",
      "fallback general agent with capability gap record",
    ],
    summary: {
      totalAgents: capabilities.agents.length,
      totalSkills: capabilities.skills.length,
      totalHooks: capabilities.hooks.length,
      totalPlugins: 0,
      totalCommands: 0,
    },
    byCapabilityType: {
      agents: Object.fromEntries(
        capabilities.agents.map((cap) => [`repo:${cap.namespace}:${cap.id}`, cap]),
      ),
      skills: Object.fromEntries(
        capabilities.skills.map((cap) => [`repo:${cap.namespace}:${cap.id}`, cap]),
      ),
      hooks: Object.fromEntries(
        capabilities.hooks.map((cap) => [`repo:${cap.namespace}:${cap.id}`, cap]),
      ),
      plugins: {},
      commands: {},
    },
  };

  return index;
}

async function buildGlobalCapabilityInventory(scannedResults, profile) {
  const index = {
    generatedAt: new Date().toISOString(),
    registryName: "global-capabilities",
    scope: "local-global-inventory",
    profile,
    canonicalProjection: CANONICAL_CAPABILITY_INDEX,
    repoCanonicalIndex: CANONICAL_CAPABILITY_INDEX,
    localInventoryPath: LOCAL_GLOBAL_INVENTORY.replace("{profile}", profile),
    summary: {
      totalAgents: 0,
      totalSkills: 0,
      totalHooks: 0,
      totalPlugins: 0,
      totalCommands: 0,
    },
    byPlatform: {},
    byCapabilityType: {
      agents: {},
      skills: {},
      hooks: {},
      plugins: {},
      commands: {},
    },
  };

  for (const scan of scannedResults) {
    index.byPlatform[scan.platformId] = scan;

    for (const [type, capabilities] of Object.entries(scan.capabilities)) {
      index.summary[`total${type.charAt(0).toUpperCase()}${type.slice(1)}`] +=
        capabilities.length;

      for (const cap of capabilities) {
        const key = `${scan.platformId}:${cap.id}`;
        index.byCapabilityType[type][key] = cap;
      }
    }
  }

  return index;
}

// ========== 输出格式 ==========

function formatTableOutput(index) {
  let output = "\n📊 Global Capability Summary\n\n";

  for (const [platformId, data] of Object.entries(index.byPlatform)) {
    output += `🔹 ${data.platform} (${data.baseDir})\n`;
    for (const [type, items] of Object.entries(data.capabilities)) {
      if (items.length > 0) {
        output += `   ${type}: ${items.length}\n`;
      }
    }
    if (data.errors.length > 0) {
      output += `   ⚠️  Errors: ${data.errors.length}\n`;
    }
  }

  output += "\n📋 Detailed Inventory\n\n";

  for (const [type, items] of Object.entries(index.byCapabilityType)) {
    const keys = Object.keys(items);
    if (keys.length === 0) continue;

    output += `\n### ${type.toUpperCase()} (${keys.length})\n\n`;

    for (const [key, cap] of Object.entries(items)) {
      const metaParts = [];
      if (cap.metadata?.description) {
        metaParts.push(cap.metadata.description.substring(0, 80) + "...");
      } else if (cap.metadata?.title) {
        metaParts.push(cap.metadata.title);
      }
      if (cap.metadata?.version) {
        metaParts.push(`v${cap.metadata.version}`);
      }

      output += `  ${key}`;
      if (metaParts.length > 0) {
        output += `\n    → ${metaParts.join(" | ")}`;
      }
      output += "\n";
    }
  }

  return output;
}

// ========== 主函数 ==========

async function main() {
  const args = process.argv.slice(2);
  const outputFormat = args.includes("--json") ? "json" : "table";
  const filterPlatform = args
    .find((a) => a.startsWith("--platform="))
    ?.split("=")[1];
  const filterType = args.find((a) => a.startsWith("--type="))?.split("=")[1];

  const platformsToScan = filterPlatform
    ? { [filterPlatform]: PLATFORMS[filterPlatform] }
    : PLATFORMS;

  console.error("🔍 Scanning global capabilities across platforms...\n");

  const scannedResults = [];
  for (const [platformId, platform] of Object.entries(platformsToScan)) {
    console.error(`  Scanning ${platform.name}...`);
    const result = await scanPlatform(platformId, platform);
    scannedResults.push(result);

    if (result.errors.length > 0) {
      console.error(`    ⚠️  ${result.errors.length} errors`);
    }
  }

  const profileState = await ensureProfileState();
  const repoCapabilityIndex = await buildRepoCapabilityIndex();
  const globalInventory = await buildGlobalCapabilityInventory(
    scannedResults,
    profileState.profile,
  );

  if (outputFormat === "json") {
    console.log(JSON.stringify(globalInventory, null, 2));
  } else {
    console.log(formatTableOutput(globalInventory));
  }

  // Write the repo-neutral canonical index, then mirror only that index into
  // runtime projections. Machine-specific global inventory stays local-only.
  const repoContent = `${JSON.stringify(repoCapabilityIndex, null, 2)}\n`;
  const canonicalIndexPath = path.join(repoRoot, CANONICAL_CAPABILITY_INDEX);
  await fs.mkdir(path.dirname(canonicalIndexPath), { recursive: true });
  await fs.writeFile(canonicalIndexPath, repoContent);

  const platformIndexDirs = [
    path.join(repoRoot, ".claude", "capability-index"),
    path.join(repoRoot, ".codex", "capability-index"),
    path.join(repoRoot, "openclaw", "capability-index"),
    path.join(repoRoot, ".cursor", "capability-index"),
  ];

  for (const indexDir of platformIndexDirs) {
    await fs.mkdir(indexDir, { recursive: true });
    await fs.writeFile(
      path.join(indexDir, "meta-kim-capabilities.json"),
      repoContent,
    );
    await fs.rm(path.join(indexDir, "global-capabilities.json"), {
      force: true,
    });
  }

  const localInventoryPath = path.join(
    profileState.profileDir,
    "capability-index",
    "global-capabilities.json",
  );
  await fs.mkdir(path.dirname(localInventoryPath), { recursive: true });
  await fs.writeFile(
    localInventoryPath,
    `${JSON.stringify(globalInventory, null, 2)}\n`,
  );

  console.error(`\n✅ Canonical index written to ${CANONICAL_CAPABILITY_INDEX}`);
  console.error(`✅ Local inventory written to ${path.relative(repoRoot, localInventoryPath).replace(/\\/g, "/")}`);
  console.error(`✅ Canonical index mirrored to ${platformIndexDirs.length} platforms:`);
  for (const dir of platformIndexDirs) {
    const rel = path.relative(repoRoot, dir).replace(/\\/g, "/");
    console.error(`   ${rel}/`);
  }
}

await main();
