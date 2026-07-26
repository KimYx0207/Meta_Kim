import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export const CODEX_REQUEST_USER_INPUT_FEATURE = "default_mode_request_user_input";
export const CODEX_JS_REPL_FEATURE = "js_repl";
export const CODEX_APP_NATIVE_PLUGIN_IDS = [
  "browser@openai-bundled",
  "chrome@openai-bundled",
  "computer-use@openai-bundled",
];
const WINDOWS_NOTIFY_COMMAND = [
  "powershell.exe",
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
  "$input | Out-Null",
];

function findSection(lines, sectionName) {
  const headerRe = new RegExp(`^\\s*\\[${sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*(?:#.*)?$`);
  const anyHeaderRe = /^\s*\[[^\]]+\]\s*(?:#.*)?$/;
  const start = lines.findIndex((line) => headerRe.test(line));
  if (start < 0) {
    return null;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (anyHeaderRe.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function normalizeLines(configText = "") {
  const normalized = String(configText ?? "").replace(/\r\n/g, "\n");
  const trailingNewline = normalized.endsWith("\n");
  const lines = normalized.length > 0 ? normalized.split("\n") : [];
  if (trailingNewline) {
    lines.pop();
  }
  return lines;
}

const TOML_BARE_KEY_RE = /^\s*[A-Za-z0-9_.-]+\s*=/;
const TOML_TABLE_HEADER_RE = /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/;

function codeBeforeTomlComment(line = "") {
  let quote = null;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
        continue;
      }
      if (quote === '"' && ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === "#") {
      return line.slice(0, index);
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    }
  }

  return line;
}

function scanTomlContainers(code, stack, lineNumber) {
  let quote = null;
  let escaped = false;

  for (let index = 0; index < code.length; index += 1) {
    const ch = code[index];
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
        continue;
      }
      if (quote === '"' && ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "[") {
      stack.push({ kind: "array", line: lineNumber, column: index + 1 });
      continue;
    }
    if (ch === "{") {
      stack.push({ kind: "inline table", line: lineNumber, column: index + 1 });
      continue;
    }
    if (ch === "]") {
      const latestArray = stack.findLastIndex((entry) => entry.kind === "array");
      if (latestArray >= 0) stack.splice(latestArray, 1);
      continue;
    }
    if (ch === "}") {
      const latestTable = stack.findLastIndex((entry) => entry.kind === "inline table");
      if (latestTable >= 0) stack.splice(latestTable, 1);
    }
  }
}

function codexConfigTomlIssue(configText = "") {
  const lines = normalizeLines(configText);
  const stack = [];

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const rawLine = lines[index];
    const code = codeBeforeTomlComment(rawLine);
    if (!code.trim()) continue;

    const isTableHeader = TOML_TABLE_HEADER_RE.test(rawLine);
    if (stack.length > 0 && (TOML_BARE_KEY_RE.test(code) || isTableHeader)) {
      return {
        type: "statement_inside_unclosed_container",
        line: lineNumber,
        column: code.search(/\S/) + 1,
        snippet: rawLine.trim(),
        opener: stack[stack.length - 1],
      };
    }

    if (isTableHeader) continue;
    scanTomlContainers(code, stack, lineNumber);
  }

  if (stack.length > 0) {
    return {
      type: "unclosed_container",
      line: lines.length || 1,
      column: 1,
      snippet: "<end of file>",
      opener: stack[stack.length - 1],
    };
  }

  return null;
}

function formatCodexConfigTomlIssue(issue) {
  const opener = issue.opener;
  const location = `line ${issue.line}:${issue.column}`;
  const openedAt = `${opener.kind} opened at line ${opener.line}:${opener.column}`;
  return [
    `Codex config.toml is not safe to merge: ${location} appears before an unclosed TOML ${openedAt}.`,
    `Problem line: ${issue.snippet}`,
    "Fix the missing comma or closing bracket above this line first, then put Codex feature flags under [features], for example:",
    "[features]",
    "multi_agent = true",
  ].join("\n");
}

export class CodexConfigTomlError extends Error {
  constructor(issue) {
    super(formatCodexConfigTomlIssue(issue));
    this.name = "CodexConfigTomlError";
    this.issue = issue;
  }
}

export function assertCodexConfigTomlMergeable(configText = "") {
  const issue = codexConfigTomlIssue(configText);
  if (issue) {
    throw new CodexConfigTomlError(issue);
  }
}

function ensureSectionSetting(lines, sectionName, settingName, settingValue) {
  const settingLine = `${settingName} = ${settingValue}`;
  const settingRe = new RegExp(
    `^(\\s*)${settingName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=.*$`,
  );
  let section = findSection(lines, sectionName);

  if (!section) {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
      lines.push("");
    }
    lines.push(`[${sectionName}]`, settingLine);
    return;
  }

  for (let index = section.start + 1; index < section.end; index += 1) {
    if (settingRe.test(lines[index])) {
      lines[index] = lines[index].replace(settingRe, `$1${settingLine}`);
      return;
    }
  }

  lines.splice(section.end, 0, settingLine);
}

function firstSectionIndex(lines) {
  const index = lines.findIndex((line) => /^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(line));
  return index < 0 ? lines.length : index;
}

function rootSettingNames(lines) {
  const names = new Set();
  const end = firstSectionIndex(lines);
  for (const line of lines.slice(0, end)) {
    const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/);
    if (match) names.add(match[1]);
  }
  return names;
}

function rootSettingLines(lines) {
  const end = firstSectionIndex(lines);
  return lines.slice(0, end).filter((line) => /^\s*[A-Za-z0-9_.-]+\s*=/.test(line));
}

function sectionNames(lines) {
  return lines
    .map((line) => line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/)?.[1])
    .filter(Boolean);
}

function sectionSettingLines(lines, sectionName) {
  const section = findSection(lines, sectionName);
  if (!section) return [];
  return lines
    .slice(section.start + 1, section.end)
    .filter((line) => /^\s*[A-Za-z0-9_.-]+\s*=/.test(line));
}

function settingNameFromLine(line) {
  return line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/)?.[1] ?? null;
}

