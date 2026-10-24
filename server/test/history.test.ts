// History: closed escalations with their outcome, searchable.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { AGENT, ALICE, startServer } from './helpers.ts';

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  srv = await startServer();
  await srv.publish('pay', { group: 'payments' });
  await srv.publish('srch', { group: 'search' });
});
after(() => srv.close());

const ask = async (lane: string, question: string) => (await srv.tool(AGENT, 'create_escalation', { lane_id: lane, question })).value;
const history = async (qs = '') => (await srv.call('GET', `/api/history${qs}`, ALICE)).body;

test('closed escalations, latest first, searchable and filtered', async () => {
  const a = await ask('pay', 'Drop legacy_role?');
  await srv.call('POST', `/api/escalations/${a.id}/decide`, ALICE, { decision: 'Accept' });
  await srv.tool(AGENT, 'acknowledge_escalation', { id: a.ref });
  const b = await ask('pay', 'Retry payouts how often?');
  await srv.call('POST', `/api/escalations/${b.id}/decide`, ALICE, { decision: 'Other', note: 'Five times, then the dead-letter queue' });
  await srv.tool(AGENT, 'acknowledge_escalation', { id: b.ref });
  const c = await ask('srch', 'Reindex tonight?');
  await srv.tool(AGENT, 'dismiss_escalation', { id: c.ref, justification: 'moot' });
  await ask('srch', 'Still open?');

  const all = await history();
  assert.deepEqual(all.items.map((e: any) => e.question), ['Reindex tonight?', 'Retry payouts how often?', 'Drop legacy_role?']);
  // The conversation is searched too.
  assert.deepEqual((await history('?q=dead-letter')).items.map((e: any) => e.id), [b.id]);
  assert.deepEqual((await history(`?q=${a.ref}`)).items.map((e: any) => e.id), [a.id]);
  assert.deepEqual((await history('?q=100%25')).items, []);
  assert.deepEqual((await history('?outcome=dismissed')).items.map((e: any) => e.id), [c.id]);
  assert.deepEqual((await history('?outcome=answered')).items.map((e: any) => e.id), [b.id, a.id]);
  assert.deepEqual((await history('?q=legacy_')).items.map((e: any) => e.id), [a.id]);
  assert.deepEqual((await history('?q=legacy%5F%5F')).items, []);
  assert.deepEqual((await history('?group=payments')).items.length, 2);
  assert.equal((await srv.call('GET', '/api/history?group=nope', ALICE)).status, 404);
  // Pages.
  const first = await history('?limit=2');
  assert.equal(first.items.length, 2);
  const second = await history(`?limit=2&before_at=${encodeURIComponent(first.next.at)}&before_id=${first.next.id}`);
  assert.deepEqual(second.items.map((e: any) => e.id), [a.id]);
  assert.equal(second.next, null);
});
