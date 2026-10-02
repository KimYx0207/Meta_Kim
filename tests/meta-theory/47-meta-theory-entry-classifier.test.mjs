import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "./_helpers.mjs";
import {
  classifyMetaTheoryEntry,
  validateEntryLexicon,
} from "../../scripts/meta-theory-entry-classifier.mjs";
import lexicon from "../../config/governance/entry-classification-lexicon.json" with { type: "json" };

describe("47 - Meta-theory entry classifier", () => {
  test("entry lexicon enforces the complete bounded four-language schema", () => {
    assert.equal(validateEntryLexicon(structuredClone(lexicon)).schemaVersion, 1);

    const missingLanguage = structuredClone(lexicon);
    delete missingLanguage.categories.action.ko;
    assert.throws(() => validateEntryLexicon(missingLanguage), /exactly en, zh, ja, and ko/);

    const emptyMatcher = structuredClone(lexicon);
    emptyMatcher.categories.action.ja = [];
    assert.throws(() => validateEntryLexicon(emptyMatcher), /must contain 1-128 terms/);

    const oversized = structuredClone(lexicon);
    oversized.categories.action.en = Array.from({ length: 129 }, (_, index) => `term-${index}`);
    assert.throws(() => validateEntryLexicon(oversized), /must contain 1-128 terms/);

    const extraCategory = structuredClone(lexicon);
    extraCategory.categories.extra = structuredClone(extraCategory.categories.action);
    assert.throws(() => validateEntryLexicon(extraCategory), /must define exactly/);
  });
  test("explicit meta-theory activation enters regulated path", () => {
    const result = classifyMetaTheoryEntry("meta-theory 帮我做治理审查");

    assert.equal(result.governedEntry, true);
    assert.equal(result.path, "regulated_path");
    assert.equal(result.taskClassification, "meta_theory_explicit");
    assert.equal(result.triggerReason, "explicit_meta_theory");
    assert.equal(result.signals.explicitMetaTheory, true);
    assert.equal("fanoutEligible" in result, false);
    assert.equal("choiceSurfaceState" in result, false);
  });

  test("ordinary natural-language durable work enters governed path", () => {
    const prompt =
      "我想把客户反馈自动整理成优先级、修复建议和验证清单，请帮我规划并开始处理。";
    assert.doesNotMatch(prompt, /agent|skill|MCP|command|阶段|packet|JSON/i);

    const result = classifyMetaTheoryEntry(prompt);

    assert.equal(result.governedEntry, true);
    assert.equal(result.path, "standard_path");
    assert.equal(result.taskClassification, "meta_theory_auto");
    assert.equal(result.triggerReason, "natural_language_durable_work");
    assert.equal(result.signals.durableOutputIntent, true);
    assert.equal("shouldAskBeforeFetch" in result, false);
  });

  test("onboarding and recovery improvement requests enter the governed standard path", () => {
    for (const prompt of [
      "Please streamline the onboarding experience and make recovery clearer",
      "把新手上手体验捋顺，失败后要能恢复",
      "オンボーディング体験を改善し、失敗後の復旧を明確にしてください",
      "온보딩 경험을 개선하고 실패 후 복구를 명확하게 해주세요",
    ]) {
      const result = classifyMetaTheoryEntry(prompt);
      assert.equal(result.governedEntry, true, prompt);
      assert.equal(result.path, "standard_path", prompt);
      assert.equal(result.taskClassification, "meta_theory_auto", prompt);
    }
  });

  test("requested professional deliverables enter governance without requiring technical vocabulary", () => {
    for (const prompt of [
      "请把我的客服经历改成运营助理岗位简历",
      "这篇正文写好了，请给小红书标题和封面文字",
      "把本周报价进度写成发给主管的周报",
      "根据这些实测参数写商品卖点文案",
      "请按这些帆布袋参数写商品详情页和卖点",
      "顾客一直催发货，帮我拟一段客服回复",
      "帮我准备一份四十五分钟的分数教案",
      "围绕这个知识点帮我出三道练习题",
      "帮我核算这项服务的成本并给出报价",
    ]) {
      const result = classifyMetaTheoryEntry(prompt);
      assert.equal(result.path, "standard_path", prompt);
      assert.equal(result.signals.durableOutputIntent, true, prompt);
    }
  });

  test("professional terminology alone does not turn an informational question into execution", () => {
    for (const prompt of ["简历是什么？", "标题与封面文字有什么区别？", "这个知识点我没懂是什么意思？"]) {
      const result = classifyMetaTheoryEntry(prompt);
      assert.equal(result.path, "fast_path", prompt);
      assert.equal(result.governedEntry, false, prompt);
    }
  });

  test("wish-style product build enters governed path without protocol words", () => {
    const prompt = "帮我做个小红书营销自动发布器";
    assert.doesNotMatch(prompt, /agent|skill|MCP|command|阶段|packet|JSON|优先级|验证清单/i);

    const result = classifyMetaTheoryEntry(prompt);

    assert.equal(result.governedEntry, true);
    assert.equal(result.path, "standard_path");
    assert.equal(result.taskClassification, "meta_theory_auto");
    assert.equal(result.triggerReason, "natural_language_product_build");
    assert.equal(result.signals.productBuildIntent, true);
    assert.equal("fanoutEligible" in result, false);
    assert.equal("subagentAuthorizationSource" in result, false);
  });

  test("human fuzzy product idea enters product-build route without capability words", () => {
    const prompt =
      "我想做个东西，能把我平时随手记的想法变成能发出去的内容，但我现在也说不清先做成啥，你帮我拆一下怎么落地，别真发。";
    assert.doesNotMatch(prompt, /agent|skill|MCP|command|findskill|tool|阶段|packet|JSON/i);

    const result = classifyMetaTheoryEntry(prompt);

    assert.equal(result.governedEntry, true);
    assert.equal(result.path, "standard_path");
    assert.equal(result.taskClassification, "meta_theory_auto");
    assert.equal(result.triggerReason, "natural_language_product_build");
    assert.equal(result.signals.productBuildIntent, true);
    assert.ok(result.signals.parallelismHints.distinctCapabilityTermCount >= 0);
  });

  test("review plus fix plus verify records parallel-work hints without deciding fan-out", () => {
    const result = classifyMetaTheoryEntry(
      "review + fix + verify 这个仓库的 hook、runner、测试，做完再告诉我。",
    );

    assert.equal(result.governedEntry, true);
    assert.equal(result.signals.directParallelRequest, true);
    assert.equal(result.signals.parallelismHints.reviewFixVerifyPattern, true);
    assert.equal("expectedIndependentLaneCount" in result, false);
  });

  test("direct Chinese dispatch and parallel correction records explicit concurrency intent", () => {
    const result = classifyMetaTheoryEntry("不是 我要的是派发啊 并行啊");

    assert.equal(result.governedEntry, true);
    assert.equal(result.path, "standard_path");
    assert.equal(result.taskClassification, "meta_theory_auto");
    assert.equal(result.triggerReason, "direct_parallel_dispatch_request");
    assert.equal(result.signals.directParallelRequest, true);
    assert.equal("fanoutEligible" in result, false);
    assert.equal("requiresSubagentAuthorization" in result, false);
  });

  test("contextual repeated creation complaint enters governed diagnosis", () => {
    const result = classifyMetaTheoryEntry("我看他好像还是一直在自己创建");

    assert.equal(result.governedEntry, true);
    assert.equal(result.path, "standard_path");
    assert.equal(result.taskClassification, "meta_theory_auto");
    assert.equal(result.triggerReason, "serial_agent_route_complaint");
    assert.equal(result.signals.serialOrSlowRouteComplaint, true);
  });

  test("critical fetch thinking review wording enters governed path without explicit meta-theory", () => {
    const result = classifyMetaTheoryEntry(
      "critical and fetch thinking and review 帮我检查项目级更新、全局能力扫描和发布验证",
    );

    assert.equal(result.governedEntry, true);
    assert.equal(result.path, "standard_path");
    assert.equal(result.taskClassification, "meta_theory_auto");
    assert.equal(result.signals.structuredGovernanceChainRequest, true);
    assert.equal("subagentAuthorizationSource" in result, false);
  });

  test("arrow-form Critical Fetch Deep Thinking Review chain records a concurrency hint without claiming safe fan-out", () => {
    const result = classifyMetaTheoryEntry(
      "Critical Thinking → Fetch → Deep Thinking → Review 检查治理规则、Codex runtime、测试缺口",
    );

    assert.equal(result.governedEntry, true);
    assert.equal(result.path, "standard_path");
    assert.equal(result.taskClassification, "meta_theory_auto");
    assert.equal(result.triggerReason, "critical_fetch_thinking_review_requested");
    assert.equal(result.signals.structuredGovernanceChainRequest, true);
    assert.equal("fanoutEligible" in result, false);
    assert.equal("expectedIndependentLaneCount" in result, false);
  });

  test("explicit meta-theory with a serial-agent complaint preserves both factual signals", () => {
    const result = classifyMetaTheoryEntry(
      "你太慢了，没看到多个 agent 并行，critical and fetch thinking and review /meta-theory",
    );

    assert.equal(result.governedEntry, true);
    assert.equal(result.path, "regulated_path");
    assert.equal(result.signals.explicitMetaTheory, true);
    assert.equal(result.signals.directParallelRequest, true);
    assert.equal(result.signals.serialOrSlowRouteComplaint, true);
  });

  test("explicit meta-theory without subagent wording does not claim fan-out or authorization", () => {
    const result = classifyMetaTheoryEntry(
      "[$meta-theory](D:/workspace/Meta_Kim/.agents/skills/meta-theory/SKILL.md) 帮我调整好，案例也需要对应检查，如果需要生成图片，用image2",
    );

    assert.equal(result.governedEntry, true);
    assert.equal(result.path, "regulated_path");
    assert.equal(result.signals.explicitMetaTheory, true);
    assert.equal("fanoutEligible" in result, false);
    assert.equal("subagentAuthorizationSource" in result, false);
  });

  test("plain meta-theory trigger records text evidence and leaves fan-out to Thinking", () => {
    const result = classifyMetaTheoryEntry(
      "meta-theory 检查 meta-theory 规则、Codex runtime、测试缺口",
    );

    assert.equal(result.governedEntry, true);
    assert.equal(result.path, "regulated_path");
    assert.equal(result.signals.explicitMetaTheory, true);
    assert.equal(result.signals.governedMetaTrigger, true);
    assert.equal("fanoutEligible" in result, false);
  });

  test("subjective quality request reports choice-relevant facts without owning the choice lifecycle", () => {
    const result = classifyMetaTheoryEntry("这个页面不好看，帮我弄高级一点");

    assert.equal(result.governedEntry, true);
    assert.equal(result.path, "standard_path");
    assert.equal(result.triggerReason, "subjective_quality_ambiguous");
    assert.equal(result.signals.subjectiveQualitySignal, true);
    assert.equal(result.signals.actionIntent, true);
    assert.ok(result.signals.routeChangingDimensionSignals.includes("quality_or_acceptance"));
    assert.equal("choiceSurfaceState" in result, false);
    assert.equal("shouldAskBeforeFetch" in result, false);
    assert.equal("ambiguityPacket" in result, false);
  });

  test("destructive production execution enters governance without owning the choice decision", () => {
    const result = classifyMetaTheoryEntry("删除生产数据库并发布上线");
    assert.equal(result.governedEntry, true);
    assert.equal(result.path, "standard_path");
    assert.equal(result.triggerReason, "high_risk_execution_intent");
    assert.equal(result.signals.highRiskTermSignal, true);
    assert.equal(result.signals.destructiveOrProductionIntent, true);
    assert.equal("ambiguityPacket" in result, false);
  });

  test("release-themed capability names are not mistaken for a live production operation", () => {
    const result = classifyMetaTheoryEntry(
      "请在当前项目新建 agent governed-release-auditor，负责审查发布配置并拒绝写操作。",
    );
    assert.equal(result.governedEntry, true);
    assert.equal(result.signals.destructiveOrProductionIntent, false);
    assert.equal(result.signals.destructiveOrProductionTermSignal, false);
  });

  test("project understanding questions enter governed Fetch path", () => {
    const result = classifyMetaTheoryEntry("这个项目是什么？");

    assert.equal(result.governedEntry, true);
    assert.equal(result.path, "standard_path");
    assert.equal(result.taskClassification, "meta_theory_auto");
    assert.equal(result.triggerReason, "project_understanding_requires_fetch");
  });

  test("commercialization strategy questions enter governed Fetch path", () => {
    const result = classifyMetaTheoryEntry("这个项目如果商业化应该怎么发展？");

    assert.equal(result.governedEntry, true);
    assert.equal(result.path, "standard_path");
    assert.equal(result.triggerReason, "project_understanding_requires_fetch");
  });

  test("existing governed execution CLI exposes entry classification without running a full run", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-meta-theory-governed-execution.mjs",
        "--classify-entry",
        "--task",
        "我想把客户反馈自动整理成优先级、修复建议和验证清单，请帮我规划并开始处理。",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.governedEntry, true);
    assert.equal(payload.triggerReason, "natural_language_durable_work");
    assert.equal(payload.taskClassification, "meta_theory_auto");
  });

  test("CLI classifies wish-style product build as governed work", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-meta-theory-governed-execution.mjs",
        "--classify-entry",
        "--task",
        "帮我做个小红书营销自动发布器",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.governedEntry, true);
    assert.equal(payload.path, "standard_path");
    assert.equal(payload.triggerReason, "natural_language_product_build");
    assert.equal(payload.taskClassification, "meta_theory_auto");
    assert.equal(payload.signals.productBuildIntent, true);
    assert.equal("fanoutEligible" in payload, false);
  });

  test("CLI temp-output flag does not consume a positional task", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-meta-theory-governed-execution.mjs",
        "--classify-entry",
        "--temp-output",
        "帮我做个小红书营销自动发布器",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.governedEntry, true);
    assert.equal(payload.path, "standard_path");
    assert.equal(payload.triggerReason, "natural_language_product_build");
    assert.notEqual(payload.triggerReason, "empty_input");
  });

  test("user-facing docs present natural language as the normal entry path", async () => {
    const readme = await readFile("README.md");
    const readmeZh = await readFile("README.zh-CN.md");
    const agents = await readFile("AGENTS.md");
    const skill = await readFile("canonical/skills/meta-theory/SKILL.md");
    const combined = `${readme}\n${readmeZh}\n${agents}\n${skill}`;

    assert.match(readme, /humans should be able to use plain task language/i);
    assert.match(readme, /maintainer shortcuts, not the normal user path/i);
    assert.match(readmeZh, /人类应该直接用自然语言说任务/);
    assert.match(readmeZh, /维护者快捷方式，不是普通用户入口/);
    assert.match(agents, /Do not require humans to know or type command words/);
    assert.match(skill, /ordinary natural-language durable work/);
    assert.match(skill, /not required human behavior/);

    assert.doesNotMatch(
      combined,
      /What needs explicit trigger|需要显式触发|Type "run meta theory"|输入"run meta theory"/,
    );
  });

  test("execution guidance requires reading target files before rewrite", async () => {
    const skill = await readFile("canonical/skills/meta-theory/SKILL.md");
    const runtimeClaude = await readFile("canonical/skills/meta-theory/references/runtime-claude.md");
    const devGovernance = await readFile("canonical/skills/meta-theory/references/dev-governance.md");

    assert.match(skill, /read every target file that may be changed/i);
    assert.match(skill, /current content of every target file has been read/i);
    assert.match(runtimeClaude, /Read the current content of every target file/i);
    assert.match(runtimeClaude, /before using Edit, MultiEdit, Write/i);
    assert.match(devGovernance, /Fetch reads the current content of every target file/i);
  });
});
