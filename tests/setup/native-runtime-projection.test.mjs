import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildNativeRuntimeAgent, invertNativeJsonMutations, planNativeRuntimeSettings } from "../../scripts/native-runtime-projection.mjs";
import { normalizeNativeHookPayload, translateNativeHookOutput } from "../../canonical/runtime-assets/shared/hooks/native-runtime-adapter.mjs";
import { manifestEntryToFinding, revertManagedJsonFragments } from "../../scripts/uninstall.mjs";
import { createGovernanceRuntimeFixture } from "../helpers/governance-runtime-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const settingsOptions = (runtimeId, overrides = {}) => ({ runtimeId, scope: "global", packageRoot: "/fixture/package", adapterPath: `/fixture/.${runtimeId}/hooks/meta-kim/native-runtime-adapter.mjs`, nodePath: "/fixture/node", ...overrides });

test("native config update and inverse preserve unrelated settings and user hooks", () => {
  for (const runtimeId of ["gemini", "zcode"]) {
    const base = { userSetting: { value: 7 }, ...(runtimeId === "gemini" ? { context: { fileName: ["TEAM.md"] }, mcpServers: { user: { command: "user-command" } } } : { hooks: { enabled: false }, mcp: { servers: { user: { command: "user-command" } } } }) };
    const first = planNativeRuntimeSettings(base, settingsOptions(runtimeId));
    const edited = structuredClone(first.config);
    edited.userSetting.value = 8;
    const events = runtimeId === "zcode" ? edited.hooks.events : edited.hooks;
    const event = runtimeId === "zcode" ? "PreToolUse" : "BeforeTool";
    const userBlock = { matcher: "user-tool", hooks: [{ type: "command", command: "user-owned" }] };
    events[event].push(userBlock);
    const second = planNativeRuntimeSettings(edited, settingsOptions(runtimeId, { packageRoot: "/fixture/package-v2", previousJournal: first.mutations }));
    assert.equal(second.config.userSetting.value, 8);
    assert.ok((runtimeId === "zcode" ? second.config.hooks.events : second.config.hooks)[event].some((block) => block.matcher === "user-tool"));
    const restored = invertNativeJsonMutations(second.config, second.mutations);
    assert.equal(restored.userSetting.value, 8);
    assert.deepEqual((runtimeId === "zcode" ? restored.hooks.events : restored.hooks)[event], [userBlock]);
    assert.equal(runtimeId === "zcode" ? restored.mcp.servers["meta-kim-runtime"] : restored.mcpServers["meta-kim-runtime"], undefined);
    if (runtimeId === "zcode") assert.equal(restored.hooks.enabled, false);
    else assert.deepEqual(restored.context.fileName, ["TEAM.md"]);
  }
});

test("ZCode project config contains no fake hooks and retains .agents MCP fallback", () => {
  const compatible = { existing: { command: "fixture", args: ["existing"] } };
  const planned = planNativeRuntimeSettings({}, settingsOptions("zcode", { scope: "project", compatibleMcpServers: compatible }));
  assert.equal(planned.config.hooks, undefined);
  assert.deepEqual(planned.config.mcp.servers.existing, compatible.existing);
  assert.deepEqual(invertNativeJsonMutations(planned.config, planned.mutations), {});
});

test("edited owned fragments and forged paths cannot be reverted or overwritten", () => {
  const planned = planNativeRuntimeSettings({}, settingsOptions("zcode"));
  planned.config.mcp.servers["meta-kim-runtime"].command = "user-replaced-command";
  assert.throws(() => invertNativeJsonMutations(planned.config, planned.mutations), /Managed JSON fragment changed/);
  assert.throws(() => planNativeRuntimeSettings(planned.config, settingsOptions("zcode", { previousJournal: planned.mutations })), /Managed JSON fragment changed/);
  assert.throws(() => invertNativeJsonMutations({}, [{ op: "set", path: ["model", "apiKey"], existed: false, value: "x" }]), /Invalid native runtime JSON mutation path/);
});

