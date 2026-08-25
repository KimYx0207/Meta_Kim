#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createReportContext } from "./report-context.mjs";
import { importDatabaseSync } from "../src/data/sqlite/runtime.mjs";

const reportContext = createReportContext();
const REPO_ROOT = reportContext.repoRoot;
const CONTRACT_PATH = path.join(REPO_ROOT, "config", "contracts", "product-delivery-bundle-contract.json");
const SCENARIO_PATH = path.join(
  REPO_ROOT,
  "tests",
  "meta-theory",
  "scenarios",
  "reviewer-calibration-samples.json",
);
function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const OUTPUT_DIR = path.resolve(
  argValue("--state-dir", reportContext.resolveStatePath("product-delivery-bundle")),
);
const BUNDLE_TASK =
  "Generate an AI-readable product delivery bundle with design, execution, acceptance, feedback, deliverables, reviewer calibration, runtime evidence, GitHub delta, and research evidence.";

const componentCommands = {
  governedRun: [
    "scripts/run-meta-theory-governed-execution.mjs",
    "--task",
    BUNDLE_TASK,
  ],
  deliverables: ["scripts/generate-meta-theory-run-deliverables.mjs"],
  githubGap: ["scripts/generate-github-gap-report.mjs"],
  runtimeMatrix: ["scripts/generate-runtime-live-shard-matrix.mjs"],
  orchestrationDag: ["scripts/generate-orchestration-dag-report.mjs"],
  research: ["scripts/generate-research-preparation-report.mjs"],
  feedback: ["scripts/generate-feedback-loop-report.mjs"],
};

const relativeToRepo = reportContext.relativeToRepo;

function publicOutputPath(filePath) {
  const relative = relativeToRepo(filePath);
  return path.isAbsolute(relative) || hasLocalAbsolutePath(relative)
    ? `@state/product-delivery-bundle/${path.basename(filePath)}`
    : relative;
}

function parseJsonFromStdout(stdout) {
  const jsonStart = stdout.indexOf("{");
  if (jsonStart === -1) throw new Error(`Command did not print JSON: ${stdout}`);
  return JSON.parse(stdout.slice(jsonStart));
}

