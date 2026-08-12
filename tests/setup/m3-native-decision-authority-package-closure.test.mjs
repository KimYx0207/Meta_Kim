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
  "src/adapters/claude/sdk-decision-host-adapter.mjs",
  "src/adapters/codex/app-server-decision-host-adapter.mjs",
  "src/adapters/codex/native-decision-surface-adapter.mjs",
  "src/data/repositories/native-host-answer-repository.mjs",
  "src/data/schemas/decision.schema.json",
  "src/data/schemas/native-decision-authority.schema.json",
  "src/data/schemas/native-host-answer-authority.schema.json",
  "src/domain/decision/decision.mjs",
  "src/domain/decision/legacy-decision-projection.mjs",
  "src/domain/decision/native-decision-authority.mjs",
  "src/domain/decision/native-host-answer-authority.mjs",
];
const GOVERNANCE_EVALUATOR = "src/domain/governance/governance-requirements.mjs";
const LEASE_CLAIM_AUTHORITY_DOMAIN = "src/domain/claims/lease-claim-authority-shadow.mjs";
const EVIDENCE_TRANSITION_DOMAIN = "src/domain/evidence/evidence-transition.mjs";
const CONTINUATION_POLICY_DOMAIN = "src/domain/continuation/continuation-policy-shadow.mjs";
const SCHEDULER_AUTHORITY_REUSE_DOMAIN = "src/domain/scheduling/scheduler-authority-reuse-shadow.mjs";
const QUOTA_USAGE_PROJECTION_DOMAIN = "src/domain/quota/quota-usage-projection.mjs";
const RUNTIME_HEALTH_PROJECTION_DOMAIN = "src/domain/runtime/runtime-health-projection.mjs";
const TODO_SAFE_PROGRESS_DOMAIN = "src/domain/work/todo-dependency-safe-progress-shadow.mjs";
const READ_ONLY_SURFACE_SOURCE_FILES = [
  "src/domain/shared/canonical-digest.mjs",
  "src/domain/presentation/read-only-run-projection-schema.mjs",
  "src/domain/presentation/read-only-run-projection-surfaces.mjs",
  "src/application/presentation/build-read-only-run-projection-surfaces.mjs",
  "src/data/projections/read-only-run-authority-snapshot.mjs",
  "src/presentation/run-surfaces/read-only-run-surface-renderers.mjs",
];
const DATA_EVENT_REPOSITORY_SOURCE_FILES = [
  "src/domain/execution/durable-run-repository-semantics.mjs",
  "src/application/ports/durable-run-repository-port.mjs",
  "src/application/run/open-durable-run-repository.mjs",
  "src/data/repositories/sqlite-durable-run-repository.mjs",
  "src/data/sqlite/runtime.mjs",
  "src/data/sqlite/transaction.mjs",
];
const SETUP_INSTALLER_DECOMPOSITION_SOURCE_FILES = [
  "src/application/installer/ensure-stable-global-projection-package.mjs",
  "src/infrastructure/installer/projection-package-boundary.mjs",
];
const KNOWLEDGE_LIFECYCLE_SOURCE_FILES = [
  "src/application/evolution/apply-knowledge-lifecycle-transition.mjs",
  "src/application/ports/knowledge-lifecycle-registry-port.mjs",
  "src/data/repositories/json-knowledge-lifecycle-registry-repository.mjs",
  "src/domain/evolution/knowledge-lifecycle.mjs",
  "src/domain/evolution/warden-writeback-approval.mjs",
];
const PACKAGE_SOURCE_FILES = [
  ...DECISION_PACKAGE_FILES,
  LEASE_CLAIM_AUTHORITY_DOMAIN,
  CONTINUATION_POLICY_DOMAIN,
  EVIDENCE_TRANSITION_DOMAIN,
  GOVERNANCE_EVALUATOR,
  QUOTA_USAGE_PROJECTION_DOMAIN,
  RUNTIME_HEALTH_PROJECTION_DOMAIN,
  SCHEDULER_AUTHORITY_REUSE_DOMAIN,
  TODO_SAFE_PROGRESS_DOMAIN,
  ...READ_ONLY_SURFACE_SOURCE_FILES,
  ...DATA_EVENT_REPOSITORY_SOURCE_FILES,
  ...SETUP_INSTALLER_DECOMPOSITION_SOURCE_FILES,
  ...KNOWLEDGE_LIFECYCLE_SOURCE_FILES,
].sort();
const IMPORT_CLOSURE_ROOTS = [
  "src/adapters/claude/native-decision-surface-adapter.mjs",
  "src/adapters/claude/sdk-decision-host-adapter.mjs",
  "src/adapters/codex/app-server-decision-host-adapter.mjs",
  "src/adapters/codex/native-decision-surface-adapter.mjs",
  "src/data/repositories/native-host-answer-repository.mjs",
  "src/domain/decision/legacy-decision-projection.mjs",
  "src/domain/decision/native-decision-authority.mjs",
  "src/domain/decision/native-host-answer-authority.mjs",
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
