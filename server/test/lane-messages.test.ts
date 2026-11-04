// Milestones on lanes (notify_owner) go to the group's conversation; lanes' own conversations are retired.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { noticeNotification } from '../src/notify.ts';
import type { Notice } from '../src/types.ts';
import { AGENT, ALICE, startServer } from './helpers.ts';

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  srv = await startServer();
  for (const id of ['talk-1', 'talk-2', 'talk-3', 'talk-4', 'talk-5']) await srv.publish(id, { group: 'chatty' });
});
after(() => srv.close());

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]);

async function upload(token: string, name: string, data: Uint8Array | string) {
  const form = new FormData();
  form.append('file', new Blob([typeof data === 'string' ? data : new Uint8Array(data)]), name);
  const res = await fetch(`${srv.base}/api/attachments`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  return { status: res.status, body: (await res.json()) as any };
}

const conversation = async (group: string) => (await srv.call('GET', `/api/groups/${group}/conversation`, ALICE)).body.items;

describe('milestones (notify_owner)', () => {
  test("go to the lane's group's conversation, with files, a quiet push, and a line in the lane's history", async () => {
    const shot = await upload(AGENT, 'merged.png', PNG);
    const notes = await upload(AGENT, 'notes.md', '# Release notes\n');
    const res = await srv.tool(AGENT, 'notify_owner', {
      lane_id: 'talk-1',
      message: 'Merged PR #311\nDeploy goes out tonight.',
      attachments: [shot.body.id, notes.body.id],
    });
    assert.equal(res.isError, false, res.text);
    assert.deepEqual(Object.keys(res.value).sort(), ['at', 'laneId']);
    const items = await conversation('chatty');
    assert.deepEqual(
      items.map((m: any) => [m.type, m.from, m.author, m.body, m.laneId, m.attachments.map((f: any) => f.name)]),
      [['message', 'agent', 'overseer', 'Merged PR #311\nDeploy goes out tonight.', null, ['merged.png', 'notes.md']]],
    );
    const group = (await srv.call('GET', '/api/groups', ALICE)).body.find((g: any) => g.id === 'chatty');
    assert.equal(group.lastAgentMessageId, items[0].id);
    // The lane's history keeps it; the lane has no conversation of its own.
    assert.ok(srv.store.laneEvents('default/talk-1').some((e) => e.kind === 'notice' && e.message.startsWith('Merged PR #311')));
    assert.equal((await srv.call('GET', '/api/lanes/talk-1', ALICE)).body.messages, undefined);
    // People who see the group can open its files.
    const file = await fetch(`${srv.base}/api/attachments/${shot.body.id}`, { headers: { authorization: `Bearer ${ALICE}` } });
    assert.equal(file.status, 200);
    // One a minute per group: put everything in one message.
    const again = await srv.call('POST', '/api/lanes/talk-2/notices', AGENT, { message: 'And another' });
    assert.equal(again.status, 409);
  });

  test("the push says what's attached and opens the group's conversation", () => {
    const n: Notice = {
      project: 'default',
      groupId: 'default/chatty',
      laneId: 'default/talk-1',
      message: 'Merged PR #311',
      by: 'overseer',
      attachments: [{ id: 'a', name: 'merged.png', type: 'image/png', size: 10 }],
    };
    const push = noticeNotification(srv.store, n);
    assert.equal(push.urgent, false);
    assert.equal(push.route, '#/group/default/chatty');
    assert.match(push.title, /talk-1|Talk 1/i);
    assert.equal(push.body, 'Merged PR #311\n📎 merged.png');
    assert.equal(noticeNotification(srv.store, { ...n, laneId: undefined }).title, 'chatty');
  });

  test("lanes' conversations are retired", async () => {
    const res = await srv.call('POST', '/api/lanes/talk-3/messages', ALICE, { body: 'Hold the deploy' });
    assert.equal(res.status, 410);
    assert.match(res.body.error, /group's conversation/);
    const published = await srv.tool(AGENT, 'update_lane', { lane_id: 'talk-3', activity: 'Tagging' });
    assert.equal(published.value.ownerMessages, undefined);
  });
});

test('with answering off, agents still post milestones', async () => {
  const plain = await startServer({ LANESIGNAL_DECISIONS: 'false' });
  try {
    await plain.publish('quiet', { group: 'g' });
    assert.equal((await plain.call('POST', '/api/lanes/quiet/notices', AGENT, { message: 'Merged' })).status, 201);
    assert.equal((await plain.call('POST', '/api/groups/g/messages', ALICE, { body: 'Nice' })).status, 404);
    assert.deepEqual((await plain.call('GET', '/api/groups/g/conversation', ALICE)).body.items.map((i: any) => i.body), ['Merged']);
  } finally {
    plain.close();
  }
});

test('the lane page keeps every unresolved escalation, however many closed ones follow', async () => {
  // Holding no ticket: the lane lists the questions raised on it (its group's epic's), not a ticket's.
  await srv.publish('busy-lane', { ticket: null });
  const open = (await srv.call('POST', '/api/escalations', AGENT, { laneId: 'busy-lane', question: 'Still open?' })).body;
  for (let i = 0; i < 51; i++) {
    const e = (await srv.call('POST', '/api/escalations', AGENT, { laneId: 'busy-lane', question: `Done ${i}?`, blocking: false })).body;
    await srv.call('POST', `/api/escalations/${e.id}/withdraw`, AGENT, { note: 'Settled.' });
  }
  const escs = (await srv.call('GET', '/api/lanes/busy-lane', ALICE)).body.escalations;
  assert.equal(escs.length, 51, 'the open one plus the latest 50 closed');
  assert.equal(escs[0].id, open.id, 'oldest first');
  assert.equal(escs.filter((e: { state: string }) => e.state === 'withdrawn').length, 50);
});
