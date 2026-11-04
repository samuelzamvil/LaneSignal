// Epics: a group's long-lived tickets, with their own questions and close approval. A group may
// have none: its own questions are then raised on the group.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { EXPORT_COLUMNS, Store } from '../src/store.ts';
import { AGENT, ALICE, REVIEWER, startServer } from './helpers.ts';
import { UNDO_V24, UNDO_V26 } from './undo.ts';

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

const groupOf = async (id: string) => (await srv.call('GET', '/api/groups', ALICE)).body.find((g: any) => g.id === id);

describe('groups hold questions of their own', () => {
  test('a new group has no epic; its own questions are coded with its id', async () => {
    await group('search');
    assert.deepEqual(await epics('search'), []);
    const g = await groupOf('search');
    assert.equal(g.code, 'search');
    assert.deepEqual([g.openEscalations, g.blockingEscalations, g.statusLine], [0, 0, null]);
    // A group's ticket is its epic's: one sent with the group is left out, with a pointer.
    const billing = await group('billing', { ticket: '680' });
    assert.match(billing.value.warning, /update_epic with epic "680" and group "billing"/);
    assert.equal((await groupOf('billing')).code, 'billing');
    // Its status line is the group's, on its box.
    await group('search', { status_line: '2 lanes busy' });
    assert.equal((await groupOf('search')).statusLine, '2 lanes busy');
  });

  test('a lane is never outside a group: publishing one without its group is refused', async () => {
    const res = await srv.call('PUT', '/api/lanes/loner', AGENT, { ticket: '100' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /needs a group/);
    assert.equal((await srv.call('GET', '/api/lanes/loner', AGENT)).status, 404);
    assert.ok(!(await srv.call('GET', '/api/groups', ALICE)).body.some((g: any) => g.id === 'ungrouped'));
    await group('home');
    await srv.call('PUT', '/api/lanes/loner', AGENT, { group: 'home', ticket: '100' });
    const viaMcp = await srv.tool(AGENT, 'update_lane', { lane_id: 'mcp-loner', ticket: '101' });
    assert.ok(viaMcp.isError);
    assert.match(viaMcp.text, /needs a group/);
    const moved = await srv.call('PUT', '/api/lanes/loner', AGENT, { group: null });
    assert.equal(moved.status, 400);
    assert.equal((await lane('loner')).group, 'home');
  });

  test("a group's and an epic's internal lanes are never listed, shown or written to", async () => {
    const snapshot = (await srv.call('GET', '/api/snapshot', ALICE)).body;
    assert.ok(!snapshot.lanes.some((l: any) => l.id.includes('~')));
    assert.ok(!(await srv.call('GET', '/api/lanes', ALICE)).body.some((l: any) => l.id.includes('~')));
    assert.equal((await srv.call('GET', '/api/lanes/~group-search', ALICE)).status, 404);
    assert.equal((await srv.call('DELETE', '/api/lanes/~group-search', ALICE)).status, 404);
    assert.equal((await srv.call('POST', '/api/lanes/~group-search/messages', ALICE, { body: 'hi' })).status, 410);
  });
});

describe("a group's own questions", () => {
  test("a ticketless lane in a group with no epic raises on the group: idle, never blocked, counted on the group", async () => {
    const res = await srv.tool(AGENT, 'update_lane', { lane_id: 'slot-1', group: 'search', status: 'active' });
    assert.match(res.value.warning, /holds no ticket, so it shows idle/);
    const q = (await ask({ lane_id: 'slot-1', question: 'Which ticket next?' })).value;
    assert.equal(q.ref, 'searchA');
    assert.equal(q.epic, undefined);
    assert.equal(q.laneId, 'slot-1');
    const l = await lane('slot-1');
    assert.equal(l.status, 'idle');
    assert.equal(l.openEscalations, 0);
    const g = await groupOf('search');
    assert.deepEqual([g.openEscalations, g.blockingEscalations], [1, 1]);
    // An FYI counts as open but not blocking.
    await ask({ lane_id: 'slot-1', question: 'FYI: CI is slow', blocking: false });
    const after = await groupOf('search');
    assert.deepEqual([after.openEscalations, after.blockingEscalations], [2, 1]);
  });

  test('raised on the group directly, with no lane or epic; the same question again is a retry', async () => {
    const q = (await ask({ group_id: 'search', question: 'Do we file the reindex ticket?' })).value;
    assert.equal(q.ref, 'searchC');
    assert.equal(q.laneId, undefined);
    const again = (await ask({ group_id: 'search', question: 'do we file the reindex  ticket?' })).value;
    assert.equal(again.id, q.id);
    assert.equal(again.duplicate, true);
    const full = (await srv.call('GET', `/api/escalations/${q.id}`, ALICE)).body;
    assert.deepEqual([full.epicId, full.ticketId, full.laneId, full.group], [null, null, null, 'search']);
    // `epic` naming a group with no epic still raises on the group, as when the group stood in as its epic.
    const legacy = (await ask({ epic: 'search', question: 'Split search into two services?' })).value;
    assert.match(legacy.ref, /^search[A-Z]$/);
    assert.equal((await srv.call('GET', `/api/escalations/${legacy.id}`, ALICE)).body.group, 'search');
    // Over HTTP too.
    const http = await srv.call('POST', '/api/escalations', AGENT, { group: 'search', question: 'Freeze on Friday?', blocking: false });
    assert.equal(http.status, 201);
    assert.equal(http.body.laneId, null);
    assert.equal((await srv.call('POST', '/api/escalations', AGENT, { group: 'search', laneId: 'slot-1', question: 'Both?' })).status, 400);
    const missing = await ask({ question: 'Where?' });
    assert.equal(missing.isError, true);
    const unknown = await ask({ epic: 'nope-epic', question: 'Where?' });
    assert.match(unknown.text, /Epic "nope-epic" not found/);
    // A blocking one has the group waiting on a person; its lanes' status doesn't change.
    assert.ok((await groupOf('search')).blockingEscalations >= 3);
    assert.equal((await lane('slot-1')).status, 'idle');
  });

  test('a lane holding a ticket raises on the ticket, unless it names an epic', async () => {
    await group('catalog');
    await srv.tool(AGENT, 'update_epic', { epic: '950', group: 'catalog', name: 'Catalog v2' });
    await srv.tool(AGENT, 'fill_lane', { lane_id: 'slot-2', group: 'catalog', ticket: '900' });
    const own = (await ask({ lane_id: 'slot-2', question: 'Ship 900?' })).value;
    assert.equal(own.ref, '900A');
    assert.equal((await lane('slot-2')).status, 'blocked_human');
    const durable = (await ask({ lane_id: 'slot-2', epic: '950', question: 'Split the catalog?' })).value;
    assert.equal(durable.ref, '950A');
    assert.equal(durable.laneId, 'slot-2', 'raised in the lane');
    assert.equal((await lane('slot-2')).blockingEscalations, 1, "the epic's question doesn't block the lane");
  });

  test("the group's overseer may acknowledge its questions", async () => {
    await group('payments');
    await srv.tool(REVIEWER, 'update_lane', { lane_id: 'rev-slot', group: 'payments' });
    const q = (await ask({ lane_id: 'rev-slot', question: 'Which payout ticket first?' }, REVIEWER)).value;
    await decide(q.id);
    const ack = await srv.tool(AGENT, 'acknowledge_escalation', { id: q.ref });
    assert.equal(ack.isError, false, ack.text);
    // Not the other way round: the reviewer doesn't oversee search.
    const other = (await ask({ group_id: 'search', question: 'Reviewer may not close this?' })).value;
    await decide(other.id);
    const denied = await srv.tool(REVIEWER, 'acknowledge_escalation', { id: other.ref });
    assert.match(denied.text, /the group's overseer/);
    await srv.tool(AGENT, 'acknowledge_escalation', { id: other.ref });
  });
});

describe('real epics', () => {
  test("adding an epic leaves the group's own questions on the group; the epic's take its code", async () => {
    await group('orders', { status_line: '2 lanes busy' });
    const q = (await ask({ group_id: 'orders', question: 'Keep the legacy cart?' })).value;
    assert.equal(q.ref, 'ordersA');
    const created = await srv.tool(AGENT, 'update_epic', { epic: '700', group: 'orders', name: 'Checkout v2' });
    assert.equal(created.isError, false, created.text);
    assert.equal(created.value.epic, '700');
    assert.equal(created.value.statusLine, undefined, "the group's status line stays the group's");
    assert.equal((await groupOf('orders')).statusLine, '2 lanes busy');
    const kept = (await srv.call('GET', `/api/escalations/${q.id}`, ALICE)).body;
    assert.deepEqual([kept.epicId, kept.group, kept.ref], [null, 'orders', 'ordersA']);
    assert.equal((await ask({ epic: '700', question: 'Guest checkout?' })).value.ref, '700A');
    // A ticketless lane in a group with one epic raises on that epic.
    await srv.tool(AGENT, 'update_lane', { lane_id: 'ord-first', group: 'orders' });
    assert.equal((await ask({ lane_id: 'ord-first', question: 'Which ticket first?' })).value.ref, '700B');
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
    assert.equal(q.ref, '700C', '700A and 700B are the epic\'s');
    assert.equal((await srv.call('GET', `/api/escalations/${q.ref}`, ALICE)).body.ticketId !== null, true);
  });

  test('fill_lane names the epic a ticket is for; closed epics and other groups\' are refused', async () => {
    const filled = await srv.tool(AGENT, 'fill_lane', { lane_id: 'ord-slot', ticket: '710', epic: '701' });
    assert.equal(filled.isError, false, filled.text);
    const t = srv.store.getTicket('default', '710')!;
    assert.equal(t.epicId, await epicId('orders', '701'));
    assert.deepEqual((await epicDetail(t.epicId!)).lanes, ['ord-slot']);
    const other = await srv.tool(AGENT, 'fill_lane', { lane_id: 'ord-slot', ticket: '710', epic: '950' });
    assert.match(other.text, /a lane's ticket names an epic of the lane's group/);
    await srv.tool(AGENT, 'fill_lane', { lane_id: 'ord-slot', ticket: '710', epic: null });
    assert.equal(srv.store.getTicket('default', '710')!.epicId, null);
    // A group with no epic has none to name.
    const none = await srv.tool(AGENT, 'fill_lane', { lane_id: 'slot-3', group: 'search', ticket: '720', epic: 'search' });
    assert.equal(none.isError, true);
  });
});

describe('message boards', () => {
  test('are retired: everything is said in the group\'s conversation', async () => {
    await group('boards');
    await srv.tool(AGENT, 'update_epic', { epic: '960', group: 'boards' });
    const id = await epicId('boards');
    const refused = await srv.call('POST', `/api/epics/${id}/messages`, ALICE, { body: 'Do the audit ticket first' });
    assert.equal(refused.status, 410);
    assert.match(refused.body.error, /group's conversation/);
    const tools = await srv.tool(AGENT, 'notify_epic', { epic: 'boards', message: 'Planning' });
    assert.equal(tools.isError, true);
    assert.equal((await epicDetail(id)).messages, undefined);
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

  test('a person approves or declines, signed in; a group whose last epic closed has none', async () => {
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
    assert.deepEqual(await epics('closing'), []);
    // A closed epic takes no more questions.
    assert.match((await ask({ epic: '800', question: 'More?' })).text, /not found|closed/);
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
    const escs = (await srv.call('GET', '/api/export/escalations.json', ALICE)).body;
    const direct = escs.find((r: any) => r.question === 'Do we file the reindex ticket?');
    assert.equal(direct.epic_id, null, "the group's own");
    assert.equal(direct.lane_id, null, 'raised on the group, in no lane');
    assert.equal(direct.group_id, 'search');
    assert.equal(typeof escs.find((r: any) => r.question === 'Guest checkout?').epic_id, 'number');
    assert.equal(escs.find((r: any) => r.question === 'Ship 900?').epic_id, null);
    const lanes = (await srv.call('GET', '/api/export/lanes.json', ALICE)).body;
    assert.ok(lanes.length > 0 && !lanes.some((l: any) => String(l.id).includes('~')));
    const events = (await srv.call('GET', '/api/export/events.json', ALICE)).body;
    assert.ok(!events.some((e: any) => String(e.lane_id ?? '').includes('~')));
  });
});

describe('REST', () => {
  test('list and detail: questions, lanes and their combined feed', async () => {
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
  ${UNDO_V26}
  ${UNDO_V24}
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

test('upgrading to epics, then past stand-ins: real epics for groups with a ticket, the others hold their own questions', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lanesignal-v17-'));
  const file = path.join(dir, 'lanesignal.db');
  const resolveTicketUrl = () => null;
  try {
    let store = new Store({ path: file, resolveTicketUrl });
    store.upsertGroup('default/train', { name: 'Train' }, 'bot');
    store.upsertGroup('default/plain', { name: 'Plain' }, 'bot');
    store.upsertLane('default/t-slot', { group: 'default/train' }, 'bot');
    const loose = store.createEscalation({ laneId: 'default/t-slot', question: 'Which ticket next?' }, 'bot');
    store.upsertLane('default/p-slot', { group: 'default/plain', ticket: '500' }, 'bot');
    // A lane from before every lane needed a group (v17 had none for it; undoing v18 takes it out).
    store.upsertGroup('default/ungrouped', {}, 'bot');
    store.upsertLane('default/stray', { group: 'default/ungrouped' }, 'bot');
    store.close();
    // Back to v17: no epics; a ticketless lane could be working.
    const db = new DatabaseSync(file);
    // Back to v17, where groups carried a ticket.
    db.exec(`${UNDO_V18}
      UPDATE groups SET ticket = '680' WHERE id = 'default/train';
      UPDATE lanes SET status = 'active' WHERE id = 'default/t-slot';`);
    db.close();

    store = new Store({ path: file, resolveTicketUrl });
    const train = store.listEpics({ groupId: 'default/train' });
    assert.deepEqual(train.map((e) => [e.ref, e.name]), [['680', 'Train']]);
    // The stand-in v18 made for a group without a ticket is gone (v26): the group holds its questions, with its code.
    assert.deepEqual(store.listEpics({ groupId: 'default/plain' }), []);
    assert.equal(store.getGroup('default/plain')?.code, 'plain');
    assert.equal(store.getLane('default/stray')?.group, 'default/ungrouped');
    assert.deepEqual(store.listEpics({ groupId: 'default/ungrouped' }), []);
    // The ticketless lane's question belongs to its group's epic, and the lane shows idle.
    assert.equal(store.getEscalation(loose.id)?.epicId, train[0].id);
    assert.equal(store.getLane('default/t-slot')?.status, 'idle');
    assert.equal(store.getLane('default/p-slot')?.status, 'active');
    assert.ok(!store.listLanes().some((l) => l.id.includes('~')));
    // Opening it again changes nothing.
    store.close();
    store = new Store({ path: file, resolveTicketUrl });
    assert.equal(store.listEpics({ states: ['open', 'close_requested', 'closed'] }).length, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('review fixes', () => {
  test("a group's own question has no lane for clients; digests and get_updates list it", async () => {
    await group('direct');
    const q = (await ask({ group_id: 'direct', question: 'Which direction?' })).value;
    assert.equal((await srv.call('GET', `/api/escalations/${q.id}`, ALICE)).body.laneId, null);
    const snapshot = (await srv.call('GET', '/api/snapshot', ALICE)).body;
    assert.equal(snapshot.escalations.find((e: any) => e.id === q.id).laneId, null);
    const open = (await srv.tool(AGENT, 'get_updates', { group_id: 'direct' })).value.open;
    assert.deepEqual(open.map((o: any) => [o.ref, o.laneId ?? null, o.epicName]), [[q.ref, null, undefined]]);
    // The owner answers Other; the agent's turn comes back as a reply.
    const start = (await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'direct', wait_seconds: 0 })).value;
    await srv.call('POST', `/api/escalations/${q.id}/decide`, ALICE, { decision: 'Other', note: 'Ask product first' });
    const w = (await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'direct', since: start.checkedAt, wait_seconds: 0 })).value;
    const reply = w.items.find((i: any) => i.kind === 'reply');
    assert.deepEqual(reply, { code: q.ref, kind: 'reply', text: 'Ask product first' });
    await srv.tool(AGENT, 'acknowledge_escalation', { id: q.ref });
  });

  test("an epic keeps a ref of its own; a lane's question names only its group's epics", async () => {
    await group('refs');
    await srv.tool(AGENT, 'update_epic', { epic: '850', group: 'refs' });
    await srv.tool(AGENT, 'update_epic', { epic: '851', group: 'refs' });
    assert.match((await srv.tool(AGENT, 'update_epic', { epic: '850', ref: '' })).text, /keeps its ticket ref/);
    assert.match((await srv.tool(AGENT, 'update_epic', { epic: '850', ref: '851' })).text, /851 is another epic already/);
    // An existing epic named with another group is refused, not silently updated.
    await group('refs2');
    assert.equal((await srv.call('POST', '/api/epics', AGENT, { group: 'refs2', ref: '850' })).status, 409);
    await srv.tool(AGENT, 'update_lane', { lane_id: 'refs-slot', group: 'refs' });
    await srv.tool(AGENT, 'update_epic', { epic: '852', group: 'refs2' });
    const cross = await ask({ lane_id: 'refs-slot', epic: '852', question: 'Wrong group?' });
    assert.match(cross.text, /not this lane's/);
    // History finds an epic's closed questions by its ref.
    const q = (await ask({ epic: '850', question: 'Scope the audit?' })).value;
    await srv.call('POST', `/api/escalations/${q.id}/withdraw`, ALICE, { note: 'moot' });
    const found = (await srv.call('GET', '/api/history?q=%23850', ALICE)).body.items;
    assert.deepEqual(found.map((e: any) => e.id), [q.id]);
  });

  test("a closed epic's tickets keep their link; questions follow a renamed epic", async () => {
    await group('links');
    await srv.tool(AGENT, 'update_epic', { epic: '860', group: 'links', name: 'Links v2' });
    const q = (await ask({ epic: '860', question: 'Keep the old links page?' })).value;
    const sent: any[] = [];
    const on = (e: any) => e.type === 'escalation' && e.escalation.id === q.id && sent.push(e.escalation);
    srv.store.events.on('change', on);
    await new Promise((r) => setTimeout(r, 5));
    await srv.tool(AGENT, 'update_epic', { epic: '860', name: 'Links revamp' });
    srv.store.events.off('change', on);
    assert.equal(sent.at(-1).epicName, 'Links revamp', 'clients hear the new name');
    assert.ok(sent[0].updatedAt > sent[0].createdAt, "so it doesn't read as a new question");
    await srv.tool(AGENT, 'acknowledge_escalation', { id: q.ref }).catch(() => {});
    await srv.call('POST', `/api/escalations/${q.id}/withdraw`, ALICE, { note: 'moot' });

    await srv.tool(AGENT, 'fill_lane', { lane_id: 'links-slot', group: 'links', ticket: '861', epic: '860' });
    const id = await epicId('links', '860');
    await srv.call('POST', `/api/epics/${id}/close-request`, AGENT, { reason: 'Shipped' });
    assert.equal((await srv.call('POST', `/api/epics/${id}/close`, ALICE, { approve: true })).body.state, 'closed');
    const cleared = await srv.tool(AGENT, 'fill_lane', { lane_id: 'links-slot', ticket: '861', epic: null });
    assert.match(cleared.value.warning, /which is closed: the link stays/);
    assert.equal(srv.store.getTicket('default', '861')!.epicId, id);
  });
});

test('upgrading to epics: two groups with one ticket, and a lane its own earlier question no longer blocks', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lanesignal-v17b-'));
  const file = path.join(dir, 'lanesignal.db');
  const resolveTicketUrl = () => null;
  try {
    let store = new Store({ path: file, resolveTicketUrl });
    store.upsertGroup('default/old-train', { name: 'Old train' }, 'bot');
    store.upsertGroup('default/new-train', { name: 'New train' }, 'bot');
    store.upsertLane('default/b-slot', { group: 'default/new-train' }, 'bot');
    const loose = store.createEscalation({ laneId: 'default/b-slot', question: 'Which ticket?' }, 'bot');
    store.upsertLane('default/b-slot', { ticket: '501', status: 'active' }, 'bot');
    store.close();
    // Back to v17, where the lane's own question still held it blocked after it took 501.
    const db = new DatabaseSync(file);
    db.exec(`${UNDO_V18}
      UPDATE groups SET ticket = '680' WHERE id = 'default/old-train';
      UPDATE groups SET ticket = '#680' WHERE id = 'default/new-train';
      UPDATE lanes SET status = 'blocked_human', blocked_since = updated_at WHERE id = 'default/b-slot';`);
    db.close();

    store = new Store({ path: file, resolveTicketUrl });
    const epics = store.listEpics();
    // The second group with the same ticket stood in as its own epic (v18); since v26 it holds its own questions.
    assert.deepEqual(
      epics.map((e) => [e.group, e.ref]).sort(),
      [['default/old-train', '680']],
    );
    assert.equal(store.getLane('default/b-slot')?.status, 'awaiting_agent');
    assert.equal(store.getEscalation(loose.id)?.state, 'open');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('advice on how a lane was published', () => {
  const pub = (name: string, args: Record<string, unknown>) => srv.tool(AGENT, name, args);

  test('a filled ticket with no epic is told which to name; once named, list_lanes and list_tickets show it', async () => {
    await pub('update_group', { group_id: 'advice', name: 'Advice' });
    await pub('update_epic', { epic: '7001', group: 'advice', name: 'Seven' });
    const loose = await pub('fill_lane', { lane_id: 'advice-1', group_id: 'advice', ticket: '7100' });
    assert.match(loose.value.warning, /name one with fill_lane's `epic`/);
    assert.match(loose.value.warning, /7001/);
    assert.equal(loose.value.epic, undefined);

    const named = await pub('fill_lane', { lane_id: 'advice-2', group_id: 'advice', ticket: '7101', epic: '7001' });
    assert.equal(named.value.warning, undefined, JSON.stringify(named.value));
    assert.equal(named.value.epic, '7001');
    const lanes = (await pub('list_lanes', { group_id: 'advice' })).value as { id: string; epic?: string }[];
    assert.equal(lanes.find((l) => l.id === 'advice-2')?.epic, '7001');
    assert.equal(lanes.find((l) => l.id === 'advice-1')?.epic, undefined);
    const tickets = (await pub('list_tickets', { group_id: 'advice' })).value as { code: string; epic?: string }[];
    assert.equal(tickets.find((t) => t.code === '7101')?.epic, '7001');
    assert.equal((await pub('get_ticket', { ticket: '7101' })).value.epic, '7001');
  });

  test('a group with no epics of its own hears nothing about naming one', async () => {
    await pub('update_group', { group_id: 'advice-plain', name: 'Plain' });
    const res = await pub('fill_lane', { lane_id: 'plain-1', group_id: 'advice-plain', ticket: '7200' });
    assert.equal(res.value.warning, undefined, JSON.stringify(res.value));
  });

  test('long activity, ticket-named lanes, emptied lanes, and finished tickets parked', async () => {
    await pub('update_group', { group_id: 'advice-habits', name: 'Habits' });
    assert.match((await pub('update_lane', { lane_id: 'habit-1', group_id: 'advice-habits', activity: 'x'.repeat(141) })).value.warning, /one line/);
    assert.equal((await pub('update_lane', { lane_id: 'habit-1', activity: 'x'.repeat(140) })).value.warning, undefined);

    assert.match((await pub('fill_lane', { lane_id: 'pr-7300', group_id: 'advice-habits', ticket: '7300' })).value.warning, /looks named after a ticket/);
    // A number no ticket has: a stream, not a ticket.
    assert.equal((await pub('fill_lane', { lane_id: 'release-2026', group_id: 'advice-habits', ticket: '7304' })).value.warning, undefined);
    assert.equal((await pub('fill_lane', { lane_id: 'slot-12', group_id: 'advice-habits', ticket: '7301' })).value.warning, undefined);

    const parked = await pub('fill_lane', { lane_id: 'slot-12', ticket: '7302', previous: 'park', reason: 'Merged PR #1, ticket resolved' });
    assert.match(parked.value.warning, /it's `done`, not parked/);
    assert.equal((await pub('fill_lane', { lane_id: 'slot-12', ticket: '7303', previous: 'park', reason: 'waiting on the vendor' })).value.warning, undefined);
    for (const [i, reason] of ['not merged yet', 'waiting until #945 is merged', 'unresolved conflicts', 'parked once #9 is resolved'].entries()) {
      const res = await pub('fill_lane', { lane_id: 'slot-12', ticket: String(7310 + i), previous: 'park', reason });
      assert.equal(res.value.warning, undefined, reason);
    }

    const emptied = await pub('fill_lane', { lane_id: 'slot-12', previous: 'done' });
    assert.match(emptied.value.warning, /remove_lane/);
    assert.equal((await pub('fill_lane', { lane_id: 'slot-12' })).value.warning, undefined, 'already empty: not told again');
  });

  test('advice comes once, when the ticket changes', async () => {
    await pub('update_group', { group_id: 'advice-once', name: 'Once' });
    await pub('update_epic', { epic: '7400', group: 'advice-once', name: 'Four' });
    assert.match((await pub('fill_lane', { lane_id: 'once-1', group_id: 'advice-once', ticket: '7401' })).value.warning, /fill_lane's `epic`/);
    assert.equal((await pub('update_lane', { lane_id: 'once-1', ticket: '7401', activity: 'Still on it' })).value.warning, undefined);
    assert.equal((await pub('fill_lane', { lane_id: 'once-1', ticket: '7401' })).value.warning, undefined);
    // Leaving a ticket with no epic on purpose isn't nagged.
    assert.equal((await pub('fill_lane', { lane_id: 'once-2', group_id: 'advice-once', ticket: '7402', epic: null })).value.warning, undefined);
  });

  test('a ticket naming a closed epic is not told to name one; another group\'s epic does not count', async () => {
    await pub('update_group', { group_id: 'advice-closed', name: 'Closed' });
    await pub('update_epic', { epic: '7500', group: 'advice-closed', name: 'Done soon' });
    await pub('update_epic', { epic: '7501', group: 'advice-closed', name: 'Stays' });
    const lane = await pub('fill_lane', { lane_id: 'closed-1', group_id: 'advice-closed', ticket: '7502', epic: '7500' });
    assert.equal(lane.value.epic, '7500');
    await pub('fill_lane', { lane_id: 'closed-1', previous: 'park', reason: 'for a moment' });
    await pub('request_epic_close', { epic: '7500', reason: 'Finished' });
    const list = (await srv.call('GET', '/api/epics?group=advice-closed', ALICE)).body as { id: number; displayRef: string }[];
    await srv.call('POST', `/api/epics/${list.find((e) => e.displayRef === '7500')!.id}/close`, ALICE, { approve: true });
    const back = await pub('fill_lane', { lane_id: 'closed-1', ticket: '7502' });
    assert.equal(back.value.epic, undefined);
    assert.doesNotMatch(back.value.warning ?? '', /name one with/);

    await pub('update_group', { group_id: 'advice-other', name: 'Other' });
    await pub('update_epic', { epic: '7600', group: 'advice-other', name: 'Theirs' });
    await pub('fill_lane', { lane_id: 'closed-2', group_id: 'advice-closed', ticket: '7601', epic: '7501' });
    await pub('fill_lane', { lane_id: 'closed-2', previous: 'park', reason: 'moving' });
    const moved = await pub('fill_lane', { lane_id: 'other-1', group_id: 'advice-other', ticket: '7601' });
    assert.equal(moved.value.epic, undefined);
    assert.match(moved.value.warning, /7600/);
    const lanes = (await pub('list_lanes', { group_id: 'advice-other' })).value as { id: string; epic?: string }[];
    assert.equal(lanes.find((l) => l.id === 'other-1')?.epic, undefined);
  });

  test('a server can turn advice off', async () => {
    const quiet = await startServer({ LANESIGNAL_LANE_ADVICE: 'false' });
    try {
      await quiet.tool(AGENT, 'update_group', { group_id: 'q' });
      const res = await quiet.tool(AGENT, 'update_lane', { lane_id: 'q-1', group_id: 'q', activity: 'x'.repeat(200) });
      assert.equal(res.value.warning, undefined);
    } finally {
      await quiet.close();
    }
  });
});
