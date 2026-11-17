/**
 * Read-only native configuration inventory for the local Agent workbench.
 *
 * The authoritative runtime compatibility matrix and native home resolver
 * determine *where* to inspect. A present configuration is not a loaded
 * capability, an executed subagent or an authorization to launch a CLI.
 * Only public configuration NAMES cross the HTTP boundary: never commands,
 * arguments, environment values, prompts, credentials or absolute paths.
 */
import { constants as fileFlags } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveClaudeUserConfigPath,
  resolveRuntimeHomeDir,
} from "../../../scripts/meta-kim-sync-config.mjs";

const MATRIX_PATH = fileURLToPath(new URL("../../../config/runtime-compatibility-catalog.json", import.meta.url));
const MAX_DIRECTORY_ITEMS = 256;
const MAX_RECORDS = 2_400;
const MAX_CONFIG_BYTES = 128 * 1024;
const MAX_CONFIG_NAME_LENGTH = 72;
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._@ -]{0,71}$/u;
const SECRET_NAME_PATTERN = /(?:sk-(?:ant|proj|live|test)-|gh[pousr]_|github_pat_|xox[baprs]-|bearer\s|api[_-]?key|secret|token|password|credential)/iu;
const SAFE_FILE_NAME = /^[^/\\\u0000-\u001f\u007f]+$/u;

// These are reviewed native locations, not guessed installed-app directories.
// Runtime home resolution is owned by meta-kim-sync-config.mjs; project paths
// mirror its declared projection layout (plus official native configuration).
const NATIVE_SCOPES = Object.freeze({
  claude: { project: ".claude", global: "claude", agents: "agents", skills: "skills",
    hooks: "hooks", plugins: "plugins", commands: "commands",
    projectConfigs: [".claude/settings.json", ".claude/settings.local.json", ".mcp.json"],
    globalConfigs: ["settings.json"] },
  codex: { project: ".codex", global: "codex", agents: "agents", skills: "skills",
    hooks: "hooks", commands: "commands",
    projectConfigs: [".codex/config.toml", ".codex/hooks.json"],
    globalConfigs: ["config.toml", "hooks.json"] },
  gemini: { project: ".gemini", global: "gemini", agents: "agents", skills: "skills",
    hooks: "hooks", plugins: "extensions", commands: "commands",
    projectConfigs: [".gemini/settings.json"], globalConfigs: ["settings.json"] },
  zcode: { project: ".zcode", global: "zcode", agents: "agents", skills: "skills",
    hooks: "hooks", commands: "commands",
    projectConfigs: [".zcode/config.json"], globalConfigs: ["cli/config.json"] },
  cursor: { project: ".cursor", global: "cursor", agents: "agents", skills: "skills",
    hooks: "hooks", plugins: "plugins", commands: "commands",
    projectConfigs: [".cursor/mcp.json", ".cursor/hooks.json"],
    globalConfigs: ["mcp.json", "hooks.json"] },
  opencode: { project: ".opencode", global: "opencode", agents: "agents", skills: "skills",
    plugins: "plugins", commands: "commands", projectConfigs: ["opencode.json"],
    globalConfigs: ["opencode.json"] },
  openclaw: { project: "openclaw", global: "openclaw", agents: "workspaces", skills: "skills",
    hooks: "hooks", projectConfigs: [], globalConfigs: ["openclaw.json"] },
  qoder: { project: ".qoder", global: "qoder", agents: "agents", skills: "skills",
    hooks: "hooks", projectConfigs: [".qoder/settings.json", ".qoder/settings.local.json"],
    globalConfigs: ["settings.json"] },
  trae: { project: ".trae", agents: "agents", skills: "skills",
    projectConfigs: [".trae/mcp.json"] },
  pi: { project: ".pi", global: "pi", agents: "agents", skills: "skills",
    plugins: "extensions", commands: "prompts", projectConfigs: [".pi/mcp.json"],
    globalConfigs: ["mcp.json"] },
});

function officialRuntimeHome(id) {
  if (id !== "pi") return resolveRuntimeHomeDir(id);
  // Pi's public native directory contract: PI_CODING_AGENT_DIR overrides
  // ~/.pi/agent. Do not interpret arbitrary paths from project contents.
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  return configured && path.isAbsolute(configured)
    ? path.resolve(configured) : path.join(os.homedir(), ".pi", "agent");
}

function publicName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  return name.length <= MAX_CONFIG_NAME_LENGTH && NAME_PATTERN.test(name)
    && !SECRET_NAME_PATTERN.test(name) ? name : null;
}

function publicCliVersion(value) {
  return typeof value === "string" && value.length <= 96
    && /^[\p{L}\p{N} ._()+/-]+$/u.test(value)
    && !SECRET_NAME_PATTERN.test(value) ? value : null;
}

