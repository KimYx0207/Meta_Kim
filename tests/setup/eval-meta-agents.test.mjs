import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveClaudeLiveProviderEnvironment,
  selectClaudeLiveProviderEnv,
} from "../../scripts/claude-live-provider-env.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

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

  test("Claude live evaluation uses the Claude provider settings without importing arbitrary settings env", async () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "meta-kim-claude-provider-env-"));
    try {
      const settingsDir = path.join(tempHome, ".claude");
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(
        path.join(settingsDir, "settings.json"),
        JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: "https://api.minimaxi.example/anthropic",
            ANTHROPIC_AUTH_TOKEN: "configured-token",
            ANTHROPIC_MODEL: "MiniMax-M3",
            ANTHROPIC_DEFAULT_SONNET_MODEL: "MiniMax-M3",
            NODE_OPTIONS: "--require=untrusted-settings-entry",
          },
        }),
      );

      const resolved = await resolveClaudeLiveProviderEnvironment({
        homeDir: tempHome,
        ambientEnv: {
          PATH: "fixture-path",
          ANTHROPIC_BASE_URL: "https://api.z.example/anthropic",
          ANTHROPIC_AUTH_TOKEN: "ambient-token",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.2[1m]",
        },
      });

      assert.equal(
        resolved.ANTHROPIC_BASE_URL,
        "https://api.minimaxi.example/anthropic",
      );
      assert.equal(resolved.ANTHROPIC_AUTH_TOKEN, "configured-token");
      assert.equal(resolved.ANTHROPIC_MODEL, "MiniMax-M3");
      assert.equal(resolved.ANTHROPIC_DEFAULT_SONNET_MODEL, "MiniMax-M3");
      assert.equal(resolved.PATH, "fixture-path");
      assert.equal(resolved.NO_COLOR, "1");
      assert.equal(resolved.NODE_OPTIONS, undefined);
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

    assert.match(source, /const codexLiveOrchestrationSchema/);
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
      /set fork_turns to "none" because the bounded child task below is self-contained/u,
      "Codex 0.146 rejects an explicit agent_type when spawn_agent keeps the default full-history fork",
    );
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
      /"exec",\s*"--ignore-user-config",\s*"--enable",\s*"multi_agent",\s*"--json"/u,
      "the release probe must retain auth while isolating itself from unrelated user MCP configuration",
    );
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
