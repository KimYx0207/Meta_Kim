import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStageDagPacket,
  selectMaximalSafeReadySet,
  stageDagGraphDigest,
  stageLaneNodeId,
  stageMergeNodeId,
  validateStageDagPacket,
} from "../../scripts/governed-execution/stage-dag.mjs";

function lane(laneId, overrides = {}) {
  return {
    laneId,
    laneKind: "execution_worker",
    ownerBindingRef: `owner:${laneId}`,
    capabilityBindingRef: `capability:${laneId}`,
    dependsOn: [],
    effectClass: "project_write",
    resourceScopes: [`file:${laneId}.mjs`],
    isolation: "shared_worktree_disjoint_files",
    status: "planned_not_invoked",
    ...overrides,
  };
}

test("stage DAG creates one merge node per stage and preserves stage barriers", () => {
  const packet = buildStageDagPacket({ stageOrder: ["Critical", "Fetch"] });
  assert.deepEqual(packet.stageOrder, ["Critical", "Fetch"]);
  assert.equal(packet.stageSummaries.length, 2);
  assert.ok(packet.nodes.some((node) => node.nodeId === stageMergeNodeId("Critical")));
  assert.ok(packet.nodes.some((node) => node.nodeId === stageMergeNodeId("Fetch")));
  for (const node of packet.nodes) {
    for (const field of [
      "nodeId",
      "stage",
      "laneKind",
      "ownerBindingRef",
      "capabilityBindingRef",
      "dependsOn",
      "effectClass",
      "resourceScopes",
      "isolation",
      "mergeNodeId",
      "status",
    ]) {
      assert.ok(Object.hasOwn(node, field), `${node.nodeId} missing ${field}`);
    }
  }

  const criticalControl = stageLaneNodeId("Critical", "control");
  const fetchControl = packet.stageSummaries[1].laneNodeIds[0];
  assert.deepEqual(
    selectMaximalSafeReadySet(packet, { capacity: 4 }).readyNodeIds,
    [criticalControl],
  );
  assert.deepEqual(
    selectMaximalSafeReadySet(packet, {
      completedNodeIds: [criticalControl],
      capacity: 4,
    }).readyNodeIds,
    [stageMergeNodeId("Critical")],
  );
  assert.deepEqual(
    selectMaximalSafeReadySet(packet, {
      completedNodeIds: [criticalControl, stageMergeNodeId("Critical")],
      capacity: 4,
    }).readyNodeIds,
    [fetchControl],
  );
});

test("independent disjoint lanes run together up to host capacity", () => {
  const packet = buildStageDagPacket({
    stageOrder: ["Execution"],
    stageLanes: { Execution: [lane("a"), lane("b"), lane("c")] },
    runtimeCapacity: 3,
  });
  const ready = selectMaximalSafeReadySet(packet, { stage: "Execution", capacity: 3 });
  assert.deepEqual(ready.readyNodeIds, [
    stageLaneNodeId("Execution", "a"),
    stageLaneNodeId("Execution", "b"),
    stageLaneNodeId("Execution", "c"),
  ]);
});

test("dependency edges serialize otherwise independent lanes", () => {
  const aId = stageLaneNodeId("Execution", "a");
  const packet = buildStageDagPacket({
    stageOrder: ["Execution"],
    stageLanes: { Execution: [lane("a"), lane("b", { dependsOn: [aId] })] },
  });
  assert.deepEqual(
    selectMaximalSafeReadySet(packet, { stage: "Execution", capacity: 2 }).readyNodeIds,
    [aId],
  );
  assert.deepEqual(
    selectMaximalSafeReadySet(packet, {
      stage: "Execution",
      completedNodeIds: [aId],
      capacity: 2,
    }).readyNodeIds,
    [stageLaneNodeId("Execution", "b")],
  );
});

test("same resource mutations do not run concurrently", () => {
  const packet = buildStageDagPacket({
    stageOrder: ["Execution"],
    stageLanes: {
      Execution: [
        lane("a", { resourceScopes: ["file:shared.mjs"] }),
        lane("b", { resourceScopes: ["file:shared.mjs"] }),
      ],
    },
  });
  const ready = selectMaximalSafeReadySet(packet, { stage: "Execution", capacity: 2 });
  assert.equal(ready.readyNodeIds.length, 1);
  assert.equal(ready.deferredNodeIds.length, 1);
});

