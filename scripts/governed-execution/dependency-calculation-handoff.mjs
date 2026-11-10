import { createHash } from "node:crypto";
import path from "node:path";
import { constants as fsConstants, promises as fs } from "node:fs";
import { loadDependencyAgentMethod, stableJson } from "../dependency-agent-discovery.mjs";
import { runDependencyCalculation, MAX_CALCULATION_INPUT_BYTES } from "./dependency-calculation.mjs";

export const MAX_CALCULATION_HANDOFF_BYTES = 524288;
const observations = new WeakMap();
const digest = (value) => createHash("sha256").update(value).digest("hex");
const runtimeId = (runtime) => runtime === "claude_code" ? "claude" : runtime;
const summary = (status, fields = {}) => ({ schemaVersion: 1, status, toolInvoked: false,
  nativeAgentInvocation: false, modelSemanticAcceptance: false, ...fields });
const ownerSourceBinding = (method, runId, taskPacketId) => ({ runId, taskPacketId, ownerAgent: method.ownerAgent,
  ownerContractSha256: method.ownerContractSha256, componentContentSha256: method.componentContentSha256 });

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

/** The optional CLI mapping shares the material reader's regular-file, UTF-8
 * and byte limits. Its contents stay private and remain unverified host data. */
export async function readDependencyCalculationMethodInputsFile(filename) {
  const input = await readDependencyCalculationInputFile(filename);
  if (input.error) return input;
  try {
    const methodInputs = JSON.parse(input.inputJson);
    if (!methodInputs || typeof methodInputs !== "object" || Array.isArray(methodInputs)) throw new TypeError();
    return { methodInputs };
  } catch { return { error: summary("invalid_input", { code: "invalid_calculation_method_inputs" }) }; }
}

