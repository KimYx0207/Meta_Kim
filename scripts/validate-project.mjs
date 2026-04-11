import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  canonicalAgentsDir,
  canonicalRuntimeAssetsDir,
  canonicalSkillPath,
  canonicalSkillReferencesDir,
  loadRuntimeProfiles,
  loadSyncManifest,
} from "./meta-kim-sync-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const execFileAsync = promisify(execFile);
const canonicalClaudeSettingsPath = path.join(
  canonicalRuntimeAssetsDir,
  "claude",
  "settings.json",
);
const canonicalClaudeMcpPath = path.join(
  canonicalRuntimeAssetsDir,
  "claude",
  "mcp.json",
);
const canonicalCodexConfigExamplePath = path.join(
  canonicalRuntimeAssetsDir,
  "codex",
  "config.toml.example",
);
const canonicalOpenClawTemplatePath = path.join(
  canonicalRuntimeAssetsDir,
  "openclaw",
  "openclaw.template.json",
);

/** Must match config/contracts/workflow-contract.json runDiscipline.publicDisplayRequires (set equality). */
const EXPECTED_PUBLIC_DISPLAY_REQUIRES = [
  "verifyPassed",
  "summaryClosed",
  "singleDeliverableMaintained",
  "deliverableChainClosed",
  "consolidatedDeliverablePresent",
];

