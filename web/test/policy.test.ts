import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ALERTS_ONLY, policyFor, POLICY_TEMPLATE } from '../src/policy.ts';

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

test('an alerts-only server gets the dismiss wording', () => {
  assert.match(policyFor('g', null), /acknowledge before acting/);
  const alerts = policyFor('g', null, true, false);
  assert.doesNotMatch(alerts, /acknowledge/);
  assert.match(alerts, /dismiss the alert, with what I decided/);
  assert.match(alerts, /I answer you here, in this session/);
  for (const [from, to] of ALERTS_ONLY) {
    assert.ok(POLICY_TEMPLATE.includes(from), `the template still says: ${from}`);
    assert.ok(alerts.includes(to));
  }
});
