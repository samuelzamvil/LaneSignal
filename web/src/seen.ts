import { useEffect, useState } from 'react';
import type { Group } from './api.ts';

/**
 * Which of the overseer's messages in each group's conversation this device has shown: the group's
 * chat button marks something new to read until the conversation is opened. Kept per device; a lost
 * store only shows a message as new again.
 */
// v3: groups' conversations, in place of lanes' and epics' (whose markers mean nothing now).
const KEY = 'lanesignal.seenGroupMessages';
try {
  localStorage.removeItem('lanesignal.seenLaneMessages');
  localStorage.removeItem('lanesignal.seenLaneMessages.v2');
} catch {
  /* storage blocked: nothing to tidy */
}
const EVENT = 'lanesignal:seen';

function read(): Record<string, number> | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? null : (JSON.parse(raw) as Record<string, number>);
  } catch {
    return null;
  }
}

function write(all: Record<string, number>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage full or blocked: the marker just stays */
  }
}

type Board = Pick<Group, 'project' | 'id' | 'lastAgentMessageId'>;
const keyOf = (group: Pick<Group, 'project' | 'id'>) => `${group.project}/${group.id}`;

/**
 * The overseer wrote in the group's conversation since this device last opened it. A device that has
 * never tracked this (a new install, or the upgrade to groups' conversations) marks nothing.
 */
export function hasNewMessage(group: Board): boolean {
  const all = read();
  return all !== null && group.lastAgentMessageId != null && group.lastAgentMessageId > (all[keyOf(group)] ?? 0);
}

/** On a device that has never tracked messages: what the groups hold now counts as read. */
export function baselineSeen(groups: Iterable<Board>) {
  if (read() !== null) return;
  const list = [...groups];
  // A server from before groups' conversations doesn't say: baseline once it does, or everything would be new.
  if (list.some((l) => l.lastAgentMessageId === undefined)) return;
  const all: Record<string, number> = {};
  for (const l of list) if (l.lastAgentMessageId !== null) all[keyOf(l)] = l.lastAgentMessageId;
  write(all);
  window.dispatchEvent(new Event(EVENT));
}

/** Marks the group's messages up to `id` as read here. */
export function markMessagesSeen(group: Pick<Group, 'project' | 'id'>, id: number | null) {
  // Before the baseline (a conversation opened from a push on a cold start), the baseline records it.
  const all = read();
  if (id == null || all === null) return;
  if ((all[keyOf(group)] ?? 0) >= id) return;
  all[keyOf(group)] = id;
  write(all);
  window.dispatchEvent(new Event(EVENT));
}

/** Re-renders when a group's messages are marked read (here or in another tab). */
export function useSeenVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    const onStorage = (e: StorageEvent) => e.key === KEY && bump();
    window.addEventListener(EVENT, bump);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EVENT, bump);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return version;
}