function within(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function safeKind(target, root) {
  if (!within(target, root)) return null;
  // Never follow symbolic links at any level below a trusted scope root.
  let current = root;
  try {
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    const relative = path.relative(root, target);
    for (const component of relative.split(path.sep).filter(Boolean)) {
      if (!SAFE_FILE_NAME.test(component) || component === "." || component === "..") return null;
      current = path.join(current, component);
      const info = await fs.lstat(current);
      if (info.isSymbolicLink()) return null;
    }
    const stat = await fs.lstat(current);
    return stat.isFile() ? "file" : stat.isDirectory() ? "directory" : null;
  } catch {
    return null;
  }
}

async function readConfig(target, scopeRoot) {
  if (await safeKind(target, scopeRoot) !== "file") return null;
  let handle;
  try {
    handle = await fs.open(target, fileFlags.O_RDONLY | (fileFlags.O_NOFOLLOW || 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES || info.size < 1) return null;
    return await handle.readFile("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function directoryEntries(dir, scopeRoot) {
  if (await safeKind(dir, scopeRoot) !== "directory") return [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => !entry.isSymbolicLink() && SAFE_FILE_NAME.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name, "en"))
      .slice(0, MAX_DIRECTORY_ITEMS);
  } catch {
    return [];
  }
}

function addCapability(target, seen, hostId, kind, value, scope) {
  if (target.length >= MAX_RECORDS) return;
  const label = publicName(value);
  if (!label) return;
  const id = label;
  const key = `${hostId}:${scope}:${kind}:${id.toLowerCase()}`;
  if (seen.has(key)) return;
  seen.add(key);
  target.push({ key, id, label, kind, hostId, scope,
    source: scope === "project" ? "project_native_config" : "user_native_config",
    registrationState: "configured_only", installationState: "configured",
    loadState: "unknown", invocationState: "not_observed" });
}

async function scanNamedFiles({ root, dir, scope, hostId, kind, extensions, target, seen,
  depth = 1, baseDir = dir }) {
  const entries = await directoryEntries(dir, root);
  for (const entry of entries) {
    const candidate = path.join(dir, entry.name);
    if (entry.isDirectory() && depth > 0) {
      await scanNamedFiles({ root, dir: candidate, scope, hostId, kind,
        extensions, target, seen, depth: depth - 1, baseDir });
    } else if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) {
      const fileLabel = entry.name.replace(/\.(?:md|toml|yaml|yml|json)$/iu, "");
      const relativeParent = path.relative(baseDir, dir);
      const label = /^(?:AGENT|SOUL|config)$/iu.test(fileLabel) && relativeParent
        ? relativeParent.split(path.sep).join(".")
        : relativeParent ? `${relativeParent.split(path.sep).join(".")}.${fileLabel}` : fileLabel;
      addCapability(target, seen, hostId, kind, label, scope);
    }
  }
}

async function scanSkills({ root, dir, scope, hostId, target, seen }) {
  // A Skill is a directory containing SKILL.md, not just any folder named skills.
  for (const entry of await directoryEntries(dir, root)) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(dir, entry.name, "SKILL.md");
    if (await safeKind(skillFile, root) === "file") {
      addCapability(target, seen, hostId, "skill", entry.name, scope);
    }
  }
}

async function scanOpenClawAgents({ root, dir, scope, hostId, target, seen }) {
  for (const entry of await directoryEntries(dir, root)) {
    if (!entry.isDirectory()) continue;
    const soulFile = path.join(dir, entry.name, "SOUL.md");
    if (await safeKind(soulFile, root) === "file") {
      addCapability(target, seen, hostId, "subagent_config", entry.name, scope);
    }
  }
}

function namedKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).filter((name) => publicName(name)) : [];
}