function isTopLevelMcpServerSection(sectionName = "") {
  return /^mcp_servers\.(?:"[^"]+"|[A-Za-z0-9_-]+)$/.test(sectionName);
}

function isStdioTransportType(value = "") {
  return String(value).trim().toLowerCase() === "stdio";
}

function isRemoteTransportType(value = "") {
  return ["http", "sse", "streamable_http", "streamable-http"].includes(
    String(value).trim().toLowerCase(),
  );
}

function mcpTransportForSection(lines, sectionName) {
  const settings = new Set(
    sectionSettingLines(lines, sectionName)
      .map(settingNameFromLine)
      .filter(Boolean),
  );
  const type = sectionSettingValue(lines, sectionName, "type");
  const hasUrl = settings.has("url");
  const hasStdioLaunch = settings.has("command") || settings.has("args");

  if (hasUrl && !hasStdioLaunch && !isStdioTransportType(type)) {
    return "remote";
  }
  if (hasStdioLaunch || isStdioTransportType(type)) {
    return "stdio";
  }
  if (hasUrl || isRemoteTransportType(type)) {
    return "remote";
  }
  return null;
}

function ensureBlankLineBeforeAppend(lines) {
  if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
    lines.push("");
  }
}

function appendWholeSection(lines, sourceLines, sectionName) {
  const section = findSection(sourceLines, sectionName);
  if (!section) return;
  ensureBlankLineBeforeAppend(lines);
  lines.push(...sourceLines.slice(section.start, section.end));
}

export function mergeCodexConfigAddOnly(baseConfigText = "", additiveConfigText = "") {
  assertCodexConfigTomlMergeable(baseConfigText);
  assertCodexConfigTomlMergeable(additiveConfigText);

  const baseLines = normalizeLines(baseConfigText);
  const additiveLines = normalizeLines(additiveConfigText);
  const preferredMcpTransports = new Map(
    sectionNames(additiveLines)
      .filter(isTopLevelMcpServerSection)
      .map((sectionName) => [
        sectionName,
        mcpTransportForSection(additiveLines, sectionName),
      ])
      .filter(([, transport]) => Boolean(transport)),
  );
  const existingRootSettings = rootSettingNames(baseLines);
  const missingRootLines = rootSettingLines(additiveLines).filter((line) => {
    const name = settingNameFromLine(line);
    return name && !existingRootSettings.has(name);
  });

  if (missingRootLines.length > 0) {
    const insertAt = firstSectionIndex(baseLines);
    const block = [...missingRootLines, ""];
    baseLines.splice(insertAt, 0, ...block);
  }

  for (const sectionName of sectionNames(additiveLines)) {
    const baseSection = findSection(baseLines, sectionName);
    if (!baseSection) {
      appendWholeSection(baseLines, additiveLines, sectionName);
      continue;
    }

    const existingSettings = new Set(
      sectionSettingLines(baseLines, sectionName)
        .map(settingNameFromLine)
        .filter(Boolean),
    );
    const missingLines = sectionSettingLines(additiveLines, sectionName).filter((line) => {
      const name = settingNameFromLine(line);
      return name && !existingSettings.has(name);
    });
    if (missingLines.length > 0) {
      const latestSection = findSection(baseLines, sectionName);
      baseLines.splice(latestSection.end, 0, ...missingLines);
    }
  }

  normalizeCodexMcpServerTransportConflicts(baseLines, preferredMcpTransports);

  return `${baseLines.join("\n")}\n`;
}

export function ensureCodexRequestUserInputFeature(configText = "") {
  assertCodexConfigTomlMergeable(configText);

  const lines = normalizeLines(configText);
  ensureSectionSetting(
    lines,
    "features",
    CODEX_REQUEST_USER_INPUT_FEATURE,
    "true",
  );
  return `${lines.join("\n")}\n`;
}

export function hasCodexRequestUserInputFeature(configText = "") {
  const normalized = String(configText ?? "").replace(/\r\n/g, "\n");
  const lines = normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n");
  const features = findSection(lines, "features");
  if (!features) {
    return false;
  }
  const settingRe = new RegExp(`^\\s*${CODEX_REQUEST_USER_INPUT_FEATURE}\\s*=\\s*true\\s*(?:#.*)?$`);
  return lines
    .slice(features.start + 1, features.end)
    .some((line) => settingRe.test(line));
}

function tomlString(value) {
  return JSON.stringify(value);
}

function tomlLiteralString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function windowsNotifyBlock() {
  return [
    "# Windows-safe no-op notification command. It consumes Codex's JSON",
    "# notification payload and exits successfully without requiring macOS",
    "# notification tools.",
    "notify = [",
    ...WINDOWS_NOTIFY_COMMAND.map((part, index) => {
      const comma = index === WINDOWS_NOTIFY_COMMAND.length - 1 ? "" : ",";
      return `  ${tomlString(part)}${comma}`;
    }),
    "]",
  ];
}

function codexComputerUseNotifyBlock(command) {
  return [
    "# Codex App computer-use notification helper. This preserves Browser /",
    "# Computer Use turn-ended integration on Windows when the helper exists.",
    "notify = [",
    `  ${tomlString(command)},`,
    `  ${tomlString("turn-ended")}`,
    "]",
  ];
}

function findCodexComputerUseNotifyCommand({
  codexHome,
  pathExists = defaultPathExists,
} = {}) {
  if (!codexHome) return null;
  const helperRoot = path.win32.join(
    codexHome,
    "plugins",
    "cache",
    "openai-bundled",
    "computer-use",
  );

  let versionDirs = [];
  try {
    versionDirs = readdirSync(helperRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareVersionLikeNamesDesc);
  } catch {
    return null;
  }

  for (const versionDir of versionDirs) {
    const candidate = path.win32.join(
      helperRoot,
      versionDir,
      "node_modules",
      "@oai",
      "sky",
      "bin",
      "windows",
      "codex-computer-use.exe",
    );
    if (pathExists(candidate)) return candidate;
  }

  return null;
}

function notifyBlockEnd(lines, start) {
  let bracketDepth = 0;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    bracketDepth += (line.match(/\[/g) ?? []).length;
    bracketDepth -= (line.match(/\]/g) ?? []).length;
    if (bracketDepth <= 0) return index + 1;
  }
  return start + 1;
}

