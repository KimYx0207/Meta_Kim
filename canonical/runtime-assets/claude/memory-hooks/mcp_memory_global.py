# -*- coding: utf-8 -*-
"""
Global MCP Memory Service Hook - SessionStart

Auto-loads memories from MCP Memory Service (doobidoo/mcp-memory-service)
at session start with LAYERED INJECTION to avoid context explosion:

  L1 (always, ~120 chars): Task state — "doing X, N done, M left"
  L2 (on demand, ~400 chars): Project memories with relevance filter
  L3 (user-triggered, ~800 chars): Recent global memories

Also reads local task state from .claude/project-task-state.json.

Usage:
  python mcp_memory_global.py --mode session    # SessionStart
  python mcp_memory_global.py --mode save --task "..." --done "..." --remaining "..."
  python mcp_memory_global.py --mode query-project   # Dump project state only (no MCP)
  python mcp_memory_global.py --mode query-memories  # Dump memories only
"""

import json
import os
import sys
import hashlib
import urllib.request
import urllib.error
import argparse
import re
import shutil
import subprocess
import tempfile
import time
from urllib.parse import urlparse
from datetime import datetime, timezone

os.environ.setdefault("NO_PROXY", "localhost,127.0.0.1")

# Force UTF-8 on stdout/stderr — Windows defaults to GBK which can't encode emoji
if sys.stdout and sys.stdout.encoding != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if sys.stderr and sys.stderr.encoding != "utf-8":
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

MEMORY_SERVICE_URL = os.environ.get(
    "MCP_MEMORY_URL",
    f"http://localhost:{os.environ.get('META_KIM_MEMORY_PORT', '8000')}",
)
MEMORY_LIMIT = int(os.environ.get("MCP_MEMORY_LIMIT", "10"))
TIMEOUT = 3
HEALTH_TIMEOUT = 0.5
MEMORY_HEALTH_WARNING_INTERVAL = int(os.environ.get("META_KIM_MEMORY_HEALTH_WARNING_INTERVAL_MS", str(60 * 60 * 1000))) / 1000
MEMORY_AUTOSTART_DISABLED = os.environ.get("META_KIM_DISABLE_MEMORY_AUTOSTART") == "1"
# L2 relevance threshold — lower for Chinese embeddings which tend to score lower
MIN_RELEVANCE = 0.55
# Content truncation lengths (Chinese chars are wider — generous limits)
MAX_LEN_COMPACT = 120
MAX_LEN_L2 = 400
MAX_LEN_L3 = 800

# Note written by the Stop-hook autosave in stop-save-progress.mjs.
AUTOSAVE_NOTE_MARKER = "auto-save from Stop hook"
# Session retention is split by source rather than one rolling window.
#
# stop-save-progress.mjs appends one regex-scraped session per turn end, so a
# single window fills with chatter: on one project all 20 slots came from a
# single 8-hour stretch and 15 of them were autosaves. Sessions written on
# purpose by /end-working — the ones a later session actually needs to resume
# from — were evicted the same day. Giving curated sessions their own quota
# keeps them out of reach of the autosave stream.
CURATED_SESSION_KEEP = 20
AUTOSAVE_SESSION_KEEP = 5


def is_autosave_session(session):
    """True when the entry came from the Stop-hook autosave, not a curated save."""
    if not isinstance(session, dict):
        return False
    note = session.get("note")
    return isinstance(note, str) and AUTOSAVE_NOTE_MARKER in note


def prune_sessions(sessions):
    """Keep recent curated sessions and a short tail of autosaves, in order."""
    curated = [i for i, s in enumerate(sessions) if not is_autosave_session(s)]
    autosaves = [i for i, s in enumerate(sessions) if is_autosave_session(s)]
    keep = set(curated[-CURATED_SESSION_KEEP:]) | set(autosaves[-AUTOSAVE_SESSION_KEEP:])
    return [s for i, s in enumerate(sessions) if i in keep]


