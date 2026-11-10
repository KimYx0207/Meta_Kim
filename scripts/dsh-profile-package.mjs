#!/usr/bin/env node
/** Native DSH profile/Skill projection. The existing install manifest owns every write. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createEmpty, manifestPathFor, readManifest, record, removeByPath, validate,
  openRecorder,
} from "./install-manifest.mjs";
import {
  executeSafeManagedFileTransaction, inspectPlainAbsolutePath, inspectTrustedPath,
  normalizeManagedRelPath, sha256Buffer,
} from "./safe-managed-file-operations.mjs";
import {
  materializeGlobalProjectionPackage, recordGlobalProjectionPackage,
  verifyExecutingGlobalProjectionPackage,
} from "./global-projection-package-store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = "dsh-profile-package.mjs";
const PURPOSE = "dsh-native-core";
const SERVICE_PURPOSE = "dsh-native-service";
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const inside = (root, value) => { const rel = path.relative(root, value); return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel)); };
const portable = (value) => value.split(path.sep).join("/");
const READABLE_RESOURCE = /\.(?:md|mdx|jsonc?|ya?ml|toml|txt|csv|[cm]?js|jsx|tsx?|py|sh|bash|ps1|sql|html?|css|xml|svg)$/iu;
// The projected methods consult these repository-owned facts before choosing a
// capability or runtime. Keep their readable source available even with
// --no-mcp; neither a user's cwd nor an optional executable package is a
// fallback documentation root. Deliberately exclude local/runtime state and
// avoid copying the whole config tree, which may hold machine-specific files.
const METHOD_SOURCE_CONFIGS = Object.freeze([
  "canonical/runtime-assets/dsh/host-contract.json",
  "config/runtime-capability-matrix.json",
  "config/os-compatibility-matrix.json",
  "config/runtime-compatibility-catalog.json",
  "config/skills.json",
  "config/sync.json",
  "config/capability-index/agent-eligibility.json",
  "config/capability-index/dependency-project-registry.json",
  "config/capability-index/meta-kim-capabilities.json",
  "config/capability-index/provider-registry.json",
  "config/capability-index/weapon-registry.json",
  "config/governance/decision-pattern-catalog.json",
]);

function readPlain(file) {
  inspectPlainAbsolutePath(file, { kind: "file" });
  return fs.readFileSync(file);
}

function filesBelow(root) {
  inspectPlainAbsolutePath(root, { kind: "directory" });
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const file = path.join(dir, entry.name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`Links are not allowed in a DSH package: ${file}`);
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) files.push(file);
      else throw new Error(`Non-regular DSH package file: ${file}`);
    }
  };
  walk(root);
  return files;
}

function frontmatterField(text, field) {
  const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1];
  const value = header?.match(new RegExp(`^${field}:\\s*(.+)$`, "mu"))?.[1]?.trim();
  if (!value || /^[>|]$/u.test(value)) throw new Error(`Missing scalar canonical ${field}`);
  return value.replace(/^(["'])(.*)\1$/u, "$2");
}

function hostContract(sourceRoot) {
  const value = JSON.parse(readPlain(path.join(sourceRoot, "canonical/runtime-assets/dsh/host-contract.json")));
  if (value.schemaVersion !== 1 || value.runtime !== "deepseek-harness") throw new Error("Unsupported DSH host contract");
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(value.profileName) || ["web", "headless", "sdk", "sdk-minimal", "acp", "desktop"].includes(value.profileName)) throw new Error("DSH profile name must be an isolated custom profile");
  for (const key of ["skillBodyMaxCharacters", "resourcePartMaxCharacters"]) if (!Number.isInteger(value[key]) || value[key] < 256 || value[key] > 6000) throw new Error(`Invalid bounded DSH contract limit: ${key}`);
  if (!Array.isArray(value.bundles) || !value.bundles.length || value.bundles.some((bundle) => typeof bundle !== "string" || !bundle.startsWith("@deepseek-ai/dsh-"))) throw new Error("DSH profile must declare its reviewed native bundles");
  if (!/^[A-Za-z0-9_-]{1,32}$/u.test(value.mcpServerName)) throw new Error("Invalid DSH MCP server name");
  return value;
}

/** Lossless bounded views, alongside the original bytes. Links retain the original base. */
export function addDshResource(files, target, bytes, limit = 6000) {
  if (!Number.isInteger(limit) || limit < 2 || limit > 6000) throw new Error("Invalid DSH resource part character limit");
  files.set(target, Buffer.from(bytes));
  if (!READABLE_RESOURCE.test(target)) return;
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw new Error(`Readable method resource must be UTF-8: ${target}`);
  const parts = [];
  let rest = text;
  do {
    let end = Math.min(limit, rest.length);
    let lineLength = 0; let lines = 1;
    for (let index = 0; index < end; index += 1) {
      if (rest[index] === "\n") { lineLength = 0; if (lines++ >= 120) { end = index + 1; break; } }
      else if (++lineLength >= 1500) { end = index + 1; break; }
    }
    if (end < rest.length && /^[\uDC00-\uDFFF]$/u.test(rest[end])) end -= 1;
    if (rest[end - 1] === "\r" && rest[end] === "\n") end -= 1;
    const part = rest.slice(0, end);
    const name = `${String(parts.length + 1).padStart(4, "0")}.${target.endsWith(".md") ? "md" : "txt"}`;
    files.set(`${target}.dsh-parts/${name}`, Buffer.from(part));
    parts.push({ path: name, characters: part.length, sha256: sha256Buffer(Buffer.from(part)) });
    rest = rest.slice(end);
  } while (rest.length);
  const index = { schemaVersion: 1, original: `../${path.posix.basename(target)}`, sha256: sha256Buffer(bytes) };
  if (parts.length <= 20) index.parts = parts;
  else {
    index.pages = [];
    for (let offset = 0; offset < parts.length; offset += 20) {
      const name = `index-${String(index.pages.length + 1).padStart(4, "0")}.json`;
      const content = Buffer.from(json({ schemaVersion: 1, parts: parts.slice(offset, offset + 20) }));
      files.set(`${target}.dsh-parts/${name}`, content);
      index.pages.push({ path: name, sha256: sha256Buffer(content) });
    }
  }
  const indexBytes = Buffer.from(json(index));
  if (indexBytes.toString("utf8").length > 5000) throw new Error(`Readable method index needs a smaller resource: ${target}`);
  files.set(`${target}.dsh-parts/index.json`, indexBytes);
}

