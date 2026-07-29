import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  GRAPHIFY_OUTPUT_SANITIZE_SCHEMA,
  sanitizeGraphifyAnalysisSidecar,
  sanitizeGraphifyOutput,
} from "../../scripts/graphify-output-sanitize.mjs";

describe("Graphify upstream output sanitizer", () => {
  test("canonicalizes Unicode IDs, rewrites exact links, and resolves canonical collisions", () => {
    const graph = {
      nodes: [
        { id: "Foo", label: "first" },
        { id: "foo", label: "second" },
        { id: "Straße", label: "third" },
      ],
      links: [
        { source: "Foo", target: "Straße" },
        { source: "foo", target: "Foo" },
      ],
    };
    const normalized = new Map([
      ["Foo", "foo"],
      ["foo", "foo"],
      ["Straße", "strasse"],
    ]);
    const result = sanitizeGraphifyOutput(graph, {
      normalizeNodeId: (value) => normalized.get(value) ?? value,
    });
    assert.equal(result.schemaVersion, GRAPHIFY_OUTPUT_SANITIZE_SCHEMA);
    assert.equal(result.canonicalizedNodeIds, 2);
    assert.equal(result.resolvedCanonicalCollisions, 1);
    assert.equal(new Set(graph.nodes.map((node) => node.id)).size, 3);
    assert.ok(graph.nodes.some((node) => node.id === "foo"));
    assert.ok(
      graph.nodes.some((node) =>
        node.id.startsWith("foo_meta_kim_collision_")
      ),
    );
    assert.ok(graph.nodes.some((node) => node.id === "strasse"));
    const ids = new Set(graph.nodes.map((node) => node.id));
    assert.ok(
      graph.links.every((link) => ids.has(link.source) && ids.has(link.target)),
    );
  });

  test("reclassifies non-repository provenance without deleting useful nodes or links", () => {
    const graph = {
      nodes: [
        { id: "tracked", source_file: "tracked.txt" },
        { id: "directory", source_file: "config/capability-index/" },
        { id: "runtime", source_file: ".claude/skills/example/SKILL.md" },
        { id: "hallucinated", source_file: "~/.claude/private.md" },
      ],
      links: [
        { source: "tracked", target: "hallucinated" },
        { source: "tracked", target: "directory" },
        { source: "runtime", target: "tracked" },
        { source: "tracked", target: "tracked" },
      ],
    };
    const result = sanitizeGraphifyOutput(graph, {
      repositoryFiles: [
        "tracked.txt",
        "config/capability-index/provider-registry.json",
      ],
    });
    assert.equal(result.repositoryDirectoryRefs, 1);
    assert.equal(result.runtimeProjectionRefs, 1);
    assert.equal(result.runtimeHomeRefs, 1);
    assert.equal(graph.nodes.length, 4);
    assert.equal(graph.links.length, 4);
    assert.equal(graph.nodes[1].source_directory, "config/capability-index");
    assert.equal(
      graph.nodes[2].runtime_source_ref,
      ".claude/skills/example/SKILL.md",
    );
    assert.equal(
      graph.nodes[3].runtime_source_ref,
      "runtime-home/claude/private.md",
    );
    assert.ok(graph.nodes.every((node) => node.source_file === undefined || node.id === "tracked"));
  });

  test("redacts only private local node source URLs with an auditable idempotent count", () => {
    const privateSourceUrls = [
      "C:/Users/Kim/private/source.mjs",
      "C:\\Users\\Kim\\private\\source.mjs",
      "\\\\server\\share\\private\\source.mjs",
      "/Users/kim/private/source.mjs",
      "/home/kim/private/source.mjs",
      "/root/private/source.mjs",
      "~/private/source.mjs",
      "~\\private\\source.mjs",
    ];
    const graph = {
      nodes: [
        ...privateSourceUrls.map((source_url, index) => ({
          id: `private-${index}`,
          source_url,
        })),
        { id: "http", source_url: "http://example.test/source.mjs" },
        { id: "https", source_url: "https://example.test/Users/guide" },
        { id: "relative", source_url: "scripts/source.mjs" },
        {
          id: "unknown-surface",
          source_url: "docs/source.mjs",
          metadata: { localPath: "C:\\Users\\Kim\\must-remain-visible-to-validator" },
        },
      ],
      links: [],
    };

    const first = sanitizeGraphifyOutput(graph);
    assert.equal(
      first.schemaVersion,
      "meta-kim-graphify-output-sanitize-v2",
    );
    assert.equal(first.changed, true);
    assert.equal(first.redactedPrivateSourceUrls, privateSourceUrls.length);
    assert.ok(
      graph.nodes
        .slice(0, privateSourceUrls.length)
        .every((node) => !Object.hasOwn(node, "source_url")),
    );
    assert.equal(
      graph.nodes[privateSourceUrls.length].source_url,
      "http://example.test/source.mjs",
    );
    assert.equal(
      graph.nodes[privateSourceUrls.length + 1].source_url,
      "https://example.test/Users/guide",
    );
    assert.equal(
      graph.nodes[privateSourceUrls.length + 2].source_url,
      "scripts/source.mjs",
    );
    assert.equal(
      graph.nodes[privateSourceUrls.length + 3].metadata.localPath,
      "C:\\Users\\Kim\\must-remain-visible-to-validator",
    );

    const afterFirst = structuredClone(graph);
    const second = sanitizeGraphifyOutput(graph);
    assert.equal(second.changed, false);
    assert.equal(second.redactedPrivateSourceUrls, 0);
    assert.deepEqual(graph, afterFirst);
  });

  test("rewrites both Graphify hyperedge reference surfaces", () => {
    const hyperedge = {
      id: "Team-Group",
      nodes: ["Foo", "bar"],
    };
    const graph = {
      nodes: [{ id: "Foo" }, { id: "bar" }],
      links: [],
      hyperedges: [structuredClone(hyperedge)],
      graph: { hyperedges: [structuredClone(hyperedge)] },
    };
    const result = sanitizeGraphifyOutput(graph, {
      normalizeNodeId: (value) => ({
        Foo: "foo",
        bar: "bar",
        "Team-Group": "team_group",
      })[value] ?? value,
    });
    assert.equal(result.canonicalizedHyperedgeIds, 2);
    assert.equal(result.rewrittenHyperedgeReferences, 2);
    assert.deepEqual(graph.hyperedges, graph.graph.hyperedges);
    assert.deepEqual(graph.hyperedges[0], {
      id: "team_group",
      nodes: ["foo", "bar"],
    });
  });

  test("refuses ambiguous duplicate raw IDs and malformed endpoints", () => {
    assert.throws(
      () => sanitizeGraphifyOutput({
        nodes: [{ id: "same" }, { id: "same" }],
        links: [],
      }),
      /duplicate exact raw node IDs/u,
    );
    assert.throws(
      () => sanitizeGraphifyOutput({
        nodes: [{ id: "safe" }],
        links: [{ source: "safe", target: 42 }],
      }),
      /malformed link endpoint/u,
    );
  });

  test("rewrites complete analysis sidecars and rejects dangling references", () => {
    const analysis = {
      communities: { 0: ["Foo", "bar"] },
      cohesion: { 0: 0.5 },
      gods: [{ id: "Foo", label: "Foo", degree: 2 }],
      surprises: [],
      questions: [],
    };
    const result = sanitizeGraphifyAnalysisSidecar(analysis, {
      nodeIdMap: new Map([
        ["Foo", "foo"],
        ["bar", "bar"],
      ]),
      graphNodeIds: new Set(["foo", "bar"]),
    });
    assert.equal(result.changed, true);
    assert.equal(result.rewrittenNodeReferences, 2);
    assert.deepEqual(analysis.communities, { 0: ["foo", "bar"] });
    assert.equal(analysis.gods[0].id, "foo");

    assert.throws(
      () =>
        sanitizeGraphifyAnalysisSidecar(
          {
            communities: { 0: ["missing"] },
            cohesion: { 0: 1 },
            gods: [],
            surprises: [],
            questions: [],
          },
          {
            nodeIdMap: new Map(),
            graphNodeIds: new Set(["safe"]),
          },
        ),
      /dangling node reference/u,
    );
  });

  test("rejects empty, truncated, or internally inconsistent analysis sidecars", () => {
    const options = {
      nodeIdMap: new Map([["safe", "safe"]]),
      graphNodeIds: new Set(["safe"]),
    };
    assert.throws(
      () => sanitizeGraphifyAnalysisSidecar({}, options),
      /communities surface is missing/u,
    );
    assert.throws(
      () =>
        sanitizeGraphifyAnalysisSidecar(
          {
            communities: {},
            cohesion: {},
            gods: [],
            surprises: [],
            questions: [],
          },
          options,
        ),
      /empty for a non-empty graph/u,
    );
    assert.throws(
      () =>
        sanitizeGraphifyAnalysisSidecar(
          {
            communities: { 0: ["safe"] },
            cohesion: { 1: 1 },
            gods: [],
            surprises: [],
            questions: [],
          },
          options,
        ),
      /community and cohesion surfaces disagree/u,
    );
  });

  test("allows the real pre-cluster sidecar shape only before publication", () => {
    const preCluster = {
      communities: { 0: ["safe"] },
      cohesion: { 0: 1 },
      gods: [],
      surprises: [],
      tokens: { input: 1, output: 1 },
    };
    const options = {
      nodeIdMap: new Map([["safe", "safe"]]),
      graphNodeIds: new Set(["safe"]),
      repositoryFiles: [],
    };
    assert.doesNotThrow(() =>
      sanitizeGraphifyAnalysisSidecar(structuredClone(preCluster), {
        ...options,
        requireComplete: false,
      }),
    );
    assert.throws(
      () =>
        sanitizeGraphifyAnalysisSidecar(
          structuredClone(preCluster),
          options,
        ),
      /questions surface is missing/u,
    );
  });

  test("requires communities to partition every graph node exactly once", () => {
    const options = {
      nodeIdMap: new Map([
        ["first", "first"],
        ["second", "second"],
      ]),
      graphNodeIds: new Set(["first", "second"]),
    };
    const base = {
      cohesion: { 0: 1 },
      gods: [],
      surprises: [],
      questions: [],
    };
    assert.throws(
      () =>
        sanitizeGraphifyAnalysisSidecar(
          { ...structuredClone(base), communities: { 0: ["first"] } },
          options,
        ),
      /partition every graph node exactly once/u,
    );
    assert.throws(
      () =>
        sanitizeGraphifyAnalysisSidecar(
          {
            ...structuredClone(base),
            communities: { 0: ["first", "second", "first"] },
          },
          options,
        ),
      /partition every graph node exactly once/u,
    );
  });

  test("rejects private local paths and source files outside the repository inventory", () => {
    const base = {
      communities: { 0: ["safe"] },
      cohesion: { 0: 1 },
      gods: [],
      surprises: [],
      questions: [],
    };
    const options = {
      nodeIdMap: new Map([["safe", "safe"]]),
      graphNodeIds: new Set(["safe"]),
      repositoryFiles: ["tracked.txt"],
    };
    assert.throws(
      () =>
        sanitizeGraphifyAnalysisSidecar(
          {
            ...structuredClone(base),
            surprises: [{ source_files: ["private.txt"] }],
          },
          options,
        ),
      /unknown source file/u,
    );
    assert.throws(
      () =>
        sanitizeGraphifyAnalysisSidecar(
          {
            ...structuredClone(base),
            questions: [{ question: "Inspect path=~/.ssh/id_rsa" }],
          },
          options,
        ),
      /private local path/u,
    );
    assert.throws(
      () =>
        sanitizeGraphifyAnalysisSidecar(
          {
            communities: {
              "C:\\Users\\Kim\\secret": ["safe"],
            },
            cohesion: {
              "C:\\Users\\Kim\\secret": 1,
            },
            gods: [],
            surprises: [],
            questions: [],
          },
          options,
        ),
      /private local path/u,
    );
    assert.throws(
      () =>
        sanitizeGraphifyAnalysisSidecar(
          {
            communities: {
              "C:\\Users\\Kim\\secret": "malformed",
            },
            cohesion: {
              "C:\\Users\\Kim\\secret": 1,
            },
            gods: [],
            surprises: [],
            questions: [],
          },
          options,
        ),
      (error) =>
        /private local path|malformed community member list/u.test(
          error.message,
        ) && !error.message.includes("C:\\Users\\Kim"),
    );
  });
});
