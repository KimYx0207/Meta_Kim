import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const hookPath = path.join(
  repoRoot,
  "canonical",
  "runtime-assets",
  "shared",
  "hooks",
  "meta-kim-memory-save.mjs",
);

const MEMORY_SET_A = [
  {
    content:
      "MCP Memory Service 8000 recall bug: service health is fine; fix multi-query and recent project recall.",
    tags: ["codex", "user-prompt", "meta_kim"],
    metadata: {},
    id: "mem-a-1",
  },
];
const MEMORY_SET_B = [
  {
    content:
      "MCP Memory Service 8000 brand new decision: switch the recall dedup marker to a per-session sidecar.",
    tags: ["codex", "user-prompt", "meta_kim"],
    metadata: {},
    id: "mem-b-1",
  },
];

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function runHook(payload, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hookPath, "--event", "user-prompt"], {
      cwd: repoRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ status: -1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function recallStatePathFor(runtime, cwd, sessionId) {
  const hash = createHash("sha256")
    .update(JSON.stringify([runtime, cwd, sessionId]))
    .digest("hex")
    .slice(0, 16);
  return path.join(os.tmpdir(), `meta-kim-memory-recall-${hash}.json`);
}

describe("shared memory hook recall dedup", () => {
  test("identical recall for one session injects once but checkpoints every turn", async () => {
    let memorySet = MEMORY_SET_A;
    const savedCheckpoints = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/api/health") {
          res.end(JSON.stringify({ status: "healthy" }));
          return;
        }
        if (req.url === "/api/search") {
          res.end(JSON.stringify({ memories: memorySet }));
          return;
        }
        if (req.method === "GET" && req.url?.startsWith("/api/memories?")) {
          res.end(JSON.stringify({ memories: memorySet }));
          return;
        }
        if (req.method === "POST" && req.url === "/api/memories") {
          savedCheckpoints.push(JSON.parse(body || "{}"));
          res.end(JSON.stringify({ success: true }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    const port = await listen(server);

    const cwd = mkdtempSync(path.join(os.tmpdir(), "meta-kim-recall-dedup-"));
    const sessionId = `recall-dedup-${Date.now()}-${process.pid}`;
    const statePath = recallStatePathFor("codex", cwd, sessionId);
    rmSync(statePath, { force: true });
    const env = {
      ...process.env,
      MCP_MEMORY_URL: `http://127.0.0.1:${port}`,
      META_KIM_DISABLE_MEMORY_AUTOSTART: "1",
      META_KIM_DISABLE_HOOK_DEDUPE: "1",
    };
    const payloadFor = (prompt) => ({
      runtime: "codex",
      cwd,
      session_id: sessionId,
      hook_event_name: "user-prompt",
      prompt,
    });

    try {
      const first = await runHook(payloadFor("unrelated alpha turn"), env);
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /Untrusted recalled memory context/u);
      assert.match(first.stdout, /recall bug/u);
      assert.equal(savedCheckpoints.length, 1);

      const second = await runHook(payloadFor("unrelated alpha turn"), env);
      assert.equal(second.status, 0, second.stderr);
      assert.equal(
        second.stdout.trim(),
        "",
        "an identical recall must not burn tokens again in the same session",
      );
      assert.equal(
        savedCheckpoints.length,
        2,
        "the checkpoint save must still run on deduped turns",
      );

      const third = await runHook(payloadFor("unrelated beta turn"), env);
      assert.equal(third.status, 0, third.stderr);
      assert.equal(third.stdout.trim(), "", "same memory set for the same session stays deduped");

      memorySet = MEMORY_SET_B;
      const fourth = await runHook(payloadFor("unrelated gamma turn"), env);
      assert.equal(fourth.status, 0, fourth.stderr);
      assert.match(
        fourth.stdout,
        /brand new decision/u,
        "a materially different recall must inject again",
      );
    } finally {
      await closeServer(server);
      rmSync(statePath, { force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("without a session id the hook keeps the legacy emit-every-turn behavior", async () => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/api/health") {
          res.end(JSON.stringify({ status: "healthy" }));
          return;
        }
        if (req.url === "/api/search" || req.url?.startsWith("/api/memories?")) {
          res.end(JSON.stringify({ memories: MEMORY_SET_A }));
          return;
        }
        if (req.method === "POST" && req.url === "/api/memories") {
          res.end(JSON.stringify({ success: true }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    const port = await listen(server);

    const cwd = mkdtempSync(path.join(os.tmpdir(), "meta-kim-recall-nosession-"));
    const env = {
      ...process.env,
      MCP_MEMORY_URL: `http://127.0.0.1:${port}`,
      META_KIM_DISABLE_MEMORY_AUTOSTART: "1",
      META_KIM_DISABLE_HOOK_DEDUPE: "1",
    };
    const payloadFor = (prompt) => ({
      runtime: "codex",
      cwd,
      hook_event_name: "user-prompt",
      prompt,
    });

    try {
      const first = await runHook(payloadFor("unrelated alpha turn"), env);
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /Untrusted recalled memory context/u);

      const second = await runHook(payloadFor("unrelated alpha turn"), env);
      assert.equal(second.status, 0, second.stderr);
      assert.match(
        second.stdout,
        /Untrusted recalled memory context/u,
        "no session identity means no session dedup state",
      );
    } finally {
      await closeServer(server);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("concurrent identical recalls claim one per-session context", async () => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        const respond = () => {
          if (req.url === "/api/health") {
            res.end(JSON.stringify({ status: "healthy" }));
            return;
          }
          if (req.url === "/api/search" || req.url?.startsWith("/api/memories?")) {
            res.end(JSON.stringify({ memories: MEMORY_SET_A }));
            return;
          }
          if (req.method === "POST" && req.url === "/api/memories") {
            res.end(JSON.stringify({ success: true }));
            return;
          }
          res.writeHead(404);
          res.end();
        };
        setTimeout(respond, 20);
      });
    });
    const port = await listen(server);
    const cwd = mkdtempSync(path.join(os.tmpdir(), "meta-kim-recall-concurrent-"));
    const sessionId = `recall-concurrent-${Date.now()}-${process.pid}`;
    const statePath = recallStatePathFor("codex", cwd, sessionId);
    rmSync(statePath, { force: true });
    rmSync(`${statePath}.lock`, { recursive: true, force: true });
    const env = {
      ...process.env,
      MCP_MEMORY_URL: `http://127.0.0.1:${port}`,
      META_KIM_DISABLE_MEMORY_AUTOSTART: "1",
      // Exercise the recall sidecar even when the short-window hook marker is
      // intentionally disabled for this test.
      META_KIM_DISABLE_HOOK_DEDUPE: "1",
    };
    const payload = {
      runtime: "codex",
      cwd,
      session_id: sessionId,
      hook_event_name: "user-prompt",
      prompt: "same concurrent recall",
    };

    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => runHook(payload, env)),
      );
      assert.ok(results.every((result) => result.status === 0), results.map((result) => result.stderr).join("\n"));
      assert.equal(
        results.filter((result) => result.stdout.trim()).length,
        1,
        "parallel memory registrations must not repeat the same recalled context",
      );
    } finally {
      await closeServer(server);
      rmSync(statePath, { force: true });
      rmSync(`${statePath}.lock`, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
