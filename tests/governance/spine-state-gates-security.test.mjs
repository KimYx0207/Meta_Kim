import assert from "node:assert/strict";
import test from "node:test";

import * as gateModule from "../../canonical/runtime-assets/shared/hooks/spine-state-gates.mjs";
import {
  CHOICE_SURFACE_STATES,
  createInitialState,
  recordDispatch,
  STAGE_META_AGENT_MAP,
  STAGE_ORDER,
  checkStageRequirements,
} from "../../canonical/runtime-assets/shared/hooks/spine-state.mjs";

test("exported gate policy constants are deeply immutable", () => {
  const stageOrder = [...STAGE_ORDER];
  const choiceStates = [...CHOICE_SURFACE_STATES];
  const inspectionCommands = [
    ...STAGE_META_AGENT_MAP.critical.readOnlyInspectionCommands,
  ];
  const gateBefore = checkStageRequirements({
    currentStage: "execution",
    dispatchedAgents: [],
    dispatchChain: {},
  });

  assert.throws(() => STAGE_ORDER.push("attacker-stage"), TypeError);
  assert.throws(() => {
    CHOICE_SURFACE_STATES[0] = "completed";
  }, TypeError);
  assert.throws(() => {
    STAGE_META_AGENT_MAP.execution.requiresAgentDispatch = false;
  }, TypeError);
  assert.throws(
    () => STAGE_META_AGENT_MAP.critical.readOnlyInspectionCommands.push("malicious"),
    TypeError,
  );

  assert.deepEqual(STAGE_ORDER, stageOrder);
  assert.deepEqual(CHOICE_SURFACE_STATES, choiceStates);
  assert.deepEqual(
    STAGE_META_AGENT_MAP.critical.readOnlyInspectionCommands,
    inspectionCommands,
  );
  assert.deepEqual(
    checkStageRequirements({
      currentStage: "execution",
      dispatchedAgents: [],
      dispatchChain: {},
    }),
    gateBefore,
  );
});

test("private meta-agent policy cannot be mutated into a forged recordDispatch owner", () => {
  assert.equal(Object.hasOwn(gateModule, "META_AGENT_NAMES"), false);

  const state = {
    ...createInitialState({
      taskClassification: "security_regression",
      triggerReason: "test",
    }),
    currentStage: "execution",
  };
  const next = recordDispatch(state, "runtime-worker", "meta-attacker", {
    task_name: "unbound-worker",
  });

  assert.deepEqual(next.dispatchChain.execution ?? [], []);
  assert.deepEqual(next.dispatchChain.execution_supplementary, ["unbound-worker"]);
});
