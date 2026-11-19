import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { runDiagnosticReadPlan } from "../../scripts/diagnostic-host-protocol.mjs";
import { FIXTURE_DIAGNOSTIC_PROVIDERS, refreshFixtureSourcePins } from "../helpers/host-reasoning-fixture.mjs";
import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";

// The stage labels live in the governed-run script and reach the page through the
// run's `agUiStageEvents`, so the wording is checked on a real bounded run rather
// than on the source text.
let runtimeFixture;
let runMetaTheoryGovernedExecution;

before(async () => {
  runtimeFixture = createGovernanceRuntimeFixtureScope(null, { graph: true });
  refreshFixtureSourcePins(runtimeFixture);
  ({ runMetaTheoryGovernedExecution } = await runtimeFixture.import("scripts/run-meta-theory-governed-execution.mjs"));
});
after(() => runtimeFixture?.cleanup());

const BOUNDED_TASK = "Run meta-theory. In parallel inspect package.json; review AGENTS.md; read README.md; audit config/contracts/workflow-contract.json.";
const BOUNDED_SCOPES = ["package.json", "AGENTS.md", "README.md", "config/contracts/workflow-contract.json"];

test("review #15: the Thinking stage label names the owner in plain Chinese, with no leftover English word", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-stage-label-"));
  try {
    const report = await runDiagnosticReadPlan(runMetaTheoryGovernedExecution, {
      task: BOUNDED_TASK,
      outputLanguage: "zh-CN",
      runId: "test-run-review-15",
      stateDir: tempDir,
      dbPath: path.join(tempDir, "runs.sqlite"),
      diagnosticProviders: FIXTURE_DIAGNOSTIC_PROVIDERS,
    }, BOUNDED_SCOPES);
    const thinking = report.coreLoop.agUiStageEvents.events.find((event) => event.stage === "Thinking");
    assert.ok(thinking, "the Thinking stage event must be present");
    assert.equal(thinking.userFacingLabel["zh-CN"], "选择负责人、能力和路线");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
