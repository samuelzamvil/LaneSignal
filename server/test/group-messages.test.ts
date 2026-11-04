import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Store } from '../src/store.ts';
import { esc as escalate, lane as publishLane } from './publish.ts';
import { UNDO_V24 } from './undo.ts';

const resolveTicketUrl = () => null;
const png = { name: 'shot.png', type: 'image/png' as const, data: new Uint8Array([137, 80, 78, 71]) };

/** A store on a file, so a test can look at its tables directly. */
function fileStore(fn: (file: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), 'lanesignal-msgs-'));
  try {
    fn(path.join(dir, 'lanesignal.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const rows = (file: string, sql: string) => {
  const db = new DatabaseSync(file);
  try {
    return db.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
};

test('every message is in one table, in its group, and each view reads the same rows', () => {
  fileStore((file) => {
    let now = Date.parse('2026-11-04T10:00:00Z');
    const store = new Store({ path: file, resolveTicketUrl, now: () => new Date((now += 1000)) });
    publishLane(store, 'default/l', { group: 'default/g' }, 'bot');
    const e = escalate(store, { laneId: 'default/l', question: 'Q?' }, 'bot');
    store.postMessage(e.id, { from: 'owner', author: 'alice', body: 'Other: wait' }, 'user:a');
    store.postLaneMessage('default/l', { from: 'agent', author: 'bot', body: 'Merged' }, 'bot');
    const epic = store.listEpics({ groupId: 'default/g' })[0];
    store.postEpicMessage(epic.id, { from: 'owner', author: 'alice', body: 'Scope?' }, 'user:a');
    store.close();

    const all = rows(file, 'SELECT group_id, escalation_id, lane_id, epic_id, body FROM group_messages ORDER BY id');
    assert.deepEqual(
      all.map((r) => [r.group_id, r.escalation_id ? 'esc' : r.lane_id ? 'lane' : r.epic_id ? 'epic' : 'group', r.body]),
      [
        ['default/g', 'esc', 'Other: wait'],
        ['default/g', 'lane', 'Merged'],
        ['default/g', 'epic', 'Scope?'],
      ],
    );
    assert.deepEqual(
      rows(file, "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('messages', 'lane_messages', 'epic_messages')"),
      [],
    );
    const reopened = new Store({ path: file, resolveTicketUrl });
    assert.deepEqual(reopened.messagesOf(e.id).map((m) => m.body), ['Other: wait']);
    assert.deepEqual(reopened.laneMessages('default/l').map((m) => m.body), ['Merged']);
    assert.deepEqual(reopened.epicMessages(epic.id).map((m) => m.body), ['Scope?']);
    reopened.close();
  });
});

test('a message stays in the group it was written in when its lane moves', () => {
  fileStore((file) => {
    const store = new Store({ path: file, resolveTicketUrl });
    publishLane(store, 'default/l', { group: 'default/a' }, 'bot');
    store.postLaneMessage('default/l', { from: 'agent', author: 'bot', body: 'In A' }, 'bot');
    publishLane(store, 'default/l', { group: 'default/b' }, 'bot');
    store.postLaneMessage('default/l', { from: 'owner', author: 'alice', body: 'In B' }, 'user:a');
    store.close();
    assert.deepEqual(
      rows(file, 'SELECT group_id, body FROM group_messages ORDER BY id').map((r) => [r.group_id, r.body]),
      [
        ['default/a', 'In A'],
        ['default/b', 'In B'],
      ],
    );
  });
});

test('upgrading to v24 moves every message, its files and what the agent has read, in time order', () => {
  fileStore((file) => {
    let now = Date.parse('2026-11-04T10:00:00Z');
    let store = new Store({ path: file, resolveTicketUrl, now: () => new Date((now += 1000)) });
    publishLane(store, 'default/l', { group: 'default/g' }, 'bot');
    const e = escalate(store, { laneId: 'default/l', question: 'Q?' }, 'bot');
    const escFile = store.addAttachment(png, 'user:a', 'alice');
    store.postMessage(e.id, { from: 'owner', author: 'alice', body: 'Other: see the shot', attachments: [escFile.id] }, 'user:a');
    const laneFile = store.addAttachment(png, 'bot', 'bot');
    store.postLaneMessage('default/l', { from: 'agent', author: 'bot', body: 'Merged', attachments: [laneFile.id] }, 'bot');
    store.postLaneMessage('default/l', { from: 'owner', author: 'alice', body: 'Read this one' }, 'user:a');
    store.takeUnreadForAgent('default/l');
    store.postLaneMessage('default/l', { from: 'owner', author: 'alice', body: 'Not this one' }, 'user:a');
    const epic = store.listEpics({ groupId: 'default/g' })[0];
    store.postEpicMessage(epic.id, { from: 'owner', author: 'alice', body: 'Scope?' }, 'user:a');
    const times = [...store.messagesOf(e.id), ...store.laneMessages('default/l'), ...store.epicMessages(epic.id)].map((m) => m.at);
    store.close();

    // Back to v23, with each table numbering its own messages (as they did), so ids change on the way up.
    const db = new DatabaseSync(file);
    db.exec(`${UNDO_V24}
      UPDATE lane_messages SET id = id + 1000;
      UPDATE attachments SET lane_message_id = lane_message_id + 1000 WHERE lane_message_id IS NOT NULL;
      UPDATE lanes SET agent_read_id = agent_read_id + 1000 WHERE agent_read_id > 0;
      UPDATE epic_messages SET id = id + 2000;
    `);
    db.close();

    store = new Store({ path: file, resolveTicketUrl });
    const thread = store.messagesOf(e.id);
    assert.deepEqual(thread.map((m) => [m.from, m.author, m.body, m.attachments.map((f) => f.name)]), [
      ['owner', 'alice', 'Other: see the shot', ['shot.png']],
    ]);
    const lane = store.laneMessages('default/l');
    assert.deepEqual(lane.map((m) => [m.body, m.attachments.length, m.seen]), [
      ['Merged', 1, undefined],
      ['Read this one', 0, true],
      ['Not this one', 0, false],
    ]);
    assert.deepEqual(store.takeUnreadForAgent('default/l').map((m) => m.body), ['Not this one']);
    assert.deepEqual(store.epicMessages(epic.id).map((m) => m.body), ['Scope?']);
    assert.deepEqual([...thread, ...lane, ...store.epicMessages(epic.id)].map((m) => m.at), times);
    // Files still resolve to where they're attached.
    assert.equal(store.getAttachment(laneFile.id)?.laneId, 'default/l');
    assert.equal(store.getAttachment(escFile.id)?.escalationId, e.id);
    store.close();

    // One table, in time order across escalation, lane and epic messages.
    assert.deepEqual(
      rows(file, 'SELECT body FROM group_messages ORDER BY id').map((r) => r.body),
      ['Other: see the shot', 'Merged', 'Read this one', 'Not this one', 'Scope?'],
    );
  });
});
