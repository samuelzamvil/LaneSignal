import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Store } from '../src/store.ts';

const resolveTicketUrl = (t: string) => `https://tickets.example/${t.replace(/^gh:/, '')}`;

test('a lane can hold several open escalations and stays blocked until all are decided', () => {
  const store = new Store({ path: ':memory:', resolveTicketUrl });
  store.upsertLane('wiring', { status: 'active', ticket: 'gh:900' }, 'bot');
  const questions = ['Add @google-cloud/tasks?', 'Use one queue per job type?', 'Set a 10 min deadline?', 'Retry 5x?'];
  const escs = questions.map((q) =>
    store.createEscalation(
      {
        laneId: 'wiring',
        question: q,
        ticket: 'gh:921',
        cost: 'Bigger image',
        alternatives: ['Hand-write the REST calls'],
      },
      'bot',
    ),
  );
  assert.equal(store.getLane('wiring')?.openEscalations, 4);
  assert.equal(escs[0].ticketUrl, 'https://tickets.example/921');
  assert.deepEqual(escs[0].alternatives, ['Hand-write the REST calls']);
  assert.deepEqual(
    store.listEscalations({ laneId: 'wiring' }).map((e) => e.question),
    questions,
  );

  for (const e of escs.slice(0, 3)) store.decideEscalation(e.id, 'yes', null, 'alice');
  assert.equal(store.getLane('wiring')?.status, 'blocked_human');
  assert.equal(store.getLane('wiring')?.openEscalations, 1);
  store.decideEscalation(escs[3].id, 'yes', null, 'alice');
  assert.equal(store.getLane('wiring')?.status, 'awaiting_agent');
  store.close();
});

