#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildIsolatedUserHomeEnv } from "./isolated-user-home-env.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keepTemp = process.argv.includes("--keep-temp");
const PROJECTION_PACKAGE_RECEIPT_PURPOSE =
  "primary-runtime-global-projection-package-runtime-bundle:receipt";

const projectCases = [
  {
    id: "project-claude",
    targets: ["claude"],
    present: ["CLAUDE.md", ".claude/settings.json", ".mcp.json"],
    absent: ["AGENTS.md", ".codex", ".agents", ".cursor", "openclaw"],
  },
  {
    id: "project-codex",
    targets: ["codex"],
    present: ["AGENTS.md", ".codex/hooks.json", ".agents/skills/meta-theory/SKILL.md"],
    absent: ["CLAUDE.md", ".claude", ".cursor", "openclaw"],
  },
  {
    id: "project-cursor",
    targets: ["cursor"],
    present: [
      "AGENTS.md",
      ".cursor/hooks.json",
      ".cursor/mcp.json",
      ".cursor/rules",
      ".cursor/skills/meta-theory/SKILL.md",
    ],
    absent: ["CLAUDE.md", ".claude", ".codex", ".agents", "openclaw"],
  },
  {
    id: "project-openclaw",
    targets: ["openclaw"],
    present: [
      "AGENTS.md",
      "openclaw/openclaw.template.json",
      "openclaw/skills/meta-theory/SKILL.md",
      "openclaw/workspaces",
    ],
    absent: ["CLAUDE.md", ".claude", ".codex", ".agents", ".cursor"],
  },
  {
    id: "project-default-claude-codex",
    targets: ["claude", "codex"],
    present: [
      "CLAUDE.md",
      "AGENTS.md",
      ".claude/settings.json",
      ".codex/hooks.json",
      ".agents/skills/meta-theory/SKILL.md",
      ".mcp.json",
    ],
    absent: [".cursor", "openclaw"],
  },
  {
    id: "project-all-explicit",
    targets: ["claude", "codex", "openclaw", "cursor"],
    present: [
      "CLAUDE.md",
      "AGENTS.md",
      ".claude/settings.json",
      ".codex/hooks.json",
      ".mcp.json",
      ".cursor/hooks.json",
      ".cursor/mcp.json",
      "openclaw/openclaw.template.json",
      "openclaw/skills/meta-theory/SKILL.md",
      ".agents/skills/meta-theory/SKILL.md",
    ],
    absent: [],
  },
];

function toFsPath(root, relPath) {
  return path.join(root, ...relPath.split("/"));
}

function existsRel(root, relPath) {
  return existsSync(toFsPath(root, relPath));
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function normalizedPathText(value) {
  const normalized = String(value).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function stablePackageRootFromManifest(manifest) {
  const receiptEntry = manifest?.entries?.find((entry) =>
    entry.source === "sync-global-meta-theory" &&
    entry.purpose === PROJECTION_PACKAGE_RECEIPT_PURPOSE &&
    entry.kind === "file"
  );
  if (!receiptEntry || !existsSync(receiptEntry.path)) return null;
  const receipt = readJson(receiptEntry.path);
  if (typeof receipt.packageRootRelative !== "string") return null;
  const packageRoot = path.resolve(path.dirname(receiptEntry.path), receipt.packageRootRelative);
  return existsSync(packageRoot) ? packageRoot : null;
}

function hookCommands(config) {
  return Object.values(config?.hooks ?? {}).flatMap((blocks) =>
    (blocks ?? []).flatMap((block) => block.hooks ?? [])
  ).map((hook) => hook.command).filter((command) => typeof command === "string");
}

const runtimeCompatibilityCatalog = readJson(
  path.join(repoRoot, "config", "runtime-compatibility-catalog.json"),
);

function productIdsByTier(tier) {
  return (runtimeCompatibilityCatalog.products ?? [])
    .filter((product) => product.tier === tier)
    .map((product) => product.id);
}

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 300_000,
    windowsHide: true,
    env: { ...process.env, ...(options.env ?? {}) },
  });
}

