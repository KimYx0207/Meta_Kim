import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  canonicalAgentsDir,
  canonicalCapabilityIndexDir,
  canonicalSkillsDir,
  canonicalSkillPath,
  canonicalSkillReferencesDir,
  loadRuntimeProfiles,
  loadSyncManifest,
} from "./meta-kim-sync-config.mjs";
import { t } from "./meta-kim-i18n.mjs";
import { validateSkillFrontmatter } from "./install-skill-sanitizer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const CANONICAL_CAPABILITY_INDEX_RELATIVE =
  "config/capability-index/meta-kim-capabilities.json";
const LOCAL_GLOBAL_CAPABILITY_INVENTORY_PATTERN =
  ".meta-kim/state/{profile}/capability-index/global-capabilities.json";

const forbiddenRuntimeMarkers = [
  "AskUserQuestion",
  'Agent(subagent_type="',
  "Skill(skill=",
  "meta-factory.mjs",
  "evolution-analyzer.mjs",
  "keyword-optimizer.mjs",
  "run_loop.py",
];

const EXPECTED_AGENT_WEAPON_MARKERS = {
  "meta-warden": [
    "## Required Deliverables",
    "Participation Summary",
    "Gate Decisions",
    "Escalation Decisions",
    "Final Synthesis",
    "Governed run artifact",
  ],
  "meta-conductor": [
    "## Required Deliverables",
    "Dispatch Board",
    "Card Deck",
    "Worker Task Board",
    "Handoff Plan",
    "Governed run artifact pointer",
  ],
  "meta-genesis": [
    "## Required Deliverables",
    "SOUL.md Draft",
    "Boundary Definition",
    "Reasoning Rules",
    "Stress-Test Record",
  ],
  "meta-artisan": [
    "## Required Deliverables",
    "Skill Loadout",
    "MCP / Tool Loadout",
    "Runtime Compatibility Plan",
    "Capability Gap List",
    "Adoption Notes",
  ],
  "meta-sentinel": [
    "## Required Deliverables",
    "Threat Model",
    "Permission Matrix",
    "Hook Configuration",
    "Rollback Rules",
  ],
  "meta-librarian": [
    "## Required Deliverables",
    "Memory Architecture",
    "Continuity Protocol",
    "Retention Policy",
    "Recovery Evidence",
  ],
  "meta-prism": [
    "## Required Deliverables",
    "Assertion Report",
    "Verification Closure Packet",
    "Drift Findings",
    "Closure Conditions",
  ],
  "meta-scout": [
    "## Required Deliverables",
    "Capability Baseline",
    "Candidate Comparison",
    "Security Notes",
    "Adoption Brief",
  ],
};

