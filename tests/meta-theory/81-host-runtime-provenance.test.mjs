import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  HOST_INHERITED_ENV_NAMES,
  HOST_RUNTIME_ENV_MARKER_NAMES,
  HOST_RUNTIME_ENV_MARKERS,
  HOST_RUNTIME_PROVENANCE_BASIS,
  HOST_SESSION_ENV_MARKER_NAMES,
  SPINE_CONVERSATION_BINDING_BASIS,
  SPINE_CONVERSATION_BINDING_REFUSALS,
  detectHostRuntimeFromEnv,
  detectHostSessionConversationId,
  governedRunStateProfile,
  resolveGovernedRunProvenance,
  resolveSpineConversationBinding,
} from "../../scripts/governed-execution/host-runtime-provenance.mjs";
import { buildRuntimeChildEnv } from "../../scripts/governed-execution/stage-runner-bridge.mjs";

const CHAT_ID = "b5799d00-ef7a-4882-818d-d9053cacba71";
const GOVERNED_RUN_ID = "meta-run-135343de4cea-mtjp1ecs-48f3cd12";
const SPINE_RUN_ID = "meta-2026-09-01t22-56-30-432z-23825f6133907331";

function claudeHostEnv(overrides = {}) {
  return { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", ...overrides };
}

function codexHostEnv(overrides = {}) {
  return { CODEX_THREAD_ID: "01a04c60-33fe-79f3-a38a-d52fcae64d4d", ...overrides };
}

function verifiedSpineState(overrides = {}) {
  return {
    active: true,
    profile: "default",
    runId: SPINE_RUN_ID,
    sourceRuntime: "claude",
    conversationLinkState: "verified",
    sourceConversation: {
      runtime: "claude",
      conversationId: CHAT_ID,
      runId: SPINE_RUN_ID,
      matchBasis: "transcript_file_verified",
    },
    ...overrides,
  };
}

function stoppedSpineState(overrides = {}) {
  return verifiedSpineState({
    active: false,
    deactivationReason: "session_stop",
    ...overrides,
  });
}

function bindingFor(spineState, overrides = {}) {
  return resolveSpineConversationBinding({
    spineState,
    runId: GOVERNED_RUN_ID,
    runProfile: "default",
    ...overrides,
  });
}

test("a governed run started under Claude Code is recorded as claude, not as the vendor default", () => {
  const provenance = resolveGovernedRunProvenance({ env: claudeHostEnv() });

  assert.equal(provenance.sourceRuntime, "claude");
  assert.notEqual(provenance.sourceRuntime, "codex");
  assert.equal(provenance.basis, "host_env_marker");
  assert.deepEqual(provenance.observedMarkers, ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]);
});

test("a governed run started under Codex is recorded as codex", () => {
  const provenance = resolveGovernedRunProvenance({ env: codexHostEnv() });

  assert.equal(provenance.sourceRuntime, "codex");
  assert.equal(provenance.basis, "host_env_marker");
  assert.deepEqual(provenance.observedMarkers, ["CODEX_THREAD_ID"]);
});

test("an unidentifiable host is recorded as undetermined instead of guessing a vendor", () => {
  const provenance = resolveGovernedRunProvenance({ env: {} });

  assert.equal(provenance.sourceRuntime, "unavailable");
  assert.notEqual(provenance.sourceRuntime, "codex");
  assert.equal(provenance.basis, "no_host_env_marker");
  assert.deepEqual(provenance.observedMarkers, []);
});

test("markers from two hosts cannot attribute a run, because a nested launch leaks the outer host", () => {
  const provenance = resolveGovernedRunProvenance({ env: claudeHostEnv(codexHostEnv()) });

  assert.equal(provenance.sourceRuntime, "unavailable");
  assert.equal(provenance.basis, "conflicting_host_env_markers");
  assert.deepEqual(provenance.observedMarkers, [
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CODEX_THREAD_ID",
  ]);
});

test("an explicitly declared runtime outranks both the spine binding and the env markers", () => {
  const declared = resolveGovernedRunProvenance({
    declaredRuntime: "cursor",
    spineRuntime: "claude",
    env: codexHostEnv(),
  });
  assert.equal(declared.sourceRuntime, "cursor");
  assert.equal(declared.basis, "declared_runtime_flag");

  const spineOverEnv = resolveGovernedRunProvenance({
    spineRuntime: "claude",
    env: codexHostEnv(),
  });
  assert.equal(spineOverEnv.sourceRuntime, "claude");
  assert.equal(spineOverEnv.basis, "live_spine_binding");

  // An unknown name is not evidence of anything, so it must fall through to the
  // next source rather than reach a reader raw.
  const unknown = resolveGovernedRunProvenance({
    declaredRuntime: "not-a-runtime",
    env: codexHostEnv(),
  });
  assert.equal(unknown.sourceRuntime, "codex");
  assert.equal(unknown.basis, "host_env_marker");

  // `claude_code` is the route's spelling of the same host; the recorded name has
  // to be the one the read surface is allowed to print.
  assert.equal(
    resolveGovernedRunProvenance({ declaredRuntime: "claude_code", env: {} }).sourceRuntime,
    "claude",
  );
});

