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

/**
 * What goes where inside a group's box: each epic with the lanes under it, the lanes that name no
 * epic, and the quiet ones folded away. Each lane lands in exactly one place.
 */
export function groupLayout<L extends Pick<Lane, 'ticketId'>>(
  lanes: L[],
  onScreen: Epic[],
  tickets: Map<string, Ticket>,
  options: {
    /** Show epics with no lanes here (off while a filter is picking lanes). */
    showEmptyEpics: boolean;
    /** A lane to fold away, unless the epic it's under says otherwise. */
    isQuiet: (lane: L) => boolean;
  },
): { epics: { epic: Epic; lanes: L[] }[]; noEpic: L[]; quiet: L[] } {
  const real = onScreen.filter((e) => !e.standIn);
  const under = new Map<number, L[]>(real.map((e) => [e.id, []]));
  const noEpic: L[] = [];
  const quiet: L[] = [];
  for (const lane of lanes) {
    const epic = laneEpic(lane, real, tickets);
    if (epic) under.get(epic.id)!.push(lane);
    else (options.isQuiet(lane) ? quiet : noEpic).push(lane);
  }
  return {
    epics: real.map((epic) => ({ epic, lanes: under.get(epic.id)! })).filter((e) => options.showEmptyEpics || e.lanes.length > 0),
    noEpic,
    quiet,
  };
}

/** Something on an epic's card worth seeing with no lanes under it: a real epic, or a stand-in's status line, questions, board or close request. */
export const epicShows = (e: Epic) => !e.standIn || !!e.statusLine || e.openEscalations > 0 || e.lastMessageId !== null || e.state !== 'open';
