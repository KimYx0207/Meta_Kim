/**
 * Empty-graph copy has to name the measured cause.
 *
 * Measured against the running hub, 92 of 113 visible sessions opened with zero
 * task nodes and every one of them printed the same sentence, "No task nodes in
 * this snapshot." The server already separates the causes: 80 of those rows were
 * activation receipts with no governed artifact, and 12 had an artifact that
 * declared no nodes. One sentence for both tells a reader the graph is empty
 * without telling them whether anything is wrong, which is the reading that
 * produced the report that "a pile of sessions all have a single node".
 *
 * The assertions pin the reason vocabulary to one exported source and require
 * distinct, translated copy for every value the snapshot service can emit, so a
 * newly added reason cannot quietly fall back to the generic sentence.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { LIVE_GRAPH_AVAILABILITY_REASONS } from "../../src/application/live/live-control-room-service.mjs";
import { renderLiveControlRoomPage } from "../../src/presentation/live/live-control-room-page.mjs";

const SERVICE_SOURCE = readFileSync(
  new URL("../../src/application/live/live-control-room-service.mjs", import.meta.url),
  "utf8",
);

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

const clientScript = inlineScriptBodies(html).find((body) => body.includes("function graphEmptyReason"));
assert.ok(clientScript, "the shipped page must still contain the graph renderer script");

/** Slice a top-level client-script function by name. */
function extractFunction(name) {
  const header = `\n  function ${name}(`;
  const start = clientScript.indexOf(header);
  assert.notEqual(start, -1, `${name} must remain in the shipped client script`);
  const end = clientScript.indexOf("\n  }", start);
  assert.notEqual(end, -1, `${name} must be a top-level client-script function`);
  return clientScript.slice(start + 1, end + 4);
}

/** Evaluate an object literal the page embeds as a client-script constant. */
function extractObjectLiteral(name) {
  const header = `\n  const ${name} = `;
  const start = clientScript.indexOf(header);
  assert.notEqual(start, -1, `${name} must be embedded in the shipped client script`);
  const valueStart = start + header.length;
  const end = clientScript.indexOf(";", valueStart);
  assert.notEqual(end, -1, `${name} must be a terminated client-script declaration`);
  return new Function(`return ${clientScript.slice(valueStart, end)};`)();
}

/**
 * Read the shipped Chinese dictionary without changing its shape. The display
 * contract guards the dictionary by slicing the same window, so this test reads
 * it rather than asking the page to expose it under a new name.
 */
function extractZhDictionary() {
  const header = "\n  const zhText = new Map(Object.entries(";
  const start = clientScript.indexOf(header);
  assert.notEqual(start, -1, "the shipped page must still carry an inline Chinese dictionary");
  const valueStart = start + header.length;
  const end = clientScript.indexOf("\n  }));", valueStart);
  assert.notEqual(end, -1, "the Chinese dictionary must remain a terminated object literal");
  return new Function(`return ${clientScript.slice(valueStart, end + 4)};`)();
}

const reasonCopy = extractObjectLiteral("GRAPH_EMPTY_REASON_TEXT");
const zhText = extractZhDictionary();

const graphEmptyReason = new Function(
  "GRAPH_EMPTY_REASON_TEXT",
  `${extractFunction("graphEmptyReason")}\nreturn graphEmptyReason;`,
)(reasonCopy);

const reasonValues = Object.values(LIVE_GRAPH_AVAILABILITY_REASONS);

test("the reason vocabulary is a non-trivial exported set", () => {
  assert.ok(reasonValues.length >= 3, "the service emits at least three distinct empty-graph reasons");
  assert.equal(new Set(reasonValues).size, reasonValues.length, "reason values must be unique");
  for (const value of reasonValues) {
    assert.match(value, /^[a-z][a-z_]+$/u, `reason ${value} must stay a snake_case state name`);
  }
});

test("every reason the service can emit gets its own sentence", () => {
  const generic = graphEmptyReason({});
  const sentences = new Map();
  for (const reason of reasonValues) {
    const sentence = graphEmptyReason({ graphAvailability: { reason } });
    assert.notEqual(
      sentence,
      generic,
      `reason ${reason} still falls back to the generic sentence, so the page cannot tell a reader why the graph is empty`,
    );
    assert.ok(sentence.length > 20, `reason ${reason} needs copy that states the cause`);
    const collision = sentences.get(sentence);
    assert.equal(
      collision,
      undefined,
      `reasons ${collision} and ${reason} print the same sentence, so they are indistinguishable on screen`,
    );
    sentences.set(sentence, reason);
  }
});

test("every empty-graph sentence is translated", () => {
  const sentences = [
    graphEmptyReason({}),
    graphEmptyReason({ truncated: { applied: true } }),
    graphEmptyReason({ run: { executionEvidenceState: "structural_planning_only" } }),
    ...reasonValues.map((reason) => graphEmptyReason({ graphAvailability: { reason } })),
  ];
  for (const sentence of sentences) {
    const translated = zhText[sentence];
    assert.ok(
      typeof translated === "string" && translated.trim(),
      `"${sentence}" has no Chinese entry, so a Chinese reader silently gets the English string`,
    );
    assert.notEqual(translated, sentence, `"${sentence}" must not be translated to itself`);
  }
});

test("an actionable cause still outranks the run's own state", () => {
  const truncatedAndEmpty = graphEmptyReason({
    truncated: { applied: true },
    run: { executionEvidenceState: "structural_planning_only" },
    graphAvailability: { reason: LIVE_GRAPH_AVAILABILITY_REASONS.artifactDeclaredNoNodes },
  });
  assert.equal(truncatedAndEmpty, graphEmptyReason({ truncated: { applied: true } }));

  const structuralAndEmpty = graphEmptyReason({
    run: { executionEvidenceState: "structural_planning_only" },
    graphAvailability: { reason: LIVE_GRAPH_AVAILABILITY_REASONS.artifactDeclaredNoNodes },
  });
  assert.equal(
    structuralAndEmpty,
    graphEmptyReason({ run: { executionEvidenceState: "structural_planning_only" } }),
  );
});

test("an unknown reason keeps a total function instead of throwing or printing a state name", () => {
  for (const input of [undefined, null, {}, { graphAvailability: null }, { graphAvailability: { reason: "invented_state" } }]) {
    const sentence = graphEmptyReason(input);
    assert.ok(typeof sentence === "string" && sentence.trim(), "the empty-graph copy must always be printable");
    assert.doesNotMatch(sentence, /_/u, "raw state names must never reach the screen");
  }
});

test("the service routes every graph reason through the exported vocabulary", () => {
  const blocks = [];
  let cursor = 0;
  for (;;) {
    const open = SERVICE_SOURCE.indexOf("graphAvailability: {", cursor);
    if (open === -1) break;
    const close = SERVICE_SOURCE.indexOf("\n    }", open);
    assert.notEqual(close, -1, "each graphAvailability block must be terminated");
    blocks.push(SERVICE_SOURCE.slice(open, close));
    cursor = close;
  }
  assert.ok(blocks.length >= 3, "the service still builds at least three graphAvailability envelopes");

  for (const block of blocks) {
    const literals = block.match(/reason:\s*"[^"]*"/gu) || [];
    assert.deepEqual(
      literals,
      [],
      `a bare reason literal (${literals.join(", ")}) bypasses LIVE_GRAPH_AVAILABILITY_REASONS, so the page cannot be forced to carry copy for it`,
    );
    assert.match(
      block,
      /reason:[^\n]*(LIVE_GRAPH_AVAILABILITY_REASONS|null)/u,
      "each graphAvailability block must name its reason through the exported vocabulary",
    );
  }
});