test("every provenance answer stays inside the declared basis vocabulary", () => {
  for (const env of [claudeHostEnv(), codexHostEnv(), {}, claudeHostEnv(codexHostEnv())]) {
    for (const declaredRuntime of [null, "claude", "not-a-runtime"]) {
      for (const spineRuntime of [null, "codex"]) {
        const provenance = resolveGovernedRunProvenance({ declaredRuntime, spineRuntime, env });
        assert.ok(
          HOST_RUNTIME_PROVENANCE_BASIS.includes(provenance.basis),
          `basis ${provenance.basis} must be part of the declared vocabulary`,
        );
      }
    }
  }
});

test("an active spine run hands its verified chat to the governed run under the run's own id", () => {
  const binding = bindingFor(verifiedSpineState());

  assert.equal(binding.linked, true);
  assert.equal(binding.refusal, null);
  assert.equal(binding.bindingBasis, "live_spine_binding");
  assert.equal(binding.sourceRuntime, "claude");
  assert.deepEqual(binding.sourceConversation, {
    runtime: "claude",
    conversationId: CHAT_ID,
    runId: GOVERNED_RUN_ID,
    matchBasis: "transcript_file_verified",
  });
  // The spine keeps the chat under the spine run id. Dropping that id would lose
  // the only trace of which activation proved the link, and keeping it in place
  // of the governed id makes the read surface treat the link as another run's.
  assert.equal(binding.spineRunId, SPINE_RUN_ID);
});

/**
 * Claude Code's `Stop` hook fires at every turn boundary, not at session end, so
 * a spine terminalized with `session_stop` routinely belongs to a chat that is
 * still open. Refusing all of them left every governed run after the first turn
 * boundary permanently unlinked, which is the whole of the reported defect.
 */
test("a deactivated spine run is revived when the host is provably the same chat", () => {
  const binding = bindingFor(stoppedSpineState(), { hostSessionId: CHAT_ID });

  assert.equal(binding.linked, true);
  assert.equal(binding.refusal, null);
  assert.equal(binding.sourceConversation.conversationId, CHAT_ID);
  assert.equal(binding.sourceConversation.matchBasis, "transcript_file_verified");
  // The revived route is weaker evidence than a live one. Sharing the live
  // route's name would make the two indistinguishable on the record, which is
  // the failure the whole module exists to prevent.
  assert.equal(binding.bindingBasis, "revived_host_session_binding");
  assert.notEqual(binding.bindingBasis, "live_spine_binding");
});

test("a deactivated spine run is not revived by a host carrying a different chat", () => {
  // The concrete case is a long-lived daemon started from another session: it
  // still exports that session's id for as long as it lives, so equality against
  // the recorded chat is the only thing separating it from the real host.
  const binding = bindingFor(stoppedSpineState(), {
    hostSessionId: "39a0b1c2-0000-4000-8000-000000000000",
  });

  assert.equal(binding.linked, false);
  assert.equal(binding.refusal, "spine_conversation_host_session_mismatch");
  assert.equal(binding.sourceConversation, null);
});

test("a deactivated spine run is not revived when the host exports no chat id at all", () => {
  const binding = bindingFor(stoppedSpineState());

  assert.equal(binding.linked, false);
  assert.equal(binding.refusal, "spine_conversation_host_session_absent");
  assert.equal(binding.sourceConversation, null);
});

test("a spine run that finished its own lifecycle is never revived, even by the right chat", () => {
  // `evolution_completed` is the run ending, not the session pausing. A matching
  // chat id says nothing about that, so the stronger fact must not override it.
  const binding = bindingFor(
    verifiedSpineState({ active: false, deactivationReason: "evolution_completed" }),
    { hostSessionId: CHAT_ID },
  );

  assert.equal(binding.linked, false);
  assert.equal(binding.refusal, "spine_run_inactive");

  // An unrecognised or absent reason is not evidence of a turn boundary either.
  for (const deactivationReason of [undefined, "some_future_reason"]) {
    const unknown = bindingFor(
      verifiedSpineState({ active: false, deactivationReason }),
      { hostSessionId: CHAT_ID },
    );
    assert.equal(unknown.linked, false);
    assert.equal(unknown.refusal, "spine_run_inactive");
  }
});

