#!/usr/bin/env node
/**
 * Narrow governance health check: contract readable, Claude hook commands match
 * canonical required subset, runtime mirrors in sync, and sample run validation.
 */

import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  detectProfileCollision,
  ensureProfileState,
  getProfilePaths,
  toRepoRelative,
} from "./meta-kim-local-state.mjs";
import { resolveTargetContext } from "./meta-kim-sync-config.mjs";
import { buildMetaKimHooksTemplate } from "./claude-settings-merge.mjs";
import { collectHookRegistrations, inspectRequiredHooks } from "./hook-registration-diagnostics.mjs";
import { collectHookPromptDiagnostics, renderHookPromptDiagnostics } from "./hookprompt-diagnostics.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const execFileAsync = promisify(execFile);

const CONTRACT = path.join(
  repoRoot,
  "config",
  "contracts",
  "workflow-contract.json",
);
const SETTINGS = path.join(repoRoot, ".claude", "settings.json");
const FIXTURE = path.join(
  repoRoot,
  "tests",
  "fixtures",
  "run-artifacts",
  "valid-run.json",
);

async function checkGlobalClaudeHooksFallback(claudeHome = process.env.META_KIM_CLAUDE_HOME ?? path.join(os.homedir(), ".claude")) {
  const settingsPath = path.join(claudeHome, "settings.json");
  try {
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    const expected = buildMetaKimHooksTemplate(path.join(claudeHome, "hooks", "meta-kim"));
    const result = inspectRequiredHooks(settings.hooks, expected, { projectRoot: claudeHome });
    const prompts = collectHookRegistrations(settings.hooks).filter((item) => item.event === "UserPromptSubmit" && !item.matcher
      && ["user-prompt-submit.js", "hookprompt-adapter.mjs"].includes(path.basename((item.script || "").replace(/\\/gu, "/"))));
    let promptHealthy = false;
    for (const prompt of prompts) {
      try { if ((await fs.stat(prompt.script)).isFile()) promptHealthy = true; } catch { /* Missing scripts are unhealthy. */ }
    }
    const missingFiles = [];
    for (const row of collectHookRegistrations(expected)) {
      try { if (!(await fs.stat(row.script)).isFile()) missingFiles.push(row.script); }
      catch { missingFiles.push(row.script); }
    }
    if (!result.ok || !promptHealthy || missingFiles.length) {
      return { ok: false, reason: `global Claude hooks missing or invalid: ${JSON.stringify(result.missing)}${promptHealthy ? "" : "; prompt entry hook missing"}${missingFiles.length ? "; registered script missing: " + [...new Set(missingFiles)].join(", ") : ""}` };
    }
    return { ok: true, settingsPath, requiredCount: result.requiredCount };
  } catch (error) { return { ok: false, reason: `global Claude settings unreadable at ${settingsPath}: ${error.message}` }; }
}
async function checkContract() {
  const raw = await fs.readFile(CONTRACT, "utf8");
  const json = JSON.parse(raw);
  const v = json.schemaVersion;
  if (typeof v !== "number") {
    throw new Error(
      "workflow-contract.json: schemaVersion missing or not a number",
    );
  }
  return v;
}

