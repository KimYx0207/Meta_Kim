import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  legacyUserPluginsForMigration,
  parseClaudePluginInventory,
  requireInstalledClaudePlugin,
} from "../../scripts/claude-plugin-migration.mjs";

const SCRIPT = path.resolve(import.meta.dirname, "../../scripts/install-global-skills-all-runtimes.mjs");

test("Claude plugin inventory is authoritative and refuses malformed or unloaded results", () => {
  assert.throws(() => parseClaudePluginInventory("not-json"), /invalid JSON/);
  assert.throws(() => parseClaudePluginInventory('{"plugins":{}}'), /unsupported inventory schema/);
  const plugins = parseClaudePluginInventory(JSON.stringify([
    { id: "everything-claude-code@old", version: "1.0.0", scope: "user", enabled: true },
    { id: "everything-claude-code@old", version: "1.0.0", scope: "project", enabled: true },
    { id: "ecc@ecc", version: "1.2.0", scope: "user", enabled: true, errors: ["failed to load"] },
  ]));
  assert.deepEqual(legacyUserPluginsForMigration(plugins, "ecc@ecc", ["everything-claude-code"]).map((row) => row.scope), ["user"]);
  assert.throws(() => requireInstalledClaudePlugin(plugins, "ecc@ecc"), /load errors/);
});

function withMockClaude(fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-claude-native-migrate-"));
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true });
  const stateFile = path.join(root, "state.json");
  const logFile = path.join(root, "calls.jsonl");
  const registryPath = path.join(home, ".claude", "plugins", "installed_plugins.json");
  const oldRegistry = '{"user": "opaque Claude-owned registry; do not rewrite"}\n';
  writeFileSync(registryPath, oldRegistry);
  writeFileSync(stateFile, JSON.stringify([
    { id: "everything-claude-code@everything-claude-code", version: "1.0.0", scope: "user", enabled: true },
  ]));
  const cliPath = path.join(bin, "claude");
  writeFileSync(cliPath, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = process.env.MOCK_CLAUDE_STATE;
fs.appendFileSync(process.env.MOCK_CLAUDE_CALLS, JSON.stringify(args) + '\\n');
const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
if (args[0] === '--version') { console.log('2.1.300'); process.exit(0); }
if (args[0] !== 'plugin') process.exit(3);
if (args[1] === 'marketplace') {
  if (args[2] === 'list') console.log(JSON.stringify([{name:'ecc'}]));
  process.exit(0);
}
if (args[1] === 'list' && args[2] === '--json') {
  console.log(JSON.stringify(rows)); process.exit(0);
}
if (args[1] === 'install' || args[1] === 'update') {
  if (process.env.MOCK_CLAUDE_DROP_INSTALL !== '1') {
    const scope = args[args.indexOf('--scope') + 1] || 'user';
    const found = rows.find(row => row.id === args[2] && row.scope === scope);
    if (!found) rows.push({ id: args[2], version: '2.0.0', scope, enabled: true });
    else found.version = '2.0.0';
    fs.writeFileSync(file, JSON.stringify(rows));
  }
  process.exit(0);
}
if (args[1] === 'disable') {
  const scope = args[args.indexOf('--scope') + 1] || 'user';
  const found = rows.find(row => row.id === args[2] && row.scope === scope);
  if (!found) process.exit(1);
  found.enabled = false;
  fs.writeFileSync(file, JSON.stringify(rows)); process.exit(0);
}
if (args[1] === 'uninstall') {
  const scope = args[args.indexOf('--scope') + 1] || 'user';
  const after = rows.filter(row => row.id !== args[2] || row.scope !== scope);
  if (after.length === rows.length) process.exit(1);
  fs.writeFileSync(file, JSON.stringify(after)); process.exit(0);
}
process.exit(4);
`);
  chmodSync(cliPath, 0o755);
  try {
    return fn({ root, bin, home, stateFile, logFile, registryPath, oldRegistry });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("installer migrates old Claude plugin with native commands and preserves registry bytes", { skip: process.platform === "win32" }, () => {
  withMockClaude(({ bin, home, stateFile, logFile, registryPath, oldRegistry }) => {
    const result = spawnSync(process.execPath, [SCRIPT,
      "--plugins-only", "--skills", "ecc", "--targets", "claude", "--skip-inventory-refresh",
    ], { encoding: "utf8", env: {
      ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      MOCK_CLAUDE_STATE: stateFile, MOCK_CLAUDE_CALLS: logFile,
      META_KIM_SKIP_OPTIONAL_TOOLS: "1", FORCE_COLOR: "0", NO_COLOR: "1",
    } });
    assert.equal(result.status, 0, result.stderr);
    const rows = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.deepEqual(rows.map((row) => row.id), ["ecc@ecc"]);
    const calls = readFileSync(logFile, "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(calls.some((args) => args.join(" ") === "plugin install ecc@ecc --scope user"));
    assert.ok(calls.some((args) => args.join(" ") === "plugin uninstall everything-claude-code@everything-claude-code --scope user --keep-data"));
    assert.equal(readFileSync(registryPath, "utf8"), oldRegistry);
  });
});

test("installer fails when Claude acknowledges install but does not register plugin", { skip: process.platform === "win32" }, () => {
  withMockClaude(({ bin, home, stateFile, logFile, registryPath, oldRegistry }) => {
    const result = spawnSync(process.execPath, [SCRIPT,
      "--plugins-only", "--skills", "ecc", "--targets", "claude", "--skip-inventory-refresh",
    ], { encoding: "utf8", env: {
      ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HOME: home, USERPROFILE: home, MOCK_CLAUDE_DROP_INSTALL: "1",
      MOCK_CLAUDE_STATE: stateFile, MOCK_CLAUDE_CALLS: logFile,
      META_KIM_SKIP_OPTIONAL_TOOLS: "1", FORCE_COLOR: "0", NO_COLOR: "1",
    } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /did not register/);
    assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")).map((row) => row.id), ["everything-claude-code@everything-claude-code"]);
    assert.equal(readFileSync(registryPath, "utf8"), oldRegistry);
  });
});

test("installer keeps project-scoped plugins while replacing only the user's legacy plugin", { skip: process.platform === "win32" }, () => {
  withMockClaude(({ bin, home, stateFile, logFile, registryPath, oldRegistry }) => {
    const rows = JSON.parse(readFileSync(stateFile, "utf8"));
    rows.push({ id: "ecc@ecc", version: "1.9.0", scope: "project", enabled: true });
    writeFileSync(stateFile, JSON.stringify(rows));
    const result = spawnSync(process.execPath, [SCRIPT,
      "--plugins-only", "--skills", "ecc", "--targets", "claude", "--skip-inventory-refresh",
    ], { encoding: "utf8", env: {
      ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      MOCK_CLAUDE_STATE: stateFile, MOCK_CLAUDE_CALLS: logFile,
      META_KIM_SKIP_OPTIONAL_TOOLS: "1", FORCE_COLOR: "0", NO_COLOR: "1",
    } });
    assert.equal(result.status, 0, result.stderr);
    const installed = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.deepEqual(installed.filter((row) => row.id === "ecc@ecc").map((row) => row.scope).sort(), ["project", "user"]);
    assert.ok(!installed.some((row) => row.id.startsWith("everything-claude-code@")));
    const calls = readFileSync(logFile, "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(calls.some((args) => args.join(" ") === "plugin install ecc@ecc --scope user"));
    assert.equal(readFileSync(registryPath, "utf8"), oldRegistry);
  });
});
