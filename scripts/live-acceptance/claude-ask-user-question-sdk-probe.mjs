#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const SURFACE = "AskUserQuestion";
const MODEL = "MiniMax-M3";
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 25;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_MESSAGES = 64;
const MIN_MAX_MESSAGES = 4;
const MAX_MAX_MESSAGES = 64;
const SAFE_CHILD_ENV_KEYS = new Set([
  "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "PROGRAMDATA",
  "USER", "USERNAME", "LOGNAME", "SHELL", "TERM", "LANG", "LC_ALL", "LC_CTYPE",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
]);
const SAFE_PATH_ENV_KEYS = new Set([
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
]);
const MINIMAX_HOSTS = new Set(["api.minimaxi.com", "api.minimax.io"]);
const RUN_OPTION_KEYS = new Set([
  "sdkEntryPath", "claudeExecutablePath", "cwd", "model", "seed", "sessionId", "timeoutMs", "maxMessages",
]);

function fail(message) {
  throw new TypeError(`Claude AskUserQuestion SDK probe: ${message}`);
}

function plainRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain record`);
  }
  return value;
}

function safeRef(value, label) {
  if (typeof value !== "string" || !SAFE_REF.test(value)) fail(`${label} must be a safe opaque reference`);
  return value;
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    fail(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return resolved;
}

function safeEnvironmentValue(value, label, maximum = 32_768) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\0\r\n]/u.test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

function readExactEnvironmentValue(source, key) {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeMiniMaxEndpoint(value) {
  const endpoint = safeEnvironmentValue(value, "ANTHROPIC_BASE_URL", 2_048);
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    fail("ANTHROPIC_BASE_URL is not a valid MiniMax URL");
  }
  if (parsed.protocol !== "https:" || !MINIMAX_HOSTS.has(parsed.hostname.toLowerCase()) ||
      parsed.username || parsed.password || parsed.search || parsed.hash || !/^\/anthropic\/?$/u.test(parsed.pathname)) {
    fail("ANTHROPIC_BASE_URL is not an allowed MiniMax Anthropic endpoint");
  }
  return endpoint;
}

/**
 * Builds the complete SDK child environment. Only exact canonical MiniMax
 * endpoint/auth keys may cross the provider boundary. Everything else is
 * reconstructed from a closed OS/proxy/certificate allowlist, so mixed-case
 * NODE_OPTIONS and Anthropic/Bedrock/Vertex/AWS/Google credentials disappear.
 */
export function buildClaudeMiniMaxProbeEnvironment(sourceEnv = process.env) {
  if (!sourceEnv || typeof sourceEnv !== "object" || Array.isArray(sourceEnv)) {
    fail("provider environment must be an environment record");
  }
  const source = sourceEnv;
  const endpoint = safeMiniMaxEndpoint(readExactEnvironmentValue(source, "ANTHROPIC_BASE_URL"));
  const authToken = safeEnvironmentValue(
    readExactEnvironmentValue(source, "ANTHROPIC_AUTH_TOKEN"),
    "ANTHROPIC_AUTH_TOKEN",
    4_096,
  );
  const childEnv = {};
  const normalizedSafeValues = new Map();
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const normalizedKey = rawKey.toUpperCase();
    if (!SAFE_CHILD_ENV_KEYS.has(normalizedKey) || typeof rawValue !== "string" || rawValue.length === 0) continue;
    const value = safeEnvironmentValue(rawValue, normalizedKey);
    const previous = normalizedSafeValues.get(normalizedKey);
    if (previous !== undefined && previous !== value) fail(`${normalizedKey} has conflicting case variants`);
    normalizedSafeValues.set(normalizedKey, value);
  }
  for (const [key, value] of normalizedSafeValues) {
    if (SAFE_PATH_ENV_KEYS.has(key) && !path.isAbsolute(value)) fail(`${key} must be an absolute path`);
    childEnv[key] = value;
  }
  return Object.freeze({
    ...childEnv,
    ANTHROPIC_AUTH_TOKEN: authToken,
    ANTHROPIC_BASE_URL: endpoint,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_SAFE_MODE: "1",
    NO_COLOR: "1",
  });
}

function normalizeRunOptions(input) {
  const options = plainRecord(input, "probe input");
  for (const key of Object.keys(options)) {
    if (!RUN_OPTION_KEYS.has(key)) fail(`unsupported probe option ${key}`);
  }
  if (typeof options.claudeExecutablePath !== "string" || !path.isAbsolute(options.claudeExecutablePath)) {
    fail("claudeExecutablePath must be an absolute path");
  }
  if (options.sdkEntryPath !== undefined &&
      (typeof options.sdkEntryPath !== "string" || !path.isAbsolute(options.sdkEntryPath))) {
    fail("sdkEntryPath must be an absolute path");
  }
  const cwd = options.cwd ?? process.cwd();
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) fail("cwd must be an absolute path");
  if (options.model !== undefined && options.model !== MODEL) fail(`model must be ${MODEL}`);
  const sessionId = options.sessionId ?? randomUUID();
  if (typeof sessionId !== "string" || !UUID.test(sessionId)) fail("sessionId must be a UUID");
  return Object.freeze({
    sdkEntryPath: options.sdkEntryPath,
    claudeExecutablePath: options.claudeExecutablePath,
    cwd,
    model: MODEL,
    seed: options.seed ?? randomUUID(),
    sessionId,
    timeoutMs: boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, "timeoutMs"),
    maxMessages: boundedInteger(options.maxMessages, DEFAULT_MAX_MESSAGES, MIN_MAX_MESSAGES, MAX_MAX_MESSAGES, "maxMessages"),
  });
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

function exactQuestionInput(value, expected) {
  const input = plainRecord(value, "AskUserQuestion input");
  if (digest(input) !== digest(expected)) fail("SDK callback input does not match the exact probe question");
  return input;
}

function messagesOf(value) {
  if (!Array.isArray(value)) fail("messages must be an array");
  return value.map((message, index) => plainRecord(message, `messages[${index}]`));
}

function toolUses(message) {
  const content = message?.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((item) => item?.type === "tool_use" && item?.name === SURFACE);
}

function toolResults(message) {
  const content = message?.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((item) => item?.type === "tool_result");
}

export function buildClaudeAskUserQuestionProbe(seed = randomUUID()) {
  const normalizedSeed = safeRef(seed, "seed");
  const question = `M3-P2 SDK callback probe ${normalizedSeed}: choose the observation label.`;
  const input = Object.freeze({
    questions: Object.freeze([Object.freeze({
      question,
      header: "M3-P2 probe",
      options: Object.freeze([
        Object.freeze({ label: "Observe A", description: `First non-authorizing probe path ${normalizedSeed}.` }),
        Object.freeze({ label: "Observe B", description: `Second non-authorizing probe path ${normalizedSeed}.` }),
      ]),
      multiSelect: false,
    })]),
  });
  const prompt = [
    "Call AskUserQuestion exactly once and do not call any other tool.",
    `Use this exact question: ${question}`,
    "Use header: M3-P2 probe",
    `Use option 1 label \"Observe A\" and description \"First non-authorizing probe path ${normalizedSeed}.\"`,
    `Use option 2 label \"Observe B\" and description \"Second non-authorizing probe path ${normalizedSeed}.\"`,
    "Set multiSelect to false. After the answer, reply with only SDK_PROBE_ACK.",
  ].join("\n");
  return Object.freeze({ seed: normalizedSeed, question, input, prompt, selectedLabel: "Observe A" });
}

