import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { apiKey } from '@better-auth/api-key';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { getMigrations } from 'better-auth/db/migration';
import { admin, bearer } from 'better-auth/plugins';
import type { AccessIdentity } from './cloudflare-access.ts';
import type { Config } from './config.ts';
import { log } from './log.ts';
import { createOidc, type OidcIdentity } from './oidc.ts';
import type { Principal } from './types.ts';

/** Prefix of account-owned agent keys, which tells them apart from session tokens. */
export const KEY_PREFIX = 'ls_';

/** Header the server sets from Express's `req.ip` (which honours trust-proxy) for Better Auth's rate limiter. */
export const CLIENT_IP_HEADER = 'x-lanesignal-client-ip';

/** User agent of the Better Auth sessions LaneSignal keeps for people signed in through Cloudflare Access. */
const ACCESS_SESSION_AGENT = 'LaneSignal (Cloudflare Access)';
/** User agent of the sessions handed out by sign-in with the OIDC provider (LANESIGNAL_OIDC_*). */
const OIDC_SESSION_AGENT = 'LaneSignal (OIDC)';

/** Header that carries the failover key with a password sign-in (LANESIGNAL_PASSWORD_FAILOVER_KEY). */
export const FAILOVER_KEY_HEADER = 'x-lanesignal-failover-key';

/** Better Auth endpoints after which open streams must re-check their credentials. */
const REVOKING_PATHS = new Set([
  '/sign-out',
  '/change-password',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/api-key/delete',
  '/admin/ban-user',
  '/admin/remove-user',
  '/admin/revoke-user-session',
  '/admin/revoke-user-sessions',
  '/admin/set-user-password',
  '/admin/set-role',
]);

const isAdminRole = (role: unknown) =>
  typeof role === 'string' && role.split(',').map((r) => r.trim()).includes('admin');

/**
 * Accounts for humans (email + password, bearer sessions) and agent keys
 * owned by those accounts, via Better Auth. Its tables live in the same
 * SQLite file as LaneSignal's own.
 */
