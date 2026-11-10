#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  executeSafeManagedFileTransaction,
  inspectTrustedPath,
  sha256Buffer,
  sha256ManagedFile,
} from "./safe-managed-file-operations.mjs";
import {
  loadProjectCapabilityOwnershipPolicy,
  readProjectCapabilityOwnershipManifest,
} from "./project-capability-ownership.mjs";

const MANIFEST_REL = ".meta-kim/state/default/project-capabilities.json";
const MANIFEST_SCHEMA = "meta-kim-project-capabilities-v0.1";
const RUNTIMES = new Set(["claude", "codex", "cursor", "openclaw", "gemini", "zcode"]);
const TYPES = new Set(["agent", "skill", "command"]);
const MODES = new Set(["create", "iterate"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const result = { apply: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") result.apply = true;
    else if (arg === "--json") result.json = true;
    else if (["--project-dir", "--runtime", "--type", "--id", "--source", "--mode"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      result[arg.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return result;
}

function safeId(value) {
  const id = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,79}$/u.test(id) || id.includes("..")) {
    throw new Error("Capability id must be 2-80 lowercase letters, digits, dots, underscores, or hyphens.");
  }
  return id;
}

function assertProjectRoot(projectDir) {
  const callerCwd = resolve(process.env.META_KIM_CALLER_CWD || process.cwd());
  const root = isAbsolute(projectDir ?? "")
    ? resolve(projectDir)
    : resolve(callerCwd, projectDir ?? ".");
  if (!existsSync(root) || lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) {
    throw new Error("Project directory must be an existing real directory.");
  }
  const markers = [".git", "AGENTS.md", "CLAUDE.md", "package.json", ".meta-kim"];
  if (!markers.some((marker) => existsSync(join(root, marker)))) {
    throw new Error("Project directory needs a project marker (.git, AGENTS.md, CLAUDE.md, package.json, or .meta-kim).");
  }
  return root;
}

function targetBase(runtime, type, id) {
  const targets = {
    gemini: { agent: `.gemini/agents/${id}.md`, skill: `.agents/skills/${id}`, command: `.gemini/commands/${id}.toml` },
    zcode: { agent: `.zcode/agents/${id}.md`, skill: `.zcode/skills/${id}`, command: `.zcode/commands/${id}.md` },
    claude: {
      agent: `.claude/agents/${id}.md`,
      skill: `.claude/skills/${id}`,
      command: `.claude/commands/${id}.md`,
    },
    codex: {
      agent: `.codex/agents/${id}.toml`,
      skill: `.agents/skills/${id}`,
      command: `.codex/commands/${id}.md`,
    },
    cursor: {
      agent: `.cursor/agents/${id}.md`,
      skill: `.cursor/skills/${id}`,
      command: `.cursor/rules/${id}.mdc`,
    },
    openclaw: {
      agent: `openclaw/workspaces/${id}/AGENTS.md`,
      skill: `openclaw/skills/${id}`,
      command: `openclaw/skills/${id}/SKILL.md`,
    },
  };
  return targets[runtime][type];
}

function walkSource(sourcePath, relativePrefix = "") {
  const source = resolve(sourcePath);
  const stats = lstatSync(source);
  if (stats.isSymbolicLink()) throw new Error(`Source links are not allowed: ${sourcePath}`);
  if (stats.isFile()) {
    return [{ source, relativePath: relativePrefix || basename(source) }];
  }
  if (!stats.isDirectory()) throw new Error(`Source must be a regular file or directory: ${sourcePath}`);
  const files = [];
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error(`Source links are not allowed: ${join(source, entry.name)}`);
    const childRel = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...walkSource(join(source, entry.name), childRel));
    else if (entry.isFile()) files.push({ source: join(source, entry.name), relativePath: childRel });
    else throw new Error(`Unsupported source entry: ${join(source, entry.name)}`);
  }
  if (files.length === 0) throw new Error("Capability source directory is empty.");
  return files;
}

function sourceRef(sourcePath) {
  const absolute = resolve(sourcePath);
  const home = resolve(homedir());
  const homeRel = relative(home, absolute);
  if (homeRel && !homeRel.startsWith("..") && !isAbsolute(homeRel)) {
    return `~/${homeRel.replaceAll("\\", "/")}`;
  }
  return `external:${basename(absolute)}#sha256:${sha256(realpathSync(absolute)).slice(0, 12)}`;
}

function readManifest(projectRoot) {
  const policy = loadProjectCapabilityOwnershipPolicy(resolve(import.meta.dirname, ".."));
  const parsed = readProjectCapabilityOwnershipManifest(projectRoot, policy);
  if (!parsed) {
    return {
      schemaVersion: MANIFEST_SCHEMA,
      ownershipScope: "project_runtime_sedimentation",
      dependencyUpdatePolicy: "preserve_project_copies",
      capabilities: [],
    };
  }
  if (parsed?.schemaVersion !== MANIFEST_SCHEMA || !Array.isArray(parsed.capabilities)) {
    throw new Error("Project capability ownership manifest is invalid; preserve it and repair before retrying.");
  }
  return parsed;
}

function capabilitySourceRoot(sourcePath, type) {
  const resolved = resolveSource(sourcePath);
  const stats = lstatSync(resolved);
  if (type === "skill" && stats.isFile() && basename(resolved).toLowerCase() === "skill.md") {
    return dirname(resolved);
  }
  return resolved;
}

function mappedSourceFiles(sourcePath, runtime, type, id) {
  const resolvedSource = capabilitySourceRoot(sourcePath, type);
  const sourceStats = lstatSync(resolvedSource);
  const base = targetBase(runtime, type, id);
  const sourceFiles = walkSource(resolvedSource);
  if (sourceStats.isFile()) {
    const relPath = type === "skill" ? `${base}/SKILL.md` : base;
    return [{ ...sourceFiles[0], relPath }];
  }
  if (type !== "skill") {
    throw new Error(`${type} source must be a single regular file.`);
  }
  return sourceFiles.map((file) => ({ ...file, relPath: `${base}/${file.relativePath}` }));
}

function resolveSource(sourcePath) {
  const callerCwd = resolve(process.env.META_KIM_CALLER_CWD || process.cwd());
  return isAbsolute(sourcePath) ? resolve(sourcePath) : resolve(callerCwd, sourcePath);
}

export function copyProjectCapability(options) {
  const projectRoot = assertProjectRoot(options.projectDir);
  const runtime = String(options.runtime ?? "").toLowerCase();
  const type = String(options.type ?? "").toLowerCase();
  const mode = String(options.mode ?? "iterate").toLowerCase();
  const id = safeId(options.id);
  if (!RUNTIMES.has(runtime)) throw new Error(`Unsupported runtime: ${runtime || "missing"}`);
  if (!TYPES.has(type)) throw new Error(`Unsupported capability type: ${type || "missing"}`);
  if (!MODES.has(mode)) throw new Error(`Unsupported copy mode: ${mode || "missing"}`);
  if (!options.source || !existsSync(resolveSource(options.source))) throw new Error("Capability source does not exist.");
  if (runtime === "gemini" && type === "command" && !String(options.source).endsWith(".toml")) {
    throw new Error("Gemini custom commands require a native TOML source; Markdown commands cannot be relabeled.");
  }

  const manifest = readManifest(projectRoot);
  const capabilityKey = `${runtime}:${type}:${id}`;
  const previous = manifest.capabilities.find((entry) => entry.capabilityKey === capabilityKey) ?? null;
  const resolvedSource = capabilitySourceRoot(options.source, type);
  const files = mappedSourceFiles(resolvedSource, runtime, type, id);
  const plannedFiles = [];
  const operations = [];
  for (const file of files) {
    const info = inspectTrustedPath(projectRoot, file.relPath, { allowMissing: true });
    if (!info) throw new Error(`Unsafe project target: ${file.relPath}`);
    const content = readFileSync(file.source);
    const sourceHash = sha256Buffer(content);
    const existingHash = sha256ManagedFile(info.target);
    const priorFile = previous?.files?.find((entry) => entry.relPath === file.relPath) ?? null;
    if (existingHash && existingHash !== sourceHash) {
      if (!priorFile) throw new Error(`Unmanaged project capability conflict: ${file.relPath}`);
      plannedFiles.push({
        relPath: file.relPath,
        baselineHash: priorFile.baselineHash,
        projectHashAtLastRecord: existingHash,
        state: "preserved_project_copy",
      });
      continue;
    }
    operations.push({
      kind: "write",
      relPath: file.relPath,
      content,
      expectedOldHash: existingHash || null,
      authorizedAdoptIdentical: Boolean(existingHash),
      phase: "content",
    });
    plannedFiles.push({
      relPath: file.relPath,
      baselineHash: sourceHash,
      projectHashAtLastRecord: existingHash || sourceHash,
      state: existingHash ? "adopted_identical" : "copied_to_project",
    });
  }

  const now = new Date().toISOString();
  const capability = {
    capabilityKey,
    runtime,
    type,
    id,
    mode,
    policy: mode === "iterate" ? "copy_to_project_for_modification" : "create_project_local_capability",
    ownershipClass: "runtime_sedimented_project_copy",
    ownership: "project",
    detachedFromDependencyUpdates: true,
    dependencyUpdatePolicy: "preserve_project_copy",
    sourceRef: sourceRef(resolvedSource),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    files: plannedFiles,
  };
  const nextManifest = {
    ...manifest,
    updatedAt: now,
    capabilities: [
      ...manifest.capabilities.filter((entry) => entry.capabilityKey !== capabilityKey),
      capability,
    ].sort((a, b) => a.capabilityKey.localeCompare(b.capabilityKey)),
  };
  const manifestPath = join(projectRoot, ...MANIFEST_REL.split("/"));
  const manifestHash = sha256ManagedFile(manifestPath);
  operations.push({
    kind: "write",
    relPath: MANIFEST_REL,
    content: `${JSON.stringify(nextManifest, null, 2)}\n`,
    expectedOldHash: manifestHash,
    phase: "manifest",
  });

  const plan = {
    schemaVersion: "meta-kim-project-capability-copy-result-v0.1",
    ok: true,
    status: options.apply ? "pending" : "planned",
    mode: options.apply ? "apply" : "dry_run",
    projectRoot,
    capability,
    manifest: MANIFEST_REL,
  };
  if (!options.apply) return plan;
  const result = executeSafeManagedFileTransaction({
    trustedRoot: projectRoot,
    backupRoot: join(projectRoot, ".meta-kim", "backups", "project-capabilities"),
    operations,
    transactionLabel: `project-capability-${runtime}-${type}-${id}`,
    lockKey: "project-mutation-session",
  });
  return {
    ...plan,
    ok: result.ok,
    status: result.status,
    transaction: result,
  };
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = copyProjectCapability(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
