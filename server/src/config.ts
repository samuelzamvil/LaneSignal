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
  /** Display name for lane groups (epic / train / overseer). */
  groupLabel: string;
  /** Ticket system key -> URL template containing {id}. */
  ticketTemplates: Record<string, string>;
  defaultTicketSystem: string | null;
  staleMinutes: number;
  /** Largest attachment, in bytes. */
  attachmentMaxBytes: number;
  /** Most attachments on one escalation. */
  attachmentsPerItem: number;
  /** Which events trigger push notifications. */
  notifyOn: Set<'escalation' | 'notice' | 'blocked' | 'completed'>;
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
  /** Hosts a project's TRMNL webhook URL may point at (TRMNL's own, plus self-hosted TRMNL servers). */
  trmnlHosts: string[];
  /**
   * Sign-in through Cloudflare Access (beta, off by default): people Access lets through are signed in as the
   * LaneSignal account with their email, from the signed `Cf-Access-Jwt-Assertion` header. Null when off.
   */
  cloudflareAccess: CloudflareAccessConfig | null;
  /**
   * Sign-in with an OpenID Connect provider (LANESIGNAL_OIDC_*, off by default), e.g. a Cloudflare Access for SaaS
   * application: LaneSignal runs the sign-in itself and keeps a session of its own, so it works without Cloudflare
   * in the path (on the LAN). Null when off.
   */
  oidc: OidcConfig | null;
  /**
   * With OIDC on, moves password sign-in to a separate page (`/?failover=<key>`) for admins only, and refuses it
   * without the key. Null: password sign-in works as usual next to OIDC.
   */
  passwordFailoverKey: string | null;
  /** SHA-256 fingerprints of the Android app's signing certificates, for /.well-known/assetlinks.json (App Links). */
  androidCertFingerprints: string[];
}

export interface CloudflareAccessConfig {
  /** https://<team>.cloudflareaccess.com: the tokens' issuer, and where its signing keys are published. */
  teamDomain: string;
  /** Application Audience (AUD) tags of the Access application(s) in front of LaneSignal. */
  audiences: string[];
  /** Create an account (not an admin) for an email Access lets through that has none yet. */
  createAccounts: boolean;
}

export interface OidcConfig {
  /** The provider's issuer URL; its discovery document is at <issuer>/.well-known/openid-configuration. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** What the sign-in button names ("Sign in with <label>"). */
  label: string;
  scopes: string[];
  /** Create an account (not an admin) for a verified email the provider signs in that has none yet. */
  createAccounts: boolean;
  /** Refuse an ID token that doesn't say its email is verified (`email_verified: true`); off, only `false` is refused. */
  requireVerifiedEmail: boolean;
  /** How often a session from this sign-in is re-checked with the provider (refresh token), in minutes. */
  recheckMinutes: number;
  /** Where the provider sends people back: <LANESIGNAL_PUBLIC_URL>/api/oidc/callback. */
  redirectUri: string;
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

/** TRMNL's own servers, always allowed for webhooks (HTTPS only). */
export const TRMNL_HOSTS = ['trmnl.com', 'usetrmnl.com'];

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

/** LANESIGNAL_CLOUDFLARE_ACCESS and its settings; a half-configured flag stops startup. */
function parseCloudflareAccess(env: NodeJS.ProcessEnv): CloudflareAccessConfig | null {
  if (!bool('LANESIGNAL_CLOUDFLARE_ACCESS', env.LANESIGNAL_CLOUDFLARE_ACCESS, false)) return null;
  const raw = env.LANESIGNAL_CF_ACCESS_TEAM_DOMAIN?.trim();
  if (!raw) throw new Error('LANESIGNAL_CLOUDFLARE_ACCESS needs LANESIGNAL_CF_ACCESS_TEAM_DOMAIN (e.g. myteam.cloudflareaccess.com)');
  let teamDomain: string;
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (url.protocol !== 'https:' || (url.pathname !== '/' && url.pathname !== '') || url.search) throw new Error();
    teamDomain = url.origin;
  } catch {
    throw new Error(`LANESIGNAL_CF_ACCESS_TEAM_DOMAIN must be an https host like myteam.cloudflareaccess.com, got "${raw}"`);
  }
  const audiences = list(env.LANESIGNAL_CF_ACCESS_AUD) ?? [];
  if (!audiences.length) {
    throw new Error("LANESIGNAL_CLOUDFLARE_ACCESS needs LANESIGNAL_CF_ACCESS_AUD: the Access application's Application Audience (AUD) tag");
  }
  return {
    teamDomain,
    audiences,
    createAccounts: bool('LANESIGNAL_CF_ACCESS_CREATE_ACCOUNTS', env.LANESIGNAL_CF_ACCESS_CREATE_ACCOUNTS, false),
  };
}

