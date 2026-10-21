import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { runCodexDesktopEngineeringSessionProducer, runCodexDesktopSessionCapabilityProducer, runControlledRuntimeCapabilityProducer } from "../../scripts/runtime-capability-producers.mjs";
import { readCodexDesktopEngineeringEvidence, readCodexDesktopSessionEvidence } from "../../scripts/live-acceptance/read-codex-session-evidence.mjs";
import { validateRuntimeCapabilityAcceptanceAttemptEvidence } from "../../scripts/runtime-capability-acceptance.mjs";
import { loadEffectiveRuntimeCapabilityClaims } from "../../scripts/effective-runtime-capability-claims.mjs";
import { standardRuntimeObservationSet } from "../../scripts/runtime-execution-gate.mjs";
import { copyRuntimeCapabilityObservationSnapshot } from "../../scripts/verify-packed-user-install-update.mjs";
const packageRoot = path.resolve(import.meta.dirname, "../..");
const temporaryRoots = new Set();
after(() => { for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true }); });
const sha = value => createHash("sha256").update(value).digest("hex");
const jsonl = records => records.map(JSON.stringify).join("\n");
function fixtureProject() { const root = mkdtempSync(path.join(tmpdir(), "meta-kim-portable-advisory-")); temporaryRoots.add(root); mkdirSync(path.join(root, ".meta-kim/state/default/imports"), { recursive: true }); return root; }
function codexDesktopFixture() {
  const codexHome = mkdtempSync(path.join(tmpdir(), "meta-kim-codex-desktop-"));
  temporaryRoots.add(codexHome);
  const sessions = path.join(codexHome, "sessions", "2026", "07", "28");
  mkdirSync(sessions, { recursive: true });
  const threadId = "11111111-1111-4111-8111-111111111111";
  const childSessionId = "22222222-2222-4222-8222-222222222222";
  const nonce = "33333333-3333-4333-8333-333333333333";
  const marker = `META_KIM_CAPABILITY_SUBAGENT_${nonce}`;
  const callId = "call_desktop_fixture";
  const now = new Date().toISOString();
  const parent = [
    { timestamp: now, type: "session_meta", payload: { id: threadId, originator: "Codex Desktop", source: "vscode", cli_version: "codex-desktop-test" } },
    { timestamp: now, type: "event_msg", payload: { type: "fixture_padding", value: "x".repeat(8 * 1024) } },
    { timestamp: now, type: "response_item", payload: { type: "function_call", name: "spawn_agent", namespace: "collaboration", arguments: "{}", call_id: callId } },
    { timestamp: now, type: "event_msg", payload: { type: "sub_agent_activity", event_id: callId, agent_thread_id: childSessionId, agent_path: "/root/fixture_child", kind: "started" } },
    { timestamp: now, type: "response_item", payload: { type: "function_call_output", call_id: callId, output: JSON.stringify({ task_name: "/root/fixture_child" }) } },
    { timestamp: now, type: "response_item", payload: { type: "agent_message", id: "fixture-final", author: "/root/fixture_child", recipient: "/root", content: [{ type: "input_text", text: `Message Type: FINAL_ANSWER\nPayload:\n${marker}` }] } },
  ];
  const child = [
    { timestamp: now, type: "session_meta", payload: { id: childSessionId, originator: "Codex Desktop", source: { subagent: { thread_spawn: { parent_thread_id: threadId } } }, cli_version: "codex-desktop-test" } },
    { timestamp: now, type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: marker } },
    { timestamp: now, type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: marker }] } },
    { timestamp: now, type: "event_msg", payload: { type: "task_complete", last_agent_message: marker } },
  ];
  writeFileSync(path.join(sessions, `rollout-parent-${threadId}.jsonl`), `${jsonl(parent)}\n`, "utf8");
  writeFileSync(path.join(sessions, `rollout-child-${childSessionId}.jsonl`), `${jsonl(child)}\n`, "utf8");
  return { codexHome, threadId, childSessionId, marker, sinceMs: Date.now() - 5_000 };
}

