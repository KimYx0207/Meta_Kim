/**
 * Pure Meta_Kim spine gate and policy helpers.
 *
 * This module intentionally has no filesystem, process, environment, crypto,
 * lifecycle, or status-projection dependencies. `spine-state.mjs` remains the
 * compatibility facade and the sole owner of transactional state authority.
 */

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

export const STAGE_ORDER = deepFreeze([
  "critical",
  "fetch",
  "thinking",
  "execution",
  "review",
  "meta-review",
  "verification",
  "evolution",
]);

export const STAGE_PUBLIC_LABELS = deepFreeze({
  critical: "Critical",
  fetch: "Fetch",
  thinking: "Thinking",
  execution: "Execution",
  review: "Review",
  "meta-review": "Meta-Review",
  verification: "Verification",
  evolution: "Evolution",
});

export const CHOICE_SURFACE_STATES = deepFreeze([
  "not_allowed",
  "critical_clarification_allowed",
  "execution_confirmation_allowed",
  "completed",
]);

const DEFAULT_READ_ONLY_VERIFIER_COMMANDS = deepFreeze([
  "git diff",
  "git diff --stat",
  "git log",
  "git show",
  "git status",
  "git rev-parse",
  "git tag --list",
  "npm run meta:check",
  "npm run meta:check:runtimes",
  "npm run meta:check:sync-coverage",
  "npm run meta:validate",
  "node --check",
  "node --test",
  "gh release view",
  "gh pr view",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
]);

const DEFAULT_FETCH_READ_ONLY_VERIFIER_COMMANDS = deepFreeze([
  "node --test",
  "node scripts/run-node-tests.mjs",
  "npm test",
  "npm run ",
  "pnpm test",
  "pnpm run ",
  "yarn test",
  "yarn ",
]);

const DEFAULT_READ_ONLY_INSPECTION_COMMANDS = deepFreeze([
  "git status",
  "git diff --stat",
  "git diff --check",
  "git diff -- ",
  "git rev-parse",
  "rg ",
  "rg --files",
  "ls",
  "Get-ChildItem",
  "Get-Content",
  "Select-String",
]);

export const STAGE_META_AGENT_MAP = deepFreeze({
  critical: {
    required: [],
    label: "Critical (scope clarification)",
    readOnlyInspectionEnabled: true,
    readOnlyInspectionCommands: DEFAULT_READ_ONLY_INSPECTION_COMMANDS,
  },
  fetch: {
    required: [],
    label: "Fetch (capability discovery)",
    requiresFetchRecordOnCommit: true,
    readOnlyInspectionEnabled: true,
    readOnlyInspectionCommands: DEFAULT_READ_ONLY_INSPECTION_COMMANDS,
    readOnlyVerifierEnabled: true,
    readOnlyVerifierCommands: DEFAULT_FETCH_READ_ONLY_VERIFIER_COMMANDS,
  },
  thinking: {
    required: [],
    label: "Thinking (route and loadout selection)",
    requiresFetchRecordOnCommit: true,
  },
  execution: { required: [], label: "Execution", requiresAgentDispatch: true },
  review: {
    required: [],
    label: "Review (quality forensics)",
    readOnlyVerifierEnabled: true,
    readOnlyVerifierCommands: DEFAULT_READ_ONLY_VERIFIER_COMMANDS,
  },
  "meta-review": {
    required: [],
    label: "Meta-Review (standards check)",
    readOnlyVerifierEnabled: true,
    readOnlyVerifierCommands: DEFAULT_READ_ONLY_VERIFIER_COMMANDS,
  },
  verification: {
    required: [],
    label: "Verification (closure)",
    readOnlyVerifierEnabled: true,
    readOnlyVerifierCommands: DEFAULT_READ_ONLY_VERIFIER_COMMANDS,
  },
  evolution: { required: [], label: "Evolution (writeback)" },
});

const META_AGENT_NAMES = deepFreeze([
  "meta-warden",
  "meta-conductor",
  "meta-genesis",
  "meta-artisan",
  "meta-sentinel",
  "meta-librarian",
  "meta-prism",
  "meta-scout",
]);

