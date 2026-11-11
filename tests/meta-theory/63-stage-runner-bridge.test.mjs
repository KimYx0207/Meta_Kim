import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { createNativeHumanMilestoneConsumer, bindVerifiedHostPlanChallengeDecision } from "../../scripts/governed-execution/plan-challenge-host-continuation.mjs";
import { createNativeHostAnswerRepository } from "../../src/data/repositories/native-host-answer-repository.mjs";
import { openCodexDesktopHumanMilestoneHost } from "../../scripts/codex-desktop-human-milestone.mjs";
import { issueNativeDecisionChallenge } from "../../src/domain/decision/native-decision-authority.mjs";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { advanceGovernedGoal, commitMachineSourceProposal } from "../../scripts/governed-execution/advance-goal.mjs";
import { openDurableRunRepository } from "../../src/application/run/open-durable-run-repository.mjs";
import { buildTaskGoalContract } from "../../src/domain/governance/task-outcome.mjs";
import { readOnlyFixtureTaskFacts } from "../helpers/task-design-facts.mjs";
import { fixtureCritical, refreshFixtureSourcePins, runWithFixtureHostThinking } from "../helpers/host-reasoning-fixture.mjs";
import {
  applyStageRunnerBridgeResult,
  buildRuntimeChildEnv,
  buildReadOnlyWorkerPrompt,
  invokeReadOnlyRuntimeWorker,
  prepareReadOnlyRuntimeInvocation,
  readObservedMachineResult,
  runStageRunnerBridge,
} from "../../scripts/governed-execution/stage-runner-bridge.mjs";

test("machine result transport keeps the complete final JSON separately from the redacted display and CLI trace", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-machine-wire-"));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const body = { status: "blocked", content: "", reason: `C:/business/source.json ${"实际领域正文".repeat(4500)}` };
  const final = JSON.stringify(body);
  const records = [
    { type: "thread.started", thread_id: "transport-fixture" },
    { type: "item.completed", item: { id: "reasoning", type: "reasoning", text: "NEVER_EXPORT_REASONING_TRACE" } },
    { type: "item.completed", item: { id: "final", type: "agent_message", text: final } },
    { type: "turn.completed", usage: {} },
  ];
  const wire = `${records.map((item) => JSON.stringify(item)).join("\n")}\n`;
  const program = `let input="";process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",async()=>{if(input.includes("fixture-write-conflict"))(await import("node:fs")).writeFileSync(${JSON.stringify(path.join(root, "conflict.json"))},"preserved fixture bytes",{flag:"wx"});const wire=Buffer.from(${JSON.stringify(wire)});const split=wire.indexOf(Buffer.from("实际"))+1;process.stdout.write(wire.subarray(0,split));setTimeout(()=>process.stdout.write(wire.subarray(split)),25);});`;
  if (process.platform === "win32") {
    writeFileSync(path.join(root, "fake-codex.mjs"), program);
    writeFileSync(path.join(root, "codex.cmd"), '@echo off\r\n"%~dp0\\node.exe" "%~dp0\\fake-codex.mjs" %*\r\n');
  } else {
    const cli = path.join(root, "codex"); writeFileSync(cli, `#!/usr/bin/env node\n${program}`); chmodSync(cli, 0o700);
  }
  // A synthetic CLI process tests transport only; it makes no model call.
  const result = await invokeReadOnlyRuntimeWorker({ runtime: "codex", workspaceRoot: root, prompt: "Return the requested JSON",
    env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}` },
    machineResultArtifact: { ownedRoot: root, relativePath: "final.json", maxBytes: 256 * 1024, responseContract: { type: "object" } } });
  assert.equal(result.status, "pass", JSON.stringify(result));
  const actual = await readObservedMachineResult(result);
  const actualCharacters = [...actual];
  const firstDifference = [...final].findIndex((char, index) => char !== actualCharacters[index]);
  assert.equal(actual === final, true, JSON.stringify({ actualBytes: Buffer.byteLength(actual), expectedBytes: Buffer.byteLength(final),
    replacementCharacters: [...actual].filter((char) => char === "\ufffd").length, firstDifference }));
  assert.equal(result.machineResultArtifact.bytes, Buffer.byteLength(final));
  assert.notEqual(result.outputText, final);
  assert.ok(result.outputText.length <= 16000);
  assert.equal(readFileSync(result.machineResultArtifact.path, "utf8").includes("NEVER_EXPORT_REASONING_TRACE"), false);
  let writeAdmissions = 0;
  const blocked = await commitMachineSourceProposal({ proposalResult: result,
    authorizeWrite: async () => { writeAdmissions++; throw new Error("Blocked output reached write admission"); } });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.reason, "machine_proposal_blocked");
  assert.equal(blocked.proposalReason, body.reason);
  assert.equal(writeAdmissions, 0, "A real observed blocked message needs no reviewer or write admission");
  const conflictPath = path.join(root, "conflict.json");
  const conflict = await invokeReadOnlyRuntimeWorker({ runtime: "codex", workspaceRoot: root, prompt: "fixture-write-conflict: Return the requested JSON",
    env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}` },
    machineResultArtifact: { ownedRoot: root, relativePath: "conflict.json", maxBytes: 256 * 1024, responseContract: { type: "object" } } });
  assert.equal(conflict.status, "failed");
  assert.equal(conflict.failureClass, "machine_result_artifact_write_failed");
  assert.equal(conflict.runtimeProcessInvoked, true);
  assert.equal(conflict.exitCode, 0, "Transport succeeded before the host's artifact write failed");
  assert.equal(conflict.sessionId, "transport-fixture");
  assert.equal(conflict.messageId, "final");
  assert.equal(conflict.rawOutputSha256, result.rawOutputSha256);
  assert.ok(conflict.durationMs > 0 && Date.parse(conflict.endedAt) >= Date.parse(conflict.startedAt));
  assert.match(conflict.inputSha256, /^[a-f0-9]{64}$/u);
  assert.equal(conflict.machineResultArtifact, undefined);
  assert.equal(readFileSync(conflictPath, "utf8"), "preserved fixture bytes");
  await assert.rejects(readObservedMachineResult(conflict), /not_observed_by_host_invoker/u);
  await assert.rejects(readObservedMachineResult(structuredClone(result)), /not_observed_by_host_invoker/u);
  writeFileSync(result.machineResultArtifact.path, `${final} `);
  await assert.rejects(readObservedMachineResult(result), /artifact_changed/u);
});
import {
  buildStageDagPacket,
  stageLaneNodeId,
} from "../../scripts/governed-execution/stage-dag.mjs";
import { discoverDependencyAgentContracts, loadDependencyAgentMethod, componentHash, stableJson, sha256 } from "../../scripts/dependency-agent-discovery.mjs";
import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";
import { DURABLE_RUN_REPOSITORY_REQUIRED_METHODS } from "../../src/domain/execution/durable-run-repository-semantics.mjs";

const CONTRACT = JSON.parse(
  readFileSync("config/contracts/stage-runner-bridge-contract.json", "utf8"),
);
const PACKAGE = JSON.parse(readFileSync("package.json", "utf8"));

function lane(taskPacketId, overrides = {}) {
  return {
    laneId: taskPacketId,
    laneKind: "execution_worker",
    ownerBindingRef: `owner:${taskPacketId}`,
    capabilityBindingRef: `capability:${taskPacketId}`,
    effectClass: "read_only_worker",
    resourceScopes: [`file:${taskPacketId}.txt`],
    isolation: "shared_read_only",
    status: "planned_not_invoked",
    ...overrides,
  };
}

function packet(taskPacketId, overrides = {}) {
  const workOrder = {
    taskPacketId,
    owner: "test",
    ownerAgent: "test-automator",
    description: `Read ${taskPacketId}.txt`,
    output: "observed value",
    acceptanceCriteria: ["read the file"],
    scopeFiles: [`${taskPacketId}.txt`],
    shardScope: [taskPacketId],
    nonGoals: ["no writes"],
    dependsOn: [],
    executionMode: "primary_execution",
    externalWriteBoundary: false,
    ...overrides,
  };
  workOrder.todayTask ??= workOrder.description;
  if (!Object.hasOwn(overrides, "taskFacts")) {
    workOrder.taskFacts = readOnlyFixtureTaskFacts(workOrder.todayTask);
    workOrder.taskFactsSubject = workOrder.todayTask;
  }
  return workOrder;
}

function dagFor(taskPacketIds, { capacity = taskPacketIds.length, laneOverrides = {} } = {}) {
  return buildStageDagPacket({
    stageOrder: ["Execution"],
    stageLanes: {
      Execution: taskPacketIds.map((taskPacketId) =>
        lane(taskPacketId, laneOverrides[taskPacketId] ?? {})
      ),
    },
    runtimeCapacity: capacity,
  });
}

