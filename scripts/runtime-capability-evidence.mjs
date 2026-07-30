import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOST_SUPPORT_VALUES,
  ROUTE_ELIGIBILITY_VALUES,
  RUNTIME_CAPABILITY_MODES,
  aggregateLegacyCapabilitySummary,
  claimIsExecutable,
} from "./runtime-capability-claims.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OBSERVATION_CLASSES = new Set([
  "official_docs",
  "repo_projection",
  "presence_only",
  "local_acceptance",
  "live_acceptance",
  "compatibility_smoke",
  "fixture_playbook",
  "conservative_review",
]);
const INTEGRATION_STATES = new Set([
  "projected",
  "projected_unaccepted",
  "declarative_only",
  "host_only",
  "not_integrated",
  "unknown",
]);
const ACCEPTANCE_REQUIREMENTS = new Set(["required", "mode_dependent", "not_required"]);
const ACCEPTANCE_STATES = new Set(["accepted", "not_run", "not_applicable", "blocked"]);
const REVIEW_STATES = new Set(["current", "conservative_retained"]);
const CONFIDENCE_STATES = new Set(["verified_local", "verified_docs", "repo_claim", "unverified"]);
const LIVE_CLASSES = new Set(["local_acceptance", "live_acceptance"]);
const HOST_PROOF_CLASSES = new Set(["official_docs", "local_acceptance", "live_acceptance"]);
const POLICY_HOST_NOT_APPLICABLE = new Set([
  "chat decision card fallback",
  "graph",
  "project rule file",
  "global rule file",
  "project install",
  "global install",
  "dependency discovery",
  "skill discovery",
  "hook discovery",
  "automation trigger",
  "human confirmation trigger",
]);
const OFFICIAL_HOSTS = {
  claude_code: new Set(["code.claude.com"]),
  codex: new Set(["developers.openai.com", "learn.chatgpt.com"]),
  openclaw: new Set(["docs.openclaw.ai"]),
  cursor: new Set(["cursor.com", "docs.cursor.com"]),
};
const REPOSITORY_EVIDENCE_PREFIXES = ["canonical/", "config/", "scripts/"];
const REPOSITORY_EVIDENCE_FILES = new Set(["setup.mjs", "AGENTS.md"]);
const OFFICIAL_PATH_CAPABILITIES = {
  claude_code: [
    [/\/sub-agents$/u, new Set(["agent", "subagent", "custom agent"])],
    [/\/tools-reference$/u, new Set(["browser / web", "shell", "filesystem", "apply_patch / edit", "native choice surface", "background task", "human confirmation trigger"])],
    [/\/hooks$/u, new Set(["hook", "hook discovery", "automation trigger"])],
    [/\/sandboxing$/u, new Set(["sandbox"])],
    [/\/permission-modes$/u, new Set(["approval", "permission mode", "popup / overlay / approval UI"])],
    [/\/slash-commands$/u, new Set(["skill", "command", "slash command", "skill discovery"])],
    [/\/mcp$/u, new Set(["MCP"])],
    [/\/memory$/u, new Set(["memory", "project rule file", "global rule file"])],
  ],
  codex: [
    [/\/codex\/(?:concepts\/)?subagents$/u, new Set(["agent", "subagent", "custom agent", "background task"])],
    [/\/codex\/skills$/u, new Set(["skill", "skill discovery"])],
    [/\/codex\/mcp$/u, new Set(["MCP"])],
    [/\/codex\/hooks$/u, new Set(["hook", "hook discovery", "automation trigger"])],
    [/\/codex\/config-reference$/u, new Set(["browser / web", "shell", "filesystem", "apply_patch / edit", "sandbox", "approval", "permission mode"])],
    [/\/codex\/guides\/agents-md$/u, new Set(["memory", "project rule file", "global rule file"])],
    [/\/codex\/cli\/slash-commands$/u, new Set(["command", "slash command"])],
    [/\/codex$/u, new Set(["background task"])],
  ],
  openclaw: [
    [/\/tools\/ask-user$/u, new Set(["native choice surface"])],
    [/\/(?:tools\/exec-approvals|plugins\/plugin-permission-requests)$/u, new Set(["human confirmation trigger", "popup / overlay / approval UI", "approval", "permission mode"])],
    [/\/(?:tools\/subagents|automation\/tasks)$/u, new Set(["agent", "subagent", "custom agent", "background task"])],
    [/\/cli\/mcp$/u, new Set(["MCP"])],
    [/\/tools\/permission-modes$/u, new Set(["approval", "permission mode"])],
    [/\/(?:automation\/hooks|plugins)$/u, new Set(["hook", "hook discovery", "automation trigger"])],
    [/\/concepts\/memory$/u, new Set(["memory", "project rule file", "global rule file"])],
    [/\/tools\/skills$/u, new Set(["skill", "skill discovery"])],
    [/\/tools\/slash-commands$/u, new Set(["command", "slash command"])],
    [/\/tools$/u, new Set(["browser / web", "shell", "filesystem", "sandbox"])],
    [/\/tools\/apply-patch$/u, new Set(["apply_patch / edit"])],
  ],
  cursor: [
    [/\/(?:docs\/subagents|changelog\/2-4)$/u, new Set(["agent", "subagent", "custom agent"])],
    [/\/docs\/skills$/u, new Set(["skill", "skill discovery"])],
    [/\/changelog\/2-4$/u, new Set(["native choice surface", "human confirmation trigger", "popup / overlay / approval UI", "approval", "permission mode", "MCP", "browser / web", "shell", "filesystem", "apply_patch / edit"])],
    [/\/docs\/hooks$/u, new Set(["hook", "hook discovery", "automation trigger"])],
    [/\/cli\/reference\/permissions$/u, new Set(["approval", "permission mode"])],
    [/\/en\/agent\/chat\/commands$/u, new Set(["command", "slash command"])],
    [/\/(?:background-agent|changelog\/2-5)$/u, new Set(["background task", "sandbox"])],
    [/\/(?:en\/context\/memories|context\/rules)$/u, new Set(["memory", "project rule file"])],
    [/\/blog\/agent-sandboxing$/u, new Set(["sandbox"])],
    [/\/en\/agent\/tools$/u, new Set(["MCP", "browser / web", "shell", "filesystem", "apply_patch / edit"])],
  ],
};

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function parseDate(value) {
  const text = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*Z)?$/.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

