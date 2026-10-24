import { useEffect, useState } from 'react';
import type { Lane } from './api.ts';

/**
 * Which agent messages on each lane this device has shown: the card marks a lane with something new
 * to read until its sheet is opened. Kept per device; a lost store only shows a message as new again.
 */
const KEY = 'lanesignal.seenLaneMessages';
const EVENT = 'lanesignal:seen';

function read(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

const keyOf = (lane: Pick<Lane, 'project' | 'id'>) => `${lane.project}/${lane.id}`;

/** The agent wrote on the lane since this device last opened it. */
export function hasNewMessage(lane: Lane): boolean {
  return lane.lastAgentMessageId !== null && lane.lastAgentMessageId > (read()[keyOf(lane)] ?? 0);
}

/** Marks the lane's messages up to `id` as read here. */
export function markMessagesSeen(lane: Pick<Lane, 'project' | 'id'>, id: number | null) {
  if (id === null) return;
  const all = read();
  if ((all[keyOf(lane)] ?? 0) >= id) return;
  all[keyOf(lane)] = id;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage full or blocked: the marker just stays */
  }
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