export function buildDshProjection({ sourceRoot = ROOT, executionRoot = null, scope = "global", servicePackage = null } = {}) {
  const contract = hostContract(sourceRoot);
  const files = new Map();
  const sourcePrefix = "skills/meta-theory/source";
  for (const sourceDir of ["canonical/skills/meta-theory", "canonical/agents", "config/contracts"]) {
    for (const sourceFile of filesBelow(path.join(sourceRoot, sourceDir))) {
      addDshResource(files, `${sourcePrefix}/${portable(path.relative(sourceRoot, sourceFile))}`, readPlain(sourceFile), contract.resourcePartMaxCharacters);
    }
  }
  for (const relative of METHOD_SOURCE_CONFIGS) {
    addDshResource(files, `${sourcePrefix}/${relative}`, readPlain(path.join(sourceRoot, relative)), contract.resourcePartMaxCharacters);
  }
  for (const license of ["LICENSE", "NOTICE"]) {
    if (fs.existsSync(path.join(sourceRoot, license))) files.set(`${sourcePrefix}/${license}`, readPlain(path.join(sourceRoot, license)));
  }
  const dispatcher = readPlain(path.join(sourceRoot, "canonical/runtime-assets/dsh/dispatcher.md")).toString("utf8");
  const roleBody = readPlain(path.join(sourceRoot, "canonical/runtime-assets/dsh/governance-role.md")).toString("utf8");
  const skill = (name, description, body, original) => {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(name)) throw new Error(`Invalid DSH skill name: ${name}`);
    if (body.length > contract.skillBodyMaxCharacters) throw new Error(`DSH entry exceeds its bounded body limit: ${name}`);
    files.set(`skills/${name}/SKILL.md`, Buffer.from(`---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${body.trim()}\n`));
    const source = path.posix.relative(`skills/${name}`, `${sourcePrefix}/${original}`);
    const index = JSON.parse(files.get(`${sourcePrefix}/${original}.dsh-parts/index.json`));
    files.set(`skills/${name}/method.json`, Buffer.from(json({
      schemaVersion: 1, kind: "canonical-method-loader", original: source,
      sourceSha256: index.sha256, partsIndex: `${source}.dsh-parts/index.json`,
    })));
  };
  skill("meta-theory", "Govern substantial work, architecture and module PRDs, evidence, dynamic delegation, review, verification and project evolution with Meta_Kim.", dispatcher, "canonical/skills/meta-theory/SKILL.md");
  const agentFiles = filesBelow(path.join(sourceRoot, "canonical/agents")).filter((file) => /^meta-[a-z-]+\.md$/u.test(path.basename(file)));
  if (agentFiles.length !== 9) throw new Error("DSH requires the existing nine canonical Meta governance owners");
  for (const agentFile of agentFiles) {
    const content = readPlain(agentFile).toString("utf8");
    skill(frontmatterField(content, "name"), frontmatterField(content, "description"), roleBody, portable(path.relative(sourceRoot, agentFile)));
  }
  const packageManifest = JSON.parse(readPlain(path.join(sourceRoot, "package.json")));
  const patch = executionRoot ? [{ insert: [{
    id: "meta-kim-mcp", name: contract.mcpPlugin,
    config: { serverName: contract.mcpServerName, transport: "stdio", command: process.execPath, args: [path.join(executionRoot, "scripts/mcp/meta-runtime-server.mjs")], failOnStartupError: true },
  }] }] : [];
  const configBase = scope === "global" ? `profiles/${contract.profileName}` : "meta-kim";
  files.set(`${configBase}/cordis.patch.yml`, Buffer.from(json(patch)));
  if (scope === "global") files.set(`${configBase}/package.json`, Buffer.from(json({
    name: "meta-kim-dsh-profile", private: true, type: "module",
    dsh: { profile: { bundles: contract.bundles } },
  })));
  const installationPath = "skills/meta-theory/installation.json";
  files.set(installationPath, Buffer.from(json({ schemaVersion: 1, version: packageManifest.version, executionRoot, nativeStageRunner: false, nativeHookEnforcement: false, upstream: contract,
    expectedPaths: [...files.keys(), installationPath].sort(),
  })));
  const purposes = new Map([...files.keys()].map((key) => [key, PURPOSE]));
  if (servicePackage) {
    const bundle = readDshServicePackage(servicePackage);
    for (const [key, value] of bundle.files) {
      if (files.has(key)) throw new Error(`Service package collides with Meta_Kim: ${key}`);
      files.set(key, value); purposes.set(key, SERVICE_PURPOSE);
    }
  }
  return { files, purposes, contract, version: packageManifest.version, skillCount: [...files.keys()].filter((file) => /^skills\/[^/]+\/SKILL\.md$/u.test(file)).length };
}

