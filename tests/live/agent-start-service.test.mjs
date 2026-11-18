import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentStartService } from "../../src/application/agent/agent-start-service.mjs";
import { diagnoseAgentHost, meetsAgentHostMinimumVersion } from "../../src/domain/runtime/agent-host-diagnostics.mjs";
import { componentHash, sha256, stableJson } from "../../scripts/dependency-agent-discovery.mjs";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const key = (suffix = "aaaa") => `agent-request-${suffix}-20261116`;
const detection = () => ({ status: "detected", version: "2.1.319 (Claude Code)", executablePath: "/not/for/browser" });
const successful = { status: 0, stdout: "untrusted", stderr: "", error: null };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("starts disabled by default, with honest detected versus supported host status", async () => {
  let launched = false;
  const service = createAgentStartService({ projectRoot,
    probe: (command) => command === "gemini" ? { status: "detected", version: "0.40.0" } : detection(),
    launch: () => { launched = true; return successful; } });
  const hosts = await service.getHosts();
  assert.equal(hosts.schemaVersion, "meta-kim-agent-hosts-v1");
  assert.equal(hosts.executionAllowed, false);
  assert.deepEqual(hosts.hosts.map((host) => host.id),
    ["claude", "gemini", "codex", "zcode", "dsh", "opencode", "openclaw"]);
  assert.equal(hosts.hosts.find((host) => host.id === "claude").launchSupported, true);
  assert.equal(hosts.hosts.find((host) => host.id === "claude").statusLabel, "可用于只读研究");
  assert.match(hosts.hosts.find((host) => host.id === "claude").nextAction, /实际修改、执行和交付/u);
  for (const host of hosts.hosts.filter((entry) => entry.id !== "claude")) {
    assert.equal(host.available, true);
    assert.equal(host.launchSupported, false);
    assert.ok(host.statusLabel && host.nextAction);
  }
  assert.equal((await service.start({ goal: "Build an app", hostId: "claude", idempotencyKey: key() })).reason,
    "agent_execution_disabled");
  assert.equal(launched, false);
  service.close();
});

test("host diagnostics tell beginners what to do without expanding launch authority", async () => {
  const secrets = { CODEX_TOKEN: "codex-do-not-expose", OPENAI_API_KEY: "openai-do-not-expose" };
  const detectedByHost = {
    claude: { status: "not_found", version: null },
    gemini: { status: "detected", version: "0.67.9" },
    codex: { status: "detected", version: "9.9.9" },
    zcode: { status: "detected", version: "9.9.9" },
    dsh: { status: "unprobed", version: null },
    opencode: { status: "not_found", version: null },
    openclaw: { status: "detected", version: "9.9.9" },
  };
  const service = createAgentStartService({ projectRoot, enabled: true,
    environment: { PATH: process.env.PATH, ...secrets },
    probe: (command) => detectedByHost[command],
    launch: () => { throw new Error("Unsupported host should not launch"); },
  });
  const snapshot = await service.getHosts();
  const host = (id) => snapshot.hosts.find((entry) => entry.id === id);
  assert.equal(snapshot.executionAllowed, false);
  assert.equal(host("claude").reason, "client_not_installed");
  assert.match(host("claude").nextAction, /安装 Claude Code.*重新检测/u);
  assert.equal(host("gemini").reason, "gemini_noninteractive_plan_auto_execution_risk");
  assert.match(host("gemini").nextAction, /自动离开只读状态/u);
  assert.equal(host("codex").reason, "personal_codex_token_not_authorized");
  assert.match(host("codex").nextAction, /不会读取或使用个人 Codex Token/u);
  assert.equal(host("zcode").reason, "needs_native_launch_review");
  assert.match(host("zcode").nextAction, /尚未完成安全启动协议/u);
  assert.equal(host("dsh").reason, "client_detection_not_verified");
  assert.match(host("dsh").nextAction, /PATH/u);
  assert.match(host("dsh").nextAction, /仍未开放自动启动/u);
  assert.equal(host("opencode").reason, "client_not_installed");
  assert.match(host("opencode").nextAction, /当前版本仍未开放自动启动/u);
  assert.ok(snapshot.hosts.every((entry) => entry.launchSupported === false));
  assert.ok(!JSON.stringify(snapshot).includes(secrets.CODEX_TOKEN));
  assert.ok(!JSON.stringify(snapshot).includes(secrets.OPENAI_API_KEY));
  service.close();
});

