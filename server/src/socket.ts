import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { ZodError } from 'zod';
import { accessFor, digestWait, ownerOf, pub, waitScopeFor } from './access.ts';
import type { AuthOptions, AuthResult } from './auth.ts';
import { log } from './log.ts';
import * as s from './schemas.ts';
import { NotFoundError, projectOf, ValidationError, type Store, type WaitScope } from './store.ts';
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

/** What makes an item the same one again: its kind, what it's about and what it says (not whether it was `seen`). */
const itemKey = (i: Item) => JSON.stringify([i.kind, 'code' in i ? i.code : null, 'id' in i ? i.id : null, i.text]);

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
  const open = new Set<WebSocket>();
  let closing = false;

  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
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
        socket.off('error', onError);
        if (socket.destroyed) return;
        wss.handleUpgrade(req, socket, head, (ws) => {
          open.add(ws);
          ws.on('close', () => open.delete(ws));
          // ws reports protocol errors (an oversized frame) after closing the socket with the matching code.
          ws.on('error', () => {});
          if (closing) return ws.close(CLOSE.restarting, 'server restarting');
          if (!auth) return ws.close(CLOSE.internal, 'internal error');
          serve(ws, req, auth);
        });
      });
  }

  function serve(ws: WebSocket, req: IncomingMessage, auth: AuthResult) {
    let ended = false;
    const close = (code: number, reason: string) => {
      ended = true;
      if (ws.readyState !== ws.OPEN) return;
      // A close reason is at most 123 bytes.
      ws.close(code, Buffer.from(reason).subarray(0, 120).toString().replace(/�+$/, ''));
    };
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
    const release = store.presence.attach(groupId, key, session, 'socket');

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
      const digest = digestWait(pub.wait(value, visible), visible.length > 1);
      const fresh = digest.items.filter((i) => !sent.has(itemKey(i)));
      if (first) send({ type: 'hello', group: query.group, session, checkedAt: value.checkedAt });
      if (!fresh.length && !first) return;
      for (const i of fresh) {
        sent.add(itemKey(i));
        if (sent.size > MAX_REMEMBERED) sent.delete(sent.values().next().value!);
      }
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

    // Bursts of changes (a ticket switch emits several) make one check.
    let pending: ReturnType<typeof setImmediate> | null = null;
    const soon = () => {
      if (pending || ended) return;
      pending = setImmediate(() => {
        pending = null;
        safeCheck();
      });
    };
    const onChange = (e: StreamEvent) => {
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
      const note = e.type === 'group_message' && e.message.from === 'owner' && e.group === groupId;
      const epicHere = e.type === 'epic' && e.epic.group === groupId;
      if (e.type === 'escalation' || e.type === 'lane_deleted' || e.type === 'ticket' || epicHere || note) soon();
    };
    const onMembership = () => close(CLOSE.accessChanged, 'access changed');
    const unwatch = auth.watchRevocation(() => close(CLOSE.unauthorized, 'credential revoked'));

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
      void auth.stillValid().then(
        (ok) => ok || close(CLOSE.unauthorized, 'credential revoked'),
        () => {},
      );
    }, opts.pingMs);

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
      if (msg && typeof msg === 'object' && (msg as { type?: unknown }).type === 'armed' && typeof (msg as { armed?: unknown }).armed === 'boolean') {
        store.presence.setArmed(groupId, key, session, (msg as { armed: boolean }).armed);
      }
    });
    ws.on('close', () => {
      ended = true;
      clearInterval(heartbeat);
      if (pending) clearImmediate(pending);
      store.events.off('change', onChange);
      opts.membershipChanges.off('changed', onMembership);
      unwatch();
      for (const r of releases.splice(0)) r();
      release();
    });
    store.events.on('change', onChange);
    opts.membershipChanges.on('changed', onMembership);

    try {
      check(true);
    } catch (err) {
      if (err instanceof NotFoundError) return close(CLOSE.notFound, err.message);
      log.error('agent socket: first check failed', { error: String(err) });
      close(CLOSE.internal, 'internal error');
    }
  }

  /** Shutdown: every socket closes with 1012 (the client reconnects); stragglers are cut off after a moment. */
  function closeAll() {
    closing = true;
    for (const ws of open) ws.close(CLOSE.restarting, 'server restarting');
    if (open.size) setTimeout(() => {
      for (const ws of open) ws.terminate();
    }, 2000).unref();
  }

  return { upgrade, closeAll };
}