export async function checkHooks({ settingsPath: providedSettingsPath, claudeHome, projectProjectionMode, projectRoot } = {}) {
  const settingsPath =
    providedSettingsPath ?? process.env.META_KIM_DOCTOR_PROJECT_SETTINGS ?? SETTINGS;
  let settings;
  try { settings = JSON.parse(await fs.readFile(settingsPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; settings = {}; }
  const hooks = settings.hooks;
  const canonical = JSON.parse(await fs.readFile(path.join(repoRoot, "canonical/runtime-assets/claude/settings.json"), "utf8"));
  const canonicalNames = new Set(collectHookRegistrations(canonical.hooks).map((item) => path.posix.basename(item.script)));
  const hasProjectManagedHooks = collectHookRegistrations(hooks).some((item) => canonicalNames.has(path.posix.basename((item.script || "").replace(/\\/gu, "/"))));
  if (!hasProjectManagedHooks) {
    if (projectProjectionMode === "project") throw new Error("Required project hooks missing: project projection mode requires canonical registrations");
    const globalFallback = await checkGlobalClaudeHooksFallback(claudeHome);
    if (globalFallback.ok) {
      return {
        mode: "global",
        settingsPath: globalFallback.settingsPath,
        requiredCount: globalFallback.requiredCount,
      };
    }
    throw new Error(
      `.claude/settings.json has no managed project hooks, and ${globalFallback.reason}`,
    );
  }
  const settingsDirectory = path.dirname(path.resolve(settingsPath));
  const trustedProjectRoot = projectRoot ? path.resolve(projectRoot)
    : path.basename(settingsDirectory).toLowerCase() === ".claude" ? path.dirname(settingsDirectory) : settingsDirectory;
  const result = inspectRequiredHooks(hooks, canonical.hooks, { projectRoot: trustedProjectRoot });
  if (!result.ok) throw new Error(`Required project hooks missing or invalid: ${JSON.stringify(result.missing)}`);
  return { mode: "project", settingsPath, requiredCount: result.requiredCount };
}

export function buildDoctorSyncCheckPlan(targetContext) {
  const projectProjectionMode =
    targetContext?.localOverrides?.projectProjectionMode ?? "project";
  const activeTargets = Array.isArray(targetContext?.activeTargets)
    ? targetContext.activeTargets
    : [];

  if (projectProjectionMode === "global_only") {
    return {
      skipped: false,
      projectProjectionMode,
      activeTargets,
      checkKind: "minimal_hook_closure",
      args: [
        path.join(repoRoot, "scripts", "sync-runtimes.mjs"),
        "--check",
        "--scope",
        "project",
      ],
    };
  }

  const args = [
    path.join(repoRoot, "scripts", "sync-runtimes.mjs"),
    "--check",
    "--scope",
    "project",
  ];
  if (activeTargets.length > 0) {
    args.push("--targets", activeTargets.join(","));
  }
  return {
    skipped: false,
    projectProjectionMode,
    activeTargets,
    checkKind: "full_project_projection",
    args,
  };
}

async function checkSync() {
  const targetContext = await resolveTargetContext();
  const plan = buildDoctorSyncCheckPlan(targetContext);
  const { stderr, stdout } = await execFileAsync(
    process.execPath,
    plan.args,
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (stderr && stderr.trim()) {
    process.stderr.write(stderr);
  }
  if (process.env.DOCTOR_GOVERNANCE_VERBOSE === "1" && stdout?.trim()) {
    process.stdout.write(stdout);
  }
  return plan;
}

async function checkValidateRun() {
  const artifactRel = path.relative(repoRoot, FIXTURE).replace(/\\/g, "/");
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [path.join(repoRoot, "scripts", "validate-run-artifact.mjs"), artifactRel],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (stderr?.trim()) {
    process.stderr.write(stderr);
  }
  let parsed;
  try {
    parsed = JSON.parse((stdout ?? "").trim() || "{}");
  } catch {
    throw new Error(
      `meta:validate:run output was not JSON: ${String(stdout).slice(0, 240)}`,
    );
  }
  if (!parsed.ok) {
    throw new Error("meta:validate:run reported ok: false");
  }
  if (process.env.DOCTOR_GOVERNANCE_VERBOSE === "1" && stdout?.trim()) {
    process.stdout.write(stdout);
  }
}

async function checkLocalState() {
  const collision = await detectProfileCollision({
    profile: process.env.META_KIM_PROFILE,
    runtimeFamily: process.env.META_KIM_RUNTIME_FAMILY,
  });
  if (collision.collision) {
    throw new Error(
      `profile collision detected: expected ${collision.expectedProfileKey}, found ${collision.existing?.profileKey}`,
    );
  }
  const state = await ensureProfileState();
  const targetContext = await resolveTargetContext();
  let runIndexReady = false;
  try {
    await fs.access(state.runIndexPath);
    runIndexReady = true;
  } catch {
    runIndexReady = false;
  }

  return {
    profile: state.profile,
    profileKey: state.metadata.profileKey,
    runtimeFamily: state.runtimeFamily,
    activeTargets: targetContext.activeTargets,
    supportedTargets: targetContext.supportedTargets,
    runIndexReady,
    runIndexPath: toRepoRelative(state.runIndexPath),
    compactionDir: toRepoRelative(state.compactionDir),
  };
}

async function writeDoctorCache({
  profile,
  failed,
  canonicalLines,
  mirrorLines,
  runtimeLines,
  localLines,
}) {
  const state = getProfilePaths({ profile });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const cacheFile = path.join(state.doctorCacheDir, `${timestamp}.json`);
  const cache = {
    timestamp,
    nodeVersion: process.version,
    passed: !failed,
    sections: {
      canonical: canonicalLines.join("\n"),
      mirror: mirrorLines.join("\n"),
      runtime: runtimeLines.join("\n"),
      local: localLines.join("\n"),
    },
    profile,
    profileKey: state.profileKey,
  };
  await fs.writeFile(cacheFile, JSON.stringify(cache, null, 2), "utf8");
  // Also write latest.json symlink-equivalent (overwrite)
  const latest = path.join(state.doctorCacheDir, "latest.json");
  await fs.writeFile(latest, JSON.stringify(cache, null, 2), "utf8");
  console.log(`  [cache] written to ${toRepoRelative(cacheFile)}`);
}

async function main() {
  console.log("meta-kim doctor:governance");
  const canonicalLines = [];
  const mirrorLines = [];
  const runtimeLines = [];
  const localLines = [];
  let failed = false;
  let profile = "default";

  try {
    const schemaVersion = await checkContract();
    canonicalLines.push(
      `  [ok] workflow-contract.json schemaVersion=${schemaVersion}`,
    );
  } catch (e) {
    failed = true;
    canonicalLines.push(`  [fail] contract: ${e.message}`);
  }

  try {
    await checkValidateRun();
    canonicalLines.push(
      `  [ok] meta:validate:run on ${path.relative(repoRoot, FIXTURE).replace(/\\/g, "/")}`,
    );
  } catch (e) {
    failed = true;
    canonicalLines.push(`  [fail] meta:validate:run: ${e.message}`);
    if (e.stderr) {
      canonicalLines.push(String(e.stderr).trim());
    }
  }

  try {
    const syncStatus = await checkSync();
    mirrorLines.push(
      syncStatus.checkKind === "minimal_hook_closure"
        ? "  [ok] global_only project safety surface (minimal Claude/Codex/Cursor Hook closure and cleanup state)"
        : `  [ok] npm run meta:check:runtimes (mirrors match canonical; targets=${syncStatus.activeTargets.join(",") || "default"})`,
    );
  } catch (e) {
    failed = true;
    mirrorLines.push(`  [fail] sync: ${e.message}`);
    if (e.stderr) {
      mirrorLines.push(String(e.stderr).trim());
    }
  }

  try {
    const hookTarget = await resolveTargetContext();
    const hookStatus = await checkHooks({ projectProjectionMode: hookTarget.localOverrides?.projectProjectionMode });
    runtimeLines.push(
      hookStatus.mode === "global"
        ? `  [ok] Claude global Meta_Kim hooks (${hookStatus.settingsPath})`
        : `  [ok] .claude/settings.json required hooks (${hookStatus.requiredCount} canonical registrations; user hooks preserved)`,
    );
  } catch (e) {
    failed = true;
    runtimeLines.push(`  [fail] hooks: ${e.message}`);
    if (e.stderr) {
      runtimeLines.push(String(e.stderr).trim());
    }
  }

  try {
    const localState = await checkLocalState();
    profile = localState.profile;
    localLines.push(
      `  [ok] profile=${localState.profile} runtime=${localState.runtimeFamily} key=${localState.profileKey}`,
    );
    localLines.push(
      `  [ok] activeTargets=${localState.activeTargets.join(", ")} supportedTargets=${localState.supportedTargets.join(", ")}`,
    );
    localLines.push(
      `  [ok] run index ${localState.runIndexReady ? "ready" : "not-built-yet"}: ${localState.runIndexPath}`,
    );
    localLines.push(`  [ok] compaction dir: ${localState.compactionDir}`);
  } catch (e) {
    failed = true;
    localLines.push(`  [fail] local state: ${e.message}`);
  }

  console.log("Canonical health");
  console.log(canonicalLines.join("\n"));
  console.log("Mirror health");
  console.log(mirrorLines.join("\n"));
  console.log("Runtime health");
  console.log(runtimeLines.join("\n"));
  console.log(renderHookPromptDiagnostics(collectHookPromptDiagnostics({ projectRoot: repoRoot })));
  console.log("Local index health");
  console.log(localLines.join("\n"));

  // Write cache last (non-blocking for the overall result)
  try {
    await writeDoctorCache({
      profile,
      failed,
      canonicalLines,
      mirrorLines,
      runtimeLines,
      localLines,
    });
  } catch (e) {
    console.error(`  [warn] failed to write doctor cache: ${e.message}`);
  }

  if (failed) {
    console.error(
      "\nDoctor finished with failures. Fix the items above, then run: npm run meta:sync && npm run meta:validate",
    );
    process.exitCode = 1;
  } else {
    console.log("\nAll governance doctor checks passed.");
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
