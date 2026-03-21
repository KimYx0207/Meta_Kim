import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const claudeAgentsDir = path.join(repoRoot, ".claude", "agents");
const openclawLocalConfigPath = path.join(repoRoot, "openclaw", "openclaw.local.json");
const prepareOpenClawScriptPath = path.join(repoRoot, "scripts", "prepare-openclaw-local.mjs");

const claudeSchema = JSON.stringify({
  type: "object",
  properties: {
    agent: { type: "string" },
    owns: { type: "array", items: { type: "string" } },
    refuses: { type: "array", items: { type: "string" } },
    artifact: { type: "string" },
    delegates_to: { type: "array", items: { type: "string" } },
  },
  required: ["agent", "owns", "refuses", "artifact", "delegates_to"],
});

const claudeCases = {
  "meta-warden": {
    ownGroups: [["统筹", "协调", "编排", "质量标准", "CEO"], ["质量", "关卡", "仲裁"], ["综合", "整合", "最终"]],
    refuseGroups: [["具体分析", "分析"], ["工具发现", "Scout", "scout", "SOUL"]],
    artifactGroups: [["报告", "综合", "go/no-go", "仲裁"]],
  },
  "meta-genesis": {
    ownGroups: [["SOUL", "soul", "提示词", "prompt"], ["人格", "灵魂", "系统"], ["架构", "设计"]],
    refuseGroups: [["Hook", "hook", "权限", "安全"], ["MCP", "skill", "技能", "记忆"]],
    artifactGroups: [["SOUL", "prompt", "提示词"]],
  },
  "meta-artisan": {
    ownGroups: [["skill", "技能"], ["MCP", "工具", "ROI", "评分", "精选"], ["匹配", "装备", "能力"]],
    refuseGroups: [["SOUL", "prompt", "提示词"], ["记忆", "memory", "Hook", "hook", "钩子", "安全"]],
    artifactGroups: [["skill", "MCP", "能力清单", "映射", "report"]],
  },
  "meta-sentinel": {
    ownGroups: [["安全", "风险", "权限"], ["Hook", "hook", "守卫"], ["回滚", "边界", "策略", "三级", "CAN", "CANNOT", "NEVER"]],
    refuseGroups: [["SOUL", "prompt", "提示词"], ["工具发现", "skill", "技能", "工作流", "编排"]],
    artifactGroups: [["Hook", "回滚", "安全规则", "守卫"]],
  },
  "meta-librarian": {
    ownGroups: [["记忆", "memory", "知识", "MEMORY"], ["连续性", "沉淀", "架构", "continuity", "persistence"], ["上下文", "档案", "索引", "保质期", "淘汰规则", "protocol"]],
    refuseGroups: [["Hook", "hook", "权限"], ["SOUL", "prompt", "提示词"]],
    artifactGroups: [["记忆", "索引", "档案", "memory"]],
  },
  "meta-conductor": {
    ownGroups: [["编排", "workflow", "工作流"], ["阶段", "节奏"], ["牌组", "发牌", "协作", "分工"]],
    refuseGroups: [["SOUL", "prompt", "提示词"], ["技能匹配", "安全", "记忆"]],
    artifactGroups: [["workflow", "工作流", "计划", "编排", "牌组"]],
  },
  "meta-prism": {
    ownGroups: [["质量", "审查", "review"], ["slop", "漂移", "缺陷"], ["验证", "回归"]],
    refuseGroups: [["工具发现", "Scout", "scout"], ["统筹", "Warden", "warden"]],
    artifactGroups: [["审查", "报告", "缺陷", "review"]],
  },
  "meta-scout": {
    ownGroups: [["发现", "discovery", "扫描"], ["工具", "skill", "MCP"], ["生态", "外部", "引入"]],
    refuseGroups: [["质量法医", "质量审查", "Prism", "prism"], ["安全", "Hook", "hook", "SOUL"]],
    artifactGroups: [["清单", "地图", "调研", "扫描", "分析报告"]],
  },
};

function normalize(value) {
  if (Array.isArray(value)) {
    return value.join(" ");
  }
  return String(value || "");
}

function keywordGroupMatched(text, keywords) {
  return keywords.some((keyword) => text.includes(String(keyword).toLowerCase()));
}

function parseJsonLines(raw) {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const parsed = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {}
  }
  return parsed;
}

