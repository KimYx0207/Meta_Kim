import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SHARED_RUNTIME_HOOK_FILES } from "../../scripts/runtime-hook-mapping.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEPENDENCIES = ["spine-state-gates.mjs", "spine-state-utils.mjs"];
const FACADE = "spine-state.mjs";

function readSource(relativePath) {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

function sourceSlice(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${label} start marker missing`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${label} end marker missing`);
  return source.slice(start, end);
}

function assertDependenciesBeforeFacade(values, label) {
  const facadeIndex = values.indexOf(FACADE);
  assert.notEqual(facadeIndex, -1, `${label} facade missing`);
  for (const dependency of DEPENDENCIES) {
    const dependencyIndex = values.indexOf(dependency);
    assert.notEqual(dependencyIndex, -1, `${label} ${dependency} missing`);
    assert.ok(
      dependencyIndex < facadeIndex,
      `${label} must place ${dependency} before ${FACADE}`,
    );
  }
}

function runtimeLocalCopyLoop(source, runtime) {
  const pattern = new RegExp(
    `for \\(const hookName of \\[\\s*"project-root\\.mjs",([\\s\\S]*?)\\]\\) \\{\\s*` +
      `const sourcePath = await canonicalGlobalHookSource\\(hookName, "${runtime}"\\);`,
    "u",
  );
  const match = source.match(pattern);
  assert.ok(match, `${runtime} local ordered copy loop missing`);
  return match[0];
}

test("ordered shared, global, and setup hook lists place dependencies before facade", () => {
  assertDependenciesBeforeFacade(SHARED_RUNTIME_HOOK_FILES, "shared runtime hooks");

  const globalSource = readSource("scripts/sync-global-meta-theory.mjs");
  assertDependenciesBeforeFacade(
    sourceSlice(
      globalSource,
      "const GLOBAL_HOOK_PACKAGE_FILES = new Set([",
      "const GLOBAL_HOOK_PACKAGE_FILES_LEGACY",
      "global hook package",
    ),
    "global hook package",
  );

  const setupSource = readSource("setup.mjs");
  const sourceCandidates = sourceSlice(
    setupSource,
    "const PROJECT_HOOK_SOURCE_CANDIDATES = {",
    "function readProjectHookSource",
    "setup source candidates",
  );
  const whitelist = sourceSlice(
    setupSource,
    "const PROJECT_HOOK_FILE_WHITELIST_BY_PLATFORM = {",
    "// Remove Meta_Kim-managed hook files",
    "setup project whitelist",
  );
  for (const [label, block, startMarker, endMarker] of [
    ["setup Codex source candidates", sourceCandidates, "codex: [", "cursor: ["],
    ["setup Cursor source candidates", sourceCandidates, "cursor: [", "openclaw: ["],
    ["setup Codex project whitelist", whitelist, "codex: new Set([", "cursor: new Set(["],
    ["setup Cursor project whitelist", whitelist, "cursor: new Set([", "openclaw: new Set(["],
  ]) {
    assertDependenciesBeforeFacade(
      sourceSlice(block, startMarker, endMarker, label),
      label,
    );
  }
});

test("Codex and Cursor manual copy dependencies before the spine-state facade", () => {
  const syncSource = readSource("scripts/sync-runtimes.mjs");
  const codexCopy = runtimeLocalCopyLoop(syncSource, "codex");
  const cursorCopy = runtimeLocalCopyLoop(syncSource, "cursor");

  assertDependenciesBeforeFacade(codexCopy, "Codex manual copy");
  assertDependenciesBeforeFacade(cursorCopy, "Cursor manual copy");
});
