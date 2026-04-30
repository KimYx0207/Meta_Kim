#!/usr/bin/env node
/**
 * Meta_Kim footprint scanner — shows everything Meta_Kim has written to the
 * current system, grouped by category A..I. Drives both `npm run meta:status`
 * (human-readable tree) and downstream tooling (uninstall.mjs, future CI).
 *
 * Data sources, in priority order:
 *   1. Install manifests (~/.meta-kim/install-manifest.json + repo-local).
 *   2. Hard-coded rule scan: well-known paths under every runtime home and
 *      inside the repository, plus ~/.claude/settings.json hook-block parsing.
 *
 * Usage:
 *   node scripts/footprint.mjs                 # tree (human)
 *   node scripts/footprint.mjs --json          # machine-readable
 *   node scripts/footprint.mjs --diff          # manifest vs filesystem drift
 *   node scripts/footprint.mjs --scope=global  # or project / both (default)
 *   node scripts/footprint.mjs --lang zh       # en/zh/ja/ko, auto by default
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  CATEGORY_LABELS,
  CATEGORIES,
  listByCategory,
  manifestPathFor,
  readManifest,
  safeStat,
} from "./install-manifest.mjs";
import {
  resolveRuntimeHomeInfo,
  supportedTargetIds,
} from "./meta-kim-sync-config.mjs";

// Intentionally NOT importing `isGlobalMetaKimManagedHookCommand` /
// `isRepoMetaKimHookCommand` from claude-settings-merge.mjs.
//
// Upstream only checks `includes("hooks/meta-kim/")` or
// `includes("hooks\\meta-kim\\")` — a single-backslash literal. But real-world
// settings.json files written by `hookCommandNode(absScriptPath)` go through
// `JSON.stringify(absPath)` once before becoming the `command` string, and
// then the whole settings object is `JSON.stringify`'d again on write, which
// double-escapes Windows paths. On disk they look like `...\\\\Users\\\\...`;
// after parse they're `...\\Users\\...` (two backslashes in the JS string),
// and the upstream single-backslash literal does not match.
//
// Phase 2 of the install-manifest work will fix `hookCommandNode` at the
// source and patch the matchers. Until then, footprint.mjs normalizes both
// single- and double-backslash cases locally so status output is accurate.
function matchesManagedHookCommand(command, marker) {
  if (typeof command !== "string") return false;
  const collapsed = command.replace(/\\\\/g, "\\");
  return (
    collapsed.includes(`${marker}/`) ||
    collapsed.includes(`${marker}\\`) ||
    command.includes(`${marker}/`) ||
    command.includes(`${marker}\\`)
  );
}

const GLOBAL_HOOK_MARKER = "hooks/meta-kim";
const REPO_HOOK_MARKER = ".claude/hooks";

function isGlobalMetaKimHookCommand(command) {
  return (
    matchesManagedHookCommand(command, GLOBAL_HOOK_MARKER) ||
    matchesManagedHookCommand(command, "hooks\\meta-kim")
  );
}
const REPO_HOOK_FILES = new Set([
  "block-dangerous-bash.mjs",
  "pre-git-push-confirm.mjs",
  "post-format.mjs",
  "post-typecheck.mjs",
  "post-console-log-warn.mjs",
  "subagent-context.mjs",
  "stop-compaction.mjs",
  "stop-memory-save.mjs",
  "stop-console-log-audit.mjs",
  "stop-completion-guard.mjs",
]);
function isRepoMetaKimHookCmd(command) {
  if (
    !matchesManagedHookCommand(command, REPO_HOOK_MARKER) &&
    !matchesManagedHookCommand(command, ".claude\\hooks")
  ) {
    return false;
  }
  const norm = String(command).replace(/\\\\/g, "\\").replace(/\\/g, "/");
  return [...REPO_HOOK_FILES].some(
    (f) => norm.endsWith(f) || norm.includes(`/hooks/${f}`),
  );
}

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  amber: "\x1b[38;2;160;120;60m",
};

const MSG = {
  en: {
    title: "Meta_Kim footprint",
    scope: (s) => `Scope: ${s}`,
    manifestFound: (p) => `Manifest: ${p}`,
    manifestMissing: "Manifest: (none — using filesystem scan)",
    manifestParseError: (p) =>
      `Manifest at ${p} is unreadable, falling back to scan`,
    categoryHeader: (k, label, n) => `${k}. ${label} (${n})`,
    empty: "(nothing found)",
    footerOk: "All clear.",
    footerFound: (n) => `Total entries: ${n}`,
    diffHeader: "Manifest vs filesystem drift",
    diffInManifestMissing: (p) =>
      `  − recorded in manifest but missing on disk: ${p}`,
    diffOnDiskUnrecorded: (p) => `  + exists on disk but not in manifest: ${p}`,
    diffClean: "No drift.",
    notes: "Notes",
    noteShared:
      "Shared deps (pip packages, .git/hooks) are informational only.",
    noteGlobal:
      "Global settings.json merge only lists hook entries Meta_Kim is known to manage.",
    noteUninstall:
      "To clean up, run: npm run meta:uninstall (dry-run) then npm run meta:uninstall:yes",
  },
  "zh-CN": {
    title: "Meta_Kim 安装足迹",
    scope: (s) => `范围：${s}`,
    manifestFound: (p) => `清单文件：${p}`,
    manifestMissing: "清单文件：（无 — 将退化为文件系统扫描）",
    manifestParseError: (p) => `清单 ${p} 无法读取，回退到扫描`,
    categoryHeader: (k, label, n) => `${k}. ${label}（${n}）`,
    empty: "（无）",
    footerOk: "当前环境干净。",
    footerFound: (n) => `总条目：${n}`,
    diffHeader: "清单 vs 文件系统 差异",
    diffInManifestMissing: (p) => `  − 清单记录有但磁盘已缺：${p}`,
    diffOnDiskUnrecorded: (p) => `  + 磁盘存在但清单未记录：${p}`,
    diffClean: "无差异。",
    notes: "说明",
    noteShared: "共享依赖（pip 包、.git/hooks）仅供参考。",
    noteGlobal: "全局 settings.json 合并只列出 Meta_Kim 管理的 hook 条目。",
    noteUninstall:
      "需清理时：先 npm run meta:uninstall（dry-run）再 npm run meta:uninstall:yes",
  },
  "ja-JP": {
    title: "Meta_Kim インストール足跡",
    scope: (s) => `スコープ：${s}`,
    manifestFound: (p) => `マニフェスト：${p}`,
    manifestMissing:
      "マニフェスト：（なし — ファイルシステムスキャンにフォールバック）",
    manifestParseError: (p) =>
      `マニフェスト ${p} を読めません、スキャンにフォールバック`,
    categoryHeader: (k, label, n) => `${k}. ${label}（${n}）`,
    empty: "（なし）",
    footerOk: "クリーンな状態です。",
    footerFound: (n) => `合計エントリ：${n}`,
    diffHeader: "マニフェスト vs ファイルシステム の乖離",
    diffInManifestMissing: (p) =>
      `  − マニフェストにあるがディスクに無い：${p}`,
    diffOnDiskUnrecorded: (p) => `  + ディスクにあるがマニフェストに無い：${p}`,
    diffClean: "乖離なし。",
    notes: "注記",
    noteShared: "共有依存（pip パッケージ、.git/hooks）は参考情報のみ。",
    noteGlobal:
      "グローバル settings.json マージは Meta_Kim 管理の hook エントリのみ表示。",
    noteUninstall:
      "クリーンアップ：npm run meta:uninstall（dry-run）→ npm run meta:uninstall:yes",
  },
  "ko-KR": {
    title: "Meta_Kim 설치 발자국",
    scope: (s) => `범위: ${s}`,
    manifestFound: (p) => `매니페스트: ${p}`,
    manifestMissing: "매니페스트: (없음 — 파일시스템 스캔으로 폴백)",
    manifestParseError: (p) => `매니페스트 ${p} 를 읽을 수 없음, 스캔으로 폴백`,
    categoryHeader: (k, label, n) => `${k}. ${label} (${n})`,
    empty: "(없음)",
    footerOk: "깨끗한 상태입니다.",
    footerFound: (n) => `총 항목: ${n}`,
    diffHeader: "매니페스트 vs 파일시스템 차이",
    diffInManifestMissing: (p) => `  − 매니페스트엔 있으나 디스크에 없음: ${p}`,
    diffOnDiskUnrecorded: (p) => `  + 디스크엔 있으나 매니페스트에 없음: ${p}`,
    diffClean: "차이 없음.",
    notes: "주석",
    noteShared: "공유 의존성(pip 패키지, .git/hooks)은 참고용입니다.",
    noteGlobal:
      "전역 settings.json 병합은 Meta_Kim 관리 hook 항목만 표시합니다.",
    noteUninstall:
      "정리: npm run meta:uninstall (dry-run) → npm run meta:uninstall:yes",
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

function runtimeHome(id) {
  try {
    return resolveRuntimeHomeInfo(id).dir;
  } catch {
    return null;
  }
}

function listDirSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function pushIfExists(findings, category, p, extra = {}) {
  const stat = safeStat(p);
  if (!stat) return;
  findings.push({
    path: p,
    category,
    kind: stat.isDirectory() ? "dir" : "file",
    source: "scan",
    purpose: extra.purpose ?? null,
    size: stat.isFile() ? stat.size : null,
    mtime: stat.mtimeMs,
    ...extra,
  });
}

// ── Category scanners ─────────────────────────────────────────────────────

function scanGlobalSkills(findings) {
  for (const id of supportedTargetIds) {
    const home = runtimeHome(id);
    if (!home) continue;
    const candidates = [
      path.join(home, "skills", "meta-theory"),
      path.join(home, "skills", "meta-theory.md"),
    ];
    for (const p of candidates) {
      pushIfExists(findings, CATEGORIES.A, p, {
        purpose: `${id}-global-skill`,
        runtime: id,
      });
    }
  }
}

function scanGlobalHooks(findings) {
  const claudeHome = runtimeHome("claude");
  if (!claudeHome) return;
  const metaHooksDir = path.join(claudeHome, "hooks", "meta-kim");
  if (!existsSync(metaHooksDir)) return;
  pushIfExists(findings, CATEGORIES.B, metaHooksDir, {
    purpose: "claude-global-hooks-dir",
    runtime: "claude",
  });
  for (const entry of listDirSafe(metaHooksDir)) {
    if (!entry.isFile()) continue;
    pushIfExists(findings, CATEGORIES.B, path.join(metaHooksDir, entry.name), {
      purpose: "claude-global-hook",
      runtime: "claude",
      hookFile: entry.name,
    });
  }
}

function scanGlobalSettingsMerge(findings) {
  const claudeHome = runtimeHome("claude");
  if (!claudeHome) return;
  const settingsPath = path.join(claudeHome, "settings.json");
  if (!existsSync(settingsPath)) return;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return;
  }
  const managed = [];
  for (const [event, blocks] of Object.entries(parsed.hooks ?? {})) {
    for (const block of blocks ?? []) {
      for (const h of block.hooks ?? []) {
        if (isGlobalMetaKimHookCommand(h.command ?? "")) {
          managed.push({
            event,
            matcher: block.matcher ?? null,
            command: h.command,
          });
        }
      }
    }
  }
  if (managed.length === 0) return;
  findings.push({
    path: settingsPath,
    category: CATEGORIES.C,
    kind: "settings-merge",
    source: "scan",
    purpose: "claude-global-settings-merge",
    managedHookCount: managed.length,
    managedHooks: managed,
  });
}

function scanProjectSkills(findings, repoRoot) {
  const candidates = [
    path.join(repoRoot, ".claude", "skills", "meta-theory"),
    path.join(repoRoot, ".codex", "skills", "meta-theory"),
    path.join(repoRoot, "openclaw", "skills", "meta-theory"),
    path.join(repoRoot, ".cursor", "skills", "meta-theory"),
    path.join(repoRoot, ".agents", "skills", "meta-theory"),
  ];
  for (const p of candidates) {
    pushIfExists(findings, CATEGORIES.D, p, { purpose: "project-skill" });
  }
}

function scanProjectHooks(findings, repoRoot) {
  const hooksDir = path.join(repoRoot, ".claude", "hooks");
  if (!existsSync(hooksDir)) return;
  for (const entry of listDirSafe(hooksDir)) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".mjs")) continue;
    pushIfExists(findings, CATEGORIES.E, path.join(hooksDir, entry.name), {
      purpose: "project-hook",
    });
  }
}

function scanProjectAgents(findings, repoRoot) {
  const locations = [
    {
      dir: path.join(repoRoot, ".claude", "agents"),
      ext: ".md",
      runtime: "claude",
    },
    {
      dir: path.join(repoRoot, ".codex", "agents"),
      ext: ".toml",
      runtime: "codex",
    },
    {
      dir: path.join(repoRoot, ".cursor", "agents"),
      ext: ".md",
      runtime: "cursor",
    },
  ];
  for (const { dir, ext, runtime } of locations) {
    if (!existsSync(dir)) continue;
    for (const entry of listDirSafe(dir)) {
      if (!entry.isFile() || !entry.name.endsWith(ext)) continue;
      pushIfExists(findings, CATEGORIES.F, path.join(dir, entry.name), {
        purpose: "project-agent",
        runtime,
      });
    }
  }
}

function scanProjectSettings(findings, repoRoot) {
  const settingsPath = path.join(repoRoot, ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      parsed = null;
    }
    const managed = [];
    if (parsed) {
      for (const [event, blocks] of Object.entries(parsed.hooks ?? {})) {
        for (const block of blocks ?? []) {
          for (const h of block.hooks ?? []) {
            if (isRepoMetaKimHookCmd(h.command ?? "")) {
              managed.push({
                event,
                matcher: block.matcher ?? null,
                command: h.command,
              });
            }
          }
        }
      }
    }
    findings.push({
      path: settingsPath,
      category: CATEGORIES.G,
      kind: "settings-merge",
      source: "scan",
      purpose: "project-settings-merge",
      managedHookCount: managed.length,
      managedHooks: managed,
    });
  }
  const mcpPath = path.join(repoRoot, ".mcp.json");
  pushIfExists(findings, CATEGORIES.G, mcpPath, { purpose: "project-mcp" });
}

function scanProjectLocalState(findings, repoRoot) {
  const metaDir = path.join(repoRoot, ".meta-kim");
  pushIfExists(findings, CATEGORIES.H, metaDir, {
    purpose: "project-local-state-root",
  });
  const known = [
    path.join(metaDir, "local.overrides.json"),
    path.join(metaDir, "state"),
    path.join(metaDir, "install-manifest.json"),
  ];
  for (const p of known) {
    pushIfExists(findings, CATEGORIES.H, p, { purpose: "project-local-state" });
  }
}

function scanSharedDeps(findings, repoRoot) {
  const gitHooksDir = path.join(repoRoot, ".git", "hooks");
  for (const name of ["post-commit", "post-checkout"]) {
    const p = path.join(gitHooksDir, name);
    if (!existsSync(p)) continue;
    try {
      const content = readFileSync(p, "utf8");
      if (content.includes("graphify")) {
        pushIfExists(findings, CATEGORIES.I, p, {
          purpose: "graphify-git-hook",
          hookName: name,
        });
      }
    } catch {
      /* ignore */
    }
  }
}

