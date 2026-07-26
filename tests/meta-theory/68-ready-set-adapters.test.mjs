import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import {
  createLangGraphReadySetExecutor,
  executeNativeReadySet,
  readySetSettlementsToNodeResults,
  resolveReadySetExecutor,
  validateReadySetAdapterResult,
} from "../../scripts/governed-execution/ready-set-adapters.mjs";

const readyNodes = [{ nodeId: "worker:a" }, { nodeId: "worker:b" }];
const context = {
  runId: "p119-test",
  graphDigest: "g".repeat(64),
  readyNodes,
  batchIndex: 0,
};
const contract = JSON.parse(readFileSync("config/contracts/stage-runner-bridge-contract.json", "utf8"));
const packageManifest = JSON.parse(readFileSync("package.json", "utf8"));

const executeNode = async (nodeId) => ({
  nodeId,
  status: "completed",
  outputSha256: nodeId === "worker:a" ? "a".repeat(64) : "b".repeat(64),
});

function fakeFunctionalRuntime({ mutateInput = null, reenter = false } = {}) {
  return {
    task: (_name, callback) => async (input) => callback(input),
    entrypoint: (_options, callback) => ({
      invoke: async (input) => {
        const value = await callback(mutateInput ? mutateInput(input) : input);
        if (reenter) await callback(input);
        return value;
      },
    }),
  };
}

describe("68 — governed ready-set adapters", () => {
  test("P-119 contract keeps LangGraph optional and names the packed acceptance", () => {
    assert.equal(contract.readySetAdapterExtension.defaultOrchestrator, "native");
    assert.match(contract.readySetAdapterExtension.langGraphApi, /Functional API/iu);
    assert.match(contract.readySetAdapterExtension.checkpointBoundary, /P-118/iu);
    assert.equal(packageManifest.dependencies?.["@langchain/langgraph"], undefined);
    assert.equal(packageManifest.optionalDependencies?.["@langchain/langgraph"], undefined);
    assert.match(packageManifest.scripts["meta:ready-set-adapter:acceptance"], /run-ready-set-adapter-acceptance/u);
  });
  test("native executor preserves the exact scheduler-selected set", async () => {
    const result = await executeNativeReadySet({ ...context, executeNode });
    validateReadySetAdapterResult(result, context);
    assert.deepEqual(
      readySetSettlementsToNodeResults(result).map((entry) => entry.nodeId),
      ["worker:a", "worker:b"],
    );
    assert.equal(result.checkpointAuthority, "p118_durable_run_kernel_only");
  });

  test("LangGraph Functional API executor uses tasks without graph/checkpointer authority", async () => {
    const executor = createLangGraphReadySetExecutor({
      loadRuntime: async () => fakeFunctionalRuntime(),
    });
    const result = await executor({ ...context, executeNode });
    validateReadySetAdapterResult(result, context);
    assert.equal(result.adapterId, "langgraph_functional_ready_set");
    assert.equal(result.optionalDependency.persistenceEnabled, false);
  });

  test("missing and incompatible optional dependencies fail explicitly", async () => {
    const missing = createLangGraphReadySetExecutor({
      loadRuntime: async () => {
        const error = new Error("missing");
        error.code = "ERR_MODULE_NOT_FOUND";
        throw error;
      },
    });
    await assert.rejects(missing({ ...context, executeNode }), { code: "optional_dependency_missing" });
    const incompatible = createLangGraphReadySetExecutor({ loadRuntime: async () => ({}) });
    await assert.rejects(incompatible({ ...context, executeNode }), {
      code: "adapter_dependency_incompatible",
    });
  });

  test("orchestrator resolution keeps native as default and rejects unknown adapters", () => {
    assert.equal(resolveReadySetExecutor(), executeNativeReadySet);
    assert.equal(typeof resolveReadySetExecutor("langgraph", {
      langgraph: { loadRuntime: async () => fakeFunctionalRuntime() },
    }), "function");
    assert.throws(() => resolveReadySetExecutor("stategraph"), {
      code: "ready_set_orchestrator_unsupported",
    });
  });

  test("wrapper re-entry and ready-set mutation fail closed", async () => {
    const reentered = createLangGraphReadySetExecutor({
      loadRuntime: async () => fakeFunctionalRuntime({ reenter: true }),
    });
    await assert.rejects(reentered({ ...context, executeNode }), {
      code: "adapter_wrapper_reentered",
    });
    const mutated = createLangGraphReadySetExecutor({
      loadRuntime: async () => fakeFunctionalRuntime({
        mutateInput: () => ({ nodeIds: ["worker:a", "worker:extra"] }),
      }),
    });
    await assert.rejects(mutated({ ...context, executeNode }), {
      code: "adapter_ready_set_changed",
    });
  });

  test("validator rejects identity, authority, duplicate, omission, and unsettled tampering", async () => {
    const valid = await executeNativeReadySet({ ...context, executeNode });
    for (const mutate of [
      (value) => ({ ...value, runId: "other" }),
      (value) => ({ ...value, graphDigest: "x".repeat(64) }),
      (value) => ({ ...value, topologyAuthorityConsumed: true }),
      (value) => ({ ...value, selectedNodeIds: ["worker:a", "worker:a"] }),
      (value) => ({ ...value, callbackExecutionEvidence: value.callbackExecutionEvidence.slice(0, 1) }),
      (value) => ({ ...value, executionState: "running" }),
      (value) => ({ ...value, results: value.results.slice(0, 1) }),
      (value) => ({
        ...value,
        results: [value.results[1], value.results[0]],
      }),
    ]) {
      assert.throws(() => validateReadySetAdapterResult(mutate(structuredClone(valid)), context));
    }
  });

  test("non-serializable callback output is rejected before evidence retention", async () => {
    const cyclic = {};
    cyclic.self = cyclic;
    for (const invalid of [1n, undefined, Number.NaN, () => {}, Symbol("x"), cyclic]) {
      await assert.rejects(
        executeNativeReadySet({
          ...context,
          executeNode: async (nodeId) => ({ nodeId, status: "completed", value: invalid }),
        }),
        { code: "adapter_result_not_serializable" },
      );
    }
  });
});
