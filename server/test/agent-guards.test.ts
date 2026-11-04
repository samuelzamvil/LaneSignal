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
    const unknown = await srv.tool(AGENT, 'find_requirements', { products: ['paymetns'] });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /Product "paymetns" not found/);
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
    const wait = await srv.tool(AGENT, 'wait_for_decisions', { format: 'full', group: 'payments', wait_seconds: 0 });
    assert.equal(wait.isError, false, wait.text);
    const none = await srv.tool(AGENT, 'wait_for_decisions', { format: 'full', wait_seconds: 0 });
    assert.match(none.text, /group_id/);
  });

  test('a mistyped API URL is a 404, not the web app', async () => {
    assert.equal((await srv.call('GET', '/mcp/api/wait?format=full&group=payments', AGENT)).status, 404);
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
    const wait = (await srv.tool(AGENT, 'wait_for_decisions', { format: 'full', group_id: 'payments', wait_seconds: 0 })).value;
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
    const body = { requirement: 'Payouts retry 5 times.', justification: 'Owner said so.', scope: 'project', source_escalation: e.ref };
    const first = (await srv.tool(AGENT, 'record_requirement', body)).value;
    const retry = (await srv.tool(AGENT, 'record_requirement', { ...body, requirement: '  payouts retry 5 times. ' })).value;
    assert.equal(retry.duplicate, true);
    assert.equal(retry.requirement.id, first.requirement.id);
    const other = (await srv.tool(AGENT, 'record_requirement', { ...body, requirement: 'Dead letters alert on-call.', scope: 'project' })).value;
    assert.notEqual(other.requirement.id, first.requirement.id);
    assert.equal(other.duplicate, undefined);
  });

  test('a retired requirement can be restored', async () => {
    const r = (await srv.call('GET', '/api/requirements?q=payouts%20retry', ALICE)).body[0];
    // Only an active requirement is retired; a pending one is rejected instead.
    if (r.status === 'pending') await srv.call('POST', `/api/requirements/${r.id}/approve`, ALICE);
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
    const wait = await srv.tool(AGENT, 'wait_for_decisions', { format: 'full', group_id: 'payments', wait_seconds: 0 });
    assert.ok(wait.text.length < 2000, `wait returned ${wait.text.length} chars`);
    assert.equal(wait.value.decided.find((e: any) => e.id === created.value.id).decision, 'fine');
    const http = await srv.call('GET', '/api/wait?format=full&group=payments&timeout=0', AGENT);
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
  test("an overseer tells the owner about a milestone; it's in the group's conversation and the lane's history, one a minute per lane", async () => {
    const res = await srv.tool(AGENT, 'notify_owner', { lane_id: 'pay-1', message: 'Merged PR #311' });
    assert.equal(res.isError, false, res.text);
    const group = (await srv.call('GET', '/api/lanes/pay-1', ALICE)).body.lane.group;
    const items = (await srv.call('GET', `/api/groups/${group}/conversation`, ALICE)).body.items;
    assert.ok(items.some((m: any) => m.from === 'agent' && m.body === 'Merged PR #311'));
    // Kept in the lane's history (exports) too.
    assert.ok(srv.store.laneEvents('default/pay-1').some((e) => e.kind === 'notice' && e.message === 'Merged PR #311'));
    // One a minute per lane: another lane's milestone goes through.
    const again = await srv.tool(AGENT, 'notify_owner', { lane_id: 'pay-1', message: 'Starting gh:42' });
    assert.equal(again.isError, true);
    assert.match(again.text, /One milestone per lane per minute/);
    assert.equal((await srv.call('POST', '/api/lanes/pay-2/notices', AGENT, { message: 'Starting gh:42' })).status, 201);
    // A retry is the same milestone, even after someone wrote in between.
    await srv.call('POST', `/api/groups/${group}/messages`, ALICE, { body: 'Nice' });
    const retry = await srv.tool(AGENT, 'notify_owner', { lane_id: 'pay-1', message: 'Merged PR #311' });
    assert.equal(retry.isError, false, retry.text);
    assert.equal((await srv.call('POST', '/api/lanes/pay-2/notices', AGENT, { message: 'x'.repeat(501) })).status, 400);
    assert.equal((await srv.tool(AGENT, 'notify_owner', { lane_id: 'pay-l', message: 'typo' })).isError, true);
    assert.equal((await srv.call('POST', '/api/lanes/pay-1/notices', ALICE, { message: 'not an agent' })).status, 403);
  });
});

