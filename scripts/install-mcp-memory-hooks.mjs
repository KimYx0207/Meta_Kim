/**
 * install-mcp-memory-hooks.mjs
 *
 * Installs MCP Memory Service Claude Code hooks (SessionStart).
 *
 * What this script does (in order):
 *   1. Copy the canonical Python hook from canonical/runtime-assets/claude/memory-hooks/
 *      to ~/.claude/hooks/mcp_memory_global.py
 *   2. Seed ~/.claude/hooks/config.json from config.template.json if not present
 *      (NEVER overwrite an existing config — user customizations are preserved)
 *   3. Register the SessionStart hook in ~/.claude/settings.json
 *   4. Warn if MCP server not responding on http://localhost:8888
 *
 * Usage:
 *   node scripts/install-mcp-memory-hooks.mjs           # Install (idempotent)
 *   node scripts/install-mcp-memory-hooks.mjs --check   # Dry-run: verify only, no side effects
 *   node scripts/install-mcp-memory-hooks.mjs --remove  # Uninstall SessionStart hook (keeps files)
 *
 * Exit codes:
 *   0  success
 *   1  non-fatal warnings occurred (hook copied but registration failed)
 *   2  fatal: canonical source asset missing
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// ── Paths ──────────────────────────────────────────────

const CANONICAL_HOOK_DIR = join(
  REPO_ROOT,
  "canonical",
  "runtime-assets",
  "claude",
  "memory-hooks",
);
const CANONICAL_HOOK_SOURCE = join(CANONICAL_HOOK_DIR, "mcp_memory_global.py");
const CANONICAL_CONFIG_TEMPLATE = join(
  CANONICAL_HOOK_DIR,
  "config.template.json",
);

const HOOKS_TARGET_DIR = join(homedir(), ".claude", "hooks");
const HOOK_TARGET = join(HOOKS_TARGET_DIR, "mcp_memory_global.py");
const CONFIG_TARGET = join(HOOKS_TARGET_DIR, "config.json");
const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");

// ── Formatting helpers ──────────────────────────────────

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

function info(msg) {
  console.log(`  ${dim("→")} ${msg}`);
}
function ok(msg) {
  console.log(`  ${green("✓")} ${msg}`);
}
function warn(msg) {
  console.log(`  ${yellow("⚠")} ${msg}`);
}
function fail(msg) {
  console.log(`  ${red("✗")} ${msg}`);
}

// ── Core helpers ────────────────────────────────────────

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf8",
    shell: false,
    ...opts,
  });
}

function checkServerHealth(url = "http://localhost:8888/api/health") {
  try {
    const result = run("curl", ["-s", "--max-time", "2", url]);
    if (result.status === 0 && result.stdout) {
      const data = JSON.parse(result.stdout);
      return data.status === "healthy";
    }
  } catch {
    // fall through
  }
  return false;
}

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    info(`Created ${dir}`);
  }
}

function filesEqual(a, b) {
  if (!existsSync(a) || !existsSync(b)) return false;
  try {
    return readFileSync(a, "utf8") === readFileSync(b, "utf8");
  } catch {
    return false;
  }
}

function copyHookFile() {
  if (!existsSync(CANONICAL_HOOK_SOURCE)) {
    fail(`Canonical hook source missing: ${CANONICAL_HOOK_SOURCE}`);
    info(
      "This is a Meta_Kim packaging bug — canonical/runtime-assets/claude/memory-hooks/ should ship with the repo.",
    );
    return false;
  }

  if (filesEqual(CANONICAL_HOOK_SOURCE, HOOK_TARGET)) {
    ok(`Hook already up-to-date: ${HOOK_TARGET}`);
    return true;
  }

  try {
    copyFileSync(CANONICAL_HOOK_SOURCE, HOOK_TARGET);
    ok(`Hook copied → ${HOOK_TARGET}`);
    return true;
  } catch (err) {
    fail(`Failed to copy hook: ${err.message}`);
    return false;
  }
}

function seedConfigIfMissing() {
  if (existsSync(CONFIG_TARGET)) {
    ok(`Config already present (preserved): ${CONFIG_TARGET}`);
    return true;
  }

  if (!existsSync(CANONICAL_CONFIG_TEMPLATE)) {
    warn(`Config template missing: ${CANONICAL_CONFIG_TEMPLATE}`);
    info("Hook will use defaults from environment variables.");
    return false;
  }

  try {
    copyFileSync(CANONICAL_CONFIG_TEMPLATE, CONFIG_TARGET);
    ok(`Config seeded → ${CONFIG_TARGET}`);
    return true;
  } catch (err) {
    warn(`Failed to seed config: ${err.message}`);
    return false;
  }
}

function pickPythonCommand() {
  // Prefer explicit python3, fall back to python. The hook itself targets 3.10+.
  const candidates =
    process.platform === "win32"
      ? ["python", "python3"]
      : ["python3", "python"];
  for (const cmd of candidates) {
    try {
      const result = run(cmd, ["--version"]);
      if (result.status === 0) return cmd;
    } catch {
      // try next
    }
  }
  return "python"; // last resort
}

function registerSessionStartHook() {
  if (!existsSync(CLAUDE_SETTINGS)) {
    warn(`${CLAUDE_SETTINGS} not found — skipping hook registration`);
    return false;
  }

  try {
    const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8"));
    const pythonCmd = pickPythonCommand();

    const existingBlocks = settings.hooks?.SessionStart ?? [];
    const alreadyRegistered = existingBlocks.some((b) =>
      b?.hooks?.some((h) => h?.command?.includes("mcp_memory_global.py")),
    );

    if (alreadyRegistered) {
      ok("SessionStart hook already registered");
      return true;
    }

    const nextSettings = {
      ...settings,
      hooks: {
        ...(settings.hooks ?? {}),
        SessionStart: [
          ...existingBlocks,
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: `${pythonCmd} "${HOOK_TARGET}"`,
              },
            ],
          },
        ],
      },
    };

    writeFileSync(
      CLAUDE_SETTINGS,
      JSON.stringify(nextSettings, null, 2) + "\n",
    );
    ok("SessionStart hook registered in settings.json");
    return true;
  } catch (err) {
    warn(`Failed to register hook: ${err.message}`);
    return false;
  }
}

function removeSessionStartHook() {
  if (!existsSync(CLAUDE_SETTINGS)) return;
  try {
    const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8"));
    if (!settings.hooks?.SessionStart) return;

    const filteredBlocks = settings.hooks.SessionStart.map((block) => ({
      ...block,
      hooks: (block?.hooks ?? []).filter(
        (h) => !h?.command?.includes("mcp_memory_global.py"),
      ),
    })).filter((block) => (block.hooks ?? []).length > 0);

    const nextHooks = { ...settings.hooks };
    if (filteredBlocks.length === 0) {
      delete nextHooks.SessionStart;
    } else {
      nextHooks.SessionStart = filteredBlocks;
    }

    const nextSettings = { ...settings, hooks: nextHooks };
    if (Object.keys(nextHooks).length === 0) delete nextSettings.hooks;

    writeFileSync(
      CLAUDE_SETTINGS,
      JSON.stringify(nextSettings, null, 2) + "\n",
    );
    ok("SessionStart hook removed from settings.json");
  } catch (err) {
    warn(`Failed to remove hook: ${err.message}`);
  }
}

// ── Commands ────────────────────────────────────────────

function install() {
  console.log(`\n${bold("Installing MCP Memory Claude Code hooks...")}\n`);

  ensureDir(HOOKS_TARGET_DIR);

  const hookCopied = copyHookFile();
  if (!hookCopied) {
    console.log(
      `\n${red("Installation aborted: hook file could not be placed.")}\n`,
    );
    process.exit(2);
  }

  seedConfigIfMissing();
  const registered = registerSessionStartHook();

  console.log("");
  info("Checking MCP Memory Service health...");
  const healthy = checkServerHealth();
  if (healthy) {
    ok("MCP Memory Service is running on http://localhost:8888");
  } else {
    warn("MCP Memory Service is NOT responding on http://localhost:8888");
    info("Start it with: python -m mcp_memory_service");
    info("Or:            uv run memory server -s hybrid");
  }

  if (!registered) {
    warn(
      "SessionStart hook not registered — Claude Code may need a restart or manual config",
    );
    console.log(
      `\n${yellow("Done with warnings.")} Restart Claude Code to load the hook.\n`,
    );
    process.exit(1);
  }

  console.log(
    `\n${green("Done!")} Restart Claude Code for hooks to take effect.\n`,
  );
}

function check() {
  console.log(`\n${bold("Checking MCP Memory hook installation...")}\n`);

  const sourceExists = existsSync(CANONICAL_HOOK_SOURCE);
  sourceExists
    ? ok(`Canonical source present: ${CANONICAL_HOOK_SOURCE}`)
    : fail(`Canonical source MISSING: ${CANONICAL_HOOK_SOURCE}`);

  const targetExists = existsSync(HOOK_TARGET);
  targetExists
    ? ok(`Hook installed: ${HOOK_TARGET}`)
    : warn(`Hook not installed at ${HOOK_TARGET}`);

  if (sourceExists && targetExists) {
    const inSync = filesEqual(CANONICAL_HOOK_SOURCE, HOOK_TARGET);
    inSync
      ? ok("Hook content in sync with canonical")
      : warn("Hook content DIFFERS from canonical (run install to update)");
  }

  const configExists = existsSync(CONFIG_TARGET);
  configExists
    ? ok(`Config present: ${CONFIG_TARGET}`)
    : warn(`Config missing: ${CONFIG_TARGET}`);

  const settingsExists = existsSync(CLAUDE_SETTINGS);
  if (settingsExists) {
    try {
      const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8"));
      const registered = (settings.hooks?.SessionStart ?? []).some((b) =>
        b?.hooks?.some((h) => h?.command?.includes("mcp_memory_global.py")),
      );
      registered
        ? ok("SessionStart hook registered in settings.json")
        : warn("SessionStart hook NOT registered");
    } catch {
      warn("Could not parse settings.json");
    }
  } else {
    warn(`settings.json not found: ${CLAUDE_SETTINGS}`);
  }

  const healthy = checkServerHealth();
  healthy
    ? ok("MCP Memory Service responding on :8888")
    : warn("MCP Memory Service NOT responding on :8888");

  console.log("");
}

function remove() {
  console.log(
    `\n${bold("Removing MCP Memory Claude Code hook registration...")}\n`,
  );

  removeSessionStartHook();
  info(`Hook file retained (manual delete: rm "${HOOK_TARGET}")`);
  info(`Config retained (manual delete: rm "${CONFIG_TARGET}")`);
  ok("Done.\n");
}

// ── Main ────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--check")) {
  check();
} else if (args.includes("--remove")) {
  remove();
} else {
  install();
}
