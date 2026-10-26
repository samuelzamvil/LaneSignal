import type { CloudflareAccessConfig } from './config.ts';
import { createJwks } from './jwt.ts';

/** Header Cloudflare Access adds to every request it lets through to the origin. */
export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

export interface AccessIdentity {
  email: string;
  /** Cloudflare's id for the user (stable per identity provider account). */
  sub: string;
  /** Expiry, in seconds since the epoch. */
  exp: number;
}

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
  const jwks = createJwks(async () => certsUrl, 'cloudflare access', fetchImpl);

  /** The identity in a valid token; null for anything else (malformed, wrong issuer or audience, expired, no email). */
  async function verifyToken(token: string): Promise<AccessIdentity | null> {
    const claims = await jwks.verify(token);
    if (!claims) return null;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (typeof claims.iss !== 'string' || !issuers.has(claims.iss)) return null;
    if (!aud.some((a) => typeof a === 'string' && config.audiences.includes(a))) return null;
    if (typeof claims.email !== 'string' || !claims.email.includes('@')) return null;
    return { email: claims.email.toLowerCase(), sub: typeof claims.sub === 'string' ? claims.sub : '', exp: claims.exp as number };
  }

  return { verify: verifyToken };
}

export type AccessVerifier = ReturnType<typeof createAccessVerifier>;