export function readDshServicePackage(root) {
  const absoluteRoot = path.resolve(root);
  const manifest = JSON.parse(readPlain(path.join(absoluteRoot, "dsh-package.json")));
  if (manifest.schemaVersion !== 1 || manifest.kind !== "kim-service-dsh-skills" || !Array.isArray(manifest.files)) throw new Error("Unsupported Kim_Service DSH package manifest");
  const files = new Map();
  for (const item of manifest.files) {
    const rel = normalizeManagedRelPath(item?.path);
    if (rel !== item?.path || !/^skills\/kim-[a-z0-9-]+\//u.test(rel) || files.has(rel)) throw new Error(`Unsafe or duplicate Service package path: ${item?.path}`);
    const info = inspectTrustedPath(absoluteRoot, rel, { allowMissing: false });
    if (!info) throw new Error(`Unsafe Service package file: ${rel}`);
    const bytes = readPlain(info.target);
    if (bytes.length !== item.size || sha256Buffer(bytes) !== item.sha256) throw new Error(`Service package integrity mismatch: ${rel}`);
    if (/^skills\/[^/]+\/SKILL\.md$/u.test(rel)) {
      const entry = bytes.toString("utf8");
      const name = frontmatterField(entry, "name");
      const body = entry.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, "");
      if (name !== rel.split("/")[1] || body.length > 6000) throw new Error(`Invalid or oversized native Service skill: ${rel}`);
    }
    files.set(rel, bytes);
  }
  const actual = filesBelow(absoluteRoot).map((file) => portable(path.relative(absoluteRoot, file))).filter((file) => file !== "dsh-package.json").sort();
  if (json(actual) !== json([...files.keys()].sort())) throw new Error("Service package has unlisted or missing files");
  if (!files.has("skills/kim-service/SKILL.md")) throw new Error("Service package is missing its native catalog skill");
  const inventory = files.get("skills/kim-service/projection.json");
  if (!inventory || json(JSON.parse(inventory).expectedPaths) !== json([...files.keys()].sort())) throw new Error("Service package content index does not match its file closure");
  return { manifest, files };
}

