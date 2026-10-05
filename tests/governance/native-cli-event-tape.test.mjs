import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { collectNativeCliEventTape, validateNativeCliEventTape } from "../../scripts/native-cli-event-tape.mjs";
import { observeClaudeJsonl, observeCodexJsonl } from "../../scripts/live-acceptance/observe-host-events.mjs";

const marker = "META_KIM_CAPABILITY_AGENT_4c5d7726-2699-45fc-b9cd-0c4539cd177f";
const workspace = "/tmp/meta-kim-synthetic-probe";
const options = (runtime = "codex", capability = "agent") => ({ runtime, capability, marker, workspace });
const jsonl = (records) => `${records.map(JSON.stringify).join("\n")}\n`;
const hash = (value) => createHash("sha256").update(value).digest("hex");

function codexAgent() {
  const spawn = { id: "spawn-1", type: "collab_tool_call", tool: "spawn_agent", sender_thread_id: "root-1", receiver_thread_ids: [], prompt: `Return ${marker} as your entire final response.`, agents_states: {}, status: "in_progress" };
  const wait = { id: "wait-1", type: "collab_tool_call", tool: "wait", sender_thread_id: "root-1", receiver_thread_ids: ["child-1"], agents_states: {}, status: "in_progress" };
  return [
    { type: "thread.started", thread_id: "root-1" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "thinking-1", type: "reasoning", text: "Private reasoning must never persist" } },
    { type: "item.completed", item: { id: "narration-1", type: "agent_message", text: "Private unrelated conversation must never persist" } },
    { type: "item.started", item: spawn },
    { type: "item.completed", item: { ...spawn, status: "completed", receiver_thread_ids: ["child-1"], agents_states: { "child-1": { status: "pending_init", message: null } } } },
    { type: "item.started", item: wait },
    { type: "item.completed", item: { ...wait, status: "completed", agents_states: { "child-1": { status: "completed", message: marker } } } },
    { type: "turn.completed", usage: { input_tokens: 12345 }, account: "private-account", config_path: "/home/private/.codex/config.toml" },
  ];
}

function codexTool(capability = "shell") {
  const command = capability === "filesystem" ? "cat meta-kim-probe.txt" : `printf 'shell-${marker}\\n' > meta-kim-probe.txt`;
  const item = { id: "tool-1", type: "command_execution", command, status: "in_progress" };
  return [
    { type: "thread.started", thread_id: "root-1" }, { type: "turn.started" },
    { type: "item.started", item },
    { type: "item.completed", item: { ...item, status: "completed", aggregated_output: capability === "filesystem" ? marker : "", exit_code: 0 } },
    { type: "turn.completed" },
  ];
}

function codexEngineering() {
  const records = [{ type: "thread.started", thread_id: "root-1" }, { type: "turn.started" }];
  const command = (id, command, output) => {
    const item = { id, type: "command_execution", command, status: "in_progress" };
    records.push({ type: "item.started", item }, { type: "item.completed", item: { ...item, status: "completed", exit_code: 0, aggregated_output: output } });
  };
  command("write-1", `printf 'before-${marker}\\n' > meta-kim-engineering-probe.txt`, "");
  command("read-1", "cat meta-kim-engineering-probe.txt", `before-${marker}\n`);
  const edit = { id: "edit-1", type: "file_change", changes: [{ path: `${workspace}/meta-kim-engineering-probe.txt`, kind: "update" }], status: "in_progress" };
  records.push({ type: "item.started", item: edit }, { type: "item.completed", item: { ...edit, status: "completed" } });
  command("read-2", "cat meta-kim-engineering-probe.txt", `after-${marker}\n`);
  records.push({ type: "turn.completed" });
  return records;
}

