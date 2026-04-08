#!/usr/bin/env node
/**
 * CLI shim for npx / npm i -g: runs setup.mjs from the package root.
 *
 * Usage (no clone):
 *   npx --yes github:KimYx0207/Meta_Kim meta-kim
 *   npx --yes github:KimYx0207/Meta_Kim meta-kim -- --lang zh-CN --check
 */
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const setup = join(root, "setup.mjs");
const result = spawnSync(process.execPath, [setup, ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status === null ? 1 : result.status);
