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
import urllib.request
import urllib.error
import argparse
import re
from datetime import datetime, timezone

os.environ.setdefault("NO_PROXY", "localhost,127.0.0.1")

MEMORY_SERVICE_URL = os.environ.get("MCP_MEMORY_URL", "http://localhost:8000")
MEMORY_LIMIT = int(os.environ.get("MCP_MEMORY_LIMIT", "10"))
TIMEOUT = 3
# L2 relevance threshold — lower for Chinese embeddings which tend to score lower
MIN_RELEVANCE = 0.55
# Content truncation lengths (Chinese chars are wider — generous limits)
MAX_LEN_COMPACT = 120
MAX_LEN_L2 = 400
MAX_LEN_L3 = 800


def _build_opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _api_get(path):
    opener = _build_opener()
    req = urllib.request.Request(
        f"{MEMORY_SERVICE_URL}{path}",
        headers={"Accept": "application/json"},
    )
    with opener.open(req, timeout=TIMEOUT) as resp:
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
        data = _api_get("/api/health")
        return data.get("status") == "healthy"
    except Exception:
        return False


# ─── Project Detection ─────────────────────────────────────────────────────

def detect_project_tag():
    cwd = os.getcwd()
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
    cwd = os.getcwd()
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
    cwd = os.getcwd()
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
    cwd = os.getcwd()
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

    state["sessions"] = state["sessions"][-20:]
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

def load_filtered_project_memories(project_tag, limit=5):
    """L2: Load project memories filtered by relevance (threshold lowered for Chinese)."""
    try:
        data = _api_post("/api/search", {
            "query": project_tag,
            "limit": 20,
        })
        results = data.get("results", [])
        filtered = [
            r for r in results
            if r.get("similarity_score", 0) >= MIN_RELEVANCE
        ]
        return [r["memory"] for r in filtered[:limit] if "memory" in r]
    except Exception:
        return []


def format_memories(mems, header, max_len):
    if not mems:
        return ""
    result = f"\n## {header}\n\n"
    for i, mem in enumerate(mems, 1):
        content = mem.get("content", "").strip()
        tags = mem.get("tags", [])
        if len(content) > max_len:
            content = content[:max_len] + "..."
        tag_str = f" [{', '.join(tags)}]" if tags else ""
        result += f"{i}. {content}{tag_str}\n\n"
    return result


# ─── SessionStart (layered) ────────────────────────────────────────────────

def _write_session_start_note():
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
            "memory_type": "note",
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

    # Write session-start record first
    if check_service_health():
        _write_session_start_note()

    ts = load_task_state()
    if ts:
        project_name = detect_project_name()
        compact = format_task_state_compact(ts, project_name)
        if compact:
            parts.append(compact)

    if check_service_health():
        project_tag = detect_project_tag()
        if project_tag:
            mems = load_filtered_project_memories(project_tag, limit=5)
            if mems:
                parts.append(format_memories(mems, f"💾 项目记忆 [{project_tag}]", MAX_LEN_L2))

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
