import { Browser } from '@capacitor/browser';
import { CapacitorHttp, registerPlugin } from '@capacitor/core';
import {
  AccessError,
  authorizeUrl,
  callbackParams,
  createTokenSource,
  discover,
  exchangeCode,
  pkce,
  randomState,
  redirectUriFor,
  register,
  type AccessClient,
  type Http,
  type TokenSource,
  type Tokens,
} from './cloudflare.ts';

/** Strings kept encrypted with a key in the Android Keystore (the app's SecureStoragePlugin). */
interface SecureStorage {
  get(o: { key: string }): Promise<{ value: string | null }>;
  set(o: { key: string; value: string }): Promise<void>;
  remove(o: { key: string }): Promise<void>;
}
const secure = registerPlugin<SecureStorage>('SecureStorage');

/** Native HTTP: Cloudflare's OAuth endpoints and Access's 401s don't answer the WebView's CORS checks. */
const nativeHttp: Http = async (req) => {
  const res = await CapacitorHttp.request({
    url: req.url,
    method: req.method,
    headers: req.form
      ? { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
      : req.json !== undefined
        ? { 'content-type': 'application/json', accept: 'application/json' }
        : { accept: 'application/json' },
    data: req.form ?? req.json,
  });
  const headers = Object.fromEntries(Object.entries(res.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  let body: unknown = res.data;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      /* not JSON */
    }
  }
  return { status: res.status, headers, body };
};

const refreshKey = (c: AccessClient) => `cf-refresh:${c.resource}`;
const store = (c: AccessClient) => ({
  get: async () => (await secure.get({ key: refreshKey(c) })).value,
  set: (v: string | null) => (v ? secure.set({ key: refreshKey(c), value: v }) : secure.remove({ key: refreshKey(c) })),
});

/** Registered clients, per server (not secret: a public client's id). */
const CLIENTS_KEY = 'lanesignal.accessClients';
/** The sign-in in progress in the Custom Tab. */
const PENDING_KEY = 'lanesignal.accessPending';
/** A sign-in not finished within this is abandoned. */
const PENDING_MAX_MS = 15 * 60_000;

interface Pending {
  client: AccessClient;
  verifier: string;
  state: string;
  startedAt: number;
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** Whether this server sits behind Cloudflare Access with Managed OAuth (then the app signs in that way). */
export async function accessGuards(server: string): Promise<boolean> {
  try {
    return (await discover(nativeHttp, server)) !== null;
  } catch {
    return false;
  }
}

/** Opens Cloudflare Access's sign-in (Google, or whatever the team uses) in a Chrome Custom Tab. */
export async function startAccessSignIn(server: string): Promise<void> {
  const found = await discover(nativeHttp, server);
  if (!found) throw new AccessError('This server is not behind Cloudflare Access with Managed OAuth turned on');
  const redirectUri = redirectUriFor(server);
  const clients = readJson<Record<string, AccessClient>>(CLIENTS_KEY) ?? {};
  let client = clients[found.resource];
  // Re-register when the endpoints moved (a new team domain) or the redirect URI changed.
  if (!client || client.tokenEndpoint !== found.metadata.token_endpoint || client.redirectUri !== redirectUri) {
    const clientId = await register(nativeHttp, found.metadata, found.resource, redirectUri);
    client = {
      resource: found.resource,
      clientId,
      tokenEndpoint: found.metadata.token_endpoint,
      revocationEndpoint: found.metadata.revocation_endpoint ?? null,
      redirectUri,
    };
    localStorage.setItem(CLIENTS_KEY, JSON.stringify({ ...clients, [found.resource]: client }));
  }
  const { verifier, challenge } = await pkce();
  const state = randomState();
  const pending: Pending = { client, verifier, state, startedAt: Date.now() };
  localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  await Browser.open({ url: authorizeUrl(found.metadata, { clientId: client.clientId, redirectUri, resource: found.resource, challenge, state }) });
}

/**
 * Finishes a sign-in from the link Access redirected to. Null when the link isn't an OAuth callback;
 * throws when it is one but doesn't match the sign-in in progress, or the exchange fails.
 */
export async function finishAccessSignIn(url: string): Promise<AccessClient | null> {
  const params = callbackParams(url);
  // The link that started the app is handed out again on every later sign-in screen: use it once.
  if (!params || handled.has(url)) return null;
  handled.add(url);
  const pending = readJson<Pending>(PENDING_KEY);
  // Only the matching callback ends the sign-in in progress; any app can open lanesignal:// links.
  if (!pending || params.state !== pending.state) {
    if (!pending) return null;
    throw new AccessError("That sign-in link doesn't match the one started here. Try again.");
  }
  localStorage.removeItem(PENDING_KEY);
  void Browser.close().catch(() => {});
  if (params.error) throw new AccessError(`Cloudflare Access: ${params.error}`);
  if (Date.now() - pending.startedAt > PENDING_MAX_MS) throw new AccessError('That sign-in expired. Try again.');
  if (!params.code) throw new AccessError('Cloudflare Access sent no sign-in code. Try again.');
  const tokens = await exchangeCode(nativeHttp, pending.client, params.code, pending.verifier);
  if (tokens.refreshToken) await store(pending.client).set(tokens.refreshToken);
  sources.set(pending.client.resource, makeSource(pending.client, tokens));
  return pending.client;
}

/** Callback links already used (in this run of the app). */
const handled = new Set<string>();

const sources = new Map<string, TokenSource>();
const makeSource = (c: AccessClient, initial?: Tokens) => createTokenSource(nativeHttp, c, store(c), initial);

/** The token source for a signed-in server (the same one for every client made for it). */
export function accessTokens(c: AccessClient): TokenSource {
  let s = sources.get(c.resource);
  if (!s) sources.set(c.resource, (s = makeSource(c)));
  return s;
}

export async function accessSignOut(c: AccessClient) {
  await accessTokens(c).signOut();
  sources.delete(c.resource);
}
