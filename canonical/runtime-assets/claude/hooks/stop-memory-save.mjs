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
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

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
const DEFAULT_ENDPOINT = process.env.MCP_MEMORY_URL || "http://localhost:8000";
const TIMEOUT_MS = 4000;

async function loadConfig() {
  const candidates = [
    join(__dirname, "..", "memory-hooks", "config.json"),
    join(
      process.env.HOME || process.env.USERPROFILE || "~",
      ".claude",
      "hooks",
      "config.json",
    ),
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
  return cfg?.memoryService?.http?.endpoint || DEFAULT_ENDPOINT;
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

  const content = parts.join("\n");
  if (content.length > 800) return content.slice(0, 797) + "...";
  return content;
}

// ── HTTP POST helper ────────────────────────────────────
function postMemory(endpoint, payload) {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const url = new URL("/api/memories", endpoint);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 8000,
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

  await postMemory(endpoint, {
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
}

main().catch(() => {});
