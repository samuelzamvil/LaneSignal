import { Capacitor } from '@capacitor/core';
import type { Escalation, Group, Lane, LaneEvent, Principal, PublicConfig, StreamEvent } from '../../server/src/types.ts';

export type { Escalation, Group, Lane, LaneEvent, Principal, PublicConfig, StreamEvent };
export type { LaneStatus, Link, Position } from '../../server/src/types.ts';

export const isNative = Capacitor.isNativePlatform();

export interface Connection {
  /** Empty string = same origin (browser served by the LaneSignal server). */
  server: string;
  token: string;
}

const KEY = 'lanesignal.connection';

export function loadConnection(): Connection | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Connection) : null;
  } catch {
    return null;
  }
}

export function saveConnection(c: Connection | null) {
  if (c) localStorage.setItem(KEY, JSON.stringify(c));
  else localStorage.removeItem(KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function normalizeServer(url: string) {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function createClient(conn: Connection) {
  const base = conn.server;
  const headers = { authorization: `Bearer ${conn.token}` };

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(base + path, {
      method,
      headers: body !== undefined ? { ...headers, 'content-type': 'application/json' } : headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let message = res.statusText;
      try {
        message = ((await res.json()) as { error?: string }).error ?? message;
      } catch {
        /* not JSON */
      }
      throw new ApiError(res.status, message);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  return {
    me: () => request<Principal>('GET', '/api/me'),
    config: () => request<PublicConfig>('GET', '/api/config'),
    snapshot: () => request<{ groups: Group[]; lanes: Lane[]; escalations: Escalation[]; serverTime: string }>('GET', '/api/snapshot'),
    laneDetail: (id: string) =>
      request<{ lane: Lane; escalations: Escalation[]; events: LaneEvent[] }>(
        'GET',
        `/api/lanes/${encodeURIComponent(id)}`,
      ),
    escalation: (id: string) => request<Escalation>('GET', `/api/escalations/${encodeURIComponent(id)}`),
    deleteLane: (id: string) => request<void>('DELETE', `/api/lanes/${encodeURIComponent(id)}`),
    decide: (id: string, decision: string, note?: string) =>
      request<Escalation>('POST', `/api/escalations/${id}/decide`, { decision, note: note || null }),
    withdraw: (id: string, note?: string) =>
      request<Escalation>('POST', `/api/escalations/${id}/withdraw`, { note: note || null }),
    registerPush: (token: string) => request<void>('POST', '/api/push/register', { token, platform: 'android' }),
    unregisterPush: (token: string) => request<void>('POST', '/api/push/unregister', { token }),

    /**
     * Reads the SSE stream with fetch (so the token travels in a header, and
     * it works the same in the browser and the Android WebView). `onActivity`
     * fires on every chunk, heartbeats included, for liveness checks.
     * Resolves when the stream ends; rejects on network errors and with an
     * ApiError when the server refuses the stream.
     */
    async stream(
      handlers: { onOpen: () => void; onEvent: (e: StreamEvent) => void; onActivity: () => void },
      signal: AbortSignal,
    ) {
      const res = await fetch(`${base}/api/events`, { headers, signal });
      if (!res.ok || !res.body) throw new ApiError(res.status, 'event stream failed');
      handlers.onOpen();
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      let cr = ''; // a trailing CR may be the first half of a CRLF split across chunks
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        handlers.onActivity();
        let text = cr + value;
        cr = text.endsWith('\r') ? '\r' : '';
        if (cr) text = text.slice(0, -1);
        buffer += text.replace(/\r\n?/g, '\n');
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const data = chunk
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(l.startsWith('data: ') ? 6 : 5))
            .join('\n');
          if (data) handlers.onEvent(JSON.parse(data) as StreamEvent);
        }
      }
    },
  };
}

export type Client = ReturnType<typeof createClient>;