function tryParseJsonFromStdout(stdout) {
  try {
    return parseJsonFromStdout(stdout);
  } catch {
    return null;
  }
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function governedArtifactPaths(stateDir, runId, language = "en") {
  return {
    artifactPath: path.join(stateDir, `${runId}.json`),
    markdownPath: path.join(stateDir, `${runId}.${language}.md`),
    reservationPath: path.join(stateDir, `${runId}.reservation.json`),
  };
}

async function atomicWriteText(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function readBundleLifecycleRow(dbPath, runId) {
  let db;
  try {
    const DatabaseSync = await importDatabaseSync();
    db = new DatabaseSync(dbPath, { readOnly: true });
    return db.prepare(`
      SELECT run_id, status, artifact_status, task_fingerprint, bundle_identity,
             json_sha256, markdown_sha256
      FROM product_delivery_bundle_runs
      WHERE run_id = ?
    `).get(runId) ?? null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

async function loadReusableGovernedRun({ runId, stateDir, dbPath, bundleIdentity }) {
  const artifactPath = path.join(stateDir, `${runId}.json`);
  const reservationPath = path.join(stateDir, `${runId}.reservation.json`);
  if (![artifactPath, reservationPath, dbPath].every(existsSync)) return null;
  try {
    const artifact = JSON.parse(statSync(artifactPath).size > 0
      ? requireText(artifactPath)
      : "null");
    const reservation = JSON.parse(requireText(reservationPath));
    const language = artifact?.resolvedOutputLanguage ?? "en";
    const markdownPath = path.join(stateDir, `${runId}.${language}.md`);
    if (!existsSync(markdownPath)) return null;
    const jsonSha256 = sha256Bytes(readFileSync(artifactPath));
    const markdownSha256 = sha256Bytes(readFileSync(markdownPath));
    const expectedStagingRefs = {
      json: `.${runId}.json.staging`,
      markdown: `.${runId}.${language}.md.staging`,
    };
    const expectedArtifactRefs = {
      json: path.basename(artifactPath),
      markdown: path.basename(markdownPath),
    };
    const lifecycleRow = await readBundleLifecycleRow(dbPath, runId);
    if (
      artifact?.schemaVersion !== 1 ||
      artifact?.runId !== runId ||
      artifact?.task !== BUNDLE_TASK ||
      !["pass", "partial"].includes(artifact?.status) ||
      reservation?.schemaVersion !== "governed-run-reservation-v0.1" ||
      reservation?.runId !== runId ||
      reservation?.taskFingerprint !== artifact.taskFingerprint ||
      reservation?.phase !== "materialized" ||
      reservation?.status !== "materialized" ||
      reservation?.jsonSha256 !== jsonSha256 ||
      reservation?.markdownSha256 !== markdownSha256 ||
      JSON.stringify(reservation?.stagingRefs) !== JSON.stringify(expectedStagingRefs) ||
      JSON.stringify(reservation?.artifactRefs) !== JSON.stringify(expectedArtifactRefs) ||
      statSync(dbPath).size <= 0 ||
      lifecycleRow?.run_id !== runId ||
      lifecycleRow?.status !== "materialized" ||
      lifecycleRow?.artifact_status !== artifact.status ||
      lifecycleRow?.task_fingerprint !== artifact.taskFingerprint ||
      lifecycleRow?.bundle_identity !== bundleIdentity ||
      lifecycleRow?.json_sha256 !== jsonSha256 ||
      lifecycleRow?.markdown_sha256 !== markdownSha256
    ) {
      return null;
    }
    return {
      status: artifact.status,
      runId,
      report: relativeToRepo(artifactPath),
      reusedGovernedRun: true,
    };
  } catch {
    return null;
  }
}

function requireText(filePath) {
  return readFileSync(filePath, "utf8");
}

async function finalizeGovernedRunLifecycle(lifecycle) {
  const provisionalArtifactPath = path.join(lifecycle.stateDir, `${lifecycle.runId}.json`);
  const artifact = JSON.parse(requireText(provisionalArtifactPath));
  if (
    artifact?.schemaVersion !== 1 ||
    artifact?.runId !== lifecycle.runId ||
    artifact?.task !== BUNDLE_TASK ||
    !["pass", "partial"].includes(artifact?.status) ||
    typeof artifact?.taskFingerprint !== "string" ||
    !artifact.taskFingerprint
  ) {
    throw new Error("Governed bundle artifact is incomplete and cannot be finalized.");
  }
  const language = artifact.resolvedOutputLanguage ?? "en";
  const paths = governedArtifactPaths(lifecycle.stateDir, lifecycle.runId, language);
  if (!existsSync(paths.markdownPath)) {
    throw new Error("Governed bundle markdown is missing and cannot be finalized.");
  }
  const jsonSha256 = sha256Bytes(readFileSync(paths.artifactPath));
  const markdownSha256 = sha256Bytes(readFileSync(paths.markdownPath));
  let priorReservation = {};
  try {
    priorReservation = JSON.parse(requireText(paths.reservationPath));
  } catch {
    // A missing or malformed managed reservation is reconstructed from the finished pair.
  }
  const now = new Date().toISOString();
  const reservation = {
    schemaVersion: "governed-run-reservation-v0.1",
    runId: lifecycle.runId,
    taskFingerprint: artifact.taskFingerprint,
    status: "materialized",
    phase: "materialized",
    jsonSha256,
    markdownSha256,
    stagingRefs: {
      json: `.${lifecycle.runId}.json.staging`,
      markdown: `.${lifecycle.runId}.${language}.md.staging`,
    },
    artifactRefs: {
      json: path.basename(paths.artifactPath),
      markdown: path.basename(paths.markdownPath),
    },
    reservedAt: priorReservation.reservedAt ?? now,
    updatedAt: now,
  };
  await atomicWriteText(paths.reservationPath, `${JSON.stringify(reservation, null, 2)}\n`);

  const DatabaseSync = await importDatabaseSync();
  const db = new DatabaseSync(lifecycle.dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS product_delivery_bundle_runs (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        artifact_status TEXT NOT NULL,
        task_fingerprint TEXT NOT NULL,
        bundle_identity TEXT NOT NULL,
        json_sha256 TEXT NOT NULL,
        markdown_sha256 TEXT NOT NULL,
        materialized_at TEXT NOT NULL
      )
    `);
    db.prepare(`
      INSERT OR REPLACE INTO product_delivery_bundle_runs
      (run_id, status, artifact_status, task_fingerprint, bundle_identity,
       json_sha256, markdown_sha256, materialized_at)
      VALUES (?, 'materialized', ?, ?, ?, ?, ?, ?)
    `).run(
      lifecycle.runId,
      artifact.status,
      artifact.taskFingerprint,
      lifecycle.bundleIdentity,
      jsonSha256,
      markdownSha256,
      now,
    );
  } finally {
    db.close();
  }
}

async function runNodeScript(args, lifecycle) {
  const commandArgs = [...args];
  if (commandArgs[0] === "scripts/run-meta-theory-governed-execution.mjs") {
    const reusable = await loadReusableGovernedRun(lifecycle);
    if (reusable) return reusable;
    const managedRunExists = [
      path.join(lifecycle.stateDir, `${lifecycle.runId}.json`),
      path.join(lifecycle.stateDir, `${lifecycle.runId}.reservation.json`),
    ].some(existsSync);
    commandArgs.push(
      "--run-id",
      lifecycle.runId,
      "--state-dir",
      lifecycle.stateDir,
      "--db",
      lifecycle.dbPath,
    );
    if (managedRunExists) commandArgs.push("--overwrite-run");
  }
  if (commandArgs[0] === "scripts/generate-meta-theory-run-deliverables.mjs") {
    commandArgs.push(
      "--run-id",
      lifecycle.runId,
      "--state-dir",
      lifecycle.stateDir,
    );
  }
  const allowPartialNonzero =
    commandArgs[0] === "scripts/run-meta-theory-governed-execution.mjs";
  const result = spawnSync(process.execPath, commandArgs, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = result.stdout ? tryParseJsonFromStdout(result.stdout) : null;
  if (result.status !== 0 && allowPartialNonzero && parsed?.status === "partial") {
    await finalizeGovernedRunLifecycle(lifecycle);
    return { ...parsed, reusedGovernedRun: false };
  }
  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout || `Command failed: node ${commandArgs.join(" ")}`,
    );
  }
  const output = parsed ?? parseJsonFromStdout(result.stdout);
  if (commandArgs[0] === "scripts/run-meta-theory-governed-execution.mjs") {
    await finalizeGovernedRunLifecycle(lifecycle);
    return { ...output, reusedGovernedRun: false };
  }
  return output;
}

function hasLocalAbsolutePath(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /[A-Za-z]:[\\/]/.test(text) || /\/(?:Users|home|var|tmp|mnt)\//.test(text);
}

function buildCalibration(scenario, contract) {
  const samples = scenario.scoringSamples.map((sample) => ({
    id: sample.id,
    pitfall: sample.pitfall,
    secondaryPitfall: sample.secondaryPitfall,
    kind: sample.kind,
    reviewerVerdict: sample.reviewerVerdict,
    score: sample.score,
    reviewerPrompt: sample.reviewerPrompt,
    passSignal: sample.passSignal,
    failSignal: sample.failSignal,
    reviewUse: `${sample.reviewerPrompt} Pass: ${sample.passSignal} Fail: ${sample.failSignal}`,
  }));
  const coveredPitfalls = new Set(
    samples.flatMap((sample) => [sample.pitfall, sample.secondaryPitfall].filter(Boolean)),
  );
  return {
    schemaVersion: "product-reviewer-calibration-v0.1",
    sampleCount: samples.length,
    positiveExampleCount: samples.filter((sample) => sample.kind === "positive").length,
    negativeExampleCount: samples.filter((sample) => sample.kind === "negative").length,
    coveredPitfalls: [...coveredPitfalls].sort(),
    missingPitfalls: contract.calibrationRequiredPitfalls.filter((pitfall) => !coveredPitfalls.has(pitfall)),
    samples,
  };
}

function buildMarkdown(report) {
  const lines = [
    "# Product Delivery Bundle",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- status: ${report.status}`,
    `- bundleFiles: ${report.summary.fileCount}`,
    `- requiredSectionsCovered: ${report.summary.requiredSectionsCovered}`,
    `- reviewerScoringSamples: ${report.reviewerCalibration.sampleCount}`,
    `- privacyCheck: ${report.privacyCheck.status}`,
    "",
    "## Product Sections",
    "",
    "| Section | Review Use | Evidence |",
    "|---|---|---|",
    ...report.sections.map(
      (section) => `| ${section.id} | ${section.reviewUse} | ${section.evidence.join(", ")} |`,
    ),
    "",
    "## Bundle Files",
    "",
    "| Key | Path | Audience |",
    "|---|---|---|",
    ...Object.entries(report.files).map(
      ([key, item]) => `| ${key} | ${item.path} | ${item.audience} |`,
    ),
    "",
    "## Reviewer Calibration",
    "",
    "| Sample | Pitfall | Verdict | Score | Pass Signal | Fail Signal |",
    "|---|---|---|---:|---|---|",
    ...report.reviewerCalibration.samples.map(
      (sample) =>
        `| ${sample.id} | ${sample.pitfall}${sample.secondaryPitfall ? ` / ${sample.secondaryPitfall}` : ""} | ${sample.reviewerVerdict} | ${sample.score} | ${sample.passSignal} | ${sample.failSignal} |`,
    ),
    "",
    "## Checks",
    "",
    "- Bundle manifest separates design, execution, acceptance, feedback, and deliverables.",
    "- Panel, report, rubric, case pack, GitHub gap, runtime matrix, DAG report, research report, and feedback report are included.",
    "- Reviewer calibration covers research-before-orchestration, skill-only capability, fake parallelism, fixture pass as live, unauthorized writeback, GitHub gap overclaim, Warden approval confusion, and mixed deliverables.",
    "- Privacy check rejects local absolute paths and credentials.",
  ];
  return `${lines.join("\n")}\n`;
}

async function resolveLocalImport(parentFile, specifier) {
  const base = path.resolve(path.dirname(parentFile), specifier);
  const candidates = [
    base,
    `${base}.mjs`,
    `${base}.js`,
    `${base}.json`,
    path.join(base, "index.mjs"),
    path.join(base, "index.js"),
  ];
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // Continue through deterministic local import candidates.
    }
  }
  return null;
}

async function dependencyClosureDigest(entryFiles) {
  const pending = [...new Set(entryFiles.map((file) => path.resolve(file)))];
  const sources = new Map();
  while (pending.length > 0) {
    const filePath = pending.pop();
    if (sources.has(filePath)) continue;
    const bytes = await fs.readFile(filePath);
    sources.set(filePath, bytes);
    if (!/\.[cm]?js$/u.test(filePath)) continue;
    const text = bytes.toString("utf8");
    const importPattern = /(?:from\s*|import\s*(?:\(\s*)?)["'](\.[^"']+)["']/gu;
    for (const match of text.matchAll(importPattern)) {
      const dependency = await resolveLocalImport(filePath, match[1]);
      if (dependency && !sources.has(dependency)) pending.push(dependency);
    }
  }
  const hash = createHash("sha256");
  for (const [filePath, bytes] of [...sources.entries()].sort(([left], [right]) =>
    left.localeCompare(right))) {
    hash.update(path.relative(REPO_ROOT, filePath).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function main() {
  const contract = JSON.parse(await fs.readFile(CONTRACT_PATH, "utf8"));
  const scenario = JSON.parse(await fs.readFile(SCENARIO_PATH, "utf8"));

  const sourceClosureDigest = await dependencyClosureDigest([
    fileURLToPath(import.meta.url),
    ...Object.values(componentCommands).map((command) => path.join(REPO_ROOT, command[0])),
  ]);
  const bundleIdentity = createHash("sha256")
    .update(JSON.stringify({
      lifecycleSchema: "product-delivery-bundle-lifecycle-v1",
      task: BUNDLE_TASK,
      contract,
      scenario,
      componentCommands,
      sourceClosureDigest,
    }))
    .digest("hex")
    .slice(0, 16);
  const lifecycle = {
    runId: `product-delivery-bundle-${bundleIdentity}`,
    stateDir: OUTPUT_DIR,
    dbPath: path.join(OUTPUT_DIR, `governed-${bundleIdentity}.sqlite`),
    bundleIdentity,
  };

  const governedRun = await runNodeScript(componentCommands.governedRun, lifecycle);
  const deliverables = await runNodeScript(componentCommands.deliverables, lifecycle);
  const githubGap = await runNodeScript(componentCommands.githubGap, lifecycle);
  const runtimeMatrix = await runNodeScript(componentCommands.runtimeMatrix, lifecycle);
  const orchestrationDag = await runNodeScript(componentCommands.orchestrationDag, lifecycle);
  const research = await runNodeScript(componentCommands.research, lifecycle);
  const feedback = await runNodeScript(componentCommands.feedback, lifecycle);

  const files = {
    panelHtml: {
      path: deliverables.files.panelHtml,
      audience: "reviewer",
      reviewUse: "Inspect why the run chose this route.",
    },
    readabilityReview: {
      path: deliverables.files.readabilityReview,
      audience: "reviewer",
      reviewUse: "Translate internal fields into user-facing labels.",
    },
    rubricMarkdown: {
      path: deliverables.files.rubricMarkdown,
      audience: "reviewer",
      reviewUse: "Score design, execution, acceptance, feedback, and deliverables.",
    },
    rubricJson: {
      path: deliverables.files.rubricJson,
      audience: "automation",
      reviewUse: "Machine-check the five-dimensional rubric.",
    },
    casePack: {
      path: deliverables.files.casePack,
      audience: "reviewer",
      reviewUse: "Review pass/fail examples without hidden protocol knowledge.",
    },
    githubGapReport: {
      path: githubGap.report,
      audience: "reviewer",
      reviewUse: "Prevent local-vs-GitHub completion overclaims.",
    },
    runtimeMatrixReport: {
      path: runtimeMatrix.report,
      audience: "reviewer",
      reviewUse: "Separate live, smoke, fixture, and blocked runtime evidence.",
    },
    orchestrationDagReport: {
      path: orchestrationDag.report,
      audience: "reviewer",
      reviewUse: "Show parallel groups, dependencies, and merge owner.",
    },
    researchReport: {
      path: research.report,
      audience: "reviewer",
      reviewUse: "Show why research must complete before Thinking.",
    },
    feedbackLoopReport: {
      path: feedback.report,
      audience: "reviewer",
      reviewUse: "Show how user correction changes the next route.",
    },
  };

  const sections = [
    {
      id: "design",
      reviewUse: "Explain real intent, capability gap, and selected route.",
      evidence: [deliverables.files.rubricJson, orchestrationDag.report, research.report],
    },
    {
      id: "execution",
      reviewUse: "Show workerTask handoff, DAG, owner, and runtime evidence.",
      evidence: [deliverables.files.panelHtml, runtimeMatrix.report, orchestrationDag.report],
    },
    {
      id: "acceptance",
      reviewUse: "Score pass/fail with rubric, GitHub delta, and runtime boundary.",
      evidence: [deliverables.files.rubricMarkdown, githubGap.report, runtimeMatrix.report],
    },
    {
      id: "feedback",
      reviewUse: "Show accept/correct/reject/promote/keep-one-time actions and next route effect.",
      evidence: [feedback.report, feedback.markdown],
    },
    {
      id: "deliverables",
      reviewUse: "List the product-facing files and how reviewers should use them.",
      evidence: [deliverables.files.casePack, deliverables.files.manifest],
    },
  ];

  const reviewerCalibration = buildCalibration(scenario, contract);
  const privacyLeaks = [];
  for (const value of [files, sections, reviewerCalibration]) {
    if (hasLocalAbsolutePath(value)) privacyLeaks.push("local_absolute_path");
  }

  await reportContext.ensureDirectory(OUTPUT_DIR);
  const jsonPath = path.join(OUTPUT_DIR, "latest.json");
  const mdPath = path.join(OUTPUT_DIR, "latest.zh-CN.md");
  files.bundleManifest = {
    path: publicOutputPath(jsonPath),
    audience: "automation",
    reviewUse: "Machine-readable bundle manifest.",
  };
  files.bundleMarkdown = {
    path: publicOutputPath(mdPath),
    audience: "reviewer",
    reviewUse: "Human-readable product delivery bundle.",
  };

  const summary = {
    fileCount: Object.keys(files).length,
    requiredSectionsCovered: contract.requiredSections.filter((section) =>
      sections.some((item) => item.id === section),
    ).length,
    requiredFilesCovered: contract.requiredFiles.filter((file) => files[file]).length,
    reviewUseCount: Object.values(files).filter((file) => file.reviewUse).length,
    governedRunStatus: governedRun.status,
  };
  const basePass =
    contract.schemaVersion === "product-delivery-bundle-contract-v0.1" &&
    summary.requiredSectionsCovered === contract.requiredSections.length &&
    summary.requiredFilesCovered === contract.requiredFiles.length &&
    reviewerCalibration.sampleCount >= 8 &&
    reviewerCalibration.positiveExampleCount >= 2 &&
    reviewerCalibration.negativeExampleCount >= 5 &&
    reviewerCalibration.missingPitfalls.length === 0 &&
    privacyLeaks.length === 0;
  const status = basePass ? (governedRun.status === "pass" ? "pass" : "partial") : "fail";

  const report = {
    schemaVersion: "product-delivery-bundle-v0.1",
    generatedAt: new Date().toISOString(),
    lifecycle: {
      bundleIdentity,
      sourceClosureDigest,
      governedRunId: lifecycle.runId,
      governedRunReused: governedRun.reusedGovernedRun === true,
    },
    contract: relativeToRepo(CONTRACT_PATH),
    scenario: relativeToRepo(SCENARIO_PATH),
    status,
    summary,
    privacyCheck: {
      status: privacyLeaks.length === 0 ? "pass" : "fail",
      leaks: privacyLeaks,
    },
    sections,
    files,
    reviewerCalibration,
  };

  await reportContext.writeJson(jsonPath, report);
  await reportContext.writeText(mdPath, buildMarkdown(report));

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: report.status === "pass",
        status: report.status,
        report: publicOutputPath(jsonPath),
        markdown: publicOutputPath(mdPath),
        fileCount: report.summary.fileCount,
        requiredSectionsCovered: report.summary.requiredSectionsCovered,
        governedRunStatus: report.summary.governedRunStatus,
        scoringSampleCount: report.reviewerCalibration.sampleCount,
        missingPitfalls: report.reviewerCalibration.missingPitfalls,
        privacyStatus: report.privacyCheck.status,
        bundleIdentity,
        sourceClosureDigest,
        governedRunId: lifecycle.runId,
        reusedGovernedRun: governedRun.reusedGovernedRun === true,
      },
      null,
      2,
    )}\n`,
  );
  if (report.status !== "pass") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
