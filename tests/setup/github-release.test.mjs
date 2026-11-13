import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { publishReleaseAssets, releaseDocumentLinks, releaseSection, resolveReleaseTitle, selectPassedRuns, validateReleaseInvocation, verifyPublished } from '../../.github/scripts/publish-release.mjs';

const sha = 'a'.repeat(40);
const workflow = '.github/workflows/ci.yml';
const passed = { id: 1, head_sha: sha, head_branch: 'main', event: 'push',
  path: workflow, status: 'completed', conclusion: 'success', html_url: 'https://github.com/example/run/1' };

test('manual main publication binds the request, checkout and current main to one commit', () => {
  const request = { tag: 'v3.12.0', refName: 'main', eventName: 'workflow_dispatch',
    sourceSha: sha, requestedSha: sha, mainSha: sha, remoteMainSha: sha };
  assert.equal(validateReleaseInvocation(request), 'main_dispatch');
  assert.throws(() => validateReleaseInvocation({ ...request, eventName: 'push' }), /explicit workflow dispatch/u);
  assert.throws(() => validateReleaseInvocation({ ...request, requestedSha: 'b'.repeat(40) }), /requested release/u);
  assert.throws(() => validateReleaseInvocation({ ...request, mainSha: 'b'.repeat(40) }), /exact current main commit/u);
  assert.throws(() => validateReleaseInvocation({ ...request, refName: 'candidate' }), /exact release/u);
});

test('a stale main dispatch cannot rely on checkout resetting origin/main to its event SHA', () => {
  const request = { tag: 'v3.12.0', refName: 'main', eventName: 'workflow_dispatch',
    sourceSha: sha, requestedSha: sha, mainSha: sha, remoteMainSha: 'b'.repeat(40) };
  assert.throws(() => validateReleaseInvocation(request), /exact current remote main commit/u);
  for (const unavailable of [undefined, null, '']) {
    assert.throws(() => validateReleaseInvocation({ ...request, remoteMainSha: unavailable }), /exact current remote main commit/u);
  }
});

test('legacy release refs keep exact version binding without admitting ordinary push events', () => {
  const request = { tag: 'v3.12.0', refName: 'release/v3.12.0', eventName: 'create',
    sourceSha: sha, requestedSha: sha, mainSha: 'b'.repeat(40) };
  assert.equal(validateReleaseInvocation(request), 'release_ref');
  assert.equal(validateReleaseInvocation({ ...request, eventName: 'workflow_dispatch' }), 'release_ref');
  assert.throws(() => validateReleaseInvocation({ ...request, refName: 'release/v3.11.0' }), /exact release/u);
  assert.throws(() => validateReleaseInvocation({ ...request, eventName: 'push' }), /Unsupported release request event/u);
});

test('release titles follow the repository rule without changing the default format', () => {
  assert.equal(resolveReleaseTitle({ title: 'Kim_Service', version: 'V1.11', releaseTitleEqualsVersion: true }), 'V1.11');
  assert.equal(resolveReleaseTitle({ title: 'Meta_Kim', version: '3.10.0' }), 'Meta_Kim 3.10.0');
});

test('published release verification checks the title as well as the tag', () => {
  const config = { tag: 'V1.11', releaseTitle: 'V1.11' };
  const release = { tag_name: 'V1.11', name: 'V1.11', assets: [] };
  assert.doesNotThrow(() => verifyPublished(release, [], config));
  assert.throws(() => verifyPublished({ ...release, name: 'Kim_Service V1.11' }, [], config), /release title differs/u);
});

test('Meta_Kim publication retains its configured project and version title', () => {
  const config = JSON.parse(fs.readFileSync(new URL('../../.github/release.json', import.meta.url), 'utf8'));
  const { version } = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(resolveReleaseTitle({ ...config, version }), `Meta_Kim ${version}`);
});

test('publication requires a successful run for the exact merged source', () => {
  assert.equal(selectPassedRuns([passed], sha, [workflow])[0].commit, sha);
  for (const difference of [{ head_sha: 'b'.repeat(40) }, { head_branch: 'candidate' },
    { event: 'pull_request' }, { status: 'in_progress' }, { conclusion: 'failure' }]) {
    assert.throws(() => selectPassedRuns([{ ...passed, ...difference }], sha, [workflow]));
  }
});

