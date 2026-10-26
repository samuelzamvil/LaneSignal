import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, mock, test } from 'node:test';
import { createAccounts } from '../src/accounts.ts';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/store.ts';

const ISSUER = 'https://lanes.cloudflareaccess.com/cdn-cgi/access/sso/oidc/client-1';
const CLIENT_ID = 'client-1';
const CLIENT_SECRET = 'client-secret-0123456789';
const PUBLIC = 'https://lanesignal.example.com';
const ADMIN_TOKEN = 'ops-token-0123456789-abcdef';
const FAILOVER = 'failover-key-0123456789';

const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64url = (b: Buffer) => b.toString('base64url');
const s256 = (v: string) => b64url(createHash('sha256').update(v).digest());

function idToken(claims: Record<string, unknown>, key = signing.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: object) => b64url(Buffer.from(JSON.stringify(o)));
  const head = enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const body = enc({ iss: ISSUER, aud: CLIENT_ID, iat: now, exp: now + 300, sub: 'sub-1', ...claims });
  return `${head}.${body}.${b64url(sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key))}`;
}

/**
 * A fake provider. `codes` maps an authorization code to the ID token claims it yields (the nonce is filled in
 * from the authorize request); `refreshAnswer` decides what a refresh gets.
 */
const provider = {
  codes: new Map<string, { claims: Record<string, unknown>; key?: typeof signing.privateKey; nonce?: string }>(),
  refreshAnswer: (_token: string): { status: number; body: Record<string, unknown> } => ({ status: 200, body: { access_token: 'a', refresh_token: 'r2' } }),
  refreshes: [] as string[],
  tokenAuth: [] as string[],
};

