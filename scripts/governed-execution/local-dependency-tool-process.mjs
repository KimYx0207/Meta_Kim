import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { checkedPath, componentHash, stableJson, sha256 } from '../dependency-agent-discovery.mjs';

import { LOCAL_DEPENDENCY_TOOL_CONTRACT } from './local-dependency-tool-contract.mjs';
export { LOCAL_DEPENDENCY_TOOL_CONTRACT };

// A fixed child transport inside the existing process-group/Windows Job guard.
// It accepts one hash-bound spec, never executable source or arbitrary argv.
async function main() {
  assert.equal(process.argv.length, 5);
  assert.equal(process.argv[2], '--spec');
  const specPath = path.resolve(process.argv[3]);
  assert.equal(await fs.realpath(specPath), specPath);
  const bytes = await fs.readFile(specPath);
  assert.equal(sha256(bytes), process.argv[4], 'transport spec drift');
  const spec = JSON.parse(bytes);
  assert.equal(spec.schemaVersion, 1);
  const selected = spec.selectedCapability;
  assert.equal(selected.componentId, LOCAL_DEPENDENCY_TOOL_CONTRACT.componentId);
  const root = await fs.realpath(selected.sourceRoot);
  assert.equal(process.platform === 'win32' ? root.toLowerCase() : root, process.platform === 'win32' ? path.resolve(selected.sourceRoot).toLowerCase() : path.resolve(selected.sourceRoot));
  const componentRoot = await checkedPath(root, `skills/${LOCAL_DEPENDENCY_TOOL_CONTRACT.componentId}`, true);
  assert.equal(sha256(await fs.readFile(selected.indexPath)), selected.indexSha256);
  const contract = JSON.parse(await fs.readFile(await checkedPath(componentRoot, 'capability.json'), 'utf8'));
  assert.equal(sha256(stableJson(contract)), selected.contractSha256);
  assert.equal(await componentHash(componentRoot), selected.componentContentSha256);
  const capability = contract.capabilities.find((entry) => entry.id === LOCAL_DEPENDENCY_TOOL_CONTRACT.capabilityId);
  assert.deepEqual(capability, selected.selectedCapability);
  assert.equal(contract.componentVersion, LOCAL_DEPENDENCY_TOOL_CONTRACT.componentVersion);
  assert.deepEqual(capability.invocation, LOCAL_DEPENDENCY_TOOL_CONTRACT.invocation);
  const entrypoint = await checkedPath(componentRoot, LOCAL_DEPENDENCY_TOOL_CONTRACT.invocation.entrypoint);
  assert.equal(sha256(await fs.readFile(entrypoint)), spec.entrypointSha256);
  assert.equal(sha256(await fs.readFile(await checkedPath(componentRoot, LOCAL_DEPENDENCY_TOOL_CONTRACT.rules))), spec.rulesSha256);
  assert(path.isAbsolute(spec.python.realpath));
  assert.equal(await fs.realpath(spec.python.realpath), spec.python.realpath);
  assert.equal(sha256(await fs.readFile(spec.python.realpath)), spec.python.sha256);
  if (spec.semgrep) {
    assert.equal(await fs.realpath(spec.semgrep.realpath), spec.semgrep.realpath);
    assert.equal(sha256(await fs.readFile(spec.semgrep.realpath)), spec.semgrep.sha256);
    assert(/^semgrep(?:\.exe)?$/iu.test(path.basename(spec.semgrep.realpath)));
    if (spec.semgrep.pythonUserBase) {
      const base = spec.semgrep.pythonUserBase;
      const version = /^Python (\d+)\.(\d+)\./u.exec(spec.python.version);
      assert(version && process.platform === 'win32');
      const versionRoot = path.dirname(path.dirname(spec.semgrep.realpath));
      assert.equal(path.basename(versionRoot).toLowerCase(), ('Python' + version[1] + version[2]).toLowerCase());
      assert.equal(await fs.realpath(base.realpath), base.realpath);
      assert.equal(base.realpath, path.dirname(versionRoot));
      assert.equal(base.packageInitPath, path.join(versionRoot, 'site-packages/semgrep/__init__.py'));
      assert.equal(await fs.realpath(base.packageInitPath), base.packageInitPath);
      assert.equal(sha256(await fs.readFile(base.packageInitPath)), base.packageInitSha256);
      assert.equal(process.env.PYTHONUSERBASE, base.realpath);
      const sitePackages = path.dirname(path.dirname(base.packageInitPath));
      const inside = (parent, target) => { const relative = path.relative(parent, target); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)); };
      for (const project of [spec.input.workspaceRoot, selected.sourceRoot]) assert(!inside(project, sitePackages) && !inside(sitePackages, project), 'runtime package path overlaps a project');
    } else assert.equal(process.env.PYTHONUSERBASE, undefined, 'unbound Python user base');
  } else assert.equal(spec.testOnly, true, 'production needs bound Semgrep identity');
  assert.equal(path.basename(spec.python.realpath).toLowerCase().replace(/\.exe$/u, '').replace(/\d(?:\.\d+)?$/u, ''), 'python');
  assert.equal(spec.input.schemaVersion, 1);
  assert.equal(await fs.realpath(spec.input.workspaceRoot), path.resolve(spec.input.workspaceRoot));
  const target = path.resolve(spec.input.workspaceRoot, spec.input.target);
  assert.equal(await fs.realpath(target), target);
  const relative = path.relative(spec.input.workspaceRoot, target);
  assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  assert(spec.input.rules === undefined || spec.input.rules === LOCAL_DEPENDENCY_TOOL_CONTRACT.rules);
  const child = spawn(spec.python.realpath, ['-B', entrypoint, ...LOCAL_DEPENDENCY_TOOL_CONTRACT.invocation.argv], {
    cwd: spec.input.workspaceRoot, env: process.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', exceeded = false;
  for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', (chunk) => {
    if (name === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 4 * 1024 * 1024) { exceeded = true; child.kill(); }
  });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(spec.input) + '\n');
  const outcome = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: null, signal: null, errorCode: error.code ?? 'launch_failed' }));
    child.once('close', (code, signal) => resolve({ code, signal, errorCode: null }));
  });
  process.stdout.write(JSON.stringify({ schemaVersion: 'meta-kim-local-tool-child-v1', pythonInvoked: Boolean(child.pid),
    pythonIdentity: spec.python, pythonExitCode: outcome.code, signal: outcome.signal, errorCode: outcome.errorCode,
    outputLimitExceeded: exceeded, stdout, stderr }) + '\n');
  // Nonzero scanner results are data, not helper failures: the parent checks them.
  if (!child.pid || exceeded || outcome.errorCode || outcome.signal) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  process.stderr.write('Fixed local tool transport preflight failed\n'); process.exitCode = 1;
});
