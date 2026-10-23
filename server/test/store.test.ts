import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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

test('waiting on an escalation whose lane is deleted rejects instead of returning stale state', async () => {
  const store = new Store({ path: ':memory:', resolveTicketUrl });
  const e = store.createEscalation({ laneId: 'l', question: 'Q?' }, 'bot');
  const waiting = store.waitForDecision(e.id, 5000);
  store.deleteLane('l');
  await assert.rejects(waiting, /no longer exists/);
  store.close();
});

test('rejects invalid numeric configuration at startup', async () => {
  const { loadConfig } = await import('../src/config.ts');
  const base = { LANESIGNAL_CONFIG: '/nonexistent.json', LANESIGNAL_AGENT_TOKENS: 'bot:agent-token-0123456789' };
  assert.throws(() => loadConfig({ ...base, LANESIGNAL_EVENT_RETENTION: 'abc' }), /LANESIGNAL_EVENT_RETENTION/);
  assert.throws(() => loadConfig({ ...base, LANESIGNAL_EVENT_RETENTION: '0' }), /LANESIGNAL_EVENT_RETENTION/);
  assert.throws(() => loadConfig({ ...base, PORT: '99999' }), /PORT/);
  assert.equal(loadConfig({ ...base, LANESIGNAL_STALE_MINUTES: '0' }).staleMinutes, 0);
});
