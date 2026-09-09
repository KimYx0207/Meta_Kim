"""Regression checks against the real installed Graphify runtime; no API calls."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import random
import shutil
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/graphify-managed-producer.py"
spec = importlib.util.spec_from_file_location("managed_producer", SCRIPT)
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)


class ProducerTests(unittest.TestCase):
    def test_sparse_matches_official_oracle(self):
        from graphify.cluster import remap_communities_to_previous as oracle
        cases = [({}, {}), ({10: ["b", "a"], 20: ["c"]}, {"x": 0}),
                 ({7: ["b", "a"], 8: ["c"]}, {"a": 1, "b": 1, "c": 2}),
                 ({7: ["a", "a", "b"], 8: ["c", "b", "b"]}, {"a": 1, "b": 2, "c": 2}),
                 ({7: ["b", "a"], 8: ["c", "b"]}, {"a": 1, "b": 1, "c": 2}),
                 ({20: ["a"], 10: ["b"]}, {"a": 2, "b": 1}),
                 ({20: ["a"], 10: ["a"]}, {"a": 1}),
                 ({5: ["a"], 6: ["y", "x"], 7: ["z"]}, {"a": 3}),
                 ({10: ["a"], 11: ["b"], 12: ["d", "c"]}, {"a": 100, "b": 2}),
                 ({99: ["b", "a"], 3: ["c"], 42: ["d"]}, {"a": 7, "b": 8, "c": 8}),
                 ({30: ["x", "a"], 20: ["y", "b"]}, {"a": 5, "b": 4, "x": 4, "y": 5}),
                 ({4: ["d", "a", "d", "c"], 1: ["b", "a", "b"]}, {"a": 9, "b": 9, "c": 8})]
        rng = random.Random(20260909)
        for index in range(300):
            nodes = [f"n{index}_{i}" for i in range(rng.randint(0, 80))]
            old_count, new_count = rng.randint(0, 12), rng.randint(0, 12)
            previous = {node: rng.randrange(old_count) for node in nodes if old_count and rng.random() < 0.85}
            communities = {cid: rng.choices(nodes, k=rng.randint(0, 18)) if nodes else []
                           for cid in rng.sample(range(50), new_count)}
            cases.append((communities, previous))
        for communities, previous in cases:
            self.assertEqual(list(producer.remap_sparse(communities, previous).items()),
                             list(oracle(communities, previous).items()))

    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="graphify-managed-producer-test-")
        cls.base = Path(cls.temporary.name).resolve()
        cls.home = cls.base / "home"
        cls.home.mkdir()
        cls.repo, cls.seed = cls.base / "repo", cls.base / "seed"
        cls.repo.mkdir()
        (cls.repo / "code.py").write_text("def hello():\n    return 1\n\ndef other():\n    return 2\n")
        (cls.repo / "keep.md").write_text("# Protected knowledge\n")
        (cls.repo / ".gitignore").write_text("graphify-out/\n.hidden-knowledge/\n")
        subprocess.run(["git", "init", "-q", str(cls.repo)], check=True)
        subprocess.run(["git", "-C", str(cls.repo), "add", "code.py", ".gitignore"], check=True)
        subprocess.run(["git", "-C", str(cls.repo), "-c", "core.hooksPath=/dev/null",
                        "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                        "commit", "-qm", "fixture"], check=True)
        cls.env = {**os.environ, "GRAPHIFY_OUT": str(cls.seed), "GRAPHIFY_NO_BACKUP": "1",
                   "HOME": str(cls.home), "XDG_CACHE_HOME": str(cls.home / ".cache"), "XDG_CONFIG_HOME": str(cls.home / ".config"),
                   "GRAPHIFY_NO_TIPS": "1", "GRAPHIFY_MAX_WORKERS": "1", "PYTHONHASHSEED": "0",
                   "PYTHONDONTWRITEBYTECODE": "1"}
        for args in (("update", str(cls.repo), "--no-cluster"),
                     ("cluster-only", str(cls.repo), "--no-label", "--no-viz")):
            completed = subprocess.run([sys.executable, "-m", "graphify", *args], env=cls.env,
                                       cwd=cls.repo, capture_output=True, text=True, timeout=30)
            if completed.returncode:
                raise RuntimeError(completed.stdout + completed.stderr)
        cls.original = json.loads((cls.seed / "graph.json").read_text())
        cls.original_target = next(node for node in cls.original["nodes"] if node.get("label") == "hello()")
        cls.protected_source = ".hidden-knowledge/keep.md"
        (cls.repo / ".hidden-knowledge").mkdir()
        (cls.repo / cls.protected_source).write_text("# Protected knowledge\n")
        native_document = next(node for node in cls.original["nodes"] if node.get("label") == "keep.md")
        cls.protected_node = {**native_document, "id": "protected_file", "source_file": cls.protected_source}
        cls.graph = copy.deepcopy(cls.original)
        old_id = cls.original_target["id"]
        for node in cls.graph["nodes"]:
            if node["id"] == old_id:
                node["id"] = "legacy_target"
        for edge in cls.graph["links"]:
            for side in ("source", "target"):
                if edge[side] == old_id:
                    edge[side] = "legacy_target"
        cls.semantic_node = {"id": "semantic_concept", "source_file": "code.py", "source_location": None,
                             "label": "Why hello exists", "file_type": "concept", "type": "concept",
                             "_origin": "semantic", "description": "Preserve this curated explanation."}
        cls.graph["nodes"].extend([cls.protected_node, cls.semantic_node])
        cls.guarded_edges = [
            {"source": "protected_file", "target": "legacy_target", "relation": "contains",
             "source_file": cls.protected_source, "source_location": "L1", "confidence": "EXTRACTED",
             "confidence_score": 1.0, "weight": 1.0, "_origin": "ast"},
            {"source": "semantic_concept", "target": "legacy_target", "relation": "explains",
             "source_file": "code.py", "source_location": None, "confidence": "INFERRED",
             "confidence_score": 0.83, "weight": 0.7, "_origin": "semantic"}]
        cls.graph["links"].extend(cls.guarded_edges)
        cls.before = producer.preserve_before(cls.repo, cls.graph)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def after_native_shape(self):
        graph = copy.deepcopy(self.original)
        graph["nodes"].extend([copy.deepcopy(self.protected_node), copy.deepcopy(self.semantic_node)])
        return graph

    def test_rebinds_real_native_node_identity_and_preserves_inferred_attributes(self):
        graph = self.after_native_shape()
        self.assertEqual(producer.retain(self.before, graph, restore=True), 2)
        restored = graph["links"][-1]
        self.assertEqual(restored, {**self.guarded_edges[-1], "target": self.original_target["id"]})
        self.assertEqual(producer.retain(self.before, graph, restore=False), 0)

    def test_ambiguous_identity_and_relation_changes_fail(self):
        graph = self.after_native_shape()
        duplicate = {**self.original_target, "id": "duplicate_target"}
        graph["nodes"].append(duplicate)
        with self.assertRaisesRegex(RuntimeError, "ambiguous"):
            producer.retain(self.before, graph, restore=True)
        graph = self.after_native_shape()
        graph["links"].append({**self.guarded_edges[-1], "target": self.original_target["id"],
                               "confidence_score": 0.12})
        with self.assertRaisesRegex(RuntimeError, "relation"):
            producer.retain(self.before, graph, restore=True)

    def test_real_native_update_collapses_identical_legacy_edge_aliases(self):
        graph = copy.deepcopy(self.graph)
        graph["nodes"].append(copy.deepcopy(self.original_target))
        graph["links"].extend({**edge, "target": self.original_target["id"]} for edge in self.guarded_edges)
        candidate = self.base / "aliased-candidate"
        candidate.mkdir()
        (candidate / "graph.json").write_text(json.dumps(graph))
        completed = subprocess.run([sys.executable, str(SCRIPT), "--repo", str(self.repo), "--candidate", str(candidate)],
                                   env=self.env, cwd=self.repo, capture_output=True, text=True, timeout=30)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        receipt = json.loads((candidate / "managed-receipt.json").read_text())
        self.assertEqual(receipt["retained"]["edges"], 4)
        self.assertEqual(receipt["retained"]["uniqueEdges"], 2)
        final = json.loads((candidate / "graph.json").read_text())
        inferred = [edge for edge in final["links"] if edge.get("confidence") == "INFERRED"]
        self.assertEqual(inferred, [{**self.guarded_edges[-1], "target": self.original_target["id"]}])
        graph["links"][-1]["confidence_score"] = 0.12
        conflicting = producer.preserve_before(self.repo, graph)
        with self.assertRaisesRegex(RuntimeError, "relation"):
            producer.retain(conflicting, copy.deepcopy(final), restore=True)

    def test_real_line_shift_rebinds_unique_ast_endpoint_without_changing_semantic_edge(self):
        repo = self.base / "line-shift-repo"
        shutil.copytree(self.repo, repo)
        code = repo / "code.py"
        code.write_text("\n\n" + code.read_text())
        candidate = self.base / "line-shift-candidate"
        candidate.mkdir()
        (candidate / "graph.json").write_text(json.dumps(self.graph))
        completed = subprocess.run([sys.executable, str(SCRIPT), "--repo", str(repo), "--candidate", str(candidate)],
                                   env=self.env, cwd=repo, capture_output=True, text=True, timeout=30)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        final = json.loads((candidate / "graph.json").read_text())
        moved = next(node for node in final["nodes"] if node.get("label") == "hello()")
        self.assertNotEqual(moved["source_location"], self.original_target["source_location"])
        inferred = [edge for edge in final["links"] if edge.get("confidence") == "INFERRED"]
        self.assertEqual(inferred, [{**self.guarded_edges[-1], "target": moved["id"]}])

    def test_real_dynamic_import_stubs_are_not_deleted_sources_but_real_definitions_are(self):
        repo = self.base / "dynamic-import-repo"
        shutil.copytree(self.repo, repo)
        (repo / "imports.mjs").write_text(
            'const a = await import("@example/sdk/server/mcp.js");\n'
            'const b = await import("./not-yet-created.mjs");\n')
        removed = repo / "removed.py"
        removed.write_text("def removed():\n    return 1\n")
        candidate = self.base / "dynamic-import-candidate"
        env = {**self.env, "GRAPHIFY_OUT": str(candidate)}
        seeded = subprocess.run([sys.executable, "-m", "graphify", "update", str(repo), "--no-cluster"],
                                env=env, cwd=repo, capture_output=True, text=True, timeout=30)
        self.assertEqual(seeded.returncode, 0, seeded.stdout + seeded.stderr)
        original = json.loads((candidate / "graph.json").read_text())
        references = {"@example/sdk/server/mcp.js", "not-yet-created.mjs"}
        self.assertTrue(references <= {node.get("source_file") for node in original["nodes"]})
        removed.unlink()
        before = producer.preserve_before(repo, original)
        self.assertEqual(before["retired"]["retiredSourcePaths"], ["removed.py"])
        completed = subprocess.run([sys.executable, str(SCRIPT), "--repo", str(repo), "--candidate", str(candidate)],
                                   env=env, cwd=repo, capture_output=True, text=True, timeout=30)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        final = json.loads((candidate / "graph.json").read_text())
        self.assertTrue(references <= {node.get("source_file") for node in final["nodes"]})
        self.assertNotIn("removed.py", {node.get("source_file") for node in final["nodes"]})
        receipt = json.loads((candidate / "managed-receipt.json").read_text())
        self.assertEqual(receipt["retained"]["retiredDeletedSources"], 1)
        (repo / ".graphifyignore").write_text("@example/sdk/server/mcp.js\nnot-yet-created.mjs\n")
        excluded = producer.preserve_before(repo, original)
        self.assertEqual(set(excluded["retired"]["explicitExcludedSourcePaths"]), references)
        with self.assertRaisesRegex(RuntimeError, "retired_source_reappeared"):
            producer.retain(excluded, final, restore=False)

    def test_line_shift_refuses_old_or_new_ambiguity_and_semantic_node_relocation(self):
        moved = self.after_native_shape()
        target = next(node for node in moved["nodes"] if node["id"] == self.original_target["id"])
        target["source_location"] = "L100"
        old_ambiguous = copy.deepcopy(self.graph)
        old_ambiguous["nodes"].append({**self.original_target, "id": "old_shadow", "source_location": "L200"})
        with self.assertRaisesRegex(RuntimeError, "ambiguous"):
            producer.retain(producer.preserve_before(self.repo, old_ambiguous), copy.deepcopy(moved), restore=True)
        new_ambiguous = copy.deepcopy(moved)
        new_ambiguous["nodes"].append({**self.original_target, "id": "new_shadow", "source_location": "L200"})
        with self.assertRaisesRegex(RuntimeError, "ambiguous"):
            producer.retain(self.before, new_ambiguous, restore=True)
        semantic_moved = self.after_native_shape()
        next(node for node in semantic_moved["nodes"] if node["id"] == "semantic_concept")["source_location"] = "L8"
        with self.assertRaisesRegex(RuntimeError, "ambiguous"):
            producer.retain(self.before, semantic_moved, restore=True)

    def test_explicit_ignore_retires_nodes_edges_and_hyperedges_without_touching_source(self):
        repo = self.base / "explicit-ignore-repo"
        shutil.copytree(self.repo, repo)
        (repo / ".graphifyignore").write_text(".hidden-knowledge/\n")
        source = repo / self.protected_source
        original_bytes = source.read_bytes()
        graph = copy.deepcopy(self.graph)
        graph["hyperedges"] = [{"id": "excluded-group", "source_file": self.protected_source,
                                "nodes": ["protected_file", "semantic_concept"]}]
        candidate = self.base / "explicit-ignore-candidate"
        candidate.mkdir()
        (candidate / "graph.json").write_text(json.dumps(graph))
        completed = subprocess.run([sys.executable, str(SCRIPT), "--repo", str(repo), "--candidate", str(candidate)],
                                   env=self.env, cwd=repo, capture_output=True, text=True, timeout=30)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        receipt = json.loads((candidate / "managed-receipt.json").read_text())
        retained = receipt["retained"]
        for kind in ("Sources", "Nodes", "Edges", "Hyperedges"):
            self.assertEqual(retained[f"retiredExplicitExcluded{kind}"], 1)
            self.assertEqual(retained[f"retiredDeleted{kind}"], 0)
        self.assertEqual(retained["explicitExcludedSourcePaths"], [self.protected_source])
        self.assertEqual(receipt["protectedSourcePaths"], [])
        self.assertEqual(source.read_bytes(), original_bytes)
        final = json.loads((candidate / "graph.json").read_text())
        self.assertNotIn("protected_file", {node["id"] for node in final["nodes"]})
        self.assertEqual(producer.hyperedges(final), [])
        self.assertTrue(any(edge.get("confidence_score") == 0.83 for edge in final["links"]))
        before = producer.preserve_before(repo, graph)
        with self.assertRaisesRegex(RuntimeError, "retired_source_reappeared"):
            producer.retain(before, graph, restore=False)

    def test_nested_explicit_negation_preserves_gitignored_and_converted_knowledge(self):
        repo = self.base / "nested-ignore-repo"
        shutil.copytree(self.repo, repo)
        (repo / ".graphifyignore").write_text(".hidden-knowledge/*.md\n")
        (repo / ".hidden-knowledge/.graphifyignore").write_text("!keep.md\n")
        (repo / ".hidden-knowledge/skip.md").write_text("# Excluded\n")
        converted = repo / "graphify-out/converted/keep.md"
        converted.parent.mkdir(parents=True, exist_ok=True)
        converted.write_text("# Converted knowledge\n")
        graph = copy.deepcopy(self.graph)
        graph["nodes"].extend([
            {**self.protected_node, "id": "excluded_document", "source_file": ".hidden-knowledge/skip.md"},
            {**self.protected_node, "id": "converted_document", "source_file": "graphify-out/converted/keep.md"},
        ])
        before = producer.preserve_before(repo, graph)
        self.assertEqual(set(before["sources"]), {self.protected_source, "graphify-out/converted/keep.md"})
        self.assertEqual(before["retired"]["explicitExcludedSourcePaths"], [".hidden-knowledge/skip.md"])
        self.assertNotIn("excluded_document", before["nodes"])
        self.assertIn("converted_document", before["nodes"])

    def test_streamed_sha256_spans_multiple_chunks(self):
        content = b"graphify" * (1024 * 1024 // 8 + 17)
        source = self.base / "multi-chunk.bin"
        source.write_bytes(content)
        self.assertEqual(producer.file_sha256(source), hashlib.sha256(content).hexdigest())

    def test_cli_candidate_isolation_ignored_source_and_real_native_update(self):
        candidate = self.base / "candidate"
        candidate.mkdir()
        (candidate / "graph.json").write_text(json.dumps(self.graph))
        current = self.repo / "graphify-out"
        current.mkdir(exist_ok=True)
        (current / "graph.json").write_text("CURRENT GRAPH MUST NOT BE READ OR WRITTEN")
        before = (current / "graph.json").read_bytes()
        result = subprocess.run([sys.executable, str(SCRIPT), "--repo", str(self.repo), "--candidate", str(candidate)],
                                env=self.env, cwd=self.repo, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        receipt = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertTrue(receipt["ok"])
        self.assertEqual(receipt["retained"]["sources"], 1)
        self.assertEqual(receipt["retained"]["restoredEdges"], 2)
        self.assertEqual(receipt["retained"]["semanticEdges"], 1)
        self.assertEqual(before, (current / "graph.json").read_bytes())
        self.assertEqual(receipt["graphSha256"], hashlib.sha256((candidate / "graph.json").read_bytes()).hexdigest())
        self.assertLess(receipt["graphBytes"], producer.MAX_BYTES)
        self.assertEqual(receipt["head"], self.graph["built_at_commit"])
        self.assertEqual(receipt["inputKind"], "working-tree")
        self.assertEqual(receipt["protectedSourcePaths"], [self.protected_source])
        self.assertEqual(receipt["protectedSourceStatSha256"], producer.source_snapshot(
            [self.repo / path for path in receipt["protectedSourcePaths"]], copied_root=self.repo / "graphify-out"))
        self.assertIn("not proof of a clean checkout", (candidate / "GRAPH_REPORT.md").read_text())
        final = json.loads((candidate / "graph.json").read_text())
        producer.retain(self.before, final, restore=False)
        self.assertEqual(json.loads((candidate / "managed-receipt.json").read_text()), receipt)
        self.assertEqual({p.name for p in current.iterdir()}, {"graph.json"})

    def test_candidate_symlink_refused_and_source_stat_change_detected(self):
        current = self.repo / "graphify-out"
        current.mkdir(exist_ok=True)
        if not (current / "graph.json").exists():
            (current / "graph.json").write_text("current")
        candidate = self.base / "symlink-candidate"
        candidate.mkdir()
        (candidate / "graph.json").symlink_to(current / "graph.json")
        completed = subprocess.run([sys.executable, str(SCRIPT), "--repo", str(self.repo), "--candidate", str(candidate)],
                                   env=self.env, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("candidate_symlink_not_allowed", completed.stdout)
        source = self.repo / self.protected_source
        old = producer.source_snapshot([str(source)])
        source.write_text("# Changed protected source\n")
        self.assertNotEqual(old, producer.source_snapshot([str(source)]))

    def test_deleted_real_source_retires_semantic_nodes_and_incident_edges(self):
        repo = self.base / "deleted-repo"
        shutil.copytree(self.repo, repo)
        (repo / "code.py").unlink()
        candidate = self.base / "deleted-candidate"
        candidate.mkdir()
        (candidate / "graph.json").write_text(json.dumps(self.graph))
        completed = subprocess.run([sys.executable, str(SCRIPT), "--repo", str(repo), "--candidate", str(candidate)],
                                   env=self.env, capture_output=True, text=True, timeout=30)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        receipt = json.loads((candidate / "managed-receipt.json").read_text())
        self.assertEqual(receipt["retained"]["retiredSourcePaths"], ["code.py"])
        self.assertEqual(receipt["retained"]["retiredDeletedNodes"], 4)
        self.assertEqual(receipt["retained"]["retiredDeletedEdges"], 4)
        self.assertEqual(receipt["retained"]["semanticNodes"], 0)
        graph = json.loads((candidate / "graph.json").read_text())
        ids = {node["id"] for node in graph["nodes"]}
        self.assertTrue(all(edge[side] in ids for edge in graph["links"] for side in ("source", "target")))
        self.assertNotIn("semantic_concept", ids)
        self.assertIn("protected_file", ids)

    def test_nonzero_native_return_is_not_success(self):
        with self.assertRaisesRegex(RuntimeError, "native_command_failed"):
            producer.native_command(SimpleNamespace(main=lambda: 2), ["update", "."])

    def test_copied_output_snapshot_survives_clone_but_detects_content_changes(self):
        original, clone = self.base / "output-original", self.base / "output-clone"
        original.mkdir()
        source = original / "converted.md"
        source.write_text("# Converted document\n", encoding="utf-8")
        before = producer.source_snapshot([source], copied_root=original)
        shutil.copytree(original, clone)
        copied = clone / source.name
        self.assertNotEqual(source.stat().st_ino, copied.stat().st_ino)
        self.assertEqual(before, producer.source_snapshot([copied], copied_root=clone))
        copied.write_text("# Changed document\n", encoding="utf-8")
        self.assertNotEqual(before, producer.source_snapshot([copied], copied_root=clone))


if __name__ == "__main__":
    unittest.main()
