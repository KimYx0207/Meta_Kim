import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  applyGraphNodeIdentityProof,
  analyzeGraphNodeIdentity,
  disambiguateGraphFileNodeLabels,
  ensureSameNameFileIdentityNodes,
  GRAPH_NODE_IDENTITY_SCHEMA,
  validateGraphNodeIdentity,
} from "../../scripts/graphify-node-identity.mjs";
import {
  createGraphifyRuntimeNormalizer,
  GRAPHIFY_NODE_ID_NORMALIZATION,
  normalizeGraphifyNodeId,
} from "../../scripts/graphify-unicode-normalize.mjs";

const repositoryFiles = [
  "canonical/runtime-assets/codex/hooks.json",
  "canonical/runtime-assets/cursor/hooks.json",
  "config/hooks.json",
  "scripts/other.mjs",
];

function fileNode(source, id, overrides = {}) {
  return {
    id,
    label: source.split("/").at(-1),
    source_file: source,
    source_location: "L1",
    file_type: "code",
    type: "code",
    _origin: "ast",
    ...overrides,
  };
}

function safeGraph() {
  return {
    built_at_commit: "a".repeat(40),
    nodes: [
      fileNode(repositoryFiles[0], "canonical_runtime_assets_codex_hooks"),
      fileNode(repositoryFiles[1], "canonical_runtime_assets_cursor_hooks_json"),
      fileNode(repositoryFiles[2], "config_hooks_file"),
      fileNode(repositoryFiles[3], "scripts_other"),
      { id: "global_without_source", label: "concept", type: "concept" },
    ],
    links: [],
  };
}

function prepare(graph) {
  disambiguateGraphFileNodeLabels(graph, { repositoryFiles });
  return graph;
}

