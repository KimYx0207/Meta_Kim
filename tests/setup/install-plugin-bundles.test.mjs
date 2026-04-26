import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(
  repoRoot,
  "scripts",
  "install-global-skills-all-runtimes.mjs",
);

function runDryRun(extraArgs = []) {
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--dry-run",
      "--plugins-only",
      "--targets",
      "claude,codex,openclaw,cursor",
      ...extraArgs,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    },
  );
  return {
    status: result.status,
    out: (result.stdout || "") + (result.stderr || ""),
  };
}

function stripAnsi(s) {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("installPluginBundlesForNonClaudeRuntimes (dry-run e2e)", () => {
  test("Claude marketplace path is exercised for superpowers", () => {
    const { status, out } = runDryRun();
    assert.equal(status, 0, `script exited ${status}`);
    const plain = stripAnsi(out);
    assert.match(
      plain,
      /superpowers-marketplace/,
      "expected marketplace id to appear (registered or install command)",
    );
    // Either "claude plugin install superpowers@..." (first run) or
    // "superpowers — 已安装 / already installed" (subsequent runs).
    const marketplaceExercised =
      /claude plugin install superpowers@superpowers-marketplace/.test(plain) ||
      /superpowers.*(already installed|已安装|이미 설치됨|既にインストール)/i.test(
        plain,
      );
    assert.ok(
      marketplaceExercised,
      "expected either install command or already-installed skip for superpowers",
    );
  });

  test("Claude marketplace path is exercised for everything-claude-code", () => {
    const { status, out } = runDryRun();
    assert.equal(status, 0);
    const plain = stripAnsi(out);
    assert.match(plain, /everything-claude-code/);
    const marketplaceExercised =
      /claude plugin install everything-claude-code@everything-claude-code/.test(
        plain,
      ) ||
      /everything-claude-code.*(already installed|已安装|이미 설치됨|既にインストール)/i.test(
        plain,
      );
    assert.ok(
      marketplaceExercised,
      "expected either install command or already-installed skip for everything-claude-code",
    );
  });

  test("Codex runtime extracts .codex/ subdir for superpowers", () => {
    const { status, out } = runDryRun();
    assert.equal(status, 0);
    const plain = stripAnsi(out);
    assert.match(
      plain,
      /git sparse-checkout https:\/\/github\.com\/obra\/superpowers\.git:\.codex ->/,
    );
  });

  test("Cursor runtime extracts .cursor/ subdir for superpowers", () => {
    const { status, out } = runDryRun();
    assert.equal(status, 0);
    const plain = stripAnsi(out);
    assert.match(
      plain,
      /git sparse-checkout https:\/\/github\.com\/obra\/superpowers\.git:\.cursor ->/,
    );
  });

  test("OpenClaw runtime falls back to skills/ for superpowers", () => {
    const { status, out } = runDryRun();
    assert.equal(status, 0);
    const plain = stripAnsi(out);
    const openclawLine = plain
      .split(/\r?\n/)
      .find(
        (l) => /obra\/superpowers\.git:skills ->/.test(l) && /openclaw/.test(l),
      );
    assert.ok(
      openclawLine,
      "expected skills/ subdir extract for superpowers on OpenClaw",
    );
  });

  test("cli-anything falls back to skills/ on Claude (no claudePlugin)", () => {
    const { status, out } = runDryRun();
    assert.equal(status, 0);
    const plain = stripAnsi(out);
    const claudeFallbackLine = plain
      .split(/\r?\n/)
      .find(
        (l) =>
          /HKUDS\/CLI-Anything\.git:skills ->/.test(l) &&
          /\.claude/.test(l) &&
          !/\.codex|\.cursor|\.openclaw/.test(l),
      );
    assert.ok(
      claudeFallbackLine,
      "expected Claude fallback to sparse-checkout skills/ into ~/.claude/skills/cli-anything",
    );
  });

  test("superpowers is NOT integrated via the generic stage/deploy path on any runtime", () => {
    const { status, out } = runDryRun();
    assert.equal(status, 0);
    const plain = stripAnsi(out);
    const forbidden = plain
      .split(/\r?\n/)
      .find((l) =>
        /sparse install https:\/\/github\.com\/obra\/superpowers\.git/.test(l),
      );
    assert.equal(
      forbidden,
      undefined,
      `superpowers must not be handled by the generic subdir-install path, got: ${forbidden}`,
    );
  });

  test("section header 'Plugin bundles' is emitted when plugin-bundle skills are processed", () => {
    const { status, out } = runDryRun();
    assert.equal(status, 0);
    const plain = stripAnsi(out);
    assert.match(plain, /Plugin bundles/);
  });
});
