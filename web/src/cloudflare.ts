/**
 * Signing in through Cloudflare Access's Managed OAuth (beta) from the Android app: discovery (RFC 9728 /
 * RFC 8414), dynamic client registration, authorization code + PKCE in a Chrome Custom Tab, and token refresh.
 * The access tokens are opaque to the app: Cloudflare checks them at its edge and LaneSignal sees who signed in.
 *
 * Everything here talks to Cloudflare, not LaneSignal, so it goes through an injected HTTP function: the native
 * one in the app (Cloudflare's endpoints don't answer the WebView's CORS checks), a fake in tests.
 */

export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  /** Sent as application/x-www-form-urlencoded. */
  form?: Record<string, string>;
  /** Sent as JSON. */
  json?: unknown;
}
export interface HttpResponse {
  status: number;
  /** Lower-case names. */
  headers: Record<string, string>;
  body: unknown;
}
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

/** What the app keeps (outside secure storage) to use and refresh tokens for one server. */
export interface AccessClient {
  /** The protected resource: the LaneSignal server's origin. */
  resource: string;
  clientId: string;
  tokenEndpoint: string;
  revocationEndpoint: string | null;
  redirectUri: string;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  /** ms since the epoch. */
  expiresAt: number;
}

export class AccessError extends Error {}

interface ServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  code_challenge_methods_supported?: string[];
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const httpsUrl = (v: unknown) => {
  const s = str(v);
  try {
    return s && new URL(s).protocol === 'https:' ? s : null;
  } catch {
    return null;
  }
};

/** The OAuth redirect URI for a server: LaneSignal serves it (and an Android App Link can claim it). */
export const redirectUriFor = (server: string) => `${new URL(server).origin}/oauth/callback`;

/** resource_metadata="…" from a WWW-Authenticate header. */
export function resourceMetadataUrl(header: string | undefined): string | null {
  const m = header && /resource_metadata="([^"]+)"/i.exec(header);
  return m ? m[1] : null;
}

/**
 * Whether Cloudflare Access with Managed OAuth guards the server, and its authorization server's endpoints.
 * Null when it doesn't (no Access, or Managed OAuth not turned on): the app then signs in with a password.
 */
export async function discover(http: Http, server: string): Promise<{ resource: string; metadata: ServerMetadata } | null> {
  const origin = new URL(server).origin;
  let meta: Record<string, unknown> | null = null;
  // Access answers unauthenticated API calls with a 401 that points at its resource metadata.
  const probe = await http({ url: `${origin}/api/me`, method: 'GET' }).catch(() => null);
  const pointed = probe?.status === 401 ? resourceMetadataUrl(probe.headers['www-authenticate']) : null;
  for (const url of [pointed, `${origin}/.well-known/cloudflare-access-protected-resource/`]) {
    if (!url || new URL(url).origin !== origin) continue;
    const res = await http({ url, method: 'GET' }).catch(() => null);
    if (res?.status === 200 && Array.isArray(obj(res.body).authorization_servers)) {
      meta = obj(res.body);
      break;
    }
  }
  const issuer = httpsUrl((meta?.authorization_servers as unknown[] | undefined)?.[0]);
  if (!issuer) return null;
  const as = await http({ url: `${issuer.replace(/\/+$/, '')}/.well-known/oauth-authorization-server`, method: 'GET' });
  const m = obj(as.body);
  const authorization = httpsUrl(m.authorization_endpoint);
  const token = httpsUrl(m.token_endpoint);
  if (as.status !== 200 || !authorization || !token) throw new AccessError("Cloudflare Access's OAuth metadata is incomplete");
  return {
    resource: str(meta?.resource) ?? origin,
    metadata: {
      authorization_endpoint: authorization,
      token_endpoint: token,
      registration_endpoint: httpsUrl(m.registration_endpoint) ?? undefined,
      revocation_endpoint: httpsUrl(m.revocation_endpoint) ?? undefined,
      code_challenge_methods_supported: Array.isArray(m.code_challenge_methods_supported)
        ? (m.code_challenge_methods_supported as string[])
        : undefined,
    },
  };
}

/** Registers the app as a public client (no secret) for this server's redirect URI. */
export async function register(http: Http, metadata: ServerMetadata, resource: string, redirectUri: string): Promise<string> {
  if (!metadata.registration_endpoint) {
    throw new AccessError('Dynamic client registration is off for this Access application');
  }
  const res = await http({
    url: metadata.registration_endpoint,
    method: 'POST',
    json: {
      client_name: 'LaneSignal Android',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      resource,
    },
  });
  const clientId = str(obj(res.body).client_id);
  if (res.status >= 300 || !clientId) {
    throw new AccessError(
      `Cloudflare Access refused to register the app (${oauthError(res) ?? res.status}). Is ${redirectUri} in the application's allowed redirect URIs?`,
    );
  }
  return clientId;
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A PKCE verifier and its S256 challenge. Access misreads challenges that start with - or _, so those are redrawn. */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  for (;;) {
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    if (/^[A-Za-z0-9]/.test(challenge)) return { verifier, challenge };
  }
}

