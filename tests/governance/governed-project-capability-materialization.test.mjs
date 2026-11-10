import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { copyProjectCapability } from "../../scripts/project-capability-copy.mjs";
import { createGovernanceRuntimeFixture } from "../helpers/governance-runtime-fixture.mjs";
import { fixtureCritical, fixtureInventoryProvider, fixtureReadWorkOrder, runFixtureHostCli } from "../helpers/host-reasoning-fixture.mjs";
import { localProtocolFixtureTaskFacts } from "../helpers/task-design-facts.mjs";

function childEnvironment(fixture) {
  return { ...fixture.env, HOME: fixture.userHome, USERPROFILE: fixture.userHome,
    CODEX_HOME: path.join(fixture.userHome, ".codex"), META_KIM_CODEX_HOME: path.join(fixture.userHome, ".codex"),
    META_KIM_CALLER_CWD: fixture.projectDir, MCP_MEMORY_URL: "http://127.0.0.1:1", META_KIM_DISABLE_MEMORY_AUTOSTART: "1" };
}

function makeFixture(name, { projectMarker = true, freshGlobalInventory = true, reuseSourceRuntimeHome = false } = {}) {
  const sourceRuntime = createGovernanceRuntimeFixture(null);
  // Development evidence pins bind this disposable source snapshot, never the
  // developer's concurrent worktree or installed package.
  const refreshed = sourceRuntime.run(["scripts/refresh-runtime-evidence-pins.mjs"]);
  assert.equal(refreshed.status, 0, refreshed.stderr || refreshed.stdout);
  const root = sourceRuntime.root;
  const projectDir = path.join(root, "project");
  const userHome = reuseSourceRuntimeHome ? sourceRuntime.home : path.join(root, "user-home");
  const stateDir = path.join(root, "state");
  const artifactDir = path.join(root, "artifacts");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(userHome, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(artifactDir, { recursive: true });
  // These are actual disposable discovery inputs, not invented selected-provider
  // records. Keep HOME isolated while retaining bounded role/creator fixtures.
  if (!reuseSourceRuntimeHome) cpSync(path.join(sourceRuntime.home, ".codex"), path.join(userHome, ".codex"), { recursive: true });
  const fixture = { root, projectDir, userHome, stateDir, artifactDir, sourceRoot: sourceRuntime.repoRoot, env: sourceRuntime.env };
  if (freshGlobalInventory) {
    const discovery = sourceRuntime.run(["scripts/discover-global-capabilities.mjs", "--runtime-inventory-only"], { env: childEnvironment(fixture) });
    assert.equal(discovery.status, 0, discovery.stderr || discovery.stdout);
  }
  if (projectMarker) writeFileSync(path.join(projectDir, "package.json"), "{}\n", "utf8");
  // This readable fixture input is deliberately not a project-root marker.
  writeFileSync(path.join(projectDir, "capability-fixture-input.md"), `# ${name}\nReview the requested capability, source binding and ownership boundaries. Only the separate reviewed materialization receiver may write capabilities. No native worker invocation is established.\n`);
  return fixture;
}

// The test host supplies a bounded source-review work order after real Fetch.
// Materialization remains a separate effect authorized by the original task
// and checked by the production receiver; this input grants no worker execution.
function materializationHostInputs(task) {
  const criticalInput = fixtureCritical({ task, successCriteria: [{ id: "capability-materialization-boundary",
    condition: "Apply only the explicitly requested, source-bound reviewed capability, or preserve the exact refusal and existing user files.",
    evidenceRequired: "Project customization decisions, copied bytes and ownership manifest, with native worker execution still unverified." }] });
  criticalInput.evidenceRefs = ["capability-fixture-input.md"];
  const governanceTaskFacts = localProtocolFixtureTaskFacts(task, { change: { behaviorPreservingInternalOnly: false } });
  return { criticalInput, governanceTaskFacts, workOrders: preparation => {
    const projectCreators = preparation.fetchPacket.capabilityDiscovery.providers.filter(provider =>
      provider.id === "meta-skill-creator" && provider.source === "project_runtime_skill_inventory" &&
      provider.routeEligible !== false && provider.executionEligible !== false && !provider.cacheEvidenceOnly);
    assert.ok(projectCreators.length <= 1, "The fixture must not invent a preference between ambiguous project creators");
    const skillCreation = projectCreators[0] ?? fixtureInventoryProvider(preparation, "meta-skill-creator", "providers");
    assert.match(skillCreation.inventoryRef, /^sha256:[a-f0-9]{64}$/u);
    const packet = fixtureReadWorkOrder(preparation, { id: "capability-source-review", todayTask: task,
      output: "Source and authorization findings for the requested local capability", criterionIds: ["capability-materialization-boundary"],
      taskFacts: governanceTaskFacts, selectedProviders: { skill: skillCreation, skillCreation,
        agentCreation: fixtureInventoryProvider(preparation, "create-agent", "providers") } });
    return [{ ...packet, capabilityNeed: ["Review local capability sources and ownership"],
      evidenceRefs: ["capability-fixture-input.md"], scopeFiles: ["capability-fixture-input.md"], shardScope: ["capability-fixture-input.md"],
      selectionReason: "The test host selects discovered source-review and creator methods; project-local creator evidence takes precedence when this fixture provides it.",
      referenceDirection: "Read capability-fixture-input.md and the supplied artifact bindings. Do not infer native invocation or authorize a different write.",
      verifySteps: [{ id: "capability-source-review-check", step: "Compare the requested capability with the reviewed artifact and current source binding", verify: "The receiver records copied bytes or its precise refusal without changing an unmanaged user file" }] }];
  } };
}

function fullGovernedSource(fixture, options) {
  const moduleUrl = relative => pathToFileURL(path.join(fixture.sourceRoot, relative)).href;
  return `
    import assert from "node:assert/strict";
    const { runMetaTheoryGovernedExecution } = await import(${JSON.stringify(moduleUrl("scripts/run-meta-theory-governed-execution.mjs"))});
    const { fixtureCritical, fixtureInventoryProvider, fixtureReadWorkOrder, runWithFixtureHostThinking } = await import(${JSON.stringify(moduleUrl("tests/helpers/host-reasoning-fixture.mjs"))});
    const { localProtocolFixtureTaskFacts } = await import(${JSON.stringify(moduleUrl("tests/helpers/task-design-facts.mjs"))});
    const hostInputs = (${materializationHostInputs.toString()});
    const options = ${JSON.stringify(options)};
    await runWithFixtureHostThinking(runMetaTheoryGovernedExecution, options, hostInputs(options.task));
  `;
}

function preparedCreationArtifact(fixture, { id, type }) {
  const creatorProviderId = type === "skill" ? "meta-skill-creator" : type === "agent" ? "create-agent" : "project-command-author";
  const creatorMethodRef = path.join(fixture.userHome, ".codex/skills", creatorProviderId, "SKILL.md");
  mkdirSync(path.dirname(creatorMethodRef), { recursive: true });
  writeFileSync(creatorMethodRef, `# ${creatorProviderId}\nDisposable creator method fixture; not native invocation proof.\n`);
  const sourceRoot = path.join(fixture.root, "prepared", id);
  mkdirSync(sourceRoot, { recursive: true });
  const content = `# ${id}\n\n## Goal\nCheck release configuration before delivery.\n\n## Responsibility\nRead the selected release manifest, compare required fields and emit a finding with source paths.\n\n## Refusal boundary\nDo not publish, change user files or treat a fixture as host invocation.\n`;
  const sourceRef = path.join(sourceRoot, type === "skill" ? "SKILL.md" : type === "agent" ? `${id}.toml` : `${id}.md`);
  writeFileSync(sourceRef, type === "agent"
    ? `name = "${id}"\ndescription = "Review release manifests and report field-level findings."\ndeveloper_instructions = ${JSON.stringify(content)}\n`
    : type === "skill" ? `---\nname: ${id}\ndescription: Review release manifests before delivery.\n---\n\n${content}` : content);
  if (type === "skill") {
    mkdirSync(path.join(sourceRoot, "references"));
    writeFileSync(path.join(sourceRoot, "references/checklist.md"), "Read the manifest version and required assets; report missing fields before delivery.\n");
  }
  const preview = copyProjectCapability({ projectDir: fixture.projectDir, runtime: "codex", type, id, source: sourceRef, mode: "create", apply: false });
  const files = preview.capability.files.map(({ relPath, baselineHash }) => ({ relPath, baselineHash })).sort((a, b) => a.relPath.localeCompare(b.relPath));
  const contentDigest = `sha256:${createHash("sha256").update(JSON.stringify(files)).digest("hex")}`;
  const evidenceRef = path.join(sourceRoot, "..", `${id}-creator-evidence.json`);
  writeFileSync(evidenceRef, JSON.stringify({ kind: "deterministic_creator_output_fixture", nativeInvocationVerified: false, creatorProviderId, creatorMethodRef }));
  const binding = { requestedCapability: id, capabilityType: type, runtime: "codex", projectRoot: fixture.projectDir };
  const approvalRef = path.join(sourceRoot, "..", `${id}-approval.json`);
  writeFileSync(approvalRef, JSON.stringify({ ...binding, status: "approved", contentDigest, creatorProviderId, creatorMethodRef, evidenceRefs: [evidenceRef] }));
  return { ...binding, sourceRef, creatorProviderId, creatorMethodRef, evidenceRefs: [evidenceRef], contentDigest, review: { status: "approved", approvalRef, contentDigest } };
}

function runGoverned(fixture, { task, runId, extraArgs = [], creationArtifacts = null, receiverProvider = null }) {
  const runner = path.join(fixture.sourceRoot, "scripts/run-meta-theory-governed-execution.mjs");
  const apiOptions = { task, runId, stateDir: fixture.stateDir, artifactDir: fixture.artifactDir, dbPath: path.join(fixture.stateDir, "runs.sqlite"), runtime: "codex", projectRoot: fixture.projectDir, outputLanguage: "zh-CN", projectCapabilityCreationArtifacts: creationArtifacts };
  const receiverSource = `
    import fs from "node:fs";
    const { buildProjectCustomizationPacket, executeProjectCustomizationPacket } = await import(${JSON.stringify(pathToFileURL(runner).href)});
    const options = ${JSON.stringify(apiOptions)};
    const provider = ${JSON.stringify(receiverProvider)};
    const plan = buildProjectCustomizationPacket({ ...options, creationArtifacts: options.projectCapabilityCreationArtifacts, orchestrationReport: { status: "pass", selectedExecutionRoute: { selectedCapabilityProviders: { skillCreation: provider }, ownerDiscoveryPacket: { candidateReusableCapabilityProviders: [provider] } } }, runtimeInvocationPlanPacket: { requiredBindings: [] } });
    const packet = executeProjectCustomizationPacket({ packet: plan, runtime: options.runtime, runId: options.runId, projectRoot: options.projectRoot });
    fs.writeFileSync(${JSON.stringify(path.join(fixture.artifactDir, `${runId}.json`))}, JSON.stringify({ projectCustomizationPacket: packet }));
  `;
  const processOptions = { cwd: fixture.projectDir, encoding: "utf8", timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024, env: childEnvironment(fixture) };
  const cliArgs = [
      runner,
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
    ];
  const result = receiverProvider || creationArtifacts
    ? spawnSync(process.execPath, ["--input-type=module", "--eval", receiverProvider ? receiverSource : fullGovernedSource(fixture, apiOptions)], processOptions)
    : runFixtureHostCli({ ...fixture, run: args => spawnSync(process.execPath, args, processOptions) }, cliArgs, materializationHostInputs(task));
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
      creationArtifacts: [
        preparedCreationArtifact(fixture, { id: "governed-release-auditor", type: "agent" }),
        preparedCreationArtifact(fixture, { id: "governed-release-checklist", type: "skill" }),
        preparedCreationArtifact(fixture, { id: "governed-release-report", type: "command" }),
      ],
      task: [
        "请在当前项目新建 agent governed-release-auditor，负责审查发布配置并拒绝执行任何写操作。",
        "请在当前项目新建 skill governed-release-checklist，用于生成发布前检查清单并拒绝修改用户文件。",
        "请在当前项目新建 command governed-release-report，用于输出发布报告并拒绝执行未授权命令。",
      ].join("\n"),
    });
    assert.equal(artifact.projectCustomizationPacket.status, "completed", JSON.stringify({ execution: artifact.projectCustomizationPacket.execution,
      creators: artifact.projectCustomizationPacket.decisions.map(decision => decision.creatorProvider) }));

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
    assert.notEqual(fixture.sourceRoot, fixture.projectDir);
    assert.equal(artifact.projectCustomizationPacket.execution.projectRoot, fixture.projectDir);
    assert.ok(artifact.projectCustomizationPacket.execution.results.every((result) => result.creationEvidence?.evidenceTier === "artifact_consistent" && result.creationEvidence.nativeInvocationVerified === false));
    assert.equal(existsSync(path.join(fixture.projectDir, ".agents/skills/governed-release-checklist/references/checklist.md")), true);
    assert.equal(readFileSync(path.join(fixture.projectDir, ".agents/skills/governed-release-checklist/SKILL.md"), "utf8"), readFileSync(path.join(fixture.root, "prepared/governed-release-checklist/SKILL.md"), "utf8"));
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

