/** Native Gemini CLI / ZCode dialects; canonical governance stays runtime-neutral. */
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const NATIVE_PROJECTION_RUNTIME_IDS = Object.freeze(["gemini", "zcode"]);
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const JSON_ROOTS = new Set(["hooks", "mcp", "mcpServers", "context"]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function checkedPath(locator) {
  if (!Array.isArray(locator) || locator.length < 1 || locator.length > 8 ||
      !JSON_ROOTS.has(locator[0]) || locator.some((part) =>
        typeof part !== "string" || !part || UNSAFE_KEYS.has(part))) {
    throw new Error("Invalid native runtime JSON mutation path");
  }
  return [...locator];
}

export function normalizeNativeJsonMutations(journal) {
  if (!Array.isArray(journal) || journal.length > 256) {
    throw new Error("Invalid native runtime JSON mutation journal");
  }
  return journal.map((entry) => {
    object(entry, "JSON mutation");
    if (!["set", "append"].includes(entry.op)) throw new Error("Unknown JSON mutation operation");
    const result = { op: entry.op, path: checkedPath(entry.path), value: structuredClone(entry.value) };
    if (entry.value === undefined) throw new Error("JSON mutation requires value");
    if (entry.op === "set") {
      if (typeof entry.existed !== "boolean") throw new Error("JSON mutation requires prior existence");
      result.existed = entry.existed;
      if (entry.existed) {
        if (entry.before === undefined) throw new Error("JSON mutation requires prior value");
        result.before = structuredClone(entry.before);
      }
    }
    result.createdPaths = (entry.createdPaths ?? []).map(checkedPath);
    if (result.createdPaths.some((created) => created.length > result.path.length ||
        created.some((part, index) => part !== result.path[index]))) {
      throw new Error("JSON mutation created path must be an owned ancestor");
    }
    return result;
  });
}

function parentFor(config, locator, create = false, createdPaths = []) {
  let node = config;
  for (let index = 0; index < locator.length - 1; index += 1) {
    const key = locator[index];
    if (!Object.hasOwn(node, key)) {
      if (!create) return null;
      node[key] = {};
      createdPaths.push(locator.slice(0, index + 1));
    }
    object(node[key], `Config ${locator.slice(0, index + 1).join(".")}`);
    node = node[key];
  }
  return node;
}

/** Remove exact managed values, preserving unrelated edits and appended user hooks. */
export function invertNativeJsonMutations(config, journal) {
  const next = structuredClone(object(config, "Runtime config"));
  for (const entry of normalizeNativeJsonMutations(journal).reverse()) {
    const parent = parentFor(next, entry.path);
    const key = entry.path.at(-1);
    if (entry.op === "append") {
      if (!parent || !Object.hasOwn(parent, key)) continue;
      if (!Array.isArray(parent[key])) throw new Error(`Managed JSON fragment changed: ${entry.path.join(".")}`);
      const matches = parent[key].flatMap((value, index) => isDeepStrictEqual(value, entry.value) ? [index] : []);
      if (matches.length !== 1) throw new Error(`Managed JSON fragment changed: ${entry.path.join(".")}`);
      parent[key].splice(matches[0], 1);
    } else {
      if (!parent || !Object.hasOwn(parent, key) || !isDeepStrictEqual(parent[key], entry.value)) {
        throw new Error(`Managed JSON fragment changed: ${entry.path.join(".")}`);
      }
      if (entry.existed) parent[key] = structuredClone(entry.before);
      else delete parent[key];
    }
    for (const locator of [...entry.createdPaths].reverse()) {
      const container = parentFor(next, locator);
      const leaf = locator.at(-1);
      const value = container?.[leaf];
      if (value && typeof value === "object" && Object.keys(value).length === 0) delete container[leaf];
    }
  }
  return next;
}

function mutate(config, journal, locator, value, { append = false, replace = false } = {}) {
  checkedPath(locator);
  const createdPaths = [];
  const parent = parentFor(config, locator, true, createdPaths);
  const key = locator.at(-1);
  const existed = Object.hasOwn(parent, key);
  if (append) {
    if (!existed) { parent[key] = []; createdPaths.push(locator); }
    if (!Array.isArray(parent[key])) throw new Error(`Config ${locator.join(".")} must be an array`);
    if (parent[key].some((candidate) => isDeepStrictEqual(candidate, value))) return;
    parent[key].push(structuredClone(value));
    journal.push({ op: "append", path: locator, value, createdPaths });
    return;
  }
  if (existed && isDeepStrictEqual(parent[key], value)) return;
  if (existed && !replace) throw new Error(`Refusing to overwrite unowned native config: ${locator.join(".")}`);
  journal.push({ op: "set", path: locator, value, existed, ...(existed ? { before: structuredClone(parent[key]) } : {}), createdPaths });
  parent[key] = structuredClone(value);
}

export function buildNativeRuntimeAgent(agent, runtimeId) {
  if (!NATIVE_PROJECTION_RUNTIME_IDS.includes(runtimeId)) throw new Error(`Unsupported native runtime ${runtimeId}`);
  // Do not copy Claude-only frontmatter, model names or tool allowlists. Both
  // hosts document omitted tools as inheritance; nested delegation stays with
  // the parent because neither runtime permits subagents to spawn subagents.
  return `---\nname: ${agent.id}\ndescription: ${JSON.stringify(agent.description)}\nmodel: inherit\n${runtimeId === "gemini" ? "kind: local\n" : "injectAgentsMd: true\n"}---\n\n` +
    `<!-- Generated from ${agent.sourceFile}; edit canonical source. -->\n` +
    `You are the ${runtimeId === "gemini" ? "Gemini CLI" : "ZCode"} projection of ${agent.id}.\n` +
    "Use the current host's actual tools and inherit its active model. If nested delegation is needed, return a bounded work order to the parent; do not invent a delegation tool. Load the meta-theory runtime reference for this host before using runtime-specific examples.\n\n" +
    `${agent.body.trim()}\n`;
}

/** A single byte-identical project bundle is discoverable by Codex and Gemini. */
export function applySharedSkillPaths(content) {
  return transformSkillPaths(content, (text) => text.replaceAll("canonical/skills/", ".agents/skills/")
    .replaceAll(".claude/skills/", ".agents/skills/"));
}

function transformSkillPaths(content, transform) {
  const blocks = [];
  let text = content;
  for (const pattern of [
    /Fetch discovery minimum checklist:[\s\S]*?\n(?=Pass condition:)/gu,
    /^- 项目内迭代或创新需要专用能力时，必须创建在对应 runtime 的原生项目目录[\s\S]*?\n/gmu,
  ]) text = text.replace(pattern, (block) => {
    const token = `__META_KIM_LITERAL_RUNTIME_MATRIX_${blocks.length}__`;
    blocks.push([token, block]);
    return token;
  });
  text = transform(text);
  for (const [token, block] of blocks) text = text.replace(token, block);
  return text;
}

/** Agent Skills retain only portable name/description frontmatter. */
export function buildPortableSkillContent(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u);
  if (!match) return content;
  const read = (key) => {
    const lines = match[1].split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const field = lines[index].match(new RegExp(`^${key}:\\s*(.*)$`, "u"));
      if (!field) continue;
      if (["|", ">"].includes(field[1].trim())) {
        const block = [];
        for (let next = index + 1; next < lines.length && !/^[A-Za-z0-9_-]+:\s*/u.test(lines[next]); next += 1) block.push(lines[next].replace(/^\s{2}/u, ""));
        return block.join("\n").trim();
      }
      return field[1].trim().replace(/^['"]|['"]$/gu, "").trim();
    }
    return "";
  };
  const scalar = (value) => value.includes("\n")
    ? `|\n${value.split(/\r?\n/u).map((line) => `  ${line}`).join("\n")}`
    : /^[A-Za-z0-9 _.,;()'"—-]+$/u.test(value) ? value : JSON.stringify(value);
  const name = read("name");
  const description = read("description");
  if (!name || !description) return content;
  return `---\nname: ${scalar(name)}\ndescription: ${scalar(description)}\n---\n\n${content.slice(match[0].length)}`;
}

export function applyNativeSkillPaths(content, runtimeId) {
  if (runtimeId === "codex" || runtimeId === "gemini") return applySharedSkillPaths(content);
  if (runtimeId === "zcode") return transformSkillPaths(content, (text) => text
    .replaceAll("canonical/skills/", ".zcode/skills/")
    .replaceAll("canonical/agents/", ".zcode/agents/")
    .replaceAll(".claude/skills/", ".zcode/skills/"));
  throw new Error(`Unsupported portable skill runtime ${runtimeId}`);
}

function quotedShellArg(value) {
  const text = String(value);
  if (/[\r\n\0]/u.test(text)) throw new Error("Unsafe hook command argument");
  // Generated commands use the existing portable Node convention. Percent
  // expansion and shell metacharacters must never become part of argv.
  if (process.platform === "win32") {
    if (/["%!]/u.test(text)) throw new Error("Unsupported Windows hook path character");
    return `"${text}"`;
  }
  return `'${text.replaceAll("'", "'\\''")}'`;
}

export function buildNativeRuntimeHookEvents(runtimeId, { adapterPath, packageRoot, nodePath = process.execPath } = {}) {
  const events = runtimeId === "gemini"
    ? ["SessionStart", "BeforeAgent", "BeforeTool", "AfterTool", "AfterAgent"]
    : runtimeId === "zcode"
      ? ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]
      : null;
  if (!events) throw new Error(`Unsupported native runtime ${runtimeId}`);
  return Object.fromEntries(events.map((event) => {
    const args = [adapterPath, "--runtime", runtimeId, "--event", event, "--package-root", packageRoot];
    const hook = runtimeId === "zcode"
      ? { type: "process", command: nodePath, args, enabled: true, timeoutMs: 20000 }
      : { type: "command", name: `meta-kim:${event}`, command: [nodePath, ...args].map(quotedShellArg).join(" "), timeout: 20000 };
    return [event, [{ matcher: ".*", hooks: [hook] }]];
  }));
}

export function planNativeRuntimeSettings(base, {
  runtimeId, scope, packageRoot, adapterPath, withHooks = true, withMcp = true,
  previousJournal = [], compatibleMcpServers = {}, nodePath = process.execPath,
} = {}) {
  if (!NATIVE_PROJECTION_RUNTIME_IDS.includes(runtimeId)) throw new Error(`Unsupported native runtime ${runtimeId}`);
  if (!["project", "global"].includes(scope)) throw new Error("Native runtime scope must be project or global");
  if (!path.isAbsolute(packageRoot ?? "") || !path.isAbsolute(adapterPath ?? "")) throw new Error("Native runtime execution paths must be absolute");
  const config = previousJournal.length ? invertNativeJsonMutations(base, previousJournal) : structuredClone(object(base, "Runtime config"));
  const mutations = [];
  if (runtimeId === "gemini") {
    const names = config.context?.fileName;
    if (Array.isArray(names)) mutate(config, mutations, ["context", "fileName"], "AGENTS.md", { append: true });
    else if (typeof names === "string") {
      if (names !== "AGENTS.md") mutate(config, mutations, ["context", "fileName"], [names, "AGENTS.md"], { replace: true });
    } else if (names === undefined) {
      mutate(config, mutations, ["context", "fileName"], ["GEMINI.md", "AGENTS.md"]);
    } else throw new Error("Gemini context.fileName must be a string or array");
  }
  if (withMcp) {
    const serversPath = runtimeId === "gemini" ? ["mcpServers"] : ["mcp", "servers"];
    // Native ZCode MCP suppresses the .agents fallback. Carry that existing
    // fallback into the same transaction before adding our one server.
    if (runtimeId === "zcode" && !Object.keys(config.mcp?.servers ?? {}).length) {
      for (const [name, definition] of Object.entries(object(compatibleMcpServers, "Compatible MCP servers"))) {
        mutate(config, mutations, [...serversPath, name], definition);
      }
    }
    mutate(config, mutations, [...serversPath, "meta-kim-runtime"], {
      command: nodePath,
      args: [path.join(packageRoot, "scripts", "mcp", "meta-runtime-server.mjs")],
      env: { META_KIM_PACKAGE_ROOT: packageRoot, META_KIM_RUNTIME_FAMILY: runtimeId },
    });
  }
  // Official ZCode project hooks are ignored; never emit a fake project hook.
  if (withHooks && (runtimeId !== "zcode" || scope === "global")) {
    const eventsPath = runtimeId === "zcode" ? ["hooks", "events"] : ["hooks"];
    if (runtimeId === "zcode") mutate(config, mutations, ["hooks", "enabled"], true, { replace: true });
    for (const [event, blocks] of Object.entries(buildNativeRuntimeHookEvents(runtimeId, { adapterPath, packageRoot, nodePath }))) {
      for (const block of blocks) mutate(config, mutations, [...eventsPath, event], block, { append: true });
    }
  }
  return { config, mutations: normalizeNativeJsonMutations(mutations), changed: !isDeepStrictEqual(config, base) };
}
