import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  analyzeGraphSemanticCoverage,
  GRAPHIFY_SEMANTIC_DIAGNOSTICS_SCHEMA,
  writeGraphSemanticCoverageArtifact,
} from "../../scripts/graphify-semantic-diagnostics.mjs";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

test("semantic coverage reports deterministic manifest zero-node sources without creating placeholders", () => {
  const graph = deepFreeze({
    nodes: [
      {
        id: "scripts_real",
        label: "misleading-owner-label",
        source_file: "scripts/real.mjs",
      },
      {
        id: "legacy_placeholder",
        label: "missing.mjs",
        source_file: "missing.mjs",
        identityOnly: true,
      },
    ],
    links: [],
  });
  const manifest = {
    "missing.mjs": {},
    "scripts/real.mjs": {},
    "config/missing.json": {},
    "assets/logo.png": {},
  };
  const result = analyzeGraphSemanticCoverage(graph, {
    manifest,
    releaseSafeIdentity: true,
    freshnessVerified: true,
  });

  assert.equal(result.schemaVersion, GRAPHIFY_SEMANTIC_DIAGNOSTICS_SCHEMA);
  assert.equal(result.status, "degraded_navigation");
  assert.equal(result.releaseSafeIdentity, true);
  assert.equal(result.freshnessVerified, true);
  assert.equal(result.semanticCompleteness, "degraded");
  assert.equal(result.evidence.manifestSourceCount, 4);
  assert.deepEqual(result.evidence.manifestSources, [
    "assets/logo.png",
    "config/missing.json",
    "missing.mjs",
    "scripts/real.mjs",
  ]);
  assert.match(result.evidence.manifestSourceDigest, /^[a-f0-9]{64}$/u);
  assert.equal(result.evidence.graphSourceCount, 1);
  assert.deepEqual(result.evidence.zeroNodeSources, [
    "assets/logo.png",
    "config/missing.json",
    "missing.mjs",
  ]);
  assert.deepEqual(result.evidence.expectedNonGraphSources, [
    "assets/logo.png",
    "config/missing.json",
  ]);
  assert.deepEqual(result.evidence.unexpectedZeroNodeSources, ["missing.mjs"]);
  assert.equal(result.evidence.zeroNodeSourceCount, 3);
  assert.match(result.evidence.zeroNodeSourceDigest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(result.sourceAnchorFallback, [
    {
      source_file: "missing.mjs",
      source_location: null,
      anchorType: "manifest_source",
      noOwnerInference: true,
    },
  ]);
  assert.deepEqual(result.expectedNonGraphSourceAnchorFallback, [
    {
      source_file: "assets/logo.png",
      source_location: null,
      anchorType: "expected_non_graph_source",
      noOwnerInference: true,
    },
    {
      source_file: "config/missing.json",
      source_location: null,
      anchorType: "expected_non_graph_source",
      noOwnerInference: true,
    },
  ]);
  assert.equal(result.noOwnerInference, true);
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.nodes[1].identityOnly, true);
});

test("missing manifest is explicit diagnostic_unavailable rather than complete coverage", () => {
  const result = analyzeGraphSemanticCoverage(
    { nodes: [{ id: "present", source_file: "present.mjs" }], links: [] },
    { releaseSafeIdentity: true, freshnessVerified: true },
  );
  assert.equal(result.status, "diagnostic_unavailable");
  assert.equal(result.diagnosticAvailable, false);
  assert.equal(result.diagnosticReason, "manifest_missing");
  assert.equal(result.semanticCompleteness, "unknown");
});

test("semantic coverage proves sanitizer collisions only from raw IDs and normalizer evidence", () => {
  const result = analyzeGraphSemanticCoverage(
    {
      nodes: [
        {
          id: "Foo",
          label: "owner-a",
          source_file: "a/Foo.mjs",
        },
        {
          id: "foo",
          label: "owner-b",
          source_file: "b/foo.mjs",
        },
      ],
      links: [],
    },
    {
      manifestSources: ["a/Foo.mjs", "b/foo.mjs"],
      releaseSafeIdentity: true,
      freshnessVerified: true,
    },
  );

  assert.equal(result.status, "degraded_navigation");
  assert.equal(result.evidence.semanticIdCollisionCount, 1);
  assert.deepEqual(result.evidence.semanticIdCollisions, [
    {
      canonicalId: "foo",
      kind: "sanitizer_collision",
      rawIds: ["Foo", "foo"],
      nodeIndexes: [0, 1],
      sourceFiles: ["a/Foo.mjs", "b/foo.mjs"],
      evidence: "raw_id_and_normalizer",
      noOwnerInference: true,
    },
  ]);
  assert.equal(result.noOwnerInference, true);
  assert.deepEqual(result.sourceAnchorFallback, []);
});

