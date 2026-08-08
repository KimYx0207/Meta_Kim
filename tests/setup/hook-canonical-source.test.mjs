import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

import {
  runtimeHookSourceOwner,
  SHARED_RUNTIME_HOOK_FILES,
} from "../../scripts/runtime-hook-mapping.mjs";
import { buildIsolatedUserHomeEnv } from "../../scripts/isolated-user-home-env.mjs";
import {
  createInitialState,
  readMetaRunStatus,
  readSpineStateIncludingInactive,
  sanitizeStateProfile,
  writeSpineState,
} from "../../canonical/runtime-assets/shared/hooks/spine-state.mjs";
import * as spineStateFacade from "../../canonical/runtime-assets/shared/hooks/spine-state.mjs";
import * as spineStateGates from "../../canonical/runtime-assets/shared/hooks/spine-state-gates.mjs";
import { withFileLock } from "../../canonical/runtime-assets/shared/hooks/spine-state-utils.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SHARED_HOOK_DIR = join(REPO_ROOT, "canonical", "runtime-assets", "shared", "hooks");
const CLAUDE_HOOK_DIR = join(REPO_ROOT, "canonical", "runtime-assets", "claude", "hooks");
const CLAUDE_COMPATIBILITY_ADAPTERS = new Set([
  "activate-meta-theory-spine.mjs",
  "skip-reminder.mjs",
  "spine-state.mjs",
  "utils.mjs",
]);

function runMemoryHook(script, payload, env, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let timeout;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const child = spawn(process.execPath, ["--trace-deprecation", script], {
      cwd: REPO_ROOT,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (status) => finish(resolve, { status, stdout, stderr, timedOut }));
    child.stdin.end(JSON.stringify(payload));
  });
}

