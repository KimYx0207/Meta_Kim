#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { inspectTrustedPath } from "./safe-managed-file-operations.mjs";
import { openDurableRunRepository } from "../src/application/run/open-durable-run-repository.mjs";
import { createNativeHostAnswerRepository } from "../src/data/repositories/native-host-answer-repository.mjs";
import { createCodexDesktopDecisionHostAdapter } from "../src/adapters/codex/desktop-decision-host-adapter.mjs";
import { createDesktopHumanMilestoneConsumer } from "./governed-execution/plan-challenge-host-continuation.mjs";

const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const bytesDigest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Open the same host adapter for bounded CLI phases and ordinary runner resume.
 * readThread/authorize are trusted host capabilities, not fields on a worker
 * result. The host must retain its original tool call and return privately.
 */
export async function openCodexDesktopHumanMilestoneHost({ projectRoot, exchangeRoot, profileRoot, kernel,
  readThread, authorize, hostConnectionRef }) {
  const root = await fs.realpath(projectRoot);
  const exchangeRelative = path.relative(root, path.resolve(exchangeRoot));
  if (!exchangeRelative.startsWith(`.meta-kim${path.sep}work${path.sep}`)) throw new Error("Desktop exchanges must remain in the project's owned .meta-kim/work directory");
  inspectTrustedPath(root, exchangeRelative, { allowMissing: true });
  if (typeof authorize !== "function") throw new TypeError("Current host scope and pause authority port is required");
  const assertCurrent = async ({ binding, decision }) => {
    if (binding.runtime !== "codex" || path.resolve(binding.projectRoot) !== root) throw new Error("Desktop milestone project/runtime mismatch");
    const admission = await authorize({ runId: binding.runId, nodeId: binding.nodeId, decisionId: decision.decisionId, bindingDigest: binding.bindingDigest });
    if (admission.status !== "ready") throw new Error(`Current host holds this milestone: ${admission.reason}`);
    const resume = kernel.resumeRun({ runId: binding.runId, taskFingerprint: binding.taskFingerprint, graphDigest: binding.graphDigest });
    if (resume.status !== "active" || resume.blockingEffects.length || resume.activeClaims.length) throw new Error("Current run has a terminal state, active claim or unresolved effect");
    const events = kernel.getEvents(binding.runId);
    const current = events.filter((event) => event.eventType === "HumanMilestoneRequested" &&
      event.payload.binding.nodeId === binding.nodeId && event.payload.binding.milestoneId === binding.milestoneId).at(-1);
    if (!current || current.payload.binding.bindingDigest !== binding.bindingDigest || digest(current.payload.decision) !== digest(decision) ||
        events.some((event) => event.eventType === "HumanMilestoneInvalidated" && event.payload.decision.decisionId === decision.decisionId)) {
      throw new Error("Desktop milestone decision is missing, superseded or invalidated");
    }
    const output = resume.completedNodes.find((item) => item.nodeId === binding.nodeId)?.output;
    if (!output || !binding.evidence.some((item) => item.evidenceRef === `artifact:${digest(binding.nodeId)}` && item.digest === `sha256:${output.outputSha256}`)) {
      throw new Error("Desktop milestone no longer binds the current producer output");
    }
    if (binding.artifactRef) {
      const file = inspectTrustedPath(root, binding.artifactRef, { allowMissing: false }).target;
      const actualDigest = `sha256:${bytesDigest(await fs.readFile(file))}`;
      if (!binding.evidence.some((item) => item.evidenceRef === `artifact-file:${digest(binding.artifactRef)}` &&
          item.digest === actualDigest)) throw new Error("Desktop milestone material version changed");
    }
  };
  const exchangePath = (bindingDigest, stage, allowMissing) => {
    if (!/^[a-f0-9]{64}$/u.test(bindingDigest) || !["prepared", "presented", "observed"].includes(stage)) throw new Error("Invalid Desktop exchange identity");
    return inspectTrustedPath(root, path.join(exchangeRelative, bindingDigest, `${stage}.json`), { allowMissing }).target;
  };
  const load = async (bindingDigest, stage) => {
    const file = exchangePath(bindingDigest, stage, true);
    let bytes;
    try { bytes = await fs.readFile(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    const data = JSON.parse(bytes.toString("utf8"));
    const event = kernel.getEvents(data.runId).find((item) => item.eventId === `desktop-milestone:${bindingDigest}:${stage}`);
    if (!event || event.payload.privateDigest !== `sha256:${bytesDigest(bytes)}` || event.payload.bindingDigest !== bindingDigest) {
      throw new Error("Private Desktop exchange has no matching durable digest; preserve it without resending");
    }
    return data.value;
  };
  const profileRelative = path.relative(root, path.resolve(profileRoot));
  if (!profileRelative.startsWith(`.meta-kim${path.sep}state${path.sep}`)) throw new Error("Decision repository must use this project's existing state boundary");
  await fs.mkdir(inspectTrustedPath(root, profileRelative, { allowMissing: true }).target, { recursive: true });
  const adapter = createCodexDesktopDecisionHostAdapter({ repository: createNativeHostAnswerRepository({ profileRoot }), readThread, assertCurrent, hostConnectionRef,
    exchange: { read: load, async write(bindingDigest, stage, value) {
      const current = await load(bindingDigest, stage);
      const ref = `desktop-private:${digest([bindingDigest, stage])}`;
      if (current) {
        if (stage !== "prepared" && digest(current) !== digest(value)) throw new Error("Desktop exchange stage is already bound to another tool result");
        return { created: false, ref, digest: `sha256:${digest(current)}` };
      }
      const file = exchangePath(bindingDigest, stage, true);
      const bytes = Buffer.from(`${JSON.stringify({ runId: value.runId, value })}\n`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      try { await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 }); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        // Another writer wins. A partial/unbound file remains unresolved; it
        // cannot cause a second native question to be issued.
        const existing = await load(bindingDigest, stage);
        if (!existing || stage !== "prepared" && digest(existing) !== digest(value)) throw new Error("Conflicting Desktop exchange write");
        return { created: false, ref, digest: `sha256:${digest(existing)}` };
      }
      kernel.appendEvent({ runId: value.runId, eventId: `desktop-milestone:${bindingDigest}:${stage}`,
        eventType: "HumanMilestoneDesktopExchange", payload: { bindingDigest, stage, privateRef: ref, privateDigest: `sha256:${bytesDigest(bytes)}` } });
      return { created: true, ref, digest: `sha256:${bytesDigest(bytes)}` };
    } } });
  return { adapter, consumer: createDesktopHumanMilestoneConsumer({ adapter }) };
}

/**
 * The shell entry is a transport for the already trusted project host. Its
 * --reader-* arguments assert the retained official call context; they are not
 * an authentication mechanism and must never be filled from model output.
 */
export async function runCodexDesktopHumanMilestoneCli(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    "project-root": { type: "string" }, db: { type: "string" }, input: { type: "string" },
    "exchange-root": { type: "string" }, "profile-root": { type: "string", default: ".meta-kim/state/default" },
    "host-binding-digest": { type: "string" }, "host-connection-ref": { type: "string" }, paused: { type: "boolean", default: false },
    "reader-result": { type: "string" }, "reader-args": { type: "string" }, "reader-call-ref": { type: "string" }, "reader-observed-at": { type: "string" },
  } });
  const [mode] = positionals;
  if (positionals.length !== 1 || !["prepare", "record-presented", "observe", "consume"].includes(mode) ||
      !values["project-root"] || !values.db || !values.input || !values["exchange-root"] || !values["host-connection-ref"]) {
    throw new Error("Use prepare|record-presented|observe|consume --project-root ROOT --db EXISTING_DB --input OWNED_CONTEXT --exchange-root OWNED_DIR --host-connection-ref REF, with the current host scope and actual reader return when needed");
  }
  const root = await fs.realpath(values["project-root"]);
  const owned = (file, allowMissing = false) => {
    if (!file) throw new Error("An owned private tool exchange path is required");
    const relative = path.relative(root, path.resolve(root, file));
    if (!relative.startsWith(`.meta-kim${path.sep}work${path.sep}`)) throw new Error("Raw Desktop materials must remain in .meta-kim/work");
    return inspectTrustedPath(root, relative, { allowMissing }).target;
  };
  const input = JSON.parse(await fs.readFile(owned(values.input), "utf8"));
  const db = inspectTrustedPath(root, path.relative(root, path.resolve(root, values.db)), { allowMissing: false }).target;
  const kernel = await openDurableRunRepository(db);
  try {
    const request = kernel.getEvents(input.runId).find((event) => event.eventType === "HumanMilestoneRequested" && event.payload.binding.bindingDigest === input.bindingDigest);
    if (!request) throw new Error("Use the existing run's current issued milestone, never a local approved flag");
    const host = await openCodexDesktopHumanMilestoneHost({ projectRoot: root, kernel,
      exchangeRoot: owned(values["exchange-root"], true), profileRoot: path.resolve(root, values["profile-root"]), hostConnectionRef: values["host-connection-ref"],
      authorize: async ({ bindingDigest }) => values.paused ? { status: "waiting", reason: "explicit_user_pause" }
        : values["host-binding-digest"] === bindingDigest ? { status: "ready" } : { status: "blocked", reason: "current_host_scope_binding_required" },
      readThread: async () => {
        const raw = await fs.readFile(owned(values["reader-result"]));
        const callArguments = JSON.parse(await fs.readFile(owned(values["reader-args"]), "utf8"));
        return { tool: "mcp__codex_app__read_thread", callRef: values["reader-call-ref"], arguments: callArguments,
          observedAt: values["reader-observed-at"], result: JSON.parse(raw.toString("utf8")), rawRef: `sha256:${bytesDigest(raw)}` };
      } });
    const result = await host.adapter[mode === "record-presented" ? "recordPresented" : mode]({
      binding: request.payload.binding, decision: request.payload.decision, ...(mode === "prepare" ? {
        hostContext: input.hostContext, activeSchema: input.activeSchema, presentation: input.presentation, expiresAt: input.expiresAt,
      } : {}),
    });
    return { ...result, executionAllowed: false, originAuthenticatedByLibrary: false,
      provenanceBoundary: "Only the current trusted host's actual official tool chain establishes source origin; these files and flags do not authenticate it" };
  } finally { kernel.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCodexDesktopHumanMilestoneCli(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === "pending") process.exitCode = 2;
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "pending", reason: error.message, executionAllowed: false, originAuthenticatedByLibrary: false })}\n`);
    process.exitCode = 1;
  });
}
