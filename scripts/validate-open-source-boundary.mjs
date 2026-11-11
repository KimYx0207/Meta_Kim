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
      file: "README.md",
      pattern:
        /directories are generated locally.*excluded from GitHub source.*\.gitignore/,
    },
    {
      file: "README.zh-CN.md",
      pattern:
        /客户端目录.*生成.*\.gitignore.*保留在本地.*不提交到 GitHub 源码/,
    },
    {
      file: "README.ja-JP.md",
      pattern:
        /クライアント別ディレクトリ.*生成.*\.gitignore.*GitHub のソースから除外/,
    },
    {
      file: "README.ko-KR.md",
      pattern:
        /클라이언트별 디렉터리.*생성.*\.gitignore.*GitHub 소스에서 제외/,
    },
  ];

  for (const { file, pattern } of docs) {
    const raw = readFileSync(repoPath(file), "utf8");
    assert(pattern.test(raw), `${file} must explain generated runtime projections are not GitHub source.`);
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