function failPacket(result) {
  return {
    status: result.status,
    error: result.error?.message,
    stdoutTail: result.stdout?.slice(-2000) ?? "",
    stderrTail: result.stderr?.slice(-2000) ?? "",
  };
}

function parseSetupJson(result) {
  if (result.status !== 0) {
    return { ok: false, error: failPacket(result) };
  }
  try {
    return { ok: true, payload: JSON.parse(result.stdout) };
  } catch (error) {
    return {
      ok: false,
      error: {
        message: error.message,
        stdoutTail: result.stdout?.slice(-2000) ?? "",
      },
    };
  }
}

function inspectProjectCase(baseDir, entry) {
  const projectDir = path.join(baseDir, entry.id);
  const projectUserHome = path.join(baseDir, "project-user-home");
  const projectEnv = buildIsolatedUserHomeEnv(projectUserHome);
  const targetExistedBeforeDryRun = existsSync(projectDir);
  const targetsArg = entry.targets.join(",");
  const commonArgs = [
    "setup.mjs",
    "--project-bootstrap",
    "--targets",
    targetsArg,
    "--project-dir",
    projectDir,
    "--json",
  ];
  const dryResult = runNode([...commonArgs, "--dry-run"], { env: projectEnv });
  const dryParsed = parseSetupJson(dryResult);
  const targetCreatedByDryRun = !targetExistedBeforeDryRun && existsSync(projectDir);
  const applyResult = runNode([...commonArgs, "--apply"], { env: projectEnv });
  const applyParsed = parseSetupJson(applyResult);
  const currentResult = runNode([...commonArgs, "--dry-run"], { env: projectEnv });
  const currentParsed = parseSetupJson(currentResult);
  const manifestPath = toFsPath(projectDir, ".meta-kim/state/default/project-bootstrap.json");
  const manifest = existsSync(manifestPath) ? readJson(manifestPath) : null;

  const missingExpected = entry.present.filter((relPath) => !existsRel(projectDir, relPath));
  const unexpectedPresent = entry.absent.filter((relPath) => existsRel(projectDir, relPath));
  const activeTargets = manifest?.activeTargets ?? [];
  const globalWrites =
    dryParsed.payload?.results?.[0]?.writePreview?.globalWrites ??
    applyParsed.payload?.results?.[0]?.writePreview?.globalWrites ??
    null;
  const targetMismatch =
    JSON.stringify(activeTargets) !== JSON.stringify(entry.targets) ? activeTargets : null;
  const ok =
    dryParsed.ok &&
    !targetCreatedByDryRun &&
    applyParsed.ok &&
    currentParsed.ok &&
    missingExpected.length === 0 &&
    unexpectedPresent.length === 0 &&
    !targetMismatch &&
    Array.isArray(globalWrites) &&
    globalWrites.length === 0 &&
    currentParsed.payload?.results?.[0]?.state?.status === "ready" &&
    currentParsed.payload?.results?.[0]?.state?.requiresConfirmation === false &&
    currentParsed.payload?.results?.[0]?.state?.counts?.pending === 0 &&
    (currentParsed.payload?.results?.[0]?.writePreview?.projectWrites ?? []).length === 0;

  return {
    id: entry.id,
    layer: "project",
    targets: entry.targets,
    status: ok ? "pass" : "fail",
    targetCreatedByDryRun,
    dryRunStatus: dryParsed.payload?.results?.[0]?.state?.status ?? null,
    applyStatus: applyParsed.payload?.results?.[0]?.state?.status ?? null,
    postApplyDryRunStatus: currentParsed.payload?.results?.[0]?.state?.status ?? null,
    postApplyRequiresConfirmation:
      currentParsed.payload?.results?.[0]?.state?.requiresConfirmation ?? null,
    postApplyPendingCount: currentParsed.payload?.results?.[0]?.state?.counts?.pending ?? null,
    postApplyProjectWrites:
      currentParsed.payload?.results?.[0]?.writePreview?.projectWrites?.length ?? null,
    manifestTargets: activeTargets,
    missingExpected,
    unexpectedPresent,
    globalWrites,
    managedCount: manifest?.managedFiles?.length ?? 0,
    skippedCount: manifest?.skippedFiles?.length ?? 0,
    errors: [dryParsed.error, applyParsed.error, currentParsed.error].filter(Boolean),
  };
}

