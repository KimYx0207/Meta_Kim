import { createHash } from "node:crypto";

// The policy is durable; the requested outcome and its criteria belong to one run.
export const FRAMEWORK_GOAL_POLICY = "Understand the user's outcome, compare evidence-backed routes, discover or create missing capabilities, orchestrate within dependencies and permissions, and verify the resulting deliverable. Governance structure is not proof of task success or global optimality.";

export const OUTCOME_METHOD_SOURCES = Object.freeze([
  "promptfoo-declarative-evaluation",
  "skillevaluator-evidence-tiers",
  "tau-bench-outcome-equivalence",
  "markitdown-material-provenance",
  "p-queue-invocation-pacing",
]);

export function taskOutcomeDigest(task) {
  if (typeof task !== "string" || !task.trim()) throw new TypeError("A non-empty user task is required");
  return createHash("sha256").update(task.trim(), "utf8").digest("hex");
}

function normalizeCriteria(criteria, task) {
  if (!Array.isArray(criteria)) throw new TypeError("acceptanceCriteria must be an array");
  const declared = criteria.length ? criteria : [{
    id: "user-outcome", description: task, kind: "semantic", required: true,
  }];
  const ids = new Set();
  const normalized = declared.map((criterion) => {
    if (!criterion || typeof criterion !== "object" || Array.isArray(criterion) ||
        typeof criterion.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(criterion.id) ||
        ids.has(criterion.id) || typeof criterion.description !== "string" || !criterion.description.trim() ||
        !["deterministic", "semantic"].includes(criterion.kind) ||
        (criterion.required !== undefined && typeof criterion.required !== "boolean")) {
      throw new TypeError("Criteria require unique ids, descriptions, a known kind and a boolean required flag");
    }
    ids.add(criterion.id);
    return {
      id: criterion.id, description: criterion.description.trim(), kind: criterion.kind,
      required: criterion.required !== false,
    };
  });
  if (!normalized.some((criterion) => criterion.required)) throw new TypeError("At least one required outcome criterion is needed");
  return normalized;
}

function criteriaDigest(criteria) {
  return createHash("sha256").update(JSON.stringify(criteria), "utf8").digest("hex");
}

export function buildTaskGoalContract({ task, acceptanceCriteria = [], outputLanguage = "en" }) {
  const taskHash = taskOutcomeDigest(task);
  const outcome = task.trim();
  const criteria = normalizeCriteria(acceptanceCriteria, outcome);
  const zh = /^zh/iu.test(outputLanguage);
  const text = zh ? {
    verification: "验证：逐条核对本次目标和验收条件，保存与本次任务绑定的检查、人工或模型评审证据。",
    constraints: "约束：遵守用户给定的范围、权限、预算、依赖与可逆性要求；能力可用性按证据记录。",
    boundaries: "边界：治理方法适用于多领域；行业角色、Skill、工具和 MCP 均经能力发现后按需选用。",
    iteration: "迭代策略：新证据改变目标时回到 Critical，改变路线时回到 Thinking；相同失败重复时复查设计。",
    completion: "完成条件：实际交付满足全部必需验收项；流程完成、文件存在、结构合格或能力选中均不能替代结果。",
    pause: "暂停条件：目标存在实质分歧、证据或能力缺失，或必要动作超出已获授权时，说明缺口和下一步。",
  } : {
    verification: "Verification: assess each task-specific criterion and retain evidence bound to this request.",
    constraints: "Constraints: respect the user's scope, permissions, budget, dependencies and reversibility requirements.",
    boundaries: "Boundaries: discover suitable agents, skills, tools and MCP capabilities across domains before binding them.",
    iteration: "Iteration: return to Critical when new evidence changes the goal, and Thinking when it changes the route; re-examine design after repeated failure.",
    completion: "Completion: the actual deliverable satisfies every required criterion; workflow, schema and selection success are insufficient.",
    pause: "Pause: explain material ambiguity, missing evidence or capability, or a necessary action beyond the existing authorization.",
  };
  return {
    schemaVersion: "goal-contract-v0.1",
    status: "pass",
    evidenceKind: "goal_contract_ready",
    evidenceBoundary: "request_binding_and_acceptance_definition_only",
    scope: "run_scoped",
    source: "user_request",
    sourceMethodRefs: [
      "joeseesun/qiaomu-goal-meta-skill/SKILL.md",
      "joeseesun/qiaomu-goal-meta-skill/references/default-goal-strategy.md",
      "config/governance/decision-pattern-catalog.json", ...OUTCOME_METHOD_SOURCES,
    ],
    taskHash,
    acceptanceDigest: criteriaDigest(criteria),
    frameworkPolicyText: FRAMEWORK_GOAL_POLICY,
    commandPrefix: "/goal",
    recommendedGoalText: [`/goal ${outcome}`, ...Object.values(text)].join("\n"),
    acceptanceCriteria: criteria,
    acceptanceSource: acceptanceCriteria.length ? "explicit_task_criteria" : "user_request_requires_task_specific_review",
    contractFields: {
      outcome,
      verification: criteria.map((criterion) => `${criterion.id}: ${criterion.kind} evidence for ${criterion.description}`),
      constraints: ["user scope and authorization", "no capability or outcome overclaim", "preserve evidence and rollback boundaries"],
      boundaries: ["current user request", "discovered capabilities", "existing runtime and scheduler authority"],
      iterationPolicy: text.iteration,
      completionEvidence: criteria.filter((criterion) => criterion.required).map((criterion) => `${criterion.id}: task-bound outcome evidence`),
      stopWhen: text.completion,
      pauseIf: text.pause,
    },
    evaluationPlan: {
      status: "planned_not_evaluated",
      levels: ["structure", "routing_and_boundary", "task_outcome"],
      assertionPolicy: "All required criteria gate acceptance; advisory scores cannot compensate for a required failure.",
      routingCoverage: ["explicit", "implicit", "contextual", "negative"],
      outcomePolicy: "Equivalent valid outcomes may use different tool sequences; enforce an exact action only when the task contract requires it.",
      modelJudgePolicy: "Model judgments are advisory until independently reviewed; record missing evidence instead of inventing a score.",
      materialPolicy: "Discover a suitable converter when source material requires it; preserve original source, extraction limitations and numeric context. Converted Markdown is not verified evidence by itself.",
      pacingPolicy: "Reuse the existing scheduler; distinguish concurrency from start-rate limits, honor user serial execution, and do not equate timeout with cancellation or automatically retry external effects.",
      claimBoundary: "Offline cases, supplied observations and cached results do not prove native invocation, live task success or global optimality.",
    },
    lint: {
      status: "pass", requiredMarkersPresent: ["/goal", ...Object.keys(text)],
      noPlaceholders: true, concreteVerificationEvidenceNamed: true,
      boundedAutonomy: true, highRiskPausePresent: true,
    },
  };
}

