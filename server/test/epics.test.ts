// Epics: a group's long-lived tickets, with their own questions, message board and close approval.
// Every group has one; a group without its own stands in as its epic.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { EXPORT_COLUMNS, Store } from '../src/store.ts';
import { AGENT, ALICE, REVIEWER, startServer } from './helpers.ts';

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  srv = await startServer();
});
after(() => srv.close());

const group = (id: string, extra: Record<string, unknown> = {}, token = AGENT) =>
  srv.tool(token, 'update_group', { group_id: id, name: id[0].toUpperCase() + id.slice(1), ...extra });
const epics = async (g: string) => (await srv.tool(AGENT, 'list_epics', { group: g })).value as any[];
const epicDetail = async (id: number) => (await srv.call('GET', `/api/epics/${id}`, ALICE)).body;
const epicId = async (g: string, name?: string) => {
  const all = (await srv.call('GET', `/api/epics?group=${g}`, ALICE)).body as any[];
  return (name ? all.find((e) => e.ref?.endsWith(name) || e.displayRef === name) : all[0]).id as number;
};
const ask = async (args: Record<string, unknown>, token = AGENT) => srv.tool(token, 'create_escalation', args);
const decide = (id: string, decision = 'Accept') => srv.call('POST', `/api/escalations/${id}/decide`, ALICE, { decision });
const lane = async (id: string) => (await srv.call('GET', `/api/lanes/${id}`, ALICE)).body.lane;

describe('every group has an epic', () => {
  test('a new group stands in as its epic, named by its id and coded with it', async () => {
    await group('search');
    const [e] = await epics('search');
    assert.equal(e.epic, 'search');
    assert.equal(e.standIn, true);
    assert.equal(e.code, 'search');
    // A group with a ticket stands in with the ticket's code.
    await group('billing', { ticket: '680' });
    assert.equal((await epics('billing'))[0].code, '680');
  });

  test('a lane published without a group joins its project\'s Ungrouped group', async () => {
    await srv.call('PUT', '/api/lanes/loner', AGENT, { ticket: '100' });
    assert.equal((await lane('loner')).group, 'ungrouped');
    assert.equal((await srv.call('GET', '/api/groups', ALICE)).body.find((g: any) => g.id === 'ungrouped')?.name, 'Ungrouped');
    assert.equal((await epics('ungrouped'))[0].standIn, true);
  });

  test('the epic\'s internal lane is never listed, shown or written to', async () => {
    const id = await epicId('search');
    const snapshot = (await srv.call('GET', '/api/snapshot', ALICE)).body;
    assert.ok(!snapshot.lanes.some((l: any) => l.id.includes('~')));
    assert.ok(snapshot.epics.some((e: any) => e.id === id));
    assert.ok(!(await srv.call('GET', '/api/lanes', ALICE)).body.some((l: any) => l.id.includes('~')));
    assert.equal((await srv.call('GET', `/api/lanes/~epic-${id}`, ALICE)).status, 404);
    assert.equal((await srv.call('POST', `/api/lanes/~epic-${id}/messages`, ALICE, { body: 'hi' })).status, 404);
    assert.equal((await srv.call('DELETE', `/api/lanes/~epic-${id}`, ALICE)).status, 404);
  });
});

