#!/usr/bin/env node
/** Opt-in, isolated official-host probe. No LLM provider is mounted or called. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyExecutingGlobalProjectionPackage } from "../../scripts/global-projection-package-store.mjs";
import { buildIsolatedTestEnvironment } from "../../scripts/run-local-verification.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

export async function probeNativeDsh({ dshRoot, servicePackage, keepArtifacts = false } = {}) {
  if (!dshRoot) throw new Error("--dsh-root must point to a local environment containing the official @deepseek-ai/dsh package");
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "meta-dsh-native-")));
  const home = path.join(temp, "home");
  const cwd = path.join(temp, "project");
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  for (const name of ["tmp", "appdata", "localappdata", "config", "cache", "data", "state", "npm-cache"]) fs.mkdirSync(path.join(home, name));
  const env = { ...buildIsolatedTestEnvironment(home), DSH_HOME: path.join(home, ".dsh") };
  try {
    // Package provisioning may need the managed network proxy/CA. Only this
    // isolated installer receives transport plumbing; no model/API credentials,
    // npm user configuration, NODE_OPTIONS, or host-runtime overrides enter it.
    // The official native worker below receives the strict environment alone.
    const installerEnv = { ...env };
    const transportKeys = new Set(["http_proxy", "https_proxy", "all_proxy", "no_proxy", "node_extra_ca_certs", "ssl_cert_file", "ssl_cert_dir"]);
    for (const [key, value] of Object.entries(process.env)) if (transportKeys.has(key.toLowerCase())) installerEnv[key] = value;
    const serviceArgs = servicePackage ? ["--service-package", path.resolve(servicePackage)] : [];
    const installed = spawnSync(process.execPath, [path.join(ROOT, "bin/meta-kim.mjs"), "dsh", "install", ...serviceArgs, "--json"], { env: installerEnv, cwd, encoding: "utf8", timeout: 240000, maxBuffer: 32 * 1024 * 1024 });
    if (installed.status !== 0) throw new Error(`Isolated package installation failed: ${installed.error?.message ?? installed.stderr?.slice(-4000) ?? installed.status}`);
    const initial = JSON.parse(installed.stdout);
    fs.writeFileSync(path.join(temp, "initial-install.json"), JSON.stringify({ ok: initial.ok, status: initial.status, skillCount: initial.skillCount, mcpConfigured: initial.mcpConfigured }));
    const payload = { dshRoot: path.resolve(dshRoot), servicePackage: servicePackage ? path.resolve(servicePackage) : null, keepArtifacts, temp, home, cwd };
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--native-worker", JSON.stringify(payload)], { env, cwd, encoding: "utf8", timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
    if (child.status !== 0) throw new Error(`Isolated native worker failed: ${child.error?.message ?? child.stderr?.slice(-4000) ?? child.status}`);
    return readJson(path.join(temp, "probe-report.json"));
  } finally { if (!keepArtifacts) fs.rmSync(temp, { recursive: true, force: true }); }
}

async function nativeWorker({ dshRoot, servicePackage, keepArtifacts, temp, home, cwd }) {
  assert.equal(os.homedir(), home, "The whole native worker must use the isolated HOME");
  assert.equal(process.cwd(), cwd);
  assert.equal(process.env.DSH_HOME, path.join(home, ".dsh"));
  const allowed = new Set(Object.keys(buildIsolatedTestEnvironment(home, process.env)).map((key) => key.toUpperCase()));
  allowed.add("DSH_HOME");
  assert.deepEqual(Object.keys(process.env).filter((key) => !allowed.has(key.toUpperCase())), [], "No host credentials or runtime overrides may enter the official native worker");
  const contract = readJson(path.join(ROOT, "canonical/runtime-assets/dsh/host-contract.json"));
  const nativeRequire = createRequire(path.join(path.resolve(dshRoot), "package.json"));
  const nativeManifestPath = nativeRequire.resolve("@deepseek-ai/dsh/package.json");
  const nativeManifest = readJson(nativeManifestPath);
  assert.equal(nativeManifest.name, "@deepseek-ai/dsh");
  assert.equal(nativeManifest.version, contract.reviewedVersion, "Review/pin a new upstream contract before certifying another DSh version");
  const load = (name) => import(pathToFileURL(nativeRequire.resolve(name)).href);
  const [{ Context }, { default: SystemPrompt }, { default: Tools }, { default: McpResources }, Mcp, { FileSystemSkillProvider }, { default: LocalFs }, ToolFs, { default: SessionProjections }, { default: WorkingDirectory }, { default: TokenMeter }, { default: ResultPruner }, { default: Skills, renderSkillContent }] = await Promise.all([
    load("@deepseek-ai/cordis"), load("@deepseek-ai/dsh-system-prompt"), load("@deepseek-ai/dsh-tools"),
    load("@deepseek-ai/dsh-mcp-resources"), load("@deepseek-ai/dsh-mcp-client"), load("@deepseek-ai/dsh-skill-filesystem"),
    load("@deepseek-ai/dsh-fs-local"), load("@deepseek-ai/dsh-tool-fs"), load("@deepseek-ai/dsh-session-projection"),
    load("@deepseek-ai/dsh-working-directory"), load("@deepseek-ai/dsh-token-meter"), load("@deepseek-ai/dsh-compaction-tool-result-pruner"),
    load("@deepseek-ai/dsh-skill"),
  ]);
  const dshHome = path.join(home, ".dsh");
  const env = process.env;
  const invoke = (cli, args, accepted = [0]) => {
    const call = spawnSync(process.execPath, [cli, ...args], { env, cwd, encoding: "utf8", timeout: 240000, maxBuffer: 32 * 1024 * 1024 });
    if (!accepted.includes(call.status)) throw new Error(`Probe subprocess failed (${args.join(" ")}): ${call.error?.message ?? call.stderr?.slice(-3000) ?? call.status}`);
    return call.stdout;
  };
  const serviceArgs = servicePackage ? ["--service-package", path.resolve(servicePackage)] : [];
  let ctx;
  try {
    const installed = readJson(path.join(temp, "initial-install.json"));
    assert.equal(installed.ok, true); assert.equal(installed.mcpConfigured, true);
    const installation = readJson(path.join(dshHome, "skills/meta-theory/installation.json"));
    const stable = await verifyExecutingGlobalProjectionPackage({ packageRoot: installation.executionRoot, homeRoot: home });
    assert.ok(stable, "MCP executable must be in a verified immutable package");
    const packedCli = path.join(stable.packageRoot, "bin/meta-kim.mjs");
    const checked = JSON.parse(invoke(packedCli, ["dsh", "check", "--json"]));
    assert.equal(checked.status, "verified_files");
    assert.equal(checked.mcpConfigured, true);
    assert.match(invoke(packedCli, ["dsh", "check"]), /MCP configured: yes/u);
    const updated = JSON.parse(invoke(packedCli, ["dsh", "update", ...serviceArgs, "--json"]));
    assert.equal(updated.status, "noop");

    const dump = invoke(path.join(path.dirname(nativeManifestPath), "lib/bin.js"), ["--profile", contract.profileName, "--dump-config"]);
    fs.writeFileSync(path.join(temp, "native-config.yml"), dump);
    assert.match(dump, /meta-kim-mcp/u); assert.match(dump, /@deepseek-ai\/dsh-mcp-client/u);
    ctx = new Context();
    await ctx.plugin(SystemPrompt, {}); await ctx.plugin(Tools);
    await ctx.plugin(LocalFs, { cwd }); await ctx.plugin(SessionProjections);
    await ctx.plugin(WorkingDirectory, { defaultDirectory: cwd });
    await ctx.plugin(ToolFs, { read: true, readImage: false, write: false, edit: false, applyPatch: false });
    await ctx.plugin(TokenMeter, {}); await ctx.plugin(ResultPruner, {}); await ctx.plugin(Skills, {});
    const readTool = ctx.tools.definitions().find((definition) => definition.name === "read");
    const readCache = new Map(); const indexCache = new Map();
    let maxRenderedCharacters = 0; let nativePartReads = 0; let jsonResourceCount = 0; let codeResourceCount = 0;
    let largestJson = null; let largestCode = null;
    const readNative = async (file) => {
      if (readCache.has(file)) return readCache.get(file);
      const args = { file_path: file };
      const value = await readTool.execute(args, { signal: AbortSignal.timeout(10000) });
      const content = readTool.output.render(args, value);
      const measured = ctx.toolResultPruner.measureContent(content);
      maxRenderedCharacters = Math.max(maxRenderedCharacters, measured);
      assert.equal(ctx.toolResultPruner.pruneContent(content), null, `Official result pruner would remove rules from ${file}`);
      const bytes = fs.readFileSync(file); const text = bytes.toString("utf8");
      const lines = text === "" ? [] : text.split(/\r?\n/u);
      if (text.endsWith("\n")) lines.pop();
      assert.deepEqual(value.lines.map((line) => line.text), lines, `Official read tool truncated a rule or line in ${file}`);
      assert.equal(value.totalLines, lines.length);
      readCache.set(file, bytes);
      return bytes;
    };
    const readIndex = async (file) => {
      if (indexCache.has(file)) return indexCache.get(file);
      const index = JSON.parse(await readNative(file)); const dir = path.dirname(file);
      let parts = index.parts;
      if (!parts) {
        parts = [];
        for (const page of index.pages) {
          const bytes = await readNative(path.join(dir, page.path)); assert.equal(sha(bytes), page.sha256);
          parts.push(...JSON.parse(bytes).parts);
        }
      }
      const assembled = [];
      for (const part of parts) {
        const bytes = await readNative(path.join(dir, part.path));
        assert.equal(sha(bytes), part.sha256); assert.ok(bytes.toString("utf8").length <= contract.resourcePartMaxCharacters);
        assembled.push(bytes); nativePartReads += 1;
      }
      const original = path.resolve(dir, index.original); const bytes = Buffer.concat(assembled);
      assert.deepEqual(bytes, fs.readFileSync(original)); assert.equal(sha(bytes), index.sha256);
      if (original.endsWith(".json")) {
        jsonResourceCount += 1;
        if (!largestJson || bytes.length > largestJson.size) largestJson = { file: original, size: bytes.length };
      }
      if (/\.(?:[cm]?js|jsx|tsx?|py|sh|bash|ps1|sql)$/iu.test(original)) {
        codeResourceCount += 1;
        if (!largestCode || bytes.length > largestCode.size) largestCode = { file: original, size: bytes.length };
      }
      indexCache.set(file, parts.length);
      return parts.length;
    };
    const inspectNativeSkills = async (expectedSource, expectedRoot, lookupCwd = cwd) => {
      let provider;
      const unregister = ctx.skills.registerProvider((control) => {
        provider = new FileSystemSkillProvider(ctx, control, { dshHome, agentsHome: path.join(home, "empty-agents"), watch: false });
        return provider;
      });
      const names = []; let primaryMethodPartsRead = 0; let maxLoaderCharacters = 0;
      const signal = AbortSignal.timeout(120000);
      try {
        const snapshot = await ctx.skills.snapshot({ cwd: lookupCwd, signal });
        assert.equal(snapshot.complete, true, "Native Skill discovery must be complete");
        assert.equal(snapshot.skills.length, installed.skillCount);
        for (const candidate of snapshot.skills) {
          const loaded = await ctx.skills.get(candidate.name, { cwd: lookupCwd, signal });
          assert.equal(loaded.source, expectedSource, "The official registry must select the expected scope");
          assert.equal(loaded.resourceBase.path, path.join(expectedRoot, loaded.name));
          names.push(loaded.name);
          assert.ok(loaded.content.length <= contract.skillBodyMaxCharacters);
          const rendered = [{ type: "text", text: renderSkillContent(loaded) }];
          maxLoaderCharacters = Math.max(maxLoaderCharacters, ctx.toolResultPruner.measureContent(rendered));
          assert.equal(ctx.toolResultPruner.pruneContent(rendered), null, `The rendered Skill loader was pruned: ${loaded.name}`);
          const methodPath = path.join(loaded.resourceBase.path, "method.json");
          if (!fs.existsSync(methodPath)) { assert.equal(loaded.name, "kim-service"); continue; }
          const method = JSON.parse(await readNative(methodPath));
          primaryMethodPartsRead += await readIndex(path.resolve(loaded.resourceBase.path, method.partsIndex));
          assert.equal(sha(fs.readFileSync(path.resolve(loaded.resourceBase.path, method.original))), method.sourceSha256);
          for (const key of ["capabilityContractIndex", "componentMethodIndex"]) if (method[key]) await readIndex(path.resolve(loaded.resourceBase.path, method[key]));
        }
        return { ok: true, count: names.length, skillNames: names.sort(), primaryMethodPartsRead, maxLoaderCharacters, source: expectedSource, registrySelectionVerified: true };
      } finally { unregister(); await provider.dispose(); }
    };
    const nativeSkillProvider = await inspectNativeSkills("user-dsh", path.join(dshHome, "skills"));
    const skillNames = nativeSkillProvider.skillNames;
    assert.ok(skillNames.includes("meta-theory"));
    if (servicePackage) assert.ok(skillNames.includes("kim-service"));

    fs.mkdirSync(path.join(cwd, ".git"));
    const nestedProject = path.join(cwd, "nested-project"); fs.mkdirSync(nestedProject);
    const nestedAttempt = spawnSync(process.execPath, [packedCli, "dsh", "install", "--scope", "project", "--project-root", nestedProject, "--no-mcp", "--json"], { env, cwd, encoding: "utf8", timeout: 30000 });
    assert.equal(nestedAttempt.status, 1); assert.match(nestedAttempt.stderr, /discovers project Skills from/u);
    assert.equal(fs.existsSync(path.join(nestedProject, ".dsh")), false);
    const projectArgs = ["--scope", "project", "--project-root", cwd];
    const projectInstalled = JSON.parse(invoke(packedCli, ["dsh", "install", ...projectArgs, ...serviceArgs, "--json"]));
    assert.equal(projectInstalled.ok, true); assert.equal(projectInstalled.mcpConfigured, true);
    assert.deepEqual(projectInstalled.launchEnvironment, {});
    const projectChecked = JSON.parse(invoke(packedCli, ["dsh", "check", ...projectArgs, "--json"]));
    assert.equal(projectChecked.status, "verified_files"); assert.equal(projectChecked.mcpConfigured, true);
    const projectUpdated = JSON.parse(invoke(packedCli, ["dsh", "update", ...projectArgs, ...serviceArgs, "--json"]));
    assert.equal(projectUpdated.status, "noop");
    const projectDump = invoke(path.join(path.dirname(nativeManifestPath), "lib/bin.js"), [...projectInstalled.launch.slice(1), "--dump-config"]);
    fs.writeFileSync(path.join(temp, "native-project-config.yml"), projectDump);
    assert.match(projectDump, /meta-kim-mcp/u); assert.match(projectDump, /@deepseek-ai\/dsh-mcp-client/u);
    const projectNativeSkills = await inspectNativeSkills("project-dsh", path.join(cwd, ".dsh/skills"), nestedProject);
    assert.deepEqual(projectNativeSkills.skillNames, skillNames);
    for (const ledgerRoot of [home, cwd]) {
      const ledger = readJson(path.join(ledgerRoot, ".meta-kim/install-manifest.json"));
      for (const entry of ledger.entries) if (entry.source === "dsh-profile-package.mjs" && entry.path.endsWith(".dsh-parts/index.json")) await readIndex(entry.path);
    }
    assert.ok(jsonResourceCount > 0, "Structured method contracts must be included in native read validation");
    const unboundedArgs = { file_path: largestJson.file };
    const unbounded = await readTool.execute(unboundedArgs, { signal: AbortSignal.timeout(10000) });
    assert.notEqual(ctx.toolResultPruner.pruneContent(readTool.output.render(unboundedArgs, unbounded)), null, "The real native pruner must expose the unsafe original large-JSON control");
    let originalLargeCodeControlWasPruned = null;
    if (servicePackage) assert.ok(codeResourceCount > 0, "Professional executable validators need the same complete source-read protection");
    if (largestCode && largestCode.size > 8192) {
      const codeArgs = { file_path: largestCode.file };
      const codeRead = await readTool.execute(codeArgs, { signal: AbortSignal.timeout(10000) });
      originalLargeCodeControlWasPruned = ctx.toolResultPruner.pruneContent(readTool.output.render(codeArgs, codeRead)) !== null;
      assert.equal(originalLargeCodeControlWasPruned, true, "The original long-code control must demonstrate why bounded source views are needed");
    }

    // Only registry/context and local MCP plugins: no agent loop or model plugin.
    await ctx.plugin(McpResources);
    const patch = readJson(path.join(dshHome, `profiles/${contract.profileName}/cordis.patch.yml`));
    const mcpConfig = patch[0].insert[0].config;
    assert.deepEqual(readJson(path.join(cwd, ".dsh/meta-kim/cordis.patch.yml"))[0].insert[0].config, mcpConfig);
    assert.equal(mcpConfig.command, process.execPath);
    assert.deepEqual(mcpConfig.args, [path.join(stable.packageRoot, "scripts/mcp/meta-runtime-server.mjs")]);
    await ctx.plugin(Mcp, mcpConfig);
    const definitions = ctx.tools.definitions();
    const toolNames = definitions.map((item) => item.name).filter((name) => name.startsWith(`mcp__${contract.mcpServerName}__`) || ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(name));
    const signal = AbortSignal.timeout(10000);
    const agents = await definitions.find((item) => item.name === "mcp__meta-kim-runtime__list_meta_agents").execute({}, { signal });
    assert.match(agents.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"), /meta-conductor/u);
    const resources = await definitions.find((item) => item.name === "list_mcp_resources").execute({ server: contract.mcpServerName }, { signal });
    assert.ok(resources.resources.some((item) => item.uri === "meta://skill/meta-theory"));
    const resource = await definitions.find((item) => item.name === "read_mcp_resource").execute({ server: contract.mcpServerName, uri: "meta://skill/meta-theory" }, { signal });
    assert.match(resource.contents[0].text, /Meta-Theory/u);
    await ctx.fiber.dispose(); ctx = null;

    const projectRemoved = JSON.parse(invoke(packedCli, ["dsh", "uninstall", ...projectArgs, "--json"]));
    assert.equal(projectRemoved.ok, true);
    assert.equal(JSON.parse(invoke(packedCli, ["dsh", "check", ...projectArgs, "--json"], [1])).status, "not_installed");
    assert.equal(JSON.parse(invoke(packedCli, ["dsh", "check", "--json"])).status, "verified_files", "Project removal must preserve the complete global installation");
    const removed = JSON.parse(invoke(packedCli, ["dsh", "uninstall", "--json"])); assert.equal(removed.ok, true);
    assert.equal(JSON.parse(invoke(packedCli, ["dsh", "check", "--json"], [1])).status, "not_installed");
    const reinstalled = JSON.parse(invoke(packedCli, ["dsh", "install", ...serviceArgs, "--json"])); assert.equal(reinstalled.ok, true);
    assert.equal(JSON.parse(invoke(packedCli, ["dsh", "check", "--json"])).status, "verified_files");
    const report = {
      schemaVersion: 1, observedAt: new Date().toISOString(), evidenceKind: "native-host-loading-and-mcp",
      upstream: { repository: contract.upstream, revision: contract.sourceRevision, version: nativeManifest.version },
      nodeVersion: process.version, modelCalls: 0, nativeModelExecutionVerified: false,
      isolation: { entireNativeWorkerInChildProcess: true, homeVerified: true, environmentAllowlistVerified: true, networkTransportOnlyDuringPackageProvisioning: true, modelProviderMounted: false },
      nativeDelegationVerified: false, nativeHookEnforcement: false, nativeStageRunner: false, businessQualityAccepted: false,
      immutablePackageTarballSha256: stable.packageTarballSha256,
      implementationSha256: Object.fromEntries(["scripts/dsh-profile-package.mjs", "bin/meta-kim.mjs", "canonical/runtime-assets/dsh/host-contract.json"].map((file) => [file, sha(fs.readFileSync(path.join(stable.packageRoot, file)))])),
      ...(servicePackage ? { servicePackageManifestSha256: sha(fs.readFileSync(path.join(path.resolve(servicePackage), "dsh-package.json"))), serviceComponents: readJson(path.join(path.resolve(servicePackage), "dsh-package.json")).componentCount } : {}),
      packedCliLifecycle: { install: reinstalled.status, update: updated.status, check: checked.status, uninstall: removed.status, reinstalled: true },
      packedProjectCliLifecycle: { install: projectInstalled.status, update: projectUpdated.status, check: projectChecked.status, uninstall: projectRemoved.status, globalPreservedAfterProjectRemoval: true, nestedGitRootMismatchRejectedBeforeWrite: true },
      nativeCliConfig: { ok: true, bytes: Buffer.byteLength(dump) },
      nativeSkillProvider,
      projectNativeCliConfig: { ok: true, bytes: Buffer.byteLength(projectDump), mcpMatchesVerifiedConnection: true, userHomePreserved: true },
      projectNativeSkills: { ...projectNativeSkills, nestedWorkingDirectoryRootSelectionVerified: true },
      nativeReadAndPruning: { ok: true, resourceCount: indexCache.size, partCount: nativePartReads, jsonResourceCount, codeResourceCount, maxRenderedCharacters, prunedBoundedResults: 0, originalLargeJsonControlWasPruned: true, originalLargeCodeControlWasPruned },
      nativeMcpPlugin: { ok: true, toolNames, resourceUris: resources.resources.map((item) => item.uri), canonicalSkillBytes: Buffer.byteLength(resource.contents[0].text) },
      ...(keepArtifacts ? { artifactsPath: temp } : {}),
    };
    fs.writeFileSync(path.join(temp, "probe-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally { if (ctx) await ctx.fiber.dispose(); }
}

async function main(argv) {
  if (argv[0] === "--native-worker") {
    if (argv.length !== 2) throw new Error("Invalid isolated native worker payload");
    await nativeWorker(JSON.parse(argv[1]));
    return;
  }
  if (!argv.length || argv.includes("--help")) { console.log("node tests/setup/dsh-native-host-probe.mjs --dsh-root /path/to/npm/environment [--service-package /path/to/package] [--report /path/to/report.json] [--keep-artifacts]\nUses an installed pinned official DSh package, isolated HOME, actual packed CLI/config/Skills/MCP. No model calls."); return; }
  const options = {}; let reportPath;
  const flags = new Map([["--dsh-root", "dshRoot"], ["--service-package", "servicePackage"]]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--keep-artifacts") options.keepArtifacts = true;
    else if (flags.has(flag) || flag === "--report") {
      const value = argv[++index]; if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      if (flag === "--report") reportPath = path.resolve(value); else options[flags.get(flag)] = path.resolve(value);
    } else throw new Error(`Unknown option: ${flag}`);
  }
  const report = await probeNativeDsh(options);
  if (reportPath) fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(`DSh native probe: ${error.stack ?? error.message}`); process.exitCode = 1; });
}
