import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const homeKeys = ["CLAUDE", "CODEX", "CURSOR", "OPENCLAW"].flatMap(
  (runtime) => [`META_KIM_${runtime}_HOME`, `${runtime}_HOME`],
).concat("CLAUDE_CONFIG_DIR");

function runNode(args, cwd, env, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

function isolatedEnv(home) {
  return {
    ...process.env,
    ...Object.fromEntries(homeKeys.map((key) => [key, ""])),
    HOME: home,
    USERPROFILE: home,
    MCP_MEMORY_URL: "",
    META_KIM_MEMORY_PORT: "",
    META_KIM_DISABLE_MEMORY_AUTOSTART: "1",
    META_KIM_DISABLE_HOOK_DEDUPE: "1",
  };
}

for (const scenario of [
  { name: "legacy URL overrides a seeded endpoint", hook: "claude/hooks/stop-memory-save.mjs", endpoint: "url" },
  { name: "legacy port overrides a seeded endpoint", hook: "claude/hooks/stop-memory-save.mjs", endpoint: "port" },
  { name: "legacy hook uses CLAUDE_HOME configuration", hook: "claude/hooks/stop-memory-save.mjs", endpoint: "config" },
  { name: "shared hook uses CLAUDE_HOME configuration", hook: "shared/hooks/meta-kim-memory-save.mjs", endpoint: "config" },
  { name: "Claude lifecycle hook uses CLAUDE_HOME configuration", hook: "claude/hooks/meta-kim-memory-save.mjs", endpoint: "config" },
  { name: "shared hook gives META_KIM_CLAUDE_HOME priority", hook: "shared/hooks/meta-kim-memory-save.mjs", endpoint: "config", metaOverride: true },
  { name: "legacy hook uses official CLAUDE_CONFIG_DIR", hook: "claude/hooks/stop-memory-save.mjs", endpoint: "config", official: true },
  { name: "shared hook uses official CLAUDE_CONFIG_DIR", hook: "shared/hooks/meta-kim-memory-save.mjs", endpoint: "config", official: true },
  { name: "Claude lifecycle uses official CLAUDE_CONFIG_DIR", hook: "claude/hooks/meta-kim-memory-save.mjs", endpoint: "config", official: true },
]) {
  test(scenario.name, async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "meta-kim-memory-path-"));
    const home = path.join(fixture, "home");
    const configuredHome = path.join(home, "Runtime Vault", "Claude");
    const project = path.join(fixture, "project");
    const posts = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/api/health") res.end('{"status":"healthy"}');
        else if (req.method === "POST" && req.url === "/api/memories") {
          posts.push(JSON.parse(body));
          res.end('{"success":true}');
        } else res.end('{"memories":[]}');
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const endpoint = `http://127.0.0.1:${server.address().port}`;
      await mkdir(path.join(home, ".claude", "hooks"), { recursive: true });
      await mkdir(path.join(configuredHome, "hooks"), { recursive: true });
      await mkdir(path.join(project, ".git"), { recursive: true });
      const config = (url) => JSON.stringify({ memoryService: { http: { endpoint: url } } });
      const wrongEndpoint = "http://127.0.0.1:1";
      await writeFile(path.join(home, ".claude", "hooks", "config.json"), config(wrongEndpoint));
      await writeFile(path.join(configuredHome, "hooks", "config.json"), config(
        scenario.endpoint === "config" ? endpoint : wrongEndpoint,
      ));
      const transcript = path.join(project, "transcript.jsonl");
      await writeFile(transcript, `${JSON.stringify({
        type: "assistant", message: { content: [{ type: "text", text: Array(20).fill("Verified current project portability and explicit configuration.").join("\n") }] },
      })}\n`);
      const env = { ...isolatedEnv(home), CLAUDE_HOME: configuredHome };
      if (scenario.metaOverride) {
        env.CLAUDE_HOME = path.join(home, ".claude");
        env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
        env.META_KIM_CLAUDE_HOME = configuredHome;
      }
      if (scenario.official) {
        env.CLAUDE_HOME = path.join(home, ".claude");
        env.CLAUDE_CONFIG_DIR = configuredHome;
      }
      if (scenario.endpoint === "url") {
        env.MCP_MEMORY_URL = endpoint;
        env.META_KIM_MEMORY_PORT = "1";
      } else if (scenario.endpoint === "port") env.META_KIM_MEMORY_PORT = String(server.address().port);
      const hook = path.join(repoRoot, "canonical/runtime-assets", scenario.hook);
      const result = await runNode(
        [hook, ...(scenario.hook.endsWith("/meta-kim-memory-save.mjs") ? ["--event", "stop"] : [])],
        project, env, JSON.stringify({ cwd: project, transcript_path: transcript, session_id: "portability-fixture", runtime: "codex" }),
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(posts.length, 1, result.stderr || result.stdout);
      assert.match(posts[0].content, /portability/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(fixture, { recursive: true, force: true });
    }
  });
}

