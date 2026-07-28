import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { resolveCurrentHostHandoff } from "../../scripts/current-host-execution-authority.mjs";
import { evaluateRouteExecutionGate } from "../../scripts/runtime-execution-gate.mjs";

function baselineMatrix() {
  const claim = (hostSupport = "native") => ({
    hostSupport,
    hostConfidence: "verified_docs",
    metaKimIntegration: "host_only",
    acceptanceRequirement: "required",
    acceptanceState: "not_run",
    routeEligibility: "host_handoff_eligible",
    evidenceRefs: ["fixture.host.contract"],
  });
  return {
    platforms: [{
      platform: "codex",
      capabilities: ["shell", "filesystem", "apply_patch / edit", "native choice surface"]
        .map((capability) => ({
          capability,
          claimsByMode: {
            interactive_host: capability === "native choice surface"
              ? { ...claim("unknown"), metaKimIntegration: "unknown" }
              : claim(),
          },
        })),
    }],
  };
}

test("ordinary engineering is compatible and hands off to the host without persistent acceptance", () => {
  const gate = evaluateRouteExecutionGate({
    runtime: "codex",
    taskShape: "engineering_execution",
    effectiveMatrix: baselineMatrix(),
  });

  assert.equal(gate.routeCompatible, true, gate.blockers.join("\n"));
  assert.equal(gate.handoffStatus, "ready_for_host_handoff");
  assert.equal(gate.hostAction, "host_action_required");
  assert.equal(gate.executionAuthorized, false);
  assert.equal(gate.persistentAcceptanceAuthorizesExecution, false);
});

test("choice-required routes await a real native choice and caller callback/env/JSON cannot complete it", () => {
  const arbitraryCallerInputs = {
    callback: () => "approved",
    environment: { META_KIM_NATIVE_CHOICE_EVIDENCE: "completed" },
    json: { status: "completed", answer: "path-a" },
  };
  const handoff = resolveCurrentHostHandoff({
    routeCompatible: true,
    choiceRequired: true,
    ...arbitraryCallerInputs,
  });
  assert.equal(handoff.handoffStatus, "awaiting_native_choice");
  assert.equal(handoff.hostAction, "invoke_native_choice_surface");
  assert.equal(handoff.executionAuthorized, false);

  const selector = readFileSync(path.join(process.cwd(), "scripts", "select-execution-route.mjs"), "utf8");
  assert.match(selector, /trustBoundary:\s*"reference_only_cli_or_environment"/u);
  assert.doesNotMatch(selector, /trusted:\s*answerRecorded/u);
});

test("known unsupported host capability still blocks handoff", () => {
  const effectiveMatrix = baselineMatrix();
  const claim = effectiveMatrix.platforms
    .find((entry) => entry.platform === "codex")
    .capabilities.find((entry) => entry.capability === "shell")
    .claimsByMode.interactive_host;
  claim.hostSupport = "unsupported";

  const gate = evaluateRouteExecutionGate({
    runtime: "codex",
    taskShape: "engineering_execution",
    effectiveMatrix,
  });
  assert.equal(gate.routeCompatible, false);
  assert.equal(gate.handoffStatus, "blocked");
  assert.match(gate.blockers.join("\n"), /unsupported/u);
});

test("production authority module contains no observer or in-process minting surface", () => {
  const source = readFileSync(
    path.join(process.cwd(), "scripts", "current-host-execution-authority.mjs"),
    "utf8",
  );
  assert.doesNotMatch(source, /WeakMap|issueCurrentHostAuthorityFromObserver|observeTestOnlyCurrentHostAuthority/u);
  assert.doesNotMatch(
    readFileSync(path.join(process.cwd(), "scripts", "run-meta-theory-governed-execution.mjs"), "utf8"),
    /currentHostChoiceObserver/u,
  );
});

test("Codex and Claude command adapters map the two host-native phases correctly", () => {
  const codex = readFileSync(
    path.join(process.cwd(), "canonical", "runtime-assets", "codex", "commands", "meta-theory.md"),
    "utf8",
  );
  const claude = readFileSync(
    path.join(process.cwd(), "canonical", "runtime-assets", "claude", "commands", "meta-theory.md"),
    "utf8",
  );
  assert.match(codex, /Phase 1[\s\S]*ready_for_host_handoff[\s\S]*Phase 2[\s\S]*request_user_input[\s\S]*spawn_agent/u);
  assert.match(claude, /Phase 1[\s\S]*ready_for_host_handoff[\s\S]*Phase 2[\s\S]*AskUserQuestion[\s\S]*Agent/u);
  for (const command of [codex, claude]) {
    assert.match(command, /persistent acceptance[\s\S]*advisory/iu);
    assert.match(command, /callback[\s\S]*environment[\s\S]*JSON/iu);
  }
});
