// Agents publish a lane (and register its group) before escalating on it. Tests about other
// behaviour use these to do the same in one step.
import type { Store } from '../src/store.ts';

type EscalationInput = Parameters<Store['createEscalation']>[0];
type LanePatch = Parameters<Store['upsertLane']>[1];

export function lane(store: Store, id: string, patch: LanePatch, actor: string | null) {
  if (patch.group && !store.groupExists(patch.group)) store.upsertGroup(patch.group, {}, actor);
  return store.upsertLane(id, patch, actor);
}

export function esc(store: Store, input: EscalationInput, actor: string) {
  if (!store.laneExists(input.laneId)) store.upsertLane(input.laneId, {}, actor);
  return store.createEscalation(input, actor);
}
