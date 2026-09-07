#!/usr/bin/env node

// Flags: --runtime <claude|codex> --scenario <id> --preflight --install-only
//        --prompt-file <path> --artifact-dir <path> --timeout-ms <ms>
//        --keep-temp   keep the clean-room temp root after the run so the packed
//                      workspace and isolated runtime home can be inspected.
//                      Copied host credentials are scrubbed first. The retained
//                      path is isolation.tempRoot in the report. A silent
//                      dependency-install no-op turns this on by itself.
//                      Equivalent env opt-in: META_KIM_CLEAN_ROOM_KEEP_TEMP=1.

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  lintBlindPrompt,
  observeClaudeAssistantMessages,
  observeClaudeJsonl,
  observeCodexAssistantMessages,
  observeCodexJsonl,
  observeMcpClientJsonl,
  parseJsonl,
} from "./observe-host-events.mjs";
import { buildExactBindingCandidateFromFiles } from "./build-exact-binding-candidate.mjs";
import { resolveWindowsCliInvocation } from "../runtime-cli-invocation.mjs";
import { tarExtractCommand } from "../tar-extract-command.mjs";
import { INSTALLER_ACK_PREFIX, hasInstallerAck } from "../installer-ack.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const sha256 = (value) => createHash("sha256").update(String(value), "utf8").digest("hex");
const sha256Bytes = (value) => createHash("sha256").update(value).digest("hex");
const EXPECTED_AGENT_TEAMS_PLAYBOOK_REF = "v4.8.0";
const EXPECTED_AGENT_TEAMS_PLAYBOOK_COMMIT = "753ff43bd9b1f9aee4d184c4f21e7f494af5a79f";
const EXPECTED_AGENT_TEAMS_PLAYBOOK_SKILL_SHA256 =
  "0c61f80b3e0616e3b6c6611e03c230e8eb26fbda65d4a7cc9477a9370e7d5fb4";
const DEPENDENCY_INSTALL_SILENT_NOOP_BLOCKER =
  "dependency_install_silent_noop_empty_output_and_missing_skill";

/**
 * Multi-line diagnostic for a dependency install that exited 0, produced the
 * empty-output digest, and left no skill artifact behind. When the harness
 * already knows the sandbox tempRoot it retains, the diagnostic points at that
 * exact path; otherwise it tells the operator to rerun with --keep-temp.
 */
function formatDependencyInstallSilentNoopDiagnostic({ tempRoot = null } = {}) {
  return [
    "installer exited 0 with empty stdout and no artifact — silent noop suspected.",
    `A real installer run emits a line starting with "${INSTALLER_ACK_PREFIX}" as its first stdout line; the recorded dependencyInstallOutputSha256 equals the empty-output digest.`,
    tempRoot
      ? `--keep-temp is already enabled for this run; inspect the retained sandbox tempRoot: ${tempRoot}`
      : "Re-run with --keep-temp and inspect the reported isolation.tempRoot workspace.",
    "Then run scripts/install-global-skills-all-runtimes.mjs by hand inside the preserved workspace with the same isolated env.",
  ].join("\n");
}

/**
 * A dependency install that exits 0, prints nothing, and leaves no skill behind
 * is indistinguishable from success in the recorded evidence, so it gets its own
 * blocker name. `exitCode === null` means an earlier step short-circuited this
 * one and must keep reporting as that earlier failure.
 */
function classifyDependencyInstallStep({ exitCode, stdout, skillPresent, tempRoot = null } = {}) {
  const output = typeof stdout === "string" ? stdout : "";
  const outputEmpty = output.trim().length === 0;
  const silentNoop = exitCode === 0 && outputEmpty && skillPresent !== true;
  return {
    outputEmpty,
    ackObserved: hasInstallerAck(output),
    silentNoop,
    blocker: silentNoop ? DEPENDENCY_INSTALL_SILENT_NOOP_BLOCKER : null,
    diagnostic: silentNoop
      ? formatDependencyInstallSilentNoopDiagnostic({ tempRoot })
      : null,
  };
}

/**
 * Resolve the initial keep-temp choice from the --keep-temp flag and the
 * META_KIM_CLEAN_ROOM_KEEP_TEMP=1 environment opt-in. The flag wins when both
 * are present, and each source keeps its own retention reason for the report.
 */
export function resolveCleanRoomKeepTemp({
  args = process.argv.slice(2),
  env = process.env,
} = {}) {
  if (Array.isArray(args) && args.includes("--keep-temp")) {
    return { keepTemp: true, reason: "keep_temp_flag" };
  }
  if (String(env.META_KIM_CLEAN_ROOM_KEEP_TEMP ?? "").trim() === "1") {
    return { keepTemp: true, reason: "keep_temp_env" };
  }
  return { keepTemp: false, reason: null };
}
const FAST_PATH_CONTROL_PROMPT =
  "请对这个刚安装的项目做一次只读的发布前维护审计。核对依赖来源、跨运行环境兼容性和发布安全。最多查看 8 个最相关文件，最后用 10 行以内列出风险和证据。不得修改源码、安装依赖、提交、推送或访问工作区外文件。";
