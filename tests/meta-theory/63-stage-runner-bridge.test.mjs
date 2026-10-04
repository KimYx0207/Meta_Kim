import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyStageRunnerBridgeResult,
  buildRuntimeChildEnv,
  buildReadOnlyWorkerPrompt,
  invokeReadOnlyRuntimeWorker,
  prepareReadOnlyRuntimeInvocation,
  runStageRunnerBridge,
} from "../../scripts/governed-execution/stage-runner-bridge.mjs";
import {
  buildStageDagPacket,
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
  return {
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
  assert.ok(text.includes(`${root}.hidden`), "a dot-suffixed sibling is not the declared root");
  assert.ok(text.includes(`${root}-backup`), "a sibling is not the declared workspace root");
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

async function dependencyMethodFixture(t) {
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

function useDependencyEnvironment(t, environment) {
  const original = process.env.META_KIM_KIM_SERVICE_ROOT;
  process.env.META_KIM_KIM_SERVICE_ROOT = environment.META_KIM_KIM_SERVICE_ROOT;
  t.after(() => original === undefined ? delete process.env.META_KIM_KIM_SERVICE_ROOT : process.env.META_KIM_KIM_SERVICE_ROOT = original);
}

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
      assert.equal(plan.input, "bounded task");
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
  assert.equal(applied.executionResult.actualWorkerExecution, false);
  for (const changed of [
    { ...core, requestRecord: { runId: "another-run" } },
    { ...core, thinkingPacket: { workerTaskPackets: [{ ...fixture.selected, ownerAgent: "other" }] } },
    { ...core, executionResult: { ...core.executionResult, workerResultPackets: [{ taskPacketId: fixture.selected.taskPacketId, ownerAgent: "other" }] } },
  ]) assert.equal(applyStageRunnerBridgeResult(changed, bridge).executionResult.workerExecutionEvidence[0].ownerMethodBinding, null);
  assert.equal(applyStageRunnerBridgeResult(core, structuredClone(bridge)).executionResult.workerExecutionEvidence[0].ownerMethodBinding, null);
  bridge.workerResults[0].outputText = "changed after completion";
  assert.equal(applyStageRunnerBridgeResult(core, bridge).executionResult.workerExecutionEvidence[0].ownerMethodBinding, null);
});

test("real compact route and governed packet retain immutable owner binding for both adapters despite prose redaction", async (t) => {
  const fixture = await dependencyMethodFixture(t);
  const runtimeFixture = createGovernanceRuntimeFixtureScope(t, { graph: true });
  process.env.META_KIM_KIM_SERVICE_ROOT = fixture.root;
  const { runMetaTheoryGovernedExecution } = await runtimeFixture.import("scripts/run-meta-theory-governed-execution.mjs");
  const { prepareReadOnlyRuntimeInvocation: prepare } = await runtimeFixture.import("scripts/governed-execution/stage-runner-bridge.mjs");
  for (const runtime of ["codex", "claude_code"]) {
    const out = path.join(runtimeFixture.root, runtime);
    const report = await runMetaTheoryGovernedExecution({ task: "请把我的客服经历改成运营助理岗位简历", runId: `owner-method-${runtime}`, runtime, osTarget: "windows", stateDir: out, artifactDir: out, dbPath: path.join(out, "runs.sqlite"), projectRoot: process.cwd(), projectCapabilityMutationMode: "read_only", emitConversationNotice: false });
    const selected = report.workerTaskPackets.find((entry) => entry.ownerAgent === fixture.owner.id);
    assert.ok(selected, `${runtime}: source owner must reach the real worker packet`);
    assert.equal(selected.ownerSource, "dependency_agent_contract");
    assert.equal(selected.ownerContract.contentDigest, fixture.owner.contentDigest);
    assert.equal(selected.ownerContract.componentContentSha256, fixture.owner.ownerContract.componentContentSha256);
    assert.equal(selected.ownerContract.input.properties.path, undefined, "existing route publication still removes path metadata");
    const plan = await prepare({ runtime, workspaceRoot: process.cwd(), packet: selected, prompt: "real routed task" });
    assert.equal(plan.ownerMethodBinding.contentDigest, fixture.owner.contentDigest);
    assert.equal(plan.ownerMethodBinding.nativeCustomAgentInvocationVerified, false);
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
