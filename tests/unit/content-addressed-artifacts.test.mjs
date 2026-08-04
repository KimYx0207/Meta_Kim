import assert from "node:assert/strict";
import { test } from "node:test";

import {
  contentDigest,
  deduplicateContentAddressedRecords,
  findReusableContentAddressedArtifact,
  stableSerialize,
} from "../../scripts/content-addressed-artifacts.mjs";

test("content addresses are stable across object key order", () => {
  assert.equal(stableSerialize({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(contentDigest({ b: 2, a: 1 }), contentDigest({ a: 1, b: 2 }));
  assert.notEqual(contentDigest({ a: 1, b: 2 }), contentDigest({ a: 1, b: 3 }));
});

test("reuses only a complete, available artifact for the exact input", () => {
  const inputDigest = contentDigest({ request: "same input" });
  const records = [
    { inputDigest, contentDigest: "artifact-a", outputPath: "missing.bin", status: "complete" },
    { inputDigest, contentDigest: "artifact-b", outputPath: "available.bin", status: "complete" },
    { inputDigest, contentDigest: "artifact-c", outputPath: "partial.bin", status: "writing" },
  ];
  const checkedPaths = [];
  const reused = findReusableContentAddressedArtifact(records, {
    inputDigest,
    isAvailable: (filePath) => {
      checkedPaths.push(filePath);
      return filePath === "available.bin";
    },
  });

  assert.equal(reused.outputPath, "available.bin");
  assert.equal(reused.reused, true);
  assert.deepEqual(checkedPaths, ["missing.bin", "available.bin"]);
  assert.equal(findReusableContentAddressedArtifact(records, {
    inputDigest: contentDigest({ request: "different input" }),
    isAvailable: () => true,
  }), null);
});

test("deduplicates exact metadata without deleting or copying payloads", () => {
  const duplicate = { inputDigest: "input", contentDigest: "artifact", outputPath: "bundle.bin", status: "complete" };
  const conflicting = { ...duplicate, outputPath: "different.bin" };
  const result = deduplicateContentAddressedRecords([duplicate, { ...duplicate }, conflicting]);

  assert.deepEqual(result, [duplicate, conflicting]);
});

