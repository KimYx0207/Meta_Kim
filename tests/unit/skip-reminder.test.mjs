/**
 * Unit tests for skip-reminder module
 * Tests PRIN-ST compliance: i18n support, constants, keyword detection precision
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Set test environment to English
process.env.META_KIM_LANG = "en";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

// Backup and restore i18n file
const i18nPath = join(
  repoRoot,
  "canonical",
  "runtime-assets",
  "shared",
  "hooks",
  "hook-i18n.mjs"
);

// Create a simple test that verifies the structure without complex mocking
describe("skip-reminder module structure", () => {
  test("should export SKIP_DECISION constants", async () => {
    const module = await import("../../canonical/runtime-assets/shared/hooks/skip-reminder.mjs");
    assert.ok(module.SKIP_DECISION);
    assert.strictEqual(module.SKIP_DECISION.SKIP, "Skip");
    assert.strictEqual(module.SKIP_DECISION.CHECK, "Check");
    assert.strictEqual(module.SKIP_DECISION.KEEP, "Keep");
  });

  test("should export GOVERNANCE_SKIP_RULES using constants", async () => {
    const module = await import("../../canonical/runtime-assets/shared/hooks/skip-reminder.mjs");
    assert.ok(module.GOVERNANCE_SKIP_RULES);
    assert.strictEqual(
      module.GOVERNANCE_SKIP_RULES.enforce_agent_dispatch.query,
      "Skip"
    );
    assert.strictEqual(
      module.GOVERNANCE_SKIP_RULES.post_format.simple_exec,
      "Skip"
    );
    assert.strictEqual(
      module.GOVERNANCE_SKIP_RULES.stop_hooks.simple_exec,
      "Keep"
    );
  });

  test("should export SIMPLE_KEYWORDS with word boundaries", async () => {
    const module = await import("../../canonical/runtime-assets/shared/hooks/skip-reminder.mjs");
    assert.ok(module.SIMPLE_KEYWORDS);
    assert.ok(Array.isArray(module.SIMPLE_KEYWORDS));
    assert.ok(module.SIMPLE_KEYWORDS.length > 0);
    // Check for word boundary patterns
    assert.ok(module.SIMPLE_KEYWORDS.some(k => k.includes("\\b")));
  });

  test("should export core functions", async () => {
    const module = await import("../../canonical/runtime-assets/shared/hooks/skip-reminder.mjs");
    assert.strictEqual(typeof module.getSkipRule, "function");
    assert.strictEqual(typeof module.hasSimpleKeyword, "function");
    assert.strictEqual(typeof module.formatSkipReason, "function");
    assert.strictEqual(typeof module.getHookImpact, "function");
    assert.strictEqual(typeof module.createSkipRecord, "function");
    assert.strictEqual(typeof module.remindSkipped, "function");
  });
});

describe("getSkipRule function", () => {
  test("should return correct rule for known hook and flow", async () => {
    const { getSkipRule, SKIP_DECISION } = await import("../../canonical/runtime-assets/shared/hooks/skip-reminder.mjs");
    assert.strictEqual(getSkipRule("enforce-agent-dispatch", "query"), SKIP_DECISION.SKIP);
    assert.strictEqual(getSkipRule("enforce-agent-dispatch", "complex_dev"), SKIP_DECISION.CHECK);
  });

  test("should normalize hook names", async () => {
    const { getSkipRule, SKIP_DECISION } = await import("../../canonical/runtime-assets/shared/hooks/skip-reminder.mjs");
    assert.strictEqual(getSkipRule("post-format.mjs", "simple_exec"), SKIP_DECISION.SKIP);
    assert.strictEqual(getSkipRule("post_format", "simple_exec"), SKIP_DECISION.SKIP);
  });

  test("should default to CHECK for unknown hooks", async () => {
    const { getSkipRule, SKIP_DECISION } = await import("../../canonical/runtime-assets/shared/hooks/skip-reminder.mjs");
    assert.strictEqual(getSkipRule("unknown-hook", "query"), SKIP_DECISION.CHECK);
  });
});

describe("hasSimpleKeyword function with word boundaries", () => {
  test("should not match substrings with word boundaries", async () => {
    const { hasSimpleKeyword } = await import("../../canonical/runtime-assets/shared/hooks/skip-reminder.mjs");
    // "check" should not match "doublecheck" or "checking"
    assert.ok(!hasSimpleKeyword("doublecheck everything"));
    assert.ok(!hasSimpleKeyword("keep checking"));
  });

  test("should match whole words correctly", async () => {
    const { hasSimpleKeyword } = await import("../../canonical/runtime-assets/shared/hooks/skip-reminder.mjs");
    assert.ok(hasSimpleKeyword("just check this file"));
    assert.ok(hasSimpleKeyword("Can you check my code?"));
    assert.ok(hasSimpleKeyword("what is the meaning of this"));
  });

  test("should handle case-insensitive matching", async () => {
    const { hasSimpleKeyword } = await import("../../canonical/runtime-assets/shared/hooks/skip-reminder.mjs");
    assert.ok(hasSimpleKeyword("CHECK this"));
    assert.ok(hasSimpleKeyword("Check This"));
  });

  test("should not trigger on technical terms containing keywords", async () => {
    const { hasSimpleKeyword } = await import("../../canonical/runtime-assets/shared/hooks/skip-reminder.mjs");
    assert.ok(!hasSimpleKeyword("use checklist for validation"));
    assert.ok(!hasSimpleKeyword("checkout the latest commit"));
    assert.ok(!hasSimpleKeyword("showcase the feature"));
  });

  test("should handle edge cases", async () => {
    const { hasSimpleKeyword } = await import("../../canonical/runtime-assets/shared/hooks/skip-reminder.mjs");
    assert.strictEqual(hasSimpleKeyword(null), false);
    assert.strictEqual(hasSimpleKeyword(undefined), false);
    assert.strictEqual(hasSimpleKeyword(""), false);
    assert.strictEqual(hasSimpleKeyword(123), false);
  });
});

describe("formatSkipReason function (i18n)", () => {
  test("should format reasons with i18n", async () => {
    const { formatSkipReason } = await import("../../canonical/runtime-assets/shared/hooks/skip-reminder.mjs");
    assert.ok(formatSkipReason("env_var"));
    assert.ok(formatSkipReason("keyword"));
    assert.ok(formatSkipReason("governance_flow", "query"));
  });
});

describe("getHookImpact function (i18n)", () => {
  test("should return localized impacts", async () => {
    const { getHookImpact } = await import("../../canonical/runtime-assets/shared/hooks/skip-reminder.mjs");
    assert.ok(getHookImpact("enforce-agent-dispatch"));
    assert.ok(getHookImpact("post-format"));
    assert.ok(getHookImpact("post-typecheck"));
  });
});

describe("createSkipRecord function", () => {
  test("should create record with timestamp", async () => {
    const { createSkipRecord } = await import("../../canonical/runtime-assets/shared/hooks/skip-reminder.mjs");
    const record = createSkipRecord("test-hook", "test reason");
    assert.strictEqual(record.hook, "test-hook");
    assert.strictEqual(record.reason, "test reason");
    assert.ok(record.timestamp);
  });
});

describe("i18n module exists", () => {
  test("should have hook-i18n.mjs file", () => {
    assert.ok(existsSync(i18nPath));
  });

  test("should export required i18n strings", () => {
    const content = readFileSync(i18nPath, "utf8");
    assert.ok(content.includes("hookSkipTitle"));
    assert.ok(content.includes("skipReasonEnvVar"));
    assert.ok(content.includes("impactEnforceAgentDispatch"));
    assert.ok(content.includes("restoreInstructions"));
  });
});
