#!/usr/bin/env node
/**
 * Stop hook: consolidate session outcomes and save to MCP Memory Service.
 *
 * Reads the session transcript (stdin provides transcript_path),
 * extracts a concise summary (topics, decisions, code changes),
 * then POSTs to the MCP Memory HTTP API.
 *
 * Always exits 0 — never blocks session stop.
 * Silent no-op if: service unreachable, transcript too short, or no config.
 */

import { readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Read stdin ──────────────────────────────────────────
const STDIN_CHUNKS = [];
for await (const chunk of process.stdin) STDIN_CHUNKS.push(chunk);
const RAW_STDIN = Buffer.concat(STDIN_CHUNKS).toString("utf8").trim();
let INPUT = {};
try {
  INPUT = JSON.parse(RAW_STDIN || "{}");
} catch {
  INPUT = {};
}

// ── Config ──────────────────────────────────────────────
function endpointFromMemoryPort() {
  const port = String(process.env.META_KIM_MEMORY_PORT || "").trim();
  return /^\d{1,5}$/u.test(port) ? `http://localhost:${port}` : null;
}

const DEFAULT_ENDPOINT = "http://localhost:8000";
const TIMEOUT_MS = 4000;
const HEALTH_TIMEOUT_MS = 500;
const REMOTE_MEMORY_ALLOWED = process.env.META_KIM_ALLOW_REMOTE_MEMORY === "1";
const MEMORY_AUTOSTART_DISABLED = process.env.META_KIM_DISABLE_MEMORY_AUTOSTART === "1";
const SECRET_PATTERNS = [
  /\bsk-(?:proj|live|test)?-[A-Za-z0-9_-]{10,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\b(?:authorization\s*:\s*bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu,
  /\b(?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*["']?[^"'\s,;]{6,}/giu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
];

async function loadConfig() {
  const claudeHome = resolve(
    process.env.META_KIM_CLAUDE_HOME?.trim() ||
    process.env.CLAUDE_HOME?.trim() ||
    join(homedir(), ".claude"),
  );
  const candidates = [
    join(claudeHome, "hooks", "config.json"),
    join(claudeHome, "hooks", "memory-hooks", "config.json"),
    join(__dirname, "..", "memory-hooks", "config.json"),
  ];
  for (const p of candidates) {
    try {
      const raw = await readFile(p, "utf8");
      return JSON.parse(raw);
    } catch {
      /* next */
    }
  }
  return {};
}

function getEndpoint(cfg) {
  return process.env.MCP_MEMORY_URL || endpointFromMemoryPort() ||
    cfg?.memoryService?.http?.endpoint || DEFAULT_ENDPOINT;
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const [first, second] = parts;
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

function isAllowedMemoryEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    if (["localhost", "127.0.0.1", "::1"].includes(hostname)) return true;
    if (isPrivateIpv4(hostname)) return true;
    if (hostname.startsWith("fc") || hostname.startsWith("fd")) return true;
    if (hostname.startsWith("fe80:")) return true;
    return REMOTE_MEMORY_ALLOWED;
  } catch {
    return false;
  }
}

function isLoopbackMemoryEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    return ["localhost", "127.0.0.1", "::1"].includes(hostname);
  } catch {
    return false;
  }
}

function getJson(endpoint, apiPath, timeoutMs = HEALTH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!isAllowedMemoryEndpoint(endpoint)) {
      resolve({ ok: false, body: {} });
      return;
    }
    let url;
    try {
      url = new URL(apiPath, endpoint);
    } catch {
      resolve({ ok: false, body: {} });
      return;
    }
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { Accept: "application/json" },
        timeout: timeoutMs,
      },
      (res) => {
        let response = "";
        res.on("data", (chunk) => {
          response += chunk;
        });
        res.on("end", () => {
          try {
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              body: JSON.parse(response || "{}"),
            });
          } catch {
            resolve({ ok: false, body: {} });
          }
        });
      },
    );
    req.on("error", () => resolve({ ok: false, body: {} }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, body: {} });
    });
    req.end();
  });
}

async function isMemoryServiceHealthy(endpoint) {
  const result = await getJson(endpoint, "/api/health");
  return result.ok && result.body?.status === "healthy";
}

function startMemoryServiceBackground(endpoint) {
  if (MEMORY_AUTOSTART_DISABLED || !isLoopbackMemoryEndpoint(endpoint)) return false;
  const memoryBin = process.env.MCP_MEMORY_BIN || "memory";
  try {
    const child = spawn(memoryBin, ["server", "--http"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        MCP_ALLOW_ANONYMOUS_ACCESS: "true",
        HF_HUB_OFFLINE: "1",
        TRANSFORMERS_OFFLINE: "1",
      },
    });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function ensureMemoryService(endpoint) {
  if (await isMemoryServiceHealthy(endpoint)) return true;
  const started = startMemoryServiceBackground(endpoint);
  if (!started) return false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (await isMemoryServiceHealthy(endpoint)) return true;
  }
  return false;
}

function redactSecrets(text) {
  let redacted = String(text ?? "");
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      const label = /authorization/iu.test(match) ? "AUTHORIZATION" : "SECRET";
      return `[REDACTED_${label}]`;
    });
  }
  return redacted;
}

function redactValue(value) {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item)]),
    );
  }
  return value;
}