test("a spine run from another profile does not lend its chat across the profile boundary", () => {
  const binding = bindingFor(verifiedSpineState({ profile: "secondary" }));

  assert.equal(binding.linked, false);
  assert.equal(binding.refusal, "spine_profile_mismatch");
  assert.equal(binding.sourceConversation, null);
});

test("a chat the host never verified is not promoted to a link", () => {
  const withoutBasis = verifiedSpineState();
  const binding = bindingFor(verifiedSpineState({
    sourceConversation: { ...withoutBasis.sourceConversation, matchBasis: undefined },
  }));

  assert.equal(binding.linked, false);
  assert.equal(binding.refusal, "spine_conversation_unverified_basis");

  assert.equal(bindingFor(verifiedSpineState({ sourceConversation: null })).refusal, "spine_conversation_unlinked");
  assert.equal(bindingFor(null).refusal, "no_spine_state");
});

test("a link is never stamped without the governed run id it belongs to", () => {
  // An unstamped chat record reads as verified for every run on the read surface,
  // so a missing run id has to refuse rather than produce a link.
  const binding = bindingFor(verifiedSpineState(), { runId: null });

  assert.equal(binding.linked, false);
  assert.equal(binding.refusal, "governed_run_id_missing");
});

test("every binding refusal stays inside the declared vocabulary", () => {
  const states = [
    null,
    verifiedSpineState({ active: false }),
    stoppedSpineState(),
    verifiedSpineState({ profile: "secondary" }),
    verifiedSpineState({ sourceConversation: null }),
    verifiedSpineState({ sourceConversation: { runtime: "claude", conversationId: "x" } }),
  ];
  for (const spineState of states) {
    for (const hostSessionId of [null, CHAT_ID, "39a0b1c2-0000-4000-8000-000000000000"]) {
      const binding = bindingFor(spineState, { hostSessionId });
      assert.ok(
        binding.refusal === null || SPINE_CONVERSATION_BINDING_REFUSALS.includes(binding.refusal),
        `refusal ${binding.refusal} must be part of the declared vocabulary`,
      );
      assert.ok(
        binding.bindingBasis === null
          || SPINE_CONVERSATION_BINDING_BASIS.includes(binding.bindingBasis),
        `basis ${binding.bindingBasis} must be part of the declared vocabulary`,
      );
      // A refusal and a proven route are mutually exclusive; carrying both would
      // let a reader treat a refused binding as evidence of one.
      assert.equal(binding.linked, binding.bindingBasis !== null);
      assert.equal(binding.linked, binding.refusal === null);
    }
  }
});

test("the host chat id is read from the injected environment under the name the host actually sets", () => {
  assert.equal(detectHostSessionConversationId({ CLAUDE_CODE_SESSION_ID: CHAT_ID }), CHAT_ID);
  assert.equal(detectHostSessionConversationId({}), null);
  assert.equal(detectHostSessionConversationId({ CLAUDE_CODE_SESSION_ID: "   " }), null);

  // `CLAUDE_SESSION_ID` is not a variable this host sets. Reading that name would
  // fail silently — an absent variable is indistinguishable from a host that
  // exports no chat id, so the tier would simply never fire.
  assert.equal(detectHostSessionConversationId({ CLAUDE_SESSION_ID: CHAT_ID }), null);
  assert.deepEqual(HOST_SESSION_ENV_MARKER_NAMES, ["CLAUDE_CODE_SESSION_ID"]);
});

test("an inherited chat id is never read as proof of which host is running", () => {
  // A chat id outlives its session, so its presence cannot attribute a run.
  // Provenance has no refusal field, so a wrong answer there is stated as fact.
  const provenance = resolveGovernedRunProvenance({ env: { CLAUDE_CODE_SESSION_ID: CHAT_ID } });

  assert.equal(provenance.sourceRuntime, "unavailable");
  assert.equal(provenance.basis, "no_host_env_marker");
  assert.deepEqual(provenance.observedMarkers, []);

  const runtimeMarkerNames = new Set(HOST_RUNTIME_ENV_MARKERS.map((m) => m.envName));
  for (const name of HOST_SESSION_ENV_MARKER_NAMES) {
    assert.equal(runtimeMarkerNames.has(name), false, `${name} must stay out of the runtime table`);
  }
});

