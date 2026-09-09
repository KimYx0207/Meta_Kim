#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  detectPython310,
  extractPipShowVersion,
  readProcessText,
  runPythonModule,
} from "./graphify-runtime.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_GRAPHIFY_VERSION = "0.9.56";
if (process.platform === "win32") {
  console.log("SKIP graphify managed Python tests: managed lifecycle requires macOS/Linux.");
  process.exit(0);
}
const TEST_FILES = Object.freeze([
  path.join(REPO_ROOT, "tests", "setup", "graphify-managed.test.py"),
  path.join(REPO_ROOT, "tests", "setup", "graphify-managed-producer.test.py"),
]);

function shellWords(value) {
  return String(value).trim().split(/\s+/u).filter(Boolean);
}

function probePython(candidate) {
  const version = spawnSync(candidate.command, [...candidate.args, "--version"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (version.status !== 0 || version.error) return null;
  const pip = runPythonModule(candidate, ["-m", "pip", "--version"]);
  if (pip.status !== 0 || pip.error) return null;
  return { ...candidate, versionText: readProcessText(version) };
}

const override = process.env.META_KIM_GRAPHIFY_PYTHON?.trim();
const overrideParts = override ? shellWords(override) : [];
const python = overrideParts.length > 0
  ? probePython({ command: overrideParts[0], args: overrideParts.slice(1) })
  : detectPython310(spawnSync, process.platform, {
      requirePip: true,
      bootstrapPip: false,
    });

if (!python) {
  console.log("SKIP graphify managed Python tests: Python 3.10+ with pip is unavailable.");
  process.exit(0);
}

const pipShow = runPythonModule(python, ["-m", "pip", "show", "graphifyy"]);
if (pipShow.status !== 0) {
  console.log("SKIP graphify managed Python tests: optional graphifyy 0.9.56 is unavailable.");
  process.exit(0);
}

const installedVersion = extractPipShowVersion(readProcessText(pipShow));
if (installedVersion !== REQUIRED_GRAPHIFY_VERSION) {
  console.log(
    `SKIP graphify managed Python tests: graphifyy ${installedVersion ?? "unknown"} is installed; ${REQUIRED_GRAPHIFY_VERSION} is required.`,
  );
  process.exit(0);
}

for (const testFile of TEST_FILES) {
  const result = runPythonModule(
    python,
    [testFile],
    undefined,
    { stdio: "inherit" },
  );
  if (result.status !== 0 || result.error) {
    process.exit(result.status ?? 1);
  }
}
