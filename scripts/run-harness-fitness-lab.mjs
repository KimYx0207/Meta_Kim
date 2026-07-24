#!/usr/bin/env node

import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const CONTRACT_PATH = path.join(
  REPO_ROOT,
  "config",
  "contracts",
  "harness-fitness-lab-contract.json",
);
const SCENARIO_PATH = path.join(
  REPO_ROOT,
  "config",
  "evals",
  "harness-fitness-lab-tasks.json",
);
const DEFAULT_STATE_ROOT = path.join(
  REPO_ROOT,
  ".meta-kim",
  "state",
  "default",
  "harness-fitness-lab",
);
const DEFAULT_WORKSPACE_ROOT = path.join(
  os.tmpdir(),
  "meta-kim-harness-fitness-lab-workspaces",
);

const FULL_GOVERNANCE_TEMPLATE = `# Fitness Lab governance scaffold

This is an isolated benchmark workspace. Solve only the requested task and do not invent external requirements.

## Critical
State the concrete outcome, acceptance, non-goals, and material ambiguity before editing. Ask no quota questions.

## Fetch
Inspect the starter files and public tests. Identify the minimum relevant local capability and evidence. Do not assume a feature exists because a schema or comment names it.

## Thinking
Compare at least two viable routes when the task is materially ambiguous or risky. Select the smallest route that meets acceptance and name the rejected weak path.

## Execution
Make bounded edits, preserve unrelated behavior, and run the public test command.

{{REVIEW_BLOCK}}

## Meta-Review
Check that the standard used for review matches the user outcome and did not reward packet completeness over task quality.

## Verification
Run fresh tests after the final edit. Do not claim success from plans, schemas, or intended commands.

## Evolution
Do not create durable agents, skills, dashboards, or workflow DSL in this benchmark. Record no writeback unless the task itself requires it.
`;

const REVIEW_BLOCK = `## Review
Adversarially inspect the changed files against the outcome, likely edge cases, accessibility/security boundaries where relevant, and unnecessary complexity. Fix concrete findings before final verification.`;

const BASELINE_INSTRUCTIONS = `# Fitness Lab baseline

This benchmark arm intentionally does not use Meta_Kim governance. Do not invoke meta-theory stages, subagents, skills, MCPs, capability discovery, governance packets, or durable planning files.

Complete the requested task directly in this benchmark workspace. Keep changes scoped and run the public tests before finishing.
`;

