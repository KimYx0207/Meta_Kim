/**
 * Page-level guards for the display-format contract.
 *
 * The control room renders observed run data, and every defect these tests pin
 * down was visible in a real browser before it was understood:
 *
 *   - structural spans carried a stray placeholder glyph because the renderer
 *     substituted one for every absent value, including values a caller had
 *     explicitly asked to render as nothing;
 *   - the run id `live-ui-regression` displayed as `GRESSION`, a string that
 *     appears in no run and cannot be searched for;
 *   - inspector facts hardcoded the glyph in twelve places, so the configured
 *     placeholder and the rendered one could silently disagree.
 *
 * The assertions therefore run the *shipped* client source rather than the
 * module copies: the browser bundle is a serialized template, and only
 * evaluating what it actually emits can refute a regression in it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadLiveDisplayFormat, shortenIdentifier } from "../../src/application/live/live-display-format.mjs";
import { renderLiveControlRoomPage } from "../../src/presentation/live/live-control-room-page.mjs";

const displayFormat = loadLiveDisplayFormat();
const html = renderLiveControlRoomPage({});

/** Extract the bodies of every inline script the page emits. */
function inlineScriptBodies(document) {
  const bodies = [];
  let cursor = 0;
  for (;;) {
    const open = document.indexOf("<script", cursor);
    if (open === -1) break;
    const bodyStart = document.indexOf(">", open);
    if (bodyStart === -1) break;
    const close = document.indexOf("</script", bodyStart);
    if (close === -1) break;
    bodies.push(document.slice(bodyStart + 1, close));
    cursor = close + 1;
  }
  return bodies;
}

const clientScript = inlineScriptBodies(html).find((body) => body.includes("function labeledFact"));

/**
 * Slice a top-level client-script function by name. Top-level functions in the
 * bundle are indented by two spaces, so the first `\n  }` after the header is
 * that function's closing brace.
 */
function extractFunction(name) {
  const header = `\n  function ${name}(`;
  const start = clientScript.indexOf(header);
  assert.notEqual(start, -1, `${name} must remain in the shipped client script`);
  const end = clientScript.indexOf("\n  }", start);
  assert.notEqual(end, -1, `${name} must be a top-level client-script function`);
  return clientScript.slice(start + 1, end + 4);
}

/** Re-create a shipped client function in an isolated scope. */
function evaluateClientFunction(name, dependencies = [], bindings = {}) {
  const sources = [...dependencies.map((dependency) => extractFunction(dependency)), extractFunction(name)];
  const bindingNames = Object.keys(bindings);
  const factory = new Function(
    "DISPLAY_FORMAT",
    ...bindingNames,
    `${sources.join("\n")}\nreturn ${name};`,
  );
  return factory(displayFormat, ...bindingNames.map((key) => bindings[key]));
}

test("the shipped bundle inlines the resolved display-format document verbatim", () => {
  assert.ok(clientScript, "the client script must be recoverable from the rendered page");
  const literal = clientScript.match(/const DISPLAY_FORMAT = (\{.*?\});\n/su);
  assert.ok(literal, "the bundle must carry the policy as a literal, not re-read it at runtime");
  assert.deepEqual(
    JSON.parse(literal[1]),
    JSON.parse(JSON.stringify(displayFormat)),
    "the browser must format values with the same policy the server validated",
  );
});

test("the client script cannot terminate its own script tag", () => {
  for (const body of inlineScriptBodies(html)) {
    assert.doesNotMatch(body, /<script/u, "an inline script body must not reopen a script tag");
  }
  assert.ok(
    clientScript.includes("function display(value, fallback)"),
    "a stray closing tag inside the bundle would truncate this extraction before display()",
  );
});

test("display honours an explicitly empty fallback instead of inventing a placeholder", () => {
  const display = evaluateClientFunction("display");
  for (const absent of [null, undefined, ""]) {
    assert.equal(display(absent, ""), "", "an explicit empty fallback means the caller wants nothing rendered");
    assert.equal(
      display(absent),
      displayFormat.emptyPlaceholder,
      "an omitted fallback still means the configured placeholder",
    );
  }
  assert.equal(display("owner-a", ""), "owner-a", "positive control: a real value survives");
});

