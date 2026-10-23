import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { ticketResolver } from '../src/tickets.ts';

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
    LANESIGNAL_TICKET_TEMPLATES: 'redmine=https://redmine.example/issues/{id},gh=https://github.com/o/r/issues/{id}',
  });
  store = new Store({ path: ':memory:', resolveTicketUrl: ticketResolver(config.ticketTemplates, config.defaultTicketSystem) });
  const app = createApp({ config, store, push: { fcm: false, ntfy: false } });
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
    assert.deepEqual((await call('GET', '/api/me', ALICE)).body, { name: 'alice', role: 'human' });
    assert.deepEqual((await call('GET', '/api/me', BOB)).body, { name: 'bob', role: 'human' });
  });

  test('health check is public', async () => {
    assert.deepEqual((await call('GET', '/healthz', null)).body, { ok: true });
  });
});

describe('lanes', () => {
  test('upsert creates, then patches, resolving ticket urls', async () => {
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

  test('unknown group ids create the group; overseer fills in its metadata', async () => {
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

  test('deleting a group ungroups its lanes', async () => {
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
    assert.equal((await call('POST', `/api/escalations/${id}/ack`, AGENT, {})).status, 409);
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
    assert.ok(!names.includes('decide_escalation'));

    const out = await rpc(AGENT, 'tools/call', {
      name: 'update_lane',
      arguments: { lane_id: 'mcp-lane', status: 'pending_ci', ticket: 'gh:5' },
    });
    const lane = JSON.parse(out.result.content[0].text);
    assert.equal(lane.ticketUrl, 'https://github.com/o/r/issues/5');
    assert.equal(store.getLane('mcp-lane')?.agent, 'bot');

    const created = await rpc(AGENT, 'tools/call', {
      name: 'create_escalation',
      arguments: { lane_id: 'mcp-lane', question: 'Merge?', options: ['Merge', 'Wait'], recommended_option: 'Merge' },
    });
    assert.equal(JSON.parse(created.result.content[0].text).recommendedOption, 'Merge');
    const bad = await rpc(AGENT, 'tools/call', {
      name: 'create_escalation',
      arguments: { lane_id: 'mcp-lane', question: 'Merge?', options: ['Merge'], recommended_option: 'Nope' },
    });
    assert.equal(bad.result.isError, true);
  });

  test('humans get decide_escalation, not agent write tools', async () => {
    const names = (await rpc(ALICE, 'tools/list', {})).result.tools.map((t: { name: string }) => t.name);
    assert.ok(names.includes('decide_escalation'));
    assert.ok(!names.includes('update_lane'));
  });
});
