import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyHookClosure } from "../helpers/hook-fixture.mjs";

// Regression coverage for the project-root gate shared by the meta-theory spine
// activate hook and the post-copy init script. Neither may bootstrap/project
// state into an arbitrary cwd (a temp dir a stray invocation runs in). They may
// only project at a *legitimate* project root, resolved by the same rule in both
// entry points:
//   1. CLAUDE_PROJECT_DIR, trusted only when it resolves to a real directory;
//   2. a runtime payload root, accepted only when marker-backed;
//   3. else a strong cwd marker (.git or the meta-kim project-bootstrap
//      manifest), found by walking up from cwd;
//   4. else nothing — skip projection.
// Tests exercise real runtime behaviour (they run the hook / the script), and a
// stubbed, network-free "python" is used where the script's success path would
// otherwise shell out to pip/graphify.

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const POST_COPY_SCRIPT = path.join(
  REPO_ROOT,
  "scripts",
  "project-post-copy-init.mjs",
);

// Deterministically triggers meta-theory activation via the skill-activation
// path, so activator tests exercise the project-root gate rather than the
// prompt-classification heuristics.
const TRIGGER_PAYLOAD = JSON.stringify({
  tool_name: "Skill",
  tool_input: { skill_name: "meta-theory" },
});

// A stub interpreter that satisfies the post-copy script's python/pip/graphify
// probes without any network access, so the script's success path can be
// observed safely and portably.
const FAKE_PYTHON = [
  'const args = process.argv.slice(2).filter((a) => a !== "-3");',
  'const j = args.join(" ");',
  'if (args.includes("--version")) { console.log("Python 3.12.0"); process.exit(0); }',
  'if (j === "-m pip --version") { console.log("pip 24.0"); process.exit(0); }',
  'if (j === "-m ensurepip --upgrade") { process.exit(0); }',
  'if (j === "-m pip show graphifyy") { console.log("Name: graphifyy\\nVersion: 1.2.3"); process.exit(0); }',
  "process.exit(0);",
].join("\n");

function writeFakeExecutable(dir, name, source) {
  writeFileSync(path.join(dir, `${name}.mjs`), source);
  if (process.platform === "win32") {
    writeFileSync(
      path.join(dir, `${name}.cmd`),
      `@echo off\r\nnode "%~dp0${name}.mjs" %*\r\n`,
    );
    return;
  }
  const binPath = path.join(dir, name);
  writeFileSync(binPath, `#!/usr/bin/env node\nimport "./${name}.mjs";\n`);
  chmodSync(binPath, 0o755);
}

function stageActivateHook(dir) {
  const hookDir = path.join(dir, "hooks");
  mkdirSync(hookDir, { recursive: true });
  copyHookClosure(REPO_ROOT, hookDir, ["activate-meta-theory-spine.mjs"]);
  return path.join(hookDir, "activate-meta-theory-spine.mjs");
}

function runActivate(hookPath, cwd, extraEnv = {}) {
  const env = { ...process.env };
  // Strip any inherited CLAUDE_PROJECT_DIR so the gate must rely on the cwd
  // marker; callers re-declare it explicitly through extraEnv.
  delete env.CLAUDE_PROJECT_DIR;
  // Keep the activator opportunistic post-copy launch inert in tests.
  env.META_KIM_POST_COPY_AUTO = "off";
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [hookPath], {
    cwd,
    input: TRIGGER_PAYLOAD,
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
    env,
  });
}

// Like runActivate, but sends a custom activation payload (still triggering
// meta-theory via the Skill path) so a test can inject extra top-level payload
// fields — e.g. a host-provided cross-runtime project-root declaration.
function runActivateWithPayload(hookPath, cwd, extraPayload = {}, extraEnv = {}) {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  env.META_KIM_POST_COPY_AUTO = "off";
  Object.assign(env, extraEnv);
  const input = JSON.stringify({
    tool_name: "Skill",
    tool_input: { skill_name: "meta-theory" },
    ...extraPayload,
  });
  return spawnSync(process.execPath, [hookPath], {
    cwd,
    input,
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
    env,
  });
}

function spineStatePath(dir) {
  return path.join(
    dir,
    ".meta-kim",
    "state",
    "default",
    "spine",
    "spine-state.json",
  );
}

