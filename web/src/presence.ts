import type { Group, GroupPresence, PresenceState } from './api.ts';

export const PRESENCE_META: Record<PresenceState, { icon: string; label: string }> = {
  listening: { icon: '●', label: 'listening' },
  not_responding: { icon: '■', label: 'not responding' },
  reconnecting: { icon: '◌', label: 'reconnecting' },
  disconnected: { icon: '┆', label: 'disconnected' },
};

/** A session's id as a link when it is one (a Remote Control URL); null for a plain name. */
export const sessionHref = (id: string) => {
  if (!/^https?:\/\//i.test(id)) return null;
  try {
    return new URL(id).href;
  } catch {
    return null;
  }
};

/**
 * The group's presence as the app shows it: none without presence (answering in LaneSignal off), and none
 * for a group nobody registered (Ungrouped, or one made by publishing a lane) while nobody is connected,
 * since it has no overseer to be missing.
 */
export const shownPresence = (group: Pick<Group, 'presence' | 'overseer'> | undefined): GroupPresence | undefined =>
  group?.presence && (group.overseer || group.presence.state !== 'disconnected') ? group.presence : undefined;

/** Whether the group's overseer gets something right now; undefined when the app shows no presence for it. */
export const overseerListening = (group: Pick<Group, 'presence' | 'overseer'> | undefined) => {
  const presence = shownPresence(group);
  return presence ? presence.state === 'listening' : undefined;
};

/** The line under the group conversation's box: whether what's written reaches the overseer now. */
export function deliveryLine(group: Pick<Group, 'presence' | 'overseer'> | undefined): string | null {
  const presence = shownPresence(group);
  if (!presence) return null;
  switch (presence.state) {
    case 'listening':
      return 'The overseer is listening: it gets this now.';
    case 'not_responding':
      return "The overseer's session is connected but isn't reading: it gets this when it does.";
    default:
      return 'The overseer isn\'t connected. It gets this when it reconnects.';
  }
}

/** The chip's tooltip: the state, since when (`when` formats a time), and each session. */
export function presenceTitle(presence: GroupPresence, when: (iso: string) => string): string {
  const head = `Overseer ${PRESENCE_META[presence.state].label}${presence.since ? ` since ${when(presence.since)}` : ''}`;
  return [head, ...presence.sessions.map((s) => `${s.id} (${s.transport}): ${PRESENCE_META[s.state].label}`)].join('\n');
}
