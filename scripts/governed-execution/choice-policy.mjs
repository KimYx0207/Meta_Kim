import materialPolicy from "../../config/governance/material-decision-policy.json" with { type: "json" };
const internalOnlyDimensions = new Set(materialPolicy.internalOnlyDimensions);

const RUNTIME_ALIASES = Object.freeze({
  claude: "claude_code",
  claude_code: "claude_code",
  codex: "codex",
  cursor: "cursor",
  openclaw: "openclaw",
});

const DIMENSION_POLICY_MATCHERS = Object.freeze({
  scope: /scope/iu,
  risk_or_cost: /risk|cost|permission/iu,
  owner: /owner/iu,
  runtime_or_os: /runtime|\bos\b/iu,
  dependency: /dependency/iu,
  acceptance: /acceptance|public-ready/iu,
  read_only_branch: /read-only/iu,
});

function normalizeDimension(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (/risk|cost|permission/iu.test(normalized)) return "risk_or_cost";
  if (/runtime|\bos\b/iu.test(normalized)) return "runtime_or_os";
  if (/dependency/iu.test(normalized)) return "dependency";
  if (/owner/iu.test(normalized)) return "owner";
  if (/acceptance|quality|public.ready/iu.test(normalized)) return "acceptance";
  if (/read.only/iu.test(normalized)) return "read_only_branch";
  if (/scope/iu.test(normalized)) return "scope";
  return normalized.replace(/[^a-z0-9]+/gu, "_");
}
function policyDimensions(policy) {
  const rules = Array.isArray(policy?.choiceRequiredWhen)
    ? policy.choiceRequiredWhen.map((rule) => String(rule))
    : [];
  return Object.entries(DIMENSION_POLICY_MATCHERS)
    .filter(([, matcher]) => rules.some((rule) => matcher.test(rule)))
    .map(([dimension]) => dimension);
}

export function resolveNativeChoiceSurface(policy, runtime) {
  const runtimeKey = RUNTIME_ALIASES[String(runtime ?? "").toLowerCase()] ?? String(runtime ?? "");
  const surfaces = policy?.platformChoiceSurfaces?.[runtimeKey];
  const primary = Array.isArray(surfaces)
    ? surfaces.find((item) => item?.support === "native") ?? surfaces[0]
    : null;
  return {
    runtime: runtimeKey,
    surface: primary?.surface ?? null,
    support: primary?.support ?? "unavailable",
    source: `config/governance/choice-surface-policy.json#platformChoiceSurfaces.${runtimeKey}`,
  };
}

export function evaluateChoiceRequirement(policy, {
  runtime,
  stage,
  routeChangingDimensions = [],
  materialBranch = false,
  decisionCardOptionCount = 0,
  highRiskOperation = false,
  destructiveOrProductionOperation = false,
} = {}) {
  const enabledDimensions = policyDimensions(policy);
  const normalizedDimensions = [...new Set(
    routeChangingDimensions.map(normalizeDimension).filter(Boolean),
  )];
  const matchedDimensions = normalizedDimensions.filter((dimension) =>
    !internalOnlyDimensions.has(dimension) && enabledDimensions.includes(dimension),
  );
  const forceRiskChoice =
    (highRiskOperation || destructiveOrProductionOperation) &&
    enabledDimensions.includes("risk_or_cost");
  const hasDecisionCardBranch = Number(decisionCardOptionCount) >= 2;
  const branchChangingChoice =
    (materialBranch || hasDecisionCardBranch) && matchedDimensions.length > 0;
  const required = forceRiskChoice || branchChangingChoice;
  const nativeSurface = resolveNativeChoiceSurface(policy, runtime);

  return {
    schemaVersion: "choice-requirement-v1",
    policySource: "config/governance/choice-surface-policy.json",
    lifecycleOwner: "meta-conductor/spine",
    stage: stage ?? null,
    required,
    choicePolicy: required ? "must_ask" : "no_choice_needed",
    reason: forceRiskChoice
      ? "high_risk_or_destructive_operation"
      : branchChangingChoice
        ? hasDecisionCardBranch
          ? "decision_card_has_material_route_branches"
          : "material_route_branch"
        : "no_material_branch_requiring_user_choice",
    routeChangingDimensions: normalizedDimensions,
    matchedPolicyDimensions: matchedDimensions,
    decisionCardOptionCount: Number(decisionCardOptionCount) || 0,
    nativeSurface,
  };
}
