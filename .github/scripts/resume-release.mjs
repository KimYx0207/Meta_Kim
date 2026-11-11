#!/usr/bin/env node
// One reviewed publication recovery. Product source, tag and assets are immutable.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RECOVERY = Object.freeze({
  repository: 'KimYx0207/Meta_Kim',
  branch: 'release-recovery/v3.10.0',
  releaseId: 441245129,
  tag: 'v3.10.0',
  title: 'Meta_Kim 3.10.0',
  version: '3.10.0',
  sourceSha: '185597ba7ee658fa8eb33b7c93152fc437c05818',
  tagObject: 'd19f4eeadd866a29d2e8a570775a06b576d8897f',
  assets: [
    { name: 'meta-kim-3.10.0.tgz', size: 8074069, sha256: '1bacc266d8482a8a8c6c54e0a068d1b8d6129253191a244fe7e15930cd2bb0f7' },
    { name: 'Meta_Kim-3.10.0-source.zip', size: 10819028, sha256: '068a9b7e8cc46269144a4386e999826c6bc55ca9c8f2319e9c38bbcfdf97df51' },
    { name: 'package-check.json', size: 398, sha256: 'c01b7a31aecf788587c0c0de6168254a2f233d276085b13d2028712fa832c9aa' },
    { name: 'SHA256SUMS.txt', size: 434, sha256: 'b01fbb4bedd01a6aad7f5c4c1ca713bfa84f2ae6e69062d3e50bad7251dcad44' },
    { name: 'SOURCE-REVISION.txt', size: 121, sha256: '3e62acb266a09927fe7266c41d27bff47b457e17f711173f20d3bac8cb28b9e5' },
    { name: 'verification.json', size: 1171, sha256: 'a3ddc62df004e4aa09681bf41bd5985ebede6dc2f583fe1e4b03d6e2320bf817' },
  ],
});

const maintenanceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const run = (file, args, cwd, input) => execFileSync(file, args, {
  cwd, input, timeout: 120000, maxBuffer: 32 * 1024 * 1024,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const git = (cwd, ...args) => run('git', args, cwd).toString('utf8').trim();
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const api = endpoint => JSON.parse(run('gh', ['api', endpoint], maintenanceRoot).toString('utf8'));
const assetPath = (output, name) => path.join(output, 'assets', name);

export function verifyReleaseSnapshot(release, request = RECOVERY) {
  assert.equal(release.id, request.releaseId, 'Unexpected release ID');
  assert.equal(release.tag_name, request.tag, 'Unexpected release tag');
  assert.equal(release.name, request.title, 'Unexpected release title');
  assert.equal(release.prerelease, false, 'Unexpected prerelease state');
  assert.equal(typeof release.draft, 'boolean', 'Missing publication state');
  assert.deepEqual(release.assets.map(item => item.name).sort(),
    request.assets.map(item => item.name).sort(), 'Release asset set changed');
  for (const expected of request.assets) {
    const actual = release.assets.find(item => item.name === expected.name);
    assert.equal(actual.state, 'uploaded', `Incomplete upload: ${expected.name}`);
    assert.equal(actual.size, expected.size, `Asset size changed: ${expected.name}`);
    assert.equal(actual.digest, `sha256:${expected.sha256}`, `Asset digest changed: ${expected.name}`);
    assert(Number.isSafeInteger(actual.id) && actual.id > 0, 'Invalid asset ID');
  }
}

export function verifyPreparedEvidence(record, packageCheck, { tree, runs }, request = RECOVERY) {
  assert.equal(record.repository, request.repository, 'Prepared repository differs');
  assert.equal(record.tag, request.tag, 'Prepared tag differs');
  assert.equal(record.version, request.version, 'Prepared version differs');
  assert.equal(record.commit, request.sourceSha, 'Prepared source commit differs');
  assert.equal(record.tree, tree, 'Prepared source tree differs');
  assert.deepEqual(record.workflows, runs, 'Prepared CI is not the current passing exact-source CI');
  assert.equal(packageCheck.status, 'passed', 'Original package check failed');
  assert.equal(packageCheck.package, 'meta-kim', 'Unexpected package name');
  assert.equal(packageCheck.version, request.version, 'Package version differs');
  assert.equal(packageCheck.archiveSha256, request.assets.find(item => item.name.endsWith('.tgz')).sha256,
    'Original package check belongs to another archive');
  assert(packageCheck.sourceFilesCompared > 0, 'Original package source comparison missing');
}

export function verifyLocalAssets(output, request = RECOVERY) {
  assert.deepEqual(fs.readdirSync(path.join(output, 'assets')).sort(),
    request.assets.map(item => item.name).sort(), 'Downloaded asset set differs');
  for (const expected of request.assets) {
    const file = assetPath(output, expected.name);
    assert(fs.lstatSync(file).isFile(), `Asset is not an ordinary file: ${expected.name}`);
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.length, expected.size, `Downloaded size differs: ${expected.name}`);
    assert.equal(digest(bytes), expected.sha256, `Downloaded bytes differ: ${expected.name}`);
  }
  const expectedSums = request.assets.filter(item => item.name !== 'SHA256SUMS.txt')
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .map(item => `${item.sha256}  ${item.name}\n`).join('');
  assert.equal(fs.readFileSync(assetPath(output, 'SHA256SUMS.txt'), 'utf8'), expectedSums,
    'Checksum file does not cover every original asset');
}

async function checkedContext(sourceRoot, output) {
  assert.equal(process.env.GITHUB_REPOSITORY, RECOVERY.repository, 'Wrong publication repository');
  assert.equal(process.env.GITHUB_EVENT_NAME, 'create', 'Recovery requires the reviewed branch creation');
  assert.equal(process.env.GITHUB_REF, `refs/heads/${RECOVERY.branch}`, 'Wrong recovery branch');
  assert(path.isAbsolute(sourceRoot) && path.isAbsolute(output), 'Use absolute source and output paths');
  sourceRoot = fs.realpathSync(sourceRoot);
  assert(sourceRoot !== maintenanceRoot && !sourceRoot.startsWith(maintenanceRoot + path.sep),
    'Product source must be a separate checkout');
  assert(!output.startsWith(sourceRoot + path.sep) && output !== sourceRoot &&
    !output.startsWith(maintenanceRoot + path.sep) && output !== maintenanceRoot,
  'Recovery output must remain outside both source checkouts');
  assert.equal(git(maintenanceRoot, 'rev-parse', 'HEAD'), process.env.GITHUB_SHA,
    'Maintenance checkout differs from the triggering commit');
  assert.equal(git(maintenanceRoot, 'status', '--porcelain=v1', '--untracked-files=all'), '',
    'Maintenance source must be clean');
  const allowedMaintenance = new Set([
    '.github/scripts/publish-release.mjs', 'tests/setup/github-release.test.mjs',
    '.github/scripts/resume-release.mjs', '.github/workflows/release-recovery.yml',
    'tests/setup/release-recovery.test.mjs',
  ]);
  const changed = git(maintenanceRoot, 'diff', '--name-only', RECOVERY.sourceSha, 'HEAD').split('\n').filter(Boolean);
  assert(changed.length > 0 && changed.every(file => allowedMaintenance.has(file)),
    'Recovery commit must contain only the reviewed publication maintenance files');
  assert.equal(git(sourceRoot, 'rev-parse', 'HEAD'), RECOVERY.sourceSha, 'Product source commit differs');
  assert.equal(git(sourceRoot, 'status', '--porcelain=v1', '--untracked-files=all'), '',
    'Product source must remain clean');
  git(sourceRoot, 'merge-base', '--is-ancestor', RECOVERY.sourceSha, 'origin/main');
  assert.equal(git(sourceRoot, 'rev-parse', `refs/tags/${RECOVERY.tag}`), RECOVERY.tagObject,
    'The original annotated tag object changed');
  assert.equal(git(sourceRoot, 'rev-parse', `refs/tags/${RECOVERY.tag}^{commit}`), RECOVERY.sourceSha,
    'Release tag points to another source');
  const remoteTag = api(`repos/${RECOVERY.repository}/git/ref/tags/${RECOVERY.tag}`);
  assert.equal(remoteTag.object.sha, RECOVERY.tagObject, 'Remote release tag changed');
  const sourceConfig = readJson(path.join(sourceRoot, '.github/release.json'));
  assert.equal(sourceConfig.repository, RECOVERY.repository, 'Source publication repository differs');
  const sourceVersion = readJson(path.join(sourceRoot, 'package.json')).version;
  assert.equal(sourceVersion, RECOVERY.version, 'Source version differs');
  assert.equal(sourceConfig.tagPrefix + sourceVersion, RECOVERY.tag, 'Source tag policy differs');
  const original = await import(pathToFileURL(path.join(sourceRoot, '.github/scripts/publish-release.mjs')).href);
  assert.equal(original.resolveReleaseTitle({ ...sourceConfig, version: sourceVersion }), RECOVERY.title);
  const response = api(`repos/${RECOVERY.repository}/actions/runs?head_sha=${RECOVERY.sourceSha}&per_page=100`);
  const runs = original.selectPassedRuns(response.workflow_runs, RECOVERY.sourceSha, sourceConfig.workflows);
  const release = api(`repos/${RECOVERY.repository}/releases/${RECOVERY.releaseId}`);
  verifyReleaseSnapshot(release);
  original.verifyPublished(release, RECOVERY.assets, { tag: RECOVERY.tag, releaseTitle: RECOVERY.title });
  return { sourceRoot, tree: git(sourceRoot, 'rev-parse', 'HEAD^{tree}'), runs, release };
}

function checkedDownloadedEvidence(output, context) {
  verifyLocalAssets(output);
  verifyPreparedEvidence(readJson(assetPath(output, 'verification.json')),
    readJson(assetPath(output, 'package-check.json')), context);
  assert.equal(fs.readFileSync(assetPath(output, 'SOURCE-REVISION.txt'), 'utf8'),
    `${RECOVERY.repository}\n${RECOVERY.tag}\ncommit ${RECOVERY.sourceSha}\ntree ${context.tree}\n`);
  const expectedArchive = RECOVERY.assets.find(item => item.name.endsWith('-source.zip'));
  const sourceArchive = run('git', ['archive', '--format=zip', `--prefix=Meta_Kim-${RECOVERY.version}/`, 'HEAD'], context.sourceRoot);
  assert.equal(digest(sourceArchive), expectedArchive.sha256, 'Original source archive differs from exact Git source');
}

export async function main(args = process.argv.slice(2)) {
  const [mode, sourceRoot, output] = args;
  assert(['prepare', 'publish'].includes(mode) && sourceRoot && output && args.length === 3,
    'Usage: resume-release.mjs prepare|publish /absolute/source /absolute/output');
  const context = await checkedContext(sourceRoot, output);
  if (mode === 'prepare') {
    fs.mkdirSync(path.join(output, 'assets'), { recursive: true });
    for (const asset of context.release.assets) {
      const bytes = run('gh', ['api', `repos/${RECOVERY.repository}/releases/assets/${asset.id}`,
        '-H', 'Accept: application/octet-stream'], maintenanceRoot);
      fs.writeFileSync(assetPath(output, asset.name), bytes);
    }
    checkedDownloadedEvidence(output, context);
    const ci = context.runs.find(item => item.workflow === '.github/workflows/ci.yml');
    assert(ci, 'Exact-source package CI missing');
    const ciDirectory = path.join(output, 'ci-package');
    run('gh', ['run', 'download', String(ci.id), '--repo', RECOVERY.repository,
      '--name', `meta-kim-${RECOVERY.sourceSha}`, '--dir', ciDirectory], maintenanceRoot);
    const expected = RECOVERY.assets.find(item => item.name.endsWith('.tgz'));
    assert.equal(digest(fs.readFileSync(path.join(ciDirectory, expected.name))), expected.sha256,
      'Draft archive differs from the package produced by passing main CI');
    fs.writeFileSync(path.join(output, 'recovery-context.json'), json({
      schemaVersion: 1, sourceSha: RECOVERY.sourceSha, sourceTree: context.tree,
      maintenanceSha: process.env.GITHUB_SHA, releaseId: RECOVERY.releaseId,
      tag: RECOVERY.tag, workflows: context.runs, packageSha256: expected.sha256,
    }));
    console.log(json({ status: 'prepared', sourceSha: RECOVERY.sourceSha, releaseId: RECOVERY.releaseId }));
    return;
  }
  checkedDownloadedEvidence(output, context);
  const prepared = readJson(path.join(output, 'recovery-context.json'));
  assert.equal(prepared.sourceSha, RECOVERY.sourceSha);
  assert.equal(prepared.sourceTree, context.tree);
  assert.equal(prepared.maintenanceSha, process.env.GITHUB_SHA);
  assert.equal(prepared.releaseId, RECOVERY.releaseId);
  assert.deepEqual(prepared.workflows, context.runs);
  // The original checker has just installed and checked the same archive in a
  // token-free step. Its deterministic result must equal the original report.
  assert(fs.readFileSync(path.join(output, 'package-check-rechecked.json'))
    .equals(fs.readFileSync(assetPath(output, 'package-check.json'))),
  'Fresh installation and source comparison did not reproduce the original package check');
  const beforeBody = context.release.body;
  if (context.release.draft) {
    // The only remote write in this recovery: publish the existing, verified ID.
    run('gh', ['api', `repos/${RECOVERY.repository}/releases/${RECOVERY.releaseId}`,
      '--method', 'PATCH', '--input', '-'], maintenanceRoot,
    json({ draft: false, make_latest: 'true' }));
  }
  const published = api(`repos/${RECOVERY.repository}/releases/${RECOVERY.releaseId}`);
  verifyReleaseSnapshot(published);
  assert.equal(published.draft, false, 'Release remains a draft');
  assert.equal(published.body, beforeBody, 'Recovery changed the existing release notes');
  const tag = api(`repos/${RECOVERY.repository}/git/ref/tags/${RECOVERY.tag}`);
  assert.equal(tag.object.sha, RECOVERY.tagObject, 'Recovery changed the release tag');
  const record = { ...prepared, status: 'published', url: published.html_url,
    recoveryRun: `${process.env.GITHUB_SERVER_URL}/${RECOVERY.repository}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    assets: RECOVERY.assets };
  fs.writeFileSync(path.join(output, 'publication-recovery.json'), json(record));
  // Keep the source/maintenance provenance in the durable Actions log without
  // adding or replacing any release asset.
  console.log(json(record));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
