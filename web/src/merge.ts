import type { Escalation, Group, Lane, StreamEvent } from './api.ts';

/** Lane and group ids are unique within a project; client maps key them by both. */
export const keyOf = (project: string, id: string) => `${project}/${id}`;

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
    for (const [id, esc] of escalations) if (esc.project === e.project && esc.laneId === e.id) escalations.delete(id);
  }
  if (e.type === 'escalation' && newer(escalations, e.escalation.id, e.escalation)) {
    if (UNRESOLVED.has(e.escalation.state)) escalations.set(e.escalation.id, e.escalation);
    else escalations.delete(e.escalation.id);
  }
  return { groups, lanes, escalations };
}
