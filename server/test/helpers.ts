import type { AddressInfo } from 'node:net';
import { createAccounts } from '../src/accounts.ts';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { ticketResolver } from '../src/tickets.ts';

export const AGENT = 'agent-token-0123456789';
export const REVIEWER = 'review-token-0123456789';
export const ALICE = 'alice-token-0123456789';

/** A server on a random port with static tokens: agents "overseer" and "reviewer", human "alice". */
export async function startServer(env: Record<string, string> = {}) {
  const config = loadConfig({
    LANESIGNAL_DATA_DIR: '/nonexistent-unused',
    LANESIGNAL_CONFIG: '/nonexistent.json',
    LANESIGNAL_AGENT_TOKENS: `overseer:${AGENT},reviewer:${REVIEWER}`,
    LANESIGNAL_HUMAN_TOKENS: `alice:${ALICE}`,
    LANESIGNAL_AUTH_SECRET: 'test-secret-0123456789-0123456789-0123',
    LANESIGNAL_TICKET_TEMPLATES: 'gh=https://github.com/o/r/issues/{id}',
    ...env,
  });
  const store = new Store({ path: ':memory:', resolveTicketUrl: ticketResolver(config.ticketTemplates, config.defaultTicketSystem) });
  const accounts = await createAccounts(config, ':memory:');
  const server = createApp({ config, store, accounts, push: { fcm: false, ntfy: false } }).listen(0);
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
    return { isError: !!msg.result.isError, text: first, value, content: msg.result.content as { text: string }[] };
  }

  return {
    base,
    store,
    config,
    call,
    tool,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}
