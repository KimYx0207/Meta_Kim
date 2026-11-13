import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasNpmInstalledDependencies } from '../../src/infrastructure/installer/npm-installed-dependencies.mjs';

test('npm-installed packages accept hoisted dependencies, but checkouts and incomplete installs do not', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kim-npm-owner-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  const write = (dir, value) => { mkdirSync(dir,{recursive:true}); writeFileSync(path.join(dir,'package.json'),JSON.stringify(value)); };
  const manifest = {name:'meta-kim', dependencies:{'@example/sdk':'1.0.0'}};
  const installed = path.join(root,'node_modules','meta-kim');
  const source = path.join(root,'source');
  write(installed,manifest); write(source,manifest);
  assert.equal(hasNpmInstalledDependencies(installed),false);
  write(path.join(root,'node_modules','@example/sdk'),{name:'@example/sdk',version:'1.0.0'});
  assert.equal(hasNpmInstalledDependencies(installed),true);
  assert.equal(hasNpmInstalledDependencies(source),false);
  write(path.join(root,'node_modules','@example/sdk'),{name:'wrong'});
  assert.equal(hasNpmInstalledDependencies(installed),false);
});

test('the public npm package explicitly includes the dependency lifecycle helper', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.files.includes('src/infrastructure/installer/npm-installed-dependencies.mjs'));
});
