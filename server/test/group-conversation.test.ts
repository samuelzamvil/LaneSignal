// A group's conversation: people write to the group, its overseer hears them through its group wait
// and acknowledges them, and anyone reads it back newest first, escalations included.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { Store } from '../src/store.ts';
import { AGENT, ALICE, REVIEWER, startServer } from './helpers.ts';
import { lane as publishLane } from './publish.ts';

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  srv = await startServer();
});
after(() => srv.close());

const say = (group: string, body: Record<string, unknown>, token = ALICE) => srv.call('POST', `/api/groups/${group}/messages`, token, body);
const notes = async (group: string, extra = '') =>
  ((await srv.call('GET', `/api/wait?group=${group}&timeout=0${extra}`, AGENT)).body.items as { kind: string; id: string; text: string }[]).filter(
    (i) => i.kind === 'group_note',
  );

describe('group conversations', () => {
  test('a person\'s message reaches the overseer\'s group wait until it acknowledges it', async () => {
    await srv.call('PUT', '/api/groups/talk', AGENT, {});
    const first = await say('talk', { body: 'Do the billing export next' });
    assert.equal(first.status, 201);
    assert.equal(first.body.from, 'owner');
    assert.equal(first.body.seen, false);
    const second = (await say('talk', { body: 'And keep the CSV columns as they are' })).body;
    // It comes back on every wait (a restart or a lost result loses nothing) until acknowledged.
    assert.deepEqual((await notes('talk')).map((n) => n.text), ['Do the billing export next', 'And keep the CSV columns as they are']);
    assert.equal((await notes('talk')).length, 2);
    assert.deepEqual((await notes('talk', `&ack=${first.body.id}`)).map((n) => n.id), [String(second.id)]);
    // Acknowledging never moves back.
    assert.deepEqual((await notes('talk', '&ack=0')).map((n) => n.id), [String(second.id)]);
    assert.equal((await srv.call('POST', '/api/groups/talk/ack', AGENT, { upTo: second.id })).body.acknowledgedUpTo, second.id);
    assert.deepEqual(await notes('talk'), []);
    const page = (await srv.call('GET', '/api/groups/talk/conversation', ALICE)).body;
    assert.deepEqual(page.items.map((i: { body: string; seen: boolean }) => [i.body, i.seen]), [
      ['And keep the CSV columns as they are', true],
      ['Do the billing export next', true],
    ]);
  });

  test('a waiting overseer hears a message as soon as it\'s written', async () => {
    await srv.call('PUT', '/api/groups/listen', AGENT, {});
    const waiting = srv.call('GET', '/api/wait?group=listen&timeout=10', AGENT);
    await new Promise((r) => setTimeout(r, 100));
    await say('listen', { body: 'Are you there?' });
    const result = (await waiting).body;
    assert.equal(result.ready, true);
    assert.deepEqual(result.items.map((i: { kind: string; text: string }) => [i.kind, i.text]), [['group_note', 'Are you there?']]);
  });

  test('a retry never posts twice', async () => {
    await srv.call('PUT', '/api/groups/retry', AGENT, {});
    const a = await say('retry', { body: 'Once', clientKey: 'k-1' });
    const b = await say('retry', { body: 'Once', clientKey: 'k-1' });
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(b.body.id, a.body.id);
    // Without a key, the same text from the same person within a minute is the same message.
    const c = await say('retry', { body: 'Twice?' });
    assert.equal((await say('retry', { body: 'Twice?' })).body.id, c.body.id);
    assert.equal((await srv.call('GET', '/api/groups/retry/conversation', ALICE)).body.items.length, 2);
  });

  test('the overseer writes once a minute; its messages need no acknowledging', async () => {
    await srv.call('PUT', '/api/groups/updates', AGENT, {});
    const posted = await srv.tool(AGENT, 'post_to_group', { group_id: 'updates', message: 'Merged #921' });
    assert.ok(!posted.isError, posted.text);
    const again = await srv.tool(AGENT, 'post_to_group', { group_id: 'updates', message: 'And #922' });
    assert.ok(again.isError);
    assert.match(again.text, /One message per group per minute/);
    assert.deepEqual(await notes('updates'), []);
    const read = await srv.tool(AGENT, 'read_conversation', { group_id: 'updates' });
    assert.deepEqual(read.value.items.map((i: { from: string; body: string }) => [i.from, i.body]), [['agent', 'Merged #921']]);
  });

  test('a removed group\'s conversation stays readable and takes no new messages', async () => {
    await srv.call('PUT', '/api/groups/gone', AGENT, {});
    await say('gone', { body: 'Before it went' });
    assert.equal((await srv.call('DELETE', '/api/groups/gone', ALICE)).status, 204);
    const refused = await say('gone', { body: 'Anyone?' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /read-only/);
    assert.deepEqual((await srv.call('GET', '/api/groups/gone/conversation', ALICE)).body.items.map((i: { body: string }) => i.body), ['Before it went']);
    // Registering it again opens it.
    await srv.call('PUT', '/api/groups/gone', AGENT, {});
    assert.equal((await say('gone', { body: 'Back' })).status, 201);
  });

  test('saying the same again after the overseer acknowledged it is a new message', async () => {
    await srv.call('PUT', '/api/groups/again', AGENT, {});
    const first = (await say('again', { body: 'Yes' })).body;
    await srv.call('POST', '/api/groups/again/ack', AGENT, { upTo: first.id });
    const second = await say('again', { body: 'Yes' });
    assert.equal(second.status, 201);
    assert.notEqual(second.body.id, first.id);
    assert.deepEqual((await notes('again')).map((n) => n.id), [String(second.body.id)]);
    // Something written in between makes it new too.
    const third = (await say('again', { body: 'Sure' })).body;
    await srv.tool(AGENT, 'post_to_group', { group_id: 'again', message: 'Also staging?' });
    assert.notEqual((await say('again', { body: 'Sure' })).body.id, third.id);
  });

  test('a key names one message: reused with other words, it is refused', async () => {
    await srv.call('PUT', '/api/groups/keys', AGENT, {});
    await say('keys', { body: 'First', clientKey: 'same' });
    const clash = await say('keys', { body: 'Second', clientKey: 'same' });
    assert.equal(clash.status, 409);
    assert.match(clash.body.error, /already used/);
  });

  test('only the overseer acknowledges: a person\'s or another key\'s ack is refused', async () => {
    await srv.call('PUT', '/api/groups/owned', AGENT, {});
    const m = (await say('owned', { body: 'For the overseer' })).body;
    assert.equal((await srv.call('GET', `/api/updates?group=owned&ack=${m.id}`, ALICE)).status, 403);
    assert.equal((await srv.call('POST', '/api/groups/owned/ack', ALICE, { upTo: m.id })).status, 403);
    // A worker (any key but the one that registered the group) is refused too, saying who oversees it.
    const worker = await srv.call('GET', `/api/wait?group=owned&timeout=0&ack=${m.id}`, REVIEWER);
    assert.equal(worker.status, 403);
    assert.match(worker.body.error, /Only the group's overseer \(overseer\) acknowledges its messages: this ack wasn't recorded/);
    assert.equal((await srv.call('POST', '/api/groups/owned/ack', REVIEWER, { upTo: m.id })).status, 403);
    const viaMcp = await srv.tool(REVIEWER, 'wait_for_decisions', { group_id: 'owned', wait_seconds: 0, ack: m.id });
    assert.ok(viaMcp.isError);
    assert.match(viaMcp.text, /Only the group's overseer/);
    assert.ok((await srv.tool(REVIEWER, 'get_updates', { group_id: 'owned', ack: m.id })).isError);
    assert.deepEqual((await notes('owned')).map((n) => n.id), [String(m.id)]);
    // The full shape lists them too, with their ids.
    const full = (await srv.call('GET', '/api/wait?group=owned&timeout=0&format=full', AGENT)).body;
    assert.deepEqual(full.groupMessages, [{ group: 'owned', messages: [{ id: m.id, body: 'For the overseer', by: 'alice', at: m.at }] }]);
  });

  test('wait_for_decisions acknowledges with `ack`', async () => {
    await srv.call('PUT', '/api/groups/mcp-ack', AGENT, {});
    const m = (await say('mcp-ack', { body: 'Ping' })).body;
    const first = await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'mcp-ack', wait_seconds: 0 });
    assert.deepEqual(first.value.items.map((i: { kind: string; id: string }) => [i.kind, i.id]), [['group_note', String(m.id)]]);
    const second = await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'mcp-ack', wait_seconds: 0, ack: m.id });
    assert.ok(!second.value.items.some((i: { kind: string }) => i.kind === 'group_note'));
    // The result says how far it has acknowledged, so the agent sees it worked; get_updates too.
    assert.equal(second.value.acked, m.id);
    assert.equal((await srv.tool(AGENT, 'get_updates', { group_id: 'mcp-ack', ack: m.id })).value.acked, m.id);
    assert.equal((await srv.call('GET', `/api/wait?group=mcp-ack&timeout=0&ack=${m.id}`, AGENT)).body.acked, m.id);
    // Without `ack`, nothing about it.
    assert.equal((await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'mcp-ack', wait_seconds: 0 })).value.acked, undefined);
  });

  test('a loop on `since` without `ack` waits for something new instead of spinning', async () => {
    await srv.call('PUT', '/api/groups/spin', AGENT, {});
    const a = (await say('spin', { body: 'One' })).body;
    const b = (await say('spin', { body: 'Two' })).body;
    const first = (await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'spin', wait_seconds: 0 })).value;
    assert.equal(first.ready, true);
    assert.deepEqual(first.items.map((i: { id: string; seen?: boolean }) => [i.id, i.seen]), [[String(a.id), undefined], [String(b.id), undefined]]);
    // From its checkedAt, the same two come back as seen, and don't end the wait: it times out.
    const started = Date.now();
    const again = (await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'spin', wait_seconds: 1, since: first.checkedAt })).value;
    assert.ok(Date.now() - started >= 900, 'it waited');
    assert.equal(again.ready, false);
    assert.deepEqual(again.items.map((i: { id: string; seen?: boolean }) => [i.id, i.seen]), [[String(a.id), true], [String(b.id), true]]);
    // A third, written during the wait, ends it; only it is new.
    const waiting = srv.tool(AGENT, 'wait_for_decisions', { group_id: 'spin', wait_seconds: 10, since: again.checkedAt });
    await new Promise((r) => setTimeout(r, 100));
    const c = (await say('spin', { body: 'Three' })).body;
    const third = (await waiting).value;
    assert.equal(third.ready, true);
    assert.deepEqual(third.items.map((i: { id: string; seen?: boolean }) => [i.id, i.seen]), [
      [String(a.id), true],
      [String(b.id), true],
      [String(c.id), undefined],
    ]);
    // The full shape and the HTTP wait mark them the same way.
    const full = (await srv.call('GET', `/api/wait?group=spin&timeout=0&format=full&since=${encodeURIComponent(third.checkedAt)}`, AGENT)).body;
    assert.deepEqual(full.groupMessages[0].messages.map((m: { seen?: boolean }) => m.seen), [true, true, true]);
    // Without a `since`, every unacknowledged note is new: a restart loses none.
    const fresh = (await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'spin', wait_seconds: 0 })).value;
    assert.equal(fresh.ready, true);
    assert.ok(fresh.items.every((i: { seen?: boolean }) => i.seen === undefined));
    // Acknowledging is what clears them.
    const done = (await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'spin', wait_seconds: 0, ack: c.id })).value;
    assert.deepEqual(done.items, []);
  });

  test('a note the overseer was never handed is new, whatever `since` it passes', async () => {
    await srv.publish('never-lane', { group: 'never' });
    const m = (await say('never', { body: 'Missed?' })).body;
    // A `since` from a wait that didn't cover the group (lanes only) is past the note, but the note never reached it.
    const lanesOnly = (await srv.call('GET', '/api/wait?lane=never-lane&timeout=0', AGENT)).body;
    const w = (await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'never', wait_seconds: 5, since: lanesOnly.checkedAt })).value;
    assert.equal(w.ready, true);
    assert.deepEqual(w.items.map((i: { id: string; seen?: boolean }) => [i.id, i.seen]), [[String(m.id), undefined]]);
    // Handed over now: from this result's checkedAt it's one it had.
    const again = (await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'never', wait_seconds: 0, since: w.checkedAt })).value;
    assert.deepEqual(again.items.map((i: { seen?: boolean }) => i.seen), [true]);
    // A worker reading the group doesn't count as handing it to the overseer.
    const n = (await say('never', { body: 'Second' })).body;
    const worker = (await srv.tool(REVIEWER, 'get_updates', { group_id: 'never' })).value;
    assert.ok(worker.groupMessages[0].messages.some((x: { id: number }) => x.id === n.id));
    const overseer = (await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'never', wait_seconds: 5, since: worker.checkedAt })).value;
    assert.equal(overseer.ready, true);
    assert.deepEqual(overseer.items.map((i: { id: string; seen?: boolean }) => [i.id, i.seen]), [[String(m.id), true], [String(n.id), undefined]]);
  });

  test("a new overseer's notes are new to it, whatever the last one was handed", async () => {
    await srv.publish('handover-lane', { group: 'handover' });
    const m = (await say('handover', { body: 'For whoever runs this' })).body;
    // The first overseer is handed it, and doesn't acknowledge it.
    await srv.tool(AGENT, 'get_updates', { group_id: 'handover' });
    // Another key takes the group over and waits from a `since` that didn't cover the group.
    await srv.call('PUT', '/api/groups/handover', REVIEWER, {});
    const lanesOnly = (await srv.call('GET', '/api/wait?lane=handover-lane&timeout=0', REVIEWER)).body;
    const w = (await srv.tool(REVIEWER, 'wait_for_decisions', { group_id: 'handover', wait_seconds: 5, since: lanesOnly.checkedAt })).value;
    assert.equal(w.ready, true);
    assert.deepEqual(w.items.map((i: { id: string; seen?: boolean }) => [i.id, i.seen]), [[String(m.id), undefined]]);
    // Handed to it now: from here it's one it had.
    const again = (await srv.tool(REVIEWER, 'wait_for_decisions', { group_id: 'handover', wait_seconds: 0, since: w.checkedAt })).value;
    assert.deepEqual(again.items.map((i: { seen?: boolean }) => i.seen), [true]);
  });

  test('acknowledging tells clients once, so people see their messages marked seen', async () => {
    await srv.call('PUT', '/api/groups/seen', AGENT, {});
    const m = (await say('seen', { body: 'Read me' })).body;
    const group = async () => (await srv.call('GET', '/api/groups', ALICE)).body.find((g: { id: string }) => g.id === 'seen');
    assert.equal((await group()).overseerReadId, 0);
    const events: { group: { id: string; overseerReadId: number } }[] = [];
    const listen = (e: any) => e.type === 'group' && e.group.id === 'default/seen' && events.push(e);
    srv.store.events.on('change', listen);
    try {
      await srv.call('POST', '/api/groups/seen/ack', AGENT, { upTo: m.id });
      await srv.call('POST', '/api/groups/seen/ack', AGENT, { upTo: m.id });
    } finally {
      srv.store.events.off('change', listen);
    }
    assert.deepEqual(events.map((e) => e.group.overseerReadId), [m.id]);
    assert.equal((await group()).overseerReadId, m.id);
  });
});

