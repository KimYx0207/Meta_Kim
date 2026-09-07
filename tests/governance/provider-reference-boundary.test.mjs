import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('reference-only dependencies cannot re-enter through discovered skill providers', () => {
  const source = readFileSync(new URL('../../scripts/select-execution-route.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function referenceOnlyProvider(');
  const end = source.indexOf('\nfunction selectProvider(', start);
  assert.ok(start >= 0 && end > start, 'the shared provider selection boundary must enforce reference-only ownership');
  const registry = JSON.parse(readFileSync(new URL('../../config/capability-index/dependency-project-registry.json', import.meta.url), 'utf8')).projects;
  const eligible = new Function('registryDependencies', `${source.slice(start, end)}; return providerEligibleForRoute;`)(registry);
  assert.equal(eligible({ id: 'gstack/browse', type: 'skills', routeEligible: true }), false);
  assert.equal(eligible({ id: 'browse', type: 'skills', sourceRef: '~/.agents/skills/gstack/browse/SKILL.md' }), false);
  assert.equal(eligible({ id: 'browse', type: 'skills', sourceRef: 'C:\\Users\\user\\.codex\\skills\\gstack\\browse\\SKILL.md' }), false);
  assert.equal(eligible({ id: 'custom-browser', type: 'skills', routeEligibility: 'reference_only' }), false);
  assert.equal(eligible({ id: 'my-gstack-notes', type: 'skills', sourceRef: 'skills/my-gstack-notes/SKILL.md' }), true);
  assert.equal(eligible({ id: 'agent-teams-playbook', type: 'skills' }), true);
  assert.equal(eligible({ id: 'read', type: 'runtimeTools', executionEligible: false }), false);
  assert.equal(eligible({ id: 'read', type: 'runtimeTools', executionEligible: true }), true);
});