def _build_opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _api_get(path, timeout=TIMEOUT):
    opener = _build_opener()
    req = urllib.request.Request(
        f"{MEMORY_SERVICE_URL}{path}",
        headers={"Accept": "application/json"},
    )
    with opener.open(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _api_post(path, body):
    opener = _build_opener()
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{MEMORY_SERVICE_URL}{path}",
        data=data,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    with opener.open(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def check_service_health():
    try:
        data = _api_get("/api/health", timeout=HEALTH_TIMEOUT)
        return data.get("status") == "healthy"
    except Exception:
        return False


def _is_loopback_memory_url(url):
    try:
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
        return host in ("localhost", "127.0.0.1", "::1")
    except Exception:
        return False


def _start_memory_service_background():
    if MEMORY_AUTOSTART_DISABLED or not _is_loopback_memory_url(MEMORY_SERVICE_URL):
        return False
    memory_bin = os.environ.get("MCP_MEMORY_BIN") or shutil.which("memory")
    if not memory_bin:
        return False
    env = os.environ.copy()
    env["MCP_ALLOW_ANONYMOUS_ACCESS"] = "true"
    env["HF_HUB_OFFLINE"] = "1"
    env["TRANSFORMERS_OFFLINE"] = "1"
    kwargs = {
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "stdin": subprocess.DEVNULL,
        "env": env,
    }
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
    else:
        kwargs["start_new_session"] = True
    try:
        subprocess.Popen([memory_bin, "server", "--http"], **kwargs)
        return True
    except Exception:
        return False


def ensure_service_health():
    if check_service_health():
        return True
    if not _start_memory_service_background():
        return False
    for _ in range(3):
        time.sleep(0.35)
        if check_service_health():
            return True
    return False


def _should_emit_memory_warning():
    if MEMORY_HEALTH_WARNING_INTERVAL < 0:
        return False
    try:
        material = f"{MEMORY_SERVICE_URL}|claude|session"
        marker = hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]
        marker_path = os.path.join(tempfile.gettempdir(), f"meta-kim-memory-health-{marker}.json")
        if os.path.exists(marker_path) and MEMORY_HEALTH_WARNING_INTERVAL > 0:
            age = time.time() - os.path.getmtime(marker_path)
            if 0 <= age < MEMORY_HEALTH_WARNING_INTERVAL:
                return False
        with open(marker_path, "w", encoding="utf-8") as f:
            json.dump({"endpoint": MEMORY_SERVICE_URL, "runtime": "claude", "time": time.time()}, f)
    except Exception:
        return True
    return True


def _memory_health_warning():
    return (
        "Meta_Kim memory status: Layer 3 MCP Memory Service is not healthy.\n"
        f"Endpoint: {MEMORY_SERVICE_URL}\n"
        "Cross-session recall/writeback is unavailable for this turn.\n"
        "The hook tried a background start with `memory server --http` when the endpoint was local.\n"
        "To fix manually, start: `MCP_ALLOW_ANONYMOUS_ACCESS=true memory server --http`.\n"
        "Status note only; do not treat recalled memory as present."
    )


# ─── Project Detection ─────────────────────────────────────────────────────

_PROJECT_ROOT_CACHE = None


def _resolve_project_root():
    """Locate the project root that memory should anchor to.

    cwd only says "where I am standing", not "which project I am working on".
    A linked git worktree is a second checkout of the same project, so memory
    written there vanishes when the worktree is removed. git already models
    project identity: --git-common-dir points at the main repo's .git from
    inside any worktree, so its parent is the shared project root.

    Submodules keep their own root on purpose (git-dir == git-common-dir there),
    and anything outside a repo falls back to cwd -- same behaviour as before.
    """
    cwd = os.getcwd()
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--git-dir", "--git-common-dir", "--show-toplevel"],
            cwd=cwd, capture_output=True, text=True, timeout=5,
        )
        if proc.returncode != 0:
            return cwd
        parts = proc.stdout.strip().splitlines()
        if len(parts) < 3:
            return cwd
        git_dir, common_dir, toplevel = (p.strip() for p in parts[:3])
        if not toplevel:
            return cwd
        git_dir = os.path.realpath(os.path.join(cwd, git_dir))
        common_dir = os.path.realpath(os.path.join(cwd, common_dir))
        if os.path.normcase(git_dir) != os.path.normcase(common_dir):
            # Linked worktree: anchor to the main repo instead of this checkout.
            main_root = os.path.dirname(common_dir)
            main_git_dir = os.path.realpath(os.path.join(main_root, ".git"))
            if (
                os.path.isdir(main_root)
                and os.path.isdir(main_git_dir)
                and os.path.normcase(main_git_dir) == os.path.normcase(common_dir)
            ):
                return main_root
        return toplevel
    except Exception:
        return cwd


