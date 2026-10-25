import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { createAccounts } from '../src/accounts.ts';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { ticketRefs, ticketResolver } from '../src/tickets.ts';

const AGENT = 'agent-token-0123456789';
const ALICE = 'alice-token-0123456789';
const BOB = 'bob-token-0123456789ab';

let base = '';
let store: Store;
let close: () => void;

before(async () => {
  const config = loadConfig({
    LANESIGNAL_DATA_DIR: '/nonexistent-unused',
    LANESIGNAL_CONFIG: '/nonexistent.json',
    LANESIGNAL_AGENT_TOKENS: `bot:${AGENT}`,
    LANESIGNAL_HUMAN_TOKENS: `alice:${ALICE}`,
    // legacy name of the human-token variable
    LANESIGNAL_OVERSEER_TOKENS: `bob:${BOB}`,
    LANESIGNAL_AUTH_SECRET: 'test-secret-0123456789-0123456789-0123',
    LANESIGNAL_TICKET_TEMPLATES: 'redmine=https://redmine.example/issues/{id},gh=https://github.com/o/r/issues/{id}',
  });
  store = new Store({
    path: ':memory:',
    resolveTicketUrl: ticketResolver(config.ticketTemplates, config.defaultTicketSystem),
    ticketRefs: ticketRefs(config.ticketTemplates, config.defaultTicketSystem),
  });
  const accounts = await createAccounts(config, ':memory:');
  const app = createApp({ config, store, accounts, push: { fcm: false, ntfy: false } });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => {
    server.closeAllConnections();
    server.close();
  };
});

after(() => close());

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('auth', () => {
  test('rejects missing and bad tokens', async () => {
    assert.equal((await call('GET', '/api/lanes', null)).status, 401);
    assert.equal((await call('GET', '/api/lanes', 'nope-nope-nope-nope')).status, 401);
  });

  test('enforces roles', async () => {
    assert.equal((await call('PUT', '/api/lanes/x', ALICE, { status: 'active' })).status, 403);
    assert.deepEqual((await call('GET', '/api/me', ALICE)).body, { name: 'alice', role: 'human', admin: true });
    assert.deepEqual((await call('GET', '/api/me', BOB)).body, { name: 'bob', role: 'human', admin: true });
  });

  test('first-run setup trusts a static human token instead of the setup code', async () => {
    const input = { email: 'ops@example.com', name: 'Ops', password: 'correct horse battery' };
    assert.equal((await call('POST', '/api/setup', null, input)).status, 403);
    assert.equal((await call('POST', '/api/setup', AGENT, input)).status, 403);
    assert.equal((await call('POST', '/api/setup', ALICE, input)).status, 201);
  });

  test('static human tokens can add people and reset passwords (break-glass)', async () => {
    const add = await call('POST', '/api/admin/people', ALICE, {
      email: 'new@example.com',
      name: 'New',
      password: 'temporary password',
    });
    assert.equal(add.status, 201);
    assert.equal(
      (await call('POST', '/api/admin/people/password', ALICE, { email: 'new@example.com', password: 'another password' })).status,
      204,
    );
    assert.equal((await call('POST', '/api/admin/people', AGENT, { email: 'x@example.com', name: 'X', password: 'temporary password' })).status, 403);
  });

  test('health check is public', async () => {
    assert.deepEqual((await call('GET', '/healthz', null)).body, { ok: true });
  });
});