export async function createAccounts(config: Config, dbPath: string, opts: { oidcFetch?: typeof fetch } = {}) {
  const signInLimit = config.signInRateLimit;
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  /** Fires whenever sessions or keys may have been revoked; open streams re-check. */
  const revocations = new EventEmitter<{ revoked: [] }>();
  revocations.setMaxListeners(0);
  const revoked = () => revocations.emit('revoked');
  /** Fires when a person is removed or banned, so their phones stop getting push. */
  const people = new EventEmitter<{
    gone: [userId: string, name: string | null, removed: boolean];
    /** Fires when an account is created (setup, an admin adding someone). */
    added: [userId: string, admin: boolean];
  }>();

  const secret = authSecret(config);
  const oidc = config.oidc && createOidc(config.oidc, opts.oidcFetch);
  const failoverKey = config.oidc ? config.passwordFailoverKey : null;
  const options = {
    database: db,
    secret,
    baseURL: config.publicUrl ?? `http://localhost:${config.port}`,
    basePath: '/api/auth',
    // The app's own origin (whatever host it's served from) plus the Android app and configured origins.
    trustedOrigins: (request) => {
      const origins = [...config.corsOrigins];
      if (config.publicUrl) origins.push(new URL(config.publicUrl).origin);
      const host = request?.headers.get('host');
      if (host) origins.push(`http://${host}`, `https://${host}`);
      return origins;
    },
    // Only an admin (or first-run setup) creates accounts.
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 10, maxPasswordLength: 128 },
    // A phone that isn't opened for a while stays signed in; every use (at most daily) extends the session.
    session: { expiresIn: config.sessionDays * 86_400, updateAge: 86_400 },
    // On in every environment (Better Auth only enables it in production by default), keyed on the real client IP.
    rateLimit: {
      enabled: true,
      customRules: { '/sign-in/email': { window: signInLimit.windowSeconds, max: signInLimit.max } },
    },
    advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
    telemetry: { enabled: false },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            people.emit('added', user.id, isAdminRole((user as { role?: unknown }).role));
          },
        },
        delete: {
          // Keys reference their owner loosely (no foreign key); remove them with the account.
          after: async (user) => {
            db.prepare('DELETE FROM apikey WHERE referenceId = ?').run(user.id);
            revoked();
            people.emit('gone', user.id, user.name ?? null, true);
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path.startsWith('/admin/impersonate')) {
          throw new APIError('FORBIDDEN', { message: 'Impersonation is disabled' });
        }
        // Names attribute decisions; only an admin may change them.
        if (ctx.path === '/update-user' && ctx.body && 'name' in ctx.body) {
          throw new APIError('FORBIDDEN', { message: 'Ask an admin to change your name' });
        }
        // With a failover key, password sign-in is a way in for admins who hold it, and nobody else.
        if (ctx.path === '/sign-in/email' && failoverKey) {
          const given = ctx.headers?.get(FAILOVER_KEY_HEADER);
          if (!given || !sameSecret(given, failoverKey)) {
            throw new APIError('FORBIDDEN', { message: `Password sign-in is off on this server. Sign in with ${config.oidc!.label}.` });
          }
          const email = typeof ctx.body?.email === 'string' ? ctx.body.email : '';
          const row = db.prepare('SELECT role FROM user WHERE lower(email) = ?').get(email.toLowerCase()) as { role: string | null } | undefined;
          if (row && !isAdminRole(row.role)) {
            throw new APIError('FORBIDDEN', { message: 'Only admins can sign in with a password on this server.' });
          }
        }
        // Keys must carry our prefix to be recognised as keys.
        if (ctx.path === '/api-key/create' && ctx.body && 'prefix' in ctx.body) {
          throw new APIError('BAD_REQUEST', { message: 'Custom key prefixes are not supported' });
        }
        // Key metadata only says which role the key acts as, and optionally the one project an agent key is bound to.
        if ((ctx.path === '/api-key/create' || ctx.path === '/api-key/update') && ctx.body?.metadata !== undefined) {
          const m = ctx.body.metadata as unknown;
          const meta = (m ?? {}) as { role?: unknown; project?: unknown };
          const ok =
            m === null ||
            (typeof m === 'object' &&
              Object.keys(m as object).every((k) => k === 'role' || k === 'project') &&
              ['agent', 'human', undefined].includes(meta.role as string | undefined) &&
              (meta.project === undefined || (typeof meta.project === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(meta.project))) &&
              !(meta.role === 'human' && meta.project !== undefined));
          if (!ok) {
            throw new APIError('BAD_REQUEST', {
              message: 'Key metadata may only set role ("agent" or "human") and, for agent keys, a project id',
            });
          }
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        // An admin password reset signs the person out everywhere.
        if (ctx.path === '/admin/set-user-password' && typeof ctx.body?.userId === 'string') {
          await ctx.context.internalAdapter.deleteUserSessions(ctx.body.userId);
        }
        // Only once the ban went through (a refused call ends up here too, with an error).
        if (ctx.path === '/admin/ban-user' && typeof ctx.body?.userId === 'string' && !(ctx.context.returned instanceof Error)) {
          const row = db.prepare('SELECT name FROM user WHERE id = ?').get(ctx.body.userId) as { name: string } | undefined;
          people.emit('gone', ctx.body.userId, row?.name ?? null, false);
        }
        if (REVOKING_PATHS.has(ctx.path)) revoked();
      }),
    },
    logger: {
      log: (level, message) => (level === 'error' ? log.error : level === 'warn' ? log.warn : log.debug)(`auth: ${message}`),
    },
    plugins: [
      // Only signed session tokens are accepted, so a raw token read from the database isn't usable.
      bearer({ requireSignature: true }),
      admin(),
      apiKey({
        defaultPrefix: KEY_PREFIX,
        // Holds only { role }: "human" keys let a person answer escalations from their own MCP client.
        enableMetadata: true,
        // The plugin's default (10 requests/day/key) would starve agents.
        rateLimit: { enabled: false },
      }),
    ],
  } satisfies BetterAuthOptions;

  // Create/upgrade Better Auth's tables first: it checks its schema when the instance starts.
  await (await getMigrations(options)).runMigrations();
  const auth = betterAuth(options);
  // Refresh tokens of OIDC sign-ins, per session, and when the provider last confirmed each.
  db.exec(`CREATE TABLE IF NOT EXISTS oidc_session (
    sessionId TEXT PRIMARY KEY,
    refreshToken TEXT,
    checkedAt INTEGER NOT NULL
  )`);
  db.exec('DELETE FROM oidc_session WHERE sessionId NOT IN (SELECT id FROM session)');

  /** A key only works while its owner exists and isn't (currently) banned. */
  const ownerActive = (userId: string) => {
    const row = db.prepare('SELECT banned, banExpires FROM user WHERE id = ?').get(userId) as
      | { banned: number | null; banExpires: string | number | null }
      | undefined;
    if (!row) return false;
    if (!row.banned) return true;
    const expires = row.banExpires == null ? null : new Date(row.banExpires).getTime();
    return expires !== null && expires < Date.now();
  };

  const userCount = () => Number((db.prepare('SELECT COUNT(*) AS n FROM user').get() as { n: number }).n);

  // First-run setup is gated by a one-time code from the server log / data dir, so that
  // reaching the server first (or an upgraded install that only had static tokens) isn't enough.
  const setupCodeFile = path.join(config.dataDir, 'setup-code');
  let setupCode: string | null = null;
  if (userCount() === 0) {
    setupCode = existsSync(setupCodeFile)
      ? readFileSync(setupCodeFile, 'utf8').trim()
      : randomBytes(9).toString('base64url');
    try {
      mkdirSync(config.dataDir, { recursive: true });
      writeFileSync(setupCodeFile, setupCode, { mode: 0o600 });
    } catch {
      /* the log line below is enough */
    }
    log.warn('no accounts yet: open the web app and create the admin account with this setup code', {
      setupCode,
      alsoIn: setupCodeFile,
    });
  }

  // First-run setup must not race: one process, so a promise chain is enough.
  let setupLock: Promise<unknown> = Promise.resolve();
  // Nor must two first requests from the same new Cloudflare Access user each create an account.
  let accessLock: Promise<unknown> = Promise.resolve();

  /**
   * The account for an email a sign-in provider verified, if it exists and isn't banned. With `create`, an email
   * without an account gets one (not an admin, with a random password: they sign in through the provider).
   */
  async function userForVerifiedEmail(email: string, name: string | null, create: boolean, via: string) {
    let user = userByEmail(email);
    if (!user && create && userCount() > 0) {
      const run = accessLock.then(async () => {
        // Another request may have created it while this one waited.
        if (userByEmail(email)) return;
        const local = name?.trim() || email.split('@')[0] || email;
        await auth.api.createUser({
          body: { email, name: local, password: randomBytes(24).toString('base64url'), role: 'user' },
        });
        log.info(`account created for a ${via} sign-in`, { email });
      });
      accessLock = run.catch(() => {});
      try {
        await run;
      } catch (err) {
        log.warn(`${via} sign-in failed`, { email, error: String(err) });
        return null;
      }
      user = userByEmail(email);
    }
    return user && ownerActive(user.id) ? user : null;
  }

  /** The bearer plugin only accepts signed tokens: "<token>.<HMAC-SHA256 of it, base64>", as sign-in hands out. */
  const signed = (token: string) => `${token}.${createHmac('sha256', secret).update(token).digest('base64')}`;

  /** Re-checks running per session, so concurrent requests share one call to the provider. */
  const rechecks = new Map<string, Promise<boolean>>();
  /**
   * Whether an OIDC session may still be used: re-checked with the provider once its last check is older than
   * LANESIGNAL_OIDC_RECHECK_MINUTES. Refused there, the session ends; an unreachable provider decides nothing.
   */
  function oidcStillAllowed(sessionId: string, token: string): Promise<boolean> | boolean {
    if (!oidc || !config.oidc) return true;
    const row = db.prepare('SELECT refreshToken, checkedAt FROM oidc_session WHERE sessionId = ?').get(sessionId) as
      | { refreshToken: string | null; checkedAt: number }
      | undefined;
    if (!row?.refreshToken || Date.now() - row.checkedAt < config.oidc.recheckMinutes * 60_000) return true;
    let run = rechecks.get(sessionId);
    if (!run) {
      run = (async () => {
        const result = await oidc.recheck(row.refreshToken!);
        if (result.ok) {
          db.prepare('UPDATE oidc_session SET refreshToken = ?, checkedAt = ? WHERE sessionId = ?').run(result.refreshToken, Date.now(), sessionId);
          return true;
        }
        if (!result.refused) return true;
        const c = await auth.$context;
        await c.internalAdapter.deleteSession(token);
        db.prepare('DELETE FROM oidc_session WHERE sessionId = ?').run(sessionId);
        log.info('oidc: the provider no longer lets this person in; session ended', { sessionId });
        revoked();
        return false;
      })().finally(() => rechecks.delete(sessionId));
      rechecks.set(sessionId, run);
    }
    return run;
  }

  const principalOfUser = (u: { id: string; name: string; email: string; role: string | null }): Principal => ({
    name: u.name || u.email,
    role: 'human',
    userId: u.id,
    email: u.email,
    admin: isAdminRole(u.role),
    superuser: isAdminRole(u.role),
  });
  const userByEmail = (email: string) =>
    db.prepare('SELECT id, name, email, role FROM user WHERE lower(email) = ?').get(email.toLowerCase()) as
      | { id: string; name: string; email: string; role: string | null }
      | undefined;

  return {
    auth,
    revocations,
    people,

    needsSetup: () => userCount() === 0,
    /** Whether an account still exists and isn't banned (push tokens of removed people are skipped). */
    userActive: ownerActive,
    /** Every account, for picking project members. */
    listUsers: () =>
      (db.prepare('SELECT id, name, email, role, banned FROM user ORDER BY name').all() as {
        id: string;
        name: string;
        email: string;
        role: string | null;
        banned: number | null;
      }[]).map((u) => ({ id: u.id, name: u.name, email: u.email, admin: isAdminRole(u.role), banned: !!u.banned })),
    isAdmin: (userId: string) => {
      const row = db.prepare('SELECT role FROM user WHERE id = ?').get(userId) as { role: string | null } | undefined;
      return !!row && isAdminRole(row.role);
    },
    /** Exposed for tests. */
    get setupCode() {
      return setupCode;
    },

    /**
     * Creates the first (admin) account. Requires the setup code unless the caller
     * already holds a static human token. Resolves null once any account exists.
     */
    setup(input: { email: string; name: string; password: string; code?: string }, trusted: boolean) {
      const run = setupLock.then(async () => {
        if (userCount() > 0) return null;
        if (!trusted && !(setupCode && input.code && sameSecret(input.code.trim(), setupCode))) {
          throw new APIError('FORBIDDEN', { message: 'Wrong or missing setup code' });
        }
        const { user } = await auth.api.createUser({
          body: { email: input.email, name: input.name, password: input.password, role: 'admin' },
        });
        setupCode = null;
        rmSync(setupCodeFile, { force: true });
        log.info('first account created', { email: user.email });
        return user;
      });
      setupLock = run.catch(() => {});
      return run;
    },

    /** Break-glass for static human tokens: create a person (optionally admin). */
    async createPerson(input: { email: string; name: string; password: string; admin?: boolean }) {
      const { user } = await auth.api.createUser({
        body: { email: input.email, name: input.name, password: input.password, role: input.admin ? 'admin' : 'user' },
      });
      return user;
    },

    /** Break-glass for static human tokens: set a password and sign the person out everywhere. */
    async resetPassword(email: string, password: string) {
      const c = await auth.$context;
      const found = await c.internalAdapter.findUserByEmail(email.toLowerCase());
      if (!found) return false;
      await c.internalAdapter.updatePassword(found.user.id, await c.password.hash(password));
      await c.internalAdapter.deleteUserSessions(found.user.id);
      revoked();
      return true;
    },

    /** Resolves an account-backed bearer credential: an agent key or a session token. */
    async identify(token: string): Promise<Principal | null> {
      try {
        if (token.startsWith(KEY_PREFIX)) {
          const res = await auth.api.verifyApiKey({ body: { key: token } });
          if (!res.valid || !res.key || !ownerActive(res.key.referenceId)) return null;
          const meta = res.key.metadata as { role?: string; project?: string } | null | undefined;
          const owner = db.prepare('SELECT name, email, role FROM user WHERE id = ?').get(res.key.referenceId) as
            | { name: string; email: string; role: string | null }
            | undefined;
          if (!owner) return null;
          if (meta?.role === 'human') {
            // Acts as its owner: decisions are attributed to the person, not the key.
            return {
              name: owner.name || owner.email,
              role: 'human',
              userId: res.key.referenceId,
              email: owner.email,
              admin: false,
              superuser: isAdminRole(owner.role),
              personalKey: true,
            };
          }
          return {
            name: res.key.name ?? 'agent',
            role: 'agent',
            userId: res.key.referenceId,
            superuser: isAdminRole(owner.role),
            ...(meta?.project ? { project: meta.project } : {}),
          };
        }
        const session = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });
        if (!session) return null;
        if (!(await oidcStillAllowed(session.session.id, session.session.token))) return null;
        return principalOfUser({ ...session.user, role: (session.user.role as string | null | undefined) ?? null });
      } catch (err) {
        log.warn('credential check failed', { error: String(err) });
        return null;
      }
    },

    /**
     * The account with the email Cloudflare Access verified, if it exists and isn't banned. With `create`, an
     * email without an account gets one (not an admin, with a random password: they sign in through Access).
     */
    async identifyAccess(identity: AccessIdentity, create: boolean): Promise<Principal | null> {
      const user = await userForVerifiedEmail(identity.email, null, create, 'Cloudflare Access');
      return user ? { ...principalOfUser(user), cloudflareAccess: true } : null;
    },

    /** Sign-in with the OIDC provider (LANESIGNAL_OIDC_*): its client, or null when that's off. */
    oidc,

    /**
     * A session for someone the OIDC provider signed in: a signed bearer token, or null when their email has no
     * active account (and LANESIGNAL_OIDC_CREATE_ACCOUNTS is off). The refresh token re-checks it later.
     */
    async oidcSession(identity: OidcIdentity, refreshToken: string | null): Promise<string | null> {
      const user = await userForVerifiedEmail(identity.email, identity.name, !!config.oidc?.createAccounts, 'OIDC');
      if (!user) return null;
      const c = await auth.$context;
      const session = await c.internalAdapter.createSession(user.id, false, { userAgent: OIDC_SESSION_AGENT });
      db.prepare('INSERT OR REPLACE INTO oidc_session (sessionId, refreshToken, checkedAt) VALUES (?, ?, ?)').run(
        session.id,
        refreshToken,
        Date.now(),
      );
      if (!refreshToken) {
        log.warn('oidc: the provider issued no refresh token, so this session is not re-checked with it', { email: user.email });
      }
      log.info('signed in with OIDC', { email: user.email });
      return signed(session.token);
    },

    /**
     * A signed Better Auth session token for a person signed in through Cloudflare Access, so Better Auth's own
     * routes (agent keys, people) work for them too. One such session per person is kept and reused.
     */
    async accessSessionToken(userId: string): Promise<string> {
      const rows = db
        .prepare('SELECT token, expiresAt FROM session WHERE userId = ? AND userAgent = ?')
        .all(userId, ACCESS_SESSION_AGENT) as { token: string; expiresAt: string | number }[];
      // Reused while it has at least half its life (at most a day) left; each use extends it anyway.
      const margin = Math.min(86_400_000, (config.sessionDays * 86_400_000) / 2);
      const fresh = rows.find((r) => new Date(r.expiresAt).getTime() > Date.now() + margin);
      let token = fresh?.token;
      if (!token) {
        const c = await auth.$context;
        const session = await c.internalAdapter.createSession(userId, false, { userAgent: ACCESS_SESSION_AGENT });
        token = session.token;
      }
      return signed(token);
    },

    close: () => db.close(),
  };
}

export type Accounts = Awaited<ReturnType<typeof createAccounts>>;

const sameSecret = (a: string, b: string) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

/** LANESIGNAL_AUTH_SECRET, or a random one generated once and kept in the data volume. */
function authSecret(config: Config) {
  if (config.authSecret) return config.authSecret;
  const file = path.join(config.dataDir, 'auth-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(config.dataDir, { recursive: true });
  const secret = randomBytes(32).toString('base64url');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
