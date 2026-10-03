import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

async function readText(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

test("choice surface policy requires trigger proof rather than artifact-only completion", async () => {
  const policy = await readJson("config/governance/choice-surface-policy.json");
  assert.equal(policy.triggerProofPolicy?.nativeSurfaceAvailableMeansCallIt, true);
  assert.deepEqual(policy.triggerProofPolicy?.primaryRuntimesNoDowngrade, [
    "codex",
    "claude_code",
  ]);
  assert.equal(policy.triggerProofPolicy?.primaryRuntimeUnavailableAction, "block_before_execution");
  assert.equal(policy.triggerProofPolicy?.artifactOnlyIsNotTriggered, true);
  assert.ok(policy.triggerProofPolicy?.completionEvidence.includes("native_tool_answer"));
  assert.ok(policy.triggerProofPolicy?.completionEvidence.includes("deferred_native_tool_call"));
  assert.ok(!policy.triggerProofPolicy?.completionEvidence.includes("conversation_fallback_reason"));
  assert.ok(policy.triggerProofPolicy?.compatibilityOnlyEvidence.includes("conversation_fallback_reason"));
  assert.ok(policy.triggerProofPolicy?.artifactOnlySignals.includes("cardPlanPacket"));
  assert.ok(policy.triggerProofPolicy?.artifactOnlySignals.includes("conversationNotice"));
});

test("choice surface policy rejects false native choice claims without runtime evidence", async () => {
  const policy = await readJson("config/governance/choice-surface-policy.json");
  const contract = await readJson("config/contracts/workflow-contract.json");
  const falseClaim = policy.falseNativeChoiceClaimPolicy;
  const contractFalseClaim =
    contract.runDiscipline?.userInteractionPolicy?.falseNativeChoiceClaimPolicy;

  assert.equal(falseClaim?.enabled, true);
  assert.equal(falseClaim?.failureClass, "false_native_choice_claim");
  assert.ok(falseClaim?.appliesTo.includes("assistant_chat_text"));
  assert.ok(falseClaim?.claimPhrases.includes("choice panel did not return"));
  assert.ok(falseClaim?.claimPhrases.includes("选择面板没有返回"));
  assert.ok(
    falseClaim?.evidenceByRuntime?.codex?.acceptedEvidence.includes(
      "request_user_input_answer",
    ),
  );
  assert.ok(
    falseClaim?.evidenceByRuntime?.codex?.acceptedEvidence.includes(
      "nativeChoiceSurfaceBlocked",
    ),
  );
  assert.ok(
    falseClaim?.evidenceByRuntime?.codex?.forbiddenSubstitutes.includes(
      "cardPlanPacket",
    ),
  );
  assert.equal(falseClaim?.evidenceByRuntime?.codex?.fallbackAllowed, false);
  assert.ok(
    falseClaim?.evidenceByRuntime?.claude_code?.acceptedEvidence.includes(
      "AskUserQuestion_answer",
    ),
  );
  assert.ok(
    falseClaim?.evidenceByRuntime?.claude_code?.acceptedEvidence.includes(
      "deferred_AskUserQuestion_tool_call",
    ),
  );
  assert.equal(
    falseClaim?.evidenceByRuntime?.cursor?.mustLabelFallback,
    true,
  );
  assert.equal(
    falseClaim?.evidenceByRuntime?.openclaw?.mustLabelFallback,
    true,
  );
  assert.equal(
    falseClaim?.evidenceByRuntime?.structural_runner?.mustLabelPending,
    true,
  );
  assert.equal(
    falseClaim?.rule,
    contractFalseClaim?.rule,
  );
  assert.deepEqual(
    falseClaim?.evidenceByRuntime,
    contractFalseClaim?.evidenceByRuntime,
  );
});

test("runtime contract distinguishes native choice trigger from generated artifacts", async () => {
  const contract = await readJson("config/contracts/workflow-contract.json");
  const policy = contract.runDiscipline?.userInteractionPolicy?.triggerProofPolicy;
  assert.equal(policy?.nativeSurfaceAvailableMeansCallIt, true);
  assert.deepEqual(policy?.primaryRuntimesNoDowngrade, ["codex", "claude_code"]);
  assert.equal(policy?.primaryRuntimeUnavailableAction, "block_before_execution");
  assert.equal(policy?.artifactOnlyIsNotTriggered, true);

  const surfaces = contract.runDiscipline?.runtimeNativeChoiceSurfaces ?? {};
  assert.match(surfaces.codex?.implementation ?? "", /request_user_input/);
  assert.equal(surfaces.codex?.unavailableAction, "block_before_execution");
  assert.deepEqual(surfaces.codex?.fallbackSurfaces, []);
  assert.match(surfaces.codex?.implementation ?? "", /artifact-only|cardPlanPacket/i);
  assert.match(surfaces.claude?.implementation ?? "", /AskUserQuestion/);
  assert.equal(surfaces.claude?.unavailableAction, "block_before_execution");
  assert.deepEqual(surfaces.claude?.fallbackSurfaces, []);
  assert.match(surfaces.claude?.implementation ?? "", /deferred/i);
  assert.match(surfaces.claude?.implementation ?? "", /Do not narrate/);
  assert.match(surfaces.claude?.implementation ?? "", /AI understanding/);
  assert.match(surfaces.claude?.implementation ?? "", /Candidate paths/);
  assert.doesNotMatch(surfaces.claude?.implementation ?? "", /render a localized chat decision card/i);
  assert.doesNotMatch(surfaces.codex?.implementation ?? "", /render a localized chat decision card/i);
  assert.match(surfaces.codex?.implementation ?? "", /do not continue with conversation_fallback/i);
  assert.match(
    surfaces.codex?.triggerDescription ?? "",
    /active schema's maximum meaningful option count|active host schema/i,
  );
  assert.match(surfaces.codex?.implementation ?? "", /host-maximum set/i);
  assert.match(surfaces.codex?.implementation ?? "", /Do not narrate/);
});

test("Codex and Claude adapters require real native calls and block instead of downgrading", async () => {
  const codex = await readText("canonical/skills/meta-theory/references/runtime-codex.md");
  const claude = await readText("canonical/skills/meta-theory/references/runtime-claude.md");

  assert.match(codex, /must call `request_user_input`/);
  assert.match(codex, /record `nativeChoiceSurfaceBlocked` with the concrete reason, stop before Execution/);
  assert.match(codex, /Do not continue with a localized markdown decision card as acceptance evidence/);
  assert.match(codex, /cardPlanPacket[\s\S]*not evidence/i);
  assert.match(codex, /False native choice claim guard/);
  assert.match(codex, /do not invent an empty response/);
  assert.match(claude, /must call `AskUserQuestion`/);
  assert.match(claude, /deferred `AskUserQuestion` tool call/i);
  assert.match(claude, /Missing native proof blocks the run/);
  assert.match(claude, /False native choice claim guard/);
  assert.match(claude, /do not narrate an empty return/);
  assert.match(codex, /active runtime-native maximum meaningful option count/i);
  assert.match(codex, /observed host capacity, not a permanent Meta_Kim limit/i);
  assert.match(codex, /Native structured panel content/i);
  assert.match(codex, /AI understanding[\s\S]*AI additions[\s\S]*Capability route[\s\S]*Candidate paths/i);
  assert.match(codex, /expected result[\s\S]*advantage[\s\S]*disadvantage\/risk[\s\S]*verification impact/i);
  assert.match(claude, /Native structured panel content/i);
  assert.match(claude, /AI understanding[\s\S]*AI additions[\s\S]*Capability route[\s\S]*Candidate paths/i);
  assert.doesNotMatch(codex, /fall back once/i);
  assert.doesNotMatch(claude, /Fall back to `conversation_fallback`/i);
});

test("primary native choice panels preserve structure and runtime maximum option policy", async () => {
  const contract = await readJson("config/contracts/workflow-contract.json");
  const policy = await readJson("config/governance/choice-surface-policy.json");
  const panel = contract.runDiscipline?.userInteractionPolicy?.nativeStructuredPanelContract;
  assert.ok(panel, "workflow contract must define nativeStructuredPanelContract");
  assert.deepEqual(panel.requiredForPrimaryRuntimes, ["codex", "claude_code"]);
  assert.equal(panel.hostOwnsVisualSkin, true);
  assert.equal(panel.metaKimOwnsPayloadStructure, true);
  for (const section of [
    "AI understanding",
    "AI additions",
    "Capability route",
    "Candidate paths",
  ]) {
    assert.ok(panel.requiredPanelSections.includes(section), `missing section ${section}`);
  }
  for (const semantic of [
    "recommended default",
    "expected result",
    "advantages",
    "disadvantages or risk",
    "verification impact",
  ]) {
    assert.ok(panel.requiredOptionSemantics.includes(semantic), `missing semantic ${semantic}`);
  }
  assert.equal(panel.runtimeNativeOptionPolicy?.optionsMin, 2);
  assert.equal(
    panel.runtimeNativeOptionPolicy?.strategy,
    "use_active_host_schema_maximum_meaningful_options",
  );
  assert.equal(panel.runtimeNativeOptionPolicy?.noMetaKimLowerCap, true);
  assert.equal(
    panel.runtimeNativeOptionPolicy?.overActiveHostMaximumBehavior,
    "show_host_maximum_best_options_and_record_omitted_alternatives",
  );
  assert.equal(
    panel.runtimeNativeOptionPolicy?.currentObservedHostMaximums?.codex
      ?.notProductCap,
    true,
  );
  assert.equal(
    panel.runtimeNativeOptionPolicy?.currentObservedHostMaximums?.claude_code
      ?.notProductCap,
    true,
  );
  assert.ok(panel.forbidden.includes("meta_kim_lower_option_cap"));
  assert.ok(panel.forbidden.includes("fixed_codex_option_cap"));
  assert.ok(panel.forbidden.includes("oversized_native_payload_retry_unchanged"));
  assert.ok(!panel.forbidden.includes("four_option_codex_request_user_input_payload"));
  assert.deepEqual(
    policy.nativeStructuredPanelContract?.runtimeNativeOptionPolicy,
    panel.runtimeNativeOptionPolicy,
  );
});

test("generated card plans mark choice cards as adapter-required, not native-triggered", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "meta-kim-choice-surface-"));
  const runId = "choice-surface-trigger-test";
  try {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-meta-theory-governed-execution.mjs",
        "Build a governed feature and choose between two implementation scopes.",
        runId,
        "--state-dir",
        tempDir,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);

    const artifact = JSON.parse(await readFile(path.join(tempDir, `${runId}.json`), "utf8"));
    const choiceCards = artifact.cardPlanPacket.cardEvents.filter((card) =>
      ["clarify", "options"].includes(card.cardKey),
    );

    assert.ok(choiceCards.length >= 2);
    for (const card of choiceCards) {
      assert.equal(card.choiceSurfaceDelivery, "adapter_required_not_triggered_by_artifact");
      assert.match(card.choiceSurfaceTriggerProof, /not a native popup/i);
      assert.match(card.choiceSurfaceTriggerProof, /native tool call/i);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
