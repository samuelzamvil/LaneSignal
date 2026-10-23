import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { createAccounts } from '../src/accounts.ts';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/store.ts';

let base = '';
let close: () => void;

before(async () => {
  // No static tokens at all: accounts and agent keys only.
  const config = loadConfig({
    LANESIGNAL_DATA_DIR: '/nonexistent-unused',
    LANESIGNAL_CONFIG: '/nonexistent.json',
    LANESIGNAL_AUTH_SECRET: 'test-secret-0123456789-0123456789-0123',
  });
  const store = new Store({ path: ':memory:', resolveTicketUrl: () => null });
  const accounts = await createAccounts(config, ':memory:');
  const server = createApp({ config, store, accounts, push: { fcm: false, ntfy: false } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => {
    server.closeAllConnections();
    server.close();
  };
});

after(() => close());

async function call(method: string, path: string, token: string | null, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      origin: base,
      ...extra,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

async function signIn(email: string, password: string) {
  const res = await call('POST', '/api/auth/sign-in/email', null, { email, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const token = res.headers.get('set-auth-token');
  assert.ok(token, 'bearer token header');
  return token!;
}

describe('accounts', () => {
  let adminToken = '';
  let agentKey = '';
  let bobToken = '';

  test('first run needs setup; setup creates the admin once', async () => {
    assert.deepEqual((await call('GET', '/api/setup', null)).body, { needsSetup: true });
    const first = await call('POST', '/api/setup', null, { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
    assert.equal(first.status, 201);
    const again = await call('POST', '/api/setup', null, { email: 'eve@example.com', name: 'Eve', password: 'correct horse battery' });
    assert.equal(again.status, 409);
    assert.deepEqual((await call('GET', '/api/setup', null)).body, { needsSetup: false });
  });

  test('public sign-up is disabled', async () => {
    const res = await call('POST', '/api/auth/sign-up/email', null, { email: 'eve@example.com', name: 'Eve', password: 'correct horse battery' });
    assert.notEqual(res.status, 200);
  });

  test('sign in yields a bearer session that works across the API', async () => {
    assert.equal((await call('POST', '/api/auth/sign-in/email', null, { email: 'ada@example.com', password: 'wrong password!' })).status, 401);
    adminToken = await signIn('ada@example.com', 'correct horse battery');
    const me = (await call('GET', '/api/me', adminToken)).body;
    assert.equal(me.role, 'human');
    assert.equal(me.admin, true);
    assert.equal(me.email, 'ada@example.com');
    assert.equal((await call('GET', '/api/snapshot', adminToken)).status, 200);
    // A human session can't act as an agent.
    assert.equal((await call('PUT', '/api/lanes/x', adminToken, { status: 'active' })).status, 403);
  });

  test('agent keys belong to the account and work for REST and MCP', async () => {
    const created = await call('POST', '/api/auth/api-key/create', adminToken, { name: 'payments-overseer' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    agentKey = created.body.key;
    assert.match(agentKey, /^ls_/);

    const lane = await call('PUT', '/api/lanes/wiring', agentKey, { status: 'active' });
    assert.equal(lane.status, 200);
    assert.equal(lane.body.agent, 'payments-overseer');

    const mcp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agentKey}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.match(await mcp.text(), /update_lane/);

    // Many requests in a row: the key plugin's default per-key rate limit must be off.
    for (let i = 0; i < 15; i++) assert.equal((await call('GET', '/api/lanes', agentKey)).status, 200);

    const listed = (await call('GET', '/api/auth/api-key/list', adminToken)).body;
    const keys = listed.apiKeys ?? listed;
    assert.equal(keys.length, 1);
    assert.equal(keys[0].name, 'payments-overseer');
    assert.equal(keys[0].key, undefined, 'the secret is never listed');
  });

  test('admins add people; non-admins cannot', async () => {
    const add = await call('POST', '/api/auth/admin/create-user', adminToken, {
      email: 'bob@example.com',
      name: 'Bob',
      password: 'temporary password',
      role: 'user',
    });
    assert.equal(add.status, 200, JSON.stringify(add.body));
    bobToken = await signIn('bob@example.com', 'temporary password');
    const me = (await call('GET', '/api/me', bobToken)).body;
    assert.equal(me.admin, false);
    const denied = await call('POST', '/api/auth/admin/create-user', bobToken, {
      email: 'mallory@example.com',
      name: 'Mallory',
      password: 'temporary password',
    });
    assert.notEqual(denied.status, 200);
  });

  test('revoked keys and signed-out sessions stop working', async () => {
    const keys = (await call('GET', '/api/auth/api-key/list', adminToken)).body;
    const id = (keys.apiKeys ?? keys)[0].id;
    assert.equal((await call('POST', '/api/auth/api-key/delete', adminToken, { keyId: id })).status, 200);
    assert.equal((await call('GET', '/api/lanes', agentKey)).status, 401);

    assert.equal((await call('POST', '/api/auth/sign-out', bobToken, {})).status, 200);
    assert.equal((await call('GET', '/api/me', bobToken)).status, 401);
  });

  test('removing a person removes their agent keys', async () => {
    const carol = await call('POST', '/api/auth/admin/create-user', adminToken, {
      email: 'carol@example.com',
      name: 'Carol',
      password: 'temporary password',
    });
    const carolToken = await signIn('carol@example.com', 'temporary password');
    const key = (await call('POST', '/api/auth/api-key/create', carolToken, { name: 'carol-bot' })).body.key;
    assert.equal((await call('GET', '/api/lanes', key)).status, 200);
    const removed = await call('POST', '/api/auth/admin/remove-user', adminToken, { userId: carol.body.user.id });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal((await call('GET', '/api/lanes', key)).status, 401);
    assert.equal((await call('GET', '/api/me', carolToken)).status, 401);
  });

  test('banning a person disables their agent keys and sessions', async () => {
    const dan = await call('POST', '/api/auth/admin/create-user', adminToken, {
      email: 'dan@example.com',
      name: 'Dan',
      password: 'temporary password',
    });
    const danToken = await signIn('dan@example.com', 'temporary password');
    const key = (await call('POST', '/api/auth/api-key/create', danToken, { name: 'dan-bot' })).body.key;
    assert.equal((await call('GET', '/api/lanes', key)).status, 200);
    assert.equal((await call('POST', '/api/auth/admin/ban-user', adminToken, { userId: dan.body.user.id })).status, 200);
    assert.equal((await call('GET', '/api/lanes', key)).status, 401);
    assert.equal((await call('GET', '/api/me', danToken)).status, 401);
  });
});
