import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const skill = readFileSync(
  resolve(repoRoot, "canonical/skills/meta-theory/SKILL.md"),
  "utf8",
);
const devGovernance = readFileSync(
  resolve(
    repoRoot,
    "canonical/skills/meta-theory/references/dev-governance.md",
  ),
  "utf8",
);

test("60 — SKILL.md names the dispatcher as the single owner of capabilityInventory", () => {
  // Main-flow step, not a hook.
  assert.match(
    skill,
    /dispatcher[\s\S]{0,200}capabilityInventory/,
    "SKILL.md must say the dispatcher writes the capabilityInventory",
  );
  assert.match(
    skill,
    /main-flow step, not a hook/,
    "SKILL.md must explicitly mark this as a main-flow step, not a hook",
  );
});

test("60 — Claude canonical hooks contain runtime adapters and thin shared-core compatibility adapters", () => {
  const hooksDir = resolve(repoRoot, "canonical/runtime-assets/claude/hooks");
  const hooks = readdirSync(hooksDir).filter((f) => f.endsWith(".mjs"));
  // Cross-runtime implementations live exclusively under shared/hooks and are
  // projected into .claude/hooks by sync-runtimes.mjs. These thin files
  // keep canonical Claude adapters directly executable in source tests.
  const expected = [
    "activate-meta-theory-spine.mjs",
    "bash-readonly-whitelist.mjs",
    "block-dangerous-bash.mjs",
    "conversation-binding.mjs",
    "ecc-permission-cache-wrapper.mjs",
    "enforce-agent-dispatch.mjs",
    "graphify-context.mjs",
    "meta-kim-memory-save.mjs",
    "post-console-log-warn.mjs",
    "post-format.mjs",
    "post-typecheck.mjs",
    "skip-reminder.mjs",
    "spine-state.mjs",
    "stop-compaction.mjs",
    "stop-completion-guard.mjs",
    "stop-console-log-audit.mjs",
    "stop-memory-save.mjs",
    "stop-save-progress.mjs",
    "stop-spine-cleanup.mjs",
    "subagent-context.mjs",
    "utils.mjs",
  ];
  for (const f of expected) {
    assert.ok(
      hooks.includes(f),
      `expected hook present: ${f}`,
    );
  }
  assert.ok(
    hooks.length === expected.length,
    `hook count drifted: actual=${hooks.length} expected=${expected.length}; ` +
      `actual=[${hooks.join(", ")}]`,
  );
});
