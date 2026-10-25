// The wait's default digest: what changed since `since`, decisions repeated until handled, counts for the rest.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { AGENT, ALICE, startServer } from './helpers.ts';

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  srv = await startServer();
});
after(() => srv.close());

const wait = async (group: string, opts: Record<string, unknown> = {}) =>
  (await srv.tool(AGENT, 'wait_for_decisions', { group_id: group, wait_seconds: 0, ...opts })).value;
const ask = async (lane: string, question: string) => (await srv.tool(AGENT, 'create_escalation', { lane_id: lane, question })).value;
const note = (lane: string, body: string) => srv.call('POST', `/api/lanes/${lane}/messages`, ALICE, { body });
const kinds = (w: any) => w.items.map((i: any) => [i.kind, i.code ?? i.lane]);

describe('wait digest', () => {
  test('with nothing open it reports nothing to do and keeps waiting', async () => {
    await srv.publish('d-idle', { group: 'digest-idle' });
    const now = await wait('digest-idle');
    assert.equal(now.ready, false);
    assert.deepEqual(now.items, []);
    assert.deepEqual(now.counts, { open: 0, decidedUnacknowledged: 0, waitingOnYou: 0 });
    assert.ok(now.checkedAt);
    // The full format still returns at once when nothing is open.
    assert.equal((await wait('digest-idle', { format: 'full' })).ready, true);
    // A long wait with nothing open returns when the owner writes on a lane.
    const waiting = srv.tool(AGENT, 'wait_for_decisions', { group_id: 'digest-idle', since: now.checkedAt, wait_seconds: 10 });
    await new Promise((r) => setTimeout(r, 100));
    await note('d-idle', 'Pick up #966 next');
    const woke = (await waiting).value;
    assert.equal(woke.ready, true);
    assert.deepEqual(woke.items, [
      { kind: 'lane_note', lane: 'd-idle', messages: [{ body: 'Pick up #966 next', by: 'alice', at: woke.items[0].messages[0].at }] },
    ]);
    // Repeating the same `since` (a wait that crashed before acting) returns the note again; the next `since` doesn't.
    assert.deepEqual(kinds(await wait('digest-idle', { since: now.checkedAt })), [['lane_note', 'd-idle']]);
    assert.deepEqual((await wait('digest-idle', { since: woke.checkedAt })).items, []);
  });

  test('decisions and replies repeat until handled; counts cover the rest', async () => {
    await srv.publish('d-work', { group: 'digest-work' });
    const accepted = await ask('d-work', 'Ship the retry change behind a feature flag, so that we can turn it off again without a deploy?');
    const other = await ask('d-work', 'Which cache?');
    await ask('d-work', 'Still open?');
    const first = await wait('digest-work');
    assert.equal(first.ready, false);
    assert.deepEqual(first.counts, { open: 3, decidedUnacknowledged: 0, waitingOnYou: 0 });

    await srv.call('POST', `/api/escalations/${accepted.id}/decide`, ALICE, { decision: 'Accept', note: 'Flag name: retry_v2' });
    await srv.call('POST', `/api/escalations/${other.id}/decide`, ALICE, { decision: 'Other', note: 'Redis' });
    const w = await wait('digest-work', { since: first.checkedAt });
    assert.equal(w.ready, true);
    assert.deepEqual(w.counts, { open: 1, decidedUnacknowledged: 1, waitingOnYou: 1 });
    const decided = w.items.find((i: any) => i.kind === 'decided');
    assert.equal(decided.code, accepted.ref);
    assert.equal(decided.decision, 'Accept');
    assert.equal(decided.note, 'Flag name: retry_v2');
    assert.equal(decided.by, 'alice');
    // The agent's own question comes back shortened, enough to recognise it.
    assert.ok(decided.question.length <= 80 && decided.question.endsWith('…'));
    const reply = w.items.find((i: any) => i.kind === 'reply');
    assert.equal(reply.code, other.ref);
    assert.deepEqual(reply.messages.map((m: any) => m.body), ['Redis']);

    // Both come back on the next wait, even with a later `since`, until handled.
    assert.deepEqual(kinds(await wait('digest-work', { since: w.checkedAt })).sort(), [['decided', accepted.ref], ['reply', other.ref]].sort());
    await srv.tool(AGENT, 'acknowledge_escalation', { id: accepted.ref });
    await srv.tool(AGENT, 'reply_to_escalation', { id: other.ref, message: 'Redis 7, OK?' });
    const handled = await wait('digest-work', { since: w.checkedAt });
    assert.deepEqual(handled.items, []);
    assert.deepEqual(handled.counts, { open: 2, decidedUnacknowledged: 0, waitingOnYou: 0 });
  });

  test('withdrawals and removed lanes come back once per since', async () => {
    await srv.publish('d-gone', { group: 'digest-gone' });
    const e = await ask('d-gone', 'Keep this lane?');
    const parked = await ask('d-gone', 'Still needed after the lane goes?');
    const start = await wait('digest-gone');
    await srv.call('POST', `/api/escalations/${e.id}/withdraw`, ALICE, { note: 'Not needed' });
    await srv.call('DELETE', '/api/lanes/d-gone', ALICE);
    const w = await wait('digest-gone', { since: start.checkedAt });
    assert.deepEqual(kinds(w), [['closed', e.ref], ['lane_removed', 'd-gone']]);
    assert.equal(w.items[0].resolution, 'Not needed');
    // The removed lane's ticket is parked with its other question, still open.
    assert.equal(w.counts.open, 1);
    assert.equal((await srv.call('GET', `/api/escalations/${parked.id}`, ALICE)).body.state, 'open');
    assert.deepEqual((await wait('digest-gone', { since: w.checkedAt })).items, []);
  });

  test('a wait on named escalations goes quiet once the agent has acknowledged them', async () => {
    await srv.publish('d-ids', { group: 'digest-ids' });
    const e = await ask('d-ids', 'Named?');
    const other = await ask('d-ids', 'Withdrawn by someone else?');
    await srv.call('POST', `/api/escalations/${e.id}/decide`, ALICE, { decision: 'Accept' });
    const w = (await srv.tool(AGENT, 'wait_for_decisions', { ids: [e.ref, other.ref], wait_seconds: 0 })).value;
    assert.deepEqual(kinds(w), [['decided', e.ref]]);
    await srv.tool(AGENT, 'acknowledge_escalation', { id: e.ref });
    const started = Date.now();
    const quiet = (await srv.tool(AGENT, 'wait_for_decisions', { ids: [e.ref, other.ref], since: w.checkedAt, wait_seconds: 1 })).value;
    assert.equal(quiet.ready, false);
    assert.deepEqual(quiet.items, []);
    assert.ok(Date.now() - started >= 900, 'it waited instead of returning at once');
    // Someone else withdrawing a named one is reported, once per since.
    await srv.call('POST', `/api/escalations/${other.id}/withdraw`, ALICE, { resolution: 'Not needed' });
    const gone = (await srv.tool(AGENT, 'wait_for_decisions', { ids: [e.ref, other.ref], since: quiet.checkedAt, wait_seconds: 0 })).value;
    assert.deepEqual(kinds(gone), [['closed', other.ref]]);
    const after = (await srv.tool(AGENT, 'wait_for_decisions', { ids: [e.ref, other.ref], since: gone.checkedAt, wait_seconds: 0 })).value;
    assert.deepEqual(after.items, []);
    // The full format keeps reporting named closed ones, as before.
    const full = (await srv.tool(AGENT, 'wait_for_decisions', { ids: [e.ref], wait_seconds: 0, format: 'full' })).value;
    assert.deepEqual(full.closed.map((x: any) => x.ref), [e.ref]);
  });

  test('over HTTP the wait is a digest too; format=full keeps the older shape', async () => {
    await srv.publish('d-http', { group: 'digest-http' });
    const e = await ask('d-http', 'HTTP?');
    await srv.call('POST', `/api/escalations/${e.id}/decide`, ALICE, { decision: 'Reject' });
    const digest = (await srv.call('GET', '/api/wait?group=digest-http&timeout=0', AGENT)).body;
    assert.deepEqual(Object.keys(digest).sort(), ['checkedAt', 'counts', 'items', 'ready']);
    assert.deepEqual(kinds(digest), [['decided', e.ref]]);
    const full = (await srv.call('GET', '/api/wait?group=digest-http&timeout=0&format=full', AGENT)).body;
    assert.deepEqual(full.decided.map((x: any) => x.ref), [e.ref]);
    assert.equal((await srv.call('GET', '/api/wait?group=digest-http&format=bogus', AGENT)).status, 400);
  });

  test('get_updates returns everything in scope, open questions included', async () => {
    await srv.publish('d-all', { group: 'digest-all' });
    const open = await ask('d-all', 'Open one?');
    const done = await ask('d-all', 'Decided one?');
    await srv.call('POST', `/api/escalations/${done.id}/decide`, ALICE, { decision: 'Accept' });
    await note('d-all', 'FYI: freeze on Friday');
    const all = (await srv.tool(AGENT, 'get_updates', { group_id: 'digest-all' })).value;
    assert.equal(all.ready, undefined);
    assert.deepEqual(all.open.map((x: any) => x.ref), [open.ref]);
    assert.deepEqual(all.decided.map((x: any) => x.ref), [done.ref]);
    assert.deepEqual(all.laneMessages.map((l: any) => l.messages.map((m: any) => m.body)), [['FYI: freeze on Friday']]);
    const http = (await srv.call('GET', '/api/updates?group=digest-all', AGENT)).body;
    assert.deepEqual(http.open.map((x: any) => x.ref), [open.ref]);
    assert.equal((await srv.tool(AGENT, 'get_updates', {})).isError, true);
  });
});