// ── Driver ────────────────────────────────────────────────────────────────

function scanGlobal() {
  const findings = [];
  scanGlobalSkills(findings);
  scanGlobalHooks(findings);
  scanGlobalSettingsMerge(findings);
  return findings;
}

function scanProject(repoRoot) {
  const findings = [];
  scanProjectSkills(findings, repoRoot);
  scanProjectHooks(findings, repoRoot);
  scanProjectAgents(findings, repoRoot);
  scanProjectSettings(findings, repoRoot);
  scanProjectLocalState(findings, repoRoot);
  scanSharedDeps(findings, repoRoot);
  return findings;
}

function renderTree(findings, t, scopeLabel) {
  const grouped = {};
  for (const k of Object.keys(CATEGORY_LABELS)) grouped[k] = [];
  for (const f of findings) (grouped[f.category] ||= []).push(f);

  const lines = [];
  lines.push(`${C.bold}${C.cyan}${t.title}${C.reset}`);
  lines.push(`${C.dim}${t.scope(scopeLabel)}${C.reset}`);
  for (const [k, label] of Object.entries(CATEGORY_LABELS)) {
    const items = grouped[k];
    if (items.length === 0) continue;
    lines.push("");
    lines.push(
      `${C.bold}${t.categoryHeader(k, label, items.length)}${C.reset}`,
    );
    for (const f of items) {
      const bits = [f.path];
      if (f.kind === "settings-merge") {
        bits.push(`${C.dim}(${f.managedHookCount} hook entries)${C.reset}`);
      } else if (f.kind === "file" && f.size != null) {
        bits.push(`${C.dim}(${humanSize(f.size)})${C.reset}`);
      }
      lines.push(`  ${bits.join(" ")}`);
    }
  }
  if (findings.length === 0) {
    lines.push("");
    lines.push(`${C.green}${t.footerOk}${C.reset}`);
  } else {
    lines.push("");
    lines.push(`${C.dim}${t.footerFound(findings.length)}${C.reset}`);
  }
  lines.push("");
  lines.push(`${C.dim}${t.notes}: ${t.noteShared}${C.reset}`);
  lines.push(`${C.dim}${t.notes}: ${t.noteGlobal}${C.reset}`);
  lines.push(`${C.dim}${t.notes}: ${t.noteUninstall}${C.reset}`);
  return lines.join("\n");
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isVirtualManifestPath(value) {
  return /^[a-z]+:/i.test(value) && !/^[a-z]:[\\/]/i.test(value);
}

function normalizeComparablePath(value) {
  return String(value).replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
}

function pathCovers(left, right) {
  const leftNorm = normalizeComparablePath(left);
  const rightNorm = normalizeComparablePath(right);
  return (
    leftNorm === rightNorm ||
    leftNorm.startsWith(`${rightNorm}/`) ||
    rightNorm.startsWith(`${leftNorm}/`)
  );
}

function mergeManifests(manifests) {
  const entries = [];
  for (const manifest of manifests.filter(Boolean)) {
    entries.push(...(manifest.entries ?? []));
  }
  return entries.length > 0 ? { entries } : null;
}

function isDiffRecordableFinding(finding) {
  return finding.category !== CATEGORIES.H && finding.category !== CATEGORIES.I;
}

function renderDiff(findings, manifest, t) {
  const onDisk = findings.filter(isDiffRecordableFinding).map((f) => f.path);
  const inManifest = (manifest?.entries ?? []).map((e) => e.path);
  const missing = inManifest.filter(
    (p) => !isVirtualManifestPath(p) && !existsSync(p),
  );
  const unrecorded = onDisk.filter(
    (p) => !inManifest.some((manifestPath) => pathCovers(manifestPath, p)),
  );
  const lines = [`${C.bold}${t.diffHeader}${C.reset}`];
  for (const p of missing)
    lines.push(`${C.red}${t.diffInManifestMissing(p)}${C.reset}`);
  for (const p of unrecorded)
    lines.push(`${C.yellow}${t.diffOnDiskUnrecorded(p)}${C.reset}`);
  if (missing.length === 0 && unrecorded.length === 0) {
    lines.push(`${C.green}${t.diffClean}${C.reset}`);
  }
  return lines.join("\n");
}

export function collectFindings({ scope, repoRoot }) {
  const findings = [];
  if (scope === "global" || scope === "both") findings.push(...scanGlobal());
  if (scope === "project" || scope === "both")
    findings.push(...scanProject(repoRoot));
  return findings;
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
  const json = flag("json");
  const diff = flag("diff");
  const lang = resolveLang(valueOf("lang"));
  const t = MSG[lang] || MSG.en;

  const repoRoot = REPO_ROOT;
  const findings = collectFindings({ scope, repoRoot });

  let manifest = null;
  if (scope === "both") {
    manifest = mergeManifests([
      readManifest(manifestPathFor("project", repoRoot)),
      readManifest(manifestPathFor("global")),
    ]);
  } else if (scope === "project") {
    manifest = readManifest(manifestPathFor("project", repoRoot));
  } else if (scope === "global") {
    manifest = readManifest(manifestPathFor("global"));
  }

  if (json) {
    const payload = {
      scope,
      lang,
      repoRoot,
      manifest: manifest
        ? {
            path: "(resolved)",
            entries: manifest.entries.length,
            byCategory: listByCategory(manifest),
          }
        : null,
      findings,
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${renderTree(findings, t, scope)}\n`);
  if (diff) {
    process.stdout.write(`\n${renderDiff(findings, manifest, t)}\n`);
  }
}

if (
  import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` ||
  process.argv[1]?.endsWith("footprint.mjs")
) {
  main().catch((err) => {
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  });
}