function claudeTool(name = "Agent", input = { prompt: `Return ${marker}`, description: "Return one probe marker" }) {
  return [
    { type: "system", subtype: "init", session_id: "session-1", cwd: "/private/account/home", apiKeySource: "secret-source", tools: ["Agent"], model: "private-model" },
    { type: "assistant", session_id: "session-1", message: { id: "message-1", content: [{ type: "thinking", thinking: "Never persist this reasoning", signature: "private-signature" }, { type: "text", text: "Unrelated parent response" }, { type: "tool_use", id: "call-1", name, input }], usage: { input_tokens: 9000 } } },
    { type: "user", session_id: "session-1", tool_use_result: name === "Agent" || name === "Task" ? { agentId: "child-1", status: "completed", content: [{ type: "text", text: marker }], usage: { output_tokens: 2345 } } : {}, message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: marker, is_error: false }] } },
    { type: "result", subtype: "success", is_error: false, session_id: "session-1", result: "Private parent final", usage: { output_tokens: 7000 }, permission_denials: [] },
  ];
}

function claudeAsync() {
  const records = claudeTool();
  records.splice(2, 0, { type: "system", subtype: "task_started", session_id: "session-1", task_id: "child-1", tool_use_id: "call-1", description: "Private task description" });
  records[3].tool_use_result = { agentId: "child-1", status: "async_launched", isAsync: true };
  records[3].message.content[0].content = "Async agent launched successfully.";
  records.splice(4, 0,
    { type: "assistant", parent_tool_use_id: "call-1", session_id: "session-1", message: { id: "child-message", stop_reason: null, content: [{ type: "thinking", thinking: "private child reasoning" }, { type: "text", text: marker }] } },
    { type: "system", subtype: "task_updated", session_id: "session-1", task_id: "child-1", patch: { status: "completed" } },
    { type: "system", subtype: "task_notification", session_id: "session-1", task_id: "child-1", tool_use_id: "call-1", status: "completed", output_file: "/private/transcripts/agent.txt", summary: "private summary" },
  );
  return records;
}

function collect(records, opts = options()) { return collectNativeCliEventTape(jsonl(records), opts); }
function rejects(records, pattern, opts = options()) { assert.throws(() => collect(records, opts), pattern); }
function assertReplays(result, opts) {
  assert.deepEqual(validateNativeCliEventTape(result.text, result.capture, opts), result);
  assert.deepEqual(validateNativeCliEventTape(result.text, result.capture, { ...opts, workspace: undefined }), result);
}

test("Codex native spawn/wait is replay-complete without reasoning, parent chat, account, config, or usage", () => {
  const raw = jsonl(codexAgent());
  const result = collectNativeCliEventTape(raw, options());
  assert.equal(result.capture.schemaVersion, "meta-kim-native-cli-event-tape-v1");
  assert.equal(result.capture.source, "native_cli_stream");
  assert.equal(result.capture.rawStdoutSha256, hash(raw));
  assert.equal(result.capture.eventTapeSha256, hash(result.text));
  assert.notEqual(result.capture.rawStdoutSha256, result.capture.eventTapeSha256);
  assert.equal(result.capture.rawByteLength, Buffer.byteLength(raw));
  assert.equal(result.capture.retainedRecords, 7);
  assert.equal(result.capture.discardedRecords, 2);
  assert.doesNotMatch(result.text, /Private|private|reasoning|account|usage|config/u);
  const [event] = observeCodexJsonl(result.text);
  assert.equal(event.childSessionId, "child-1");
  assert.equal(event.resultTextSha256, hash(marker));
  assert.equal(event.completionBoundary, "wait_child_completed");
  assert.deepEqual(event.resultSourceLines, [6]);
  assertReplays(result, options());
});

test("both agent labels preserve their complete native evidence in both runtimes", () => {
  for (const capability of ["agent", "subagent"]) {
    for (const runtime of ["codex", "claude_code"]) {
      const opts = options(runtime, capability);
      const result = collect(runtime === "codex" ? codexAgent() : claudeTool(), opts);
      const [event] = (runtime === "codex" ? observeCodexJsonl : observeClaudeJsonl)(result.text);
      assert.equal(event.resultTextSha256, hash(marker));
      assert.equal(event.childSessionId, "child-1");
      assertReplays(result, opts);
    }
  }
});

