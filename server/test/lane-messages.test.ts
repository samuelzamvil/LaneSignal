// A conversation on each lane: the agent's notices (with files) and the owner's notes back. Nothing blocks.
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

const write = (lane: string, body: string) => srv.call('POST', `/api/lanes/${lane}/messages`, ALICE, { body });
const detail = async (lane: string) => (await srv.call('GET', `/api/lanes/${lane}`, ALICE)).body;

describe('lane conversations', () => {
  test("the agent's notice carries files, opens the lane from the push, and sits in the lane's conversation", async () => {
    const shot = await upload(AGENT, 'merged.png', PNG);
    const notes = await upload(AGENT, 'notes.md', '# Release notes\n');
    const res = await srv.tool(AGENT, 'notify_owner', {
      lane_id: 'talk-1',
      message: 'Merged PR #311\nDeploy goes out tonight.',
      attachments: [shot.body.id, notes.body.id],
    });
    assert.equal(res.isError, false, res.text);
    const d = await detail('talk-1');
    assert.deepEqual(
      d.messages.map((m: any) => [m.from, m.author, m.body, m.attachments.map((f: any) => f.name)]),
      [['agent', 'overseer', 'Merged PR #311\nDeploy goes out tonight.', ['merged.png', 'notes.md']]],
    );
    assert.equal(d.lane.lastAgentMessageId, d.messages[0].id);
    assert.ok(d.events.some((e: any) => e.kind === 'notice' && e.message.startsWith('Merged PR #311')));
    // People who see the lane can open its files.
    const file = await fetch(`${srv.base}/api/attachments/${shot.body.id}`, { headers: { authorization: `Bearer ${ALICE}` } });
    assert.equal(file.status, 200);
    // An attached file can't be attached again elsewhere.
    const again = await srv.call('POST', '/api/lanes/talk-2/notices', AGENT, { message: 'Same shot', attachments: [shot.body.id] });
    assert.equal(again.status, 409);
  });

  test("the push says what's attached and opens the lane", () => {
    const n: Notice = {
      project: 'default',
      laneId: 'default/talk-1',
      message: 'Merged PR #311',
      by: 'overseer',
      attachments: [{ id: 'a', name: 'merged.png', type: 'image/png', size: 10 }],
    };
    const push = noticeNotification(srv.store, n);
    assert.equal(push.urgent, false);
    assert.equal(push.route, '#/lane/default/talk-1');
    assert.equal(push.body, 'Merged PR #311\n📎 merged.png');
  });

  test("the owner's note reaches a working agent when it next publishes the lane, once", async () => {
    const res = await write('talk-2', 'Also bump the changelog');
    assert.equal(res.status, 201);
    assert.equal(res.body.seen, false);
    const before = await detail('talk-2');
    assert.equal(before.lane.unreadByAgent, 1);
    // Writing doesn't change the lane: not its status, not its freshness.
    assert.equal(before.lane.status, 'active');
    const published = await srv.tool(AGENT, 'update_lane', { lane_id: 'talk-2', activity: 'Tagging the release' });
    assert.deepEqual(
      published.value.ownerMessages.map((m: any) => [m.body, m.by]),
      [['Also bump the changelog', 'alice']],
    );
    const after = await detail('talk-2');
    assert.equal(after.lane.unreadByAgent, 0);
    assert.equal(after.messages.at(-1).seen, true);
    assert.equal((await srv.tool(AGENT, 'update_lane', { lane_id: 'talk-2', activity: 'Still tagging' })).value.ownerMessages, undefined);
    // Over HTTP too.
    await write('talk-2', 'And the README');
    const put = await srv.call('PUT', '/api/lanes/talk-2', AGENT, { activity: 'README' });
    assert.deepEqual(put.body.ownerMessages.map((m: any) => m.body), ['And the README']);
  });

  test('the agent writing on the lane gets the notes it had not seen', async () => {
    await write('talk-3', 'Hold the deploy until Monday');
    const res = await srv.tool(AGENT, 'notify_owner', { lane_id: 'talk-3', message: 'Tests green' });
    assert.deepEqual(res.value.ownerMessages.map((m: any) => m.body), ['Hold the deploy until Monday']);
    await write('talk-3', 'Thanks');
    const http = await srv.call('POST', '/api/lanes/talk-3/messages', AGENT, { body: 'Will do' });
    assert.equal(http.status, 409, 'one agent message per lane per minute');
    // Refused, so the note is still waiting for it.
    assert.equal((await detail('talk-3')).lane.unreadByAgent, 1);
    await srv.tool(AGENT, 'update_lane', { lane_id: 'talk-3' });
  });

  test('a waiting agent wakes for a note on its lanes, even with questions still open', async () => {
    await srv.tool(AGENT, 'create_escalation', { lane_id: 'talk-4', question: 'Rename the table?' });
    const waiting = srv.tool(AGENT, 'wait_for_decisions', { group_id: 'chatty', wait_seconds: 10 });
    await new Promise((r) => setTimeout(r, 100));
    await write('talk-4', 'Whatever you do, keep the old name as a view');
    const w = (await waiting).value;
    assert.equal(w.ready, true);
    assert.deepEqual(
      w.laneMessages.map((l: any) => [l.laneId, l.messages.map((m: any) => m.body)]),
      [['talk-4', ['Whatever you do, keep the old name as a view']]],
    );
    // Handed over: the next wait doesn't repeat it.
    const next = (await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'chatty', wait_seconds: 0 })).value;
    assert.deepEqual(next.laneMessages, []);
    // The HTTP wait hands notes over too.
    await write('talk-4', 'One more thing');
    const http = await srv.call('GET', '/api/wait?group=chatty&timeout=0', AGENT);
    assert.deepEqual(http.body.laneMessages[0].messages.map((m: any) => m.body), ['One more thing']);
    assert.equal((await detail('talk-4')).lane.unreadByAgent, 0);
  });

  test('limits: length, empty, removed lanes', async () => {
    assert.equal((await write('talk-5', '   ')).status, 400);
    assert.equal((await write('talk-5', 'x'.repeat(2001))).status, 400);
    assert.equal((await srv.call('POST', '/api/lanes/talk-5/messages', AGENT, { body: 'x'.repeat(501) })).status, 400);
    assert.equal((await write('nope', 'hello')).status, 404);
    await srv.call('DELETE', '/api/lanes/talk-5', ALICE);
    assert.equal((await write('talk-5', 'Are you there?')).status, 409);
  });
});

