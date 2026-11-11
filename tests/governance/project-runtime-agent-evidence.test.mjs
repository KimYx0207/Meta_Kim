import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createGovernanceRuntimeFixture } from "../helpers/governance-runtime-fixture.mjs";

const runtimeCounts = (agents) => agents.reduce((counts, agent) => {
  counts[agent.runtime] = (counts[agent.runtime] ?? 0) + 1;
  return counts;
}, {});

for (const extraClaudeAgents of [0, 40]) {
  test(`route publication keeps every discovered runtime with ${extraClaudeAgents} extra early-runtime agents`, (t) => {
    const fixture = createGovernanceRuntimeFixture(t);
    const sync = JSON.parse(readFileSync(path.join(fixture.repoRoot, "config/sync.json"), "utf8"));
    const targets = sync.supportedTargets;
    const synchronized = fixture.run(["scripts/sync-runtimes.mjs", "--scope", "project", "--targets", targets.join(",")]);
    assert.equal(synchronized.status, 0, synchronized.stderr || synchronized.stdout);
    for (let index = 0; index < extraClaudeAgents; index += 1) {
      writeFileSync(path.join(fixture.repoRoot, ".claude/agents", `meta-extra-${index}.md`),
        "# Discovery fixture\n\nRead-only test inventory; no native host execution or authority.\n");
    }
    const inspect = (compact) => {
      const result = fixture.run(["scripts/select-execution-route.mjs", "--task", "fuzzy strategy task",
        "--runtime", "codex", "--os", "linux", ...(compact ? ["--json"] : [])]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return JSON.parse(result.stdout).ownerDiscoveryPacket;
    };
    const full = inspect(false);
    const compact = inspect(true);
    const expectedRuntimes = targets.map((target) => target === "claude" ? "claude_code" : target).sort();
    t.diagnostic(JSON.stringify({ full: runtimeCounts(full.projectRuntimeAgents), compact: runtimeCounts(compact.projectRuntimeAgents) }));
    for (const [label, packet, limit] of [["full", full, 80], ["compact", compact, 30]]) {
      assert.ok(packet.projectRuntimeAgents.length <= limit, `${label} output keeps its existing evidence budget`);
      assert.deepEqual(Object.keys(runtimeCounts(packet.projectRuntimeAgents)).sort(), expectedRuntimes,
        `${label} output must not hide a discovered runtime because another runtime filled its evidence budget`);
    }
    const canonicalAgentCount = readdirSync(path.join(fixture.repoRoot, "canonical/agents")).filter((name) => name.endsWith(".md")).length;
    assert.equal(compact.inventoryCounts.projectRuntimeAgents, canonicalAgentCount * targets.length + extraClaudeAgents,
      "inventory count describes all discovered agents, not just the bounded publication sample");
  });
}
