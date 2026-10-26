// Alerts only (LANESIGNAL_DECISIONS=false): the owner answers in the agent's own session, and the
// agent dismisses the alert with a justification. Nothing is answered or waited on in LaneSignal.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { AGENT, ALICE, REVIEWER, startServer } from './helpers.ts';

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  srv = await startServer({ LANESIGNAL_DECISIONS: 'false' });
  await srv.publish('drop-col', { group: 'payments' });
});
after(() => srv.close());

const alert = async (question: string, extra: Record<string, unknown> = {}) =>
  (await srv.tool(AGENT, 'create_escalation', { lane_id: 'drop-col', question, ...extra })).value;
const lane = async () => (await srv.call('GET', '/api/lanes/drop-col', ALICE)).body.lane;

describe('alerts', () => {
  test('the server says answering in LaneSignal is off', async () => {
    const config = (await srv.call('GET', '/api/config', ALICE)).body;
    assert.equal(config.decisions, false);
    assert.equal(config.requirements, true);
  });

  test('an alert blocks the lane; dismissing it with a justification unblocks it', async () => {
    const a = await alert('Drop legacy_role?');
    // The lane's ticket ("drop-col", no usable code of its own: T<n>) and a letter.
    assert.match(a.ref, /^T\d+A$/);
    assert.equal((await lane()).status, 'blocked_human');
    const bare = await srv.tool(AGENT, 'dismiss_escalation', { id: a.ref });
    assert.equal(bare.isError, true, 'a justification is required');
    const done = await srv.tool(AGENT, 'dismiss_escalation', {
      id: a.ref,
      justification: 'Sam: drop it (in session)',
      activity: 'Dropping legacy_role',
    });
    assert.equal(done.isError, false, done.text);
    assert.equal(done.value.state, 'withdrawn');
    assert.equal(done.value.resolution, 'Sam: drop it (in session)');
    const after = await lane();
    assert.equal(after.status, 'active');
    assert.equal(after.activity, 'Dropping legacy_role');
  });

  test('over HTTP an agent must say why; a person may dismiss a stale alert', async () => {
    const a = await alert('Rename the table?');
    assert.equal((await srv.call('POST', `/api/escalations/${a.id}/withdraw`, AGENT, {})).status, 400);
    const byOwner = await srv.call('POST', `/api/escalations/${a.id}/withdraw`, ALICE, { note: 'session ended' });
    assert.equal(byOwner.status, 200);
    assert.equal(byOwner.body.state, 'withdrawn');
  });

  test("only the agent that raised an alert dismisses it", async () => {
    const a = await alert('Mine?');
    const other = await srv.tool(REVIEWER, 'dismiss_escalation', { id: a.ref, justification: 'not mine' });
    assert.equal(other.isError, true);
    assert.match(other.text, /only that agent, the overseer of the group its \w+ is in, or a person can dismiss it/);
    await srv.tool(AGENT, 'dismiss_escalation', { id: a.ref, justification: 'moot' });
  });

  test('nothing is answered or waited on in LaneSignal', async () => {
    const a = await alert('Answer here?');
    assert.equal((await srv.call('POST', `/api/escalations/${a.id}/decide`, ALICE, { decision: 'yes' })).status, 404);
    assert.equal((await srv.call('POST', `/api/escalations/${a.id}/ack`, AGENT, {})).status, 404);
    assert.equal((await srv.call('GET', '/api/wait?format=full&group=payments&timeout=0', AGENT)).status, 404);
    const humanTools = await fetch(`${srv.base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ALICE}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }).then((r) => r.text());
    assert.ok(!humanTools.includes('decide_escalation'));
    await srv.tool(AGENT, 'dismiss_escalation', { id: a.ref, justification: 'moot' });
  });

  test('a requirement can cite the alert, naming who decided in the session', async () => {
    const a = await alert('Retry payouts how often?');
    await srv.tool(AGENT, 'dismiss_escalation', { id: a.ref, justification: 'Sam: 5 times (in session)' });
    const res = await srv.tool(AGENT, 'record_requirement', {
      requirement: 'Payouts retry at most 5 times.',
      justification: 'Sam, in the overseer session.',
      scope: 'project',
      source_escalation: a.ref,
      decided_by: 'Sam (in session)',
    });
    assert.equal(res.isError, false, res.text);
    // Who decided and where come with the justification, on request.
    const full = (await srv.tool(AGENT, 'get_requirement', { id: res.value.requirement.id, include_justification: true })).value;
    assert.equal(full.sourceEscalation, a.ref);
    assert.equal(full.decidedBy, 'Sam (in session)');
    const without = await srv.tool(AGENT, 'record_requirement', {
      requirement: 'Payouts alert on-call.',
      justification: 'x',
      scope: 'project',
      source_escalation: a.ref,
    });
    assert.match(without.text, /say who decided with decided_by/);
  });

  test('requirements are kept short', async () => {
    const res = await srv.tool(AGENT, 'record_requirement', {
      requirement: 'x'.repeat(301),
      justification: 'y',
      scope: 'project',
      decided_by: 'Sam',
    });
    assert.equal(res.isError, true);
    assert.match(res.text, /requirement/);
  });

  test("overseers whose keys one person created can't dismiss each other's alerts; a rotated key can", async () => {
    await srv.call('POST', '/api/admin/people', ALICE, { email: 'owner@example.com', name: 'Owner', password: 'correct horse battery' });
    const signIn = await fetch(`${srv.base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: srv.base },
      body: JSON.stringify({ email: 'owner@example.com', password: 'correct horse battery' }),
    });
    const session = signIn.headers.get('set-auth-token')!;
    const key = async (name: string) =>
      (await srv.call('POST', '/api/auth/api-key/create', session, { name, metadata: { role: 'agent' } })).body.key as string;
    const payments = await key('payments-overseer');
    const search = await key('search-overseer');
    await srv.publish('owned', { token: payments });
    const a = (await srv.tool(payments, 'create_escalation', { lane_id: 'owned', question: 'Whose?' })).value;
    const other = await srv.tool(search, 'dismiss_escalation', { id: a.ref, justification: 'not mine' });
    assert.equal(other.isError, true);
    assert.match(other.text, /raised by payments-overseer/);
    const rotated = await key('payments-overseer');
    const mine = await srv.tool(rotated, 'dismiss_escalation', { id: a.ref, justification: 'Sam: yes (in session)' });
    assert.equal(mine.isError, false, mine.text);
  });

  test("a person dismissing a stale alert leaves the lane waiting on its agent, not working", async () => {
    await alert('Stale?');
    const open = (await srv.call('GET', '/api/escalations?lane=drop-col', ALICE)).body.find((e: any) => e.question === 'Stale?');
    assert.equal((await srv.call('POST', `/api/escalations/${open.id}/withdraw`, ALICE, { note: 'session ended' })).status, 200);
    assert.equal((await lane()).status, 'awaiting_agent');
  });
});