test("Codex shell, filesystem, native file changes and composite keep every native tool record", () => {
  for (const capability of ["shell", "filesystem", "apply_patch / edit", "engineering_composite"]) {
    const records = ["shell", "filesystem"].includes(capability) ? codexTool(capability) : codexEngineering();
    if (capability === "apply_patch / edit") {
      records.splice(2, 2);
      records.splice(-3, 2);
      for (const record of records) if (record.item?.command) record.item.command = record.item.command.replaceAll("meta-kim-engineering-probe.txt", "meta-kim-probe.txt");
      for (const record of records) if (record.item?.changes) record.item.changes[0].path = `${workspace}/meta-kim-probe.txt`;
    }
    const opts = options("codex", capability);
    const result = collect(records, opts);
    const events = observeCodexJsonl(result.text);
    assert.equal(events.length, ["shell", "filesystem"].includes(capability) ? 1 : capability === "apply_patch / edit" ? 2 : 4);
    assert.equal(result.capture.discardedRecords, 0);
    assertReplays(result, opts);
  }
});

test("Claude shell, PowerShell, Read, and native Edit preserve observer inputs and outputs", () => {
  const cases = [
    ["Bash", "shell", { command: `printf 'shell-${marker}\\n' > meta-kim-probe.txt` }],
    ["PowerShell", "shell", { command: `Set-Content -LiteralPath meta-kim-probe.txt -Value 'shell-${marker}'` }],
    ["Read", "filesystem", { file_path: `${workspace}/meta-kim-probe.txt` }],
    ["Edit", "apply_patch / edit", { file_path: "meta-kim-probe.txt", old_string: `before-${marker}`, new_string: `after-${marker}` }],
  ];
  for (const [name, capability, input] of cases) {
    const opts = options("claude_code", capability);
    const records = claudeTool(name, input);
    if (capability === "shell") records[2].message.content[0].content = "";
    if (name === "Edit") {
      records[2].message.content[0].content = `after-${marker}`;
      records.splice(1, 0,
        { type: "assistant", session_id: "session-1", message: { id: "read-msg", content: [{ type: "tool_use", id: "read-call", name: "Read", input: { file_path: "meta-kim-probe.txt" } }] } },
        { type: "user", session_id: "session-1", message: { content: [{ type: "tool_result", tool_use_id: "read-call", content: `before-${marker}` }] } },
      );
    }
    const result = collect(records, opts);
    const event = observeClaudeJsonl(result.text).at(-1);
    assert.equal(event.hostSurface, name);
    assert.equal(event.inputDigest, hash(JSON.stringify(input)));
    assert.doesNotMatch(result.text, /Private|private|usage|thinking|signature|apiKeySource/u);
    assertReplays(result, opts);
  }
});

test("Claude native async child lifecycle and parent_tool_use_id survive projection", () => {
  const opts = options("claude_code");
  const result = collect(claudeAsync(), opts);
  const [event] = observeClaudeJsonl(result.text);
  assert.equal(event.childSessionId, "child-1");
  assert.equal(event.resultMessageId, "child-message");
  assert.equal(event.resultTextSha256, hash(marker));
  assert.equal(event.lifecycleEvidence, "claude_async_agent_task_lifecycle");
  assert.doesNotMatch(result.text, /private|thinking|usage|output_file/u);
  assertReplays(result, opts);
});

test("wrong child final text and extra whitespace reject before anything persists", () => {
  const records = codexAgent();
  records[7].item.agents_states["child-1"].message = "WRONG_MARKER";
  rejects(records, /exact marker/u);
  const async = claudeAsync();
  async[4].message.content[1].text = "WRONG_MARKER";
  rejects(async, /exact marker/u, options("claude_code"));
  for (const value of [` ${marker}`, `${marker}\n`, `${marker} extra prose`]) {
    const records = claudeTool(); records[2].message.content[0].content = value;
    rejects(records, /exact marker/u, options("claude_code"));
  }
});

