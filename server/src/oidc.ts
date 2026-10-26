import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { OidcConfig } from './config.ts';
import { createJwks } from './jwt.ts';
import { log } from './log.ts';

/** Where the sign-in starts (a browser or the app's Custom Tab opens it) and where the provider sends it back. */
export const OIDC_START_PATH = '/api/oidc/start';
export const OIDC_CALLBACK_PATH = '/api/oidc/callback';
/** Cookie that ties the provider's answer to the browser that started the sign-in (login CSRF). */
export const OIDC_STATE_COOKIE = 'ls_oidc_state';

/** A sign-in not finished within this is forgotten. */
const PENDING_MAX_MS = 10 * 60_000;
/** The code a finished sign-in hands the client to redeem for its session. */
const HANDOFF_MAX_MS = 2 * 60_000;
/** At most this many sign-ins in progress at once (a flood of starts can't grow memory without bound)... */
const MAX_PENDING = 1000;
/** ...and from one client address, so one client can't use them all up for everyone. */
const MAX_PENDING_PER_CLIENT = 20;
/** A failed discovery is retried after this. */
const DISCOVERY_RETRY_MS = 60_000;

export interface OidcIdentity {
  email: string;
  name: string | null;
  /** The provider's id for the person. */
  sub: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
}

interface Pending {
  nonce: string;
  verifier: string;
  /** The client's own PKCE challenge: only it can redeem the handoff code (any app can open lanesignal:// links). */
  clientChallenge: string;
  app: boolean;
  /** Who started it (their address), for the per-client cap. */
  client: string;
  at: number;
}

/** A sign-in failure whose message is safe to show; `app` when the app's Custom Tab started it. */
export class OidcError extends Error {
  app = false;
}

const random = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');
const sameString = (a: string, b: string) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/**
 * Sign-in with an OpenID Connect provider (authorization code + PKCE, a confidential client), e.g. a Cloudflare
 * Access for SaaS application. LaneSignal talks to the provider itself, so the sessions it hands out work without
 * the provider (or Cloudflare) in the request path. A refresh token, when the provider issues one, lets those
 * sessions be re-checked with the provider every so often.
 */