/** Documented in AGENTS.md / CLAUDE.md — project hook commands (Stop may list multiple). */
const EXPECTED_CLAUDE_HOOK_COMMANDS = [
  "node .claude/hooks/block-dangerous-bash.mjs",
  "node .claude/hooks/pre-git-push-confirm.mjs",
  "node .claude/hooks/post-format.mjs",
  "node .claude/hooks/post-typecheck.mjs",
  "node .claude/hooks/post-console-log-warn.mjs",
  "node .claude/hooks/subagent-context.mjs",
  "node .claude/hooks/stop-console-log-audit.mjs",
  "node .claude/hooks/stop-completion-guard.mjs",
];

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
    "Fallback Plan",
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
      .replace(/shared-skills\//g, "shared-skill ")
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

async function listCanonicalSkillReferences() {
  const entries = await fs.readdir(canonicalSkillReferencesDir, {
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
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
    "config/contracts/workflow-contract.json",
    "docs/runtime-capability-matrix.md",
    "memory/patterns/.gitkeep",
    "memory/scars/.gitkeep",
    "memory/capability-gaps.md",
    "scripts/mcp/meta-runtime-server.mjs",
    "scripts/eval-meta-agents.mjs",
    "scripts/prepare-openclaw-local.mjs",
    "scripts/validate-run-artifact.mjs",
    "tests/fixtures/run-artifacts/valid-run.json",
    "tests/fixtures/run-artifacts/invalid-run-public-ready.json",
  ];

  for (const relativePath of requiredFiles) {
    assert(
      await exists(path.join(repoRoot, relativePath)),
      `Missing required file: ${relativePath}`,
    );
  }
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
    (contract.schemaVersion ?? 0) >= 5,
    "workflow-contract.json schemaVersion must be >= 5 after execution-agent factory hardening.",
  );
  assert(
    contract.runDiscipline?.singleDepartmentPerRun === true,
    "workflow-contract.json must enforce singleDepartmentPerRun.",
  );
  assert(
    contract.runDiscipline?.singlePrimaryDeliverable === true,
    "workflow-contract.json must enforce singlePrimaryDeliverable.",
  );
  assert(
    contract.runDiscipline?.rejectMultiTopicRuns === true,
    "workflow-contract.json must reject multi-topic runs.",
  );
  assert(
    contract.runDiscipline?.requireClosedDeliverableChain === true,
    "workflow-contract.json must require a closed deliverable chain.",
  );

  const requiredRunHeader = [
    "department",
    "primaryDeliverable",
    "audience",
    "freshnessRequirement",
    "visualPolicy",
    "handoffPlan",
  ];
  assert(
    JSON.stringify(contract.runDiscipline?.requiredRunHeader ?? []) ===
      JSON.stringify(requiredRunHeader),
    "workflow-contract.json requiredRunHeader is out of policy.",
  );

  for (const field of [
    "todayTask",
    "output",
    "deliverableLink",
    "qualityBar",
    "referenceDirection",
    "handoffTarget",
    "lengthExpectation",
    "visualOrAssetPlan",
  ]) {
    assert(
      contract.runDiscipline?.requiredWorkerFields?.includes(field),
      `workflow-contract.json requiredWorkerFields must include ${field}.`,
    );
  }

  const publicDisplayRequires = contract.runDiscipline?.publicDisplayRequires;
  assert(
    Array.isArray(publicDisplayRequires),
    "workflow-contract.json must define publicDisplayRequires as an array.",
  );
  assert(
    JSON.stringify([...publicDisplayRequires].sort()) ===
      JSON.stringify([...EXPECTED_PUBLIC_DISPLAY_REQUIRES].sort()),
    "workflow-contract.json publicDisplayRequires must exactly match the canonical public-display gate set.",
  );
  assert(
    contract.gates?.dealer?.primaryOwner === "meta-conductor" &&
      contract.gates?.dealer?.escalationOwner === "meta-warden",
    "workflow-contract.json dealer gate must model meta-conductor primary + meta-warden escalation ownership.",
  );
  for (const source of ["meta-sentinel", "meta-prism", "user", "system"]) {
    assert(
      contract.gates?.dealer?.interruptSources?.includes(source),
      `workflow-contract.json dealer gate must include interrupt source ${source}.`,
    );
  }

  assert(
    contract.gates?.publicDisplay?.owner === "meta-warden",
    "workflow-contract.json publicDisplay gate owner must be meta-warden.",
  );
  assert(
    contract.gates?.publicDisplay?.hardReleaseGate === true,
    "workflow-contract.json publicDisplay gate must be a hard release gate.",
  );
  assert(
    JSON.stringify(
      [...(contract.gates?.publicDisplay?.requiredConditions ?? [])].sort(),
    ) === JSON.stringify([...EXPECTED_PUBLIC_DISPLAY_REQUIRES].sort()),
    "workflow-contract.json publicDisplay requiredConditions must match publicDisplayRequires.",
  );
  for (const field of [
    "blockFinalDraftWithoutVerifiedRun",
    "blockExternalDisplayWithoutSummaryClosure",
    "blockCompletionWithoutClosedDeliverableChain",
  ]) {
    assert(
      contract.gates?.publicDisplay?.[field] === true,
      `workflow-contract.json publicDisplay gate must set ${field} to true.`,
    );
  }

  const taskClassification = contract.runDiscipline?.taskClassification;
  assert(
    taskClassification?.classifierVersion === "v2",
    "workflow-contract.json taskClassification classifierVersion must be v2.",
  );
  for (const [field, expected] of [
    ["taskClassEnum", ["Q", "A", "P", "S"]],
    ["requestClassEnum", ["query", "execute", "plan", "strategy"]],
    [
      "governanceFlowEnum",
      [
        "query",
        "simple_exec",
        "complex_dev",
        "meta_analysis",
        "proposal_review",
        "rhythm",
      ],
    ],
    [
      "triggerReasonEnum",
      [
        "multi_file",
        "cross_module",
        "external_side_effect",
        "durable_artifact",
        "owner_missing",
      ],
    ],
    [
      "upgradeReasonEnum",
      [
        "cross_system_scope",
        "review_or_verify_required",
        "owner_creation_required",
      ],
    ],
    [
      "bypassReasonEnum",
      [
        "pure_query",
        "read_only_explanation",
        "existing_verified_artifact_reuse",
      ],
    ],
  ]) {
    for (const item of expected) {
      assert(
        taskClassification?.[field]?.includes(item),
        `workflow-contract.json taskClassification.${field} must include ${item}.`,
      );
    }
  }
  assert(
    taskClassification?.ownerRequiredByDefault === true &&
      taskClassification?.onlyQueryMayBypassOwner === true,
    "workflow-contract.json taskClassification must keep owner-required-by-default discipline.",
  );

  const cardGovernance = contract.runDiscipline?.cardGovernance;
  assert(
    cardGovernance?.enabled === true,
    "workflow-contract.json cardGovernance must be enabled.",
  );
  assert(
    cardGovernance?.dealerRoleModel === "conductor-primary-warden-escalation",
    "workflow-contract.json cardGovernance dealerRoleModel must be conductor-primary-warden-escalation.",
  );
  for (const [field, expected] of [
    [
      "cardTypeEnum",
      ["info", "action", "risk", "silence", "default", "upgrade"],
    ],
    [
      "cardDecisionEnum",
      ["deal", "suppress", "defer", "skip", "interrupt_insert", "escalate"],
    ],
    [
      "cardAudienceEnum",
      ["user", "owner", "reviewer", "governance", "runtime"],
    ],
    [
      "cardTimingEnum",
      [
        "immediate",
        "next_stage",
        "after_dependency",
        "after_verify",
        "on_risk",
        "on_timeout",
        "on_user_request",
      ],
    ],
    [
      "cardShellEnum",
      [
        "conversation",
        "file",
        "packet",
        "agent_dispatch",
        "summary",
        "silent_hold",
      ],
    ],
    [
      "cardSourceEnum",
      [
        "meta-conductor",
        "meta-warden",
        "meta-sentinel",
        "meta-prism",
        "system",
        "user",
      ],
    ],
    [
      "suppressionReasonEnum",
      [
        "attention_budget_low",
        "already_known",
        "already_in_context",
        "verification_pending",
        "public_display_blocked",
        "no_clear_intervention_gain",
      ],
    ],
  ]) {
    for (const item of expected) {
      assert(
        cardGovernance?.[field]?.includes(item),
        `workflow-contract.json cardGovernance.${field} must include ${item}.`,
      );
    }
  }
  assert(
    cardGovernance?.defaultNoCardPolicy ===
      "prefer_silence_without_clear_intervention_gain",
    "workflow-contract.json cardGovernance must define the default no-card policy.",
  );

  const silencePolicy = contract.runDiscipline?.silencePolicy;
  assert(
    silencePolicy?.noInterventionPreferred === true &&
      silencePolicy?.requiresInterruptionJustification === true &&
      silencePolicy?.deferRequiresDeadline === true,
    "workflow-contract.json silencePolicy must prefer no-intervention and require interruption/defer discipline.",
  );
  for (const item of ["none", "no_card", "defer", "intentional_silence"]) {
    assert(
      silencePolicy?.silenceDecisionEnum?.includes(item),
      `workflow-contract.json silencePolicy.silenceDecisionEnum must include ${item}.`,
    );
  }

  const controlIntervention = contract.runDiscipline?.controlIntervention;
  assert(
    controlIntervention?.requiresReturnToMainChain === true,
    "workflow-contract.json controlIntervention must require return-to-main-chain discipline.",
  );
  for (const [field, expected] of [
    [
      "decisionTypeEnum",
      ["skip", "interrupt", "override", "escalation_insert"],
    ],
    [
      "skipReasonEnum",
      [
        "already_known",
        "already_in_context",
        "attention_budget_low",
        "not_applicable",
        "artifact_not_needed",
      ],
    ],
    [
      "interruptReasonEnum",
      [
        "security_risk",
        "quality_drift",
        "user_urgent",
        "system_failure",
        "global_impact",
      ],
    ],
    [
      "overrideReasonEnum",
      [
        "security_override",
        "verification_block",
        "public_display_block",
        "governance_owner_insert",
      ],
    ],
    [
      "insertedGovernanceOwners",
      ["meta-sentinel", "meta-prism", "meta-warden", "meta-conductor"],
    ],
  ]) {
    for (const item of expected) {
      assert(
        controlIntervention?.[field]?.includes(item),
        `workflow-contract.json controlIntervention.${field} must include ${item}.`,
      );
    }
  }

  const deliveryShell = contract.runDiscipline?.deliveryShell;
  for (const [field, expected] of [
    [
      "shellTypeEnum",
      [
        "one_line",
        "structured_status",
        "technical_detail",
        "review_delta",
        "executive_summary",
        "artifact_link",
      ],
    ],
    ["presentationModeEnum", ["direct", "digest", "deferred", "quiet"]],
    ["exposureLevelEnum", ["internal", "review", "public"]],
    [
      "interventionFormEnum",
      [
        "conversation",
        "file_write",
        "task_packet",
        "agent_dispatch",
        "notification",
        "none",
      ],
    ],
  ]) {
    for (const item of expected) {
      assert(
        deliveryShell?.[field]?.includes(item),
        `workflow-contract.json deliveryShell.${field} must include ${item}.`,
      );
    }
  }

  const requiredPackets =
    contract.runDiscipline?.protocolFirst?.requiredPackets ?? [];
  for (const packet of [
    "runHeader",
    "taskClassification",
    "cardPlanPacket",
    "orchestrationTaskBoardPacket",
    "dispatchBoard",
    "workerTaskPacket",
    "workerResultPacket",
    "reviewPacket",
    "verificationPacket",
    "summaryPacket",
    "evolutionWritebackPacket",
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
      contract.runDiscipline?.protocolFirst?.orchestrationTaskBoardPacketRequiredWhenGovernanceFlows?.includes(
        flow,
      ),
      `workflow-contract.json orchestrationTaskBoardPacketRequiredWhenGovernanceFlows must include ${flow}.`,
    );
  }
  assert(
    contract.runDiscipline?.protocolFirst?.capabilityGapPacketRequiredWhenUpgradeReasons?.includes(
      "owner_creation_required",
    ),
    "workflow-contract.json capabilityGapPacketRequiredWhenUpgradeReasons must include owner_creation_required.",
  );
  for (const action of [
    "create_execution_agent",
    "upgrade_execution_agent",
  ]) {
    assert(
      contract.runDiscipline?.protocolFirst?.executionAgentCardRequiredWhenResolutionActions?.includes(
        action,
      ),
      `workflow-contract.json executionAgentCardRequiredWhenResolutionActions must include ${action}.`,
    );
  }

  const findingClosure = contract.runDiscipline?.findingClosure;
  for (const field of [
    "findingIdRequired",
    "reviewFindingRequiresRevisionResponse",
    "revisionResponseRequiresFixArtifact",
    "verificationRequiresFreshEvidence",
    "closureRequiresVerificationResult",
  ]) {
    assert(
      findingClosure?.[field] === true,
      `workflow-contract.json findingClosure must set ${field} to true.`,
    );
  }
  for (const closeState of [
    "open",
    "fixed_pending_verify",
    "verified_closed",
    "accepted_risk",
  ]) {
    assert(
      findingClosure?.closeStateEnum?.includes(closeState),
      `workflow-contract.json findingClosure.closeStateEnum must include ${closeState}.`,
    );
  }
  for (const transition of [
    "open->fixed_pending_verify",
    "fixed_pending_verify->verified_closed",
    "fixed_pending_verify->accepted_risk",
  ]) {
    assert(
      findingClosure?.legalTransitions?.includes(transition),
      `workflow-contract.json findingClosure.legalTransitions must include ${transition}.`,
    );
  }

  const reviewPacketFields =
    contract.protocols?.reviewPacket?.requiredFields ?? [];
  assert(
    reviewPacketFields.includes("findings"),
    "workflow-contract.json reviewPacket must require findings.",
  );
  for (const [protocolName, expectedFields] of [
    [
      "taskClassification",
      [
        "taskClass",
        "requestClass",
        "governanceFlow",
        "triggerReasons",
        "upgradeReasons",
        "bypassReasons",
        "ownerRequired",
        "decisionSource",
        "classifierVersion",
        "complexity",
      ],
    ],
    [
      "cardPlanPacket",
      [
        "dealerOwner",
        "dealerMode",
        "cards",
        "deliveryShells",
        "silenceDecision",
        "controlDecisions",
        "defaultShellId",
      ],
    ],
    [
      "orchestrationTaskBoardPacket",
      ["dispatchBoardId", "boardMode", "tasks", "synthesisOwner"],
    ],
    [
      "orchestrationTask",
      ["taskId", "taskKind", "owner", "sequence", "dependsOn", "deliverable"],
    ],
    [
      "capabilityGapPacket",
      [
        "gapId",
        "requestedCapability",
        "currentAgentsChecked",
        "insufficiencyReason",
        "resolutionAction",
        "requestedBy",
        "approvedBy",
      ],
    ],
    [
      "executionAgentCard",
      [
        "agentId",
        "purpose",
        "capabilities",
        "nonCapabilities",
        "dependencies",
        "inputs",
        "outputs",
      ],
    ],
    [
      "cardDecision",
      [
        "cardId",
        "cardType",
        "cardIntent",
        "cardDecision",
        "cardAudience",
        "cardTiming",
        "cardShell",
        "cardPriority",
        "cardReason",
        "cardSource",
        "cardSuppressed",
        "suppressionReason",
        "deliveryShellId",
      ],
    ],
    [
      "deliveryShell",
      [
        "deliveryShellId",
        "shellType",
        "presentationMode",
        "exposureLevel",
        "interventionForm",
        "audience",
        "contentBoundary",
      ],
    ],
    [
      "silenceDecision",
      [
        "silenceDecision",
        "noInterventionPreferred",
        "interruptionJustified",
        "deferUntil",
        "reasonForSilence",
      ],
    ],
    [
      "controlDecision",
      [
        "decisionId",
        "decisionType",
        "skipReason",
        "interruptReason",
        "overrideReason",
        "insertedGovernanceOwner",
        "emergencyGovernanceTriggered",
        "returnsToStage",
        "rejoinCondition",
      ],
    ],
    [
      "reviewFinding",
      [
        "findingId",
        "severity",
        "owner",
        "summary",
        "requiredAction",
        "fixArtifact",
        "verifiedBy",
        "closeState",
      ],
    ],
    [
      "revisionResponse",
      [
        "findingId",
        "actionId",
        "owner",
        "responseType",
        "status",
        "fixArtifact",
        "responseSummary",
      ],
    ],
    [
      "verificationResult",
      ["findingId", "verifiedBy", "result", "evidence", "closeState"],
    ],
    [
      "summaryPacket",
      [
        "verifyPassed",
        "summaryClosed",
        "singleDeliverableMaintained",
        "deliverableChainClosed",
        "consolidatedDeliverablePresent",
        "publicReady",
        "deliveryShellsUsed",
        "blockedBy",
      ],
    ],
  ]) {
    const fields = contract.protocols?.[protocolName]?.requiredFields ?? [];
    for (const field of expectedFields) {
      assert(
        fields.includes(field),
        `workflow-contract.json protocol ${protocolName} must require ${field}.`,
      );
    }
  }

  const verificationPacketFields =
    contract.protocols?.verificationPacket?.requiredFields ?? [];
  for (const field of [
    "verified",
    "remainingIssues",
    "evidence",
    "fixEvidence",
    "revisionResponses",
    "verificationResults",
    "closeFindings",
  ]) {
    assert(
      verificationPacketFields.includes(field),
      `workflow-contract.json verificationPacket must require ${field}.`,
    );
  }

  assert(
    contract.runDiscipline?.evolutionDecision?.required === true,
    "workflow-contract.json must require an explicit evolution decision.",
  );
  for (const field of ["writeback", "none"]) {
    assert(
      contract.runDiscipline?.evolutionDecision?.allowedDecisions?.includes(
        field,
      ),
      `workflow-contract.json evolutionDecision.allowedDecisions must include ${field}.`,
    );
  }
  assert(
    contract.runDiscipline?.evolutionDecision?.noneRequiresReason === true &&
      contract.runDiscipline?.evolutionDecision?.writebackRequiresTargets ===
        true,
    "workflow-contract.json evolutionDecision must require either writeback targets or an explicit reason.",
  );
  const evolutionFields =
    contract.protocols?.evolutionWritebackPacket?.requiredFields ?? [];
  for (const field of [
    "ownerAssessment",
    "writebackDecision",
    "decisionReason",
    "writebacks",
    "retain",
    "upgrade",
    "retire",
    "scarIds",
    "syncRequired",
  ]) {
    assert(
      evolutionFields.includes(field),
      `workflow-contract.json evolutionWritebackPacket must require ${field}.`,
    );
  }
  const publicDisplayGate = contract.runDiscipline?.publicDisplayGate;
  for (const field of [
    "hardReleaseGate",
    "blockDisplayBeforeVerification",
    "blockDisplayBeforeSummaryClosure",
    "blockCompletionBeforeDeliverableClosure",
  ]) {
    assert(
      publicDisplayGate?.[field] === true,
      `workflow-contract.json publicDisplayGate must set ${field} to true.`,
    );
  }

  const runArtifactValidation = contract.runDiscipline?.runArtifactValidation;
  assert(
    runArtifactValidation?.script === "scripts/validate-run-artifact.mjs",
    "workflow-contract.json must point runArtifactValidation to scripts/validate-run-artifact.mjs.",
  );
  for (const field of [
    "findingLineageRequired",
    "deliverableLinkMustReferencePrimaryDeliverable",
    "summaryPacketRequired",
    "cardPlanPacketRequired",
    "orchestrationTaskBoardPacketRequired",
  ]) {
    assert(
      runArtifactValidation?.[field] === true,
      `workflow-contract.json runArtifactValidation must set ${field} to true.`,
    );
  }
  assert(
    runArtifactValidation?.publicReadyField === "summaryPacket.publicReady",
    "workflow-contract.json runArtifactValidation must point publicReadyField to summaryPacket.publicReady.",
  );

  assert(
    contract.departmentVisualPolicies?.game?.defaultMode ===
      "generate_or_self_create",
    "workflow-contract.json game visual policy must default to generate_or_self_create.",
  );
  assert(
    contract.departmentVisualPolicies?.ai?.defaultMode ===
      "official_or_verified_reference",
    "workflow-contract.json ai visual policy must default to official_or_verified_reference.",
  );
}

async function validateRuntimeParityMatrix() {
  const matrixPath = path.join(
    repoRoot,
    "docs",
    "runtime-capability-matrix.md",
  );
  const raw = await fs.readFile(matrixPath, "utf8");

  for (const marker of [
    "行为一致性对照表",
    "trigger parity",
    "card parity",
    "silence parity",
    "control-decision parity",
    "shell parity",
    "hook parity",
    "review parity",
    "verification parity",
    "stop condition parity",
    "writeback parity",
    "run artifact parity",
    "`npm run eval:agents`",
    "`npm run eval:agents:live`",
  ]) {
    assert(
      raw.includes(marker),
      `docs/runtime-capability-matrix.md must include ${marker}.`,
    );
  }
}

async function validateRunArtifactFixtures() {
  const validFixture = path.join(
    repoRoot,
    "tests",
    "fixtures",
    "run-artifacts",
    "valid-run.json",
  );
  const invalidFixture = path.join(
    repoRoot,
    "tests",
    "fixtures",
    "run-artifacts",
    "invalid-run-public-ready.json",
  );

  await execFileAsync(
    "node",
    ["scripts/validate-run-artifact.mjs", validFixture],
    {
      cwd: repoRoot,
      timeout: 30_000,
    },
  );

  let invalidPassed = false;
  try {
    await execFileAsync(
      "node",
      ["scripts/validate-run-artifact.mjs", invalidFixture],
      {
        cwd: repoRoot,
        timeout: 30_000,
      },
    );
    invalidPassed = true;
  } catch {
    invalidPassed = false;
  }

  assert(
    invalidPassed === false,
    "scripts/validate-run-artifact.mjs must reject the invalid public-ready fixture.",
  );
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

async function validateOpenClawArtifacts(agentIds) {
  const templateConfig = JSON.parse(
    await fs.readFile(canonicalOpenClawTemplatePath, "utf8"),
  );
  const configIds = templateConfig.agents?.list?.map((agent) => agent.id) ?? [];
  const sortedAgentIds = [...agentIds].sort();
  const sortedConfigIds = [...configIds].sort();

  assert(
    typeof templateConfig.agents?.defaults?.model === "string" &&
      templateConfig.agents.defaults.model.length >= 1,
    "canonical/runtime-assets/openclaw/openclaw.template.json is missing a default model.",
  );

  assert(
    JSON.stringify(sortedConfigIds) === JSON.stringify(sortedAgentIds),
    "canonical OpenClaw template agent list is out of sync with canonical/agents.",
  );

  const allowedIds = templateConfig.tools?.agentToAgent?.allow ?? [];
  const sortedAllowedIds = [...allowedIds].sort();
  assert(
    JSON.stringify(sortedAllowedIds) === JSON.stringify(sortedAgentIds),
    "Canonical OpenClaw agentToAgent allow-list is out of sync with canonical/agents.",
  );

  const hookEntries = templateConfig.hooks?.internal?.entries;
  assert(
    templateConfig.hooks?.internal?.enabled === true,
    "canonical OpenClaw template must enable internal hooks.",
  );
  for (const hookName of ["session-memory", "command-logger", "boot-md"]) {
    assert(
      hookEntries?.[hookName]?.enabled === true,
      `canonical OpenClaw template is missing enabled hook ${hookName}.`,
    );
  }
}

async function validatePortableSkill() {
  const referenceFiles = await listCanonicalSkillReferences();
  const skillSourcePath = canonicalSkillPath;
  const skillSource = await fs.readFile(skillSourcePath, "utf8");

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
      skillSource.includes(marker),
      `Portable skill is missing station-deliverable marker ${marker}.`,
    );
  }
  assertNoForbiddenMarkers(skillSource, skillSourcePath, ["AskUserQuestion"]);
  const descriptionMatch = skillSource.match(
    /description:\s*\|\r?\n([\s\S]*?)\r?\n---/,
  );
  if (descriptionMatch) {
    const descriptionLength = descriptionMatch[1].trim().length;
    assert(
      descriptionLength <= 1024,
      `Canonical meta-theory skill description is too long for Codex compatibility (${descriptionLength} > 1024).`,
    );
  }

  for (const referenceFile of referenceFiles) {
    const canonicalReferencePath = path.join(
      canonicalSkillReferencesDir,
      referenceFile,
    );
    const canonicalReference = await fs.readFile(
      canonicalReferencePath,
      "utf8",
    );
    assertNoForbiddenMarkers(canonicalReference, canonicalReferencePath, [
      "AskUserQuestion",
    ]);
  }
}

