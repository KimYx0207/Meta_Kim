#!/usr/bin/env node

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

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const sha256 = (value) => createHash("sha256").update(String(value), "utf8").digest("hex");
const sha256Bytes = (value) => createHash("sha256").update(value).digest("hex");
const EXPECTED_AGENT_TEAMS_PLAYBOOK_REF = "v4.8.0";
const EXPECTED_AGENT_TEAMS_PLAYBOOK_COMMIT = "753ff43bd9b1f9aee4d184c4f21e7f494af5a79f";
const EXPECTED_AGENT_TEAMS_PLAYBOOK_SKILL_SHA256 =
  "0c61f80b3e0616e3b6c6611e03c230e8eb26fbda65d4a7cc9477a9370e7d5fb4";
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
  let keepTemp = args.includes("--keep-temp");
  try {
    const packageInfo = await packAndExtract(tempRoot);
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
      const report = { schemaVersion: "clean-room-live-acceptance-v0.1", runId, status: "preflight_pass", isolation };
      await fs.writeFile(path.join(artifactsDir, `${runId}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }

    const env = baseIsolatedEnv(userHome, runtimeHome, isolatedTemp);
    const runtimeTarget = runtime === "claude" ? "claude" : "codex";
    const install = runCli("npm", [
      "install", "--ignore-scripts", "--no-audit", "--no-fund",
    ], { cwd: packageInfo.workspace, env, timeoutMs });
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
    const dependencySkillSha256 = existsSync(dependencySkillPath)
      ? createHash("sha256").update(await fs.readFile(dependencySkillPath)).digest("hex")
      : null;
    let dependencyArchiveMetadata = null;
    const dependencyArchiveMetadataPath = path.join(dependencyDir, ".meta-kim-source.json");
    if (existsSync(dependencyArchiveMetadataPath)) {
      try {
        dependencyArchiveMetadata = JSON.parse(
          await fs.readFile(dependencyArchiveMetadataPath, "utf8"),
        );
      } catch {
        dependencyArchiveMetadata = null;
      }
    }
    const archiveCommitPrefix = EXPECTED_AGENT_TEAMS_PLAYBOOK_COMMIT.slice(0, 7);
    const archiveRevisionVerified =
      dependencyArchiveMetadata?.source === "github_archive_fallback" &&
      String(dependencyArchiveMetadata?.rootName ?? "").toLowerCase().endsWith(`-${archiveCommitPrefix}`) &&
      dependencySkillSha256 === EXPECTED_AGENT_TEAMS_PLAYBOOK_SKILL_SHA256;
    let dependencyCommitResult = existsSync(dependencySkillPath)
      ? run("git", ["-C", dependencyDir, "rev-parse", "HEAD"], { env, timeoutMs: 30_000 })
      : { status: null, stdout: "" };
    let dependencyCommit = dependencyCommitResult.status === 0
      ? String(dependencyCommitResult.stdout).trim()
      : null;
    let dependencyPin = {
      expectedRef: EXPECTED_AGENT_TEAMS_PLAYBOOK_REF,
      expectedCommit: EXPECTED_AGENT_TEAMS_PLAYBOOK_COMMIT,
      action: dependencyCommit === EXPECTED_AGENT_TEAMS_PLAYBOOK_COMMIT
        ? "already_expected_commit"
        : archiveRevisionVerified
          ? "verified_archive_commit_prefix_and_skill_hash"
          : "not_attempted",
      exitCode:
        dependencyCommit === EXPECTED_AGENT_TEAMS_PLAYBOOK_COMMIT || archiveRevisionVerified
          ? 0
          : null,
    };
    if (
      dependencyInstall.status === 0 &&
      existsSync(dependencySkillPath) &&
      dependencyCommit !== EXPECTED_AGENT_TEAMS_PLAYBOOK_COMMIT &&
      !archiveRevisionVerified
    ) {
      const fetchTag = run("git", [
        "-C", dependencyDir, "fetch", "--depth", "1", "origin",
        `refs/tags/${EXPECTED_AGENT_TEAMS_PLAYBOOK_REF}:refs/tags/${EXPECTED_AGENT_TEAMS_PLAYBOOK_REF}`,
      ], { env, timeoutMs: 120_000 });
      const checkout = fetchTag.status === 0
        ? run("git", ["-C", dependencyDir, "checkout", "--detach", EXPECTED_AGENT_TEAMS_PLAYBOOK_COMMIT], {
            env,
            timeoutMs: 30_000,
          })
        : { status: null };
      dependencyPin = {
        expectedRef: EXPECTED_AGENT_TEAMS_PLAYBOOK_REF,
        expectedCommit: EXPECTED_AGENT_TEAMS_PLAYBOOK_COMMIT,
        action: "fetch_tag_and_detach",
        fetchExitCode: fetchTag.status,
        exitCode: checkout.status,
      };
      dependencyCommitResult = run("git", ["-C", dependencyDir, "rev-parse", "HEAD"], {
        env,
        timeoutMs: 30_000,
      });
      dependencyCommit = dependencyCommitResult.status === 0
        ? String(dependencyCommitResult.stdout).trim()
        : null;
    }
    const dependencyRevisionVerified =
      dependencyCommit === EXPECTED_AGENT_TEAMS_PLAYBOOK_COMMIT || archiveRevisionVerified;
    const dependencyReady =
      dependencyInstall.status === 0 &&
      existsSync(dependencySkillPath) &&
      dependencyPin.exitCode === 0 &&
      dependencyRevisionVerified &&
      dependencySkillSha256 === EXPECTED_AGENT_TEAMS_PLAYBOOK_SKILL_SHA256;
    const projectionSync = dependencyReady
      ? run(process.execPath, [
          path.join(packageInfo.workspace, "scripts", "sync-runtimes.mjs"),
          "--scope", "project",
          "--targets", runtimeTarget,
        ], { cwd: packageInfo.workspace, env, timeoutMs })
      : { status: null, stdout: "", stderr: "dependency_install_failed_before_projection_sync" };
    const bootstrap = projectionSync.status === 0
      ? run(process.execPath, [
          path.join(packageInfo.workspace, "setup.mjs"),
          "--project-bootstrap",
          "--project-dir", packageInfo.workspace,
          "--targets", runtimeTarget,
          "--apply",
          "--json",
        ], { cwd: packageInfo.workspace, env, timeoutMs })
      : { status: null, stdout: "", stderr: "projection_sync_failed_before_bootstrap" };
    const mcpTransportProbe = bootstrap.status === 0
      ? run(process.execPath, [
          path.join(packageInfo.workspace, "scripts", "live-acceptance", "probe-mcp-transport.mjs"),
          "--repo-root", packageInfo.workspace,
        ], { cwd: packageInfo.workspace, env, timeoutMs: 60_000 })
      : { status: null, stdout: "", stderr: "bootstrap_failed_before_mcp_transport_probe" };
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
      projectionSyncExitCode: projectionSync.status,
      bootstrapExitCode: bootstrap.status,
      mcpTransportProbeExitCode: mcpTransportProbe.status,
      mcpTransportConformanceObserved: mcpTransportEvents.length === 1,
      mcpTransportConformanceBoundary:
        "This proves the packed installation can complete MCP initialize, tools/list, and tools/call. It does not prove the blind host route selected MCP.",
      installOutputSha256: sha256(install.stdout ?? ""),
      dependencyInstallOutputSha256: sha256(dependencyInstall.stdout ?? ""),
      projectionSyncOutputSha256: sha256(projectionSync.stdout ?? ""),
      bootstrapOutputSha256: sha256(bootstrap.stdout ?? ""),
      mcpTransportProbeOutputSha256: sha256(mcpTransportProbe.stdout ?? ""),
      stderrTail: `${install.stderr ?? ""}\n${dependencyInstall.stderr ?? ""}\n${projectionSync.stderr ?? ""}\n${bootstrap.stderr ?? ""}`.slice(-2000),
      projectedAgentsPresent:
        existsSync(path.join(packageInfo.workspace, runtime === "claude" ? ".claude" : ".codex", "agents")),
      projectedSkillPresent: existsSync(
        path.join(packageInfo.workspace, runtime === "claude" ? ".claude" : ".agents", "skills", "meta-theory", "SKILL.md"),
      ),
      dependencySkillPresent: existsSync(dependencySkillPath),
    };
    if (
      install.status !== 0 ||
      !dependencyReady ||
      projectionSync.status !== 0 ||
      bootstrap.status !== 0 ||
      mcpTransportProbe.status !== 0 ||
      mcpTransportEvents.length !== 1
    ) {
      const report = {
        schemaVersion: "clean-room-live-acceptance-v0.1",
        runId,
        target: runtime === "codex" ? "codex_cli" : "claude_code",
        status: "blocked",
        blocker: "clean_install_or_project_bootstrap_failed",
        isolation,
        installation,
      };
      await fs.writeFile(path.join(artifactsDir, `${runId}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = 1;
      return;
    }
    if (installOnly) {
      const report = {
        schemaVersion: "clean-room-live-acceptance-v0.1",
        runId,
        target: runtime === "codex" ? "codex_cli" : "claude_code",
        status: "install_pass",
        isolation,
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
        isolation,
        installation,
        targetBoundary:
          "Codex CLI scans the OS-user ~/.agents/skills root even with isolated HOME, USERPROFILE, CODEX_HOME, --ignore-user-config, and explicit runtime skill roots. Use an OS-level disposable user/container or a host-supported global-skill disable switch before claiming clean-room CLI evidence. This does not describe Codex Desktop.",
      };
      await fs.writeFile(path.join(artifactsDir, `${runId}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = 1;
      return;
    }
    const governedArtifactsBefore = await snapshotGovernedArtifacts(packageInfo.workspace);
    let authBoundary;
    let result;
    if (runtime === "codex") {
      authBoundary = await copyCodexAuthOnly(runtimeHome);
      result = runCli("codex", [
        "exec", "--json", "--ephemeral", "--ignore-user-config",
        "--skip-git-repo-check", "--dangerously-bypass-hook-trust",
        "-s", "workspace-write", "-C", packageInfo.workspace, "-",
      ], { cwd: packageInfo.workspace, env, input: prompt, timeoutMs });
    } else {
      authBoundary = { inheritedEnvironmentVariables: inheritClaudeAuth(env) };
      const settingsPath = path.join(tempRoot, "claude-settings.json");
      const projectedMcpPath = path.join(packageInfo.workspace, ".mcp.json");
      const mcpPath = existsSync(projectedMcpPath)
        ? projectedMcpPath
        : path.join(tempRoot, "claude-mcp.json");
      await fs.writeFile(settingsPath, "{}\n", "utf8");
      if (!existsSync(mcpPath)) await fs.writeFile(mcpPath, "{\"mcpServers\":{}}\n", "utf8");
      result = runCli("claude", [
        "-p", "--output-format", "stream-json", "--verbose", "--include-hook-events",
        "--strict-mcp-config", "--mcp-config", mcpPath, "--settings", settingsPath,
        "--permission-mode", "dontAsk", "--no-session-persistence",
      ], { cwd: packageInfo.workspace, env, input: prompt, timeoutMs });
    }
    const rawPath = path.join(artifactsDir, `${runId}.raw.jsonl`);
    await atomicExclusiveWrite(rawPath, result.stdout ?? "");
    const events = runtime === "codex"
      ? observeCodexJsonl(result.stdout)
      : observeClaudeJsonl(result.stdout);
    const assistantMessages = runtime === "codex"
      ? observeCodexAssistantMessages(result.stdout)
      : observeClaudeAssistantMessages(result.stdout);
    const governedArtifactsAfter = await snapshotGovernedArtifacts(packageInfo.workspace);
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
        governedArtifactRoot: path.join(packageInfo.workspace, ".meta-kim", "state"),
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
      isolation,
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
  }
}

export {
  cleanupCleanRoomTemp,
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
