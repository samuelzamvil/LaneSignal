import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { describe, test } from 'node:test';
import { createAuth, type AccessAuth } from '../src/auth.ts';
import type { Principal } from '../src/types.ts';

const AGENT = 'agent-token-0123456789';
const HUMAN = 'human-token-0123456789';

/** A plain Node request, as a WebSocket upgrade arrives (no Express on it). */
function request(url: string, headers: Record<string, string> = {}, method = 'GET') {
  const req = new IncomingMessage(new Socket());
  req.url = url;
  req.method = method;
  req.headers = headers;
  return req;
}

function setup(opts: { access?: boolean } = {}) {
  const revocations = new EventEmitter();
  let revoked = false;
  const accounts = {
    // Account-backed credentials: one key, which `revoke()` invalidates.
    identify: async (token: string): Promise<Principal | null> =>
      token === 'ls_accountkey' && !revoked ? { name: 'keyed', role: 'agent', userId: 'u1' } : null,
    identifyAccess: async (who: { email: string }): Promise<Principal | null> => ({
      name: who.email,
      role: 'human',
      userId: 'u2',
      cloudflareAccess: true,
    }),
    revocations,
  };
  const access: AccessAuth | null = opts.access
    ? {
        verifier: { verify: async (a: string) => (a === 'good-assertion' ? { email: 'pat@example.com', sub: 's' } : null) } as never,
        createAccounts: false,
        trustedOrigins: () => ['https://lanes.example.com'],
      }
    : null;
  const auth = createAuth(
    [
      { name: 'overseer', role: 'agent', token: AGENT },
      { name: 'alice', role: 'human', token: HUMAN },
    ],
    accounts as never,
    access,
  );
  return {
    auth,
    revoke() {
      revoked = true;
      revocations.emit('revoked');
    },
  };
}

describe('authenticate on a plain Node request', () => {
  test('a bearer header identifies the caller', async () => {
    const { auth } = setup();
    const r = await auth.authenticate(request('/api/agent/socket?group=g', { authorization: `Bearer ${AGENT}` }));
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.principal.name, 'overseer');
  });

  test('no credential, or a wrong one, is 401', async () => {
    const { auth } = setup();
    const none = await auth.authenticate(request('/api/agent/socket'));
    assert.deepEqual(none, { ok: false, status: 401, error: 'unauthorized' });
    const wrong = await auth.authenticate(request('/api/agent/socket', { authorization: 'Bearer nope' }));
    assert.equal(wrong.ok, false);
  });

  test('roles are enforced', async () => {
    const { auth } = setup();
    const r = await auth.authenticate(request('/x', { authorization: `Bearer ${HUMAN}` }), { roles: ['agent'] });
    assert.deepEqual(r, { ok: false, status: 403, error: 'requires role agent' });
  });

  test('the access_token query parameter counts only on /api/events', async () => {
    const { auth } = setup();
    const events = await auth.authenticate(request(`/api/events?access_token=${AGENT}`));
    assert.equal(events.ok, true);
    const socket = await auth.authenticate(request(`/api/agent/socket?access_token=${AGENT}`));
    assert.equal(socket.ok, false);
  });

  test('the original URL wins over a rewritten one (Express routers)', async () => {
    const { auth } = setup();
    const req = Object.assign(request(`/?access_token=${AGENT}`), { originalUrl: `/api/events?access_token=${AGENT}` });
    assert.equal((await auth.authenticate(req)).ok, true);
  });

  test('an identity from Cloudflare Access alone is refused when a credential is required', async () => {
    const { auth } = setup({ access: true });
    const viaAccess = request('/api/agent/socket', { 'cf-access-jwt-assertion': 'good-assertion' });
    const plain = await auth.authenticate(viaAccess);
    assert.equal(plain.ok && plain.principal.name, 'pat@example.com');
    assert.deepEqual(await auth.authenticate(viaAccess, { credentialRequired: true }), { ok: false, status: 401, error: 'unauthorized' });
    // A real credential next to the assertion still works.
    const both = request('/api/agent/socket', { 'cf-access-jwt-assertion': 'good-assertion', authorization: `Bearer ${AGENT}` });
    const r = await auth.authenticate(both, { credentialRequired: true });
    assert.equal(r.ok && r.principal.name, 'overseer');
  });

  test('a cross-site change signed in through Access is refused', async () => {
    const { auth } = setup({ access: true });
    const headers = { 'cf-access-jwt-assertion': 'good-assertion', origin: 'https://evil.example' };
    const r = await auth.authenticate(request('/api/x', headers, 'POST'));
    assert.deepEqual(r, { ok: false, status: 403, error: 'cross-site request refused' });
  });

  test('stillValid and watchRevocation follow a revoked key', async () => {
    const { auth, revoke } = setup();
    const r = await auth.authenticate(request('/x', { authorization: 'Bearer ls_accountkey' }));
    assert.ok(r.ok);
    assert.equal(await r.stillValid(), true);
    let invalidated = false;
    const unwatch = r.watchRevocation(() => (invalidated = true));
    revoke();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(invalidated, true);
    assert.equal(await r.stillValid(), false);
    unwatch();
  });
});