test("the stage runner strips every host variable a child could inherit an identity from", () => {
  const { childEnv, removedManagedHostMarkers } = buildRuntimeChildEnv("codex", {
    ...claudeHostEnv({ CLAUDE_CODE_SESSION_ID: CHAT_ID }),
    ...codexHostEnv({ CODEX_PERMISSION_PROFILE: "read-only" }),
  });

  assert.deepEqual(removedManagedHostMarkers, [...HOST_INHERITED_ENV_NAMES]);
  assert.deepEqual(HOST_INHERITED_ENV_NAMES, [
    ...HOST_RUNTIME_ENV_MARKER_NAMES,
    ...HOST_SESSION_ENV_MARKER_NAMES,
  ]);
  // A Codex child inheriting a Claude chat id could claim a chat it never had,
  // and the revived route accepts exactly that equality as its second fact.
  assert.equal(Object.hasOwn(childEnv, "CLAUDE_CODE_SESSION_ID"), false);

  // Two copies of this list diverge the moment a host adds a variable: the bridge
  // would keep leaking a marker that detection still trusts as host identity.
  const bridge = readFileSync("scripts/governed-execution/stage-runner-bridge.mjs", "utf8");
  assert.doesNotMatch(bridge, /"CLAUDE_CODE_ENTRYPOINT"/);
  assert.doesNotMatch(bridge, /"CLAUDE_CODE_SESSION_ID"/);
  assert.doesNotMatch(bridge, /"CODEX_PERMISSION_PROFILE",\s*\n\s*\]/);
});

test("chat liveness is never inferred from transcript file age", () => {
  // A session idle for hours is still the live session, and a transcript outlives
  // the session that wrote it — so file age answers a different question than the
  // one the revived route asks, in both directions.
  const source = readFileSync("scripts/governed-execution/host-runtime-provenance.mjs", "utf8");

  for (const recencySignal of [/\bmtime\b/, /\bmtimeMs\b/, /\bstatSync\b/, /\butimes\b/, /\bbirthtime\b/]) {
    assert.doesNotMatch(source, recencySignal);
  }
});

test("the run's state profile is read from the injected environment, not from the process", () => {
  assert.equal(governedRunStateProfile({}), "default");
  assert.equal(governedRunStateProfile({ META_KIM_PROFILE: "secondary" }), "secondary");
  assert.equal(governedRunStateProfile({ META_KIM_STATE_PROFILE: "secondary" }), "secondary");
  assert.equal(
    governedRunStateProfile({ META_KIM_PROFILE: "primary", META_KIM_STATE_PROFILE: "secondary" }),
    "primary",
  );
});

/**
 * The CLI is where the defect was reported from: a run started with no
 * `--runtime` came out stamped as the route's default vendor. The unit tests
 * above cannot see that, because the default lives in argument parsing — only a
 * real invocation with no flag proves the route default stopped reaching
 * provenance.
 */
test("a CLI run with no declared runtime records the host it was actually started under", async (t) => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-cli-hostprov-"));
  t.after(async () => fs.rm(outputRoot, { recursive: true, force: true }));
  const runId = "meta-cli-hostprov-1";
  const env = { ...process.env, CLAUDECODE: "1" };
  for (const name of HOST_INHERITED_ENV_NAMES) {
    if (name !== "CLAUDECODE") delete env[name];
  }
  delete env.META_KIM_RUNTIME;

  await promisify(execFile)(process.execPath, [
    "scripts/run-meta-theory-governed-execution.mjs",
    "--task", "Read package metadata and report the exact package name.",
    "--run-id", runId,
    "--state-dir", outputRoot,
    "--artifact-dir", outputRoot,
    "--db", path.join(outputRoot, "runs.sqlite"),
  ], { env, cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 });

  const artifact = JSON.parse(await fs.readFile(path.join(outputRoot, `${runId}.json`), "utf8"));
  assert.equal(artifact.sourceRuntime, "claude");
  assert.notEqual(artifact.sourceRuntime, "codex");
  assert.equal(artifact.requestRecord.runtimeContext.runtimeFamily, "claude");
  // The spine tier reads this repo's own state file, which cwd makes unavoidable
  // and whose liveness depends on whoever ran the suite. Stripping the inherited
  // chat id above rules out the revived route; an activated spine would still win
  // over the env markers, so the basis is asserted as any route that proves a
  // host rather than pinned to one. The defect being guarded is a vendor default
  // reaching this field at all, which `sourceRuntime` above pins exactly.
  assert.ok(
    ["host_env_marker", "live_spine_binding"].includes(
      artifact.hostProvenancePacket.provenanceBasis,
    ),
    `provenanceBasis ${artifact.hostProvenancePacket.provenanceBasis} must name a proven route`,
  );
  // The route still plans against its own default; only provenance changed.
  assert.equal(artifact.requestRecord.runtimeContext.routeTarget, "codex");
});