test('with answering off, people read the conversation but write in the session', async () => {
  const plain = await startServer({ LANESIGNAL_DECISIONS: 'false' });
  try {
    await plain.publish('quiet', { group: 'g' });
    assert.equal((await plain.call('POST', '/api/lanes/quiet/notices', AGENT, { message: 'Merged' })).status, 201);
    assert.equal((await plain.call('POST', '/api/lanes/quiet/messages', ALICE, { body: 'Nice' })).status, 404);
    assert.equal((await plain.call('GET', '/api/lanes/quiet', ALICE)).body.messages.length, 1);
  } finally {
    plain.close();
  }
});

test('lane conversations export as lane_messages', async () => {
  const s = await startServer();
  try {
    await s.publish('exported', { group: 'g' });
    await s.call('POST', '/api/lanes/exported/notices', AGENT, { message: 'Merged PR #9' });
    await s.call('POST', '/api/lanes/exported/messages', ALICE, { body: 'Great' });
    const csv = (await s.call('GET', '/api/export/lane_messages.csv', ALICE)).body as string;
    const lines = csv.trim().split('\r\n');
    assert.equal(lines[0], 'id,project,lane_id,from,author,body,attachments,at');
    assert.match(lines[1], /^\d+,default,exported,agent,overseer,Merged PR #9,,/);
    assert.match(lines[2], /,owner,alice,Great,,/);
  } finally {
    s.close();
  }
});