test("Windows file scopes normalize case and separators and preserve parent-child exclusion", () => {
  const packet = buildStageDagPacket({
    stageOrder: ["Execution"],
    stageLanes: {
      Execution: [
        lane("parent", { resourceScopes: ["path:C:\\Repo\\SRC"] }),
        lane("child", { resourceScopes: ["file:c:/repo/src/components/App.mjs"] }),
      ],
    },
  });
  const ready = selectMaximalSafeReadySet(packet, { stage: "Execution", capacity: 2 });
  assert.deepEqual(ready.readyNodeIds, [stageLaneNodeId("Execution", "parent")]);
  assert.deepEqual(ready.deferredNodeIds, [stageLaneNodeId("Execution", "child")]);
});

test("ready-set maximizes cardinality instead of accepting a greedy blocking lane", () => {
  const packet = buildStageDagPacket({
    stageOrder: ["Execution"],
    stageLanes: {
      Execution: [
        lane("a", { resourceScopes: ["artifact:x", "artifact:y"] }),
        lane("b", { resourceScopes: ["artifact:x"] }),
        lane("c", { resourceScopes: ["artifact:y"] }),
      ],
    },
  });
  const ready = selectMaximalSafeReadySet(packet, { stage: "Execution", capacity: 2 });
  assert.deepEqual(ready.readyNodeIds, [
    stageLaneNodeId("Execution", "b"),
    stageLaneNodeId("Execution", "c"),
  ]);
  assert.deepEqual(ready.deferredNodeIds, [stageLaneNodeId("Execution", "a")]);
});

test("unknown mutation scope is exclusive and never parallelized", () => {
  const packet = buildStageDagPacket({
    stageOrder: ["Execution"],
    stageLanes: {
      Execution: [
        lane("unknown-a", { resourceScopes: [] }),
        lane("unknown-b", { resourceScopes: [] }),
      ],
    },
  });
  const ready = selectMaximalSafeReadySet(packet, { stage: "Execution", capacity: 8 });
  assert.equal(ready.readyNodeIds.length, 1);
  assert.equal(ready.deferredNodeIds.length, 1);
});

test("runtime capacity bounds the maximal safe ready set", () => {
  const packet = buildStageDagPacket({
    stageOrder: ["Execution"],
    stageLanes: { Execution: [lane("a"), lane("b"), lane("c")] },
    runtimeCapacity: 2,
  });
  const ready = selectMaximalSafeReadySet(packet, { stage: "Execution" });
  assert.equal(ready.readyNodeIds.length, 2);
  assert.equal(ready.deferredNodeIds.length, 1);
});

test("eligibleNodeIds restricts candidates without changing null behavior or manufacturing readiness", () => {
  const aId = stageLaneNodeId("Execution", "a");
  const bId = stageLaneNodeId("Execution", "b");
  const cId = stageLaneNodeId("Execution", "c");
  const packet = buildStageDagPacket({
    stageOrder: ["Execution"],
    stageLanes: {
      Execution: [
        lane("a"),
        lane("b", { dependsOn: [aId] }),
        lane("c"),
      ],
    },
  });

  assert.deepEqual(
    selectMaximalSafeReadySet(packet, { stage: "Execution", capacity: 3 }),
    selectMaximalSafeReadySet(packet, {
      stage: "Execution",
      capacity: 3,
      eligibleNodeIds: null,
    }),
  );
  assert.deepEqual(
    selectMaximalSafeReadySet(packet, {
      stage: "Execution",
      capacity: 3,
      eligibleNodeIds: [bId, cId],
    }).readyNodeIds,
    [cId],
    "an eligible dependent must stay blocked until its real DAG dependency is completed",
  );
  assert.deepEqual(
    selectMaximalSafeReadySet(packet, {
      stage: "Execution",
      capacity: 3,
      eligibleNodeIds: [aId, cId],
    }).candidateNodeIds,
    [aId, cId],
  );
});