export const randomState = () => base64url(crypto.getRandomValues(new Uint8Array(16)));

export function authorizeUrl(
  metadata: ServerMetadata,
  p: { clientId: string; redirectUri: string; resource: string; challenge: string; state: string },
) {
  const url = new URL(metadata.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    state: p.state,
    resource: p.resource,
  }).toString();
  return url.toString();
}

function oauthError(res: HttpResponse) {
  const b = obj(res.body);
  return str(b.error_description) ?? str(b.error);
}

function tokensFrom(res: HttpResponse, previousRefresh: string | null): Tokens {
  const b = obj(res.body);
  const accessToken = str(b.access_token);
  if (res.status !== 200 || !accessToken) {
    const err = new AccessError(oauthError(res) ?? `Cloudflare Access answered ${res.status}`);
    // invalid_grant: the refresh token expired or was revoked, or the user no longer passes the policy.
    if (obj(res.body).error === 'invalid_grant' || res.status === 400 || res.status === 401) err.name = 'SignedOut';
    throw err;
  }
  const expiresIn = typeof b.expires_in === 'number' && b.expires_in > 0 ? b.expires_in : 900;
  return { accessToken, refreshToken: str(b.refresh_token) ?? previousRefresh, expiresAt: Date.now() + expiresIn * 1000 };
}

export async function exchangeCode(http: Http, c: AccessClient, code: string, verifier: string): Promise<Tokens> {
  const res = await http({
    url: c.tokenEndpoint,
    method: 'POST',
    form: {
      grant_type: 'authorization_code',
      code,
      client_id: c.clientId,
      redirect_uri: c.redirectUri,
      code_verifier: verifier,
      resource: c.resource,
    },
  });
  return tokensFrom(res, null);
}

export async function refresh(http: Http, c: AccessClient, refreshToken: string): Promise<Tokens> {
  const res = await http({
    url: c.tokenEndpoint,
    method: 'POST',
    form: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: c.clientId, resource: c.resource },
  });
  return tokensFrom(res, refreshToken);
}

export async function revoke(http: Http, c: AccessClient, token: string) {
  if (!c.revocationEndpoint) return;
  await http({ url: c.revocationEndpoint, method: 'POST', form: { token, token_type_hint: 'refresh_token', client_id: c.clientId } });
}

/** Refresh this long before the access token expires, so requests never race its expiry. */
const EARLY_MS = 2 * 60_000;

/**
 * Keeps one server's access token fresh. The refresh token lives in secure storage (Android Keystore);
 * the access token only in memory. Concurrent callers share one refresh.
 */
export function createTokenSource(
  http: Http,
  client: AccessClient,
  store: { get: () => Promise<string | null>; set: (v: string | null) => Promise<void> },
  initial?: Tokens,
) {
  let current: Tokens | null = initial ?? null;
  let inflight: Promise<string> | null = null;

  async function renew(): Promise<string> {
    const refreshToken = current?.refreshToken ?? (await store.get());
    if (!refreshToken) {
      const err = new AccessError('Not signed in to Cloudflare Access');
      err.name = 'SignedOut';
      throw err;
    }
    try {
      current = await refresh(http, client, refreshToken);
    } catch (err) {
      if (err instanceof AccessError && err.name === 'SignedOut') await store.set(null);
      throw err;
    }
    if (current.refreshToken && current.refreshToken !== refreshToken) await store.set(current.refreshToken);
    return current.accessToken;
  }

  return {
    /** A usable access token, refreshed first when it's (nearly) expired or `force` says the server refused it. */
    token(force = false): Promise<string> {
      if (!force && current && current.expiresAt - EARLY_MS > Date.now()) return Promise.resolve(current.accessToken);
      inflight ??= renew().finally(() => (inflight = null));
      return inflight;
    },
    /** Revokes the refresh token (best effort) and forgets everything. */
    async signOut() {
      const refreshToken = current?.refreshToken ?? (await store.get());
      current = null;
      await store.set(null);
      if (refreshToken) await revoke(http, client, refreshToken).catch(() => {});
    },
  };
}

export type TokenSource = ReturnType<typeof createTokenSource>;

/** lanesignal://oauth/callback?… or https://<host>/oauth/callback?… (an App Link): the code and state. */
export function callbackParams(url: string): { code: string | null; state: string | null; error: string | null } | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const isApp = u.protocol === 'lanesignal:' && `${u.host}${u.pathname}`.replace(/\/+$/, '') === 'oauth/callback';
  const isLink = u.protocol === 'https:' && u.pathname.replace(/\/+$/, '') === '/oauth/callback';
  if (!isApp && !isLink) return null;
  const p = u.searchParams;
  return { code: p.get('code'), state: p.get('state'), error: p.get('error_description') ?? p.get('error') };
}
