import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const claudeAgentsDir = path.join(repoRoot, ".claude", "agents");
const openclawWorkspacesDir = path.join(repoRoot, "openclaw", "workspaces");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseFrontmatter(raw, filePath) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`${filePath} is missing YAML frontmatter.`);
  }

  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      throw new Error(`${filePath} has an invalid frontmatter line: ${line}`);
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    data[key] = value.replace(/^['"]|['"]$/g, "");
  }

  return data;
}

async function validateRequiredFiles() {
  const requiredFiles = [
    "README.md",
    "CLAUDE.md",
    "AGENTS.md",
    "LICENSE",
    ".gitignore",
    "meta/meta.md",
    ".claude/skills/meta-theory/SKILL.md",
    "openclaw/openclaw.template.json",
  ];

  for (const relativePath of requiredFiles) {
    assert(
      await exists(path.join(repoRoot, relativePath)),
      `Missing required file: ${relativePath}`
    );
  }
}

async function validateClaudeAgents() {
  const files = (await fs.readdir(claudeAgentsDir))
    .filter((file) => file.endsWith(".md"))
    .sort();

  assert(files.length >= 1, "No Claude agent files found.");

  const ids = [];
  for (const file of files) {
    const filePath = path.join(claudeAgentsDir, file);
    const raw = await fs.readFile(filePath, "utf8");
    const frontmatter = parseFrontmatter(raw, filePath);
    assert(frontmatter.name, `${file} is missing frontmatter name.`);
    assert(frontmatter.description, `${file} is missing frontmatter description.`);
    assert(
      frontmatter.name === file.replace(/\.md$/, ""),
      `${file} frontmatter name must match filename.`
    );
    ids.push(frontmatter.name);
  }

  return ids;
}

async function validateOpenClawArtifacts(agentIds) {
  const templateConfigPath = path.join(repoRoot, "openclaw", "openclaw.template.json");
  const templateConfig = JSON.parse(await fs.readFile(templateConfigPath, "utf8"));
  const configIds = templateConfig.agents?.list?.map((agent) => agent.id) ?? [];

  assert(
    JSON.stringify(configIds) === JSON.stringify(agentIds),
    "openclaw/openclaw.template.json agent list is out of sync with .claude/agents."
  );

  const allowedIds = templateConfig.tools?.agentToAgent?.allow ?? [];
  assert(
    JSON.stringify(allowedIds) === JSON.stringify(agentIds),
    "OpenClaw agentToAgent allow-list is out of sync with .claude/agents."
  );

  for (const agentId of agentIds) {
    for (const fileName of ["SOUL.md", "AGENTS.md", "HEARTBEAT.md"]) {
      const workspaceFile = path.join(openclawWorkspacesDir, agentId, fileName);
      assert(await exists(workspaceFile), `Missing OpenClaw workspace file: ${path.relative(repoRoot, workspaceFile)}`);
    }
  }
}

async function validatePackageJson() {
  const packageJsonPath = path.join(repoRoot, "package.json");
  const pkg = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  assert(pkg.scripts?.["sync:runtimes"], "package.json is missing sync:runtimes.");
  assert(pkg.scripts?.validate, "package.json is missing validate.");
  assert(pkg.license === "MIT", "package.json license must be MIT.");
}

async function validateGitignore() {
  const gitignorePath = path.join(repoRoot, ".gitignore");
  const gitignore = await fs.readFile(gitignorePath, "utf8");
  for (const expected of ["node_modules/", "openclaw/openclaw.local.json"]) {
    assert(gitignore.includes(expected), `.gitignore is missing ${expected}`);
  }
}

async function main() {
  await validateRequiredFiles();
  const agentIds = await validateClaudeAgents();
  await validateOpenClawArtifacts(agentIds);
  await validatePackageJson();
  await validateGitignore();
  console.log(`Validation passed for ${agentIds.length} agents.`);
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
