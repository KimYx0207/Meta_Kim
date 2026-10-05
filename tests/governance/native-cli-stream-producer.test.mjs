import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertRuntimeHostInvocationSuccess, runtimeHostInvocationError, nativeCliStreamInvocationArgs, runControlledRuntimeCapabilityProducer, runCodexCompositeEngineeringProducer, validateControlledProbeOptions } from "../../scripts/runtime-capability-producers.mjs";
import { produceRuntimeCapabilityAcceptance, validateRuntimeCapabilityAcceptanceAttemptEvidence, writeRuntimeCapabilityAcceptanceAttempt } from "../../scripts/runtime-capability-acceptance.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const jsonl = (records) => records.map(JSON.stringify).join("\n") + "\n";
const isolation = "official_cli_existing_login_fresh_workspace_structured_stream";
function project(t) {
  const root = mkdtempSync(path.join(tmpdir(), "meta-native-stream-test-"));
  mkdirSync(path.join(root, ".meta-kim", "state", "default", "imports"), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function marker(request) { return request.prompt.match(/META_KIM_CAPABILITY_[A-Z0-9_]+_[0-9a-f-]{36}/u)[0]; }
function completed(request, records) {
  return { status: 0, signal: null, stdout: jsonl(records), stderr: "", runtimeVersion: request.runtime === "codex" ? "codex-cli 0.157.1" : "2.1.236 (Claude Code)",
    runtimeIsolation: isolation, authObservation: { kind: "official_existing_login", runtime: request.runtime, provider: request.runtime === "codex" ? "chatgpt" : "firstParty" } };
}
function codexAgent(request) {
  const token = marker(request), parent = "11111111-1111-4111-8111-111111111111", child = "22222222-2222-4222-8222-222222222222";
  const spawn = { id: "spawn", type: "collab_tool_call", tool: "spawn_agent", sender_thread_id: parent, receiver_thread_ids: [child], prompt: `Return exactly ${token}`, agents_states: { [child]: { status: "running", message: null } } };
  const wait = { id: "wait", type: "collab_tool_call", tool: "wait", sender_thread_id: parent, receiver_thread_ids: [child], prompt: null };
  return completed(request, [
    { type: "thread.started", thread_id: parent }, { type: "turn.started" },
    { type: "item.started", item: { ...spawn, receiver_thread_ids: [], agents_states: {}, status: "in_progress" } }, { type: "item.completed", item: { ...spawn, status: "completed" } },
    { type: "item.started", item: { ...wait, status: "in_progress", agents_states: { [child]: { status: "running", message: null } } } },
    { type: "item.completed", item: { ...wait, status: "completed", agents_states: { [child]: { status: "completed", message: token } } } },
    { type: "item.completed", item: { id: "reasoning", type: "reasoning", text: "PRIVATE_NON_EVIDENCE_REASONING" } },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 10 } },
  ]);
}
function claudeShell(request) {
  const token = marker(request), session = "33333333-3333-4333-8333-333333333333";
  writeFileSync(path.join(request.workspace, "meta-kim-probe.txt"), `shell-${token}`);
  return completed(request, [
    { type: "system", subtype: "init", session_id: session, tools: ["Bash", "Read", "Edit"] },
    { type: "assistant", session_id: session, message: { id: "msg1", content: [{ type: "tool_use", id: "shell1", name: "Bash", input: { command: `printf '%s' 'shell-${token}' > meta-kim-probe.txt` } }] } },
    { type: "user", session_id: session, message: { content: [{ type: "tool_result", tool_use_id: "shell1", content: "", is_error: false }] } },
    { type: "result", subtype: "success", session_id: session, is_error: false, result: "finished" },
  ]);
}
function codexEngineering(request) {
  const token = marker(request), file = path.join(request.workspace, "meta-kim-engineering-probe.txt");
  writeFileSync(file, `after-${token}\n`);
  const commands = [
    { id: "write", type: "command_execution", command: `printf '%s' 'before-${token}' > meta-kim-engineering-probe.txt`, aggregated_output: "", exit_code: 0 },
    { id: "read-before", type: "command_execution", command: "cat meta-kim-engineering-probe.txt", aggregated_output: `before-${token}\n`, exit_code: 0 },
    { id: "edit", type: "file_change", changes: [{ path: file, kind: "update" }] },
    { id: "read-after", type: "command_execution", command: "cat meta-kim-engineering-probe.txt", aggregated_output: `after-${token}\n`, exit_code: 0 },
  ];
  return completed(request, [ { type: "thread.started", thread_id: "44444444-4444-4444-8444-444444444444" }, { type: "turn.started" },
    ...commands.flatMap(item => [{ type: "item.started", item: { ...item, status: "in_progress" } }, { type: "item.completed", item: { ...item, status: "completed" } }]),
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 10 } },
  ]);
}
function validation(produced, root) {
  return validateRuntimeCapabilityAcceptanceAttemptEvidence(produced.acceptance.record, { profileRoot: path.join(root, ".meta-kim", "state", "default") });
}

