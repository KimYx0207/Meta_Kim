import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createLiveWorkspaceService } from "../../src/application/live/live-workspace-service.mjs";
import { activateSpineState, createInitialState, readSpineState } from "../../canonical/runtime-assets/shared/hooks/spine-state.mjs";
import { buildGovernedHostHandoff } from "../../canonical/runtime-assets/shared/hooks/governed-host-checkpoint.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHAT = "01900000-0000-7000-8000-000000000074";
const PROFILE = "native-host-test";
const build = (state, projectRoot) => buildGovernedHostHandoff({ state, projectRoot,
  adapterPath: path.join(REPO, "canonical/runtime-assets/shared/hooks/governed-host-checkpoint.mjs"),
  skillPath: path.join(REPO, "canonical/skills/meta-theory/SKILL.md"), language: "en" });
const handoffFrom = content => JSON.parse(content.split("\n")
  .find(line => line.startsWith("Current private Live workspace handoff: "))
  .slice("Current private Live workspace handoff: ".length));
const invoke = (handoff, args) => spawnSync(process.execPath, [handoff.hostEntry, ...args], {
  encoding: "utf8", env: { ...process.env, META_KIM_PROFILE: "wrong-profile", META_KIM_STATE_PROFILE: "wrong-profile" },
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-native-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".git"));
  const state = createInitialState({ activationMode: "hook_observed", driverMode: "hook_observed", hookGateMode: "advisory",
    sourceConversation: { runtime: "claude", conversationId: CHAT, matchBasis: "transcript_file_verified" } });
  state.profile = PROFILE;
  state.recordOrigin = "acceptance_fixture";
  state.currentStage = "thinking";
  state.stages.critical.status = "completed";
  state.stages.fetch.status = "completed";
  state.stages.thinking.status = "in_progress";
  await activateSpineState(root, state);
  const service = createLiveWorkspaceService({ projectRoot: root, profile: PROFILE });
  await service.publishDesign({ runId: state.runId, conversationId: CHAT, expectedRevision: 0,
    input: { schemaVersion: 1, design: { mode: "exploration", userJourneys: [], interfaces: [], sharedState: [], taskSlices: [],
      softwareDesign: { schemaVersion: 1, architecture: { id: "single-host", revision: 1, summary: "Continue in the installed host",
        decisionRefs: [], technologyChoices: [], constraints: [], moduleIds: ["worker"] },
      modules: [{ id: "worker", purpose: "Produce the scoped artifact" }] } } } });
  const current = () => readSpineState(root, { profile: PROFILE });
  const statePath = path.join(root, ".meta-kim/state", PROFILE, "spine/spine-state.json");
  return { root, state, service, current, statePath };
}

test("a Claude-only handoff reads fresh work through the real CLI without claiming or requiring Codex", async t => {
  const f = await fixture(t);
  const original = await f.current();
  const handoff = handoffFrom(build(original, f.root));
  assert.equal(handoff.status, "read_only_handoff");
  assert.equal(handoff.snapshotOnly, true);
  assert.deepEqual(handoff.nextWorkArguments, ["--project-root", f.root, "--profile", PROFILE,
    "--run-id", f.state.runId, "--conversation-id", CHAT, "--next-work"]);
  assert.equal(handoff.arguments.at(-1), "--inspect", "existing inspection callers remain compatible");
  const before = await readFile(f.statePath, "utf8");
  const waiting = invoke(handoff, handoff.nextWorkArguments);
  assert.equal(waiting.status, 0, waiting.stderr);
  const pending = JSON.parse(waiting.stdout);
  assert.equal(pending.status, "waiting_human");
  assert.equal(pending.continuation.mayContinue, false);
  assert.equal(await readFile(f.statePath, "utf8"), before, "next-work cannot claim, write or consume approval");

  const overview = await f.service.getOverview({ runId: f.state.runId });
  const review = overview.reviews.find(item => item.kind === "outline");
  await f.service.review({ runId: f.state.runId, decisionId: review.decisionId, expectedRevision: review.revision,
    expectedWorkspaceRevision: overview.revision, artifactId: review.artifactId, version: review.version,
    choice: "accept", nonce: "native-host-outline-accepted" });
  const acceptedBytes = await readFile(f.statePath, "utf8");
  const fresh = invoke(handoff, handoff.nextWorkArguments);
  assert.equal(fresh.status, 0, fresh.stderr);
  const ready = JSON.parse(fresh.stdout);
  assert.equal(ready.status, "ready");
  assert.equal(ready.continuation.mayContinue, true);
  assert.ok(Array.isArray(ready.claimArguments));
  assert.equal(ready.claimArguments[ready.claimArguments.indexOf("--conversation-id") + 1], CHAT);
  assert.equal(await readFile(f.statePath, "utf8"), acceptedBytes, "reusing the bound read argv reads new state without replaying a claim");

  const claimed = invoke(handoff, ready.claimArguments);
  assert.equal(claimed.status, 0, claimed.stderr);
  assert.equal(JSON.parse(claimed.stdout).status, "host_claimed");
  const claimedBytes = await readFile(f.statePath, "utf8");
  const duplicate = invoke(handoff, ready.claimArguments);
  assert.notEqual(duplicate.status, 0, "the read-only handoff cannot weaken the claim's existing CAS");
  assert.equal(await readFile(f.statePath, "utf8"), claimedBytes);
  const noSecondWorker = invoke(handoff, handoff.nextWorkArguments);
  assert.equal(noSecondWorker.status, 0, noSecondWorker.stderr);
  assert.equal(JSON.parse(noSecondWorker.stdout).continuation.mayContinue, false);
});

test("an unbound profile or conversation yields no executable workspace argv", async t => {
  const f = await fixture(t);
  const state = await f.current();
  for (const [field, value, reason] of [
    ["profile", null, "workspace_profile_unbound"],
    ["conversationLinkState", "unlinked", "workspace_conversation_unverified"],
  ]) {
    const unbound = structuredClone(state);
    if (field === "profile") unbound.liveWorkspace.profile = value;
    else unbound[field] = value;
    const handoff = handoffFrom(build(unbound, f.root));
    assert.equal(handoff.status, "unavailable");
    assert.equal(handoff.reason, reason);
    assert.equal(handoff.arguments, undefined);
    assert.equal(handoff.nextWorkArguments, undefined);
  }
  assert.deepEqual(await f.current(), state);
});
