#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const forbiddenRuntimeSources = [
  ".claude/",
  ".codex/",
  ".agents/",
  ".cursor/",
  ".gemini/",
  ".zcode/",
  ".dsh/",
  "openclaw/",
  "codex/",
  ".mcp.json",
];

function repoPath(relativePath) {
  return path.join(repoRoot, relativePath);
}

function normalizePath(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/^.\//, "");
}

function isForbiddenRuntimeSource(relativePath) {
  const normalized = normalizePath(relativePath);
  return forbiddenRuntimeSources.some((entry) => {
    if (entry.endsWith("/")) {
      return normalized === entry.slice(0, -1) || normalized.startsWith(entry);
    }
    return normalized === entry;
  });
}

function listTrackedFiles() {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.status !== 0) {
    return {
      skipped: true,
      reason: result.stderr?.trim() || "git ls-files failed",
      files: [],
    };
  }

  return {
    skipped: false,
    files: result.stdout.split("\0").filter(Boolean).map(normalizePath),
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertGitignoreCoversRuntimeProjections() {
  const gitignore = readFileSync(repoPath(".gitignore"), "utf8");
  for (const entry of forbiddenRuntimeSources) {
    const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = entry.endsWith("/")
      ? new RegExp(`^/${escaped}$|^${escaped}$`, "m")
      : new RegExp(`^/${escaped}$|^${escaped}$`, "m");
    assert(pattern.test(gitignore), `.gitignore must keep ${entry} out of GitHub source.`);
  }
}

function assertPackageFilesExcludeRuntimeProjections() {
  const pkg = JSON.parse(readFileSync(repoPath("package.json"), "utf8"));
  const forbidden = (pkg.files ?? [])
    .map(normalizePath)
    .filter(isForbiddenRuntimeSource);

  assert(
    forbidden.length === 0,
    `package.json files must not package generated runtime projections: ${forbidden.join(", ")}`,
  );
}

function assertTrackedFilesExcludeRuntimeProjections() {
  const tracked = listTrackedFiles();
  if (tracked.skipped) {
    return tracked;
  }

  const forbidden = tracked.files.filter(isForbiddenRuntimeSource);
  assert(
    forbidden.length === 0,
    `Generated runtime projections must not be tracked in GitHub source: ${forbidden.join(", ")}`,
  );
  return tracked;
}

function assertDocsExplainBoundary() {
  const docs = [
    {
      readme: "README.md",
      guide: "docs/technical-notes.md",
      generationPattern: /directories.*generated locally.*npm run meta:sync/,
      boundaryPattern:
        /excluded from GitHub source.*kept local.*\.gitignore/,
    },
    {
      readme: "README.zh-CN.md",
      guide: "docs/technical-notes.zh-CN.md",
      generationPattern: /客户端目录.*npm run meta:sync.*在本地生成/,
      boundaryPattern: /\.gitignore.*保留在本地.*不提交到 GitHub 源码/,
    },
    {
      readme: "README.ja-JP.md",
      guide: "docs/technical-notes.ja-JP.md",
      generationPattern: /クライアント別ディレクトリ.*npm run meta:sync.*ローカルに生成/,
      boundaryPattern: /\.gitignore.*GitHub のソースから除外.*ローカルに保持/,
    },
    {
      readme: "README.ko-KR.md",
      guide: "docs/technical-notes.ko-KR.md",
      generationPattern: /클라이언트별 디렉터리.*npm run meta:sync.*로컬에 생성/,
      boundaryPattern: /\.gitignore.*GitHub 소스에서 제외.*로컬에 유지/,
    },
  ];

  for (const { readme, guide, generationPattern, boundaryPattern } of docs) {
    const readmeRaw = readFileSync(repoPath(readme), "utf8");
    const escapedGuide = guide.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const guideLink = new RegExp(`\\]\\((?:\\./)?${escapedGuide}(?:#[^\\s)]*)?\\)`);
    assert(guideLink.test(readmeRaw), `${readme} must link to its localized technical guide ${guide}.`);

    const raw = readFileSync(repoPath(guide), "utf8");
    assert(raw.includes("`canonical/`") && raw.includes("`config/`"), `${guide} must identify the canonical source and configuration directories.`);
    assert(generationPattern.test(raw), `${guide} must explain that runtime directories are generated locally by meta:sync.`);
    assert(boundaryPattern.test(raw), `${guide} must explain that .gitignore keeps generated runtime projections local and out of GitHub source.`);
  }
}

function main() {
  assertGitignoreCoversRuntimeProjections();
  assertPackageFilesExcludeRuntimeProjections();
  const tracked = assertTrackedFilesExcludeRuntimeProjections();
  assertDocsExplainBoundary();

  const gitStatus = tracked.skipped
    ? `git-check=skipped (${tracked.reason})`
    : "git-check=passed";
  console.log(`open-source boundary valid (${gitStatus})`);
}

try {
  main();
} catch (error) {
  console.error(`open-source boundary invalid: ${error.message}`);
  process.exitCode = 1;
}
