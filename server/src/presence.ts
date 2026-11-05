import type { GroupPresence, PresenceChange, PresenceReason, PresenceState, PresenceTransport } from './types.ts';

/** Most sessions one group keeps: past it, the one that ended longest ago goes first. */
export const MAX_SESSIONS = 20;

const RANK: Record<PresenceState, number> = { listening: 0, not_responding: 1, reconnecting: 2, disconnected: 3 };

interface Session {
  /** The overseer's full key ("user:<account>:<key name>" or "token:<name>"). */
  key: string;
  name: string;
  transport: PresenceTransport;
  /** Open connections, by attach token: a release whose token is gone (the session ended) does nothing. */
  conns: Set<number>;
  state: Exclude<PresenceState, 'disconnected'>;
  since: string;
  /** When the last connection ended (ms), for the cap: null while connected. */
  endedAt: number | null;
  /** Set when the socket's relay reported that nothing reads its events. */
  unarmedSince: number | null;
  /** The quiet and offline timers of its last ended connection. */
  timers: Set<ReturnType<typeof setTimeout>>;
  /** Turns it not responding once its events went unread for the offline window. */
  unarmedTimer: ReturnType<typeof setTimeout> | null;
}

interface GroupRecord {
  sessions: Map<string, Session>;
  state: PresenceState;
  /** When the group took its current state; null while disconnected and nothing has connected since the start. */
  since: string | null;
}

export interface PresenceOptions {
  /** How long a session stays listening after its last connection ends. */
  quietMs: number;
  /** How long after its last connection ended a session is dropped (and how long unread events make it not responding). */
  offlineMs: number;
  now: () => Date;
  /** A group's sessions changed: `change` is set when the group's own state changed with them. */
  onChange: (groupId: string, change: PresenceChange | null) => void;
}

/**
 * Which of each group's overseer sessions are connected, in memory only (like lanes' "agent waiting"):
 * after a restart every group is disconnected until its overseer comes back.
 */
export class Presence {
  private groups = new Map<string, GroupRecord>();
  private nextToken = 1;
  private closed = false;
  private opts: PresenceOptions;

  constructor(opts: PresenceOptions) {
    this.opts = opts;
  }

  /** The group's presence as clients see it. */
  of(groupId: string): GroupPresence {
    const g = this.groups.get(groupId);
    if (!g) return { state: 'disconnected', since: null, sessions: [] };
    return {
      state: g.state,
      since: g.since,
      sessions: [...g.sessions.values()]
        .sort((a, b) => RANK[a.state] - RANK[b.state] || a.since.localeCompare(b.since))
        .map((s) => ({ id: s.name, transport: s.transport, state: s.state, since: s.since })),
    };
  }