test("rejects malformed, nonobject, duplicate-key and empty records rather than skipping", () => {
  for (const text of ["", "garbage", "[]\n", "null\n", `${jsonl(codexAgent())}\n`, `${jsonl(codexAgent())}not json\n`]) {
    assert.throws(() => collectNativeCliEventTape(text, options()), /native CLI event tape/u);
  }
  const raw = jsonl(codexTool()).replace('"exit_code":0', '"exit_code":17,"exit_code":0');
  assert.throws(() => collectNativeCliEventTape(raw, options()), /duplicate or unsafe JSON key/u);
  assert.throws(() => collectNativeCliEventTape(jsonl(codexTool()).replace('"exit_code":0', '"__proto__":{},"exit_code":0'), options()), /unsafe JSON key/u);
});

test("bounded bytes, per-line size, record count, and nesting reject oversized evidence", () => {
  assert.throws(() => collectNativeCliEventTape(" ".repeat(4 * 1024 * 1024 + 1), options()), /byte limit/u);
  const huge = codexAgent();
  huge[2].item.text = "x".repeat(128 * 1024);
  rejects(huge, /oversized JSONL/u);
  assert.throws(() => collectNativeCliEventTape(`${'{}\n'.repeat(4097)}`, options()), /record limit/u);
  const nested = codexAgent();
  nested[2].unused = JSON.parse(`${'['.repeat(34)}0${']'.repeat(34)}`);
  rejects(nested, /nesting limit/u);
});

test("rejects missing, repeated, out-of-order, and non-successful final boundaries", () => {
  for (const records of [codexAgent().slice(0, -1), codexAgent().slice(1), codexAgent().filter((record) => record.type !== "turn.started")]) rejects(records, /missing|outside/u);
  const duplicate = codexAgent(); duplicate.splice(2, 0, { type: "turn.started" }); rejects(duplicate, /duplicate/u);
  rejects([...codexAgent(), { type: "turn.completed" }], /after final/u);
  rejects([...codexAgent(), { type: "item.completed", item: { id: "late", type: "reasoning", text: "late" } }], /after final/u);
  for (const mutator of [
    (records) => records.pop(),
    (records) => records.shift(),
    (records) => { delete records.at(-1).is_error; },
    (records) => { records.at(-1).subtype = "incomplete"; },
    (records) => records.push(records.at(-1)),
  ]) {
    const records = claudeTool(); mutator(records); rejects(records, /missing|failure|after final/u, options("claude_code"));
  }
});

test("failures hidden in discarded reasoning, config, parent chat or terminal metadata still reject", () => {
  const poison = [
    { status: "declined" }, { status: "cancelled" }, { status: "failed" }, { error: { message: "oops" } },
    { is_error: true }, { isError: true }, { success: false }, { exit_code: 7 }, { exitCode: -1 },
    { permission_denials: [{ tool_name: "Agent" }] }, { content: "Error: hidden" }, { text: "Exit code: 2" },
    { stop_reason: "max_tokens" }, { errors: ["failure"] },
  ];
  for (const bad of poison) {
    const records = codexAgent(); records[2].metadata = bad; rejects(records, /error|fail|nonzero|truncated|denial|unsuccessful/u);
    const claude = claudeTool(); claude[0].metadata = bad; rejects(claude, /error|fail|nonzero|truncated|denial|unsuccessful/u, options("claude_code"));
  }
});

test("unknown operational events and unknown content are fail closed", () => {
  for (const record of [{ type: "event_msg", payload: { type: "function_call" } }, { type: "response_item", payload: {} }, { type: "anything" }, { type: "item.completed", item: { id: "unknown", type: "web_search" } }]) {
    const records = codexAgent(); records.splice(2, 0, record); rejects(records, /unknown/u);
  }
  const records = claudeTool(); records.splice(1, 0, { type: "stream_event", session_id: "session-1", event: {} });
  rejects(records, /unknown/u, options("claude_code"));
  const content = claudeTool(); content[1].message.content.push({ type: "unknown_tool" }); rejects(content, /unknown/u, options("claude_code"));
});

