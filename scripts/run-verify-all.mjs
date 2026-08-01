#!/usr/bin/env node
// Meta_Kim verify-all 编排器
//
// 把 `meta:verify:all` 的长 `&&` 链，换成有名字、可续跑的流水线。
// 每步打印名字、耗时；挂了告诉你哪步挂、怎么续跑。
//
// 用法：
//   node scripts/run-verify-all.mjs              # 跑全部
//   node scripts/run-verify-all.mjs --list       # 列阶段
//   node scripts/run-verify-all.mjs --from meta:check   # 从某步续跑
//   node scripts/run-verify-all.mjs --json       # 结束时打印聚合 JSON
//   node scripts/run-verify-all.mjs --live-certified # 追加外部签名实机认证

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createReportContext } from "./report-context.mjs";
import {
  createVerificationAttemptId,
  writeVerificationReportAttempt,
} from "./verification-report-history.mjs";
import {
  PACKED_USER_ACCEPTANCE_EXPECTED_DURATION_MS,
  runPackedUserInstallUpdateAcceptance,
} from "./verify-packed-user-install-update.mjs";
import { resolveRuntimeProfilesFromManifest } from "./meta-kim-sync-config.mjs";
import { packedProductProofComplete } from "./packed-product-proof.mjs";

export { packedProductProofComplete } from "./packed-product-proof.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const RELEASE_SYNC_MANIFEST = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "config", "sync.json"), "utf8"),
);
const RELEASE_RUNTIME_PROFILES = resolveRuntimeProfilesFromManifest(
  RELEASE_SYNC_MANIFEST,
);
const RELEASE_VERIFICATION_POLICY = JSON.parse(
  readFileSync(
    path.join(
      REPO_ROOT,
      "config",
      "contracts",
      "release-verification-policy.json",
    ),
    "utf8",
  ),
);

export const RELEASE_RUNTIME_TARGETS = Object.freeze([
  ...RELEASE_SYNC_MANIFEST.supportedTargets,
]);

function timeoutEnvironmentKey(stageName) {
  const suffix = String(stageName)
    .replace(/[^a-z0-9]+/giu, "_")
    .replace(/^_+|_+$/gu, "")
    .toUpperCase();
  return `${RELEASE_VERIFICATION_POLICY.timeoutEnvironmentPrefix}${suffix}_MS`;
}

function resolveReleasePolicyTimeout(policyKey, timeoutId, environment) {
  const configured = RELEASE_VERIFICATION_POLICY[policyKey]?.[timeoutId];
  if (!Number.isSafeInteger(configured) || configured <= 0) {
    throw new Error(`release verification timeout policy is missing ${timeoutId}`);
  }
  const envKey = timeoutEnvironmentKey(timeoutId);
  const override = environment[envKey];
  if (override == null || String(override).trim() === "") return configured;
  const parsed = Number(override);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${envKey} must be a positive integer number of milliseconds`);
  }
  return parsed;
}

export function resolveReleaseStageTimeout(stageName, environment = process.env) {
  return resolveReleasePolicyTimeout("stageTimeoutsMs", stageName, environment);
}

export function resolveReleaseOperationTimeout(operationName, environment = process.env) {
  return resolveReleasePolicyTimeout(
    "operationTimeoutsMs",
    operationName,
    environment,
  );
}

const STANDARD_STAGE_COMMANDS = Object.freeze([
  ["discover:global", "npm run discover:global -- --check"],
  ["meta:agents:migration-catalog:check", "npm run meta:agents:migration-catalog:check"],
  [
    "meta:sync",
    `npm run meta:sync -- --targets ${RELEASE_RUNTIME_TARGETS.join(",")}`,
  ],
  [
    "meta:check",
    `npm run meta:check:runtimes -- --targets ${RELEASE_RUNTIME_TARGETS.join(",")} && npm run meta:check:sync-coverage && npm run meta:open-source-boundary:validate && npm run meta:validate`,
  ],
  ["meta:verify:governance:core", "npm run meta:verify:governance:core"],
  [
    "meta:graphify:verified-rebuild",
    "npm run meta:graphify:verified-rebuild && npm run meta:graphify:check",
  ],
  ["meta:check:global:release", "npm run meta:check:global:release"],
  ["eval-meta-agents", "node scripts/eval-meta-agents.mjs --primary-release-fuse"],
  ["meta:runtime:produce", "node scripts/run-runtime-capability-producers.mjs --status --require-fresh"],
  ["meta:test:inventory", "npm run meta:test:inventory"],
  ["meta:test:unit", "npm run meta:test:unit"],
  ["meta:test:process-guard", "npm run meta:test:process-guard"],
  ["meta:test:setup", "npm run meta:test:setup"],
  ["meta:test:meta-theory", "npm run meta:test:meta-theory"],
  ["meta:test:integration", "npm run meta:test:integration"],
]);

export function buildVerificationStages(environment = process.env) {
  return STANDARD_STAGE_COMMANDS.map(([name, cmd]) => ({
    name,
    cmd,
    timeoutMs: resolveReleaseStageTimeout(name, environment),
  }));
}

export const STAGES = Object.freeze(
  buildVerificationStages().map((stage) => Object.freeze(stage)),
);

export const LIVE_CERTIFIED_STAGE = Object.freeze({
  name: "meta:acceptance:clean-room:require",
  cmd: "npm run meta:acceptance:clean-room:require",
  timeoutMs: resolveReleaseStageTimeout("meta:acceptance:clean-room:require"),
});
const RELEASE_PROBE_SKILL_ID = "planning-with-files";
const RELEASE_PROBE_MODE_OPERATION =
  "all-runtime-global-install-update-probe-mode";

function releaseProbeModeTimeout(environment = process.env) {
  return resolveReleaseOperationTimeout(RELEASE_PROBE_MODE_OPERATION, environment);
}

function releasePreflightExpectedDuration(environment = process.env) {
  return releaseProbeModeTimeout(environment) * 2 +
    PACKED_USER_ACCEPTANCE_EXPECTED_DURATION_MS;
}

function emitProgress(onProgress, event) {
  if (typeof onProgress !== "function") return;
  try {
    onProgress(event);
  } catch {
    // Progress reporting must never change verification evidence or control flow.
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function captureCommand(cwd, command, args) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout || `exit ${result.status}`}`,
    );
  }
  return result.stdout;
}

