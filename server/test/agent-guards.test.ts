// Guards against the mistakes agents actually make (typos, another overseer's codes, retries),
// and keeping results small enough to be cheap.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { AGENT, ALICE, REVIEWER, startServer } from './helpers.ts';

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  srv = await startServer();
  await srv.publish('pay-1', { group: 'payments' });
  await srv.publish('pay-2', { group: 'payments' });
  await srv.publish('other', { group: 'search', token: REVIEWER });
});
after(() => srv.close());

const ask = async (lane: string, question: string, token = AGENT, extra: Record<string, unknown> = {}) =>
  (await srv.tool(token, 'create_escalation', { lane_id: lane, question, ...extra })).value;
const decide = (id: string, decision: string) => srv.call('POST', `/api/escalations/${id}/decide`, ALICE, { decision });

describe('typos are errors, not new things nobody waits on', () => {
  test('escalating on an unknown lane', async () => {
    const res = await srv.tool(AGENT, 'create_escalation', { lane_id: 'pay-l', question: 'Typo?' });
    assert.equal(res.isError, true);
    assert.match(res.text, /Lane "pay-l" not found: publish it first/);
    assert.equal((await srv.call('GET', '/api/lanes/pay-l', ALICE)).status, 404);
  });

  test('putting a lane in an unknown group', async () => {
    const res = await srv.tool(AGENT, 'update_lane', { lane_id: 'pay-3', group: 'paymetns' });
    assert.equal(res.isError, true);
    assert.match(res.text, /Group "paymetns" not found/);
    assert.ok(!(await srv.call('GET', '/api/groups', ALICE)).body.some((g: any) => g.id === 'paymetns'));
  });

  test('filtering by an unknown group', async () => {
    const lanes = await srv.tool(AGENT, 'list_lanes', { group: 'Payments train' });
    assert.equal(lanes.isError, true);
    assert.match(lanes.text, /Group "Payments train" not found/);
    assert.equal((await srv.tool(AGENT, 'find_requirements', { group_id: 'paymetns' })).isError, true);
    assert.equal((await srv.call('GET', '/api/requirements?group=paymetns', AGENT)).status, 404);
  });

  test('group and group_id both work wherever a group is named', async () => {
    const a = await srv.tool(AGENT, 'list_lanes', { group_id: 'payments' });
    const b = await srv.tool(AGENT, 'list_lanes', { group: 'payments' });
    assert.deepEqual(a.value.map((l: any) => l.id).sort(), ['pay-1', 'pay-2']);
    assert.deepEqual(b.value, a.value);
    const lane = await srv.tool(AGENT, 'update_lane', { lane_id: 'pay-2', group_id: 'payments', activity: 'via group_id' });
    assert.equal(lane.isError, false, lane.text);
    assert.equal((await srv.call('GET', '/api/lanes/pay-2', ALICE)).body.lane.group, 'payments');
    const wait = await srv.tool(AGENT, 'wait_for_decisions', { group: 'payments', wait_seconds: 0 });
    assert.equal(wait.isError, false, wait.text);
    const none = await srv.tool(AGENT, 'wait_for_decisions', { wait_seconds: 0 });
    assert.match(none.text, /group_id/);
  });

  test('a mistyped API URL is a 404, not the web app', async () => {
    assert.equal((await srv.call('GET', '/mcp/api/wait?group=payments', AGENT)).status, 404);
  });
});

describe('acknowledging', () => {
  test("another overseer can't acknowledge your decision; a person can", async () => {
    const mine = await ask('pay-1', 'Mine to pick up?');
    await decide(mine.id, 'yes');
    const theirs = await srv.tool(REVIEWER, 'acknowledge_escalation', { id: mine.ref });
    assert.equal(theirs.isError, true);
    assert.match(theirs.text, /raised by overseer; only that agent/);
    // The decision is still waiting for its overseer.
    const wait = (await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'payments', wait_seconds: 0 })).value;
    assert.deepEqual(wait.decided.map((e: any) => e.id), [mine.id]);
    const byPerson = await srv.call('POST', `/api/escalations/${mine.id}/ack`, ALICE, { note: 'handled in the session' });
    assert.equal(byPerson.status, 200);
    assert.equal(byPerson.body.state, 'acknowledged');
  });

  test('a lane stays blocked while another blocking question is open', async () => {
    const one = await ask('pay-2', 'First of two?');
    const two = await ask('pay-2', 'Second of two?');
    await decide(one.id, 'yes');
    const ack = await srv.tool(AGENT, 'acknowledge_escalation', { id: one.id, status: 'active', activity: 'Doing the first' });
    assert.equal(ack.isError, false, ack.text);
    const lane = (await srv.call('GET', '/api/lanes/pay-2', ALICE)).body.lane;
    assert.equal(lane.status, 'blocked_human');
    assert.equal(lane.activity, 'Doing the first');
    await decide(two.id, 'no');
    await srv.tool(AGENT, 'acknowledge_escalation', { id: two.id, status: 'active' });
    assert.equal((await srv.call('GET', '/api/lanes/pay-2', ALICE)).body.lane.status, 'active');
  });
});

