#!/usr/bin/env python3
"""Build one isolated candidate with the installed Graphify 0.9.56 runtime."""
import argparse
from collections import Counter, defaultdict
import gc
import hashlib
import importlib.metadata
import inspect
import json
import os
from pathlib import Path
import subprocess
import sys

VERSION = "0.9.56"
REMAP_SHA256 = "2b6a7d3e62acee4263e5e57efc1f8e270b33495ddc6792d1cc5c31a9b227189e"
MAX_BYTES = 512 * 1024 * 1024


def remap_sparse(communities, previous):
    overlaps = Counter()
    for new, members in communities.items():
        for node in set(members):
            if node in previous:
                overlaps[previous[node], new] += 1
    mapping, used = {}, set()
    for (old, new), count in sorted(overlaps.items(), key=lambda row: (-row[1], *row[0])):
        if old not in used and new not in mapping:
            mapping[new] = old
            used.add(old)
    unmatched = sorted((cid for cid in communities if cid not in mapping),
                       key=lambda cid: (-len(communities[cid]), tuple(sorted(communities[cid]))))
    next_id = 0
    for cid in unmatched:
        while next_id in used:
            next_id += 1
        mapping[cid] = next_id
        used.add(next_id)
    return dict(sorted((mapping[cid], sorted(nodes)) for cid, nodes in communities.items()))


