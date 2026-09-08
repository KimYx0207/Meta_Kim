import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  attestPlanningContinuity,
  checkpointPlanningContinuity,
  initializePlanningContinuity,
  inspectPlanningContinuity,
  planningWorkClosed,
} from "../../canonical/runtime-assets/shared/hooks/planning-continuity.mjs";

const hookPath = path.resolve(import.meta.dirname, "../../canonical/runtime-assets/shared/hooks/planning-continuity.mjs");

test("a completed task reopens with full Hook context and then returns to a bounded pointer", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-kim-planning-reopen-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".git"));
  const spineRoot = path.join(root, ".meta-kim/state/default/spine");
  await mkdir(spineRoot, { recursive: true });
  await writeFile(path.join(spineRoot, "spine-state.json"), JSON.stringify({ active: true, stage: "execution" }));
  const planPath = path.join(root, "task_plan.md");
  const openPlan = "# Task plan\n\n- [ ] reopen this bounded task\n";
  await writeFile(planPath, openPlan);
  await writeFile(path.join(root, "findings.md"), "# Findings\n");
  await writeFile(path.join(root, "progress.md"), "# Progress\n");
  const sessionId = "reopened-plan-session";
  const input = { payload: {}, options: { projectRoot: root, runtime: "claude", runId: sessionId } };
  await initializePlanningContinuity(input);
  await attestPlanningContinuity({ ...input, options: { ...input.options, ownerReview: true } });
  const event = (name) => {
    const result = spawnSync(process.execPath, [hookPath, "--event", name, "--runtime", "claude"], {
      cwd: root, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      input: JSON.stringify({ session_id: sessionId, cwd: root }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.additionalContext : "";
  };
  assert.match(event("user-prompt"), /FILE task_plan\.md/u);
  await writeFile(planPath, openPlan.replace("[ ]", "[x]"));
  await checkpointPlanningContinuity(input);
  const closed = await inspectPlanningContinuity(input);
  assert.equal(closed.status, "healthy");
  assert.equal(planningWorkClosed(closed.completion), true);
  for (const name of ["user-prompt", "session-start", "pre-compact"]) assert.equal(event(name), "", name);

  // Reopen the task itself, leaving progress.md unchanged.
  await writeFile(planPath, openPlan);
  await checkpointPlanningContinuity(input);
  const reopened = await inspectPlanningContinuity(input);
  assert.equal(reopened.status, "healthy");
  assert.equal(planningWorkClosed(reopened.completion), false);
  const restored = event("user-prompt");
  assert.match(restored, /FILE task_plan\.md/u);
  assert.match(restored, /\[ \] reopen this bounded task/u);
  const repeated = event("user-prompt");
  assert.match(repeated, /Planning unchanged since digest/u);
  assert.doesNotMatch(repeated, /FILE task_plan\.md/u);
  assert.match(event("session-start"), /FILE task_plan\.md/u);
  assert.match(event("pre-compact"), /FILE task_plan\.md/u);
  t.diagnostic("open=full; closed prompt/start/compact=empty; reopened task=full; repeat=pointer; recovery start/compact=full");
});