const GOVERNED_EXECUTION_PROMPT =
  "请为这个刚安装的项目制定并落地一份发布就绪改进方案。基于现有文件核对依赖来源、跨运行环境兼容性和发布安全，创建 release-readiness-plan.md，写清优先级、每项修改建议、验收方法和不做事项。最多查看 12 个最相关文件；只允许新增这一个报告文件，不得修改源码、安装依赖、提交、推送或访问工作区外文件。";
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function pathIsWithin(root, target, { allowRoot = false } = {}) {
  const relative = path.relative(root, target);
  return (allowRoot && relative === "") || (
    relative !== "" && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

async function realContainedFile(root, filePath, label) {
  const realRoot = await fs.realpath(path.resolve(root));
  const realFile = await fs.realpath(path.resolve(filePath));
  if (!pathIsWithin(realRoot, realFile)) throw new Error(`${label}_outside_allowed_root`);
  const stats = await fs.stat(realFile);
  if (!stats.isFile()) throw new Error(`${label}_not_regular_file`);
  return realFile;
}

async function atomicExclusiveWrite(filePath, bytes) {
  const resolved = path.resolve(filePath);
  const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  try {
    await fs.link(temporary, resolved);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function topLevelHostSessionFromRaw(rawHostJsonl, runtime, assistantMessages = []) {
  const records = parseJsonl(rawHostJsonl);
  const candidates = [];
  for (const { value } of records) {
    if (runtime === "codex" && value?.type === "session_meta") {
      candidates.push(value?.payload?.id ?? value?.payload?.session_id ?? null);
    }
    if (runtime === "codex" && value?.type === "thread.started") {
      candidates.push(value.thread_id ?? null);
    }
    if (runtime === "claude" && value?.type === "system") {
      candidates.push(value.session_id ?? value?.payload?.session_id ?? null);
    }
  }
  if (runtime === "claude") {
    candidates.push(...assistantMessages
      .filter((message) => message?.mainThreadChat === true)
      .map((message) => message.sessionId));
  }
  const sessions = [...new Set(candidates.filter(Boolean))];
  if (sessions.length !== 1) throw new Error(`top_level_host_session_count:${sessions.length}`);
  return sessions[0];
}

function bindAssistantMessagesToTopLevelSession(messages, topLevelSessionId) {
  return messages.map((message) => ({
    ...message,
    mainThreadChat:
      message.mainThreadChat === true && message.sessionId === topLevelSessionId,
  }));
}

async function atomicExclusiveMove(sourcePath, destinationPath) {
  await fs.link(sourcePath, destinationPath);
  await fs.rm(sourcePath);
}

function canonicalFlatEvents(events) {
  return (events ?? []).map((event) => {
    const marker = event?.metaKimBinding;
    if (!marker) return event;
    if (event.bindingRef != null) {
      const { metaKimBinding, ...canonical } = event;
      return canonical;
    }
    for (const [key, value] of Object.entries(marker)) {
      if (event[key] !== undefined && event[key] !== value) {
        throw new Error(`observer_binding_collision:${key}`);
      }
    }
    const { metaKimBinding, ...rest } = event;
    return { ...rest, ...marker };
  });
}

function conversationNoticeExpectations(artifact) {
  const notice = artifact?.conversationNotice ?? artifact?.coreLoop?.conversationNotice ?? null;
  const explicit = notice?.hostObservationExpectations ??
    notice?.progressObservationExpectations ??
    artifact?.coreLoop?.conversationNoticeObservationPacket?.expectedMessages ??
    [];
  if (!Array.isArray(explicit) || explicit.length === 0) {
    throw new Error("conversation_notice_observation_expectations_missing");
  }
  return explicit.map((entry, index) => {
    if (!/^[a-f0-9]{64}$/u.test(entry?.textSha256 ?? "")) {
      throw new Error(`conversation_notice_text_hash_missing:${index}`);
    }
    if (typeof entry?.stage !== "string" || entry.stage.length === 0) {
      throw new Error(`conversation_notice_stage_missing:${index}`);
    }
    return {
      textSha256: entry.textSha256,
      stage: entry.stage,
    };
  });
}

function joinConversationNotices(artifact, assistantMessages, topLevelSessionId) {
  const joined = conversationNoticeExpectations(artifact).map((expected, index) => {
    const matches = assistantMessages.filter((message) =>
      message?.textSha256 === expected.textSha256
    );
    if (matches.length !== 1) throw new Error(`conversation_notice_match_count:${index}:${matches.length}`);
    const message = matches[0];
    if (message.mainThreadChat !== true || message.sessionId !== topLevelSessionId) {
      throw new Error(`conversation_notice_not_main_thread:${index}`);
    }
    return {
      stage: expected.stage,
      textSha256: expected.textSha256,
      sessionId: message.sessionId,
      messageId: message.messageId,
      eventId: message.eventId,
      observerFormat: message.observerFormat,
      resultStatus: message.resultStatus,
      mainThreadChat: true,
    };
  });
  const sessions = new Set(joined.map((item) => item.sessionId).filter(Boolean));
  if (sessions.size !== 1 || joined.some((item) => !item.sessionId)) {
    throw new Error("conversation_notice_session_ambiguous_or_missing");
  }
  return joined;
}

function isGovernedArtifact(value) {
  return Boolean(
    value?.runId &&
    Array.isArray(value?.coreLoop?.runtimeInvocationPlanPacket?.requiredBindings),
  );
}

async function walkJsonFiles(root) {
  if (!existsSync(root)) return [];
  const results = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) results.push(...await walkJsonFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith(".json")) results.push(entryPath);
  }
  return results;
}

export async function snapshotGovernedArtifacts(workspace) {
  const stateRoot = path.join(path.resolve(workspace), ".meta-kim", "state");
  const snapshot = new Map();
  for (const filePath of await walkJsonFiles(stateRoot)) {
    try {
      const bytes = await fs.readFile(filePath);
      if (!isGovernedArtifact(JSON.parse(bytes.toString("utf8")))) continue;
      snapshot.set(path.resolve(filePath), sha256Bytes(bytes));
    } catch {
      // Non-run JSON and concurrently incomplete files are not governed artifacts.
    }
  }
  return snapshot;
}

export function selectSingleNewGovernedArtifact(before, after) {
  const changed = [...after.entries()]
    .filter(([filePath, digest]) => before.get(filePath) !== digest)
    .map(([filePath]) => filePath)
    .sort();
  if (changed.length !== 1) {
    throw new Error(`governed_artifact_count:${changed.length}`);
  }
  return changed[0];
}

export async function buildUnsignedCandidateBundle({
  artifactsDir,
  harnessRunId,
  governedArtifactPath,
  governedArtifactRoot,
  selectedGovernedArtifactSha256,
  runtime,
  rawHostJsonl,
}) {
  if (!SAFE_RUN_ID.test(harnessRunId ?? "")) throw new Error("harness_run_id_invalid");
  if (!['codex', 'claude'].includes(runtime)) throw new Error("observer_runtime_invalid");
  if (typeof rawHostJsonl !== "string" || rawHostJsonl.length === 0) {
    throw new Error("raw_host_jsonl_missing");
  }
  if (!/^[a-f0-9]{64}$/u.test(selectedGovernedArtifactSha256 ?? "")) {
    throw new Error("selected_governed_artifact_sha256_missing");
  }
  const realArtifactsDir = await fs.realpath(path.resolve(artifactsDir));
  const realGovernedPath = await realContainedFile(
    governedArtifactRoot,
    governedArtifactPath,
    "governed_artifact",
  );
  const governedBytes = await fs.readFile(realGovernedPath);
  const governedSha256 = sha256Bytes(governedBytes);
  if (governedSha256 !== selectedGovernedArtifactSha256) {
    throw new Error("governed_artifact_changed_after_snapshot");
  }
  const governedArtifact = JSON.parse(governedBytes.toString("utf8"));
  const observedEvents = runtime === "codex"
    ? observeCodexJsonl(rawHostJsonl)
    : observeClaudeJsonl(rawHostJsonl);
  const events = canonicalFlatEvents(observedEvents);
  const assistantMessages = runtime === "codex"
    ? observeCodexAssistantMessages(rawHostJsonl)
    : observeClaudeAssistantMessages(rawHostJsonl);
  const topLevelHostSessionId = topLevelHostSessionFromRaw(
    rawHostJsonl,
    runtime,
    assistantMessages,
  );
  const sessionBoundAssistantMessages = bindAssistantMessagesToTopLevelSession(
    assistantMessages,
    topLevelHostSessionId,
  );
  const conversationNoticeObservations = joinConversationNotices(
    governedArtifact,
    sessionBoundAssistantMessages,
    topLevelHostSessionId,
  );
  const markedEvents = (events ?? []).filter((event) => event?.bindingRef != null);
  if (markedEvents.length === 0) {
    throw new Error("missing_raw_host_binding_marker");
  }
  if (markedEvents.some((event) => event.runId !== governedArtifact.runId)) {
    throw new Error("governed_run_id_mismatch");
  }

  const bundlesRoot = path.join(realArtifactsDir, "bundles");
  await fs.mkdir(bundlesRoot, { recursive: true });
  const realBundlesRoot = await fs.realpath(bundlesRoot);
  if (!pathIsWithin(realArtifactsDir, realBundlesRoot)) throw new Error("bundles_root_outside_artifacts");
  const bundleRoot = path.resolve(realBundlesRoot, harnessRunId);
  if (!pathIsWithin(realBundlesRoot, bundleRoot)) throw new Error("bundle_root_outside_artifacts");
  await fs.mkdir(bundleRoot);
  const realBundleRoot = await fs.realpath(bundleRoot);
  if (!pathIsWithin(realBundlesRoot, realBundleRoot)) throw new Error("bundle_symlink_escape");
  const governedBundlePath = path.join(bundleRoot, `${governedSha256}.governed.json`);
  await atomicExclusiveWrite(governedBundlePath, governedBytes);
  const rawBytes = Buffer.from(rawHostJsonl, "utf8");
  const rawSha256 = sha256Bytes(rawBytes);
  const rawObservationPath = path.join(bundleRoot, `${rawSha256}.raw.jsonl`);
  await atomicExclusiveWrite(rawObservationPath, rawBytes);
  const normalizedObservation = {
    schemaVersion: "clean-room-normalized-binding-observation-v0.1",
    runId: governedArtifact.runId,
    rawArtifact: {
      path: path.basename(rawObservationPath),
      sha256: rawSha256,
    },
    events,
    topLevelHostSessionId,
    assistantMessages: sessionBoundAssistantMessages.map(({ text, ...observation }) => observation),
    conversationNoticeObservations,
    retentionPolicy: {
      classification: "local_sensitive",
      successfulBundlePolicy: "content_addressed_bundle_only",
      failedBundlePolicy: "standalone_raw_failure_diagnostic",
      deletionAuthority: "maintainer_or_release_evidence_retention_job",
    },
  };
  const observationBytes = Buffer.from(`${JSON.stringify(normalizedObservation, null, 2)}\n`, "utf8");
  const observationSha256 = sha256Bytes(observationBytes);
  const observationPath = path.join(bundleRoot, `${observationSha256}.observation.json`);
  await atomicExclusiveWrite(observationPath, observationBytes);
  const temporaryCandidatePath = path.join(bundleRoot, "candidate.pending.json");
  const candidate = await buildExactBindingCandidateFromFiles({
    governedArtifactPath: governedBundlePath,
    observationPath,
    rawObservationPath,
    outputPath: temporaryCandidatePath,
    bundleRoot,
    conversationNoticeObservations,
    retentionPolicy: normalizedObservation.retentionPolicy,
  });
  const candidateBytes = await fs.readFile(temporaryCandidatePath);
  const candidateSha256 = sha256Bytes(candidateBytes);
  const candidatePath = path.join(bundleRoot, `${candidateSha256}.candidate.json`);
  await atomicExclusiveMove(temporaryCandidatePath, candidatePath);
  return {
    status: "unsigned_candidate_built",
    promotionEligible: false,
    exactBindingCoverage: false,
    governedRunId: governedArtifact.runId,
    bundleRoot: path.relative(realArtifactsDir, bundleRoot).replaceAll("\\", "/"),
    governedArtifact: { path: path.basename(governedBundlePath), sha256: governedSha256 },
    rawHostJsonl: { path: path.basename(rawObservationPath), sha256: rawSha256 },
    observation: { path: path.basename(observationPath), sha256: observationSha256 },
    candidate: { path: path.basename(candidatePath), sha256: candidateSha256 },
    candidateStatus: candidate.status,
    conversationNoticeObservations,
    retentionPolicy: {
      classification: "local_sensitive",
      successfulBundlePolicy: "content_addressed_bundle_only",
      failedBundlePolicy: "standalone_raw_failure_diagnostic",
      deletionAuthority: "maintainer_or_release_evidence_retention_job",
    },
    trustBoundary:
      "Unsigned candidate only; exactBindingCoverage remains false until a private external observer verifies and attests every selected binding.",
  };
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeoutMs ?? 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function runCli(command, args, options = {}) {
  if (process.platform !== "win32") return run(command, args, options);
  const invocation = resolveWindowsCliInvocation(command, args, {
    env: options.env ?? process.env,
  });
  return run(invocation.command, invocation.args, options);
}

function baseIsolatedEnv(home, runtimeHome, tempDir) {
  const allowed = [
    "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec",
    "LANG", "LC_ALL", "TERM", "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    // install-global-skills-all-runtimes.mjs reads this explicit git proxy
    // switch. HOME isolation strips ~/.gitconfig, so a loopback proxy
    // configured there is invisible to the dependency git clone; without this
    // passthrough the clean-room dependency step cannot run on proxied or
    // offline-first machines.
    "META_KIM_GIT_PROXY",
  ];
  const env = Object.fromEntries(
    allowed.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]),
  );
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: runtimeHome,
    CLAUDE_CONFIG_DIR: runtimeHome,
    CLAUDE_HOME: runtimeHome,
    TMP: tempDir,
    TEMP: tempDir,
    CODEX_SKILLS_DIR: path.join(runtimeHome, "skills"),
    CLAUDE_SKILLS_DIR: path.join(runtimeHome, "skills"),
    META_KIM_DEP_ROOTS: "",
    META_KIM_HOST_INVOCATION_EVIDENCE: "",
    META_KIM_HOST_INVOCATION_EVIDENCE_TRUSTED: "",
    META_KIM_NATIVE_CHOICE_EVIDENCE: "",
    META_KIM_NATIVE_CHOICE_EVIDENCE_TRUSTED: "",
  };
}