export function evaluateTaskOutcome(goalContract, observations = []) {
  const taskHash = taskOutcomeDigest(goalContract?.contractFields?.outcome);
  if (goalContract?.source !== "user_request" || goalContract?.scope !== "run_scoped" || goalContract.taskHash !== taskHash) {
    throw new TypeError("Outcome evaluation requires a goal bound to the current user request");
  }
  if (!Array.isArray(observations)) throw new TypeError("observations must be an array");
  if (!Array.isArray(goalContract.acceptanceCriteria) || !goalContract.acceptanceCriteria.length) {
    throw new TypeError("Outcome evaluation requires the original acceptance criteria");
  }
  const criteria = normalizeCriteria(goalContract.acceptanceCriteria, goalContract.contractFields.outcome);
  const acceptanceDigest = criteriaDigest(criteria);
  if (goalContract.acceptanceDigest !== acceptanceDigest) throw new TypeError("Acceptance criteria binding mismatch");
  const knownIds = new Set(criteria.map((criterion) => criterion.id));
  const errors = [];
  for (const observation of observations) {
    if (!observation || typeof observation !== "object" || Array.isArray(observation) || !knownIds.has(observation.criterionId)) {
      errors.push("unknown_or_invalid_criterion_observation");
    }
  }
  const results = criteria.map((criterion) => {
    const matches = observations.filter((observation) => observation?.criterionId === criterion.id);
    const observation = matches[0];
    const base = { criterionId: criterion.id, required: criterion.required, kind: criterion.kind };
    if (matches.length === 0) return { ...base, status: "missing", reason: "no_outcome_evidence" };
    if (matches.length > 1) return { ...base, status: "invalid", reason: "ambiguous_duplicate_observations" };
    if (observation.taskHash !== taskHash) return { ...base, status: "invalid", reason: "task_binding_mismatch" };
    if (observation.acceptanceDigest !== acceptanceDigest) return { ...base, status: "invalid", reason: "acceptance_binding_mismatch" };
    if (!["pass", "fail", "inconclusive"].includes(observation.verdict)) return { ...base, status: "invalid", reason: "unknown_verdict" };
    const allowed = criterion.kind === "deterministic"
      ? ["deterministic_check", "human_review", "independent_review"]
      : ["human_review", "independent_review"];
    if (!allowed.includes(observation.evidenceKind)) {
      return { ...base, status: "inconclusive", reason: "evidence_kind_does_not_establish_outcome" };
    }
    if (typeof observation.evidenceRef !== "string" || !observation.evidenceRef.trim()) {
      return { ...base, status: "missing", reason: "evidence_reference_missing" };
    }
    if (["human_review", "independent_review"].includes(observation.evidenceKind) && (typeof observation.reviewer !== "string" || !observation.reviewer.trim())) {
      return { ...base, status: "missing", reason: "review_owner_missing" };
    }
    if (observation.evidenceKind === "independent_review" &&
        (typeof observation.producer !== "string" || !observation.producer.trim() || observation.producer.trim() === observation.reviewer.trim())) {
      return { ...base, status: "inconclusive", reason: "independent_review_not_established" };
    }
    return { ...base, status: observation.verdict, evidenceRef: observation.evidenceRef, reason: "reported_task_bound_assessment" };
  });
  const required = results.filter((result) => result.required);
  const status = errors.length || results.some((result) => result.status === "invalid") || required.some((result) => result.status === "fail")
    ? "fail"
    : required.every((result) => result.status === "pass") ? "pass" : "incomplete";
  return {
    schemaVersion: "task-outcome-evaluation-v0.1", taskHash, acceptanceDigest, status,
    evidenceKind: "reported_criterion_assessment", results, errors,
    requiredPassed: required.filter((result) => result.status === "pass").length,
    requiredCount: required.length,
    observationCount: observations.length,
    claimBoundary: "Validates supplied criterion assessments; it does not authenticate their source or prove live execution, user acceptance or global optimality.",
    executionVerified: false, nativeInvocationVerified: false, publicReady: false,
  };
}
