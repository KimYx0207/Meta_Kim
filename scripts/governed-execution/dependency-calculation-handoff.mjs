import { createHash } from "node:crypto";
import path from "node:path";
import { constants as fsConstants, promises as fs } from "node:fs";
import { loadDependencyAgentMethod } from "../dependency-agent-discovery.mjs";
import { runDependencyCalculation, MAX_CALCULATION_INPUT_BYTES, calculationIssues } from "./dependency-calculation.mjs";

export const MAX_CALCULATION_HANDOFF_BYTES = 524288;
const observations = new WeakMap();
const digest = (value) => createHash("sha256").update(value).digest("hex");
const runtimeId = (runtime) => runtime === "claude_code" ? "claude" : runtime;
const summary = (status, fields = {}) => ({ schemaVersion: 1, status, toolInvoked: false,
  nativeAgentInvocation: false, modelSemanticAcceptance: false, ...fields });

export async function readDependencyCalculationInputFile(filename) {
  let handle;
  try {
    // Follow explicitly supplied symlinks to ordinary files. Reject a FIFO or
    // device before open, then guard a check/open replacement on POSIX as well.
    if (!(await fs.stat(filename)).isFile()) return { error: summary("invalid_input", { code: "calculation_materials_file_required" }) };
    handle = await fs.open(filename, process.platform === "win32" ? "r" : fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) return { error: summary("invalid_input", { code: "calculation_materials_file_required" }) };
    const buffer = Buffer.alloc(MAX_CALCULATION_INPUT_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_CALCULATION_INPUT_BYTES) return { error: summary("invalid_input", { code: "calculation_materials_size_limit", maxBytes: MAX_CALCULATION_INPUT_BYTES }) };
    try { return { inputJson: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)) }; }
    catch { return { error: summary("invalid_input", { code: "calculation_materials_invalid_utf8" }) }; }
  } catch (error) {
    return { error: summary("invalid_input", { code: "calculation_materials_file_unreadable",
      fileError: typeof error.code === "string" ? error.code : "READ_FAILED" }) };
  } finally {
    // A close error must not replace the bounded, structured read result.
    if (handle) await handle.close().catch(() => {});
  }
}

