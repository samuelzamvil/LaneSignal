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

const exec = (file: string, sql: string) => {
  const db = new DatabaseSync(file);
  try {
    db.exec(sql);
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
    store.postNotice('default/l', 'Merged', 'bot');
    store.postGroupMessage('default/g', { from: 'owner', author: 'alice', body: 'Next?' }, 'user:a');
    store.close();

    const all = rows(file, 'SELECT group_id, escalation_id, lane_id, epic_id, body FROM group_messages ORDER BY id');
    assert.deepEqual(
      all.map((r) => [r.group_id, r.escalation_id ? 'esc' : r.lane_id ? 'lane' : r.epic_id ? 'epic' : 'group', r.body]),
      [
        ['default/g', 'esc', 'Other: wait'],
        // A milestone records the lane it's about.
        ['default/g', 'lane', 'Merged'],
        ['default/g', 'group', 'Next?'],
      ],
    );
    assert.deepEqual(
      rows(file, "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('messages', 'lane_messages', 'epic_messages')"),
      [],
    );
    const reopened = new Store({ path: file, resolveTicketUrl });
    assert.deepEqual(reopened.messagesOf(e.id).map((m) => m.body), ['Other: wait']);
    assert.deepEqual(
      reopened.groupConversation('default/g').items.map((i) => (i.type === 'message' ? i.body : `? ${i.question}`)),
      ['Next?', 'Merged', 'Other: wait', '? Q?'],
    );
    reopened.close();
  });
});

test('a message stays in the group it was written in when its lane moves', () => {
  fileStore((file) => {
    const store = new Store({ path: file, resolveTicketUrl });
    publishLane(store, 'default/l', { group: 'default/a' }, 'bot');
    store.postNotice('default/l', 'In A', 'bot');
    publishLane(store, 'default/l', { group: 'default/b' }, 'bot');
    store.postNotice('default/l', 'In B', 'bot');
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

/**
 * A v23 database with lane and epic conversations, as lanes and epics had them then: each table numbering
 * its own messages, files linked by those numbers.
 */
function seedV23(file: string) {
  let now = Date.parse('2026-11-04T10:00:00Z');
  const store = new Store({ path: file, resolveTicketUrl, now: () => new Date((now += 1000)) });
  publishLane(store, 'default/l', { group: 'default/g' }, 'bot');
  const e = escalate(store, { laneId: 'default/l', question: 'Q?' }, 'bot');
  const escFile = store.addAttachment(png, 'user:a', 'alice');
  store.postMessage(e.id, { from: 'owner', author: 'alice', body: 'Other: see the shot', attachments: [escFile.id] }, 'user:a');
  const laneFile = store.addAttachment(png, 'bot', 'bot');
  const epic = store.upsertEpic('default', { groupId: 'default/g', ref: '700' }, 'bot');
  store.close();
  exec(
    file,
    `${UNDO_V24}
     INSERT INTO lane_messages (id, lane_id, author_kind, author, body, created_at) VALUES
       (1001, 'default/l', 'agent', 'bot', 'Merged', '2026-11-04T10:01:00.000Z'),
       (1002, 'default/l', 'owner', 'alice', 'Thanks', '2026-11-04T10:02:00.000Z');
     UPDATE attachments SET lane_message_id = 1001, position = 0 WHERE id = '${laneFile.id}';
     INSERT INTO epic_messages (id, epic_id, author_kind, author, body, created_at) VALUES
       (2001, ${epic.id}, 'owner', 'alice', 'Scope?', '2026-11-04T10:03:00.000Z');`,
  );
  return { escalationId: e.id, escFile: escFile.id, laneFile: laneFile.id, epicId: epic.id };
}

test('upgrading to v24 moves every message and its files into the group\'s conversation, in time order', () => {
  fileStore((file) => {
    const seeded = seedV23(file);
    const before = rows(file, 'SELECT created_at FROM lane_messages UNION ALL SELECT created_at FROM epic_messages');

    const store = new Store({ path: file, resolveTicketUrl });
    const thread = store.messagesOf(seeded.escalationId);
    assert.deepEqual(thread.map((m) => [m.from, m.author, m.body, m.attachments.map((f) => f.name)]), [
      ['owner', 'alice', 'Other: see the shot', ['shot.png']],
    ]);
    const messages = store
      .groupConversation('default/g')
      .items.filter((i) => i.type === 'message')
      .map((i) => (i.type === 'message' ? [i.body, i.laneId, i.epicId, i.attachments.length] : []));
    assert.deepEqual(messages, [
      ['Scope?', null, seeded.epicId, 0],
      ['Thanks', 'default/l', null, 0],
      ['Merged', 'default/l', null, 1],
      ['Other: see the shot', null, null, 1],
    ]);
    // Files still resolve to where they're attached.
    assert.equal(store.getAttachment(seeded.laneFile)?.laneId, 'default/l');
    assert.equal(store.getAttachment(seeded.escFile)?.escalationId, seeded.escalationId);
    store.close();
    const after = rows(file, "SELECT created_at FROM group_messages WHERE lane_id IS NOT NULL OR epic_id IS NOT NULL ORDER BY id");
    assert.deepEqual(after.map((r) => r.created_at), before.map((r) => r.created_at));
  });
});

test('upgrading to v24 keeps each table\'s order when the clock went back between messages', () => {
  fileStore((file) => {
    const store = new Store({ path: file, resolveTicketUrl });
    publishLane(store, 'default/l', { group: 'default/g' }, 'bot');
    store.close();
    // The second note was stamped earlier than the first (a restart with the clock behind).
    exec(
      file,
      `${UNDO_V24}
       INSERT INTO lane_messages (id, lane_id, author_kind, author, body, created_at) VALUES
         (1, 'default/l', 'owner', 'alice', 'First', '2026-11-04T10:00:10.000Z'),
         (2, 'default/l', 'owner', 'alice', 'Second', '2026-11-04T10:00:05.000Z');`,
    );
    new Store({ path: file, resolveTicketUrl }).close();
    assert.deepEqual(rows(file, 'SELECT body FROM group_messages ORDER BY id').map((r) => r.body), ['First', 'Second']);
  });
});

test('upgrading to v24: a message on a lane in no group goes to its project\'s Ungrouped group', () => {
  fileStore((file) => {
    const store = new Store({ path: file, resolveTicketUrl });
    publishLane(store, 'default/l', { group: 'default/g' }, 'bot');
    store.close();
    exec(
      file,
      `${UNDO_V24}
       INSERT INTO lane_messages (lane_id, author_kind, author, body, created_at) VALUES ('default/l', 'agent', 'bot', 'Old notice', '2026-11-04T10:00:00.000Z');
       UPDATE lanes SET group_id = NULL WHERE id = 'default/l';`,
    );
    new Store({ path: file, resolveTicketUrl }).close();
    assert.deepEqual(rows(file, 'SELECT group_id FROM group_messages').map((r) => r.group_id), ['default/ungrouped']);
  });
});
