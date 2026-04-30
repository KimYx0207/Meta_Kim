import process from "node:process";
import { readJsonFromStdin } from "./utils.mjs";

await readJsonFromStdin();

const additionalContext = [
  "Meta_Kim subagent rule set:",
  "- Theory source: canonical/skills/meta-theory/references/meta-theory.md",
  "- Canonical Claude agent source: .claude/agents/*.md",
  "- After editing agents or skills, run npm run meta:sync and npm run meta:validate",
  "- Prefer the smallest agent boundary that can solve the task cleanly",
  "- Do not fork runtime-specific instructions unless the target runtime genuinely requires it",
  "- Graph context: if graphify-out/graph.json exists in the target project root, prefer reading graphify-out/GRAPH_REPORT.md when present, then graph.json as compressed codebase context (up to 71x smaller than reading all source files). Extract module boundaries from clusters, dependency chains from edges, and risk areas from God nodes. Treat AMBIGUOUS nodes (confidence 0.1-0.3) as uncertain dependencies requiring manual verification, not as absent dependencies.",
].join("\n");

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SubagentStart",
      additionalContext,
    },
  }),
);