test("runtime CLI minimum versions compare semver components, not lexically", () => {
  assert.equal(meetsAgentHostMinimumVersion("Claude Code v2.1.259", "2.1.259"), true);
  assert.equal(meetsAgentHostMinimumVersion("v2.10.0", "2.1.259"), true);
  assert.equal(meetsAgentHostMinimumVersion("2.1.258", "2.1.259"), false);
  assert.equal(meetsAgentHostMinimumVersion("version unverified", "2.1.259"), false);
  const hypotheticalCodexProfile = diagnoseAgentHost(
    { id: "codex", label: "Codex", profile: { minimumVersion: "0.1.0" } },
    { status: "detected", version: "9.9.9" },
  );
  assert.equal(hypotheticalCodexProfile.launchSupported, false);
  assert.equal(hypotheticalCodexProfile.reason, "personal_codex_token_not_authorized");
});

test("only reviewed Claude plan mode launches, using stdin and fixed local CWD", async () => {
  const gate = deferred();
  const invocations = [];
  const service = createAgentStartService({ projectRoot, enabled: true,
    environment: { META_KIM_KIM_SERVICE_ROOT: path.join(projectRoot, ".isolated-no-kim-service"), HOME: "" },
    probe: () => detection(),
    launch: (command, args, options) => { invocations.push({ command, args, options }); return gate.promise; } });
  const goal = `Research options; $(touch /tmp/pwned); AUTH_TOKEN=supersecret;\nDo not do edits.`;
  const receipt = await service.start({ goal, hostId: "claude", idempotencyKey: key("launch"),
    cwd: "/tmp", command: "sh", args: ["-c", "id"] });
  assert.deepEqual({ ...receipt, capabilityState: undefined },
    { status: "accepted", requestId: receipt.requestId, runId: null, capabilityState: undefined });
  assert.equal(receipt.capabilityState.sourceRef, "dependency:kim-service/generated/capabilities.json");
  assert.match(receipt.requestId, /^[0-9a-f-]{36}$/u);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].command, "claude");
  assert.equal(invocations[0].options.input, goal);
  assert.equal(invocations[0].options.cwd, path.resolve(projectRoot));
  assert.deepEqual(invocations[0].args.slice(0, 1), ["-p"]);
  assert.deepEqual(invocations[0].args.slice(2, 6),
    ["--permission-mode", "plan", "--permission-prompts", "none"]);
  assert.ok(invocations[0].args.includes("--no-chrome"));
  assert.ok(invocations[0].options.maxOutputBytes <= 256 * 1024);
  assert.ok(!invocations[0].args.some((arg) => arg.includes("supersecret") || arg.includes("touch")));
  assert.equal(service.inspect({ idempotencyKey: key("launch") }).status, "running");
  gate.resolve(successful);
  await flush();
  assert.equal(service.inspect({ idempotencyKey: key("launch") }).status, "completed");
  service.close();
});

test("Gemini noninteractive plan is detected but cannot launch under an auto-execution risk", async () => {
  const invocations = [];
  const service = createAgentStartService({ projectRoot, enabled: true,
    probe: () => ({ status: "detected", version: "0.68.0" }),
    launch: (command, args, options) => {
      invocations.push({ command, args, options });
      return { status: 0, stdout: JSON.stringify({ response: "先调查资料，再请用户选方案。", stats: { total_tokens: 12 } }) };
    },
  });
  const capability = await service.getHosts();
  assert.equal(capability.hosts.find((host) => host.id === "gemini").launchSupported, false);
  const receipt = await service.start({ goal: "研究企业知识库方案", hostId: "gemini", idempotencyKey: key("gemini-plan") });
  assert.equal(receipt.status, "unavailable");
  assert.equal(receipt.reason, "gemini_noninteractive_plan_auto_execution_risk");
  assert.equal(invocations.length, 0);
  await flush();
  assert.equal(service.inspect({ idempotencyKey: key("gemini-plan") }).status, "unknown");
  service.close();
});