function passingInvoker({ delayMs = 5, lifecycle = null } = {}) {
  return async ({ runtime, packet }) => {
    const startedAt = new Date();
    if (lifecycle) {
      lifecycle.active += 1;
      lifecycle.maxActive = Math.max(lifecycle.maxActive, lifecycle.active);
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (lifecycle) lifecycle.active -= 1;
    const outputText = `${runtime}:${packet.taskPacketId}:observed`;
    return {
      status: "pass",
      runtime,
      exitCode: 0,
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: delayMs,
      sessionId: `${runtime}-session-${packet.taskPacketId}`,
      messageId: `${runtime}-message-${packet.taskPacketId}`,
      outputText,
      outputSha256: "a".repeat(64),
      rawOutputSha256: "b".repeat(64),
      hostEventCount: 2,
      toolEventCount: 1,
      stderrTail: "",
    };
  };
}

test("P-117 contract requires Codex and Claude Code with one DAG authority", () => {
  assert.equal(CONTRACT.prdTaskId, "P-117");
  assert.deepEqual(CONTRACT.primaryRuntimes, ["codex", "claude"]);
  assert.equal(CONTRACT.singleAuthority.packet, "coreLoop.stageDagPacket");
  assert.equal(CONTRACT.safety.taskBudget, null);
  assert.equal(CONTRACT.acceptance.oneRuntimeMaySubstituteForAnother, false);
  assert.equal(CONTRACT.acceptance.syntheticProviderOrModelOutputCountsAsProductEvidence, false);
  assert.equal(CONTRACT.acceptance.deterministicInputFilesAllowed, true);
  assert.match(CONTRACT.safety.childEnvironmentBoundary, /exact runtime allowlist/u);
  assert.match(CONTRACT.safety.childEnvironmentBoundary, /Prefix-matching is forbidden/u);
  assert.match(CONTRACT.safety.filesystemReadBoundary, /not claimed as mechanically confined/u);
  assert.match(CONTRACT.safety.telemetryRedaction, /built-in and custom invokers/u);
  assert.match(PACKAGE.scripts["meta:stage-runner:acceptance"], /--runtime both/u);
  assert.match(PACKAGE.scripts["meta:stage-runner:codex"], /--runtime codex/u);
  assert.match(PACKAGE.scripts["meta:stage-runner:claude"], /--runtime claude/u);
  assert.match(PACKAGE.scripts["meta:stage-runner:governed"], /--runtime both/u);
});

test("read-only worker prompt retains the original governed user task", () => {
  const prompt = buildReadOnlyWorkerPrompt({
    runId: "p117-task-context-test",
    runtime: "codex",
    node: dagFor(["one"]).nodes[0],
    packet: packet("one"),
    requestTask: "Read package.json and report the exact version.",
  });
  assert.match(prompt, /Original user task: Read package\.json and report the exact version\./u);
  if (process.platform === "win32") {
    assert.match(prompt, /direct Get-Content -LiteralPath command without a pipeline/u);
  }
});

test("large confirmed work orders reach runtime adapters intact without an invented prompt budget", async () => {
  const required = `${"Required reader acceptance: ".repeat(3_000)}Preserve the final EPUB illustrations.`;
  const qualityContext = {
    qualityBar: "Read the current artifact and use existing evidence; do not create a second verification harness.",
    evidenceRefs: ["fixture:reader-artifact", "fixture:approved-reader-requirements"],
    verifySteps: [{ id: "reader", step: "npm run build", verify: "This command is a verification direction, not permission for this read-only worker to run it." }],
    referenceDirection: "Compare the actual illustrations with the approved artifact; report missing runtime evidence rather than substituting test counts.",
  };
  const original = packet("one", { ...qualityContext, acceptanceCriteria: [required], intentBinding: {
    status: "host_provided_understanding", intentDigest: "a".repeat(64), confirmedOutcome: "An EPUB with its original illustrations",
    constraints: { outputFormat: "EPUB", preserve: ["original-illustrations"] },
    acceptanceCriteria: [{ id: "reader", description: required, kind: "semantic", required: true }],
  } });
  const assertQualityContext = (input) => {
    const line = input.split("\n").find((entry) => entry.startsWith("Task packet: "));
    const task = JSON.parse(line.slice("Task packet: ".length));
    for (const [field, value] of Object.entries(qualityContext)) assert.deepEqual(task[field], value, `actual worker input preserves ${field}`);
    assert.ok(input.includes(required));
  };
  for (const profile of [null, { status: "ready", owner: { ownerAgent: original.ownerAgent }, materials: [] }]) {
    // A synthetic profile only distinguishes transport branches; it is not a
    // source/fit or native invocation attestation.
    const selected = { ...original, ...(profile ? { agentCapabilityProfile: profile } : {}) };
    const prompt = buildReadOnlyWorkerPrompt({ runId: "complete-prompt", runtime: "codex",
      node: dagFor(["one"]).nodes[0], packet: selected, requestTask: "Inspect the reader artifact." });
    assert.ok(prompt.length > 64_000, "Exercise the former arbitrary cutoff");
    for (const runtime of ["codex", "claude"]) {
      const invocation = await prepareReadOnlyRuntimeInvocation({ runtime, workspaceRoot: process.cwd(), packet: selected, prompt });
      assert.equal(invocation.input, prompt, `${runtime} stdin must preserve the complete task`);
      assertQualityContext(invocation.input);
      if (runtime === "codex") assert.equal(invocation.args[invocation.args.indexOf("--sandbox") + 1], "read-only");
      else {
        assert.equal(invocation.args[invocation.args.indexOf("--permission-mode") + 1], "plan");
        assert.equal(invocation.args[invocation.args.indexOf("--allowedTools") + 1], "Read,Glob,Grep");
      }
    }
    let calls = 0;
    const bridge = await runStageRunnerBridge({ runId: "complete-prompt", runtime: "codex",
      stageDagPacket: dagFor(["one"]), workerTaskPackets: [selected], workspaceRoot: process.cwd(),
      evidenceKind: "custom_test_double", invokeWorker: async (options) => {
        calls += 1;
        assertQualityContext(options.prompt);
        return passingInvoker()(options);
      } });
    assert.equal(calls, 1);
    assert.equal(bridge.status, "pass");
    assert.equal(bridge.executionProjection.invocationTruth.nativeRuntimeInvoked, false);
  }
});

test("an adapter context rejection remains an explicit failure after receiving the full work order", async () => {
  const required = `${"Retain required content. ".repeat(3_000)}Final protected requirement.`;
  let calls = 0;
  const bridge = await runStageRunnerBridge({ runId: "adapter-context-rejection", runtime: "codex",
    stageDagPacket: dagFor(["one"]), workerTaskPackets: [packet("one", { acceptanceCriteria: [required] })], workspaceRoot: process.cwd(),
    evidenceKind: "custom_test_double", invokeWorker: async ({ prompt }) => {
      calls += 1;
      assert.ok(prompt.includes(required));
      return { status: "failed", failureClass: "runtime_nonzero_exit", failureMessage: "Test adapter rejected its context size", exitCode: 2, durationMs: 1 };
    } });
  assert.equal(calls, 1);
  assert.equal(bridge.status, "failed");
  assert.equal(bridge.failure.failureClass, "runtime_nonzero_exit");
  assert.equal(bridge.executionProjection.invocationTruth.nativeRuntimeInvoked, false);
});

test("runtime child environment is provider-specific and drops unrelated cloud credentials", () => {
  const parentEnv = {
    PATH: "runtime-path",
    OPENAI_API_KEY: "codex-secret",
    OPENAI_BASE_URL: "https://codex.example.invalid",
    CODEX_HOME: "codex-home",
    OPENAI_INTERNAL_DB_PASSWORD: "must-not-leak",
    CODEX_PROJECT_SECRET: "must-not-leak",
    ANTHROPIC_API_KEY: "claude-secret",
    ANTHROPIC_BASE_URL: "https://claude.example.invalid",
    CLAUDE_CONFIG_DIR: "claude-home",
    CLAUDE_PROJECT_SECRET: "must-not-leak",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    AZURE_CLIENT_SECRET: "azure-secret",
    GOOGLE_APPLICATION_CREDENTIALS: "google-secret-path",
    CLOUD_ML_TOKEN: "cloud-ml-secret",
    DATABASE_URL: "must-not-leak",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "parent-claude",
    CODEX_THREAD_ID: "parent-thread",
    CODEX_PERMISSION_PROFILE: "managed",
  };
  const codex = buildRuntimeChildEnv("codex", parentEnv);
  assert.deepEqual(codex.removedManagedHostMarkers, [
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CODEX_THREAD_ID",
    "CODEX_PERMISSION_PROFILE",
  ]);
  assert.equal(codex.childEnv.OPENAI_API_KEY, "codex-secret");
  assert.equal(codex.childEnv.OPENAI_BASE_URL, "https://codex.example.invalid");
  assert.equal(codex.childEnv.CODEX_HOME, "codex-home");
  assert.equal(codex.childEnv.OPENAI_INTERNAL_DB_PASSWORD, undefined);
  assert.equal(codex.childEnv.CODEX_PROJECT_SECRET, undefined);
  assert.equal(codex.childEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(codex.childEnv.CLAUDE_CONFIG_DIR, undefined);

  const claude = buildRuntimeChildEnv("claude", parentEnv);
  assert.equal(claude.childEnv.ANTHROPIC_API_KEY, "claude-secret");
  assert.equal(claude.childEnv.ANTHROPIC_BASE_URL, "https://claude.example.invalid");
  assert.equal(claude.childEnv.CLAUDE_CONFIG_DIR, "claude-home");
  assert.equal(claude.childEnv.CLAUDE_PROJECT_SECRET, undefined);
  assert.equal(claude.childEnv.OPENAI_API_KEY, undefined);
  assert.equal(claude.childEnv.CODEX_HOME, undefined);

  for (const childEnv of [codex.childEnv, claude.childEnv]) {
    assert.equal(childEnv.PATH, "runtime-path");
    assert.equal(childEnv.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(childEnv.AZURE_CLIENT_SECRET, undefined);
    assert.equal(childEnv.GOOGLE_APPLICATION_CREDENTIALS, undefined);
    assert.equal(childEnv.CLOUD_ML_TOKEN, undefined);
    assert.equal(childEnv.DATABASE_URL, undefined);
    assert.equal(childEnv.CLAUDECODE, undefined);
    assert.equal(childEnv.CODEX_THREAD_ID, undefined);
  }
});

test("bridge sanitizes custom worker output, stderr, and failure fields before retention", async () => {
  const secret = "bridge-secret-value-93841";
  const literalPassword = "literal-password-71592";
  const result = await runStageRunnerBridge({
    runId: "p118-custom-redaction",
    runtime: "codex",
    stageDagPacket: dagFor(["one"]),
    workerTaskPackets: [packet("one")],
    workspaceRoot: process.cwd(),
    redactionEnv: { OPENAI_API_KEY: secret },
    evidenceKind: "custom_test_double",
    invokeWorker: async () => ({
      status: "failed",
      durationMs: 1,
      outputText: `${process.cwd()} ${process.cwd().toUpperCase()} OPENAI_API_KEY=${secret} password=\"${literalPassword}\"`,
      outputSha256: "a".repeat(64),
      stderrTail: `${os.homedir()} ACCESS_TOKEN=${secret}`,
      failureClass: "custom_failure",
      failureMessage: `API_KEY=${secret}; PASSWORD=${literalPassword}; ${process.cwd()}`,
    }),
  });

  const retained = JSON.stringify({ nodeRecords: result.nodeRecords, failure: result.failure });
  assert.equal(retained.includes(secret), false);
  assert.equal(retained.includes(literalPassword), false);
  assert.equal(result.nodeRecords[0].outputText.includes(process.cwd()), false);
  assert.equal(result.nodeRecords[0].outputText.includes(process.cwd().toUpperCase()), false);
  assert.equal(result.nodeRecords[0].stderrTail.includes(os.homedir()), false);
  assert.equal(retained.includes(os.homedir()), false);
  assert.match(result.nodeRecords[0].outputText, /<workspace>/u);
  assert.match(result.nodeRecords[0].outputText, /<redacted-secret>/u);
  assert.match(result.nodeRecords[0].stderrTail, /<user-home>/u);
  assert.notEqual(result.nodeRecords[0].outputSha256, "a".repeat(64));
  assert.match(result.failure.reason, /<redacted-secret>/u);
});

test("bridge log path redaction keeps root boundaries while protecting case variants", async () => {
  const root = process.cwd();
  const home = os.homedir();
  // A worktree can live inside the user home. Workspace siblings stay outside
  // the workspace replacement while still preserving the independent home rule.
  const rootInsideHome = root.toLowerCase().startsWith(`${home}${path.sep}`.toLowerCase());
  const siblingRoot = rootInsideHome ? `<user-home>${root.slice(home.length)}` : root;
  const result = await runStageRunnerBridge({
    runId: "case-variant-path-redaction",
    runtime: "codex",
    stageDagPacket: dagFor(["one"]),
    workerTaskPackets: [packet("one")],
    workspaceRoot: root,
    evidenceKind: "custom_test_double",
    invokeWorker: async () => ({
      status: "pass", durationMs: 1,
      outputText: `"${root.toUpperCase()}/private.txt" ${root}-backup word${root} (${home.toUpperCase()}/private.txt) ${pathToFileURL(root).href.toUpperCase()}/private.txt ${root.toUpperCase()}. ${root}.hidden`,
      outputSha256: "a".repeat(64), stderrTail: "",
    }),
  });
  const text = result.nodeRecords[0].outputText;
  assert.ok(text.includes('"<workspace>/private.txt"'));
  assert.ok(text.includes("(<user-home>/private.txt)"));
  assert.ok(text.includes("file://<workspace>/private.txt"), "file URL presentations must not leak the root");
  assert.ok(text.includes("<workspace>. "), "sentence punctuation must not prevent root redaction");
  assert.ok(text.includes(`${siblingRoot}.hidden`), "a dot-suffixed sibling remains outside the workspace and obeys home redaction");
  assert.ok(text.includes(`${siblingRoot}-backup`), "a sibling remains outside the workspace and obeys home redaction");
  assert.ok(text.includes(`word${root}`), "a path embedded in a larger token is not the declared root");
});

test("sequential bridge executes one native-bound worker and the local merge node", async () => {
  const result = await runStageRunnerBridge({
    runId: "p117-sequential-test",
    runtime: "codex",
    stageDagPacket: dagFor(["one"], { capacity: 1 }),
    workerTaskPackets: [packet("one")],
    workspaceRoot: process.cwd(),
    capacity: 1,
    invokeWorker: passingInvoker(),
    evidenceKind: "test_double",
  });
  assert.equal(result.status, "pass");
  assert.equal(result.stageDagPacket.status, "planned_not_invoked");
  assert.equal(result.executionProjection.status, "executed");
  assert.equal(result.workerResults.length, 1);
  assert.ok(result.workerResults[0].observedDurationMs > 0);
  assert.equal(result.workerResults[0].actualBinding.runtime, "codex");
  assert.match(result.workspaceBoundary, /filesystem read confinement is not claimed/u);
  assert.equal(result.nodeRecords.at(-1).laneKind, "stage_merge");
  assert.equal(result.nodeRecords.at(-1).status, "completed");
});

test("fan-out bridge uses the DAG ready set and overlaps two native calls before merge", async () => {
  const lifecycle = { active: 0, maxActive: 0 };
  const result = await runStageRunnerBridge({
    runId: "p117-fanout-test",
    runtime: "claude",
    stageDagPacket: dagFor(["left", "right"], { capacity: 2 }),
    workerTaskPackets: [packet("left"), packet("right")],
    workspaceRoot: process.cwd(),
    capacity: 2,
    invokeWorker: passingInvoker({ delayMs: 20, lifecycle }),
    evidenceKind: "test_double",
  });
  assert.equal(result.status, "pass");
  assert.equal(lifecycle.maxActive, 2);
  assert.equal(result.workerResults.length, 2);
  assert.deepEqual(result.workerResults.map((worker) => worker.taskPacketId), ["left", "right"]);
  assert.equal(result.nodeRecords.filter((record) => record.laneKind === "stage_merge").length, 1);
  assert.equal(result.mergedOutput.length, 2);
});

test("read-only bridge rejects side-effect worker tasks before invoking a runtime", async () => {
  let invoked = false;
  const result = await runStageRunnerBridge({
    runId: "p117-side-effect-test",
    runtime: "codex",
    stageDagPacket: dagFor(["write"]),
    workerTaskPackets: [packet("write", { externalWriteBoundary: true })],
    workspaceRoot: process.cwd(),
    invokeWorker: async () => {
      invoked = true;
      throw new Error("must not run");
    },
    evidenceKind: "test_double",
  });
  assert.equal(invoked, false);
  assert.equal(result.status, "failed");
  assert.equal(result.failure.failureClass, "read_only_bridge_rejected_side_effect_task");
  assert.equal(result.workerResults.length, 0);
});

test("read-only bridge rejects a mutating DAG node even when its packet denies side effects", async () => {
  let invoked = false;
  const result = await runStageRunnerBridge({
    runId: "p117-node-effect-test",
    runtime: "codex",
    stageDagPacket: dagFor(["write"], {
      laneOverrides: { write: { effectClass: "external_write" } },
    }),
    workerTaskPackets: [packet("write", { externalWriteBoundary: false })],
    workspaceRoot: process.cwd(),
    invokeWorker: async () => {
      invoked = true;
      throw new Error("must not run");
    },
    evidenceKind: "test_double",
  });
  assert.equal(invoked, false);
  assert.equal(result.status, "failed");
  assert.equal(result.failure.failureClass, "read_only_bridge_rejected_node_effect");
});

test("bridge application cannot promote an injected callback to native execution truth", async () => {
  const bridge = await runStageRunnerBridge({
    runId: "p117-apply-test",
    runtime: "claude",
    stageDagPacket: dagFor(["one"], { capacity: 1 }),
    workerTaskPackets: [packet("one")],
    workspaceRoot: process.cwd(),
    capacity: 1,
    invokeWorker: passingInvoker(),
    evidenceKind: "native_read_only_stage_runner",
  });
  const coreLoop = {
    stageDagPacket: dagFor(["one"], { capacity: 1 }),
    executionResult: {
      actualWorkerExecution: false,
      executionClosure: "worker_execution_blocked_or_not_required",
      workerResultPackets: [{
        taskPacketId: "one",
        owner: "test",
        status: "planned_not_executed",
      }],
      workerExecutionEvidence: [{
        taskPacketId: "one",
        liveWorkerExecution: false,
        status: "planned_not_executed",
      }],
      mergeResult: { status: "dispatch_board_merged", liveExecutionMerged: false },
    },
    traceEvalControlPlane: {
      stageTiming: [{ stage: "Execution", observedDurationMs: 0 }],
    },
    langGraphRunPacket: {
      runtimeExecutionEvidence: "not_claimed",
      eventLog: [{ nodeId: "worker:one", eventType: "WorkerBlocked" }],
    },
    visibleMetaTheorySurfacePacket: { langGraph: {} },
  };
  const applied = applyStageRunnerBridgeResult(coreLoop, bridge);
  assert.equal(applied.stageDagPacket.status, "planned_not_invoked");
  assert.equal(applied.stageDagPacket.graphDigest, coreLoop.stageDagPacket.graphDigest);
  assert.equal(applied.stageRunnerBridgePacket.status, "pass");
  assert.equal(bridge.invocationAuthority, "injected_callback");
  assert.equal(bridge.workerResults[0].evidenceKind, "injected_stage_runner_callback");
  assert.equal(bridge.executionProjection.invocationTruth.bridgeCallbackCompleted, true);
  assert.equal(bridge.executionProjection.invocationTruth.nativeRuntimeInvoked, false);
  assert.equal(bridge.executionProjection.invocationTruth.plannedIsInvoked, false);
  assert.equal(applied.executionResult.actualWorkerExecution, false);
  assert.equal(applied.executionResult.workerResultPackets[0].status, "executed");
  assert.equal(applied.executionResult.workerExecutionEvidence[0].liveWorkerExecution, false);
  assert.ok(applied.traceEvalControlPlane.stageTiming[0].observedDurationMs > 0);
  assert.equal(applied.langGraphRunPacket.runtimeExecutionEvidence, "synthetic_stage_runner_bridge");
  assert.equal(applied.langGraphRunPacket.eventLog[0].eventType, "WorkerFinished");

  const syntheticBridge = structuredClone(bridge);
  syntheticBridge.workerResults[0].evidenceKind = "test_double";
  const syntheticApplied = applyStageRunnerBridgeResult(coreLoop, syntheticBridge);
  assert.equal(syntheticApplied.executionResult.actualWorkerExecution, false);
  assert.equal(
    syntheticApplied.executionResult.workerResultPackets[0].resultKind,
    "synthetic_read_only_worker_result",
  );
  assert.equal(
    syntheticApplied.executionResult.workerExecutionEvidence[0].runtimeProcessInvoked,
    false,
  );
  assert.equal(
    syntheticApplied.langGraphRunPacket.runtimeExecutionEvidence,
    "synthetic_stage_runner_bridge",
  );

  const nativeBridge = structuredClone(bridge);
  nativeBridge.invocationAuthority = "built_in_native_read_only_subprocess";
  nativeBridge.workerResults[0].evidenceKind = "native_read_only_stage_runner";
  const nativeApplied = applyStageRunnerBridgeResult(coreLoop, nativeBridge);
  assert.equal(nativeApplied.executionResult.actualWorkerExecution, false);
  assert.equal(
    nativeApplied.langGraphRunPacket.runtimeExecutionEvidence,
    "synthetic_stage_runner_bridge",
  );

  const missingBridgeDigest = structuredClone(bridge);
  delete missingBridgeDigest.stageDagPacket.graphDigest;
  assert.throws(
    () => applyStageRunnerBridgeResult(coreLoop, missingBridgeDigest),
    /bridge graph digest is missing/iu,
  );
});

async function dependencyMethodFixture(t, { structured = false, optionalKnowledge = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-owner-method-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = "resume-editor";
  const componentPath = `agents/${id}`;
  const componentRoot = path.join(root, componentPath);
  mkdirSync(componentRoot, { recursive: true });
  const sourceText = `---\nname: ${id}\ndescription: 简历修改：按真实经历匹配目标岗位\ntools: Read\n---\n\n# 简历方法\n\n先比对真实经历，再逐条检查证据，缺失事实标待确认。\nDo not invent facts or contact anybody.\n`;
  const capability = {
    id: "resume-editing", summary: "简历修改：按真实经历匹配目标岗位",
    useWhen: ["请把我的客服经历改成运营助理岗位简历"], doNotUseWhen: ["不编造经历"],
    input: { type: "object", required: ["facts"], properties: { facts: { type: "string" }, path: { type: "string" }, workspace: { type: "string" }, baseDir: { type: "string" } } },
    output: { type: "object", required: ["draft"], properties: { draft: { type: "string", description: 'Never search "/private/materials"' } } },
    permissions: ["filesystem:read-user-materials"], sideEffects: [],
    humanGate: { required: true, when: ["发布另行确认"] }, validation: ["check.mjs"],
  };
  const contract = { schemaVersion: 1, id, componentType: "agent", componentVersion: "0.1.0", entrypoint: "AGENT.md", capabilities: [capability] };
  writeFileSync(path.join(componentRoot, "AGENT.md"), sourceText);
  writeFileSync(path.join(componentRoot, "capability.json"), stableJson(contract));
  if (optionalKnowledge) writeFileSync(path.join(componentRoot, "example.md"), "Editable resume example\n只使用当前已提供的经历。\n");
  if (structured) writeFileSync(path.join(componentRoot, "method.json"), stableJson({ schemaVersion: 1, roleId: id,
    protocol: "host-bound-task-method-v1", steps: ["Compare supplied facts before drafting", "Keep missing facts explicit"],
    ...(optionalKnowledge ? { knowledgeAssets: [{ id: "resume-example", path: "example.md", appliesTo: ["需要可编辑简历示例时读取"], sourceRefs: ["fixture:resume-example"] }] } : {}),
    acceptance: ["Every experience claim points to a supplied fact"], automaticInvocation: false, finalAcceptance: "caller_only" }));
  writeFileSync(path.join(componentRoot, "check.mjs"), 'throw new Error("dependency validation must not execute");\n');
  const component = { id, componentType: "agent", componentVersion: "0.1.0", path: componentPath, entrypoint: "AGENT.md", capabilityIds: [capability.id], validation: capability.validation, contentSha256: await componentHash(componentRoot), contractSha256: sha256(stableJson(contract)) };
  const indexed = { ...capability, componentId: id, componentType: "agent", componentVersion: "0.1.0", componentPath, entrypoint: "AGENT.md", componentContentSha256: component.contentSha256, contractSha256: component.contractSha256 };
  mkdirSync(path.join(root, "generated"));
  writeFileSync(path.join(root, "generated/capabilities.json"), stableJson({ schemaVersion: 1, componentCount: 1, capabilityCount: 1, components: [component], capabilities: [indexed] }));
  const environment = { META_KIM_KIM_SERVICE_ROOT: root };
  const projects = JSON.parse(readFileSync("config/capability-index/dependency-project-registry.json", "utf8")).projects;
  const discovery = await discoverDependencyAgentContracts({ projects, projectRoot: process.cwd(), environment });
  const owner = discovery.agents.find((agent) => agent.id === `kim-service:${id}`);
  assert.ok(owner);
  const selected = packet("method", { owner: owner.id, ownerAgent: owner.id, ownerSource: owner.source, ownerSourceRef: owner.sourceRef, ownerBindingMode: owner.ownerBindingMode, ownerContract: owner.ownerContract });
  return { root, componentRoot, sourceText, owner, selected, environment };
}

/** Real local subprocesses with fixture data only; no model or external calls. */
async function parallelMachineGoalFixture(t, { mode = "parallel", hostCapacity = 2, planCapacity = 8 } = {}) {
  const fixture = await dependencyMethodFixture(t, { structured: true });
  const timelinePath = path.join(fixture.root, "timeline.jsonl");
  const startedBPath = path.join(fixture.root, "b-started");
  const releaseBPath = path.join(fixture.root, "release-b");
  const program = `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
let input="";process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>{
  const task=JSON.parse(input.split("\\n").find(line=>line.startsWith("Task packet: ")).slice(13));
  const trace=event=>appendFileSync(${JSON.stringify(timelinePath)},JSON.stringify({event,id:task.taskPacketId,pid:process.pid})+"\\n");
  trace("started");
  const finish=()=>{trace("finished");if(task.description==="failure"&&task.taskPacketId==="b")process.exit(9);
    const body={draft:"Supplied fixture facts",status:task.description==="blocked"&&task.taskPacketId==="b"?"blocked":"partial",handoff:{nextOwner:task.ownerAgent,requiresDecision:false}};
    process.stdout.write([{type:"thread.started",thread_id:"fixture-"+task.taskPacketId},{type:"item.completed",item:{id:"final",type:"agent_message",text:JSON.stringify(body)}},{type:"turn.completed",usage:{}}].map(record=>JSON.stringify(record)).join("\\n")+"\\n");};
  if(task.description==="parallel"){
    if(task.taskPacketId==="b")writeFileSync(${JSON.stringify(startedBPath)},"started");
    if(task.taskPacketId==="c"){writeFileSync(${JSON.stringify(releaseBPath)},"released");finish();return;}
    const waitFor=task.taskPacketId==="a"?${JSON.stringify(startedBPath)}:${JSON.stringify(releaseBPath)};
    const poll=setInterval(()=>{if(existsSync(waitFor)){clearInterval(poll);finish();}},10);
  }else setTimeout(finish,30);
});`;
  writeFileSync(path.join(fixture.root, "fake-codex.mjs"), program);
  if (process.platform === "win32") writeFileSync(path.join(fixture.root, "codex.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.mjs" %*\r\n`);
  else { writeFileSync(path.join(fixture.root, "codex"), `#!/usr/bin/env node\n${program}`); chmodSync(path.join(fixture.root, "codex"), 0o700); }
  const env = { ...process.env, ...fixture.environment, PATH: `${fixture.root}${path.delimiter}${process.env.PATH}` };
  const goalContract = buildTaskGoalContract({ task: "Read supplied fixture facts and preserve dependencies" });
  const graph = dagFor(["a", "b", "c"], { capacity: planCapacity,
    laneOverrides: { c: { dependsOn: [stageLaneNodeId("Execution", "a")] } } });
  const packets = ["a", "b", "c"].map((id) => ({ ...fixture.selected, taskPacketId: id, description: mode,
    methodInputs: { facts: "Fixed fixture facts", capacity: 999 }, dependsOn: id === "c" ? ["a"] : [] }));
  const context = { ...fixture, graph, packets, timelinePath, dbPath: path.join(fixture.root, "kernel.sqlite"),
    invoked: [], authorized: [], active: 0, maxActive: 0, runId: `machine-${mode}`, taskFingerprint: sha256("fixture:parallel-machine") };
  context.host = { ownerId: "parallel-fixture-host", adapterId: "synthetic-cli", capacity: hostCapacity,
    maxResultBytes: 256 * 1024, timeoutMs: 3000,
    authorize: async ({ taskPacket }) => { if (taskPacket) context.authorized.push(structuredClone(taskPacket)); return { status: "ready" }; },
    adapterRegistry: { invoke: async (_id, request) => {
      context.invoked.push(request.packet.taskPacketId); context.active++; context.maxActive = Math.max(context.maxActive, context.active);
      try { return { result: await invokeReadOnlyRuntimeWorker({ ...request, env }) }; }
      finally { context.active--; }
    } } };
  context.run = async (extra = {}) => {
    const kernel = await openDurableRunRepository(context.dbPath);
    try {
      const result = await advanceGovernedGoal({ runId: context.runId, goalContract, stageDagPacket: graph,
        workerTaskPackets: packets, projectRoot: process.cwd(), artifactRoot: path.join(fixture.root, "results"), runtime: "codex",
        host: context.host, kernel, taskFingerprint: context.taskFingerprint, env, ...extra });
      const resume = kernel.resumeRun({ runId: context.runId, graphDigest: graph.graphDigest, taskFingerprint: context.taskFingerprint });
      return { result, resume, events: kernel.getEvents(context.runId) };
    } finally { kernel.close(); }
  };
  return context;
}

test("machine goal runs real independent processes and refills a freed slot with the dependent task", async (t) => {
  const context = await parallelMachineGoalFixture(t);
  const { result, resume, events } = await context.run();
  assert.equal(result.status, "waiting", JSON.stringify(result));
  assert.equal(context.maxActive, 2);
  assert.equal(context.active, 0, "Returning must drain every admitted process");
  assert.deepEqual(context.invoked, ["a", "b", "c"]);
  assert.ok(result.calls.every((call) => call.status === "completed" && call.acceptanceStatus === "pending_independent_review"));
  assert.equal(resume.activeClaims.length, 0);
  assert.equal(resume.completedNodes.length, 4, "Three deliveries and the existing stage merge are retained");
  const timeline = readFileSync(context.timelinePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const at = (id, event) => timeline.findIndex((row) => row.id === id && row.event === event);
  assert.ok(at("a", "started") < at("a", "finished") && at("b", "started") < at("a", "finished"), "A waits for B's real subprocess before producing its output");
  assert.ok(at("a", "finished") < at("c", "started") && at("c", "started") < at("b", "finished"), "C releases the slow independent B only after A completes");
  assert.equal(new Set(timeline.map((row) => row.pid)).size, 3);
  assert.equal(events.at(-1).eventType, "RunCoordinatorReleased");
  const replay = await context.run();
  assert.deepEqual(replay.result.calls, []);
  assert.deepEqual(context.invoked, ["a", "b", "c"], "Resume reuses all durable deliveries");
});

test("machine goal capacity comes from the host and a plan can only lower it", async (t) => {
  for (const [label, hostCapacity, planCapacity] of [["host limit", 1, 8], ["plan limit", 3, 1], ["default host", undefined, 8]]) {
    await t.test(label, async (subtest) => {
      const context = await parallelMachineGoalFixture(subtest, { mode: "capacity", hostCapacity, planCapacity });
      if (hostCapacity === undefined) delete context.host.capacity;
      const { result } = await context.run();
      assert.ok(result.calls.every((call) => call.status === "completed"), JSON.stringify(result));
      assert.equal(context.maxActive, 1, "methodInputs.capacity=999 cannot grant worker capacity");
    });
  }
  for (const capacity of [0, -1, 1.5, NaN, Infinity, "2", null, Number.MAX_SAFE_INTEGER + 1]) {
    const result = await advanceGovernedGoal({ runId: "invalid-capacity", host: { capacity,
      authorize: async () => ({ status: "ready" }), adapterRegistry: { invoke: async () => assert.fail("Invalid capacity invoked a worker") } } });
    assert.equal(result.reason, "host_capacity_must_be_a_positive_integer");
  }
});

test("machine goal isolates a failed attempt, completes its independent branch and requires explicit recovery", async (t) => {
  const context = await parallelMachineGoalFixture(t, { mode: "failure" });
  const { result, resume, events } = await context.run();
  assert.equal(result.status, "blocked", JSON.stringify(result));
  assert.equal(context.active, 0);
  assert.deepEqual(context.invoked, ["a", "b", "c"]);
  assert.deepEqual(result.calls.filter((call) => call.status === "completed").map((call) => call.taskPacketId), ["a", "c"]);
  assert.equal(result.calls.find((call) => call.taskPacketId === "b").status, "unresolved");
  assert.equal(result.calls.find((call) => call.taskPacketId === "b").invocationStatus, "failed");
  assert.equal(resume.completedNodes.length, 2);
  assert.equal(events.filter((event) => event.eventType === "NodeAttemptFailed").length, 1);
  const replay = await context.run();
  assert.equal(replay.result.reason, "prior_attempt_requires_explicit_recovery");
  assert.deepEqual(replay.result.calls, []);
  assert.deepEqual(context.invoked, ["a", "b", "c"]);
});

test("machine goal keeps a professional blocked result distinct from a failed invocation", async (t) => {
  const context = await parallelMachineGoalFixture(t, { mode: "blocked" });
  const { result, events } = await context.run();
  assert.equal(result.status, "waiting", JSON.stringify(result));
  assert.equal(result.reason, "professional_result_requires_input_or_decision");
  assert.equal(result.calls.find((call) => call.taskPacketId === "b").domainOutput.status, "blocked");
  assert.ok(result.calls.every((call) => call.status === "completed"));
  assert.equal(events.filter((event) => event.eventType === "NodeAttemptFailed").length, 0);
});

test("machine goal coordinator excludes a second consumer even before a node is claimed", async (t) => {
  const context = await parallelMachineGoalFixture(t, { mode: "capacity" });
  let notifyEntered;
  let release;
  const entered = new Promise((resolve) => { notifyEntered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const first = context.run({ host: { ...context.host, authorize: async ({ node }) => {
    if (!node) return { status: "ready" };
    notifyEntered(); await gate; return { status: "waiting", reason: "fixture_host_wait" };
  } } });
  await entered;
  try {
    const second = await context.run();
    assert.equal(second.result.reason, "existing_run_coordinator");
    assert.deepEqual(context.invoked, []);
  } finally { release(); }
  const settled = await first;
  assert.equal(settled.result.reason, "fixture_host_wait");
  assert.equal(settled.events.at(-1).eventType, "RunCoordinatorReleased");
});

test("machine goal drains an admitted worker on a host pause and resumes without duplicate work", async (t) => {
  const context = await parallelMachineGoalFixture(t, { mode: "capacity" });
  const paused = await context.run({ host: { ...context.host, authorize: async ({ taskPacket }) =>
    taskPacket?.taskPacketId === "b" ? { status: "paused", reason: "fixture_user_pause" } : { status: "ready" } } });
  assert.equal(paused.result.status, "paused");
  assert.equal(context.active, 0);
  assert.deepEqual(context.invoked, ["a"]);
  assert.equal(paused.result.calls[0].status, "completed", "The host pause must wait for the admitted A result");
  assert.equal(paused.resume.activeClaims.length, 0);
  assert.equal(paused.events.at(-1).eventType, "RunCoordinatorReleased");
  const resumed = await context.run();
  assert.deepEqual(context.invoked, ["a", "b", "c"]);
  assert.ok(resumed.result.calls.every((call) => call.status === "completed"));
});

test("machine goal rejects stale coordinator output and never releases the replacement owner's lease", async (t) => {
  const context = await parallelMachineGoalFixture(t, { mode: "capacity" });
  const invoke = context.host.adapterRegistry.invoke;
  let takeoverEventSeq;
  context.host.adapterRegistry.invoke = async (id, request) => {
    const observed = await invoke(id, request);
    if (request.packet.taskPacketId === "a") {
      const replacement = await openDurableRunRepository(context.dbPath);
      try {
        const claim = replacement.claimRunCoordinator({ runId: context.runId, ownerId: "replacement-fixture-host", leaseMs: 30_000,
          nowMs: Date.now() + 60_000 });
        takeoverEventSeq = claim.eventSeq;
      } finally { replacement.close(); }
    }
    return observed;
  };
  const { result, events, resume } = await context.run();
  assert.equal(result.reason, "run_coordinator_lease_lost", JSON.stringify(result));
  assert.equal(context.active, 0);
  assert.ok(!resume.completedNodes.some((node) => node.nodeId === stageLaneNodeId("Execution", "a")));
  assert.ok(!events.some((event) => event.eventSeq > takeoverEventSeq && ["NodeAttemptCompleted", "RunCoordinatorReleased"].includes(event.eventType)),
    "A stale consumer cannot commit output or release another coordinator's lease");
});

test("machine goal retains a replaced node claim for recovery instead of committing its stale output", async (t) => {
  const context = await parallelMachineGoalFixture(t, { mode: "capacity" });
  const invoke = context.host.adapterRegistry.invoke;
  context.host.adapterRegistry.invoke = async (id, request) => {
    const observed = await invoke(id, request);
    if (request.packet.taskPacketId === "a") {
      const replacement = await openDurableRunRepository(context.dbPath);
      try { replacement.claimNode({ runId: context.runId, nodeId: request.node.nodeId, ownerId: "replacement-node-owner",
        nodeDefinitionHash: "fixture:replacement", inputHash: "fixture:replacement", dependencyOutputHash: "fixture:replacement",
        leaseMs: 30_000, nowMs: Date.now() + 60_000 }); }
      finally { replacement.close(); }
    }
    return observed;
  };
  const { result, resume, events } = await context.run();
  assert.equal(result.reason, "node_attempt_resolution_requires_explicit_recovery", JSON.stringify(result));
  assert.equal(context.active, 0);
  assert.ok(!resume.completedNodes.some((node) => node.nodeId === stageLaneNodeId("Execution", "a")));
  assert.ok(resume.activeClaims.some((claim) => claim.leaseOwner === "replacement-node-owner"));
  assert.ok(events.some((event) => event.eventType === "NodeAttemptAbandoned"));
  assert.ok(!context.invoked.includes("c"), "A stale A output must not release dependent C");
});

function useDependencyEnvironment(t, environment) {
  const original = process.env.META_KIM_KIM_SERVICE_ROOT;
  process.env.META_KIM_KIM_SERVICE_ROOT = environment.META_KIM_KIM_SERVICE_ROOT;
  t.after(() => original === undefined ? delete process.env.META_KIM_KIM_SERVICE_ROOT : process.env.META_KIM_KIM_SERVICE_ROOT = original);
}

test("machine goal consumes a verified revision in the actual unfinished worker request", async (t) => {
  const fixture = await dependencyMethodFixture(t, { structured: true });
  const { evaluateProductOutcomeReview } = await import("../../scripts/governed-execution/product-design.mjs");
  const projects = JSON.parse(readFileSync("config/capability-index/dependency-project-registry.json", "utf8")).projects;
  const discovered = await discoverDependencyAgentContracts({ projects, projectRoot: fixture.root, environment: fixture.environment });
  const currentOwner = discovered.agents.find((owner) => owner.id === fixture.selected.ownerAgent);
  const selected = { ...fixture.selected, ownerSource: currentOwner.source, ownerSourceRef: currentOwner.sourceRef,
    ownerBindingMode: currentOwner.ownerBindingMode, ownerContract: currentOwner.ownerContract };
  const program = `let input="";process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>{const task=JSON.parse(input.split("\\n").find(line=>line.startsWith("Task packet: ")).slice(13));const body={draft:task.referenceDirection??"independent",status:"partial",handoff:{nextOwner:task.ownerAgent,requiresDecision:false}};process.stdout.write([{type:"thread.started",thread_id:"synthetic-"+task.taskPacketId},{type:"item.completed",item:{id:"final",type:"agent_message",text:JSON.stringify(body)}},{type:"turn.completed",usage:{}}].map(record=>JSON.stringify(record)).join("\\n")+"\\n");});`;
  writeFileSync(path.join(fixture.root, "fake-codex.mjs"), program);
  if (process.platform === "win32") writeFileSync(path.join(fixture.root, "codex.cmd"), '@echo off\r\n"%~dp0\\node.exe" "%~dp0\\fake-codex.mjs" %*\r\n');
  else { writeFileSync(path.join(fixture.root, "codex"), `#!/usr/bin/env node\n${program}`); chmodSync(path.join(fixture.root, "codex"), 0o700); }
  const env = { ...process.env, ...fixture.environment, PATH: `${fixture.root}${path.delimiter}${process.env.PATH}` };
  const task = "Inspect the current report and make its next bounded review satisfy the original criteria.";
  const metricContract = "量=检查条目；单位=条/秒；范围分母=本合成夹具的全部12条；测法=现有本地报告检查；质量门槛=12/12条有来源；速度门槛=30秒内；基线可达证据=fixture:baseline（合成输入，不是实际性能证明）。";
  const goalContract = buildTaskGoalContract({ task, acceptanceCriteria: [
    { id: "report-correctness", description: metricContract, kind: "semantic" },
    { id: "independent-audit", description: "The independent audit has its evidence", kind: "semantic" },
  ] });
  const packets = ["a", "b", "c"].map((id) => ({ ...selected, taskPacketId: id,
    methodInputs: { facts: "Existing facts; no additional tools or writes" }, todayTask: "Original bounded task",
    taskFacts: readOnlyFixtureTaskFacts("Original bounded task"), taskFactsSubject: "Original bounded task",
    referenceDirection: "Use the existing facts", evidenceRefs: ["fixture:original"], verifySteps: [],
    acceptanceCriterionIds: [id === "b" ? "independent-audit" : "report-correctness"], dependsOn: id === "c" ? ["a"] : [] }));
  const dag = dagFor(["a", "b", "c"], { capacity: 1, laneOverrides: { c: { dependsOn: [stageLaneNodeId("Execution", "a")] } } });
  const material = "Current supplied report: the exact statement still requires correction.";
  writeFileSync(path.join(fixture.root, "report.md"), material);
  const requiredChange = "Compare the exact disputed statement with the supplied facts and return a corrected bounded report with the comparison evidence.";
  const captures = [];
  const authorized = [];
  const host = { ownerId: "fixture-host", adapterId: "synthetic-cli", maxResultBytes: 256 * 1024,
    authorize: async ({ taskPacket }) => { if (taskPacket) authorized.push(structuredClone(taskPacket)); return { status: "ready" }; },
    adapterRegistry: { invoke: async (_id, request) => { captures.push(structuredClone({ packet: request.packet, prompt: request.prompt }));
      return { result: await invokeReadOnlyRuntimeWorker({ ...request, env }) }; } } };
  const run = async (mode, returnToStage = "Execution", { omitReview = false, patchInput = null } = {}) => {
    const runId = `verified-revision-${mode}`;
    const artifact = { runId, goalContractPacket: goalContract, workerTaskPackets: packets };
    const input = { schemaVersion: 1, runId, taskHash: goalContract.taskHash, intentDigest: null, acceptanceDigest: goalContract.acceptanceDigest,
      designDigest: null, reviewRef: "fixture:current-review", artifactSnapshots: [{ ref: "report.md", sha256: sha256(material), producerTaskId: "a" }],
      observations: [{ criterionId: "report-correctness", taskHash: goalContract.taskHash, acceptanceDigest: goalContract.acceptanceDigest,
        artifactRefs: ["report.md"], verdict: "fail", evidenceKind: "independent_review", producer: "prior-producer", reviewer: "independent-reviewer", evidenceRef: "fixture:current-review" }],
      revisionRequests: [{ taskId: "c", criterionId: "report-correctness", returnToStage, finding: "The statement disagrees with the supplied facts",
        requiredChange, evidenceRefs: ["fixture:current-review"] }] };
    patchInput?.(input);
    const outcomeReview = omitReview ? null : await evaluateProductOutcomeReview({ input, artifact, projectRoot: fixture.root });
    const kernel = await openDurableRunRepository(path.join(fixture.root, `${mode}.sqlite`));
    try {
      try { kernel.resumeRun({ runId, graphDigest: dag.graphDigest, taskFingerprint: sha256(task) }); }
      catch {
        kernel.createRun({ runId, graphDigest: dag.graphDigest, taskFingerprint: sha256(task) });
        const nodeId = stageLaneNodeId("Execution", "a");
        const claim = kernel.claimNode({ runId, nodeId, ownerId: host.ownerId, nodeDefinitionHash: "fixture-a", inputHash: "fixture-a", dependencyOutputHash: "fixture-a", leaseMs: 30_000 });
        kernel.completeNode({ ...claim, runId, nodeId, ownerId: host.ownerId, output: { outputSha256: sha256(material), domainOutput: { status: "partial", handoff: { requiresDecision: false, nextOwner: fixture.selected.ownerAgent } } } });
      }
      return await advanceGovernedGoal({ runId, goalContract, stageDagPacket: dag, workerTaskPackets: packets, projectRoot: fixture.root,
        artifactRoot: path.join(fixture.root, mode), runtime: "codex", host, kernel, taskFingerprint: sha256(task), env, outcomeReview });
    } finally { kernel.close(); }
  };
  const result = await run("execute");
  assert.deepEqual(captures.map(({ packet }) => packet.taskPacketId), ["b", "c"], JSON.stringify(result));
  const actual = captures.find(({ packet }) => packet.taskPacketId === "c");
  assert.ok(actual.prompt.includes(requiredChange), "The actual CLI prompt must contain the concrete verified revision");
  assert.ok(actual.prompt.includes(sha256(material)), "The current artifact digest must travel with the requested change");
  assert.ok(actual.prompt.includes(metricContract), "The existing criterion description must retain the complete measurement and quality/speed requirements");
  assert.ok(actual.packet.verifySteps.some((check) => check.verify === metricContract));
  assert.equal(actual.packet.todayTask, packets[2].todayTask, "A verified revision preserves the confirmed task identity");
  assert.equal(actual.packet.taskFactsSubject, packets[2].taskFactsSubject, "Revision guidance cannot rebind old task facts");
  assert.deepEqual(actual.packet, authorized.find((packet) => packet.taskPacketId === "c"), "Authorize and invoke must see the same packet");
  assert.deepEqual(actual.packet.scopeFiles, packets[2].scopeFiles);
  assert.deepEqual(actual.packet.ownerContract, packets[2].ownerContract);
  assert.ok(result.calls.find((call) => call.taskPacketId === "c").domainOutput?.draft?.includes(requiredChange),
    `An actual synthetic CLI must consume the revised direction: ${JSON.stringify(result)}`);
  await run("execute");
  assert.equal(captures.length, 2, "The same review cannot replay completed workers");
  await t.test("invalid observation binding cannot create executable revisions", async () => {
    const beforeInvalid = captures.length;
    await assert.rejects(run("invalid-observation", "Execution", { patchInput: (input) => { input.observations[0].taskHash = "wrong-task"; } }), /invalid.*observation|binding/i);
    assert.equal(captures.length, beforeInvalid);
  });
  await t.test("pending stage revision survives omission and unrelated review, while a current replacement is single-use", async () => {
    const beforeThinking = captures.length;
    const thinking = await run("thinking", "Thinking");
    assert.deepEqual(captures.slice(beforeThinking).map(({ packet }) => packet.taskPacketId), ["b"]);
    assert.equal(thinking.nextAction.stage, "Thinking");
    assert.ok(JSON.stringify(thinking.nextAction).includes(requiredChange), "The real host receives the full unfinished stage action, not an empty blocked reason");
    const beforeOmitted = captures.length;
    const omitted = await run("thinking", "Thinking", { omitReview: true });
    assert.equal(omitted.nextAction?.stage, "Thinking");
    assert.equal(captures.length, beforeOmitted, "Omission cannot release C or replay B");
    const b = thinking.calls.find((call) => call.taskPacketId === "b");
    const bOnly = await run("thinking", "Thinking", { patchInput: (input) => {
      const ref = path.relative(fixture.root, b.machineResultArtifact.path).split(path.sep).join("/");
      input.reviewRef = "fixture:b-only-review";
      input.artifactSnapshots = [{ ref, sha256: b.outputSha256, producerTaskId: "b" }];
      input.observations[0] = { ...input.observations[0], criterionId: "independent-audit", artifactRefs: [ref], verdict: "pass", evidenceRef: input.reviewRef };
      input.revisionRequests = [];
    } });
    assert.equal(bOnly.nextAction.stage, "Thinking", "A B-only review cannot clear the pending C criterion");
    assert.equal(captures.length, beforeOmitted);
    const replaced = await run("thinking", "Execution");
    assert.deepEqual(captures.slice(beforeOmitted).map(({ packet }) => packet.taskPacketId), ["c"]);
    assert.ok(replaced.calls[0].domainOutput.draft.includes(requiredChange));
    const beforeStale = captures.length;
    await assert.rejects(run("thinking", "Thinking"), /superseded.*review/i);
    assert.equal(captures.length, beforeStale, "A superseded review cannot restore the old wait or resend work");
  });
  const inconclusive = await run("inconclusive", "Fetch", { patchInput: (input) => { input.observations[0].verdict = "inconclusive"; } });
  assert.equal(inconclusive.nextAction.stage, "Fetch");
  assert.equal(inconclusive.outcome.results.find((result) => result.criterionId === "report-correctness").status, "inconclusive");
  writeFileSync(path.join(fixture.root, "report.md"), "Changed after the review snapshot");
  await assert.rejects(run("wrong-current-sha"), /changed since review/);
});

test("machine goal keeps a decision local while independent work continues without replay on resume", async (t) => {
  const fixture = await dependencyMethodFixture(t, { structured: true });
  const program = `let input="";process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>{
    const line=input.split("\\n").find(line=>line.startsWith("Task packet: "));
    const task=JSON.parse(line.slice("Task packet: ".length));
    const body={draft:task.taskPacketId,status:task.taskPacketId==="a"&&task.description==="technical-block"?"blocked":"partial",handoff:{nextOwner:task.ownerAgent,
      requiresDecision:task.taskPacketId==="a"&&task.description==="needs-decision"}};
    const records=[{type:"thread.started",thread_id:"synthetic-"+task.taskPacketId},
      {type:"item.completed",item:{id:"final",type:"agent_message",text:JSON.stringify(body)}},{type:"turn.completed",usage:{}}];
    process.stdout.write(records.map(record=>JSON.stringify(record)).join("\\n")+"\\n");});`;
  if (process.platform === "win32") {
    writeFileSync(path.join(fixture.root, "fake-codex.mjs"), program);
    writeFileSync(path.join(fixture.root, "codex.cmd"), '@echo off\r\n"%~dp0\\node.exe" "%~dp0\\fake-codex.mjs" %*\r\n');
  } else {
    const cli = path.join(fixture.root, "codex");
    writeFileSync(cli, `#!/usr/bin/env node\n${program}`); chmodSync(cli, 0o700);
  }
  const env = { ...process.env, ...fixture.environment, PATH: `${fixture.root}${path.delimiter}${process.env.PATH}` };
  const dag = dagFor(["a", "b", "c"], { capacity: 1,
    laneOverrides: { c: { dependsOn: [stageLaneNodeId("Execution", "a")] } } });
  const task = "Inspect the supplied facts and independently verify the parent deliverable.";
  const goalContract = buildTaskGoalContract({ task });
  const invoked = [];
  const host = { ownerId: "synthetic-cli-host", adapterId: "synthetic-cli", maxResultBytes: 256 * 1024,
    authorize: async () => ({ status: "ready" }), adapterRegistry: { invoke: async (_id, request) => {
      invoked.push(request.packet.taskPacketId);
      // An actual synthetic CLI process exercises observed-result transport, not a model.
      return { result: await invokeReadOnlyRuntimeWorker({ ...request, env }) };
    } } };
  const run = async (mode, extra = {}) => {
    const kernel = await openDurableRunRepository(path.join(fixture.root, `${mode}.sqlite`));
    try {
      return await advanceGovernedGoal({ runId: `local-wait-${mode}`, goalContract, stageDagPacket: dag,
        workerTaskPackets: ["a", "b", "c"].map((id) => ({ ...fixture.selected, taskPacketId: id, description: mode,
          methodInputs: { facts: mode }, dependsOn: id === "c" ? ["a"] : [] })),
        projectRoot: process.cwd(), artifactRoot: path.join(fixture.root, mode), runtime: "codex",
        host: { ...host, ...extra.host }, kernel, taskFingerprint: sha256(task), env,
        humanMilestones: extra.humanMilestones ?? [], observations: extra.observations ?? [] });
    } finally { kernel.close(); }
  };
  const waiting = await run("needs-decision");
  assert.equal(waiting.status, "waiting", JSON.stringify(waiting));
  assert.deepEqual(invoked, ["a", "b"], "A waits for a decision; independent B runs and dependent C does not");
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.reason, "professional_result_requires_input_or_decision");
  assert.equal(waiting.outcome.status, "incomplete");
  assert.deepEqual(waiting.calls.map((call) => call.taskPacketId), ["a", "b"]);
  const resumed = await run("needs-decision");
  assert.deepEqual(invoked, ["a", "b"], "The reopened kernel does not replay A or B, or release C");
  assert.equal(resumed.status, "waiting");
  assert.deepEqual(resumed.calls, []);
  const milestone = { nodeId: stageLaneNodeId("Execution", "a"), milestoneId: "prd_mvp_scope", trigger: "first",
    evidence: [{ evidenceRef: "evidence:prd", digest: `sha256:${"1".repeat(64)}` }] };
  let hostQuestions = 0;
  const humanHost = (selectedOptionId) => {
    let request;
    let response;
    let returnedAt;
    const repository = createNativeHostAnswerRepository({ profileRoot: fixture.root });
    return createNativeHumanMilestoneConsumer({ repository,
      now: () => new Date(Date.parse(returnedAt) + 1).toISOString(),
      prepareDecision: async ({ decision }) => {
        assert.equal(invoked.at(-1), "b", "Independent B must run before the host waits for a human answer");
        hostQuestions += 1;
        const issuedAt = new Date().toISOString();
        returnedAt = new Date(Date.parse(issuedAt) + 1).toISOString();
        const options = decision.options.map(({ optionId }) => ({ optionId,
          label: ({ "option:accept": "确认本版", "option:revise": "提出修改", "option:return": "退回方案" })[optionId], description: optionId }));
        const question = { id: "milestone", header: "当前版本", question: "请判断本版材料", options };
        request = { id: hostQuestions, method: "item/tool/requestUserInput", params: {
          threadId: "synthetic-human-thread", turnId: `turn-${hostQuestions}`, itemId: `item-${hostQuestions}`,
          questions: [{ ...question, options: options.map(({ label, description }) => ({ label, description })) }] } };
        response = { id: hostQuestions, result: { answers: { milestone: { answers: [options.find((item) => item.optionId === selectedOptionId).label] } } } };
        return { issuedChallenge: issueNativeDecisionChallenge(decision, { runtime: "codex", surface: "request_user_input",
          challengeRef: `challenge:milestone-${hostQuestions}`, requestRef: `request:milestone-${hostQuestions}`,
          issuedAt, expiresAt: new Date(Date.parse(issuedAt) + 60_000).toISOString() }),
        expectedBinding: { threadId: request.params.threadId, turnId: request.params.turnId, itemId: request.params.itemId },
        presentation: { question } };
      },
      hostConnection: { hostConnectionRef: "host:synthetic-human-milestone",
        takeRequestUserInput: async () => ({ request, timeSourceClaimRef: "time-source:request" }),
        takeResponse: async () => ({ response, at: returnedAt, timeSourceClaimRef: "time-source:return" }),
        ackResponse: async () => {} },
    });
  };
  const consumer = humanHost("option:accept");
  const paused = await run("needs-decision", { humanMilestones: [milestone], host: { humanDecisionConsumer: consumer,
    authorize: async () => ({ status: "waiting", reason: "explicit_user_pause" }) } });
  assert.equal(paused.reason, "explicit_user_pause");
  assert.equal(hostQuestions, 0);
  const accepted = await run("needs-decision", { humanMilestones: [milestone], host: { humanDecisionConsumer: consumer } });
  assert.equal(accepted.humanMilestoneReviews[0].accepted, true, JSON.stringify(accepted));
  assert.deepEqual(invoked, ["a", "b", "c"], "A/B outputs are reused; the current consumed human reply releases only C");
  assert.equal(hostQuestions, 1);
  const acceptedAgain = await run("needs-decision", { humanMilestones: [milestone], host: { humanDecisionConsumer: consumer } });
  assert.deepEqual(acceptedAgain.calls, []);
  assert.equal(hostQuestions, 1, "Replay revalidates the stored consumed reply without another human prompt");
  assert.equal(bindVerifiedHostPlanChallengeDecision({ verifiedDecision: { approved: true, state: "consumed" }, preview: {} }).accepted, false);
  const changed = await run("needs-decision", { humanMilestones: [{ ...milestone,
    evidence: [{ evidenceRef: "evidence:prd", digest: `sha256:${"2".repeat(64)}` }] }] });
  assert.equal(changed.humanMilestoneReviews[0].accepted, false, "The old accepted reply cannot approve changed PRD evidence");
  assert.equal(changed.humanMilestoneReviews[0].reason, "human_milestone_changed_evidence_requires_revision");
  const returned = await run("human-return", { humanMilestones: [milestone], host: { humanDecisionConsumer: humanHost("option:return") } });
  assert.deepEqual(returned.calls.map((call) => call.taskPacketId), ["a", "b"]);
  assert.equal(returned.humanMilestoneReviews[0].reason, "human_milestone_returned");
  const revised = await run("human-revise", { humanMilestones: [milestone], host: { humanDecisionConsumer: humanHost("option:revise") } });
  assert.deepEqual(revised.calls.map((call) => call.taskPacketId), ["a", "b"]);
  assert.equal(revised.humanMilestoneReviews[0].reason, "human_milestone_revision_required");
  const technical = await run("technical-block", { humanMilestones: [milestone], host: { humanDecisionConsumer: humanHost("option:accept") } });
  assert.equal(technical.humanMilestoneReviews[0].accepted, true);
  assert.deepEqual(technical.calls.map((call) => call.taskPacketId), ["a", "b"], "A human judgement does not resolve technical blocked inputs");
  const repairStart = invoked.length;
  const partial = await run("partial-without-decision");
  assert.deepEqual(invoked.slice(repairStart), ["a", "b", "c"], "An ordinary fix adds no milestone; partial alone does not block dependent work");
  assert.equal(partial.status, "waiting", "Executed work does not establish parent acceptance");
  assert.equal(partial.reason, "parent_goal_outcome_evidence_or_authorized_plan_required");
  assert.equal(partial.publicReady, false);
  await t.test("persisted human declaration survives omitted request arguments", async () => {
    const pending = await run("declaration-pending", { humanMilestones: [milestone] });
    assert.deepEqual(pending.calls.map((call) => call.taskPacketId), ["a", "b"]);
    const omitted = await run("declaration-pending");
    assert.equal(omitted.reason, "human_milestone_review_required");
    assert.deepEqual(omitted.calls, [], "Omitting the declaration cannot execute its dependent C");
    assert.equal(omitted.humanMilestoneReviews[0].accepted, false);
    const reportedPass = await run("declaration-pending", { observations: goalContract.acceptanceCriteria.map((criterion) => ({
      criterionId: criterion.id, taskHash: goalContract.taskHash, acceptanceDigest: goalContract.acceptanceDigest,
      verdict: "pass", evidenceKind: "human_review", reviewer: "synthetic-user", evidenceRef: "fixture:reported-goal-pass" })) });
    assert.equal(reportedPass.status, "waiting", "Reported criterion pass cannot complete a run with its persisted human decision unanswered");
    assert.equal(reportedPass.userOutcomeAccepted, false);
  });
  await t.test("E1 to E2 to E1 cannot revive an invalidated consumed decision", async () => {
    const admissions = [];
    const authorize = async ({ node }) => {
      if (node?.nodeId === stageLaneNodeId("Execution", "c")) {
        admissions.push(node.nodeId);
        return { status: "waiting", reason: "stop_before_worker" };
      }
      return { status: "ready" };
    };
    const liveConsumer = humanHost("option:accept");
    const acceptedE1 = await run("evidence-lifecycle", { humanMilestones: [milestone],
      host: { authorize, humanDecisionConsumer: liveConsumer } });
    assert.equal(acceptedE1.humanMilestoneReviews[0].accepted, true);
    const changedE2 = await run("evidence-lifecycle", { humanMilestones: [{ ...milestone,
      evidence: [{ evidenceRef: "evidence:prd", digest: `sha256:${"2".repeat(64)}` }] }], host: { authorize } });
    assert.equal(changedE2.humanMilestoneReviews[0].accepted, false);
    const beforeRestore = admissions.length;
    const questionsBeforeRestore = hostQuestions;
    const restoredE1 = await run("evidence-lifecycle", { humanMilestones: [milestone],
      host: { authorize, humanDecisionConsumer: liveConsumer } });
    assert.equal(restoredE1.humanMilestoneReviews[0].accepted, false);
    assert.equal(restoredE1.humanMilestoneReviews[0].decisionState, "invalidated");
    assert.equal(admissions.length, beforeRestore, "Invalidated E1 cannot even admit C for execution");
    assert.equal(hostQuestions, questionsBeforeRestore, "Invalidated/unknown history does not cause an automatic new human request");
  });
});

test("verified dependency methods preserve exact source and use one restricted Claude role or explicit Codex contract mode", async (t) => {
  const fixture = await dependencyMethodFixture(t);
  for (const runtime of ["codex", "claude"]) {
    const plan = await prepareReadOnlyRuntimeInvocation({ runtime, workspaceRoot: process.cwd(), packet: fixture.selected, prompt: "bounded task", env: fixture.environment });
    assert.equal(plan.ownerMethodBinding.contentDigest, sha256(fixture.sourceText));
    assert.equal(plan.ownerMethodBinding.nativeCustomAgentInvocationVerified, false);
    if (runtime === "claude") {
      assert.equal(plan.args.includes("--safe-mode"), false, "safe mode suppresses custom roles");
      assert.ok(plan.args.includes("--bare"));
      const roles = JSON.parse(plan.args[plan.args.indexOf("--agents") + 1]);
      assert.deepEqual(Object.keys(roles), ["resume-editor"]);
      assert.equal(roles["resume-editor"].prompt, fixture.sourceText);
      assert.deepEqual(roles["resume-editor"].tools, ["Read"]);
      assert.equal(plan.args[plan.args.indexOf("--agent") + 1], "resume-editor");
      assert.equal(plan.args[plan.args.indexOf("--permission-mode") + 1], "plan");
      assert.equal(plan.args[plan.args.indexOf("--allowedTools") + 1], "Read");
      assert.ok(plan.args.includes("--no-session-persistence"));
      assert.ok(plan.input.startsWith("bounded task"));
      assert.match(plan.input, /legacy_compatible/u);
      assert.match(plan.input, /"missingInputFields":\["facts"\]/u);
      assert.equal(plan.ownerMethodBinding.nativeCustomAgent, "requested_unverified");
    } else {
      assert.ok(plan.input.endsWith(fixture.sourceText));
      assert.equal(plan.ownerMethodBinding.methodDelivery, "codex_contract_method_prompt");
      assert.equal(plan.ownerMethodBinding.nativeCustomAgent, "not_verified");
      assert.equal(plan.args.includes("--agent"), false);
      for (const flag of ["--ignore-user-config", "--ignore-rules", "--ephemeral"]) assert.ok(plan.args.includes(flag));
      assert.equal(plan.args[plan.args.indexOf("--sandbox") + 1], "read-only");
    }
  }
  const generic = await prepareReadOnlyRuntimeInvocation({ runtime: "claude", workspaceRoot: process.cwd(), packet: packet("generic"), prompt: "generic task", env: {} });
  assert.ok(generic.args.includes("--safe-mode"));
  assert.equal(generic.args.includes("--agents"), false);
  assert.equal(generic.ownerMethodBinding, null);
  assert.equal(generic.input, "generic task");
});

test("packet paths, forged bindings, missing definitions, drift and symlink roots fail before any worker callback", async (t) => {
  const fixture = await dependencyMethodFixture(t);
  useDependencyEnvironment(t, fixture.environment);
  const invalid = [
    { ...fixture.selected, ownerSourceRef: "../../untrusted/AGENT.md" },
    { ...fixture.selected, ownerContract: { ...fixture.selected.ownerContract, sourceRef: "../../untrusted/AGENT.md" } },
    { ...fixture.selected, ownerContract: { ...fixture.selected.ownerContract, contentDigest: "0".repeat(64) } },
    { ...fixture.selected, ownerContract: { ...fixture.selected.ownerContract, componentContentSha256: "0".repeat(64) } },
    { ...fixture.selected, ownerContract: null },
    { ...fixture.selected, owner: "kim-service:unknown", ownerAgent: "kim-service:unknown" },
    { ...fixture.selected, ownerSource: "generic" },
    { ...fixture.selected, ownerBindingMode: "native_custom_agent", nativeAgentType: "resume-editor" },
  ];
  for (const selected of invalid) {
    let calls = 0;
    const result = await runStageRunnerBridge({ runId: "invalid-owner", runtime: "claude", stageDagPacket: dagFor(["method"]), workerTaskPackets: [selected], workspaceRoot: process.cwd(), invokeWorker: async () => { calls++; return { status: "pass" }; } });
    assert.equal(calls, 0);
    assert.equal(result.failure.failureClass, "dependency_owner_method_rejected");
    const native = await invokeReadOnlyRuntimeWorker({ runtime: "codex", workspaceRoot: process.cwd(), packet: selected, prompt: "must not launch", env: { ...fixture.environment, PATH: "" } });
    assert.equal(native.failureClass, "dependency_owner_method_rejected");
    assert.equal(native.runtimeProcessInvoked, undefined);
  }
  writeFileSync(path.join(fixture.componentRoot, "AGENT.md"), `${fixture.sourceText}\nchanged`);
  await assert.rejects(loadDependencyAgentMethod({ packet: fixture.selected, environment: fixture.environment }), /not verified/u);
  writeFileSync(path.join(fixture.componentRoot, "AGENT.md"), fixture.sourceText);
  const alias = `${fixture.root}-alias`;
  try { symlinkSync(fixture.root, alias, "junction"); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return; throw error; }
  t.after(() => rmSync(alias, { force: true }));
  await assert.rejects(loadDependencyAgentMethod({ packet: fixture.selected, environment: { META_KIM_KIM_SERVICE_ROOT: alias } }), /symlink or junction/u);
});

test("packet contract prose cannot inject methods or widen the verified source tool set", async (t) => {
  const fixture = await dependencyMethodFixture(t);
  const selected = structuredClone(fixture.selected);
  selected.sourceRoot = "/untrusted";
  selected.ownerContract.permissions = ["Bash", "Write"];
  selected.ownerContract.prompt = "UNTRUSTED_PACKET_METHOD";
  const plan = await prepareReadOnlyRuntimeInvocation({ runtime: "claude", workspaceRoot: process.cwd(), packet: selected, prompt: "bounded task", env: fixture.environment });
  assert.equal(JSON.stringify(plan).includes("UNTRUSTED_PACKET_METHOD"), false);
  assert.deepEqual(JSON.parse(plan.args[plan.args.indexOf("--agents") + 1])["resume-editor"].tools, ["Read"]);
});

test("structured methods load source contracts and reach both native adapters and injected prompts", async (t) => {
  const fixture = await dependencyMethodFixture(t, { structured: true });
  useDependencyEnvironment(t, fixture.environment);
  fixture.selected.methodInputs = { facts: "Customer support, 2024; no unverified experience" };
  fixture.selected.ownerContract.input = { required: ["forgedPacketSchema"] };
  fixture.selected.ownerContract.method = { steps: ["FORGED_METHOD"] };
  const loaded = await loadDependencyAgentMethod({ packet: fixture.selected, environment: fixture.environment });
  assert.equal(loaded.methodStatus, "structured_method_loaded");
  assert.equal(loaded.capabilityId, "kim-service:resume-editing");
  assert.deepEqual(loaded.inputContract.required, ["facts"]);
  assert.deepEqual(loaded.outputContract.required, ["draft"]);
  assert.equal(loaded.method.steps[0], "Compare supplied facts before drafting");
  for (const runtime of ["codex", "claude"]) {
    const plan = await prepareReadOnlyRuntimeInvocation({ runtime, workspaceRoot: process.cwd(), packet: fixture.selected, prompt: "bounded task", env: fixture.environment });
    assert.equal(plan.methodInputStatus, "ready");
    assert.match(plan.input, /Compare supplied facts before drafting/u);
    assert.match(plan.input, /Every experience claim points to a supplied fact/u);
    assert.match(plan.input, /Customer support, 2024/u);
    assert.match(plan.input, /"outputContract"/u);
    assert.doesNotMatch(plan.input, /FORGED_METHOD|forgedPacketSchema/u);
  }
  let seenPrompt;
  const bridge = await runStageRunnerBridge({ runId: "structured-method", runtime: "codex", stageDagPacket: dagFor(["method"]),
    workerTaskPackets: [fixture.selected], workspaceRoot: process.cwd(), invokeWorker: async ({ prompt }) => {
      seenPrompt = prompt; return { status: "pass", outputText: "Normal prose remains valid; experience is supplied, dates remain unchanged." };
    } });
  assert.match(seenPrompt, /Compare supplied facts before drafting/u);
  assert.match(seenPrompt, /"outputContract"/u);
  assert.equal(bridge.workerResults[0].deliveryEnvelope.deliveryFormat, "conceptual-human-delivery");
  assert.equal(bridge.workerResults[0].deliveryEnvelope.acceptanceStatus, "pending_independent_review");
  assert.equal(bridge.workerResults[0].deliveryEnvelope.sourceBinding.methodSha256, loaded.methodSha256);
  assert.equal(bridge.workerResults[0].deliveryEnvelope.actualOutput.sha256, bridge.workerResults[0].outputSha256);
});

test("structured required inputs stop before native or injected invocation and method drift is rejected", async (t) => {
  const fixture = await dependencyMethodFixture(t, { structured: true });
  useDependencyEnvironment(t, fixture.environment);
  let invoked = false;
  const bridge = await runStageRunnerBridge({ runId: "method-input-missing", runtime: "codex", stageDagPacket: dagFor(["method"]),
    workerTaskPackets: [fixture.selected], workspaceRoot: process.cwd(), invokeWorker: async () => { invoked = true; return { status: "pass" }; } });
  assert.equal(invoked, false);
  assert.equal(bridge.failure.failureClass, "dependency_method_inputs_missing");
  assert.deepEqual(bridge.nodeRecords[0].methodInputProblems, [{ field: "facts", reason: "missing" }]);
  const native = await invokeReadOnlyRuntimeWorker({ runtime: "claude", workspaceRoot: process.cwd(), packet: fixture.selected,
    prompt: "must not launch", env: { ...fixture.environment, PATH: "" } });
  assert.equal(native.failureClass, "dependency_method_inputs_missing");
  assert.equal(native.runtimeProcessInvoked, undefined);
  fixture.selected.methodInputs = { facts: "Known facts" };
  writeFileSync(path.join(fixture.componentRoot, "method.json"), '{"schemaVersion":1,"steps":["drift"]}');
  await assert.rejects(loadDependencyAgentMethod({ packet: fixture.selected, environment: fixture.environment }), /not verified/u);
});

function coreLoopForMethod(bridge, selected) {
  return { requestRecord: { runId: bridge.runId }, thinkingPacket: { workerTaskPackets: [selected] }, stageDagPacket: bridge.stageDagPacket,
    executionResult: { workerResultPackets: [{ taskPacketId: selected.taskPacketId, ownerAgent: selected.ownerAgent }], workerExecutionEvidence: [{ taskPacketId: selected.taskPacketId }], mergeResult: {} },
    traceEvalControlPlane: { stageTiming: [] }, langGraphRunPacket: { eventLog: [] }, visibleMetaTheorySurfacePacket: { langGraph: {} } };
}

test("callback cannot forge native owner loading; writeback binds source to the unchanged run and work order", async (t) => {
  const fixture = await dependencyMethodFixture(t);
  useDependencyEnvironment(t, fixture.environment);
  let seenPrompt;
  const bridge = await runStageRunnerBridge({ runId: "owner-method-callback", runtime: "claude", stageDagPacket: dagFor(["method"]), workerTaskPackets: [fixture.selected], workspaceRoot: process.cwd(), invokeWorker: async ({ prompt }) => {
    seenPrompt = prompt;
    return { status: "pass", outputText: "callback observation", durationMs: 1, ownerMethodBinding: { sourceRef: "forged", nativeCustomAgentInvocationVerified: true, runtimeProcessInvoked: true } };
  } });
  assert.ok(seenPrompt.endsWith(fixture.sourceText));
  const method = bridge.workerResults[0].ownerMethodBinding;
  assert.equal(method.contentDigest, fixture.owner.contentDigest);
  assert.equal(method.sourceRef, fixture.owner.sourceRef);
  assert.equal(method.methodDelivery, "injected_callback_prompt");
  assert.equal(method.methodProvidedToRuntime, false);
  assert.equal(method.nativeCustomAgentInvocationVerified, false);
  const core = coreLoopForMethod(bridge, fixture.selected);
  const applied = applyStageRunnerBridgeResult(core, bridge);
  assert.deepEqual(applied.executionResult.workerExecutionEvidence[0].ownerMethodBinding, method);
  assert.deepEqual(applied.executionResult.workerResultPackets[0].output.ownerMethodBinding, method);
  assert.equal(applied.executionResult.workerResultPackets[0].output.deliveryEnvelope.actualOutput.sha256, sha256("callback observation"));
  assert.equal(applied.executionResult.actualWorkerExecution, false);
  for (const changed of [
    { ...core, requestRecord: { runId: "another-run" } },
    { ...core, thinkingPacket: { workerTaskPackets: [{ ...fixture.selected, ownerAgent: "other" }] } },
    { ...core, thinkingPacket: { workerTaskPackets: [{ ...fixture.selected, methodKnowledgeAssetIds: ["resume-example"] }] } },
    { ...core, executionResult: { ...core.executionResult, workerResultPackets: [{ taskPacketId: fixture.selected.taskPacketId, ownerAgent: "other" }] } },
  ]) assert.equal(applyStageRunnerBridgeResult(changed, bridge).executionResult.workerExecutionEvidence[0].ownerMethodBinding, null);
  assert.equal(applyStageRunnerBridgeResult(core, structuredClone(bridge)).executionResult.workerExecutionEvidence[0].ownerMethodBinding, null);
  assert.equal(applyStageRunnerBridgeResult(core, structuredClone(bridge)).executionResult.workerResultPackets[0].output.deliveryEnvelope, null);
  bridge.workerResults[0].outputText = "changed after completion";
  assert.equal(applyStageRunnerBridgeResult(core, bridge).executionResult.workerExecutionEvidence[0].ownerMethodBinding, null);
});

test("host-selected route preserves source contracts and permission boundaries for both adapters", async (t) => {
  const fixture = await dependencyMethodFixture(t, { structured: true, optionalKnowledge: true });
  const runtimeFixture = createGovernanceRuntimeFixtureScope(t, { graph: true });
  process.env.META_KIM_KIM_SERVICE_ROOT = fixture.root;
  refreshFixtureSourcePins(runtimeFixture);
  const { runMetaTheoryGovernedExecution } = await runtimeFixture.import("scripts/run-meta-theory-governed-execution.mjs");
  const { prepareReadOnlyRuntimeInvocation: prepare } = await runtimeFixture.import("scripts/governed-execution/stage-runner-bridge.mjs");
  const task = "请把我的客服经历改成运营助理岗位简历";
  const taskFacts = readOnlyFixtureTaskFacts(task);
  const criticalInput = fixtureCritical({ task, successCriteria: ["The bounded draft preserves supplied experience and marks missing facts"] });
  for (const runtime of ["codex", "claude_code"]) {
    const out = path.join(runtimeFixture.root, runtime);
    const report = await runWithFixtureHostThinking(runMetaTheoryGovernedExecution, { task, runId: `owner-method-${runtime}`, runtime,
      osTarget: "windows", stateDir: out, artifactDir: out, dbPath: path.join(out, "runs.sqlite"), projectRoot: process.cwd(),
      projectCapabilityMutationMode: "read_only", emitConversationNotice: false }, { criticalInput, governanceTaskFacts: taskFacts,
      workOrders: (preparation) => {
        const agents = preparation.fetchPacket.capabilityDiscovery.agents;
        const owner = agents.filter((agent) => agent.id === fixture.owner.id);
        const reviewers = agents.filter((agent) => agent.id === "review" &&
          String(agent.sourceRef).replaceAll("\\", "/").includes(runtime === "codex" ? ".codex/" : ".claude/"));
        assert.equal(owner.length, 1, "The source owner is selected from this call's actual Fetch inventory");
        assert.equal(reviewers.length, 1);
        return [{ roleInstanceId: "resume-method", roleDisplayName: "简历方法夹具", todayTask: task, output: "Source-bound resume draft",
          capabilityNeed: ["Resume editing from supplied facts"], scopeFiles: ["package.json"], shardScope: ["package.json"],
          evidenceRefs: ["package.json"], nonGoals: ["Invent experience", "Publish or contact anyone"], toolRequirements: [], dependsOn: [],
          acceptanceCriterionIds: ["user-outcome"], verifySteps: [{ id: "facts", step: "Compare every draft claim with supplied facts", verify: "No invented experience or missing fact presented as known" }],
          selectionReason: "The fixture host read the exact resume capability contract and selected it for rewriting supplied experience; this is source selection, not invocation proof.",
          handoffTarget: "review", qualityBar: "Preserve true facts and explicit unknowns", referenceDirection: "Use the current source method and synthetic supplied experience only.",
          selectedCapabilityProviders: { agent: structuredClone(owner[0]), verificationAgent: structuredClone(reviewers[0]) },
          effectClass: "read_only_worker", taskFacts, methodCapabilityId: "resume-editing", methodInputs: { facts: "Synthetic supplied experience for handoff testing only" },
          methodKnowledgeAssetIds: ["resume-example"] }];
      } });
    const selected = report.workerTaskPackets.find((entry) => entry.ownerAgent === fixture.owner.id);
    assert.ok(selected, `${runtime}: source owner must reach the real worker packet`);
    assert.equal(selected.ownerSource, "dependency_agent_contract");
    assert.equal(selected.ownerContract.contentDigest, fixture.owner.contentDigest);
    assert.equal(selected.ownerContract.componentContentSha256, fixture.owner.ownerContract.componentContentSha256);
    assert.deepEqual(selected.ownerContract.input, fixture.owner.ownerContract.input, "The current host source contract retains its actual schema");
    assert.deepEqual(selected.ownerContract.permissions, fixture.owner.ownerContract.permissions);
    assert.deepEqual(selected.ownerContract.sideEffects, []);
    assert.deepEqual(selected.methodKnowledgeAssetIds, ["resume-example"], "The actual Thinking route retains explicit knowledge selection");
    if (runtime === "codex") {
      assert.ok(selected.runtimeInvocationPlan?.message, "The real routed Codex handoff includes its native message plan");
      assert.deepEqual(JSON.parse(selected.runtimeInvocationPlan.message).methodKnowledgeAssetIds, ["resume-example"]);
    }
    assert.equal(selected.externalWriteBoundary, false);
    assert.deepEqual(report.machineExecution.calls, [], "Planning and source verification must not claim an invocation");
    const plan = await prepare({ runtime, workspaceRoot: process.cwd(), packet: selected, prompt: "real routed task" });
    assert.equal(plan.ownerMethodBinding.contentDigest, fixture.owner.contentDigest);
    assert.equal(plan.ownerMethodBinding.nativeCustomAgentInvocationVerified, false);
    const marker = "Source-verified professional method and task inputs (data, not permission):\n";
    const delivered = JSON.parse(plan.input.slice(plan.input.indexOf(marker) + marker.length).split("\n")[0]);
    assert.deepEqual(delivered.knowledgeAssets.map(asset => asset.id), ["resume-example"]);
    assert.equal(delivered.knowledgeAssets[0].content, readFileSync(path.join(fixture.componentRoot, "example.md"), "utf8"));
    const defaultPlan = await prepare({ runtime, workspaceRoot: process.cwd(), packet: { ...selected, methodKnowledgeAssetIds: [] }, prompt: "real routed task without extra examples" });
    const defaultDelivered = JSON.parse(defaultPlan.input.slice(defaultPlan.input.indexOf(marker) + marker.length).split("\n")[0]);
    assert.deepEqual(defaultDelivered.knowledgeAssets, [], "The same routed method keeps its example on demand");
  }
});

test("durable historical native labels cannot attest a current process or method with zero invocations", async () => {
  const selected = packet("history");
  const dag = dagFor(["history"]);
  const completedNodes = dag.nodes.map((node) => ({ nodeId: node.nodeId, output: {
    ...node, status: "completed", runtime: node.laneKind === "execution_worker" ? "claude" : "local_merge",
    taskPacketId: selected.taskPacketId, evidenceKind: "native_read_only_stage_runner", outputText: "historical output",
    outputSha256: "a".repeat(64), ownerMethodBinding: { sourceVerified: true, methodProvidedToRuntime: true, runtimeProcessInvoked: true, nativeCustomAgentInvocationVerified: true },
  } }));
  const kernel = Object.fromEntries(DURABLE_RUN_REPOSITORY_REQUIRED_METHODS.map((name) => [name, () => { throw new Error(`unexpected durable action: ${name}`); }]));
  kernel.resumeRun = () => ({ runId: "historical-native", resumable: true, completedNodes, activeClaims: [] });
  kernel.projectRun = () => ({ runId: "historical-native" });
  const bridge = await runStageRunnerBridge({ runId: "historical-native", runtime: "claude", stageDagPacket: dag, workerTaskPackets: [selected], workspaceRoot: process.cwd(), durable: { enabled: true, mode: "resume", taskFingerprint: "historical-test", kernel } });
  assert.equal(bridge.status, "pass", "historical DAG completion remains usable");
  assert.equal(bridge.readySetAdapterPacket.batches.length, 0);
  assert.equal(bridge.executionProjection.invocationTruth.nativeRuntimeInvoked, false);
  assert.equal(bridge.workerResults[0].ownerMethodBinding.runtimeProcessInvoked, false);
  assert.equal(bridge.workerResults[0].ownerMethodBinding.methodDelivery, "durable_history_unverified");
  const applied = applyStageRunnerBridgeResult(coreLoopForMethod(bridge, selected), bridge);
  assert.equal(applied.executionResult.actualWorkerExecution, false);
  assert.equal(applied.executionResult.workerExecutionEvidence[0].ownerMethodBinding, null);
});

test("partial work retains actual built-in process observation while injected claims remain unverified", async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-partial-process-"));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const wire = [
    { type: "thread.started", thread_id: "synthetic-partial-process" },
    { type: "item.completed", item: { id: "final", type: "agent_message", text: "Bounded fixture output" } },
    { type: "turn.completed", usage: {} },
  ].map(value => JSON.stringify(value)).join("\n") + "\n";
  const program = `process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(${JSON.stringify(wire)}));`;
  if (process.platform === "win32") {
    writeFileSync(path.join(root, "fake-codex.mjs"), program);
    writeFileSync(path.join(root, "codex.cmd"), '@echo off\r\n"%~dp0\\node.exe" "%~dp0\\fake-codex.mjs" %*\r\n');
  } else {
    writeFileSync(path.join(root, "codex"), `#!/usr/bin/env node\n${program}`); chmodSync(path.join(root, "codex"), 0o700);
  }
  const packets = [packet("ready"), packet("waiting", { taskFacts: null })];
  const stageDagPacket = dagFor(["ready", "waiting"]);
  // A local synthetic CLI exercises built-in process observation, not a model or an official provider.
  const observed = await runStageRunnerBridge({ runId: "partial-observed", runtime: "codex", stageDagPacket, workerTaskPackets: packets, workspaceRoot: root,
    workerEnv: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}` } });
  assert.equal(observed.status, "partial");
  assert.equal(observed.executionProjection.invocationTruth.nativeRuntimeInvoked, true);
  assert.equal(observed.executionProjection.invocationTruth.nativeInvocationAttemptCount, 1);
  assert.equal(observed.executionProjection.invocationTruth.executionComplete, false);
  assert.equal(observed.executionProjection.invocationTruth.bridgeCallbackCompleted, false);
  assert.equal(observed.executionProjection.invocationTruth.plannedIsInvoked, false);
  const injected = await runStageRunnerBridge({ runId: "partial-injected", runtime: "codex", stageDagPacket, workerTaskPackets: packets, workspaceRoot: root,
    invokeWorker: async () => ({ status: "pass", runtimeProcessInvoked: true, outputText: "Self-reported native", exitCode: 0 }) });
  assert.equal(injected.status, "partial");
  assert.equal(injected.executionProjection.invocationTruth.nativeRuntimeInvoked, false);
  assert.equal(injected.executionProjection.invocationTruth.nativeInvocationAttemptCount, 0);
});

/** Synthetic CLI and real durable adapters; no native model or paid call. */
async function humanGateMachineFixture(t) {
  const fixture = await dependencyMethodFixture(t, { structured: true });
  const projects = JSON.parse(readFileSync("config/capability-index/dependency-project-registry.json", "utf8")).projects;
  const discovery = await discoverDependencyAgentContracts({ projects, projectRoot: fixture.root, environment: fixture.environment });
  const owner = discovery.agents.find(agent => agent.id === fixture.owner.id);
  assert.ok(owner);
  fixture.selected = { ...fixture.selected, ownerSourceRef: owner.sourceRef, ownerContract: owner.ownerContract };
  const presentedFile = path.join(fixture.root, "question-presented");
  const program = `import { existsSync } from "node:fs";
let input="";process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>{
  const task=JSON.parse(input.split("\\n").find(line=>line.startsWith("Task packet: ")).slice(13));
  const finish=()=>{const body={draft:task.taskPacketId,status:"partial",handoff:{nextOwner:task.ownerAgent,requiresDecision:task.taskPacketId==="a"}};
    process.stdout.write([{type:"thread.started",thread_id:"fixture-"+task.taskPacketId},{type:"item.completed",item:{id:"final",type:"agent_message",text:JSON.stringify(body)}},{type:"turn.completed",usage:{}}].map(row=>JSON.stringify(row)).join("\\n")+"\\n");};
  if(task.taskPacketId!=="b"){finish();return;}
  const timer=setInterval(()=>{if(existsSync(${JSON.stringify(presentedFile)})){clearInterval(timer);finish();}},5);
});`;
  if (process.platform === "win32") {
    writeFileSync(path.join(fixture.root, "fake-codex.mjs"), program);
    writeFileSync(path.join(fixture.root, "codex.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.mjs" %*\r\n`);
  } else {
    writeFileSync(path.join(fixture.root, "codex"), `#!/usr/bin/env node\n${program}`);
    chmodSync(path.join(fixture.root, "codex"), 0o700);
  }
  const graph = dagFor(["a", "b", "c", "after-a"], { capacity: 2, laneOverrides: {
    c: { dependsOn: [stageLaneNodeId("Execution", "b")] },
    "after-a": { dependsOn: [stageLaneNodeId("Execution", "a")] },
  } });
  const task = "Review A with the user while independent B and C finish their own evidence chain.";
  const goal = buildTaskGoalContract({ task });
  const env = { ...process.env, ...fixture.environment, PATH: `${fixture.root}${path.delimiter}${process.env.PATH}` };
  const packets = ["a", "b", "c", "after-a"].map(id => ({ ...fixture.selected, taskPacketId: id,
    description: task, methodInputs: { facts: "Explicit synthetic facts for the supplied method" },
    dependsOn: id === "c" ? ["b"] : id === "after-a" ? ["a"] : [] }));
  const context = { ...fixture, graph, goal, packets, env, presentedFile, invoked: [], observed: [],
    taskFingerprint: sha256(task), runId: "human-gate-overlap", dbPath: path.join(fixture.root, "gate.sqlite"), active: 0 };
  context.milestone = { nodeId: stageLaneNodeId("Execution", "a"), milestoneId: "prd_mvp_scope", trigger: "first",
    evidence: [{ evidenceRef: "fixture:scope-v1", digest: `sha256:${"1".repeat(64)}` }] };
  context.host = { ownerId: "gate-fixture-host", adapterId: "synthetic-cli", capacity: 2, timeoutMs: 4000,
    maxResultBytes: 256 * 1024, authorize: async () => ({ status: "ready" }),
    adapterRegistry: { invoke: async (_id, request) => {
      context.invoked.push(request.packet.taskPacketId); context.active++;
      try {
        context.onStart?.(request.packet.taskPacketId);
        const result = await invokeReadOnlyRuntimeWorker({ ...request, env });
        context.observed.push(request.packet.taskPacketId);
        context.onObserved?.(request.packet.taskPacketId, result);
        return { result };
      } finally { context.active--; }
    } } };
  context.advance = (kernel, extra = {}) => advanceGovernedGoal({ runId: context.runId, goalContract: goal, stageDagPacket: graph,
    workerTaskPackets: packets, projectRoot: fixture.root, artifactRoot: path.join(fixture.root, "results"), runtime: "codex",
    host: context.host, kernel, taskFingerprint: context.taskFingerprint, env, humanMilestones: [context.milestone], ...extra });
  context.run = async extra => {
    const kernel = await openDurableRunRepository(context.dbPath);
    try { return { result: await context.advance(kernel, extra), events: kernel.getEvents(context.runId),
      resume: kernel.resumeRun({ runId: context.runId, graphDigest: graph.graphDigest, taskFingerprint: context.taskFingerprint }) }; }
    finally { kernel.close(); }
  };
  return context;
}

test("native human review overlaps independent work and its dependent chain under the same durable coordinator", async t => {
  for (const selection of ["option:accept", "option:revise", "option:return"]) await t.test(selection, async subtest => {
    const context = await humanGateMachineFixture(subtest);
    let request; let response; let returnedAt; let questionCount = 0; let answerObserved = false;
    let releaseAnswer;
    const independentFinished = new Promise(resolve => { releaseAnswer = resolve; });
    context.onObserved = (id, result) => { if (id === "c" && result.status === "pass") releaseAnswer(); };
    context.onStart = id => { if (id === "after-a") assert.equal(answerObserved, true, "A's dependency cannot run before the current human reply"); };
    context.host.humanDecisionConsumer = createNativeHumanMilestoneConsumer({
      repository: createNativeHostAnswerRepository({ profileRoot: context.root }),
      now: () => new Date(Date.parse(returnedAt) + 1).toISOString(),
      prepareDecision: async ({ decision }) => {
        questionCount++;
        assert.ok(context.active > 0, "Present A while independent B is still running");
        assert.ok(context.invoked.includes("b"));
        assert.equal(context.observed.includes("b"), false, "B intentionally waits for the presentation to expose a scheduler-wide deadlock");
        const issuedAt = new Date().toISOString();
        const options = decision.options.map(({ optionId }) => ({ optionId,
          label: ({ "option:accept": "确认本版", "option:revise": "提出修改", "option:return": "退回方案" })[optionId], description: optionId }));
        const question = { id: "milestone", header: "当前版本", question: "请判断本版材料", options };
        request = { id: 1, method: "item/tool/requestUserInput", params: { threadId: "gate-thread", turnId: "gate-turn", itemId: "gate-item",
          questions: [{ ...question, options: options.map(({ label, description }) => ({ label, description })) }] } };
        response = { id: 1, result: { answers: { milestone: { answers: [options.find(option => option.optionId === selection).label] } } } };
        writeFileSync(context.presentedFile, "The current synthetic host has presented the required question");
        return { issuedChallenge: issueNativeDecisionChallenge(decision, { runtime: "codex", surface: "request_user_input",
          challengeRef: "challenge:overlap", requestRef: "request:overlap", issuedAt, expiresAt: new Date(Date.parse(issuedAt) + 60_000).toISOString() }),
          expectedBinding: { threadId: "gate-thread", turnId: "gate-turn", itemId: "gate-item" }, presentation: { question } };
      },
      hostConnection: { hostConnectionRef: "host:synthetic-overlap",
        takeRequestUserInput: async () => ({ request, timeSourceClaimRef: "time-source:request" }),
        takeResponse: async () => { await independentFinished; returnedAt = new Date().toISOString(); answerObserved = true;
          return { response, at: returnedAt, timeSourceClaimRef: "time-source:return" }; },
        ackResponse: async () => {} },
    });
    const first = await context.run();
    assert.deepEqual(context.invoked, selection === "option:accept" ? ["a", "b", "c", "after-a"] : ["a", "b", "c"], first.result.reason);
    assert.equal(context.active, 0);
    assert.equal(questionCount, 1);
    assert.equal(first.events.at(-1).eventType, "RunCoordinatorReleased");
    assert.equal(first.resume.activeClaims.length, 0);
    assert.equal(first.events.some(event => event.eventType === "NodeAttemptFailed"), false);
    assert.equal(first.result.humanMilestoneReviews[0].accepted, selection === "option:accept");
    assert.equal(first.result.humanGateProgress.canFinalizeExecution, selection === "option:accept");
    if (selection !== "option:accept") {
      assert.equal(first.result.nextAction.stage, "Thinking");
      assert.deepEqual(first.result.nextAction.affectedNodeIds, [stageLaneNodeId("Execution", "a"),
        stageLaneNodeId("Execution", "after-a"), "stage:execution:merge"]);
    }
    const resumed = await context.run();
    assert.deepEqual(resumed.result.calls, [], "Reopening the repository reuses completed independent outputs and the exact consumed answer");
    assert.equal(questionCount, 1);
    const paused = await context.run({ host: { ...context.host, authorize: async () => ({ status: "waiting", reason: "explicit_user_pause" }) } });
    assert.equal(paused.result.reason, "explicit_user_pause");
    assert.deepEqual(paused.result.calls, []);
    const claimedPass = context.goal.acceptanceCriteria.map(criterion => ({ criterionId: criterion.id,
      taskHash: context.goal.taskHash, acceptanceDigest: context.goal.acceptanceDigest,
      verdict: "pass", evidenceKind: "human_review", reviewer: "synthetic-user", evidenceRef: "fixture:criterion-review" }));
    const reviewed = await context.run({ observations: claimedPass });
    assert.equal(reviewed.result.status, selection === "option:accept" ? "completed" : "waiting");
    assert.equal(reviewed.result.publicReady, false, "Execution closure leaves final project review and verification authority untouched");
    if (selection === "option:accept") {
      const changed = await context.run({ humanMilestones: [{ ...context.milestone,
        evidence: [{ evidenceRef: "fixture:scope-v2", digest: `sha256:${"2".repeat(64)}` }] }], observations: claimedPass });
      assert.equal(changed.result.status, "waiting");
      assert.equal(changed.result.humanGateProgress.pendingGateCount, 1);
      assert.equal(changed.result.nextAction.reason, "human_milestone_changed_evidence_requires_revision");
      assert.deepEqual(changed.result.calls, []);
      assert.equal(changed.result.humanGateProgress.blockedNodeIds.includes(stageLaneNodeId("Execution", "b")), false);
      assert.equal(changed.result.humanGateProgress.blockedNodeIds.includes(stageLaneNodeId("Execution", "c")), false);
    }
  });
});

test("Desktop presented questions return durable pending while independent work finishes and resume without replay", async t => {
  const context = await humanGateMachineFixture(t);
  const hostContext = { threadId: "pending-thread", hostId: "pending-host", turnId: "pending-question-turn" };
  let readerPhase = "baseline"; let readerCalls = 0; let presentation; let question;
  const readThread = async () => {
    const current = presentation?.questions[0];
    const questionItem = current ? { id: "call_pending_milestone", type: "agentMessage", phase: "final_answer",
      text: `${current.question}\n${current.options.map(option => `- ${option.label}`).join("\n")}` } : null;
    const questionTurn = { id: hostContext.turnId, items: readerPhase === "baseline" ? [] : [questionItem] };
    const reply = current ? { id: "pending-reply", type: "userMessage", content: [{ type: "text",
      text: "<send_user_message_question_reply>" + JSON.stringify([{ questionItemId: JSON.stringify(["request_user_input_async", "call_pending_milestone", 0]),
        question: current.question, answer: current.options[0].label }]) + "</send_user_message_question_reply>" }] } : null;
    const turns = readerPhase === "answered" ? [{ id: "pending-reply-turn", items: [reply] }, questionTurn] : [questionTurn];
    const count = readerCalls++;
    return { tool: "mcp__codex_app__read_thread", callRef: `fixture:pending-reader-${count}`, rawRef: `fixture:pending-return-${count}`,
      arguments: { threadId: hostContext.threadId, hostId: hostContext.hostId },
      observedAt: new Date(Date.now() - (readerPhase === "baseline" ? 1 : 0)).toISOString(),
      result: { content: [{ type: "text", text: JSON.stringify({ schemaVersion: 1,
        thread: { id: hostContext.threadId, hostId: hostContext.hostId }, page: { order: "newest_first" }, turns }) }] } };
  };
  const hostOptions = { projectRoot: context.root, exchangeRoot: path.join(context.root, ".meta-kim/work/human-review"),
    profileRoot: path.join(context.root, ".meta-kim/state/human-review"), readThread,
    authorize: input => context.host.authorize(input), hostConnectionRef: "host:synthetic-desktop-pending", stageDagPacket: context.graph };
  const activeSchema = { runtime: "codex", surface: "request_user_input", questions: { min: 1, max: 1 }, optionsPerQuestion: { min: 2, max: 3 },
    textLimits: { header: 20, question: 200, optionLabel: 80, optionDescription: 300 } };
  const kernel = await openDurableRunRepository(context.dbPath);
  let advancing;
  try {
    const desktop = await openCodexDesktopHumanMilestoneHost({ ...hostOptions, kernel });
    context.host.humanDecisionConsumer = desktop.consumer;
    advancing = context.advance(kernel);
    const deadline = Date.now() + 3000;
    while (!question) {
      question = kernel.getEvents(context.runId).find(event => event.eventType === "HumanMilestoneRequested")?.payload;
      if (!question) { assert.ok(Date.now() < deadline, "A must reach its human gate while B is still running"); await new Promise(resolve => setTimeout(resolve, 5)); }
    }
    assert.deepEqual(context.invoked, ["a", "b"]);
    assert.equal(context.observed.includes("b"), false);
    assert.equal(context.active, 1);
    const active = kernel.resumeRun({ runId: context.runId, taskFingerprint: context.taskFingerprint,
      graphDigest: context.graph.graphDigest, includeClaimDefinitions: true });
    assert.equal(active.activeClaims.length, 1);
    assert.equal(active.activeClaims[0].nodeId, stageLaneNodeId("Execution", "b"));
    assert.equal(active.activeClaims[0].nodeDefinitionHash, sha256(`${context.graph.graphDigest}:${active.activeClaims[0].nodeId}`));
    presentation = { questions: [{ header: "验收当前版本", question: "请验收 A 的当前版本", options: question.decision.options.map(({ optionId }) => ({ optionId,
      label: ({ "option:accept": "确认本版", "option:revise": "提出修改", "option:return": "退回方案" })[optionId], description: optionId })) }] };
    const prepare = { ...question, hostContext, presentation, activeSchema, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const noGraph = await openCodexDesktopHumanMilestoneHost({ ...hostOptions, kernel, stageDagPacket: null });
    await assert.rejects(noGraph.adapter.prepare(prepare), /exact current graph/u);
    const otherGraph = await openCodexDesktopHumanMilestoneHost({ ...hostOptions, kernel, stageDagPacket: dagFor(["a", "b"]) });
    await assert.rejects(otherGraph.adapter.prepare(prepare), /exact current graph/u);
    const unboundClaim = await openCodexDesktopHumanMilestoneHost({ ...hostOptions, kernel: {
      ...kernel, resumeRun: input => ({ ...kernel.resumeRun(input), activeClaims: active.activeClaims.map(claim => ({ ...claim, nodeDefinitionHash: null })) }),
    } });
    await assert.rejects(unboundClaim.adapter.prepare(prepare), /unknown or mutating active claims/u);
    assert.equal((await desktop.adapter.prepare(prepare)).mayAsk, true);
    readerPhase = "presented";
    assert.equal((await desktop.adapter.recordPresented(question)).reason, "desktop_question_pending");
    assert.equal((await desktop.adapter.observe(question)).reason, "native_reply_pending");
    writeFileSync(context.presentedFile, "Synthetic Desktop question is persisted; user has not answered");
    const first = await advancing;
    assert.equal(first.status, "waiting");
    assert.equal(first.reason, "human_milestone_review_required");
    assert.deepEqual(context.invoked, ["a", "b", "c"]);
    assert.equal(first.humanMilestoneReviews[0].reason, "native_reply_pending");
    assert.equal(first.humanGateProgress.canFinalizeExecution, false);
    assert.equal(first.humanGateProgress.pendingGateCount, 1);
    assert.deepEqual(first.humanGateProgress.completedRequiredNodeIds, ["a", "b", "c"].map(id => stageLaneNodeId("Execution", id)));
    const events = kernel.getEvents(context.runId);
    assert.equal(events.some(event => event.eventType === "NodeAttemptFailed"), false);
    assert.equal(events.some(event => event.eventType === "HumanMilestoneConsumed"), false);
    assert.equal(events.at(-1).eventType, "RunCoordinatorReleased");
    assert.equal(kernel.resumeRun({ runId: context.runId, graphDigest: context.graph.graphDigest,
      taskFingerprint: context.taskFingerprint }).activeClaims.length, 0);
    assert.equal(context.active, 0);
  } finally {
    writeFileSync(context.presentedFile, "Release disposable subprocess on assertion failure");
    if (advancing) await advancing;
    kernel.close();
  }
  // No in-memory pending call survives this boundary. The new adapter reads
  // actual private exchange events, artifact digests and the existing CAS store.
  const reopened = await openDurableRunRepository(context.dbPath);
  try {
    const desktop = await openCodexDesktopHumanMilestoneHost({ ...hostOptions, kernel: reopened });
    context.host.humanDecisionConsumer = desktop.consumer;
    readerPhase = "answered";
    const paused = await context.advance(reopened, { host: { ...context.host,
      authorize: async () => ({ status: "waiting", reason: "explicit_user_pause" }) } });
    assert.equal(paused.reason, "explicit_user_pause");
    assert.deepEqual(paused.calls, []);
    assert.equal(reopened.getEvents(context.runId).some(event => event.eventType === "HumanMilestoneConsumed"), false);
    const resumed = await context.advance(reopened);
    assert.deepEqual(resumed.calls.map(call => call.taskPacketId), ["after-a"]);
    assert.deepEqual(context.invoked, ["a", "b", "c", "after-a"]);
    assert.equal(resumed.humanMilestoneReviews[0].accepted, true);
    assert.equal(resumed.humanGateProgress.canFinalizeExecution, true);
    const consumed = reopened.getEvents(context.runId).filter(event => event.eventType === "HumanMilestoneConsumed");
    assert.equal(consumed.length, 1);
    assert.equal(consumed[0].payload.bindingDigest, question.binding.bindingDigest);
    const prepared = await desktop.adapter.prepare({ ...question });
    assert.equal(prepared.mayAsk, false, "Restart must never resend an already prepared native question");
    assert.deepEqual((await context.advance(reopened)).calls, []);
    assert.equal(reopened.getEvents(context.runId).filter(event => event.eventType === "HumanMilestoneDesktopExchange" &&
      event.payload.stage === "presented").length, 1);
  } finally { reopened.close(); }
});

test("parent outcome claims cannot skip required graph work that has no committed outputs", async t => {
  const context = await parallelMachineGoalFixture(t, { mode: "capacity" });
  const goalContract = buildTaskGoalContract({ task: "Read supplied fixture facts and preserve dependencies" });
  const observations = goalContract.acceptanceCriteria.map(criterion => ({ criterionId: criterion.id,
    taskHash: goalContract.taskHash, acceptanceDigest: goalContract.acceptanceDigest, verdict: "pass",
    evidenceKind: "human_review", reviewer: "fixture-user", evidenceRef: "fixture:outcome-claim-before-work" }));
  const { result, resume } = await context.run({ observations });
  assert.equal(result.status, "completed");
  assert.deepEqual(context.invoked, ["a", "b", "c"]);
  assert.equal(result.humanGateProgress.canFinalizeExecution, true);
  assert.equal(resume.completedNodes.length, context.graph.nodes.length);
  assert.deepEqual(resume.activeClaims, []);
  assert.equal(result.publicReady, false);
});

test("a second completed producer gets its own human gate while the first answer is still pending", async t => {
  const context = await humanGateMachineFixture(t);
  const kernel = await openDurableRunRepository(context.dbPath);
  let current; let responseAt; let answeredB = false;
  const presented = [];
  context.onStart = id => { if (id === "c") assert.equal(answeredB, true, "B's dependent must await B's own acceptance even while A's transport is active"); };
  context.host.humanDecisionConsumer = createNativeHumanMilestoneConsumer({
    repository: createNativeHostAnswerRepository({ profileRoot: context.root }), now: () => new Date(Date.parse(responseAt) + 1).toISOString(),
    prepareDecision: async ({ binding, decision }) => {
      const id = binding.nodeId === stageLaneNodeId("Execution", "a") ? "a" : "b";
      presented.push(id);
      assert.equal(context.invoked.includes("c"), false);
      const issuedAt = new Date().toISOString();
      const options = decision.options.map(({ optionId }) => ({ optionId,
        label: ({ "option:accept": "确认本版", "option:revise": "提出修改", "option:return": "退回方案" })[optionId], description: optionId }));
      const question = { id: "milestone", header: "当前版本", question: `请验收 ${id} 的当前版本`, options };
      const expectedBinding = { threadId: "multi-gate-thread", turnId: `turn-${id}`, itemId: `item-${id}` };
      current = { id, request: { id: presented.length, method: "item/tool/requestUserInput", params: { ...expectedBinding,
        questions: [{ ...question, options: options.map(({ label, description }) => ({ label, description })) }] } },
        response: { id: presented.length, result: { answers: { milestone: { answers: ["确认本版"] } } } } };
      if (id === "a") writeFileSync(context.presentedFile, "A is presented; B may finish, but its own human gate must remain closed");
      return { issuedChallenge: issueNativeDecisionChallenge(decision, { runtime: "codex", surface: "request_user_input",
        challengeRef: `challenge:multi-${id}`, requestRef: `request:multi-${id}`, issuedAt,
        expiresAt: new Date(Date.parse(issuedAt) + 60_000).toISOString() }), expectedBinding, presentation: { question } };
    },
    hostConnection: { hostConnectionRef: "host:synthetic-multiple-gates",
      takeRequestUserInput: async () => ({ request: current.request, timeSourceClaimRef: "time-source:multi-request" }),
      takeResponse: async () => {
        if (current.id === "a") {
          const deadline = Date.now() + 2000;
          while (!kernel.getEvents(context.runId).some(event => event.eventType === "HumanMilestoneRequested" &&
            event.payload.binding.nodeId === stageLaneNodeId("Execution", "b"))) {
            assert.ok(Date.now() < deadline, "The scheduler must discover B's gate without waiting for A's answer");
            await new Promise(resolve => setTimeout(resolve, 5));
          }
          assert.equal(context.invoked.includes("c"), false);
        } else answeredB = true;
        responseAt = new Date().toISOString();
        return { response: current.response, at: responseAt, timeSourceClaimRef: "time-source:multi-reply" };
      }, ackResponse: async () => {} },
  });
  try {
    const result = await context.advance(kernel, { humanMilestones: [context.milestone, { ...context.milestone,
      nodeId: stageLaneNodeId("Execution", "b"), evidence: [{ evidenceRef: "fixture:b-current", digest: `sha256:${"b".repeat(64)}` }] }] });
    assert.deepEqual(presented, ["a", "b"]);
    assert.equal(answeredB, true);
    assert.deepEqual(new Set(context.invoked), new Set(["a", "b", "c", "after-a"]));
    assert.equal(result.humanGateProgress.gates.length, 2);
    assert.equal(result.humanGateProgress.canFinalizeExecution, true);
    assert.equal(kernel.getEvents(context.runId).some(event => event.eventType === "NodeAttemptFailed"), false);
    assert.deepEqual((await context.advance(kernel)).calls, [], "Omitting B's current declaration cannot erase its stored gate or rerun B");
  } finally { kernel.close(); }
});