function nowIso() {
  return new Date().toISOString();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function relativeToRepo(filePath) {
  return path.relative(REPO_ROOT, filePath).replaceAll("\\", "/");
}

function comparablePath(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInside(root, target) {
  const comparableRoot = comparablePath(root);
  const comparableTarget = comparablePath(target);
  return (
    comparableTarget === comparableRoot ||
    comparableTarget.startsWith(`${comparableRoot}${path.sep}`)
  );
}

function resolveChildPath(root, child, label) {
  if (typeof child !== "string" || child.trim() === "" || path.isAbsolute(child)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const target = path.resolve(root, child);
  if (comparablePath(target) === comparablePath(root) || !isPathInside(root, target)) {
    throw new Error(`${label} must stay below its declared root`);
  }
  return target;
}

function assertSafeRunId(runId) {
  if (
    typeof runId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) ||
    runId === "." ||
    runId === ".."
  ) {
    throw new Error("run-id must use 1-128 safe filename characters and cannot contain paths");
  }
  return runId;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
    await fs.rm(filePath, { force: true });
    await fs.rename(tempPath, filePath);
  }
}

async function writeTextFile(root, relativePath, content) {
  const target = resolveChildPath(root, relativePath, "scenario file path");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

function parseArgs(argv) {
  const options = {
    mode: "run",
    provider: "fixture",
    trials: null,
    seed: "meta-kim-p116",
    runId: null,
    stateRoot: DEFAULT_STATE_ROOT,
    workspaceRoot: DEFAULT_WORKSPACE_ROOT,
    timeoutMs: 8 * 60 * 1000,
    maxCases: null,
    model: null,
    taskId: null,
    groupId: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--validate") options.mode = "validate";
    else if (arg === "--plan") options.mode = "plan";
    else if (arg === "--run") options.mode = "run";
    else if (arg.startsWith("--provider=")) options.provider = arg.slice(11);
    else if (arg === "--provider") options.provider = argv[++index];
    else if (arg.startsWith("--trials=")) options.trials = Number(arg.slice(9));
    else if (arg === "--trials") options.trials = Number(argv[++index]);
    else if (arg.startsWith("--seed=")) options.seed = arg.slice(7);
    else if (arg === "--seed") options.seed = argv[++index];
    else if (arg.startsWith("--run-id=")) options.runId = arg.slice(9);
    else if (arg === "--run-id") options.runId = argv[++index];
    else if (arg.startsWith("--state-root=")) options.stateRoot = path.resolve(arg.slice(13));
    else if (arg === "--state-root") options.stateRoot = path.resolve(argv[++index]);
    else if (arg.startsWith("--workspace-root=")) options.workspaceRoot = path.resolve(arg.slice(17));
    else if (arg === "--workspace-root") options.workspaceRoot = path.resolve(argv[++index]);
    else if (arg.startsWith("--timeout-ms=")) options.timeoutMs = Number(arg.slice(13));
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (arg.startsWith("--max-cases=")) options.maxCases = Number(arg.slice(12));
    else if (arg === "--max-cases") options.maxCases = Number(argv[++index]);
    else if (arg.startsWith("--model=")) options.model = arg.slice(8);
    else if (arg === "--model") options.model = argv[++index];
    else if (arg.startsWith("--task-id=")) options.taskId = arg.slice(10);
    else if (arg === "--task-id") options.taskId = argv[++index];
    else if (arg.startsWith("--group-id=")) options.groupId = arg.slice(11);
    else if (arg === "--group-id") options.groupId = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export function assertStandaloneCodexHost(env = process.env) {
  const managedHostMarkers = ["CODEX_THREAD_ID", "CODEX_PERMISSION_PROFILE"].filter(
    (name) => typeof env[name] === "string" && env[name].trim() !== "",
  );
  if (managedHostMarkers.length > 0) {
    const error = new Error(
      [
        "P-116 live trials are blocked inside a managed Codex Desktop session.",
        `Detected host markers: ${managedHostMarkers.join(", ")}.`,
        "Run the live matrix from a standalone native shell so Codex can own the trial lifecycle without nested Desktop policy.",
        "Do not bypass this preflight or replace the native Codex CLI with Docker, WSL, or another provider.",
      ].join(" "),
    );
    error.code = "P116_NESTED_CODEX_HOST_BLOCKED";
    error.managedHostMarkers = managedHostMarkers;
    throw error;
  }
  return {
    ok: true,
    executionContext: "standalone_native_shell",
    managedHostMarkers: [],
  };
}

export function validateFitnessLabDefinition(contract, scenarioPack) {
  const errors = [];
  if (contract?.schemaVersion !== "harness-fitness-lab-contract-v0.1") {
    errors.push("wrong contract schemaVersion");
  }
  if (contract?.prdTaskId !== "P-116") errors.push("P-116 must own the contract");
  if (contract?.primaryRuntime !== "codex") errors.push("first lab must stay Codex-only");
  const groups = contract?.experiment?.groups ?? [];
  const groupIds = groups.map((group) => group.id);
  for (const expected of ["baseline", "full", "without_review"]) {
    if (!groupIds.includes(expected)) errors.push(`missing group ${expected}`);
  }
  const ablation = groups.find((group) => group.id === "without_review");
  if (ablation?.ablationLayer !== "Review") errors.push("ablation must remove Review only");
  const tasks = scenarioPack?.tasks ?? [];
  const taskClasses = tasks.map((task) => task.taskClass);
  for (const expected of contract?.experiment?.taskClasses ?? []) {
    if (!taskClasses.includes(expected)) errors.push(`missing task class ${expected}`);
  }
  for (const task of tasks) {
    if (!task.id || !task.prompt || !task.publicTestCommand || !task.hiddenTestCommand) {
      errors.push(`task ${task.id ?? "unknown"} is incomplete`);
    }
    if (Object.keys(task.starterFiles ?? {}).length < 2) {
      errors.push(`task ${task.id} needs at least two starter files`);
    }
    if (Object.keys(task.hiddenFiles ?? {}).length < 1) {
      errors.push(`task ${task.id} needs held-out tests`);
    }
    if ((task.rubricChecks ?? []).length !== 5) {
      errors.push(`task ${task.id} must have five blind rubric checks`);
    }
    for (const relativePath of [
      ...Object.keys(task.starterFiles ?? {}),
      ...Object.keys(task.hiddenFiles ?? {}),
      ...Object.keys(task.fixtureSolutionFiles ?? {}),
      ...(task.rubricChecks ?? []).map((check) => check.file),
    ]) {
      try {
        resolveChildPath("fitness-scenario-root", relativePath, "scenario file path");
      } catch {
        errors.push(`task ${task.id} contains an unsafe scenario file path`);
        break;
      }
    }
  }
  const expectedCount =
    tasks.length * groups.length * contract.experiment.trialsPerTaskGroup;
  if (expectedCount !== contract.experiment.expectedLiveTrialCount) {
    errors.push(`expected live trial count drifted: ${expectedCount}`);
  }
  if (contract?.truthBoundary?.fixtureRunsCountAsProductEvidence !== false) {
    errors.push("fixture evidence must not count as product evidence");
  }
  return { ok: errors.length === 0, errors };
}

function seededNumber(seedText) {
  return Number.parseInt(sha256(seedText).slice(0, 8), 16) >>> 0;
}

function seededShuffle(items, seedText) {
  const output = [...items];
  let state = seededNumber(seedText) || 1;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  for (let index = output.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [output[index], output[target]] = [output[target], output[index]];
  }
  return output;
}

export function buildTrialPlan(contract, scenarioPack, options = {}) {
  const trials = options.trials ?? contract.experiment.trialsPerTaskGroup;
  if (!Number.isInteger(trials) || trials < 1) throw new Error("trials must be a positive integer");
  const plan = [];
  for (let trial = 1; trial <= trials; trial += 1) {
    for (const task of scenarioPack.tasks) {
      for (const group of contract.experiment.groups) {
        const trialId = `${task.id}--${group.id}--t${trial}`;
        plan.push({
          trialId,
          taskId: task.id,
          taskClass: task.taskClass,
          groupId: group.id,
          trial,
          seed: sha256(`${options.seed ?? "meta-kim-p116"}:${trialId}`).slice(0, 16),
        });
      }
    }
  }
  return seededShuffle(plan, options.seed ?? "meta-kim-p116");
}

export function governanceInstructionsForGroup(groupId) {
  if (groupId === "baseline") return BASELINE_INSTRUCTIONS;
  if (groupId === "full") {
    return FULL_GOVERNANCE_TEMPLATE.replace("{{REVIEW_BLOCK}}", REVIEW_BLOCK);
  }
  if (groupId === "without_review") {
    return FULL_GOVERNANCE_TEMPLATE.replace(
      "{{REVIEW_BLOCK}}",
      "<!-- Review layer intentionally removed for P-116 ablation. -->",
    );
  }
  throw new Error(`Unknown group: ${groupId}`);
}

function executionPrompt(task, planItem) {
  return [
    task.prompt,
    "",
    `Public verification command: ${task.publicTestCommand}`,
    `Trial seed: ${planItem.seed}`,
    "Work only inside this isolated workspace. Hidden acceptance tests are not present during execution.",
    "Do not add Meta_Kim framework files, new agents, dashboards, or workflow DSL.",
  ].join("\n");
}

async function initializeWorkspace(workspace, task, groupId) {
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.mkdir(workspace, { recursive: true });
  for (const [relativePath, content] of Object.entries(task.starterFiles)) {
    await writeTextFile(workspace, relativePath, content);
  }
  await writeTextFile(workspace, "AGENTS.md", governanceInstructionsForGroup(groupId));
  await execFileAsync("git", ["init", "--quiet"], {
    cwd: workspace,
    windowsHide: true,
  });
  await execFileAsync("git", ["add", "--all"], {
    cwd: workspace,
    windowsHide: true,
  });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Meta_Kim Fitness Lab",
      "-c",
      "user.email=fitness-lab@local.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture: initialize isolated baseline",
    ],
    { cwd: workspace, windowsHide: true },
  );
}

async function applyFixtureSolution(workspace, task) {
  for (const [relativePath, content] of Object.entries(task.fixtureSolutionFiles ?? {})) {
    await writeTextFile(workspace, relativePath, content);
  }
  return {
    ok: true,
    timedOut: false,
    exitCode: 0,
    stdout: `${JSON.stringify({ type: "fixture.completed", synthetic: true })}\n`,
    stderr: "",
    durationMs: 1,
    command: "fixture-provider",
  };
}

function runChild(file, args, options = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {}
    }, options.timeoutMs ?? 120000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        ok: false,
        timedOut,
        exitCode: null,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        durationMs: Date.now() - startedAt,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        ok: code === 0 && !timedOut,
        timedOut,
        exitCode: code,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
    if (options.input != null) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export function codexCommandSpecFromCandidates(
  candidates,
  { fileExists = existsSync, nodeExecutable = process.execPath } = {},
) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const base = path.basename(candidate).toLowerCase();
    if (["codex", "codex.cmd", "codex.ps1"].includes(base)) {
      const wrapperDirectory = path.dirname(candidate);
      const cliScript = [
        path.join(wrapperDirectory, "node_modules", "@openai", "codex", "bin", "codex.js"),
        path.join(wrapperDirectory, "..", "@openai", "codex", "bin", "codex.js"),
      ].find((script) => fileExists(script));
      if (cliScript) {
        return { file: nodeExecutable, prefixArgs: [cliScript], source: "npm_node_wrapper" };
      }
    }
  }
  const executable = candidates.find(
    (candidate) => /\.exe$/i.test(candidate) && fileExists(candidate),
  );
  if (executable) return { file: executable, prefixArgs: [], source: "native_executable" };
  const fallback = candidates.find(Boolean) ?? "codex";
  return { file: fallback, prefixArgs: [], source: "path_fallback" };
}

