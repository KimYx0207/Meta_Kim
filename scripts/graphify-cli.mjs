#!/usr/bin/env node

import process from "node:process";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  detectPython310,
  discoverWindowsPythonPaths,
  discoverWindowsPythonPathCommands,
  extractPipShowVersion,
  formatPythonLauncher,
  parsePythonVersion,
  readProcessText,
  resolveGraphifyExecutable,
  runPythonModule,
} from "./graphify-runtime.mjs";
import { enrichMetaKimGraph } from "./graphify-enrichment.mjs";
import {
  graphifyOutputNormalizationValues,
  sanitizeGraphifyAnalysisSidecar,
  sanitizeGraphifyOutput,
} from "./graphify-output-sanitize.mjs";
import {
  hasPrivateLocalPath,
  revealsMachineIdentity,
  sanitizeKnownMetaKimHomeAliases,
} from "./graphify-private-path.mjs";
import {
  createGraphifyRuntimeNormalizer,
  GRAPHIFY_NODE_ID_NORMALIZATION,
} from "./graphify-unicode-normalize.mjs";
import {
  applyGraphNodeIdentityProof,
  analyzeGraphNodeIdentity,
  disambiguateGraphFileNodeLabels,
  GRAPH_NODE_IDENTITY_SCHEMA,
  validateGraphNodeIdentity,
} from "./graphify-node-identity.mjs";
import { homedir } from "node:os";
import { sanitizeGraphifyWindowsHooks } from "./graphify-hook-sanitize.mjs";
import { renameWithTransientRetry } from "./transient-rename.mjs";

const command = process.argv[2] || "check";
const GRAPHIFY_MIGRATION_STATE_SCHEMA = "meta-kim-graphify-migration-state-v2";
const GRAPHIFY_EXISTING_EXTRACT_ADOPTION_SCHEMA =
  "meta-kim-graphify-existing-extract-adoption-v1";

function graphifyLauncher() {
  if (process.env.META_KIM_GRAPHIFY_BIN) {
    return {
      command: process.env.META_KIM_GRAPHIFY_BIN,
      args: (process.env.META_KIM_GRAPHIFY_BIN_ARGS || "")
        .trim()
        .split(/\s+/u)
        .filter(Boolean),
      normalizerPython: null,
    };
  }
  const primaryPython = detectPython310(spawnSync, process.platform, {
    requirePip: true,
    bootstrapPip: false,
  });
  const located = primaryPython
    ? locateGraphifyInstallation(primaryPython)
    : null;
  if (located) {
    return {
      command: located.python.command,
      args: [...located.python.args, "-m", "graphify"],
      normalizerPython: {
        command: located.python.command,
        args: [...located.python.args],
      },
    };
  }
  return {
    command: "graphify",
    args: [],
    normalizerPython: null,
  };
}

function verifiedGraphifyEnvironment() {
  const clean = sanitizedGitEnvironment();
  const blocked = new Set([
    "PYTHONHOME",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "PYTHONINSPECT",
    "PYTHONUSERBASE",
  ]);
  for (const key of Object.keys(clean)) {
    if (blocked.has(key.toUpperCase())) delete clean[key];
  }
  return clean;
}

function verifiedGraphifyLauncher() {
  const verifiedSpawn = (command, args, options = {}) =>
    spawnSync(command, args, {
      ...options,
      env: verifiedGraphifyEnvironment(),
      windowsHide: true,
    });
  const primaryPython = detectPython310(verifiedSpawn, process.platform, {
    requirePip: true,
    bootstrapPip: false,
  });
  const located = primaryPython
    ? locateGraphifyInstallation(primaryPython, verifiedSpawn)
    : null;
  if (!located) {
    throw new Error("installed Graphify distribution could not be located");
  }
  const executable = resolveGraphifyExecutable(located.python, verifiedSpawn);
  if (!executable || !path.isAbsolute(executable) || !existsSync(executable)) {
    throw new Error("installed Graphify console script is not an absolute file");
  }
  const executableStats = lstatSync(executable);
  if (!executableStats.isFile() || executableStats.isSymbolicLink()) {
    throw new Error("installed Graphify console script is not a plain file");
  }
  const realExecutable = realpathSync.native(executable);
  if (pathIdentity(realExecutable) !== pathIdentity(executable)) {
    throw new Error("installed Graphify console script resolves through an alias");
  }
  const installedVersion = extractPipShowVersion(located.pipShowText);
  const versionResult = spawnSync(realExecutable, ["--version"], {
    encoding: "utf8",
    shell: false,
    env: verifiedGraphifyEnvironment(),
    windowsHide: true,
  });
  const executableVersion = readProcessText(versionResult).match(
    /graphify\s+([^\s]+)/iu,
  )?.[1];
  if (
    versionResult.status !== 0 ||
    !installedVersion ||
    executableVersion !== installedVersion
  ) {
    throw new Error("Graphify console script version does not match pip distribution metadata");
  }
  return {
    command: realExecutable,
    args: [],
    normalizerPython: {
      command: located.python.command,
      args: [...located.python.args],
    },
    version: installedVersion,
    executableSha256: sha256(readFileSync(realExecutable)),
  };
}

const GRAPHIFY_API_KEY_NAMES = Object.freeze([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "MOONSHOT_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OLLAMA_API_KEY",
]);

