import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  LIVE_DISPLAY_FORMAT_CONFIG_URL,
  LIVE_DISPLAY_FORMAT_SCHEMA_VERSION,
  loadLiveDisplayFormat,
  normalizeLiveDisplayFormat,
  resolveNodeTaskLine,
  serializeIdentifierShortener,
  serializeNodeTaskLineResolver,
  shortenIdentifier,
} from "../../src/application/live/live-display-format.mjs";

const shipped = loadLiveDisplayFormat();

function validDocument(overrides = {}) {
  return {
    schemaVersion: LIVE_DISPLAY_FORMAT_SCHEMA_VERSION,
    emptyPlaceholder: "-",
    identifierShortForm: { maxChars: 20, headChars: 8, tailChars: 8, ellipsis: "…" },
    nodeTaskLine: { minChars: 2, sourceFields: ["task"], duplicateOfFields: ["label"] },
    nonInformativeValues: ["unknown"],
    ...overrides,
  };
}

test("schema version is declared for cross-layer contract checks", () => {
  assert.equal(LIVE_DISPLAY_FORMAT_SCHEMA_VERSION, "meta-kim-live-display-format-v1");
});

test("the shipped display-format document is the validated source of truth", () => {
  const raw = JSON.parse(readFileSync(LIVE_DISPLAY_FORMAT_CONFIG_URL, "utf8"));
  assert.deepEqual(shipped, normalizeLiveDisplayFormat(raw), "the loader must not transform the document");
  assert.equal(shipped.schemaVersion, LIVE_DISPLAY_FORMAT_SCHEMA_VERSION);
  assert.ok(shipped.emptyPlaceholder.length > 0, "the placeholder glyph must be configured, not implied");
  assert.ok(shipped.nodeTaskLine.sourceFields.length > 0);
});

test("a malformed document is rejected instead of silently defaulted", () => {
  const rejections = [
    [null, "LIVE_DISPLAY_FORMAT_INVALID"],
    [{}, "LIVE_DISPLAY_FORMAT_SCHEMA_MISMATCH"],
    [validDocument({ schemaVersion: "meta-kim-live-display-format-v0" }), "LIVE_DISPLAY_FORMAT_SCHEMA_MISMATCH"],
    [validDocument({ emptyPlaceholder: "" }), "LIVE_DISPLAY_FORMAT_INVALID"],
    [validDocument({ identifierShortForm: { maxChars: 0, headChars: 8, tailChars: 8, ellipsis: "…" } }), "LIVE_DISPLAY_FORMAT_INVALID"],
    [validDocument({ identifierShortForm: { maxChars: 20, headChars: 8.5, tailChars: 8, ellipsis: "…" } }), "LIVE_DISPLAY_FORMAT_INVALID"],
    [validDocument({ identifierShortForm: { maxChars: 12, headChars: 8, tailChars: 8, ellipsis: "…" } }), "LIVE_DISPLAY_FORMAT_SHORT_FORM_USELESS"],
    [validDocument({ nodeTaskLine: { minChars: 2, sourceFields: [], duplicateOfFields: [] } }), "LIVE_DISPLAY_FORMAT_INVALID"],
    [validDocument({ nodeTaskLine: { minChars: 2, sourceFields: ["task"], duplicateOfFields: "label" } }), "LIVE_DISPLAY_FORMAT_INVALID"],
    [validDocument({ nonInformativeValues: undefined }), "LIVE_DISPLAY_FORMAT_INVALID"],
    [validDocument({ nonInformativeValues: ["Unknown"] }), "LIVE_DISPLAY_FORMAT_INVALID"],
    [validDocument({ nonInformativeValues: ["unknown", ""] }), "LIVE_DISPLAY_FORMAT_INVALID"],
  ];
  for (const [document, code] of rejections) {
    assert.throws(() => normalizeLiveDisplayFormat(document), (error) => error.code === code, `expected ${code} for ${JSON.stringify(document)}`);
  }
  assert.doesNotThrow(() => normalizeLiveDisplayFormat(validDocument()), "positive control: the valid document must pass");
});

test("the non-informative sentinel list is case-folded so it can actually match", () => {
  assert.ok(shipped.nonInformativeValues.length > 0, "the shipped list must carry the sentinels the renderer filters");
  for (const entry of shipped.nonInformativeValues) {
    assert.equal(entry, entry.toLowerCase(), `${entry} would never match a case-folded observed value`);
  }
  assert.ok(
    shipped.nonInformativeValues.includes("unknown"),
    "the observed snapshots carry literal 'unknown' owners; dropping this entry would surface them as facts",
  );
  assert.equal(
    shipped.nonInformativeValues.includes(shipped.emptyPlaceholder),
    false,
    "the placeholder is filtered by its own comparison, not by this list",
  );
  assert.doesNotThrow(
    () => normalizeLiveDisplayFormat(validDocument({ nonInformativeValues: [] })),
    "an empty list is a legitimate choice: it means filter nothing",
  );
});

test("an unreadable document reports the path instead of failing anonymously", () => {
  assert.throws(
    () => loadLiveDisplayFormat(new URL("./missing-display-format.json", import.meta.url)),
    (error) => error.code === "LIVE_DISPLAY_FORMAT_UNREADABLE" && /missing-display-format\.json/u.test(error.message),
  );
});

