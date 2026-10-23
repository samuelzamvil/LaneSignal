import { App as CapApp } from '@capacitor/app';
import { useEffect, useRef, useState } from 'react';
import { ApiError, isNative, type Client, type Escalation, type Group, type Lane, type StreamEvent } from './api.ts';

export type LinkState = 'connecting' | 'live' | 'offline' | 'unauthorized';

export interface LiveData {
  groups: Map<string, Group>;
  lanes: Map<string, Lane>;
  escalations: Map<string, Escalation>;
  link: LinkState;
  /** Bumps on every event so detail views can refetch. */
  version: number;
  lastEvent: StreamEvent | null;
}

type Entities = Pick<LiveData, 'groups' | 'lanes' | 'escalations'>;

const UNRESOLVED = new Set(['open', 'decided']);
/** The server pings every 25s; a stream silent for longer than this is dead. */
const STALL_MS = 60_000;

/** Keeps whichever copy is newer, so an old event can't undo newer state (equal times apply). */
function newer<T extends { updatedAt: string }>(map: Map<string, T>, id: string, next: T) {
  const cur = map.get(id);
  return !cur || cur.updatedAt <= next.updatedAt;
}

function applyEvent(s: Entities, e: StreamEvent): Entities {
  const groups = new Map(s.groups);
  const lanes = new Map(s.lanes);
  const escalations = new Map(s.escalations);
  if (e.type === 'group' && newer(groups, e.group.id, e.group)) groups.set(e.group.id, e.group);
  if (e.type === 'group_deleted') groups.delete(e.id);
  if (e.type === 'lane' && newer(lanes, e.lane.id, e.lane)) lanes.set(e.lane.id, e.lane);
  if (e.type === 'lane_deleted') {
    lanes.delete(e.id);
    for (const [id, esc] of escalations) if (esc.laneId === e.id) escalations.delete(id);
  }
  if (e.type === 'escalation' && newer(escalations, e.escalation.id, e.escalation)) {
    if (UNRESOLVED.has(e.escalation.state)) escalations.set(e.escalation.id, e.escalation);
    else escalations.delete(e.escalation.id);
  }
  return { groups, lanes, escalations };
}

/**
 * Snapshot + server-sent events. Each connection opens the stream first and
 * then loads a snapshot; events received meanwhile are buffered and replayed
 * on top of it, so nothing that happens during the load is lost. Reconnects
 * with backoff (re-snapshotting each time), drops stalled streams, and stops
 * on a rejected token.
 */
export function useLiveData(client: Client): LiveData {
  const [state, setState] = useState<LiveData>({
    groups: new Map(),
    lanes: new Map(),
    escalations: new Map(),
    link: 'connecting',
    version: 0,
    lastEvent: null,
  });
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    let stopped = false;
    let ctrl = new AbortController();
    let attempt = 0;
    let wake: (() => void) | null = null;
    let unauthorized = false;
    const isAuthError = (err: unknown) => err instanceof ApiError && (err.status === 401 || err.status === 403);

    async function connect() {
      const conn = new AbortController();
      ctrl = conn;
      // null once the snapshot is in; until then events wait here.
      let pending: StreamEvent[] | null = [];
      let stall: ReturnType<typeof setTimeout> | undefined;
      const alive = () => {
        clearTimeout(stall);
        stall = setTimeout(() => conn.abort(), STALL_MS);
      };
      try {
        await client.stream(
          {
            onOpen: () => {
              alive();
              client.snapshot().then(
                (snap) => {
                  if (conn.signal.aborted || !pending) return;
                  let base: Entities = {
                    groups: new Map(snap.groups.map((g) => [g.id, g])),
                    lanes: new Map(snap.lanes.map((l) => [l.id, l])),
                    escalations: new Map(snap.escalations.map((e) => [e.id, e])),
                  };
                  for (const e of pending) base = applyEvent(base, e);
                  pending = null;
                  attempt = 0;
                  setState((s) => ({ ...s, ...base, link: 'live', version: s.version + 1 }));
                },
                (err) => {
                  // No snapshot means no trustworthy state: start over.
                  if (isAuthError(err)) unauthorized = true;
                  conn.abort();
                },
              );
            },
            onEvent: (e) => {
              if (pending) pending.push(e);
              else setState((s) => ({ ...s, ...applyEvent(s, e), version: s.version + 1, lastEvent: e }));
            },
            onActivity: alive,
          },
          conn.signal,
        );
      } catch (err) {
        if (isAuthError(err)) unauthorized = true;
      } finally {
        clearTimeout(stall);
      }
    }

    async function loop() {
      while (!stopped) {
        await connect();
        if (stopped) return;
        if (unauthorized) {
          setState((s) => ({ ...s, link: 'unauthorized' }));
          return;
        }
        setState((s) => ({ ...s, link: attempt === 0 ? 'connecting' : 'offline' }));
        const delay = Math.min(30_000, 1000 * 2 ** attempt++);
        await new Promise<void>((r) => {
          const t = setTimeout(r, delay);
          wake = () => {
            clearTimeout(t);
            r();
          };
        });
        wake = null;
      }
    }

    // Force a fresh connection, e.g. when the app returns to the foreground.
    kick.current = () => {
      attempt = 0;
      ctrl.abort();
      wake?.();
    };

    void loop();
    return () => {
      stopped = true;
      ctrl.abort();
      wake?.();
    };
  }, [client]);

  useEffect(() => {
    // Mobile OSes silently kill sockets of backgrounded apps; reconnect after a real pause.
    let hiddenAt = 0;
    const onVisible = () => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 20_000) kick.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    const resume = isNative ? CapApp.addListener('resume', () => kick.current()) : null;
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      void resume?.then((h) => h.remove());
    };
  }, []);

  return state;
}

/** Re-renders every `ms` so relative timestamps stay fresh. */
export function useNow(ms = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