test("eligibleNodeIds rejects unknown, duplicate, empty, sparse, and malformed inputs", () => {
  const packet = buildStageDagPacket({
    stageOrder: ["Execution"],
    stageLanes: { Execution: [lane("a"), lane("b")] },
  });
  const aId = stageLaneNodeId("Execution", "a");
  const sparse = [aId];
  sparse.length = 2;

  for (const [eligibleNodeIds, expected] of [
    [[], /eligibleNodeIds must be a non-empty array/iu],
    [[aId, aId], /eligibleNodeIds must contain unique node ids/iu],
    [["unknown-node"], /eligibleNodeIds contains unknown node id: unknown-node/iu],
    [[""], /eligibleNodeIds must contain non-empty strings/iu],
    [[42], /eligibleNodeIds must contain non-empty strings/iu],
    [sparse, /eligibleNodeIds must be dense/iu],
  ]) {
    assert.throws(
      () => selectMaximalSafeReadySet(packet, { eligibleNodeIds }),
      expected,
    );
  }
  assert.throws(
    () => selectMaximalSafeReadySet(packet, { eligibleNodeIds: "not-an-array" }),
    /eligibleNodeIds must be a non-empty array/iu,
  );
});

test("eligibleNodeIds preserves conflict, capacity, maximal-cardinality, and deterministic ordering", () => {
  const packet = buildStageDagPacket({
    stageOrder: ["Execution"],
    stageLanes: {
      Execution: [
        lane("a", { resourceScopes: ["artifact:x", "artifact:y"] }),
        lane("b", { resourceScopes: ["artifact:x"] }),
        lane("c", { resourceScopes: ["artifact:y"] }),
        lane("d", { resourceScopes: ["artifact:z"] }),
      ],
    },
  });
  const eligibleNodeIds = [
    stageLaneNodeId("Execution", "d"),
    stageLaneNodeId("Execution", "c"),
    stageLaneNodeId("Execution", "b"),
    stageLaneNodeId("Execution", "a"),
  ];
  const expected = [
    stageLaneNodeId("Execution", "b"),
    stageLaneNodeId("Execution", "c"),
    stageLaneNodeId("Execution", "d"),
  ];

  for (let iteration = 0; iteration < 10; iteration += 1) {
    const ready = selectMaximalSafeReadySet(packet, {
      stage: "Execution",
      capacity: 3,
      eligibleNodeIds,
    });
    assert.deepEqual(ready.readyNodeIds, expected);
    assert.equal(ready.readyNodeIds.length, 3);
    assert.ok(!ready.readyNodeIds.includes(stageLaneNodeId("Execution", "a")));
  }

  assert.deepEqual(
    selectMaximalSafeReadySet(packet, {
      stage: "Execution",
      capacity: 2,
      eligibleNodeIds: eligibleNodeIds.filter((nodeId) =>
        nodeId !== stageLaneNodeId("Execution", "a")
      ),
    }).readyNodeIds,
    [stageLaneNodeId("Execution", "b"), stageLaneNodeId("Execution", "c")],
  );
});

test("eligibleNodeIds property: every selected and deferred node is a real eligible ready candidate", () => {
  const packet = buildStageDagPacket({
    stageOrder: ["Execution"],
    stageLanes: {
      Execution: [lane("a"), lane("b"), lane("c"), lane("d")],
    },
  });
  const nodeIds = packet.nodes
    .filter((node) => node.laneKind === "execution_worker")
    .map((node) => node.nodeId);

  for (let mask = 1; mask < (1 << nodeIds.length); mask += 1) {
    const eligibleNodeIds = nodeIds.filter((_, index) => (mask & (1 << index)) !== 0);
    for (const capacity of [1, 2, 8]) {
      const result = selectMaximalSafeReadySet(packet, {
        stage: "Execution",
        capacity,
        eligibleNodeIds: [...eligibleNodeIds].reverse(),
      });
      assert.deepEqual(result.candidateNodeIds, eligibleNodeIds);
      assert.ok(result.readyNodeIds.every((nodeId) => eligibleNodeIds.includes(nodeId)));
      assert.ok(result.deferredNodeIds.every((nodeId) => eligibleNodeIds.includes(nodeId)));
      assert.equal(
        new Set([...result.readyNodeIds, ...result.deferredNodeIds]).size,
        eligibleNodeIds.length,
      );
      assert.ok(result.readyNodeIds.length <= capacity);
    }
  }
});