/** LANESIGNAL_OIDC_* (on when the issuer is set); a half-configured provider stops startup. */
function parseOidc(env: NodeJS.ProcessEnv, publicUrl: string | null): OidcConfig | null {
  const raw = env.LANESIGNAL_OIDC_ISSUER?.trim();
  if (!raw) {
    if (env.LANESIGNAL_PASSWORD_FAILOVER_KEY?.trim()) {
      throw new Error('LANESIGNAL_PASSWORD_FAILOVER_KEY needs LANESIGNAL_OIDC_ISSUER: without a provider, nobody could sign in');
    }
    return null;
  }
  let issuer: string;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.search || url.hash) throw new Error();
    issuer = url.toString().replace(/\/+$/, '');
  } catch {
    throw new Error(`LANESIGNAL_OIDC_ISSUER must be an https URL, got "${raw}"`);
  }
  const clientId = env.LANESIGNAL_OIDC_CLIENT_ID?.trim();
  const clientSecret = env.LANESIGNAL_OIDC_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error('LANESIGNAL_OIDC_ISSUER needs LANESIGNAL_OIDC_CLIENT_ID and LANESIGNAL_OIDC_CLIENT_SECRET');
  let base: URL;
  try {
    base = new URL(publicUrl ?? '');
    if (base.protocol !== 'https:') throw new Error();
  } catch {
    throw new Error('LANESIGNAL_OIDC_ISSUER needs LANESIGNAL_PUBLIC_URL (https): the provider sends people back to <public URL>/api/oidc/callback');
  }
  const scopes = (env.LANESIGNAL_OIDC_SCOPES?.trim() || 'openid email profile').split(/[\s,]+/).filter(Boolean);
  if (!scopes.includes('openid')) scopes.unshift('openid');
  return {
    issuer,
    clientId,
    clientSecret,
    label: env.LANESIGNAL_OIDC_LABEL?.trim() || 'Cloudflare',
    scopes,
    createAccounts: bool('LANESIGNAL_OIDC_CREATE_ACCOUNTS', env.LANESIGNAL_OIDC_CREATE_ACCOUNTS, false),
    requireVerifiedEmail: bool('LANESIGNAL_OIDC_REQUIRE_VERIFIED_EMAIL', env.LANESIGNAL_OIDC_REQUIRE_VERIFIED_EMAIL, true),
    recheckMinutes: int('LANESIGNAL_OIDC_RECHECK_MINUTES', env.LANESIGNAL_OIDC_RECHECK_MINUTES, 15, 1, 1440),
    redirectUri: `${base.origin}/api/oidc/callback`,
  };
}

function parseFailoverKey(v: string | undefined): string | null {
  const key = v?.trim();
  if (!key) return null;
  if (key.length < 16) throw new Error('LANESIGNAL_PASSWORD_FAILOVER_KEY must be at least 16 characters');
  if (!/^[A-Za-z0-9._~-]+$/.test(key)) throw new Error('LANESIGNAL_PASSWORD_FAILOVER_KEY may only use letters, digits and . _ ~ - (it goes in a URL)');
  return key;
}