function commonRoot(left, right) {
  let root = path.resolve(left);
  while (!inside(root, right)) {
    const parent = path.dirname(root);
    if (parent === root) throw new Error("DSH home and install ledger must be on the same filesystem root");
    root = parent;
  }
  return root;
}

// The reviewed DSH filesystem provider scans the nearest ancestor with a .git
// marker (directory or worktree file), falling back to the launch directory.
// Do not install an apparently successful project package in an invisible child.
function nativeProjectRoot(projectRoot) {
  let current = projectRoot;
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return projectRoot;
    current = parent;
  }
}

function locations({ scope = "global", projectRoot, dshHome, homeRoot = os.homedir(), sourceRoot = ROOT } = {}) {
  if (!["global", "project"].includes(scope)) throw new Error("DSH scope must be global or project");
  const ledgerRoot = path.resolve(scope === "project" ? projectRoot ?? process.env.META_KIM_CALLER_CWD ?? process.cwd() : homeRoot);
  inspectPlainAbsolutePath(ledgerRoot, { kind: "directory" });
  const runtimeRoot = scope === "project" ? path.join(ledgerRoot, ".dsh") : path.resolve(dshHome ?? process.env.DSH_HOME ?? path.join(homeRoot, ".dsh"));
  const trustedRoot = commonRoot(ledgerRoot, runtimeRoot);
  inspectPlainAbsolutePath(trustedRoot, { kind: "directory" });
  if (!inspectTrustedPath(trustedRoot, portable(path.relative(trustedRoot, runtimeRoot)), { allowMissing: true })) throw new Error("DSH home has an unsafe path or link");
  const manifestPath = scope === "global" ? path.join(ledgerRoot, ".meta-kim/install-manifest.json") : manifestPathFor(scope, ledgerRoot);
  if (!inspectTrustedPath(trustedRoot, portable(path.relative(trustedRoot, manifestPath)), { allowMissing: true })) throw new Error("Install manifest has an unsafe path or link");
  return { scope, ledgerRoot, runtimeRoot, trustedRoot, manifestPath, profileName: hostContract(sourceRoot).profileName,
    hostProjectRoot: scope === "project" ? nativeProjectRoot(ledgerRoot) : null };
}

function ledgerAt(loc, version) {
  const current = readManifest(loc.manifestPath);
  if (!current && fs.existsSync(loc.manifestPath)) throw new Error("Existing install manifest is invalid; preserve it and repair ownership first");
  return current ?? createEmpty({ scope: loc.scope, repoRoot: loc.ledgerRoot, metaKimVersion: version });
}