test("duplicate calls, terminal IDs, and stale updates cannot overwrite proof", () => {
  const call = codexAgent(); call.splice(5, 0, structuredClone(call[4])); rejects(call, /duplicate/u);
  const terminal = codexAgent(); terminal.splice(6, 0, structuredClone(terminal[5])); rejects(terminal, /duplicate/u);
  const narration = codexAgent(); narration.splice(4, 0, structuredClone(narration[3])); rejects(narration, /duplicate/u);
  for (const index of [1, 2]) {
    const records = claudeTool(); records.splice(index + 1, 0, structuredClone(records[index])); rejects(records, /duplicate/u, options("claude_code"));
  }
  const async = claudeAsync(); async.splice(6, 0, structuredClone(async[5])); rejects(async, /duplicate/u, options("claude_code"));
});

test("cross-root and unmatched lifecycle fragments reject", () => {
  const root = codexAgent(); root[4].item.sender_thread_id = "other-root"; rejects(root, /cross-root/u);
  const another = codexAgent(); another.splice(3, 0, { type: "thread.started", thread_id: "other-root" }); rejects(another, /duplicate/u);
  const wait = codexAgent(); wait[6].item.receiver_thread_ids = ["unknown-child"]; rejects(wait, /unknown child/u);
  const missing = codexAgent(); missing.splice(7, 1); rejects(missing, /unfinished/u);
  const claude = claudeTool(); claude[2].session_id = "other-session"; rejects(claude, /cross-root/u, options("claude_code"));
  const async = claudeAsync(); async[4].parent_tool_use_id = "unknown-call"; rejects(async, /unknown Agent/u, options("claude_code"));
  const incomplete = claudeAsync(); incomplete.splice(6, 1); rejects(incomplete, /unfinished/u, options("claude_code"));
});

test("credential paths, private inputs, outside-workspace paths, and traversal never persist", () => {
  for (const command of ["cat /home/alice/private.txt", "cat ~/.codex/auth.json", "cat ../private.txt", "cat $HOME/.ssh/id_rsa", "cat meta-kim-probe.txt # api_key=secret", "cat /tmp/meta-kim-private-probe-other/meta-kim-probe.txt"]) {
    const records = codexTool(); records[2].item.command = command; rejects(records, /credential|outside-workspace|traversal/u);
  }
  const records = claudeTool(); records[1].message.content[2].input.account = "private@example.test"; rejects(records, /unknown native tool input/u, options("claude_code"));
  const edit = codexEngineering(); edit[6].item.changes[0].path = "/tmp/elsewhere/meta-kim-probe.txt"; rejects(edit, /outside-workspace/u, options("codex", "engineering_composite"));
});

test("replay checks hash, exact canonical projection, source, runtime, and bounded counts", () => {
  const original = collect(codexAgent());
  for (const change of [
    { source: "imported_json" }, { runtime: "claude_code" }, { schemaVersion: "other" }, { retainedRecords: 100 },
    { discardedRecords: -1 }, { rawByteLength: 0 }, { rawStdoutSha256: "invalid" }, { extra: "private" },
  ]) assert.throws(() => validateNativeCliEventTape(original.text, { ...original.capture, ...change }, options()), /native CLI event tape/u);
  assert.throws(() => validateNativeCliEventTape(`${original.text} `, original.capture, options()), /hash mismatch/u);
  for (const mutate of [
    (records) => { records[0].account = "leaked"; },
    (records) => records.splice(2, 0, { type: "item.completed", item: { id: "extra-reasoning", type: "reasoning", text: "leaked" } }),
    (records) => { records.at(-1).usage = { tokens: 123 }; },
  ]) {
    const records = original.text.trim().split("\n").map(JSON.parse); mutate(records);
    const text = jsonl(records);
    assert.throws(() => validateNativeCliEventTape(text, { ...original.capture, eventTapeSha256: hash(text), retainedRecords: records.length }, options()), /canonical replay-complete/u);
  }
  const reordered = original.text.split("\n").map((line) => line ? JSON.stringify(JSON.parse(line), null, 1) : "").join("\n");
  assert.throws(() => validateNativeCliEventTape(reordered, { ...original.capture, eventTapeSha256: hash(reordered) }, options()), /malformed/u);
});

