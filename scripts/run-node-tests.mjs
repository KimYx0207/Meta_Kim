#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import process from "node:process";

function expandPattern(pattern) {
  const normalized = String(pattern)
    .replace(/^["']|["']$/g, "")
    .replace(/\\/g, "/");
  const starIndex = normalized.indexOf("*");
  if (starIndex === -1) {
    return [normalized];
  }

  const slashIndex = normalized.lastIndexOf("/", starIndex);
  const dir = slashIndex === -1 ? "." : normalized.slice(0, slashIndex);
  const filePattern = normalized.slice(slashIndex + 1);
  const regex = new RegExp(
    `^${filePattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );

  return readdirSync(dir)
    .filter((entry) => regex.test(entry))
    .sort()
    .map((entry) => `${dir}/${entry}`);
}

const patterns = process.argv.slice(2);
const files = patterns.flatMap(expandPattern);

if (files.length === 0) {
  console.error("No test files matched.");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (result.stdout) {
  process.stdout.write(result.stdout);
}
if (result.stderr) {
  process.stderr.write(result.stderr);
}
if (result.status !== 0) {
  console.error(
    `node --test exited ${result.status ?? "unknown"} for ${files.length} file(s).`,
  );
}

process.exit(result.status ?? 1);
