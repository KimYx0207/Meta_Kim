import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkedPath, componentHash, stableJson, sha256 } from '../dependency-agent-discovery.mjs';
import { detectPython310 } from '../graphify-runtime.mjs';
import { spawnCli } from '../runtime-cli-invocation.mjs';
import { runCommandWithIgnoredStdin } from '../eval-process-runner.mjs';
import { taskOutcomeDigest } from '../../src/domain/governance/task-outcome.mjs';
import { intentDialogueDigest } from './intent-dialogue.mjs';
import { discoverRuntimeExecutablePaths } from '../runtime-executable-binding.mjs';
import { LOCAL_DEPENDENCY_TOOL_CONTRACT, LOCAL_DEPENDENCY_TOOL_OUTPUT_SHAPES as shapes, LOCAL_DEPENDENCY_TOOL_OUTPUT_STATUSES as statuses, LOCAL_DEPENDENCY_TOOL_SCHEMA_VERSION as schemaVersion, LOCAL_DEPENDENCY_TOOL_INPUT_FIELDS as inputFields } from './local-dependency-tool-contract.mjs';
export { LOCAL_DEPENDENCY_TOOL_CONTRACT };

const observations = new WeakMap();
const workOrders = new WeakMap();
const invocationShape = LOCAL_DEPENDENCY_TOOL_CONTRACT.invocation;
const ruleIds = LOCAL_DEPENDENCY_TOOL_CONTRACT.ruleIds;
const samePath = (a, b) => { const left = path.resolve(a), right = path.resolve(b); return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right; };
const digest = (value) => sha256(stableJson(value));
const keys = (value, expected, label) => {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} contains unsupported or missing fields`);
};
const safeText = (value) => String(value ?? '').replace(/(?:Bearer\s+|(?:token|password|api[_-]?key)\s*[:=]\s*)\S+/giu, '[redacted]').replace(/(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/)[^\s"']+/gu, '<local-path>').slice(0, 2000);
const inside = (root, target) => { const relative = path.relative(root, target); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); };

async function trustedPath(file, directory = true) {
  assert(typeof file === 'string' && path.isAbsolute(file), 'path must be absolute');
  assert(!file.includes('\0') && !/^(?:\\\\|\/\/)/u.test(file), 'network paths are unsupported');
  const resolved = path.resolve(file);
  const real = await fs.realpath(resolved);
  assert(samePath(real, resolved), 'path cannot traverse a symlink or junction');
  const stat = await fs.lstat(resolved);
  assert(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()), 'path has an unsafe type');
  return resolved;
}

function bindingView({ runId, runtime, node, packet, localToolBinding = packet?.localToolBinding }) {
  return { runId, runtime, nodeId: node?.nodeId, taskPacketId: packet?.taskPacketId,
    taskHash: localToolBinding?.taskHash, intentDigest: localToolBinding?.intentDigest,
    provider: localToolBinding?.selectedCapability?.id,
    contractSha256: localToolBinding?.selectedCapability?.contractSha256,
    componentContentSha256: localToolBinding?.selectedCapability?.componentContentSha256,
    indexSha256: localToolBinding?.selectedCapability?.indexSha256,
    sourceRoot: localToolBinding?.selectedCapability?.sourceRoot, componentRoot: localToolBinding?.selectedCapability?.componentRoot,
    indexPath: localToolBinding?.selectedCapability?.indexPath,
    testOnly: localToolBinding?.selectedCapability?.testOnly === true, fixture: localToolBinding?.selectedCapability?.evidence?.fixture === true,
    scopeFiles: packet?.scopeFiles, effectClass: node?.effectClass ?? packet?.effectClass,
    sourceReview: packet?.intentBinding?.constraints?.localToolSourceReview,
    input: localToolBinding?.input };
}

function validateSourceReview(packet, selected) {
  const review = packet?.intentBinding?.constraints?.localToolSourceReview;
  assert(review?.status === 'pass', 'source review must explicitly pass');
  assert(review && Array.isArray(review.evidenceRefs) && review.evidenceRefs.length > 0 && review.evidenceRefs.every((ref) => typeof ref === 'string' && ref.trim()), 'exact source-review evidence is missing');
  for (const field of ['dependencyId', 'sourceRoot', 'componentVersion', 'contractSha256', 'componentContentSha256', 'indexSha256']) {
    assert(field === 'sourceRoot' ? samePath(review[field], selected[field]) : review[field] === selected[field], `source review differs from selection: ${field}`);
  }
}

/** Called by the existing host runner after confirmed understanding, never by CLI JSON. */
export function bindLocalDependencyToolWorkOrder(packet, { runId, runtime, node, requestTask, confirmedIntent, sharedUnderstandingConfirmed, testOnly = false }) {
  const binding = packet?.localToolBinding;
  assert.equal(binding?.runId, runId); assert.equal(binding.taskHash, taskOutcomeDigest(requestTask));
  assert.equal(binding.intentDigest, packet.intentDigest ?? packet.intentBinding?.intentDigest);
  validateSourceReview(packet, binding.selectedCapability);
  if (testOnly) {
    assert.equal(binding.selectedCapability.testOnly, true); assert.equal(binding.selectedCapability.evidence?.fixture, true);
  } else {
    assert.equal(binding.selectedCapability.testOnly === true || binding.selectedCapability.evidence?.fixture === true, false, 'fixture cannot produce a production work order');
    assert.equal(binding.selectedCapability.dependencyId, LOCAL_DEPENDENCY_TOOL_CONTRACT.dependencyId, 'unreviewed dependency');
    assert.equal(packet.intentBinding?.status, 'host_provided_understanding');
    assert.equal(confirmedIntent?.taskHash, binding.taskHash);
    assert.equal(intentDialogueDigest(confirmedIntent), binding.intentDigest);
    assert.deepEqual(confirmedIntent.constraints?.localToolSourceReview, packet.intentBinding.constraints.localToolSourceReview);
    assert.equal(sharedUnderstandingConfirmed?.trusted, true);
    assert.equal(sharedUnderstandingConfirmed.binding, 'plan-challenge-understanding-confirmation');
    assert.equal(sharedUnderstandingConfirmed.taskHash, binding.taskHash);
    assert.equal(sharedUnderstandingConfirmed.intentDigest, binding.intentDigest);
    assert(Array.isArray(confirmedIntent.evidenceRefs) && Array.isArray(sharedUnderstandingConfirmed.evidenceRefs));
    assert(confirmedIntent.evidenceRefs.every((ref) => sharedUnderstandingConfirmed.evidenceRefs.includes(ref)));
  }
  workOrders.set(packet, { bindingDigest: digest(bindingView({ runId, runtime, node, packet })), testOnly });
  return packet;
}

async function validateSource(selected) {
  assert(selected?.type === 'skills' && selected.componentId === LOCAL_DEPENDENCY_TOOL_CONTRACT.componentId, 'unsupported dependency tool component');
  assert(selected.selectedCapability?.id === LOCAL_DEPENDENCY_TOOL_CONTRACT.capabilityId, 'unsupported local capability');
  assert(selected.evidence?.source === 'local_dependency_skill_contract', 'selected capability requires source-verified discovery');
  assert(/^[a-f0-9]{64}$/u.test(selected.indexSha256), 'selection index digest is required');
  const sourceRoot = await trustedPath(selected.sourceRoot);
  const componentRoot = await checkedPath(sourceRoot, `skills/${LOCAL_DEPENDENCY_TOOL_CONTRACT.componentId}`, true);
  assert(samePath(componentRoot, selected.componentRoot), 'component root differs from discovery');
  const indexPath = await trustedPath(selected.indexPath, false);
  assert(inside(sourceRoot, indexPath), 'index must belong to the dependency');
  const indexBytes = await fs.readFile(indexPath);
  assert.equal(sha256(indexBytes), selected.indexSha256, 'dependency index changed after selection');
  const index = JSON.parse(indexBytes.toString('utf8'));
  const component = index.components?.find((entry) => entry.id === LOCAL_DEPENDENCY_TOOL_CONTRACT.componentId);
  assert(component?.componentType === 'skill' && component.path === `skills/${LOCAL_DEPENDENCY_TOOL_CONTRACT.componentId}`, 'index component mismatch');
  const contract = JSON.parse(await fs.readFile(await checkedPath(componentRoot, 'capability.json'), 'utf8'));
  assert.equal(contract.id, LOCAL_DEPENDENCY_TOOL_CONTRACT.componentId); assert.equal(contract.componentType, 'skill');
  assert.equal(contract.componentVersion, LOCAL_DEPENDENCY_TOOL_CONTRACT.componentVersion, 'unreviewed component version');
  assert.equal(component.componentVersion, contract.componentVersion);
  assert.equal(contract.entrypoint, 'SKILL.md');
  assert.equal(sha256(stableJson(contract)), selected.contractSha256, 'full contract changed');
  assert.equal(component.contractSha256, selected.contractSha256, 'index contract binding changed');
  const contentHash = await componentHash(componentRoot);
  assert.equal(contentHash, selected.componentContentSha256, 'dependency component changed');
  assert.equal(component.contentSha256, contentHash, 'index component binding changed');
  const capability = contract.capabilities.find((entry) => entry.id === LOCAL_DEPENDENCY_TOOL_CONTRACT.capabilityId);
  assert.deepEqual(capability, selected.selectedCapability, 'selected capability differs from full source contract');
  assert.deepEqual(capability.invocation, invocationShape, 'unsupported invocation adapter shape');
  assert.deepEqual(capability.sideEffects, [], 'tool cannot acquire source-write permission');
  assert.equal(capability.humanGate?.required, false, 'required permission gate is unresolved');
  const projected = { ...capability, componentId: component.id, componentType: 'skill', componentVersion: contract.componentVersion,
    componentPath: component.path, entrypoint: contract.entrypoint, componentContentSha256: contentHash, contractSha256: selected.contractSha256 };
  const row = index.capabilities?.find((entry) => entry.id === capability.id && entry.componentId === component.id);
  assert(row, 'selected capability missing from index');
  for (const [key, value] of Object.entries(row)) assert.deepEqual(value, projected[key], `index source mismatch: ${key}`);
  const entrypoint = await checkedPath(componentRoot, invocationShape.entrypoint);
  const rulesPath = await checkedPath(componentRoot, LOCAL_DEPENDENCY_TOOL_CONTRACT.rules);
  const prompt = await checkedPath(componentRoot, 'SKILL.md');
  return { entrypoint, rulesSha256: sha256(await fs.readFile(rulesPath)), entrypointSha256: sha256(await fs.readFile(entrypoint)),
    promptSha256: sha256(await fs.readFile(prompt)), componentContentSha256: contentHash, componentRoot };
}

async function snapshot(target) {
  const stat = await fs.lstat(target);
  if (stat.isFile()) return sha256(await fs.readFile(target));
  return componentHash(target);
}

function validateOutput(output, exitCode, workspaceRoot, target, rulesSha256) {
  assert(Number.isInteger(exitCode), 'scanner exit status is missing');
  keys(output, shapes.root, 'tool output');
  assert.equal(output.schemaVersion, schemaVersion); assert.equal(output.componentVersion, LOCAL_DEPENDENCY_TOOL_CONTRACT.componentVersion);
  assert(statuses.includes(output.status));
  assert.equal(output.completed, output.status === 'completed');
  assert.equal(output.completed, exitCode === 0, 'exit code disagrees with completion');
  assert.equal(output.networkUsed, false); assert.equal(output.filesModified, false);
  assert(Array.isArray(output.findings) && output.findings.length <= 10000);
  assert(Array.isArray(output.errors) && output.errors.length <= 1000);
  keys(output.runtime, shapes.runtime, 'runtime');
  assert(typeof output.runtime.pythonVersion === 'string' && output.runtime.pythonVersion.length < 100);
  assert(output.runtime.semgrepVersion === null || typeof output.runtime.semgrepVersion === 'string');
  keys(output.rules, shapes.rules, 'rules');
  assert.equal(output.rules.source, `canonical:skills/${LOCAL_DEPENDENCY_TOOL_CONTRACT.componentId}/${LOCAL_DEPENDENCY_TOOL_CONTRACT.rules}`);
  assert.deepEqual(output.rules.includedRuleIds, [...ruleIds]);
  for (const key of ['sourceSha256', 'effectiveSha256']) assert(output.rules[key] === null || /^[a-f0-9]{64}$/u.test(output.rules[key]));
  if (output.rules.sourceSha256 !== null) assert.equal(output.rules.sourceSha256, rulesSha256, 'output rules source digest disagrees');
  if (output.completed) { assert.equal(output.rules.sourceSha256, rulesSha256, 'completed scan needs rule evidence'); assert(/^[a-f0-9]{64}$/u.test(output.rules.effectiveSha256), 'completed scan needs effective-rule evidence'); }
  for (const finding of output.findings) {
    keys(finding, shapes.finding, 'finding');
    assert(typeof finding.path === 'string' && !/[\\:\0]/u.test(finding.path));
    assert(finding.path.split('/').every((segment) => segment && segment !== '..' && segment !== '.'));
    const absolute = path.resolve(workspaceRoot, finding.path);
    assert(inside(target, absolute), 'finding is outside authorized target');
    for (const key of ['start', 'end']) { keys(finding[key], shapes.location, 'location'); assert(Number.isInteger(finding[key].line) && finding[key].line > 0 && Number.isInteger(finding[key].col) && finding[key].col > 0); }
    for (const key of ['checkId', 'severity', 'message']) assert(typeof finding[key] === 'string' && finding[key].length < 2001);
    assert(ruleIds.some((id) => finding.checkId === id || finding.checkId.endsWith(`.${id}`)), 'finding uses an unreviewed rule');
  }
  for (const error of output.errors) { keys(error, shapes.error, 'error'); assert(typeof error.code === 'string' && typeof error.message === 'string'); }
  return output;
}

function isolatedEnv(home) {
  const env = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'LANG', 'LC_ALL']) if (typeof process.env[key] === 'string') env[key] = process.env[key];
  return { ...env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData'), LOCALAPPDATA: path.join(home, 'LocalAppData'), TEMP: home, TMP: home,
    XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', SEMGREP_SEND_METRICS: 'off' };
}

/** Only the observed in-process object has authority; JSON/copies and mutations do not. */
export function isObservedLocalDependencyToolResult(result, expectedBinding = {}) {
  const observed = result && observations.get(result);
  if (!observed) return false;
  try { return observed.resultDigest === digest(result) && observed.bindingDigest === digest(bindingView(expectedBinding)); }
  catch { return false; }
}

/** Execute the one reviewed local Python adapter; no arbitrary command or caller permission flag. */
export async function invokeLocalDependencyToolWorker({ runId, runtime, workspaceRoot, timeoutMs = 60000, node, packet, requestTask, signal = null }) {
  const startedAt = new Date().toISOString(); const started = performance.now();
  let processResult = null, home = null, receiptRoot = null, source = null, before = null, after = null, target = null, binding = packet?.localToolBinding;
  let sourceUnmodifiedVerified = false, guardFailure = null, executionIdentity = null;
  let preparedBindingDigest = null, preparedBinding = null;
  let failureClass = null, failureMessage = null, output = null, cleanup = { tempHomeRemoved: false, ownedProcessGroupCleanupVerified: false, processTree: 'not_claimed', boundary: 'Owned process group only; escaped processes and network isolation are not claimed' };
  try {
    const workOrder = workOrders.get(packet);
    assert(workOrder && workOrder.bindingDigest === digest(bindingView({ runId, runtime, node, packet })), 'local tool requires a host-bound original work order');
    if (!workOrder.testOnly && !LOCAL_DEPENDENCY_TOOL_CONTRACT.supportedPlatforms.includes(process.platform)) {
      failureClass = 'unsupported_runtime';
      throw new Error('Production local scanner requires verified Windows Job cleanup; POSIX detached Semgrep is unsupported');
    }
    preparedBinding = JSON.parse(stableJson(bindingView({ runId, runtime, node, packet })));
    preparedBindingDigest = digest(preparedBinding);
    assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId), 'invalid run id');
    assert(['codex', 'claude'].includes(runtime), 'unsupported host runtime');
    assert(node?.nodeId && packet?.taskPacketId, 'node and task packet binding required');
    assert.equal(node.effectClass ?? packet.effectClass, 'read_only_support', 'tool needs an explicit read-only support work order');
    assert.equal(binding?.runId, runId, 'tool binding run mismatch');
    assert.equal(binding.taskHash, taskOutcomeDigest(requestTask), 'tool binding task mismatch');
    assert.equal(binding.intentDigest, packet.intentDigest ?? packet.intentBinding?.intentDigest, 'intent binding mismatch');
    assert(/^[a-f0-9]{64}$/u.test(binding.intentDigest), 'intent digest is required');
    assert(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000, 'invalid local timeout');
    const root = await trustedPath(workspaceRoot);
    keys(binding.input, Object.hasOwn(binding.input, 'rules') ? [...inputFields, 'rules'] : inputFields, 'tool input');
    assert.equal(binding.input.schemaVersion, schemaVersion); assert(path.isAbsolute(binding.input.workspaceRoot) && samePath(binding.input.workspaceRoot, root), 'input workspace differs from trusted workspace');
    assert(binding.input.rules === undefined || binding.input.rules === LOCAL_DEPENDENCY_TOOL_CONTRACT.rules, 'unreviewed rules');
    target = await trustedPath(path.resolve(root, binding.input.target));
    assert(inside(root, target) && !samePath(root, target), 'target must be a bounded directory within the workspace');
    assert(Array.isArray(packet.scopeFiles) && packet.scopeFiles.length > 0, 'authorized target scope is missing');
    assert(packet.scopeFiles.some((entry) => typeof entry === 'string' && inside(root, path.resolve(root, entry)) && !samePath(root, path.resolve(root, entry)) && inside(path.resolve(root, entry), target)), 'target exceeds work-order scope');
    source = await validateSource(binding.selectedCapability);
    validateSourceReview(packet, binding.selectedCapability);
    assert.equal(digest(bindingView({ runId, runtime, node, packet })), preparedBindingDigest, 'work-order binding changed during preparation');
    assert(!inside(target, source.componentRoot), 'scanner component must not be inside its target');
    before = await snapshot(target);
    const tmp = path.join(root, 'tmp'); const receipts = path.join(tmp, 'local-dependency-tool-receipts');
    assert(!inside(target, receipts), 'owned receipt directory cannot be inside the scan target');
    await fs.mkdir(tmp, { recursive: true }); await trustedPath(tmp);
    await fs.mkdir(receipts, { recursive: true }); await trustedPath(receipts);
    receiptRoot = await fs.mkdtemp(path.join(receipts, `${runId}-`));
    if (signal?.aborted) throw new Error('local tool invocation cancelled before launch');
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-kim-local-tool-home-'));
    const env = isolatedEnv(home);
    const python = detectPython310((command, args, options) => spawnSync(command, args, { ...options, env, timeout: 10000, windowsHide: true, shell: false }), process.platform, { env: process.env });
    assert(python, 'existing Python >=3.10 is unavailable; no installation attempted');
    const version = await spawnCli(python.command, [...python.args, '--version'], { env, cwd: root, timeoutMs: 10000, maxOutputBytes: 4096, signal });
    assert.equal(version.status, 0, 'Python version probe failed');
    const verified = await validateSource(binding.selectedCapability); assert.deepEqual(verified, source, 'source drift before launch');
    const pythonPath = await fs.realpath(path.isAbsolute(version.command) ? version.command : discoverRuntimeExecutablePaths(version.command)[0]);
    const pythonIdentity = { realpath: pythonPath, sha256: sha256(await fs.readFile(pythonPath)), version: (version.stdout || version.stderr).trim() };
    let semgrepIdentity = null;
    if (!workOrders.get(packet).testOnly) {
      for (const candidate of discoverRuntimeExecutablePaths('semgrep')) {
        try {
          const realpath = await trustedPath(candidate, false);
          assert(!inside(root, realpath) && !inside(binding.selectedCapability.sourceRoot, realpath), 'Semgrep cannot come from a project tree');
          assert(/^semgrep(?:\.exe)?$/iu.test(path.basename(realpath)), 'unsupported Semgrep launcher');
          if (process.platform === 'win32') assert.equal((await fs.readFile(realpath)).subarray(0, 2).toString(), 'MZ', 'Semgrep must be a native executable launcher');
          semgrepIdentity = { realpath, sha256: sha256(await fs.readFile(realpath)) }; break;
        } catch { /* Non-direct, linked or project launchers stay ineligible. */ }
      }
      assert(semgrepIdentity, 'already-installed direct Semgrep is unavailable; no installation attempted');
      // Bind only the already installed Windows user-site runtime derived from
      // the verified launcher and selected Python; never inherit PYTHONPATH.
      const pythonVersion = /^Python (\d+)\.(\d+)\./u.exec(pythonIdentity.version);
      const scriptsRoot = path.dirname(semgrepIdentity.realpath);
      const versionRoot = path.dirname(scriptsRoot);
      if (pythonVersion && path.basename(scriptsRoot).toLowerCase() === 'scripts' &&
          path.basename(versionRoot).toLowerCase() === ('Python' + pythonVersion[1] + pythonVersion[2]).toLowerCase()) {
        const userBase = await trustedPath(path.dirname(versionRoot));
        const packageInitPath = await trustedPath(path.join(versionRoot, 'site-packages/semgrep/__init__.py'), false);
        const sitePackages = path.dirname(path.dirname(packageInitPath));
        for (const project of [root, binding.selectedCapability.sourceRoot]) {
          assert(!inside(project, userBase) && !inside(project, packageInitPath) && !inside(project, sitePackages) && !inside(sitePackages, project), 'Semgrep runtime cannot overlap a project');
        }
        semgrepIdentity.pythonUserBase = { realpath: userBase, packageInitPath, packageInitSha256: sha256(await fs.readFile(packageInitPath)) };
        env.PYTHONUSERBASE = userBase;
      }
    }
    const windowsRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:/Windows';
    const osDirs = process.platform === 'win32' ? [path.join(windowsRoot, 'System32'), path.join(windowsRoot, 'System32/WindowsPowerShell/v1.0')] : ['/usr/bin', '/bin'];
    env.PATH = [...new Set([semgrepIdentity && path.dirname(semgrepIdentity.realpath), path.dirname(pythonPath), ...osDirs].filter(Boolean))].join(path.delimiter); delete env.Path;
    const helper = fileURLToPath(new URL('./local-dependency-tool-process.mjs', import.meta.url));
    const helperHash = sha256(await fs.readFile(helper)); const nodeHash = sha256(await fs.readFile(process.execPath));
    executionIdentity = { python: pythonIdentity, semgrep: semgrepIdentity, helperSha256: helperHash, nodeSha256: nodeHash };
    const spec = { schemaVersion: 1, selectedCapability: binding.selectedCapability, input: binding.input, python: pythonIdentity, semgrep: semgrepIdentity, testOnly: workOrders.get(packet).testOnly, entrypointSha256: source.entrypointSha256, rulesSha256: source.rulesSha256 };
    const specText = JSON.stringify(spec); const specPath = path.join(home, 'tool-spec.json'); await fs.writeFile(specPath, specText, { flag: 'wx' });
    let guarded;
    try { guarded = await runCommandWithIgnoredStdin(process.execPath, [helper, '--spec', specPath, sha256(specText)], { cwd: root, env, timeout: timeoutMs, outputLimitBytes: 8 * 1024 * 1024, signal, label: 'fixed-local-dependency-tool', redact: safeText }); }
    catch (error) { guardFailure = { code: error.code, exitCode: error.exitCode ?? null, stdoutSanitizedSha256: sha256(error.stdout ?? ''), stderr: safeText(error.stderr), stderrSanitizedSha256: sha256(error.stderr ?? '') }; cleanup.ownedProcessGroupCleanupVerified = error.ownedProcessGroupCleanupVerified === true; cleanup.ownedProcessGroupScope = error.ownedProcessGroupScope; throw error; }
    cleanup.ownedProcessGroupCleanupVerified = guarded.ownedProcessGroupCleanupVerified === true; cleanup.ownedProcessGroupScope = guarded.ownedProcessGroupScope;
    assert(cleanup.ownedProcessGroupCleanupVerified, 'owned tool process cleanup not verified');
    const child = JSON.parse(guarded.stdout);
    assert.equal(child.schemaVersion, 'meta-kim-local-tool-child-v1'); assert.equal(child.pythonInvoked, true);
    assert.deepEqual(child.pythonIdentity, pythonIdentity);
    processResult = { status: child.pythonExitCode, stdout: child.stdout, stderr: child.stderr, signal: child.signal, error: child.errorCode, outputLimitExceeded: child.outputLimitExceeded };
    assert.equal(sha256(await fs.readFile(helper)), helperHash, 'fixed helper changed'); assert.equal(sha256(await fs.readFile(process.execPath)), nodeHash, 'Node executable changed');
    assert.equal(sha256(await fs.readFile(pythonPath)), pythonIdentity.sha256, 'Python executable changed');
    if (semgrepIdentity) assert.equal(sha256(await fs.readFile(semgrepIdentity.realpath)), semgrepIdentity.sha256, 'Semgrep executable changed');
    if (semgrepIdentity?.pythonUserBase) assert.equal(sha256(await fs.readFile(semgrepIdentity.pythonUserBase.packageInitPath)), semgrepIdentity.pythonUserBase.packageInitSha256, 'Semgrep runtime bootstrap changed');
    if (processResult.error || processResult.outputLimitExceeded || processResult.signal) throw new Error('local tool process failed, cancelled or exceeded output bound');
    output = validateOutput(JSON.parse(processResult.stdout), processResult.status, root, target, source.rulesSha256);
    assert.deepEqual(await validateSource(binding.selectedCapability), source, 'dependency drift after execution');
    assert.equal(digest(bindingView({ runId, runtime, node, packet })), preparedBindingDigest, 'work-order binding changed during execution');
    after = await snapshot(target); assert.equal(after, before, 'authorized source changed during scan');
    sourceUnmodifiedVerified = true;
    if (!output.completed) { failureClass = `local_tool_${output.status}`; failureMessage = 'Local scanner returned an incomplete result; no completion claim'; }
  } catch (error) { failureClass ??= processResult ? 'local_tool_result_rejected' : 'local_tool_preflight_blocked'; failureMessage = safeText(error.message); }
  finally {
    if (home) { try { assert(path.dirname(home) === path.resolve(os.tmpdir())); await fs.rm(home, { recursive: true, force: true }); cleanup.tempHomeRemoved = true; } catch { cleanup.tempHomeRemoved = false; failureClass ??= 'local_tool_cleanup_failed'; } }
  }
  const result = { status: failureClass ? 'failed' : 'pass', authority: 'local_tool', startedAt, endedAt: new Date().toISOString(), durationMs: Math.max(1, performance.now() - started),
    exitCode: processResult?.status ?? null, outputText: output ? JSON.stringify(output) : null, outputSha256: output ? sha256(JSON.stringify(output)) : null,
    rawOutputSha256: processResult ? sha256(processResult.stdout) : null, failureClass, failureMessage,
    localToolProcessInvoked: Boolean(processResult && !processResult.error), localToolReceipt: null, outcomeStatus: output?.status ?? 'blocked', completed: !failureClass && output?.completed === true,
    nativeInvocationVerified: false, modelInvocationVerified: false, cleanup, sourceUnmodifiedVerified };
  if (receiptRoot) {
    const receipt = { schemaVersion: 1, binding: preparedBinding, source, targetBeforeSha256: before, targetAfterSha256: after,
      stdoutSha256: result.rawOutputSha256, stderrSha256: sha256(processResult?.stderr ?? ''), exitCode: result.exitCode, output, cleanup, guardFailure, executionIdentity, sourceUnmodifiedVerified, failureClass,
      authority: 'local_tool_only', nativeInvocationVerified: false, modelInvocationVerified: false };
    const text = JSON.stringify(receipt, null, 2) + '\n';
    const file = path.join(receiptRoot, 'receipt.json'); await fs.writeFile(file, text, { flag: 'wx' });
    await fs.writeFile(path.join(receiptRoot, 'stderr.sanitized.log'), safeText(processResult?.stderr ?? guardFailure?.stderr), { flag: 'wx' });
    result.localToolReceipt = { path: file, sha256: sha256(text), rawStdoutSha256: result.rawOutputSha256, stderrSha256: sha256(processResult?.stderr ?? ''),
      bindingDigest: preparedBindingDigest, summary: { status: output?.status ?? 'blocked', completed: result.completed, findingsCount: output?.findings.length ?? 0, errorsCount: output?.errors.length ?? 0, networkUsed: output?.networkUsed ?? null, filesModified: sourceUnmodifiedVerified ? false : null } };
    if (processResult && output && sourceUnmodifiedVerified && cleanup.ownedProcessGroupCleanupVerified && cleanup.tempHomeRemoved && workOrders.get(packet)?.testOnly === false && binding.selectedCapability.testOnly !== true && binding.selectedCapability.evidence?.fixture !== true) observations.set(result, { bindingDigest: preparedBindingDigest, resultDigest: digest(result) });
  }
  return result;
}
