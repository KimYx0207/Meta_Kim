import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { copyProjectCapability } from "../../scripts/project-capability-copy.mjs";

const REPO_ROOT = path.resolve(".");
const RUNNER = path.join(REPO_ROOT, "scripts", "run-meta-theory-governed-execution.mjs");

function makeFixture(name, { projectMarker = true, freshGlobalInventory = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), `meta-kim-governed-materialize-${name}-`));
  const projectDir = path.join(root, "project");
  const userHome = path.join(root, "user-home");
  const stateDir = path.join(root, "state");
  const artifactDir = path.join(root, "artifacts");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(userHome, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(artifactDir, { recursive: true });
  if (freshGlobalInventory) {
    const globalInventoryPath = path.join(
      userHome,
      ".meta-kim",
      "state",
      "default",
      "capability-index",
      "global-capabilities.json",
    );
    mkdirSync(path.dirname(globalInventoryPath), { recursive: true });
    writeFileSync(globalInventoryPath, `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      registryName: "global-capabilities",
      scope: "local-global-inventory",
      profile: "default",
      canonicalProjection: "config/capability-index/meta-kim-capabilities.json",
      repoCanonicalIndex: "config/capability-index/meta-kim-capabilities.json",
      localInventoryPath: ".meta-kim/state/default/capability-index/global-capabilities.json",
      summary: {
        totalAgents: 0,
        totalSkills: 0,
        totalHooks: 0,
        totalMcpServers: 0,
        totalMcpTools: 0,
        totalPlugins: 0,
        totalCommands: 0,
        totalRules: 0,
        totalPrompts: 0,
      },
      byPlatform: {},
      byCapabilityType: {
        agents: {},
        skills: {},
        hooks: {},
        mcpServers: {},
        mcpTools: {},
        plugins: {},
        commands: {},
        rules: {},
        prompts: {},
      },
    }, null, 2)}\n`, "utf8");
  }
  if (projectMarker) writeFileSync(path.join(projectDir, "package.json"), "{}\n", "utf8");
  return { root, projectDir, userHome, stateDir, artifactDir };
}

function runGoverned(fixture, { task, runId, extraArgs = [] }) {
  const result = spawnSync(
    process.execPath,
    [
      RUNNER,
      "--task",
      task,
      "--run-id",
      runId,
      "--state-dir",
      fixture.stateDir,
      "--artifact-dir",
      fixture.artifactDir,
      "--db",
      path.join(fixture.stateDir, "runs.sqlite"),
      "--runtime",
      "codex",
      "--output-language",
      "zh-CN",
      ...extraArgs,
    ],
    {
      cwd: fixture.projectDir,
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        HOME: fixture.userHome,
        USERPROFILE: fixture.userHome,
        CODEX_HOME: path.join(fixture.userHome, ".codex"),
        META_KIM_CODEX_HOME: path.join(fixture.userHome, ".codex"),
        META_KIM_CALLER_CWD: fixture.projectDir,
      },
    },
  );
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(readFileSync(path.join(fixture.artifactDir, `${runId}.json`), "utf8"));
}

