import test from "node:test";
import assert from "node:assert/strict";

import { CONVERSATION_BINDING_REFUSAL_REASONS } from "../../canonical/runtime-assets/shared/hooks/conversation-binding.mjs";
import {
  CONVERSATION_LINK_REFUSAL_COPY,
  CONVERSATION_LINK_REFUSAL_REASONS,
  conversationLinkRefusalFor,
  normalizeConversationLinkRefusal,
} from "../../src/application/live/live-conversation-link-vocabulary.mjs";
import { renderLiveControlRoomPage } from "../../src/presentation/live/live-control-room-page.mjs";

test("the read surface knows exactly the reasons the hook can write", () => {
  // Two hand-kept lists drift, and this one drifts silently: a reason the hook
  // writes but this list omits normalizes to null, which reads as "no reason was
  // recorded" — the same output as a run that genuinely had none. Comparing both
  // directions is not enough on its own, because two empty lists also match.
  assert.ok(
    CONVERSATION_LINK_REFUSAL_REASONS.length >= 7,
    "an empty or truncated vocabulary would make every comparison below vacuous",
  );
  assert.ok(
    CONVERSATION_LINK_REFUSAL_REASONS.includes("transcript_file_absent"),
    "the reason a real failed binding records must be present, not just some list",
  );
  assert.deepEqual(
    [...CONVERSATION_LINK_REFUSAL_REASONS].sort(),
    [...CONVERSATION_BINDING_REFUSAL_REASONS].sort(),
    "every reason the activation hook can record must be a reason this surface can read",
  );
});

test("every reason a run can carry has a sentence a reader can act on", () => {
  for (const reason of CONVERSATION_LINK_REFUSAL_REASONS) {
    const copy = CONVERSATION_LINK_REFUSAL_COPY[reason];
    assert.equal(typeof copy, "string", `${reason} has no copy, so it would print as a raw enum`);
    assert.ok(copy.length > 12, `${reason} copy is too short to tell a reader where to look`);
    assert.ok(
      !copy.includes("_"),
      `${reason} copy still reads like an identifier rather than a sentence`,
    );
  }
});

test("an unknown or malformed reason falls back instead of reaching the reader", () => {
  assert.equal(normalizeConversationLinkRefusal("transcript_file_absent"), "transcript_file_absent");
  assert.equal(normalizeConversationLinkRefusal("a_reason_from_a_newer_build"), null);
  assert.equal(normalizeConversationLinkRefusal(""), null);
  assert.equal(normalizeConversationLinkRefusal(null), null);
  assert.equal(normalizeConversationLinkRefusal({ reason: "transcript_file_absent" }), null);
  assert.equal(normalizeConversationLinkRefusal(["transcript_file_absent"]), null);
});

test("a verified link suppresses a stale reason left by an earlier attempt", () => {
  // The writer already refuses to emit both. A reader takes the file as given, so
  // it has to refuse the contradiction on its own or it will print "verified link"
  // and "the transcript is gone" about one run.
  assert.equal(conversationLinkRefusalFor("verified", "transcript_file_absent"), null);
  assert.equal(conversationLinkRefusalFor("unlinked", "transcript_file_absent"), "transcript_file_absent");
  assert.equal(conversationLinkRefusalFor("candidate", "transcript_file_absent"), "transcript_file_absent");
  assert.equal(conversationLinkRefusalFor("unlinked", "not_a_known_reason"), null);
});

test("the shipped page carries both languages for every reason", () => {
  const html = renderLiveControlRoomPage();
  for (const reason of CONVERSATION_LINK_REFUSAL_REASONS) {
    const english = CONVERSATION_LINK_REFUSAL_COPY[reason];
    assert.ok(
      html.includes(english),
      `${reason} copy never reaches the client script, so the reason cannot be shown`,
    );
    // A missing translation does not fail loudly: `zhText.get(text) || text`
    // returns the English source, so a Chinese reader silently gets English.
    const zhEntry = new RegExp(
      `"${english.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}":\\s*"([^"]+)"`,
      "u",
    ).exec(html);
    assert.ok(zhEntry, `${reason} has no zhText entry, so Chinese readers fall back to English`);
    assert.ok(
      /[一-鿿]/u.test(zhEntry[1]),
      `${reason} zhText entry is not Chinese: ${zhEntry[1]}`,
    );
  }
});
