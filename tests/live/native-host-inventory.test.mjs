import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverNativeHostInventory } from "../../src/application/agent/native-host-inventory.mjs";
import { createAgentStartService } from "../../src/application/agent/agent-start-service.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meta-native-inventory-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  const globals = path.join(root, "native-homes");
  const external = path.join(root, "external");
  await Promise.all([projectRoot, globals, external].map((directory) => fs.mkdir(directory, { recursive: true })));
  const write = async (relativePath, content) => {
    const target = path.join(projectRoot, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  };
  const resolver = (hostId) => path.join(globals, hostId);
  return { root, projectRoot, globals, external, write, resolver };
}

const snapshot = {
  hosts: [
    { id: "claude", available: true, version: "Claude Code v2.1.319",
      launchSupported: true, reason: "read_only_plan_verified",
      statusLabel: "可用于只读研究", nextAction: "只读研究。" },
    { id: "codex", available: true, version: "codex-cli 0.9.0",
      launchSupported: false, reason: "personal_codex_token_not_authorized",
      statusLabel: "已检测，暂不开放启动", nextAction: "不使用个人 Codex Token。" },
    { id: "pi", available: false, launchSupported: false,
      reason: "client_not_installed", version: null },
  ],
};

test("native client inventory includes every reviewed host plus Pi, aliases DSH and distinguishes execution", async (t) => {
  const { projectRoot, resolver } = await fixture(t);
  const directory = await discoverNativeHostInventory({
    projectRoot, hostSnapshot: snapshot, runtimeHomeResolver: resolver,
    claudeMcpConfigResolver: () => path.join(projectRoot, ".claude.json"),
  });
  const byId = new Map(directory.nativeHosts.map((host) => [host.id, host]));
  assert.equal(directory.scanScope, "server_host");
  assert.ok(directory.nativeHosts.length >= 20);
  assert.ok(byId.has("claude") && byId.has("codex") && byId.has("dsh") && byId.has("pi"));
  assert.equal(byId.has("deepseek-harness"), false);
  assert.equal(byId.get("claude").status, "detected");
  assert.equal(byId.get("claude").launchSupported, true);
  assert.equal(byId.get("codex").status, "detected");
  assert.equal(byId.get("codex").launchSupported, false);
  assert.equal(byId.get("codex").blockedReason, "personal_codex_token_not_authorized");
  assert.equal(byId.get("pi").status, "not_found");
  assert.equal(byId.get("cursor").status, "not_probed");
  assert.equal(byId.get("workbuddy").connectionMode, "manual_skill_zip_import");
  assert.equal(byId.get("workbuddy").launchPolicy, "not_authorized");
  assert.ok(directory.nativeCapabilities.every((capability) =>
    capability.registrationState === "configured_only"
      && capability.loadState === "unknown" && capability.invocationState === "not_observed"));
});

test("native Agent/Subagent, Skills, MCP, Hooks, Plugins, Commands only reveal configuration names", async (t) => {
  const { projectRoot, write, resolver, globals } = await fixture(t);
  await write(".claude/agents/code-reviewer.md", "---\nname: code-reviewer\n---\nSECRET_TOKEN=not-public");
  await write(".claude/skills/plan-review/SKILL.md", "# Private contents sk-ant-secret");
  await write(".claude/commands/plan.md", "private prompt");
  await write(".claude/plugins/theme/plugin.json", JSON.stringify({ name: "theme", env: { API_KEY: "secret" } }));
  await write(".mcp.json", JSON.stringify({ mcpServers: { graphdb: {
    command: "secret-server", args: ["--api-key", "mcp-secret"], env: { TOKEN: "hide-me" },
  } } }));
  await write(".claude/settings.json", JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ command: "SECRET_COMMAND_PRIVATE" }] }] },
    apiKey: "sk-ant-never-return",
  }));
  await write(".codex/agents/architect.toml", "name='architect'\ndeveloper_instructions='PRIVATE'\n");
  await write(".codex/config.toml", `[agents.researcher]\nconfig_file = "../SECRET_PRIVATE.toml"\n[mcp_servers.postgres]\ncommand = "npx"\nargs = ["secret-token-value"]\n`);
  await write(".agents/skills/shared-plan/SKILL.md", "private");
  await write(".pi/agents/pi-research.md", "private");
  await write(".pi/skills/pi-skill/SKILL.md", "private");
  await write(".pi/extensions/flow.mjs", "const secret='do-not-leak'");
  await write(".pi/prompts/refactor.md", "private");
  await write(".pi/mcp.json", JSON.stringify({ mcpServers: { "pi-mcp": { env: { SECRET: "private-value" } } } }));
  const piHome = path.join(globals, "pi");
  await fs.mkdir(path.join(piHome, "skills", "pi-global-skill"), { recursive: true });
  await fs.writeFile(path.join(piHome, "skills", "pi-global-skill", "SKILL.md"), "global private");
  const agyHome = path.join(globals, "antigravity");
  await fs.mkdir(path.join(agyHome, "skills", "meta-theory"), { recursive: true });
  await fs.writeFile(path.join(agyHome, "skills", "meta-theory", "SKILL.md"), "agy skill private");
  await fs.mkdir(path.join(agyHome, "plugins", "chrome-devtools-plugin"), { recursive: true });
  await fs.writeFile(path.join(agyHome, "mcp_config.json"), JSON.stringify({ mcpServers: { "mcp-chrome": { env: { TOKEN: "hide-me" } } } }));
  const directory = await discoverNativeHostInventory({ projectRoot, hostSnapshot: snapshot,
    runtimeHomeResolver: resolver,
    claudeMcpConfigResolver: () => path.join(projectRoot, ".claude.json") });
  const kinds = (hostId) => directory.nativeCapabilities.filter((entry) => entry.hostId === hostId)
    .map(({ kind, label }) => `${kind}:${label}`);
  for (const expected of ["subagent_config:code-reviewer", "skill:plan-review", "command:plan",
    "plugin:theme", "mcp:graphdb", "hook:PreToolUse"]) assert.ok(kinds("claude").includes(expected), expected);
  assert.equal(kinds("claude").includes("plugin:plugin"), false,
    "a nested plugin manifest must not be a second generic plugin entry");
  for (const expected of ["subagent_config:architect", "subagent_config:researcher", "mcp:postgres",
    "skill:shared-plan"]) assert.ok(kinds("codex").includes(expected), expected);
  for (const expected of ["skill:meta-theory", "plugin:chrome-devtools-plugin", "mcp:mcp-chrome"]) {
    assert.ok(kinds("antigravity").includes(expected), expected);
  }
  assert.equal(kinds("antigravity").includes("skill:shared-plan"), false);
  for (const expected of ["subagent_config:pi-research", "skill:pi-skill", "skill:pi-global-skill",
    "plugin:flow.mjs", "command:refactor", "mcp:pi-mcp"]) assert.ok(kinds("pi").includes(expected), expected);
  const serialized = JSON.stringify(directory);
  for (const secret of ["SECRET_TOKEN", "not-public", "sk-ant-secret", "mcp-secret", "hide-me",
    "sk-ant-never-return", "SECRET_PRIVATE", "secret-token-value", "do-not-leak", "private-value",
    projectRoot, globals]) assert.equal(serialized.includes(secret), false, `leaked: ${secret}`);
});

