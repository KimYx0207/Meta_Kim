import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  readJson,
  readFile,
  SCAR_TYPES,
  SCAR_IMPACT_LEVELS,
  EIGHT_STAGES,
} from "./_helpers.mjs";

describe("workflow-contract.json — schema compliance", async () => {
  const contract = await readJson("config/contracts/workflow-contract.json");

  test("schemaVersion exists", () => {
    assert.notEqual(contract.schemaVersion, undefined);
    assert.ok(contract.schemaVersion >= 5, "schemaVersion should be >= 5 after execution-agent factory packet hardening");
  });

  test('owner is "Meta_Kim"', () => {
    assert.equal(contract.owner, "Meta_Kim");
  });

  test('businessWorkflow has id "business"', () => {
    assert.equal(contract.businessWorkflow?.id, "business");
  });

  test("canonicalExecutionSpineStages has all 8 stages", () => {
    const stages = contract.businessWorkflow?.canonicalExecutionSpineStages;
    assert.ok(Array.isArray(stages), "canonicalExecutionSpineStages should be an array");
    const expected = [
      "critical",
      "fetch",
      "thinking",
      "execution",
      "review",
      "meta_review",
      "verification",
      "evolution",
    ];
    for (const stage of expected) {
      assert.ok(stages.includes(stage), `missing stage: ${stage}`);
    }
    assert.equal(stages.length, 8);
  });

  test("businessWorkflow.phases has 10 entries", () => {
    const phases = contract.businessWorkflow?.phases;
    assert.ok(Array.isArray(phases), "phases should be an array");
    assert.equal(phases.length, 10);
  });

  test("all 10 phase names present", () => {
    const phases = contract.businessWorkflow?.phases;
    const expected = [
      "direction",
      "planning",
      "execution",
      "review",
      "meta_review",
      "revision",
      "verify",
      "summary",
      "feedback",
      "evolve",
    ];
    for (const name of expected) {
      assert.ok(phases.includes(name), `missing phase: ${name}`);
    }
  });

  test('gates.planning.owner includes "meta-conductor"', () => {
    const owner = contract.gates?.planning?.owner;
    assert.ok(
      typeof owner === "string" && owner.includes("meta-conductor"),
      `planning gate owner should include "meta-conductor", got: ${owner}`
    );
  });

  test('gates.metaReview.owners includes both "meta-warden" and "meta-prism"', () => {
    const owners = contract.gates?.metaReview?.owners;
    assert.ok(Array.isArray(owners), "metaReview owners should be an array");
    assert.ok(owners.includes("meta-warden"), 'missing "meta-warden"');
    assert.ok(owners.includes("meta-prism"), 'missing "meta-prism"');
  });

  test('gates.verify.owners includes both "meta-warden" and "meta-prism"', () => {
    const owners = contract.gates?.verify?.owners;
    assert.ok(Array.isArray(owners), "verify owners should be an array");
    assert.ok(owners.includes("meta-warden"), 'missing "meta-warden"');
    assert.ok(owners.includes("meta-prism"), 'missing "meta-prism"');
  });

  test("runDiscipline.singleDepartmentPerRun is true", () => {
    assert.equal(contract.runDiscipline?.singleDepartmentPerRun, true);
  });

  test("runDiscipline.singlePrimaryDeliverable is true", () => {
    assert.equal(contract.runDiscipline?.singlePrimaryDeliverable, true);
  });

  test("runDiscipline.rejectMultiTopicRuns is true", () => {
    assert.equal(contract.runDiscipline?.rejectMultiTopicRuns, true);
  });

  test("runDiscipline.requireClosedDeliverableChain is true", () => {
    assert.equal(contract.runDiscipline?.requireClosedDeliverableChain, true);
  });

  test("runDiscipline.executionOwnership.anonymousExecutionForbidden is true", () => {
    assert.equal(
      contract.runDiscipline?.executionOwnership?.anonymousExecutionForbidden,
      true
    );
  });

  test("protocols has runHeader key", () => {
    assert.ok(
      contract.protocols?.runHeader !== undefined,
      "protocols should have runHeader"
    );
  });

  test("protocols has workerTaskPacket key", () => {
    assert.ok(
      contract.protocols?.workerTaskPacket !== undefined,
      "protocols should have workerTaskPacket"
    );
  });

  test("protocols has all 15 governed packet types", () => {
    const expected = [
      "runHeader",
      "taskClassification",
      "cardPlanPacket",
      "dispatchEnvelopePacket",
      "orchestrationTaskBoardPacket",
      "capabilityGapPacket",
      "executionAgentCard",
      "dispatchBoard",
      "workerTaskPacket",
      "workerResultPacket",
      "reviewPacket",
      "verificationPacket",
      "summaryPacket",
      "compactionPacket",
      "evolutionWritebackPacket",
    ];
    const keys = Object.keys(contract.protocols ?? {});
    for (const packet of expected) {
      assert.ok(keys.includes(packet), `missing protocol packet: ${packet}`);
    }
    assert.equal(expected.length, 15);
  });

  test("publicDisplayRequires has all 5 conditions", () => {
    const conditions = contract.runDiscipline?.publicDisplayRequires;
    assert.ok(Array.isArray(conditions), "publicDisplayRequires should be an array");
    const expected = [
      "verifyPassed",
      "summaryClosed",
      "singleDeliverableMaintained",
      "deliverableChainClosed",
      "consolidatedDeliverablePresent",
    ];
    for (const cond of expected) {
      assert.ok(conditions.includes(cond), `missing condition: ${cond}`);
    }
  });

  test("public display gate is a hard release gate", () => {
    const gate = contract.gates?.publicDisplay ?? {};
    assert.equal(gate.owner, "meta-warden");
    assert.equal(gate.hardReleaseGate, true);
    assert.equal(gate.blockFinalDraftWithoutVerifiedRun, true);
    assert.equal(gate.blockExternalDisplayWithoutSummaryClosure, true);
    assert.equal(gate.blockCompletionWithoutClosedDeliverableChain, true);
    assert.deepEqual(
      [...(gate.requiredConditions ?? [])].sort(),
      [...(contract.runDiscipline?.publicDisplayRequires ?? [])].sort()
    );
  });

  test("task classification hardening exists", () => {
    const classification = contract.runDiscipline?.taskClassification ?? {};
    assert.equal(classification.classifierVersion, "v2");
    assert.deepEqual(classification.taskClassEnum, ["Q", "A", "P", "S"]);
    assert.deepEqual(classification.requestClassEnum, ["query", "execute", "plan", "strategy"]);
    assert.ok(classification.governanceFlowEnum.includes("simple_exec"));
    assert.ok(classification.governanceFlowEnum.includes("complex_dev"));
    assert.ok(classification.governanceFlowEnum.includes("proposal_review"));
    assert.ok(classification.triggerReasonEnum.includes("multi_file"));
    assert.ok(classification.triggerReasonEnum.includes("owner_missing"));
    assert.ok(classification.upgradeReasonEnum.includes("owner_creation_required"));
    assert.ok(classification.bypassReasonEnum.includes("pure_query"));
    assert.equal(classification.ownerRequiredByDefault, true);
    assert.equal(classification.onlyQueryMayBypassOwner, true);
  });

  test("card governance model is explicit", () => {
    const cardGovernance = contract.runDiscipline?.cardGovernance ?? {};
    assert.equal(cardGovernance.enabled, true);
    assert.equal(cardGovernance.dealerRoleModel, "conductor-primary-warden-escalation");
    for (const type of ["info", "action", "risk", "silence", "default", "upgrade"]) {
      assert.ok(cardGovernance.cardTypeEnum?.includes(type), `missing cardType: ${type}`);
    }
    for (const decision of ["deal", "suppress", "defer", "skip", "interrupt_insert", "escalate"]) {
      assert.ok(cardGovernance.cardDecisionEnum?.includes(decision), `missing cardDecision: ${decision}`);
    }
    assert.equal(
      cardGovernance.defaultNoCardPolicy,
      "prefer_silence_without_clear_intervention_gain"
    );
  });

  test("silence / skip / interrupt / shell policies are explicit", () => {
    const silencePolicy = contract.runDiscipline?.silencePolicy ?? {};
    assert.equal(silencePolicy.noInterventionPreferred, true);
    assert.equal(silencePolicy.requiresInterruptionJustification, true);
    assert.equal(silencePolicy.deferRequiresDeadline, true);
    for (const item of ["none", "no_card", "defer", "intentional_silence"]) {
      assert.ok(silencePolicy.silenceDecisionEnum?.includes(item), `missing silence decision: ${item}`);
    }

    const control = contract.runDiscipline?.controlIntervention ?? {};
    assert.equal(control.requiresReturnToMainChain, true);
    for (const item of ["skip", "interrupt", "override", "escalation_insert"]) {
      assert.ok(control.decisionTypeEnum?.includes(item), `missing control decision type: ${item}`);
    }
    for (const owner of ["meta-sentinel", "meta-prism", "meta-warden", "meta-conductor"]) {
      assert.ok(control.insertedGovernanceOwners?.includes(owner), `missing inserted governance owner: ${owner}`);
    }

    const shell = contract.runDiscipline?.deliveryShell ?? {};
    for (const item of ["one_line", "structured_status", "technical_detail", "review_delta", "executive_summary", "artifact_link"]) {
      assert.ok(shell.shellTypeEnum?.includes(item), `missing shell type: ${item}`);
    }
    for (const item of ["direct", "digest", "deferred", "quiet"]) {
      assert.ok(shell.presentationModeEnum?.includes(item), `missing presentation mode: ${item}`);
    }
  });

  test("protocolFirst requires taskClassification packet", () => {
    const requiredPackets = contract.runDiscipline?.protocolFirst?.requiredPackets ?? [];
    assert.ok(requiredPackets.includes("taskClassification"));
    assert.ok(requiredPackets.includes("cardPlanPacket"));
    assert.ok(requiredPackets.includes("dispatchEnvelopePacket"));
    assert.ok(requiredPackets.includes("orchestrationTaskBoardPacket"));
    assert.ok(requiredPackets.includes("summaryPacket"));
  });

  test("dispatch envelope is mandatory for non-query governance flows", () => {
    const envelopeWhen =
      contract.runDiscipline?.protocolFirst?.dispatchEnvelopePacketRequiredWhenGovernanceFlows ?? [];
    assert.ok(envelopeWhen.includes("simple_exec"));
    assert.ok(envelopeWhen.includes("complex_dev"));
    assert.ok(envelopeWhen.includes("meta_analysis"));
    assert.ok(!envelopeWhen.includes("query"));

    const fields = contract.protocols?.dispatchEnvelopePacket?.requiredFields ?? [];
    for (const field of [
      "ownerAgent",
      "taskRef",
      "allowedCapabilities",
      "blockedCapabilities",
      "memoryMode",
      "workspaceHint",
      "resultSchemaRef",
      "reviewOwner",
      "verificationOwner",
    ]) {
      assert.ok(fields.includes(field), `dispatchEnvelopePacket missing ${field}`);
    }
    assert.deepEqual(contract.protocols?.dispatchEnvelopePacket?.memoryModeEnum, [
      "fresh_context",
      "inherit_summary_only",
      "inherit_full_context",
    ]);
  });

  test("orchestration task board is mandatory for non-query governance flows", () => {
    const boardWhen =
      contract.runDiscipline?.protocolFirst?.orchestrationTaskBoardPacketRequiredWhenGovernanceFlows ?? [];
    assert.ok(boardWhen.includes("simple_exec"));
    assert.ok(boardWhen.includes("complex_dev"));
    assert.ok(boardWhen.includes("meta_analysis"));
    assert.ok(!boardWhen.includes("query"));

    const fields = contract.protocols?.orchestrationTaskBoardPacket?.requiredFields ?? [];
    for (const field of ["dispatchBoardId", "boardMode", "tasks", "synthesisOwner"]) {
      assert.ok(fields.includes(field), `orchestrationTaskBoardPacket missing ${field}`);
    }

    const taskFields = contract.protocols?.orchestrationTask?.requiredFields ?? [];
    for (const field of ["taskId", "taskKind", "owner", "sequence", "dependsOn", "deliverable"]) {
      assert.ok(taskFields.includes(field), `orchestrationTask missing ${field}`);
    }
  });

  test("capability gap and execution agent packets are conditionally enforced", () => {
    const gapWhen =
      contract.runDiscipline?.protocolFirst?.capabilityGapPacketRequiredWhenUpgradeReasons ?? [];
    assert.ok(
      gapWhen.includes("owner_creation_required"),
      "capabilityGapPacket must be required when owner creation is needed"
    );

    const gapFields = contract.protocols?.capabilityGapPacket?.requiredFields ?? [];
    for (const field of [
      "gapId",
      "requestedCapability",
      "currentAgentsChecked",
      "insufficiencyReason",
      "resolutionAction",
      "requestedBy",
      "approvedBy",
    ]) {
      assert.ok(gapFields.includes(field), `capabilityGapPacket missing ${field}`);
    }

    const cardWhen =
      contract.runDiscipline?.protocolFirst?.executionAgentCardRequiredWhenResolutionActions ?? [];
    assert.ok(cardWhen.includes("create_execution_agent"));
    assert.ok(cardWhen.includes("upgrade_execution_agent"));

    const cardFields = contract.protocols?.executionAgentCard?.requiredFields ?? [];
    for (const field of [
      "agentId",
      "purpose",
      "capabilities",
      "nonCapabilities",
      "dependencies",
      "inputs",
      "outputs",
    ]) {
      assert.ok(cardFields.includes(field), `executionAgentCard missing ${field}`);
    }
  });

  test("local state + compaction policy are explicit", () => {
    const localState = contract.runDiscipline?.localState ?? {};
    assert.equal(localState.root, ".meta-kim/state");
    assert.equal(localState.defaultProfile, "default");
    assert.ok(localState.profileKeyRequires?.includes("repo_path_hash"));
    assert.ok(localState.profileKeyRequires?.includes("runtime_family"));
    assert.equal(localState.runIndex?.canonicalSource, false);
    assert.equal(localState.compaction?.localOnly, true);
    assert.equal(localState.compaction?.publicArtifactForbidden, true);

    const compactionFields = contract.protocols?.compactionPacket?.requiredFields ?? [];
    for (const field of [
      "packetVersion",
      "runRef",
      "profile",
      "profileKey",
      "openFindings",
      "pendingRevisions",
      "verifyGateState",
      "singleDeliverableState",
      "summaryDelta",
      "writebackDecision",
    ]) {
      assert.ok(compactionFields.includes(field), `compactionPacket missing ${field}`);
    }
    assert.deepEqual(contract.protocols?.compactionPacket?.verifyGateStateEnum, [
      "pending_verify",
      "verified",
      "accepted_risk",
    ]);
  });

  test("intentPacket protocol and conditional governance flows are defined", () => {
    const when = contract.runDiscipline?.protocolFirst?.intentPacketRequiredWhenGovernanceFlows ?? [];
    assert.ok(when.includes("complex_dev"));
    assert.ok(when.includes("meta_analysis"));
    const fields = contract.protocols?.intentPacket?.requiredFields ?? [];
    for (const field of ["trueUserIntent", "successCriteria", "nonGoals", "intentPacketVersion"]) {
      assert.ok(fields.includes(field), `intentPacket missing ${field}`);
    }
  });

  test("intentGatePacket protocol and conditional governance flows are defined", () => {
    const when = contract.runDiscipline?.protocolFirst?.intentGatePacketRequiredWhenGovernanceFlows ?? [];
    assert.ok(when.includes("complex_dev"));
    assert.ok(when.includes("meta_analysis"));
    const fields = contract.protocols?.intentGatePacket?.requiredFields ?? [];
    for (const field of ["ambiguitiesResolved", "requiresUserChoice", "defaultAssumptions", "intentGatePacketVersion"]) {
      assert.ok(fields.includes(field), `intentGatePacket missing ${field}`);
    }
    const soft = contract.runDiscipline?.runArtifactValidation?.softPublicReadyTodoGate;
    assert.ok(soft?.environmentVariable, "softPublicReadyTodoGate.environmentVariable");
    assert.equal(soft?.environmentValue, "1");
    const comment = contract.runDiscipline?.runArtifactValidation?.softCommentReviewGate;
    assert.ok(comment?.environmentVariable, "softCommentReviewGate.environmentVariable");
    assert.equal(comment?.environmentValue, "1");
    assert.ok(comment?.summaryBooleanField, "softCommentReviewGate.summaryBooleanField");
  });

  test("finding closure rules are explicit", () => {
    const closure = contract.runDiscipline?.findingClosure ?? {};
    assert.equal(closure.findingIdRequired, true);
    assert.equal(closure.reviewFindingRequiresRevisionResponse, true);
    assert.equal(closure.revisionResponseRequiresFixArtifact, true);
    assert.equal(closure.verificationRequiresFreshEvidence, true);
    assert.equal(closure.closureRequiresVerificationResult, true);
    for (const state of ["open", "fixed_pending_verify", "verified_closed", "accepted_risk"]) {
      assert.ok(closure.closeStateEnum?.includes(state), `missing close state: ${state}`);
    }
    for (const transition of [
      "open->fixed_pending_verify",
      "fixed_pending_verify->verified_closed",
      "fixed_pending_verify->accepted_risk",
    ]) {
      assert.ok(closure.legalTransitions?.includes(transition), `missing close state transition: ${transition}`);
    }
  });

  test("card / review / revision / verification / summary protocols are explicit", () => {
    const cardPlanFields = contract.protocols?.cardPlanPacket?.requiredFields ?? [];
    for (const field of ["dealerOwner", "dealerMode", "cards", "deliveryShells", "silenceDecision", "controlDecisions", "defaultShellId"]) {
      assert.ok(cardPlanFields.includes(field), `cardPlanPacket missing ${field}`);
    }

    const cardDecisionFields = contract.protocols?.cardDecision?.requiredFields ?? [];
    for (const field of ["cardId", "cardType", "cardIntent", "cardDecision", "cardAudience", "cardTiming", "cardShell", "cardPriority", "cardReason", "cardSource", "cardSuppressed", "suppressionReason", "deliveryShellId"]) {
      assert.ok(cardDecisionFields.includes(field), `cardDecision missing ${field}`);
    }

    const deliveryShellFields = contract.protocols?.deliveryShell?.requiredFields ?? [];
    for (const field of ["deliveryShellId", "shellType", "presentationMode", "exposureLevel", "interventionForm", "audience", "contentBoundary"]) {
      assert.ok(deliveryShellFields.includes(field), `deliveryShell missing ${field}`);
    }

    const silenceDecisionFields = contract.protocols?.silenceDecision?.requiredFields ?? [];
    for (const field of ["silenceDecision", "noInterventionPreferred", "interruptionJustified", "deferUntil", "reasonForSilence"]) {
      assert.ok(silenceDecisionFields.includes(field), `silenceDecision missing ${field}`);
    }

    const controlDecisionFields = contract.protocols?.controlDecision?.requiredFields ?? [];
    for (const field of ["decisionId", "decisionType", "skipReason", "interruptReason", "overrideReason", "insertedGovernanceOwner", "emergencyGovernanceTriggered", "returnsToStage", "rejoinCondition"]) {
      assert.ok(controlDecisionFields.includes(field), `controlDecision missing ${field}`);
    }

    const reviewPacketFields = contract.protocols?.reviewPacket?.requiredFields ?? [];
    assert.ok(reviewPacketFields.includes("findings"));

    const reviewFindingFields = contract.protocols?.reviewFinding?.requiredFields ?? [];
    for (const field of ["findingId", "severity", "owner", "summary", "requiredAction", "fixArtifact", "verifiedBy", "closeState"]) {
      assert.ok(reviewFindingFields.includes(field), `reviewFinding missing ${field}`);
    }

    const revisionFields = contract.protocols?.revisionResponse?.requiredFields ?? [];
    for (const field of ["findingId", "actionId", "owner", "responseType", "status", "fixArtifact", "responseSummary"]) {
      assert.ok(revisionFields.includes(field), `revisionResponse missing ${field}`);
    }

    const verificationPacketFields = contract.protocols?.verificationPacket?.requiredFields ?? [];
    for (const field of ["fixEvidence", "revisionResponses", "verificationResults", "closeFindings"]) {
      assert.ok(verificationPacketFields.includes(field), `verificationPacket missing ${field}`);
    }

    const verificationResultFields = contract.protocols?.verificationResult?.requiredFields ?? [];
    for (const field of ["findingId", "verifiedBy", "result", "evidence", "closeState"]) {
      assert.ok(verificationResultFields.includes(field), `verificationResult missing ${field}`);
    }

    const summaryPacketFields = contract.protocols?.summaryPacket?.requiredFields ?? [];
    for (const field of ["verifyPassed", "summaryClosed", "singleDeliverableMaintained", "deliverableChainClosed", "consolidatedDeliverablePresent", "publicReady", "deliveryShellsUsed", "blockedBy"]) {
      assert.ok(summaryPacketFields.includes(field), `summaryPacket missing ${field}`);
    }
  });

  test("evolution requires explicit writeback decision", () => {
    const decision = contract.runDiscipline?.evolutionDecision ?? {};
    assert.equal(decision.required, true);
    assert.ok(decision.allowedDecisions?.includes("writeback"));
    assert.ok(decision.allowedDecisions?.includes("none"));
    assert.equal(decision.noneRequiresReason, true);
    assert.equal(decision.writebackRequiresTargets, true);

    const evolutionFields = contract.protocols?.evolutionWritebackPacket?.requiredFields ?? [];
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
      assert.ok(evolutionFields.includes(field), `evolutionWritebackPacket missing ${field}`);
    }
  });

  test("run artifact validation is contract-backed", () => {
    const runArtifactValidation = contract.runDiscipline?.runArtifactValidation ?? {};
    assert.equal(runArtifactValidation.script, "scripts/validate-run-artifact.mjs");
    assert.equal(runArtifactValidation.findingLineageRequired, true);
    assert.equal(runArtifactValidation.deliverableLinkMustReferencePrimaryDeliverable, true);
    assert.equal(runArtifactValidation.summaryPacketRequired, true);
    assert.equal(runArtifactValidation.cardPlanPacketRequired, true);
    assert.equal(runArtifactValidation.orchestrationTaskBoardPacketRequired, true);
    assert.equal(runArtifactValidation.publicReadyField, "summaryPacket.publicReady");
  });

  test("dealer role is explicit without adding a new agent", () => {
    const dealer = contract.gates?.dealer ?? {};
    assert.equal(dealer.primaryOwner, "meta-conductor");
    assert.equal(dealer.escalationOwner, "meta-warden");
    for (const source of ["meta-sentinel", "meta-prism", "user", "system"]) {
      assert.ok(dealer.interruptSources?.includes(source), `missing interrupt source: ${source}`);
    }
  });
});