describe('an FYI that now needs the owner', () => {
  test('raising it again as blocking keeps its code, blocks the lane and takes the new fields', async () => {
    await srv.publish('fyi-lane', { group: 'payments' });
    const fyi = await ask('fyi-lane', 'CI takes 40 minutes now', AGENT, { blocking: false });
    assert.equal((await srv.call('GET', '/api/lanes/fyi-lane', ALICE)).body.lane.status, 'active');
    // Leaving `blocking` out means blocking, as when creating.
    const res = await srv.call('POST', '/api/escalations', AGENT, {
      laneId: 'fyi-lane',
      question: 'CI takes 40 minutes now',
      recommendation: 'Split the e2e job',
      options: ['Split', 'Leave it'],
      recommendedOption: 'Split',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.id, fyi.id);
    assert.equal(res.body.upgraded, true);
    assert.equal(res.body.blocking, true);
    assert.deepEqual(res.body.options, ['Split', 'Leave it']);
    assert.equal(res.body.recommendation, 'Split the e2e job');
    assert.equal((await srv.call('GET', '/api/lanes/fyi-lane', ALICE)).body.lane.status, 'blocked_human');
    // Again: nothing more to upgrade.
    assert.equal((await ask('fyi-lane', 'CI takes 40 minutes now')).upgraded, undefined);
    // A retry of the original FYI call leaves it alone.
    const fyi2 = await ask('fyi-lane', 'Flaky test in payouts', AGENT, { blocking: false });
    assert.equal((await ask('fyi-lane', 'Flaky test in payouts', AGENT, { blocking: false })).upgraded, undefined);
    // Once answered, the same question is a new escalation.
    await decide(fyi2.id, 'noted');
    const fresh = await ask('fyi-lane', 'Flaky test in payouts', AGENT, { blocking: true });
    assert.notEqual(fresh.id, fyi2.id);
  });
  const tool = (args: Record<string, unknown>, token = AGENT) => srv.tool(token, 'create_escalation', args);

  test('the same question in other spacing, case or closing punctuation is still the same: it upgrades', async () => {
    await srv.publish('fyi-punct', { group: 'fyi-g1' });
    const fyi = (await tool({ lane_id: 'fyi-punct', question: 'Ship it?', blocking: false })).value;
    const again = (await tool({ lane_id: 'fyi-punct', question: 'ship  it' })).value;
    assert.equal(again.id, fyi.id);
    assert.equal(again.upgraded, true);
    // Different words, or punctuation inside that changes what it asks, are a different question.
    assert.notEqual((await tool({ lane_id: 'fyi-punct', question: 'Ship it now?' })).value.id, fyi.id);
    const a = (await tool({ lane_id: 'fyi-punct', question: 'Rename foo-bar to foo_bar?', blocking: false })).value;
    assert.notEqual((await tool({ lane_id: 'fyi-punct', question: 'Rename foo_bar to foo-bar?', blocking: false })).value.id, a.id);
    const b = (await tool({ lane_id: 'fyi-punct', question: 'Is a > b?', blocking: false })).value;
    assert.notEqual((await tool({ lane_id: 'fyi-punct', question: 'Is a < b?', blocking: false })).value.id, b.id);
  });

  test("asked as blocking from a lane, an FYI on the group's epic moves to the lane and blocks it; another lane's never is", async () => {
    await srv.publish('fyi-move', { group: 'fyi-g2' });
    await srv.publish('fyi-move-2', { group: 'fyi-g2' });
    const onEpic = (await tool({ epic: 'fyi-g2', question: 'Freeze the schema?', blocking: false })).value;
    // Asked again as an FYI from a lane, it's the lane's own.
    assert.notEqual((await tool({ lane_id: 'fyi-move-2', question: 'Freeze the schema?', blocking: false })).value.id, onEpic.id);
    const fromLane = (await tool({ lane_id: 'fyi-move', question: 'Freeze the schema.' })).value;
    assert.equal(fromLane.id, onEpic.id);
    assert.equal(fromLane.upgraded, true);
    // Same code, now the lane's ticket's: the lane blocks, and a wait on the lane hears the answer.
    assert.equal(fromLane.ref, onEpic.ref);
    assert.equal(fromLane.laneId, 'fyi-move');
    assert.equal(fromLane.epic, undefined);
    // A retry keeps the question's words.
    assert.equal(fromLane.question, 'Freeze the schema?');
    assert.equal((await srv.call('GET', '/api/lanes/fyi-move', ALICE)).body.lane.status, 'blocked_human');
    await srv.call('POST', `/api/escalations/${onEpic.id}/decide`, ALICE, { decision: 'Accept' });
    const heard = (await srv.tool(AGENT, 'wait_for_decisions', { lane_ids: ['fyi-move'], wait_seconds: 0 })).value;
    assert.deepEqual(heard.items.map((i: { code: string; kind: string }) => [i.code, i.kind]), [[onEpic.ref, 'decided']]);
    await srv.tool(AGENT, 'acknowledge_escalation', { id: onEpic.ref });
    // If the upgrade fails, nothing moved: the FYI stays on the epic.
    const stays = (await tool({ epic: 'fyi-g2', question: 'Pin the versions?', blocking: false })).value;
    const failed = await tool({ lane_id: 'fyi-move', question: 'Pin the versions?', attachments: ['no-such-file'] });
    assert.ok(failed.isError);
    const after = (await srv.call('GET', `/api/escalations/${stays.id}`, ALICE)).body;
    assert.equal(after.laneId, null);
    assert.equal(after.blocking, false);
    // An epic FYI raised from another lane isn't this lane's to take.
    const fromOther = (await tool({ epic: 'fyi-g2', lane_id: 'fyi-move-2', question: 'Bump the SDK?', blocking: false })).value;
    assert.notEqual((await tool({ lane_id: 'fyi-move', question: 'Bump the SDK?' })).value.id, fromOther.id);
    // The same short question on two lanes is two questions: each lane's own blocks.
    const onOther = (await tool({ lane_id: 'fyi-move-2', question: 'OK to merge?', blocking: false })).value;
    const here = (await tool({ lane_id: 'fyi-move', question: 'OK to merge?' })).value;
    assert.notEqual(here.id, onOther.id);
    assert.equal((await srv.call('GET', '/api/lanes/fyi-move', ALICE)).body.lane.status, 'blocked_human');
    assert.equal((await srv.call('GET', '/api/lanes/fyi-move-2', ALICE)).body.lane.status, 'active');
    // Another overseer's FYI is never taken for yours.
    const theirs = (await tool({ epic: 'fyi-g2', question: 'Rename the service?', blocking: false }, REVIEWER)).value;
    assert.notEqual((await tool({ lane_id: 'fyi-move-2', question: 'Rename the service?' })).value.id, theirs.id);
  });

  test('`upgrade` names the FYI by its code, whatever its words', async () => {
    await srv.publish('fyi-code', { group: 'fyi-g3' });
    const fyi = (await tool({ lane_id: 'fyi-code', question: 'Payments CI is slow', blocking: false })).value;
    const up = await tool({ upgrade: fyi.ref, question: 'Split the payments e2e job now?', recommendation: 'Split it' });
    assert.equal(up.isError, false, up.text);
    assert.equal(up.value.id, fyi.id);
    assert.equal(up.value.upgraded, true);
    assert.equal(up.value.question, 'Split the payments e2e job now?');
    assert.equal((await srv.call('GET', '/api/lanes/fyi-code', ALICE)).body.lane.status, 'blocked_human');
    // Again: already blocking, nothing to upgrade.
    const twice = (await tool({ upgrade: fyi.ref })).value;
    assert.equal(twice.duplicate, true);
    assert.equal(twice.upgraded, undefined);
    // Over HTTP too, with the question left out.
    const fyi2 = (await tool({ lane_id: 'fyi-code', question: 'Disk at 80%', blocking: false })).value;
    const http = await srv.call('POST', '/api/escalations', AGENT, { upgrade: fyi2.ref });
    assert.equal(http.status, 200);
    assert.equal(http.body.upgraded, true);
    assert.equal(http.body.question, 'Disk at 80%');
    // Not another agent's (outside its group), not a closed one, and no question without `upgrade`.
    const fyi3 = (await tool({ lane_id: 'fyi-code', question: 'Logs are noisy', blocking: false })).value;
    const other = await tool({ upgrade: fyi3.ref }, REVIEWER);
    assert.ok(other.isError);
    assert.match(other.text, /only that agent, the overseer of the group/);
    await srv.call('POST', `/api/escalations/${fyi3.id}/decide`, ALICE, { decision: 'noted' });
    const closed = await tool({ upgrade: fyi3.ref });
    assert.ok(closed.isError);
    assert.ok((await tool({ lane_id: 'fyi-code' })).isError);
    // Where it is stays: lane_id, epic, blocking or positions with it are refused, not dropped.
    const fyi4 = (await tool({ lane_id: 'fyi-code', question: 'Cache is cold', blocking: false })).value;
    assert.match((await tool({ upgrade: fyi4.ref, lane_id: 'fyi-code' })).text, /leave out lane_id/);
    assert.equal((await srv.call('POST', '/api/escalations', AGENT, { upgrade: fyi4.ref, blocking: false })).status, 400);
    // A recommended option alone must be one of its options.
    const rec = await srv.call('POST', '/api/escalations', AGENT, { upgrade: fyi4.ref, recommendedOption: 'Warm it' });
    assert.equal(rec.status, 400);
    assert.match(rec.body.error, /must be one of/);
    // Answered Other, the FYI still goes back to the owner, as when it's raised again as blocking.
    await srv.call('POST', `/api/escalations/${fyi4.id}/decide`, ALICE, { decision: 'Other', note: 'Why?' });
    const other4 = (await tool({ upgrade: fyi4.ref })).value;
    assert.equal(other4.upgraded, true);
    assert.equal((await srv.call('GET', `/api/escalations/${fyi4.id}`, ALICE)).body.turn, 'owner');
  });

  test('a new blocking question names the open FYIs in its group', async () => {
    await srv.publish('fyi-list', { group: 'fyi-g4' });
    const a = (await tool({ lane_id: 'fyi-list', question: 'Heads up: quota', blocking: false })).value;
    const b = (await tool({ epic: 'fyi-g4', question: 'Heads up: billing', blocking: false })).value;
    const blocking = (await tool({ lane_id: 'fyi-list', question: 'Raise the quota to 10k?' })).value;
    assert.deepEqual(blocking.openFyis, [a.ref, b.ref]);
    // Not on an FYI, and not when there are none.
    assert.equal((await tool({ lane_id: 'fyi-list', question: 'Heads up: more', blocking: false })).value.openFyis, undefined);
    // The group's overseer sees every FYI in it; another key only its own, the ones it can upgrade.
    await srv.publish('fyi-list-2', { group: 'fyi-g4', token: REVIEWER });
    const theirs = (await tool({ lane_id: 'fyi-list-2', question: 'Heads up: theirs', blocking: false }, REVIEWER)).value;
    const all = (await tool({ lane_id: 'fyi-list-2', question: 'Ready to ship?' }, REVIEWER)).value.openFyis;
    assert.ok(all.includes(a.ref) && all.includes(theirs.ref));
    const mine = (await tool({ lane_id: 'fyi-list', question: 'Ready to deploy?' })).value.openFyis;
    assert.ok(mine.includes(a.ref) && !mine.includes(theirs.ref));
    await srv.publish('fyi-none', { group: 'fyi-g5' });
    assert.equal((await tool({ lane_id: 'fyi-none', question: 'Go?' })).value.openFyis, undefined);
  });
});

test('a notice can run to several lines; a retry returns it, another within the minute is refused', async () => {
  assert.equal((await srv.call('POST', '/api/lanes/other/notices', REVIEWER, { message: 'Merged #311\nAlso lots more' })).status, 201);
  assert.equal((await srv.call('POST', '/api/lanes/other/notices', REVIEWER, { message: 'Merged #311\nAlso lots more' })).status, 201);
  assert.equal((await srv.call('POST', '/api/lanes/other/notices', REVIEWER, { message: 'Merged #312' })).status, 409);
});
