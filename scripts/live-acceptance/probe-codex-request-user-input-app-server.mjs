/**
 * Real-process Codex app-server request_user_input transport probe.
 *
 * The probe launches the installed Codex app-server and answers as its own
 * scripted client. It proves only that the real process emitted and accepted
 * the exact JSON-RPC exchange. It never claims Codex Desktop UI, a human
 * answer, current-host authority, or execution authorization.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveCliInvocation } from "../runtime-cli-invocation.mjs";
import { snapshotCodexRequestUserInputRequest } from "../../src/adapters/codex/app-server-decision-host-adapter.mjs";
const REQUEST_METHOD = "item/tool/requestUserInput";
const STDERR_TAIL_LIMIT = 8 * 1024;
const MAX_OPTIONS = 64;
const MAX_CANONICAL_REQUEST_BYTES = 64 * 1024;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex")}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function redactProbeDiagnostic(value, sensitiveValues = []) {
  let output = String(value ?? "")
    .replace(/\b(?:authorization\s*:\s*)?bearer\s+[A-Za-z0-9._~+\/-]+/giu, "Bearer <redacted>")
    .replace(/\b([A-Za-z0-9_]*(?:api[_-]?key|token|password))\b(?:\s*[:=]\s*|\s+)[^\s,;]+/giu, "$1=<redacted>")
    .replace(/\b(provider|modelProvider)\b(?:\s*[:=]\s*|\s+)[`"']?[^\s,;`"']+/giu, "$1=<redacted>")
    .replace(/[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n]+[\\/])*[^\\/:*?"<>|\r\n]*/gu, "<redacted-path>")
    .replace(/\/(?:Users|home)\/[^\s:;,"']+(?:\/[^\s:;,"']+)*/gu, "<redacted-path>");
  for (const sensitive of sensitiveValues) {
    if (typeof sensitive === "string" && sensitive) {
      output = output.replace(new RegExp(escapeRegExp(sensitive), "gu"), "<redacted-answer>");
    }
  }
  return output;
}

export function buildScriptedRequestUserInputResponse(request, selectedLabel) {
  const snapshot = snapshotTransportRequest(request);
  const question = snapshot.params.questions[0];
  if (!question.options.some((option) => option.label === selectedLabel)) {
    throw new Error("selected label is not present in the real app-server request");
  }
  return Object.freeze({
    id: snapshot.id,
    result: Object.freeze({
      answers: Object.freeze({
        [question.id]: Object.freeze({ answers: Object.freeze([selectedLabel]) }),
      }),
    }),
  });
}

export function snapshotTransportRequest(request) {
  const snapshot = snapshotCodexRequestUserInputRequest(request);
  const question = snapshot.params.questions[0];
  if (question.isSecret === true) throw new Error("probe refuses secret input");
  if (question.options.length > MAX_OPTIONS) throw new Error("request options exceed the probe safety limit");
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_CANONICAL_REQUEST_BYTES) {
    throw new Error("canonical request exceeds the probe safety byte limit");
  }
  // Codex 0.146 may set isOther=true on the real native surface. The probe
  // records that transport fact but responds only with a known option label.
  return snapshot;
}