describe('lanes', () => {
  test('upsert creates, then patches, resolving ticket urls', async () => {
    const typo = await call('PUT', '/api/lanes/epic-1', AGENT, { group: 'payments-epc' });
    assert.equal(typo.status, 404, 'a mistyped group is an error, not a new group');
    assert.match(typo.body.error, /Group "payments-epc" not found/);
    assert.equal((await call('PUT', '/api/groups/payments-epic', AGENT, {})).status, 200);
    const created = await call('PUT', '/api/lanes/epic-1', AGENT, {
      name: 'Epic 1',
      group: 'payments-epic',
      ticket: 'redmine:1234',
      activity: 'Writing migration',
      links: [{ label: 'PR #7', url: 'https://github.com/o/r/pull/7', kind: 'pr' }],
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.status, 'active');
    assert.equal(created.body.ticketUrl, 'https://redmine.example/issues/1234');
    assert.equal(created.body.agent, 'bot');
    assert.equal(created.body.group, 'payments-epic');

    const patched = await call('PUT', '/api/lanes/epic-1', AGENT, { status: 'pending_ci', ticket: '#99' });
    assert.equal(patched.body.status, 'pending_ci');
    assert.equal(patched.body.name, 'Epic 1');
    assert.equal(patched.body.ticketUrl, 'https://redmine.example/issues/99');
    assert.equal(patched.body.links.length, 1);
  });

  test('a group registered without a name is named after its id; overseer fills in its metadata', async () => {
    const groups = (await call('GET', '/api/groups', ALICE)).body;
    assert.deepEqual(
      groups.map((g: { id: string; name: string }) => [g.id, g.name]),
      [['payments-epic', 'payments-epic']],
    );
    const updated = await call('PUT', '/api/groups/payments-epic', AGENT, {
      name: 'Payments epic',
      ticket: 'redmine:4700',
      links: [{ label: 'Overseer session', url: 'https://claude.ai/code/session_x', kind: 'session' }],
    });
    assert.equal(updated.body.ticketUrl, 'https://redmine.example/issues/4700');
    const snap = (await call('GET', '/api/snapshot', ALICE)).body;
    assert.equal(snap.groups[0].name, 'Payments epic');
    assert.equal((await call('PUT', '/api/groups/x', ALICE, { name: 'nope' })).status, 403);
  });

  test('exports: zip of CSVs, single CSV/JSON datasets, date filters', async () => {
    const zip = await fetch(`${base}/api/export`, { headers: { authorization: `Bearer ${ALICE}` } });
    assert.equal(zip.status, 200);
    assert.equal(zip.headers.get('content-type'), 'application/zip');
    assert.match(zip.headers.get('content-disposition') ?? '', /lanesignal-export-\d{4}-\d{2}-\d{2}\.zip/);
    const buf = Buffer.from(await zip.arrayBuffer());
    assert.equal(buf.readUInt32LE(0), 0x04034b50);
    for (const name of ['escalations.csv', 'positions.csv', 'lanes.csv', 'groups.csv', 'events.csv', 'README.txt']) {
      assert.ok(buf.includes(Buffer.from(name)), name);
    }

    const csv = await fetch(`${base}/api/export/escalations.csv`, { headers: { authorization: `Bearer ${AGENT}` } });
    assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.ok((await csv.text()).startsWith('id,ref,project,lane_id,lane_name,'));
    const lanesCsv = await fetch(`${base}/api/export/lanes.csv`, { headers: { authorization: `Bearer ${AGENT}` } });
    assert.ok((await lanesCsv.text()).includes('epic-1,default,Epic 1,payments-epic'));

    const json = await call('GET', '/api/export/lanes.json', ALICE);
    assert.ok(json.body.some((l: { id: string }) => l.id === 'epic-1'));
    assert.equal((await call('GET', '/api/export/escalations.json?from=2999-01-01', ALICE)).body.length, 0);
    assert.equal((await call('GET', '/api/export/secrets.csv', ALICE)).status, 404);
    assert.equal((await call('GET', '/api/export/lanes.csv?from=yesterday', ALICE)).status, 400);
    assert.equal((await call('GET', '/api/export', null)).status, 401);
  });

  test('deleting a group ungroups its lanes', async () => {
    await call('PUT', '/api/groups/tmp-group', AGENT, {});
    await call('PUT', '/api/lanes/tmp-lane', AGENT, { group: 'tmp-group' });
    assert.equal((await call('DELETE', '/api/groups/tmp-group', ALICE)).status, 204);
    assert.equal((await call('GET', '/api/lanes/tmp-lane', ALICE)).body.lane.group, null);
    await call('DELETE', '/api/lanes/tmp-lane', ALICE);
  });

  test('body-parser errors are client errors, not 500s', async () => {
    const res = await fetch(`${base}/api/lanes/big`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${AGENT}`, 'content-type': 'application/json' },
      body: JSON.stringify({ activity: 'x'.repeat(300_000) }),
    });
    assert.equal(res.status, 413);
  });

  test('validates input', async () => {
    assert.equal((await call('PUT', '/api/lanes/bad%20id', AGENT, {})).status, 400);
    assert.equal((await call('PUT', '/api/lanes/ok', AGENT, { status: 'exploded' })).status, 400);
    assert.equal(
      (await call('PUT', '/api/lanes/ok', AGENT, { links: [{ label: 'x', url: 'javascript:alert(1)' }] })).status,
      400,
    );
  });

  test('detail includes event history', async () => {
    const res = await call('GET', '/api/lanes/epic-1', ALICE);
    assert.equal(res.status, 200);
    const messages = res.body.events.map((e: { message: string }) => e.message);
    assert.ok(messages.includes('active → pending_ci'));
    assert.ok(messages.includes('Writing migration'));
  });
});

describe('escalation lifecycle', () => {
  let id = '';

  test('agent creates; lane becomes blocked_human', async () => {
    const unpublished = await call('POST', '/api/escalations', AGENT, { laneId: 'train-a', question: 'Too early?' });
    assert.equal(unpublished.status, 404, 'the lane must be published first');
    assert.match(unpublished.body.error, /Lane "train-a" not found: publish it first/);
    await call('PUT', '/api/lanes/train-a', AGENT, {});
    const res = await call('POST', '/api/escalations', AGENT, {
      laneId: 'train-a',
      context: 'legacy_role has had no reads for 90 days.',
      question: 'Drop legacy column?',
      recommendation: 'Drop it; backups cover rollback.',
      recommendedOption: 'Yes',
      positions: [{ agent: 'reviewer', stance: 'agree', note: 'No readers found' }],
      options: ['Yes', 'No'],
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.state, 'open');
    assert.equal(res.body.recommendedOption, 'Yes');
    assert.equal(res.body.positions[0].agent, 'reviewer');
    id = res.body.id;
    const lane = (await call('GET', '/api/lanes/train-a', ALICE)).body.lane;
    assert.equal(lane.status, 'blocked_human');
    assert.equal(lane.openEscalations, 1);
    assert.ok(lane.blockedSince);
  });

  test('recommendedOption must be one of the options', async () => {
    const res = await call('POST', '/api/escalations', AGENT, {
      laneId: 'train-a',
      question: 'Q?',
      options: ['A'],
      recommendedOption: 'B',
    });
    assert.equal(res.status, 400);
  });

  test('agents add or replace positions while open', async () => {
    await call('POST', `/api/escalations/${id}/positions`, AGENT, { stance: 'disagree', note: 'risky' });
    const res = await call('POST', `/api/escalations/${id}/positions`, AGENT, {
      agent: 'reviewer',
      stance: 'neutral',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.positions.map((p: { agent: string; stance: string }) => [p.agent, p.stance]),
      [
        ['bot', 'disagree'],
        ['reviewer', 'neutral'],
      ],
    );
    assert.equal((await call('POST', `/api/escalations/${id}/positions`, ALICE, { stance: 'agree' })).status, 403);
  });

  test('agents cannot decide', async () => {
    assert.equal((await call('POST', `/api/escalations/${id}/decide`, AGENT, { decision: 'Yes' })).status, 403);
  });

  test('long-poll returns when decided; second human gets 409', async () => {
    const waiting = call('GET', `/api/escalations/${id}?wait=10`, AGENT);
    await new Promise((r) => setTimeout(r, 100));
    const decided = await call('POST', `/api/escalations/${id}/decide`, ALICE, { decision: 'Yes', note: 'backup first' });
    assert.equal(decided.status, 200);
    const polled = await waiting;
    assert.equal(polled.body.state, 'decided');
    assert.equal(polled.body.decidedBy, 'alice');
    assert.equal((await call('POST', `/api/escalations/${id}/decide`, BOB, { decision: 'No' })).status, 409);
  });

  test('lane leaves blocked_human and accumulates blocked time', async () => {
    const lane = (await call('GET', '/api/lanes/train-a', ALICE)).body.lane;
    assert.equal(lane.status, 'awaiting_agent');
    assert.equal(lane.blockedSince, null);
    assert.ok(lane.blockedTotalMs >= 0);
  });

  test('decided escalations stay listed until acknowledged', async () => {
    const open = (await call('GET', '/api/escalations', ALICE)).body;
    assert.ok(open.some((e: { id: string }) => e.id === id));
    assert.equal((await call('POST', `/api/escalations/${id}/ack`, AGENT, { note: 'dropping' })).status, 200);
    const after = (await call('GET', '/api/escalations', ALICE)).body;
    assert.ok(!after.some((e: { id: string }) => e.id === id));
    // Repeating an acknowledgement is a safe no-op.
    const again = await call('POST', `/api/escalations/${id}/ack`, AGENT, {});
    assert.equal(again.status, 200);
    assert.equal(again.body.resolution, 'dropping');
    assert.equal((await call('POST', `/api/escalations/${id}/positions`, AGENT, { stance: 'agree' })).status, 409);
  });

  test('withdraw closes an open escalation', async () => {
    const e = (await call('POST', '/api/escalations', AGENT, { laneId: 'train-a', question: 'Q', blocking: false })).body;
    const res = await call('POST', `/api/escalations/${e.id}/withdraw`, AGENT, { note: 'answered in Remote Control' });
    assert.equal(res.body.state, 'withdrawn');
  });
});

describe('real-time stream', () => {
  test('SSE delivers lane updates (token via query param)', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/events?access_token=${ALICE}`, { signal: ctrl.signal });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    await call('PUT', '/api/lanes/sse-lane', AGENT, { activity: 'hello' });
    let text = '';
    const decoder = new TextDecoder();
    while (!text.includes('sse-lane')) {
      const { value } = await reader.read();
      text += decoder.decode(value);
    }
    assert.match(text, /event: lane/);
    ctrl.abort();
  });

  test('query token is not accepted elsewhere', async () => {
    assert.equal((await call('GET', `/api/lanes?access_token=${ALICE}`, null)).status, 401);
  });
});

describe('mcp', () => {
  async function rpc(token: string, method: string, params: unknown, id = 1) {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const text = await res.text();
    const data = text.split('\n').find((l) => l.startsWith('data: '));
    return JSON.parse(data ? data.slice(6) : text);
  }

  test('agent tools list and update_lane', async () => {
    const tools = await rpc(AGENT, 'tools/list', {});
    const names = tools.result.tools.map((t: { name: string }) => t.name);
    assert.ok(names.includes('update_lane'));
    assert.ok(names.includes('create_escalation'));
    assert.ok(names.includes('add_position'));
    assert.ok(names.includes('update_group'));
    assert.ok(!names.includes('export_data'), 'exports are for people, not every agent session');
    assert.ok(!names.includes('decide_escalation'));

    const out = await rpc(AGENT, 'tools/call', {
      name: 'update_lane',
      arguments: { lane_id: 'mcp-lane', status: 'pending_ci', ticket: 'gh:5' },
    });
    const lane = JSON.parse(out.result.content[0].text);
    assert.deepEqual(Object.keys(lane).sort(), ['id', 'letter', 'project', 'status'], 'where the lane stands, nothing echoed');
    assert.equal(store.getLane('default/mcp-lane')?.ticketUrl, 'https://github.com/o/r/issues/5');
    assert.equal(store.getLane('default/mcp-lane')?.agent, 'bot');

    const created = await rpc(AGENT, 'tools/call', {
      name: 'create_escalation',
      arguments: { lane_id: 'mcp-lane', question: 'Merge?', accept_means: 'Merge it now', reject_means: 'Wait for QA' },
    });
    // Agents get the escalation back in brief: not the whole question echoed.
    const brief = JSON.parse(created.result.content[0].text);
    // Coded with the lane's ticket: gh isn't the default system (redmine is), so its prefix stays.
    assert.equal(brief.ref, 'gh:5A');
    assert.equal(brief.state, 'open');
    assert.equal(brief.acceptMeans, undefined);
    assert.equal(store.getEscalation(brief.id)?.acceptMeans, 'Merge it now');
    const bad = await rpc(AGENT, 'tools/call', {
      name: 'create_escalation',
      arguments: { lane_id: 'mcp-lane', question: 'Merge?', reject_means: '' },
    });
    assert.equal(bad.result.isError, true);
  });

  test('export_data returns CSV pages', async () => {
    const out = await rpc(ALICE, 'tools/call', { name: 'export_data', arguments: { dataset: 'lanes', limit: 1 } });
    const [summary, body] = out.result.content.map((c: { text: string }) => c.text);
    assert.match(summary, /^lanes: rows 1-1 of \d+; call again with offset 1/);
    assert.ok(body.startsWith('id,project,name,group_id,'));
    const empty = await rpc(ALICE, 'tools/call', { name: 'export_data', arguments: { dataset: 'lanes', offset: 9999 } });
    assert.ok(empty.result.content[1].text.startsWith('id,project,name,group_id,'), 'header even when empty');
    const bad = await rpc(ALICE, 'tools/call', { name: 'export_data', arguments: { dataset: 'lanes', from: 'soon' } });
    assert.equal(bad.result.isError, true);
  });

  test('humans get decide_escalation, not agent write tools', async () => {
    const names = (await rpc(ALICE, 'tools/list', {})).result.tools.map((t: { name: string }) => t.name);
    assert.ok(names.includes('decide_escalation'));
    assert.ok(!names.includes('update_lane'));
  });
});
