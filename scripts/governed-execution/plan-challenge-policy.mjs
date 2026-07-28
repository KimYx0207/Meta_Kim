import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const ACTION_INTENT_CONFIG = JSON.parse(
  readFileSync(
    new URL("../../config/governance/plan-challenge-action-intent.json", import.meta.url),
    "utf8",
  ),
);
const ACTION_INTENT_REGEX_FLAGS = ACTION_INTENT_CONFIG.regexFlags ?? "iu";

function matchesConfiguredPattern(text, patterns = []) {
  return patterns.some((pattern) => new RegExp(pattern, ACTION_INTENT_REGEX_FLAGS).test(text));
}

function stripConfiguredQuotedSpans(text) {
  return (ACTION_INTENT_CONFIG.quotedSpanPatterns ?? []).reduce(
    (value, pattern) => value.replace(new RegExp(pattern, `${ACTION_INTENT_REGEX_FLAGS}g`), " "),
    text,
  );
}

function configuredClauses(text) {
  const withoutQuotedSpans = stripConfiguredQuotedSpans(text);
  const splitPattern = ACTION_INTENT_CONFIG.clauseSplitPattern ?? "[\\n]+";
  return withoutQuotedSpans
    .split(new RegExp(splitPattern, ACTION_INTENT_REGEX_FLAGS))
    .map((clause) => clause.trim())
    .filter(Boolean);
}

const PLAN_CHALLENGE_QUESTION_STATUSES = new Set([
  "open",
  "answered",
  "skipped",
  "invalidated",
]);

function trustedContradictionEvidence(items) {
  return (Array.isArray(items) ? items : []).filter(
    (item) =>
      item &&
      typeof item === "object" &&
      item.trusted === true &&
      String(item.binding ?? "") === "plan-challenge-contradiction" &&
      String(item.evidenceRef ?? "").trim(),
  );
}

function classifyPlanChallengeActions(task, requestedSideEffectActions = []) {
  const text = String(task ?? "");
  const clauses = configuredClauses(text);
  const clauseContexts = clauses.map((clause) => ({
    clause,
    readOnly: matchesConfiguredPattern(clause, ACTION_INTENT_CONFIG.readOnlyPatterns),
    documentationOnly:
      matchesConfiguredPattern(clause, ACTION_INTENT_CONFIG.documentationContextPatterns) &&
      !matchesConfiguredPattern(
        clause,
        ACTION_INTENT_CONFIG.documentationExecutionOverridePatterns,
      ),
    nonExecutionContext: matchesConfiguredPattern(
      clause,
      ACTION_INTENT_CONFIG.nonExecutionContextPatterns,
    ),
  }));
  const explicitlyReadOnly =
    clauseContexts.length > 0 &&
    clauseContexts.every((context) => context.readOnly || context.nonExecutionContext);
  const documentationOnly =
    clauseContexts.some((context) => context.documentationOnly) &&
    clauseContexts.every(
      (context) => context.documentationOnly || context.readOnly || context.nonExecutionContext,
    );
  const nonExecutionContext =
    clauseContexts.length > 0 &&
    clauseContexts.every((context) => context.nonExecutionContext || context.readOnly);
  const actions = new Set(
    (Array.isArray(requestedSideEffectActions) ? requestedSideEffectActions : [])
      .map((action) => String(action).trim())
      .filter(Boolean),
  );
  if (!explicitlyReadOnly) {
    for (const context of clauseContexts) {
      if (context.readOnly || context.nonExecutionContext) continue;
      for (const rule of ACTION_INTENT_CONFIG.actions ?? []) {
        if (context.documentationOnly && rule.skipWhenDocumentationOnly === true) continue;
        if (
          matchesConfiguredPattern(context.clause, rule.patterns) &&
          !matchesConfiguredPattern(context.clause, rule.negationPatterns)
        ) actions.add(rule.action);
      }
    }
  }
  return {
    explicitlyReadOnly,
    documentationOnly,
    nonExecutionContext,
    sideEffectActions: explicitlyReadOnly ? [] : [...actions].sort(),
  };
}