function createJsonRpcClient(child) {
  let nextId = 1;
  let buffer = "";
  const pending = new Map();
  const waiters = [];
  let stderrTail = "";

  const deliver = (message) => {
    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")) && pending.has(String(message.id))) {
      const waiter = pending.get(String(message.id));
      pending.delete(String(message.id));
      if (message.error) waiter.reject(new Error(`Codex app-server ${waiter.method} error: ${JSON.stringify(message.error)}`));
      else waiter.resolve(message.result);
      return;
    }
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      waiter.resolve(message);
    }
  };

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    while (buffer.includes("\n")) {
      const boundary = buffer.indexOf("\n");
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      if (!line) continue;
      try { deliver(JSON.parse(line)); }
      catch (error) {
        for (const waiter of pending.values()) waiter.reject(error);
        pending.clear();
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-STDERR_TAIL_LIMIT);
  });

  const write = (message) => child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  return Object.freeze({
    request(method, params) {
      const id = nextId++;
      const promise = new Promise((resolve, reject) => pending.set(String(id), { resolve, reject, method }));
      write({ id, method, params });
      return promise;
    },
    notify(method, params) {
      write(params === undefined ? { method } : { method, params });
    },
    respond(message) { write(message); },
    waitFor(predicate) {
      return new Promise((resolve, reject) => waiters.push({ predicate, resolve, reject }));
    },
    stderrTail: (sensitiveValues = []) => redactProbeDiagnostic(stderrTail.slice(-2000), sensitiveValues),
  });
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function runCodexRequestUserInputTransportProbe({
  cwd = process.cwd(),
  selectedLabel = "Keep",
  timeoutMs = 120_000,
} = {}) {
  if (!["Keep", "Change"].includes(selectedLabel)) throw new Error("selectedLabel must be Keep or Change");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) throw new Error("timeoutMs is out of range");
  const invocation = resolveCliInvocation("codex", [
    "app-server",
    "--stdio",
    "--enable",
    "default_mode_request_user_input",
  ]);
  const child = spawn(invocation.command, invocation.args, {
    cwd,
    env: process.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = createJsonRpcClient(child);
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const timeout = (promise, label) => withTimeout(promise, timeoutMs, label);

  try {
    await timeout(client.request("initialize", {
      clientInfo: { name: "meta-kim-transport-probe", title: "Meta_Kim transport probe", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    }), "initialize");
    client.notify("initialized");

    const thread = await timeout(client.request("thread/start", {
      cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      baseInstructions: [
        "You are running a request_user_input protocol transport probe.",
        "Call request_user_input exactly once and call no other tool.",
        "Use exactly one question: id route_choice, header Route, question Choose the route.",
        "Use exactly two options: Keep / Keep current route. and Change / Change route.",
        "After the answer, reply briefly with the selected label.",
      ].join(" "),
    }), "thread/start");
    const threadId = thread?.thread?.id;
    if (typeof threadId !== "string" || !threadId) throw new Error("thread/start returned no thread id");

    const serverRequestPromise = client.waitFor((message) => message?.method === REQUEST_METHOD);
    const turnCompletedPromise = client.waitFor((message) => message?.method === "turn/completed");
    const turn = await timeout(client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "Run the exact request_user_input transport probe now." }],
    }), "turn/start");
    const turnId = turn?.turn?.id;
    if (typeof turnId !== "string" || !turnId) throw new Error("turn/start returned no turn id");

    const request = snapshotTransportRequest(await timeout(serverRequestPromise, REQUEST_METHOD));
    if (request.params.threadId !== threadId || request.params.turnId !== turnId) {
      throw new Error("real app-server request is not bound to the started thread/turn");
    }
    const response = buildScriptedRequestUserInputResponse(request, selectedLabel);
    client.respond(response);
    const completed = await timeout(turnCompletedPromise, "turn/completed");
    if (completed?.params?.turn?.id !== turnId) throw new Error("turn/completed did not match the probed turn");

    return Object.freeze({
      schemaVersion: "codex-request-user-input-transport-probe-v1",
      status: "transport_observed",
      target: "codex_app_server_stdio",
      codexDesktopObserved: false,
      answerSource: "scripted_probe_client",
      humanVerified: false,
      currentHostAuthority: false,
      executionAllowed: false,
      requestMethod: REQUEST_METHOD,
      requestIdType: typeof request.id,
      threadBindingMatched: true,
      turnBindingMatched: true,
      itemBindingPresent: Boolean(request.params.itemId),
      renderedHostPayloadDigest: digest(request.params.questions),
      nativeOtherOptionExposed: request.params.questions[0].isOther === true,
      responseDigest: digest(response),
      completedTurnMatched: true,
      authorityBoundary: "real_app_server_transport_scripted_client_non_authorizing",
    });
  } catch (error) {
    throw new Error(`${redactProbeDiagnostic(error?.message, [selectedLabel])}; app-server stderr: ${client.stderrTail([selectedLabel])}`);
  } finally {
    child.stdin.end();
    const ended = await Promise.race([
      exit.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    if (!ended) child.kill();
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--answer") options.selectedLabel = argv[++index];
    else if (argv[index] === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (argv[index] === "--cwd") options.cwd = argv[++index];
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  return runCodexRequestUserInputTransportProbe(options);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${redactProbeDiagnostic(error?.message)}\n`);
      process.exitCode = 1;
    });
}
