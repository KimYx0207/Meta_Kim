import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs, realpathSync, readFileSync } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

let openDurableRunKernel;
let runMetaTheoryGovernedExecution;

const execFileAsync = promisify(execFile);
let ENTRY;
const TASK = "Run meta-theory: inspect package.json and produce a durable verification report of the exact package name and version. Do not modify files.";

let runtimeFixture;
before(async () => {
  runtimeFixture = createGovernanceRuntimeFixtureScope(null, { graph: true });
  const pins = runtimeFixture.run(["scripts/refresh-runtime-evidence-pins.mjs"]);
  assert.equal(pins.status, 0, pins.stderr || pins.stdout);
  ({ runMetaTheoryGovernedExecution } = await runtimeFixture.import("scripts/run-meta-theory-governed-execution.mjs"));
  ({ openDurableRunKernel } = await runtimeFixture.import("scripts/governed-execution/durable-run-kernel.mjs"));
  ENTRY = path.resolve("scripts/run-meta-theory-governed-execution.mjs");
});
after(() => runtimeFixture?.cleanup());


async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-p118-entry-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function workerCounter(counter) {
  return async ({ runtime, packet }) => {
    counter.count += 1;
    return {
      status: "pass",
      runtime,
      exitCode: 0,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 2,
      sessionId: `session-${packet.taskPacketId}`,
      messageId: `message-${packet.taskPacketId}`,
      outputText: "meta-kim 2.9.0",
      outputSha256: "a".repeat(64),
      rawOutputSha256: "b".repeat(64),
      hostEventCount: 1,
      toolEventCount: 1,
      stderrTail: "",
    };
  };
}

