#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { openDurableRunRepository } from "../src/application/run/open-durable-run-repository.mjs";
import { prepareLiveHostContinuation, completeLiveHostContinuation } from "../src/application/live/plan-live-continuation.mjs";
import { createLiveContinuationCommandStore } from "../src/infrastructure/live/live-continuation-command-store.mjs";
import { createLiveRuntimeAdapterRegistry } from "../src/infrastructure/live/live-runtime-adapter-registry.mjs";
import { canonicalDigest } from "../src/domain/shared/canonical-digest.mjs";
import { inspectTrustedPath } from "./safe-managed-file-operations.mjs";

const EXCHANGE_JSON_ROLES = {
  input: { code: "LIVE_HOST_INPUT_JSON_INVALID", label: "input exchange" },
  existing: { code: "LIVE_HOST_EXISTING_EXCHANGE_JSON_INVALID", label: "existing exchange artifact" },
  request: { code: "LIVE_HOST_REQUEST_JSON_INVALID", label: "prepared request artifact" },
};

function parseExchangeJson(text, role) {
  try { return JSON.parse(text); }
  catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    const { code, label } = EXCHANGE_JSON_ROLES[role];
    // Native JSON errors may quote private work orders or tool returns. Report
    // the controlled file role, never the parser message or its original cause.
    const error = new Error(`Live host continuation: the ${label} file contains invalid JSON`);
    error.code = code;
    error.recovery = {
      status: "recovery_required", artifactRole: role, readOnly: true, mayDispatch: false,
      nextAction: `Inspect the local ${label} file for truncation or invalid syntax and compare it with its original source. Preserve it and reconcile any original host receipt before retrying.`,
    };
    throw error;
  }
}

async function publishExchangeFile(output, value) {
  await fs.mkdir(path.dirname(output), { recursive: true });
  const pending = `${output}.${randomUUID()}.tmp`;
  const handle = await fs.open(pending, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
    await handle.close();
    // Linking the flushed private file publishes a complete artifact without
    // overwriting another exchange that appeared after the initial read.
    await fs.link(pending, output);
  } finally {
    await handle.close().catch(() => {});
    await fs.rm(pending, { force: true }).catch(() => {});
  }
}

