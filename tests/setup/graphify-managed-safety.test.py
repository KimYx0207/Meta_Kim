"""Isolated manager safety checks; no third-party runtime or model calls."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/graphify-managed.py"
spec = importlib.util.spec_from_file_location("managed_safety", SCRIPT)
managed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(managed)


class ManagedSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="meta-graph-safety-")
        self.base = Path(self.tmp.name).resolve()
        self.repo = self.make_repo("repo")

    def tearDown(self):
        self.tmp.cleanup()

    def make_repo(self, name):
        repo = self.base / name
        repo.mkdir()
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        (repo / ".gitignore").write_text("graphify-out/\n")
        subprocess.run(["git", "-C", str(repo), "add", ".gitignore"], check=True)
        subprocess.run(["git", "-C", str(repo), "-c", "core.hooksPath=/dev/null",
                        "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                        "commit", "-qm", "fixture"], check=True)
        current = repo / "graphify-out"
        current.mkdir()
        (current / "graph.json").write_text('{"nodes": [], "links": []}\n')
        return repo

    def prepare_state(self):
        repo, state = managed.context(self.repo)
        state.mkdir(parents=True)
        managed.write_json(state / "config.json", {"owner": "Meta_Kim", "repo": str(repo)})
        managed.write_json(state / "request.json", {"id": "safety", "event": "manual", "at": time.time()})
        return repo, state

    def fake_producer(self, repo, candidate, _logger):
        managed.write_json(candidate / "managed-receipt.json", {
            "ok": True,
            "head": managed.source_snapshot(repo)["head"],
            "graphSha256": managed.graph_digest(candidate),
        })

    def test_graph_root_symlink_never_deletes_external_cache(self):
        repo, state = self.prepare_state()
        current = repo / "graphify-out"
        outside = self.base / "outside-graph"
        current.rename(outside)
        sentinel = outside / "cache/ast/keep.txt"
        sentinel.parent.mkdir(parents=True)
        sentinel.write_text("outside must survive\n")
        current.symlink_to(outside, target_is_directory=True)
        error = None
        with patch.object(managed, "run_producer", self.fake_producer):
            try:
                managed.work(repo, state)
            except RuntimeError as exc:
                error = exc
        self.assertTrue(sentinel.exists(), "refresh deleted the external cache sentinel")
        self.assertEqual(sentinel.read_text(), "outside must survive\n")
        self.assertIsNotNone(error, "linked graph root must fail before promotion")
        self.assertTrue(current.is_symlink())
        self.assertFalse((state / "previous").exists())

    def test_shared_hooks_refuse_another_repository_without_mutating_registration(self):
        second = self.make_repo("second")
        shared = self.base / "shared-hooks"
        shared.mkdir()
        (shared / "post-commit").write_text("#!/bin/sh\n# user-owned prelude\n")
        for repo in (self.repo, second):
            subprocess.run(["git", "-C", str(repo), "config", "core.hooksPath", str(shared)], check=True)
        with patch("importlib.metadata.version", return_value="0.9.56"):
            repo, state = managed.context(self.repo)
            managed.install(repo, state)
            before = {p.name: p.read_bytes() for p in shared.iterdir() if p.is_file()}
            repo2, state2 = managed.context(second)
            with self.assertRaisesRegex(RuntimeError, "another repository|different repository"):
                managed.install(repo2, state2)
            after = {p.name: p.read_bytes() for p in shared.iterdir() if p.is_file()}
            self.assertEqual(after, before)
            self.assertFalse(state2.exists(), "foreign hook registration must be refused before installing runtime state")
            self.assertTrue(managed.status(repo, state)["wiringReady"])
            managed.install(repo, state)
            self.assertEqual({p.name: p.read_bytes() for p in shared.iterdir() if p.is_file()}, before)

    def test_linked_and_broken_control_paths_fail_before_external_changes(self):
        for relative in ("graphify-out", ".git/graphify", ".git/graphify/candidate", ".git/graphify/previous"):
            for broken in (False, True):
                with self.subTest(path=relative, broken=broken):
                    repo = self.make_repo(f"links-{len(list(self.base.iterdir()))}")
                    target = repo / relative
                    if target.exists():
                        target.rename(repo / "retained-original")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    external = self.base / f"outside-{len(list(self.base.iterdir()))}"
                    if not broken:
                        external.mkdir()
                        (external / "sentinel").write_text("keep\n")
                    target.symlink_to(external, target_is_directory=True)
                    with self.assertRaisesRegex(RuntimeError, "symlink"):
                        managed.context(repo)
                    self.assertTrue(target.is_symlink())
                    if not broken:
                        self.assertEqual((external / "sentinel").read_text(), "keep\n")

    def test_nested_seed_and_cache_links_are_rejected(self):
        outside = self.base / "external-cache"
        outside.mkdir()
        sentinel = outside / "keep.txt"
        sentinel.write_text("keep\n")
        current = self.repo / "graphify-out"
        (current / "cache").mkdir()
        (current / "cache/ast").symlink_to(outside, target_is_directory=True)
        candidate = self.repo / "candidate"
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            managed.copy_seed(current, candidate)
        self.assertFalse(candidate.exists())
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            managed.clean_ast_cache(current)
        self.assertEqual(sentinel.read_text(), "keep\n")

    def test_cleanup_uses_held_parent_descriptor_during_directory_replacement(self):
        state = self.repo / ".git/graphify"
        candidate = state / "candidate"
        candidate.mkdir(parents=True)
        (candidate / "owned").write_text("owned\n")
        external = self.base / "outside-swap"
        (external / "candidate").mkdir(parents=True)
        sentinel = external / "candidate/sentinel"
        sentinel.write_text("keep\n")
        previous_state = state.with_name("graphify-original")
        original_rmtree = managed.shutil.rmtree
        invoked = []

        def replace_parent_before_remove(target, *args, **kwargs):
            self.assertIsNotNone(kwargs.get("dir_fd"), "cleanup must be descriptor anchored")
            invoked.append(target)
            state.rename(previous_state)
            state.symlink_to(external, target_is_directory=True)
            return original_rmtree(target, *args, **kwargs)

        replace_parent_before_remove.avoids_symlink_attacks = True
        with patch.object(managed.shutil, "rmtree", replace_parent_before_remove):
            managed.remove_managed_tree(self.repo, candidate)
        self.assertEqual(len(invoked), 1)
        self.assertEqual(sentinel.read_text(), "keep\n")
        self.assertFalse((previous_state / "candidate").exists())

    def test_foreign_legacy_registration_without_owner_marker_is_preserved(self):
        shared = self.base / "legacy-shared-hooks"
        shared.mkdir()
        other = self.make_repo("legacy-owner")
        block = managed.hook_block(other, "post-commit")
        block = "\n".join(line for line in block.splitlines() if not line.startswith("# meta-kim-repository:"))
        hook = shared / "post-commit"
        hook.write_text("#!/bin/sh\n" + block + "\n")
        original = hook.read_bytes()
        subprocess.run(["git", "-C", str(self.repo), "config", "core.hooksPath", str(shared)], check=True)
        repo, state = managed.context(self.repo)
        with self.assertRaisesRegex(RuntimeError, "another repository"):
            managed.install(repo, state)
        self.assertEqual(hook.read_bytes(), original)
        self.assertFalse(state.exists())

    def test_concurrent_shared_hook_installers_serialize_then_refuse_second_owner(self):
        second = self.make_repo("concurrent-second")
        shared = self.base / "concurrent-hooks"
        shared.mkdir()
        for repo in (self.repo, second):
            subprocess.run(["git", "-C", str(repo), "config", "core.hooksPath", str(shared)], check=True)
        acquired = self.base / "first-acquired"
        release = self.base / "release-first"
        second_started = self.base / "second-started"
        second_entered = self.base / "second-entered"
        harness = self.base / "install-harness.py"
        harness.write_text(
            "import importlib.util, sys, time\nfrom pathlib import Path\nfrom unittest.mock import patch\n"
            f"spec = importlib.util.spec_from_file_location('manager', {str(SCRIPT)!r})\n"
            "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n"
            "repo, state = m.context(Path(sys.argv[1])); original = m.install_locked\n"
            "def hold(repo, state):\n"
            f"    Path({str(acquired)!r} if sys.argv[2] == 'first' else {str(second_entered)!r}).write_text('entered')\n"
            "    if sys.argv[2] == 'first':\n"
            "        deadline = time.monotonic() + 10\n"
            f"        while not Path({str(release)!r}).exists():\n"
            "            if time.monotonic() > deadline: raise RuntimeError('fixture release timed out')\n"
            "            time.sleep(0.02)\n"
            "    return original(repo, state)\n"
            "m.install_locked = hold\n"
            f"if sys.argv[2] == 'second': Path({str(second_started)!r}).write_text('started')\n"
            "with patch('importlib.metadata.version', return_value='0.9.56'): m.install(repo, state)\n"
        )
        first = subprocess.Popen([sys.executable, str(harness), str(self.repo), "first"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        follower = None
        try:
            deadline = time.monotonic() + 5
            while not acquired.exists() and time.monotonic() < deadline and first.poll() is None:
                time.sleep(0.02)
            self.assertTrue(acquired.exists(), "first installer must reach the locked section")
            follower = subprocess.Popen([sys.executable, str(harness), str(second), "second"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 5
            while not second_started.exists() and time.monotonic() < deadline and follower.poll() is None:
                time.sleep(0.02)
            self.assertTrue(second_started.exists())
            time.sleep(0.2)
            self.assertIsNone(follower.poll(), "second installer must wait for the shared lock")
            self.assertFalse(second_entered.exists(), "second installer must not start state writes")
            release.write_text("release\n")
            first_output = first.communicate(timeout=10)
            second_output = follower.communicate(timeout=10)
            self.assertEqual(first.returncode, 0, str(first_output))
            self.assertNotEqual(follower.returncode, 0, str(second_output))
            self.assertIn("another repository", second_output[1])
            self.assertFalse(second_entered.exists())
            self.assertFalse((second / ".git/graphify").exists())
            self.assertTrue(managed.status(*managed.context(self.repo))["wiringReady"])
        finally:
            release.write_text("release\n")
            for process in (first, follower):
                if process is not None:
                    if process.poll() is None:
                        process.kill()
                    process.communicate()


if __name__ == "__main__":
    unittest.main()