test("67 — active paired resume consumes and preserves scope-bound outcome revisions", async (t) => {
  const root = await tempRoot(t);
  const projectRoot = process.cwd();
  const runId = "outcome-revision-public-active";
  const sourceRoot = path.join(root, "service");
  const componentPath = "agents/report-reviewer";
  const componentRoot = path.join(sourceRoot, componentPath);
  const { componentHash, stableJson, sha256, discoverDependencyAgentContracts } = await runtimeFixture.import("scripts/dependency-agent-discovery.mjs");
  const { buildTaskGoalContract, taskOutcomeDigest } = await runtimeFixture.import("src/domain/governance/task-outcome.mjs");
  const { intentDialogueDigest } = await runtimeFixture.import("scripts/governed-execution/intent-dialogue.mjs");
  const { stageLaneNodeId } = await runtimeFixture.import("scripts/governed-execution/stage-dag.mjs");
  const { invokeReadOnlyRuntimeWorker } = await runtimeFixture.import("scripts/governed-execution/stage-runner-bridge.mjs");
  const { resolveCliInvocation } = await runtimeFixture.import("scripts/runtime-cli-invocation.mjs");
  await fs.mkdir(componentRoot, { recursive: true });
  const capability = { id: "report-review", summary: "Read-only PRD report review against current facts", useWhen: ["Review the supplied PRD report"], doNotUseWhen: ["Implement or deploy"],
    input: { type: "object", required: ["facts"], properties: { facts: { type: "string" } } },
    output: { type: "object", required: ["draft"], properties: { draft: { type: "string" } } },
    permissions: ["filesystem:read-user-materials"], sideEffects: [], humanGate: { required: false, when: [] }, validation: ["check.mjs"] };
  const contract = { schemaVersion: 1, id: "report-reviewer", componentType: "agent", componentVersion: "0.1.0", entrypoint: "AGENT.md", capabilities: [capability] };
  await fs.writeFile(path.join(componentRoot, "AGENT.md"), "---\nname: report-reviewer\ndescription: Read-only PRD report review\ntools: Read\n---\nCompare current supplied facts. Do not edit files, implement or deploy. Discovery fixture only.\n");
  await fs.writeFile(path.join(componentRoot, "capability.json"), stableJson(contract));
  await fs.writeFile(path.join(componentRoot, "method.json"), stableJson({ schemaVersion: 1, roleId: "report-reviewer", protocol: "host-bound-task-method-v1",
    steps: ["Read the supplied current report", "Compare exact statements and evidence"], acceptance: ["Return the actual comparison"], automaticInvocation: false, finalAcceptance: "caller_only" }));
  await fs.writeFile(path.join(componentRoot, "check.mjs"), 'throw new Error("Discovery must not execute dependency validation");\n');
  const component = { id: "report-reviewer", componentType: "agent", componentVersion: "0.1.0", path: componentPath, entrypoint: "AGENT.md",
    capabilityIds: [capability.id], validation: capability.validation, contentSha256: await componentHash(componentRoot), contractSha256: sha256(stableJson(contract)) };
  await fs.mkdir(path.join(sourceRoot, "generated"));
  await fs.writeFile(path.join(sourceRoot, "generated/capabilities.json"), stableJson({ schemaVersion: 1, componentCount: 1, capabilityCount: 1,
    components: [component], capabilities: [{ ...capability, componentId: component.id, componentType: component.componentType, componentVersion: component.componentVersion,
      componentPath, entrypoint: component.entrypoint, componentContentSha256: component.contentSha256, contractSha256: component.contractSha256 }] }));
  const oldRoot = process.env.META_KIM_KIM_SERVICE_ROOT;
  const oldPath = process.env.PATH;
  process.env.META_KIM_KIM_SERVICE_ROOT = sourceRoot;
  t.after(() => { if (oldRoot === undefined) delete process.env.META_KIM_KIM_SERVICE_ROOT; else process.env.META_KIM_KIM_SERVICE_ROOT = oldRoot; process.env.PATH = oldPath; });
  const program = `let input="";process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>{const task=JSON.parse(input.split("\\n").find(line=>line.startsWith("Task packet: ")).slice(13));const body={draft:task.referenceDirection??"bounded report",status:"partial",handoff:{nextOwner:task.ownerAgent,requiresDecision:false}};process.stdout.write([{type:"thread.started",thread_id:"synthetic-"+task.taskPacketId},{type:"item.completed",item:{id:"final",type:"agent_message",text:JSON.stringify(body)}},{type:"turn.completed",usage:{}}].map(record=>JSON.stringify(record)).join("\\n")+"\\n");});`;
  await fs.writeFile(path.join(root, "fake-codex.mjs"), program);
  const ownedNode = path.join(root, process.platform === "win32" ? "node.exe" : "node");
  await fs.copyFile(process.execPath, ownedNode);
  if (process.platform === "win32") await fs.writeFile(path.join(root, "codex.cmd"), '@echo off\r\n"%~dp0\\node.exe" "%~dp0\\fake-codex.mjs" %*\r\n');
  else { await fs.writeFile(path.join(root, "codex"), `#!/usr/bin/env node\n${program}`); await fs.chmod(path.join(root, "codex"), 0o700); }
  process.env.PATH = `${root}${path.delimiter}${oldPath}`;
  const workerEnvironment = { ...process.env, PATH: `${root}${path.delimiter}${path.dirname(process.execPath)}` };
  if (process.platform === "win32") assert.equal(resolveCliInvocation("codex", [], { env: workerEnvironment }).launchDescriptor.jsEntry,
    path.join(root, "fake-codex.mjs"), "This fixture must never resolve or invoke a global Codex executable");
  const operation = "Review the supplied PRD report against package metadata and return bounded evidence.";
  const task = `Run meta-theory: ${operation} Do not implement or deploy.`;
  const criteria = [{ id: "report", description: "The report agrees with the supplied source facts", kind: "semantic", required: true },
    { id: "audit", description: "An independent bounded audit provides its evidence", kind: "semantic", required: true }];
  const confirmedIntent = { taskHash: taskOutcomeDigest(task), outcome: task, constraints: { nonGoals: ["No implementation or deployment"] },
    acceptanceCriteria: criteria, settledDecisions: [], evidenceRefs: ["fixture:host-understanding"] };
  const intentDigest = intentDialogueDigest(confirmedIntent);
  const goal = buildTaskGoalContract({ task, acceptanceCriteria: criteria });
  const reportRef = "tmp/public-outcome-report.md";
  const report = "Current supplied report, retained as synthetic fixture material.";
  await fs.writeFile(path.join(projectRoot, reportRef), report);
  const slices = ["a", "b", "c"].map((id) => ({ id, workKind: "support", outcome: operation, capabilityNeed: ["Read-only PRD report review"], methodCapabilityId: capability.id,
    methodInputs: { facts: report }, scopeFiles: ["package.json", reportRef], inputRefs: [reportRef], criterionIds: [id === "b" ? "audit" : "report"],
    dependsOn: id === "c" ? ["a"] : [], dependencyReasons: id === "c" ? [{ taskId: "a", reason: "Consumes the prior report" }] : [],
    deliverables: [{ id: `${id}-report`, description: "Bounded report comparison", consumer: "Current user" }],
    verification: [{ criterionId: id === "b" ? "audit" : "report", procedure: "Compare actual source facts", expectedEvidence: "Exact comparison and source" }],
    completionDemo: "Read the bounded evidence" }));
  const base = { task, runId, stateDir: root, artifactDir: root, dbPath: path.join(root, "analytics.sqlite"), projectRoot,
    projectCapabilityMutationMode: "read_only", confirmedIntent,
    sharedUnderstandingConfirmed: { trusted: true, binding: "plan-challenge-understanding-confirmation", taskHash: goal.taskHash, intentDigest, evidenceRefs: confirmedIntent.evidenceRefs },
    designInput: { schemaVersion: 1, taskHash: goal.taskHash, intentDigest, acceptanceDigest: goal.acceptanceDigest,
      designId: "current-report-review", revision: 1, mode: "delivery", lifecycle: "first_delivery", sourceRefs: [reportRef], settledDecisionRefs: [],
      userJourneys: [], taskSlices: slices, artifactFlow: [] } };
  const captures = [];
  const authorized = [];
  const ownedNodeRealPath = await fs.realpath(ownedNode);
  const fakeScriptRealPath = await fs.realpath(path.join(root, "fake-codex.mjs"));
  const ownedNodeSha256 = sha256(await fs.readFile(ownedNode));
  const fakeScriptSha256 = sha256(program);
  const codexArgs = ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only", "--cd", projectRoot, "-"];
  const approvedArgv = [fakeScriptRealPath, ...codexArgs];
  const actualSpawns = [];
  let activeWorkerBoundary = false;
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function(command, args, options) {
    if (!activeWorkerBoundary) return originalSpawn.call(this, command, args, options);
    // This is the final transport call, not an earlier PATH prediction.
    if (process.platform === "win32") {
      assert.equal(realpathSync(command), ownedNodeRealPath);
      assert.deepEqual(args, approvedArgv);
    } else {
      assert.equal(command, "codex");
      assert.deepEqual(args, codexArgs);
    }
    assert.equal(sha256(readFileSync(ownedNodeRealPath)), ownedNodeSha256);
    assert.equal(realpathSync(approvedArgv[0]), fakeScriptRealPath);
    assert.equal(sha256(readFileSync(fakeScriptRealPath)), fakeScriptSha256);
    assert.equal(options.env.PATH, workerEnvironment.PATH);
    actualSpawns.push({ executable: ownedNodeRealPath, executableSha256: ownedNodeSha256, argv: [...approvedArgv], scriptSha256: fakeScriptSha256 });
    return originalSpawn.call(this, ownedNodeRealPath, [...approvedArgv], options);
  };
  syncBuiltinESMExports();
  t.after(() => { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); });
  let allow = false;
  const host = { enabled: true, durableMode: "fresh", durableDbPath: path.join(root, "machine.sqlite"), runtime: "codex", ownerId: "fixture-host",
    machineArtifactRoot: path.join(projectRoot, "tmp/public-outcome-results"), maxResultBytes: 256 * 1024,
    authorize: async ({ node, taskPacket }) => { if (taskPacket) authorized.push(structuredClone(taskPacket)); return node && !allow
      ? { status: "waiting", reason: "fixture_seed_prior_result" } : { status: "ready" }; },
    adapterRegistry: { invoke: async (_id, request) => {
      const launch = resolveCliInvocation("codex", [], { env: workerEnvironment });
      if (process.platform === "win32") assert.equal(launch.launchDescriptor.jsEntry, path.join(root, "fake-codex.mjs"));
      captures.push({ packet: structuredClone(request.packet), prompt: request.prompt, launch: launch.launchDescriptor });
      activeWorkerBoundary = true;
      try { return { result: await invokeReadOnlyRuntimeWorker({ ...request, env: workerEnvironment }) }; }
      finally { activeWorkerBoundary = false; } } } };
  const projects = JSON.parse(await fs.readFile("config/capability-index/dependency-project-registry.json", "utf8")).projects;
  const discovery = await discoverDependencyAgentContracts({ projects, projectRoot, environment: process.env });
  assert.ok(discovery.agents.some((agent) => agent.id === "kim-service:report-reviewer"), JSON.stringify(discovery));
  const routeCheck = runtimeFixture.run(["scripts/select-execution-route.mjs", "--task", [task, operation, "Read-only PRD report review", "package.json", reportRef].join("\n"),
    "--action-task", [operation, "package.json", reportRef].join("\n"), "--runtime", "codex", "--os", "windows", "--run-id", runId,
    "--method-work-kind", "support", "--method-capability-id", capability.id, "--json"], { env: { ...process.env } });
  assert.equal(routeCheck.status, 0, routeCheck.stderr || routeCheck.stdout);
  const route = JSON.parse(routeCheck.stdout);
  assert.equal(route.recommendedRoute.owner, "kim-service:report-reviewer", JSON.stringify({ owner: route.recommendedRoute.owner,
    agent: route.recommendedRoute.selectedCapabilityProviders?.agent, blocked: route.recommendedRoute.blockedReasons, discovery: discovery.sources }));
  const first = await runMetaTheoryGovernedExecution({ ...base, stageRunner: host });
  assert.equal(first.machineExecution.reason, "fixture_seed_prior_result", JSON.stringify(first.machineExecution));
  const reservation = JSON.parse(await fs.readFile(path.join(root, `${runId}.reservation.json`), "utf8"));
  const hashFile = async (file) => createHash("sha256").update(await fs.readFile(file)).digest("hex");
  assert.equal(reservation.jsonSha256, await hashFile(first.paths.json));
  assert.equal(reservation.markdownSha256, await hashFile(first.paths.markdown));
  const packets = first.workerTaskPackets;
  const a = packets.find((packet) => packet.designBinding.sliceId === "a");
  const b = packets.find((packet) => packet.designBinding.sliceId === "b");
  const c = packets.find((packet) => packet.designBinding.sliceId === "c");
  const kernel = await openDurableRunKernel(host.durableDbPath);
  try {
    assert.equal(kernel.projectRun(runId).run.status, "active");
    const nodeId = stageLaneNodeId("Execution", a.taskPacketId);
    const claim = kernel.claimNode({ runId, nodeId, ownerId: host.ownerId, nodeDefinitionHash: "fixture-prior-a", inputHash: "fixture-a", dependencyOutputHash: "fixture-a", leaseMs: 30_000 });
    // Explicit synthetic prior output; no native/model or historical business invocation is claimed.
    kernel.completeNode({ ...claim, runId, nodeId, ownerId: host.ownerId, output: { taskPacketId: a.taskPacketId, outputSha256: sha256(report),
      domainOutput: { status: "partial", handoff: { requiresDecision: false, nextOwner: a.ownerAgent } } } });
  } finally { kernel.close(); }
  allow = true;
  const requiredChange = "Reconcile the exact disputed statement with current source evidence and return the bounded comparison; retain the original scope and measurement criteria.";
  const review = (stage) => ({ schemaVersion: 1, runId, taskHash: goal.taskHash, intentDigest, acceptanceDigest: goal.acceptanceDigest,
    designDigest: first.productDesignPacket.designDigest, reviewRef: `fixture:review-${stage}`,
    artifactSnapshots: [{ ref: reportRef, sha256: sha256(report), producerTaskId: a.taskPacketId }],
    observations: [{ criterionId: "report", taskHash: goal.taskHash, intentDigest, acceptanceDigest: goal.acceptanceDigest,
      artifactRefs: [reportRef], verdict: "fail", evidenceKind: "independent_review", producer: "fixture-producer", reviewer: "fixture-reviewer", evidenceRef: `fixture:review-${stage}` }],
    revisionRequests: [{ taskId: c.taskPacketId, criterionId: "report", returnToStage: stage, finding: "Current statement needs evidence comparison", requiredChange, evidenceRefs: [`fixture:review-${stage}`] }] });
  const resume = (input) => runMetaTheoryGovernedExecution({ ...base, stageRunner: { ...host, durableMode: "resume" }, ...(input ? { outcomeReviewInput: input } : {}) });
  const bad = review("Execution"); bad.observations[0].taskHash = "wrong-task";
  await assert.rejects(resume(bad), /invalid.*observation|binding/i);
  assert.equal(captures.length, 0);
  const thinking = await resume(review("Thinking"));
  assert.deepEqual(captures.map(({ packet }) => packet.taskPacketId), [b.taskPacketId]);
  assert.equal(thinking.machineExecution.nextAction.stage, "Thinking");
  const omitted = await resume();
  assert.equal(omitted.machineExecution.nextAction.stage, "Thinking");
  assert.equal(captures.length, 1);
  const bResult = thinking.machineExecution.calls.find((call) => call.taskPacketId === b.taskPacketId);
  const bRef = path.relative(projectRoot, bResult.machineResultArtifact.path).split(path.sep).join("/");
  const bOnly = { ...review("Thinking"), reviewRef: "fixture:b-only", artifactSnapshots: [{ ref: bRef, sha256: bResult.outputSha256, producerTaskId: b.taskPacketId }],
    observations: [{ ...review("Thinking").observations[0], criterionId: "audit", artifactRefs: [bRef], verdict: "pass", evidenceRef: "fixture:b-only" }], revisionRequests: [] };
  const partial = await resume(bOnly);
  assert.equal(partial.machineExecution.nextAction.stage, "Thinking");
  assert.ok(partial.summaryPacket.nextAction.includes(requiredChange));
  const partialOmitted = await resume();
  assert.equal(partialOmitted.machineExecution.nextAction.stage, "Thinking");
  assert.equal(captures.length, 1, "Neither omission nor the unrelated B review releases C or replays B");
  const executed = await resume(review("Execution"));
  assert.deepEqual(captures.map(({ packet }) => packet.taskPacketId), [b.taskPacketId, c.taskPacketId]);
  assert.ok(captures[1].prompt.includes(requiredChange));
  assert.ok(captures[1].prompt.includes(sha256(report)));
  assert.deepEqual(captures[1].packet, authorized.find((packet) => packet.taskPacketId === c.taskPacketId));
  assert.ok(executed.machineExecution.calls[0].domainOutput.draft.includes(requiredChange));
  await assert.rejects(resume(review("Thinking")), /superseded.*review/i);
  await resume();
  assert.equal(captures.length, 2, "The current saved review and completed outputs are reused without another send");
  assert.equal(actualSpawns.length, 2);
  t.diagnostic(JSON.stringify({ evidenceKind: "actual_owned_synthetic_node_spawns_not_model_calls", actualSpawns }));
});

