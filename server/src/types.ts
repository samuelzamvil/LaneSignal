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

/**
 * A body of tickets (an epic or train) and the overseer agent session that
 * runs its lanes. One overseer -> many lanes; the group is named after it.
 */
export interface Group {
  id: string;
  name: string;
  /** The epic/train ticket, resolved like lane tickets. */
  ticket: string | null;
  ticketUrl: string | null;
  /** Typically the overseer's Remote Control session (kind "session"). */
  links: Link[];
  /** Token name that last updated the group. */
  agent: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Lane {
  id: string;
  name: string;
  /** Id of the group (epic/train/overseer) this lane belongs to. */
  group: string | null;
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

export const STANCES = ['agree', 'disagree', 'neutral'] as const;
export type Stance = (typeof STANCES)[number];

/** One agent's view on the escalation's recommendation. */
export interface Position {
  agent: string;
  stance: Stance;
  note: string | null;
  at: string;
}

/**
 * Loose structure: Context -> Question -> Recommendation -> agent positions.
 * Only `question` is required.
 */
export interface Escalation {
  id: string;
  laneId: string;
  /** The decision being asked for; doubles as the headline. */
  question: string;
  /** Background a human needs to answer without opening the session. */
  context: string | null;
  /** What the escalating agent would do. */
  recommendation: string | null;
  /** Which of `options` the recommendation corresponds to, if any. */
  recommendedOption: string | null;
  /** Agreement/disagreement from agents, one entry per agent. */
  positions: Position[];
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
  /** What groups are called in this deployment: "Epic", "Train", "Overseer", ... */
  groupLabel: string;
  statuses: readonly LaneStatus[];
  ticketSystems: string[];
  staleMinutes: number;
  push: { fcm: boolean; ntfy: boolean };
}

export type Role = 'human' | 'agent';

export interface Principal {
  name: string;
  role: Role;
}

export type StreamEvent =
  | { type: 'group'; group: Group }
  | { type: 'group_deleted'; id: string }
  | { type: 'lane'; lane: Lane }
  | { type: 'lane_deleted'; id: string }
  | { type: 'escalation'; escalation: Escalation };