/** "AA:BB:…" SHA-256 certificate fingerprints (colons optional); anything else stops startup. */
function parseFingerprints(v: string | undefined): string[] {
  return (list(v) ?? []).map((f) => {
    const hex = f.replace(/:/g, '').toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(hex)) throw new Error(`LANESIGNAL_ANDROID_CERT_SHA256 entries must be SHA-256 fingerprints, got "${f}"`);
    return hex.match(/../g)!.join(':');
  });
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

  // Ticket system names are lower-case wherever they appear ("Redmine" configures "redmine").
  const ticketTemplates = Object.fromEntries(
    Object.entries(parseTemplates(env.LANESIGNAL_TICKET_TEMPLATES) ?? file.ticketTemplates ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const notifyOn = new Set(
    (list(env.LANESIGNAL_NOTIFY_ON) ?? file.notifyOn ?? ['escalation', 'notice']).filter(
      (n): n is 'escalation' | 'notice' | 'blocked' | 'completed' =>
        n === 'escalation' || n === 'notice' || n === 'blocked' || n === 'completed',
    ),
  );

  const publicUrl = env.LANESIGNAL_PUBLIC_URL ?? file.publicUrl ?? null;
  return {
    name: env.LANESIGNAL_NAME ?? file.name ?? 'LaneSignal',
    host: env.HOST ?? '0.0.0.0',
    port: int('PORT', env.PORT, 8080, 1, 65535),
    dataDir,
    publicUrl,
    trustProxy: parseTrustProxy(env.LANESIGNAL_TRUST_PROXY),
    corsOrigins: list(env.LANESIGNAL_CORS_ORIGINS) ?? file.corsOrigins ?? DEFAULT_CORS,
    tokens,
    authSecret: env.LANESIGNAL_AUTH_SECRET ?? null,
    signInRateLimit: {
      max: int('LANESIGNAL_SIGNIN_RATE_MAX', env.LANESIGNAL_SIGNIN_RATE_MAX, 5, 1, 10_000),
      windowSeconds: int('LANESIGNAL_SIGNIN_RATE_WINDOW', env.LANESIGNAL_SIGNIN_RATE_WINDOW, 60, 1, 86_400),
    },
    sessionDays: int('LANESIGNAL_SESSION_DAYS', env.LANESIGNAL_SESSION_DAYS, 90, 1, 3650),
    groupLabel: env.LANESIGNAL_GROUP_LABEL ?? file.groupLabel ?? 'Group',
    ticketTemplates,
    defaultTicketSystem:
      (env.LANESIGNAL_TICKET_DEFAULT ?? file.defaultTicketSystem)?.toLowerCase() ?? Object.keys(ticketTemplates)[0] ?? null,
    staleMinutes: int('LANESIGNAL_STALE_MINUTES', env.LANESIGNAL_STALE_MINUTES ?? file.staleMinutes, 30, 0, 100_000),
    attachmentMaxBytes: int('LANESIGNAL_ATTACHMENT_MAX_MB', env.LANESIGNAL_ATTACHMENT_MAX_MB, 5, 1, 50) * 1024 * 1024,
    attachmentsPerItem: int('LANESIGNAL_ATTACHMENTS_PER_ITEM', env.LANESIGNAL_ATTACHMENTS_PER_ITEM, 5, 1, 20),
    notifyOn,
    fcmServiceAccountFile: env.LANESIGNAL_FCM_SERVICE_ACCOUNT_FILE ?? file.fcmServiceAccountFile ?? null,
    ntfyUrl: env.LANESIGNAL_NTFY_URL ?? file.ntfyUrl ?? null,
    ntfyToken: env.LANESIGNAL_NTFY_TOKEN ?? file.ntfyToken ?? null,
    ntfyOpen: oneOf('LANESIGNAL_NTFY_OPEN', env.LANESIGNAL_NTFY_OPEN, ['app', 'browser'] as const, 'app'),
    eventRetention: int('LANESIGNAL_EVENT_RETENTION', env.LANESIGNAL_EVENT_RETENTION ?? file.eventRetention, 200, 1, 100_000),
    decisions: bool('LANESIGNAL_DECISIONS', env.LANESIGNAL_DECISIONS, true),
    requirements: bool('LANESIGNAL_REQUIREMENTS', env.LANESIGNAL_REQUIREMENTS, true),
    trmnlHosts: [...TRMNL_HOSTS, ...(list(env.LANESIGNAL_TRMNL_HOSTS) ?? []).map((h) => h.toLowerCase())],
    cloudflareAccess: parseCloudflareAccess(env),
    oidc: parseOidc(env, publicUrl),
    passwordFailoverKey: parseFailoverKey(env.LANESIGNAL_PASSWORD_FAILOVER_KEY),
    androidCertFingerprints: parseFingerprints(env.LANESIGNAL_ANDROID_CERT_SHA256),
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
