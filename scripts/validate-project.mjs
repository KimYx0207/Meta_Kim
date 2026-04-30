import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  canonicalAgentsDir,
  canonicalCapabilityIndexDir,
  canonicalRuntimeAssetsDir,
  canonicalSkillPath,
  canonicalSkillReferencesDir,
  loadRuntimeProfiles,
  loadSyncManifest,
} from "./meta-kim-sync-config.mjs";
import { t } from "./meta-kim-i18n.mjs";

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
const canonicalSharedMemoryHookPath = path.join(
  canonicalRuntimeAssetsDir,
  "shared",
  "hooks",
  "meta-kim-memory-save.mjs",
);
const canonicalOpenClawMemoryHookDir = path.join(
  canonicalRuntimeAssetsDir,
  "openclaw",
  "hooks",
  "mcp-memory-service",
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
  "node .claude/hooks/stop-memory-save.mjs",
  "node .claude/hooks/stop-compaction.mjs",
  "node .claude/hooks/stop-console-log-audit.mjs",
  "node .claude/hooks/stop-completion-guard.mjs",
];

const GRAPHIFY_MAX_REPORT_AGE_DAYS = 14;
const GRAPHIFY_MAX_INFERRED_EDGE_RATIO = 0.5;
const GRAPHIFY_MAX_ISOLATED_NODE_RATIO = 0.25;
const GRAPHIFY_MAX_HELPER_GOD_NODE_EDGE_RATIO = 0.25;
const GRAPHIFY_HELPER_GOD_NODE_LABELS = new Set([
  "log()",
  "readFile()",
  "main()",
]);
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

async function walkFilesByExtensions(rootDir, extensions, bucket = []) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === "graphify-out" ||
        entry.name === ".meta-kim" ||
        entry.name === ".backup" ||
        entry.name === ".claude" ||
        entry.name === ".codex" ||
        entry.name === ".cursor" ||
        entry.name === ".agents" ||
        entry.name === "openclaw" ||
        entry.name === "memory"
      ) {
        continue;
      }
      await walkFilesByExtensions(entryPath, extensions, bucket);
    } else if (
      entry.isFile() &&
      extensions.some((extension) => entry.name.endsWith(extension))
    ) {
      bucket.push(entryPath);
    }
  }
  return bucket;
}

function toRepoRelative(filePath) {
  return path.relative(repoRoot, filePath).replace(/\\/g, "/");
}

function getNpmScriptReferences(raw) {
  const references = new Set();
  const regex = /\bnpm\s+run\s+(?!run\b)([A-Za-z0-9:_-]+)/g;
  let match;
  while ((match = regex.exec(raw)) !== null) {
    references.add(match[1]);
  }
  return [...references].sort();
}

