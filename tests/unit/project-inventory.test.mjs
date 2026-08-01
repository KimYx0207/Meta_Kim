import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  REPO_ROOT,
  buildProjectInventory,
  classifyTrackedTests,
} from "../../scripts/project-inventory.mjs";

describe("project inventory and standard test-suite coverage", () => {
  test("classifies unknown tracked test directories as uncovered", () => {
    const result = classifyTrackedTests([
      "tests/unit/example.test.mjs",
      "tests/unregistered/example.test.mjs",
    ]);
    assert.equal(result.counts.unit, 1);
    assert.deepEqual(result.unmatched, ["tests/unregistered/example.test.mjs"]);
  });

  test("classifies setup tests by runtime capability instead of a filename list", () => {
    const result = classifyTrackedTests([
      "tests/setup/global-runtime-bundle.test.mjs",
      "tests/setup/global-runtime-assets.test.mjs",
      "tests/setup/mcp-memory-hooks.test.mjs",
      "tests/setup/install-scope-matrix.test.mjs",
      "tests/setup/config-loader.test.mjs",
    ]);
    assert.equal(result.counts.setupPacked, 3);
    assert.equal(result.counts.setupDiagnostic, 1);
    assert.equal(result.counts.setup, 1);
    assert.deepEqual(result.unmatched, []);
  });

  test("classifies the owned process tests into the dedicated serial suite", () => {
    const result = classifyTrackedTests([
      "tests/unit/eval-process-runner.test.mjs",
      "tests/setup/windows-job-process-runner.test.mjs",
      "tests/setup/posix-process-group-runner.test.mjs",
      "tests/setup/process-runner-contract.test.mjs",
      "tests/unit/runtime-cli-invocation.test.mjs",
    ]);
    assert.equal(result.counts.processGuard, 3);
    assert.equal(result.counts.unit, 2);
    assert.deepEqual(result.unmatched, []);
  });

  test("every tracked test belongs to an explicit standard suite", () => {
    const inventory = buildProjectInventory();
    assert.equal(
      inventory.testSuiteCoverageOk,
      true,
      `Uncovered tracked tests: ${inventory.unmatchedTrackedTests.join(", ")}; command mismatches: ${JSON.stringify(inventory.suiteCommandMismatches)}`,
    );
    assert.deepEqual(inventory.unmatchedTrackedTests, []);
    assert.deepEqual(inventory.suiteCommandMismatches, []);
    assert.ok(inventory.testSuites.unit >= 1);
  });

  test("package scripts expose unit and inventory checks in the standard full chain", () => {
    const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    assert.equal(
      packageJson.scripts["meta:test:unit"],
      'node scripts/run-node-tests.mjs "tests/unit/*.test.mjs" && npm run meta:test:poc-design-gate',
    );
    assert.equal(
      packageJson.scripts["meta:test:poc-design-gate"],
      'node scripts/run-node-tests.mjs "tests/poc-design-gate/*.test.mjs"',
    );
    assert.equal(
      packageJson.scripts["meta:test:inventory"],
      "node scripts/project-inventory.mjs --check-tests",
    );
    assert.equal(
      packageJson.scripts["meta:test:integration"],
      'node scripts/run-node-tests.mjs "tests/integration/*.test.mjs"',
    );
    assert.match(packageJson.scripts["meta:test:setup"], /--exclude-import "node:child_process"/u);
    assert.match(packageJson.scripts["meta:test:setup"], /--concurrency 4/u);
    assert.match(
      packageJson.scripts["meta:test:setup:diagnostic"],
      /--include-import "node:child_process" --concurrency 2/u,
    );
    assert.equal(
      packageJson.scripts["meta:test:setup:packed"],
      'node scripts/run-node-tests.mjs "tests/setup/global-runtime-bundle.test.mjs" "tests/setup/global-runtime-assets.test.mjs" "tests/setup/mcp-memory-hooks.test.mjs"',
    );
    assert.equal(
      packageJson.scripts["meta:test:process-guard"],
      'node scripts/run-node-tests.mjs "tests/setup/windows-job-process-runner.test.mjs" "tests/setup/posix-process-group-runner.test.mjs" "tests/setup/process-runner-contract.test.mjs" --concurrency 1',
    );
    assert.match(packageJson.scripts["meta:verify:governance"], /meta:test:integration/);
    assert.match(packageJson.scripts["meta:verify:governance:core"], /meta:test:governance/);
    assert.equal(
      packageJson.scripts["meta:verify:all:chain"],
      "npm run meta:verify:all",
      "the compatibility chain must delegate to the authoritative runner instead of duplicating its stages",
    );
    assert.match(packageJson.scripts["meta:theory:run"], /--emit-conversation-notice/);
    assert.equal(
      packageJson.scripts["meta:theory:run:notice"],
      packageJson.scripts["meta:theory:run"],
    );
    assert.match(packageJson.scripts["meta:theory:run:json"], /--no-emit-conversation-notice/);
    assert.match(packageJson.scripts["meta:test:unit"], /meta:test:poc-design-gate/);
  });
});
