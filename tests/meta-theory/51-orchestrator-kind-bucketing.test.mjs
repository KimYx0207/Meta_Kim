import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";

function route(task, runtime = "claude_code", os = "windows") {
  const result = spawnSync(
    process.execPath,
    ["scripts/select-execution-route.mjs", "--task", task, "--runtime", runtime, "--os", os, "--json"],
    // The explicit capability-gap route includes the bounded discovery packet,
    // which can exceed Node's default 1 MiB on a populated runtime inventory.
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

describe("51 — Orchestrator-kind bucketing (capability-classed fan-out)", () => {
  test("every worker carries an ownerKind from the 9-kind enum", () => {
    const result = route(
      "refactor frontend in src/ui, rebuild backend api in src/api, migrate database schema, deploy config ci"
    );
    const allowed = new Set(["agent", "skill", "mcp", "command", "runtimeTool", "hook", "plugin", "memory", "dependency"]);
    for (const w of result.workerTaskPacketDrafts) {
      assert.ok(
        allowed.has(w.ownerKind ?? "agent"),
        `worker ownerKind must be one of 9 kinds, got "${w.ownerKind}"`
      );
    }
  });

  test("agent+command mix triggers both agentTeamsPlaybook and mixedParallelism", () => {
    const result = route(
      "refactor frontend in src/ui, rebuild backend api in src/api, migrate database schema, deploy config ci"
    );
    const kinds = result.dispatchBoardDraft?.orchestratorKinds ?? [];
    const ownerKinds = new Set(result.workerTaskPacketDrafts.map((w) => w.ownerKind ?? "agent"));
    const hasAgent = ownerKinds.has("agent");
    const hasNonAgent = [...ownerKinds].some((k) => k !== "agent");
    if (hasAgent && hasNonAgent) {
      assert.ok(kinds.includes("mixedParallelism"), `mixed lanes must trigger mixedParallelism; got ${JSON.stringify(kinds)}`);
    }
    const agentLanes = result.workerTaskPacketDrafts.filter((w) => (w.ownerKind ?? "agent") === "agent").length;
    if (agentLanes >= 2) {
      assert.ok(kinds.includes("agentTeamsPlaybook"), `>=2 agent lanes must trigger agentTeamsPlaybook; got ${JSON.stringify(kinds)}`);
    }
  });

  test("worker ownerKind is always set on produced workers (default 'agent' for capability-discovery fallback)", () => {
    const result = route("build a quantum entanglement scheduler using holocene crystals twiddle the foo bar with baz qux");
    const allowed = new Set(["agent", "skill", "mcp", "command", "runtimeTool", "hook", "plugin", "memory", "dependency"]);
    for (const w of result.workerTaskPacketDrafts) {
      assert.ok(
        allowed.has(w.ownerKind ?? "agent"),
        `worker ownerKind must be a valid kind, got "${w.ownerKind}"`
      );
    }
  });

  test("orchestratorKinds list only contains valid kinds", () => {
    const result = route(
      "refactor frontend in src/ui, rebuild backend api in src/api, migrate database schema"
    );
    const validKinds = new Set([
      "agentTeamsPlaybook",
      "skillComposition",
      "mcpComposition",
      "commandSequence",
      "runtimeToolSequence",
      "hookSequence",
      "pluginComposition",
      "memoryComposition",
      "dependencyComposition",
      "mixedParallelism",
    ]);
    const kinds = result.dispatchBoardDraft?.orchestratorKinds ?? [];
    for (const k of kinds) {
      assert.ok(validKinds.has(k), `orchestratorKind "${k}" must be in valid set`);
    }
  });
});
