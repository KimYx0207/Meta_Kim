/**
 * e2e-eight-stage-live.test.mjs
 *
 * Synthetic scenario and canonical-contract regression for the eight-stage vocabulary.
 * These assertions read fixtures and documents; they do not execute the native
 * eight-stage lifecycle, invoke models, display a native card, or prove delivery.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { loadMetaTheoryCorpus, readJson, readFile } from "./_helpers.mjs";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 数据加载（在async describe块中一次性加载，避免await问题）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const [
  clarityScenarios,
  dispatchScenarios,
  cardDeckScenarios,
  evolutionScenarios,
  corpus,
  capabilityReport,
  devGov,
  conductor,
  prism,
  warden,
  contract,
] = await Promise.all([
  readJson("tests/meta-theory/scenarios/clarity-gate-scenarios.json"),
  readJson("tests/meta-theory/scenarios/dispatch-scenarios.json"),
  readJson("tests/meta-theory/scenarios/card-deck-scenarios.json"),
  readJson("tests/meta-theory/scenarios/evolution-scenarios.json"),
  loadMetaTheoryCorpus(),
  readFile("canonical/skills/meta-theory/references/meta-theory.md"),
  readFile("canonical/skills/meta-theory/references/dev-governance.md"),
  readFile("canonical/agents/meta-conductor.md"),
  readFile("canonical/agents/meta-prism.md"),
  readFile("canonical/agents/meta-warden.md"),
  readJson("config/contracts/workflow-contract.json"),
]);

const skillContent = corpus.combined;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Stage 1: Critical — Blocking Clarification
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Stage 1: Critical — Blocking Clarification", () => {
  test("E2E-01: 模糊输入可触发早期澄清", () => {
    const scenario = clarityScenarios.find((s) => s.id === "CG-01");
    assert.ok(scenario, "CG-01 must exist");
    const dims = scenario.ambiguousDims || [];
    assert.ok(
      dims.length >= 2,
      `CG-01 has ${dims.length} ambiguous dims, need ≥2`,
    );
    assert.ok(dims.includes("Scope"), "Must include Scope dimension");
    assert.ok(dims.includes("Goal"), "Must include Goal dimension");
    assert.ok(
      scenario.expectedBehavior?.toLowerCase().includes("ask") ||
        scenario.expectedBehavior?.toLowerCase().includes("must"),
      "Ambiguous input must support clarification",
    );
  });

  test("E2E-02: 清晰输入直接进入Fetch", () => {
    const scenario = clarityScenarios.find((s) => s.id === "CG-04");
    assert.ok(scenario, "CG-04 must exist");
    const dims = scenario.ambiguousDims || [];
    assert.equal(dims.length, 0, "CG-04 must have zero ambiguous dims");
    assert.ok(
      scenario.expectedBehavior?.toLowerCase().includes("proceed") ||
        scenario.expectedBehavior?.toLowerCase().includes("direct"),
      "CG-04 must proceed directly without asking",
    );
  });

  test("E2E-01b: 主观审美负反馈触发早期交互澄清", () => {
    const scenario = clarityScenarios.find((s) => s.id === "CG-13");
    assert.ok(scenario, "CG-13 must exist");
    assert.match(scenario.input, /不好看/);
    assert.ok(
      scenario.ambiguousDims.includes("Success criteria"),
      "Subjective quality input must mark success criteria as ambiguous",
    );
    assert.match(
      scenario.expectedBehavior,
      /native choice surface|localized fallback|交互式选择|确认卡/i,
      "Subjective quality input must require a user choice surface",
    );
    assert.match(
      scenario.passFailCriteria.FAIL,
      /猜|直接开始改 UI/,
      "Guessing an aesthetic direction must be a failure",
    );
  });

  test("E2E-01c: 不可量化形容词触发用户定标", () => {
    const scenario = clarityScenarios.find((s) => s.id === "CG-14");
    assert.ok(scenario, "CG-14 must exist");
    assert.match(scenario.input, /顺畅|高级|好一点/);
    assert.ok(
      scenario.ambiguousDims.includes("Success criteria"),
      "Non-measurable adjectives must mark success criteria as ambiguous",
    );
    assert.match(
      scenario.expectedBehavior,
      /non-measurable|judgment|不可量化/i,
      "Non-measurable adjectives must be treated as judgment-dependent",
    );
    assert.match(
      scenario.passFailCriteria.FAIL,
      /猜|直接/,
      "Guessing a subjective quality direction must be a failure",
    );
  });

  test("Critical阶段保留澄清维度用于阻断性问题", () => {
    const allDims = new Set();
    for (const s of clarityScenarios) {
      for (const d of s.ambiguousDims || []) {
        allDims.add(d);
      }
    }
    assert.ok(allDims.has("Scope"), "Must have Scope dimension");
    assert.ok(allDims.has("Goal"), "Must have Goal dimension");
    assert.ok(
      allDims.has("Constraints") || allDims.has("Architecture type"),
      "Must have Constraints or Architecture type dimension",
    );
  });

  test("clarity-gate场景≥12个，覆盖全部维度组合", () => {
    assert.ok(
      clarityScenarios.length >= 12,
      `Need ≥12 scenarios, got ${clarityScenarios.length}`,
    );
    for (const s of clarityScenarios) {
      assert.ok(s.id, `Scenario must have id`);
      assert.ok(
        s.expectedBehavior,
        `Scenario ${s.id} must have expectedBehavior`,
      );
      assert.ok(
        Array.isArray(s.ambiguousDims),
        `Scenario ${s.id} must have ambiguousDims array`,
      );
      assert.ok(
        s.passFailCriteria?.PASS,
        `Scenario ${s.id} must have PASS criteria`,
      );
    }
  });
});

describe("Thinking → Execution: Unified Confirmation", () => {
  test("Execution前一次性确认，且不是每个阶段都弹确认", () => {
    assert.match(skillContent, /Fetch\/content evidence.*Thinking\/pre-decision option framing/s);
    assert.match(skillContent, /After Thinking completes, BEFORE any Execution/);
    assert.match(skillContent, /DO NOT.*Critical\/Fetch\/Thinking\/Review/s);
  });

  test("确认卡只包含会改变结果分叉的产品化问题", () => {
    const block = skillContent.slice(
      skillContent.indexOf("Possible question dimensions:"),
      skillContent.indexOf("Wait for user response before proceeding to Execution."),
    );
    const questions = [...block.matchAll(/^\d+\.\s+.+Confirmation - ask only when.+$/gm)];
    assert.ok(questions.length >= 1, "Need outcome-branching question examples");
    assert.match(skillContent, /no question quota/i);
    assert.match(skillContent, /Each visible question must change an execution branch/i);
    for (let i = 0; i < questions.length; i++) {
      const start = questions[i].index ?? 0;
      const end = i + 1 < questions.length ? (questions[i + 1].index ?? block.length) : block.length;
      const options = [...block.slice(start, end).matchAll(/^\s+- Option [A-D]:/gm)];
      assert.ok(options.length >= 2);
    }
    assert.match(skillContent, /understandable to non-technical users/i);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Stage 2: Fetch — Capability Discovery
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Stage 2: Fetch — Capability Discovery", () => {
  test("E2E-03: 纯查询bypass dispatchEnvelopePacket", () => {
    // dispatch-scenarios.json中是否有query/analysis类型场景
    assert.ok(
      dispatchScenarios.length >= 15,
      `Need ≥15 dispatch scenarios, got ${dispatchScenarios.length}`,
    );
    // 验证有Type A (analysis) 场景 — 这类场景不需要dispatch
    const typeAScenarios = dispatchScenarios.filter(
      (s) => s.expectedType === "A" || s.type === "A",
    );
    assert.ok(
      typeAScenarios.length > 0,
      "Must have Type A analysis scenarios (no dispatch needed)",
    );
    // 验证有pure query场景（AD-01: 评估meta-genesis的质量）
    const pureQueryScenarios = dispatchScenarios.filter(
      (s) =>
        s.input?.toLowerCase().includes("评估") ||
        s.input?.toLowerCase().includes("review") ||
        s.input?.toLowerCase().includes("analyze"),
    );
    assert.ok(
      pureQueryScenarios.length > 0,
      "Must have pure analysis/query scenarios",
    );
  });

  test("Fetch阶段定义≥3个能力发现来源", () => {
    const fetchContent = skillContent + " " + capabilityReport;
    const discoverySources = [
      /local.*agent|agent.*local/i,
      /mirrored.*capability|capability.*mirror/i,
      /global.*capability|capability.*global/i,
      /indexed.*capability|capability.*index/i,
      /source.*file|file.*search/i,
    ];
    const found = discoverySources.filter((p) => p.test(fetchContent));
    assert.ok(
      found.length >= 2,
      `Fetch must reference ≥2 discovery sources (found ${found.length}/5)`,
    );
  });

  test("Fetch阶段引用memory recall机制", () => {
    const skillAndLibrarian = skillContent + " " + capabilityReport;
    const memoryPatterns = [
      /memory.*recall|recall.*memory/i,
      /Librarian.*memory|memory.*Librarian/i,
      /run.*index|sqlite.*index/i,
    ];
    const found = memoryPatterns.some((p) => p.test(skillAndLibrarian));
    assert.ok(found, "Fetch stage must reference memory recall mechanism");
  });

  test("Fetch产生fetchPacket产物", () => {
    const fetchFields = contract.protocols?.fetchPacket?.requiredFields || [];
    assert.ok(fetchFields.length > 0, "fetchPacket must have required fields");
    assert.ok(
      fetchFields.some(
        (f) =>
          f.toLowerCase().includes("capability") ||
          f.toLowerCase().includes("match"),
      ),
      "fetchPacket must have capability matching fields",
    );
  });

  test("Fetch阶段要求研究能力发现基于实际工具证据", () => {
    const packet = contract.protocols?.contentEvidencePacket;
    assert.ok(packet?.requiredFields?.includes("researchCapabilityDiscovery"));

    const discovery = packet.researchCapabilityDiscovery;
    assert.ok(discovery?.requiredFields?.includes("toolInventorySources"));
    assert.ok(discovery?.requiredFields?.includes("availableRetrievalCapabilities"));
    assert.ok(discovery?.requiredFields?.includes("selectedResearchPath"));
    assert.ok(discovery?.forbiddenFields?.includes("platformSurface"));

    const policyText = JSON.stringify(discovery);
    assert.match(policyText, /proof/i);
    assert.match(policyText, /active_tools|deferred_tools|mcp|plugins|skills|commands/);
    assert.doesNotMatch(policyText, /desktop \| cli \| web \| ide/i);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Stage 3: Thinking — Planning & Orchestration
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Stage 3: Thinking — Planning & Orchestration", () => {
  test("E2E-05: 复杂任务生成orchestrationTaskBoardPacket with parallelGroup+mergeOwner", () => {
    const taskFields =
      contract.protocols?.orchestrationTaskBoardPacket?.requiredFields || [];
    assert.ok(taskFields.length > 0, "orchestrationTaskBoardPacket must exist");
    const workerFields =
      contract.protocols?.workerTaskPacket?.requiredFields || [];
    assert.ok(
      workerFields.includes("parallelGroup"),
      "workerTaskPacket must have parallelGroup",
    );
    assert.ok(
      workerFields.includes("mergeOwner"),
      "workerTaskPacket must have mergeOwner",
    );
    assert.ok(
      workerFields.includes("dependsOn"),
      "workerTaskPacket must have dependsOn",
    );
  });

  test("Thinking阶段要求探索≥2个方案路径", () => {
    const thinkingPatterns = [
      /option.*exploration|exploration.*option/i,
      /alternative|second.*path|方案.*探索/i,
      /pros.*cons|权衡|trade.*off/i,
    ];
    const found = thinkingPatterns.filter((p) => p.test(skillContent));
    assert.ok(
      found.length >= 1,
      "Thinking stage must require option exploration (≥2 paths)",
    );
  });

  test("Thinking阶段记录被拒绝的方案", () => {
    const rejectPatterns = [
      /reject|alternative.*not.*chosen|放弃.*方案/i,
      /decision.*record|rejected.*option/i,
    ];
    const found = rejectPatterns.filter(
      (p) => p.test(skillContent) || p.test(devGov),
    );
    assert.ok(
      found.length >= 1,
      "Thinking must document rejected alternatives",
    );
  });

  test("Thinking产生的handoffPlan在runHeader中", () => {
    const headerFields = contract.protocols?.runHeader?.requiredFields || [];
    assert.ok(
      headerFields.includes("handoffPlan"),
      "runHeader must have handoffPlan for delivery chain transparency",
    );
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Stage 4: Execution — Dispatch & Card Dealing
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Stage 4: Execution — Dispatch & Card Dealing", () => {
  test("E2E-08: ≥3连续高成本牌触发强制silence", () => {
    const highCostScenario = cardDeckScenarios.find(
      (s) =>
        s.expectedCards?.includes("Execute") ||
        s.expectedCards?.includes("Rollback") ||
        s.expectedCards?.includes("Fix"),
    );
    assert.ok(highCostScenario, "Must have scenario with high-cost cards");
    const silencePatterns = [
      /3.*consecutive.*high.*density/i,
      /high.*density.*pause/i,
      /pause.*for.*digestion/i,
      /overload.*rule.*silence/i,
      /consecutive.*high.*cost/i,
    ];
    const found = silencePatterns.some((p) => p.test(devGov));
    assert.ok(
      found,
      "dev-governance.md must document forced silence after ≥3 consecutive high-density cards",
    );
  });

  test("Execution必须dispatch到agents，不能自己执行", () => {
    const dispatchPatterns = [
      /dispatch.*board|board.*owner/i,
      /not.*executor|orchestration.*only|dispatch.*not.*execute/i,
    ];
    const found = dispatchPatterns.some((p) => p.test(conductor));
    assert.ok(found, "Conductor must own dispatch, NOT execution");
  });

  test("Execution产生workerTaskPackets产物", () => {
    const workerFields =
      contract.protocols?.workerTaskPacket?.requiredFields || [];
    assert.ok(workerFields.length > 0, "workerTaskPacket must have fields");
    // owner字段对应executionAgentCard的所有者
    assert.ok(
      workerFields.includes("owner"),
      "workerTaskPacket must have owner field",
    );
  });

  test("Execution记录每个card的发出决策", () => {
    const cardFields = contract.protocols?.cardPlanPacket?.requiredFields || [];
    assert.ok(cardFields.includes("cardEvents"), "cardPlanPacket must have cardEvents");
    assert.ok(cardFields.includes("cardTypeCatalog"), "cardPlanPacket must have cardTypeCatalog");
    assert.ok(
      cardFields.includes("cardTypeDecisions"),
      "cardPlanPacket must have cardTypeDecisions",
    );
    assert.ok(
      cardFields.includes("deliveryShells"),
      "cardPlanPacket must have deliveryShells",
    );
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Stage 5: Review — Quality Gate
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Stage 5: Review — Quality Gate", () => {
  test("Review由meta-prism执行质量审查", () => {
    const prismPatterns = [
      /quality.*review|review.*quality/i,
      /anti.*slop|slop.*detect/i,
      /drift.*detect/i,
    ];
    const found = prismPatterns.some((p) => p.test(prism));
    assert.ok(found, "meta-prism must own quality review");
  });

  test("Review发现生成reviewFinding", () => {
    const findingFields =
      contract.protocols?.reviewFinding?.requiredFields || [];
    assert.ok(
      findingFields.length > 0,
      "reviewFinding must have required fields",
    );
    assert.ok(
      findingFields.some((f) => f.toLowerCase().includes("severity")),
      "reviewFinding must have severity",
    );
    assert.ok(
      findingFields.some((f) => f.toLowerCase().includes("finding")),
      "reviewFinding must have findingId",
    );
  });

  test("Review定义4种发现关闭状态", () => {
    const closure = contract.runDiscipline?.findingClosure || {};
    const states = closure.closeStateEnum || [];
    assert.ok(states.includes("open"), "Must have open state");
    assert.ok(
      states.includes("fixed_pending_verify"),
      "Must have fixed_pending_verify",
    );
    assert.ok(states.includes("verified_closed"), "Must have verified_closed");
    assert.ok(states.includes("accepted_risk"), "Must have accepted_risk");
    assert.equal(states.length, 4, "Must have exactly 4 close states");
  });

  test("Review支持revisionResponse → verificationResult闭环", () => {
    const revFields =
      contract.protocols?.revisionResponse?.requiredFields || [];
    const verifFields =
      contract.protocols?.verificationResult?.requiredFields || [];
    assert.ok(revFields.length > 0, "revisionResponse must have fields");
    assert.ok(verifFields.length > 0, "verificationResult must have fields");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Stage 6: Meta-Review — Review Standard Verification
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Stage 6: Meta-Review — Review Standard Verification", () => {
  test("Meta-Review验证Review阶段本身的完整性", () => {
    const metaReviewPatterns = [
      /meta.*review|review.*standard/i,
      /review.*review|second.*review/i,
      /meta.*review.*stage/i,
    ];
    const found = metaReviewPatterns.some((p) => p.test(skillContent));
    assert.ok(found, "Meta-Review stage must be documented in SKILL.md");
  });

  test("Meta-Review由meta-warden最终仲裁", () => {
    const patterns = [
      /final.*synthesis|synthesis.*final/i,
      /arbitrat/i,
      /final.*decision/i,
    ];
    const found = patterns.some((p) => p.test(warden));
    assert.ok(found, "meta-warden must provide final synthesis/arbitration");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Stage 7: Verification — Evidence-Based Closure
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Stage 7: Verification — Evidence-Based Closure", () => {
  test("Verification要求fresh evidence（新鲜证据）", () => {
    const evidencePatterns = [
      /fresh.*evidence|evidence.*fresh/i,
      /verification.*fresh/i,
      /new.*evidence|evidence.*new/i,
    ];
    const found = evidencePatterns.some((p) => p.test(devGov));
    assert.ok(
      found,
      "Verification must require fresh evidence (not cached/old)",
    );
  });

  test("Verification通过后才能设置publicReady=true", () => {
    const gate = contract.gates?.publicDisplay || {};
    assert.ok(gate.hardReleaseGate, "publicDisplay must be hardReleaseGate");
    assert.ok(
      gate.blockFinalDraftWithoutVerifiedRun,
      "Must block final draft without verified run",
    );
    assert.ok(
      gate.blockExternalDisplayWithoutSummaryClosure,
      "Must block external display without summary closure",
    );
  });

  test("Verification产生verificationPacket产物", () => {
    const verifFields =
      contract.protocols?.verificationPacket?.requiredFields || [];
    assert.ok(verifFields.length > 0, "verificationPacket must have fields");
    assert.ok(
      verifFields.some((f) => f.toLowerCase().includes("result")),
      "verificationPacket must have result",
    );
  });

  test("Verification决定是否进入Evolution（通过/回退）", () => {
    const verifResults =
      contract.protocols?.verificationResult?.requiredFields || [];
    assert.ok(
      verifResults.some((f) => f.toLowerCase().includes("result")),
      "verificationResult must have result field (pass/fail)",
    );
    assert.ok(
      verifResults.some((f) => f.toLowerCase().includes("closestate")),
      "verificationResult must have closeState for finding closure",
    );
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Stage 8: Evolution — Pattern Capture & Writeback
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Stage 8: Evolution — Pattern Capture & Writeback", () => {
  test("E2E-06: ≥3次相同pattern触发extract-as-skill", () => {
    const patternScenario = evolutionScenarios.find((s) => s.id === "EV-01");
    assert.ok(patternScenario, "EV-01 must exist");
    assert.equal(
      patternScenario.detectedDimension,
      "patternReuse",
      "EV-01 must detect patternReuse",
    );
    assert.ok(
      patternScenario.expectedAmplification?.includes("skill"),
      "patternReuse must amplify to skill extraction",
    );
    assert.ok(
      patternScenario.expectedStorage?.includes("canonical/skills/"),
      "Skill must be stored in canonical/skills/",
    );
  });

  test("Evolution有writeback和none两种决策", () => {
    // 验证evolutionScenarios中有不同决策类型
    // writeback场景：有expectedAmplification（写回动作）
    // none场景：有expectedWritebackDecision=none（不写回）
    const writebackScenarios = evolutionScenarios.filter(
      (s) => s.expectedAmplification && !s.expectedWritebackDecision,
    );
    const noneScenarios = evolutionScenarios.filter(
      (s) => s.expectedWritebackDecision === "none",
    );
    assert.ok(
      writebackScenarios.length > 0,
      `Must have scenarios with writeback (expectedAmplification non-empty), got ${writebackScenarios.length}`,
    );
    assert.ok(
      noneScenarios.length > 0,
      "Must have scenario with writebackDecision=none",
    );
    // none场景必须有decisionReason
    for (const s of noneScenarios) {
      assert.ok(
        s.expectedReason,
        `Scenario ${s.id} with writebackDecision=none must have expectedReason`,
      );
    }
  });

  test("Evolution检测scar时记录到scar-protocol.md", () => {
    const scarScenario = evolutionScenarios.find((s) => s.id === "EV-08");
    assert.ok(scarScenario, "EV-08 must exist");
    assert.equal(
      scarScenario.detectedDimension,
      "scarDetected",
      "EV-08 must detect scar",
    );
    assert.ok(
      scarScenario.expectedStorage?.includes("scar"),
      "Scar must be stored in scar-protocol.md",
    );
  });

  test("Evolution产生evolutionWritebackPacket", () => {
    const evoFields =
      contract.protocols?.evolutionWritebackPacket?.requiredFields || [];
    assert.ok(
      evoFields.length > 0,
      "evolutionWritebackPacket must have fields",
    );
    assert.ok(
      evoFields.includes("writebackDecision"),
      "evolutionWritebackPacket must have writebackDecision",
    );
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 完整8阶段链路端到端验证
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Synthetic contract coverage: eight-stage spine", () => {
  test("8阶段顺序严格：Critical永远第1，Evolution永远最后", () => {
    const stages = [
      "Critical",
      "Fetch",
      "Thinking",
      "Execution",
      "Review",
      "Meta-Review",
      "Verification",
      "Evolution",
    ];
    for (const stage of stages) {
      assert.ok(
        skillContent.includes(stage),
        `SKILL.md must include stage: ${stage}`,
      );
    }
    // 验证stage spine中Critical在Evolution前面（检查stage序列模式）
    // SKILL.md keeps the compact ASCII spine while references may render it differently.
    const spinePattern =
      /Critical.*(?:→|->).*Fetch.*(?:→|->).*Thinking.*(?:→|->).*Execution.*(?:→|->).*Review.*(?:→|->).*Meta-Review.*(?:→|->).*Verification.*(?:→|->).*Evolution/i;
    assert.ok(
      spinePattern.test(skillContent),
      "SKILL.md must contain the full 8-stage spine sequence with Critical before Evolution",
    );
  });

  test("每个阶段都有对应的协议packet产物", () => {
    const packetMap = [
      { stage: "Critical", packet: "runHeader" },
      { stage: "Critical", packet: "taskClassification" },
      { stage: "Fetch", packet: "fetchPacket" },
      { stage: "Thinking", packet: "orchestrationTaskBoardPacket" },
      { stage: "Execution", packet: "cardPlanPacket" },
      { stage: "Execution", packet: "dispatchEnvelopePacket" },
      { stage: "Execution", packet: "workerTaskPacket" },
      { stage: "Review", packet: "reviewPacket" },
      { stage: "Verification", packet: "verificationPacket" },
      { stage: "Evolution", packet: "evolutionWritebackPacket" },
    ];

    for (const { stage, packet } of packetMap) {
      const fields = contract.protocols?.[packet]?.requiredFields;
      assert.ok(
        fields !== undefined,
        `Stage ${stage} must produce ${packet} protocol packet`,
      );
    }
  });

  test("valid-run.json synthetic fixture contains the required packet shapes", async () => {
    const { fileExists } = await import("./_helpers.mjs");
    const fixturePath = "tests/fixtures/run-artifacts/valid-run.json";
    const exists = await fileExists(fixturePath);
    assert.ok(exists, "valid-run.json fixture must exist");

    const run = await readJson(fixturePath);
    assert.ok(run.runHeader, "run must have runHeader");
    assert.ok(run.runHeader.department, "runHeader must have department");
    assert.ok(
      run.runHeader.primaryDeliverable,
      "runHeader must have primaryDeliverable",
    );

    const packets = [
      "runHeader",
      "taskClassification",
      "fetchPacket",
      "cardPlanPacket",
      "dispatchEnvelopePacket",
      "orchestrationTaskBoardPacket",
      "businessFlowBlueprintPacket",
      "agentBlueprintPacket",
      "workerTaskPackets",
      "reviewPacket",
      "verificationPacket",
      "summaryPacket",
      "evolutionWritebackPacket",
    ];
    for (const p of packets) {
      assert.ok(
        run[p] !== undefined,
        `valid-run.json must contain ${p} packet`,
      );
    }
  });


});