test("an identifier short enough to read is never rewritten", () => {
  const form = shipped.identifierShortForm;
  const runId = "live-ui-regression";
  assert.ok(runId.length <= form.maxChars, "fixture precondition: this run id fits the budget");
  assert.equal(shortenIdentifier(runId, form), runId, "a readable id must be reproduced verbatim");
  assert.notEqual(shortenIdentifier(runId, form), "GRESSION", "a fixed tail slice produced a string that matches no run");
});

test("a long identifier keeps both ends so it can be matched back to the run", () => {
  const form = shipped.identifierShortForm;
  const runId = "meta-2026-08-30t21-55-12-985z-a1b2c3d4";
  const short = shortenIdentifier(runId, form);
  assert.ok(short.length < runId.length, "negative control: a long id must actually shorten");
  assert.ok(short.includes(form.ellipsis), "the elision must be visible");
  assert.ok(runId.startsWith(short.slice(0, form.headChars)), "the head must come from the id");
  assert.ok(runId.endsWith(short.slice(-form.tailChars)), "the tail must come from the id");
});

test("identifier shortening never splits a surrogate pair", () => {
  const short = shortenIdentifier("🙂".repeat(30), shipped.identifierShortForm);
  const loneSurrogate = [...short].some((character) => {
    const code = character.codePointAt(0);
    return code >= 0xd800 && code <= 0xdfff;
  });
  assert.equal(loneSurrogate, false, "slicing by UTF-16 unit would leave half an emoji behind");
});

test("non-string identifiers degrade to empty rather than to a placeholder", () => {
  for (const value of [null, undefined, 42, {}, "", "   "]) {
    assert.equal(shortenIdentifier(value, shipped.identifierShortForm), "");
  }
});

test("a node task line that repeats the label is suppressed", () => {
  const node = { label: "read-source", summary: "reads the page module", task: "read-source" };
  assert.equal(resolveNodeTaskLine(node, shipped), "", "the observed regression printed this line twice");
  assert.equal(
    resolveNodeTaskLine({ ...node, task: "read the control-room page module" }, shipped),
    "read the control-room page module",
    "negative control: a task that adds information must survive",
  );
});

test("duplicate detection ignores case and whitespace noise", () => {
  const node = { label: "Read Source", task: "  read   source  " };
  assert.equal(resolveNodeTaskLine(node, shipped), "");
  assert.equal(resolveNodeTaskLine({ summary: "Merge Owner", task: "merge owner" }, shipped), "");
});

test("a placeholder-valued task falls through to the next configured field", () => {
  const placeholder = shipped.emptyPlaceholder;
  assert.equal(resolveNodeTaskLine({ task: placeholder, label: "worker" }, shipped), "", "no field carries a value");
  assert.equal(
    resolveNodeTaskLine({ task: placeholder, description: "verifies the packed CLI", label: "worker" }, shipped),
    "verifies the packed CLI",
    "the description must be used once the task slot is empty",
  );
});

test("a task line shorter than the configured minimum is not worth a row", () => {
  assert.equal(resolveNodeTaskLine({ task: "x" }, shipped), "");
  assert.equal(resolveNodeTaskLine({ task: "xy" }, shipped), "xy", "positive control: the minimum is inclusive");
});

test("malformed node input degrades to an empty line instead of throwing", () => {
  assert.equal(resolveNodeTaskLine(null, shipped), "");
  assert.equal(resolveNodeTaskLine({ task: 42 }, shipped), "");
  assert.equal(resolveNodeTaskLine({ task: "real work" }, null), "real work", "a missing policy must fall back to defaults");
});

test("the serialized formatters are self-contained enough to run in the browser bundle", () => {
  const sources = [serializeIdentifierShortener(), serializeNodeTaskLineResolver()];
  for (const source of sources) {
    assert.doesNotMatch(source, /\bimport\b|\brequire\(/u, "serialized source must not reference a module system");
    assert.doesNotMatch(source, /`/u, "serialized source must not contain backticks; it is inlined into a template literal");
    assert.doesNotMatch(source, /\$\{/u, "serialized source must not contain template substitutions");
  }

  const isolatedShorten = new Function(`return (${sources[0]});`)();
  const isolatedTaskLine = new Function(`return (${sources[1]});`)();
  const identifiers = ["live-ui-regression", "meta-2026-08-30t21-55-12-985z-a1b2c3d4", "", "x"];
  for (const identifier of identifiers) {
    assert.equal(
      isolatedShorten(identifier, shipped.identifierShortForm),
      shortenIdentifier(identifier, shipped.identifierShortForm),
      `inlined shortener disagreed for ${identifier}`,
    );
  }
  const nodes = [
    { label: "read-source", task: "read-source" },
    { label: "read-source", task: "read the page module" },
    { task: shipped.emptyPlaceholder, description: "verifies the packed CLI" },
  ];
  for (const node of nodes) {
    assert.equal(
      isolatedTaskLine(node, shipped),
      resolveNodeTaskLine(node, shipped),
      `inlined task resolver disagreed for ${JSON.stringify(node)}`,
    );
  }
});