async function validateSyncConfiguration() {
  const manifest = await loadSyncManifest();
  const profiles = await loadRuntimeProfiles(manifest);

  const supportedTargets = manifest.supportedTargets ?? [];
  const defaultTargets = manifest.defaultTargets ?? supportedTargets;
  const availableTargets = manifest.availableTargets ?? Object.keys(profiles);
  const generatedTargets = manifest.generatedTargets ?? {};

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
    availableTargets.every((target) =>
      Object.prototype.hasOwnProperty.call(profiles, target),
    ),
    "config/sync.json availableTargets must only reference known runtime targets.",
  );
  assert(
    supportedTargets.every(
      (target) =>
        Array.isArray(generatedTargets[target]) && generatedTargets[target].length > 0,
    ),
    "config/sync.json must declare generatedTargets for every supported target.",
  );
}

async function validateCodexArtifacts() {
  const configExample = await fs.readFile(
    canonicalCodexConfigExamplePath,
    "utf8",
  );
  for (const expected of [
    "approval_policy",
    "sandbox_mode",
    "[agents]",
    "[mcp_servers.meta_kim_runtime]",
    ".agents/skills/",
  ]) {
    assert(
      configExample.includes(expected),
      `canonical/runtime-assets/codex/config.toml.example is missing ${expected}`,
    );
  }
}

