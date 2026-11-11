import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_PATH, readFile } from "./_helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_PATH = path.join(__dirname, "scenarios", "clarity-gate-scenarios.json");

const requiredOptionSignals = [
  /change|touch|include|optimi[sz]e|apply|modify/i,
  /problem solved|solves|prevent|avoid|fix/i,
  /result|expected result|user gets/i,
  /advantage|benefit|why choose/i,
  /disadvantage|cost|risk|trade-off/i,
];

describe("Clarity Gate unified execution confirmation", async () => {
  const skillEntry = await fs.readFile(SKILL_PATH, "utf-8");
  const runtimeCodex = await readFile(
    "canonical/skills/meta-theory/references/runtime-codex.md",
  );
  const runtimeClaude = await readFile(
    "canonical/skills/meta-theory/references/runtime-claude.md",
  );
  const pathSelection = await readFile(
    "canonical/skills/meta-theory/references/path-selection.md",
  );
  const ownerResolution = await readFile(
    "canonical/skills/meta-theory/references/owner-resolution.md",
  );
  const skillContent = `${skillEntry}\n${runtimeCodex}\n${runtimeClaude}\n${pathSelection}\n${ownerResolution}`;
  const decisionTemplate = await readFile(
    "canonical/templates/user-interaction/decision-template.md",
  );
  const batchTemplate = await readFile(
    "canonical/templates/user-interaction/batch-decision-template.md",
  );
  const workflowContract = await readFile("config/contracts/workflow-contract.json");
  const workflowContractJson = JSON.parse(workflowContract);
  const coreLoopContract = await readFile("config/contracts/core-loop-contract.json");
  const coreLoopContractJson = JSON.parse(coreLoopContract);
  const devGov = await readFile(
    "canonical/skills/meta-theory/references/dev-governance.md",
  );

  test("confirmation happens after Fetch and Thinking, before Execution", () => {
    assert.match(skillContent, /Fetch\/content evidence.*Thinking\/pre-decision option framing/s);
    assert.match(skillContent, /At the transition from Thinking.*Execution/s);
    assert.match(skillContent, /After Thinking completes, BEFORE any Execution/);
    assert.match(skillContent, /DO NOT.*Critical\/Fetch\/Thinking\/Review/s);
  });

  test("Critical clarification is separate from execution confirmation", () => {
    assert.match(skillContent, /Critical clarification/i);
    assert.match(skillContent, /intent completeness framework/i);
    assert.match(skillContent, /not.*true human intent/i);
    assert.match(skillContent, /critical_clarification_allowed/i);
    assert.match(skillContent, /before executing a dispatch plan/i);
    assert.doesNotMatch(skillContent, /IMMEDIATELY invoke the native question tool/i);
  });

  test("confirmation includes AI understanding, additions, route, and candidate paths", () => {
    for (const phrase of [
      "AI understanding",
      "AI additions",
      "Capability route",
      "Candidate paths",
    ]) {
      assert.ok(skillContent.includes(phrase), `${phrase} must be present`);
    }
  });

  test("confirmation asks only outcome-branching questions and rejects quotas", () => {
    const confirmationBlock = skillContent.slice(
      skillContent.indexOf("Possible question dimensions:"),
      skillContent.indexOf("Wait for user response before proceeding to Execution."),
    );
    const questions = [...confirmationBlock.matchAll(/^\d+\.\s+.+Confirmation - ask only when.+$/gm)];
    assert.ok(questions.length >= 1, "expected question dimension examples");
    assert.match(skillContent, /no question quota/i);
    assert.match(skillContent, /Each visible question must change an execution branch/i);
    assert.match(skillContent, /Do not add filler options to satisfy a count/i);
    assert.doesNotMatch(skillContent, /4\+ questions|4-6 questions|minimum 4 questions/i);

    for (let i = 0; i < questions.length; i++) {
      const start = questions[i].index ?? 0;
      const end = i + 1 < questions.length ? (questions[i + 1].index ?? confirmationBlock.length) : confirmationBlock.length;
      const questionBlock = confirmationBlock.slice(start, end);
      const options = [...questionBlock.matchAll(/^\s+- Option [A-D]:/gm)];
      assert.ok(
        options.length >= 2,
        `${questions[i][0]} must have at least 2 materially different options`,
      );
    }
  });

  test("options use non-technical product wording with result, advantages, and disadvantages", () => {
    const optionLines = skillContent
      .split(/\r?\n/)
      .filter((line) => /^\s+- Option [A-D]:/.test(line));
    assert.ok(optionLines.length >= 12, "expected product option examples");
    for (const line of optionLines) {
      for (const signal of requiredOptionSignals.slice(2)) {
        assert.match(line, signal, `option missing product signal: ${line}`);
      }
    }
    assert.match(skillContent, /understandable to non-technical users/i);
  });

  test("templates enforce outcome-branching choices and product-readable dimensions", () => {
    const combined = `${decisionTemplate}\n${batchTemplate}`;
    assert.match(combined, /Ask only questions whose answer changes the user-visible result, scope, risk, cost, permission, or acceptance/);
    assert.match(combined, /Do not add filler questions or filler options to satisfy a count/);
    assert.match(combined, /Expected result/);
    assert.match(combined, /non-technical users/);
    assert.doesNotMatch(combined, /\*\*Your choice:\*\* \[ \] A \[ \] B\s*$/m);
  });

  test("workflow contract distinguishes native surfaces without requiring stage-by-stage popups", () => {
    assert.match(workflowContract, /nativeChoiceSurface|choiceSurfaces/);
    assert.doesNotMatch(
      workflowContract,
      /Critical\/Fetch\/Thinking\/Review confirmation/,
    );
  });

  test("subjective quality complaints trigger Critical clarification before Fetch", () => {
    const frame =
      workflowContractJson.runDiscipline?.qualityFirstPolicy
        ?.intentCompletenessFramework;
    const policy = frame?.subjectiveQualitySignalPolicy;
    assert.ok(policy, "subjective quality signal policy must exist");
    assert.equal(policy.required, true);
    for (const signal of [
      "good",
      "bad",
      "beautiful",
      "not_beautiful",
      "does_not_look_good",
      "ugly",
      "smooth",
      "hard_to_use",
      "feels_off",
      "not_smooth",
      "professional",
      "premium",
      "advanced",
      "clean",
      "simple",
      "fast",
      "slow",
    ]) {
      assert.ok(policy.triggerSignals?.includes(signal), `missing ${signal}`);
    }
    assert.match(policy.nonMeasurableAdjectiveRule, /good\/bad/);
    assert.match(policy.nonMeasurableAdjectiveRule, /smooth\/not smooth/);
    assert.match(policy.ambiguityChoiceSurfaceRule, /multiple valid outputs/);
    assert.match(policy.ambiguityChoiceSurfaceRule, /low-risk assumption/);
    for (const missing of [
      "target",
      "quality_dimension",
      "acceptance_standard",
      "allowed_scope",
    ]) {
      assert.ok(policy.blockingWhenMissing?.includes(missing), `missing ${missing}`);
    }

    const combined = `${runtimeCodex}\n${runtimeClaude}\n${workflowContract}`;
    assert.match(combined, /subjective quality|non-measurable adjective/i);
    assert.match(combined, /doesn't look good|does_not_look_good|ugly|professional|premium|smooth/i);
    assert.match(combined, /critical_clarification_allowed/);
    assert.match(combined, /before Fetch|before.*Fetch/i);
    assert.doesNotMatch(
      runtimeClaude,
      /AskUserQuestion called during Critical or Fetch stage/,
    );
  });

  test("non-trivial executable work requires preDecisionOptionFrame content evidence before decision", () => {
    const preDecisionOptionFrame =
      workflowContractJson.protocols?.preDecisionOptionFrame;
    assert.ok(
      preDecisionOptionFrame,
      "workflow contract must define protocols.preDecisionOptionFrame",
    );

    const requiredFields = preDecisionOptionFrame.requiredFields ?? [];
    for (const field of [
      "decisionTrigger",
      "contentEvidence",
      "optionFrame",
      "presentedBeforeDecision",
      "userChoiceState",
      "nativeChoiceSurface",
    ]) {
      assert.ok(
        requiredFields.includes(field),
        `preDecisionOptionFrame missing required field "${field}"`,
      );
    }

    const policyText = JSON.stringify(preDecisionOptionFrame);
    assert.match(policyText, /non[-_ ]trivial/i);
    assert.match(policyText, /executable/i);
    assert.match(policyText, /contentEvidence|content evidence/i);
    assert.match(policyText, /before.*decision|decision.*before/i);
  });

  test("pre-decision frame must close unclear questions before detailed orchestration", () => {
    const preDecisionOptionFrame =
      workflowContractJson.protocols?.preDecisionOptionFrame;
    assert.ok(
      preDecisionOptionFrame,
      "workflow contract must define protocols.preDecisionOptionFrame",
    );

    for (const field of ["unresolvedQuestions", "solutionChoiceState"]) {
      assert.ok(
        preDecisionOptionFrame.requiredFields?.includes(field),
        `preDecisionOptionFrame missing required field "${field}"`,
      );
    }

    const combined = `${skillContent}\n${devGov}\n${workflowContract}`;
    assert.match(combined, /unresolved questions|unclear questions|不明确问题/i);
    assert.match(combined, /candidate solution|候选解决方案/i);
    assert.match(combined, /solutionChoiceState/);
    assert.match(combined, /finalize.*dispatch|锁定方案|详细编排/i);
    assert.match(combined, /workerTaskPackets/);
  });

  test("contentEvidencePacket defines deep research requirements for evidence owner", () => {
    const packet = workflowContractJson.protocols?.contentEvidencePacket;
    assert.ok(packet, "workflow contract must define protocols.contentEvidencePacket");

    const requiredFields = packet.requiredFields ?? [];
    for (const field of [
      "researchCapabilityDiscovery",
      "deepResearchPlan",
      "sourceCategoryCoverage",
      "crossReferenceMatrix",
      "contradictionLog",
      "assumptionLedger",
      "decisionImpactMap",
    ]) {
      assert.ok(
        requiredFields.includes(field),
        `contentEvidencePacket missing deep research field "${field}"`,
      );
    }

    const policyText = JSON.stringify(packet);
    assert.match(policyText, /deep research/i);
    assert.match(policyText, /decision impact/i);
    assert.match(policyText, /evidence owner|Conductor/i);
    assert.match(policyText, /deepResearchPlanQualityGate/);
    assert.match(policyText, /sourceQualityLadder/);
    assert.match(policyText, /deepReadTargets/);
    assert.match(policyText, /claimAttributionRules/);
    assert.match(policyText, /originalSynthesisRules/);
    assert.match(policyText, /decisionQualityFrame/);
    assert.match(policyText, /minimumDecisionTest/);
    assert.match(policyText, /competingHypotheses/);
    assert.match(policyText, /evidenceConfidencePolicy/);
    assert.match(policyText, /decisionReadinessGate/);
    assert.match(policyText, /copying third-party prompt text/);
    assert.match(policyText, /cosmetic rewrites/);
  });

  test("decision information is responsibility-matched across stages, phases, and non-stage boundaries", () => {
    const coreStages = coreLoopContractJson.stages ?? [];
    assert.equal(coreStages.length, 8, "core loop must keep the eight-stage spine");
    for (const stage of coreStages) {
      const decision = stage.decisionResponsibilities;
      assert.ok(decision, `${stage.stage} must define decisionResponsibilities`);
      assert.equal(typeof decision.responsibilityRef, "string");
      assert.equal(typeof decision.decisionQuestion, "string");
      assert.ok(
        Array.isArray(decision.informationToCollect) &&
          decision.informationToCollect.length >= 3,
        `${stage.stage} must name stage-specific information inputs`,
      );
      assert.ok(
        Array.isArray(decision.decisionOutputs) &&
          decision.decisionOutputs.length >= 2,
        `${stage.stage} must name stage-specific decision outputs`,
      );
    }

    const businessWorkflow = workflowContractJson.businessWorkflow;
    const businessSemantics = businessWorkflow?.phaseDecisionSemantics;
    for (const phase of businessWorkflow?.phases ?? []) {
      const entry = businessSemantics?.phases?.[phase];
      assert.ok(entry, `business phase ${phase} must define decision semantics`);
      assert.equal(typeof entry.responsibility, "string");
      assert.equal(typeof entry.decisionQuestion, "string");
      assert.ok(Array.isArray(entry.informationToCollect));
      assert.ok(Array.isArray(entry.decisionOutputs));
    }

    const metaWorkflow = workflowContractJson.metaWorkflow;
    const metaSemantics = metaWorkflow?.phaseDecisionSemantics;
    for (const phase of metaWorkflow?.phases ?? []) {
      assert.ok(
        metaSemantics?.phases?.[phase],
        `meta phase ${phase} must define decision semantics`,
      );
    }

    const scopeTypes = businessWorkflow?.decisionContextPolicy?.scopeTypes ?? [];
    for (const scope of [
      "spine_stage",
      "business_phase",
      "meta_phase",
      "capability_route",
      "tool_or_provider",
      "verification_path",
      "evolution_writeback",
    ]) {
      assert.ok(scopeTypes.includes(scope), `decisionContextPolicy missing ${scope}`);
    }

    const impactStages =
      workflowContractJson.protocols?.contentEvidencePacket
        ?.decisionImpactStageEnum ?? [];
    for (const boundary of [
      "Meta-Review",
      "Verification",
      "Evolution",
      "business_phase",
      "meta_phase",
      "owner_weapon_dependency",
      "runtime_os_support",
      "user_interaction_surface",
    ]) {
      assert.ok(impactStages.includes(boundary), `decisionImpactStageEnum missing ${boundary}`);
    }
  });

  test("contentEvidencePacket requires capability-proof research discovery without platformSurface", () => {
    const packet = workflowContractJson.protocols?.contentEvidencePacket;
    assert.ok(packet, "workflow contract must define protocols.contentEvidencePacket");

    const requiredFields = packet.requiredFields ?? [];
    assert.ok(
      requiredFields.includes("researchCapabilityDiscovery"),
      "contentEvidencePacket must require researchCapabilityDiscovery",
    );

    const discovery = packet.researchCapabilityDiscovery;
    assert.ok(discovery, "contentEvidencePacket must define researchCapabilityDiscovery");

    for (const field of [
      "requiredCapabilities",
      "runtimeContext",
      "toolInventorySources",
      "availableRetrievalCapabilities",
      "selectedResearchPath",
      "capabilityGaps",
      "validatedBy",
    ]) {
      assert.ok(
        discovery.requiredFields?.includes(field),
        `researchCapabilityDiscovery missing required field "${field}"`,
      );
    }

    const policyText = JSON.stringify(discovery);
    assert.match(policyText, /toolInventorySources/);
    assert.match(policyText, /web_search|url_fetch|docs_lookup|mcp_search|plugin_search/);
    assert.match(policyText, /proof/);
    assert.match(policyText, /selectedResearchPath/);
    assert.match(policyText, /host-form-factor|capability proof|capability evidence/i);
    assert.doesNotMatch(policyText, /desktop \| cli \| web \| ide/i);
    assert.ok(
      discovery.forbiddenFields?.includes("platformSurface"),
      "platformSurface must be explicitly forbidden as a research capability signal",
    );
  });

  test("Codex uses request_user_input and blocks instead of downgrading", () => {
    const codexSurface =
      workflowContractJson.runDiscipline?.runtimeNativeChoiceSurfaces?.codex;
    assert.ok(codexSurface, "Codex native choice surface policy must exist");
    assert.equal(codexSurface.primarySurface, "request_user_input");
    assert.equal(codexSurface.featureFlag, "default_mode_request_user_input");
    assert.equal(
      codexSurface.recommendedConfig,
      "[features].default_mode_request_user_input = true",
    );
    assert.deepEqual(codexSurface.fallbackSurfaces, []);
    assert.equal(codexSurface.unavailableAction, "block_before_execution");

    const codexPolicyText = `${codexSurface.triggerDescription} ${codexSurface.implementation}`;
    assert.match(codexPolicyText, /request_user_input/i);
    assert.match(codexPolicyText, /default_mode_request_user_input/i);
    assert.match(codexPolicyText, /active schema's maximum meaningful option count/i);
    assert.match(codexPolicyText, /do not add a Meta_Kim lower cap/i);
    assert.match(codexPolicyText, /API 400|api_error/i);
    assert.match(codexPolicyText, /block before Execution|blocks before Execution/i);
    assert.match(codexPolicyText, /nativeChoiceSurfaceBlocked/i);
    assert.match(codexPolicyText, /exec|hook adapters/i);
    assert.match(codexPolicyText, /chat cards must not claim a popup|must not claim a popup/i);
    assert.match(codexPolicyText, /AI understanding/i);
    assert.match(codexPolicyText, /Candidate paths/i);
    assert.match(codexPolicyText, /host-maximum set/i);
    assert.doesNotMatch(codexPolicyText, /localized confirmation card/i);
  });

  test("Claude Code uses native AskUserQuestion for branch-changing decisions", () => {
    const claudeSurface =
      workflowContractJson.runDiscipline?.runtimeNativeChoiceSurfaces?.claude;
    assert.ok(claudeSurface, "Claude native choice surface policy must exist");
    assert.equal(claudeSurface.primarySurface, "AskUserQuestion_tool");
    assert.deepEqual(claudeSurface.fallbackSurfaces, []);
    assert.equal(claudeSurface.unavailableAction, "block_before_execution");

    const claudePolicyText = `${claudeSurface.triggerDescription} ${claudeSurface.implementation}\n${runtimeClaude}`;
    assert.match(claudePolicyText, /AskUserQuestion/);
    assert.match(claudePolicyText, /questions array/i);
    assert.match(claudePolicyText, /popup|host UI/i);
    assert.match(claudePolicyText, /nativeChoiceSurfaceBlocked/i);
    assert.match(claudePolicyText, /deferred `AskUserQuestion`|deferred AskUserQuestion/i);
    assert.match(claudePolicyText, /maximum meaningful option count/i);
    assert.match(claudePolicyText, /not a Meta_Kim product cap/i);
    assert.match(claudePolicyText, /No filler questions/i);
    assert.match(claudePolicyText, /AI understanding/i);
    assert.match(claudePolicyText, /Candidate paths/i);
    assert.match(claudePolicyText, /host owns the skin|host owns.*skin|host owns/i);
    assert.match(claudePolicyText, /issue #12031/);
    assert.doesNotMatch(claudePolicyText, /fall back to .*localized chat decision card/i);
  });

  test("Codex meta-theory choice surfaces use native UI without exposing protocol logs", () => {
    assert.match(skillContent, /Codex Multi-Option Choice Surface Rule/);
    assert.match(skillContent, /default_mode_request_user_input/);
    assert.match(skillContent, /request_user_input/);
    assert.match(skillContent, /confirmation or decision surface/s);
    assert.match(skillContent, /native interactive surface|native choice surface/i);
    assert.match(skillContent, /block before Execution/i);
    assert.match(skillContent, /Do not show a `Preflight` block/i);
    assert.match(skillContent, /unless the user explicitly asks for debug, audit, protocol, or governance trace output/i);
    assert.match(skillContent, /active runtime-native maximum meaningful option count/i);
    assert.match(skillContent, /explicit output-language choice/i);
    assert.match(skillContent, /latest input/i);
    assert.match(skillContent, /Option A.*placeholders|placeholders.*Option A/s);
    assert.match(skillContent, /resolved user-facing language/i);
    assert.match(skillContent, /instead of hardcoding any single human language/i);
    assert.match(skillContent, /active `request_user_input` schema/i);
    assert.match(skillContent, /future or different host exposes more/i);
    assert.match(skillContent, /structured decision panel/i);
    assert.match(skillContent, /AI understanding/i);
    assert.doesNotMatch(skillContent, /方案 A/);
    assert.doesNotMatch(skillContent, /当前以聊天确认卡展示，不是弹窗/);
    assert.match(skillContent, /Claude Code native question tool remains unchanged/i);

    const codexPolicy =
      workflowContractJson.runDiscipline?.userInteractionPolicy
        ?.codexVisibleMultiOptionOutput;
    assert.ok(codexPolicy, "workflow contract must define Codex visible multi-option policy");
    assert.equal(codexPolicy.required, true);
    assert.equal(codexPolicy.minimumOptions, 2);
    assert.equal(
      codexPolicy.appliesTo,
      "every_user_visible_codex_meta_theory_confirmation_or_decision_surface",
    );
    assert.equal(codexPolicy.normalPresentation, "native_request_user_input");
    assert.equal(codexPolicy.debugLabel, "Multi-Option Snapshot");
    assert.equal(codexPolicy.visibleLabelRequired, false);
    assert.equal(codexPolicy.internalPreflightHiddenByDefault, true);
    assert.ok(codexPolicy.internalFieldsHiddenByDefault?.includes("Preflight"));
    assert.ok(codexPolicy.internalFieldsHiddenByDefault?.includes("nativeChoiceSurface"));
    assert.ok(codexPolicy.internalFieldsHiddenByDefault?.includes("conversation_fallback"));
    assert.equal(codexPolicy.debugVisibilityRequiresExplicitUserRequest, true);
    assert.equal(
      codexPolicy.languagePolicy,
      "runtime_tool_selected_output_language_else_explicit_output_language_choice_else_latest_user_input_language",
    );
    assert.equal(codexPolicy.protocolIdentifiersRemainCanonical, true);
    assert.equal(codexPolicy.fallbackMustDeclareNotPopup, true);
    assert.equal(codexPolicy.claudeNativeChoiceSurfaceUnchanged, true);

    const nativePanel =
      workflowContractJson.runDiscipline?.userInteractionPolicy
        ?.nativeStructuredPanelContract;
    assert.ok(nativePanel, "workflow contract must define native structured panel contract");
    assert.equal(
      nativePanel.runtimeNativeOptionPolicy?.strategy,
      "use_active_host_schema_maximum_meaningful_options",
    );
    assert.equal(nativePanel.runtimeNativeOptionPolicy?.noMetaKimLowerCap, true);
    assert.equal(
      nativePanel.runtimeNativeOptionPolicy?.currentObservedHostMaximums?.codex
        ?.notProductCap,
      true,
    );
    assert.ok(nativePanel.forbidden?.includes("meta_kim_lower_option_cap"));
    assert.ok(!nativePanel.forbidden?.includes("four_option_codex_request_user_input_payload"));
    assert.ok(nativePanel.requiredPanelSections?.includes("AI understanding"));
    assert.ok(nativePanel.requiredOptionSemantics?.includes("verification impact"));
  });

  test("Cursor choice surface uses stable alwaysApply chat-card fallback", async () => {
    const cursorSurface =
      workflowContractJson.runDiscipline?.runtimeNativeChoiceSurfaces?.cursor;
    assert.ok(cursorSurface, "Cursor choice surface policy must exist");
    assert.equal(cursorSurface.primarySurface, "alwaysApply_rule_chat_card");
    assert.ok(
      cursorSurface.fallbackSurfaces?.includes("conversation_fallback"),
      "Cursor must fall back to conversation cards",
    );
    const cursorPolicyText = `${cursorSurface.triggerDescription} ${cursorSurface.implementation}`;
    assert.match(cursorPolicyText, /alwaysApply/i);
    assert.match(cursorPolicyText, /chat decision card/i);
    assert.match(cursorPolicyText, /preToolUse/i);
    assert.match(cursorPolicyText, /failClosed/i);
    assert.match(cursorPolicyText, /native modal|popup/i);

    const cursorRule = await readFile(
      "canonical/runtime-assets/cursor/rules/meta-choice-surface.mdc",
    );
    assert.match(cursorRule, /alwaysApply: true/);
    assert.match(cursorRule, /Do not call this a popup/i);
    assert.match(cursorRule, /conversation_fallback/);
  });

  test("Choice Surface Gate forbids premature popup or execution confirmation", () => {
    const combined = `${skillContent}\n${workflowContract}\n${devGov}`;
    const gate =
      workflowContractJson.runDiscipline?.userInteractionPolicy
        ?.choiceSurfaceGate;

    assert.ok(gate, "workflow contract must define choiceSurfaceGate");
    assert.equal(gate.required, true);
    assert.equal(gate.stateField, "choiceSurfaceState");
    for (const state of [
      "not_allowed",
      "critical_clarification_allowed",
      "execution_confirmation_allowed",
      "completed",
    ]) {
      assert.ok(gate.stateEnum?.includes(state), `missing state ${state}`);
      assert.match(combined, new RegExp(state));
    }

    assert.match(combined, /FORBIDDEN: premature choice surface/i);
    assert.match(combined, /test a popup|interactive box|popup_test_request/i);
    assert.match(combined, /Critical[\s\S]*Fetch[\s\S]*Thinking/);
    assert.match(combined, /intent frame/i);
    assert.match(combined, /changes the user-visible result, scope, risk, acceptance, permission, or non-goal/i);
    assert.match(combined, /must not present execution options/i);
    assert.match(combined, /contentEvidencePacket[\s\S]*preDecisionOptionFrame/);
    assert.match(combined, /No candidate paths means no execution confirmation/i);
    assert.match(combined, /no Fetch evidence means Thinking is not complete/i);
    assert.match(combined, /no Thinking result means no pre-Execution confirmation/i);
  });

  test("post-choice analysis must respect user selections instead of overriding direction", () => {
    const combined = `${skillContent}\n${devGov}`;

    assert.match(combined, /Respect user choices \(after questioning\)/i);
    assert.match(combined, /Base the analysis on the user's actual selections/i);
    assert.match(combined, /not on what the model "thinks is better"/i);
    assert.match(combined, /significant risk/i);
    assert.match(combined, /Thinking/i);
    assert.match(combined, /Option A[\s\S]*user's original choice/i);
    assert.match(combined, /Option B[\s\S]*suggested adjustment/i);
    assert.match(combined, /Do not unilaterally override their selection/i);
  });
});

describe("Clarity Gate scenario JSON remains valid", async () => {
  const rawJson = await fs.readFile(SCENARIOS_PATH, "utf-8");
  const scenarios = JSON.parse(rawJson);

  test("scenarios file contains at least 12 entries", () => {
    assert.ok(scenarios.length >= 12, `expected at least 12 scenarios, got ${scenarios.length}`);
  });

  test("each scenario keeps reviewable pass/fail criteria", () => {
    for (const scenario of scenarios) {
      assert.equal(typeof scenario.id, "string");
      assert.equal(typeof scenario.input, "string");
      assert.ok(Array.isArray(scenario.ambiguousDims));
      assert.equal(typeof scenario.expectedBehavior, "string");
      assert.equal(typeof scenario.passFailCriteria?.PASS, "string");
      assert.equal(typeof scenario.passFailCriteria?.FAIL, "string");
    }
  });

  test("subjective design complaint scenario requires native choice before mutation", () => {
    const scenario = scenarios.find((s) => s.id === "CG-13");
    assert.ok(scenario, "CG-13 subjective quality scenario must exist");
    assert.match(scenario.input, /不好看/);
    assert.ok(scenario.ambiguousDims.includes("Success criteria"));
    assert.match(scenario.expectedBehavior, /native choice surface|localized fallback|交互式选择|确认卡/i);
    assert.match(scenario.expectedBehavior, /before Fetch|before.*mutation/i);
    assert.match(scenario.passFailCriteria.PASS, /澄清审美|体验方向/);
    assert.match(scenario.passFailCriteria.FAIL, /猜|直接开始改 UI/);
  });

  test("non-measurable adjective scenario requires user calibration", () => {
    const scenario = scenarios.find((s) => s.id === "CG-14");
    assert.ok(scenario, "CG-14 non-measurable adjective scenario must exist");
    assert.match(scenario.input, /顺畅|高级|好一点/);
    assert.ok(scenario.ambiguousDims.includes("Success criteria"));
    assert.match(scenario.expectedBehavior, /不可量化|non-measurable|judgment/i);
    assert.match(scenario.expectedBehavior, /native choice surface|localized fallback|交互式选择|确认卡/i);
    assert.match(scenario.passFailCriteria.PASS, /判断标准|验收标准/);
    assert.match(scenario.passFailCriteria.FAIL, /猜|直接/);
  });
});
