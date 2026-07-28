import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  parseRuntimeCapabilityMatrix,
  parseRuntimeCapabilityEvidenceLedger,
  readRequiredPackagedText,
  validateRequiredMarkdown,
} from "./runtime-resource-contract.mjs";
import { loadEffectiveRuntimeCapabilityClaims } from "../effective-runtime-capability-claims.mjs";
import { standardRuntimeObservationSet } from "../runtime-execution-gate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const packagedCanonicalAgentsDir = path.join(repoRoot, "canonical", "agents");

const preferredOrder = [
  "meta-warden",
  "meta-genesis",
  "meta-artisan",
  "meta-sentinel",
  "meta-librarian",
  "meta-conductor",
  "meta-prism",
  "meta-scout",
  "meta-chrysalis",
];
const metaAgentFilePattern = /^meta-[\w-]+\.md$/i;
const dispatchModes = new Set(["plan", "execute"]);
const maxDispatchOutputChars = 12000;

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
  const files = (await fs.readdir(packagedCanonicalAgentsDir))
    .filter((file) => metaAgentFilePattern.test(file))
    .sort();

  const agents = [];
  for (const file of files) {
    const filePath = path.join(packagedCanonicalAgentsDir, file);
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

async function loadRuntimeCapabilityMatrix(filePath) {
  const raw = await readRequiredPackagedText(filePath, {
    packageRoot: repoRoot,
    label: "Meta_Kim runtime capability matrix",
  });
  const matrix = parseRuntimeCapabilityMatrix(raw, filePath);
  return JSON.stringify(matrix, null, 2);
}

async function loadRuntimeCapabilityEvidence(filePath) {
  const raw = await readRequiredPackagedText(filePath, {
    packageRoot: repoRoot,
    label: "Meta_Kim runtime capability evidence ledger",
  });
  return JSON.stringify(parseRuntimeCapabilityEvidenceLedger(raw, filePath), null, 2);
}

function currentEffectiveRuntimeCapabilities() {
  const redact = (message) => String(message)
    .replaceAll(repoRoot, "<package>")
    .replaceAll(process.cwd(), "<cwd>")
    .replace(/[A-Za-z]:[\\/][^\r\n;]+/gu, "<absolute>");
  try {
    const state = loadEffectiveRuntimeCapabilityClaims({
      packageRoot: repoRoot,
      projectRoot: process.env.META_KIM_CALLER_CWD || undefined,
    });
    const results = (state.overlayStatus?.applied ?? []).map((entry) => ({
      ...entry,
      evidenceClass: "advisory_persisted_observation",
      observedInCurrentRun: false,
      executionAuthority: false,
    }));
    const observed = new Set(results.map((entry) => `${entry.runtime}:${entry.capability}:${entry.mode}`));
    const missing = standardRuntimeObservationSet().filter((entry) => !observed.has(`${entry.runtime}:${entry.capability}:${entry.mode}`));
    return JSON.stringify({
      matrix: state.effectiveMatrix,
      overlayStatus: state.overlayStatus,
      results,
      missing,
      evidenceClass: "advisory_persisted_observation",
      observedInCurrentRun: false,
      executionAuthority: false,
      currentHostAdapter: "unavailable_over_mcp_resource_read",
      issues: state.issues.map(redact),
    }, null, 2);
  } catch {
    return JSON.stringify({
      matrix: null,
      overlayStatus: { state: "blocked", applied: [], rejected: [] },
      results: [],
      missing: standardRuntimeObservationSet(),
      evidenceClass: "advisory_persisted_observation",
      observedInCurrentRun: false,
      executionAuthority: false,
      currentHostAdapter: "unavailable_over_mcp_resource_read",
      issues: ["effective runtime overlay could not be read safely"],
    }, null, 2);
  }
}

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
    "config",
    "runtime-capability-matrix.json",
  );
  const evidencePath = path.join(repoRoot, "config", "runtime-capability-evidence.json");
  const metaTheorySkillPath = path.join(
    repoRoot,
    "canonical",
    "skills",
    "meta-theory",
    "SKILL.md",
  );

  const [metaTheoryRaw, runtimeMatrix, runtimeEvidence, metaTheorySkillRaw] = await Promise.all([
    readRequiredPackagedText(metaTheoryPath, {
      packageRoot: repoRoot,
      label: "Meta_Kim theory reference",
    }),
    loadRuntimeCapabilityMatrix(matrixPath),
    loadRuntimeCapabilityEvidence(evidencePath),
    readRequiredPackagedText(metaTheorySkillPath, {
      packageRoot: repoRoot,
      label: "Meta_Kim skill definition",
    }),
  ]);

  const metaTheory = validateRequiredMarkdown(metaTheoryRaw, {
    label: "Meta_Kim theory reference",
  });
  const metaTheorySkill = validateRequiredMarkdown(metaTheorySkillRaw, {
    label: "Meta_Kim skill definition",
    requireFrontmatter: true,
    expectedFrontmatterName: "meta-theory",
  });
  return { agents, metaTheory, runtimeMatrix, runtimeEvidence, metaTheorySkill };
}

