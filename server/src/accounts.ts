import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { apiKey } from '@better-auth/api-key';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { admin, bearer } from 'better-auth/plugins';
import type { Config } from './config.ts';
import { log } from './log.ts';
import type { Principal } from './types.ts';

/** Prefix of account-owned agent keys, which tells them apart from session tokens. */
export const KEY_PREFIX = 'ls_';

/**
 * Accounts for humans (email + password, bearer sessions) and agent keys
 * owned by those accounts, via Better Auth. Its tables live in the same
 * SQLite file as LaneSignal's own.
 */
export async function createAccounts(config: Config, dbPath: string) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');

  const options = {
    database: db,
    secret: authSecret(config),
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
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 10 },
    telemetry: { enabled: false },
    databaseHooks: {
      user: {
        delete: {
          // Keys reference their owner loosely (no foreign key); remove them with the account.
          after: async (user) => {
            db.prepare('DELETE FROM apikey WHERE referenceId = ?').run(user.id);
          },
        },
      },
    },
    logger: {
      log: (level, message) => (level === 'error' ? log.error : level === 'warn' ? log.warn : log.debug)(`auth: ${message}`),
    },
    plugins: [
      bearer(),
      admin(),
      apiKey({
        defaultPrefix: KEY_PREFIX,
        // The plugin's default (10 requests/day/key) would starve agents.
        rateLimit: { enabled: false },
      }),
    ],
  } satisfies BetterAuthOptions;

  // Create/upgrade Better Auth's tables first: it checks its schema when the instance starts.
  await (await getMigrations(options)).runMigrations();
  const auth = betterAuth(options);

  /** A key only works while its owner exists and isn't banned. */
  const ownerActive = (userId: string) => {
    const row = db.prepare('SELECT banned FROM user WHERE id = ?').get(userId) as { banned: number | null } | undefined;
    return !!row && !row.banned;
  };

  const userCount = () => Number((db.prepare('SELECT COUNT(*) AS n FROM user').get() as { n: number }).n);

  // First-run setup must not race: one process, so a promise chain is enough.
  let setupLock: Promise<unknown> = Promise.resolve();

  return {
    auth,

    needsSetup: () => userCount() === 0,

    /** Creates the first (admin) account; refuses once any account exists. */
    setup(input: { email: string; name: string; password: string }) {
      const run = setupLock.then(async () => {
        if (userCount() > 0) return null;
        const { user } = await auth.api.createUser({ body: { ...input, role: 'admin' } });
        log.info('first account created', { email: user.email });
        return user;
      });
      setupLock = run.catch(() => {});
      return run;
    },

    /** Resolves an account-backed bearer credential: an agent key or a session token. */
    async identify(token: string): Promise<Principal | null> {
      try {
        if (token.startsWith(KEY_PREFIX)) {
          const res = await auth.api.verifyApiKey({ body: { key: token } });
          if (!res.valid || !res.key || !ownerActive(res.key.referenceId)) return null;
          return { name: res.key.name ?? 'agent', role: 'agent', userId: res.key.referenceId };
        }
        const session = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });
        if (!session) return null;
        return {
          name: session.user.name || session.user.email,
          role: 'human',
          userId: session.user.id,
          email: session.user.email,
          admin: session.user.role === 'admin',
        };
      } catch (err) {
        log.debug('credential rejected', { error: String(err) });
        return null;
      }
    },

    close: () => db.close(),
  };
}

export type Accounts = Awaited<ReturnType<typeof createAccounts>>;

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