test("native agents inherit the host model and avoid copying foreign frontmatter", () => {
  const agent = { id: "meta-reviewer", description: "Review evidence", sourceFile: "canonical/agents/meta-reviewer.md", body: "Review the source and acceptance criteria.", raw: "model: opus\ntools: Agent" };
  for (const runtimeId of ["gemini", "zcode"]) {
    const rendered = buildNativeRuntimeAgent(agent, runtimeId);
    assert.match(rendered, /model: inherit/u);
    assert.doesNotMatch(rendered, /model: opus|tools: Agent/u);
    assert.match(rendered, /Review the source and acceptance criteria/u);
  }
});

test("Gemini and ZCode use documented, distinct hook input/output dialects", () => {
  const normalized = normalizeNativeHookPayload("gemini", "BeforeTool", { tool_name: "write_file", tool_input: { file_path: "src/a.ts", content: "x" } });
  assert.equal(normalized.tool_name, "Write");
  assert.equal(normalized.hook_event_name, "PreToolUse");
  const core = { hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "needs evidence" } };
  assert.deepEqual(translateNativeHookOutput("gemini", "BeforeTool", core), { decision: "deny", reason: "needs evidence" });
  assert.equal(translateNativeHookOutput("zcode", "PreToolUse", core).hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(translateNativeHookOutput("gemini", "SessionStart", core), {});
  assert.throws(() => normalizeNativeHookPayload("zcode", "BeforeTool", {}), /Unsupported native hook/);
});

