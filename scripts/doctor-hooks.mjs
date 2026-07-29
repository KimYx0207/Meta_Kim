#!/usr/bin/env node
/**
 * Meta_Kim hook doctor — scan settings.json files for hook commands whose
 * target files no longer exist or are obviously incompatible with their Node
 * module scope (zombies, ESM/CommonJS mismatches, etc.).
 *
 * Usage:
 *   node scripts/doctor-hooks.mjs              # scan ~/.claude/settings.json (dry-run)
 *   node scripts/doctor-hooks.mjs --fix        # repair known Graphify hooks, remove zombies, and back up
 *   node scripts/doctor-hooks.mjs --all        # also scan <repo>/.claude/settings.json
 *   node scripts/doctor-hooks.mjs --project    # scan ONLY <repo>/.claude/settings.json
 *   node scripts/doctor-hooks.mjs --project-root <path> # resolve project settings from path
 *   node scripts/doctor-hooks.mjs --lang zh    # force language (en/zh/ja/ko); default: auto
 *   node scripts/doctor-hooks.mjs --silent     # CI mode, exit code = zombie count (capped at 1)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

const MESSAGES = {
  en: {
    title: "Meta_Kim hook doctor",
    scanning: (p) => `Scanning ${p}`,
    notFound: (p) => `settings.json not found at ${p} — nothing to scan`,
    parseFailed: (p, e) => `Failed to parse ${p}: ${e}`,
    noHooks: (p) => `No hooks registered in ${p}`,
    zombieHeader: (n) => `Found ${n} zombie hook(s) — files do not exist:`,
    incompatibleHeader: (n) => `Found ${n} incompatible hook(s) — files exist but cannot run:`,
    unverifiedHeader: (n) => `Found ${n} unverified hook command(s) — target path could not be parsed:`,
    liveHeader: (n) => `Healthy hook(s) (${n}):`,
    zombieItem: (e, m, p) => `  [${e} / ${m}]  ${p}`,
    incompatibleItem: (e, m, p, reason) => `  [${e} / ${m}]  ${p}\n    ${reason}`,
    unverifiedItem: (e, m, command) => `  [${e} / ${m}]  ${command}`,
    summaryClean: "All parsed hook targets point to existing, runtime-compatible files.",
    dryRunHint:
      "Dry-run only. Re-run with --fix to back up, repair known Graphify commands, and remove zombie entries.",
    incompatibleHint:
      "Incompatible hooks are diagnostic-only. Meta_Kim will not delete or rewrite unknown hooks automatically.",
    backupWritten: (p) => `Backup written: ${p}`,
    graphifyRepaired: (n, p) =>
      `Repaired ${n} unsafe Graphify hook command${n === 1 ? "" : "s"} (backup: ${p}).`,
    removedCount: (n) =>
      `Removed ${n} zombie hook entr${n === 1 ? "y" : "ies"}.`,
    settingsSaved: (p) => `Saved: ${p}`,
    finalStructure: "Resulting hook events:",
    langAutoDetected: (l) => `Language: ${l} (auto)`,
  },
  "zh-CN": {
    title: "Meta_Kim hook 体检",
    scanning: (p) => `正在扫描：${p}`,
    notFound: (p) => `${p} 不存在，跳过`,
    parseFailed: (p, e) => `解析 ${p} 失败：${e}`,
    noHooks: (p) => `${p} 里没有注册任何 hook`,
    zombieHeader: (n) => `发现 ${n} 个僵尸 hook（目标文件不存在）：`,
    incompatibleHeader: (n) => `发现 ${n} 个不兼容 hook（文件存在但无法运行）：`,
    unverifiedHeader: (n) => `发现 ${n} 个未验证 hook 命令（无法解析目标路径）：`,
    liveHeader: (n) => `健康的 hook（${n}）：`,
    zombieItem: (e, m, p) => `  [${e} / ${m}]  ${p}`,
    incompatibleItem: (e, m, p, reason) => `  [${e} / ${m}]  ${p}\n    ${reason}`,
    unverifiedItem: (e, m, command) => `  [${e} / ${m}]  ${command}`,
    summaryClean: "所有可解析 hook 的目标文件都存在且运行时兼容。",
    dryRunHint: "当前仅为扫描模式。加 --fix 参数可自动备份、修复已知 Graphify 命令并清除僵尸条目。",
    incompatibleHint: "不兼容 hook 只诊断和建议；Meta_Kim 不会自动删除或改写未知 hook。",
    backupWritten: (p) => `已备份：${p}`,
    graphifyRepaired: (n, p) => `已修复 ${n} 个不安全的 Graphify hook 命令（备份：${p}）。`,
    removedCount: (n) => `已移除 ${n} 个僵尸 hook 条目。`,
    settingsSaved: (p) => `已保存：${p}`,
    finalStructure: "剩余 hook 事件：",
    langAutoDetected: (l) => `语言：${l}（自动）`,
  },
  "ja-JP": {
    title: "Meta_Kim hook ドクター",
    scanning: (p) => `スキャン中：${p}`,
    notFound: (p) => `${p} が見つかりません — スキップ`,
    parseFailed: (p, e) => `${p} の解析に失敗：${e}`,
    noHooks: (p) => `${p} に hook が登録されていません`,
    zombieHeader: (n) =>
      `${n} 個のゾンビ hook を検出（ファイルが存在しません）：`,
    incompatibleHeader: (n) =>
      `${n} 個の互換性のない hook を検出（ファイルは存在しますが実行できません）：`,
    unverifiedHeader: (n) =>
      `${n} 個の未検証 hook コマンドを検出（ターゲットパスを解析できません）：`,
    liveHeader: (n) => `正常な hook（${n}）：`,
    zombieItem: (e, m, p) => `  [${e} / ${m}]  ${p}`,
    incompatibleItem: (e, m, p, reason) => `  [${e} / ${m}]  ${p}\n    ${reason}`,
    unverifiedItem: (e, m, command) => `  [${e} / ${m}]  ${command}`,
    summaryClean: "解析可能なすべての hook ターゲットが存在し、実行時互換性があります。",
    dryRunHint:
      "ドライラン。--fix を付けるとバックアップしてからゾンビを削除します。",
    incompatibleHint:
      "互換性のない hook は診断のみです。Meta_Kim は未知の hook を自動削除・変更しません。",
    backupWritten: (p) => `バックアップ作成：${p}`,
    graphifyRepaired: (n, p) =>
      `安全でない Graphify hook コマンドを ${n} 件修復しました（バックアップ：${p}）。`,
    removedCount: (n) => `ゾンビ hook を ${n} 件削除しました。`,
    settingsSaved: (p) => `保存：${p}`,
    finalStructure: "残存する hook イベント：",
    langAutoDetected: (l) => `言語：${l}（自動）`,
  },
  "ko-KR": {
    title: "Meta_Kim hook 닥터",
    scanning: (p) => `스캔 중: ${p}`,
    notFound: (p) => `${p} 를 찾을 수 없음 — 건너뜀`,
    parseFailed: (p, e) => `${p} 파싱 실패: ${e}`,
    noHooks: (p) => `${p} 에 등록된 hook 이 없음`,
    zombieHeader: (n) => `좀비 hook ${n} 개 발견 (파일 없음):`,
    incompatibleHeader: (n) => `호환되지 않는 hook ${n} 개 발견 (파일은 있지만 실행 불가):`,
    unverifiedHeader: (n) => `검증되지 않은 hook 명령 ${n} 개 발견 (대상 경로를 파싱할 수 없음):`,
    liveHeader: (n) => `정상 hook (${n}):`,
    zombieItem: (e, m, p) => `  [${e} / ${m}]  ${p}`,
    incompatibleItem: (e, m, p, reason) => `  [${e} / ${m}]  ${p}\n    ${reason}`,
    unverifiedItem: (e, m, command) => `  [${e} / ${m}]  ${command}`,
    summaryClean: "파싱 가능한 모든 hook 대상 파일이 존재하며 런타임과 호환됩니다.",
    dryRunHint: "드라이런 모드. --fix 옵션으로 백업 후 좀비 항목을 제거합니다.",
    incompatibleHint:
      "호환되지 않는 hook은 진단만 합니다. Meta_Kim은 알 수 없는 hook을 자동 삭제하거나 수정하지 않습니다.",
    backupWritten: (p) => `백업 완료: ${p}`,
    graphifyRepaired: (n, p) =>
      `안전하지 않은 Graphify hook 명령 ${n}개를 복구했습니다 (백업: ${p}).`,
    removedCount: (n) => `좀비 hook ${n} 건 제거 완료.`,
    settingsSaved: (p) => `저장됨: ${p}`,
    finalStructure: "남은 hook 이벤트:",
    langAutoDetected: (l) => `언어: ${l} (자동)`,
  },
};

function resolveLang(cliLang) {
  const normalize = (value) => {
    if (!value) return null;
    const v = String(value).toLowerCase();
    if (v === "zh" || v.startsWith("zh")) return "zh-CN";
    if (v === "ja" || v.startsWith("ja")) return "ja-JP";
    if (v === "ko" || v.startsWith("ko")) return "ko-KR";
    if (v === "en" || v.startsWith("en")) return "en";
    return null;
  };
  return (
    normalize(cliLang) ||
    normalize(process.env.METAKIM_LANG) ||
    normalize(process.env.LC_ALL) ||
    normalize(process.env.LC_MESSAGES) ||
    normalize(process.env.LANG) ||
    "en"
  );
}

export function parseCommandTokens(command) {
  const tokens = [];
  let current = "";
  let inQuotes = false;
  let quoteChar = "";

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if ((char === '"' || char === "'") && (i === 0 || command[i - 1] !== '\\')) {
      if (inQuotes && char === quoteChar) {
        inQuotes = false;
      } else if (!inQuotes) {
        inQuotes = true;
        quoteChar = char;
      } else {
        current += char;
      }
    } else if (char === " " && !inQuotes) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function customBasename(p) {
  const lastSlash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (lastSlash === -1) return p;
  return p.slice(lastSlash + 1);
}

function isAbsoluteGraphifyExecutable(value) {
  return (
    typeof value === "string" &&
    path.win32.isAbsolute(value) &&
    ["graphify", "graphify.exe"].includes(customBasename(value).toLowerCase())
  );
}

/** Parse only Graphify's documented Claude hook-guard command contract. */
export function parseGraphifyHookCommand(hook) {
  if (!hook || typeof hook !== "object" || typeof hook.command !== "string") {
    return null;
  }
  if (Object.hasOwn(hook, "type") && hook.type !== "command") return null;
  if (Object.hasOwn(hook, "args")) {
    if (!Array.isArray(hook.args) || !hook.args.every((arg) => typeof arg === "string")) {
      return null;
    }
    const executable = hook.command.trim();
    if (!isAbsoluteGraphifyExecutable(executable)) return null;
    const [guard, action, strict, ...extra] = hook.args;
    if (guard !== "hook-guard" || !["read", "search"].includes(action) || extra.length > 0) {
      return null;
    }
    if (strict !== undefined && (action !== "read" || strict !== "--strict")) return null;
    return { executable, action, strict: strict === "--strict", form: "exec" };
  }

  const match = hook.command.trim().match(
    /^(?:"([^"]+)"|'([^']+)'|((?:[A-Za-z]:[\\/]|\\\\|\/\/).+?))\s+hook-guard\s+(read|search)(?:\s+(--strict))?\s*$/iu,
  );
  if (!match) return null;
  const executable = match[1] ?? match[2] ?? match[3];
  const action = match[4].toLowerCase();
  const strict = match[5] === "--strict";
  if (
    !isAbsoluteGraphifyExecutable(executable) ||
    /[\r\n;&|]/u.test(executable) ||
    (strict && action !== "read")
  ) return null;
  return { executable, action, strict, form: "shell" };
}