function owned(entry, loc) {
  if (entry.source !== SOURCE || ![PURPOSE, SERVICE_PURPOSE].includes(entry.purpose) || entry.kind !== "file" || entry.runtimeTarget !== "deepseek-harness" || !inside(loc.runtimeRoot, entry.path)) return false;
  const rel = portable(path.relative(loc.runtimeRoot, entry.path));
  return entry.purpose === SERVICE_PURPOSE
    ? /^skills\/kim-[a-z0-9-]+\//u.test(rel)
    : /^skills\/meta-[a-z-]+\//u.test(rel) || [`profiles/${loc.profileName}/package.json`, `profiles/${loc.profileName}/cordis.patch.yml`, "meta-kim/cordis.patch.yml"].includes(rel);
}

function inspectedHash(file, loc) {
  const info = inspectTrustedPath(loc.trustedRoot, portable(path.relative(loc.trustedRoot, file)), { allowMissing: true });
  if (!info) throw new Error(`Unsafe installed file path or link: ${file}`);
  return fs.existsSync(file) ? sha256Buffer(readPlain(file)) : null;
}

function expectedProjectionIssues(loc, entries, indexRel, purpose, issues) {
  const indexPath = path.join(loc.runtimeRoot, indexRel);
  const owner = entries.find((entry) => entry.path === indexPath && entry.purpose === purpose);
  if (!owner) return [{ path: indexPath, reason: "missing_projection_index_ownership" }];
  if (issues.some((issue) => issue.path === indexPath)) return [];
  const inventory = JSON.parse(readPlain(indexPath));
  if (!Array.isArray(inventory.expectedPaths) || !inventory.expectedPaths.length || new Set(inventory.expectedPaths).size !== inventory.expectedPaths.length) return [{ path: indexPath, reason: "invalid_projection_index" }];
  const expected = new Set();
  const findings = [];
  for (const rel of inventory.expectedPaths) {
    if (normalizeManagedRelPath(rel) !== rel) { findings.push({ path: indexPath, reason: "invalid_projection_index" }); continue; }
    const file = path.join(loc.runtimeRoot, rel);
    if (!owned({ source: SOURCE, purpose, kind: "file", runtimeTarget: "deepseek-harness", path: file }, loc)) { findings.push({ path: indexPath, reason: "invalid_projection_index" }); continue; }
    expected.add(file);
    if (!entries.some((entry) => entry.path === file && entry.purpose === purpose)) findings.push({ path: file, reason: "missing_projection_file_ownership" });
  }
  for (const entry of entries.filter((entry) => entry.purpose === purpose)) if (!expected.has(entry.path)) findings.push({ path: entry.path, reason: "unlisted_projection_file_ownership" });
  return findings;
}

function installedSkillCount(loc) {
  return ledgerAt(loc).entries.filter((entry) => owned(entry, loc) && /^skills\/[^/]+\/SKILL\.md$/u.test(portable(path.relative(loc.runtimeRoot, entry.path))) && fs.existsSync(entry.path)).length;
}

