import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  authorizeUrl,
  callbackParams,
  createTokenSource,
  discover,
  exchangeCode,
  pkce,
  redirectUriFor,
  register,
  resourceMetadataUrl,
  type AccessClient,
  type Http,
  type HttpRequest,
  type HttpResponse,
} from '../src/cloudflare.ts';

const TEAM = 'https://lanes.cloudflareaccess.com';
const SERVER = 'https://ls.example.com';

const AS_METADATA = {
  issuer: 'lanes.cloudflareaccess.com',
  authorization_endpoint: `${TEAM}/cdn-cgi/access/oauth/authorization`,
  token_endpoint: `${TEAM}/cdn-cgi/access/oauth/token`,
  registration_endpoint: `${TEAM}/cdn-cgi/access/oauth/registration`,
  revocation_endpoint: `${TEAM}/cdn-cgi/access/oauth/revoke`,
  code_challenge_methods_supported: ['S256'],
};

/** Cloudflare Access with Managed OAuth in front of SERVER, as the docs describe it. */
function fakeAccess(opts: { managedOAuth?: boolean } = {}) {
  const calls: HttpRequest[] = [];
  let issued = 0;
  const http: Http = async (req) => {
    calls.push(req);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ status, headers, body });
    if (req.url === `${SERVER}/api/me`) {
      return opts.managedOAuth === false
        ? json(401, { error: 'unauthorized' })
        : json(401, { error: 'invalid_token' }, {
            'www-authenticate': `Bearer realm="OAuth", error="invalid_token", resource_metadata="${SERVER}/.well-known/cloudflare-access-protected-resource/"`,
          });
    }
    if (req.url === `${SERVER}/.well-known/cloudflare-access-protected-resource/`) {
      return opts.managedOAuth === false
        ? json(200, '<!doctype html>')
        : json(200, { resource: SERVER, protected: true, authorization_servers: [TEAM] });
    }
    if (req.url === `${TEAM}/.well-known/oauth-authorization-server`) return json(200, AS_METADATA);
    if (req.url === AS_METADATA.registration_endpoint) return json(201, { client_id: 'client-1', ...(req.json as object) });
    if (req.url === AS_METADATA.token_endpoint) {
      const f = req.form!;
      if (f.grant_type === 'refresh_token' && f.refresh_token === 'oauth:revoked') return json(400, { error: 'invalid_grant' });
      issued++;
      return json(200, { access_token: `oauth:access-${issued}`, token_type: 'bearer', expires_in: 900, refresh_token: `oauth:refresh-${issued}` });
    }
    if (req.url === AS_METADATA.revocation_endpoint) return json(200, {});
    return json(404, {});
  };
  return { http, calls };
}

const client: AccessClient = {
  resource: SERVER,
  clientId: 'client-1',
  tokenEndpoint: AS_METADATA.token_endpoint,
  revocationEndpoint: AS_METADATA.revocation_endpoint,
  redirectUri: `${SERVER}/oauth/callback`,
};

test('discovers the authorization server from the 401 Access answers with', async () => {
  const { http } = fakeAccess();
  const found = await discover(http, `${SERVER}/`);
  assert.equal(found?.resource, SERVER);
  assert.equal(found?.metadata.token_endpoint, AS_METADATA.token_endpoint);
  assert.equal(found?.metadata.registration_endpoint, AS_METADATA.registration_endpoint);
});

test('a server without Managed OAuth is not mistaken for one', async () => {
  assert.equal(await discover(fakeAccess({ managedOAuth: false }).http, SERVER), null);
  assert.equal(await discover(async () => { throw new TypeError('offline'); }, SERVER), null);
});