function listTopLevel(root) {
  try {
    return readdirSync(root).sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function countFiles(root) {
  if (!existsSync(root)) return 0;
  const stat = statSync(root);
  if (!stat.isDirectory()) return 1;
  let count = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    count += countFiles(path.join(root, entry.name));
  }
  return count;
}

function inspectGlobalSync(baseDir, { id, targets, withGlobalHooks = false }) {
  const userHome = path.join(baseDir, id, "user-home");
  const homes = {
    claude: path.join(userHome, ".claude"),
    codex: path.join(userHome, ".codex"),
    cursor: path.join(userHome, ".cursor"),
    openclaw: path.join(userHome, ".openclaw"),
  };
  const env = {
    USERPROFILE: userHome,
    HOME: userHome,
    META_KIM_CLAUDE_HOME: homes.claude,
    META_KIM_CODEX_HOME: homes.codex,
    META_KIM_CURSOR_HOME: homes.cursor,
    META_KIM_OPENCLAW_HOME: homes.openclaw,
  };
  const args = [
    "scripts/sync-global-meta-theory.mjs",
    "--targets",
    targets.join(","),
  ];
  if (withGlobalHooks) args.push("--with-global-hooks");
  const result = runNode(args, { env });
  const manifestPath = path.join(userHome, ".meta-kim", "install-manifest.json");
  const manifest = existsSync(manifestPath) ? readJson(manifestPath) : null;
  const requiredChecks = {};
  if (targets.includes("claude")) {
    requiredChecks.claudeSkill = existsRel(homes.claude, "skills/meta-theory/SKILL.md");
    requiredChecks.claudeCommand = existsRel(homes.claude, "commands/meta-theory.md");
    if (withGlobalHooks) {
      requiredChecks.claudeGlobalHooks = existsRel(
        homes.claude,
        "hooks/meta-kim/activate-meta-theory-spine.mjs",
      );
    }
  }
  if (targets.includes("codex")) {
    requiredChecks.codexSkill = existsRel(homes.codex, "skills/meta-theory/SKILL.md");
    requiredChecks.codexCommand = existsRel(homes.codex, "commands/meta-theory.md");
    requiredChecks.codexConfig = existsRel(homes.codex, "config.toml");
    if (withGlobalHooks) {
      requiredChecks.codexGlobalHooks = existsRel(
        homes.codex,
        "hooks/meta-kim/activate-meta-theory-spine.mjs",
      );
      const codexHooksJsonPath = path.join(homes.codex, "hooks.json");
      const codexHooksJson = existsSync(codexHooksJsonPath)
        ? readJson(codexHooksJsonPath)
        : null;
      const stablePackageRoot = stablePackageRootFromManifest(manifest);
      const commands = hookCommands(codexHooksJson).map(normalizedPathText);
      const stablePackageRootText = stablePackageRoot
        ? normalizedPathText(stablePackageRoot)
        : null;
      const repoRootText = normalizedPathText(repoRoot);
      requiredChecks.codexGlobalHooksJson =
        stablePackageRootText !== null &&
        commands.some((command) =>
          command.includes("activate-meta-theory-spine.mjs") &&
          command.includes("--package-root") &&
          command.includes(stablePackageRootText)
        ) &&
        commands.every((command) => !command.includes(repoRootText));
    }
  }
  if (targets.includes("cursor")) {
    requiredChecks.cursorSkill = existsRel(homes.cursor, "skills/meta-theory/SKILL.md");
  }
  if (targets.includes("openclaw")) {
    requiredChecks.openclawSkill = existsRel(homes.openclaw, "skills/meta-theory/SKILL.md");
  }
  const untouchedChecks = {};
  if (!targets.includes("cursor")) {
    untouchedChecks.cursorHomeUntouched = listTopLevel(homes.cursor).length === 0;
  }
  if (!targets.includes("openclaw")) {
    untouchedChecks.openclawHomeUntouched =
      listTopLevel(homes.openclaw).length === 0;
  }
  const checks = { ...requiredChecks, ...untouchedChecks };
  const ok = result.status === 0 && Object.values(checks).every(Boolean);
  return {
    id,
    layer: "global",
    targets,
    status: ok ? "pass" : "fail",
    checks,
    requiredChecks,
    untouchedChecks,
    manifestEntries: manifest?.entries?.length ?? 0,
    manifestPath: existsSync(manifestPath) ? manifestPath : null,
    homeFileCounts: {
      claude: countFiles(homes.claude),
      codex: countFiles(homes.codex),
      cursor: countFiles(homes.cursor),
      openclaw: countFiles(homes.openclaw),
    },
    errors: result.status === 0 ? [] : [failPacket(result)],
  };
}

function classification() {
  return {
    globalLayer: {
      purpose: "Reusable capability layer in runtime homes; it does not enable governance for every project by itself.",
      defaultTargets: ["claude", "codex"],
      platformSupportTiers: {
        sourceOfTruth: "config/runtime-compatibility-catalog.json",
        formalProjectionTargets: productIdsByTier("runtime_projection"),
        defaultSelectedTargets: ["claude", "codex"],
        nonDefaultFormalProjectionTargets: ["openclaw", "cursor"],
        dependencyInstallTargets: productIdsByTier("dependency_install_target"),
        candidateProbeTargets: productIdsByTier("candidate_probe"),
        boundary:
          "Claude Code, Codex, OpenClaw, and Cursor are formal Meta_Kim projection targets; dependency_install_target and candidate_probe products are not project projections.",
      },
      selectedByDefault: [
        {
          runtime: "claude",
          surfaces: ["~/.claude/skills/meta-theory/", "~/.claude/commands/meta-theory.md"],
          notes: "Global hooks/settings are advanced opt-in, not default.",
        },
        {
          runtime: "codex",
          surfaces: [
            "~/.codex/skills/meta-theory/",
            "~/.codex/commands/meta-theory.md",
            "~/.codex/config.toml choice-surface controls",
          ],
        },
      ],
      nonDefaultFormalTargets: [
        "~/.cursor/skills/meta-theory/",
        "~/.openclaw/skills/meta-theory/",
      ],
    },
    projectLayer: {
      purpose: "Directory-authorized runtime projection generated only for activeTargets.",
      defaultTargets: ["claude", "codex"],
      targetSurfaces: {
        claude: ["CLAUDE.md", ".claude/", ".mcp.json"],
        codex: ["AGENTS.md", ".codex/"],
        cursor: ["AGENTS.md context", ".cursor/agents/", ".cursor/rules/", ".cursor/skills/", ".cursor/hooks.json", ".cursor/mcp.json"],
        openclaw: ["AGENTS.md team/context material", "openclaw/workspaces/", "openclaw/skills/", "openclaw/hooks/", "openclaw/openclaw.template.json"],
      },
      alwaysRecordsOnApply: [".meta-kim/state/default/project-bootstrap.json", ".meta-kim/backups/project-bootstrap/<timestamp> when existing files are backed up"],
    },
  };
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-install-scope-"));
let summary;
try {
  const projectResults = projectCases.map((entry) => inspectProjectCase(tempRoot, entry));
  const globalResults = [
    inspectGlobalSync(tempRoot, {
      id: "global-default-claude-codex",
      targets: ["claude", "codex"],
      withGlobalHooks: true,
    }),
    inspectGlobalSync(tempRoot, {
      id: "global-all-formal-targets",
      targets: ["claude", "codex", "cursor", "openclaw"],
      withGlobalHooks: true,
    }),
  ];
  const results = [...projectResults, ...globalResults];
  summary = {
    schemaVersion: "meta-kim-install-scope-verification-v0.1",
    ok: results.every((entry) => entry.status === "pass"),
    repoRoot,
    tempRoot: keepTemp ? tempRoot : null,
    generatedAt: new Date().toISOString(),
    classification: classification(),
    projectResults,
    globalResults,
  };
} finally {
  if (!keepTemp) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

console.log(`${JSON.stringify(summary, null, 2)}\n`);
if (!summary.ok) {
  process.exitCode = 1;
}
