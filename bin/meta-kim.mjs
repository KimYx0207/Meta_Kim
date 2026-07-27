#!/usr/bin/env node
/** Stable CLI for npx / npm i -g. All paths resolve from the package root. */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSetupCliArgs } from "../scripts/setup-cli-policy.mjs";
import {
  getStatusCliCopy,
  resolveMetaKimCliLanguage,
} from "../scripts/meta-kim-i18n.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const callerCwd = process.cwd();
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const rawArgs = process.argv.slice(2);
while (["meta-kim", "--"].includes(rawArgs[0])) rawArgs.shift();

function languageValue(args) {
  const equals = args.find((arg) => arg.startsWith("--lang="));
  if (equals) return equals.slice("--lang=".length);
  const index = args.indexOf("--lang");
  return index >= 0 ? args[index + 1] ?? null : null;
}

function resolvedLanguage(args = rawArgs) {
  return resolveMetaKimCliLanguage(languageValue(args)).language;
}

function statusCopy(args = rawArgs) {
  return getStatusCliCopy(resolvedLanguage(args));
}

function renderHelp(language = resolvedLanguage()) {
  const status = getStatusCliCopy(language);
  return `Meta_Kim ${packageJson.version}

${status.usageHeading}:
  meta-kim [install] [options]
  meta-kim update [options]
  meta-kim check [options]
  ${status.usage}
  meta-kim doctor
  meta-kim doctor hooks [--fix] [--project|--all] [--project-root <dir>]
  meta-kim release audit --tag <tag> [--verification-report <file>] [--package-file <tgz>] [--require-exact] [--json]
  meta-kim release close --issue <P-NNN> --prd <repo-relative-file> [--profile default] [--json]
  meta-kim mcp serve
  meta-kim uninstall [--yes] [--deep] [--scope=global|project|both]
  meta-kim project bootstrap [--project-dir <dir>] [--dry-run|--apply] [--json]
  meta-kim project capability copy --project-dir <dir> --runtime <runtime> --type <agent|skill|command> --id <id> --source <path> --mode <create|iterate> [--apply] [--json]

${status.hooksNote}

${status.optionsHeading}:
  -h, --help       ${status.helpOption}
  -v, --version    ${status.versionOption}
`;
}

const commands = new Set(["install", "update", "check", "status", "doctor", "release", "uninstall", "project", "mcp"]);

function fail(message, copy = statusCopy()) {
  console.error(`meta-kim: ${message}`);
  console.error(copy.usageHint);
  process.exit(2);
}

function validateSetupOptions(args) {
  try {
    validateSetupCliArgs(args);
  } catch (error) {
    fail(error.message);
  }
}

function validateScopeOptions(args, copy = getStatusCliCopy("en")) {
  for (const arg of args) {
    if (!arg.startsWith("--scope=")) continue;
    const scope = arg.slice("--scope=".length);
    if (!["global", "project", "both"].includes(scope)) {
      fail(copy.invalidScope(scope), copy);
    }
  }
}

function validateDoctorHooksOptions(args) {
  const allowedFlags = new Set([
    "--fix",
    "--all",
    "--project",
    "--silent",
    "--help",
    "-h",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (allowedFlags.has(arg) || arg.startsWith("--lang=")) continue;
    if (["--lang", "--project-root"].includes(arg)) {
      if (!args[index + 1] || args[index + 1].startsWith("--")) {
        fail(`${arg} requires a value`);
      }
      index += 1;
      continue;
    }
    fail(`unknown doctor hooks option '${arg}'`);
  }
  if (args.includes("--all") && args.includes("--project")) {
    fail("doctor hooks accepts only one of --all or --project");
  }
}

function statusOptionTokens(args) {
  const tokens = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--lang") {
      if (!args[index + 1] || args[index + 1].startsWith("--")) {
        fail(statusCopy(args).missingLang, statusCopy(args));
      }
      index += 1;
      continue;
    }
    tokens.push(arg);
  }
  return tokens;
}

function renderConciseStatus(payload, copy) {
  const findings = Array.isArray(payload.findings) ? payload.findings : [];
  const runtimes = [...new Set(findings.map((item) => item.runtime).filter(Boolean))];
  return [
    copy.title,
    `${copy.scope}: ${payload.scope}`,
    `${copy.found}: ${findings.length}`,
    `${copy.manifest}: ${payload.manifest?.entries ?? copy.none}`,
    `${copy.runtimes}: ${runtimes.length ? runtimes.join(", ") : copy.none}`,
    `${copy.portable}: ${payload.machinePortable?.portable ? copy.yes : copy.no}`,
    ...(!payload.machinePortable?.portable ? [copy.portabilityReason] : []),
    "",
    copy.uninstallDryRun,
    copy.uninstallApply,
    copy.details,
    copy.machine,
    copy.diff,
  ].join("\n");
}

