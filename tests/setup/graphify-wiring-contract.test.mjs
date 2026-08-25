import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { enrichMetaKimGraph } from "../../scripts/graphify-enrichment.mjs";
import { applyGraphNodeIdentityProof } from "../../scripts/graphify-node-identity.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

function writeFakeExecutable(dir, name, source) {
  const scriptPath = path.join(dir, `${name}.mjs`);
  writeFileSync(scriptPath, source);

  if (process.platform === "win32") {
    const cmdPath = path.join(dir, `${name}.cmd`);
    writeFileSync(cmdPath, `@echo off\r\nnode "%~dp0${name}.mjs" %*\r\n`);
    return cmdPath;
  }

  const binPath = path.join(dir, name);
  writeFileSync(binPath, `#!/usr/bin/env node\nimport "./${name}.mjs";\n`);
  chmodSync(binPath, 0o755);
  return binPath;
}

describe("graphify idempotent wiring (contract)", () => {
  test("graphify-cli.mjs invokes hook install after claude install", () => {
    const src = readFileSync(
      path.join(root, "scripts/graphify-cli.mjs"),
      "utf8",
    );
    const claudeIdx = src.indexOf('["-m", "graphify", "claude", "install"]');
    const hookIdx = src.indexOf('["-m", "graphify", "hook", "install"]');
    assert.notEqual(claudeIdx, -1);
    assert.notEqual(hookIdx, -1);
    assert.ok(hookIdx > claudeIdx, "hook install must follow claude install");
    assert.match(src, /sanitizeGraphifyHookSettings\(resolveGraphifyExecutable\(python\)\)/);
    assert.match(src, /path\.join\(homedir\(\), "\.claude", "settings\.json"\)/);
    assert.match(src, /sanitizeGraphifyWindowsHooks\(target, \{ graphifyExecutable \}\)/);
  });

  test("graphify-cli.mjs uses full extract for identity migration and update afterwards", () => {
    const src = readFileSync(
      path.join(root, "scripts/graphify-cli.mjs"),
      "utf8",
    );

    assert.match(src, /function runRebuild\(\)/);
    assert.match(
      src,
      /\[\s*"extract",\s*"\.",\s*"--force",\s*\.\.\.\(migrationCodeOnly \? \["--code-only"\] : migrationBackendArgs\),?\s*\]/,
    );
    assert.match(src, /\["update", "\."\]/);
    assert.match(src, /graphIdentityMigrationPlan\(/);
    assert.match(src, /GRAPHIFY_MIGRATION_STATE_SCHEMA/);
    assert.match(src, /\["--backend", "claude-cli"\]/);
    assert.match(src, /META_KIM_GRAPHIFY_MIGRATION_BACKEND/);
    assert.match(src, /\[\s*"cluster-only",\s*"\.",\s*\.\.\.migrationBackendArgs\]/);
    assert.match(src, /disambiguateGraphFileNodeLabels\(graph, \{/);
    assert.match(src, /finalGraphStats\.nodes\.toLocaleString\("en-US"\)/);
    const prepareIdx = src.lastIndexOf("writeMigrationState(plan.paths, plan.repository, \"extract_complete\")");
    const clusterIdx = src.lastIndexOf('"cluster-only", ".", ...migrationBackendArgs');
    const stampIdx = src.lastIndexOf("if (!stampGraphFreshness(");
    assert.ok(prepareIdx > 0 && prepareIdx < clusterIdx);
    assert.ok(clusterIdx < stampIdx);
    assert.match(src, /spawnSync\(launcher\.command, \[\.\.\.launcher\.args, \.\.\.graphifyArgs\]/);
    assert.match(src, /\["-m", "graphify", \.\.\.graphifyArgs\]/);
    assert.match(src, /case "rebuild":/);
  });

  test("graphify-cli.mjs forwards query/path/explain to the graphify CLI", () => {
    const src = readFileSync(path.join(root, "scripts/graphify-cli.mjs"), "utf8");

    assert.match(src, /function runGraphifyPassthrough\(\)/);
    assert.match(src, /const graphifyArgs = process\.argv\.slice\(2\)/);
    assert.match(src, /spawnSync\(launcher\.command, \[\.\.\.launcher\.args, \.\.\.graphifyArgs\]/);
    assert.match(src, /direct\.status \?\? 1/);
    assert.match(src, /\["-m", "graphify", \.\.\.graphifyArgs\]/);
    assert.match(src, /case "query":/);
    assert.match(src, /case "path":/);
    assert.match(src, /case "explain":/);
  });

  test("graphify-cli.mjs can forward --force for intentional smaller rebuilds", () => {
    const src = readFileSync(
      path.join(root, "scripts/graphify-cli.mjs"),
      "utf8",
    );

    assert.match(src, /process\.argv\.includes\("--force"\)/);
    assert.match(src, /graphifyArgs\.push\("--force"\)/);
  });

  test("graphify rebuild retries with --force when graphify refuses a smaller graph", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "meta-kim-graphify-"));
    const bin = path.join(tmp, "bin");
    const repo = path.join(tmp, "repo");
    mkdirSync(bin);
    mkdirSync(path.join(repo, "graphify-out"), { recursive: true });

    const fakeGraphify = `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const statePath = path.join(process.cwd(), ".fake-graphify-state");
const forced = args.includes("--force");
if (args[0] === "cluster-only" && args[1] === ".") {
  process.exit(0);
}
if (args[0] !== "update" || args[1] !== ".") {
  process.exit(9);
}
if (!forced && !existsSync(statePath)) {
  writeFileSync(statePath, "refused");
  console.error("Refusing to overwrite — you may be missing chunk files from a previous session. Pass --force to override.");
  process.exit(1);
}
mkdirSync(path.join(process.cwd(), "graphify-out"), { recursive: true });
const head = readFileSync(path.join(process.cwd(), ".git", "HEAD"), "utf8").trim();
writeFileSync(
  path.join(process.cwd(), "graphify-out", "GRAPH_REPORT.md"),
  "# Graph Report\\n\\n## Summary\\n- 1 nodes · 0 edges · 0 communities\\n\\n## Graph Freshness\\n- Built from commit: \`0000000\`\\n",
);
writeFileSync(
  path.join(process.cwd(), "graphify-out", "graph.json"),
  JSON.stringify({
    nodes: [{
      id: "tracked_txt",
      label: "tracked.txt",
      source_file: "tracked.txt",
      source_location: "L1",
      file_type: "document",
      type: "document",
      _origin: "ast",
    }],
    links: [],
    built_at_commit: head,
  }) + "\\n",
);
console.log("forced rebuild ok");
`;
    writeFakeExecutable(bin, "graphify", fakeGraphify);
    const graphifyScript = path.join(bin, "graphify.mjs");

    for (const args of [
      ["init"],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Test User"],
    ]) {
      const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    writeFileSync(path.join(repo, ".gitignore"), "graphify-out/\n.fake-graphify-state\n");
    writeFileSync(path.join(repo, "tracked.txt"), "fresh head\n");
    for (const args of [
      ["add", ".gitignore", "tracked.txt"],
      ["commit", "-m", "seed"],
    ]) {
      const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    writeFileSync(
      path.join(repo, "graphify-out", "GRAPH_REPORT.md"),
      "# Graph Report\n\n## Summary\n- 1 nodes · 0 edges · 0 communities\n\n## Graph Freshness\n- Built from commit: `aaaaaaaa`\n",
    );
    const initialGraph = {
      nodes: [{
        id: "tracked_txt",
        label: "tracked.txt",
        source_file: "tracked.txt",
        source_location: "L1",
        file_type: "document",
        type: "document",
        _origin: "ast",
      }],
      links: [],
      built_at_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim();
    applyGraphNodeIdentityProof(initialGraph, {
      trackedFiles: [".gitignore", "tracked.txt"],
      builtCommit: head,
    });
    writeFileSync(
      path.join(repo, "graphify-out", "graph.json"),
      JSON.stringify(initialGraph),
    );

    try {
      const result = spawnSync(
        process.execPath,
        [path.join(root, "scripts", "graphify-cli.mjs"), "rebuild"],
        {
          cwd: repo,
          encoding: "utf8",
          env: {
            ...process.env,
            META_KIM_GRAPHIFY_BIN: process.execPath,
            META_KIM_GRAPHIFY_BIN_ARGS: graphifyScript,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            Path: `${bin}${path.delimiter}${process.env.Path ?? ""}`,
          },
        },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /Refusing to overwrite/);
      assert.match(result.stderr, /retrying with --force/);
      assert.match(result.stdout, /forced rebuild ok/);

      const head = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: repo,
        encoding: "utf8",
      }).stdout.trim();
      const graph = JSON.parse(
        readFileSync(path.join(repo, "graphify-out", "graph.json"), "utf8"),
      );
      assert.equal(graph.built_at_commit, head);
      assert.match(
        readFileSync(path.join(repo, "graphify-out", "GRAPH_REPORT.md"), "utf8"),
        new RegExp(head),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("graphify-cli.mjs stamps freshness metadata after successful rebuild", () => {
    const src = readFileSync(
      path.join(root, "scripts/graphify-cli.mjs"),
      "utf8",
    );
    const rebuildIdx = src.indexOf("function runRebuild()");
    assert.notEqual(rebuildIdx, -1);
    const rebuildBody = src.slice(rebuildIdx);

    assert.match(src, /function stampGraphFreshness\(/);
    assert.match(src, /graph\.built_at_commit = repository\.currentHead/);
    assert.match(src, /enrichMetaKimGraph\(graph\)/);
    assert.ok(src.includes("Built from commit:\\s*`?([0-9a-f]{7,40})`?"));
    assert.match(
      rebuildBody,
      /stampGraphFreshness\(\s*plan\.repository\.repoRoot,/u,
    );
  });

  test("graphify enrichment adds Meta_Kim agent governance edges and node type aliases", () => {
    const graph = {
      nodes: [
        {
          id: "agents_meta_warden",
          source_file: "canonical/agents/meta-warden.md",
          file_type: "document",
        },
        {
          id: "agents_meta_conductor",
          source_file: "canonical/agents/meta-conductor.md",
          file_type: "document",
        },
        { id: "canonical/agents/meta-prism.md", file_type: "document" },
        { id: "canonical/agents/meta-chrysalis.md", file_type: "document" },
        { id: "canonical/agents/meta-artisan.md", file_type: "document" },
        { id: "canonical/agents/meta-librarian.md", file_type: "document" },
        { id: "canonical/agents/meta-sentinel.md", file_type: "document" },
        { id: "canonical/agents/meta-genesis.md", file_type: "document" },
        { id: "canonical/agents/meta-scout.md", file_type: "document" },
      ],
      links: [],
    };

    const result = enrichMetaKimGraph(graph);

    assert.equal(result.changed, true);
    assert.ok(result.addedAgentGovernanceEdges >= 8);
    assert.equal(graph.nodes[0].type, "document");
    assert.ok(
      graph.links.some(
        (edge) =>
          edge.source === "agents_meta_warden" &&
          edge.target === "agents_meta_conductor" &&
          edge.relation === "governs" &&
          edge.kind === "agent_governance",
      ),
    );
  });

  test("package exposes a cross-platform graphify rebuild script", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    );

    assert.equal(
      pkg.scripts["meta:graphify:rebuild"],
      "node scripts/graphify-cli.mjs rebuild",
    );
  });

  test("AGENTS uses the cross-platform graphify rebuild script", () => {
    const src = readFileSync(path.join(root, "AGENTS.md"), "utf8");

    assert.match(src, /npm run meta:graphify:rebuild/);
    assert.doesNotMatch(src, /python3 -c "from graphify\.watch/);
  });

  test("setup.mjs installPythonTools wires graphify for all activeTargets", () => {
    const lines = readFileSync(path.join(root, "setup.mjs"), "utf8").split(
      /\r?\n/,
    );
    const start = lines.findIndex((l) =>
      l.includes("async function installPythonTools("),
    );
    const end = lines.findIndex(
      (l, i) => i > start && l.startsWith("// ── Step 4.6:"),
    );
    assert.ok(start !== -1 && end !== -1, "installPythonTools body not found");
    const body = lines.slice(start, end).join("\n");
    assert.match(body, /\["-m", "graphify", "hook", "install"\]/);
    assert.match(body, /for \(const target of expandGraphifyTargets\(activeTargets\)\)/);
    assert.match(
      body,
      /\["-m", "graphify", "[a-z]+", "install"\]/,
      "per-platform graphify install present",
    );
    assert.match(
      body,
      /\["-m", "graphify", "update", "\."\]/,
      "install should generate the local graph once after wiring graphify",
    );
    // pip install failure must NOT return early (skill install still needs to run)
    const afterPip = body.split(/pip install.*graphifyy.*\]/s)[1] || "";
    assert.doesNotMatch(
      afterPip.slice(0, 120),
      /^\s*return;/m,
      "no early return right after already-installed ok()",
    );
  });

  test("setup.mjs installPythonTools can wire graphify in a final project directory", () => {
    const src = readFileSync(path.join(root, "setup.mjs"), "utf8");

    assert.match(
      src,
      /async function installPythonTools\(\s*activeTargets,\s*inUpdateMode = false,\s*targetDir = PROJECT_DIR,\s*options = \{\},\s*\)/,
    );
    assert.match(src, /const graphifyDir = resolve\(targetDir\)/);
    assert.match(src, /join\(graphifyDir, "\.git"\)/);
    assert.doesNotMatch(src, /guideAlreadyHasGraphifySection\(platform, graphifyDir\)/);
    assert.match(
      src,
      /runPythonModule\(\s*python,\s*\["-m", "graphify", "hook", "install"\],[\s\S]*?\{ cwd: graphifyDir, stdio: "pipe" \}/,
    );
    assert.match(
      src,
      /runPythonModule\(\s*python,\s*\["-m", "graphify", platform, "install"\],[\s\S]*?\{ cwd: graphifyDir, stdio: "pipe" \}/,
    );
    assert.match(
      src,
      /runPythonModule\(\s*python,\s*\["-m", "graphify", "update", "\."\],[\s\S]*?\{ cwd: graphifyDir, stdio: "pipe" \}/,
    );
  });

  test("setup deploy export uses global post-copy initializer", () => {
    const src = readFileSync(path.join(root, "setup.mjs"), "utf8");
    const start = src.indexOf("async function copyToDeployDir(");
    const end = src.indexOf("async function runQuickDeploy()", start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    const body = src.slice(start, end);
    const applyStart = src.indexOf("async function applyProjectBootstrapToDir(");
    const applyEnd = src.indexOf("function classifyProjectBootstrapError", applyStart);
    assert.notEqual(applyStart, -1);
    assert.notEqual(applyEnd, -1);
    const applyBody = src.slice(applyStart, applyEnd);

    assert.match(body, /applyProjectBootstrapToDir\(activeTargets, targetDir\)/);
    assert.match(body, /sanitizeGraphifyWindowsHooks\([\s\S]*?join\(targetDir, "\.claude", "settings\.json"\)/);
    assert.doesNotMatch(applyBody, /writePostCopyBootstrap\(targetDir, activeTargets\)/);
    assert.match(applyBody, /projectBootstrapTransactionalPlan\(plan, targetDir, backup\)/);
    assert.match(applyBody, /executeSafeManagedFileTransaction\(\{/);
    assert.match(applyBody, /transactionLabel: "project-bootstrap-apply"/);
    assert.match(body, /printPostCopyBootstrapHint\(\)/);
    assert.doesNotMatch(body, /installGraphify/);
    assert.doesNotMatch(body, /installPythonTools\(activeTargets, false, targetDir\)/);
    assert.match(src, /function collectProjectDeployPlan\(activeTargets, targetDir\)/);
  });

  test("install and update deploy exports do not treat the staging directory as the final graphify root", () => {
    const src = readFileSync(path.join(root, "setup.mjs"), "utf8");
    const installStart = src.indexOf("async function runInstall()");
    const updateStart = src.indexOf("async function runUpdate()");
    const checkStart = src.indexOf("async function runCheck()", updateStart);
    assert.notEqual(installStart, -1);
    assert.notEqual(updateStart, -1);
    assert.notEqual(checkStart, -1);
    const installBody = src.slice(installStart, updateStart);
    const updateBody = src.slice(updateStart, checkStart);

    for (const body of [installBody, updateBody]) {
      assert.doesNotMatch(body, /pythonToolsEnabled/);
      assert.doesNotMatch(body, /installGraphify/);
      assert.match(body, /copyToDeployDirs\(activeTargets, deployDirs\)/);
    }
  });

  test("quick deploy does not copy post-copy executable into the project", () => {
    const src = readFileSync(path.join(root, "setup.mjs"), "utf8");
    const start = src.indexOf("async function runQuickDeploy()");
    const end = src.indexOf("// ── Install scope selection", start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    const body = src.slice(start, end);

    assert.doesNotMatch(body, /writePostCopyBootstrap\(targetDir, \[platformId\]\)/);
    assert.doesNotMatch(body, /installPythonTools\([\s\S]*?targetDir/);
    assert.ok(
      body.includes("deployPlatformFiles(platformId, targetDir)"),
      "quick deploy must still copy target runtime entry/config files",
    );
  });

  test("global post-copy initializer writes graphify outputs in the current project root", () => {
    const body = readFileSync(
      path.join(root, "scripts", "project-post-copy-init.mjs"),
      "utf8",
    );

    assert.match(body, /const rootDir = resolveProjectRoot\(\{/);
    assert.match(body, /\["-m", "pip", "show", "graphifyy"\]/);
    assert.match(body, /\["-m", "pip", "install", "graphifyy"\]/);
    assert.match(body, /\["-m", "graphify", "hook", "install"\]/);
    assert.match(body, /sanitizeGraphifyWindowsHooks\([\s\S]*?join\(rootDir, "\.claude", "settings\.json"\)/);
    assert.match(body, /\["-m", "graphify", platform, "install"\]/);
    assert.match(body, /\["-m", "graphify", "update", "\."\]/);
    assert.match(body, /process\.argv\.includes\("--auto"\)/);
    assert.match(body, /process\.argv\.includes\("--auto-worker"\)/);
    assert.match(body, /post-copy-init\.json/);
    assert.match(body, /spawn\(process\.execPath, \[scriptPath, "--auto-worker"\]/);
    assert.match(body, /detached: true/);
    assert.match(body, /failedRetryMs/);
    // CLAUDE_PROJECT_DIR (the runtime's project env) is allowed; this only
    // guards against setup.mjs's PROJECT_DIR staging global.
    assert.doesNotMatch(body, /(?<![A-Za-z0-9_])PROJECT_DIR\b/);
  });

  test("meta-theory activation hook starts post-copy auto-init without blocking startup", () => {
    const src = readFileSync(
      path.join(root, "canonical/runtime-assets/shared/hooks/activate-meta-theory-spine.mjs"),
      "utf8",
    );
    const claudeSettings = readFileSync(
      path.join(root, "canonical/runtime-assets/claude/settings.json"),
      "utf8",
    );

    assert.match(src, /project-post-copy-init\.mjs/);
    assert.match(src, /--package-root/);
    assert.match(src, /spawnSync\(process\.execPath, \[scriptPath, "--auto", "--project-root", root\]/);
    assert.match(src, /timeout: 4000/);
    assert.match(src, /stdio: "ignore"/);
    assert.match(src, /META_KIM_POST_COPY_AUTO === "off"/);
    assert.match(src, /catch \{\s*\/\/ Post-copy auto-init is opportunistic/s);
    assert.match(src, /critical_fetch_thinking_review_requested/);
    assert.match(src, /natural_language_durable_work/);
    assert.match(claudeSettings, /"UserPromptSubmit"/);
    assert.match(claudeSettings, /activate-meta-theory-spine\.mjs/);
    assert.doesNotMatch(src, /projectBootstrapProbe/);
    assert.doesNotMatch(src, /project-bootstrap-daily-probe\.json/);
    assert.doesNotMatch(src, /packageUpdateReminderFlag/);
    assert.doesNotMatch(src, /META_KIM_UPDATE_REMINDER_DAYS/);
    assert.doesNotMatch(src, /additionalContext/);
    assert.doesNotMatch(src, /decision: "block"/);
    assert.doesNotMatch(src, /suppressOriginalPrompt: false/);
    assert.doesNotMatch(src, /"--apply"/);
  });

  test("meta-theory activation hook launches global post-copy initializer for current project", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-post-copy-auto-"));
    const packageRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-package-root-"));
    try {
      // A real session runs the hook from a project root; mark tempDir so the
      // project-root gate activates here instead of skipping a bare temp dir.
      mkdirSync(path.join(tempDir, ".git"), { recursive: true });
      const globalScript = path.join(packageRoot, "scripts", "project-post-copy-init.mjs");
      mkdirSync(path.dirname(globalScript), { recursive: true });
      writeFileSync(
        globalScript,
        [
          'import { mkdirSync, writeFileSync } from "node:fs";',
          'import { join } from "node:path";',
          'const rootArg = process.argv.indexOf("--project-root");',
          'const declaredRoot = rootArg >= 0 ? process.argv[rootArg + 1] : null;',
          'if (!declaredRoot) process.exit(2);',
          'const stateDir = join(declaredRoot, ".meta-kim", "state", "default");',
          'mkdirSync(stateDir, { recursive: true });',
          'writeFileSync(join(stateDir, "post-copy-init.json"), JSON.stringify({ status: "stubbed", declaredRoot }) + "\\n");',
        ].join("\n"),
        "utf8",
      );
      const hookPath = path.join(
        root,
        "canonical/runtime-assets/shared/hooks/activate-meta-theory-spine.mjs",
      );
      const result = spawnSync(process.execPath, [hookPath, "--package-root", packageRoot], {
        cwd: tempDir,
        input: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          prompt: "critical and fetch thinking and review 初始化这个项目",
        }),
        encoding: "utf8",
        timeout: 120_000,
        windowsHide: true,
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(
        existsSync(path.join(tempDir, ".meta-kim", "state", "default", "post-copy-init.json")),
        true,
      );
      const marker = JSON.parse(
        readFileSync(
          path.join(tempDir, ".meta-kim", "state", "default", "post-copy-init.json"),
          "utf8",
        ),
      );
      assert.equal(path.resolve(marker.declaredRoot), path.resolve(tempDir));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  test("meta-theory activation hook starts spine without project bootstrap automation", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-activation-no-write-"));
    try {
      // Mark tempDir a project root so the spine activates here (this test
      // asserts spine-state is written but no project-bootstrap.json).
      mkdirSync(path.join(tempDir, ".git"), { recursive: true });
      const hookPath = path.join(
        root,
        "canonical/runtime-assets/shared/hooks/activate-meta-theory-spine.mjs",
      );
      const result = spawnSync(process.execPath, [hookPath], {
        cwd: tempDir,
        input: JSON.stringify({
          tool_name: "Skill",
          tool_input: { skill_name: "meta-theory" },
        }),
        encoding: "utf8",
        timeout: 120_000,
        windowsHide: true,
        env: {
          ...process.env,
          META_KIM_PACKAGE_ROOT: root,
          META_KIM_POST_COPY_AUTO: "off",
        },
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(
        existsSync(path.join(tempDir, ".meta-kim", "state", "default", "spine", "spine-state.json")),
        true,
      );
      assert.equal(
        existsSync(path.join(tempDir, ".meta-kim", "state", "default", "project-bootstrap.json")),
        false,
      );
      assert.equal(result.stdout.trim(), "");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("bootstrap probe off still allows prompt-entry spine activation", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-probe-off-spine-"));
    const globalStateDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-probe-off-state-"));
    try {
      // Mark tempDir a project root so prompt-entry spine activation writes
      // spine-state here (probe-off must not suppress legitimate activation).
      mkdirSync(path.join(tempDir, ".git"), { recursive: true });
      const hookPath = path.join(
        root,
        "canonical/runtime-assets/shared/hooks/activate-meta-theory-spine.mjs",
      );
      const result = spawnSync(process.execPath, [hookPath, "--package-root", root], {
        cwd: tempDir,
        input: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          prompt:
            "critical and fetch thinking and review 帮我修复项目入口，完成后实机测试、提交、推送、发布新版本",
        }),
        encoding: "utf8",
        timeout: 120_000,
        windowsHide: true,
        env: {
          ...process.env,
          META_KIM_PROJECT_BOOTSTRAP_PROBE: "off",
          META_KIM_GLOBAL_STATE_DIR: globalStateDir,
          META_KIM_POST_COPY_AUTO: "off",
        },
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stdout.trim(), "");
      assert.equal(existsSync(path.join(tempDir, ".meta-kim", "state", "default", "spine", "spine-state.json")), true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(globalStateDir, { recursive: true, force: true });
    }
  });

  test("Meta_Kim source root is not blocked by project bootstrap prompt entry", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-source-root-prompt-"));
    mkdirSync(path.join(tempDir, "canonical", "skills", "meta-theory"), { recursive: true });
    writeFileSync(path.join(tempDir, "package.json"), JSON.stringify({ name: "meta-kim" }));
    writeFileSync(path.join(tempDir, "setup.mjs"), "");
    writeFileSync(path.join(tempDir, "canonical", "skills", "meta-theory", "SKILL.md"), "");
    const hookPath = path.join(
      root,
      "canonical/runtime-assets/shared/hooks/activate-meta-theory-spine.mjs",
    );
    try {
      const result = spawnSync(process.execPath, [hookPath, "--package-root", root], {
        cwd: tempDir,
        input: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          prompt: "critical and fetch thinking and review 帮我修复并验证 Meta_Kim",
        }),
        encoding: "utf8",
        timeout: 120_000,
        windowsHide: true,
        env: {
          ...process.env,
          META_KIM_POST_COPY_AUTO: "off",
        },
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.doesNotMatch(result.stdout, /project bootstrap dry-run found this directory is not ready/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("setup.mjs always lets upstream platform install refresh its Graphify hook", () => {
    const src = readFileSync(path.join(root, "setup.mjs"), "utf8");

    assert.doesNotMatch(src, /guideAlreadyHasGraphifySection/);
    assert.match(src, /\["-m", "graphify", platform, "install"\]/);
  });

  test("install validates deployed artifacts while release validation keeps graphify check", () => {
    const setupSrc = readFileSync(path.join(root, "setup.mjs"), "utf8");
    const childContractSrc = readFileSync(
      path.join(root, "scripts", "node-spawn-config.mjs"),
      "utf8",
    );
    const verifyRunner = readFileSync(
      path.join(root, "scripts", "run-verify-all.mjs"),
      "utf8",
    );

    assert.match(setupSrc, /async function validateInstalledArtifacts/);
    assert.match(setupSrc, /SETUP_NODE_CHILD\.GLOBAL_META_THEORY_SYNC/);
    assert.doesNotMatch(
      setupSrc.slice(
        setupSrc.indexOf("async function validateInstalledArtifacts"),
        setupSrc.indexOf("function printInstallResult"),
      ),
      /SETUP_NODE_CHILD\.PROJECT_VALIDATION/,
    );
    assert.match(
      childContractSrc,
      /\[SETUP_NODE_CHILD\.PROJECT_VALIDATION\][\s\S]*scriptRelative: "scripts\/validate-project\.mjs"[\s\S]*languageOption: true/,
    );
    assert.match(verifyRunner, /meta:graphify:check/);
  });

  test("graphify-out remains a local generated artifact, not a package file", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    );
    const gitignore = readFileSync(path.join(root, ".gitignore"), "utf8");

    assert.doesNotMatch((pkg.files ?? []).join("\n"), /graphify-out/);
    assert.match(gitignore, /^graphify-out\/$/m);
  });

  test("install-global-skills-all-runtimes.mjs calls wiring when pip skip", () => {
    const src = readFileSync(
      path.join(root, "scripts/install-global-skills-all-runtimes.mjs"),
      "utf8",
    );
    const idx = src.indexOf("if (pipShow.status === 0)");
    assert.notEqual(idx, -1);
    const branch = src.slice(idx, idx + 600);
    assert.match(branch, /ensureGraphifyWiring\(\)/);
  });

  test("install-global-skills-all-runtimes.mjs does not let graphify rewrite existing Claude guide wiring", () => {
    const src = readFileSync(
      path.join(root, "scripts/install-global-skills-all-runtimes.mjs"),
      "utf8",
    );
    const idx = src.indexOf("const ensureGraphifyWiring = () =>");
    assert.notEqual(idx, -1);
    const wiring = src.slice(idx, idx + 1000);

    assert.match(src, /function guideAlreadyHasGraphifySection\(platform\)/);
    assert.match(src, /\^##\\s\+graphify\\b\/im/);
    assert.match(wiring, /guideAlreadyHasGraphifySection\("claude"\)/);
    assert.match(wiring, /graphifyInstallSkippedGuideExists\("claude"\)/);
    assert.match(wiring, /\["-m", "graphify", "hook", "install"\]/);
  });

  test("canonical subagent-context treats Graphify as query-first navigation", () => {
    const src = readFileSync(
      path.join(
        root,
        "canonical/runtime-assets/claude/hooks/subagent-context.mjs",
      ),
      "utf8",
    );
    assert.match(src, /GRAPH_REPORT\.md/);
    assert.match(src, /graphify query/);
    assert.match(src, /graphify path/);
    assert.match(src, /graphify explain/);
    assert.match(src, /candidate file anchors/);
    assert.match(src, /verify route-changing claims against source files/);
    assert.match(src, /Never inject full graph\.json or full GRAPH_REPORT\.md/);
    assert.doesNotMatch(src, /compressed codebase context/);
  });

  test("setup embedded graphify hook source stays query-first", () => {
    const src = readFileSync(path.join(root, "setup.mjs"), "utf8");
    const idx = src.indexOf("function buildCodexGraphifyContextHookSource()");
    assert.notEqual(idx, -1);
    const hookSource = src.slice(idx, idx + 1500);

    assert.match(hookSource, /graphify query/);
    assert.match(hookSource, /graphify path/);
    assert.match(hookSource, /graphify explain/);
    assert.match(hookSource, /candidate file anchors/);
    assert.match(hookSource, /verify route-changing claims against source files/);
    assert.match(hookSource, /never inject full graph\.json or full GRAPH_REPORT\.md/);
    assert.doesNotMatch(hookSource, /Read graphify-out\/GRAPH_REPORT\.md/);
  });

  test("graphify check fails when GRAPH_REPORT.md was built from an older HEAD", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "meta-kim-graphify-"));
    const bin = path.join(tmp, "bin");
    const repo = path.join(tmp, "repo");
    mkdirSync(bin);
    mkdirSync(path.join(repo, "graphify-out"), { recursive: true });

    const fakePython = `
const args = process.argv.slice(2).filter((arg) => arg !== "-3");
if (args.includes("--version")) {
  console.log("Python 3.12.0");
  process.exit(0);
}
if (args.join(" ") === "-m pip --version") {
  console.log("pip 24.0");
  process.exit(0);
}
if (args.join(" ") === "-m pip show graphifyy") {
  console.log("Name: graphifyy\\nVersion: 1.2.3");
  process.exit(0);
}
process.exit(1);
`;
    for (const name of ["py", "python", "python3"]) {
      writeFakeExecutable(bin, name, fakePython);
    }
    for (const args of [
      ["init"],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Test User"],
    ]) {
      const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    writeFileSync(path.join(repo, "tracked.txt"), "fresh head\n");
    for (const args of [
      ["add", "tracked.txt"],
      ["commit", "-m", "seed"],
    ]) {
      const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }

    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim();
    assert.notEqual(
      head,
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "test fixture must use a stale graph commit",
    );

    writeFileSync(
      path.join(repo, "graphify-out", "GRAPH_REPORT.md"),
      "# Graph Report\n\n## Graph Freshness\n- Built from commit: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`\n",
    );
    writeFileSync(
      path.join(repo, "graphify-out", "graph.json"),
      JSON.stringify({
        nodes: [{ id: "n1", label: "n1" }],
        links: [{ source: "n1", target: "n1" }],
        built_at_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    );

    try {
      const result = spawnSync(
        process.execPath,
        [path.join(root, "scripts", "graphify-cli.mjs"), "check"],
        {
          cwd: repo,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            Path: `${bin}${path.delimiter}${process.env.Path ?? ""}`,
          },
        },
      );

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Graphify graph\/report is stale or inconsistent/);
      assert.match(result.stderr, /npm run meta:graphify:rebuild/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
