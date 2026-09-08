import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildCodexProjectHooksJson } from "../../scripts/sync-runtimes.mjs";
import { buildCodexHooksJson } from "../../scripts/runtime-hook-mapping.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const hookPath = path.join(
  repoRoot,
  "canonical",
  "runtime-assets",
  "claude",
  "hooks",
  "subagent-context.mjs",
);

function runHook(payload, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hookPath], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ status: -1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function markerPathFor(sessionKey, agentName) {
  const hash = createHash("sha256")
    .update(JSON.stringify([sessionKey, agentName]))
    .digest("hex")
    .slice(0, 16);
  return path.join(os.tmpdir(), `meta-kim-subagent-ctx-${hash}.flag`);
}

function subagentStartPayload({ sessionId, cwd, agentName, agentId, nestedKey, nestedValue } = {}) {
  const payload = {
    hook_event_name: "SubagentStart",
    cwd: cwd ?? repoRoot,
  };
  if (sessionId) payload.session_id = sessionId;
  if (agentName) payload.agent_type = agentName;
  if (agentId) payload.agent_id = agentId;
  if (nestedKey) payload.tool_input = { [nestedKey]: nestedValue };
  return payload;
}

describe("subagent-context token guard", () => {
  test("distinct subagent instances of the same type each receive their own context", async () => {
    const sessionId = `same-type-${Date.now()}-${process.pid}`;
    const base = subagentStartPayload({ sessionId, agentName: "meta-prism" });
    const first = await runHook({ ...base, agent_id: "instance-one" });
    const second = await runHook({ ...base, agent_id: "instance-two" });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.match(first.stdout, /Meta_Kim subagent rule set/u);
    assert.match(second.stdout, /Meta_Kim subagent rule set/u, "same role does not imply shared conversation context");
    const repeated = await runHook({ ...base, agent_id: "instance-one" });
    assert.equal(repeated.stdout.trim(), "", "a duplicate event for the same instance is still deduplicated");
    for (const id of ["instance-one", "instance-two"]) rmSync(markerPathFor(sessionId, id), { force: true });
  });

  test("META_KIM_SUBAGENT_CONTEXT=off emits nothing and exits 0", async () => {
    const result = await runHook(subagentStartPayload({ sessionId: `off-${Date.now()}` }), {
      META_KIM_SUBAGENT_CONTEXT: "off",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "");
  });

  test("injects the rule set once per (session, agent), not on every SubagentStart", async () => {
    const sessionId = `subagent-dedup-${Date.now()}-${process.pid}`;
    const prismMarker = markerPathFor(sessionId, "meta-prism");
    const scoutMarker = markerPathFor(sessionId, "meta-scout");
    rmSync(prismMarker, { force: true });
    rmSync(scoutMarker, { force: true });
    try {
      const first = await runHook(
        subagentStartPayload({ sessionId, agentName: "meta-prism", agentId: "meta-prism" }),
      );
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /Meta_Kim subagent rule set/u);
      assert.equal(existsSync(prismMarker), true, "expected a per-(session, agent) marker");
      assert.ok(statSync(prismMarker).size <= 256, "marker file must stay tiny");

      const second = await runHook(
        subagentStartPayload({ sessionId, agentName: "meta-prism", agentId: "meta-prism" }),
      );
      assert.equal(second.status, 0, second.stderr);
      assert.equal(second.stdout.trim(), "", "same session and agent must not re-inject");

      const otherAgent = await runHook(
        subagentStartPayload({ sessionId, agentName: "meta-scout", agentId: "meta-scout" }),
      );
      assert.equal(otherAgent.status, 0, otherAgent.stderr);
      assert.match(otherAgent.stdout, /Meta_Kim subagent rule set/u);
    } finally {
      rmSync(prismMarker, { force: true });
      rmSync(scoutMarker, { force: true });
    }
  });

  test("concurrent duplicate events claim one identified subagent marker", async () => {
    const sessionId = `concurrent-subagent-${Date.now()}-${process.pid}`;
    const marker = markerPathFor(sessionId, "instance-one");
    rmSync(marker, { force: true });
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => runHook(
          subagentStartPayload({ sessionId, agentId: "instance-one", agentName: "meta-prism" }),
        )),
      );
      assert.ok(results.every((result) => result.status === 0), results.map((result) => result.stderr).join("\n"));
      assert.equal(
        results.filter((result) => result.stdout.trim()).length,
        1,
        "parallel registrations must not duplicate one identified subagent context",
      );
    } finally {
      rmSync(marker, { force: true });
    }
  });

  test("nested role names and task labels do not impersonate subagent instance identity", async () => {
    const sessionId = `nested-agent-${Date.now()}-${process.pid}`;
    const claudeMarker = markerPathFor(sessionId, "meta-artisan");
    const codexMarker = markerPathFor(sessionId, "worker-renovation");
    rmSync(claudeMarker, { force: true });
    rmSync(codexMarker, { force: true });
    try {
      const claudeFirst = await runHook(
        subagentStartPayload({ sessionId, nestedKey: "subagent_type", nestedValue: "meta-artisan" }),
      );
      assert.match(claudeFirst.stdout, /Meta_Kim subagent rule set/u);
      const claudeSecond = await runHook(
        subagentStartPayload({ sessionId, nestedKey: "subagent_type", nestedValue: "meta-artisan" }),
      );
      assert.match(claudeSecond.stdout, /Meta_Kim subagent rule set/u);
      assert.equal(existsSync(claudeMarker), false);

      const codexFirst = await runHook(
        subagentStartPayload({ sessionId, nestedKey: "task_name", nestedValue: "worker-renovation" }),
      );
      assert.match(codexFirst.stdout, /Meta_Kim subagent rule set/u);
      const codexSecond = await runHook(
        subagentStartPayload({ sessionId, nestedKey: "task_name", nestedValue: "worker-renovation" }),
      );
      assert.match(codexSecond.stdout, /Meta_Kim subagent rule set/u);
      assert.equal(existsSync(codexMarker), false);
    } finally {
      rmSync(claudeMarker, { force: true });
      rmSync(codexMarker, { force: true });
    }
  });

  test("does not suppress independent contexts when no instance identity is available", async () => {
    const sessionId = `no-agent-${Date.now()}-${process.pid}`;
    const marker = markerPathFor(sessionId, "");
    rmSync(marker, { force: true });
    try {
      const first = await runHook(subagentStartPayload({ sessionId }));
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /Meta_Kim subagent rule set/u);

      const second = await runHook(subagentStartPayload({ sessionId }));
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stdout, /Meta_Kim subagent rule set/u);
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(marker, { force: true });
    }
  });

  test("does not suppress future sessions by persisting a cwd key", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-subagent-ctx-fixture-"));
    const marker = markerPathFor(root, "meta-prism");
    rmSync(marker, { force: true });
    try {
      const first = await runHook(
        subagentStartPayload({ cwd: root, agentName: "meta-prism" }),
      );
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /Meta_Kim subagent rule set/u);

      const second = await runHook(
        subagentStartPayload({ cwd: root, agentName: "meta-prism" }),
      );
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stdout, /Meta_Kim subagent rule set/u);
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(marker, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Codex SubagentStart matcher stays scoped to governance agents", () => {
  test("project Codex hooks inject subagent-context only for meta-* agents", () => {
    const config = buildCodexProjectHooksJson({ packageRoot: "D:/Meta_Kim" });
    const entries = config.hooks.SubagentStart ?? [];
    const contextEntries = entries.filter((entry) =>
      (entry.hooks ?? []).some((hook) => hook.command?.includes("subagent-context.mjs")),
    );
    assert.ok(contextEntries.length > 0, "expected a subagent-context entry");
    for (const entry of contextEntries) {
      assert.equal(
        entry.matcher,
        "meta-*",
        "the governance rule set must not inject into every run-scoped worker subagent",
      );
    }
    const spineEntries = entries.filter((entry) =>
      (entry.hooks ?? []).some((hook) =>
        hook.command?.includes("activate-meta-theory-spine.mjs"),
      ),
    );
    assert.ok(spineEntries.length > 0, "expected the spine lifecycle entry");
    for (const entry of spineEntries) {
      assert.equal(entry.matcher, "*", "lifecycle observation must keep watching every subagent");
    }
  });

  test("global Codex hooks never wire subagent-context with a catch-all matcher", () => {
    const config = buildCodexHooksJson();
    for (const entry of config.hooks.SubagentStart ?? []) {
      const wiresContext = (entry.hooks ?? []).some((hook) =>
        hook.command?.includes("subagent-context.mjs"),
      );
      if (wiresContext) {
        assert.equal(
          entry.matcher,
          "meta-*",
          "any Codex subagent-context wiring must stay scoped to meta-* agents",
        );
      }
    }
  });
});
