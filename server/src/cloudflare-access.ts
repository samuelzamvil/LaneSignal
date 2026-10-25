import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';
import type { CloudflareAccessConfig } from './config.ts';
import { log } from './log.ts';

/** Header Cloudflare Access adds to every request it lets through to the origin. */
export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

/** Clock skew tolerated on exp/nbf/iat. */
const SKEW_S = 60;
/** Signing keys are re-read this often, and at most this often again when a token names an unknown key. */
const KEYS_MAX_AGE_MS = 60 * 60_000;
const UNKNOWN_KID_REFETCH_MS = 60_000;

export interface AccessIdentity {
  email: string;
  /** Cloudflare's id for the user (stable per identity provider account). */
  sub: string;
  /** Expiry, in seconds since the epoch. */
  exp: number;
}

type Jwk = { kid?: string; kty?: string; alg?: string; n?: string; e?: string };

const b64json = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

/**
 * Verifies the application token Cloudflare Access forwards in `Cf-Access-Jwt-Assertion`: an RS256 JWT signed
 * with the team's keys (published at <team domain>/cdn-cgi/access/certs), issued by the team domain, for one
 * of the configured Access applications (AUD tags). Tokens from browser sign-ins and from Managed OAuth
 * (the Android app) look the same here. Service-token requests carry no email and identify nobody.
 */
export function createAccessVerifier(config: CloudflareAccessConfig, fetchImpl: typeof fetch = fetch) {
  const certsUrl = `${config.teamDomain}/cdn-cgi/access/certs`;
  // Application tokens name the team domain as a URL; accept the bare host too, as Access's OAuth metadata writes it.
  const issuers = new Set([config.teamDomain, new URL(config.teamDomain).host]);
  let keys = new Map<string, KeyObject>();
  let fetchedAt = 0;
  let inflight: Promise<void> | null = null;

  function load(): Promise<void> {
    inflight ??= (async () => {
      try {
        const res = await fetchImpl(certsUrl, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { keys?: Jwk[] };
        const next = new Map<string, KeyObject>();
        for (const k of body.keys ?? []) {
          if (!k.kid || k.kty !== 'RSA') continue;
          next.set(k.kid, createPublicKey({ key: k as JsonWebKey, format: 'jwk' }));
        }
        keys = next;
      } catch (err) {
        log.warn('cloudflare access: could not load signing keys', { url: certsUrl, error: String(err) });
      } finally {
        // A failure also counts, so a broken team domain isn't fetched on every request.
        fetchedAt = Date.now();
        inflight = null;
      }
    })();
    return inflight;
  }

  async function keyFor(kid: string): Promise<KeyObject | undefined> {
    const age = Date.now() - fetchedAt;
    if (age > KEYS_MAX_AGE_MS || (!keys.has(kid) && age > UNKNOWN_KID_REFETCH_MS)) await load();
    return keys.get(kid);
  }

  /** The identity in a valid token; null for anything else (malformed, wrong issuer or audience, expired, no email). */
  async function verifyToken(token: string): Promise<AccessIdentity | null> {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = b64json(parts[0]);
      claims = b64json(parts[1]);
    } catch {
      return null;
    }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
    const key = await keyFor(header.kid);
    if (!key) return null;
    const signed = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
    if (!signed) return null;

    const now = Date.now() / 1000;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (typeof claims.iss !== 'string' || !issuers.has(claims.iss)) return null;
    if (!aud.some((a) => typeof a === 'string' && config.audiences.includes(a))) return null;
    if (typeof claims.exp !== 'number' || claims.exp < now - SKEW_S) return null;
    if (typeof claims.nbf === 'number' && claims.nbf > now + SKEW_S) return null;
    if (typeof claims.iat === 'number' && claims.iat > now + SKEW_S) return null;
    if (typeof claims.email !== 'string' || !claims.email.includes('@')) return null;
    return { email: claims.email.toLowerCase(), sub: typeof claims.sub === 'string' ? claims.sub : '', exp: claims.exp };
  }

  return { verify: verifyToken };
}

export type AccessVerifier = ReturnType<typeof createAccessVerifier>;
