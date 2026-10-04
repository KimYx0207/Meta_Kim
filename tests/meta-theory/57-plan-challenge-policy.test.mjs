import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRouteBranchingOptions,
  buildPlanChallengeState,
  parsePlanChallengeControl,
  planChallengeAuthorizationBinding,
  runMetaTheoryGovernedExecution,
  selectHighestImpactOpenQuestion,
} from "../../scripts/run-meta-theory-governed-execution.mjs";
import { validateArtifactFile } from "../../scripts/validate-run-artifact.mjs";

const CORE_LOOP_CONTRACT = JSON.parse(
  readFileSync(new URL("../../config/contracts/core-loop-contract.json", import.meta.url), "utf8"),
);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function selectRoute(task, extraArgs = []) {
  const result = spawnSync(process.execPath, [
    "scripts/select-execution-route.mjs",
    "--task",
    task,
    "--runtime",
    "codex",
    "--os",
    "windows",
    "--json",
    ...extraArgs,
  ], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function build(task, overrides = {}) {
  return buildPlanChallengeState({
    task,
    responses: [],
    sharedUnderstandingConfirmed: false,
    executionAuthorization: null,
    contradictionEvidence: [],
    requestedSideEffectActions: [],
    ...overrides,
  });
}

function trustedResponse(question, status = "answered", userAnswer = null, sequence = 1) {
  return {
    questionId: question.questionId,
    status,
    userAnswer:
      userAnswer ??
      (status === "answered" ? "用户已确认当前问题的处理边界。" : null),
    trusted: true,
    binding: `plan-challenge-response:${question.questionId}`,
    selectionBinding: `plan-challenge-selection:${question.questionId}`,
    sequence,
    historical: false,
    evidenceRefs: [`native-choice:${question.questionId}`],
  };
}

function trustedUnderstanding() {
  return {
    trusted: true,
    binding: "plan-challenge-understanding-confirmation",
    evidenceRefs: ["native-choice:shared-understanding"],
  };
}

function trustedAuthorization(actions) {
  return {
    state: "authorized",
    source: "native_choice",
    scopeActions: [...actions],
    trusted: true,
    binding: planChallengeAuthorizationBinding(actions),
    evidenceRefs: ["native-choice:execution-authorization"],
  };
}

function answerEveryOpenQuestion(task, overrides = {}) {
  const responses = [];
  let result = build(task, { ...overrides, responses });
  while (result.planChallengeState.selectedQuestionId) {
    const question = result.planChallengeState.currentQuestion;
    for (const response of responses) response.historical = true;
    responses.push(trustedResponse(question, "answered", null, responses.length + 1));
    result = build(task, { ...overrides, responses });
  }
  return result;
}

describe("57 - risk-adaptive plan challenge", () => {
  test("explicit user wording activates the challenge without creating a new stage", () => {
    const result = build("先不要执行，帮我拷问这个发布方案，并找出会改变路线的问题。");

    assert.equal(result.planChallengeState.active, true);
    assert.ok(
      result.planChallengeState.triggerReasons.includes("explicit_user_request"),
      "an explicit challenge request must be recorded as the activation reason",
    );
    assert.equal(result.planChallengeState.phase, "awaiting_user_answer");
    assert.equal(
      result.unresolvedQuestions.filter((question) => question.status === "open").length > 0,
      true,
    );

    const stages = CORE_LOOP_CONTRACT.stages.map((stage) => stage.stage);
    assert.deepEqual(stages, [
      "Critical",
      "Fetch",
      "Thinking",
      "Execution",
      "Review",
      "Meta-Review",
      "Verification",
      "Evolution",
    ]);
  });

  test("material irreversible, high-cost, permission, and contradiction risks activate it", () => {
    for (const task of [
      "把生产数据库旧表永久删除并执行不可逆迁移。",
      "购买年度企业套餐并把全部客户迁移过去。",
      "修改全局权限配置并将结果发布到外部系统。",
    ]) {
      const result = build(task);
      assert.equal(result.planChallengeState.active, true, task);
      assert.ok(result.planChallengeState.triggerReasons.includes("material_risk"), task);
    }

    const contradiction = build("更新当前方案。", {
      contradictionEvidence: [
        {
          evidenceRef: "fetchPacket.contradictionLog[0]",
          trusted: true,
          binding: "plan-challenge-contradiction",
        },
      ],
    });
    assert.equal(contradiction.planChallengeState.active, true);
    assert.ok(
      contradiction.planChallengeState.triggerReasons.includes("evidence_contradiction"),
    );
    assert.ok(
      contradiction.planChallengeState.triggerEvidence.some(
        (item) => item.excerpt === "fetchPacket.contradictionLog[0]" && item.trusted === true,
      ),
    );
  });

  test("low-risk reversible work proceeds without challenge questions", () => {
    const result = build("修正文档里的一个错别字。");

    assert.equal(result.planChallengeState.active, false);
    assert.equal(result.planChallengeState.phase, "inactive");
    assert.equal(result.planChallengeState.selectedQuestionId, null);
    assert.deepEqual(result.planChallengeState.pendingUserChoice.controls, []);
    assert.deepEqual(result.unresolvedQuestions, []);
  });

  test("a refusal boundary does not become destructive-change intent", () => {
    for (const task of [
      "请迭代全局 skill governed-iterated-skill，并拒绝覆盖用户维护的项目能力。",
      "Update the project skill but never overwrite user-maintained files.",
    ]) {
      const result = build(task);
      assert.equal(result.planChallengeState.sideEffectActions.includes("destructive_change"), false, task);
      assert.equal(result.planChallengeState.authorizationRequired, false, task);
    }
  });

  test("procurement and payment nouns in analysis do not request a purchase commitment", () => {
    for (const task of [
      "帮我比较采购报价",
      "帮我比较这几家供应商",
      "分析购买成本与付款方式。",
      "解释支付流程和年度套餐价格。",
      "采购报价有什么差异？",
      "Compare procurement quotes and purchase prices.",
      "Analyze payment options for an annual plan.",
      "Explain the purchase process.",
      "Purchase quotes need comparison.",
    ]) {
      const result = build(task);
      assert.equal(result.planChallengeState.active, false, task);
      assert.equal(result.planChallengeState.authorizationRequired, false, task);
      assert.deepEqual(result.planChallengeState.sideEffectActions, [], task);
    }
  });

  test("purchase, payment and order requests survive preceding analysis or negated actions", () => {
    for (const task of [
      "请购买这批货物",
      "请为我购买这批货物",
      "帮我向B采购这批货物",
      "请购买报价管理软件",
      "请把评估过的货物购买下来",
      "订阅年度套餐",
      "请购买计划中的物料",
      "采购这批货物。",
      "请支付这张账单。",
      "比较采购报价，然后下单",
      "分析采购报价然后付款。",
      "比较采购报价并下单",
      "比较报价并向B下单",
      "比较采购报价后向B下单",
      "先比较采购报价再帮我向B下单",
      "不要采购A并采购B",
      "不执行采购再下单。",
      "仅分析采购报价后付款。",
      "仅分析采购报价，然后购买这批货物。",
      "不要购买旧款然后购买新款。",
      "不执行采购，但请支付这张账单。",
      "请比较采购报价并删除旧报价文件。",
      "Purchase the annual plan.",
      "Please pay the supplier.",
      "Can you purchase this item?",
      "Help me buy these supplies",
      "compare supplier quotes and then place the order",
      "Compare procurement quotes and please place the order",
      "Analysis only for the quotes, then buy these items.",
      "Do not purchase the old items but purchase the new items.",
      "Do not execute the purchase, then pay the supplier.",
      "Compare purchase prices and delete the cached quotes.",
    ]) {
      const result = build(task);
      const action = /删除|delete/iu.test(task) ? "destructive_change" : "purchase_commitment";
      assert.equal(result.planChallengeState.active, true, task);
      assert.equal(result.planChallengeState.authorizationRequired, true, task);
      assert.ok(result.planChallengeState.sideEffectActions.includes(action), task);
    }
  });

  test("negated purchase actions do not request execution authorization", () => {
    for (const task of [
      "请不要购买这批货物。",
      "不要下单，只比较采购报价。",
      "不执行采购。",
      "无需支付账单。",
      "不要购买也不要付款。",
      "Do not purchase these items.",
      "Please do not pay the supplier.",
      "Compare supplier quotes and do not place the order.",
      "Do not purchase this and do not pay that.",
      "不要采购A或支付B。",
      "Do not purchase these goods or pay the supplier.",
      "Never buy these supplies nor pay this invoice.",
      "Explain the words purchase and pay.",
    ]) {
      const result = build(task);
      assert.equal(result.planChallengeState.authorizationRequired, false, task);
      assert.equal(result.planChallengeState.sideEffectActions.includes("purchase_commitment"), false, task);
    }
  });

  test("coordinated purchase verbs retain the authorization boundary", () => {
    for (const task of [
      "Purchase and install the annual plan",
      "Buy and install this software for us",
      "Buy or rent this software for us",
      "Purchase or install the annual plan",
      "Procure and install the annual plan",
      "Order and install the annual plan",
      "Pay and install the annual plan",
      "Subscribe and install the annual plan",
    ]) {
      const { planChallengeState: state } = build(task);
      assert.ok(state.sideEffectActions.includes("purchase_commitment"), task);
      assert.equal(state.active, true, task);
      assert.equal(state.authorizationRequired, true, task);
      assert.equal(state.executionAllowed, false, task);
    }
  });

  test("coordinated purchase nouns and complete term explanations remain nonexecuting", () => {
    for (const task of [
      "Purchase and payment terms need explanation.",
      "Purchase or subscription options need comparison.",
      "Order and payment records need review.",
      "Purchase and order terms need explanation.",
      "Explain the words purchase and pay in this sentence.",
      "Define the terms purchase or pay in this context.",
      "Describe the terms order and pay in this text.",
      "Explain the meanings of purchase and pay in this sentence.",
      "Explain what purchase and pay mean",
      "What do purchase and pay mean?",
    ]) {
      const { planChallengeState: state } = build(task);
      assert.equal(state.authorizationRequired, false, task);
      assert.deepEqual(state.sideEffectActions, [], task);
    }
  });

  test("determined purchase nouns and coordinated sales data remain nonexecuting", () => {
    for (const task of [
      "Purchase and sales data need analysis.",
      "The purchase and payment terms need explanation.",
      "Our order and payment records need review.",
      "These purchase and sales data need analysis.",
      "Those order and payment records need review.",
      "My purchase and payment terms need explanation.",
      "Your purchase or subscription options need comparison.",
      "Their purchase and order terms need explanation.",
    ]) {
      const { planChallengeState: state } = build(task);
      assert.equal(state.authorizationRequired, false, task);
      assert.deepEqual(state.sideEffectActions, [], task);
    }
  });

  test("data purchases do not become nominal prefixes", () => {
    for (const task of [
      "Purchase data",
      "Purchase sales data",
      "Buy sales data",
      "Buy purchase and sales data",
      "Please purchase sales data.",
      "Purchase and install annual plan",
    ]) {
      const { planChallengeState: state } = build(task);
      assert.ok(state.sideEffectActions.includes("purchase_commitment"), task);
      assert.equal(state.authorizationRequired, true, task);
      assert.equal(state.executionAllowed, false, task);
    }
  });

  test("determined noun prefixes preserve later commitments and explicit scope", () => {
    for (const task of [
      "Purchase and sales data need analysis and buy the annual plan",
      "The purchase and payment terms need explanation and purchase the annual plan",
      "Our order and payment records need review and pay the supplier",
      "These purchase and sales data need analysis, then purchase the annual plan",
      "Their purchase and payment terms need explanation; pay the supplier",
    ]) {
      const { planChallengeState: state } = build(task);
      assert.ok(state.sideEffectActions.includes("purchase_commitment"), task);
      assert.equal(state.authorizationRequired, true, task);
      assert.equal(state.executionAllowed, false, task);
    }
    const { planChallengeState: explicit } = build(
      "Our order and payment records need review.",
      { requestedSideEffectActions: ["purchase_commitment"] },
    );
    assert.deepEqual(explicit.sideEffectActions, ["purchase_commitment"]);
    assert.equal(explicit.authorizationRequired, true);
    assert.equal(explicit.executionAllowed, false);
  });

  test("purchase explanations cannot consume subsequent commitments or override explicit scope", () => {
    for (const task of [
      "Explain the words purchase and pay in this sentence, then purchase the annual plan",
      "Explain the words purchase and pay in this sentence and then purchase the annual plan",
      "Explain the words purchase and pay in this sentence and please pay the supplier",
      "Explain what purchase and pay mean and then buy the annual plan",
      "What do purchase and pay mean? Then pay the supplier",
      "Purchase and payment terms need explanation and purchase the annual plan",
      "Compare procurement quotes and please place the order",
    ]) {
      const { planChallengeState: state } = build(task);
      assert.ok(state.sideEffectActions.includes("purchase_commitment"), task);
      assert.equal(state.authorizationRequired, true, task);
      assert.equal(state.executionAllowed, false, task);
    }
    const { planChallengeState: explicit } = build(
      "Explain the words purchase and pay in this sentence.",
      { requestedSideEffectActions: ["purchase_commitment"] },
    );
    assert.equal(explicit.authorizationRequired, true);
    for (const task of [
      "Do not purchase and install the annual plan",
      "Never buy or rent this software for us",
      "Never purchase nor install the annual plan",
    ]) {
      const { planChallengeState: state } = build(task);
      assert.equal(state.authorizationRequired, false, task);
      assert.equal(state.sideEffectActions.includes("purchase_commitment"), false, task);
    }
  });

  test("purchase scope boundaries preserve unrelated coordinated prohibitions", () => {
    for (const task of [
      "do not deploy and publish the app",
      "don't release this and don't deploy this",
      "不要发布也不要部署。",
    ]) {
      const result = build(task);
      assert.equal(result.planChallengeState.authorizationRequired, false, task);
      assert.deepEqual(result.planChallengeState.sideEffectActions, [], task);
    }
  });

  test("low-risk documentation wording does not become a material-risk challenge", () => {
    for (const task of [
      "更新发布说明中的一个错别字。",
      "修复权限文档里的标点。",
      "把迁移指南标题改短一点。",
      "写一篇介绍生产环境概念的文档。",
    ]) {
      const result = build(task);
      assert.equal(result.planChallengeState.active, false, task);
      assert.equal(result.planChallengeState.authorizationRequired, false, task);
      assert.deepEqual(result.unresolvedQuestions, [], task);
    }
  });

  test("natural Chinese follow-up release and deploy intent requires authorization", () => {
    const cases = [
      ["请先压力测试这个生产发布方案，确认后发布到生产环境。", "external_release"],
      ["请压力测试后部署到生产环境。", "production_deploy"],
      ["方案确认后再上线到正式环境。", "external_release"],
      ["先评估是否应该发布，如果没问题就直接发布到生产环境。", "external_release"],
      ["解释完当前方案后，直接发布到生产环境。", "external_release"],
      ["解释“发布到生产”的含义，然后将版本发布到生产环境。", "external_release"],
      ["不要发布，但要部署到生产环境。", "production_deploy"],
      ["不要发布但要部署到生产环境。", "production_deploy"],
      ["Do not release but deploy this to production.", "production_deploy"],
      ["不要发布旧版本，但要发布新版本。", "external_release"],
      ["不要部署旧服务，而是部署新服务到生产环境。", "production_deploy"],
    ];
    for (const [task, action] of cases) {
      const result = build(task);
      assert.equal(result.planChallengeState.active, true, task);
      assert.equal(result.planChallengeState.authorizationRequired, true, task);
      assert.ok(result.planChallengeState.sideEffectActions.includes(action), task);
    }
    for (const task of [
      "更新发布说明中的一个错别字。",
      "只检查生产发布方案，不执行发布。",
      "设计一个自动发布器的文档结构。",
      "解释一下“确认后发布到生产环境”这句话是什么意思。",
      "“测试后部署到生产环境”是什么意思？",
      "我们是否应该确认后发布到生产环境？",
      "don't release this and don't deploy this",
      "不要发布也不要部署。",
    ]) {
      const result = build(task);
      assert.equal(result.planChallengeState.authorizationRequired, false, task);
      assert.equal(result.planChallengeState.sideEffectActions.includes("external_release"), false, task);
      assert.equal(result.planChallengeState.sideEffectActions.includes("production_deploy"), false, task);
    }
  });

  test("negated challenge wording and unrelated stop-summary prose do not activate it", () => {
    for (const task of [
      "不需要方案拷问，只修正文档错字。",
      "不要压力测试，只执行既定的低风险文案修改。",
      "帮我汇总并停止记录这段低风险说明。",
    ]) {
      const result = build(task);
      assert.equal(result.planChallengeState.active, false, task);
      assert.equal(result.planChallengeState.phase, "inactive", task);
      assert.equal(result.planChallengeState.stopRequested, false, task);
    }
  });

  test("explicit negative read-only wording stays active without a side-effect gate", () => {
    for (const task of [
      "只读压力测试这个发布方案，不执行、不修改、不部署。",
      "帮我挑刺：无需修改权限，只检查权限文档。",
      "stress test the plan, but do not deploy or modify anything",
    ]) {
      const result = build(task);
      assert.equal(result.planChallengeState.authorizationRequired, false, task);
      assert.equal(result.planChallengeState.executionAllowed, false, task);
      const selected = result.unresolvedQuestions.find(
        (question) => question.questionId === result.planChallengeState.selectedQuestionId,
      );
      assert.notEqual(
        selected?.questionTarget,
        "wrong_permission_or_safety_risk",
        task,
      );
    }

    const negativeLowRisk = build("不要发布，只检查发布说明有没有错字。");
    assert.equal(negativeLowRisk.planChallengeState.active, false);
    assert.equal(negativeLowRisk.planChallengeState.authorizationRequired, false);
    assert.deepEqual(negativeLowRisk.unresolvedQuestions, []);
  });

  test("an active challenge exposes one pending user choice and cannot silently complete", () => {
    const result = build("帮我挑刺这个本地方案。", { outputLanguage: "zh-CN" });
    const pending = result.planChallengeState.pendingUserChoice;

    assert.equal(result.planChallengeState.phase, "awaiting_user_answer");
    assert.equal(result.planChallengeState.executionAllowed, false);
    assert.equal(pending.status, "required_not_invoked");
    assert.equal(typeof pending.question.binding, "string");
    assert.ok(pending.question.binding.length > 0);
    assert.equal(typeof pending.question.displayText, "string");
    assert.ok(pending.question.displayText.length > 0);
    assert.deepEqual(pending.controls.map((control) => control.action), [
      "accept_recommendation",
      "skip",
      "summarize_stop",
      "continue",
    ]);
  });

  test("natural-language controls map to stable challenge actions", () => {
    for (const [expected, samples] of Object.entries({
      accept_recommendation: ["按推荐走", "use the recommendation", "推奨案で進めて", "추천대로 진행"],
      skip: ["跳过", "skip this", "スキップ", "건너뛰기"],
      summarize_stop: ["够了，汇总", "stop and summarize", "要約して停止", "요약하고 중지"],
      continue: ["继续问", "continue questioning", "質問を続ける", "계속 질문"],
    })) {
      for (const sample of samples) {
        assert.equal(parsePlanChallengeControl(sample), expected, sample);
      }
    }
  });

  test("accept, skip, continue, and summarize controls preserve question history", () => {
    const task = "请压力测试这个方案；如果通过，将版本发布到生产环境并迁移数据库。";
    const initial = build(task);
    const first = initial.planChallengeState.currentQuestion;
    assert.ok(first?.recommendedAnswer);

    const accepted = build(task, {
      control: parsePlanChallengeControl("按推荐走"),
    });
    assert.equal(
      accepted.unresolvedQuestions.find((question) => question.questionId === first.questionId)?.status,
      "answered",
    );
    assert.equal(
      accepted.unresolvedQuestions.find((question) => question.questionId === first.questionId)?.userAnswer,
      first.recommendedAnswer,
    );
    assert.notEqual(accepted.planChallengeState.selectedQuestionId, first.questionId);

    const skipped = build(task, { control: parsePlanChallengeControl("跳过") });
    assert.equal(skipped.unresolvedQuestions[0].status, "skipped");
    assert.equal(skipped.unresolvedQuestions[1].status, "invalidated");

    const continued = build(task, { control: parsePlanChallengeControl("继续问") });
    assert.equal(continued.planChallengeState.selectedQuestionId, first.questionId);
    assert.equal(continued.unresolvedQuestions[0].status, "open");

    const summarized = build(task, { control: parsePlanChallengeControl("够了，汇总") });
    assert.equal(summarized.planChallengeState.stopRequested, true);
    assert.equal(summarized.planChallengeState.selectedQuestionId, null);
    assert.equal(
      summarized.unresolvedQuestions.some((question) => question.status === "open"),
      false,
    );
    assert.equal(summarized.planChallengeState.pendingUserChoice.status, "not_required");
  });

  test("only the highest-impact eligible open question is selected", () => {
    const questions = [
      {
        questionId: "scope",
        impactPriority: 40,
        dependsOn: [],
        status: "open",
      },
      {
        questionId: "permission",
        impactPriority: 100,
        dependsOn: [],
        status: "open",
      },
      {
        questionId: "follow-up",
        impactPriority: 120,
        dependsOn: ["permission"],
        status: "open",
      },
      {
        questionId: "answered",
        impactPriority: 200,
        dependsOn: [],
        status: "answered",
      },
    ];

    const selected = selectHighestImpactOpenQuestion(questions);
    assert.equal(selected?.questionId, "permission");
    assert.equal(
      questions.filter((question) => question.questionId === selected?.questionId).length,
      1,
    );
  });

  test("a skipped dependency invalidates its dependent question", () => {
    const task = "请压力测试这个方案；如果通过，将版本发布到生产环境并迁移数据库。";
    const result = build(task, {
      responses: [
        trustedResponse(
          { questionId: "plan-challenge-permission-boundary" },
          "skipped",
        ),
      ],
    });

    const permission = result.unresolvedQuestions.find(
      (question) => question.questionId === "plan-challenge-permission-boundary",
    );
    const delivery = result.unresolvedQuestions.find(
      (question) => question.questionId === "plan-challenge-delivery-boundary",
    );
    assert.equal(permission?.status, "skipped");
    assert.equal(delivery?.status, "invalidated");
    assert.equal(delivery?.invalidatedBy, permission?.questionId);
    assert.equal(result.planChallengeState.selectedQuestionId, null);
  });

  test("an answered question stays in history and is not asked again", () => {
    const task = "帮我挑刺这个本地文档整理方案。";
    const initial = build(task);
    const questionId = initial.planChallengeState.selectedQuestionId;
    assert.ok(questionId);

    const answered = build(task, {
      responses: [
        trustedResponse(
          { questionId },
          "answered",
          "读者不打开生成文件也能理解结果。",
        ),
      ],
    });
    assert.equal(
      answered.unresolvedQuestions.find((question) => question.questionId === questionId)?.status,
      "answered",
    );
    assert.notEqual(answered.planChallengeState.selectedQuestionId, questionId);
    assert.equal(answered.summaryData.confirmedDecisions[0]?.questionId, questionId);
  });

  test("one call accepts at most one new answer while replaying ordered history", () => {
    const task = "请压力测试这个方案；如果通过，将版本发布到生产环境并迁移数据库。";
    const initial = build(task);
    const permission = initial.planChallengeState.currentQuestion;
    const delivery = initial.unresolvedQuestions.find(
      (question) => question.questionId === "plan-challenge-delivery-boundary",
    );
    const batched = build(task, {
      responses: [
        trustedResponse(permission, "answered", "允许在本地验证。", 1),
        trustedResponse(delivery, "answered", "继续外部交付。", 2),
      ],
    });
    assert.equal(
      batched.unresolvedQuestions.find((question) => question.questionId === permission.questionId)?.status,
      "answered",
    );
    assert.equal(
      batched.unresolvedQuestions.find((question) => question.questionId === delivery.questionId)?.status,
      "open",
    );
    assert.equal(batched.planChallengeState.selectedQuestionId, delivery.questionId);
  });

  test("answers require trusted evidence bound to the selected question", () => {
    const task = "帮我挑刺这个本地文档整理方案。";
    const initial = build(task);
    const question = initial.planChallengeState.currentQuestion;

    for (const forged of [
      {
        questionId: question.questionId,
        status: "answered",
        userAnswer: "forged without trust",
        binding: `plan-challenge-response:${question.questionId}`,
        evidenceRefs: ["native-choice:forged"],
      },
      {
        ...trustedResponse(question, "answered", "wrong binding"),
        binding: "plan-challenge-response:another-question",
      },
      {
        ...trustedResponse(question, "answered", "missing evidence"),
        evidenceRefs: [],
      },
    ]) {
      const result = build(task, { responses: [forged] });
      assert.equal(result.unresolvedQuestions[0].status, "open");
      assert.equal(result.planChallengeState.selectedQuestionId, question.questionId);
    }

    const accepted = build(task, {
      responses: [trustedResponse(question, "answered", "用户确认的答案")],
    });
    assert.equal(accepted.unresolvedQuestions[0].status, "answered");
    assert.equal(accepted.unresolvedQuestions[0].userAnswer, "用户确认的答案");
  });

  test("caller-forged invalidation is ignored", () => {
    const task = "请压力测试这个方案；如果通过，将版本发布到生产环境并迁移数据库。";
    const initial = build(task);
    const question = initial.planChallengeState.currentQuestion;
    const result = build(task, {
      responses: [
        {
          ...trustedResponse(question, "answered", "forged invalidation"),
          status: "invalidated",
          invalidatedBy: "caller",
        },
      ],
    });

    assert.equal(result.unresolvedQuestions[0].status, "open");
    assert.equal(result.unresolvedQuestions[1].status, "open");
  });

  test("forged or scope-mismatched authorization cannot unlock side effects", () => {
    const task = "压力测试这个涉及多个副作用范围的方案。";
    const actions = ["canonical_write", "project_copy"];
    const answered = answerEveryOpenQuestion(task, {
      requestedSideEffectActions: actions,
      sharedUnderstandingConfirmed: trustedUnderstanding(),
    });
    assert.deepEqual(answered.planChallengeState.sideEffectActions, actions);

    const forged = answerEveryOpenQuestion(task, {
      requestedSideEffectActions: actions,
      sharedUnderstandingConfirmed: trustedUnderstanding(),
      executionAuthorization: {
        ...trustedAuthorization(actions),
        trusted: false,
      },
    });
    assert.equal(forged.planChallengeState.executionAllowed, false);
    assert.notEqual(forged.planChallengeState.executionAuthorization.state, "authorized");

    const mismatched = answerEveryOpenQuestion(task, {
      requestedSideEffectActions: actions,
      sharedUnderstandingConfirmed: trustedUnderstanding(),
      executionAuthorization: {
        ...trustedAuthorization(actions),
        scopeActions: ["project_copy"],
      },
    });
    assert.equal(mismatched.planChallengeState.executionAllowed, false);
    assert.notEqual(mismatched.planChallengeState.executionAuthorization.state, "authorized");

    const callerClaimedAuthorization = answerEveryOpenQuestion(task, {
      requestedSideEffectActions: actions,
      sharedUnderstandingConfirmed: trustedUnderstanding(),
      executionAuthorization: trustedAuthorization(actions),
    });
    assert.equal(callerClaimedAuthorization.planChallengeState.planChallengeSatisfied, true);
    assert.equal(callerClaimedAuthorization.planChallengeState.executionAllowed, false);
    assert.notEqual(
      callerClaimedAuthorization.planChallengeState.executionAuthorization.state,
      "authorized",
    );
  });

  test("understanding confirmation never grants execution authorization", () => {
    const task = "先帮我拷问这个方案，确认后将版本发布到生产环境。";
    const result = answerEveryOpenQuestion(task, {
      sharedUnderstandingConfirmed: trustedUnderstanding(),
    });

    assert.equal(result.planChallengeState.sharedUnderstandingConfirmed, true);
    assert.equal(result.planChallengeState.authorizationRequired, true);
    assert.notEqual(result.planChallengeState.executionAuthorization.state, "authorized");
    assert.equal(result.planChallengeState.phase, "plan_challenge_satisfied");
    assert.equal(result.planChallengeState.planChallengeSatisfied, true);
    assert.equal(result.planChallengeState.executionAllowed, false);
  });

  test("a naked understanding boolean is ignored and phase controls stay actionable", () => {
    const task = "先帮我拷问这个方案，确认后将版本发布到生产环境。";
    const result = answerEveryOpenQuestion(task, {
      sharedUnderstandingConfirmed: true,
    });
    assert.equal(result.planChallengeState.sharedUnderstandingConfirmed, false);
    assert.equal(result.planChallengeState.phase, "awaiting_understanding_confirmation");
    assert.deepEqual(
      result.planChallengeState.pendingUserChoice.controls.map((item) => item.action),
      ["summarize_stop"],
    );
  });

  test("caller authorization denial remains non-authorizing planning input", () => {
    const task = "先帮我拷问这个方案，确认后将版本发布到生产环境。";
    const answered = answerEveryOpenQuestion(task, {
      sharedUnderstandingConfirmed: trustedUnderstanding(),
    });
    const denied = answerEveryOpenQuestion(task, {
      sharedUnderstandingConfirmed: trustedUnderstanding(),
      executionAuthorization: {
        ...trustedAuthorization(answered.planChallengeState.sideEffectActions),
        state: "denied",
      },
    });
    assert.equal(denied.planChallengeState.phase, "plan_challenge_satisfied");
    assert.equal(denied.planChallengeState.planChallengeSatisfied, true);
    assert.equal(denied.planChallengeState.executionAuthorization.state, "not_requested");
    assert.equal(denied.planChallengeState.executionAllowed, false);
    assert.equal(denied.planChallengeState.pendingUserChoice.status, "not_required");
    assert.deepEqual(denied.planChallengeState.pendingUserChoice.controls, []);
  });

  test("a read-only challenge does not demand execution authorization", () => {
    const task = "只读方式帮我压力测试本地文档结构，不修改文件。";
    const result = answerEveryOpenQuestion(task, {
      sharedUnderstandingConfirmed: trustedUnderstanding(),
    });

    assert.equal(result.planChallengeState.active, true);
    assert.equal(result.planChallengeState.authorizationRequired, false);
    assert.equal(result.planChallengeState.executionAuthorization.state, "not_required");
    assert.equal(result.planChallengeState.phase, "plan_challenge_satisfied");
    assert.equal(result.planChallengeState.planChallengeSatisfied, true);
    assert.equal(result.planChallengeState.executionAllowed, false);
  });

  test("read-only wording suppresses inference but preserves explicit side-effect actions", () => {
    for (const task of [
      "只读压力测试这个命令方案，不修改也不创建文件。",
      "只读比较采购报价。",
      "Read-only comparison of supplier quotes; do not purchase anything.",
    ]) {
      for (const action of ["project_capability_copy", "purchase_commitment"]) {
        const result = build(task, { requestedSideEffectActions: [action] });
        assert.deepEqual(result.planChallengeState.sideEffectActions, [action], task);
        assert.equal(result.planChallengeState.active, true, task);
        assert.equal(result.planChallengeState.authorizationRequired, true, task);
      }
      assert.deepEqual(build(task).planChallengeState.sideEffectActions, [], task);
    }
  });

  test("pure preference and evidence-insufficient questions do not invent recommendations", () => {
    const preference = build("帮我拷问这个纯视觉风格偏好：暖色还是冷色？");
    const insufficient = build("帮我拷问一个证据不足的市场定位决定。");

    const preferenceQuestion = preference.unresolvedQuestions.find(
      (question) => question.recommendationState === "preference_only",
    );
    assert.ok(preferenceQuestion, "preference-only work must be represented explicitly");
    assert.equal(preferenceQuestion.recommendedAnswer, null);

    const insufficientQuestion = insufficient.unresolvedQuestions.find(
      (question) => question.recommendationState === "insufficient_evidence",
    );
    assert.ok(insufficientQuestion, "missing evidence must be represented explicitly");
    assert.equal(insufficientQuestion.recommendedAnswer, null);
  });

  test("Japanese and Korean challenge surfaces are localized and hide internal ids", () => {
    for (const [outputLanguage, task, localizedPattern] of [
      ["ja-JP", "この公開計画をストレステストしてください", /[ぁ-んァ-ヶ一-龠]/u],
      ["ko-KR", "이 배포 계획을 스트레스 테스트해 주세요", /[가-힣]/u],
    ]) {
      const result = build(task, { outputLanguage });
      assert.equal(result.planChallengeState.active, true, outputLanguage);
      const pendingText = result.planChallengeState.pendingUserChoice.question.displayText;
      assert.match(pendingText, localizedPattern, outputLanguage);
      if (result.planChallengeState.pendingUserChoice.question.recommendation) {
        assert.match(
          result.planChallengeState.pendingUserChoice.question.recommendation,
          localizedPattern,
          outputLanguage,
        );
      }
      assert.doesNotMatch(pendingText, /plan-challenge-|questionId|binding/iu);
      assert.ok(result.summaryData.visibleLines.length > 0);
      assert.match(result.summaryData.visibleLines.join("\n"), localizedPattern, outputLanguage);
      assert.doesNotMatch(
        result.summaryData.visibleLines.join("\n"),
        /plan-challenge-|questionId|binding/iu,
      );
    }
  });

  test("an incomplete challenge blocks canonical writeback and project capability copies", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-plan-challenge-write-gate-"));
    const projectRoot = path.join(tempDir, "project");
    const canonicalRoot = path.join(tempDir, "canonical");
    await mkdir(path.join(projectRoot, ".git"), { recursive: true });
    await mkdir(canonicalRoot, { recursive: true });
    await writeFile(path.join(projectRoot, "package.json"), '{"name":"challenge-fixture"}\n');
    const task = [
      "请先压力测试这个方案。",
      "同一套 PRD review standard 需要 skill。",
      "请在当前项目新建 command governed-challenge-report，用于输出检查报告。",
    ].join("\n");

    try {
      const candidateOnly = await runMetaTheoryGovernedExecution({
        task,
        runId: "plan-challenge-write-gate-candidate",
        stateDir: path.join(tempDir, "candidate-state"),
        dbPath: path.join(tempDir, "candidate.sqlite"),
        projectRoot,
        canonicalRoot,
        projectCapabilityMutationMode: "auto",
      });
      assert.ok(
        candidateOnly.wardenWritebackFlow.candidates.length > 0,
        "the fixture must produce a real canonical candidate before testing the gate",
      );
      assert.equal(candidateOnly.projectCustomizationPacket.execution.appliedCount, 0);
      assert.equal(
        existsSync(path.join(projectRoot, ".codex", "commands", "governed-challenge-report.md")),
        false,
      );

      const targetRelative =
        candidateOnly.wardenWritebackFlow.candidates[0].targetRelativeToCanonical;
      const approvalPacket = {
        schemaVersion: "warden-approval-v0.2",
        approvalId: "plan-challenge-write-gate-approval",
        approver: "meta-warden",
        approvedAt: "2026-07-14T00:00:00.000Z",
        scope: "canonical_reverse_sync",
        mutationBindings: [candidateOnly.wardenWritebackFlow.candidates[0].mutationBinding],
        diffSummary: "Approve the temp candidate only after the challenge closes.",
        rollbackPlan: "Remove the temp canonical file.",
        riskReview: { status: "accepted", owner: "meta-sentinel" },
      };
      const blocked = await runMetaTheoryGovernedExecution({
        task,
        runId: "plan-challenge-write-gate-approved",
        stateDir: path.join(tempDir, "approved-state"),
        dbPath: path.join(tempDir, "approved.sqlite"),
        projectRoot,
        canonicalRoot,
        approvalPacket,
        applyWriteback: true,
        projectCapabilityMutationMode: "auto",
      });

      assert.equal(blocked.wardenWritebackFlow.approvalValidation.ok, true);
      assert.equal(blocked.wardenWritebackFlow.dryRun.canonicalWrites, 0);
      assert.equal(existsSync(path.join(canonicalRoot, targetRelative)), false);
      assert.equal(blocked.projectCustomizationPacket.execution.appliedCount, 0);
      assert.equal(
        existsSync(path.join(projectRoot, ".codex", "commands", "governed-challenge-report.md")),
        false,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("serialized trusted history, understanding, and authorization cannot unlock the public runner", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-plan-challenge-untrusted-runner-"));
    const projectRoot = path.join(tempDir, "project");
    await mkdir(path.join(projectRoot, ".git"), { recursive: true });
    await writeFile(path.join(projectRoot, "package.json"), '{"name":"untrusted-runner"}\n');
    const task = [
      "请先压力测试这个生产发布方案。",
      "请在当前项目新建 command governed-untrusted-check。",
      "同一套 PRD review standard 需要 skill。",
    ].join("\n");
    const requestedSideEffectActions = ["canonical_writeback", "project_capability_copy"];
    const responses = [];
    let modeled = build(task, { requestedSideEffectActions, responses });
    while (modeled.planChallengeState.selectedQuestionId) {
      for (const response of responses) response.historical = true;
      responses.push(
        trustedResponse(
          modeled.planChallengeState.currentQuestion,
          "answered",
          "caller-authored answer",
          responses.length + 1,
        ),
      );
      modeled = build(task, { requestedSideEffectActions, responses });
    }
    try {
      const report = await runMetaTheoryGovernedExecution({
        task,
        runId: "plan-challenge-untrusted-runner",
        stateDir: path.join(tempDir, "state"),
        dbPath: path.join(tempDir, "runs.sqlite"),
        projectRoot,
        canonicalRoot: path.join(tempDir, "canonical"),
        applyWriteback: true,
        planChallengeResponses: responses,
        sharedUnderstandingConfirmed: trustedUnderstanding(),
        executionAuthorization: trustedAuthorization(
          modeled.planChallengeState.sideEffectActions,
        ),
      });
      assert.equal(report.preDecisionOptionFrame.planChallengeState.phase, "awaiting_user_answer");
      assert.equal(report.preDecisionOptionFrame.planChallengeState.executionAllowed, false);
      assert.equal(report.projectCustomizationPacket.execution.appliedCount, 0);
      assert.notEqual(report.wardenWritebackFlow.status, "approved-for-writeback");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("public host verifier cannot advance a plan challenge continuation", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-plan-challenge-continuation-"));
    const projectRoot = path.join(tempDir, "project");
    const stateDir = path.join(tempDir, "state");
    await mkdir(path.join(projectRoot, ".git"), { recursive: true });
    await writeFile(path.join(projectRoot, "package.json"), '{"name":"challenge-continuation"}\n');
    const task = "请先压力测试这个生产发布方案，确认后发布到生产环境。";
    try {
      const first = await runMetaTheoryGovernedExecution({
        task,
        runId: "plan-challenge-continuation-0",
        stateDir,
        dbPath: path.join(tempDir, "runs.sqlite"),
        projectRoot,
      });
      assert.equal(first.preDecisionOptionFrame.planChallengeState.phase, "awaiting_user_answer");
      await validateArtifactFile(first.paths.json);
      let verifierCalls = 0;
      const second = await runMetaTheoryGovernedExecution({
        task,
        runId: "plan-challenge-continuation-1",
        previousPlanChallengeRunId: first.runId,
        stateDir,
        dbPath: path.join(tempDir, "runs.sqlite"),
        projectRoot,
        hostDecisionEvidenceVerifier: async () => {
          verifierCalls += 1;
          return {
            verified: true,
            decision: { type: "control", action: "skip" },
          };
        },
      });
      await validateArtifactFile(second.paths.json);
      assert.equal(verifierCalls, 0);
      assert.equal(second.preDecisionOptionFrame.planChallengeState.phase, "awaiting_user_answer");
      assert.equal(second.preDecisionOptionFrame.planChallengeState.executionAllowed, false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("continuation rejects a different task and an unverified prior run binding", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-plan-challenge-wrong-chain-"));
    const projectRoot = path.join(tempDir, "project");
    const stateDir = path.join(tempDir, "state");
    await mkdir(path.join(projectRoot, ".git"), { recursive: true });
    await writeFile(path.join(projectRoot, "package.json"), '{"name":"wrong-chain"}\n');
    const task = "请先压力测试这个生产发布方案。";
    try {
      const first = await runMetaTheoryGovernedExecution({
        task,
        runId: "plan-challenge-wrong-chain-0",
        stateDir,
        dbPath: path.join(tempDir, "runs.sqlite"),
        projectRoot,
      });
      await assert.rejects(
        runMetaTheoryGovernedExecution({
          task: "请先压力测试另一个生产发布方案。",
          runId: "plan-challenge-wrong-chain-task",
          previousPlanChallengeRunId: first.runId,
          stateDir,
          dbPath: path.join(tempDir, "runs.sqlite"),
          projectRoot,
          hostDecisionEvidenceVerifier: async () => ({
            verified: true,
            adapterId: "test-host-adapter",
            currentRunOnly: true,
            continuationRunId: first.runId,
            evidenceRefs: ["host-event:wrong-task"],
          }),
        }),
        /different task/iu,
      );
      const ignoredBinding = await runMetaTheoryGovernedExecution({
          task,
          runId: "plan-challenge-wrong-chain-binding",
          previousPlanChallengeRunId: first.runId,
          stateDir,
          dbPath: path.join(tempDir, "runs.sqlite"),
          projectRoot,
          hostDecisionEvidenceVerifier: async () => ({
            verified: true,
            adapterId: "test-host-adapter",
            currentRunOnly: true,
            continuationRunId: "some-other-run",
            evidenceRefs: ["host-event:wrong-binding"],
          }),
        });
      assert.equal(
        ignoredBinding.preDecisionOptionFrame.planChallengeState.phase,
        "awaiting_user_answer",
      );
      assert.equal(ignoredBinding.preDecisionOptionFrame.planChallengeState.executionAllowed, false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("public host controls remain inert across continuations", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-plan-challenge-control-chain-"));
    const projectRoot = path.join(tempDir, "project");
    const stateDir = path.join(tempDir, "state");
    await mkdir(path.join(projectRoot, ".git"), { recursive: true });
    await writeFile(path.join(projectRoot, "package.json"), '{"name":"control-chain"}\n');
    const task = "请先压力测试这个生产发布方案。";
    try {
      const first = await runMetaTheoryGovernedExecution({
        task,
        runId: "plan-challenge-control-chain-0",
        stateDir,
        dbPath: path.join(tempDir, "runs.sqlite"),
        projectRoot,
      });
      const second = await runMetaTheoryGovernedExecution({
        task,
        runId: "plan-challenge-control-chain-1",
        previousPlanChallengeRunId: first.runId,
        stateDir,
        dbPath: path.join(tempDir, "runs.sqlite"),
        projectRoot,
        hostDecisionEvidenceVerifier: async () => ({
          verified: true,
          adapterId: "test-host-adapter",
          currentRunOnly: true,
          continuationRunId: first.runId,
          evidenceRefs: ["host-event:skip-question"],
          decision: { type: "control", action: "skip" },
        }),
      });
      await validateArtifactFile(second.paths.json);
      assert.equal(second.preDecisionOptionFrame.planChallengeState.phase, "awaiting_user_answer");
      assert.equal(
        second.preDecisionOptionFrame.unresolvedQuestions.some((question) => question.status === "skipped"),
        false,
      );

      const third = await runMetaTheoryGovernedExecution({
        task,
        runId: "plan-challenge-control-chain-2",
        previousPlanChallengeRunId: second.runId,
        stateDir,
        dbPath: path.join(tempDir, "runs.sqlite"),
        projectRoot,
        hostDecisionEvidenceVerifier: async () => ({
          verified: true,
          adapterId: "test-host-adapter",
          currentRunOnly: true,
          continuationRunId: second.runId,
          evidenceRefs: ["host-event:continue-chain"],
        }),
      });
      await validateArtifactFile(third.paths.json);
      assert.equal(third.preDecisionOptionFrame.planChallengeState.phase, "awaiting_user_answer");
      assert.equal(third.preDecisionOptionFrame.planChallengeState.executionAllowed, false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("completion summary remains usable in chat", () => {
    const task = "帮我拷问这个发布方案。";
    const answered = answerEveryOpenQuestion(task, {
      sharedUnderstandingConfirmed: trustedUnderstanding(),
    });
    const result = answerEveryOpenQuestion(task, {
      sharedUnderstandingConfirmed: trustedUnderstanding(),
      executionAuthorization: trustedAuthorization(
        answered.planChallengeState.sideEffectActions,
      ),
    });

    assert.equal(result.planChallengeState.phase, "plan_challenge_satisfied");
    assert.equal(result.planChallengeState.planChallengeSatisfied, true);
    assert.equal(result.planChallengeState.executionAllowed, false);
    assert.ok(Array.isArray(result.summaryData.confirmedDecisions));
    assert.ok(Array.isArray(result.summaryData.openRisks));
    assert.equal(typeof result.summaryData.nextStep, "string");
    assert.ok(result.summaryData.nextStep.trim().length > 0);
    assert.ok(result.summaryData.visibleLines.length > 0);
    assert.doesNotMatch(
      result.summaryData.visibleLines.join("\n"),
      /plan-challenge-|questionId|binding/iu,
    );
    assert.equal(result.planChallengeState.chatSummaryRef, "summaryPacket");
  });

  test("pending artifacts validate honestly while forged execution state fails closed", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-plan-challenge-validator-"));
    try {
      const report = await runMetaTheoryGovernedExecution({
        task: "帮我压力测试这个方案，然后将版本发布到生产环境。",
        runId: "plan-challenge-validator-pending",
        stateDir: tempDir,
        artifactDir: tempDir,
        dbPath: path.join(tempDir, "runs.sqlite"),
        projectCapabilityMutationMode: "read_only",
      });
      const valid = await validateArtifactFile(report.paths.json);
      assert.equal(valid.runId, report.runId);
      assert.equal(report.preDecisionOptionFrame.solutionChoiceState, "pending_user_choice");
      assert.equal(report.coreLoop.executionResult.executionGate, "blocked_by_plan_challenge");

      // Isolated hosts may discover no viable owner while understanding or
      // permission is still pending. Keep that gap honest instead of padding
      // the frame with an unevidenced route.
      const emptyCandidates = JSON.parse(readFileSync(report.paths.json, "utf8"));
      assert.equal(emptyCandidates.preDecisionOptionFrame.planChallengeState.active, true);
      assert.equal(emptyCandidates.coreLoop.executionResult.executionAllowed, false);
      assert.notEqual(emptyCandidates.status, "pass");
      // This fixture isolates the non-route permission question. Local
      // inventory can otherwise add a separate route question to the report.
      emptyCandidates.preDecisionOptionFrame.unresolvedQuestions =
        emptyCandidates.preDecisionOptionFrame.unresolvedQuestions.filter((question) =>
          question.questionId !== "plan-challenge-route-selection");
      emptyCandidates.preDecisionOptionFrame.candidateOptions = [];
      const emptyCandidatesPath = path.join(tempDir, "pending-no-routes.json");
      await writeFile(emptyCandidatesPath, `${JSON.stringify(emptyCandidates, null, 2)}\n`, "utf8");
      await validateArtifactFile(emptyCandidatesPath);

      const invalidCandidate = structuredClone(emptyCandidates);
      invalidCandidate.preDecisionOptionFrame.candidateOptions = [{}];
      const invalidCandidatePath = path.join(tempDir, "pending-invalid-route.json");
      await writeFile(invalidCandidatePath, `${JSON.stringify(invalidCandidate, null, 2)}\n`, "utf8");
      await assert.rejects(validateArtifactFile(invalidCandidatePath), /candidateOptions\[0\].*missing required field/iu);

      const routeChoice = structuredClone(emptyCandidates);
      const routeFrame = routeChoice.preDecisionOptionFrame;
      const previousQuestionId = routeFrame.planChallengeState.selectedQuestionId;
      const routeQuestionId = "plan-challenge-route-selection";
      for (const question of routeFrame.unresolvedQuestions) {
        if (question.questionId === previousQuestionId) question.questionId = routeQuestionId;
        question.dependsOn = question.dependsOn.map((id) => id === previousQuestionId ? routeQuestionId : id);
      }
      routeFrame.planChallengeState.selectedQuestionId = routeQuestionId;
      routeFrame.planChallengeState.pendingUserChoice.question.binding = `plan-challenge-response:${routeQuestionId}`;
      const routeChoicePath = path.join(tempDir, "route-choice-no-routes.json");
      await writeFile(routeChoicePath, `${JSON.stringify(routeChoice, null, 2)}\n`, "utf8");
      await assert.rejects(validateArtifactFile(routeChoicePath), /at least two paths for a required route choice/iu);
      // This deliberately incomplete option checks the count before any option
      // quality checks; a single route cannot become a real branching choice.
      routeFrame.candidateOptions = [{}];
      await writeFile(routeChoicePath, `${JSON.stringify(routeChoice, null, 2)}\n`, "utf8");
      await assert.rejects(validateArtifactFile(routeChoicePath), /at least two paths for a required route choice/iu);
      routeFrame.requiresUserChoice = false;
      await writeFile(routeChoicePath, `${JSON.stringify(routeChoice, null, 2)}\n`, "utf8");
      await assert.rejects(validateArtifactFile(routeChoicePath), /at least two paths for a required route choice/iu);

      const forged = JSON.parse(await readFileSync(report.paths.json, "utf8"));
      forged.preDecisionOptionFrame.planChallengeState.executionAllowed = true;
      forged.coreLoop.executionResult.executionAllowed = true;
      forged.coreLoop.executionResult.executionGate = "ready";
      const forgedPath = path.join(tempDir, "forged.json");
      await writeFile(forgedPath, `${JSON.stringify(forged, null, 2)}\n`, "utf8");
      await assert.rejects(
        validateArtifactFile(forgedPath),
        /executionAllowed must remain false/iu,
      );

      const impossibleReady = JSON.parse(readFileSync(report.paths.json, "utf8"));
      const challenge = impossibleReady.preDecisionOptionFrame.planChallengeState;
      challenge.phase = "ready_for_execution";
      challenge.executionAllowed = true;
      challenge.planChallengeSatisfied = false;
      challenge.pendingUserChoice = { status: "not_required", question: null, controls: [] };
      impossibleReady.preDecisionOptionFrame.requiresUserChoice = false;
      impossibleReady.preDecisionOptionFrame.solutionChoiceState = "confirmed";
      impossibleReady.preDecisionOptionFrame.userChoiceState = "confirmed";
      impossibleReady.preDecisionOptionFrame.choiceGateSkip = null;
      impossibleReady.preDecisionOptionFrame.skipSource = "user_confirmed";
      impossibleReady.coreLoop.executionResult.executionAllowed = true;
      impossibleReady.coreLoop.executionResult.executionGate = "ready";
      const impossibleReadyPath = path.join(tempDir, "impossible-ready.json");
      await writeFile(
        impossibleReadyPath,
        `${JSON.stringify(impossibleReady, null, 2)}\n`,
        "utf8",
      );
      await assert.rejects(
        validateArtifactFile(impossibleReadyPath),
        /executionAllowed must remain false|cannot claim ready_for_execution/iu,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("ordinary local-mutation work without alternatives stays inactive", () => {
    const result = build("帮我实现登录功能修复。");

    assert.equal(result.planChallengeState.active, false);
    assert.deepEqual(result.planChallengeState.triggerReasons, []);
    assert.equal(result.planChallengeState.phase, "inactive");
    assert.equal(result.planChallengeState.pendingUserChoice.status, "not_required");
    assert.deepEqual(result.unresolvedQuestions, []);
  });

  test("plain inclusive-or wording without alternatives does not activate branching", () => {
    for (const task of [
      "帮我修复登录功能，或者顺手更新一下依赖。",
      "Review the login fix and maybe update the docs.",
    ]) {
      const result = build(task);
      assert.equal(result.planChallengeState.active, false, task);
      assert.deepEqual(result.planChallengeState.triggerReasons, [], task);
    }
  });

  test("alternatives phrasing activates a branching decision and demands a user choice", () => {
    for (const task of [
      "方案A还是方案B，帮我定一下再动手。",
      "这两条路线你选哪条：先重构还是先加功能？",
      "should we use the local cache or the remote API for session storage?",
      "Should we use the rebuild approach or the incremental approach first?",
    ]) {
      const result = build(task);
      assert.equal(result.planChallengeState.active, true, task);
      assert.ok(
        result.planChallengeState.triggerReasons.includes("branching_decision"),
        task,
      );
      assert.equal(result.planChallengeState.phase, "awaiting_user_answer", task);
      assert.equal(
        result.planChallengeState.pendingUserChoice.status,
        "required_not_invoked",
        task,
      );
      const routeQuestion = result.unresolvedQuestions.find(
        (question) => question.questionId === "plan-challenge-route-selection",
      );
      assert.ok(routeQuestion, task);
      assert.equal(routeQuestion.status, "open", task);
      assert.equal(routeQuestion.recommendationState, "preference_only", task);
      assert.equal(routeQuestion.recommendedAnswer, null, task);
      assert.equal(
        result.planChallengeState.pendingUserChoice.question.binding,
        "plan-challenge-response:plan-challenge-route-selection",
        task,
      );
    }
  });

  test("structural branching options activate the route-selection question with option lines", () => {
    const result = build("帮我改进构建流程。", {
      branchingOptions: [
        { label: "迁移到 esbuild", summary: "最快，但需要重写配置" },
        { label: "保留现有 webpack", summary: "零迁移成本，构建时间不变" },
        { label: "混合方案" },
      ],
    });

    assert.equal(result.planChallengeState.active, true);
    assert.ok(result.planChallengeState.triggerReasons.includes("branching_decision"));
    const routeQuestion = result.unresolvedQuestions.find(
      (question) => question.questionId === "plan-challenge-route-selection",
    );
    assert.ok(routeQuestion);
    assert.equal(routeQuestion.impactPriority, 85);
    assert.ok(routeQuestion.question.includes("存在多条实质不同的可行路线"));
    assert.ok(routeQuestion.question.includes("• 迁移到 esbuild — 最快，但需要重写配置"));
    assert.ok(routeQuestion.question.includes("• 保留现有 webpack — 零迁移成本，构建时间不变"));
    assert.ok(routeQuestion.question.includes("• 混合方案"));
    assert.equal(routeQuestion.recommendationState, "preference_only");
    assert.equal(routeQuestion.recommendedAnswer, null);
    assert.equal(result.planChallengeState.phase, "awaiting_user_answer");
  });

  test("the real high-score subjective route exposes its must-ask choice card", () => {
    const result = selectRoute("这个页面不好看，请提供方案A还是方案B让我选择布局");

    assert.equal(result.recommendedRoute?.score, 94);
    assert.equal(result.entryChoiceDecision?.choicePolicy, "must_ask");
    assert.equal(result.entryChoiceDecision?.critical?.required, true);
    assert.equal(result.entryChoiceDecision?.thinking?.required, true);
    assert.equal(result.userChoiceNeeded, true);
    assert.ok(result.decisionCard);
    assert.ok(Array.isArray(result.decisionCard.options));
    assert.ok(result.decisionCard.options.length >= 2);
    assert.deepEqual(result.requiredUserChoiceIfAny, result.decisionCard);

    const checkpointOptions = new Set(
      (result.decisionCheckpoints ?? []).flatMap((checkpoint) => checkpoint.options ?? []),
    );
    const rankedRouteIds = new Set(
      (result.rankedRoutes ?? []).map((route) => route.id).filter(Boolean),
    );
    const cardLabels = result.decisionCard.options.map((option) => option.label ?? option.id);
    assert.equal(new Set(cardLabels).size, cardLabels.length);
    assert.ok(
      cardLabels.every((label) => checkpointOptions.has(label) || rankedRouteIds.has(label)),
      JSON.stringify({ cardLabels, checkpointOptions: [...checkpointOptions], rankedRouteIds: [...rankedRouteIds] }),
    );
    assert.ok(
      cardLabels.includes(result.decisionCard.recommendedDefault),
      "the recommended default must be one of the real choice options",
    );
    assert.equal(result.routeExecutionGate?.handoffStatus, "awaiting_native_choice");
    assert.equal(result.routeExecutionGate?.canEnterExecution, false);
  });

  test("a low-risk route does not gain a choice card from the policy projection", () => {
    const result = selectRoute("修正文档里的一个错别字。");

    assert.equal(result.entryChoiceDecision?.choicePolicy, "no_choice_needed");
    assert.equal(result.userChoiceNeeded, false);
    assert.equal(result.decisionCard, null);
    assert.equal(result.requiredUserChoiceIfAny, null);
  });

  test("ordinary route cards exclude blocked support entries and low-score routes", () => {
    const result = selectRoute("Pressure-test this plan, then publish the version to GitHub.");
    const feasibleRouteIds = new Set((result.rankedRoutes ?? [])
      .filter((route) => route.id && route.score >= 70 && !(route.blockedReasons?.length))
      .map((route) => route.id));
    assert.ok((result.rankedRoutes ?? []).some((route) => route.blockedReasons?.length),
      "the fixture must include blocked support entries to exercise their exclusion");
    if (result.decisionCard === null) return;
    assert.ok(result.decisionCard.options.length >= 2);
    assert.ok(result.decisionCard.options.every((option) => feasibleRouteIds.has(option.id)),
      JSON.stringify(result.decisionCard.options));
  });

  test("complementary worker lanes never become mutually exclusive route options", () => {
    const routeOptions = buildRouteBranchingOptions({
      workerTaskPackets: [
        {
          roleDisplayName: "frontend",
          roleInstanceId: "ui",
          parallelGroup: "implementation",
        },
        {
          roleDisplayName: "backend",
          roleInstanceId: "api",
          parallelGroup: "implementation",
        },
        {
          roleDisplayName: "test",
          roleInstanceId: "qa",
          dependsOn: ["api"],
          parallelGroup: "verification",
        },
      ],
      selectedExecutionRoute: {
        routeExecutionGate: { handoffStatus: "ready_for_host_handoff" },
      },
    });

    assert.deepEqual(routeOptions, []);
    const result = build("帮我实现登录功能修复。", { branchingOptions: routeOptions });
    assert.equal(result.planChallengeState.active, false);
    assert.equal(result.planChallengeState.pendingUserChoice.status, "not_required");
  });

  test("the route selector decision card remains a required choice", () => {
    const routeReport = {
      workerTaskPackets: [
        { roleDisplayName: "frontend", roleInstanceId: "ui" },
        { roleDisplayName: "backend", roleInstanceId: "api" },
      ],
      selectedExecutionRoute: {
        decisionCard: {
          recommendedDefault: "incremental-route",
          options: [
            {
              id: "incremental-route",
              bestFor: "existing project",
              benefit: "smallest scope",
              cost: "slower migration",
              risk: "partial support",
              expectedResult: "bounded execution",
              verification: "route validation",
            },
            {
              id: "rebuild-route",
              bestFor: "new architecture",
              benefit: "clean boundary",
              cost: "larger change",
              risk: "higher migration cost",
              expectedResult: "new route",
              verification: "full review",
            },
          ],
        },
        routeExecutionGate: { handoffStatus: "awaiting_native_choice" },
      },
    };
    const routeOptions = buildRouteBranchingOptions(routeReport);

    assert.equal(routeOptions.length, 2);
    assert.equal(routeOptions[0].label, "incremental-route");
    assert.equal(routeOptions[0].recommended, true);
    const result = build("帮我修复当前登录功能。", { branchingOptions: routeOptions });
    assert.ok(result.planChallengeState.triggerReasons.includes("branching_decision"));
    assert.equal(result.planChallengeState.pendingUserChoice.status, "required_not_invoked");

    const settledRouteOptions = buildRouteBranchingOptions({
      ...routeReport,
      selectedExecutionRoute: {
        ...routeReport.selectedExecutionRoute,
        routeExecutionGate: { handoffStatus: "ready_for_host_handoff" },
      },
    });
    assert.deepEqual(settledRouteOptions, []);
  });

  test("an explicitly settled route is not asked again because structural alternatives exist", () => {
    const result = build("我已经决定采用本地缓存方案，不要切换到远程 API。", {
      branchingOptions: [
        { label: "本地缓存方案" },
        { label: "远程 API" },
      ],
    });

    assert.equal(result.planChallengeState.active, false);
    assert.deepEqual(result.planChallengeState.triggerReasons, []);
    assert.equal(result.planChallengeState.pendingUserChoice.status, "not_required");
  });

  test("exactly one recommended option becomes the recommendation; more or fewer do not", () => {
    const single = build("帮我改进构建流程。", {
      branchingOptions: [
        { label: "迁移到 esbuild", summary: "最快", recommended: true },
        { label: "保留现有 webpack", summary: "零成本" },
      ],
    });
    const singleQuestion = single.unresolvedQuestions.find(
      (question) => question.questionId === "plan-challenge-route-selection",
    );
    assert.equal(singleQuestion.recommendationState, "recommended");
    assert.equal(singleQuestion.recommendedAnswer, "迁移到 esbuild");

    const multiple = build("帮我改进构建流程。", {
      branchingOptions: [
        { label: "A", recommended: true },
        { label: "B", recommended: true },
      ],
    });
    const multipleQuestion = multiple.unresolvedQuestions.find(
      (question) => question.questionId === "plan-challenge-route-selection",
    );
    assert.equal(multipleQuestion.recommendationState, "preference_only");
    assert.equal(multipleQuestion.recommendedAnswer, null);

    const lonely = build("帮我改进构建流程。", {
      branchingOptions: [{ label: "only one lane" }],
    });
    assert.equal(lonely.planChallengeState.active, false);
    assert.deepEqual(lonely.unresolvedQuestions, []);
  });

  test("option lines are bounded to six options and 120 characters per line", () => {
    const longSummary = "x".repeat(200);
    const result = build("帮我改进构建流程。", {
      branchingOptions: Array.from({ length: 8 }, (_, index) => ({
        label: `option-${index + 1}`,
        summary: index === 0 ? longSummary : `summary ${index + 1}`,
      })),
    });
    const routeQuestion = result.unresolvedQuestions.find(
      (question) => question.questionId === "plan-challenge-route-selection",
    );
    const lines = routeQuestion.question.split("\n").filter((line) => line.startsWith("• "));
    assert.equal(lines.length, 6);
    assert.ok(!routeQuestion.question.includes("option-7"));
    assert.ok(!routeQuestion.question.includes("option-8"));
    for (const line of lines) {
      assert.ok(line.length <= 120, `line too long: ${line.length}`);
    }
    assert.ok(lines[0].endsWith("..."));
  });

  test("branching alone does not require execution authorization", () => {
    const result = build("方案A还是方案B，帮我定一下再动手。");

    assert.equal(result.planChallengeState.authorizationRequired, false);
    assert.equal(
      result.planChallengeState.executionAuthorization.state,
      "not_required",
    );
    assert.equal(
      result.planChallengeState.executionAuthorization.scopeCoversActions,
      true,
    );
    assert.ok(
      !result.summaryData.openRisks.some(
        (risk) => risk.questionId === "execution-authorization",
      ),
    );
    assert.ok(
      !result.unresolvedQuestions.some(
        (question) => question.questionId === "plan-challenge-permission-boundary",
      ),
    );
  });

  test("branching coexists with material risk and sits between permission and delivery", () => {
    const task = "把生产数据库旧表永久删除并执行不可逆迁移，方案A还是方案B？";
    const result = build(task);

    assert.equal(result.planChallengeState.active, true);
    assert.ok(result.planChallengeState.triggerReasons.includes("material_risk"));
    assert.ok(result.planChallengeState.triggerReasons.includes("branching_decision"));
    const priorities = new Map(
      result.unresolvedQuestions.map((question) => [question.questionId, question.impactPriority]),
    );
    assert.equal(priorities.get("plan-challenge-permission-boundary"), 100);
    assert.equal(priorities.get("plan-challenge-route-selection"), 85);
    assert.equal(priorities.get("plan-challenge-delivery-boundary"), 80);
    assert.equal(
      result.planChallengeState.selectedQuestionId,
      "plan-challenge-permission-boundary",
    );

    const answered = build(task, {
      responses: [
        trustedResponse(
          { questionId: "plan-challenge-permission-boundary" },
          "answered",
          "仅允许本地验证。",
        ),
      ],
    });
    assert.equal(
      answered.planChallengeState.selectedQuestionId,
      "plan-challenge-route-selection",
    );
  });

  test("Japanese and Korean route-selection surfaces stay localized", () => {
    for (const [outputLanguage, task, localizedPattern] of [
      ["ja-JP", "方案A还是方案B，どちらを採用しますか？", /[ぁ-んァ-ヶ一-龠]/u],
      ["ko-KR", "方案A还是方案B，어느 쪽을 채택할까요?", /[가-힣]/u],
    ]) {
      const result = build(task, { outputLanguage });
      const routeQuestion = result.unresolvedQuestions.find(
        (question) => question.questionId === "plan-challenge-route-selection",
      );
      assert.ok(routeQuestion, outputLanguage);
      assert.match(routeQuestion.question, localizedPattern, outputLanguage);
      assert.doesNotMatch(routeQuestion.question, /plan-challenge-|questionId|binding/iu);
    }
  });

  test("challenge implementation keeps the eight-stage spine and contains no attribution prose", () => {
    const stages = CORE_LOOP_CONTRACT.stages.map((stage) => stage.stage);
    assert.equal(stages.length, 8);
    const sources = [
      "../../canonical/skills/meta-theory/SKILL.md",
      "../../canonical/skills/meta-theory/references/dev-governance.md",
      "../../canonical/skills/meta-theory/references/rhythm-orchestration.md",
      "../../canonical/skills/meta-theory/references/spine-state.md",
      "../../config/contracts/core-loop-contract.json",
      "../../config/contracts/workflow-contract.json",
      "../../config/governance/plan-challenge-action-intent.json",
      "../../scripts/run-meta-theory-governed-execution.mjs",
      "../../scripts/governed-execution/plan-challenge-host-continuation.mjs",
      "../../scripts/governed-execution/plan-challenge-policy.mjs",
    ].map((file) => readFileSync(new URL(file, import.meta.url), "utf8"));
    const challengeText = sources
      .flatMap((source) => source.split(/\r?\n/u))
      .filter((line) => /plan.?challenge|方案拷问|压力测试|帮我挑刺/iu.test(line))
      .join("\n");
    const forbiddenAttribution = new RegExp(
      [
        ["inspired", "by"].join("\\s+"),
        ["adapted", "from"].join("\\s+"),
        ["borrowed", "from"].join("\\s+"),
        "\\u501f\\u9274",
        "\\u53c2\\u8003\\u81ea",
        "\\u6765\\u6e90\\u4e8e",
      ].join("|"),
      "iu",
    );
    assert.doesNotMatch(challengeText, forbiddenAttribution);
  });
});