def packed(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def node_key(node):
    from graphify.build import _is_file_node_label
    source, label = node.get("source_file"), node.get("label")
    if _is_file_node_label(label, source):
        label = str(source).replace("\\", "/").rsplit("/", 1)[-1]
    return (source, node.get("source_location"), label, node.get("file_type"), node.get("type"))


def edge_key(edge):
    from graphify.build import _is_ast_tier
    omitted = {"community", "community_name"} | ({"_origin"} if _is_ast_tier(edge) else set())
    return packed({key: value for key, value in edge.items() if key not in omitted})


def source_snapshot(paths, copied_root=None):
    """Stat external sources; content-bind output artifacts that promotion copies."""
    copied_root = Path(copied_root).resolve() if copied_root is not None else None
    rows = []
    for path in sorted(set(map(str, paths))):
        try:
            file = Path(path)
            st = file.stat()
            if copied_root is not None and file.is_relative_to(copied_root):
                digest = file_sha256(file)
                after = file.stat()
                if (st.st_ino, st.st_size, st.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
                    raise RuntimeError("source_changed: protected output changed while hashing")
                rows.append(("copied-output", file.relative_to(copied_root).as_posix(), digest))
            else:
                rows.append((path, st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns))
        except OSError as exc:
            raise RuntimeError("source_changed: protected source unavailable") from exc
    return hashlib.sha256(packed(rows).encode()).hexdigest()


def hyperedges(graph):
    return graph.get("hyperedges", graph.get("graph", {}).get("hyperedges", []))


def explicit_ignored_predicate(repo):
    from graphify.detect import _load_graphifyignore, _load_dir_own_ignore, _is_ignored
    patterns = _load_graphifyignore(repo, gitignore=False)
    loaded, cache = {repo}, {}

    def ignored(path):
        ancestor = repo
        for part in path.relative_to(repo).parts[:-1]:
            ancestor = ancestor / part
            if ancestor not in loaded:
                loaded.add(ancestor)
                patterns.extend(_load_dir_own_ignore(ancestor, gitignore=False))
        return _is_ignored(path, repo, patterns, _cache=cache)

    return ignored


def preserve_before(repo, graph):
    from graphify.build import _is_ast_tier
    from graphify.detect import ignored_predicate, CODE_EXTENSIONS, DOC_EXTENSIONS, PAPER_EXTENSIONS, IMAGE_EXTENSIONS
    from graphify.watch import _is_remote_source
    ignored = ignored_predicate(repo)
    explicit_ignored = explicit_ignored_predicate(repo)
    protected, deleted, excluded = {}, set(), set()
    nodes = {node["id"]: node for node in graph["nodes"]}
    if len(nodes) != len(graph["nodes"]):
        raise RuntimeError("duplicate_node_ids")
    all_edges = graph.get("links", graph.get("edges", []))
    # Native import rescue emits source_file-bearing stubs even when a package
    # or relative target never existed. Require import evidence and no parsed
    # definition or owned relationship before exempting that source from deletion.
    import_targets = {edge.get("target") for edge in all_edges if _is_ast_tier(edge)
                      and edge.get("relation") in {"dynamic_import", "imports_from", "imports", "re_exports"}}
    reference_nodes = {key for key, node in nodes.items() if key in import_targets and _is_ast_tier(node)
                       and node.get("file_type") == "code" and node.get("confidence") == "EXTRACTED"
                       and not any(node.get(field) for field in ("source_location", "node_kind", "type"))}
    reference_only_sources = ({nodes[key].get("source_file") for key in reference_nodes}
                              - {node.get("source_file") for key, node in nodes.items() if key not in reference_nodes}
                              - {item.get("source_file") for item in [*all_edges, *hyperedges(graph)]})
    for source in {item.get("source_file") for item in [*nodes.values(), *all_edges, *hyperedges(graph)]}:
        if not isinstance(source, str) or not source or _is_remote_source(source):
            continue
        path = (repo / source).resolve()
        if not path.is_relative_to(repo):
            continue
        if explicit_ignored(path):
            excluded.add(source)
            continue
        try:
            path.stat()
        except FileNotFoundError:
            if source not in reference_only_sources and path.suffix.lower() in CODE_EXTENSIONS | DOC_EXTENSIONS | PAPER_EXTENSIONS | IMAGE_EXTENSIONS:
                deleted.add(source)
            continue
        if path.is_file() and ignored(path):
            protected[source] = str(path)
    retired_sources = deleted | excluded
    retired_nodes = {key for key, node in nodes.items() if node.get("source_file") in retired_sources}
    retired_edge = lambda edge: edge.get("source_file") in retired_sources or edge.get("source") in retired_nodes or edge.get("target") in retired_nodes
    guarded = {key: node for key, node in nodes.items()
               if key not in retired_nodes and (node.get("source_file") in protected or not _is_ast_tier(node))}
    edges = [edge for edge in all_edges if not retired_edge(edge) and
             (edge.get("source_file") in protected or not _is_ast_tier(edge)
              or edge.get("source") in guarded or edge.get("target") in guarded)]
    kept_hyperedges = [edge for edge in hyperedges(graph) if edge.get("source_file") not in retired_sources and
                      not retired_nodes.intersection(edge.get("nodes", edge.get("members", edge.get("node_ids", []))))]
    endpoint_ids = set(guarded) | {edge[side] for edge in edges for side in ("source", "target")}
    if not endpoint_ids <= nodes.keys():
        raise RuntimeError("dangling_protected_edge")
    endpoints = {key: node_key(nodes[key]) for key in endpoint_ids}
    relocatable = {key: value[:1] + value[2:] for key, value in endpoints.items()
                   if key not in guarded and _is_ast_tier(nodes[key])}
    old_matches = defaultdict(set)
    wanted = set(relocatable.values())
    for node in nodes.values():
        key = node_key(node)
        identity = key[:1] + key[2:]
        if identity in wanted:
            old_matches[identity].add(key)
    relocatable = {key: identity for key, identity in relocatable.items() if len(old_matches[identity]) == 1}

    def retirement_counts(sources, reason):
        retired = {key for key, node in nodes.items() if node.get("source_file") in sources}
        return {f"retired{reason}Sources": len(sources), f"retired{reason}Nodes": len(retired),
                f"retired{reason}Edges": sum(edge.get("source_file") in sources or edge.get("source") in retired
                                             or edge.get("target") in retired for edge in all_edges),
                f"retired{reason}Hyperedges": sum(edge.get("source_file") in sources or bool(retired.intersection(
                    edge.get("nodes", edge.get("members", edge.get("node_ids", []))))) for edge in hyperedges(graph))}

    return {"sources": protected, "nodes": guarded, "edges": edges,
            "endpoints": endpoints, "relocatable": relocatable,
            "communities": {key: node["community"] for key, node in nodes.items() if node.get("community") is not None},
            "hyperedges": kept_hyperedges,
            "semanticNodes": sum(not _is_ast_tier(node) for node in guarded.values()),
            "semanticEdges": sum(not _is_ast_tier(edge) for edge in edges),
            "retired": {**retirement_counts(deleted, "Deleted"), **retirement_counts(excluded, "ExplicitExcluded"),
                        "explicitExcludedSourcePaths": sorted(excluded), "retiredSourcePaths": sorted(retired_sources)}}


def retain(before, graph, *, restore):
    from graphify.build import _is_ast_tier
    nodes = {node["id"]: node for node in graph["nodes"]}
    if len(nodes) != len(graph["nodes"]):
        raise RuntimeError("duplicate_node_ids")
    retired = set(before["retired"]["retiredSourcePaths"])
    reappeared = [(kind, item.get("source_file")) for kind, items in
                  (("node", nodes.values()), ("edge", graph.get("links", graph.get("edges", []))),
                   ("hyperedge", hyperedges(graph))) for item in items if item.get("source_file") in retired]
    if reappeared:
        raise RuntimeError("retired_source_reappeared: " + packed({
            "counts": dict(Counter(kind for kind, _ in reappeared)),
            "sources": [{"kind": kind, "source_file": source} for kind, source in sorted(set(reappeared))[:8]]}))
    wanted, by_key = set(before["endpoints"].values()), defaultdict(list)
    relocatable, by_symbol = set(before["relocatable"].values()), defaultdict(list)
    for node in nodes.values():
        key = node_key(node)
        if key in wanted:
            by_key[key].append(node["id"])
        if key[:1] + key[2:] in relocatable:
            by_symbol[key[:1] + key[2:]].append(node["id"])

    def target(old_id):
        key = before["endpoints"][old_id]
        if old_id in nodes and node_key(nodes[old_id]) == key:
            return old_id
        matches = by_key[key]
        if not matches and old_id in before["relocatable"]:
            moved = by_symbol[before["relocatable"][old_id]]
            if len(moved) == 1 and _is_ast_tier(nodes[moved[0]]):
                return moved[0]
        if len(matches) != 1:
            raise RuntimeError("protected_identity_missing_or_ambiguous")
        return matches[0]

    for old_id, old in before["nodes"].items():
        current = nodes[target(old_id)]
        if _is_ast_tier(current) != _is_ast_tier(old):
            raise RuntimeError("protected_node_origin_changed")
        derived = {"id", "community", "community_name", "norm_label", "label"}
        if _is_ast_tier(old):
            derived.add("_origin")
        if any(current.get(key) != value for key, value in old.items() if key not in derived):
            raise RuntimeError("protected_node_attributes_changed")
    edges = graph.get("links", graph.get("edges", []))
    available = Counter(edge_key(edge) for edge in edges)
    pairs = {frozenset((edge["source"], edge["target"])) for edge in edges}
    restored, expected = 0, set()
    for old in before["edges"]:
        edge = {**old, "source": target(old["source"]), "target": target(old["target"])}
        key = edge_key(edge)
        if key in expected:
            continue  # Legacy id aliases can converge on one identical simple-graph edge.
        expected.add(key)
        if available[key]:
            available[key] -= 1
            continue
        pair = frozenset((edge["source"], edge["target"]))
        if not restore or pair in pairs or edge["source"] == edge["target"]:
            same_pair = [item for item in edges if frozenset((item["source"], item["target"])) == pair]
            raise RuntimeError("protected_relation_missing_or_changed: " + packed({
                "restore": restore, "prior": old, "rebound": edge,
                "candidateSamePair": same_pair[:3], "candidateSamePairCount": len(same_pair)}))
        if _is_ast_tier(edge):
            edge["_origin"] = "ast"
        edges.append(edge)
        pairs.add(pair)
        restored += 1
    if Counter(map(packed, before["hyperedges"])) - Counter(map(packed, hyperedges(graph))):
        raise RuntimeError("protected_hyperedge_changed")
    before["normalizedEdgeCount"] = len(expected)
    if restore:
        for node in nodes.values():
            if node["id"] in before["communities"]:
                node["community"] = before["communities"][node["id"]]
    return restored


def validate(candidate, head, before):
    from graphify.cluster import community_member_sigs
    graph_path = candidate / "graph.json"
    graph = json.loads(graph_path.read_text(encoding="utf-8"))
    retain(before, graph, restore=False)
    ids = {node["id"] for node in graph["nodes"]}
    edges = graph["links"]
    if any(edge.get(side) not in ids for edge in edges for side in ("source", "target")):
        raise RuntimeError("dangling_edges")
    communities = json.loads((candidate / ".graphify_analysis.json").read_text())["communities"]
    members = [node for group in communities.values() for node in group]
    actual = {node["id"]: str(node.get("community")) for node in graph["nodes"]}
    if len(members) != len(ids) or set(members) != ids or any(actual[node] != cid for cid, group in communities.items() for node in group):
        raise RuntimeError("community_membership_mismatch")
    report = (candidate / "GRAPH_REPORT.md").read_text(encoding="utf-8")
    summary = f"{len(ids)} nodes · {len(edges)} edges · {len(communities)} communities"
    if graph.get("built_at_commit") != head or f"`{head[:8]}`" not in report or summary not in report:
        raise RuntimeError("graph_report_head_or_counts_mismatch")
    labels_path = candidate / ".graphify_labels.json"
    if labels_path.exists():
        labels = json.loads(labels_path.read_text())
        signatures = json.loads(labels_path.with_name(labels_path.name + ".sig").read_text())
        expected = {str(key): value for key, value in community_member_sigs({int(k): v for k, v in communities.items()}).items()}
        if set(labels) != set(communities) or signatures != expected:
            raise RuntimeError("community_labels_mismatch")
        if any(node.get("community_name") != labels[str(node["community"])] for node in graph["nodes"]):
            raise RuntimeError("node_community_label_mismatch")
    from graphify.paths import write_json_atomic, write_text_atomic
    write_json_atomic(graph_path, graph, ensure_ascii=False)
    if graph_path.stat().st_size >= MAX_BYTES:
        raise RuntimeError("candidate_exceeds_512_mib")
    graph_sha256 = file_sha256(graph_path)
    write_text_atomic(candidate / "GRAPH_REPORT.md", report + "\n- Managed input: working tree; the commit above is its base revision, not proof of a clean checkout.\n")
    return {"head": head, "nodes": len(ids), "edges": len(edges), "communities": len(communities),
            "graphSha256": graph_sha256,
            "graphBytes": graph_path.stat().st_size}


def native_command(native, arguments):
    sys.argv = ["graphify", *arguments]
    if native.main() not in (None, 0):
        raise RuntimeError("native_command_failed")


def produce(repo, candidate):
    repo, candidate = repo.resolve(), candidate.resolve()
    if not candidate.is_dir() or candidate == repo or candidate.is_relative_to(repo / "graphify-out"):
        raise RuntimeError("candidate_must_be_separate_from_current")
    if any(path.is_symlink() for path in candidate.rglob("*")):
        raise RuntimeError("candidate_symlink_not_allowed")
    os.environ.update(GRAPHIFY_OUT=str(candidate), GRAPHIFY_NO_BACKUP="1", GRAPHIFY_MAX_GRAPH_BYTES="2GB",
                      GRAPHIFY_NO_TIPS="1", GRAPHIFY_VIZ_NODE_LIMIT="0")
    import importlib
    cluster = importlib.import_module("graphify.cluster")
    from graphify.paths import GRAPHIFY_OUT, write_json_atomic
    if Path(GRAPHIFY_OUT).resolve() != candidate:
        raise RuntimeError("graphify_imported_before_candidate_binding")
    if importlib.metadata.version("graphifyy") != VERSION or hashlib.sha256(inspect.getsource(cluster.remap_communities_to_previous).encode()).hexdigest() != REMAP_SHA256:
        raise RuntimeError("graphify_runtime_changed_revalidate_adapter")
    head = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
    before = preserve_before(repo, json.loads((candidate / "graph.json").read_text(encoding="utf-8")))
    source_digest = source_snapshot(before["sources"].values(), copied_root=repo / "graphify-out")
    detector = importlib.import_module("graphify.detect")
    original_ignored = detector.ignored_predicate
    preserved = set(before["sources"].values())

    def ignored_predicate(*args, **kwargs):
        original = original_ignored(*args, **kwargs)
        return lambda path: False if str(Path(path).resolve()) in preserved else original(path)

    detector.ignored_predicate = ignored_predicate
    cluster.remap_communities_to_previous = remap_sparse
    native = importlib.import_module("graphify.__main__")
    native_command(native, ["update", str(repo), "--no-cluster"])
    graph = json.loads((candidate / "graph.json").read_text(encoding="utf-8"))
    restored = retain(before, graph, restore=True)
    graph["built_at_commit"] = head
    write_json_atomic(candidate / "graph.json", graph, ensure_ascii=False)
    del graph
    gc.collect()
    native_command(native, ["cluster-only", str(repo), "--graph", str(candidate / "graph.json"), "--no-label", "--no-viz"])
    result = validate(candidate, head, before)
    if source_snapshot(before["sources"].values(), copied_root=repo / "graphify-out") != source_digest:
        raise RuntimeError("source_changed: protected source changed during build")
    result.update(ok=True, inputKind="working-tree", runtimeVersion=VERSION,
                  protectedSourcePaths=sorted(Path(path).relative_to(repo).as_posix() for path in preserved),
                  protectedSourceStatSha256=source_digest,
                  retained={"sources": len(preserved), "nodes": len(before["nodes"]),
                  "edges": len(before["edges"]), "uniqueEdges": before["normalizedEdgeCount"],
                  "restoredEdges": restored, "semanticNodes": before["semanticNodes"],
                  "semanticEdges": before["semanticEdges"], "sourceStatSha256": source_digest, **before["retired"]})
    write_json_atomic(candidate / "managed-receipt.json", result, ensure_ascii=False)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    args = parser.parse_args()
    try:
        if not args.repo.is_absolute() or not args.candidate.is_absolute():
            raise RuntimeError("absolute_paths_required")
        print(json.dumps(produce(args.repo, args.candidate), ensure_ascii=False))
    except (Exception, SystemExit) as exc:
        print(json.dumps({"ok": False, "error": str(exc) or "native_command_failed"}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
