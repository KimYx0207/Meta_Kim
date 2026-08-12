import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  analyzeFitnessResults,
  assertStandaloneCodexHost,
  buildCodexTrialArgs,
  buildIsolatedCodexTrialEnv,
  buildTrialPlan,
  codexCommandSpecFromCandidates,
  codexHostContextObservation,
  evaluateBlindQuality,
  governanceInstructionsForGroup,
  parseCodexJsonl,
  runFitnessLab,
  validateFitnessLabDefinition,
} from "../../scripts/run-harness-fitness-lab.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const contract = JSON.parse(
  await readFile(path.join(repoRoot, "config/contracts/harness-fitness-lab-contract.json"), "utf8"),
);
const scenarios = JSON.parse(
  await readFile(
    path.join(repoRoot, "config/evals/harness-fitness-lab-tasks.json"),
    "utf8",
  ),
);

let tempRoot;
before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "meta-kim-fitness-test-"));
});
after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

test("61 — P-116 contract fixes the Codex-only 3x3x3 experiment and truth boundary", () => {
  const validation = validateFitnessLabDefinition(contract, scenarios);
  assert.deepEqual(validation, { ok: true, errors: [] });
  assert.equal(contract.primaryRuntime, "codex");
  assert.equal(contract.experiment.expectedLiveTrialCount, 27);
  assert.match(contract.experiment.codexBackend, /native Codex CLI/);
  assert.match(contract.experiment.codexBackend, /no Docker, WSL/);
  assert.equal(contract.experiment.codexPermissionProfile, ":workspace");
  assert.match(contract.experiment.codexApprovalReviewer, /auto_review/);
  assert.match(contract.experiment.codexWritableRootBinding, /external per-trial Git repository/);
  assert.match(contract.experiment.codexWritableRootBinding, /immutable starter commit/);
  assert.match(contract.experiment.codexWritableRootBinding, /no duplicate --add-dir/);
  assert.match(contract.experiment.controlledRuntimeLoadout, /every group/);
  assert.equal(contract.status, "accepted_with_negative_fitness_result");
  assert.match(contract.experiment.workspaceIsolation, /external OS-temp workspace/);
  assert.equal(contract.latestFormalResult.completedLiveTrials, 27);
  assert.equal(contract.latestFormalResult.labDeliveryAccepted, true);
  assert.equal(contract.latestFormalResult.governanceFitnessPassed, false);
  assert.equal(contract.latestFormalResult.improvedTaskClasses, 1);
  assert.match(contract.latestFormalResult.evidenceReportSha256, /^[a-f0-9]{64}$/);
  assert.match(contract.latestFormalResult.executedContractDigest, /^[a-f0-9]{64}$/);
  assert.match(contract.latestFormalResult.scenarioDigest, /^[a-f0-9]{64}$/);
  assert.equal(contract.latestFormalResult.reviewFinding, "ineffective");
  assert.match(contract.experiment.liveHostRequirement, /standalone PowerShell/);
  assert.equal(contract.truthBoundary.fixtureRunsCountAsProductEvidence, false);
  assert.equal(contract.truthBoundary.dockerRunsCountAsProductEvidence, false);
  assert.equal(contract.blindEvaluation.groupIdentityVisibleToEvaluator, false);
});

test("61 — native Codex trial argv holds the controlled loadout constant", () => {
  const workspace = path.join(tempRoot, "controlled-workspace");
  const args = buildCodexTrialArgs(workspace, "test-model");
  assert.deepEqual(args.slice(0, 4), ["exec", "--ignore-user-config", "--ignore-rules", "--strict-config"]);
  assert.ok(args.includes('default_permissions=":workspace"'));
  assert.ok(args.includes('approval_policy="on-request"'));
  assert.ok(args.includes('approvals_reviewer="auto_review"'));
  assert.ok(!args.includes("--sandbox"));
  assert.ok(!args.includes("--add-dir"));
  assert.equal(args.filter((arg) => arg === workspace).length, 1);
  for (const capability of [
    "hooks",
    "codex_hooks",
    "plugin_hooks",
    "plugins",
    "apps",
    "tool_search",
  ]) {
    const index = args.indexOf(capability);
    assert.ok(index > 0 && args[index - 1] === "--disable", `${capability} must be disabled`);
  }
  assert.ok(!args.includes("danger-full-access"));
  assert.deepEqual(args.slice(-3), ["--model", "test-model", "-"]);
});