const DEGRADED_MIN_AGENT_CHECKS = 3;
const ALLOWED_CHOICE_GATE_SKIPS = new Set([
  "trivial",
  "no_branching_choice",
  "explicit_auto_proceed",
]);

/**
 * Normalize a stage identifier for pure gate evaluation.
 *
 * @param {unknown} stageName
 * @returns {string}
 */
export function normalizeStage(stageName) {
  if (typeof stageName !== "string") return "critical";
  const normalized = stageName.trim().toLowerCase().replace(/_/g, "-");
  return STAGE_ORDER.includes(normalized) ? normalized : "critical";
}

/**
 * Extract the first canonical meta-agent name from a dispatch description.
 *
 * @param {unknown} description
 * @param {unknown} prompt
 * @returns {string|null}
 */
export function extractMetaAgentName(description, prompt) {
  const text = `${description || ""} ${prompt || ""}`.toLowerCase();
  for (const name of META_AGENT_NAMES) {
    if (text.includes(name)) return name;
  }
  return null;
}

/**
 * Return whether a value is one of the private canonical meta-agent names.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isMetaAgentName(value) {
  return META_AGENT_NAMES.includes(value);
}

/**
 * Validate the evidence supporting a degraded-mode declaration.
 *
 * @param {object|null|undefined} state
 * @returns {{valid: boolean, reason: string|null, missing: string[]}}
 */
export function validateDegradedDeclaration(state) {
  const s = state || {};
  if (s.degradedMode !== true) {
    return { valid: true, reason: null, missing: [] };
  }

  const missing = [];
  const fetchRecord = s.fetchRecord;
  if (!fetchRecord || typeof fetchRecord !== "object") {
    missing.push("fetchRecord");
  } else {
    if (fetchRecord.capabilitySearchPerformed !== true) {
      missing.push("fetchRecord.capabilitySearchPerformed=true");
    }
    const matches = Array.isArray(fetchRecord.capabilityMatches)
      ? fetchRecord.capabilityMatches
      : Array.isArray(fetchRecord.matchedCapabilities)
        ? fetchRecord.matchedCapabilities
        : [];
    if (matches.length < DEGRADED_MIN_AGENT_CHECKS) {
      missing.push(
        `fetchRecord.capabilityMatches>=${DEGRADED_MIN_AGENT_CHECKS}`,
      );
    }
  }

  if (missing.length === 0) {
    return { valid: true, reason: null, missing: [] };
  }
  return {
    valid: false,
    reason:
      `Degraded declaration rejected: missing evidence [${missing.join(", ")}]. ` +
      `Per SKILL.md Degraded Mode, declaring degradedMode=true requires a prior ` +
      `capability search with capabilitySearchPerformed=true and at least ` +
      `${DEGRADED_MIN_AGENT_CHECKS} capabilityMatches recorded. ` +
      `Either perform the capability search first or set degradedMode=false.`,
    missing,
  };
}

/**
 * Evaluate the execution-stage fan-out gate.
 *
 * @param {object|null|undefined} state
 * @returns {{triggered: boolean, dispatched: number, workerCount: number,
 * stage: string|null, degraded: boolean, reason: string|null}}
 */
