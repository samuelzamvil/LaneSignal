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
  store.upsertLane('default/wiring', { status: 'active', ticket: 'gh:900' }, 'bot');
  const questions = ['Add @google-cloud/tasks?', 'Use one queue per job type?', 'Set a 10 min deadline?', 'Retry 5x?'];
  const escs = questions.map((q) =>
    store.createEscalation(
      {
        laneId: 'default/wiring',
        question: q,
        ticket: 'gh:921',
        cost: 'Bigger image',
        alternatives: ['Hand-write the REST calls'],
      },
      'bot',
    ),
  );
  assert.equal(store.getLane('default/wiring')?.openEscalations, 4);
  assert.equal(escs[0].ticketUrl, 'https://tickets.example/921');
  assert.deepEqual(escs[0].alternatives, ['Hand-write the REST calls']);
  assert.deepEqual(
    store.listEscalations({ laneId: 'default/wiring' }).map((e) => e.question),
    questions,
  );

  for (const e of escs.slice(0, 3)) store.decideEscalation(e.id, 'yes', null, 'alice');
  assert.equal(store.getLane('default/wiring')?.status, 'blocked_human');
  assert.equal(store.getLane('default/wiring')?.openEscalations, 1);
  store.decideEscalation(escs[3].id, 'yes', null, 'alice');
  assert.equal(store.getLane('default/wiring')?.status, 'awaiting_agent');
  store.close();
});

