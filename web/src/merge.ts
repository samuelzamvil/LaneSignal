import type { Epic, Escalation, Group, Lane, StreamEvent, Ticket } from './api.ts';

/** Lane and group ids are unique within a project; client maps key them by both. */
export const keyOf = (project: string, id: string) => `${project}/${id}`;

export interface Entities {
  groups: Map<string, Group>;
  lanes: Map<string, Lane>;
  escalations: Map<string, Escalation>;
  /** Keyed by the ticket's number (unique across projects). */
  tickets: Map<string, Ticket>;
  /** Open epics (and ones waiting for close approval), keyed by number (unique across projects). */
  epics: Map<string, Epic>;
}

const UNRESOLVED = new Set(['open', 'decided']);
/** Keeps whichever copy is newer, so an old event can't undo newer state (equal times apply). */
function newer<T extends { updatedAt: string }>(map: Map<string, T>, id: string, next: T) {
  const cur = map.get(id);
  return !cur || cur.updatedAt <= next.updatedAt;
}

/** Applies one stream event to the client's state; unresolved escalations only. */
export function applyEvent(s: Entities, e: StreamEvent): Entities {
  const groups = new Map(s.groups);
  const lanes = new Map(s.lanes);
  const escalations = new Map(s.escalations);
  const tickets = new Map(s.tickets);
  const epics = new Map(s.epics);
  if (e.type === 'group') {
    const k = keyOf(e.group.project, e.group.id);
    if (newer(groups, k, e.group)) groups.set(k, e.group);
  }
  if (e.type === 'group_deleted') groups.delete(keyOf(e.project, e.id));
  if (e.type === 'lane') {
    const k = keyOf(e.lane.project, e.lane.id);
    if (newer(lanes, k, e.lane)) lanes.set(k, e.lane);
  }
  if (e.type === 'lane_deleted') {
    lanes.delete(keyOf(e.project, e.id));
    // Questions stay with their ticket or epic; only older ones that had neither go with the lane.
    for (const [id, esc] of escalations) {
      if (esc.project === e.project && esc.laneId === e.id && esc.ticketId === null && !esc.epicId) escalations.delete(id);
    }
  }
  if (e.type === 'escalation' && newer(escalations, e.escalation.id, e.escalation)) {
    if (UNRESOLVED.has(e.escalation.state)) escalations.set(e.escalation.id, e.escalation);
    else escalations.delete(e.escalation.id);
  }
  if (e.type === 'ticket' && newer(tickets, String(e.ticket.id), e.ticket)) tickets.set(String(e.ticket.id), e.ticket);
  if (e.type === 'epic' && newer(epics, String(e.epic.id), e.epic)) {
    if (e.epic.state === 'closed') epics.delete(String(e.epic.id));
    else epics.set(String(e.epic.id), e.epic);
  }
  return { groups, lanes, escalations, tickets, epics };
}
