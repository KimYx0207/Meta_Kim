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

function runDryRun(extraArgs = [], extraEnv = {}) {
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
      env: {
        ...process.env,
        META_KIM_LANG: "en",
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        ...extraEnv,
      },
    },
  );
  return {
    status: result.status,
    out: (result.stdout || "") + (result.stderr || ""),
  };
}

function runFullDryRun(extraArgs = []) {
  const result = spawnSync(process.execPath, [SCRIPT, "--dry-run", ...extraArgs], {
    encoding: "utf8",
    env: {
      ...process.env,
      META_KIM_LANG: "en",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
  });
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

  test("Claude marketplace path is exercised for ECC", () => {
    const { status, out } = runDryRun();
    assert.equal(status, 0);
    const plain = stripAnsi(out);
    const marketplaceExercised =
      /claude plugin install ecc@ecc/.test(plain) ||
      /ecc@ecc.*(already installed|已安装|이미 설치됨|既にインストール)/i.test(
        plain,
      );
    assert.ok(
      marketplaceExercised,
      "expected install command or already-installed skip for canonical ecc@ecc",
    );
    assert.doesNotMatch(plain, /ecc@everything-claude-code/);
    assert.doesNotMatch(plain, /everything-claude-code@everything-claude-code/);
    assert.doesNotMatch(plain, /claude plugin install everything-claude-code@ecc/);
  });

  test("Claude update mode refreshes canonical ECC plugin instead of relying on manual host fixes", () => {
    const { status, out } = runDryRun(["--update"]);
    assert.equal(status, 0);
    const plain = stripAnsi(out);
    assert.match(
      plain,
      /claude plugin update ecc@ecc/,
      "expected Meta_Kim update path to update the installed ECC plugin",
    );
    assert.doesNotMatch(plain, /claude plugin update ecc@everything-claude-code/);
    assert.doesNotMatch(plain, /claude plugin update everything-claude-code@everything-claude-code/);
  });

  test("ECC non-Claude runtimes use upstream native installer, not skills fallback", () => {
    const { status, out } = runDryRun();
    assert.equal(status, 0);
    const plain = stripAnsi(out);
    assert.match(plain, /npx --yes --package ecc-universal@latest ecc install --profile core --target codex/);
    assert.match(
      plain,
      /preserve existing .*\.codex.*config\.toml before ECC upstream installer, reject upstream MCP\/project\/root config, and restore only the user snapshot plus Meta_Kim native controls/,
    );
    assert.match(
      plain,
      /ensure .*\.codex.*config\.toml preserves Codex App Browser\/Chrome\/Computer Use native controls/,
    );
    assert.match(
      plain,
      /protect .*\.codex.*AGENTS\.md from ECC upstream installer/,
    );
    assert.match(
      plain,
      /ecc: project-local installer skipped during global update; run from each cursor project root: npx --yes --package ecc-universal@latest ecc install --profile core --target cursor/,
    );
    assert.doesNotMatch(
      plain,
      /git sparse-checkout https:\/\/github\.com\/affaan-m\/ECC\.git:\.codex ->/,
    );
    assert.doesNotMatch(
      plain,
      /git sparse-checkout https:\/\/github\.com\/affaan-m\/ECC\.git:skills ->/,
    );
  });

  test("ECC opencode target is accepted and uses upstream home installer", () => {
    const { status, out } = runDryRun(["--targets", "opencode"]);
    assert.equal(status, 0);
    const plain = stripAnsi(out);
    assert.match(
      plain,
      /npx --yes --package ecc-universal@latest ecc install --profile core --target opencode/,
    );
  });

  test("Qoder target is accepted for probes but not treated as an ECC target", () => {
    const { status, out } = runFullDryRun(["--skills", "ecc", "--targets", "qoder"]);
    assert.equal(status, 0);
    const plain = stripAnsi(out);
    assert.doesNotMatch(plain, /Unknown runtime target: qoder/);
    assert.doesNotMatch(
      plain,
      /ecc install --profile core --target qoder/,
    );
  });

  test("ECC filtered installs do not trigger generic skill fallback", () => {
    const { status, out } = runFullDryRun(["--skills", "ecc", "--targets", "zed"]);
    assert.equal(status, 0);
    const plain = stripAnsi(out);
    assert.match(
      plain,
      /ecc: project-local installer skipped during global update; run from each zed project root: npx --yes --package ecc-universal@latest ecc install --profile core --target zed/,
    );
    assert.doesNotMatch(plain, /undefined/);
    assert.doesNotMatch(plain, /skill-creator/);
    assert.doesNotMatch(plain, /sparse install https:\/\/github\.com\/affaan-m\/ECC\.git/);
    assert.doesNotMatch(plain, /git clone https:\/\/github\.com\/affaan-m\/ECC\.git/);
  });

  test("unknown --skills filter skips optional skill suite without installing generic fallback", () => {
    const { status, out } = runFullDryRun([
      "--skills",
      "does-not-exist",
      "--targets",
      "claude,codex",
    ]);
    assert.equal(status, 0);
    const plain = stripAnsi(out);
    assert.match(plain, /Unknown skill id|No skill repositories matched/i);
    assert.doesNotMatch(plain, /skill-creator/);
    assert.doesNotMatch(plain, /git clone https:\/\/github\.com\//);
    assert.doesNotMatch(plain, /sparse install https:\/\/github\.com\//);
    assert.match(plain, /ensure .*\.codex.*config\.toml preserves Codex App Browser\/Chrome\/Computer Use native controls/);
  });

  test("empty --skills filter means no selected third-party skill repos, not all repos", () => {
    const { status, out } = runFullDryRun([
      "--skip-plugins",
      "--skills",
      "",
      "--targets",
      "claude,codex",
    ]);
    assert.equal(status, 0);
    const plain = stripAnsi(out);
    assert.match(plain, /No third-party skill repos selected/i);
    assert.doesNotMatch(plain, /git clone https:\/\/github\.com\//);
    assert.doesNotMatch(plain, /sparse install https:\/\/github\.com\//);
    assert.doesNotMatch(plain, /skill-creator/);
  });

  test("Codex runtime uses native plugin flow for superpowers", () => {
    const { status, out } = runDryRun();
    assert.equal(status, 0);
    const plain = stripAnsi(out);
    assert.match(plain, /codex plugin add superpowers@openai-curated/);
    assert.doesNotMatch(
      plain,
      /git sparse-checkout https:\/\/github\.com\/obra\/superpowers\.git:\.codex ->/,
    );
  });

  test("Cursor runtime uses native plugin flow for superpowers", () => {
    const { status, out } = runDryRun();
    assert.equal(status, 0);
    const plain = stripAnsi(out);
    assert.match(plain, /Cursor native plugin manual step/);
    assert.match(plain, /\/add-plugin superpowers/);
    assert.match(plain, /does not currently expose a non-interactive plugin install command/);
    assert.doesNotMatch(
      plain,
      /git sparse-checkout https:\/\/github\.com\/obra\/superpowers\.git:\.cursor ->/,
    );
  });

  test("plugin handoff and ECC project-local notices honor zh-CN i18n", () => {
    const { status, out } = runDryRun([], { META_KIM_LANG: "zh-CN" });
    assert.equal(status, 0);
    const plain = stripAnsi(out);
    assert.match(plain, /插件包 \/ 原生插件交接/);
    assert.match(plain, /全局更新不会写入项目本地安装/);
    assert.match(plain, /Cursor 原生插件需手动安装/);
    assert.match(plain, /保留现有 .*\.codex.*config\.toml/);
    assert.match(plain, /保护 .*\.codex.*AGENTS\.md 不被 ECC 上游安装器覆盖/);
    assert.doesNotMatch(plain, /Cursor native plugin manual step/);
    assert.doesNotMatch(plain, /project-local installer skipped during global update/);
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
