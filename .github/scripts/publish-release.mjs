#!/usr/bin/env node
// Maintainer-only GitHub publication. Product execution never imports this file.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const command = (file, args, input) => execFileSync(file, args, {
  cwd: root, encoding: 'utf8', input, timeout: 120000,
  maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
}).trim();
const api = (endpoint, body) => JSON.parse(command('gh', [
  'api', endpoint, ...(body ? ['--method', 'POST', '--input', '-'] : []),
], body ? json(body) : undefined));

export function selectPassedRuns(runs, sha, workflowPaths) {
  assert(/^[a-f0-9]{40}$/.test(sha), 'Expected an exact source commit');
  return workflowPaths.map(workflow => {
    const candidates = runs.filter(run => run.head_sha === sha &&
      run.head_branch === 'main' && run.event === 'push' &&
      run.path === workflow).sort((a, b) => b.id - a.id);
    const latest = candidates[0];
    assert(latest?.status === 'completed' && latest.conclusion === 'success',
      `The latest main run for ${workflow} has not passed for ${sha}`);
    return { id: latest.id, workflow, url: latest.html_url,
      commit: sha, conclusion: latest.conclusion };
  });
}

export function releaseSection(markdown, version) {
  const lines = markdown.split(/\r?\n/u);
  const headings = lines.map((text, index) => ({ text, index }))
    .filter(({ text }) => /^## /u.test(text));
  const match = headings.find(({ text }) =>
    text.startsWith(`## [${version}] - `) || text.startsWith(`## ${version} - `));
  assert(match, `Missing dated changelog section ${version}`);
  const end = headings.find(({ index }) => index > match.index)?.index ?? lines.length;
  const section = lines.slice(match.index + 1, end).join('\n').trim();
  assert(section, `Empty changelog section ${version}`);
  return section;
}

// A release page is not the source document's directory. Bind relative links
// and image targets to this release's immutable tag while preserving examples.
export function releaseDocumentLinks(markdown, { repository, tag, sourceFile }) {
  const base = `https://github.com/${repository}/blob/${encodeURIComponent(tag)}/`;
  const directory = path.posix.dirname(sourceFile);
  const resolveTarget = value => {
    const wrapped = value.startsWith('<') && value.endsWith('>');
    const target = wrapped ? value.slice(1, -1) : value;
    if (/^(?:#|\/|[a-z][a-z\d+.-]*:)/iu.test(target)) return value;
    const [, file, suffix] = /^([^?#]+)(.*)$/u.exec(target);
    const resolved = base + path.posix.normalize(path.posix.join(directory, file)) + suffix;
    return wrapped ? `<${resolved}>` : resolved;
  };
  let fence = null;
  return markdown.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker && !fence) { fence = marker; return line; }
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length &&
          line.slice(line.indexOf(marker) + marker.length).trim() === '') fence = null;
      return line;
    }
    return line.replace(/(`+)(.*?)\1|(\]\()(<[^>]+>|[^\s)]+)(?=\s|\))/gu,
      (match, codeDelimiter, _code, prefix, target) =>
        codeDelimiter ? match : prefix + resolveTarget(target));
  }).join('\n');
}

export function resolveReleaseTitle(config) {
  return config.releaseTitleEqualsVersion === true
    ? config.version : `${config.title} ${config.version}`;
}

function configuration() {
  const config = JSON.parse(fs.readFileSync(path.join(root, '.github/release.json'), 'utf8'));
  const version = config.versionFile.endsWith('.json')
    ? JSON.parse(fs.readFileSync(path.join(root, config.versionFile), 'utf8')).version
    : fs.readFileSync(path.join(root, config.versionFile), 'utf8').trim();
  assert(config.repository === process.env.GITHUB_REPOSITORY, 'Publication repository mismatch');
  assert(/^(?:\d+\.\d+\.\d+|V\d+\.\d+)$/u.test(version), 'Invalid release version');
  const tag = config.tagPrefix + version;
  assert(process.env.GITHUB_REF_NAME === `release/${tag}`, 'Use the exact release/<version> branch');
  const sha = command('git', ['rev-parse', 'HEAD']);
  assert.equal(sha, process.env.GITHUB_SHA, 'Checked-out source differs from the requested release');
  command('git', ['merge-base', '--is-ancestor', sha, 'origin/main']);
  assert.equal(command('git', ['status', '--porcelain=v1', '--untracked-files=all']), '', 'Release source must be clean');
  return { ...config, version, tag, sha, releaseTitle: resolveReleaseTitle({ ...config, version }),
    tree: command('git', ['rev-parse', 'HEAD^{tree}']) };
}

function evidence(config) {
  const result = api(`repos/${config.repository}/actions/runs?head_sha=${config.sha}&per_page=100`);
  return selectPassedRuns(result.workflow_runs, config.sha, config.workflows);
}

function optionalApi(endpoint, request = api) {
  try { return request(endpoint); }
  catch (error) {
    if (/HTTP 404/u.test(String(error.stderr))) return null;
    throw error;
  }
}

function peelTag(repository, ref) {
  let object = ref.object;
  for (let depth = 0; object.type === 'tag' && depth < 4; depth++) {
    object = api(`repos/${repository}/git/tags/${object.sha}`).object;
  }
  assert.equal(object.type, 'commit', 'Release tag does not resolve to a commit');
  return object.sha;
}

function assetsIn(directory) {
  return fs.readdirSync(directory).filter(name => /\.(?:tgz|zip|json|txt)$/u.test(name))
    .sort().map(name => {
      assert(/^[A-Za-z0-9._-]+$/u.test(name), 'Unsupported release asset name');
      const file = path.join(directory, name);
      assert(fs.lstatSync(file).isFile(), 'Release assets must be ordinary files');
      const bytes = fs.readFileSync(file);
      return { name, file, size: bytes.length, sha256: digest(bytes) };
    });
}

export function verifyPublished(release, assets, config) {
  assert.equal(release.tag_name, config.tag);
  assert.equal(release.name, config.releaseTitle, 'Published release title differs');
  for (const item of assets) {
    const remote = release.assets.find(asset => asset.name === item.name);
    assert(remote && remote.size === item.size && remote.digest === `sha256:${item.sha256}`,
      `Published asset differs: ${item.name}`);
  }
}

function findRelease(repository, tag, request) {
  const endpoint = `repos/${repository}/releases`;
  const published = optionalApi(`${endpoint}/tags/${encodeURIComponent(tag)}`, request);
  if (published) return published;
  // GitHub's tag endpoint returns published releases. Drafts are visible in
  // the authenticated release list and must subsequently be read by ID.
  for (let page = 1; ; page++) {
    const releases = request(`${endpoint}?per_page=100&page=${page}`);
    const match = releases.find(release => release.tag_name === tag);
    if (match) return match;
    if (releases.length < 100) return null;
  }
}

export function publishReleaseAssets(config, assets, output, { request = api, run = command } = {}) {
  const endpoint = `repos/${config.repository}/releases`;
  let release = findRelease(config.repository, config.tag, request);
  if (release && !release.draft) {
    verifyPublished(release, assets, config);
    return { status: 'already_published', url: release.html_url };
  }
  if (!release) release = request(endpoint, {
    tag_name: config.tag, target_commitish: config.sha, draft: true,
    name: config.releaseTitle,
    body: fs.readFileSync(path.join(output, 'release-notes.md'), 'utf8'),
  });
  else run('gh', ['release', 'edit', config.tag, '--repo', config.repository,
    '--title', config.releaseTitle, '--notes-file', path.join(output, 'release-notes.md')]);
  assert.equal(release.tag_name, config.tag);
  const releasePath = `${endpoint}/${release.id}`;
  for (const item of assets) run('gh', ['release', 'upload', config.tag, item.file,
    '--repo', config.repository, '--clobber']);
  release = request(releasePath);
  verifyPublished(release, assets, config);
  run('gh', ['release', 'edit', config.tag, '--repo', config.repository,
    '--draft=false', '--latest', '--title', config.releaseTitle,
    '--notes-file', path.join(output, 'release-notes.md')]);
  release = request(releasePath);
  assert.equal(release.draft, false);
  verifyPublished(release, assets, config);
  return { status: 'published', url: release.html_url, commit: config.sha,
    assets: assets.map(({ name, size, sha256 }) => ({ name, size, sha256 })) };
}

export function main(args = process.argv.slice(2)) {
  const [mode, output] = args;
  assert(['prepare', 'publish'].includes(mode) && output && path.isAbsolute(output),
    'Usage: publish-release.mjs prepare|publish /absolute/asset-directory');
  const config = configuration();
  const runs = evidence(config);
  fs.mkdirSync(output, { recursive: true });
  if (mode === 'prepare') {
    const record = { schemaVersion: 1, repository: config.repository,
      version: config.version, tag: config.tag, commit: config.sha, tree: config.tree,
      workflows: runs, scope: 'Repository CI and the packaged checks attached to this release',
      modelCalls: 0, nativeModelQualityCertification: false };
    fs.writeFileSync(path.join(output, 'verification.json'), json(record));
    fs.writeFileSync(path.join(output, 'SOURCE-REVISION.txt'),
      `${config.repository}\n${config.tag}\ncommit ${config.sha}\ntree ${config.tree}\n`);
    const notes = [`# ${config.title} ${config.version}`, ...config.changelogs.map(({ file, language }) =>
      `## ${language}\n\n${releaseDocumentLinks(
        releaseSection(fs.readFileSync(path.join(root, file), 'utf8'), config.version),
        { repository: config.repository, tag: config.tag, sourceFile: file })}`),
    '## Checks and downloads',
    ...runs.map(run => `- [${run.workflow}](${run.url})`),
    '- Downloadable packages, source revisions and SHA-256 checksums are attached below.'];
    fs.writeFileSync(path.join(output, 'release-notes.md'), notes.join('\n\n') + '\n');
    console.log(json({ tag: config.tag, commit: config.sha, checkedWorkflows: runs.length }));
    return;
  }

  const before = assetsIn(output).filter(item => item.name !== 'SHA256SUMS.txt');
  assert(before.some(item => /\.(?:tgz|zip)$/u.test(item.name)), 'No distributable package');
  const prepared = JSON.parse(fs.readFileSync(path.join(output, 'verification.json'), 'utf8'));
  assert.equal(prepared.commit, config.sha, 'Prepared assets belong to a different source commit');
  assert.equal(prepared.tree, config.tree, 'Prepared assets belong to a different source tree');
  fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'),
    before.map(item => `${item.sha256}  ${item.name}\n`).join(''));
  const assets = assetsIn(output);
  let ref = optionalApi(`repos/${config.repository}/git/ref/tags/${config.tag}`);
  if (ref) assert.equal(peelTag(config.repository, ref), config.sha, 'Existing release tag points elsewhere');
  else {
    const tag = api(`repos/${config.repository}/git/tags`, {
      tag: config.tag, message: `${config.title} ${config.version}`, object: config.sha, type: 'commit',
    });
    ref = api(`repos/${config.repository}/git/refs`, { ref: `refs/tags/${config.tag}`, sha: tag.sha });
    assert.equal(peelTag(config.repository, ref), config.sha);
  }
  console.log(json(publishReleaseAssets(config, assets, output)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
