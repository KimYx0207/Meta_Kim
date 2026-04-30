import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function readRepoFile(...segments) {
  return readFileSync(path.join(repoRoot, ...segments), "utf8");
}

describe("MCP memory cross-runtime hooks", () => {
  test("shared hook supports lifecycle save and lookup", () => {
    const source = readRepoFile(
      "canonical",
      "runtime-assets",
      "shared",
      "hooks",
      "meta-kim-memory-save.mjs",
    );

    assert.match(source, /session-start/);
    assert.match(source, /user-prompt/);
    assert.match(source, /\/api\/search/);
    assert.match(source, /n_results/);
    assert.match(source, /memory_type:\s*"observation"/);
    assert.doesNotMatch(source, /memoryTypeForEvent/);
    assert.doesNotMatch(source, /legacy_memory_type/);
    assert.doesNotMatch(source, /\/api\/memories\/search/);
    assert.match(source, /systemMessage/);
    assert.match(source, /node:https/);
    assert.match(source, /url\.protocol === "https:" \? https : http/);
  });

  test("Claude stop memory hook writes correct memory type", () => {
    const source = readRepoFile(
      "canonical",
      "runtime-assets",
      "claude",
      "hooks",
      "stop-memory-save.mjs",
    );

    assert.match(source, /memory_type:\s*"observation"/);
    assert.doesNotMatch(source, /legacy_memory_type/);
    assert.doesNotMatch(source, /memory_type:\s*"session-summary"/);
  });

  test("installer registers Codex and Cursor lifecycle events", () => {
    const source = readRepoFile("scripts", "install-mcp-memory-hooks.mjs");

    assert.match(source, /settings\.hooks\.SessionStart/);
    assert.match(source, /settings\.hooks\.UserPromptSubmit/);
    assert.match(source, /settings\.hooks\.Stop/);
    assert.match(source, /settings\.hooks\.beforeSubmitPrompt/);
    assert.match(source, /settings\.hooks\.stop/);
  });

  test("OpenClaw managed hook is packaged", () => {
    const hookMd = readRepoFile(
      "canonical",
      "runtime-assets",
      "openclaw",
      "hooks",
      "mcp-memory-service",
      "HOOK.md",
    );
    const handler = readRepoFile(
      "canonical",
      "runtime-assets",
      "openclaw",
      "hooks",
      "mcp-memory-service",
      "handler.ts",
    );

    assert.match(hookMd, /command:new/);
    assert.match(hookMd, /command:stop/);
    assert.match(handler, /\/api\/memories/);
    assert.match(handler, /memory_type:\s*"observation"/);
    assert.doesNotMatch(handler, /memoryType/);
    assert.doesNotMatch(handler, /legacyMemoryType/);
    assert.doesNotMatch(handler, /legacy_memory_type/);
    assert.doesNotMatch(handler, /return "session-summary"/);
  });
});
