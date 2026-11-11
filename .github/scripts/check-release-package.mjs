#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const [archive, installed, report] = process.argv.slice(2);
assert(archive && installed && report, 'Expected archive, installed package and report paths');
const source = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
assert.equal(manifest.name, source.name);
assert.equal(manifest.version, source.version);
const cli = path.join(installed, 'bin/meta-kim.mjs');
const version = execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8', timeout: 15000 }).trim();
assert.equal(version, source.version);
const help = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8', timeout: 15000 });
assert(help.includes('meta-kim dsh'));
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
let sourceFiles = 0;
for (const relative of tracked) {
  const file = path.join(installed, relative);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
  assert(fs.readFileSync(file).equals(fs.readFileSync(relative)), `Packaged source differs: ${relative}`);
  sourceFiles++;
}
for (const relative of ['canonical/skills/meta-theory/SKILL.md',
  'canonical/runtime-assets/claude/hooks/enforce-agent-dispatch.mjs',
  'canonical/runtime-assets/shared/hooks/task-progress.mjs',
  'src/runtimes/deepseek-harness/candidate-adapter.mjs']) {
  assert(fs.existsSync(path.join(installed, relative)), `Package missing ${relative}`);
}
const record = { schemaVersion: 1, package: source.name, version, status: 'passed',
  archiveSha256: createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
  sourceFilesCompared: sourceFiles,
  checks: ['npm installation of downloadable archive', 'CLI version', 'CLI help',
    'packaged Git source equality', 'required runtime files'], modelCalls: 0 };
fs.writeFileSync(report, JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify(record));