export function analyzeClaudeAskUserQuestionSdkLifecycle(input = {}) {
  const value = plainRecord(input, "analysis input");
  const sessionId = safeRef(value.sessionId, "sessionId");
  const requestId = safeRef(value.requestId, "requestId");
  const toolUseID = safeRef(value.toolUseID, "toolUseID");
  const callbackInput = plainRecord(value.callbackInput, "callbackInput");
  const updatedInput = plainRecord(value.updatedInput, "updatedInput");
  const expectedInput = plainRecord(value.expectedInput, "expectedInput");
  exactQuestionInput(callbackInput, expectedInput);
  if (digest(updatedInput.questions) !== digest(expectedInput.questions)) fail("callback answer changed the presented questions");
  const answer = updatedInput.answers?.[expectedInput.questions[0].question];
  if (answer !== value.selectedLabel) fail("callback answer does not match the selected probe label");

  const messages = messagesOf(value.messages);
  const init = messages.find((message) => message.type === "system" && message.subtype === "init");
  if (!init || init.session_id !== sessionId) fail("SDK init does not match the pre-bound session");
  const calls = messages.flatMap((message) => toolUses(message).map((item) => ({ message, item })));
  if (calls.length !== 1) fail("SDK stream must contain exactly one AskUserQuestion tool_use");
  const call = calls[0];
  if (call.message.session_id !== sessionId || call.item.id !== toolUseID) fail("assistant tool_use is not bound to the callback session and toolUseID");
  exactQuestionInput(call.item.input, expectedInput);

  const results = messages.flatMap((message) => toolResults(message).map((item) => ({ message, item })));
  const matchingResults = results.filter(({ message, item }) => message.session_id === sessionId && item.tool_use_id === toolUseID);
  if (matchingResults.length !== 1) fail("SDK stream must contain one same-session tool_result for the callback toolUseID");
  const matchedResult = matchingResults[0];
  if (matchedResult.item.is_error === true) fail("SDK tool_result reports an error");
  const structuredToolResult = plainRecord(matchedResult.message.tool_use_result, "SDK structured tool_use_result");
  if (digest(structuredToolResult) !== digest(updatedInput)) {
    fail("SDK structured tool_use_result does not match the exact callback answer");
  }
  const resultMessage = messages.find((message) => message.type === "result");
  if (!resultMessage || resultMessage.session_id !== sessionId || resultMessage.subtype !== "success" || resultMessage.result !== "SDK_PROBE_ACK") {
    fail("SDK terminal result is not the expected successful callback continuation");
  }

  return Object.freeze({
    schemaVersion: "claude-ask-user-question-sdk-observation-v1",
    status: "sdk_callback_tool_use_and_stream_correlated",
    runtime: "claude",
    surface: SURFACE,
    sessionId,
    callbackRequestId: requestId,
    toolUseID,
    callbackInputDigest: digest(callbackInput),
    updatedInputDigest: digest(updatedInput),
    assistantToolUseObserved: true,
    toolResultObserved: true,
    terminalResultObserved: true,
    privateContinuationState: "consumed_inside_sdk_callback",
    machineSelectedProbeAnswer: true,
    humanAnswerVerified: false,
    hostAuthorityEstablished: false,
    executionAllowed: false,
  });
}