test('a note in the same millisecond as a wait is returned once, and later ones still are', async () => {
  const { Store } = await import('../src/store.ts');
  // The clock never moves: everything happens in one millisecond.
  const frozen = new Date('2026-10-25T00:00:00.000Z');
  const store = new Store({ path: ':memory:', resolveTicketUrl: () => null, now: () => frozen });
  try {
    store.upsertGroup('default/g', {}, 'bot');
    store.upsertLane('default/l', { group: 'default/g' }, 'bot');
    store.postLaneMessage('default/l', { from: 'owner', author: 'alice', body: 'First' }, 'alice');
    const first = store.decisionsFor({ groupId: 'default/g' });
    assert.deepEqual(first.laneMessages.map((l) => l.messages.map((m) => m.body)), [['First']]);
    store.handOver(first);
    const again = store.decisionsFor({ groupId: 'default/g', since: first.checkedAt });
    assert.deepEqual(again.laneMessages, [], 'not repeated from its own checkedAt');
    store.postLaneMessage('default/l', { from: 'owner', author: 'alice', body: 'Second' }, 'alice');
    const next = store.decisionsFor({ groupId: 'default/g', since: again.checkedAt });
    assert.deepEqual(next.laneMessages.map((l) => l.messages.map((m) => m.body)), [['Second']]);
    // Repeating an older since still brings back what came after it.
    store.handOver(next);
    const crashed = store.decisionsFor({ groupId: 'default/g', since: again.checkedAt });
    assert.deepEqual(crashed.laneMessages.map((l) => l.messages.map((m) => m.body)), [['Second']]);
  } finally {
    store.close();
  }
});