test("display no longer leaks a placeholder into machine-read values", () => {
  const display = evaluateClientFunction("display");
  assert.equal(Number.isNaN(new Date(display("", "")).getTime()), true, "an absent timestamp must not parse");
  assert.notEqual(
    display("", ""),
    displayFormat.emptyPlaceholder,
    "the placeholder used to flow into Date parsing, URL parameters and the session search box",
  );
  assert.equal(display("2026-08-30T21:55:12.985Z", ""), "2026-08-30T21:55:12.985Z");
});

test("display strips control characters that would break the rendered markup", () => {
  const display = evaluateClientFunction("display");
  const tab = String.fromCharCode(9);
  const nul = String.fromCharCode(0);
  const del = String.fromCharCode(127);
  assert.equal(display("owner" + tab + "a", ""), "owner a", "a tab must not survive into the markup");
  assert.equal(display(nul + "owner" + del, ""), "owner", "C0 and DEL must be stripped, then trimmed");
  assert.equal(display(nul, ""), "", "a value that is nothing but control characters carries no information");
  assert.equal(display("a".repeat(400), "").length, 240, "an unbounded value must not blow out the layout");
});

test("the bundle inlines the reviewed shortener rather than a second implementation", () => {
  const prefix = "const shortenIdentifier = ";
  const start = clientScript.indexOf(prefix);
  assert.notEqual(start, -1, "the shortener must be inlined, not reimplemented inside the template");
  // A serialized function keeps its own indentation, so its closing brace is the
  // first one at column zero. Matching an indented brace instead runs past the
  // shortener and into whatever the template inlines next.
  const end = clientScript.indexOf("\n};", start);
  assert.notEqual(end, -1, "the inlined shortener must terminate at its own closing brace");
  const inlined = clientScript.slice(start + prefix.length, end + 3).trim();
  assert.equal(
    inlined,
    shortenIdentifier.toString() + ";",
    "server and browser must shorten identifiers with one implementation, not two that can drift",
  );
});

test("no structural element is created with a literal empty text argument", () => {
  const literalEmptyThirdArgument = clientScript.match(
    /makeElement\(\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*""\s*\)/gu,
  );
  assert.equal(
    literalEmptyThirdArgument,
    null,
    "makeElement renders the placeholder for an empty value, so a literal empty marker prints a stray glyph",
  );
  assert.match(
    clientScript,
    /makeElement\("span", "", label\)/u,
    "negative control: an empty className with a real value is the legitimate form and must not be flagged",
  );
});

test("a run id is shortened so it can still be matched back to its run", () => {
  const sessionShortId = evaluateClientFunction("sessionShortId", ["display"], { shortenIdentifier });
  const observed = "live-ui-regression";
  assert.equal(sessionShortId({ runId: observed }), observed, "this run id fits the budget and must be shown intact");
  assert.notEqual(sessionShortId({ runId: observed }), "GRESSION", "a fixed tail slice named no run at all");
  assert.equal(sessionShortId({}), "", "a session without a run id renders nothing, not a placeholder");
  const long = "meta-2026-08-30t21-55-12-985z-a1b2c3d4";
  const short = sessionShortId({ runId: long });
  assert.ok(short.length < long.length, "negative control: a long id must actually shorten");
  assert.ok(long.startsWith(short.slice(0, displayFormat.identifierShortForm.headChars)), "the head must come from the id");
  assert.ok(long.endsWith(short.slice(-displayFormat.identifierShortForm.tailChars)), "the tail must come from the id");
});

