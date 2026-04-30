#!/usr/bin/env node
/**
 * Cross-runtime lifecycle hook: load and save compact MCP Memory checkpoints.
 *
 * Claude Code has a richer transcript-aware Python hook. This shared hook is
 * intentionally generic for Codex, Cursor, and other runtimes that expose hook
 * JSON plus cwd. It supports:
 *   - session-start: save a start marker and inject relevant memory context
 *   - user-prompt: save the submitted prompt and inject relevant memory context
 *   - stop: save a compact session checkpoint
 *
 * Always exits 0. Memory persistence must never block the host runtime.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const TIMEOUT_MS = 4000;
const MAX_TEXT = 3000;
const MAX_MEMORY_CONTEXT = 1200;

function safeJsonParse(text, fallback = {}) {
  try {
    const parsed = JSON.parse(text || "");
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readStdin() {
  try {
    return readFileSync(0, "utf8").trim();
  } catch {
    return "";
  }
}

function cliArgValue(name) {
  const prefix = `${name}=`;
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === name && process.argv[index + 1]) return process.argv[index + 1];
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return "";
}

function readText(filePath, maxChars = MAX_TEXT) {
  if (!filePath || !existsSync(filePath)) return "";
  try {
    const text = readFileSync(filePath, "utf8");
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } catch {
    return "";
  }
}

function tailFile(filePath, maxLines = 80) {
  const text = readText(filePath, 12000);
  if (!text) return "";
  return text.split(/\r?\n/u).slice(-maxLines).join("\n").trim();
}

function detectRuntime(payload) {
  const explicit = process.env.META_KIM_RUNTIME || payload.runtime || payload.runtime_id;
  if (typeof explicit === "string" && explicit) return explicit.toLowerCase();

  const script = process.argv[1] || "";
  if (script.includes(`${path.sep}.codex${path.sep}`)) return "codex";
  if (script.includes(`${path.sep}.cursor${path.sep}`)) return "cursor";
  if (script.includes(`${path.sep}.openclaw${path.sep}`)) return "openclaw";
  return "unknown-runtime";
}

function detectEvent(payload) {
  const explicit =
    cliArgValue("--event") ||
    process.env.META_KIM_HOOK_EVENT ||
    payload.hook_event_name ||
    payload.event ||
    payload.type ||
    payload.action;
  const event = String(explicit || "").toLowerCase();
  if (event.includes("session") && event.includes("start")) return "session-start";
  if (event.includes("startup") || event.includes("resume")) return "session-start";
  if (event.includes("prompt") || event.includes("beforesubmitprompt")) {
    return "user-prompt";
  }
  if (event.includes("stop") || payload.stop_hook_active != null) return "stop";
  return event || "unknown";
}

function detectCwd(payload) {
  for (const key of ["cwd", "workspaceDir", "workspace_dir", "projectDir", "project_dir"]) {
    if (typeof payload[key] === "string" && payload[key]) return payload[key];
  }
  return process.cwd();
}

function endpointFromClaudeConfig() {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".claude", "hooks", "config.json"),
    path.join(home, ".claude", "hooks", "memory-hooks", "config.json"),
  ];
  for (const filePath of candidates) {
    const cfg = safeJsonParse(readText(filePath, 4000), null);
    const endpoint = cfg?.memoryService?.http?.endpoint;
    if (typeof endpoint === "string" && endpoint) return endpoint;
  }
  return null;
}

function getEndpoint() {
  return (
    process.env.MCP_MEMORY_URL ||
    endpointFromClaudeConfig() ||
    "http://localhost:8000"
  );
}

function projectName(cwd) {
  return path.basename(cwd || "") || "unknown-project";
}

function extractTranscriptText(jsonl) {
  const texts = [];
  for (const line of jsonl.split(/\r?\n/u)) {
    const obj = safeJsonParse(line, null);
    if (!obj) continue;
    const blocks = obj.message?.content;
    if ((obj.type === "assistant" || obj.type === "user") && Array.isArray(blocks)) {
      for (const block of blocks) {
        if (block?.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        }
      }
    }
    for (const key of ["content", "text", "message"]) {
      if (typeof obj[key] === "string") texts.push(obj[key]);
    }
  }
  return texts.join("\n").trim();
}

function textFromPayload(payload) {
  const parts = [];
  for (const key of [
    "prompt",
    "user_prompt",
    "userPrompt",
    "message",
    "content",
    "input",
    "summary",
  ]) {
    if (typeof payload[key] === "string" && payload[key].trim()) {
      parts.push(`${key}: ${payload[key].trim()}`);
    }
  }
  return parts.join("\n");
}

function promptFromPayload(payload) {
  for (const key of [
    "prompt",
    "user_prompt",
    "userPrompt",
    "message",
    "content",
    "input",
  ]) {
    if (typeof payload[key] === "string" && payload[key].trim()) {
      return payload[key].trim();
    }
  }
  return "";
}

function gitStatus(cwd) {
  const result = spawnSync("git", ["status", "--short"], {
    cwd,
    encoding: "utf8",
    timeout: 3000,
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout.trim()) return "";
  return result.stdout.trim().split(/\r?\n/u).slice(0, 30).join("\n");
}

function buildContent(payload, runtime, cwd, event) {
  const transcriptPath =
    payload.transcript_path ||
    payload.transcriptPath ||
    payload.conversation_path ||
    payload.session_path;
  const transcriptText = extractTranscriptText(readText(transcriptPath, 80000));
  const payloadText = textFromPayload(payload);
  const plan = tailFile(path.join(cwd, "task_plan.md"), 70);
  const progress = tailFile(path.join(cwd, "progress.md"), 70);
  const status = gitStatus(cwd);

  const project = projectName(cwd);
  const lines = [
    `Runtime ${event} checkpoint - ${runtime} - ${project}`,
    `Time: ${new Date().toISOString()}`,
    `Project dir: ${cwd}`,
  ];

  if (transcriptText) lines.push("\nTranscript excerpt:\n" + transcriptText);
  if (payloadText) lines.push("\nHook payload text:\n" + payloadText);
  if (plan) lines.push("\nTask plan tail:\n" + plan);
  if (progress) lines.push("\nProgress tail:\n" + progress);
  if (status) lines.push("\nGit status:\n" + status);

  const compactPayload = {
    event,
    raw_event: payload.hook_event_name || payload.event || payload.type,
    session_id: payload.session_id || payload.sessionId || payload.conversation_id,
    stop_hook_active: payload.stop_hook_active,
  };
  lines.push("\nHook metadata:\n" + JSON.stringify(compactPayload));

  const content = lines.join("\n").replace(/\n{4,}/gu, "\n\n\n").trim();
  return content.length > 4000 ? content.slice(0, 3997) + "..." : content;
}

function postJson(endpoint, apiPath, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const url = new URL(apiPath, endpoint);
    const transport = url.protocol === "https:" ? https : http;
    const agentId = String(body?.metadata?.runtime || body?.runtime || "meta-kim");
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          "X-Agent-ID": agentId,
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let response = "";
        res.on("data", (chunk) => {
          response += chunk;
        });
        res.on("end", () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            body: safeJsonParse(response, {}),
          });
        });
      },
    );
    req.on("error", () => resolve({ ok: false, body: {} }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, body: {} });
    });
    req.write(data);
    req.end();
  });
}

async function postMemory(endpoint, body) {
  const result = await postJson(endpoint, "/api/memories", body);
  return result.ok;
}

async function searchMemories(endpoint, query, project) {
  if (!query) return [];
  const result = await postJson(endpoint, "/api/search", {
    query,
    n_results: 8,
  });
  if (!result.ok) return [];

  const rawMemories = result.body.memories || result.body.results || [];
  const memories = [];
  for (const resultEntry of rawMemories) {
    const memory =
      resultEntry && typeof resultEntry === "object"
        ? resultEntry.memory || resultEntry
        : null;
    if (!memory || typeof memory !== "object") continue;
    const content = String(memory.content || "").trim();
    if (!content) continue;
    const tags = Array.isArray(memory.tags) ? memory.tags : [];
    const similarityScore =
      resultEntry && typeof resultEntry === "object"
        ? resultEntry.similarity_score || resultEntry.relevance_score
        : undefined;
    const projectHit = tags.includes(project) || content.includes(project);
    memories.push({
      ...memory,
      content,
      tags,
      similarity_score: similarityScore,
      projectHit,
    });
  }
  return memories
    .sort((left, right) => Number(right.projectHit) - Number(left.projectHit))
    .slice(0, 4);
}

function formatMemoryContext(memories, runtime, event) {
  if (!Array.isArray(memories) || memories.length === 0) return "";
  const lines = [
    `Meta_Kim memory context (${runtime}, ${event})`,
    "Use only if relevant to the current task.",
  ];
  for (const memory of memories) {
    const tags = Array.isArray(memory.tags) && memory.tags.length
      ? ` [${memory.tags.slice(0, 4).join(", ")}]`
      : "";
    let content = memory.content.replace(/\s+/gu, " ").trim();
    if (content.length > 260) content = `${content.slice(0, 257)}...`;
    lines.push(`- ${content}${tags}`);
  }
  const context = lines.join("\n");
  return context.length > MAX_MEMORY_CONTEXT
    ? `${context.slice(0, MAX_MEMORY_CONTEXT - 3)}...`
    : context;
}

function emitRuntimeContext(context) {
  const payload = {
    systemMessage: context,
    message: context,
    continue: true,
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main() {
  const raw = readStdin();
  const payload = safeJsonParse(raw, {});
  const runtime = detectRuntime(payload);
  const cwd = detectCwd(payload);
  const event = detectEvent(payload);
  const endpoint = getEndpoint();
  const project = projectName(cwd);

  const content = buildContent(payload, runtime, cwd, event);
  if (content.length >= 40) {
    await postMemory(endpoint, {
      content,
      tags: [runtime, event, "meta_kim", project].filter(Boolean),
      memory_type: "observation",
      conversation_id:
        payload.session_id ||
        payload.sessionId ||
        payload.conversation_id ||
        `${runtime}-${project}-${Date.now()}`,
      metadata: {
        generated_by: "meta-kim-cross-runtime-memory",
        runtime,
        event,
        project_dir: cwd,
        has_transcript:
          Boolean(payload.transcript_path) ||
          Boolean(payload.transcriptPath) ||
          Boolean(payload.conversation_path) ||
          Boolean(payload.session_path),
      },
    });
  }

  if (event === "stop") return;

  const query = promptFromPayload(payload) || project;
  const memories = await searchMemories(endpoint, query, project);
  const context = formatMemoryContext(memories, runtime, event);
  if (context) emitRuntimeContext(context);
}

main().catch(() => {});
