import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { readJson } from "./_helpers.mjs";

describe("27 — Governance agent upgrade plan", async () => {
  const planPath = "docs/governance-agent-upgrade-plan.zh-CN.md";
  const plan = existsSync(planPath) ? await readFile(planPath, "utf8") : null;
  const stationContract = await readJson(
    "config/contracts/governance-agent-design-station-contract.json"
  );

  test("documents source-neutral standards and forbidden architecture copying", (t) => {
    if (!plan) {
      t.skip("local-private governance plan is not attached in this workspace");
      return;
    }
    for (const source of [
      "专业角色标准",
      "能力设计与评测标准",
      "产品流程与交付节奏标准",
      "记忆、信任策略、回放标准",
      "子 agent 使用边界标准",
    ]) {
      assert.match(plan, new RegExp(source, "i"));
    }
    assert.match(plan, /不能复制/);
    assert.match(plan, /不能照搬/);
    assert.match(plan, /不能把.*架构.*搬进 Meta_Kim/);
    assert.match(plan, /公开治理文件只保留 Meta_Kim 自己的标准/);
  });

  test("defines the governance agent design stations", (t) => {
    if (!plan) {
      t.skip("local-private governance plan is not attached in this workspace");
      return;
    }
    for (const station of [
      "Boundary Station",
      "Loadout Station",
      "Memory Station",
      "Review Station",
      "Gate Station",
    ]) {
      assert.match(plan, new RegExp(station));
    }
    for (const owner of [
      "meta-genesis",
      "meta-artisan",
      "meta-librarian",
      "meta-prism",
      "meta-warden",
    ]) {
      assert.match(plan, new RegExp(owner));
    }
  });

  test("names the next contract and validation path", (t) => {
    if (!plan) {
      t.skip("local-private governance plan is not attached in this workspace");
      return;
    }
    assert.match(plan, /governance-agent-design-station-contract\.json/);
    assert.match(plan, /agentBoundaryDecision/);
    assert.match(plan, /agentLoadoutDecision/);
    assert.match(plan, /agentMemoryDecision/);
    assert.match(plan, /agentDesignReview/);
    assert.match(plan, /agentCandidateGateDecision/);
    assert.match(plan, /npm run meta:core:mvp:acceptance/);
    assert.match(plan, /npm run meta:test:meta-theory/);
  });

  test("station contract is source-neutral and covers five station outputs", () => {
    assert.equal(
      stationContract.contractId,
      "governance-agent-design-station-contract"
    );
    assert.equal(stationContract.stations.length, 5);
    assert.deepEqual(
      stationContract.stations.map((station) => station.outputPacket),
      [
        "agentBoundaryDecision",
        "agentLoadoutDecision",
        "agentMemoryDecision",
        "agentDesignReview",
        "agentCandidateGateDecision",
      ]
    );
    assert.ok(
      stationContract.sourceTranslationPolicy.mustNotCopy.includes(
        "external prompt wording"
      )
    );
    assert.doesNotMatch(
      JSON.stringify(stationContract),
      /gstack|gbrain|wshobson|Anthropic|(?<!meta-)\bskill-creator\b/i
    );
    assert.ok(stationContract.stations.find(station => station.id === "loadout_station")
      .failIf.some(reason => reason.includes("required meta-skill-creator")),
    "the first-party capability factory remains a required ownership boundary");
  });
});