test('a newer failed rerun cannot be hidden by an old passing run', () => {
  assert.throws(() => selectPassedRuns([passed, { ...passed, id: 2, conclusion: 'failure' }], sha, [workflow]));
  assert.throws(() => selectPassedRuns([passed], sha, [workflow, '.github/workflows/other.yml']));
});

test('release notes select the exact version and preserve localized text', () => {
  const changelog = '# 更新日志\n\n## [3.10.0] - 2026-11-11\n\n### 変更\n\n本文。\n\n## [3.1.0] - 2026-01-01\n\n旧版';
  assert.equal(releaseSection(changelog, '3.10.0'), '### 変更\n\n本文。');
  assert.throws(() => releaseSection(changelog, '3.10'));
  assert.equal(releaseSection('## V1.11 - 2026-11-11\n\nActual delivery\n', 'V1.11'), 'Actual delivery');
});

test('release links and images resolve against the exact tag, keeping external URLs and anchors', () => {
  const context = { repository: 'owner/project', tag: 'v3.10.0', sourceFile: 'CHANGELOG.zh-CN.md' };
  const markdown = '[记录](docs/record.md#results)\n![説明図](docs/images/flow.svg)\n' +
    '[旧版](CHANGELOG.md#v110)\n[外部](https://example.com/docs/a)\n[本页](#results)';
  assert.equal(releaseDocumentLinks(markdown, context),
    '[记录](https://github.com/owner/project/blob/v3.10.0/docs/record.md#results)\n' +
    '![説明図](https://github.com/owner/project/blob/v3.10.0/docs/images/flow.svg)\n' +
    '[旧版](https://github.com/owner/project/blob/v3.10.0/CHANGELOG.md#v110)\n' +
    '[外部](https://example.com/docs/a)\n[本页](#results)');
});

test('release links respect document directories and preserve literal code samples', () => {
  const context = { repository: 'owner/project', tag: 'V1.11', sourceFile: 'docs/releases/CHANGELOG.md' };
  const markdown = '[guide](../guide.md "Guide")\n[spaced](<../guide notes.md>)\n' +
    '`[example](docs/example.md)`\n```md\n[example](docs/example.md)\n```\n' +
    '~~~md\n![example](docs/image.svg)\n~~~\n[contact](mailto:maintainer@example.com)';
  const result = releaseDocumentLinks(markdown, context);
  assert.ok(result.startsWith('[guide](https://github.com/owner/project/blob/V1.11/docs/guide.md "Guide")\n' +
    '[spaced](<https://github.com/owner/project/blob/V1.11/docs/guide notes.md>)'));
  assert.ok(result.includes('`[example](docs/example.md)`'));
  assert.ok(result.includes('```md\n[example](docs/example.md)\n```'));
  assert.ok(result.includes('~~~md\n![example](docs/image.svg)\n~~~'));
  assert.ok(result.endsWith('[contact](mailto:maintainer@example.com)'));
});

