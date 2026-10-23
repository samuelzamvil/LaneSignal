// Product requirements: owner decisions that agents record and find later.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { AGENT, ALICE, startServer } from './helpers.ts';

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  srv = await startServer();
  await srv.tool(AGENT, 'update_group', { group_id: 'payments', name: 'Payments train' });
  await srv.tool(AGENT, 'update_group', { group_id: 'search', name: 'Search train' });
});
after(() => srv.close());

const record = (args: Record<string, unknown>, token = AGENT) => srv.tool(token, 'record_requirement', args);

describe('recording owner decisions', () => {
  test('from an answered escalation: the decider is recorded', async () => {
    const e = (await srv.tool(AGENT, 'create_escalation', { lane_id: 'pay-1', question: 'How many payout retries?' })).value;
    await srv.call('POST', `/api/escalations/${e.ref}/decide`, ALICE, { decision: '5, then dead-letter' });
    const res = await record({
      requirement: 'Payout jobs retry at most 5 times, then go to the dead-letter queue.',
      justification: 'Retries beyond 5 only delayed alerts in the March incident.',
      tags: ['payout-retries', 'Dead-Letter'],
      group_id: 'payments',
      source_escalation: e.ref,
    });
    assert.equal(res.isError, false, res.text);
    const req = res.value.requirement;
    assert.match(req.id, /^R\d+$/);
    assert.equal(req.decidedBy, 'alice');
    assert.equal(req.sourceEscalation, e.ref);
    assert.equal(req.recordedBy, 'overseer');
    assert.equal(req.group, 'payments');
    assert.deepEqual(req.tags, ['payout-retries', 'dead-letter']);
    assert.equal(req.status, 'active');
  });

  test('from a conversation: decided_by names the person', async () => {
    const res = await record({
      requirement: 'All money amounts are integers in minor units.',
      justification: 'Floats caused rounding drift in reconciliation.',
      tags: ['money-amounts'],
      decided_by: 'Sam (Remote Control, 2026-10-23)',
    });
    assert.equal(res.isError, false, res.text);
    assert.equal(res.value.requirement.group, null, 'product-wide');
    assert.equal(res.value.requirement.decidedBy, 'Sam (Remote Control, 2026-10-23)');
  });

  test('an agent must say whose decision it is', async () => {
    const res = await record({ requirement: 'Use Redis.', justification: 'I like it.', tags: ['caching'] });
    assert.equal(res.isError, true);
    assert.match(res.text, /whose decision/);
  });

  test('an unanswered escalation is not a source', async () => {
    const e = (await srv.tool(AGENT, 'create_escalation', { lane_id: 'pay-1', question: 'Open still?' })).value;
    const res = await record({ requirement: 'X.', justification: 'Y.', tags: ['open-source'], source_escalation: e.ref });
    assert.equal(res.isError, true);
    assert.match(res.text, /hasn't been decided/);
  });

  test('a person recording one is the decider', async () => {
    const res = await srv.call('POST', '/api/requirements', ALICE, {
      requirement: 'Search results never show archived products.',
      justification: 'Support tickets from confused customers.',
      tags: ['search-results'],
      group: 'search',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.requirement.decidedBy, 'alice');
  });

  test('broad, malformed or too many tags are rejected; unknown groups too', async () => {
    const base = { requirement: 'X.', justification: 'Y.', decided_by: 'Sam' };
    const broad = await record({ ...base, tags: ['backend'] });
    assert.equal(broad.isError, true);
    assert.match(broad.text, /too broad/);
    assert.equal((await record({ ...base, tags: ['two words'] })).isError, true);
    assert.equal((await record({ ...base, tags: ['a-b', 'c-d', 'e-f', 'g-h'] })).isError, true);
    assert.equal((await record({ ...base, tags: [] })).isError, true);
    const typo = await record({ ...base, tags: ['x-y'], group_id: 'paymnets' });
    assert.match(typo.text, /Group "paymnets" not found/);
    assert.equal((await srv.call('POST', '/api/requirements', AGENT, { ...base, decidedBy: 'Sam', tags: ['ui'] })).status, 400);
  });

  test('a near-duplicate comes back with the similar requirement', async () => {
    const res = await record({
      requirement: 'Payout jobs retry 5 times at most.',
      justification: 'Same as before.',
      tags: ['payout-retries'],
      group_id: 'payments',
      decided_by: 'Sam',
    });
    assert.ok(res.value.similar.some((r: any) => /retry at most 5 times/.test(r.requirement)));
  });
});

describe('finding requirements', () => {
  test('free-text search ranks matches, word forms included', async () => {
    const found = (await srv.tool(AGENT, 'find_requirements', { query: 'how many retries for payouts?' })).value;
    assert.ok(found.length >= 1);
    assert.match(found[0].requirement, /retry/);
  });

  test('a group search includes product-wide requirements but not other groups', async () => {
    const found = (await srv.tool(AGENT, 'find_requirements', { group_id: 'payments' })).value;
    const groups = new Set(found.map((r: any) => r.group));
    assert.ok(groups.has('payments') && groups.has(null));
    assert.ok(!groups.has('search'));
  });

  test('tag filter, tag list and lookup by id', async () => {
    const byTag = (await srv.call('GET', '/api/requirements?tag=money-amounts', ALICE)).body;
    assert.equal(byTag.length, 1);
    const tags = (await srv.tool(AGENT, 'list_requirement_tags', {})).value;
    assert.deepEqual(tags[0], { tag: 'payout-retries', count: 2 });
    const one = await srv.tool(AGENT, 'get_requirement', { id: byTag[0].id.toLowerCase() });
    assert.equal(one.value.id, byTag[0].id);
    assert.equal((await srv.call('GET', '/api/requirements/R9999', ALICE)).status, 404);
    assert.equal((await srv.call('GET', '/api/requirements?bogus=1', ALICE)).status, 400);
  });
});

describe('changing direction', () => {
  test('superseding keeps the old decision, marked, and links forward', async () => {
    const old = (await srv.call('GET', '/api/requirements?tag=money-amounts', ALICE)).body[0];
    const res = await srv.tool(AGENT, 'supersede_requirement', {
      id: old.id,
      requirement: 'All money amounts are integers in minor units, with the currency stored alongside.',
      justification: 'Multi-currency launch.',
      tags: ['money-amounts'],
      decided_by: 'Sam',
    });
    assert.equal(res.isError, false, res.text);
    const replacement = res.value.requirement;
    const before = (await srv.tool(AGENT, 'get_requirement', { id: old.id })).value;
    assert.equal(before.status, 'superseded');
    assert.equal(before.supersededBy, replacement.id);
    assert.equal(replacement.group, null, 'keeps the old scope');
    const active = (await srv.call('GET', '/api/requirements?tag=money-amounts', ALICE)).body;
    assert.deepEqual(active.map((r: any) => r.id), [replacement.id]);
    const all = (await srv.call('GET', '/api/requirements?tag=money-amounts&status=active,superseded', ALICE)).body;
    assert.equal(all.length, 2);
    const again = await srv.tool(AGENT, 'supersede_requirement', { id: old.id, requirement: 'Z.', justification: 'Z.', tags: ['z-z'], decided_by: 'Sam' });
    assert.match(again.text, /superseded; only active/);
  });

  test('people correct wording or retire; agents cannot', async () => {
    const r = (await srv.call('GET', '/api/requirements?tag=search-results', ALICE)).body[0];
    assert.equal((await srv.call('PATCH', `/api/requirements/${r.id}`, AGENT, { justification: 'x' })).status, 403);
    const edited = await srv.call('PATCH', `/api/requirements/${r.id}`, ALICE, { justification: 'Confused customers (support).' });
    assert.equal(edited.body.justification, 'Confused customers (support).');
    assert.equal((await srv.call('POST', `/api/requirements/${r.id}/retire`, AGENT)).status, 403);
    assert.equal((await srv.call('POST', `/api/requirements/${r.id}/retire`, ALICE)).body.status, 'retired');
    assert.equal((await srv.call('GET', '/api/requirements?tag=search-results', ALICE)).body.length, 0);
    // Edits stay searchable.
    const hit = (await srv.call('GET', '/api/requirements?q=support&status=retired', ALICE)).body;
    assert.deepEqual(hit.map((x: any) => x.id), [r.id]);
  });

  test('requirements are exported with the rest of the data', async () => {
    const rows = (await srv.call('GET', '/api/export/requirements.json', ALICE)).body;
    assert.ok(rows.length >= 4);
    assert.ok(rows.some((x: any) => x.status === 'superseded' && /^R\d+$/.test(x.superseded_by)));
    assert.ok(rows.every((x: any) => x.decided_by));
  });
});