function trimShellPunctuation(token) {
  return token.replace(/^[;&|]+|[;&|]+$/g, "");
}

const RUNNERS = new Set([
  "node",
  "python",
  "python3",
  "bash",
  "sh",
  "pwsh",
  "powershell",
  "cmd",
  "npx",
  "tsx",
  "ts-node",
  "bun",
  "deno",
]);

function runnerName(token) {
  const base = customBasename(token).toLowerCase();
  const withoutExe = base.endsWith(".exe") ? base.slice(0, -4) : base;
  return RUNNERS.has(withoutExe) ? withoutExe : null;
}

function isScriptLikePath(value) {
  if (!value) return false;
  const lower = value.toLowerCase();
  const scriptExtension = /\.(mjs|js|cjs|py|sh|ts|tsx|bat|cmd|ps1)$/i;
  return (
    scriptExtension.test(lower) ||
    (/^(?:\.{1,2}|~)[\\/]/.test(value) && scriptExtension.test(lower))
  );
}

function extractPathFromTokens(tokens) {
  if (tokens.length === 0) return null;

  const isShellRunner = (runner) =>
    ["bash", "sh", "pwsh", "powershell", "cmd"].includes(runner);

  const isShellPayloadFlag = (token, runner) => {
    const lower = token.toLowerCase();
    if (!isShellRunner(runner)) return false;
    if (runner === "bash" || runner === "sh") return /^-[a-z]*c[a-z]*$/.test(lower);
    if (runner === "cmd") return lower === "/c" || lower === "/k";
    return lower === "-command" || lower === "--command" || lower === "-c";
  };

  const isShellSeparator = (token) =>
    ["&&", "||", ";", "|", "&"].includes(token);

  let activeRunner = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const normalized = trimShellPunctuation(token);
    const lower = normalized.toLowerCase();

    // 1. Skip known runners
    const currentRunner = runnerName(normalized);
    if (currentRunner) {
      activeRunner = currentRunner;
      continue;
    }

    // 2. Shell command payload: recursively parse that payload
    if (isShellPayloadFlag(normalized, activeRunner)) {
      if (i + 1 < tokens.length) {
        return extractCommandPath(tokens[i + 1]);
      }
      return null;
    }

    // 3. Skip options that take an argument
    if (
      normalized === "-r" ||
      normalized === "--require" ||
      normalized === "--loader" ||
      normalized === "--experimental-loader" ||
      normalized === "--import" ||
      normalized === "-m"
    ) {
      i++; // Skip the option parameter/argument token
      continue;
    }

    // 4. Skip shell flow control that commonly appears inside -c payloads.
    if (isShellSeparator(normalized)) {
      continue;
    }

    // 5. Skip "cd <dir>" so the directory is not mistaken for a hook target.
    if (lower === "cd" || lower === "pushd" || lower === "popd") {
      if (lower !== "popd") i++;
      continue;
    }

    // 6. Skip other flags (e.g. --inspect, -v).
    if (
      normalized.startsWith("-") ||
      (normalized.startsWith("/") && normalized.length === 2)
    ) {
      continue;
    }

    // 7. Check if it's a script/path-like target
    if (isScriptLikePath(normalized)) {
      return normalized;
    }
  }

  return null;
}

