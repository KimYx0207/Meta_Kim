import assert from "node:assert/strict";
import test from "node:test";

import { renderLiveControlRoomPage } from "../../src/presentation/live/live-control-room-page.mjs";
import { LIVE_UI_COPY, liveUiLocale, serializeLiveUiCopy, translateLiveUiCopy } from "../../src/presentation/live/live-ui-copy.mjs";
import { buildLocalFeedbackText } from "../../src/presentation/live/live-feedback-draft.mjs";

function shippedHelper(name) {
  const html = renderLiveControlRoomPage();
  const start = html.indexOf("  function " + name + "(");
  const end = html.indexOf("\n  function ", start + 1);
  assert.ok(start > 0 && end > start, name + " is shipped in the page");
  return html.slice(start, end);
}

function initialLanguage(stored, languages, denied = false) {
  const html = renderLiveControlRoomPage();
  const start = html.indexOf("  function initialLanguage() {");
  const end = html.indexOf("\n  function localize(", start);
  assert.ok(start > 0 && end > start);
  return new Function("window", "LANGUAGE_STORAGE_KEY", html.slice(start, end) + "\nreturn initialLanguage();")({
    navigator: { languages, language: languages[0] },
    localStorage: { getItem() { if (denied) throw new Error("denied"); return stored; } },
  }, "meta-kim-live-language");
}

test("Live chooses all four shipped languages using a saved choice, then browser preferences", () => {
  for (const [tag, language] of [["zh-Hans-CN", "zh"], ["en-GB", "en"], ["ja-JP", "ja"], ["ko-KR", "ko"]]) {
    assert.equal(initialLanguage(null, [tag]), language);
    assert.equal(initialLanguage(language, ["en-US"]), language);
    assert.equal(initialLanguage(null, [tag], true), language, "storage denial must not prevent the browser preference");
  }
  assert.equal(initialLanguage("unsupported", ["fr-FR", "ko-KR"]), "ko");
  assert.equal(initialLanguage(null, ["fr-FR"]), "en");
  assert.equal(initialLanguage(null, []), "zh");
});

test("the shipped language selector exposes four real choices", () => {
  const html = renderLiveControlRoomPage();
  assert.ok(/<select[^>]+data-live-language-select/u.test(html), "the shipped page exposes a native language selector");
  for (const [value, label] of [["zh", "中文"], ["en", "English"], ["ja", "日本語"], ["ko", "한국어"]]) {
    assert.match(html, new RegExp(`<option value="${value}">${label}</option>`, "u"));
  }
  assert.match(html, /localStorage\?\.setItem\(LANGUAGE_STORAGE_KEY, currentLanguage\)/u);
});

test("Japanese and Korean cover the actual UI labels and preserve every placeholder", () => {
  assert.deepEqual(Object.keys(LIVE_UI_COPY.ja).sort(), Object.keys(LIVE_UI_COPY.ko).sort());
  const placeholders = (value) => [...value.matchAll(/\{[A-Za-z]+\}/gu)].map(([match]) => match).sort();
  for (const language of ["ja", "ko"]) {
    const copy = LIVE_UI_COPY[language];
    for (const [key, translated] of Object.entries(copy)) {
      assert.ok(typeof translated === "string" && translated.length > 0, language + " / " + key);
      assert.deepEqual(placeholders(translated), placeholders(key), language + " / " + key);
    }
    const html = renderLiveControlRoomPage();
    for (const [, label] of html.matchAll(/data-i18n-en="([^"]+)"/gu)) {
      assert.ok(Object.hasOwn(copy, label), language + " misses shipped label: " + label);
    }
  }
});

test("stage labels and evidence type/status are reader-facing copy, not raw machine keys", () => {
  const stages = { critical: "Goal", fetch: "Research", thinking: "Design", execution: "Execution",
    review: "Review", "meta-review": "Meta-review", verification: "Checks", evolution: "Learning" };
  const english = new Function("currentLanguage", "LIVE_UI_COPY", "translateLiveUiCopy", "DISPLAY_FORMAT", "zhText",
    shippedHelper("display") + shippedHelper("localize") + "\nreturn localize;")(
    "en", LIVE_UI_COPY, translateLiveUiCopy, { emptyPlaceholder: "—" }, new Map(),
  );
  for (const [id, label] of Object.entries(stages)) assert.equal(english(id), label);
  for (const language of ["ja", "ko"]) {
    assert.notEqual(translateLiveUiCopy("evidence", language), "evidence");
    assert.notEqual(translateLiveUiCopy("verified", language), "verified");
    assert.equal(translateLiveUiCopy("evidence · 原始标题", language), LIVE_UI_COPY[language].evidence + " · 原始标题");
  }
});