async function validatePackageJson() {
  const packageJsonPath = path.join(repoRoot, "package.json");
  const pkg = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  assert(
    pkg.scripts?.["sync:runtimes"],
    "package.json is missing sync:runtimes.",
  );
  assert(pkg.scripts?.validate, "package.json is missing validate.");
  assert(
    pkg.scripts?.["validate:run"],
    "package.json is missing validate:run.",
  );
  assert(pkg.scripts?.["eval:agents"], "package.json is missing eval:agents.");
  assert(pkg.scripts?.["verify:all"], "package.json is missing verify:all.");
  assert(
    !pkg.scripts?.["sync:global:meta-theory:codex-active"],
    "package.json should not keep the legacy sync:global:meta-theory:codex-active script.",
  );
  assert(
    pkg.scripts?.["prepare:openclaw-local"],
    "package.json is missing prepare:openclaw-local.",
  );
  assert(
    pkg.dependencies?.["@modelcontextprotocol/sdk"],
    "package.json is missing @modelcontextprotocol/sdk.",
  );
  assert(pkg.dependencies?.zod, "package.json is missing zod.");
  assert(pkg.license === "MIT", "package.json license must be MIT.");
}

async function validateGitignore() {
  const gitignorePath = path.join(repoRoot, ".gitignore");
  const gitignore = await fs.readFile(gitignorePath, "utf8");
  for (const expected of [
    "node_modules/",
    "docs/",
    "openclaw/workspaces/*/.openclaw/",
    ".meta-kim/state/",
    ".meta-kim/local.overrides.json",
  ]) {
    assert(gitignore.includes(expected), `.gitignore is missing ${expected}`);
  }
}