export function extractCommandPath(command) {
  if (typeof command !== "string") return null;
  return extractPathFromTokens(parseCommandTokens(command.trim()));
}

function extractDirectSpawnArgsTarget(runner, args) {
  const directFileOperand = () => {
    if (args[0] === "--" && isScriptLikePath(args[1])) return args[1];
    if (!args[0]?.startsWith("-") && isScriptLikePath(args[0])) return args[0];
    return null;
  };

  if (["node", "python", "python3", "bash", "sh"].includes(runner)) {
    return directFileOperand();
  }
  if (runner === "pwsh" || runner === "powershell") {
    const fileFlag = args[0]?.toLowerCase();
    if ((fileFlag === "-file" || fileFlag === "--file") && isScriptLikePath(args[1])) {
      return args[1];
    }
  }
  return null;
}

/**
 * Extract the executable script target from either Claude Code's shell-form
 * hook command or its direct-spawn `command` + `args` form.
 *
 * Args are inspected only for allowlisted, unambiguous file-execution modes.
 * Ambiguous runners and eval/module/command payload modes stay unverified so
 * cleanup cannot mistake their data arguments for hook targets.
 *
 * @param {unknown} hook Claude Code hook configuration entry.
 * @returns {string | null} Parsed script path, or null when it cannot be
 * safely identified.
 */
