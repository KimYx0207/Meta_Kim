import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The control-room page is one JS module holding an entire HTML document, a
 * stylesheet, and a client script inside `String.raw` template literals. A
 * backtick typed anywhere inside one of those spans -- in a nested template, in
 * an example, or in a JSDoc comment quoting an identifier -- ends the template
 * early, and everything the author meant as text becomes JavaScript. The module
 * then fails to parse, so every test that imports it dies at import time with a
 * syntax error pointing at whatever token happened to follow.
 *
 * That has now happened three times, each time costing diagnosis rather than
 * correctness. This file reads the module as TEXT and never imports it, so it
 * still runs when the module cannot be parsed, and it names the offending line
 * instead of leaving a stack trace to interpret.
 */
const PAGE_PATH = fileURLToPath(new URL("../../src/presentation/live/live-control-room-page.mjs", import.meta.url));
const BACKTICK = String.fromCharCode(96);

/** The spans that must stay pure text, in source order. */
const REQUIRED_SPANS = Object.freeze(["CLIENT_SCRIPT", "GRAPH_FIRST_CSS"]);

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

/**
 * Locate every `const NAME = String.raw` span and where its template closes.
 *
 * The closer is taken as the next backtick, which is the whole point: if a stray
 * backtick sits inside the intended span, this finds THAT one, and the text
 * after it will not look like the end of a statement.
 */
function readRawSpans(source) {
  const spans = [];
  const opener = /const\s+([A-Z_][A-Z0-9_]*)\s*=\s*String\.raw/gu;
  for (let match = opener.exec(source); match; match = opener.exec(source)) {
    const start = source.indexOf(BACKTICK, match.index + match[0].length);
    assert.notEqual(start, -1, `${match[1]} declares String.raw with no template literal after it`);
    const close = source.indexOf(BACKTICK, start + 1);
    spans.push({ name: match[1], start, close });
  }
  return spans;
}

test("every inlined template closes at a statement boundary, so no stray backtick can end it early", () => {
  const source = readFileSync(PAGE_PATH, "utf8");
  const spans = readRawSpans(source);

  assert.deepEqual(
    spans.map((span) => span.name),
    REQUIRED_SPANS,
    "the guard must find the spans it claims to protect, otherwise it passes by scanning nothing",
  );

  for (const span of spans) {
    assert.notEqual(span.close, -1, `${span.name} template is never closed`);
    const tail = source.slice(span.close + 1, span.close + 12);
    assert.match(
      tail,
      /^\s*;/u,
      `${span.name} ends at line ${lineOf(source, span.close)} followed by ${JSON.stringify(tail)} instead of `
        + `a semicolon. A backtick inside the span ended it there -- remove it and quote identifiers without backticks`,
    );
  }
});

test("the inlined spans contain no escaped backtick either, because String.raw keeps the backslash", () => {
  const source = readFileSync(PAGE_PATH, "utf8");

  for (const span of readRawSpans(source)) {
    const body = source.slice(span.start + 1, span.close);
    const escaped = body.indexOf(`\\${BACKTICK}`);
    assert.equal(
      escaped,
      -1,
      `${span.name} escapes a backtick at line ${lineOf(source, span.start + 1 + escaped)}. In String.raw the `
        + "backslash survives into the output, so the escape is both a lie to the reader and live text in the page",
    );
  }
});
