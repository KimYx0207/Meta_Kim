import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises as fs,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  resolveClaudeLiveProviderEnvironmentSync,
  selectClaudeLiveProviderEnv,
} from "../../scripts/claude-live-provider-env.mjs";
import * as evalProcessRunner from "../../scripts/eval-process-runner.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const {
  isSafeWindowsLauncherFailureOperation,
  isSafeWindowsLauncherFailureReason,
} = evalProcessRunner;

function isolatedHomeEnvironment(homeDir, extra = {}) {
  const root = path.parse(homeDir).root;
  return {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    HOMEDRIVE: root.replace(/[\\/]$/u, ""),
    HOMEPATH: homeDir.slice(root.length - 1),
    CODEX_HOME: path.join(homeDir, ".codex"),
    NO_COLOR: "1",
    ...extra,
  };
}

describe("eval-meta-agents Claude smoke", () => {
  test("Claude live evaluation isolates unrelated user hooks and binds the installed runtime definition inline", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts", "eval-meta-agents.mjs"),
      "utf8",
    );
    assert.match(source, /resolveClaudeLiveAgentOverride/u);
    assert.match(
      source,
      /const inlineAgentsJson = JSON\.stringify\(runtimeAgentOverride\.agents\)[\s\S]*"--setting-sources"[\s\S]*""[\s\S]*"--agents"[\s\S]*inlineAgentsJson[\s\S]*"--agent"/u,
    );
    assert.match(source, /claude_main_session_inline_custom_agent_binding/u);
    assert.match(source, /customizationIsolation: "empty_setting_sources_cli_inline_agent"/u);
    assert.match(source, /commandDisplay: `claude --setting-sources <none>/u);
    assert.doesNotMatch(source, /"--safe-mode"[\s\S]*inlineAgentsJson/u);
    assert.match(source, /redactClaudeLiveCommandText\(value, sensitiveCommandValues\)/u);
    assert.match(source, /resolveClaudeLiveProviderEnvironment/u);
    assert.match(
      source,
      /providerEnvironmentSource:\s*"claude_global_settings_allowlist_then_process_fallback"/u,
    );
    assert.doesNotMatch(source, /nativeInvocationCommand: `claude -p --agent/u);
  });

  test("Claude failure reports preserve allowlisted cleanup evidence without leaking process inputs", async () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts", "eval-meta-agents.mjs"),
      "utf8",
    );
    const policySource = source.match(
      /const MAX_PUBLIC_SECONDARY_CLEANUP_FAILURES = 4;[\s\S]*?function publicProcessFailureEvidence\(error\) \{[\s\S]*?\n\}/u,
    )?.[0];
    assert.ok(policySource);
    const helperSource = policySource.match(
      /function publicProcessFailureEvidence\(error\) \{[\s\S]*?\n\}/u,
    )?.[0];
    assert.ok(helperSource);

    const projectEvidence = Function(
      "PROCESS_TREE_CLEANUP_CLAIM",
      "PROCESS_TREE_CLEANUP_BOUNDARY",
      "isSafeWindowsLauncherFailureOperation",
      "isSafeWindowsLauncherFailureReason",
      `"use strict"; ${policySource}; return publicProcessFailureEvidence;`,
    )(
      "not_claimed",
      "out_of_job_process_creation_not_covered",
      isSafeWindowsLauncherFailureOperation,
      isSafeWindowsLauncherFailureReason,
    );
    assert.equal(isSafeWindowsLauncherFailureOperation.add, undefined);
    assert.equal(isSafeWindowsLauncherFailureReason.add, undefined);
    assert.equal(
      Object.hasOwn(
        evalProcessRunner,
        "SAFE_WINDOWS_LAUNCHER_FAILURE_OPERATIONS",
      ),
      false,
    );
    assert.equal(
      Object.hasOwn(
        evalProcessRunner,
        "SAFE_WINDOWS_LAUNCHER_FAILURE_REASONS",
      ),
      false,
    );
    assert.equal(
      isSafeWindowsLauncherFailureOperation("CreateSecretToken"),
      false,
    );
    assert.equal(isSafeWindowsLauncherFailureReason("secret_token"), false);
    const failure = Object.assign(new Error("redacted public message"), {
      code: "META_KIM_WINDOWS_JOB_PROCESS_GROUP_DRAIN_FAILED",
      systemCode: "ENOENT",
      launcherFailureOperation: "CreateJobObjectW",
      launcherWin32Error: 5,
      timeoutMs: 150_000,
      exitCode: null,
      signal: "SIGKILL",
      outputLimitStreams: ["stdout", "stderr", "private-stream"],
      ownedProcessGroupCleanupVerified: false,
      ownedProcessGroupCleanupFailure: true,
      ownedProcessGroupCleanupReason:
        "launcher_force_stopped_after_cleanup_timeout",
      ownedProcessGroupSurvivorCount: 2,
      ownedProcessGroupScope: "windows_job_object_owned_process_group",
      processTreeCleanupClaim: "not_claimed",
      processTreeCleanupBoundary: "out_of_job_process_creation_not_covered",
      launcherStillAlive: false,
      launcherForcedStop: true,
      runnerControlDirectoryRetained: true,
      secondaryCleanupFailures: [
        {
          code: "META_KIM_RUNNER_CONTROL_DIRECTORY_CLEANUP_FAILED",
          reason: "runner_temp_cleanup_failed",
          path: "C:/secret/control-directory",
          detail: "SECONDARY_PRIVATE_DETAIL",
        },
        {
          code: "INVALID SECRET CODE",
          reason: "INVALID SECRET REASON",
        },
      ],
      processTreeCleanupVerified: true,
      command: "COMMAND_SECRET",
      prompt: "PROMPT_SECRET",
      agents: "AGENTS_JSON_SECRET",
      schema: "SCHEMA_SECRET",
      env: { ANTHROPIC_AUTH_TOKEN: "ENV_SECRET" },
      stdout: "STDOUT_SECRET",
      stderr: "STDERR_SECRET",
      stdoutMetadata: { digest: "STDOUT_DIGEST_SECRET" },
      stderrMetadata: { digest: "STDERR_DIGEST_SECRET" },
      cause: new Error("CAUSE_SECRET"),
      stack: "STACK_SECRET",
      controlDirectory: "C:/secret/control-directory",
      arbitrary: "ARBITRARY_SECRET",
    });

    assert.deepEqual(projectEvidence(failure), {
      code: "META_KIM_WINDOWS_JOB_PROCESS_GROUP_DRAIN_FAILED",
      systemCode: "ENOENT",
      launcherFailureOperation: "CreateJobObjectW",
      launcherWin32Error: 5,
      timeoutMs: 150_000,
      exitCode: null,
      outputLimitStreams: ["stdout", "stderr"],
      ownedProcessGroupCleanupVerified: false,
      ownedProcessGroupCleanupFailure: true,
      launcherStillAlive: false,
      launcherForcedStop: true,
      runnerControlDirectoryRetained: true,
      ownedProcessGroupCleanupReason:
        "launcher_force_stopped_after_cleanup_timeout",
      ownedProcessGroupSurvivorCount: 2,
      ownedProcessGroupScope: "windows_job_object_owned_process_group",
      processTreeCleanupClaim: "not_claimed",
      processTreeCleanupBoundary: "out_of_job_process_creation_not_covered",
      secondaryCleanupFailures: [
        {
          code: "META_KIM_RUNNER_CONTROL_DIRECTORY_CLEANUP_FAILED",
          reason: "runner_temp_cleanup_failed",
        },
      ],
    });

    assert.deepEqual(
      projectEvidence({
        code: "META_KIM_SECRET_TOKEN",
        systemCode: "ESECRET",
        ownedProcessGroupCleanupReason: "secret_token",
        launcherFailureOperation: "CreateSecretToken",
        launcherWin32Error: -1,
        secondaryCleanupFailures: [
          {
            code: "META_KIM_SECRET_TOKEN",
            reason: "secret_token",
          },
        ],
      }),
      {
        ownedProcessGroupCleanupVerified: false,
        ownedProcessGroupCleanupFailure: true,
        ownedProcessGroupCleanupReason: "cleanup_evidence_inconsistent",
      },
    );
    assert.deepEqual(
      projectEvidence({
        ownedProcessGroupCleanupVerified: true,
        ownedProcessGroupCleanupFailure: false,
        ownedProcessGroupCleanupReason: null,
        ownedProcessGroupSurvivorCount: 0,
        ownedProcessGroupScope: "windows_job_object_owned_process_group",
        launcherStillAlive: false,
      }),
      {
        ownedProcessGroupCleanupVerified: true,
        ownedProcessGroupCleanupFailure: false,
        ownedProcessGroupCleanupReason: null,
        ownedProcessGroupSurvivorCount: 0,
        ownedProcessGroupScope: "windows_job_object_owned_process_group",
        launcherStillAlive: false,
      },
    );
    assert.deepEqual(
      projectEvidence({
        ownedProcessGroupCleanupVerified: true,
        ownedProcessGroupCleanupFailure: false,
        ownedProcessGroupCleanupReason: null,
        ownedProcessGroupSurvivorCount: null,
        ownedProcessGroupScope: "windows_job_object_owned_process_group",
        launcherStillAlive: false,
        runnerControlDirectoryRetained: true,
        secondaryCleanupFailures: [
          {
            code: "META_KIM_RUNNER_CONTROL_DIRECTORY_CLEANUP_FAILED",
            reason: "runner_temp_cleanup_failed",
          },
        ],
      }),
      {
        ownedProcessGroupCleanupVerified: true,
        ownedProcessGroupCleanupFailure: false,
        ownedProcessGroupCleanupReason: null,
        ownedProcessGroupSurvivorCount: null,
        ownedProcessGroupScope: "windows_job_object_owned_process_group",
        runnerControlDirectoryRetained: true,
        launcherStillAlive: false,
        secondaryCleanupFailures: [
          {
            code: "META_KIM_RUNNER_CONTROL_DIRECTORY_CLEANUP_FAILED",
            reason: "runner_temp_cleanup_failed",
          },
        ],
      },
    );
    assert.deepEqual(
      projectEvidence({
        ownedProcessGroupCleanupVerified: true,
        ownedProcessGroupCleanupFailure: false,
        ownedProcessGroupCleanupReason: null,
        ownedProcessGroupSurvivorCount: 0,
        ownedProcessGroupScope: "posix_detached_process_group",
      }),
      {
        ownedProcessGroupCleanupVerified: true,
        ownedProcessGroupCleanupFailure: false,
        ownedProcessGroupCleanupReason: null,
        ownedProcessGroupSurvivorCount: 0,
        ownedProcessGroupScope: "posix_detached_process_group",
      },
    );
    assert.deepEqual(
      projectEvidence({
        code: "META_KIM_WINDOWS_PROCESS_RUNNER_RESULT_UNVERIFIED",
        launcherFailureOperation: "CreateJobObjectW",
        launcherWin32Error: 5,
        ownedProcessGroupCleanupVerified: false,
        ownedProcessGroupCleanupFailure: true,
        ownedProcessGroupCleanupReason: "create_job_failed",
        ownedProcessGroupSurvivorCount: null,
        ownedProcessGroupScope: "windows_job_object_owned_process_group",
      }),
      {
        code: "META_KIM_WINDOWS_PROCESS_RUNNER_RESULT_UNVERIFIED",
        launcherFailureOperation: "CreateJobObjectW",
        launcherWin32Error: 5,
        ownedProcessGroupCleanupVerified: false,
        ownedProcessGroupCleanupFailure: true,
        ownedProcessGroupCleanupReason: "create_job_failed",
        ownedProcessGroupSurvivorCount: null,
        ownedProcessGroupScope: "windows_job_object_owned_process_group",
      },
    );
    assert.deepEqual(
      projectEvidence({
        ownedProcessGroupCleanupVerified: true,
        ownedProcessGroupCleanupFailure: true,
        ownedProcessGroupCleanupReason: "launcher_exit_unverified",
        ownedProcessGroupSurvivorCount: 0x1_0000_0000,
        ownedProcessGroupScope: "windows_job_object_owned_process_group",
        launcherStillAlive: true,
      }),
      {
        ownedProcessGroupCleanupVerified: false,
        ownedProcessGroupCleanupFailure: true,
        ownedProcessGroupCleanupReason: "cleanup_evidence_inconsistent",
      },
    );
    assert.deepEqual(
      projectEvidence({
        launcherFailureOperation: "CreateJobObjectW;COMMAND_SECRET",
        launcherWin32Error: 0x1_0000_0000,
        exitCode: -1,
      }),
      {},
    );
    assert.deepEqual(projectEvidence({ exitCode: 0x1_0000_0000 }), {});
    assert.deepEqual(
      projectEvidence({
        launcherFailureOperation: "compile_native_bridge",
        launcherWin32Error: 0xffff_ffff,
      }),
      {
        launcherFailureOperation: "compile_native_bridge",
        launcherWin32Error: 0xffff_ffff,
      },
    );

    const boundedArrays = projectEvidence({
      outputLimitStreams: Array.from(
        { length: 64 },
        (_, index) => (index % 2 === 0 ? "stdout" : "stderr"),
      ),
      secondaryCleanupFailures: Array.from({ length: 32 }, () => ({
        code: "META_KIM_RUNNER_CONTROL_DIRECTORY_CLEANUP_FAILED",
        reason: "runner_temp_cleanup_failed",
      })),
    });
    assert.deepEqual(boundedArrays.outputLimitStreams, ["stdout", "stderr"]);
    assert.equal(boundedArrays.secondaryCleanupFailures.length, 4);
    assert.deepEqual(boundedArrays.secondaryCleanupFailures[0], {
      code: "META_KIM_RUNNER_CONTROL_DIRECTORY_CLEANUP_FAILED",
      reason: "runner_temp_cleanup_failed",
    });
    assert.deepEqual(
      projectEvidence({
        outputLimitStreams: [
          ...Array.from({ length: 8 }, () => "PRIVATE_STREAM"),
          "stdout",
        ],
        secondaryCleanupFailures: [
          ...Array.from({ length: 4 }, () => ({
            code: "META_KIM_SECRET_TOKEN",
            reason: "secret_token",
          })),
          {
            code: "META_KIM_RUNNER_CONTROL_DIRECTORY_CLEANUP_FAILED",
            reason: "runner_temp_cleanup_failed",
          },
        ],
      }),
      {},
    );
    assert.equal(Object.hasOwn(projectEvidence(failure), "signal"), false);

    if (process.platform === "win32") {
      let runnerError = null;
      try {
        await evalProcessRunner.runWindowsGuardedCommand(
          process.execPath,
          ["-e", "process.exit(23)"],
          { cwd: repoRoot, timeout: 30_000 },
        );
      } catch (error) {
        runnerError = error;
      }
      assert.ok(runnerError);
      const actualRunnerEvidence = projectEvidence(runnerError);
      assert.equal(actualRunnerEvidence.exitCode, 23);
      assert.equal(actualRunnerEvidence.ownedProcessGroupCleanupVerified, true);
      assert.equal(actualRunnerEvidence.ownedProcessGroupCleanupFailure, false);
      assert.equal(actualRunnerEvidence.ownedProcessGroupCleanupReason, null);
      assert.equal(actualRunnerEvidence.ownedProcessGroupSurvivorCount, null);
      assert.equal(
        actualRunnerEvidence.ownedProcessGroupScope,
        "windows_job_object_owned_process_group",
      );
      assert.equal(actualRunnerEvidence.launcherStillAlive, false);
    }

    let retainedGuardDir = null;
    const fakeLauncher = new EventEmitter();
    fakeLauncher.pid = 424_242;
    fakeLauncher.exitCode = null;
    fakeLauncher.signalCode = null;
    fakeLauncher.stdin = new PassThrough();
    fakeLauncher.stdout = new PassThrough();
    fakeLauncher.stderr = new PassThrough();
    const retainedDirectoryRunner =
      evalProcessRunner.createWindowsGuardedCommandRunner({
        launcherPath: "fixture-launcher.ps1",
        spawn: (_file, args) => {
          const resultPath = args[args.indexOf("-ResultPath") + 1];
          void fs
            .writeFile(
              resultPath,
              JSON.stringify({
                schemaVersion: "meta-kim-windows-job-process-runner-v1",
                verified: true,
                reason: "process_exited_job_drained",
                childExitCode: 0,
                activeProcesses: 0,
                stopRequested: false,
                failureOperation: null,
                win32Error: null,
              }),
              "utf8",
            )
            .then(() => {
              fakeLauncher.exitCode = 0;
              fakeLauncher.stdin.destroy();
              fakeLauncher.stdout.end();
              fakeLauncher.stderr.end();
              fakeLauncher.emit("close", 0, null);
            });
          return fakeLauncher;
        },
        fs: {
          async mkdtemp(prefix) {
            retainedGuardDir = await fs.mkdtemp(prefix);
            return retainedGuardDir;
          },
          writeFile: (...args) => fs.writeFile(...args),
          readFile: (...args) => fs.readFile(...args),
          async rm() {
            throw new Error("fixture control-directory cleanup denied");
          },
        },
      });
    try {
      let retainedDirectoryError = null;
      try {
        await retainedDirectoryRunner("fixture.exe", []);
      } catch (error) {
        retainedDirectoryError = error;
      }
      assert.ok(retainedDirectoryError);
      const retainedDirectoryEvidence = projectEvidence(retainedDirectoryError);
      assert.equal(
        retainedDirectoryEvidence.code,
        "META_KIM_RUNNER_CONTROL_DIRECTORY_CLEANUP_FAILED",
      );
      assert.equal(
        retainedDirectoryEvidence.ownedProcessGroupCleanupVerified,
        true,
      );
      assert.equal(
        retainedDirectoryEvidence.ownedProcessGroupCleanupFailure,
        false,
      );
      assert.equal(retainedDirectoryEvidence.ownedProcessGroupCleanupReason, null);
      assert.equal(retainedDirectoryEvidence.ownedProcessGroupSurvivorCount, null);
      assert.equal(retainedDirectoryEvidence.launcherStillAlive, false);
      assert.equal(retainedDirectoryEvidence.runnerControlDirectoryRetained, true);
    } finally {
      if (retainedGuardDir) {
        await fs.rm(retainedGuardDir, { recursive: true, force: true });
      }
    }

    const serialized = JSON.stringify(projectEvidence(failure));
    for (const secret of [
      "COMMAND_SECRET",
      "PROMPT_SECRET",
      "AGENTS_JSON_SECRET",
      "SCHEMA_SECRET",
      "ENV_SECRET",
      "STDOUT_SECRET",
      "STDERR_SECRET",
      "DIGEST_SECRET",
      "CAUSE_SECRET",
      "STACK_SECRET",
      "control-directory",
      "PRIVATE_DETAIL",
      "ARBITRARY_SECRET",
      "META_KIM_SECRET_TOKEN",
      "ESECRET",
      "secret_token",
      "CreateSecretToken",
      "processTreeCleanupVerified",
    ]) {
      assert.doesNotMatch(serialized, new RegExp(secret, "u"));
    }

    const claudeCases = source.match(
      /async function runClaudeCases\(agentIds\) \{[\s\S]*?\n\}/u,
    )?.[0];
    assert.ok(claudeCases);
    assert.equal(
      claudeCases.match(/\.\.\.publicProcessFailureEvidence\(error\)/gu)?.length,
      2,
    );
    const claudeReportCatch = source.match(
      /report\.claude = isOptionalRuntimeUnavailable\(error\.message\)[\s\S]*?\n\s*\};/u,
    )?.[0];
    assert.ok(claudeReportCatch);
    assert.equal(
      claudeReportCatch.match(/\.\.\.publicProcessFailureEvidence\(error\)/gu)
        ?.length,
      2,
    );
    assert.doesNotMatch(helperSource, /\.\.\.error\b/u);
    assert.doesNotMatch(helperSource, /processTreeCleanupVerified/u);
  });

  test("Claude controlled provider resolver discards ambient routes before applying the MiniMax allowlist", () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "meta-kim-claude-provider-env-"));
    try {
      const settingsDir = path.join(tempHome, ".claude");
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(
        path.join(settingsDir, "settings.json"),
        JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: "https://minimax.fixture.invalid/anthropic",
            ANTHROPIC_AUTH_TOKEN: "fixture-minimax-token",
            ANTHROPIC_MODEL: "MiniMax-M3",
            ANTHROPIC_DEFAULT_SONNET_MODEL: "MiniMax-M3",
            API_TIMEOUT_MS: "1200000",
            NODE_OPTIONS: "--require=untrusted-settings-entry",
            AWS_PROFILE: "settings-cloud-profile-must-not-enter",
            GOOGLE_APPLICATION_CREDENTIALS: "settings-google-credentials-must-not-enter",
            UNRELATED_SETTINGS_VALUE: "settings-unrelated-must-not-enter",
          },
        }),
      );

      const preservedSystemEnv = {
        PATH: "fixture-path",
        TEMP: "fixture-temp",
        HTTPS_PROXY: "http://proxy.fixture.invalid",
        NO_PROXY: "localhost,.fixture.invalid",
        NODE_EXTRA_CA_CERTS: "fixture-extra-ca.pem",
        SSL_CERT_FILE: "fixture-cert.pem",
        REQUESTS_CA_BUNDLE: "fixture-ca-bundle.pem",
      };
      const resolved = resolveClaudeLiveProviderEnvironmentSync({
        homeDir: tempHome,
        ambientEnv: {
          ...preservedSystemEnv,
          HOME: "ambient-home-must-not-be-used",
          ANTHROPIC_API_KEY: "ambient-api-key",
          ANTHROPIC_AUTH_TOKEN: "ambient-glm-token",
          ANTHROPIC_BASE_URL: "https://glm.fixture.invalid/anthropic",
          ANTHROPIC_MODEL: "GLM-5",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "GLM-5-Air",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "GLM-5",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "GLM-5",
          API_TIMEOUT_MS: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0",
          CLAUDE_CODE_EFFORT_LEVEL: "low",
          NODE_OPTIONS: "--require=ambient-route",
        },
      });

      assert.equal(
        resolved.ANTHROPIC_BASE_URL,
        "https://minimax.fixture.invalid/anthropic",
      );
      assert.equal(resolved.ANTHROPIC_AUTH_TOKEN, "fixture-minimax-token");
      assert.equal(resolved.ANTHROPIC_MODEL, "MiniMax-M3");
      assert.equal(resolved.ANTHROPIC_DEFAULT_SONNET_MODEL, "MiniMax-M3");
      assert.equal(resolved.API_TIMEOUT_MS, "1200000");
      for (const [key, value] of Object.entries(preservedSystemEnv)) {
        assert.equal(resolved[key], value, `${key} is required by the child process`);
      }
      assert.equal(resolved.HOME, "ambient-home-must-not-be-used");
      assert.equal(resolved.NO_COLOR, "1");
      assert.equal(resolved.NODE_OPTIONS, undefined);
      assert.equal(resolved.AWS_PROFILE, undefined);
      assert.equal(resolved.GOOGLE_APPLICATION_CREDENTIALS, undefined);
      assert.equal(resolved.UNRELATED_SETTINGS_VALUE, undefined);
      for (const key of [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
        "CLAUDE_CODE_EFFORT_LEVEL",
      ]) {
        assert.equal(resolved[key], undefined, `${key} must not leak from the ambient environment`);
      }
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("Claude controlled provider reads and forwards the exact CLAUDE_CONFIG_DIR root", () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "meta-kim-claude-config-root-"));
    const defaultConfigDir = path.join(tempHome, ".claude");
    const declaredConfigDir = path.join(tempHome, "declared-claude-config");
    try {
      mkdirSync(defaultConfigDir, { recursive: true });
      mkdirSync(declaredConfigDir, { recursive: true });
      writeFileSync(path.join(defaultConfigDir, "settings.json"), JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://wrong-default.fixture.invalid/anthropic",
          ANTHROPIC_AUTH_TOKEN: "wrong-default-token",
        },
      }), "utf8");
      writeFileSync(path.join(declaredConfigDir, "settings.json"), JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://minimax-config-root.fixture.invalid/anthropic",
          ANTHROPIC_AUTH_TOKEN: "fixture-config-root-token",
        },
      }), "utf8");

      const resolved = resolveClaudeLiveProviderEnvironmentSync({
        homeDir: tempHome,
        ambientEnv: {
          PATH: "fixture-path",
          Claude_Config_Dir: declaredConfigDir,
        },
      });

      assert.equal(resolved.CLAUDE_CONFIG_DIR, declaredConfigDir);
      assert.equal(resolved.ANTHROPIC_BASE_URL, "https://minimax-config-root.fixture.invalid/anthropic");
      assert.equal(resolved.ANTHROPIC_AUTH_TOKEN, "fixture-config-root-token");
      assert.equal(resolved.ANTHROPIC_MODEL, undefined, "endpoint plus auth is sufficient without a model override");
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("Claude controlled provider resolver fails closed when global allowlist settings are unavailable", () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "meta-kim-claude-provider-env-invalid-"));
    const settingsDir = path.join(tempHome, ".claude");
    const settingsPath = path.join(settingsDir, "settings.json");
    const resolve = () => resolveClaudeLiveProviderEnvironmentSync({
      homeDir: tempHome,
      ambientEnv: { PATH: "fixture-path", ANTHROPIC_MODEL: "ambient-GLM" },
    });
    try {
      assert.throws(resolve, /missing or malformed/u, "missing settings must not inherit an ambient provider");
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(settingsPath, "{not-json", "utf8");
      assert.throws(resolve, /missing or malformed/u, "malformed settings must not inherit an ambient provider");
      writeFileSync(settingsPath, JSON.stringify({ env: { NODE_OPTIONS: "--inspect", UNRELATED: "value" } }), "utf8");
      assert.throws(resolve, /missing or malformed/u, "settings without an allowlisted provider must fail closed");
      for (const [label, env] of [
        ["timeout only", { API_TIMEOUT_MS: "1200000" }],
        ["effort only", { CLAUDE_CODE_EFFORT_LEVEL: "high" }],
        ["model only", { ANTHROPIC_MODEL: "MiniMax-M3" }],
      ]) {
        writeFileSync(settingsPath, JSON.stringify({ env }), "utf8");
        assert.throws(resolve, /missing|malformed|provider|credential|endpoint|auth/u, `${label} must not authorize a provider`);
      }
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("Claude controlled provider removes cloud credentials and mixed-case poison keys deterministically", () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "meta-kim-claude-provider-pollution-"));
    const settingsDir = path.join(tempHome, ".claude");
    const poisonedKeys = [
      "CLAUDE_CODE_USE_BEDROCK",
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_SECURITY_TOKEN",
      "AWS_PROFILE",
      "AWS_REGION",
      "AWS_DEFAULT_REGION",
      "AWS_ROLE_ARN",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
      "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
      "AWS_CONTAINER_CREDENTIALS_FULL_URI",
      "CLAUDE_CODE_USE_VERTEX",
      "ANTHROPIC_VERTEX_PROJECT_ID",
      "CLOUD_ML_REGION",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GOOGLE_CLOUD_PROJECT",
      "GOOGLE_CLOUD_QUOTA_PROJECT",
      "GOOGLE_CLOUD_LOCATION",
      "GCLOUD_PROJECT",
      "NoDe_OpTiOnS",
      "aNtHrOpIc_BaSe_Url",
      "AnThRoPiC_ApI_kEy",
      "cLaUdE_cOdE_uSe_BeDrOcK",
      "gOoGlE_aPpLiCaTiOn_CrEdEnTiAlS",
    ];
    try {
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://minimax-pollution.fixture.invalid/anthropic",
          ANTHROPIC_AUTH_TOKEN: "fixture-pollution-token",
        },
      }), "utf8");
      const resolved = resolveClaudeLiveProviderEnvironmentSync({
        homeDir: tempHome,
        ambientEnv: {
          PATH: "fixture-path",
          TEMP: "fixture-temp",
          ...Object.fromEntries(poisonedKeys.map((key) => [key, `poison-${key}`])),
        },
      });

      assert.equal(resolved.ANTHROPIC_BASE_URL, "https://minimax-pollution.fixture.invalid/anthropic");
      assert.equal(resolved.ANTHROPIC_AUTH_TOKEN, "fixture-pollution-token");
      assert.equal(resolved.PATH, "fixture-path");
      assert.equal(resolved.TEMP, "fixture-temp");
      for (const key of poisonedKeys) {
        assert.equal(Object.hasOwn(resolved, key), false, `${key} must not reach the controlled child environment`);
      }
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("Claude provider environment selector accepts only the live-provider allowlist", () => {
    assert.deepEqual(
      selectClaudeLiveProviderEnv({
        env: {
          ANTHROPIC_MODEL: "MiniMax-M3",
          API_TIMEOUT_MS: "1200000",
          EMPTY_VALUE: "",
          NODE_OPTIONS: "--inspect",
        },
      }),
      {
        ANTHROPIC_MODEL: "MiniMax-M3",
        API_TIMEOUT_MS: "1200000",
      },
    );
  });

  test("Windows CLI search includes npm-style ~/.local shims before native bin", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts", "eval-meta-agents.mjs"),
      "utf8",
    );
    const searchDirs = source.match(
      /function getWindowsCliSearchDirs\(\) \{[\s\S]*?\n\}/,
    )?.[0];

    assert.ok(searchDirs);
    assert.ok(
      searchDirs.indexOf('path.join(up, ".local")') <
        searchDirs.indexOf('path.join(up, ".local", "bin")'),
    );
  });

  test("Claude discovery reads declared runtime definitions and treats `claude agents` as diagnostic only", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts", "eval-meta-agents.mjs"),
      "utf8",
    );
    const discovery = source.match(
      /async function runClaudeDiscovery\(agentIds\) \{[\s\S]*?\n\}/,
    )?.[0];

    assert.ok(discovery);
    assert.match(discovery, /readRuntimeAgentDefinitions/);
    assert.match(discovery, /\.claude", "agents"/);
    assert.match(discovery, /source: discoveredAgents\.source/);
    assert.match(discovery, /expectedInventorySource: "canonical\/agents"/);
    assert.match(discovery, /discoveryKind: "declared_runtime_agent_definitions"/);
    assert.match(discovery, /diagnosticOnlyCommand: "claude agents"/);
    assert.doesNotMatch(discovery, /readRuntimeAgentIdsOrCanonical/);
  });

  test("canonical inventory never substitutes for missing Claude or Codex runtime definitions", () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "meta-kim-empty-runtime-home-"));
    try {
      for (const runtime of ["claude", "codex"]) {
        const projectDefinitionPath = path.join(
          repoRoot,
          runtime === "claude" ? ".claude" : ".codex",
          "agents",
          runtime === "claude" ? "meta-prism.md" : "meta-prism.toml",
        );
        const hasProjectDefinition = existsSync(projectDefinitionPath);
        const result = spawnSync(
          process.execPath,
          ["scripts/eval-meta-agents.mjs", `--runtime=${runtime}`, "--agent=meta-prism"],
          {
            cwd: repoRoot,
            env: isolatedHomeEnvironment(tempHome),
            encoding: "utf8",
            timeout: 30_000,
          },
        );
        assert.equal(
          result.status,
          hasProjectDefinition ? 0 : 1,
          `${runtime}: ${result.stderr || result.stdout}`,
        );
        const report = JSON.parse(result.stdout);
        const runtimeReport = report[runtime];
        assert.equal(
          runtimeReport.status,
          hasProjectDefinition ? "passed" : "failed",
        );
        const discovery = runtime === "claude" ? runtimeReport.discovery : runtimeReport.sample;
        const ids = runtime === "claude" ? discovery.ids : discovery.custom_agents;
        assert.deepEqual(ids, hasProjectDefinition ? ["meta-prism"] : []);
        assert.equal(
          runtime === "claude" ? discovery.expectedInventorySource : discovery.expected_inventory_source,
          "canonical/agents",
        );
        assert.doesNotMatch(JSON.stringify(discovery), /canonical-agent-fallback/u);
      }
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("Codex runtime identity comes from declared name and public evidence hides the absolute user home", () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "meta-kim-declared-agent-home-"));
    try {
      const agentsDir = path.join(tempHome, ".codex", "agents");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        path.join(agentsDir, "misleading-filename.toml"),
        [
          'name = "meta-prism"',
          'description = "fixture"',
          'developer_instructions = "fixture"',
          "",
        ].join("\n"),
      );
      const result = spawnSync(
        process.execPath,
        ["scripts/eval-meta-agents.mjs", "--runtime=codex", "--agent=meta-prism"],
        {
          cwd: repoRoot,
          env: isolatedHomeEnvironment(tempHome),
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const report = JSON.parse(result.stdout);
      assert.deepEqual(report.codex.sample.custom_agents, ["meta-prism"]);
      assert.equal(report.codex.sample.custom_agent_definitions[0].name, "meta-prism");
      assert.doesNotMatch(result.stdout, new RegExp(tempHome.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&"), "iu"));
      assert.doesNotMatch(result.stdout, /misleading-filename\.toml/u);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("OpenClaw smoke can structurally validate without local auth secrets", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts", "eval-meta-agents.mjs"),
      "utf8",
    );

    assert.match(source, /function isMissingOpenClawAuthError/);
    assert.match(source, /async function runOpenClawStructuralSmoke/);
    assert.match(source, /openclaw_auth_not_configured/);
    assert.match(source, /source: "structural-template"/);
  });

  test("OpenClaw local prepare can hydrate from an existing meta agent when main auth is absent", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts", "prepare-openclaw-local.mjs"),
      "utf8",
    );

    assert.match(source, /agentAuthDirLooksUsable/);
    assert.match(source, /fallback:\$\{fallbackAgentId\.agentId\}/);
    assert.match(source, /Hydrated missing OpenClaw auth files/);
    assert.match(source, /fileLooksUsable\(targetPath\)/);
    assert.match(source, /currentAuthStoreLooksUsable/);
    assert.match(source, /sqlite_runtime_managed/);
    assert.match(source, /without copying credential databases/);
  });

  test("live evaluation can be sharded by canonical agent id", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts", "eval-meta-agents.mjs"),
      "utf8",
    );

    assert.match(source, /const agentArg = rawArgs\.find/);
    assert.match(source, /const selectedAgentIds = new Set/);
    assert.match(source, /function filterSelectedAgentIds/);
    assert.match(source, /requestedAgents/);
    assert.match(source, /Unknown agent filter/);
    assert.match(source, /Claude live case \$\{agentId\} attempt \$\{attempt\}\/2 scored/);
    assert.match(source, /attempts: attempt/);
  });

  test("Claude live eval grounds role answers in loaded agent boundaries", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts", "eval-meta-agents.mjs"),
      "utf8",
    );

    assert.match(source, /const scoutInstruction =/);
    assert.match(source, /通过 --agents 显式绑定的已安装 Claude Code agent 定义/);
    assert.match(source, /description、own、do_not_touch、boundary/);
    assert.match(source, /不要凭通用 agent 印象补写/);
    assert.match(source, /tool-skill-MCP\/ROI/);
    assert.match(source, /不直接执行工具或运行时动作/);
    assert.match(source, /协调\/dispatch\/loadout\/final approval/);
  });
  test("OpenClaw evaluation prefers the main config MiniMax M3 model", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts", "eval-meta-agents.mjs"),
      "utf8",
    );

    assert.match(source, /function defaultOpenClawEvalModel/);
    assert.match(source, /META_KIM_OPENCLAW_EVAL_MODEL/);
    assert.match(source, /const mainConfigModel = openClawMainDefaultModel\(\)/);
    assert.match(source, /function readOpenClawMainConfig/);
    assert.match(source, /function openClawMainDefaultModel/);
    assert.match(source, /function ensureOpenClawModelRefInProviders/);
    assert.match(source, /const evalModels = ensureOpenClawModelRefInProviders/);
    assert.match(source, /\.\.\.\(mainConfig\.auth \?\? \{\}\)/);
    assert.match(source, /\.\.\.evalModels/);
    assert.match(source, /openclawMainConfigPath/);
    assert.match(source, /"MiniMax-M3"/);
    assert.match(source, /function openClawLocalAuthProfileHasProvider/);
    assert.match(source, /function openClawLocalModelRefForProvider/);
    assert.match(source, /function hasCodexCliAuth/);
    assert.match(source, /codex-cli\/gpt-5\.4/);
    assert.match(source, /"gpt-5\.4-mini"/);
    assert.match(source, /preferredModelIds/);
    assert.match(
      source,
      /codexModel && openClawLocalAuthProfileHasProvider\("codex"\)/,
    );
    assert.match(source, /"models\.json"/);
    assert.match(source, /useMainConfig: true/);
    assert.match(source, /configSource: "main"/);
    assert.match(source, /configSource: baseStatus\.tempConfig\.configSource/);
    assert.match(source, /codexHomeDir/);
    assert.match(source, /function shouldUseIsolatedCodexHome/);
    assert.match(source, /normalized\.startsWith\("codex-cli\/"\)/);
    assert.match(source, /\? \{ CODEX_HOME: tempConfig\.codexHomeDir \}/);
    assert.match(source, /OPENAI_API_KEY/);
    assert.match(source, /openai-codex\/gpt-5\.4/);
    assert.match(source, /function applyOpenClawEvalDefaults/);
    assert.match(source, /typeof existingDefaults\.model === "string"/);
    assert.match(source, /model: agent\.model \?\? evalModel/);
    assert.match(source, /bootstrapMaxChars: existingDefaults\.bootstrapMaxChars \?\? 1_200/);
    assert.match(source, /bootstrapTotalMaxChars: existingDefaults\.bootstrapTotalMaxChars \?\? 4_000/);
    assert.match(source, /profile: agent\.tools\?\.profile \?\? "minimal"/);
    assert.match(source, /memoryGetMaxChars/);
    assert.match(source, /startupContext/);
    assert.match(source, /enabled: false/);
    assert.match(source, /skills: agent\.skills \?\? \["meta-theory"\]/);
    assert.match(source, /evalModel: config\.agents\.defaults\.model\.primary/);
    assert.match(source, /sessionRootDir/);
    assert.match(source, /store: path\.join\(sessionRootDir, "\{agentId\}", "sessions\.json"\)/);
    assert.match(source, /stateDir/);
    assert.match(source, /homeDir/);
    assert.match(source, /OPENCLAW_STATE_DIR: tempConfig\.stateDir/);
    assert.match(source, /OPENCLAW_HOME: tempConfig\.homeDir/);
    assert.match(source, /hydrateOpenClawEvalAuthState/);
    assert.match(source, /maxRetries: 5/);
    assert.match(source, /OpenClaw eval temp cleanup left locked files/);
    assert.match(source, /shellEnv/);
    assert.match(source, /timeoutMs: 0/);
    assert.match(source, /allow: \["minimax", "openai"\]/);
    assert.doesNotMatch(source, /entries:\s*\{[\s\S]*"openai-codex": \{/);
    assert.match(source, /load: \{\s*paths: \[\]/);
    assert.match(source, /memory: "none"/);
    assert.match(source, /allowBundled: \[\]/);
    assert.match(source, /extraDirs: \[skillsRootDir\]/);
    assert.match(source, /watch: false/);
    assert.match(source, /maxSkillsLoadedPerSource: 8/);
    assert.match(source, /tool execution/);
    assert.match(source, /工具操作/);
    assert.match(source, /质量审计/);
    assert.match(source, /质量门禁/);
    assert.match(source, /质量门槛/);
    assert.match(source, /prompt 架构/);
    assert.match(source, /接入外部工具/);
    assert.match(source, /业务代码/);
    assert.match(source, /内部逻辑/);
    assert.match(source, /AI_slop/);
    assert.match(source, /发现报告/);
    assert.match(source, /协调管理/);
    assert.match(source, /synthesis/);
    assert.match(source, /边界守门/);
    assert.match(source, /SOUL\/AGENTS/);
  });

  test("OpenClaw child commands receive a stable current-user home", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts", "eval-meta-agents.mjs"),
      "utf8",
    );

    assert.match(source, /function openClawChildEnv/);
    assert.match(source, /HOME: homeDir/);
    assert.match(source, /USERPROFILE: homeDir/);
    assert.match(source, /HOMEDRIVE: drive/);
    assert.match(source, /HOMEPATH: homePath/);
    assert.match(source, /env: openClawChildEnv/);
  });

  test("OpenClaw live eval recovers completed replies from session jsonl when the CLI hangs", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts", "eval-meta-agents.mjs"),
      "utf8",
    );

    assert.match(source, /async function readOpenClawSessionPayload/);
    assert.ok(source.includes('entry.name.endsWith(".jsonl")'));
    assert.match(source, /sessionDirs = \[\]/);
    assert.match(source, /options\.sessionDirs \?\? \[\]/);
    assert.match(source, /baseStatus\.tempConfig\.sessionRootDir/);
    assert.match(source, /currentSessionId === sessionId/);
    assert.match(source, /event\.data\?\.runId === sessionId/);
    assert.match(source, /recentEvents/);
    assert.match(source, /eventMs >= sinceMs - 1_000/);
    assert.match(source, /const startedAtMs = Date\.now\(\)/);
    assert.match(source, /function isOpenClawBoundaryPayload/);
    assert.match(source, /typeof payload\.agent === "string"/);
    assert.match(source, /Array\.isArray\(payload\.owns\)/);
    assert.match(source, /Array\.isArray\(payload\.refuses\)/);
    assert.match(source, /typeof payload\.artifact === "string"/);
    assert.match(source, /Array\.isArray\(payload\.delegates_to\)/);
    assert.match(source, /function extractOpenClawPayloadFromSessionEvents/);
    assert.match(source, /parseJsonObjectFromText\(item\.text\)/);
    assert.match(source, /isOpenClawBoundaryPayload\(payloadObject\)/);
    assert.match(source, /if \(hasToolCall\) \{\s*continue;\s*\}/);
    assert.match(source, /return null;\s*\}/);
    assert.match(source, /function normalizeOpenClawAgentPayload/);
    assert.match(source, /normalizeOpenClawAgentPayload\(agentId, turn\.payload\)/);
    assert.match(source, /async function runOpenClawAgentTurn/);
    assert.match(source, /Promise\.race\(\[commandOutcome, sessionOutcome\]\)/);
    assert.match(source, /commandAbort\.abort\(\)/);
    assert.match(source, /META_KIM_COMMAND_ABORTED/);
    assert.match(source, /pollAbort\.abort\(\)/);
    assert.match(source, /OpenClaw live turn still running/);
    assert.match(source, /heartbeatMs = 30_000/);
    assert.match(source, /baseStatus\.tempConfig\.stateDir/);
    assert.match(source, /"agents"/);
    assert.match(source, /openclaw:bootstrap-context:full/);
    assert.match(source, /payload\.sessionRecovery\?\.bootstrapFull === true/);
    assert.match(source, /recoveredFromSession/);
    assert.match(source, /JSON 必须包含 agent/);
    assert.match(source, /agentId === "meta-scout"/);
    assert.match(source, /不直接执行工具或运行时动作/);
    assert.match(source, /"--thinking"/);
    assert.match(source, /"300"/);
    assert.match(source, /sessionTimeoutMs: 390_000/);
    assert.match(source, /attempt <= 2/);
    assert.match(source, /attempts: turnAttempt/);
  });

  test("Cursor runtime reports projection smoke and explicit live harness contract boundary", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts", "eval-meta-agents.mjs"),
      "utf8",
    );
    const contract = JSON.parse(
      readFileSync(
        path.join(
          repoRoot,
          "config",
          "contracts",
          "cursor-live-turn-harness-contract.json",
        ),
        "utf8",
      ),
    );

    assert.match(source, /\["claude", "codex", "openclaw", "cursor"\]/);
    assert.match(source, /async function runCursorSmoke/);
    assert.match(source, /async function runCursorLive/);
    assert.match(source, /async function probeCursorAgentHarness/);
    assert.match(source, /function cursorLivePayloadOk/);
    assert.match(source, /META_KIM_CURSOR_AGENT_BIN/);
    assert.match(source, /META_KIM_CURSOR_BIN/);
    assert.match(source, /cursor-agent-wsl/);
    assert.match(source, /wsl\.exe/);
    assert.match(source, /function windowsPathToWslPath/);
    assert.match(source, /META_KIM_CURSOR_SKIP_WSL/);
    assert.match(source, /cursor-live-turn-harness-contract\.json/);
    assert.match(source, /"skills",\s*"meta-theory"/);
    assert.match(source, /"hooks\.json"/);
    assert.match(source, /"rules"/);
    assert.match(source, /cursor_live_harness_blocked/);
    assert.match(source, /unsupportedWithReason/);
    assert.match(source, /native_harness_missing/);
    assert.match(source, /localProbe/);
    assert.match(source, /blockedCriteria/);
    assert.match(source, /summarizeRuntimeReport\("cursor", report\.cursor\)/);
    assert.equal(contract.schemaVersion, "cursor-live-turn-harness-v0.1");
    assert.equal(
      contract.releaseBoundary.projectionSmokeIsLivePass,
      false,
    );
    assert.equal(contract.officialEvidenceRefreshedAt, "2026-06-04");
    assert.equal(contract.officialEvidenceRefreshOwner, "meta-scout");
    assert.ok(
      contract.officialEvidence.some((item) =>
        item.url === "https://docs.cursor.com/en/cli/reference/output-format",
      ),
    );
    assert.ok(
      contract.nativeHarnessCandidates.some((item) =>
        item.requiredHelpPatterns.includes("--output-format"),
      ),
    );
    assert.ok(
      contract.nativeHarnessCandidates.some((item) => item.id === "cursor-agent-wsl"),
    );
  });

  test("Cursor live with missing native agent reports structured blocked boundary", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/eval-meta-agents.mjs", "--runtime=cursor", "--live"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          META_KIM_CURSOR_AGENT_BIN: path.join(repoRoot, ".missing-cursor-agent.exe"),
          META_KIM_CURSOR_BIN: path.join(repoRoot, ".missing-cursor.exe"),
          META_KIM_CURSOR_SKIP_WSL: "1",
          NO_COLOR: "1",
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.cursor.status, "blocked");
    assert.equal(report.cursor.reason, "cursor_live_harness_blocked");
    assert.equal(report.cursor.failureClass, "native_harness_missing");
    assert.equal(
      report.cursor.contract.schemaVersion,
      "cursor-live-turn-harness-v0.1",
    );
    assert.equal(
      report.runtimeEvidencePacket.records[0].failureClass,
      "native_harness_missing",
    );
    assert.equal(report.runtimeEvidencePacket.records[0].evidenceKind, "unsupported");
    assert.match(
      report.runtimeEvidencePacket.records[0].remainingAction,
      /Cursor Agent CLI \(`cursor-agent`\)/,
    );
    assert.equal(report.summary.releaseGrade, false);
  });

  test("Cursor live success fixture remains diagnostic and cannot promote release-grade evidence", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/eval-meta-agents.mjs", "--runtime=cursor", "--live"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          META_KIM_CURSOR_LIVE_SUCCESS_FIXTURE: "1",
          META_KIM_CURSOR_SKIP_WSL: "1",
          NO_COLOR: "1",
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.summary.passed, ["cursor"]);
    assert.equal(report.cursor.status, "passed");
    assert.equal(report.cursor.fixture, true);
    assert.equal(report.cursor.localProbe.selectedHarness, "cursor-agent-success-fixture");
    assert.equal(report.runtimeEvidencePacket.records[0].runtime, "cursor");
    assert.equal(report.runtimeEvidencePacket.records[0].evidenceKind, "live");
    assert.equal(report.runtimeEvidencePacket.records[0].failureClass, "live_incomplete");
    assert.equal(report.runtimeEvidencePacket.records[0].strictReleasePass, false);
    assert.equal(report.runtimeEvidencePacket.summary.releaseGrade, false);
  });

  test("Runtime evidence aggregator uses fixed failure taxonomy", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts", "eval-meta-agents.mjs"),
      "utf8",
    );

    assert.match(source, /const RUNTIME_FAILURE_TAXONOMY/);
    for (const failureClass of [
      "timeout",
      "auth_missing",
      "native_harness_missing",
      "projection_only",
      "tool_unsupported",
    ]) {
      assert.match(source, new RegExp(failureClass));
    }
    assert.match(source, /function classifyRuntimeFailure/);
    assert.match(source, /function buildRuntimeEvidencePacket/);
    assert.match(source, /runtimeEvidencePacket/);
    assert.match(source, /remainingAction/);
    assert.match(source, /strictReleasePass/);
    const evidenceRecordBuilder = source.match(
      /function buildRuntimeEvidenceRecord\([\s\S]*?\n\}/u,
    )?.[0];
    assert.ok(evidenceRecordBuilder);
    assert.match(evidenceRecordBuilder, /report\?\.releaseFuseInvocationObserved === true/u);
    assert.match(source, /releaseGrade/);
    assert.match(source, /blockedFromRelease/);
  });

  test("Codex live validates governed orchestration and records timeout fallback evidence", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts", "eval-meta-agents.mjs"),
      "utf8",
    );

    assert.match(source, /const successPayload = \{/);
    assert.match(source, /function codexLivePayloadOk/);
    assert.match(source, /function tryExtractCodexReply/);
    assert.match(source, /governed_entry/);
    assert.match(source, /warden_entry_gate/);
    assert.match(source, /conductor_orchestration/);
    assert.match(source, /orchestrationTaskBoardPacket/);
    assert.match(source, /workerTaskPackets/);
    assert.match(source, /synthesisOwner/);
    assert.match(source, /roleDisplayName/);
    assert.match(
      source,
      /Owner: \$\{representativeAgentId\}\. Return ONLY OK/u,
      "the CLI lifecycle probe must carry the professional owner in its bounded child message",
    );
    assert.match(
      source,
      /wait for exactly that returned child until its final is visible/u,
      "Codex must use the current top-level collaboration lifecycle",
    );
    assert.match(source, /Call the native spawn_agent tool exactly once now/u);
    assert.match(source, /Never call wait before spawn_agent succeeds/u);
    assert.match(source, /do not retry the spawn/u);
    assert.match(source, /return exactly this JSON object and nothing else/u);
    assert.match(
      source,
      /do not use a code-exec wrapper/u,
      "the release prompt must reject the obsolete code-mode shim",
    );
    assert.doesNotMatch(source, /tools\.multi_agent_v1__spawn_agent/u);
    assert.doesNotMatch(source, /tools\.multi_agent_v1__wait_agent/u);
    assert.match(source, /META_KIM_CODEX_EVAL_MODEL/u);
    assert.match(source, /META_KIM_CODEX_EVAL_REASONING_EFFORT/u);
    assert.doesNotMatch(source, /runtimePayloadTemplate/u);
    assert.match(source, /isCommandTimeoutFailure/);
    assert.match(source, /META_KIM_COMMAND_TIMEOUT/);
    assert.doesNotMatch(source, /timeoutTriggered/u);
    assert.match(source, /runCommandWithIgnoredStdin/u);
    assert.match(source, /codex_live_timeout/);
    assert.match(source, /codex_exec_orchestration_prompt/);
    assert.match(source, /function extractCodexThreadId/);
    assert.match(source, /thread\.started/);
    assert.match(source, /threadId: extractCodexThreadId\(error\.stdout\)/);
    assert.match(source, /sessionRecoveryHint/);
    assert.match(source, /recoveredFromTimeout/);
    assert.match(source, /codex_live_timeout_recovered/);
    assert.match(source, /status: "passed"/);
    assert.match(source, /retryCommand/);
    assert.match(source, /stdoutTail/);
    assert.match(source, /stderrTail/);
    assert.match(
      source,
      /const CODEX_LIVE_TIMEOUT_MS\s*=\s*180_000/u,
    );
    assert.match(source, /timeout:\s*CODEX_LIVE_TIMEOUT_MS/u);
    assert.match(
      source,
      /timeoutMs:\s*error\.timeoutMs\s*\?\?\s*CODEX_LIVE_TIMEOUT_MS/u,
    );
    const evidenceHelper = source.match(
      /function inspectCodexLiveEvidence\([\s\S]*?\n\}/u,
    )?.[0];
    assert.ok(evidenceHelper);
    assert.match(evidenceHelper, /observeCodexJsonl\(hostEventText\)/u);
    assert.match(evidenceHelper, /spawn_agent/u);
    assert.match(evidenceHelper, /event\.childSessionId/u);
    assert.match(evidenceHelper, /releaseFuseInvocationObserved/u);
    assert.match(evidenceHelper, /customAgentInvocationObserved/u);
    assert.match(evidenceHelper, /run_scoped_owner_contract/u);
    assert.match(evidenceHelper, /native_custom_agent/u);
    assert.match(evidenceHelper, /returned_child_final/u);
    assert.match(source, /CODEX_SESSION_SETTLE_TIMEOUT_MS/u);
    assert.match(source, /sessionSettleTimeoutMs:\s*CODEX_SESSION_SETTLE_TIMEOUT_MS/u);
    assert.match(evidenceHelper, /event\.resultMessageId/u);
    assert.match(evidenceHelper, /event\.resultTextSha256/u);
    assert.match(
      evidenceHelper,
      /event\.completionBoundary === "returned_child_final"/u,
    );
    assert.doesNotMatch(evidenceHelper, /completed_activity_observed/u);
    const sessionFallbackHelper = source.match(
      /async function inspectCodexLiveEvidenceWithSessionFallback\([\s\S]*?\n\}/u,
    )?.[0];
    assert.ok(sessionFallbackHelper);
    assert.match(sessionFallbackHelper, /inspectCodexLiveEvidence\(stdout,/u);
    assert.match(
      sessionFallbackHelper,
      /if \(fixture \|\| directEvidence\.nativeInvocationObserved\) return directEvidence;[\s\S]*?readCodexSessionEvidence\(/u,
      "fixture evidence must short-circuit before any CODEX_HOME session lookup",
    );
    assert.match(sessionFallbackHelper, /hostEventText: sessionEvidence\.parentSessionText/u);
    assert.match(sessionFallbackHelper, /sessionEvidence: publicCodexSessionEvidence\(sessionEvidence\)/u);
    assert.match(sessionFallbackHelper, /codexSessionNativeInvocationMatches/u);
    assert.match(
      source,
      /liveEvidence = await inspectCodexLiveEvidenceWithSessionFallback\(stdout,/u,
    );
    assert.match(
      source,
      /timeoutEvidence = await inspectCodexLiveEvidenceWithSessionFallback\([\s\S]*?error\.stdout,/u,
      "timeout behavior JSON and validated session host events must use the same inspector",
    );
    const publicSessionEvidence = source.match(
      /function publicCodexSessionEvidence\(evidence\) \{[\s\S]*?\n\}/u,
    )?.[0];
    assert.ok(publicSessionEvidence);
    for (const safeField of [
      "threadId",
      "childSessionId",
      "sessionDigest",
      "childSessionDigest",
      "sourceCategory",
      "cliVersion",
    ]) {
      assert.match(publicSessionEvidence, new RegExp(`${safeField}: evidence\\.${safeField}`, "u"));
    }
    assert.doesNotMatch(publicSessionEvidence, /parentSessionText|SessionPath|filePath|codexHome/u);
    assert.match(source, /wrapperTimedOutAfterCompletedInvocation:\s*true/u);
    assert.match(source, /releaseFuseInvocationObserved:\s*true/u);
    assert.match(source, /customAgentInvocationObserved/u);
    assert.match(
      source,
      /nativeInvocationObserved:\s*customAgentInvocationObserved,[\s\S]*?customAgentInvocationObserved,/u,
      "public report must not alias custom-agent proof to run-scoped invocation proof",
    );
    const completedTimeoutPass = source.match(
      /if \(codexRecoveryHasReturnedChildFinal\(timeoutEvidence\)\) \{[\s\S]*?\n\s*\}/u,
    )?.[0];
    assert.ok(completedTimeoutPass);
    assert.doesNotMatch(completedTimeoutPass, /stderrTail/u);
    assert.match(completedTimeoutPass, /stderrSha256/u);
    assert.match(completedTimeoutPass, /errorClass/u);
    assert.match(
      source,
      /Warden -> Conductor -> orchestrationTaskBoardPacket -> workerTaskPackets/,
    );
  });

  test("Codex timeout recovery with structurally valid model JSON stays diagnostic-only", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/eval-meta-agents.mjs", "--runtime=codex", "--live"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          META_KIM_CODEX_LIVE_TIMEOUT_FIXTURE: "1",
          NO_COLOR: "1",
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.summary.passed, []);
    assert.deepEqual(report.summary.skipped, ["codex"]);
    assert.equal(report.codex.status, "skipped");
    assert.equal(report.codex.recoveredFromTimeout, true);
    assert.equal(report.codex.nativeInvocationObserved, false);
    assert.equal(
      report.codex.sample.runtime_smoke.orchestrationTaskBoardPacket
        .synthesisOwner,
      "meta-conductor",
    );
    assert.equal(
      report.codex.sample.runtime_smoke.workerTaskPackets[0].owner,
      "meta-artisan",
    );
    assert.equal(
      report.codex.sample.runtime_recovery.reason,
      "codex_live_timeout_recovered",
    );
    assert.equal(
      report.codex.sample.runtime_recovery.threadId,
      "codex-live-timeout-fixture-thread",
    );
    assert.equal(report.runtimeEvidencePacket.records[0].runtime, "codex");
    assert.equal(report.runtimeEvidencePacket.records[0].evidenceKind, "skipped");
    assert.equal(report.runtimeEvidencePacket.records[0].failureClass, "timeout");
    assert.equal(report.runtimeEvidencePacket.records[0].strictReleasePass, false);
    assert.equal(report.runtimeEvidencePacket.summary.releaseGrade, false);
    assert.equal("stderrTail" in report.codex.sample.runtime_recovery, false);
    assert.match(
      report.codex.sample.runtime_recovery.stderrSha256,
      /^[a-f0-9]{64}$/u,
    );
    assert.match(
      report.codex.sample.runtime_recovery.errorClass,
      /timeout/u,
    );
    assert.doesNotMatch(
      result.stdout,
      /(?:[A-Za-z]:[\\/](?:Users|home)[\\/]|Bearer\s+\S+|sk-[A-Za-z0-9_-]{12,})/iu,
      "public evaluator JSON must not expose home paths or credential-shaped tokens",
    );
  });

  test("Codex nonzero wrapper exit recovers only from a completed native invocation", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/eval-meta-agents.mjs", "--runtime=codex", "--live"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          META_KIM_CODEX_LIVE_NONZERO_FIXTURE: "returned",
          NO_COLOR: "1",
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.summary.passed, ["codex"]);
    assert.equal(report.codex.status, "passed");
    assert.equal(report.codex.releaseFuseInvocationObserved, true);
    assert.equal(report.codex.wrapperFailedAfterCompletedInvocation, true);
    assert.equal(
      report.codex.sample.runtime_recovery.reason,
      "codex_wrapper_failed_after_completed_native_invocation",
    );
    assert.equal(report.runtimeEvidencePacket.summary.releaseGrade, true);
    assert.equal("stderrTail" in report.codex.sample.runtime_recovery, false);
    assert.match(
      report.codex.sample.runtime_recovery.stderrSha256,
      /^[a-f0-9]{64}$/u,
    );
    assert.equal(
      report.codex.sample.runtime_native_invocation.completionBoundary,
      "returned_child_final",
    );
    assert.match(
      report.codex.sample.runtime_native_invocation.resultMessageId,
      /^message-[a-f0-9]{24}$/u,
    );
    assert.match(
      report.codex.sample.runtime_native_invocation.resultTextSha256,
      /^[a-f0-9]{64}$/u,
    );
  });

  test("Codex nonzero wrapper exit rejects dispatch-only evidence without a child return", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/eval-meta-agents.mjs", "--runtime=codex", "--live"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          META_KIM_CODEX_LIVE_NONZERO_FIXTURE: "weak",
          NO_COLOR: "1",
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.summary.passed, []);
    assert.deepEqual(report.summary.failed, ["codex"]);
    assert.equal(report.codex.status, "failed");
    assert.equal(report.runtimeEvidencePacket.summary.releaseGrade, false);
    assert.doesNotMatch(result.stdout, /wrapperFailedAfterCompletedInvocation/u);
  });

  test("Codex normal wrapper exit still rejects dispatch-only evidence", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/eval-meta-agents.mjs", "--runtime=codex", "--live"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          META_KIM_CODEX_LIVE_WEAK_NORMAL_FIXTURE: "1",
          NO_COLOR: "1",
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.summary.passed, []);
    assert.deepEqual(report.summary.failed, ["codex"]);
    assert.equal(report.codex.status, "failed");
    assert.equal(report.codex.releaseFuseInvocationObserved, false);
    assert.equal(report.runtimeEvidencePacket.summary.releaseGrade, false);
  });

  test("primary release fuse fixes Claude plus Codex scope and forbids filters or fixtures", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts", "eval-meta-agents.mjs"),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /runPrimaryReleaseRuntimeIsolated\("claude"\)/u,
      "Claude must retain its native direct custom-agent probe path",
    );
    assert.match(
      source,
      /primaryReleaseFuse\s*\?\s*await runPrimaryReleaseRuntimeIsolated\("codex"\)/u,
    );
    assert.match(
      source,
      /codex:\s*240_000[\s\S]*primaryReleaseProcessIsolation:\s*"runtime_subprocess"/u,
    );
    assert.match(
      source,
      /import\s*\{[^}]*runWindowsGuardedCommand[^}]*\}\s*from "\.\/eval-process-runner\.mjs";/u,
      "the primary evaluator must use the shared bounded Job Object runner",
    );
    assert.doesNotMatch(source, /META_KIM_EVAL_START_GATE/u);
    assert.match(
      source,
      /async function prepareIsolatedCodexLiveHome\([\s\S]*auth\.json[\s\S]*multi_agent = true[\s\S]*max_threads = 2/u,
      "the release probe must retain auth while isolating itself from unrelated user MCP configuration",
    );
    assert.match(source, /CODEX_HOME: isolatedRuntimeHome\.runtimeHome/u);
    assert.match(source, /delete codexEnv\.CODEX_THREAD_ID/u);
    assert.match(source, /delete codexEnv\.CODEX_SESSION_ID/u);
    assert.match(source, /delete codexEnv\.CODEX_INTERNAL_ORIGINATOR_OVERRIDE/u);
    assert.match(source, /cleanupIsolatedCodexLiveHome\(isolatedRuntimeHome\)/u);
    assert.doesNotMatch(source, /"--ignore-user-config"/u);
    assert.match(
      source,
      /META_KIM_CHILD_COMMAND_FAILED[\s\S]*codex_wrapper_failed_after_completed_native_invocation/u,
      "a nonzero wrapper exit may recover only from the same completed native-invocation evidence",
    );
    assert.match(source, /function codexRecoveryHasReturnedChildFinal\(/u);
    assert.match(source, /completionBoundary === "returned_child_final"/u);
    assert.doesNotMatch(source, /windows-process-tree-guard\.ps1/u);
    assert.doesNotMatch(source, /taskkill(?:\.exe)?/iu);
    const isolatedRunner = source.match(
      /async function runPrimaryReleaseRuntimeIsolated\(runtimeName\) \{[\s\S]*?\n\}/u,
    )?.[0];
    assert.ok(isolatedRunner);
    assert.match(
      isolatedRunner,
      /for \(let attempt = 1; attempt <= 2; attempt \+= 1\)/u,
      "a transient isolated Codex miss may retry once without reusing its evidence",
    );
    assert.match(isolatedRunner, /priorAttemptEvidence: attemptEvidence/u);
    assert.match(isolatedRunner, /META_KIM_CHILD_COMMAND_FAILED/u);
    assert.match(isolatedRunner, /non_release_grade_child_exit/u);
    const filtered = spawnSync(
      process.execPath,
      ["scripts/eval-meta-agents.mjs", "--primary-release-fuse", "--runtime=claude"],
      { cwd: repoRoot, encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(filtered.status, 1);
    assert.match(filtered.stderr, /fixes runtime scope to claude,codex.*forbids --runtime\/--agent/iu);

    const fixture = spawnSync(
      process.execPath,
      ["scripts/eval-meta-agents.mjs", "--primary-release-fuse"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          META_KIM_CODEX_LIVE_TIMEOUT_FIXTURE: "1",
          NO_COLOR: "1",
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.equal(fixture.status, 1);
    assert.match(fixture.stderr, /forbids Codex live failure fixtures/u);
  });
});
