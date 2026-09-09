#!/usr/bin/env python3
"""Repository-local Graphify lifecycle. Graphify remains the graph producer."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import importlib.util
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid

SCRIPT = Path(__file__).resolve()
PRODUCER = SCRIPT.with_name("graphify-managed-producer.py")
EVENTS = ("post-commit", "post-checkout", "post-merge", "post-rewrite")
LOG_BYTES, LOG_BACKUPS, AST_BYTES, AST_DAYS = 2 * 1024**2, 3, 1024**3, 30
CORE = ("graph.json", "GRAPH_REPORT.md", ".graphify_analysis.json", ".graphify_labels.json",
        ".graphify_labels.json.sig", ".graphify_root", ".graphify_semantic_marker", "cost.json",
        ".graphify_build.json", ".graphify_python", "manifest.json")


def clean_environment():
    env = {key: value for key, value in os.environ.items()
           if not key.startswith("GIT_") and key not in {
               "PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE", "PYTHONSTARTUP", "PYTHONINSPECT",
               "GRAPHIFY_OUT", "GRAPHIFY_CHANGED", "GRAPHIFY_FORCE"}}
    env.update(PYTHONNOUSERSITE="1", PYTHONHASHSEED="0", PYTHONDONTWRITEBYTECODE="1", GRAPHIFY_NO_BACKUP="1")
    return env


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args], env=clean_environment())


def context(repo):
    repo = Path(git(repo, "rev-parse", "--show-toplevel").decode().strip()).resolve()
    git_dir = (repo / git(repo, "rev-parse", "--git-dir").decode().strip()).resolve()
    common = (repo / git(repo, "rev-parse", "--git-common-dir").decode().strip()).resolve()
    if git_dir != common:
        raise RuntimeError("Managed Graphify belongs to the main checkout; linked worktree skipped")
    state = git_dir / "graphify"
    if state.is_symlink():
        raise RuntimeError("Graphify control directory must not be a symlink")
    return repo, state


def read_json(path, fallback=None):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return fallback


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
        temporary.chmod(0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def source_snapshot(repo):
    digest = hashlib.sha256()
    paths = set(git(repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard").split(b"\0"))
    for raw in sorted(paths - {b""}):
        relative = os.fsdecode(raw)
        if "graphify-out" in Path(relative).parts:
            continue
        file = repo / relative
        try:
            st = file.lstat()
            identity = (st.st_mode, st.st_size, st.st_mtime_ns, st.st_ino,
                        os.readlink(file) if file.is_symlink() else "")
        except FileNotFoundError:
            identity = ("missing",)
        digest.update(raw + b"\0" + repr(identity).encode() + b"\0")
    return {"head": git(repo, "rev-parse", "HEAD").decode().strip(), "sources": digest.hexdigest()}


def hook_block(repo, event, manager=SCRIPT):
    # Keep Graphify's markers so an upstream reinstall can be detected/repaired.
    stem = "graphify-checkout-hook" if event == "post-checkout" else "graphify-hook"
    arguments = " ".join(shlex.quote(str(value)) for value in
                         (sys.executable, manager, "request", "--repo", repo, "--event", event))
    operation_guard = ("  for operation in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD; do\n"
                       "    [ ! -e \"$(git rev-parse --git-path \"$operation\")\" ] || exit 0\n"
                       "  done\n") if event in {"post-commit", "post-checkout"} else ""
    return (f"# {stem}-start\n(\n"
            f"  [ \"$(git rev-parse --show-toplevel 2>/dev/null)\" = {shlex.quote(str(repo))} ] || exit 0\n"
            f"{operation_guard}"
            f"  {arguments} </dev/null\n)\n# {stem}-end")


def hooks_path(repo):
    return (repo / git(repo, "rev-parse", "--git-path", "hooks").decode().strip()).resolve()


def alias_command(manager=SCRIPT):
    return "!" + " ".join(shlex.quote(str(value)) for value in (sys.executable, manager))


def repair_guidance(repo):
    for name in ("AGENTS.md", "CLAUDE.md"):
        file = repo / name
        if not file.is_file() or file.is_symlink():
            continue
        content = file.read_text()
        pattern = r"(?msi)^## graphify\s*\n.*?(?=^#{1,2} |\Z)"
        updated = re.sub(pattern, lambda match: match[0].replace("`graphify update .`", "`git meta-graphify run`"), content)
        if updated != content:
            file.write_text(updated)


def install(repo, state):
    from importlib.metadata import version
    if version("graphifyy") != "0.9.56":
        raise RuntimeError("Validate the producer adapter before wiring a different Graphify version")
    if not PRODUCER.is_file():
        raise RuntimeError("Managed Graphify producer is missing from the installed package")
    if not (repo / "graphify-out/graph.json").is_file():
        raise RuntimeError("An existing graph is required; managed refresh never seeds an empty replacement")
    if state.exists() and any(state.iterdir()) and not (state / "config.json").is_file():
        raise RuntimeError("Refusing to adopt an unregistered, nonempty Graphify control directory")
    existing = subprocess.run(["git", "-C", str(repo), "config", "--local", "--get", "alias.meta-graphify"],
                              env=clean_environment(), capture_output=True, text=True).stdout.strip()
    old_config = read_json(state / "config.json", {})
    if existing and existing not in {alias_command(), old_config.get("alias")}:
        raise RuntimeError("The local meta-graphify alias already belongs to another command")
    directory = hooks_path(repo)
    directory.mkdir(parents=True, exist_ok=True)
    state.mkdir(parents=True, exist_ok=True)
    runtime = state / "runtime"
    if runtime.is_symlink():
        raise RuntimeError("Managed Graphify runtime must not be a symlink")
    manager = runtime / SCRIPT.name
    # Hooks must survive removal of an npx cache or an installer checkout.
    # Serialize the two fixed runtime files against every active producer.
    with (state / "worker.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        runtime.mkdir(exist_ok=True)
        for source in (SCRIPT, PRODUCER):
            destination = runtime / source.name
            if destination.is_symlink():
                raise RuntimeError("Managed Graphify runtime script must not be a symlink")
            if source == destination:
                continue
            temporary = destination.with_name(destination.name + "." + uuid.uuid4().hex + ".tmp")
            try:
                with temporary.open("xb") as handle:
                    handle.write(source.read_bytes())
                temporary.chmod(0o600)
                os.replace(temporary, destination)
            finally:
                temporary.unlink(missing_ok=True)
    write_json(state / "config.json", {
        "schema": 1, "owner": "Meta_Kim", "repo": str(repo), "python": sys.executable,
        "manager": str(manager), "producer": str(runtime / PRODUCER.name), "alias": alias_command(manager), "graphifyVersion": "0.9.56",
        "current": "graphify-out", "events": EVENTS, "previousCopies": 1,
        "logBytes": LOG_BYTES, "logBackups": LOG_BACKUPS, "astCacheBytes": AST_BYTES,
        "astCacheDays": AST_DAYS, "modelCalls": False,
    })
    for event in EVENTS:
        hook = directory / event
        if hook.is_symlink():
            raise RuntimeError(f"Refusing to replace a symlink hook: {hook}")
        content = hook.read_text() if hook.exists() else "#!/bin/sh\n"
        backup = state / "original-hooks" / event
        if not backup.exists():
            backup.parent.mkdir(parents=True, exist_ok=True)
            backup.write_text(content)
        block = hook_block(repo, event, manager)
        pattern = r"# graphify-(?:checkout-)?hook-start.*?# graphify-(?:checkout-)?hook-end"
        matches = list(re.finditer(pattern, content, re.DOTALL))
        if len(matches) > 1:
            raise RuntimeError(f"Multiple Graphify blocks require reconciliation: {hook}")
        updated = re.sub(pattern, lambda _: block, content, flags=re.DOTALL) if matches else content + "\n" + block + "\n"
        if updated != content:
            hook.write_text(updated)
        hook.chmod(hook.stat().st_mode | 0o111)
    git(repo, "config", "--local", "alias.meta-graphify", alias_command(manager))
    repair_guidance(repo)
    return status(repo, state)


def status(repo, state):
    config = read_json(state / "config.json")
    manager = Path(config["manager"]) if config else SCRIPT
    directory = hooks_path(repo)
    hooks = {event: (directory / event).is_file() and hook_block(repo, event, manager) in (directory / event).read_text()
             for event in EVENTS}
    alias = subprocess.run(["git", "-C", str(repo), "config", "--local", "--get", "alias.meta-graphify"],
                           env=clean_environment(), capture_output=True, text=True).stdout.strip()
    runtime_ready = (bool(config) and manager.is_file() and not manager.is_symlink()
                     and Path(config["producer"]).is_file() and not Path(config["producer"]).is_symlink()
                     and not manager.parent.is_symlink())
    return {"installed": bool(config), "hooks": hooks, "aliasReady": alias == alias_command(manager),
            "wiringReady": runtime_ready and all(hooks.values()) and alias == alias_command(manager),
            "current": str(repo / "graphify-out"), "state": str(state),
            "lastRun": read_json(state / "status.json"), "lastSuccess": read_json(state / "success.json")}


def request(repo, state, event):
    config = read_json(state / "config.json")
    if not config:
        raise RuntimeError("Graphify lifecycle is not installed for this repository")
    write_json(state / "request.json", {"id": uuid.uuid4().hex, "event": event, "at": time.time()})
    subprocess.Popen([config["python"], config["manager"], "work", "--repo", str(repo)],
                     cwd=repo, env=clean_environment(), stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
                     close_fds=True)


def copy_seed(current, candidate):
    candidate.mkdir()
    for source in current.iterdir():
        name = source.name
        if name in {".rebuild.lock", ".pending_changes", "managed-receipt.json", ".graph.tmp.json"}:
            continue
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", name) and source.is_dir() and {p.name for p in source.iterdir()} <= set(CORE):
            continue  # Native dated backups are superseded by the one previous bundle.
        if source.is_symlink():
            raise RuntimeError(f"Graph seed is not a plain artifact: {source}")
        # APFS clones avoid another physical full graph copy; never use hard links.
        cloned = sys.platform == "darwin" and subprocess.run(
            ["/bin/cp", "-cR", str(source), str(candidate / name)], capture_output=True).returncode == 0
        if not cloned:
            if source.is_dir():
                shutil.copytree(source, candidate / name, dirs_exist_ok=True)
            else:
                shutil.copy2(source, candidate / name)


def output_snapshot(output):
    rows = []
    for directory, subdirs, files in os.walk(output, followlinks=False):
        subdirs[:] = [name for name in subdirs if name != "cache"]
        for name in sorted(files):
            if name in {".rebuild.lock", ".pending_changes"}:
                continue
            file = Path(directory) / name
            st = file.lstat()
            rows.append((str(file.relative_to(output)), st.st_mode, st.st_size, st.st_mtime_ns, st.st_ino))
    return hashlib.sha256(json.dumps(sorted(rows)).encode()).hexdigest()


def protected_snapshot(repo, receipt):
    paths = receipt.get("protectedSourcePaths")
    if paths is None:
        return None
    sources = []
    for relative in paths:
        file = (repo / relative).resolve()
        if not file.is_relative_to(repo):
            raise RuntimeError("Protected source resolves outside the repository")
        if not file.is_file():
            return None
        sources.append(str(file))
    spec = importlib.util.spec_from_file_location("managed_graph_producer", PRODUCER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.source_snapshot(sources, copied_root=repo / "graphify-out")


def graph_digest(output):
    digest = hashlib.sha256()
    with (output / "graph.json").open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def clean_ast_cache(output):
    cache = output / "cache/ast"
    if not cache.is_dir() or cache.is_symlink():
        return
    files = [(file.stat().st_mtime, file.stat().st_size, file)
             for file in cache.rglob("*") if file.is_file() and not file.is_symlink()]
    total = sum(size for _, size, _ in files)
    for modified, size, file in sorted(files):
        if modified < time.time() - AST_DAYS * 86400 or total > AST_BYTES:
            file.unlink()
            total -= size


def run_producer(repo, candidate, logger):
    process = subprocess.Popen([sys.executable, str(PRODUCER), "--repo", str(repo), "--candidate", str(candidate)],
                               cwd=repo, env=clean_environment(), stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, start_new_session=True)
    timed_out = threading.Event()

    def expire():
        timed_out.set()
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    timer = threading.Timer(900, expire)
    timer.start()
    try:
        for line in process.stdout:
            logger.info(line.rstrip()[:8192])
        code = process.wait()
        if code or timed_out.is_set():
            raise RuntimeError(f"Graphify producer failed: exit={code}, timeout={timed_out.is_set()}")
    finally:
        timer.cancel()
        timer.join()
        # Cancellation must not leave the detached producer writing a candidate.
        # Do not poll first: an unreaped child still owns its process-group id.
        if process.returncode is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        process.wait()
        process.stdout.close()


def publish(current, candidate, previous):
    if previous.exists():
        shutil.rmtree(previous)
    try:
        os.replace(current, previous)
        os.replace(candidate, current)
    except BaseException:
        if not current.exists() and previous.exists():
            os.replace(previous, current)
        raise


def work(repo, state):
    config = read_json(state / "config.json", {})
    if config.get("owner") != "Meta_Kim" or config.get("repo") != str(repo):
        raise RuntimeError("An installed Meta_Kim lifecycle is required before writing graph artifacts")
    state.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("metaj.graphify")
    logger.setLevel(logging.INFO)
    with (state / "worker.lock").open("a") as lock:
        # Waiting workers recheck the single latest request after acquiring the lock.
        fcntl.flock(lock, fcntl.LOCK_EX)
        handler = RotatingFileHandler(state / "worker.log", maxBytes=LOG_BYTES, backupCount=LOG_BACKUPS, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
        logger.addHandler(handler)
        current, candidate, previous = repo / "graphify-out", state / "candidate", state / "previous"
        item = None
        signals = (signal.SIGTERM, signal.SIGINT)
        original_handlers = {number: signal.getsignal(number) for number in signals}

        def cancel(number, _frame):
            # A second supervisor signal must not interrupt child reaping/rollback.
            for target in signals:
                signal.signal(target, signal.SIG_IGN)
            raise RuntimeError(f"Graphify refresh cancelled: {signal.Signals(number).name}")

        try:
            for number in signals:
                signal.signal(number, cancel)
            if not current.exists() and previous.exists():
                os.replace(previous, current)
                logger.info("Recovered the previous graph after an interrupted directory promotion")
            for attempt in range(3):
                item = read_json(state / "request.json")
                if not item:
                    return
                last = read_json(state / "status.json", {})
                if last.get("request", {}).get("id") == item["id"] and last.get("status") in {"success", "unchanged"}:
                    return
                started = time.time()
                source = source_snapshot(repo)
                success = read_json(state / "success.json", {})
                prior_receipt = success.get("receipt", {})
                current_output = output_snapshot(current)
                if (success.get("source") == source and success.get("outputSnapshot") == current_output
                        and prior_receipt.get("graphSha256") == graph_digest(current)
                        and success.get("protectedOutputStatSha256") == protected_snapshot(repo, prior_receipt)):
                    write_json(state / "status.json", {"status": "unchanged", "request": item, "at": started, "source": source})
                    if read_json(state / "request.json")["id"] == item["id"]:
                        return
                    continue
                write_json(state / "status.json", {"status": "running", "request": item, "startedAt": started, "pid": os.getpid()})
                logger.info("Start %s %s attempt=%s", item["event"], item["id"], attempt + 1)
                if candidate.exists():
                    shutil.rmtree(candidate)
                copy_seed(current, candidate)
                run_producer(repo, candidate, logger)
                if source_snapshot(repo) != source:
                    logger.info("Sources changed during refresh; discard candidate and retry")
                    shutil.rmtree(candidate)
                    time.sleep(3)
                    continue
                if output_snapshot(current) != current_output:
                    raise RuntimeError("Another writer changed the current graph; candidate was not published")
                receipt = read_json(candidate / "managed-receipt.json")
                if (not receipt or receipt.get("ok") is not True or receipt.get("head") != source["head"]
                        or receipt.get("graphSha256") != graph_digest(candidate)):
                    raise RuntimeError("Producer returned without a matching verified receipt")
                clean_ast_cache(candidate)
                publish(current, candidate, previous)
                # Rollback needs the verified bundle, not a duplicate extraction cache.
                if (previous / "cache/ast").is_dir() and not (previous / "cache/ast").is_symlink():
                    shutil.rmtree(previous / "cache/ast")
                result = {"status": "success", "request": item, "startedAt": started, "finishedAt": time.time(),
                          "source": source, "outputSnapshot": output_snapshot(current),
                          "protectedOutputStatSha256": protected_snapshot(repo, receipt), "receipt": receipt}
                write_json(state / "success.json", result)
                write_json(state / "status.json", result)
                logger.info("Published verified graph in %.1fs", time.time() - started)
                if read_json(state / "request.json")["id"] == item["id"]:
                    return
            raise RuntimeError("Sources kept changing; retained last valid graph and pending request")
        except BaseException as error:
            logger.exception("Refresh failed; current graph remains available")
            write_json(state / "status.json", {"status": "failed", "request": item,
                                               "at": time.time(), "error": str(error)})
            raise
        finally:
            try:
                if candidate.exists():
                    shutil.rmtree(candidate)
                logger.removeHandler(handler)
                handler.close()
            finally:
                for number, original in original_handlers.items():
                    signal.signal(number, original)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("install", "status", "request", "work", "run", "query", "path", "explain"))
    parser.add_argument("--repo", default=os.getcwd())
    parser.add_argument("--event", default="managed-rebuild")
    args, forwarded = parser.parse_known_args()
    if forwarded and args.command not in {"query", "path", "explain"}:
        parser.error("unrecognized arguments: " + " ".join(forwarded))
    repo, state = context(args.repo)
    config = read_json(state / "config.json", {})
    registered = Path(config.get("manager", SCRIPT))
    if config and args.command not in {"install", "status"}:
        if registered.is_symlink() or registered.parent.is_symlink() or Path(config["producer"]).is_symlink():
            raise RuntimeError("Managed Graphify runtime script must not be a symlink")
    if args.command not in {"install", "status"} and registered != SCRIPT:
        os.execv(sys.executable, [sys.executable, str(registered), *sys.argv[1:]])
    if args.command == "install":
        print(json.dumps(install(repo, state), ensure_ascii=False))
    elif args.command == "status":
        result = status(repo, state)
        print(json.dumps(result, ensure_ascii=False))
        return 1 if result["installed"] and not result["wiringReady"] else 0
    elif args.command == "request":
        request(repo, state, args.event)
    elif args.command in {"query", "path", "explain"}:
        env = {**clean_environment(), "GRAPHIFY_OUT": str(repo / "graphify-out")}
        return subprocess.run([sys.executable, "-m", "graphify", args.command, *forwarded], cwd=repo, env=env).returncode
    else:
        if args.command == "run":
            write_json(state / "request.json", {"id": uuid.uuid4().hex, "event": args.event, "at": time.time()})
        work(repo, state)
        print(json.dumps(status(repo, state), ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(main())