export function ensureCodexWindowsNotifyCompat(
  configText = "",
  platformName = process.platform,
  options = {},
) {
  const normalized = String(configText ?? "").replace(/\r\n/g, "\n");
  if (platformName !== "win32" || !/terminal-notifier/.test(normalized)) {
    return normalized.endsWith("\n") || normalized.length === 0
      ? normalized
      : `${normalized}\n`;
  }

  const trailingNewline = normalized.endsWith("\n");
  const lines = normalized.length > 0 ? normalized.split("\n") : [];
  if (trailingNewline) {
    lines.pop();
  }

  const helperCommand = findCodexComputerUseNotifyCommand(options);
  const replacementBlock = helperCommand
    ? codexComputerUseNotifyBlock(helperCommand)
    : windowsNotifyBlock();

  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*notify\s*=\s*\[/.test(lines[index])) continue;
    const end = notifyBlockEnd(lines, index);
    const block = lines.slice(index, end).join("\n");
    if (!/terminal-notifier/.test(block)) continue;
    lines.splice(index, end - index, ...replacementBlock);
    return `${lines.join("\n")}\n`;
  }

  return `${lines.join("\n")}\n`;
}

function parseTomlStringValue(rawValue = "") {
  const trimmed = String(rawValue).trim().replace(/\s+#.*$/, "");
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function sectionSettingValue(lines, sectionName, settingName) {
  const section = findSection(lines, sectionName);
  if (!section) return null;
  const settingRe = new RegExp(
    `^\\s*${settingName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(.+?)\\s*$`,
  );
  for (let index = section.start + 1; index < section.end; index += 1) {
    const match = lines[index].match(settingRe);
    if (match) return parseTomlStringValue(match[1]);
  }
  return null;
}

function removeSectionSetting(lines, sectionName, settingName) {
  const section = findSection(lines, sectionName);
  if (!section) return;
  const settingRe = new RegExp(
    `^\\s*${settingName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`,
  );
  for (let index = section.end - 1; index > section.start; index -= 1) {
    if (settingRe.test(lines[index])) {
      lines.splice(index, 1);
    }
  }
}

function codexMcpServerTransportConflict(lines, sectionName) {
  const settings = new Set(
    sectionSettingLines(lines, sectionName)
      .map(settingNameFromLine)
      .filter(Boolean),
  );
  const type = sectionSettingValue(lines, sectionName, "type");
  const hasRemote = settings.has("url") || isRemoteTransportType(type);
  const hasStdio =
    settings.has("command") ||
    settings.has("args") ||
    isStdioTransportType(type);

  return hasRemote && hasStdio;
}

function removeTransportTypeIf(lines, sectionName, predicate) {
  const type = sectionSettingValue(lines, sectionName, "type");
  if (type !== null && predicate(type)) {
    removeSectionSetting(lines, sectionName, "type");
  }
}

function normalizeCodexMcpServerTransportConflicts(
  lines,
  preferredTransports = new Map(),
) {
  for (const sectionName of sectionNames(lines)) {
    if (!isTopLevelMcpServerSection(sectionName)) continue;
    if (!codexMcpServerTransportConflict(lines, sectionName)) continue;

    const preferredTransport =
      preferredTransports.get(sectionName) ??
      mcpTransportForSection(lines, sectionName) ??
      "stdio";

    if (preferredTransport === "remote") {
      for (const settingName of ["command", "args", "cwd"]) {
        removeSectionSetting(lines, sectionName, settingName);
      }
      removeTransportTypeIf(lines, sectionName, isStdioTransportType);
      continue;
    }

    for (const settingName of [
      "url",
      "bearer_token_env_var",
      "oauth_client_id",
      "oauth_resource",
    ]) {
      removeSectionSetting(lines, sectionName, settingName);
    }
    removeTransportTypeIf(lines, sectionName, isRemoteTransportType);
  }
}

function withoutExtendedWindowsPrefix(filePath = "") {
  return String(filePath).replace(/^\\\\\?\\/, "");
}

function defaultPathExists(filePath) {
  try {
    return existsSync(withoutExtendedWindowsPrefix(filePath));
  } catch {
    return false;
  }
}

function normalizeWindowsPathForToml(filePath) {
  const value = String(filePath);
  if (!/^[A-Za-z]:\\/.test(value)) return value;
  return value.startsWith("\\\\?\\") ? value : `\\\\?\\${value}`;
}

function isStaleBundledMarketplaceSource(source = "", pathExists = defaultPathExists) {
  const normalized = String(source).replace(/\//g, "\\");
  if (/\\\.codex\\\.tmp\\bundled-marketplaces\\openai-bundled$/i.test(normalized)) {
    return true;
  }
  if (/\\bundled-marketplaces\\openai-bundled$/i.test(normalized)) {
    return !pathExists(source);
  }
  return false;
}

function compareVersionLikeNamesDesc(left, right) {
  return right.localeCompare(left, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function findCodexAppBundledMarketplaceSource({
  platformName = process.platform,
  pathExists = defaultPathExists,
  windowsAppsRoots,
  bundledMarketplaceSource,
} = {}) {
  if (bundledMarketplaceSource && pathExists(bundledMarketplaceSource)) {
    return normalizeWindowsPathForToml(bundledMarketplaceSource);
  }
  if (platformName !== "win32") {
    return null;
  }

  const roots = windowsAppsRoots ?? [
    process.env.ProgramFiles ? path.win32.join(process.env.ProgramFiles, "WindowsApps") : null,
    "C:\\Program Files\\WindowsApps",
  ].filter(Boolean);

  for (const root of roots) {
    let entries = [];
    try {
      entries = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^OpenAI\.Codex_/i.test(entry.name))
        .map((entry) => entry.name);
    } catch {
      continue;
    }

    for (const appDir of entries.sort(compareVersionLikeNamesDesc)) {
      const candidate = path.win32.join(
        root,
        appDir,
        "app",
        "resources",
        "plugins",
        "openai-bundled",
      );
      if (pathExists(candidate)) {
        return normalizeWindowsPathForToml(candidate);
      }
    }
  }

  return null;
}

function ensureOpenAiBundledMarketplace(lines, options = {}) {
  const sectionName = "marketplaces.openai-bundled";
  const pathExists = options.pathExists ?? defaultPathExists;
  const existingSource = sectionSettingValue(lines, sectionName, "source");
  const discoveredSource = findCodexAppBundledMarketplaceSource(options);
  const sourceToKeep =
    discoveredSource ??
    (existingSource && !isStaleBundledMarketplaceSource(existingSource, pathExists)
      ? existingSource
      : null);

  ensureSectionSetting(lines, sectionName, "source_type", tomlString("local"));
  if (sourceToKeep) {
    ensureSectionSetting(
      lines,
      sectionName,
      "source",
      tomlLiteralString(normalizeWindowsPathForToml(sourceToKeep)),
    );
    return;
  }

  removeSectionSetting(lines, sectionName, "source");
}

export function ensureCodexAppNativeControls(configText = "", options = {}) {
  assertCodexConfigTomlMergeable(configText);

  const lines = normalizeLines(configText);
  const platformName = options.platformName ?? process.platform;

  ensureSectionSetting(lines, "features", CODEX_REQUEST_USER_INPUT_FEATURE, "true");
  ensureSectionSetting(lines, "features", CODEX_JS_REPL_FEATURE, "true");
  if (platformName === "win32") {
    ensureSectionSetting(lines, "windows", "sandbox", tomlString("unelevated"));
    ensureOpenAiBundledMarketplace(lines, { ...options, platformName });

    for (const pluginId of CODEX_APP_NATIVE_PLUGIN_IDS) {
      ensureSectionSetting(lines, `plugins."${pluginId}"`, "enabled", "true");
    }
  }

  normalizeCodexMcpServerTransportConflicts(lines);

  return ensureCodexWindowsNotifyCompat(
    `${lines.join("\n")}\n`,
    platformName,
    options,
  );
}

function codexConfigTextStyle(configText = "") {
  const text = String(configText ?? "");
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? text.slice(1) : text;
  const eol = body.match(/\r\n|\n|\r/u)?.[0] ?? "\n";
  return {
    text,
    bom,
    body,
    eol,
    trailingNewline: /(?:\r\n|\n|\r)$/u.test(body),
  };
}

function codexConfigLineRecords(configText = "") {
  const style = codexConfigTextStyle(configText);
  const records = [];
  let offset = style.bom.length;
  const matcher = /([^\r\n]*)(\r\n|\n|\r|$)/gu;
  let match;
  while ((match = matcher.exec(style.body)) !== null) {
    const [whole, body, eol] = match;
    if (whole === "" && matcher.lastIndex === style.body.length) break;
    records.push({
      start: offset,
      bodyEnd: offset + body.length,
      end: offset + whole.length,
      body,
      eol,
    });
    offset += whole.length;
    if (!eol) break;
  }
  return { ...style, records };
}

function parseCodexConfigLocators(configText = "") {
  const document = codexConfigLineRecords(configText);
  const tables = new Map();
  const assignments = new Map();
  let table = "";

  const push = (map, key, value) => {
    const values = map.get(key) ?? [];
    values.push(value);
    map.set(key, values);
  };

  for (const record of document.records) {
    const header = record.body.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/u);
    if (header) {
      table = header[1];
      push(tables, table, record);
      continue;
    }
    const assignment = record.body.match(/^(\s*)([A-Za-z0-9_.-]+)(\s*=\s*)(.*)$/u);
    if (!assignment) continue;
    const code = codeBeforeTomlComment(assignment[4]);
    const stack = [];
    scanTomlContainers(code, stack, 1);
    push(assignments, `${table}\u0000${assignment[2]}`, {
      ...record,
      table,
      key: assignment[2],
      indent: assignment[1],
      separator: assignment[3],
      rhs: assignment[4],
      multiline: stack.length > 0,
    });
  }
  return { ...document, tables, assignments };
}

function expandedAssignment(text, assignment) {
  if (!assignment.multiline) return assignment;
  const parsed = codexConfigLineRecords(text);
  const startIndex = parsed.records.findIndex((record) => record.start === assignment.start);
  if (startIndex < 0) throw new Error("Codex config multiline locator disappeared.");
  const stack = [];
  const firstCode = codeBeforeTomlComment(assignment.rhs);
  scanTomlContainers(firstCode, stack, 1);
  let last = parsed.records[startIndex];
  for (let index = startIndex + 1; stack.length > 0 && index < parsed.records.length; index += 1) {
    last = parsed.records[index];
    scanTomlContainers(codeBeforeTomlComment(last.body), stack, index + 1);
  }
  if (stack.length > 0) {
    throw new Error(`Codex config mutation cannot safely locate multiline ${assignment.table}.${assignment.key}.`);
  }
  return {
    ...assignment,
    bodyEnd: last.bodyEnd,
    end: last.end,
    body: text.slice(assignment.start, last.bodyEnd),
  };
}

function mutationLocatorKey(locator) {
  return `${locator.table}\u0000${locator.key}`;
}

function splitTomlRhsComment(rhs) {
  const code = codeBeforeTomlComment(rhs);
  return { code, comment: rhs.slice(code.length) };
}

function sameTomlScalar(rhs, desiredValue) {
  return splitTomlRhsComment(rhs).code.trim() === desiredValue;
}

function replaceTomlScalar(assignment, desiredValue) {
  const { code, comment } = splitTomlRhsComment(assignment.rhs);
  const trailing = code.slice(code.trimEnd().length);
  return `${assignment.indent}${assignment.key}${assignment.separator}${desiredValue}${trailing}${comment}`;
}

function assertSinglePlanningTable(parsed, tableName) {
  const headers = parsed.tables.get(tableName) ?? [];
  if (headers.length > 1) {
    throw new Error(`Codex config mutation is ambiguous: duplicate [${tableName}] tables.`);
  }
  return headers[0] ?? null;
}

function planCodexSettingMutation(configText, table, key, desiredValue) {
  const parsed = parseCodexConfigLocators(configText);
  const header = table ? assertSinglePlanningTable(parsed, table) : null;
  const locator = { table, key };
  const existing = parsed.assignments.get(mutationLocatorKey(locator)) ?? [];
  if (existing.length > 1) {
    throw new Error(`Codex config mutation is ambiguous: duplicate ${table ? `[${table}].` : ""}${key}.`);
  }
  if (existing.length === 1) {
    const assignment = existing[0];
    if (assignment.multiline) {
      throw new Error(`Codex config mutation cannot safely locate multiline ${table ? `[${table}].` : ""}${key}.`);
    }
    if (sameTomlScalar(assignment.rhs, desiredValue)) {
      return { text: configText, mutation: null };
    }
    const afterFragment = replaceTomlScalar(assignment, desiredValue);
    return {
      text: `${configText.slice(0, assignment.start)}${afterFragment}${configText.slice(assignment.bodyEnd)}`,
      mutation: {
        kind: "replace",
        locator,
        beforeFragment: assignment.body,
        afterFragment,
      },
    };
  }

  const settingLine = `${key} = ${desiredValue}`;
  let position;
  let afterFragment;
  if (table && !header) {
    position = configText.length;
    const hasContent = parsed.body.length > 0;
    const lastLine = parsed.records.at(-1)?.body ?? "";
    const separator = !hasContent
      ? ""
      : parsed.trailingNewline
        ? (lastLine.trim() === "" ? "" : parsed.eol)
        : `${parsed.eol}${parsed.eol}`;
    const suffix = parsed.trailingNewline ? parsed.eol : "";
    afterFragment = `${separator}[${table}]${parsed.eol}${settingLine}${suffix}`;
  } else if (table) {
    const headerIndex = parsed.records.indexOf(header);
    const nextHeader = parsed.records.slice(headerIndex + 1).find((record) =>
      /^\s*\[[^\]]+\]\s*(?:#.*)?$/u.test(record.body)
    );
    position = nextHeader?.start ?? configText.length;
    const prefix = position === configText.length && !parsed.trailingNewline && parsed.body.length > 0
      ? parsed.eol
      : "";
    const suffix = position < configText.length || parsed.trailingNewline ? parsed.eol : "";
    afterFragment = `${prefix}${settingLine}${suffix}`;
  } else {
    const firstHeader = parsed.records.find((record) =>
      /^\s*\[[^\]]+\]\s*(?:#.*)?$/u.test(record.body)
    );
    position = firstHeader?.start ?? configText.length;
    const suffix = position < configText.length || parsed.trailingNewline ? parsed.eol : "";
    afterFragment = `${settingLine}${suffix}`;
  }
  return {
    text: `${configText.slice(0, position)}${afterFragment}${configText.slice(position)}`,
    mutation: {
      kind: "insert",
      locator,
      beforeFragment: "",
      afterFragment,
    },
  };
}

function planCodexSettingRemoval(configText, table, key) {
  const parsed = parseCodexConfigLocators(configText);
  if (table) assertSinglePlanningTable(parsed, table);
  const locator = { table, key };
  const candidates = parsed.assignments.get(mutationLocatorKey(locator)) ?? [];
  if (candidates.length === 0) return { text: configText, mutation: null };
  if (candidates.length !== 1) {
    throw new Error(`Codex config mutation is ambiguous: duplicate ${table}.${key}.`);
  }
  const assignment = expandedAssignment(configText, candidates[0]);
  let beforeFragment = assignment.body;
  const afterFragment = assignment.body
    .split(/\r\n|\n|\r/u)
    .map((line) => `# Meta_Kim disabled conflicting ${table ? `[${table}].` : ""}${key}: ${line}`)
    .join(parsed.eol);
  let replaceStart = assignment.start;
  let replaceEnd = assignment.bodyEnd;
  const existingIndexes = [];
  for (
    let index = configText.indexOf(afterFragment);
    index >= 0;
    index = configText.indexOf(afterFragment, index + afterFragment.length)
  ) {
    existingIndexes.push(index);
  }
  if (existingIndexes.length === 1) {
    const existingStart = existingIndexes[0];
    const existingEnd = existingStart + afterFragment.length;
    const adjacentLine = (value) => /^[\t ]*(?:\r\n|\n|\r)[\t ]*$/u.test(value);
    if (
      existingStart >= assignment.bodyEnd &&
      adjacentLine(configText.slice(assignment.bodyEnd, existingStart))
    ) {
      replaceEnd = existingEnd;
      beforeFragment = configText.slice(replaceStart, replaceEnd);
    } else if (
      existingEnd <= assignment.start &&
      adjacentLine(configText.slice(existingEnd, assignment.start))
    ) {
      replaceStart = existingStart;
      beforeFragment = configText.slice(replaceStart, replaceEnd);
    }
  }
  return {
    text: `${configText.slice(0, replaceStart)}${afterFragment}${configText.slice(replaceEnd)}`,
    mutation: {
      kind: "replace",
      locator,
      beforeFragment,
      afterFragment,
    },
  };
}

function planCodexStaleDisabledCommentCleanup(configText, table, key) {
  const parsed = parseCodexConfigLocators(configText);
  if (table) assertSinglePlanningTable(parsed, table);
  const locator = { table, key };
  const assignments = parsed.assignments.get(mutationLocatorKey(locator)) ?? [];
  if (assignments.length !== 1) return { text: configText, mutation: null };
  const assignment = expandedAssignment(configText, assignments[0]);
  const disabledPrefix = `# Meta_Kim disabled conflicting ${table ? `[${table}].` : ""}${key}:`;
  const comments = parsed.records.filter((record) => record.body.startsWith(disabledPrefix));
  if (comments.length === 0) return { text: configText, mutation: null };
  if (comments.length !== 1) {
    throw new Error(`Codex config managed disabled comment is ambiguous: ${table}.${key}`);
  }
  const comment = comments[0];
  const adjacentLine = (value) => /^[\t ]*(?:\r\n|\n|\r)[\t ]*$/u.test(value);
  let replaceStart;
  let replaceEnd;
  if (
    comment.start >= assignment.bodyEnd &&
    adjacentLine(configText.slice(assignment.bodyEnd, comment.start))
  ) {
    replaceStart = assignment.start;
    replaceEnd = comment.bodyEnd;
  } else if (
    comment.bodyEnd <= assignment.start &&
    adjacentLine(configText.slice(comment.bodyEnd, assignment.start))
  ) {
    replaceStart = comment.start;
    replaceEnd = assignment.bodyEnd;
  } else {
    throw new Error(`Codex config managed disabled comment drifted: ${table}.${key}`);
  }
  const beforeFragment = configText.slice(replaceStart, replaceEnd);
  return {
    text: `${configText.slice(0, replaceStart)}${assignment.body}${configText.slice(replaceEnd)}`,
    mutation: {
      kind: "replace",
      locator,
      beforeFragment,
      afterFragment: assignment.body,
    },
  };
}

function planCodexNotifyMutation(configText, platformName, options) {
  if (platformName !== "win32" || !/terminal-notifier/u.test(configText)) {
    return { text: configText, mutation: null };
  }
  const parsed = parseCodexConfigLocators(configText);
  const locator = { table: "", key: "notify" };
  const candidates = parsed.assignments.get(mutationLocatorKey(locator)) ?? [];
  if (candidates.length !== 1) {
    throw new Error("Codex config notify mutation is missing or ambiguous.");
  }
  const assignment = expandedAssignment(configText, candidates[0]);
  if (!/terminal-notifier/u.test(assignment.body)) {
    return { text: configText, mutation: null };
  }
  const helperCommand = findCodexComputerUseNotifyCommand(options);
  const replacementLines = helperCommand
    ? codexComputerUseNotifyBlock(helperCommand)
    : windowsNotifyBlock();
  const indent = assignment.indent;
  const afterFragment = replacementLines
    .map((line) => `${indent}${line}`)
    .join(parsed.eol);
  return {
    text: `${configText.slice(0, assignment.start)}${afterFragment}${configText.slice(assignment.bodyEnd)}`,
    mutation: {
      kind: "replace",
      locator,
      beforeFragment: assignment.body,
      afterFragment,
    },
  };
}

export function normalizeCodexConfigMutations(mutations = []) {
  if (!Array.isArray(mutations)) {
    throw new TypeError("Codex config mutations must be an array.");
  }
  const normalized = [];
  const indexes = new Map();
  for (const [index, mutation] of mutations.entries()) {
    if (
      !mutation ||
      !["insert", "replace", "remove"].includes(mutation.kind) ||
      !mutation.locator ||
      typeof mutation.locator.table !== "string" ||
      typeof mutation.locator.key !== "string" ||
      !mutation.locator.key ||
      typeof mutation.beforeFragment !== "string" ||
      typeof mutation.afterFragment !== "string" ||
      (mutation.kind !== "remove" && !mutation.afterFragment)
    ) {
      throw new TypeError(`Invalid Codex config mutation at index ${index}.`);
    }
    if (
      (mutation.kind === "insert" && mutation.beforeFragment !== "") ||
      (mutation.kind === "replace" && (!mutation.beforeFragment || !mutation.afterFragment)) ||
      (mutation.kind === "remove" && (!mutation.beforeFragment || mutation.afterFragment !== ""))
    ) {
      throw new TypeError(`Invalid ${mutation.kind} Codex config mutation at index ${index}.`);
    }
    const key = mutationLocatorKey(mutation.locator);
    const next = {
      kind: mutation.kind,
      locator: {
        table: mutation.locator.table,
        key: mutation.locator.key,
      },
      beforeFragment: mutation.beforeFragment,
      afterFragment: mutation.afterFragment,
    };
    const previousIndex = indexes.get(key);
    if (previousIndex === undefined) {
      indexes.set(key, normalized.length);
      normalized.push(next);
      continue;
    }
    const previous = normalized[previousIndex];
    let chained = null;
    if (
      previous.kind === next.kind &&
      previous.beforeFragment === next.beforeFragment &&
      previous.afterFragment === next.afterFragment
    ) {
      // A host may restore the pre-merge value between runs. Reapplying the
      // exact same mutation does not create a second ownership layer; retain
      // the original reversible journal entry.
      chained = previous;
    } else if (
      previous.kind === "replace" &&
      next.kind === "replace" &&
      (() => {
        const managedIndex = next.beforeFragment.indexOf(previous.afterFragment);
        if (
          managedIndex < 0 ||
          next.beforeFragment.indexOf(
            previous.afterFragment,
            managedIndex + previous.afterFragment.length,
          ) >= 0
        ) return false;
        const before = next.beforeFragment.slice(0, managedIndex);
        const after = next.beforeFragment.slice(managedIndex + previous.afterFragment.length);
        const separator = /^[\t ]*(?:\r\n|\n|\r)[\t ]*$/u;
        return (
          managedIndex === 0 &&
          after.endsWith(next.afterFragment) &&
          separator.test(after.slice(0, -next.afterFragment.length))
        ) || (
          managedIndex + previous.afterFragment.length === next.beforeFragment.length &&
          before.startsWith(next.afterFragment) &&
          separator.test(before.slice(next.afterFragment.length))
        );
      })()
    ) {
      // The host restored a current active value next to Meta_Kim's prior
      // disabled fragment. Removing that stale managed fragment closes this
      // locator's ownership; uninstall must leave the host value in place.
      normalized.splice(previousIndex, 1);
      indexes.clear();
      normalized.forEach((item, itemIndex) => indexes.set(mutationLocatorKey(item.locator), itemIndex));
      continue;
    } else if (previous.kind === "insert" && next.kind === "replace") {
      const at = previous.afterFragment.indexOf(next.beforeFragment);
      if (at >= 0 && previous.afterFragment.indexOf(next.beforeFragment, at + next.beforeFragment.length) < 0) {
        chained = {
          ...previous,
          afterFragment: `${previous.afterFragment.slice(0, at)}${next.afterFragment}${previous.afterFragment.slice(at + next.beforeFragment.length)}`,
        };
      }
    } else if (previous.kind === "replace" && next.kind === "replace" && previous.afterFragment === next.beforeFragment) {
      chained = { ...previous, afterFragment: next.afterFragment };
    } else if (
      previous.kind === "replace" &&
      next.kind === "replace" &&
      previous.afterFragment === next.afterFragment
    ) {
      // The host restored or regenerated the unmanaged baseline while the
      // desired managed result stayed exact. Rebase the reversible journal to
      // the latest baseline so cleanup restores current host state.
      chained = next;
    } else if (previous.kind === "replace" && next.kind === "remove" && previous.afterFragment === next.beforeFragment) {
      chained = { ...previous, kind: "remove", afterFragment: "" };
    } else if (previous.kind === "remove" && next.kind === "insert") {
      chained = {
        ...previous,
        kind: "replace",
        afterFragment: next.afterFragment,
      };
    } else if (previous.kind === "insert" && next.kind === "remove") {
      const inserted = previous.afterFragment.includes(next.beforeFragment);
      if (inserted) chained = null;
      if (inserted) {
        normalized.splice(previousIndex, 1);
        indexes.clear();
        normalized.forEach((item, itemIndex) => indexes.set(mutationLocatorKey(item.locator), itemIndex));
        continue;
      }
    }
    if (!chained) {
      throw new Error(`Non-contiguous Codex config mutation chain: ${mutation.locator.table}.${mutation.locator.key}`);
    }
    normalized[previousIndex] = chained;
  }
  return normalized;
}

export function planCodexAppNativeControls(configText = "", options = {}) {
  assertCodexConfigTomlMergeable(configText);
  let text = String(configText ?? "");
  const mutations = [];
  const settings = [
    ["features", CODEX_REQUEST_USER_INPUT_FEATURE, "true"],
    ["features", CODEX_JS_REPL_FEATURE, "true"],
  ];
  const platformName = options.platformName ?? process.platform;
  if (platformName === "win32") {
    settings.push(
      ["windows", "sandbox", tomlString("unelevated")],
      ["marketplaces.openai-bundled", "source_type", tomlString("local")],
      ...CODEX_APP_NATIVE_PLUGIN_IDS.map((pluginId) => [
        `plugins."${pluginId}"`,
        "enabled",
        "true",
      ]),
    );
  }
  for (const [table, key, value] of settings) {
    const planned = planCodexSettingMutation(text, table, key, value);
    text = planned.text;
    if (planned.mutation) mutations.push(planned.mutation);
  }

  if (platformName === "win32") {
    const pathExists = options.pathExists ?? defaultPathExists;
    const currentLines = normalizeLines(text);
    const existingSource = sectionSettingValue(
      currentLines,
      "marketplaces.openai-bundled",
      "source",
    );
    const discoveredSource = findCodexAppBundledMarketplaceSource({
      ...options,
      platformName,
      pathExists,
    });
    const sourceToKeep = discoveredSource ?? (
      existingSource && !isStaleBundledMarketplaceSource(existingSource, pathExists)
        ? existingSource
        : null
    );
    const sourcePlan = sourceToKeep
      ? planCodexSettingMutation(
          text,
          "marketplaces.openai-bundled",
          "source",
          tomlLiteralString(normalizeWindowsPathForToml(sourceToKeep)),
        )
      : planCodexSettingRemoval(text, "marketplaces.openai-bundled", "source");
    text = sourcePlan.text;
    if (sourcePlan.mutation) mutations.push(sourcePlan.mutation);

    if (sourceToKeep) {
      const cleanupPlan = planCodexStaleDisabledCommentCleanup(
        text,
        "marketplaces.openai-bundled",
        "source",
      );
      text = cleanupPlan.text;
      if (cleanupPlan.mutation) mutations.push(cleanupPlan.mutation);
    }

    const notifyPlan = planCodexNotifyMutation(text, platformName, options);
    text = notifyPlan.text;
    if (notifyPlan.mutation) mutations.push(notifyPlan.mutation);
  }

  const conflictLines = normalizeLines(text);
  for (const sectionName of sectionNames(conflictLines)) {
    if (!isTopLevelMcpServerSection(sectionName)) continue;
    if (!codexMcpServerTransportConflict(conflictLines, sectionName)) continue;
    const preferred = mcpTransportForSection(conflictLines, sectionName) ?? "stdio";
    const removals = preferred === "remote"
      ? ["command", "args", "cwd"]
      : ["url", "bearer_token_env_var", "oauth_client_id", "oauth_resource"];
    const type = sectionSettingValue(conflictLines, sectionName, "type");
    if (
      type !== null &&
      (preferred === "remote" ? isStdioTransportType(type) : isRemoteTransportType(type))
    ) {
      removals.push("type");
    }
    for (const key of removals) {
      const removal = planCodexSettingRemoval(text, sectionName, key);
      text = removal.text;
      if (removal.mutation) mutations.push(removal.mutation);
    }
  }

  assertCodexConfigTomlMergeable(text);
  return { text, mutations: normalizeCodexConfigMutations(mutations) };
}

function uniqueAssignmentForInverse(text, locator) {
  const parsed = parseCodexConfigLocators(text);
  if (locator.table && (parsed.tables.get(locator.table) ?? []).length !== 1) {
    throw new Error(`Codex config managed table is missing or ambiguous: ${locator.table}`);
  }
  const assignments = parsed.assignments.get(mutationLocatorKey(locator)) ?? [];
  if (assignments.length !== 1) {
    throw new Error(
      `Codex config managed locator is ${assignments.length === 0 ? "missing" : "ambiguous"}: ${locator.table}.${locator.key}`,
    );
  }
  return expandedAssignment(text, assignments[0]);
}

function insertedTableHasUnmanagedContent(text, mutation, assignment) {
  const headerMatch = mutation.afterFragment.match(
    new RegExp(`(?:^|\\r\\n|\\n|\\r)\\s*\\[${mutation.locator.table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*(?:#.*)?(?:\\r\\n|\\n|\\r)`, "u"),
  );
  if (!mutation.locator.table || !headerMatch) return false;
  const parsed = parseCodexConfigLocators(text);
  const header = [...parsed.records]
    .reverse()
    .find((record) =>
      record.start < assignment.start &&
      new RegExp(`^\\s*\\[${mutation.locator.table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*(?:#.*)?$`, "u").test(record.body)
    );
  if (!header) return true;
  const nextHeader = parsed.records.find((record) =>
    record.start > header.start && /^\s*\[[^\]]+\]\s*(?:#.*)?$/u.test(record.body)
  );
  const sectionEnd = nextHeader?.start ?? text.length;
  const remainder = `${text.slice(header.end, assignment.start)}${text.slice(assignment.end, sectionEnd)}`;
  return remainder.split(/\r\n|\n|\r/u).some((line) => {
    const trimmed = line.trim();
    return Boolean(trimmed && !trimmed.startsWith("#"));
  });
}

export function invertCodexConfigMutations(configText = "", mutations = []) {
  const normalized = normalizeCodexConfigMutations(mutations);
  let text = String(configText ?? "");

  // Preflight and simulate the complete inverse in memory. No caller-visible
  // result is produced unless every managed locator and exact fragment passes.
  for (const mutation of [...normalized].reverse()) {
    if (mutation.kind === "remove") {
      const parsed = parseCodexConfigLocators(text);
      if (
        mutation.locator.table &&
        (parsed.tables.get(mutation.locator.table) ?? []).length !== 1
      ) {
        throw new Error(`Codex config managed table is missing or ambiguous: ${mutation.locator.table}`);
      }
      if ((parsed.assignments.get(mutationLocatorKey(mutation.locator)) ?? []).length !== 0) {
        throw new Error(`Codex config removed locator was recreated: ${mutation.locator.table}.${mutation.locator.key}`);
      }
      let position = text.length;
      if (mutation.locator.table) {
        const header = parsed.tables.get(mutation.locator.table)[0];
        position = parsed.records.find((record) =>
          record.start > header.start && /^\s*\[[^\]]+\]\s*(?:#.*)?$/u.test(record.body)
        )?.start ?? text.length;
      } else {
        position = parsed.records.find((record) =>
          /^\s*\[[^\]]+\]\s*(?:#.*)?$/u.test(record.body)
        )?.start ?? text.length;
      }
      text = `${text.slice(0, position)}${mutation.beforeFragment}${text.slice(position)}`;
      continue;
    }
    if (mutation.kind === "replace") {
      const parsed = parseCodexConfigLocators(text);
      if (
        mutation.locator.table &&
        (parsed.tables.get(mutation.locator.table) ?? []).length !== 1
      ) {
        throw new Error(`Codex config managed table is missing or ambiguous: ${mutation.locator.table}`);
      }
      const assignments = parsed.assignments.get(mutationLocatorKey(mutation.locator)) ?? [];
      const disabledPrefix = `# Meta_Kim disabled conflicting ${mutation.locator.table ? `[${mutation.locator.table}].` : ""}${mutation.locator.key}:`;
      const isDisabledConflict = mutation.afterFragment
        .split(/\r\n|\n|\r/u)
        .every((line) => line.startsWith(disabledPrefix));
      let exactIndex;
      let replaceEnd;
      if (isDisabledConflict) {
        if (assignments.length !== 0) {
          throw new Error(
            `Codex config disabled locator was recreated or duplicated: ${mutation.locator.table}.${mutation.locator.key}`,
          );
        }
        exactIndex = text.indexOf(mutation.afterFragment);
        if (
          exactIndex < 0 ||
          text.indexOf(mutation.afterFragment, exactIndex + mutation.afterFragment.length) >= 0
        ) {
          throw new Error(
            `Codex config managed fragment drifted: ${mutation.locator.table}.${mutation.locator.key}`,
          );
        }
        replaceEnd = exactIndex + mutation.afterFragment.length;
      } else {
        if (assignments.length !== 1) {
          throw new Error(
            `Codex config managed locator is ${assignments.length === 0 ? "missing" : "ambiguous"}: ${mutation.locator.table}.${mutation.locator.key}`,
          );
        }
        const assignment = expandedAssignment(text, assignments[0]);
        exactIndex = text.indexOf(mutation.afterFragment);
        const fragmentEnd = exactIndex + mutation.afterFragment.length;
        const locatorInsideFragment =
          exactIndex >= 0 &&
          text.indexOf(mutation.afterFragment, fragmentEnd) < 0 &&
          assignment.start >= exactIndex &&
          assignment.bodyEnd <= fragmentEnd &&
          text.slice(assignment.start, assignment.bodyEnd) === assignment.body;
        if (!locatorInsideFragment) {
          throw new Error(
            `Codex config managed fragment drifted: ${mutation.locator.table}.${mutation.locator.key}`,
          );
        }
        replaceEnd = fragmentEnd;
      }
      if (exactIndex < 0) {
        throw new Error(
          `Codex config managed fragment drifted: ${mutation.locator.table}.${mutation.locator.key}`,
        );
      }
      text = `${text.slice(0, exactIndex)}${mutation.beforeFragment}${text.slice(replaceEnd)}`;
      continue;
    }
    const assignment = uniqueAssignmentForInverse(text, mutation.locator);
    let expected = mutation.afterFragment;
    if (mutation.kind === "insert") {
      const fragmentParsed = parseCodexConfigLocators(mutation.afterFragment);
      const candidates = [...fragmentParsed.assignments.values()]
        .flat()
        .filter((candidate) => candidate.key === mutation.locator.key);
      expected = candidates.length === 1
        ? expandedAssignment(mutation.afterFragment, candidates[0]).body
        : null;
    }
    if (!expected || assignment.body !== expected) {
      throw new Error(
        `Codex config managed fragment drifted: ${mutation.locator.table}.${mutation.locator.key}`,
      );
    }
    const exactIndex = text.indexOf(mutation.afterFragment);
    const exactUnique = exactIndex >= 0 && text.indexOf(
      mutation.afterFragment,
      exactIndex + mutation.afterFragment.length,
    ) < 0;
    if (
      exactUnique &&
      !insertedTableHasUnmanagedContent(text, mutation, assignment)
    ) {
      text = `${text.slice(0, exactIndex)}${text.slice(exactIndex + mutation.afterFragment.length)}`;
      continue;
    }

    // A newly inserted table may now contain unrelated user settings. Remove
    // only the exact managed assignment and deliberately preserve the header.
    const removeEnd = assignment.end;
    text = `${text.slice(0, assignment.start)}${text.slice(removeEnd)}`;
  }
  assertCodexConfigTomlMergeable(text);
  return text;
}