function graphifyMigrationBackendArgs() {
  const explicit = String(process.env.META_KIM_GRAPHIFY_MIGRATION_BACKEND ?? "").trim();
  if (explicit) return ["--backend", explicit];
  if (GRAPHIFY_API_KEY_NAMES.some((name) => String(process.env[name] ?? "").trim())) {
    return [];
  }
  const claude = spawnSync("claude", ["--version"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  return claude.status === 0 && !claude.error ? ["--backend", "claude-cli"] : [];
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function ensurePython({ requirePip = false } = {}) {
  const python = detectPython310(spawnSync, process.platform, {
    requirePip,
    bootstrapPip: requirePip,
  });
  if (!python) {
    fail(requirePip ? "Python 3.10+ with pip not found" : "Python 3.10+ not found");
    return null;
  }
  return python;
}

function isSafeWindowsPythonCandidate(candidate) {
  if (process.platform !== "win32") return true;
  if (!candidate || candidate.args?.length !== 0) return false;
  if (!path.win32.isAbsolute(candidate.command)) return false;
  const normalized = candidate.command.replaceAll("\\", "/").toLowerCase();
  return !normalized.includes("/windowsapps/") &&
    /python(?:3)?\.exe$/iu.test(path.win32.basename(candidate.command));
}

function probePython(candidate) {
  if (!isSafeWindowsPythonCandidate(candidate)) return null;
  let result;
  try {
    result = spawnSync(candidate.command, [...candidate.args, "--version"], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
  } catch {
    return null;
  }
  if (result?.error || result?.status !== 0) {
    return null;
  }
  const versionText = readProcessText(result);
  const parsed = parsePythonVersion(versionText);
  if (!parsed) {
    return null;
  }
  if (parsed.major < 3 || (parsed.major === 3 && parsed.minor < 10)) {
    return null;
  }
  return { ...candidate, version: parsed, versionText };
}

function pythonKey(python) {
  return `${python.command}::${python.args.join(" ")}`;
}

function* iterateGraphifyPythonCandidates(primary) {
  const seen = new Set();
  const yieldIfNew = function* (python) {
    if (!python) return;
    const key = pythonKey(python);
    if (seen.has(key)) return;
    seen.add(key);
    yield python;
  };

  const envOverride = process.env.META_KIM_GRAPHIFY_PYTHON;
  if (envOverride && envOverride.trim()) {
    const parts = envOverride.trim().split(/\s+/u);
    const probed = probePython({ command: parts[0], args: parts.slice(1) });
    yield* yieldIfNew(probed);
  }

  yield* yieldIfNew(primary);

  if (process.platform === "win32") {
    for (const candidate of discoverWindowsPythonPathCommands(spawnSync)) {
      const probed = probePython(candidate);
      yield* yieldIfNew(probed);
    }
    for (const { major, minor, path: exePath } of discoverWindowsPythonPaths()) {
      if (major < 3 || (major === 3 && minor < 10)) continue;
      const probed = probePython({ command: exePath, args: [] });
      yield* yieldIfNew(probed);
    }
  }
}

function locateGraphifyInstallation(primaryPython, spawnFn = spawnSync) {
  for (const python of iterateGraphifyPythonCandidates(primaryPython)) {
    const pipShow = runPythonModule(
      python,
      ["-m", "pip", "show", "graphifyy"],
      spawnFn,
    );
    if (pipShow.status === 0) {
      return {
        python,
        pipShowText: readProcessText(pipShow),
      };
    }
  }
  return null;
}

function extractReportCommit(reportRaw) {
  const metadataLines = reportRaw
    .split(/\r?\n/u)
    .filter((line) => /Built from commit:/iu.test(line));
  if (metadataLines.length !== 1) return null;
  const match = metadataLines[0].match(
    /Built from commit:\s*`?([0-9a-f]{40})`?\s*$/iu,
  );
  return match?.[1] ?? null;
}

function extractRawReportCommit(reportRaw) {
  const metadataLines = reportRaw
    .split(/\r?\n/u)
    .filter((line) => /Built from commit:/iu.test(line));
  if (metadataLines.length !== 1) return null;
  const match = metadataLines[0].match(
    /Built from commit:\s*`?([0-9a-f]{7,40})`?\s*$/iu,
  );
  return match?.[1] ?? null;
}

function renderGraphIdentityReportLine(proof) {
  const fileCount = Number(proof.fileIdentityCount ?? proof.fileNodeCount ?? 0);
  return `- Meta_Kim node identity: \`${proof.schemaVersion}\` (${proof.status}; ${fileCount} file nodes; evidence ${proof.evidenceSha256})`;
}

function reportGraphCounts(reportRaw) {
  const matches = [
    ...reportRaw.matchAll(
      /^- ([\d,]+) nodes · ([\d,]+) edges · ([\d,]+) communities\b/gmu,
    ),
  ];
  if (matches.length !== 1) return null;
  const match = matches[0];
  return {
    nodes: Number(match[1].replaceAll(",", "")),
    links: Number(match[2].replaceAll(",", "")),
    communities: Number(match[3].replaceAll(",", "")),
  };
}

function commitsMatch(left, right) {
  return /^[0-9a-f]{40}$/iu.test(String(left ?? "")) &&
    /^[0-9a-f]{40}$/iu.test(String(right ?? "")) &&
    String(left).toLowerCase() === String(right).toLowerCase();
}

function pathIdentity(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function sanitizedGitEnvironment(environment = process.env) {
  const clean = { ...environment };
  for (const key of Object.keys(clean)) {
    if (key.toUpperCase().startsWith("GIT_")) delete clean[key];
  }
  return clean;
}

function gitText(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    env: sanitizedGitEnvironment(),
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) return null;
  return String(result.stdout ?? "");
}

function isKnownUntrackedGraphifyAttributes(repoRoot, repositoryFile) {
  if (repositoryFile !== ".gitattributes") return false;
  const tracked = gitText(repoRoot, [
    "ls-files",
    "--error-unmatch",
    "--",
    ".gitattributes",
  ]);
  if (tracked) return false;
  const candidate = path.join(repoRoot, ".gitattributes");
  if (!existsSync(candidate)) return false;
  const stats = lstatSync(candidate);
  if (!stats.isFile() || stats.isSymbolicLink()) return false;
  return readFileSync(candidate, "utf8").trim() ===
    "graphify-out/graph.json merge=graphify";
}

function readRepositoryContext(cwd) {
  const requested = path.resolve(cwd);
  if (!existsSync(requested)) return null;
  const cwdStats = lstatSync(requested);
  if (!cwdStats.isDirectory() || cwdStats.isSymbolicLink()) return null;
  const realCwd = realpathSync.native(requested);
  if (pathIdentity(realCwd) !== pathIdentity(requested)) return null;
  const topLevelRaw = gitText(realCwd, ["rev-parse", "--show-toplevel"]);
  if (!topLevelRaw) return null;
  const topLevel = realpathSync.native(topLevelRaw.split(/\r?\n/u)[0].trim());
  if (pathIdentity(topLevel) !== pathIdentity(realCwd)) return null;
  const headRaw = gitText(topLevel, ["rev-parse", "HEAD"]);
  const currentHead = headRaw?.split(/\r?\n/u)[0]?.trim() ?? "";
  if (!/^[0-9a-f]{40}$/iu.test(currentHead)) return null;
  const filesRaw = gitText(topLevel, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (filesRaw == null) return null;
  const deletedFilesRaw = gitText(topLevel, ["ls-files", "--deleted", "-z"]);
  if (deletedFilesRaw == null) return null;
  const deletedFiles = new Set(
    deletedFilesRaw
      .split("\0")
      .filter((value) => value.length > 0)
      .map((value) => value.replaceAll("\\", "/")),
  );
  const repositoryFiles = filesRaw
    .split("\0")
    .filter((value) => value.length > 0)
    .map((value) => value.replaceAll("\\", "/"))
    .filter((value) => !deletedFiles.has(value))
    .filter((value) => !isKnownUntrackedGraphifyAttributes(topLevel, value));
  return {
    repoRoot: topLevel,
    currentHead,
    repositoryFiles,
    repositoryStateSha256: repositoryStateDigest(topLevel, repositoryFiles),
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function repositoryStateDigest(repoRoot, repositoryFiles) {
  const digest = createHash("sha256");
  for (const repositoryFile of [...repositoryFiles].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  )) {
    const target = path.join(repoRoot, ...repositoryFile.split("/"));
    const stats = lstatSync(target);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("repository inventory contains a non-plain file");
    }
    digest.update(repositoryFile);
    digest.update("\0");
    digest.update(sha256(readFileSync(target)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function refreshRepositorySnapshot(expected, boundary) {
  const current = readRepositoryContext(expected.repoRoot);
  if (
    !current ||
    pathIdentity(current.repoRoot) !== pathIdentity(expected.repoRoot) ||
    !commitsMatch(current.currentHead, expected.currentHead) ||
    repositoryFilesDigest(current.repositoryFiles) !==
      repositoryFilesDigest(expected.repositoryFiles) ||
    current.repositoryStateSha256 !== expected.repositoryStateSha256
  ) {
    throw new Error(
      `repository changed during Graphify ${boundary}; rerun from a stable source snapshot`,
    );
  }
  return current;
}

function graphNormalizationValues(
  graph,
  repositoryFiles,
  analysisSidecar = null,
) {
  const values = new Set();
  const add = (value) => {
    if (typeof value === "string") values.add(value);
  };
  for (const value of graphifyOutputNormalizationValues(graph)) add(value);
  for (const source of repositoryFiles) {
    add(source);
    const extension = path.posix.extname(source);
    add(extension ? source.slice(0, -extension.length) : source);
  }
  if (
    analysisSidecar?.communities &&
    typeof analysisSidecar.communities === "object"
  ) {
    for (const nodeIds of Object.values(analysisSidecar.communities)) {
      for (const nodeId of Array.isArray(nodeIds) ? nodeIds : []) add(nodeId);
    }
  }
  for (const god of Array.isArray(analysisSidecar?.gods)
    ? analysisSidecar.gods
    : []) {
    add(god?.id);
  }
  return [...values];
}

function graphRuntimeNormalizer(
  graph,
  repository,
  {
    honorStoredAscii = false,
    analysisSidecar = null,
    runtimeBinding = null,
  } = {},
) {
  const storedDescriptor =
    graph?.meta_kim_enrichment?.nodeIdentity?.nodeIdNormalization;
  const launcher = runtimeBinding?.launcher ?? graphifyLauncher();
  const environment = runtimeBinding?.environment ?? sanitizedGitEnvironment();
  return createGraphifyRuntimeNormalizer(
    graphNormalizationValues(
      graph,
      repository.repositoryFiles,
      analysisSidecar,
    ),
    {
      launcherCommand: launcher.command,
      pythonCandidate: launcher.normalizerPython,
      environment,
      forceAsciiInvariant:
        honorStoredAscii &&
        storedDescriptor === GRAPHIFY_NODE_ID_NORMALIZATION,
    },
  );
}

function assertPlainGraphifyPaths(cwd, { requireArtifacts = false } = {}) {
  const repo = realpathSync.native(path.resolve(cwd));
  const output = path.join(repo, "graphify-out");
  if (!existsSync(output)) {
    if (requireArtifacts) throw new Error("graphify output is missing");
    return {
      output,
      graphPath: path.join(output, "graph.json"),
      reportPath: path.join(output, "GRAPH_REPORT.md"),
      analysisPath: path.join(output, ".graphify_analysis.json"),
    };
  }
  const outputStats = lstatSync(output);
  if (!outputStats.isDirectory() || outputStats.isSymbolicLink()) {
    throw new Error("graphify output must be a plain repository directory");
  }
  const realOutput = realpathSync.native(output);
  if (!isContained(repo, realOutput) || pathIdentity(realOutput) !== pathIdentity(output)) {
    throw new Error("graphify output resolves outside the repository");
  }
  const result = {
    output,
    graphPath: path.join(output, "graph.json"),
    reportPath: path.join(output, "GRAPH_REPORT.md"),
    analysisPath: path.join(output, ".graphify_analysis.json"),
  };
  for (const [label, target] of [["graph", result.graphPath], ["report", result.reportPath]]) {
    if (!existsSync(target)) {
      if (requireArtifacts) throw new Error(`graphify ${label} is missing`);
      continue;
    }
    const stats = lstatSync(target);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`graphify ${label} must be a plain file`);
    }
    const realTarget = realpathSync.native(target);
    if (!isContained(realOutput, realTarget) || pathIdentity(realTarget) !== pathIdentity(target)) {
      throw new Error(`graphify ${label} resolves outside the repository`);
    }
  }
  return result;
}

function atomicWritePlainFile(filePath, contents) {
  const parent = path.dirname(filePath);
  const tempPath = path.join(parent, `.meta-kim-${path.basename(filePath)}-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(tempPath, "wx", 0o600);
    writeFileSync(fd, contents, "utf8");
    closeSync(fd);
    fd = undefined;
    if (existsSync(filePath)) {
      const stats = lstatSync(filePath);
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("target is not a plain file");
    }
    renameSync(tempPath, filePath);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(tempPath)) rmSync(tempPath, { force: true });
  }
}

function readGraphifyAnalysisSidecar(paths) {
  if (!existsSync(paths.analysisPath)) return null;
  const stats = lstatSync(paths.analysisPath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("Graphify analysis sidecar must be a plain file");
  }
  const realOutput = realpathSync.native(paths.output);
  const realAnalysis = realpathSync.native(paths.analysisPath);
  if (
    !isContained(realOutput, realAnalysis) ||
    pathIdentity(realAnalysis) !== pathIdentity(paths.analysisPath)
  ) {
    throw new Error("Graphify analysis sidecar resolves outside graphify-out");
  }
  return JSON.parse(readFileSync(paths.analysisPath, "utf8"));
}

function sanitizeGraphifyAnalysisFile(
  paths,
  graph,
  nodeIdMap,
  repositoryFiles,
  { requireComplete = true } = {},
) {
  const analysis = readGraphifyAnalysisSidecar(paths);
  if (!analysis) {
    return {
      analysis: null,
      sanitization: { changed: false, rewrittenNodeReferences: 0 },
    };
  }
  const sanitization = sanitizeGraphifyAnalysisSidecar(analysis, {
    nodeIdMap,
    graphNodeIds: new Set(graph.nodes.map((node) => node.id)),
    repositoryFiles,
    requireComplete,
  });
  if (sanitization.changed) {
    atomicWritePlainFile(
      paths.analysisPath,
      `${JSON.stringify(analysis, null, 2)}\n`,
    );
  }
  return { analysis, sanitization };
}

function checkGraphFreshness(cwd = process.cwd(), runtimeBinding = null) {
  const repository = readRepositoryContext(cwd);
  if (!repository) {
    fail("Graphify check must run from the real Git repository root");
    return false;
  }
  let paths;
  try {
    paths = assertPlainGraphifyPaths(repository.repoRoot, { requireArtifacts: true });
  } catch (error) {
    fail(`Graphify artifacts are unsafe: ${error.message}`);
    return false;
  }
  const { reportPath, graphPath } = paths;
  if (!existsSync(reportPath) || !existsSync(graphPath)) {
    fail(
      "graphify-out/GRAPH_REPORT.md and graphify-out/graph.json are required; run npm run meta:graphify:rebuild",
    );
    return false;
  }

  let graph;
  try {
    graph = JSON.parse(readFileSync(graphPath, "utf8"));
  } catch (error) {
    fail(`graphify-out/graph.json is not valid JSON: ${error.message}`);
    return false;
  }
  let nodeNormalizer;
  let analysisSidecar;
  try {
    analysisSidecar = readGraphifyAnalysisSidecar(paths);
    nodeNormalizer = graphRuntimeNormalizer(graph, repository, {
      honorStoredAscii: true,
      analysisSidecar,
      runtimeBinding,
    });
  } catch (error) {
    fail(`Graphify Python node-ID normalizer is unavailable: ${error.message}`);
    return false;
  }

  const reportRaw = readFileSync(reportPath, "utf8");
  if (revealsMachineIdentity(reportRaw)) {
    fail("GRAPH_REPORT.md exposes a private local path; rebuild after sanitizing upstream output.");
    return false;
  }
  const graphCommit = String(graph.built_at_commit ?? "");
  const reportCommit = extractReportCommit(reportRaw);
  if (!graphCommit || !reportCommit) {
    fail(
      "Graphify graph/report freshness metadata is incomplete; run npm run meta:graphify:rebuild",
    );
    return false;
  }

  if (
    !commitsMatch(graphCommit, repository.currentHead) ||
    !commitsMatch(reportCommit, repository.currentHead)
  ) {
    fail(
      `Graphify graph/report is stale or inconsistent with current HEAD ${repository.currentHead.slice(0, 12)}. Run npm run meta:graphify:rebuild.`,
    );
    return false;
  }

  const identity = validateGraphNodeIdentity(graph, {
    repositoryFiles: repository.repositoryFiles,
    repositoryStateSha256: repository.repositoryStateSha256,
    builtCommit: repository.currentHead,
    requireStored: true,
    normalizeNodeId: nodeNormalizer.normalize,
    nodeIdNormalization: nodeNormalizer.descriptor,
    analysisSidecar,
    requireAnalysisSidecar:
      nodeNormalizer.descriptor !== GRAPHIFY_NODE_ID_NORMALIZATION,
  });
  if (!identity.ok) {
    fail(
      `Graphify node identity is not release-safe: ${identity.reason}. Run npm run meta:graphify:rebuild.`,
    );
    return false;
  }
  const expectedIdentityLine = renderGraphIdentityReportLine(identity.expected);
  const identityLines = reportRaw
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("- Meta_Kim node identity:"));
  if (identityLines.length !== 1 || identityLines[0] !== expectedIdentityLine) {
    fail("GRAPH_REPORT.md is not bound to the verified graph identity proof; run npm run meta:graphify:rebuild.");
    return false;
  }
  const counts = reportGraphCounts(reportRaw);
  const actualCounts = {
    nodes: Array.isArray(graph.nodes) ? graph.nodes.length : 0,
    links: Array.isArray(graph.links) ? graph.links.length : 0,
    communities:
      analysisSidecar?.communities &&
      typeof analysisSidecar.communities === "object" &&
      !Array.isArray(analysisSidecar.communities)
        ? Object.keys(analysisSidecar.communities).length
        : 0,
  };
  if (
    !counts ||
    counts.nodes !== actualCounts.nodes ||
    counts.links !== actualCounts.links ||
    counts.communities !== actualCounts.communities
  ) {
    fail("GRAPH_REPORT.md node/edge/community counts do not match graph and analysis artifacts; run npm run meta:graphify:rebuild.");
    return false;
  }

  console.log(
    `graphify graph and report match HEAD ${repository.currentHead.slice(0, 8)} with ${identity.expected.schemaVersion}`,
  );
  return true;
}

function stampGraphFreshness(cwd = process.cwd(), runtimeBinding = null) {
  const repository = readRepositoryContext(cwd);
  if (!repository) {
    fail("Graphify stamping must run from the real Git repository root");
    return false;
  }
  let paths;
  try {
    paths = assertPlainGraphifyPaths(repository.repoRoot, { requireArtifacts: true });
  } catch (error) {
    fail(`Graphify artifacts are unsafe: ${error.message}`);
    return false;
  }
  const { reportPath, graphPath } = paths;
  let changed = false;
  let identityProof = null;
  let finalGraphStats = null;

  if (existsSync(graphPath)) {
    const graph = JSON.parse(readFileSync(graphPath, "utf8"));
    const previousSanitization =
      graph?.meta_kim_enrichment?.outputSanitization ?? null;
    const previousExistingExtractAdoption =
      graph?.meta_kim_enrichment?.existingExtractAdoption ?? null;
    let upstreamNormalizer;
    try {
      upstreamNormalizer = graphRuntimeNormalizer(graph, repository, {
        runtimeBinding,
      });
    } catch (error) {
      fail(`Graphify Python node-ID normalizer is unavailable: ${error.message}`);
      return false;
    }
    const outputSanitization = sanitizeGraphifyOutput(graph, {
      repositoryFiles: repository.repositoryFiles,
      normalizeNodeId: upstreamNormalizer.normalize,
    });
    const enrichment = enrichMetaKimGraph(graph);
    graph.meta_kim_enrichment.outputSanitization =
      outputSanitization.changed || !previousSanitization
        ? outputSanitization
        : previousSanitization;
    if (previousExistingExtractAdoption) {
      graph.meta_kim_enrichment.existingExtractAdoption =
        previousExistingExtractAdoption;
    }
    let analysisSidecar;
    try {
      analysisSidecar = readGraphifyAnalysisSidecar(paths);
    } catch (error) {
      fail(`Sanitized Graphify node IDs could not be rebound: ${error.message}`);
      return false;
    }
    const fileIdentities = disambiguateGraphFileNodeLabels(graph, {
      repositoryFiles: repository.repositoryFiles,
    });
    let analysisSanitization;
    try {
      analysisSanitization = sanitizeGraphifyAnalysisFile(
        paths,
        graph,
        outputSanitization.nodeIdMap,
        repository.repositoryFiles,
      );
      analysisSidecar = analysisSanitization.analysis;
    } catch (error) {
      fail(`Graphify analysis sidecar could not be rebound: ${error.message}`);
      return false;
    }
    let proofNormalizer;
    try {
      proofNormalizer = graphRuntimeNormalizer(graph, repository, {
        analysisSidecar,
        runtimeBinding,
      });
    } catch (error) {
      fail(`Sanitized Graphify node IDs could not be rebound: ${error.message}`);
      return false;
    }
    const commitChanged =
      !commitsMatch(String(graph.built_at_commit ?? ""), repository.currentHead);
    graph.built_at_commit = repository.currentHead;
    const identity = applyGraphNodeIdentityProof(graph, {
      repositoryFiles: repository.repositoryFiles,
      repositoryStateSha256: repository.repositoryStateSha256,
      builtCommit: repository.currentHead,
      normalizeNodeId: proofNormalizer.normalize,
      nodeIdNormalization: proofNormalizer.descriptor,
      analysisSidecar,
      requireAnalysisSidecar:
        proofNormalizer.descriptor !== GRAPHIFY_NODE_ID_NORMALIZATION,
    });
    identityProof = identity.proof;
    if (identityProof.status !== "verified_graph_file_identity") {
      fail(
        `Graphify rebuild still has unsafe node identity: ${validateGraphNodeIdentity(graph, {
          repositoryFiles: repository.repositoryFiles,
          repositoryStateSha256: repository.repositoryStateSha256,
          builtCommit: repository.currentHead,
          requireStored: false,
          normalizeNodeId: proofNormalizer.normalize,
          nodeIdNormalization: proofNormalizer.descriptor,
          analysisSidecar,
          requireAnalysisSidecar:
            proofNormalizer.descriptor !== GRAPHIFY_NODE_ID_NORMALIZATION,
        }).reason}`,
      );
      return false;
    }
    if (
      enrichment.changed ||
      outputSanitization.changed ||
      analysisSanitization.sanitization.changed ||
      fileIdentities.changed ||
      identity.changed ||
      commitChanged
    ) {
      atomicWritePlainFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`);
      changed = true;
    }
    finalGraphStats = {
      nodes: Array.isArray(graph.nodes) ? graph.nodes.length : 0,
      links: Array.isArray(graph.links) ? graph.links.length : 0,
    };
  }

  if (existsSync(reportPath)) {
    const reportRaw = readFileSync(reportPath, "utf8");
    const sanitizedReport = sanitizeKnownMetaKimHomeAliases(reportRaw);
    if (revealsMachineIdentity(sanitizedReport)) {
      fail("GRAPH_REPORT.md exposes a private local path; refusing to stamp unsafe output.");
      return false;
    }
    let nextReport = sanitizedReport.replace(
      /Built from commit:\s*`?([0-9a-f]{7,40})`?/i,
      `Built from commit: \`${repository.currentHead}\``,
    );
    if (identityProof) {
      const identityLine = renderGraphIdentityReportLine(identityProof);
      if (/^- Meta_Kim node identity:.*$/mu.test(nextReport)) {
        nextReport = nextReport.replace(/^- Meta_Kim node identity:.*$/mu, identityLine);
      } else {
        nextReport = nextReport.replace(
          /(Built from commit:\s*`?[0-9a-f]{7,40}`?[^\r\n]*\r?\n)/iu,
          `$1${identityLine}\n`,
        );
      }
    }
    if (finalGraphStats) {
      nextReport = nextReport.replace(
        /^- \d[\d,]* nodes · \d[\d,]* edges ·/mu,
        `- ${finalGraphStats.nodes.toLocaleString("en-US")} nodes · ${finalGraphStats.links.toLocaleString("en-US")} edges ·`,
      );
    }
    if (nextReport !== reportRaw) {
      atomicWritePlainFile(reportPath, nextReport);
      changed = true;
    }
  }

  if (changed) {
    console.log(`graphify freshness stamped to HEAD ${repository.currentHead.slice(0, 8)}`);
  }
  return checkGraphFreshness(repository.repoRoot, runtimeBinding);
}

function migrationStatePath(output) {
  return path.join(output, ".meta-kim-node-identity-migration.json");
}

function sanitizeGraphForClustering(
  paths,
  repository,
  runtimeBinding = null,
) {
  const graph = JSON.parse(readFileSync(paths.graphPath, "utf8"));
  const previousSanitization =
    graph?.meta_kim_enrichment?.outputSanitization ?? null;
  const previousExistingExtractAdoption =
    graph?.meta_kim_enrichment?.existingExtractAdoption ?? null;
  const normalizer = graphRuntimeNormalizer(graph, repository, {
    runtimeBinding,
  });
  const outputSanitization = sanitizeGraphifyOutput(graph, {
    repositoryFiles: repository.repositoryFiles,
    normalizeNodeId: normalizer.normalize,
  });
  const enrichment = enrichMetaKimGraph(graph);
  const fileIdentities = disambiguateGraphFileNodeLabels(graph, {
    repositoryFiles: repository.repositoryFiles,
  });
  const clusteringInputWasBound =
    previousSanitization?.clusteringInputBound === true;
  let requiresRecluster =
    outputSanitization.changed ||
    fileIdentities.changed ||
    enrichment.changed ||
    !clusteringInputWasBound;
  graph.meta_kim_enrichment.outputSanitization = {
    ...(outputSanitization.changed || !previousSanitization
      ? outputSanitization
      : previousSanitization),
    clusteringInputBound: true,
  };
  if (previousExistingExtractAdoption) {
    graph.meta_kim_enrichment.existingExtractAdoption =
      previousExistingExtractAdoption;
  }
  let analysisSanitization;
  try {
    ({ sanitization: analysisSanitization } =
      sanitizeGraphifyAnalysisFile(
        paths,
        graph,
        outputSanitization.nodeIdMap,
        repository.repositoryFiles,
        { requireComplete: false },
      ));
  } catch (error) {
    if (
      !/dangling node reference|partition every graph node exactly once/u.test(
        String(error?.message ?? ""),
      )
    ) {
      throw error;
    }
    if (existsSync(paths.analysisPath)) {
      containedPlainFileDigest(
        paths.output,
        paths.analysisPath,
        "Graphify analysis sidecar",
      );
      rmSync(paths.analysisPath, { force: true });
    }
    analysisSanitization = {
      changed: true,
      rewrittenNodeReferences: 0,
      communityCoverageComplete: false,
      resetForRecluster: true,
    };
  }
  requiresRecluster =
    requiresRecluster ||
    analysisSanitization.communityCoverageComplete === false;
  if (requiresRecluster) {
    atomicWritePlainFile(paths.graphPath, `${JSON.stringify(graph, null, 2)}\n`);
  }
  return {
    requiresRecluster,
    analysisSanitization,
  };
}

function repositoryFilesDigest(repositoryFiles) {
  return sha256([...repositoryFiles].sort((left, right) => left.localeCompare(right, "en")).join("\0"));
}

function graphFileDigest(graphPath) {
  return sha256(readFileSync(graphPath));
}

function containedPlainFileDigest(output, filePath, label) {
  if (!existsSync(filePath)) return null;
  const stats = lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a plain file`);
  }
  const realOutput = realpathSync.native(output);
  const realFile = realpathSync.native(filePath);
  if (
    !isContained(realOutput, realFile) ||
    pathIdentity(realFile) !== pathIdentity(filePath)
  ) {
    throw new Error(`${label} resolves outside graphify-out`);
  }
  return sha256(readFileSync(filePath));
}

const VERIFIED_GRAPHIFY_OUTPUT_FILES = Object.freeze([
  "graph.json",
  ".graphify_analysis.json",
  "GRAPH_REPORT.md",
  ".graphify_labels.json",
  ".graphify_labels.json.sig",
  ".graphify_root",
  ".graphify_semantic_marker",
  "cost.json",
  "manifest.json",
]);

const REQUIRED_VERIFIED_GRAPHIFY_OUTPUT_FILES = Object.freeze([
  "graph.json",
  "GRAPH_REPORT.md",
]);

function snapshotVerifiedGraphifyFiles(output) {
  const snapshot = new Map();
  for (const file of VERIFIED_GRAPHIFY_OUTPUT_FILES) {
    const target = path.join(output, file);
    const digest = containedPlainFileDigest(
      output,
      target,
      `verified Graphify ${file}`,
    );
    if (digest) snapshot.set(file, digest);
  }
  for (const required of REQUIRED_VERIFIED_GRAPHIFY_OUTPUT_FILES) {
    if (!snapshot.has(required)) {
      throw new Error(`verified Graphify ${required} is missing`);
    }
  }
  return snapshot;
}

function sameGraphifyFileSnapshot(left, right) {
  return left.size === right.size &&
    [...left].every(([file, digest]) => right.get(file) === digest);
}

function installVerifiedGraphifyOutput(
  repository,
  destinationPaths,
  isolatedPaths,
) {
  const backupName =
    `.meta-kim-graphify-previous-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
  const previousOutput = path.join(repository.repoRoot, backupName);
  let previousMoved = false;
  let nextInstalled = false;
  let boundSnapshot = null;
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const before = snapshotVerifiedGraphifyFiles(isolatedPaths.output);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      const after = snapshotVerifiedGraphifyFiles(isolatedPaths.output);
      if (sameGraphifyFileSnapshot(before, after)) {
        boundSnapshot = after;
        break;
      }
    }
    if (!boundSnapshot) {
      throw new Error("verified Graphify output did not become stable for atomic installation");
    }
    const current = assertPlainGraphifyPaths(repository.repoRoot, {
      requireArtifacts: false,
    });
    if (pathIdentity(current.output) !== pathIdentity(destinationPaths.output)) {
      throw new Error("Graphify destination changed during isolated build");
    }
    if (existsSync(current.output)) {
      renameWithTransientRetry(current.output, previousOutput);
      previousMoved = true;
    }
    if (existsSync(current.output)) {
      throw new Error("Graphify destination was recreated during atomic installation");
    }
    renameWithTransientRetry(isolatedPaths.output, current.output);
    nextInstalled = true;
    const installed = assertPlainGraphifyPaths(repository.repoRoot, {
      requireArtifacts: true,
    });
    const installedSnapshot = snapshotVerifiedGraphifyFiles(installed.output);
    if (!sameGraphifyFileSnapshot(boundSnapshot, installedSnapshot)) {
      throw new Error("installed Graphify output failed full snapshot binding");
    }
  } catch (error) {
    const currentOutput = destinationPaths.output;
    if (nextInstalled && existsSync(currentOutput)) {
      const installed = assertPlainGraphifyPaths(repository.repoRoot, {
        requireArtifacts: true,
      });
      const installedGraph = containedPlainFileDigest(
        installed.output,
        installed.graphPath,
        "failed installed Graphify graph",
      );
      if (installedGraph === boundSnapshot?.get("graph.json")) {
        renameWithTransientRetry(
          currentOutput,
          path.join(path.dirname(isolatedPaths.output), "graphify-out-failed"),
        );
      }
    }
    if (previousMoved && !existsSync(currentOutput) && existsSync(previousOutput)) {
      renameWithTransientRetry(previousOutput, currentOutput);
    }
    throw error;
  }
  if (previousMoved) {
    console.log(
      `Previous local Graphify output retained at ${backupName}.`,
    );
  }
}

function runVerifiedLocalGraphifyUpdate(
  repository,
  destinationPaths,
  launcher,
) {
  const repositoryParent = realpathSync.native(
    path.dirname(repository.repoRoot),
  );
  const tempRoot = mkdtempSync(
    path.join(repositoryParent, ".meta-kim-graphify-verified-"),
  );
  if (
    path.parse(tempRoot).root.toLowerCase() !==
      path.parse(repository.repoRoot).root.toLowerCase() ||
    !isContained(repositoryParent, realpathSync.native(tempRoot))
  ) {
    throw new Error("verified Graphify worktree is not on the repository volume");
  }
  const workspace = path.join(tempRoot, "repo");
  let worktreeAdded = false;
  try {
    const added = spawnSync(
      "git",
      ["worktree", "add", "--detach", workspace, repository.currentHead],
      {
        cwd: repository.repoRoot,
        encoding: "utf8",
        shell: false,
        env: sanitizedGitEnvironment(),
        windowsHide: true,
      },
    );
    if (added.status !== 0 || added.error) {
      throw new Error("isolated Graphify worktree could not be created");
    }
    worktreeAdded = true;

    for (const repositoryFile of repository.repositoryFiles) {
      const source = path.join(
        repository.repoRoot,
        ...repositoryFile.split("/"),
      );
      const target = path.join(workspace, ...repositoryFile.split("/"));
      const sourceStats = lstatSync(source);
      if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
        throw new Error("repository snapshot contains a non-plain file");
      }
      if (!isContained(workspace, target)) {
        throw new Error("repository snapshot path escaped isolated worktree");
      }
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(source, target);
    }

    const isolatedOutput = path.join(workspace, "graphify-out");
    if (existsSync(isolatedOutput)) {
      if (!isContained(tempRoot, isolatedOutput)) {
        throw new Error("isolated Graphify output escaped temporary root");
      }
      rmSync(isolatedOutput, { recursive: true, force: true });
    }
    const isolatedRepository = readRepositoryContext(workspace);
    if (
      !isolatedRepository ||
      !commitsMatch(isolatedRepository.currentHead, repository.currentHead) ||
      repositoryFilesDigest(isolatedRepository.repositoryFiles) !==
        repositoryFilesDigest(repository.repositoryFiles) ||
      isolatedRepository.repositoryStateSha256 !==
        repository.repositoryStateSha256
    ) {
      throw new Error("isolated Graphify worktree does not match the source snapshot");
    }

    const updated = runGraphifyUpdateForRebuild(
      ["update", ".", "--force"],
      {
        cwd: workspace,
        launcher,
        env: verifiedGraphifyEnvironment(),
        requireDirect: true,
      },
    );
    if ((updated.status || 0) !== 0) {
      throw new Error("isolated Graphify update failed");
    }
    const isolatedPaths = assertPlainGraphifyPaths(workspace, {
      requireArtifacts: true,
    });
    for (const required of ["graph.json", ".graphify_analysis.json", "GRAPH_REPORT.md"]) {
      containedPlainFileDigest(
        isolatedPaths.output,
        path.join(isolatedPaths.output, required),
        `isolated Graphify ${required}`,
      );
    }

    installVerifiedGraphifyOutput(
      repository,
      destinationPaths,
      isolatedPaths,
    );
  } finally {
    let cleanupFailure = null;
    if (worktreeAdded) {
      const removed = spawnSync("git", ["worktree", "remove", "--force", workspace], {
        cwd: repository.repoRoot,
        encoding: "utf8",
        shell: false,
        env: sanitizedGitEnvironment(),
        windowsHide: true,
      });
      if (removed.status !== 0 || removed.error) {
        cleanupFailure = "isolated Graphify worktree removal failed";
      }
    }
    if (existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
    if (worktreeAdded) {
      const pruned = spawnSync("git", ["worktree", "prune"], {
        cwd: repository.repoRoot,
        encoding: "utf8",
        shell: false,
        env: sanitizedGitEnvironment(),
        windowsHide: true,
      });
      if (pruned.status !== 0 || pruned.error) {
        cleanupFailure = "isolated Graphify worktree prune failed";
      } else if (cleanupFailure) {
        cleanupFailure = null;
      }
    }
    if (cleanupFailure) {
      throw new Error(cleanupFailure);
    }
  }
}

function existingExtractCounts(graph, analysisSidecar) {
  return {
    nodes: Array.isArray(graph?.nodes) ? graph.nodes.length : 0,
    links: Array.isArray(graph?.links) ? graph.links.length : 0,
    communities:
      analysisSidecar?.communities &&
      typeof analysisSidecar.communities === "object" &&
      !Array.isArray(analysisSidecar.communities)
        ? Object.keys(analysisSidecar.communities).length
        : 0,
  };
}

function inspectExistingExtractSnapshot(paths, repository) {
  const worktreeStatus = gitText(repository.repoRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (worktreeStatus == null) {
    throw new Error("existing extract adoption could not inspect repository status");
  }
  const meaningfulStatus = worktreeStatus
    .split(/\r?\n/u)
    .filter(Boolean)
    .filter((line) => !/\?\? \.gitattributes$/u.test(line));
  if (meaningfulStatus.length > 0) {
    throw new Error(
      "repository content changed after the existing extract artifacts were written",
    );
  }
  const rawGraphSha256 = containedPlainFileDigest(
    paths.output,
    paths.graphPath,
    "Graphify existing extract graph",
  );
  const rawAnalysisSha256 = containedPlainFileDigest(
    paths.output,
    paths.analysisPath,
    "Graphify existing extract analysis",
  );
  const rawReportSha256 = containedPlainFileDigest(
    paths.output,
    paths.reportPath,
    "Graphify existing extract report",
  );
  if (!rawGraphSha256 || !rawAnalysisSha256 || !rawReportSha256) {
    throw new Error(
      "existing extract adoption requires graph, analysis, and report plain files",
    );
  }

  const graph = JSON.parse(readFileSync(paths.graphPath, "utf8"));
  const analysisSidecar = readGraphifyAnalysisSidecar(paths);
  const reportRaw = readFileSync(paths.reportPath, "utf8");
  const rawReportCommit = extractRawReportCommit(reportRaw);
  if (
    !commitsMatch(graph?.built_at_commit, repository.currentHead) ||
    !rawReportCommit ||
    !String(repository.currentHead)
      .toLowerCase()
      .startsWith(String(rawReportCommit).toLowerCase())
  ) {
    throw new Error(
      "existing extract graph/report is not bound to the current HEAD",
    );
  }
  const sanitizedReport = sanitizeKnownMetaKimHomeAliases(reportRaw);
  if (hasPrivateLocalPath(sanitizedReport)) {
    throw new Error("existing extract report still contains a private local path");
  }
  const reportedCounts = reportGraphCounts(reportRaw);
  const actualCounts = existingExtractCounts(graph, analysisSidecar);
  if (
    !reportedCounts ||
    reportedCounts.nodes !== actualCounts.nodes ||
    reportedCounts.links !== actualCounts.links ||
    reportedCounts.communities !== actualCounts.communities
  ) {
    throw new Error(
      "existing extract report counts do not match graph and analysis artifacts",
    );
  }

  const oldestArtifactMtimeMs = Math.min(
    statSync(paths.graphPath).mtimeMs,
    statSync(paths.analysisPath).mtimeMs,
    statSync(paths.reportPath).mtimeMs,
  );
  let latestRepositoryMtimeMs = 0;
  for (const repositoryFile of repository.repositoryFiles) {
    latestRepositoryMtimeMs = Math.max(
      latestRepositoryMtimeMs,
      statSync(
        path.join(repository.repoRoot, ...repositoryFile.split("/")),
      ).mtimeMs,
    );
  }
  if (latestRepositoryMtimeMs > oldestArtifactMtimeMs) {
    throw new Error(
      "repository content changed after the existing extract artifacts were written",
    );
  }

  return {
    graph,
    analysisSidecar,
    reportRaw,
    sanitizedReport,
    evidence: {
      schemaVersion: GRAPHIFY_EXISTING_EXTRACT_ADOPTION_SCHEMA,
      status: "verified_existing_extract_snapshot",
      builtCommit: repository.currentHead,
      repositoryFilesSha256: repositoryFilesDigest(
        repository.repositoryFiles,
      ),
      repositoryStateSha256: repository.repositoryStateSha256,
      rawGraphSha256,
      rawAnalysisSha256,
      rawReportSha256,
      latestRepositoryMtimeMs,
      oldestArtifactMtimeMs,
    },
  };
}

function adoptExistingExtract(paths, repository) {
  const inspected = inspectExistingExtractSnapshot(paths, repository);
  const original = {
    graph: readFileSync(paths.graphPath),
    analysis: readFileSync(paths.analysisPath),
    report: readFileSync(paths.reportPath),
  };
  try {
    if (inspected.sanitizedReport !== inspected.reportRaw) {
      atomicWritePlainFile(paths.reportPath, inspected.sanitizedReport);
    }

    const sanitization = sanitizeGraphForClustering(paths, repository);
    const graph = JSON.parse(readFileSync(paths.graphPath, "utf8"));
    const analysisSidecar = readGraphifyAnalysisSidecar(paths);
    const proofNormalizer = graphRuntimeNormalizer(graph, repository, {
      analysisSidecar,
    });
    graph.meta_kim_enrichment.existingExtractAdoption = inspected.evidence;
    const identity = applyGraphNodeIdentityProof(graph, {
      repositoryFiles: repository.repositoryFiles,
      repositoryStateSha256: repository.repositoryStateSha256,
      builtCommit: repository.currentHead,
      normalizeNodeId: proofNormalizer.normalize,
      nodeIdNormalization: proofNormalizer.descriptor,
      analysisSidecar,
      requireAnalysisSidecar:
        proofNormalizer.descriptor !== GRAPHIFY_NODE_ID_NORMALIZATION,
    });
    if (identity.proof.status !== "verified_graph_file_identity") {
      throw new Error("existing extract does not cover the current repository identity");
    }
    atomicWritePlainFile(paths.graphPath, `${JSON.stringify(graph, null, 2)}\n`);

    refreshRepositorySnapshot(repository, "existing-extract adoption");
    writeMigrationState(
      paths,
      repository,
      sanitization.requiresRecluster ? "extract_complete" : "cluster_complete",
    );
    const checkpoint = inspectMigrationState(paths, repository);
    if (checkpoint.status !== "valid") {
      throw new Error("existing extract adoption checkpoint could not be verified");
    }
    return checkpoint.state;
  } catch (error) {
    atomicWritePlainFile(paths.graphPath, original.graph);
    atomicWritePlainFile(paths.analysisPath, original.analysis);
    atomicWritePlainFile(paths.reportPath, original.report);
    clearMigrationState(paths);
    throw error;
  }
}

function migrationSnapshotPaths(output) {
  return {
    graph: path.join(output, ".meta-kim-extract-graph.json"),
    analysis: path.join(output, ".meta-kim-extract-analysis.json"),
  };
}

function inspectMigrationState(paths, repository) {
  const statePath = migrationStatePath(paths.output);
  if (!existsSync(statePath) || !existsSync(paths.graphPath)) {
    return { status: "missing", state: null };
  }
  const stats = lstatSync(statePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("Graphify migration state is not a plain file");
  }
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    if (
      state.schemaVersion !== GRAPHIFY_MIGRATION_STATE_SCHEMA ||
      !["extract_complete", "cluster_complete"].includes(state.stage) ||
      !commitsMatch(state.builtCommit, repository.currentHead) ||
      state.repositoryFilesSha256 !== repositoryFilesDigest(repository.repositoryFiles) ||
      state.repositoryStateSha256 !== repository.repositoryStateSha256
    ) {
      return { status: "stale", state };
    }
    const snapshots = migrationSnapshotPaths(paths.output);
    if (
      state.extractGraphSha256 !==
        containedPlainFileDigest(
          paths.output,
          snapshots.graph,
          "Graphify extract graph snapshot",
        ) ||
      state.extractAnalysisSha256 !==
        containedPlainFileDigest(
          paths.output,
          snapshots.analysis,
          "Graphify extract analysis snapshot",
        )
    ) {
      return { status: "invalid", state };
    }
    if (
      state.graphSha256 !== graphFileDigest(paths.graphPath) ||
      state.analysisSha256 !==
        containedPlainFileDigest(
          paths.output,
          paths.analysisPath,
          "Graphify analysis sidecar",
        ) ||
      (state.stage === "cluster_complete" &&
        state.reportSha256 !==
          containedPlainFileDigest(
            paths.output,
            paths.reportPath,
            "Graphify report",
          ))
    ) {
      return { status: "in_doubt", state };
    }
    return { status: "valid", state };
  } catch {
    return { status: "invalid", state: null };
  }
}

function writeMigrationState(paths, repository, stage) {
  assertPlainGraphifyPaths(repository.repoRoot, { requireArtifacts: true });
  const snapshots = migrationSnapshotPaths(paths.output);
  if (stage === "extract_complete") {
    containedPlainFileDigest(
      paths.output,
      snapshots.graph,
      "Graphify extract graph snapshot",
    );
    containedPlainFileDigest(
      paths.output,
      snapshots.analysis,
      "Graphify extract analysis snapshot",
    );
    atomicWritePlainFile(snapshots.graph, readFileSync(paths.graphPath, "utf8"));
    if (existsSync(paths.analysisPath)) {
      atomicWritePlainFile(
        snapshots.analysis,
        readFileSync(paths.analysisPath, "utf8"),
      );
    } else if (existsSync(snapshots.analysis)) {
      rmSync(snapshots.analysis, { force: true });
    }
  }
  const state = {
    schemaVersion: GRAPHIFY_MIGRATION_STATE_SCHEMA,
    stage,
    builtCommit: repository.currentHead,
    repositoryFilesSha256: repositoryFilesDigest(repository.repositoryFiles),
    repositoryStateSha256: repository.repositoryStateSha256,
    graphSha256: graphFileDigest(paths.graphPath),
    analysisSha256: containedPlainFileDigest(
      paths.output,
      paths.analysisPath,
      "Graphify analysis sidecar",
    ),
    reportSha256:
      stage === "cluster_complete"
        ? containedPlainFileDigest(
            paths.output,
            paths.reportPath,
            "Graphify report",
          )
        : null,
    extractGraphSha256: containedPlainFileDigest(
      paths.output,
      snapshots.graph,
      "Graphify extract graph snapshot",
    ),
    extractAnalysisSha256: containedPlainFileDigest(
      paths.output,
      snapshots.analysis,
      "Graphify extract analysis snapshot",
    ),
  };
  atomicWritePlainFile(migrationStatePath(paths.output), `${JSON.stringify(state, null, 2)}\n`);
}

function restoreMigrationInput(paths, state) {
  const snapshots = migrationSnapshotPaths(paths.output);
  if (
    state.extractGraphSha256 !==
      containedPlainFileDigest(
        paths.output,
        snapshots.graph,
        "Graphify extract graph snapshot",
      ) ||
    state.extractAnalysisSha256 !==
      containedPlainFileDigest(
        paths.output,
        snapshots.analysis,
        "Graphify extract analysis snapshot",
      )
  ) {
    throw new Error("Graphify extract snapshot is missing or inconsistent");
  }
  atomicWritePlainFile(paths.graphPath, readFileSync(snapshots.graph, "utf8"));
  if (state.extractAnalysisSha256) {
    atomicWritePlainFile(
      paths.analysisPath,
      readFileSync(snapshots.analysis, "utf8"),
    );
  } else if (existsSync(paths.analysisPath)) {
    rmSync(paths.analysisPath, { force: true });
  }
}

function clearMigrationState(paths) {
  const statePath = migrationStatePath(paths.output);
  if (existsSync(statePath)) {
    const stats = lstatSync(statePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("Graphify migration state is not a plain file");
    }
    rmSync(statePath, { force: true });
  }
  const snapshots = migrationSnapshotPaths(paths.output);
  for (const snapshot of Object.values(snapshots)) {
    if (existsSync(snapshot)) {
      containedPlainFileDigest(
        paths.output,
        snapshot,
        "Graphify extract snapshot",
      );
      rmSync(snapshot, { force: true });
    }
  }
}

function graphIdentityMigrationPlan(
  cwd = process.cwd(),
  runtimeBinding = null,
) {
  const repository = readRepositoryContext(cwd);
  if (!repository) throw new Error("Graphify rebuild must run from the real Git repository root");
  const paths = assertPlainGraphifyPaths(repository.repoRoot, { requireArtifacts: false });
  if (!existsSync(paths.graphPath)) {
    return { repository, paths, fullExtract: true };
  }
  const graph = JSON.parse(readFileSync(paths.graphPath, "utf8"));
  const analysisSidecar = readGraphifyAnalysisSidecar(paths);
  const nodeNormalizer = graphRuntimeNormalizer(graph, repository, {
    honorStoredAscii: true,
    analysisSidecar,
    runtimeBinding,
  });
  const stored = graph?.meta_kim_enrichment?.nodeIdentity;
  const analysis = analyzeGraphNodeIdentity(graph, {
    repositoryFiles: repository.repositoryFiles,
    repositoryStateSha256:
      stored &&
      Object.prototype.hasOwnProperty.call(stored, "repositoryStateSha256")
        ? stored.repositoryStateSha256
        : repository.repositoryStateSha256,
    normalizeNodeId: nodeNormalizer.normalize,
    nodeIdNormalization: nodeNormalizer.descriptor,
    analysisSidecar,
    requireAnalysisSidecar:
      nodeNormalizer.descriptor !== GRAPHIFY_NODE_ID_NORMALIZATION,
  });
  const legacyV2ProofUpgrade =
    stored?.schemaVersion === GRAPH_NODE_IDENTITY_SCHEMA &&
    (
      typeof stored?.graphContentSha256 !== "string" ||
      !stored?.analysisCommunityCoverageIssues ||
      !Object.prototype.hasOwnProperty.call(
        stored,
        "repositoryStateSha256",
      )
    );
  const trustedStoredBaseline =
    stored?.schemaVersion === GRAPH_NODE_IDENTITY_SCHEMA &&
    stored?.status === "verified_graph_file_identity" &&
    stored?.repositoryFilesSha256 === analysis.repositoryFilesSha256 &&
    stored?.repositoryPathPolicy === analysis.repositoryPathPolicy &&
    stored?.nodeIdNormalization === analysis.nodeIdNormalization &&
    stored?.fileNodeBindingsSha256 === analysis.fileNodeBindingsSha256 &&
    stored?.nodeIdsSha256 === analysis.nodeIdsSha256 &&
    stored?.linkEndpointsSha256 === analysis.linkEndpointsSha256 &&
    stored?.hyperedgeReferencesSha256 === analysis.hyperedgeReferencesSha256 &&
    stored?.analysisSidecarSha256 === analysis.analysisSidecarSha256 &&
    stored?.nodeProvenanceSha256 === analysis.nodeProvenanceSha256 &&
    stored?.outputSanitizationSha256 === analysis.outputSanitizationSha256 &&
    (
      legacyV2ProofUpgrade ||
      (
        stored?.graphContentSha256 === analysis.graphContentSha256 &&
        stored?.evidenceSha256 === analysis.evidenceSha256
      )
    ) &&
    JSON.stringify(stored?.fileNodeBindings ?? null) ===
      JSON.stringify(analysis.fileNodeBindings);
  return {
    repository,
    paths,
    fullExtract:
      analysis.requiresUpstreamReextract === true || !trustedStoredBaseline,
  };
}

function processOutputText(result) {
  return `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
}

function isGraphifySmallerGraphRefusal(result) {
  return /Refusing to overwrite/i.test(processOutputText(result));
}

function runGraphifyUpdate(graphifyArgs, options = {}) {
  const launcher = options.launcher ?? graphifyLauncher();
  const direct = spawnSync(launcher.command, [...launcher.args, ...graphifyArgs], {
    cwd: options.cwd,
    stdio: options.stdio ?? "inherit",
    encoding: options.encoding,
    shell: false,
    env: options.env ?? sanitizedGitEnvironment(),
    windowsHide: true,
  });
  if (!direct.error) {
    return { result: direct, usedDirect: true };
  }
  if (options.requireDirect === true) {
    return { result: direct, usedDirect: true };
  }

  const python = ensurePython({ requirePip: true });
  if (!python) {
    return { result: { status: process.exitCode || 1 }, usedDirect: false };
  }

  const result = runPythonModule(
    python,
    ["-m", "graphify", ...graphifyArgs],
    undefined,
    {
      stdio: options.stdio ?? "inherit",
      encoding: options.encoding,
      cwd: options.cwd,
      env: options.env ?? sanitizedGitEnvironment(),
    },
  );
  return { result, usedDirect: false };
}

function runGraphifyUpdateForRebuild(graphifyArgs, options = {}) {
  if (graphifyArgs.includes("--force")) {
    return runGraphifyUpdate(graphifyArgs, {
      stdio: "inherit",
      ...options,
    }).result;
  }

  const first = runGraphifyUpdate(graphifyArgs, {
    stdio: "pipe",
    encoding: "utf8",
    ...options,
  }).result;
  if ((first.status || 0) === 0) {
    process.stdout.write(first.stdout ?? "");
    process.stderr.write(first.stderr ?? "");
    return first;
  }

  if (!isGraphifySmallerGraphRefusal(first)) {
    process.stdout.write(first.stdout ?? "");
    process.stderr.write(first.stderr ?? "");
    return first;
  }

  process.stdout.write(first.stdout ?? "");
  process.stderr.write(first.stderr ?? "");
  console.warn(
    "graphify rebuild produced fewer nodes; retrying with --force and stamping the new graph to current HEAD.",
  );
  return runGraphifyUpdate([...graphifyArgs, "--force"], {
    stdio: "inherit",
    ...options,
  }).result;
}

function runCheck() {
  const python = ensurePython({ requirePip: true });
  if (!python) {
    return;
  }

  console.log(python.versionText);

  const located = locateGraphifyInstallation(python);
  if (!located) {
    fail("graphify not installed");
    return;
  }

  if (pythonKey(located.python) !== pythonKey(python)) {
    console.log(
      `graphifyy located via ${formatPythonLauncher(located.python)} (${located.python.versionText})`,
    );
  }

  const version = extractPipShowVersion(located.pipShowText) ?? "unknown";
  console.log(`graphify ${version}`);
  checkGraphFreshness();
}

function installGraphify({ upgrade = false } = {}) {
  const python = ensurePython({ requirePip: true });
  if (!python) {
    return;
  }

  console.log(`Using ${formatPythonLauncher(python)} (${python.versionText})`);

  const pipArgs = ["-m", "pip", "install"];
  if (upgrade) {
    pipArgs.push("--upgrade");
  }
  pipArgs.push("graphifyy");

  const pipResult = runPythonModule(python, pipArgs, undefined, {
    stdio: "inherit",
  });
  if (pipResult.status !== 0) {
    process.exitCode = pipResult.status || 1;
    return;
  }

  const installResult = runPythonModule(
    python,
    ["-m", "graphify", "claude", "install"],
    undefined,
    { stdio: "inherit" },
  );
  if (installResult.status !== 0) {
    process.exitCode = installResult.status || 1;
    return;
  }

  const hookResult = runPythonModule(
    python,
    ["-m", "graphify", "hook", "install"],
    undefined,
    { stdio: "inherit" },
  );
  if (hookResult.status !== 0) {
    process.exitCode = hookResult.status || 1;
  }

  sanitizeGraphifyHookSettings(resolveGraphifyExecutable(python));
}

// graphify's upstream `hook install` writes Windows shell-form commands
// (`C:\...\graphify.EXE hook-guard read`) that Git Bash mangles. Rewrite them
// into direct-spawn `command` + `args` form so the path survives verbatim.
function sanitizeGraphifyHookSettings(graphifyExecutable) {
  if (process.platform !== "win32") return;
  const targets = [
    path.join(process.cwd(), ".claude", "settings.json"),
    path.join(homedir(), ".claude", "settings.json"),
  ];
  for (const target of targets) {
    const result = sanitizeGraphifyWindowsHooks(target, { graphifyExecutable });
    if (result.changed) {
      console.log(
        `Rewrote ${result.count} graphify hook command(s) in ${target} to direct-spawn form (backup: ${result.backup})`,
      );
    }
  }
}

function runRebuild() {
  const initialRepository = readRepositoryContext(process.cwd());
  if (!initialRepository) {
    fail("Graphify rebuild must run from the real Git repository root");
    return;
  }
  let initialPaths;
  try {
    initialPaths = assertPlainGraphifyPaths(initialRepository.repoRoot, {
      requireArtifacts: false,
    });
  } catch (error) {
    fail(`Graphify rebuild refused unsafe repository state: ${error.message}`);
    return;
  }
  let migrationInspection;
  try {
    migrationInspection = inspectMigrationState(initialPaths, initialRepository);
  } catch (error) {
    fail(`Graphify migration state is unsafe: ${error.message}`);
    return;
  }
  const verifiedLocalUpdate = process.argv.includes("--verified-local-update");
  let verifiedLauncher = null;
  let verifiedRuntimeBinding = null;
  if (
    verifiedLocalUpdate &&
    process.argv.includes("--adopt-existing-extract")
  ) {
    fail("Graphify verified local update and existing-extract adoption are mutually exclusive");
    return;
  }
  if (verifiedLocalUpdate) {
    const verifiedOverrideKeys = [
      "META_KIM_GRAPHIFY_BIN",
      "META_KIM_GRAPHIFY_BIN_ARGS",
      "META_KIM_GRAPHIFY_PYTHON",
      "META_KIM_GRAPHIFY_NORMALIZER_PYTHON",
    ];
    if (
      Object.keys(process.env).some((key) =>
        verifiedOverrideKeys.includes(key.toUpperCase()) &&
        String(process.env[key] ?? "").trim(),
      )
    ) {
      fail(
        "Graphify verified local update rejects executable and Python overrides; release evidence must use the installed Python module",
      );
      return;
    }
    try {
      verifiedLauncher = verifiedGraphifyLauncher();
      verifiedRuntimeBinding = {
        launcher: verifiedLauncher,
        environment: verifiedGraphifyEnvironment(),
      };
    } catch (error) {
      fail(`Graphify verified producer could not be bound: ${error.message}`);
      return;
    }
    try {
      clearMigrationState(initialPaths);
    } catch (error) {
      fail(`Graphify verified local update could not clear stale recovery state: ${error.message}`);
      return;
    }
    console.log(
      `Running Graphify ${verifiedLauncher.version} from bound console script ${verifiedLauncher.executableSha256.slice(0, 12)} in an isolated empty worktree (no LLM).`,
    );
    try {
      runVerifiedLocalGraphifyUpdate(
        initialRepository,
        initialPaths,
        verifiedLauncher,
      );
      const repository = refreshRepositorySnapshot(
        initialRepository,
        "verified local update",
      );
      const paths = assertPlainGraphifyPaths(repository.repoRoot, {
        requireArtifacts: true,
      });
      writeMigrationState(paths, repository, "extract_complete");
      migrationInspection = inspectMigrationState(paths, repository);
      if (migrationInspection.status !== "valid") {
        throw new Error("verified local update checkpoint could not be verified");
      }
    } catch (error) {
      fail(`Graphify verified local update produced unsafe artifacts: ${error.message}`);
      return;
    }
  }
  if (process.argv.includes("--adopt-existing-extract")) {
    if (migrationInspection.status !== "missing") {
      fail(
        "Graphify existing-extract adoption requires uncheckpointed raw artifacts",
      );
      return;
    }
    try {
      adoptExistingExtract(initialPaths, initialRepository);
      migrationInspection = inspectMigrationState(
        initialPaths,
        initialRepository,
      );
      console.log(
        "Adopted the existing Graphify extract as maintainer-authorized recovery evidence; release verification must still run --verified-local-update.",
      );
    } catch (error) {
      fail(`Graphify existing extract could not be adopted safely: ${error.message}`);
      return;
    }
  }
  let migrationState =
    migrationInspection.status === "valid"
      ? migrationInspection.state
      : migrationInspection.status === "in_doubt"
        ? { ...migrationInspection.state, stage: "extract_complete" }
        : null;
  if (migrationInspection.status === "in_doubt") {
    console.warn(
      "Graphify migration checkpoint is in_doubt after a graph change; rerunning cluster before any release-safe stamp.",
    );
    try {
      restoreMigrationInput(initialPaths, migrationInspection.state);
      writeMigrationState(
        initialPaths,
        initialRepository,
        "extract_complete",
      );
      migrationState = inspectMigrationState(
        initialPaths,
        initialRepository,
      ).state;
    } catch (error) {
      fail(`Graphify migration checkpoint could not restore its extract snapshot: ${error.message}`);
      return;
    }
  }
  let plan;
  try {
    plan = graphIdentityMigrationPlan(
      process.cwd(),
      verifiedRuntimeBinding,
    );
  } catch (error) {
    fail(`Graphify rebuild refused unsafe repository state: ${error.message}`);
    return;
  }
  const migrationInProgress = plan.fullExtract || migrationState !== null;
  const migrationBackendArgs = migrationInProgress
    ? verifiedLocalUpdate
      ? ["--no-label", "--no-viz"]
      : graphifyMigrationBackendArgs()
    : [];

  if (migrationInProgress && !migrationState) {
    console.log(
      "Graphify has real legacy/unsafe file-node identities; running one resumable upstream extract --force migration.",
    );
    const extracted = runGraphifyUpdateForRebuild([
      "extract",
      ".",
      "--force",
      ...migrationBackendArgs,
    ]);
    process.exitCode = extracted.status || 0;
    if ((extracted.status || 0) !== 0) return;
    try {
      plan.repository = refreshRepositorySnapshot(
        plan.repository,
        "extract",
      );
      plan.paths = assertPlainGraphifyPaths(plan.repository.repoRoot, { requireArtifacts: true });
      writeMigrationState(plan.paths, plan.repository, "extract_complete");
      const checkpoint = inspectMigrationState(plan.paths, plan.repository);
      migrationState = checkpoint.status === "valid" ? checkpoint.state : null;
      if (!migrationState) throw new Error("extract checkpoint could not be verified");
    } catch (error) {
      fail(`Graphify extract completed but its resume checkpoint is unsafe: ${error.message}`);
      return;
    }
  }

  if (migrationInProgress && migrationState) {
    try {
      const sanitized = sanitizeGraphForClustering(
        plan.paths,
        plan.repository,
        verifiedRuntimeBinding,
      );
      if (
        sanitized.requiresRecluster ||
        migrationState.stage === "extract_complete"
      ) {
        writeMigrationState(plan.paths, plan.repository, "extract_complete");
        const checkpoint = inspectMigrationState(plan.paths, plan.repository);
        migrationState = checkpoint.status === "valid" ? checkpoint.state : null;
        if (migrationState?.stage !== "extract_complete") {
          throw new Error("sanitized clustering input checkpoint could not be verified");
        }
      }
    } catch (error) {
      fail(`Graphify output could not be normalized before clustering: ${error.message}`);
      return;
    }
  }

  if (migrationInProgress && migrationState?.stage === "extract_complete") {
    try {
      plan.repository = refreshRepositorySnapshot(
        plan.repository,
        "pre-cluster",
      );
    } catch (error) {
      fail(`Graphify clustering refused a mixed repository snapshot: ${error.message}`);
      return;
    }
    console.log("Resuming Graphify identity migration from the completed extract checkpoint.");
    const clustered = runGraphifyUpdate(
      ["cluster-only", ".", ...migrationBackendArgs],
      {
        stdio: "inherit",
        ...(verifiedLocalUpdate
          ? {
              launcher: verifiedLauncher,
              env: verifiedGraphifyEnvironment(),
              requireDirect: true,
            }
          : {}),
      },
    ).result;
    process.exitCode = clustered.status || 0;
    if ((clustered.status || 0) !== 0) return;
    try {
      plan.repository = refreshRepositorySnapshot(
        plan.repository,
        "cluster",
      );
      plan.paths = assertPlainGraphifyPaths(plan.repository.repoRoot, { requireArtifacts: true });
      writeMigrationState(plan.paths, plan.repository, "cluster_complete");
      const checkpoint = inspectMigrationState(plan.paths, plan.repository);
      migrationState = checkpoint.status === "valid" ? checkpoint.state : null;
      if (migrationState?.stage !== "cluster_complete") {
        throw new Error("cluster checkpoint could not be verified");
      }
    } catch (error) {
      fail(`Graphify clustering completed but its resume checkpoint is unsafe: ${error.message}`);
      return;
    }
  }

  if (!migrationInProgress) {
    const graphifyArgs = ["update", "."];
    if (process.argv.includes("--force")) graphifyArgs.push("--force");
    const updated = runGraphifyUpdateForRebuild(graphifyArgs);
    process.exitCode = updated.status || 0;
    if ((updated.status || 0) !== 0) return;
    try {
      plan.repository = refreshRepositorySnapshot(
        plan.repository,
        "update",
      );
      plan.paths = assertPlainGraphifyPaths(plan.repository.repoRoot, { requireArtifacts: true });
      const sanitized = sanitizeGraphForClustering(
        plan.paths,
        plan.repository,
        verifiedRuntimeBinding,
      );
      if (sanitized.requiresRecluster) {
        writeMigrationState(
          plan.paths,
          plan.repository,
          "extract_complete",
        );
        migrationState = inspectMigrationState(
          plan.paths,
          plan.repository,
        ).state;
        const clusterBackendArgs = graphifyMigrationBackendArgs();
        const clustered = runGraphifyUpdate(
          ["cluster-only", ".", ...clusterBackendArgs],
          { stdio: "inherit" },
        ).result;
        process.exitCode = clustered.status || 0;
        if ((clustered.status || 0) !== 0) return;
        plan.repository = refreshRepositorySnapshot(
          plan.repository,
          "post-update cluster",
        );
        plan.paths = assertPlainGraphifyPaths(
          plan.repository.repoRoot,
          { requireArtifacts: true },
        );
        writeMigrationState(
          plan.paths,
          plan.repository,
          "cluster_complete",
        );
        const checkpoint = inspectMigrationState(
          plan.paths,
          plan.repository,
        );
        migrationState =
          checkpoint.status === "valid" ? checkpoint.state : null;
        if (migrationState?.stage !== "cluster_complete") {
          throw new Error(
            "post-update cluster checkpoint could not be verified",
          );
        }
      }
    } catch (error) {
      fail(`Graphify update produced unsafe artifacts: ${error.message}`);
      return;
    }
  }

  try {
    plan.repository = refreshRepositorySnapshot(
      plan.repository,
      "pre-stamp",
    );
  } catch (error) {
    fail(`Graphify stamping refused a mixed repository snapshot: ${error.message}`);
    return;
  }
  if (!stampGraphFreshness(
    plan.repository.repoRoot,
    verifiedRuntimeBinding,
  )) {
    process.exitCode = 1;
    return;
  }
  try {
    clearMigrationState(plan.paths);
  } catch (error) {
    fail(`Graphify migration state could not be closed safely: ${error.message}`);
  }
}

function runGraphifyPassthrough() {
  const graphifyArgs = process.argv.slice(2);
  const launcher = graphifyLauncher();
  const direct = spawnSync(launcher.command, [...launcher.args, ...graphifyArgs], {
    stdio: "inherit",
    shell: false,
    env: sanitizedGitEnvironment(),
    windowsHide: true,
  });
  if (!direct.error) {
    process.exitCode = direct.status ?? 1;
    return;
  }

  const python = ensurePython({ requirePip: true });
  if (!python) {
    return;
  }

  const result = runPythonModule(
    python,
    ["-m", "graphify", ...graphifyArgs],
    undefined,
    { stdio: "inherit", env: sanitizedGitEnvironment() },
  );
  process.exitCode = result.status ?? 1;
}

switch (command) {
  case "check":
    runCheck();
    break;
  case "install":
    installGraphify({ upgrade: false });
    break;
  case "update":
    installGraphify({ upgrade: true });
    break;
  case "rebuild":
    runRebuild();
    break;
  case "query":
  case "path":
  case "explain":
    runGraphifyPassthrough();
    break;
  default:
    fail(`Unknown graphify command: ${command}`);
    break;
}
