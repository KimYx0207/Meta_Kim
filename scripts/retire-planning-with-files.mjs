#!/usr/bin/env node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  directoryClosureSync,
  manifestPathFor,
  openRecorder,
  readManifest,
} from "./install-manifest.mjs";

export const RETIRED_PLANNING_DEPENDENCY_ID = "planning-with-files";

const MANIFEST_SOURCE = "install-global-skills-all-runtimes";
const MANIFEST_PURPOSE = "planning-with-files-global-skill";
const CODEX_WRAPPER_FILES = new Map([
  ["codex_hook_adapter.py", ["[planning-with-files]", "def run_shell_script", "HOOK_DIR"]],
  ["codex_hook_runner.mjs", ["collectWindowsPythonCandidatePaths", "INSTALL_TIME_PYTHON_HINT", "const scriptPath = process.argv[2]"]],
  ["session_start.py", ["import codex_hook_adapter as adapter", 'adapter.run_shell_script("session-start.sh"'] ],
  ["user_prompt_submit.py", ["import codex_hook_adapter as adapter", 'adapter.run_shell_script("user-prompt-submit.sh"'] ],
  ["pre_tool_use.py", ["import codex_hook_adapter as adapter", 'adapter.run_shell_script("pre-tool-use.sh"'] ],
  ["post_tool_use.py", ["import codex_hook_adapter as adapter", 'adapter.run_shell_script("post-tool-use.sh"'] ],
  ["stop.py", ["import codex_hook_adapter as adapter", 'adapter.run_shell_script("stop.sh"'] ],
]);

function normalizeForCompare(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertContained(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`retired_dependency_target_outside_runtime_home:${target}`);
}

async function assertPlainDirectoryChain(root, targetDirectory) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(targetDirectory);
  assertContained(resolvedRoot, resolvedTarget);
  if (!(await pathExists(resolvedRoot))) return;
  const rootStat = await fs.lstat(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`retired_dependency_runtime_home_not_plain_directory:${resolvedRoot}`);
  }
  const rootReal = await fs.realpath(resolvedRoot);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  const segments = relative ? relative.split(path.sep).filter(Boolean) : [];
  let current = resolvedRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!(await pathExists(current))) break;
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`retired_dependency_path_link_or_non_directory:${current}`);
    }
    const currentReal = await fs.realpath(current);
    assertContained(rootReal, currentReal);
  }
}

async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function aliasTargetsSkill(aliasPath, skillPath) {
  try {
    const stat = await fs.lstat(aliasPath);
    if (!stat.isSymbolicLink()) return false;
    const [aliasReal, skillReal] = await Promise.all([
      fs.realpath(aliasPath),
      fs.realpath(skillPath),
    ]);
    return normalizeForCompare(aliasReal) === normalizeForCompare(skillReal);
  } catch {
    return false;
  }
}

function commandIsRetiredPlanningHook(command) {
  const normalized = String(command ?? "").replace(/\\\\/gu, "\\").replace(/\\/gu, "/");
  if (!normalized.includes("/hooks/codex_hook_runner.mjs")) return false;
  return [...CODEX_WRAPPER_FILES.keys()]
    .filter((file) => file.endsWith(".py"))
    .some((file) => normalized.includes(`/hooks/${file}`));
}

function retiredPlanningHookReference(command, codexHome) {
  const normalized = String(command ?? "").replace(/\\\\/gu, "\\").replace(/\\/gu, "/");
  const normalizedHome = path.resolve(codexHome).replace(/\\/gu, "/");
  const compare = process.platform === "win32"
    ? normalized.toLowerCase()
    : normalized;
  const homeCompare = process.platform === "win32"
    ? normalizedHome.toLowerCase()
    : normalizedHome;
  const runnerPath = `${homeCompare}/hooks/codex_hook_runner.mjs`;
  if (!compare.includes(runnerPath)) return null;
  const wrapper = [...CODEX_WRAPPER_FILES.keys()]
    .filter((file) => file.endsWith(".py"))
    .find((file) => compare.includes(`${homeCompare}/hooks/${file}`)) ?? null;
  return { wrapper, runnerReferenced: true };
}

