import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import path from "node:path";
import { REPO_ROOT } from "./_helpers.mjs";

const execFileAsync = promisify(execFile);

describe("validate-run-artifact.mjs", () => {
  const validFixture = path.join(
    REPO_ROOT,
    "tests",
    "fixtures",
    "run-artifacts",
    "valid-run.json",
  );
  const invalidFixture = path.join(
    REPO_ROOT,
    "tests",
    "fixtures",
    "run-artifacts",
    "invalid-run-public-ready.json",
  );
  const invalidCompactionFixture = path.join(
    REPO_ROOT,
    "tests",
    "fixtures",
    "run-artifacts",
    "invalid-run-compaction-open-findings.json",
  );

  async function validateFixture(fixturePath) {
    const { stdout } = await execFileAsync(
      "node",
      ["scripts/validate-run-artifact.mjs", fixturePath],
      { cwd: REPO_ROOT },
    );
    return JSON.parse(stdout);
  }

  async function writeTempFixture(t, mutate) {
    const raw = await fs.readFile(validFixture, "utf8");
    const artifact = JSON.parse(raw);
    mutate(artifact);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-validate-"));
    const file = path.join(dir, "fixture.json");
    await fs.writeFile(file, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    t.after(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });
    return file;
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function routePrimaryExecutionOwner(artifact, ownerAgent) {
    artifact.dispatchEnvelopePacket.ownerAgent = ownerAgent;
    artifact.orchestrationTaskBoardPacket.tasks[0].owner = ownerAgent;
    for (const lane of artifact.businessFlowBlueprintPacket.requiredLanes) {
      lane.candidateOwners = [ownerAgent, "meta-conductor"];
      lane.selectedOwner = ownerAgent;
    }
    const role = artifact.agentBlueprintPacket.roles[0];
    role.ownerAgent = ownerAgent;
    role.ownerResolution = "reuse_existing_owner";
    role.ownerSource = "global_reuse";
    role.agentCopyPolicy = "use_global_directly";
    role.agentIterationPlan =
      "Use the existing global owner directly; do not copy it into the project.";
    artifact.workerTaskPackets[0].ownerAgent = ownerAgent;
    artifact.workerTaskPackets[0].owner = ownerAgent;
    artifact.workerResultPackets[0].owner = ownerAgent;
    artifact.reviewPacket.findings[0].owner = ownerAgent;
    artifact.verificationPacket.revisionResponses[0].owner = ownerAgent;
  }

  function addFactoryReviewParticipation(artifact) {
    const reviewCoverage =
      artifact.agentBlueprintPacket.governanceStageCoverage.Review;
    if (!reviewCoverage.includes("meta-chrysalis")) {
      reviewCoverage.push("meta-chrysalis");
    }
  }

  function routeProjectLocalTopicCreation(artifact) {
    routePrimaryExecutionOwner(artifact, "topic-analyst");
    addFactoryReviewParticipation(artifact);
    artifact.taskClassification.upgradeReasons = [
      ...artifact.taskClassification.upgradeReasons,
      "owner_creation_required",
    ];
    artifact.orchestrationTaskBoardPacket.boardMode = "factory_then_dispatch";
    artifact.orchestrationTaskBoardPacket.tasks = [
      {
        taskId: "task-001",
        taskKind: "factory_build",
        owner: "meta-genesis",
        sequence: 1,
        dependsOn: [],
        deliverable: "topic-analyst execution-agent card",
        businessRoleId: "agent",
        roleDisplayName: "agent",
      },
      {
        taskId: "task-002",
        taskKind: "execution",
        owner: "topic-analyst",
        sequence: 2,
        dependsOn: ["task-001"],
        deliverable: "ranked topic analysis",
        businessRoleId: "analysis",
        roleDisplayName: "analysis",
      },
    ];
    const role = artifact.agentBlueprintPacket.roles[0];
    role.ownerSource = "project_local";
    role.agentCopyPolicy = "create_project_local_agent";
    role.ownerResolution = "create_owner_first";
    role.agentIterationPlan =
      "Create a project-local topic analysis execution agent because global search found no reusable owner.";
    artifact.capabilityGapPacket = {
      gapId: "gap-project-local-topic-agent",
      requestedCapability: "project-specific topic analysis",
      currentAgentsChecked: [
        "code-reviewer",
        "frontend-developer",
        "meta-scout",
      ],
      insufficiencyReason:
        "Global and existing project-local owners do not cover recurring topic analysis.",
      resolutionAction: "create_execution_agent",
      executionAgentRegistryScope: "project_local",
      requestedBy: "meta-conductor",
      approvedBy: "meta-warden",
    };
    artifact.executionAgentCard = {
      registryScope: "project_local",
      agentId: "topic-analyst",
      businessRoleId: "analysis",
      roleDisplayName: "analysis",
      purpose:
        "Project-local execution owner for recurring topic analysis workflows.",
      capabilities: ["topic analysis", "project taxonomy matching"],
      nonCapabilities: ["governance arbitration", "code implementation"],
      dependencies: ["meta-skill:research-analysis"],
      inputs: ["project goals", "candidate topic list"],
      outputs: ["ranked topic analysis"],
    };
  }

  function validInterfaceIntegrationPacket(kind = "third_party") {
    return {
      integrationKind: kind,
      interfaceInventory: [
        {
          interfaceId: "provider-create-order",
          producer: kind === "internal" ? "backend" : "third-party-provider",
          consumer: "backend",
          contractArtifactRef: "docs/provider/create-order.openapi.json",
          schemaRef: "components.schemas.CreateOrderRequest",
        },
      ],
      fieldLedger: [
        {
          fieldName: "orderAmount",
          fieldClass: "outbound_provider_field",
          sourceOfTruth: "provider official docs",
          evidenceRef: "ev-provider-docs",
          owner: "backend",
          transformationRule: "Convert internal cents to provider minor unit.",
          unknownStatus: "confirmed",
        },
      ],
      unknowns: [],
      evidence: [
        {
          evidenceId: "ev-provider-docs",
          sourceType: "official_docs",
          sourceRef: "https://provider.example/docs/orders",
          summary: "Provider create-order fields and auth requirements.",
        },
      ],
      reviewGates:
        kind === "internal"
          ? [
              "source_of_truth",
              "contract_diff",
              "error_model",
              "state_machine",
              "sandbox_contract_test",
              "human_owner_approval",
            ]
          : [
              "source_of_truth",
              "signature_auth",
              "idempotency",
              "callback_webhook",
              "error_model",
              "state_machine",
              "sandbox_contract_test",
              "security_secrets",
              "human_owner_approval",
            ],
      testMatrix: [
        { scenario: "success" },
        { scenario: "auth_failure" },
        { scenario: "rate_limited" },
        { scenario: "timeout" },
        { scenario: "missing_field" },
        { scenario: "provider_5xx" },
        { scenario: "duplicate_request_or_callback" },
      ],
      ownerApprovals: [{ owner: "backend", approvalRef: "ticket-123" }],
    };
  }

  function modernCapabilityBindings() {
    return {
      matchedCapabilities: [
        {
          matchId: "cap-match-auth-refresh-001",
          capabilitySlot: "auth refresh implementation discipline",
          bindingType: "skill",
          bindingRef: "meta-theory:local-project-code-change",
          providerId: "meta-theory",
          source: "capability-index",
          confidenceScore: 4,
          selectionReason:
            "Represents implementation capability as run-scoped evidence while durable ownership stays with governance meta agents.",
          selectionScope: "run_scoped",
          persistencePolicy: "do_not_persist_to_agent_identity",
          fallback:
            "Block with capabilityGapPacket if no governance owner can supervise the run-scoped capability.",
        },
      ],
      capabilityBindings: [
        {
          bindingId: "binding-auth-refresh-001",
          capabilitySlot: "auth refresh implementation discipline",
          bindingType: "skill",
          bindingRef: "meta-theory:local-project-code-change",
          source: "capability-index",
          evidenceRef: "contentEvidencePacket.capabilityEvidence[0]",
        },
      ],
    };
  }

  function addTriggerReason(artifact, reason) {
    if (!artifact.taskClassification.triggerReasons.includes(reason)) {
      artifact.taskClassification.triggerReasons.push(reason);
    }
    const reviewReasons =
      artifact.reviewPacket.triggerVsSkipReasonCheck.triggerReasons;
    if (!reviewReasons.includes(reason)) {
      reviewReasons.push(reason);
    }
  }

  test("accepts a valid run artifact with full finding lineage", async () => {
    const result = await validateFixture(validFixture);
    assert.equal(result.ok, true);
    assert.ok(result.validatedPackets.includes("fetchPacket"));
    assert.ok(result.validatedPackets.includes("dispatchEnvelopePacket"));
    assert.ok(result.validatedPackets.includes("orchestrationTaskBoardPacket"));
    assert.ok(result.validatedPackets.includes("cardPlanPacket"));
    assert.ok(result.validatedPackets.includes("summaryPacket"));
  });

  test("rejects pre-decision frames missing unresolved question closure", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      delete artifact.preDecisionOptionFrame.unresolvedQuestions;
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /preDecisionOptionFrame.*unresolvedQuestions/,
    );
  });

  test("rejects finalized dispatch when solution choice is still pending", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.intentGatePacket.requiresUserChoice = true;
      artifact.intentGatePacket.pendingUserChoices = [
        "Choose between narrow patch and full runtime migration.",
      ];
      artifact.preDecisionOptionFrame.requiresUserChoice = true;
      artifact.preDecisionOptionFrame.choiceGateSkip = null;
      artifact.preDecisionOptionFrame.solutionChoiceState = "pending";
      artifact.dispatchEnvelopePacket.userChoiceState = "pending";
      artifact.workerTaskPackets[0].userChoiceState = "pending";
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /solutionChoiceState/,
    );
  });

  test("rejects shallow Fetch evidence that cannot change a decision", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.contentEvidencePacket.decisionImpactMap = [];
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /decisionImpactMap.*decision-grade evidence/,
    );
  });

  test("rejects research evidence without iteration logs", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      delete artifact.contentEvidencePacket.iterationLog;
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /iterationLog/,
    );
  });

  test("rejects claim evidence cards with unresolved source refs", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.contentEvidencePacket.claimEvidenceCards[0].sourceRefs = [
        "contentEvidencePacket.missingEvidence[0]",
      ];
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /claimEvidenceCards.*sourceRefs/,
    );
  });

  test("rejects deep research without decision quality frame", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      delete artifact.contentEvidencePacket.deepResearchPlan.decisionQualityFrame;
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /decisionQualityFrame/,
    );
  });

  test("rejects deep research without competing hypotheses", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.contentEvidencePacket.deepResearchPlan.competingHypotheses = [
        artifact.contentEvidencePacket.deepResearchPlan.competingHypotheses[0],
      ];
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /competingHypotheses/,
    );
  });

  test("rejects missing Critical production-correctness intent fields", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      delete artifact.intentPacket.realIntent;
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /intentPacket.*realIntent/,
    );
  });

  test("rejects Fetch packets without capability discovery", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.contentEvidencePacket.capabilityDiscovery = [];
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /capabilityDiscovery/,
    );
  });

  test("rejects worker work orders missing work type", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      delete artifact.workerTaskPackets[0].workType;
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /workType/,
    );
  });

  test("rejects temporary fallback owner modes in worker work orders", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.workerTaskPackets[0].ownerMode = "temporary-fallback-owner";
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /ownerMode/,
    );
  });

  test("rejects worker work orders missing evidence references", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.workerTaskPackets[0].evidenceRefs = [];
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /evidenceRefs/,
    );
  });

  test("rejects worker work orders missing handoff contracts", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      delete artifact.workerTaskPackets[0].handoffContract;
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /handoffContract/,
    );
  });

  test("rejects skipped choice gates without a safety rationale", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      delete artifact.preDecisionOptionFrame.skipSafetyRationale;
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /skipSafetyRationale/,
    );
  });

  test("rejects worker completion without per-file proof", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      delete artifact.workerResultPackets[0].fileCompletionList;
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /fileCompletionList/,
    );
  });

  test("rejects fabricated worker verification evidence", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.workerResultPackets[0].workerExecutionEvidence[0].status =
        "fabricated";
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /must not fabricate verification/,
    );
  });

  test("rejects skipped worker verification evidence for verified public-ready runs", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      for (const packet of artifact.workerResultPackets) {
        for (const evidence of packet.workerExecutionEvidence) {
          evidence.status = "skipped";
          evidence.skipReason = "not run";
          delete evidence.actualOutput;
          delete evidence.exitCode;
          delete evidence.commandRanAt;
        }
      }
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /skipped worker verification evidence/,
    );
  });

  test("rejects worker evidence that is not bound to a verify step", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      delete artifact.workerResultPackets[0].workerExecutionEvidence[0].verifyStepRef;
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /verifyStepRef/,
    );
  });

  test("rejects json-output verification evidence that is not parseable JSON", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      const evidence = artifact.workerResultPackets[0].workerExecutionEvidence[0];
      evidence.successMarkerFormat = "json-output";
      evidence.actualOutput = "not json";
      delete evidence.exitCode;
      delete evidence.commandRanAt;
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /parseable JSON/,
    );
  });

  test("rejects unstructured fix evidence for closed findings", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.verificationPacket.fixEvidence = [
        "src/auth/refresh.ts removed inline secret fallback",
      ];
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /fixEvidence/,
    );
  });

  test("rejects accepted risk without owner, reason, and revisit trigger", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.verificationPacket.verificationResults[0].closeState =
        "accepted_risk";
      artifact.verificationPacket.fixEvidence[0].result = "accepted_risk";
      delete artifact.verificationPacket.fixEvidence[0].riskOwner;
      delete artifact.verificationPacket.fixEvidence[0].riskReason;
      delete artifact.verificationPacket.fixEvidence[0].expiryOrRevisitTrigger;
      artifact.summaryPacket.publicReady = false;
      artifact.summaryPacket.verifyPassed = false;
      artifact.summaryPacket.blockedBy = ["finding-001 accepted risk"];
      artifact.runHeader.publicReady = false;
      artifact.publicReadyDecision.publicReady = false;
      artifact.publicReadyDecision.status = "partial";
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /accepted_risk/,
    );
  });

  test("rejects public-ready runs with open worker todos by default", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.workerTaskPackets[0].taskTodoState = "open";
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /taskTodoState=open/,
    );
  });

  test("rejects public-ready runs without comment review acknowledgment", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      delete artifact.summaryPacket.commentReviewAcknowledged;
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /commentReviewAcknowledged/,
    );
  });

  test("rejects runtime-generated agent ids as user-visible role names", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.dispatchEnvelopePacket.roleDisplayName = "agent-019e56a9";
      artifact.agentBlueprintPacket.roles[0].roleDisplayName =
        "agent-019e56a9";
      artifact.workerTaskPackets[0].roleDisplayName = "agent-019e56a9";
      artifact.orchestrationTaskBoardPacket.tasks[0].roleDisplayName =
        "agent-019e56a9";
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /runtime alias|runtime nickname|role-family/,
    );
  });

  test("rejects an invalid public-ready run artifact", async () => {
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", invalidFixture],
        {
          cwd: REPO_ROOT,
        },
      ),
    );
  });

  test("rejects any public-ready claim without contextEngineeringBudget", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      delete artifact.contextEngineeringBudget;
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /requires contextEngineeringBudget/,
    );
  });

  test("allows non-public-ready runs to omit contextEngineeringBudget", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      delete artifact.contextEngineeringBudget;
      artifact.runHeader.publicReady = false;
      artifact.summaryPacket.publicReady = false;
      artifact.summaryPacket.blockedBy = ["context engineering evidence not attached"];
      artifact.publicReadyDecision.publicReady = false;
      artifact.publicReadyDecision.status = "partial";
      artifact.compactionPacket.summaryDelta.publicReady = false;
      artifact.compactionPacket.summaryDelta.blockedBy = [
        "context engineering evidence not attached",
      ];
    });
    const result = await validateFixture(tempFixture);
    assert.equal(result.ok, true);
    assert.equal(
      result.validatedPackets.includes("contextEngineeringBudget"),
      false,
      "context budget must remain outside protocolFirst.requiredPackets",
    );
  });

  test("rejects public-ready context budgets with non-pass status or blockers", async (t) => {
    for (const testCase of [
      {
        name: "non-pass status",
        mutate: (context) => {
          context.status = "partial";
        },
        expected: /contextEngineeringBudget\.status=pass/,
      },
      {
        name: "nonempty blockedBy",
        mutate: (context) => {
          context.blockedBy = ["host_context_load_not_observed"];
        },
        expected: /contextEngineeringBudget\.blockedBy to be empty/,
      },
    ]) {
      const tempFixture = await writeTempFixture(t, (artifact) => {
        testCase.mutate(artifact.contextEngineeringBudget);
      });
      await assert.rejects(
        execFileAsync(
          "node",
          ["scripts/validate-run-artifact.mjs", tempFixture],
          { cwd: REPO_ROOT },
        ),
        testCase.expected,
        testCase.name,
      );
    }
  });

  test("rejects every incomplete public-ready context measurement", async (t) => {
    for (const testCase of [
      {
        field: "hostObservedContextLoad",
        value: false,
        expected: /hostObservedContextLoad=true/,
      },
      {
        field: "actualInputTokens",
        value: -1,
        expected: /actualInputTokens.*finite nonnegative number/,
      },
      {
        field: "duplicateRuleScanStatus",
        value: "not_run",
        expected: /duplicateRuleScanStatus=pass/,
      },
      {
        field: "conflictingRuleScanStatus",
        value: "not_run",
        expected: /conflictingRuleScanStatus=pass/,
      },
      {
        field: "omissionVerificationStatus",
        value: "not_verified",
        expected: /omissionVerificationStatus=pass/,
      },
    ]) {
      const tempFixture = await writeTempFixture(t, (artifact) => {
        artifact.contextEngineeringBudget.measurement[testCase.field] =
          testCase.value;
      });
      await assert.rejects(
        execFileAsync(
          "node",
          ["scripts/validate-run-artifact.mjs", tempFixture],
          { cwd: REPO_ROOT },
        ),
        testCase.expected,
        testCase.field,
      );
    }
  });

  test("rejects unobserved or unbound public-ready context sources", async (t) => {
    for (const testCase of [
      {
        name: "unobserved evidence state",
        mutate: (context) => {
          context.fixedContext[0].evidenceState = "declared_not_host_observed";
        },
        expected: /evidenceState.*host_observed_as_model_context/,
      },
      {
        name: "missing evidence ref",
        mutate: (context) => {
          delete context.variableContext[0].evidenceRef;
        },
        expected: /evidenceRef/,
      },
    ]) {
      const tempFixture = await writeTempFixture(t, (artifact) => {
        testCase.mutate(artifact.contextEngineeringBudget);
      });
      await assert.rejects(
        execFileAsync(
          "node",
          ["scripts/validate-run-artifact.mjs", tempFixture],
          { cwd: REPO_ROOT },
        ),
        testCase.expected,
        testCase.name,
      );
    }
  });

  test("rejects public-ready decisions without matching context fields", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      delete artifact.publicReadyDecision.contextEngineeringBudgetStatus;
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /publicReadyDecision\.contextEngineeringBudgetStatus must match/,
    );
  });

  test("rejects compaction packets that drop open findings", async () => {
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", invalidCompactionFixture],
        {
          cwd: REPO_ROOT,
        },
      ),
    );
  });

  test("rejects public-ready when selected executable capability was not invoked", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.capabilityInvocationTruthPacket.realInvocationCoverage.status =
        "partial";
      artifact.capabilityInvocationTruthPacket.realInvocationCoverage.missingFamilies =
        ["skill"];
      artifact.capabilityInvocationTruthPacket.rows[0].state =
        "selected_not_invoked";
      artifact.capabilityInvocationTruthPacket.rows[0].appliedCount = 0;
      artifact.publicReadyDecision.publicReady = true;
      artifact.publicReadyDecision.status = "pass";
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /realInvocationCoverage\.status=pass|selected executable capability/,
    );
  });

  test("rejects public-ready when invocation coverage has no host evidence count", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.capabilityInvocationTruthPacket.realInvocationCoverage.status = "pass";
      artifact.capabilityInvocationTruthPacket.realInvocationCoverage.missingFamilies = [];
      artifact.capabilityInvocationTruthPacket.realInvocationCoverage.hostEvidenceCount = 0;
      artifact.runtimeInvocationPlanPacket.evidence = [
        {
          family: "skill",
          state: "applied",
          providerId: "meta-theory",
          hostSurface: "skill",
          evidenceKind: "skill_application",
          evidenceRef: "skill:meta-theory:SKILL.md-read",
          passEligible: true,
        },
        {
          family: "command_script",
          state: "invoked",
          providerId: "npm-test",
          hostSurface: "shell",
          evidenceKind: "command_output",
          evidenceRef: "command:node-test:pass",
          passEligible: true,
        },
      ];
      for (const row of artifact.capabilityInvocationTruthPacket.rows) {
        row.invocationEvidenceRefs = [`fixture:${row.family}:evidence`];
      }
      artifact.summaryPacket.publicReady = true;
      artifact.publicReadyDecision.publicReady = true;
      artifact.publicReadyDecision.status = "pass";
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /hostEvidenceCount > 0/,
    );
  });

  test("rejects public-ready when top-level packet masks failing coreLoop truth", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.coreLoop = {
        runtimeInvocationPlanPacket: cloneJson(artifact.runtimeInvocationPlanPacket),
        hostInvocationRequestPacket: cloneJson(artifact.hostInvocationRequestPacket),
        capabilityInvocationTruthPacket: cloneJson(artifact.capabilityInvocationTruthPacket),
        productExperiencePacket: cloneJson(artifact.productExperiencePacket),
        publicReadyDecision: cloneJson(artifact.publicReadyDecision),
      };
      artifact.coreLoop.capabilityInvocationTruthPacket.realInvocationCoverage.status =
        "partial";
      artifact.coreLoop.capabilityInvocationTruthPacket.realInvocationCoverage.missingFamilies =
        ["skill"];
      artifact.coreLoop.capabilityInvocationTruthPacket.rows[0].state =
        "selected_not_invoked";
      artifact.coreLoop.publicReadyDecision.publicReady = false;
      artifact.coreLoop.publicReadyDecision.status = "partial";
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /must match coreLoop\.capabilityInvocationTruthPacket|publicReadyDecision\.publicReady must match/,
    );
  });

  test("rejects public-ready when summary and publicReadyDecision disagree", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.summaryPacket.publicReady = false;
      artifact.summaryPacket.blockedBy = ["forced disagreement"];
      artifact.publicReadyDecision.publicReady = true;
      artifact.publicReadyDecision.status = "pass";
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /false public-ready signals/,
    );
  });

  test("rejects interface integration runs without interfaceIntegrationContractPacket", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.taskClassification.triggerReasons.push("third_party_integration");
      artifact.businessFlowBlueprintPacket.deliverableType =
        "third_party_integration";
      delete artifact.interfaceIntegrationContractPacket;
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /interfaceIntegrationContractPacket is required/,
    );
  });

  test("rejects third-party interface integration packets that miss required gates", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.taskClassification.triggerReasons.push("third_party_integration");
      artifact.businessFlowBlueprintPacket.deliverableType =
        "third_party_integration";
      artifact.interfaceIntegrationContractPacket =
        validInterfaceIntegrationPacket("third_party");
      artifact.interfaceIntegrationContractPacket.reviewGates =
        artifact.interfaceIntegrationContractPacket.reviewGates.filter(
          (gate) => gate !== "signature_auth",
        );
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /must include signature_auth/,
    );
  });

  test("rejects interface integration packets that store raw secret values", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.taskClassification.triggerReasons.push("third_party_integration");
      artifact.businessFlowBlueprintPacket.deliverableType =
        "third_party_integration";
      artifact.interfaceIntegrationContractPacket =
        validInterfaceIntegrationPacket("third_party");
      artifact.interfaceIntegrationContractPacket.interfaceInventory[0].apiKeyValue =
        "not-allowed";
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /must not store secret values/,
    );
  });

  test("accepts a minimal valid third-party interface integration packet", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      addTriggerReason(artifact, "third_party_integration");
      artifact.businessFlowBlueprintPacket.deliverableType =
        "third_party_integration";
      artifact.productCompletenessPacket.designDimensions.push({
        dimensionId: "third_party_integration",
        status: "covered",
        evidenceRef: "interfaceIntegrationContractPacket",
      });
      artifact.interfaceIntegrationContractPacket =
        validInterfaceIntegrationPacket("third_party");
    });
    const result = await validateFixture(tempFixture);
    assert.equal(result.ok, true);
  });

  test("rejects product deliverables missing productCompletenessPacket", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      delete artifact.productCompletenessPacket;
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /productCompletenessPacket/,
    );
  });

  test("rejects product deliverables missing side-effect or rollback gates", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      delete artifact.sideEffectLedgerPacket;
      delete artifact.rollbackPlanPacket;
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /sideEffectLedgerPacket|rollbackPlanPacket/,
    );
  });

  test("rejects every non-public-ready design gate status", async (t) => {
    const contract = JSON.parse(
      await fs.readFile(
        path.join(REPO_ROOT, "config", "contracts", "workflow-contract.json"),
        "utf8",
      ),
    );
    const statusPolicy =
      contract.runDiscipline.runArtifactValidation
        .productGatePublicReadyStatusPolicy.packetStatusFields;

    for (const entry of statusPolicy) {
      const protocol = contract.protocols[entry.packet];
      const statusEnum = protocol.statusEnum ?? [];
      const rejectedStatuses = statusEnum.filter(
        (status) => !entry.publicReadyAllowed.includes(status),
      );
      assert.ok(
        rejectedStatuses.length > 0,
        `${entry.packet} should have at least one non-public-ready status`,
      );

      for (const badStatus of rejectedStatuses) {
        const tempFixture = await writeTempFixture(t, (artifact) => {
          artifact[entry.packet][entry.statusField] = badStatus;
        });
        await assert.rejects(
          execFileAsync(
            "node",
            ["scripts/validate-run-artifact.mjs", tempFixture],
            { cwd: REPO_ROOT },
          ),
          new RegExp(`${entry.packet}|publicReady`),
        );
      }
    }
  });

  test("rejects executable work misclassified as query", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.taskClassification.governanceFlow = "query";
      artifact.taskClassification.requestClass = "execute";
      artifact.taskClassification.taskClass = "A";
      artifact.taskClassification.ownerRequired = true;
      artifact.taskClassification.bypassReasons = ["pure_query"];
      artifact.businessFlowBlueprintPacket.deliverableType = "article";
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /governanceFlow=query|pure-query|misclassified/i,
    );
  });

  test("rejects gate evidence refs that do not resolve to artifact evidence", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.productCompletenessPacket.evidenceRefs = [
        "missingPacket.nonexistentEvidence",
      ];
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /evidenceRefs|missingPacket/,
    );
  });

  test("rejects missing design-time dimension coverage before public-ready", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.productCompletenessPacket.designDimensions = [];
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /designDimensions|core_highlight/,
    );
  });

  test("rejects design-time dimensions without evidence or omission reason", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.experienceQualityPacket.experienceDimensions = [];
      artifact.experienceQualityPacket.experienceDimensions.push({
        dimensionId: "media_audio_motion",
        status: "omitted_with_reason",
      });
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /media_audio_motion|omissionReason|evidenceRef/,
    );
  });

  test("rejects secret-like values inside design gate arrays", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.sideEffectLedgerPacket.sideEffects = [
        {
          kind: "external_api",
          secretValue: "sk-test-should-never-appear",
        },
      ];
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /must not store secret values/,
    );
  });

  test("rejects Evolution writeback targets that use local memory or continuity storage", async (t) => {
    for (const target of [
      "memory/capability-gaps.md",
      ".meta-kim/state/default/compaction/latest.json",
      "compaction/latest.json",
      "run-index.sqlite",
    ]) {
      const tempFixture = await writeTempFixture(t, (artifact) => {
        artifact.evolutionWritebackPacket.writebacks = [
          {
            target,
            reason: "invalid local continuity target for Evolution writeback",
          },
        ];
      });
      await assert.rejects(
        execFileAsync(
          "node",
          ["scripts/validate-run-artifact.mjs", tempFixture],
          { cwd: REPO_ROOT },
        ),
        /must not use memory, compaction, or run-index storage/,
      );
    }
  });

  test("rejects forbidden Evolution writeback targets even when writebackDecision is none", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.evolutionWritebackPacket.writebackDecision = "none";
      artifact.evolutionWritebackPacket.writebacks = [
        {
          target: "memory/patterns/session.md",
          reason: "invalid hidden writeback target",
        },
      ];
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /must not use memory, compaction, or run-index storage/,
    );
  });

  test("rejects Evolution writeback targets that traverse out of allowed roots", async (t) => {
    for (const target of [
      "canonical/skills/../runtime-assets/codex/config.toml.example",
      "config/contracts/../capability-index/meta-kim-capabilities.json",
    ]) {
      const tempFixture = await writeTempFixture(t, (artifact) => {
        artifact.evolutionWritebackPacket.writebacks = [
          {
            target,
            reason: "traversal must not bypass writeback target roots",
          },
        ];
      });
      await assert.rejects(
        execFileAsync(
          "node",
          ["scripts/validate-run-artifact.mjs", tempFixture],
          { cwd: REPO_ROOT },
        ),
        /must not contain path traversal/,
      );
    }
  });

  test("rejects Evolution writeback targets with Windows-style traversal", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.evolutionWritebackPacket.writebacks = [
        {
          target:
            "canonical\\skills\\..\\runtime-assets\\codex\\config.toml.example",
          reason: "backslash traversal must not bypass writeback target roots",
        },
      ];
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /must not contain path traversal/,
    );
  });

  test("accepts canonical Evolution writeback targets from the workflow contract", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.evolutionWritebackPacket.writebacks = [
        {
          target: "canonical/agents/meta-warden.md",
          reason: "agent boundary lesson belongs in the agent definition",
        },
        {
          target: "canonical/skills/meta-theory/SKILL.md",
          reason: "reusable governance rule belongs in the skill source",
        },
        {
          target: "config/capability-index/meta-kim-capabilities.json",
          reason: "capability ownership update belongs in the capability index",
        },
        {
          target: "config/contracts/workflow-contract.json",
          reason: "workflow gate updates belong in the workflow contract",
        },
      ];
    });
    const result = await validateFixture(tempFixture);
    assert.equal(result.ok, true);
  });

  test("rejects dispatch envelopes without ownerAgent", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.dispatchEnvelopePacket.ownerAgent = "";
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
    );
  });

  test("rejects dispatch envelopes with overlapping allowed/blocked capabilities", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.dispatchEnvelopePacket.blockedCapabilities = [
        ...artifact.dispatchEnvelopePacket.blockedCapabilities,
        artifact.dispatchEnvelopePacket.allowedCapabilities[0],
      ];
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
    );
  });

  test("rejects dispatch envelopes with illegal memoryMode", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.dispatchEnvelopePacket.memoryMode = "inherit_random_context";
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
    );
  });

  test("rejects circular worker dependencies", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      const secondTask = {
        ...artifact.workerTaskPackets[0],
        taskPacketId: "task-002",
        roleInstanceId: "auth-refresh#2",
        shardScope: ["auth-refresh-hardening:token-refresh-tests"],
        artifactNamespace: "auth-refresh-tests",
        dependsOn: [{ taskRef: "task-001", type: "gate" }],
      };
      artifact.workerTaskPackets[0].dependsOn = [
        { taskRef: "task-002", type: "gate" },
      ];
      artifact.workerTaskPackets.push(secondTask);
      artifact.workerResultPackets.push({
        ...artifact.workerResultPackets[0],
        taskPacketId: "task-002",
      });
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /cycle|circular/i,
    );
  });

  test("rejects parallel worker packets that are only read-only sidecars", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.workerTaskPackets[0].executionMode = "readonly_fetch_sidecar";
      const secondTask = {
        ...artifact.workerTaskPackets[0],
        taskPacketId: "task-002",
        executionMode: "readonly_review_sidecar",
        roleInstanceId: "auth-refresh#2",
        shardKey: "file-scope-tests",
        shardScope: ["auth-refresh-hardening:token-refresh-tests"],
        artifactNamespace: "auth-refresh-tests",
        dependsOn: [],
      };
      artifact.workerTaskPackets.push(secondTask);
      artifact.workerResultPackets.push({
        ...artifact.workerResultPackets[0],
        taskPacketId: "task-002",
      });
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /read-only sidecar|execution worker|parallelGroup/i,
    );
  });

  test("rejects missing fetchPacket for governed runs", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      delete artifact.fetchPacket;
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        {
          cwd: REPO_ROOT,
        },
      ),
    );
  });

  test("rejects content evidence without research capability discovery", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      delete artifact.contentEvidencePacket.researchCapabilityDiscovery;
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        {
          cwd: REPO_ROOT,
        },
      ),
      /researchCapabilityDiscovery/,
    );
  });

  test("rejects platformSurface as a research capability signal", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.contentEvidencePacket.researchCapabilityDiscovery.platformSurface =
        "desktop";
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        {
          cwd: REPO_ROOT,
        },
      ),
      /platformSurface/,
    );
  });

  test("rejects current-project fetch packets that check other projects", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.fetchPacket.projectsChecked = [
        ...artifact.fetchPacket.projectsChecked,
        {
          projectRef: "project-other",
          checkMode: "global_registry_hit",
          reason: "unexpected cross-project fetch",
        },
      ];
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        {
          cwd: REPO_ROOT,
        },
      ),
    );
  });

  test("rejects review findings that do not name a source project", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      delete artifact.reviewPacket.findings[0].sourceProject;
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        {
          cwd: REPO_ROOT,
        },
      ),
    );
  });

  test("rejects review process checks that omit Critical trigger reasons", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.reviewPacket.triggerVsSkipReasonCheck.triggerReasons =
        artifact.taskClassification.triggerReasons.filter(
          (reason) => reason !== "multi_file",
        );
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /triggerVsSkipReasonCheck.*triggerReasons/,
    );
  });

  test("rejects review process checks that claim pass for a mismatched skip reason", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.reviewPacket.triggerVsSkipReasonCheck.skipReason =
        "unrecorded_skip";
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /triggerVsSkipReasonCheck.*skipReason/,
    );
  });

  test("rejects dispatch envelopes missing reviewOwner", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.dispatchEnvelopePacket.reviewOwner = "";
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
    );
  });

  test("rejects dispatch envelopes missing verificationOwner", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.dispatchEnvelopePacket.verificationOwner = "";
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
    );
  });

  test("rejects missing orchestration task board for non-query flows", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      delete artifact.orchestrationTaskBoardPacket;
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        {
          cwd: REPO_ROOT,
        },
      ),
    );
  });

  test("rejects missing capability gap packet when owner creation is required", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.taskClassification.upgradeReasons = [
        ...artifact.taskClassification.upgradeReasons,
        "owner_creation_required",
      ];
      delete artifact.capabilityGapPacket;
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        {
          cwd: REPO_ROOT,
        },
      ),
    );
  });

  test("rejects execution agent card gaps when factory action is create_execution_agent", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.taskClassification.upgradeReasons = [
        ...artifact.taskClassification.upgradeReasons,
        "owner_creation_required",
      ];
      artifact.capabilityGapPacket = {
        gapId: "gap-001",
        requestedCapability: "topic-analysis",
        currentAgentsChecked: ["meta-prism", "meta-artisan"],
        insufficiencyReason:
          "No execution agent currently owns this business capability.",
        resolutionAction: "create_execution_agent",
        requestedBy: "meta-conductor",
        approvedBy: "meta-warden",
      };
      artifact.executionAgentCard = {
        agentId: "topic-analyst",
        purpose: "Owns topic analysis execution for growth workflows.",
        capabilities: ["topic-clustering", "trend-prioritization"],
        nonCapabilities: ["article-writing"],
        dependencies: ["findskill:topic-analysis"],
        inputs: ["growth goal", "candidate topics"],
        outputs: [],
      };
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        {
          cwd: REPO_ROOT,
        },
      ),
    );
  });

  test("rejects public executionAgentCard compatibility without external registry scope", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.capabilityGapPacket = {
        gapId: "gap-public-exec-agent",
        requestedCapability: "frontend implementation",
        currentAgentsChecked: ["meta-conductor", "meta-artisan"],
        insufficiencyReason:
          "Public Meta_Kim must not persist frontend-developer as an owner.",
        resolutionAction: "create_execution_agent",
        requestedBy: "meta-conductor",
        approvedBy: "meta-warden",
      };
      artifact.executionAgentCard = {
        agentId: "frontend-developer",
        businessRoleId: "frontend",
        roleDisplayName: "frontend",
        purpose: "External compatibility probe.",
        capabilities: ["frontend implementation"],
        nonCapabilities: ["governance ownership"],
        dependencies: ["react-best-practices"],
        inputs: ["task brief"],
        outputs: ["patch"],
      };
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        {
          cwd: REPO_ROOT,
        },
      ),
    );
  });

  test("accepts direct global agent reuse without copying into the project", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      routePrimaryExecutionOwner(artifact, "code-reviewer");
    });
    const { stdout } = await execFileAsync(
      "node",
      ["scripts/validate-run-artifact.mjs", tempFixture],
      { cwd: REPO_ROOT },
    );
    assert.equal(JSON.parse(stdout).ok, true);
  });

  test("rejects copying a directly usable global agent into the project", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      routePrimaryExecutionOwner(artifact, "code-reviewer");
      artifact.agentBlueprintPacket.roles[0].agentCopyPolicy =
        "copy_to_project_for_modification";
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /use_global_directly/,
    );
  });

  test("accepts project-local agent upgrade when global reuse is insufficient", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      routePrimaryExecutionOwner(artifact, "frontend-developer");
      addFactoryReviewParticipation(artifact);
      const role = artifact.agentBlueprintPacket.roles[0];
      role.ownerSource = "project_local";
      role.agentCopyPolicy = "copy_to_project_for_modification";
      role.ownerResolution = "upgrade_existing_owner";
      role.agentIterationPlan =
        "Copy the global frontend agent into the user project before adding project-specific UI knowledge.";
      artifact.capabilityGapPacket = {
        gapId: "gap-project-local-frontend-upgrade",
        requestedCapability: "project-specific frontend implementation",
        currentAgentsChecked: ["frontend-developer", "meta-artisan"],
        insufficiencyReason:
          "The global frontend agent is a partial fit but needs project-specific UI conventions.",
        resolutionAction: "upgrade_execution_agent",
        executionAgentRegistryScope: "project_local",
        requestedBy: "meta-conductor",
        approvedBy: "meta-warden",
      };
      artifact.executionAgentCard = {
        registryScope: "project_local",
        agentId: "frontend-developer",
        businessRoleId: "frontend",
        roleDisplayName: "frontend",
        purpose:
          "Project-local frontend owner with persistent project UI conventions.",
        capabilities: ["frontend implementation", "project UI conventions"],
        nonCapabilities: ["governance arbitration"],
        dependencies: ["global:frontend-developer"],
        inputs: ["task brief", "project UI rules"],
        outputs: ["project-local frontend patch"],
      };
    });
    const { stdout } = await execFileAsync(
      "node",
      ["scripts/validate-run-artifact.mjs", tempFixture],
      { cwd: REPO_ROOT },
    );
    assert.equal(JSON.parse(stdout).ok, true);
  });

  test("accepts project-local agent creation when no global owner fits", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      routeProjectLocalTopicCreation(artifact);
    });
    const { stdout } = await execFileAsync(
      "node",
      ["scripts/validate-run-artifact.mjs", tempFixture],
      { cwd: REPO_ROOT },
    );
    assert.equal(JSON.parse(stdout).ok, true);
  });

  test("rejects executionAgentCard that freezes worker task fields", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      routeProjectLocalTopicCreation(artifact);
      artifact.executionAgentCard.scopeFiles = ["app/topic/page.tsx"];
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /worker-task field/,
    );
  });

  test("rejects executionAgentCard that binds identity to a file path", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      routeProjectLocalTopicCreation(artifact);
      artifact.executionAgentCard.purpose =
        "Fix login bug in app/auth/page.tsx for the current request.";
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /concrete file path|single-run task/,
    );
  });

  test("rejects execution-agent factory without Chrysalis review participation", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      routePrimaryExecutionOwner(artifact, "topic-analyst");
      artifact.taskClassification.upgradeReasons = [
        ...artifact.taskClassification.upgradeReasons,
        "owner_creation_required",
      ];
      const role = artifact.agentBlueprintPacket.roles[0];
      role.ownerSource = "project_local";
      role.agentCopyPolicy = "create_project_local_agent";
      role.ownerResolution = "create_owner_first";
      artifact.capabilityGapPacket = {
        gapId: "gap-project-local-topic-agent",
        requestedCapability: "project-specific topic analysis",
        currentAgentsChecked: ["meta-scout"],
        insufficiencyReason:
          "No existing owner covers recurring topic analysis.",
        resolutionAction: "create_execution_agent",
        executionAgentRegistryScope: "project_local",
        requestedBy: "meta-conductor",
        approvedBy: "meta-warden",
      };
      artifact.executionAgentCard = {
        registryScope: "project_local",
        agentId: "topic-analyst",
        businessRoleId: "analysis",
        roleDisplayName: "analysis",
        purpose: "Project-local execution owner.",
        capabilities: ["topic analysis"],
        nonCapabilities: ["governance arbitration"],
        dependencies: ["meta-skill:research-analysis"],
        inputs: ["project goals"],
        outputs: ["ranked topic analysis"],
      };
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /meta-chrysalis/,
    );
  });

  test("rejects role blueprints missing required Fetch governance participation", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.agentBlueprintPacket.governanceStageCoverage.Fetch =
        artifact.agentBlueprintPacket.governanceStageCoverage.Fetch.filter(
          (owner) => owner !== "meta-genesis",
        );
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /meta-genesis/,
    );
  });

  test("rejects project-local copy when no modification is planned", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      routePrimaryExecutionOwner(artifact, "frontend-developer");
      const role = artifact.agentBlueprintPacket.roles[0];
      role.ownerSource = "project_local";
      role.agentCopyPolicy = "copy_to_project_for_modification";
      role.ownerResolution = "reuse_existing_owner";
      role.agentIterationPlan =
        "Copy the agent locally even though no persistent modification is planned.";
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /only agents that need modification are copied/,
    );
  });

  test("rejects unsupported run-scoped matched skill providers", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.agentBlueprintPacket.roles[0].matchedSkills[0].providerId =
        "unsupported-provider";
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        {
          cwd: REPO_ROOT,
        },
      ),
    );
  });

  test("rejects matched skill providers outside role providerCompatibility", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.agentBlueprintPacket.roles[0].providerCompatibility = [
        "superpowers",
      ];
      artifact.agentBlueprintPacket.roles[0].matchedSkills[0].providerId =
        "meta-theory";
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        {
          cwd: REPO_ROOT,
        },
      ),
    );
  });

  test("accepts role blueprints that use matchedCapabilities without matchedSkills", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      const role = artifact.agentBlueprintPacket.roles[0];
      const bindings = modernCapabilityBindings();
      delete role.matchedSkills;
      role.matchedCapabilities = bindings.matchedCapabilities;
      role.capabilityBindings = bindings.capabilityBindings;
    });
    const result = await validateFixture(tempFixture);
    assert.equal(result.ok, true);
  });

  test("rejects matchedCapabilities without concrete capabilityBindings", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      const role = artifact.agentBlueprintPacket.roles[0];
      const bindings = modernCapabilityBindings();
      delete role.matchedSkills;
      role.matchedCapabilities = bindings.matchedCapabilities;
      delete role.capabilityBindings;
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /capabilityBindings/,
    );
  });

  test("rejects role blueprints without matched capability evidence", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      const role = artifact.agentBlueprintPacket.roles[0];
      delete role.matchedSkills;
      delete role.matchedCapabilities;
      delete role.capabilityBindings;
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        { cwd: REPO_ROOT },
      ),
      /matchedCapabilities|matchedSkills/,
    );
  });

  test("accepts legacy role blueprints that only use matchedSkills", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      const role = artifact.agentBlueprintPacket.roles[0];
      delete role.matchedCapabilities;
      delete role.capabilityBindings;
    });
    const result = await validateFixture(tempFixture);
    assert.equal(result.ok, true);
  });

  // ── Cross-project flow tests ─────────────────────────────────────────

  test("accepts a valid cross-project run artifact (queryScope=all_projects)", async () => {
    const crossProjectFixture = path.join(
      REPO_ROOT,
      "tests",
      "fixtures",
      "run-artifacts",
      "valid-cross-project-run.json",
    );
    const result = await validateFixture(crossProjectFixture);
    assert.equal(result.ok, true);
  });

  test("rejects cross-project runs that use project_only route", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.taskClassification.queryScope = "all_projects";
      artifact.taskClassification.crossProjectReason =
        "user_explicit_cross_project_request";
      artifact.dispatchEnvelopePacket.route = "project_only";
      artifact.dispatchEnvelopePacket.memoryMode = "cross_project_readonly";
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        {
          cwd: REPO_ROOT,
        },
      ),
    );
  });

  test("rejects cross-project runs that use project_only memoryMode", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.taskClassification.queryScope = "all_projects";
      artifact.taskClassification.crossProjectReason =
        "user_explicit_cross_project_request";
      artifact.dispatchEnvelopePacket.route = "cross_project";
      artifact.dispatchEnvelopePacket.memoryMode = "project_only";
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        {
          cwd: REPO_ROOT,
        },
      ),
    );
  });

  test("rejects current-project runs with cross_project route", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.dispatchEnvelopePacket.route = "cross_project";
      artifact.dispatchEnvelopePacket.memoryMode = "cross_project_readonly";
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        {
          cwd: REPO_ROOT,
        },
      ),
    );
  });

  // ── Cross-project contamination check tests ──────────────────────────

  test("rejects review with crossProjectContaminationCheck=fail but revisionNeeded=false", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.reviewPacket.crossProjectContaminationCheck = "fail";
      artifact.reviewPacket.revisionNeeded = false;
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        {
          cwd: REPO_ROOT,
        },
      ),
    );
  });

  test("rejects summaryPacket.sourceProjects missing a review source project", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.reviewPacket.sourceProjects = [
        "project-auth-refresh-hardening",
        "project-other",
      ];
      artifact.fetchPacket.projectsChecked = [
        ...artifact.fetchPacket.projectsChecked,
        {
          projectRef: "project-other",
          checkMode: "global_registry_hit",
          reason: "cross-project reference",
        },
      ];
      artifact.summaryPacket.sourceProjects = [
        "project-auth-refresh-hardening",
      ];
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        {
          cwd: REPO_ROOT,
        },
      ),
    );
  });

  test("rejects summaryPacket.sourceProjects referencing unchecked projects", async (t) => {
    const tempFixture = await writeTempFixture(t, (artifact) => {
      artifact.summaryPacket.sourceProjects = [
        "project-auth-refresh-hardening",
        "project-never-checked",
      ];
    });
    await assert.rejects(
      execFileAsync(
        "node",
        ["scripts/validate-run-artifact.mjs", tempFixture],
        {
          cwd: REPO_ROOT,
        },
      ),
    );
  });
});
