import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { applyGraphNodeIdentityProof } from "../../scripts/graphify-node-identity.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "scripts", "graphify-cli.mjs");

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function initRepo(parent, name) {
  const repo = path.join(parent, name);
  mkdirSync(repo);
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "Test User"]);
  writeFileSync(path.join(repo, ".gitignore"), "graphify-out/\n");
  writeFileSync(path.join(repo, "tracked.txt"), `${name}\n`);
  git(repo, ["add", ".gitignore", "tracked.txt"]);
  git(repo, ["commit", "-m", "seed"]);
  return repo;
}

function writeCommand(dir, name, source) {
  const modulePath = path.join(dir, `${name}.mjs`);
  writeFileSync(modulePath, source);
  if (process.platform === "win32") {
    const commandPath = path.join(dir, `${name}.cmd`);
    writeFileSync(commandPath, `@echo off\r\nnode "%~dp0${name}.mjs" %*\r\n`);
    return commandPath;
  }
  const commandPath = path.join(dir, name);
  writeFileSync(commandPath, `#!/usr/bin/env node\nimport "./${name}.mjs";\n`);
  chmodSync(commandPath, 0o755);
  return commandPath;
}

function fakePythonBin(parent) {
  const bin = path.join(parent, "bin");
  mkdirSync(bin);
  const source = `
const args = process.argv.slice(2).filter((arg) => arg !== "-3");
if (args.includes("--version")) { console.log("Python 3.12.0"); process.exit(0); }
if (args.join(" ") === "-m pip --version") { console.log("pip 24.0"); process.exit(0); }
if (args.join(" ") === "-m pip show graphifyy") { console.log("Name: graphifyy\\nVersion: 0.9.28"); process.exit(0); }
process.exit(1);
`;
  for (const name of ["py", "python", "python3"]) writeCommand(bin, name, source);
  return bin;
}

