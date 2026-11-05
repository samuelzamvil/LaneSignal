import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createAccounts } from '../src/accounts.ts';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { ticketRefs, ticketResolver } from '../src/tickets.ts';
import { TrmnlPusher, type TrmnlOptions } from '../src/trmnl.ts';

export const AGENT = 'agent-token-0123456789';
export const REVIEWER = 'review-token-0123456789';
export const ALICE = 'alice-token-0123456789';

/**
 * A server on a random port with static tokens: agents "overseer" and "reviewer", human "alice".
 * With `trmnl`, it pushes TRMNL screens through the given (fake) fetch.
 */
export async function startServer(
  env: Record<string, string> = {},
  opts: {
    trmnl?: TrmnlOptions;
    presence?: { quietMs: number; offlineMs: number };
    /** The agent socket's heartbeat (default: the config's, 20s and 2 missed pings). */
    agentSocket?: { pingMs?: number; missedPings?: number };
  } = {},
) {
  const config = loadConfig({
    LANESIGNAL_DATA_DIR: '/nonexistent-unused',
    LANESIGNAL_CONFIG: '/nonexistent.json',
    LANESIGNAL_AGENT_TOKENS: `overseer:${AGENT},reviewer:${REVIEWER}`,
    LANESIGNAL_HUMAN_TOKENS: `alice:${ALICE}`,
    LANESIGNAL_AUTH_SECRET: 'test-secret-0123456789-0123456789-0123',
    LANESIGNAL_TICKET_TEMPLATES: 'gh=https://github.com/o/r/issues/{id}',
    ...env,
  });
  const store = new Store({
    path: ':memory:',
    resolveTicketUrl: ticketResolver(config.ticketTemplates, config.defaultTicketSystem),
    ticketRefs: ticketRefs(config.ticketTemplates, config.defaultTicketSystem),
    // Short timers keep tests fast: the quiet window (lanes' "agent waiting" too), then disconnected.
    waitGraceMs: opts.presence?.quietMs ?? 50,
    presenceOfflineMs: opts.presence?.offlineMs ?? 150,
    attachmentsPerItem: config.attachmentsPerItem,
    decisions: config.decisions,
  });
  // Every lane is in a group: tests publish theirs in "main", here in each project they use.
  for (const project of ['default', 'shop']) store.upsertGroup(`${project}/main`, { name: 'main' }, 'overseer');
  const accounts = await createAccounts(config, ':memory:');
  const skillFile = fileURLToPath(new URL('../../skills/lanesignal/SKILL.md', import.meta.url));
  const trmnl = opts.trmnl ? new TrmnlPusher(store, opts.trmnl).start() : undefined;
  const trmnlDir = fileURLToPath(new URL('../../integrations/trmnl', import.meta.url));
  const app = createApp({ config, store, accounts, push: { fcm: false, ntfy: false }, skillFile, trmnl, trmnlDir, agentSocket: opts.agentSocket });
  const server = app.listen(0);
  server.on('upgrade', app.locals.upgrade);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(method: string, path: string, token: string | null, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json, headers: res.headers };
  }

  /**
   * Publishes a lane (as an agent must before escalating on it), leaving an existing one as is.
   * Registers its group first (`group`, or "main" for a new lane). A new lane holds a ticket named after it (`ticket`
   * overrides; null for none), so it works and its questions block it.
   */
  async function publish(laneId: string, opts: { token?: string; project?: string; group?: string; ticket?: string | null } = {}) {
    const token = opts.token ?? AGENT;
    const qs = opts.project ? `?project=${encodeURIComponent(opts.project)}` : '';
    const existing = await call('GET', `/api/lanes/${encodeURIComponent(laneId)}${qs}`, token);
    if (!opts.group && existing.status === 200) return;
    // Every lane is in a group: a new one without one named goes in "main".
    opts = { ...opts, group: opts.group ?? 'main' };
    await call('PUT', `/api/groups/${encodeURIComponent(opts.group!)}${qs}`, token, {});
    const ticket = existing.status === 200 ? {} : { ticket: opts.ticket === undefined ? laneId : opts.ticket };
    const res = await call('PUT', `/api/lanes/${encodeURIComponent(laneId)}${qs}`, token, { ...(opts.group ? { group: opts.group } : {}), ...ticket });
    if (res.status !== 200) throw new Error(`publishing lane ${laneId}: ${res.status} ${JSON.stringify(res.body)}`);
  }

  /** One MCP tools/call; returns the parsed JSON of the first text block, or the error text. */
  async function tool(token: string, name: string, args: Record<string, unknown>) {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const text = await res.text();
    // The SSE response may carry notifications before the result.
    const messages = text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)));
    const msg = messages.find((m) => 'result' in m || 'error' in m) ?? JSON.parse(text);
    if (msg.error) return { isError: true, text: msg.error.message as string, value: null };
    const first = msg.result.content[0].text as string;
    let value: any = null;
    try {
      value = JSON.parse(first);
    } catch {
      value = null;
    }
    return { isError: !!msg.result.isError, text: first, value, content: msg.result.content as { type: string; text?: string; data?: string; mimeType?: string }[] };
  }

  return {
    base,
    store,
    config,
    call,
    tool,
    publish,
    /** Closes agent sockets with 1012, as shutdown does. */
    closeSockets: () => app.locals.closeSockets() as void,
    close() {
      trmnl?.stop();
      app.locals.closeSockets();
      server.closeAllConnections();
      server.close();
    },
  };
}