function jsonText(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function trimOutput(text, maxLength = maxDispatchOutputChars) {
  if (typeof text !== "string") return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...[trimmed ${text.length - maxLength} chars]`;
}

function payloadToText(payload) {
  if (payload === undefined || payload === null) return "";
  if (typeof payload === "string") return payload;
  return JSON.stringify(payload, null, 2);
}

function buildDispatchTask({ agent, scope, payload }) {
  const payloadText = payloadToText(payload);
  return [
    `MCP dispatch requested for Meta_Kim agent ${agent.id}.`,
    `Agent title: ${agent.title}`,
    `Scope: ${scope}`,
    payloadText ? `Payload:\n${payloadText}` : "Payload: none",
    "Run through the governed Meta_Kim route; keep execution evidence and verification boundaries explicit.",
  ].join("\n\n");
}

async function runGovernedDispatch({ agent, scope, payload }) {
  const runner = path.join(
    repoRoot,
    "scripts",
    "run-meta-theory-governed-execution.mjs",
  );
  const task = buildDispatchTask({ agent, scope, payload });
  const args = [runner, "--task", task, "--temp-output"];

  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        META_KIM_MCP_DISPATCH_AGENT_ID: agent.id,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      stderr += "\nTimed out after 60000ms.";
    }, 60000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        exitCode: null,
        signal: null,
        stdout: trimOutput(stdout),
        stderr: trimOutput(`${stderr}\n${error.message}`),
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code,
        signal,
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr),
      });
    });
  });
}

const runtimeData = await loadRuntimeData();

if (process.argv.includes("--effective-runtime-self-test")) {
  process.stdout.write(`${currentEffectiveRuntimeCapabilities()}\n`);
  process.exit(0);
}

if (process.argv.includes("--self-test")) {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        agentCount: runtimeData.agents.length,
        agentIds: runtimeData.agents.map((agent) => agent.id),
        agentSources: runtimeData.agents.map((agent) => agent.sourceFile),
        resources: [
          "meta://theory",
          "meta://runtime-matrix",
          "meta://runtime-evidence",
          "meta://runtime-effective",
          "meta://skill/meta-theory",
        ],
        tools: [
          "list_meta_agents",
          "get_meta_agent",
          "get_meta_runtime_capabilities",
          "get_meta_runtime_evidence",
          "get_meta_effective_runtime_capabilities",
          "dispatch_meta_agent",
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
        text: runtimeData.metaTheorySkill,
      },
    ],
  }),
);

server.registerResource(
  "runtime-evidence",
  "meta://runtime-evidence",
  { description: "Canonical static runtime observation ledger", mimeType: "application/json" },
  async () => ({ contents: [{ uri: "meta://runtime-evidence", mimeType: "application/json", text: runtimeData.runtimeEvidence }] }),
);

server.registerResource(
  "runtime-effective",
  "meta://runtime-effective",
  { description: "Profile-local effective runtime capability status", mimeType: "application/json" },
  async () => ({ contents: [{ uri: "meta://runtime-effective", mimeType: "application/json", text: currentEffectiveRuntimeCapabilities() }] }),
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
      agentId: z
        .string()
        .min(1)
        .max(100)
        .regex(
          /^[a-zA-Z0-9_-]+$/,
          "agentId must contain only alphanumeric/underscore/dash",
        ),
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
    description: "Return the canonical Meta_Kim runtime capability matrix.",
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

server.registerTool(
  "get_meta_runtime_evidence",
  { description: "Return the canonical static runtime observation ledger.", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: runtimeData.runtimeEvidence }] }),
);

server.registerTool(
  "get_meta_effective_runtime_capabilities",
  { description: "Return profile-local advisory runtime observations. This read-only MCP result never grants current-run execution authority.", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: currentEffectiveRuntimeCapabilities() }] }),
);

server.registerTool(
  "dispatch_meta_agent",
  {
    description:
      "Create a governed Meta_Kim dispatch packet for a meta-agent; execute only when explicitly approved.",
    inputSchema: {
      agentId: z
        .string()
        .min(1)
        .max(100)
        .regex(/^[a-zA-Z0-9_-]+$/, "agentId must contain only alphanumeric/underscore/dash"),
      scope: z.string().min(1).max(4000),
      payload: z.unknown().optional(),
      mode: z.enum(["plan", "execute"]).optional(),
      executionApproved: z.boolean().optional(),
    },
  },
  async ({
    agentId,
    scope,
    payload = null,
    mode = "plan",
    executionApproved = false,
  }) => {
    const agent = runtimeData.agents.find((item) => item.id === agentId);
    if (!agent) {
      return jsonText({
        ok: false,
        status: "unknown_agent",
        error: `Unknown agentId: ${agentId}`,
        availableAgentIds: runtimeData.agents.map((item) => item.id),
      });
    }

    if (!dispatchModes.has(mode)) {
      return jsonText({
        ok: false,
        status: "invalid_mode",
        error: `Unsupported dispatch mode: ${mode}`,
        allowedModes: [...dispatchModes],
      });
    }

    const packet = {
      ok: true,
      status: mode === "execute" ? "execution_requested" : "planned",
      tool: "dispatch_meta_agent",
      agentId: agent.id,
      title: agent.title,
      sourceFile: agent.sourceFile,
      scope,
      payload,
      route: {
        runner: "scripts/run-meta-theory-governed-execution.mjs",
        args: ["--task", "<MCP dispatch task>", "--temp-output"],
        outputPolicy: "temp-output",
      },
      safety: {
        defaultMode: "plan",
        executionRequires: ["mode=execute", "executionApproved=true"],
        commandPolicy:
          "fixed node runner path, no shell interpolation, no arbitrary command string",
      },
    };

    if (mode !== "execute") {
      return jsonText({
        ...packet,
        nextAction:
          "Review this dispatch packet; call again with mode=execute and executionApproved=true to run the governed route.",
      });
    }

    if (!executionApproved) {
      return jsonText({
        ...packet,
        ok: false,
        status: "blocked_pending_execution_approval",
        error: "Execution mode requires executionApproved=true.",
      });
    }

    const execution = await runGovernedDispatch({ agent, scope, payload });
    return jsonText({
      ...packet,
      status: execution.exitCode === 0 ? "executed" : "execution_failed",
      execution,
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