// These are host-supplied materials, never a grant or caller-supplied tool receipt.
// Bind before asynchronous route discovery; keep raw materials out of run artifacts.
export function prepareDependencyCalculationInput({ input, task, intentDigest = null, environment = process.env }) {
  if (input == null) return null;
  const invalid = (code) => ({ summary: summary("invalid_input", { code }) });
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some((key) => !["inputJson", "dependencyRoot"].includes(key)) ||
      typeof input.inputJson !== "string" || typeof task !== "string" || task.length > 6000) {
    return invalid("invalid_calculation_input_envelope");
  }
  if (Buffer.byteLength(input.inputJson, "utf8") > MAX_CALCULATION_INPUT_BYTES) {
    return invalid("calculation_materials_size_limit");
  }
  let parsed;
  try { parsed = JSON.parse(input.inputJson); } catch { return invalid("invalid_materials_json"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return invalid("materials_must_be_object");
  const dependencyRoot = input.dependencyRoot ?? environment.META_KIM_KIM_SERVICE_ROOT;
  if (typeof dependencyRoot !== "string" || !path.isAbsolute(dependencyRoot)) return invalid("explicit_dependency_root_required");
  const binding = { requestSha256: digest(task), inputSha256: digest(input.inputJson), intentDigest,
    dependencyRootSha256: digest(path.resolve(dependencyRoot)) };
  return { task, inputJson: input.inputJson, dependencyRoot: path.resolve(dependencyRoot), binding,
    summary: summary("prepared", { binding, inputBytes: Buffer.byteLength(input.inputJson, "utf8") }) };
}

/** Called only after the existing plan/route gate. It always runs the real helper;
 * no public receipt parameter or callback can create a current tool observation. */
export async function prepareDependencyCalculationHandoff({ request, runId, runtime, osTarget, route, workerTaskPackets, environment = process.env }) {
  if (!request || request.summary.status !== "prepared") return { summary: request?.summary ?? summary("not_requested"), handoff: null };
  const fail = (code) => ({ summary: summary("blocked", { code, binding: request.binding }), handoff: null });
  const gate = route?.routeExecutionGate;
  if (gate?.handoffStatus !== "ready_for_host_handoff" || gate.canHandoffToHost !== true || gate.routeCompatible !== true) return fail("calculation_route_not_ready");
  const owner = route.recommendedRoute?.owner;
  const selected = workerTaskPackets.filter((packet) => (packet.ownerAgent ?? packet.owner) === owner);
  if (selected.length !== 1 || selected[0].ownerSource !== "dependency_agent_contract") return fail("calculation_owner_binding_rejected");
  const packet = selected[0];
  let method;
  try { method = await loadDependencyAgentMethod({ packet, environment }); }
  catch { return fail("calculation_owner_source_rejected"); }
  const calculation = await runDependencyCalculation({ task: request.task, inputJson: request.inputJson,
    dependencyRoot: request.dependencyRoot, runtime, osTarget });
  const publicSummary = summary(calculation.status, {
    code: calculation.code ?? null, binding: request.binding, ownerAgent: owner,
    toolInvoked: calculation.toolInvoked, questions: calculation.questions ?? [], missing: calculation.missing ?? [],
    receiptStatus: calculation.receipt?.status ?? null,
    receiptSha256: calculation.receipt ? digest(JSON.stringify(calculation.receipt)) : null,
    issues: calculationIssues(calculation.receipt),
    ...(calculation.maxBytes ? { maxBytes: calculation.maxBytes } : {}),
    execution: calculation.execution ?? null,
    observationScope: "current_invocation",
  });
  if (calculation.route?.owner !== owner || calculation.route?.sourceContentSha256 !== method.componentContentSha256 ||
      calculation.binding?.requestSha256 !== request.binding.requestSha256 || calculation.binding?.inputSha256 !== request.binding.inputSha256) {
    return { summary: { ...publicSummary, status: "blocked", code: "calculation_source_or_binding_rejected" }, handoff: null };
  }
  const conflicts = [...new Set(publicSummary.issues.filter((issue) => issue.code === "definition_conflict").map((issue) => issue.field))];
  if (calculation.route.toolId === "supplier-comparison-calculate" && conflicts.length) return { summary: { ...publicSummary, status: "needs_input", code: "calculation_definition_conflict",
    questions: [`请确认候选报价的${conflicts.map((field) => ({ currency: "币种", specification: "规格与单位", qualityDefinition: "质量评分定义" })[field] ?? field).join("、")}采用什么统一口径；当前不作横向排名。`] }, handoff: null };
  // A process launch failure permits explicitly uncomputed material analysis.
  // Source failures, receipt failures, missing inputs and invalid inputs do not.
  if (!["completed", "partial"].includes(calculation.status) && calculation.code !== "calculation_process_failed") {
    return { summary: publicSummary, handoff: null };
  }
  const handoff = { schemaVersion: 1, runId, runtime: runtimeId(runtime), requestTask: request.task,
    taskPacketId: packet.taskPacketId, ownerAgent: owner, ownerContract: {
      contentDigest: method.contentDigest, componentContentSha256: method.componentContentSha256,
      ownerContractSha256: method.ownerContractSha256,
    }, binding: request.binding,
    materials: { trust: "unverified_host_supplied_materials", inputJson: request.inputJson },
    calculation: { status: calculation.status, code: calculation.code ?? null, toolInvoked: calculation.toolInvoked,
      receipt: calculation.receipt ?? null, execution: calculation.execution ?? null,
      evidence: calculation.receipt ? "current_source_verified_helper_result" : "no_usable_calculation_receipt" },
  };
  const serialized = JSON.stringify(handoff);
  if (Buffer.byteLength(serialized, "utf8") > MAX_CALCULATION_HANDOFF_BYTES) {
    return { summary: { ...publicSummary, status: "blocked", code: "calculation_handoff_size_limit", maxBytes: MAX_CALCULATION_HANDOFF_BYTES }, handoff: null };
  }
  observations.set(handoff, { digest: digest(serialized), packetDigest: digest(JSON.stringify(packet)) });
  return { summary: { ...publicSummary, status: "ready_for_worker", handoffSha256: digest(serialized),
    handoffBytes: Buffer.byteLength(serialized, "utf8") }, handoff };
}

export function calculationHandoffForWorker({ handoff, runId, runtime, requestTask, packet }) {
  if (!handoff) return null;
  const observation = observations.get(handoff);
  if (!observation || observation.digest !== digest(JSON.stringify(handoff)) || handoff.runId !== runId ||
      handoff.runtime !== runtimeId(runtime) || handoff.requestTask !== requestTask) {
    throw new TypeError("calculation_handoff_binding_rejected");
  }
  if (packet.taskPacketId !== handoff.taskPacketId) return null;
  if (observation.packetDigest !== digest(JSON.stringify(packet)) || (packet.ownerAgent ?? packet.owner) !== handoff.ownerAgent) {
    throw new TypeError("calculation_handoff_owner_rejected");
  }
  return structuredClone(handoff);
}