test("memory hooks reject truthy non-string transcript aliases and keep valid transcript reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "meta-kim-memory-hook-path-type-"));
  const gitInit = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" });
  assert.equal(gitInit.status, 0, gitInit.stderr);
  const transcriptPath = join(root, "transcript.jsonl");
  writeFileSync(
    transcriptPath,
    '{"type":"user","message":{"content":[{"type":"text","text":"valid transcript evidence"}]}}\n',
    "utf8",
  );
  const savedMemories = [];
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"status":"healthy"}');
      return;
    }
    if (request.method === "POST" && request.url === "/api/memories") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        savedMemories.push(JSON.parse(body));
        response.writeHead(201, { "Content-Type": "application/json" });
        response.end("{}");
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const env = {
    ...process.env,
    MCP_MEMORY_URL: `http://127.0.0.1:${address.port}`,
    META_KIM_DISABLE_MEMORY_AUTOSTART: "1",
    META_KIM_DISABLE_HOOK_DEDUPE: "1",
  };
  const hookScripts = [
    join(SHARED_HOOK_DIR, "meta-kim-memory-save.mjs"),
    join(CLAUDE_HOOK_DIR, "meta-kim-memory-save.mjs"),
  ];
  const nonStringAliases = [
    { transcript_path: 17 },
    { transcriptPath: {} },
    { conversation_path: [] },
    { session_path: true },
  ];

  try {
    for (const script of hookScripts) {
      for (const alias of nonStringAliases) {
        const result = await runMemoryHook(script, { cwd: root, event: "stop", ...alias }, env);
        assert.equal(result.timedOut, false, "memory hook timed out");
        assert.equal(result.status, 0, result.stderr);
        assert.doesNotMatch(result.stderr, /DEP0187|DeprecationWarning/u);
      }
      const valid = await runMemoryHook(
        script,
        { cwd: root, event: "stop", transcript_path: transcriptPath },
        env,
      );
      assert.equal(valid.timedOut, false, "memory hook timed out");
      assert.equal(valid.status, 0, valid.stderr);
      assert.doesNotMatch(valid.stderr, /DEP0187|DeprecationWarning/u);
    }
    assert.equal(savedMemories.length, hookScripts.length * (nonStringAliases.length + 1));
    const validMemories = savedMemories.filter((memory) => memory.content.includes("valid transcript evidence"));
    assert.equal(validMemories.length, hookScripts.length);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("cross-runtime hook core has one canonical owner", () => {
  assert.deepEqual(SHARED_RUNTIME_HOOK_FILES, [
    "project-root.mjs",
    "utils.mjs",
    "skip-reminder.mjs",
    "spine-state-utils.mjs",
    "spine-state-gates.mjs",
    "spine-state.mjs",
    "activate-meta-theory-spine.mjs",
  ]);

  for (const fileName of SHARED_RUNTIME_HOOK_FILES) {
    assert.equal(existsSync(join(SHARED_HOOK_DIR, fileName)), true, fileName);
    const claudePath = join(CLAUDE_HOOK_DIR, fileName);
    if (!CLAUDE_COMPATIBILITY_ADAPTERS.has(fileName)) {
      assert.equal(existsSync(claudePath), false, fileName);
      continue;
    }
    const adapter = readFileSync(claudePath, "utf8");
    assert.match(adapter, /\.\.\/\.\.\/shared\/hooks\//, fileName);
    assert.ok(adapter.split(/\r?\n/u).filter(Boolean).length <= 2, `${fileName} must stay thin`);
    assert.notEqual(adapter, readFileSync(join(SHARED_HOOK_DIR, fileName), "utf8"));
  }
});

test("spine-state keeps its original gate exports as a compatibility facade", () => {
  const facadeExports = [
    "STAGE_ORDER",
    "STAGE_PUBLIC_LABELS",
    "CHOICE_SURFACE_STATES",
    "STAGE_META_AGENT_MAP",
    "extractMetaAgentName",
    "validateDegradedDeclaration",
    "evaluateFanoutGate",
    "checkPreExecutionReadiness",
    "checkCapabilityNodeBindings",
    "checkStageRequirements",
    "checkChoiceSurfaceGate",
    "isExecutionTool",
    "isReadOnlyTool",
    "getGovernanceFlow",
  ];

  for (const exportName of facadeExports) {
    assert.equal(
      spineStateFacade[exportName],
      spineStateGates[exportName],
      `${exportName} must remain available through spine-state.mjs`,
    );
  }
});

test("runtime-specific memory hooks keep explicit source owners", () => {
  const claudeMemory = readFileSync(
    join(CLAUDE_HOOK_DIR, "meta-kim-memory-save.mjs"),
    "utf8",
  );
  const genericMemory = readFileSync(
    join(SHARED_HOOK_DIR, "meta-kim-memory-save.mjs"),
    "utf8",
  );

  assert.equal(runtimeHookSourceOwner("claude", "meta-kim-memory-save.mjs"), "claude");
  assert.equal(runtimeHookSourceOwner("codex", "meta-kim-memory-save.mjs"), "shared");
  assert.equal(runtimeHookSourceOwner("cursor", "meta-kim-memory-save.mjs"), "shared");
  assert.equal(runtimeHookSourceOwner("claude", "stop-spine-cleanup.mjs"), "claude");
  assert.equal(runtimeHookSourceOwner("codex", "stop-spine-cleanup.mjs"), "shared");
  assert.equal(runtimeHookSourceOwner("cursor", "stop-spine-cleanup.mjs"), "shared");
  assert.equal(runtimeHookSourceOwner("codex", "stop-compaction.mjs"), "claude");
  assert.equal(runtimeHookSourceOwner("cursor", "stop-compaction.mjs"), "claude");
  assert.equal(runtimeHookSourceOwner("codex", "unknown-same-name.mjs"), null);
  assert.match(
    claudeMemory,
    /process\.env\.MCP_ALLOW_ANONYMOUS_ACCESS \|\| "true"/u,
  );
  assert.match(
    genericMemory,
    /process\.env\.MCP_ALLOW_ANONYMOUS_ACCESS \|\| "true"/u,
  );
  const setupSource = readFileSync(join(REPO_ROOT, "setup.mjs"), "utf8");
  assert.match(
    setupSource,
    /runtimeHookSourceOwner\(platformId, hookName\)/u,
  );
  const syncSource = readFileSync(join(REPO_ROOT, "scripts", "sync-runtimes.mjs"), "utf8");
  assert.doesNotMatch(syncSource, /codexMemoryHookContent|cursorMemoryHookContent/u);
});

test("global hook sync projects universal core and runtime-owned memory entrypoints", () => {
  const root = mkdtempSync(join(tmpdir(), "meta-kim-hook-source-"));
  try {
    const userHome = join(root, "user-home");
    const homes = {
      claude: join(root, "claude"),
      codex: join(root, "codex"),
      cursor: join(root, "cursor"),
    };
    const isolatedEnv = buildIsolatedUserHomeEnv(userHome, {
      META_KIM_CLAUDE_HOME: homes.claude,
      META_KIM_CODEX_HOME: homes.codex,
      META_KIM_CURSOR_HOME: homes.cursor,
    });
    const result = spawnSync(
      process.execPath,
      [
        "scripts/sync-global-meta-theory.mjs",
        "--targets",
        "claude,codex",
        "--with-global-hooks",
        "--skip-durable-mcp",
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: isolatedEnv,
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const cursorResult = spawnSync(
      process.execPath,
      ["scripts/sync-runtimes.mjs", "--scope", "global", "--targets", "cursor"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: isolatedEnv,
      },
    );
    assert.equal(cursorResult.status, 0, cursorResult.stderr || cursorResult.stdout);

    const isolatedManifestPath = join(userHome, ".meta-kim", "install-manifest.json");
    const isolatedManifest = JSON.parse(readFileSync(isolatedManifestPath, "utf8"));
    assert.ok(Array.isArray(isolatedManifest.entries));
    assert.ok(isolatedManifest.entries.some((entry) => entry.path.startsWith(root)));

    for (const fileName of SHARED_RUNTIME_HOOK_FILES) {
      const canonical = readFileSync(join(SHARED_HOOK_DIR, fileName), "utf8");
      for (const [runtime, home] of Object.entries(homes)) {
        const projected = readFileSync(
          join(home, "hooks", "meta-kim", fileName),
          "utf8",
        );
        assert.equal(projected, canonical, `${runtime}:${fileName}`);
      }
    }
    const claudeMemory = readFileSync(
      join(homes.claude, "hooks", "meta-kim", "meta-kim-memory-save.mjs"),
      "utf8",
    );
    const codexMemory = readFileSync(
      join(homes.codex, "hooks", "meta-kim", "meta-kim-memory-save.mjs"),
      "utf8",
    );
    const cursorMemory = readFileSync(
      join(homes.cursor, "hooks", "meta-kim", "meta-kim-memory-save.mjs"),
      "utf8",
    );
    assert.equal(
      claudeMemory,
      readFileSync(join(CLAUDE_HOOK_DIR, "meta-kim-memory-save.mjs"), "utf8"),
    );
    assert.equal(
      codexMemory,
      readFileSync(join(SHARED_HOOK_DIR, "meta-kim-memory-save.mjs"), "utf8"),
    );
    assert.equal(cursorMemory, codexMemory);
    const claudeStop = readFileSync(
      join(homes.claude, "hooks", "meta-kim", "stop-spine-cleanup.mjs"),
      "utf8",
    );
    const codexStop = readFileSync(
      join(homes.codex, "hooks", "meta-kim", "stop-spine-cleanup.mjs"),
      "utf8",
    );
    const cursorStop = readFileSync(
      join(homes.cursor, "hooks", "meta-kim", "stop-spine-cleanup.mjs"),
      "utf8",
    );
    assert.equal(
      claudeStop,
      readFileSync(join(CLAUDE_HOOK_DIR, "stop-spine-cleanup.mjs"), "utf8"),
    );
    assert.equal(
      codexStop,
      readFileSync(join(SHARED_HOOK_DIR, "stop-spine-cleanup.mjs"), "utf8"),
    );
    assert.equal(cursorStop, codexStop);
    assert.notEqual(claudeStop, codexStop);

    const projectRoot = join(root, "project");
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    for (const [runtime, home] of Object.entries(homes)) {
      const hooksDir = join(home, "hooks", "meta-kim");
      const profile = `projected-${runtime}`;
      const env = {
        ...process.env,
        META_KIM_PROFILE: profile,
        META_KIM_DISABLE_MEMORY_AUTOSTART: "1",
        META_KIM_POST_COPY_AUTO: "off",
      };
      for (const dependency of [
        "activate-meta-theory-spine.mjs",
        "project-root.mjs",
        "spine-state-gates.mjs",
        "spine-state.mjs",
        "spine-state-utils.mjs",
        "utils.mjs",
        "stop-spine-cleanup.mjs",
      ]) {
        assert.equal(existsSync(join(hooksDir, dependency)), true, `${runtime}:${dependency}`);
      }

      const activate = (prompt) => spawnSync(
        process.execPath,
        [join(hooksDir, "activate-meta-theory-spine.mjs")],
        {
          cwd: projectRoot,
          encoding: "utf8",
          env,
          input: JSON.stringify({ prompt }),
        },
      );
      const firstActivation = activate("critical and fetch thinking and review repair projected lifecycle");
      assert.equal(firstActivation.status, 0, firstActivation.stderr);

      const spinePath = join(
        projectRoot,
        ".meta-kim",
        "state",
        profile,
        "spine",
        "spine-state.json",
      );
      const first = JSON.parse(readFileSync(spinePath, "utf8"));
      assert.match(first.runId, /^meta-/u);
      assert.match(first.taskFingerprint, /^hmac-sha256:[a-f0-9]{64}$/u);
      assert.equal(Object.hasOwn(first, "task"), false);

      const secondActivation = activate("critical and fetch thinking and review update projected replacement");
      assert.equal(secondActivation.status, 0, secondActivation.stderr);
      const second = JSON.parse(readFileSync(spinePath, "utf8"));
      assert.notEqual(second.runId, first.runId);
      const superseded = JSON.parse(readFileSync(join(
        projectRoot,
        ".meta-kim",
        "state",
        profile,
        "runs",
        first.runId,
        "status.json",
      ), "utf8"));
      assert.equal(superseded.active, false);
      assert.equal(superseded.lifecycleStatus, "superseded");
      assert.equal(superseded.supersededByRunId, second.runId);

      const stop = spawnSync(
        process.execPath,
        [join(hooksDir, "stop-spine-cleanup.mjs")],
        { cwd: projectRoot, encoding: "utf8", env, input: "{}" },
      );
      assert.equal(stop.status, 0, stop.stderr);
      const terminal = JSON.parse(readFileSync(join(
        projectRoot,
        ".meta-kim",
        "state",
        profile,
        "runs",
        second.runId,
        "status.json",
      ), "utf8"));
      assert.equal(terminal.active, false);
      assert.equal(terminal.lifecycleStatus, "session_stopped");
      assert.equal(terminal.deactivationReason, "session_stop");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent spine writes remain atomic and keep status paired with state", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "meta-kim-spine-concurrency-"));
  try {
    const states = Array.from({ length: 12 }, (_, index) => ({
      ...createInitialState({
        taskClassification: "concurrency_regression",
        triggerReason: "test",
      }),
      runId: `meta-concurrent-${index}`,
      currentStage: index % 2 === 0 ? "fetch" : "thinking",
      writerMarker: index,
    }));

    await Promise.all(states.map((state) => writeSpineState(cwd, state)));

    const finalState = await readSpineStateIncludingInactive(cwd);
    const activeStatus = await readMetaRunStatus(cwd, "default");
    assert.ok(finalState);
    assert.ok(activeStatus);
    assert.equal(activeStatus.runId, finalState.runId);
    assert.equal(activeStatus.currentStageKey, finalState.currentStage);
    assert.equal(
      existsSync(
        join(cwd, ".meta-kim", "state", "default", "spine", "spine-state.json.lock"),
      ),
      false,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("stale lock owners are reclaimed after a crashed writer", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "meta-kim-stale-lock-"));
  const lockPath = join(cwd, "spine-state.json.lock");
  try {
    writeFileSync(lockPath, `${JSON.stringify({ pid: 2147483647, createdAt: "2000-01-01T00:00:00.000Z" })}\n`);
    let entered = false;
    await withFileLock(lockPath, async () => { entered = true; });
    assert.equal(entered, true);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an old lock owned by a live PID is never reclaimed", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "meta-kim-live-lock-"));
  const lockPath = join(cwd, "spine-state.json.lock");
  try {
    const content = `${JSON.stringify({
      pid: process.pid,
      createdAt: "2000-01-01T00:00:00.000Z",
      nonce: "live-owner",
    })}\n`;
    writeFileSync(lockPath, content);
    const oldTime = new Date("2000-01-01T00:00:00.000Z");
    utimesSync(lockPath, oldTime, oldTime);
    let entered = false;
    await assert.rejects(
      withFileLock(lockPath, async () => { entered = true; }),
      /Failed to acquire file lock/u,
    );
    assert.equal(entered, false);
    assert.equal(readFileSync(lockPath, "utf8"), content);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("META_KIM_PROFILE keeps spine and status envelopes in one named profile", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "meta-kim-named-profile-"));
  const previous = process.env.META_KIM_PROFILE;
  process.env.META_KIM_PROFILE = "named-profile";
  try {
    const state = {
      ...createInitialState({ taskClassification: "profile_regression", triggerReason: "test" }),
      runId: "meta-named-profile-run",
      currentStage: "fetch",
    };
    await writeSpineState(cwd, state);
    assert.equal(
      existsSync(join(cwd, ".meta-kim", "state", "named-profile", "spine", "spine-state.json")),
      true,
    );
    assert.equal(
      existsSync(join(cwd, ".meta-kim", "state", "named-profile", "active-run.json")),
      true,
    );
    assert.equal(existsSync(join(cwd, ".meta-kim", "state", "default", "spine", "spine-state.json")), false);
  } finally {
    if (previous === undefined) delete process.env.META_KIM_PROFILE;
    else process.env.META_KIM_PROFILE = previous;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("writeSpineState resolves one profile when environment and state disagree", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "meta-kim-profile-mismatch-"));
  const previous = process.env.META_KIM_PROFILE;
  process.env.META_KIM_PROFILE = "environment-profile";
  try {
    const state = {
      ...createInitialState({ taskClassification: "profile_regression", triggerReason: "test" }),
      runId: "meta-profile-mismatch-run",
      currentStage: "thinking",
      profile: "state-profile",
    };
    await writeSpineState(cwd, state);

    assert.equal(
      existsSync(join(cwd, ".meta-kim", "state", "environment-profile", "spine", "spine-state.json")),
      true,
    );
    assert.equal(
      existsSync(join(cwd, ".meta-kim", "state", "environment-profile", "active-run.json")),
      true,
    );
    assert.equal(
      existsSync(
        join(
          cwd,
          ".meta-kim",
          "state",
          "environment-profile",
          "runs",
          "meta-profile-mismatch-run",
          "status.json",
        ),
      ),
      true,
    );
    assert.equal(existsSync(join(cwd, ".meta-kim", "state", "state-profile")), false);
  } finally {
    if (previous === undefined) delete process.env.META_KIM_PROFILE;
    else process.env.META_KIM_PROFILE = previous;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("custom spine directory routes spine and status through the same profile", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "meta-kim-custom-spine-profile-"));
  const previousProfile = process.env.META_KIM_PROFILE;
  const previousSpineDir = process.env.META_KIM_SPINE_STATE_DIR;
  process.env.META_KIM_PROFILE = "environment-profile";
  process.env.META_KIM_SPINE_STATE_DIR = ".meta-kim/state/custom-profile/spine";
  try {
    const state = {
      ...createInitialState({ taskClassification: "profile_regression", triggerReason: "test" }),
      runId: "meta-custom-profile-run",
      currentStage: "review",
    };
    await writeSpineState(cwd, state);

    assert.equal(
      existsSync(join(cwd, ".meta-kim", "state", "custom-profile", "spine", "spine-state.json")),
      true,
    );
    assert.equal(
      existsSync(join(cwd, ".meta-kim", "state", "custom-profile", "active-run.json")),
      true,
    );
    assert.equal(
      existsSync(
        join(
          cwd,
          ".meta-kim",
          "state",
          "custom-profile",
          "runs",
          "meta-custom-profile-run",
          "status.json",
        ),
      ),
      true,
    );
    assert.equal(existsSync(join(cwd, ".meta-kim", "state", "environment-profile")), false);
    assert.equal((await readSpineStateIncludingInactive(cwd))?.runId, "meta-custom-profile-run");
    assert.equal((await readMetaRunStatus(cwd, "custom-profile"))?.runId, "meta-custom-profile-run");
  } finally {
    if (previousProfile === undefined) delete process.env.META_KIM_PROFILE;
    else process.env.META_KIM_PROFILE = previousProfile;
    if (previousSpineDir === undefined) delete process.env.META_KIM_SPINE_STATE_DIR;
    else process.env.META_KIM_SPINE_STATE_DIR = previousSpineDir;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("profile sanitization is stable, readable, and collision-resistant", () => {
  for (const profile of ["default", "tenant-a", "team.one_2"]) {
    assert.equal(sanitizeStateProfile(profile), profile);
  }
  const upper = sanitizeStateProfile("UPPER.case");
  assert.match(upper, /^derived-upper\.case-[a-f0-9]{12}$/u);
  assert.notEqual(upper, sanitizeStateProfile("upper.case"));
  assert.notEqual(sanitizeStateProfile("Team"), sanitizeStateProfile("team"));
  assert.equal(sanitizeStateProfile("Team"), sanitizeStateProfile("Team"));

  const slash = sanitizeStateProfile("tenant/a");
  const space = sanitizeStateProfile("tenant a");
  assert.match(slash, /^derived-tenant-a-[a-f0-9]{12}$/u);
  assert.match(space, /^derived-tenant-a-[a-f0-9]{12}$/u);
  assert.notEqual(slash, space);

  const traversal = sanitizeStateProfile("../../customer-a");
  assert.match(traversal, /^derived-customer-a-[a-f0-9]{12}$/u);
  assert.doesNotMatch(traversal, /\.\.|[\\/]/u);

  const longA = sanitizeStateProfile(`${"tenant".repeat(20)}-a`);
  const longB = sanitizeStateProfile(`${"tenant".repeat(20)}-b`);
  assert.ok(longA.length <= 80);
  assert.ok(longB.length <= 80);
  assert.notEqual(longA, longB);
  assert.match(longA, /-[a-f0-9]{12}$/u);
});

test("unsafe custom spine profile segment uses the same collision-resistant route", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "meta-kim-unsafe-custom-spine-"));
  const previousSpineDir = process.env.META_KIM_SPINE_STATE_DIR;
  process.env.META_KIM_SPINE_STATE_DIR = ".meta-kim/state/tenant a/spine";
  try {
    const profile = sanitizeStateProfile("tenant a");
    const state = {
      ...createInitialState({ taskClassification: "profile_regression", triggerReason: "test" }),
      runId: "meta-unsafe-custom-profile-run",
    };
    await writeSpineState(cwd, state);
    assert.equal(
      existsSync(join(cwd, ".meta-kim", "state", profile, "spine", "spine-state.json")),
      true,
    );
    assert.equal(
      existsSync(join(cwd, ".meta-kim", "state", profile, "active-run.json")),
      true,
    );
    assert.equal(existsSync(join(cwd, ".meta-kim", "state", "tenant a")), false);
  } finally {
    if (previousSpineDir === undefined) delete process.env.META_KIM_SPINE_STATE_DIR;
    else process.env.META_KIM_SPINE_STATE_DIR = previousSpineDir;
    rmSync(cwd, { recursive: true, force: true });
  }
});