test("native invocation retains official login, execpolicy rules and actual native tools", () => {
  const codex = nativeCliStreamInvocationArgs({ runtime: "codex", workspace: "/tmp/probe", capability: "agent" });
  assert(codex.includes("--ephemeral")); assert(codex.includes("--json"));
  assert(!codex.includes("--ignore-rules")); assert(codex.includes("workspace-write"));
  assert(codex.includes("project_doc_max_bytes=0")); // optional prompt discovery is separate from execpolicy rules
  const claude = nativeCliStreamInvocationArgs({ runtime: "claude_code", workspace: "/tmp/probe", capability: "agent" });
  for (const flag of ["--safe-mode", "--no-session-persistence", "--forward-subagent-text", "--allowedTools"]) assert(claude.includes(flag));
  for (const flag of ["--bare", "--tools", "--dangerously-skip-permissions"]) assert(!claude.includes(flag));
  assert.throws(() => validateControlledProbeOptions({ runtime: "claude_code", source: "native_cli_stream", claudeMaxBudgetUsd: .1 }), /API/u);
});

test("Codex native agent stream retains complete replay evidence without reasoning", t => {
  const root = project(t);
  const result = runControlledRuntimeCapabilityProducer({ projectRoot: root, runtime: "codex", capability: "agent", source: "native_cli_stream", executor: codexAgent });
  assert.equal(result.receipt.testOnly, true); assert.equal(result.receipt.hostInvocation.request.source, "native_cli_stream");
  assert.equal(result.receipt.streamCapture.eventTapeSha256, result.receipt.rawArtifact.sha256);
  assert.equal(result.receipt.streamCapture.rawStdoutSha256, result.receipt.hostInvocation.result.stdoutSha256);
  assert.notEqual(result.receipt.streamCapture.rawStdoutSha256, result.receipt.streamCapture.eventTapeSha256);
  assert.doesNotMatch(readFileSync(result.rawPath, "utf8"), /PRIVATE_NON_EVIDENCE_REASONING/);
  const checked = validation(result, root); assert(!checked.issues.some(issue => /binding|native CLI|evidence|raw host/.test(issue)), checked.issues.join("\n"));
});

test("Claude native shell stream binds OAuth status and actual file outcome", t => {
  const root = project(t);
  const result = runControlledRuntimeCapabilityProducer({ projectRoot: root, runtime: "claude_code", capability: "shell", source: "native_cli_stream", executor: claudeShell });
  assert.equal(result.receipt.authObservation.provider, "firstParty");
  assert.equal(result.receipt.workspaceOutcome.contentSha256, sha(`shell-${result.receipt.capabilityMarker}`));
  const checked = validation(result, root); assert(!checked.issues.some(issue => /binding|native CLI|evidence|raw host/.test(issue)), checked.issues.join("\n"));
});

test("Codex native engineering stream preserves the four-event three-facet chain", t => {
  const root = project(t);
  const result = runCodexCompositeEngineeringProducer({ projectRoot: root, source: "native_cli_stream", executor: codexEngineering });
  assert.deepEqual(result.results.map(r=>r.capability), ["shell", "filesystem", "apply_patch / edit"]);
  for (const entry of result.results) {
    const checked = validation(entry, root); assert(!checked.issues.some(issue => /binding|native CLI|evidence|raw host|lifecycle/.test(issue)), checked.issues.join("\n"));
    assert.equal(entry.receipt.testOnly, true);
    assert.equal(entry.receipt.compositeLifecycle.parentSessionRef, undefined);
  }
});

test("auth mismatch, unsuccessful processes and truncated streams never persist an accepted tape", t => {
  for (const mutate of [r=>{r.authObservation.provider="api";},r=>{r.signal="SIGTERM";},r=>{r.status=1;},r=>{r.stdout=r.stdout.split("\n").slice(0,-2).join("\n");}]) {
    const root = project(t), id="rejected-attempt";
    assert.throws(() => runControlledRuntimeCapabilityProducer({ projectRoot: root, attemptId: id, runtime: "codex", capability: "agent", source: "native_cli_stream", executor: request=>{const r=codexAgent(request);mutate(r);return r;} }));
    assert.equal(existsSync(path.join(root,".meta-kim/state/default/runtime-capability-producers/receipts",`${id}.json`)),false);
  }
});

