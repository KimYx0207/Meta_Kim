import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { releaseDocumentLinks, releaseSection, resolveReleaseTitle, selectPassedRuns, verifyPublished } from '../../.github/scripts/publish-release.mjs';

const sha = 'a'.repeat(40);
const workflow = '.github/workflows/ci.yml';
const passed = { id: 1, head_sha: sha, head_branch: 'main', event: 'push',
  path: workflow, status: 'completed', conclusion: 'success', html_url: 'https://github.com/example/run/1' };

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
