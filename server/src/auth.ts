import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { TokenEntry } from './config.ts';
import type { Principal, Role } from './types.ts';

const digest = (s: string) => createHash('sha256').update(s).digest();

export function createAuth(tokens: TokenEntry[]) {
  const entries = tokens.map((t) => ({ principal: { name: t.name, role: t.role } as Principal, hash: digest(t.token) }));

  function identify(token: string | undefined): Principal | null {
    if (!token) return null;
    const hash = digest(token);
    // Compare against every entry so timing doesn't reveal which one matched.
    let match: Principal | null = null;
    for (const e of entries) if (timingSafeEqual(hash, e.hash)) match = e.principal;
    return match;
  }

  function tokenFrom(req: Request): string | undefined {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice(7).trim();
    // EventSource can't send headers; allow the token as a query parameter for /api/events only.
    if (req.originalUrl.split('?')[0] === '/api/events' && typeof req.query.access_token === 'string') return req.query.access_token;
    return undefined;
  }

  /** Requires a valid token; optionally restricts to roles. */
  function require(...roles: Role[]) {
    return (req: Request, res: Response, next: NextFunction) => {
      const principal = identify(tokenFrom(req));
      if (!principal) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      if (roles.length && !roles.includes(principal.role)) {
        res.status(403).json({ error: `requires role ${roles.join(' or ')}` });
        return;
      }
      res.locals.principal = principal;
      next();
    };
  }

  return { identify, require };
}

export const principalOf = (res: Response) => res.locals.principal as Principal;