test('upgrades a schema v1 database without losing escalations', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lanesignal-'));
  const file = path.join(dir, 'db.sqlite');
  try {
    let store = new Store({ path: file, resolveTicketUrl });
    const esc = store.createEscalation({ laneId: 'default/old-lane', question: 'Still here?' }, 'bot');
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
      PRAGMA foreign_keys = OFF;
      DROP INDEX lanes_project;
      DROP INDEX escalations_project;
      DROP INDEX lanes_letter;
      DROP INDEX escalations_code;
      ALTER TABLE groups DROP COLUMN project_id;
      ALTER TABLE lanes DROP COLUMN project_id;
      ALTER TABLE escalations DROP COLUMN project_id;
      ALTER TABLE requirements DROP COLUMN project_id;
      DROP TABLE project_members;
      DROP TABLE project_notify;
      DROP TABLE projects;
      UPDATE groups SET id = substr(id, 9);
      UPDATE lanes SET id = substr(id, 9), group_id = CASE WHEN group_id IS NULL THEN NULL ELSE substr(group_id, 9) END;
      UPDATE escalations SET lane_id = substr(lane_id, 9);
      UPDATE lane_events SET lane_id = substr(lane_id, 9);
      UPDATE requirements SET group_id = substr(group_id, 9) WHERE group_id IS NOT NULL;
      CREATE UNIQUE INDEX lanes_letter ON lanes(letter_index) WHERE letter_index IS NOT NULL;
      CREATE UNIQUE INDEX escalations_code ON escalations(letter_index, seq) WHERE letter_index IS NOT NULL;
      DROP TABLE requirements_fts;
      DROP TABLE requirements_fts_plain;
      DROP TABLE requirements;
      DROP INDEX lanes_letter;
      DROP INDEX escalations_code;
      ALTER TABLE lanes DROP COLUMN letter_index;
      ALTER TABLE escalations DROP COLUMN letter_index;
      ALTER TABLE escalations DROP COLUMN seq;
      DROP INDEX escalations_ref;
      ALTER TABLE escalations DROP COLUMN ref;
      ALTER TABLE escalations DROP COLUMN withdrawn_by;
      ALTER TABLE push_tokens DROP COLUMN user_id;
      ALTER TABLE push_tokens DROP COLUMN legacy;
      UPDATE meta SET value = '1' WHERE key = 'schema_version';
    `);
    db.close();

    store = new Store({ path: file, resolveTicketUrl });
    const migrated = store.getEscalation(esc.id);
    assert.equal(migrated?.question, 'Still here?');
    assert.deepEqual(migrated?.alternatives, []);
    assert.equal(migrated?.cost, null);
    assert.equal(migrated?.blocking, true);
    assert.equal(migrated?.ref, 'A1');
    assert.equal(store.getEscalation('a1')?.id, esc.id);
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
  const blocking = store.createEscalation({ laneId: 'default/l', question: 'Blocking?' }, 'bot');
  store.createEscalation({ laneId: 'default/l', question: 'FYI?', blocking: false }, 'bot');
  assert.equal(store.getLane('default/l')?.status, 'blocked_human');
  store.decideEscalation(blocking.id, 'yes', null, 'alice');
  assert.equal(store.getLane('default/l')?.status, 'awaiting_agent');
  assert.equal(store.getLane('default/l')?.openEscalations, 1);
  store.close();
});

test('acknowledging or withdrawing never unblocks a lane the agent blocked itself', () => {
  const store = new Store({ path: ':memory:', resolveTicketUrl });
  const e1 = store.createEscalation({ laneId: 'default/l', question: 'One?' }, 'bot');
  const e2 = store.createEscalation({ laneId: 'default/l', question: 'Two?', blocking: false }, 'bot');
  store.decideEscalation(e1.id, 'yes', null, 'alice');
  store.decideEscalation(e2.id, 'yes', null, 'alice');
  store.upsertLane('default/l', { status: 'blocked_human', activity: 'waiting for creds rotation' }, 'bot');
  store.acknowledgeEscalation(e1.id, null, 'bot');
  store.withdrawEscalation(e2.id, 'moot', 'bot');
  assert.equal(store.getLane('default/l')?.status, 'blocked_human');
  store.close();
});

test('lane history returns the newest escalations, oldest first', () => {
  const store = new Store({ path: ':memory:', resolveTicketUrl });
  for (let i = 0; i < 60; i++) store.createEscalation({ laneId: 'default/l', question: `q${i}`, blocking: false }, 'bot');
  const recent = store.listEscalations({ laneId: 'default/l', limit: 50 });
  assert.equal(recent.length, 50);
  assert.equal(recent[0].question, 'q10');
  assert.equal(recent[49].question, 'q59');
  store.close();
});

test('positions are capped per escalation', () => {
  const store = new Store({ path: ':memory:', resolveTicketUrl });
  const e = store.createEscalation({ laneId: 'default/l', question: 'Q?' }, 'bot');
  for (let i = 0; i < 20; i++) store.addPosition(e.id, { agent: `a${i}`, stance: 'agree' }, 'bot');
  assert.throws(() => store.addPosition(e.id, { agent: 'a20', stance: 'agree' }, 'bot'), /At most 20/);
  // Replacing an existing agent's position still works at the cap.
  store.addPosition(e.id, { agent: 'a0', stance: 'disagree' }, 'bot');
  store.close();
});

test('removing a lane withdraws its waiting escalation instead of leaving the agent hanging', async () => {
  const store = new Store({ path: ':memory:', resolveTicketUrl });
  const e = store.createEscalation({ laneId: 'default/l', question: 'Q?' }, 'bot');
  const waiting = store.waitForDecision(e.id, 5000);
  store.deleteLane('default/l', 'alice');
  const result = await waiting;
  assert.equal(result.state, 'withdrawn');
  assert.equal(result.resolution, 'Lane removed by alice');
  store.close();
});

test('removing a lane archives it: hidden from the dashboard, kept for export, restored on republish', () => {
  const store = new Store({ path: ':memory:', resolveTicketUrl });
  store.upsertLane('default/l', { name: 'Lane', group: 'default/g', status: 'active' }, 'bot');
  const e = store.createEscalation({ laneId: 'default/l', question: 'Q?' }, 'bot');
  store.decideEscalation(e.id, 'yes', null, 'alice');
  store.acknowledgeEscalation(e.id, 'done', 'bot');
  store.createEscalation({ laneId: 'default/l', question: 'Still open?' }, 'bot');
  store.deleteLane('default/l', 'alice');

  assert.equal(store.getLane('default/l'), null);
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

  store.upsertLane('default/l', { status: 'active' }, 'bot');
  assert.equal(store.getLane('default/l')?.name, 'Lane');
  assert.ok(store.laneEvents('default/l').some((ev) => ev.message === 'Lane restored'));
  store.close();
});

test('removing a group archives it; lanes read as ungrouped but exports keep the group', () => {
  const store = new Store({ path: ':memory:', resolveTicketUrl });
  store.upsertGroup('default/payments', { name: 'Payments epic' }, 'bot');
  store.upsertLane('default/l', { group: 'default/payments' }, 'bot');
  store.deleteGroup('default/payments', 'alice');
  assert.equal(store.getLane('default/l')?.group, null);
  assert.deepEqual(store.listGroups(), []);
  // An unrelated update must not drop the lane's group association.
  store.upsertLane('default/l', { activity: 'still going' }, 'bot');
  const lane = store.exportRows('lanes')[0];
  assert.equal(lane.group_id, 'payments');
  assert.equal(lane.group_name, 'Payments epic');
  assert.ok(store.exportRows('groups')[0].archived_at);
  // Publishing to the group again brings it back.
  store.upsertLane('default/l2', { group: 'default/payments' }, 'bot');
  assert.equal(store.listGroups()[0].name, 'Payments epic');
  store.close();
});

test('only routine activity text is trimmed; status and escalation history is kept', () => {
  const store = new Store({ path: ':memory:', resolveTicketUrl, eventRetention: 2 });
  const statuses = ['active', 'pending_ci', 'active', 'pending_ci', 'active'] as const;
  statuses.forEach((status, i) => store.upsertLane('default/l', { status, activity: `step ${i}` }, 'bot'));
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
      laneId: 'default/l',
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

test('removing a blocked lane ends its blocked spell; decided answers survive and can be acknowledged', () => {
  let now = Date.parse('2026-10-01T10:00:00Z');
  const store = new Store({ path: ':memory:', resolveTicketUrl, now: () => new Date(now) });
  const changes: string[] = [];
  store.events.on('change', (e) => changes.push(e.type === 'lane' ? `lane:${e.lane.id}` : e.type));
  store.upsertLane('default/a', { status: 'active' }, 'bot');
  const decided = store.createEscalation({ laneId: 'default/a', question: 'Decided?', blocking: false }, 'bot');
  store.decideEscalation(decided.id, 'yes', null, 'alice');
  store.createEscalation({ laneId: 'default/a', question: 'Open?' }, 'bot');
  now += 60_000;
  store.deleteLane('default/a', 'alice');
  now += 3_600_000;

  const lane = store.exportRows('lanes')[0];
  assert.equal(lane.status, 'idle');
  assert.equal(lane.blocked_seconds_total, 60);
  const states = Object.fromEntries(store.exportRows('escalations').map((r) => [r.question, r.state]));
  assert.deepEqual(states, { 'Decided?': 'decided', 'Open?': 'withdrawn' });
  assert.ok(
    store.exportRows('events').some((e) => e.kind === 'escalation' && e.message === 'Escalation closed: Lane removed by alice'),
  );

  // The agent acting on the earlier answer can still acknowledge it, without the lane reappearing.
  changes.length = 0;
  store.acknowledgeEscalation(decided.id, 'done', 'bot');
  assert.deepEqual(changes, ['escalation']);

  store.upsertLane('default/a', { activity: 'back' }, 'bot');
  assert.equal(store.getLane('default/a')?.status, 'idle');
  assert.equal(store.getLane('default/a')?.blockedTotalMs, 60_000);
  store.close();
});

test('restoring an archived group re-sends its lanes so clients regroup them', () => {
  const store = new Store({ path: ':memory:', resolveTicketUrl });
  store.upsertLane('default/b', { group: 'default/g2' }, 'bot');
  store.upsertLane('default/c', { group: 'default/g2' }, 'bot');
  store.deleteGroup('default/g2', 'alice');
  const lanes: string[] = [];
  store.events.on('change', (e) => e.type === 'lane' && lanes.push(`${e.lane.id}:${e.lane.group}`));
  store.upsertGroup('default/g2', { name: 'G2 again' }, 'bot');
  assert.deepEqual(lanes.sort(), ['default/b:default/g2', 'default/c:default/g2']);
  store.close();
});

test('every export row has exactly the documented columns, so headers never change', async () => {
  const { EXPORT_COLUMNS, EXPORT_DATASETS } = await import('../src/store.ts');
  const { datasetCsv } = await import('../src/export.ts');
  const store = new Store({ path: ':memory:', resolveTicketUrl });
  store.upsertLane('default/l', { group: 'default/g' }, 'bot');
  store.createEscalation({ laneId: 'default/l', question: 'Q?', positions: [{ agent: 'r', stance: 'agree' }] }, 'bot');
  for (const d of EXPORT_DATASETS) {
    for (const row of store.exportRows(d)) assert.deepEqual(Object.keys(row), [...EXPORT_COLUMNS[d]], d);
    const empty = datasetCsv(store, d, { laneId: 'default/nope' });
    const full = datasetCsv(store, d, {});
    assert.equal(empty.split('\r\n')[0], full.split('\r\n')[0], d);
  }
  store.close();
});

test('positions are filtered by when each position was taken', () => {
  let now = Date.parse('2026-10-01T10:00:00Z');
  const store = new Store({ path: ':memory:', resolveTicketUrl, now: () => new Date(now) });
  const e = store.createEscalation({ laneId: 'default/l', question: 'Q?' }, 'bot');
  now = Date.parse('2026-10-05T10:00:00Z');
  store.addPosition(e.id, { agent: 'late', stance: 'agree' }, 'bot');
  assert.equal(store.exportRows('positions', { to: '2026-10-03T00:00:00.000Z' }).length, 0);
  assert.equal(store.exportRows('positions', { from: '2026-10-03T00:00:00.000Z' }).length, 1);
  store.close();
});

test('export date filters are UTC-only and strict', async () => {
  const { exportFilter } = await import('../src/schemas.ts');
  assert.equal(exportFilter.parse({ from: '2026-10-01' }).from, '2026-10-01T00:00:00.000Z');
  assert.equal(exportFilter.parse({ from: '2026-10-01T10:00:00+02:00' }).from, '2026-10-01T08:00:00.000Z');
  for (const bad of [{ from: '2026-10-01T10:00' }, { from: '2026-02-30' }, { lane_id: 'x' }, { from: '2026-10-02', to: '2026-10-01' }]) {
    assert.equal(exportFilter.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test('a removed person\'s phones are dropped, but not a static token\'s that shares the name', () => {
  const store = new Store({ path: ':memory:', resolveTicketUrl });
  store.addPushToken('account-token-0', 'android', 'Carol', 'u-carol');
  store.addPushToken('static-token-00', 'android', 'Carol');
  store.addPushToken('other-token-000', 'android', 'Dan', 'u-dan');
  store.removePushTokensOf('u-carol', 'Carol');
  assert.deepEqual(
    store.listPushTokens().map((t) => t.token).sort(),
    ['other-token-000', 'static-token-00'],
  );
  store.close();
});

test('tokens registered before the upgrade are matched by name', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lanesignal-'));
  const file = path.join(dir, 'db.sqlite');
  try {
    let store = new Store({ path: file, resolveTicketUrl });
    store.close();
    const db = new DatabaseSync(file);
    db.exec(`
      PRAGMA foreign_keys = OFF;
      DROP INDEX lanes_project;
      DROP INDEX escalations_project;
      DROP INDEX lanes_letter;
      DROP INDEX escalations_code;
      ALTER TABLE groups DROP COLUMN project_id;
      ALTER TABLE lanes DROP COLUMN project_id;
      ALTER TABLE escalations DROP COLUMN project_id;
      ALTER TABLE requirements DROP COLUMN project_id;
      DROP TABLE project_members;
      DROP TABLE project_notify;
      DROP TABLE projects;
      UPDATE groups SET id = substr(id, 9);
      UPDATE lanes SET id = substr(id, 9), group_id = CASE WHEN group_id IS NULL THEN NULL ELSE substr(group_id, 9) END;
      UPDATE escalations SET lane_id = substr(lane_id, 9);
      UPDATE lane_events SET lane_id = substr(lane_id, 9);
      UPDATE requirements SET group_id = substr(group_id, 9) WHERE group_id IS NOT NULL;
      CREATE UNIQUE INDEX lanes_letter ON lanes(letter_index) WHERE letter_index IS NOT NULL;
      CREATE UNIQUE INDEX escalations_code ON escalations(letter_index, seq) WHERE letter_index IS NOT NULL;
      DROP TABLE requirements_fts;
      DROP TABLE requirements_fts_plain;
      DROP TABLE requirements;
      DROP INDEX lanes_letter;
      DROP INDEX escalations_code;
      ALTER TABLE lanes DROP COLUMN letter_index;
      ALTER TABLE escalations DROP COLUMN letter_index;
      ALTER TABLE escalations DROP COLUMN seq;
      DROP INDEX escalations_ref;
      ALTER TABLE escalations DROP COLUMN ref;
      ALTER TABLE escalations DROP COLUMN withdrawn_by;
      ALTER TABLE push_tokens DROP COLUMN user_id;
      ALTER TABLE push_tokens DROP COLUMN legacy;
      INSERT INTO push_tokens (token, platform, owner, created_at) VALUES ('old-carol-token', 'android', 'Carol', 'x');
      UPDATE meta SET value = '4' WHERE key = 'schema_version';
    `);
    db.close();
    store = new Store({ path: file, resolveTicketUrl });
    store.removePushTokensOf('u-carol', 'Carol');
    assert.deepEqual(store.listPushTokens(), []);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('active lanes get letters, smallest free first; finished lanes give theirs back', () => {
  const store = new Store({ path: ':memory:', resolveTicketUrl });
  store.upsertLane('default/one', {}, 'bot');
  store.upsertLane('default/two', {}, 'bot');
  assert.equal(store.getLane('default/one')?.letter, 'A');
  assert.equal(store.getLane('default/two')?.letter, 'B');
  const a1 = store.createEscalation({ laneId: 'default/one', question: 'First?' }, 'bot');
  const b1 = store.createEscalation({ laneId: 'default/two', question: 'Other lane?' }, 'bot');
  assert.deepEqual([a1.ref, b1.ref], ['A1', 'B1']);
  // Completing a lane keeps its letter while a question is still unanswered...
  store.upsertLane('default/one', { status: 'completed' }, 'bot');
  assert.equal(store.getLane('default/one')?.letter, 'A');
  store.decideEscalation(a1.id, 'yes', null, 'alice');
  assert.equal(store.getLane('default/one')?.letter, 'A', 'decided but not picked up yet');
  store.acknowledgeEscalation(a1.id, null, 'bot');
  assert.equal(store.getLane('default/one')?.letter, null);
  // ...and the next lane takes the free letter; codes keep counting so they never repeat.
  store.upsertLane('default/three', {}, 'bot');
  assert.equal(store.getLane('default/three')?.letter, 'A');
  const next = store.createEscalation({ laneId: 'default/three', question: 'Reused letter?' }, 'bot');
  assert.equal(next.ref, 'A2');
  assert.equal(store.getEscalation('A1')?.id, a1.id);
  assert.equal(store.getEscalation('#a2')?.id, next.id);
  // A finished lane that gets a new question takes a letter again.
  const back = store.createEscalation({ laneId: 'default/one', question: 'One more?' }, 'bot');
  assert.equal(store.getLane('default/one')?.letter, 'C');
  assert.equal(back.ref, 'C1');
  // Removing a lane frees its letter once nothing is pending.
  store.deleteLane('default/two', 'alice');
  assert.equal(store.listLanes().find((l) => l.id === 'two'), undefined);
  store.upsertLane('default/four', {}, 'bot');
  assert.equal(store.getLane('default/four')?.letter, 'B');
  store.close();
});

test('letters go past Z like spreadsheet columns', () => {
  const store = new Store({ path: ':memory:', resolveTicketUrl });
  for (let i = 0; i < 28; i++) store.upsertLane(`default/lane-${i}`, {}, 'bot');
  assert.equal(store.getLane('default/lane-25')?.letter, 'Z');
  assert.equal(store.getLane('default/lane-26')?.letter, 'AA');
  assert.equal(store.createEscalation({ laneId: 'default/lane-27', question: 'Far?' }, 'bot').ref, 'AB1');
  assert.equal(store.getEscalation('ab1')?.laneId, 'default/lane-27');
  store.close();
});

test('upgrading gives active lanes letters first and keeps every code unique', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lanesignal-'));
  const file = path.join(dir, 'db.sqlite');
  try {
    let store = new Store({ path: file, resolveTicketUrl });
    store.upsertLane('default/done', {}, 'bot');
    const old = store.createEscalation({ laneId: 'default/done', question: 'Old?' }, 'bot');
    store.withdrawEscalation(old.id, null, 'bot');
    store.upsertLane('default/done', { status: 'completed' }, 'bot');
    store.upsertLane('default/live', {}, 'bot');
    const open = store.createEscalation({ laneId: 'default/live', question: 'Open?' }, 'bot');
    store.close();
    const db = new DatabaseSync(file);
    db.exec(`
      PRAGMA foreign_keys = OFF;
      DROP INDEX lanes_project;
      DROP INDEX escalations_project;
      DROP INDEX lanes_letter;
      DROP INDEX escalations_code;
      ALTER TABLE groups DROP COLUMN project_id;
      ALTER TABLE lanes DROP COLUMN project_id;
      ALTER TABLE escalations DROP COLUMN project_id;
      ALTER TABLE requirements DROP COLUMN project_id;
      DROP TABLE project_members;
      DROP TABLE project_notify;
      DROP TABLE projects;
      UPDATE groups SET id = substr(id, 9);
      UPDATE lanes SET id = substr(id, 9), group_id = CASE WHEN group_id IS NULL THEN NULL ELSE substr(group_id, 9) END;
      UPDATE escalations SET lane_id = substr(lane_id, 9);
      UPDATE lane_events SET lane_id = substr(lane_id, 9);
      UPDATE requirements SET group_id = substr(group_id, 9) WHERE group_id IS NOT NULL;
      CREATE UNIQUE INDEX lanes_letter ON lanes(letter_index) WHERE letter_index IS NOT NULL;
      CREATE UNIQUE INDEX escalations_code ON escalations(letter_index, seq) WHERE letter_index IS NOT NULL;
      DROP TABLE requirements_fts;
      DROP TABLE requirements_fts_plain;
      DROP TABLE requirements;
      DROP INDEX lanes_letter;
      DROP INDEX escalations_code;
      ALTER TABLE lanes DROP COLUMN letter_index;
      ALTER TABLE escalations DROP COLUMN letter_index;
      ALTER TABLE escalations DROP COLUMN seq;
      UPDATE meta SET value = '5' WHERE key = 'schema_version';
    `);
    db.close();
    store = new Store({ path: file, resolveTicketUrl });
    assert.equal(store.getLane('default/live')?.letter, 'A');
    assert.equal(store.getLane('default/done')?.letter, null);
    assert.equal(store.getEscalation(open.id)?.ref, 'A1');
    assert.equal(store.getEscalation(old.id)?.ref, 'B1');
    assert.equal(store.createEscalation({ laneId: 'default/live', question: 'New?' }, 'bot').ref, 'A2');
    // Numbers from before the upgrade (#1 was the first escalation) still resolve.
    assert.equal(store.getEscalation('#1')?.id, old.id);
    assert.equal(store.getEscalation('2')?.id, open.id);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

