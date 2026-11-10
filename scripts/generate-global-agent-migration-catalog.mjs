#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  loadRuntimeProfiles,
  loadSyncManifest,
  resolveGlobalAgentProjectionTargets,
} from "./meta-kim-sync-config.mjs";
import {
  parseCanonicalAgent,
  renderGlobalAgentProjection,
} from "./sync-runtimes.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
export const GENERATOR_OUTPUT_CLASS = "canonical_source";
const catalogPath = path.join(
  repoRoot,
  "config",
  "migrations",
  "global-agent-projection-fingerprints.json",
);

function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeRepoPath(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/^\.\//u, "");
}

function isSimpleAgentProjectionPath(filePath, agentsDir, extension) {
  const normalizedPath = normalizeRepoPath(filePath);
  const normalizedDir = normalizeRepoPath(agentsDir).replace(/\/+$/u, "");
  if (!normalizedPath.startsWith(`${normalizedDir}/`)) return false;
  const relativePath = normalizedPath.slice(normalizedDir.length + 1);
  return !relativePath.includes("/") && relativePath.endsWith(extension);
}

function parseHistoricalBlobReferences(rawLog, trackedRoots) {
  const normalizedRoots = trackedRoots.map((root) =>
    normalizeRepoPath(root).replace(/\/+$/u, ""),
  );
  const references = [];
  const seen = new Set();
  for (const line of rawLog.split(/\r?\n/u)) {
    const match = line.match(
      /^:[0-7]{6} [0-7]{6} ([a-f0-9]{40,64}) ([a-f0-9]{40,64}) [A-Z][0-9]*\t(.+)$/u,
    );
    if (!match) continue;
    const filePath = normalizeRepoPath(match[3]);
    if (!normalizedRoots.some((root) =>
      filePath === root || filePath.startsWith(`${root}/`)
    )) {
      continue;
    }
    for (const objectId of [match[1], match[2]]) {
      if (/^0+$/u.test(objectId)) continue;
      const key = `${objectId}:${filePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      references.push({ objectId, filePath });
    }
  }
  return references;
}

function readHistoricalBlobs(references) {
  const objectIds = [...new Set(references.map(({ objectId }) => objectId))];
  if (objectIds.length === 0) return new Map();
  const output = execFileSync("git", ["cat-file", "--batch"], {
    cwd: repoRoot,
    input: `${objectIds.join("\n")}\n`,
    encoding: null,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const blobs = new Map();
  let offset = 0;
  for (const objectId of objectIds) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) {
      throw new Error(`Malformed git cat-file response for ${objectId}.`);
    }
    const header = output.subarray(offset, headerEnd).toString("utf8");
    const headerMatch = header.match(/^([a-f0-9]{40,64}) blob ([0-9]+)$/u);
    if (!headerMatch) {
      throw new Error(`Expected a Git blob for ${objectId}, received: ${header}`);
    }
    const size = Number.parseInt(headerMatch[2], 10);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (!Number.isSafeInteger(size) || contentEnd >= output.length) {
      throw new Error(`Malformed git cat-file blob size for ${objectId}.`);
    }
    blobs.set(objectId, output.subarray(contentStart, contentEnd).toString("utf8"));
    if (output[contentEnd] !== 0x0a) {
      throw new Error(`Malformed git cat-file blob terminator for ${objectId}.`);
    }
    offset = contentEnd + 1;
  }
  return blobs;
}

function addFingerprint(index, agentId, targetId, content) {
  const key = `${agentId}\0${targetId}`;
  if (!index.has(key)) {
    index.set(key, { agentId, targetId, fingerprints: new Set() });
  }
  index.get(key).fingerprints.add(sha256(content));
}

export async function buildGlobalAgentMigrationCatalog() {
  // This catalog authorizes recognition of historical managed projections.
  // A shallow log is incomplete even when the current projection is readable;
  // accepting it would silently drop old fingerprints on --write and let the
  // same truncated result pass --check.
  if (git(["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    throw new Error(
      "Global Agent migration catalog requires complete Git history. Run git fetch --unshallow before rebuilding or checking it; the existing catalog is preserved.",
    );
  }
  const manifest = await loadSyncManifest();
  const profiles = await loadRuntimeProfiles(manifest);
  const targetProjections = resolveGlobalAgentProjectionTargets(
    profiles,
    manifest.supportedTargets,
    { requireMigrationSupport: true },
  );
  const canonicalAgentsRoot = manifest.canonicalRoots.agents.replaceAll("\\", "/");
  const runtimeProjectionRoots = targetProjections.map((target) => {
    const agentsDir = profiles[target.targetId]?.projection?.outputPaths?.agentsDir;
    if (
      typeof agentsDir !== "string" ||
      !agentsDir.trim() ||
      path.isAbsolute(agentsDir) ||
      normalizeRepoPath(agentsDir).split("/").includes("..")
    ) {
      throw new Error(
        `Runtime profile ${target.targetId} must declare a safe project Agent output path for historical migration.`,
      );
    }
    return {
      ...target,
      repoAgentsDir: normalizeRepoPath(agentsDir),
    };
  });
  const trackedRoots = [
    canonicalAgentsRoot,
    ...runtimeProjectionRoots.map(({ repoAgentsDir }) => repoAgentsDir),
  ];
  const historyLog = git([
    "log",
    "--format=",
    "--raw",
    "--no-abbrev",
    "--no-renames",
    "--",
    ...trackedRoots,
  ]);
  const references = parseHistoricalBlobReferences(historyLog, trackedRoots);
  const blobs = readHistoricalBlobs(references);
  const fingerprintIndex = new Map();

  for (const { objectId, filePath } of references) {
    const raw = blobs.get(objectId);
    if (typeof raw !== "string") continue;
    if (
      filePath.startsWith(`${canonicalAgentsRoot}/`) &&
      /^[^/]+\.md$/u.test(filePath.slice(canonicalAgentsRoot.length + 1))
    ) {
      const fileAgentId = path.posix.basename(filePath, ".md");
      let agent;
      try {
        agent = parseCanonicalAgent(raw, filePath);
      } catch {
        continue;
      }
      if (agent.id !== fileAgentId) continue;
      for (const target of targetProjections) {
        addFingerprint(
          fingerprintIndex,
          agent.id,
          target.targetId,
          renderGlobalAgentProjection(agent, target),
        );
      }
    }

    for (const target of runtimeProjectionRoots) {
      if (!isSimpleAgentProjectionPath(
        filePath,
        target.repoAgentsDir,
        target.fileExtension,
      )) {
        continue;
      }
      const agentId = path.posix.basename(filePath, target.fileExtension);
      if (!/^[a-z0-9][a-z0-9-]*$/u.test(agentId)) continue;
      addFingerprint(fingerprintIndex, agentId, target.targetId, raw);
    }
  }

  for (const fileName of readdirSync(path.join(repoRoot, canonicalAgentsRoot)).sort()) {
    if (!fileName.endsWith(".md")) continue;
    const sourceFile = `${canonicalAgentsRoot}/${fileName}`;
    const raw = readFileSync(path.join(repoRoot, sourceFile), "utf8");
    const agent = parseCanonicalAgent(raw, sourceFile);
    if (agent.id !== path.posix.basename(fileName, ".md")) continue;
    for (const target of targetProjections) {
      addFingerprint(
        fingerprintIndex,
        agent.id,
        target.targetId,
        renderGlobalAgentProjection(agent, target),
      );
    }
  }

  const targetOrder = new Map(
    targetProjections.map((target, index) => [target.targetId, index]),
  );
  const projections = [...fingerprintIndex.values()]
    .sort((left, right) =>
      left.agentId.localeCompare(right.agentId) ||
      (targetOrder.get(left.targetId) ?? Number.MAX_SAFE_INTEGER) -
        (targetOrder.get(right.targetId) ?? Number.MAX_SAFE_INTEGER) ||
      left.targetId.localeCompare(right.targetId)
    )
    .map(({ agentId, targetId, fingerprints }) => ({
      agentId,
      targetId,
      fingerprints: [...fingerprints].sort(),
    }));

  if (projections.length === 0) {
    throw new Error("No historical canonical Agent projections were discovered from Git history.");
  }
  return {
    schemaVersion: 1,
    generator: "scripts/generate-global-agent-migration-catalog.mjs",
    projections,
  };
}

export function serializeGlobalAgentMigrationCatalog(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

async function main() {
  const flags = new Set(process.argv.slice(2));
  if ([...flags].some((flag) => !["--check", "--write"].includes(flag)) || flags.size > 1) {
    throw new Error("Usage: node scripts/generate-global-agent-migration-catalog.mjs [--check|--write]");
  }
  const expected = serializeGlobalAgentMigrationCatalog(
    await buildGlobalAgentMigrationCatalog(),
  );
  if (flags.has("--check")) {
    const actual = readFileSync(catalogPath, "utf8");
    if (actual !== expected) {
      throw new Error(
        "Global Agent migration catalog is stale; regenerate it with --write and review the exact fingerprints.",
      );
    }
    process.stdout.write(`Global Agent migration catalog is current: ${catalogPath}\n`);
    return;
  }
  if (flags.has("--write")) {
    mkdirSync(path.dirname(catalogPath), { recursive: true });
    writeFileSync(catalogPath, expected, "utf8");
    process.stdout.write(`Wrote ${catalogPath}\n`);
    return;
  }
  process.stdout.write(expected);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((error) => {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
