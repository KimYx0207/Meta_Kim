import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildI18N } from "../../config/i18n/setup-strings.mjs";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "bin", "meta-kim.mjs");
const setup = path.join(repoRoot, "setup.mjs");
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));

function run(script, args = [], env = {}, cwd = repoRoot) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 32 * 1024 * 1024,
  });
}

describe("stable package CLI UX", () => {
  test("--help and --version are successful package-root-independent queries", () => {
    const help = run(cli, ["--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /meta-kim status/);
    assert.match(help.stdout, /meta-kim uninstall/);
    assert.match(help.stdout, /meta-kim doctor hooks/);
    assert.match(help.stdout, /meta-kim release audit/);
    assert.match(help.stdout, /meta-kim release close/);

    const releaseAuditHelp = run(cli, ["release", "audit", "--help"]);
    assert.equal(releaseAuditHelp.status, 0, releaseAuditHelp.stderr);
    assert.match(releaseAuditHelp.stdout, /historical-report-unavailable/);

    const releaseCloseHelp = run(cli, ["release", "close", "--help"]);
    assert.equal(releaseCloseHelp.status, 0, releaseCloseHelp.stderr);
    assert.match(releaseCloseHelp.stdout, /never creates a second queue/);

    const version = run(cli, ["--version"]);
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), packageJson.version);

    const npxCompatible = run(cli, ["meta-kim", "--", "--version"]);
    assert.equal(npxCompatible.status, 0, npxCompatible.stderr);
    assert.equal(npxCompatible.stdout.trim(), packageJson.version);
  });

  test("unknown options fail closed before setup runs", () => {
    const result = run(cli, ["--definitely-unknown"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown option/);
    assert.doesNotMatch(result.stdout, /META_KIM/);

    const directSetup = run(setup, ["--definitely-unknown"]);
    assert.notEqual(directSetup.status, 0);
    assert.match(directSetup.stderr, /unknown option/);
  });

  test("rebind-runtime-launch rejects bad targets instead of silently dropping them", () => {
    // A dropped typo looks identical to a successful rebind, so the runtime
    // the user meant to re-record silently keeps its stale binding.
    const typo = run(setup, ["--rebind-runtime-launch", "--targets", "codex,typo"]);
    assert.notEqual(typo.status, 0);
    assert.match(typo.stderr, /Unknown runtime target: typo/);
    assert.doesNotMatch(typo.stdout, /Re-recorded/);

    // Supported elsewhere in the repo, but outside this mode's contract.
    const outOfScope = run(setup, ["--rebind-runtime-launch", "--targets", "cursor"]);
    assert.notEqual(outOfScope.status, 0);
    assert.match(outOfScope.stderr, /does not support cursor/);
    assert.doesNotMatch(outOfScope.stdout, /Re-recorded/);
  });

  test("empty setup values fail before setup performs work", () => {
    for (const arg of ["--lang=", "--targets=", "--project-dir="]) {
      const result = run(setup, [arg]);
      assert.equal(result.status, 2, result.stderr || result.stdout);
      assert.match(result.stderr, /missing value for/);
      assert.doesNotMatch(result.stdout, /META_KIM/);
    }
  });

  test("invalid status and uninstall scopes fail closed", () => {
    for (const command of ["status", "uninstall"]) {
      const result = run(
        cli,
        [command, ...(command === "status" ? ["--lang", "en"] : []), "--scope=porject", "--yes"].filter(
          (arg) => command === "uninstall" || arg !== "--yes",
        ),
      );
      assert.equal(result.status, 2, result.stderr || result.stdout);
      assert.match(result.stderr, /invalid scope 'porject'/);
    }
  });

  test("package CLI maps sustainable management commands to package-root scripts", () => {
    const source = readFileSync(cli, "utf8");
    assert.match(source, /case "status"[\s\S]*?scripts\/footprint\.mjs/);
    assert.match(source, /case "doctor"[\s\S]*?scripts\/doctor-interactive\.mjs/);
    assert.match(source, /case "doctor"[\s\S]*?scripts\/doctor-hooks\.mjs/);
    assert.match(source, /case "release"[\s\S]*?scripts\/audit-release-binding\.mjs/);
    assert.match(source, /case "release"[\s\S]*?scripts\/record-release-planning-closure\.mjs/);
    assert.match(source, /case "uninstall"[\s\S]*?scripts\/uninstall\.mjs/);
    assert.match(source, /case "check"[\s\S]*?setup\.mjs/);
    assert.match(source, /case "update"[\s\S]*?setup\.mjs/);
  });

  test("status runs from an unrelated current directory", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "meta-kim-cli-cwd-"));
    try {
      const result = run(cli, ["status", "--json"], {}, cwd);
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotThrow(() => JSON.parse(result.stdout));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("doctor hooks --fix repairs the caller project's known Graphify hook", {
    skip: process.platform !== "win32",
  }, () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "meta-kim-doctor-hooks-cwd-"));
    try {
      const claudeDir = path.join(cwd, ".claude");
      const graphifyExe = path.join(cwd, "graphify.EXE");
      const settingsPath = path.join(claudeDir, "settings.json");
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(graphifyExe, "", "utf8");
      writeFileSync(settingsPath, JSON.stringify({
        hooks: {
          PreToolUse: [{
            matcher: "Read",
            hooks: [{
              type: "command",
              command: `${graphifyExe.replaceAll("/", "\\")} hook-guard read`,
            }],
          }],
        },
      }, null, 2), "utf8");

      const result = run(cli, ["doctor", "hooks", "--fix", "--silent"], {}, cwd);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
      const hook = saved.hooks.PreToolUse[0].hooks[0];
      assert.equal(path.resolve(hook.command), path.resolve(graphifyExe));
      assert.deepEqual(hook.args, ["hook-guard", "read"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("doctor hooks rejects unknown options before scanning", () => {
    const result = run(cli, ["doctor", "hooks", "--rewrite-everything"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown doctor hooks option/);
  });

  test("status accepts language aliases and keeps concise, detailed, and JSON layers compatible", () => {
    const locales = [
      ["en", /Meta_Kim status/],
      ["zh", /Meta_Kim 状态/],
      ["ja", /Meta_Kim ステータス/],
      ["ko", /Meta_Kim 상태/],
    ];
    for (const [language, title] of locales) {
      const concise = run(cli, ["status", "--lang", language]);
      assert.equal(concise.status, 0, concise.stderr);
      assert.match(concise.stdout, title);
      assert.match(concise.stdout, /status --details/);
      assert.match(concise.stdout, /meta:uninstall/);
      assert.match(concise.stdout, /meta:uninstall:yes/);
      assert.match(concise.stdout, /\.meta-kim\/state/);
      assert.doesNotMatch(concise.stdout, /^A\. /m);

      const equalsForm = run(cli, ["status", `--lang=${language}`, "--json"]);
      assert.equal(equalsForm.status, 0, equalsForm.stderr);
      assert.doesNotThrow(() => JSON.parse(equalsForm.stdout));
    }

    const detailed = run(cli, ["status", "--lang", "en", "--details"]);
    assert.equal(detailed.status, 0, detailed.stderr);
    assert.match(detailed.stdout, /A\. Global runtime skills/);

    const localizedHelp = run(cli, ["status", "--lang", "zh", "--help"]);
    assert.equal(localizedHelp.status, 0, localizedHelp.stderr);
    assert.match(localizedHelp.stdout, /用法/);

    const localizedError = run(cli, ["status", "--lang", "zh", "--bad"]);
    assert.equal(localizedError.status, 2);
    assert.match(localizedError.stderr, /未知的状态选项/);
  });

  test("status default locale stays consistent between concise and details surfaces", () => {
    const env = {
      META_KIM_OUTPUT_LANGUAGE: "",
      METAKIM_LANG: "",
      LC_ALL: "",
      LC_MESSAGES: "",
      LANG: "ja_JP.UTF-8",
    };
    const concise = run(cli, ["status"], env);
    const detailed = run(cli, ["status", "--details"], env);
    assert.equal(concise.status, 0, concise.stderr);
    assert.equal(detailed.status, 0, detailed.stderr);
    assert.match(concise.stdout, /Meta_Kim ステータス/);
    assert.match(detailed.stdout, /Meta_Kim インストール足跡/);
    assert.doesNotMatch(detailed.stdout, /Meta_Kim footprint|Scope: both/);
  });
});

describe("setup check is read-only", () => {
  test("failed sync guidance is available in all supported languages", () => {
    const i18n = buildI18N({ MIN_NODE_VERSION: 18 });
    for (const language of ["en", "zh-CN", "ja-JP", "ko-KR"]) {
      assert.ok(i18n[language].checkOverallFailed);
      assert.match(i18n[language].checkRepairCommand, /npm run meta:sync/);
    }
  });

  test("--check does not create profile state", () => {
    const profile = `check-read-only-${process.pid}-${Date.now()}`;
    const profileDir = path.join(repoRoot, ".meta-kim", "state", profile);
    assert.equal(existsSync(profileDir), false);
    const result = run(setup, ["--check", "--silent", "--targets", "claude,codex"], {
      META_KIM_PROFILE: profile,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(profileDir), false, "--check must not create profile directories or metadata");
  });
});

describe("doctor result semantics", () => {
  test("failed checks set a failing exit status and summary separates states", () => {
    const source = readFileSync(path.join(repoRoot, "scripts", "doctor-interactive.mjs"), "utf8");
    assert.match(source, /process\.exitCode = 1/);
    assert.match(source, /checked=\$\{results\.length\} passed=\$\{passed\} failed=\$\{failed\} skipped=0/);
    assert.match(source, /return failed === 0/);
    assert.match(source, /meta:eval:agents[\s\S]*?--require-all-runtimes/);
  });
});