function collectClaudeHookCommands(hooksRoot) {
  const commands = [];
  if (!hooksRoot || typeof hooksRoot !== "object") {
    return commands;
  }
  for (const entries of Object.values(hooksRoot)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      for (const hook of entry.hooks ?? []) {
        if (hook?.type === "command" && typeof hook.command === "string") {
          commands.push(hook.command.trim());
        }
      }
    }
  }
  return commands;
}

async function validateClaudeSettings() {
  const settings = JSON.parse(
    await fs.readFile(canonicalClaudeSettingsPath, "utf8"),
  );
  assert(
    settings.permissions?.deny?.length >= 1,
    "canonical/runtime-assets/claude/settings.json is missing deny rules.",
  );
  const hooks = settings.hooks;
  assert(
    hooks?.PreToolUse?.length >= 1,
    "canonical Claude settings are missing PreToolUse hooks.",
  );
  assert(
    hooks?.PostToolUse?.length >= 1,
    "canonical Claude settings are missing PostToolUse hooks.",
  );
  assert(
    hooks?.SubagentStart?.length >= 1,
    "canonical Claude settings are missing SubagentStart hooks.",
  );
  assert(
    hooks?.Stop?.length >= 1,
    "canonical Claude settings are missing Stop hooks.",
  );

  assert(
    hooks.PreToolUse[0]?.matcher === "Bash",
    "canonical Claude settings PreToolUse must target Bash.",
  );
  assert(
    hooks.PostToolUse[0]?.matcher === "Edit|Write",
    "canonical Claude settings PostToolUse must target Edit|Write.",
  );
  assert(
    hooks.SubagentStart[0]?.matcher === "*",
    "canonical Claude settings SubagentStart must use matcher *.",
  );
  assert(
    hooks.Stop[0]?.matcher === "*",
    "canonical Claude settings Stop must use matcher *.",
  );

  const found = collectClaudeHookCommands(hooks).sort();
  const expected = [...EXPECTED_CLAUDE_HOOK_COMMANDS].sort();
  assert(
    JSON.stringify(found) === JSON.stringify(expected),
    `canonical Claude hook commands must match documented hook coverage (expected ${expected.length}, found ${found.length}).`,
  );
}

