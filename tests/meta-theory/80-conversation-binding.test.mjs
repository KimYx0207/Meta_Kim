import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONVERSATION_BINDING_MATCH_BASIS,
  CONVERSATION_BINDING_RUNTIMES,
  resolveVerifiedSourceConversation,
} from "../../canonical/runtime-assets/shared/hooks/conversation-binding.mjs";
import {
  PROJECT_META_KIM_HOOK_FILES,
  SHARED_RUNTIME_HOOK_FILES,
} from "../../scripts/runtime-hook-mapping.mjs";
import {
  bindSourceConversation,
  SOURCE_CONVERSATION_MATCH_BASIS,
} from "../../canonical/runtime-assets/shared/hooks/spine-state.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SESSION_ID = "b5799d00-ef7a-4882-818d-d9053cacba71";
const TRANSCRIPT_DIR = "/home/kim/.claude/projects/D--KimProject-Meta-Kim";
const TRANSCRIPT_PATH = `${TRANSCRIPT_DIR}/${SESSION_ID}.jsonl`;

function presentFile(size = 4096) {
  return () => ({ exists: true, isFile: true, size });
}

function claudePayload(overrides = {}) {
  return {
    hook_event_name: "UserPromptSubmit",
    session_id: SESSION_ID,
    transcript_path: TRANSCRIPT_PATH,
    cwd: "D:\\KimProject\\Meta_Kim",
    ...overrides,
  };
}

test("binds the conversation when the transcript file confirms the claimed session id", () => {
  const resolved = resolveVerifiedSourceConversation(claudePayload(), {
    runtime: "claude",
    fileFacts: presentFile(),
  });

  assert.deepEqual(resolved.conversation, {
    runtime: "claude",
    conversationId: SESSION_ID,
    matchBasis: CONVERSATION_BINDING_MATCH_BASIS,
  });
  assert.deepEqual(resolved.binding, {
    state: "verified",
    runtime: "claude",
    basis: CONVERSATION_BINDING_MATCH_BASIS,
  });
});

test("carries a host-supplied conversation title without inventing one", () => {
  const titled = resolveVerifiedSourceConversation(
    claudePayload({ conversation_title: "Live control room closure" }),
    { runtime: "claude", fileFacts: presentFile() },
  );
  assert.equal(titled.conversation.title, "Live control room closure");

  const untitled = resolveVerifiedSourceConversation(claudePayload(), {
    runtime: "claude",
    fileFacts: presentFile(),
  });
  assert.equal("title" in untitled.conversation, false);
});

test("never returns the transcript path, so a user home never reaches a run record", () => {
  const resolved = resolveVerifiedSourceConversation(claudePayload(), {
    runtime: "claude",
    fileFacts: presentFile(),
  });
  assert.equal(JSON.stringify(resolved.conversation).includes(TRANSCRIPT_DIR), false);
  assert.equal(JSON.stringify(resolved.binding).includes(TRANSCRIPT_DIR), false);
});

test("normalizes the claude-code runtime alias and accepts every declared runtime", () => {
  assert.equal(
    resolveVerifiedSourceConversation(claudePayload(), {
      runtime: "claude-code",
      fileFacts: presentFile(),
    }).conversation.runtime,
    "claude",
  );

  for (const runtime of CONVERSATION_BINDING_RUNTIMES) {
    const resolved = resolveVerifiedSourceConversation(claudePayload(), {
      runtime,
      fileFacts: presentFile(),
    });
    assert.equal(resolved.conversation?.runtime, runtime, `${runtime} must bind`);
  }
});

test("refuses to bind when the runtime is not identified", () => {
  const resolved = resolveVerifiedSourceConversation(claudePayload(), {
    runtime: "",
    fileFacts: presentFile(),
  });
  assert.equal(resolved.conversation, null);
  assert.deepEqual(resolved.binding, { state: "unlinked", runtime: null, reason: "runtime_not_identified" });
});

test("refuses to bind when the host supplies no usable conversation id", () => {
  const resolved = resolveVerifiedSourceConversation(
    claudePayload({ session_id: undefined, transcript_path: undefined }),
    { runtime: "claude", fileFacts: presentFile() },
  );
  assert.equal(resolved.conversation, null);
  assert.deepEqual(resolved.binding, {
    state: "unlinked",
    runtime: "claude",
    reason: "conversation_id_not_identified",
  });
});

test("refuses ids that fall outside the conversation reference shape", () => {
  for (const sessionId of ["../../etc/passwd", "a", "id with spaces", "id\nnewline"]) {
    const resolved = resolveVerifiedSourceConversation(
      claudePayload({ session_id: sessionId, transcript_path: `${TRANSCRIPT_DIR}/${sessionId}.jsonl` }),
      { runtime: "claude", fileFacts: presentFile() },
    );
    assert.equal(resolved.conversation, null, `${sessionId} must not bind`);
    assert.equal(resolved.binding.reason, "conversation_id_not_identified");
  }
});

test("refuses to bind when the host names a session but no transcript path", () => {
  const resolved = resolveVerifiedSourceConversation(
    claudePayload({ transcript_path: undefined }),
    { runtime: "claude", fileFacts: presentFile() },
  );
  assert.equal(resolved.conversation, null);
  assert.equal(resolved.binding.reason, "transcript_path_absent");
});

test("refuses a relative transcript path, because cwd is not part of the proof", () => {
  const resolved = resolveVerifiedSourceConversation(
    claudePayload({ transcript_path: `projects/${SESSION_ID}.jsonl` }),
    { runtime: "claude", fileFacts: presentFile() },
  );
  assert.equal(resolved.conversation, null);
  assert.equal(resolved.binding.reason, "transcript_path_not_absolute");
});