export function captureReleaseSourceSnapshot(cwd = process.cwd()) {
  try {
    const head = captureCommand(cwd, "git", ["rev-parse", "HEAD"]).trim();
    const tree = captureCommand(cwd, "git", ["rev-parse", "HEAD^{tree}"]).trim();
    const status = captureCommand(cwd, "git", [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    const trackedDiff = captureCommand(cwd, "git", [
      "diff",
      "--binary",
      "HEAD",
      "--",
      ".",
    ]);
    const untracked = captureCommand(cwd, "git", [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ])
      .split("\0")
      .filter(Boolean)
      .sort();
    const untrackedEvidence = untracked.map((relativePath) => {
      const filePath = path.join(cwd, relativePath);
      try {
        return `${relativePath}\0${sha256(readFileSync(filePath))}`;
      } catch (error) {
        return `${relativePath}\0unreadable:${error.code ?? error.message}`;
      }
    });
    const packageManifestHash = sha256(readFileSync(path.join(cwd, "package.json")));
    return {
      captureOk: true,
      head,
      tree,
      dirty: status.length > 0,
      statusEntryCount: status.split("\0").filter(Boolean).length,
      diffHash: sha256(
        [status, trackedDiff, ...untrackedEvidence].join("\0meta-kim-snapshot\0"),
      ),
      packageManifestHash,
      untrackedFileCount: untracked.length,
      error: null,
    };
  } catch (error) {
    return {
      captureOk: false,
      head: null,
      tree: null,
      dirty: null,
      statusEntryCount: null,
      diffHash: null,
      packageManifestHash: null,
      untrackedFileCount: null,
      error: error.message,
    };
  }
}

export function compareReleaseSourceSnapshots(start, end) {
  const mismatchReasons = [];
  if (!start?.captureOk || !end?.captureOk) mismatchReasons.push("source_snapshot_unavailable");
  for (const field of ["head", "tree", "diffHash", "packageManifestHash"]) {
    if (start?.[field] !== end?.[field]) mismatchReasons.push(`${field}_changed_during_verification`);
  }
  if (start?.dirty === true) mismatchReasons.push("source_dirty_at_start");
  if (end?.dirty === true) mismatchReasons.push("source_dirty_at_end");
  const stable = mismatchReasons.every((reason) =>
    ["source_dirty_at_start", "source_dirty_at_end"].includes(reason),
  );
  return {
    stable,
    releaseEligible:
      stable && start?.captureOk === true && end?.captureOk === true,
    cleanCommitEligible:
      stable && start?.captureOk === true && end?.captureOk === true &&
      start.dirty === false && end.dirty === false,
    mismatchReasons,
  };
}

export function compareReleaseSourceSnapshotSequence(entries) {
  const snapshots = entries.map((entry, index) =>
    entry?.snapshot
      ? { label: entry.label ?? `snapshot_${index}`, snapshot: entry.snapshot }
      : { label: `snapshot_${index}`, snapshot: entry },
  );
  if (snapshots.length < 2) {
    return {
      stable: false,
      releaseEligible: false,
      cleanCommitEligible: false,
      mismatchReasons: ["source_snapshot_sequence_incomplete"],
      windows: [],
    };
  }

  const windows = [];
  for (let index = 1; index < snapshots.length; index += 1) {
    const previous = snapshots[index - 1];
    const current = snapshots[index];
    windows.push({
      from: previous.label,
      to: current.label,
      ...compareReleaseSourceSnapshots(previous.snapshot, current.snapshot),
    });
  }
  const mismatchReasons = [...new Set(windows.flatMap((window) => window.mismatchReasons))];
  const capturesAvailable = snapshots.every((entry) => entry.snapshot?.captureOk === true);
  const stable = windows.every((window) => window.stable);
  return {
    stable,
    releaseEligible: stable && capturesAvailable,
    cleanCommitEligible:
      stable && capturesAvailable && snapshots.every((entry) => entry.snapshot.dirty === false),
    mismatchReasons,
    windows,
  };
}

function installedProbeSkillPath(runtimeHomes, runtimeId) {
  return path.join(runtimeHomes[runtimeId], "skills", RELEASE_PROBE_SKILL_ID, "SKILL.md");
}

export function runAllRuntimeGlobalInstallUpdateProbe({
  cwd = process.cwd(),
  installerScript = path.join(cwd, "scripts", "install-global-skills-all-runtimes.mjs"),
  environment = process.env,
  onProgress = null,
} = {}) {
  const modeTimeoutMs = releaseProbeModeTimeout(environment);
  emitProgress(onProgress, {
    event: "all_runtime_probe_start",
    expectedDurationMs: modeTimeoutMs * 2,
    targets: [...RELEASE_RUNTIME_TARGETS],
  });
  const isolatedHome = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-targets-"));
  const runtimeHomes = Object.fromEntries(
    RELEASE_RUNTIME_TARGETS.map((runtimeId) => [runtimeId, path.join(isolatedHome, runtimeId)]),
  );
  for (const runtimeHome of Object.values(runtimeHomes)) mkdirSync(runtimeHome, { recursive: true });
  const probeEnv = {
    ...environment,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    META_KIM_SKIP_OPTIONAL_TOOLS: "1",
  };
  for (const runtimeId of RELEASE_RUNTIME_TARGETS) {
    for (const envKey of RELEASE_RUNTIME_PROFILES[runtimeId].activation.envKeys) {
      probeEnv[envKey] = runtimeHomes[runtimeId];
    }
  }
  delete probeEnv.META_KIM_LOCAL_DEPENDENCY_ROOT;
  const commands = [];
  try {
    for (const mode of ["install", "update"]) {
      emitProgress(onProgress, {
        event: "runtime_probe_mode_start",
        mode,
        expectedDurationMs: modeTimeoutMs,
        targets: [...RELEASE_RUNTIME_TARGETS],
      });
      const commandArgs = [
        installerScript,
        ...(mode === "update" ? ["--update"] : []),
        "--targets",
        RELEASE_RUNTIME_TARGETS.join(","),
        "--skills",
        RELEASE_PROBE_SKILL_ID,
        "--skip-plugins",
        "--skip-inventory-refresh",
      ];
      const result = spawnSync(process.execPath, commandArgs, {
        cwd,
        encoding: "utf8",
        windowsHide: true,
        timeout: modeTimeoutMs,
        env: probeEnv,
      });
      const commandRecord = {
        mode,
        status: result.status === 0 ? "passed" : "failed",
        exitCode: result.status,
        timedOut: result.error?.code === "ETIMEDOUT",
        outputHash: sha256(`${result.stdout ?? ""}\n${result.stderr ?? ""}`),
        artifactProof: [],
        error: result.error?.message ?? null,
      };
      commands.push(commandRecord);
      if (result.status !== 0 || result.error) {
        const failure = {
          status: "failed",
          targets: [...RELEASE_RUNTIME_TARGETS],
          modes: commands,
          sourcePolicy: "external_declared_dependency_no_local_fallback",
          artifactProof: [],
          error: result.error?.message || result.stderr || result.stdout || `exit ${result.status}`,
        };
        emitProgress(onProgress, {
          event: "runtime_probe_mode_complete",
          mode,
          status: "failed",
          durationLimitMs: modeTimeoutMs,
          error: failure.error,
          nextAction:
            "Check dependency access and runtime-home permissions, then rerun node scripts/run-verify-all.mjs.",
        });
        emitProgress(onProgress, {
          event: "all_runtime_probe_complete",
          status: "failed",
          error: failure.error,
        });
        return failure;
      }
      commandRecord.artifactProof = RELEASE_RUNTIME_TARGETS.map((runtimeId) => {
        const skillPath = installedProbeSkillPath(runtimeHomes, runtimeId);
        const content = readFileSync(skillPath);
        return {
          runtime: runtimeId,
          relativePath: path.relative(isolatedHome, skillPath).replaceAll("\\", "/"),
          sha256: sha256(content),
          bytes: content.length,
        };
      });
      emitProgress(onProgress, {
        event: "runtime_probe_mode_complete",
        mode,
        status: "passed",
        artifactCount: commandRecord.artifactProof.length,
      });
    }

    const artifactProof = commands.at(-1).artifactProof;
    const proof = {
      status: "passed",
      targets: [...RELEASE_RUNTIME_TARGETS],
      modes: commands,
      sourcePolicy: "external_declared_dependency_no_local_fallback",
      artifactProof,
      identicalArtifactHash:
        new Set(artifactProof.map((entry) => entry.sha256)).size === 1,
      error: null,
    };
    emitProgress(onProgress, {
      event: "all_runtime_probe_complete",
      status: "passed",
      artifactCount: artifactProof.length,
    });
    return proof;
  } catch (error) {
    const failure = {
      status: "failed",
      targets: [...RELEASE_RUNTIME_TARGETS],
      modes: commands,
      sourcePolicy: "external_declared_dependency_no_local_fallback",
      artifactProof: [],
      error: error.message,
    };
    emitProgress(onProgress, {
      event: "all_runtime_probe_complete",
      status: "failed",
      error: error.message,
      nextAction:
        "Inspect the probe error and runtime-home permissions, then rerun node scripts/run-verify-all.mjs.",
    });
    return failure;
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
}

export function runReleasePreflight({
  environment = process.env,
  captureSnapshot = () => captureReleaseSourceSnapshot(process.cwd()),
  runProbe = ({ onProgress: probeProgress } = {}) =>
    runAllRuntimeGlobalInstallUpdateProbe({
      environment,
      onProgress: probeProgress,
    }),
  runPackedProbe = ({ onProgress: probeProgress } = {}) =>
    runPackedUserInstallUpdateAcceptance({ onProgress: probeProgress }),
  onProgress = null,
} = {}) {
  emitProgress(onProgress, {
    event: "release_preflight_start",
    expectedDurationMs: releasePreflightExpectedDuration(environment),
    targets: [...RELEASE_RUNTIME_TARGETS],
  });
  const invocation = captureSnapshot();
  const globalTargetProof = runProbe({ onProgress });
  const packedUserProof = globalTargetProof.status === "passed"
    ? runPackedProbe({ onProgress })
    : {
        status: "not_run_after_global_target_failure",
        sourcePolicy: "npm_pack_installed_public_cli",
        error: null,
      };
  const postProbe = captureSnapshot();
  const result = {
    globalTargetProof,
    packedUserProof,
    sourceSnapshot: { invocation, postProbe },
    sourceIntegrity: compareReleaseSourceSnapshotSequence([
      { label: "invocation", snapshot: invocation },
      { label: "post_probe", snapshot: postProbe },
    ]),
  };
  emitProgress(onProgress, {
    event: "release_preflight_complete",
    status:
      globalTargetProof.status === "passed" && packedProductProofComplete(packedUserProof)
        ? "passed"
        : "failed",
    error: globalTargetProof.error ?? packedUserProof.error ?? null,
    nextAction:
      globalTargetProof.status === "passed" && packedProductProofComplete(packedUserProof)
        ? null
        : "Resolve the reported install/update probe failure, then rerun node scripts/run-verify-all.mjs.",
  });
  return result;
}

export function computeReleaseGrade({
  results,
  startIndex,
  sourceIntegrity = { releaseEligible: true },
  globalTargetProof = { status: "passed" },
  packedUserProof = null,
}) {
  if (startIndex !== 0 || results.length < STAGES.length) return false;
  if (
    sourceIntegrity.releaseEligible !== true ||
    globalTargetProof.status !== "passed" ||
    !packedProductProofComplete(packedUserProof)
  ) return false;
  return STAGES.every(
    (stage, index) =>
      results[index]?.name === stage.name && results[index]?.status === "passed",
  );
}

export function computeLiveCertified({
  requested,
  releaseGrade,
  results,
  startIndex,
}) {
  if (!requested || !releaseGrade || startIndex !== 0) return false;
  const liveResult = results[STAGES.length];
  return (
    liveResult?.name === LIVE_CERTIFIED_STAGE.name &&
    liveResult?.status === "passed"
  );
}

export function computeVerificationClaims({
  requested,
  results,
  startIndex,
  sourceIntegrity,
  globalTargetProof,
  packedUserProof,
}) {
  const releaseGrade = computeReleaseGrade({
    results,
    startIndex,
    sourceIntegrity,
    globalTargetProof,
    packedUserProof,
  });
  const liveCertified = computeLiveCertified({
    requested,
    releaseGrade,
    results,
    startIndex,
  });
  return {
    releaseGrade,
    liveCertified,
    liveCertificationStatus: requested
      ? liveCertified
        ? "passed"
        : "failed_or_incomplete"
      : "not_requested",
  };
}

function printReleasePreflightProgress(progress) {
  const expectedMinutes = Math.max(
    1,
    Math.ceil((progress.expectedDurationMs ?? 0) / 60_000),
  );
  let message = null;
  if (progress.event === "release_preflight_start") {
    message =
      `发布预检开始：将隔离验证四个运行时的安装和更新，预计最长约 ${expectedMinutes} 分钟；期间会持续显示进度。`;
  } else if (progress.event === "all_runtime_probe_start") {
    message = "正在准备隔离运行时目录和依赖探针。";
  } else if (progress.event === "runtime_probe_mode_start") {
    message =
      `开始四运行时${progress.mode === "install" ? "安装" : "更新"}探针（最长约 ${expectedMinutes} 分钟）。`;
  } else if (progress.event === "runtime_probe_mode_complete") {
    if (progress.status === "passed") {
      message =
        `四运行时${progress.mode === "install" ? "安装" : "更新"}探针通过（${progress.artifactCount ?? 0} 个产物已核验）。`;
    } else {
      const detail = String(progress.error ?? "unknown error").trim().split(/\r?\n/u)[0];
      message =
        `四运行时${progress.mode === "install" ? "安装" : "更新"}探针失败：${detail}\n` +
        `下一步：${progress.nextAction}`;
    }
  } else if (progress.event === "all_runtime_probe_complete" && progress.status === "failed") {
    message = `隔离安装/更新预检未通过；请先处理上方失败原因。`;
  } else if (progress.event === "packed_user_acceptance_start") {
    message = "开始验证 npm pack 候选包的真实用户安装、更新和重复更新。";
  } else if (progress.event === "packed_user_mode_start") {
    message = `候选包用户入口：开始第 ${progress.ordinal} 次 ${progress.mode}。`;
  } else if (progress.event === "packed_user_mode_complete") {
    message = `候选包用户入口：第 ${progress.ordinal} 次 ${progress.mode} 通过。`;
  } else if (progress.event === "packed_project_mode_start") {
    message = `候选包项目入口：开始第 ${progress.ordinal} 次 ${progress.mode}。`;
  } else if (progress.event === "packed_project_mode_complete") {
    message = `候选包项目入口：第 ${progress.ordinal} 次 ${progress.mode} 通过。`;
  } else if (progress.event === "packed_user_acceptance_complete") {
    message = progress.status === "passed"
      ? "候选包真实用户安装/更新验收通过。"
      : `候选包真实用户安装/更新验收失败：${progress.error ?? "unknown error"}`;
  } else if (progress.event === "release_preflight_complete") {
    message = progress.status === "passed"
      ? "发布预检完成，继续执行标准验证阶段。"
      : `发布预检停止。下一步：${progress.nextAction}`;
  }
  if (message) process.stderr.write(`[verify-all] ${message}\n`);
}

async function main() {

const args = process.argv.slice(2);
const liveCertifiedRequested = args.includes("--live-certified");
const selectedStages = liveCertifiedRequested
  ? [...STAGES, LIVE_CERTIFIED_STAGE]
  : STAGES;
const jsonMode = args.includes("--json");
const noReport = args.includes("--no-report");
const reportIdx = args.findIndex((arg) => arg === "--report" || arg === "--json-out");
const reportContext = createReportContext();
const reportPath =
  reportIdx >= 0 && args[reportIdx + 1] && !args[reportIdx + 1].startsWith("--")
    ? args[reportIdx + 1]
    : reportContext.resolveStatePath("verification-report.json");
const verificationAttemptId = createVerificationAttemptId();

if (args.includes("--probe-all-runtime-global-targets")) {
  const probe = runAllRuntimeGlobalInstallUpdateProbe({
    onProgress: printReleasePreflightProgress,
  });
  process.stdout.write(`${JSON.stringify(probe, null, 2)}\n`);
  process.exit(probe.status === "passed" ? 0 : 1);
}

function writeReport(report) {
  if (noReport) {
    return {
      report,
      recordPath: null,
      latestReportPath: null,
      latestReleaseGradePath: null,
    };
  }
  return writeVerificationReportAttempt({
    report,
    reportPath,
    attemptId: verificationAttemptId,
  });
}

if (args.includes("--list")) {
  if (jsonMode) {
    console.log(JSON.stringify({ stages: selectedStages, liveCertifiedRequested }, null, 2));
  } else {
    selectedStages.forEach((s, i) => console.log(`${i + 1}. ${s.name}  →  ${s.cmd}`));
  }
  process.exit(0);
}

const fromIdx = args.indexOf("--from");
let startIndex = 0;
if (fromIdx >= 0) {
  const target = args[fromIdx + 1];
  const idx = selectedStages.findIndex((s) => s.name === target);
  if (idx < 0) {
    console.error(
      `未知阶段：${target}。可用：${selectedStages.map((s) => s.name).join(", ")}`,
    );
    process.exit(2);
  }
  startIndex = idx;
}

function parseStageCommand(cmd) {
  const parts = cmd.trim().split(/\s+/);
  if (parts[0] === "npm" && parts[1] === "run" && parts[2]) {
    if (process.platform === "win32") {
      return {
        command: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/s", "/c", ["npm", "run", ...parts.slice(2)].join(" ")],
      };
    }
    return { command: "npm", args: ["run", ...parts.slice(2)] };
  }
  if (parts[0] === "node" && parts[1]) {
    return { command: process.execPath, args: parts.slice(1) };
  }
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", cmd],
    };
  }
  return { command: "sh", args: ["-lc", cmd] };
}

function runWithTimeout(cmd, timeoutMs, { captureStdout = false } = {}) {
  const { command, args: commandArgs } = parseStageCommand(cmd);
  const environment = { ...process.env };
  if (cmd.includes("meta:graphify:verified-rebuild")) {
    const blockedEnvironmentKeys = new Set([
      "META_KIM_GRAPHIFY_BIN",
      "META_KIM_GRAPHIFY_BIN_ARGS",
      "META_KIM_GRAPHIFY_PYTHON",
      "META_KIM_GRAPHIFY_NORMALIZER_PYTHON",
      "PYTHONHOME",
      "PYTHONPATH",
      "PYTHONSTARTUP",
      "PYTHONINSPECT",
      "PYTHONUSERBASE",
    ]);
    for (const key of Object.keys(environment)) {
      if (blockedEnvironmentKeys.has(key.toUpperCase())) {
        delete environment[key];
      }
    }
  }
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    shell: false,
    env: environment,
    ...(captureStdout ? { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] } : { stdio: "inherit" }),
    timeout: timeoutMs,
  });
  const timedOut = result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM";
  const exitCode = result.status ?? (timedOut ? null : 1);
  return {
    ok: exitCode === 0 && !timedOut && !result.error,
    timedOut,
    exitCode,
    signal: result.signal ?? null,
    error: result.error?.message ?? null,
    stdout: captureStdout ? result.stdout ?? "" : null,
  };
}

