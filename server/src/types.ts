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
  /** Ids of the products it works on. Its title on the dashboard comes from them. */
  products: string[];
  /** Token name that last updated the group. */
  agent: string | null;
  /** Its overseer: the name of the key that registered it last. Any overseer may take control; each change is recorded. */
  overseer: string | null;
  /** When the current overseer took control. */
  overseerSince: string | null;
  /** The latest message in the group's conversation (anyone's), for clients to see it changed. */
  lastMessageId: number | null;
  /** The overseer's latest message in the group's conversation, for marking the group as having something new to read. */
  lastAgentMessageId: number | null;
  /** How far its overseer has acknowledged people's messages to the group (0: none yet): those up to it are seen. */
  overseerReadId: number;
  createdAt: string;
  updatedAt: string;
  /** Whether its overseer is connected right now. Absent when answering in LaneSignal is off. */
  presence?: GroupPresence;
}

/** Best first: a group takes the state of its best session. */
export type PresenceState = 'listening' | 'not_responding' | 'reconnecting' | 'disconnected';
/** How a session is connected: the agent socket, or a wait (`wait_for_decisions`, `GET /api/wait`). */
export type PresenceTransport = 'socket' | 'wait';

export interface PresenceSession {
  /** The name the agent gave its session (`session`), or `wait:<key name>` without one. */
  id: string;
  transport: PresenceTransport;
  state: Exclude<PresenceState, 'disconnected'>;
  /** When it took this state. */
  since: string;
}

export interface GroupPresence {
  state: PresenceState;
  /** When the group took this state; null while disconnected when no session has connected since the server started. */
  since: string | null;
  sessions: PresenceSession[];
}

/**
 * Why a group's presence changed: a session `connected`, its connection `ended`, the `quiet` window passed,
 * it went `offline`, another key `taken_over` the group, or its events went unread (`not_reading`) or are read again (`reading`).
 */
export type PresenceReason = 'connected' | 'ended' | 'quiet' | 'offline' | 'taken_over' | 'not_reading' | 'reading';