async function validateMcpConfig() {
  const config = JSON.parse(await fs.readFile(canonicalClaudeMcpPath, "utf8"));
  const server = config.mcpServers?.["meta-kim-runtime"];
  assert(
    server,
    "canonical/runtime-assets/claude/mcp.json is missing meta-kim-runtime.",
  );
  assert(server.command === "node", "meta-kim-runtime must run through node.");
}

async function validateMcpSelfTest() {
  const scriptPath = path.join(
    repoRoot,
    "scripts",
    "mcp",
    "meta-runtime-server.mjs",
  );
  const { stdout } = await execFileAsync("node", [scriptPath, "--self-test"], {
    cwd: repoRoot,
  });
  const parsed = JSON.parse(stdout);
  assert(parsed.ok === true, "MCP self-test did not report ok=true.");
  assert(parsed.agentCount >= 1, "MCP self-test returned no agents.");
}

async function validateFactoryRelease() {
  const factoryRoot = path.join(repoRoot, "factory");
  if (!(await exists(factoryRoot))) {
    return;
  }
  const legacyPaths = [
    "factory/generated",
    "factory/catalog",
    "factory/flagship-20",
    "factory/flagship-batch-1",
    "factory/flagship-batch-2",
    "factory/flagship-batch-3",
    "factory/flagship-batch-4",
    "factory/industry-coverage-matrix.md",
    "factory/flagship-20.md",
    "factory/orchestration-playbooks.md",
    "scripts/generate-industry-agents.mjs",
    "scripts/compile-foundry-runtime-packs.mjs",
    "scripts/build-flagship-batch-1.mjs",
    "scripts/build-flagship-batch-2.mjs",
    "scripts/build-flagship-batch-3.mjs",
    "scripts/build-flagship-batch-4.mjs",
    "scripts/build-flagship-complete.mjs",
    "factory/README.md",
    "factory/README.zh-CN.md",
    "factory/flagship-complete/README.md",
    "factory/flagship-complete/README.zh-CN.md",
    "factory/runtime-packs/README.md",
    "factory/runtime-packs/README.zh-CN.md",
    "factory/flagship-20.json",
    "openclaw/workspaces/meta-artisan/memory/README.md",
    "openclaw/workspaces/meta-conductor/memory/README.md",
    "openclaw/workspaces/meta-genesis/memory/README.md",
    "openclaw/workspaces/meta-librarian/memory/README.md",
    "openclaw/workspaces/meta-prism/memory/README.md",
    "openclaw/workspaces/meta-scout/memory/README.md",
    "openclaw/workspaces/meta-sentinel/memory/README.md",
    "openclaw/workspaces/meta-warden/memory/README.md",
  ];

  for (const relativePath of legacyPaths) {
    assert(
      !(await exists(path.join(repoRoot, relativePath))),
      `Legacy release-build artifact should not exist in public repo: ${relativePath}`,
    );
  }

  const factoryRootEntries = await fs.readdir(path.join(repoRoot, "factory"), {
    withFileTypes: true,
  });
  for (const entry of factoryRootEntries) {
    assert(
      !(entry.isFile() && entry.name.endsWith(".md")),
      `factory/ should not contain user-facing Markdown docs: factory/${entry.name}`,
    );
  }

  const factoryMarkdownFiles = await walkFiles(
    path.join(repoRoot, "factory"),
    ".md",
  );
  for (const filePath of factoryMarkdownFiles) {
    const baseName = path.basename(filePath).toLowerCase();
    assert(
      !baseName.startsWith("readme"),
      `Nested README files are not allowed in factory/: ${path.relative(repoRoot, filePath)}`,
    );
  }
  const factoryTomlFiles = await walkFiles(
    path.join(repoRoot, "factory"),
    ".toml",
  );
  const forbiddenFactoryDocRefs = [
    "factory/industry-coverage-matrix.md",
    "factory/flagship-20.md",
    "factory/orchestration-playbooks.md",
  ];
  for (const filePath of [...factoryMarkdownFiles, ...factoryTomlFiles]) {
    const raw = await fs.readFile(filePath, "utf8");
    for (const marker of forbiddenFactoryDocRefs) {
      assert(
        !raw.includes(marker),
        `${path.relative(repoRoot, filePath)} still references removed release doc ${marker}.`,
      );
    }
  }

  const departmentCount = await countFiles(
    path.join(repoRoot, "factory", "agent-library", "departments"),
    ".md",
  );
  const specialistCount = await countFiles(
    path.join(repoRoot, "factory", "agent-library", "specialists"),
    ".md",
  );
  const flagshipCount = await countFiles(
    path.join(repoRoot, "factory", "flagship-complete", "agents"),
    ".md",
  );
  const runtimeClaudeCount = await countFiles(
    path.join(repoRoot, "factory", "runtime-packs", "claude", "agents"),
    ".md",
  );
  const runtimeCodexCount = await countFiles(
    path.join(repoRoot, "factory", "runtime-packs", "codex", "agents"),
    ".toml",
  );
  const runtimeOpenClawCount = (
    await fs.readdir(
      path.join(repoRoot, "factory", "runtime-packs", "openclaw", "workspaces"),
      {
        withFileTypes: true,
      },
    )
  ).filter((entry) => entry.isDirectory()).length;
  const flagshipClaudeCount = await countFiles(
    path.join(
      repoRoot,
      "factory",
      "flagship-complete",
      "runtime-packs",
      "claude",
      "agents",
    ),
    ".md",
  );
  const flagshipCodexCount = await countFiles(
    path.join(
      repoRoot,
      "factory",
      "flagship-complete",
      "runtime-packs",
      "codex",
      "agents",
    ),
    ".toml",
  );
  const flagshipOpenClawCount = (
    await fs.readdir(
      path.join(
        repoRoot,
        "factory",
        "flagship-complete",
        "runtime-packs",
        "openclaw",
        "workspaces",
      ),
      { withFileTypes: true },
    )
  ).filter((entry) => entry.isDirectory()).length;

  assert(
    departmentCount === 100,
    `Expected 100 department briefs, found ${departmentCount}.`,
  );
  assert(
    specialistCount === 1000,
    `Expected 1000 specialist briefs, found ${specialistCount}.`,
  );
  assert(
    flagshipCount === 20,
    `Expected 20 flagship agents, found ${flagshipCount}.`,
  );
  assert(
    runtimeClaudeCount === 1100,
    `Expected 1100 Claude runtime packs, found ${runtimeClaudeCount}.`,
  );
  assert(
    runtimeCodexCount === 1100,
    `Expected 1100 Codex runtime packs, found ${runtimeCodexCount}.`,
  );
  assert(
    runtimeOpenClawCount === 1100,
    `Expected 1100 OpenClaw workspaces, found ${runtimeOpenClawCount}.`,
  );
  assert(
    flagshipClaudeCount === 20,
    `Expected 20 flagship Claude packs, found ${flagshipClaudeCount}.`,
  );
  assert(
    flagshipCodexCount === 20,
    `Expected 20 flagship Codex packs, found ${flagshipCodexCount}.`,
  );
  assert(
    flagshipOpenClawCount === 20,
    `Expected 20 flagship OpenClaw workspaces, found ${flagshipOpenClawCount}.`,
  );

  const runtimeSummary = JSON.parse(
    await fs.readFile(
      path.join(repoRoot, "factory", "runtime-packs", "summary.json"),
      "utf8",
    ),
  );
  assert(
    runtimeSummary.summary?.industries === 20,
    "runtime-packs/summary.json must report 20 industries.",
  );
  assert(
    runtimeSummary.summary?.departmentSeeds === 100,
    "runtime-packs/summary.json must report 100 department seeds.",
  );
  assert(
    runtimeSummary.summary?.specialistAgents === 1000,
    "runtime-packs/summary.json must report 1000 specialist agents.",
  );
  assert(
    runtimeSummary.summary?.totalAgents === 1100,
    "runtime-packs/summary.json must report 1100 total agents.",
  );

  const flagshipSummary = JSON.parse(
    await fs.readFile(
      path.join(repoRoot, "factory", "flagship-complete", "summary.json"),
      "utf8",
    ),
  );
  assert(
    flagshipSummary.counts?.flagshipAgents === 20,
    "flagship-complete/summary.json must report 20 flagship agents.",
  );
  assert(
    flagshipSummary.counts?.claudeAgents === 20,
    "flagship-complete/summary.json must report 20 Claude flagship agents.",
  );
  assert(
    flagshipSummary.counts?.codexAgents === 20,
    "flagship-complete/summary.json must report 20 Codex flagship agents.",
  );
  assert(
    flagshipSummary.counts?.openclawWorkspaces === 20,
    "flagship-complete/summary.json must report 20 OpenClaw flagship workspaces.",
  );

  const specialistFiles = await walkFiles(
    path.join(repoRoot, "factory", "agent-library", "specialists"),
    ".md",
  );
  const requiredSpecialistSections = [
    "## Strategic Value",
    "## Failure Modes to Avoid",
    "## Escalate Immediately If",
    "## Output Packet",
    "## Review Checklist",
    "## Voice Calibration",
    "## Signature Questions",
    "## Default Reasoning Sequence",
  ];
  for (const specialistPath of specialistFiles) {
    const raw = await fs.readFile(specialistPath, "utf8");
    for (const section of requiredSpecialistSections) {
      assert(
        raw.includes(section),
        `${path.relative(repoRoot, specialistPath)} is missing section ${section}.`,
      );
    }

    const industry = path.basename(path.dirname(path.dirname(specialistPath)));
    const department = path.basename(path.dirname(specialistPath));
    const specialist = path.basename(specialistPath, ".md");
    const specialistId = `${industry}-${department}-${specialist}`;
    const runtimeTargets = [
      path.join(
        repoRoot,
        "factory",
        "runtime-packs",
        "claude",
        "agents",
        `${specialistId}.md`,
      ),
      path.join(
        repoRoot,
        "factory",
        "runtime-packs",
        "codex",
        "agents",
        `${specialistId}.toml`,
      ),
      path.join(
        repoRoot,
        "factory",
        "runtime-packs",
        "openclaw",
        "workspaces",
        specialistId,
        "SOUL.md",
      ),
    ];

    for (const runtimePath of runtimeTargets) {
      assert(
        await exists(runtimePath),
        `Missing specialist runtime artifact: ${path.relative(repoRoot, runtimePath)}.`,
      );
      const runtimeRaw = await fs.readFile(runtimePath, "utf8");
      for (const section of requiredSpecialistSections) {
        assert(
          runtimeRaw.includes(section),
          `${path.relative(repoRoot, runtimePath)} is missing section ${section}.`,
        );
      }
    }
  }
}

