#!/usr/bin/env node
/** Read-only, no-model native plugin inventory probe (not a session reload proof). */
import { spawnSync } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseClaudePluginInventory } from "./claude-plugin-migration.mjs";

export function normalizeZCodePluginInventory(raw) {
  const data = JSON.parse(raw);
  const rows = Array.isArray(data) ? data : data?.plugins;
  if (!Array.isArray(rows)) throw new Error("ZCode plugins list --json returned an unknown schema");
  return rows.map((row) => {
    if (!row || typeof row !== "object" || typeof (row.id ?? row.name) !== "string") {
      throw new Error("ZCode plugin inventory includes an invalid item");
    }
    return {
      id: row.id ?? row.name,
      version: typeof row.version === "string" ? row.version : "unknown",
      enabled: row.enabled === true,
      errors: Array.isArray(row.errors) ? row.errors : [],
    };
  });
}

export function inspectExpectedPlugin(rows, expected) {
  const found = rows.find((row) => row.id === expected);
  return {
    present: Boolean(found),
    enabled: found?.enabled === true,
    version: found?.version ?? null,
    loadErrors: found?.errors?.length ?? 0,
    inventoryPass: Boolean(found?.enabled && !found?.errors?.length),
  };
}

function runCli(command, args) {
  const options = { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 };
  if (process.platform === "win32") {
    // No user-controlled arguments are passed to a shell; fixed command words only.
    return spawnSync(`${command} ${args.join(" ")}`, { ...options, shell: true });
  }
  return spawnSync(command, args, options);
}

export function probePluginClient(runtime, expected, run = runCli) {
  if (!["claude", "zcode"].includes(runtime)) throw new Error("--runtime must be claude or zcode");
  const command = runtime === "claude" ? "claude" : "zcode";
  const version = run(command, runtime === "claude" ? ["--version"] : ["version"]);
  const inventoryArgs = runtime === "claude" ? ["plugin", "list", "--json"] : ["plugins", "list", "--json"];
  const observed = run(command, inventoryArgs);
  const base = {
    runtime,
    clientVersion: version.status === 0 ? (version.stdout || version.stderr).trim().slice(0, 160) : null,
    inventoryObserved: false,
    expectedPlugin: expected ?? null,
    inventoryPass: false,
    sessionReloadVerified: false,
    liveInvocationVerified: false,
  };
  if (observed.status !== 0) {
    return {
      ...base,
      reason: "Native plugin CLI unavailable or failed; verify using the client's Plugins settings and a fresh session",
    };
  }
  try {
    const rows = runtime === "claude"
      ? parseClaudePluginInventory(observed.stdout)
      : normalizeZCodePluginInventory(observed.stdout);
    return {
      ...base,
      inventoryObserved: true,
      inventoryPass: expected ? inspectExpectedPlugin(rows, expected).inventoryPass : true,
      ...(expected ? { plugin: inspectExpectedPlugin(rows, expected) } : { installedPluginCount: rows.length }),
      reason: "Native CLI inventory only; reload and invoke the plugin inside the actual client before claiming live acceptance",
    };
  } catch (error) {
    return { ...base, reason: error.message };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const runtime = args[args.indexOf("--runtime") + 1];
  const expectedIndex = args.indexOf("--expected");
  const expected = expectedIndex === -1 ? null : args[expectedIndex + 1];
  try {
    if (expected !== null && !/^[a-z0-9._-]+(?:@[a-z0-9._-]+)?$/u.test(expected ?? "")) {
      throw new Error("--expected must be a plugin name or name@marketplace");
    }
    const outcome = probePluginClient(runtime, expected);
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    process.exitCode = outcome.inventoryPass ? 0 : outcome.inventoryObserved ? 1 : 2;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