export function createOidc(config: OidcConfig, fetchImpl: typeof fetch = fetch) {
  let discovery: Discovery | null = null;
  let discoveryFailedAt = 0;
  let discovering: Promise<Discovery> | null = null;

  function discover(): Promise<Discovery> {
    if (discovery) return Promise.resolve(discovery);
    if (Date.now() - discoveryFailedAt < DISCOVERY_RETRY_MS) return Promise.reject(new OidcError('The sign-in provider is unreachable'));
    discovering ??= (async () => {
      const url = `${config.issuer}/.well-known/openid-configuration`;
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = (await res.json()) as Record<string, unknown>;
        const https = (v: unknown) => {
          const s = str(v);
          if (!s || new URL(s).protocol !== 'https:') throw new Error(`discovery document lacks an https endpoint (${String(v)})`);
          return s;
        };
        const issuer = str(d.issuer)?.replace(/\/+$/, '');
        if (issuer !== config.issuer) throw new Error(`discovery names issuer "${String(d.issuer)}", not ${config.issuer}`);
        discovery = {
          issuer: str(d.issuer)!,
          authorization_endpoint: https(d.authorization_endpoint),
          token_endpoint: https(d.token_endpoint),
          jwks_uri: https(d.jwks_uri),
          token_endpoint_auth_methods_supported: Array.isArray(d.token_endpoint_auth_methods_supported)
            ? (d.token_endpoint_auth_methods_supported as string[])
            : undefined,
        };
        return discovery;
      } catch (err) {
        discoveryFailedAt = Date.now();
        log.warn('oidc: discovery failed', { url, error: String(err) });
        throw new OidcError('The sign-in provider is unreachable or misconfigured');
      } finally {
        discovering = null;
      }
    })();
    return discovering;
  }

  const jwks = createJwks(async () => (await discover()).jwks_uri, 'oidc', fetchImpl);

  /** POSTs to the token endpoint, authenticating as the client the way the provider says it supports. */
  async function tokenRequest(params: Record<string, string>) {
    const d = await discover();
    const methods = d.token_endpoint_auth_methods_supported;
    const basic = !methods || methods.includes('client_secret_basic') || !methods.includes('client_secret_post');
    const body = new URLSearchParams(params);
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (basic) {
      const enc = (v: string) => encodeURIComponent(v);
      headers.authorization = `Basic ${Buffer.from(`${enc(config.clientId)}:${enc(config.clientSecret)}`).toString('base64')}`;
    } else {
      body.set('client_id', config.clientId);
      body.set('client_secret', config.clientSecret);
    }
    const res = await fetchImpl(d.token_endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  }

  const pending = new Map<string, Pending>();
  const handoffs = new Map<string, { token: string; clientChallenge: string; at: number }>();
  const prune = () => {
    const now = Date.now();
    for (const [k, p] of pending) if (now - p.at > PENDING_MAX_MS) pending.delete(k);
    for (const [k, h] of handoffs) if (now - h.at > HANDOFF_MAX_MS) handoffs.delete(k);
  };

  async function finishPending(p: Pending, input: { state: string; code?: string; error?: string; cookieState?: string }) {
    if (!input.cookieState || !sameString(input.cookieState, input.state)) {
      throw new OidcError('That sign-in was started in another browser. Start again here.');
    }
    if (input.error) throw new OidcError(`The sign-in provider refused: ${input.error}`);
    if (!input.code) throw new OidcError('The sign-in provider sent no code. Start again.');
    const d = await discover();
    const { status, json } = await tokenRequest({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: config.redirectUri,
      code_verifier: p.verifier,
    });
    const idToken = str(json.id_token);
    if (status !== 200 || !idToken) {
      log.warn('oidc: code exchange failed', { status, error: str(json.error), description: str(json.error_description) });
      throw new OidcError('The sign-in provider refused the sign-in code. Start again.');
    }
    const claims = await jwks.verify(idToken);
    const aud = claims && (Array.isArray(claims.aud) ? claims.aud : [claims.aud]);
    const ok =
      claims &&
      claims.iss === d.issuer &&
      aud!.includes(config.clientId) &&
      (aud!.length === 1 || claims.azp === config.clientId) &&
      typeof claims.nonce === 'string' &&
      sameString(claims.nonce, p.nonce);
    if (!ok) {
      log.warn('oidc: ID token refused (signature, issuer, audience, expiry or nonce)');
      throw new OidcError("The sign-in provider's answer didn't check out. Start again.");
    }
    const email = str(claims.email)?.toLowerCase();
    if (!email || !email.includes('@')) throw new OidcError('The sign-in provider sent no email address. Add the "email" scope.');
    if (claims.email_verified === false || (config.requireVerifiedEmail && claims.email_verified !== true)) {
      throw new OidcError(
        `The sign-in provider didn't say it verified ${email}. If it never does, an admin can set LANESIGNAL_OIDC_REQUIRE_VERIFIED_EMAIL=false.`,
      );
    }
    const sub = str(claims.sub);
    if (!sub) throw new OidcError("The sign-in provider's answer named nobody (no subject).");
    const identity: OidcIdentity = { email, name: str(claims.name), sub };
    return { identity, refreshToken: str(json.refresh_token), app: p.app, clientChallenge: p.clientChallenge };
  }

  return {
    label: config.label,

    /** The provider's sign-in URL, and the state the browser must keep (in a cookie) to finish it. */
    async start(input: { clientChallenge: string; app: boolean; client: string }): Promise<{ url: string; state: string }> {
      prune();
      const mine = [...pending.values()].filter((p) => p.client === input.client).length;
      if (pending.size >= MAX_PENDING || mine >= MAX_PENDING_PER_CLIENT) {
        throw new OidcError('Too many sign-ins in progress. Try again in a few minutes.');
      }
      const d = await discover();
      const state = random();
      const p: Pending = {
        nonce: random(),
        verifier: random(),
        clientChallenge: input.clientChallenge,
        app: input.app,
        client: input.client,
        at: Date.now(),
      };
      pending.set(state, p);
      const url = new URL(d.authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        scope: config.scopes.join(' '),
        state,
        nonce: p.nonce,
        code_challenge: s256(p.verifier),
        code_challenge_method: 'S256',
      }).toString();
      return { url: url.toString(), state };
    },

    /**
     * Finishes a sign-in from the provider's redirect: checks the state against the cookie, exchanges the code
     * and verifies the ID token. Throws an OidcError (safe to show) when anything is off.
     */
    async finish(input: { state?: string; code?: string; error?: string; cookieState?: string }) {
      prune();
      const p = input.state ? pending.get(input.state) : undefined;
      if (!input.state || !p) throw new OidcError('That sign-in expired or was already used. Start again.');
      pending.delete(input.state);
      try {
        return await finishPending(p, input as typeof input & { state: string });
      } catch (err) {
        if (err instanceof OidcError) err.app = p.app;
        throw err;
      }
    },

    /**
     * Re-checks a sign-in with the provider. `refused`: the provider no longer lets the person in (or the refresh
     * token expired); `unreachable`: it couldn't be asked, so nothing is decided.
     */
    async recheck(refreshToken: string): Promise<{ ok: true; refreshToken: string } | { ok: false; refused: boolean }> {
      try {
        const { status, json } = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
        if (status === 200) return { ok: true, refreshToken: str(json.refresh_token) ?? refreshToken };
        // Only invalid_grant says the person (or their refresh token) is out. Anything else (a rotated client secret,
        // a config change, a 5xx, a proxy page) is the server's or the provider's problem: keep the session.
        const refused = json.error === 'invalid_grant';
        log.warn('oidc: re-check failed', { status, error: str(json.error), refused });
        return { ok: false, refused };
      } catch (err) {
        log.warn('oidc: re-check could not reach the provider', { error: String(err) });
        return { ok: false, refused: false };
      }
    },

    /** A one-time code the client redeems (with its PKCE verifier) for the session token. */
    handoff(token: string, clientChallenge: string) {
      prune();
      const code = random();
      handoffs.set(code, { token, clientChallenge, at: Date.now() });
      return code;
    },

    /** The session token for a handoff code, once; null for an unknown, used, expired or mismatched one. */
    redeem(code: string, verifier: string): string | null {
      prune();
      const h = handoffs.get(code);
      if (!h) return null;
      // Used up on the first try, right or wrong: a guessed verifier gets one chance.
      handoffs.delete(code);
      return sameString(s256(verifier), h.clientChallenge) ? h.token : null;
    },
  };
}

export type Oidc = ReturnType<typeof createOidc>;
