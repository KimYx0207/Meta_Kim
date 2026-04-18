#!/usr/bin/env node
/**
 * Meta_Kim uninstaller — reverses what sync-runtimes / sync-global-meta-theory
 * / setup.mjs have written. Dry-run by default; `--yes` actually deletes.
 *
 * Categories handled (A..I from footprint.mjs):
 *   A. Global runtime skills         → remove directory
 *   B. Global hooks                  → remove directory
 *   C. Global settings.json merges   → back up + strip managed hook entries
 *   D. Project runtime skills        → remove directory
 *   E. Project runtime hooks         → remove file
 *   F. Project runtime agents        → (kept by default — owned by the repo
 *                                       itself; pass --purge-project-agents)
 *   G. Project settings / MCP        → back up + strip managed hooks
 *   H. Project local state           → remove directory (.meta-kim/)
 *   I. Shared deps (pip, git hooks)  → only when --deep is passed
 *
 * Usage:
 *   node scripts/uninstall.mjs                       # dry-run
 *   node scripts/uninstall.mjs --yes                 # actually delete
 *   node scripts/uninstall.mjs --scope=global --yes  # global-only cleanup
 *   node scripts/uninstall.mjs --deep --yes          # also pip + git hooks
 *   node scripts/uninstall.mjs --lang zh             # en/zh/ja/ko
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { collectFindings } from "./footprint.mjs";
import {
  CATEGORIES,
  manifestPathFor,
  readManifest,
} from "./install-manifest.mjs";

/**
 * Convert an install-manifest entry into the same shape as a scan finding so
 * planActions() can consume either source uniformly. Returns null for entries
 * the current uninstall pipeline cannot act on (pip-package, mcp-server,
 * git-hook — those need dedicated actions the pipeline does not model yet).
 */
export function manifestEntryToFinding(entry) {
  if (!entry?.path || !entry?.category) return null;
  if (
    entry.kind === "pip-package" ||
    entry.kind === "mcp-server" ||
    entry.kind === "git-hook"
  ) {
    return null;
  }
  const base = {
    path: entry.path,
    category: entry.category,
    source: entry.source || "manifest",
    purpose: entry.purpose || null,
  };
  if (entry.kind === "settings-merge") {
    const commands = entry.mergedHookCommands || [];
    return {
      ...base,
      kind: "settings-merge",
      managedHookCount: commands.length,
      managedHooks: commands.map((command) => ({
        event: null,
        matcher: null,
        command,
      })),
    };
  }
  return {
    ...base,
    kind: entry.kind === "dir" ? "dir" : "file",
    size: entry.size ?? null,
    mtime: null,
  };
}

/**
 * Collect findings from install manifests (global + project) for the given
 * scope. Returns an empty array when no manifest exists or all entries are
 * non-actionable — callers should then fall back to collectFindings().
 */
export function findingsFromManifest({ scope, repoRoot }) {
  const findings = [];
  if (scope === "global" || scope === "both") {
    try {
      const m = readManifest(manifestPathFor("global"));
      if (m?.entries) {
        for (const entry of m.entries) {
          const finding = manifestEntryToFinding(entry);
          if (finding) findings.push(finding);
        }
      }
    } catch {
      /* best-effort: manifest read failures fall through to scan */
    }
  }
  if (scope === "project" || scope === "both") {
    try {
      const m = readManifest(manifestPathFor("project", repoRoot));
      if (m?.entries) {
        for (const entry of m.entries) {
          const finding = manifestEntryToFinding(entry);
          if (finding) findings.push(finding);
        }
      }
    } catch {
      /* best-effort: manifest read failures fall through to scan */
    }
  }
  return findings;
}

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

