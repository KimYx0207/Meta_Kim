import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildAgentTeamsWaves,
  buildFanoutSafetyPacket,
  taskIsExecutableWorker,
} from "../../scripts/governed-execution/fanout-policy.mjs";

function task(id, overrides = {}) {
  return {
    taskPacketId: id,
    roleDisplayName: id,
    parallelGroup: "repair",
    collisionPolicy: "exclusive_scope",
    workspaceIsolation: "shared_worktree_disjoint_files",
    mutationPolicy: "scoped_local_writes_only",
    scopeFiles: [`${id}.mjs`],
    dependsOn: [],
    externalWriteBoundary: false,
    ...overrides,
  };
}

test("fanout policy accepts independent disjoint lanes", () => {
  const tasks = [task("a"), task("b")];
  const safety = buildFanoutSafetyPacket(tasks);
  assert.equal(safety.safeForParallelFanout, true);
  assert.equal(safety.status, "pass");
  const waves = buildAgentTeamsWaves(tasks, {
    maxConcurrentAgents: 2,
    requestedParallelAgents: 2,
    runtimeCapacity: 4,
    capacitySource: "test",
    capacitySourceKind: "test",
  }, safety);
  assert.deepEqual(waves.map((wave) => wave.taskPacketIds), [["a", "b"]]);
});

test("fanout policy blocks collisions, cycles, and external writes", () => {
  const collision = buildFanoutSafetyPacket([
    task("a", { scopeFiles: ["same.mjs"] }),
    task("b", { scopeFiles: ["same.mjs"] }),
  ]);
  assert.equal(collision.safeForParallelFanout, false);
  assert.equal(collision.collisionConflicts.length, 1);

  const cycle = buildFanoutSafetyPacket([
    task("a", { dependsOn: ["b"] }),
    task("b", { dependsOn: ["a"] }),
  ]);
  assert.equal(cycle.dependencySafe, false);
  assert.deepEqual(new Set(cycle.cycleTaskIds), new Set(["a", "b"]));

  assert.equal(taskIsExecutableWorker(task("write", { externalWriteBoundary: true })), false);
});

test("wave planning honors dependencies and runtime capacity", () => {
  const tasks = [
    task("a"),
    task("b"),
    task("c", { dependsOn: ["a", "b"] }),
  ];
  const safety = buildFanoutSafetyPacket(tasks);
  const waves = buildAgentTeamsWaves(tasks, {
    maxConcurrentAgents: 2,
    requestedParallelAgents: 3,
    runtimeCapacity: 2,
    capacitySource: "test",
    capacitySourceKind: "test",
  }, safety);
  assert.deepEqual(waves.map((wave) => wave.taskPacketIds), [["a", "b"], ["c"]]);
});

test("governed execution defaults resolve through the active profile", async () => {
  const source = await readFile(
    new URL("../../scripts/run-meta-theory-governed-execution.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /getProfilePaths\(\{ repoPath: REPO_ROOT \}\)\.profileDir/);
  assert.doesNotMatch(source, /["']state["']\s*,\s*["']default["']\s*,\s*["']governed-executions["']/);
});

test("unknown safety and route identifiers never prove isolated file work", () => {
  for (const patch of [
    { workspaceIsolation: "unproven" }, { mutationPolicy: "unproven" }, { collisionPolicy: "unproven" },
    { safetyEvidence: { status: "unproven" } }, { scopeFiles: ["route://fixture/one"] },
    { scopeFiles: [], artifactNamespace: "unique-name" },
    { externalWriteBoundary: undefined, externalWritePolicy: "unproven" },
    { externalWriteBoundary: false, externalWritePolicy: "requested_not_parallel_safe" },
    { externalWriteBoundary: false, externalWritePolicy: "unproven" },
    { externalWriteBoundary: true, externalWritePolicy: "forbidden" },
  ]) assert.equal(buildFanoutSafetyPacket([task("a", patch), task("b")]).safeForParallelFanout, false, JSON.stringify(patch));
});

test("read-only overlap is safe, while ancestor writes need actual dependency ordering", () => {
  const shared = [task("a", { scopeFiles: ["src"], mutationPolicy: "read_only" }), task("b", { scopeFiles: ["src/Client.ts"], mutationPolicy: "read_only" })];
  assert.equal(buildFanoutSafetyPacket(shared).safeForParallelFanout, true);
  const writes = shared.map((packet) => ({ ...packet, mutationPolicy: "scoped_local_writes_only" }));
  assert.equal(buildFanoutSafetyPacket(writes).safeForParallelFanout, false);
  writes[1].dependsOn = ["a"];
  assert.equal(buildFanoutSafetyPacket(writes).safeForParallelFanout, true);
});

test("explicit isolated artifact work remains supported", () => {
  const tasks = ["a", "b"].map((id) => task(id, { scopeFiles: [], workspaceIsolation: "run_scoped", mutationPolicy: "artifacts_only", artifactNamespace: id }));
  assert.equal(buildFanoutSafetyPacket(tasks).safeForParallelFanout, true);
});

test("lexical path aliases cannot establish independent mutation shards", () => {
  for (const alias of ["src/unused/../A.ts", "src//A.ts", "./src/A.ts", "src\\A.ts", "SRC/a.ts"]) {
    const left = task("a", { scopeFiles: ["src/A.ts"] });
    const right = task("b", { scopeFiles: [alias] });
    assert.equal(buildFanoutSafetyPacket([left, right]).safeForParallelFanout, false, alias);
    assert.equal(right.scopeFiles[0], alias, "Comparison must not rewrite the original task scope");
    right.dependsOn = ["a"];
    assert.equal(buildFanoutSafetyPacket([left, right]).safeForParallelFanout, true, alias);
  }
  for (const unresolved of ["../src/A.ts", "src/../../A.ts", "C:src/A.ts", "//?/C:/src/A.ts"]) {
    assert.equal(buildFanoutSafetyPacket([task("a", { scopeFiles: [unresolved] }), task("b")]).safeForParallelFanout, false, unresolved);
  }
});

test("mixed scope roots do not prove independent writes but permit ordered or shared reads", () => {
  const rootForms = ["src/A.ts", "C:/repo/src/A.ts", "/src/A.ts", "//server/share/src/A.ts"];
  for (const [index, leftScope] of rootForms.entries()) {
    for (const rightScope of rootForms.slice(index + 1)) {
      const tasks = [task("a", { scopeFiles: [leftScope] }), task("b", { scopeFiles: [rightScope] })];
      const label = `${leftScope} vs ${rightScope}`;
      assert.equal(buildFanoutSafetyPacket(tasks).safeForParallelFanout, false, label);
      assert.deepEqual(tasks.map((packet) => packet.scopeFiles), [[leftScope], [rightScope]]);
      assert.equal(buildFanoutSafetyPacket(tasks.map((packet) => ({ ...packet, mutationPolicy: "read_only" }))).safeForParallelFanout, true, label);
      tasks[1].dependsOn = ["a"];
      const orderedSafety = buildFanoutSafetyPacket(tasks);
      assert.equal(orderedSafety.safeForParallelFanout, true, label);
      assert.deepEqual(buildAgentTeamsWaves(tasks, { maxConcurrentAgents: 2 }, orderedSafety).map((wave) => wave.taskPacketIds), [["a"], ["b"]], label);
    }
  }
  for (const root of ["src", "C:/repo/src", "/src", "//server/share/src"]) {
    assert.equal(buildFanoutSafetyPacket([task("a", { scopeFiles: [`${root}/A.ts`] }), task("b", { scopeFiles: [`${root}/B.ts`] })]).safeForParallelFanout, true, root);
  }
});
