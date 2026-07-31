import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const GRAPHIFY_NODE_ID_NORMALIZATION =
  "graphify-ascii-invariant-normalize-v1";

const PYTHON_BATCH_SCRIPT = String.raw`
import importlib.metadata
import hashlib
import json
from pathlib import Path
import sys
import unicodedata
from graphify import ids as graphify_ids

distribution = importlib.metadata.distribution("graphifyy")
distribution_root = Path(distribution.locate_file("")).resolve()
module_path = Path(graphify_ids.__file__).resolve()
if not module_path.is_relative_to(distribution_root):
    raise RuntimeError("graphify.ids was not loaded from the installed distribution")

values = json.load(sys.stdin)
result = {
    "graphifyVersion": importlib.metadata.version("graphifyy"),
    "moduleSha256": hashlib.sha256(module_path.read_bytes()).hexdigest(),
    "unicodeVersion": unicodedata.unidata_version,
    "normalized": [graphify_ids.normalize_id(value) for value in values],
}
json.dump(result, sys.stdout, ensure_ascii=False)
`;

function splitCommand(value) {
  return String(value ?? "")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

function resolveLauncherPath(command, environment) {
  if (!command) return null;
  if (path.isAbsolute(command) && existsSync(command)) return command;
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(locator, [command], {
    encoding: "utf8",
    shell: false,
    env: environment,
  });
  if (result.status !== 0 || result.error) return null;
  return String(result.stdout ?? "")
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .find((value) => value && existsSync(value)) ?? null;
}

function inferredPythonCandidate(launcherPath) {
  if (!launcherPath) return null;
  if (process.platform === "win32") {
    const scriptsDir = path.dirname(launcherPath);
    if (path.basename(scriptsDir).toLocaleLowerCase("en") !== "scripts") {
      return null;
    }
    const python = path.join(path.dirname(scriptsDir), "python.exe");
    return existsSync(python) ? { command: python, args: [] } : null;
  }
  try {
    const firstLine = readFileSync(launcherPath, "utf8").split(/\r?\n/u)[0];
    const match = firstLine.match(/^#!\s*(.+?python[0-9.]*)\s*$/u);
    return match && existsSync(match[1])
      ? { command: match[1], args: [] }
      : null;
  } catch {
    return null;
  }
}

function pythonCandidates({ launcherCommand, environment, pythonCandidate }) {
  const candidates = [];
  if (pythonCandidate?.command) candidates.push(pythonCandidate);
  const explicit = splitCommand(
    environment.META_KIM_GRAPHIFY_NORMALIZER_PYTHON ??
      environment.META_KIM_GRAPHIFY_PYTHON,
  );
  if (explicit.length > 0) {
    candidates.push({ command: explicit[0], args: explicit.slice(1) });
  }
  const launcherPath = resolveLauncherPath(launcherCommand, environment);
  const inferred = inferredPythonCandidate(launcherPath);
  if (inferred) candidates.push(inferred);
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.command}\0${candidate.args.join("\0")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function asciiNormalize(value) {
  const raw = String(value ?? "");
  if (/[^\x00-\x7f]/u.test(raw)) {
    throw new Error(
      "non-ASCII Graphify IDs require the actual Graphify Python normalizer",
    );
  }
  return raw
    .replace(/[^A-Za-z0-9_]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
}

export function normalizeGraphifyNodeId(value) {
  return asciiNormalize(value);
}

export function createGraphifyRuntimeNormalizer(
  values,
  {
    launcherCommand = "graphify",
    environment = process.env,
    forceAsciiInvariant = false,
    pythonCandidate = null,
  } = {},
) {
  const uniqueValues = [...new Set(values.map((value) => String(value ?? "")))];
  const candidates = forceAsciiInvariant
    ? []
    : pythonCandidates({ launcherCommand, environment, pythonCandidate });
  const isolatedCwd = mkdtempSync(
    path.join(tmpdir(), "meta-kim-graphify-normalizer-"),
  );
  try {
    const cwdStats = lstatSync(isolatedCwd);
    if (
      !cwdStats.isDirectory() ||
      cwdStats.isSymbolicLink() ||
      realpathSync.native(isolatedCwd) !== path.resolve(isolatedCwd)
    ) {
      throw new Error("Graphify normalizer cwd is not a plain isolated directory");
    }
    for (const candidate of candidates) {
      const result = spawnSync(
        candidate.command,
        [...candidate.args, "-c", PYTHON_BATCH_SCRIPT],
        {
          cwd: isolatedCwd,
          input: JSON.stringify(uniqueValues),
          encoding: "utf8",
          shell: false,
          env: {
            ...environment,
            PYTHONIOENCODING: "utf-8",
            PYTHONUTF8: "1",
          },
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      if (result.status !== 0 || result.error) continue;
      try {
        const parsed = JSON.parse(String(result.stdout ?? ""));
        if (
          !Array.isArray(parsed.normalized) ||
          parsed.normalized.length !== uniqueValues.length ||
          !/^\d+\.\d+\.\d+$/u.test(String(parsed.graphifyVersion ?? "")) ||
          !/^[0-9a-f]{64}$/u.test(String(parsed.moduleSha256 ?? "")) ||
          !/^\d+\.\d+\.\d+$/u.test(String(parsed.unicodeVersion ?? ""))
        ) {
          continue;
        }
        const normalizedByValue = new Map(
          uniqueValues.map((value, index) => [value, parsed.normalized[index]]),
        );
        const descriptor =
          `graphify-${parsed.graphifyVersion}-module-${parsed.moduleSha256.slice(0, 12)}-python-unicode-${parsed.unicodeVersion}-live-v2`;
        return {
          descriptor,
          normalize(value) {
            const key = String(value ?? "");
            if (!normalizedByValue.has(key)) {
              throw new Error("Graphify normalizer received an unbound value");
            }
            return normalizedByValue.get(key);
          },
        };
      } catch {
        // Try the next verified candidate.
      }
    }
  } finally {
    rmSync(isolatedCwd, { recursive: true, force: true });
  }

  if (uniqueValues.every((value) => /^[\x00-\x7f]*$/u.test(value))) {
    const normalizedByValue = new Map(
      uniqueValues.map((value) => [value, asciiNormalize(value)]),
    );
    return {
      descriptor: GRAPHIFY_NODE_ID_NORMALIZATION,
      normalize(value) {
        const key = String(value ?? "");
        if (!normalizedByValue.has(key)) {
          throw new Error("ASCII Graphify normalizer received an unbound value");
        }
        return normalizedByValue.get(key);
      },
    };
  }
  throw new Error(
    "Unable to bind non-ASCII node IDs to the actual Graphify Python runtime",
  );
}
