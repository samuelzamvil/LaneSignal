import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  tokens: TokenEntry[];
  categories: string[];
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
  categories?: string[];
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
    ...parseTokens(env.LANESIGNAL_OVERSEER_TOKENS, 'overseer'),
    ...parseTokens(env.LANESIGNAL_AGENT_TOKENS, 'agent'),
    ...(file.tokens ?? []),
  ];
  if (tokens.length === 0) tokens = bootstrapTokens(dataDir);
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
    port: Number(env.PORT ?? 8080),
    dataDir,
    publicUrl: env.LANESIGNAL_PUBLIC_URL ?? file.publicUrl ?? null,
    trustProxy: env.LANESIGNAL_TRUST_PROXY === 'true',
    corsOrigins: list(env.LANESIGNAL_CORS_ORIGINS) ?? file.corsOrigins ?? DEFAULT_CORS,
    tokens,
    categories: list(env.LANESIGNAL_CATEGORIES) ?? file.categories ?? ['Epic', 'Train', 'Overseer'],
    ticketTemplates,
    defaultTicketSystem:
      env.LANESIGNAL_TICKET_DEFAULT ?? file.defaultTicketSystem ?? Object.keys(ticketTemplates)[0] ?? null,
    staleMinutes: Number(env.LANESIGNAL_STALE_MINUTES ?? file.staleMinutes ?? 30),
    notifyOn,
    fcmServiceAccountFile: env.LANESIGNAL_FCM_SERVICE_ACCOUNT_FILE ?? file.fcmServiceAccountFile ?? null,
    ntfyUrl: env.LANESIGNAL_NTFY_URL ?? file.ntfyUrl ?? null,
    ntfyToken: env.LANESIGNAL_NTFY_TOKEN ?? file.ntfyToken ?? null,
    eventRetention: Number(env.LANESIGNAL_EVENT_RETENTION ?? file.eventRetention ?? 200),
  };
}

/**
 * With no tokens configured, generate one overseer and one agent token and
 * keep them in the data volume so they survive restarts and upgrades.
 */
function bootstrapTokens(dataDir: string): TokenEntry[] {
  const file = path.join(dataDir, 'generated-tokens.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as TokenEntry[];
  mkdirSync(dataDir, { recursive: true });
  const tokens: TokenEntry[] = [
    { name: 'overseer', role: 'overseer', token: randomBytes(24).toString('base64url') },
    { name: 'agent', role: 'agent', token: randomBytes(24).toString('base64url') },
  ];
  writeFileSync(file, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  log.warn('no tokens configured; generated bootstrap tokens', { path: file });
  return tokens;
}