async function resolveCodexCommandSpec() {
  const override = process.env.META_KIM_CODEX_CLI?.trim();
  if (override) return codexCommandSpecFromCandidates([override]);
  if (process.platform !== "win32") {
    return { file: "codex", prefixArgs: [], source: "path_executable" };
  }
  const { stdout } = await execFileAsync("where.exe", ["codex"], {
    windowsHide: true,
    encoding: "utf8",
  });
  const candidates = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return codexCommandSpecFromCandidates(candidates);
}

export function buildCodexTrialArgs(workspace, model = null) {
  const args = [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--skip-git-repo-check",
    "--ephemeral",
    "--json",
    "--color",
    "never",
    "--config",
    'approval_policy="on-request"',
    "--config",
    'approvals_reviewer="auto_review"',
    "--config",
    'default_permissions=":workspace"',
    "--cd",
    workspace,
    "--disable",
    "hooks",
    "--disable",
    "codex_hooks",
    "--disable",
    "plugin_hooks",
    "--disable",
    "plugins",
    "--disable",
    "apps",
    "--disable",
    "tool_search",
  ];
  if (model) args.push("--model", model);
  args.push("-");
  return args;
}

async function runCodexTrial(workspace, task, planItem, options) {
  const commandSpec = await resolveCodexCommandSpec();
  const args = buildCodexTrialArgs(workspace, options.model);
  const result = await runChild(commandSpec.file, [...commandSpec.prefixArgs, ...args], {
    cwd: workspace,
    timeoutMs: options.timeoutMs,
    input: executionPrompt(task, planItem),
  });
  return {
    ...result,
    hostContext: codexHostContextObservation(result, workspace),
    command: `${path.basename(commandSpec.file)} ${commandSpec.source} exec --ephemeral --json --config default_permissions=:workspace --config approval_policy=on-request --config approvals_reviewer=auto_review --cd <trial-workspace> --controlled-loadout`,
  };
}
export function codexHostContextObservation(result, workspace = null) {
  const diagnostic = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
  const resolvedWorkspace = workspace == null ? null : path.resolve(workspace);
  const workspaceInsideRepository =
    resolvedWorkspace === REPO_ROOT ||
    resolvedWorkspace?.startsWith(`${REPO_ROOT}${path.sep}`) === true;
  const sharedCapabilitySignals = [
    /Ignoring malformed agent role definition/i,
    /failed to load skill .*[/\\]\.agents[/\\]skills/i,
    /[/\\]Users[/\\][^/\\]+[/\\]\.codex[/\\]agents/i,
    /[/\\]Users[/\\][^/\\]+[/\\]\.agents[/\\]skills/i,
  ]
    .filter((pattern) => pattern.test(diagnostic))
    .map((pattern) => pattern.source);
  return {
    backend: "native_codex_cli",
    workspaceOutsideRepository: workspace != null && !workspaceInsideRepository,
    trialScopedInstructionsPresent: workspace != null && existsSync(path.join(workspace, "AGENTS.md")),
    sharedHostCapabilitiesHeldConstantAcrossGroups: true,
    globalCapabilitySignalsObserved: sharedCapabilitySignals.length > 0,
    globalCapabilitySignalCount: sharedCapabilitySignals.length,
  };
}

