import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("repository AGENTS.md fits Codex's default project document budget", () => {
  const entry = readFileSync(new URL("../../AGENTS.md", import.meta.url));
  assert.ok(entry.byteLength <= 32 * 1024, `AGENTS.md takes ${entry.byteLength} bytes`);
  const maintainerGuide = readFileSync(new URL("../../MAINTAINER.md", import.meta.url), "utf8");
  assert.match(entry.toString("utf8"), /\]\(MAINTAINER\.md/u);
  assert.match(maintainerGuide, /Runtime Sedimentation/u);
});
