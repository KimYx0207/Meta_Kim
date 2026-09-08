import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import * as cleanRoom from "../../scripts/live-acceptance/run-clean-room-live-acceptance.mjs";

import {
  DEPENDENCY_INSTALL_SILENT_NOOP_BLOCKER,
  classifyDependencyInstallStep,
  resolveCleanRoomKeepTemp,
  resolveInstallGateOutcome,
} from "../../scripts/live-acceptance/run-clean-room-live-acceptance.mjs";
import { installerAckLine } from "../../scripts/installer-ack.mjs";

const readyGate = {
  installExitCode: 0,
  dependencyReady: true,
  projectionSyncExitCode: 0,
  bootstrapExitCode: 0,
  mcpTransportProbeExitCode: 0,
  mcpTransportEventCount: 1,
};

test("clean-room project initialization has one writer and verifies its manifest", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "meta-kim-bootstrap-order-"));
  try {
    const calls = [];
    const bytes = "# owned projection\n";
    const relPath = ".agents/skills/meta-theory/SKILL.md";
    const runCommand = (_command, args) => {
      calls.push(args);
      assert.equal(path.basename(args[0]), "setup.mjs", "sync-runtimes must not pre-create unowned files");
      if (args.includes("--apply")) {
        mkdirSync(path.dirname(path.join(workspace, relPath)), { recursive: true });
        writeFileSync(path.join(workspace, relPath), bytes);
        const state = path.join(workspace, ".meta-kim/state/default");
        mkdirSync(state, { recursive: true });
        writeFileSync(path.join(state, "project-bootstrap.json"), JSON.stringify({
          schemaVersion: "meta-kim-project-bootstrap-v0.1",
          managedFiles: [{ relPath, contentHash: createHash("sha256").update(bytes).digest("hex") }],
        }));
      }
      return { status: 0, stderr: "", stdout: JSON.stringify({ ok: true, results: [{
        state: { targetDir: workspace, status: "ready", counts: { pending: 0 } },
      }] }) };
    };
    const result = await cleanRoom.initializeCleanRoomProject({ workspace, runtimeTarget: "codex", env: {}, timeoutMs: 1000, runCommand });
    assert.equal(result.bootstrap.status, 0);
    assert.equal(result.projectionVerification.status, 0);
    assert.equal(result.projectionVerification.managedFileCount, 1);
    assert.equal(result.projectionSyncMode, "bootstrap_only_with_dry_run_and_manifest_verification");
    assert.equal(calls.length, 2);
    assert.ok(calls[0].includes("--apply"));
    assert.ok(calls[1].includes("--dry-run"));

    for (const fault of ["pending", "hash", "empty", "escape"]) {
      const faultyRun = (command, args) => {
        const response = runCommand(command, args);
        if (args.includes("--dry-run")) {
          if (fault === "pending") response.stdout = JSON.stringify({ ok: true, results: [{ state: { targetDir: workspace, status: "ready", counts: { pending: 1 } } }] });
          if (fault === "hash") writeFileSync(path.join(workspace, relPath), "changed after bootstrap\n");
          if (fault === "empty" || fault === "escape") writeFileSync(path.join(workspace, ".meta-kim/state/default/project-bootstrap.json"), JSON.stringify({
            schemaVersion: "meta-kim-project-bootstrap-v0.1", managedFiles: fault === "empty" ? [] : [{ relPath: "../outside", contentHash: "a".repeat(64) }],
          }));
        }
        return response;
      };
      const rejected = await cleanRoom.initializeCleanRoomProject({ workspace, runtimeTarget: "codex", env: {}, timeoutMs: 1000, runCommand: faultyRun });
      assert.equal(rejected.projectionVerification.status, 1, fault);
    }
    let failedCalls = 0;
    const failed = await cleanRoom.initializeCleanRoomProject({ workspace, runtimeTarget: "codex", env: {}, timeoutMs: 1000,
      runCommand: () => { failedCalls++; return { status: 1, stdout: "", stderr: "unknown user file conflict" }; },
    });
    assert.equal(failedCalls, 1);
    assert.equal(failed.bootstrap.status, 1);
    assert.equal(failed.projectionVerification.status, null);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("dependency installer executes through a linked workspace entrypoint", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-installer-entry-"));
  try {
    const workspace = path.join(root, "workspace");
    symlinkSync(path.resolve(import.meta.dirname, "../.."), workspace, "junction");
    const result = spawnSync(process.execPath, [
      path.join(workspace, "scripts/install-global-skills-all-runtimes.mjs"),
      "--help",
    ], { cwd: workspace, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--targets/, "linked entry must execute CLI, not exit silently");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dependency installer runs a plain entry but stays dormant when imported", () => {
  const script = path.resolve(import.meta.dirname, "../../scripts/install-global-skills-all-runtimes.mjs");
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-installer-import-"));
  try {
    const plain = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8", timeout: 30_000 });
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /--targets/);
    const source = `await import(${JSON.stringify(pathToFileURL(script).href)}); console.log('import-only');`;
    const wrapper = path.join(root, "wrapper.mjs");
    writeFileSync(wrapper, source);
    for (const args of [
      [wrapper],
      ["--input-type=module", "-e", source],
      ["--input-type=module", "-"],
      ["--input-type=module", "-e", `process.argv[1] = ${JSON.stringify(path.join(root, "virtual-entry.mjs"))}; ${source}`],
    ]) {
      const imported = spawnSync(process.execPath, args, { input: source, encoding: "utf8", timeout: 30_000 });
      assert.equal(imported.status, 0, imported.stderr);
      assert.equal(imported.stdout.trim(), "import-only");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clean-room pins the cloned revision before checking skill presence and hash", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-dependency-pin-"));
  const git = (args, cwd = root) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    return r.stdout.trim();
  };
  try {
    const source = path.join(root, "source");
    git(["init", source]);
    const expectedBytes = "---\nname: fixture\ndescription: fixture\n---\nverified version\n";
    writeFileSync(path.join(source, "SKILL.md"), expectedBytes);
    git(["add", "."], source);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "verified"], source);
    const expectedCommit = git(["rev-parse", "HEAD"], source);
    git(["tag", "v-fixture"], source);
    const expectedSkillSha256 = createHash("sha256").update(readFileSync(path.join(source, "SKILL.md"))).digest("hex");
    for (const shape of ["missing", "changed"]) {
      if (shape === "missing") rmSync(path.join(source, "SKILL.md"));
      else writeFileSync(path.join(source, "SKILL.md"), "new incompatible version\n");
      writeFileSync(path.join(source, "README.md"), shape);
      git(["add", "-A"], source);
      git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", shape], source);
      const dependencyDir = path.join(root, shape);
      git(["clone", "--config", "core.autocrlf=false", "--depth", "1", pathToFileURL(source).href, dependencyDir]);
      const result = await cleanRoom.verifyInstalledDependency({
        dependencyDir, installExitCode: 0, env: process.env,
        expectedRef: "v-fixture", expectedCommit, expectedSkillSha256,
      });
      assert.equal(result.dependencyReady, true, JSON.stringify(result));
      assert.equal(result.dependencyCommit, expectedCommit);
      assert.equal(result.dependencySkillSha256, expectedSkillSha256);
      assert.equal(result.dependencyPin.action, "fetch_tag_and_detach");
    }
    const parentHead = git(["rev-parse", "HEAD"], source);
    const nested = path.join(source, "not-a-clone");
    mkdirSync(nested);
    writeFileSync(path.join(nested, "SKILL.md"), expectedBytes);
    const refused = await cleanRoom.verifyInstalledDependency({
      dependencyDir: nested, installExitCode: 0, env: process.env,
      expectedRef: "v-fixture", expectedCommit, expectedSkillSha256,
    });
    assert.equal(refused.dependencyReady, false);
    assert.equal(refused.dependencyCommit, null);
    assert.equal(refused.dependencyPin.action, "not_attempted");
    assert.equal(git(["rev-parse", "HEAD"], source), parentHead);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clean-room archive fallback still requires both revision metadata and exact skill bytes", async () => {
  const dependencyDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-dependency-archive-"));
  try {
    const skillPath = path.join(dependencyDir, "SKILL.md");
    writeFileSync(skillPath, "verified bytes\n");
    const expectedCommit = "a".repeat(40);
    const expectedSkillSha256 = createHash("sha256").update(readFileSync(skillPath)).digest("hex");
    const options = { dependencyDir, installExitCode: 0, env: process.env, expectedRef: "v-fixture", expectedCommit, expectedSkillSha256 };
    assert.equal((await cleanRoom.verifyInstalledDependency(options)).dependencyReady, false);
    writeFileSync(path.join(dependencyDir, ".meta-kim-source.json"), JSON.stringify({ source: "github_archive_fallback", rootName: "fixture-aaaaaaa" }));
    const verified = await cleanRoom.verifyInstalledDependency(options);
    assert.equal(verified.dependencyReady, true);
    assert.equal(verified.dependencyPin.action, "verified_archive_commit_prefix_and_skill_hash");
    assert.equal((await cleanRoom.verifyInstalledDependency({ ...options, installExitCode: 1 })).dependencyReady, false);
    writeFileSync(skillPath, "changed bytes\n");
    assert.equal((await cleanRoom.verifyInstalledDependency(options)).dependencyReady, false);
  } finally {
    rmSync(dependencyDir, { recursive: true, force: true });
  }
});