test("native hook subprocess resolves the canonical dependency closure and translates an actual core denial", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "meta-kim-native-hook-"));
  try {
    for (const runtimeId of ["gemini", "zcode"]) {
      const result = spawnSync(process.execPath, [path.join(root, "canonical/runtime-assets/shared/hooks/native-runtime-adapter.mjs"),
        "--runtime", runtimeId, "--event", runtimeId === "gemini" ? "BeforeTool" : "PreToolUse", "--package-root", root], {
        cwd: fixture, input: JSON.stringify({ tool_name: runtimeId === "gemini" ? "write_file" : "Write", tool_input: { file_path: "example.js" } }),
        encoding: "utf8", timeout: 20000,
        // A controlled core identity fixture exercises denial transport; this
        // does not establish either new host's real subagent identity signal.
        env: { ...process.env, META_KIM_META_ENFORCEMENT_MODE: "block", CLAUDE_SUBAGENT_TYPE: "meta-warden" },
      });
      assert.equal(result.status, 0, result.stderr);
      const denied = JSON.parse(result.stdout);
      assert.equal(runtimeId === "gemini" ? denied.decision : denied.hookSpecificOutput.permissionDecision, "deny");
      assert.equal(existsSync(path.join(fixture, "example.js")), false);
    }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("real project sync shares Codex/Gemini skill bytes and preserves ZCode user config through update and uninstall", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "meta-kim-native-project-"));
  try {
    for (const item of ["package.json", "config", "canonical"]) cpSync(path.join(root, item), path.join(fixture, item), { recursive: true });
    const env = { ...process.env, META_KIM_REPO_ROOT: fixture, META_KIM_CALLER_CWD: fixture };
    const run = (targets, more = []) => spawnSync(process.execPath, [path.join(root, "scripts/sync-runtimes.mjs"), "--targets", targets, ...more], { cwd: fixture, env, encoding: "utf8" });
    mkdirSync(path.join(fixture, ".zcode"), { recursive: true });
    const configPath = path.join(fixture, ".zcode/config.json");
    writeFileSync(configPath, JSON.stringify({ userSetting: "keep", mcp: { servers: { unrelated: { command: "fixture" } } } }));
    let result = run("codex,gemini,zcode");
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const sharedSkillPath = path.join(fixture, ".agents/skills/meta-theory/SKILL.md");
    const original = readFileSync(sharedSkillPath, "utf8");
    assert.equal(existsSync(path.join(fixture, ".gemini/skills/meta-theory/SKILL.md")), false);
    assert.equal(existsSync(path.join(fixture, ".zcode/hooks")), false);
    for (const target of ["gemini", "codex", "zcode"]) {
      result = run(target);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(readFileSync(sharedSkillPath, "utf8"), original);
    }
    result = run("codex,gemini,zcode", ["--check", "--json"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).userSetting, "keep");
    const manifest = JSON.parse(readFileSync(path.join(fixture, ".meta-kim/install-manifest.json"), "utf8"));
    const entry = manifest.entries.find((item) => item.purpose === "zcode-project-settings-merge");
    assert.equal(entry.kind, "json-fragment-merge");
    const finding = manifestEntryToFinding(entry);
    const uninstalled = revertManagedJsonFragments({ path: finding.path, mutationJournal: finding.jsonMutationJournal });
    assert.equal(uninstalled.success, true, uninstalled.reason);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { userSetting: "keep", mcp: { servers: { unrelated: { command: "fixture" } } } });
    assert.equal(readFileSync(sharedSkillPath, "utf8"), original);
    const userModified = `${original}\nUser project instructions.\n`;
    writeFileSync(sharedSkillPath, userModified);
    for (const target of ["gemini", "codex"]) {
      result = run(target);
      assert.notEqual(result.status, 0, "both runtime writers must refuse an edited shared skill");
      assert.match(result.stderr, /Refusing to overwrite an unowned or edited native projection/u);
      assert.equal(readFileSync(sharedSkillPath, "utf8"), userModified);
    }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("switching native projections to global_only retires exact fragments and keeps user files", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "meta-kim-native-global-only-"));
  try {
    for (const item of ["package.json", "config", "canonical"]) cpSync(path.join(root, item), path.join(fixture, item), { recursive: true });
    const env = { ...process.env, META_KIM_REPO_ROOT: fixture, META_KIM_CALLER_CWD: fixture };
    const run = (more = []) => spawnSync(process.execPath, [path.join(root, "scripts/sync-runtimes.mjs"), "--targets", "gemini,zcode", ...more], { cwd: fixture, env, encoding: "utf8" });
    let result = run();
    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const name of ["gemini", "zcode"]) {
      const settings = path.join(fixture, `.${name}`, name === "gemini" ? "settings.json" : "config.json");
      const config = JSON.parse(readFileSync(settings, "utf8"));
      config.userSetting = name;
      writeFileSync(settings, JSON.stringify(config));
      writeFileSync(path.join(fixture, `.${name}/agents/user.md`), "User-owned agent.\n");
    }
    writeFileSync(path.join(fixture, ".meta-kim/local.overrides.json"), JSON.stringify({ projectProjectionMode: "global_only" }));
    result = run();
    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const name of ["gemini", "zcode"]) {
      assert.equal(existsSync(path.join(fixture, `.${name}/agents/meta-warden.md`)), false);
      assert.equal(readFileSync(path.join(fixture, `.${name}/agents/user.md`), "utf8"), "User-owned agent.\n");
      const settings = path.join(fixture, `.${name}`, name === "gemini" ? "settings.json" : "config.json");
      assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), { userSetting: name });
    }
    assert.equal(existsSync(path.join(fixture, ".agents/skills/meta-theory")), false);
    assert.equal(existsSync(path.join(fixture, ".zcode/skills/meta-theory")), false);
    assert.equal(existsSync(path.join(fixture, ".zcode/hooks")), false);
    assert.equal(existsSync(path.join(fixture, ".gemini/hooks/meta-kim/native-runtime-adapter.mjs")), true);
    result = run(["--check", "--json"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("native global package survives source removal and checks, updates, and uninstalls exact settings", (t) => {
  const runtime = createGovernanceRuntimeFixture(t);
  cpSync(path.join(root, "bin"), path.join(runtime.repoRoot, "bin"), { recursive: true });
  // This lifecycle case installs the real npm dependency closure. Carry only
  // the environment's transport/CA settings, never npm or provider credentials.
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (process.env[key]) runtime.env[key] = process.env[key];
  }
  let result = runtime.run(["scripts/refresh-runtime-evidence-pins.mjs"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  let stableRoot;
  for (const name of ["gemini", "zcode"]) {
    const configPath = path.join(runtime.home, `.${name}`, name === "zcode" ? "cli/config.json" : "settings.json");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ userSetting: name }));
  }
  result = runtime.run(["scripts/sync-global-meta-theory.mjs", "--targets", "gemini,zcode", "--with-global-hooks"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const sharedAlias = path.join(runtime.home, ".agents/skills/meta-theory");
  mkdirSync(sharedAlias, { recursive: true });
  writeFileSync(path.join(sharedAlias, "SKILL.md"), "User-owned shared alias must not be hidden or deleted.\n");
  result = runtime.run(["scripts/sync-global-meta-theory.mjs", "--targets", "gemini", "--check", "--with-global-hooks"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /active shared skill differs/u);
  assert.equal(readFileSync(path.join(sharedAlias, "SKILL.md"), "utf8"), "User-owned shared alias must not be hidden or deleted.\n");
  rmSync(sharedAlias, { recursive: true });
  result = runtime.run(["scripts/sync-global-meta-theory.mjs", "--targets", "gemini,zcode", "--check", "--with-global-hooks"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = runtime.run(["scripts/sync-global-meta-theory.mjs", "--targets", "gemini,zcode", "--with-global-hooks"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const name of ["gemini", "zcode"]) {
    const configPath = path.join(runtime.home, `.${name}`, name === "zcode" ? "cli/config.json" : "settings.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(config.userSetting, name);
    const mcp = (name === "zcode" ? config.mcp.servers : config.mcpServers)["meta-kim-runtime"];
    stableRoot = path.resolve(mcp.args[0], "../../..");
    assert.ok(mcp.args[0].includes("projection-packages"));
    assert.ok(existsSync(mcp.args[0]));
    const adapter = path.join(runtime.home, `.${name}/hooks/meta-kim/native-runtime-adapter.mjs`);
    const response = runtime.run([adapter, "--runtime", name, "--event", "SessionStart", "--package-root", path.resolve(mcp.args[0], "../../..")], { input: JSON.stringify({ cwd: runtime.repoRoot }) });
    assert.equal(response.status, 0, response.stderr);
    assert.ok(JSON.parse(response.stdout).hookSpecificOutput.additionalContext);
  }
  const shared = path.join(runtime.repoRoot, ".agents/skills/meta-theory/SKILL.md");
  const sharedBefore = readFileSync(shared, "utf8");
  const project = path.join(runtime.root, "customer-project");
  mkdirSync(path.join(project, ".git"), { recursive: true });
  mkdirSync(path.join(project, ".gemini"));
  mkdirSync(path.join(project, ".zcode"));
  writeFileSync(path.join(project, "AGENTS.md"), "User project conventions stay here.\n");
  writeFileSync(path.join(project, ".gemini/settings.json"), JSON.stringify({ userSetting: "project", context: { fileName: ["TEAM.md"] } }));
  writeFileSync(path.join(project, ".zcode/config.json"), JSON.stringify({ userSetting: "project" }));
  const bootstrap = (targets) => runtime.run([path.join(stableRoot, "setup.mjs"), "--project-bootstrap", "--apply", "--targets", targets, "--project-dir", project, "--json"], { cwd: project });
  result = bootstrap("codex,gemini,zcode");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const projectManifest = path.join(project, ".meta-kim/state/default/project-bootstrap.json");
  const projectManifestBefore = readFileSync(projectManifest, "utf8");
  const globalManifest = path.join(runtime.home, ".meta-kim/install-manifest.json");
  const globalManifestBefore = readFileSync(globalManifest, "utf8");
  const sourceDryRun = () => {
    const checked = runtime.run(["setup.mjs", "--project-bootstrap", "--dry-run", "--targets", "codex,gemini,zcode", "--project-dir", project, "--json"]);
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
    assert.equal(readFileSync(globalManifest, "utf8"), globalManifestBefore, "dry-run must not install or update global ownership");
    return JSON.parse(checked.stdout).results[0].state;
  };
  assert.equal(sourceDryRun().counts.pending, 0, "same source must reuse the verified immutable command authority");
  assert.equal(readFileSync(projectManifest, "utf8"), projectManifestBefore, "dry-run must preserve project ownership bytes");

  for (const changedRoot of [runtime.repoRoot, stableRoot]) {
    const changed = path.join(changedRoot, "scripts/mcp/meta-runtime-server.mjs");
    const before = readFileSync(changed);
    try {
      writeFileSync(changed, Buffer.concat([before, Buffer.from("\n// disposable source or bundle drift\n")]));
      assert.ok(sourceDryRun().counts.pending > 0, "changed source or a broken installed receipt cannot be reported as a no-op");
      assert.equal(readFileSync(projectManifest, "utf8"), projectManifestBefore);
    } finally { writeFileSync(changed, before); }
  }
  const unknown = JSON.parse(projectManifestBefore);
  unknown.sourceChain.packageRoot = path.join(runtime.root, "unverified-package");
  writeFileSync(projectManifest, JSON.stringify(unknown));
  try {
    assert.ok(sourceDryRun().counts.pending > 0, "a manifest locator alone is not package authority");
    assert.equal(readFileSync(projectManifest, "utf8"), JSON.stringify(unknown));
  } finally { writeFileSync(projectManifest, projectManifestBefore); }
  const projectShared = path.join(project, ".agents/skills/meta-theory/SKILL.md");
  const projectSharedBefore = readFileSync(projectShared, "utf8");
  assert.match(readFileSync(path.join(project, ".zcode/agents/meta-warden.md"), "utf8"), /model: inherit/u);
  assert.equal(existsSync(path.join(project, ".zcode/hooks")), false);
  for (const name of ["gemini", "zcode"]) {
    const configPath = path.join(project, `.${name}`, name === "gemini" ? "settings.json" : "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.laterUserEdit = true;
    writeFileSync(configPath, JSON.stringify(config));
  }
  result = bootstrap("codex,gemini,zcode");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(readFileSync(path.join(project, "AGENTS.md"), "utf8"), /User project conventions stay here/u);
  result = bootstrap("gemini");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(readFileSync(path.join(project, ".zcode/config.json"), "utf8")), { userSetting: "project", laterUserEdit: true });
  assert.equal(readFileSync(projectShared, "utf8"), projectSharedBefore);
  assert.equal(readFileSync(shared, "utf8"), sharedBefore);
  rmSync(runtime.repoRoot, { recursive: true, force: true });
  result = runtime.run([path.join(stableRoot, "scripts/sync-global-meta-theory.mjs"), "--targets", "gemini,zcode", "--check", "--with-global-hooks"], { cwd: project });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = runtime.run([path.join(stableRoot, "scripts/uninstall.mjs"), "--scope", "global", "--yes"], { cwd: project });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(readFileSync(projectShared, "utf8"), projectSharedBefore);
  assert.ok(existsSync(path.join(stableRoot, "scripts/mcp/meta-runtime-server.mjs")), "an enrolled project's execution dependency must remain installed");
  assert.match(result.stdout, /Shared execution package preserved/u);
  for (const name of ["gemini", "zcode"]) {
    const config = JSON.parse(readFileSync(path.join(runtime.home, `.${name}`, name === "zcode" ? "cli/config.json" : "settings.json"), "utf8"));
    assert.deepEqual(config, { userSetting: name });
  }
  result = bootstrap("codex");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(readFileSync(projectShared, "utf8"), projectSharedBefore);
  result = runtime.run([path.join(stableRoot, "scripts/uninstall.mjs"), "--scope", "global", "--yes"], { cwd: project });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(existsSync(stableRoot), false, "the package can retire after its final native project reference is removed");
});