function planChallengeSignals(task, contradictionEvidence = [], requestedSideEffectActions = []) {
  const text = String(task ?? "");
  const actionIntent = classifyPlanChallengeActions(task, requestedSideEffectActions);
  const boundContradictions = trustedContradictionEvidence(contradictionEvidence);
  const explicitChallengeNegated =
    /(?:不需要|无需|不要|别)\s*(?:(?:方案|计划)\s*)?(?:拷问|压力测试|挑刺|反证|质疑)|(?:do\s+not|don't|no\s+need\s+to)\s+(?:challenge|stress[- ]?test)|(?:不要|不要です|必要ありません).*(?:ストレステスト|問い直)|(?:필요\s*없|하지\s*마).*(?:스트레스\s*테스트|비판적\s*검토)/iu.test(text);
  const explicitUserRequest =
    !explicitChallengeNegated &&
    /方案拷问|计划拷问|帮我拷问|拷问一下|压力测试|帮我挑刺|挑刺一下|反证(?:一下|这个|方案)?|质疑(?:一下|这个|方案)?|challenge\s+(?:(?:the|this)\s+)?(?:plan|proposal|approach)|stress[- ]?test\s+(?:(?:the|this)\s+)?(?:plan|proposal|approach)|(?:計画|提案|方針).*(?:ストレステスト|批判的に検証|問い直)|ストレステスト.*(?:計画|提案|方針)|(?:계획|제안|방안).*(?:스트레스\s*테스트|비판적으로\s*검토|따져)|스트레스\s*테스트.*(?:계획|제안|방안)/iu.test(text);
  const materialRisk =
    !actionIntent.explicitlyReadOnly &&
    !actionIntent.documentationOnly &&
    (actionIntent.sideEffectActions.some((action) => action !== "local_file_mutation") ||
      /高成本|昂贵|不可逆|安全边界|costly|high[- ]?cost|irreversible/iu.test(text));
  const evidenceContradiction =
    boundContradictions.length > 0 ||
    /证据(?:互相)?矛盾|信息冲突|结论冲突|前后不一致|contradict(?:ion|ory)|conflicting\s+evidence|evidence\s+conflict/iu.test(text);
  const evidenceInsufficient =
    /没有证据|证据不足|缺少证据|无可靠证据|无法证明|insufficient\s+evidence|no\s+evidence|lack(?:ing|s)?\s+evidence|unproven/iu.test(text);
  return {
    explicitUserRequest,
    materialRisk,
    evidenceContradiction,
    sideEffectRequested: actionIntent.sideEffectActions.length > 0,
    explicitlyReadOnly: actionIntent.explicitlyReadOnly,
    documentationOnly: actionIntent.documentationOnly,
    sideEffectActions: actionIntent.sideEffectActions,
    boundContradictions,
    evidenceInsufficient,
    triggerReasons: [
      ...(explicitUserRequest ? ["explicit_user_request"] : []),
      ...(materialRisk ? ["material_risk"] : []),
      ...(evidenceContradiction ? ["evidence_contradiction"] : []),
    ],
  };
}

function planChallengeQuestion({
  questionId,
  question,
  questionTarget,
  decisionImpact,
  impactPriority,
  dependsOn = [],
  evidenceRefs = [],
  recommendationState,
  recommendedAnswer = null,
  recommendationRationale,
}) {
  return {
    questionId,
    question,
    questionTarget,
    decisionImpact,
    impactPriority,
    dependsOn,
    evidenceRefs,
    recommendationState,
    recommendedAnswer,
    recommendationRationale,
    userAnswer: null,
    answerEvidenceRefs: [],
    invalidatedBy: null,
    status: "open",
  };
}

export function selectHighestImpactOpenQuestion(questions) {
  const byId = new Map((questions ?? []).map((question) => [question.questionId, question]));
  return [...(questions ?? [])]
    .filter((question) => {
      if (question.status !== "open") return false;
      return (question.dependsOn ?? []).every(
        (dependencyId) => byId.get(dependencyId)?.status === "answered",
      );
    })
    .sort(
      (left, right) =>
        Number(right.impactPriority ?? 0) - Number(left.impactPriority ?? 0) ||
        String(left.questionId).localeCompare(String(right.questionId)),
    )[0] ?? null;
}

export function parsePlanChallengeControl(text) {
  const value = String(text ?? "").trim();
  if (!value) return null;
  if (["accept_recommendation", "skip", "summarize_stop", "continue"].includes(value)) {
    return value;
  }
  if (/够了.*(?:总结|汇总)|总结.*(?:停止|结束)|汇总.*(?:停止|结束)|总结并停止|summary.*stop|summari[sz]e.*stop|stop.*summari[sz]e|要約.*(?:停止|終了)|まとめ.*(?:停止|終了)|요약.*중지|정리.*중지/iu.test(value)) {
    return "summarize_stop";
  }
  if (/按推荐(?:走|执行|继续)|接受推荐|采用推荐|accept\s+(?:the\s+)?recommendation|use\s+(?:the\s+)?recommendation|推奨(?:案)?で進|おすすめ.*進|추천.*진행|권장.*진행/iu.test(value)) {
    return "accept_recommendation";
  }
  if (/^(?:跳过|跳过这个问题|skip|skip\s+this|スキップ|この質問をスキップ|건너뛰기|이 질문 건너뛰기)[.!。！\s]*$/iu.test(value)) {
    return "skip";
  }
  if (/^(?:继续问|继续拷问|继续挑战|continue\s+questioning|continue\s+challenge|質問を続ける|계속 질문|계속 검토)[.!。！\s]*$/iu.test(value)) {
    return "continue";
  }
  return null;
}

export function planChallengeAuthorizationBinding(sideEffectActions = []) {
  const normalized = [...new Set((sideEffectActions ?? []).map((item) => String(item).trim()).filter(Boolean))]
    .sort()
    .join("\n");
  return `plan-challenge-authorization:${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

export function buildPlanChallengeState({
  task,
  responses = [],
  control = null,
  sharedUnderstandingConfirmed = false,
  executionAuthorization = null,
  contradictionEvidence = [],
  requestedSideEffectActions = [],
  outputLanguage = "zh-CN",
  priorChallengeState = null,
} = {}) {
  const signals = planChallengeSignals(task, contradictionEvidence, requestedSideEffectActions);
  const active = signals.triggerReasons.length > 0;
  const authorizationRequired =
    active && !signals.explicitlyReadOnly && signals.sideEffectActions.length > 0;
  const locale = String(outputLanguage).toLowerCase();
  const zh = locale.startsWith("zh");
  let copy = zh
    ? {
        permissionQuestion: "本次运行明确允许哪些不可逆操作或外部操作？",
        permissionImpact: "答案会决定是否允许修改外部、全局、生产环境或难以撤销的状态。",
        permissionRecommendation: "在精确授权范围前，继续阻止不可逆操作和外部操作。",
        permissionRationale: "先产出可撤销的本地结果，用户审查后再扩大副作用范围。",
        deliveryQuestion: "本次运行应在本地修改并验证后结束，还是继续执行外部交付？",
        deliveryImpact: "答案会改变交付边界，并决定是否包含发布或部署环节。",
        deliveryRecommendation: "除非外部交付已被单独授权，否则在本地修改并验证后停止。",
        deliveryRationale: "这样可以保留清晰的审查与回滚边界，不会悄悄扩大范围。",
        conflictQuestion: "选择路线前，必须先解决哪一条冲突结论？",
        conflictImpact: "答案会改变采用哪组证据，并可能替换当前路线。",
        conflictRationale: "冲突证据未解决前，任何路线推荐都不可靠。",
        preferenceQuestion: "什么结果会让你认为当前方案不可接受？",
        preferenceImpact: "答案会改变用于保留或否决当前方案的验收边界。",
        preferenceRationale: "这是用户自己的质量和价值边界，系统不能替用户编造偏好。",
        inactiveNext: "沿用现有低风险、无分支路线，不增加额外拷问环节。",
        answerNext: (id) => `只询问当前影响最高的问题 ${id}，并等待用户回答。`,
        understandingNext: "汇总已确认的决定，并确认双方理解是否一致。",
        deniedNext: "停止执行：用户未授权执行。",
        authorizationNext: "将执行授权与理解确认分开，单独请求执行授权。",
        executeNext: "只在明确授权的范围内执行。",
        understandingRisk: "当前方案尚未完成共同理解确认。",
        authorizationRisk: "执行授权与理解确认相互独立，目前尚未授权。",
      }
    : {
        permissionQuestion: "Which irreversible or external operations, if any, are explicitly authorized for this run?",
        permissionImpact: "The answer changes whether execution may mutate external, global, production, or hard-to-reverse state.",
        permissionRecommendation: "Keep irreversible and external operations blocked until their exact scope is explicitly authorized.",
        permissionRationale: "A reversible local result can be reviewed before broader side effects are allowed.",
        deliveryQuestion: "Should the run stop after verified local changes, or continue to an external delivery step?",
        deliveryImpact: "The answer changes the deliverable boundary and whether an external release or deployment lane is included.",
        deliveryRecommendation: "Stop after verified local changes unless external delivery is separately authorized.",
        deliveryRationale: "This preserves a reviewable rollback boundary without silently widening the requested scope.",
        conflictQuestion: "Which conflicting claim must be resolved before the route can be selected?",
        conflictImpact: "The answer changes which evidence is authoritative and may replace the selected route.",
        conflictRationale: "No route recommendation is reliable until the conflicting evidence is resolved.",
        preferenceQuestion: "Which outcome would make the current plan unacceptable to you?",
        preferenceImpact: "The answer changes the acceptance boundary used to challenge or retain the current plan.",
        preferenceRationale: "This is the user's quality and value boundary, so the system must not invent a preferred answer.",
        inactiveNext: "Continue the existing low-risk no-branching path without an extra challenge step.",
        answerNext: (id) => `Ask only ${id} and wait for the user's answer.`,
        understandingNext: "Summarize the resolved decisions and ask whether the shared understanding is correct.",
        deniedNext: "Stop execution; authorization was denied.",
        authorizationNext: "Request execution authorization separately from understanding confirmation.",
        executeNext: "Execute only within the explicitly authorized scope.",
        understandingRisk: "The plan has not yet been confirmed as a shared understanding.",
        authorizationRisk: "Execution authorization remains separate and has not been granted.",
      };
  if (locale.startsWith("ja")) {
    copy = {
      ...copy,
      permissionQuestion: "この実行で明示的に許可する、取り消しにくい操作または外部操作はどれですか？",
      permissionImpact: "回答によって、外部・グローバル・本番環境、または取り消しにくい状態を変更できるかが決まります。",
      permissionRecommendation: "正確な許可範囲が確認されるまで、取り消しにくい操作と外部操作を停止してください。",
      permissionRationale: "まず取り消し可能なローカル結果を作り、確認後に副作用の範囲を広げます。",
      deliveryQuestion: "ローカル変更と検証で終了しますか、それとも外部への配布まで進めますか？",
      deliveryImpact: "回答によって成果物の範囲と、公開またはデプロイ工程を含めるかが変わります。",
      deliveryRecommendation: "外部配布が個別に許可されていない限り、ローカル変更と検証で停止してください。",
      deliveryRationale: "確認とロールバックの境界を保ち、暗黙に範囲を広げないためです。",
      conflictQuestion: "経路を選ぶ前に、どの矛盾した主張を解決する必要がありますか？",
      conflictImpact: "回答によって採用する証拠が変わり、現在の経路を置き換える可能性があります。",
      conflictRationale: "矛盾する証拠が解決されるまで、経路の推奨は信頼できません。",
      preferenceQuestion: "どの結果なら、現在の計画を受け入れられないと判断しますか？",
      preferenceImpact: "回答によって、現在の計画を残すか退けるかの受け入れ境界が変わります。",
      preferenceRationale: "これはユーザー自身の品質と価値の境界であり、システムが代わりに作ることはできません。",
      inactiveNext: "低リスクで分岐のない既存経路を続け、追加質問は行いません。",
      answerNext: (question) => `現在もっとも影響が大きい質問だけを確認します：${question}`,
      understandingNext: "確定した判断を要約し、共通理解が正しいか確認します。",
      deniedNext: "実行を停止します。実行許可がありません。",
      authorizationNext: "共通理解の確認とは別に、実行許可を確認します。",
      executeNext: "明示的に許可された範囲だけを実行します。",
      understandingRisk: "計画の共通理解がまだ確認されていません。",
      authorizationRisk: "実行許可は共通理解とは別で、まだ付与されていません。",
    };
  } else if (locale.startsWith("ko")) {
    copy = {
      ...copy,
      permissionQuestion: "이번 실행에서 되돌리기 어렵거나 외부에 영향을 주는 작업 중 무엇을 명시적으로 허용합니까?",
      permissionImpact: "답변에 따라 외부, 전역, 운영 환경 또는 되돌리기 어려운 상태를 변경할 수 있는지가 결정됩니다.",
      permissionRecommendation: "정확한 허용 범위가 확인될 때까지 되돌리기 어려운 작업과 외부 작업을 차단하세요.",
      permissionRationale: "먼저 되돌릴 수 있는 로컬 결과를 만든 뒤 검토 후 부작용 범위를 넓힐 수 있습니다.",
      deliveryQuestion: "로컬 변경과 검증에서 끝낼까요, 아니면 외부 배포 단계까지 진행할까요?",
      deliveryImpact: "답변에 따라 결과물 범위와 외부 출시 또는 배포 단계를 포함할지가 달라집니다.",
      deliveryRecommendation: "외부 전달이 별도로 승인되지 않았다면 로컬 변경과 검증에서 중지하세요.",
      deliveryRationale: "검토와 롤백 경계를 유지하고 요청 범위를 조용히 넓히지 않기 위해서입니다.",
      conflictQuestion: "경로를 선택하기 전에 어떤 상충된 주장을 먼저 해결해야 합니까?",
      conflictImpact: "답변에 따라 어떤 증거를 채택할지가 달라지고 현재 경로가 바뀔 수 있습니다.",
      conflictRationale: "상충된 증거가 해결되기 전에는 어떤 경로 추천도 신뢰할 수 없습니다.",
      preferenceQuestion: "어떤 결과라면 현재 계획을 받아들일 수 없습니까?",
      preferenceImpact: "답변에 따라 현재 계획을 유지하거나 기각하는 수용 기준이 달라집니다.",
      preferenceRationale: "이는 사용자의 품질과 가치 기준이므로 시스템이 대신 만들어서는 안 됩니다.",
      inactiveNext: "위험이 낮고 분기가 없는 기존 경로를 유지하며 추가 질문을 만들지 않습니다.",
      answerNext: (question) => `현재 영향이 가장 큰 질문 하나만 확인합니다: ${question}`,
      understandingNext: "확정된 결정을 요약하고 공통 이해가 맞는지 확인합니다.",
      deniedNext: "실행 권한이 없으므로 실행을 중지합니다.",
      authorizationNext: "공통 이해 확인과 별도로 실행 권한을 요청합니다.",
      executeNext: "명시적으로 승인된 범위에서만 실행합니다.",
      understandingRisk: "계획에 대한 공통 이해가 아직 확인되지 않았습니다.",
      authorizationRisk: "실행 권한은 공통 이해와 별개이며 아직 부여되지 않았습니다.",
    };
  }
  const questions = [];
  const triggerEvidence = [];
  const addTriggerEvidence = (kind, source, excerpt, trusted = true, binding = "task") => {
    const index = triggerEvidence.length;
    triggerEvidence.push({
      evidenceId: `plan-challenge-trigger-${index + 1}`,
      kind,
      source,
      excerpt: String(excerpt ?? "").slice(0, 500),
      trusted,
      binding,
    });
    return `preDecisionOptionFrame.planChallengeState.triggerEvidence[${index}]`;
  };
  const explicitEvidenceRef = signals.explicitUserRequest
    ? addTriggerEvidence("explicit_user_request", "user_request", task)
    : null;
  const riskEvidenceRef = signals.materialRisk
    ? addTriggerEvidence(
        "material_risk",
        "classified_side_effect_intent",
        signals.sideEffectActions.join(", "),
      )
    : null;
  const contradictionRefs = [];
  if (signals.evidenceContradiction) {
    if (signals.boundContradictions.length > 0) {
      for (const item of signals.boundContradictions) {
        contradictionRefs.push(
          addTriggerEvidence(
            "evidence_contradiction",
            item.source ?? "host_evidence",
            item.evidenceRef,
            true,
            item.binding,
          ),
        );
      }
    } else {
      contradictionRefs.push(
        addTriggerEvidence("evidence_contradiction", "user_request", task),
      );
    }
  }

  if (signals.materialRisk) {
    questions.push(
      planChallengeQuestion({
        questionId: "plan-challenge-permission-boundary",
        question: copy.permissionQuestion,
        questionTarget: "wrong_permission_or_safety_risk",
        decisionImpact: copy.permissionImpact,
        impactPriority: 100,
        evidenceRefs: [riskEvidenceRef],
        recommendationState: "recommended",
        recommendedAnswer: copy.permissionRecommendation,
        recommendationRationale: copy.permissionRationale,
      }),
    );
    questions.push(
      planChallengeQuestion({
        questionId: "plan-challenge-delivery-boundary",
        question: copy.deliveryQuestion,
        questionTarget: "wrong_deliverable_or_scope_risk",
        decisionImpact: copy.deliveryImpact,
        impactPriority: 80,
        dependsOn: ["plan-challenge-permission-boundary"],
        evidenceRefs: [riskEvidenceRef],
        recommendationState: "recommended",
        recommendedAnswer: copy.deliveryRecommendation,
        recommendationRationale: copy.deliveryRationale,
      }),
    );
  }

  if (signals.evidenceContradiction) {
    questions.push(
      planChallengeQuestion({
        questionId: "plan-challenge-evidence-conflict",
        question: copy.conflictQuestion,
        questionTarget: "wrong_goal_risk",
        decisionImpact: copy.conflictImpact,
        impactPriority: 90,
        evidenceRefs: contradictionRefs,
        recommendationState: "insufficient_evidence",
        recommendedAnswer: null,
        recommendationRationale: copy.conflictRationale,
      }),
    );
  }

  if (signals.explicitUserRequest && signals.evidenceInsufficient && questions.length === 0) {
    questions.push(
      planChallengeQuestion({
        questionId: "plan-challenge-missing-evidence",
        question: copy.conflictQuestion,
        questionTarget: "wrong_acceptance_or_quality_risk",
        decisionImpact: copy.conflictImpact,
        impactPriority: 70,
        evidenceRefs: [explicitEvidenceRef],
        recommendationState: "insufficient_evidence",
        recommendedAnswer: null,
        recommendationRationale: copy.conflictRationale,
      }),
    );
  }

  if (signals.explicitUserRequest && questions.length === 0) {
    questions.push(
      planChallengeQuestion({
        questionId: "plan-challenge-unacceptable-outcome",
        question: copy.preferenceQuestion,
        questionTarget: "wrong_acceptance_or_quality_risk",
        decisionImpact: copy.preferenceImpact,
        impactPriority: 50,
        evidenceRefs: [explicitEvidenceRef],
        recommendationState: "preference_only",
        recommendedAnswer: null,
        recommendationRationale: copy.preferenceRationale,
      }),
    );
  }

  const decisionEvidence = [];
  const addDecisionEvidence = ({
    kind,
    binding,
    sourceRefs,
    sequence = null,
    historical = null,
  }) => {
    const index = decisionEvidence.length;
    decisionEvidence.push({
      evidenceId: `plan-challenge-decision-${index + 1}`,
      kind,
      binding,
      sourceRefs: [...sourceRefs],
      sequence,
      historical,
      trusted: false,
    });
    return `preDecisionOptionFrame.planChallengeState.decisionEvidence[${index}]`;
  };
  const invalidateDerivedQuestions = () => {
    let invalidated = true;
    while (invalidated) {
      invalidated = false;
      const permissionAnswer = questions.find(
        (question) => question.questionId === "plan-challenge-permission-boundary",
      );
      if (
        permissionAnswer?.status === "answered" &&
        /不(?:允许|做|执行)?外部|不要外部|不发布|不部署|仅本地|只在本地|local\s+only|no\s+external|do\s+not\s+(?:release|deploy)|外部.*(?:なし|しない)|로컬만|외부.*안/iu.test(permissionAnswer.userAnswer ?? "")
      ) {
        const delivery = questions.find(
          (question) => question.questionId === "plan-challenge-delivery-boundary",
        );
        if (delivery?.status === "open") {
          delivery.status = "invalidated";
          delivery.invalidatedBy = "answer:plan-challenge-permission-boundary:no_external_operations";
          invalidated = true;
        }
      }
      const byId = new Map(questions.map((question) => [question.questionId, question]));
      for (const question of questions) {
        if (question.status !== "open") continue;
        const invalidDependency = (question.dependsOn ?? []).find((dependencyId) =>
          ["skipped", "invalidated"].includes(byId.get(dependencyId)?.status),
        );
        if (!invalidDependency) continue;
        question.status = "invalidated";
        question.invalidatedBy = invalidDependency;
        invalidated = true;
      }
    }
  };
  const reusablePriorState =
    priorChallengeState?.trusted === true &&
    priorChallengeState?.planChallengeState?.active === true &&
    Array.isArray(priorChallengeState?.unresolvedQuestions) &&
    Array.isArray(priorChallengeState?.planChallengeState?.decisionEvidence);
  if (reusablePriorState) {
    decisionEvidence.push(
      ...priorChallengeState.planChallengeState.decisionEvidence.map((item) => ({
        ...item,
        trusted: false,
        sourceRefs: [...(item.sourceRefs ?? [])],
        historical: item.kind === "question_response" ? true : item.historical ?? null,
      })),
    );
    const priorQuestions = new Map(
      priorChallengeState.unresolvedQuestions.map((question) => [question.questionId, question]),
    );
    for (const question of questions) {
      const prior = priorQuestions.get(question.questionId);
      if (
        !prior ||
        prior.questionTarget !== question.questionTarget ||
        JSON.stringify(prior.dependsOn ?? []) !== JSON.stringify(question.dependsOn ?? []) ||
        !["answered", "skipped"].includes(prior.status)
      ) continue;
      question.status = prior.status;
      question.userAnswer = prior.userAnswer ?? null;
      question.answerEvidenceRefs = [...(prior.answerEvidenceRefs ?? [])];
    }
  }
  invalidateDerivedQuestions();

  const seenResponseSequences = new Set(
    decisionEvidence
      .filter((item) => item.kind === "question_response" && Number.isInteger(item.sequence))
      .map((item) => item.sequence),
  );
  let currentTurnResponseApplied = false;
  const orderedResponses = (Array.isArray(responses) ? responses : [])
    .filter(
      (response) =>
        response &&
        typeof response === "object" &&
        Number.isInteger(response.sequence) &&
        response.sequence >= 1,
    )
    .sort((left, right) => left.sequence - right.sequence);
  for (const response of orderedResponses) {
    if (seenResponseSequences.has(response.sequence)) continue;
    if (response.historical !== true && currentTurnResponseApplied) continue;
    const selected = selectHighestImpactOpenQuestion(questions);
    if (!selected || String(response.questionId) !== selected.questionId) continue;
    const trustedResponse =
      response.trusted === true &&
      response.binding === `plan-challenge-response:${selected.questionId}` &&
      response.selectionBinding === `plan-challenge-selection:${selected.questionId}` &&
      Array.isArray(response.evidenceRefs) &&
      response.evidenceRefs.length > 0;
    if (!trustedResponse || !PLAN_CHALLENGE_QUESTION_STATUSES.has(response.status)) continue;
    const evidenceRef = addDecisionEvidence({
      kind: "question_response",
      binding: response.binding,
      sourceRefs: response.evidenceRefs,
      sequence: response.sequence,
      historical: response.historical === true,
    });
    if (response.status === "answered" && String(response.userAnswer ?? "").trim()) {
      selected.status = "answered";
      selected.userAnswer = String(response.userAnswer).trim();
      selected.answerEvidenceRefs = [evidenceRef];
    } else if (response.status === "skipped") {
      selected.status = "skipped";
      selected.userAnswer = response.userAnswer == null ? null : String(response.userAnswer);
      selected.answerEvidenceRefs = [evidenceRef];
    } else {
      decisionEvidence.pop();
      continue;
    }
    seenResponseSequences.add(response.sequence);
    if (response.historical !== true) currentTurnResponseApplied = true;
    invalidateDerivedQuestions();
  }

  const parsedControl = !active
    ? null
    : typeof control === "string"
    ? parsePlanChallengeControl(control)
    : control?.trusted === true &&
        control?.binding === "plan-challenge-control" &&
        Array.isArray(control?.evidenceRefs) &&
        control.evidenceRefs.length > 0
      ? control.action
      : parsePlanChallengeControl(task);
  let stopRequested = false;
  let stopReason = null;
  let selectedQuestion = active ? selectHighestImpactOpenQuestion(questions) : null;
  const trustedControlEvidence =
    control?.trusted === true &&
    control?.binding === "plan-challenge-control" &&
    Array.isArray(control?.evidenceRefs) &&
    control.evidenceRefs.length > 0;
  const recordControlQuestionEvidence = (question) => {
    if (!trustedControlEvidence) {
      return ["preDecisionOptionFrame.planChallengeState.controlEvidence"];
    }
    const priorSequences = [...seenResponseSequences];
    const sequence = (priorSequences.length > 0 ? Math.max(...priorSequences) : 0) + 1;
    const evidenceRef = addDecisionEvidence({
      kind: "question_response",
      binding: `plan-challenge-response:${question.questionId}`,
      sourceRefs: control.evidenceRefs,
      sequence,
      historical: false,
    });
    seenResponseSequences.add(sequence);
    return [evidenceRef];
  };
  if (parsedControl === "accept_recommendation" && selectedQuestion) {
    if (selectedQuestion.recommendationState === "recommended" && selectedQuestion.recommendedAnswer) {
      selectedQuestion.status = "answered";
      selectedQuestion.userAnswer = selectedQuestion.recommendedAnswer;
      selectedQuestion.answerEvidenceRefs = recordControlQuestionEvidence(selectedQuestion);
    }
  } else if (parsedControl === "skip" && selectedQuestion) {
    selectedQuestion.status = "skipped";
    selectedQuestion.answerEvidenceRefs = recordControlQuestionEvidence(selectedQuestion);
  } else if (parsedControl === "summarize_stop") {
    stopRequested = true;
    stopReason = "user_requested_summary_stop";
    for (const question of questions) {
      if (question.status !== "open") continue;
      question.status = "invalidated";
      question.invalidatedBy = stopReason;
    }
  }
  invalidateDerivedQuestions();

  selectedQuestion = active && !stopRequested
    ? selectHighestImpactOpenQuestion(questions)
    : null;
  const requiredAuthorizationBinding = planChallengeAuthorizationBinding(signals.sideEffectActions);
  const priorChallenge = reusablePriorState ? priorChallengeState.planChallengeState : null;
  const newUnderstandingProvided =
    sharedUnderstandingConfirmed?.trusted === true &&
    sharedUnderstandingConfirmed?.binding === "plan-challenge-understanding-confirmation" &&
    Array.isArray(sharedUnderstandingConfirmed?.evidenceRefs) &&
    sharedUnderstandingConfirmed.evidenceRefs.length > 0;
  const priorUnderstandingConfirmed =
    priorChallenge?.sharedUnderstandingConfirmed === true &&
    Array.isArray(priorChallenge?.sharedUnderstandingEvidenceRefs) &&
    priorChallenge.sharedUnderstandingEvidenceRefs.length > 0;
  const trustedUnderstanding = newUnderstandingProvided || priorUnderstandingConfirmed;
  const scopeActions = [];
  const authorizationScopeCoversActions = false;
  const authorization = active && authorizationRequired
    ? {
        state: "not_requested",
        source: "host_native_authorization_required",
        scope: scopeActions.join(", ") || "none",
        scopeActions,
        trusted: false,
        binding: requiredAuthorizationBinding,
        evidenceRefs: [],
        scopeCoversActions: authorizationScopeCoversActions,
      }
    : {
        state: "not_required",
        source: active ? "read_only_or_no_side_effect_challenge" : "plan_challenge_inactive",
        scope: "none",
        scopeActions: [],
        trusted: false,
        binding: requiredAuthorizationBinding,
        evidenceRefs: [],
        scopeCoversActions: true,
      };
  const understandingConfirmed = active && trustedUnderstanding;
  const understandingEvidenceRefs = newUnderstandingProvided
    ? [
        addDecisionEvidence({
          kind: "shared_understanding_confirmation",
          binding: "plan-challenge-understanding-confirmation",
          sourceRefs: sharedUnderstandingConfirmed.evidenceRefs,
        }),
      ]
    : priorUnderstandingConfirmed
      ? [...priorChallenge.sharedUnderstandingEvidenceRefs]
      : [];
  const planChallengeSatisfied =
    active && !stopRequested && selectedQuestion == null && understandingConfirmed;
  const phase = stopRequested
    ? "stopped_by_user"
    : !active
    ? "inactive"
    : selectedQuestion
      ? "awaiting_user_answer"
      : !understandingConfirmed
        ? "awaiting_understanding_confirmation"
        : planChallengeSatisfied
          ? "plan_challenge_satisfied"
          : "awaiting_understanding_confirmation";
  const executionAllowed = false;
  const confirmedDecisions = questions
    .filter((question) => question.status === "answered")
    .map((question) => ({
      questionId: question.questionId,
      decision: question.userAnswer,
      evidenceRefs: question.evidenceRefs,
    }));
  const openRisks = questions
    .filter((question) => question.status === "open")
    .map((question) => ({
      questionId: question.questionId,
      risk: question.decisionImpact,
      blockedBy: question.dependsOn.filter(
        (dependencyId) =>
          questions.find((candidate) => candidate.questionId === dependencyId)?.status !== "answered",
      ),
    }));
  if (active && !understandingConfirmed && selectedQuestion == null) {
    openRisks.push({
      questionId: "shared-understanding-confirmation",
      risk: copy.understandingRisk,
      blockedBy: [],
    });
  }
  if (
    active &&
    understandingConfirmed &&
    authorizationRequired &&
    !["authorized", "denied"].includes(authorization.state)
  ) {
    openRisks.push({
      questionId: "execution-authorization",
      risk: copy.authorizationRisk,
      blockedBy: [],
    });
  }
  const nextStep = phase === "inactive"
    ? copy.inactiveNext
    : phase === "awaiting_user_answer"
      ? copy.answerNext(selectedQuestion.question)
      : phase === "awaiting_understanding_confirmation"
        ? copy.understandingNext
        : phase === "plan_challenge_satisfied" && authorizationRequired
          ? copy.authorizationNext
          : phase === "execution_denied"
            ? copy.deniedNext
          : phase === "stopped_by_user"
            ? (zh
                ? "已按用户要求停止继续提问，只保留当前汇总。"
                : locale.startsWith("ja")
                  ? "ユーザーの指示により追加質問を停止し、現在の要約だけを保持します。"
                  : locale.startsWith("ko")
                    ? "사용자 요청에 따라 추가 질문을 중지하고 현재 요약만 유지합니다."
                    : "Stop asking further questions and keep the current summary, as requested by the user.")
            : copy.executeNext;

  const questionControls = locale.startsWith("ja")
    ? [
        { action: "accept_recommendation", label: "推奨案を採用" },
        { action: "skip", label: "この質問をスキップ" },
        { action: "summarize_stop", label: "要約して停止" },
        { action: "continue", label: "質問を続ける" },
      ]
    : locale.startsWith("ko")
      ? [
          { action: "accept_recommendation", label: "권장안 채택" },
          { action: "skip", label: "이 질문 건너뛰기" },
          { action: "summarize_stop", label: "요약하고 중지" },
          { action: "continue", label: "계속 질문" },
        ]
      : zh
        ? [
            { action: "accept_recommendation", label: "按推荐走" },
            { action: "skip", label: "跳过这个问题" },
            { action: "summarize_stop", label: "汇总并停止" },
            { action: "continue", label: "继续问" },
          ]
        : [
            { action: "accept_recommendation", label: "Accept recommendation" },
            { action: "skip", label: "Skip this question" },
            { action: "summarize_stop", label: "Summarize and stop" },
            { action: "continue", label: "Continue questioning" },
          ];
  const pendingDisplayText = phase === "awaiting_user_answer"
    ? selectedQuestion?.question ?? null
    : phase === "awaiting_understanding_confirmation"
      ? copy.understandingNext
      : phase === "awaiting_execution_authorization"
        ? copy.authorizationNext
        : null;
  const pendingUserChoice = {
    status: pendingDisplayText ? "required_not_invoked" : "not_required",
    question: pendingDisplayText
      ? {
          binding: selectedQuestion
            ? `plan-challenge-response:${selectedQuestion.questionId}`
            : phase === "awaiting_execution_authorization"
              ? requiredAuthorizationBinding
              : "plan-challenge-understanding-confirmation",
          displayText: pendingDisplayText,
          recommendation:
            selectedQuestion?.recommendationState === "recommended"
              ? selectedQuestion.recommendedAnswer
              : null,
        }
      : null,
    controls: !pendingDisplayText
      ? []
      : phase === "awaiting_user_answer"
        ? questionControls
        : questionControls.filter((item) => item.action === "summarize_stop"),
  };
  const visibleLines = [
    ...confirmedDecisions.map((decision) =>
      zh
        ? `已确认：${decision.decision}`
        : locale.startsWith("ja")
          ? `確認済み：${decision.decision}`
          : locale.startsWith("ko")
            ? `확정됨: ${decision.decision}`
            : `Confirmed: ${decision.decision}`,
    ),
    ...openRisks.map((risk) =>
      zh
        ? `待处理风险：${risk.risk}`
        : locale.startsWith("ja")
          ? `未解決のリスク：${risk.risk}`
          : locale.startsWith("ko")
            ? `미해결 위험: ${risk.risk}`
            : `Open risk: ${risk.risk}`,
    ),
    nextStep,
  ];

  return {
    unresolvedQuestions: questions,
    planChallengeState: {
      active,
      planChallengeSatisfied,
      authorizationRequired,
      sideEffectActions: signals.sideEffectActions,
      executionAllowed,
      phase,
      triggerReasons: signals.triggerReasons,
      triggerEvidence,
      decisionEvidence,
      triggerEvidenceRefs: triggerEvidence.map(
        (_, index) => `preDecisionOptionFrame.planChallengeState.triggerEvidence[${index}]`,
      ),
      selectedQuestionId: selectedQuestion?.questionId ?? null,
      currentQuestion: selectedQuestion
        ? {
            questionId: selectedQuestion.questionId,
            displayText: selectedQuestion.question,
            recommendationState: selectedQuestion.recommendationState,
            recommendedAnswer: selectedQuestion.recommendedAnswer,
          }
        : null,
      pendingUserChoice,
      stopRequested,
      stopReason,
      controlEvidence: parsedControl
        ? {
            action: parsedControl,
            source: typeof control === "string" ? "explicit_control_text" : "user_request_or_trusted_control",
            trusted: false,
          }
        : null,
      sharedUnderstandingConfirmed: understandingConfirmed,
      sharedUnderstandingEvidenceRefs: understandingEvidenceRefs,
      executionAuthorization: authorization,
      chatSummaryRef: "summaryPacket",
    },
    summaryData: {
      confirmedDecisions,
      openRisks,
      nextStep,
      visibleLines,
    },
  };
}
