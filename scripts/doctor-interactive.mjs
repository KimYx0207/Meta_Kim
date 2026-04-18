#!/usr/bin/env node
/**
 * Interactive diagnostic entry point for Meta_Kim.
 * Provides a unified menu for running various health checks.
 *
 * Usage:
 *   node scripts/doctor-interactive.mjs
 *   npm run meta:doctor
 */

import { execSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { select } from "@inquirer/prompts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

/** Run a npm-script or node script and stream its output. */
function runCommand(label, cmd, args = []) {
  const isNpm = cmd === "npm";
  const fullLabel = isNpm
    ? `npm run ${args[0]}`
    : `node scripts/${path.basename(cmd)}`;

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`${"─".repeat(60)}`);

  try {
    if (isNpm) {
      execSync(`npm run ${args[0]}`, {
        cwd: repoRoot,
        stdio: "inherit",
        shell: true,
      });
    } else {
      execSync(`node "${cmd}"`, {
        cwd: repoRoot,
        stdio: "inherit",
        shell: true,
      });
    }
    console.log(`\n  [OK] ${fullLabel} completed successfully`);
    return true;
  } catch (err) {
    console.error(`\n  [FAIL] ${fullLabel} exited with error`);
    return false;
  }
}

/** Run full diagnostic suite (used by both non-interactive mode and "full" menu option). */
async function runFullDiagnostic() {
  console.log(`\n${"=".repeat(60)}`);
  console.log("  完整诊断报告 — Full Diagnostic Report");
  console.log(`${"=".repeat(60)}`);
  const results = [];

  results.push([
    "运行环境诊断",
    runCommand("运行环境诊断", "npm", ["meta:doctor:governance"]),
  ]);
  results.push([
    "安装验证",
    runCommand("安装状态诊断", "npm", ["meta:validate"]),
  ]);
  results.push([
    "运行时检查",
    runCommand("运行时镜像检查", "npm", ["meta:check:runtimes"]),
  ]);
  results.push([
    "全局同步检查",
    runCommand("全局同步检查", "npm", ["meta:check:global"]),
  ]);
  results.push([
    "运行时集成",
    runCommand("运行时集成诊断", "npm", ["meta:eval:agents"]),
  ]);

  console.log(`\n${"=".repeat(60)}`);
  console.log("  诊断汇总 — Diagnostic Summary");
  console.log(`${"=".repeat(60)}`);
  for (const [name, ok] of results) {
    const icon = ok ? "✓" : "✗";
    const color = ok ? "\x1b[32m" : "\x1b[31m";
    console.log(`  ${color}${icon}\x1b[0m ${name}`);
  }
  const passed = results.filter(([, ok]) => ok).length;
  console.log(`\n  通过: ${passed}/${results.length}`);
  if (passed === results.length) {
    console.log("  \x1b[32m全部通过 — All checks passed!\x1b[0m");
  } else {
    console.log(
      "  部分诊断失败 — Some checks failed. Review above for details.",
    );
  }
  console.log(`${"=".repeat(60)}\n`);
}

async function main() {
  // Detect non-interactive environment (e.g. Claude Code bash, CI)
  const isInteractive =
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    !process.env.TERM?.startsWith("dumb");

  if (!isInteractive) {
    console.log(
      `\n[INFO] Non-interactive mode detected — running full diagnostic...\n`,
    );
    await runFullDiagnostic();
    return;
  }

  console.log(`
╔═══════════════════════════════════════════════════╗
║          Meta_Kim 交互式诊断中心                   ║
║          Meta_Kim Interactive Diagnostics         ║
╚═══════════════════════════════════════════════════╝
`);

  const choices = [
    {
      name: "运行环境诊断 (recommended first)",
      value: "runtime",
      description: "检查 Node 版本、npm、Python 等基础运行环境",
    },
    {
      name: "安装状态诊断",
      value: "install",
      description: "验证项目验证 (npm run meta:validate) 和运行时镜像",
    },
    {
      name: "同步状态诊断",
      value: "sync",
      description:
        "检查 canonical/ -> .claude/.codex/openclaw/.cursor 同步状态",
    },
    {
      name: "运行时集成诊断",
      value: "agents",
      description: "运行时烟雾测试：CLI 可用性、注册表/配置脚手架",
    },
    {
      name: "完整诊断报告",
      value: "full",
      description: "运行所有诊断项并生成汇总报告",
    },
    {
      name: "退出",
      value: "exit",
      description: "退出诊断中心",
    },
  ];

  const menuChoices = choices.map((c) => ({
    name: `${c.name} — ${c.description}`,
    value: c.value,
  }));

  let running = true;
  while (running) {
    try {
      const answer = await select({
        message: "选择诊断项 (Choose a diagnostic):",
        choices: menuChoices,
        pageSize: 8,
      });

      switch (answer) {
        case "runtime":
          runCommand("运行环境诊断", "npm", ["meta:doctor:governance"]);
          break;

        case "install":
          runCommand("安装状态诊断 (meta:validate)", "npm", ["meta:validate"]);
          console.log("");
          runCommand("安装状态诊断 (meta:check:runtimes)", "npm", [
            "meta:check:runtimes",
          ]);
          break;

        case "sync":
          runCommand("同步状态诊断", "npm", ["meta:check:runtimes"]);
          console.log("");
          runCommand("同步状态诊断 (global)", "npm", ["meta:check:global"]);
          break;

        case "agents":
          runCommand("运行时集成诊断", "npm", ["meta:eval:agents"]);
          break;

        case "full":
          await runFullDiagnostic();
          break;

        case "exit":
          running = false;
          console.log("\n再见 — Goodbye!\n");
          break;
      }
    } catch (err) {
      // User pressed Ctrl+C or select was cancelled
      if (err.name === "ExitSilentError") {
        running = false;
        console.log("\n\n已退出 — Exited.\n");
      } else {
        throw err;
      }
    }
  }
}

main().catch((err) => {
  if (err.name !== "ExitSilentError") {
    console.error(`\nUnexpected error: ${err.message}`);
    process.exit(1);
  }
});