describe('questions on epics', () => {
  test('a ticketless lane raises on its group\'s epic: idle, never blocked, counted on the card', async () => {
    await group('search');
    const res = await srv.tool(AGENT, 'update_lane', { lane_id: 'slot-1', group: 'search', status: 'active' });
    assert.match(res.value.warning, /holds no ticket, so it shows idle/);
    assert.equal((await lane('slot-1')).status, 'idle');
    const q = (await ask({ lane_id: 'slot-1', question: 'Which ticket next?' })).value;
    assert.equal(q.ref, 'searchA');
    assert.equal(q.epic, 'Search');
    assert.equal(q.laneId, 'slot-1');
    const l = await lane('slot-1');
    assert.equal(l.status, 'idle');
    assert.equal(l.openEscalations, 0);
    const [e] = await epics('search');
    assert.equal(e.openEscalations, 1);
    assert.equal(e.blockingEscalations, 1);
    // An FYI counts as open but not blocking.
    await ask({ lane_id: 'slot-1', question: 'FYI: CI is slow', blocking: false });
    const [after] = await epics('search');
    assert.deepEqual([after.openEscalations, after.blockingEscalations], [2, 1]);
  });

  test('raised on an epic directly, with no lane; the same question again is a retry', async () => {
    const q = (await ask({ epic: 'search', question: 'Do we file the reindex ticket?' })).value;
    assert.equal(q.ref, 'searchC');
    assert.equal(q.laneId, undefined);
    const again = (await ask({ epic: 'search', question: 'do we file the reindex  ticket?' })).value;
    assert.equal(again.id, q.id);
    assert.equal(again.duplicate, true);
    const full = (await srv.call('GET', `/api/escalations/${q.id}`, ALICE)).body;
    assert.equal(full.epicId, await epicId('search'));
    assert.equal(full.ticketId, null);
    const missing = await ask({ question: 'Where?' });
    assert.equal(missing.isError, true);
    const unknown = await ask({ epic: 'nope-epic', question: 'Where?' });
    assert.match(unknown.text, /Epic "nope-epic" not found/);
  });

  test('a lane holding a ticket raises on the ticket, unless it names an epic', async () => {
    await srv.tool(AGENT, 'fill_lane', { lane_id: 'slot-2', group: 'search', ticket: '900' });
    const own = (await ask({ lane_id: 'slot-2', question: 'Ship 900?' })).value;
    assert.equal(own.ref, '900A');
    assert.equal((await lane('slot-2')).status, 'blocked_human');
    const durable = (await ask({ lane_id: 'slot-2', epic: 'search', question: 'Split search into two services?' })).value;
    assert.match(durable.ref, /^search[A-Z]$/);
    assert.equal(durable.laneId, 'slot-2', 'raised in the lane');
    assert.equal((await lane('slot-2')).blockingEscalations, 1, "the epic's question doesn't block the lane");
  });

  test("the overseer of the epic's group may acknowledge its questions", async () => {
    await group('payments');
    await srv.tool(REVIEWER, 'update_lane', { lane_id: 'rev-slot', group: 'payments' });
    const q = (await ask({ lane_id: 'rev-slot', question: 'Which payout ticket first?' }, REVIEWER)).value;
    await decide(q.id);
    const ack = await srv.tool(AGENT, 'acknowledge_escalation', { id: q.ref });
    assert.equal(ack.isError, false, ack.text);
    // Not the other way round: the reviewer doesn't oversee search.
    const other = (await ask({ epic: 'search', question: 'Reviewer may not close this?' })).value;
    await decide(other.id);
    const denied = await srv.tool(REVIEWER, 'acknowledge_escalation', { id: other.ref });
    assert.match(denied.text, /overseer of the group its epic is in/);
    await srv.tool(AGENT, 'acknowledge_escalation', { id: other.ref });
  });
});