export function stripRetiredPlanningHooks(config = {}, {
  codexHome = null,
  verifiedOwnedFiles = null,
} = {}) {
  const next = structuredClone(config && typeof config === "object" ? config : {});
  const shouldRemove = (command) => {
    if (!codexHome || !(verifiedOwnedFiles instanceof Set)) {
      return commandIsRetiredPlanningHook(command);
    }
    const reference = retiredPlanningHookReference(command, codexHome);
    return Boolean(
      reference?.wrapper &&
      verifiedOwnedFiles.has("codex_hook_runner.mjs") &&
      verifiedOwnedFiles.has(reference.wrapper),
    );
  };
  const hooks = {};
  for (const [event, blocks] of Object.entries(next.hooks ?? {})) {
    if (!Array.isArray(blocks)) {
      hooks[event] = blocks;
      continue;
    }
    const keptBlocks = [];
    for (const block of blocks) {
      if (Array.isArray(block?.hooks)) {
        const keptHooks = block.hooks.filter(
          (hook) => !shouldRemove(hook?.command),
        );
        if (keptHooks.length > 0) keptBlocks.push({ ...block, hooks: keptHooks });
        continue;
      }
      if (!shouldRemove(block?.command)) keptBlocks.push(block);
    }
    if (keptBlocks.length > 0) hooks[event] = keptBlocks;
  }
  next.hooks = hooks;
  return next;
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.meta-kim-retire-${process.pid}-${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function inspectOwnedRegularFile(filePath, markers) {
  if (!(await pathExists(filePath))) return { state: "absent" };
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { state: "preserved", reason: "not_owned_regular_file" };
  }
  const source = await fs.readFile(filePath, "utf8");
  if (!markers.every((marker) => source.includes(marker))) {
    return { state: "preserved", reason: "ownership_markers_mismatch" };
  }
  return { state: "owned" };
}

function collectHookCommands(config) {
  const commands = [];
  for (const [event, blocks] of Object.entries(config?.hooks ?? {})) {
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (Array.isArray(block?.hooks)) {
        for (const hook of block.hooks) commands.push({ event, command: hook?.command });
      } else {
        commands.push({ event, command: block?.command });
      }
    }
  }
  return commands;
}

async function planOwnedCodexHooks(codexHome) {
  const hooksDir = path.join(codexHome, "hooks");
  assertContained(codexHome, hooksDir);
  await assertPlainDirectoryChain(codexHome, hooksDir);
  const removeFiles = [];
  const preserved = [];
  const verifiedOwnedFiles = new Set();

  for (const [fileName, markers] of CODEX_WRAPPER_FILES) {
    const filePath = path.join(hooksDir, fileName);
    assertContained(codexHome, filePath);
    const ownership = await inspectOwnedRegularFile(filePath, markers);
    if (ownership.state === "owned") {
      verifiedOwnedFiles.add(fileName);
      removeFiles.push(filePath);
    } else if (ownership.state === "preserved") {
      preserved.push({ path: filePath, reason: ownership.reason });
    }
  }

  const hooksJson = path.join(codexHome, "hooks.json");
  let hooksUpdate = null;
  if (await pathExists(hooksJson)) {
    const hooksStat = await fs.lstat(hooksJson);
    if (!hooksStat.isFile() || hooksStat.isSymbolicLink()) {
      preserved.push({ path: hooksJson, reason: "not_owned_regular_file" });
    } else {
      const original = JSON.parse(await fs.readFile(hooksJson, "utf8"));
    for (const entry of collectHookCommands(original)) {
      const reference = retiredPlanningHookReference(entry.command, codexHome);
      if (
        reference?.runnerReferenced &&
        (!reference.wrapper ||
          !verifiedOwnedFiles.has("codex_hook_runner.mjs") ||
          !verifiedOwnedFiles.has(reference.wrapper))
      ) {
        preserved.push({
          path: hooksJson,
          reason: `unverified_hook_registration:${entry.event}`,
        });
      }
    }
    const stripped = stripRetiredPlanningHooks(original, {
      codexHome,
      verifiedOwnedFiles,
    });
    if (JSON.stringify(original) !== JSON.stringify(stripped)) {
      hooksUpdate = { path: hooksJson, value: stripped };
    }
    }
  }

  const pycache = path.join(hooksDir, "__pycache__");
  if (await pathExists(pycache)) {
    const pycacheStat = await fs.lstat(pycache);
    if (!pycacheStat.isDirectory() || pycacheStat.isSymbolicLink()) {
      preserved.push({ path: pycache, reason: "unverified_python_cache_directory" });
      return { removeFiles, hooksUpdate, preserved };
    }
    for (const entry of await fs.readdir(pycache, { withFileTypes: true })) {
      if (!entry.isFile() || !/^codex_hook_adapter\..+\.pyc$/u.test(entry.name)) continue;
      const target = path.join(pycache, entry.name);
      assertContained(codexHome, target);
      if (
        verifiedOwnedFiles.has("codex_hook_adapter.py") &&
        /^codex_hook_adapter\.cpython-\d{2,3}(?:\.opt-[12])?\.pyc$/u.test(entry.name)
      ) {
        removeFiles.push(target);
      } else {
        preserved.push({ path: target, reason: "unverified_python_cache" });
      }
    }
  }
  return { removeFiles, hooksUpdate, preserved };
}