test("native plan result may contain two validated strategy cards without promoting model claims to evidence", async () => {
  const cards = {
    summary: "选择知识库试点范围",
    strategies: [
      { id: "A", title: "单业务试点", approach: "先做客服知识检索",
        tradeoffs: "投入低，跨部门价值有限", evidenceSummary: "只有当前目标可见，外部来源尚待核实",
        risks: "权限映射需要确认" },
      { id: "B", title: "跨部门分阶段", approach: "先接权限与目录，再扩展采购",
        tradeoffs: "集成多一些，但可逐模块验收", evidenceSummary: "已看到需求描述，真实数据尚待核实",
        risks: "数据源可能不一致" },
    ],
    recommendedStrategyId: "B", openQuestions: ["有哪些现有知识库？"],
    evidenceVerified: true, // A model statement must never become trusted attestation.
    extraneousPrivateMessage: "do-not-expose",
  };
  const service = createAgentStartService({ projectRoot, enabled: true,
    probe: detection,
    launch: () => ({ status: 0, stdout: JSON.stringify({ result: JSON.stringify(cards) }) }),
  });
  await service.start({ goal: "比较知识库方案", hostId: "claude", idempotencyKey: key("structured-cards") });
  await flush();
  const receipt = service.inspect({ idempotencyKey: key("structured-cards") });
  assert.equal(receipt.status, "completed");
  const preview = JSON.parse(receipt.resultPreview);
  assert.equal(preview.schemaVersion, "meta-kim-agent-strategy-options-v1");
  assert.equal(preview.provenance, "native_plan_unverified");
  assert.equal(preview.evidenceVerified, false);
  assert.deepEqual(preview.strategies.map(strategy => strategy.id), ["A", "B"]);
  assert.equal(preview.recommendedStrategyId, "B");
  assert.equal(preview.extraneousPrivateMessage, undefined);
  assert.ok(!receipt.resultPreview.includes("do-not-expose"));
  service.close();
});

test("malformed candidate cards never turn into model-verified strategy options", async () => {
  const invalid = { summary: "方案比较", strategies: [
    { id: "A", title: "重复", approach: "同一方法", tradeoffs: "权衡", evidenceSummary: "无来源", risks: "风险" },
    { id: "B", title: "重复", approach: "同一方法", tradeoffs: "权衡", evidenceSummary: "无来源", risks: "风险" },
  ], recommendedStrategyId: "A", openQuestions: [] };
  const service = createAgentStartService({ projectRoot, enabled: true,
    probe: detection,
    launch: () => ({ status: 0, stdout: JSON.stringify({ result: JSON.stringify(invalid) }) }),
  });
  await service.start({ goal: "查出三个方案", hostId: "claude", idempotencyKey: key("invalid-cards") });
  await flush();
  const raw = service.inspect({ idempotencyKey: key("invalid-cards") }).resultPreview;
  assert.ok(raw);
  assert.equal(JSON.parse(raw).schemaVersion, undefined,
    "Unverified or malformed input is retained as unstructured text; the UI must not render cards");
  service.close();
});

test("structured result secrets are scrubbed before strategy cards are exposed", async () => {
  const privateCards = { summary: "研究摘要", strategies: [
    { id: "A", title: "方法一", approach: "读取资料", tradeoffs: "速度快", evidenceSummary: "无独立来源", risks: "sk-ant-1234567890" },
    { id: "B", title: "方法二", approach: "先整理资料", tradeoffs: "成本低", evidenceSummary: "需再次核对", risks: "数据缺口" },
  ], recommendedStrategyId: null, openQuestions: [] };
  const service = createAgentStartService({ projectRoot, enabled: true,
    probe: detection,
    launch: () => ({ status: 0, stdout: JSON.stringify({ result: JSON.stringify(privateCards) }) }),
  });
  await service.start({ goal: "研究两个方案", hostId: "claude", idempotencyKey: key("private-cards") });
  await flush();
  const preview = service.inspect({ idempotencyKey: key("private-cards") }).resultPreview;
  assert.ok(!preview.includes("sk-ant"));
  assert.match(JSON.parse(preview).strategies[0].risks, /凭据已隐藏/u);
  service.close();
});