function step(num, total, label, detail = "") {
  console.log(`\n[${num}/${total}] ${label}`);
  if (detail) console.log(`    ${detail}`);
}

function pass(msg = "") {
  console.log(`    ✓ ${msg}`);
}

function fail(msg) {
  console.error(`    ✗ ${msg}`);
}

async function main() {
  const TOTAL = 15;
  let current = 1;

  console.log("\n========================================");
  console.log("  Meta_Kim Project Integrity Check");
  console.log("========================================");

  // 1. Required files
  step(
    current++,
    TOTAL,
    "Checking required files",
    "README.md, CLAUDE.md, package.json, sync manifest, canonical runtime assets, run-artifact fixtures, memory assets",
  );
  await validateRequiredFiles();
  pass("All required kernel files present");

  // 2. Workflow contract
  step(
    current++,
    TOTAL,
    "Validating workflow contract",
    "single-department run discipline, primary deliverable, closed deliverable chain",
  );
  await validateWorkflowContract();
  pass("Workflow contract is valid");

  // 3. Sync manifest and runtime target catalog
  step(
    current++,
    TOTAL,
    "Validating sync manifest",
    "supportedTargets, defaultTargets, availableTargets, generatedTargets",
  );
  await validateSyncConfiguration();
  pass("Sync manifest and runtime target catalog are coherent");

  // 4. Canonical agent definitions
  step(
    current++,
    TOTAL,
    "Validating canonical agent definitions",
    "frontmatter completeness + forbidden-marker check + boundary discipline",
  );
  const agentIds = await validateClaudeAgents();
  pass(`${agentIds.length} agents passed: ${agentIds.join(", ")}`);

  // 5. Canonical OpenClaw runtime asset
  step(
    current++,
    TOTAL,
    "Validating OpenClaw runtime asset",
    "canonical template agent list, hooks, and allow-list must match canonical agents",
  );
  await validateOpenClawArtifacts(agentIds);
  pass("Canonical OpenClaw runtime asset is valid");

  // 6. Canonical meta-theory skill
  step(
    current++,
    TOTAL,
    "Checking canonical SKILL.md",
    "canonical metadata, station deliverable markers, and references",
  );
  await validatePortableSkill();
  pass("Canonical meta-theory skill package is valid");

  // 7. Codex runtime asset template
  step(
    current++,
    TOTAL,
    "Validating Codex runtime asset",
    "canonical config template markers",
  );
  await validateCodexArtifacts();
  pass("Canonical Codex runtime asset is valid");

  // 7. Runtime parity matrix
  step(
    current++,
    TOTAL,
    "Checking runtime parity matrix",
    "trigger/hook/review/verification/stop/writeback parity must be documented",
  );
  await validateRuntimeParityMatrix();
  pass("Runtime parity matrix contains the required governance parity markers");

  // 8. Run artifact fixtures
  step(
    current++,
    TOTAL,
    "Checking run artifact fixtures",
    "valid fixture must pass; invalid public-ready fixture must fail",
  );
  await validateRunArtifactFixtures();
  pass(
    "Run artifact validator accepts the valid fixture and rejects the invalid fixture",
  );

  // 9. npm scripts
  step(
    current++,
    TOTAL,
    "Checking package.json scripts",
    "sync:runtimes / validate / eval:agents / verify:all, etc.",
  );
  await validatePackageJson();
  pass("All required scripts registered");

  // 10. .gitignore
  step(
    current++,
    TOTAL,
    "Checking .gitignore rules",
    "node_modules/ / docs/ / local state isolation, etc.",
  );
  await validateGitignore();
  pass(".gitignore contains all necessary local-state rules");

  // 11. Canonical Claude settings
  step(
    current++,
    TOTAL,
    "Checking canonical Claude settings",
    "permission deny rules / PreToolUse / SubagentStart hooks",
  );
  await validateClaudeSettings();
  pass("Canonical Claude hooks and permissions configured correctly");

  // 12. Canonical MCP config
  step(
    current++,
    TOTAL,
    "Checking canonical MCP config",
    "meta-kim-runtime service definition and startup command",
  );
  await validateMcpConfig();
  pass("Canonical MCP config is valid");

  // 13. MCP self-test
  step(
    current++,
    TOTAL,
    "Running MCP self-test",
    "start meta-runtime-server and verify agent count",
  );
  await validateMcpSelfTest();
  pass("MCP self-test passed");

  // 14. Factory release artifacts (skipped if factory/ not in public repo)
  step(
    current++,
    TOTAL,
    "Checking factory release artifacts",
    "100 departments / 1000 specialists / 20 flagship / 1100 runtime packs",
  );
  await validateFactoryRelease();
  pass("Factory artifacts validated (or skipped — not in public repo)");

  console.log("\n========================================");
  console.log(`  All ${TOTAL} checks passed`);
  console.log(`  8 agents ready`);
  console.log("========================================\n");
}

try {
  await main();
} catch (error) {
  console.error("\n    Validation failed!");
  console.error(`    ${error.message}\n`);
  process.exitCode = 1;
}
