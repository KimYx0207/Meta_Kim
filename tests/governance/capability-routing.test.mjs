import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import test from "node:test";

function route(task, runtime = "auto", os = "auto", extraArgs = []) {
  const result = spawnSync(process.execPath, ["scripts/select-execution-route.mjs", "--task", task, "--runtime", runtime, "--os", os, "--json", ...extraArgs], {
    encoding: "utf8",
    maxBuffer: Number.POSITIVE_INFINITY,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function assertNativeCodexSpawn(
  binding,
  ownerAgent,
  packet = null,
  expectedMode = "run_scoped_owner_contract",
) {
  assert.equal(binding?.hostSurface, "spawn_agent");
  assert.deepEqual(binding?.supportedHostSurfaces, ["spawn_agent", "followup_task"]);
  assert.equal(binding?.ownerAgent, ownerAgent);
  assert.equal(binding?.ownerBindingMode, expectedMode);
  assert.equal(
    binding?.nativeAgentType,
    expectedMode === "native_custom_agent" ? ownerAgent : null,
  );
  assert.match(binding?.task_name ?? "", /^[a-z0-9_]+$/);
  assert.ok((binding?.task_name ?? "").length <= 64);
  assert.notEqual(binding?.task_name, ownerAgent, "task_name is a run-scoped label, not the professional owner identity");
  assert.equal(binding?.fork_turns, "none");
  assert.equal(typeof binding?.message, "string");
  const message = JSON.parse(binding.message);
  assert.equal(message.ownerAgent, ownerAgent);
  assert.equal(message.ownerKind, "agent");
  assert.equal(message.ownerBindingMode, expectedMode);
  assert.equal(
    message.nativeAgentType,
    expectedMode === "native_custom_agent" ? ownerAgent : null,
  );
  assert.equal(message.ownerDefinition.sourceRef, binding.ownerSource);
  assert.equal(
    message.ownerDefinition.nativeCustomAgentEligible,
    binding.ownerDefinition.nativeCustomAgentEligible,
  );
  assert.equal(message.metaKimBinding.family, "agent_subagent");
  assert.equal(message.metaKimBinding.providerId, `global:${ownerAgent}`);
  assert.equal(message.metaKimBinding.taskPacketId, message.taskPacketId);
  assert.equal(message.metaKimBinding.roleInstanceId, message.roleInstanceId);
  assert.equal(message.metaKimBinding.evidenceKind, "spawn_agent_result");
  assert.equal(binding?.followupTaskTemplate?.hostSurface, "followup_task");
  assert.equal(binding?.followupTaskTemplate?.target, null);
  assert.equal(
    binding?.followupTaskTemplate?.targetPolicy,
    "existing_runtime_instance_id_only_not_owner_identity",
  );
  const followupMessage = JSON.parse(binding.followupTaskTemplate.message);
  assert.deepEqual(followupMessage.metaKimBinding, message.metaKimBinding);
  if (expectedMode === "native_custom_agent") {
    assert.equal(followupMessage.ownerBindingMode, "run_scoped_owner_contract");
    assert.equal(followupMessage.nativeAgentType, null);
  } else {
    assert.deepEqual(followupMessage, message);
  }
  assert.equal(message.outputContract.verificationOwner, packet?.verificationOwner ?? "meta-prism");
  if (packet) {
    assert.equal(message.taskPacketId, packet.taskPacketId);
    assert.equal(message.roleDisplayName, packet.roleDisplayName);
    assert.notEqual(message.roleDisplayName, binding.task_name);
    assert.equal(message.roleInstanceId, packet.roleInstanceId);
    assert.equal(message.coordination.parallelGroup, packet.parallelGroup);
    assert.equal(message.coordination.mergeOwner, packet.mergeOwner);
    assert.equal(message.scope.purpose, packet.purpose);
  }
  assert.equal(binding?.hostSurfaceProbeRequired, true);
  if (expectedMode === "native_custom_agent") {
    assert.equal(binding?.ownerSelectorField, "agent_type");
    assert.equal(binding?.agent_type, ownerAgent);
    assert.equal(
      binding?.invocationReadiness,
      "native_custom_agent_request_ready_success_still_requires_host_result",
    );
  } else {
    assert.equal(binding?.ownerSelectorField, null);
    assert.match(binding?.invocationReadiness ?? "", /^run_scoped_ready_/u);
    assert.equal(Object.hasOwn(binding ?? {}, "agent_type"), false);
  }
  assert.equal(Object.hasOwn(binding ?? {}, "fork_context"), false);
  assert.equal(Object.hasOwn(binding ?? {}, "messageRef"), false);
}

test("routing fixtures recall internal patterns and platform/OS matrices", () => {
  const pureQuery = route("Meta_Kim 是什么？", "codex", "windows");
  assert.equal(pureQuery.entryClassification.path, "fast_path");
  assert.equal(pureQuery.routeExecutionGate?.applies, false);
  assert.equal(pureQuery.routeExecutionGate?.canEnterExecution, false);
  assert.equal(pureQuery.routeExecutionGate?.blockedBy.includes("runtime_capability_acceptance_required"), false);
  const fuzzy = route("fuzzy strategy task");
  assert.ok(fuzzy.candidateWeapons.includes("meta-kim-decision-patterns"));
  assert.ok(
    fuzzy.ownerDiscoveryPacket?.governanceStages?.Critical?.requiredAgents?.includes("meta-warden"),
    "Critical stage governance owner discovery must be visible",
  );
  assert.ok(
    fuzzy.ownerDiscoveryPacket?.governanceStages?.Fetch?.requiredAgents?.includes("meta-artisan"),
    "Fetch stage governance owner discovery must be visible",
  );
  assert.ok(
    Array.isArray(fuzzy.ownerDiscoveryPacket?.projectRuntimeAgents),
    "project runtime agents must be listed even when none are selected",
  );
  assert.ok(
    fuzzy.ownerDiscoveryPacket?.discoveryPrinciple === "canonical_index_first_capability_discovery_owner_last_binding",
    "route discovery must expose canonical/index-first discovery and owner-last binding principle",
  );
  assert.equal(
    fuzzy.ownerDiscoveryPacket?.searchOrder?.[0],
    "repo_canonical_capability_index",
    "canonical capability index must be collected before provider matching",
  );
  assert.ok(
    fuzzy.ownerDiscoveryPacket?.ownerBindingOrder?.includes("local_global_agent_inventory"),
    "local global inventory must be part of owner binding",
  );
  assert.ok(
    fuzzy.ownerDiscoveryPacket?.searchOrder?.includes("available_capability_providers_skills_tools_mcp"),
    "skill/tool/MCP providers must still be checked before agent creation",
  );
  const projectProjectionPolicy = fuzzy.ownerDiscoveryPacket?.projectProjectionPolicy ?? {};
  const projectRuntimeProvidersExpected = projectProjectionPolicy.projectRuntimeProvidersExpected !== false;
  assert.equal(typeof projectProjectionPolicy.projectProjectionMode, "string");
  assert.ok(
    ["project_runtime_inventory", "local_global_runtime_inventory"].includes(projectProjectionPolicy.validationProviderLayer),
    "route output must name the runtime provider validation layer",
  );
  if (projectRuntimeProvidersExpected) {
    assert.ok(
      fuzzy.ownerDiscoveryPacket?.projectRuntimeSkillProviders?.some((provider) => provider.id === "meta-theory"),
      "project-local skill providers must be visible in owner discovery",
    );
    assert.ok(
      fuzzy.ownerDiscoveryPacket?.projectRuntimeCapabilityProviders?.some((provider) => provider.type === "hooks"),
      "project-local hook providers must be visible in owner discovery",
    );
    assert.ok(
      fuzzy.ownerDiscoveryPacket?.projectRuntimeCapabilityProviders?.some((provider) => provider.type === "rules"),
      "project-local rule/prompt providers must be visible in owner discovery",
    );
    assert.ok(
      fuzzy.ownerDiscoveryPacket?.capabilityProviderCoverage?.projectRuntimeLightScan?.commands >
        fuzzy.ownerDiscoveryPacket?.projectRuntimeCapabilityProviders?.length,
      "the regression fixture must contain enough commands to exercise bounded route evidence",
    );
    for (const [providerId, sourceRef] of [
      ["codex-hooks-json", ".codex/hooks.json"],
      ["claude-settings-json", ".claude/settings.json"],
      ["cursor-hooks-json", ".cursor/hooks.json"],
      ["openclaw-template-json", "openclaw/openclaw.template.json"],
    ]) {
      assert.ok(
        fuzzy.ownerDiscoveryPacket?.projectRuntimeCapabilityProviders?.some(
          (provider) => provider.id === providerId && provider.sourceRef === sourceRef,
        ),
        `${sourceRef} must survive bounded route evidence when commands outnumber the output limit`,
      );
    }
    assert.ok(
      fuzzy.ownerDiscoveryPacket?.projectRuntimeCapabilityProviders?.some(
        (provider) => provider.id?.startsWith("package-script:") && provider.sourceRef?.startsWith("package.json#scripts."),
      ),
      "at least one package.json command provider must survive bounded route evidence",
    );
  } else {
    const routeSearchRefs = fuzzy.ownerDiscoveryPacket.capabilityDiscoverySearchLog
      .map((entry) => `${entry.source}:${entry.sourceRef}`)
      .join("\n");
    assert.equal(projectProjectionPolicy.projectProjectionMode, "global_only");
    assert.equal(projectProjectionPolicy.validationProviderLayer, "local_global_runtime_inventory");
    assert.match(routeSearchRefs, /\.meta-kim\/local\.overrides\.json#projectProjectionMode=global_only/);
    assert.match(routeSearchRefs, /~\/\.codex\/hooks\.json/);
    assert.ok(
      fuzzy.ownerDiscoveryPacket?.capabilityProviderCoverage?.localGlobalCached?.hooks >= 1,
      "global_only route validation must rely on cached global hook providers",
    );
  }
  assert.ok(
    fuzzy.ownerDiscoveryPacket?.capabilityProviderCoverage?.localGlobalCached?.plugins >= 1,
    "cached global plugin providers must be counted without per-run full scan",
  );
  assert.ok(
    fuzzy.ownerDiscoveryPacket?.runtimeToolProviders?.some((provider) => provider.type === "runtimeTools"),
    "runtime tool providers must be visible as reusable provider evidence",
  );
  assert.ok(
    fuzzy.ownerDiscoveryPacket?.capabilityProviderCoverage?.projectRuntimeLightScan?.runtimeTools >= 1,
    "runtime tool coverage must be exposed alongside skills, commands, hooks, MCP, plugins, rules, and prompts",
  );
  assert.equal(
    fuzzy.ownerDiscoveryPacket?.globalInventoryFreshness?.mode,
    "cached_global_inventory_plus_project_light_scan",
    "per-run routing must use cached global inventory plus light project scan",
  );
  assert.equal(fuzzy.ownerDiscoveryPacket?.globalInventoryFreshness?.staleAfterMinutes, 20160);
  assert.equal(fuzzy.ownerDiscoveryPacket?.globalInventoryFreshness?.staleAfterDays, 14);
  assert.equal(typeof fuzzy.ownerDiscoveryPacket?.globalInventoryFreshness?.refreshRequiredBeforeExecution, "boolean");
  assert.equal(fuzzy.routeExecutionGate?.canPreviewRoute, true);
  assert.equal(typeof fuzzy.routeExecutionGate?.canEnterExecution, "boolean");
  assert.ok(
    fuzzy.ownerDiscoveryPacket?.candidateReusableCapabilityProviders?.length > 0,
    "reusable capability providers must be listed before create/upgrade",
  );
  if (fuzzy.candidateDependencyProjects.includes("kim-decision")) {
    assert.equal(fuzzy.rankedRoutes.some((route) => route.dependencyProject === "kim-decision" && route.scoreBand === "execute"), false);
  }

  const goalContract = route("帮我把这个模糊目标整理成 Goal Prompt 和 Loop Prompt，先不要执行", "codex", "windows");
  assert.equal(goalContract.taskShape, "goal_contract");
  assert.equal(goalContract.recommendedRoute?.weapon, "goalpro");
  assert.equal(goalContract.recommendedRoute?.dependencyProject, "goalpro");
  assert.equal(goalContract.recommendedRoute?.boundary?.executionMode, "prompt_only");
  assert.equal(goalContract.recommendedRoute?.boundary?.notExecutor, true);
  assert.equal(goalContract.rankedRoutes.some((candidate) => candidate.dependencyProject === "kim-decision" && candidate.scoreBand === "execute"), false);

  const codeRefactor = route("帮我重构这个前端模块并运行测试", "codex", "windows");
  assert.equal(codeRefactor.taskShape, "engineering_execution");
  assert.equal(codeRefactor.rankedRoutes.some((candidate) => candidate.dependencyProject === "kim-decision" && candidate.scoreBand === "execute"), false);

  const contentGrowthDecision = route("内容营销中，标题文案和封面设计怎样提升转化，帮我判断怎么改", "codex", "windows");
  assert.equal(contentGrowthDecision.taskShape, "strategy_product_decision");
  assert.equal(contentGrowthDecision.recommendedRoute?.id, "kim-decision-lens:codex:windows");
  assert.equal(contentGrowthDecision.recommendedRoute?.dependency, null);
  assert.equal(contentGrowthDecision.recommendedRoute?.decisionLensProvider, "kim-decision");
  assert.equal(contentGrowthDecision.recommendedRoute?.boundary?.executionMode, "model_context");
  assert.equal(contentGrowthDecision.recommendedRoute?.boundary?.notExecutor, true);
  assert.deepEqual(
    contentGrowthDecision.decisionExperiencePlan?.sequence?.map((step) => step.step),
    ["critical_decision", "fetch_evidence_decision", "thinking_path_decision"],
  );
  assert.match(contentGrowthDecision.decisionExperiencePlan?.goalProBoundary ?? "", /not triggered by this route/i);
  assert.match(contentGrowthDecision.decisionExperiencePlan?.evolutionBoundary ?? "", /not the place that creates user Goals/i);

  const contentAutomationBuild = route("帮我做一个内容营销自动发布器，需要内容策略、前端界面、后端 API、数据模型、平台集成、权限风控、测试验收和发布运维", "codex", "windows");
  assert.equal(contentAutomationBuild.recommendedRoute?.id, "product-build-orchestration:codex:windows");

  const product = route("product monetization task");
  assert.ok(product.internalDecisionPatterns.includes("thinking-minimum-test"));

  const chineseProduct = route("模糊目标：帮我把一个产品商业化，但我不知道先做增长、定价还是转化", "codex", "windows");
  assert.equal(chineseProduct.taskShape, "strategy_product_decision");
  assert.equal(chineseProduct.intentAmplificationPrecheck.needsIntentAmplification, true);
  assert.equal(chineseProduct.recommendedRoute?.weapon, "meta-kim-decision-patterns");
  assert.equal(chineseProduct.recommendedRoute?.dependencyProject, null);

  const subjectiveQuality = route("这个页面不好看，帮我弄高级一点", "codex", "windows");
  assert.equal(
    subjectiveQuality.recommendedRoute?.selectedCapabilityProviders?.verificationCommand?.id,
    "package-script:meta:route:validate",
    "evidence prioritization must not change the provider selected for execution",
  );
  assert.equal(Object.hasOwn(subjectiveQuality.entryClassification ?? {}, "ambiguityPacket"), false);
  assert.equal(Object.hasOwn(subjectiveQuality.entryClassification ?? {}, "subagentAuthorizationSource"), false);
  assert.equal(subjectiveQuality.routeExecutionGate?.entryChoiceDecision?.choicePolicy, "must_ask");
  assert.equal(subjectiveQuality.routeExecutionGate?.nativeChoiceSurface?.primarySurface, "request_user_input");
  assert.equal(subjectiveQuality.routeExecutionGate?.canEnterExecution, false);
  assert.equal(subjectiveQuality.routeExecutionGate?.handoffStatus, "blocked");
  assert.equal(subjectiveQuality.routeExecutionGate?.hostAction, "none");
  assert.equal(subjectiveQuality.routeExecutionGate?.canHandoffToHost, false);
  assert.ok(
    subjectiveQuality.routeExecutionGate?.blockedBy?.includes("runtime_capability_known_unsupported"),
    "persisted advisory evidence must not authorize a native choice handoff in the current run",
  );
  assert.equal(subjectiveQuality.routeExecutionGate?.persistentAcceptanceAuthorizesExecution, false);
  assert.equal(subjectiveQuality.recommendedRoute?.id, "subjective-ui-design-orchestration:codex:windows");
  assert.equal(
    subjectiveQuality.autonomousCapabilityDiscovery?.trigger,
    "entry_classifier_auto_governed_entry",
    "ordinary vague product/UI input must self-start capability discovery",
  );
  assert.equal(
    subjectiveQuality.autonomousCapabilityDiscovery?.requiredByDefault,
    true,
    "capability discovery must be a default entry behavior, not a user-reminder side effect",
  );
  assert.equal(
    subjectiveQuality.autonomousCapabilityDiscovery?.userReminderDetected,
    false,
    "the no-keyword subjective request fixture proves discovery was not triggered by the user's stage words",
  );
  for (const family of ["execution_agents", "skills", "mcp_servers", "commands", "runtime_tools", "verification_owner"]) {
    assert.ok(
      subjectiveQuality.autonomousCapabilityDiscovery?.familiesChecked?.includes(family),
      `autonomous capability discovery must check ${family}`,
    );
  }
  for (const source of [
    "project_runtime_inventory",
    "claude_global_inventory_cache",
    "codex_global_inventory_cache",
    "cursor_global_inventory_cache",
    "openclaw_global_inventory_cache",
    "codex_global_skill_filesystem_light_scan",
    "mcp_inventory",
    "package_json_scripts",
  ]) {
    assert.ok(
      subjectiveQuality.autonomousCapabilityDiscovery?.sourcesChecked?.includes(source),
      `autonomous capability discovery must check ${source}`,
    );
  }
  assert.match(
    subjectiveQuality.autonomousCapabilityDiscovery?.sourceRefPolicy ?? "",
    /~\/\.codex.*~\/\.claude.*~\/\.cursor.*~\/\.openclaw.*~\/\.agents/i,
    "reportable source refs must use a cross-runtime home-relative policy",
  );
  assert.equal(
    subjectiveQuality.typeFirstRoutePolicy?.policyKind,
    "route_selection_invariant",
    "route output must expose type-first classification as an invariant",
  );
  assert.equal(
    subjectiveQuality.typeFirstRoutePolicy?.mustNotBecomeChecklist,
    true,
    "type-first routing must not become another acceptance checklist",
  );
  assert.equal(
    subjectiveQuality.typeFirstRoutePolicy?.axes?.objectType?.forbiddenFallback,
    "guess_executable_route_from_shape_only",
    "route-critical object types must not be guessed from shape alone",
  );
  assert.equal(
    subjectiveQuality.typeFirstRoutePolicy?.axes?.evidenceType?.forbiddenFallback,
    "validator_pass_as_runtime_truth",
    "evidence typing must keep validator pass separate from runtime truth",
  );
  assert.equal(
    subjectiveQuality.typeFirstRoutePolicy?.axes?.ownershipType?.unclearAction,
    "preserve_or_block_until_owner_is_known",
    "unknown ownership must preserve or block instead of overwriting local state",
  );
  assert.equal(subjectiveQuality.routeExecutionGate?.typeFirstPolicyRef, "typeFirstRoutePolicy");
  assert.equal(subjectiveQuality.routeTypeClassification?.policyRef, "typeFirstRoutePolicy");
  assert.equal(
    subjectiveQuality.routeTypeClassification?.evidenceType?.claimLimit,
    "route_preview_not_runtime_truth",
    "structural route output must not claim runtime truth",
  );
  assert.equal(
    subjectiveQuality.routeTypeClassification?.objectType?.forbiddenFallbackAvoided,
    true,
    "route type classification must avoid object-shape guessing",
  );
  assert.ok(subjectiveQuality.decisionCheckpoints?.length >= 3);
  assert.ok(
    subjectiveQuality.decisionCheckpoints.some((checkpoint) => checkpoint.stage === "Thinking"),
    "subjective UI work must ask again after Fetch/Thinking when route choices diverge",
  );
  assert.ok(
    subjectiveQuality.workerTaskPacketDrafts?.some((packet) => packet.roleDisplayName === "frontend"),
    "subjective UI route must create frontend work lanes",
  );
  assert.ok(
    subjectiveQuality.workerTaskPacketDrafts?.some((packet) => packet.roleDisplayName === "test"),
    "subjective UI route must create browser/test verification lanes",
  );
  assert.ok(
    subjectiveQuality.workerTaskPacketDrafts?.some((packet) => packet.roleDisplayName === "review"),
    "subjective UI route must create a real review lane",
  );
  assert.ok(
    /read target page\/component\/style files/i.test(
      subjectiveQuality.subjectiveUiCapabilityAmplification?.readBeforeEditPolicy ?? "",
    ),
    "subjective UI implementation lane must preserve read-before-edit behavior",
  );
  assert.ok(
    JSON.stringify(subjectiveQuality.recommendedRoute?.selectedCapabilityProviders ?? {}).match(
      /product-design|design-review|design-html|e2e|browser/i,
    ),
    "subjective UI route must bind concrete design/frontend/browser/review capabilities",
  );
  assert.equal(subjectiveQuality.recommendedRoute?.blockedReasons?.length, 0);
  assert.equal(
    JSON.stringify(subjectiveQuality.recommendedRoute?.selectedCapabilityProviders ?? {}).includes("C:/Users/"),
    false,
    "route provider refs should not leak local absolute home paths into reportable route JSON",
  );
  assert.ok(
    subjectiveQuality.routeExecutionGate?.blockedBy.includes(
      "native_choice_surface_required_before_execution",
    ),
  );
  assert.equal(subjectiveQuality.routeExecutionGate?.returnToStage, "Critical");
  assert.notEqual(
    subjectiveQuality.recommendedRoute?.weapon,
    "dependency-project-registry",
    "subjective quality choices must stay on the internal decision/route path unless dependency discovery is explicit",
  );

  const subjectiveQualityWithReminder = route(
    "这个页面不好看，帮我弄高级一点 critical and fetch thinking and review",
    "codex",
    "windows",
  );
  assert.equal(
    subjectiveQualityWithReminder.recommendedRoute?.id,
    subjectiveQuality.recommendedRoute?.id,
    "explicit stage words must not be required to reach the subjective UI orchestration route",
  );
  assert.equal(subjectiveQualityWithReminder.autonomousCapabilityDiscovery?.userReminderDetected, true);
  assert.deepEqual(
    subjectiveQualityWithReminder.workerTaskPacketDrafts?.map((packet) => packet.roleInstanceId),
    subjectiveQuality.workerTaskPacketDrafts?.map((packet) => packet.roleInstanceId),
    "the no-keyword route must get the same lane amplification as the explicit stage-word route",
  );

  const subjectiveQualityConfirmed = route(
    "这个页面不好看，帮我弄高级一点",
    "codex",
    "windows",
    [
      "--native-choice-evidence",
      JSON.stringify({
        surface: "request_user_input",
        choices: [
          {
            stage: "Critical",
            status: "completed",
            evidenceRef: "codex:request_user_input:critical-answer",
          },
        ],
      }),
    ],
  );
  assert.equal(subjectiveQualityConfirmed.routeExecutionGate?.canEnterExecution, false);
  assert.ok(
    subjectiveQualityConfirmed.routeExecutionGate?.blockedBy.includes(
      "thinking_route_choice_required_before_execution",
    ),
  );
  assert.equal(subjectiveQualityConfirmed.routeExecutionGate?.returnToStage, "Critical");
  assert.equal(subjectiveQualityConfirmed.routeExecutionGate?.nativeChoiceSurface?.evidence?.trusted, false);

  const subjectiveQualityFullyConfirmed = route(
    "这个页面不好看，帮我弄高级一点",
    "codex",
    "windows",
    [
      "--native-choice-evidence",
      JSON.stringify({
        surface: "request_user_input",
        choices: [
          {
            stage: "Critical",
            status: "completed",
            evidenceRef: "codex:request_user_input:critical-answer",
          },
          {
            stage: "Thinking",
            status: "completed",
            evidenceRef: "codex:request_user_input:thinking-answer",
          },
        ],
      }),
    ],
  );
  assert.equal(subjectiveQualityFullyConfirmed.routeExecutionGate?.canEnterExecution, false);
  assert.equal(subjectiveQualityFullyConfirmed.routeExecutionGate?.handoffStatus, "blocked");
  assert.equal(subjectiveQualityFullyConfirmed.routeExecutionGate?.hostAction, "none");
  assert.ok(subjectiveQualityFullyConfirmed.routeExecutionGate?.blockedBy.includes("native_choice_surface_required_before_execution"));
  assert.ok(subjectiveQualityFullyConfirmed.routeExecutionGate?.blockedBy.includes("thinking_route_choice_required_before_execution"));
  assert.ok(subjectiveQualityFullyConfirmed.routeExecutionGate?.blockedBy.includes("runtime_capability_known_unsupported"));
  assert.equal(subjectiveQualityFullyConfirmed.routeExecutionGate?.blockedBy.includes("runtime_capability_acceptance_required"), false);
  assert.equal(subjectiveQualityFullyConfirmed.routeExecutionGate?.persistentAcceptanceAuthorizesExecution, false);
  assert.equal(subjectiveQualityFullyConfirmed.routeExecutionGate?.thinkingChoiceSurface?.evidenceTrusted, false);

  const claudeSubjectiveQuality = route(
    "这个页面不好看，帮我弄高级一点",
    "claude_code",
    "windows",
  );
  assert.equal(
    claudeSubjectiveQuality.routeExecutionGate?.nativeChoiceSurface?.primarySurface,
    "AskUserQuestion",
  );
  assert.equal(
    claudeSubjectiveQuality.routeExecutionGate?.thinkingChoiceSurface?.primarySurface,
    "AskUserQuestion",
  );
  const claudeWrongSurfaceEvidence = route(
    "这个页面不好看，帮我弄高级一点",
    "claude_code",
    "windows",
    [
      "--native-choice-evidence",
      JSON.stringify({
        surface: "request_user_input",
        choices: [
          { stage: "Critical", status: "completed", evidenceRef: "wrong-runtime:critical" },
          { stage: "Thinking", status: "completed", evidenceRef: "wrong-runtime:thinking" },
        ],
      }),
    ],
  );
  assert.equal(
    claudeWrongSurfaceEvidence.routeExecutionGate?.nativeChoiceSurface?.evidence?.trusted,
    false,
  );
  const claudeNativeChoiceEvidence = route(
    "这个页面不好看，帮我弄高级一点",
    "claude_code",
    "windows",
    [
      "--native-choice-evidence",
      JSON.stringify({
        surface: "AskUserQuestion",
        choices: [
          { stage: "Critical", status: "completed", evidenceRef: "claude:critical" },
          { stage: "Thinking", status: "completed", evidenceRef: "claude:thinking" },
        ],
      }),
    ],
  );
  assert.equal(
    claudeNativeChoiceEvidence.routeExecutionGate?.nativeChoiceSurface?.evidence?.trusted,
    false,
  );

  for (const highRiskTask of [
    "删除生产数据库并发布上线",
    "deploy this release to production and remove the old database",
  ]) {
    const highRiskRoute = route(highRiskTask, "claude_code", "windows");
    assert.equal(highRiskRoute.entryClassification?.governedEntry, true);
    assert.equal(
      highRiskRoute.routeExecutionGate?.entryChoiceDecision?.critical?.choicePolicy,
      "must_ask",
    );
    assert.equal(
      highRiskRoute.routeExecutionGate?.nativeChoiceSurface?.primarySurface,
      "AskUserQuestion",
    );
    assert.equal(highRiskRoute.routeExecutionGate?.canEnterExecution, false);
  }

  const subjectiveQualityForgedChoice = route(
    "这个页面不好看，帮我弄高级一点",
    "codex",
    "windows",
    ["--native-choice-evidence", "completed"],
  );
  assert.equal(subjectiveQualityForgedChoice.routeExecutionGate?.canEnterExecution, false);
  assert.equal(
    subjectiveQualityForgedChoice.routeExecutionGate?.nativeChoiceSurface?.evidence?.trusted,
    false,
  );
  assert.equal(
    subjectiveQualityForgedChoice.routeExecutionGate?.nativeChoiceSurface?.evidence?.status,
    "invalid",
  );

  const subjectiveQualityUnreferencedChoice = route(
    "这个页面不好看，帮我弄高级一点",
    "codex",
    "windows",
    [
      "--native-choice-evidence",
      JSON.stringify({
        surface: "request_user_input",
        choices: [
          { stage: "Critical", status: "completed" },
          { stage: "Thinking", status: "completed" },
        ],
      }),
    ],
  );
  assert.equal(subjectiveQualityUnreferencedChoice.routeExecutionGate?.canEnterExecution, false);
  assert.equal(
    subjectiveQualityUnreferencedChoice.routeExecutionGate?.nativeChoiceSurface?.evidence?.trusted,
    false,
  );

  const refactor = route("complex code refactor");
  assert.ok(refactor.recommendedRoute || refactor.capabilityGapPacket);
  assert.ok(refactor.capabilityGapPacket || !/^meta-/.test(refactor.recommendedRoute?.owner ?? ""), "Pure code execution must not route governance agent as implementation worker");
  if (!refactor.recommendedRoute) {
    assert.equal(refactor.routeExecutionGate?.canEnterExecution, false, "Execution gate must block when no route is recommended");
  }

  const smoke = route(
    "Create a provider smoke test that discovers an execution agent, finds a skill provider, finds an MCP provider, and emits a verification command",
    "codex",
    "windows",
  );
  assert.equal(smoke.taskShape, "engineering_execution");
  assert.equal(smoke.recommendedRoute?.id, "execution-capability-discovery:codex:windows");
  assert.ok(!/^meta-/.test(smoke.recommendedRoute?.owner ?? ""), "Engineering smoke route must use an execution owner");
  assert.equal(smoke.recommendedRoute?.selectedCapabilityProviders?.skillDiscovery?.id, "findskill");
  assert.equal(smoke.recommendedRoute?.selectedCapabilityProviders?.skillCreation?.id, "meta-skill-creator");
  assert.equal(
    smoke.recommendedRoute?.selectedCapabilityProviders?.skillDiscovery?.platformId,
    "codex",
    "Codex smoke route must prefer the Codex-installed findskill provider over same-name Claude Code skills",
  );
  assert.equal(
    smoke.recommendedRoute?.selectedCapabilityProviders?.skillCreation?.platformId,
    "codex",
    "Codex smoke route must prefer the Codex-installed meta-skill-creator provider over same-name Claude Code skills",
  );
  assert.ok(smoke.recommendedRoute?.selectedCapabilityProviders?.agent, "Engineering smoke route must bind an execution agent provider");
  assert.notEqual(
    smoke.recommendedRoute?.selectedCapabilityProviders?.agent?.platformId,
    "claudeCode",
    "Codex smoke route must not bind Claude Code global agents as execution owners",
  );
  assert.equal(smoke.recommendedRoute?.selectedCapabilityProviders?.agentCreation?.id, "create-agent");
  assert.ok(smoke.recommendedRoute?.selectedCapabilityProviders?.skill, "Engineering smoke route must bind a skill provider");
  assert.ok(
    smoke.recommendedRoute?.selectedCapabilityProviders?.mcpServer || smoke.recommendedRoute?.selectedCapabilityProviders?.mcpTool,
    "Engineering smoke route must bind an MCP provider",
  );
  assert.ok(smoke.recommendedRoute?.selectedCapabilityProviders?.command || smoke.recommendedRoute?.selectedCapabilityProviders?.runtimeTool);
  const smokeHasUnsafeParallelDrafts =
    smoke.workerTaskPacketDrafts?.length >= 2 &&
    smoke.workerTaskPacketDrafts.some(
      (packet) =>
        packet.shardScope.length === 0 ||
        packet.workspaceIsolation === "unproven" ||
        packet.safetyEvidence?.status !== "proven",
    );
  assert.equal(smoke.routeExecutionGate?.canEnterExecution, !smokeHasUnsafeParallelDrafts);
  if (smokeHasUnsafeParallelDrafts) {
    assert.ok(smoke.routeExecutionGate?.blockedBy.includes("parallel_lane_safety_not_proven"));
    assert.equal(smoke.routeExecutionGate?.returnToStage, "Thinking");
  }

  const claudeSmoke = route(
    "Create a provider smoke test that discovers an execution agent, finds a skill provider, finds an MCP provider, and emits a verification command",
    "claude_code",
    "windows",
  );
  assert.equal(
    claudeSmoke.recommendedRoute?.selectedCapabilityProviders?.skillCreation?.id,
    "meta-skill-creator",
    "Claude Code smoke route must select the replacement meta-skill-creator provider",
  );
  assert.equal(
    claudeSmoke.recommendedRoute?.selectedCapabilityProviders?.skillCreation?.platformId,
    "claudeCode",
    "Claude Code smoke route must prefer the Claude Code-installed meta-skill-creator provider",
  );

  const claudeAgentSearch = route(
    "在 Claude Code 里运行 agent 搜索不对 critical and fetch thinking and review",
    "claude_code",
    "windows",
  );
  assert.equal(
    claudeAgentSearch.recommendedRoute?.id,
    "execution-capability-discovery:claude_code:windows",
    "Claude Code agent-search complaints must route to execution capability discovery",
  );
  assert.notEqual(
    claudeAgentSearch.recommendedRoute?.selectedCapabilityProviders?.agent?.runtime,
    "codex",
    "Claude Code must not bind Codex project agent adapters as execution owners",
  );
  assert.ok(
    !String(claudeAgentSearch.recommendedRoute?.selectedCapabilityProviders?.agent?.sourceRef ?? "").startsWith(".codex/agents/"),
    "Claude Code agent search must not select .codex/agents adapters as callable Claude agents",
  );

  const codexAgentReuseComplaint = route(
    "Critical Thinking Fetch Deep Thinking Review 为什么 Codex 一直创建 agent 而不是找全局 agent",
    "codex",
    "windows",
  );
  assert.equal(
    codexAgentReuseComplaint.recommendedRoute?.id,
    "execution-capability-discovery:codex:windows",
    "Codex agent-creation complaints must route to execution capability discovery before dependency/project registry",
  );
  assert.equal(
    codexAgentReuseComplaint.recommendedRoute?.selectedCapabilityProviders?.agent?.platformId,
    "codex",
    "Codex owner discovery must bind a Codex-callable global/project agent provider",
  );
  assertNativeCodexSpawn(
    codexAgentReuseComplaint.recommendedRoute?.codexSpawnBinding,
    codexAgentReuseComplaint.recommendedRoute?.owner,
  );
  assertNativeCodexSpawn(
    codexAgentReuseComplaint.workerTaskPacketDrafts?.[0]?.codexSpawnBinding,
    codexAgentReuseComplaint.recommendedRoute?.owner,
    codexAgentReuseComplaint.workerTaskPacketDrafts?.[0],
  );

  const codexAgentTypeSchema = JSON.stringify({
    hostSurface: "spawn_agent",
    inputProperties: ["task_name", "message", "agent_type"],
    evidenceSource: "active_host_tool_schema",
  });
  const codexNativeCustomAgentRoute = route(
    "Critical Thinking Fetch Deep Thinking Review 为什么 Codex 一直创建 agent 而不是找全局 agent",
    "codex",
    "windows",
    ["--codex-host-tool-schema", codexAgentTypeSchema],
  );
  assertNativeCodexSpawn(
    codexNativeCustomAgentRoute.recommendedRoute?.codexSpawnBinding,
    codexNativeCustomAgentRoute.recommendedRoute?.owner,
  );
  assertNativeCodexSpawn(
    codexNativeCustomAgentRoute.workerTaskPacketDrafts?.[0]?.codexSpawnBinding,
    codexNativeCustomAgentRoute.recommendedRoute?.owner,
    codexNativeCustomAgentRoute.workerTaskPacketDrafts?.[0],
  );
  assert.equal(
    codexNativeCustomAgentRoute.recommendedRoute?.codexSpawnBinding
      ?.hostToolSchemaEvidence?.suppliedArtifactRejected,
    true,
  );
  assert.equal(
    codexAgentReuseComplaint.capabilityGapDetected,
    false,
    "A complaint about repeated agent creation must not be misread as a create-agent capability gap request",
  );

  const codexContextualCreationComplaint = route(
    "我看他好像还是一直在自己创建",
    "codex",
    "windows",
  );
  assert.equal(
    codexContextualCreationComplaint.recommendedRoute?.id,
    "execution-capability-discovery:codex:windows",
    "Contextual Chinese repeated-creation complaints must inspect Codex owner reuse instead of falling to a low-signal route",
  );
  assert.equal(
    codexContextualCreationComplaint.capabilityGapDetected,
    false,
    "Contextual repeated-creation complaints must not become create_agent capability gaps",
  );
  assertNativeCodexSpawn(
    codexContextualCreationComplaint.recommendedRoute?.codexSpawnBinding,
    codexContextualCreationComplaint.recommendedRoute?.owner,
  );

  const codexExplicitParallelDispatch = route(
    "我要的是派发啊 并行啊：检查 meta-theory 规则、Codex runtime、测试缺口",
    "codex",
    "windows",
  );
  assert.equal(
    codexExplicitParallelDispatch.recommendedRoute?.id,
    "execution-capability-discovery:codex:windows",
    "Direct parallel dispatch requests must route to execution capability discovery",
  );
  assert.ok(
    codexExplicitParallelDispatch.workerTaskPacketDrafts.length >= 2,
    "Direct parallel dispatch requests with separable scopes must produce multiple worker task packets",
  );
  assert.ok(
    codexExplicitParallelDispatch.workerTaskPacketDrafts.every((packet) => packet.ownerKind === "agent"),
    "Direct parallel dispatch worker lanes must bind reusable agent owners instead of replacing owners with skills",
  );
  for (const packet of codexExplicitParallelDispatch.workerTaskPacketDrafts) {
    assertNativeCodexSpawn(packet.codexSpawnBinding, packet.ownerAgent, packet);
  }
  assert.equal(codexExplicitParallelDispatch.dispatchBoardDraft?.dispatchMode, "fan_out_ready");
  assert.equal(codexExplicitParallelDispatch.dispatchBoardDraft?.fanoutReadiness?.thinkingApproved, true);
  assert.equal(
    new Set(codexExplicitParallelDispatch.workerTaskPacketDrafts.map((packet) => packet.codexSpawnBinding.task_name)).size,
    codexExplicitParallelDispatch.workerTaskPacketDrafts.length,
    "Native Codex task names must remain unique after normalization",
  );
  assert.ok(
    codexExplicitParallelDispatch.dispatchBoardDraft?.orchestratorKinds?.includes("agentTeamsPlaybook"),
    "Multiple Codex agent lanes must select the agent teams fan-out adapter",
  );

  const codexStructuredChainFanout = route(
    "Critical Thinking → Fetch → Deep Thinking → Review 检查 meta-theory 规则、Codex runtime、测试缺口",
    "codex",
    "windows",
  );
  assert.equal(Object.hasOwn(codexStructuredChainFanout.entryClassification ?? {}, "subagentAuthorizationSource"), false);
  assert.equal(codexStructuredChainFanout.entryClassification?.signals?.structuredGovernanceChainRequest, true);
  assert.equal(
    codexStructuredChainFanout.recommendedRoute?.id,
    "execution-capability-discovery:codex:windows",
    "Structured chain fan-out must route through execution capability discovery",
  );
  assert.ok(
    codexStructuredChainFanout.workerTaskPacketDrafts.length >= 2,
    "Structured chain fan-out with separable scopes must produce multiple worker task packets",
  );
  for (const packet of codexStructuredChainFanout.workerTaskPacketDrafts) {
    assert.equal(packet.ownerKind, "agent");
    assertNativeCodexSpawn(packet.codexSpawnBinding, packet.ownerAgent, packet);
  }

  const codexMetaTriggerFanout = route(
    "meta-theory 检查 meta-theory 规则、Codex runtime、测试缺口",
    "codex",
    "windows",
  );
  assert.equal(Object.hasOwn(codexMetaTriggerFanout.entryClassification ?? {}, "subagentAuthorizationSource"), false);
  assert.equal(codexMetaTriggerFanout.entryClassification?.signals?.explicitMetaTheory, true);
  assert.equal(
    codexMetaTriggerFanout.recommendedRoute?.id,
    "execution-capability-discovery:codex:windows",
    "Meta-theory fan-out must route through execution capability discovery when there are separable scopes",
  );
  assert.ok(
    codexMetaTriggerFanout.workerTaskPacketDrafts.length >= 2,
    "Meta-theory fan-out with separable scopes must produce multiple worker task packets",
  );
  for (const packet of codexMetaTriggerFanout.workerTaskPacketDrafts) {
    assert.equal(packet.ownerKind, "agent");
    assertNativeCodexSpawn(packet.codexSpawnBinding, packet.ownerAgent, packet);
  }

  const codexCapabilityCoreComplaint = route(
    "帮我实现 Agent Skill Command MCP 的调用并修复核心功能 Critical Thinking → Fetch → Deep Thinking → Review",
    "codex",
    "windows",
  );
  const unsafeDrafts = codexCapabilityCoreComplaint.workerTaskPacketDrafts.filter(
    (packet) =>
      packet.shardScope.length === 0 ||
      packet.workspaceIsolation === "unproven" ||
      packet.safetyEvidence?.status === "unproven",
  );
  if (unsafeDrafts.length > 0) {
    assert.notEqual(
      codexCapabilityCoreComplaint.dispatchBoardDraft?.dispatchMode,
      "fan_out_ready",
      "An implementation request naming Agent/Skill/Command/MCP must not become safe live fan-out while lane isolation is unproven",
    );
    assert.equal(codexCapabilityCoreComplaint.dispatchBoardDraft?.fanoutReadiness?.thinkingApproved, false);
  }

  const codexWhitespaceFanout = route(
    "Critical Thinking → Fetch → Deep Thinking → Review 检查平台 key adapter 注册 能力账本 第二批平台路由 上传证据",
    "codex",
    "windows",
  );
  assert.ok(
    codexWhitespaceFanout.workerTaskPacketDrafts.length >= 2,
    "Structured fan-out must split whitespace-separated capability anchors instead of collapsing to one worker",
  );
  for (const packet of codexWhitespaceFanout.workerTaskPacketDrafts) {
    assert.equal(packet.ownerKind, "agent");
    assertNativeCodexSpawn(packet.codexSpawnBinding, packet.ownerAgent, packet);
  }

  const hook = route("platform hook install");
  assert.ok(hook.candidateWeapons.includes("runtime-capability-matrix"));

  const windows = route("windows setup task", "codex", "windows");
  assert.equal(windows.osFilterResult.applied, "windows");

  const cursor = route("cursor unknown capability task", "cursor", "windows");
  assert.ok(cursor.recommendedRoute || cursor.capabilityGapPacket);

  const missing = route("missing dependency task");
  assert.ok(missing.recommendedRoute || missing.capabilityGapPacket);
  assert.ok(
    ["classified_route_can_be_scored", "blocked_with_reason", "capabilityGapPacket"].includes(
      missing.routeExecutionGate?.typeFirstDisposition,
    ),
    "missing providers must classify or degrade instead of guessing an executable route",
  );
  assert.equal(
    missing.routeTypeClassification?.gapDecisionRef,
    "capabilityGapDecision",
    "capability-gap routing must link type classification to the blocking decision",
  );
});