const startedAt = new Date().toISOString();
const releasePreflight =
  startIndex === 0
    ? runReleasePreflight({ onProgress: printReleasePreflightProgress })
    : (() => {
        const invocation = captureReleaseSourceSnapshot(process.cwd());
        return {
          sourceSnapshot: { invocation, postProbe: invocation },
          sourceIntegrity: compareReleaseSourceSnapshotSequence([
            { label: "invocation", snapshot: invocation },
            { label: "post_probe", snapshot: invocation },
          ]),
          globalTargetProof: {
            status: "not_run_for_resumed_diagnostic",
            targets: [...RELEASE_RUNTIME_TARGETS],
            modes: [],
            sourcePolicy: "external_declared_dependency_no_local_fallback",
            artifactProof: [],
            error: null,
          },
          packedUserProof: {
            status: "not_run_for_resumed_diagnostic",
            sourcePolicy: "npm_pack_installed_public_cli",
            error: null,
          },
        };
      })();
const { globalTargetProof, packedUserProof } = releasePreflight;
const sourceSnapshotInvocation = releasePreflight.sourceSnapshot.invocation;
const sourceSnapshotPostProbe = releasePreflight.sourceSnapshot.postProbe;
let failedStage =
  startIndex === 0 && globalTargetProof.status !== "passed"
    ? { name: "all-runtime-global-install-update-probe" }
    : startIndex === 0 && !packedProductProofComplete(packedUserProof)
      ? { name: "packed-user-install-update-acceptance" }
    : null;