function ageInDays(older, newer) {
  return Math.floor((newer - older) / 86_400_000);
}

function isFutureDate(value, parsedMs, nowMs, timeZone = "Asia/Shanghai") {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(String(value ?? ""))) {
    const currentLocalDate = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(nowMs));
    return String(value) > currentLocalDate;
  }
  return parsedMs > nowMs;
}

function insideRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function digestRepositoryFile(filePath) {
  const bytes = readFileSync(filePath);
  if (!isUtf8(bytes)) return sha256(bytes);
  // Git archives and npm packages may carry the same tracked text with LF or
  // CRLF endings. Bind the repository content, not the checkout convention.
  return sha256(Buffer.from(bytes.toString("utf8").replace(/\r\n?/gu, "\n"), "utf8"));
}

function repositorySourcePath(ref) {
  const normalized = String(ref ?? "").replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!REPOSITORY_EVIDENCE_FILES.has(normalized) && !REPOSITORY_EVIDENCE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return null;
  const requested = path.resolve(repoRoot, normalized);
  let real;
  try { real = realpathSync(requested); } catch { return null; }
  return insideRoot(real, realpathSync(repoRoot)) ? real : null;
}

export function digestRepositorySource(sourcePath) {
  const stat = lstatSync(sourcePath);
  if (stat.isSymbolicLink()) throw new Error("repository evidence cannot be a symlink");
  if (stat.isFile()) return digestRepositoryFile(sourcePath);
  if (!stat.isDirectory()) throw new Error("repository evidence must be a regular file or directory");
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("repository evidence tree cannot contain symlinks");
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  walk(sourcePath);
  files.sort((left, right) => left.localeCompare(right));
  return sha256(files.map((file) => `${path.relative(sourcePath, file).replaceAll("\\", "/")}\0${digestRepositoryFile(file)}\n`).join(""));
}