describe("meta-theory spine activate project-root gate", () => {
  test("does not project into a non-project temp dir", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "meta-kim-noproj-"));
    try {
      const hookPath = stageActivateHook(cwd);
      const result = runActivate(hookPath, cwd);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(
        existsSync(path.join(cwd, ".meta-kim")),
        false,
        "activate must not project .meta-kim state into a non-project dir",
      );
      assert.equal(
        existsSync(path.join(cwd, "graphify-out")),
        false,
        "activate must not bootstrap graphify into a non-project dir",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("projects spine state at a .git-marked project root", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "meta-kim-git-"));
    try {
      mkdirSync(path.join(cwd, ".git"), { recursive: true });
      const hookPath = stageActivateHook(cwd);
      const result = runActivate(hookPath, cwd);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(
        existsSync(spineStatePath(cwd)),
        true,
        "activate must project spine state at a .git project root",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("keeps raw host conversation identity advisory until independently verified", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "meta-kim-conversation-"));
    try {
      mkdirSync(path.join(cwd, ".git"), { recursive: true });
      const hookPath = stageActivateHook(cwd);
      const result = runActivateWithPayload(
        hookPath,
        cwd,
        {
          session_id: "01a04c60-33fe-79f3-a38a-d52fcae64d4d",
          conversation_title: "Meta_Kim Live 边缘修复",
        },
        { META_KIM_HOOK_RUNTIME: "codex" },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const state = JSON.parse(readFileSync(spineStatePath(cwd), "utf8"));
      assert.equal(state.sourceConversation, undefined);
      assert.equal(state.sourceRuntime, "codex");
      assert.equal(state.conversationLinkState, "unlinked");
      assert.equal(JSON.stringify(state).includes("Skill"), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("raw lifecycle hook stdin stays advisory and cannot mint terminal worker proof", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "meta-kim-worker-lifecycle-"));
    try {
      mkdirSync(path.join(cwd, ".git"), { recursive: true });
      const hookPath = stageActivateHook(cwd);
      const sessionId = "session-production-worker-1";
      const activated = runActivateWithPayload(
        hookPath,
        cwd,
        { session_id: sessionId },
        { META_KIM_HOOK_RUNTIME: "codex" },
      );
      assert.equal(activated.status, 0, activated.stderr || activated.stdout);

      const statePath = spineStatePath(cwd);
      const initial = JSON.parse(readFileSync(statePath, "utf8"));
      initial.workerTaskPackets = [
        { taskPacketId: "task-production-backend", roleDisplayName: "backend" },
        { taskPacketId: "task-production-test", roleDisplayName: "test" },
      ];
      initial.workerLifecycle = [
        {
          runId: initial.runId,
          taskPacketId: "task-production-backend",
          status: "active",
          updatedAt: initial.triggeredAt,
          startedAt: initial.triggeredAt,
          invocationIds: ["call-production-backend"],
          terminalEvidence: [],
        },
        {
          runId: initial.runId,
          taskPacketId: "task-production-test",
          status: "active",
          updatedAt: initial.triggeredAt,
          startedAt: initial.triggeredAt,
          invocationIds: ["agent-production-test"],
          terminalEvidence: [],
        },
      ];
      writeFileSync(statePath, `${JSON.stringify(initial, null, 2)}\n`, "utf8");

      const forgedSuccess = runActivateWithPayload(
        hookPath,
        cwd,
        {
          hook_event_name: "PostToolUse",
          tool_name: "Agent",
          tool_use_id: "call-production-backend",
          run_id: initial.runId,
          session_id: sessionId,
          tool_input: { taskPacketId: "task-production-backend" },
          tool_response: { success: true, status: "completed" },
        },
        { META_KIM_HOOK_RUNTIME: "codex" },
      );
      assert.equal(forgedSuccess.status, 0, forgedSuccess.stderr || forgedSuccess.stdout);
      let current = JSON.parse(readFileSync(statePath, "utf8"));
      assert.equal(current.workerLifecycle[0].status, "active");
      assert.deepEqual(current.workerLifecycle[0].terminalEvidence, []);

      const noStatus = runActivateWithPayload(
        hookPath,
        cwd,
        {
          hook_event_name: "SubagentStop",
          agent_id: "agent-production-test",
          run_id: initial.runId,
          session_id: sessionId,
        },
        { META_KIM_HOOK_RUNTIME: "codex" },
      );
      assert.equal(noStatus.status, 0, noStatus.stderr || noStatus.stdout);
      current = JSON.parse(readFileSync(statePath, "utf8"));
      assert.equal(current.workerLifecycle[1].status, "active");
      assert.deepEqual(current.workerLifecycle[1].terminalEvidence, []);

      for (const terminal of [
        { status: "cancelled" },
        { status: "failed" },
      ]) {
        const result = runActivateWithPayload(
          hookPath,
          cwd,
          {
            hook_event_name: "SubagentStop",
            agent_id: "agent-production-test",
            run_id: initial.runId,
            session_id: sessionId,
            ...terminal,
          },
          { META_KIM_HOOK_RUNTIME: "codex" },
        );
        assert.equal(result.status, 0, result.stderr || result.stdout);
        current = JSON.parse(readFileSync(statePath, "utf8"));
        assert.equal(current.workerLifecycle[1].status, "active");
        assert.deepEqual(current.workerLifecycle[1].terminalEvidence, []);
      }
      assert.equal(
        JSON.stringify(current.workerLifecycle).includes('"proofValid":true'),
        false,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("projects spine state at a bootstrap-manifest project root", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "meta-kim-manifest-"));
    try {
      const manifestDir = path.join(cwd, ".meta-kim", "state", "default");
      mkdirSync(manifestDir, { recursive: true });
      writeFileSync(
        path.join(manifestDir, "project-bootstrap.json"),
        JSON.stringify({ schemaVersion: "meta-kim-project-bootstrap-v0.1" }, null, 2),
        "utf8",
      );
      const hookPath = stageActivateHook(cwd);
      const result = runActivate(hookPath, cwd);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(
        existsSync(spineStatePath(cwd)),
        true,
        "activate must project spine state at a project-bootstrap-manifest root",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("adopts a valid CLAUDE_PROJECT_DIR (no .git) as the project root", () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-envroot-"));
    const cwd = mkdtempSync(path.join(os.tmpdir(), "meta-kim-envcwd-"));
    try {
      // projectDir is a real directory with no .git / no manifest; only the
      // explicit declaration makes it a project root.
      const hookPath = stageActivateHook(cwd);
      const result = runActivate(hookPath, cwd, { CLAUDE_PROJECT_DIR: projectDir });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(
        existsSync(spineStatePath(projectDir)),
        true,
        "activate must project into the declared CLAUDE_PROJECT_DIR",
      );
      assert.equal(
        existsSync(path.join(cwd, ".meta-kim")),
        false,
        "activate must not project into the (non-project) cwd",
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("does not trust a CLAUDE_PROJECT_DIR that points at a non-existent path", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "meta-kim-badenv-"));
    try {
      const bogus = path.join(cwd, "does-not-exist", "nope");
      const hookPath = stageActivateHook(cwd);
      const result = runActivate(hookPath, cwd, { CLAUDE_PROJECT_DIR: bogus });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      // An unusable explicit declaration must not be trusted; cwd has no marker
      // either, so nothing is projected — not into cwd, not into the bogus path.
      assert.equal(
        existsSync(path.join(cwd, ".meta-kim")),
        false,
        "invalid CLAUDE_PROJECT_DIR must fall through and skip projection",
      );
      assert.equal(existsSync(bogus), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("resolves the project root from a nested subdirectory (walk-up)", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-subdir-"));
    try {
      mkdirSync(path.join(root, ".git"), { recursive: true });
      const subdir = path.join(root, "packages", "app", "src");
      mkdirSync(subdir, { recursive: true });
      // Hook package lives at the project root; the hook runs with cwd = subdir.
      const hookPath = stageActivateHook(root);
      const result = runActivate(hookPath, subdir);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(
        existsSync(spineStatePath(root)),
        true,
        "walk-up from a subdir must project spine state at the .git project root",
      );
      assert.equal(
        existsSync(path.join(subdir, ".meta-kim")),
        false,
        "walk-up must not project into the subdirectory itself",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts marker-backed cross-runtime payload roots", () => {
    const payloadRootFields = [
      "cwd",
      "workspace_root",
      "workspaceRoot",
      "workspace_dir",
      "workspaceDir",
      "project_dir",
      "projectDir",
      "project_root",
      "projectRoot",
    ];
    for (const field of payloadRootFields) {
      const projectDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-payloadroot-"));
      const cwd = mkdtempSync(path.join(os.tmpdir(), "meta-kim-payloadcwd-"));
      try {
        mkdirSync(path.join(projectDir, ".git"), { recursive: true });
        const hookPath = stageActivateHook(cwd);
        const result = runActivateWithPayload(hookPath, cwd, { [field]: projectDir });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.equal(
          existsSync(spineStatePath(projectDir)),
          true,
          `marker-backed payload field "${field}" must resolve the project root`,
        );
        assert.equal(
          existsSync(path.join(cwd, ".meta-kim")),
          false,
          `payload field "${field}" must not cause projection into the cwd`,
        );
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  });

  test("rejects an unmarked payload directory", () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-payload-unmarked-"));
    const cwd = mkdtempSync(path.join(os.tmpdir(), "meta-kim-payloadcwd-"));
    try {
      const hookPath = stageActivateHook(cwd);
      const result = runActivateWithPayload(hookPath, cwd, { workspaceRoot: projectDir });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(existsSync(path.join(projectDir, ".meta-kim")), false);
      assert.equal(existsSync(path.join(cwd, ".meta-kim")), false);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("does not let payload redirect a valid cwd project to another repository", () => {
    const cwdProject = mkdtempSync(path.join(os.tmpdir(), "meta-kim-payload-cwd-project-"));
    const otherProject = mkdtempSync(path.join(os.tmpdir(), "meta-kim-payload-other-project-"));
    try {
      mkdirSync(path.join(cwdProject, ".git"), { recursive: true });
      mkdirSync(path.join(otherProject, ".git"), { recursive: true });
      const hookPath = stageActivateHook(cwdProject);
      const result = runActivateWithPayload(hookPath, cwdProject, {
        workspaceRoot: otherProject,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(existsSync(spineStatePath(cwdProject)), true);
      assert.equal(existsSync(path.join(otherProject, ".meta-kim")), false);
    } finally {
      rmSync(cwdProject, { recursive: true, force: true });
      rmSync(otherProject, { recursive: true, force: true });
    }
  });

  test("rejects relative payload project roots", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "meta-kim-payload-relative-"));
    try {
      const relativeProject = path.join(cwd, "other-project");
      mkdirSync(path.join(relativeProject, ".git"), { recursive: true });
      const hookPath = stageActivateHook(cwd);
      const result = runActivateWithPayload(hookPath, cwd, {
        workspaceRoot: "other-project",
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(existsSync(path.join(relativeProject, ".meta-kim")), false);
      assert.equal(existsSync(path.join(cwd, ".meta-kim")), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("project-post-copy-init project-root gate", () => {
  test("no-ops (exit 0, no bootstrap) in a non-project temp dir", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "meta-kim-postcopy-"));
    try {
      const env = { ...process.env };
      delete env.CLAUDE_PROJECT_DIR;
      const result = spawnSync(process.execPath, [POST_COPY_SCRIPT], {
        cwd,
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true,
        env,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(
        existsSync(path.join(cwd, ".meta-kim")),
        false,
        "post-copy init must not write .meta-kim state into a non-project dir",
      );
      assert.equal(
        existsSync(path.join(cwd, "graphify-out")),
        false,
        "post-copy init must not bootstrap graphify into a non-project dir",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("no-ops when CLAUDE_PROJECT_DIR points at a non-existent path", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "meta-kim-postcopy-badenv-"));
    try {
      const bogus = path.join(cwd, "does-not-exist", "nope");
      const env = { ...process.env };
      delete env.CLAUDE_PROJECT_DIR;
      env.CLAUDE_PROJECT_DIR = bogus;
      const result = spawnSync(process.execPath, [POST_COPY_SCRIPT], {
        cwd,
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true,
        env,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      // Invalid explicit path falls back to the cwd walk-up, which finds no
      // marker in a bare temp dir, so the script safely skips (no bootstrap).
      assert.equal(existsSync(path.join(cwd, ".meta-kim")), false);
      assert.equal(existsSync(bogus), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("adopts a valid CLAUDE_PROJECT_DIR (no .git), matching the activator", () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-pc-project-"));
    const cwd = mkdtempSync(path.join(os.tmpdir(), "meta-kim-pc-cwd-"));
    const fakeBin = mkdtempSync(path.join(os.tmpdir(), "meta-kim-pc-bin-"));
    try {
      for (const name of ["py", "python", "python3"]) {
        writeFakeExecutable(fakeBin, name, FAKE_PYTHON);
      }
      const env = { ...process.env };
      delete env.CLAUDE_PROJECT_DIR;
      env.CLAUDE_PROJECT_DIR = projectDir; // valid directory, but no .git marker
      env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
      env.Path = `${fakeBin}${path.delimiter}${process.env.Path ?? ""}`;
      const result = spawnSync(process.execPath, [POST_COPY_SCRIPT], {
        cwd,
        encoding: "utf8",
        timeout: 30000,
        windowsHide: true,
        env,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      // The script adopted the declared project dir and ran post-copy there
      // (against a stubbed, network-free python), writing its marker into
      // projectDir — not skipping, and not touching the bare cwd.
      assert.equal(
        existsSync(
          path.join(projectDir, ".meta-kim", "state", "default", "post-copy-init.json"),
        ),
        true,
        "post-copy init must adopt CLAUDE_PROJECT_DIR and initialize there",
      );
      assert.equal(existsSync(path.join(cwd, ".meta-kim")), false);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  test("adopts an explicit --project-root from an unrelated unmarked cwd", () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-pc-cli-project-"));
    const cwd = mkdtempSync(path.join(os.tmpdir(), "meta-kim-pc-cli-cwd-"));
    const fakeBin = mkdtempSync(path.join(os.tmpdir(), "meta-kim-pc-cli-bin-"));
    try {
      for (const name of ["py", "python", "python3"]) {
        writeFakeExecutable(fakeBin, name, FAKE_PYTHON);
      }
      const env = { ...process.env };
      delete env.CLAUDE_PROJECT_DIR;
      env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
      env.Path = `${fakeBin}${path.delimiter}${process.env.Path ?? ""}`;
      const result = spawnSync(
        process.execPath,
        [POST_COPY_SCRIPT, "--project-root", projectDir],
        {
          cwd,
          encoding: "utf8",
          timeout: 30000,
          windowsHide: true,
          env,
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(
        existsSync(
          path.join(projectDir, ".meta-kim", "state", "default", "post-copy-init.json"),
        ),
        true,
      );
      assert.equal(existsSync(path.join(cwd, ".meta-kim")), false);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  test("falls back to a marked ancestor when CLAUDE_PROJECT_DIR is invalid (walk-up)", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-pc-badenv-root-"));
    const fakeBin = mkdtempSync(path.join(os.tmpdir(), "meta-kim-pc-bin-"));
    try {
      // Mark the root with the project-bootstrap manifest (the non-.git marker),
      // then invoke from a nested subdir with an INVALID CLAUDE_PROJECT_DIR. The
      // gate must discard the unusable declaration, walk up to the marked
      // ancestor, and initialize there — matching the activator's rule.
      const manifestDir = path.join(root, ".meta-kim", "state", "default");
      mkdirSync(manifestDir, { recursive: true });
      writeFileSync(
        path.join(manifestDir, "project-bootstrap.json"),
        JSON.stringify({ schemaVersion: "meta-kim-project-bootstrap-v0.1" }, null, 2),
        "utf8",
      );
      const subdir = path.join(root, "packages", "app");
      mkdirSync(subdir, { recursive: true });
      for (const name of ["py", "python", "python3"]) {
        writeFakeExecutable(fakeBin, name, FAKE_PYTHON);
      }
      const bogus = path.join(root, "does-not-exist", "nope");
      const env = { ...process.env };
      delete env.CLAUDE_PROJECT_DIR;
      env.CLAUDE_PROJECT_DIR = bogus; // invalid → must fall through to walk-up
      env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
      env.Path = `${fakeBin}${path.delimiter}${process.env.Path ?? ""}`;
      const result = spawnSync(process.execPath, [POST_COPY_SCRIPT], {
        cwd: subdir,
        encoding: "utf8",
        timeout: 30000,
        windowsHide: true,
        env,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(
        existsSync(path.join(root, ".meta-kim", "state", "default", "post-copy-init.json")),
        true,
        "invalid CLAUDE_PROJECT_DIR must fall back to the marked ancestor and init there",
      );
      assert.equal(
        existsSync(path.join(subdir, ".meta-kim")),
        false,
        "post-copy must not init in the subdirectory it was invoked from",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  test("resolves the project root from a nested subdirectory (walk-up)", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-pc-subdir-"));
    const fakeBin = mkdtempSync(path.join(os.tmpdir(), "meta-kim-pc-bin-"));
    try {
      // .git at the root, no CLAUDE_PROJECT_DIR, invoked from a deep subdir.
      // post-copy must walk up to the .git root and initialize there, never in
      // the subdirectory — mirroring the activator's nested-subdir behaviour.
      mkdirSync(path.join(root, ".git"), { recursive: true });
      const subdir = path.join(root, "packages", "app", "src");
      mkdirSync(subdir, { recursive: true });
      for (const name of ["py", "python", "python3"]) {
        writeFakeExecutable(fakeBin, name, FAKE_PYTHON);
      }
      const env = { ...process.env };
      delete env.CLAUDE_PROJECT_DIR;
      env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
      env.Path = `${fakeBin}${path.delimiter}${process.env.Path ?? ""}`;
      const result = spawnSync(process.execPath, [POST_COPY_SCRIPT], {
        cwd: subdir,
        encoding: "utf8",
        timeout: 30000,
        windowsHide: true,
        env,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(
        existsSync(path.join(root, ".meta-kim", "state", "default", "post-copy-init.json")),
        true,
        "walk-up from a subdir must init post-copy state at the .git project root",
      );
      assert.equal(
        existsSync(path.join(subdir, ".meta-kim")),
        false,
        "walk-up must not init into the subdirectory itself",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });
});