const results = [];
for (let i = startIndex; !failedStage && i < selectedStages.length; i += 1) {
  const stage = selectedStages[i];
  const label = `[${i + 1}/${selectedStages.length}] ${stage.name}`;
  const t0 = Date.now();
  console.log(`\n=== ${label} ===\n> ${stage.cmd}`);
  const result = runWithTimeout(stage.cmd, stage.timeoutMs, { captureStdout: stage.name === "meta:runtime:produce" });
  const ms = Date.now() - t0;
  if (result.ok) {
    console.log(`\n✓ ${label} 通过 (${ms}ms)`);
    let controlledProducerEvidence = null;
    if (stage.name === "meta:runtime:produce") {
      try { controlledProducerEvidence = JSON.parse(result.stdout); }
      catch (error) { throw new Error(`controlled producer stage returned invalid JSON: ${error.message}`); }
      process.stdout.write(result.stdout);
    }
    results.push({
      name: stage.name,
      cmd: stage.cmd,
      status: "passed",
      durationMs: ms,
      exitCode: 0,
      timedOut: false,
      ...(controlledProducerEvidence ? { controlledProducerEvidence } : {}),
    });
  } else {
    const reason = result.timedOut ? `超时 (>${stage.timeoutMs}ms)` : `exit ${result.exitCode ?? "?"}`;
    console.error(`\n✗ ${label} 失败 (${ms}ms, ${reason})`);
    console.error(
      `  续跑：node scripts/run-verify-all.mjs${liveCertifiedRequested ? " --live-certified" : ""} --from ${stage.name}`,
    );
    results.push({
      name: stage.name,
      cmd: stage.cmd,
      status: "failed",
      durationMs: ms,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      signal: result.signal,
      error: result.error,
      resumeCommand: `node scripts/run-verify-all.mjs${liveCertifiedRequested ? " --live-certified" : ""} --from ${stage.name}`,
    });
    failedStage = stage;
    break;
  }
}