const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (u === `${ISSUER}/.well-known/openid-configuration`) {
    return json({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorization`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
    });
  }
  if (u === `${ISSUER}/jwks`) return json({ keys: [{ ...signing.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' }] });
  if (u === `${ISSUER}/token`) {
    provider.tokenAuth.push(String((init?.headers as Record<string, string>).authorization));
    const form = new URLSearchParams(String(init?.body));
    if (form.get('grant_type') === 'refresh_token') {
      provider.refreshes.push(form.get('refresh_token')!);
      const a = provider.refreshAnswer(form.get('refresh_token')!);
      return json(a.body, a.status);
    }
    const c = provider.codes.get(form.get('code')!);
    if (!c || form.get('redirect_uri') !== `${PUBLIC}/api/oidc/callback` || !form.get('code_verifier')) return json({ error: 'invalid_grant' }, 400);
    provider.codes.delete(form.get('code')!);
    return json({ access_token: 'a', refresh_token: 'r1', id_token: idToken({ nonce: c.nonce, ...c.claims }, c.key) });
  }
  throw new Error(`unexpected fetch ${u}`);
}) as typeof fetch;

const OIDC = {
  LANESIGNAL_PUBLIC_URL: PUBLIC,
  LANESIGNAL_OIDC_ISSUER: ISSUER,
  LANESIGNAL_OIDC_CLIENT_ID: CLIENT_ID,
  LANESIGNAL_OIDC_CLIENT_SECRET: CLIENT_SECRET,
};

async function start(env: Record<string, string>) {
  const config = loadConfig({
    LANESIGNAL_DATA_DIR: '/nonexistent-unused',
    LANESIGNAL_CONFIG: '/nonexistent.json',
    LANESIGNAL_AUTH_SECRET: 'test-secret-0123456789-0123456789-0123',
    LANESIGNAL_HUMAN_TOKENS: `ops:${ADMIN_TOKEN}`,
    LANESIGNAL_SIGNIN_RATE_MAX: '100',
    ...env,
  });
  const store = new Store({ path: ':memory:', resolveTicketUrl: () => null });
  const accounts = await createAccounts(config, ':memory:', { oidcFetch: fakeFetch });
  const server = createApp({ config, store, accounts, push: { fcm: false, ntfy: false } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: { origin: base, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
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
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const addPerson = (email: string, name: string, admin = false) =>
    call('POST', '/api/admin/people', bearer(ADMIN_TOKEN), { email, name, password: 'temporary password', admin });

  /** Starts a sign-in; returns what the provider would get, the cookie, and the client's verifier. */
  async function begin(opts: { app?: boolean } = {}) {
    const verifier = b64url(randomBytes(32));
    const res = await call('GET', `/api/oidc/start?challenge=${s256(verifier)}${opts.app ? '&app=1' : ''}`);
    assert.equal(res.status, 302);
    const to = new URL(res.headers.get('location')!);
    const cookie = res.headers.get('set-cookie')!.split(';')[0];
    return { to, cookie, verifier, state: to.searchParams.get('state')!, nonce: to.searchParams.get('nonce')! };
  }

  /** A full sign-in as `claims` (email etc.); returns the callback's response and the verifier. */
  async function signIn(claims: Record<string, unknown>, opts: { app?: boolean; key?: typeof signing.privateKey; nonce?: string } = {}) {
    const b = await begin(opts);
    const code = b64url(randomBytes(8));
    provider.codes.set(code, { claims, key: opts.key, nonce: opts.nonce ?? b.nonce });
    const res = await call('GET', `/api/oidc/callback?code=${code}&state=${b.state}`, { cookie: b.cookie });
    return { res, verifier: b.verifier };
  }

  /** Signs in and redeems the handoff code: the session token. */
  async function session(email: string) {
    const { res, verifier } = await signIn({ email, email_verified: true });
    assert.equal(res.status, 302, JSON.stringify(res.body));
    const code = /^\/#oidc=(.+)$/.exec(res.headers.get('location')!)![1];
    const redeemed = await call('POST', '/api/oidc/redeem', {}, { code, verifier });
    assert.equal(redeemed.status, 200);
    return redeemed.body.token as string;
  }

  return {
    accounts,
    call,
    bearer,
    addPerson,
    begin,
    signIn,
    session,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

describe('sign-in with an OIDC provider', () => {
  let srv: Awaited<ReturnType<typeof start>>;
  before(async () => {
    srv = await start(OIDC);
    assert.equal((await srv.addPerson('ada@example.com', 'Ada')).status, 201);
  });
  after(() => srv.close());

  test('the login page learns about the provider', async () => {
    const res = await srv.call('GET', '/api/setup');
    assert.deepEqual(res.body, { needsSetup: false, oidc: { label: 'Cloudflare' }, passwordFailover: false });
  });

  test('start sends the browser to the provider with PKCE, a nonce and a state cookie', async () => {
    const b = await srv.begin();
    assert.equal(b.to.origin + b.to.pathname, `${ISSUER}/authorization`);
    assert.equal(b.to.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(b.to.searchParams.get('redirect_uri'), `${PUBLIC}/api/oidc/callback`);
    assert.equal(b.to.searchParams.get('scope'), 'openid email profile');
    assert.equal(b.to.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(b.nonce && b.state);
    assert.equal(b.cookie, `ls_oidc_state=${b.state}`);
    // Without the client's own challenge there's nothing to start.
    assert.equal((await srv.call('GET', '/api/oidc/start')).status, 400);
  });

  test('a finished sign-in hands out a one-time code for a normal session', async () => {
    const token = await srv.session('Ada@Example.com');
    const me = await srv.call('GET', '/api/me', srv.bearer(token));
    assert.equal(me.status, 200);
    assert.equal(me.body.name, 'Ada');
    assert.equal(me.body.role, 'human');
    assert.equal(me.body.cloudflareAccess, undefined);
    // Better Auth's own routes take it like a password session.
    const s = await srv.call('GET', '/api/auth/get-session', srv.bearer(token));
    assert.equal(s.body.user.email, 'ada@example.com');
    // The client secret goes to the token endpoint, as HTTP Basic.
    assert.equal(provider.tokenAuth.at(-1), `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`);
  });

  test('the handoff code works once, and only with the verifier of the challenge that started it', async () => {
    const { res, verifier } = await srv.signIn({ email: 'ada@example.com' });
    const code = /#oidc=(.+)$/.exec(res.headers.get('location')!)![1];
    assert.equal((await srv.call('POST', '/api/oidc/redeem', {}, { code, verifier: b64url(randomBytes(32)) })).status, 400);
    // A wrong guess used it up.
    assert.equal((await srv.call('POST', '/api/oidc/redeem', {}, { code, verifier })).status, 400);
    const again = await srv.signIn({ email: 'ada@example.com' });
    const code2 = /#oidc=(.+)$/.exec(again.res.headers.get('location')!)![1];
    assert.equal((await srv.call('POST', '/api/oidc/redeem', {}, { code: code2, verifier: again.verifier })).status, 200);
    assert.equal((await srv.call('POST', '/api/oidc/redeem', {}, { code: code2, verifier: again.verifier })).status, 400);
  });

  test('the app gets its code through a lanesignal:// link', async () => {
    const { res } = await srv.signIn({ email: 'ada@example.com' }, { app: true });
    assert.equal(res.status, 200);
    assert.match(res.body, /lanesignal:\/\/oidc\/callback\?code=[\w-]+/);
  });

  test('the callback must come back to the browser that started it, once', async () => {
    const b = await srv.begin();
    const code = 'c-cookie';
    provider.codes.set(code, { claims: { email: 'ada@example.com' }, nonce: b.nonce });
    const wrong = await srv.call('GET', `/api/oidc/callback?code=${code}&state=${b.state}`, { cookie: 'ls_oidc_state=someone-elses' });
    assert.equal(wrong.status, 403);
    assert.match(wrong.body, /another browser/);
    // The state is used up either way.
    const replay = await srv.call('GET', `/api/oidc/callback?code=${code}&state=${b.state}`, { cookie: b.cookie });
    assert.equal(replay.status, 403);
    assert.match(replay.body, /expired or was already used/);
  });

  test("ID tokens that don't check out are refused", async () => {
    const cases: [Record<string, unknown>, { key?: typeof signing.privateKey; nonce?: string }][] = [
      [{ email: 'ada@example.com' }, { nonce: 'not-the-nonce' }],
      [{ email: 'ada@example.com', aud: 'someone-else' }, {}],
      [{ email: 'ada@example.com', aud: [CLIENT_ID, 'other'] }, {}],
      [{ email: 'ada@example.com', iss: 'https://evil.example.com' }, {}],
      [{ email: 'ada@example.com', exp: Math.floor(Date.now() / 1000) - 3600 }, {}],
      [{ email: 'ada@example.com' }, { key: other.privateKey }],
    ];
    for (const [claims, opts] of cases) {
      const { res } = await srv.signIn(claims, opts);
      assert.equal(res.status, 403, JSON.stringify(claims));
      assert.match(res.body, /didn&#39;t check out/);
    }
    const unverified = await srv.signIn({ email: 'ada@example.com', email_verified: false });
    assert.equal(unverified.res.status, 403);
    assert.match(unverified.res.body, /hasn&#39;t verified/);
    const noEmail = await srv.signIn({});
    assert.match(noEmail.res.body, /no email/);
  });

  test('an email without an account is told why', async () => {
    const { res } = await srv.signIn({ email: 'eve@example.com' });
    assert.equal(res.status, 403);
    assert.match(res.body, /eve@example\.com, which has no active LaneSignal account/);
  });

  test('a provider error is shown', async () => {
    const b = await srv.begin();
    const res = await srv.call('GET', `/api/oidc/callback?error=access_denied&state=${b.state}`, { cookie: b.cookie });
    assert.equal(res.status, 403);
    assert.match(res.body, /refused: access_denied/);
  });

  test('the app sends its session beside the Managed OAuth token', async () => {
    const token = await srv.session('ada@example.com');
    const both = { authorization: 'Bearer oauth:managed-token', 'x-lanesignal-session': token };
    assert.equal((await srv.call('GET', '/api/me', both)).body.name, 'Ada');
    const s = await srv.call('GET', '/api/auth/get-session', both);
    assert.equal(s.body.user.email, 'ada@example.com');
    // A LaneSignal bearer still decides alone.
    assert.equal((await srv.call('GET', '/api/me', { ...srv.bearer(ADMIN_TOKEN), 'x-lanesignal-session': token })).body.name, 'ops');
  });

  test('password sign-in still works without a failover key', async () => {
    const res = await srv.call('POST', '/api/auth/sign-in/email', {}, { email: 'ada@example.com', password: 'temporary password' });
    assert.equal(res.status, 200);
  });
});

describe('re-checking OIDC sessions with the provider', () => {
  let srv: Awaited<ReturnType<typeof start>>;
  before(async () => {
    srv = await start({ ...OIDC, LANESIGNAL_OIDC_RECHECK_MINUTES: '5' });
    await srv.addPerson('ada@example.com', 'Ada');
  });
  after(() => {
    mock.timers.reset();
    srv.close();
  });

  test('a session is re-checked once its check is old, and ends when the provider refuses', async () => {
    const token = await srv.session('ada@example.com');
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    provider.refreshes.length = 0;
    // Recent: no call to the provider.
    assert.equal((await srv.call('GET', '/api/me', srv.bearer(token))).status, 200);
    assert.deepEqual(provider.refreshes, []);

    // Old: one refresh, whose new refresh token is kept.
    mock.timers.tick(6 * 60_000);
    provider.refreshAnswer = () => ({ status: 200, body: { access_token: 'a', refresh_token: 'r2' } });
    await Promise.all([srv.call('GET', '/api/me', srv.bearer(token)), srv.call('GET', '/api/me', srv.bearer(token))]);
    assert.deepEqual(provider.refreshes, ['r1']);

    // An unreachable provider decides nothing.
    mock.timers.tick(6 * 60_000);
    provider.refreshAnswer = () => ({ status: 503, body: {} });
    assert.equal((await srv.call('GET', '/api/me', srv.bearer(token))).status, 200);
    assert.deepEqual(provider.refreshes, ['r1', 'r2']);

    // A refusal ends the session.
    provider.refreshAnswer = () => ({ status: 400, body: { error: 'invalid_grant' } });
    assert.equal((await srv.call('GET', '/api/me', srv.bearer(token))).status, 401);
    assert.equal((await srv.call('GET', '/api/me', srv.bearer(token))).status, 401);
    mock.timers.reset();
  });

  test('password sessions are never sent to the provider', async () => {
    const res = await srv.call('POST', '/api/auth/sign-in/email', {}, { email: 'ada@example.com', password: 'temporary password' });
    const token = res.headers.get('set-auth-token')!;
    mock.timers.enable({ apis: ['Date'], now: Date.now() + 60 * 60_000 });
    provider.refreshes.length = 0;
    assert.equal((await srv.call('GET', '/api/me', srv.bearer(token))).status, 200);
    assert.deepEqual(provider.refreshes, []);
    mock.timers.reset();
  });
});

describe('new accounts from OIDC sign-ins', () => {
  test('an email the provider verified gets an account (not an admin) when that is on', async () => {
    const srv = await start({ ...OIDC, LANESIGNAL_OIDC_CREATE_ACCOUNTS: 'true' });
    try {
      await srv.addPerson('ada@example.com', 'Ada', true);
      const token = await srv.session('newbie@example.com');
      const me = await srv.call('GET', '/api/me', srv.bearer(token));
      assert.equal(me.body.email, 'newbie@example.com');
      assert.equal(me.body.admin, false);
    } finally {
      srv.close();
    }
  });
});

describe('password failover key', () => {
  let srv: Awaited<ReturnType<typeof start>>;
  before(async () => {
    srv = await start({ ...OIDC, LANESIGNAL_PASSWORD_FAILOVER_KEY: FAILOVER });
    await srv.addPerson('root@example.com', 'Root', true);
    await srv.addPerson('ada@example.com', 'Ada');
  });
  after(() => srv.close());

  const signIn = (email: string, key?: string) =>
    srv.call('POST', '/api/auth/sign-in/email', key ? { 'x-lanesignal-failover-key': key } : {}, { email, password: 'temporary password' });

  test('the login page hides passwords', async () => {
    assert.equal((await srv.call('GET', '/api/setup')).body.passwordFailover, true);
  });

  test('without the key, password sign-in is refused', async () => {
    for (const key of [undefined, 'wrong-key-0123456789']) {
      const res = await signIn('root@example.com', key);
      assert.equal(res.status, 403);
      assert.match(res.body.message, /Password sign-in is off on this server\. Sign in with Cloudflare/);
    }
  });

  test('with the key, admins sign in and nobody else', async () => {
    assert.equal((await signIn('root@example.com', FAILOVER)).status, 200);
    const res = await signIn('ada@example.com', FAILOVER);
    assert.equal(res.status, 403);
    assert.match(res.body.message, /Only admins/);
  });

  test('OIDC sign-in is unaffected', async () => {
    const token = await srv.session('ada@example.com');
    assert.equal((await srv.call('GET', '/api/me', srv.bearer(token))).status, 200);
  });
});

describe('OIDC config', () => {
  const base = { LANESIGNAL_DATA_DIR: '/nonexistent-unused', LANESIGNAL_CONFIG: '/nonexistent.json' };

  test('off by default, and nothing is served', async () => {
    assert.equal(loadConfig(base).oidc, null);
    const srv = await start({});
    try {
      assert.deepEqual((await srv.call('GET', '/api/setup')).body, { needsSetup: true });
      assert.equal((await srv.call('GET', '/api/oidc/start')).status, 404);
    } finally {
      srv.close();
    }
  });

  test('a half-configured provider stops startup', () => {
    assert.throws(() => loadConfig({ ...base, ...OIDC, LANESIGNAL_OIDC_CLIENT_SECRET: '' }), /CLIENT_ID and LANESIGNAL_OIDC_CLIENT_SECRET/);
    assert.throws(() => loadConfig({ ...base, ...OIDC, LANESIGNAL_PUBLIC_URL: '' }), /needs LANESIGNAL_PUBLIC_URL/);
    assert.throws(() => loadConfig({ ...base, ...OIDC, LANESIGNAL_PUBLIC_URL: 'http://lanesignal.lan' }), /needs LANESIGNAL_PUBLIC_URL \(https\)/);
    assert.throws(() => loadConfig({ ...base, ...OIDC, LANESIGNAL_OIDC_ISSUER: 'http://idp.example.com' }), /must be an https URL/);
  });

  test('the failover key needs a provider and a usable key', () => {
    assert.throws(() => loadConfig({ ...base, LANESIGNAL_PASSWORD_FAILOVER_KEY: FAILOVER }), /needs LANESIGNAL_OIDC_ISSUER/);
    assert.throws(() => loadConfig({ ...base, ...OIDC, LANESIGNAL_PASSWORD_FAILOVER_KEY: 'short' }), /at least 16/);
    assert.throws(() => loadConfig({ ...base, ...OIDC, LANESIGNAL_PASSWORD_FAILOVER_KEY: 'has spaces in it 0123' }), /letters, digits/);
  });

  test('reads the options', () => {
    const c = loadConfig({
      ...base,
      ...OIDC,
      LANESIGNAL_OIDC_ISSUER: `${ISSUER}/`,
      LANESIGNAL_OIDC_LABEL: 'Google',
      LANESIGNAL_OIDC_SCOPES: 'email profile offline_access',
    }).oidc!;
    assert.equal(c.issuer, ISSUER);
    assert.equal(c.label, 'Google');
    assert.deepEqual(c.scopes, ['openid', 'email', 'profile', 'offline_access']);
    assert.equal(c.recheckMinutes, 15);
    assert.equal(c.redirectUri, `${PUBLIC}/api/oidc/callback`);
  });
});