test("explicit automatic selection only chooses an installed reviewed read-only host", async () => {
  const calls = [];
  const observed = [];
  const service = createAgentStartService({ projectRoot, enabled: true,
    environment: { PATH: process.env.PATH, CODEX_TOKEN: "never-forward-this-token" },
    probe: (command) => {
      observed.push(command);
      if (command === "claude") return { status: "not_found", version: null };
      if (command === "gemini") return { status: "detected", version: "0.69.0" };
      return { status: "detected", version: "999.0.0" };
    },
    launch: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: JSON.stringify({ response: "只读研究结果" }) };
    },
  });
  const hosts = await service.getHosts();
  assert.equal(hosts.recommendedHostId, null);
  assert.ok(hosts.hosts.find((entry) => entry.id === "codex").launchSupported === false);
  const receipt = await service.start({ goal: "设计一套知识库", hostId: "auto", idempotencyKey: key("auto-gemini") });
  assert.equal(receipt.status, "unavailable");
  assert.equal(receipt.reason, "no_reviewed_client_available");
  assert.equal(receipt.runId, null);
  assert.equal(calls.length, 0);
  await flush();
  assert.equal(service.inspect({ idempotencyKey: key("auto-gemini") }).status, "blocked");
  assert.ok(observed.includes("codex"), "Host diagnostics can detect Codex without authorizing it");
  service.close();
});

test("automatic selection never falls back to an unreviewed host or overrides an explicit choice", async () => {
  let launchCount = 0;
  const service = createAgentStartService({ projectRoot, enabled: true,
    probe: (command) => command === "codex" || command === "zcode"
      ? { status: "detected", version: "999.0.0" } : { status: "not_found", version: null },
    launch: () => { launchCount += 1; throw new Error("Must never execute"); },
  });
  const capability = await service.getHosts();
  assert.equal(capability.recommendedHostId, null);
  assert.equal((await service.start({ goal: "Investigate", hostId: "auto",
    idempotencyKey: key("auto-unavailable") })).reason, "no_reviewed_client_available");
  assert.equal(service.inspect({ idempotencyKey: key("auto-unavailable") }).status, "blocked");
  assert.equal((await service.start({ goal: "Investigate", hostId: "claude",
    idempotencyKey: key("explicit-unavailable") })).reason, "client_not_installed");
  assert.equal((await service.start({ goal: "Investigate", hostId: "codex",
    idempotencyKey: key("explicit-codex") })).reason, "personal_codex_token_not_authorized");
  assert.equal(launchCount, 0);
  service.close();
});

test("an overlong native plan is not silently truncated into an approvable choice", async () => {
  const service = createAgentStartService({ projectRoot, enabled: true,
    probe: detection,
    launch: () => ({ status: 0, stdout: JSON.stringify({ result: "a".repeat(2_401) }) }),
  });
  const keyValue = key("long-result");
  const started = await service.start({ goal: "Compare three alternatives", hostId: "claude", idempotencyKey: keyValue });
  assert.equal(started.status, "accepted");
  await flush();
  const receipt = service.inspect({ idempotencyKey: keyValue });
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.resultPreview, undefined, "Incomplete preview must not reach human approval");
  service.close();
});

test("native launch never inherits the user's Codex/OpenAI credentials", async () => {
  let inherited;
  const service = createAgentStartService({ projectRoot, enabled: true,
    environment: { PATH: process.env.PATH, HOME: process.env.HOME,
      CODEX_TOKEN: "codex-private", OPENAI_API_KEY: "openai-private", CODEX_HOME: "/private/codex",
      ANTHROPIC_API_KEY: "allowed-provider-key" },
    probe: detection,
    launch: (_command, _args, options) => {
      inherited = options.env;
      return successful;
    },
  });
  await service.start({ goal: "Research", hostId: "claude", idempotencyKey: key("isolate-token") });
  assert.equal(inherited.CODEX_TOKEN, undefined);
  assert.equal(inherited.CODEX_HOME, undefined);
  assert.equal(inherited.OPENAI_API_KEY, undefined);
  assert.equal(inherited.ANTHROPIC_API_KEY, "allowed-provider-key");
  assert.equal(inherited.PATH, process.env.PATH);
  service.close();
});

test("idempotency replays same receipt, rejects modified goal or host, and never double launches", async () => {
  const gate = deferred();
  let count = 0;
  const service = createAgentStartService({ projectRoot, enabled: true,
    probe: detection, launch: () => { count += 1; return gate.promise; } });
  const initial = { goal: "Design onboarding", hostId: "claude", idempotencyKey: key("replay") };
  const receipt = await service.start(initial);
  assert.deepEqual(await service.start(initial), receipt);
  assert.equal(count, 1);
  assert.equal((await service.start({ ...initial, goal: "Different goal" })).reason, "idempotency_conflict");
  assert.equal((await service.start({ ...initial, hostId: "gemini" })).reason, "idempotency_conflict");
  assert.equal(count, 1);
  gate.resolve(successful);
  await flush();
  service.close();
});