export interface PresenceChange {
  from: PresenceState;
  to: PresenceState;
  reason: PresenceReason;
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
  /** The ticket the lane holds, as the agent last wrote it, e.g. "redmine:1234" or "#42"; null when it holds none. */
  ticket: string | null;
  /** Resolved from the configured URL templates; null when no template matches. */
  ticketUrl: string | null;
  /** The held ticket's id (see Ticket), or null. */
  ticketId: number | null;
  /** Another ticket the held one waits on, e.g. "945"; null when none. */
  waitingOn: string | null;
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

/**
 * Where a ticket stands in LaneSignal: held by a lane, set aside to pick up again, or let go
 * finished or not. Nothing here claims anything about the ticket's real status in its tracker.
 */
export const TICKET_STATES = ['in_lane', 'parked', 'done', 'dropped'] as const;

/** An overseer asks to reopen a closed epic; it waits for a signed-in person. */
export interface ReopenRequest {
  reason: string;
  by: string;
  at: string;
}
export type TicketState = (typeof TICKET_STATES)[number];

/** A ticket worked in lanes: owns its escalations and status history, and moves between lanes. */
export interface Ticket {
  /** Short number, unique across projects. */
  id: number;
  project: string;
  /** Canonical reference ("redmine:967"): the forms an agent may write ("967", "#967", the URL) all map to it. */
  ref: string;
  /** The reference as first written. */
  displayRef: string;
  /** What its escalation codes start with: "967A", "gh:632B", or "T42C" when the ref can't be one. */
  code: string;
  url: string | null;
  /** The group it was last worked in. */
  group: string | null;
  /** The lane holding it, or null. */
  lane: string | null;
  /** The last lane it was in (the one it left, while parked or over); null if it never was. */
  lastLane: string | null;
  state: TicketState;
  parkReason: string | null;
  /** Another ticket (canonical ref) this one waits on. */
  waitingOn: string | null;
  /** The epic it belongs to, if it names one. */
  epicId: number | null;
  /** Its status: the holding lane's while in a lane, else as it was when the lane let it go. */
  status: LaneStatus;
  statusSince: string;
  blockedSince: string | null;
  blockedTotalMs: number;
  /** Escalations still waiting on a human. */
  openEscalations: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export const EPIC_STATES = ['open', 'close_requested', 'closed'] as const;
export type EpicState = (typeof EPIC_STATES)[number];

/**
 * A long-lived ticket a group steers its work by: its own questions and message board, not worked in
 * a lane. Every group has one; when none was given, the group stands in as its epic (`standIn`).
 */
export interface Epic {
  /** Short number, unique across projects. */
  id: number;
  project: string;
  group: string;
  /** Canonical ref of its ticket ("redmine:680"); null for a group's stand-in epic. */
  ref: string | null;
  /** The ref as first written. */
  displayRef: string | null;
  url: string | null;
  /** What its escalation codes start with: "680A", or the group's id for a stand-in. */
  code: string;
  name: string;
  links: Link[];
  /** One line the overseer sets: "3 of 5 lanes busy; next up #966". */
  statusLine: string | null;
  state: EpicState;
  standIn: boolean;
  /** Why the overseer asked to close it, while waiting for a person. */
  closeReason: string | null;
  closeRequestedBy: string | null;
  /** A closed epic its overseer asked to reopen, waiting for a person's approval. */
  reopenRequest: ReopenRequest | null;
  /** Its questions waiting on a person, and of those how many block (it shows "Waiting on you"). */
  openEscalations: number;
  blockingEscalations: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
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
  /**
   * Short code for humans and agents to refer to it by: its ticket's or epic's code and a letter ("967A",
   * "680A"); older ones keep their lane's letter and a number ("A12"). Accepted wherever an id is.
   */
  ref: string;
  /** The ticket it belongs to; null for an epic's. */
  ticketId: number | null;
  /** The group it was raised in: its thread is in that group's conversation. */
  group: string | null;
  /** That ticket's short ref ("967", "gh:632"); null without one. */
  ticketRef: string | null;
  /** The epic it belongs to (raised on an epic, or on a lane holding no ticket); null for a ticket's. */
  epicId: number | null;
  /** That epic's name. */
  epicName: string | null;
  /** Project the escalation's lane belongs to. */
  project: string;
  /** Short key of that project, so codes can be shown as "LS·A12" where projects mix. */
  projectKey: string;
  laneId: string | null;
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
  /** Suggested answers rendered as one-tap buttons (older escalations; new ones use Accept / Reject / Other). */
  options: string[];
  /** What answering Accept means, e.g. "Drop the column in migration 0042". */
  acceptMeans: string | null;
  /** What answering Reject means; only when `allowReject`. */
  rejectMeans: string | null;
  /** Whether Reject is offered (default true). */
  allowReject: boolean;
  /** Files the agent attached (plans, screenshots). Fetch each from /api/attachments/:id. */
  attachments: AttachmentMeta[];
  /**
   * Whose move it is while open: the owner's (the question, or the agent's latest reply, waits on
   * them), or the agent's (the owner answered Other and the agent hasn't replied yet).
   */
  turn: 'owner' | 'agent';
  /** Messages in its conversation, and the latest one. */
  messageCount: number;
  lastMessage: Message | null;
  /** The whole conversation, oldest first: only when one escalation is fetched. */
  messages?: Message[];
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

/** One message in an escalation's conversation: the owner's instructions or the agent's short reply. */
export interface Message {
  id: number;
  from: 'owner' | 'agent';
  /** Who wrote it: the person, or the agent's key name. */
  author: string;
  body: string;
  at: string;
  attachments: AttachmentMeta[];
}

/** A message in a group's conversation (GroupMessage adds where it was written). Nothing in it blocks anything. */
export interface LaneMessage extends Message {
  /** People's messages: whether the overseer has acknowledged it yet. */
  seen?: boolean;
}

/**
 * A message in a group's conversation. Written to the group directly (`escalationId`, `laneId` and
 * `epicId` all null), on one of its escalations, or as the overseer's milestone on a lane (`laneId`).
 * `epicId`, and `laneId` on people's messages, come from before lanes' and epics' conversations were retired.
 */
export interface GroupMessage extends LaneMessage {
  escalationId: string | null;
  laneId: string | null;
  epicId: number | null;
}

/** One entry in a group's conversation, newest first: a message, or an escalation (its thread starts here). */
export type GroupFeedItem =
  | ({ type: 'message' } & GroupMessage)
  | {
      type: 'escalation';
      id: string;
      ref: string;
      question: string;
      state: EscalationState;
      turn: 'owner' | 'agent';
      blocking: boolean;
      decision: string | null;
      decidedBy: string | null;
      decidedAt: string | null;
      resolution: string | null;
      laneId: string | null;
      at: string;
    };

/** A page of a group's conversation, newest first; `next` fetches the page before it (null at the start). */
export interface GroupConversationPage {
  items: GroupFeedItem[];
  next: string | null;
}

/** A file on an escalation: Markdown or plain text, or a PNG, JPEG, WebP or GIF image. */
export interface AttachmentMeta {
  id: string;
  name: string;
  type: AttachmentType;
  size: number;
}

export const ATTACHMENT_TYPES = ['text/markdown', 'text/plain', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

export interface LaneEvent {
  id: number;
  laneId: string;
  at: string;
  /** `notice`: the agent's milestone on the lane (in its group's conversation); `message`: an owner's note from before lanes' conversations were retired; `ticket`: a ticket filled, parked or let go. */
  kind: 'status' | 'activity' | 'escalation' | 'notice' | 'message' | 'ticket';
  message: string;
  actor: string | null;
  /** The ticket it concerns: the one the lane held, or the escalation's. */
  ticketId?: number | null;
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
  /** An account admin, who sees every project without being a member. */
  instanceAdmin?: boolean;
}

export interface PublicConfig {
  name: string;
  /** What groups are called in this deployment: "Epic", "Train", "Overseer", ... */
  groupLabel: string;
  statuses: readonly LaneStatus[];
  ticketSystems: string[];
  /** Ticket system key -> URL template with {id}, so the app can link refs written in free text. */
  ticketTemplates: Record<string, string>;
  /** The system plain refs like `#1234` link to. */
  defaultTicketSystem: string | null;
  staleMinutes: number;
  push: { fcm: boolean; ntfy: boolean };
  /** People answer escalations in LaneSignal; off, they answer in the agent's session and agents dismiss alerts. */
  decisions: boolean;
  /** The requirements register is on. */
  requirements: boolean;
  /** Alerts arrive as regular notifications instead of high priority (Settings → Push). */
  quietAlerts: boolean;
  /** Sign-in through Cloudflare Access is on (LANESIGNAL_CLOUDFLARE_ACCESS, beta). */
  cloudflareAccess?: boolean;
}

/** `observer`: a read-only key for agents that watch (Settings → Keys); it reads what an agent key reads and changes nothing. */
export type Role = 'human' | 'agent' | 'observer';

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
  /** An agent or observer key bound to one project. */
  project?: string;
  /** A personal key: acts as its owner, but from a Claude session, so its requirements still wait for approval. */
  personalKey?: boolean;
  /** Signed in through Cloudflare Access (LANESIGNAL_CLOUDFLARE_ACCESS) rather than with a LaneSignal session. */
  cloudflareAccess?: boolean;
}

/**
 * `pending` until a person approves it (agents' records start there), then `active`;
 * `superseded` or `retired` once it no longer applies. `rejected`: a person turned down the pending
 * record (with a reason); agents never see those.
 */
export type RequirementStatus = 'pending' | 'active' | 'superseded' | 'retired' | 'rejected';

/**
 * Where a requirement applies: every project (`global`), every product in its project (`project`),
 * or only the products it names (`products`). Always chosen, never a default.
 */
export type RequirementScope = 'global' | 'project' | 'products';

/** A product within a project, which requirements can be scoped to. Only people create products. */
export interface Product {
  project: string;
  /** Kebab-case, unique within the project, e.g. "billing". */
  id: string;
  name: string;
  /** The product this one is a subproject of, or null at the top level. One level deep. */
  parent: string | null;
  /** A CSS hex colour, e.g. "#3b82f6", or null for the default. */
  color: string | null;
  /** Locked: agents can't add requirements to it, change its requirements, or move requirements in or out. */
  locked: boolean;
  archived: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Pending and active requirements scoped to it. */
  requirements: number;
}

/** A change to a requirement's scope, kept for audits. */
export interface RequirementChange {
  id: number;
  requirement: string;
  kind: 'scope';
  actor: string;
  from: { scope: RequirementScope; project: string | null; products: string[] };
  to: { scope: RequirementScope; project: string | null; products: string[] };
  at: string;
}

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
  /** Global, project-wide, or the products in `products`. */
  scope: RequirementScope;
  /** Product ids in its project, when `scope` is "products"; empty otherwise. */
  products: string[];
  /** Recorded before products existed (or without a scope): waiting for a person to choose one. Counts as project-wide meanwhile. */
  needsRegrouping: boolean;
  /** How many times a person changed its scope (`GET /api/requirements/:id/changes` lists them). */
  scopeChanges: number;
  /** One normative statement, e.g. "Payout jobs retry at most 5 times." */
  requirement: string;
  /** Why, and where the decision was made. */
  justification: string;
  /** Retired: tags older requirements were recorded with (products replaced them). Empty on new ones. */
  tags: string[];
  status: RequirementStatus;
  /** Set when superseded: the requirement that replaced this one. */
  supersededBy: string | null;
  /** Set when rejected: why the person turned it down. */
  rejectionReason: string | null;
  /** The person who made the decision. */
  decidedBy: string;
  /** Code of the escalation the decision came from, if any (e.g. "A12"). */
  sourceEscalation: string | null;
  /** Who recorded it (agent key or person). */
  recordedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** What the TRMNL screen's card shows: an escalation (drawn from its current state), or a notification. */
export type TrmnlCard =
  | { kind: 'escalation'; id: string; at: string }
  /** `files`: how many the agent attached to a notice. */
  /** `laneId` empty for a message to the whole group, whose `groupId` it names then. */
  | { kind: 'notice' | 'completed' | 'blocked'; laneId: string; groupId?: string; title: string; body: string; at: string; files?: number };

/** A project's TRMNL screen: a private plugin LaneSignal pushes to. */
export interface TrmnlSetup {
  project: string;
  webhookUrl: string;
  enabled: boolean;
  /** Lane milestones, completions and blocks take the card too, not only escalations. */
  includeNotifications: boolean;
  /** The TRMNL account has TRMNL+: 30 pushes per hour instead of 12. */
  plus: boolean;
  card: TrmnlCard | null;
  lastPushAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  updatedAt: string;
}

/** A project's TRMNL setup as its admins see it: the webhook URL is masked. */
export type TrmnlView =
  | { configured: false }
  | ({ configured: true } & Pick<TrmnlSetup, 'webhookUrl' | 'enabled' | 'includeNotifications' | 'plus' | 'lastPushAt' | 'lastError' | 'lastErrorAt' | 'updatedAt'>);

/** How TRMNL answered a push. */
export interface TrmnlPushResult {
  ok: boolean;
  /** TRMNL's HTTP status, when it answered. */
  status?: number;
  error?: string;
}

/** The agent's message on a lane (a milestone, with any files): a quiet push that opens the lane. */
export interface Notice {
  project: string;
  /** The group whose conversation it's in. */
  groupId: string;
  /** The lane it's about (notify_owner), for its title. */
  laneId?: string;
  message: string;
  by: string;
  attachments?: AttachmentMeta[];
}

export type StreamEvent =
  /** `presence`: set when this event is the group's presence transition. */
  | { type: 'group'; group: Group; presence?: PresenceChange }
  | { type: 'group_deleted'; id: string; project: string }
  /** `statusChanged` is set when this event is the lane's status transition (drives notifications). */
  /** `completed`: the lane was published completed and let its ticket go (it shows idle now). */
  | { type: 'lane'; lane: Lane; statusChanged?: boolean; completed?: boolean }
  | { type: 'lane_deleted'; id: string; project: string }
  /** `raised`: an FYI that now needs the owner, notified like a new question. `replied`: the agent answered the owner's Other (`reply`) or posted an update while they decide. */
  | { type: 'escalation'; escalation: Escalation; raised?: boolean; replied?: 'reply' | 'update' }
  /** Someone wrote in a group's conversation directly. */
  | { type: 'group_message'; group: string; project: string; message: GroupMessage }
  /** A ticket filled into a lane, parked, done or dropped, or what it waits on changed. */
  | { type: 'ticket'; ticket: Ticket }
  /** An epic changed: details, close request, or its questions' counts. */
  | { type: 'epic'; epic: Epic }
  /** `previousProject`: set when a person moved it out of that project (null: out of global), so those who saw it there learn it's gone. */
  | { type: 'requirement'; requirement: Requirement; previousProject?: string | null }
  /** A product was added, renamed, recoloured, locked or unlocked, or archived. */
  | { type: 'product'; product: Product };