function allObjects(value, output = []) {
  if (!value || typeof value !== "object") return output;
  output.push(value);
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach((entry) => allObjects(entry, output));
    else allObjects(child, output);
  }
  return output;
}

export function parseCodexJsonl(raw) {
  const events = raw
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  let inputTokens = null;
  let cachedInputTokens = null;
  let outputTokens = null;
  let toolCallCount = 0;
  let fileMutationCount = 0;
  let testRunCount = 0;
  let reworkCount = 0;
  let failedTestObserved = false;
  let model = null;
  for (const event of events) {
    for (const object of allObjects(event)) {
      const usage = object.usage;
      if (usage && typeof usage === "object") {
        if (Number.isFinite(usage.input_tokens)) inputTokens = usage.input_tokens;
        if (Number.isFinite(usage.cached_input_tokens)) cachedInputTokens = usage.cached_input_tokens;
        if (Number.isFinite(usage.output_tokens)) outputTokens = usage.output_tokens;
      }
      if (!model && typeof object.model === "string") model = object.model;
    }
    const item = event.item ?? event.payload?.item ?? event;
    const itemType = String(item?.type ?? event.type ?? "");
    const command = String(item?.command ?? item?.aggregated_output ?? "");
    if (/command_execution|file_change|mcp_tool_call|collaboration_tool_call|tool_call/.test(itemType)) {
      toolCallCount += 1;
    }
    if (/file_change|apply_patch|write_file/.test(itemType)) {
      fileMutationCount += 1;
      if (failedTestObserved) reworkCount += 1;
    }
    if (/\b(test|node --test|npm test|npm run test)\b/i.test(command)) {
      testRunCount += 1;
      const exitCode = item?.exit_code ?? item?.exitCode;
      if (Number.isFinite(exitCode) && exitCode !== 0) failedTestObserved = true;
    }
  }
  return {
    eventCount: events.length,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    toolCallCount,
    fileMutationCount,
    testRunCount,
    reworkCount,
    model,
  };
}

