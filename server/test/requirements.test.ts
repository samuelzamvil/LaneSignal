// Product requirements: owner decisions that agents record and find later.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { AGENT, ALICE, REVIEWER, startServer } from './helpers.ts';

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  srv = await startServer();
  await srv.tool(AGENT, 'update_group', { group_id: 'payments', name: 'Payments train' });
  await srv.tool(AGENT, 'update_group', { group_id: 'search', name: 'Search train' });
  await srv.publish('pay-1');
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
    assert.match(res.value.requirement.id, /^R\d+$/);
    // Agents get it back without bookkeeping; the API has everything.
    assert.equal(res.value.requirement.recordedBy, undefined);
    const req = (await srv.call('GET', `/api/requirements/${res.value.requirement.id}`, ALICE)).body;
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
    assert.equal(res.value.requirement.group, undefined, 'product-wide');
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
    const groups = new Set(found.map((r: any) => r.group ?? null));
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

describe('review fixes', () => {
  test('search matches prefixes as well as word forms; punctuation-only queries match nothing', async () => {
    await record({ requirement: 'Deployments happen on Tuesdays.', justification: 'Support coverage.', tags: ['deploy-schedule'], decided_by: 'Sam' });
    for (const q of ['deploy', 'deployment', 'tuesday', 'pay', 'retries']) {
      const found = (await srv.tool(AGENT, 'find_requirements', { query: q })).value;
      assert.ok(found.length > 0, q);
    }
    assert.deepEqual((await srv.tool(AGENT, 'find_requirements', { query: '?!' })).value, []);
  });

  test('an agent cannot cite an unrelated answered escalation as the source', async () => {
    await srv.tool(REVIEWER, 'update_lane', { lane_id: 'theme', group: 'search' });
    const other = (await srv.tool(REVIEWER, 'create_escalation', { lane_id: 'theme', question: 'Dark mode colour?' })).value;
    await srv.call('POST', `/api/escalations/${other.ref}/decide`, ALICE, { decision: 'blue' });
    const laundered = await record({
      requirement: 'Payouts may skip KYC.',
      justification: 'Faster.',
      tags: ['kyc-checks'],
      group_id: 'payments',
      source_escalation: other.ref,
    });
    assert.equal(laundered.isError, true);
    assert.match(laundered.text, /raised by reviewer/);
    // The agent that raised it, or one in the same group, may cite it.
    const own = await srv.tool(REVIEWER, 'record_requirement', {
      requirement: 'Dark mode uses blue accents.',
      justification: 'Owner preference.',
      tags: ['dark-mode'],
      group_id: 'search',
      source_escalation: other.ref,
    });
    assert.equal(own.isError, false, own.text);
    const sameGroup = await record({
      requirement: 'Dark mode accents are blue.',
      justification: 'Owner preference.',
      tags: ['dark-mode'],
      group_id: 'search',
      source_escalation: other.ref,
    });
    assert.equal(sameGroup.isError, false, sameGroup.text);
  });

  test('bodies are strict and trimmed; one source only; tags dedupe before the limit', async () => {
    const base = { requirement: 'X.', justification: 'Y.', tags: ['x-y'], decidedBy: 'Sam' };
    assert.equal((await srv.call('POST', '/api/requirements', AGENT, { ...base, group_id: 'payments' })).status, 400);
    assert.equal((await srv.call('POST', '/api/requirements', AGENT, { ...base, requirement: '   ' })).status, 400);
    const both = await srv.call('POST', '/api/requirements', ALICE, { ...base, sourceEscalation: 'A1' });
    assert.equal(both.status, 400);
    assert.match(both.body.error, /either source_escalation or decided_by/);
    const dedup = await srv.call('POST', '/api/requirements', AGENT, { ...base, tags: ['A-B', 'a-b', 'c-d', 'e-f'] });
    assert.equal(dedup.status, 201, JSON.stringify(dedup.body));
    assert.deepEqual(dedup.body.requirement.tags, ['a-b', 'c-d', 'e-f']);
    const blank = await srv.call('PATCH', `/api/requirements/${dedup.body.requirement.id}`, ALICE, { requirement: '  ' });
    assert.equal(blank.status, 400);
    const mcp = await record({ requirement: 'X.', justification: 'Y.', tags: ['x-y'], decided_by: 'Sam', source_escalation: 'A1' });
    assert.match(mcp.text, /source_escalation or decided_by/);
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
    assert.equal(replacement.group, undefined, 'keeps the old scope (no group)');
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
    assert.equal((await srv.call('PATCH', `/api/requirements/${r.id}`, ALICE, { justification: 'z' })).status, 409, 'retired ones are history');
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