function codexDesktopEngineeringFixture(projectRoot) {
  const codexHome = mkdtempSync(path.join(tmpdir(), "meta-kim-codex-desktop-engineering-"));
  temporaryRoots.add(codexHome);
  const sessions = path.join(codexHome, "sessions", "2026", "07", "28");
  mkdirSync(sessions, { recursive: true });
  const threadId = "66666666-6666-4666-8666-666666666666";
  const nonce = "77777777-7777-4777-8777-777777777777";
  const marker = `META_KIM_CAPABILITY_ENGINEERING_${nonce}`;
  const workspacePath = path.join(projectRoot, ".meta-kim", "state", "default", "runtime-capability-producers", "workspaces", `desktop-engineering-${nonce}`);
  const file = path.join(workspacePath, "meta-kim-probe.txt");
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(file, `after-${marker}\n`, "utf8");
  const now = new Date().toISOString();
  const slashFile = file.replaceAll("\\", "/");
  const call = (id, input) => ({ timestamp: now, type: "response_item", payload: { type: "custom_tool_call", name: "exec", status: "completed", call_id: id, input } });
  const output = (id, text = "{}") => ({ timestamp: now, type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: [{ type: "input_text", text }] } });
  const patchEnd = (type, change) => ({ timestamp: now, type: "event_msg", payload: { type: "patch_apply_end", success: true, status: "completed", stdout: `Success ${slashFile}`, changes: { [file]: { type, ...change } } } });
  const records = [
    { timestamp: now, type: "session_meta", payload: { id: threadId, originator: "Codex Desktop", source: "vscode", cli_version: "codex-desktop-engineering-test" } },
    call("desktop-shell", `const r=await tools.shell_command({command:"New-Item -ItemType Directory -Path '${workspacePath}'"});`),
    output("desktop-shell", `Exit code: 0\n${workspacePath}`),
    call("desktop-add", `const patch="*** Begin Patch\\n*** Add File: ${slashFile}\\n+before-${marker}\\n*** End Patch"; text(await tools.apply_patch(patch));`),
    patchEnd("add", { content: `before-${marker}\n` }),
    output("desktop-add"),
    call("desktop-read-before", `const r=await tools.shell_command({command:"Get-Content -LiteralPath '${file}'"});`),
    output("desktop-read-before", `Exit code: 0\nbefore-${marker}`),
    call("desktop-update", `const patch="*** Begin Patch\\n*** Update File: ${slashFile}\\n@@\\n-before-${marker}\\n+after-${marker}\\n*** End Patch"; text(await tools.apply_patch(patch));`),
    patchEnd("update", { unified_diff: `@@ -1 +1 @@\n-before-${marker}\n+after-${marker}\n` }),
    output("desktop-update"),
    call("desktop-read-after", `const r=await tools.shell_command({command:"Get-Content -LiteralPath '${file}'"});`),
    output("desktop-read-after", `Exit code: 0\nafter-${marker}`),
  ];
  writeFileSync(path.join(sessions, `rollout-desktop-${threadId}.jsonl`), `${jsonl(records)}\n`, "utf8");
  return { codexHome, threadId, marker, workspacePath, sinceMs: Date.now() - 5_000 };
}

