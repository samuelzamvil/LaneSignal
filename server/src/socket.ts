import { createHash } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { ZodError } from 'zod';
import { accessFor, digestWait, ownerOf, pub, waitScopeFor } from './access.ts';
import type { AuthOptions, AuthResult } from './auth.ts';
import { log } from './log.ts';
import * as s from './schemas.ts';
import { NotFoundError, projectOf, ValidationError, type Store, type WaitResult, type WaitScope } from './store.ts';
import type { StreamEvent } from './types.ts';

/** Where agents (the relay) hold their socket. */
export const SOCKET_PATH = '/api/agent/socket';

/** Application close codes: Node's WebSocket client can't see an HTTP status on a refused upgrade, so these carry the reason. */
export const CLOSE = {
  /** The query is malformed (a client bug): don't retry as is. */
  badRequest: 4400,
  /** Not authorized, or the credential was revoked. */
  unauthorized: 4401,
  /** Not the group's overseer, or the wrong role. */
  forbidden: 4403,
  /** Unknown or removed group (or project). */
  notFound: 4404,
  /** Another overseer took the group over. */
  takenOver: 4409,
  /** The key's access changed (projects): reconnect at once. */
  accessChanged: 4100,
  /** The server is restarting. */
  restarting: 1012,
  /** Something went wrong on the server. */
  internal: 1011,
} as const;

/** Largest frame a client may send: it only ever sends `{"type":"armed","armed":…}`. */
const MAX_PAYLOAD = 16 * 1024;
/** Items a connection remembers having sent, so a long-lived one doesn't grow without bound. */
const MAX_REMEMBERED = 5000;
/** How long a closed (or refused) socket gets to finish the close handshake before it's cut off. */
const CLOSE_GRACE_MS = 2000;
/** Bursts of changes (a ticket switch emits several) make one check. */
const DEBOUNCE_MS = 50;

export interface AgentSocketOptions {
  store: Store;
  authenticate: (req: IncomingMessage, opts: AuthOptions) => Promise<AuthResult>;
  /** Answering in LaneSignal: off, the socket doesn't exist (404). */
  decisions: boolean;
  /** A protocol ping and an application `ping` frame this often. */
  pingMs: number;
  /** Pings in a row left unanswered before the connection is dropped. */
  missedPings: number;
  /** Fires when any project membership changes: open sockets close (4100) so access is worked out again. */
  membershipChanges: { on(event: 'changed', fn: () => void): unknown; off(event: 'changed', fn: () => void): unknown };
}

type Item = ReturnType<typeof digestWait>['items'][number];

/**
 * The digest's items, each with what makes it the same one again, or null for kinds a check reports once (`closed`,
 * `lane_removed`, `ticket_moved`, `reopen_*`: each check starts where the last one ended, so they never come twice).
 * Decisions, replies and group notes are listed on every check until handled, so the connection remembers those it
 * sent: a decision by its code and words, a reply by the owner's last message (the same words again are a new
 * reply), a note by its id. Keys are hashed, to keep what a long-lived connection remembers small.
 */
function keyed(w: WaitResult, items: Item[]): [Item, string | null][] {
  const replies = w.replies.map((r) => r.messages.at(-1)?.id ?? null);
  let reply = 0;
  return items.map((i) => {
    let key: unknown[] | null = null;
    if (i.kind === 'decided') key = [i.kind, 'code' in i ? i.code : null, i.text];
    else if (i.kind === 'reply') key = [i.kind, 'code' in i ? i.code : null, replies[reply++]];
    else if (i.kind === 'group_note') key = [i.kind, 'id' in i ? i.id : null];
    return [i, key && createHash('sha256').update(JSON.stringify(key)).digest('base64url').slice(0, 22)];
  });
}

/** Whether an upgrade asks for a WebSocket (other upgrades, such as `h2c`, are plain requests to the app). */
const isWebSocket = (req: IncomingMessage) =>
  (req.headers.upgrade ?? '')
    .split(',')
    .some((p) => p.trim().toLowerCase() === 'websocket');

/**
 * Hands a non-WebSocket upgrade (`Upgrade: h2c` from curl --http2 or Java's HttpClient) back to the HTTP server as the
 * plain request it also is: the request is written again without its upgrade, ahead of what the client sent after it
 * (a body, further requests), and the server parses the connection anew, keep-alive and all.
 */
