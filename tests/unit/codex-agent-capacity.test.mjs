import test from "node:test";
import assert from "node:assert/strict";
import { parseAgentsMaxThreadsFromToml } from "../../scripts/run-meta-theory-governed-execution.mjs";

test("Codex capacity reads both current and legacy keys without a client installation", () => {
  for (const key of ["max_threads", "max_concurrent_threads_per_session"]) {
    assert.equal(
      parseAgentsMaxThreadsFromToml(`[agents]\n${key} = 6 # explicit user limit\n`),
      6,
      key,
    );
  }
});

test("Codex capacity ignores absent invalid and other-table values", () => {
  for (const input of [
    "",
    "[agents]\nmax_depth = 1\n",
    "[agents]\nmax_threads = 0\n",
    ' [agents]\nmax_concurrent_threads_per_session = "6"\n',
    "[agents]\nmax_depth = 1\n[agents.reviewer]\nmax_concurrent_threads_per_session = 8\n",
    "[features]\nmax_threads = 8\n",
  ]) {
    assert.equal(parseAgentsMaxThreadsFromToml(input), null, input);
  }
});

test("Codex capacity rejects duplicate alias declarations instead of choosing a winner", () => {
  for (const values of [
    "max_threads = 2\nmax_concurrent_threads_per_session = 6",
    "max_concurrent_threads_per_session = 6\nmax_threads = 2",
    "max_threads = 2\nmax_threads = 6",
  ]) {
    assert.throws(
      () => parseAgentsMaxThreadsFromToml(`[agents]\n${values}\n`),
      /Duplicate Codex agents capacity/u,
    );
  }
});