test("duplicate raw IDs are separate evidence and do not become semantic collisions", () => {
  const result = analyzeGraphSemanticCoverage(
    {
      nodes: [
        { id: "same", source_file: "a.mjs" },
        { id: "same", source_file: "b.mjs" },
        { id: "Foo", source_file: "same-source.mjs" },
        { id: "foo", source_file: "same-source.mjs" },
      ],
      links: [],
    },
    {
      manifestSources: ["a.mjs", "b.mjs", "same-source.mjs"],
      releaseSafeIdentity: true,
      freshnessVerified: true,
    },
  );
  assert.equal(result.evidence.duplicateRawIdCount, 1);
  assert.equal(result.evidence.semanticIdCollisionCount, 0);
  assert.equal(result.semanticCompleteness, "complete");
  assert.equal(result.status, "verified_navigation");
});

test("semantic completeness does not masquerade as release-safe navigation when identity or freshness fails", () => {
  const result = analyzeGraphSemanticCoverage(
    { nodes: [{ id: "present", source_file: "present.mjs" }], links: [] },
    {
      manifestSources: ["present.mjs", "missing.mjs"],
      releaseSafeIdentity: false,
      freshnessVerified: true,
    },
  );

  assert.equal(result.status, "semantic_completeness_degraded");
  assert.equal(result.releaseSafeIdentity, false);
  assert.equal(result.freshnessVerified, true);
  assert.equal(result.semanticCompletenessDegraded, true);
});

test("semantic coverage remains stable for equivalent manifest key order and complete sources", () => {
  const graph = {
    nodes: [
      { id: "a", source_file: "a.mjs" },
      { id: "b", source_file: "b.mjs" },
    ],
    links: [],
  };
  const first = analyzeGraphSemanticCoverage(graph, {
    manifest: { "b.mjs": {}, "a.mjs": {} },
    releaseSafeIdentity: true,
    freshnessVerified: true,
  });
  const second = analyzeGraphSemanticCoverage(graph, {
    manifest: { "a.mjs": {}, "b.mjs": {} },
    releaseSafeIdentity: true,
    freshnessVerified: true,
  });

  assert.equal(first.status, "verified_navigation");
  assert.equal(first.evidence.zeroNodeSourceCount, 0);
  assert.deepEqual(first, second);
});

test("diagnostic artifact is complete, bound, contained, and atomically replaceable", () => {
  const outputDir = mkdtempSync(path.join(tmpdir(), "meta-kim-graphify-diagnostics-"));
  try {
    const diagnostics = analyzeGraphSemanticCoverage(
      { nodes: [{ id: "a", source_file: "a.mjs" }], links: [] },
      {
        manifestSources: ["a.mjs"],
        releaseSafeIdentity: true,
        freshnessVerified: true,
      },
    );
    const first = writeGraphSemanticCoverageArtifact({
      outputDir,
      diagnostics,
      binding: {
        builtAtCommit: "a".repeat(40),
        graphIdentityProofDigest: "b".repeat(64),
        graphReportSha256: "c".repeat(64),
      },
    });
    assert.equal(first.changed, true);
    assert.equal(existsSync(first.artifactPath), true);
    const artifact = JSON.parse(readFileSync(first.artifactPath, "utf8"));
    assert.equal(artifact.binding.builtAtCommit, "a".repeat(40));
    assert.equal(artifact.binding.graphIdentityProofDigest, "b".repeat(64));
    assert.equal(artifact.binding.graphReportSha256, "c".repeat(64));
    assert.equal(artifact.diagnostics.evidence.zeroNodeSourceDigest.length, 64);
    const second = writeGraphSemanticCoverageArtifact({
      outputDir,
      diagnostics,
      binding: first.binding,
    });
    assert.equal(second.changed, false);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
