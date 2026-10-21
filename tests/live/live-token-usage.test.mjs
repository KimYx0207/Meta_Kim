import assert from "node:assert/strict";
import test from "node:test";

import {
  formatLiveTokenCount,
  normalizeLiveTokenUsage,
  serializeLiveTokenUsageResolvers,
  summarizeLiveTokenCoverage,
} from "../../src/presentation/live/live-token-usage.mjs";

const unknownUsage = { inputTokens: null, outputTokens: null, totalTokens: null };
const invalidCounts = [undefined, null, "", " ", false, true, "0", "12", -1, 1.5,
  NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, 0n, {}, [], new Number(0)];

test("unknown and invalid usage values never become measured zero", () => {
  for (const value of invalidCounts) {
    assert.deepEqual(normalizeLiveTokenUsage({ inputTokens: value, outputTokens: value, totalTokens: value }), unknownUsage);
  }
  for (const record of [undefined, null, false, 0, "", [], {}]) {
    assert.deepEqual(normalizeLiveTokenUsage(record), unknownUsage);
  }
  const mustNotCoerce = { valueOf() { throw new Error("usage must not invoke coercion"); } };
  assert.deepEqual(normalizeLiveTokenUsage({ outputTokens: mustNotCoerce }), unknownUsage);
});

test("zero and positive safe integers are retained without inventing totals", () => {
  assert.deepEqual(normalizeLiveTokenUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }), {
    inputTokens: 0, outputTokens: 0, totalTokens: 0,
  });
  assert.deepEqual(normalizeLiveTokenUsage({ inputTokens: 12, outputTokens: 34, totalTokens: 100 }), {
    inputTokens: 12, outputTokens: 34, totalTokens: 100,
  }, "an observed total is preserved rather than reconciled with the parts");
  assert.deepEqual(normalizeLiveTokenUsage({ inputTokens: 12, outputTokens: 34 }), {
    inputTokens: 12, outputTokens: 34, totalTokens: null,
  }, "even both parts do not prove an observed total");
  assert.deepEqual(normalizeLiveTokenUsage({ outputTokens: 34, cachedTokens: 5, reasoningTokens: 8 }), {
    inputTokens: null, outputTokens: 34, totalTokens: null,
  }, "subsets never become extra usage or a total");
  assert.equal(normalizeLiveTokenUsage({ inputTokens: Number.MAX_SAFE_INTEGER }).inputTokens, Number.MAX_SAFE_INTEGER);
  assert.equal(Object.is(normalizeLiveTokenUsage({ outputTokens: -0 }).outputTokens, -0), false);
});

test("legacy scalar output aliases preserve zero and respect explicit field precedence", () => {
  for (const alias of ["tokens", "tokenCount"]) {
    for (const value of [0, 42]) {
      assert.deepEqual(normalizeLiveTokenUsage({ [alias]: value }), { ...unknownUsage, outputTokens: value });
    }
  }
  assert.equal(normalizeLiveTokenUsage({ outputTokens: 0, tokens: 42, tokenCount: 90 }).outputTokens, 0);
  assert.equal(normalizeLiveTokenUsage({ outputTokens: null, tokens: 0, tokenCount: 90 }).outputTokens, 0);
  assert.equal(normalizeLiveTokenUsage({ outputTokens: "", tokenCount: 42 }).outputTokens, 42);
  assert.equal(normalizeLiveTokenUsage({ outputTokens: -1, tokenCount: 42 }).outputTokens, null);
  for (const tokens of [{ input: 12, output: 34, total: 46 }, { state: "observed", value: 34 }, "34", false]) {
    assert.deepEqual(normalizeLiveTokenUsage({ tokens }), unknownUsage, "a token container or invalid alias is not output usage");
  }
});

test("coverage distinguishes any-field measurements from field-specific partial coverage", () => {
  const coverage = summarizeLiveTokenCoverage([
    { inputTokens: 0 },
    { outputTokens: 25 },
    { totalTokens: 50 },
    { outputTokens: 0, totalTokens: 0 },
    {},
    { inputTokens: null, outputTokens: NaN },
  ]);
  assert.deepEqual(coverage, {
    nodeCount: 6, measuredNodeCount: 4, unknownNodeCount: 2,
    inputMeasuredNodeCount: 1, outputMeasuredNodeCount: 2, totalMeasuredNodeCount: 2,
  });
});

