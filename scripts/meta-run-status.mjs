#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { readMetaRunStatus } from "../canonical/runtime-assets/shared/hooks/spine-state.mjs";
import {
  getMetaRunStatusCopy,
  resolveMetaKimCliLanguage,
} from "./meta-kim-i18n.mjs";

const args = new Set(process.argv.slice(2));
const json = args.has("--json");
const latest = args.has("--latest");
const details = args.has("--details") || args.has("--verbose");
const langEqualsArg = process.argv.find((arg) => arg.startsWith("--lang="));
const langIndex = process.argv.indexOf("--lang");
const cliLanguage =
  langEqualsArg?.slice("--lang=".length) ||
  (langIndex >= 0 ? process.argv[langIndex + 1] : null);
const profileArg = process.argv.find((arg) => arg.startsWith("--profile="));
const profile =
  profileArg?.slice("--profile=".length) ||
  process.env.META_KIM_PROFILE ||
  process.env.META_KIM_STATE_PROFILE;

const DEFAULT_LABELS = {
  inactive: "meta_governance_status=inactive",
  active: "meta_governance_active",
  completed: "completed",
  current: "current",
  next: "next",
  blocked: "blocked",
  none: "none",
  separator: "=",
  listSeparator: ",",
};

const LATEST_LABELS = {
  missing: "meta_governance_latest=missing",
  latestRun: "latest_run",
  task: "task",
  status: "status",
  publicReady: "public_ready",
  summary: "summary",
  ownerHandoff: "owner_handoff",
  runtimeEvidence: "runtime_evidence",
  releaseBoundary: "release_boundary",
  report: "report",
  nextCommand: "next_command",
  none: "none",
  separator: "=",
  listSeparator: "; ",
};

function humanCopy(languageHint = null) {
  const { language } = cliLanguage
    ? resolveMetaKimCliLanguage(cliLanguage)
    : languageHint
      ? resolveMetaKimCliLanguage(languageHint)
      : resolveMetaKimCliLanguage();
  return getMetaRunStatusCopy(language);
}

function humanValue(value, copy) {
  const key = String(value ?? "none");
  return copy.values[key] ?? key;
}

function redactSensitiveText(value, sensitiveValues = []) {
  let text = String(value ?? "");
  for (const sensitiveValue of sensitiveValues) {
    const secret = typeof sensitiveValue === "string" ? sensitiveValue.trim() : "";
    if (!secret) continue;
    if (text.includes(secret)) {
      if (secret.length < 8) return "redacted_in_status_summary";
      text = text.split(secret).join("redacted_in_status_summary");
    }
  }
  return text;
}

function toPublicStatusProjection(value, options = {}) {
  if (Array.isArray(value)) {
    return value.map((item) => toPublicStatusProjection(item, options));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/fingerprint/iu.test(key) && key !== "taskIdentitySource",
        )
        .map(([key, item]) => [key, toPublicStatusProjection(item, options)]),
    );
  }
  if (typeof value === "string") {
    return redactSensitiveText(value, options.sensitiveValues);
  }
  return value;
}

function localizeEmbeddedEnums(value, copy) {
  return String(value ?? copy.values.none).replace(
    /(?<=[:/])(pass|partial|failed|blocked|pending|unknown)(?=[:/;\s]|$)/gu,
    (match) => humanValue(match, copy),
  );
}

function safeProfileName(value) {
  const candidate = value || "default";
  if (/^[A-Za-z0-9._-]+$/.test(candidate)) return candidate;
  throw new Error(`Invalid profile name: ${candidate}`);
}

function toRepoRelative(cwd, value) {
  if (!value || typeof value !== "string") return null;
  const resolved = path.isAbsolute(value) ? value : path.resolve(cwd, value);
  const relative = path.relative(cwd, resolved) || ".";
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return relative.split(path.sep).join("/");
}

function assertPathInside(baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  ) {
    return targetPath;
  }
  throw new Error(
    `Refusing to read governed execution artifact outside ${baseDir}`,
  );
}