test("67 — human milestones reenter the public runner with current native replies and preserve completed work", async (t) => {
  const root = await tempRoot(t);
  const runId = "human-milestone-public-resume";
  const { buildTaskGoalContract } = await runtimeFixture.import("src/domain/governance/task-outcome.mjs");
  const goal = buildTaskGoalContract({ task: TASK });
  // Reviewable material belongs to the isolated project, not the external DB directory.
  const artifactDir = "tmp/human-milestone-materials";
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(`${artifactDir}/system.md`, "Current bounded system plan for the package report.");
  await fs.writeFile(`${artifactDir}/prd.md`, "Current PRD: exact package name and version; no source changes.");
  const slice = (id, workKind, dependsOn = []) => ({ id, workKind, outcome: TASK,
    capabilityNeed: ["read package metadata and produce a bounded verification report"], scopeFiles: ["package.json"], inputRefs: ["package.json"],
    criterionIds: goal.acceptanceCriteria.map((criterion) => criterion.id), dependsOn, journeyRefs: [], decisionRefs: [],
    dependencyReasons: dependsOn.map((taskId) => ({ taskId, reason: "Consumes the reviewed plan and scope" })),
    deliverables: [{ id: `${id}-report`, description: "Package metadata report", consumer: "Current package user" }],
    verification: goal.acceptanceCriteria.map((criterion) => ({ criterionId: criterion.id, procedure: "Compare to package.json", expectedEvidence: "Exact current metadata" })),
    completionDemo: "Show the exact package name and version with evidence" });
  const designInput = { schemaVersion: 1, taskHash: goal.taskHash, intentDigest: null, acceptanceDigest: goal.acceptanceDigest,
    designId: "package-milestone-review", revision: 1, mode: "delivery", lifecycle: "first_delivery", sourceRefs: ["package.json"],
    settledDecisionRefs: [], domainTerms: [], userJourneys: [],
    taskSlices: [slice("review-materials", "support"), slice("independent", "support"), slice("consumer", "vertical_slice", ["review-materials"])],
    artifactFlow: [["system", "system_plan"], ["prd", "prd"]].map(([id, artifactKind]) => ({ id, artifactKind,
      producerTaskId: "review-materials", consumerTaskIds: ["consumer"], terminalArtifactRef: `${artifactDir}/${id}.md`,
      sourceArtifactRefs: ["package.json"], scopeEvidenceRefs: ["fixture:current-plan"], criterionIds: goal.acceptanceCriteria.map((criterion) => criterion.id) })) };
  const base = { task: TASK, runId, stateDir: root, artifactDir: root, dbPath: path.join(root, "analytics.sqlite"),
    projectRoot: process.cwd(), projectCapabilityMutationMode: "read_only", designInput };
  const planned = await runMetaTheoryGovernedExecution(base);
  await fs.rm(planned.paths.json);
  await fs.rm(planned.paths.markdown);
  const { stageLaneNodeId } = await runtimeFixture.import("scripts/governed-execution/stage-dag.mjs");
  const { createNativeHumanMilestoneConsumer } = await runtimeFixture.import("scripts/governed-execution/plan-challenge-host-continuation.mjs");
  const { createNativeHostAnswerRepository } = await runtimeFixture.import("src/data/repositories/native-host-answer-repository.mjs");
  const { issueNativeDecisionChallenge } = await runtimeFixture.import("src/domain/decision/native-decision-authority.mjs");
  const packets = planned.coreLoop.thinkingPacket.workerTaskPackets;
  assert.ok(packets.length);
  const durableDbPath = path.join(root, "milestones.sqlite");
  const kernel = await openDurableRunKernel(durableDbPath);
  const producerId = stageLaneNodeId("Execution", packets.find((packet) => packet.designBinding.sliceId === "review-materials").taskPacketId);
  const consumerId = stageLaneNodeId("Execution", packets.find((packet) => packet.designBinding.sliceId === "consumer").taskPacketId);
  assert.deepEqual(planned.coreLoop.thinkingPacket.humanMilestonePlan.requests.map((request) => request.milestoneId), ["direction_system_plan", "prd_mvp_scope"]);
  assert.deepEqual(planned.coreLoop.thinkingPacket.humanMilestonePlan.gaps, []);
  try {
    kernel.createRun({ runId, graphDigest: planned.coreLoop.stageDagPacket.graphDigest, taskFingerprint: planned.taskFingerprint });
    // Synthetic completed outputs exercise public resume, not native worker execution.
    for (const packet of packets) {
      const nodeId = stageLaneNodeId("Execution", packet.taskPacketId);
      if (nodeId === consumerId) continue;
      const claim = kernel.claimNode({ runId, nodeId, ownerId: "fixture-host", nodeDefinitionHash: "fixture-definition",
        inputHash: "fixture-input", dependencyOutputHash: "fixture-upstream", leaseMs: 30_000 });
      kernel.completeNode({ runId, nodeId, attemptId: claim.attemptId, ownerId: "fixture-host", fenceToken: claim.fenceToken,
        output: { outputSha256: "a".repeat(64), domainOutput: { status: "partial", handoff: {
          requiresDecision: false, nextOwner: packet.ownerAgent } } } });
    }
  } finally { kernel.close(); }
  let calls = 0;
  const admitted = [];
  const host = { enabled: true, durableMode: "resume", durableDbPath, ownerId: "fixture-host", runtime: "codex",
    adapterRegistry: { invoke: async () => { calls += 1; throw new Error("Completed workers must not be replayed"); } },
    authorize: async ({ node }) => { if (node) { admitted.push(node.nodeId); return { status: "waiting", reason: "fixture_stops_at_consumer_admission" }; }
      return { status: "ready" }; } };
  const pending = await runMetaTheoryGovernedExecution({ ...base, stageRunner: host });
  assert.equal(pending.machineExecution.reason, "human_milestone_review_required", JSON.stringify(pending.machineExecution));
  assert.equal(pending.preDecisionOptionFrame.unresolvedQuestions.find((question) => question.nodeId === producerId).status, "open");
  assert.equal(calls, 0);
  assert.deepEqual(admitted, [], "The automatic plan/PRD gate must precede the consumer");
  let request;
  let response;
  let at;
  let questions = 0;
  const consumer = createNativeHumanMilestoneConsumer({ repository: createNativeHostAnswerRepository({ profileRoot: root }),
    now: () => new Date(Date.parse(at) + 1).toISOString(),
    prepareDecision: async ({ decision }) => {
      questions += 1;
      const issuedAt = new Date().toISOString(); at = new Date(Date.parse(issuedAt) + 1).toISOString();
      const options = decision.options.map(({ optionId }) => ({ optionId, description: optionId,
        label: ({ "option:accept": "确认本版", "option:revise": "提出修改", "option:return": "退回方案" })[optionId] }));
      const question = { id: "milestone", header: "当前材料", question: "请判断本版", options };
      const itemId = `fixture-item-${questions}`;
      request = { id: questions, method: "item/tool/requestUserInput", params: { threadId: "fixture-thread", turnId: "fixture-turn",
        itemId, questions: [{ ...question, options: options.map(({ label, description }) => ({ label, description })) }] } };
      response = { id: questions, result: { answers: { milestone: { answers: ["确认本版"] } } } };
      return { issuedChallenge: issueNativeDecisionChallenge(decision, { runtime: "codex", surface: "request_user_input",
        challengeRef: `challenge:public-milestone-${questions}`, requestRef: `request:public-milestone-${questions}`, issuedAt,
        expiresAt: new Date(Date.parse(issuedAt) + 60_000).toISOString() }), presentation: { question },
      expectedBinding: { threadId: "fixture-thread", turnId: "fixture-turn", itemId } };
    }, hostConnection: { hostConnectionRef: "host:synthetic-public-entry",
      takeRequestUserInput: async () => ({ request, timeSourceClaimRef: "time-source:request" }),
      takeResponse: async () => ({ response, at, timeSourceClaimRef: "time-source:return" }), ackResponse: async () => {} } });
  const firstAnswer = await runMetaTheoryGovernedExecution({ ...base, stageRunner: { ...host, humanDecisionConsumer: consumer } });
  assert.equal(firstAnswer.machineExecution.humanMilestoneReviews[0].accepted, true);
  assert.deepEqual(admitted, [], "Answering the system plan cannot release the unanswered PRD consumer");
  const accepted = await runMetaTheoryGovernedExecution({ ...base, stageRunner: { ...host, humanDecisionConsumer: consumer } });
  assert.equal(accepted.machineExecution.humanMilestoneReviews.every((review) => review.accepted), true, JSON.stringify(accepted.machineExecution));
  assert.equal(accepted.machineExecution.reason, "fixture_stops_at_consumer_admission");
  assert.ok(accepted.preDecisionOptionFrame.unresolvedQuestions.some((question) => question.question.includes("PRD与MVP范围") && question.question.includes(`${artifactDir}/prd.md`)));
  assert.deepEqual(admitted, [consumerId], "Only the actual current answers release the dependent consumer");
  const replay = await runMetaTheoryGovernedExecution({ ...base, stageRunner: { ...host, humanDecisionConsumer: consumer } });
  assert.deepEqual(replay.machineExecution.calls, []);
  assert.equal(calls, 0);
  assert.equal(questions, 2);
  assert.equal(replay.machineExecution.outcome.status, "incomplete", "A milestone judgement is not parent-goal acceptance");
  const inheritedBase = { ...base, runId: `${runId}-unproven-inheritance`, designInput: { ...designInput, lifecycle: "within_accepted_scope" } };
  const inheritedPlan = await runMetaTheoryGovernedExecution(inheritedBase);
  await fs.rm(inheritedPlan.paths.json); await fs.rm(inheritedPlan.paths.markdown);
  const inheritedKernel = await openDurableRunKernel(durableDbPath);
  try {
    inheritedKernel.createRun({ runId: inheritedBase.runId, graphDigest: inheritedPlan.coreLoop.stageDagPacket.graphDigest,
      taskFingerprint: inheritedPlan.taskFingerprint });
    for (const packet of inheritedPlan.coreLoop.thinkingPacket.workerTaskPackets.filter((packet) => packet.designBinding.sliceId !== "consumer")) {
      const nodeId = stageLaneNodeId("Execution", packet.taskPacketId);
      const claim = inheritedKernel.claimNode({ runId: inheritedBase.runId, nodeId, ownerId: "fixture-host", nodeDefinitionHash: "fixture-definition",
        inputHash: "fixture-input", dependencyOutputHash: "fixture-upstream", leaseMs: 30_000 });
      inheritedKernel.completeNode({ runId: inheritedBase.runId, nodeId, attemptId: claim.attemptId, ownerId: "fixture-host", fenceToken: claim.fenceToken,
        output: { outputSha256: "a".repeat(64), domainOutput: { status: "partial", handoff: { requiresDecision: false, nextOwner: packet.ownerAgent } } } });
    }
  } finally { inheritedKernel.close(); }
  const unproven = await runMetaTheoryGovernedExecution({ ...inheritedBase, stageRunner: { ...host, humanDecisionConsumer: consumer } });
  assert.equal(unproven.machineExecution.status, "waiting");
  assert.ok(unproven.machineExecution.humanMilestoneReviews.every((review) => !review.accepted && review.nextAction.stage === "Thinking"));
  assert.equal(unproven.preDecisionOptionFrame.unresolvedQuestions.some((question) => question.milestoneId), false,
    "Unproven accepted-scope classification returns to Thinking, not a blind human question");
  assert.equal(questions, 2, "A new run cannot reuse old human answers or blindly ask again on a supplied enum");
});

