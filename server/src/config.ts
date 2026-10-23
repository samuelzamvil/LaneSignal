import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Role } from './types.ts';
import { log } from './log.ts';

export interface TokenEntry {
  name: string;
  role: Role;
  token: string;
}

export interface Config {
  name: string;
  host: string;
  port: number;
  dataDir: string;
  publicUrl: string | null;
  trustProxy: boolean;
  corsOrigins: string[];
  /** Static tokens from env/config. Optional now that accounts and agent keys exist. */
  tokens: TokenEntry[];
  /** Signs account sessions; generated into the data dir when unset. */
  authSecret: string | null;
  /** Sign-in attempts allowed per client IP per window. */
  signInRateLimit: { max: number; windowSeconds: number };
  /** Display name for lane groups (epic / train / overseer). */
  groupLabel: string;
  /** Ticket system key -> URL template containing {id}. */
  ticketTemplates: Record<string, string>;
  defaultTicketSystem: string | null;
  staleMinutes: number;
  /** Which events trigger push notifications. */
  notifyOn: Set<'escalation' | 'blocked' | 'completed'>;
  fcmServiceAccountFile: string | null;
  ntfyUrl: string | null;
  ntfyToken: string | null;
  eventRetention: number;
}

/** Optional JSON file (usually on the /config volume). Env vars win over it. */
interface FileConfig {
  name?: string;
  publicUrl?: string;
  corsOrigins?: string[];
  tokens?: TokenEntry[];
  groupLabel?: string;
  ticketTemplates?: Record<string, string>;
  defaultTicketSystem?: string;
  staleMinutes?: number;
  notifyOn?: string[];
  fcmServiceAccountFile?: string;
  ntfyUrl?: string;
  ntfyToken?: string;
  eventRetention?: number;
}

const list = (v: string | undefined) =>
  v
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** "name:token,name2:token2" */
function parseTokens(v: string | undefined, role: Role): TokenEntry[] {
  return (list(v) ?? []).map((pair) => {
    const i = pair.indexOf(':');
    if (i <= 0) throw new Error(`Invalid ${role} token entry "${pair}", expected name:token`);
    return { name: pair.slice(0, i), role, token: pair.slice(i + 1) };
  });
}

/** "redmine=https://redmine/issues/{id},gh=https://github.com/o/r/issues/{id}" */
function parseTemplates(v: string | undefined): Record<string, string> | undefined {
  const items = list(v);
  if (!items) return undefined;
  return Object.fromEntries(
    items.map((pair) => {
      const i = pair.indexOf('=');
      if (i <= 0) throw new Error(`Invalid ticket template "${pair}", expected key=url`);
      return [pair.slice(0, i), pair.slice(i + 1)];
    }),
  );
}

/** Integer setting within [min, max]; anything else stops startup with a clear message. */
function int(name: string, value: string | number | undefined, fallback: number, min: number, max: number) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${value}"`);
  }
  return n;
}

const DEFAULT_CORS = ['capacitor://localhost', 'https://localhost', 'http://localhost'];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(env.LANESIGNAL_DATA_DIR ?? '/data');
  const configFile = env.LANESIGNAL_CONFIG ?? '/config/lanesignal.json';
  let file: FileConfig = {};
  if (existsSync(configFile)) {
    file = JSON.parse(readFileSync(configFile, 'utf8')) as FileConfig;
    log.info('config file loaded', { path: configFile });
  }

  let tokens = [
    ...parseTokens(env.LANESIGNAL_HUMAN_TOKENS, 'human'),
    // Former name of LANESIGNAL_HUMAN_TOKENS, still accepted.
    ...parseTokens(env.LANESIGNAL_OVERSEER_TOKENS, 'human'),
    ...parseTokens(env.LANESIGNAL_AGENT_TOKENS, 'agent'),
    // "overseer" was the former name of the human role.
    ...(file.tokens ?? []).map((t) => ({ ...t, role: (t.role as string) === 'overseer' ? ('human' as const) : t.role })),
  ];
  if (tokens.length === 0) tokens = legacyBootstrapTokens(dataDir);
  if (env.LANESIGNAL_AUTH_SECRET !== undefined && env.LANESIGNAL_AUTH_SECRET.length < 32) {
    throw new Error('LANESIGNAL_AUTH_SECRET must be at least 32 characters');
  }
  for (const t of tokens) {
    if (t.token.length < 16) throw new Error(`Token for "${t.name}" is shorter than 16 characters`);
  }

  const ticketTemplates = parseTemplates(env.LANESIGNAL_TICKET_TEMPLATES) ?? file.ticketTemplates ?? {};
  const notifyOn = new Set(
    (list(env.LANESIGNAL_NOTIFY_ON) ?? file.notifyOn ?? ['escalation']).filter(
      (n): n is 'escalation' | 'blocked' | 'completed' =>
        n === 'escalation' || n === 'blocked' || n === 'completed',
    ),
  );

  return {
    name: env.LANESIGNAL_NAME ?? file.name ?? 'LaneSignal',
    host: env.HOST ?? '0.0.0.0',
    port: int('PORT', env.PORT, 8080, 1, 65535),
    dataDir,
    publicUrl: env.LANESIGNAL_PUBLIC_URL ?? file.publicUrl ?? null,
    trustProxy: env.LANESIGNAL_TRUST_PROXY === 'true',
    corsOrigins: list(env.LANESIGNAL_CORS_ORIGINS) ?? file.corsOrigins ?? DEFAULT_CORS,
    tokens,
    authSecret: env.LANESIGNAL_AUTH_SECRET ?? null,
    signInRateLimit: {
      max: int('LANESIGNAL_SIGNIN_RATE_MAX', env.LANESIGNAL_SIGNIN_RATE_MAX, 5, 1, 10_000),
      windowSeconds: int('LANESIGNAL_SIGNIN_RATE_WINDOW', env.LANESIGNAL_SIGNIN_RATE_WINDOW, 60, 1, 86_400),
    },
    groupLabel: env.LANESIGNAL_GROUP_LABEL ?? file.groupLabel ?? 'Epic',
    ticketTemplates,
    defaultTicketSystem:
      env.LANESIGNAL_TICKET_DEFAULT ?? file.defaultTicketSystem ?? Object.keys(ticketTemplates)[0] ?? null,
    staleMinutes: int('LANESIGNAL_STALE_MINUTES', env.LANESIGNAL_STALE_MINUTES ?? file.staleMinutes, 30, 0, 100_000),
    notifyOn,
    fcmServiceAccountFile: env.LANESIGNAL_FCM_SERVICE_ACCOUNT_FILE ?? file.fcmServiceAccountFile ?? null,
    ntfyUrl: env.LANESIGNAL_NTFY_URL ?? file.ntfyUrl ?? null,
    ntfyToken: env.LANESIGNAL_NTFY_TOKEN ?? file.ntfyToken ?? null,
    eventRetention: int('LANESIGNAL_EVENT_RETENTION', env.LANESIGNAL_EVENT_RETENTION ?? file.eventRetention, 200, 1, 100_000),
  };
}

/**
 * Earlier versions generated a token pair into the data volume when none were
 * configured; keep honouring it so those installs aren't locked out. New
 * installs use accounts (first-run setup) and account-owned agent keys instead.
 */
function legacyBootstrapTokens(dataDir: string): TokenEntry[] {
  const file = path.join(dataDir, 'generated-tokens.json');
  if (!existsSync(file)) return [];
  return (JSON.parse(readFileSync(file, 'utf8')) as TokenEntry[]).map((t) => ({
    ...t,
    role: (t.role as string) === 'overseer' ? ('human' as const) : t.role,
  }));
}
