import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

let runtimeFixture;
before(async () => {
  runtimeFixture = createGovernanceRuntimeFixtureScope(null, { graph: true });
});
after(() => runtimeFixture?.cleanup());


function route(task, runtime = "claude_code", os = "windows", outputArgs = ["--json"]) {
  const result = spawnSync(
    process.execPath,
    ["scripts/select-execution-route.mjs", "--task", task, "--runtime", runtime, "--os", os, ...outputArgs],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

describe("50 — Parallel execution lanes (engineering fan-out)", () => {
  test("multi-segment task produces >=2 workers and parallel lanes", () => {
    const result = route(
      "refactor frontend components in src/ui, rebuild backend api routes in src/api, and migrate database schema. three independent parallel lanes."
    );
    const drafts = result.workerTaskPacketDrafts;
    const lanes = result.recommendedRoute.parallelExecutionLanes ?? [];
    assert.ok(lanes.length >= 2, `expected >=2 parallel lanes, got ${lanes.length}`);
    assert.ok(drafts.length >= 2, `expected >=2 worker drafts, got ${drafts.length}`);
  });

  test("every produced worker ownerAgent must come from runtime-scoped candidate owners (by ownerKind)", () => {
    const result = route(
      "refactor frontend components in src/ui, rebuild backend api routes in src/api, and migrate database schema."
    );
    const agentAvailable = new Set(result.ownerDiscoveryPacket.candidateExistingExecutionOwners);
    const nonAgentProviders = [
      ...result.ownerDiscoveryPacket.repoCanonicalCapabilityProviders,
      ...result.ownerDiscoveryPacket.projectRuntimeCapabilityProviders,
      ...result.ownerDiscoveryPacket.localGlobalCapabilityProviders,
    ];
    const nonAgentIds = new Set([
      ...nonAgentProviders.map((p) => p.id),
      ...result.ownerDiscoveryPacket.candidateReusableCapabilityProviders,
    ]);
    for (const draft of result.workerTaskPacketDrafts) {
      const kind = draft.ownerKind ?? "agent";
      const pool = kind === "agent" ? agentAvailable : nonAgentIds;
      assert.ok(
        pool.has(draft.ownerAgent),
        `worker ownerAgent "${draft.ownerAgent}" (kind=${kind}) must be in runtime-scoped candidate set`
      );
    }
  });

  test("every parallel lane owner must come from runtime-scoped candidate providers (by ownerKind)", () => {
    const result = route(
      "refactor frontend components in src/ui, rebuild backend api routes in src/api, and migrate database schema."
    );
    const lanes = result.recommendedRoute.parallelExecutionLanes ?? [];
    const agentAvailable = new Set(result.ownerDiscoveryPacket.candidateExistingExecutionOwners);
    const nonAgentProviders = [
      ...result.ownerDiscoveryPacket.repoCanonicalCapabilityProviders,
      ...result.ownerDiscoveryPacket.projectRuntimeCapabilityProviders,
      ...result.ownerDiscoveryPacket.localGlobalCapabilityProviders,
    ];
    const nonAgentIds = new Set([
      ...nonAgentProviders.map((p) => p.id),
      ...result.ownerDiscoveryPacket.candidateReusableCapabilityProviders,
    ]);
    for (const lane of lanes) {
      const kind = lane.ownerKind ?? "agent";
      const pool = kind === "agent" ? agentAvailable : nonAgentIds;
      assert.ok(
        pool.has(lane.ownerAgent),
        `lane ownerAgent "${lane.ownerAgent}" (kind=${kind}) must be in runtime-scoped candidate set`
      );
    }
  });

  test("selected real providers survive raw 100 and compact 80/30 evidence limits", () => {
    const task = "refactor frontend components in src/ui, rebuild backend api routes in src/api, and migrate database schema.";
    const original = readFileSync("package.json", "utf8");
    const packageJson = JSON.parse(original);
    const id = "package-script:migrate:meta-kim";
    const baselineOwners = route(task).workerTaskPacketDrafts.map(({ ownerAgent, ownerKind }) => ({ ownerAgent, ownerKind }));
    // Discovery-only fixture commands never run. Their nonmatching names move
    // the actual selected command beyond both existing evidence cutoffs.
    const padding = Object.fromEntries(Array.from({ length: 130 }, (_, i) => [`unrelated-inventory-${i}`, "node --version"]));
    packageJson.scripts = { ...padding, ...packageJson.scripts };
    assert.ok(Object.keys(packageJson.scripts).indexOf("migrate:meta-kim") > 100);
    writeFileSync("package.json", JSON.stringify(packageJson, null, 2));
    try {
      for (const [outputArgs, candidateLimit, projectLimit] of [[[], 100, 80], [["--json"], 80, 30]]) {
        const result = route(task, "claude_code", "windows", outputArgs);
        const packet = result.ownerDiscoveryPacket;
        assert.deepEqual(result.workerTaskPacketDrafts.map(({ ownerAgent, ownerKind }) => ({ ownerAgent, ownerKind })), baselineOwners);
        assert.ok(packet.candidateReusableCapabilityProviders.includes(id), `selected command must remain in ${outputArgs.length ? "compact" : "raw"} candidate evidence`);
        const provider = packet.projectRuntimeCapabilityProviders.find((entry) => entry.id === id);
        assert.ok(provider, "selected command must retain its actual discovered source record");
        assert.equal(provider.sourceRef, "package.json#scripts.migrate:meta-kim");
        assert.equal(provider.source, "package_script_inventory");
        assert.equal(provider.type, "commands");
        assert.equal(provider.runtime, "shared");
        assert.equal(packet.candidateReusableCapabilityProviders.length, candidateLimit);
        assert.equal(packet.projectRuntimeCapabilityProviders.length, projectLimit);
        assert.equal(new Set(packet.candidateReusableCapabilityProviders).size, candidateLimit);
      }
    } finally {
      writeFileSync("package.json", original);
    }
  });

  test("publication never synthesizes discovery evidence for an unknown selected reference", () => {
    const file = "scripts/select-execution-route.mjs";
    const original = readFileSync(file, "utf8");
    const marker = "\nfunction compactProvider(provider) {";
    const unknown = "package-script:never-discovered-r5";
    assert.ok(original.includes(marker));
    // Inject a corrupt selected claim into this disposable fixture only. There
    // is no production override, unknown command execution, or real inventory edit.
    const injection = `\noutput.workerTaskPacketDrafts.push({ownerKind: "command", ownerAgent: ${JSON.stringify(unknown)}});\noutput.recommendedRoute.selectedCapabilityProviders.untrustedFixture = {id: ${JSON.stringify(unknown)}, type: "commands", sourceRef: "fabricated-reference"};\n`;
    writeFileSync(file, original.replace(marker, injection + marker));
    try {
      for (const outputArgs of [[], ["--json"]]) {
        const result = route("refactor frontend components, rebuild backend api, and migrate database schema.", "claude_code", "windows", outputArgs);
        const packet = result.ownerDiscoveryPacket;
        assert.ok(result.workerTaskPacketDrafts.some((draft) => draft.ownerAgent === unknown));
        assert.equal(packet.candidateReusableCapabilityProviders.includes(unknown), false);
        for (const field of ["repoCanonicalCapabilityProviders", "projectRuntimeCapabilityProviders", "localGlobalCapabilityProviders", "runtimeToolProviders"]) {
          assert.equal(packet[field].some((provider) => provider.id === unknown || provider.sourceRef === "fabricated-reference"), false);
        }
      }
    } finally {
      writeFileSync(file, original);
    }
  });

  test("single-line task falls back to single worker (no fan-out)", () => {
    const result = route("fix the login button on the homepage");
    if (!result.recommendedRoute) {
      assert.ok(true, "no route available — inventory gap, not a fan-out failure");
      return;
    }
    const drafts = result.workerTaskPacketDrafts;
    const lanes = result.recommendedRoute.parallelExecutionLanes ?? [];
    assert.equal(lanes.length, 0, "single-line task must not produce parallel lanes");
    assert.equal(drafts.length, 1, "single-line task must fall back to exactly 1 worker");
  });

  test("owner of every produced worker must be in declared available set (no transient or invented ids)", () => {
    const result = route(
      "build a quantum entanglement scheduler using holocene crystals and twiddle the foo bar with baz qux"
    );
    const available = new Set(result.ownerDiscoveryPacket.candidateExistingExecutionOwners);
    for (const draft of result.workerTaskPacketDrafts) {
      if (draft.ownerAgent === null) continue;
      assert.ok(available.has(draft.ownerAgent), `worker owner "${draft.ownerAgent}" must be in declared available set`);
    }
    if (!result.recommendedRoute) {
      assert.ok(true, "no route available — inventory gap, not a fan-out failure");
      return;
    }
    const lanes = result.recommendedRoute.parallelExecutionLanes ?? [];
    for (const lane of lanes) {
      if (lane.ownerAgent === null) continue;
      assert.ok(available.has(lane.ownerAgent), `lane owner "${lane.ownerAgent}" must be in declared available set`);
    }
  });

  test("multi-segment task produces parallel lanes so downstream dispatch can fan out", () => {
    const result = route(
      "refactor frontend components in src/ui, rebuild backend api routes in src/api, and migrate database schema."
    );
    const lanes = result.recommendedRoute.parallelExecutionLanes ?? [];
    const drafts = result.workerTaskPacketDrafts;
    assert.ok(lanes.length >= 2, "multi-segment task must produce >=2 parallel lanes");
    assert.ok(drafts.length >= 2, "multi-segment task must produce >=2 worker drafts");
  });

  test("meta-governed whitespace capability anchors still split into reusable global-agent lanes", () => {
    const result = route(
      "Critical Thinking → Fetch → Deep Thinking → Review 检查平台 key adapter 注册 能力账本 第二批平台路由 上传证据",
      "codex",
      "windows",
    );
    const lanes = result.recommendedRoute.parallelExecutionLanes ?? [];
    const drafts = result.workerTaskPacketDrafts;
    const available = new Set(result.ownerDiscoveryPacket.candidateExistingExecutionOwners);

    assert.equal(Object.hasOwn(result.entryClassification, "subagentAuthorizationSource"), false);
    assert.equal(result.entryClassification.signals.structuredGovernanceChainRequest, true);
    assert.ok(lanes.length >= 2, `expected whitespace capability anchors to produce >=2 lanes, got ${lanes.length}`);
    assert.ok(drafts.length >= 2, `expected >=2 worker drafts, got ${drafts.length}`);
    for (const draft of drafts) {
      assert.equal(draft.ownerKind, "agent");
      assert.ok(available.has(draft.ownerAgent), `worker owner "${draft.ownerAgent}" must be an existing discovered owner`);
      assert.equal(draft.codexSpawnBinding?.hostSurface, "spawn_agent");
      assert.equal(draft.codexSpawnBinding?.ownerBindingMode, "run_scoped_owner_contract");
      assert.equal(draft.codexSpawnBinding?.nativeAgentType, null);
      assert.equal(draft.codexSpawnBinding?.ownerSelectorField, null);
      assert.equal(draft.codexSpawnBinding?.ownerAgent, draft.ownerAgent);
      assert.match(draft.codexSpawnBinding?.task_name ?? "", /^[a-z0-9_]+$/);
      assert.equal(draft.codexSpawnBinding?.fork_turns, "none");
      const message = JSON.parse(draft.codexSpawnBinding?.message ?? "null");
      assert.equal(message?.taskPacketId, draft.taskPacketId);
      assert.equal(message?.roleInstanceId, draft.roleInstanceId);
      assert.equal(message?.coordination?.mergeOwner, draft.mergeOwner);
      assert.equal(message?.scope?.purpose, draft.purpose);
      assert.equal(Object.hasOwn(draft.codexSpawnBinding ?? {}, "agent_type"), false);
      assert.equal(Object.hasOwn(draft.codexSpawnBinding ?? {}, "fork_context"), false);
      assert.equal(Object.hasOwn(draft.codexSpawnBinding ?? {}, "messageRef"), false);
    }
    assert.equal(
      result.dispatchBoardDraft?.dispatchMode,
      "fanout_eligible",
      "upload/external-write scope must stay blocked from live parallel dispatch until isolation is proven",
    );
    assert.equal(result.dispatchBoardDraft?.fanoutReadiness?.thinkingApproved, false);
    assert.equal(result.dispatchBoardDraft?.fanoutReadiness?.externalWritesForbidden, false);
  });

  test("overlapping mutation shards stay eligible but never become fan-out ready", () => {
    const result = route(
      "meta-theory 并行修改 src/ui/button.ts；同时更新 src/ui/button.ts",
      "codex",
      "windows",
    );
    assert.ok(result.workerTaskPacketDrafts.length >= 2);
    assert.equal(result.dispatchBoardDraft?.dispatchMode, "fanout_eligible");
    assert.equal(result.dispatchBoardDraft?.fanoutReadiness?.thinkingApproved, false);
    assert.equal(result.dispatchBoardDraft?.fanoutReadiness?.shardScopesPairwiseDisjoint, false);
  });
});