export function evaluateFanoutGate(state) {
  const s = state || {};
  const dispatched = Array.isArray(s.dispatchedAgents)
    ? s.dispatchedAgents.length
    : 0;
  const workerCount = Array.isArray(s.workerTaskPackets)
    ? s.workerTaskPackets.length
    : 0;
  const stage = typeof s.currentStage === "string" ? s.currentStage : null;
  const declaredDegraded = s.degradedMode === true;
  const degradationCheck = declaredDegraded
    ? validateDegradedDeclaration(state)
    : { valid: true, reason: null };
  const degraded = declaredDegraded && degradationCheck.valid;
  const triggered =
    stage === "execution" && dispatched === 0 && workerCount >= 2 && !degraded;
  let reason = null;
  if (triggered) {
    if (declaredDegraded && !degraded) {
      reason =
        `Execution-stage fan-out run has 0 recorded Agent dispatches ` +
        `(dispatched=${dispatched}, workerLanes=${workerCount}, stage=${stage}) ` +
        `and declared degraded but without valid evidence: ` +
        `${degradationCheck.reason} ` +
        `Provide the missing evidence, dispatch an Agent, or clear degradedMode.`;
    } else {
      reason =
        "Execution-stage fan-out run has 0 recorded Agent dispatches " +
        `(dispatched=${dispatched}, workerLanes=${workerCount}, stage=${stage}). ` +
        "Dispatch an Agent (spawn_agent / Agent tool) for the worker lanes, " +
        "or explicitly declare degraded by writing spine state " +
        "`degradedMode: true` (then this run is marked internal-ready, not " +
        "public-ready).";
    }
  }
  return {
    triggered,
    dispatched,
    workerCount,
    stage,
    degraded,
    reason,
  };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function nonEmptyObject(value) {
  return isObject(value) && Object.keys(value).length > 0;
}

function firstString(...values) {
  return values.find((value) => isNonEmptyString(value));
}

function hasSignalValue(value) {
  return isNonEmptyString(value) || hasNonEmptyArray(value);
}

function hasAnySignal(object, keys) {
  if (!isObject(object)) return false;
  return keys.some((key) => hasSignalValue(object[key]));
}

function hasIntentSignal(state) {
  const intentKeys = ["realIntent", "intent", "outcome", "coreProblem"];
  const successKeys = ["successCriteria", "acceptanceCriteria", "qualityBar"];
  const records = [
    state,
    state?.intentPacket,
    state?.intentGatePacket,
    state?.criticalRecord,
  ];
  return records.some(
    (record) =>
      hasAnySignal(record, intentKeys) && hasAnySignal(record, successKeys),
  );
}

function hasThinkingRouteSignal(state) {
  if (nonEmptyObject(state?.dispatchBoard)) return true;
  if (hasNonEmptyArray(state?.workerTaskPackets)) return true;
  if (hasNonEmptyArray(state?.agentBlueprintPacket?.roles)) return true;
  const flow = state?.businessFlowBlueprintPacket;
  if (
    hasNonEmptyArray(flow?.requiredLanes) ||
    hasNonEmptyArray(flow?.optionalLanes)
  ) {
    return true;
  }
  if (nonEmptyObject(state?.ownerDiscoveryPacket)) return true;
  if (nonEmptyObject(state?.routeScoreBreakdown)) return true;
  return false;
}

function hasMemorySignal(state) {
  return !!firstString(
    state?.memoryMode,
    state?.memoryPolicy,
    state?.memoryStrategy,
    state?.memoryPlan,
    state?.dispatchEnvelopePacket?.memoryMode,
    state?.dispatchEnvelopePacket?.memoryPolicy,
    state?.dispatchEnvelopePacket?.memoryStrategy,
    state?.fetchRecord?.memoryMode,
    state?.fetchRecord?.memoryStrategy,
    state?.ownerDiscoveryPacket?.memoryMode,
    state?.ownerDiscoveryPacket?.memoryStrategy,
  );
}

function hasReviewStandardSignal(state) {
  if (
    firstString(
      state?.reviewStandard,
      state?.reviewPlan,
      state?.qualityBar,
      state?.dispatchEnvelopePacket?.reviewStandard,
      state?.dispatchEnvelopePacket?.reviewOwner,
      state?.dispatchBoard?.reviewStandard,
      state?.dispatchBoard?.reviewerAgent,
    )
  ) {
    return true;
  }

  if (hasNonEmptyArray(state?.workerTaskPackets)) {
    return state.workerTaskPackets.some((packet) =>
      firstString(
        packet?.reviewStandard,
        packet?.qualityBar,
        packet?.finalizationGate,
        packet?.handoffTarget,
        packet?.handoffContract?.handoffTo,
      ),
    );
  }

  return false;
}

function supportStatus(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function containsUnsupportedStatus(value) {
  if (typeof value === "string") {
    return /^(known[-_ ]unsupported|unsupported|not_supported|blocked|deny|denied)$/.test(
      supportStatus(value),
    );
  }
  if (Array.isArray(value)) return value.some(containsUnsupportedStatus);
  if (isObject(value)) {
    if (containsUnsupportedStatus(value.status)) return true;
    return Object.values(value).some(containsUnsupportedStatus);
  }
  return false;
}

function hasKnownUnsupportedRuntimeOrOs(state) {
  return [
    state?.runtimeSupport,
    state?.osSupport,
    state?.runtimeSupportStatus,
    state?.osSupportStatus,
    state?.runtimeCompatibility,
    state?.osCompatibility,
    state?.runtimeMatrix,
    state?.osMatrix,
    state?.dispatchEnvelopePacket?.runtimeSupport,
    state?.dispatchEnvelopePacket?.osSupport,
    state?.dispatchBoard?.runtimeSupport,
    state?.dispatchBoard?.osSupport,
    state?.ownerDiscoveryPacket?.runtimeSupport,
    state?.ownerDiscoveryPacket?.osSupport,
  ].some(containsUnsupportedStatus);
}

function hasCapabilityProviderEvidence(state) {
  const fetchRecord = state?.fetchRecord;
  if (
    hasNonEmptyArray(fetchRecord?.capabilityMatches) ||
    hasNonEmptyArray(fetchRecord?.matchedCapabilities) ||
    hasNonEmptyArray(fetchRecord?.providerMatches) ||
    hasNonEmptyArray(fetchRecord?.capabilityProviders)
  ) {
    return true;
  }

  const ownerDiscovery = state?.ownerDiscoveryPacket;
  const providerFields = [
    ownerDiscovery?.candidateReusableCapabilityProviders,
    ownerDiscovery?.reusableCapabilityProviders,
    ownerDiscovery?.capabilityProviders,
    ownerDiscovery?.candidateSkills,
    ownerDiscovery?.candidateCommands,
    ownerDiscovery?.candidateMcpTools,
    ownerDiscovery?.candidateTools,
    ownerDiscovery?.candidatePrompts,
  ];
  if (providerFields.some(hasNonEmptyArray)) return true;

  const laneGroups = [
    state?.businessFlowBlueprintPacket?.requiredLanes,
    state?.businessFlowBlueprintPacket?.optionalLanes,
  ].filter(Array.isArray);
  return laneGroups.some((lanes) =>
    lanes.some((lane) =>
      hasNonEmptyArray(lane?.candidateSkills) ||
      hasNonEmptyArray(lane?.candidateCapabilities) ||
      hasNonEmptyArray(lane?.candidateCommands) ||
      hasNonEmptyArray(lane?.candidateMcpTools) ||
      hasNonEmptyArray(lane?.candidateTools) ||
      hasNonEmptyArray(lane?.candidatePrompts) ||
      hasNonEmptyArray(lane?.candidateOwners),
    ),
  );
}

function hasExecutionOwnerEvidence(state) {
  if (firstString(state?.dispatchBoard?.ownerAgent, state?.dispatchBoard?.owner)) {
    return true;
  }
  if (hasNonEmptyArray(state?.workerTaskPackets)) {
    return state.workerTaskPackets.some((packet) =>
      firstString(packet?.ownerAgent, packet?.owner, packet?.roleDisplayName),
    );
  }
  if (hasNonEmptyArray(state?.agentBlueprintPacket?.roles)) {
    return state.agentBlueprintPacket.roles.some((role) =>
      firstString(role?.ownerAgent, role?.owner, role?.roleDisplayName),
    );
  }
  return !!firstString(
    state?.ownerDiscoveryPacket?.selectedOwner,
    state?.ownerDiscoveryPacket?.ownerAgent,
    state?.selectedOwner,
    state?.ownerAgent,
  );
}

function hasLoadoutEvidence(state) {
  if (hasNonEmptyArray(state?.capabilityBindings)) return true;
  if (
    firstString(
      state?.dispatchBoard?.weapon,
      state?.dispatchBoard?.selectedWeapon,
      state?.selectedWeapon,
      state?.abstractPrompt,
      state?.promptRef,
      state?.dispatchEnvelopePacket?.abstractPrompt,
      state?.dispatchEnvelopePacket?.promptRef,
    )
  ) {
    return true;
  }

  if (hasNonEmptyArray(state?.workerTaskPackets)) {
    return state.workerTaskPackets.some((packet) =>
      hasNonEmptyArray(packet?.capabilityRequirements) ||
      hasNonEmptyArray(packet?.toolRequirements) ||
      hasNonEmptyArray(packet?.skillRequirements) ||
      hasNonEmptyArray(packet?.commandRequirements) ||
      hasNonEmptyArray(packet?.mcpRequirements) ||
      firstString(packet?.abstractPrompt, packet?.promptRef, packet?.weapon),
    );
  }

  if (hasNonEmptyArray(state?.agentBlueprintPacket?.roles)) {
    return state.agentBlueprintPacket.roles.some((role) =>
      hasNonEmptyArray(role?.matchedSkills) ||
      hasNonEmptyArray(role?.matchedCapabilities) ||
      hasNonEmptyArray(role?.capabilityBindings) ||
      firstString(role?.abstractPrompt, role?.promptRef, role?.weapon),
    );
  }

  return false;
}

function hasFetchEvidence(state) {
  return !!(
    state?.fetchRecord ||
    state?.fetchPacket ||
    state?.contentEvidencePacket ||
    state?.capabilityEvidencePacket
  );
}

function collectPreExecutionReadinessGaps(state) {
  const missing = [];

  if (!hasIntentSignal(state)) {
    missing.push("intent signal (intentPacket or realIntent + successCriteria)");
  }
  if (!hasFetchEvidence(state)) {
    missing.push("Fetch evidence");
  }
  if (!hasThinkingRouteSignal(state)) {
    missing.push("Thinking route plan");
  }
  if (!hasMemorySignal(state)) {
    missing.push("memory strategy");
  }
  if (!hasReviewStandardSignal(state)) {
    missing.push("Review standard");
  }

  return missing;
}

/**
 * Check minimum pre-execution evidence without consulting external state.
 *
 * @param {object|null|undefined} state
 * @returns {{met: boolean, missing: string[], reason: string}}
 */
export function checkPreExecutionReadiness(state) {
  if (!state || state.queryBypass) {
    return {
      met: true,
      missing: [],
      reason: "pre-execution readiness gate bypassed",
    };
  }

  const missing = collectPreExecutionReadinessGaps(state);
  return {
    met: missing.length === 0,
    missing,
    reason:
      missing.length === 0
        ? "minimum key-behavior pre-execution evidence is present"
        : "Pre-execution readiness requires the key behavior evidence only: intent, Fetch evidence, Thinking route/loadout, and memory strategy. Optional packet fields belong to validators, not hook blocking.",
  };
}

function collectCapabilityNodeBindingGaps(state) {
  const missing = [];

  const fetchRecord = state?.fetchRecord;
  if (!isObject(fetchRecord)) {
    missing.push("fetchRecord");
  } else if (fetchRecord.capabilitySearchPerformed !== true) {
    missing.push("fetchRecord.capabilitySearchPerformed=true");
  }

  if (!hasCapabilityProviderEvidence(state)) {
    missing.push(
      "capability provider evidence (agent, skill, command, MCP, tool, or prompt)",
    );
  }
  if (!hasExecutionOwnerEvidence(state)) {
    missing.push("execution owner");
  }
  if (!hasLoadoutEvidence(state)) {
    missing.push("owner loadout (skill, command, MCP, tool, or abstract prompt)");
  }
  if (!hasMemorySignal(state)) {
    missing.push("memory strategy");
  }
  if (!hasReviewStandardSignal(state)) {
    missing.push("Review standard");
  }
  if (hasKnownUnsupportedRuntimeOrOs(state)) {
    missing.push("runtime/OS support not known-unsupported");
  }

  return missing;
}

/**
 * Check execution owner and capability bindings.
 *
 * @param {object|null|undefined} state
 * @returns {{met: boolean, missing: string[], reason: string}}
 */
export function checkCapabilityNodeBindings(state) {
  if (!state || state.queryBypass) {
    return {
      met: true,
      missing: [],
      reason: "capability node binding gate bypassed",
    };
  }

  const missing = collectCapabilityNodeBindingGaps(state);
  return {
    met: missing.length === 0,
    missing,
    reason:
      missing.length === 0
        ? "minimum capability owner/loadout bindings present"
        : "Execution requires key capability evidence only: capability search, selected owner, usable loadout across skill/command/MCP/tool/prompt, and memory strategy. Exhaustive per-field work-order validation belongs to validators.",
  };
}

function normalizeChoiceSurfaceState(value) {
  return CHOICE_SURFACE_STATES.includes(value) ? value : "not_allowed";
}

function hasCandidateOptions(frame) {
  if (!frame || typeof frame !== "object") return false;
  const optionFields = [
    frame.candidatePaths,
    frame.solutionPaths,
    frame.options,
    frame.candidates,
    frame.cards,
  ];
  return optionFields.some((value) => Array.isArray(value) && value.length > 0);
}

function getPreDecisionOptionFrame(state) {
  return (
    state?.preDecisionOptionFrame ||
    state?.cardPlanPacket ||
    state?.businessFlowBlueprintPacket ||
    null
  );
}

function hasChoiceGateSkip(state) {
  const frame = getPreDecisionOptionFrame(state);
  const skip =
    state?.choiceGateSkip ||
    frame?.choiceGateSkip ||
    state?.intentGatePacket?.choiceGateSkip;
  if (!ALLOWED_CHOICE_GATE_SKIPS.has(skip)) return false;
  const skipSource = state?.skipSource || frame?.skipSource;
  const skipSafetyRationale =
    state?.skipSafetyRationale || frame?.skipSafetyRationale;
  return (
    typeof skipSource === "string" &&
    skipSource.trim().length > 0 &&
    typeof skipSafetyRationale === "string" &&
    skipSafetyRationale.trim().length > 0 &&
    !/fallback/i.test(skipSafetyRationale)
  );
}

/**
 * Check native choice-surface ordering and completion evidence.
 *
 * @param {object|null|undefined} state
 * @returns {{met: boolean, missing: string[], reason: string}}
 */
export function checkChoiceSurfaceGate(state) {
  if (!state || state.queryBypass) {
    return { met: true, missing: [], reason: "choice surface gate bypassed" };
  }

  const stage = normalizeStage(state.currentStage);
  const stageIdx = STAGE_ORDER.indexOf(stage);
  const thinkingIdx = STAGE_ORDER.indexOf("thinking");
  const executionIdx = STAGE_ORDER.indexOf("execution");
  const choiceState = normalizeChoiceSurfaceState(state.choiceSurfaceState);
  const fetchEvidencePresent = hasFetchEvidence(state);
  const preDecisionFrame = getPreDecisionOptionFrame(state);
  const candidateOptionsPresent = hasCandidateOptions(preDecisionFrame);
  const skipRecorded = hasChoiceGateSkip(state);
  const decisionBasisPresent =
    fetchEvidencePresent && (candidateOptionsPresent || skipRecorded);

  if (
    stageIdx < thinkingIdx &&
    (choiceState === "execution_confirmation_allowed" ||
      choiceState === "completed")
  ) {
    return {
      met: false,
      missing: ["Fetch evidence", "Thinking candidate options"],
      reason:
        "Choice Surface Gate violation: execution confirmation appeared before Fetch and Thinking completed.",
    };
  }

  if (
    stage === "thinking" &&
    (choiceState === "execution_confirmation_allowed" ||
      choiceState === "completed") &&
    !decisionBasisPresent
  ) {
    return {
      met: false,
      missing: ["Fetch evidence", "preDecisionOptionFrame"],
      reason:
        "Choice Surface Gate violation: execution confirmation requires Fetch evidence and a Thinking option frame.",
    };
  }

  if (stageIdx >= executionIdx) {
    if (!decisionBasisPresent) {
      return {
        met: false,
        missing: ["Fetch evidence", "preDecisionOptionFrame"],
        reason:
          "Execution cannot start before Fetch evidence and Thinking candidate options are recorded.",
      };
    }

    if (choiceState !== "completed" && !skipRecorded) {
      return {
        met: false,
        missing: ["choiceSurfaceState=completed"],
        reason:
          "Execution cannot start before execution confirmation is completed or an explicit choiceGateSkip is recorded.",
      };
    }
  }

  return { met: true, missing: [], reason: "choice surface gate met" };
}

/**
 * Check the current stage's pure governance requirements.
 *
 * @param {object} state
 * @returns {{met: boolean, missing: string[], reason: string}}
 */
export function checkStageRequirements(state) {
  const stage = state.currentStage;
  const req = STAGE_META_AGENT_MAP[stage];
  if (!req) return { met: true, missing: [], reason: "no requirements" };

  const chain = state.dispatchChain || {};
  const dispatched = chain[stage] || [];
  const missing = req.required.filter((agent) => !dispatched.includes(agent));

  if (req.requiresAgentDispatch && state.dispatchedAgents.length === 0) {
    const nodeBindingGate = checkCapabilityNodeBindings(state);
    if (!nodeBindingGate.met) {
      return nodeBindingGate;
    }
  }

  if (
    req.requiresFetchRecordOnCommit &&
    !state.fetchRecord &&
    state.stageTransitionIntent === "commit"
  ) {
    return {
      met: false,
      missing: ["fetchRecord in spine state"],
      reason:
        "Stage commit requires a fetchRecord before advancing. " +
        "During Fetch, read/search/capability-scan/state-write actions remain allowed; complete capability search, write fetchRecord to spine state, then commit the stage.",
    };
  }

  if (
    state.fetchRecord &&
    state.fetchRecord.researchRequired &&
    !state.fetchRecord.researchValidationPerformed
  ) {
    return {
      met: false,
      missing: ["research validation in fetchRecord"],
      reason:
        "Task requires research validation but researchValidationPerformed=false. " +
        "Discover web search tools via capability descriptors, search ≥5 source categories, " +
        "record in fetchRecord, then return to Thinking.",
    };
  }

  const choiceSurfaceGate = checkChoiceSurfaceGate(state);
  if (!choiceSurfaceGate.met) {
    return choiceSurfaceGate;
  }

  if (STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf("execution")) {
    const readinessGate = checkPreExecutionReadiness(state);
    if (!readinessGate.met) {
      return readinessGate;
    }

    const nodeBindingGate = checkCapabilityNodeBindings(state);
    if (!nodeBindingGate.met) {
      return nodeBindingGate;
    }
  }

  return {
    met: missing.length === 0,
    missing,
    reason:
      missing.length > 0
        ? `Stage "${stage}" requires stage owner record(s): ${missing.join(", ")}. Record the missing stage evidence before advancing.`
        : "requirements met",
  };
}

/** @param {unknown} toolName */
export function isExecutionTool(toolName) {
  const execTools = [
    "Write",
    "Edit",
    "Bash",
    "MultiEdit",
    "NotebookEdit",
    "apply_patch",
  ];
  return execTools.includes(toolName);
}

/** @param {unknown} toolName */
export function isReadOnlyTool(toolName) {
  const readOnlyTools = [
    "Read",
    "Glob",
    "Grep",
    "LSPO",
    "TaskList",
    "TaskGet",
    "TaskOutput",
    "WebFetch",
    "WebSearch",
    "ListMcpResourcesTool",
    "ReadMcpResourceTool",
  ];
  return readOnlyTools.includes(toolName);
}

/**
 * Map a task classification to the hook governance flow.
 *
 * @param {object|null|undefined} state
 * @returns {string}
 */
export function getGovernanceFlow(state) {
  const flowMap = {
    query: "query",
    simple_exec: "simple_exec",
    complex_dev: "complex_dev",
    meta_theory_auto: "complex_dev",
  };
  return flowMap[state?.taskClassification] || "simple_exec";
}