describe('retries and duplicates', () => {
  test('the same question with different spacing or case is a retry', async () => {
    const first = await ask('pay-1', 'Use one queue per job type?');
    const again = await ask('pay-1', '  use one queue   per job type? ');
    assert.equal(again.id, first.id);
    assert.equal(again.duplicate, true);
  });

  test('a retried requirement returns the first; a second decision from the same answer is kept', async () => {
    const e = await ask('pay-1', 'How many retries?');
    await decide(e.id, '5, and alert on dead letters');
    const body = { requirement: 'Payouts retry 5 times.', justification: 'Owner said so.', tags: ['payout-retries'], source_escalation: e.ref };
    const first = (await srv.tool(AGENT, 'record_requirement', body)).value;
    const retry = (await srv.tool(AGENT, 'record_requirement', { ...body, requirement: '  payouts retry 5 times. ' })).value;
    assert.equal(retry.duplicate, true);
    assert.equal(retry.requirement.id, first.requirement.id);
    const other = (await srv.tool(AGENT, 'record_requirement', { ...body, requirement: 'Dead letters alert on-call.', tags: ['dead-letters'] })).value;
    assert.notEqual(other.requirement.id, first.requirement.id);
    assert.equal(other.duplicate, undefined);
  });

  test('a tag that differs from an existing one by a plural is flagged', async () => {
    const res = await srv.tool(AGENT, 'record_requirement', {
      requirement: 'Failed payouts alert on-call.',
      justification: 'Owner, in standup.',
      tags: ['payout-retry'],
      decided_by: 'Sam',
    });
    assert.ok(res.value.warnings.some((w: string) => /close to the existing tag "payout-retries"/.test(w)), res.text);
  });

  test('a retired requirement can be restored', async () => {
    const r = (await srv.call('GET', '/api/requirements?tag=payout-retries', ALICE)).body[0];
    assert.equal((await srv.call('POST', `/api/requirements/${r.id}/retire`, ALICE)).body.status, 'retired');
    const restored = await srv.call('POST', `/api/requirements/${r.id}/restore`, ALICE);
    assert.equal(restored.status, 200);
    assert.equal(restored.body.status, 'active');
    assert.equal((await srv.call('POST', `/api/requirements/${r.id}/restore`, ALICE)).status, 409);
  });
});

describe('small results', () => {
  test('creating, waiting and acknowledging return escalations in brief', async () => {
    const context = 'x'.repeat(20_000);
    const created = await srv.tool(AGENT, 'create_escalation', { lane_id: 'pay-1', question: 'Big one?', context });
    assert.ok(created.text.length < 1000, `create returned ${created.text.length} chars`);
    assert.equal(created.value.context, undefined);
    await decide(created.value.id, 'fine');
    const wait = await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'payments', wait_seconds: 0 });
    assert.ok(wait.text.length < 2000, `wait returned ${wait.text.length} chars`);
    assert.equal(wait.value.decided.find((e: any) => e.id === created.value.id).decision, 'fine');
    const http = await srv.call('GET', '/api/wait?group=payments&timeout=0', AGENT);
    assert.ok(http.body.decided.length > 0 && http.body.decided.every((e: any) => e.context === undefined));
    const ack = await srv.tool(AGENT, 'acknowledge_escalation', { id: created.value.id });
    assert.ok(ack.text.length < 1000);
    // Everything is still one call away.
    assert.equal((await srv.tool(AGENT, 'get_escalation', { id: created.value.ref })).value.context, context);
  });

  test('list_escalations filters by group and keeps to a small page', async () => {
    await ask('other', 'Not yours?', REVIEWER);
    const mine = (await srv.tool(AGENT, 'list_escalations', { group_id: 'payments', states: ['open', 'decided', 'acknowledged'] })).value;
    assert.ok(mine.length > 0 && mine.every((e: any) => e.laneId.startsWith('pay-')));
    const all = (await srv.tool(AGENT, 'list_escalations', { states: ['open', 'decided', 'acknowledged', 'withdrawn'], limit: 2 })).value;
    assert.equal(all.length, 2);
  });
});

describe('notices', () => {
  test('an overseer tells the owner about a milestone; it lands in the lane history, one per minute', async () => {
    const res = await srv.tool(AGENT, 'notify_owner', { lane_id: 'pay-1', message: 'Merged PR #311' });
    assert.equal(res.isError, false, res.text);
    const events = (await srv.call('GET', '/api/lanes/pay-1', ALICE)).body.events;
    assert.ok(events.some((e: any) => e.kind === 'notice' && e.message === 'Merged PR #311'));
    const again = await srv.tool(AGENT, 'notify_owner', { lane_id: 'pay-1', message: 'Starting gh:42' });
    assert.equal(again.isError, true);
    assert.match(again.text, /One notice per lane per minute/);
    assert.equal((await srv.call('POST', '/api/lanes/pay-2/notices', AGENT, { message: 'Starting gh:42' })).status, 201);
    assert.equal((await srv.call('POST', '/api/lanes/pay-2/notices', AGENT, { message: 'x'.repeat(141) })).status, 400);
    assert.equal((await srv.tool(AGENT, 'notify_owner', { lane_id: 'pay-l', message: 'typo' })).isError, true);
    assert.equal((await srv.call('POST', '/api/lanes/pay-1/notices', ALICE, { message: 'not an agent' })).status, 403);
  });
});
