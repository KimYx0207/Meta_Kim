import { createHash } from "node:crypto";

const ADAPTER_SCHEMA = "meta-kim-ready-set-adapter-result-v0.1";
const AUTHORITY_PACKET_REF = "coreLoop.stageDagPacket";

const sha256 = (value) =>
  createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");

function adapterError(code, message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function exactNodeIds(readyNodes) {
  if (!Array.isArray(readyNodes) || readyNodes.length === 0) {
    throw adapterError("ready_set_invalid", "readyNodes must be a non-empty array");
  }
  const ids = readyNodes.map((node) => String(node?.nodeId ?? ""));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw adapterError("ready_set_invalid", "readyNodes must have unique non-empty nodeId values");
  }
  return ids;
}

export function readySetDigest({ runId, graphDigest, batchIndex, nodeIds }) {
  return sha256(JSON.stringify({ runId, graphDigest, batchIndex, nodeIds }));
}

function serializeError(error) {
  return {
    name: String(error?.name ?? "Error"),
    message: String(error?.message ?? error ?? "ready-set callback failed").slice(0, 2_000),
    code: error?.code == null ? null : String(error.code),
  };
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw adapterError(
    "ready_set_adapter_aborted",
    `Ready-set adapter was aborted: ${String(signal.reason ?? "process safety timeout")}`,
  );
}