function configSections(content, extension) {
  if (extension === ".toml") {
    const sections = { agents: [], mcp: [] };
    // Only bracket section names are interpreted. Never parse `command`,
    // `args`, `env`, config_file paths or authentication values.
    const regexp = /^\s*\[\s*(agents|mcp_servers)\.((?:"[^"\r\n]{1,72}")|(?:[\p{L}\p{N}_-]{1,72}))\s*\]\s*(?:#.*)?$/gmu;
    for (const match of content.matchAll(regexp)) {
      const name = match[2].replace(/^"|"$/gu, "");
      if (!publicName(name)) continue;
      (match[1] === "agents" ? sections.agents : sections.mcp).push(name);
    }
    return { agents: sections.agents, mcp: sections.mcp, hooks: [] };
  }
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const mcp = [parsed.mcpServers, parsed.mcp?.servers, parsed.mcp?.mcpServers]
      .flatMap(namedKeys);
    const agentConfigs = [parsed.agents, parsed.subagents].flatMap(namedKeys);
    const hooks = [];
    for (const [event, value] of Object.entries(parsed.hooks ?? {})) {
      if (!publicName(event)) continue;
      // Display event and number of configured matcher groups, but never
      // expose a hook's executable command, arguments, paths or contents.
      const count = Array.isArray(value) ? Math.min(value.length, 32) : 1;
      for (let index = 0; index < count; index += 1) {
        hooks.push(count === 1 ? event : `${event} ${index + 1}`);
      }
    }
    return { agents: agentConfigs, mcp, hooks };
  } catch {
    return null;
  }
}

async function scanConfigs({ scopeRoot, scope, hostId, configPaths, target, seen }) {
  for (const configPath of configPaths) {
    if (!within(configPath, scopeRoot)) continue;
    const contents = await readConfig(configPath, scopeRoot);
    if (!contents) continue;
    const sections = configSections(contents, path.extname(configPath).toLowerCase());
    if (!sections) continue;
    for (const name of sections.agents) {
      addCapability(target, seen, hostId, "subagent_config", name, scope);
    }
    for (const name of sections.mcp) {
      addCapability(target, seen, hostId, "mcp", name, scope);
    }
    for (const name of sections.hooks) {
      addCapability(target, seen, hostId, "hook", name, scope);
    }
  }
}

async function scanHostScope({ hostId, spec, scope, projectRoot, runtimeHomeResolver,
  claudeMcpConfigResolver, target, seen }) {
  const scopeRoot = scope === "project" ? path.resolve(projectRoot)
    : spec.global ? runtimeHomeResolver(spec.global) : null;
  if (!scopeRoot || !path.isAbsolute(scopeRoot)
    || await safeKind(scopeRoot, scopeRoot) !== "directory") return;
  const base = scope === "project" ? path.join(scopeRoot, spec.project) : scopeRoot;
  const common = { root: scopeRoot, scope, hostId, target, seen };
  // A host-specific folder is optional: Claude supports project-root
  // `.mcp.json` even when `.claude/` does not exist. Do not silently skip
  // independently declared configuration files.
  if (await safeKind(base, scopeRoot) === "directory") {
    if (spec.agents) {
      if (hostId === "openclaw") await scanOpenClawAgents({ ...common, dir: path.join(base, spec.agents) });
      else await scanNamedFiles({ ...common, dir: path.join(base, spec.agents),
        kind: "subagent_config", extensions: hostId === "codex" ? [".toml"] : [".md"], depth: 1 });
    }
    if (spec.skills) await scanSkills({ ...common, dir: path.join(base, spec.skills) });
    if (spec.hooks) await scanNamedFiles({ ...common, dir: path.join(base, spec.hooks),
      kind: "hook", extensions: [".mjs", ".js", ".sh", ".ps1", ".json", ".py", ".md"], depth: 1 });
    if (spec.plugins) await scanNamedFiles({ ...common, dir: path.join(base, spec.plugins),
      kind: "plugin", extensions: [".json", ".mjs", ".js", ".md"], depth: 0 });
    if (spec.plugins) {
      for (const entry of await directoryEntries(path.join(base, spec.plugins), scopeRoot)) {
        if (!entry.isDirectory()) continue;
        addCapability(target, seen, hostId, "plugin", entry.name, scope);
      }
    }
    if (spec.commands) await scanNamedFiles({ ...common, dir: path.join(base, spec.commands),
      kind: "command", extensions: [".md", ".toml"], depth: 1 });
  }

  const configPaths = (scope === "project" ? spec.projectConfigs : spec.globalConfigs || [])
    .map((relative) => path.join(scopeRoot, relative));
  if (scope === "global" && hostId === "claude") {
    // Claude's account-level MCP registry is not in settings.json.
    const userConfig = claudeMcpConfigResolver();
    if (typeof userConfig === "string") {
      // Only inspect the reviewed host config file; reject paths outside its
      // canonical parent directory unless an explicit env override owns it.
      const parent = path.dirname(userConfig);
      await scanConfigs({ ...common, scopeRoot: parent, configPaths: [userConfig] });
    }
  }
  await scanConfigs({ ...common, scopeRoot, configPaths });
}

/**
 * Catalog discovery is read-only and side-effect free. hostSnapshot is the
 * *existing* safe CLI diagnostic from getHosts(), not independent authorization.
 */
export async function discoverNativeHostInventory({
  projectRoot,
  hostSnapshot = { hosts: [] },
  runtimeHomeResolver = officialRuntimeHome,
  claudeMcpConfigResolver = resolveClaudeUserConfigPath,
  catalogPath = MATRIX_PATH,
} = {}) {
  if (!path.isAbsolute(projectRoot ?? "")) throw new TypeError("Absolute projectRoot required");
  const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
  if (!Array.isArray(catalog.products)) throw new TypeError("Runtime compatibility catalog invalid");
  const detections = new Map((hostSnapshot.hosts || []).map((host) => [host.id, host]));
  // The compatibility catalog is the single source for supported and probe-only
  // host identities. Duplicating a host here produces two indistinguishable Pi
  // cards and hides whether its compatibility contract was actually reviewed.
  const allProducts = catalog.products;
  const nativeHosts = allProducts.map((product) => {
    // DSH is the executable host name; the compatibility matrix's product ID
    // is `deepseek-harness`. They describe one host, not two integrations.
    const hostId = product.id === "deepseek-harness" ? "dsh" : product.id;
    const detection = detections.get(hostId);
    const available = detection ? detection.available === true : null;
    const manualImport = ["workbuddy", "doubao"].includes(product.id);
    const connectionMode = manualImport ? "manual_skill_zip_import"
      : detection?.launchSupported === true ? "reviewed_read_only_cli"
      : detection ? "native_cli_diagnostics_only"
        : product.tier === "runtime_projection" ? "native_projection_configuration_only"
          : "compatibility_reference_only";
    const connectionLabel = manualImport ? "手动导入 Skill ZIP"
      : detection?.launchSupported ? "已审阅的本地 CLI 只读研究"
        : detection ? "本地 CLI 检测（暂不开放启动）"
          : product.tier === "runtime_projection" ? "本地配置兼容（未验证连接）"
            : "兼容性参考（未验证连接）";
    return { id: hostId,
      label: hostId === "dsh" ? "DSH · DeepSeek Harness" : product.label || hostId,
      status: detection ? detection.available === true ? "detected"
        : detection.reason === "client_not_installed" ? "not_found" : "unprobed"
        : "not_probed",
      version: publicCliVersion(detection?.version),
      available, launchSupported: detection?.launchSupported === true,
      availability: available === null || (detection && detection.reason === "client_detection_not_verified")
        ? "not_probed" : available ? "detected" : "not_detected",
      verification: detection ? "native_cli_probe" : "compatibility_registry_only",
      compatibilityTier: product.tier,
      connectionKind: manualImport ? "manual_skill_import_only" : "native_runtime_or_candidate",
      connectionMode,
      connectionLabel,
      launchPolicy: detection?.launchSupported === true ? "reviewed_read_only_plan_only" : "not_authorized",
      blockedReason: detection?.launchSupported ? null : detection?.reason || "not_probed_or_not_connected",
      statusLabel: detection?.statusLabel || (manualImport ? "需在客户端手动导入" : "尚未探测本机客户端"),
      nextAction: detection?.nextAction || (manualImport
        ? "需在相应桌面客户端导入 Skill ZIP 并实际验收。"
        : "此处仅记录兼容性和配置目录，未验证本机安装或调用。"),
    };
  });
  const target = [];
  const seen = new Set();
  for (const host of nativeHosts) {
    const spec = NATIVE_SCOPES[host.id];
    if (!spec) continue;
    await scanHostScope({ hostId: host.id, spec, scope: "project", projectRoot,
      runtimeHomeResolver, claudeMcpConfigResolver, target, seen });
    if (spec.global) await scanHostScope({ hostId: host.id, spec, scope: "global", projectRoot,
      runtimeHomeResolver, claudeMcpConfigResolver, target, seen });
  }
  // A shared cross-client Skill directory is scanned once and displayed as
  // Codex/Gemini compatible rather than duplicated once under each host.
  for (const [scope, root, folder] of [
    ["project", projectRoot, path.join(projectRoot, ".agents", "skills")],
    ["global", path.dirname(runtimeHomeResolver("codex")),
      path.join(path.dirname(runtimeHomeResolver("codex")), ".agents", "skills")],
  ]) {
    if (await safeKind(root, root) === "directory") {
      await scanSkills({ root, dir: folder, scope, hostId: "codex", target, seen });
    }
  }
  target.sort((a, b) => a.hostId.localeCompare(b.hostId, "en")
    || a.scope.localeCompare(b.scope, "en")
    || a.kind.localeCompare(b.kind, "en")
    || a.id.localeCompare(b.id, "en"));
  return { scanScope: "server_host", nativeHosts, nativeCapabilities: target,
    nativeInventoryEvidence: "configuration_only_except_cli_detection",
    nativeSubagentInvocationEvidence: "live_run_tasks_only" };
}