/** One bounded host exchange. This process has no Codex chat tools or sender. */
export async function runLiveHostContinuationCli(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    "project-root": { type: "string" }, db: { type: "string" }, profile: { type: "string", default: "default" },
    input: { type: "string" }, output: { type: "string" }, request: { type: "string" }, "work-order": { type: "string" },
    "authorized-command-digest": { type: "string" }, "approval-ref": { type: "string" },
    paused: { type: "boolean", default: false }, outcome: { type: "string", default: "unknown" },
  } });
  const [mode] = positionals;
  if (positionals.length !== 1 || !["prepare", "commit"].includes(mode) || !values["project-root"] || !values.db || !values.input) {
    throw new Error("Use prepare|commit --project-root ROOT --db EXISTING_DB --input OWNED_JSON; prepare also requires --output and handoff --work-order, commit --request.");
  }
  const root = await fs.realpath(values["project-root"]);
  const ownedPath = (value, allowMissing = false) => {
    if (!value) throw new Error("An owned exchange path is required");
    const relative = path.relative(root, path.resolve(root, value));
    if (!relative.startsWith(`.meta-kim${path.sep}work${path.sep}`)) throw new Error("Exchange files must be inside the project's .meta-kim/work directory");
    return inspectTrustedPath(root, relative, { allowMissing }).target;
  };
  const rawInput = await fs.readFile(ownedPath(values.input));
  const input = parseExchangeJson(rawInput.toString("utf8"), "input");
  const db = inspectTrustedPath(root, path.relative(root, path.resolve(root, values.db)), { allowMissing: false }).target;
  const store = createLiveContinuationCommandStore({ projectRoot: root, profile: values.profile });
  const registry = createLiveRuntimeAdapterRegistry({ adapters: [{ adapterId: "codex-host-threads", runtime: "codex",
    capabilities: ["handoff", "resume"], execute() { throw new Error("Only the current host can call the chat tools"); } }] });
  const kernel = await openDurableRunRepository(db);
  try {
    const context = { adapterRegistry: registry, commandStore: store, durableRepository: kernel };
    if (mode === "prepare") {
      const workOrder = values["work-order"] ? await fs.readFile(ownedPath(values["work-order"]), "utf8") : undefined;
      const output = ownedPath(values.output, true);
      let previous = null;
      try { previous = parseExchangeJson(await fs.readFile(output, "utf8"), "existing"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (previous && previous.commandDigest !== input.commandDigest) throw new Error("Existing exchange belongs to another command");
      // These arguments are supplied by the current authorized host, separately
      // from task JSON. They bind its scope assertion; they do not authenticate a human.
      const authorize = !values["authorized-command-digest"] || !values["approval-ref"] ? undefined : async ({ command }) => {
        if (values.paused) return { status: "waiting", reason: "explicit_user_pause" };
        if (values["authorized-command-digest"] !== command.commandDigest || values["approval-ref"] !== command.payload.approvalRef) {
          return { status: "blocked", reason: "host_authorization_binding_mismatch" };
        }
        return { status: "ready", commandDigest: command.commandDigest, approvalRef: values["approval-ref"],
          targetThreadId: command.payload.targetThreadId, workOrderDigest: command.payload.workOrderDigest };
      };
      const prepared = await prepareLiveHostContinuation({ ...context, command: input, workOrder, authorize });
      if (previous && prepared.request && (previous.requestDigest !== prepared.requestDigest ||
          canonicalDigest(previous.request) !== canonicalDigest(prepared.request) || previous.effect?.effectId !== prepared.effect?.effectId)) {
        throw new Error("Existing exchange request binding changed");
      }
      let requestArtifactState = previous ? "existing" : "absent";
      if (!previous && ["prepared", "already_prepared"].includes(prepared.status)) {
        await publishExchangeFile(output, { commandId: input.commandId, commandDigest: input.commandDigest, ...prepared });
        requestArtifactState = prepared.status === "prepared" ? "created" : "restored";
      }
      return { status: prepared.status, reason: prepared.reason, mayDispatch: prepared.mayDispatch,
        effectId: prepared.effect?.effectId, effectState: prepared.effectState, requestDigest: prepared.requestDigest,
        tool: prepared.request?.tool, targetThreadId: input.payload?.targetThreadId, requestPath: output,
        requestArtifactState,
        nextAction: prepared.status === "already_prepared" ? "reconcile_original_host_return" : undefined,
        authorizationAuthenticatedByLibrary: false, completionVerified: false };
    }
    if (!["returned", "unknown"].includes(values.outcome)) throw new Error("Receipt outcome must be returned or unknown");
    const prepared = parseExchangeJson(await fs.readFile(ownedPath(values.request), "utf8"), "request");
    const record = (await store.list()).find((item) => item.command.commandId === prepared.commandId);
    if (!record || record.command.commandDigest !== prepared.commandDigest) throw new Error("Prepared request has no matching command log record");
    const receipt = { effectId: prepared.effect.effectId, requestDigest: prepared.requestDigest,
      targetThreadId: record.command.payload.targetThreadId, tool: prepared.request.tool, outcome: values.outcome, toolResult: input };
    const result = await completeLiveHostContinuation({ ...context, command: record.command,
      workOrder: prepared.request.arguments.prompt, receipt });
    return { ...result, rawReceiptSha256: createHash("sha256").update(rawInput).digest("hex") };
  } finally { kernel.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runLiveHostContinuationCli(process.argv.slice(2)).then((result) => {
    process.stdout.write(JSON.stringify(result) + "\n");
    if (["blocked", "waiting", "in_doubt"].includes(result.status)) process.exitCode = 2;
  }).catch((error) => {
    process.stderr.write(JSON.stringify({ status: "blocked", code: error.code ?? null, error: error.message,
      ...(error.recovery ? { recovery: error.recovery } : {}) }) + "\n");
    process.exitCode = 1;
  });
}