test("public native source cannot inject an executor, reader or credential directory", async t => {
  for (const key of ["executor","reader","codexHome"]) await assert.rejects(produceRuntimeCapabilityAcceptance({projectRoot:project(t),source:"native_cli_stream",runtime:"codex",capabilities:["agent"],[key]:()=>{throw new Error("must never run");}}),/does not accept injected/u);
});

test("public report import cannot turn native stream fixtures into production authority", t => {
  const root=project(t);
  const produced=runControlledRuntimeCapabilityProducer({projectRoot:root,runtime:"codex",capability:"agent",source:"native_cli_stream",executor:codexAgent});
  assert.throws(()=>writeRuntimeCapabilityAcceptanceAttempt({projectRoot:root,reportPath:produced.receiptPath,sourceKind:"controlled_producer_receipt",runtime:"codex",capability:"agent",mode:"interactive_host"}),/controlled|producer|private|source/i);
});


test("native dispatch rejects duplicate or incomplete facets before invoking a CLI", async t => {
  for (const capabilities of [["shell","shell","shell"],["shell"],[],["unknown"]]) {
    await assert.rejects(produceRuntimeCapabilityAcceptance({ projectRoot: project(t), source: "native_cli_stream", runtime: "codex", capabilities }), /unique supported set|engineering proof requires/u);
  }
});

function tamperReceipt(produced, mutate) {
  const value=JSON.parse(readFileSync(produced.receiptPath,"utf8")); mutate(value);
  const {recordHash:discard,...body}=value; value.recordHash=sha(JSON.stringify(body));
  const bytes=JSON.stringify(value)+"\n"; writeFileSync(produced.receiptPath,bytes);
  const attempt=structuredClone(produced.acceptance.record); attempt.sourceReport.sha256=sha(bytes);
  return attempt;
}

test("rehashing cannot remove stream provenance, change status or attach private session dependencies", t => {
  for (const mutate of [
    value=>{value.hostInvocation.result.status=1;value.hostInvocation.resultDigest=sha(JSON.stringify(value.hostInvocation.result));},
    value=>{value.hostInvocation.request.capability="shell";value.hostInvocation.requestDigest=sha(JSON.stringify(value.hostInvocation.request));},
    value=>{value.hostInvocation.request.command="another-cli";value.hostInvocation.requestDigest=sha(JSON.stringify(value.hostInvocation.request));},
    value=>{value.authObservation.provider="api";},
    value=>{value.authObservation.email="private@example.invalid";},
    value=>{value.compositeLifecycle={parentSessionRef:"old-private-session.jsonl"};},
    value=>{delete value.hostInvocation.request.source;value.hostInvocation.requestDigest=sha(JSON.stringify(value.hostInvocation.request));},
    value=>{value.streamCapture.eventTapeSha256="0".repeat(64);},
    value=>{value.hostInvocation.request.args.push("--ignore-rules");value.hostInvocation.requestDigest=sha(JSON.stringify(value.hostInvocation.request));},
  ]) {
    const root=project(t), produced=runControlledRuntimeCapabilityProducer({projectRoot:root,runtime:"codex",capability:"agent",source:"native_cli_stream",executor:codexAgent});
    const attempt=tamperReceipt(produced,mutate);
    const checked=validateRuntimeCapabilityAcceptanceAttemptEvidence(attempt,{profileRoot:path.join(root,".meta-kim/state/default")});
    assert.equal(checked.valid,false); assert(checked.issues.some(issue=>/native|source|binding|hash/.test(issue)),checked.issues.join("\n"));
  }
});