const sourceSnapshotEnd = captureReleaseSourceSnapshot(process.cwd());
const sourceIntegrity = compareReleaseSourceSnapshotSequence([
  { label: "invocation", snapshot: sourceSnapshotInvocation },
  { label: "post_probe", snapshot: sourceSnapshotPostProbe },
  { label: "final", snapshot: sourceSnapshotEnd },
]);
const verificationClaims = computeVerificationClaims({
  requested: liveCertifiedRequested,
  results,
  startIndex,
  sourceIntegrity,
  globalTargetProof,
  packedUserProof,
});
const { releaseGrade, liveCertified, liveCertificationStatus } = verificationClaims;
let report = {
  ok: !failedStage && sourceIntegrity.stable,
  releaseGrade,
  liveCertified,
  liveCertificationStatus,
  packedProductProofComplete: packedProductProofComplete(packedUserProof),
  resumedRun: startIndex > 0,
  releaseGradeReason:
    startIndex > 0
      ? `Resumed verification is diagnostic only; release-grade requires one report containing all ${STAGES.length} standard stages.`
      : globalTargetProof.status !== "passed"
        ? "Release-grade requires successful isolated install and update artifacts for every declared global runtime target."
      : !packedProductProofComplete(packedUserProof)
        ? "Release-grade requires the npm-packed public CLI to prove isolated fresh install/update plus canonical Agent projections, explicitly authorized global Hooks, portable Claude MCP registration, and packed-installed CLI MCP transport."
      : !sourceIntegrity.stable
        ? `Source changed during verification: ${sourceIntegrity.mismatchReasons.join(", ")}.`
      : !releaseGrade
        ? failedStage
        ? `Verification failed at ${failedStage.name}.`
        : `The report does not contain all ${STAGES.length} standard release-grade stages.`
        : `All ${STAGES.length} standard release-grade stages passed in one complete run.`,
  liveCertificationReason: liveCertifiedRequested
    ? liveCertified
      ? "The optional external clean-room signature gate passed after the complete standard release-grade run."
      : startIndex > 0
        ? "A resumed run cannot self-promote to live-certified."
        : failedStage?.name === LIVE_CERTIFIED_STAGE.name
          ? "Standard release-grade passed, but the optional external clean-room signature gate failed."
          : "Live certification was requested but the complete standard run or external signature gate did not pass."
    : "Optional external live certification was not requested.",
  startedAt,
  completedAt: new Date().toISOString(),
  releasePreflight: {
    globalTargetProof,
    packedUserProof,
    sourceSnapshot: {
      invocation: sourceSnapshotInvocation,
      postProbe: sourceSnapshotPostProbe,
      start: sourceSnapshotPostProbe,
      end: sourceSnapshotEnd,
      ...sourceIntegrity,
    },
  },
  startStage: selectedStages[startIndex]?.name ?? null,
  failedStage: failedStage?.name ?? null,
  stages: results,
};
const reportWrite = writeReport(report);
report = reportWrite.report;