const CLI_FLAG_GUARD_TIMEOUT_MS = 120_000;

// The CLI rejects these flag combinations before doing any work, so a healthy
// child exits in well under a second. The generous budget is a hang fuse only,
// and the killed assertion keeps a starved child from reading as a wrong message.
async function rejectsCliFlags(args, pattern) {
  const failure = await execFileAsync(process.execPath, [ENTRY, ...args], {
    cwd: process.cwd(),
    timeout: CLI_FLAG_GUARD_TIMEOUT_MS,
  }).then(() => null, (error) => error);
  assert.ok(failure, `expected the CLI to reject: ${args.join(" ")}`);
  assert.notEqual(
    failure.killed,
    true,
    `CLI was killed by the ${CLI_FLAG_GUARD_TIMEOUT_MS}ms harness budget instead of rejecting: ${args.join(" ")}`,
  );
  assert.match(`${failure.message}\n${failure.stderr ?? ""}`, pattern);
}

function durableStageRunner(root, counter, mode = "fresh") {
  return {
    enabled: true,
    runtime: "codex",
    durableMode: mode,
    durableDbPath: path.join(root, "durable-runs.sqlite"),
    // Keep the integration fixture aligned with the production coordinator
    // defaults. A one-second lease can expire when the full parallel test suite
    // temporarily starves this process even though the coordinator is healthy.
    durableLeaseMs: 30_000,
    durableHeartbeatIntervalMs: 10_000,
    capacity: 1,
    timeoutMs: 30_000,
    invokeWorker: workerCounter(counter),
    evidenceKind: "durable_kernel_test_double",
  };
}