export async function retirePlanningWithFiles({ homes, targets, dryRun = false } = {}) {
  const selected = [...new Set(targets ?? Object.keys(homes ?? {}))]
    .filter((runtime) => homes?.[runtime]);
  const manifestPath = manifestPathFor("global");
  const manifest = readManifest(manifestPath);
  const recorder = manifest
    ? openRecorder({
        scope: "global",
        requireExistingValidManifest: true,
      })
    : null;
  const removed = [];
  const preserved = [];
  const plannedRemovals = [];
  const plannedManifestForgets = [];
  let plannedHooksUpdate = null;

  for (const runtime of selected) {
    const runtimeHome = path.resolve(homes[runtime]);
    const skillPath = path.join(runtimeHome, "skills", RETIRED_PLANNING_DEPENDENCY_ID);
    const aliasPath = path.join(runtimeHome, "plugins", RETIRED_PLANNING_DEPENDENCY_ID);
    assertContained(runtimeHome, skillPath);
    assertContained(runtimeHome, aliasPath);
    await assertPlainDirectoryChain(runtimeHome, path.dirname(skillPath));
    await assertPlainDirectoryChain(runtimeHome, path.dirname(aliasPath));
    const entry = (manifest?.entries ?? []).find(
      (candidate) =>
        normalizeForCompare(candidate.path) === normalizeForCompare(skillPath) &&
        candidate.source === MANIFEST_SOURCE &&
        candidate.purpose === MANIFEST_PURPOSE &&
        candidate.kind === "dir",
    );

    const skillExists = await pathExists(skillPath);
    const aliasExists = await pathExists(aliasPath);
    if (skillExists) {
      const skillStat = await fs.lstat(skillPath);
      if (!skillStat.isDirectory() || skillStat.isSymbolicLink()) {
        preserved.push({ path: skillPath, reason: "skill_path_not_plain_directory" });
        if (aliasExists) preserved.push({ path: aliasPath, reason: "skill_not_owned" });
        continue;
      }
      const closure = directoryClosureSync(skillPath);
      const owned = Boolean(
        entry && closure &&
        closure.sha256 === entry.directoryClosureSha256 &&
        closure.entryCount === entry.directoryClosureEntryCount,
      );
      if (!owned) {
        preserved.push({ path: skillPath, reason: "manifest_closure_mismatch" });
        if (aliasExists) {
          preserved.push({ path: aliasPath, reason: "skill_not_owned" });
        }
        continue;
      }
      if (aliasExists) {
        if (await aliasTargetsSkill(aliasPath, skillPath)) {
          plannedRemovals.push({ path: aliasPath, recursive: false });
        } else {
          preserved.push({ path: aliasPath, reason: "alias_target_mismatch" });
        }
      }
      plannedRemovals.push({ path: skillPath, recursive: true });
      plannedManifestForgets.push(skillPath);
    } else {
      if (aliasExists) {
        preserved.push({ path: aliasPath, reason: "orphan_alias_without_owned_skill" });
      }
      if (entry) plannedManifestForgets.push(skillPath);
    }
  }

  if (selected.includes("codex")) {
    const codexPlan = await planOwnedCodexHooks(path.resolve(homes.codex));
    plannedRemovals.push(...codexPlan.removeFiles.map((filePath) => ({
      path: filePath,
      recursive: false,
    })));
    plannedHooksUpdate = codexPlan.hooksUpdate;
    preserved.push(...codexPlan.preserved);
  }

  if (preserved.length > 0) {
    return {
      removed,
      preserved,
      manifest: { ok: true, changed: false, blockedByPreservedContent: true },
      dryRun,
    };
  }

  if (dryRun) {
    return {
      removed: [
        ...plannedRemovals.map((entry) => entry.path),
        ...(plannedHooksUpdate ? [plannedHooksUpdate.path] : []),
      ],
      preserved,
      manifest: { ok: true, changed: false, dryRun: true },
      dryRun,
    };
  }

  if (plannedHooksUpdate) {
    await writeJsonAtomic(plannedHooksUpdate.path, plannedHooksUpdate.value);
    removed.push(plannedHooksUpdate.path);
  }
  for (const operation of plannedRemovals) {
    await fs.rm(operation.path, {
      recursive: operation.recursive,
      force: true,
    });
    removed.push(operation.path);
  }
  for (const skillPath of plannedManifestForgets) {
    recorder?.forget(skillPath, MANIFEST_PURPOSE);
  }

  const manifestResult = !recorder
    ? { ok: true, changed: false, dryRun: false }
    : await recorder.flush();
  if (!manifestResult.ok) throw new Error(manifestResult.error);
  return { removed, preserved, manifest: manifestResult, dryRun };
}

async function main() {
  const home = os.homedir();
  const homes = {
    claude: process.env.META_KIM_CLAUDE_HOME || path.join(home, ".claude"),
    codex: process.env.META_KIM_CODEX_HOME || path.join(home, ".codex"),
    cursor: process.env.META_KIM_CURSOR_HOME || path.join(home, ".cursor"),
    openclaw: process.env.META_KIM_OPENCLAW_HOME || path.join(home, ".openclaw"),
  };
  const result = await retirePlanningWithFiles({
    homes,
    targets: Object.keys(homes),
    dryRun: process.argv.includes("--dry-run"),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.preserved.length > 0) process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await main();
}