function controlledFixtureExecutor(request) {
  const marker = request.prompt.match(/META_KIM_CAPABILITY_[A-Z0-9_]+_[0-9a-f-]{36}/u)?.[0];
  assert.ok(marker);
  if (request.capability === "shell") writeFileSync(path.join(request.workspace, "meta-kim-probe.txt"), `shell-${marker}\n`);
  if (request.capability === "apply_patch / edit") writeFileSync(path.join(request.workspace, "meta-kim-probe.txt"), `after-${marker}\n`);
  let records;
  if (request.runtime === "codex") {
    const item = ["agent", "subagent"].includes(request.capability)
      ? { id: "fixture-agent", type: "collab_tool_call", tool: "spawn_agent", message: marker, receiver_thread_id: "fixture-child" }
      : request.capability === "apply_patch / edit" ? { id: "fixture-edit", type: "file_change" }
      : { id: "fixture-tool", type: "command_execution", command: request.capability === "filesystem" ? `Get-Content meta-kim-probe.txt # ${marker}` : `bounded-probe ${marker}` };
    records = [{ type: "thread.started", thread_id: "fixture-thread" }, { type: "item.started", item: { ...item, status: "in_progress" } },
      { type: "item.completed", item: { ...item, status: "completed", ...(item.type === "command_execution" ? { exit_code: 0, aggregated_output: marker } : { result: marker }) } }];
  } else {
    const name = ["agent", "subagent"].includes(request.capability) ? "Agent" : request.capability === "shell" ? "Bash" : request.capability === "filesystem" ? "Read" : "Edit";
    records = [{ type: "assistant", session_id: "fixture-session", message: { id: "fixture-message", content: [{ type: "tool_use", id: "fixture-call", name, input: { path: "meta-kim-probe.txt", marker } }] } },
      { type: "user", session_id: "fixture-session", tool_use_result: name === "Agent" ? { agentId: "fixture-child" } : {}, message: { content: [{ type: "tool_result", tool_use_id: "fixture-call", content: marker }] } }];
  }
  return { status: 0, signal: null, stdout: jsonl(records), stderr: "", runtimeVersion: `${request.runtime}-fixture-1` };
}

function nativeFixtureExecutor(request) {
  const marker = request.prompt.match(/META_KIM_CAPABILITY_[A-Z0-9_]+_[0-9a-f-]{36}/u)?.[0];
  let records;
  if (request.runtime === "claude_code") {
    assert.equal(request.capability, "shell");
    writeFileSync(path.join(request.workspace, "meta-kim-probe.txt"), `shell-${marker}`);
    const session = "88888888-8888-4888-8888-888888888888";
    records = [{ type: "system", subtype: "init", session_id: session, tools: ["Bash"] },
      { type: "assistant", session_id: session, message: { id: "native-message", content: [{ type: "tool_use", id: "native-shell", name: "Bash", input: { command: `printf '%s' 'shell-${marker}' > meta-kim-probe.txt` } }] } },
      { type: "user", session_id: session, message: { content: [{ type: "tool_result", tool_use_id: "native-shell", content: "", is_error: false }] } },
      { type: "result", subtype: "success", session_id: session, is_error: false, result: "finished" }];
  } else {
    assert.equal(request.capability, "agent");
    const parent = "99999999-9999-4999-8999-999999999999", child = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const spawn = { id: "native-spawn", type: "collab_tool_call", tool: "spawn_agent", sender_thread_id: parent, receiver_thread_ids: [child], prompt: `Return exactly ${marker}`, agents_states: { [child]: { status: "running", message: null } } };
    const wait = { id: "native-wait", type: "collab_tool_call", tool: "wait", sender_thread_id: parent, receiver_thread_ids: [child], prompt: null };
    records = [{ type: "thread.started", thread_id: parent }, { type: "turn.started" },
      { type: "item.started", item: { ...spawn, receiver_thread_ids: [], agents_states: {}, status: "in_progress" } }, { type: "item.completed", item: { ...spawn, status: "completed" } },
      { type: "item.started", item: { ...wait, status: "in_progress", agents_states: { [child]: { status: "running", message: null } } } },
      { type: "item.completed", item: { ...wait, status: "completed", agents_states: { [child]: { status: "completed", message: marker } } } }, { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }];
  }
  return { status: 0, signal: null, stdout: `${jsonl(records)}\n`, stderr: "", runtimeVersion: `${request.runtime}-native-fixture-1`, runtimeIsolation: "official_cli_existing_login_fresh_workspace_structured_stream", authObservation: { kind: "official_existing_login", runtime: request.runtime, provider: request.runtime === "codex" ? "chatgpt" : "firstParty" } };
}

