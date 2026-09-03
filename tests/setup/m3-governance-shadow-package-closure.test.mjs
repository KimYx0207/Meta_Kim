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
const GOVERNANCE_REQUIREMENT_CUTOVER_SOURCE_PATHS = [
  "src/data/schemas/governance-requirement-plan.schema.json",
  "src/domain/governance/governance-requirement-cutover.mjs",
];
const GOVERNANCE_REQUIREMENT_CUTOVER_PACKAGE_PATHS = [
  "config/contracts/governance-requirement-cutover-contract.json",
  "config/governance/governance-requirement-rollout.json",
  "scripts/governed-execution/governance-requirement-legacy-adapter.mjs",
];
const LEASE_CLAIM_AUTHORITY_PATH = "src/domain/claims/lease-claim-authority-shadow.mjs";
const EVIDENCE_TRANSITION_PATH = "src/domain/evidence/evidence-transition.mjs";
const CONTINUATION_POLICY_PATH = "src/domain/continuation/continuation-policy-shadow.mjs";
const SCHEDULER_AUTHORITY_REUSE_PATH = "src/domain/scheduling/scheduler-authority-reuse-shadow.mjs";
const QUOTA_USAGE_PROJECTION_PATH = "src/domain/quota/quota-usage-projection.mjs";
const RUNTIME_HEALTH_PROJECTION_PATH = "src/domain/runtime/runtime-health-projection.mjs";
const TODO_SAFE_PROGRESS_PATH = "src/domain/work/todo-dependency-safe-progress-shadow.mjs";
const CANDIDATE_RUNTIME_ADAPTER_PATHS = [
  "src/runtimes/deepseek-harness/candidate-adapter.mjs",
  "src/runtimes/qoder/candidate-adapter.mjs",
  "src/runtimes/trae/candidate-adapter.mjs",
  "src/runtimes/zcode/candidate-adapter.mjs",
];
const BETA_RUNTIME_ADAPTER_BUNDLE_PATHS = [
  "src/application/installer/beta-runtime-adapter-bundle.mjs",
  "src/infrastructure/installer/beta-runtime-adapter-bundle.mjs",
];
const READ_ONLY_SURFACE_SOURCE_PATHS = [
  "src/domain/shared/canonical-digest.mjs",
  "src/domain/presentation/read-only-run-projection-schema.mjs",
  "src/domain/presentation/read-only-run-projection-surfaces.mjs",
  "src/application/presentation/build-read-only-run-projection-surfaces.mjs",
  "src/data/projections/read-only-run-authority-snapshot.mjs",
  "src/presentation/run-surfaces/read-only-run-surface-renderers.mjs",
];
const DATA_EVENT_REPOSITORY_SOURCE_PATHS = [
  "src/domain/execution/durable-run-repository-semantics.mjs",
  "src/application/ports/durable-run-repository-port.mjs",
  "src/application/run/open-durable-run-repository.mjs",
  "src/data/repositories/sqlite-durable-run-repository.mjs",
  "src/data/sqlite/runtime.mjs",
  "src/data/sqlite/transaction.mjs",
];
const SETUP_INSTALLER_DECOMPOSITION_SOURCE_PATHS = [
  "src/application/installer/ensure-stable-global-projection-package.mjs",
  "src/infrastructure/installer/projection-package-boundary.mjs",
];
const KNOWLEDGE_LIFECYCLE_SOURCE_PATHS = [
  "src/domain/evolution/knowledge-lifecycle.mjs",
  "src/domain/evolution/warden-writeback-approval.mjs",
  "src/application/evolution/apply-knowledge-lifecycle-transition.mjs",
  "src/application/ports/knowledge-lifecycle-registry-port.mjs",
  "src/data/repositories/json-knowledge-lifecycle-registry-repository.mjs",
];
const LIVE_L02_L04_SOURCE_PATHS = [
  "src/domain/live/live-continuation-command.mjs",
  "src/domain/live/live-share-artifact.mjs",
  "src/application/live/build-live-share-artifact.mjs",
  "src/application/live/live-acceptance-fixture-loader.mjs",
  "src/application/live/live-catalog-scan-policy.mjs",
  "src/application/live/live-control-room-service.mjs",
  "src/application/live/live-conversation-link-vocabulary.mjs",
  "src/application/live/live-default-selection.mjs",
  "src/application/live/live-display-format.mjs",
  "src/application/live/live-graph-camera.mjs",
  "src/application/live/live-hub-lifecycle-budget.mjs",
  "src/application/live/live-record-origin.mjs",
  "src/application/live/live-replay-visibility.mjs",
  "src/application/live/live-run-retention.mjs",
  "src/application/live/live-run-substance.mjs",
  "src/application/live/live-run-visibility.mjs",
  "src/application/live/live-scheduling-projection.mjs",
  "src/application/live/live-spacing-scale.mjs",
  "src/application/live/live-status-vocabulary.mjs",
  "src/application/live/live-stream-policy.mjs",
  "src/application/live/live-typography-scale.mjs",
  "src/application/live/live-viewport-budget.mjs",
  "src/application/live/plan-live-continuation.mjs",
  "src/infrastructure/live/live-continuation-command-store.mjs",
  "src/infrastructure/live/live-control-room-server.mjs",
  "src/infrastructure/live/live-hub-lifecycle.mjs",
  "src/infrastructure/live/live-hub-project-catalog.mjs",
  "src/infrastructure/live/live-read-repository.mjs",
  "src/infrastructure/live/live-run-retention-store.mjs",
  "src/infrastructure/live/live-runtime-adapter-registry.mjs",
  "src/presentation/live/live-control-room-page.mjs",
  "src/presentation/live/render-live-share-card.mjs",
  "src/sdk/live/common.mjs",
  "src/sdk/live/evidence-card.mjs",
  "src/sdk/live/index.mjs",
  "src/sdk/live/replay-theme.mjs",
  "src/sdk/live/runtime-adapter.mjs",
];
const LIVE_PRESENTATION_ASSET_PATHS = [
  "src/presentation/live/assets/meta-kim-k-mark.png",
  "src/presentation/live/assets/meta-kim-live.ico",
];
const LIVE_L02_L04_PACKAGE_FILES = [
  "config/contracts/meta-kim-live-share-schema.json",
  "scripts/meta-kim-live.mjs",
];
const ADAPTER_PATH = "scripts/governed-execution/governance-requirements-shadow-adapter.mjs";
const LEASE_CLAIM_AUTHORITY_ADAPTER_PATH = "scripts/governed-execution/lease-claim-authority-shadow-adapter.mjs";
const EVIDENCE_TRANSITION_ADAPTER_PATH = "scripts/governed-execution/evidence-transition-shadow-adapter.mjs";
const CONTINUATION_POLICY_ADAPTER_PATH = "scripts/governed-execution/continuation-policy-shadow-adapter.mjs";
const SCHEDULER_AUTHORITY_REUSE_ADAPTER_PATH = "scripts/governed-execution/scheduler-authority-reuse-shadow-adapter.mjs";
const QUOTA_USAGE_PROJECTION_ADAPTER_PATH = "scripts/governed-execution/quota-usage-projection-adapter.mjs";
const RUNTIME_HEALTH_PROJECTION_ADAPTER_PATH = "scripts/governed-execution/runtime-health-projection-adapter.mjs";
const TODO_SAFE_PROGRESS_ADAPTER_PATH = "scripts/governed-execution/todo-dependency-safe-progress-shadow-adapter.mjs";
const STAGE_RUNNER_BRIDGE_PATH = "scripts/governed-execution/stage-runner-bridge.mjs";
const RUNNER_PATH = "scripts/run-meta-theory-governed-execution.mjs";
const APPROVED_DECISION_CLOSURE = [
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
const APPROVED_SOURCE_CLOSURE = [
  EVALUATOR_PATH,
  ...GOVERNANCE_REQUIREMENT_CUTOVER_SOURCE_PATHS,
  LEASE_CLAIM_AUTHORITY_PATH,
  EVIDENCE_TRANSITION_PATH,
  CONTINUATION_POLICY_PATH,
  SCHEDULER_AUTHORITY_REUSE_PATH,
  QUOTA_USAGE_PROJECTION_PATH,
  RUNTIME_HEALTH_PROJECTION_PATH,
  TODO_SAFE_PROGRESS_PATH,
  ...READ_ONLY_SURFACE_SOURCE_PATHS,
  ...DATA_EVENT_REPOSITORY_SOURCE_PATHS,
  ...SETUP_INSTALLER_DECOMPOSITION_SOURCE_PATHS,
  ...KNOWLEDGE_LIFECYCLE_SOURCE_PATHS,
  ...LIVE_L02_L04_SOURCE_PATHS,
  ...LIVE_PRESENTATION_ASSET_PATHS,
  ...CANDIDATE_RUNTIME_ADAPTER_PATHS,
  ...BETA_RUNTIME_ADAPTER_BUNDLE_PATHS,
  ...APPROVED_DECISION_CLOSURE,
].sort();
const UNRELATED_SOURCE_PATHS = [
  "src/data/schemas/governance-requirements.schema.json",
  "src/domain/claims/lease-claim-authority-projection.mjs",
  "scripts/governed-execution/lease-claim-authority-projection-adapter.mjs",
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
  for (const requiredPath of LIVE_L02_L04_PACKAGE_FILES) {
    assert.ok(manifest.files.includes(requiredPath), `package.files is missing ${requiredPath}`);
    assert.ok(files.has(requiredPath), `packed package is missing ${requiredPath}`);
  }
  const packedSourceFiles = [...files].filter((filePath) => filePath.startsWith("src/")).sort();
  assert.deepEqual(packedSourceFiles, APPROVED_SOURCE_CLOSURE);
  for (const requiredPath of [EVALUATOR_PATH, ADAPTER_PATH, RUNNER_PATH]) {
    assert.ok(files.has(requiredPath), `packed package is missing ${requiredPath}`);
  }
  for (const requiredPath of GOVERNANCE_REQUIREMENT_CUTOVER_PACKAGE_PATHS) {
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
  assert.match(
    runnerSource,
    /from\s+["']\.\/governed-execution\/governance-requirement-legacy-adapter\.mjs["']/,
    "governed runner must import the packaged legacy snapshot adapter",
  );
  assert.match(
    runnerSource,
    /from\s+["']\.\.\/src\/domain\/governance\/governance-requirement-cutover\.mjs["']/,
    "governed runner must import the packaged cutover controller",
  );

  const files = packageFileSet();
  assert.ok(files.has(EVALUATOR_PATH));
  assert.ok(files.has(ADAPTER_PATH));
  assert.ok(files.has(RUNNER_PATH));
  for (const requiredPath of [
    ...GOVERNANCE_REQUIREMENT_CUTOVER_SOURCE_PATHS,
    ...GOVERNANCE_REQUIREMENT_CUTOVER_PACKAGE_PATHS,
  ]) {
    assert.ok(files.has(requiredPath), `packed package is missing ${requiredPath}`);
  }
});

test("M3-A01 Evidence shadow resolves Domain inward and stays on the existing packaged bridge path", () => {
  const adapterSource = readFileSync(path.join(REPO_ROOT, EVIDENCE_TRANSITION_ADAPTER_PATH), "utf8");
  const bridgeSource = readFileSync(path.join(REPO_ROOT, STAGE_RUNNER_BRIDGE_PATH), "utf8");
  const domainImport = adapterSource.match(/from\s+["'](\.\.\/\.\.\/src\/domain\/evidence\/evidence-transition\.mjs)["']/);

  assert.ok(domainImport, "Evidence shadow adapter must import the pure Evidence Domain relatively");
  assert.equal(
    resolvePackageRelativeImport(EVIDENCE_TRANSITION_ADAPTER_PATH, domainImport[1]),
    EVIDENCE_TRANSITION_PATH,
    "installed package-relative adapter import must resolve to the Evidence Domain",
  );
  assert.match(
    bridgeSource,
    /from\s+["']\.\/evidence-transition-shadow-adapter\.mjs["']/,
    "the existing stage runner bridge must import the packaged Evidence shadow adapter",
  );

  const files = packageFileSet();
  for (const requiredPath of [
    EVIDENCE_TRANSITION_PATH,
    EVIDENCE_TRANSITION_ADAPTER_PATH,
    STAGE_RUNNER_BRIDGE_PATH,
  ]) {
    assert.ok(files.has(requiredPath), `packed package is missing ${requiredPath}`);
  }
});

test("M3-A02 Continuation shadow resolves Domain inward and stays non-authoritative on the packaged bridge path", () => {
  const domainSource = readFileSync(path.join(REPO_ROOT, CONTINUATION_POLICY_PATH), "utf8");
  const adapterSource = readFileSync(path.join(REPO_ROOT, CONTINUATION_POLICY_ADAPTER_PATH), "utf8");
  const bridgeSource = readFileSync(path.join(REPO_ROOT, STAGE_RUNNER_BRIDGE_PATH), "utf8");
  const domainImport = adapterSource.match(/from\s+["'](\.\.\/\.\.\/src\/domain\/continuation\/continuation-policy-shadow\.mjs)["']/);

  assert.ok(domainImport, "Continuation shadow adapter must import the pure Continuation Domain relatively");
  assert.equal(
    resolvePackageRelativeImport(CONTINUATION_POLICY_ADAPTER_PATH, domainImport[1]),
    CONTINUATION_POLICY_PATH,
    "installed package-relative adapter import must resolve to the Continuation Domain",
  );
  assert.match(
    bridgeSource,
    /from\s+["']\.\/continuation-policy-shadow-adapter\.mjs["']/,
    "the existing stage runner bridge must import the packaged Continuation shadow adapter",
  );
  assert.doesNotMatch(
    domainSource,
    /\bfrom\s*["']node:(?:fs|path|process|child_process|net|http|https|dns|tls|dgram|sqlite)/u,
    "Continuation Domain must not gain runtime or I/O dependencies",
  );
  assert.doesNotMatch(
    domainSource,
    /\b(?:appendEvent|completeNode|failNode|claimNode|setRunTerminalStatus)\s*\(/u,
    "Continuation Domain must not gain kernel mutation authority",
  );

  const files = packageFileSet();
  for (const requiredPath of [
    CONTINUATION_POLICY_PATH,
    CONTINUATION_POLICY_ADAPTER_PATH,
    STAGE_RUNNER_BRIDGE_PATH,
  ]) {
    assert.ok(files.has(requiredPath), `packed package is missing ${requiredPath}`);
  }
});

test("M3-A03 Todo safe-progress shadow resolves Domain inward without gaining runtime authority", () => {
  const domainSource = readFileSync(path.join(REPO_ROOT, TODO_SAFE_PROGRESS_PATH), "utf8");
  const adapterSource = readFileSync(path.join(REPO_ROOT, TODO_SAFE_PROGRESS_ADAPTER_PATH), "utf8");
  const bridgeSource = readFileSync(path.join(REPO_ROOT, STAGE_RUNNER_BRIDGE_PATH), "utf8");
  const domainImport = adapterSource.match(/from\s+["'](\.\.\/\.\.\/src\/domain\/work\/todo-dependency-safe-progress-shadow\.mjs)["']/);

  assert.ok(domainImport, "Todo safe-progress adapter must import the pure Work Domain relatively");
  assert.equal(
    resolvePackageRelativeImport(TODO_SAFE_PROGRESS_ADAPTER_PATH, domainImport[1]),
    TODO_SAFE_PROGRESS_PATH,
    "installed package-relative adapter import must resolve to the Work Domain",
  );
  assert.match(
    bridgeSource,
    /from\s+["']\.\/todo-dependency-safe-progress-shadow-adapter\.mjs["']/,
    "the existing stage runner bridge must import the packaged Todo safe-progress adapter",
  );
  assert.doesNotMatch(
    domainSource,
    /\bfrom\s*["']node:(?:fs|path|process|child_process|net|http|https|dns|tls|dgram|sqlite)/u,
    "Work Domain must not gain runtime or I/O dependencies",
  );
  assert.doesNotMatch(
    domainSource,
    /\b(?:appendEvent|completeNode|failNode|claimNode|setRunTerminalStatus|selectMaximalSafeReadySet|dispatchReadySet)\s*\(/u,
    "Work Domain must not gain kernel or scheduler authority",
  );

  const files = packageFileSet();
  for (const requiredPath of [
    TODO_SAFE_PROGRESS_PATH,
    TODO_SAFE_PROGRESS_ADAPTER_PATH,
    STAGE_RUNNER_BRIDGE_PATH,
  ]) {
    assert.ok(files.has(requiredPath), `packed package is missing ${requiredPath}`);
  }
});

test("M3-A04 Scheduler reuse shadow resolves Domain inward without copying scheduler or kernel authority", () => {
  const domainSource = readFileSync(path.join(REPO_ROOT, SCHEDULER_AUTHORITY_REUSE_PATH), "utf8");
  const adapterSource = readFileSync(path.join(REPO_ROOT, SCHEDULER_AUTHORITY_REUSE_ADAPTER_PATH), "utf8");
  const bridgeSource = readFileSync(path.join(REPO_ROOT, STAGE_RUNNER_BRIDGE_PATH), "utf8");
  const domainImport = adapterSource.match(/from\s+["'](\.\.\/\.\.\/src\/domain\/scheduling\/scheduler-authority-reuse-shadow\.mjs)["']/);

  assert.ok(domainImport, "Scheduler reuse adapter must import the pure Scheduling Domain relatively");
  assert.equal(
    resolvePackageRelativeImport(SCHEDULER_AUTHORITY_REUSE_ADAPTER_PATH, domainImport[1]),
    SCHEDULER_AUTHORITY_REUSE_PATH,
    "installed package-relative adapter import must resolve to the Scheduling Domain",
  );
  assert.match(
    bridgeSource,
    /from\s+["']\.\/scheduler-authority-reuse-shadow-adapter\.mjs["']/,
    "the existing stage runner bridge must import the packaged Scheduler reuse adapter",
  );
  assert.doesNotMatch(
    domainSource,
    /\bfrom\s*["']node:(?:fs|path|process|child_process|net|http|https|dns|tls|dgram|sqlite)/u,
    "Scheduling Domain must not gain Node runtime or I/O dependencies",
  );
  assert.doesNotMatch(
    domainSource,
    /\b(?:appendEvent|writeEvent|completeNode|failNode|claimNode|acquireLease|renewLease|releaseLease|setRunTerminalStatus|selectMaximalSafeReadySet|dispatchReadySet|executeNativeReadySet)\s*\(/u,
    "Scheduling Domain must not gain kernel mutation or scheduler invocation authority",
  );

  const files = packageFileSet();
  for (const requiredPath of [
    SCHEDULER_AUTHORITY_REUSE_PATH,
    SCHEDULER_AUTHORITY_REUSE_ADAPTER_PATH,
    STAGE_RUNNER_BRIDGE_PATH,
  ]) {
    assert.ok(files.has(requiredPath), `packed package is missing ${requiredPath}`);
  }
});

test("M3-A05 Lease claim shadow resolves Domain inward and excludes the superseded projection authority", () => {
  const domainSource = readFileSync(path.join(REPO_ROOT, LEASE_CLAIM_AUTHORITY_PATH), "utf8");
  const adapterSource = readFileSync(path.join(REPO_ROOT, LEASE_CLAIM_AUTHORITY_ADAPTER_PATH), "utf8");
  const bridgeSource = readFileSync(path.join(REPO_ROOT, STAGE_RUNNER_BRIDGE_PATH), "utf8");
  const domainImport = adapterSource.match(/from\s+["'](\.\.\/\.\.\/src\/domain\/claims\/lease-claim-authority-shadow\.mjs)["']/);

  assert.ok(domainImport, "Lease claim shadow adapter must import the pure Claims Domain relatively");
  assert.equal(
    resolvePackageRelativeImport(LEASE_CLAIM_AUTHORITY_ADAPTER_PATH, domainImport[1]),
    LEASE_CLAIM_AUTHORITY_PATH,
    "installed package-relative adapter import must resolve to the Lease claim Domain",
  );
  assert.match(
    bridgeSource,
    /from\s+["']\.\/lease-claim-authority-shadow-adapter\.mjs["']/,
    "the existing stage runner bridge must import the packaged Lease claim shadow adapter",
  );
  assert.doesNotMatch(
    domainSource,
    /\bfrom\s*["']node:(?:fs|path|process|child_process|net|http|https|dns|tls|dgram|sqlite|crypto)/u,
    "Claims Domain must not gain Node runtime or I/O dependencies",
  );
  assert.doesNotMatch(
    domainSource,
    /\b(?:appendEvent|writeEvent|completeNode|failNode|claimNode|takeoverClaim|heartbeatClaim|releaseClaim|acquireLease|renewLease|releaseLease|setRunTerminalStatus|selectMaximalSafeReadySet|dispatchReadySet|executeNativeReadySet|projectRun|resumeRun)\s*\(/u,
    "Claims Domain must not gain kernel, claim, lease, scheduler, or runtime projection authority",
  );
  assert.doesNotMatch(
    `${domainSource}\n${adapterSource}\n${bridgeSource}`,
    /lease-claim-authority-projection(?:-adapter)?\.mjs|lease-claim-authority-projection-v1/u,
    "the A05 path must not depend on the superseded projection implementation",
  );

  const files = packageFileSet();
  for (const requiredPath of [
    LEASE_CLAIM_AUTHORITY_PATH,
    LEASE_CLAIM_AUTHORITY_ADAPTER_PATH,
    STAGE_RUNNER_BRIDGE_PATH,
  ]) {
    assert.ok(files.has(requiredPath), `packed package is missing ${requiredPath}`);
  }
  for (const excludedPath of [
    "src/domain/claims/lease-claim-authority-projection.mjs",
    "scripts/governed-execution/lease-claim-authority-projection-adapter.mjs",
  ]) {
    assert.ok(!files.has(excludedPath), `packed package must exclude ${excludedPath}`);
  }
});

test("M3-A06 Runtime health projection resolves Domain inward without gaining liveness or runtime authority", () => {
  const domainSource = readFileSync(path.join(REPO_ROOT, RUNTIME_HEALTH_PROJECTION_PATH), "utf8");
  const adapterSource = readFileSync(path.join(REPO_ROOT, RUNTIME_HEALTH_PROJECTION_ADAPTER_PATH), "utf8");
  const bridgeSource = readFileSync(path.join(REPO_ROOT, STAGE_RUNNER_BRIDGE_PATH), "utf8");
  const domainImport = adapterSource.match(/from\s+["'](\.\.\/\.\.\/src\/domain\/runtime\/runtime-health-projection\.mjs)["']/);

  assert.ok(domainImport, "Runtime health adapter must import the pure Runtime Domain relatively");
  assert.equal(
    resolvePackageRelativeImport(RUNTIME_HEALTH_PROJECTION_ADAPTER_PATH, domainImport[1]),
    RUNTIME_HEALTH_PROJECTION_PATH,
    "installed package-relative adapter import must resolve to the Runtime health Domain",
  );
  assert.match(
    bridgeSource,
    /from\s+["']\.\/runtime-health-projection-adapter\.mjs["']/,
    "the existing stage runner bridge must import the packaged Runtime health adapter",
  );
  assert.doesNotMatch(
    domainSource,
    /\bfrom\s*["']node:(?:fs|path|process|child_process|net|http|https|dns|tls|dgram|sqlite|crypto)/u,
    "Runtime health Domain must not gain Node runtime or I/O dependencies",
  );
  assert.doesNotMatch(
    domainSource,
    /\b(?:appendEvent|writeEvent|completeNode|failNode|claimNode|takeoverClaim|heartbeatClaim|releaseClaim|acquireLease|renewLease|releaseLease|setRunTerminalStatus|selectMaximalSafeReadySet|dispatchReadySet|executeNativeReadySet|projectRun|resumeRun|consumeQuota|mutateQuota)\s*\(/u,
    "Runtime health Domain must not gain kernel, runtime, claim, scheduler, or quota authority",
  );

  const files = packageFileSet();
  for (const requiredPath of [
    RUNTIME_HEALTH_PROJECTION_PATH,
    RUNTIME_HEALTH_PROJECTION_ADAPTER_PATH,
    STAGE_RUNNER_BRIDGE_PATH,
  ]) {
    assert.ok(files.has(requiredPath), `packed package is missing ${requiredPath}`);
  }
});

test("M3-A07 Quota usage projection resolves Domain inward without gaining quota enforcement authority", () => {
  const domainSource = readFileSync(path.join(REPO_ROOT, QUOTA_USAGE_PROJECTION_PATH), "utf8");
  const adapterSource = readFileSync(path.join(REPO_ROOT, QUOTA_USAGE_PROJECTION_ADAPTER_PATH), "utf8");
  const bridgeSource = readFileSync(path.join(REPO_ROOT, STAGE_RUNNER_BRIDGE_PATH), "utf8");
  const domainImport = adapterSource.match(/from\s+["'](\.\.\/\.\.\/src\/domain\/quota\/quota-usage-projection\.mjs)["']/);

  assert.ok(domainImport, "Quota usage adapter must import the pure Quota Domain relatively");
  assert.equal(
    resolvePackageRelativeImport(QUOTA_USAGE_PROJECTION_ADAPTER_PATH, domainImport[1]),
    QUOTA_USAGE_PROJECTION_PATH,
    "installed package-relative adapter import must resolve to the Quota usage Domain",
  );
  assert.match(
    bridgeSource,
    /from\s+["']\.\/quota-usage-projection-adapter\.mjs["']/,
    "the existing stage runner bridge must import the packaged Quota usage adapter",
  );
  assert.doesNotMatch(
    domainSource,
    /\bfrom\s*["']node:(?:fs|path|process|child_process|net|http|https|dns|tls|dgram|sqlite|crypto)/u,
    "Quota usage Domain must not gain Node runtime or I/O dependencies",
  );
  assert.doesNotMatch(
    domainSource,
    /\b(?:appendEvent|writeEvent|completeNode|failNode|claimNode|heartbeatNode|resumeRun|projectRun|selectMaximalSafeReadySet|dispatchReadySet|executeNativeReadySet|consumeQuota|mutateQuota|stopRun|pauseRun|retryNode)\s*\(/u,
    "Quota usage Domain must not gain kernel, scheduler, or quota enforcement authority",
  );

  const files = packageFileSet();
  for (const requiredPath of [
    QUOTA_USAGE_PROJECTION_PATH,
    QUOTA_USAGE_PROJECTION_ADAPTER_PATH,
    STAGE_RUNNER_BRIDGE_PATH,
  ]) {
    assert.ok(files.has(requiredPath), `packed package is missing ${requiredPath}`);
  }
});

test("M3-A09 durable repository resolves through Application and Data while retaining the packed legacy facade", () => {
  const compositionPath = "src/application/run/open-durable-run-repository.mjs";
  const portPath = "src/application/ports/durable-run-repository-port.mjs";
  const dataPath = "src/data/repositories/sqlite-durable-run-repository.mjs";
  const legacyPath = "scripts/governed-execution/durable-run-kernel.mjs";
  const compositionSource = readFileSync(path.join(REPO_ROOT, compositionPath), "utf8");
  const legacySource = readFileSync(path.join(REPO_ROOT, legacyPath), "utf8");
  const portImport = compositionSource.match(/from\s+["'](\.\.\/ports\/durable-run-repository-port\.mjs)["']/u);
  const dataImport = compositionSource.match(/from\s+["'](\.\.\/\.\.\/data\/repositories\/sqlite-durable-run-repository\.mjs)["']/u);
  const facadeImport = legacySource.match(/from\s+["'](\.\.\/\.\.\/src\/application\/run\/open-durable-run-repository\.mjs)["']/u);

  assert.ok(portImport, "Application composition must validate the durable repository port");
  assert.ok(dataImport, "Application composition must select the SQLite Data implementation");
  assert.ok(facadeImport, "legacy kernel path must remain a compatibility facade");
  assert.equal(resolvePackageRelativeImport(compositionPath, portImport[1]), portPath);
  assert.equal(resolvePackageRelativeImport(compositionPath, dataImport[1]), dataPath);
  assert.equal(resolvePackageRelativeImport(legacyPath, facadeImport[1]), compositionPath);
  assert.doesNotMatch(legacySource, /\b(?:CREATE|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK|PRAGMA)\b/u);

  const files = packageFileSet();
  for (const requiredPath of [...DATA_EVENT_REPOSITORY_SOURCE_PATHS, legacyPath]) {
    assert.ok(files.has(requiredPath), `packed package is missing ${requiredPath}`);
  }
});

test("M3-A10 setup composes the packaged Application use case and Infrastructure boundary", () => {
  const applicationPath =
    "src/application/installer/ensure-stable-global-projection-package.mjs";
  const infrastructurePath =
    "src/infrastructure/installer/projection-package-boundary.mjs";
  const setupPath = "setup.mjs";
  const applicationSource = readFileSync(
    path.join(REPO_ROOT, applicationPath),
    "utf8",
  );
  const infrastructureSource = readFileSync(
    path.join(REPO_ROOT, infrastructurePath),
    "utf8",
  );
  const setupSource = readFileSync(path.join(REPO_ROOT, setupPath), "utf8");

  assert.doesNotMatch(applicationSource, /from\s+["']node:/u);
  assert.doesNotMatch(
    applicationSource,
    /global-projection-package-store\.mjs/u,
  );
  assert.match(
    infrastructureSource,
    /from\s+["']\.\.\/\.\.\/\.\.\/scripts\/global-projection-package-store\.mjs["']/u,
  );
  assert.match(
    setupSource,
    /from\s+["']\.\/src\/application\/installer\/ensure-stable-global-projection-package\.mjs["']/u,
  );
  assert.match(
    setupSource,
    /from\s+["']\.\/src\/infrastructure\/installer\/projection-package-boundary\.mjs["']/u,
  );

  const files = packageFileSet();
  for (const requiredPath of [applicationPath, infrastructurePath, setupPath]) {
    assert.ok(files.has(requiredPath), `packed package is missing ${requiredPath}`);
  }
});

test("M3-A11 package contains the exact layered knowledge lifecycle vertical", () => {
  const files = packageFileSet();
  for (const requiredPath of KNOWLEDGE_LIFECYCLE_SOURCE_PATHS) {
    assert.ok(files.has(requiredPath), `packed package is missing ${requiredPath}`);
  }
  assert.equal(files.has("src"), false, "package must not broaden the source boundary to src/**");
});
