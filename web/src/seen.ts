import { useEffect, useState } from 'react';
import type { Lane } from './api.ts';

/**
 * Which agent messages on each lane this device has shown: the card marks a lane with something new
 * to read until its sheet is opened. Kept per device; a lost store only shows a message as new again.
 */
const KEY = 'lanesignal.seenLaneMessages';
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

const keyOf = (lane: Pick<Lane, 'project' | 'id'>) => `${lane.project}/${lane.id}`;

/**
 * The agent wrote on the lane since this device last opened it. A device that has never tracked this
 * (a new install, or the upgrade that turned earlier notices into messages) marks nothing.
 */
export function hasNewMessage(lane: Lane): boolean {
  const all = read();
  return all !== null && lane.lastAgentMessageId !== null && lane.lastAgentMessageId > (all[keyOf(lane)] ?? 0);
}

/** On a device that has never tracked messages: what the lanes hold now counts as read. */
export function baselineSeen(lanes: Iterable<Lane>) {
  if (read() !== null) return;
  const all: Record<string, number> = {};
  for (const l of lanes) if (l.lastAgentMessageId !== null) all[keyOf(l)] = l.lastAgentMessageId;
  write(all);
  window.dispatchEvent(new Event(EVENT));
}

/** Marks the lane's messages up to `id` as read here. */
export function markMessagesSeen(lane: Pick<Lane, 'project' | 'id'>, id: number | null) {
  if (id === null) return;
  const all = read() ?? {};
  if ((all[keyOf(lane)] ?? 0) >= id) return;
  all[keyOf(lane)] = id;
  write(all);
  window.dispatchEvent(new Event(EVENT));
}

/** Re-renders when a lane's messages are marked read (here or in another tab). */
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