function resolveObservationRefs(refs, observations, issues, context) {
  if (!Array.isArray(refs) || refs.length === 0) {
    issues.push(`${context} must bind non-empty evidenceRefs`);
    return [];
  }
  return refs.map((ref) => {
    const observation = observations.get(ref);
    if (!observation) issues.push(`${context} has unresolved evidenceRef ${ref}`);
    return observation;
  }).filter(Boolean);
}

function validateAcceptanceArtifact(observation, { allowedEvidenceRoots, nowMs }, issues) {
  const artifact = observation?.artifact;
  const id = observation?.id ?? "acceptance observation";
  if (!artifact || !isNonEmptyString(artifact.path) || !isNonEmptyString(artifact.sha256) || !isNonEmptyString(artifact.correlationId) || !isNonEmptyString(artifact.attemptId)) {
    issues.push(`${id} acceptance artifact requires path, sha256, correlationId, and attemptId`);
    return;
  }
  const roots = (allowedEvidenceRoots ?? [path.join(repoRoot, ".meta-kim", "state")])
    .filter((root) => existsSync(root))
    .flatMap((root) => {
      try {
        const stat = lstatSync(root);
        return stat.isDirectory() && !stat.isSymbolicLink() ? [realpathSync(root)] : [];
      } catch { return []; }
    });
  if (roots.length === 0) {
    issues.push(`${id} has no existing allowed evidence root`);
    return;
  }
  let artifactRealPath;
  try {
    const requestedPath = path.isAbsolute(artifact.path)
      ? artifact.path
      : path.resolve(roots[0], artifact.path);
    const requestedStat = lstatSync(requestedPath);
    if (!requestedStat.isFile() || requestedStat.isSymbolicLink()) {
      issues.push(`${id} artifact must be a regular non-symlink file`);
      return;
    }
    artifactRealPath = realpathSync(requestedPath);
  } catch {
    issues.push(`${id} artifact file does not exist`);
    return;
  }
  if (!roots.some((root) => insideRoot(artifactRealPath, root))) {
    issues.push(`${id} artifact escapes the allowed evidence root`);
    return;
  }
  const bytes = readFileSync(artifactRealPath);
  if (sha256(bytes) !== String(artifact.sha256).toLowerCase()) {
    issues.push(`${id} artifact SHA-256 mismatch`);
    return;
  }
  let record;
  try {
    record = JSON.parse(bytes.toString("utf8"));
  } catch {
    issues.push(`${id} artifact is not valid JSON`);
    return;
  }
  if (record.digestBoundSnapshot !== true || record.outcome !== "pass") {
    issues.push(`${id} artifact must be a digest-bound snapshot with pass outcome`);
  }
  for (const [field, expected] of [
    ["runtime", observation.runtime],
    ["capability", observation.capabilities?.[0]],
    ["mode", observation.runtimeModes?.[0]],
    ["correlationId", artifact.correlationId],
    ["attemptId", artifact.attemptId],
  ]) {
    if (record[field] !== expected) issues.push(`${id} artifact ${field} binding mismatch`);
  }
  const recordDate = parseDate(record.observedAt);
  if (recordDate === null || isFutureDate(record.observedAt, recordDate, nowMs)) issues.push(`${id} artifact observedAt is invalid or future-dated`);
  if (record.observedAt !== observation.observedAt) issues.push(`${id} artifact observedAt binding mismatch`);
  if (record.releaseGrade === true) {
    if (!/^[a-f0-9]{40}$/i.test(String(record.commit ?? ""))) issues.push(`${id} release-grade artifact missing commit binding`);
    if (!/^[a-f0-9]{64}$/i.test(String(record.packageDigest ?? ""))) issues.push(`${id} release-grade artifact missing package digest binding`);
  }
}