test("67 — CLI keeps planned-only default and validates durable fresh/resume flags before work", async (t) => {
  const root = await tempRoot(t);
  await rejectsCliFlags(["--execute-stage-dag", "--resume-stage-dag", "--task", TASK],
    /mutually exclusive|cannot be used together/iu);
  await rejectsCliFlags(["--resume-stage-dag", "--task", TASK],
    /resume-stage-dag.*run-id|run-id.*required/iu);
  await rejectsCliFlags(
    ["--execute-stage-dag", "--overwrite-run", "--task", TASK, "--state-dir", root],
    /durable.*overwrite|overwrite.*durable/iu,
  );
  await rejectsCliFlags(
    ["--execute-stage-dag", "--stage-runner-orchestrator", "stategraph", "--task", TASK, "--state-dir", root],
    /unsupported stage-runner orchestrator|stategraph/iu,
  );

  const planned = await runMetaTheoryGovernedExecution({
    task: TASK,
    stateDir: root,
    artifactDir: root,
    dbPath: path.join(root, "planned.sqlite"),
    projectRoot: process.cwd(),
    projectCapabilityMutationMode: "read_only",
  });
  assert.equal(planned.stageRunnerBridgePacket, null);
  assert.equal(planned.executionResult.actualWorkerExecution, false);
  assert.equal(planned.durableExecution, undefined);
});

