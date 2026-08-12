import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";

import {
  analyzeClaudeAskUserQuestionSdkLifecycle,
  buildClaudeAskUserQuestionProbe,
  buildClaudeMiniMaxProbeEnvironment,
  runClaudeAskUserQuestionSdkProbe,
} from "../../scripts/live-acceptance/claude-ask-user-question-sdk-probe.mjs";

const MINI_MAX_ENV = {
  ANTHROPIC_BASE_URL: "https://api.minimaxi.com/anthropic",
  ANTHROPIC_AUTH_TOKEN: "fixture-minimax-auth-token",
};

async function withMiniMaxProcessEnvironment(run) {
  const previous = Object.fromEntries(
    Object.keys(MINI_MAX_ENV).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, MINI_MAX_ENV);
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withFakeSdk(source, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "meta-kim-claude-probe-sdk-"));
  const sdkEntryPath = path.join(directory, "sdk.mjs");
  await writeFile(sdkEntryPath, source, "utf8");
  try {
    return await run(sdkEntryPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function fixture(overrides = {}) {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const requestId = "sdk-request-1";
  const toolUseID = "toolu_ask_1";
  const probe = buildClaudeAskUserQuestionProbe("probe-seed-1");
  const updatedInput = {
    questions: structuredClone(probe.input.questions),
    answers: { [probe.question]: probe.selectedLabel },
  };
  const messages = [
    { type: "system", subtype: "init", session_id: sessionId },
    {
      type: "assistant",
      session_id: sessionId,
      message: { id: "msg-1", content: [{ type: "tool_use", id: toolUseID, name: "AskUserQuestion", input: structuredClone(probe.input) }] },
    },
    {
      type: "user",
      session_id: sessionId,
      message: { content: [{ type: "tool_result", tool_use_id: toolUseID, content: "answered" }] },
      tool_use_result: structuredClone(updatedInput),
    },
    { type: "result", subtype: "success", session_id: sessionId, result: "SDK_PROBE_ACK" },
  ];
  return {
    sessionId,
    requestId,
    toolUseID,
    callbackInput: structuredClone(probe.input),
    updatedInput,
    expectedInput: structuredClone(probe.input),
    selectedLabel: probe.selectedLabel,
    messages,
    ...overrides,
  };
}

test("correlates the exact SDK session, request, tool_use and tool_result without authorizing", () => {
  const observed = analyzeClaudeAskUserQuestionSdkLifecycle(fixture());
  assert.equal(observed.status, "sdk_callback_tool_use_and_stream_correlated");
  assert.equal(observed.callbackRequestId, "sdk-request-1");
  assert.equal(observed.privateContinuationState, "consumed_inside_sdk_callback");
  assert.equal(observed.humanAnswerVerified, false);
  assert.equal(observed.hostAuthorityEstablished, false);
  assert.equal(observed.executionAllowed, false);
});

test("rejects a callback replayed against a different assistant tool_use", () => {
  const input = fixture();
  input.messages[1].message.content[0].id = "toolu_other";
  assert.throws(() => analyzeClaudeAskUserQuestionSdkLifecycle(input), /tool_use is not bound/i);
});

test("rejects cross-session tool_result correlation", () => {
  const input = fixture();
  input.messages[2].session_id = "22222222-2222-4222-8222-222222222222";
  assert.throws(() => analyzeClaudeAskUserQuestionSdkLifecycle(input), /same-session tool_result/i);
});

test("rejects a model-mutated question or option payload", () => {
  const input = fixture();
  input.messages[1].message.content[0].input.questions[0].options[0].label = "Changed";
  assert.throws(() => analyzeClaudeAskUserQuestionSdkLifecycle(input), /does not match the exact probe question/i);
});

test("rejects a callback answer outside the exact presented option set", () => {
  const input = fixture();
  input.updatedInput.answers[input.expectedInput.questions[0].question] = "Unexpected";
  assert.throws(() => analyzeClaudeAskUserQuestionSdkLifecycle(input), /does not match the selected probe label/i);
});

test("rejects an errored tool_result even when session and tool_use id match", () => {
  const input = fixture();
  input.messages[2].message.content[0].is_error = true;
  assert.throws(() => analyzeClaudeAskUserQuestionSdkLifecycle(input), /tool_result reports an error/i);
});

test("rejects a structured tool_use_result that differs from the callback answer", () => {
  const input = fixture();
  input.messages[2].tool_use_result.answers[input.expectedInput.questions[0].question] = "Observe B";
  assert.throws(() => analyzeClaudeAskUserQuestionSdkLifecycle(input), /does not match the exact callback answer/i);
});

test("rejects a failed or unexpected terminal result", () => {
  const failed = fixture();
  failed.messages[3].subtype = "error_during_execution";
  assert.throws(() => analyzeClaudeAskUserQuestionSdkLifecycle(failed), /expected successful callback continuation/i);

  const unexpected = fixture();
  unexpected.messages[3].result = "different";
  assert.throws(() => analyzeClaudeAskUserQuestionSdkLifecycle(unexpected), /expected successful callback continuation/i);
});

test("production probe keeps callback continuation private and all public claims non-authorizing", async () => {
  const source = await readFile(new URL("../../scripts/live-acceptance/claude-ask-user-question-sdk-probe.mjs", import.meta.url), "utf8");
  assert.match(source, /const canUseTool = async/u);
  assert.match(source, /Symbol\("claude-sdk-callback"\)/u);
  assert.match(source, /consumed_inside_sdk_callback/u);
  assert.doesNotMatch(source, /export\s+(?:function|const|class)\s+.*(?:Continuation|Authoriz|Verified)/u);
  assert.match(source, /humanAnswerVerified:\s*false/u);
  assert.match(source, /hostAuthorityEstablished:\s*false/u);
  assert.match(source, /executionAllowed:\s*false/u);
});

test("builds a closed MiniMax child environment and strips mixed-case provider pollution", () => {
  const child = buildClaudeMiniMaxProbeEnvironment({
    ...MINI_MAX_ENV,
    PATH: "fixture-path",
    HTTPS_PROXY: "http://proxy.fixture.invalid",
    NoDe_OpTiOnS: "--require=ambient-injection",
    aNtHrOpIc_ApI_kEy: "wrong-provider-key",
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_SHARED_CREDENTIALS_FILE: "relative-secret-path",
    Google_Application_Credentials: "relative-google-secret-path",
    ANTHROPIC_VERTEX_PROJECT_ID: "wrong-vertex-project",
    CLOUD_ML_REGION: "wrong-cloud-region",
    UNRELATED_SECRET: "must-not-cross",
  });
  assert.deepEqual(child, {
    PATH: "fixture-path",
    HTTPS_PROXY: "http://proxy.fixture.invalid",
    ANTHROPIC_AUTH_TOKEN: MINI_MAX_ENV.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_BASE_URL: MINI_MAX_ENV.ANTHROPIC_BASE_URL,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_SAFE_MODE: "1",
    NO_COLOR: "1",
  });
  assert.equal(child.ANTHROPIC_API_KEY, undefined, "dual auth must not cross into MiniMax");
  assert.equal(child.NODE_OPTIONS, undefined);
});

test("fails closed for mixed-case-only credentials, wrong endpoints, and conflicting safe case variants", () => {
  assert.throws(
    () => buildClaudeMiniMaxProbeEnvironment({
      ANTHROPIC_BASE_URL: MINI_MAX_ENV.ANTHROPIC_BASE_URL,
      aNtHrOpIc_AuTh_ToKeN: MINI_MAX_ENV.ANTHROPIC_AUTH_TOKEN,
    }),
    /ANTHROPIC_AUTH_TOKEN is invalid/u,
  );
  assert.throws(
    () => buildClaudeMiniMaxProbeEnvironment({ ...MINI_MAX_ENV, ANTHROPIC_BASE_URL: "https://example.invalid/anthropic" }),
    /not an allowed MiniMax Anthropic endpoint/u,
  );
  assert.throws(
    () => buildClaudeMiniMaxProbeEnvironment({ ...MINI_MAX_ENV, PATH: "one", Path: "two" }),
    /PATH has conflicting case variants/u,
  );
});

test("rejects out-of-range or unsupported API options before importing an SDK", async () => {
  const base = {
    claudeExecutablePath: path.resolve("fixture-claude.exe"),
    cwd: process.cwd(),
    sessionId: "11111111-1111-4111-8111-111111111111",
  };
  await assert.rejects(
    runClaudeAskUserQuestionSdkProbe({ ...base, timeoutMs: 24 }),
    /timeoutMs must be an integer from 25 through 120000/u,
  );
  await assert.rejects(
    runClaudeAskUserQuestionSdkProbe({ ...base, maxMessages: 65 }),
    /maxMessages must be an integer from 4 through 64/u,
  );
  await assert.rejects(
    runClaudeAskUserQuestionSdkProbe({ ...base, model: "haiku" }),
    /model must be MiniMax-M3/u,
  );
  await assert.rejects(
    runClaudeAskUserQuestionSdkProbe({ ...base, providerEnv: MINI_MAX_ENV }),
    /unsupported probe option providerEnv/u,
  );
});

test("aborts and closes a stalled SDK stream at the wall-clock limit", async () => {
  const fakeSdk = `
    export function query({ options }) {
      globalThis.__claudeProbeTimeout = { closed: 0, aborted: false, env: options.env };
      options.abortController.signal.addEventListener("abort", () => {
        globalThis.__claudeProbeTimeout.aborted = true;
      }, { once: true });
      return {
        [Symbol.asyncIterator]() { return this; },
        next() {
          return new Promise((resolve, reject) => {
            options.abortController.signal.addEventListener("abort", () => reject(new Error("raw fake abort")), { once: true });
          });
        },
        close() { globalThis.__claudeProbeTimeout.closed += 1; },
      };
    }
  `;
  await withMiniMaxProcessEnvironment(() => withFakeSdk(fakeSdk, async (sdkEntryPath) => {
    await assert.rejects(
      runClaudeAskUserQuestionSdkProbe({
        sdkEntryPath,
        claudeExecutablePath: path.resolve("fixture-claude.exe"),
        cwd: process.cwd(),
        sessionId: "11111111-1111-4111-8111-111111111111",
        timeoutMs: 25,
      }),
      (error) => error.message.includes("wall-clock timeout exceeded") && !error.message.includes("raw fake abort"),
    );
    assert.equal(globalThis.__claudeProbeTimeout.aborted, true);
    assert.ok(globalThis.__claudeProbeTimeout.closed >= 1);
    assert.equal(Object.hasOwn(globalThis.__claudeProbeTimeout.env, "NODE_OPTIONS"), false);
    delete globalThis.__claudeProbeTimeout;
  }));
});

test("aborts and closes after the bounded SDK message count", async () => {
  const fakeSdk = `
    export function query({ options }) {
      globalThis.__claudeProbeLimit = { closed: 0, aborted: false };
      options.abortController.signal.addEventListener("abort", () => {
        globalThis.__claudeProbeLimit.aborted = true;
      }, { once: true });
      return {
        [Symbol.asyncIterator]() { return this; },
        async next() { return { done: false, value: { type: "assistant", secretRaw: "must-not-surface" } }; },
        close() { globalThis.__claudeProbeLimit.closed += 1; },
      };
    }
  `;
  await withMiniMaxProcessEnvironment(() => withFakeSdk(fakeSdk, async (sdkEntryPath) => {
    await assert.rejects(
      runClaudeAskUserQuestionSdkProbe({
        sdkEntryPath,
        claudeExecutablePath: path.resolve("fixture-claude.exe"),
        cwd: process.cwd(),
        sessionId: "11111111-1111-4111-8111-111111111111",
        maxMessages: 4,
      }),
      (error) => error.message.includes("SDK message limit exceeded") && !error.message.includes("must-not-surface"),
    );
    assert.equal(globalThis.__claudeProbeLimit.aborted, true);
    assert.ok(globalThis.__claudeProbeLimit.closed >= 1);
    delete globalThis.__claudeProbeLimit;
  }));
});

test("production source never spreads process.env into the SDK child", async () => {
  const source = await readFile(new URL("../../scripts/live-acceptance/claude-ask-user-question-sdk-probe.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /env:\s*\{\s*\.\.\.process\.env/u);
  assert.match(source, /abortController/u);
  assert.match(source, /messages\.length\s*=\s*0/u);
});

test("deferred claude -p is not promoted by this active-only SDK probe", async () => {
  const source = await readFile(new URL("../../scripts/live-acceptance/claude-ask-user-question-sdk-probe.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /--resume|deferred_resume|resumeDeferredAskUserQuestion/u);
});
