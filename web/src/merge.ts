import type { Escalation, Group, Lane, StreamEvent } from './api.ts';

export interface Entities {
  groups: Map<string, Group>;
  lanes: Map<string, Lane>;
  escalations: Map<string, Escalation>;
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
