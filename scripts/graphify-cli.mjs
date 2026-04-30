#!/usr/bin/env node

import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  detectPython310,
  extractPipShowVersion,
  formatPythonLauncher,
  readProcessText,
  runPythonModule,
} from "./graphify-runtime.mjs";

const command = process.argv[2] || "check";

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function ensurePython({ requirePip = false } = {}) {
  const python = detectPython310(spawnSync, process.platform, {
    requirePip,
    bootstrapPip: requirePip,
  });
  if (!python) {
    fail(requirePip ? "Python 3.10+ with pip not found" : "Python 3.10+ not found");
    return null;
  }
  return python;
}

function runCheck() {
  const python = ensurePython({ requirePip: true });
  if (!python) {
    return;
  }

  console.log(python.versionText);

  const pipShow = runPythonModule(python, ["-m", "pip", "show", "graphifyy"]);
  if (pipShow.status !== 0) {
    fail("graphify not installed");
    return;
  }

  const version = extractPipShowVersion(readProcessText(pipShow)) ?? "unknown";
  console.log(`graphify ${version}`);
}

function installGraphify({ upgrade = false } = {}) {
  const python = ensurePython({ requirePip: true });
  if (!python) {
    return;
  }

  console.log(`Using ${formatPythonLauncher(python)} (${python.versionText})`);

  const pipArgs = ["-m", "pip", "install"];
  if (upgrade) {
    pipArgs.push("--upgrade");
  }
  pipArgs.push("graphifyy");

  const pipResult = runPythonModule(python, pipArgs, undefined, {
    stdio: "inherit",
  });
  if (pipResult.status !== 0) {
    process.exitCode = pipResult.status || 1;
    return;
  }

  const installResult = runPythonModule(
    python,
    ["-m", "graphify", "claude", "install"],
    undefined,
    { stdio: "inherit" },
  );
  if (installResult.status !== 0) {
    process.exitCode = installResult.status || 1;
    return;
  }

  const hookResult = runPythonModule(
    python,
    ["-m", "graphify", "hook", "install"],
    undefined,
    { stdio: "inherit" },
  );
  if (hookResult.status !== 0) {
    process.exitCode = hookResult.status || 1;
  }
}

switch (command) {
  case "check":
    runCheck();
    break;
  case "install":
    installGraphify({ upgrade: false });
    break;
  case "update":
    installGraphify({ upgrade: true });
    break;
  default:
    fail(`Unknown graphify command: ${command}`);
    break;
}
