#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTaskGoalContract, evaluateTaskOutcome, taskOutcomeDigest } from "../src/domain/governance/task-outcome.mjs";
import { buildCapabilityGapOrchestration } from "./run-capability-gap-orchestration.mjs";
import { intentDialogueDigest } from "./governed-execution/intent-dialogue.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

export function evaluateGovernedArtifact(artifact, observations = []) {
  const core = artifact?.coreLoop ?? artifact;
  const task = core?.requestRecord?.task;
  const goal = core?.goalContractPacket;
  const taskHash = taskOutcomeDigest(task);
  const dialogue = core?.intentPacket?.intentBinding;
  const confirmedOutcome = dialogue?.status === "host_provided_understanding" ? dialogue.outcome : task.trim();
  if (goal?.taskHash !== taskHash || core?.intentPacket?.realIntent !== confirmedOutcome) {
    throw new TypeError("Artifact request, Critical intent and outcome contract must refer to the same task");
  }
  if (dialogue?.status === "host_provided_understanding") {
    const digest = intentDialogueDigest({
      taskHash: dialogue.taskHash, outcome: dialogue.outcome, constraints: dialogue.constraints,
      acceptanceCriteria: dialogue.acceptanceCriteria, settledDecisions: dialogue.settledDecisionRefs,
      evidenceRefs: dialogue.evidenceRefs,
    });
    if (dialogue.taskHash !== taskHash || goal.confirmedOutcome !== confirmedOutcome ||
        dialogue.intentDigest !== digest || goal.intentBinding?.intentDigest !== digest) {
      throw new TypeError("Confirmed understanding must preserve its original task and exact intent binding");
    }
    const normalize = (criteria) => criteria.map((criterion) => ({
      id: criterion.id, description: criterion.description.trim(), kind: criterion.kind,
      required: criterion.required !== false,
    }));
    if (dialogue.acceptanceCriteria?.length &&
        JSON.stringify(normalize(dialogue.acceptanceCriteria)) !== JSON.stringify(goal.acceptanceCriteria)) {
      throw new TypeError("Confirmed acceptance criteria must match the outcome contract");
    }
  }
  return evaluateTaskOutcome(goal, observations);
}

export function evaluateGovernanceFixtures(fixtures) {
  const ids = new Set();
  if (!Array.isArray(fixtures?.cases) || !fixtures.cases.length) throw new TypeError("A non-empty fixture suite is required");
  const cases = fixtures.cases.map((entry) => {
    if (!entry.id || ids.has(entry.id)) throw new TypeError("Fixture ids must be unique");
    ids.add(entry.id);
    try {
      const goal = buildTaskGoalContract({ task: entry.task, acceptanceCriteria: entry.criteria ?? [] });
      const route = buildCapabilityGapOrchestration(entry.task);
      assert.equal(route.criticalSummary.realGoal, entry.task.trim(), "Critical changed the user goal");
      assert.equal(route.rootGoal, entry.task.trim(), "The root goal was replaced by framework acceptance");
      const observations = (entry.observations ?? []).map((observation) => ({
        ...observation,
        taskHash: observation.taskBinding === "other" ? taskOutcomeDigest("A different user task") : goal.taskHash,
        acceptanceDigest: goal.acceptanceDigest,
      }));
      const evaluation = evaluateGovernedArtifact({
        requestRecord: { task: entry.task },
        intentPacket: { realIntent: route.criticalSummary.realGoal },
        goalContractPacket: goal,
      }, observations);
      assert.equal(evaluation.status, entry.expectedStatus);
      assert.equal(evaluation.executionVerified, false);
      assert.equal(evaluation.nativeInvocationVerified, false);
      assert.equal(evaluation.publicReady, false);
      return { id: entry.id, domain: entry.domain, bucket: entry.bucket, status: "pass", outcomeStatus: evaluation.status };
    } catch (error) {
      return { id: entry.id, domain: entry.domain, bucket: entry.bucket, status: "fail", reason: error.message };
    }
  });
  return {
    schemaVersion: "governance-outcome-fixture-report-v0.1",
    status: cases.every((entry) => entry.status === "pass") ? "pass" : "fail",
    evidenceKind: "offline_functional_regression",
    cases, passed: cases.filter((entry) => entry.status === "pass").length, total: cases.length,
    liveModelCalls: 0, liveQualityImprovementProven: false,
    claimBoundary: "These synthetic observations test intent binding and evaluator behavior, not the quality of any live model or role.",
  };
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!["--artifact", "--observations", "--json-out"].includes(key) || !args[index + 1] || args[index + 1].startsWith("--") || options[key]) {
      throw new TypeError("Use --artifact <run.json> [--observations <observations.json>] [--json-out <new-report.json>], or no arguments for offline regression");
    }
    options[key] = args[index + 1];
  }
  if (options["--observations"] && !options["--artifact"]) throw new TypeError("Observations require a bound run artifact");
  const readJson = async (filename) => JSON.parse((await readFile(filename, "utf8")).replace(/^\uFEFF/u, ""));
  const report = options["--artifact"]
    ? evaluateGovernedArtifact(await readJson(options["--artifact"]), options["--observations"] ? await readJson(options["--observations"]) : [])
    : evaluateGovernanceFixtures(await readJson(path.join(repoRoot, "config/evals/governance-outcomes.json")));
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options["--json-out"]) {
    const output = path.resolve(options["--json-out"]);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, json, { flag: "wx" });
  }
  process.stdout.write(json);
  if (report.status !== "pass") process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