function parseLastJson(raw) {
  const parsedLines = parseJsonLines(raw);
  if (parsedLines.length > 0) {
    return parsedLines.at(-1);
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractClaudeStructured(raw) {
  const parsed = parseLastJson(raw);
  if (!parsed) {
    throw new Error("Claude output was not valid JSON.");
  }
  return parsed.structured_output || parsed.result || parsed;
}

function extractCodexReply(raw) {
  const events = parseJsonLines(raw);
  const lastMessage = [...events]
    .reverse()
    .find((event) => event.type === "item.completed" && event.item?.type === "agent_message");

  if (!lastMessage?.item?.text) {
    throw new Error("Codex did not emit a final agent message.");
  }

  try {
    return JSON.parse(lastMessage.item.text);
  } catch {
    return { raw: lastMessage.item.text };
  }
}

async function resolveOpenClawCommand() {
  if (process.platform !== "win32") {
    return {
      file: "openclaw",
      toArgs(args) {
        return args;
      },
    };
  }

  const { stdout } = await execFileAsync("where.exe", ["openclaw.ps1"], {
    cwd: repoRoot,
    timeout: 30_000,
    env: { ...process.env, NO_COLOR: "1" },
  });

  const scriptPath = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!scriptPath) {
    throw new Error("Failed to resolve openclaw.ps1 via where.exe.");
  }

  return {
    file: "powershell.exe",
    toArgs(args) {
      const escapedScript = scriptPath.replace(/'/g, "''");
      const escapedArgs = args
        .map((arg) => `'${String(arg).replace(/'/g, "''")}'`)
        .join(" ");
      return [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `& '${escapedScript}' ${escapedArgs}`.trim(),
      ];
    },
  };
}

function extractOpenClawReply(raw) {
  const parsed = parseLastJson(raw);
  if (!parsed) {
    return { raw: raw.trim() };
  }

  const payloadText = parsed.payloads?.[0]?.text;
  if (typeof payloadText === "string" && payloadText.trim()) {
    try {
      return {
        ...JSON.parse(payloadText),
        wrapper: parsed,
      };
    } catch {
      return {
        raw: payloadText.trim(),
        wrapper: parsed,
      };
    }
  }

  const textCandidate =
    parsed.reply?.text ||
    parsed.output?.text ||
    parsed.message?.text ||
    parsed.response?.text ||
    parsed.text ||
    "";

  if (typeof textCandidate === "string" && textCandidate.trim()) {
    try {
      return JSON.parse(textCandidate);
    } catch {
      return { raw: textCandidate.trim(), wrapper: parsed };
    }
  }

  return parsed;
}

async function runCommandWithIgnoredStdin(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let finished = false;
    let timeoutId = null;
    let killTimerId = null;

    function settle(error, result) {
      if (finished) {
        return;
      }
      finished = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (killTimerId) {
        clearTimeout(killTimerId);
      }
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    }

    if (typeof options.timeout === "number" && options.timeout > 0) {
      timeoutId = setTimeout(() => {
        child.kill("SIGTERM");
        killTimerId = setTimeout(() => {
          child.kill("SIGKILL");
        }, 5_000);
        settle(
          new Error(
            `Command timed out after ${options.timeout}ms: ${file} ${args.join(" ")}`
          )
        );
      }, options.timeout);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      settle(error);
    });

    child.on("close", (code, signal) => {
      if (finished) {
        return;
      }
      if (code === 0) {
        settle(null, { stdout, stderr });
        return;
      }

      const failureDetails = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
      const suffix = signal ? ` (signal: ${signal})` : "";
      settle(
        new Error(
          `Command failed: ${file} ${args.join(" ")}${suffix}${
            failureDetails ? `\n${failureDetails}` : ""
          }`
        )
      );
    });
  });
}

function scoreClaudeCase(caseConfig, payload) {
  const joined = [
    payload.agent,
    normalize(payload.owns),
    normalize(payload.refuses),
    payload.artifact,
    normalize(payload.delegates_to),
  ]
    .join(" ")
    .toLowerCase();

  const matchedGroups = [];
  const missedGroups = [];

  for (const [label, groups] of Object.entries({
    own: caseConfig.ownGroups,
    refuse: caseConfig.refuseGroups,
    artifact: caseConfig.artifactGroups,
  })) {
    groups.forEach((group, index) => {
      const hit = keywordGroupMatched(joined, group);
      const entry = `${label}:${index + 1}`;
      if (hit) {
        matchedGroups.push(entry);
      } else {
        missedGroups.push(entry);
      }
    });
  }

  const totalGroups = matchedGroups.length + missedGroups.length;
  const score = totalGroups === 0 ? 1 : matchedGroups.length / totalGroups;
  return {
    score,
    matchedGroups,
    missedGroups,
  };
}