function assert(condition, message) {
  if (!condition) {
    // Human-friendly: strip dev-path jargon from messages
    const clean = message
      .replace(/\.claude\/agents\//g, "Claude agent ")
      .replace(/\.claude\/skills\//g, "Claude skill ")
      .replace(/\.codex\/agents\//g, "Codex agent ")
      .replace(/\.codex\/skills\//g, "Codex skill ")
      .replace(/\.agents\/skills\//g, "Codex项目skill ")
      .replace(/openclaw\/workspaces\//g, "OpenClaw workspace ")
      .replace(/openclaw\/skills\//g, "OpenClaw skill ")
      .replace(/\.md /g, ".md ")
      .replace(/\.toml /g, ".toml ");
    throw new Error(clean);
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function countFiles(rootDir, extension) {
  let count = 0;
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      count += await countFiles(entryPath, extension);
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      count += 1;
    }
  }
  return count;
}

async function walkFiles(rootDir, extension, bucket = []) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(entryPath, extension, bucket);
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      bucket.push(entryPath);
    }
  }
  return bucket;
}

function toRepoRelative(filePath) {
  return path.relative(repoRoot, filePath).replace(/\\/g, "/");
}

async function listCanonicalSkillReferences() {
  const entries = await fs.readdir(canonicalSkillReferencesDir, {
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

async function listCanonicalSkillManifests() {
  const entries = await fs.readdir(canonicalSkillsDir, { withFileTypes: true });
  const manifests = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillPath = path.join(canonicalSkillsDir, entry.name, "SKILL.md");
    if (await exists(skillPath)) {
      manifests.push({
        id: entry.name,
        path: toRepoRelative(skillPath),
      });
    }
  }
  return manifests.sort((left, right) => left.id.localeCompare(right.id));
}

function assertNoForbiddenMarkers(
  raw,
  filePath,
  markers = forbiddenRuntimeMarkers,
) {
  for (const marker of markers) {
    assert(
      !raw.includes(marker),
      `${filePath} still contains forbidden marker: ${marker}`,
    );
  }
}

/**
 * Skill files may contain `Skill(skill=` in the Dependency Resources section —
 * those are documented invocation examples, not forbidden runtime tool calls.
 * This function strips the Dependency Resources section before checking.
 */
function assertNoForbiddenMarkersInSkill(
  raw,
  filePath,
  markers = forbiddenRuntimeMarkers,
) {
  // Extract everything before ## Dependency Resources (case-insensitive)
  const depResMatch = raw.match(/\n## Dependency Resources\b/i);
  const contentBeforeDepRes = depResMatch
    ? raw.substring(0, depResMatch.index)
    : raw;

  // Also extract Dependency Skills section (new name in v1.4.0)
  const depSkillsMatch = raw.match(/\n## Dependency Skills\b/i);
  const contentBeforeDepSkills = depSkillsMatch
    ? raw.substring(0, depSkillsMatch.index)
    : contentBeforeDepRes;

  for (const marker of markers) {
    // Check body before the Dependency Resources/Skills section
    assert(
      !contentBeforeDepSkills.includes(marker),
      `${filePath} still contains forbidden marker: ${marker} (outside Dependency Resources section)`,
    );
  }
}

function parseFrontmatter(raw, filePath) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`${filePath} is missing YAML frontmatter.`);
  }

  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      throw new Error(`${filePath} has an invalid frontmatter line: ${line}`);
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    data[key] = value.replace(/^['"]|['"]$/g, "");
  }

  return data;
}

async function validateRequiredFiles() {
  const requiredFiles = [
    "README.md",
    "README.zh-CN.md",
    "CLAUDE.md",
    "AGENTS.md",
    "LICENSE",
    ".gitignore",
    "config/sync.json",
    "canonical/agents/meta-warden.md",
    "canonical/skills/meta-theory/SKILL.md",
    "canonical/runtime-assets/claude/settings.json",
    "canonical/runtime-assets/claude/mcp.json",
    "canonical/runtime-assets/codex/config.toml.example",
    "canonical/runtime-assets/openclaw/openclaw.template.json",
    "config/contracts/sync-manifest.schema.json",
    "config/contracts/runtime-profile.schema.json",
    "config/contracts/runtime-compatibility-catalog.schema.json",
    "config/contracts/core-loop-contract.json",
    "config/runtime-compatibility-catalog.json",
    "config/contracts/workflow-contract.json",
    CANONICAL_CAPABILITY_INDEX_RELATIVE,
    "scripts/mcp/meta-runtime-server.mjs",
  ];

  for (const relativePath of requiredFiles) {
    assert(
      await exists(path.join(repoRoot, relativePath)),
      `Missing required file: ${relativePath}`,
    );
  }
}

async function validateCoreLoopContract() {
  const contractPath = path.join(
    repoRoot,
    "config",
    "contracts",
    "core-loop-contract.json",
  );
  const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
  const expectedStages = [
    "Critical",
    "Fetch",
    "Thinking",
    "Execution",
    "Review",
    "Meta-Review",
    "Verification",
    "Evolution",
  ];

  assert(
    (contract.schemaVersion ?? 0) >= 1 &&
      contract.contractId === "meta-kim-core-loop-contract",
    "core-loop-contract.json must define the Meta_Kim core loop contract.",
  );
  assert(
    contract.defaultEntry?.contractIsDefaultPath === true &&
      contract.defaultEntry?.entryScript ===
        "scripts/run-meta-theory-governed-execution.mjs" &&
      contract.defaultEntry?.packageScript === "meta:theory:run",
    "core-loop-contract.json must bind the default governed execution entrypoint.",
  );
  const stages = contract.stages ?? [];
  assert(
    stages.map((stage) => stage.stage).join("|") === expectedStages.join("|"),
    "core-loop-contract.json must define the exact eight-stage spine in order.",
  );
  for (const stage of stages) {
    for (const field of [
      "requiredInputs",
      "requiredOutputs",
      "skipConditions",
      "gateConditions",
      "blockingGates",
      "warningGates",
      "defaultOwner",
    ]) {
      assert(stage[field] !== undefined, `core-loop-contract ${stage.stage} missing ${field}.`);
    }
    assert(
      stage.requiredInputs.length > 0 &&
        stage.requiredOutputs.length > 0 &&
        stage.skipConditions.length > 0 &&
        stage.gateConditions.length > 0,
      `core-loop-contract ${stage.stage} must have non-empty IO, skip, and gate policy.`,
    );
    const decision = stage.decisionResponsibilities ?? {};
    for (const field of [
      "responsibilityRef",
      "decisionQuestion",
      "informationToCollect",
      "decisionOutputs",
      "userChoiceWhen",
    ]) {
      assert(
        decision[field] !== undefined,
        `core-loop-contract ${stage.stage} decisionResponsibilities missing ${field}.`,
      );
    }
    assert(
      typeof decision.responsibilityRef === "string" &&
        decision.responsibilityRef.length > 0 &&
        typeof decision.decisionQuestion === "string" &&
        decision.decisionQuestion.length > 0 &&
        Array.isArray(decision.informationToCollect) &&
        decision.informationToCollect.length >= 3 &&
        Array.isArray(decision.decisionOutputs) &&
        decision.decisionOutputs.length >= 2 &&
        typeof decision.userChoiceWhen === "string" &&
        decision.userChoiceWhen.length > 0,
      `core-loop-contract ${stage.stage} must define responsibility-matched decision information.`,
    );
  }
  const byStage = Object.fromEntries(stages.map((stage) => [stage.stage, stage]));
  for (const field of [
    "intentPacket.realIntent",
    "intentPacket.successCriteria",
    "intentPacket.nonGoals",
    "intentPacket.blockingUnknowns",
    "intentPacket.noQuotaClarification",
  ]) {
    assert(
      byStage.Critical.requiredOutputs.includes(field),
      `Critical requiredOutputs must include ${field}.`,
    );
  }
  for (const field of [
    "fetchPacket.capabilityDiscovery.searchLog",
    "fetchPacket.capabilityDiscovery.capabilityInventory",
    "fetchPacket.capabilityGap",
  ]) {
    assert(byStage.Fetch.requiredOutputs.includes(field), `Fetch requiredOutputs must include ${field}.`);
  }
  for (const field of [
    "thinkingPacket.owner",
    "thinkingPacket.weapon",
    "thinkingPacket.workerTaskPackets",
    "thinkingPacket.reviewOwner",
    "thinkingPacket.verificationOwner",
    "thinkingPacket.mergeOwner",
    "thinkingPacket.parallelGroups",
    "thinkingPacket.dependencyPolicy",
    "thinkingPacket.omittedLanesWithReason",
  ]) {
    assert(
      byStage.Thinking.requiredOutputs.includes(field),
      `Thinking requiredOutputs must include ${field}.`,
    );
  }
  assert(
    byStage.Review.requiredInputs.includes("thinkingPacket") &&
      byStage.Review.requiredOutputs.includes("reviewPacket.upstreamQuality"),
    "Review must check Critical/Fetch/Thinking quality before result polish.",
  );
  assert(
    byStage["Meta-Review"].requiredOutputs.includes(
      "metaReviewPacket.publicReadyGateCheck",
    ),
    "Meta-Review must check the public-ready gate.",
  );
  assert(
    byStage.Verification.gateConditions.includes("public-ready claim") &&
      byStage.Verification.warningGates.some((gate) => /ordinary low-risk/i.test(gate)),
    "Verification must act as fuse/public-ready gate, not every-step interception.",
  );
  assert(
    byStage.Evolution.requiredOutputs.includes(
      "evolutionWritebackPacket.noneWithReason",
    ) &&
      byStage.Evolution.blockingGates.includes("missing_writeback_or_none_reason"),
    "Evolution must require writeback or none-with-reason.",
  );

  const discovery = contract.capabilityDiscovery ?? {};
  for (const source of [
    "canonical/agents",
    "runtime agent mirrors",
    "MCP servers and config",
    "tools, scripts, and package commands",
    "hooks",
    "runtime capability matrix",
    "OS compatibility matrix",
    "config/capability-index",
    "global capability inventory",
    "Graphify/project map",
  ]) {
    assert(
      discovery.minimumSources?.includes(source),
      `core-loop-contract capabilityDiscovery.minimumSources must include ${source}.`,
    );
  }
  for (const field of [
    "id",
    "providerType",
    "sourcePath",
    "runtimeSupport",
    "riskLevel",
    "ownerBoundary",
    "canExecute",
    "canReview",
    "canVerify",
    "canCreateOrUpgrade",
    "missingDependencies",
    "confidence",
    "reason",
  ]) {
    assert(
      discovery.inventoryRecordRequiredFields?.includes(field),
      `capability inventory record contract must require ${field}.`,
    );
  }
  const cards = contract.dynamicWorkflow?.cards ?? [];
  for (const card of [
    "Clarify",
    "Shrink scope",
    "Options",
    "Execute",
    "Verify",
    "Fix",
    "Rollback",
    "Risk",
    "Nudge",
    "Pause",
  ]) {
    assert(cards.includes(card), `dynamic workflow cards must include ${card}.`);
  }
  assert(
    contract.executionOwnership?.mainThreadRole === "scope_delegate_review_synthesize" &&
      contract.executionOwnership?.requiresWorkerTaskPackets === true,
    "Execution ownership must keep the main thread as dispatcher/synthesizer and require workerTaskPackets.",
  );
  assert(
    contract.verificationPolicy?.notEveryStepInterceptor === true &&
      contract.verificationPolicy?.hooksAreLastResortFuse === true &&
      contract.verificationPolicy?.validatorsAreReleaseAndContractEvidence === true,
    "Verification policy must keep hooks as fuses and validators as release/contract gates.",
  );
  assert(
    contract.publicReadyClaim?.requiresVerificationEvidence === true &&
      contract.publicReadyClaim?.blocksOn?.includes("runtime smoke mislabeled as live"),
    "Public-ready claims must require verification evidence and block smoke-as-live overclaims.",
  );
  assert(
    contract.crossRuntimeBoundary?.doNotMixFormats === true &&
      contract.crossRuntimeBoundary?.canonicalSourceFirst === true,
    "Cross-runtime policy must forbid mixing runtime formats and keep canonical source first.",
  );
}

async function validateWorkflowContract() {
  const contractPath = path.join(
    repoRoot,
    "config",
    "contracts",
    "workflow-contract.json",
  );
  const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));

  assert(
    (contract.schemaVersion ?? 0) >= 6,
    "workflow-contract.json schemaVersion must be >= 6 for stage-quality governance.",
  );

  const protocolFirst = contract.runDiscipline?.protocolFirst ?? {};
  assert(
    protocolFirst.enabled === true,
    "workflow-contract.json protocolFirst must be enabled.",
  );

  const qualityFirst = contract.runDiscipline?.qualityFirstPolicy ?? {};
  assert(
    qualityFirst.clarificationPolicy?.askOnlyIfAnswerChangesExecution === true &&
      qualityFirst.clarificationPolicy?.forbidQuestionQuotaFilling === true &&
      qualityFirst.clarificationPolicy?.questionCountPolicy ===
        "no_quota_ask_only_outcome_branching" &&
      !("maxBlockingQuestions" in (qualityFirst.clarificationPolicy ?? {})),
    "workflow-contract.json qualityFirstPolicy must forbid filler clarification questions.",
  );
  assert(
    qualityFirst.readBeforeEditPolicy?.requiredBeforeMutation === true &&
      qualityFirst.readBeforeEditPolicy?.allowedDuringCriticalFetch?.includes(
        "git_status",
      ) &&
      qualityFirst.readBeforeEditPolicy?.blockedBeforeThinkingReadiness?.includes(
        "mutation",
      ),
    "workflow-contract.json qualityFirstPolicy must require read-before-edit evidence before mutation.",
  );
  const stageOutputs = qualityFirst.stageRequiredOutputs ?? {};
  for (const [stage, field] of [
    ["critical", "realIntent"],
    ["critical", "noQuotaClarification"],
    ["fetch", "decisionImpactMap"],
    ["fetch", "capabilityDiscovery"],
    ["thinking", "designFrame"],
    ["thinking", "workerTaskPackets"],
    ["thinking", "dependencyPolicy"],
    ["review", "fallbackBoundary"],
  ]) {
    assert(
      stageOutputs[stage]?.includes(field),
      `workflow-contract.json qualityFirstPolicy.stageRequiredOutputs.${stage} must include ${field}.`,
    );
  }
  assert(
    qualityFirst.dependencyPolicy?.criticalDependencyFailureActions?.includes(
      "return_to_stage",
    ) &&
      qualityFirst.dependencyPolicy?.forbiddenActions?.includes("use_fallback"),
    "workflow-contract.json qualityFirstPolicy.dependencyPolicy must block fallback dependency handling.",
  );
  for (const stage of ["critical", "fetch", "thinking", "execution", "review"]) {
    assert(
      typeof qualityFirst.stageQualityContract?.[stage] === "string" &&
        qualityFirst.stageQualityContract[stage].length > 0,
      `workflow-contract.json qualityFirstPolicy.stageQualityContract must define ${stage}.`,
    );
  }
  for (const workType of ["content", "product", "code", "research", "design"]) {
    assert(
      qualityFirst.expertLensCatalog?.some((entry) => entry.workType === workType),
      `workflow-contract.json qualityFirstPolicy.expertLensCatalog must include ${workType}.`,
    );
  }
  assert(
    qualityFirst.promptPrecisionPolicy?.compactNotationAllowed === true,
    "workflow-contract.json qualityFirstPolicy must allow compact internal prompt notation.",
  );
  const visibleNotice = qualityFirst.hostVisibleNoticeContract ?? {};
  assert(
    visibleNotice.required === true &&
      visibleNotice.primaryUserVisibleSurface === "assistant_chat_message",
    "workflow-contract.json qualityFirstPolicy.hostVisibleNoticeContract must require assistant-chat progress notices.",
  );
  for (const hiddenSurface of [
    "hookSpecificOutput.additionalContext",
    "markdown_report_only",
  ]) {
    assert(
      visibleNotice.notUserVisibleSurfaces?.includes(hiddenSurface),
      `workflow-contract.json hostVisibleNoticeContract.notUserVisibleSurfaces must include ${hiddenSurface}.`,
    );
  }
  for (const requiredMoment of [
    "run_start",
    "route_selected_before_execution",
    "closure",
  ]) {
    assert(
      visibleNotice.requiredMoments?.includes(requiredMoment),
      `workflow-contract.json hostVisibleNoticeContract.requiredMoments must include ${requiredMoment}.`,
    );
  }
  assert(
    visibleNotice.runtimeAdapters?.codex?.choiceSurface === "request_user_input" &&
      visibleNotice.runtimeAdapters?.claude?.choiceSurface === "AskUserQuestion",
    "workflow-contract.json hostVisibleNoticeContract must preserve native Codex and Claude choice surfaces.",
  );
  assert(
    visibleNotice.i18n?.languageOrder?.includes("latest_user_input_language") &&
      visibleNotice.i18n?.maxBulletsPerNotice === 3,
    "workflow-contract.json hostVisibleNoticeContract must define i18n language fallback and concise notice size.",
  );

  const requiredPackets = protocolFirst.requiredPackets ?? [];
  for (const packet of [
    "taskClassification",
    "contentEvidencePacket",
    "preDecisionOptionFrame",
    "businessFlowBlueprintPacket",
    "productCompletenessPacket",
    "experienceQualityPacket",
    "testStrategyPacket",
    "structureHygienePacket",
    "agentBlueprintPacket",
    "dispatchEnvelopePacket",
    "workerTaskPacket",
    "reviewPacket",
  ]) {
    assert(
      requiredPackets.includes(packet),
      `workflow-contract.json protocolFirst.requiredPackets must include ${packet}.`,
    );
  }

  for (const flow of [
    "simple_exec",
    "complex_dev",
    "meta_analysis",
    "proposal_review",
    "rhythm",
  ]) {
    assert(
      protocolFirst.contentEvidencePacketRequiredBeforeUserChoiceWhenGovernanceFlows?.includes(
        flow,
      ),
      `workflow-contract.json must require contentEvidencePacket before user choice for ${flow}.`,
    );
    assert(
      protocolFirst.preDecisionOptionFrameRequiredBeforeUserChoiceWhenGovernanceFlows?.includes(
        flow,
      ),
      `workflow-contract.json must require preDecisionOptionFrame before user choice for ${flow}.`,
    );
    assert(
      protocolFirst.dispatchEnvelopePacketRequiredWhenGovernanceFlows?.includes(
        flow,
      ),
      `workflow-contract.json must require dispatchEnvelopePacket for ${flow}.`,
    );
  }

  assert(
    protocolFirst.dispatchArtifactsFinalizedAfterChoice === true,
    "workflow-contract.json must forbid final dispatch artifacts before user choice or a valid recorded skip.",
  );

  for (const flow of ["complex_dev", "meta_analysis"]) {
    assert(
      protocolFirst.intentPacketRequiredWhenGovernanceFlows?.includes(flow),
      `workflow-contract.json must require intentPacket for ${flow}.`,
    );
    assert(
      protocolFirst.intentGatePacketRequiredWhenGovernanceFlows?.includes(flow),
      `workflow-contract.json must require intentGatePacket for ${flow}.`,
    );
  }

  const contentEvidenceFields =
    contract.protocols?.contentEvidencePacket?.requiredFields ?? [];
  for (const field of [
    "researchCapabilityDiscovery",
    "localSourcesRead",
    "contentFindings",
    "capabilityEvidence",
    "assumptionLedger",
    "decisionImpactMap",
    "evidenceLaneValidatedBy",
  ]) {
    assert(
      contentEvidenceFields.includes(field),
      `workflow-contract.json contentEvidencePacket must require ${field}.`,
    );
  }

  const capabilityDiscovery =
    contract.protocols?.contentEvidencePacket?.researchCapabilityDiscovery ?? {};
  for (const field of [
    "requiredCapabilities",
    "toolInventorySources",
    "availableRetrievalCapabilities",
    "selectedResearchPath",
    "capabilityGaps",
    "validatedBy",
  ]) {
    assert(
      capabilityDiscovery.requiredFields?.includes(field),
      `workflow-contract.json researchCapabilityDiscovery must require ${field}.`,
    );
  }
  assert(
    capabilityDiscovery.forbiddenFields?.includes("platformSurface"),
    "workflow-contract.json researchCapabilityDiscovery must forbid platformSurface guessing.",
  );
  const researchQualityGate =
    contract.protocols?.contentEvidencePacket?.deepResearchPlanQualityGate ?? {};
  for (const field of [
    "decisionUse",
    "questions",
    "sourceCategoriesPlanned",
    "deepReadTargets",
    "sourceQualityLadder",
    "claimAttributionRules",
    "crossCheckStrategy",
    "originalSynthesisRules",
    "decisionImpactCriteria",
    "decisionQualityFrame",
    "competingHypotheses",
    "minimumDecisionTest",
    "evidenceConfidencePolicy",
    "decisionReadinessGate",
    "keyInformationTargets",
    "iterationPlan",
    "stopCondition",
    "decisionUpdateRule",
  ]) {
    assert(
      researchQualityGate.requiredPlanFields?.includes(field),
      `workflow-contract.json deepResearchPlanQualityGate must require ${field}.`,
    );
  }
  assert(
    researchQualityGate.minimumSearchAngles >= 3,
    "workflow-contract.json deepResearchPlanQualityGate must require at least 3 search angles.",
  );
  assert(
    researchQualityGate.minimumKeySourcesToDeepRead >= 3,
    "workflow-contract.json deepResearchPlanQualityGate must require key-source deep reading.",
  );
  assert(
    researchQualityGate.minimumIndependentSourcesForRouteChangingClaim >= 2,
    "workflow-contract.json deepResearchPlanQualityGate must require cross-source route evidence.",
  );
  for (const field of ["intent", "subject", "path", "constraints", "evidenceUse", "outputCommitment"]) {
    assert(
      researchQualityGate.decisionQualityFrameRequiredFields?.includes(field),
      `workflow-contract.json deepResearchPlanQualityGate decisionQualityFrame must require ${field}.`,
    );
  }
  for (const field of ["goal", "input", "action", "output", "passCondition", "failSignal", "nextStep", "doNotDo"]) {
    assert(
      researchQualityGate.minimumDecisionTestRequiredFields?.includes(field),
      `workflow-contract.json deepResearchPlanQualityGate minimumDecisionTest must require ${field}.`,
    );
  }
  assert(
    researchQualityGate.competingHypothesesPolicy?.minimumHypotheses >= 2,
    "workflow-contract.json deepResearchPlanQualityGate must require competing hypotheses.",
  );
  assert(
    researchQualityGate.evidenceConfidencePolicy?.sourceStates?.includes("confirmed") &&
      researchQualityGate.evidenceConfidencePolicy?.sourceStates?.includes("unconfirmed"),
    "workflow-contract.json deepResearchPlanQualityGate must require evidence confidence states.",
  );
  assert(
    researchQualityGate.decisionReadinessGate?.requiredSignals?.includes("real_alternatives") &&
      researchQualityGate.decisionReadinessGate?.requiredSignals?.includes("action_commitment"),
    "workflow-contract.json deepResearchPlanQualityGate must require decision readiness signals.",
  );
  assert(
    researchQualityGate.originalSynthesisPolicy?.forbidden?.includes(
      "copying third-party prompt text",
    ) &&
      researchQualityGate.originalSynthesisPolicy?.forbidden?.includes(
        "using cosmetic rewrites to disguise copied wording",
      ),
    "workflow-contract.json deepResearchPlanQualityGate must forbid copied prompt text and cosmetic disguise.",
  );
  const contentEvidenceRequired =
    contract.protocols?.contentEvidencePacket?.requiredFields ?? [];
  for (const field of ["iterationLog", "claimEvidenceCards"]) {
    assert(
      contentEvidenceRequired.includes(field),
      `workflow-contract.json contentEvidencePacket must require ${field}.`,
    );
    assert(
      contract.protocols?.contentEvidencePacket?.deepResearchRequiredFields?.includes(field),
      `workflow-contract.json deepResearchRequiredFields must require ${field}.`,
    );
  }
  const iterationGate =
    contract.protocols?.contentEvidencePacket?.iterationLogQualityGate ?? {};
  assert(
    iterationGate.minimumIterationLogEntries >= 1,
    "workflow-contract.json iterationLogQualityGate must require iterative evidence logs.",
  );
  for (const field of [
    "iteration",
    "trigger",
    "queryOrAction",
    "observation",
    "gapClosed",
    "nextStepDecision",
    "stopCheck",
  ]) {
    assert(
      iterationGate.requiredFields?.includes(field),
      `workflow-contract.json iterationLogQualityGate must require ${field}.`,
    );
  }
  const claimCardGate =
    contract.protocols?.contentEvidencePacket?.claimEvidenceCardQualityGate ?? {};
  assert(
    claimCardGate.minimumClaimEvidenceCards >= 1,
    "workflow-contract.json claimEvidenceCardQualityGate must require claim evidence cards.",
  );
  for (const field of [
    "claim",
    "sourceRefs",
    "evidenceAnchor",
    "confidence",
    "counterevidence",
    "decisionImpact",
    "falsificationStatus",
  ]) {
    assert(
      claimCardGate.requiredFields?.includes(field),
      `workflow-contract.json claimEvidenceCardQualityGate must require ${field}.`,
    );
  }

  const decisionImpactValues =
    contract.protocols?.contentEvidencePacket?.decisionImpactStageEnum ?? [];
  for (const value of [
    "Critical",
    "Fetch",
    "Thinking",
    "Execution",
    "Review",
    "Meta-Review",
    "Verification",
    "Evolution",
    "business_phase",
    "meta_phase",
    "business_lane",
    "capability_route",
    "owner_weapon_dependency",
    "runtime_os_support",
    "tool_or_provider",
    "verification_path",
    "evolution_writeback",
    "user_interaction_surface",
  ]) {
    assert(
      decisionImpactValues.includes(value),
      `workflow-contract.json decisionImpactStageEnum must include ${value}.`,
    );
  }
  const decisionScopePolicy =
    contract.protocols?.contentEvidencePacket?.decisionImpactScopePolicy ?? {};
  assert(
    decisionScopePolicy.spineStageValues?.includes("Evolution") &&
      decisionScopePolicy.nonSpineValues?.includes("business_phase") &&
      decisionScopePolicy.nonSpineValues?.includes("tool_or_provider"),
    "workflow-contract.json decisionImpactScopePolicy must cover spine and non-spine decision boundaries.",
  );

  const optionFrame = contract.protocols?.preDecisionOptionFrame ?? {};
  for (const field of [
    "builtFromContentEvidence",
    "contentEvidenceRefs",
    "unresolvedQuestions",
    "candidateOptions",
    "recommendedDefault",
    "solutionChoiceState",
    "reviewOwner",
  ]) {
    assert(
      optionFrame.requiredFields?.includes(field),
      `workflow-contract.json preDecisionOptionFrame must require ${field}.`,
    );
  }
  for (const field of [
    "problemSolved",
    "expectedResult",
    "advantages",
    "disadvantages",
    "candidateOwners",
    "candidateTaskShape",
  ]) {
    assert(
      optionFrame.candidateOptionRequiredFields?.includes(field),
      `workflow-contract.json preDecisionOptionFrame candidate options must require ${field}.`,
    );
  }

  const productGatePolicy =
    contract.runDiscipline?.productDeliverableGatePolicy ?? {};
  assert(
    productGatePolicy.enabled === true &&
      productGatePolicy.requiredForNonQuery === true,
    "workflow-contract.json productDeliverableGatePolicy must be enabled before non-query delivery.",
  );
  for (const packet of [
    "productCompletenessPacket",
    "experienceQualityPacket",
    "testStrategyPacket",
    "structureHygienePacket",
  ]) {
    assert(
      productGatePolicy.requiredPackets?.includes(packet),
      `workflow-contract.json productDeliverableGatePolicy.requiredPackets must include ${packet}.`,
    );
  }
  for (const dimension of [
    "core_highlight",
    "feature_completeness",
    "ui_ue_ux",
    "real_test_strategy",
    "directory_structure",
    "dead_redundant_cleanup",
  ]) {
    assert(
      productGatePolicy.designDimensionCatalog?.some(
        (entry) => entry.dimensionId === dimension,
      ),
      `workflow-contract.json productDeliverableGatePolicy.designDimensionCatalog must include ${dimension}.`,
    );
  }

  const businessFlow = contract.protocols?.businessFlowBlueprintPacket ?? {};
  for (const field of [
    "deliverableType",
    "requiredLanes",
    "optionalLanes",
    "omittedLanes",
    "laneDependencies",
    "coverageJudgment",
  ]) {
    assert(
      businessFlow.requiredFields?.includes(field),
      `workflow-contract.json businessFlowBlueprintPacket must require ${field}.`,
    );
  }
  for (const field of [
    "capabilityNeed",
    "capabilitySearchQuery",
    "candidateOwners",
    "matchedCapabilities",
    "capabilityBindings",
    "selectedOwner",
    "selectionReason",
    "coverageStatus",
  ]) {
    assert(
      businessFlow.laneRequiredFields?.includes(field),
      `workflow-contract.json businessFlowBlueprintPacket lanes must require ${field}.`,
    );
  }
  assert(
    businessFlow.coverageJudgmentEnum?.includes("incomplete") &&
      businessFlow.coverageJudgmentEnum?.includes("intentionally_reduced"),
    "workflow-contract.json businessFlowBlueprintPacket must distinguish incomplete coverage from intentional scope reduction.",
  );

  const decisionContext =
    contract.businessWorkflow?.decisionContextPolicy ?? {};
  for (const field of [
    "scopeType",
    "scopeId",
    "responsibility",
    "decisionQuestion",
    "informationToCollect",
    "candidateOptions",
    "recommendationOrNextState",
    "userChoiceImpact",
    "evidenceRefs",
  ]) {
    assert(
      decisionContext.requiredDecisionRecordFields?.includes(field),
      `workflow-contract.json decisionContextPolicy must require ${field}.`,
    );
  }
  for (const scope of [
    "spine_stage",
    "business_phase",
    "meta_phase",
    "business_lane",
    "capability_route",
    "owner_weapon_dependency",
    "runtime_os_support",
    "tool_or_provider",
    "verification_path",
    "evolution_writeback",
    "user_interaction_surface",
  ]) {
    assert(
      decisionContext.scopeTypes?.includes(scope),
      `workflow-contract.json decisionContextPolicy.scopeTypes must include ${scope}.`,
    );
  }

  const assertDecisionSemantics = (container, ids, label) => {
    const requiredFields = container?.requiredPhaseFields ?? [];
    for (const field of [
      "responsibility",
      "decisionQuestion",
      "informationToCollect",
      "decisionOutputs",
    ]) {
      assert(
        requiredFields.includes(field),
        `workflow-contract.json ${label} must require ${field}.`,
      );
    }
    for (const id of ids) {
      const entry = container?.phases?.[id];
      assert(entry, `workflow-contract.json ${label} missing ${id}.`);
      assert(
        typeof entry.responsibility === "string" &&
          entry.responsibility.length > 0 &&
          typeof entry.decisionQuestion === "string" &&
          entry.decisionQuestion.length > 0 &&
          Array.isArray(entry.informationToCollect) &&
          entry.informationToCollect.length >= 3 &&
          Array.isArray(entry.decisionOutputs) &&
          entry.decisionOutputs.length >= 2,
        `workflow-contract.json ${label}.${id} must define responsibility-matched decision information.`,
      );
    }
  };
  assertDecisionSemantics(
    contract.businessWorkflow?.phaseDecisionSemantics,
    contract.businessWorkflow?.phases ?? [],
    "businessWorkflow.phaseDecisionSemantics",
  );
  assertDecisionSemantics(
    contract.metaWorkflow?.phaseDecisionSemantics,
    contract.metaWorkflow?.phases ?? [],
    "metaWorkflow.phaseDecisionSemantics",
  );

  const runArtifactValidation = contract.runDiscipline?.runArtifactValidation ?? {};
  assert(
    runArtifactValidation.publicReadyTodoGate?.defaultMode === "hard" &&
      runArtifactValidation.commentReviewGate?.defaultMode === "hard",
    "workflow-contract.json run artifact quality gates must be hard by default.",
  );
  assert(
    !JSON.stringify(contract.protocols?.workerTaskPacket ?? {}).includes(
      "use_fallback",
    ),
    "workflow-contract.json workerTaskPacket dependency contract must not allow use_fallback.",
  );

  for (const [protocolName, expectedFields] of [
    [
      "productCompletenessPacket",
      ["outcome", "acceptanceCriteria", "nonGoals", "designDimensions", "evidenceRefs"],
    ],
    [
      "experienceQualityPacket",
      ["audience", "criticalJourneys", "qualityAttributes", "experienceDimensions", "evidenceRefs"],
    ],
    [
      "testStrategyPacket",
      ["strategy", "requiredTestTypes", "coverageRationale", "testDimensions", "evidenceRefs"],
    ],
    [
      "structureHygienePacket",
      ["changedAreas", "boundaryChecks", "orphanCleanup", "structureDimensions", "evidenceRefs"],
    ],
  ]) {
    const fields = contract.protocols?.[protocolName]?.requiredFields ?? [];
    for (const field of expectedFields) {
      assert(
        fields.includes(field),
        `workflow-contract.json ${protocolName} must require ${field}.`,
      );
    }
  }

  const agentBlueprint = contract.protocols?.agentBlueprintPacket ?? {};
  const governanceStagePolicy = agentBlueprint.governanceStageCoveragePolicy ?? {};
  for (const stage of ["Critical", "Fetch", "Thinking", "Review"]) {
    assert(
      governanceStagePolicy.requiredStages?.includes(stage),
      `workflow-contract.json governanceStageCoveragePolicy must require ${stage}.`,
    );
    assert(
      Array.isArray(governanceStagePolicy.stageRequiredAgents?.[stage]) &&
        governanceStagePolicy.stageRequiredAgents[stage].length >= 1,
      `workflow-contract.json governanceStageCoveragePolicy must assign required agents for ${stage}.`,
    );
  }
  assert(
    governanceStagePolicy.skillSelectionScope === "run_scoped",
    "workflow-contract.json governanceStageCoveragePolicy must keep concrete skill selection run-scoped.",
  );
  const globalReusePolicy = agentBlueprint.globalAgentReusePolicy ?? {};
  for (const source of [
    "repo_canonical_capability_index",
    "runtime_mirror_indexes",
    "project_runtime_agent_inventory",
    "local_global_agent_inventory",
    "available_capability_providers_skills_tools_mcp",
  ]) {
    assert(
      globalReusePolicy.requiredEvidenceOrder?.includes(source),
      `workflow-contract.json globalAgentReusePolicy must require ${source}.`,
    );
  }
  assert(
    globalReusePolicy.creationBlockedUntilExistingAgentsChecked === true,
    "workflow-contract.json globalAgentReusePolicy must block creation until existing agents are checked.",
  );

  const discoveryPolicy =
    contract.runDiscipline?.executionOwnership?.capabilityDiscoveryRuntimePolicy ?? {};
  assert(
    discoveryPolicy.defaultMode === "cached_global_inventory_plus_project_light_scan",
    "workflow-contract.json capability discovery must default to cached global inventory plus project light scan.",
  );
  assert(
    discoveryPolicy.fullScanWhen?.includes("explicit_user_refresh") &&
      discoveryPolicy.fullScanWhen?.includes("stale_cache") &&
      discoveryPolicy.fullScanWhen?.includes("scheduled_refresh_older_than_14_days") &&
      discoveryPolicy.fullScanWhen?.includes("high_risk_provider_route"),
    "workflow-contract.json capability discovery full-scan triggers must be explicit.",
  );
  assert(
    discoveryPolicy.staleAfterMinutes === 20160 && discoveryPolicy.staleAfterDays === 14,
    "workflow-contract.json capability discovery cache must become stale after 14 days.",
  );
  assert(
    /must not run a full global filesystem scan on every dispatch/i.test(
      discoveryPolicy.perRunBehavior ?? "",
    ),
    "workflow-contract.json capability discovery must forbid per-dispatch full scans.",
  );
  assert(
    /older than 14 days/i.test(discoveryPolicy.perRunBehavior ?? "") &&
      /2 weeks/i.test(discoveryPolicy.userPromptPolicy ?? "") &&
      /update first/i.test(discoveryPolicy.userPromptPolicy ?? ""),
    "workflow-contract.json capability discovery must define the 2-week refresh notice UX.",
  );
  assert(
    /must not dump full provider definitions/i.test(discoveryPolicy.tokenPolicy ?? ""),
    "workflow-contract.json capability discovery must protect token budget.",
  );

  const executionAgentCard =
    contract.protocols?.executionAgentCard?.abstractionPolicy ?? {};
  assert(
    executionAgentCard.concreteWorkOrderFieldsForbidden === true,
    "workflow-contract.json executionAgentCard must forbid work-order fields in durable identity.",
  );
  assert(
    executionAgentCard.pathLikeBindingsForbidden === true,
    "workflow-contract.json executionAgentCard must forbid path-like durable bindings.",
  );
  assert(
    executionAgentCard.providerFirstAgentLast === true,
    "workflow-contract.json executionAgentCard must require provider-first, agent-last creation.",
  );
  for (const field of ["todayTask", "scopeFiles", "deliverableLink", "verifySteps"]) {
    assert(
      executionAgentCard.forbiddenDurableFields?.includes(field),
      `workflow-contract.json executionAgentCard.abstractionPolicy must forbid ${field}.`,
    );
  }

  const workerFields = contract.protocols?.workerTaskPacket?.requiredFields ?? [];
  for (const field of [
    "todayTask",
    "scopeFiles",
    "workType",
    "executionMode",
    "qualityBar",
    "referenceDirection",
    "verifySteps",
    "preDecisionOptionFrameRef",
    "finalizationGate",
  ]) {
    assert(
      workerFields.includes(field),
      `workflow-contract.json workerTaskPacket must require ${field}.`,
    );
  }
  const executionModePolicy =
    contract.protocols?.workerTaskPacket?.executionModePolicy ?? {};
  assert(
    executionModePolicy.executionWorkerModes?.includes("primary_execution") &&
      executionModePolicy.executionWorkerModes?.includes("factory_then_dispatch"),
    "workflow-contract.json workerTaskPacket.executionModePolicy must define execution worker modes.",
  );
  assert(
    executionModePolicy.sidecarModes?.includes("readonly_fetch_sidecar") &&
      executionModePolicy.sidecarModes?.includes("readonly_review_sidecar"),
    "workflow-contract.json workerTaskPacket.executionModePolicy must define read-only sidecar modes.",
  );
  const executionModeEnum = executionModePolicy.executionModeEnum ?? [];
  const executionModeClasses = new Set(executionModePolicy.executionModeClasses ?? []);
  const executionModeClassMap = executionModePolicy.executionModeClassMap ?? {};
  for (const expectedClass of [
    "real_execution",
    "read_only_sidecar",
    "approval_gate",
  ]) {
    assert(
      executionModeClasses.has(expectedClass),
      `workflow-contract.json workerTaskPacket.executionModePolicy must define ${expectedClass}.`,
    );
  }
  for (const mode of executionModeEnum) {
    assert(
      executionModeClasses.has(executionModeClassMap[mode]),
      `workflow-contract.json workerTaskPacket.executionModePolicy must classify ${mode}.`,
    );
  }
  for (const mode of executionModePolicy.executionWorkerModes ?? []) {
    assert(
      executionModeClassMap[mode] === "real_execution",
      `workflow-contract.json execution worker mode ${mode} must classify as real_execution.`,
    );
  }
  for (const mode of executionModePolicy.sidecarModes ?? []) {
    assert(
      executionModeClassMap[mode] === "read_only_sidecar",
      `workflow-contract.json sidecar mode ${mode} must classify as read_only_sidecar.`,
    );
  }
  for (const mode of executionModePolicy.approvalGateModes ?? []) {
    assert(
      executionModeClassMap[mode] === "approval_gate",
      `workflow-contract.json approval gate mode ${mode} must classify as approval_gate.`,
    );
  }
  const verifySteps = contract.protocols?.workerTaskPacket?.verifyStepsField ?? {};
  assert(
    verifySteps.items?.required?.includes("step") &&
      verifySteps.items?.required?.includes("verify"),
    "workflow-contract.json workerTaskPacket.verifySteps must require step and verify.",
  );

  const reviewFields = contract.protocols?.reviewPacket?.requiredFields ?? [];
  for (const field of [
    "ownerCoverage",
    "protocolCompliance",
    "qualityGate",
    "triggerVsSkipReasonCheck",
    "findings",
  ]) {
    assert(
      reviewFields.includes(field),
      `workflow-contract.json reviewPacket must require ${field}.`,
    );
  }
}
function assertSchemaRequired(schemaNode, value, label) {
  for (const field of schemaNode.required ?? []) {
    assert(
      Object.prototype.hasOwnProperty.call(value ?? {}, field),
      `${label} must include schema-required field ${field}.`,
    );
  }
}

function assertSchemaEnum(schemaNode, value, label) {
  if (!schemaNode?.enum) {
    return;
  }
  assert(
    schemaNode.enum.includes(value),
    `${label} must be one of ${schemaNode.enum.join(", ")}.`,
  );
}

function assertSchemaConst(schemaNode, value, label) {
  if (!Object.prototype.hasOwnProperty.call(schemaNode ?? {}, "const")) {
    return;
  }
  assert(value === schemaNode.const, `${label} must equal ${schemaNode.const}.`);
}

function assertNoAdditionalSchemaProperties(schemaNode, value, label) {
  if (schemaNode.additionalProperties !== false) {
    return;
  }
  const allowed = new Set(Object.keys(schemaNode.properties ?? {}));
  const extras = Object.keys(value ?? {}).filter((key) => !allowed.has(key));
  assert(
    extras.length === 0,
    `${label} has fields not declared in capability-index.schema.json: ${extras.join(", ")}.`,
  );
}

async function validateCapabilityIndexSchema(index) {
  const schemaPath = path.join(
    repoRoot,
    "config",
    "contracts",
    "capability-index.schema.json",
  );
  const schema = JSON.parse(await fs.readFile(schemaPath, "utf8"));

  assert(schema.type === "object", "capability-index.schema.json root must be an object schema.");
  assertSchemaRequired(schema, index, "capability index");
  assertNoAdditionalSchemaProperties(schema, index, "capability index");
  assertSchemaEnum(schema.properties.scope, index.scope, "capability index scope");
  for (const field of [
    "abstractCapabilitySlots",
    "metaSkillProviders",
    "runtimeSelectedSkills",
    "longTermAgentIdentityPolicy",
  ]) {
    assert(
      Object.prototype.hasOwnProperty.call(schema.properties, field),
      `capability-index.schema.json must define ${field}.`,
    );
  }

  const fetchOrderSchema = schema.properties.fetchOrder;
  assert(Array.isArray(index.fetchOrder), "capability index fetchOrder must be an array.");
  for (const [position, item] of index.fetchOrder.entries()) {
    assertSchemaEnum(
      fetchOrderSchema.items,
      item,
      `capability index fetchOrder[${position}]`,
    );
  }

  const groupsSchema = schema.properties.byCapabilityType.properties;
  assert(index.byCapabilityType && typeof index.byCapabilityType === "object", "capability index byCapabilityType must be an object.");

  assert(
    Array.isArray(index.abstractCapabilitySlots) &&
      index.abstractCapabilitySlots.length >= 1,
    "capability index must declare at least one abstractCapabilitySlots entry.",
  );
  for (const [position, slot] of index.abstractCapabilitySlots.entries()) {
    assertSchemaRequired(
      schema.properties.abstractCapabilitySlots.items,
      slot,
      `capability index abstractCapabilitySlots[${position}]`,
    );
    assert(
      slot.selectedSkillScope === "run_only",
      `capability index abstractCapabilitySlots[${position}].selectedSkillScope must be run_only.`,
    );
    assert(
      Array.isArray(slot.allowedProviderIds) &&
        slot.allowedProviderIds.length >= 1,
      `capability index abstractCapabilitySlots[${position}] must list allowedProviderIds.`,
    );
  }
  assert(
    index.runtimeSelectedSkills?.selectedSkillScope === "run_only",
    "capability index runtimeSelectedSkills.selectedSkillScope must be run_only.",
  );
  assert(
    index.longTermAgentIdentityPolicy
      ?.forbidConcreteSkillInLongTermAgentIdentity === true,
    "capability index longTermAgentIdentityPolicy must forbid concrete skills in long-term agent identity.",
  );
  for (const provider of [
    "agent-teams-playbook",
    "superpowers",
    "ecc",
    "findskill",
  ]) {
    const providerEntry = index.metaSkillProviders?.[provider];
    assert(
      providerEntry?.providerKind === "meta-skill-package" &&
        providerEntry?.allowedForLongTermAgentIdentity === true &&
        providerEntry?.concreteSubSkillBindingForbidden === true,
      `capability index metaSkillProviders.${provider} must be an allowed meta-skill package provider with concrete child-skill binding forbidden.`,
    );
    assert(
      index.longTermAgentIdentityPolicy?.allowedMetaSkillProviderIds?.includes(
        provider,
      ),
      `capability index longTermAgentIdentityPolicy.allowedMetaSkillProviderIds must include ${provider}.`,
    );
  }
  assert(
    Array.isArray(
      index.longTermAgentIdentityPolicy?.forbiddenConcreteSkillPatterns,
    ) &&
      index.longTermAgentIdentityPolicy.forbiddenConcreteSkillPatterns.length >=
        1,
    "capability index longTermAgentIdentityPolicy must declare forbidden concrete child-skill binding patterns.",
  );

  const agentSchema = groupsSchema.agents.additionalProperties;
  for (const [key, entry] of Object.entries(index.byCapabilityType.agents ?? {})) {
    assertSchemaRequired(agentSchema, entry, `capability index agent ${key}`);
    assertSchemaConst(agentSchema.properties.type, entry.type, `capability index agent ${key}.type`);
    assertSchemaEnum(agentSchema.properties.layer, entry.layer, `capability index agent ${key}.layer`);
    if (entry.layer === "meta") {
      assert(
        entry.executionBlock === true,
        `capability index agent ${key} must set executionBlock=true for meta layer.`,
      );
    }
  }

  const skillSchema = groupsSchema.skills.additionalProperties;
  for (const [key, entry] of Object.entries(index.byCapabilityType.skills ?? {})) {
    assertSchemaRequired(skillSchema, entry, `capability index skill ${key}`);
    assertSchemaConst(skillSchema.properties.type, entry.type, `capability index skill ${key}.type`);
  }

  const governanceRules = index.governanceRules ?? {};
  const governanceSchema = schema.properties.governanceRules?.properties ?? {};
  assertSchemaConst(
    governanceSchema.metaAgentDispatchRule,
    governanceRules.metaAgentDispatchRule,
    "capability index governanceRules.metaAgentDispatchRule",
  );
  assertSchemaConst(
    governanceSchema.fallbackBehavior,
    governanceRules.fallbackBehavior,
    "capability index governanceRules.fallbackBehavior",
  );
}

async function readProjectProjectionMode() {
  try {
    const overridesPath = path.join(repoRoot, ".meta-kim", "local.overrides.json");
    const overrides = JSON.parse(await fs.readFile(overridesPath, "utf8"));
    return typeof overrides.projectProjectionMode === "string"
      ? overrides.projectProjectionMode
      : null;
  } catch {
    return null;
  }
}

async function validateCapabilityIndex() {
  const indexPath = path.join(
    canonicalCapabilityIndexDir,
    "meta-kim-capabilities.json",
  );
  const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
  await validateCapabilityIndexSchema(index);
  assert(
    index.scope === "repo-canonical",
    "config/capability-index/meta-kim-capabilities.json must be a repo-canonical index.",
  );
  assert(
    index.canonicalProjection === CANONICAL_CAPABILITY_INDEX_RELATIVE,
    "capability index must identify config/capability-index/meta-kim-capabilities.json as canonicalProjection.",
  );
  assert(
    index.localGlobalInventory === LOCAL_GLOBAL_CAPABILITY_INVENTORY_PATTERN,
    "capability index must point global inventory to .meta-kim/state/{profile}/capability-index/global-capabilities.json.",
  );
  assert(
    Array.isArray(index.fetchOrder) &&
      index.fetchOrder.join(" -> ") ===
        "repo canonical capability index -> runtime mirror -> local global inventory -> capability gap packet and return to Thinking",
    "capability index fetchOrder must be canonical -> mirror -> local inventory -> fallback.",
  );

  const serialized = JSON.stringify(index);
  const homeDir = os.homedir().replace(/\\/g, "\\\\");
  assert(
    !serialized.includes(homeDir),
    "repo-canonical capability index must not contain machine-specific home paths.",
  );

  const indexedAgentPaths = new Set(
    Object.values(index.byCapabilityType?.agents ?? {}).map((entry) => entry.path),
  );
  const canonicalAgentFiles = (await fs.readdir(canonicalAgentsDir))
    .filter((file) => file.endsWith(".md"))
    .map((file) => `canonical/agents/${file}`)
    .sort();
  const missingAgents = canonicalAgentFiles.filter(
    (agentPath) => !indexedAgentPaths.has(agentPath),
  );
  assert(
    missingAgents.length === 0,
    `capability index is missing canonical agents: ${missingAgents.join(", ")}.`,
  );

  const indexedSkillPaths = new Set(
    Object.values(index.byCapabilityType?.skills ?? {}).map((entry) => entry.path),
  );
  const canonicalSkillManifests = await listCanonicalSkillManifests();
  const missingSkills = canonicalSkillManifests
    .map((skill) => skill.path)
    .filter((skillPath) => !indexedSkillPaths.has(skillPath));
  assert(
    missingSkills.length === 0,
    `capability index is missing canonical skills: ${missingSkills.join(", ")}.`,
  );

  const canonicalContent = await fs.readFile(indexPath, "utf8");
  // In "global_only" project projection mode, sync-runtimes.mjs intentionally
  // does not maintain project-local capability-index mirrors (selectedTargets
  // is forced to [] when projectProjectionMode === "global_only"). Requiring
  // project-local mirror presence or byte identity contradicts that mode and
  // produces false failures, so skip project-local mirror validation there.
  const projectProjectionMode = await readProjectProjectionMode();
  if (projectProjectionMode === "global_only") {
    return;
  }
  for (const mirror of index.mirroredTo ?? []) {
    const mirrorPath = path.join(repoRoot, mirror);
    assert(await exists(mirrorPath), `Missing capability index mirror: ${mirror}.`);
    const mirroredContent = await fs.readFile(mirrorPath, "utf8");
    assert(
      mirroredContent === canonicalContent,
      `${mirror} must be byte-for-byte identical to ${CANONICAL_CAPABILITY_INDEX_RELATIVE}.`,
    );
  }
}


async function validateClaudeAgents() {
  const files = (await fs.readdir(canonicalAgentsDir))
    .filter((file) => file.endsWith(".md"))
    .sort();

  assert(files.length >= 1, "No canonical agent files found.");

  const ids = [];
  for (const file of files) {
    const filePath = path.join(canonicalAgentsDir, file);
    const raw = await fs.readFile(filePath, "utf8");
    const frontmatter = parseFrontmatter(raw, filePath);
    assert(frontmatter.name, `${file} is missing frontmatter name.`);
    assert(
      frontmatter.description,
      `${file} is missing frontmatter description.`,
    );
    assert(
      frontmatter.name === file.replace(/\.md$/, ""),
      `${file} frontmatter name must match filename.`,
    );
    assertNoForbiddenMarkers(raw, filePath);
    for (const marker of EXPECTED_AGENT_WEAPON_MARKERS[frontmatter.name] ??
      []) {
      assert(
        raw.includes(marker),
        `${file} must include weapon-pack marker ${marker}.`,
      );
    }
    ids.push(frontmatter.name);
  }

  const conductorPath = path.join(canonicalAgentsDir, "meta-conductor.md");
  const conductorRaw = await fs.readFile(conductorPath, "utf8");
  for (const marker of [
    "One run = one department = one thing",
    "sole primary deliverable",
    "All worker tasks must serve the same delivery chain",
    "Visual/Material Strategy",
  ]) {
    assert(
      conductorRaw.includes(marker),
      `meta-conductor.md must include ${marker}.`,
    );
  }

  const wardenPath = path.join(canonicalAgentsDir, "meta-warden.md");
  const wardenRaw = await fs.readFile(wardenPath, "utf8");
  for (const marker of [
    "exactly one department and one primary deliverable",
    "deliverable-chain discipline",
    "public-display discipline",
    "Visual strategy consistent with department nature",
  ]) {
    assert(
      wardenRaw.includes(marker),
      `meta-warden.md must include ${marker}.`,
    );
  }

  return ids;
}

async function validatePortableSkill() {
  const referenceFiles = await listCanonicalSkillReferences();
  const skillSourcePath = canonicalSkillPath;
  const skillSource = await fs.readFile(skillSourcePath, "utf8");
  const referenceSources = await Promise.all(
    referenceFiles.map(async (referenceFile) => {
      const referencePath = path.join(canonicalSkillReferencesDir, referenceFile);
      return fs.readFile(referencePath, "utf8");
    }),
  );
  const portableSkillCorpus = [skillSource, ...referenceSources].join("\n");

  for (const expected of [
    "name: meta-theory",
    "version:",
    "author:",
    "trigger:",
    "tools:",
  ]) {
    assert(
      skillSource.includes(expected),
      `Portable skill is missing ${expected}`,
    );
  }
  for (const marker of [
    "### Station Deliverable Contract (Mandatory)",
    "Required Genesis deliverables",
    "Required Artisan deliverables",
    "Required Conductor deliverables",
  ]) {
    assert(
      portableSkillCorpus.includes(marker),
      `Portable skill is missing station-deliverable marker ${marker}.`,
    );
  }
  assertNoForbiddenMarkers(skillSource, skillSourcePath, []);
  const frontmatterValidation = validateSkillFrontmatter(skillSource);
  assert(
    frontmatterValidation.ok,
    `Canonical meta-theory skill frontmatter is invalid: ${frontmatterValidation.message}.`,
  );

  for (const referenceFile of referenceFiles) {
    const canonicalReferencePath = path.join(
      canonicalSkillReferencesDir,
      referenceFile,
    );
    const canonicalReference = await fs.readFile(
      canonicalReferencePath,
      "utf8",
    );
    const allowedRuntimeMarkers =
      referenceFile === "runtime-claude.md"
        ? []
        : ["AskUserQuestion"];
    assertNoForbiddenMarkers(
      canonicalReference,
      canonicalReferencePath,
      allowedRuntimeMarkers,
    );
  }
}

async function validateSyncConfiguration() {
  const manifest = await loadSyncManifest();
  const profiles = await loadRuntimeProfiles(manifest);

  const supportedTargets = manifest.supportedTargets ?? [];
  const defaultTargets = manifest.defaultTargets ?? supportedTargets;
  const availableTargets = manifest.availableTargets ?? Object.keys(profiles);
  const generatedTargets = manifest.generatedTargets ?? {};
  const canonicalRoots = manifest.canonicalRoots ?? {};
  const projectPolicy = manifest.projectMaterializationPolicy ?? {};

  assert(
    supportedTargets.length >= 1,
    "config/sync.json must declare at least one supported target.",
  );
  assert(
    JSON.stringify([...supportedTargets].sort()) ===
      JSON.stringify(Object.keys(profiles).sort()),
    "config/sync.json supportedTargets must match the runtime target catalog.",
  );
  assert(
    defaultTargets.every((target) => supportedTargets.includes(target)),
    "config/sync.json defaultTargets must be a subset of supportedTargets.",
  );
  assert(
    JSON.stringify(defaultTargets) === JSON.stringify(["claude", "codex"]),
    "config/sync.json defaultTargets must keep direct-Enter install/update on Claude Code and Codex only.",
  );
  assert(
    availableTargets.every((target) =>
      Object.prototype.hasOwnProperty.call(profiles, target),
    ),
    "config/sync.json availableTargets must only reference known runtime targets.",
  );
  assert(
    supportedTargets.every(
      (target) =>
        Array.isArray(generatedTargets[target]) &&
        generatedTargets[target].length > 0,
    ),
    "config/sync.json must declare generatedTargets for every supported target.",
  );
  assert(
    canonicalRoots.skills === "canonical/skills",
    "config/sync.json canonicalRoots.skills must be canonical/skills.",
  );
  assert(
    canonicalRoots.contracts === "config/contracts",
    "config/sync.json canonicalRoots.contracts must be config/contracts.",
  );
  assert(
    canonicalRoots.capabilityIndex === "config/capability-index",
    "config/sync.json canonicalRoots.capabilityIndex must be config/capability-index.",
  );
  assert(
    projectPolicy.defaultAssetMode === "global_reusable_by_default",
    "config/sync.json projectMaterializationPolicy.defaultAssetMode must keep reusable assets global by default.",
  );
  for (const assetType of ["agents", "commands", "mcp", "skills"]) {
    assert(
      projectPolicy.globalByDefault?.includes(assetType),
      `config/sync.json projectMaterializationPolicy.globalByDefault must include ${assetType}.`,
    );
  }
  assert(
    !projectPolicy.globalByDefault?.includes("hooks"),
    "config/sync.json projectMaterializationPolicy.globalByDefault must keep hooks opt-in, not default-global.",
  );
  assert(
    projectPolicy.projectMaterializationTrigger ===
      "project_specific_customization_or_iteration_innovation",
    "config/sync.json project materialization must require project-specific customization or iteration innovation.",
  );
  assert(
    projectPolicy.projectRuntimeAssetCopyPolicy ===
      "copy_to_project_when_explicit_project_update_or_project_dedicated_extension",
    "config/sync.json must copy reusable runtime assets into projects only after explicit project update selection or when a project-dedicated extension is needed.",
  );
  assert(
    projectPolicy.projectAllowedBase?.includes("runtime_entry_context") &&
      projectPolicy.projectAllowedBase?.includes("merged_project_config") &&
      projectPolicy.projectAllowedBase?.includes("project_cache_state") &&
      projectPolicy.projectAllowedBase?.includes("project_specific_capability_overrides"),
    "config/sync.json projectMaterializationPolicy.projectAllowedBase must preserve context/config/state and project-specific overrides only.",
  );
  assert(
    projectPolicy.projectStatePaths?.includes(".meta-kim/state") &&
      projectPolicy.projectStatePaths?.includes(".meta-kim/backups") &&
      projectPolicy.projectStatePaths?.includes(".meta-kim/local.overrides.json"),
    "config/sync.json projectMaterializationPolicy.projectStatePaths must keep project state under .meta-kim.",
  );

  assert(
    profiles.codex.projection.outputPaths.skillsDir === ".agents/skills" &&
      profiles.codex.projection.outputPaths.skillRoot ===
        ".agents/skills/meta-theory",
    "Codex runtime profile must use .agents/skills as the only project skill root.",
  );
  assert(
    profiles.claude.projection.outputPaths.skillsDir === ".claude/skills" &&
      profiles.openclaw.projection.outputPaths.skillsDir === "openclaw/skills" &&
      profiles.cursor.projection.outputPaths.skillsDir === ".cursor/skills",
    "Runtime profiles must declare skillsDir for project runtime skill mirrors.",
  );
  assert(
    profiles.codex.projection.outputPaths.hooksDir === ".codex/hooks" &&
      profiles.codex.projection.outputPaths.hooksFile === ".codex/hooks.json",
    "Codex runtime profile must declare hook cleanup/config paths.",
  );
  assert(
    profiles.cursor.projection.assetTypes.includes("hooks") &&
      profiles.cursor.projection.assetTypes.includes("rules") &&
      profiles.cursor.projection.outputPaths.hooksDir === ".cursor/hooks" &&
      profiles.cursor.projection.outputPaths.hooksFile === ".cursor/hooks.json" &&
      profiles.cursor.projection.outputPaths.rulesDir === ".cursor/rules",
    "Cursor runtime profile must declare hook cleanup/config and rule output paths.",
  );
  assert(
    !(manifest.generatedTargets?.cursor ?? []).includes(".cursor/hooks") &&
      (manifest.generatedTargets?.cursor ?? []).includes(".cursor/hooks.json") &&
      (manifest.generatedTargets?.cursor ?? []).includes(".cursor/rules"),
    "config/sync.json must advertise Cursor hook config/rule paths without project hook dirs.",
  );
}

function sortedJson(values) {
  return JSON.stringify([...values].sort());
}

async function validateRuntimeCompatibilityCatalog() {
  const catalog = JSON.parse(
    await fs.readFile(
      path.join(repoRoot, "config", "runtime-compatibility-catalog.json"),
      "utf8",
    ),
  );
  const manifest = await loadSyncManifest();
  const skillsManifest = JSON.parse(
    await fs.readFile(path.join(repoRoot, "config", "skills.json"), "utf8"),
  );

  assert(
    (catalog.schemaVersion ?? 0) >= 1,
    "runtime compatibility catalog schemaVersion must be >= 1.",
  );
  assert(
    catalog.decisionBoundary?.noAutoPromotionFromDependencyInstall === true &&
      catalog.decisionBoundary?.noAutoPromotionFromGenericSkillPath === true &&
      catalog.decisionBoundary?.noFormalClaimFromSurfaceMatch === true,
    "runtime compatibility catalog must forbid automatic promotion from dependency installs, generic paths, or primitive surface matches.",
  );
  const requiredSurfaces = [
    "instruction_context",
    "skill_workflow",
    "agent_mode",
    "hook_automation",
    "mcp_tooling",
    "command_cli",
    "memory_context",
    "permission_safety",
  ];
  for (const surface of requiredSurfaces) {
    assert(
      typeof catalog.surfaceTaxonomy?.[surface] === "string" &&
        catalog.surfaceTaxonomy[surface].trim(),
      `runtime compatibility catalog surfaceTaxonomy missing ${surface}.`,
    );
  }

  const products = catalog.products ?? [];
  assert(
    Array.isArray(products) && products.length >= 1,
    "runtime compatibility catalog must declare products.",
  );
  const productIds = products.map((product) => product.id);
  assert(
    new Set(productIds).size === productIds.length,
    "runtime compatibility catalog product ids must be unique.",
  );
  const byId = new Map(products.map((product) => [product.id, product]));
  const supportedTargets = new Set(manifest.supportedTargets ?? []);
  const defaultTargets = new Set(
    manifest.defaultTargets ?? manifest.supportedTargets ?? [],
  );
  const projectionIds = products
    .filter((product) => product.tier === "runtime_projection")
    .map((product) => product.id);

  assert(
    sortedJson(projectionIds) === sortedJson(supportedTargets),
    "runtime_projection catalog products must exactly match config/sync.json supportedTargets.",
  );

  for (const product of products) {
    const formal = product.formalProjection ?? {};
    if (product.tier === "runtime_projection") {
      assert(
        supportedTargets.has(product.id),
        `runtime_projection ${product.id} must be in config/sync.json supportedTargets.`,
      );
      assert(
        formal.inSyncManifest === true &&
          formal.hasRuntimeProfile === true &&
          formal.hasProjectionLayout === true,
        `runtime_projection ${product.id} must declare formal projection evidence.`,
      );
      assert(
        formal.isDefaultTarget === defaultTargets.has(product.id),
        `runtime_projection ${product.id} default-target flag must match config/sync.json.`,
      );
      continue;
    }

    assert(
      !supportedTargets.has(product.id) && !defaultTargets.has(product.id),
      `${product.id} must not be in config/sync.json until promoted to runtime_projection.`,
    );
    assert(
      formal.inSyncManifest === false &&
        formal.hasRuntimeProfile === false &&
        formal.hasProjectionLayout === false &&
        formal.isDefaultTarget === false,
      `${product.id} must not claim formal projection fields before promotion.`,
    );
  }

  const ecc = skillsManifest.skills?.find((skill) => skill.id === "ecc");
  assert(ecc, "config/skills.json must declare ecc.");
  const eccTargets = new Set(ecc.targets ?? []);
  for (const target of eccTargets) {
    const product = byId.get(target);
    assert(
      product,
      `runtime compatibility catalog is missing ECC target ${target}.`,
    );
    assert(
      product.dependencyInstall?.ecc?.support === "native",
      `runtime compatibility catalog must mark ECC target ${target} as native.`,
    );
  }

  const qoder = byId.get("qoder");
  assert(qoder, "runtime compatibility catalog must include qoder.");
  assert(
    qoder.tier === "candidate_probe" &&
      qoder.dependencyInstall?.ecc?.support === "not_supported" &&
      qoder.genericCompatibility?.status === "verified_current",
    "qoder must remain a verified generic candidate, not a formal projection or ECC target.",
  );
  assert(
    !eccTargets.has("qoder") && !supportedTargets.has("qoder"),
    "qoder must not be in ECC targets or sync supportedTargets until promoted.",
  );
  assert(
    (qoder.evidence ?? []).some(
      (entry) => entry.type === "github_issue" && entry.ref.includes("/issues/7"),
    ) &&
      (qoder.evidence ?? []).filter((entry) => entry.type === "official_docs")
        .length >= 4,
    "qoder candidate must be anchored to issue #7 and official Qoder docs.",
  );

  const candidateProfiles = [
    {
      id: "qoder",
      minDocs: 4,
      surfaces: [
        "instruction_context",
        "skill_workflow",
        "agent_mode",
        "hook_automation",
        "mcp_tooling",
      ],
      status: "verified_current",
    },
    {
      id: "trae",
      minDocs: 4,
      surfaces: [
        "instruction_context",
        "skill_workflow",
        "agent_mode",
        "mcp_tooling",
        "memory_context",
      ],
      status: "partial",
    },
    {
      id: "kiro",
      minDocs: 4,
      surfaces: [
        "instruction_context",
        "skill_workflow",
        "hook_automation",
        "mcp_tooling",
        "command_cli",
      ],
      status: "partial",
    },
    {
      id: "windsurf",
      minDocs: 4,
      surfaces: [
        "instruction_context",
        "skill_workflow",
        "hook_automation",
        "mcp_tooling",
        "memory_context",
      ],
      status: "partial",
    },
    {
      id: "cline",
      minDocs: 2,
      surfaces: ["instruction_context", "mcp_tooling", "permission_safety"],
      status: "partial",
    },
    {
      id: "roo-code",
      minDocs: 4,
      surfaces: [
        "instruction_context",
        "skill_workflow",
        "agent_mode",
        "mcp_tooling",
        "command_cli",
        "permission_safety",
      ],
      status: "partial",
    },
    {
      id: "continue",
      minDocs: 4,
      surfaces: [
        "instruction_context",
        "agent_mode",
        "mcp_tooling",
        "command_cli",
        "permission_safety",
      ],
      status: "partial",
    },
  ];
  for (const profile of candidateProfiles) {
    const product = byId.get(profile.id);
    assert(product, `runtime compatibility catalog must include candidate ${profile.id}.`);
    assert(
      product.tier === "candidate_probe" &&
        product.formalProjection?.inSyncManifest === false &&
        product.dependencyInstall?.ecc?.support === "not_supported" &&
        product.genericCompatibility?.status === profile.status,
      `${profile.id} must remain a candidate_probe with honest projection and ECC boundaries.`,
    );
    assert(
      !eccTargets.has(profile.id) && !supportedTargets.has(profile.id),
      `${profile.id} must not be in ECC targets or sync supportedTargets until promoted.`,
    );
    const surfaces = new Set(product.compatibilitySurfaces ?? []);
    for (const surface of profile.surfaces) {
      assert(surfaces.has(surface), `${profile.id} candidate missing ${surface} surface.`);
    }
    assert(
      (product.evidence ?? []).filter((entry) => entry.type === "official_docs")
        .length >= profile.minDocs,
      `${profile.id} candidate must cite enough official docs evidence.`,
    );
  }

  const cursor = byId.get("cursor");
  assert(cursor, "runtime compatibility catalog must include cursor.");
  assert(
    cursor.genericCompatibility?.agentPath === ".cursor/agents/{agent}.md" &&
      cursor.genericCompatibility?.hookConfig === ".cursor/hooks.json" &&
      (cursor.evidence ?? []).some(
        (entry) => entry.type === "official_docs" && entry.ref.includes("cursor.com/docs/subagents"),
      ) &&
      (cursor.evidence ?? []).some(
        (entry) => entry.type === "official_docs" && entry.ref.includes("cursor.com/docs/hooks"),
      ) &&
      (cursor.evidence ?? []).some(
        (entry) => entry.type === "official_docs" && entry.ref.includes("cursor.com/docs/rules"),
      ),
    "Cursor runtime projection must cite official subagent, hook, and rule docs.",
  );

  const openclaw = byId.get("openclaw");
  assert(openclaw, "runtime compatibility catalog must include openclaw.");
  assert(
    openclaw.genericCompatibility?.status === "verified_current" &&
      /strict OpenClaw self-test evidence/i.test(openclaw.nextAction ?? "") &&
      (openclaw.evidence ?? []).some(
        (entry) => entry.type === "official_docs" && entry.ref.includes("docs.openclaw.ai/concepts/agent"),
      ) &&
      (openclaw.evidence ?? []).some(
        (entry) => entry.type === "official_docs" && entry.ref.includes("docs.openclaw.ai/automation/hooks"),
      ),
    "OpenClaw runtime projection must preserve official workspace/hook evidence and require strict OpenClaw self-test evidence that passes review before merge.",
  );
}


async function validateSkillsManifest() {
  const manifest = JSON.parse(
    await fs.readFile(path.join(repoRoot, "config", "skills.json"), "utf8"),
  );
  const hookprompt = manifest.skills?.find((skill) => skill.id === "hookprompt");
  assert(hookprompt, "config/skills.json must declare hookprompt.");
  assert(
    hookprompt.capabilities?.includes("prompt-submission-optimization"),
    "hookprompt must declare prompt-submission-optimization capability.",
  );
  assert(
    hookprompt.targets?.includes("claude") &&
      hookprompt.targets?.includes("codex") &&
      hookprompt.targets?.includes("cursor"),
    "hookprompt targets must install native Claude support plus Codex and Cursor adapter support.",
  );
  assert(
    hookprompt.platformSupport?.claude?.status === "native" &&
      hookprompt.platformSupport?.codex?.status === "adapter-required" &&
      hookprompt.platformSupport?.cursor?.status === "adapter-required",
    "hookprompt platformSupport must distinguish native, adapter-required, and degraded runtimes.",
  );

  const planning = manifest.skills?.find(
    (skill) => skill.id === "planning-with-files",
  );
  assert(
    planning?.globalHookSubdirs?.cursor && planning?.globalHookConfigFiles?.cursor,
    "planning-with-files must install Cursor lifecycle hooks globally.",
  );
}

function step(num, total, label, detail = "") {
  console.log(`\n[${num}/${total}] ${label}`);
  if (detail) console.log(`${detail}`);
}

function pass(msg = "") {
  console.log(`✓ ${msg}`);
}

function fail(msg) {
  console.error(`✗ ${msg}`);
}

/**
 * EB-004 deprecation check (v2.3.1, warn-only).
 *
 * Scans .meta-kim/state/<profile>/spine/spine-state.json files for
 * `preDecisionOptionFrame.{choiceSurfaceState,solutionChoiceState,choiceGateSkip}`
 * — these fields belong on the top-level `state` object, not nested inside
 * `preDecisionOptionFrame`. The frame describes the question; user answers
 * and state markers live at the top level.
 *
 * v2.3.1 emits warnings only. v2.4.0 will fail validation when legacy nesting
 * is found. A helper script `scripts/migrate-spine-state-eb004.mjs` promotes
 * the fields and removes the legacy nesting.
 *
 * @returns {Promise<{warnings: string[]}>}
 */
async function validateSpineStateChoiceFieldLocations() {
  const warnings = [];
  const stateDir = path.join(repoRoot, ".meta-kim", "state");
  if (!(await exists(stateDir))) {
    return { warnings };
  }

  let profiles;
  try {
    profiles = await fs.readdir(stateDir);
  } catch {
    return { warnings };
  }

  const legacyFields = [
    "choiceSurfaceState",
    "solutionChoiceState",
    "choiceGateSkip",
  ];

  for (const profile of profiles) {
    const stateFile = path.join(stateDir, profile, "spine", "spine-state.json");
    if (!(await exists(stateFile))) continue;
    let state;
    try {
      state = JSON.parse(await fs.readFile(stateFile, "utf8"));
    } catch {
      continue;
    }
    const frame = state?.preDecisionOptionFrame;
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) continue;
    for (const legacyField of legacyFields) {
      if (frame[legacyField] !== undefined) {
        warnings.push(
          `[EB-004 deprecation, v2.3.1 warn-only] '${toRepoRelative(stateFile)}': ` +
            `preDecisionOptionFrame.${legacyField} should be moved to state.${legacyField} ` +
            `(top-level). Will FAIL in v2.4.0. ` +
            `See docs/v2.3.1-rfc-EB-004-preDecisionOptionFrame-nesting.md. ` +
            `Helper: scripts/migrate-spine-state-eb004.mjs.`,
        );
      }
    }
  }

  return { warnings };
}

async function main() {
  const TOTAL = 7;
  let current = 1;

  console.log("\n========================================");
  console.log(t.val.headerTitle);
  console.log("========================================");

  // 1. Required files
  step(current++, TOTAL, t.val.step01, t.val.step01Detail);
  await validateRequiredFiles();
  pass(t.val.step01Pass);

  // 2. Workflow contract
  step(current++, TOTAL, t.val.step02, t.val.step02Detail);
  await validateCoreLoopContract();
  await validateWorkflowContract();
  pass(t.val.step02Pass);

  // 3. Sync manifest and runtime target catalog
  step(current++, TOTAL, t.val.step03, t.val.step03Detail);
  await validateSyncConfiguration();
  await validateRuntimeCompatibilityCatalog();
  pass(t.val.step03Pass);

  // 4. Canonical agent definitions
  step(current++, TOTAL, t.val.step04, t.val.step04Detail);
  const agentIds = await validateClaudeAgents();
  pass(t.val.step04Pass(agentIds.length, agentIds));

  // 5. Canonical meta-theory skill
  step(current++, TOTAL, t.val.step05, t.val.step05Detail);
  await validatePortableSkill();
  pass(t.val.step05Pass);

  // 6. Skills manifest
  step(current++, TOTAL, t.val.step06, t.val.step06Detail);
  await validateSkillsManifest();
  pass(t.val.step06Pass);

  // 7. Canonical capability index
  step(current++, TOTAL, t.val.step07, t.val.step07Detail);
  await validateCapabilityIndex();
  pass(t.val.step07Pass);

  // EB-004 deprecation check (warn-only, does not gate validation).
  const eb004Result = await validateSpineStateChoiceFieldLocations();

  console.log("\n========================================");
  console.log(t.val.footerAll(TOTAL));
  console.log(t.val.footerAgents(agentIds.length));
  if (eb004Result.warnings.length > 0) {
    console.log("----------------------------------------");
    console.log(
      `EB-004 deprecation warnings (v2.3.1 warn-only, will FAIL in v2.4.0):`,
    );
    for (const warning of eb004Result.warnings) {
      console.log(`  ! ${warning}`);
    }
  }
  console.log("========================================\n");
}

try {
  await main();
} catch (error) {
  console.error("\n    " + t.val.valFailed);
  console.error(`    ${error.message}\n`);
  process.exitCode = 1;
}