test("67 — governed entry can explicitly select the LangGraph Functional API ready-set adapter", async (t) => {
  const root = await tempRoot(t);
  const counter = { count: 0 };
  const report = await runMetaTheoryGovernedExecution({
    task: TASK,
    runId: "p119-governed-langgraph-adapter",
    stateDir: root,
    artifactDir: root,
    dbPath: path.join(root, "analytics.sqlite"),
    projectRoot: process.cwd(),
    projectCapabilityMutationMode: "read_only",
    stageRunner: {
      ...durableStageRunner(root, counter),
      orchestrator: "langgraph",
      orchestratorOptions: {
        langgraph: {
          loadRuntime: async () => ({
            task: (_name, callback) => async (input) => callback(input),
            entrypoint: (_options, callback) => ({ invoke: callback }),
          }),
        },
      },
    },
  });
  assert.ok(counter.count > 0);
  assert.equal(report.stageRunnerBridgePacket.status, "pass");
  assert.equal(
    report.stageRunnerBridgePacket.routeHandoffEvidence.handoffStatus,
    "ready_for_host_handoff",
  );
  assert.equal(report.stageRunnerBridgePacket.routeHandoffEvidence.executionAuthorized, false);
  assert.equal(
    report.stageRunnerBridgePacket.workerResults[0].evidenceKind,
    "durable_kernel_test_double",
  );
  assert.equal(report.coreLoop.executionResult.executionAllowed, false);
  assert.equal(report.coreLoop.executionResult.actualWorkerExecution, false);
  assert.deepEqual(
    report.stageRunnerBridgePacket.readySetAdapterPacket.adapterIds,
    ["langgraph_functional_ready_set"],
  );
  assert.ok(report.stageRunnerBridgePacket.readySetAdapterPacket.batches.every(
    (batch) => batch.checkpointAuthority === "p118_durable_run_kernel_only",
  ));
});

test("67 — fresh durable auto-run reserves identity, uses the stateDir database, and closes coordinator", async (t) => {
  const root = await tempRoot(t);
  const counter = { count: 0 };
  const report = await runMetaTheoryGovernedExecution({
    task: TASK,
    stateDir: root,
    artifactDir: root,
    dbPath: path.join(root, "analytics.sqlite"),
    projectRoot: process.cwd(),
    projectCapabilityMutationMode: "read_only",
    stageRunner: {
      ...durableStageRunner(root, counter),
      durableDbPath: undefined,
    },
  });
  assert.ok(counter.count > 0);
  assert.equal(report.durableExecution.mode, "fresh");
  assert.equal(report.durableExecution.status, "materialized");
  assert.equal(report.durableExecution.database, "state_dir/durable-runs.sqlite");
  assert.equal(JSON.stringify(report.durableExecution).includes(path.resolve(root)), false);
  const reservation = JSON.parse(await fs.readFile(
    path.join(root, `${report.runId}.reservation.json`),
    "utf8",
  ));
  assert.equal(reservation.schemaVersion, "governed-run-reservation-v0.1");
  assert.equal(reservation.runId, report.runId);
  assert.equal(reservation.taskFingerprint, report.taskFingerprint);

  const kernel = await openDurableRunKernel(path.join(root, "durable-runs.sqlite"), {
    enableTestHooks: true,
  });
  try {
    assert.equal(kernel.projectRun(report.runId).run.status, "completed");
    const coordinator = kernel.testOnly.database.prepare(
      "SELECT * FROM governed_run_coordinators WHERE run_id = ?",
    ).get(report.runId);
    assert.equal(coordinator.owner_id, null);
    assert.equal(Number(coordinator.fence_token), report.durableExecution.fenceToken);
  } finally {
    kernel.close();
  }
});

