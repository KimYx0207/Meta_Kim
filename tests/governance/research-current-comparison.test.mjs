import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { normalizeResearchEvidence, persistResearchEvidence, researchForTask, readTaskResearchEvidence } from "../../scripts/governed-execution/research-records.mjs";
import { normalizeRequirementsDiscovery, normalizeProductDesign } from "../../scripts/governed-execution/product-design.mjs";
import { buildTaskGoalContract } from "../../src/domain/governance/task-outcome.mjs";

const now = Date.parse("2026-11-15T00:00:00Z");
const observedAt = "2026-11-14T18:00:00Z";
function inputFor(taskHash = "industry-task") {
  return { schemaVersion: 2, taskHash, intentDigest: null, required: true,
    topics: [{ id: "channel", question: "Which route fits the intended customer outcome?", keywords: ["commerce"],
      queries: [{ keyword: "commerce", channel: "web", query: "current commerce channel capabilities", observedAt }],
      sourceIds: ["platform", "store"], decisionRefs: ["choose-channel"], decisionImpact: "Channel changes operating cost and user experience",
      status: "resolved", conclusion: "Both candidate routes have different operating requirements",
      decisionContext: { phase: "comparison", decisionQuestionId: "choose-channel", recommendedAlternativeId: "platform",
        recommendationRationale: "A platform reduces the initial operational burden if that outcome is selected",
        alternatives: [
          { id: "platform", mechanism: "Operate on an existing commerce platform", tradeoffs: ["Platform controls the checkout and fees"], sourceIds: ["platform"] },
          { id: "store", mechanism: "Operate an independent storefront", tradeoffs: ["Merchant owns acquisition and operations"], sourceIds: ["store"] }
        ], compatibility: [], remainingUnknowns: [], stopReason: "The evidence supports presenting a material choice; no user choice has occurred" }
    }],
    sources: ["platform", "store"].map(id => ({ id, kind: "official", url: `https://example.com/${id}`, observedAt,
      relevance: "Channel capability fixture", findings: "Source-specific capability fixture", adaptation: "Synthetic regression fixture, not real market evidence" })) };
}

test("current-source age is enforced without silently treating old undated-expiry evidence as fresh", () => {
  const input = inputFor(); delete input.topics[0].decisionContext;
  input.constraints = { evidenceRefs: ["fixture:user-requested-current-information"], maxSourceAgeHours: 24 };
  input.sources[0].observedAt = "2026-11-01T00:00:00Z";
  const result = normalizeResearchEvidence({ input, taskHash: input.taskHash, now });
  assert.ok(result.gaps.includes("research_source_stale:platform"));
  assert.equal(result.readiness, "research_incomplete");
  input.constraints.maxSourceAgeHours = -1;
  assert.throws(() => normalizeResearchEvidence({ input, taskHash: input.taskHash, now }), /source age/i);
});

test("a source-backed comparison preserves a recommendation without inventing a selection", () => {
  const input = inputFor();
  const result = normalizeResearchEvidence({ input, taskHash: input.taskHash, now });
  assert.equal(result.readiness, "ready");
  assert.equal(result.topics[0].decisionContext.phase, "comparison");
  assert.equal(result.topics[0].decisionContext.recommendedAlternativeId, "platform");
  assert.equal(result.topics[0].decisionContext.selectedAlternativeId, undefined);
  const [packet] = researchForTask({ research: result, sourceIds: ["platform"] });
  assert.equal(packet.decisionContexts[0].context.decisionQuestionId, "choose-channel");
  input.topics[0].decisionContext.selectedAlternativeId = "platform";
  assert.throws(() => normalizeResearchEvidence({ input, taskHash: input.taskHash, now }), /comparison.*select/i);
});

test("an unselected research comparison must use the existing material decision frontier", () => {
  const research = inputFor();
  const input = { schemaVersion: 1, taskHash: research.taskHash, intentDigest: null, evidenceRefs: ["fixture:current-research"], research,
    decisionItems: [{ questionId: "choose-channel", question: "Which operating outcome fits?", decisionImpact: "Sets scope and ongoing costs", evidenceRefs: ["fixture:current-research"],
      resolutionClass: "material_user_decision", recommendationRationale: "Start with the lower operational burden if it fits the goal", options: [
        { label: "Platform business", tradeoff: "Lower setup burden with platform dependence" },
        { label: "Independent store", tradeoff: "Own the customer relationship and acquisition burden" }
      ] }] };
  const dialogue = { taskHash: research.taskHash, intentDigest: null };
  assert.equal(normalizeRequirementsDiscovery({ input, dialogue }).decisionItems.length, 1);
  input.decisionItems = [];
  assert.throws(() => normalizeRequirementsDiscovery({ input, dialogue }), /comparison.*decision frontier/i);
});

test("a delivery design cannot consume an unselected material research comparison", () => {
  const goal = buildTaskGoalContract({ task: "Choose an ecommerce business route" });
  const research = normalizeResearchEvidence({ input: inputFor(goal.taskHash), taskHash: goal.taskHash, now });
  const input = { schemaVersion: 1, taskHash: goal.taskHash, intentDigest: null, acceptanceDigest: goal.acceptanceDigest,
    designId: "route", revision: 1, mode: "exploration", sourceRefs: ["fixture:current-research"], researchRefs: ["platform"], taskSlices: [] };
  const dialogue = { taskHash: goal.taskHash, intentDigest: null, settledDecisionRefs: [] };
  assert.equal(normalizeProductDesign({ input, dialogue, goalContract: goal, research }).researchBinding.gaps.length, 0);
  input.mode = "delivery";
  assert.ok(normalizeProductDesign({ input, dialogue, goalContract: goal, research }).researchBinding.gaps.includes("research_choice_pending:choose-channel"));
});

test("rereading rechecks current-source age while preserving independent fresh evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-current-research-"));
  try {
    const input = inputFor(); delete input.topics[0].decisionContext;
    input.constraints = { evidenceRefs: ["fixture:user-requested-current-information"], maxSourceAgeHours: 24 };
    input.sources[1].observedAt = "2026-11-14T00:00:00Z";
    const research = await persistResearchEvidence({ research: normalizeResearchEvidence({ input, taskHash: input.taskHash, now }), projectRoot: root, outputDir: path.join(root, "records") });
    const options = { projectRoot: root, taskHash: input.taskHash, intentDigest: null, now: now + 2 * 60 * 60 * 1000 };
    assert.equal((await readTaskResearchEvidence({ ...options, evidence: researchForTask({ research, sourceIds: ["platform"] }) }))[0].id, "platform");
    await assert.rejects(readTaskResearchEvidence({ ...options, evidence: researchForTask({ research, sourceIds: ["store"] }) }), /stale|source age/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fresh evidence cannot carry a decision whose supporting source has since become stale or expired", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-decision-research-"));
  try {
    for (const reason of ["age", "expiry"]) {
      const input = inputFor();
      if (reason === "age") {
        input.constraints = { evidenceRefs: ["fixture:user-requested-current-information"], maxSourceAgeHours: 24 };
        input.sources[1].observedAt = "2026-11-14T00:00:00Z";
      } else input.sources[1].expiresAt = "2026-11-15T01:00:00Z";
      const research = await persistResearchEvidence({ research: normalizeResearchEvidence({ input, taskHash: input.taskHash, now }), projectRoot: root, outputDir: path.join(root, reason) });
      await assert.rejects(readTaskResearchEvidence({ projectRoot: root, taskHash: input.taskHash, intentDigest: null,
        now: now + 2 * 60 * 60 * 1000, evidence: researchForTask({ research, sourceIds: ["platform"] }) }), /stale|expired/i);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