test("packed stream path only copies self-contained minimal evidence", () => {
  const source=readFileSync(new URL("../../scripts/verify-packed-user-install-update.mjs",import.meta.url),"utf8");
  assert.match(source,/nativeStream \? \[\] : \[receipt\.compositeLifecycle/u);
  assert.match(source,/native CLI stream snapshots cannot depend on private session files/u);
});

test("Claude shell grants contain only the current platform's exact nonce-bound command", () => {
  const token="META_KIM_CAPABILITY_SHELL_55555555-5555-4555-8555-555555555555";
  for (const platform of ["win32","linux"]) {
    const args=nativeCliStreamInvocationArgs({runtime:"claude_code",workspace:"/tmp/probe",capability:"shell",marker:token,platform});
    const allowed=args[args.indexOf("--allowedTools")+1], disabled=args[args.indexOf("--disallowedTools")+1];
    assert(allowed.includes(token)); assert(!allowed.includes(","));
    assert(allowed.startsWith(platform==="win32"?"PowerShell(Set-Content ":"Bash(printf "));
    assert(disabled.includes(platform==="win32"?"Bash":"PowerShell"));
    assert(disabled.includes("Read")); assert(disabled.includes("Write")); assert(disabled.includes("mcp__*"));
  }
});

test("generated Windows shell grant has a replayable exact native PowerShell event", async () => {
  const {collectNativeCliEventTape}=await import("../../scripts/native-cli-event-tape.mjs");
  const token="META_KIM_CAPABILITY_SHELL_55555555-5555-4555-8555-555555555555";
  const workspace="C:\\Temp\\meta-kim-controlled-probe", session="66666666-6666-4666-8666-666666666666";
  const args=nativeCliStreamInvocationArgs({runtime:"claude_code",workspace,capability:"shell",marker:token,platform:"win32"});
  const grant=args[args.indexOf("--allowedTools")+1], command=grant.slice("PowerShell(".length,-1);
  const records=[
    {type:"system",subtype:"init",session_id:session,tools:["PowerShell"]},
    {type:"assistant",session_id:session,message:{id:"win-message",content:[{type:"tool_use",id:"win-shell",name:"PowerShell",input:{command}}]}},
    {type:"user",session_id:session,message:{content:[{type:"tool_result",tool_use_id:"win-shell",content:"",is_error:false}]}},
    {type:"result",subtype:"success",session_id:session,is_error:false,result:"finished"},
  ];
  assert.doesNotThrow(()=>collectNativeCliEventTape(jsonl(records),{runtime:"claude_code",capability:"shell",marker:token,workspace}));
});


test("Windows spawnSync EPERM preserves bounded diagnostics but strips user paths and private output", () => {
  const nativeFailure = { status: null, signal: null, stdout: "PRIVATE_STDOUT", stderr: "PRIVATE_STDERR",
    error: { code: "EPERM", errno: -4048, syscall: "spawnSync C:\\Users\\PRIVATE_USER\\npm\\node.exe",
      path: "C:\\Users\\PRIVATE_USER\\npm\\node.exe", spawnargs: ["PRIVATE_ARGUMENT"], message: "PRIVATE_MESSAGE" } };
  for (const phase of ["native CLI version preflight", "native CLI help preflight", "native CLI auth-status preflight", "native CLI bounded probe"]) {
    assert.throws(() => assertRuntimeHostInvocationSuccess("codex", phase, nativeFailure), error => {
      assert.equal(error.status, null); assert.equal(error.exitCode, null); assert.equal(error.signal, null);
      assert.equal(error.code, "EPERM"); assert.equal(error.errorCode, "EPERM"); assert.equal(error.errno, -4048); assert.equal(error.syscall, "spawnSync");
      assert.match(error.message, /exit=unknown; signal=none; errorCode=EPERM; errno=-4048; syscall=spawnSync/u);
      assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE_|node\.exe|Users/u);
      return true;
    });
  }
});

test("benign CLI warnings do not replace a successful exit with a process failure", () => {
  const successful = {status:0, signal:null, error:null, stdout:"codex-cli 0.157.1\n", stderr:"diagnostic startup warning"};
  assert.equal(assertRuntimeHostInvocationSuccess("codex", "version", successful), successful);
});

test("signal, errno and syscall diagnostics reject malformed or unbounded values without echoing", () => {
  const error=runtimeHostInvocationError("codex","probe",{status:0,signal:"PRIVATE_SIGNAL /path",error:{code:"PRIVATE_CODE secret",errno:"PRIVATE_ERRNO",syscall:"PRIVATE_SYSCALL /private/path"}});
  assert.equal(error.signal,"unknown"); assert.equal(error.code,"unknown"); assert.equal(error.errno,null); assert.equal(error.syscall,"unknown");
  assert.doesNotMatch(error.message+JSON.stringify(error),/PRIVATE_|private\/path/u);
  assert.throws(()=>assertRuntimeHostInvocationSuccess("codex","probe",{status:0,signal:null,error:{code:"EPERM",errno:-4048,syscall:"spawnSync"}}),/EPERM/u);
});

test("every native preflight uses the shared diagnostic assertion without a fallback", () => {
  const source=readFileSync(new URL("../../scripts/runtime-capability-producers.mjs",import.meta.url),"utf8");
  const native=source.slice(source.indexOf("function nativeCliStreamExecutor("),source.indexOf("function productionExecutorSelected("));
  for(const phase of ["native CLI version preflight","native CLI help preflight","native CLI auth-status preflight"]) assert(native.includes(`assertRuntimeHostInvocationSuccess(request.runtime, "${phase}"`));
  assert.match(native,/shell: false/u); assert.doesNotMatch(native,/shell: true|execFileSync|spawnargs|chmod|icacls|bypass|withRuntimeIsolation/u);
});