test("67 — resume returns already_materialized without workers or overwrites and rejects one-sided artifacts", async (t) => {
  const root = await tempRoot(t);
  const runId = "p118-entry-already-materialized";
  const firstCounter = { count: 0 };
  const first = await runMetaTheoryGovernedExecution({
    task: TASK,
    runId,
    stateDir: root,
    artifactDir: root,
    dbPath: path.join(root, "analytics.sqlite"),
    projectRoot: process.cwd(),
    projectCapabilityMutationMode: "read_only",
    stageRunner: durableStageRunner(root, firstCounter, "fresh"),
  });
  const jsonBefore = await fs.readFile(first.paths.json, "utf8");
  const markdownBefore = await fs.readFile(first.paths.markdown, "utf8");
  const resumedCounter = { count: 0 };
  const resumed = await runMetaTheoryGovernedExecution({
    task: TASK,
    runId,
    stateDir: root,
    artifactDir: root,
    dbPath: path.join(root, "analytics.sqlite"),
    projectRoot: process.cwd(),
    projectCapabilityMutationMode: "read_only",
    stageRunner: durableStageRunner(root, resumedCounter, "resume"),
  });
  assert.equal(resumed.durableExecution.status, "already_materialized");
  assert.equal(resumed.durableExecution.workerCount, 0);
  assert.equal(resumedCounter.count, 0);
  assert.equal(await fs.readFile(first.paths.json, "utf8"), jsonBefore);
  assert.equal(await fs.readFile(first.paths.markdown, "utf8"), markdownBefore);

  await fs.rm(first.paths.markdown);
  await assert.rejects(
    runMetaTheoryGovernedExecution({
      task: TASK,
      runId,
      stateDir: root,
      artifactDir: root,
      dbPath: path.join(root, "analytics.sqlite"),
      projectRoot: process.cwd(),
      projectCapabilityMutationMode: "read_only",
      stageRunner: durableStageRunner(root, { count: 0 }, "resume"),
    }),
    /artifact.*incomplete|json.*markdown|fail.*closed/iu,
  );
});

test("67 — resume continues an identity-bound active kernel run and materializes it once", async (t) => {
  const root = await tempRoot(t);
  const runId = "p118-entry-active-resume";
  const planned = await runMetaTheoryGovernedExecution({
    task: TASK,
    runId,
    stateDir: root,
    artifactDir: root,
    dbPath: path.join(root, "analytics.sqlite"),
    projectRoot: process.cwd(),
    projectCapabilityMutationMode: "read_only",
  });
  await fs.rm(planned.paths.json);
  await fs.rm(planned.paths.markdown);
  const durableDbPath = path.join(root, "durable-runs.sqlite");
  const kernel = await openDurableRunKernel(durableDbPath);
  try {
    kernel.createRun({
      runId,
      graphDigest: planned.coreLoop.stageDagPacket.graphDigest,
      taskFingerprint: planned.taskFingerprint,
    });
  } finally {
    kernel.close();
  }
  const counter = { count: 0 };
  const resumed = await runMetaTheoryGovernedExecution({
    task: TASK,
    runId,
    stateDir: root,
    artifactDir: root,
    dbPath: path.join(root, "analytics.sqlite"),
    projectRoot: process.cwd(),
    projectCapabilityMutationMode: "read_only",
    stageRunner: durableStageRunner(root, counter, "resume"),
  });
  assert.ok(counter.count > 0);
  assert.equal(resumed.durableExecution.mode, "resume");
  assert.equal(resumed.durableExecution.status, "materialized");
  assert.equal(resumed.stageRunnerBridgePacket.executionProjection.durable.resumed, true);
});

test("67 — resume strictly binds reservation schema, runId, and task fingerprint", async (t) => {
  const root = await tempRoot(t);
  const runId = "p118-entry-reservation-binding";
  await fs.writeFile(
    path.join(root, `${runId}.reservation.json`),
    `${JSON.stringify({
      schemaVersion: "governed-run-reservation-v0.0",
      runId,
      taskFingerprint: "wrong",
      status: "reserved_or_incomplete",
    })}\n`,
  );
  await assert.rejects(
    runMetaTheoryGovernedExecution({
      task: TASK,
      runId,
      stateDir: root,
      artifactDir: root,
      dbPath: path.join(root, "analytics.sqlite"),
      projectRoot: process.cwd(),
      projectCapabilityMutationMode: "read_only",
      stageRunner: durableStageRunner(root, { count: 0 }, "resume"),
    }),
    /reservation.*schema|identity|fingerprint/iu,
  );
});

test("67 — progress callback failure preserves execution and a materialized resume emits no task replay", async (t) => {
  const root = await tempRoot(t);
  const runId = "p118-progress-sink-failure";
  const initialCounter = { count: 0 };
  const first = await runMetaTheoryGovernedExecution({
    task: TASK, runId, stateDir: root, artifactDir: root,
    dbPath: path.join(root, "analytics.sqlite"), projectRoot: process.cwd(),
    projectCapabilityMutationMode: "read_only",
    onConversationProgress() { throw new Error("progress callback crash"); },
    stageRunner: durableStageRunner(root, initialCounter, "fresh"),
  });
  assert.ok(initialCounter.count > 0);
  assert.equal(first.durableExecution.status, "materialized");
  assert.equal(first.conversationNotice.emitted, false);
  assert.ok(first.conversationNotice.progressEvents.every((event) => event.deliveryStatus === "failed"));
  const counter = { count: 0 };
  const events = [];
  const resumed = await runMetaTheoryGovernedExecution({
    task: TASK, runId, stateDir: root, artifactDir: root,
    dbPath: path.join(root, "analytics.sqlite"), projectRoot: process.cwd(),
    projectCapabilityMutationMode: "read_only",
    onConversationProgress(event) { events.push(event); },
    stageRunner: durableStageRunner(root, counter, "resume"),
  });
  assert.equal(resumed.durableExecution.mode, "resume");
  assert.equal(resumed.durableExecution.status, "already_materialized");
  assert.equal(counter.count, 0);
  assert.equal(resumed.conversationNotice.emitted, true);
  assert.deepEqual(events.map((event) => event.stage), ["Resume"]);
  assert.equal(events.some((event) => event.eventKind === "durable_task_event"), false);
});

