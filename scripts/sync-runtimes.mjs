import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const claudeAgentsDir = path.join(repoRoot, ".claude", "agents");
const openclawDir = path.join(repoRoot, "openclaw");
const openclawWorkspacesDir = path.join(openclawDir, "workspaces");
const templateConfigPath = path.join(openclawDir, "openclaw.template.json");
const localConfigPath = path.join(openclawDir, "openclaw.local.json");
const checkOnly = process.argv.includes("--check");

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

async function loadAgents() {
  const files = (await fs.readdir(claudeAgentsDir))
    .filter((file) => file.endsWith(".md"))
    .sort();

  const agents = [];
  for (const file of files) {
    const filePath = path.join(claudeAgentsDir, file);
    const raw = await fs.readFile(filePath, "utf8");
    const { data, body } = parseFrontmatter(raw, filePath);

    if (!data.name || !data.description) {
      throw new Error(`${filePath} must define frontmatter name and description.`);
    }

    agents.push({
      id: data.name,
      description: data.description,
      sourceFile: path.relative(repoRoot, filePath).replace(/\\/g, "/"),
      title: extractTitle(body, data.name),
      summary: extractSummary(body, data.description),
      role: roleFromTitle(extractTitle(body, data.name), data.description),
      body: body.trim(),
    });
  }

  return sortAgents(agents);
}

function buildWorkspaceDirectory(agents) {
  const rows = agents
    .map(
      (agent) =>
        `| \`${agent.id}\` | ${agent.title} | ${agent.description} |`
    )
    .join("\n");

  return `# AGENTS.md - Meta_Kim Team Directory

This file is generated from \`.claude/agents/*.md\` by \`npm run sync:runtimes\`.

Use the smallest agent whose boundary matches the task. Escalate to \`meta-warden\` when the task spans multiple agent boundaries.

| Agent ID | Name | Responsibility |
| --- | --- | --- |
${rows}
`;
}

function buildSoul(agent) {
  return `# SOUL.md - ${agent.id}

Generated from \`${agent.sourceFile}\`. Edit the Claude source file first, then run \`npm run sync:runtimes\`.

## Runtime Notes

- You are running inside OpenClaw.
- Read the local \`AGENTS.md\` before delegating with \`sessions_send\`.
- Stay inside your own responsibility boundary unless the user explicitly asks you to coordinate broader work.
- The long-form theory source lives at \`meta/meta.md\` in this repository.

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

function buildOpenClawConfig(agents, workspaceRoot) {
  return {
    agents: {
      defaults: {
        model: "claude-sonnet-4-5",
      },
      list: agents.map((agent, index) => ({
        id: agent.id,
        default: index === 0,
        name: agent.title,
        workspace: path.join(workspaceRoot, agent.id),
      })),
    },
    bindings: [],
    tools: {
      agentToAgent: {
        enabled: true,
        allow: agents.map((agent) => agent.id),
      },
    },
  };
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
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
    return { changed: true };
  }

  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, nextContent, "utf8");
  return { changed: true };
}

async function writeGeneratedJson(filePath, value) {
  const nextContent = `${JSON.stringify(value, null, 2)}\n`;
  return writeGeneratedFile(filePath, nextContent);
}

async function main() {
  const agents = await loadAgents();
  const teamDirectory = buildWorkspaceDirectory(agents);
  const changedFiles = [];

  for (const agent of agents) {
    const workspaceDir = path.join(openclawWorkspacesDir, agent.id);
    const writes = await Promise.all([
      writeGeneratedFile(path.join(workspaceDir, "SOUL.md"), buildSoul(agent)),
      writeGeneratedFile(path.join(workspaceDir, "AGENTS.md"), teamDirectory),
      writeGeneratedFile(
        path.join(workspaceDir, "HEARTBEAT.md"),
        buildHeartbeat(agent)
      ),
    ]);

    if (writes.some((result) => result.changed)) {
      changedFiles.push(`openclaw/workspaces/${agent.id}`);
    }
  }

  const templateConfig = buildOpenClawConfig(
    agents,
    "__REPO_ROOT__/openclaw/workspaces"
  );
  const localConfig = buildOpenClawConfig(
    agents,
    path.join(repoRoot, "openclaw", "workspaces")
  );

  if ((await writeGeneratedJson(templateConfigPath, templateConfig)).changed) {
    changedFiles.push("openclaw/openclaw.template.json");
  }
  if ((await writeGeneratedJson(localConfigPath, localConfig)).changed) {
    changedFiles.push("openclaw/openclaw.local.json");
  }

  if (checkOnly && changedFiles.length > 0) {
    console.error("Generated runtime assets are out of date:");
    for (const file of changedFiles) {
      console.error(`- ${file}`);
    }
    process.exitCode = 1;
    return;
  }

  if (checkOnly) {
    console.log("Runtime assets are up to date.");
    return;
  }

  console.log(`Synced ${agents.length} agents into OpenClaw runtime assets.`);
}

await main();