def project_root():
    """Stable directory that owns this project's memory. Cached per process."""
    global _PROJECT_ROOT_CACHE
    if _PROJECT_ROOT_CACHE is None:
        _PROJECT_ROOT_CACHE = _resolve_project_root()
    return _PROJECT_ROOT_CACHE


def detect_project_tag():
    cwd = project_root()
    tag_file = os.path.join(cwd, ".claude", "memory_tag")
    if os.path.isfile(tag_file):
        try:
            with open(tag_file, encoding="utf-8") as f:
                tag = f.read().strip()
            if tag:
                return tag
        except Exception:
            pass

    if not check_service_health():
        return None
    try:
        data = _api_get("/api/tags")
        known_tags = [
            item["tag"] for item in data.get("tags", [])
            if item.get("count", 0) >= 2
        ]
    except Exception:
        return None

    if not known_tags:
        return None

    claude_md = os.path.join(cwd, "CLAUDE.md")
    if os.path.isfile(claude_md):
        try:
            with open(claude_md, encoding="utf-8") as f:
                content = f.read(1000)
            for tag in known_tags:
                if len(tag) >= 3 and tag in content:
                    return tag
        except Exception:
            pass

    dir_name = os.path.basename(cwd)
    dir_lower = dir_name.lower().replace("-", "").replace("_", "")
    for tag in known_tags:
        tag_lower = tag.lower().replace("-", "").replace("_", "")
        if dir_lower in tag_lower or tag_lower in dir_lower:
            return tag
    return None


def detect_project_name():
    cwd = project_root()
    claude_md = os.path.join(cwd, "CLAUDE.md")
    if os.path.isfile(claude_md):
        try:
            with open(claude_md, encoding="utf-8") as f:
                first_line = f.readline()
                if "# " in first_line:
                    return first_line.strip().lstrip("# ").strip()
        except Exception:
            pass
    return os.path.basename(cwd)


# ─── Task State ─────────────────────────────────────────────────────────────

TASK_STATE_FILENAME = "project-task-state.json"


def task_state_path():
    cwd = project_root()
    ts_path = os.path.join(cwd, ".claude", TASK_STATE_FILENAME)
    return ts_path if os.path.isfile(ts_path) else None


