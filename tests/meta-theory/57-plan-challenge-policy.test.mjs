import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
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

  test("read-only classification removes caller-requested side-effect actions", () => {
    const result = build("只读压力测试这个命令方案，不修改也不创建文件。", {
      requestedSideEffectActions: ["project_capability_copy"],
    });
    assert.deepEqual(result.planChallengeState.sideEffectActions, []);
    assert.equal(result.planChallengeState.authorizationRequired, false);
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
        schemaVersion: "warden-approval-v0.1",
        approvalId: "plan-challenge-write-gate-approval",
        approver: "meta-warden",
        approvedAt: "2026-07-14T00:00:00.000Z",
        scope: "test only: approved target remains blocked while user choice is pending",
        targets: [`canonical/${targetRelative}`],
        diffSummary: "Approve the temp candidate only after the challenge closes.",
        rollbackPlan: "Remove the temp canonical file.",
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