function projectionPlan(loc, projection, { uninstall = false, replaceService = false } = {}) {
  let manifest = ledgerAt(loc, projection?.version);
  const previous = manifest.entries.filter((entry) => owned(entry, loc));
  const ownedByPath = new Map(previous.map((entry) => [entry.path, entry]));
  const desired = new Map([...projection?.files ?? []].map(([rel, content]) => [path.join(loc.runtimeRoot, rel), { rel, content }]));
  const operations = [];
  const conflicts = [];
  let changed = false;
  for (const [file, { rel, content }] of desired) {
    const owner = ownedByPath.get(file);
    const hash = inspectedHash(file, loc);
    const anotherOwner = manifest.entries.find((entry) => entry.path === file && entry !== owner);
    if (anotherOwner || (hash && !owner) || (hash && owner && hash !== owner.sha256)) {
      conflicts.push({ path: file, reason: owner ? "user_modified" : "unowned_existing" }); continue;
    }
    operations.push({ kind: "write", relPath: portable(path.relative(loc.trustedRoot, file)), content, expectedOldHash: owner?.sha256 ?? null, allowManagedMissingCreate: Boolean(owner) });
    const nextHash = sha256Buffer(content);
    if (!owner || nextHash !== owner.sha256 || !hash) {
      changed = true;
      manifest = record(manifest, { path: file, kind: "file", category: rel.startsWith("skills/") ? loc.scope === "global" ? "A" : "D" : loc.scope === "global" ? "C" : "G", source: SOURCE, purpose: projection.purposes.get(rel), size: content.length, sha256: nextHash, ownershipClass: "install_projection", runtimeTarget: "deepseek-harness" });
    }
  }
  for (const entry of previous) {
    if (desired.has(entry.path) || (!uninstall && entry.purpose === SERVICE_PURPOSE && !replaceService)) continue;
    const hash = inspectedHash(entry.path, loc);
    if (hash && hash !== entry.sha256) { conflicts.push({ path: entry.path, reason: "user_modified" }); continue; }
    operations.push({ kind: "remove", relPath: portable(path.relative(loc.trustedRoot, entry.path)), expectedOldHash: entry.sha256, allowManagedMissingRemove: true });
    manifest = removeByPath(manifest, entry.path, entry.purpose); changed = true;
  }
  if (changed) {
    manifest.updatedAt = new Date().toISOString();
    if (projection?.version) manifest.metaKimVersion = projection.version;
    const result = validate(manifest);
    if (!result.ok) throw new Error(`Invalid resulting installation ledger: ${result.errors.join("; ")}`);
    operations.push({ kind: "write", phase: "manifest", relPath: portable(path.relative(loc.trustedRoot, loc.manifestPath)), content: json(manifest), expectedOldHash: inspectedHash(loc.manifestPath, loc) });
  }
  return { operations, conflicts, previousCount: previous.length };
}

function applyPlan(loc, plan, options) {
  if (options.dryRun) return { ok: !plan.conflicts.length, status: "planned", writes: plan.operations.filter((item) => item.kind === "write").length, removals: plan.operations.filter((item) => item.kind === "remove").length, conflicts: plan.conflicts };
  if (plan.conflicts.length && !options.uninstall) return { ok: false, status: "blocked", conflicts: plan.conflicts, message: "Existing user files were preserved. Resolve the listed conflicts, then retry." };
  const result = executeSafeManagedFileTransaction({ trustedRoot: loc.trustedRoot, backupRoot: path.join(loc.ledgerRoot, ".meta-kim/backups/dsh"), operations: plan.operations, transactionLabel: "dsh-native", lockKey: "dsh-native", controlDirRel: portable(path.relative(loc.trustedRoot, path.join(loc.ledgerRoot, ".meta-kim/transactions"))) });
  return { ...result, ok: result.ok && !plan.conflicts.length, ...(result.ok && plan.conflicts.length ? { status: "partial" } : {}), conflicts: plan.conflicts };
}