test("governed run materializes confirmed Agent, Skill, and Command with project ownership", () => {
  const fixture = makeFixture("create");
  const candidatePrefix = "meta-kim-project-capability-candidates-";
  const candidatesBefore = new Set(
    readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(candidatePrefix)),
  );
  try {
    const artifact = runGoverned(fixture, {
      runId: "governed-materialize-create",
      task: [
        "请在当前项目新建 agent governed-release-auditor，负责审查发布配置并拒绝执行任何写操作。",
        "请在当前项目新建 skill governed-release-checklist，用于生成发布前检查清单并拒绝修改用户文件。",
        "请在当前项目新建 command governed-release-report，用于输出发布报告并拒绝执行未授权命令。",
      ].join("\n"),
    });

    const expected = [
      path.join(fixture.projectDir, ".codex", "agents", "governed-release-auditor.toml"),
      path.join(fixture.projectDir, ".agents", "skills", "governed-release-checklist", "SKILL.md"),
      path.join(fixture.projectDir, ".codex", "commands", "governed-release-report.md"),
    ];
    for (const target of expected) {
      assert.equal(existsSync(target), true, target);
      const content = readFileSync(target, "utf8");
      assert.match(content, /Goal/u);
      assert.match(content, /Responsibility/u);
      assert.match(content, /Refusal boundary/u);
    }

    const manifest = JSON.parse(readFileSync(
      path.join(fixture.projectDir, ".meta-kim", "state", "default", "project-capabilities.json"),
      "utf8",
    ));
    assert.deepEqual(
      new Set(manifest.capabilities.map((entry) => entry.type)),
      new Set(["agent", "skill", "command"]),
    );
    assert.ok(manifest.capabilities.every((entry) =>
      entry.ownershipClass === "runtime_sedimented_project_copy" &&
      entry.dependencyUpdatePolicy === "preserve_project_copy"),
    );
    assert.equal(artifact.projectCustomizationPacket.status, "completed");
    assert.equal(artifact.projectCustomizationPacket.execution.appliedCount, 3);
    assert.equal(artifact.coreLoop.executionResult.executionAllowed, false);
    assert.equal(artifact.coreLoop.executionResult.actualWorkerExecution, false);
    assert.equal(artifact.coreLoop.executionResult.actualProjectCapabilityMutation, true);
    assert.match(artifact.projectCustomizationPacket.userSummary, /已将 agent/u);
    assert.match(artifact.projectCustomizationPacket.userSummary, /\.codex\/agents/u);
    const leakedCandidates = readdirSync(os.tmpdir()).filter(
      (entry) => entry.startsWith(candidatePrefix) && !candidatesBefore.has(entry),
    );
    assert.deepEqual(leakedCandidates, [], "governed run must clean its unique temporary capability candidates");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("governed run reuses fitting global Agent, Skill, and Command without project copies", () => {
  const fixture = makeFixture("reuse");
  try {
    const codexHome = path.join(fixture.userHome, ".codex");
    mkdirSync(path.join(codexHome, "agents"), { recursive: true });
    mkdirSync(path.join(codexHome, "skills", "governed-reuse-skill"), { recursive: true });
    mkdirSync(path.join(codexHome, "commands"), { recursive: true });
    writeFileSync(path.join(codexHome, "agents", "governed-reuse-agent.toml"), 'name = "governed-reuse-agent"\n', "utf8");
    writeFileSync(path.join(codexHome, "skills", "governed-reuse-skill", "SKILL.md"), "# reuse skill\n", "utf8");
    writeFileSync(path.join(codexHome, "commands", "governed-reuse-command.md"), "# reuse command\n", "utf8");

    const artifact = runGoverned(fixture, {
      runId: "governed-materialize-reuse",
      task: [
        "直接复用全局 agent governed-reuse-agent，不需要迭代，也不要复制到项目，用于现有审查工作。",
        "直接复用全局 skill governed-reuse-skill，不需要迭代，也不要复制到项目，用于现有检查工作。",
        "直接复用全局 command governed-reuse-command，不需要迭代，也不要复制到项目，用于现有报告工作。",
      ].join("\n"),
    });

    assert.equal(artifact.projectCustomizationPacket.status, "completed_no_copy");
    assert.equal(artifact.projectCustomizationPacket.execution.appliedCount, 0);
    assert.equal(artifact.projectCustomizationPacket.execution.noCopyCount, 3);
    assert.equal(existsSync(path.join(fixture.projectDir, ".meta-kim", "state", "default", "project-capabilities.json")), false);
    assert.equal(existsSync(path.join(fixture.projectDir, ".codex", "agents", "governed-reuse-agent.toml")), false);
    assert.equal(existsSync(path.join(fixture.projectDir, ".agents", "skills", "governed-reuse-skill")), false);
    assert.equal(existsSync(path.join(fixture.projectDir, ".codex", "commands", "governed-reuse-command.md")), false);
    assert.match(artifact.projectCustomizationPacket.userSummary, /未复制到项目/u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("governed run iterates a complete global Skill directory and detaches it from global updates", () => {
  const fixture = makeFixture("iterate-skill");
  try {
    const skillRoot = path.join(fixture.userHome, ".codex", "skills", "governed-iterated-skill");
    const globalFiles = {
      skill: path.join(skillRoot, "SKILL.md"),
      reference: path.join(skillRoot, "references", "policy.md"),
      script: path.join(skillRoot, "scripts", "verify.mjs"),
      asset: path.join(skillRoot, "assets", "template.txt"),
    };
    for (const file of Object.values(globalFiles)) mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(globalFiles.skill, "# Global skill v1\n", "utf8");
    writeFileSync(globalFiles.reference, "global policy v1\n", "utf8");
    writeFileSync(globalFiles.script, "export const version = 1;\n", "utf8");
    writeFileSync(globalFiles.asset, "global template v1\n", "utf8");

    const artifact = runGoverned(fixture, {
      runId: "governed-materialize-iterate-skill",
      task: "请迭代全局 skill governed-iterated-skill，用于当前项目的发布审查，并拒绝覆盖用户维护的项目能力。",
    });

    const projectSkillRoot = path.join(fixture.projectDir, ".agents", "skills", "governed-iterated-skill");
    const expectedRelPaths = [
      ".agents/skills/governed-iterated-skill/SKILL.md",
      ".agents/skills/governed-iterated-skill/assets/template.txt",
      ".agents/skills/governed-iterated-skill/references/policy.md",
      ".agents/skills/governed-iterated-skill/scripts/verify.mjs",
    ];
    for (const relPath of expectedRelPaths) {
      assert.equal(existsSync(path.join(fixture.projectDir, ...relPath.split("/"))), true, relPath);
    }
    const manifestPath = path.join(fixture.projectDir, ".meta-kim", "state", "default", "project-capabilities.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.deepEqual(
      manifest.capabilities[0].files.map((file) => file.relPath).sort(),
      expectedRelPaths.slice().sort(),
    );
    assert.equal(manifest.capabilities[0].sourceRef.endsWith("/governed-iterated-skill"), true);
    assert.equal(artifact.projectCustomizationPacket.execution.appliedCount, 1);

    const projectReference = path.join(projectSkillRoot, "references", "policy.md");
    writeFileSync(projectReference, "project-owned policy\n", "utf8");
    writeFileSync(globalFiles.skill, "# Global skill v2\n", "utf8");
    writeFileSync(globalFiles.reference, "global policy v2\n", "utf8");
    writeFileSync(globalFiles.script, "export const version = 2;\n", "utf8");
    writeFileSync(globalFiles.asset, "global template v2\n", "utf8");
    const update = copyProjectCapability({
      projectDir: fixture.projectDir,
      runtime: "codex",
      type: "skill",
      id: "governed-iterated-skill",
      source: globalFiles.skill,
      mode: "iterate",
      apply: true,
    });
    assert.equal(update.ok, true);
    assert.equal(readFileSync(projectReference, "utf8"), "project-owned policy\n");
    assert.equal(readFileSync(path.join(projectSkillRoot, "SKILL.md"), "utf8"), "# Global skill v1\n");
    assert.equal(readFileSync(path.join(projectSkillRoot, "scripts", "verify.mjs"), "utf8"), "export const version = 1;\n");
    assert.equal(readFileSync(path.join(projectSkillRoot, "assets", "template.txt"), "utf8"), "global template v1\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("read-only governed run and unresolved project root do not claim materialization", () => {
  const readOnlyFixture = makeFixture("read-only");
  const failedFixture = makeFixture("failed", { projectMarker: false });
  const task = "请在当前项目新建 command governed-safe-report，用于输出安全报告并拒绝执行写操作。";
  try {
    const readOnly = runGoverned(readOnlyFixture, {
      runId: "governed-materialize-read-only",
      task,
      extraArgs: ["--read-only"],
    });
    assert.equal(readOnly.projectCustomizationPacket.status, "read_only");
    assert.equal(readOnly.projectCustomizationPacket.execution.appliedCount, 0);
    assert.equal(existsSync(path.join(readOnlyFixture.projectDir, ".codex", "commands", "governed-safe-report.md")), false);
    assert.match(readOnly.projectCustomizationPacket.userSummary, /只读模式/u);

    const failed = runGoverned(failedFixture, {
      runId: "governed-materialize-failed",
      task,
    });
    assert.equal(failed.status, "partial");
    assert.equal(failed.projectCustomizationPacket.status, "partial");
    assert.equal(failed.projectCustomizationPacket.execution.failedCount, 1);
    assert.equal(existsSync(path.join(failedFixture.projectDir, ".codex", "commands", "governed-safe-report.md")), false);
    assert.match(failed.projectCustomizationPacket.userSummary, /不会假称完成/u);
  } finally {
    rmSync(readOnlyFixture.root, { recursive: true, force: true });
    rmSync(failedFixture.root, { recursive: true, force: true });
  }
});

test("missing global inventory blocks project capability creation before materialization", () => {
  const fixture = makeFixture("missing-inventory", { freshGlobalInventory: false });
  try {
    const artifact = runGoverned(fixture, {
      runId: "governed-materialize-missing-inventory",
      task: "请在当前项目新建 command governed-inventory-gated-report，用于输出报告并拒绝执行未授权命令。",
    });
    assert.equal(artifact.status, "partial");
    assert.equal(artifact.projectCustomizationPacket.execution.appliedCount, 0);
    assert.equal(
      artifact.projectCustomizationPacket.execution.results[0].reason,
      "governed_route_not_execution_ready",
    );
    assert.equal(
      existsSync(path.join(fixture.projectDir, ".codex", "commands", "governed-inventory-gated-report.md")),
      false,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("query-only and underspecified create requests never produce placeholder capabilities", () => {
  const queryFixture = makeFixture("query");
  const vagueFixture = makeFixture("vague");
  const chineseAgentFixture = makeFixture("chinese-agent");
  const descriptiveFixture = makeFixture("descriptive-agent");
  try {
    const query = runGoverned(queryFixture, {
      runId: "governed-materialize-query",
      task: "是否需要在当前项目创建 command governed-query-only？只做判断，不要写入。",
    });
    assert.equal(query.projectCustomizationPacket.requestedCapabilityCount, 0);
    assert.equal(query.projectCustomizationPacket.status, "not_required");
    assert.equal(existsSync(path.join(queryFixture.projectDir, ".codex", "commands", "governed-query-only.md")), false);

    const vague = runGoverned(vagueFixture, {
      runId: "governed-materialize-vague",
      task: "请在当前项目新建 agent governed-empty-agent。",
    });
    assert.equal(vague.status, "partial");
    assert.equal(vague.projectCustomizationPacket.status, "partial");
    assert.equal(
      vague.projectCustomizationPacket.execution.results[0].reason,
      "insufficient_durable_capability_specification",
    );
    assert.equal(existsSync(path.join(vagueFixture.projectDir, ".codex", "agents", "governed-empty-agent.toml")), false);
    assert.match(vague.projectCustomizationPacket.userSummary, /不会假称完成/u);

    const chineseAgents = runGoverned(chineseAgentFixture, {
      runId: "governed-materialize-chinese-agents",
      task: [
        "请在当前项目新建智能体 governed-cn-agent，负责检查中文需求并拒绝修改用户文件。",
        "请在当前项目新建代理 governed-cn-proxy，负责验证交付状态并拒绝执行未授权命令。",
      ].join("\n"),
    });
    assert.equal(chineseAgents.projectCustomizationPacket.execution.appliedCount, 2);
    assert.equal(existsSync(path.join(chineseAgentFixture.projectDir, ".codex", "agents", "governed-cn-agent.toml")), true);
    assert.equal(existsSync(path.join(chineseAgentFixture.projectDir, ".codex", "agents", "governed-cn-proxy.toml")), true);

    const descriptive = runGoverned(descriptiveFixture, {
      runId: "governed-materialize-descriptive-agent",
      task: [
        "agent governed-background-observer 长期负责生成运行报告并拒绝修改用户文件。",
        "skill governed-report-helper is a recurring capability responsible for generating release reports and refuses to modify user files.",
        "agent governed-planner 长期负责生成 skill weekly-report 的计划。",
        "请审查需要升级的 agent governed-auditor，负责发布检查并拒绝修改用户文件。",
      ].join("\n"),
    });
    assert.equal(descriptive.projectCustomizationPacket.requestedCapabilityCount, 4);
    assert.equal(descriptive.projectCustomizationPacket.status, "read_only");
    assert.equal(descriptive.projectCustomizationPacket.execution.appliedCount, 0);
    assert.equal(descriptive.projectCustomizationPacket.execution.authorizationMissingCount, 4);
    assert.ok(
      descriptive.projectCustomizationPacket.execution.results.every(
        (result) => result.reason === "explicit_project_capability_mutation_authorization_required",
      ),
    );
    assert.equal(
      existsSync(path.join(descriptiveFixture.projectDir, ".codex", "agents", "governed-background-observer.toml")),
      false,
    );
    assert.equal(
      existsSync(path.join(descriptiveFixture.projectDir, ".agents", "skills", "governed-report-helper", "SKILL.md")),
      false,
    );
    assert.equal(
      existsSync(path.join(descriptiveFixture.projectDir, ".codex", "agents", "governed-planner.toml")),
      false,
    );
    assert.equal(
      existsSync(path.join(descriptiveFixture.projectDir, ".codex", "agents", "governed-auditor.toml")),
      false,
    );
    assert.equal(
      existsSync(path.join(descriptiveFixture.projectDir, ".meta-kim", "state", "default", "project-capabilities.json")),
      false,
    );
  } finally {
    rmSync(queryFixture.root, { recursive: true, force: true });
    rmSync(vagueFixture.root, { recursive: true, force: true });
    rmSync(chineseAgentFixture.root, { recursive: true, force: true });
    rmSync(descriptiveFixture.root, { recursive: true, force: true });
  }
});