def load_task_state():
    ts_path = task_state_path()
    if not ts_path:
        return None
    try:
        with open(ts_path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def format_task_state_compact(state, project_name):
    """L1: Compact one-liner for quick resume context. Max ~120 chars (Chinese-friendly)."""
    sessions = state.get("sessions", [])
    last = sessions[-1] if sessions else None
    if not last:
        return ""
    completed_n = len(last.get("completed_tasks", []))
    remaining_n = len(last.get("remaining_tasks", []))
    current = last.get("current_task", "")
    parts = []
    if current:
        parts.append(f"当前: {current}")
    if completed_n:
        parts.append(f"已完成{completed_n}件")
    if remaining_n:
        parts.append(f"剩余{remaining_n}件")
    joined = " | ".join(parts)
    return f"**{project_name}** | {joined}" if parts else ""


def format_task_state_full(state, project_name):
    """L1 full: When user wants detail, show in session context block."""
    sessions = state.get("sessions", [])
    last = sessions[-1] if sessions else None
    if not last:
        return ""

    completed = last.get("completed_tasks", [])
    remaining = last.get("remaining_tasks", [])
    current = last.get("current_task", "未记录")
    session_date = last.get("date", "")

    lines = [f"## 项目进度 [{project_name}]", f"**上次会话**: {session_date}"]

    if current:
        lines.append(f"**当前任务**: {current}")

    if completed:
        lines.append(f"**已完成** ({len(completed)}件事)")
        for i, task in enumerate(completed[-5:], 1):
            desc = task.get("description", task) if isinstance(task, dict) else task
            lines.append(f"  {i}. {desc} ✅")

    if remaining:
        lines.append(f"**剩余任务** ({len(remaining)}件事)")
        for i, task in enumerate(remaining[:5], 1):
            if isinstance(task, dict):
                lines.append(f"  {i}. {task.get('description', '')}")
            else:
                lines.append(f"  {i}. {task}")

    return "\n".join(lines)


def write_task_state(args):
    # Must resolve the same way task_state_path() reads, or memory would be
    # read from the main repo and written into the worktree.
    cwd = project_root()
    os.makedirs(os.path.join(cwd, ".claude"), exist_ok=True)
    ts_path = os.path.join(cwd, ".claude", TASK_STATE_FILENAME)

    if os.path.isfile(ts_path):
        try:
            with open(ts_path, encoding="utf-8") as f:
                state = json.load(f)
        except Exception:
            state = _new_state()
    else:
        state = _new_state()

    if "sessions" not in state or not isinstance(state["sessions"], list):
        state["sessions"] = []

    done_tasks = []
    if args.done:
        for desc in args.done:
            done_tasks.append({
                "description": desc.strip(),
                "completed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            })

    remaining_tasks = []
    if args.remaining:
        for desc in args.remaining:
            remaining_tasks.append({
                "description": desc.strip(),
                "status": "pending",
            })

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    project_name = detect_project_name()

    last_current = (
        state["sessions"][-1].get("current_task", "")
        if state["sessions"] else ""
    )

    state["sessions"].append({
        "session_id": os.environ.get("CLAUDE_SESSION_ID", "unknown"),
        "date": now[:10],
        "started_at": now,
        "current_task": args.task or last_current,
        "completed_tasks": done_tasks,
        "remaining_tasks": remaining_tasks,
        "note": args.note or "",
    })

    state["sessions"] = prune_sessions(state["sessions"])
    state["updated_at"] = now
    state["project"] = project_name
    state["project_dir"] = cwd

    with open(ts_path, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)

    total_done = sum(len(s.get("completed_tasks", [])) for s in state["sessions"])
    total_sessions = len(state["sessions"])

    return {
        "saved": True,
        "file": ts_path,
        "total_sessions": total_sessions,
        "total_completed": total_done,
        "last_session_completed": len(done_tasks),
        "last_session_remaining": len(remaining_tasks),
    }


def _new_state():
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return {"version": 1, "created_at": now, "updated_at": now, "sessions": []}


# ─── L2: Filtered Project Memories ─────────────────────────────────────────

def _normalize_project_text(text):
    return re.sub(r"[-_\s]+", "", str(text or "").lower())


def _memory_content(mem):
    return str(mem.get("content", "")).strip()


def _is_generic_lifecycle_memory(content):
    return bool(
        re.search(r"Claude Code 会话启动", content)
        or re.search(r"Runtime session-start checkpoint", content, re.I)
        or re.search(r"会话启动", content)
    )


def _is_high_signal_memory(content):
    return bool(re.search(r"8000|MCP Memory Service|third layer|cross-session|第三层|跨会话|召回|记忆", content, re.I))


def _is_project_memory(mem, project_tag):
    project_needle = _normalize_project_text(project_tag)
    metadata = mem.get("metadata", {}) if isinstance(mem.get("metadata"), dict) else {}
    tags = mem.get("tags", []) if isinstance(mem.get("tags"), list) else []
    haystack = _normalize_project_text(
        " ".join([
            _memory_content(mem),
            *[str(tag) for tag in tags],
            str(metadata.get("project_dir", "")),
            str(metadata.get("cwd", "")),
            str(metadata.get("project", "")),
        ])
    )
    return bool(project_needle and project_needle in haystack)


def _recall_terms(*texts):
    terms = []
    seen = set()
    for term in re.findall(r"[\w\u4e00-\u9fff-]{2,}", " ".join(str(t or "") for t in texts).lower()):
        if term in {"this", "that", "with", "from", "into", "工作", "继续"}:
            continue
        if term not in seen:
            seen.add(term)
            terms.append(term[:48])
    return terms[:24]


def _memory_created_at(mem):
    metadata = mem.get("metadata", {}) if isinstance(mem.get("metadata"), dict) else {}
    value = (
        mem.get("created_at")
        or mem.get("created_at_iso")
        or mem.get("createdAt")
        or mem.get("timestamp")
        or mem.get("updated_at_iso")
        or metadata.get("created_at")
        or metadata.get("created_at_iso")
        or metadata.get("createdAt")
        or metadata.get("updated_at_iso")
        or metadata.get("timestamp")
    )
    if not value:
        return 0
    try:
        normalized = str(value).replace("Z", "+00:00")
        return datetime.fromisoformat(normalized).timestamp()
    except Exception:
        return 0


def _memory_dedupe_key(content):
    normalized = str(content or "")
    normalized = re.sub(r"\b\d{4}-\d{2}-\d{2}T[\d:.]+Z\b", "", normalized)
    normalized = re.sub(r"\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?\b", "", normalized)
    normalized = re.sub(r"\b[0-9a-f]{8}-[0-9a-f-]{20,}\b", "", normalized, flags=re.I)
    normalized = re.sub(r"^Time:.*$", "", normalized, flags=re.M)
    normalized = re.sub(r"^Project dir:.*$", "", normalized, flags=re.M)
    normalized = re.sub(r"Hook metadata:[\s\S]*$", "", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip()[:520]
    return hashlib.sha256((normalized or str(content or "")).encode("utf-8")).hexdigest()


def _score_memory(mem, project_tag, terms, source_rank=0):
    content = _memory_content(mem)
    lowered = content.lower()
    score = float(source_rank or 0)
    if _is_project_memory(mem, project_tag):
        score += 30
    if mem.get("_meta_kim_source") == "recent":
        score += 8
    score += min(20, float(mem.get("similarity_score", 0) or 0) * 20)
    for term in terms:
        if term and term.lower() in lowered:
            score += 2
    if re.search(r"UserPromptSubmit prompt|user-prompt|stop checkpoint|session summary", content, re.I):
        score += 4
    if _is_high_signal_memory(content):
        score += 15
    if re.search(r"New task for existing agent|You are not alone in the codebase", content, re.I):
        score -= 25
    if _is_generic_lifecycle_memory(content):
        score -= 35
    created_at = _memory_created_at(mem)
    if created_at:
        age_hours = max(0, (time.time() - created_at) / 3600)
        score += max(0, 10 - age_hours / 24)
    return score


def _dedupe_and_rank_memories(memories, project_tag, terms, limit):
    by_hash = {}
    for mem in memories:
        content = _memory_content(mem)
        if not content:
            continue
        key = _memory_dedupe_key(content)
        scored = dict(mem)
        scored["_meta_kim_terms"] = terms
        scored["_meta_kim_score"] = _score_memory(
            scored,
            project_tag,
            terms,
            scored.get("_meta_kim_source_rank", 0),
        )
        if key not in by_hash or scored["_meta_kim_score"] > by_hash[key]["_meta_kim_score"]:
            by_hash[key] = scored
    ranked = sorted(by_hash.values(), key=lambda item: item.get("_meta_kim_score", 0), reverse=True)
    non_generic = [mem for mem in ranked if not _is_generic_lifecycle_memory(_memory_content(mem))]
    base = non_generic or ranked
    preferred_recent = [
        mem for mem in base
        if mem.get("_meta_kim_source") == "recent"
        and _is_project_memory(mem, project_tag)
        and _is_high_signal_memory(_memory_content(mem))
    ]
    preferred_recent = sorted(preferred_recent, key=_memory_created_at, reverse=True)[:2]
    selected = []
    selected_keys = set()
    for mem in [*preferred_recent, *base]:
        key = _memory_dedupe_key(_memory_content(mem))
        if key in selected_keys:
            continue
        selected.append(mem)
        selected_keys.add(key)
        if len(selected) >= limit:
            break
    return selected


def _excerpt_memory_content(content, terms, max_len):
    content = str(content or "").strip()
    if len(content) <= max_len:
        return content
    needles = [
        "mcp memory service",
        "memory service",
        "8000",
        "third layer",
        "cross-session",
        "召回",
        "记忆",
        *terms,
    ]
    lowered = content.lower()
    best_index = -1
    for needle in needles:
        needle = str(needle or "").strip().lower()
        if len(needle) < 2:
            continue
        index = lowered.find(needle)
        if index >= 0:
            best_index = index
            break
    if best_index < 0:
        return content[:max_len] + "..."
    start = max(0, best_index - 90)
    end = min(len(content), start + max_len)
    return ("..." if start > 0 else "") + content[start:end] + ("..." if end < len(content) else "")


def load_recent_project_memories(project_tag, limit=10):
    try:
        data = _api_get(f"/api/memories?limit={max(64, limit * 3)}")
        results = data.get("memories", data.get("results", []))
        memories = []
        for index, result in enumerate(results):
            memory = result.get("memory", result) if isinstance(result, dict) else None
            if not isinstance(memory, dict) or not _is_project_memory(memory, project_tag):
                continue
            memory = dict(memory)
            memory["_meta_kim_source"] = "recent"
            memory["_meta_kim_source_rank"] = max(0, 10 - index)
            memories.append(memory)
        return memories[:limit]
    except Exception:
        return []


def load_filtered_project_memories(project_tag, limit=5):
    """L2: Load project memories with multi-query recall plus recent-project fallback."""
    try:
        memories = []
        queries = [
            project_tag,
            f"{project_tag} current problems decisions next steps blockers bugs hooks memory recall",
            f"{project_tag} MCP Memory Service 8000 third layer cross-session recall current problem",
            f"{project_tag} recent work implementation verification follow up",
        ]
        terms = _recall_terms(*queries)
        for query_index, query in enumerate(queries):
            data = _api_post("/api/search", {
                "query": query,
                "n_results": 20,
            })
            results = data.get("memories", data.get("results", []))
            for index, result in enumerate(results):
                memory = result.get("memory", result) if isinstance(result, dict) else None
                if not isinstance(memory, dict):
                    continue
                score = result.get("similarity_score", memory.get("similarity_score", 0))
                if score < MIN_RELEVANCE and not _is_project_memory(memory, project_tag):
                    continue
                memory = dict(memory)
                memory["similarity_score"] = score
                memory["_meta_kim_source"] = "search"
                memory["_meta_kim_source_rank"] = max(0, 12 - query_index - index)
                memories.append(memory)
        memories.extend(load_recent_project_memories(project_tag, limit=max(10, limit * 2)))
        return _dedupe_and_rank_memories(memories, project_tag, terms, limit)
    except Exception:
        return []


def format_memories(mems, header, max_len):
    if not mems:
        return ""
    result = f"\n## {header}\n\n"
    for i, mem in enumerate(mems, 1):
        content = _excerpt_memory_content(
            mem.get("content", "").strip(),
            mem.get("_meta_kim_terms", []),
            max_len,
        )
        tags = mem.get("tags", [])
        tag_str = f" [{', '.join(tags)}]" if tags else ""
        result += f"{i}. {content}{tag_str}\n\n"
    return result


# ─── SessionStart (layered) ────────────────────────────────────────────────

def _write_session_start_observation():
    """Write a session-start record to MCP Memory."""
    try:
        project_name = detect_project_name()
        cwd = os.getcwd()
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")[:19]
        content = (
            f"Claude Code 会话启动 - {now} - "
            f"工作目录: {cwd} - 项目: {project_name}"
        )
        tags = ["会话", "启动", "系统", project_name]
        _api_post("/api/memories", {
            "content": content,
            "tags": tags,
            "memory_type": "observation",
            "metadata": {
                "generated_by": "meta-kim-session-start",
                "project_dir": cwd,
            },
        })
    except Exception:
        pass


def main_session_start():
    """L1 compact: task state + filtered memories. ~120-500 chars."""
    parts = []
    service_ready = ensure_service_health()

    # Write session-start record first
    if service_ready:
        _write_session_start_observation()

    ts = load_task_state()
    if ts:
        project_name = detect_project_name()
        compact = format_task_state_compact(ts, project_name)
        if compact:
            parts.append(compact)

    if service_ready:
        project_tag = detect_project_tag()
        if project_tag:
            mems = load_filtered_project_memories(project_tag, limit=5)
            if mems:
                parts.append(format_memories(mems, f"💾 项目记忆 [{project_tag}]", MAX_LEN_L2))
    elif _should_emit_memory_warning():
        parts.append(_memory_health_warning())

    if parts:
        context = "\n".join(parts)
        print(json.dumps({"message": context, "continue": True}, ensure_ascii=False))
    else:
        print(json.dumps({"message": "", "continue": True}))


def main_session_full():
    """L1 full + L2: ~500-800 chars."""
    parts = []

    ts = load_task_state()
    if ts:
        project_name = detect_project_name()
        full = format_task_state_full(ts, project_name)
        if full:
            parts.append(full)

    if check_service_health():
        project_tag = detect_project_tag()
        if project_tag:
            mems = load_filtered_project_memories(project_tag, limit=5)
            if mems:
                parts.append(format_memories(mems, f"💾 项目记忆 [{project_tag}]", MAX_LEN_L2))
        recent = _api_get(f"/api/memories?limit=3").get("memories", [])
        if recent:
            parts.append(format_memories(recent, "💾 最近记忆", MAX_LEN_L2))

    if parts:
        context = "\n".join(parts)
        print(json.dumps({"message": context, "continue": True}, ensure_ascii=False))
    else:
        print(json.dumps({"message": "", "continue": True}))


def main_query_memories():
    """L3: full dump on demand. ~800 chars max."""
    parts = []
    if check_service_health():
        project_tag = detect_project_tag()
        if project_tag:
            mems = load_filtered_project_memories(project_tag, limit=10)
            if mems:
                parts.append(format_memories(mems, f"💾 项目记忆 [{project_tag}]", MAX_LEN_L3))
        recent = _api_get(f"/api/memories?limit=5").get("memories", [])
        if recent:
            parts.append(format_memories(recent, "💾 最近记忆", MAX_LEN_L3))

    combined = "\n".join(parts)
    if len(combined) > MAX_LEN_L3 * 2:
        combined = combined[:MAX_LEN_L3 * 2] + "\n...(已截断)"
    print(json.dumps({"message": combined, "continue": True}, ensure_ascii=False))


def main_query_project():
    """L1 compact only: task state, no MCP calls."""
    ts = load_task_state()
    if ts:
        project_name = detect_project_name()
        full = format_task_state_full(ts, project_name)
        compact = format_task_state_compact(ts, project_name)
        msg = full if compact else ""
        print(json.dumps({"message": msg, "continue": True}, ensure_ascii=False))
    else:
        print(json.dumps({"message": "", "continue": True}))


# ─── CLI Entry ────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="MCP Memory Service Session Hook",
        usage="%(prog)s --mode session|save|query-project|query-memories",
    )
    parser.add_argument(
        "--mode",
        default="session",
        choices=["session", "session-full", "save", "session-end", "query-project", "query-memories"],
        help=(
            "session = L1 compact (~120-500 chars); "
            "session-full = L1 full + L2 (~500-800 chars); "
            "save = write task state; "
            "query-project = L1 compact only, no MCP; "
            "query-memories = L3 full dump on demand"
        ),
    )
    parser.add_argument("--task", type=str, help="Current task description")
    parser.add_argument("--done", type=str, nargs="+", help="Completed tasks")
    parser.add_argument("--remaining", type=str, nargs="+", help="Remaining tasks")
    parser.add_argument("--note", type=str, default="", help="Session note")

    args = parser.parse_args()

    if args.mode == "save":
        result = write_task_state(args)
        print(json.dumps(result, ensure_ascii=False))
    elif args.mode == "session-full":
        main_session_full()
    elif args.mode == "session-end":
        print(json.dumps({"message": "", "continue": True}))
    elif args.mode == "query-project":
        main_query_project()
    elif args.mode == "query-memories":
        main_query_memories()
    else:
        main_session_start()


if __name__ == "__main__":
    main()
