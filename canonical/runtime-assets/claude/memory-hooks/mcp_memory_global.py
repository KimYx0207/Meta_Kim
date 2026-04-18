# -*- coding: utf-8 -*-
"""
Global MCP Memory Service Hook - SessionStart

Auto-loads memories from MCP Memory Service (doobidoo/mcp-memory-service)
at session start. Detects current project from CWD and filters memories
by project tag when available.

Works globally across all projects.
"""

import json
import os
import sys
import urllib.request
import urllib.error

# Bypass proxy for localhost
os.environ.setdefault("NO_PROXY", "localhost,127.0.0.1")

MEMORY_SERVICE_URL = os.environ.get("MCP_MEMORY_URL", "http://localhost:8888")
MEMORY_LIMIT = int(os.environ.get("MCP_MEMORY_LIMIT", "10"))
TIMEOUT = 3


def _build_opener() -> urllib.request.OpenerDirector:
    """Build URL opener that bypasses proxy."""
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _api_get(path: str) -> dict:
    """GET request to memory service API."""
    opener = _build_opener()
    req = urllib.request.Request(
        f"{MEMORY_SERVICE_URL}{path}",
        headers={"Accept": "application/json"},
    )
    with opener.open(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _api_post(path: str, body: dict) -> dict:
    """POST request to memory service API."""
    opener = _build_opener()
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{MEMORY_SERVICE_URL}{path}",
        data=data,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    with opener.open(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def detect_project_tag() -> str | None:
    """Detect project tag by matching memory service tags against project context.

    Strategy (in priority order):
    1. .claude/memory_tag file (explicit override)
    2. Match tags API against CLAUDE.md content
    3. Match tags API against directory name
    """
    cwd = os.getcwd()

    # Strategy 1: explicit tag file
    tag_file = os.path.join(cwd, ".claude", "memory_tag")
    if os.path.isfile(tag_file):
        with open(tag_file, "r", encoding="utf-8") as f:
            tag = f.read().strip()
        if tag:
            return tag

    # Get all known tags from memory service
    try:
        data = _api_get("/api/tags")
        known_tags = [item["tag"] for item in data.get("tags", []) if item.get("count", 0) >= 2]
    except Exception:
        return None

    if not known_tags:
        return None

    # Strategy 2: match against CLAUDE.md content
    claude_md = os.path.join(cwd, "CLAUDE.md")
    if os.path.isfile(claude_md):
        try:
            with open(claude_md, "r", encoding="utf-8") as f:
                content = f.read(1000)
            for tag in known_tags:
                if len(tag) >= 3 and tag in content:
                    return tag
        except Exception:
            pass

    # Strategy 3: match against directory name
    dir_name = os.path.basename(cwd)
    dir_lower = dir_name.lower().replace("-", "").replace("_", "")
    for tag in known_tags:
        tag_lower = tag.lower().replace("-", "").replace("_", "")
        if dir_lower in tag_lower or tag_lower in dir_lower:
            return tag

    return None


def load_project_memories(project_tag: str, limit: int = MEMORY_LIMIT) -> list[dict]:
    """Load memories filtered by project tag."""
    try:
        data = _api_post("/api/search/by-tag", {
            "tags": [project_tag],
            "match_all": False,
        })
        results = data.get("results", [])
        # Search API nests memory inside result: {memory: {...}, similarity_score, ...}
        return [r["memory"] for r in results[:limit] if "memory" in r]
    except Exception:
        return []


def load_recent_memories(limit: int = MEMORY_LIMIT) -> list[dict]:
    """Load recent memories (no project filter)."""
    try:
        data = _api_get(f"/api/memories?limit={limit}")
        return data.get("memories", [])
    except Exception:
        return []


def format_memories(memories: list[dict], header: str, max_content_len: int = 300) -> str:
    """Format memory list into readable context string."""
    if not memories:
        return ""

    result = f"\n## {header}\n\n"
    for i, mem in enumerate(memories, 1):
        content = mem.get("content", "").strip()
        tags = mem.get("tags", [])
        if len(content) > max_content_len:
            content = content[:max_content_len] + "..."
        tag_str = f" [{', '.join(tags)}]" if tags else ""
        result += f"{i}. {content}{tag_str}\n\n"

    return result


def check_service_health() -> bool:
    """Check if memory service is running."""
    try:
        data = _api_get("/api/health")
        return data.get("status") == "healthy"
    except Exception:
        return False


def main():
    """Main: load memories and output as session context."""
    if not check_service_health():
        print(json.dumps({"message": "", "continue": True}))
        return

    project_tag = detect_project_tag()

    parts = []

    if project_tag:
        # Load project-specific memories
        project_memories = load_project_memories(project_tag)
        formatted = format_memories(
            project_memories,
            f"💾 MCP Memory - 项目记忆 [{project_tag}]",
        )
        if formatted:
            parts.append(formatted)

    # Load recent global memories (fewer if we already have project memories)
    global_limit = 5 if project_tag else MEMORY_LIMIT
    recent_memories = load_recent_memories(global_limit)
    formatted = format_memories(recent_memories, "💾 MCP Memory - 最近记忆")
    if formatted:
        parts.append(formatted)

    if parts:
        context = "\n".join(parts)
        print(json.dumps({"message": context, "continue": True}, ensure_ascii=False))
    else:
        print(json.dumps({"message": "", "continue": True}))


if __name__ == "__main__":
    main()