test("61 — native Codex trials isolate user config and project trust history", () => {
  const isolatedHome = path.join(tempRoot, "isolated-codex-home");
  const env = buildIsolatedCodexTrialEnv(isolatedHome, {
    PATH: "test-path",
    CODEX_HOME: "C:/Users/test/.codex",
    HOME: "C:/Users/test",
    USERPROFILE: "C:/Users/test",
  });

  assert.equal(env.PATH, "test-path");
  assert.equal(env.CODEX_HOME, path.join(isolatedHome, ".codex"));
  assert.equal(env.HOME, isolatedHome);
  assert.equal(env.USERPROFILE, isolatedHome);
  assert.notEqual(env.CODEX_HOME, "C:/Users/test/.codex");
});

test("61 — managed Desktop sessions fail closed while standalone native hosts pass", () => {
  assert.throws(
    () =>
      assertStandaloneCodexHost({
        CODEX_THREAD_ID: "redacted",
        CODEX_PERMISSION_PROFILE: ":workspace",
      }),
    (error) => {
      assert.equal(error.code, "P116_NESTED_CODEX_HOST_BLOCKED");
      assert.deepEqual(error.managedHostMarkers, ["CODEX_THREAD_ID", "CODEX_PERMISSION_PROFILE"]);
      assert.match(error.message, /standalone native shell/);
      assert.match(error.message, /without nested Desktop policy/);
      assert.match(error.message, /Do not bypass/);
      return true;
    },
  );
  assert.deepEqual(assertStandaloneCodexHost({}), {
    ok: true,
    executionContext: "standalone_native_shell",
    managedHostMarkers: [],
  });
});

test("61 — trial planner emits three repetitions for every task and group", () => {
  const plan = buildTrialPlan(contract, scenarios, { trials: 3, seed: "test-seed" });
  assert.equal(plan.length, 27);
  for (const task of scenarios.tasks) {
    for (const group of contract.experiment.groups) {
      assert.equal(
        plan.filter((item) => item.taskId === task.id && item.groupId === group.id).length,
        3,
      );
    }
  }
  assert.deepEqual(
    plan.map((item) => item.trialId),
    buildTrialPlan(contract, scenarios, { trials: 3, seed: "test-seed" }).map(
      (item) => item.trialId,
    ),
  );
});