function handBack(server: Server, req: IncomingMessage, socket: Duplex, head: Buffer) {
  const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!;
    const value = req.rawHeaders[i + 1]!;
    const lower = name.toLowerCase();
    if (lower === 'upgrade') continue;
    if (lower === 'connection') {
      const kept = value
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t && t.toLowerCase() !== 'upgrade');
      if (kept.length) lines.push(`${name}: ${kept.join(', ')}`);
      continue;
    }
    lines.push(`${name}: ${value}`);
  }
  socket.unshift(Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'), head]));
  server.emit('connection', socket);
}

/** Answers an upgrade the server doesn't serve: 404, and the socket goes. */
function refuse(socket: Duplex) {
  if (socket.destroyed) return;
  socket.once('finish', () => socket.destroy());
  socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
}

/**
 * The agent socket (GET /api/agent/socket): an overseer session holds it to hear what needs it in its group, as the
 * digest items `wait_for_decisions` returns. The upgrade is accepted from any request on the path; refusals are
 * close codes (see CLOSE). Returns the HTTP server's `upgrade` handler and `closeAll` for shutdown.
 */
export function createAgentSockets(opts: AgentSocketOptions) {
  const { store } = opts;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, clientTracking: false });
  /** Open sockets, with how each one ends (a served one lets go of its session, lanes and listeners at once). */
  const open = new Map<WebSocket, (code: number, reason: string) => void>();
  /** Upgrades still authenticating: shutdown cuts them off with the rest. */
  const upgrading = new Set<Duplex>();
  let closing = false;

  /** Closes a socket and cuts it off if the client doesn't finish the close handshake in time. */
  function closeSocket(ws: WebSocket, code: number, reason: string) {
    if (ws.readyState === ws.OPEN) {
      // A close reason is at most 123 bytes.
      ws.close(code, Buffer.from(reason).subarray(0, 120).toString().replace(/\uFFFD+$/, ''));
    }
    setTimeout(() => ws.terminate(), CLOSE_GRACE_MS).unref();
  }

  function upgrade(this: Server, req: IncomingMessage, socket: Duplex, head: Buffer) {
    if (!isWebSocket(req)) {
      handBack(this, req, socket, head);
      return;
    }
    const url = req.url ?? '';
    const q = url.indexOf('?');
    const path = q < 0 ? url : url.slice(0, q);
    if (!opts.decisions || path !== SOCKET_PATH || req.method !== 'GET') {
      refuse(socket);
      return;
    }
    // Until ws takes the socket over, nothing else listens for its errors (a client resetting mid-handshake).
    const onError = () => socket.destroy();
    socket.on('error', onError);
    upgrading.add(socket);
    void opts
      .authenticate(req, { roles: ['agent'], credentialRequired: true })
      .then(
        (auth) => auth,
        (err: unknown) => {
          log.error('agent socket: authentication failed', { error: String(err) });
          return null;
        },
      )
      .then((auth) => {
        upgrading.delete(socket);
        socket.off('error', onError);
        // The client hung up while it was being authenticated.
        if (socket.destroyed) return;
        wss.handleUpgrade(req, socket, head, (ws) => {
          open.set(ws, (code, reason) => closeSocket(ws, code, reason));
          ws.on('close', () => open.delete(ws));
          // ws reports protocol errors (an oversized frame) after closing the socket with the matching code.
          ws.on('error', () => {});
          if (closing) return closeSocket(ws, CLOSE.restarting, 'server restarting');
          if (!auth) return closeSocket(ws, CLOSE.internal, 'internal error');
          serve(ws, req, auth);
        });
      });
  }

  function serve(ws: WebSocket, req: IncomingMessage, auth: AuthResult) {
    let ended = false;
    /** What to undo when the connection ends, each once, newest first. */
    const cleanups: (() => void)[] = [];
    const cleanup = () => {
      for (const fn of cleanups.splice(0).reverse()) {
        try {
          fn();
        } catch (err) {
          log.error('agent socket: cleanup failed', { error: String(err) });
        }
      }
    };
    // Ending doesn't wait for the close handshake: presence, lanes and listeners are let go at once.
    const close = (code: number, reason: string) => {
      if (ended) return;
      ended = true;
      cleanup();
      closeSocket(ws, code, reason);
    };
    ws.on('close', () => {
      ended = true;
      cleanup();
    });
    if (open.has(ws)) open.set(ws, close);
    if (!auth.ok) return close(auth.status === 401 ? CLOSE.unauthorized : CLOSE.forbidden, auth.error);
    const principal = auth.principal;

    const target = req.url ?? '';
    const qs = target.indexOf('?');
    let query: ReturnType<typeof s.socketQuery.parse>;
    let scope: WaitScope;
    try {
      query = s.socketQuery.parse(Object.fromEntries(new URLSearchParams(qs < 0 ? '' : target.slice(qs + 1))));
      const parsed = s.waitScope.parse({ groupId: query.group, since: query.since });
      scope = { ...waitScopeFor(accessFor(store, principal), parsed, query.project), mode: 'digest' };
    } catch (err) {
      if (err instanceof NotFoundError) return close(CLOSE.notFound, err.message);
      if (err instanceof ZodError) return close(CLOSE.badRequest, err.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`).join('; '));
      if (err instanceof ValidationError) return close(CLOSE.badRequest, err.message);
      log.error('agent socket: bad scope', { error: String(err) });
      return close(CLOSE.internal, 'internal error');
    }
    const groupId = scope.groupId!;
    const session = query.session;
    const key = ownerOf(principal);
    // Only the group's overseer counts, or any agent key while the group has none (as for waits).
    const owner = store.groupOwner(groupId);
    if (owner === undefined) return close(CLOSE.notFound, `Group "${query.group}" not found`);
    if (owner !== null && owner !== key) return close(CLOSE.forbidden, "This key isn't the group's overseer");

    // Everything from `since` on connect, then each check from the last one's `checkedAt`. Notes the key was handed
    // before the client's `since` come marked `seen`, as on a wait; the socket itself never hands notes over.
    let since: string | undefined = scope.since;
    const notesSince = scope.since ?? null;
    const sent = new Set<string>();
    const held = new Set<string>();
    const releases: (() => void)[] = [];
    let holding = false;
    cleanups.push(store.presence.attach(groupId, key, session, 'socket'));
    cleanups.push(() => {
      for (const r of releases.splice(0)) r();
    });

    const send = (frame: object) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    };

    /** Lanes show "agent waiting" while the session is listening (not while it's not responding). */
    const syncHolding = () => {
      const listening = store.presence.stateOf(groupId, key, session) === 'listening';
      if (listening === holding) return;
      holding = listening;
      if (!listening) {
        for (const r of releases.splice(0)) r();
        held.clear();
      }
    };
    const hold = (laneIds: Iterable<string | null>) => {
      if (!holding) return;
      const fresh = [...laneIds].filter((id): id is string => id !== null && !held.has(id));
      if (!fresh.length) return;
      for (const id of fresh) held.add(id);
      releases.push(store.holdLanes(fresh));
    };

    /** Works out what's pending and sends what this connection hasn't sent yet (on connect: hello, then items, even none). */
    const check = (first = false) => {
      if (ended) return;
      const visible = accessFor(store, principal).projects;
      if (!visible.includes(projectOf(groupId))) return close(CLOSE.accessChanged, 'access changed');
      const value = store.decisionsFor({ ...scope, since, notesSince });
      since = value.checkedAt;
      syncHolding();
      hold(value.open.map((o) => o.laneId));
      const visibleWait = pub.wait(value, visible);
      const digest = digestWait(visibleWait, visible.length > 1);
      const fresh: Item[] = [];
      for (const [item, k] of keyed(visibleWait, digest.items)) {
        if (k !== null) {
          if (sent.has(k)) continue;
          sent.add(k);
          if (sent.size > MAX_REMEMBERED) sent.delete(sent.values().next().value!);
        }
        fresh.push(item);
      }
      if (first) {
        send({
          type: 'hello',
          group: query.group,
          session,
          checkedAt: value.checkedAt,
          pingSeconds: opts.pingMs / 1000,
          missedPings: opts.missedPings,
        });
      }
      if (!fresh.length && !first) return;
      const counts = digest.counts ?? { open: 0, decidedUnacknowledged: 0, waitingOnYou: 0 };
      send({ type: 'items', items: fresh, counts, checkedAt: value.checkedAt });
    };
    const safeCheck = () => {
      try {
        check();
      } catch (err) {
        if (err instanceof NotFoundError) return close(CLOSE.notFound, err.message);
        log.error('agent socket: check failed', { error: String(err) });
        close(CLOSE.internal, 'internal error');
      }
    };

    let pending: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (pending || ended) return;
      pending = setTimeout(() => {
        pending = null;
        safeCheck();
      }, DEBOUNCE_MS);
    };
    cleanups.push(() => {
      if (pending) clearTimeout(pending);
      pending = null;
    });
    const project = projectOf(groupId);
    const onChange = (e: StreamEvent) => {
      if (ended) return;
      if (e.type === 'group_deleted' && e.id === groupId) return close(CLOSE.notFound, 'Group removed');
      if (e.type === 'group' && e.group.id === groupId) {
        const now = store.groupOwner(groupId);
        if (now === undefined) return close(CLOSE.notFound, 'Group removed');
        if (now !== null && now !== key) return close(CLOSE.takenOver, 'Another overseer took the group over');
        // The session's own state may have changed (not responding, or back): lanes follow it, and when it's
        // listening again the next check holds the lanes with open questions anew.
        const was = holding;
        syncHolding();
        if (!was && holding) soon();
        return;
      }
      // Only what can concern this group: its notes and epics, and questions, lanes and tickets in its project.
      const here =
        (e.type === 'group_message' && e.message.from === 'owner' && e.group === groupId) ||
        (e.type === 'epic' && e.epic.group === groupId) ||
        (e.type === 'escalation' && e.escalation.project === project) ||
        (e.type === 'lane_deleted' && e.project === project) ||
        (e.type === 'ticket' && e.ticket.project === project);
      if (here) soon();
    };
    const onMembership = () => close(CLOSE.accessChanged, 'access changed');
    store.events.on('change', onChange);
    cleanups.push(() => store.events.off('change', onChange));
    opts.membershipChanges.on('changed', onMembership);
    cleanups.push(() => opts.membershipChanges.off('changed', onMembership));
    cleanups.push(auth.watchRevocation(() => close(CLOSE.unauthorized, 'credential revoked')));
    // Revoked while the upgrade was being handled (after the credential was checked, before the watch began).
    const recheck = () =>
      void auth.stillValid().then(
        (ok) => ok || close(CLOSE.unauthorized, 'credential revoked'),
        () => {},
      );
    recheck();

    let missed = 0;
    const heartbeat = setInterval(() => {
      // The client's stack answers protocol pings by itself: silence means the connection (or the client) is gone.
      if (missed >= opts.missedPings) {
        ws.terminate();
        return;
      }
      missed++;
      ws.ping();
      send({ type: 'ping' });
      recheck();
    }, opts.pingMs);
    cleanups.push(() => clearInterval(heartbeat));

    ws.on('pong', () => {
      missed = 0;
    });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (ended) return;
      if (msg && typeof msg === 'object' && (msg as { type?: unknown }).type === 'armed' && typeof (msg as { armed?: unknown }).armed === 'boolean') {
        store.presence.setArmed(groupId, key, session, (msg as { armed: boolean }).armed);
      }
    });

    try {
      check(true);
    } catch (err) {
      if (err instanceof NotFoundError) return close(CLOSE.notFound, err.message);
      log.error('agent socket: first check failed', { error: String(err) });
      close(CLOSE.internal, 'internal error');
    }
  }

  /**
   * Shutdown: every socket closes with 1012 (the client reconnects), and upgrades still authenticating get the same
   * once they're through. Whatever is left after a moment is cut off, so nothing holds `server.close()`.
   */
  function closeAll() {
    closing = true;
    for (const end of [...open.values()]) end(CLOSE.restarting, 'server restarting');
    setTimeout(() => {
      for (const ws of open.keys()) ws.terminate();
      for (const socket of upgrading) socket.destroy();
    }, CLOSE_GRACE_MS).unref();
  }

  return { upgrade, closeAll };
}