function runConciseStatus(args, copy) {
  const forwarded = args.filter((arg) => !["--details", "--verbose"].includes(arg));
  const result = spawnSync(process.execPath, [join(root, "scripts/footprint.mjs"), "--json", ...forwarded], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status === null ? 1 : result.status);
  }
  process.stdout.write(`${renderConciseStatus(JSON.parse(result.stdout), copy)}\n`);
  process.exit(0);
}

function run(relativeScript, args = []) {
  const result = spawnSync(process.execPath, [join(root, relativeScript), ...args], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      // The public bin is the trust boundary for relative CLI paths. Never let
      // a polluted parent environment retarget project mutations.
      META_KIM_CALLER_CWD: callerCwd,
    },
  });
  process.exit(result.status === null ? 1 : result.status);
}

if (rawArgs.length === 1 && ["-h", "--help", "help"].includes(rawArgs[0])) {
  console.log(renderHelp());
  process.exit(0);
}
if (rawArgs.length === 1 && ["-v", "--version", "version"].includes(rawArgs[0])) {
  console.log(packageJson.version);
  process.exit(0);
}

const first = rawArgs[0];
const command = commands.has(first) ? first : "install";
const commandArgs = command === "install" && first !== "install" ? rawArgs : rawArgs.slice(1);

switch (command) {
  case "install":
    validateSetupOptions(commandArgs);
    run("setup.mjs", commandArgs);
    break;
  case "update":
    validateSetupOptions(commandArgs);
    run("setup.mjs", ["--update", ...commandArgs]);
    break;
  case "check":
    validateSetupOptions(commandArgs);
    run("setup.mjs", ["--check", ...commandArgs]);
    break;
  case "status":
    {
    const copy = statusCopy(commandArgs);
    const optionTokens = statusOptionTokens(commandArgs);
    const unknown = optionTokens.find(
      (arg) =>
        !["--json", "--diff", "--details", "--verbose", "--help", "-h"].includes(arg) &&
        !arg.startsWith("--scope=") &&
        !arg.startsWith("--lang="),
    );
    if (unknown) {
      fail(copy.unknown(unknown), copy);
    }
    validateScopeOptions(commandArgs, copy);
    if (optionTokens.includes("--help") || optionTokens.includes("-h")) {
      console.log(renderHelp(resolvedLanguage(commandArgs)));
      process.exit(0);
    }
    if (
      optionTokens.includes("--json") ||
      optionTokens.includes("--diff") ||
      optionTokens.includes("--details") ||
      optionTokens.includes("--verbose")
    ) {
      run(
        "scripts/footprint.mjs",
        commandArgs.filter((arg) => !["--details", "--verbose"].includes(arg)),
      );
    }
    runConciseStatus(commandArgs, copy);
    }
    break;
  case "doctor":
    if (commandArgs.length === 0) {
      run("scripts/doctor-interactive.mjs");
    }
    if (commandArgs[0] !== "hooks") {
      fail(`unknown doctor subcommand '${commandArgs[0]}'`);
    }
    validateDoctorHooksOptions(commandArgs.slice(1));
    if (commandArgs.slice(1).some((arg) => ["--help", "-h"].includes(arg))) {
      console.log(renderHelp(resolvedLanguage(commandArgs.slice(1))));
      process.exit(0);
    }
    run(
      "scripts/doctor-hooks.mjs",
      commandArgs.slice(1).some((arg) => ["--all", "--project"].includes(arg))
        ? commandArgs.slice(1)
        : ["--project", ...commandArgs.slice(1)],
    );
    break;
  case "release":
    if (commandArgs[0] === "audit") {
      run("scripts/audit-release-binding.mjs", commandArgs.slice(1));
    }
    if (commandArgs[0] === "close") {
      run("scripts/record-release-planning-closure.mjs", commandArgs.slice(1));
    }
    fail("release subcommand must be 'audit' or 'close'");
    break;
  case "uninstall":
    if (commandArgs.some((arg) => !["--yes", "--deep"].includes(arg) && !arg.startsWith("--scope="))) {
      fail(`unknown uninstall option '${commandArgs.find((arg) => !["--yes", "--deep"].includes(arg) && !arg.startsWith("--scope="))}'`);
    }
    validateScopeOptions(commandArgs);
    run("scripts/uninstall.mjs", commandArgs);
    break;
  case "project":
    if (commandArgs[0] === "bootstrap") {
      validateSetupOptions(commandArgs.slice(1));
      run("setup.mjs", ["--project-bootstrap", ...commandArgs.slice(1)]);
    }
    if (commandArgs[0] === "capability" && commandArgs[1] === "copy") {
      run("scripts/project-capability-copy.mjs", commandArgs.slice(2));
    }
    fail("project subcommand must be 'bootstrap' or 'capability copy'");
    break;
  case "mcp":
    if (!['serve', 'self-test'].includes(commandArgs[0]) || commandArgs.length !== 1) {
      fail("mcp subcommand must be 'serve' or 'self-test'");
    }
    run("scripts/mcp/meta-runtime-server.mjs", commandArgs[0] === "self-test" ? ["--self-test"] : []);
    break;
}
