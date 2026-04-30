import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

type OpenClawEvent = {
  type?: string;
  action?: string;
  context?: Record<string, unknown>;
  [key: string]: unknown;
};

function readText(filePath: string, maxChars = 3000): string {
  if (!filePath || !existsSync(filePath)) return "";
  try {
    const text = readFileSync(filePath, "utf8");
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } catch {
    return "";
  }
}

function tailFile(filePath: string, maxLines = 80): string {
  const text = readText(filePath, 12000);
  if (!text) return "";
  return text.split(/\r?\n/u).slice(-maxLines).join("\n").trim();
}

function endpoint(): string {
  return process.env.MCP_MEMORY_URL || "http://localhost:8000";
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function eventName(event: OpenClawEvent): string {
  return [asString(event.type), asString(event.action)].filter(Boolean).join(":");
}

function buildContent(event: OpenClawEvent): {
  content: string;
  project: string;
  workspaceDir: string;
} {
  const context = event.context ?? {};
  const workspaceDir =
    asString(context.workspaceDir) ||
    asString(context.workspace_dir) ||
    asString(context.cwd) ||
    process.cwd();
  const project = basename(workspaceDir || "") || "openclaw";
  const sessionEntry = context.sessionEntry ?? context.previousSessionEntry;

  const lines = [
    `Runtime session checkpoint - openclaw - ${project}`,
    `Time: ${new Date().toISOString()}`,
    `Workspace dir: ${workspaceDir}`,
    `Event: ${eventName(event)}`,
  ];

  const sessionSummary = compactJson(sessionEntry);
  if (sessionSummary) {
    lines.push("\nOpenClaw session entry:\n" + sessionSummary.slice(0, 1800));
  }

  const memory = tailFile(join(workspaceDir, "MEMORY.md"), 80);
  const today = new Date().toISOString().slice(0, 10);
  const daily = tailFile(join(workspaceDir, "memory", `${today}.md`), 80);
  const progress = tailFile(join(workspaceDir, "progress.md"), 70);
  const plan = tailFile(join(workspaceDir, "task_plan.md"), 70);

  if (memory) lines.push("\nMEMORY.md tail:\n" + memory);
  if (daily) lines.push("\nDaily memory tail:\n" + daily);
  if (plan) lines.push("\nTask plan tail:\n" + plan);
  if (progress) lines.push("\nProgress tail:\n" + progress);

  const content = lines.join("\n").trim();
  return {
    content: content.length > 4000 ? content.slice(0, 3997) + "..." : content,
    project,
    workspaceDir,
  };
}

async function saveMemory(event: OpenClawEvent): Promise<void> {
  const { content, project, workspaceDir } = buildContent(event);
  if (content.length < 40) return;

  await fetch(new URL("/api/memories", endpoint()), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-ID": "openclaw" },
    body: JSON.stringify({
      content,
      tags: ["openclaw", eventName(event), "meta_kim", project],
      memory_type: "observation",
      conversation_id: `openclaw-${project}-${Date.now()}`,
      metadata: {
        generated_by: "meta-kim-openclaw-mcp-memory-hook",
        runtime: "openclaw",
        event: eventName(event),
        project_dir: workspaceDir,
      },
    }),
  }).catch(() => undefined);
}

export default async function handler(event: OpenClawEvent): Promise<void> {
  await saveMemory(event);
}
