import type { LaneEvent } from './api.ts';

/** One line of a lane's history: an event as it is, or a ticket switch as one marker. */
export type TimelineItem =
  | { kind: 'event'; event: LaneEvent }
  | { kind: 'switch'; id: number; at: string; text: string; actor: string | null };

const FILLED = /^Filled with /;

/**
 * A lane's history (latest first, as the server sends it) with its ticket events as markers. A
 * ticket let go and the next one taken in the same call read as one: "Parked 500: blocked on the
 * vendor API · filled with 501".
 */
export function withSwitchMarkers(events: LaneEvent[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.kind !== 'ticket') {
      out.push({ kind: 'event', event: e });
      continue;
    }
    // Latest first: the fill comes before the release it followed.
    const next = events[i + 1];
    if (FILLED.test(e.message) && next?.kind === 'ticket' && !FILLED.test(next.message) && next.at === e.at) {
      out.push({ kind: 'switch', id: e.id, at: e.at, text: `${next.message} · ${e.message.replace(FILLED, 'filled with ')}`, actor: e.actor });
      i++;
      continue;
    }
    out.push({ kind: 'switch', id: e.id, at: e.at, text: e.message, actor: e.actor });
  }
  return out;
}
