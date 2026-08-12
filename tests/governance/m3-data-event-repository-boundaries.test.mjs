import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const read = (relativePath) => readFileSync(path.resolve(relativePath), "utf8");
const imports = (source) => [...source.matchAll(/\bfrom\s*["']([^"']+)["']/gu)]
  .map((match) => match[1]);

const CONTRACT_PATH = "config/contracts/data-event-repository-unification-contract.json";
const DOMAIN_PATH = "src/domain/execution/durable-run-repository-semantics.mjs";
const PORT_PATH = "src/application/ports/durable-run-repository-port.mjs";
const COMPOSITION_PATH = "src/application/run/open-durable-run-repository.mjs";
const DATA_PATH = "src/data/repositories/sqlite-durable-run-repository.mjs";
const DATA_RUNTIME_PATH = "src/data/sqlite/runtime.mjs";
const DATA_TRANSACTION_PATH = "src/data/sqlite/transaction.mjs";
const LEGACY_KERNEL_PATH = "scripts/governed-execution/durable-run-kernel.mjs";
const LEGACY_RUNTIME_PATH = "scripts/sqlite-runtime.mjs";
const LEGACY_TRANSACTION_PATH = "scripts/sqlite-transaction.mjs";

test("M3-A09 contract names one execution authority and three non-interchangeable repository classes", () => {
  const contract = JSON.parse(read(CONTRACT_PATH));
  assert.equal(contract.phase, "M3-A09");
  assert.equal(contract.authority.executionTruth, "governed_events_and_current_head");
  assert.equal(contract.authority.durableRepository, DATA_PATH);
  assert.equal(contract.repositoryClasses.durableRun.role, "sole_execution_truth");
  assert.equal(contract.repositoryClasses.durableRun.eventIdentity, "append_only_exact_idempotency");
  assert.equal(contract.repositoryClasses.nativeHostAnswer.mayAuthorizeExecution, false);
  assert.equal(contract.repositoryClasses.nativeHostAnswer.mergedIntoDurableRun, false);
  assert.equal(contract.repositoryClasses.legacyAnalytics.role, "analytics_projection_only");
  for (const capability of ["mayResume", "mayClaim", "mayLease", "mayCheckpoint"]) {
    assert.equal(contract.repositoryClasses.legacyAnalytics[capability], false, capability);
  }
  assert.equal(contract.repositoryClasses.legacyAnalytics.mergedIntoDurableRun, false);
  assert.equal(contract.compatibility.schemaChanged, false);
  assert.equal(contract.compatibility.databaseCopied, false);
  assert.equal(contract.compatibility.dualWriteAllowed, false);
});

test("M3-A09 Domain is pure and owns semantics without Node, SQL, Data, or script dependencies", () => {
  const source = read(DOMAIN_PATH);
  assert.deepEqual(imports(source), []);
  assert.doesNotMatch(
    source,
    /node:|\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE TABLE|BEGIN|COMMIT|ROLLBACK|PRAGMA)\b|(?:^|["'/])(?:scripts|data|adapters)(?:["'/]|$)/iu,
  );
  assert.match(source, /per_run_monotonic_cursor/u);
  assert.match(source, /cursor_and_version_compare_and_set/u);
  assert.match(source, /owner_attempt_lease_and_fence_bound/u);
  assert.match(source, /dualWriteAllowed:\s*false/u);
});

test("M3-A09 Application validates the port and composes Data without owning SQL or filesystem I/O", () => {
  const port = read(PORT_PATH);
  const composition = read(COMPOSITION_PATH);
  for (const [label, source] of [["port", port], ["composition", composition]]) {
    assert.doesNotMatch(
      source,
      /node:(?:fs|path|sqlite)|\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE TABLE|BEGIN|COMMIT|ROLLBACK|PRAGMA)\b|\.meta-kim[\\/]|governed-execution\.sqlite/iu,
      label,
    );
  }
  assert.deepEqual(imports(port), ["../../domain/execution/durable-run-repository-semantics.mjs"]);
  assert.match(port, /assertDurableRunRepositoryPort/u);
  assert.match(port, /repository is missing method/u);
  assert.match(composition, /assertDurableRunRepositoryPort/u);
  assert.match(composition, /openSqliteDurableRunRepository/u);
});

test("M3-A09 Data is the SQLite/transaction owner and never imports scripts or presentation", () => {
  const repository = read(DATA_PATH);
  const runtime = read(DATA_RUNTIME_PATH);
  const transaction = read(DATA_TRANSACTION_PATH);
  for (const [label, source] of [[DATA_PATH, repository], [DATA_RUNTIME_PATH, runtime], [DATA_TRANSACTION_PATH, transaction]]) {
    const specifiers = imports(source);
    assert.equal(
      specifiers.some((specifier) => /(?:^|\/)scripts(?:\/|$)|presentation/u.test(specifier)),
      false,
      label,
    );
  }
  assert.match(repository, /CREATE TABLE IF NOT EXISTS governed_events/u);
  assert.match(repository, /BEGIN IMMEDIATE|withSqliteTransaction/u);
  assert.match(repository, /Per-run cursor CAS lost/u);
  assert.match(repository, /Stale fence/u);
  assert.match(repository, /governed_checkpoints/u);
  assert.match(runtime, /node:sqlite/u);
  assert.match(transaction, /BEGIN \$\{mode\}/u);
  assert.match(transaction, /ROLLBACK/u);
});

test("M3-A09 legacy facades retain imports but contain no SQL, state path, or implementation body", () => {
  for (const relativePath of [LEGACY_KERNEL_PATH, LEGACY_RUNTIME_PATH, LEGACY_TRANSACTION_PATH]) {
    const source = read(relativePath);
    assert.doesNotMatch(
      source,
      /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE TABLE|BEGIN|COMMIT|ROLLBACK|PRAGMA)\b|\.meta-kim[\\/]|governed-execution\.sqlite/iu,
      relativePath,
    );
    assert.doesNotMatch(source, /\b(?:function|class)\s+[A-Za-z_$]/u, relativePath);
    assert.match(source, /\bexport\s*\{/u, relativePath);
  }
});

test("M3-A09 legacy analytics and native-host stores remain explicit non-execution authorities", () => {
  const contract = JSON.parse(read(CONTRACT_PATH));
  const analytics = read("scripts/capability-gap-mvp.mjs");
  const nativeHost = read("src/data/repositories/native-host-answer-repository.mjs");
  assert.match(analytics, /CREATE TABLE IF NOT EXISTS run_events/u);
  assert.match(analytics, /INSERT OR REPLACE INTO run_events/u);
  assert.equal(contract.repositoryClasses.legacyAnalytics.runEventsWriteMode, "legacy_insert_or_replace");
  assert.doesNotMatch(
    nativeHost,
    /\b(?:openDurableRunKernel|openSqliteDurableRunRepository|claimRunCoordinator|claimNode|completeNode|projectRun)\b/u,
  );
  assert.match(nativeHost, /compare-and-set persistence/u);
  assert.match(nativeHost, /never interprets/u);
  assert.match(nativeHost, /stored answer as execution authorization/u);
});