test("memory installer checks configured runtime homes without touching defaults", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "meta-kim-installer-home-"));
  const home = path.join(fixture, "home");
  const installer = path.join(repoRoot, "scripts/install-mcp-memory-hooks.mjs");
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end('{"status":"healthy"}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await mkdir(home, { recursive: true });
    for (const runtime of ["claude", "codex", "cursor", "openclaw"]) {
      const custom = path.join(home, "Runtime Vault", runtime);
      const defaultRoot = path.join(home, `.${runtime}`);
      await mkdir(custom, { recursive: true });
      await mkdir(defaultRoot, { recursive: true });
      const sentinel = path.join(defaultRoot, "preserve.txt");
      await writeFile(sentinel, "original user data");
      const env = {
        ...isolatedEnv(home),
        [`${runtime.toUpperCase()}_HOME`]: custom,
        MCP_MEMORY_URL: `http://127.0.0.1:${server.address().port}`,
      };
      const result = await runNode([installer, "--check", "--targets", runtime], repoRoot, env);
      assert.equal(result.status, 1, result.stderr);
      const output = `${result.stdout}${result.stderr}`.replaceAll("\\", "/");
      assert.ok(
        output.includes(custom.replaceAll("\\", "/")) || output.includes(path.relative(home, custom).replaceAll("\\", "/")),
        output,
      );
      assert.doesNotMatch(result.stderr, /Invalid MCP Memory managed-assets spec/);
      assert.equal(await readFile(sentinel, "utf8"), "original user data");
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(fixture, { recursive: true, force: true });
  }
});

test("memory installer rejects external homes before mutation or default fallback", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "meta-kim-external-home-"));
  try {
    const home = path.join(fixture, "home");
    const outside = path.join(fixture, "external-codex");
    await mkdir(home);
    await mkdir(outside);
    const env = { ...isolatedEnv(home), CODEX_HOME: outside };
    const sentinel = path.join(outside, "preserve.txt");
    await writeFile(sentinel, "external user data");
    const result = await runNode(
      [path.join(repoRoot, "scripts/install-mcp-memory-hooks.mjs"), "--targets", "codex"], repoRoot, env,
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /outside this memory installer's supported user-home boundary/);
    assert.equal(await readFile(sentinel, "utf8"), "external user data");
    await assert.rejects(readFile(path.join(home, ".codex", "hooks.json")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(home, ".meta-kim", "install-manifest.json")), { code: "ENOENT" });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("memory installer does not inspect an unselected external runtime", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "meta-kim-selected-home-"));
  try {
    const home = path.join(fixture, "home");
    await mkdir(home);
    const result = await runNode(
      [path.join(repoRoot, "scripts/install-mcp-memory-hooks.mjs"), "--remove", "--targets", "codex"],
      repoRoot, { ...isolatedEnv(home), CLAUDE_HOME: path.join(fixture, "external-claude") },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(result.stderr, /outside|unsafe runtime home/);
    await assert.rejects(readFile(path.join(fixture, "external-claude", "settings.json")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(home, ".claude", "settings.json")), { code: "ENOENT" });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