test('upgrades a schema v1 database without losing escalations', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lanesignal-'));
  const file = path.join(dir, 'db.sqlite');
  try {
    let store = new Store({ path: file, resolveTicketUrl });
    const esc = store.createEscalation({ laneId: 'old-lane', question: 'Still here?' }, 'bot');
    store.close();

    // Roll the file back to the v1 layout.
    const db = new DatabaseSync(file);
    db.exec(`
      ALTER TABLE escalations DROP COLUMN ticket;
      ALTER TABLE escalations DROP COLUMN cost;
      ALTER TABLE escalations DROP COLUMN alternatives;
      ALTER TABLE escalations DROP COLUMN blocking;
      ALTER TABLE lanes DROP COLUMN archived_at;
      ALTER TABLE groups DROP COLUMN archived_at;
      UPDATE meta SET value = '1' WHERE key = 'schema_version';
    `);
    db.close();

    store = new Store({ path: file, resolveTicketUrl });
    const migrated = store.getEscalation(esc.id);
    assert.equal(migrated?.question, 'Still here?');
    assert.deepEqual(migrated?.alternatives, []);
    assert.equal(migrated?.cost, null);
    assert.equal(migrated?.blocking, true);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses a pre-release database instead of failing on every write', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lanesignal-'));
  const file = path.join(dir, 'db.sqlite');
  try {
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE lanes (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT);
    `);
    db.close();
    assert.throws(() => new Store({ path: file, resolveTicketUrl }), /pre-release LaneSignal build/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FYI (non-blocking) escalations do not keep a lane blocked', () => {
  const store = new Store({ path: ':memory:', resolveTicketUrl });
  const blocking = store.createEscalation({ laneId: 'l', question: 'Blocking?' }, 'bot');
  store.createEscalation({ laneId: 'l', question: 'FYI?', blocking: false }, 'bot');
  assert.equal(store.getLane('l')?.status, 'blocked_human');
  store.decideEscalation(blocking.id, 'yes', null, 'alice');
  assert.equal(store.getLane('l')?.status, 'awaiting_agent');
  assert.equal(store.getLane('l')?.openEscalations, 1);
  store.close();
});

test('acknowledging or withdrawing never unblocks a lane the agent blocked itself', () => {
  const store = new Store({ path: ':memory:', resolveTicketUrl });
  const e1 = store.createEscalation({ laneId: 'l', question: 'One?' }, 'bot');
  const e2 = store.createEscalation({ laneId: 'l', question: 'Two?', blocking: false }, 'bot');
  store.decideEscalation(e1.id, 'yes', null, 'alice');
  store.decideEscalation(e2.id, 'yes', null, 'alice');
  store.upsertLane('l', { status: 'blocked_human', activity: 'waiting for creds rotation' }, 'bot');
  store.acknowledgeEscalation(e1.id, null, 'bot');
  store.withdrawEscalation(e2.id, 'moot', 'bot');
  assert.equal(store.getLane('l')?.status, 'blocked_human');
  store.close();
});

test('lane history returns the newest escalations, oldest first', () => {
  const store = new Store({ path: ':memory:', resolveTicketUrl });
  for (let i = 0; i < 60; i++) store.createEscalation({ laneId: 'l', question: `q${i}`, blocking: false }, 'bot');
  const recent = store.listEscalations({ laneId: 'l', limit: 50 });
  assert.equal(recent.length, 50);
  assert.equal(recent[0].question, 'q10');
  assert.equal(recent[49].question, 'q59');
  store.close();
});

test('positions are capped per escalation', () => {
  const store = new Store({ path: ':memory:', resolveTicketUrl });
  const e = store.createEscalation({ laneId: 'l', question: 'Q?' }, 'bot');
  for (let i = 0; i < 20; i++) store.addPosition(e.id, { agent: `a${i}`, stance: 'agree' }, 'bot');
  assert.throws(() => store.addPosition(e.id, { agent: 'a20', stance: 'agree' }, 'bot'), /At most 20/);
  // Replacing an existing agent's position still works at the cap.
  store.addPosition(e.id, { agent: 'a0', stance: 'disagree' }, 'bot');
  store.close();
});

test('removing a lane withdraws its waiting escalation instead of leaving the agent hanging', async () => {
  const store = new Store({ path: ':memory:', resolveTicketUrl });
  const e = store.createEscalation({ laneId: 'l', question: 'Q?' }, 'bot');
  const waiting = store.waitForDecision(e.id, 5000);
  store.deleteLane('l', 'alice');
  const result = await waiting;
  assert.equal(result.state, 'withdrawn');
  assert.equal(result.resolution, 'Lane removed by alice');
  store.close();
});

test('removing a lane archives it: hidden from the dashboard, kept for export, restored on republish', () => {
  const store = new Store({ path: ':memory:', resolveTicketUrl });
  store.upsertLane('l', { name: 'Lane', group: 'g', status: 'active' }, 'bot');
  const e = store.createEscalation({ laneId: 'l', question: 'Q?' }, 'bot');
  store.decideEscalation(e.id, 'yes', null, 'alice');
  store.acknowledgeEscalation(e.id, 'done', 'bot');
  store.createEscalation({ laneId: 'l', question: 'Still open?' }, 'bot');
  store.deleteLane('l', 'alice');

  assert.equal(store.getLane('l'), null);
  assert.deepEqual(store.listLanes(), []);
  assert.deepEqual(store.listEscalations(), []);
  assert.deepEqual(
    store.exportRows('escalations').map((r) => [r.question, r.state]),
    [
      ['Q?', 'acknowledged'],
      ['Still open?', 'withdrawn'],
    ],
  );
  const lanes = store.exportRows('lanes');
  assert.equal(lanes.length, 1);
  assert.ok(lanes[0].archived_at);

  store.upsertLane('l', { status: 'active' }, 'bot');
  assert.equal(store.getLane('l')?.name, 'Lane');
  assert.ok(store.laneEvents('l').some((ev) => ev.message === 'Lane restored'));
  store.close();
});

test('removing a group archives it; lanes read as ungrouped but exports keep the group', () => {
  const store = new Store({ path: ':memory:', resolveTicketUrl });
  store.upsertGroup('payments', { name: 'Payments epic' }, 'bot');
  store.upsertLane('l', { group: 'payments' }, 'bot');
  store.deleteGroup('payments', 'alice');
  assert.equal(store.getLane('l')?.group, null);
  assert.deepEqual(store.listGroups(), []);
  // An unrelated update must not drop the lane's group association.
  store.upsertLane('l', { activity: 'still going' }, 'bot');
  const lane = store.exportRows('lanes')[0];
  assert.equal(lane.group_id, 'payments');
  assert.equal(lane.group_name, 'Payments epic');
  assert.ok(store.exportRows('groups')[0].archived_at);
  // Publishing to the group again brings it back.
  store.upsertLane('l2', { group: 'payments' }, 'bot');
  assert.equal(store.listGroups()[0].name, 'Payments epic');
  store.close();
});

test('only routine activity text is trimmed; status and escalation history is kept', () => {
  const store = new Store({ path: ':memory:', resolveTicketUrl, eventRetention: 2 });
  const statuses = ['active', 'pending_ci', 'active', 'pending_ci', 'active'] as const;
  statuses.forEach((status, i) => store.upsertLane('l', { status, activity: `step ${i}` }, 'bot'));
  const events = store.exportRows('events');
  assert.equal(events.filter((e) => e.kind === 'activity').length, 2);
  assert.equal(events.filter((e) => e.kind === 'status').length, 5); // created + 4 changes
  store.close();
});

test('escalation export computes timings and recommendation follow-through', () => {
  let now = Date.parse('2026-10-01T10:00:00Z');
  const store = new Store({ path: ':memory:', resolveTicketUrl, now: () => new Date(now) });
  const e = store.createEscalation(
    {
      laneId: 'l',
      question: 'Merge?',
      options: ['Merge', 'Wait'],
      recommendedOption: 'Merge',
      alternatives: ['Wait a day', 'Split it'],
      positions: [{ agent: 'rev', stance: 'agree' }],
    },
    'bot',
  );
  now += 90_000;
  store.decideEscalation(e.id, 'Merge', null, 'alice');
  now += 30_000;
  store.acknowledgeEscalation(e.id, null, 'bot');
  const [row] = store.exportRows('escalations');
  assert.equal(row.seconds_to_decision, 90);
  assert.equal(row.seconds_to_acknowledge, 30);
  assert.equal(row.followed_recommendation, true);
  assert.equal(row.alternatives, 'Wait a day | Split it');
  assert.equal(row.positions_agree, 1);
  assert.equal(store.exportRows('escalations', { from: '2026-10-02T00:00:00.000Z' }).length, 0);
  assert.equal(store.exportRows('positions')[0].agent, 'rev');
  store.close();
});

test('CSV export escapes quotes and newlines and defuses spreadsheet formulas', async () => {
  const { toCsv } = await import('../src/export.ts');
  const csv = toCsv([{ a: 'say "hi"', b: 'line1\nline2', c: '=HYPERLINK("x")', d: 3, e: null }]);
  assert.equal(csv, 'a,b,c,d,e\r\n"say ""hi""","line1\nline2","\'=HYPERLINK(""x"")",3,\r\n');
});

test('rejects invalid numeric configuration at startup', async () => {
  const { loadConfig } = await import('../src/config.ts');
  const base = { LANESIGNAL_CONFIG: '/nonexistent.json', LANESIGNAL_AGENT_TOKENS: 'bot:agent-token-0123456789' };
  assert.throws(() => loadConfig({ ...base, LANESIGNAL_EVENT_RETENTION: 'abc' }), /LANESIGNAL_EVENT_RETENTION/);
  assert.throws(() => loadConfig({ ...base, LANESIGNAL_EVENT_RETENTION: '0' }), /LANESIGNAL_EVENT_RETENTION/);
  assert.throws(() => loadConfig({ ...base, PORT: '99999' }), /PORT/);
  assert.equal(loadConfig({ ...base, LANESIGNAL_STALE_MINUTES: '0' }).staleMinutes, 0);
});

test('LANESIGNAL_TRUST_PROXY accepts hop counts and address lists', async () => {
  const { loadConfig } = await import('../src/config.ts');
  const base = { LANESIGNAL_CONFIG: '/nonexistent.json', LANESIGNAL_AGENT_TOKENS: 'bot:agent-token-0123456789' };
  assert.equal(loadConfig(base).trustProxy, false);
  assert.equal(loadConfig({ ...base, LANESIGNAL_TRUST_PROXY: '1' }).trustProxy, 1);
  assert.equal(loadConfig({ ...base, LANESIGNAL_TRUST_PROXY: 'true' }).trustProxy, true);
  assert.equal(loadConfig({ ...base, LANESIGNAL_TRUST_PROXY: 'loopback, 10.0.0.0/8' }).trustProxy, 'loopback, 10.0.0.0/8');
  assert.equal(loadConfig({ ...base, LANESIGNAL_TRUST_PROXY: 'FALSE' }).trustProxy, false);
  assert.throws(() => loadConfig({ ...base, LANESIGNAL_TRUST_PROXY: 'yes' }), /LANESIGNAL_TRUST_PROXY/);
  assert.throws(() => loadConfig({ ...base, LANESIGNAL_TRUST_PROXY: '10.0.0.0/99' }), /LANESIGNAL_TRUST_PROXY/);
});

test('tokens generated by earlier versions keep working next to configured ones', async () => {
  const { loadConfig } = await import('../src/config.ts');
  const dir = mkdtempSync(path.join(tmpdir(), 'lanesignal-legacy-'));
  try {
    writeFileSync(
      path.join(dir, 'generated-tokens.json'),
      JSON.stringify([{ name: 'overseer', role: 'overseer', token: 'legacy-token-0123456789' }]),
    );
    const config = loadConfig({
      LANESIGNAL_CONFIG: '/nonexistent.json',
      LANESIGNAL_DATA_DIR: dir,
      LANESIGNAL_HUMAN_TOKENS: 'ops:ops-token-0123456789abc',
    });
    assert.deepEqual(
      config.tokens.map((t) => `${t.name}:${t.role}`),
      ['ops:human', 'overseer:human'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