test("61 — Review ablation changes only the Review block", () => {
  const baseline = governanceInstructionsForGroup("baseline");
  const full = governanceInstructionsForGroup("full");
  const ablation = governanceInstructionsForGroup("without_review");
  assert.match(full, /## Review/);
  assert.match(baseline, /does not use Meta_Kim governance/);
  assert.match(baseline, /Do not invoke meta-theory stages, subagents, skills, MCPs/);
  assert.doesNotMatch(ablation, /## Review/);
  const normalizedFull = full.replace(/## Review[\s\S]*?(?=\n## Meta-Review)/, "ABLATION");
  const normalizedAblation = ablation.replace(
    /<!-- Review layer intentionally removed for P-116 ablation\. -->/,
    "ABLATION",
  );
  assert.equal(
    normalizedFull.replace(/ABLATION\n+/, "ABLATION\n"),
    normalizedAblation.replace(/ABLATION\n+/, "ABLATION\n"),
  );
});

test("61 — Codex JSONL parser records usage, tools, tests, and post-failure rework", () => {
  const raw = [
    { type: "item.completed", item: { type: "command_execution", command: "node --test", exit_code: 1 } },
    { type: "item.completed", item: { type: "file_change" } },
    { type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30 }, model: "test-model" },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
  const telemetry = parseCodexJsonl(raw);
  assert.equal(telemetry.inputTokens, 120);
  assert.equal(telemetry.outputTokens, 30);
  assert.equal(telemetry.toolCallCount, 2);
  assert.equal(telemetry.testRunCount, 1);
  assert.equal(telemetry.reworkCount, 1);
  assert.equal(telemetry.model, "test-model");
});

test("61 — Windows npm wrapper resolves to node plus codex.js instead of an App Execution Alias", () => {
  const wrapper = "C:/Users/test/AppData/Roaming/npm/codex.cmd";
  const expectedScript =
    "C:/Users/test/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js";
  const spec = codexCommandSpecFromCandidates(
    [wrapper, "C:/Program Files/WindowsApps/OpenAI.Codex/app/resources/codex.exe"],
    {
      fileExists: (candidate) => candidate.replaceAll("\\", "/") === expectedScript,
      nodeExecutable: "C:/node/node.exe",
    },
  );
  assert.deepEqual(spec, {
    file: "C:/node/node.exe",
    prefixArgs: [path.normalize(expectedScript)],
    source: "npm_node_wrapper",
  });

  const isolatedWrapper = "D:/lab/node_modules/.bin/codex.cmd";
  const isolatedScript = "D:/lab/node_modules/@openai/codex/bin/codex.js";
  assert.deepEqual(
    codexCommandSpecFromCandidates([isolatedWrapper], {
      fileExists: (candidate) => candidate.replaceAll("\\", "/") === isolatedScript,
      nodeExecutable: "C:/node/node.exe",
    }),
    {
      file: "C:/node/node.exe",
      prefixArgs: [path.normalize(isolatedScript)],
      source: "npm_node_wrapper",
    },
  );
});

test("61 — blind scorer receives no group identity and fixture solutions satisfy rubrics", async () => {
  const workspaceRoot = path.join(tempRoot, "workspaces");
  const fixtureRun = await runFitnessLab({
    mode: "run",
    provider: "fixture",
    trials: 1,
    seed: "fixture-test",
    runId: "fixture-test",
    stateRoot: tempRoot,
    workspaceRoot,
    timeoutMs: 120000,
    maxCases: null,
    model: null,
  });
  assert.equal(fixtureRun.report.status, "diagnostic_only");
  assert.equal(fixtureRun.report.countsTowardProductEvidence, false);
  assert.equal(fixtureRun.report.results.length, 9);
  assert.ok(fixtureRun.report.results.every((item) => item.environmentOutcomeSuccess));
  assert.ok(fixtureRun.report.results.every((item) => item.blindQuality.score === 5));
  assert.ok(
    fixtureRun.report.results.every(
      (item) => item.blindQuality.groupIdentityVisible === false && !("groupId" in item.blindQuality),
    ),
  );

  const one = fixtureRun.report.results[0];
  const task = scenarios.tasks.find((candidate) => candidate.id === one.taskId);
  const workspace = path.join(workspaceRoot, "fixture-test", one.trialId);
  const head = await readFile(path.join(workspace, ".git", "HEAD"), "utf8");
  assert.match(head, /^ref: refs\/heads\//);
  const headRef = head.trim().slice("ref: ".length);
  assert.match(await readFile(path.join(workspace, ".git", headRef), "utf8"), /^[a-f0-9]{40}\s*$/);
  const rescored = await evaluateBlindQuality(workspace, task, one.blindQuality.submissionId);
  assert.deepEqual(rescored, one.blindQuality);
});

test("61 — analyzer keeps failures in the denominator and can identify positive plus ineffective components", () => {
  const plan = buildTrialPlan(contract, scenarios, { trials: 3, seed: "analysis-test" });
  const results = plan.map((item) => {
    const baselinePenalty = item.groupId === "baseline" && item.taskClass !== "simple_modification";
    const score = item.groupId === "baseline" ? (item.taskClass === "simple_modification" ? 4.5 : 3.5) : 4.5;
    return {
      ...item,
      countsTowardProductEvidence: true,
      environmentOutcomeSuccess: !baselinePenalty,
      blindQuality: { score },
      metrics: {
        wallClockMs: item.groupId === "baseline" ? 100 : 120,
        inputTokens: item.groupId === "baseline" ? 100 : 120,
        outputTokens: 20,
        toolCallCount: 2,
        reworkCount: 0,
        failureType: baselinePenalty ? "held_out_environment_failure" : null,
      },
    };
  });
  const report = analyzeFitnessResults(contract, plan, results, "codex");
  assert.equal(report.status, "pass");
  assert.equal(report.summary.improvedTaskClasses, 2);
  assert.equal(report.byGroupTask.baseline.cross_file_high_risk.successRate, 0);
  assert.deepEqual(report.componentFindings, [
    { component: "Meta_Kim governance bundle", finding: "positive" },
    { component: "Review layer", finding: "ineffective" },
  ]);
});

test("61 — a partial live plan is a non-promotable pilot instead of a formal failure", () => {
  const plan = buildTrialPlan(contract, scenarios, { trials: 1, seed: "pilot" }).slice(0, 1);
  const results = plan.map((item) => ({
    ...item,
    countsTowardProductEvidence: true,
    environmentOutcomeSuccess: true,
    blindQuality: { score: 5 },
    metrics: {
      wallClockMs: 100,
      inputTokens: 100,
      outputTokens: 10,
      toolCallCount: 1,
      reworkCount: 0,
      failureType: null,
    },
  }));
  const report = analyzeFitnessResults(contract, plan, results, "codex");
  assert.equal(report.status, "pilot_incomplete");
  assert.equal(report.summary.pilotHealth, "pass");
  assert.equal(report.summary.expectedFullTrialCount, 27);
  assert.equal(report.countsTowardProductEvidence, false);
});

test("61 — native Codex records shared host capabilities without changing the backend", () => {
  const clean = codexHostContextObservation(
    { stdout: '{"type":"turn.completed"}\n', stderr: "" },
    repoRoot,
  );
  assert.equal(clean.backend, "native_codex_cli");
  assert.equal(clean.workspaceOutsideRepository, false);
  assert.equal(clean.globalCapabilitySignalsObserved, false);
  const observed = codexHostContextObservation(
    {
      stdout: "",
      stderr: "failed to load skill C:\\Users\\Kim\\.agents\\skills\\meta-theory\\SKILL.md",
    },
  );
  assert.equal(observed.globalCapabilitySignalsObserved, true);
  assert.equal(observed.sharedHostCapabilitiesHeldConstantAcrossGroups, true);
});

test("61 — package exposes validate, plan, fixture, pilot, and live commands", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.match(pkg.scripts["meta:fitness:validate"], /--validate/);
  assert.match(pkg.scripts["meta:fitness:plan"], /--plan --trials 3/);
  assert.match(pkg.scripts["meta:fitness:fixture"], /--provider=fixture/);
  assert.match(pkg.scripts["meta:fitness:pilot"], /--provider=codex --trials 1/);
  assert.match(pkg.scripts["meta:fitness:pilot"], /--task-id=simple-normalize-tags/);
  assert.match(pkg.scripts["meta:fitness:pilot"], /--group-id=baseline/);
  assert.match(pkg.scripts["meta:fitness:pilot"], /--max-cases 1/);
  assert.match(pkg.scripts["meta:fitness:run"], /--provider=codex --trials 3/);
  assert.match(pkg.scripts["meta:verify:governance:core"], /meta:fitness:validate/);
});

test("61 — destructive workspace cleanup rejects path-bearing run ids", async () => {
  await assert.rejects(
    () =>
      runFitnessLab({
        mode: "run",
        provider: "fixture",
        trials: 1,
        seed: "path-safety",
        runId: "../escape",
        stateRoot: tempRoot,
        workspaceRoot: path.join(tempRoot, "path-safety-workspaces"),
        timeoutMs: 120000,
        maxCases: 1,
        model: null,
      }),
    /run-id must use 1-128 safe filename characters/,
  );
});
