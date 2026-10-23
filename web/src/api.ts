import { Capacitor } from '@capacitor/core';
import type {
  Escalation,
  Group,
  Lane,
  LaneEvent,
  Principal,
  PublicConfig,
  Requirement,
  RequirementStatus,
  StreamEvent,
} from '../../server/src/types.ts';

export type { Escalation, Group, Lane, LaneEvent, Principal, PublicConfig, Requirement, RequirementStatus, StreamEvent };
export type { LaneStatus, Link, Position } from '../../server/src/types.ts';

export const isNative = Capacitor.isNativePlatform();

export interface Connection {
  /** Empty string = same origin (browser served by the LaneSignal server). */
  server: string;
  /** An account session token, or a static access token from the server config. */
  token: string;
  kind?: 'session' | 'token';
}

export interface AgentKey {
  id: string;
  name: string | null;
  /** First characters of the key, for recognising it. */
  start: string | null;
  createdAt: string;
  lastRequest: string | null;
  /** role "human" marks a personal key that answers escalations as its owner. */
  metadata?: { role?: string } | null;
}

export interface Person {
  id: string;
  name: string;
  email: string;
  role: string | null;
  banned: boolean | null;
  createdAt: string;
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
        const body = (await res.json()) as { error?: string; message?: string };
        message = body.error ?? body.message ?? message;
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
    requirements: (f: { q?: string; tags?: string[]; group?: string; statuses?: RequirementStatus[] }) => {
      const p = new URLSearchParams();
      if (f.q) p.set('q', f.q);
      if (f.tags?.length) p.set('tag', f.tags.join(','));
      if (f.group) p.set('group', f.group);
      if (f.statuses?.length) p.set('status', f.statuses.join(','));
      p.set('limit', '200');
      return request<Requirement[]>('GET', `/api/requirements?${p}`);
    },
    requirementTags: () => request<{ tag: string; count: number }[]>('GET', '/api/requirements/tags'),
    editRequirement: (id: string, patch: { requirement?: string; justification?: string; tags?: string[] }) =>
      request<Requirement>('PATCH', `/api/requirements/${encodeURIComponent(id)}`, patch),
    retireRequirement: (id: string) => request<Requirement>('POST', `/api/requirements/${encodeURIComponent(id)}/retire`, {}),
    deleteLane: (id: string) => request<void>('DELETE', `/api/lanes/${encodeURIComponent(id)}`),
    /** `change` replaces the answer on a decided escalation the agent hasn't acknowledged. */
    decide: (id: string, decision: string, note?: string, change = false) =>
      request<Escalation>('POST', `/api/escalations/${id}/decide`, { decision, note: note || null, ...(change ? { change } : {}) }),
    withdraw: (id: string, note?: string) =>
      request<Escalation>('POST', `/api/escalations/${id}/withdraw`, { note: note || null }),
    signOut: () => request<unknown>('POST', '/api/auth/sign-out', {}),
    /** Signs out every other device; returns this device's replacement session token. */
    changePassword: async (currentPassword: string, newPassword: string): Promise<string> => {
      const res = await fetch(`${base}/api/auth/change-password`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword, revokeOtherSessions: true }),
      });
      if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
      const token = res.headers.get('set-auth-token') ?? ((await res.json()) as { token?: string }).token;
      if (!token) throw new ApiError(500, 'Server did not return a new session token');
      return token;
    },

    // Agent keys belong to the signed-in account.
    listKeys: async () => {
      const res = await request<{ apiKeys: AgentKey[] } | AgentKey[]>('GET', '/api/auth/api-key/list');
      return Array.isArray(res) ? res : res.apiKeys;
    },
    createKey: (name: string, role: 'agent' | 'human' = 'agent') =>
      request<AgentKey & { key: string }>('POST', '/api/auth/api-key/create', {
        name,
        ...(role === 'human' ? { metadata: { role: 'human' } } : {}),
      }),
    deleteKey: (keyId: string) => request<unknown>('POST', '/api/auth/api-key/delete', { keyId }),

    // People (admins only).
    listPeople: async () =>
      (await request<{ users: Person[] }>('GET', '/api/auth/admin/list-users?limit=200&sortBy=createdAt')).users,
    addPerson: (p: { name: string; email: string; password: string; admin: boolean }) =>
      request<{ user: Person }>('POST', '/api/auth/admin/create-user', {
        name: p.name,
        email: p.email,
        password: p.password,
        role: p.admin ? 'admin' : 'user',
      }),
    removePerson: (userId: string) => request<unknown>('POST', '/api/auth/admin/remove-user', { userId }),

    /** Downloads an export (zip or CSV) and hands it to the browser as a file. */
    async download(path: string, fallbackName: string) {
      const res = await fetch(base + path, { headers });
      if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },

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

/** Unauthenticated calls used before there is a session. */
export const publicApi = {
  async setupStatus(server: string): Promise<{ needsSetup: boolean }> {
    const res = await fetch(`${server}/api/setup`);
    if (!res.ok) throw new ApiError(res.status, `Server answered ${res.status}`);
    return (await res.json()) as { needsSetup: boolean };
  },

  async setup(server: string, input: { email: string; name: string; password: string; code: string }) {
    const res = await fetch(`${server}/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
  },

  /** Email + password sign-in; returns the bearer session token. */
  async signIn(server: string, email: string, password: string): Promise<string> {
    const res = await fetch(`${server}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
    const token = res.headers.get('set-auth-token') ?? ((await res.json()) as { token?: string }).token;
    if (!token) throw new ApiError(500, 'Server did not return a session token');
    return token;
  },
};

async function errorMessage(res: Response) {
  try {
    const body = (await res.json()) as { error?: string; message?: string; issues?: { message: string }[] };
    return body.issues?.[0]?.message ?? body.error ?? body.message ?? res.statusText;
  } catch {
    return res.statusText;
  }
}
