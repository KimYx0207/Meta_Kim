import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { taskOutcomeDigest } from "../../src/domain/governance/task-outcome.mjs";
import { intentDialogueDigest } from "../../scripts/governed-execution/intent-dialogue.mjs";

/** Explicit test-host judgment, never production inference or an approval receipt. */
export function fixtureCritical({ task, outcome = task, intentDigest = null, successCriteria, blockingUnknowns = [], nonGoals = [] }) {
  assert.ok(successCriteria?.length, "Each fixture must declare its own observable success criteria");
  return { taskHash: taskOutcomeDigest(task), intentDigest, realIntent: outcome, successCriteria,
    blockingUnknowns, nonGoals, evidenceRefs: ["package.json"] };
}

/** Refresh only source-byte projection pins in the disposable copied repository. */
export function refreshFixtureSourcePins(fixture) {
  const result = fixture.run(["scripts/refresh-runtime-evidence-pins.mjs"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

export function fixtureInventoryProvider(preparation, id, kind = "agents") {
  const candidates = preparation.fetchPacket.capabilityDiscovery[kind].filter(provider => provider.id === id &&
    provider.routeEligible !== false && provider.executionEligible !== false && !provider.cacheEvidenceOnly &&
    (provider.runtime === "codex" || /[\\/]\.codex[\\/]/u.test(provider.sourceRef ?? "")));
  assert.equal(candidates.length, 1, `Expected one current Codex discovery fixture for ${id}, found ${candidates.length}`);
  assert.match(candidates[0].inventoryRef, /^sha256:[a-f0-9]{64}$/u);
  return structuredClone(candidates[0]);
}

/** Exercise the real two-call protocol. Work-order semantics are explicit fixture
 * data supplied by each test; selected provider objects come from the persisted
 * Fetch inventory. This helper cannot grant native execution or user acceptance. */
export async function runWithFixtureHostThinking(run, options, { criticalInput, governanceTaskFacts, workOrders }) {
  assert.equal(typeof workOrders, "function", "The test host must supply an explicit work-order decision");
  const prepared = await run({ ...options, runId: options.runId + "-fetch", criticalInput, governanceTaskFacts,
    stageRunner: null, outcomeReviewInput: null, onConversationProgress: null });
  const preparation = JSON.parse(await readFile(prepared.paths.json, "utf8"));
  assert.equal(preparation.artifactKind, "host_preparation");
  assert.equal(preparation.preparation.status, "needs_thinking");
  assert.deepEqual(preparation.workerTaskPackets, []);
  assert.equal(preparation.coreLoop.stageDagPacket, undefined);
  assert.match(preparation.fetchPacket.capabilityDiscovery?.inventoryDigest ?? "", /^[a-f0-9]{64}$/u,
    JSON.stringify(preparation.hostInvocationRequestPacket.nextAction));
  const thinkingInput = fixtureThinkingInput(preparation, { criticalInput, workOrders });
  return run({ ...options, criticalInput, governanceTaskFacts, thinkingInput, previousPlanChallengeRunId: preparation.runId });
}

/** Build only from an actual preparation and explicit call-site work orders. */
export function fixtureThinkingInput(preparation, { criticalInput, workOrders }) {
  assert.equal(typeof workOrders, "function");
  const packets = workOrders(preparation);
  return { taskHash: criticalInput.taskHash, intentDigest: criticalInput.intentDigest,
    requirementsDigest: preparation.requirementsDiscoveryPacket?.discoveryDigest ?? null,
    evidenceRefs: ["package.json"], intentPacket: structuredClone(criticalInput), fetchPacket: preparation.fetchPacket,
    thinkingPacket: { designFrame: "Explicit test-host judgment for bounded source inspection; no native invocation or completed user outcome is claimed.",
      consideredLanes: packets.map(packet => ({ id: packet.roleInstanceId, reason: packet.selectionReason })),
      omittedLanesWithReason: [{ id: "external-delivery", reason: "This test checks local handoff and binding only; no external writes are requested." }], workerTaskPackets: packets } };
}

/** Exercise the same prepare/resume protocol through the actual public CLI.
 * This helper never intercepts fixture.run or supplies missing data implicitly. */
export function runFixtureHostCli(fixture, argv, { criticalInput, governanceTaskFacts, workOrders }, options = {}) {
  const at = (flag) => argv.indexOf(flag);
  assert.ok(at("--run-id") >= 0 && at("--task") >= 0, "Fixture calls declare their task and run identity");
  const task = argv[at("--task") + 1];
  const runId = argv[at("--run-id") + 1];
  assert.equal(criticalInput.taskHash, taskOutcomeDigest(task));
  assert.equal(governanceTaskFacts.taskHash, criticalInput.taskHash);
  const directory = path.join(fixture.root, "host-inputs", runId);
  mkdirSync(directory, { recursive: true });
  const write = (name, value) => { const file = path.join(directory, name + ".json"); writeFileSync(file, JSON.stringify(value)); return file; };
  const inputs = ["--critical-input", write("critical", criticalInput), "--governance-task-facts-input", write("facts", governanceTaskFacts)];
  const prepareArgs = [...argv];
  prepareArgs[at("--run-id") + 1] = runId + "-fetch";
  const prepared = fixture.run([...prepareArgs.filter(arg => arg !== "--emit-conversation-notice"), ...inputs, "--no-emit-conversation-notice"], options);
  assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
  const summary = JSON.parse(prepared.stdout);
  assert.equal(summary.status, "needs_thinking", JSON.stringify(summary.nextAction));
  const preparation = JSON.parse(readFileSync(summary.input, "utf8"));
  assert.deepEqual(preparation.workerTaskPackets, []);
  const thinking = fixtureThinkingInput(preparation, { criticalInput, workOrders });
  return fixture.run([...argv, ...inputs, "--thinking-input", write("thinking", thinking), "--previous-plan-challenge-run", preparation.runId], options);
}

/** Fixed read-only fixture packet. Call sites supply the specific outcome,
 * criterion IDs and task identity; this is not a general task planner. */
export function fixtureReadWorkOrder(preparation, { id, todayTask, output, criterionIds, owner = "backend", selectedProviders = {}, taskFacts }) {
  return { roleInstanceId: id, roleDisplayName: owner, todayTask, output,
    capabilityNeed: ["read package metadata"], evidenceRefs: ["package.json"], scopeFiles: ["package.json"], shardScope: ["package.json"],
    nonGoals: ["No source edits, native success claims, publication or deployment"], toolRequirements: [], dependsOn: [],
    acceptanceCriterionIds: criterionIds, verifySteps: [{ id: id + "-check", step: "Read the current package.json and compare the reported value", verify: "The value matches the current source; missing execution remains unverified" }],
    selectionReason: "The test host selected the discovered bounded backend role for package metadata inspection and a separate review owner.",
    handoffTarget: "review", qualityBar: "Source-bound report, no invented execution evidence", referenceDirection: "Use only the current fixture package.json and supplied criterion IDs.",
    selectedCapabilityProviders: { agent: fixtureInventoryProvider(preparation, owner), verificationAgent: fixtureInventoryProvider(preparation, "review"), skill: fixtureInventoryProvider(preparation, "get-context", "providers"), ...selectedProviders },
    effectClass: "read_only_worker", ...(taskFacts ? { taskFacts } : {}) };
}

/** Synthetic current-host reader port, exercising the real Desktop adapter and
 * private CAS store. This is transport/protocol evidence, never native-host E2E.
 * It writes only the disposable fixture's owned work/state directories. */
export async function observeFixturePlanChoice(fixture, preparation, questionId, optionIndex = 0) {
  const { openCodexDesktopPlanChallengeHost } = await fixture.import("scripts/codex-desktop-human-milestone.mjs");
  const context = { artifactPath: preparation.paths.json, questionId,
    exchangeRoot: path.join(fixture.repoRoot, ".meta-kim/work/fixture-choices"),
    profileRoot: path.join(fixture.repoRoot, ".meta-kim/state/fixture-choices"), hostConnectionRef: "host:synthetic-desktop-fixture" };
  const hostContext = { threadId: "fixture-thread", hostId: "fixture-host", turnId: "fixture-question-turn" };
  let readCount = 0; let presentation;
  const readThread = async () => {
    const count = readCount++;
    const question = presentation?.questions[0];
    const item = question ? { id: "call_fixture_choice", type: "agentMessage", phase: "final_answer",
      text: `${question.question}\n${question.options.map(option => `- ${option.label}`).join("\n")}` } : null;
    const reply = question ? { id: "fixture-reply", type: "userMessage", content: [{ type: "text",
      text: "<send_user_message_question_reply>" + JSON.stringify([{ questionItemId: JSON.stringify(["request_user_input_async", "call_fixture_choice", 0]),
        question: question.question, answer: question.options[optionIndex].label }]) + "</send_user_message_question_reply>" }] } : null;
    const turns = count === 0 ? [{ id: hostContext.turnId, items: [] }]
      : count === 1 ? [{ id: hostContext.turnId, items: [item] }]
        : [{ id: "fixture-reply-turn", items: [reply] }, { id: hostContext.turnId, items: [item] }];
    return { tool: "mcp__codex_app__read_thread", callRef: `fixture:reader-call-${count}`, rawRef: `fixture:reader-return-${count}`,
      arguments: { threadId: hostContext.threadId, hostId: hostContext.hostId }, observedAt: new Date(Date.now() - (count === 0 ? 1 : 0)).toISOString(),
      result: { content: [{ type: "text", text: JSON.stringify({ schemaVersion: 1, thread: { id: hostContext.threadId, hostId: hostContext.hostId },
        page: { order: "newest_first" }, turns }) }] } };
  };
  const host = await openCodexDesktopPlanChallengeHost({ ...context, projectRoot: fixture.repoRoot,
    readThread, authorize: async () => ({ status: "ready", reason: "test-owned read-only decision fixture" }) });
  presentation = host.question.presentation;
  const prepared = await host.adapter.prepare({ ...host.question, hostContext, presentation,
    activeSchema: { runtime: "codex", surface: "request_user_input", questions: { min: 1, max: 1 }, optionsPerQuestion: { min: 2, max: 3 },
      textLimits: { header: 20, question: 200, optionLabel: 80, optionDescription: 300 } }, expiresAt: new Date(Date.now() + 60000).toISOString() });
  assert.equal(prepared.mayAsk, true);
  assert.equal((await host.adapter.recordPresented(host.question)).reason, "desktop_question_pending");
  assert.equal((await host.adapter.observe(host.question)).status, "observed");
  const consumed = await host.consume();
  assert.equal(consumed.status, "consumed");
  assert.equal(consumed.executionAllowed, false);
  assert.equal(consumed.originAuthenticatedByLibrary, false);
  const priorIntent = preparation.preparation.intentSnapshot ?? { taskHash: taskOutcomeDigest(preparation.task), outcome: preparation.task,
    constraints: {}, acceptanceCriteria: [], settledDecisions: [], evidenceRefs: consumed.settledDecision.evidenceRefs };
  const confirmedIntent = { ...priorIntent, evidenceRefs: [...new Set([...priorIntent.evidenceRefs, ...consumed.settledDecision.evidenceRefs])],
    settledDecisions: [...(priorIntent.settledDecisions ?? []).filter(decision => decision.decisionId !== questionId), consumed.settledDecision] };
  return { planChallengeHostInput: context, confirmedIntent, intentDigest: intentDialogueDigest(confirmedIntent) };
}