describe('real epics', () => {
  test('the first real epic retires the stand-in: questions and board move to it, codes kept; status line set', async () => {
    await group('orders');
    const standIn = await epicId('orders');
    const q = (await ask({ epic: 'orders', question: 'Keep the legacy cart?' })).value;
    assert.equal(q.ref, 'ordersA');
    await srv.tool(AGENT, 'update_epic', { epic: 'orders', status_line: '2 lanes busy' });
    assert.equal((await srv.call('POST', `/api/epics/${standIn}/messages`, ALICE, { body: 'Cart redesign first' })).status, 201);
    const created = await srv.tool(AGENT, 'update_epic', { epic: '700', group: 'orders', name: 'Checkout v2' });
    assert.equal(created.isError, false, created.text);
    assert.equal(created.value.epic, '700');
    assert.equal(created.value.statusLine, '2 lanes busy', 'the stand-in\'s status line carries over');
    // The board note the overseer hadn't seen comes back with it.
    assert.deepEqual(created.value.ownerMessages.map((m: any) => m.body), ['Cart redesign first']);
    const real = await epicId('orders');
    assert.notEqual(real, standIn);
    const moved = (await srv.call('GET', `/api/escalations/${q.id}`, ALICE)).body;
    assert.equal(moved.epicId, real);
    assert.equal(moved.ref, 'ordersA', 'codes are kept');
    assert.deepEqual((await epicDetail(real)).messages.map((m: any) => m.body), ['Cart redesign first']);
    assert.equal((await srv.call('GET', `/api/epics/${standIn}`, ALICE)).body.epic.state, 'closed');
    // New questions take the real epic's code.
    assert.equal((await ask({ epic: '700', question: 'Guest checkout?' })).value.ref, '700A');
    // Over REST, with its status line.
    const rest = await srv.call('POST', '/api/epics', AGENT, { group: 'orders', ref: '701', name: 'Returns', statusLine: 'Scoping' });
    assert.equal(rest.status, 201, JSON.stringify(rest.body));
    assert.equal(rest.body.statusLine, 'Scoping');
    assert.equal(rest.body.group, 'orders');
  });

  test('a group with several epics: a ticketless lane must say which', async () => {
    await srv.tool(AGENT, 'update_lane', { lane_id: 'ord-slot', group: 'orders' });
    const vague = await ask({ lane_id: 'ord-slot', question: 'Which first?' });
    assert.equal(vague.isError, true);
    assert.match(vague.text, /its group has 2 epics: say which/);
    const named = await ask({ lane_id: 'ord-slot', epic: '701', question: 'Which first?' });
    assert.equal(named.value.ref, '701A');
    const byGroup = await srv.tool(AGENT, 'update_epic', { epic: 'orders', status_line: 'x' });
    assert.match(byGroup.text, /has 2 epics: name one by its ref/);
  });

  test('a ticket and an epic with the same ref share one letter sequence', async () => {
    await srv.tool(AGENT, 'fill_lane', { lane_id: 'groom', group: 'orders', ticket: '700' });
    const q = (await ask({ lane_id: 'groom', question: 'Groom 700 now?' })).value;
    assert.equal(q.ref, '700B', '700A is the epic\'s');
    assert.equal((await srv.call('GET', `/api/escalations/${q.ref}`, ALICE)).body.ticketId !== null, true);
  });

  test('fill_lane names the epic a ticket is for; closed epics and other groups\' are refused; the stand-in clears it', async () => {
    const filled = await srv.tool(AGENT, 'fill_lane', { lane_id: 'ord-slot', ticket: '710', epic: '701' });
    assert.equal(filled.isError, false, filled.text);
    const t = srv.store.getTicket('default', '710')!;
    assert.equal(t.epicId, await epicId('orders', '701'));
    assert.deepEqual((await epicDetail(t.epicId!)).lanes, ['ord-slot']);
    const other = await srv.tool(AGENT, 'fill_lane', { lane_id: 'ord-slot', ticket: '710', epic: 'search' });
    assert.match(other.text, /a lane's ticket names an epic of the lane's group/);
    await srv.tool(AGENT, 'fill_lane', { lane_id: 'ord-slot', ticket: '710', epic: null });
    assert.equal(srv.store.getTicket('default', '710')!.epicId, null);
    // The search group's stand-in: naming it means no epic of its own.
    await srv.tool(AGENT, 'fill_lane', { lane_id: 'slot-3', group: 'search', ticket: '720', epic: 'search' });
    assert.equal(srv.store.getTicket('default', '720')!.epicId, null);
  });
});