// ── Transcript reader ───────────────────────────────────
async function readTranscript(transcriptPath, maxLines = 400) {
  if (!transcriptPath) return "";
  try {
    const raw = await readFile(transcriptPath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const slice = lines.length > maxLines ? lines.slice(-maxLines) : lines;
    return slice.join("\n");
  } catch {
    return "";
  }
}

// ── Extract assistant text from JSONL transcript ────────
function extractText(jsonl) {
  const texts = [];
  for (const line of jsonl.split("\n")) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
        for (const block of obj.message.content) {
          if (block.type === "text" && block.text) texts.push(block.text);
        }
      }
      if (obj.type === "user" && Array.isArray(obj.message?.content)) {
        for (const block of obj.message.content) {
          if (block.type === "text" && block.text) texts.push(block.text);
        }
      }
    } catch {
      /* skip */
    }
  }
  return texts.join("\n");
}

// ── Lightweight topic / decision extraction ─────────────
const TOPIC_PATTERNS = [
  [/(?:implement|build|create|add|develop)\w*\s+[\w.-]+/gi, "implementation"],
  [/(?:fix|debug|resolv|repair)\w*\s+[\w.-]+/gi, "bugfix"],
  [/(?:refactor|restructur|rewrit|clean)\w*/gi, "refactor"],
  [/(?:test|spec|coverage|assert)\w*/gi, "testing"],
  [/(?:deploy|releas|publish|ship)\w*/gi, "deployment"],
  [/(?:config|setup|environ|setting)\w*/gi, "configuration"],
  [/(?:design|architect|pattern|structure)\w*/gi, "architecture"],
  [/(?:perform|optim|speed|memory|fast)\w*/gi, "performance"],
];

const DECISION_PATTERNS = [
  /(?:decided|chose|opted|agreed|will use|going with|settled on)[^.!\n]{10,80}/gi,
];

function analyze(text) {
  const topics = [];
  const seen = new Set();
  for (const [pat, label] of TOPIC_PATTERNS) {
    const m = text.match(pat);
    if (m?.length > 0 && !seen.has(label)) {
      topics.push(label);
      seen.add(label);
    }
  }

  const decisions = [];
  for (const pat of DECISION_PATTERNS) {
    const m = text.match(pat);
    if (m) decisions.push(...m.slice(0, 2));
  }

  return { topics, decisions };
}

// ── Build memory content ────────────────────────────────
function buildContent(text, analysis, cwd) {
  const now = new Date().toISOString().slice(0, 10);
  const project = cwd?.split(/[/\\]/).pop() || "unknown";
  const parts = [`Session ${now} — ${project}`];

  if (analysis.topics.length) {
    parts.push(`Topics: ${analysis.topics.join(", ")}`);
  }
  if (analysis.decisions.length) {
    parts.push(`Decisions: ${analysis.decisions.join("; ")}`);
  }

  // Extract up to 3 significant user messages for context
  const userLines = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (
      trimmed.length > 20 &&
      trimmed.length < 200 &&
      !trimmed.startsWith("{")
    ) {
      userLines.push(trimmed);
    }
    if (userLines.length >= 3) break;
  }
  if (userLines.length) {
    parts.push("Key points: " + userLines.join(" | "));
  }

  const content = redactSecrets(parts.join("\n"));
  if (content.length > 800) return content.slice(0, 797) + "...";
  return content;
}

// ── HTTP POST helper ────────────────────────────────────
function postMemory(endpoint, payload) {
  return new Promise((resolve) => {
    if (!isAllowedMemoryEndpoint(endpoint)) {
      resolve({ success: false });
      return;
    }
    const data = JSON.stringify(redactValue(payload));
    let url;
    try {
      url = new URL("/api/memories", endpoint);
    } catch {
      resolve({ success: false });
      return;
    }
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 8000),
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve({ success: false });
          }
        });
      },
    );
    req.on("error", () => resolve({ success: false }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ success: false });
    });
    req.write(data);
    req.end();
  });
}

// ── Main ────────────────────────────────────────────────
async function main() {
  const cfg = await loadConfig();
  const endpoint = getEndpoint(cfg);
  const serviceReady = await ensureMemoryService(endpoint);
  if (!serviceReady) {
    process.stderr.write(
      `[meta-kim] MCP Memory Service not healthy at ${endpoint}; session memory was not saved. Tried background start with memory server --http for local endpoints.\n`,
    );
    return;
  }

  const transcriptPath = INPUT.transcript_path || INPUT.transcriptPath;
  const cwd = INPUT.cwd || process.cwd();

  const rawJsonl = await readTranscript(transcriptPath);
  if (rawJsonl.length < 200) return;

  const text = extractText(rawJsonl);
  if (text.length < 100) return;

  const analysis = analyze(text);
  const content = buildContent(text, analysis, cwd);
  if (content.length < 30) return;

  const tags = [
    "claude-code",
    "session-summary",
    cwd?.split(/[/\\]/).pop() || "unknown",
    ...analysis.topics.slice(0, 3),
  ].filter(Boolean);

  const result = await postMemory(endpoint, {
    content,
    tags,
    memory_type: "observation",
    metadata: {
      generated_by: "meta-kim-stop-memory-save",
      project_dir: cwd,
      topics: analysis.topics,
      decisions_count: analysis.decisions.length,
    },
  });
  if (result?.success) {
    process.stderr.write(
      `[meta-kim] Session memory saved (${content.length} chars, ${tags.length} tags)\n`,
    );
  }
}

main().catch(() => {});