test('resource metadata pointing at another host is ignored', async () => {
  const http: Http = async (req): Promise<HttpResponse> =>
    req.url.endsWith('/api/me')
      ? { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://evil.example/meta"' }, body: null }
      : { status: 404, headers: {}, body: null };
  assert.equal(await discover(http, SERVER), null);
  assert.equal(resourceMetadataUrl('Bearer realm="x"'), null);
});

test('registers a public client for the https callback', async () => {
  const { http, calls } = fakeAccess();
  const found = (await discover(http, SERVER))!;
  assert.equal(redirectUriFor(`${SERVER}/some/path`), `${SERVER}/oauth/callback`);
  assert.equal(await register(http, found.metadata, SERVER, redirectUriFor(SERVER)), 'client-1');
  const reg = calls.find((c) => c.url === AS_METADATA.registration_endpoint)!;
  assert.deepEqual((reg.json as { redirect_uris: string[] }).redirect_uris, [`${SERVER}/oauth/callback`]);
  assert.equal((reg.json as { token_endpoint_auth_method: string }).token_endpoint_auth_method, 'none');
  const refused: Http = async () => ({ status: 400, headers: {}, body: { error: 'invalid_redirect_uri' } });
  await assert.rejects(register(refused, found.metadata, SERVER, redirectUriFor(SERVER)), /allowed redirect URIs/);
});

test('PKCE: an S256 challenge that starts with a letter or digit', async () => {
  for (let i = 0; i < 20; i++) {
    const { verifier, challenge } = await pkce();
    assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.match(challenge, /^[A-Za-z0-9][A-Za-z0-9_-]{42}$/);
    assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
  }
});

test('the authorization URL carries PKCE, state and the resource', () => {
  const url = new URL(authorizeUrl(AS_METADATA, { clientId: 'client-1', redirectUri: client.redirectUri, resource: SERVER, challenge: 'abc', state: 'st' }));
  assert.equal(url.origin + url.pathname, AS_METADATA.authorization_endpoint);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'abc');
  assert.equal(url.searchParams.get('state'), 'st');
  assert.equal(url.searchParams.get('resource'), SERVER);
  assert.equal(url.searchParams.get('response_type'), 'code');
});

test('exchanges the code with the verifier', async () => {
  const { http, calls } = fakeAccess();
  const tokens = await exchangeCode(http, client, 'the-code', 'the-verifier');
  assert.equal(tokens.accessToken, 'oauth:access-1');
  assert.equal(tokens.refreshToken, 'oauth:refresh-1');
  assert.ok(tokens.expiresAt > Date.now() + 800_000);
  const form = calls.at(-1)!.form!;
  assert.equal(form.code_verifier, 'the-verifier');
  assert.equal(form.redirect_uri, client.redirectUri);
});

test('the token source refreshes once for concurrent callers and keeps the new refresh token', async () => {
  const { http, calls } = fakeAccess();
  let stored: string | null = 'oauth:refresh-0';
  const source = createTokenSource(http, client, { get: async () => stored, set: async (v) => void (stored = v) });
  const tokens = await Promise.all([source.token(), source.token(), source.token()]);
  assert.deepEqual(tokens, ['oauth:access-1', 'oauth:access-1', 'oauth:access-1']);
  assert.equal(calls.filter((c) => c.url === AS_METADATA.token_endpoint).length, 1);
  assert.equal(stored, 'oauth:refresh-1');
  // Fresh tokens are reused; a refused one is replaced.
  assert.equal(await source.token(), 'oauth:access-1');
  assert.equal(await source.token(true), 'oauth:access-2');
  // Signing out revokes the refresh token and forgets it.
  await source.signOut();
  assert.equal(stored, null);
  assert.equal(calls.at(-1)!.url, AS_METADATA.revocation_endpoint);
  assert.equal(calls.at(-1)!.form!.token, 'oauth:refresh-2');
});

test('an expired or revoked grant signs out', async () => {
  const { http } = fakeAccess();
  let stored: string | null = 'oauth:revoked';
  const source = createTokenSource(http, client, { get: async () => stored, set: async (v) => void (stored = v) });
  await assert.rejects(source.token(), (err: Error) => err.name === 'SignedOut');
  assert.equal(stored, null);
  await assert.rejects(source.token(), (err: Error) => err.name === 'SignedOut');
});

test('callback links: the app link and the https App Link', () => {
  assert.deepEqual(callbackParams('lanesignal://oauth/callback?code=c1&state=s1'), { code: 'c1', state: 's1', error: null });
  assert.deepEqual(callbackParams(`${SERVER}/oauth/callback?code=c2&state=s2`), { code: 'c2', state: 's2', error: null });
  assert.equal(callbackParams('lanesignal://oauth/callback?error=access_denied')?.error, 'access_denied');
  assert.equal(callbackParams('lanesignal://esc/1'), null);
  assert.equal(callbackParams('http://ls.example.com/oauth/callback?code=x'), null);
  assert.equal(callbackParams('not a url'), null);
});