// These are host-supplied materials, never a grant or caller-supplied tool receipt.
// Optional methodInputs are the host's unverified mapping of inputJson to the
// selected professional input contract, not independently established facts.
// Bind before asynchronous route discovery; keep both raw inputs out of artifacts.
export function prepareDependencyCalculationInput({ input, task, intentDigest = null, environment = process.env }) {
  if (input == null) return null;
  const invalid = (code) => ({ summary: summary("invalid_input", { code }) });
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some((key) => !["inputJson", "dependencyRoot", "methodInputs"].includes(key)) ||
      typeof input.inputJson !== "string" || typeof task !== "string" || task.length > 6000) {
    return invalid("invalid_calculation_input_envelope");
  }
  if (Buffer.byteLength(input.inputJson, "utf8") > MAX_CALCULATION_INPUT_BYTES) {
    return invalid("calculation_materials_size_limit");
  }
  let parsed;
  try { parsed = JSON.parse(input.inputJson); } catch { return invalid("invalid_materials_json"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return invalid("materials_must_be_object");
  let methodInputs;
  if (input.methodInputs != null) {
    try {
      if (typeof input.methodInputs !== "object" || Array.isArray(input.methodInputs)) return invalid("invalid_calculation_method_inputs");
      const serialized = stableJson(input.methodInputs);
      if (Buffer.byteLength(serialized, "utf8") > MAX_CALCULATION_INPUT_BYTES) return invalid("calculation_method_inputs_size_limit");
      methodInputs = JSON.parse(serialized);
    } catch { return invalid("invalid_calculation_method_inputs"); }
  }
  const dependencyRoot = input.dependencyRoot ?? environment.META_KIM_KIM_SERVICE_ROOT;
  if (typeof dependencyRoot !== "string" || !path.isAbsolute(dependencyRoot)) return invalid("explicit_dependency_root_required");
  const binding = { requestSha256: digest(task), inputSha256: digest(input.inputJson), intentDigest,
    dependencyRootSha256: digest(path.resolve(dependencyRoot)),
    ...(methodInputs ? { methodInputsSha256: digest(stableJson(methodInputs)) } : {}) };
  return { task, inputJson: input.inputJson, ...(methodInputs ? { methodInputs } : {}), dependencyRoot: path.resolve(dependencyRoot), binding,
    summary: summary("prepared", { binding, inputBytes: Buffer.byteLength(input.inputJson, "utf8") }) };
}

/** Thinking binds a non-file work order to the actual bounded materials and a
 * freshly verified read-only owner. This does not execute the calculation or
 * establish native invocation; the existing handoff verifies those separately. */
export async function bindDependencyCalculationWorkOrder({ request, runId, route, workerTaskPackets, environment = process.env, projectRoot }) {
  if (request?.summary?.status !== "prepared") return workerTaskPackets;
  const rebound = prepareDependencyCalculationInput({ input: { inputJson: request.inputJson, dependencyRoot: request.dependencyRoot, methodInputs: request.methodInputs },
    task: request.task, intentDigest: request.binding?.intentDigest, environment });
  if (rebound.summary.status !== "prepared" || JSON.stringify(rebound.binding) !== JSON.stringify(request.binding)) return workerTaskPackets;
  const owner = route?.recommendedRoute?.owner;
  const selected = workerTaskPackets.filter((packet) => (packet.ownerAgent ?? packet.owner) === owner);
  if (selected.length !== 1 || selected[0].ownerSource !== "dependency_agent_contract") return workerTaskPackets;
  const packet = selected[0];
  let method;
  try { method = await loadDependencyAgentMethod({ packet, environment, projectRoot }); }
  catch { return workerTaskPackets; }
  if (!method?.tools?.length || method.tools.some((tool) => tool !== "Read") ||
      !Array.isArray(packet.ownerContract?.sideEffects) || packet.ownerContract.sideEffects.length !== 0) return workerTaskPackets;
  const shardScope = [`input-sha256:${request.binding.inputSha256}`];
  // Record the source observation only after reloading the verified component.
  // Its original contract digest is distinct from the redacted public projection.
  request.summary.ownerSourceBinding = ownerSourceBinding(method, runId, packet.taskPacketId);
  const workOrderScope = { kind: "dependency_materials", runId, ...request.binding, inputBytes: request.summary.inputBytes,
    ownerContractSha256: method.ownerContractSha256, ownerContractProjectionSha256: digest(stableJson(packet.ownerContract)),
    componentContentSha256: method.componentContentSha256 };
  return workerTaskPackets.map((entry) => entry !== packet ? entry : {
    ...entry, workOrderScope, scopeFiles: [], shardScope, workOrderReadiness: "ready",
    safetyEvidence: { status: "proven", evidenceBasis: "verified_readonly_owner_and_bound_materials",
      shardScope, dependencyEvidence: "single_materials_owner", mutationPolicy: "read_only",
      workspaceIsolation: "shared_workspace_read_only", externalWritePolicy: "forbidden", collisionPolicy: "no_overlap" },
    dependencyEvidence: "single_materials_owner", mutationPolicy: "read_only",
    workspaceIsolation: "shared_workspace_read_only", externalWritePolicy: "forbidden", externalWriteBoundary: false,
    collisionPolicy: "no_overlap", finalizationGate: route.routeExecutionGate?.hostAction ?? "host_action_required",
  });
}

/** Called only after the existing plan/route gate. It always runs the real helper;
 * no public receipt parameter or callback can create a current tool observation. */
export async function prepareDependencyCalculationHandoff({ request, runId, runtime, osTarget, route, workerTaskPackets, environment = process.env, projectRoot }) {
  if (!request || request.summary.status !== "prepared") return { summary: request?.summary ?? summary("not_requested"), handoff: null };
  const fail = (code) => ({ summary: summary("blocked", { ...request.summary, status: "blocked", code }), handoff: null });
  const gate = route?.routeExecutionGate;
  if (gate?.handoffStatus !== "ready_for_host_handoff" || gate.canHandoffToHost !== true || gate.routeCompatible !== true) return fail("calculation_route_not_ready");
  const owner = route.recommendedRoute?.owner;
  const selected = workerTaskPackets.filter((packet) => (packet.ownerAgent ?? packet.owner) === owner);
  if (selected.length !== 1 || selected[0].ownerSource !== "dependency_agent_contract") return fail("calculation_owner_binding_rejected");
  const packet = selected[0];
  let method;
  try { method = await loadDependencyAgentMethod({ packet, environment, projectRoot }); }
  catch { return fail("calculation_owner_source_rejected"); }
  // Project an existing, checked Thinking decision. Never create reasoning or
  // rebind another task's work order merely by copying this request's hash.
  const rebound = prepareDependencyCalculationInput({ input: { inputJson: request.inputJson, dependencyRoot: request.dependencyRoot, methodInputs: request.methodInputs },
    task: request.task, intentDigest: request.binding?.intentDigest, environment });
  if (rebound?.summary.status !== "prepared" || stableJson(rebound.binding) !== stableJson(request.binding)) {
    return fail("calculation_request_binding_rejected");
  }
  if (request.methodInputs && packet.methodInputs != null && stableJson(request.methodInputs) !== stableJson(packet.methodInputs)) {
    return fail("calculation_method_inputs_conflict");
  }
  const taskHash = digest(request.task.trim());
  const intentMatches = (value) => value?.taskHash === taskHash && (value.intentDigest ?? null) === (request.binding.intentDigest ?? null);
  const selectedRoute = route.recommendedRoute;
  const provider = selectedRoute?.selectedCapabilityProviders?.agent;
  if (!intentMatches(route.intentBinding) || !intentMatches(packet.intentBinding) ||
      route.task !== route.intentBinding.routeTask || runtimeId(route.runtime) !== runtimeId(runtime) ||
      runtimeId(selectedRoute?.runtime) !== runtimeId(runtime) ||
      selectedRoute?.selectionPolicy !== "host_selected_current_bindings" ||
      selectedRoute.selectionStatus !== "bindings_verified_not_invoked" || selectedRoute.blockedReasons?.length ||
      provider?.id !== owner || provider.source !== "dependency_agent_contract" ||
      provider.contentDigest !== packet.ownerContract?.contentDigest || provider.contentDigest !== method.contentDigest ||
      provider.ownerContract?.componentContentSha256 !== packet.ownerContract?.componentContentSha256 ||
      provider.ownerContract?.componentContentSha256 !== method.componentContentSha256) {
    return fail("calculation_thinking_binding_rejected");
  }
  const scope = packet.workOrderScope;
  if (scope?.kind !== "dependency_materials" || scope.runId !== runId ||
      !["requestSha256", "inputSha256", "intentDigest", "dependencyRootSha256", "methodInputsSha256"]
        .every(key => (scope[key] ?? null) === (request.binding[key] ?? null)) ||
      scope.inputBytes !== request.summary.inputBytes || scope.inputBytes !== Buffer.byteLength(request.inputJson, "utf8") ||
      scope.ownerContractSha256 !== method.ownerContractSha256 || scope.componentContentSha256 !== method.componentContentSha256 ||
      scope.ownerContractProjectionSha256 !== digest(stableJson(packet.ownerContract)) ||
      packet.scopeFiles?.length !== 0 || packet.shardScope?.length !== 1 ||
      packet.shardScope[0] !== `input-sha256:${request.binding.inputSha256}`) {
    return fail("calculation_work_order_binding_rejected");
  }
  const methodAssessment = { schemaVersion: 1, runtime, taskHash: request.binding.requestSha256,
    agentId: owner, contentDigest: packet.ownerContract.contentDigest,
    componentContentSha256: packet.ownerContract.componentContentSha256,
    operation: packet.todayTask, deliverable: packet.output, fitRationale: selectedRoute.selectionReason,
    nonGoals: packet.nonGoals, evidenceRefs: packet.evidenceRefs };
  const calculation = await runDependencyCalculation({ task: request.task, inputJson: request.inputJson,
    methodAssessment, dependencyRoot: request.dependencyRoot, runtime, osTarget, environment, projectRoot });
  const publicSummary = summary(calculation.status, {
    code: calculation.code ?? null, binding: request.binding, ownerAgent: owner,
    ownerSourceBinding: ownerSourceBinding(method, runId, packet.taskPacketId),
    inputBytes: request.summary.inputBytes,
    toolInvoked: calculation.toolInvoked, questions: calculation.questions ?? [], missing: calculation.missing ?? [],
    receiptStatus: calculation.receipt?.status ?? null,
    receiptSha256: calculation.receipt ? digest(JSON.stringify(calculation.receipt)) : null,
    // Domain issues may contain user row identifiers or free-text materials.
    // Public artifacts retain a machine code and binding, never those details.
    issues: (calculation.issues ?? []).map(issue => ({
      code: typeof issue.code === "string" && /^[a-z][a-z0-9_]{0,95}$/u.test(issue.code)
        ? issue.code : "unclassified_calculation_issue",
      detailSha256: digest(stableJson(issue)),
    })),
    ...(calculation.maxBytes ? { maxBytes: calculation.maxBytes } : {}),
    execution: calculation.execution ?? null,
    observationScope: "current_invocation",
  });
  if (calculation.route?.owner !== owner || calculation.route?.sourceContentSha256 !== method.componentContentSha256 ||
      calculation.binding?.requestSha256 !== request.binding.requestSha256 || calculation.binding?.inputSha256 !== request.binding.inputSha256) {
    return { summary: { ...publicSummary, status: "blocked", code: "calculation_source_or_binding_rejected" }, handoff: null };
  }
  if (["completed", "partial"].includes(calculation.status) && calculation.handoff && calculation.handoff.status !== "ready") return {
    summary: { ...publicSummary, status: calculation.handoff.status,
      code: calculation.handoff.code, questions: calculation.handoff.questions }, handoff: null };
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
    materials: { trust: "unverified_host_supplied_materials", inputJson: request.inputJson,
      ...(request.methodInputs ? { methodInputs: structuredClone(request.methodInputs),
        methodInputsTrust: "unverified_host_mapping_of_original_input_json" } : {}) },
    calculation: { status: calculation.status, code: calculation.code ?? null, toolInvoked: calculation.toolInvoked,
      receipt: calculation.receipt ?? null, execution: calculation.execution ?? null, issues: calculation.issues ?? [],
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
