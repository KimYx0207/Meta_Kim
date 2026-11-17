import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createAgentStartService } from "../../src/application/agent/agent-start-service.mjs";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const detection = (command) => command === "claude"
  ? { status: "detected", version: "2.1.319 (Claude Code)" }
  : { status: "detected", version: "0.69.0" };
const request = (suffix) => ({ goal: "Build a cross-border ecommerce platform", hostId: "claude",
  idempotencyKey: `native-b2-${suffix}-20261117`, selectedStrategy: "B: human gate",
  selectionReason: "Sensitive publishing requires review", planPreview: "A: automatic. B: gated.",
  planDigest: "a".repeat(64) });
const design = () => ({
  system: { title: "Commerce platform", goal: "Enable B2B ecommerce", architecture: "Modular services with audit",
    techStack: "Node.js with PostgreSQL", acceptance: ["All approvals traced"] },
  modules: [{ id: "research", title: "Evidence", objective: "Research requirements",
    inputContract: ["Business brief"], outputContract: ["Reviewable research"], boundaries: [],
    acceptance: ["Trace to source"], dependencies: [] },
  { id: "review", title: "Review", objective: "Approve business strategy",
    inputContract: ["Research result"], outputContract: ["Signed decision"], boundaries: ["No writes"],
    acceptance: ["Human decision recorded"], dependencies: ["research"] }],
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("B2 native draft reuses Claude's reviewed plan-only launch, chosen B1 plan, and verified-reference hook", async () => {
  const calls = [];
  const service = createAgentStartService({ projectRoot, enabled: true, probe: detection,
    launch: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: JSON.stringify({ result: JSON.stringify(design()) }) };
    } });
  const input = request("verified");
  assert.equal((await service.startDesignDraft(input)).status, "accepted");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "claude");
  assert.deepEqual(calls[0].args.slice(2, 6), ["--permission-mode", "plan", "--permission-prompts", "none"]);
  assert.ok(calls[0].args.includes("--no-chrome"));
  assert.ok(calls[0].args.includes("--output-format"));
  assert.equal(calls[0].options.cwd, projectRoot.replace(/\/$/u, ""));
  assert.match(calls[0].options.input, /originalUserGoal/u);
  assert.match(calls[0].options.input, /selectedStrategy/u);
  assert.match(calls[0].options.input, /Sensitive publishing requires review/u);
  assert.match(calls[0].options.input, /planDigest/u);
  assert.ok(!calls[0].args.join(" ").includes(input.goal));
  await flush();
  const output = service.inspectDesignDraft({ idempotencyKey: input.idempotencyKey });
  assert.equal(output.status, "completed");
  assert.deepEqual(output.design, design());
  assert.equal(output.runId, null);
  assert.equal(output.nativeEvidenceVerified, false);
  assert.equal(output.selectedHostId, "claude");
  service.close();
});

test("malformed, incomplete, cyclic and oversized B2 output never become editable completed designs", async () => {
  const malformed = [
    "Not JSON",
    JSON.stringify({ system: design().system, modules: [] }),
    JSON.stringify({ ...design(), modules: [{ ...design().modules[0], dependencies: ["missing"] }] }),
    JSON.stringify({ ...design(), modules: [
      { ...design().modules[0], dependencies: ["review"] }, design().modules[1]] }),
    JSON.stringify(design()) + " ".repeat(130 * 1024),
  ];
  for (const [index, text] of malformed.entries()) {
    const input = request(`invalid-${index}`);
    const service = createAgentStartService({ projectRoot, enabled: true, probe: detection,
      launch: () => ({ status: 0, stdout: JSON.stringify({ result: text }) }) });
    assert.equal((await service.startDesignDraft(input)).status, "accepted");
    await flush();
    const output = service.inspectDesignDraft({ idempotencyKey: input.idempotencyKey });
    assert.equal(output.status, "failed", `invalid case ${index}`);
    assert.equal(output.design, undefined);
    assert.equal(output.runId, null);
    service.close();
  }
});

test("native B2 fields redact private tokens and machine paths without returning raw transcripts", async () => {
  const privateDesign = design();
  privateDesign.system.architecture = "Use sk-ant-secretkey00001234 and /home/alice/private/project";
  privateDesign.modules[0].boundaries = ["Secret api_key=outside-secret-123456" ];
  const input = request("redacted-secret");
  const service = createAgentStartService({ projectRoot, enabled: true, probe: detection,
    launch: () => ({ status: 0, stdout: JSON.stringify({ result: JSON.stringify(privateDesign),
      stderr: "untrusted sk-ant-stderrsecret-123456", unexpectedPrivate: "never-disclose" }) }) });
  await service.startDesignDraft(input);
  await flush();
  const receipt = service.inspectDesignDraft({ idempotencyKey: input.idempotencyKey });
  assert.equal(receipt.status, "completed");
  assert.match(receipt.design.system.architecture, /凭据已隐藏/u);
  assert.match(receipt.design.system.architecture, /本地路径/u);
  assert.match(receipt.design.modules[0].boundaries[0], /凭据字段已隐藏/u);
  assert.ok(!JSON.stringify(receipt).includes("outside-secret"));
  assert.ok(!JSON.stringify(receipt).includes("never-disclose"));
  assert.ok(!JSON.stringify(receipt).includes("stderrsecret"));
  service.close();
});

test("Gemini B1 and B2 cannot launch even if the CLI claims a reviewed plan-mode version", async () => {
  let calls = 0;
  const service = createAgentStartService({ projectRoot, enabled: true,
    probe: (command) => command === "claude" ? { status: "not_found", version: null }
      : { status: "detected", version: "999.0.0" },
    launch: () => { calls += 1; throw new Error("Gemini must not be launched"); },
  });
  const hosts = await service.getHosts();
  assert.equal(hosts.hosts.find((host) => host.id === "gemini").reason,
    "gemini_noninteractive_plan_auto_execution_risk");
  assert.equal(hosts.hosts.find((host) => host.id === "gemini").launchSupported, false);
  assert.equal((await service.start({ goal: "Need options", hostId: "gemini",
    idempotencyKey: "gemini-b1-never-20261117" })).reason,
  "gemini_noninteractive_plan_auto_execution_risk");
  assert.equal((await service.startDesignDraft({ ...request("gemini-no-write"), hostId: "gemini" })).reason,
    "gemini_noninteractive_plan_auto_execution_risk");
  assert.equal((await service.startDesignDraft({ ...request("auto-no-write"), hostId: "auto" })).reason,
    "no_reviewed_client_available");
  assert.equal(calls, 0);
  service.close();
});
