import { classifyMetaTheoryEntry } from "../meta-theory-entry-classifier.mjs";

const EXTERNAL_RESEARCH_PATTERN = /third[-\s]?party|external|provider|service|api|sdk|oauth|integration|webhook|latest|current version|授权|接口|外部|第三方|服务商|集成|平台规则|发布|自动发|风控|规则|限流|价格|合规/u;

export const LEGACY_GOVERNANCE_REQUIREMENT_KEYS = Object.freeze([
  "clarification",
  "research",
  "planning",
  "humanDecision",
  "permission",
  "review",
  "metaReview",
  "securityReview",
  "verification",
  "evolution",
]);

function fail(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function plain(value, label) {
  if (!isPlainObject(value)) fail(`${label} must be a plain object.`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || descriptor?.enumerable !== true || !("value" in descriptor)) {
      fail(`${label} must expose enumerable data properties only.`);
    }
  }
  return value;
}

function dataValue(value, key, label, fallback = undefined) {
  const descriptor = Object.getOwnPropertyDescriptor(plain(value, label), key);
  if (descriptor == null) return fallback;
  if (!("value" in descriptor) || descriptor.enumerable !== true) {
    fail(`${label}.${key} must be an enumerable data property.`);
  }
  return descriptor.value;
}

function denseArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) fail(`${label} must be dense.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) fail(`${label}[${index}] must be a data property.`);
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && "value" in descriptor) deepFreeze(descriptor.value);
    }
    Object.freeze(value);
  }
  return value;
}

function normalizedSignals({ task, orchestrationReport, planChallengePreview, requestedSideEffectActions }) {
  if (typeof task !== "string" || !task.trim()) fail("task must be a non-empty string.");
  const report = plain(orchestrationReport, "orchestrationReport");
  const plan = plain(planChallengePreview, "planChallengePreview");
  const workerTaskPackets = denseArray(
    dataValue(report, "workerTaskPackets", "orchestrationReport", []),
    "orchestrationReport.workerTaskPackets",
  );
  const workers = workerTaskPackets.map((packet, index) => plain(packet, `workerTaskPackets[${index}]`));
  const sideEffects = denseArray(
    requestedSideEffectActions ?? [],
    "requestedSideEffectActions",
  );
  if (sideEffects.some((action) => typeof action !== "string" || !action.trim())) {
    fail("requestedSideEffectActions must contain non-empty strings.");
  }
  const classification = classifyMetaTheoryEntry(task);
  const classificationSignals = plain(classification.signals, "entryClassification.signals");
  const challenge = plain(
    dataValue(plan, "planChallengeState", "planChallengePreview", {}),
    "planChallengePreview.planChallengeState",
  );
  const selectedRoute = plain(
    dataValue(report, "selectedExecutionRoute", "orchestrationReport", {}),
    "orchestrationReport.selectedExecutionRoute",
  );
  const entryChoice = plain(
    dataValue(selectedRoute, "entryChoiceDecision", "selectedExecutionRoute", {}),
    "selectedExecutionRoute.entryChoiceDecision",
  );
  const criticalChoice = plain(
    dataValue(entryChoice, "critical", "entryChoiceDecision", {}),
    "entryChoiceDecision.critical",
  );
  const thinkingChoice = plain(
    dataValue(entryChoice, "thinking", "entryChoiceDecision", {}),
    "entryChoiceDecision.thinking",
  );
  const activeDecision =
    dataValue(challenge, "active", "planChallengeState", false) === true ||
    dataValue(criticalChoice, "required", "entryChoiceDecision.critical", false) === true ||
    dataValue(thinkingChoice, "required", "entryChoiceDecision.thinking", false) === true;
  const capabilityNames = workers.flatMap((worker, index) => {
    const requirements = denseArray(
      dataValue(worker, "capabilityRequirements", `workerTaskPackets[${index}]`, []),
      `workerTaskPackets[${index}].capabilityRequirements`,
    );
    return requirements.filter((item) => typeof item === "string").map((item) => item.toLowerCase());
  });
  const externalWrite = workers.some((worker, index) =>
    dataValue(worker, "externalWriteBoundary", `workerTaskPackets[${index}]`, false) === true ||
    dataValue(worker, "executionMode", `workerTaskPackets[${index}]`, "") === "approval_gate",
  );
  const taskLower = task.toLowerCase();
  const migration = /\bmigrat(?:e|ion)\b|迁移/u.test(taskLower);
  const requestedReview = /\b(?:review|audit)\b|审查|审核|复审/u.test(taskLower);
  const durableLearningRequested = /\b(?:evolution|writeback|learn(?:ing)?)\b|沉淀|演化|长期学习|写回/u.test(taskLower);
  const externalResearch = EXTERNAL_RESEARCH_PATTERN.test(taskLower);
  const highRisk = dataValue(classificationSignals, "highRiskTermSignal", "entryClassification.signals", false) === true;
  const destructiveOrProduction =
    dataValue(classificationSignals, "destructiveOrProductionIntent", "entryClassification.signals", false) === true;
  const subjective = dataValue(classificationSignals, "subjectiveQualitySignal", "entryClassification.signals", false) === true;
  const productBuild = dataValue(classificationSignals, "productBuildIntent", "entryClassification.signals", false) === true;
  const parallelism = plain(
    dataValue(classificationSignals, "parallelismHints", "entryClassification.signals", {}),
    "entryClassification.signals.parallelismHints",
  );
  const multiStep = workers.length > 1 ||
    Number(dataValue(parallelism, "delimitedSegmentCount", "parallelismHints", 0)) > 1;
  const externalSideEffect = externalWrite || sideEffects.length > 0 || destructiveOrProduction;
  const materialDimensions = [];
  const dimensionSignals = denseArray(
    dataValue(classificationSignals, "routeChangingDimensionSignals", "entryClassification.signals", []),
    "entryClassification.signals.routeChangingDimensionSignals",
  );
  if (dimensionSignals.includes("quality_or_acceptance")) materialDimensions.push("result");
  if (dimensionSignals.includes("scope")) materialDimensions.push("scope");
  if (dimensionSignals.includes("risk_or_permission") || highRisk) materialDimensions.push("risk");
  if (externalSideEffect && !materialDimensions.includes("permission")) materialDimensions.push("permission");
  const internalImplementationOnly =
    !activeDecision && !subjective && !productBuild && !highRisk && !externalSideEffect && workers.length <= 1;
  return {
    activeDecision,
    capabilityNames,
    classification,
    destructiveOrProduction,
    durableLearningRequested,
    externalResearch,
    externalSideEffect,
    highRisk,
    internalImplementationOnly,
    materialDimensions: [...new Set(materialDimensions)],
    migration,
    multiStep,
    productBuild,
    requestedReview,
    subjective,
    workerCount: workers.length,
  };
}

export function deriveGovernanceTaskFacts(input) {
  const args = plain(input, "input");
  const task = dataValue(args, "task", "input");
  const orchestrationReport = dataValue(args, "orchestrationReport", "input");
  const planChallengePreview = dataValue(args, "planChallengePreview", "input");
  const requestedSideEffectActions = dataValue(args, "requestedSideEffectActions", "input", []);
  const signals = normalizedSignals({ task, orchestrationReport, planChallengePreview, requestedSideEffectActions });
  const crossModule = signals.workerCount > 1;
  const multipleCapabilities = new Set(signals.capabilityNames).size > 1 || signals.workerCount > 1;
  const planningSignal = signals.multiStep || crossModule || signals.migration || signals.externalSideEffect || signals.productBuild || multipleCapabilities;
  const facts = {
    schemaVersion: "governance-task-facts-v1",
    intent: {
      executable: signals.classification.governedEntry === true,
      userRequestedReview: signals.requestedReview,
      durableLearningRequested: signals.durableLearningRequested,
    },
    clarity: {
      blockingUnknowns: signals.subjective ? ["fact:subjective-quality-ambiguous"] : [],
    },
    evidence: {
      currentExternalFactsRequired: signals.externalResearch,
      localEvidenceSufficient: !signals.externalResearch,
      references: [signals.externalResearch ? "evidence:legacy-external-route-signal" : "evidence:legacy-local-route-signal"],
    },
    change: {
      multiStep: signals.multiStep,
      crossModule,
      dataMigration: signals.migration,
      externalSideEffect: signals.externalSideEffect,
      complexArchitectureChange: signals.productBuild,
      multipleCapabilities,
      publicInterfaceChange: false,
      complexBusinessLogic: signals.productBuild,
      dataStructureChange: signals.migration,
      behaviorPreservingInternalOnly: signals.internalImplementationOnly && !planningSignal,
    },
    decision: {
      reasonableOptionCount: signals.activeDecision ? 2 : signals.internalImplementationOnly ? 1 : 0,
      materialDimensions: signals.activeDecision ? signals.materialDimensions : [],
      internalImplementationOnly: signals.internalImplementationOnly,
    },
    security: {
      auth: false,
      permission: signals.highRisk || signals.externalSideEffect,
      credential: false,
      secret: false,
      payment: false,
      production: signals.destructiveOrProduction,
      databaseDestructive: signals.destructiveOrProduction && signals.migration,
      systemConfiguration: signals.destructiveOrProduction && !signals.migration,
      highPrivilegeDependency: false,
      highRiskMcp: false,
    },
    verification: {
      deterministicChecks: signals.classification.governedEntry === true
        ? ["check:legacy-verification-command"]
        : [],
    },
  };
  return deepFreeze(facts);
}

function legacyRequirement(required, sourceRef, reason) {
  return deepFreeze({ required, reason, evidence: [sourceRef] });
}

export function buildLegacyGovernanceRequirementSnapshot(input) {
  const args = plain(input, "input");
  const task = dataValue(args, "task", "input");
  const orchestrationReport = dataValue(args, "orchestrationReport", "input");
  const planChallengePreview = dataValue(args, "planChallengePreview", "input");
  const requestedSideEffectActions = dataValue(args, "requestedSideEffectActions", "input", []);
  const signals = normalizedSignals({ task, orchestrationReport, planChallengePreview, requestedSideEffectActions });
  return deepFreeze({
    schemaVersion: "governance-requirement-legacy-snapshot-v1",
    sourceRef: "legacy:governed-runner-v3",
    gates: {
      clarification: legacyRequirement(signals.subjective, "legacy:entry-classifier-clarification", "Legacy entry classification requires clarification for subjective quality work."),
      research: legacyRequirement(signals.externalResearch, "legacy:fetch-research-route", "Legacy route evidence requires external research only when external capability signals are selected."),
      planning: legacyRequirement(true, "legacy:business-phase-planning", "Legacy governed execution always emits planning artifacts."),
      humanDecision: legacyRequirement(signals.activeDecision, "legacy:plan-challenge-choice", "Legacy plan challenge requires a native human decision only for an active material branch."),
      permission: legacyRequirement(signals.externalSideEffect || signals.highRisk, "legacy:worker-permission-boundary", "Legacy worker and route boundaries require permission for high-risk or external side effects."),
      review: legacyRequirement(true, "legacy:orchestration-review-result", "Legacy governed execution always emits structural review."),
      metaReview: legacyRequirement(true, "legacy:business-phase-meta-review", "Legacy business phases always emit meta-review."),
      securityReview: legacyRequirement(signals.externalSideEffect || signals.highRisk, "legacy:sentinel-security-boundary", "Legacy has no independent security verdict; Sentinel boundary is conservatively mapped for risky work."),
      verification: legacyRequirement(true, "legacy:runtime-verification-result", "Legacy governed execution always emits runtime verification evidence."),
      evolution: legacyRequirement(signals.durableLearningRequested, "legacy:warden-writeback-flow", "Legacy Warden writeback runs only when durable learning is requested."),
    },
  });
}

export function legacyGateFromSnapshot(snapshot) {
  const value = plain(snapshot, "legacySnapshot");
  if (dataValue(value, "schemaVersion", "legacySnapshot") !== "governance-requirement-legacy-snapshot-v1") {
    fail("legacySnapshot.schemaVersion is unsupported.");
  }
  const gates = plain(dataValue(value, "gates", "legacySnapshot"), "legacySnapshot.gates");
  const booleans = {};
  for (const key of LEGACY_GOVERNANCE_REQUIREMENT_KEYS) {
    const record = plain(dataValue(gates, key, "legacySnapshot.gates"), `legacySnapshot.gates.${key}`);
    const required = dataValue(record, "required", `legacySnapshot.gates.${key}`);
    if (typeof required !== "boolean") fail(`legacySnapshot.gates.${key}.required must be boolean.`);
    booleans[key] = required;
  }
  return deepFreeze({
    source: dataValue(value, "sourceRef", "legacySnapshot", "legacy:governed-runner-v3"),
    requirements: booleans,
  });
}