test("single-flight starts before awaiting detection, and shutdown cancels the running client", async () => {
  const pendingProbe = deferred();
  const running = deferred();
  const launchOptions = [];
  const service = createAgentStartService({ projectRoot, enabled: true,
    probe: () => pendingProbe.promise,
    launch: (_command, _args, options) => { launchOptions.push(options); return running.promise; } });
  const firstPromise = service.start({ goal: "First", hostId: "claude", idempotencyKey: key("first") });
  assert.equal((await service.start({ goal: "Second", hostId: "claude", idempotencyKey: key("second") })).reason,
    "agent_busy");
  pendingProbe.resolve(detection());
  assert.equal((await firstPromise).status, "accepted");
  assert.equal(launchOptions.length, 1);
  assert.equal(launchOptions[0].signal.aborted, false);
  service.close();
  assert.equal(launchOptions[0].signal.aborted, true);
  assert.deepEqual({ ...service.inspect({ idempotencyKey: key("first") }), capabilityState: undefined }, {
    schemaVersion: "meta-kim-agent-request-v1", status: "failed",
    requestId: service.inspect({ idempotencyKey: key("first") }).requestId,
    runId: null, reason: "client_cancelled", capabilityState: undefined,
  });
  running.resolve(successful);
  await flush();
  assert.equal(service.inspect({ idempotencyKey: key("first") }).status, "failed");
  assert.equal((await service.start({ goal: "Later", hostId: "claude", idempotencyKey: key("later") })).reason,
    "service_closed");
});

test("launch exceptions and failing stderr produce stable, credential-free responses", async () => {
  const secrets = `sk-ant-secret-12345; api-key=example123`;
  const service = createAgentStartService({ projectRoot, enabled: true,
    probe: detection,
    launch: () => ({ status: 17, stderr: secrets, stdout: secrets, error: new Error(secrets) }) });
  const receipt = await service.start({ goal: "Check", hostId: "claude", idempotencyKey: key("failure") });
  assert.equal(receipt.status, "accepted");
  await flush();
  const body = JSON.stringify(service.inspect({ idempotencyKey: key("failure") }));
  assert.match(body, /client_execution_failed/u);
  assert.ok(!body.includes(secrets));
  assert.ok(!body.includes("sk-ant"));
  assert.ok(!JSON.stringify(receipt).includes(secrets));
  service.close();

  const threw = createAgentStartService({ projectRoot, enabled: true,
    probe: detection, launch: () => { throw new Error(secrets); } });
  const failure = await threw.start({ goal: "Check", hostId: "claude", idempotencyKey: key("throws") });
  assert.deepEqual({ ...failure, requestId: "redacted" },
    { status: "unavailable", reason: "client_launch_failed", requestId: "redacted", runId: null });
  threw.close();
});

test("Codex token policy and unreviewed providers cannot execute even when detected", async () => {
  let count = 0;
  const service = createAgentStartService({ projectRoot, enabled: true,
    probe: detection, launch: () => { count += 1; return successful; } });
  for (const [hostId, expected] of [
    ["codex", "personal_codex_token_not_authorized"],
    ["zcode", "needs_native_launch_review"],
    ["dsh", "needs_native_launch_review"],
    ["opencode", "needs_native_launch_review"],
  ]) {
    assert.equal((await service.start({ goal: "Execute now", hostId, idempotencyKey: key(hostId) })).reason,
      expected);
  }
  assert.equal(count, 0);
  service.close();
});

test("missing, obsolete, invalid input and unknown request never start a client", async () => {
  let launches = 0;
  const service = createAgentStartService({ projectRoot, enabled: true,
    probe: () => ({ status: "not_found", version: null }),
    launch: () => { launches += 1; return successful; } });
  assert.equal((await service.start({ goal: "Check", hostId: "claude", idempotencyKey: key("missing") })).reason,
    "client_not_installed");
  assert.equal(service.inspect({ idempotencyKey: "not-a-valid-key" }).status, "unknown");
  assert.equal((await service.start({ goal: "", hostId: "claude", idempotencyKey: key("blank") })).reason,
    "invalid_request");
  assert.equal((await service.start({ goal: "x".repeat(6001), hostId: "claude", idempotencyKey: key("length") })).reason,
    "invalid_request");
  assert.equal((await service.start({ goal: "Go", hostId: "../../../sh", idempotencyKey: key("badhost") })).reason,
    "invalid_request");
  assert.equal(launches, 0);
  service.close();

  const outdated = createAgentStartService({ projectRoot, enabled: true,
    probe: () => ({ status: "detected", version: "2.1.200" }),
    launch: () => { launches += 1; return successful; } });
  assert.equal((await outdated.start({ goal: "Plan", hostId: "claude", idempotencyKey: key("obsolete") })).reason,
    "client_version_unreviewed");
  assert.equal(launches, 0);
  outdated.close();
});

