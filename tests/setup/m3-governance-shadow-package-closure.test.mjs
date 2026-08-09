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
const EVALUATOR_PATH = "src/domain/governance/governance-requirements.mjs";
const ADAPTER_PATH = "scripts/governed-execution/governance-requirements-shadow-adapter.mjs";
const RUNNER_PATH = "scripts/run-meta-theory-governed-execution.mjs";
const APPROVED_DECISION_CLOSURE = [
  "src/adapters/claude/native-decision-surface-adapter.mjs",
  "src/adapters/codex/native-decision-surface-adapter.mjs",
  "src/data/schemas/decision.schema.json",
  "src/data/schemas/native-decision-authority.schema.json",
  "src/domain/decision/decision.mjs",
  "src/domain/decision/legacy-decision-projection.mjs",
  "src/domain/decision/native-decision-authority.mjs",
];
const APPROVED_SOURCE_CLOSURE = [EVALUATOR_PATH, ...APPROVED_DECISION_CLOSURE].sort();
const UNRELATED_SOURCE_PATHS = [
  "src/data/schemas/governance-requirements.schema.json",
];

function packageFileSet() {
  const result = spawnSync(
    NPM_PACK_COMMAND,
    NPM_PACK_ARGS,
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      windowsHide: true,
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const [pack] = JSON.parse(result.stdout);
  assert.ok(pack, "npm pack --dry-run did not return package metadata");
  return new Set(pack.files.map(({ path: filePath }) => filePath));
}

function resolvePackageRelativeImport(fromPath, specifier) {
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
}

test("M3 Governance evaluator remains in the exact approved M3 source package closure", () => {
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const sourceWhitelist = manifest.files.filter((entry) => entry.startsWith("src/")).sort();

  assert.deepEqual(sourceWhitelist, APPROVED_SOURCE_CLOSURE);
  assert.equal(
    manifest.files.some((entry) => /^src(?:\/|\/\*\*)?$/u.test(entry)),
    false,
    "package files must not contain a broad src/ or src/** entry",
  );

  const files = packageFileSet();
  const packedSourceFiles = [...files].filter((filePath) => filePath.startsWith("src/")).sort();
  assert.deepEqual(packedSourceFiles, APPROVED_SOURCE_CLOSURE);
  for (const requiredPath of [EVALUATOR_PATH, ADAPTER_PATH, RUNNER_PATH]) {
    assert.ok(files.has(requiredPath), `packed package is missing ${requiredPath}`);
  }
  for (const excludedPath of UNRELATED_SOURCE_PATHS) {
    assert.ok(!files.has(excludedPath), `packed package must exclude ${excludedPath}`);
  }
});

test("M3 Governance shadow adapter resolves its packaged evaluator dependency", () => {
  const adapterSource = readFileSync(path.join(REPO_ROOT, ADAPTER_PATH), "utf8");
  const runnerSource = readFileSync(path.join(REPO_ROOT, RUNNER_PATH), "utf8");
  const evaluatorImport = adapterSource.match(/from\s+["'](\.\.\/\.\.\/src\/domain\/governance\/governance-requirements\.mjs)["']/);

  assert.ok(evaluatorImport, "shadow adapter must import the Governance evaluator relatively");
  assert.equal(
    resolvePackageRelativeImport(ADAPTER_PATH, evaluatorImport[1]),
    EVALUATOR_PATH,
    "installed package-relative adapter import must resolve to the evaluator",
  );
  assert.match(
    runnerSource,
    /from\s+["']\.\/governed-execution\/governance-requirements-shadow-adapter\.mjs["']/,
    "governed runner must import the packaged shadow adapter",
  );

  const files = packageFileSet();
  assert.ok(files.has(EVALUATOR_PATH));
  assert.ok(files.has(ADAPTER_PATH));
  assert.ok(files.has(RUNNER_PATH));
});
