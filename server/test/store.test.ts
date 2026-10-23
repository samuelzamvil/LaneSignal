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
      UPDATE meta SET value = '1' WHERE key = 'schema_version';
    `);
    db.close();

    store = new Store({ path: file, resolveTicketUrl });
    const migrated = store.getEscalation(esc.id);
    assert.equal(migrated?.question, 'Still here?');
    assert.deepEqual(migrated?.alternatives, []);
    assert.equal(migrated?.cost, null);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