function proofLine(proof) {
  return `- Meta_Kim node identity: \`${proof.schemaVersion}\` (${proof.status}; ${proof.fileIdentityCount} file nodes; evidence ${proof.evidenceSha256})`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function repositoryStateSha256(repo, repositoryFiles) {
  const digest = createHash("sha256");
  for (const repositoryFile of [...repositoryFiles].sort()) {
    digest.update(repositoryFile);
    digest.update("\0");
    digest.update(sha256(readFileSync(path.join(repo, repositoryFile))));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function writeValidArtifacts(repo) {
  const head = git(repo, ["rev-parse", "HEAD"]);
  const repositoryFiles = spawnSync("git", ["ls-files", "-z"], {
    cwd: repo,
    encoding: "utf8",
  }).stdout.split("\0").filter(Boolean);
  const graph = {
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
  };
  const proof = applyGraphNodeIdentityProof(graph, {
    repositoryFiles,
    repositoryStateSha256: repositoryStateSha256(repo, repositoryFiles),
    builtCommit: head,
  }).proof;
  mkdirSync(path.join(repo, "graphify-out"), { recursive: true });
  writeFileSync(path.join(repo, "graphify-out", "graph.json"), `${JSON.stringify(graph)}\n`);
  writeFileSync(
    path.join(repo, "graphify-out", "GRAPH_REPORT.md"),
    `# Graph Report\n\n## Summary\n- 1 nodes · 0 edges · 0 communities\n\n## Graph Freshness\n- Built from commit: \`${head}\`\n${proofLine(proof)}\n`,
  );
  return { head, graph, proof };
}

function runCheck(repo, bin, env = {}) {
  return spawnSync(process.execPath, [cli, "check"], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      Path: `${bin}${path.delimiter}${process.env.Path ?? ""}`,
      ...env,
    },
  });
}

test("graphify check sanitizes all GIT_* redirects and binds the real cwd repository", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "meta-kim-graphify-git-env-"));
  try {
    const repo = initRepo(temp, "repo-a");
    const poison = initRepo(temp, "repo-b");
    const bin = fakePythonBin(temp);
    writeFileSync(
      path.join(repo, ".gitattributes"),
      "graphify-out/graph.json merge=graphify\n",
    );
    writeValidArtifacts(repo);
    const result = runCheck(repo, bin, {
      GIT_DIR: path.join(poison, ".git"),
      git_work_tree: poison,
      GiT_iNdEx_FiLe: path.join(poison, ".git", "index"),
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /graph and report match HEAD/u);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("graphify check ignores a root Windows CEF debug log during verification", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "meta-kim-graphify-cef-log-"));
  try {
    const repo = initRepo(temp, "repo");
    const bin = fakePythonBin(temp);
    writeFileSync(
      path.join(repo, ".gitignore"),
      `${readFileSync(path.join(repo, ".gitignore"), "utf8")}/debug.log\n`,
    );
    git(repo, ["add", ".gitignore"]);
    git(repo, ["commit", "-m", "ignore machine-local CEF log"]);
    writeValidArtifacts(repo);

    writeFileSync(
      path.join(repo, "debug.log"),
      "[INFO:cefmain_win.cc] Invoking CefInitialize\n",
    );

    assert.equal(git(repo, ["status", "--short"]), "");
    const result = runCheck(repo, bin);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /graph and report match HEAD/u);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("graphify check rejects a current graph paired with an old report and short commit prefixes", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "meta-kim-graphify-report-bind-"));
  try {
    const repo = initRepo(temp, "repo");
    const bin = fakePythonBin(temp);
    const { graph } = writeValidArtifacts(repo);
    const reportPath = path.join(repo, "graphify-out", "GRAPH_REPORT.md");
    writeFileSync(reportPath, readFileSync(reportPath, "utf8").replace(/Built from commit: `[^`]+`/u, "Built from commit: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`"));
    assert.notEqual(runCheck(repo, bin).status, 0);
    writeValidArtifacts(repo);
    writeFileSync(reportPath, readFileSync(reportPath, "utf8").replace(/evidence [a-f0-9]{64}/u, `evidence ${"0".repeat(64)}`));
    assert.notEqual(runCheck(repo, bin).status, 0);
    writeValidArtifacts(repo);
    writeFileSync(reportPath, readFileSync(reportPath, "utf8").replace("- 1 nodes · 0 edges ·", "- 2 nodes · 0 edges ·"));
    assert.notEqual(runCheck(repo, bin).status, 0);
    writeValidArtifacts(repo);
    graph.built_at_commit = git(repo, ["rev-parse", "HEAD"])[0];
    writeFileSync(path.join(repo, "graphify-out", "graph.json"), JSON.stringify(graph));
    assert.notEqual(runCheck(repo, bin).status, 0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("graphify check rejects duplicate or conflicting report truth markers", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "meta-kim-graphify-report-unique-"));
  try {
    const repo = initRepo(temp, "repo");
    const bin = fakePythonBin(temp);
    const { head, proof } = writeValidArtifacts(repo);
    const reportPath = path.join(repo, "graphify-out", "GRAPH_REPORT.md");

    writeFileSync(
      reportPath,
      `${readFileSync(reportPath, "utf8")}- Built from commit: \`${head}\`\n`,
    );
    assert.notEqual(runCheck(repo, bin).status, 0);

    writeValidArtifacts(repo);
    writeFileSync(
      reportPath,
      `${readFileSync(reportPath, "utf8")}- 1 nodes · 0 edges · 0 communities\n`,
    );
    assert.notEqual(runCheck(repo, bin).status, 0);

    writeValidArtifacts(repo);
    writeFileSync(
      reportPath,
      `${readFileSync(reportPath, "utf8")}${proofLine(proof)}\n`,
    );
    assert.notEqual(runCheck(repo, bin).status, 0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("graphify check binds tracked file contents even when HEAD and inventory are unchanged", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "meta-kim-graphify-content-proof-"));
  try {
    const repo = initRepo(temp, "repo");
    const bin = fakePythonBin(temp);
    writeValidArtifacts(repo);
    assert.equal(runCheck(repo, bin).status, 0);
    writeFileSync(path.join(repo, "tracked.txt"), "changed without commit\n");
    const changed = runCheck(repo, bin);
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /node identity is not release-safe/u);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("graphify check rejects private local paths in the report without echoing them", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "meta-kim-graphify-report-private-"));
  try {
    const repo = initRepo(temp, "repo");
    const bin = fakePythonBin(temp);
    writeValidArtifacts(repo);
    const reportPath = path.join(repo, "graphify-out", "GRAPH_REPORT.md");
    writeFileSync(
      reportPath,
      `${readFileSync(reportPath, "utf8")}\nPrivate: path=~/.ssh/id_rsa\n`,
    );
    const result = runCheck(repo, bin);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /private local path/u);
    assert.doesNotMatch(result.stderr, /~\/\.ssh/u);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("graphify check classifies stale sidecar node references instead of failing normalizer binding", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "meta-kim-graphify-sidecar-dangling-"));
  try {
    const repo = initRepo(temp, "repo");
    const bin = fakePythonBin(temp);
    writeValidArtifacts(repo);
    writeFileSync(
      path.join(repo, "graphify-out", ".graphify_analysis.json"),
      JSON.stringify({
        communities: { 0: ["missing_node"] },
        cohesion: { 0: 1 },
        gods: [],
        surprises: [],
        questions: [],
      }),
    );
    const result = runCheck(repo, bin);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /analysis sidecar does not bind exact node IDs/u);
    assert.doesNotMatch(result.stderr, /unbound value/u);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("graphify rebuild refuses a graphify-out junction before an outside file can be touched", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "meta-kim-graphify-junction-"));
  try {
    const repo = initRepo(temp, "repo");
    const outside = path.join(temp, "outside");
    mkdirSync(outside);
    const sentinel = path.join(outside, "graph.json");
    writeFileSync(sentinel, "outside-sentinel\n");
    symlinkSync(outside, path.join(repo, "graphify-out"), process.platform === "win32" ? "junction" : "dir");
    const result = spawnSync(process.execPath, [cli, "rebuild"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, META_KIM_GRAPHIFY_BIN: process.execPath },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsafe repository state|plain repository directory|outside/u);
    assert.equal(readFileSync(sentinel, "utf8"), "outside-sentinel\n");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("graphify rebuild resumes at cluster after an interrupted full extract", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "meta-kim-graphify-resume-"));
  try {
    const repo = initRepo(temp, "repo");
    const head = git(repo, ["rev-parse", "HEAD"]);
    mkdirSync(path.join(repo, "graphify-out"));
    writeFileSync(
      path.join(repo, "graphify-out", "graph.json"),
      JSON.stringify({
        nodes: [{
          id: "legacy_generic",
          label: "tracked.txt",
          source_file: "tracked.txt",
          source_location: "L1",
          type: "code",
          file_type: "code",
          _origin: "ast",
        }],
        links: [],
        built_at_commit: head,
      }),
    );
    writeFileSync(
      path.join(repo, "graphify-out", "GRAPH_REPORT.md"),
      `# Graph Report\n\n## Summary\n- 1 nodes · 0 edges · 0 communities\n\n## Graph Freshness\n- Built from commit: \`${head}\`\n`,
    );
    const statePath = path.join(temp, "calls.json");
    writeFileSync(statePath, JSON.stringify({ extract: 0, cluster: 0, update: 0 }));
    const fake = path.join(temp, "fake-graphify.mjs");
    writeFileSync(fake, `
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const statePath = process.env.FAKE_GRAPHIFY_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const command = args[0];
if (command === "extract") {
  state.extract += 1;
  const head = process.env.FAKE_HEAD;
  const graph = { nodes: [{ id: "tracked", label: "tracked.txt", source_file: "tracked.txt", source_location: "L1", type: "code", file_type: "code", _origin: "ast" }], links: [], built_at_commit: head };
  writeFileSync(path.join(process.cwd(), "graphify-out", "graph.json"), JSON.stringify(graph));
  writeFileSync(path.join(process.cwd(), "graphify-out", "GRAPH_REPORT.md"), "# Graph Report\\n\\n## Summary\\n- 1 nodes · 0 edges · 0 communities\\n\\n## Graph Freshness\\n- Built from commit: " + head + "\\n");
} else if (command === "cluster-only") {
  state.cluster += 1;
  writeFileSync(statePath, JSON.stringify(state));
  if (state.cluster === 1) {
    const graphPath = path.join(process.cwd(), "graphify-out", "graph.json");
    const graph = JSON.parse(readFileSync(graphPath, "utf8"));
    graph.nodes.push({ id: "partial_cluster_concept", label: "partial cluster", type: "concept" });
    writeFileSync(graphPath, JSON.stringify(graph));
    process.exit(17);
  }
} else if (command === "update") {
  state.update += 1;
}
writeFileSync(statePath, JSON.stringify(state));
`);
    const run = () => spawnSync(process.execPath, [cli, "rebuild"], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        META_KIM_GRAPHIFY_BIN: process.execPath,
        META_KIM_GRAPHIFY_BIN_ARGS: fake,
        META_KIM_GRAPHIFY_MIGRATION_BACKEND: "claude-cli",
        FAKE_GRAPHIFY_STATE: statePath,
        FAKE_HEAD: head,
      },
    });
    const first = run();
    assert.equal(first.status, 17, first.stderr || first.stdout);
    assert.equal(existsSync(path.join(repo, "graphify-out", ".meta-kim-node-identity-migration.json")), true);
    const second = run();
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const calls = JSON.parse(readFileSync(statePath, "utf8"));
    assert.deepEqual(calls, { extract: 1, cluster: 2, update: 0 });
    assert.equal(existsSync(path.join(repo, "graphify-out", ".meta-kim-node-identity-migration.json")), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("graphify rebuild re-extracts a safe-looking graph that has no current v2 proof", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "meta-kim-graphify-proof-baseline-"));
  try {
    const repo = initRepo(temp, "repo");
    const head = git(repo, ["rev-parse", "HEAD"]);
    mkdirSync(path.join(repo, "graphify-out"));
    const graph = {
      nodes: [{
        id: "tracked",
        label: "tracked.txt",
        source_file: "tracked.txt",
        source_location: "L1",
        type: "code",
        file_type: "code",
        _origin: "ast",
      }],
      links: [],
      built_at_commit: head,
    };
    writeFileSync(
      path.join(repo, "graphify-out", "graph.json"),
      JSON.stringify(graph),
    );
    writeFileSync(
      path.join(repo, "graphify-out", "GRAPH_REPORT.md"),
      `# Graph Report\n\n## Summary\n- 1 nodes · 0 edges · 0 communities\n\n## Graph Freshness\n- Built from commit: \`${head}\`\n`,
    );
    const statePath = path.join(temp, "calls.json");
    writeFileSync(statePath, JSON.stringify({ extract: 0, cluster: 0, update: 0 }));
    const fake = path.join(temp, "fake-graphify.mjs");
    writeFileSync(fake, `
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const statePath = process.env.FAKE_GRAPHIFY_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const command = args[0];
if (command === "extract") {
  state.extract += 1;
  const head = process.env.FAKE_HEAD;
  const graph = { nodes: [{ id: "tracked", label: "tracked.txt", source_file: "tracked.txt", source_location: "L1", type: "code", file_type: "code", _origin: "ast" }], links: [], built_at_commit: head };
  writeFileSync(path.join(process.cwd(), "graphify-out", "graph.json"), JSON.stringify(graph));
  writeFileSync(path.join(process.cwd(), "graphify-out", "GRAPH_REPORT.md"), "# Graph Report\\n\\n## Summary\\n- 1 nodes · 0 edges · 0 communities\\n\\n## Graph Freshness\\n- Built from commit: " + head + "\\n");
} else if (command === "cluster-only") {
  state.cluster += 1;
} else if (command === "update") {
  state.update += 1;
}
writeFileSync(statePath, JSON.stringify(state));
`);
    const result = spawnSync(process.execPath, [cli, "rebuild"], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        META_KIM_GRAPHIFY_BIN: process.execPath,
        META_KIM_GRAPHIFY_BIN_ARGS: fake,
        META_KIM_GRAPHIFY_MIGRATION_BACKEND: "claude-cli",
        FAKE_GRAPHIFY_STATE: statePath,
        FAKE_HEAD: head,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(
      JSON.parse(readFileSync(statePath, "utf8")),
      { extract: 1, cluster: 1, update: 0 },
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("graphify update resets stale sidecar references and re-clusters before stamping", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "meta-kim-graphify-sidecar-update-"));
  try {
    const repo = initRepo(temp, "repo");
    const { head, graph } = writeValidArtifacts(repo);
    const repositoryFiles = spawnSync("git", ["ls-files", "-z"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.split("\0").filter(Boolean);
    const analysis = {
      communities: { 0: ["tracked_txt"] },
      cohesion: { 0: 1 },
      gods: [{ id: "tracked_txt", label: "tracked.txt", degree: 0 }],
      surprises: [],
      questions: [],
    };
    const proof = applyGraphNodeIdentityProof(graph, {
      repositoryFiles,
      repositoryStateSha256: repositoryStateSha256(repo, repositoryFiles),
      builtCommit: head,
      analysisSidecar: analysis,
    }).proof;
    writeFileSync(
      path.join(repo, "graphify-out", "graph.json"),
      `${JSON.stringify(graph)}\n`,
    );
    writeFileSync(
      path.join(repo, "graphify-out", ".graphify_analysis.json"),
      `${JSON.stringify(analysis)}\n`,
    );
    writeFileSync(
      path.join(repo, "graphify-out", "GRAPH_REPORT.md"),
      `# Graph Report\n\n## Summary\n- 1 nodes · 0 edges · 1 communities\n\n## Graph Freshness\n- Built from commit: \`${head}\`\n${proofLine(proof)}\n`,
    );

    const statePath = path.join(temp, "calls.json");
    writeFileSync(statePath, JSON.stringify({ update: 0, cluster: 0 }));
    const fake = path.join(temp, "fake-graphify.mjs");
    writeFileSync(fake, `
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const statePath = process.env.FAKE_GRAPHIFY_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
if (process.argv[2] === "update") {
  state.update += 1;
  const graphPath = path.join(process.cwd(), "graphify-out", "graph.json");
  const analysisPath = path.join(process.cwd(), "graphify-out", ".graphify_analysis.json");
  const graph = JSON.parse(readFileSync(graphPath, "utf8"));
  const analysis = JSON.parse(readFileSync(analysisPath, "utf8"));
  graph.nodes[0].id = "Tracked.Txt";
  analysis.communities["0"] = ["removed_old"];
  analysis.gods[0].id = "removed_old";
  writeFileSync(graphPath, JSON.stringify(graph));
  writeFileSync(analysisPath, JSON.stringify(analysis));
} else if (process.argv[2] === "cluster-only") {
  state.cluster += 1;
  const analysisPath = path.join(process.cwd(), "graphify-out", ".graphify_analysis.json");
  writeFileSync(analysisPath, JSON.stringify({
    communities: { 0: ["tracked_txt"] },
    cohesion: { 0: 1 },
    gods: [{ id: "tracked_txt", label: "tracked.txt", degree: 0 }],
    surprises: [],
    questions: []
  }));
}
writeFileSync(statePath, JSON.stringify(state));
`);
    const result = spawnSync(process.execPath, [cli, "rebuild"], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        META_KIM_GRAPHIFY_BIN: process.execPath,
        META_KIM_GRAPHIFY_BIN_ARGS: fake,
        FAKE_GRAPHIFY_STATE: statePath,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(
      JSON.parse(readFileSync(statePath, "utf8")),
      { update: 1, cluster: 1 },
    );
    const finalAnalysis = JSON.parse(
      readFileSync(
        path.join(repo, "graphify-out", ".graphify_analysis.json"),
        "utf8",
      ),
    );
    assert.deepEqual(finalAnalysis.communities, { 0: ["tracked_txt"] });
    assert.equal(finalAnalysis.gods[0].id, "tracked_txt");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("graphify rebuild rejects tracked content mutation performed during update", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "meta-kim-graphify-update-toctou-"));
  try {
    const repo = initRepo(temp, "repo");
    writeValidArtifacts(repo);
    const fake = path.join(temp, "fake-graphify.mjs");
    writeFileSync(fake, `
import { writeFileSync } from "node:fs";
import path from "node:path";
if (process.argv[2] === "update") {
  writeFileSync(path.join(process.cwd(), "tracked.txt"), "mutated during update\\n");
}
`);
    const result = spawnSync(process.execPath, [cli, "rebuild"], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        META_KIM_GRAPHIFY_BIN: process.execPath,
        META_KIM_GRAPHIFY_BIN_ARGS: fake,
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /repository changed during Graphify update/u);
    assert.equal(
      existsSync(
        path.join(repo, "graphify-out", ".meta-kim-node-identity-migration.json"),
      ),
      false,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("graphify rebuild rejects tracked content mutation performed during extract", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "meta-kim-graphify-extract-toctou-"));
  try {
    const repo = initRepo(temp, "repo");
    const head = git(repo, ["rev-parse", "HEAD"]);
    mkdirSync(path.join(repo, "graphify-out"));
    writeFileSync(
      path.join(repo, "graphify-out", "graph.json"),
      JSON.stringify({
        nodes: [{
          id: "legacy",
          label: "tracked.txt",
          source_file: "tracked.txt",
          source_location: "L1",
          type: "code",
          file_type: "code",
          _origin: "ast",
        }],
        links: [],
        built_at_commit: head,
      }),
    );
    writeFileSync(
      path.join(repo, "graphify-out", "GRAPH_REPORT.md"),
      `# Graph Report\n\n## Summary\n- 1 nodes · 0 edges · 0 communities\n\n## Graph Freshness\n- Built from commit: \`${head}\`\n`,
    );
    const fake = path.join(temp, "fake-graphify.mjs");
    writeFileSync(fake, `
import { writeFileSync } from "node:fs";
import path from "node:path";
if (process.argv[2] === "extract") {
  writeFileSync(path.join(process.cwd(), "tracked.txt"), "mutated during extract\\n");
  const head = process.env.FAKE_HEAD;
  const graph = { nodes: [{ id: "tracked_txt", label: "tracked.txt", source_file: "tracked.txt", source_location: "L1", type: "code", file_type: "code", _origin: "ast" }], links: [], built_at_commit: head };
  writeFileSync(path.join(process.cwd(), "graphify-out", "graph.json"), JSON.stringify(graph));
  writeFileSync(path.join(process.cwd(), "graphify-out", "GRAPH_REPORT.md"), "# Graph Report\\n\\n## Summary\\n- 1 nodes · 0 edges · 0 communities\\n\\n## Graph Freshness\\n- Built from commit: " + head + "\\n");
}
`);
    const result = spawnSync(process.execPath, [cli, "rebuild"], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        META_KIM_GRAPHIFY_BIN: process.execPath,
        META_KIM_GRAPHIFY_BIN_ARGS: fake,
        META_KIM_GRAPHIFY_MIGRATION_BACKEND: "claude-cli",
        FAKE_HEAD: head,
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /repository changed during Graphify extract/u);
    assert.equal(
      existsSync(
        path.join(repo, "graphify-out", ".meta-kim-node-identity-migration.json"),
      ),
      false,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("graphify rebuild restores a truncated analysis sidecar from the extract checkpoint", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "meta-kim-graphify-sidecar-resume-"));
  try {
    const repo = initRepo(temp, "repo");
    const head = git(repo, ["rev-parse", "HEAD"]);
    mkdirSync(path.join(repo, "graphify-out"));
    writeFileSync(
      path.join(repo, "graphify-out", "graph.json"),
      JSON.stringify({
        nodes: [{
          id: "legacy",
          label: "tracked.txt",
          source_file: "tracked.txt",
          source_location: "L1",
          type: "code",
          file_type: "code",
          _origin: "ast",
        }],
        links: [],
        built_at_commit: head,
      }),
    );
    writeFileSync(
      path.join(repo, "graphify-out", "GRAPH_REPORT.md"),
      `# Graph Report\n\n## Summary\n- 1 nodes · 0 edges · 0 communities\n\n## Graph Freshness\n- Built from commit: \`${head}\`\n`,
    );
    const statePath = path.join(temp, "calls.json");
    writeFileSync(statePath, JSON.stringify({ extract: 0, cluster: 0 }));
    const fake = path.join(temp, "fake-graphify.mjs");
    writeFileSync(fake, `
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const statePath = process.env.FAKE_GRAPHIFY_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const command = process.argv[2];
const output = path.join(process.cwd(), "graphify-out");
if (command === "extract") {
  state.extract += 1;
  const graph = { nodes: [{ id: "tracked_txt", label: "tracked.txt", source_file: "tracked.txt", source_location: "L1", type: "code", file_type: "code", _origin: "ast" }], links: [], built_at_commit: process.env.FAKE_HEAD };
  writeFileSync(path.join(output, "graph.json"), JSON.stringify(graph));
  writeFileSync(path.join(output, ".graphify_analysis.json"), JSON.stringify({ communities: { 0: ["tracked_txt"] }, cohesion: { 0: 1 }, gods: [], surprises: [] }));
  writeFileSync(path.join(output, "GRAPH_REPORT.md"), "# Graph Report\\n\\n## Summary\\n- 1 nodes · 0 edges · 1 communities\\n\\n## Graph Freshness\\n- Built from commit: " + process.env.FAKE_HEAD + "\\n");
} else if (command === "cluster-only") {
  state.cluster += 1;
  if (state.cluster === 1) {
    writeFileSync(path.join(output, ".graphify_analysis.json"), "{\\n");
    writeFileSync(statePath, JSON.stringify(state));
    process.exit(17);
  }
  writeFileSync(path.join(output, ".graphify_analysis.json"), JSON.stringify({ communities: { 0: ["tracked_txt"] }, cohesion: { 0: 1 }, gods: [], surprises: [], questions: [] }));
}
writeFileSync(statePath, JSON.stringify(state));
`);
    const run = () => spawnSync(process.execPath, [cli, "rebuild"], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        META_KIM_GRAPHIFY_BIN: process.execPath,
        META_KIM_GRAPHIFY_BIN_ARGS: fake,
        META_KIM_GRAPHIFY_MIGRATION_BACKEND: "claude-cli",
        FAKE_GRAPHIFY_STATE: statePath,
        FAKE_HEAD: head,
      },
    });
    assert.equal(run().status, 17);
    const second = run();
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.deepEqual(
      JSON.parse(readFileSync(statePath, "utf8")),
      { extract: 1, cluster: 2 },
    );
    assert.doesNotThrow(() =>
      JSON.parse(
        readFileSync(
          path.join(repo, "graphify-out", ".graphify_analysis.json"),
          "utf8",
        ),
      ),
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("graphify rebuild binds the cluster report and re-clusters from the extract snapshot", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "meta-kim-graphify-cluster-report-"));
  try {
    const repo = initRepo(temp, "repo");
    const head = git(repo, ["rev-parse", "HEAD"]);
    const output = path.join(repo, "graphify-out");
    mkdirSync(output);
    writeFileSync(
      path.join(output, "graph.json"),
      JSON.stringify({
        nodes: [{
          id: "legacy",
          label: "tracked.txt",
          source_file: "tracked.txt",
          source_location: "L1",
          type: "code",
          file_type: "code",
          _origin: "ast",
        }],
        links: [],
        built_at_commit: head,
      }),
    );
    writeFileSync(
      path.join(output, "GRAPH_REPORT.md"),
      `# Graph Report\n\n## Summary\n- 1 nodes · 0 edges · 0 communities\n\n## Graph Freshness\n- Built from commit: \`${head}\`\n`,
    );
    const statePath = path.join(temp, "calls.json");
    writeFileSync(statePath, JSON.stringify({ extract: 0, cluster: 0 }));
    const fake = path.join(temp, "fake-graphify.mjs");
    writeFileSync(fake, `
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const statePath = process.env.FAKE_GRAPHIFY_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const command = process.argv[2];
const output = path.join(process.cwd(), "graphify-out");
if (command === "extract") {
  state.extract += 1;
  const graph = { nodes: [{ id: "tracked_txt", label: "tracked.txt", source_file: "tracked.txt", source_location: "L1", type: "code", file_type: "code", _origin: "ast" }], links: [], built_at_commit: process.env.FAKE_HEAD };
  writeFileSync(path.join(output, "graph.json"), JSON.stringify(graph));
  writeFileSync(path.join(output, ".graphify_analysis.json"), JSON.stringify({ communities: { 0: ["tracked_txt"] }, cohesion: { 0: 1 }, gods: [], surprises: [] }));
  writeFileSync(path.join(output, "GRAPH_REPORT.md"), "# Graph Report\\n\\n## Summary\\n- 1 nodes · 0 edges · 1 communities\\n\\n## Graph Freshness\\n- Built from commit: " + process.env.FAKE_HEAD + "\\n");
} else if (command === "cluster-only") {
  state.cluster += 1;
  writeFileSync(path.join(output, ".graphify_analysis.json"), JSON.stringify({ communities: { 0: ["tracked_txt"] }, cohesion: { 0: 1 }, gods: [], surprises: [], questions: [] }));
  const suffix = state.cluster === 1 ? "\\nPrivate: C:\\\\Users\\\\Kim\\\\secret.txt\\n" : "";
  writeFileSync(path.join(output, "GRAPH_REPORT.md"), "# Graph Report\\n\\n## Summary\\n- 1 nodes · 0 edges · 1 communities\\n\\n## Graph Freshness\\n- Built from commit: " + process.env.FAKE_HEAD + "\\n" + suffix);
}
writeFileSync(statePath, JSON.stringify(state));
`);
    const run = () => spawnSync(process.execPath, [cli, "rebuild"], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        META_KIM_GRAPHIFY_BIN: process.execPath,
        META_KIM_GRAPHIFY_BIN_ARGS: fake,
        META_KIM_GRAPHIFY_MIGRATION_BACKEND: "claude-cli",
        FAKE_GRAPHIFY_STATE: statePath,
        FAKE_HEAD: head,
      },
    });
    const first = run();
    assert.notEqual(first.status, 0);
    assert.match(first.stderr, /private local path/u);
    const checkpointPath = path.join(
      output,
      ".meta-kim-node-identity-migration.json",
    );
    assert.equal(
      JSON.parse(readFileSync(checkpointPath, "utf8")).stage,
      "cluster_complete",
    );
    writeFileSync(
      path.join(output, "GRAPH_REPORT.md"),
      "# interrupted report\n",
    );
    const second = run();
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.deepEqual(
      JSON.parse(readFileSync(statePath, "utf8")),
      { extract: 1, cluster: 2 },
    );
    assert.equal(existsSync(checkpointPath), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("graphify rebuild removes orphan extract snapshots even when no state file exists", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "meta-kim-graphify-orphan-snapshot-"));
  try {
    const repo = initRepo(temp, "repo");
    writeValidArtifacts(repo);
    const statePath = path.join(temp, "calls.json");
    writeFileSync(statePath, JSON.stringify({ update: 0, cluster: 0 }));
    const fake = path.join(temp, "fake-graphify.mjs");
    writeFileSync(fake, `
import { readFileSync, writeFileSync } from "node:fs";
const statePath = process.env.FAKE_GRAPHIFY_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
if (process.argv[2] === "update") state.update += 1;
if (process.argv[2] === "cluster-only") state.cluster += 1;
writeFileSync(statePath, JSON.stringify(state));
`);
    const run = () => spawnSync(process.execPath, [cli, "rebuild"], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        META_KIM_GRAPHIFY_BIN: process.execPath,
        META_KIM_GRAPHIFY_BIN_ARGS: fake,
        FAKE_GRAPHIFY_STATE: statePath,
      },
    });
    const first = run();
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const output = path.join(repo, "graphify-out");
    const orphanGraph = path.join(output, ".meta-kim-extract-graph.json");
    const orphanAnalysis = path.join(output, ".meta-kim-extract-analysis.json");
    writeFileSync(orphanGraph, readFileSync(path.join(output, "graph.json"), "utf8"));
    writeFileSync(orphanAnalysis, "{}\n");
    assert.equal(
      existsSync(path.join(output, ".meta-kim-node-identity-migration.json")),
      false,
    );
    const second = run();
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.equal(existsSync(orphanGraph), false);
    assert.equal(existsSync(orphanAnalysis), false);
    assert.deepEqual(
      JSON.parse(readFileSync(statePath, "utf8")),
      { update: 2, cluster: 1 },
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("graphify extract checkpoints are invalidated when repository contents change", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "meta-kim-graphify-content-checkpoint-"));
  try {
    const repo = initRepo(temp, "repo");
    const head = git(repo, ["rev-parse", "HEAD"]);
    mkdirSync(path.join(repo, "graphify-out"));
    writeFileSync(
      path.join(repo, "graphify-out", "graph.json"),
      JSON.stringify({
        nodes: [{
          id: "legacy",
          label: "tracked.txt",
          source_file: "tracked.txt",
          source_location: "L1",
          type: "code",
          file_type: "code",
          _origin: "ast",
        }],
        links: [],
        built_at_commit: head,
      }),
    );
    writeFileSync(
      path.join(repo, "graphify-out", "GRAPH_REPORT.md"),
      `# Graph Report\n\n## Summary\n- 1 nodes · 0 edges · 0 communities\n\n## Graph Freshness\n- Built from commit: \`${head}\`\n`,
    );
    const statePath = path.join(temp, "calls.json");
    writeFileSync(statePath, JSON.stringify({ extract: 0, cluster: 0 }));
    const fake = path.join(temp, "fake-graphify.mjs");
    writeFileSync(fake, `
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const statePath = process.env.FAKE_GRAPHIFY_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const command = process.argv[2];
if (command === "extract") {
  state.extract += 1;
  const graph = {
    nodes: [{ id: "tracked_txt", label: "tracked.txt", source_file: "tracked.txt", source_location: "L1", type: "code", file_type: "code", _origin: "ast" }],
    links: [],
    built_at_commit: process.env.FAKE_HEAD
  };
  writeFileSync(path.join(process.cwd(), "graphify-out", "graph.json"), JSON.stringify(graph));
  writeFileSync(path.join(process.cwd(), "graphify-out", "GRAPH_REPORT.md"), "# Graph Report\\n\\n## Summary\\n- 1 nodes · 0 edges · 0 communities\\n\\n## Graph Freshness\\n- Built from commit: " + process.env.FAKE_HEAD + "\\n");
} else if (command === "cluster-only") {
  state.cluster += 1;
  writeFileSync(statePath, JSON.stringify(state));
  if (state.cluster === 1) process.exit(23);
}
writeFileSync(statePath, JSON.stringify(state));
`);
    const run = () =>
      spawnSync(process.execPath, [cli, "rebuild"], {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          META_KIM_GRAPHIFY_BIN: process.execPath,
          META_KIM_GRAPHIFY_BIN_ARGS: fake,
          META_KIM_GRAPHIFY_MIGRATION_BACKEND: "claude-cli",
          FAKE_GRAPHIFY_STATE: statePath,
          FAKE_HEAD: head,
        },
      });
    const first = run();
    assert.equal(first.status, 23, first.stderr || first.stdout);
    const checkpointPath = path.join(
      repo,
      "graphify-out",
      ".meta-kim-node-identity-migration.json",
    );
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
    assert.match(checkpoint.repositoryStateSha256, /^[a-f0-9]{64}$/u);

    writeFileSync(path.join(repo, "tracked.txt"), "changed after extract\n");
    const second = run();
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.deepEqual(
      JSON.parse(readFileSync(statePath, "utf8")),
      { extract: 2, cluster: 2 },
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