describe("Graphify node identity proof v2", () => {
  test("uses real L1 file nodes, shortest-unique labels, and a replayable v2 proof", () => {
    const graph = prepare(safeGraph());
    assert.deepEqual(graph.nodes.slice(0, 3).map((node) => node.label), [
      "codex/hooks.json",
      "cursor/hooks.json",
      "config/hooks.json",
    ]);

    const applied = applyGraphNodeIdentityProof(graph, {
      repositoryFiles,
      builtCommit: graph.built_at_commit,
    });

    assert.equal(GRAPH_NODE_IDENTITY_SCHEMA, "meta-kim-graph-node-identity-v2");
    assert.equal(applied.proof.status, "verified_graph_file_identity");
    assert.equal(applied.proof.coveredSameNameGroupCount, 1);
    assert.equal(applied.proof.coveredSameNameSourceCount, 3);
    assert.equal(applied.proof.fileNodeBindings.length, 4);
    assert.match(applied.proof.repositoryFilesSha256, /^[a-f0-9]{64}$/u);
    assert.equal(
      applied.proof.repositoryPathPolicy,
      "repository-relative-posix-case-exact-v1",
    );
    assert.equal(applied.proof.nodeIdNormalization, GRAPHIFY_NODE_ID_NORMALIZATION);
    assert.match(applied.proof.fileNodeBindingsSha256, /^[a-f0-9]{64}$/u);
    assert.equal(
      validateGraphNodeIdentity(graph, {
        repositoryFiles,
        builtCommit: graph.built_at_commit,
      }).ok,
      true,
    );
  });

  test("uses an explicit repository-root label when a root file shares a basename", () => {
    const files = ["README.md", "examples/README.md", "scripts/README.md"];
    const graph = {
      nodes: files.map((source) =>
        fileNode(source, normalizeGraphifyNodeId(source)),
      ),
      links: [],
    };

    disambiguateGraphFileNodeLabels(graph, { repositoryFiles: files });

    assert.deepEqual(graph.nodes.map((node) => node.label), [
      "./README.md",
      "examples/README.md",
      "scripts/README.md",
    ]);
    assert.equal(
      analyzeGraphNodeIdentity(graph, { repositoryFiles: files }).status,
      "verified_graph_file_identity",
    );
  });

  test("removes legacy identityOnly placeholders and never manufactures semantic coverage", () => {
    const graph = {
      nodes: [
        {
          id: "placeholder",
          label: "hooks.json",
          source_file: repositoryFiles[0],
          source_location: "L1",
          type: "file_identity",
          file_type: "file_identity",
          _origin: "meta_kim_enrichment",
          metaKimGenerated: true,
          identityOnly: true,
        },
        {
          id: "upstream-identity",
          label: "external",
          identityOnly: true,
          _origin: "upstream",
        },
      ],
      links: [{ source: "placeholder", target: "placeholder" }],
    };

    const cleanup = ensureSameNameFileIdentityNodes(graph, { repositoryFiles });
    assert.equal(cleanup.changed, true);
    assert.equal(cleanup.removed, 1);
    assert.deepEqual(graph.nodes.map((node) => node.id), ["upstream-identity"]);
    assert.deepEqual(graph.links, []);
    const result = analyzeGraphNodeIdentity(graph, { repositoryFiles });
    assert.equal(result.status, "unsafe_node_identity");
    assert.equal(result.fileIdentityCount, 0);
    assert.equal(result.missingFileIdentityCoverage, true);
    assert.equal(result.requiresUpstreamReextract, true);
    assert.equal(result.unrepresentedSameNameSources.length, 3);
  });

  test("requires every node ID to be globally unique, including same-source and source-less nodes", () => {
    for (const mutate of [
      (graph) => graph.nodes.push({ ...graph.nodes[0] }),
      (graph) => graph.nodes.push({ id: "global_without_source", label: "other" }),
    ]) {
      const graph = prepare(safeGraph());
      mutate(graph);
      const result = analyzeGraphNodeIdentity(graph, { repositoryFiles });
      assert.equal(result.status, "unsafe_node_identity");
      assert.equal(result.duplicateNodeIds.length, 1);
    }

    const missing = prepare(safeGraph());
    missing.nodes.push({ label: "no id" });
    assert.equal(analyzeGraphNodeIdentity(missing, { repositoryFiles }).missingNodeIdIndexes.length, 1);
  });

  test("uses Graphify Unicode normalization for global IDs and full source paths", () => {
    const values = [
      "脚本/工具.mjs",
      "脚本/工具",
      "CAFÉ",
      "cafe\u0301",
      "ПРИВЕТ",
      "Straße",
      "x\u{1E6D1}Y",
      "\uA7F1",
      "Foo",
      "foo",
      "é",
      "e\u0301",
      "a-b",
      "a_b",
      "甲/工具.mjs",
      "甲/工具",
      "乙/工具.mjs",
      "乙/工具",
      "mjs",
      "脚本_工具_mjs",
      "привет",
      ...repositoryFiles,
      ...repositoryFiles.map((source) => {
        const extensionIndex = source.lastIndexOf(".");
        return extensionIndex > source.lastIndexOf("/")
          ? source.slice(0, extensionIndex)
          : source;
      }),
      ...safeGraph().nodes.map((node) => node.id),
    ];
    const runtimeNormalizer = createGraphifyRuntimeNormalizer(values, {
      launcherCommand: process.platform === "win32" ? "py" : "graphify",
      pythonCandidate:
        process.platform === "win32"
          ? { command: "py", args: ["-3.14"] }
          : null,
    });
    const normalize = runtimeNormalizer.normalize;
    assert.match(
      runtimeNormalizer.descriptor,
      /^graphify-\d+\.\d+\.\d+-module-[0-9a-f]{12}-python-unicode-\d+\.\d+\.\d+-live-v2$/u,
    );
    assert.equal(normalize("脚本/工具.mjs"), "脚本_工具_mjs");
    assert.equal(normalize("CAFÉ"), "café");
    assert.equal(normalize("cafe\u0301"), "café");
    assert.equal(normalize("ПРИВЕТ"), "привет");
    assert.equal(normalize("Straße"), "strasse");
    assert.equal(normalize("x\u{1E6D1}Y"), "x_y");
    assert.equal(normalize("\uA7F1"), "");

    for (const ids of [
      ["Foo", "foo"],
      ["é", "e\u0301"],
      ["a-b", "a_b"],
    ]) {
      const graph = prepare(safeGraph());
      graph.nodes.push(
        { id: ids[0], label: "one", type: "concept" },
        { id: ids[1], label: "two", type: "concept" },
      );
      const result = analyzeGraphNodeIdentity(graph, {
        repositoryFiles,
        normalizeNodeId: normalize,
        nodeIdNormalization: runtimeNormalizer.descriptor,
      });
      assert.equal(result.status, "unsafe_node_identity");
      assert.equal(result.duplicateNodeIds.length, 1);
      assert.ok(result.invalidNodeIdIndexes.length >= 1);
    }

    const unicodeRepositoryFiles = ["脚本/工具.mjs"];
    const unicodeGraph = {
      nodes: [
        fileNode("脚本/工具.mjs", "脚本_工具_mjs"),
        { id: "привет", label: "Cyrillic concept", type: "concept" },
      ],
      links: [],
    };
    assert.equal(
      analyzeGraphNodeIdentity(unicodeGraph, {
        repositoryFiles: unicodeRepositoryFiles,
        normalizeNodeId: normalize,
        nodeIdNormalization: runtimeNormalizer.descriptor,
      }).status,
      "verified_graph_file_identity",
    );

    const collisionFiles = ["甲/工具.mjs", "乙/工具.mjs"];
    const collisionGraph = {
      nodes: collisionFiles.map((source) => fileNode(source, "mjs")),
      links: [],
    };
    const collision = analyzeGraphNodeIdentity(collisionGraph, {
      repositoryFiles: collisionFiles,
      normalizeNodeId: normalize,
      nodeIdNormalization: runtimeNormalizer.descriptor,
    });
    assert.equal(collision.status, "unsafe_node_identity");
    assert.equal(collision.duplicateNodeIds.length, 1);
    assert.equal(collision.invalidFileNodeIds.length, 2);
  });

  test("rejects stale and dangling hyperedge identity references on either truth surface", () => {
    const graph = prepare(safeGraph());
    graph.hyperedges = [{ id: "team", nodes: [graph.nodes[0].id] }];
    graph.graph = { hyperedges: structuredClone(graph.hyperedges) };
    const safe = analyzeGraphNodeIdentity(graph, { repositoryFiles });
    assert.equal(safe.status, "verified_graph_file_identity");
    assert.match(safe.hyperedgeReferencesSha256, /^[a-f0-9]{64}$/u);

    graph.graph.hyperedges[0].nodes[0] = "missing";
    const stale = analyzeGraphNodeIdentity(graph, { repositoryFiles });
    assert.equal(stale.status, "unsafe_node_identity");
    assert.equal(stale.hyperedgeSurfaceMismatch, true);
    assert.equal(stale.hyperedgeReferenceIssues.length, 1);
  });

  test("rejects absolute, parent-traversing, non-canonical, and untracked source_file values without leaking them", () => {
    const badSources = [
      "C:/private/secret.mjs",
      "/private/secret.mjs",
      "../private/secret.mjs",
      "scripts/../private/secret.mjs",
      "scripts\\private\\secret.mjs",
      "not-in-repository.mjs",
    ];
    for (const source of badSources) {
      const graph = prepare(safeGraph());
      graph.nodes.push(fileNode(source, `bad_${graph.nodes.length}`));
      const result = validateGraphNodeIdentity(graph, {
        repositoryFiles,
        requireStored: false,
      });
      assert.equal(result.ok, false, source);
      assert.doesNotMatch(result.reason, /private|secret|C:\//iu);
      assert.match(result.reason, /source_file|repository inventory/u);
    }
  });

  test("does not mistake an L1 command AST node for a real file node", () => {
    const graph = safeGraph();
    graph.nodes = graph.nodes.filter((node) => node.source_file !== repositoryFiles[0]);
    graph.nodes.push(
      fileNode(repositoryFiles[0], "mcp_command_hooks", {
        label: "hooks.json",
        type: "command",
        file_type: "command",
        command: "node",
      }),
    );
    prepare(graph);
    const result = analyzeGraphNodeIdentity(graph, { repositoryFiles });
    assert.equal(result.status, "verified_graph_file_identity");
    assert.equal(result.fileIdentityCount, 3);
    assert.deepEqual(result.unrepresentedSameNameSources, [
      { basename: "hooks.json", source: repositoryFiles[0] },
    ]);
  });

  test("accepts full-source IDs with or without extension and suffix, but rejects swapped path IDs", () => {
    const allowedIds = [
      "scripts_other",
      "scripts_other_mjs",
      "scripts_other_file",
      "scripts_other_mjs_file",
    ];
    for (const id of allowedIds) {
      const graph = prepare(safeGraph());
      graph.nodes.find((node) => node.source_file === repositoryFiles[3]).id = id;
      assert.equal(
        analyzeGraphNodeIdentity(graph, { repositoryFiles }).invalidFileNodeIds.length,
        0,
        id,
      );
    }

    const graph = prepare(safeGraph());
    const first = graph.nodes[0].id;
    graph.nodes[0].id = graph.nodes[1].id;
    graph.nodes[1].id = first;
    const result = analyzeGraphNodeIdentity(graph, { repositoryFiles });
    assert.equal(result.status, "unsafe_node_identity");
    assert.equal(result.invalidFileNodeIds.length, 2);

    const nonSameName = prepare(safeGraph());
    nonSameName.nodes.find((node) => node.source_file === repositoryFiles[3]).id =
      "config_hooks";
    const globalFileIdCheck = analyzeGraphNodeIdentity(nonSameName, { repositoryFiles });
    assert.deepEqual(globalFileIdCheck.invalidFileNodeIds, [
      { source: repositoryFiles[3], id: "config_hooks" },
    ]);
  });

  test("proof binds ordered source, IDs, labels, and type markers so stale swaps cannot pass", () => {
    const graph = prepare(safeGraph());
    applyGraphNodeIdentityProof(graph, {
      repositoryFiles,
      builtCommit: graph.built_at_commit,
    });
    const originalDigest = graph.meta_kim_enrichment.nodeIdentity.fileNodeBindingsSha256;

    graph.nodes[0].type = "document";
    graph.nodes[0].file_type = "document";
    const staleType = validateGraphNodeIdentity(graph, {
      repositoryFiles,
      builtCommit: graph.built_at_commit,
    });
    assert.equal(staleType.ok, false);
    assert.match(staleType.reason, /missing or stale/u);
    assert.notEqual(staleType.expected.fileNodeBindingsSha256, originalDigest);

    graph.nodes[0].type = "code";
    graph.nodes[0].file_type = "code";
    [graph.nodes[0].label, graph.nodes[1].label] = [graph.nodes[1].label, graph.nodes[0].label];
    const swappedLabels = validateGraphNodeIdentity(graph, {
      repositoryFiles,
      builtCommit: graph.built_at_commit,
      requireStored: false,
    });
    assert.equal(swappedLabels.ok, false);
    assert.match(swappedLabels.reason, /shortest-unique/u);
  });

  test("rejects raw ID or file-label normalization and exact-link breakage", () => {
    const graph = prepare(safeGraph());
    const originalId = graph.nodes[0].id;
    graph.links.push({ source: originalId, target: "global_without_source" });
    applyGraphNodeIdentityProof(graph, {
      repositoryFiles,
      builtCommit: graph.built_at_commit,
    });
    const originalDigest = graph.meta_kim_enrichment.nodeIdentity.evidenceSha256;

    graph.nodes[0].id = `${originalId} `;
    const rawId = validateGraphNodeIdentity(graph, {
      repositoryFiles,
      builtCommit: graph.built_at_commit,
      requireStored: false,
    });
    assert.equal(rawId.ok, false);
    assert.deepEqual(rawId.expected.invalidNodeIdIndexes, [0]);
    assert.deepEqual(rawId.expected.danglingLinkIndexes, [0]);
    assert.match(rawId.reason, /canonical strings|exact node IDs/u);
    assert.notEqual(rawId.expected.evidenceSha256, originalDigest);

    graph.nodes[0].id = originalId;
    graph.nodes[0].label = ` ${graph.nodes[0].label}`;
    const rawLabel = validateGraphNodeIdentity(graph, {
      repositoryFiles,
      builtCommit: graph.built_at_commit,
      requireStored: false,
    });
    assert.equal(rawLabel.ok, false);
    assert.deepEqual(rawLabel.expected.invalidFileNodeLabelIndexes, [0]);
    assert.match(rawLabel.reason, /canonical strings/u);
    assert.notEqual(rawLabel.expected.evidenceSha256, originalDigest);
  });

  test("rejects a stored v1 or otherwise stale proof", () => {
    const graph = prepare(safeGraph());
    graph.meta_kim_enrichment = {
      nodeIdentity: { schemaVersion: "meta-kim-graph-node-identity-v1" },
    };
    const result = validateGraphNodeIdentity(graph, {
      repositoryFiles,
      builtCommit: graph.built_at_commit,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /meta-kim-graph-node-identity-v2/u);
  });

  test("proof binds the exact repository inventory, not only its file count", () => {
    const graph = {
      nodes: [
        fileNode("shared.txt", "shared_txt"),
        { id: "concept", label: "concept", type: "concept" },
      ],
      links: [],
      built_at_commit: "a".repeat(40),
    };
    applyGraphNodeIdentityProof(graph, {
      repositoryFiles: ["private-a.txt", "shared.txt"],
      builtCommit: graph.built_at_commit,
    });
    const result = validateGraphNodeIdentity(graph, {
      repositoryFiles: ["different-b.txt", "shared.txt"],
      builtCommit: graph.built_at_commit,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing or stale/u);
    assert.notEqual(
      graph.meta_kim_enrichment.nodeIdentity.repositoryFilesSha256,
      result.expected.repositoryFilesSha256,
    );
  });

  test("requires a complete non-empty analysis sidecar for live proof", () => {
    const graph = prepare(safeGraph());
    const options = {
      repositoryFiles,
      builtCommit: graph.built_at_commit,
      requireAnalysisSidecar: true,
    };
    const empty = analyzeGraphNodeIdentity(graph, {
      ...options,
      analysisSidecar: {},
    });
    assert.equal(empty.status, "unsafe_node_identity");
    assert.ok(empty.analysisSidecarShapeIssues.length > 0);

    const truncated = analyzeGraphNodeIdentity(graph, {
      ...options,
      analysisSidecar: {
        communities: {},
        cohesion: {},
        gods: [],
        surprises: [],
        questions: [],
      },
    });
    assert.equal(truncated.status, "unsafe_node_identity");
    assert.ok(
      truncated.analysisSidecarShapeIssues.some(
        (issue) => issue.reason === "empty_for_non_empty_graph",
      ),
    );

    const complete = analyzeGraphNodeIdentity(graph, {
      ...options,
      analysisSidecar: {
        communities: {
          0: graph.nodes.map((node) => node.id),
        },
        cohesion: { 0: 1 },
        gods: [{ id: graph.nodes[0].id }],
        surprises: [],
        questions: [],
      },
    });
    assert.equal(complete.status, "verified_graph_file_identity");
    assert.match(complete.analysisSidecarSha256, /^[a-f0-9]{64}$/u);

    const missingNode = analyzeGraphNodeIdentity(graph, {
      ...options,
      analysisSidecar: {
        communities: { 0: [graph.nodes[0].id] },
        cohesion: { 0: 1 },
        gods: [],
        surprises: [],
        questions: [],
      },
    });
    assert.equal(missingNode.status, "unsafe_node_identity");
    assert.ok(
      missingNode.analysisCommunityCoverageIssues.missingGraphNodeCount > 0,
    );

    const duplicateNode = analyzeGraphNodeIdentity(graph, {
      ...options,
      analysisSidecar: {
        communities: {
          0: graph.nodes.map((node) => node.id),
          1: [graph.nodes[0].id],
        },
        cohesion: { 0: 1, 1: 1 },
        gods: [],
        surprises: [],
        questions: [],
      },
    });
    assert.equal(duplicateNode.status, "unsafe_node_identity");
    assert.equal(
      duplicateNode.analysisCommunityCoverageIssues.duplicateNodeReferenceCount,
      1,
    );
  });

  test("binds ordinary graph metadata and rejects private graph fields", () => {
    const graph = prepare(safeGraph());
    applyGraphNodeIdentityProof(graph, {
      repositoryFiles,
      builtCommit: graph.built_at_commit,
    });
    graph.nodes[0].description = "changed after proof";
    const changed = validateGraphNodeIdentity(graph, {
      repositoryFiles,
      builtCommit: graph.built_at_commit,
    });
    assert.equal(changed.ok, false);
    assert.notEqual(
      changed.expected.graphContentSha256,
      graph.meta_kim_enrichment.nodeIdentity.graphContentSha256,
    );

    graph.nodes[0].description = "path=~/.ssh/id_rsa";
    const privateGraph = analyzeGraphNodeIdentity(graph, {
      repositoryFiles,
      builtCommit: graph.built_at_commit,
    });
    assert.equal(privateGraph.status, "unsafe_node_identity");
    assert.ok(privateGraph.graphPrivatePathIssues.length > 0);
    assert.ok(
      privateGraph.graphPrivatePathIssues.every(
        (pointer) => !pointer.includes("~/.ssh"),
      ),
    );
  });

  test("allows HTTP node source URLs without weakening private-path checks elsewhere", () => {
    const graph = prepare(safeGraph());
    graph.nodes[0].source_url = "https://example.test/home/project/source.mjs";
    const safeHttpSource = analyzeGraphNodeIdentity(graph, {
      repositoryFiles,
      builtCommit: graph.built_at_commit,
    });
    assert.equal(safeHttpSource.graphPrivatePathIssues.length, 0);

    const rejectedMutations = [
      ["description", "https://example.test/home/project/source.mjs"],
      ["source_url", "file:///home/kim/private/source.mjs"],
      ["source_url", "https://example.test/home/project\\C:\\Users\\Kim"],
      ["source_url", "https://example.test/home/project\nC:\\Users\\Kim"],
      ["source_url", "https://example.test/home/project?next=/home/kim/private"],
      ["source_url", "https://example.test/home/project?next=%2Fhome%2Fkim%2Fprivate"],
      ["source_url", "https://example.test/home/project?next=%252Fhome%252Fkim%252Fprivate"],
      ["source_url", "https://example.test/home/project?next=%252Fhome%2Fkim%252Fprivate"],
      ["source_url", "https://example.test/home/project#C:/Users/Kim/private"],
      ["source_url", "https://example.test/home/project#C%253A%252FUsers%252FKim%252Fprivate"],
      ["source_url", "https://user%2Fhome%2Fkim@example.test/project"],
      ["source_url", "https://user%252Fhome%252Fkim@example.test/project"],
      ["source_url", `https://example.test/${"a".repeat(8200)}`],
      ["source_url", `https://example.test/home/project?value=${"a".repeat(8200)}`],
      ["source_url", "https:// invalid/home/kim/private"],
    ];
    for (const [field, value] of rejectedMutations) {
      const candidate = prepare(safeGraph());
      candidate.nodes[0][field] = value;
      const result = analyzeGraphNodeIdentity(candidate, {
        repositoryFiles,
        builtCommit: candidate.built_at_commit,
      });
      assert.ok(
        result.graphPrivatePathIssues.length > 0,
        `${field} mutation should remain private`,
      );
    }
  });

  test("binds sanitized provenance and refuses private analysis paths", () => {
    const graph = prepare(safeGraph());
    graph.meta_kim_enrichment = {
      outputSanitization: {
        schemaVersion: "meta-kim-graphify-output-sanitize-v1",
        runtimeProjectionRefs: 1,
      },
    };
    graph.nodes.push({
      id: "runtime_ref",
      label: "runtime",
      runtime_source_ref: ".claude/skills/example/SKILL.md",
    });
    applyGraphNodeIdentityProof(graph, {
      repositoryFiles,
      builtCommit: graph.built_at_commit,
    });
    graph.meta_kim_enrichment.outputSanitization.runtimeProjectionRefs = 2;
    const tampered = validateGraphNodeIdentity(graph, {
      repositoryFiles,
      builtCommit: graph.built_at_commit,
    });
    assert.equal(tampered.ok, false);
    assert.notEqual(
      tampered.expected.outputSanitizationSha256,
      graph.meta_kim_enrichment.nodeIdentity.outputSanitizationSha256,
    );

    const privateAnalysis = analyzeGraphNodeIdentity(graph, {
      repositoryFiles,
      builtCommit: graph.built_at_commit,
      requireAnalysisSidecar: true,
      analysisSidecar: {
        communities: { 0: graph.nodes.map((node) => node.id) },
        cohesion: { 0: 1 },
        gods: [],
        surprises: [],
        questions: [{ question: "Open C:\\Users\\Kim\\private.txt" }],
      },
    });
    assert.equal(privateAnalysis.status, "unsafe_node_identity");
    assert.ok(privateAnalysis.analysisPrivatePathIssues.length > 0);

    const privateKeyAnalysis = analyzeGraphNodeIdentity(graph, {
      repositoryFiles,
      builtCommit: graph.built_at_commit,
      requireAnalysisSidecar: true,
      analysisSidecar: {
        communities: {
          "C:\\Users\\Kim\\secret": graph.nodes.map((node) => node.id),
        },
        cohesion: { "C:\\Users\\Kim\\secret": 1 },
        gods: [],
        surprises: [],
        questions: [],
      },
    });
    assert.equal(privateKeyAnalysis.status, "unsafe_node_identity");
    assert.deepEqual(privateKeyAnalysis.analysisPrivatePathIssues, [
      "$.[value].[key]",
      "$.[value].[key]",
    ]);
    assert.ok(
      privateKeyAnalysis.analysisPrivatePathIssues.every(
        (pointer) => !pointer.includes("C:\\Users\\Kim"),
      ),
    );

    graph.nodes.at(-1).runtime_source_ref = "C:\\Users\\Kim\\private.md";
    const badProvenance = analyzeGraphNodeIdentity(graph, { repositoryFiles });
    assert.deepEqual(
      badProvenance.invalidProvenanceNodeIndexes,
      [graph.nodes.length - 1],
    );
  });
});