const MSG = {
  en: {
    title: "Meta_Kim uninstall",
    dryNote: "DRY-RUN — nothing will be deleted. Re-run with --yes to apply.",
    liveNote: "LIVE RUN — changes will be applied now.",
    sourceManifest:
      "Source: install-manifest (recorded entries from prior sync runs).",
    sourceScan:
      "Source: filesystem scan (no manifest found, or --no-manifest was passed).",
    planHeader: "Planned actions:",
    actRemoveDir: (p) => `  − remove directory: ${p}`,
    actRemoveFile: (p) => `  − remove file: ${p}`,
    actStripSettings: (p, n) =>
      `  ~ strip ${n} Meta_Kim hook entr${n === 1 ? "y" : "ies"} from: ${p}`,
    actBackup: (p) => `  ↳ backup → ${p}`,
    actPipUninstall: (pkg) => `  − pip uninstall ${pkg}  (--deep only)`,
    actGitHook: (p) => `  − remove shared git hook: ${p}  (--deep only)`,
    summary: (n) => `${n} action(s) planned.`,
    summaryNone: "Nothing to do — system is clean.",
    done: "Done.",
    doneDelta: (del, strip) =>
      `Done: ${del} path(s) removed, ${strip} settings entr${strip === 1 ? "y" : "ies"} stripped.`,
    projectAgentsKept:
      "Project runtime agents (.claude/agents, .codex/agents, .cursor/agents) are kept by default — pass --purge-project-agents to also remove them.",
    deepOff:
      "Shared dependencies (pip packages, .git/hooks) are NOT touched unless --deep is passed.",
    backupDone: (p) => `Backup written: ${p}`,
    settingsParseFailed: (p) => `Cannot parse ${p} — leaving it untouched.`,
    confirmNeeded: "Refusing to delete without --yes. Exiting.",
  },
  "zh-CN": {
    title: "Meta_Kim 卸载",
    dryNote: "DRY-RUN 模式 — 不会真删。加 --yes 后才执行。",
    liveNote: "LIVE 模式 — 现在开始执行实际删除。",
    sourceManifest: "来源：install-manifest（历次 sync 记录的条目）。",
    sourceScan:
      "来源：文件系统扫描（未找到 manifest，或传入了 --no-manifest）。",
    planHeader: "计划执行的操作：",
    actRemoveDir: (p) => `  − 删除目录：${p}`,
    actRemoveFile: (p) => `  − 删除文件：${p}`,
    actStripSettings: (p, n) => `  ~ 从 ${p} 移除 ${n} 条 Meta_Kim hook 条目`,
    actBackup: (p) => `  ↳ 备份 → ${p}`,
    actPipUninstall: (pkg) => `  − pip 卸载 ${pkg}（仅 --deep 时）`,
    actGitHook: (p) => `  − 删除共享 git hook：${p}（仅 --deep 时）`,
    summary: (n) => `共 ${n} 项待执行操作。`,
    summaryNone: "无事可做，系统已是干净状态。",
    done: "完成。",
    doneDelta: (del, strip) =>
      `完成：删除 ${del} 个路径，清理 ${strip} 条 settings 条目。`,
    projectAgentsKept:
      "项目级 runtime agents（.claude/agents、.codex/agents、.cursor/agents）默认保留。加 --purge-project-agents 才一起删。",
    deepOff:
      "共享依赖（pip 包、.git/hooks）默认不动。如需一并清理请加 --deep。",
    backupDone: (p) => `已备份：${p}`,
    settingsParseFailed: (p) => `无法解析 ${p}，跳过该文件。`,
    confirmNeeded: "未加 --yes，拒绝执行删除。退出。",
  },
  "ja-JP": {
    title: "Meta_Kim アンインストール",
    dryNote: "DRY-RUN — 削除しません。--yes で実行します。",
    liveNote: "LIVE 実行 — 変更を即時適用します。",
    sourceManifest:
      "ソース：install-manifest（過去の sync で記録されたエントリ）。",
    sourceScan:
      "ソース：ファイルシステムスキャン（manifest なし、または --no-manifest 指定）。",
    planHeader: "実行予定の操作：",
    actRemoveDir: (p) => `  − ディレクトリ削除：${p}`,
    actRemoveFile: (p) => `  − ファイル削除：${p}`,
    actStripSettings: (p, n) =>
      `  ~ ${p} から Meta_Kim 管理 hook を ${n} 件削除`,
    actBackup: (p) => `  ↳ バックアップ → ${p}`,
    actPipUninstall: (pkg) => `  − pip uninstall ${pkg}（--deep のみ）`,
    actGitHook: (p) => `  − 共有 git hook 削除：${p}（--deep のみ）`,
    summary: (n) => `計 ${n} 件の操作を予定。`,
    summaryNone: "何もする必要がありません。クリーンな状態です。",
    done: "完了。",
    doneDelta: (del, strip) =>
      `完了：${del} パス削除、${strip} 件の settings エントリ除去。`,
    projectAgentsKept:
      "プロジェクト ランタイム agents はデフォルトで保持。--purge-project-agents で削除可。",
    deepOff: "共有依存（pip パッケージ、.git/hooks）は --deep 時のみ削除。",
    backupDone: (p) => `バックアップ作成：${p}`,
    settingsParseFailed: (p) => `${p} を解析できません、スキップ。`,
    confirmNeeded: "--yes なし、削除を拒否して終了。",
  },
  "ko-KR": {
    title: "Meta_Kim 제거",
    dryNote: "DRY-RUN — 실제 삭제 안 함. --yes 로 재실행하면 적용.",
    liveNote: "LIVE 모드 — 변경이 즉시 적용됩니다.",
    sourceManifest: "소스: install-manifest (이전 sync에 기록된 항목).",
    sourceScan:
      "소스: 파일시스템 스캔 (manifest 없음 또는 --no-manifest 지정).",
    planHeader: "실행 예정 작업:",
    actRemoveDir: (p) => `  − 디렉터리 삭제: ${p}`,
    actRemoveFile: (p) => `  − 파일 삭제: ${p}`,
    actStripSettings: (p, n) => `  ~ ${p} 에서 Meta_Kim hook 항목 ${n} 건 제거`,
    actBackup: (p) => `  ↳ 백업 → ${p}`,
    actPipUninstall: (pkg) => `  − pip uninstall ${pkg} (--deep 전용)`,
    actGitHook: (p) => `  − 공유 git hook 제거: ${p} (--deep 전용)`,
    summary: (n) => `총 ${n} 건 작업 예정.`,
    summaryNone: "할 일 없음, 이미 깨끗한 상태.",
    done: "완료.",
    doneDelta: (del, strip) =>
      `완료: 경로 ${del} 건 제거, settings 항목 ${strip} 건 제거.`,
    projectAgentsKept:
      "프로젝트 runtime agents 는 기본 보존. --purge-project-agents 로 함께 삭제.",
    deepOff: "공유 의존성(pip 패키지, .git/hooks)은 --deep 시에만 삭제.",
    backupDone: (p) => `백업 완료: ${p}`,
    settingsParseFailed: (p) => `${p} 파싱 실패, 건너뜀.`,
    confirmNeeded: "--yes 없음, 삭제 거부. 종료.",
  },
};

