import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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
  "graphify-context.mjs",
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

function markerPathFor(keyMaterial) {
  const hash = createHash("sha256").update(keyMaterial).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `meta-kim-graphify-ctx-${hash}.flag`);
}

function fixtureWithGraph() {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-graphify-ctx-fixture-"));
  mkdirSync(path.join(root, "graphify-out"), { recursive: true });
  writeFileSync(path.join(root, "graphify-out", "graph.json"), "{}", "utf8");
  return root;
}

function searchPayload(root, sessionId) {
  return {
    session_id: sessionId,
    cwd: root,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "rg TODO src/" },
  };
}

describe("graphify-context token guard", () => {
  test("unidentified sessions never inherit a directory-wide suppression marker", async () => {
    const root = fixtureWithGraph();
    const marker = markerPathFor(root);
    try {
      writeFileSync(marker, "old unrelated conversation");
      const result = await runHook({ ...searchPayload(root, ""), session_id: undefined });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /graphify query/u);
    } finally {
      rmSync(marker, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("META_KIM_GRAPHIFY_CONTEXT=off emits nothing and exits 0", async () => {
    const root = fixtureWithGraph();
    try {
      const result = await runHook(
        searchPayload(root, `off-switch-${Date.now()}-${process.pid}`),
        { META_KIM_GRAPHIFY_CONTEXT: "off" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), "");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("emits the graphify tip once per session, then stays silent until the session changes", async () => {
    const root = fixtureWithGraph();
    const sessionId = `dedup-session-${Date.now()}-${process.pid}`;
    const markerPath = markerPathFor(sessionId);
    rmSync(markerPath, { force: true });
    try {
      const first = await runHook(searchPayload(root, sessionId));
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /graphify query/u);
      assert.equal(existsSync(markerPath), true, "expected a once-per-session marker file");
      assert.ok(statSync(markerPath).size <= 256, "marker file must stay tiny");

      const second = await runHook(searchPayload(root, sessionId));
      assert.equal(second.status, 0, second.stderr);
      assert.equal(second.stdout.trim(), "", "same session must not re-inject the tip");

      const otherSession = await runHook(
        searchPayload(root, `${sessionId}-next`),
      );
      assert.equal(otherSession.status, 0, otherSession.stderr);
      assert.match(otherSession.stdout, /graphify query/u);
      rmSync(markerPathFor(`${sessionId}-next`), { force: true });
    } finally {
      rmSync(markerPath, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("concurrent duplicate events claim the session marker exactly once", async () => {
    const root = fixtureWithGraph();
    const sessionId = `concurrent-${Date.now()}-${process.pid}`;
    const markerPath = markerPathFor(sessionId);
    rmSync(markerPath, { force: true });
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => runHook(searchPayload(root, sessionId))),
      );
      assert.ok(results.every((result) => result.status === 0), results.map((result) => result.stderr).join("\n"));
      assert.equal(
        results.filter((result) => result.stdout.trim()).length,
        1,
        "parallel registrations must not all inject the same full hint",
      );
    } finally {
      rmSync(markerPath, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not persist suppression when the payload has no session id", async () => {
    const root = fixtureWithGraph();
    const markerPath = markerPathFor(root);
    rmSync(markerPath, { force: true });
    try {
      const first = await runHook({ ...searchPayload(root, ""), session_id: undefined });
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /graphify query/u);

      const second = await runHook({ ...searchPayload(root, ""), session_id: undefined });
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stdout, /graphify query/u);
      assert.equal(existsSync(markerPath), false, "unknown sessions cannot share directory-wide suppression");
    } finally {
      rmSync(markerPath, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("non-search commands and missing graph.json never emit or write a marker", async () => {
    const root = fixtureWithGraph();
    const quietSession = `quiet-${Date.now()}-${process.pid}`;
    const quietMarker = markerPathFor(quietSession);
    rmSync(quietMarker, { force: true });
    try {
      const nonSearch = await runHook({
        ...searchPayload(root, quietSession),
        tool_input: { command: "ls -la" },
      });
      assert.equal(nonSearch.status, 0, nonSearch.stderr);
      assert.equal(nonSearch.stdout.trim(), "");
      assert.equal(existsSync(quietMarker), false, "no marker before the first real search");

      rmSync(path.join(root, "graphify-out"), { recursive: true, force: true });
      const noGraph = await runHook(searchPayload(root, quietSession));
      assert.equal(noGraph.status, 0, noGraph.stderr);
      assert.equal(noGraph.stdout.trim(), "");
      assert.equal(existsSync(quietMarker), false);
    } finally {
      rmSync(quietMarker, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a broken tmp dir never suppresses emission", async () => {
    const root = fixtureWithGraph();
    const brokenTmp = path.join(root, "no-such-tmp");
    try {
      const result = await runHook(
        searchPayload(root, `broken-tmp-${Date.now()}-${process.pid}`),
        { TMP: brokenTmp, TEMP: brokenTmp, TMPDIR: brokenTmp },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /graphify query/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
