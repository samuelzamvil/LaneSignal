import { App as CapApp } from '@capacitor/app';
import { useEffect, useRef, useState } from 'react';
import { isNative, type Client, type Escalation, type Lane, type StreamEvent } from './api.ts';

export type LinkState = 'connecting' | 'live' | 'offline';

export interface LiveData {
  lanes: Map<string, Lane>;
  escalations: Map<string, Escalation>;
  link: LinkState;
  /** Bumps on every event so detail views can refetch. */
  version: number;
  lastEvent: StreamEvent | null;
}

const UNRESOLVED = new Set(['open', 'decided']);

/**
 * Snapshot + server-sent events. Reconnects with backoff and re-snapshots on
 * every (re)connect, so missed events while offline or backgrounded are
 * never lost.
 */
export function useLiveData(client: Client): LiveData {
  const [state, setState] = useState<LiveData>({
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

    const apply = (e: StreamEvent) =>
      setState((s) => {
        const lanes = new Map(s.lanes);
        const escalations = new Map(s.escalations);
        if (e.type === 'lane') lanes.set(e.lane.id, e.lane);
        if (e.type === 'lane_deleted') {
          lanes.delete(e.id);
          for (const [id, esc] of escalations) if (esc.laneId === e.id) escalations.delete(id);
        }
        if (e.type === 'escalation') {
          if (UNRESOLVED.has(e.escalation.state)) escalations.set(e.escalation.id, e.escalation);
          else escalations.delete(e.escalation.id);
        }
        return { ...s, lanes, escalations, version: s.version + 1, lastEvent: e };
      });

    async function loop() {
      while (!stopped) {
        ctrl = new AbortController();
        try {
          await client.stream(
            async () => {
              attempt = 0;
              const snap = await client.snapshot();
              setState((s) => ({
                ...s,
                lanes: new Map(snap.lanes.map((l) => [l.id, l])),
                escalations: new Map(snap.escalations.map((e) => [e.id, e])),
                link: 'live',
                version: s.version + 1,
              }));
            },
            apply,
            ctrl.signal,
          );
        } catch {
          /* fall through to reconnect */
        }
        if (stopped) return;
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