describe('message boards', () => {
  test("the overseer posts once a minute; a person's note comes back in the group's wait and get_updates", async () => {
    await group('boards');
    const id = await epicId('boards');
    const first = await srv.tool(AGENT, 'notify_epic', { epic: 'boards', message: 'Planning the next three tickets' });
    assert.equal(first.isError, false, first.text);
    const retry = await srv.tool(AGENT, 'notify_epic', { epic: 'boards', message: 'Planning the next three tickets' });
    assert.equal(retry.isError, false, 'a retry returns the message sent');
    const second = await srv.tool(AGENT, 'notify_epic', { epic: 'boards', message: 'Another' });
    assert.match(second.text, /One message per epic per minute/);
    assert.equal((await epicDetail(id)).epic.lastAgentMessageId !== null, true);

    const start = (await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'boards', wait_seconds: 0 })).value;
    assert.equal((await srv.call('POST', `/api/epics/${id}/messages`, ALICE, { body: 'Do the audit ticket first' })).status, 201);
    assert.equal((await epicDetail(id)).epic.unreadByAgent, 1);
    const updates = (await srv.tool(AGENT, 'get_updates', { group_id: 'boards' })).value;
    assert.deepEqual(updates.boardMessages.map((b: any) => [b.epic, b.messages.map((m: any) => m.body)]), [['Boards', ['Do the audit ticket first']]]);
    // get_updates hands it over; a digest from an earlier `since` still reports it, once.
    assert.equal((await epicDetail(id)).epic.unreadByAgent, 0);
    const w = (await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'boards', since: start.checkedAt, wait_seconds: 0 })).value;
    assert.deepEqual(
      w.items.map((i: any) => [i.kind, i.epic, i.messages[0].body]),
      [['board_note', 'Boards', 'Do the audit ticket first']],
    );
    const later = (await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'boards', since: w.checkedAt, wait_seconds: 0 })).value;
    assert.deepEqual(later.items, []);
  });

  test('a wait hands over notes; another without since has nothing', async () => {
    const id = await epicId('boards');
    await srv.call('POST', `/api/epics/${id}/messages`, ALICE, { body: 'Second note' });
    const w = (await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'boards', wait_seconds: 0 })).value;
    assert.deepEqual(w.items.map((i: any) => i.kind), ['board_note']);
    assert.equal((await epicDetail(id)).epic.unreadByAgent, 0);
    const again = (await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'boards', wait_seconds: 0 })).value;
    assert.deepEqual(again.items, []);
  });
});