test("refuses when the transcript file names a different session than the payload claims", () => {
  const resolved = resolveVerifiedSourceConversation(
    claudePayload({ transcript_path: `${TRANSCRIPT_DIR}/4a65610b-a469-4ef5-af02-ea62e7464510.jsonl` }),
    { runtime: "claude", fileFacts: presentFile() },
  );
  assert.equal(resolved.conversation, null);
  assert.deepEqual(resolved.binding, {
    state: "unlinked",
    runtime: "claude",
    reason: "transcript_identity_mismatch",
  });
});

test("refuses when the named transcript is missing or is not a regular file", () => {
  const missing = resolveVerifiedSourceConversation(claudePayload(), {
    runtime: "claude",
    fileFacts: () => ({ exists: false, isFile: false, size: 0 }),
  });
  assert.equal(missing.conversation, null);
  assert.equal(missing.binding.reason, "transcript_file_absent");

  const directory = resolveVerifiedSourceConversation(claudePayload(), {
    runtime: "claude",
    fileFacts: () => ({ exists: true, isFile: false, size: 4096 }),
  });
  assert.equal(directory.conversation, null);
  assert.equal(directory.binding.reason, "transcript_file_absent");
});

test("refuses an empty transcript, because an empty file proves no conversation", () => {
  const resolved = resolveVerifiedSourceConversation(claudePayload(), {
    runtime: "claude",
    fileFacts: () => ({ exists: true, isFile: true, size: 0 }),
  });
  assert.equal(resolved.conversation, null);
  assert.equal(resolved.binding.reason, "transcript_file_empty");
});

test("survives a filesystem probe that throws instead of answering", () => {
  const resolved = resolveVerifiedSourceConversation(claudePayload(), {
    runtime: "claude",
    fileFacts: () => {
      throw new Error("EPERM");
    },
  });
  assert.equal(resolved.conversation, null);
  assert.equal(resolved.binding.reason, "transcript_file_absent");
});

test("the activation hook asks the resolver instead of hardcoding an unlinked run", () => {
  const hookPath = path.join(
    REPO_ROOT,
    "canonical/runtime-assets/shared/hooks/activate-meta-theory-spine.mjs",
  );
  const source = readFileSync(hookPath, "utf8");

  assert.match(source, /from "\.\/conversation-binding\.mjs"/u);
  assert.match(source, /resolveVerifiedSourceConversation/u);
  assert.equal(
    /sourceConversation:\s*null/u.test(source),
    false,
    "the activation hook must not pin every run to an unlinked conversation",
  );
});

// This reads the projection manifests, not the projected directories. A hook
// directory that is one sync behind is self-consistent — the older entrypoint
// does not import the module, so nothing dangles — and stayed green here for a
// day while every run recorded an unlinked conversation. Drift on disk is
// content-hash work and belongs to `npm run meta:check:runtimes`.
test("the resolver is declared as a shipped dependency of the hook that imports it", () => {
  assert.ok(
    SHARED_RUNTIME_HOOK_FILES.includes("conversation-binding.mjs"),
    "conversation-binding.mjs must be a shared runtime hook file",
  );
  assert.ok(
    PROJECT_META_KIM_HOOK_FILES.has("conversation-binding.mjs"),
    "conversation-binding.mjs must be projected into project hook directories",
  );
  const sharedIndex = SHARED_RUNTIME_HOOK_FILES.indexOf("conversation-binding.mjs");
  const hookIndex = SHARED_RUNTIME_HOOK_FILES.indexOf("activate-meta-theory-spine.mjs");
  assert.ok(
    sharedIndex >= 0 && hookIndex > sharedIndex,
    "the dependency must be listed before the entrypoint that imports it",
  );
});

// `matchBasis` is the only field the binding consumer reads before it decides a
// run is unverified: `scripts/governed-execution/host-runtime-provenance.mjs`
// refuses with `spine_conversation_unverified_basis` when the basis is absent.
// The whitelist in `spine-state.mjs` therefore hands out permission to be read as
// verified, and it carried `host_reported_binding` with no producer anywhere in
// `canonical/`, `scripts/`, or `src/`, and no consumer past the membership check
// itself — so any caller that wrote that string by hand would have passed. Zero of
// this machine's stored records carried it, which is what "no producer" looks like
// from the disk side.
//
// Both halves below are measured rather than read off a constant. The earned set
// comes from running the verifier; admission comes from putting each value through
// the state writer. Comparing the whitelist against the verifier's exported
// constant would be vacuous, because the whitelist is derived from it.
test("every basis the state gate admits is one a verifier can earn", () => {
  const earned = new Set();
  const verified = resolveVerifiedSourceConversation(claudePayload(), {
    runtime: "claude",
    fileFacts: presentFile(),
  });
  if (typeof verified.conversation?.matchBasis === "string") {
    earned.add(verified.conversation.matchBasis);
  }

  assert.ok(
    earned.size > 0,
    "the verifier must earn a basis for a payload it accepts, or every comparison below is vacuous",
  );
  assert.ok(
    SOURCE_CONVERSATION_MATCH_BASIS.length > 0,
    "an empty whitelist would satisfy the loop below while stripping every basis in production",
  );

  for (const basis of SOURCE_CONVERSATION_MATCH_BASIS) {
    assert.ok(
      earned.has(basis),
      `nothing can earn "${basis}", so admitting it lets a hand-written string read as a verified binding`,
    );
    const bound = bindSourceConversation(
      { runId: "meta-run-basis-invariant" },
      { runtime: "claude", conversationId: SESSION_ID, matchBasis: basis },
      { sourceRuntime: "claude" },
    );
    assert.equal(
      bound.sourceConversation?.matchBasis,
      basis,
      `the state writer must keep "${basis}", or a run that did verify is stored as one that did not`,
    );
  }
});