async function copyCodexAuthOnly(runtimeHome) {
  const sourceHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const source = path.join(sourceHome, "auth.json");
  if (!existsSync(source)) return { copied: false, reason: "auth_json_missing" };
  const content = await fs.readFile(source, "utf8");
  await fs.mkdir(runtimeHome, { recursive: true });
  await fs.writeFile(path.join(runtimeHome, "auth.json"), content, { encoding: "utf8", mode: 0o600 });
  return { copied: true, sourceKind: "codex_auth_json_only", credentialMaterialRecorded: false };
}

async function copiedCredentialAbsent(filePath) {
  try {
    await fs.access(filePath);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

async function scrubAndRemoveCopiedCredential(filePath, { retries = 8 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (await copiedCredentialAbsent(filePath)) return;
    try {
      const stat = await fs.lstat(filePath);
      if (stat.isFile()) {
        const handle = await fs.open(filePath, "r+");
        try {
          const zeros = Buffer.alloc(Math.min(64 * 1024, Math.max(1, stat.size)));
          for (let offset = 0; offset < stat.size; offset += zeros.length) {
            const length = Math.min(zeros.length, stat.size - offset);
            await handle.write(zeros, 0, length, offset);
          }
          await handle.sync();
          await handle.truncate(0);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      await fs.rm(filePath, { force: true });
      if (await copiedCredentialAbsent(filePath)) return;
      lastError = new Error("copied credential still exists after removal");
    } catch (error) {
      lastError = error;
      await fs.chmod(filePath, 0o600).catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
  }
  throw new Error(
    `Unable to scrub and remove copied Codex credential: ${lastError?.message ?? "unknown error"}`,
    { cause: lastError },
  );
}

async function cleanupCleanRoomTemp(
  tempRoot,
  { preserveTemp = false, removeTree = fs.rm } = {},
) {
  const codexHome = path.join(tempRoot, "user-home", "codex-home");
  const copiedAuthPath = path.join(codexHome, "auth.json");
  try {
    await scrubAndRemoveCopiedCredential(copiedAuthPath);
  } catch (credentialError) {
    // Diagnostic preservation never takes precedence over credential removal.
    await fs.rm(codexHome, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 250,
    }).catch(() => {});
    if (!(await copiedCredentialAbsent(copiedAuthPath))) {
      throw credentialError;
    }
  }
  if (preserveTemp) return;
  try {
    await removeTree(tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 500,
    });
  } catch (error) {
    if (!["EBUSY", "EPERM"].includes(error?.code)) throw error;
    process.stderr.write(
      `clean-room temp cleanup deferred because a runtime still holds a file: ${tempRoot}\n`,
    );
  }
}

function inheritClaudeAuth(env) {
  const names = [
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN", "AWS_PROFILE", "AWS_REGION",
    "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION",
  ];
  const inherited = [];
  for (const name of names) {
    if (!process.env[name]) continue;
    env[name] = process.env[name];
    inherited.push(name);
  }
  return inherited;
}

async function packAndExtract(tempRoot) {
  const packDir = path.join(tempRoot, "pack");
  const extractDir = path.join(tempRoot, "user-home", "workspace");
  await fs.mkdir(packDir, { recursive: true });
  await fs.mkdir(extractDir, { recursive: true });
  const packed = runCli("npm", ["pack", "--json", "--pack-destination", packDir], {
    cwd: repoRoot,
    timeoutMs: 180_000,
  });
  if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout || "npm pack failed");
  const packResult = JSON.parse(packed.stdout);
  const tarball = path.join(packDir, packResult[0].filename);
  const tarballBytes = await fs.readFile(tarball);
  const extraction = tarExtractCommand(tarball, extractDir);
  const extracted = run(extraction.command, extraction.args, { cwd: extraction.cwd, timeoutMs: 120_000 });
  if (extracted.status !== 0) throw new Error(extracted.stderr || extracted.stdout || "tar extract failed");
  return {
    workspace: path.join(extractDir, "package"),
    tarball,
    tarballSha256: createHash("sha256").update(tarballBytes).digest("hex"),
  };
}

/**
 * The install gate keeps the dependency-install no-op named. Every other reason
 * to stop before the blind host run stays under the generic blocker.
 */
function resolveInstallGateOutcome({
  installExitCode,
  dependencyReady,
  dependencyStep,
  projectionSyncExitCode,
  bootstrapExitCode,
  mcpTransportProbeExitCode,
  mcpTransportEventCount,
} = {}) {
  const blocked =
    installExitCode !== 0 ||
    dependencyReady !== true ||
    dependencyStep?.silentNoop === true ||
    projectionSyncExitCode !== 0 ||
    bootstrapExitCode !== 0 ||
    mcpTransportProbeExitCode !== 0 ||
    mcpTransportEventCount !== 1;
  if (!blocked) return { blocked, blocker: null, diagnostic: null };
  return {
    blocked,
    blocker: dependencyStep?.blocker ?? "clean_install_or_project_bootstrap_failed",
    diagnostic: dependencyStep?.diagnostic ?? null,
  };
}

export async function verifyInstalledDependency({
  dependencyDir,
  installExitCode,
  env,
  expectedRef = EXPECTED_AGENT_TEAMS_PLAYBOOK_REF,
  expectedCommit = EXPECTED_AGENT_TEAMS_PLAYBOOK_COMMIT,
  expectedSkillSha256 = EXPECTED_AGENT_TEAMS_PLAYBOOK_SKILL_SHA256,
}) {
  const skillPath = path.join(dependencyDir, "SKILL.md");
  let ownGitRoot = false;
  // rev-parse alone can discover a parent repository. Never fetch or checkout
  // unless this exact installed directory owns its own plain Git directory.
  if (installExitCode === 0) {
    try {
      const directory = await fs.lstat(dependencyDir);
      const gitDirectory = await fs.lstat(path.join(dependencyDir, ".git"));
      if (directory.isDirectory() && gitDirectory.isDirectory() && !gitDirectory.isSymbolicLink()) {
        const top = run("git", ["-C", dependencyDir, "rev-parse", "--show-toplevel"], { env, timeoutMs: 30_000 });
        if (top.status === 0) {
          ownGitRoot = await fs.realpath(String(top.stdout).trim()) === await fs.realpath(dependencyDir);
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const readCommit = () => {
    if (!ownGitRoot) return null;
    const result = run("git", ["-C", dependencyDir, "rev-parse", "HEAD"], { env, timeoutMs: 30_000 });
    return result.status === 0 ? String(result.stdout).trim() : null;
  };
  let dependencyCommit = readCommit();
  const dependencyPin = {
    expectedRef, expectedCommit,
    action: dependencyCommit === expectedCommit ? "already_expected_commit" : "not_attempted",
    exitCode: dependencyCommit === expectedCommit ? 0 : null,
  };
  if (ownGitRoot && dependencyCommit !== expectedCommit) {
    const fetchTag = run("git", [
      "-C", dependencyDir, "fetch", "--depth", "1", "origin",
      `refs/tags/${expectedRef}:refs/tags/${expectedRef}`,
    ], { env, timeoutMs: 120_000 });
    const checkout = fetchTag.status === 0
      ? run("git", ["-C", dependencyDir, "checkout", "--detach", expectedCommit], { env, timeoutMs: 30_000 })
      : { status: null };
    Object.assign(dependencyPin, {
      action: "fetch_tag_and_detach", fetchExitCode: fetchTag.status, exitCode: checkout.status,
    });
    dependencyCommit = readCommit();
  }
  // Presence and digest describe the selected revision, never the clone's
  // default branch before pinning (whose layout may legitimately differ).
  const dependencySkillSha256 = existsSync(skillPath)
    ? createHash("sha256").update(await fs.readFile(skillPath)).digest("hex")
    : null;
  let dependencyArchiveMetadata = null;
  try {
    dependencyArchiveMetadata = JSON.parse(await fs.readFile(path.join(dependencyDir, ".meta-kim-source.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  const archiveRevisionVerified =
    dependencyArchiveMetadata?.source === "github_archive_fallback" &&
    String(dependencyArchiveMetadata?.rootName ?? "").toLowerCase().endsWith(`-${expectedCommit.slice(0, 7)}`) &&
    dependencySkillSha256 === expectedSkillSha256;
  if (!ownGitRoot && archiveRevisionVerified) {
    Object.assign(dependencyPin, { action: "verified_archive_commit_prefix_and_skill_hash", exitCode: 0 });
  }
  const dependencyRevisionVerified = dependencyCommit === expectedCommit || archiveRevisionVerified;
  return {
    dependencyCommit, dependencyPin, dependencySkillSha256,
    dependencyArchiveMetadata, dependencyRevisionVerified,
    dependencyReady: installExitCode === 0 && dependencyPin.exitCode === 0 &&
      dependencyRevisionVerified && dependencySkillSha256 === expectedSkillSha256,
  };
}

export async function copyCleanRoomProject({ sourceWorkspace, workspace }) {
  try {
    await fs.lstat(workspace);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // fs.cp creates the destination itself. Pre-creating it conflicts with
    // errorOnExist on Node 24 and would obscure the no-overwrite guarantee.
    await fs.cp(sourceWorkspace, workspace, { recursive: true, errorOnExist: true, force: false });
    return;
  }
  throw new Error(`clean-room project target already exists: ${workspace}`);
}

export async function initializeCleanRoomProject({
  workspace, sourceWorkspace = repoRoot, runtimeTarget, env, timeoutMs, runCommand = run,
}) {
  const sourceRoot = await fs.realpath(sourceWorkspace);
  const projectRoot = await fs.realpath(workspace);
  const relative = path.relative(sourceRoot, projectRoot);
  const reverse = path.relative(projectRoot, sourceRoot);
  const overlaps = (value) => value === "" || (!value.startsWith(`..${path.sep}`) && value !== ".." && !path.isAbsolute(value));
  if (overlaps(relative) || overlaps(reverse)) {
    throw new Error("clean-room package source and project target must be separate, non-overlapping roots");
  }
  const projectionSyncMode = "bootstrap_only_with_dry_run_and_manifest_verification";
  const args = [path.join(sourceWorkspace, "setup.mjs"), "--project-bootstrap",
    "--project-dir", workspace, "--targets", runtimeTarget];
  // Bootstrap is the only writer: sync-runtimes uses another ownership ledger
  // and can pre-create files that bootstrap correctly treats as user-owned.
  const bootstrap = runCommand(process.execPath, [...args, "--apply", "--json"], { cwd: workspace, env, timeoutMs });
  if (bootstrap.status !== 0) {
    return { bootstrap, projectionSyncMode, projectionVerification: {
      status: null, stdout: "", stderr: "bootstrap_failed_before_projection_verification",
    } };
  }
  const verification = runCommand(process.execPath, [...args, "--dry-run", "--json"], { cwd: workspace, env, timeoutMs });
  if (verification.status !== 0) return { bootstrap, projectionSyncMode, projectionVerification: verification };
  try {
    const summary = JSON.parse(verification.stdout);
    const state = summary.results?.[0]?.state;
    if (summary.ok !== true || summary.results?.length !== 1 ||
        state?.status !== "ready" || state?.counts?.pending !== 0 ||
        typeof state.targetDir !== "string" || path.resolve(state.targetDir) !== path.resolve(workspace)) {
      throw new Error("bootstrap dry-run must report this project ready with zero pending files");
    }
    const root = await fs.realpath(workspace);
    const inside = (target) => {
      const relative = path.relative(root, target);
      return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    const manifestPath = path.join(workspace, ".meta-kim/state/default/project-bootstrap.json");
    if (!inside(await fs.realpath(manifestPath))) throw new Error("bootstrap manifest escaped its project");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    if (manifest.schemaVersion !== "meta-kim-project-bootstrap-v0.1" ||
        !Array.isArray(manifest.managedFiles) || manifest.managedFiles.length === 0) {
      throw new Error("bootstrap ownership manifest must contain managed files");
    }
    const seen = new Set();
    for (const entry of manifest.managedFiles) {
      if (typeof entry.relPath !== "string" || path.isAbsolute(entry.relPath) ||
          !/^[a-f0-9]{64}$/iu.test(entry.contentHash ?? "")) {
        throw new Error("invalid bootstrap managed file binding");
      }
      const target = path.resolve(root, entry.relPath);
      if (!inside(target) || seen.has(target)) throw new Error("unsafe or duplicate bootstrap managed path");
      seen.add(target);
      if (!inside(await fs.realpath(target))) throw new Error("bootstrap managed file escaped its project");
      const actual = createHash("sha256").update(await fs.readFile(target)).digest("hex");
      if (actual !== entry.contentHash.toLowerCase()) throw new Error(`bootstrap managed hash mismatch: ${entry.relPath}`);
    }
    return { bootstrap, projectionSyncMode, projectionVerification: {
      ...verification, managedFileCount: seen.size,
    } };
  } catch (error) {
    return { bootstrap, projectionSyncMode, projectionVerification: {
      ...verification, status: 1, stderr: `${verification.stderr ?? ""}\n${error.message}`,
    } };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name, fallback = null) => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  const preflightOnly = args.includes("--preflight");
  const installOnly = args.includes("--install-only");
  const scenario = value("--scenario", "governed_execution");
  if (!["governed_execution", "fast_path_control"].includes(scenario)) {
    throw new Error("--scenario must be governed_execution or fast_path_control");
  }
  const runtime = value("--runtime", preflightOnly ? "preflight" : null);
  if (!runtime || !["preflight", "codex", "claude"].includes(runtime)) {
    throw new Error("Use --preflight or --runtime codex|claude");
  }
  const promptPath = value("--prompt-file");
  const timeoutMs = Number(value("--timeout-ms", "300000"));
  if (!Number.isFinite(timeoutMs) || timeoutMs < 10_000) {
    throw new Error("--timeout-ms must be a finite number >= 10000");
  }
  const prompt = promptPath
    ? await fs.readFile(path.resolve(promptPath), "utf8")
    : scenario === "fast_path_control"
      ? FAST_PATH_CONTROL_PROMPT
      : GOVERNED_EXECUTION_PROMPT;
  const promptLint = lintBlindPrompt(prompt);
  if (!promptLint.pass) throw new Error(`Blind prompt leaks capability names: ${promptLint.hits.join(", ")}`);

  const runId = `clean-room-${runtime}-${randomUUID()}`;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-clean-room-"));
  const artifactsDir = path.resolve(
    value("--artifact-dir", path.join(repoRoot, ".meta-kim", "state", "default", "clean-room-live")),
  );
  await fs.mkdir(artifactsDir, { recursive: true });
  const initialKeepTemp = resolveCleanRoomKeepTemp({ args });
  let keepTemp = initialKeepTemp.keepTemp;
  let tempRetentionReason = initialKeepTemp.reason;
  const withTempRetention = (base) => ({
    ...base,
    tempRootRetained: keepTemp,
    tempRootRetentionReason: tempRetentionReason,
  });
  try {
    const packageInfo = await packAndExtract(tempRoot);
    const projectWorkspace = path.join(tempRoot, "user-home", "project");
    const userHome = path.join(tempRoot, "user-home");
    const runtimeHome = path.join(userHome, `${runtime}-home`);
    const isolatedTemp = path.join(tempRoot, "tmp");
    await fs.mkdir(userHome, { recursive: true });
    await fs.mkdir(runtimeHome, { recursive: true });
    await fs.mkdir(isolatedTemp, { recursive: true });
    const parentEntries = await fs.readdir(path.dirname(packageInfo.workspace));
    const osSharedAgentsSkillRoot = path.join(os.homedir(), ".agents", "skills");
    const codexSharedSkillRootContaminates =
      runtime === "codex" &&
      existsSync(osSharedAgentsSkillRoot) &&
      !path.resolve(osSharedAgentsSkillRoot).startsWith(path.resolve(userHome));
    const isolation = {
      tempRoot,
      home: userHome,
      runtimeHome,
      tempDir: isolatedTemp,
      packageWorkspace: packageInfo.workspace,
      projectWorkspace,
      packageSha256: packageInfo.tarballSha256,
      siblingAgentTeamsPlaybookAbsent: !parentEntries.some((name) => /agent-teams-playbook/i.test(name)),
      globalInventoryInjectionConfigured: false,
      osSharedAgentsSkillRoot,
      codexSharedSkillRootContaminates,
      promptSha256: sha256(prompt),
      promptLint,
      scenario,
    };
    if (preflightOnly) {
      const report = { schemaVersion: "clean-room-live-acceptance-v0.1", runId, status: "preflight_pass", isolation: withTempRetention(isolation) };
      await fs.writeFile(path.join(artifactsDir, `${runId}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }

    const env = baseIsolatedEnv(userHome, runtimeHome, isolatedTemp);
    const runtimeTarget = runtime === "claude" ? "claude" : "codex";
    const install = runCli("npm", [
      "install", "--ignore-scripts", "--no-audit", "--no-fund",
    ], { cwd: packageInfo.workspace, env, timeoutMs });
    if (install.status === 0) {
      // Keep the packed setup source fixed. The project receives a separate
      // copy, including installed dependencies required by its MCP/scripts.
      await copyCleanRoomProject({ sourceWorkspace: packageInfo.workspace, workspace: projectWorkspace });
    }
    const dependencyInstall = install.status === 0
      ? run(process.execPath, [
          path.join(packageInfo.workspace, "scripts", "install-global-skills-all-runtimes.mjs"),
          "--targets", runtimeTarget,
          "--skills", "agent-teams-playbook",
          "--skip-inventory-refresh",
        ], { cwd: packageInfo.workspace, env, timeoutMs })
      : { status: null, stdout: "", stderr: "npm_install_failed_before_dependency_install" };
    const dependencySkillPath = path.join(
      runtimeHome,
      "skills",
      "agent-teams-playbook",
      "SKILL.md",
    );
    const dependencyDir = path.dirname(dependencySkillPath);
    const dependencyStep = classifyDependencyInstallStep({
      exitCode: dependencyInstall.status,
      stdout: dependencyInstall.stdout,
      skillPresent: existsSync(dependencySkillPath),
      tempRoot,
    });
    if (dependencyStep.silentNoop && !keepTemp) {
      keepTemp = true;
      tempRetentionReason = DEPENDENCY_INSTALL_SILENT_NOOP_BLOCKER;
    }
    const {
      dependencySkillSha256, dependencyArchiveMetadata, dependencyCommit,
      dependencyPin, dependencyRevisionVerified, dependencyReady,
    } = await verifyInstalledDependency({
      dependencyDir, installExitCode: dependencyInstall.status, env,
    });
    const projectInitialization = dependencyReady
      ? await initializeCleanRoomProject({ workspace: projectWorkspace, sourceWorkspace: packageInfo.workspace, runtimeTarget, env, timeoutMs })
      : { bootstrap: { status: null, stdout: "", stderr: "dependency_install_failed_before_bootstrap" },
          projectionVerification: { status: null, stdout: "", stderr: "dependency_install_failed_before_projection_verification" },
          projectionSyncMode: "not_attempted_dependency_not_ready" };
    const { bootstrap, projectionVerification } = projectInitialization;
    const mcpTransportProbe = projectionVerification.status === 0
      ? run(process.execPath, [
          path.join(packageInfo.workspace, "scripts", "live-acceptance", "probe-mcp-transport.mjs"),
          // The protocol probe must load the server and its source evidence
          // from the fixed package; the project's AGENTS.md is a projection.
          "--repo-root", packageInfo.workspace,
        ], { cwd: projectWorkspace, env, timeoutMs: 60_000 })
      : { status: null, stdout: "", stderr: "projection_verification_failed_before_mcp_transport_probe" };
    const mcpTransportEvents = mcpTransportProbe.status === 0
      ? observeMcpClientJsonl(mcpTransportProbe.stdout)
      : [];
    const installation = {
      installExitCode: install.status,
      dependencyInstallExitCode: dependencyInstall.status,
      dependencyReady,
      dependencyCommit,
      dependencyPin,
      dependencyRevisionVerified,
      dependencyArchiveMetadata,
      dependencySkillSha256,
      projectionSyncMode: projectInitialization.projectionSyncMode,
      projectionSyncExitCode: projectionVerification.status,
      projectionVerifiedManagedFileCount: projectionVerification.managedFileCount ?? 0,
      bootstrapExitCode: bootstrap.status,
      mcpTransportProbeExitCode: mcpTransportProbe.status,
      mcpTransportConformanceObserved: mcpTransportEvents.length === 1,
      mcpTransportPackageRoot: packageInfo.workspace,
      mcpTransportProjectCwd: projectWorkspace,
      mcpTransportConformanceBoundary:
        "This proves the packed installation can complete MCP initialize, tools/list, and tools/call. It does not prove the blind host route selected MCP.",
      installOutputSha256: sha256(install.stdout ?? ""),
      dependencyInstallOutputSha256: sha256(dependencyInstall.stdout ?? ""),
      dependencyInstallOutputEmpty: dependencyStep.outputEmpty,
      dependencyInstallAckObserved: dependencyStep.ackObserved,
      dependencyInstallSilentNoop: dependencyStep.silentNoop,
      dependencyInstallSilentNoopDiagnostic: dependencyStep.diagnostic,
      projectionSyncOutputSha256: sha256(projectionVerification.stdout ?? ""),
      bootstrapOutputSha256: sha256(bootstrap.stdout ?? ""),
      mcpTransportProbeOutputSha256: sha256(mcpTransportProbe.stdout ?? ""),
      stderrTail: `${install.stderr ?? ""}\n${dependencyInstall.stderr ?? ""}\n${projectionVerification.stderr ?? ""}\n${bootstrap.stderr ?? ""}`.slice(-2000),
      projectedAgentsPresent:
        existsSync(path.join(projectWorkspace, runtime === "claude" ? ".claude" : ".codex", "agents")),
      projectedSkillPresent: existsSync(
        path.join(projectWorkspace, runtime === "claude" ? ".claude" : ".agents", "skills", "meta-theory", "SKILL.md"),
      ),
      dependencySkillPresent: existsSync(dependencySkillPath),
    };
    const installGate = resolveInstallGateOutcome({
      installExitCode: install.status,
      dependencyReady,
      dependencyStep,
      projectionSyncExitCode: projectionVerification.status,
      bootstrapExitCode: bootstrap.status,
      mcpTransportProbeExitCode: mcpTransportProbe.status,
      mcpTransportEventCount: mcpTransportEvents.length,
    });
    if (installGate.blocked) {
      const report = {
        schemaVersion: "clean-room-live-acceptance-v0.1",
        runId,
        target: runtime === "codex" ? "codex_cli" : "claude_code",
        status: "blocked",
        blocker: installGate.blocker,
        ...(installGate.diagnostic ? { blockerDiagnostic: installGate.diagnostic } : {}),
        isolation: withTempRetention(isolation),
        installation,
      };
      await fs.writeFile(path.join(artifactsDir, `${runId}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (installGate.diagnostic) {
        process.stderr.write(`${report.blocker}: ${installGate.diagnostic}\n`);
      }
      process.exitCode = 1;
      return;
    }
    if (installOnly) {
      const report = {
        schemaVersion: "clean-room-live-acceptance-v0.1",
        runId,
        target: runtime === "codex" ? "codex_cli" : "claude_code",
        status: "install_pass",
        isolation: withTempRetention(isolation),
        installation,
      };
      await fs.writeFile(path.join(artifactsDir, `${runId}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    if (codexSharedSkillRootContaminates) {
      const report = {
        schemaVersion: "clean-room-live-acceptance-v0.1",
        runId,
        target: "codex_cli",
        scenario,
        status: "blocked",
        promotionEligible: false,
        exactBindingCoverage: false,
        blocker: "codex_cli_global_agents_skills_cannot_be_isolated_in_current_host",
        isolation: withTempRetention(isolation),
        installation,
        targetBoundary:
          "Codex CLI scans the OS-user ~/.agents/skills root even with isolated HOME, USERPROFILE, CODEX_HOME, --ignore-user-config, and explicit runtime skill roots. Use an OS-level disposable user/container or a host-supported global-skill disable switch before claiming clean-room CLI evidence. This does not describe Codex Desktop.",
      };
      await fs.writeFile(path.join(artifactsDir, `${runId}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = 1;
      return;
    }
    const governedArtifactsBefore = await snapshotGovernedArtifacts(projectWorkspace);
    let authBoundary;
    let result;
    if (runtime === "codex") {
      authBoundary = await copyCodexAuthOnly(runtimeHome);
      result = runCli("codex", [
        "exec", "--json", "--ephemeral", "--ignore-user-config",
        "--skip-git-repo-check", "--dangerously-bypass-hook-trust",
        "-s", "workspace-write", "-C", projectWorkspace, "-",
      ], { cwd: projectWorkspace, env, input: prompt, timeoutMs });
    } else {
      authBoundary = { inheritedEnvironmentVariables: inheritClaudeAuth(env) };
      const settingsPath = path.join(tempRoot, "claude-settings.json");
      const projectedMcpPath = path.join(projectWorkspace, ".mcp.json");
      const mcpPath = existsSync(projectedMcpPath)
        ? projectedMcpPath
        : path.join(tempRoot, "claude-mcp.json");
      await fs.writeFile(settingsPath, "{}\n", "utf8");
      if (!existsSync(mcpPath)) await fs.writeFile(mcpPath, "{\"mcpServers\":{}}\n", "utf8");
      result = runCli("claude", [
        "-p", "--output-format", "stream-json", "--verbose", "--include-hook-events",
        "--strict-mcp-config", "--mcp-config", mcpPath, "--settings", settingsPath,
        "--permission-mode", "dontAsk", "--no-session-persistence",
      ], { cwd: projectWorkspace, env, input: prompt, timeoutMs });
    }
    const rawPath = path.join(artifactsDir, `${runId}.raw.jsonl`);
    await atomicExclusiveWrite(rawPath, result.stdout ?? "");
    const events = runtime === "codex"
      ? observeCodexJsonl(result.stdout)
      : observeClaudeJsonl(result.stdout);
    const assistantMessages = runtime === "codex"
      ? observeCodexAssistantMessages(result.stdout)
      : observeClaudeAssistantMessages(result.stdout);
    const governedArtifactsAfter = await snapshotGovernedArtifacts(projectWorkspace);
    let candidateGeneration;
    try {
      const governedArtifactPath = selectSingleNewGovernedArtifact(
        governedArtifactsBefore,
        governedArtifactsAfter,
      );
      candidateGeneration = await buildUnsignedCandidateBundle({
        artifactsDir,
        harnessRunId: runId,
        governedArtifactPath,
        governedArtifactRoot: path.join(projectWorkspace, ".meta-kim", "state"),
        selectedGovernedArtifactSha256: governedArtifactsAfter.get(governedArtifactPath),
        runtime,
        rawHostJsonl: result.stdout ?? "",
      });
    } catch (error) {
      candidateGeneration = {
        status: "blocked",
        promotionEligible: false,
        exactBindingCoverage: false,
        reason: error.message,
        requiredRunnerChange:
          error.message === "missing_raw_host_binding_marker"
            ? "The runtime host dispatcher must copy hostInvocationRequestPacket exact values plus taskPacketId and roleInstanceId into an immutable metaKimBinding marker in the real Task/spawn call arguments."
            : error.message.startsWith("conversation_notice_")
              ? "The governed runner must emit conversationNotice.hostObservationExpectations[] with one {stage, textSha256} entry for every required visible progress notice. The harness derives the single real host session from completed assistant-message events; callers must not provide a session id."
            : null,
      };
    }
    let standaloneRawRetained = true;
    if (candidateGeneration.status === "unsigned_candidate_built") {
      try {
        await fs.rm(rawPath);
        standaloneRawRetained = false;
      } catch (error) {
        candidateGeneration = {
          ...candidateGeneration,
          status: "blocked",
          promotionEligible: false,
          exactBindingCoverage: false,
          reason: `standalone_raw_cleanup_failed:${error.code ?? error.message}`,
        };
      }
    }
    const contentAddressedRawPath = candidateGeneration.rawHostJsonl
      ? path.join(artifactsDir, candidateGeneration.bundleRoot, candidateGeneration.rawHostJsonl.path)
      : null;
    const retainedRawPath = standaloneRawRetained ? rawPath : contentAddressedRawPath;
    const naturallyObservedFamilies = [...new Set(events.map((event) => event.family))].sort();
    // This harness observes host behavior; it deliberately cannot promote its
    // own output to route completion. Exact selected-binding coverage must be
    // joined by an external release verifier after the host exits.
    const exactBindingCoverage = false;
    const report = {
      schemaVersion: "clean-room-live-acceptance-v0.1",
      runId,
      target: runtime === "codex" ? "codex_cli" : "claude_code",
      acceptanceMode: "blind_route",
      scenario,
      status:
        result.status === 0 &&
        events.length > 0 &&
        candidateGeneration.status === "unsigned_candidate_built"
          ? "orchestration_observed"
          : "blocked",
      promotionEligible: false,
      exactBindingCoverage,
      process: {
        exitCode: result.status,
        signal: result.signal ?? null,
        stderrTail: String(result.stderr ?? "").slice(-2000),
      },
      isolation: withTempRetention(isolation),
      installation,
      authBoundary,
      candidateGeneration,
      observation: {
        rawArtifact: retainedRawPath,
        standaloneFailureDiagnostic: standaloneRawRetained ? rawPath : null,
        rawSha256: sha256(result.stdout ?? ""),
        retentionPolicy: {
          classification: "local_sensitive",
          state: standaloneRawRetained
            ? "standalone_raw_retained_for_failed_bundle_diagnostic"
            : "content_addressed_bundle_only",
          successfulBundlePolicy: "remove_redundant_standalone_raw",
          failedBundlePolicy: "retain_standalone_raw_with_explicit_path",
        },
        eventCount: events.length,
        assistantMessageCount: assistantMessages.length,
        naturallyObservedFamilies,
        notObservedFamilies: [
          "agent_subagent", "skill", "mcp", "hook", "command_script", "runtime_tool",
        ].filter((family) => !naturallyObservedFamilies.includes(family)),
        exactBindingCoverage,
        events,
        boundary:
          "Observed events describe what the isolated host actually did. Only events joined to route-selected bindings may be promoted to live invocation evidence.",
      },
      targetBoundary:
        runtime === "codex"
          ? "codex_cli evidence does not prove codex_desktop behavior"
          : "claude_code stream evidence applies only to this isolated CLI run",
    };
    await atomicExclusiveWrite(
      path.join(artifactsDir, `${runId}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    await cleanupCleanRoomTemp(tempRoot, { preserveTemp: keepTemp });
    if (keepTemp) {
      process.stderr.write(
        `clean-room temp root retained (${tempRetentionReason}): ${tempRoot}\n`,
      );
    }
  }
}

export {
  DEPENDENCY_INSTALL_SILENT_NOOP_BLOCKER,
  classifyDependencyInstallStep,
  cleanupCleanRoomTemp,
  resolveInstallGateOutcome,
  resolveWindowsCliInvocation,
  runCli,
  scrubAndRemoveCopiedCredential,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}