async function portableFixture(kind) {
  const sourceRoot = fixtureProject();
  const targetRoot = fixtureProject();
  const fixture = kind === "agent" ? codexDesktopFixture() : codexDesktopEngineeringFixture(sourceRoot);
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = fixture.codexHome;
  let produced;
  try {
    produced = kind === "agent"
      ? await runCodexDesktopSessionCapabilityProducer({ projectRoot: sourceRoot, ...fixture, reader: options => readCodexDesktopSessionEvidence(options) })
      : await runCodexDesktopEngineeringSessionProducer({ projectRoot: sourceRoot, ...fixture, reader: options => readCodexDesktopEngineeringEvidence(options) });
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  }
  const profileRoot = path.join(targetRoot, ".meta-kim/state/default");
  const sourceProfile = path.join(sourceRoot, ".meta-kim/state/default");
  const allResults = [...produced.results];
  for (const claim of standardRuntimeObservationSet()) {
    if (allResults.some(result => result.receipt.runtime === claim.runtime && result.receipt.capability === claim.capability && result.receipt.mode === claim.mode)) continue;
    const native = (claim.runtime === "claude_code" && claim.capability === "shell") || (claim.runtime === "codex" && claim.capability === "agent");
    allResults.push(runControlledRuntimeCapabilityProducer({ projectRoot: sourceRoot, runtime: claim.runtime, capability: claim.capability, ...(native ? { source: "native_cli_stream", executor: nativeFixtureExecutor } : { executor: controlledFixtureExecutor }) }));
  }
  const bindings = [];
  const copy = relative => {
    const bytes = readFileSync(path.join(sourceProfile, relative));
    const destination = path.join(profileRoot, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
    return sha(bytes);
  };
  for (const result of allResults) {
    const attempt = result.acceptance.record;
    const attemptSha256 = copy(`runtime-capability-acceptance/attempts/${attempt.attemptId}.json`);
    const receiptSha256 = copy(attempt.sourceReport.path);
    const rawArtifactSha256 = copy(result.receipt.rawArtifact.path);
    bindings.push({ runtime: attempt.runtime, capability: attempt.capability, mode: attempt.mode, attemptId: attempt.attemptId, observedAt: attempt.observedAt, attemptSha256, receiptSha256, rawArtifactSha256,
      ...(result.receipt.compositeLifecycle?.sourceCategory === "codex_desktop_sessions" ? { sourceWorkspacePath: fixture.workspacePath } : {}) });
  }
  const snapshot = { schemaVersion: "meta-kim-runtime-advisory-snapshot-v1", evidenceClass: "read_only_advisory_snapshot", observedInCurrentRun: false, executionAuthority: false, sourceValidatedAt: new Date().toISOString(), sourceProfileRootDigest: sha(sourceProfile.replaceAll("\\", "/").toLowerCase()), bindings };
  const manifest = path.join(profileRoot, "runtime-capability-acceptance/advisory-snapshot.json");
  const save = () => writeFileSync(manifest, `${JSON.stringify(snapshot, null, 2)}\n`);
  save();
  // Only synthetic fixture sessions are removed. The portable target has never
  // received a sessions store or the original engineering workspace.
  rmSync(fixture.codexHome, { recursive: true, force: true });
  if (kind === "engineering") rmSync(fixture.workspacePath, { recursive: true, force: true });
  return { produced, allResults, profileRoot, targetRoot, snapshot, manifest, save };
}

test("portable Desktop fragments replay both semantic chains without original sessions or workspace", async context => {
  for (const kind of ["agent", "engineering"]) await context.test(kind, async () => {
    const fixture = await portableFixture(kind);
    for (const result of fixture.produced.results) {
      const attempt = result.acceptance.record;
      const replay = validateRuntimeCapabilityAcceptanceAttemptEvidence(attempt, { profileRoot: fixture.profileRoot, portableAdvisorySnapshot: true });
      assert.equal(replay.valid, true, replay.issues.join("\n"));
      const original = validateRuntimeCapabilityAcceptanceAttemptEvidence(attempt, { profileRoot: fixture.profileRoot, portableAdvisorySnapshot: false });
      assert.equal(original.valid, false, "ordinary validation must still require the original source");
      const release = validateRuntimeCapabilityAcceptanceAttemptEvidence(attempt, { profileRoot: fixture.profileRoot, portableAdvisorySnapshot: true, releaseResolution: true });
      assert.equal(release.valid, false);
      assert.match(release.issues.join("\n"), /portable advisory snapshots cannot satisfy release resolution/u);
    }
    assert.equal(readdirSync(fixture.targetRoot, { recursive: true }).some(name => /(?:^|[/\\])sessions(?:[/\\]|$)/u.test(name)), false);
    const state = loadEffectiveRuntimeCapabilityClaims({ packageRoot, projectRoot: fixture.targetRoot, allowTestReceipts: true });
    assert.equal(state.overlayStatus.applied.length, 10, state.issues.join("\n"));
    assert.ok(state.overlayStatus.applied.every(entry => entry.executionAuthority === false && entry.observedInCurrentRun === false));
  });
});

test("portable snapshot enforces complete exact labels, unique IDs, hashes and source validation time", async () => {
  const fixture = await portableFixture("engineering");
  const attempt = fixture.produced.results[0].acceptance.record;
  const original = structuredClone(fixture.snapshot);
  const mutations = [
    value => value.bindings.pop(),
    value => { value.bindings[0] = structuredClone(value.bindings[1]); },
    value => { value.bindings[0].attemptId = value.bindings[1].attemptId; },
    value => { value.bindings[0].rawArtifactSha256 = "invalid"; },
    value => { value.sourceValidatedAt = new Date(Date.now() + 60000).toISOString(); },
    value => { value.bindings.find(entry => entry.attemptId === attempt.attemptId).attemptSha256 = "0".repeat(64); },
    value => { value.bindings.find(entry => entry.attemptId === attempt.attemptId).receiptSha256 = "0".repeat(64); },
    value => { value.bindings.find(entry => entry.attemptId === attempt.attemptId).rawArtifactSha256 = "0".repeat(64); },
    value => { value.bindings.find(entry => entry.attemptId === attempt.attemptId).sourceWorkspacePath = path.join(fixture.targetRoot, "wrong-workspace"); },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(original);
    mutate(value);
    writeFileSync(fixture.manifest, JSON.stringify(value));
    const replay = validateRuntimeCapabilityAcceptanceAttemptEvidence(attempt, { profileRoot: fixture.profileRoot, portableAdvisorySnapshot: true });
    assert.equal(replay.valid, false, JSON.stringify(value));
  }
  rmSync(fixture.manifest);
  assert.equal(validateRuntimeCapabilityAcceptanceAttemptEvidence(attempt, { profileRoot: fixture.profileRoot, portableAdvisorySnapshot: true }).valid, false);
});

test("all non-Desktop controlled receipts enforce portable attempt, receipt, raw and observedAt bindings", async context => {
  const fixture = await portableFixture("engineering");
  const original = structuredClone(fixture.snapshot);
  for (const [runtime, native] of [["claude_code", false], ["claude_code", true], ["codex", true]]) await context.test(`${runtime} ${native ? "native_cli_stream" : "legacy"}`, () => {
    const result = fixture.allResults.find(result => result.receipt.runtime === runtime && !result.receipt.producer.id.includes("desktop") && (result.receipt.hostInvocation.request.source === "native_cli_stream") === native);
    assert.ok(result);
    const attempt = result.acceptance.record;
    for (const field of ["attemptSha256", "receiptSha256", "rawArtifactSha256", "observedAt"]) {
      const snapshot = structuredClone(original);
      const binding = snapshot.bindings.find(entry => entry.attemptId === attempt.attemptId);
      binding[field] = field === "observedAt" ? new Date(Date.parse(binding.observedAt) - 1000).toISOString() : "0".repeat(64);
      writeFileSync(fixture.manifest, JSON.stringify(snapshot));
      const direct = validateRuntimeCapabilityAcceptanceAttemptEvidence(attempt, { profileRoot: fixture.profileRoot, portableAdvisorySnapshot: true });
      assert.equal(direct.valid, false, `${runtime} ${field} mismatch must be rejected`);
      assert.match(direct.issues.join("\n"), /portable advisory .*binding mismatch/u);
      const state = loadEffectiveRuntimeCapabilityClaims({ packageRoot, projectRoot: fixture.targetRoot, allowTestReceipts: true });
      assert.equal(state.overlayStatus.applied.some(entry => entry.attemptId === attempt.attemptId), false, `${runtime} ${field} must not overlay`);
    }
  });
  fixture.save();
});

test("recent source validation never renews original observedAt TTL", async () => {
  const fixture = await portableFixture("agent");
  const attempt = fixture.produced.results[0].acceptance.record;
  const later = new Date(Date.parse(attempt.observedAt) + 2 * 24 * 60 * 60 * 1000).toISOString();
  fixture.snapshot.sourceValidatedAt = later;
  fixture.save();
  const replay = validateRuntimeCapabilityAcceptanceAttemptEvidence(attempt, { profileRoot: fixture.profileRoot, portableAdvisorySnapshot: true, now: later });
  assert.equal(replay.valid, false);
  assert.match(replay.issues.join("\n"), /source observation is stale/u);
  assert.equal(fixture.snapshot.bindings.find(entry => entry.attemptId === attempt.attemptId).observedAt, attempt.observedAt);
});

test("an advisory source cannot re-export any self-contained or Desktop observation as original evidence", () => {
  const sourceProjectRoot = fixtureProject();
  const targetProjectRoot = fixtureProject();
  const directory = path.join(sourceProjectRoot, ".meta-kim/state/default/runtime-capability-acceptance");
  mkdirSync(directory, { recursive: true });
  // The refusal precedes source loading, and does not depend on whether a
  // receipt reopens Desktop sessions or is a self-contained native CLI tape.
  writeFileSync(path.join(directory, "advisory-snapshot.json"), JSON.stringify({ schemaVersion: "meta-kim-runtime-advisory-snapshot-v1", bindings: standardRuntimeObservationSet().map((entry, index) => ({ ...entry, attemptId: `native-self-contained-${index}` })) }));
  assert.throws(() => copyRuntimeCapabilityObservationSnapshot({ sourceProjectRoot, targetProjectRoot }), /advisory snapshots cannot be re-exported/u);
  assert.equal(existsSync(path.join(targetProjectRoot, ".meta-kim/state/default/runtime-capability-acceptance")), false);
  assert.equal(existsSync(path.join(targetProjectRoot, ".meta-kim/state/default/runtime-capability-producers")), false);
});

test("portable replay rejects a changed selected original line even when the raw receipt hashes are rebound", async () => {
  const fixture = await portableFixture("engineering");
  const result = fixture.produced.results[0];
  const attempt = result.acceptance.record;
  const receipt = structuredClone(result.receipt);
  const rawPath = path.join(fixture.profileRoot, receipt.rawArtifact.path);
  const raw = readFileSync(rawPath, "utf8").replace("New-Item", "Remove-Item");
  writeFileSync(rawPath, raw);
  receipt.rawArtifact.sha256 = sha(raw);
  receipt.hostInvocation.result.stdoutSha256 = sha(raw);
  receipt.hostInvocation.resultDigest = sha(JSON.stringify(receipt.hostInvocation.result));
  receipt.compositeLifecycle.parentFragmentDigest = sha(raw);
  const { recordHash: oldHash, ...body } = receipt;
  receipt.recordHash = sha(JSON.stringify(body));
  const receiptPath = path.join(fixture.profileRoot, attempt.sourceReport.path);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  attempt.sourceReport.sha256 = sha(readFileSync(receiptPath));
  attempt.rawArtifactSha256 = sha(raw);
  const attemptPath = path.join(fixture.profileRoot, `runtime-capability-acceptance/attempts/${attempt.attemptId}.json`);
  writeFileSync(attemptPath, JSON.stringify(attempt));
  const binding = fixture.snapshot.bindings.find(entry => entry.attemptId === attempt.attemptId);
  Object.assign(binding, { attemptSha256: sha(readFileSync(attemptPath)), receiptSha256: attempt.sourceReport.sha256, rawArtifactSha256: receipt.rawArtifact.sha256 });
  fixture.save();
  const replay = validateRuntimeCapabilityAcceptanceAttemptEvidence(attempt, { profileRoot: fixture.profileRoot, portableAdvisorySnapshot: true });
  assert.equal(replay.valid, false);
  assert.match(replay.issues.join("\n"), /line digest mismatch/u);
});

