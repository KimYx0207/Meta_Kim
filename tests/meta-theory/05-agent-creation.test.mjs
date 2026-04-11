import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile as readFileRaw } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SKILL_PATH,
  REFERENCE_DIR,
  QUALITY_GRADES,
  EMPTY_ADJECTIVES,
  DELIVERY_SHELL_DIMENSIONS,
  TEN_CARD_TYPES,
  readFile,
} from "./_helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_PATH = path.join(
  __dirname,
  "scenarios",
  "creation-scenarios.json"
);

let skillContent;
/** SKILL.md + create-agent.md — Part A phases live in the reference, not only the skill stub. */
let pipelineCorpus;
let scenarios;

async function loadFixtures() {
  if (!skillContent) {
    skillContent = await readFile("canonical/skills/meta-theory/SKILL.md");
    const createAgent = await readFile(
      "canonical/skills/meta-theory/references/create-agent.md"
    );
    pipelineCorpus = `${skillContent}\n${createAgent}`;
  }
  if (!scenarios) {
    const raw = await readFileRaw(SCENARIOS_PATH, "utf-8");
    scenarios = JSON.parse(raw);
  }
}

describe("05 — Type B Agent Creation Pipeline", async () => {
  await loadFixtures();

  describe("Part A: Pipeline Structure (SKILL + create-agent reference)", () => {
    test("A-01: Two entry modes documented (Mode A Discovery / Mode B Direct)", () => {
      assert.match(pipelineCorpus, /Mode A.*Discovery/i);
      assert.match(pipelineCorpus, /Mode B.*Direct/i);
      assert.match(
        pipelineCorpus,
        /Two Entry Modes/i,
        "Missing 'Two Entry Modes' heading"
      );
    });

    test("A-02: Phase 1 — Discovery and Splitting exists", () => {
      assert.match(pipelineCorpus, /Phase 1.*Discovery and Splitting/is);
      assert.match(
        pipelineCorpus,
        /Step 0.*Data Collection/i,
        "Phase 1 should include Step 0 Data Collection"
      );
      assert.match(
        pipelineCorpus,
        /Capability Dimension Enumeration/i,
        "Phase 1 should include capability dimension enumeration"
      );
      assert.match(
        pipelineCorpus,
        /Coupling Grouping/i,
        "Phase 1 should include coupling grouping"
      );
    });

    test("A-03: Phase 2 — Pre-Design Decision (Global vs Project-Specific) exists", () => {
      assert.match(
        pipelineCorpus,
        /Phase 2.*Pre-Design Decision/is,
        "Missing Phase 2 heading"
      );
      assert.match(
        pipelineCorpus,
        /Global vs Project-Specific/i,
        "Phase 2 should mention Global vs Project-Specific"
      );
    });

    test("A-04: Phase 3 — Design On Demand exists", () => {
      assert.match(
        pipelineCorpus,
        /Phase 3.*Design On Demand/is,
        "Missing Phase 3 heading"
      );
    });

    test("A-05: Phase 4 — Review and Revision exists", () => {
      assert.match(
        pipelineCorpus,
        /Phase 4.*Review and Revision/is,
        "Missing Phase 4 heading"
      );
    });

    test("A-06: Phase 5 — Integration and Verification exists", () => {
      assert.match(
        pipelineCorpus,
        /Phase 5.*Integration and Verification/is,
        "Missing Phase 5 heading"
      );
    });

    test("A-07: 3 Hard Criteria for project-specific decision (Domain Gap, Project Uniqueness, Frequency)", () => {
      assert.match(
        pipelineCorpus,
        /3 Hard Criteria/i,
        "Missing '3 Hard Criteria' section"
      );
      assert.match(
        pipelineCorpus,
        /Domain Gap/i,
        "Missing 'Domain Gap' criterion"
      );
      assert.match(
        pipelineCorpus,
        /Project Uniqueness/i,
        "Missing 'Project Uniqueness' criterion"
      );
      assert.match(
        pipelineCorpus,
        /Frequency/i,
        "Missing 'Frequency' criterion"
      );
    });

    test("A-08: Genesis marked as Mandatory", () => {
      assert.match(
        pipelineCorpus,
        /Genesis.*Mandatory/i,
        "Genesis should be marked as Mandatory"
      );
    });

    test("A-09: Artisan marked as Mandatory", () => {
      assert.match(
        pipelineCorpus,
        /Artisan.*Mandatory/i,
        "Artisan should be marked as Mandatory"
      );
    });

    test("A-10: Sentinel/Librarian/Conductor marked as On Demand with trigger questions", () => {
      const onDemandStations = ["Scout", "Sentinel", "Librarian", "Conductor"];
      for (const station of onDemandStations) {
        assert.match(
          pipelineCorpus,
          new RegExp(`${station}.*On Demand`, "i"),
          `${station} should be marked as On Demand`
        );
      }

      assert.match(
        pipelineCorpus,
        /local capability.*missing|external capability.*missing|search externally/is,
        "Missing Scout trigger question"
      );
      assert.match(
        pipelineCorpus,
        /Will it modify files.*call external APIs.*operate databases/is,
        "Missing Sentinel trigger question"
      );
      assert.match(
        pipelineCorpus,
        /need to remember what it did last time/i,
        "Missing Librarian trigger question"
      );
      assert.match(
        pipelineCorpus,
        /hand off results to other Agents.*coordinate execution order/is,
        "Missing Conductor trigger question"
      );
    });

    test("A-10b: Plain-language execution chain is documented", () => {
      assert.match(
        pipelineCorpus,
        /Warden.*front door|public front door/i,
        "Pipeline must describe Warden as the front door"
      );
      assert.match(
        pipelineCorpus,
        /Conductor.*orchestrat/i,
        "Pipeline must describe Conductor as orchestration-only"
      );
      assert.match(
        pipelineCorpus,
        /Execution Agents?.*do the actual work|actual workers/i,
        "Pipeline must state that execution agents do the actual work"
      );
    });

    test("A-11: Station Deliverable Contract table covers all participating agents", () => {
      assert.match(
        pipelineCorpus,
        /Station Deliverable Contract/i,
        "Missing Station Deliverable Contract section"
      );

      const expectedStations = [
        "Warden",
        "Genesis",
        "Artisan",
        "Sentinel",
        "Librarian",
        "Conductor",
        "Prism",
        "Scout",
      ];
      for (const station of expectedStations) {
        assert.match(
          pipelineCorpus,
          new RegExp(`\\|\\s*${station}[^|]*\\|`, "i"),
          `Station Deliverable Contract should include ${station}`
        );
      }
    });

    test("A-12: Quality grading scale S/A/B/C/D documented", () => {
      for (const grade of QUALITY_GRADES) {
        assert.match(
          pipelineCorpus,
          new RegExp(`\\b${grade}\\b`),
          `Quality grade '${grade}' should be documented`
        );
      }

      assert.match(
        pipelineCorpus,
        /S\/A.*Pass/i,
        "S/A should map to Pass"
      );
      assert.match(
        pipelineCorpus,
        /D.*redo/i,
        "D grade should trigger redo"
      );
    });

    test("A-13: Base-meta factory is explicit and excludes Conductor from capability building", () => {
      assert.match(
        pipelineCorpus,
        /Base[- ]Meta Factory|Execution-Agent Factory/i,
        "Missing explicit factory section"
      );
      for (const station of [
        "Genesis",
        "Artisan",
        "Scout",
        "Sentinel",
        "Librarian",
      ]) {
        assert.match(
          pipelineCorpus,
          new RegExp(station, "i"),
          `Factory section must include ${station}`
        );
      }
      assert.match(
        pipelineCorpus,
        /Conductor.*does not build capability|Conductor.*not part of the factory/i,
        "Factory section must state that Conductor is not the capability-building station"
      );
    });

    test("A-14: Execution agent role card requires the 5 fixed fields", () => {
      assert.match(
        pipelineCorpus,
        /Execution Agent Role Card/i,
        "Missing execution agent role card section"
      );
      for (const field of [
        /what it is for|purpose/i,
        /can do|capabilities/i,
        /cannot do|non-capabilities|boundaries/i,
        /dependencies/i,
        /inputs/i,
        /outputs/i,
      ]) {
        assert.match(
          pipelineCorpus,
          field,
          `Role card must include ${field}`
        );
      }
    });

    test("A-15: Four fixed artifacts are documented", () => {
      for (const artifact of [
        /Capability Gap Sheet|capabilityGapPacket/i,
        /Execution Agent Role Card|executionAgentCard/i,
        /Orchestration Task Board|orchestrationTaskBoardPacket/i,
        /Evolution Record|evolutionWritebackPacket/i,
      ]) {
        assert.match(
          pipelineCorpus,
          artifact,
          `Missing fixed artifact reference: ${artifact}`
        );
      }
    });
  });

  describe("Part B: Creation Scenarios (from creation-scenarios.json)", () => {
    test("B-00: Scenario file loads and contains 14 scenarios", () => {
      assert.ok(Array.isArray(scenarios), "Scenarios must be an array");
      assert.equal(scenarios.length, 14, "Expected exactly 14 scenarios");
    });

    test("B-01 (AC-01): Mode A full flow — complete 5-phase walkthrough", () => {
      const s = scenarios.find((sc) => sc.id === "AC-01");
      assert.ok(s, "AC-01 scenario missing");
      assert.equal(s.expectedMode, "A");

      const phases = s.expectedPhases;
      assert.ok(phases.phase1.required, "Phase 1 must be required for Mode A");
      assert.ok(phases.phase2.required, "Phase 2 must be required");
      assert.ok(phases.phase3.required, "Phase 3 must be required");
      assert.ok(phases.phase4.required, "Phase 4 must be required");
      assert.ok(phases.phase5.required, "Phase 5 must be required");

      assert.ok(
        s.expectedAgentCalls.includes("meta-genesis"),
        "Must dispatch to meta-genesis"
      );
      assert.ok(
        s.expectedAgentCalls.includes("meta-artisan"),
        "Must dispatch to meta-artisan"
      );
      assert.ok(
        s.expectedAgentCalls.includes("meta-prism"),
        "Must dispatch to meta-prism"
      );
      assert.ok(
        s.expectedAgentCalls.includes("meta-warden"),
        "Must dispatch to meta-warden"
      );

      const fullFlow = s.expectedFullFlow;
      assert.ok(fullFlow, "AC-01 must include expectedFullFlow");
      assert.ok(fullFlow.phase1_discovery, "Missing phase1_discovery in full flow");
      assert.ok(fullFlow.phase2_preDesign, "Missing phase2_preDesign in full flow");
      assert.ok(fullFlow.phase3_design, "Missing phase3_design in full flow");
      assert.ok(fullFlow.phase4_review, "Missing phase4_review in full flow");
      assert.ok(fullFlow.phase5_integration, "Missing phase5_integration in full flow");

      assert.ok(
        fullFlow.phase3_design.genesis.eightModules.length === 8,
        "Genesis must require 8 modules"
      );
      assert.ok(
        fullFlow.phase3_design.genesis.deliverables.length === 4,
        "Genesis must have 4 deliverables"
      );
      assert.ok(
        fullFlow.phase3_design.artisan.deliverables.length === 5,
        "Artisan must have 5 deliverables"
      );
    });

    test("B-02 (AC-02): Mode B direct mode — skip Phase 1", () => {
      const s = scenarios.find((sc) => sc.id === "AC-02");
      assert.ok(s, "AC-02 scenario missing");
      assert.equal(s.expectedMode, "B");
      assert.equal(
        s.expectedPhases.phase1.required,
        false,
        "Phase 1 must be skipped in Mode B"
      );
      assert.ok(
        s.expectedPhases.phase2.required,
        "Phase 2 must still run in Mode B"
      );
    });

    test("B-03 (AC-03): Global agent already covers — Phase 2 intercept", () => {
      const s = scenarios.find((sc) => sc.id === "AC-03");
      assert.ok(s, "AC-03 scenario missing");
      assert.match(
        s.expectedPhases.phase2.expectedOutcome,
        /intercept/i,
        "Phase 2 should intercept when global agent covers capability"
      );
      assert.equal(
        s.expectedPhases.phase2.threeCriteriaResult.domainGap,
        false,
        "Domain Gap should be false when global agent exists"
      );
      assert.equal(
        s.expectedPhases.phase3.required,
        false,
        "Phase 3 should not be required when intercepted"
      );
      assert.deepEqual(
        s.expectedAgentCalls,
        [],
        "No agent dispatches when pipeline terminates at Phase 2"
      );
    });

    test("B-04 (AC-04): SOUL.md abstraction violation — grade D redo", () => {
      const s = scenarios.find((sc) => sc.id === "AC-04");
      assert.ok(s, "AC-04 scenario missing");
      assert.equal(
        s.expectedPhases.phase4.expectedGrade,
        "D",
        "Abstraction violation must get grade D"
      );
      assert.match(
        s.expectedPhases.phase4.reason,
        /specific tasks/i,
        "Reason must mention describing specific tasks"
      );
    });

    test("B-05 (AC-05): On-demand station trigger — Sentinel", () => {
      const s = scenarios.find((sc) => sc.id === "AC-05");
      assert.ok(s, "AC-05 scenario missing");
      assert.ok(
        s.expectedPhases.phase3.onDemandTrigger.sentinel.triggered,
        "Sentinel should be triggered for API/DB access"
      );
      assert.ok(
        s.expectedAgentCalls.includes("meta-sentinel"),
        "meta-sentinel must be in agent calls"
      );
    });

    test("B-06 (AC-06): On-demand station trigger — Librarian", () => {
      const s = scenarios.find((sc) => sc.id === "AC-06");
      assert.ok(s, "AC-06 scenario missing");
      assert.ok(
        s.expectedPhases.phase3.onDemandTrigger.librarian.triggered,
        "Librarian should be triggered for cross-session memory"
      );
      assert.ok(
        s.expectedAgentCalls.includes("meta-librarian"),
        "meta-librarian must be in agent calls"
      );
    });

    test("B-07 (AC-07): On-demand station trigger — Conductor", () => {
      const s = scenarios.find((sc) => sc.id === "AC-07");
      assert.ok(s, "AC-07 scenario missing");
      assert.ok(
        s.expectedPhases.phase3.onDemandTrigger.conductor.triggered,
        "Conductor should be triggered for multi-agent coordination"
      );
      assert.ok(
        s.expectedAgentCalls.includes("meta-conductor"),
        "meta-conductor must be in agent calls"
      );
    });

    test("B-08 (AC-08): AI-Slop density >3% triggers automatic grade D", () => {
      const s = scenarios.find((sc) => sc.id === "AC-08");
      assert.ok(s, "AC-08 scenario missing");
      assert.equal(
        s.expectedPhases.phase4.slopDetection.automaticGrade,
        "D",
        "Slop density >3% must trigger automatic grade D"
      );
      assert.match(
        s.expectedPhases.phase4.slopDetection.density,
        />3%/,
        "Density threshold must be >3%"
      );
    });

    test("B-09 (AC-09): Replaceability test — name swap still holds means grade D", () => {
      const s = scenarios.find((sc) => sc.id === "AC-09");
      assert.ok(s, "AC-09 scenario missing");
      assert.equal(
        s.expectedPhases.phase4.replaceabilityTest.grade,
        "D",
        "Name-swap passing = no domain depth = grade D"
      );
      assert.match(
        s.expectedPhases.phase4.replaceabilityTest.reason,
        /Domain Depth/i,
        "Must cite lack of domain depth"
      );
    });

    test("B-10 (AC-10): Empty Adjectives detection", () => {
      const s = scenarios.find((sc) => sc.id === "AC-10");
      assert.ok(s, "AC-10 scenario missing");

      const detected = s.expectedPhases.phase4.emptyAdjectivesDetected;
      assert.ok(
        Array.isArray(detected) && detected.length > 0,
        "Must detect empty adjectives"
      );

      for (const adj of detected) {
        assert.ok(
          EMPTY_ADJECTIVES.includes(adj),
          `Detected adjective '${adj}' must be in canonical EMPTY_ADJECTIVES list`
        );
      }
    });

    test("B-11 (AC-11): Max 2 revision rounds then user decides", () => {
      const s = scenarios.find((sc) => sc.id === "AC-11");
      assert.ok(s, "AC-11 scenario missing");

      const rounds = s.expectedPhases.phase4.revisionRounds;
      assert.ok(rounds.round1, "Must document round 1 result");
      assert.ok(rounds.round2, "Must document round 2 result");
      assert.match(
        rounds.action,
        /hand to user/i,
        "After 2 rounds must hand to user"
      );
      assert.match(
        rounds.action,
        /max 2 rounds/i,
        "Must reference max 2 rounds limit"
      );
    });

    test("B-12 (AC-12): Station Deliverable completeness check", () => {
      const s = scenarios.find((sc) => sc.id === "AC-12");
      assert.ok(s, "AC-12 scenario missing");

      const deliverables = s.expectedPhases.phase3.stationDeliverables;
      const expectedStations = [
        "warden",
        "genesis",
        "artisan",
        "sentinel",
        "librarian",
        "conductor",
        "prism",
        "scout",
      ];

      for (const station of expectedStations) {
        assert.ok(
          deliverables[station],
          `Missing deliverables for station: ${station}`
        );
        assert.ok(
          Array.isArray(deliverables[station]) &&
            deliverables[station].length > 0,
          `${station} must have at least one deliverable`
        );
      }

      assert.deepEqual(deliverables.genesis, [
        "SOUL.md Draft",
        "Boundary Definition",
        "Reasoning Rules",
        "Stress-Test Record",
      ]);
      assert.deepEqual(deliverables.artisan, [
        "Skill Loadout",
        "MCP / Tool Loadout",
        "Fallback Plan",
        "Capability Gap List",
        "Adoption Notes",
      ]);
    });

    test("B-13 (AC-13): User veto on splitting proposal (Iron Rule)", () => {
      const s = scenarios.find((sc) => sc.id === "AC-13");
      assert.ok(s, "AC-13 scenario missing");

      const veto = s.expectedPhases.phase1.userVeto;
      assert.match(
        veto.dataShows,
        /high coupling/i,
        "Data must show high coupling"
      );
      assert.match(
        veto.ironRule,
        /user override is final/i,
        "Iron Rule must state user override is final"
      );
    });

    test("B-14 (AC-14): Final verification — Five Criteria 5/5 + no Death Patterns + 8 modules complete", () => {
      const s = scenarios.find((sc) => sc.id === "AC-14");
      assert.ok(s, "AC-14 scenario missing");

      const checklist = s.expectedPhases.phase5.finalChecklist;
      assert.ok(checklist.fiveCriteria, "Must check Five Criteria");
      assert.match(
        checklist.fiveCriteria.required,
        /5\/5 PASS/,
        "Five Criteria must require 5/5 PASS"
      );

      assert.ok(checklist.deathPatterns, "Must check death patterns");
      assert.match(
        checklist.deathPatterns.required,
        /no Stew-All/i,
        "Must check for Stew-All"
      );
      assert.match(
        checklist.deathPatterns.required,
        /no Shattered/i,
        "Must check for Shattered"
      );

      assert.ok(checklist.eightModules, "Must check 8 modules");
      assert.match(
        checklist.eightModules.required,
        /all 8 complete/i,
        "Must require all 8 modules complete"
      );

      assert.ok(
        checklist.skipJustification,
        "Must check skip justification"
      );
    });
  });
});