function resolveLang(cliLang) {
  const pick = (value) => {
    if (!value) return null;
    const v = String(value).toLowerCase();
    if (v.startsWith("zh")) return "zh-CN";
    if (v.startsWith("ja")) return "ja-JP";
    if (v.startsWith("ko")) return "ko-KR";
    if (v.startsWith("en")) return "en";
    return null;
  };
  return (
    pick(cliLang) ||
    pick(process.env.METAKIM_LANG) ||
    pick(process.env.LC_ALL) ||
    pick(process.env.LC_MESSAGES) ||
    pick(process.env.LANG) ||
    "en"
  );
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function iso() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function normalizeHookCommand(command) {
  return String(command ?? "").replace(/\\\\/g, "\\");
}

function isManagedGlobalCommand(command) {
  const n = normalizeHookCommand(command);
  return n.includes("hooks/meta-kim/") || n.includes("hooks\\meta-kim\\");
}

const REPO_HOOK_FILES = new Set([
  "block-dangerous-bash.mjs",
  "pre-git-push-confirm.mjs",
  "post-format.mjs",
  "post-typecheck.mjs",
  "post-console-log-warn.mjs",
  "subagent-context.mjs",
  "stop-compaction.mjs",
  "stop-console-log-audit.mjs",
  "stop-completion-guard.mjs",
]);

function isManagedRepoCommand(command) {
  const n = normalizeHookCommand(command).replace(/\\/g, "/");
  if (!n.includes("/.claude/hooks/")) return false;
  return [...REPO_HOOK_FILES].some((f) => n.endsWith(f));
}

function stripManagedHookBlocks(hooksSection, predicate) {
  if (!hooksSection || typeof hooksSection !== "object") {
    return { hooks: {}, stripped: 0 };
  }
  let stripped = 0;
  const next = {};
  for (const [event, blocks] of Object.entries(hooksSection)) {
    const kept = [];
    for (const block of blocks ?? []) {
      const filtered = (block.hooks ?? []).filter((h) => {
        const hit = predicate(h.command ?? "");
        if (hit) stripped += 1;
        return !hit;
      });
      if (filtered.length > 0) {
        kept.push({ ...block, hooks: filtered });
      }
    }
    if (kept.length > 0) next[event] = kept;
  }
  return { hooks: next, stripped };
}

function planActions({
  scope,
  repoRoot,
  deep,
  purgeProjectAgents,
  useManifest = true,
}) {
  let findings = [];
  let source = "scan";
  if (useManifest) {
    findings = findingsFromManifest({ scope, repoRoot });
    if (findings.length > 0) source = "manifest";
  }
  if (findings.length === 0) {
    findings = collectFindings({ scope, repoRoot });
  }
  const actions = [];

  for (const f of findings) {
    switch (f.category) {
      case CATEGORIES.A: {
        actions.push({
          kind: "remove",
          path: f.path,
          catLabel: "A",
          recursive: f.kind === "dir",
        });
        break;
      }
      case CATEGORIES.B: {
        if (
          f.path.endsWith(path.sep + "meta-kim") ||
          f.path.endsWith("/meta-kim")
        ) {
          actions.push({
            kind: "remove",
            path: f.path,
            catLabel: "B",
            recursive: true,
          });
        }
        break;
      }
      case CATEGORIES.C: {
        actions.push({
          kind: "strip-settings",
          path: f.path,
          catLabel: "C",
          predicate: isManagedGlobalCommand,
          expectedCount: f.managedHookCount ?? 0,
        });
        break;
      }
      case CATEGORIES.D: {
        actions.push({
          kind: "remove",
          path: f.path,
          catLabel: "D",
          recursive: f.kind === "dir",
        });
        break;
      }
      case CATEGORIES.E: {
        actions.push({
          kind: "remove",
          path: f.path,
          catLabel: "E",
          recursive: f.kind === "dir",
        });
        break;
      }
      case CATEGORIES.F: {
        if (purgeProjectAgents) {
          actions.push({
            kind: "remove",
            path: f.path,
            catLabel: "F",
            recursive: f.kind === "dir",
          });
        }
        break;
      }
      case CATEGORIES.G: {
        if (f.kind === "settings-merge") {
          actions.push({
            kind: "strip-settings",
            path: f.path,
            catLabel: "G",
            predicate: isManagedRepoCommand,
            expectedCount: f.managedHookCount ?? 0,
          });
        } else {
          actions.push({
            kind: "remove",
            path: f.path,
            catLabel: "G",
            recursive: f.kind === "dir",
          });
        }
        break;
      }
      case CATEGORIES.H: {
        actions.push({
          kind: "remove",
          path: f.path,
          catLabel: "H",
          recursive: f.kind === "dir",
        });
        break;
      }
      case CATEGORIES.I: {
        if (deep) {
          actions.push({
            kind: "remove",
            path: f.path,
            catLabel: "I",
            recursive: f.kind === "dir",
          });
        }
        break;
      }
      default:
        break;
    }
  }

  const seen = new Set();
  const deduped = actions.filter((a) => {
    const key = `${a.kind}::${a.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { actions: deduped, source };
}

function describe(action, t) {
  switch (action.kind) {
    case "remove":
      return action.recursive
        ? t.actRemoveDir(action.path)
        : t.actRemoveFile(action.path);
    case "strip-settings":
      return t.actStripSettings(action.path, action.expectedCount);
    case "pip-uninstall":
      return t.actPipUninstall(action.package);
    default:
      return `  ? ${action.kind} ${action.path ?? ""}`;
  }
}

function backupSettings(settingsPath) {
  const raw = readFileSync(settingsPath, "utf8");
  const target = `${settingsPath}.backup-${iso()}`;
  writeFileSync(target, raw);
  return target;
}

function applyStripSettings(action, t) {
  const raw = readFileSync(action.path, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`${C.yellow}${t.settingsParseFailed(action.path)}${C.reset}`);
    return { success: false, stripped: 0 };
  }
  const backupPath = backupSettings(action.path);
  const { hooks, stripped } = stripManagedHookBlocks(
    parsed.hooks ?? {},
    action.predicate,
  );
  parsed.hooks = hooks;
  writeFileSync(action.path, `${JSON.stringify(parsed, null, 2)}\n`);
  return { success: true, stripped, backupPath };
}

function applyRemove(action) {
  try {
    rmSync(action.path, { recursive: action.recursive === true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(`--${name}`);
  const valueOf = (name) => {
    const eq = args.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 ? (args[idx + 1] ?? null) : null;
  };

  const rawScope = valueOf("scope") || "both";
  const scope = ["global", "project", "both"].includes(rawScope)
    ? rawScope
    : "both";
  const apply = flag("yes");
  const deep = flag("deep");
  const purgeProjectAgents = flag("purge-project-agents");
  const useManifest = !flag("no-manifest");
  const lang = resolveLang(valueOf("lang"));
  const t = MSG[lang] || MSG.en;

  const repoRoot = REPO_ROOT;

  const { actions, source } = planActions({
    scope,
    repoRoot,
    deep,
    purgeProjectAgents,
    useManifest,
  });

  const lines = [];
  lines.push(`${C.bold}${C.cyan}${t.title}${C.reset}`);
  lines.push(
    apply
      ? `${C.yellow}${t.liveNote}${C.reset}`
      : `${C.dim}${t.dryNote}${C.reset}`,
  );
  lines.push(
    `${C.dim}${source === "manifest" ? t.sourceManifest : t.sourceScan}${C.reset}`,
  );
  if (!purgeProjectAgents)
    lines.push(`${C.dim}${t.projectAgentsKept}${C.reset}`);
  if (!deep) lines.push(`${C.dim}${t.deepOff}${C.reset}`);

  if (actions.length === 0) {
    lines.push(`${C.green}${t.summaryNone}${C.reset}`);
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  lines.push("");
  lines.push(`${C.bold}${t.planHeader}${C.reset}`);
  for (const a of actions) lines.push(describe(a, t));
  lines.push("");
  lines.push(`${C.dim}${t.summary(actions.length)}${C.reset}`);
  process.stdout.write(`${lines.join("\n")}\n`);

  if (!apply) {
    process.stdout.write(`\n${C.yellow}${t.confirmNeeded}${C.reset}\n`);
    return;
  }

  let removedCount = 0;
  let strippedTotal = 0;
  for (const a of actions) {
    if (a.kind === "strip-settings") {
      if (!existsSync(a.path)) continue;
      const { success, stripped, backupPath } = applyStripSettings(a, t);
      if (success) {
        strippedTotal += stripped;
        console.log(
          `${C.green}✓ ${t.actStripSettings(a.path, stripped)}${C.reset}`,
        );
        if (backupPath)
          console.log(`${C.dim}${t.backupDone(backupPath)}${C.reset}`);
      }
    } else if (a.kind === "remove") {
      if (applyRemove(a)) removedCount += 1;
    }
  }
  process.stdout.write(
    `\n${C.green}${t.doneDelta(removedCount, strippedTotal)}${C.reset}\n`,
  );
}

if (process.argv[1]?.endsWith("uninstall.mjs")) {
  main().catch((err) => {
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  });
}