test("the short update clock follows the selected UI language", () => {
  const at = "2026-11-12T16:07:15.000Z";
  for (const language of ["zh", "en", "ja", "ko"]) {
    const formatTime = new Function("currentLanguage", "liveUiLocale", "DISPLAY_FORMAT",
      shippedHelper("display") + shippedHelper("formatTime") + "\nreturn formatTime;")(
      language, liveUiLocale, { emptyPlaceholder: "—" },
    );
    assert.equal(formatTime(at), new Intl.DateTimeFormat(liveUiLocale(language), { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(at)));
    assert.equal(formatTime(null), "");
  }
});

test("the serialized browser formatter translates UI counters and leaves their values intact", () => {
  const browser = new Function(serializeLiveUiCopy() + "\nreturn { translateLiveUiCopy, liveUiLocale };")();
  for (const language of ["ja", "ko"]) {
    for (const value of ["Evidence", "Running", "1 linked evidence item · 0 tools · 7 events", "Tasks completed 3/7", "Owner · meta-warden", "Source · 原始 output.log", "No attached files"]) {
      assert.equal(browser.translateLiveUiCopy(value, language), translateLiveUiCopy(value, language));
    }
    assert.ok(translateLiveUiCopy("Owner · meta-warden", language).endsWith("meta-warden"));
    assert.ok(translateLiveUiCopy("Source · 原始 output.log", language).endsWith("原始 output.log"));
    assert.equal(translateLiveUiCopy("Fix the checkout form: keep email optional", language), "Fix the checkout form: keep email optional");
  }
  assert.equal(browser.liveUiLocale("ja"), "ja-JP");
  assert.equal(browser.liveUiLocale("ko"), "ko-KR");
});

test("saved task names and log bodies bypass UI translation even when they match a label", () => {
  const makeElement = new Function("document", "localize", "display", shippedHelper("makeElement") + "\nreturn makeElement;")(
    { createElement: () => ({}) }, (value) => "translated:" + value, (value) => value,
  );
  const setText = new Function("localize", "display", shippedHelper("setText") + "\nreturn setText;")(
    (value) => "translated:" + value, (value) => value,
  );
  assert.equal(makeElement("span", "", "Requirements analysis", { record: true }).textContent, "Requirements analysis");
  assert.equal(makeElement("span", "", "Requirements analysis").textContent, "translated:Requirements analysis");
  const body = {};
  setText(body, "Run ABC", undefined, { record: true });
  assert.equal(body.textContent, "Run ABC");
});

test("localized built-in demos keep the same observation facts and explicit demo boundary", () => {
  const demo = (language) => new Function("currentLanguage", "localize", shippedHelper("buildStateDemoSnapshot") + "\nreturn buildStateDemoSnapshot();")(
    language, (value) => translateLiveUiCopy(value, language),
  );
  const facts = (snapshot) => ({
    demo: snapshot.run.demoMode, sourceRuntime: snapshot.run.sourceRuntime,
    permissions: snapshot.permissions, edges: snapshot.edges,
    nodes: snapshot.nodes.map(({ id, status, active, displayState, ownerAgent }) => ({ id, status, active, displayState, ownerAgent })),
    evidence: snapshot.evidence.map(({ id, nodeId, status }) => ({ id, nodeId, status })),
  });
  const english = demo("en");
  for (const language of ["ja", "ko"]) {
    const localized = demo(language);
    assert.deepEqual(facts(localized), facts(english));
    assert.equal(localized.run.title, LIVE_UI_COPY[language][english.run.title]);
    assert.equal(localized.nodes[1].label, LIVE_UI_COPY[language]["Requirements analysis"]);
    assert.equal(localized.evidence[0].summary, LIVE_UI_COPY[language]["Demo completion evidence"]);
    assert.equal(localized.permissions.readOnly, true);
    assert.equal(localized.permissions.canMutate, false);
    assert.equal(localized.run.demoMode, true);
  }
});

test("Japanese and Korean feedback instructions retain exact user feedback and identifiers", () => {
  const original = "  Keep the title Requirements analysis.\n原話・원문  ";
  for (const language of ["ja", "ko"]) {
    const text = buildLocalFeedbackText({ runId: "run-literal", nodeId: "node-literal", nodeLabel: "Requirements analysis" }, original, language);
    assert.ok(text.startsWith(LIVE_UI_COPY[language]["Revise this result using the feedback below, preserve confirmed requirements and unrelated work, then check the same result again."]));
    assert.ok(text.includes("Requirements analysis · node-literal"));
    assert.ok(text.includes("run-literal"));
    assert.ok(text.endsWith(original));
  }
});

test("composed UI counters preserve their spacing and translate each measured-value label", () => {
  for (const language of ["en", "ja", "ko"]) {
    const localize = new Function("currentLanguage", "LIVE_UI_COPY", "translateLiveUiCopy", "DISPLAY_FORMAT", "zhText",
      shippedHelper("display") + shippedHelper("localize") + "\nreturn localize;")(
      language, LIVE_UI_COPY, translateLiveUiCopy, { emptyPlaceholder: "—" }, new Map(),
    );
    const value = localize("Input · ") + "0" + localize(" / Output · ") + "3";
    assert.equal(value, language === "en" ? "Input · 0 / Output · 3"
      : LIVE_UI_COPY[language]["Input · "] + "0" + LIVE_UI_COPY[language][" / Output · "] + "3");
    assert.equal(localize("\nunknown record text\n"), "unknown record text", "only known product fragments bypass display normalization");
  }
});
