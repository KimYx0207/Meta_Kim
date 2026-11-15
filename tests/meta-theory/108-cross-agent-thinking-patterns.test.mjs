import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../canonical/skills/meta-theory/', import.meta.url);
const load = (name) => readFile(new URL(name, root), 'utf8');

test('meta-theory exposes task-matched thinking patterns as shared capabilities for any professional Agent', async () => {
  const dispatcher = await load('SKILL.md');
  const guide = await load('references/cross-agent-thinking-patterns.md');
  assert.match(dispatcher, /cross-agent-thinking-patterns\.md/);
  assert.match(dispatcher, /agent-thinking-patterns/);
  assert.match(guide, /any (?:professional )?Agent|任何专业 Agent/i);
  assert.match(guide, /capability-first/i);
  assert.match(guide, /not.*(?:mandatory|force)|不强制/i);
  assert.match(guide, /Kim_Service.*agent-thinking-patterns|agent-thinking-patterns.*Kim_Service/i);
  for (const patternId of [
    'clarify-real-problem', 'adversarial-review', 'backcast-goal', 'expert-comparison',
    'decision-tradeoffs', 'opportunity-scan', 'practice-feedback',
    'repeatable-system', 'knowledge-extraction', 'strategic-focus',
  ]) assert.match(guide, new RegExp('`' + patternId + '`'));
  assert.match(guide, /编码|engineering|代码/i);
  assert.match(guide, /营销|marketing/i);
  assert.match(guide, /教学|education/i);
});

test('optional practice feedback waits for observed work and remains independent of approval and business state', async () => {
  const guide = await load('references/cross-agent-thinking-patterns.md');
  assert.match(guide, /practice-feedback[\s\S]{0,300}(?:submission|提交)/i);
  assert.match(guide, /not_run|awaiting_submission/);
  assert.match(guide, /单一|原有.*(?:PRD|状态)|single source/i);
  assert.match(guide, /权限|approval/i);
  assert.match(guide, /professional Agent remains the owner/i);
});