async function runKnownNodeCommand(command, cwd, timeoutMs = 120000) {
  const parts = command.split(/\s+/).filter(Boolean);
  if (parts[0] !== "node") throw new Error(`Only node validation commands are allowed: ${command}`);
  return runChild(process.execPath, parts.slice(1), { cwd, timeoutMs });
}

async function installHiddenTests(workspace, task) {
  for (const [relativePath, content] of Object.entries(task.hiddenFiles)) {
    await writeTextFile(workspace, relativePath, content);
  }
}

export async function evaluateBlindQuality(workspace, task, submissionId) {
  const checks = [];
  for (const check of task.rubricChecks) {
    const filePath = path.join(workspace, check.file);
    let text = "";
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch {}
    const flags = check.flags ?? "";
    const passed = check.forbidPattern
      ? !new RegExp(check.forbidPattern, flags).test(text)
      : new RegExp(check.pattern, flags).test(text);
    checks.push({ id: check.id, passed });
  }
  const passedCount = checks.filter((check) => check.passed).length;
  return {
    schemaVersion: "fitness-blind-quality-v0.1",
    submissionId,
    groupIdentityVisible: false,
    score: Number(((passedCount / checks.length) * 5).toFixed(2)),
    checks,
  };
}

function redactDiagnostic(text) {
  const userHome = os.homedir();
  const escapedHome = userHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(text ?? "")
    .replace(new RegExp(escapedHome, process.platform === "win32" ? "gi" : "g"), "<user-home>")
    .replace(/(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]+)/g, "[REDACTED]")
    .slice(-8000);
}

function failureTypeFor(providerResult, hiddenResult, telemetry) {
  if (providerResult.timedOut) return "provider_timeout";
  if (!providerResult.ok) return "provider_failed";
  if (!hiddenResult.ok) return "held_out_environment_failure";
  if (telemetry.eventCount === 0) return "missing_trajectory";
  return null;
}

async function executeTrial({ runRoot, workspaceRoot, planItem, task, provider, options, contractDigest, scenarioDigest }) {
  const trialsRoot = resolveChildPath(runRoot, "trials", "trial state directory");
  const trialDir = resolveChildPath(trialsRoot, planItem.trialId, "trial state id");
  const resultPath = path.join(trialDir, "result.json");
  if (existsSync(resultPath)) {
    const existing = await readJson(resultPath);
    if (
      existing.contractDigest !== contractDigest ||
      existing.scenarioDigest !== scenarioDigest ||
      existing.trialId !== planItem.trialId ||
      existing.seed !== planItem.seed ||
      existing.provider !== provider
    ) {
      throw new Error(`Cannot resume ${planItem.trialId}: trial identity or definition changed`);
    }
    return existing;
  }
  const workspace = resolveChildPath(workspaceRoot, planItem.trialId, "trial workspace id");
  await initializeWorkspace(workspace, task, planItem.groupId);
  const startedAt = nowIso();
  const providerResult =
    provider === "codex"
      ? await runCodexTrial(workspace, task, planItem, options)
      : await applyFixtureSolution(workspace, task);
  const eventsPath = path.join(trialDir, "events.jsonl");
  await fs.mkdir(trialDir, { recursive: true });
  await fs.writeFile(eventsPath, providerResult.stdout, "utf8");
  const telemetry = parseCodexJsonl(providerResult.stdout);
  await installHiddenTests(workspace, task);
  const submissionId = `submission-${sha256(`${planItem.trialId}:${contractDigest}:${scenarioDigest}`).slice(0, 16)}`;
  const blindQuality = await evaluateBlindQuality(workspace, task, submissionId);
  const hiddenResult = await runKnownNodeCommand(task.hiddenTestCommand, workspace, 120000);
  const failureType = failureTypeFor(providerResult, hiddenResult, telemetry);
  const result = {
    schemaVersion: "harness-fitness-trial-v0.1",
    trialId: planItem.trialId,
    taskId: planItem.taskId,
    taskClass: planItem.taskClass,
    groupId: planItem.groupId,
    trial: planItem.trial,
    seed: planItem.seed,
    provider,
    evidenceKind: provider === "codex" ? "live_codex_jsonl" : "fixture_synthetic",
    countsTowardProductEvidence: provider === "codex" && telemetry.eventCount > 0,
    contractDigest,
    scenarioDigest,
    startedAt,
    completedAt: nowIso(),
    environmentOutcomeSuccess: providerResult.ok && hiddenResult.ok,
    blindQuality,
    metrics: {
      reworkCount: telemetry.reworkCount,
      toolCallCount: telemetry.toolCallCount,
      inputTokens: telemetry.inputTokens,
      cachedInputTokens: telemetry.cachedInputTokens,
      outputTokens: telemetry.outputTokens,
      wallClockMs: providerResult.durationMs,
      failureType,
      trajectoryDigest: sha256(providerResult.stdout),
      eventCount: telemetry.eventCount,
      model: telemetry.model ?? options.model,
    },
    provider: {
      ok: providerResult.ok,
      exitCode: providerResult.exitCode,
      timedOut: providerResult.timedOut,
      command: providerResult.command,
      hostContext: providerResult.hostContext ?? null,
      stderrTail: redactDiagnostic(providerResult.stderr),
      eventsRef: relativeToRepo(eventsPath),
    },
    heldOutVerification: {
      ok: hiddenResult.ok,
      exitCode: hiddenResult.exitCode,
      command: task.hiddenTestCommand,
      stdoutTail: redactDiagnostic(hiddenResult.stdout),
      stderrTail: redactDiagnostic(hiddenResult.stderr),
    },
  };
  await writeJsonAtomic(resultPath, result);
  return result;
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function median(values) {
  const usable = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!usable.length) return null;
  const middle = Math.floor(usable.length / 2);
  return usable.length % 2 ? usable[middle] : (usable[middle - 1] + usable[middle]) / 2;
}