describe('a group\'s conversation, page by page', () => {
  test('newest first, escalations where their threads start, in an order that never changes', () => {
    let now = Date.parse('2026-11-04T10:00:00Z');
    const store = new Store({ path: ':memory:', resolveTicketUrl: () => null, now: () => new Date(now) });
    publishLane(store, 'default/l', { group: 'default/g' }, 'bot');
    store.postGroupMessage('default/g', { from: 'owner', author: 'alice', body: 'one' }, 'user:a');
    now += 1000;
    const e = store.createEscalation({ laneId: 'default/l', question: 'Ship it?' }, 'bot');
    // Same time as the question: the question comes first.
    store.postMessage(e.id, { from: 'owner', author: 'alice', body: 'Other: wait' }, 'user:a');
    now += 1000;
    store.postGroupMessage('default/g', { from: 'owner', author: 'alice', body: 'three' }, 'user:a');
    store.postGroupMessage('default/g', { from: 'owner', author: 'alice', body: 'four' }, 'user:a');
    const all = store.groupConversation('default/g').items.map((i) => (i.type === 'message' ? i.body : `? ${i.question}`));
    assert.deepEqual(all, ['four', 'three', 'Other: wait', '? Ship it?', 'one']);
    // Two at a time, the same order, nothing repeated or skipped.
    const paged: string[] = [];
    let before: string | undefined;
    do {
      const page = store.groupConversation('default/g', { limit: 2, before });
      paged.push(...page.items.map((i) => (i.type === 'message' ? i.body : `? ${i.question}`)));
      before = page.next ?? undefined;
    } while (before);
    assert.deepEqual(paged, all);
    assert.throws(() => store.groupConversation('default/g', { before: 'nonsense' }), /previous page/);
    store.close();
  });

  test('an escalation\'s thread stays in the group it was raised in when its lane moves', () => {
    const store = new Store({ path: ':memory:', resolveTicketUrl: () => null });
    publishLane(store, 'default/l', { group: 'default/g' }, 'bot');
    const e = store.createEscalation({ laneId: 'default/l', question: 'Before the move?' }, 'bot');
    publishLane(store, 'default/l', { group: 'default/h' }, 'bot');
    store.postMessage(e.id, { from: 'owner', author: 'alice', body: 'Reply after the move' }, 'user:a');
    const in_ = (g: string) => store.groupConversation(g).items.map((i) => (i.type === 'message' ? i.body : `? ${i.question}`));
    assert.deepEqual(in_('default/g'), ['Reply after the move', '? Before the move?']);
    assert.deepEqual(in_('default/h'), []);
    store.close();
  });

  test('a group with no overseer recorded is acknowledged by any agent, never by a person', () => {
    const store = new Store({ path: ':memory:', resolveTicketUrl: () => null });
    try {
      store.upsertGroup('default/old', {}, 'bot');
      const m = store.postGroupMessage('default/old', { from: 'owner', author: 'alice', body: 'Hi' }, 'alice');
      assert.throws(() => store.ackGroupMessages('default/old', m.id, { key: 'user:1:alice', agent: false }), /Only the group's overseer acknowledges/);
      assert.equal(store.ackGroupMessages('default/old', m.id, { key: 'token:any', agent: true }), m.id);
    } finally {
      store.close();
    }
  });

  test('unacknowledged messages survive a restart, and acknowledging is idempotent', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lanesignal-ack-'));
    const file = path.join(dir, 'lanesignal.db');
    try {
      let store = new Store({ path: file, resolveTicketUrl: () => null });
      store.upsertGroup('default/g', {}, 'bot');
      const a = store.postGroupMessage('default/g', { from: 'owner', author: 'alice', body: 'a' }, 'user:a');
      const b = store.postGroupMessage('default/g', { from: 'owner', author: 'alice', body: 'b' }, 'user:a');
      store.close();
      store = new Store({ path: file, resolveTicketUrl: () => null });
      assert.deepEqual(store.unacknowledgedGroupMessages('default/g').map((m) => m.body), ['a', 'b']);
      assert.equal(store.ackGroupMessages('default/g', a.id), a.id);
      assert.equal(store.ackGroupMessages('default/g', a.id), a.id);
      // Never past the latest message, never back.
      assert.equal(store.ackGroupMessages('default/g', b.id + 1000), b.id);
      assert.equal(store.ackGroupMessages('default/g', 0), b.id);
      assert.deepEqual(store.unacknowledgedGroupMessages('default/g'), []);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('upgrading to v25: each escalation joins the conversation of the group it was raised in', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lanesignal-v24-'));
  const file = path.join(dir, 'lanesignal.db');
  try {
    let store = new Store({ path: file, resolveTicketUrl: () => null });
    publishLane(store, 'default/l', { group: 'default/g' }, 'bot');
    const onLane = store.createEscalation({ laneId: 'default/l', question: 'On the lane?' }, 'bot');
    const epic = store.listEpics({ groupId: 'default/g' })[0];
    const onEpic = store.createEscalation({ laneId: Store.epicLaneId('default', epic.id), epic: epic.id, question: 'On the epic?' }, 'bot');
    store.close();
    const db = new DatabaseSync(file);
    db.exec(`
      DROP INDEX escalations_group;
      ALTER TABLE escalations DROP COLUMN group_id;
      DROP INDEX group_messages_group_time;
      ALTER TABLE groups DROP COLUMN overseer_read_id;
      UPDATE meta SET value = '24' WHERE key = 'schema_version';`);
    db.close();
    store = new Store({ path: file, resolveTicketUrl: () => null });
    const ids = store
      .groupConversation('default/g')
      .items.filter((i) => i.type === 'escalation')
      .map((i) => i.id)
      .sort();
    assert.deepEqual(ids, [onLane.id, onEpic.id].sort());
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