test("empty or malformed scoped nodes remain unmeasured", () => {
  const emptyCoverage = {
    nodeCount: 0, measuredNodeCount: 0, unknownNodeCount: 0,
    inputMeasuredNodeCount: 0, outputMeasuredNodeCount: 0, totalMeasuredNodeCount: 0,
  };
  for (const nodes of [undefined, null, {}, "nodes", []]) assert.deepEqual(summarizeLiveTokenCoverage(nodes), emptyCoverage);
  assert.deepEqual(summarizeLiveTokenCoverage([null, false, {}]), {
    ...emptyCoverage, nodeCount: 3, unknownNodeCount: 3,
  });
});

test("snapshot refresh is stateless, idempotent and does not mutate its source", () => {
  const node = Object.freeze({ inputTokens: 10, outputTokens: 0, totalTokens: null });
  const snapshot = Object.freeze([node, Object.freeze({})]);
  const expectedUsage = { inputTokens: 10, outputTokens: 0, totalTokens: null };
  const expectedCoverage = {
    nodeCount: 2, measuredNodeCount: 1, unknownNodeCount: 1,
    inputMeasuredNodeCount: 1, outputMeasuredNodeCount: 1, totalMeasuredNodeCount: 0,
  };
  for (let refresh = 0; refresh < 3; refresh += 1) {
    assert.deepEqual(normalizeLiveTokenUsage(node), expectedUsage);
    assert.deepEqual(normalizeLiveTokenUsage(normalizeLiveTokenUsage(node)), expectedUsage);
    assert.deepEqual(summarizeLiveTokenCoverage(snapshot), expectedCoverage);
  }
  assert.deepEqual(summarizeLiveTokenCoverage([{}]), {
    nodeCount: 1, measuredNodeCount: 0, unknownNodeCount: 1,
    inputMeasuredNodeCount: 0, outputMeasuredNodeCount: 0, totalMeasuredNodeCount: 0,
  }, "another snapshot cannot inherit measurements from a previous render");
  assert.deepEqual(node, expectedUsage);
});

test("formatting exposes unknown values and measured zero in both page languages", () => {
  assert.equal(formatLiveTokenCount(0), "0");
  assert.equal(formatLiveTokenCount(12345), "12,345");
  assert.equal(formatLiveTokenCount(0, "en"), "0");
  assert.equal(formatLiveTokenCount(12345, "en"), "12,345");
  for (const value of invalidCounts) {
    assert.equal(formatLiveTokenCount(value), "未计量");
    assert.equal(formatLiveTokenCount(value, "en"), "Not measured");
  }
});

test("serialized client helpers include all dependencies and match module behavior", () => {
  const source = serializeLiveTokenUsageResolvers();
  const browser = new Function(source + "\nreturn { normalizeLiveTokenUsage, summarizeLiveTokenCoverage, formatLiveTokenCount };")();
  const records = [null, {}, { inputTokens: 0 }, { outputTokens: 42 }, { totalTokens: 99 },
    { tokens: 0 }, { tokenCount: 34 }, { outputTokens: null, tokens: { total: 55 } },
    ...invalidCounts.map((value) => ({ inputTokens: value, outputTokens: value, totalTokens: value }))];
  for (const record of records) assert.deepEqual(browser.normalizeLiveTokenUsage(record), normalizeLiveTokenUsage(record));
  for (const recordsInSnapshot of [[], records, records.slice(0, 4), records]) {
    assert.deepEqual(browser.summarizeLiveTokenCoverage(recordsInSnapshot), summarizeLiveTokenCoverage(recordsInSnapshot));
  }
  for (const language of ["zh", "en"]) {
    for (const value of [0, 12345, Number.MAX_SAFE_INTEGER, ...invalidCounts]) {
      assert.equal(browser.formatLiveTokenCount(value, language), formatLiveTokenCount(value, language));
    }
  }
});