function ratio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

function summarizeBucket(items) {
  return {
    trialCount: items.length,
    successRate: items.length
      ? items.filter((item) => item.environmentOutcomeSuccess).length / items.length
      : 0,
    blindQualityMean: average(items.map((item) => item.blindQuality.score)),
    medianWallClockMs: median(items.map((item) => item.metrics.wallClockMs)),
    medianInputTokens: median(items.map((item) => item.metrics.inputTokens)),
    medianOutputTokens: median(items.map((item) => item.metrics.outputTokens)),
    medianToolCalls: median(items.map((item) => item.metrics.toolCallCount)),
    medianReworkCount: median(items.map((item) => item.metrics.reworkCount)),
    failureTypes: Object.fromEntries(
      [...new Set(items.map((item) => item.metrics.failureType).filter(Boolean))].map((type) => [
        type,
        items.filter((item) => item.metrics.failureType === type).length,
      ]),
    ),
  };
}

export function analyzeFitnessResults(contract, plan, results, provider) {
  const byGroupTask = {};
  for (const group of contract.experiment.groups) {
    byGroupTask[group.id] = {};
    for (const taskClass of contract.experiment.taskClasses) {
      byGroupTask[group.id][taskClass] = summarizeBucket(
        results.filter((item) => item.groupId === group.id && item.taskClass === taskClass),
      );
    }
  }
  const byGroup = Object.fromEntries(
    contract.experiment.groups.map((group) => [
      group.id,
      summarizeBucket(results.filter((item) => item.groupId === group.id)),
    ]),
  );
  const criteria = contract.passCriteria;
  const taskClassComparisons = contract.experiment.taskClasses.map((taskClass) => {
    const baseline = byGroupTask.baseline[taskClass];
    const full = byGroupTask.full[taskClass];
    const successDelta = full.successRate - baseline.successRate;
    const blindQualityDelta = full.blindQualityMean - baseline.blindQualityMean;
    return {
      taskClass,
      successDelta,
      blindQualityDelta,
      improved:
        successDelta >= criteria.successRateImprovementPoints ||
        blindQualityDelta >= criteria.blindQualityImprovement,
    };
  });
  const improvedTaskClasses = taskClassComparisons.filter((item) => item.improved).length;
  const tokenRatio = ratio(byGroup.full.medianInputTokens, byGroup.baseline.medianInputTokens);
  const wallClockRatio = ratio(byGroup.full.medianWallClockMs, byGroup.baseline.medianWallClockMs);
  const highRiskFull = byGroupTask.full.cross_file_high_risk;
  const highRiskBaseline = byGroupTask.baseline.cross_file_high_risk;
  const avoidedHighCostError =
    highRiskFull.successRate > highRiskBaseline.successRate && highRiskFull.successRate > 0;
  const efficiencyPass =
    ((tokenRatio == null || tokenRatio <= criteria.maximumMedianTokenRatio) &&
      (wallClockRatio == null || wallClockRatio <= criteria.maximumMedianWallClockRatio)) ||
    avoidedHighCostError;
  const full = byGroup.full;
  const withoutReview = byGroup.without_review;
  const reviewSuccessDelta = full.successRate - withoutReview.successRate;
  const reviewQualityDelta = full.blindQualityMean - withoutReview.blindQualityMean;
  const reviewFinding =
    reviewSuccessDelta >= criteria.successRateImprovementPoints || reviewQualityDelta >= 0.2
      ? "positive"
      : reviewSuccessDelta < 0 || reviewQualityDelta < -0.2
        ? "negative"
        : "ineffective";
  const governanceBundleFinding =
    improvedTaskClasses >= criteria.minimumImprovedTaskClasses ? "positive" : "ineffective_or_negative";
  const componentFindings = [
    { component: "Meta_Kim governance bundle", finding: governanceBundleFinding },
    { component: "Review layer", finding: reviewFinding },
  ];
  const positiveCount = componentFindings.filter((item) => item.finding === "positive").length;
  const ineffectiveOrNegativeCount = componentFindings.filter((item) =>
    ["ineffective", "negative", "ineffective_or_negative"].includes(item.finding),
  ).length;
  const expectedFullTrialCount = contract.experiment.expectedLiveTrialCount;
  const partialPlan = plan.length < expectedFullTrialCount;
  const fullMatrixComplete =
    plan.length === expectedFullTrialCount &&
    results.length === expectedFullTrialCount &&
    results.every((item) => item.countsTowardProductEvidence);
  const pilotHealth = partialPlan
    ? results.length === plan.length &&
      results.every(
        (item) => item.countsTowardProductEvidence && item.environmentOutcomeSuccess,
      )
      ? "pass"
      : "fail"
    : null;
  const criteriaPass =
    improvedTaskClasses >= criteria.minimumImprovedTaskClasses &&
    efficiencyPass &&
    positiveCount >= criteria.componentFindingRequired.positive &&
    ineffectiveOrNegativeCount >= criteria.componentFindingRequired.ineffectiveOrNegative;
  return {
    schemaVersion: "harness-fitness-lab-report-v0.1",
    prdTaskId: "P-116",
    generatedAt: nowIso(),
    provider,
    evidenceKind: provider === "codex" ? "live_codex_trials" : "fixture_diagnostic",
    countsTowardProductEvidence: provider === "codex" && fullMatrixComplete,
    status:
      provider !== "codex"
        ? "diagnostic_only"
        : partialPlan
          ? "pilot_incomplete"
          : !fullMatrixComplete
            ? "incomplete"
            : criteriaPass
              ? "pass"
              : "fail",
    summary: {
      plannedTrialCount: plan.length,
      expectedFullTrialCount,
      completedTrialCount: results.length,
      pilotHealth,
      improvedTaskClasses,
      requiredImprovedTaskClasses: criteria.minimumImprovedTaskClasses,
      tokenRatio,
      wallClockRatio,
      avoidedHighCostError,
      efficiencyPass,
      criteriaPass,
    },
    taskClassComparisons,
    componentFindings,
    byGroup,
    byGroupTask,
    truthBoundary: contract.truthBoundary,
    results,
  };
}