function labelForNodeId(nodesById, id) {
  return nodesById.get(id)?.label ?? "";
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
    CANONICAL_CAPABILITY_INDEX_RELATIVE,
    "docs/runtime-capability-matrix.md",
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
    (contract.schemaVersion ?? 0) >= 6,
    "workflow-contract.json schemaVersion must be >= 6 after Critical/Fetch/Thinking/Review packet hardening.",
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
    "fetchPacket",
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
  for (const action of ["create_execution_agent", "upgrade_execution_agent"]) {
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
  assert(
    reviewPacketFields.includes("sourceProjects"),
    "workflow-contract.json reviewPacket must require sourceProjects.",
  );
  assert(
    reviewPacketFields.includes("crossProjectContaminationCheck"),
    "workflow-contract.json reviewPacket must require crossProjectContaminationCheck.",
  );
  assert(
    JSON.stringify(
      contract.protocols?.reviewPacket?.crossProjectContaminationCheckEnum ??
        [],
    ) === JSON.stringify(["pass", "fail"]),
    "workflow-contract.json reviewPacket crossProjectContaminationCheckEnum must be [pass, fail].",
  );
  for (const [protocolName, expectedFields] of [
    [
      "taskClassification",
      [
        "taskClass",
        "requestClass",
        "queryScope",
        "projectRef",
        "registryStatus",
        "crossProjectReason",
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
      "fetchPacket",
      [
        "projectsChecked",
        "projectLocalSources",
        "globalRegistryHits",
        "capabilityMatches",
        "capabilityGaps",
        "graphSources",
        "knowledgeSources",
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
      "dispatchEnvelopePacket",
      [
        "ownerAgent",
        "taskRef",
        "allowedCapabilities",
        "blockedCapabilities",
        "route",
        "ownerSelection",
        "memoryMode",
        "workspaceHint",
        "resultSchemaRef",
        "reviewOwner",
        "verificationOwner",
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
        "sourceProject",
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
        "sourceProjects",
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
    "`npm run meta:eval:agents`",
    "`npm run meta:eval:agents:live`",
  ]) {
    assert(
      raw.includes(marker),
      `docs/runtime-capability-matrix.md must include ${marker}.`,
    );
  }
}

async function validateCapabilityIndex() {
  const indexPath = path.join(
    canonicalCapabilityIndexDir,
    "meta-kim-capabilities.json",
  );
  const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
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
        "repo canonical capability index -> runtime mirror -> local global inventory -> fallback general agent with capability gap record",
    "capability index fetchOrder must be canonical -> mirror -> local inventory -> fallback.",
  );

  const serialized = JSON.stringify(index);
  const homeDir = os.homedir().replace(/\\/g, "\\\\");
  assert(
    !serialized.includes(homeDir),
    "repo-canonical capability index must not contain machine-specific home paths.",
  );

  for (const mirror of index.mirroredTo ?? []) {
    const mirrorPath = path.join(repoRoot, mirror);
    if (await exists(mirrorPath)) {
      const mirrored = JSON.parse(await fs.readFile(mirrorPath, "utf8"));
      assert(
        mirrored.canonicalProjection === CANONICAL_CAPABILITY_INDEX_RELATIVE,
        `${mirror} must point back to ${CANONICAL_CAPABILITY_INDEX_RELATIVE}.`,
      );
    }
  }
}

async function validateGraphifyGate() {
  const graphifyCli = path.join(repoRoot, "scripts", "graphify-cli.mjs");
  await execFileAsync("node", [graphifyCli, "check"], {
    cwd: repoRoot,
    timeout: 30_000,
  });

  const reportPath = path.join(repoRoot, "graphify-out", "GRAPH_REPORT.md");
  const graphPath = path.join(repoRoot, "graphify-out", "graph.json");
  assert(await exists(reportPath), "graphify-out/GRAPH_REPORT.md is required.");
  assert(await exists(graphPath), "graphify-out/graph.json is required.");

  const [reportStat, graphStat] = await Promise.all([
    fs.stat(reportPath),
    fs.stat(graphPath),
  ]);
  assert(graphStat.size > 0, "graphify-out/graph.json must be non-empty.");
  assert(
    reportStat.mtimeMs >= graphStat.mtimeMs - 1000,
    "graphify-out/GRAPH_REPORT.md must not be older than graph.json.",
  );
  const reportAgeDays = (Date.now() - reportStat.mtimeMs) / 86_400_000;
  assert(
    reportAgeDays <= GRAPHIFY_MAX_REPORT_AGE_DAYS,
    `graphify report is stale (${reportAgeDays.toFixed(1)} days old).`,
  );

  const graph = JSON.parse(await fs.readFile(graphPath, "utf8"));
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const links = Array.isArray(graph.links)
    ? graph.links
    : Array.isArray(graph.edges)
      ? graph.edges
      : [];
  assert(nodes.length > 0, "graphify graph must contain nodes.");
  assert(links.length > 0, "graphify graph must contain edges/links.");

  const inferredEdges = links.filter(
    (edge) => String(edge.confidence ?? "").toUpperCase() === "INFERRED",
  ).length;
  const inferredRatio = inferredEdges / links.length;
  assert(
    inferredRatio <= GRAPHIFY_MAX_INFERRED_EDGE_RATIO,
    `graphify inferred edge ratio is too high (${inferredRatio.toFixed(2)}).`,
  );

  const degree = new Map(nodes.map((node) => [node.id, 0]));
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  let helperGodNodeEdges = 0;
  for (const edge of links) {
    const source = edge.source ?? edge._src;
    const target = edge.target ?? edge._tgt;
    degree.set(source, (degree.get(source) ?? 0) + 1);
    degree.set(target, (degree.get(target) ?? 0) + 1);
    if (
      GRAPHIFY_HELPER_GOD_NODE_LABELS.has(labelForNodeId(nodesById, source)) ||
      GRAPHIFY_HELPER_GOD_NODE_LABELS.has(labelForNodeId(nodesById, target))
    ) {
      helperGodNodeEdges += 1;
    }
  }

  const isolatedNodes = [...degree.values()].filter((value) => value === 0);
  const isolatedRatio = isolatedNodes.length / nodes.length;
  assert(
    isolatedRatio <= GRAPHIFY_MAX_ISOLATED_NODE_RATIO,
    `graphify isolated node ratio is too high (${isolatedRatio.toFixed(2)}).`,
  );

  const helperRatio = helperGodNodeEdges / links.length;
  assert(
    helperRatio <= GRAPHIFY_MAX_HELPER_GOD_NODE_EDGE_RATIO,
    `graphify helper god-node edge ratio is too high (${helperRatio.toFixed(2)}).`,
  );

  const pollutedNodes = nodes.filter((node) =>
    /(^|[\\/])(node_modules|\.git|dist|build|graphify-out)([\\/]|$)/i.test(
      String(node.source_file ?? node.path ?? node.label ?? ""),
    ),
  );
  assert(
    pollutedNodes.length / nodes.length <= 0.05,
    "graphify graph contains too many generated/dependency pollution nodes.",
  );
}

async function validateDocumentationFacts() {
  const docs = await walkFilesByExtensions(repoRoot, [".md"]);
  const packageJson = JSON.parse(
    await fs.readFile(path.join(repoRoot, "package.json"), "utf8"),
  );
  const scripts = packageJson.scripts ?? {};

  for (const docPath of docs) {
    const relativePath = toRepoRelative(docPath);
    const raw = await fs.readFile(docPath, "utf8");
    assert(
      !raw.includes("docs/meta.md"),
      `${relativePath} must not reference docs/meta.md as a theory source.`,
    );
    assert(
      !/\.claude\/(?:agents|skills|capability-index)[^\n]*(?:canonical|主源|source of truth|source layer)/i.test(
        raw,
      ),
      `${relativePath} must not describe .claude projections as canonical sources.`,
    );
    assert(
      !/(?:canonical|主源|source of truth|source layer)[^\n]*\.claude\/(?:agents|skills|capability-index)/i.test(
        raw,
      ),
      `${relativePath} must not describe .claude projections as canonical sources.`,
    );

    for (const scriptName of getNpmScriptReferences(raw)) {
      assert(
        scripts[scriptName],
        `${relativePath} references missing npm script: ${scriptName}`,
      );
    }
  }

  for (const relativePath of [
    "canonical/skills/meta-theory/SKILL.md",
    "canonical/skills/meta-theory/references/meta-theory.md",
    ".codex/skills/meta-theory/SKILL.md",
    ".cursor/skills/meta-theory/SKILL.md",
    "openclaw/skills/meta-theory/SKILL.md",
  ]) {
    assert(
      await exists(path.join(repoRoot, relativePath)),
      `Documented runtime skill path is missing: ${relativePath}`,
    );
  }

  const testFiles = await walkFilesByExtensions(path.join(repoRoot, "tests"), [
    ".mjs",
  ]);
  const knownGapsPath = path.join(repoRoot, "tests", "fixtures", "known-doc-gaps.json");
  const knownDocGaps = (await exists(knownGapsPath))
    ? JSON.parse(await fs.readFile(knownGapsPath, "utf8"))
    : [];
  for (const filePath of testFiles) {
    const raw = await fs.readFile(filePath, "utf8");
    const relativePath = toRepoRelative(filePath);
    const docGapWarnings = [...raw.matchAll(/console\.warn\(([\s\S]*?DOC GAP[\s\S]*?)\);/g)];
    for (const warning of docGapWarnings) {
      const message = warning[1];
      const allowed = knownDocGaps.some(
        (entry) =>
          entry.path === relativePath &&
          message.includes(entry.messageContains) &&
          entry.owner &&
          entry.expiry &&
          entry.closeCondition,
      );
      assert(
        allowed,
        `${relativePath} has an untracked DOC GAP warning; add owner, expiry, and closeCondition to tests/fixtures/known-doc-gaps.json or convert it to a failing assertion.`,
      );
    }
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

  const extraSkillDirs = templateConfig.skills?.load?.extraDirs ?? [];
  assert(
    extraSkillDirs.includes("__REPO_ROOT__\\openclaw\\skills"),
    "canonical OpenClaw template must register repo-local openclaw/skills via skills.load.extraDirs.",
  );

  for (const fileName of ["HOOK.md", "handler.ts"]) {
    await fs.access(path.join(canonicalOpenClawMemoryHookDir, fileName));
  }
  const sharedMemoryHook = await fs.readFile(
    canonicalSharedMemoryHookPath,
    "utf8",
  );
  assert(
    sharedMemoryHook.includes("--event") &&
      sharedMemoryHook.includes("/api/memories/search"),
    "canonical shared memory hook must support lifecycle events and MCP memory search.",
  );
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
  const canonicalRoots = manifest.canonicalRoots ?? {};

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
        Array.isArray(generatedTargets[target]) &&
        generatedTargets[target].length > 0,
    ),
    "config/sync.json must declare generatedTargets for every supported target.",
  );
  assert(
    canonicalRoots.contracts === "config/contracts",
    "config/sync.json canonicalRoots.contracts must be config/contracts.",
  );
  assert(
    canonicalRoots.capabilityIndex === "config/capability-index",
    "config/sync.json canonicalRoots.capabilityIndex must be config/capability-index.",
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
    ".codex/skills/",
  ]) {
    assert(
      configExample.includes(expected),
      `canonical/runtime-assets/codex/config.toml.example is missing ${expected}`,
    );
  }
  const commandPath = path.join(
    canonicalRuntimeAssetsDir,
    "codex",
    "commands",
    "meta-theory.md",
  );
  const command = await fs.readFile(commandPath, "utf8");
  for (const expected of [
    "name: meta-theory",
    "~/.codex/skills/meta-theory/SKILL.md",
    ".codex/skills/meta-theory/SKILL.md",
  ]) {
    assert(
      command.includes(expected),
      `canonical/runtime-assets/codex/commands/meta-theory.md is missing ${expected}`,
    );
  }
}

async function validatePackageJson() {
  const packageJsonPath = path.join(repoRoot, "package.json");
  const pkg = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  assert(pkg.scripts?.["meta:sync"], "package.json is missing meta:sync.");
  assert(
    pkg.scripts?.["meta:validate"],
    "package.json is missing meta:validate.",
  );
  assert(
    pkg.scripts?.["meta:validate:run"],
    "package.json is missing meta:validate:run.",
  );
  assert(
    pkg.scripts?.["meta:eval:agents"],
    "package.json is missing meta:eval:agents.",
  );
  assert(
    pkg.scripts?.["meta:verify:all"],
    "package.json is missing meta:verify:all.",
  );
  assert(
    !pkg.scripts?.["sync:global:meta-theory:codex-active"],
    "package.json should not keep the legacy sync:global:meta-theory:codex-active script.",
  );
  assert(
    pkg.scripts?.["prepare:openclaw-local"],
    "package.json is missing prepare:openclaw-local.",
  );
  assert(
    pkg.scripts?.["meta:deps:install"] ===
      "node scripts/install-global-skills-all-runtimes.mjs --targets claude",
    "package.json meta:deps:install must use the Node-based installer with --targets claude.",
  );
  assert(
    pkg.scripts?.["meta:deps:update"] ===
      "node scripts/install-global-skills-all-runtimes.mjs --update --targets claude",
    "package.json meta:deps:update must use the Node-based installer with --targets claude.",
  );
  const setupTestScript = pkg.scripts?.["meta:test:setup"] ?? "";
  assert(
    /tests\/setup\/\*\.test\.mjs/.test(setupTestScript) &&
      (/node --test/.test(setupTestScript) ||
        /scripts\/run-node-tests\.mjs/.test(setupTestScript)),
    "package.json must expose meta:test:setup for installer regression coverage.",
  );
  assert(
    pkg.scripts?.["meta:verify:all"]?.includes("npm run meta:test:setup"),
    "package.json meta:verify:all must include npm run meta:test:setup.",
  );
  assert(
    pkg.scripts?.["meta:verify:all"]?.includes("npm run meta:graphify:check"),
    "package.json meta:verify:all must include npm run meta:graphify:check.",
  );
  assert(
    pkg.scripts?.["meta:verify:all:live"]?.includes("npm run meta:test:setup"),
    "package.json meta:verify:all:live must include npm run meta:test:setup.",
  );
  assert(
    pkg.scripts?.["meta:verify:all:live"]?.includes(
      "npm run meta:graphify:check",
    ),
    "package.json meta:verify:all:live must include npm run meta:graphify:check.",
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
  if (detail) console.log(`${detail}`);
}

function pass(msg = "") {
  console.log(`✓ ${msg}`);
}

function fail(msg) {
  console.error(`✗ ${msg}`);
}

async function main() {
  const TOTAL = 18;
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
  await validateWorkflowContract();
  pass(t.val.step02Pass);

  // 3. Sync manifest and runtime target catalog
  step(current++, TOTAL, t.val.step03, t.val.step03Detail);
  await validateSyncConfiguration();
  pass(t.val.step03Pass);

  // 4. Canonical agent definitions
  step(current++, TOTAL, t.val.step04, t.val.step04Detail);
  const agentIds = await validateClaudeAgents();
  pass(t.val.step04Pass(agentIds.length, agentIds));

  // 5. Canonical OpenClaw runtime asset
  step(current++, TOTAL, t.val.step05, t.val.step05Detail);
  await validateOpenClawArtifacts(agentIds);
  pass(t.val.step05Pass);

  // 6. Canonical meta-theory skill
  step(current++, TOTAL, t.val.step06, t.val.step06Detail);
  await validatePortableSkill();
  pass(t.val.step06Pass);

  // 7. Codex runtime asset template
  step(current++, TOTAL, t.val.step07, t.val.step07Detail);
  await validateCodexArtifacts();
  pass(t.val.step07Pass);

  // 8. Runtime parity matrix
  step(current++, TOTAL, t.val.step08, t.val.step08Detail);
  await validateRuntimeParityMatrix();
  pass(t.val.step08Pass);

  // 9. Canonical capability index
  step(current++, TOTAL, "Canonical capability index");
  await validateCapabilityIndex();
  pass("capability index source and mirrors are valid.");

  // 10. Graphify governance gate
  step(current++, TOTAL, "Graphify governance gate");
  await validateGraphifyGate();
  pass("graphify CLI, report, graph, and health gates are valid.");

  // 11. Documentation fact checks
  step(current++, TOTAL, "Documentation fact checks");
  await validateDocumentationFacts();
  pass("documentation references are aligned with repo facts.");

  // 12. Run artifact fixtures
  step(current++, TOTAL, t.val.step09, t.val.step09Detail);
  await validateRunArtifactFixtures();
  pass(t.val.step09Pass);

  // 13. npm scripts
  step(current++, TOTAL, t.val.step10, t.val.step10Detail);
  await validatePackageJson();
  pass(t.val.step10Pass);

  // 14. .gitignore
  step(current++, TOTAL, t.val.step11, t.val.step11Detail);
  await validateGitignore();
  pass(t.val.step11Pass);

  // 15. Canonical Claude settings
  step(current++, TOTAL, t.val.step12, t.val.step12Detail);
  await validateClaudeSettings();
  pass(t.val.step12Pass);

  // 16. Canonical MCP config
  step(current++, TOTAL, t.val.step13, t.val.step13Detail);
  await validateMcpConfig();
  pass(t.val.step13Pass);

  // 17. MCP self-test
  step(current++, TOTAL, t.val.step14, t.val.step14Detail);
  await validateMcpSelfTest();
  pass(t.val.step14Pass);

  // 18. Factory release artifacts (skipped if factory/ not in public repo)
  step(current++, TOTAL, t.val.step15, t.val.step15Detail);
  await validateFactoryRelease();
  pass(t.val.step15Pass);

  console.log("\n========================================");
  console.log(t.val.footerAll(TOTAL));
  console.log(t.val.footerAgents(agentIds.length));
  console.log("========================================\n");
}

try {
  await main();
} catch (error) {
  console.error("\n    " + t.val.valFailed);
  console.error(`    ${error.message}\n`);
  process.exitCode = 1;
}
