import assert from "node:assert/strict";
import { readOnlyFixtureTaskFacts } from "./task-design-facts.mjs";

/** Explicit fixture-host assessment for a bounded read-only bridge test.
 * Call only for a test's declared source-observation task. This does not change
 * the production dispatcher or grant tools, side effects, or native evidence.
 * Missing/stale-fact tests must construct their negative packets directly. */
export function readOnlyWorkerPacket(packet) {
  const todayTask = packet.todayTask ?? packet.description;
  assert.equal(typeof todayTask, "string");
  assert.ok(todayTask.trim(), "A bridge fixture declares the actual subtask");
  assert.equal(Object.hasOwn(packet, "taskFacts"), false,
    "Do not silently replace supplied or deliberately missing task facts");
  return { ...packet, todayTask, taskFactsSubject: todayTask,
    taskFacts: readOnlyFixtureTaskFacts(todayTask) };
}