test("a project-root Claude MCP declaration remains visible without a .claude folder", async (t) => {
  const { projectRoot, write, resolver } = await fixture(t);
  await write(".mcp.json", JSON.stringify({ mcpServers: { "project-index": {
    command: "NEVER_EXPOSE_THIS_COMMAND", env: { API_KEY: "NEVER_EXPOSE_THIS_SECRET" },
  } } }));
  const directory = await discoverNativeHostInventory({ projectRoot, hostSnapshot: snapshot,
    runtimeHomeResolver: resolver, claudeMcpConfigResolver: () => path.join(projectRoot, ".claude.json") });
  assert.ok(directory.nativeCapabilities.some(item => item.hostId === "claude" && item.kind === "mcp"
    && item.id === "project-index" && item.scope === "project"));
  const payload = JSON.stringify(directory);
  assert.equal(payload.includes("NEVER_EXPOSE_THIS_COMMAND"), false);
  assert.equal(payload.includes("NEVER_EXPOSE_THIS_SECRET"), false);
});

test("symlink escapes and oversized configs are rejected without reading private external content", async (t) => {
  const { projectRoot, external, write, resolver } = await fixture(t);
  await fs.writeFile(path.join(external, "SECRET_CONFIG.md"), "SECRET_PRIVATE_OUTSIDE");
  await fs.symlink(external, path.join(projectRoot, ".claude"), process.platform === "win32" ? "junction" : "dir");
  await write(".mcp.json", "x".repeat(130 * 1024));
  await write(".pi/mcp.json", JSON.stringify({ mcpServers: { safe: {}, "api-key-private": {}, token: {} } }));
  const directory = await discoverNativeHostInventory({ projectRoot, hostSnapshot: snapshot,
    runtimeHomeResolver: resolver,
    claudeMcpConfigResolver: () => path.join(external, "secret.json") });
  const capabilities = JSON.stringify(directory.nativeCapabilities);
  assert.equal(capabilities.includes("SECRET_CONFIG"), false);
  assert.equal(capabilities.includes("api-key-private"), false);
  assert.equal(capabilities.includes('"token"'), false);
  assert.ok(directory.nativeCapabilities.some((entry) => entry.hostId === "pi" && entry.id === "safe"));
  assert.ok(!directory.nativeCapabilities.some((entry) => entry.hostId === "claude" && entry.kind === "mcp"));
});

test("service native GET-style directory probes known CLIs and Pi but never launches or consumes Codex token", async (t) => {
  const { projectRoot } = await fixture(t);
  const probed = [];
  let launched = false;
  const service = createAgentStartService({ projectRoot,
    environment: { CODEX_TOKEN: "super-private-codex-token", PATH: "" },
    probe: (name) => { probed.push(name); return { status: "not_found", version: null }; },
    launch: () => { launched = true; throw new Error("Must not launch"); },
  });
  t.after(() => service.close());
  const directory = await service.getNativeDirectory();
  assert.equal(directory.scanScope, "server_host");
  assert.ok(directory.nativeHosts.some((entry) => entry.id === "pi" && entry.status === "not_found"));
  assert.deepEqual(new Set(probed), new Set(["claude", "gemini", "codex", "zcode", "dsh",
    "opencode", "openclaw", "pi"]));
  assert.equal(launched, false);
  assert.equal(JSON.stringify(directory).includes("super-private-codex-token"), false);
});

test("malformed CLI version output is never published as a credential-bearing label", async (t) => {
  const { projectRoot, resolver } = await fixture(t);
  const directory = await discoverNativeHostInventory({ projectRoot,
    hostSnapshot: { hosts: [{ id: "codex", available: true,
      version: "Codex token sk-proj-very-private", launchSupported: false,
      reason: "personal_codex_token_not_authorized" }] },
    runtimeHomeResolver: resolver });
  assert.equal(directory.nativeHosts.find((host) => host.id === "codex").version, null);
  assert.equal(JSON.stringify(directory).includes("sk-proj-very-private"), false);
});