export function extractHookTargetPath(hook) {
  if (!hook || typeof hook !== "object") return null;
  const graphify = parseGraphifyHookCommand(hook);
  if (graphify) return graphify.executable;
  const command = typeof hook.command === "string" ? hook.command : "";
  if (Object.hasOwn(hook, "args")) {
    if (!Array.isArray(hook.args) || !hook.args.every((arg) => typeof arg === "string")) {
      return null;
    }
    const literalCommand = command.trim();
    if (isScriptLikePath(literalCommand)) return literalCommand;
    const runner = runnerName(literalCommand);
    return runner ? extractDirectSpawnArgsTarget(runner, hook.args) : null;
  }
  return extractCommandPath(command);
}

/**
 * Detect shell-form hook commands that cannot survive Claude Code's native
 * Windows Git Bash boundary. An unquoted `C:\\...` or UNC executable token at
 * the start of the command is parsed by Bash before the executable starts, so
 * every backslash becomes an escape and the path collapses (for example
 * `C:\\Users` becomes `C:Users`).
 *
 * Direct-spawn `command` + `args` hooks do not cross this shell boundary and
 * quoted tokens are left alone. This is diagnostic-only; cleanup continues to
 * preserve external or otherwise ambiguous commands.
 */
export function detectHookCommandIncompatibility(
  hook,
  runtimePlatform = platform(),
) {
  if (
    runtimePlatform !== "win32" ||
    !hook ||
    typeof hook !== "object" ||
    typeof hook.command !== "string" ||
    Object.hasOwn(hook, "args")
  ) {
    return null;
  }
  const match = hook.command
    .trim()
    .match(/^((?:[A-Za-z]:\\|\\\\)[^\s"';&|]+)/u);
  if (!match) return null;
  return {
    code: "windows_shell_backslash_path",
    path: match[1],
    reason:
      `Native Windows Claude Code runs shell-form hooks through Git Bash, ` +
      `where the unquoted backslashes in ${match[1]} are consumed as escapes. ` +
      "Regenerate the hook with forward slashes or use direct-spawn command + args.",
  };
}

/**
 * Rewrite a Windows shell-form hook that Git Bash would mangle into the
 * direct-spawn `command` + `args` form. Direct-spawn hooks bypass Bash, so the
 * backslashes in the executable path survive verbatim instead of being parsed
 * as escapes. Pure transform only: it never writes files, and it acts solely
 * on graphify-injected commands (the ones Meta_Kim's own install flow emits),
 * leaving unrelated user hooks untouched for explicit review.
 *
 * Returns the rewritten hook object, or null when the hook is not a graphify
 * Windows shell-form command that needs rewriting.
 */
export function rewriteHookToDirectSpawn(
  hook,
  runtimePlatform = platform(),
  graphifyExecutable = null,
) {
  if (
    runtimePlatform !== "win32" ||
    !hook ||
    typeof hook !== "object" ||
    typeof hook.command !== "string"
  ) {
    return null;
  }
  const parsed = parseGraphifyHookCommand(hook);
  if (!parsed) return null;
  const executable = graphifyExecutable ?? parsed.executable;
  if (!isAbsoluteGraphifyExecutable(executable)) return null;
  const args = ["hook-guard", parsed.action, ...(parsed.strict ? ["--strict"] : [])];
  if (
    parsed.form === "exec" &&
    hook.command === executable &&
    hook.args.length === args.length &&
    hook.args.every((arg, index) => arg === args[index])
  ) return null;
  const { command: _command, args: _args, ...metadata } = hook;
  return {
    ...metadata,
    type: hook.type ?? "command",
    command: executable,
    args,
  };
}

export function settingsProjectRoot(settingsPath) {
  const settingsDir = path.dirname(path.resolve(settingsPath));
  return path.basename(settingsDir).toLowerCase() === ".claude"
    ? path.dirname(settingsDir)
    : settingsDir;
}

export function resolveHookTargetPath(target, settingsPath) {
  if (!target) return null;
  const expanded = target === "~"
    ? homedir()
    : target.startsWith("~/") || target.startsWith("~\\")
      ? path.join(homedir(), target.slice(2))
      : target;
  if (platform() === "win32" && path.posix.isAbsolute(expanded)) {
    const explicitWslDrivePath = /^\/mnt\/[A-Za-z](?:[\\/]|$)/u.test(expanded);
    if (!explicitWslDrivePath) return null;
  }
  if (
    path.isAbsolute(expanded) ||
    path.win32.isAbsolute(expanded) ||
    path.posix.isAbsolute(expanded)
  ) {
    return path.normalize(expanded);
  }
  return path.resolve(settingsProjectRoot(settingsPath), expanded);
}

function nearestPackageType(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    const packagePath = path.join(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const parsed = JSON.parse(readFileSync(packagePath, "utf8"));
        return { type: parsed?.type ?? null, path: packagePath };
      } catch {
        return { type: null, path: packagePath };
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return { type: null, path: null };
    current = parent;
  }
}

export function detectHookRuntimeIncompatibility(targetPath) {
  if (!targetPath || path.extname(targetPath).toLowerCase() !== ".js") return null;
  const packageScope = nearestPackageType(path.dirname(targetPath));
  if (packageScope.type !== "module") return null;
  let source;
  try {
    source = readFileSync(targetPath, "utf8");
  } catch {
    return null;
  }
  const commonJsLine = source.split(/\r?\n/u).find((line) =>
    /^\s*(?:(?:const|let|var)\s+[^=]+?=\s*)?require\s*\(/u.test(line) ||
    /^\s*(?:module\.exports|exports(?:\.[A-Za-z_$][\w$]*)?)\s*=/u.test(line)
  );
  if (!commonJsLine) return null;
  return {
    code: "esm_commonjs_mismatch",
    reason:
      `.js runs as ESM because ${packageScope.path} declares type=module, ` +
      "but the hook contains CommonJS require/module.exports. Convert it to ESM or rename it to .cjs and update settings.json.",
    packagePath: packageScope.path,
  };
}

export function scanSettingsFile(settingsPath) {
  if (!existsSync(settingsPath)) {
    return { ok: false, reason: "missing" };
  }
  let raw;
  try {
    raw = readFileSync(settingsPath, "utf8");
  } catch (e) {
    return { ok: false, reason: "read-failed", error: e };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: "parse-failed", error: e };
  }
  const hooks = parsed.hooks || {};
  const zombies = [];
  const incompatible = [];
  const unverified = [];
  const live = [];
  for (const [event, blocks] of Object.entries(hooks)) {
    for (const block of blocks || []) {
      for (const hook of block.hooks || []) {
        const graphify = parseGraphifyHookCommand(hook);
        const commandIssue = detectHookCommandIncompatibility(hook);
        const rawTarget = extractHookTargetPath(hook);
        const target = resolveHookTargetPath(rawTarget, settingsPath);
        const exists = target ? existsSync(target) : true;
        const entry = {
          event,
          matcher: block.matcher,
          path: target ?? commandIssue?.path ?? null,
          rawPath: rawTarget,
          command: hook.command,
        };
        if (graphify && !exists) {
          incompatible.push({
            ...entry,
            code: "missing_graphify_executable",
            reason:
              `The recognized Graphify executable no longer exists at ${target}. ` +
              "Run Meta_Kim setup/update to relocate this hook; doctor preserves it until a verified replacement is available.",
          });
          continue;
        }
        if (commandIssue) {
          incompatible.push({ ...entry, ...commandIssue });
          continue;
        }
        if (!rawTarget || !target) {
          unverified.push(entry);
          continue;
        }
        if (!exists) {
          zombies.push(entry);
          continue;
        }
        const runtimeIssue = detectHookRuntimeIncompatibility(target);
        if (runtimeIssue) {
          incompatible.push({ ...entry, ...runtimeIssue });
          continue;
        }
        live.push(entry);
      }
    }
  }
  return { ok: true, settings: parsed, zombies, incompatible, unverified, live };
}

export function removeZombies(settings, settingsPath) {
  const hooks = settings.hooks || {};
  const next = {};
  let removed = 0;
  for (const [event, blocks] of Object.entries(hooks)) {
    const keptBlocks = (blocks || [])
      .map((block) => {
        const keptHooks = (block.hooks || []).filter((hook) => {
          if (parseGraphifyHookCommand(hook)) return true;
          const target = resolveHookTargetPath(
            extractHookTargetPath(hook),
            settingsPath,
          );
          if (!target) return true;
          if (existsSync(target)) return true;
          removed += 1;
          return false;
        });
        return { ...block, hooks: keptHooks };
      })
      .filter((block) => (block.hooks || []).length > 0);
    if (keptBlocks.length > 0) {
      next[event] = keptBlocks;
    }
  }
  return { settings: { ...settings, hooks: next }, removed };
}

function iso() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function backupPath(settingsPath) {
  return `${settingsPath}.backup-${iso()}`;
}

export function findProjectSettings(projectRoot = process.cwd()) {
  const projSettings = path.join(path.resolve(projectRoot), ".claude", "settings.json");
  return existsSync(projSettings) ? projSettings : null;
}

export function projectRootFromArgs(args, cwd = process.cwd()) {
  const index = args.indexOf("--project-root");
  if (index < 0) return path.resolve(cwd);
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--project-root requires a path");
  }
  return path.resolve(cwd, value);
}

async function main() {
  const args = process.argv.slice(2);
  const fixMode = args.includes("--fix");
  const allMode = args.includes("--all");
  const explicitProjectRoot = args.includes("--project-root");
  const projectOnly = args.includes("--project") || (explicitProjectRoot && !allMode);
  const silent = args.includes("--silent");
  const projectRoot = projectRootFromArgs(
    args,
    process.env.META_KIM_CALLER_CWD || process.cwd(),
  );
  const langIdx = args.indexOf("--lang");
  const langArg = langIdx >= 0 ? args[langIdx + 1] : null;
  const lang = resolveLang(langArg);
  const t = MESSAGES[lang] || MESSAGES.en;

  const userSettings = path.join(homedir(), ".claude", "settings.json");
  const projectSettings = findProjectSettings(projectRoot);
  const targets = [];
  if (!projectOnly) targets.push({ path: userSettings, label: "user" });
  if ((allMode || projectOnly) && projectSettings) {
    targets.push({ path: projectSettings, label: "project" });
  }

  if (!silent) {
    console.log(`${C.bold}${C.cyan}${t.title}${C.reset}`);
    if (!langArg) {
      console.log(`${C.dim}${t.langAutoDetected(lang)}${C.reset}`);
    }
  }

  let totalIssues = 0;
  const graphifySanitizer = fixMode
    ? await import("./graphify-hook-sanitize.mjs")
    : null;
  for (const target of targets) {
    if (!silent) {
      console.log(`\n${C.bold}${t.scanning(target.path)}${C.reset}`);
    }
    let result = scanSettingsFile(target.path);
    if (!result.ok) {
      if (result.reason === "missing") {
        if (!silent)
          console.log(`${C.dim}  ${t.notFound(target.path)}${C.reset}`);
        continue;
      }
      if (result.reason === "parse-failed") {
        console.error(
          `${C.red}  ${t.parseFailed(target.path, result.error?.message ?? "")}${C.reset}`,
        );
        process.exitCode = 1;
        continue;
      }
      continue;
    }
    if (graphifySanitizer) {
      const repaired = graphifySanitizer.sanitizeGraphifyWindowsHooks(target.path);
      if (repaired.changed) {
        if (!silent) {
          console.log(
            `${C.green}  ${t.graphifyRepaired(repaired.count, repaired.backup)}${C.reset}`,
          );
        }
        result = scanSettingsFile(target.path);
        if (!result.ok) {
          throw new Error(`Graphify hook repair could not be verified for ${target.path}`);
        }
      }
    }
    const { zombies, incompatible, unverified, live, settings } = result;
    if (zombies.length === 0 && incompatible.length === 0 && unverified.length === 0 && live.length === 0) {
      if (!silent) console.log(`${C.dim}  ${t.noHooks(target.path)}${C.reset}`);
      continue;
    }
    if (zombies.length === 0 && incompatible.length === 0) {
      if (!silent) {
        console.log(`${C.green}  ✓ ${t.summaryClean}${C.reset}`);
        console.log(`${C.dim}  ${t.liveHeader(live.length)}${C.reset}`);
        for (const l of live) {
          console.log(
            `${C.dim}${t.zombieItem(l.event, l.matcher, l.path)}${C.reset}`,
          );
        }
        if (unverified.length > 0) {
          console.log(`${C.yellow}  ? ${t.unverifiedHeader(unverified.length)}${C.reset}`);
          for (const item of unverified) {
            console.log(`${C.yellow}${t.unverifiedItem(item.event, item.matcher, item.command)}${C.reset}`);
          }
        }
      }
      continue;
    }
    totalIssues += zombies.length + incompatible.length;
    if (!silent) {
      if (zombies.length > 0) {
        console.log(`${C.yellow}  ⚠ ${t.zombieHeader(zombies.length)}${C.reset}`);
        for (const z of zombies) {
          console.log(
            `${C.yellow}${t.zombieItem(z.event, z.matcher, z.path)}${C.reset}`,
          );
        }
      }
      if (incompatible.length > 0) {
        console.log(`${C.red}  ⚠ ${t.incompatibleHeader(incompatible.length)}${C.reset}`);
        for (const item of incompatible) {
          console.log(
            `${C.red}${t.incompatibleItem(item.event, item.matcher, item.path, item.reason)}${C.reset}`,
          );
        }
        console.log(`${C.dim}${t.incompatibleHint}${C.reset}`);
      }
      if (unverified.length > 0) {
        console.log(`${C.yellow}  ? ${t.unverifiedHeader(unverified.length)}${C.reset}`);
        for (const item of unverified) {
          console.log(
            `${C.yellow}${t.unverifiedItem(item.event, item.matcher, item.command)}${C.reset}`,
          );
        }
      }
      console.log(`${C.dim}  ${t.liveHeader(live.length)}${C.reset}`);
      for (const l of live) {
        console.log(
          `${C.dim}${t.zombieItem(l.event, l.matcher, l.path)}${C.reset}`,
        );
      }
    }

    if (!fixMode) {
      if (!silent && zombies.length > 0) console.log(`\n${C.bold}${t.dryRunHint}${C.reset}`);
      continue;
    }

    if (zombies.length === 0) continue;

    const backup = backupPath(target.path);
    writeFileSync(backup, JSON.stringify(settings, null, 2));
    if (!silent)
      console.log(`${C.green}  ${t.backupWritten(backup)}${C.reset}`);

    const { settings: cleaned, removed } = removeZombies(settings, target.path);
    writeFileSync(target.path, `${JSON.stringify(cleaned, null, 2)}\n`);
    if (!silent) {
      console.log(`${C.green}  ${t.removedCount(removed)}${C.reset}`);
      console.log(`${C.green}  ${t.settingsSaved(target.path)}${C.reset}`);
      console.log(`${C.dim}  ${t.finalStructure}${C.reset}`);
      for (const [ev, blocks] of Object.entries(cleaned.hooks || {})) {
        const n = blocks.reduce((acc, b) => acc + (b.hooks || []).length, 0);
        console.log(`${C.dim}    ${ev}: ${n}${C.reset}`);
      }
    }
  }

  if (silent) {
    process.exit(totalIssues > 0 ? 1 : 0);
  }
}

const isMain = process.argv[1] && (
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
);
if (isMain) {
  main().catch((err) => {
    console.error(
      `${C.red}doctor-hooks failed: ${err?.message ?? err}${C.reset}`,
    );
    process.exit(1);
  });
}