if (failedStage) {
  console.error(`  本次报告：${reportWrite.recordPath ?? "--no-report"}`);
  console.error(`  最新报告：${reportWrite.latestReportPath ?? "--no-report"}`);
  if (reportWrite.latestReleaseGradePath) {
    console.error(`  最近发布级报告：${reportWrite.latestReleaseGradePath}`);
  }
  if (jsonMode) console.log(JSON.stringify(report, null, 2));
  console.error(`\n=== verify-all 停在 ${failedStage.name} ===`);
  process.exit(1);
}
if (!sourceIntegrity.stable) {
  console.error(`  本次报告：${reportWrite.recordPath ?? "--no-report"}`);
  console.error(`  最新报告：${reportWrite.latestReportPath ?? "--no-report"}`);
  if (reportWrite.latestReleaseGradePath) {
    console.error(`  最近发布级报告：${reportWrite.latestReleaseGradePath}`);
  }
  if (jsonMode) console.log(JSON.stringify(report, null, 2));
  console.error("\n=== verify-all 源码在验证期间发生变化，不构成 release-grade ===");
  process.exit(1);
}
if (jsonMode) console.log(JSON.stringify(report, null, 2));
if (startIndex > 0) {
  console.log(
    `\n=== verify-all 续跑诊断通过（从第 ${startIndex + 1} 步起）；不构成 release-grade 或 live-certified ===`,
  );
} else {
  console.log(
    releaseGrade
      ? `\n=== verify-all 全过（共 ${selectedStages.length} 步）===`
      : `\n=== verify-all 阶段通过，但不构成 release-grade：${sourceIntegrity.mismatchReasons.join(", ")} ===`,
  );
  if (releaseGrade && !sourceIntegrity.cleanCommitEligible) {
    console.log(
      "源码内容在整轮验证期间保持稳定，但工作树非 clean；提交或打标签前必须重新核对 commit tree 与本报告中的 tree/diff/package hashes。",
    );
  }
}
console.log(`本次报告：${reportWrite.recordPath ?? "--no-report"}`);
console.log(`最新报告：${reportWrite.latestReportPath ?? "--no-report"}`);
if (reportWrite.latestReleaseGradePath) {
  console.log(`最近发布级报告：${reportWrite.latestReleaseGradePath}`);
}
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) await main();
