// Agents publish a lane (and register its group) before escalating on it. Tests about other
// behaviour use these to do the same in one step.
import { localId, type Store } from '../src/store.ts';

type EscalationInput = Parameters<Store['createEscalation']>[0];
type LanePatch = Parameters<Store['upsertLane']>[1];

// A new lane holds a ticket named after it unless the patch says otherwise (null: none), so it
// works and its questions block it, as a lane did before epics took ticketless lanes' questions.
// Every lane is in a group: a new one without one named goes in its project's "main".
const inGroup = (store: Store, id: string, patch: LanePatch, actor: string | null): LanePatch => {
  const group = patch.group ?? (store.laneExists(id) ? undefined : `${id.slice(0, id.indexOf('/'))}/main`);
  if (group && !store.groupExists(group)) store.upsertGroup(group, {}, actor);
  return group ? { ...patch, group } : patch;
};

export function lane(store: Store, id: string, patch: LanePatch, actor: string | null) {
  patch = inGroup(store, id, patch, actor);
  const fresh = !store.laneExists(id) && patch.ticket === undefined;
  return store.upsertLane(id, fresh ? { ...patch, ticket: localId(id) } : patch, actor);
}

export function esc(store: Store, input: EscalationInput, actor: string) {
  if (!store.laneExists(input.laneId)) store.upsertLane(input.laneId, inGroup(store, input.laneId, { ticket: localId(input.laneId) }, actor), actor);
  return store.createEscalation(input, actor);
}