function reportMarkdown(report) {
  const lines = [
    "# Harness Fitness Lab",
    "",
    `- status: ${report.status}`,
    `- provider: ${report.provider}`,
    `- evidenceKind: ${report.evidenceKind}`,
    `- completed: ${report.summary.completedTrialCount}/${report.summary.plannedTrialCount} (formal matrix: ${report.summary.expectedFullTrialCount})`,
    `- pilotHealth: ${report.summary.pilotHealth ?? "not_applicable"}`,
    `- improvedTaskClasses: ${report.summary.improvedTaskClasses}/${report.summary.requiredImprovedTaskClasses}`,
    `- tokenRatio: ${report.summary.tokenRatio ?? "missing"}`,
    `- wallClockRatio: ${report.summary.wallClockRatio ?? "missing"}`,
    "",
    "## Task Classes",
    "",
    "| Task class | Success delta | Blind quality delta | Improved |",
    "|---|---:|---:|---|",
    ...report.taskClassComparisons.map(
      (item) =>
        `| ${item.taskClass} | ${item.successDelta.toFixed(3)} | ${item.blindQualityDelta.toFixed(3)} | ${item.improved} |`,
    ),
    "",
    "## Component Findings",
    "",
    ...report.componentFindings.map((item) => `- ${item.component}: ${item.finding}`),
    "",
    "Fixture runs and incomplete matrices are diagnostic only. Failed and timed-out live trials remain in the denominator.",
  ];
  return `${lines.join("\n")}\n`;
}

