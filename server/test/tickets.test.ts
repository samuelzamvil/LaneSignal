// Tickets own their escalations and status history; lanes are slots that hold one at a time.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ticketRefs } from '../src/tickets.ts';
import { AGENT, ALICE, REVIEWER, startServer } from './helpers.ts';

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  srv = await startServer({
    LANESIGNAL_TICKET_TEMPLATES: 'redmine=https://redmine.example/issues/{id},gh=https://github.com/o/r/issues/{id}',
  });
  await srv.call('PUT', '/api/groups/train', AGENT, { name: 'Train' });
});
after(() => srv.close());

const fill = (args: Record<string, unknown>, token = AGENT) => srv.tool(token, 'fill_lane', args);
const lane = async (id: string) => (await srv.call('GET', `/api/lanes/${id}`, ALICE)).body.lane;
const ticket = async (ref: string) => (await srv.tool(AGENT, 'get_ticket', { ticket: ref })).value;
const ask = async (laneId: string, question: string, extra: Record<string, unknown> = {}, token = AGENT) =>
  (await srv.tool(token, 'create_escalation', { lane_id: laneId, question, ...extra }, )).value;

describe('ticket refs', () => {
  const refs = ticketRefs({ redmine: 'https://redmine.example/issues/{id}', gh: 'https://github.com/o/r/issues/{id}' }, 'redmine');
  test('every form of a ref has one canonical form', () => {
    for (const raw of ['967', '#967', 'redmine:967', 'Redmine:#967', ' redmine: 967 ', 'https://redmine.example/issues/967']) {
      assert.equal(refs.canonical(raw), 'redmine:967', raw);
    }
    assert.equal(refs.canonical('GH:12'), 'gh:12');
    assert.equal(refs.canonical('https://github.com/o/r/issues/12'), 'gh:12');
    assert.equal(refs.canonical('jira:ABC-1'), 'jira:ABC-1');
    assert.equal(refs.canonical('https://elsewhere.example/x/1'), 'https://elsewhere.example/x/1');
    assert.equal(refs.display('redmine:967'), '967');
    assert.equal(refs.display('gh:12'), 'gh:12');
    // No templates: just the number.
    assert.equal(ticketRefs({}, null).canonical('#42'), '42');
  });
});

