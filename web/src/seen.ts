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
/** When the latest escalation raised in each group was shown here (its createdAt). */
const ESC_KEY = 'lanesignal.seenGroupEscalations';

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

function readEsc(): Record<string, string> | null {
  try {
    const raw = localStorage.getItem(ESC_KEY);
    return raw === null ? null : (JSON.parse(raw) as Record<string, string>);
  } catch {
    return null;
  }
}

function writeEsc(all: Record<string, string>) {
  try {
    localStorage.setItem(ESC_KEY, JSON.stringify(all));
  } catch {
    /* storage full or blocked: the marker just stays */
  }
}

/** When the newest escalation raised in the group was (open or decided ones: what the client holds), or null. */
export function latestEscalationAt(
  escalations: Iterable<{ project: string; group: string | null; createdAt: string }>,
  group: Pick<Group, 'project' | 'id'>,
): string | null {
  let latest: string | null = null;
  for (const e of escalations) if (e.project === group.project && e.group === group.id && (latest === null || e.createdAt > latest)) latest = e.createdAt;
  return latest;
}

type Board = Pick<Group, 'project' | 'id' | 'lastAgentMessageId'>;
const keyOf = (group: Pick<Group, 'project' | 'id'>) => `${group.project}/${group.id}`;

/**
 * The overseer wrote in the group's conversation, or raised an escalation in it (`latestEscalation`,
 * its time), since this device last opened it. A device that has never tracked this (a new install,
 * or the upgrade to groups' conversations) marks nothing.
 */
export function hasNewMessage(group: Board, latestEscalation: string | null = null): boolean {
  const all = read();
  if (all !== null && group.lastAgentMessageId != null && group.lastAgentMessageId > (all[keyOf(group)] ?? 0)) return true;
  const esc = readEsc();
  return esc !== null && latestEscalation !== null && latestEscalation > (esc[keyOf(group)] ?? '');
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

/**
 * On a device that has never tracked escalations in groups: those the client holds now count as
 * seen, so only ones raised from here on mark the chat button.
 */
export function baselineSeenEscalations(groups: Iterable<Pick<Group, 'project' | 'id'>>, escalations: { project: string; group: string | null; createdAt: string }[]) {
  if (readEsc() !== null) return;
  const all: Record<string, string> = {};
  for (const g of groups) {
    const at = latestEscalationAt(escalations, g);
    if (at !== null) all[keyOf(g)] = at;
  }
  writeEsc(all);
  window.dispatchEvent(new Event(EVENT));
}

/** Marks the group's messages up to `id`, and its escalations up to `latestEscalation` (a time), as read here. */
export function markMessagesSeen(group: Pick<Group, 'project' | 'id'>, id: number | null, latestEscalation: string | null = null) {
  // Before the baseline (a conversation opened from a push on a cold start), the baseline records it.
  let changed = false;
  const all = read();
  if (id != null && all !== null && (all[keyOf(group)] ?? 0) < id) {
    all[keyOf(group)] = id;
    write(all);
    changed = true;
  }
  const esc = readEsc();
  if (latestEscalation !== null && esc !== null && (esc[keyOf(group)] ?? '') < latestEscalation) {
    esc[keyOf(group)] = latestEscalation;
    writeEsc(esc);
    changed = true;
  }
  if (changed) window.dispatchEvent(new Event(EVENT));
}

/** Re-renders when a group's messages are marked read (here or in another tab). */
export function useSeenVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    const onStorage = (e: StorageEvent) => (e.key === KEY || e.key === ESC_KEY) && bump();
    window.addEventListener(EVENT, bump);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EVENT, bump);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return version;
}