describe("clean-room dependency install silent no-op", () => {
  test("exit 0 with empty stdout and no skill is a named failure, not green", () => {
    const step = classifyDependencyInstallStep({
      exitCode: 0,
      stdout: "",
      skillPresent: false,
    });
    assert.equal(step.silentNoop, true);
    assert.equal(step.blocker, DEPENDENCY_INSTALL_SILENT_NOOP_BLOCKER);
    assert.equal(step.ackObserved, false);
    assert.match(step.diagnostic, /empty stdout/);

    // dependencyReady true is the shape that used to record a green install.
    const gate = resolveInstallGateOutcome({ ...readyGate, dependencyStep: step });
    assert.equal(gate.blocked, true);
    assert.equal(gate.blocker, DEPENDENCY_INSTALL_SILENT_NOOP_BLOCKER);
    assert.equal(gate.diagnostic, step.diagnostic);
  });

  test("the named failure does not fire for other install shapes", () => {
    // A real installer run always emits the acknowledgement line.
    const acknowledged = classifyDependencyInstallStep({
      exitCode: 0,
      stdout: `${installerAckLine({ targets: "codex", skills: ["agent-teams-playbook"] })}\n`,
      skillPresent: false,
    });
    assert.equal(acknowledged.outputEmpty, false);
    assert.equal(acknowledged.ackObserved, true);
    assert.equal(acknowledged.silentNoop, false);

    // Whitespace-only stdout is still no output.
    assert.equal(
      classifyDependencyInstallStep({ exitCode: 0, stdout: "\n \n", skillPresent: false }).silentNoop,
      true,
    );

    // Skill present means the step did its job even without output.
    assert.equal(
      classifyDependencyInstallStep({ exitCode: 0, stdout: "", skillPresent: true }).silentNoop,
      false,
    );

    // exitCode null means an earlier step short-circuited this one; it must keep
    // reporting as that earlier failure, not as a silent no-op.
    const shortCircuited = classifyDependencyInstallStep({
      exitCode: null,
      stdout: "",
      skillPresent: false,
    });
    assert.equal(shortCircuited.silentNoop, false);
    assert.equal(
      resolveInstallGateOutcome({
        ...readyGate,
        installExitCode: 1,
        dependencyReady: false,
        dependencyStep: shortCircuited,
      }).blocker,
      "clean_install_or_project_bootstrap_failed",
    );

    // A nonzero installer exit is an ordinary failure, not this diagnostic.
    assert.equal(
      classifyDependencyInstallStep({ exitCode: 1, stdout: "", skillPresent: false }).silentNoop,
      false,
    );

    // A fully healthy install still passes the gate.
    const healthy = classifyDependencyInstallStep({
      exitCode: 0,
      stdout: `${installerAckLine({})}\n`,
      skillPresent: true,
    });
    assert.equal(resolveInstallGateOutcome({ ...readyGate, dependencyStep: healthy }).blocked, false);
  });

  test("the silent no-op diagnostic is multi-line and names the retained sandbox tempRoot", () => {
    // Without a sandbox root the diagnostic must tell the operator to rerun
    // with --keep-temp and inspect the reported tempRoot.
    const bare = classifyDependencyInstallStep({
      exitCode: 0,
      stdout: "",
      skillPresent: false,
    });
    assert.ok(bare.diagnostic.includes("\n"), "the diagnostic must be multi-line");
    assert.match(bare.diagnostic, /silent noop/u);
    assert.match(bare.diagnostic, /--keep-temp/u);
    assert.doesNotMatch(bare.diagnostic, /meta-kim-clean-room-/u);

    // Once the harness knows the tempRoot it retains, the diagnostic must
    // point at that exact path instead of a generic rerun instruction.
    const tempRoot = path.join(os.tmpdir(), "meta-kim-clean-room-example");
    const located = classifyDependencyInstallStep({
      exitCode: 0,
      stdout: "",
      skillPresent: false,
      tempRoot,
    });
    assert.ok(located.diagnostic.includes("\n"));
    assert.match(located.diagnostic, new RegExp(tempRoot.replaceAll("\\", "\\\\")));
    assert.match(located.diagnostic, /silent noop/u);
    // The same diagnostic text flows into the gate so the blocked report and
    // stderr stay consistent with the report JSON field.
    const gate = resolveInstallGateOutcome({
      ...readyGate,
      dependencyStep: located,
    });
    assert.equal(gate.diagnostic, located.diagnostic);
  });

  test("keep-temp can be requested by flag or by META_KIM_CLEAN_ROOM_KEEP_TEMP=1", () => {
    // Default: nothing is retained.
    assert.deepEqual(
      resolveCleanRoomKeepTemp({ args: [], env: {} }),
      { keepTemp: false, reason: null },
    );
    // Only the exact value 1 counts as opt-in.
    assert.deepEqual(
      resolveCleanRoomKeepTemp({ args: [], env: { META_KIM_CLEAN_ROOM_KEEP_TEMP: "0" } }),
      { keepTemp: false, reason: null },
    );
    assert.deepEqual(
      resolveCleanRoomKeepTemp({ args: [], env: { META_KIM_CLEAN_ROOM_KEEP_TEMP: "true" } }),
      { keepTemp: false, reason: null },
    );
    // The env opt-in works on its own and with distinct attribution.
    assert.deepEqual(
      resolveCleanRoomKeepTemp({ args: [], env: { META_KIM_CLEAN_ROOM_KEEP_TEMP: "1" } }),
      { keepTemp: true, reason: "keep_temp_env" },
    );
    // The CLI flag wins and is attributed to the flag.
    assert.deepEqual(
      resolveCleanRoomKeepTemp({
        args: ["--keep-temp"],
        env: { META_KIM_CLEAN_ROOM_KEEP_TEMP: "1" },
      }),
      { keepTemp: true, reason: "keep_temp_flag" },
    );
  });
});
