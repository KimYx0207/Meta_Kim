import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { buildGlobalCapabilityInventory } from "../../scripts/discover-global-capabilities.mjs";
import {
  APPROX_BYTES_PER_TOKEN,
  DEFAULT_SKILL_METADATA_CHAR_BUDGET,
  computeSkillMetadataPreflight,
  replayCodexJsonl,
} from "../../scripts/codex-capability-diagnostics.mjs";

const fixtureRoot = path.resolve("tests", "fixtures", "codex-capability-diagnostics");

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

describe("Codex capability diagnostics", () => {
  test("invalid capabilities publish diagnosis-only ownership and manifest repair boundaries", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-ownership-"));
    const agentPath = path.join(tempRoot, "agents", "invalid.toml");
    const forgedAgentPath = path.join(tempRoot, "agents", "forged.toml");
    const skillPath = path.join(tempRoot, "skills", "invalid", "SKILL.md");
    await fs.mkdir(path.dirname(agentPath), { recursive: true });
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.writeFile(agentPath, 'name = "invalid"\n', "utf8");
    await fs.writeFile(forgedAgentPath, 'name = "forged"\n', "utf8");
    await fs.writeFile(skillPath, "# no frontmatter\n", "utf8");
    try {
      const inventory = await buildGlobalCapabilityInventory(
        [{
          platform: "Codex",
          platformId: "codex",
          capabilities: {
            agents: [{
              id: "invalid",
              platformId: "codex",
              path: agentPath,
              validCustomAgentDefinition: false,
              customAgentDefinitionErrors: ["missing_description"],
            }, {
              id: "forged",
              platformId: "codex",
              path: forgedAgentPath,
              validCustomAgentDefinition: false,
              customAgentDefinitionErrors: ["missing_description"],
            }],
            skills: [{
              id: "invalid-skill",
              platformId: "codex",
              path: skillPath,
              validSkillDefinition: false,
              skillDefinitionErrors: ["missing_name", "missing_description"],
            }],
            hooks: [], plugins: [], commands: [], rules: [], prompts: [], mcpServers: [], mcpTools: [],
          },
          errors: [],
        }],
        "ownership-test",
        null,
        {
          ownershipIndex: new Map([[pathKey(agentPath), {
            owner: "meta_kim",
            ownershipClass: "install_projection",
            manifestRef: "~/.meta-kim/install-manifest.json",
            manifestDigest: "a".repeat(64),
            validatedInstallManifest: true,
          }], [pathKey(forgedAgentPath), {
            owner: "meta_kim",
            ownershipClass: "install_projection",
            manifestRef: "forged-install-manifest.json",
            manifestDigest: "b".repeat(64),
            validatedInstallManifest: false,
          }]]),
        },
      );
      const agent = inventory.byCapabilityType.agents["codex:invalid"];
      const forgedAgent = inventory.byCapabilityType.agents["codex:forged"];
      const skill = inventory.byCapabilityType.skills["codex:invalid-skill"];
      assert.equal(agent.owner, "meta_kim");
      assert.equal(agent.ownershipClass, "install_projection");
      assert.equal(agent.repairRoute, "meta_kim_manifest_owned_repair");
      assert.equal(agent.automaticMutationAllowed, false);
      assert.equal(forgedAgent.owner, "meta_kim");
      assert.equal(forgedAgent.repairRoute, "diagnose_only_owner_managed_repair");
      assert.equal(forgedAgent.automaticMutationAllowed, false);
      assert.equal(skill.owner, "user");
      assert.equal(skill.repairRoute, "diagnose_only_owner_managed_repair");
      assert.equal(skill.automaticMutationAllowed, false);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("skill metadata preflight uses 2 percent tokens or the 8000 character fallback", () => {
    const skill = (id, sourceClass, description, collision = null) => ({
      id,
      platformId: "codex",
      sourceClass,
      metadata: { description },
      collision,
    });
    const inventory = {
      byPlatform: {
        codex: {
          platformId: "codex",
          capabilities: {
            skills: [
              skill("project-skill", "project", "a".repeat(120)),
              skill("shared-skill", "shared", "四".repeat(20)),
              skill("plugin-skill", "plugin", "plugin description"),
            ],
          },
        },
      },
      byCapabilityType: {
        skills: {
          "codex:project-skill": skill("project-skill", "project", "a".repeat(120)),
          "codex:shared-skill": skill("shared-skill", "shared", "四".repeat(20), { kind: "exact_duplicate" }),
          "codex:plugin-skill": skill("plugin-skill", "plugin", "plugin description"),
        },
      },
    };
    const knownWindow = computeSkillMetadataPreflight(inventory, { contextWindow: 10_000 });
    assert.deepEqual(knownWindow.budget, {
      unit: "tokens",
      value: 200,
      source: "context_window_percent",
    });
    assert.equal(knownWindow.projected.fidelity, "projected_estimate");
    assert.equal(knownWindow.projected.assessedView, "raw_host_visible_candidate_set");
    assert.equal(knownWindow.projected.shadowedSourceCount, 0);
    assert.equal(
      knownWindow.projected.logicalWinnerEstimatedTokens,
      knownWindow.projected.estimatedTokens,
    );
    assert.equal(knownWindow.projected.bySourceClass.plugin.raw, 1);
    assert.equal(knownWindow.projected.bySourceClass.shared.exactDuplicate, 1);
    assert.equal(knownWindow.conclusion.hostObservationRequired, true);
    assert.notEqual(knownWindow.conclusion.status, "pass");
    assert.equal(APPROX_BYTES_PER_TOKEN, 4);

    const fallback = computeSkillMetadataPreflight(inventory);
    assert.equal(fallback.budget.unit, "characters");
    assert.equal(fallback.budget.value, DEFAULT_SKILL_METADATA_CHAR_BUDGET);
    assert.equal(fallback.conclusion.reason, "host_observation_required");

    const reportedArtifact = computeSkillMetadataPreflight(inventory, {
      contextWindow: 10_000,
      hostArtifacts: [{ total: 3, included: 3, omitted: 0, truncated_description_chars: 0 }],
    });
    assert.equal(reportedArtifact.reportedHostArtifacts[0].evidenceClass, "reported_host_artifact");
    assert.equal(reportedArtifact.reportedHostArtifacts[0].verificationStatus, "unverified");
    assert.equal(reportedArtifact.hostObserved.length, 0);
    assert.equal(reportedArtifact.conclusion.status, "partial");
    assert.equal(
      reportedArtifact.conclusion.reason,
      "host_observation_verification_required",
    );

    const reportedTruncation = computeSkillMetadataPreflight(inventory, {
      contextWindow: 10_000,
      hostArtifacts: [{
        total: 3,
        included: 3,
        omitted: 0,
        truncated_description_chars: 1,
        truncated_description_count: 1,
      }],
    });
    assert.equal(reportedTruncation.conclusion.status, "risk");
  });

  test("JSONL replay keeps lag, budget, malformed, and fatal conclusions independent", async () => {
    const replay = await replayCodexJsonl([
      path.join(fixtureRoot, "success-with-lag.jsonl"),
      path.join(fixtureRoot, "fatal-failure.jsonl"),
      path.join(fixtureRoot, "skill-budget-warning.jsonl"),
      path.join(fixtureRoot, "historical-skill-warning.jsonl"),
      path.join(fixtureRoot, "lag-without-exit-receipt.jsonl"),
      path.join(fixtureRoot, "completed-with-diagnostic-items.jsonl"),
      path.join(fixtureRoot, "completed-with-failed-exit.jsonl"),
      path.join(fixtureRoot, "malformed.jsonl"),
    ]);
    const byName = new Map(replay.reports.map((report) => [report.sourceRef, report]));
    const lag = byName.get("success-with-lag.jsonl");
    assert.match(lag.sourceDigest, /^[a-f0-9]{64}$/u);
    assert.equal(lag.eventStream.droppedEventCount, 3);
    assert.equal(lag.eventStream.lagDisposition, "nonfatal_warning_when_turn_completed");
    assert.deepEqual(lag.tokens, {
      aggregation: "max_observed_high_water_not_session_sum",
      input: 1200,
      cachedInput: 400,
      output: 80,
    });
    assert.equal(lag.conclusion.status, "observed_turn_and_exit_markers_unbound");
    assert.deepEqual(lag.sourceBinding, {
      scope: "whole_file",
      runTurnBound: false,
      evidenceClass: "observed_markers_only",
    });
    assert.deepEqual(lag.turn.exitReceipt, { observed: true, success: true });
    assert.equal(lag.conclusion.diagnosticOnly, true);
    assert.equal(lag.conclusion.publicReady, false);

    const fatal = byName.get("fatal-failure.jsonl");
    assert.equal(fatal.turn.failed, true);
    assert.equal(fatal.conclusion.status, "observed_fatal_or_invalid_markers");

    const budget = byName.get("skill-budget-warning.jsonl");
    assert.equal(budget.skillBudget.warningCount, 1);
    assert.equal(budget.skillBudget.omittedSkillCount, 3);
    assert.equal(budget.skillBudget.omittedCountEvidence, "numeric_field");
    assert.equal(budget.skillBudget.truncatedSkillCount, 2);
    assert.equal(budget.skillBudget.truncatedCountEvidence, "numeric_field");
    assert.equal(
      budget.conclusion.causalInference,
      "not_inferred_between_skill_budget_and_event_stream",
    );

    const nonSkillNumericFixture = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-non-skill-")),
      "non-skill.jsonl",
    );
    try {
      await fs.writeFile(
        nonSkillNumericFixture,
        `${JSON.stringify({ type: "business.result", omitted_count: 7, truncated_count: 4 })}\n`,
        "utf8",
      );
      const nonSkill = (await replayCodexJsonl([nonSkillNumericFixture])).reports[0];
      assert.equal(nonSkill.skillBudget.omittedSkillCount, null);
      assert.equal(nonSkill.skillBudget.truncatedSkillCount, null);
    } finally {
      await fs.rm(path.dirname(nonSkillNumericFixture), { recursive: true, force: true });
    }

    const historical = byName.get("historical-skill-warning.jsonl");
    assert.equal(historical.skillBudget.omittedSkillCount, 156);
    assert.equal(historical.skillBudget.omittedCountEvidence, "message_reported");
    assert.equal(historical.skillBudget.averageDescriptionCharsPerSkill, 42);
    assert.equal(historical.skillBudget.averageDescriptionCharsEvidence, "message_reported");
    assert.equal(historical.skillBudget.descriptionShorteningReported, true);
    assert.equal(historical.skillBudget.truncatedSkillCount, null);
    assert.equal(historical.skillBudget.truncatedCountEvidence, "unknown");

    const unresolvedLag = byName.get("lag-without-exit-receipt.jsonl");
    assert.equal(
      unresolvedLag.eventStream.lagDisposition,
      "unresolved_without_successful_exit_receipt",
    );
    assert.deepEqual(unresolvedLag.turn.exitReceipt, { observed: false, success: false });

    const diagnosticItems = byName.get("completed-with-diagnostic-items.jsonl");
    assert.equal(diagnosticItems.turn.completed, true);
    assert.equal(diagnosticItems.conclusion.fatalErrorCount, 0);
    assert.equal(
      diagnosticItems.conclusion.status,
      "observed_turn_completed_marker_without_exit_binding",
    );
    assert.deepEqual(diagnosticItems.runtimeDiagnostics, {
      itemErrorCount: 3,
      capabilityDefinitionWarningCount: 1,
      deprecationWarningCount: 1,
      otherItemErrorCount: 0,
      itemErrorsAreNotProcessFatalWithoutTurnFailure: true,
    });

    const failedExit = byName.get("completed-with-failed-exit.jsonl");
    assert.deepEqual(failedExit.turn.exitReceipt, { observed: true, success: false });
    assert.equal(failedExit.conclusion.processExitFailure, true);
    assert.equal(failedExit.conclusion.status, "observed_fatal_or_invalid_markers");

    const malformed = byName.get("malformed.jsonl");
    assert.equal(malformed.malformedLineCount, 1);
    assert.equal(malformed.conclusion.status, "observed_fatal_or_invalid_markers");
  });
});