async function readJsonFile(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function readLatestGovernedExecution(cwd, profileName) {
  const safeProfile = safeProfileName(profileName);
  const stateDir = path.join(
    cwd,
    ".meta-kim",
    "state",
    safeProfile,
    "governed-executions",
  );
  const latestPath = path.join(stateDir, "latest.json");

  let latestRecord;
  try {
    latestRecord = await readJsonFile(latestPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  const artifactPath = assertPathInside(
    stateDir,
    latestRecord.jsonPath
      ? path.resolve(cwd, latestRecord.jsonPath)
      : path.join(stateDir, `${latestRecord.runId}.json`),
  );
  const artifact = await readJsonFile(artifactPath);

  return {
    latestRecord,
    artifact,
    paths: {
      latestPath,
      artifactPath,
      markdownPath: latestRecord.markdownPath
        ? path.resolve(cwd, latestRecord.markdownPath)
        : null,
    },
  };
}

function normalizeRuntimeRecords(artifact) {
  const records =
    artifact?.runtimeEvidencePacket?.records ||
    artifact?.runtimeProjectionEvidence?.results ||
    artifact?.runReportPanelContract?.runtimeEvidence ||
    [];

  return Array.isArray(records) ? records : [];
}

function summarizeRuntimeRecord(record) {
  const runtime = record.runtime || "unknown";
  const status = record.status || "unknown";
  const details = [record.evidenceKind, record.failureClass].filter(Boolean);
  return details.length
    ? `${runtime}:${status}/${details.join("/")}`
    : `${runtime}:${status}`;
}

function summarizeOwnerHandoff(ownerHandoff) {
  if (!Array.isArray(ownerHandoff) || ownerHandoff.length === 0) {
    return LATEST_LABELS.none;
  }

  return ownerHandoff
    .slice(0, 3)
    .map((handoff) => {
      const owner = handoff.owner || handoff.roleDisplayName || "owner";
      const mergeOwner = handoff.mergeOwner || "merge_owner_unknown";
      const verificationOwner =
        handoff.verificationOwner || "verification_owner_unknown";
      return `${owner}->${mergeOwner}/${verificationOwner}`;
    })
    .join(LATEST_LABELS.listSeparator);
}

function summarizeReleaseBoundaries(runtimeRecords) {
  const boundaries = runtimeRecords.filter(
    (record) =>
      record?.remainingAction &&
      (record.strictReleasePass === false ||
        record.releaseGrade === false ||
        record.status === "blocked"),
  );

  if (boundaries.length === 0) return LATEST_LABELS.none;

  return boundaries
    .map((record) => `${record.runtime || "unknown"}: ${record.remainingAction}`)
    .join(LATEST_LABELS.listSeparator);
}

function summarizeLatestGovernedExecution(cwd, latestExecution) {
  if (!latestExecution) return null;

  const { latestRecord, artifact, paths } = latestExecution;
  const panel = artifact.runReportPanelContract || {};
  const decisionSummary = panel.decisionSummary || {};
  const runtimeRecords = normalizeRuntimeRecords(artifact);
  const runId = artifact.runId || latestRecord.runId || "unknown";
  const publicReadyDecision =
    artifact.publicReadyDecision || artifact.coreLoop?.publicReadyDecision || {};
  const publicReady =
    typeof publicReadyDecision.publicReady === "boolean"
      ? String(publicReadyDecision.publicReady)
      : publicReadyDecision.status || "unknown";
  const markdownPath =
    toRepoRelative(cwd, latestRecord.markdownPath) ||
    toRepoRelative(cwd, artifact.runReport?.markdownPath) ||
    toRepoRelative(cwd, paths.markdownPath);

  const sensitiveValues = [artifact.task, decisionSummary.task];
  return toPublicStatusProjection({
    runId,
    // Keep the legacy key for machine consumers, but status surfaces must never
    // duplicate the governed artifact's raw task. The explicit report command
    // remains the user-authorized detail surface.
    task: "redacted_in_status_summary",
    taskDisclosure: "use_explicit_report_readback",
    status: artifact.status || decisionSummary.status || "unknown",
    publicReady,
    summary: redactSensitiveText(
      decisionSummary.plainLanguageSummary ||
        artifact.userExperienceNotice?.expectation ||
        "none",
      sensitiveValues,
    ),
    ownerHandoff: summarizeOwnerHandoff(panel.ownerHandoff),
    runtimeEvidence: runtimeRecords.length
      ? runtimeRecords.map(summarizeRuntimeRecord).join(LATEST_LABELS.listSeparator)
      : LATEST_LABELS.none,
    releaseBoundary: redactSensitiveText(
      summarizeReleaseBoundaries(runtimeRecords),
      sensitiveValues,
    ),
    report: markdownPath || LATEST_LABELS.none,
    nextCommand: `npm run meta:theory:report -- --run-id ${runId}`,
    jsonPath:
      toRepoRelative(cwd, latestRecord.jsonPath) ||
      toRepoRelative(cwd, paths.artifactPath),
  });
}

function renderLatestSummary(summary, copy, showDetails = false) {
  const labels = copy.labels;
  if (!summary) return labels.missing;

  const separator = labels.separator ?? "=";
  const primary = [
    labels.title,
    `${labels.latestRun}${separator}${summary.runId}`,
    `${labels.status}${separator}${humanValue(summary.status, copy)}`,
    `${labels.publicReady}${separator}${humanValue(summary.publicReady, copy)}`,
    `${labels.summary}${separator}${summary.summary}`,
  ];
  if (summary.releaseBoundary !== LATEST_LABELS.none) {
    primary.push(`${labels.releaseBoundary}${separator}${localizeEmbeddedEnums(summary.releaseBoundary, copy)}`);
  }
  primary.push(
    `${labels.report}${separator}${summary.report}`,
    `${labels.nextCommand}${separator}${summary.nextCommand}`,
  );
  if (showDetails) {
    primary.push(
      `${labels.ownerHandoff}${separator}${summary.ownerHandoff}`,
      `${labels.runtimeEvidence}${separator}${localizeEmbeddedEnums(summary.runtimeEvidence, copy)}`,
    );
  }
  return primary.join("\n");
}

if (latest) {
  const latestExecution = await readLatestGovernedExecution(
    process.cwd(),
    profile,
  );
  const summary = summarizeLatestGovernedExecution(process.cwd(), latestExecution);

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  }

  const copy = humanCopy(latestExecution?.artifact?.resolvedOutputLanguage);
  console.log(renderLatestSummary(summary, copy, details));
  process.exit(0);
}

const status = await readMetaRunStatus(process.cwd(), profile);

if (json) {
  const publicStatus = status ? toPublicStatusProjection(status) : null;
  console.log(JSON.stringify(publicStatus, null, 2));
  process.exit(0);
}

if (!status) {
  console.log(humanCopy().labels.inactive);
  process.exit(0);
}

const copy = humanCopy(status.resolvedOutputLanguage);
const labels = {
  ...copy.labels,
  ...(!cliLanguage && status.publicLabels && typeof status.publicLabels === "object"
    ? status.publicLabels
    : {}),
};

if (status.active === false) {
  const continuation =
    status.deactivationReason === "session_stop"
      ? humanValue("local_continuity_or_new_run_only", copy)
      : status.continuationBoundary?.mode || labels.none;
  console.log(
    [
      labels.inactive,
      `${labels.reason || "reason"}${labels.separator}${humanValue(status.deactivationReason || "none", copy)}`,
      `${labels.continuation || "continuation"}${labels.separator}${continuation}`,
      `${labels.current}${labels.separator}${status.currentStage || labels.none}`,
    ].join("\n"),
  );
  process.exit(0);
}

const completed = status.completed?.length
  ? status.completed.join(labels.listSeparator)
  : labels.none;
const stagePurpose = status.stagePurpose || status.stagePurposeKey || labels.none;

console.log(
  [
    `${labels.active}${labels.separator}${status.currentStage} (${status.stageIndex}/${status.stageTotal}, ${status.percent}%)`,
    `${labels.completed}${labels.separator}${completed}`,
    `${labels.current}${labels.separator}${stagePurpose}`,
    `${labels.next}${labels.separator}${status.next || labels.none}`,
    `${labels.blocked}${labels.separator}${status.blockedOn || labels.none}`,
  ].join("\n"),
);
