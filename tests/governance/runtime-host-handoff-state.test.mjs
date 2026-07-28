import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { resolveCurrentHostHandoff } from "../../scripts/current-host-execution-authority.mjs";

test("P-130 runner exposes handoff state without minting execution authority", () => {
  assert.deepEqual(
    resolveCurrentHostHandoff({ routeCompatible: true }),
    {
      handoffStatus: "ready_for_host_handoff",
      hostAction: "host_action_required",
      executionAuthorized: false,
      blockedReasons: [],
    },
  );
  assert.equal(
    resolveCurrentHostHandoff({
      routeCompatible: true,
      choiceRequired: true,
      callback: () => true,
      environment: "completed",
      json: { answer: "path-a" },
    }).handoffStatus,
    "awaiting_native_choice",
  );
  assert.equal(
    resolveCurrentHostHandoff({ routeCompatible: false, blockedReasons: ["unsupported"] }).handoffStatus,
    "blocked",
  );

  const runner = readFileSync(
    path.join(process.cwd(), "scripts", "run-meta-theory-governed-execution.mjs"),
    "utf8",
  );
  assert.doesNotMatch(runner, /currentHostChoiceObserver|issueCurrentHostAuthorityFromObserver/u);
  assert.match(runner, /awaiting_native_choice/u);
  assert.match(runner, /host_action_required/u);
});
