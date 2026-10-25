import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { createAccounts } from '../src/accounts.ts';
import { createApp } from '../src/app.ts';
import { createAccessVerifier } from '../src/cloudflare-access.ts';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/store.ts';

const TEAM = 'https://lanes.cloudflareaccess.com';
const AUD = 'aud-tag-0123456789abcdef';
const ADMIN_TOKEN = 'ops-token-0123456789-abcdef';

const keyPair = () => generateKeyPairSync('rsa', { modulusLength: 2048 });
const signing = keyPair();
const other = keyPair();

/** What Cloudflare publishes at <team>/cdn-cgi/access/certs. */
let certFetches = 0;
const fakeFetch = (async (url: string | URL) => {
  assert.equal(String(url), `${TEAM}/cdn-cgi/access/certs`);
  certFetches++;
  const jwk = { ...signing.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
  return new Response(JSON.stringify({ keys: [jwk], public_cert: {}, public_certs: [] }), {
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

/** An application token as Cloudflare Access would forward it. */
function jwt(claims: Record<string, unknown>, opts: { kid?: string; key?: KeyObject; alg?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'k1', typ: 'JWT' });
  const body = enc({ iss: TEAM, aud: [AUD], iat: now, nbf: now, exp: now + 900, sub: 'sub-1', type: 'app', ...claims });
  const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), opts.key ?? signing.privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

async function start(env: Record<string, string>) {
  const config = loadConfig({
    LANESIGNAL_DATA_DIR: '/nonexistent-unused',
    LANESIGNAL_CONFIG: '/nonexistent.json',
    LANESIGNAL_AUTH_SECRET: 'test-secret-0123456789-0123456789-0123',
    LANESIGNAL_HUMAN_TOKENS: `ops:${ADMIN_TOKEN}`,
    ...env,
  });
  const store = new Store({ path: ':memory:', resolveTicketUrl: () => null });
  const accounts = await createAccounts(config, ':memory:');
  const server = createApp({ config, store, accounts, push: { fcm: false, ntfy: false }, accessFetch: fakeFetch }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = text;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* html */
    }
    return { status: res.status, body: json, headers: res.headers };
  }
  const addPerson = (email: string, name: string) =>
    call('POST', '/api/admin/people', { authorization: `Bearer ${ADMIN_TOKEN}` }, { email, name, password: 'temporary password' });
  return {
    base,
    accounts,
    call,
    addPerson,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

const ON = { LANESIGNAL_CLOUDFLARE_ACCESS: 'true', LANESIGNAL_CF_ACCESS_TEAM_DOMAIN: 'lanes.cloudflareaccess.com', LANESIGNAL_CF_ACCESS_AUD: AUD };
const as = (token: string) => ({ 'cf-access-jwt-assertion': token });

describe('cloudflare access sign-in', () => {
  let srv: Awaited<ReturnType<typeof start>>;
  before(async () => {
    srv = await start(ON);
    assert.equal((await srv.addPerson('ada@example.com', 'Ada')).status, 201);
  });
  after(() => srv.close());

  test('a valid assertion signs in as the account with that email', async () => {
    const me = await srv.call('GET', '/api/me', as(jwt({ email: 'Ada@Example.com' })));
    assert.equal(me.status, 200);
    assert.equal(me.body.name, 'Ada');
    assert.equal(me.body.role, 'human');
    assert.equal(me.body.cloudflareAccess, true);
    const config = await srv.call('GET', '/api/config', as(jwt({ email: 'ada@example.com' })));
    assert.equal(config.body.cloudflareAccess, true);
  });

  test("the Managed OAuth token Cloudflare may pass along doesn't get in the way", async () => {
    const me = await srv.call('GET', '/api/me', { authorization: 'Bearer oauth:abc123', ...as(jwt({ email: 'ada@example.com' })) });
    assert.equal(me.status, 200);
    assert.equal(me.body.name, 'Ada');
  });

  test('a LaneSignal credential wins over the assertion', async () => {
    const me = await srv.call('GET', '/api/me', { authorization: `Bearer ${ADMIN_TOKEN}`, ...as(jwt({ email: 'ada@example.com' })) });
    assert.equal(me.body.name, 'ops');
  });

  test('an email without an account is told why', async () => {
    const res = await srv.call('GET', '/api/me', as(jwt({ email: 'eve@example.com' })));
    assert.equal(res.status, 403);
    assert.match(res.body.error, /eve@example\.com.*no active LaneSignal account/);
  });

  test('invalid assertions are refused', async () => {
    const bad = [
      jwt({ email: 'ada@example.com', aud: ['someone-else'] }),
      jwt({ email: 'ada@example.com', iss: 'https://evil.cloudflareaccess.com' }),
      jwt({ email: 'ada@example.com', exp: Math.floor(Date.now() / 1000) - 3600 }),
      jwt({ email: 'ada@example.com', nbf: Math.floor(Date.now() / 1000) + 3600 }),
      jwt({ email: 'ada@example.com' }, { key: other.privateKey }),
      jwt({ email: 'ada@example.com' }, { kid: 'unknown' }),
      jwt({ email: 'ada@example.com' }, { alg: 'HS256' }),
      // A service token's assertion names no person.
      jwt({ common_name: 'client-id.access' }),
      'not.a.jwt',
      'garbage',
    ];
    for (const token of bad) assert.equal((await srv.call('GET', '/api/me', as(token))).status, 401, token);
    // Tampering with the claims breaks the signature.
    const [h, , sig] = jwt({ email: 'ada@example.com' }).split('.');
    const forged = Buffer.from(JSON.stringify({ iss: TEAM, aud: [AUD], exp: 9e9, email: 'ada@example.com' })).toString('base64url');
    assert.equal((await srv.call('GET', '/api/me', as(`${h}.${forged}.${sig}`))).status, 401);
  });

  test('the bare team host is accepted as issuer too', async () => {
    const me = await srv.call('GET', '/api/me', as(jwt({ email: 'ada@example.com', iss: 'lanes.cloudflareaccess.com' })));
    assert.equal(me.status, 200);
  });

  test('changes signed in through Access must not come from another site', async () => {
    const token = jwt({ email: 'ada@example.com' });
    const evil = await srv.call('PUT', '/api/settings/push', { ...as(token), origin: 'https://evil.example' }, { quietAlerts: true });
    assert.equal(evil.status, 403);
    const own = await srv.call('POST', '/api/auth/api-key/create', { ...as(token), origin: 'https://evil.example' }, { name: 'x' });
    assert.equal(own.status, 401);
    // Reads are fine (CORS keeps another site from seeing the answer), and so are same-origin changes.
    assert.equal((await srv.call('GET', '/api/me', { ...as(token), origin: 'https://evil.example' })).status, 200);
    const app = await srv.call('POST', '/api/auth/api-key/create', { ...as(token), origin: 'https://localhost' }, { name: 'phone' });
    assert.equal(app.status, 200);
  });

  test("Better Auth's routes work for someone signed in through Access", async () => {
    const token = jwt({ email: 'ada@example.com' });
    const created = await srv.call('POST', '/api/auth/api-key/create', { ...as(token), origin: srv.base }, { name: 'ada-overseer' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.match(created.body.key, /^ls_/);
    const agent = await srv.call('GET', '/api/me', { authorization: `Bearer ${created.body.key}` });
    assert.equal(agent.body.role, 'agent');
    assert.equal(agent.body.name, 'ada-overseer');
    const listed = await srv.call('GET', '/api/auth/api-key/list', as(token));
    const keys = Array.isArray(listed.body) ? listed.body : listed.body.apiKeys;
    assert.ok(keys.some((k: { name: string }) => k.name === 'ada-overseer'));
    // The kept session is reused rather than a new one made per request.
    const ada = srv.accounts.listUsers().find((u) => u.email === 'ada@example.com')!;
    assert.equal(await srv.accounts.accessSessionToken(ada.id), await srv.accounts.accessSessionToken(ada.id));
  });

  test("removing or banning the person ends their Access sign-in", async () => {
    assert.equal((await srv.addPerson('bob@example.com', 'Bob')).status, 201);
    const token = jwt({ email: 'bob@example.com' });
    assert.equal((await srv.call('GET', '/api/me', as(token))).status, 200);
    const bob = srv.accounts.listUsers().find((u) => u.email === 'bob@example.com')!;
    const c = await srv.accounts.auth.$context;
    await c.internalAdapter.updateUser(bob.id, { banned: true });
    assert.equal((await srv.call('GET', '/api/me', as(token))).status, 403);
    await c.internalAdapter.deleteUser(bob.id);
    assert.equal((await srv.call('GET', '/api/me', as(token))).status, 403);
  });

  test('the OAuth callback hands the code to the app, escaped', async () => {
    const res = await srv.call('GET', '/oauth/callback?code=abc"<x>&state=s1&other=dropped');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /html/);
    assert.match(res.body, /lanesignal:\/\/oauth\/callback\?code=abc%22%3Cx%3E&#38;state=s1/);
    assert.doesNotMatch(res.body, /other=dropped/);
    assert.doesNotMatch(res.body, /<x>/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  test('signing keys are cached', async () => {
    const before = certFetches;
    for (let i = 0; i < 3; i++) await srv.call('GET', '/api/me', as(jwt({ email: 'ada@example.com' })));
    assert.equal(certFetches, before);
  });
});

describe('cloudflare access: creating accounts', () => {
  let srv: Awaited<ReturnType<typeof start>>;
  before(async () => {
    srv = await start({ ...ON, LANESIGNAL_CF_ACCESS_CREATE_ACCOUNTS: 'true' });
    assert.equal((await srv.addPerson('admin@example.com', 'Admin')).status, 201);
  });
  after(() => srv.close());

  test('an email Access lets through gets an account (not an admin), once', async () => {
    const token = jwt({ email: 'new.person@example.com' });
    const results = await Promise.all([1, 2, 3].map(() => srv.call('GET', '/api/me', as(token))));
    for (const r of results) assert.equal(r.status, 200);
    assert.equal(results[0].body.name, 'new.person');
    assert.ok(!results[0].body.admin);
    assert.equal(srv.accounts.listUsers().filter((u) => u.email === 'new.person@example.com').length, 1);
  });
});

describe('cloudflare access: off', () => {
  let srv: Awaited<ReturnType<typeof start>>;
  before(async () => {
    srv = await start({});
    await srv.addPerson('ada@example.com', 'Ada');
  });
  after(() => srv.close());

  test('the assertion is ignored and the callback route is absent', async () => {
    assert.equal((await srv.call('GET', '/api/me', as(jwt({ email: 'ada@example.com' })))).status, 401);
    assert.equal((await srv.call('GET', '/api/config', as(jwt({ email: 'ada@example.com' })))).status, 401);
    assert.notEqual((await srv.call('GET', '/oauth/callback?code=x')).status, 200);
  });
});

describe('cloudflare access: configuration', () => {
  const load = (env: Record<string, string>) =>
    loadConfig({ LANESIGNAL_DATA_DIR: '/nonexistent-unused', LANESIGNAL_CONFIG: '/nonexistent.json', ...env });

  test('needs a team domain and an AUD tag', () => {
    assert.throws(() => load({ LANESIGNAL_CLOUDFLARE_ACCESS: 'true' }), /TEAM_DOMAIN/);
    assert.throws(() => load({ LANESIGNAL_CLOUDFLARE_ACCESS: 'true', LANESIGNAL_CF_ACCESS_TEAM_DOMAIN: 'x.cloudflareaccess.com' }), /AUD/);
    assert.throws(() => load({ ...ON, LANESIGNAL_CF_ACCESS_TEAM_DOMAIN: 'http://x.cloudflareaccess.com' }), /https/);
    assert.throws(() => load({ ...ON, LANESIGNAL_CF_ACCESS_TEAM_DOMAIN: 'https://x.cloudflareaccess.com/path' }), /https host/);
    assert.throws(() => load({ ...ON, LANESIGNAL_CLOUDFLARE_ACCESS: 'maybe' }), /true or false/);
  });

  test('normalises the team domain and reads the options', () => {
    const c = load({ ...ON, LANESIGNAL_CF_ACCESS_TEAM_DOMAIN: 'https://Lanes.cloudflareaccess.com/', LANESIGNAL_CF_ACCESS_AUD: 'a, b' });
    assert.deepEqual(c.cloudflareAccess, { teamDomain: TEAM, audiences: ['a', 'b'], createAccounts: false });
    assert.equal(load({}).cloudflareAccess, null);
  });

  test('assetlinks.json fingerprints are validated and normalised', () => {
    const hex = 'ab'.repeat(32);
    assert.deepEqual(load({ LANESIGNAL_ANDROID_CERT_SHA256: hex }).androidCertFingerprints, ['AB:'.repeat(31) + 'AB']);
    assert.throws(() => load({ LANESIGNAL_ANDROID_CERT_SHA256: 'nope' }), /SHA-256/);
  });

  test('an unreachable key endpoint fails closed and is not hammered', async () => {
    let calls = 0;
    const verifier = createAccessVerifier({ teamDomain: TEAM, audiences: [AUD], createAccounts: false }, (async () => {
      calls++;
      throw new Error('offline');
    }) as typeof fetch);
    assert.equal(await verifier.verify(jwt({ email: 'ada@example.com' })), null);
    assert.equal(await verifier.verify(jwt({ email: 'ada@example.com' })), null);
    assert.equal(calls, 1);
  });
});

describe('assetlinks.json', () => {
  test('served only when fingerprints are configured', async () => {
    const hex = 'AB:'.repeat(31) + 'AB';
    const srv = await start({ LANESIGNAL_ANDROID_CERT_SHA256: hex });
    try {
      const res = await srv.call('GET', '/.well-known/assetlinks.json');
      assert.equal(res.status, 200);
      assert.equal(res.body[0].target.package_name, 'dev.lanesignal.app');
      assert.deepEqual(res.body[0].target.sha256_cert_fingerprints, [hex]);
    } finally {
      srv.close();
    }
    const plain = await start({});
    try {
      assert.notEqual((await plain.call('GET', '/.well-known/assetlinks.json')).status, 200);
    } finally {
      plain.close();
    }
  });
});