export function validateRuntimeEvidenceLedger(ledger, options = {}) {
  const issues = [];
  const observations = new Map();
  const nowMs = Date.parse(options.now ?? new Date().toISOString());
  const correlationIds = new Set();
  if (ledger?.schemaVersion !== "2.0.0" || ledger?.claimSchemaVersion !== 2 || ledger?.authorityBoundary !== "observations_only") {
    issues.push("evidence ledger must use schemaVersion 2.0.0, claimSchemaVersion 2, and observations_only authority");
  }
  if (!ledger?.semantics?.reviewed || !ledger?.semantics?.verified || !ledger?.semantics?.liveAcceptance) {
    issues.push("evidence ledger must define reviewed, verified, and liveAcceptance semantics");
  }
  if (!Array.isArray(ledger?.observations) || ledger.observations.length === 0) {
    issues.push("evidence ledger observations must be non-empty");
    return { issues, observations };
  }
  for (const observation of ledger.observations) {
    const id = observation?.id;
    if (!isNonEmptyString(id) || observations.has(id)) {
      issues.push(`invalid or duplicate observation id ${id}`);
      continue;
    }
    observations.set(id, observation);
    if (!OBSERVATION_CLASSES.has(observation.observationClass)) issues.push(`${id} has invalid observationClass`);
    if (!Array.isArray(observation.capabilities) || observation.capabilities.length === 0) issues.push(`${id} must name capabilities`);
    if (!Array.isArray(observation.runtimeModes) || observation.runtimeModes.length === 0 || observation.runtimeModes.some((mode) => !RUNTIME_CAPABILITY_MODES.includes(mode))) issues.push(`${id} has invalid runtimeModes`);
    const observedMs = parseDate(observation.observedAt);
    if (observedMs === null || isFutureDate(observation.observedAt, observedMs, nowMs, options.timeZone)) issues.push(`${id} observedAt is invalid or future-dated`);
    if (!Array.isArray(observation.sourceRefs) || observation.sourceRefs.length === 0) issues.push(`${id} missing sourceRefs`);
    for (const forbidden of ["support", "confidence", "integrationStatus", "acceptanceState", "routeEligibility"]) {
      if (Object.hasOwn(observation, forbidden)) issues.push(`${id} must not store conclusion field ${forbidden}`);
    }
    if (observation.observationClass === "official_docs") {
      const parsedUrls = [];
      for (const ref of observation.sourceRefs ?? []) {
        try {
          const url = new URL(ref);
          if (url.protocol !== "https:" || !OFFICIAL_HOSTS[observation.runtime]?.has(url.hostname) || url.username || url.password || url.port) {
            issues.push(`${id} uses a non-allowlisted official documentation URL`);
          }
          parsedUrls.push(url);
        } catch {
          issues.push(`${id} official documentation source must be an absolute HTTPS URL`);
        }
      }
      const rules = OFFICIAL_PATH_CAPABILITIES[observation.runtime];
      if (rules) {
        for (const capability of observation.capabilities ?? []) {
          if (!parsedUrls.some((url) => rules.some(([pattern, capabilities]) => pattern.test(url.pathname.replace(/\/$/u, "")) && capabilities.has(capability)))) {
            issues.push(`${id} official documentation path does not prove capability ${capability}`);
          }
        }
      }
    }
    if (["conservative_review", "repo_projection"].includes(observation.observationClass)) {
      if (observation.sourceRefs?.some((ref) => ref === "config/runtime-capability-matrix.json")) issues.push(`${id} conservative review cannot cite the matrix as self-proof`);
      for (const ref of observation.sourceRefs ?? []) {
        if (/^https:/u.test(ref) || !repositorySourcePath(ref)) issues.push(`${id} repository evidence source must resolve inside an allowlisted repository asset`);
      }
    }
    if (observation.observationClass === "repo_projection") {
      const artifacts = new Map((observation.sourceArtifacts ?? []).map((entry) => [entry.path, entry]));
      for (const ref of observation.sourceRefs ?? []) {
        const sourcePath = repositorySourcePath(ref);
        const artifact = artifacts.get(ref);
        if (!artifact || artifact.digestKind !== "sha256" || !/^[a-f0-9]{64}$/iu.test(String(artifact.sha256 ?? ""))) {
          issues.push(`${id} repo projection source ${ref} is missing a SHA-256 binding`);
          continue;
        }
        if (sourcePath) {
          try {
            if (digestRepositorySource(sourcePath) !== artifact.sha256.toLowerCase()) issues.push(`${id} repo projection source ${ref} SHA-256 mismatch`);
          } catch (error) { issues.push(`${id} ${error.message}`); }
        }
      }
    }
    if (LIVE_CLASSES.has(observation.observationClass)) {
      if (observation.capabilities?.length !== 1 || observation.runtimeModes?.length !== 1) {
        issues.push(`${id} acceptance observation must bind exactly one capability and one runtime mode`);
      }
      const correlationId = observation.artifact?.correlationId;
      if (correlationIds.has(correlationId)) issues.push(`${id} duplicates acceptance correlationId ${correlationId}`);
      if (correlationId) correlationIds.add(correlationId);
      validateAcceptanceArtifact(observation, {
        allowedEvidenceRoots: options.allowedEvidenceRoots,
        nowMs,
      }, issues);
    }
  }
  return { issues, observations };
}

