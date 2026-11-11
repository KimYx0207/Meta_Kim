import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { RECOVERY, verifyLocalAssets, verifyPreparedEvidence, verifyReleaseSnapshot } from '../../.github/scripts/resume-release.mjs';

const release = () => ({ id: RECOVERY.releaseId, tag_name: RECOVERY.tag,
  name: RECOVERY.title, draft: true, prerelease: false,
  assets: RECOVERY.assets.map((item, index) => ({ id: index + 1, name: item.name,
    state: 'uploaded', size: item.size, digest: `sha256:${item.sha256}` })) });

test('recovery accepts the exact draft and published result, rejecting changed identity or assets', () => {
  assert.doesNotThrow(() => verifyReleaseSnapshot(release()));
  assert.doesNotThrow(() => verifyReleaseSnapshot({ ...release(), draft: false }));
  for (const change of [{ id: 1 }, { tag_name: 'v3.10.1' }, { name: 'Other' },
    { prerelease: true }, { draft: undefined }, { assets: release().assets.slice(1) }]) {
    assert.throws(() => verifyReleaseSnapshot({ ...release(), ...change }));
  }
  for (const change of [{ size: 1 }, { digest: `sha256:${'0'.repeat(64)}` }, { state: 'new' }, { id: -1 }]) {
    const changed = release(); Object.assign(changed.assets[0], change);
    assert.throws(() => verifyReleaseSnapshot(changed));
  }
});

test('recovery evidence stays bound to original source, tree, exact CI and installed archive', () => {
  const context = { tree: 'a'.repeat(40), runs: [{ id: 42, commit: RECOVERY.sourceSha, conclusion: 'success' }] };
  const record = { repository: RECOVERY.repository, tag: RECOVERY.tag,
    version: RECOVERY.version, commit: RECOVERY.sourceSha, tree: context.tree, workflows: context.runs };
  const checked = { package: 'meta-kim', version: RECOVERY.version, status: 'passed',
    archiveSha256: RECOVERY.assets[0].sha256, sourceFilesCompared: 100 };
  assert.doesNotThrow(() => verifyPreparedEvidence(record, checked, context));
  for (const change of [{ commit: 'b'.repeat(40) }, { tree: 'b'.repeat(40) },
    { workflows: [] }, { tag: 'v3.10.1' }, { repository: 'other/repo' }]) {
    assert.throws(() => verifyPreparedEvidence({ ...record, ...change }, checked, context));
  }
  for (const change of [{ status: 'failed' }, { archiveSha256: '0'.repeat(64) },
    { sourceFilesCompared: 0 }, { version: '3.10.1' }]) {
    assert.throws(() => verifyPreparedEvidence(record, { ...checked, ...change }, context));
  }
});

test('download verification hashes the actual bytes and rejects extras and incorrect checksums', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'assets'));
  const bytes = Buffer.from('reviewed package bytes');
  const hash = value => createHash('sha256').update(value).digest('hex');
  const sums = Buffer.from(`${hash(bytes)}  package.tgz\n`);
  const request = { assets: [{ name: 'package.tgz', size: bytes.length, sha256: hash(bytes) },
    { name: 'SHA256SUMS.txt', size: sums.length, sha256: hash(sums) }] };
  fs.writeFileSync(path.join(root, 'assets/package.tgz'), bytes);
  fs.writeFileSync(path.join(root, 'assets/SHA256SUMS.txt'), sums);
  assert.doesNotThrow(() => verifyLocalAssets(root, request));
  fs.writeFileSync(path.join(root, 'assets/package.tgz'), Buffer.from('unreviewed package byte'));
  assert.throws(() => verifyLocalAssets(root, request));
  fs.writeFileSync(path.join(root, 'assets/package.tgz'), bytes);
  fs.writeFileSync(path.join(root, 'assets/extra.json'), '{}');
  assert.throws(() => verifyLocalAssets(root, request));
  fs.unlinkSync(path.join(root, 'assets/extra.json'));
  const wrongSums = Buffer.from(`${hash(bytes)}  other.tgz\n`);
  fs.writeFileSync(path.join(root, 'assets/SHA256SUMS.txt'), wrongSums);
  assert.throws(() => verifyLocalAssets(root, { assets: [request.assets[0],
    { name: 'SHA256SUMS.txt', size: wrongSums.length, sha256: hash(wrongSums) }] }), /Checksum file/);
});
