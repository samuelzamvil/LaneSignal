// Agents publish a lane (and register its group) before escalating on it. Tests about other
// behaviour use these to do the same in one step.
import { localId, type Store } from '../src/store.ts';

type EscalationInput = Parameters<Store['createEscalation']>[0];
type LanePatch = Parameters<Store['upsertLane']>[1];

// A new lane holds a ticket named after it unless the patch says otherwise (null: none), so it
// works and its questions block it, as a lane did before epics took ticketless lanes' questions.
export function lane(store: Store, id: string, patch: LanePatch, actor: string | null) {
  if (patch.group && !store.groupExists(patch.group)) store.upsertGroup(patch.group, {}, actor);
  const fresh = !store.laneExists(id) && patch.ticket === undefined;
  return store.upsertLane(id, fresh ? { ...patch, ticket: localId(id) } : patch, actor);
}

export function esc(store: Store, input: EscalationInput, actor: string) {
  if (!store.laneExists(input.laneId)) store.upsertLane(input.laneId, { ticket: localId(input.laneId) }, actor);
  return store.createEscalation(input, actor);
}