  /**
   * A connection for the session opens; returns its release. Each attach counts once, so a session stays
   * connected until its last connection is released, and a release after the session ended does nothing.
   */
  attach(groupId: string, key: string, name: string, transport: PresenceTransport): () => void {
    if (this.closed) return () => {};
    const token = this.nextToken++;
    this.change(groupId, 'connected', (g) => {
      const id = sessionKey(key, name);
      let s = g.sessions.get(id);
      if (!s) {
        this.makeRoom(g);
        s = { key, name, transport, conns: new Set(), state: 'listening', since: this.iso(), endedAt: null, unarmedSince: null, timers: new Set(), unarmedTimer: null };
        g.sessions.set(id, s);
      }
      this.clearTimers(s);
      s.transport = transport;
      s.conns.add(token);
      s.endedAt = null;
      if (s.state === 'reconnecting') this.setState(s, 'listening');
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(groupId, key, name, token);
    };
  }

  /** A wait that returned at once: the session counts as connected just now, and its quiet window starts. */
  touch(groupId: string, key: string, name: string, transport: PresenceTransport) {
    this.attach(groupId, key, name, transport)();
  }

  /** Whether anything reads the session's events (the socket's relay reports it). Unread for the offline window: not responding. */
  setArmed(groupId: string, key: string, name: string, armed: boolean) {
    const s = this.groups.get(groupId)?.sessions.get(sessionKey(key, name));
    if (!s || this.closed) return;
    if (armed) {
      if (s.unarmedSince === null) return;
      this.clearUnarmed(s);
      this.change(groupId, 'reading', () => s.state === 'not_responding' && this.setState(s, 'listening'));
      return;
    }
    if (s.unarmedSince !== null || !s.conns.size) return;
    s.unarmedSince = Date.now();
    const timer = setTimeout(() => {
      s.unarmedTimer = null;
      if (this.closed) return;
      this.change(groupId, 'not_reading', () => s.conns.size > 0 && s.unarmedSince !== null && this.setState(s, 'not_responding'));
    }, this.opts.offlineMs);
    timer.unref?.();
    s.unarmedTimer = timer;
  }

  /** Another key took the group over: every session of other keys ends at once. */
  endOwner(groupId: string, newOwner: string) {
    const g = this.groups.get(groupId);
    if (!g || this.closed) return;
    this.change(groupId, 'taken_over', () => {
      for (const [id, s] of g.sessions) {
        if (s.key === newOwner) continue;
        this.clearTimers(s, true);
        g.sessions.delete(id);
      }
    });
  }

  /** The group is gone: nothing about it is kept or reported. */
  remove(groupId: string) {
    const g = this.groups.get(groupId);
    if (!g) return;
    for (const s of g.sessions.values()) this.clearTimers(s, true);
    this.groups.delete(groupId);
  }

  close() {
    this.closed = true;
    for (const g of this.groups.values()) for (const s of g.sessions.values()) this.clearTimers(s, true);
  }

  private release(groupId: string, key: string, name: string, token: number) {
    const s = this.groups.get(groupId)?.sessions.get(sessionKey(key, name));
    if (!s || !s.conns.delete(token) || this.closed) return;
    if (s.conns.size) return;
    this.change(groupId, 'ended', () => {
      this.clearTimers(s, true);
      s.endedAt = Date.now();
      // Within the quiet window an ended connection still counts as listening: an ordinary re-wait doesn't flicker.
      if (s.state !== 'listening') this.setState(s, 'listening');
    });
    this.schedule(groupId, s, this.opts.quietMs, 'quiet', () => this.setState(s, 'reconnecting'));
    this.schedule(groupId, s, this.opts.offlineMs, 'offline', () => {
      const g = this.groups.get(groupId);
      if (g?.sessions.get(sessionKey(key, name)) === s) g.sessions.delete(sessionKey(key, name));
      this.clearTimers(s, true);
    });
  }

  /** A new session would go over the cap: the one that ended longest ago goes (or, all connected, the oldest). */
  private makeRoom(g: GroupRecord) {
    while (g.sessions.size >= MAX_SESSIONS) {
      let victim: [string, Session] | null = null;
      for (const entry of g.sessions) {
        const [, s] = entry;
        if (!victim) victim = entry;
        else {
          const v = victim[1];
          const older = s.endedAt !== null && (v.endedAt === null || s.endedAt < v.endedAt);
          const bothLive = s.endedAt === null && v.endedAt === null && s.since < v.since;
          if (older || bothLive) victim = entry;
        }
      }
      this.clearTimers(victim![1], true);
      g.sessions.delete(victim![0]);
    }
  }

  private schedule(groupId: string, s: Session, ms: number, reason: PresenceReason, fire: () => void) {
    const timer = setTimeout(() => {
      s.timers.delete(timer);
      if (this.closed) return;
      this.change(groupId, reason, fire);
    }, ms);
    timer.unref?.();
    s.timers.add(timer);
  }

  /** The ended connection's timers; `all` also the unread-events one (the session or its connection is gone). */
  private clearTimers(s: Session, all = false) {
    for (const t of s.timers) clearTimeout(t);
    s.timers.clear();
    if (all) this.clearUnarmed(s);
  }

  private clearUnarmed(s: Session) {
    if (s.unarmedTimer) clearTimeout(s.unarmedTimer);
    s.unarmedTimer = null;
    s.unarmedSince = null;
  }

  private setState(s: Session, state: Session['state']) {
    if (s.state === state) return;
    s.state = state;
    s.since = this.iso();
  }

  /** Runs `apply`, then reports what changed for the group (nothing, its sessions, or its state too). */
  private change(groupId: string, reason: PresenceReason, apply: (g: GroupRecord) => void) {
    let g = this.groups.get(groupId);
    if (!g) {
      g = { sessions: new Map(), state: 'disconnected', since: null };
      this.groups.set(groupId, g);
    }
    const before = snapshot(g);
    apply(g);
    const state = [...g.sessions.values()].reduce<PresenceState>((best, s) => (RANK[s.state] < RANK[best] ? s.state : best), 'disconnected');
    const from = g.state;
    if (state !== from) {
      g.state = state;
      g.since = this.iso();
    }
    if (snapshot(g) === before) return;
    this.opts.onChange(groupId, state !== from ? { from, to: state, reason } : null);
  }

  private iso() {
    return this.opts.now().toISOString();
  }
}

const sessionKey = (key: string, name: string) => `${key}\n${name}`;

/** What clients would see, to tell whether anything they see changed. */
const snapshot = (g: GroupRecord) =>
  JSON.stringify([g.state, g.since, [...g.sessions.values()].map((s) => [s.name, s.transport, s.state, s.since])]);