test("raw stdout digest remains an independent private-byte commitment", () => {
  const raw = codexTool().map((record) => ` ${JSON.stringify(record)} `).join("\r\n");
  const result = collectNativeCliEventTape(raw, options("codex", "shell"));
  assert.equal(result.capture.rawStdoutSha256, hash(raw));
  assert.equal(result.capture.eventTapeSha256, hash(result.text));
  assert.notEqual(result.capture.rawStdoutSha256, result.capture.eventTapeSha256);
  assertReplays(result, options("codex", "shell"));
});

test("an otherwise valid agent probe cannot smuggle successful shell actions or customer data", () => {
  const records = codexAgent();
  records.splice(-1, 0,
    { type: "item.started", item: { id: "private-shell", type: "command_execution", command: "cat customer-salaries.txt", status: "in_progress" } },
    { type: "item.completed", item: { id: "private-shell", type: "command_execution", command: "cat customer-salaries.txt", status: "completed", exit_code: 0, aggregated_output: "Customer Alice salary 100000" } },
  );
  rejects(records, /unrelated actions/u);
  const claude = claudeTool();
  claude.splice(-1, 0,
    { type: "assistant", session_id: "session-1", message: { id: "private-msg", content: [{ type: "tool_use", id: "extra", name: "Read", input: { file_path: "customer-salaries.txt" } }] } },
    { type: "user", session_id: "session-1", message: { content: [{ type: "tool_result", tool_use_id: "extra", content: "Customer Alice salary 100000" }] } },
  );
  rejects(claude, /unrelated/u, options("claude_code"));
});

test("correct probe actions reject unrelated private output and command suffixes", () => {
  for (const content of ["Customer Alice salary 100000", `${marker}\nPrivate additional data`, ""]) {
    const read = codexTool("filesystem"); read[3].item.aggregated_output = content;
    rejects(read, /synthetic tool output/u, options("codex", "filesystem"));
  }
  for (const suffix of ["; cat customer-salaries.txt", " && env", " | tee other.txt", "\nwhoami"]) {
    const read = codexTool("filesystem");
    read[2].item.command += suffix;
    read[3].item.command += suffix;
    rejects(read, /synthetic read/u, options("codex", "filesystem"));
  }
  const wait = codexAgent(); wait[7].item.output = "Private customer data";
  rejects(wait, /collaboration output/u);
  const edit = codexEngineering(); edit[7].item.output = "Private customer data";
  rejects(edit, /synthetic tool output/u, options("codex", "engineering_composite"));
});

test("native immutable command and prompt inputs cannot change at updates or completion", () => {
  const command = codexTool("filesystem"); command[3].item.command = "cat changed.txt";
  rejects(command, /input changed/u, options("codex", "filesystem"));
  const spawn = codexAgent(); spawn[5].item.prompt = `Return exactly ${marker}`;
  rejects(spawn, /input changed/u);
  const updated = codexTool("filesystem");
  updated.splice(3, 0, { type: "item.updated", item: { ...updated[2].item, command: "cat different.txt" } });
  rejects(updated, /input changed/u, options("codex", "filesystem"));
  const operation = codexAgent(); operation[5].item.tool = "wait";
  rejects(operation, /input changed/u);
});

test("hidden native tool operations cannot vanish inside discarded reasoning or metadata", () => {
  const codex = codexAgent(); codex[2].metadata = { type: "tool_use", name: "secret", input: {} };
  rejects(codex, /hidden operational/u);
  const claude = claudeTool(); claude[0].metadata = { type: "function_call", arguments: {} };
  rejects(claude, /hidden operational/u, options("claude_code"));
});

