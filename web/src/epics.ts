import type { Epic, Lane, Ticket } from './api.ts';
import { keyOf } from './merge.ts';

/** A group's epics on its section of the Lanes page: its real ones (oldest first), or its stand-in when it has none. */
export function epicsOnScreen(groupKey: string | null, epics: Iterable<Epic>): Epic[] {
  if (!groupKey) return [];
  const all = [...epics].filter((e) => keyOf(e.project, e.group) === groupKey).sort((a, b) => a.id - b.id);
  const real = all.filter((e) => !e.standIn);
  return real.length ? real : all.filter((e) => e.standIn).slice(0, 1);
}

/**
 * The epic card a lane is listed under: its ticket's epic, when that's one of the real epics on
 * screen for its group. Otherwise (no ticket, no epic, or a closed one) it's listed under the group.
 */
export function laneEpic(lane: Pick<Lane, 'ticketId'>, onScreen: Epic[], tickets: Map<string, Ticket>): Epic | undefined {
  const t = lane.ticketId !== null ? tickets.get(String(lane.ticketId)) : undefined;
  return t?.epicId ? onScreen.find((e) => e.id === t.epicId && !e.standIn) : undefined;
}

/** Something on an epic's card worth seeing with no lanes under it: a real epic, or a stand-in's status line, questions, board or close request. */
export const epicShows = (e: Epic) => !e.standIn || !!e.statusLine || e.openEscalations > 0 || e.lastMessageId !== null || e.state !== 'open';