describe('closing an epic', () => {
  let personal = '';
  before(async () => {
    await srv.call('POST', '/api/admin/people', ALICE, { email: 'pat@example.com', name: 'Pat', password: 'correct horse battery' });
    const signIn = await fetch(`${srv.base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: srv.base },
      body: JSON.stringify({ email: 'pat@example.com', password: 'correct horse battery' }),
    });
    const session = signIn.headers.get('set-auth-token')!;
    personal = (await srv.call('POST', '/api/auth/api-key/create', session, { name: 'pat-claude', metadata: { role: 'human' } })).body.key;
  });

  test('an overseer asks; refused while questions are open or answered and unacknowledged', async () => {
    await group('closing');
    await srv.tool(AGENT, 'update_epic', { epic: '800', group: 'closing', name: 'Audit' });
    // A stand-in isn't closed: it steps aside for a real epic.
    assert.match((await srv.tool(AGENT, 'request_epic_close', { epic: 'boards', reason: 'x' })).text, /stand-in epic isn't closed/);
    const q = (await ask({ epic: '800', question: 'Anything left?' })).value;
    assert.match((await srv.tool(AGENT, 'request_epic_close', { epic: '800', reason: 'Done' })).text, /still open or awaiting acknowledgement/);
    await decide(q.id);
    assert.match((await srv.tool(AGENT, 'request_epic_close', { epic: '800', reason: 'Done' })).text, /still open or awaiting acknowledgement/);
    await srv.tool(AGENT, 'acknowledge_escalation', { id: q.ref });
    const asked = await srv.tool(AGENT, 'request_epic_close', { epic: '800', reason: 'Audit filed' });
    assert.equal(asked.isError, false, asked.text);
    assert.equal(asked.value.state, 'close_requested');
    assert.equal(asked.value.closeReason, 'Audit filed');
  });

  test('a person approves or declines, signed in; the last real epic closing brings the stand-in back', async () => {
    const id = await epicId('closing', '800');
    assert.equal((await srv.call('POST', `/api/epics/${id}/close`, AGENT, { approve: true })).status, 403);
    assert.equal((await srv.call('POST', `/api/epics/${id}/close`, personal, { approve: true })).status, 403);
    const declined = await srv.call('POST', `/api/epics/${id}/close`, ALICE, { approve: false });
    assert.equal(declined.body.state, 'open');
    assert.equal(declined.body.closeReason, null);
    assert.equal((await srv.call('POST', `/api/epics/${id}/close`, ALICE, { approve: true })).status, 409, 'nobody asked');
    await srv.call('POST', `/api/epics/${id}/close-request`, AGENT, { reason: 'Audit filed' });
    const closed = await srv.call('POST', `/api/epics/${id}/close`, ALICE, { approve: true });
    assert.equal(closed.body.state, 'closed');
    const now = await epics('closing');
    assert.deepEqual(now.map((e) => [e.epic, e.standIn]), [['closing', true]]);
    // A closed epic takes no more questions or board posts.
    assert.match((await ask({ epic: '800', question: 'More?' })).text, /not found|closed/);
    assert.equal((await srv.call('POST', `/api/epics/${id}/messages`, ALICE, { body: 'late' })).status, 409);
    // Nor can a ticket name it any more.
    const fill = await srv.tool(AGENT, 'fill_lane', { lane_id: 'close-slot', group: 'closing', ticket: '810', epic: '800' });
    assert.equal(fill.isError, true);
    assert.match(fill.text, /Epic 800 is closed/);
  });
});

describe('export', () => {
  test('epics.csv and epic_messages.csv have their columns; escalations carry epic_id; lanes.csv has no internal lanes', async () => {
    for (const d of ['epics', 'epic_messages'] as const) {
      const csv = await (await fetch(`${srv.base}/api/export/${d}.csv`, { headers: { authorization: `Bearer ${ALICE}` } })).text();
      assert.equal(csv.split(/\r?\n/)[0], EXPORT_COLUMNS[d].join(','), d);
    }
    const epicRows = (await srv.call('GET', '/api/export/epics.json', ALICE)).body;
    assert.ok(epicRows.some((r: any) => r.display_ref === '700' && r.name === 'Checkout v2' && r.stand_in === false));
    assert.ok(epicRows.some((r: any) => r.group_id === 'orders' && r.stand_in === true && r.state === 'closed'));
    const boards = (await srv.call('GET', '/api/export/epic_messages.json', ALICE)).body;
    assert.ok(boards.some((r: any) => r.body === 'Do the audit ticket first' && r.from === 'owner' && typeof r.epic_id === 'number'));
    const escs = (await srv.call('GET', '/api/export/escalations.json', ALICE)).body;
    const direct = escs.find((r: any) => r.question === 'Do we file the reindex ticket?');
    assert.equal(typeof direct.epic_id, 'number');
    assert.equal(direct.lane_id, null, 'raised on the epic, in no lane');
    assert.equal(escs.find((r: any) => r.question === 'Ship 900?').epic_id, null);
    const lanes = (await srv.call('GET', '/api/export/lanes.json', ALICE)).body;
    assert.ok(lanes.length > 0 && !lanes.some((l: any) => String(l.id).includes('~')));
    const events = (await srv.call('GET', '/api/export/events.json', ALICE)).body;
    assert.ok(!events.some((e: any) => String(e.lane_id ?? '').includes('~')));
  });
});

describe('REST', () => {
  test('list and detail: questions, board, lanes and their combined feed', async () => {
    const list = (await srv.call('GET', '/api/epics?group=orders', ALICE)).body;
    // The test server's only ticket system (gh) is the default: "700" is "gh:700", shown as written.
    assert.deepEqual(list.map((e: any) => [e.ref, e.displayRef]).sort(), [['gh:700', '700'], ['gh:701', '701']]);
    const id = await epicId('orders', '700');
    await srv.tool(AGENT, 'fill_lane', { lane_id: 'groom', ticket: '700', epic: '700', activity: 'Grooming the backlog' });
    const d = await epicDetail(id);
    assert.equal(d.epic.name, 'Checkout v2');
    assert.ok(d.escalations.some((e: any) => e.ref === '700A'));
    assert.deepEqual(d.lanes, ['groom']);
    assert.ok(d.feed.some((e: any) => e.laneId === 'groom' && e.message === 'Grooming the backlog'));
    assert.equal((await srv.call('GET', '/api/epics/99999', ALICE)).status, 404);
    assert.equal((await srv.call('GET', '/api/epics/abc', ALICE)).status, 404);
    const put = await srv.call('PUT', `/api/epics/${id}`, AGENT, { statusLine: '1 lane grooming' });
    assert.equal(put.body.statusLine, '1 lane grooming');
    assert.equal((await srv.call('PUT', `/api/epics/${id}`, ALICE, { statusLine: 'x' })).status, 403);
  });
});

/** Takes a database back from v18 (epics) to v17. */
const UNDO_V18 = `
  DELETE FROM lane_events WHERE lane_id LIKE '%/~epic-%';
  DELETE FROM escalations WHERE lane_id LIKE '%/~epic-%';
  DELETE FROM lanes WHERE id LIKE '%/~epic-%';
  UPDATE lanes SET group_id = NULL WHERE group_id LIKE '%/ungrouped';
  DELETE FROM groups WHERE id LIKE '%/ungrouped';
  DROP INDEX escalations_epic;
  ALTER TABLE escalations DROP COLUMN epic_id;
  ALTER TABLE tickets DROP COLUMN epic_id;
  DROP INDEX attachments_epic_message;
  ALTER TABLE attachments DROP COLUMN epic_message_id;
  DROP TABLE epic_messages;
  DROP TABLE epics;
  UPDATE meta SET value = '17' WHERE key = 'schema_version';
`;

test('upgrading to epics: real epics for groups with a ticket, stand-ins otherwise, Ungrouped, idle ticketless lanes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lanesignal-v17-'));
  const file = path.join(dir, 'lanesignal.db');
  const resolveTicketUrl = () => null;
  try {
    let store = new Store({ path: file, resolveTicketUrl });
    store.upsertGroup('default/train', { name: 'Train', ticket: '680' }, 'bot');
    store.upsertGroup('default/plain', { name: 'Plain' }, 'bot');
    store.upsertLane('default/t-slot', { group: 'default/train' }, 'bot');
    const loose = store.createEscalation({ laneId: 'default/t-slot', question: 'Which ticket next?' }, 'bot');
    store.upsertLane('default/p-slot', { group: 'default/plain', ticket: '500' }, 'bot');
    store.upsertLane('default/stray', {}, 'bot');
    store.close();
    // Back to v17: no epics; a ticketless lane could be working.
    const db = new DatabaseSync(file);
    db.exec(`${UNDO_V18}
      UPDATE lanes SET status = 'active' WHERE id = 'default/t-slot';`);
    db.close();

    store = new Store({ path: file, resolveTicketUrl });
    const train = store.listEpics({ groupId: 'default/train' });
    assert.deepEqual(train.map((e) => [e.ref, e.standIn, e.name]), [['680', false, 'Train']]);
    const plain = store.listEpics({ groupId: 'default/plain' });
    assert.deepEqual(plain.map((e) => [e.ref, e.standIn, e.code]), [[null, true, 'plain']]);
    assert.equal(store.getLane('default/stray')?.group, 'default/ungrouped');
    assert.equal(store.listEpics({ groupId: 'default/ungrouped' })[0]?.standIn, true);
    // The ticketless lane's question belongs to its group's epic, and the lane shows idle.
    assert.equal(store.getEscalation(loose.id)?.epicId, train[0].id);
    assert.equal(store.getLane('default/t-slot')?.status, 'idle');
    assert.equal(store.getLane('default/p-slot')?.status, 'active');
    assert.ok(!store.listLanes().some((l) => l.id.includes('~')));
    // Opening it again changes nothing.
    store.close();
    store = new Store({ path: file, resolveTicketUrl });
    assert.equal(store.listEpics({ states: ['open', 'close_requested', 'closed'] }).length, 3);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
