import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function readPayload() {
  try {
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function commandFromPayload(payload) {
  const input = payload?.tool_input ?? payload?.toolInput ?? payload?.input ?? payload;
  return typeof input?.command === "string" ? input.command : "";
}

function isSearchCommand(command) {
  return /\b(grep|rg|ripgrep|find|fd|ack|ag)\b/i.test(command);
}

const payload = readPayload();
const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
const graphPath = path.join(cwd, "graphify-out", "graph.json");
const command = commandFromPayload(payload);

function claimSessionMarker(markerPath) {
  try {
    // `existsSync` followed by `writeFileSync` lets two hook registrations
    // observe the same empty slot. Exclusive creation makes the decision one
    // winner per explicit session, even when the host starts hooks together.
    writeFileSync(markerPath, `${Date.now()}\n`, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    // A marker failure is advisory only. The graph tip must remain available
    // when the host temp directory is unavailable or read-only.
    return true;
  }
}

if (process.env.META_KIM_GRAPHIFY_CONTEXT === "off") {
  process.exit(0);
}

if (isSearchCommand(command) && existsSync(graphPath)) {
  // Once-per-session guard: the tip is static, so re-injecting it on every
  // search command only burns tokens. A directory is not a session identity.
  const sessionId =
    payload.session_id ||
    payload.sessionId ||
    payload.conversation_id ||
    payload.conversationId ||
    "";
  const keyMaterial = typeof sessionId === "string" ? sessionId.trim() : "";
  const markerPath = keyMaterial ? path.join(
    os.tmpdir(),
    `meta-kim-graphify-ctx-${createHash("sha256").update(keyMaterial).digest("hex").slice(0, 16)}.flag`,
  ) : null;

  if (!markerPath || claimSessionMarker(markerPath)) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext:
            "graphify: knowledge graph at graphify-out/. For focused questions, run `graphify query \"<question>\" --budget 1000` first; use `graphify path`/`graphify explain` for relationships or concepts. Treat graph results as candidate file anchors only: verify route-changing claims against source files, and fall back to targeted `rg` when results are generic or stale. Read GRAPH_REPORT.md only for broad architecture context; never inject full graph.json or full GRAPH_REPORT.md.",
        },
      }),
    );

  }
}
