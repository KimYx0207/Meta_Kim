import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentWorkflowService } from "../../src/application/agent/agent-workflow-service.mjs";
import { createAgentExecutionBridge } from "../../src/application/agent/agent-execution-bridge.mjs";
import { createAgentNativeExecutionService } from "../../src/application/agent/agent-native-execution-service.mjs";
import { createLiveControlRoomServer } from "../../src/infrastructure/live/live-control-room-server.mjs";

const KEY = "native-b3-request-20261118";
const APPROVAL = "native-b3-approval-20261118";
const SESSION = "7c5dcf5d";
function approvedDesign() {
  return {
    system: { title: "一人公司数字员工", goal: "降低跨境电商运营成本",
      architecture: "调研 -> 人审 -> 执行 -> 核验", techStack: "Node and local files",
      acceptance: ["可核对成果和执行证据"] },
    modules: [{ id: "research", title: "市场调研", objective: "核对有出处的市场信息",
      inputContract: ["目标"], outputContract: ["参考资料"], boundaries: ["不得伪造来源"],
      acceptance: ["有真实引用"], dependencies: [] },
    { id: "implementation", title: "本地实现", objective: "生成本地方案文件",
      inputContract: ["经人审设计"], outputContract: ["项目内草稿"], boundaries: ["不得自动发布"],
      acceptance: ["经测试并由用户验收"], dependencies: ["research"] }],
  };
}

async function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "meta-kim-native-b3-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".git"));
  const native = {
    getHosts: async () => ({ hosts: [], executionAllowed: true }),
    start: async () => ({ status: "accepted" }),
    inspect: () => ({ status: "completed", resultPreview: "A 方案范围大；B 方案按阶段有证据地交付。" }),
    getProfessionalReference: async () => ({ capabilityState: { status: "verified_local_method_bound",
      methodSha256: "a".repeat(64) }, methodPrompt: "verified Kim_Service method reference" }),
  };
  const workflow = createAgentWorkflowService({ projectRoot: root, agentStartService: native });
  await workflow.start({ goal: "制作可自行迭代的跨境电商数字员工体系", hostId: "claude", idempotencyKey: KEY });
  const plan = await workflow.inspect({ idempotencyKey: KEY });
  const decision = await workflow.recordDecision({
    idempotencyKey: KEY, requestId: plan.requestId, planDigest: plan.planDigest,
    decisionKey: "native-b3-decision-20261118", action: "adopt",
    selectedStrategy: "B 方案", selectionReason: "先交付最小可验证闭环",
  });
  const basis = { idempotencyKey: KEY, requestId: plan.requestId, planDigest: plan.planDigest,
    decisionKey: decision.decision.decisionKey };
  workflow.recordDesign({ ...basis, action: "submit", expectedVersion: 0,
    mutationKey: "native-b3-design-submit", design: approvedDesign() });
  for (const [index, target] of [{ kind: "system" }, { kind: "module", moduleId: "research" },
    { kind: "module", moduleId: "implementation" }].entries()) {
    workflow.recordDesign({ ...basis, action: "approve", expectedVersion: index + 1,
      mutationKey: "native-b3-design-approve-" + index, target });
  }
  const preview = workflow.inspectHandoff({ idempotencyKey: KEY });
  const handoff = workflow.prepareHandoff({ ...basis, handoffKey: "native-b3-prepared-handoff",
    designVersion: preview.designVersion, designDigest: preview.designDigest });
  assert.equal(handoff.status, "prepared");
  const calls = [];
  let listedState = "working";
  let backgroundOutput = "backgrounded · " + SESSION + " · meta-test\n  claude attach " + SESSION;
  const launch = async (command, args, options) => {
    calls.push({ command, args, options });
    return args[0] === "--bg" ? { status: 0, stdout: backgroundOutput }
      : { status: 0, stdout: JSON.stringify([{ id: SESSION, kind: "background", cwd: root,
        name: "meta-" + KEY.slice(0, 20),
        state: listedState, startedAt: Date.now() }]) };
  };
  const bridge = createAgentExecutionBridge({ projectRoot: root, agentWorkflowService: workflow });
  const create = () => createAgentNativeExecutionService({
    projectRoot: root, workflowService: workflow, executionBridge: bridge,
    probe: async command => command === "claude"
      ? { status: "detected", version: "2.1.319 (Claude Code)" } : { status: "not_found" },
    launch, environment: { PATH: process.env.PATH, CODEX_TOKEN: "personal-secret",
      OPENAI_API_KEY: "do-not-inherit", CHATGPT_AUTH: "private", USER_LANGUAGE: "zh" },
  });
  return { root, workflow, bridge, create, handoff, calls, launch,
    setState: value => { listedState = value; },
    setBackgroundOutput: value => { backgroundOutput = value; } };
}

