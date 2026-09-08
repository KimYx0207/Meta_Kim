import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { readJsonFromStdin } from "./utils.mjs";

const payload = await readJsonFromStdin();

const additionalContext = [
  "Meta_Kim subagent rule set:",
  "- Theory source: canonical/skills/meta-theory/references/meta-theory.md",
  "- Canonical Claude agent source: .claude/agents/*.md",
  "- After editing agents or skills, run npm run meta:sync and npm run meta:validate",
  "- Prefer the smallest agent boundary that can solve the task cleanly",
  "- Do not fork runtime-specific instructions unless the target runtime genuinely requires it",
  "- Codex owner identity comes from the verified worker invocation envelope (ownerAgent + ownerSource + capabilityLoadout + role/co-ordination + metaKimBinding). task_name, followup target, and UI nickname are runtime instance labels only and must never be presented as the professional owner.",
  "- Graph context: if graphify-out/graph.json exists in the target project root, use Graphify as navigation, not as a context dump. For focused questions, prefer `graphify query \"<question>\" --budget 1000`, `graphify path \"A\" \"B\"`, or `graphify explain \"concept\"`; read GRAPH_REPORT.md only for broad architecture orientation. Treat graph results as candidate file anchors, verify route-changing claims against source files, and fall back to targeted repository search when graph results are generic, stale, or polluted by generated state. Never inject full graph.json or full GRAPH_REPORT.md.",
  "- CRITICAL: you are a dispatched subagent. If the task scope grows beyond your assigned boundary (multi-file, multi-module, multi-capability), report back to the dispatcher instead of self-expanding. Self-expansion is a governance violation.",
].join("\n");

function subagentIdentityFromPayload(hookPayload) {
  const candidates = [
    hookPayload?.agent_id,
    hookPayload?.agentId,
    hookPayload?.subagent_id,
    hookPayload?.subagentId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function claimSubagentMarker(markerPath) {
  try {
    // SubagentStart may be delivered to duplicate registrations at once.
    // Exclusive creation serializes those registrations without sharing a
    // marker between two independently identified workers.
    writeFileSync(markerPath, `${Date.now()}\n`, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    // Context injection is advisory; preserve the rule set if the temp marker
    // cannot be written.
    return true;
  }
}

if (process.env.META_KIM_SUBAGENT_CONTEXT !== "off") {
  // Each new subagent has its own context, even when its role name repeats.
  // Only duplicate events for an identified instance may share a marker.
  const sessionId =
    payload.session_id ||
    payload.sessionId ||
    payload.conversation_id ||
    payload.conversationId ||
    "";
  const sessionKey = typeof sessionId === "string" ? sessionId.trim() : "";
  const agentId = subagentIdentityFromPayload(payload);
  const markerPath = sessionKey && agentId ? path.join(
    os.tmpdir(),
    `meta-kim-subagent-ctx-${createHash("sha256")
      .update(JSON.stringify([sessionKey, agentId]))
      .digest("hex")
      .slice(0, 16)}.flag`,
  ) : null;

  if (!markerPath || claimSubagentMarker(markerPath)) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SubagentStart",
          additionalContext,
        },
      }),
    );

  }
}