// Model the documented GitHub API, including the published-only tag endpoint,
// while exercising the production upload / verify / publish flow end to end.
function releaseRemote(t, { existing = null, olderReleases = 0, corruptUpload = false } = {}) {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'github-release-flow-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const config = { repository: 'owner/project', tag: 'v3.10.0', sha,
    releaseTitle: 'Meta_Kim 3.10.0' };
  const bytes = Buffer.from('the package bytes already checked by the release gate');
  const file = path.join(output, 'meta-kim-3.10.0.tgz');
  fs.writeFileSync(file, bytes);
  fs.writeFileSync(path.join(output, 'release-notes.md'), 'Verified release notes.\n');
  const assets = [{ name: path.basename(file), file, size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') }];
  const remoteAsset = { name: assets[0].name, size: assets[0].size,
    digest: `sha256:${assets[0].sha256}` };
  const releases = Array.from({ length: olderReleases }, (_, index) => ({
    id: index + 1, tag_name: `v0.0.${index}`, draft: false, assets: [],
  }));
  if (existing) releases.push({ id: 441245129, tag_name: config.tag,
    name: config.releaseTitle, draft: existing === 'draft',
    assets: existing === 'published' ? [remoteAsset] : [],
    html_url: `https://github.com/${config.repository}/releases/tag/${config.tag}` });
  const reads = [];
  const writes = [];
  const endpoint = `repos/${config.repository}/releases`;
  const current = () => releases.find(release => release.tag_name === config.tag);
  const missing = () => { throw Object.assign(new Error('Not Found'), { stderr: 'gh: Not Found (HTTP 404)' }); };
  const request = (url, body) => {
    if (body) {
      assert.equal(url, endpoint);
      assert.equal(body.draft, true);
      assert.equal(body.target_commitish, sha);
      assert.equal(body.body, 'Verified release notes.\n');
      assert.equal(current(), undefined, 'an interrupted draft must be reused');
      const release = { id: 441245129, ...body, assets: [],
        html_url: `https://github.com/${config.repository}/releases/tag/${config.tag}` };
      releases.push(release);
      writes.push('create');
      return structuredClone(release);
    }
    reads.push(url);
    if (url === `${endpoint}/tags/${config.tag}`) {
      const release = current();
      return release && !release.draft ? structuredClone(release) : missing();
    }
    if (url.startsWith(`${endpoint}?`)) {
      const page = Number(new URL(url, 'https://api.github.com/').searchParams.get('page'));
      return structuredClone(releases.slice((page - 1) * 100, page * 100));
    }
    if (url === `${endpoint}/441245129` && current()) return structuredClone(current());
    return missing();
  };
  const run = (program, args) => {
    assert.equal(program, 'gh');
    assert.equal(args[0], 'release');
    assert.equal(args[2], config.tag);
    assert.equal(args[args.indexOf('--repo') + 1], config.repository);
    const release = current();
    assert.ok(release, 'CLI operation needs an existing release');
    if (args[1] === 'upload') {
      const uploaded = fs.readFileSync(args[3]);
      release.assets = [{ name: path.basename(args[3]), size: uploaded.length,
        digest: `sha256:${corruptUpload ? '0'.repeat(64) : createHash('sha256').update(uploaded).digest('hex')}` }];
      writes.push('upload');
    } else {
      assert.equal(args[1], 'edit');
      release.name = args[args.indexOf('--title') + 1];
      if (args.includes('--draft=false')) {
        release.draft = false;
        writes.push('publish');
      } else writes.push('edit-draft');
    }
  };
  return { config, assets, output, request, run, current, reads, writes,
    publish: () => publishReleaseAssets(config, assets, output, { request, run }) };
}

test('a new draft uploads and publishes even though the tag endpoint cannot read drafts', t => {
  const remote = releaseRemote(t);
  assert.equal(remote.publish().status, 'published');
  assert.equal(remote.current().draft, false);
  assert.deepEqual(remote.writes, ['create', 'upload', 'publish']);
  assert.equal(remote.reads.filter(url => url.endsWith('/441245129')).length, 2);
});

test('an interrupted draft beyond the first page is reused and a later published retry is read-only', t => {
  const remote = releaseRemote(t, { existing: 'draft', olderReleases: 100 });
  assert.equal(remote.publish().status, 'published');
  assert.ok(remote.reads.some(url => url.endsWith('page=2')));
  assert.equal(remote.current().id, 441245129);
  assert.deepEqual(remote.writes, ['edit-draft', 'upload', 'publish']);
  const written = [...remote.writes];
  assert.equal(remote.publish().status, 'already_published');
  assert.deepEqual(remote.writes, written);
});

test('already-published assets are verified and a mismatch never triggers an upload', t => {
  const remote = releaseRemote(t, { existing: 'published' });
  assert.equal(remote.publish().status, 'already_published');
  remote.current().assets[0].digest = `sha256:${'0'.repeat(64)}`;
  assert.throws(remote.publish, /Published asset differs/u);
  assert.deepEqual(remote.writes, []);
});

test('an uploaded digest mismatch leaves the draft unpublished', t => {
  const remote = releaseRemote(t, { existing: 'draft', corruptUpload: true });
  assert.throws(remote.publish, /Published asset differs/u);
  assert.equal(remote.current().draft, true);
  assert.ok(!remote.writes.includes('publish'));
});

test('release lookup permissions errors are not treated as a missing release', t => {
  const remote = releaseRemote(t);
  const denied = Object.assign(new Error('Forbidden'), { stderr: 'gh: Forbidden (HTTP 403)' });
  assert.throws(() => publishReleaseAssets(remote.config, remote.assets, remote.output, {
    request: () => { throw denied; }, run: remote.run,
  }), error => error === denied);
  assert.deepEqual(remote.writes, []);
});
