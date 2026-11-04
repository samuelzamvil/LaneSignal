// A group's conversation: people write to the group, its overseer hears them through its group wait
// and acknowledges them, and anyone reads it back newest first, escalations included.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { Store } from '../src/store.ts';
import { AGENT, ALICE, startServer } from './helpers.ts';
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

  test('only the overseer acknowledges: a person\'s ack is ignored', async () => {
    await srv.call('PUT', '/api/groups/owned', AGENT, {});
    const m = (await say('owned', { body: 'For the overseer' })).body;
    await srv.call('GET', `/api/updates?group=owned&ack=${m.id}`, ALICE);
    assert.equal((await srv.call('POST', '/api/groups/owned/ack', ALICE, { upTo: m.id })).status, 403);
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
    const epic = store.upsertEpic('default', { groupId: 'default/g', ref: '700' }, 'bot');
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

test("upgrading to v26: a stand-in epic's questions, board and status line become its group's", () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lanesignal-v25-'));
  const file = path.join(dir, 'lanesignal.db');
  try {
    let store = new Store({ path: file, resolveTicketUrl: () => null });
    publishLane(store, 'default/slot', { group: 'default/grp', ticket: null }, 'bot');
    const loose = store.createEscalation({ laneId: 'default/slot', question: 'Which ticket next?' }, 'bot');
    const direct = store.createEscalation({ laneId: Store.groupLaneId('default/grp'), question: 'Freeze on Friday?' }, 'bot');
    store.close();
    // Back to v25, where the group stood in as its own epic and held these on it.
    const db = new DatabaseSync(file);
    db.exec(`
      INSERT INTO epics (num, project_id, group_id, ref, display_ref, code_ref, name, links, state, stand_in, status_line, agent_read_id, created_at, updated_at)
        VALUES (77, 'default', 'default/grp', NULL, NULL, 'grp', 'Grp', '[]', 'open', 1, 'Two lanes busy', 0, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
      INSERT INTO lanes (id, name, group_id, status, links, created_at, updated_at, status_since)
        VALUES ('default/~epic-77', 'Grp', 'default/grp', 'idle', '[]', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
      UPDATE escalations SET epic_id = 77 WHERE id = '${loose.id}';
      UPDATE escalations SET epic_id = 77, lane_id = 'default/~epic-77' WHERE id = '${direct.id}';
      UPDATE lane_events SET lane_id = 'default/~epic-77' WHERE lane_id = 'default/~group-grp';
      DELETE FROM lanes WHERE id = 'default/~group-grp';
      INSERT INTO group_messages (id, group_id, epic_id, author_kind, author, body, created_at)
        VALUES (500, 'default/grp', 77, 'owner', 'alice', 'Read already', '2026-11-01T00:00:01.000Z'),
               (501, 'default/grp', 77, 'owner', 'alice', 'Not read yet', '2026-11-01T00:00:02.000Z');
      UPDATE epics SET agent_read_id = 500 WHERE num = 77;
      ALTER TABLE groups DROP COLUMN code_ref;
      ALTER TABLE groups DROP COLUMN status_line;
      UPDATE meta SET value = '25' WHERE key = 'schema_version';`);
    db.close();

    store = new Store({ path: file, resolveTicketUrl: () => null });
    assert.deepEqual(store.listEpics({ groupId: 'default/grp', states: ['open', 'close_requested', 'closed'] }), []);
    const g = store.getGroup('default/grp')!;
    assert.deepEqual([g.code, g.statusLine, g.openEscalations], ['grp', 'Two lanes busy', 2]);
    for (const [id, ref] of [
      [loose.id, loose.ref],
      [direct.id, direct.ref],
    ]) {
      const e = store.getEscalation(id)!;
      assert.deepEqual([e.epicId, e.ticketId, e.group, e.ref], [null, null, 'default/grp', ref], 'codes kept');
    }
    assert.equal(store.getEscalation(direct.id)?.laneId, Store.groupLaneId('default/grp'));
    // The board's notes are the group's now; the one the overseer had read stays read.
    assert.deepEqual(store.unacknowledgedGroupMessages('default/grp').map((m) => m.body), ['Not read yet']);
    // New questions carry on the group's code.
    const next = store.createEscalation({ laneId: Store.groupLaneId('default/grp'), question: 'And next?' }, 'bot');
    assert.match(next.ref, /^grp[A-Z]$/);
    assert.notEqual(next.ref, loose.ref);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