test("no run identifier is truncated by a fixed slice anywhere in the bundle", () => {
  for (const line of clientScript.split("\n")) {
    if (!/\.slice\(-/u.test(line)) continue;
    assert.doesNotMatch(
      line,
      /run\.id|runId|\brunIdentifier\b/u,
      `a fixed tail slice on a run id produced the unmatchable "GRESSION": ${line.trim()}`,
    );
  }
});

test("inspector facts compose the configured placeholder rather than a hardcoded glyph", () => {
  const labeledFact = evaluateClientFunction("labeledFact", ["display"]);
  const placeholder = displayFormat.emptyPlaceholder;
  assert.equal(labeledFact("Status", ""), `Status · ${placeholder}`);
  assert.equal(labeledFact("Status", null), `Status · ${placeholder}`);
  assert.equal(labeledFact("Tokens", 0), "Tokens · 0", "zero is a value, not an absence");
  assert.equal(labeledFact("Owner", "meta-warden"), "Owner · meta-warden");
});

test("the translation dictionary no longer hardcodes the placeholder glyph", () => {
  // The window must start at the dictionary itself: the bundle head also carries
  // the inlined display-format literal, which legitimately contains the glyph.
  const dictionaryStart = clientScript.indexOf("const zhText = new Map(");
  const dictionaryEnd = clientScript.indexOf("let currentLanguage", dictionaryStart);
  assert.notEqual(dictionaryStart, -1, "harness sanity: the translation dictionary must be recoverable");
  assert.ok(dictionaryEnd > dictionaryStart, "harness sanity: the dictionary must precede the language selector");
  const dictionary = clientScript.slice(dictionaryStart, dictionaryEnd);
  assert.ok(
    dictionary.includes('"Handoff": "移交"'),
    "harness sanity: the window must actually contain dictionary entries",
  );
  assert.equal(
    dictionary.includes(displayFormat.emptyPlaceholder),
    false,
    "a composite key baking in the glyph stops matching the moment the glyph is reconfigured",
  );
  for (const prefix of ["Status", "Owner", "Runtime", "Model", "Duration", "Tools", "Tokens", "Loadout"]) {
    assert.ok(
      clientScript.includes(`text.startsWith("${prefix} · ")`),
      `${prefix} facts must translate by prefix so the value stays out of the dictionary`,
    );
  }
});

test("a value carrying no information is filtered by the configured sentinel list", () => {
  const usefulNodeMeta = evaluateClientFunction("usefulNodeMeta", ["display"]);
  assert.equal(usefulNodeMeta(displayFormat.emptyPlaceholder), false, "the placeholder is not an observed fact");
  for (const sentinel of displayFormat.nonInformativeValues) {
    assert.equal(usefulNodeMeta(sentinel), false, `${sentinel} is configured as carrying no information`);
    assert.equal(usefulNodeMeta(sentinel.toUpperCase()), false, "the comparison must be case-folded");
  }
  for (const absent of [null, undefined, "", "   "]) {
    assert.equal(usefulNodeMeta(absent), false);
  }
  assert.equal(usefulNodeMeta("meta-conductor"), true, "positive control: a real owner is a fact");
});

test("the pre-hydration shell shows the same placeholder the client will render", () => {
  const shell = html.slice(html.indexOf("<body"));
  const placeholder = displayFormat.emptyPlaceholder;
  assert.ok(shell.includes(placeholder), "the first paint must show honest empty slots, not blank boxes");
  assert.equal(
    shell.includes("${EMPTY_PLACEHOLDER}"),
    false,
    "an unresolved interpolation would ship the variable name to the reader",
  );
  const inspectorFacts = shell.match(/data-live-selected-node-status>([^<]*)</u);
  assert.ok(inspectorFacts, "the inspector status slot must exist before hydration");
  assert.ok(
    inspectorFacts[1].endsWith(placeholder),
    "the shell fact and the hydrated fact must agree on what an empty slot looks like",
  );
});

test("every stylesheet the module declares is actually injected into the page", () => {
  const backtick = String.fromCharCode(96);
  const source = readFileSync(new URL("../../src/presentation/live/live-control-room-page.mjs", import.meta.url), "utf8");
  const declared = Array.from(source.matchAll(/^const (\w+_CSS) = String\.raw/gmu)).map((match) => match[1]);
  assert.ok(declared.length > 0, "harness sanity: the module must declare at least one stylesheet");
  const unreferenced = declared.filter((name) => !source.includes(String.fromCharCode(36) + "{" + name + "}"));
  assert.deepEqual(
    unreferenced,
    [],
    "a declared-but-never-injected stylesheet is dead weight that still reads as though it shipped",
  );
  assert.ok(
    source.includes("<style>" + String.fromCharCode(36) + "{" + declared[0] + "}</style>"),
    "positive control: the declared stylesheet must reach the document, not only be mentioned",
  );
  assert.equal(
    source.includes("const PAGE_CSS = String.raw" + backtick),
    false,
    "the superseded pre-canvas stylesheets were removed; reintroducing one revives 424 lines of unreachable CSS",
  );
});

test("an absent timestamp formats to nothing instead of to a placeholder", () => {
  const formatTime = evaluateClientFunction("formatTime", ["display"]);
  for (const absent of [null, undefined, ""]) {
    assert.equal(formatTime(absent), "", "a row with no observed time must not claim one");
  }
  const formatted = formatTime("2026-08-30T22:22:08.349Z");
  assert.notEqual(formatted, "", "positive control: a real timestamp must still format");
  assert.notEqual(formatted, displayFormat.emptyPlaceholder);
});

test("a time element is only created where an observed timestamp exists", () => {
  assert.ok(
    clientScript.includes("function appendObservedTime"),
    "one helper must own the decision to render a time element",
  );
  const timeElements = clientScript.match(/makeElement\(\s*"time"/gu) || [];
  assert.equal(
    timeElements.length,
    1,
    "an empty time element carries no machine-readable value, so only the guarded helper may create one",
  );
  assert.match(
    clientScript,
    /element\.dateTime = parsed\.toISOString\(\)/u,
    "a rendered time must carry its machine-readable value, not only localised text",
  );
});

test("no snapshot field is concatenated straight into a class name or dataset value", () => {
  assert.equal(
    clientScript.includes('history-" + item.kind'),
    false,
    'a null kind produced the literal class "history-null" and the dataset value "null"',
  );
  assert.equal(
    clientScript.includes("item.kind + \" · \" + item.label"),
    false,
    'a null kind produced the heading "null · Worker evidence 1"',
  );
  assert.match(
    clientScript,
    /const kindText = display\(item\.kind, ""\)/u,
    "positive control: the kind must be resolved through display before it is composed",
  );
});

test("no comment inside the client-script template quotes code with a backtick", () => {
  const backtick = String.fromCharCode(96);
  const interpolation = String.fromCharCode(36) + "{";
  const source = readFileSync(new URL("../../src/presentation/live/live-control-room-page.mjs", import.meta.url), "utf8");
  const open = source.indexOf("const CLIENT_SCRIPT = String.raw");
  // The template body contains nested IIFEs, so the first "})();" is not the end
  // of it. Only the column-zero close followed by the template quote is.
  const close = source.indexOf("\n})();" + backtick + ";", open);
  assert.ok(open > 0 && close > open, "harness sanity: the client-script template must be locatable");
  const region = source.slice(open, close);
  assert.ok(
    region.includes("function appendObservedTime"),
    "harness sanity: the region must reach the end of the template, not stop at a nested IIFE",
  );

  const offenders = (text) => text.split("\n").reduce((found, line, index) => {
    const comment = line.trimStart();
    const isComment = comment.startsWith("//") || comment.startsWith("*") || comment.startsWith("/*");
    if (isComment && (comment.includes(backtick) || comment.includes(interpolation))) found.push(index + 1);
    return found;
  }, []);

  const anchor = region.indexOf("\n  //");
  assert.notEqual(anchor, -1, "harness sanity: the region must contain at least one comment to plant into");
  const planted = region.slice(0, anchor) + "\n  // " + backtick + "x" + backtick + region.slice(anchor);
  assert.deepEqual(offenders(planted).length, 1, "harness sanity: the detector must catch a planted backtick");

  assert.deepEqual(
    offenders(region),
    [],
    "a backtick in a comment closes the String.raw template and breaks the module at parse time",
  );
});