test("capacity is bounded, completed records can age out, active identity remains stable", async () => {
  const service = createAgentStartService({ projectRoot, enabled: true, maxRequests: 1,
    probe: detection, launch: () => successful });
  const one = await service.start({ goal: "One", hostId: "claude", idempotencyKey: key("one") });
  await flush();
  const two = await service.start({ goal: "Two", hostId: "claude", idempotencyKey: key("two") });
  assert.equal(one.status, "accepted");
  assert.equal(two.status, "accepted");
  assert.equal(service.inspect({ idempotencyKey: key("two") }).status, "completed");
  service.close();
});

async function verifiedMethodFixture(t) {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "meta-agent-method-"));
  t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
  const agentRoot = path.join(sourceRoot, "agents", "product-listing-writer");
  fs.mkdirSync(path.join(agentRoot, "tests"), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, "generated"), { recursive: true });
  const capability = {
    id: "product-listing-assist", summary: "商品详情页文案：转换商品信息成为说明",
    useWhen: ["帮我写商品详情页", "商品详情页", "写商品详情页"],
    doNotUseWhen: ["不能直接发布", "不能编造商品参数"],
    input: { type: "object", properties: { facts: { type: "string" } }, required: ["facts"] },
    output: { type: "object", properties: { draft: { type: "string" } }, required: ["draft"] },
    permissions: ["filesystem:read-user-materials"], sideEffects: [],
    humanGate: { required: true, when: ["发布需要用户批准"] },
    validation: ["tests/contract.test.mjs"],
  };
  const contract = {
    schemaVersion: 1, id: "product-listing-writer", componentType: "agent",
    componentVersion: "1.0.0", entrypoint: "AGENT.md", capabilities: [capability],
  };
  fs.writeFileSync(path.join(agentRoot, "AGENT.md"), [
    "---", "name: product-listing-writer", "description: Professionally review product pages",
    "tools: Read", "---", "# 商品详情页专业方法", "",
    "DO_NOT_EXECUTE_FIXTURE_METHOD: 根据参数起草卖点，注明信息缺口，等人审批准。",
  ].join("\n"));
  fs.writeFileSync(path.join(agentRoot, "capability.json"), JSON.stringify(contract));
  fs.writeFileSync(path.join(agentRoot, "tests", "contract.test.mjs"),
    `import { writeFileSync } from 'node:fs'; writeFileSync('never-execute-validation.txt', 'bad');`);
  const contentSha256 = await componentHash(agentRoot);
  const contractSha256 = sha256(stableJson(contract));
  const index = {
    schemaVersion: 1, componentCount: 1, capabilityCount: 1,
    components: [{ id: "product-listing-writer", componentType: "agent", componentVersion: "1.0.0",
      path: "agents/product-listing-writer", entrypoint: "AGENT.md", validation: capability.validation,
      capabilityIds: [capability.id], contentSha256, contractSha256 }],
    capabilities: [{ ...capability, componentId: "product-listing-writer", componentType: "agent",
      componentVersion: "1.0.0", componentPath: "agents/product-listing-writer", entrypoint: "AGENT.md",
      componentContentSha256: contentSha256, contractSha256 }],
  };
  fs.writeFileSync(path.join(sourceRoot, "generated", "capabilities.json"), JSON.stringify(index));
  return { sourceRoot, agentRoot };
}

