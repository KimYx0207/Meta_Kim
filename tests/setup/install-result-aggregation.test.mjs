import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

import {
  INSTALL_STEP_CLASSIFICATION,
  INSTALL_STEP_OUTCOME,
  installStep,
  summarizeInstallStatus,
} from "../../scripts/install-status-semantics.mjs";
import {
  MCP_MEMORY_SETUP_ACTION,
  MCP_MEMORY_SETUP_REASON,
  resolveMcpMemorySetupPolicy,
} from "../../scripts/setup-memory-policy.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");

function loadRegisterMcpMemoryServer() {
  const source = readFileSync(resolve(repoRoot, "setup.mjs"), "utf8");
  const start = source.indexOf("function registerMcpMemoryServer(");
  const end = source.indexOf("\nasync function startMcpMemoryServiceBackground", start);
  assert.ok(start >= 0 && end > start, "registerMcpMemoryServer source not found");
  return vm.runInNewContext(`(${source.slice(start, end)})`, {});
}

describe("install result aggregation", () => {
  test("critical validation failure produces failed status and non-zero exit", () => {
    const result = summarizeInstallStatus([
      installStep("runtime sync", true),
      installStep("validation", false),
    ]);

    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.criticalFailures.map((step) => step.id), ["validation"]);
  });

  test("optional Python or MCP failure is partial without becoming a critical failure", () => {
    const result = summarizeInstallStatus([
      installStep("validation", true),
      installStep("Python tools", false, INSTALL_STEP_CLASSIFICATION.OPTIONAL),
    ]);

    assert.equal(result.status, "partial");
    assert.equal(result.exitCode, 0);
    assert.equal(result.criticalFailures.length, 0);
    assert.deepEqual(result.optionalFailures.map((step) => step.id), ["Python tools"]);
  });

  test("non-boolean outcomes fail closed while an explicit skip remains successful", () => {
    const invalid = summarizeInstallStatus([installStep("validation", undefined)]);
    const skipped = summarizeInstallStatus([
      installStep(
        "optional MCP",
        INSTALL_STEP_OUTCOME.SKIPPED,
        INSTALL_STEP_CLASSIFICATION.OPTIONAL,
      ),
    ]);

    assert.equal(invalid.status, "failed");
    assert.equal(invalid.exitCode, 1);
    assert.equal(skipped.status, "complete");
  });

  test("silent/default setup without global hooks skips memory and remains complete", () => {
    const policy = resolveMcpMemorySetupPolicy({
      needGlobal: true,
      withGlobalHooks: false,
      skipOptionalTools: false,
    });
    const result = summarizeInstallStatus([
      installStep("global sync", true),
      installStep(
        "MCP Memory",
        policy.action === MCP_MEMORY_SETUP_ACTION.SKIP
          ? INSTALL_STEP_OUTCOME.SKIPPED
          : false,
        INSTALL_STEP_CLASSIFICATION.OPTIONAL,
      ),
      installStep("global inventory", true),
    ]);

    assert.deepEqual(policy, {
      action: MCP_MEMORY_SETUP_ACTION.SKIP,
      reason: MCP_MEMORY_SETUP_REASON.GLOBAL_HOOKS_REQUIRED,
    });
    assert.equal(result.status, "complete");
    assert.equal(result.exitCode, 0);
    assert.equal(result.optionalFailures.length, 0);
  });

  test("memory becomes runnable only after global scope and hook opt-in are both present", () => {
    assert.deepEqual(
      resolveMcpMemorySetupPolicy({
        needGlobal: true,
        withGlobalHooks: true,
        skipOptionalTools: false,
      }),
      {
        action: MCP_MEMORY_SETUP_ACTION.RUN,
        reason: MCP_MEMORY_SETUP_REASON.READY,
      },
    );
    assert.equal(
      resolveMcpMemorySetupPolicy({
        needGlobal: false,
        withGlobalHooks: true,
      }).action,
      MCP_MEMORY_SETUP_ACTION.SKIP,
    );
  });

  test("malformed MCP config fails registration instead of claiming it exists", () => {
    const register = loadRegisterMcpMemoryServer();
    const failures = [];
    const result = register({
      mcpPath: "fixture/.mcp.json",
      memoryServerConfig: { command: "memory" },
      fileExists: () => true,
      readText: () => "{ malformed",
      writeText: () => assert.fail("malformed config must not be overwritten"),
      isLegacy: () => false,
      onFailure: (error) => failures.push(error.message),
    });

    assert.equal(result, false);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /JSON|position|property|expected/iu);
  });

  test("MCP config write failure returns false and emits the failure callback", () => {
    const register = loadRegisterMcpMemoryServer();
    const failures = [];
    const result = register({
      mcpPath: "fixture/.mcp.json",
      memoryServerConfig: { command: "memory" },
      fileExists: () => true,
      readText: () => JSON.stringify({ mcpServers: {} }),
      writeText: () => {
        throw new Error("EACCES: fixture is read-only");
      },
      isLegacy: () => false,
      onFailure: (error) => failures.push(error.message),
    });

    assert.equal(result, false);
    assert.deepEqual(failures, ["EACCES: fixture is read-only"]);
  });

  test("setup delegates final title and exit behavior to the aggregate result", () => {
    const source = readFileSync(resolve(repoRoot, "setup.mjs"), "utf8");

    assert.match(source, /summarizeInstallStatus\(stepResults\)/);
    assert.match(source, /process\.exit\(result\.exitCode\)/);
    assert.match(
      source,
      /deployResults\.length === deployDirs\.length &&\s*deployResults\.every\([\s\S]*?item\.status === "ok" && item\.stateStatus === "ready"/,
    );
    assert.doesNotMatch(
      source,
      /C\.red[^\n]*t\.setupError[^\n]*[\s\S]{0,160}t\.validationWarnings/,
    );
    assert.match(
      source,
      /if \(result\.status === "complete"\) \{\s*console\.log\(`\\n\$\{C\.bold\}\$\{C\.green\}✓ \$\{t\.(?:installComplete|updateComplete)\}/,
    );
    assert.match(source, /return registrationOk && hooksOk && backgroundOk;/);
    assert.match(
      source,
      /configureCandidateBoot: \(candidate\) => configureBootAutoStart\(candidate\.memoryBin, endpoint, \{\s*databasePath,\s*\}\)/,
    );
    assert.match(
      source,
      /if \(!transaction\.ok\) \{[\s\S]*?return false;[\s\S]*?registrationOk = transaction\.registrationOk;\s*backgroundOk = true;/,
    );
    assert.match(source, /wiringOk = false;\s*warn\(t\.graphifyHookFailed\)/);
    assert.match(source, /wiringOk = false;\s*warn\(t\.graphifySkillFailed\(platform\)\)/);
    assert.match(source, /return wiringOk;/);
  });
});