test("recognized native Agent wrappers drop only structural duplicate id and numeric usage", () => {
  const records = claudeTool();
  records[2].message.content[0].content = [
    { type: "text", text: marker },
    { type: "text", text: "agentId: child-1\n<usage>subagent_tokens: 123\ntool_uses: 0</usage>" },
  ];
  const result = collect(records, options("claude_code"));
  assert.doesNotMatch(result.text, /usage|subagent_tokens/u);
  assert.equal(observeClaudeJsonl(result.text)[0].resultTextSha256, hash(marker));
  assertReplays(result, options("claude_code"));
  records[2].message.content[0].content[1].text += "private data";
  rejects(records, /wrapper/u, options("claude_code"));
});

test("recognized Read line numbers and POSIX shell wrapper preserve exact synthetic content", () => {
  const records = claudeTool("Read", { file_path: "meta-kim-probe.txt" });
  records[2].message.content[0].content = `     1→${marker}\n`;
  assertReplays(collect(records, options("claude_code", "filesystem")), options("claude_code", "filesystem"));
  const codex = codexTool("filesystem");
  codex[2].item.command = "/bin/bash -lc 'cat meta-kim-probe.txt'";
  codex[3].item.command = codex[2].item.command;
  assertReplays(collect(codex, options("codex", "filesystem")), options("codex", "filesystem"));
});

test("Agent control overrides and custom owners reject while display prose never persists", () => {
  for (const control of [{ mode: "bypassPermissions" }, { model: "other-model" }, { subagent_type: "customer-private-agent" }, { run_in_background: true }]) {
    const records = claudeTool(); Object.assign(records[1].message.content[2].input, control);
    rejects(records, /input field|outside|async launch/u, options("claude_code"));
  }
  const records = claudeTool();
  records[1].message.content[2].input.name = "Customer Jane annual salary 90000";
  records[1].message.content[2].input.description = "Customer Joe annual salary 80000";
  records[1].message.content[2].input.subagent_type = "general-purpose";
  records[1].message.content[2].input.run_in_background = false;
  const result = collect(records, options("claude_code"));
  assert.doesNotMatch(result.text, /Customer|salary|description|"name":"Customer/u);
  assertReplays(result, options("claude_code"));
  for (const control of [{ model: "other-model" }, { agent_type: "custom-owner" }, { fork_turns: "all" }]) {
    const codex = codexAgent(); Object.assign(codex[4].item, control); Object.assign(codex[5].item, control);
    rejects(codex, /outside/u);
  }
  const async = claudeAsync(); async[1].message.content[2].input.run_in_background = true;
  assertReplays(collect(async, options("claude_code")), options("claude_code"));
});

test("canonical Codex prompt cannot hide private text through legacy input aliases", () => {
  for (const key of ["message", "task_name", "arguments", "input", "tool_input", "agent_type", "fork_turns"]) {
    const records = codexAgent();
    records[4].item[key] = "Customer Jane salary 90000";
    records[5].item[key] = "Customer Jane salary 90000";
    rejects(records, /noncanonical collaboration/u);
  }
  const wait = codexAgent(); wait[6].item.prompt = "Customer Jane salary 90000"; wait[7].item.prompt = wait[6].item.prompt;
  rejects(wait, /unexpected wait prompt/u);
});

test("non-Agent output envelopes cannot hide private content and conflicting path aliases reject", () => {
  const records = claudeTool("Read", { file_path: "meta-kim-probe.txt" });
  records[2].tool_use_result = { content: "Customer Jane salary 90000", stdout: "private" };
  rejects(records, /synthetic tool output/u, options("claude_code", "filesystem"));
  records[2].tool_use_result = { file: { filePath: "meta-kim-probe.txt", content: marker, numLines: 1 }, usage: { tokens: 10 } };
  const result = collect(records, options("claude_code", "filesystem"));
  assert.doesNotMatch(result.text, /usage|numLines/u);
  assertReplays(result, options("claude_code", "filesystem"));
  records[1].message.content[2].input.path = "private-customer.txt";
  rejects(records, /synthetic probe file/u, options("claude_code", "filesystem"));
  const shell = claudeTool("Bash", { command: `printf 'shell-${marker}' > meta-kim-probe.txt`, run_in_background: true });
  rejects(shell, /background shell/u, options("claude_code", "shell"));
});