function approval(f) {
  return { idempotencyKey: KEY, handoffDigest: f.handoff.handoffDigest,
    approvalKey: APPROVAL, scope: "local_project_draft" };
}

test("real B1/B2 approval is required before B3 may launch a native host", async t => {
  const f = await fixture(t);
  const service = f.create();
  const pending = await service.inspect({ idempotencyKey: KEY });
  assert.equal(pending.status, "ready_to_authorize");
  assert.equal(pending.governedRunVerified, false);
  assert.equal((await service.authorizeAndLaunch({ ...approval(f), scope: "payments" })).reason, "invalid_b3_approval");
  assert.equal((await service.authorizeAndLaunch({ ...approval(f), handoffDigest: "b".repeat(64) })).reason, "stale_b3_handoff");
  assert.equal(f.calls.length, 0, "no host call may happen before a matching human B3 approval");
});

test("B3 launch is one-use, shell-free, Codex-token-free and uses a verified Kim_Service method", async t => {
  const f = await fixture(t);
  const service = f.create();
  const launched = await service.authorizeAndLaunch(approval(f));
  assert.equal(launched.nativeSessionId, SESSION);
  assert.equal(launched.nativeLaunchReceiptSaved, true);
  assert.equal(launched.officialRunId, null);
  assert.equal(launched.acceptanceVerified, false);
  const only = f.calls.filter(call => call.args[0] === "--bg");
  assert.equal(only.length, 1);
  assert.equal(only[0].command, "claude");
  assert.ok(only[0].args.includes("--restricted"));
  assert.ok(only[0].args.includes("acceptEdits"));
  assert.ok(only[0].args.includes("Read,Edit,Write,Glob,Grep"));
  assert.ok(only[0].args.includes("mcp__*"));
  assert.equal(only[0].args.includes("-p"), false, "background cannot use -p");
  assert.equal(only[0].options.env.CODEX_TOKEN, undefined);
  assert.equal(only[0].options.env.OPENAI_API_KEY, undefined);
  assert.equal(only[0].options.env.CHATGPT_AUTH, undefined);
  assert.equal(only[0].options.env.USER_LANGUAGE, "zh");
  assert.equal(only[0].args.at(-1).includes("跨境电商"), false, "private user goal must not be in process arguments");
  const order = JSON.parse(readFileSync(path.join(f.root, ".meta-kim", "state", "default",
    "agent-workflow", "native-execution", "work-" + KEY + ".json"), "utf8"));
  assert.equal(order.originalGoal, "制作可自行迭代的跨境电商数字员工体系");
  assert.equal(order.approvedDesign.modules.length, 2);
  assert.equal(order.professionalMethodReference, "verified Kim_Service method reference");
  assert.equal(order.workContext.contextRevision, "handoff:" + f.handoff.handoffDigest);
  const replay = await service.authorizeAndLaunch(approval(f));
  assert.equal(replay.nativeSessionId, SESSION);
  assert.equal(f.calls.filter(call => call.args[0] === "--bg").length, 1);
  assert.equal((await service.authorizeAndLaunch({ ...approval(f), approvalKey: "another-approval-20261118" })).reason,
    "b3_approval_already_used");
});

test("native status is reconciled after restart without mistaking done for verified public acceptance", async t => {
  const f = await fixture(t);
  await f.create().authorizeAndLaunch(approval(f));
  const restored = f.create();
  assert.equal((await restored.inspect({ idempotencyKey: KEY })).status, "running");
  f.setState("done");
  // New instance must consult the authoritative CLI, not cached original process state.
  const again = f.create();
  const finished = await again.inspect({ idempotencyKey: KEY });
  assert.equal(finished.status, "ready_for_review");
  assert.equal(finished.nativeObservation, "claude_agents_json_project_bound");
  assert.equal(finished.governedRunVerified, false);
  assert.equal(finished.acceptanceVerified, false);
  assert.equal(f.calls.filter(call => call.args[0] === "--bg").length, 1);
});

test("ambiguous OS dispatch is retained in doubt and never repeated", async t => {
  const f = await fixture(t);
  f.setBackgroundOutput("non-standard terminal output");
  const service = f.create();
  const result = await service.authorizeAndLaunch(approval(f));
  assert.equal(result.reason, "background_session_not_confirmed");
  assert.equal((await f.create().authorizeAndLaunch(approval(f))).status, "in_doubt");
  assert.equal(f.calls.filter(call => call.args[0] === "--bg").length, 1);
});