function assertJsonSerializable(value, label) {
  const seen = new WeakSet();
  const visit = (current, path = label) => {
    if (current === null || typeof current === "string" || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (Number.isFinite(current)) return;
      throw adapterError("adapter_result_not_serializable", `${path} must contain only finite numbers`);
    }
    if (["undefined", "bigint", "symbol", "function"].includes(typeof current)) {
      throw adapterError(
        "adapter_result_not_serializable",
        `${path} contains unsupported JSON value type ${typeof current}`,
      );
    }
    if (typeof current !== "object") return;
    if (seen.has(current)) {
      throw adapterError("adapter_result_not_serializable", `${path} contains a circular reference`);
    }
    const prototype = Object.getPrototypeOf(current);
    if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) {
      throw adapterError("adapter_result_not_serializable", `${path} must contain only plain objects`);
    }
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}[${index}]`));
    } else {
      Object.entries(current).forEach(([key, item]) => visit(item, `${path}.${key}`));
    }
    seen.delete(current);
  };
  try {
    visit(value);
    JSON.stringify(value);
  } catch (error) {
    if (error?.code === "adapter_result_not_serializable") throw error;
    throw adapterError("adapter_result_not_serializable", `${label} must be strictly JSON-serializable`, error);
  }
}

function buildResult({
  adapterId,
  runtimeExecutionEvidence,
  runId,
  graphDigest,
  batchIndex,
  nodeIds,
  settlements,
  invocationCounts,
  optionalDependency = null,
}) {
  const result = {
    schemaVersion: ADAPTER_SCHEMA,
    prdTaskId: "P-119",
    adapterId,
    status: settlements.every((entry) => entry.status === "fulfilled") ? "pass" : "node_failure",
    authorityPacketRef: AUTHORITY_PACKET_REF,
    topologyAuthorityConsumed: false,
    checkpointAuthority: "p118_durable_run_kernel_only",
    runtimeExecutionEvidence,
    runId,
    graphDigest,
    batchIndex,
    selectedNodeIds: nodeIds,
    readySetDigest: readySetDigest({ runId, graphDigest, batchIndex, nodeIds }),
    executionState: "settled",
    callbackExecutionEvidence: nodeIds.map((nodeId) => ({
      nodeId,
      invocationCount: invocationCounts.get(nodeId) ?? 0,
      settled: true,
    })),
    results: settlements,
    optionalDependency,
  };
  assertJsonSerializable(result, "ready-set adapter result");
  return result;
}

async function executeCallbacksOnce(readyNodes, executeNode, signal = null) {
  throwIfAborted(signal);
  const nodeIds = exactNodeIds(readyNodes);
  const selectedNodeIds = new Set(nodeIds);
  const invocationCounts = new Map();
  const invoke = async (nodeId) => {
    throwIfAborted(signal);
    if (!selectedNodeIds.has(nodeId)) {
      throw adapterError("adapter_unknown_node", `Adapter attempted unknown node: ${nodeId}`);
    }
    const count = (invocationCounts.get(nodeId) ?? 0) + 1;
    invocationCounts.set(nodeId, count);
    if (count !== 1) {
      throw adapterError("adapter_duplicate_node_invocation", `Adapter invoked node more than once: ${nodeId}`);
    }
    try {
      const value = await executeNode(nodeId);
      return { nodeId, status: "fulfilled", value };
    } catch (error) {
      return { nodeId, status: "rejected", error: serializeError(error) };
    }
  };
  return { nodeIds, invocationCounts, invoke };
}

export async function executeNativeReadySet({
  runId,
  graphDigest,
  readyNodes,
  executeNode,
  batchIndex = 0,
  signal = null,
}) {
  const { nodeIds, invocationCounts, invoke } = await executeCallbacksOnce(readyNodes, executeNode, signal);
  const settlements = await Promise.all(nodeIds.map((nodeId) => invoke(nodeId)));
  throwIfAborted(signal);
  return buildResult({
    adapterId: "native_ready_set",
    runtimeExecutionEvidence: "native_promise_all_settled",
    runId,
    graphDigest,
    batchIndex,
    nodeIds,
    settlements,
    invocationCounts,
  });
}

function validateLangGraphRuntime(runtime) {
  if (typeof runtime?.entrypoint !== "function" || typeof runtime?.task !== "function") {
    throw adapterError(
      "adapter_dependency_incompatible",
      "@langchain/langgraph must expose Functional API entrypoint and task",
    );
  }
  return runtime;
}

export function createLangGraphReadySetExecutor({
  loadRuntime = () => import("@langchain/langgraph"),
} = {}) {
  return async function executeLangGraphReadySet({
    runId,
    graphDigest,
    readyNodes,
    executeNode,
    batchIndex = 0,
    signal = null,
  }) {
    throwIfAborted(signal);
    let runtime;
    try {
      runtime = validateLangGraphRuntime(await loadRuntime());
    } catch (error) {
      if (error?.code === "adapter_dependency_incompatible") throw error;
      throw adapterError(
        error?.code === "ERR_MODULE_NOT_FOUND"
          ? "optional_dependency_missing"
          : "optional_adapter_unavailable",
        `LangGraph ready-set adapter is unavailable: ${error.message}`,
        error,
      );
    }
    throwIfAborted(signal);
    const { nodeIds, invocationCounts, invoke } = await executeCallbacksOnce(
      readyNodes,
      executeNode,
      signal,
    );
    const executeSelectedNode = runtime.task(
      "meta_kim_execute_selected_ready_node",
      async (nodeId) => {
        throwIfAborted(signal);
        return invoke(nodeId);
      },
    );
    let entrypointInvocationCount = 0;
    const workflow = runtime.entrypoint(
      { name: "meta_kim_execute_selected_ready_set" },
      async (input) => {
        entrypointInvocationCount += 1;
        if (entrypointInvocationCount !== 1) {
          throw adapterError(
            "adapter_wrapper_reentered",
            "LangGraph ready-set wrapper executed more than once",
          );
        }
        if (JSON.stringify(input.nodeIds) !== JSON.stringify(nodeIds)) {
          throw adapterError("adapter_ready_set_changed", "LangGraph wrapper input changed the ready set");
        }
        return Promise.all(input.nodeIds.map((nodeId) => executeSelectedNode(nodeId)));
      },
    );
    const settlements = await workflow.invoke({ nodeIds }, { signal });
    throwIfAborted(signal);
    return buildResult({
      adapterId: "langgraph_functional_ready_set",
      runtimeExecutionEvidence: "langgraph_functional_entrypoint_tasks_observed",
      runId,
      graphDigest,
      batchIndex,
      nodeIds,
      settlements,
      invocationCounts,
      optionalDependency: {
        package: "@langchain/langgraph",
        requiredExports: ["entrypoint", "task"],
        persistenceEnabled: false,
      },
    });
  };
}

export function resolveReadySetExecutor(orchestrator = "native", options = {}) {
  const normalized = String(orchestrator ?? "native").trim().toLowerCase();
  if (normalized === "native") return executeNativeReadySet;
  if (normalized === "langgraph") return createLangGraphReadySetExecutor(options.langgraph);
  throw adapterError(
    "ready_set_orchestrator_unsupported",
    `Unsupported stage-runner orchestrator: ${orchestrator}. Expected native or langgraph.`,
  );
}

export function validateReadySetAdapterResult(result, {
  runId,
  graphDigest,
  readyNodes,
  batchIndex = 0,
} = {}) {
  const nodeIds = exactNodeIds(readyNodes);
  const expectedDigest = readySetDigest({ runId, graphDigest, batchIndex, nodeIds });
  if (!result || typeof result !== "object") {
    throw adapterError("adapter_result_invalid", "Ready-set adapter result must be an object");
  }
  const exactFields = [
    ["schemaVersion", ADAPTER_SCHEMA],
    ["authorityPacketRef", AUTHORITY_PACKET_REF],
    ["runId", runId],
    ["graphDigest", graphDigest],
    ["batchIndex", batchIndex],
    ["readySetDigest", expectedDigest],
    ["executionState", "settled"],
  ];
  for (const [field, expected] of exactFields) {
    if (result[field] !== expected) {
      throw adapterError("adapter_result_binding_mismatch", `${field} does not match the selected ready set`);
    }
  }
  if (result.topologyAuthorityConsumed !== false || result.checkpointAuthority !== "p118_durable_run_kernel_only") {
    throw adapterError("adapter_authority_violation", "Adapter attempted to claim graph or checkpoint authority");
  }
  if (JSON.stringify(result.selectedNodeIds) !== JSON.stringify(nodeIds)) {
    throw adapterError("adapter_ready_set_mismatch", "Adapter selected nodes do not exactly match scheduler output");
  }
  if (!Array.isArray(result.callbackExecutionEvidence) || result.callbackExecutionEvidence.length !== nodeIds.length) {
    throw adapterError("adapter_callback_evidence_invalid", "Adapter callback evidence is incomplete");
  }
  for (let index = 0; index < nodeIds.length; index += 1) {
    const evidence = result.callbackExecutionEvidence[index];
    if (evidence?.nodeId !== nodeIds[index] || evidence?.invocationCount !== 1 || evidence?.settled !== true) {
      throw adapterError("adapter_callback_evidence_invalid", `Adapter callback evidence failed for ${nodeIds[index]}`);
    }
  }
  if (!Array.isArray(result.results) || result.results.length !== nodeIds.length) {
    throw adapterError("adapter_result_coverage_invalid", "Adapter results do not cover the exact ready set");
  }
  for (let index = 0; index < nodeIds.length; index += 1) {
    const settlement = result.results[index];
    if (settlement?.nodeId !== nodeIds[index] || !["fulfilled", "rejected"].includes(settlement?.status)) {
      throw adapterError("adapter_result_identity_invalid", `Adapter result identity failed for ${nodeIds[index]}`);
    }
    if (settlement.status === "fulfilled" && settlement.value?.nodeId !== nodeIds[index]) {
      throw adapterError("adapter_result_identity_invalid", `Callback result nodeId failed for ${nodeIds[index]}`);
    }
  }
  assertJsonSerializable(result, "ready-set adapter result");
  return result;
}

export function readySetSettlementsToNodeResults(result) {
  return result.results.map((settlement) => settlement.status === "fulfilled"
    ? settlement.value
    : {
        nodeId: settlement.nodeId,
        status: "failed",
        failureClass: settlement.error?.code ?? "ready_set_node_rejected",
        failureMessage: settlement.error?.message ?? "Ready-set node callback rejected",
      });
}

export const READY_SET_ADAPTER_PROFILES = Object.freeze({
  native: { status: "verified", defaultDependency: true },
  langgraph: { status: "optional_runtime_adapter", defaultDependency: false },
  openai_agents: { status: "deferred_not_implemented_no_credentials", defaultDependency: false },
  claude_agent: { status: "deferred_not_implemented_no_credentials", defaultDependency: false },
});
