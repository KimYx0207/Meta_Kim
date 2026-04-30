import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { canonicalAgentsDir } from "../meta-kim-sync-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

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
const metaAgentFilePattern = /^meta-[\w-]+\.md$/i;

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

function sortAgents(agents) {
  return [...agents].sort((left, right) => {
    const leftIndex = preferredOrder.indexOf(left.id);
    const rightIndex = preferredOrder.indexOf(right.id);
    return (
      (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) -
      (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex)
    );
  });
}

async function loadAgents() {
  const files = (await fs.readdir(canonicalAgentsDir))
    .filter((file) => metaAgentFilePattern.test(file))
    .sort();

  const agents = [];
  for (const file of files) {
    const filePath = path.join(canonicalAgentsDir, file);
    const raw = await fs.readFile(filePath, "utf8");
    const { data, body } = parseFrontmatter(raw, filePath);
    const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? data.name;
    agents.push({
      id: data.name,
      description: data.description,
      title,
      sourceFile: path.relative(repoRoot, filePath).replace(/\\/g, "/"),
      prompt: body.trim(),
    });
  }
  return sortAgents(agents);
}

async function readUtf8IfExists(filePath, fallbackText) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return fallbackText;
  }
}

const FALLBACK_META_THEORY = `# Meta theory

Use **CLAUDE.md**, **AGENTS.md**, \`canonical/skills/meta-theory/SKILL.md\`, and \`canonical/skills/meta-theory/references/meta-theory.md\` as the canonical Meta_Kim context.
`;

const FALLBACK_RUNTIME_MATRIX = `# Runtime capability matrix (stub)

\`docs/runtime-capability-matrix.md\` is not present in this working tree. See **AGENTS.md** for Codex/OpenClaw mirrors and runtime sync commands (\`npm run meta:sync\`, \`npm run meta:validate\`).
`;

async function loadRuntimeData() {
  const agents = await loadAgents();
  const metaTheoryPath = path.join(
    repoRoot,
    "canonical",
    "skills",
    "meta-theory",
    "references",
    "meta-theory.md",
  );
  const matrixPath = path.join(
    repoRoot,
    "docs",
    "runtime-capability-matrix.md",
  );
  const openclawSkillPath = path.join(
    repoRoot,
    "openclaw",
    "skills",
    "meta-theory",
    "SKILL.md",
  );

  const [metaTheory, runtimeMatrix, openclawSkill] = await Promise.all([
    readUtf8IfExists(metaTheoryPath, FALLBACK_META_THEORY),
    readUtf8IfExists(matrixPath, FALLBACK_RUNTIME_MATRIX),
    readUtf8IfExists(openclawSkillPath, FALLBACK_META_THEORY),
  ]);

  return { agents, metaTheory, runtimeMatrix, openclawSkill };
}

const runtimeData = await loadRuntimeData();

if (process.argv.includes("--self-test")) {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        agentCount: runtimeData.agents.length,
        resources: [
          "meta://theory",
          "meta://runtime-matrix",
          "meta://skill/meta-theory",
        ],
        tools: [
          "list_meta_agents",
          "get_meta_agent",
          "get_meta_runtime_capabilities",
        ],
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

const server = new McpServer({
  name: "meta-kim-runtime",
  version: "1.1.0",
});

server.registerResource(
  "meta-theory",
  "meta://theory",
  {
    description: "Canonical Meta_Kim theory transcript",
    mimeType: "text/markdown",
  },
  async () => ({
    contents: [
      {
        uri: "meta://theory",
        mimeType: "text/markdown",
        text: runtimeData.metaTheory,
      },
    ],
  }),
);

server.registerResource(
  "runtime-matrix",
  "meta://runtime-matrix",
  {
    description: "Capability matrix across Claude Code, OpenClaw, and Codex",
    mimeType: "text/markdown",
  },
  async () => ({
    contents: [
      {
        uri: "meta://runtime-matrix",
        mimeType: "text/markdown",
        text: runtimeData.runtimeMatrix,
      },
    ],
  }),
);

server.registerResource(
  "meta-skill",
  "meta://skill/meta-theory",
  {
    description: "Portable Meta_Kim skill definition",
    mimeType: "text/markdown",
  },
  async () => ({
    contents: [
      {
        uri: "meta://skill/meta-theory",
        mimeType: "text/markdown",
        text: runtimeData.openclawSkill,
      },
    ],
  }),
);

server.registerTool(
  "list_meta_agents",
  {
    description: "List the Meta_Kim agents, their roles, and source files.",
    inputSchema: {},
  },
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          runtimeData.agents.map((agent) => ({
            id: agent.id,
            title: agent.title,
            description: agent.description,
            sourceFile: agent.sourceFile,
          })),
          null,
          2,
        ),
      },
    ],
  }),
);

server.registerTool(
  "get_meta_agent",
  {
    description: "Return the definition of a single Meta_Kim agent.",
    inputSchema: {
      agentId: z.string(),
      includePrompt: z.boolean().optional(),
    },
  },
  async ({ agentId, includePrompt = false }) => {
    const agent = runtimeData.agents.find((item) => item.id === agentId);

    if (!agent) {
      return {
        content: [
          {
            type: "text",
            text: `Unknown agentId: ${agentId}`,
          },
        ],
      };
    }

    const response = {
      id: agent.id,
      title: agent.title,
      description: agent.description,
      sourceFile: agent.sourceFile,
    };

    if (includePrompt) {
      response.prompt = agent.prompt;
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  },
);

server.registerTool(
  "get_meta_runtime_capabilities",
  {
    description:
      "Return the runtime capability matrix for Claude Code, OpenClaw, and Codex.",
    inputSchema: {},
  },
  async () => ({
    content: [
      {
        type: "text",
        text: runtimeData.runtimeMatrix,
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