describe('tickets', () => {
  test('a lane parks a ticket for a bug fix, then takes it back with its history', async () => {
    assert.equal((await fill({ lane_id: 'slot-a', group: 'train', ticket: '500', status: 'active' })).isError, false);
    const q = await ask('slot-a', 'Vendor API key?');
    assert.equal(q.ref, '500A');
    assert.equal((await lane('slot-a')).status, 'blocked_human');

    // Blocked on the owner: ice 500, pull in the bug fix.
    const missing = await fill({ lane_id: 'slot-a', ticket: '501' });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /holds 500: say what happens to it with previous/);
    const noReason = await fill({ lane_id: 'slot-a', ticket: '501', previous: 'park' });
    assert.match(noReason.text, /Say why 500 is parked/);
    const fixed = await fill({ lane_id: 'slot-a', ticket: '#501', previous: 'park', reason: 'waiting on the vendor API key', status: 'active' });
    assert.equal(fixed.isError, false, fixed.text);
    const a = await lane('slot-a');
    assert.equal(a.ticket, '#501');
    assert.equal(a.status, 'active', "500's open question doesn't block the slot");
    assert.equal(a.blockingEscalations, 0);
    const parked = await ticket('redmine:500');
    assert.equal(parked.state, 'parked');
    assert.equal(parked.parkReason, 'waiting on the vendor API key');
    assert.equal(parked.lane, undefined);
    assert.deepEqual(parked.escalations.map((e: any) => [e.ref, e.state]), [['500A', 'open']]);
    // The question stays in the owner's inbox.
    const inbox = (await srv.call('GET', '/api/escalations', ALICE)).body;
    assert.ok(inbox.some((e: any) => e.ref === '500A' && e.state === 'open'));
    assert.equal((await ask('slot-a', 'Hotfix or wait for the release?', { blocking: false })).ref, '501A');

    // Answering the parked question leaves the slot alone.
    await srv.call('POST', `/api/escalations/${q.id}/decide`, ALICE, { decision: 'Accept', note: 'Key is in the vault' });
    assert.equal((await lane('slot-a')).status, 'active');

    // 501 is done: the slot takes 500 back, waiting on the agent to pick up the answer.
    const back = await fill({ lane_id: 'slot-a', ticket: 'https://redmine.example/issues/500', previous: 'done' });
    assert.equal(back.isError, false, back.text);
    const again = await lane('slot-a');
    assert.equal(again.ticket, 'https://redmine.example/issues/500');
    assert.equal(again.status, 'awaiting_agent');
    assert.equal((await ticket('501')).state, 'done');
    const t500 = await ticket('500');
    assert.equal(t500.state, 'in_lane');
    assert.equal(t500.lane, 'slot-a');
    assert.deepEqual(t500.lanes, ['slot-a']);
    const history = t500.history.map((h: any) => h.message);
    assert.ok(history.includes('Parked 500: waiting on the vendor API key'));
    assert.ok(history.some((m: string) => m.startsWith('Escalated 500A')));
    assert.ok(!history.some((m: string) => m.includes('501A')), "501's questions stay with 501");
    // 501's FYI went with it: done, so its unanswered question was withdrawn.
    const t501 = await ticket('501');
    assert.deepEqual(t501.escalations.map((e: any) => [e.ref, e.state]), [['501A', 'withdrawn']]);
    assert.match(t501.escalations[0].resolution, /501 done by overseer/);
    // Acknowledging the parked-time answer works as ever, and the ticket's next question continues its letters.
    assert.equal((await srv.tool(AGENT, 'acknowledge_escalation', { id: '500a', status: 'active' })).isError, false);
    assert.equal((await ask('slot-a', 'Rotate the old key?')).ref, '500B');
  });

  test('a ticket is in one lane at a time, whichever way it is written', async () => {
    await fill({ lane_id: 'slot-b', group: 'train', ticket: 'redmine:600' });
    const taken = await fill({ lane_id: 'slot-c', group: 'train', ticket: '#600' });
    assert.equal(taken.isError, true);
    assert.match(taken.text, /600 is in lane "slot-b"/);
    const http = await srv.call('PUT', '/api/lanes/slot-c/fill', AGENT, { group: 'train', ticket: 'https://redmine.example/issues/600' });
    assert.equal(http.status, 409);
    // Refilling a lane with the ticket it holds is a plain update: no previous needed.
    const same = await fill({ lane_id: 'slot-b', ticket: '600', activity: 'Writing tests' });
    assert.equal(same.isError, false, same.text);
    assert.equal((await lane('slot-b')).activity, 'Writing tests');
  });

  test('a parked ticket can come back in any lane, its questions with it', async () => {
    await fill({ lane_id: 'slot-d', group: 'train', ticket: '610' });
    const q = await ask('slot-d', 'Which region?');
    await fill({ lane_id: 'slot-d', previous: 'park', reason: 'waiting on infra' });
    const d = await lane('slot-d');
    assert.equal(d.ticket, null);
    assert.equal(d.status, 'idle');
    await fill({ lane_id: 'slot-e', group: 'train', ticket: '610' });
    const e = await lane('slot-e');
    assert.equal(e.status, 'blocked_human');
    assert.equal(e.blockingEscalations, 1);
    const moved = (await srv.call('GET', `/api/escalations/${q.id}`, ALICE)).body;
    assert.equal(moved.laneId, 'slot-e');
    assert.deepEqual((await ticket('610')).lanes, ['slot-d', 'slot-e']);
  });

  test('update_lane with another ticket parks the old one and says so', async () => {
    await srv.tool(AGENT, 'update_lane', { lane_id: 'slot-f', group: 'train', ticket: '620' });
    const res = await srv.tool(AGENT, 'update_lane', { lane_id: 'slot-f', ticket: '621' });
    assert.equal(res.isError, false, res.text);
    assert.match(res.value.warning, /Parked 620.*fill_lane/);
    const old = await ticket('620');
    assert.equal(old.state, 'parked');
    assert.equal(old.parkReason, 'switched (legacy call)');
    // A pull request is no ticket.
    const pr = await srv.tool(AGENT, 'update_lane', { lane_id: 'slot-f', ticket: 'gh:77' });
    assert.match(pr.value.warning, /PRs go in links, never ticket/);
  });

  test('completed finishes the ticket and leaves the slot idle', async () => {
    await fill({ lane_id: 'slot-g', group: 'train', ticket: '630' });
    const fyi = await ask('slot-g', 'FYI: flaky test', { blocking: false });
    const res = await srv.tool(AGENT, 'update_lane', { lane_id: 'slot-g', status: 'completed' });
    assert.equal(res.value.status, 'idle');
    const g = await lane('slot-g');
    assert.equal(g.ticket, null);
    assert.equal(g.ticketId, null);
    const done = await ticket('630');
    assert.equal(done.state, 'done');
    assert.equal(done.status, 'completed');
    assert.equal((await srv.call('GET', `/api/escalations/${fyi.id}`, ALICE)).body.state, 'withdrawn');
  });

  test('remove_lane parks its ticket by default, or lets it go as told', async () => {
    await fill({ lane_id: 'slot-h', group: 'train', ticket: '640' });
    const q = await ask('slot-h', 'Keep going?');
    assert.equal((await srv.tool(AGENT, 'remove_lane', { lane_id: 'slot-h' })).isError, false);
    const parked = await ticket('640');
    assert.equal(parked.state, 'parked');
    assert.equal(parked.parkReason, 'Lane removed');
    assert.equal((await srv.call('GET', `/api/escalations/${q.id}`, ALICE)).body.state, 'open', 'a parked ticket keeps its questions');
    await fill({ lane_id: 'slot-i', group: 'train', ticket: '641' });
    const gone = await ask('slot-i', 'Still needed?');
    assert.equal((await srv.call('DELETE', '/api/lanes/slot-i?previous=drop&reason=superseded', AGENT)).status, 204);
    assert.equal((await ticket('641')).state, 'dropped');
    assert.equal((await srv.call('GET', `/api/escalations/${gone.id}`, ALICE)).body.state, 'withdrawn');
  });

  test('waiting_on names another ticket and clears once that one is done', async () => {
    await fill({ lane_id: 'slot-j', group: 'train', ticket: '946', waiting_on: '#945' });
    assert.equal((await lane('slot-j')).waitingOn, '945');
    assert.equal((await ticket('946')).waitingOn, 'redmine:945');
    await fill({ lane_id: 'slot-k', group: 'train', ticket: '945' });
    await fill({ lane_id: 'slot-k', previous: 'done' });
    assert.equal((await lane('slot-j')).waitingOn, null);
    const self = await fill({ lane_id: 'slot-j', ticket: '946', waiting_on: '946' });
    assert.match(self.text, /can't wait on itself/);
    const empty = await srv.tool(AGENT, 'update_lane', { lane_id: 'slot-k', waiting_on: '1' });
    assert.match(empty.text, /holds no ticket/);
  });

  test("the overseer of a ticket's new group may close its questions", async () => {
    // The reviewer runs another group and raises a question on 650, then parks it.
    await srv.call('PUT', '/api/groups/other', REVIEWER, { name: 'Other' });
    await fill({ lane_id: 'their-slot', group: 'other', ticket: '650' }, REVIEWER);
    const q = await ask('their-slot', 'Split the migration?', {}, REVIEWER);
    await fill({ lane_id: 'their-slot', previous: 'park', reason: 'handing over' }, REVIEWER);
    await srv.call('POST', `/api/escalations/${q.id}/decide`, ALICE, { decision: 'Accept' });
    const before = await srv.tool(AGENT, 'acknowledge_escalation', { id: q.ref });
    assert.equal(before.isError, true, 'not while the ticket is in the other group');
    // The train's overseer takes the ticket over.
    await fill({ lane_id: 'slot-l', group: 'train', ticket: '650' });
    const ack = await srv.tool(AGENT, 'acknowledge_escalation', { id: q.ref });
    assert.equal(ack.isError, false, ack.text);
  });

  test('a lane holding no ticket codes its questions with its letter', async () => {
    await fill({ lane_id: 'slot-m', group: 'train' });
    const q = await ask('slot-m', 'What next?');
    assert.match(q.ref, /^[A-Z]+\d+$/);
    // Filling the lane later doesn't move that question onto the ticket.
    await fill({ lane_id: 'slot-m', ticket: '660' });
    assert.equal((await srv.call('GET', `/api/escalations/${q.id}`, ALICE)).body.ticketId, null);
    assert.equal((await ticket('660')).escalations.length, 0);
  });

  test('tickets are listed, searched by code and exported', async () => {
    const listed = (await srv.tool(AGENT, 'list_tickets', { group_id: 'train' })).value;
    assert.ok(listed.some((t: any) => t.ref === '500' && t.state === 'in_lane'));
    assert.ok(listed.some((t: any) => t.ref === '640' && t.state === 'parked'));
    assert.ok(!listed.some((t: any) => t.state === 'done'), 'held and parked by default');
    const parked = (await srv.call('GET', '/api/tickets?group=train&state=parked', ALICE)).body;
    assert.ok(parked.every((t: any) => t.state === 'parked'));
    const one = (await srv.call('GET', `/api/tickets/${encodeURIComponent('#500')}`, ALICE)).body;
    assert.equal(one.ticket.code, '500');
    assert.equal(one.ticket.url, 'https://redmine.example/issues/500');
    assert.equal((await srv.call('GET', '/api/tickets/9999', ALICE)).status, 404);
    // History finds a closed escalation by its ticket code.
    const found = (await srv.call('GET', '/api/history?q=501a', ALICE)).body.items;
    assert.deepEqual(found.map((e: any) => e.ref), ['501A']);
    const csv = (await srv.call('GET', '/api/export/tickets.csv', ALICE)).body as string;
    assert.match(csv.split('\n')[0], /^id,project,ref,display_ref,code,ticket_url,group_id,lane_id,state,park_reason/);
    assert.match(csv, /redmine:640,640,640,.*,parked,Lane removed/);
  });
});