export async function runFitnessLab(options) {
  options = {
    workspaceRoot: DEFAULT_WORKSPACE_ROOT,
    timeoutMs: 8 * 60 * 1000,
    model: null,
    ...options,
  };
  const contractRaw = await fs.readFile(CONTRACT_PATH, "utf8");
  const scenarioRaw = await fs.readFile(SCENARIO_PATH, "utf8");
  const contract = JSON.parse(contractRaw);
  const scenarioPack = JSON.parse(scenarioRaw);
  const validation = validateFitnessLabDefinition(contract, scenarioPack);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  if (options.mode === "validate") return { validation, contract, scenarioPack };
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("timeout-ms must be a positive number");
  }
  if (options.maxCases != null && (!Number.isInteger(options.maxCases) || options.maxCases < 1)) {
    throw new Error("max-cases must be a positive integer");
  }
  const trials = options.trials ?? contract.experiment.trialsPerTaskGroup;
  const fullPlan = buildTrialPlan(contract, scenarioPack, { trials, seed: options.seed });
  const filteredPlan = fullPlan.filter(
    (item) =>
      (options.taskId == null || item.taskId === options.taskId) &&
      (options.groupId == null || item.groupId === options.groupId),
  );
  if (filteredPlan.length === 0) {
    throw new Error(`No trials matched taskId=${options.taskId ?? "*"} groupId=${options.groupId ?? "*"}`);
  }
  const plan = Number.isInteger(options.maxCases)
    ? filteredPlan.slice(0, options.maxCases)
    : filteredPlan;
  if (options.mode === "plan") return { validation, plan };
  if (!["fixture", "codex"].includes(options.provider)) {
    throw new Error("provider must be fixture or codex");
  }
  if (options.provider === "codex") assertStandaloneCodexHost();
  const runId =
    options.runId ??
    `${options.provider}-${new Date().toISOString().replace(/[:.]/g, "-")}-${sha256(options.seed).slice(0, 8)}`;
  assertSafeRunId(runId);
  const runRoot = resolveChildPath(options.stateRoot, runId, "run-id");
  options.runId = runId;
  const workspaceRoot = resolveChildPath(options.workspaceRoot, runId, "run-id");
  if (options.provider === "codex" && isPathInside(REPO_ROOT, workspaceRoot)) {
    throw new Error("live Codex trial workspaces must stay outside the Meta_Kim repository");
  }
  const contractDigest = sha256(contractRaw);
  const scenarioDigest = sha256(scenarioRaw);
  await fs.mkdir(runRoot, { recursive: true });
  await writeJsonAtomic(path.join(runRoot, "plan.json"), {
    schemaVersion: "harness-fitness-plan-v0.1",
    runId,
    provider: options.provider,
    contractDigest,
    scenarioDigest,
    seed: options.seed,
    host: { platform: process.platform, arch: process.arch, node: process.version, cpus: os.cpus().length },
    workspaceIsolation: {
      rootOutsideRepository: !path.resolve(workspaceRoot).startsWith(`${REPO_ROOT}${path.sep}`),
      backend: "native_codex_cli",
    },
    expectedFullTrialCount: contract.experiment.expectedLiveTrialCount,
    plan,
  });
  const taskById = new Map(scenarioPack.tasks.map((task) => [task.id, task]));
  const results = [];
  for (let index = 0; index < plan.length; index += 1) {
    const planItem = plan[index];
    process.stderr.write(
      `[fitness ${index + 1}/${plan.length}] ${planItem.taskId} ${planItem.groupId} trial=${planItem.trial}\n`,
    );
    results.push(
      await executeTrial({
        runRoot,
        workspaceRoot,
        planItem,
        task: taskById.get(planItem.taskId),
        provider: options.provider,
        options,
        contractDigest,
        scenarioDigest,
      }),
    );
  }
  const report = analyzeFitnessResults(contract, plan, results, options.provider);
  report.runId = runId;
  report.contractDigest = contractDigest;
  report.scenarioDigest = scenarioDigest;
  const reportPath = path.join(runRoot, "report.json");
  const markdownPath = path.join(runRoot, "report.zh-CN.md");
  await writeJsonAtomic(reportPath, report);
  await fs.writeFile(markdownPath, reportMarkdown(report), "utf8");
  await writeJsonAtomic(path.join(options.stateRoot, "latest.json"), {
    runId,
    report: relativeToRepo(reportPath),
    status: report.status,
    generatedAt: report.generatedAt,
    contractDigest,
    scenarioDigest,
  });
  return { validation, plan, report, reportPath, markdownPath };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const output = await runFitnessLab(options);
  if (options.mode === "validate") {
    process.stdout.write(`${JSON.stringify({ ok: true, prdTaskId: output.contract.prdTaskId }, null, 2)}\n`);
    return;
  }
  if (options.mode === "plan") {
    process.stdout.write(`${JSON.stringify({ ok: true, trialCount: output.plan.length, plan: output.plan }, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: output.report.status === "pass" || output.report.status === "diagnostic_only",
        runId: output.report.runId,
        status: output.report.status,
        evidenceKind: output.report.evidenceKind,
        completedTrialCount: output.report.summary.completedTrialCount,
        report: relativeToRepo(output.reportPath),
      },
      null,
      2,
    )}\n`,
  );
  if (
    options.provider === "codex" &&
    output.report.status !== "pass" &&
    !(output.report.status === "pilot_incomplete" && output.report.summary.pilotHealth === "pass")
  ) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