async function loadClaudeAgentIds() {
  const files = (await fs.readdir(claudeAgentsDir))
    .filter((file) => file.endsWith(".md"))
    .sort();

  return files.map((file) => file.replace(/\.md$/, ""));
}

async function runClaudeDiscovery(agentIds) {
  const { stdout } = await runCommandWithIgnoredStdin(
    "claude",
    ["agents"],
    {
      cwd: repoRoot,
      timeout: 60_000,
      env: { ...process.env, NO_COLOR: "1" },
    }
  );

  const missing = agentIds.filter((agentId) => !stdout.includes(agentId));
  return {
    ok: missing.length === 0,
    missing,
  };
}

async function runClaudeCases(agentIds) {
  const results = [];

  for (const agentId of agentIds) {
    const caseConfig = claudeCases[agentId];
    if (!caseConfig) {
      results.push({
        agentId,
        ok: false,
        error: "No eval case configured.",
      });
      continue;
    }

    try {
      const prompt =
        "你正在做 Meta_Kim 元 agent 角色边界自检。只返回符合 schema 的 JSON，不要解释。" +
        "agent 写你的 agent id；owns 写你只负责的 3 个短语；refuses 写你明确不负责的 2 个短语；" +
        "artifact 写你最核心的产物；delegates_to 写跨边界时最常升级/委派的 2 个 agent id。";

      const { stdout } = await runCommandWithIgnoredStdin(
        "claude",
        [
          "-p",
          "--output-format",
          "json",
          "--agent",
          agentId,
          "--json-schema",
          claudeSchema,
          prompt,
        ],
        {
          cwd: repoRoot,
          timeout: 120_000,
          env: { ...process.env, NO_COLOR: "1" },
        }
      );

      const payload = extractClaudeStructured(stdout);
      const { score, matchedGroups, missedGroups } = scoreClaudeCase(caseConfig, payload);
      results.push({
        agentId,
        ok: payload.agent === agentId && score >= 0.8,
        score,
        matchedGroups,
        missedGroups,
        sample: payload,
      });
    } catch (error) {
      results.push({
        agentId,
        ok: false,
        error: error.message,
      });
    }
  }

  return results;
}

async function runCodexSmoke() {
  const prompt =
    "请只输出一行 JSON，不要解释。字段有 " +
    "runtime、entrypoint、project_skill_root、compat_skill_mirror、custom_agents、mcp_supported、sandbox_configurable、approvals_configurable。" +
    "根据当前仓库回答 Codex 在这个项目中的接入点，只基于仓库内实际存在的文件。";

  const { stdout } = await execFileAsync(
    "codex",
    [
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "-C",
      repoRoot,
      prompt,
    ],
    {
      cwd: repoRoot,
      timeout: 180_000,
      env: { ...process.env, NO_COLOR: "1" },
    }
  );

  const payload = extractCodexReply(stdout);
  const entrypoints = Array.isArray(payload.entrypoint)
    ? payload.entrypoint
    : [payload.entrypoint];
  const skillRoots = Array.isArray(payload.project_skill_root)
    ? payload.project_skill_root
    : [payload.project_skill_root];
  const compatMirrors = Array.isArray(payload.compat_skill_mirror)
    ? payload.compat_skill_mirror
    : [payload.compat_skill_mirror];
  const customAgents = Array.isArray(payload.custom_agents)
    ? payload.custom_agents
    : [payload.custom_agents];
  const hasMetaWardenAgent = customAgents.some((item) => {
    const value = String(item || "");
    return value === "meta-warden" || value.endsWith("meta-warden.toml");
  });
  const ok =
    payload.runtime === "Codex" &&
    entrypoints.includes("AGENTS.md") &&
    (skillRoots.includes(".agents/skills/meta-theory") ||
      skillRoots.includes(".agents/skills/meta-theory/SKILL.md") ||
      skillRoots.includes(".agents/skills")) &&
    (compatMirrors.includes(".codex/skills/meta-theory.md") ||
      compatMirrors.includes(".codex/skills")) &&
    hasMetaWardenAgent &&
    payload.mcp_supported === true &&
    payload.sandbox_configurable === true &&
    payload.approvals_configurable === true;

  return {
    ok,
    sample: payload,
  };
}