test("creator references follow their discovered source root while artifact references remain business-local", async (t) => {
  const fixture = makeFixture("creator-origin-roots", { freshGlobalInventory: false, reuseSourceRuntimeHome: true });
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ status: "healthy", memories: [] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const phases = [];
  const phase = (name) => {
    phases.push(name);
    writeFileSync(path.join(fixture.root, "creator-origin-stages.json"), JSON.stringify(phases));
    t.diagnostic(name);
  };
  try {
    const relativeMethod = ".agents/skills/meta-skill-creator/SKILL.md";
    const frameworkMethod = path.join(fixture.sourceRoot, relativeMethod);
    mkdirSync(path.dirname(frameworkMethod), { recursive: true });
    writeFileSync(frameworkMethod, "# Framework creator method\nDisposable source-origin fixture, not native execution proof.\n");
    const businessMethod = path.join(fixture.projectDir, relativeMethod);
    mkdirSync(path.dirname(businessMethod), { recursive: true });
    writeFileSync(businessMethod, "# Business creator method\nDifferent actual source with the same relative name.\n");
    const methodDigest = createHash("sha256").update(readFileSync(businessMethod)).digest("hex");
    const publishedBusinessRoot = process.platform === "win32" ? "[REDACTED_ABSOLUTE_PATH]" : "[REDACTED_POSIX_PATH]";
    const prepared = (id, creatorMethodRef, target = fixture) => {
      const artifact = preparedCreationArtifact(target, { id, type: "skill" });
      const originalSource = path.dirname(artifact.sourceRef);
      const businessSource = path.join(target.projectDir, "prepared", id);
      mkdirSync(path.join(businessSource, "references"), { recursive: true });
      for (const rel of ["SKILL.md", "references/checklist.md"]) writeFileSync(path.join(businessSource, rel), readFileSync(path.join(originalSource, rel)));
      artifact.sourceRef = `prepared/${id}/SKILL.md`;
      artifact.creatorMethodRef = creatorMethodRef;
      const evidenceDir = path.join(target.projectDir, "evidence");
      mkdirSync(evidenceDir, { recursive: true });
      artifact.evidenceRefs = [`evidence/${id}-creator.json`];
      writeFileSync(path.join(target.projectDir, artifact.evidenceRefs[0]), JSON.stringify({ fixture: true, nativeInvocationVerified: false }));
      const approval = { requestedCapability: id, capabilityType: "skill", runtime: "codex", projectRoot: target.projectDir, creatorProviderId: "meta-skill-creator", creatorMethodRef, evidenceRefs: artifact.evidenceRefs, status: "approved", contentDigest: artifact.contentDigest };
      artifact.review.approvalRef = `evidence/${id}-approval.json`;
      writeFileSync(path.join(target.projectDir, artifact.review.approvalRef), JSON.stringify(approval));
      return artifact;
    };
    const businessArtifact = prepared("business-creator-origin", businessMethod);
    const options = {
      task: "请在当前项目新建 skill business-creator-origin，用于检查发布清单并拒绝修改用户文件。",
      runId: "creator-origin-full-api",
      projectCapabilityCreationArtifacts: [businessArtifact],
      projectRoot: fixture.projectDir,
      runtime: "codex",
      outputLanguage: "zh-CN",
      stateDir: fixture.stateDir,
      artifactDir: fixture.artifactDir,
      dbPath: path.join(fixture.stateDir, "runs.sqlite"),
    };
    phase("full_api_started");
    // The local mock must remain responsive while the full API child runs.
    // Keep the established 180s API guard; do not block its server with spawnSync.
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "--eval", fullGovernedSource(fixture, options)], {
        cwd: fixture.projectDir,
        env: { ...childEnvironment(fixture), MCP_MEMORY_URL: `http://127.0.0.1:${server.address().port}` },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => { child.kill(); reject(new Error("creator full API exceeded its existing 180000ms guard")); }, 180000);
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`creator full API exited ${code}: ${stderr || stdout}`)); });
    });
    phase("full_api_returned");
    const full = JSON.parse(readFileSync(path.join(fixture.artifactDir, "creator-origin-full-api.json"), "utf8")).projectCustomizationPacket;
    t.diagnostic(JSON.stringify({ tier: "isolated_full_governed_api", creatorProvider: full.decisions[0].creatorProvider, status: full.status, results: full.execution.results }));
    assert.equal(full.decisions[0].creatorProvider.source, "project_runtime_skill_inventory");
    assert.equal(full.decisions[0].creatorProvider.sourceRoot, fixture.projectDir, "the internal Fetch handoff retains the actual project source root; published receiver roots are checked separately below");
    assert.equal(full.decisions[0].creatorProvider.contentDigest, methodDigest, "the real selector selected B's method, not A's same-name shadow");
    assert.equal(full.status, "completed");
    for (const rel of ["SKILL.md", "references/checklist.md"]) {
      assert.equal(readFileSync(path.join(fixture.projectDir, ".agents/skills/business-creator-origin", rel), "utf8"),
        readFileSync(path.join(fixture.projectDir, "prepared/business-creator-origin", rel), "utf8"));
    }

    // Receiver API cases supply explicit discovered-origin records. They test
    // source binding, not a claim that the full runner discovered project B.
    for (const [id, sourceRoot, contentDigest, expected, methodRef = relativeMethod, source = "project_runtime_skill_inventory"] of [
      ["creator-origin-business-visible", fixture.projectDir, methodDigest, "completed"],
      ["creator-origin-missing", null, methodDigest, "creator_provider_source_root_required"],
      ["creator-origin-wrong", fixture.sourceRoot, methodDigest, "creator_method_source_mismatch"],
      ["creator-origin-drift", publishedBusinessRoot, "0".repeat(64), "creator_provider_content_digest_mismatch"],
      ["creator-origin-no-digest", publishedBusinessRoot, null, "creator_provider_content_digest_required"],
      ["creator-origin-unknown", publishedBusinessRoot, methodDigest, "creator_provider_source_root_required", relativeMethod, "unknown_origin"],
      ["creator-origin-framework", ".", null, "completed", frameworkMethod],
      ["creator-origin-global", null, null, "completed", "~/.codex/skills/meta-skill-creator/SKILL.md", "codex_global_skill_filesystem_light_scan"],
    ]) {
      phase(`receiver_started:${id}`);
      const artifact = prepared(id, methodRef);
      const provider = { id: "meta-skill-creator", type: "skills", source, runtime: "codex",
        sourceRef: source === "codex_global_skill_filesystem_light_scan" ? methodRef : relativeMethod,
        ...(sourceRoot ? { sourceRoot } : {}), ...(contentDigest ? { contentDigest } : {}) };
      const packet = runGoverned(fixture, { task: `请创建 skill ${id}，用于检查发布清单并拒绝修改用户文件。`, runId: id, creationArtifacts: [artifact], receiverProvider: provider }).projectCustomizationPacket;
      if (expected === "completed") {
        assert.equal(packet.status, "completed");
        assert.equal(packet.execution.appliedCount, 1);
      } else {
        assert.equal(packet.status, "partial");
        assert.equal(packet.execution.results[0].reason, expected);
        assert.equal(packet.execution.appliedCount, 0);
        assert.equal(existsSync(path.join(fixture.projectDir, `.agents/skills/${id}/SKILL.md`)), false);
      }
      phase(`receiver_returned:${id}`);
    }
    const nested = { ...fixture, projectDir: path.join(fixture.sourceRoot, "nested-business") };
    const nestedMethod = path.join(nested.projectDir, relativeMethod);
    mkdirSync(path.dirname(nestedMethod), { recursive: true });
    writeFileSync(path.join(nested.projectDir, "package.json"), "{}\n");
    writeFileSync(nestedMethod, "# Nested business creator\nStill owned by business B inside A.\n");
    const nestedArtifact = prepared("creator-origin-nested", relativeMethod, nested);
    const nestedProvider = { id: "meta-skill-creator", type: "skills", source: "project_runtime_skill_inventory", runtime: "codex", sourceRef: relativeMethod,
      sourceRoot: `.${path.sep}nested-business`, contentDigest: createHash("sha256").update(readFileSync(nestedMethod)).digest("hex") };
    const nestedResult = runGoverned(nested, { task: "请创建 skill creator-origin-nested，用于检查发布清单并拒绝修改用户文件。", runId: "creator-origin-nested", creationArtifacts: [nestedArtifact], receiverProvider: nestedProvider }).projectCustomizationPacket;
    assert.equal(nestedResult.status, "completed");
    assert.equal(existsSync(path.join(nested.projectDir, ".agents/skills/creator-origin-nested/SKILL.md")), true);
  } finally {
    t.diagnostic(`last_phase:${phases.at(-1) ?? "before_api"}`);
    await new Promise((resolve) => server.close(resolve));
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("new capability creation requires reviewed creator output instead of generated shells", () => {
  const fixture = makeFixture("creator-output-required");
  try {
    const artifact = runGoverned(fixture, {
      runId: "governed-creator-output-required",
      task: [
        "请在当前项目新建 agent reviewed-release-auditor，负责检查发布清单并拒绝发布。",
        "请在当前项目新建 skill reviewed-release-checklist，用于检查发布文件并拒绝修改用户文件。",
        "请在当前项目新建 command reviewed-release-report，用于输出发布报告并拒绝执行未授权命令。",
      ].join("\n"),
    });
    assert.equal(artifact.status, "partial");
    assert.equal(artifact.projectCustomizationPacket.status, "partial");
    assert.equal(artifact.projectCustomizationPacket.execution.appliedCount, 0);
    assert.equal(artifact.projectCustomizationPacket.execution.failedCount, 3, JSON.stringify(artifact.projectCustomizationPacket));
    assert.ok(artifact.projectCustomizationPacket.decisions.every(decision => decision.globalCandidateChecked.matched === false),
      "reviewed-release-auditor must not be mistaken for the existing review Agent");
    assert.ok(artifact.projectCustomizationPacket.execution.results.every((result) => result.reason === "creator_output_required" && result.factoryNextStep));
    assert.equal(artifact.coreLoop.publicReadyDecision.publicReady, false);
    assert.ok(artifact.coreLoop.publicReadyDecision.blockedBy.includes("projectCustomizationPacket.status=partial."));
    assert.equal(existsSync(path.join(fixture.projectDir, ".meta-kim/state/default/project-capabilities.json")), false);
    assert.equal(existsSync(path.join(fixture.projectDir, ".agents/skills/reviewed-release-checklist/SKILL.md")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("creation handoff rejects wrong creators, missing provenance, approval drift, scope drift and user-file conflicts", async (t) => {
  const id = "reviewed-project-method";
  const task = `请在当前项目新建 skill ${id}，用于检查发布清单并拒绝修改用户文件。`;
  const cases = [
    ["wrong-creator", (artifact) => { artifact.creatorProviderId = "create-agent"; }, "meta_skill_creator_provider_required"],
    ["missing-provenance", (artifact) => { rmSync(artifact.evidenceRefs[0]); }, "creator_provenance_source_required"],
    ["pending-approval", (artifact) => {
      const approval = JSON.parse(readFileSync(artifact.review.approvalRef, "utf8"));
      approval.status = "pending";
      writeFileSync(artifact.review.approvalRef, JSON.stringify(approval));
    }, "creator_review_approval_required"],
    ["changed-package-resource", (artifact) => { writeFileSync(path.join(path.dirname(artifact.sourceRef), "references/checklist.md"), "Changed after approval.\n"); }, "creator_prepared_content_digest_mismatch"],
    ["wrong-project", (artifact, fixture) => { artifact.projectRoot = fixture.sourceRoot; }, "creator_output_required"],
    ["wrong-type", (artifact) => { artifact.capabilityType = "agent"; }, "creator_output_required"],
    ["wrong-runtime", (artifact) => { artifact.runtime = "claude"; }, "creator_output_required"],
    ["unmanaged-user-file", (_artifact, fixture) => {
      const userFile = path.join(fixture.projectDir, `.agents/skills/${id}/references/checklist.md`);
      mkdirSync(path.dirname(userFile), { recursive: true });
      writeFileSync(userFile, "User-maintained project method.\n");
    }, `Unmanaged project capability conflict: .agents/skills/${id}/references/checklist.md`],
  ];
  for (const [name, mutate, reason] of cases) {
    await t.test(name, () => {
      const fixture = makeFixture(name);
      try {
        const prepared = preparedCreationArtifact(fixture, { id, type: "skill" });
        mutate(prepared, fixture);
        const artifact = runGoverned(fixture, { task, runId: `creation-boundary-${name}`, creationArtifacts: [prepared] });
        assert.equal(artifact.projectCustomizationPacket.status, "partial");
        assert.equal(artifact.projectCustomizationPacket.execution.appliedCount, 0);
        assert.equal(artifact.projectCustomizationPacket.execution.results[0].reason, reason);
        assert.equal(artifact.coreLoop.publicReadyDecision.publicReady, false);
        assert.equal(existsSync(path.join(fixture.projectDir, ".meta-kim/state/default/project-capabilities.json")), false);
        const target = path.join(fixture.projectDir, `.agents/skills/${id}/SKILL.md`);
        assert.equal(existsSync(target), false);
        if (name === "unmanaged-user-file") assert.equal(readFileSync(path.join(path.dirname(target), "references/checklist.md"), "utf8"), "User-maintained project method.\n");
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("candidate-only and conditional creation stay unapproved without writing a named Skill", () => {
  const fixture = makeFixture("candidate-only");
  try {
    const artifact = runGoverned(fixture, {
      runId: "creation-candidate-only",
      task: "Create candidate-only skill named pending-project-method for repeatable release verification.\nCreate skill conditional-project-method unless Warden approval is supplied, responsible for release verification.",
    });
    assert.equal(artifact.projectCustomizationPacket.execution.appliedCount, 0);
    assert.equal(artifact.projectCustomizationPacket.status, "read_only");
    assert.equal(artifact.projectCustomizationPacket.execution.authorizationMissingCount, 2);
    assert.equal(artifact.coreLoop.publicReadyDecision.publicReady, false);
    assert.equal(existsSync(path.join(fixture.projectDir, ".agents/skills")), false);
    assert.equal(existsSync(path.join(fixture.projectDir, ".meta-kim/state/default/project-capabilities.json")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("existing user Skill reuse does not turn a refusal into iteration or ownership", () => {
  const fixture = makeFixture("existing-project-user-skill");
  try {
    const target = path.join(fixture.projectDir, ".agents/skills/existing-project-method/SKILL.md");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "# User project method\nVerified project-specific release checks.\n");
    const before = readFileSync(target, "utf8");
    const artifact = runGoverned(fixture, {
      runId: "existing-project-user-skill",
      task: "请在当前项目创建 skill existing-project-method，用于检查发布清单并拒绝修改用户文件。",
    });
    assert.equal(artifact.projectCustomizationPacket.status, "completed_no_copy");
    assert.equal(artifact.projectCustomizationPacket.decisions[0].copyPolicy, "use_global_directly");
    assert.equal(artifact.projectCustomizationPacket.execution.appliedCount, 0);
    assert.equal(readFileSync(target, "utf8"), before);
    assert.equal(existsSync(path.join(fixture.projectDir, ".meta-kim/state/default/project-capabilities.json")), false);
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

test("missing cached inventory cannot replace reviewed creator output for current source-bound capabilities", () => {
  const fixture = makeFixture("missing-inventory", { freshGlobalInventory: false });
  try {
    assert.equal(existsSync(path.join(fixture.userHome, ".meta-kim/state/default/capability-index/global-capabilities.json")), false);
    const artifact = runGoverned(fixture, {
      runId: "governed-materialize-missing-inventory",
      task: "请在当前项目新建 command governed-inventory-gated-report，用于输出报告并拒绝执行未授权命令。",
    });
    assert.equal(artifact.status, "partial");
    assert.equal(artifact.projectCustomizationPacket.execution.appliedCount, 0);
    assert.equal(
      artifact.projectCustomizationPacket.execution.results[0].reason,
      "creator_output_required",
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
      creationArtifacts: [
        preparedCreationArtifact(chineseAgentFixture, { id: "governed-cn-agent", type: "agent" }),
        preparedCreationArtifact(chineseAgentFixture, { id: "governed-cn-proxy", type: "agent" }),
      ],
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