test("67 — already_materialized validates paired digests and CLI reports resume with zero workers", async (t) => {
  const root = await tempRoot(t);
  const runId = "p118-digest-bound-materialized";
  const first = await runMetaTheoryGovernedExecution({
    task: TASK,
    runId,
    stateDir: root,
    artifactDir: root,
    dbPath: path.join(root, "analytics.sqlite"),
    projectRoot: process.cwd(),
    projectCapabilityMutationMode: "read_only",
    stageRunner: durableStageRunner(root, { count: 0 }, "fresh"),
  });
  const reservation = JSON.parse(await fs.readFile(path.join(root, `${runId}.reservation.json`), "utf8"));
  assert.equal(reservation.phase, "materialized");
  assert.match(reservation.jsonSha256, /^[a-f0-9]{64}$/u);
  assert.match(reservation.markdownSha256, /^[a-f0-9]{64}$/u);
  assert.ok(reservation.stagingRefs.json && !path.isAbsolute(reservation.stagingRefs.json));
  assert.ok(reservation.stagingRefs.markdown && !path.isAbsolute(reservation.stagingRefs.markdown));

  const { stdout } = await execFileAsync(process.execPath, [
    ENTRY,
    "--resume-stage-dag",
    "--run-id",
    runId,
    "--task",
    TASK,
    "--state-dir",
    root,
    "--artifact-dir",
    root,
    "--db",
    path.join(root, "analytics.sqlite"),
    "--durable-db",
    path.join(root, "durable-runs.sqlite"),
  ], { cwd: process.cwd(), timeout: 30_000 });
  const summary = JSON.parse(stdout);
  assert.equal(summary.durableExecution.mode, "resume");
  assert.equal(summary.durableExecution.status, "already_materialized");
  assert.equal(summary.durableExecution.workerCount, 0);

  await fs.appendFile(first.paths.json, " \n");
  await assert.rejects(
    runMetaTheoryGovernedExecution({
      task: TASK,
      runId,
      stateDir: root,
      artifactDir: root,
      dbPath: path.join(root, "analytics.sqlite"),
      projectRoot: process.cwd(),
      projectCapabilityMutationMode: "read_only",
      stageRunner: durableStageRunner(root, { count: 0 }, "resume"),
    }),
    /digest|tamper|pair/iu,
  );
});

test("67 — resume repairs a missing final artifact from a bounded staging reference", async (t) => {
  const root = await tempRoot(t);
  const runId = "p118-stage-repair";
  const first = await runMetaTheoryGovernedExecution({
    task: TASK,
    runId,
    stateDir: root,
    artifactDir: root,
    dbPath: path.join(root, "analytics.sqlite"),
    projectRoot: process.cwd(),
    projectCapabilityMutationMode: "read_only",
    stageRunner: durableStageRunner(root, { count: 0 }, "fresh"),
  });
  const reservationPath = path.join(root, `${runId}.reservation.json`);
  const reservation = JSON.parse(await fs.readFile(reservationPath, "utf8"));
  const markdownStage = path.join(root, reservation.stagingRefs.markdown);
  await fs.copyFile(first.paths.markdown, markdownStage);
  await fs.rm(first.paths.markdown);
  reservation.phase = "artifacts_committing";
  await fs.writeFile(reservationPath, `${JSON.stringify(reservation, null, 2)}\n`);
  const resumed = await runMetaTheoryGovernedExecution({
    task: TASK,
    runId,
    stateDir: root,
    artifactDir: root,
    dbPath: path.join(root, "analytics.sqlite"),
    projectRoot: process.cwd(),
    projectCapabilityMutationMode: "read_only",
    stageRunner: durableStageRunner(root, { count: 0 }, "resume"),
  });
  assert.equal(resumed.durableExecution.status, "already_materialized");
  assert.equal((await fs.stat(first.paths.markdown)).isFile(), true);
});

test("67 — dual committed artifacts with an active DB resume to terminal without worker replay", async (t) => {
  const root = await tempRoot(t);
  const runId = "p118-artifacts-active-db";
  const crash = new Error("simulated materialization crash");
  crash.simulatedProcessCrash = true;
  const firstCounter = { count: 0 };
  await assert.rejects(
    runMetaTheoryGovernedExecution({
      task: TASK,
      runId,
      stateDir: root,
      artifactDir: root,
      dbPath: path.join(root, "analytics.sqlite"),
      projectRoot: process.cwd(),
      projectCapabilityMutationMode: "read_only",
      stageRunner: {
        ...durableStageRunner(root, firstCounter, "fresh"),
        materializationFaultInjector(step) {
          if (step === "artifacts_committed") throw crash;
        },
      },
    }),
    /simulated materialization crash/iu,
  );
  assert.ok(firstCounter.count > 0);
  assert.equal((await fs.stat(path.join(root, `${runId}.json`))).isFile(), true);
  assert.equal((await fs.stat(path.join(root, `${runId}.en.md`))).isFile(), true);
  const resumedCounter = { count: 0 };
  const resumed = await runMetaTheoryGovernedExecution({
    task: TASK,
    runId,
    stateDir: root,
    artifactDir: root,
    dbPath: path.join(root, "analytics.sqlite"),
    projectRoot: process.cwd(),
    projectCapabilityMutationMode: "read_only",
    stageRunner: durableStageRunner(root, resumedCounter, "resume"),
  });
  assert.equal(resumed.durableExecution.status, "materialized");
  assert.equal(resumedCounter.count, 0);
});

test("67 — terminal kernel plus missing final artifact is finalized from staging without workers", async (t) => {
  const root = await tempRoot(t);
  const runId = "p118-terminal-missing-final";
  const crash = new Error("simulated post-terminal crash");
  crash.simulatedProcessCrash = true;
  await assert.rejects(
    runMetaTheoryGovernedExecution({
      task: TASK,
      runId,
      stateDir: root,
      artifactDir: root,
      dbPath: path.join(root, "analytics.sqlite"),
      projectRoot: process.cwd(),
      projectCapabilityMutationMode: "read_only",
      stageRunner: {
        ...durableStageRunner(root, { count: 0 }, "fresh"),
        materializationFaultInjector(step) {
          if (step === "kernel_terminal") throw crash;
        },
      },
    }),
    /simulated post-terminal crash/iu,
  );
  await fs.rm(path.join(root, `${runId}.json`));
  const counter = { count: 0 };
  const resumed = await runMetaTheoryGovernedExecution({
    task: TASK,
    runId,
    stateDir: root,
    artifactDir: root,
    dbPath: path.join(root, "analytics.sqlite"),
    projectRoot: process.cwd(),
    projectCapabilityMutationMode: "read_only",
    stageRunner: durableStageRunner(root, counter, "resume"),
  });
  assert.equal(counter.count, 0);
  assert.equal(resumed.durableExecution.status, "already_materialized");
  const persisted = JSON.parse(await fs.readFile(path.join(root, `${runId}.json`), "utf8"));
  assert.equal(persisted.durableExecution.status, "materialized");
  assert.equal(JSON.parse(await fs.readFile(
    path.join(root, `${runId}.reservation.json`),
    "utf8",
  )).phase, "materialized");
});
