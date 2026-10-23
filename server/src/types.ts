// Shared API types. The web client imports these with `import type`, so keep
// this file free of runtime code.

export const LANE_STATUSES = [
  'blocked_human',
  'pending_ci',
  'awaiting_agent',
  'active',
  'idle',
  'completed',
] as const;

export type LaneStatus = (typeof LANE_STATUSES)[number];

export interface Link {
  label: string;
  url: string;
  /** Free-form hint for the UI icon: pr, ci, session, doc, ... */
  kind?: string;
}

export interface Lane {
  id: string;
  name: string;
  category: string | null;
  status: LaneStatus;
  /** Raw ticket reference as published by the agent, e.g. "redmine:1234" or "#42". */
  ticket: string | null;
  /** Resolved from the configured URL templates; null when no template matches. */
  ticketUrl: string | null;
  activity: string | null;
  links: Link[];
  /** Name of the agent token that last updated the lane. */
  agent: string | null;
  createdAt: string;
  updatedAt: string;
  statusSince: string;
  /** Set while status is blocked_human. */
  blockedSince: string | null;
  /** Accumulated blocked time from previous blocked periods, in ms. */
  blockedTotalMs: number;
  /** Count of escalations still waiting on a human decision. */
  openEscalations: number;
}

export type EscalationState = 'open' | 'decided' | 'acknowledged' | 'withdrawn';

export interface Escalation {
  id: string;
  laneId: string;
  title: string;
  body: string | null;
  /** Suggested answers rendered as one-tap buttons. */
  options: string[];
  links: Link[];
  state: EscalationState;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  decision: string | null;
  decisionNote: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  acknowledgedAt: string | null;
  /** Agent note when acknowledging or withdrawing. */
  resolution: string | null;
}

export interface LaneEvent {
  id: number;
  laneId: string;
  at: string;
  kind: 'status' | 'activity' | 'escalation';
  message: string;
  actor: string | null;
}

export interface PublicConfig {
  name: string;
  categories: string[];
  statuses: readonly LaneStatus[];
  ticketSystems: string[];
  staleMinutes: number;
  push: { fcm: boolean; ntfy: boolean };
}

export type Role = 'overseer' | 'agent';

export interface Principal {
  name: string;
  role: Role;
}

export type StreamEvent =
  | { type: 'lane'; lane: Lane }
  | { type: 'lane_deleted'; id: string }
  | { type: 'escalation'; escalation: Escalation };