export async function manageDsh(action, options = {}) {
  if (!["install", "update", "check", "uninstall"].includes(action)) throw new Error(`Unknown DSH action: ${action}`);
  const loc = locations(options);
  const projectRootMismatch = loc.scope === "project" && loc.hostProjectRoot !== loc.ledgerRoot;
  if (["install", "update"].includes(action) && projectRootMismatch) {
    throw new Error(`DSH discovers project Skills from ${loc.hostProjectRoot}, not the requested child directory ${loc.ledgerRoot}. Retry with --project-root ${JSON.stringify(loc.hostProjectRoot)}. No project files were changed.`);
  }
  if (action === "check") {
    const manifest = ledgerAt(loc);
    const entries = manifest.entries.filter((entry) => owned(entry, loc));
    const issues = entries.flatMap((entry) => {
      const hash = inspectedHash(entry.path, loc);
      return hash === entry.sha256 ? [] : [{ path: entry.path, reason: hash ? "user_modified" : "missing" }];
    });
    if (entries.length) {
      if (projectRootMismatch) issues.push({ path: loc.runtimeRoot, reason: "native_project_projection_root_mismatch", hostProjectRoot: loc.hostProjectRoot });
      issues.push(...expectedProjectionIssues(loc, entries, "skills/meta-theory/installation.json", PURPOSE, issues));
      const minimumCore = ["skills/meta-theory/SKILL.md", "skills/meta-theory/method.json", loc.scope === "global" ? `profiles/${loc.profileName}/cordis.patch.yml` : "meta-kim/cordis.patch.yml", ...(loc.scope === "global" ? [`profiles/${loc.profileName}/package.json`] : [])];
      for (const rel of minimumCore) if (!entries.some((entry) => entry.path === path.join(loc.runtimeRoot, rel) && entry.purpose === PURPOSE)) issues.push({ path: path.join(loc.runtimeRoot, rel), reason: "incomplete_core_projection" });
      if (entries.some((entry) => entry.purpose === SERVICE_PURPOSE)) issues.push(...expectedProjectionIssues(loc, entries, "skills/kim-service/projection.json", SERVICE_PURPOSE, issues));
    }
    const installation = path.join(loc.runtimeRoot, "skills/meta-theory/installation.json");
    let mcpConfigured = entries.length ? null : false;
    if (entries.some((entry) => entry.path === installation) && fs.existsSync(installation) && !issues.some((issue) => issue.path === installation)) {
      const data = JSON.parse(readPlain(installation));
      mcpConfigured = Boolean(data.executionRoot);
      if (data.executionRoot && !await verifyExecutingGlobalProjectionPackage({ packageRoot: data.executionRoot, homeRoot: options.homeRoot ?? os.homedir() })) issues.push({ path: data.executionRoot, reason: "immutable_package_verification_failed" });
    }
    const incomplete = issues.some((issue) => /projection|ownership/u.test(issue.reason));
    return { ok: entries.length > 0 && !issues.length, status: !entries.length ? "not_installed" : incomplete ? "incomplete" : issues.length ? "drift" : "verified_files", scope: loc.scope, runtimeRoot: loc.runtimeRoot,
      ...(loc.scope === "project" ? { hostProjectRoot: loc.hostProjectRoot, projectRootMatchesNativeDiscovery: !projectRootMismatch } : {}),
      fileCount: entries.length, skillCount: installedSkillCount(loc), mcpConfigured, issues, nativeModelExecutionVerified: false, nativeHookEnforcement: false, nativeStageRunner: false };
  }
  if (action === "uninstall") return applyPlan(loc, projectionPlan(loc, null, { uninstall: true }), { ...options, uninstall: true });
  const sourceRoot = path.resolve(options.sourceRoot ?? ROOT);
  let executionRoot = null;
  const preliminary = buildDshProjection({ sourceRoot, scope: loc.scope, servicePackage: options.servicePackage });
  const preflight = projectionPlan(loc, preliminary, { replaceService: Boolean(options.servicePackage) });
  if (preflight.conflicts.length || options.dryRun) return { ...applyPlan(loc, preflight, options), ...(options.dryRun ? { plannedSkillCount: preliminary.skillCount } : {}) };
  if (options.mcp !== false) {
    if (path.resolve(options.homeRoot ?? os.homedir()) !== path.resolve(os.homedir())) throw new Error("MCP installation must use the process HOME so the shared immutable-package ledger has one authority");
    const verified = await verifyExecutingGlobalProjectionPackage({ packageRoot: sourceRoot, homeRoot: options.homeRoot ?? os.homedir() }) ?? await materializeGlobalProjectionPackage({ sourceRoot, homeRoot: options.homeRoot ?? os.homedir() });
    executionRoot = verified.packageRoot;
    // The immutable package is shared with other Meta_Kim hosts and retains its existing authority.
    const recorder = openRecorder({ scope: "global", metaKimVersion: preliminary.version });
    await recordGlobalProjectionPackage(recorder, verified);
    const recorded = await recorder.flush();
    if (!recorded.ok) throw new Error(`Cannot record immutable executable package: ${recorded.error}`);
  }
  const projection = buildDshProjection({ sourceRoot: executionRoot ?? sourceRoot, executionRoot, scope: loc.scope, servicePackage: options.servicePackage });
  const result = applyPlan(loc, projectionPlan(loc, projection, { replaceService: Boolean(options.servicePackage) }), options);
  const patch = path.join(loc.runtimeRoot, loc.scope === "global" ? `profiles/${projection.contract.profileName}` : "meta-kim", "cordis.patch.yml");
  return { ...result, scope: loc.scope, runtimeRoot: loc.runtimeRoot, skillCount: installedSkillCount(loc), mcpConfigured: Boolean(executionRoot), nativeModelExecutionVerified: false,
    launch: loc.scope === "global" ? ["dsh", "--profile", projection.contract.profileName] : ["dsh", "--profile", "web", "--patch", patch],
    launchEnvironment: loc.scope === "global" ? { DSH_HOME: loc.runtimeRoot } : {},
    nodeRequirement: `DSH requires Node >=${projection.contract.minimumNodeVersion}; Meta_Kim's other hosts keep their own requirements.`,
  };
}