async function runOpenClawSmoke() {
  await execFileAsync(
    "node",
    [prepareOpenClawScriptPath],
    {
      cwd: repoRoot,
      timeout: 120_000,
      env: { ...process.env, NO_COLOR: "1" },
    }
  );

  const command = await resolveOpenClawCommand();
  const env = {
    ...process.env,
    NO_COLOR: "1",
    OPENCLAW_CONFIG_PATH: openclawLocalConfigPath,
  };

  const validation = await execFileAsync(
    command.file,
    command.toArgs(["config", "validate"]),
    {
      cwd: repoRoot,
      timeout: 60_000,
      env,
    }
  );

  let hooksDiscovery = {
    ok: false,
    output: "",
  };
  try {
    const hooks = await execFileAsync(
      command.file,
      command.toArgs(["hooks", "list", "--verbose"]),
      {
        cwd: repoRoot,
        timeout: 60_000,
        env,
      }
    );
    const hooksOutput = hooks.stdout.trim();
    const hooksLower = hooksOutput.toLowerCase();
    const hooksNormalized = hooksLower.replace(/\s+/g, " ");
    hooksDiscovery = {
      ok:
        hooksNormalized.includes("boot-md") &&
        hooksNormalized.includes("command-") &&
        hooksNormalized.includes("logger") &&
        hooksNormalized.includes("session-") &&
        hooksNormalized.includes("memory"),
      output: hooksOutput,
    };
  } catch (error) {
    hooksDiscovery = {
      ok: false,
      output: error.message,
    };
  }

  const smokeAgents = await loadClaudeAgentIds();
  const agentResults = [];

  for (const agentId of smokeAgents) {
    try {
      const prompt =
        '请只输出一行 JSON，不要解释。字段为 {"agent": string, "owns": string, "artifact": string}。';
      const { stdout } = await execFileAsync(
        command.file,
        command.toArgs([
          "agent",
          "--local",
          "--agent",
          agentId,
          "--message",
          prompt,
          "--json",
          "--timeout",
          "120",
        ]),
        {
          cwd: repoRoot,
          timeout: 180_000,
          env,
        }
      );

      const payload = extractOpenClawReply(stdout);
      const injectionOk =
        payload.wrapper?.meta?.systemPromptReport?.injectedWorkspaceFiles?.every(
          (item) => item.missing === false
        ) ?? false;
      agentResults.push({
        agentId,
        ok: payload.agent === agentId,
        injectionOk,
        sample: payload,
      });
    } catch (error) {
      agentResults.push({
        agentId,
        ok: false,
        error: error.message,
      });
    }
  }

  return {
    ok:
      validation.stdout.toLowerCase().includes("config valid") &&
      hooksDiscovery.ok &&
      agentResults.every((result) => result.ok && result.injectionOk),
    configOk: validation.stdout.toLowerCase().includes("config valid"),
    hooksOk: hooksDiscovery.ok,
    hooksDiscovery: hooksDiscovery.output,
    validation: validation.stdout.trim(),
    agentResults,
  };
}

async function main() {
  const agentIds = await loadClaudeAgentIds();
  const report = {
    timestamp: new Date().toISOString(),
    claude: null,
    codex: null,
    openclaw: null,
  };

  try {
    const discovery = await runClaudeDiscovery(agentIds);
    const results = await runClaudeCases(agentIds);
    report.claude = {
      ok: discovery.ok && results.every((result) => result.ok),
      discovery,
      results,
    };
  } catch (error) {
    report.claude = {
      ok: false,
      error: error.message,
    };
  }

  try {
    report.codex = await runCodexSmoke();
  } catch (error) {
    report.codex = {
      ok: false,
      error: error.message,
    };
  }

  try {
    report.openclaw = await runOpenClawSmoke();
  } catch (error) {
    report.openclaw = {
      ok: false,
      error: error.message,
    };
  }

  const overallOk =
    report.claude?.ok === true &&
    report.codex?.ok === true &&
    report.openclaw?.ok === true;

  console.log(JSON.stringify(report, null, 2));
  if (!overallOk) {
    process.exitCode = 1;
  }
}

await main();