test("concurrent B3 approvals reserve exactly one native launch", async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([
    f.create().authorizeAndLaunch(approval(f)),
    f.create().authorizeAndLaunch(approval(f)),
  ]);
  assert.equal(f.calls.filter(call => call.args[0] === "--bg").length, 1);
  assert.ok([first.status, second.status].every(status => ["unconfirmed", "in_doubt", "running"].includes(status)));
  assert.equal((await f.create().inspect({ idempotencyKey: KEY })).nativeSessionId, SESSION);
});

test("changed private work order cannot be mistaken for an authorized continuation", async t => {
  const f = await fixture(t);
  await f.create().authorizeAndLaunch(approval(f));
  const filename = path.join(f.root, ".meta-kim", "state", "default", "agent-workflow",
    "native-execution", "work-" + KEY + ".json");
  const packet = JSON.parse(readFileSync(filename, "utf8"));
  packet.originalGoal = "unapproved replacement";
  writeFileSync(filename, JSON.stringify(packet));
  const inspected = await f.create().inspect({ idempotencyKey: KEY });
  assert.equal(inspected.status, "blocked");
  assert.equal(inspected.reason, "b3_work_order_integrity_failed");
  assert.equal(inspected.acceptanceVerified, false);
  assert.equal(f.calls.filter(call => call.args[0] === "--bg").length, 1);
});

test("B3 is scoped to exact project and becomes stale when approved design changes", async t => {
  const f = await fixture(t);
  await f.create().authorizeAndLaunch(approval(f));
  const prepared = f.workflow.inspectDesign({ idempotencyKey: KEY });
  const revisedModule = { ...approvedDesign().modules[0], objective: "变更后的目标" };
  f.workflow.recordDesign({ idempotencyKey: KEY, requestId: f.handoff.basis.requestId,
    planDigest: f.handoff.basis.planDigest, decisionKey: f.handoff.basis.decisionKey,
    action: "revise_module", expectedVersion: prepared.version,
    mutationKey: "native-b3-postlaunch-revision", module: revisedModule });
  assert.equal((await f.create().inspect({ idempotencyKey: KEY })).reason, "approved_handoff_changed_after_b3");
  const other = mkdtempSync(path.join(tmpdir(), "meta-kim-b3-another-root-"));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  mkdirSync(path.join(other, ".git"));
  const isolatedWorkflow = createAgentWorkflowService({ projectRoot: other, agentStartService: {
    getHosts: async () => ({}), start: async () => ({ status: "blocked" }), inspect: () => ({ status: "unknown" }),
  } });
  const isolatedBridge = createAgentExecutionBridge({ projectRoot: other, agentWorkflowService: isolatedWorkflow });
  const isolated = createAgentNativeExecutionService({ projectRoot: other, workflowService: isolatedWorkflow,
    executionBridge: isolatedBridge, probe: async () => { throw Error("must not probe"); },
    launch: async () => { throw Error("must not launch"); } });
  assert.equal((await isolated.inspect({ idempotencyKey: KEY })).reason, "agent_b2_approval_pending");
});

test("localhost B3 endpoint requires same-origin JSON and private workspace token", async t => {
  const f = await fixture(t);
  const executor = f.create();
  const server = createLiveControlRoomServer({ projectRoot: f.root, port: 0, globalHub: false,
    enableAgentStart: true, workspaceEnabled: true, agentStartService: f.workflow,
    agentNativeExecutionService: executor, service: { getSnapshot: async () => null } });
  t.after(async () => server.close());
  const { url } = await server.start();
  const html = await (await fetch(url)).text();
  const match = html.match(/<script type="application\/json" id="live-workspace-config">([^<]+)<\/script>/u);
  assert.ok(match);
  const auth = JSON.parse(match[1]);
  const getUrl = new URL(url + "/api/agent/execution");
  getUrl.searchParams.set("idempotencyKey", KEY);
  assert.equal((await fetch(getUrl)).status, 403);
  const headers = { [auth.controlHeader]: auth.controlToken };
  assert.equal((await (await fetch(getUrl, { headers })).json()).status, "ready_to_authorize");
  assert.equal((await fetch(url + "/api/agent/execution", { method: "POST",
    headers: { ...headers, "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify(approval(f)) })).status, 403);
  const launched = await (await fetch(url + "/api/agent/execution", { method: "POST",
    headers: { ...headers, "content-type": "application/json", origin: url },
    body: JSON.stringify(approval(f)) })).json();
  assert.equal(launched.nativeSessionId, SESSION);
  assert.equal(f.calls.filter(call => call.args[0] === "--bg").length, 1);
});