test("canonical graph digest ignores runtime projections but binds graph semantics", () => {
  const packet = buildStageDagPacket({
    stageOrder: ["Execution"],
    stageLanes: { Execution: [lane("a"), lane("b")] },
    runtimeCapacity: 2,
  });
  const runtimeProjection = structuredClone(packet);
  runtimeProjection.status = "executed";
  runtimeProjection.runtimeCapacity = 99;
  runtimeProjection.nodes[0].status = "completed";
  runtimeProjection.nodes[0].observedDurationMs = 42;
  runtimeProjection.invocationTruth = {
    plannedIsInvoked: true,
    evidenceRef: "runtime-only",
  };
  assert.equal(stageDagGraphDigest(runtimeProjection), packet.graphDigest);

  const graphMutation = structuredClone(packet);
  graphMutation.nodes[1].dependsOn = [graphMutation.nodes[0].nodeId];
  assert.notEqual(stageDagGraphDigest(graphMutation), packet.graphDigest);
  assert.throws(() => validateStageDagPacket(graphMutation), /graph digest mismatch/iu);
});

test("build rejects stage slug collisions", () => {
  assert.throws(
    () => buildStageDagPacket({ stageOrder: ["Meta Review", "Meta-Review"] }),
    /stage slug collision.*meta-review/iu,
  );
});

test("build rejects duplicate node ids across the full graph", () => {
  assert.throws(
    () => buildStageDagPacket({
      stageOrder: ["Critical", "Fetch"],
      stageLanes: {
        Critical: [lane("critical", { nodeId: "shared-node" })],
        Fetch: [lane("fetch", { nodeId: "shared-node" })],
      },
    }),
    /duplicate stage DAG node ids.*shared-node/iu,
  );
});

test("build rejects a lane colliding with its stage merge node", () => {
  assert.throws(
    () => buildStageDagPacket({
      stageOrder: ["Execution"],
      stageLanes: {
        Execution: [lane("worker", { nodeId: stageMergeNodeId("Execution") })],
      },
    }),
    /duplicate stage DAG node ids.*stage:execution:merge/iu,
  );
});

test("build rejects self dependencies, missing dependencies, and cycles", () => {
  const selfId = stageLaneNodeId("Execution", "self");
  assert.throws(
    () => buildStageDagPacket({
      stageOrder: ["Execution"],
      stageLanes: { Execution: [lane("self", { dependsOn: [selfId] })] },
    }),
    /self dependency.*stage:execution:lane:self/iu,
  );
  assert.throws(
    () => buildStageDagPacket({
      stageOrder: ["Execution"],
      stageLanes: { Execution: [lane("missing", { dependsOn: ["unknown-node"] })] },
    }),
    /missing dependencies.*unknown-node/iu,
  );

  const leftId = stageLaneNodeId("Execution", "left");
  const rightId = stageLaneNodeId("Execution", "right");
  assert.throws(
    () => buildStageDagPacket({
      stageOrder: ["Execution"],
      stageLanes: {
        Execution: [
          lane("left", { dependsOn: [rightId] }),
          lane("right", { dependsOn: [leftId] }),
        ],
      },
    }),
    /cycle.*stage:execution:lane:/iu,
  );
});

test("import validation and scheduler reject corrupted external DAG packets", () => {
  const packet = buildStageDagPacket({
    stageOrder: ["Execution"],
    stageLanes: { Execution: [lane("left"), lane("right")] },
  });
  const duplicate = structuredClone(packet);
  duplicate.nodes[1].nodeId = duplicate.nodes[0].nodeId;
  assert.throws(() => validateStageDagPacket(duplicate), /duplicate stage DAG node ids/iu);
  assert.throws(
    () => selectMaximalSafeReadySet(duplicate, { stage: "Execution" }),
    /duplicate stage DAG node ids/iu,
  );

  const cycle = structuredClone(packet);
  const workers = cycle.nodes.filter((node) => node.laneKind === "execution_worker");
  workers[0].dependsOn = [workers[1].nodeId];
  workers[1].dependsOn = [workers[0].nodeId];
  assert.throws(() => validateStageDagPacket(cycle), /cycle/iu);
});
