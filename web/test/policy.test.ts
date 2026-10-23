import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { policyFor, POLICY_TEMPLATE } from '../src/policy.ts';

test('the app shows the same policy template as the docs', () => {
  const doc = readFileSync(new URL('../../docs/agent-instructions.md', import.meta.url), 'utf8');
  assert.equal(POLICY_TEMPLATE.trim(), doc.split('\n---\n')[1].trim());
});

test('the project line is kept only for keys that need it', () => {
  assert.match(policyFor('payments-epic', 'shop'), /oversee group `payments-epic`[\s\S]*Project: `shop`/);
  assert.doesNotMatch(policyFor('payments-epic', null), /Project:/);
});

test('the requirements part is left out when the server has no requirements', () => {
  assert.match(policyFor('g', null), /\*\*Requirements\*\*/);
  const without = policyFor('g', null, false);
  assert.doesNotMatch(without, /requirement/i);
  assert.match(without, /When I answer/);
});
