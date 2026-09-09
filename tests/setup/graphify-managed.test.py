"""Repository-managed Graphify lifecycle tests.

These tests use the real installed graphifyy runtime for the happy path and
patch only the manager producer boundary for failure/race cases.
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/graphify-managed.py"
spec = importlib.util.spec_from_file_location("graphify_managed", SCRIPT)
managed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(managed)


class ManagedGraphifyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="graphify-managed-test-")
        self.base = Path(self.tmp.name).resolve()
        self.home = self.base / "home"
        self.home.mkdir()
        self.repo = self.base / "repo"
        self.repo.mkdir()
        self.env = {
            **os.environ,
            "HOME": str(self.home),
            "XDG_CACHE_HOME": str(self.home / ".cache"),
            "XDG_CONFIG_HOME": str(self.home / ".config"),
            "GRAPHIFY_NO_BACKUP": "1",
            "GRAPHIFY_NO_TIPS": "1",
            "GRAPHIFY_MAX_WORKERS": "1",
            "PYTHONHASHSEED": "0",
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        (self.repo / ".gitignore").write_text("graphify-out/\n")
        (self.repo / "app.py").write_text("def alpha():\n    return 1\n")
        self.git("add", ".gitignore", "app.py")
        self.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "initial")

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args, check=True, **kwargs):
        return subprocess.run(
            ["git", "-C", str(self.repo), *args],
            env=self.env,
            text=True,
            capture_output=True,
            check=check,
            **kwargs,
        )

    def run_manager(self, *args, check=True, timeout=120):
        completed = subprocess.run(
            [sys.executable, str(SCRIPT), *args, "--repo", str(self.repo)],
            cwd=self.repo,
            env=self.env,
            text=True,
            capture_output=True,
            timeout=timeout,
        )
        if check and completed.returncode:
            self.fail(completed.stdout + completed.stderr)
        return completed

    def write_minimal_native_graph(self):
        graph_dir = self.repo / "graphify-out"
        env = {**self.env, "GRAPHIFY_OUT": str(graph_dir)}
        for args in (("update", str(self.repo), "--no-cluster"),
                     ("cluster-only", str(self.repo), "--no-label", "--no-viz")):
            completed = subprocess.run(
                [sys.executable, "-m", "graphify", *args],
                cwd=self.repo,
                env=env,
                text=True,
                capture_output=True,
                timeout=60,
            )
            if completed.returncode:
                self.fail(completed.stdout + completed.stderr)
        self.assertTrue((graph_dir / "graph.json").is_file())
        self.assertTrue((graph_dir / "GRAPH_REPORT.md").is_file())
        return graph_dir

    def test_hooks_survive_removal_of_the_installer_package(self):
        self.write_minimal_native_graph()
        package = self.base / "ephemeral-package"
        package.mkdir()
        for source in (SCRIPT, managed.PRODUCER):
            shutil.copy2(source, package / source.name)
        subprocess.run([sys.executable, str(package / SCRIPT.name), "install", "--repo", str(self.repo)],
                       env=self.env, cwd=self.repo, capture_output=True, check=True)
        shutil.rmtree(package)
        configured = json.loads((self.repo / ".git/graphify/config.json").read_text())
        self.assertEqual(Path(configured["manager"]), self.repo / ".git/graphify/runtime/graphify-managed.py")
        refreshed = self.git("meta-graphify", "run", timeout=60)
        result = json.loads(refreshed.stdout.splitlines()[-1])
        self.assertTrue(result["wiringReady"])
        self.assertEqual(result["lastRun"]["status"], "success")

    def test_runtime_symlinks_never_overwrite_or_execute_external_files(self):
        self.write_minimal_native_graph()
        self.run_manager("install")
        runtime = self.repo / ".git/graphify/runtime"
        executed = self.base / "external-executed"
        external = self.base / "outside-runtime.py"
        original = f"from pathlib import Path\nPath({str(executed)!r}).write_text('executed')\n".encode()
        external.write_bytes(original)
        old_temporary = runtime / "graphify-managed.tmp"
        old_temporary.symlink_to(external)
        self.run_manager("install")
        self.assertEqual(external.read_bytes(), original)
        self.assertTrue(old_temporary.is_symlink())
        self.assertFalse((runtime / SCRIPT.name).is_symlink())
        for name in (SCRIPT.name, managed.PRODUCER.name):
            with self.subTest(script=name):
                script = runtime / name
                content = script.read_bytes()
                script.unlink()
                script.symlink_to(external)
                try:
                    status = self.run_manager("status", check=False)
                    self.assertNotEqual(status.returncode, 0)
                    self.assertFalse(json.loads(status.stdout)["wiringReady"])
                    install = self.run_manager("install", check=False)
                    self.assertNotEqual(install.returncode, 0)
                    self.assertIn("symlink", install.stderr)
                    run = self.run_manager("run", check=False)
                    self.assertNotEqual(run.returncode, 0)
                    self.assertIn("symlink", run.stderr)
                    if name == managed.PRODUCER.name:
                        alias = self.git("meta-graphify", "run", check=False)
                        self.assertNotEqual(alias.returncode, 0)
                        self.assertIn("symlink", alias.stderr)
                    self.assertEqual(external.read_bytes(), original)
                    self.assertFalse(executed.exists())
                    self.assertTrue(script.is_symlink())
                finally:
                    script.unlink()
                    script.write_bytes(content)
                    script.chmod(0o600)

    def read_status(self):
        completed = self.run_manager("status")
        return json.loads(completed.stdout)

    def wait_for_event(self, event, since, timeout=90):
        deadline = time.time() + timeout
        while time.time() < deadline:
            status = self.read_status()
            last = status.get("lastRun") or {}
            request = last.get("request") or {}
            finished = last.get("finishedAt") or last.get("at") or 0
            if request.get("event") == event and finished >= since and last.get("status") in {"success", "unchanged"}:
                return status
            time.sleep(0.5)
        self.fail(f"timed out waiting for {event}; last status={self.read_status()}")

    def install_with_custom_hooks(self):
        self.write_minimal_native_graph()
        (self.repo / "AGENTS.md").write_text("# Project\nKeep original instructions.\n\n## graphify\nRun `graphify update .`.\n\n## Other rules\nKeep this too.\n")
        hooks = self.repo / ".git" / "hooks"
        upstream = "# graphify-hook-start\nold upstream bytes\n# graphify-hook-end\n"
        checkout = "# graphify-checkout-hook-start\nold checkout bytes\n# graphify-checkout-hook-end\n"
        for name, block in {
            "post-commit": upstream,
            "post-checkout": checkout,
            "post-merge": upstream,
            "post-rewrite": upstream,
        }.items():
            (hooks / name).write_text(f"#!/bin/sh\necho before-{name}\n{block}echo after-{name}\n")
            (hooks / name).chmod(0o755)
        self.run_manager("install")
        return hooks

    def test_install_rewrites_native_hook_blocks_preserves_custom_bytes_and_is_idempotent(self):
        hooks = self.install_with_custom_hooks()
        first = {}
        for event in managed.EVENTS:
            content = (hooks / event).read_text()
            self.assertIn(f"echo before-{event}", content)
            self.assertIn(f"echo after-{event}", content)
            self.assertIn("graphify-managed.py", content)
            self.assertIn(" request --repo ", content)
            self.assertNotIn("old upstream bytes", content)
            self.assertNotIn("old checkout bytes", content)
            first[event] = content
        self.run_manager("install")
        self.assertEqual(first, {event: (hooks / event).read_text() for event in managed.EVENTS})
        status = self.read_status()
        self.assertTrue(status["installed"])
        self.assertTrue(status["wiringReady"])
        self.assertEqual(set(status["hooks"]), set(managed.EVENTS))
        self.assertTrue(all(status["hooks"].values()))
        guide = (self.repo / "AGENTS.md").read_text()
        self.assertIn("`git meta-graphify run`", guide)
        self.assertIn("Keep original instructions.", guide)
        self.assertIn("## Other rules\nKeep this too.", guide)
        self.assertNotIn("`graphify update .`", guide)
        self.assertTrue(json.loads(self.git("meta-graphify", "status").stdout)["aliasReady"])

    def test_real_git_dispatcher_triggers_four_events_with_native_producer(self):
        self.install_with_custom_hooks()

        (self.repo / "app.py").write_text("def alpha():\n    return 2\n")
        self.git("add", "app.py")
        since = time.time() - 0.1
        self.git("commit", "-qm", "post commit event")
        self.wait_for_event("post-commit", since)

        since = time.time() - 0.1
        self.git("checkout", "-qb", "side")
        self.wait_for_event("post-checkout", since)

        (self.repo / "rewrite.py").write_text("def rewritten():\n    return 1\n")
        self.git("add", "rewrite.py")
        since = time.time() - 0.1
        self.git("commit", "--amend", "--no-edit")
        self.wait_for_event("post-rewrite", since)

        self.git("-c", "core.hooksPath=/dev/null", "checkout", "-q", "master")
        self.git("-c", "core.hooksPath=/dev/null", "checkout", "-qb", "merge-source")
        (self.repo / "merge.py").write_text("def merged():\n    return 1\n")
        self.git("add", "merge.py")
        self.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "merge source")
        self.git("-c", "core.hooksPath=/dev/null", "checkout", "-q", "master")
        since = time.time() - 0.1
        self.git("merge", "--no-ff", "merge-source", "-m", "merge event")
        status = self.wait_for_event("post-merge", since)
        self.assertIn(status["lastRun"]["status"], {"success", "unchanged"})
        self.assertEqual(status["lastSuccess"]["receipt"]["runtimeVersion"], "0.9.56")

    def prepare_managed_state(self):
        self.write_minimal_native_graph()
        repo, state = managed.context(self.repo)
        state.mkdir(parents=True, exist_ok=True)
        managed.write_json(state / "config.json", {
            "schema": 1,
            "owner": "Meta_Kim",
            "repo": str(repo),
            "python": sys.executable,
            "manager": str(SCRIPT),
            "producer": str(SCRIPT.with_name("graphify-managed-producer.py")),
        })
        return repo, state

    def test_failed_producer_does_not_modify_current(self):
        repo, state = self.prepare_managed_state()
        managed.write_json(state / "request.json", {"id": "failed", "event": "manual", "at": time.time()})
        current_graph = (repo / "graphify-out" / "graph.json").read_bytes()
        original = managed.run_producer
        try:
            managed.run_producer = lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("producer failed"))
            with self.assertRaisesRegex(RuntimeError, "producer failed"):
                managed.work(repo, state)
        finally:
            managed.run_producer = original
        self.assertEqual(current_graph, (repo / "graphify-out" / "graph.json").read_bytes())
        self.assertFalse((state / "candidate").exists())
        status = json.loads((state / "status.json").read_text())
        self.assertEqual(status["status"], "failed")

    def test_real_termination_reaps_producer_and_cleans_candidate(self):
        repo, state = self.prepare_managed_state()
        original_graph = (repo / "graphify-out/graph.json").read_bytes()
        for number in (signal.SIGTERM, signal.SIGINT):
            with self.subTest(signal=number.name):
                marker = self.base / f"producer-{number.name}.pid"
                sleeper = self.base / f"producer-{number.name}.py"
                sleeper.write_text(
                    "import os, time\nfrom pathlib import Path\n"
                    f"Path({str(marker)!r}).write_text(str(os.getpid()))\n"
                    "time.sleep(30)\n"
                )
                harness = self.base / "manager-harness.py"
                harness.write_text(
                    "import importlib.util, sys\nfrom pathlib import Path\n"
                    f"spec = importlib.util.spec_from_file_location('manager', {str(SCRIPT)!r})\n"
                    "manager = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(manager)\n"
                    f"manager.PRODUCER = Path({str(sleeper)!r})\n"
                    f"sys.argv = [{str(SCRIPT)!r}, 'run', '--repo', {str(repo)!r}]\n"
                    "sys.exit(manager.main())\n"
                )
                process = subprocess.Popen(
                    [sys.executable, str(harness)], cwd=repo, env=self.env,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True,
                )
                producer_pid = None
                try:
                    deadline = time.time() + 10
                    while not marker.exists() and process.poll() is None and time.time() < deadline:
                        time.sleep(0.05)
                    self.assertTrue(marker.exists(), "Producer did not reach its isolated wait")
                    producer_pid = int(marker.read_text())
                    self.assertEqual(os.getpgid(producer_pid), producer_pid)
                    self.assertTrue((state / "candidate").is_dir())
                    os.killpg(process.pid, number)
                    stdout, stderr = process.communicate(timeout=10)
                    self.assertNotEqual(process.returncode, 0, stdout + stderr)
                    with self.assertRaises(ProcessLookupError):
                        os.kill(producer_pid, 0)
                    self.assertFalse((state / "candidate").exists())
                    self.assertEqual((repo / "graphify-out/graph.json").read_bytes(), original_graph)
                    status = json.loads((state / "status.json").read_text())
                    self.assertEqual(status["status"], "failed")
                    self.assertIn(f"cancelled: {number.name}", status["error"])
                finally:
                    if process.poll() is None:
                        os.killpg(process.pid, signal.SIGKILL)
                    process.communicate()
                    if producer_pid:
                        try:
                            os.killpg(producer_pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass

    def test_concurrent_latest_coalescing_keeps_final_request_state(self):
        repo, state = self.prepare_managed_state()
        first = {"id": "first", "event": "post-commit", "at": time.time()}
        latest = {"id": "latest", "event": "post-merge", "at": time.time() + 1}
        managed.write_json(state / "request.json", first)
        original = managed.run_producer
        calls = []

        def fake_producer(_repo, candidate, _logger):
            calls.append(candidate)
            original(_repo, candidate, _logger)
            if len(calls) == 1:
                managed.write_json(state / "request.json", latest)

        try:
            managed.run_producer = fake_producer
            managed.work(repo, state)
        finally:
            managed.run_producer = original
        status = json.loads((state / "status.json").read_text())
        self.assertEqual(status["request"]["id"], "latest")
        self.assertEqual(status["status"], "unchanged")
        success = json.loads((state / "success.json").read_text())
        self.assertEqual(success["request"]["id"], "first")
        self.assertEqual(len(calls), 1)
        self.assertTrue((repo / "graphify-out" / "managed-receipt.json").is_file())

    def test_manual_memory_build_boundary_and_cost_record_survive_two_promotions(self):
        self.install_with_custom_hooks()
        current = self.repo / "graphify-out"
        records = {"memory/answer.md": "User supplied Q&A\n", "reflections/LESSONS.md": "Keep this lesson\n",
                   "cost.json": "{\"input_tokens\": 13}\n", ".graphify_semantic_marker": "1\n"}
        for relative, content in records.items():
            file = current / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(content)
        for revision in (3, 4):
            (self.repo / "app.py").write_text(f"def alpha():\n    return {revision}\n")
            self.run_manager("run")
            for relative, content in records.items():
                self.assertEqual((current / relative).read_text(), content)
        self.assertFalse((self.repo / ".git/graphify/candidate").exists())
        self.assertEqual(len(list((self.repo / ".git/graphify").glob("previous*"))), 1)

    def test_ignored_source_change_cannot_take_unchanged_fast_path(self):
        ignored = self.repo / "keep.md"
        ignored.write_text("# Known knowledge\nOriginal body.\n")
        self.install_with_custom_hooks()
        (self.repo / ".gitignore").write_text("graphify-out/\nkeep.md\n")
        first = json.loads(self.run_manager("run").stdout.splitlines()[-1])
        self.assertIn("keep.md", first["lastSuccess"]["receipt"]["protectedSourcePaths"])
        ignored.write_text("# Known knowledge\nChanged body.\n")
        second = json.loads(self.run_manager("run").stdout.splitlines()[-1])
        self.assertEqual(second["lastRun"]["status"], "success")
        self.assertNotEqual(first["lastSuccess"]["protectedOutputStatSha256"], second["lastSuccess"]["protectedOutputStatSha256"])

    def test_publish_exception_restores_previous_current(self):
        current = self.base / "current"
        candidate = self.base / "candidate"
        previous = self.base / "previous"
        current.mkdir()
        candidate.mkdir()
        (current / "graph.json").write_text("current")
        (candidate / "graph.json").write_text("candidate")
        original_replace = managed.os.replace
        calls = []

        def flaky_replace(src, dst):
            calls.append((Path(src).name, Path(dst).name))
            if len(calls) == 2:
                raise OSError("promotion failed")
            return original_replace(src, dst)

        try:
            managed.os.replace = flaky_replace
            with self.assertRaisesRegex(OSError, "promotion failed"):
                managed.publish(current, candidate, previous)
        finally:
            managed.os.replace = original_replace
        self.assertTrue(current.is_dir())
        self.assertEqual((current / "graph.json").read_text(), "current")
        self.assertTrue(candidate.is_dir())
        self.assertFalse(previous.exists())

    def test_clean_ast_cache_enforces_age_and_size_bound_without_touching_other_cache(self):
        output = self.base / "output"
        ast = output / "cache" / "ast"
        converted = output / "converted"
        ast.mkdir(parents=True)
        converted.mkdir(parents=True)
        old = ast / "old.bin"
        huge = ast / "huge.bin"
        fresh = ast / "fresh.bin"
        other = converted / "keep.bin"
        old.write_bytes(b"old")
        cutoff = time.time() - 31 * 86400
        os.utime(old, (cutoff, cutoff))
        with huge.open("wb") as handle:
            handle.seek(1024 ** 3 + 128)
            handle.write(b"x")
        fresh.write_bytes(b"fresh")
        other.write_bytes(b"converted")
        managed.clean_ast_cache(output)
        self.assertFalse(old.exists())
        self.assertFalse(huge.exists())
        self.assertTrue(fresh.exists())
        self.assertTrue(other.exists())


if __name__ == "__main__":
    unittest.main()