async function importSdk(moduleSpecifier) {
  if (moduleSpecifier) return import(pathToFileURL(moduleSpecifier).href);
  return import("@anthropic-ai/claude-agent-sdk");
}

export async function runClaudeAskUserQuestionSdkProbe(input = {}) {
  const options = normalizeRunOptions(input);
  const probe = buildClaudeAskUserQuestionProbe(options.seed ?? randomUUID());
  const sessionId = options.sessionId;
  const childEnv = buildClaudeMiniMaxProbeEnvironment(process.env);
  const sdk = await importSdk(options.sdkEntryPath);
  if (typeof sdk.query !== "function") fail("Claude Agent SDK query export is unavailable");

  const messages = [];
  let callbackRecord = null;
  let query;
  let timedOut = false;
  let messageLimitExceeded = false;
  const abortController = new AbortController();
  const closeQuery = () => {
    try {
      query?.close?.();
    } catch {
      // Abort remains the fail-closed authority if SDK cleanup itself fails.
    }
  };
  const canUseTool = async (toolName, rawInput, callbackOptions) => {
    if (callbackRecord) fail("SDK invoked more than one input callback");
    if (toolName !== SURFACE) fail(`unexpected SDK callback tool ${toolName}`);
    const callback = plainRecord(callbackOptions, "SDK callback options");
    const toolUseID = safeRef(callback.toolUseID, "SDK callback toolUseID");
    const requestId = safeRef(callback.requestId, "SDK callback requestId");
    const questionInput = exactQuestionInput(rawInput, probe.input);
    const updatedInput = Object.freeze({
      questions: questionInput.questions,
      answers: Object.freeze({ [probe.question]: probe.selectedLabel }),
    });

    // This one-shot capability is created and consumed only on the SDK's real
    // callback stack. It is never exported, serialized, persisted, or allowed
    // to authorize an action. A crash/restart loses it and requires re-asking.
    const privateContinuation = { token: Symbol("claude-sdk-callback"), consumed: false };
    const consume = () => {
      if (privateContinuation.consumed) fail("private SDK continuation was replayed");
      privateContinuation.consumed = true;
      return updatedInput;
    };
    const consumedInput = consume();
    callbackRecord = { requestId, toolUseID, callbackInput: questionInput, updatedInput: consumedInput };
    return { behavior: "allow", updatedInput: consumedInput, toolUseID };
  };

  const timer = setTimeout(() => {
    timedOut = true;
    messages.length = 0;
    abortController.abort();
    closeQuery();
  }, options.timeoutMs);
  try {
    query = sdk.query({
      prompt: probe.prompt,
      options: {
        abortController,
        pathToClaudeCodeExecutable: options.claudeExecutablePath,
        sessionId,
        cwd: options.cwd,
        model: options.model,
        tools: [SURFACE],
        canUseTool,
        maxTurns: 3,
        settingSources: [],
        plugins: [],
        mcpServers: {},
        strictMcpConfig: true,
        env: childEnv,
      },
    });
    for await (const message of query) {
      if (messages.length >= options.maxMessages) {
        messageLimitExceeded = true;
        messages.length = 0;
        abortController.abort();
        closeQuery();
        fail("SDK message limit exceeded");
      }
      messages.push(message);
    }
    if (timedOut) fail("SDK wall-clock timeout exceeded");
    if (!callbackRecord) fail("Claude SDK did not invoke AskUserQuestion canUseTool");
    return analyzeClaudeAskUserQuestionSdkLifecycle({
      sessionId,
      requestId: callbackRecord.requestId,
      toolUseID: callbackRecord.toolUseID,
      callbackInput: callbackRecord.callbackInput,
      updatedInput: callbackRecord.updatedInput,
      expectedInput: probe.input,
      selectedLabel: probe.selectedLabel,
      messages,
    });
  } catch (error) {
    if (timedOut) {
      messages.length = 0;
      fail("SDK wall-clock timeout exceeded");
    }
    if (messageLimitExceeded) {
      messages.length = 0;
      fail("SDK message limit exceeded");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (timedOut || messageLimitExceeded) closeQuery();
  }
}

function parseArgs(argv) {
  const result = {};
  const supported = new Set([
    "--sdk-entry", "--claude-executable", "--cwd", "--model", "--seed", "--session-id",
    "--timeout-ms", "--max-messages",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!supported.has(key)) fail(`unsupported argument ${key}`);
    if (Object.hasOwn(result, key)) fail(`duplicate argument ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${key} requires a value`);
    index += 1;
    result[key] = value;
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await runClaudeAskUserQuestionSdkProbe({
      sdkEntryPath: args["--sdk-entry"],
      claudeExecutablePath: args["--claude-executable"],
      cwd: args["--cwd"],
      model: args["--model"],
      seed: args["--seed"],
      sessionId: args["--session-id"],
      timeoutMs: args["--timeout-ms"] === undefined ? undefined : Number(args["--timeout-ms"]),
      maxMessages: args["--max-messages"] === undefined ? undefined : Number(args["--max-messages"]),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
