import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';
import { log } from './log.ts';

/** Clock skew tolerated on exp/nbf/iat. */
export const SKEW_S = 60;
/** Signing keys are re-read this often, and at most this often again when a token names an unknown key. */
const KEYS_MAX_AGE_MS = 60 * 60_000;
const UNKNOWN_KID_REFETCH_MS = 60_000;

type Jwk = { kid?: string; kty?: string; alg?: string; n?: string; e?: string };

/** A JWT part as an object; throws for anything else (null, a number, an array...). */
const b64json = (part: string) => {
  const v: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
  return v as Record<string, unknown>;
};

/**
 * RSA signing keys published as a JWK set, cached and re-read when they're old or a token names a new key.
 * `url` is resolved on each load (an OIDC provider's comes from its discovery document).
 */
export function createJwks(url: () => Promise<string>, label: string, fetchImpl: typeof fetch = fetch) {
  let keys = new Map<string, KeyObject>();
  let fetchedAt = 0;
  let inflight: Promise<void> | null = null;

  function load(): Promise<void> {
    inflight ??= (async () => {
      let where = '';
      try {
        where = await url();
        const res = await fetchImpl(where, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { keys?: Jwk[] };
        const next = new Map<string, KeyObject>();
        for (const k of body.keys ?? []) {
          if (!k.kid || k.kty !== 'RSA') continue;
          next.set(k.kid, createPublicKey({ key: k as JsonWebKey, format: 'jwk' }));
        }
        keys = next;
      } catch (err) {
        log.warn(`${label}: could not load signing keys`, { url: where, error: String(err) });
      } finally {
        // A failure also counts, so a broken URL isn't fetched on every request.
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

  /**
   * The claims of an RS256 JWT signed with one of these keys and within its validity period (exp, nbf, iat);
   * null for anything else. Issuer and audience are the caller's to check.
   */
  async function verifyJwt(token: string): Promise<Record<string, unknown> | null> {
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
    if (typeof claims.exp !== 'number' || claims.exp < now - SKEW_S) return null;
    if (typeof claims.nbf === 'number' && claims.nbf > now + SKEW_S) return null;
    if (typeof claims.iat === 'number' && claims.iat > now + SKEW_S) return null;
    return claims;
  }

  return { verify: verifyJwt };
}
