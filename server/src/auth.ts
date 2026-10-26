import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Accounts } from './accounts.ts';
import { ACCESS_JWT_HEADER, type AccessVerifier } from './cloudflare-access.ts';
import type { TokenEntry } from './config.ts';
import type { Principal, Role } from './types.ts';

const digest = (s: string) => createHash('sha256').update(s).digest();

/** What a request authenticates with: its bearer token, and the Cloudflare Access assertion when that's on. */
interface Credential {
  bearer?: string;
  access?: string;
}

/** Cloudflare Access sign-in (LANESIGNAL_CLOUDFLARE_ACCESS): the verifier, and whether new emails get accounts. */
export interface AccessAuth {
  verifier: AccessVerifier;
  createAccounts: boolean;
  /** Origins a browser request signed in through Access may come from (CSRF guard; see `sameSiteOk`). */
  trustedOrigins: (req: Request) => string[];
}

/**
 * Header for a LaneSignal session next to Access's Managed OAuth token, which takes `Authorization` in the app:
 * through the tunnel Cloudflare needs that token, on the LAN LaneSignal needs the session.
 */
export const SESSION_HEADER = 'x-lanesignal-session';

/** Managed OAuth access tokens: Cloudflare resolves them at its edge, they mean nothing to LaneSignal. */
const isAccessOAuthToken = (token: string) => token.startsWith('oauth:');

/**
 * Bearer credentials, checked in order: static tokens from config, then
 * account-owned agent keys and account sessions. With Cloudflare Access on, a request
 * without a LaneSignal credential is signed in as the account Access verified.
 */
export function createAuth(
  tokens: TokenEntry[],
  accounts: Pick<Accounts, 'identify' | 'identifyAccess' | 'revocations'>,
  access: AccessAuth | null = null,
) {
  const entries = tokens.map((t) => ({
    // Config-file human tokens belong to whoever runs the server, so they may manage accounts.
    principal: { name: t.name, role: t.role, admin: t.role === 'human' } as Principal,
    hash: digest(t.token),
  }));

  function staticToken(token: string): Principal | null {
    const hash = digest(token);
    // Compare against every entry so timing doesn't reveal which one matched.
    let match: Principal | null = null;
    for (const e of entries) if (timingSafeEqual(hash, e.hash)) match = e.principal;
    return match;
  }

  async function identify(token: string | undefined): Promise<Principal | null> {
    if (!token || isAccessOAuthToken(token)) return null;
    return staticToken(token) ?? (await accounts.identify(token));
  }

  /**
   * A LaneSignal bearer credential decides alone, valid or not: a revoked key never turns into the person
   * Access vouches for. Only without one (or with Access's own Managed OAuth token, which Cloudflare may pass
   * on) does the Access assertion count. `unknownEmail` is set when Access verified someone LaneSignal has no
   * (active) account for, so they can be told why they're refused. `create` allows creating that account
   * (LANESIGNAL_CF_ACCESS_CREATE_ACCOUNTS); re-checks of open connections never create one.
   */
  async function identifyCredential(c: Credential, create = true): Promise<{ principal: Principal | null; unknownEmail?: string }> {
    if (c.bearer && !isAccessOAuthToken(c.bearer)) return { principal: await identify(c.bearer) };
    if (!access || !c.access) return { principal: null };
    const who = await access.verifier.verify(c.access);
    if (!who) return { principal: null };
    const viaAccess = await accounts.identifyAccess(who, create && access.createAccounts);
    return viaAccess ? { principal: viaAccess } : { principal: null, unknownEmail: who.email };
  }

  function tokenFrom(req: Request): string | undefined {
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    const session = req.headers[SESSION_HEADER];
    if (typeof session === 'string' && session.trim() && (!bearer || isAccessOAuthToken(bearer))) return session.trim();
    if (bearer) return bearer;
    // EventSource can't send headers; allow the token as a query parameter for /api/events only.
    if (req.originalUrl.split('?')[0] === '/api/events' && typeof req.query.access_token === 'string') return req.query.access_token;
    return undefined;
  }

  function credentialFrom(req: Request): Credential {
    const assertion = access ? req.headers[ACCESS_JWT_HEADER] : undefined;
    return { bearer: tokenFrom(req), access: typeof assertion === 'string' ? assertion : undefined };
  }

  /**
   * The Access cookie rides along on a browser's cross-site requests too (Cloudflare then adds the assertion),
   * which bearer tokens never do. So a change signed in through Access must not come from another site:
   * browsers send Origin on every cross-origin request and on same-origin POSTs.
   */
  function sameSiteOk(req: Request) {
    if (!access || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
    const origin = req.headers.origin;
    return !origin || access.trustedOrigins(req).includes(origin);
  }

  /** The account a request is signed in as through Cloudflare Access (none when it carries a LaneSignal credential). */
  async function accessPrincipal(req: Request): Promise<Principal | null> {
    if (!access) return null;
    const c = credentialFrom(req);
    if (c.bearer && !isAccessOAuthToken(c.bearer)) return null;
    const { principal } = await identifyCredential(c);
    return principal && sameSiteOk(req) ? principal : null;
  }

  /** Requires a valid credential; optionally restricts to roles. */
  function require(...roles: Role[]) {
    return async (req: Request, res: Response, next: NextFunction) => {
      const credential = credentialFrom(req);
      const { principal, unknownEmail } = await identifyCredential(credential);
      if (!principal) {
        if (unknownEmail) {
          res.status(403).json({ error: `Cloudflare Access signed you in as ${unknownEmail}, which has no active LaneSignal account. Ask an admin to add you.` });
          return;
        }
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      if (principal.cloudflareAccess && !sameSiteOk(req)) {
        res.status(403).json({ error: 'cross-site request refused' });
        return;
      }
      if (roles.length && !roles.includes(principal.role)) {
        res.status(403).json({ error: `requires role ${roles.join(' or ')}` });
        return;
      }
      res.locals.principal = principal;
      // Long-lived requests (SSE, long-polls) re-check the credential while they stay open. An Access
      // assertion stops being valid when it expires, so a stream signed in that way ends and reconnects.
      // An account admin who is demoted loses every project they weren't a member of: treat that as invalid too.
      // It must still be the same identity: an account removed and made again isn't the one that opened the stream.
      const stillValid = async () => {
        const now = (await identifyCredential(credential, false)).principal;
        return (
          now !== null &&
          now.role === principal.role &&
          now.userId === principal.userId &&
          now.name === principal.name &&
          !!now.superuser === !!principal.superuser
        );
      };
      res.locals.stillValid = stillValid;
      // Calls onInvalid as soon as a revocation (sign-out, key delete, ban, removal...) invalidates this credential.
      res.locals.watchRevocation = (onInvalid: () => void) => {
        const check = () => void stillValid().then((ok) => ok || onInvalid());
        accounts.revocations.on('revoked', check);
        return () => accounts.revocations.off('revoked', check);
      };
      next();
    };
  }

  /** The LaneSignal credential a request carries (its bearer, or the session header beside a Managed OAuth token). */
  function bearerOf(req: Request): string | undefined {
    const token = tokenFrom(req);
    return token && !isAccessOAuthToken(token) ? token : undefined;
  }

  return { identify, require, accessPrincipal, bearerOf };
}

export const principalOf = (res: Response) => res.locals.principal as Principal;
export const stillValidOf = (res: Response) => res.locals.stillValid as () => Promise<boolean>;
/** Subscribe to revocation of this request's credential; returns an unsubscribe function. */
export const watchRevocationOf = (res: Response) => res.locals.watchRevocation as (onInvalid: () => void) => () => void;
