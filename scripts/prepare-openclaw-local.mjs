import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { canonicalAgentsDir } from "./meta-kim-sync-config.mjs";

const filesToMirror = ["auth.json", "auth-profiles.json", "models.json"];
const currentAuthStoreFile = "openclaw-agent.sqlite";
const minUsableFileBytes = 3;

async function ensureExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fileLooksUsable(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size >= minUsableFileBytes;
  } catch {
    return false;
  }
}

async function agentAuthDirLooksUsable(agentDir) {
  const checks = await Promise.all(
    filesToMirror.map((fileName) => fileLooksUsable(path.join(agentDir, fileName))),
  );
  return checks.every(Boolean);
}

async function currentAuthStoreLooksUsable(agentDir) {
  return fileLooksUsable(path.join(agentDir, currentAuthStoreFile));
}

async function loadAgentIds() {
  const files = (await fs.readdir(canonicalAgentsDir))
    .filter((file) => file.endsWith(".md"))
    .sort();

  return files.map((file) => file.replace(/\.md$/, ""));
}

async function copyFileIfChanged(sourcePath, targetPath) {
  const source = await fs.readFile(sourcePath);
  let current = null;

  try {
    current = await fs.readFile(targetPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  if (current && Buffer.compare(source, current) === 0) {
    return false;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, source);
  return true;
}

export async function prepareOpenClawLocal({
  homeDir = os.homedir(),
  agentIds = null,
  log = console.log,
} = {}) {
  const resolvedAgentIds = agentIds ?? await loadAgentIds();
  const openclawAgentsRoot = path.join(homeDir, ".openclaw", "agents");
  const sourceAgentDir = path.join(openclawAgentsRoot, "main", "agent");

  if (await currentAuthStoreLooksUsable(sourceAgentDir)) {
    log(
      `OpenClaw SQLite auth storage detected; ${resolvedAgentIds.length} meta agents keep runtime-managed auth inheritance without copying credential databases.`,
    );
    return {
      storageMode: "sqlite_runtime_managed",
      changedTargets: [],
    };
  }

  let effectiveSourceAgentDir = sourceAgentDir;
  let sourceMode = "main";

  if (!(await agentAuthDirLooksUsable(sourceAgentDir))) {
    const fallbackAgentId = (
      await Promise.all(
        resolvedAgentIds.map(async (agentId) => ({
          agentId,
          agentDir: path.join(openclawAgentsRoot, agentId, "agent"),
          usable: await agentAuthDirLooksUsable(
            path.join(openclawAgentsRoot, agentId, "agent"),
          ),
        })),
      )
    ).find((candidate) => candidate.usable);

    if (!fallbackAgentId) {
      throw new Error(`Missing source OpenClaw auth file: ${path.join(sourceAgentDir, "auth.json")}`);
    }

    effectiveSourceAgentDir = fallbackAgentId.agentDir;
    sourceMode = `fallback:${fallbackAgentId.agentId}`;
  }

  const changedTargets = [];

  for (const agentId of resolvedAgentIds) {
    const targetAgentDir = path.join(openclawAgentsRoot, agentId, "agent");
    await fs.mkdir(path.join(openclawAgentsRoot, agentId, "sessions"), {
      recursive: true,
    });

    for (const fileName of filesToMirror) {
      const sourcePath = path.join(effectiveSourceAgentDir, fileName);
      const targetPath = path.join(targetAgentDir, fileName);
      if (
        sourceMode !== "main" &&
        (await fileLooksUsable(targetPath))
      ) {
        continue;
      }
      const changed = await copyFileIfChanged(sourcePath, targetPath);
      if (changed) {
        changedTargets.push(path.relative(openclawAgentsRoot, targetPath));
      }
    }
  }

  if (changedTargets.length === 0) {
    log(`OpenClaw local agent auth is already hydrated for ${resolvedAgentIds.length} meta agents.`);
    return {
      storageMode: "legacy_file_mirror",
      changedTargets,
    };
  }

  log(
    sourceMode === "main"
      ? `Hydrated OpenClaw auth for ${resolvedAgentIds.length} meta agents from ~/.openclaw/agents/main/agent.`
      : `Hydrated missing OpenClaw auth files for ${resolvedAgentIds.length} meta agents from existing ${sourceMode} local agent auth.`,
  );
  for (const changed of changedTargets) {
    log(`- ${changed.replace(/\\/g, "/")}`);
  }
  return {
    storageMode: "legacy_file_mirror",
    changedTargets,
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    await prepareOpenClawLocal();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
