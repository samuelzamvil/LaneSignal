// Other opens a conversation: the owner's instructions reach the agent, which acts on them or replies.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { AGENT, ALICE, REVIEWER, startServer } from './helpers.ts';

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  srv = await startServer();
  await srv.publish('chat', { group: 'payments' });
});
after(() => srv.close());

const ask = async (question: string) => (await srv.tool(AGENT, 'create_escalation', { lane_id: 'chat', question })).value;
const lane = async () => (await srv.call('GET', '/api/lanes/chat', ALICE)).body.lane;
const other = (id: string, note: string) => srv.call('POST', `/api/escalations/${id}/decide`, ALICE, { decision: 'Other', note });
const wait = async () => (await srv.tool(AGENT, 'wait_for_decisions', { format: 'full', group_id: 'payments', wait_seconds: 0 })).value;

describe('conversations', () => {
  test('Other hands the turn to the agent, and its reply hands it back', async () => {
    const e = await ask('Ship the new checkout?');
    assert.equal((await lane()).status, 'blocked_human');
    const res = await other(e.id, 'Only behind a flag');
    assert.equal(res.body.turn, 'agent');
    // The lane shows the agent working while it's the agent's turn.
    assert.equal((await lane()).status, 'awaiting_agent');
    const w = await wait();
    assert.equal(w.ready, true);
    assert.deepEqual(
      w.replies.map((r: any) => [r.ref, r.messages.map((m: any) => m.body)]),
      [[e.ref, ['Only behind a flag']]],
    );
    const reply = await srv.tool(AGENT, 'reply_to_escalation', { id: e.ref, message: 'Flag name: checkout_v2. OK?' });
    assert.equal(reply.isError, false, reply.text);
    assert.equal((await lane()).status, 'blocked_human');
    const full = (await srv.call('GET', `/api/escalations/${e.id}`, ALICE)).body;
    assert.equal(full.turn, 'owner');
    assert.deepEqual(
      full.messages.map((m: any) => [m.from, m.body]),
      [
        ['owner', 'Only behind a flag'],
        ['agent', 'Flag name: checkout_v2. OK?'],
      ],
    );
    assert.equal((await srv.tool(AGENT, 'get_escalation', { id: e.ref })).value.messages.length, 2);
    // Only new owner messages come back.
    await srv.call('POST', `/api/escalations/${e.id}/messages`, ALICE, { body: 'Call it checkout_next' });
    assert.deepEqual((await wait()).replies.find((r: any) => r.id === e.id).messages.map((m: any) => m.body), ['Call it checkout_next']);
    // Acknowledging takes the owner's latest instructions as the decision.
    const ack = await srv.tool(AGENT, 'acknowledge_escalation', { id: e.ref, status: 'active', activity: 'Adding checkout_next' });
    assert.equal(ack.isError, false, ack.text);
    const closed = (await srv.call('GET', `/api/escalations/${e.id}`, ALICE)).body;
    assert.equal(closed.state, 'acknowledged');
    assert.equal(closed.decision, 'Other');
    assert.equal(closed.decisionNote, 'Call it checkout_next');
    assert.equal(closed.decidedBy, 'alice');
    assert.equal((await lane()).status, 'active');
  });

  test('agent messages are short; longer goes in a file', async () => {
    const e = await ask('Which cache?');
    const long = await srv.tool(AGENT, 'reply_to_escalation', { id: e.ref, message: 'x'.repeat(501) });
    assert.equal(long.isError, true);
    assert.match(long.text, /under 500 characters: attach a file/);
    // An update while it's the owner's turn keeps it theirs.
    await srv.tool(AGENT, 'reply_to_escalation', { id: e.ref, message: 'Benchmarks done: Redis is 2x faster.' });
    assert.equal((await srv.call('GET', `/api/escalations/${e.id}`, ALICE)).body.turn, 'owner');
    assert.equal((await lane()).status, 'blocked_human');
  });

  test("only the raising agent replies, and only while it's open", async () => {
    const e = await ask('Retry policy?');
    const theirs = await srv.tool(REVIEWER, 'reply_to_escalation', { id: e.ref, message: 'mine now' });
    assert.match(theirs.text, /only that agent \(or a person\) can reply to it/);
    await srv.call('POST', `/api/escalations/${e.id}/decide`, ALICE, { decision: 'Accept' });
    const late = await srv.tool(AGENT, 'reply_to_escalation', { id: e.ref, message: 'thanks' });
    assert.match(late.text, /the conversation is closed/);
  });

  test('a single-escalation wait wakes on Other', async () => {
    const e = await ask('Wait on me?');
    const waiting = srv.call('GET', `/api/escalations/${e.id}?wait=5`, AGENT);
    await new Promise((r) => setTimeout(r, 50));
    await other(e.id, 'Do it on Monday');
    const started = Date.now();
    const res = await waiting;
    assert.ok(Date.now() - started < 2000);
    assert.equal(res.body.turn, 'agent');
    await srv.tool(AGENT, 'acknowledge_escalation', { id: e.ref });
  });

  test('acknowledging keeps every instruction since the agent last wrote', async () => {
    const e = await ask('Tidy the schema?');
    await other(e.id, 'Drop the unused index');
    await srv.call('POST', `/api/escalations/${e.id}/messages`, ALICE, { body: 'And rename the column' });
    const ack = await srv.tool(AGENT, 'acknowledge_escalation', { id: e.ref });
    assert.equal(ack.value.decisionNote, 'Drop the unused index\n\nAnd rename the column');
  });

  test('acknowledging after the agent replied takes the owner\'s latest instructions', async () => {
    await srv.publish('rename', { group: 'payments' });
    const status = async () => (await srv.call('GET', '/api/lanes/rename', ALICE)).body.lane.status;
    const e = (await srv.tool(AGENT, 'create_escalation', { lane_id: 'rename', question: 'Rename the queue?' })).value;
    await other(e.id, 'Call it jobs');
    await srv.call('POST', `/api/escalations/${e.id}/messages`, ALICE, { body: 'Keep the old name as an alias' });
    await srv.tool(AGENT, 'reply_to_escalation', { id: e.ref, message: 'On it: jobs, with an alias.' });
    assert.equal(await status(), 'blocked_human');
    const ack = await srv.tool(AGENT, 'acknowledge_escalation', { id: e.ref });
    assert.equal(ack.isError, false, ack.text);
    assert.equal(ack.value.state, 'acknowledged');
    assert.equal(ack.value.decision, 'Other');
    assert.equal(ack.value.decisionNote, 'Call it jobs\n\nKeep the old name as an alias');
    // The reply had put the lane back to blocked; acknowledging releases it.
    assert.equal(await status(), 'awaiting_agent');
    // With no instructions from the owner, an open escalation still can't be acknowledged.
    const unanswered = (await srv.tool(AGENT, 'create_escalation', { lane_id: 'rename', question: 'Untouched?' })).value;
    const early = await srv.tool(AGENT, 'acknowledge_escalation', { id: unanswered.ref });
    assert.match(early.text, /is open; expected decided/);
    // An FYI re-raised as blocking goes back to the owner: notes on the FYI don't answer it.
    const fyi = (await srv.tool(AGENT, 'create_escalation', { lane_id: 'rename', question: 'FYI: queue is slow', blocking: false })).value;
    await other(fyi.id, 'Noted, ignore for now');
    await srv.tool(AGENT, 'create_escalation', { lane_id: 'rename', question: 'FYI: queue is slow', blocking: true });
    const stale = await srv.tool(AGENT, 'acknowledge_escalation', { id: fyi.ref });
    assert.match(stale.text, /is open; expected decided/);
  });

  test("dismissing during the agent's turn puts the lane back to work", async () => {
    await srv.publish('quiet', { group: 'payments' });
    const e = (await srv.tool(AGENT, 'create_escalation', { lane_id: 'quiet', question: 'Dismiss me?' })).value;
    await other(e.id, 'Not needed');
    const quiet = async () => (await srv.call('GET', '/api/lanes/quiet', ALICE)).body.lane.status;
    assert.equal(await quiet(), 'awaiting_agent');
    await srv.tool(AGENT, 'dismiss_escalation', { id: e.ref, justification: 'Owner: not needed' });
    assert.equal(await quiet(), 'active');
  });

  test("an FYI raised as blocking during the agent's turn goes back to the owner", async () => {
    const fyi = (await srv.tool(AGENT, 'create_escalation', { lane_id: 'chat', question: 'FYI: slow CI', blocking: false })).value;
    await other(fyi.id, 'Why?');
    const upgraded = await srv.tool(AGENT, 'create_escalation', { lane_id: 'chat', question: 'FYI: slow CI' });
    assert.equal(upgraded.value.upgraded, true);
    const got = (await srv.call('GET', `/api/escalations/${fyi.id}`, ALICE)).body;
    assert.equal(got.turn, 'owner');
    assert.equal((await lane()).status, 'blocked_human');
    // Asking a blocking question again during the agent's turn points at replying instead.
    const e = await ask('Again?');
    await other(e.id, 'Explain');
    const again = await srv.tool(AGENT, 'create_escalation', { lane_id: 'chat', question: 'Again?' });
    assert.match(again.text, /reply with reply_to_escalation/);
  });

  test('a retried reply is sent once; updates are one a minute', async () => {
    const e = await ask('Retry me?');
    await other(e.id, 'Explain');
    await srv.tool(AGENT, 'reply_to_escalation', { id: e.ref, message: 'Because of X.' });
    await srv.tool(AGENT, 'reply_to_escalation', { id: e.ref, message: 'Because of X.' });
    assert.equal((await srv.call('GET', `/api/escalations/${e.id}`, ALICE)).body.messageCount, 2);
    const flood = await srv.tool(AGENT, 'reply_to_escalation', { id: e.ref, message: 'Also Y.' });
    assert.match(flood.text, /One update a minute/);
  });

  test('conversations are exported', async () => {
    const csv = (await srv.call('GET', '/api/export/messages.csv', ALICE)).body as string;
    assert.ok(csv.startsWith('id,escalation_id,escalation_ref,project,lane_id,from,author,body,attachments,at'));
    assert.match(csv, /Only behind a flag/);
  });
});