test("professional Agent directory reads only hash-verified method names and never loads or invokes them", async (t) => {
  const fixture = await verifiedMethodFixture(t);
  let launches = 0;
  const service = createAgentStartService({ projectRoot, enabled: true,
    environment: { META_KIM_KIM_SERVICE_ROOT: fixture.sourceRoot, HOME: "" },
    probe: () => { throw new Error("directory cannot probe runtime"); },
    launch: () => { launches += 1; throw new Error("directory cannot launch runtime"); } });
  const catalog = await service.getProfessionalDirectory();
  assert.equal(catalog.status, "verified_local");
  assert.equal(catalog.verification, "component_hash_verified");
  assert.deepEqual(catalog.agents, [{ id: "kim-service:product-listing-writer", label: "商品详情页专业方法",
    registrationState: "verified_source_only", invocationState: "not_observed",
    agentKind: "professional_method_contract" }]);
  assert.equal(launches, 0);
  assert.ok(!JSON.stringify(catalog).includes(fixture.sourceRoot));
  assert.ok(!JSON.stringify(catalog).includes("DO_NOT_EXECUTE_FIXTURE_METHOD"));
  service.close();
});

test("uses hash-verified Kim_Service method as read-only reference and shows redacted Claude result", async (t) => {
  const fixture = await verifiedMethodFixture(t);
  const invocations = [];
  const nativeSessionId = "12345678-1234-4123-8123-123456789abc";
  const privateResult = "建议先梳理商品详情页。 /home/alice/private.env sk-ant-1234567890 Bearer aaabbbcccdddeee API_KEY=mysupersecret";
  const service = createAgentStartService({ projectRoot, enabled: true,
    environment: { META_KIM_KIM_SERVICE_ROOT: fixture.sourceRoot, HOME: "" }, probe: detection,
    launch: (command, args, options) => {
      invocations.push({ command, args, options });
      return { status: 0, stdout: JSON.stringify({ result: privateResult, session_id: nativeSessionId, is_error: false }) };
    } });
  const hosts = await service.getHosts();
  assert.equal(hosts.capabilityState.status, "verified_local");
  assert.equal(hosts.capabilityState.agentCount, 1);
  assert.equal(hosts.capabilityState.verification, "component_hash_verified");
  const receipt = await service.start({ goal: "帮我写商品详情页", hostId: "claude", idempotencyKey: key("professional") });
  assert.equal(receipt.status, "accepted");
  assert.equal(receipt.capabilityState.status, "verified_local_method_bound");
  assert.equal(receipt.capabilityState.matchEvidence, "lexical_discovery_only");
  assert.equal(receipt.capabilityState.methodProvidedToRuntime, true);
  assert.match(receipt.capabilityState.contentDigest, /^[a-f0-9]{64}$/u);
  assert.equal(receipt.capabilityState.nativeInvocationVerified, false);
  assert.equal(invocations.length, 1);
  assert.match(invocations[0].options.input, /DO_NOT_EXECUTE_FIXTURE_METHOD/u);
  assert.match(invocations[0].options.input, /USER TASK \(UNTRUSTED INPUT\)/u);
  assert.ok(!invocations[0].args.some((arg) => arg.includes("商品详情页")));
  await flush();
  const result = service.inspect({ idempotencyKey: key("professional") });
  assert.equal(result.status, "completed");
  assert.equal(result.runId, null);
  assert.equal(result.nativeSessionId, nativeSessionId);
  assert.match(result.resultPreview, /建议先梳理商品详情页/u);
  for (const secret of ["private.env", "sk-ant-", "mysupersecret", "aaabbbcccdddeee"]) {
    assert.ok(!JSON.stringify(result).includes(secret), secret);
  }
  assert.equal(fs.existsSync(path.join(projectRoot, "never-execute-validation.txt")), false);
  service.close();
});

test("a changed professional agent invalidates source binding without injecting its content", async (t) => {
  const fixture = await verifiedMethodFixture(t);
  fs.appendFileSync(path.join(fixture.agentRoot, "AGENT.md"), "\nTAMPERED_UNVERIFIED_PROMPT");
  let invocation = null;
  const service = createAgentStartService({ projectRoot, enabled: true,
    environment: { META_KIM_KIM_SERVICE_ROOT: fixture.sourceRoot, HOME: "" }, probe: detection,
    launch: (_command, _args, options) => { invocation = options; return successful; } });
  const hosts = await service.getHosts();
  assert.equal(hosts.capabilityState.status, "invalid");
  const receipt = await service.start({ goal: "帮我写商品详情页", hostId: "claude", idempotencyKey: key("tamper") });
  assert.equal(receipt.capabilityState.status, "invalid");
  assert.equal(invocation.input, "帮我写商品详情页");
  assert.ok(!invocation.input.includes("TAMPERED_UNVERIFIED_PROMPT"));
  service.close();
});