export function validateRuntimeCapabilityClaims(matrix, ledger, options = {}) {
  const nowMs = Date.parse(options.now ?? new Date().toISOString());
  const staleAfterDays = options.staleAfterDays ?? 30;
  const { issues, observations } = validateRuntimeEvidenceLedger(ledger, options);
  for (const observation of observations.values()) {
    if (LIVE_CLASSES.has(observation.observationClass)) issues.push(`${observation.id} live/local acceptance must not be stored in the canonical static ledger`);
  }
  if (matrix?.schemaVersion !== 2 || matrix?.claimSchemaVersion !== 2 || matrix?.evidenceLedger !== "config/runtime-capability-evidence.json") issues.push("matrix must use formal schemaVersion 2, claimSchemaVersion 2, and canonical evidenceLedger");
  if (matrix?.generatedFrom?.includes("local_probe") || Object.hasOwn(matrix ?? {}, "lastVerifiedAt")) issues.push("matrix must not use local_probe or ambiguous top-level lastVerifiedAt");
  if (!matrix?.claimSemantics?.hostSupport || !matrix?.claimSemantics?.metaKimIntegration || !matrix?.claimSemantics?.acceptance || !matrix?.claimSemantics?.legacySummary) issues.push("matrix must define v2 claim semantics");
  const reviewedAtMs = parseDate(matrix?.lastReviewedAt);
  if (reviewedAtMs === null || isFutureDate(matrix?.lastReviewedAt, reviewedAtMs, nowMs, options.timeZone) || ageInDays(reviewedAtMs, nowMs) > staleAfterDays) issues.push("matrix lastReviewedAt must be current, non-future, and fresh");

  const rows = [];
  for (const platform of matrix?.platforms ?? []) {
    for (const row of platform.capabilities ?? []) {
      const key = `${platform.platform}.${row.capability}`;
      rows.push({ platform: platform.platform, row, key });
      if (!HOST_SUPPORT_VALUES.includes(row.hostSupport) || !CONFIDENCE_STATES.has(row.hostConfidence)) issues.push(`${key} missing or invalid explicit hostSupport/hostConfidence`);
      if (!Array.isArray(row.runtimeModes) || row.runtimeModes.length === 0 || row.runtimeModes.some((mode) => !RUNTIME_CAPABILITY_MODES.includes(mode))) issues.push(`${key} has invalid runtimeModes`);
      if (!Array.isArray(row.requiredModes) || row.requiredModes.some((mode) => !row.runtimeModes?.includes(mode))) issues.push(`${key} requiredModes must be a subset of runtimeModes`);
      const rowEvidence = resolveObservationRefs(row.evidenceRefs, observations, issues, `${key}.evidenceRefs`);
      for (const observation of rowEvidence) {
        if (observation.runtime !== platform.platform || !observation.capabilities.includes(row.capability)) issues.push(`${key}.evidenceRefs evidence ${observation.id} is not capability-specific`);
      }
      const claimModes = Object.keys(row.claimsByMode ?? {});
      if (claimModes.length !== row.runtimeModes?.length || row.runtimeModes?.some((mode) => !Object.hasOwn(row.claimsByMode ?? {}, mode))) issues.push(`${key} claimsByMode must cover every declared runtime mode exactly`);
      const modeClaims = Object.values(row.claimsByMode ?? {});
      if (!modeClaims.some((claim) => claim.hostSupport === row.hostSupport)) issues.push(`${key} row hostSupport must be represented by a mode claim`);
      if (!modeClaims.some((claim) => claim.hostConfidence === row.hostConfidence)) issues.push(`${key} row hostConfidence must be represented by a mode claim`);

      for (const mode of row.runtimeModes ?? []) {
        const claim = row.claimsByMode?.[mode];
        const context = `${key}.claimsByMode.${mode}`;
        if (!claim) continue;
        if (!HOST_SUPPORT_VALUES.includes(claim.hostSupport) || !CONFIDENCE_STATES.has(claim.hostConfidence)) issues.push(`${context} has invalid host conclusion`);
        if (!INTEGRATION_STATES.has(claim.metaKimIntegration)) issues.push(`${context} has invalid integration state`);
        if (!ACCEPTANCE_REQUIREMENTS.has(claim.acceptanceRequirement) || !ACCEPTANCE_STATES.has(claim.acceptanceState)) issues.push(`${context} has invalid acceptance state`);
        if (!ROUTE_ELIGIBILITY_VALUES.includes(claim.routeEligibility)) issues.push(`${context} has invalid routeEligibility`);
        const resolved = resolveObservationRefs(claim.evidenceRefs, observations, issues, context);
        for (const observation of resolved) {
          if (observation.runtime !== platform.platform || !observation.capabilities.includes(row.capability)) issues.push(`${context} evidence ${observation.id} is not capability-specific`);
          if (!observation.runtimeModes.includes(mode)) issues.push(`${context} evidence ${observation.id} does not cover mode ${mode}`);
        }
        const hostProof = resolved.filter((entry) => HOST_PROOF_CLASSES.has(entry.observationClass));
        const liveProof = resolved.filter((entry) => LIVE_CLASSES.has(entry.observationClass));
        const integrationProof = resolved.filter((entry) => entry.observationClass === "repo_projection" || LIVE_CLASSES.has(entry.observationClass));
        if (["native", "partial"].includes(claim.hostSupport) && hostProof.length === 0) issues.push(`${context} host support requires docs or correlated acceptance evidence`);
        if (claim.hostSupport === "not_applicable" && !POLICY_HOST_NOT_APPLICABLE.has(row.capability)) issues.push(`${context} host not_applicable is allowed only for Meta_Kim-owned policy/fallback capabilities`);
        if (claim.hostConfidence === "verified_docs" && !resolved.some((entry) => entry.observationClass === "official_docs")) issues.push(`${context} verified_docs requires allowlisted official documentation`);
        if (claim.hostConfidence === "verified_local" && liveProof.length === 0) issues.push(`${context} verified_local requires correlated acceptance evidence`);
        if (["projected", "projected_unaccepted", "declarative_only"].includes(claim.metaKimIntegration) && integrationProof.length === 0) issues.push(`${context} integration conclusion requires repository projection or correlated acceptance evidence`);
        if (claim.acceptanceState === "accepted" && liveProof.length === 0) issues.push(`${context} accepted state requires correlated local/live evidence`);
        if (claim.routeEligibility === "executable" && !claimIsExecutable(claim)) issues.push(`${context} executable route is not accepted and usable`);
        if (claim.routeEligibility !== "executable" && claimIsExecutable(claim)) issues.push(`${context} resolver/route eligibility contradiction`);
        if (["presence_only", "conservative_review", "repo_projection"].some((kind) => resolved.some((entry) => entry.observationClass === kind)) && hostProof.length === 0 && ["native", "partial"].includes(claim.hostSupport)) issues.push(`${context} presence/review/projection evidence cannot establish host support`);
      }

      for (const requiredMode of row.requiredModes ?? []) {
        const claim = row.claimsByMode?.[requiredMode];
        if (!claim || claim.acceptanceRequirement === "not_required") issues.push(`${key} required mode ${requiredMode} must require acceptance`);
      }

      const review = row.reviewState;
      const reviewMs = parseDate(review?.lastReviewedAt);
      if (!REVIEW_STATES.has(review?.status) || reviewMs === null || isFutureDate(review?.lastReviewedAt, reviewMs, nowMs, options.timeZone) || ageInDays(reviewMs, nowMs) > staleAfterDays || !isNonEmptyString(review?.rationale)) issues.push(`${key} reviewState must be fresh, non-future, and explicit`);
      const reviewEvidence = resolveObservationRefs(review?.evidenceRefs, observations, issues, `${key}.reviewState`);
      const freshConservativeEvidence = reviewEvidence.some((observation) => {
        const observedMs = parseDate(observation.observedAt);
        return observation.observationClass === "conservative_review"
          && observedMs !== null
          && !isFutureDate(observation.observedAt, observedMs, nowMs, options.timeZone)
          && ageInDays(observedMs, nowMs) <= staleAfterDays;
      });
      if (!freshConservativeEvidence) issues.push(`${key} review must bind fresh conservative_review evidence`);
      const aggregate = aggregateLegacyCapabilitySummary(row);
      if (row.support !== aggregate.support || row.confidence !== aggregate.confidence) issues.push(`${key} legacy support/confidence must equal the conservative v2 aggregate`);
      if (platform.platform === "cursor" && Object.values(row.claimsByMode ?? {}).some((claim) => claim.acceptanceState === "accepted" || claim.routeEligibility === "executable")) issues.push(`${key} Cursor must remain product/live unaccepted in P-130`);
    }
  }

  for (const runtime of ["claude_code", "codex"]) {
    const native = rows.find((entry) => entry.platform === runtime && entry.row.capability === "native choice surface")?.row;
    const fallback = rows.find((entry) => entry.platform === runtime && entry.row.capability === "chat decision card fallback")?.row;
    const interactive = native?.claimsByMode?.interactive_host;
    if (!native?.requiredModes?.includes("interactive_host") || interactive?.acceptanceRequirement !== "required" || interactive?.acceptanceState === "accepted" || interactive?.routeEligibility === "executable" || interactive?.completionFallbackAllowed !== false) issues.push(`${runtime} native choice interactive mode must remain required and unaccepted without native evidence`);
    if (Object.values(fallback?.claimsByMode ?? {}).some((claim) => claim.completionEligible !== false)) issues.push(`${runtime} chat fallback can never complete native choice`);
  }

  const openClawApply = rows.find((entry) => entry.platform === "openclaw" && entry.row.capability === "apply_patch / edit")?.row;
  const openClawChoice = rows.find((entry) => entry.platform === "openclaw" && entry.row.capability === "native choice surface")?.row;
  const openClawMcp = rows.find((entry) => entry.platform === "openclaw" && entry.row.capability === "MCP")?.row;
  const allOpenClawRefs = [openClawApply, openClawChoice, openClawMcp].flatMap((row) => Object.values(row?.claimsByMode ?? {}).flatMap((claim) => claim.evidenceRefs)).map((ref) => observations.get(ref)?.sourceRefs ?? []).flat();
  for (const requiredUrl of ["https://docs.openclaw.ai/tools/apply-patch", "https://docs.openclaw.ai/tools/ask-user", "https://docs.openclaw.ai/cli/mcp"]) {
    if (!allOpenClawRefs.includes(requiredUrl)) issues.push(`OpenClaw canonical documentation URL missing: ${requiredUrl}`);
  }
  const openClawHook = rows.find((entry) => entry.platform === "openclaw" && entry.row.capability === "hook")?.row;
  if (Object.values(openClawHook?.claimsByMode ?? {}).some((claim) => claim.metaKimIntegration !== "declarative_only")) issues.push("OpenClaw lifecycle Hook must remain distinct from uninstalled typed tool blocking");
  return issues;
}

export function assertRuntimeCapabilityClaims(matrix, ledger, options = {}) {
  const issues = validateRuntimeCapabilityClaims(matrix, ledger, options);
  if (issues.length > 0) throw new Error(`runtime capability evidence validation failed:\n- ${issues.join("\n- ")}`);
}

export const validateBaselineRuntimeCapabilityClaims = validateRuntimeCapabilityClaims;
export const assertBaselineRuntimeCapabilityClaims = assertRuntimeCapabilityClaims;

export function redactProbePath(value, { repositoryRoot = repoRoot, homeRoot = null, stateRoot = null } = {}) {
  if (!value) return null;
  const absolute = path.resolve(value);
  for (const [root, token] of [[stateRoot, "<state>"], [repositoryRoot, "<repo>"], [homeRoot, "<home>"]]) {
    if (!root) continue;
    const resolvedRoot = path.resolve(root);
    if (insideRoot(absolute, resolvedRoot)) {
      const relative = path.relative(resolvedRoot, absolute).replace(/\\/g, "/");
      return relative ? `${token}/${relative}` : token;
    }
  }
  return `<absolute>/${path.basename(absolute)}`;
}
