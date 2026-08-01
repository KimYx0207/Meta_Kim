#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

export const TEST_SUITES = Object.freeze({
  governance: {
    prefix: "tests/governance/",
    packageScript: "meta:test:governance",
    command: 'node scripts/run-node-tests.mjs "tests/governance/*.test.mjs"',
  },
  integration: {
    prefix: "tests/integration/",
    packageScript: "meta:test:integration",
    command: 'node scripts/run-node-tests.mjs "tests/integration/*.test.mjs"',
  },
  metaTheory: {
    prefix: "tests/meta-theory/",
    packageScript: "meta:test:meta-theory",
    command: 'node scripts/run-node-tests.mjs "tests/meta-theory/*.test.mjs"',
  },
  pocDesignGate: {
    prefix: "tests/poc-design-gate/",
    packageScript: "meta:test:poc-design-gate",
    command: 'node scripts/run-node-tests.mjs "tests/poc-design-gate/*.test.mjs"',
  },
  processGuard: {
    paths: [
      "tests/setup/windows-job-process-runner.test.mjs",
      "tests/setup/posix-process-group-runner.test.mjs",
      "tests/setup/process-runner-contract.test.mjs",
    ],
    packageScript: "meta:test:process-guard",
    command:
      'node scripts/run-node-tests.mjs "tests/setup/windows-job-process-runner.test.mjs" "tests/setup/posix-process-group-runner.test.mjs" "tests/setup/process-runner-contract.test.mjs" --concurrency 1',
  },
  setup: {
    prefix: "tests/setup/",
    packageScript: "meta:test:setup",
    command:
      'node scripts/run-node-tests.mjs "tests/setup/*.test.mjs" --exclude "tests/setup/global-runtime-bundle.test.mjs" --exclude "tests/setup/global-runtime-assets.test.mjs" --exclude "tests/setup/mcp-memory-hooks.test.mjs" --exclude-import "node:child_process" --concurrency 4',
    excludePaths: [
      "tests/setup/global-runtime-bundle.test.mjs",
      "tests/setup/global-runtime-assets.test.mjs",
      "tests/setup/mcp-memory-hooks.test.mjs",
    ],
    excludeImports: ["node:child_process"],
  },
  setupDiagnostic: {
    prefix: "tests/setup/",
    packageScript: "meta:test:setup:diagnostic",
    command:
      'node scripts/run-node-tests.mjs "tests/setup/*.test.mjs" --exclude "tests/setup/global-runtime-bundle.test.mjs" --exclude "tests/setup/global-runtime-assets.test.mjs" --exclude "tests/setup/mcp-memory-hooks.test.mjs" --include-import "node:child_process" --concurrency 2',
    excludePaths: [
      "tests/setup/global-runtime-bundle.test.mjs",
      "tests/setup/global-runtime-assets.test.mjs",
      "tests/setup/mcp-memory-hooks.test.mjs",
    ],
    includeImports: ["node:child_process"],
  },
  setupPacked: {
    paths: [
      "tests/setup/global-runtime-bundle.test.mjs",
      "tests/setup/global-runtime-assets.test.mjs",
      "tests/setup/mcp-memory-hooks.test.mjs",
    ],
    packageScript: "meta:test:setup:packed",
    command:
      'node scripts/run-node-tests.mjs "tests/setup/global-runtime-bundle.test.mjs" "tests/setup/global-runtime-assets.test.mjs" "tests/setup/mcp-memory-hooks.test.mjs"',
  },
  unit: {
    prefix: "tests/unit/",
    packageScript: "meta:test:unit",
    command:
      'node scripts/run-node-tests.mjs "tests/unit/*.test.mjs" && npm run meta:test:poc-design-gate',
  },
});

function normalizePath(value) {
  return String(value).replaceAll("\\", "/");
}

export function listTrackedTests(repoRoot = REPO_ROOT) {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "tests/**/*.test.mjs"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  return output
    .split(/\r?\n/u)
    .map((entry) => normalizePath(entry.trim()))
    .filter(Boolean)
    .filter((entry) => existsSync(path.join(repoRoot, entry)))
    .sort();
}

export function classifyTrackedTests(trackedTests, suites = TEST_SUITES) {
  const counts = Object.fromEntries(Object.keys(suites).map((name) => [name, 0]));
  const unmatched = [];
  for (const testPath of trackedTests) {
    const absoluteTestPath = path.join(REPO_ROOT, testPath);
    const source = existsSync(absoluteTestPath) ? readFileSync(absoluteTestPath, "utf8") : "";
    const importsModule = (specifier) => {
      const escaped = String(specifier).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(
        "(?:from\\s+|import\\s*\\(|require\\s*\\()?[\"']" + escaped + "[\"']",
        "u",
      ).test(source);
    };
    const suite = Object.entries(suites).find(([, definition]) =>
      definition.paths?.includes(testPath),
    ) ?? Object.entries(suites).find(([, definition]) =>
      definition.prefix &&
      testPath.startsWith(definition.prefix) &&
      !definition.excludePaths?.includes(testPath) &&
      definition.includeImports?.every(importsModule),
    ) ?? Object.entries(suites).find(([, definition]) =>
      definition.prefix &&
      testPath.startsWith(definition.prefix) &&
      !definition.excludePaths?.includes(testPath) &&
      (!definition.excludeImports ||
        definition.excludeImports.every((specifier) => !importsModule(specifier))),
    );
    if (!suite) {
      unmatched.push(testPath);
      continue;
    }
    counts[suite[0]] += 1;
  }
  return { counts, unmatched };
}

export function buildProjectInventory(repoRoot = REPO_ROOT) {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const topLevelScripts = readdirSync(path.join(repoRoot, "scripts"), {
    withFileTypes: true,
  }).filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"));
  const trackedTests = listTrackedTests(repoRoot);
  const testCoverage = classifyTrackedTests(trackedTests);
  const suiteCommandMismatches = Object.entries(TEST_SUITES)
    .filter(([, definition]) => packageJson.scripts?.[definition.packageScript] !== definition.command)
    .map(([name, definition]) => ({
      suite: name,
      packageScript: definition.packageScript,
      expected: definition.command,
      actual: packageJson.scripts?.[definition.packageScript] ?? null,
    }));
  return {
    schemaVersion: "meta-kim-project-inventory-v0.1",
    topLevelMjsScriptCount: topLevelScripts.length,
    packageScriptCount: Object.keys(packageJson.scripts ?? {}).length,
    trackedTestCount: trackedTests.length,
    testSuites: testCoverage.counts,
    suiteCommandMismatches,
    unmatchedTrackedTests: testCoverage.unmatched,
    testSuiteCoverageOk:
      testCoverage.unmatched.length === 0 && suiteCommandMismatches.length === 0,
  };
}

function main() {
  const inventory = buildProjectInventory();
  process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
  if (process.argv.includes("--check-tests") && !inventory.testSuiteCoverageOk) {
    console.error(
      `Standard test coverage mismatch: ${[
        ...inventory.unmatchedTrackedTests,
        ...inventory.suiteCommandMismatches.map((item) => item.packageScript),
      ].join(", ")}`,
    );
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
