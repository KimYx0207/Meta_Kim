#!/usr/bin/env node
/**
 * Meta_Kim hook doctor — scan settings.json files for hook commands whose
 * target files no longer exist (zombies from machine-to-machine copies,
 * renamed hooks, uninstalled tools, etc.).
 *
 * Usage:
 *   node scripts/doctor-hooks.mjs              # scan ~/.claude/settings.json (dry-run)
 *   node scripts/doctor-hooks.mjs --fix        # remove zombies + write back (auto backup)
 *   node scripts/doctor-hooks.mjs --all        # also scan <repo>/.claude/settings.json
 *   node scripts/doctor-hooks.mjs --project    # scan ONLY <repo>/.claude/settings.json
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
    liveHeader: (n) => `Healthy hook(s) (${n}):`,
    zombieItem: (e, m, p) => `  [${e} / ${m}]  ${p}`,
    summaryClean: "All hooks point to existing files.",
    dryRunHint:
      "Dry-run only. Re-run with --fix to back up & remove the zombie entries.",
    backupWritten: (p) => `Backup written: ${p}`,
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
    liveHeader: (n) => `健康的 hook（${n}）：`,
    zombieItem: (e, m, p) => `  [${e} / ${m}]  ${p}`,
    summaryClean: "所有 hook 的目标文件都存在，无需清理。",
    dryRunHint: "当前仅为扫描模式。加 --fix 参数可自动备份并清除僵尸条目。",
    backupWritten: (p) => `已备份：${p}`,
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
    liveHeader: (n) => `正常な hook（${n}）：`,
    zombieItem: (e, m, p) => `  [${e} / ${m}]  ${p}`,
    summaryClean: "すべての hook ターゲットが存在します。",
    dryRunHint:
      "ドライラン。--fix を付けるとバックアップしてからゾンビを削除します。",
    backupWritten: (p) => `バックアップ作成：${p}`,
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
    liveHeader: (n) => `정상 hook (${n}):`,
    zombieItem: (e, m, p) => `  [${e} / ${m}]  ${p}`,
    summaryClean: "모든 hook 대상 파일이 존재합니다.",
    dryRunHint: "드라이런 모드. --fix 옵션으로 백업 후 좀비 항목을 제거합니다.",
    backupWritten: (p) => `백업 완료: ${p}`,
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

function extractCommandPath(command) {
  if (typeof command !== "string") return null;
  const quoted = command.match(/"([^"]+)"/);
  if (quoted) return quoted[1];
  const tokens = command.trim().split(/\s+/);
  for (let i = 1; i < tokens.length; i += 1) {
    if (
      /[\\/]/.test(tokens[i]) ||
      tokens[i].endsWith(".mjs") ||
      tokens[i].endsWith(".js") ||
      tokens[i].endsWith(".py") ||
      tokens[i].endsWith(".sh")
    ) {
      return tokens[i];
    }
  }
  return null;
}

function scanSettingsFile(settingsPath) {
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
  const live = [];
  for (const [event, blocks] of Object.entries(hooks)) {
    for (const block of blocks || []) {
      for (const hook of block.hooks || []) {
        const target = extractCommandPath(hook.command || "");
        const exists = target ? existsSync(target) : true;
        const entry = {
          event,
          matcher: block.matcher,
          path: target,
          command: hook.command,
        };
        (exists ? live : zombies).push(entry);
      }
    }
  }
  return { ok: true, settings: parsed, zombies, live };
}

function removeZombies(settings) {
  const hooks = settings.hooks || {};
  const next = {};
  let removed = 0;
  for (const [event, blocks] of Object.entries(hooks)) {
    const keptBlocks = (blocks || [])
      .map((block) => {
        const keptHooks = (block.hooks || []).filter((hook) => {
          const target = extractCommandPath(hook.command || "");
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

function findProjectSettings() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(__dirname, "..");
  const projSettings = path.join(repoRoot, ".claude", "settings.json");
  return existsSync(projSettings) ? projSettings : null;
}

async function main() {
  const args = process.argv.slice(2);
  const fixMode = args.includes("--fix");
  const allMode = args.includes("--all");
  const projectOnly = args.includes("--project");
  const silent = args.includes("--silent");
  const langIdx = args.indexOf("--lang");
  const langArg = langIdx >= 0 ? args[langIdx + 1] : null;
  const lang = resolveLang(langArg);
  const t = MESSAGES[lang] || MESSAGES.en;

  const userSettings = path.join(homedir(), ".claude", "settings.json");
  const projectSettings = findProjectSettings();
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

  let totalZombies = 0;
  for (const target of targets) {
    if (!silent) {
      console.log(`\n${C.bold}${t.scanning(target.path)}${C.reset}`);
    }
    const result = scanSettingsFile(target.path);
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
    const { zombies, live, settings } = result;
    if (zombies.length === 0 && live.length === 0) {
      if (!silent) console.log(`${C.dim}  ${t.noHooks(target.path)}${C.reset}`);
      continue;
    }
    if (zombies.length === 0) {
      if (!silent) {
        console.log(`${C.green}  ✓ ${t.summaryClean}${C.reset}`);
        console.log(`${C.dim}  ${t.liveHeader(live.length)}${C.reset}`);
        for (const l of live) {
          console.log(
            `${C.dim}${t.zombieItem(l.event, l.matcher, l.path)}${C.reset}`,
          );
        }
      }
      continue;
    }
    totalZombies += zombies.length;
    if (!silent) {
      console.log(`${C.yellow}  ⚠ ${t.zombieHeader(zombies.length)}${C.reset}`);
      for (const z of zombies) {
        console.log(
          `${C.yellow}${t.zombieItem(z.event, z.matcher, z.path)}${C.reset}`,
        );
      }
      console.log(`${C.dim}  ${t.liveHeader(live.length)}${C.reset}`);
      for (const l of live) {
        console.log(
          `${C.dim}${t.zombieItem(l.event, l.matcher, l.path)}${C.reset}`,
        );
      }
    }

    if (!fixMode) {
      if (!silent) console.log(`\n${C.bold}${t.dryRunHint}${C.reset}`);
      continue;
    }

    const backup = backupPath(target.path);
    writeFileSync(backup, JSON.stringify(settings, null, 2));
    if (!silent)
      console.log(`${C.green}  ${t.backupWritten(backup)}${C.reset}`);

    const { settings: cleaned, removed } = removeZombies(settings);
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
    process.exit(totalZombies > 0 ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(
    `${C.red}doctor-hooks failed: ${err?.message ?? err}${C.reset}`,
  );
  process.exit(1);
});
