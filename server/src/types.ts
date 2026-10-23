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
  /** Project the group belongs to. */
  project: string;
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
  /** Unique within its project. */
  id: string;
  /** Project the lane belongs to. */
  project: string;
  /**
   * Letter while the lane is active or has unresolved escalations (A, B, … Z, AA…); its
   * escalations are coded with it ("A12"). Freed for another lane once it's done.
   */
  letter: string | null;
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
  /** Of those, how many hold the lane blocked (the rest are FYI). */
  blockingEscalations: number;
  /** An agent is waiting on this lane's escalations right now, so an answer reaches it at once. */
  agentWaiting: boolean;
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
  /** Short code for humans and agents to refer to it by: its lane's letter and a number, e.g. "A12". Accepted wherever an id is. */
  ref: string;
  /** Project the escalation's lane belongs to. */
  project: string;
  /** Short key of that project, so codes can be shown as "LS·A12" where projects mix. */
  projectKey: string;
  laneId: string;
  /** The decision being asked for; doubles as the headline. */
  question: string;
  /** Background a human needs to answer without opening the session. */
  context: string | null;
  /** What the escalating agent would do. */
  recommendation: string | null;
  /** Which of `options` the recommendation corresponds to, if any. */
  recommendedOption: string | null;
  /** What following the recommendation costs (dependencies, time, risk...). */
  cost: string | null;
  /** Other paths considered, each with its tradeoff. */
  alternatives: string[];
  /** What the question is about, e.g. the plan or PR "gh:921"; the lane's own ticket may differ. */
  ticket: string | null;
  ticketUrl: string | null;
  /** Agreement/disagreement from agents, one entry per agent. */
  positions: Position[];
  /** Suggested answers rendered as one-tap buttons. */
  options: string[];
  links: Link[];
  /** Holds the lane in blocked_human while open; false for FYI questions. */
  blocking: boolean;
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

/** One application or codebase, with its own groups, lanes, escalations and requirements. */
export interface Project {
  /** Stable id, e.g. "lanesignal". */
  id: string;
  /** Short uppercase key shown before escalation codes where projects mix ("LS·A12"). */
  key: string;
  name: string;
  createdAt: string;
}

export type ProjectRole = 'admin' | 'member';

/** A project as the caller sees it. */
export interface ProjectAccess extends Project {
  /** The caller's role; instance admins and config tokens are admins everywhere. */
  role: ProjectRole;
  /** Whether the caller's phones get push notifications for this project. */
  notify: boolean;
}

export interface ProjectMember {
  userId: string;
  name: string;
  email: string;
  role: ProjectRole;
  notify: boolean;
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
  /** Owning account: the signed-in user, or the user an agent key belongs to. Absent for config tokens. */
  userId?: string;
  email?: string;
  /** May manage accounts (account admins and config-file human tokens). */
  admin?: boolean;
  /** Account admins (and keys they own): admin of every project. */
  superuser?: boolean;
  /** An agent key bound to one project. */
  project?: string;
}

export type RequirementStatus = 'active' | 'superseded' | 'retired';

/**
 * A product decision made by the owner, kept so it can be found later without
 * digging through tickets. Agents record them; the decision is always a human's.
 */
export interface Requirement {
  /** "R14": global, never reused. */
  id: string;
  /** Project it applies to; null when it applies to all projects (an owner-wide rule). */
  project: string | null;
  /** Group (train/epic) within the project it belongs to; null for project-wide requirements. */
  group: string | null;
  /** One normative statement, e.g. "Payout jobs retry at most 5 times." */
  requirement: string;
  /** Why, and where the decision was made. */
  justification: string;
  /** 1-3 specific kebab-case tags naming a capability. */
  tags: string[];
  status: RequirementStatus;
  /** Set when superseded: the requirement that replaced this one. */
  supersededBy: string | null;
  /** The person who made the decision. */
  decidedBy: string;
  /** Code of the escalation the decision came from, if any (e.g. "A12"). */
  sourceEscalation: string | null;
  /** Who recorded it (agent key or person). */
  recordedBy: string;
  createdAt: string;
  updatedAt: string;
}

export type StreamEvent =
  | { type: 'group'; group: Group }
  | { type: 'group_deleted'; id: string; project: string }
  /** `statusChanged` is set when this event is the lane's status transition (drives notifications). */
  | { type: 'lane'; lane: Lane; statusChanged?: boolean }
  | { type: 'lane_deleted'; id: string; project: string }
  | { type: 'escalation'; escalation: Escalation }
  | { type: 'requirement'; requirement: Requirement };
