import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
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
  /**
   * Express "trust proxy": false, a hop count (1 = one reverse proxy in front),
   * or addresses/subnets ("loopback", "10.0.0.0/8"). `true` trusts every hop,
   * which lets clients spoof their IP; prefer a hop count.
   */
  trustProxy: boolean | number | string;
  corsOrigins: string[];
  /** Static tokens from env/config. Optional now that accounts and agent keys exist. */
  tokens: TokenEntry[];
  /** Signs account sessions; generated into the data dir when unset. */
  authSecret: string | null;
  /** Sign-in attempts allowed per client IP per window. */
  signInRateLimit: { max: number; windowSeconds: number };
  /** Days a sign-in lasts without being used; each use (at most daily) extends it. */
  sessionDays: number;
  /** Requirement tags rejected as too broad; null for the built-in list. */
  broadTags: string[] | null;
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
  /**
   * What tapping an ntfy notification opens: the LaneSignal Android app ("app", a lanesignal:// link,
   * with an "Open in browser" button when the public URL is set) or the web app ("browser").
   */
  ntfyOpen: 'app' | 'browser';
  eventRetention: number;
  /**
   * Answering escalations in LaneSignal (on by default): the dashboard's decision buttons, and agents
   * waiting for and acknowledging decisions. Off, LaneSignal only alerts: people answer in the agent's
   * own session, and the agent dismisses the alert with a justification.
   */
  decisions: boolean;
  /** The requirements register (on by default). */
  requirements: boolean;
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

/** "true"/"false" (also 1/0, yes/no, on/off); anything else stops startup. */
function bool(name: string, value: string | undefined, fallback: boolean) {
  if (value === undefined || value.trim() === '') return fallback;
  const v = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  throw new Error(`${name} must be true or false, got "${value}"`);
}

/** One of a few words; anything else stops startup. */
function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (value === undefined || value.trim() === '') return fallback;
  const v = value.trim().toLowerCase() as T;
  if (!allowed.includes(v)) throw new Error(`${name} must be one of ${allowed.join(', ')}, got "${value}"`);
  return v;
}

const PROXY_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** Validated Express "trust proxy" value; a typo stops startup instead of crashing inside Express. */
function parseTrustProxy(v: string | undefined): boolean | number | string {
  const value = v?.trim();
  const lower = value?.toLowerCase();
  if (!value || lower === 'false') return false;
  if (lower === 'true') {
    log.warn('LANESIGNAL_TRUST_PROXY=true trusts any X-Forwarded-For a client sends; use a hop count such as 1');
    return true;
  }
  if (/^\d+$/.test(value)) return Number(value);
  for (const part of value.split(',').map((p) => p.trim())) {
    const [addr, bits, extra] = part.split('/');
    const valid =
      extra === undefined &&
      (PROXY_KEYWORDS.has(part) ||
        (isIP(addr) !== 0 && (bits === undefined || (/^\d+$/.test(bits) && Number(bits) <= (isIP(addr) === 4 ? 32 : 128)))));
    if (!valid) {
      throw new Error(
        `LANESIGNAL_TRUST_PROXY must be false, a hop count, or addresses/subnets (e.g. 172.18.0.0/16); got "${value}"`,
      );
    }
  }
  return value;
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

  const tokens = [
    ...parseTokens(env.LANESIGNAL_HUMAN_TOKENS, 'human'),
    // Former name of LANESIGNAL_HUMAN_TOKENS, still accepted.
    ...parseTokens(env.LANESIGNAL_OVERSEER_TOKENS, 'human'),
    ...parseTokens(env.LANESIGNAL_AGENT_TOKENS, 'agent'),
    // "overseer" was the former name of the human role.
    ...(file.tokens ?? []).map((t) => ({ ...t, role: (t.role as string) === 'overseer' ? ('human' as const) : t.role })),
  ];
  // Tokens generated by earlier versions keep working alongside any configured ones.
  tokens.push(...legacyBootstrapTokens(dataDir));
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
    trustProxy: parseTrustProxy(env.LANESIGNAL_TRUST_PROXY),
    corsOrigins: list(env.LANESIGNAL_CORS_ORIGINS) ?? file.corsOrigins ?? DEFAULT_CORS,
    tokens,
    authSecret: env.LANESIGNAL_AUTH_SECRET ?? null,
    signInRateLimit: {
      max: int('LANESIGNAL_SIGNIN_RATE_MAX', env.LANESIGNAL_SIGNIN_RATE_MAX, 5, 1, 10_000),
      windowSeconds: int('LANESIGNAL_SIGNIN_RATE_WINDOW', env.LANESIGNAL_SIGNIN_RATE_WINDOW, 60, 1, 86_400),
    },
    sessionDays: int('LANESIGNAL_SESSION_DAYS', env.LANESIGNAL_SESSION_DAYS, 90, 1, 3650),
    broadTags: env.LANESIGNAL_BROAD_TAGS !== undefined ? (list(env.LANESIGNAL_BROAD_TAGS) ?? []) : null,
    groupLabel: env.LANESIGNAL_GROUP_LABEL ?? file.groupLabel ?? 'Group',
    ticketTemplates,
    defaultTicketSystem:
      env.LANESIGNAL_TICKET_DEFAULT ?? file.defaultTicketSystem ?? Object.keys(ticketTemplates)[0] ?? null,
    staleMinutes: int('LANESIGNAL_STALE_MINUTES', env.LANESIGNAL_STALE_MINUTES ?? file.staleMinutes, 30, 0, 100_000),
    notifyOn,
    fcmServiceAccountFile: env.LANESIGNAL_FCM_SERVICE_ACCOUNT_FILE ?? file.fcmServiceAccountFile ?? null,
    ntfyUrl: env.LANESIGNAL_NTFY_URL ?? file.ntfyUrl ?? null,
    ntfyToken: env.LANESIGNAL_NTFY_TOKEN ?? file.ntfyToken ?? null,
    ntfyOpen: oneOf('LANESIGNAL_NTFY_OPEN', env.LANESIGNAL_NTFY_OPEN, ['app', 'browser'] as const, 'app'),
    eventRetention: int('LANESIGNAL_EVENT_RETENTION', env.LANESIGNAL_EVENT_RETENTION ?? file.eventRetention, 200, 1, 100_000),
    decisions: bool('LANESIGNAL_DECISIONS', env.LANESIGNAL_DECISIONS, true),
    requirements: bool('LANESIGNAL_REQUIREMENTS', env.LANESIGNAL_REQUIREMENTS, true),
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