const HELP = `Meta_Kim native DSH integration
  meta-kim dsh install|update|check|uninstall [--scope global|project] [--project-root PATH]
      [--dsh-home PATH] [--service-package PATH] [--no-mcp] [--dry-run] [--json]

Global: an isolated 'meta-kim' DSH profile plus native Skills under DSH_HOME (default ~/.dsh).
Project: .dsh/skills plus a --patch overlay; the user's DSH_HOME and credentials stay active.
MCP uses Meta_Kim's verified immutable package store. --no-mcp installs Skills without an executable binding.
The existing install manifest owns all files. User edits/unowned files are preserved; check reports drift.
DSH 0.2.2-rc.1 requires Node >=24.9.0. Skills are not native custom-agent presets or Hook enforcement.
No command here calls a model or installs a model credential. Run the returned launch command yourself.
`;

export async function runDshCli(argv = process.argv.slice(2)) {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) { console.log(HELP); return 0; }
  const [action, ...args] = argv;
  const options = {};
  const valueFlags = new Map([["--scope", "scope"], ["--project-root", "projectRoot"], ["--dsh-home", "dshHome"], ["--service-package", "servicePackage"]]);
  const base = process.env.META_KIM_CALLER_CWD ?? process.cwd();
  for (let index = 0; index < args.length; index += 1) {
    const [key, inline] = args[index].split(/=(.*)/su);
    if (valueFlags.has(key)) {
      const value = inline ?? args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
      options[valueFlags.get(key)] = key === "--scope" ? value : path.resolve(base, value);
    } else if (key === "--json" && inline === undefined) options.json = true;
    else if (key === "--dry-run" && inline === undefined) options.dryRun = true;
    else if (key === "--no-mcp" && inline === undefined) options.mcp = false;
    else throw new Error(`Unknown DSH option: ${args[index]}`);
  }
  const result = await manageDsh(action, options);
  if (options.json) console.log(json(result));
  else {
    console.log(`DSH ${action}: ${result.status}`);
    if (result.skillCount !== undefined) console.log(`Native Skills: ${result.skillCount}. MCP configured: ${result.mcpConfigured === true ? "yes" : result.mcpConfigured === false ? "no" : "unknown"}.`);
    if (result.launch) console.log(`Launch argv: ${JSON.stringify(result.launch)}${Object.keys(result.launchEnvironment).length ? `; environment: ${JSON.stringify(result.launchEnvironment)}` : ""}`);
    for (const item of result.conflicts ?? result.issues ?? []) console.log(`Preserved / needs attention: ${item.path} (${item.reason})`);
    if (result.nodeRequirement) console.log(result.nodeRequirement);
    console.log("File/config verification does not certify native model execution, Hook enforcement, or delivery quality.");
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runDshCli().then((code) => { process.exitCode = code; }).catch((error) => { console.error(`meta-kim dsh: ${error.message}`); process.exitCode = 1; });
}
