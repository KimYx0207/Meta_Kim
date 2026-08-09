import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NPM_PACK_COMMAND = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npm";
const NPM_PACK_ARGS = process.platform === "win32"
  ? ["/d", "/s", "/c", "npm.cmd pack --dry-run --json --ignore-scripts"]
  : ["pack", "--dry-run", "--json", "--ignore-scripts"];

const DECISION_PACKAGE_FILES = [
  "src/adapters/claude/native-decision-surface-adapter.mjs",
  "src/adapters/codex/native-decision-surface-adapter.mjs",
  "src/data/schemas/decision.schema.json",
  "src/data/schemas/native-decision-authority.schema.json",
  "src/domain/decision/decision.mjs",
  "src/domain/decision/legacy-decision-projection.mjs",
  "src/domain/decision/native-decision-authority.mjs",
];
const GOVERNANCE_EVALUATOR = "src/domain/governance/governance-requirements.mjs";
const PACKAGE_SOURCE_FILES = [...DECISION_PACKAGE_FILES, GOVERNANCE_EVALUATOR].sort();
const IMPORT_CLOSURE_ROOTS = [
  "src/adapters/claude/native-decision-surface-adapter.mjs",
  "src/adapters/codex/native-decision-surface-adapter.mjs",
  "src/domain/decision/legacy-decision-projection.mjs",
  "src/domain/decision/native-decision-authority.mjs",
];

let packedFiles;

function packageFileSet() {
  if (packedFiles) return packedFiles;

  const result = spawnSync(NPM_PACK_COMMAND, NPM_PACK_ARGS, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    windowsHide: true,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const [pack] = JSON.parse(result.stdout);
  assert.ok(pack, "npm pack --dry-run did not return package metadata");
  packedFiles = new Set(pack.files.map(({ path: filePath }) => filePath));
  return packedFiles;
}

function resolvePackageRelativeImport(fromPath, specifier) {
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
}

test("M3 native Decision package closure is exact and does not widen src", () => {
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const sourceWhitelist = manifest.files.filter((entry) => entry.startsWith("src/")).sort();

  assert.deepEqual(sourceWhitelist, PACKAGE_SOURCE_FILES);
  assert.equal(
    manifest.files.some((entry) => /^src(?:\/|\/\*\*)?$/u.test(entry)),
    false,
    "package files must not contain a broad src/ or src/** entry",
  );

  const files = packageFileSet();
  const packedSourceFiles = [...files].filter((filePath) => filePath.startsWith("src/")).sort();
  assert.deepEqual(packedSourceFiles, PACKAGE_SOURCE_FILES);
  for (const requiredPath of DECISION_PACKAGE_FILES) {
    assert.ok(files.has(requiredPath), `packed package is missing ${requiredPath}`);
  }
});

test("both native adapters and the authority resolve only to files in the packed layout", () => {
  const files = packageFileSet();

  for (const importerPath of IMPORT_CLOSURE_ROOTS) {
    assert.ok(files.has(importerPath), `packed package is missing importer ${importerPath}`);
    const source = readFileSync(path.join(REPO_ROOT, importerPath), "utf8");
    const relativeSpecifiers = [...source.matchAll(/\bfrom\s+["'](\.[^"']+)["']/gu)]
      .map((match) => match[1]);

    assert.ok(relativeSpecifiers.length > 0, `${importerPath} must expose its relative import closure`);
    for (const specifier of relativeSpecifiers) {
      const resolvedPath = resolvePackageRelativeImport(importerPath, specifier);
      assert.ok(
        files.has(resolvedPath),
        `${importerPath} import ${specifier} resolves outside the packed package`,
      );
    }
  }
});
