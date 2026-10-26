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
/** find_requirements for work not tied to a product (project-wide and global ones), as a list. */
const find = async (args: Record<string, unknown>) => {
  const r = await srv.tool(AGENT, 'find_requirements', { project_only: true, ...args });
  return { ...r, value: r.isError ? r.value : r.value.requirements };
};

describe('recording owner decisions', () => {
  test('from an answered escalation: the decider is recorded', async () => {
    const e = (await srv.tool(AGENT, 'create_escalation', { lane_id: 'pay-1', question: 'How many payout retries?' })).value;
    await srv.call('POST', `/api/escalations/${e.ref}/decide`, ALICE, { decision: '5, then dead-letter' });
    const res = await record({
      requirement: 'Payout jobs retry at most 5 times, then go to the dead-letter queue.',
      justification: 'Retries beyond 5 only delayed alerts in the March incident.',
      scope: 'project',
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
    assert.equal(req.scope, 'project');
    assert.equal(req.status, 'pending', 'an agent\'s record waits for approval');
  });

  test('from a conversation: decided_by names the person', async () => {
    const res = await record({
      requirement: 'All money amounts are integers in minor units.',
      justification: 'Floats caused rounding drift in reconciliation.',
      scope: 'project',
      decided_by: 'Sam (Remote Control, 2026-10-23)',
    });
    assert.equal(res.isError, false, res.text);
    assert.equal(res.value.requirement.scope, 'project');
    assert.equal(res.value.requirement.decidedBy, undefined, 'who decided comes with the justification, on request');
    const full = (await srv.tool(AGENT, 'get_requirement', { id: res.value.requirement.id, include_justification: true })).value;
    assert.equal(full.decidedBy, 'Sam (Remote Control, 2026-10-23)');
  });

  test('an agent must say whose decision it is', async () => {
    const res = await record({ requirement: 'Use Redis.', justification: 'I like it.', scope: 'project' });
    assert.equal(res.isError, true);
    assert.match(res.text, /whose decision/);
  });

  test('an unanswered escalation is not a source', async () => {
    const e = (await srv.tool(AGENT, 'create_escalation', { lane_id: 'pay-1', question: 'Open still?' })).value;
    const res = await record({ requirement: 'X.', justification: 'Y.', scope: 'project', source_escalation: e.ref });
    assert.equal(res.isError, true);
    assert.match(res.text, /hasn't been decided/);
  });

  test('a person recording one is the decider', async () => {
    const res = await srv.call('POST', '/api/requirements', ALICE, {
      requirement: 'Search results never show archived products.',
      justification: 'Support tickets from confused customers.',
      scope: 'project',
      group: 'search',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.requirement.decidedBy, 'alice');
    assert.equal(res.body.requirement.status, 'active', 'a person recording it approves it');
  });

  test('a scope is required; unknown groups are rejected', async () => {
    const base = { requirement: 'X.', justification: 'Y.', decided_by: 'Sam' };
    const unscoped = await record(base);
    assert.equal(unscoped.isError, true);
    assert.match(unscoped.text, /scope/);
    const typo = await record({ ...base, scope: 'project', group_id: 'paymnets' });
    assert.match(typo.text, /Group "paymnets" not found/);
    const rest = await srv.call('POST', '/api/requirements', AGENT, { requirement: 'X.', justification: 'Y.', decidedBy: 'Sam' });
    assert.equal(rest.status, 400);
    assert.match(rest.body.error, /Say where it applies/);
  });

  test('a near-duplicate comes back with the similar requirement', async () => {
    const res = await record({
      requirement: 'Payout jobs retry 5 times at most.',
      justification: 'Same as before.',
      scope: 'project',
      group_id: 'payments',
      decided_by: 'Sam',
    });
    assert.ok(res.value.similar.some((r: any) => /retry at most 5 times/.test(r.requirement)));
  });
});

describe('finding requirements', () => {
  test('free-text search ranks matches, word forms included', async () => {
    const found = (await find({ query: 'how many retries for payouts?' })).value;
    assert.ok(found.length >= 1);
    assert.match(found[0].requirement, /retry/);
  });

  test('a search says what it covers: products, or project_only', async () => {
    const neither = await srv.tool(AGENT, 'find_requirements', {});
    assert.equal(neither.isError, true);
    assert.match(neither.text, /products|project_only/);
    const res = await srv.tool(AGENT, 'find_requirements', { project_only: true });
    assert.deepEqual(res.value.scope, { project: 'default', projectOnly: true });
    assert.ok(res.value.requirements.every((r: any) => r.justification === undefined), 'no justification in searches');
  });

  test('lookup by id; justification only when asked', async () => {
    const money = (await srv.call('GET', '/api/requirements?q=money', ALICE)).body;
    assert.equal(money.length, 1);
    const one = await srv.tool(AGENT, 'get_requirement', { id: money[0].id.toLowerCase() });
    assert.equal(one.value.id, money[0].id);
    assert.equal(one.value.justification, undefined);
    assert.match((await srv.tool(AGENT, 'get_requirement', { id: money[0].id, include_justification: true })).value.justification, /rounding/);
    assert.equal((await srv.tool(AGENT, 'list_requirement_tags', {})).isError, true, 'tags are gone');
    assert.equal((await srv.call('GET', '/api/requirements/R9999', ALICE)).status, 404);
    assert.equal((await srv.call('GET', '/api/requirements?bogus=1', ALICE)).status, 400);
  });
});

describe('review fixes', () => {
  test('search matches prefixes as well as word forms; punctuation-only queries match nothing', async () => {
    await record({ requirement: 'Deployments happen on Tuesdays.', justification: 'Support coverage.', scope: 'project', decided_by: 'Sam' });
    for (const q of ['deploy', 'deployment', 'tuesday', 'pay', 'retries']) {
      const found = (await find({ query: q })).value;
      assert.ok(found.length > 0, q);
    }
    assert.deepEqual((await find({ query: '?!' })).value, []);
  });

  test('an agent cannot cite an unrelated answered escalation as the source', async () => {
    await srv.tool(REVIEWER, 'update_lane', { lane_id: 'theme', group: 'search' });
    const other = (await srv.tool(REVIEWER, 'create_escalation', { lane_id: 'theme', question: 'Dark mode colour?' })).value;
    await srv.call('POST', `/api/escalations/${other.ref}/decide`, ALICE, { decision: 'blue' });
    const laundered = await record({
      requirement: 'Payouts may skip KYC.',
      justification: 'Faster.',
      scope: 'project',
      group_id: 'payments',
      source_escalation: other.ref,
    });
    assert.equal(laundered.isError, true);
    assert.match(laundered.text, /raised by reviewer/);
    // The agent that raised it, or one in the same group, may cite it.
    const own = await srv.tool(REVIEWER, 'record_requirement', {
      requirement: 'Dark mode uses blue accents.',
      justification: 'Owner preference.',
      scope: 'project',
      group_id: 'search',
      source_escalation: other.ref,
    });
    assert.equal(own.isError, false, own.text);
    const sameGroup = await record({
      requirement: 'Dark mode accents are blue.',
      justification: 'Owner preference.',
      scope: 'project',
      group_id: 'search',
      source_escalation: other.ref,
    });
    assert.equal(sameGroup.isError, false, sameGroup.text);
  });

  test('bodies are strict and trimmed; one source only', async () => {
    const base = { requirement: 'X.', justification: 'Y.', scope: 'project', decidedBy: 'Sam' };
    assert.equal((await srv.call('POST', '/api/requirements', AGENT, { ...base, group_id: 'payments' })).status, 400);
    assert.equal((await srv.call('POST', '/api/requirements', AGENT, { ...base, requirement: '   ' })).status, 400);
    const both = await srv.call('POST', '/api/requirements', ALICE, { ...base, sourceEscalation: 'pay-1A' });
    assert.equal(both.status, 400);
    assert.match(both.body.error, /either source_escalation or decided_by/);
    const made = await srv.call('POST', '/api/requirements', AGENT, base);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const blank = await srv.call('PATCH', `/api/requirements/${made.body.requirement.id}`, ALICE, { requirement: '  ' });
    assert.equal(blank.status, 400);
    const mcp = await record({ requirement: 'X.', justification: 'Y.', scope: 'project', decided_by: 'Sam', source_escalation: 'pay-1A' });
    assert.match(mcp.text, /source_escalation or decided_by/);
  });
});

describe('changing direction', () => {
  test('superseding keeps the old decision, marked, and links forward', async () => {
    const old = (await srv.call('GET', '/api/requirements?q=money', ALICE)).body[0];
    const res = await srv.tool(AGENT, 'supersede_requirement', {
      id: old.id,
      requirement: 'All money amounts are integers in minor units, with the currency stored alongside.',
      justification: 'Multi-currency launch.',
      scope: 'project',
      decided_by: 'Sam',
    });
    assert.equal(res.isError, false, res.text);
    const replacement = res.value.requirement;
    await srv.call('POST', `/api/requirements/${replacement.id}/approve`, ALICE);
    const before = (await srv.tool(AGENT, 'get_requirement', { id: old.id })).value;
    assert.equal(before.status, 'superseded');
    assert.equal(before.supersededBy, replacement.id);
    assert.equal(replacement.group, undefined, 'keeps the old scope (no group)');
    const active = (await srv.call('GET', '/api/requirements?q=money', ALICE)).body;
    assert.deepEqual(active.map((r: any) => r.id), [replacement.id]);
    const all = (await srv.call('GET', '/api/requirements?q=money&status=active,superseded', ALICE)).body;
    assert.equal(all.length, 2);
    const again = await srv.tool(AGENT, 'supersede_requirement', { id: old.id, requirement: 'Z.', justification: 'Z.', scope: 'project', decided_by: 'Sam' });
    assert.match(again.text, /superseded; only pending or active/);
  });

  test('pending records show in searches until a person approves them', async () => {
    const res = await record({
      requirement: 'Refunds are issued to the original payment method only.',
      justification: 'Fraud review, Q3.',
      scope: 'project',
      decided_by: 'Sam',
    });
    const id = res.value.requirement.id;
    assert.equal(res.value.requirement.status, 'pending');
    // Searches return it, marked pending, to agents and people alike.
    const found = (await find({ query: 'refunds' })).value;
    assert.deepEqual(found.map((x: any) => [x.id, x.status]), [[id, 'pending']]);
    assert.equal((await srv.call('GET', '/api/requirements?q=refunds', ALICE)).body[0].status, 'pending');
    assert.deepEqual((await srv.call('GET', '/api/requirements?q=refunds&status=active', ALICE)).body, []);
    // Only people approve.
    assert.equal((await srv.call('POST', `/api/requirements/${id}/approve`, AGENT)).status, 403);
    const approved = await srv.call('POST', `/api/requirements/${id}/approve`, ALICE);
    assert.equal(approved.body.status, 'active');
    assert.equal((await srv.tool(AGENT, 'get_requirement', { id })).value.status, 'active');
    assert.equal((await srv.call('POST', `/api/requirements/${id}/approve`, ALICE)).status, 409);
    // A pending record is rejected with a reason, not retired; restoring it puts it back up for approval.
    const other = (await record({ requirement: 'Refunds over $500 need a second approver.', justification: 'Fraud.', scope: 'project', decided_by: 'Sam' })).value.requirement.id;
    assert.equal((await srv.call('POST', `/api/requirements/${other}/retire`, ALICE)).status, 409, 'pending ones are rejected, not retired');
    assert.equal((await srv.call('POST', `/api/requirements/${other}/reject`, ALICE, {})).status, 400, 'a reason is required');
    assert.equal((await srv.call('POST', `/api/requirements/${other}/reject`, ALICE, { reason: '   ' })).status, 400);
    assert.equal((await srv.call('POST', `/api/requirements/${other}/reject`, AGENT, { reason: 'No.' })).status, 403);
    const rejected = (await srv.call('POST', `/api/requirements/${other}/reject`, ALICE, { reason: 'Sam never said $500.' })).body;
    assert.deepEqual([rejected.status, rejected.rejectionReason], ['rejected', 'Sam never said $500.']);
    assert.equal((await srv.call('POST', `/api/requirements/${other}/approve`, ALICE)).status, 409);
    assert.equal((await srv.call('POST', `/api/requirements/${other}/reject`, ALICE, { reason: 'Again.' })).status, 409);
    const restored = (await srv.call('POST', `/api/requirements/${other}/restore`, ALICE)).body;
    assert.deepEqual([restored.status, restored.rejectionReason], ['pending', null]);
    assert.equal((await srv.call('POST', `/api/requirements/${other}/approve`, ALICE)).body.status, 'active');
  });

  test('rejected requirements are hidden from agents and default searches', async () => {
    const id = (await record({ requirement: 'Invoices are emailed as PDFs only.', justification: 'Accounting.', scope: 'project', decided_by: 'Sam' })).value.requirement.id;
    await srv.call('POST', `/api/requirements/${id}/reject`, ALICE, { reason: 'Misheard: HTML too.' });
    // Default searches skip them, for people and agents alike.
    assert.deepEqual((await srv.call('GET', '/api/requirements?q=invoices', ALICE)).body, []);
    assert.deepEqual((await find({ query: 'invoices' })).value, []);
    assert.deepEqual((await find({ query: id })).value, [], 'not even by id');
    assert.deepEqual((await find({ query: 'invoices PDFs', statuses: ['pending', 'active', 'superseded', 'retired'] })).value, []);
    assert.equal((await find({ query: 'invoices', statuses: ['rejected'] })).isError, true, 'agents cannot ask for them');
    assert.match((await srv.tool(AGENT, 'get_requirement', { id })).text, /not found/);
    assert.equal((await srv.tool(AGENT, 'supersede_requirement', { id, requirement: 'Invoices are HTML.', justification: 'x', scope: 'project', decided_by: 'Sam' })).isError, true);
    assert.equal((await srv.call('GET', `/api/requirements/${id}`, AGENT)).status, 404);
    assert.deepEqual((await srv.call('GET', '/api/requirements?q=invoices&status=rejected', AGENT)).body, []);
    assert.deepEqual((await srv.call('GET', `/api/requirements?q=${id}`, ALICE)).body, [], 'by id too, unless asked for');
    // People asking for them get them, with the reason.
    const shown = (await srv.call('GET', '/api/requirements?q=invoices&status=rejected', ALICE)).body;
    assert.deepEqual(shown.map((x: any) => [x.id, x.rejectionReason]), [[id, 'Misheard: HTML too.']]);
    assert.equal((await srv.call('GET', `/api/requirements/${id}`, ALICE)).body.status, 'rejected');
    // The same decision can be recorded again; the rejected one doesn't count as a duplicate.
    const again = await record({ requirement: 'Invoices are emailed as PDFs only.', justification: 'Accounting.', scope: 'project', decided_by: 'Sam' });
    assert.equal(again.value.duplicate, undefined);
    assert.notEqual(again.value.requirement.id, id);
    assert.ok(!(again.value.similar ?? []).some((x: any) => x.id === id), 'rejected ones are never offered as similar');
  });

  test('exports leave rejected requirements out for agents', async () => {
    const id = (await record({ requirement: 'Receipts keep the store logo.', justification: 'Brand.', scope: 'project', decided_by: 'Sam' })).value.requirement.id;
    await srv.call('POST', `/api/requirements/${id}/reject`, ALICE, { reason: 'TOPSECRET reason' });
    const agent = await srv.call('GET', '/api/export/requirements.json', AGENT);
    assert.ok(!agent.body.some((x: any) => x.id === id || x.rejection_reason === 'TOPSECRET reason'));
    const person = await srv.call('GET', '/api/export/requirements.json', ALICE);
    assert.ok(person.body.some((x: any) => x.id === id && x.rejection_reason === 'TOPSECRET reason'));
  });

  test('a rejected replacement leaves nothing pointing at it, and restoring it links it again', async () => {
    const base = { justification: 'Ops.', scope: 'project', decided_by: 'Sam' };
    const get = async (id: string) => (await srv.call('GET', `/api/requirements/${id}`, ALICE)).body;
    const a = (await srv.call('POST', '/api/requirements', ALICE, { requirement: 'Purges run monthly.', justification: 'Ops.', scope: 'project' })).body.requirement;
    const p = (await srv.tool(AGENT, 'supersede_requirement', { id: a.id, requirement: 'Purges run weekly.', ...base })).value.requirement;
    const p2 = (await srv.tool(AGENT, 'supersede_requirement', { id: p.id, requirement: 'Purges run daily.', ...base })).value.requirement;
    await srv.call('POST', `/api/requirements/${p2.id}/reject`, ALICE, { reason: 'Too often.' });
    assert.deepEqual([(await get(a.id)).status, (await get(a.id)).supersededBy], ['active', null]);
    assert.deepEqual([(await get(p.id)).status, (await get(p.id)).supersededBy], ['superseded', null], 'the swapped proposal no longer names it');
    const seen = (await find({ statuses: ['active', 'superseded'] })).value;
    assert.ok(!JSON.stringify(seen).includes(`"${p2.id}"`));
    // Restored: the pending replacement again, so approving it supersedes the old decision.
    assert.equal((await srv.call('POST', `/api/requirements/${p2.id}/restore`, ALICE)).body.status, 'pending');
    assert.equal((await get(a.id)).supersededBy, p2.id);
    await srv.call('POST', `/api/requirements/${p2.id}/approve`, ALICE);
    assert.deepEqual([(await get(a.id)).status, (await get(a.id)).supersededBy], ['superseded', p2.id]);
  });

  test('a personal key cannot reject, and never sees a rejected requirement', async () => {
    await srv.call('POST', '/api/admin/people', ALICE, { email: 'rae@example.com', name: 'Rae', password: 'correct horse battery' });
    const signIn = await fetch(`${srv.base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: srv.base },
      body: JSON.stringify({ email: 'rae@example.com', password: 'correct horse battery' }),
    });
    const personal = (await srv.call('POST', '/api/auth/api-key/create', signIn.headers.get('set-auth-token')!, { name: 'rae-claude', metadata: { role: 'human' } })).body.key;
    const id = (await record({ requirement: 'Statements close on the 1st.', justification: 'Finance.', scope: 'project', decided_by: 'Sam' })).value.requirement.id;
    assert.equal((await srv.call('POST', `/api/requirements/${id}/reject`, personal, { reason: 'No.' })).status, 403);
    assert.equal((await srv.call('GET', `/api/requirements/${id}`, ALICE)).body.status, 'pending');
    await srv.call('POST', `/api/requirements/${id}/reject`, ALICE, { reason: 'PK-SECRET' });
    assert.equal((await srv.call('GET', `/api/requirements/${id}`, personal)).status, 404);
    assert.deepEqual((await srv.call('GET', '/api/requirements?q=statements&status=rejected', personal)).body, []);
    assert.equal((await srv.call('POST', `/api/requirements/${id}/restore`, personal)).status, 404);
    const exported = await srv.tool(personal, 'export_data', { dataset: 'requirements', format: 'json' });
    assert.equal(exported.isError, false, exported.text);
    assert.ok(!exported.text.includes('PK-SECRET'));
  });

  test('agents on the event stream learn a rejected requirement is gone, without its reason', async () => {
    const id = (await record({ requirement: 'Coupons stack at most twice.', justification: 'Margins.', scope: 'project', decided_by: 'Sam' })).value.requirement.id;
    const read = async (token: string) => {
      const ctrl = new AbortController();
      const res = await fetch(`${srv.base}/api/events`, { headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal });
      const reader = res.body!.getReader();
      let text = '';
      return {
        async until(needle: string) {
          const decoder = new TextDecoder();
          while (!text.includes(needle)) text += decoder.decode((await reader.read()).value);
          ctrl.abort();
          return text;
        },
      };
    };
    const agent = await read(AGENT);
    const person = await read(ALICE);
    await new Promise((r) => setTimeout(r, 100));
    await srv.call('POST', `/api/requirements/${id}/reject`, ALICE, { reason: 'STREAM-SECRET' });
    const seen = await agent.until('requirement_removed');
    assert.match(seen, new RegExp(`"id":"${id}"`));
    assert.ok(!seen.includes('STREAM-SECRET'));
    assert.match(await person.until('STREAM-SECRET'), /"status":"rejected"/);
  });

  test('a requirement with a change waiting is not withdrawn until the change is decided', async () => {
    const base = { justification: 'Ops.', scope: 'project', decided_by: 'Sam' };
    const get = async (id: string) => (await srv.call('GET', `/api/requirements/${id}`, ALICE)).body;
    // A pending record with its own pending change: reject the change first.
    const r3 = (await record({ requirement: 'Cache entries live 1 hour.', ...base })).value.requirement;
    const r4 = (await srv.tool(AGENT, 'supersede_requirement', { id: r3.id, requirement: 'Cache entries live 2 hours.', ...base })).value.requirement;
    const refused = await srv.call('POST', `/api/requirements/${r3.id}/reject`, ALICE, { reason: 'Never decided.' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, new RegExp(r4.id));
    await srv.call('POST', `/api/requirements/${r4.id}/reject`, ALICE, { reason: 'No.' });
    assert.equal((await srv.call('POST', `/api/requirements/${r3.id}/reject`, ALICE, { reason: 'Never decided.' })).body.status, 'rejected');
    assert.equal((await get(r3.id)).supersededBy, null);
    // Restoring R3 brings back a lone pending record; R4 stays rejected. Restoring R4 then makes it R3's change again.
    await srv.call('POST', `/api/requirements/${r3.id}/restore`, ALICE);
    assert.deepEqual([(await get(r3.id)).status, (await get(r3.id)).supersededBy], ['pending', null]);
    assert.equal((await get(r4.id)).status, 'rejected');
    await srv.call('POST', `/api/requirements/${r4.id}/restore`, ALICE);
    assert.deepEqual([(await get(r3.id)).supersededBy, (await get(r4.id)).status], [r4.id, 'pending']);
    // An active one with a pending change isn't retired out from under it either.
    const a = (await srv.call('POST', '/api/requirements', ALICE, { requirement: 'Cache is per region.', justification: 'Ops.', scope: 'project' })).body.requirement;
    const b = (await srv.tool(AGENT, 'supersede_requirement', { id: a.id, requirement: 'Cache is global.', ...base })).value.requirement;
    assert.equal((await srv.call('POST', `/api/requirements/${a.id}/retire`, ALICE)).status, 409);
    await srv.call('POST', `/api/requirements/${b.id}/approve`, ALICE);
    assert.deepEqual([(await get(a.id)).status, (await get(b.id)).status], ['superseded', 'active']);
  });

  test('restoring a rejected swap links back the proposal it was swapped in for', async () => {
    const base = { justification: 'Ops.', scope: 'project', decided_by: 'Sam' };
    const get = async (id: string) => (await srv.call('GET', `/api/requirements/${id}`, ALICE)).body;
    const r5 = (await srv.call('POST', '/api/requirements', ALICE, { requirement: 'Logs are kept 30 days.', justification: 'Ops.', scope: 'project' })).body.requirement;
    const r6 = (await srv.tool(AGENT, 'supersede_requirement', { id: r5.id, requirement: 'Logs are kept 60 days.', ...base })).value.requirement;
    const r7 = (await srv.tool(AGENT, 'supersede_requirement', { id: r6.id, requirement: 'Logs are kept 90 days.', ...base })).value.requirement;
    await srv.call('POST', `/api/requirements/${r7.id}/reject`, ALICE, { reason: 'Too long.' });
    assert.equal((await get(r6.id)).supersededBy, null);
    await srv.call('POST', `/api/requirements/${r7.id}/restore`, ALICE);
    assert.deepEqual([(await get(r5.id)).status, (await get(r5.id)).supersededBy], ['active', r7.id]);
    assert.deepEqual([(await get(r6.id)).status, (await get(r6.id)).supersededBy], ['superseded', r7.id]);
  });

  test('restoring a rejected replacement is refused once what it replaced has moved on', async () => {
    const base = { justification: 'Ops.', scope: 'project', decided_by: 'Sam' };
    const a = (await srv.call('POST', '/api/requirements', ALICE, { requirement: 'Archives run monthly.', justification: 'Ops.', scope: 'project' })).body.requirement;
    const p = (await srv.tool(AGENT, 'supersede_requirement', { id: a.id, requirement: 'Archives run weekly.', ...base })).value.requirement;
    await srv.call('POST', `/api/requirements/${p.id}/reject`, ALICE, { reason: 'No.' });
    await srv.tool(AGENT, 'supersede_requirement', { id: a.id, requirement: 'Archives run yearly.', ...base });
    const res = await srv.call('POST', `/api/requirements/${p.id}/restore`, ALICE);
    assert.equal(res.status, 409);
    assert.equal((await srv.call('GET', `/api/requirements/${p.id}`, ALICE)).body.status, 'rejected');
  });

  test('an agent\'s replacement leaves the old decision in force until it is approved', async () => {
    const base = { justification: 'Ops review.', scope: 'project', decided_by: 'Sam' };
    const old = (await srv.call('POST', '/api/requirements', ALICE, { requirement: 'Exports run nightly.', justification: 'Ops.', scope: 'project' })).body.requirement;
    assert.equal(old.status, 'active');
    const first = (await srv.tool(AGENT, 'supersede_requirement', { id: old.id, requirement: 'Exports run hourly.', ...base })).value.requirement;
    assert.equal(first.status, 'pending');
    let now = (await srv.call('GET', `/api/requirements/${old.id}`, ALICE)).body;
    assert.deepEqual([now.status, now.supersededBy], ['active', first.id], 'still in force, replacement named');
    // Whichever of the two a search finds, agents get both: the decision in force, then the pending change.
    const ids = (r: { value: { id: string }[] }) => r.value.map((x) => x.id);
    assert.deepEqual(ids(await find({ query: 'nightly' })), [old.id, first.id]);
    assert.deepEqual(ids(await find({ query: 'hourly' })), [old.id, first.id]);
    assert.deepEqual(ids(await find({ query: first.id })), [old.id, first.id]);
    assert.deepEqual(ids(await find({ query: old.id })), [old.id, first.id]);
    const listed = (await srv.call('GET', '/api/requirements?q=exports&status=active', ALICE)).body;
    assert.deepEqual(listed.map((x: any) => [x.id, x.status]), [[old.id, 'active'], [first.id, 'pending']]);
    const twice = await srv.tool(AGENT, 'supersede_requirement', { id: old.id, requirement: 'Exports run weekly.', ...base });
    assert.match(twice.text, /already has a replacement waiting/);
    // Rejected: the old one is clear again and can be replaced afresh.
    await srv.call('POST', `/api/requirements/${first.id}/reject`, ALICE, { reason: 'Hourly is too often.' });
    now = (await srv.call('GET', `/api/requirements/${old.id}`, ALICE)).body;
    assert.deepEqual([now.status, now.supersededBy], ['active', null]);
    const second = (await srv.tool(AGENT, 'supersede_requirement', { id: old.id, requirement: 'Exports run every 6 hours.', ...base })).value.requirement;
    // Approved: now the old one is superseded.
    await srv.call('POST', `/api/requirements/${second.id}/approve`, ALICE);
    now = (await srv.call('GET', `/api/requirements/${old.id}`, ALICE)).body;
    assert.deepEqual([now.status, now.supersededBy], ['superseded', second.id]);
  });

  test('superseding a pending change swaps the proposal instead of chaining', async () => {
    const base = { justification: 'Ops.', scope: 'project', decided_by: 'Sam' };
    const a = (await srv.call('POST', '/api/requirements', ALICE, { requirement: 'Backups run at 02:00.', justification: 'Ops.', scope: 'project' })).body.requirement;
    const b = (await srv.tool(AGENT, 'supersede_requirement', { id: a.id, requirement: 'Backups run at 03:00.', ...base })).value.requirement;
    const c = (await srv.tool(AGENT, 'supersede_requirement', { id: b.id, requirement: 'Backups run at 04:00.', ...base })).value.requirement;
    const get = async (id: string) => (await srv.call('GET', `/api/requirements/${id}`, ALICE)).body;
    assert.deepEqual([(await get(a.id)).status, (await get(a.id)).supersededBy], ['active', c.id], 'the decision in force waits on the newest proposal');
    assert.deepEqual([(await get(b.id)).status, (await get(b.id)).supersededBy], ['superseded', c.id]);
    for (const query of ['02', '04', a.id, c.id]) {
      const found = (await find({ query })).value.map((x: any) => x.id);
      assert.deepEqual(found, [a.id, c.id], query);
    }
    await srv.call('POST', `/api/requirements/${c.id}/approve`, ALICE);
    assert.deepEqual([(await get(a.id)).status, (await get(a.id)).supersededBy], ['superseded', c.id]);
    assert.deepEqual((await find({ query: 'backups' })).value.map((x: any) => x.id), [c.id]);
  });

  test('people correct wording or retire; agents cannot', async () => {
    const r = (await srv.call('GET', '/api/requirements?q=results', ALICE)).body[0];
    assert.equal((await srv.call('PATCH', `/api/requirements/${r.id}`, AGENT, { justification: 'x' })).status, 403);
    const edited = await srv.call('PATCH', `/api/requirements/${r.id}`, ALICE, { justification: 'Confused customers (support).' });
    assert.equal(edited.body.justification, 'Confused customers (support).');
    assert.equal((await srv.call('POST', `/api/requirements/${r.id}/retire`, AGENT)).status, 403);
    assert.equal((await srv.call('POST', `/api/requirements/${r.id}/retire`, ALICE)).body.status, 'retired');
    assert.equal((await srv.call('PATCH', `/api/requirements/${r.id}`, ALICE, { justification: 'z' })).status, 409, 'retired ones are history');
    assert.equal((await srv.call('GET', '/api/requirements?q=results', ALICE)).body.length, 0);
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
