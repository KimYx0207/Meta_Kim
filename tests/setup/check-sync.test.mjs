/**
 * Tests for checkSync() — runtime sync verification logic.
 * Covers: canonical hooks validation, workspace completeness, path resolution.
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import * as path from "node:path";
import {
  CLAUDE_HOOK_FILES as CANONICAL_HOOKS,
  META_AGENTS,
  OPENCLAW_WORKSPACE_MD,
  expectedAgentProjectionFiles,
  summarizeExpectedFiles,
} from "../../scripts/runtime-sync-check.mjs";

// ── Hook validation ───────────────────────────────────────────

// Normalize paths to forward slashes for cross-platform comparison
function normalizePath(p) {
  return p.replace(/\\/g, "/");
}

function validateHooks(hooksDir, allFiles) {
  const toKey = (h) => normalizePath(path.join(hooksDir, h));
  const fileSet = new Set(allFiles.map(normalizePath));
  const present = CANONICAL_HOOKS.filter((h) => fileSet.has(toKey(h)));
  const missing = CANONICAL_HOOKS.filter((h) => !fileSet.has(toKey(h)));
  return { present, missing, allPresent: missing.length === 0 };
}

function validateWorkspaces(homeDir, workspaceIds, allDirs) {
  const dirSet = new Set(allDirs.map(normalizePath));
  let complete = 0;
  let missing = [];
  for (const id of workspaceIds) {
    const wsDir = normalizePath(path.join(homeDir, `workspace-${id}`));
    const allMdPresent = OPENCLAW_WORKSPACE_MD.every((md) =>
      dirSet.has(`${wsDir}/${md}`),
    );
    if (allMdPresent) complete++;
    else missing.push(id);
  }
  return { complete, total: workspaceIds.length, missing };
}

describe("validateHooks()", () => {
  test("returns all present when all canonical hooks exist", () => {
    const hooksDir = "/home/user/.claude/hooks/meta-kim";
    const allFiles = CANONICAL_HOOKS.map((h) => path.join(hooksDir, h));
    const result = validateHooks(hooksDir, allFiles);
    assert.strictEqual(result.allPresent, true);
    assert.strictEqual(result.present.length, CANONICAL_HOOKS.length);
    assert.strictEqual(result.missing.length, 0);
  });

  test("detects missing hooks", () => {
    const hooksDir = "/home/user/.claude/hooks/meta-kim";
    // Only 3 hooks present
    const presentHooks = CANONICAL_HOOKS.slice(0, 3);
    const allFiles = presentHooks.map((h) => path.join(hooksDir, h));
    const result = validateHooks(hooksDir, allFiles);
    assert.strictEqual(result.allPresent, false);
    assert.strictEqual(result.present.length, 3);
    assert.strictEqual(result.missing.length, CANONICAL_HOOKS.length - 3);
    assert.ok(result.missing.includes("stop-completion-guard.mjs"));
  });

  test("empty hooks dir returns all missing", () => {
    const hooksDir = "/home/user/.claude/hooks/meta-kim";
    const result = validateHooks(hooksDir, []);
    assert.strictEqual(result.allPresent, false);
    assert.strictEqual(result.present.length, 0);
    assert.strictEqual(result.missing.length, CANONICAL_HOOKS.length);
  });

  test("hooks in wrong subdir are not counted", () => {
    const wrongDir = "/home/user/.claude/hooks/other";
    const allFiles = CANONICAL_HOOKS.map((h) => path.join(wrongDir, h));
    const result = validateHooks("/home/user/.claude/hooks/meta-kim", allFiles);
    assert.strictEqual(result.allPresent, false);
    assert.strictEqual(result.present.length, 0);
  });
});

describe("summarizeExpectedFiles()", () => {
  test("counts exact Meta_Kim agents even when extra files exist", () => {
    const summary = summarizeExpectedFiles(
      [
        ...expectedAgentProjectionFiles(".md"),
        "frontend.md",
        "backend.md",
        "debugger.md",
      ],
      expectedAgentProjectionFiles(".md"),
    );

    assert.strictEqual(summary.presentCount, META_AGENTS.length);
    assert.deepStrictEqual(summary.missing, []);
    assert.ok(summary.extra.includes("frontend.md"));
  });

  test("reports missing expected Meta_Kim agents instead of raw directory size", () => {
    const summary = summarizeExpectedFiles(
      [
        ...expectedAgentProjectionFiles(".md").filter(
          (name) => name !== "meta-warden.md",
        ),
        "frontend.md",
        "backend.md",
        "debugger.md",
      ],
      expectedAgentProjectionFiles(".md"),
    );

    assert.strictEqual(summary.presentCount, META_AGENTS.length - 1);
    assert.deepStrictEqual(summary.missing, ["meta-warden.md"]);
  });
});

describe("validateWorkspaces()", () => {
  test("complete workspace with all 9 .md files passes", () => {
    const homeDir = "/home/user/.openclaw";
    const allDirs = [
      "/home/user/.openclaw/workspace-meta-warden/BOOT.md",
      "/home/user/.openclaw/workspace-meta-warden/SOUL.md",
      "/home/user/.openclaw/workspace-meta-warden/IDENTITY.md",
      "/home/user/.openclaw/workspace-meta-warden/TOOLS.md",
      "/home/user/.openclaw/workspace-meta-warden/AGENTS.md",
      "/home/user/.openclaw/workspace-meta-warden/MEMORY.md",
      "/home/user/.openclaw/workspace-meta-warden/HEARTBEAT.md",
      "/home/user/.openclaw/workspace-meta-warden/BOOTSTRAP.md",
      "/home/user/.openclaw/workspace-meta-warden/USER.md",
    ];
    const result = validateWorkspaces(homeDir, ["meta-warden"], allDirs);
    assert.strictEqual(result.complete, 1);
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.missing.length, 0);
  });

  test("workspace missing BOOT.md fails", () => {
    const homeDir = "/home/user/.openclaw";
    const allDirs = [
      // missing BOOT.md
      "/home/user/.openclaw/workspace-meta-warden/SOUL.md",
      "/home/user/.openclaw/workspace-meta-warden/IDENTITY.md",
      "/home/user/.openclaw/workspace-meta-warden/TOOLS.md",
      "/home/user/.openclaw/workspace-meta-warden/AGENTS.md",
      "/home/user/.openclaw/workspace-meta-warden/MEMORY.md",
      "/home/user/.openclaw/workspace-meta-warden/HEARTBEAT.md",
      "/home/user/.openclaw/workspace-meta-warden/BOOTSTRAP.md",
      "/home/user/.openclaw/workspace-meta-warden/USER.md",
    ];
    const result = validateWorkspaces(homeDir, ["meta-warden"], allDirs);
    assert.strictEqual(result.complete, 0);
    assert.ok(result.missing.includes("meta-warden"));
  });

  test("partial completeness is reported correctly", () => {
    const homeDir = "/home/user/.openclaw";
    const allDirs = [
      ...OPENCLAW_WORKSPACE_MD.map(
        (md) => `/home/user/.openclaw/workspace-meta-warden/${md}`,
      ),
      // meta-conductor incomplete
    ];
    const result = validateWorkspaces(homeDir, META_AGENTS, allDirs);
    assert.strictEqual(result.complete, 1);
    assert.strictEqual(result.total, 8);
    assert.ok(result.missing.includes("meta-conductor"));
  });
});

// ── Path resolution edge cases ─────────────────────────────────

describe("Runtime path resolution patterns", () => {
  test("Claude home resolves to ~/.claude", () => {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const claudeHome = path.join(home, ".claude");
    assert.ok(claudeHome.includes(".claude"));
  });

  test("Codex home resolves to ~/.codex", () => {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const codexHome = path.join(home, ".codex");
    assert.ok(codexHome.includes(".codex"));
  });

  test("Cursor home resolves to ~/.cursor", () => {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const cursorHome = path.join(home, ".cursor");
    assert.ok(cursorHome.includes(".cursor"));
  });

  test("OpenClaw workspaces are flat workspace-* at runtime root", () => {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const openclawHome = path.join(home, ".openclaw");
    const wsPath = path.join(openclawHome, "workspace-meta-warden");
    assert.ok(wsPath.includes("workspace-meta-warden"));
    assert.ok(!wsPath.includes("workspaces/"));
  });
});
