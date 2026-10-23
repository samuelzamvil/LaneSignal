import type { Lane, LaneStatus } from './api.ts';

export const STATUS_META: Record<LaneStatus, { label: string; tone: string; rank: number }> = {
  blocked_human: { label: 'Needs human', tone: 'danger', rank: 0 },
  pending_ci: { label: 'Pending CI', tone: 'info', rank: 1 },
  awaiting_agent: { label: 'Awaiting agent', tone: 'info', rank: 2 },
  active: { label: 'Active', tone: 'ok', rank: 3 },
  idle: { label: 'Idle', tone: 'muted', rank: 4 },
  completed: { label: 'Completed', tone: 'muted', rank: 5 },
};

export const needsHuman = (l: Lane) => l.status === 'blocked_human' || l.openEscalations > 0;

/** Human-required first, then by status rank, then most recently updated. */
export function compareLanes(a: Lane, b: Lane) {
  const h = Number(needsHuman(b)) - Number(needsHuman(a));
  if (h) return h;
  const r = STATUS_META[a.status].rank - STATUS_META[b.status].rank;
  if (r) return r;
  return b.updatedAt.localeCompare(a.updatedAt);
}

export function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export const ago = (iso: string, now: number) => {
  const ms = now - Date.parse(iso);
  return ms < 45_000 ? 'just now' : `${duration(ms)} ago`;
};

export const blockedMs = (l: Lane, now: number) =>
  l.blockedTotalMs + (l.blockedSince ? now - Date.parse(l.blockedSince) : 0);

export const isStale = (l: Lane, now: number, staleMinutes: number) =>
  staleMinutes > 0 &&
  (l.status === 'active' || l.status === 'pending_ci' || l.status === 'awaiting_agent') &&
  now - Date.parse(l.updatedAt) > staleMinutes * 60_000;

export const absolute = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