describe("evolution-contract.json — schema compliance", async () => {
  const evo = await readJson("config/contracts/evolution-contract.json");

  test("schemaVersion exists", () => {
    assert.notEqual(evo.schemaVersion, undefined);
  });

  test("has all 6 evolution dimensions as keys", () => {
    const loop = evo.evolutionFeedbackLoop ?? {};
    const expected = [
      "patternReuse",
      "boundaryDrift",
      "rhythmBottleneck",
      "capabilityGap",
      "processBottleneck",
      "scarDetected",
    ];
    const keys = Object.keys(loop);
    for (const dim of expected) {
      assert.ok(keys.includes(dim), `missing evolution dimension: ${dim}`);
    }
  });

  test("each dimension has required fields (target, storage, trigger, evidence)", () => {
    const loop = evo.evolutionFeedbackLoop ?? {};
    const requiredFields = ["target", "storage", "trigger", "evidence"];
    for (const [dim, value] of Object.entries(loop)) {
      for (const field of requiredFields) {
        assert.ok(
          value?.[field] !== undefined,
          `dimension "${dim}" missing field "${field}"`
        );
      }
    }
  });

  test("patternReuse references skills storage", () => {
    const storage = evo.evolutionFeedbackLoop?.patternReuse?.storage ?? "";
    assert.ok(
      storage.includes("skills"),
      `patternReuse storage should reference skills, got: ${storage}`
    );
  });

  test("boundaryDrift references agents storage", () => {
    const storage = evo.evolutionFeedbackLoop?.boundaryDrift?.storage ?? "";
    assert.ok(
      storage.includes("agents"),
      `boundaryDrift storage should reference agents, got: ${storage}`
    );
  });

  test("scarDetected references scar protocol", () => {
    const entry = evo.evolutionFeedbackLoop?.scarDetected ?? {};
    const combined = `${entry.target ?? ""} ${entry.storage ?? ""} ${entry.trigger ?? ""}`;
    assert.ok(
      combined.includes("scar"),
      `scarDetected should reference scar protocol, got: ${combined}`
    );
  });

  test("all dimensions have amplification operations", () => {
    const ops = evo.amplificationOperations ?? {};
    const expected = [
      "patternReuse",
      "boundaryDrift",
      "rhythmBottleneck",
      "capabilityGap",
      "processBottleneck",
      "scarDetected",
    ];
    const keys = Object.keys(ops);
    for (const dim of expected) {
      assert.ok(
        keys.includes(dim),
        `missing amplification operation for: ${dim}`
      );
    }
  });
});

describe("scar-protocol.md — schema compliance", async () => {
  const content = await readFile("config/contracts/scar-protocol.md");

  test("all 4 scar types documented", () => {
    for (const scarType of SCAR_TYPES) {
      assert.ok(
        content.includes(scarType),
        `scar type "${scarType}" not found in scar-protocol.md`
      );
    }
  });

  test("all 4 impact levels documented", () => {
    for (const level of SCAR_IMPACT_LEVELS) {
      assert.ok(
        content.includes(level),
        `impact level "${level}" not found in scar-protocol.md`
      );
    }
  });

  test("scar record schema fields present", () => {
    const requiredFields = [
      "id",
      "type",
      "date",
      "triggered_by",
      "what_happened",
      "root_cause",
      "impact",
      "prevention_rule",
    ];
    for (const field of requiredFields) {
      assert.ok(
        content.includes(field),
        `schema field "${field}" not found in scar-protocol.md`
      );
    }
  });
});
