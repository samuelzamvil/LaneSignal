import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import {
  LANE_STATUSES,
  type Escalation,
  type EscalationState,
  type Group,
  type Lane,
  type LaneEvent,
  type LaneStatus,
  type Link,
  type AttachmentMeta,
  type AttachmentType,
  type LaneMessage,
  type Message,
  type Notice,
  type Position,
  type Project,
  type ProjectRole,
  type Product,
  type Requirement,
  type RequirementChange,
  type RequirementScope,
  type RequirementStatus,
  type TrmnlCard,
  type TrmnlSetup,
  type Stance,
  type StreamEvent,
  type Epic,
  type EpicState,
  type Ticket,
  type TicketState,
} from './types.ts';
import { ticketRefs, type TicketRefs } from './tickets.ts';

export class NotFoundError extends Error {}

const MAX_POSITIONS = 20;
export class ConflictError extends Error {}
/** The caller may see the thing but not do this to it; a 403. */
export class ForbiddenError extends Error {}
/** Input that's well-formed but not acceptable (e.g. an overbroad tag); a 400. */
export class ValidationError extends Error {}

/** Tags too broad to help anyone find a requirement; overridable with LANESIGNAL_BROAD_TAGS. */
export const DEFAULT_BROAD_TAGS = [
  'backend', 'frontend', 'ui', 'ux', 'api', 'misc', 'general', 'other', 'product', 'feature', 'features',
  'requirement', 'requirements', 'decision', 'decisions', 'important', 'todo', 'bug', 'bugs', 'code', 'app',
];

/** Requirements that still apply: approved, or recorded and waiting for approval. */
const IN_FORCE: RequirementStatus[] = ['pending', 'active'];
const inForce = (r: Requirement) => IN_FORCE.includes(r.status);

export interface RequirementInput {
  requirement: string;
  justification: string;
  tags: string[];
  /** Project it applies to; null for every project (an owner-wide rule). */
  project?: string | null;
  /** Qualified group id within that project; null or absent for project-wide. */
  group?: string | null;
  /**
   * Global (project null), project-wide, or the products in `products` (ids in the project).
   * Absent: worked out from `project` as before products existed, and flagged for a person to regroup.
   */
  scope?: RequirementScope;
  products?: string[];
  /** Escalation (id or code) the owner decided this in; its decider becomes `decidedBy`. */
  sourceEscalation?: string | null;
  /** The person who decided, when there's no escalation (e.g. said in Remote Control). */
  decidedBy?: string | null;
}

/** Where a person moves a requirement: global (project null), project-wide, or products of the project. */
export interface ScopeTarget {
  scope: RequirementScope;
  project: string | null;
  products?: string[];
}

export interface RecordResult {
  requirement: Requirement;
  /** Pending or active requirements that read alike: check these aren't the same decision. */
  similar: Requirement[];
  /** Advice, e.g. a tag already on most requirements. */
  warnings: string[];
  /** True when an active requirement already cites the same escalation: that one is returned, nothing new is stored. */
  duplicate?: boolean;
}

/** Lane letters: 0 -> A, 25 -> Z, 26 -> AA, like spreadsheet columns. */
export function letterOf(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    n -= 1;
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

function indexOfLetter(letters: string): number {
  let n = 0;
  for (const c of letters.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

/** The project existing data moves into, and the one a fresh install starts with. */
export const DEFAULT_PROJECT = 'default';

/** Lane and group ids are stored qualified with their project: "project/lane". */
export const qualify = (project: string, id: string) => `${project}/${id}`;
export const localId = (qualified: string) => qualified.slice(qualified.indexOf('/') + 1);
export const projectOf = (qualified: string) => {
  const i = qualified.indexOf('/');
  // A bare id here is a bug in the caller, not bad input: fail loudly rather than write to project "".
  if (i <= 0) throw new Error(`internal: "${qualified}" is not qualified with a project`);
  return qualified.slice(0, i);
};

/** How long a lane keeps showing "agent waiting" after a wait ends, so back-to-back waits don't flicker. */
const WAIT_GRACE_MS = 30_000;

/** What `waitForDecisions` watches: explicit escalations, whole lanes, and/or a group's lanes. */
/** An escalation as the store holds it: always the lane it was raised in (an epic's internal lane for one raised on the epic). */
export type StoredEscalation = Escalation & { laneId: string };

export interface WaitScope {
  ids?: string[];
  laneIds?: string[];
  groupId?: string;
  /**
   * Report escalations in the lanes/group that someone else withdrew at or after
   * this time (e.g. a person dismissed one), and lanes removed since then. Defaults to when the wait starts;
   * a loop passes the previous result's `checkedAt` so nothing slips between calls.
   */
  since?: string;
  /** Who is waiting: their own withdrawals aren't reported back to them. */
  viewer?: string;
  /**
   * `digest`: ready only when there's something to handle; with `since`, the owner's notes are those
   * written since then (whether or not handed over), so a crashed wait that repeats its `since` loses
   * nothing. `full`: the older behaviour, ready at once when nothing is open, notes handed over once.
   * Left out (get_updates): unread notes, plus any since `since`.
   */
  mode?: 'digest' | 'full';
  /** Set by waitForDecisions: whether `since` came from the agent (false when it defaulted to now). */
  givenSince?: boolean;
}

export interface WaitResult {
  /** True when there's something to act on, or nothing left to wait for. */
  ready: boolean;
  /** Answered and waiting for the agent's acknowledgement. */
  decided: Escalation[];
  /**
   * Escalations named in `ids` that were closed (withdrawn or already acknowledged), and ones in
   * the lanes/group that someone else withdrew since `since` (a removed lane is reported in `removedLanes`).
   */
  closed: Escalation[];
  /**
   * The owner answered Other: their messages since the agent last wrote. Act on them and acknowledge,
   * or reply (reply_to_escalation).
   */
  replies: { id: string; ref: string; projectKey: string; laneId: string | null; epicName?: string; question: string; messages: Message[] }[];
  /** Still waiting on a human. */
  open: { id: string; ref: string; laneId: string | null; epicName?: string; question: string }[];
  /** Lanes in scope that someone else took off the dashboard since `since`: stop work on them. */
  removedLanes: { laneId: string; removedBy: string | null; at: string }[];
  /** The owner wrote on lanes in scope (not about an escalation): their messages the agent hasn't seen. */
  laneMessages: { laneId: string; messages: LaneMessage[] }[];
  /** Digest only: tickets from lanes in scope that a lane outside it took since `since` (another overseer, usually). */
  movedTickets: { ticket: string; ticketId: number; laneId: string; by: string | null; at: string }[];
  /** A group's wait: people's notes on its epics' boards the overseer hasn't seen (and, in a digest, any since `since`). */
  boardMessages: { project: string; epicId: number; epic: string; messages: LaneMessage[] }[];
  /** Server time of this result; pass it as `since` on the next wait. */
  checkedAt: string;
}

export const EXPORT_DATASETS = [
  'escalations', 'positions', 'messages', 'lane_messages', 'lanes', 'groups', 'tickets', 'epics', 'epic_messages', 'events', 'requirements',
  'products', 'requirement_changes',
] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];
/** Datasets that exist only while the requirements register is on. */
export const REQUIREMENT_DATASETS: readonly ExportDataset[] = ['requirements', 'products', 'requirement_changes'];

/** Fixed column order per dataset, so a CSV's header never depends on whether it has rows. */
export const EXPORT_COLUMNS: Record<ExportDataset, readonly string[]> = {
  escalations: [
    'id', 'ref', 'project', 'lane_id', 'lane_name', 'group_id', 'group_name', 'ticket', 'ticket_url', 'question', 'context',
    'recommendation', 'recommended_option', 'cost', 'alternatives', 'options', 'accept_means', 'reject_means',
    'allow_reject', 'attachments', 'blocking', 'state', 'created_by',
    'created_at', 'decided_by', 'decided_at', 'decision', 'decision_note', 'followed_recommendation',
    'acknowledged_at', 'resolution', 'closed_at', 'seconds_to_decision', 'seconds_to_acknowledge', 'seconds_open',
    'positions_agree', 'positions_disagree', 'positions_neutral', 'links', 'ticket_id', 'legacy_ref', 'epic_id',
  ],
  positions: ['escalation_id', 'escalation_ref', 'project', 'lane_id', 'question', 'agent', 'stance', 'note', 'at'],
  lanes: [
    'id', 'project', 'name', 'group_id', 'group_name', 'status', 'ticket', 'ticket_url', 'activity', 'last_published_by',
    'created_at', 'updated_at', 'status_since', 'blocked_seconds_total', 'blocked_since', 'escalations_total',
    'escalations_open', 'links', 'archived_at', 'ticket_id',
  ],
  groups: ['id', 'project', 'name', 'ticket', 'ticket_url', 'links', 'last_published_by', 'created_at', 'updated_at', 'archived_at'],
  tickets: [
    'id', 'project', 'ref', 'display_ref', 'code', 'ticket_url', 'group_id', 'lane_id', 'state', 'park_reason', 'waiting_on',
    'status', 'blocked_seconds_total', 'escalations_total', 'escalations_open', 'created_at', 'updated_at', 'closed_at',
  ],
  epics: [
    'id', 'project', 'group_id', 'ref', 'display_ref', 'code', 'name', 'ticket_url', 'stand_in', 'state', 'status_line', 'links',
    'close_reason', 'close_requested_by', 'escalations_total', 'escalations_open', 'created_at', 'updated_at', 'closed_at',
  ],
  epic_messages: ['id', 'project', 'epic_id', 'from', 'author', 'body', 'attachments', 'at'],
  events: ['id', 'project', 'lane_id', 'at', 'kind', 'message', 'actor', 'ticket_id'],
  messages: ['id', 'escalation_id', 'escalation_ref', 'project', 'lane_id', 'from', 'author', 'body', 'attachments', 'at'],
  lane_messages: ['id', 'project', 'lane_id', 'from', 'author', 'body', 'attachments', 'at'],
  requirements: [
    'id', 'project', 'group_id', 'requirement', 'justification', 'tags', 'status', 'superseded_by', 'decided_by',
    'source_escalation', 'recorded_by', 'created_at', 'updated_at', 'rejection_reason', 'scope', 'products', 'needs_regrouping',
  ],
  products: ['project', 'id', 'name', 'color', 'locked', 'archived', 'requirements', 'created_by', 'created_at', 'updated_at'],
  requirement_changes: ['id', 'requirement', 'kind', 'actor', 'from_scope', 'from_project', 'from_products', 'to_scope', 'to_project', 'to_products', 'at'],
};
export interface ExportFilter {
  from?: string;
  to?: string;
  /** Qualified lane id. */
  laneId?: string;
  /** Projects to include (requirements for all projects are always included); undefined = every project. */
  projects?: string[];
  /** Include rejected requirements (only people who approve requirements see them). */
  includeRejected?: boolean;
}

export interface GroupPatch {
  name?: string;
  ticket?: string | null;
  links?: Link[];
}

export interface LanePatch {
  name?: string;
  /** Group id; unknown ids create the group. */
  group?: string | null;
  status?: LaneStatus;
  /** The ticket the lane holds: a different one switches tickets (see LaneFill), null empties the lane. */
  ticket?: string | null;
  activity?: string | null;
  links?: Link[];
}

/** What happens to the ticket a lane lets go of: set aside to pick up again, finished, or dropped unfinished. */
export type TicketRelease = 'park' | 'done' | 'drop';

/** How a lane changes tickets (fill_lane), on top of a LanePatch. */
export interface LaneFill {
  /** What happens to the ticket the lane holds now; required by fill_lane when it changes tickets. */
  previous?: TicketRelease;
  /** Why it's parked (required for park), or a note on done/drop. */
  reason?: string | null;
  /** Another ticket the held one waits on; null clears it. */
  waitingOn?: string | null;
  /** The epic (its number) the held ticket is for; null clears it. */
  epic?: number | null;
  /**
   * fill_lane: `previous` is required when the lane lets a ticket go. Without it (update_lane, older
   * agents) the ticket is parked.
   */
  strict?: boolean;
}

export interface EscalationInput {
  laneId: string;
  question: string;
  context?: string | null;
  recommendation?: string | null;
  recommendedOption?: string | null;
  cost?: string | null;
  alternatives?: string[];
  ticket?: string | null;
  positions?: { agent: string; stance: Stance; note?: string | null }[];
  options?: string[];
  acceptMeans?: string | null;
  rejectMeans?: string | null;
  allowReject?: boolean;
  /** Ids of files uploaded to /api/attachments by the same agent. */
  attachments?: string[];
  links?: Link[];
  /** Marks the lane blocked_human until the escalation is decided. Default true. */
  blocking?: boolean;
  /**
   * The epic it's for (its number). Raised on an epic directly, `laneId` is the epic's internal lane
   * (Store.epicLaneId). Without it, a lane holding no ticket raises on its group's epic.
   */
  epic?: number;
}

export interface StoreOptions {
  path: string;
  resolveTicketUrl: (ticket: string) => string | null;
  /** Canonical ticket refs (see ticketRefs); without it, refs are only trimmed and stripped of a leading #. */
  ticketRefs?: TicketRefs;
  eventRetention?: number;
  now?: () => Date;
  /** How long a lane keeps showing "agent waiting" after a wait ends (default 30s). */
  waitGraceMs?: number;
  /** Tags rejected as too broad (lowercase). */
  broadTags?: string[];
  /** Most files on one escalation (default 5). */
  attachmentsPerItem?: number;
}

const SCHEMA_VERSION = 20;

/** Agent messages stay short: anything longer belongs in an attached file. */
export const AGENT_MESSAGE_MAX = 500;
export const OWNER_MESSAGE_MAX = 2000;

/** Uploads nothing references after this long are deleted. */
const UNREFERENCED_TTL_MS = 24 * 60 * 60 * 1000;
/** Uploads one uploader may have waiting to be referenced, so nobody fills the disk. */
const MAX_PENDING_UPLOADS = 20;

type Row = Record<string, unknown>;

/** What a ticket switch changed besides the lane itself, for events once the transaction commits. */
interface Touched {
  /** Escalations withdrawn. */
  escalations: Set<string>;
  /** Other lanes to send again (e.g. ones whose ticket waited on a finished one). */
  lanes: Set<string>;
  /** Tickets filled, parked, done, dropped, or whose waiting_on changed. */
  tickets: Set<number>;
}

/** Escalation ids. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Codes are a ticket's short ref and a letter: short refs ending in a digit, so "5A" can't be ref "5A"'s. */
const CODE_REF = /^[A-Za-z0-9:._-]{1,40}$/;

/**
 * SQLite-backed store. Every mutation emits a StreamEvent on `events`, which
 * feeds SSE clients, long-polling agents, and push notifications.
 */
export class Store {
  readonly events = new EventEmitter<{ change: [StreamEvent]; notice: [Notice] }>();
  private db: DatabaseSync;
  private resolveTicketUrl: (ticket: string) => string | null;
  private refs: TicketRefs;
  private broadTags: Set<string>;
  private retention: number;
  private now: () => Date;
  /** No timestamp written from now on is earlier than this (ms): the latest `checkedAt` handed out. */
  private floorMs = 0;
  /** Lanes with an agent currently waiting on their escalations (in memory: waits don't survive restarts). */
  private waiting = new Map<string, number>();
  private graceTimers = new Set<ReturnType<typeof setTimeout>>();
  private waitGraceMs: number;
  private attachmentsPerItem: number;

  constructor(opts: StoreOptions) {
    this.db = new DatabaseSync(opts.path);
    this.resolveTicketUrl = opts.resolveTicketUrl;
    this.refs = opts.ticketRefs ?? ticketRefs({}, null);
    this.retention = opts.eventRetention ?? 200;
    const clock = opts.now ?? (() => new Date());
    this.now = () => {
      const t = clock();
      return t.getTime() >= this.floorMs ? t : new Date(this.floorMs);
    };
    this.waitGraceMs = opts.waitGraceMs ?? WAIT_GRACE_MS;
    this.attachmentsPerItem = opts.attachmentsPerItem ?? 5;
    this.broadTags = new Set((opts.broadTags ?? DEFAULT_BROAD_TAGS).map((t) => t.toLowerCase()));
    this.events.setMaxListeners(0);
    this.migrate();
    this.recanonicalizeTickets();
  }

  /**
   * Tickets (and epics) are stored by their canonical ref, which depends on the configured ticket systems: after
   * those change ("967" now means "redmine:967"), refs are worked out again from how each ticket was
   * first written, so publishing the same ticket still finds it. Codes don't change.
   */
  private recanonicalizeTickets() {
    const rows = this.db.prepare('SELECT num, project_id, ref, display_ref FROM tickets').all() as Row[];
    for (const r of rows) {
      const ref = this.refs.canonical(r.display_ref as string);
      if (ref === r.ref) continue;
      // Two tickets that now mean the same one keep their refs; the older form still finds the first.
      if (this.db.prepare('SELECT 1 FROM tickets WHERE project_id = ? AND ref = ?').get(r.project_id as string, ref)) continue;
      this.db.prepare('UPDATE tickets SET ref = ? WHERE num = ?').run(ref, Number(r.num));
    }
    // Epics' refs the same way.
    for (const r of this.db.prepare('SELECT num, project_id, ref, display_ref FROM epics WHERE ref IS NOT NULL').all() as Row[]) {
      const ref = this.refs.canonical(r.display_ref as string);
      if (ref === r.ref || this.db.prepare('SELECT 1 FROM epics WHERE project_id = ? AND ref = ?').get(r.project_id as string, ref)) continue;
      this.db.prepare('UPDATE epics SET ref = ? WHERE num = ?').run(ref, Number(r.num));
    }
    // Escalations' own ticket field, stored canonical.
    for (const r of this.db.prepare('SELECT id, ticket FROM escalations WHERE ticket IS NOT NULL').all() as Row[]) {
      const ref = this.refs.canonical(r.ticket as string);
      if (ref !== r.ticket) this.db.prepare('UPDATE escalations SET ticket = ? WHERE id = ?').run(ref, r.id as string);
    }
    for (const r of this.db.prepare('SELECT num, waiting_on FROM tickets WHERE waiting_on IS NOT NULL').all() as Row[]) {
      const ref = this.refs.canonical(r.waiting_on as string);
      if (ref !== r.waiting_on) this.db.prepare('UPDATE tickets SET waiting_on = ? WHERE num = ?').run(ref, Number(r.num));
    }
  }

  close() {
    for (const t of this.graceTimers) clearTimeout(t);
    this.db.close();
  }

  ping() {
    this.db.prepare('SELECT 1').get();
  }

  private migrate() {
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as Row | undefined;
    const version = row ? Number(row.value) : 0;
    if (version >= SCHEMA_VERSION) return;
    if (version >= 1 && !this.hasColumn('lanes', 'group_id')) {
      // Pre-release builds wrote schema_version 1 with a different layout.
      throw new Error(
        'This database was created by a pre-release LaneSignal build and cannot be upgraded. ' +
          'Move lanesignal.db (and its -wal/-shm files) out of the data directory to start fresh.',
      );
    }
    this.tx(() => {
      if (version < 1) this.migrateV1();
      if (version < 2) {
        // Escalation fields: its own ticket/PR reference, cost of the recommendation, alternatives.
        this.db.exec(`
          ALTER TABLE escalations ADD COLUMN ticket TEXT;
          ALTER TABLE escalations ADD COLUMN cost TEXT;
          ALTER TABLE escalations ADD COLUMN alternatives TEXT NOT NULL DEFAULT '[]';
        `);
      }
      if (version < 3) {
        // Whether the escalation holds its lane in blocked_human (FYI questions don't).
        this.db.exec('ALTER TABLE escalations ADD COLUMN blocking INTEGER NOT NULL DEFAULT 1');
      }
      if (version < 4) {
        // Removing a lane or group archives it, so its escalations and history stay available for export.
        this.db.exec(`
          ALTER TABLE lanes ADD COLUMN archived_at TEXT;
          ALTER TABLE groups ADD COLUMN archived_at TEXT;
        `);
      }
      if (version < 5) {
        // A global escalation number (now only an internal ordering key; v6 adds codes like A12), and
        // the account a push token belongs to, so removed people stop getting notifications.
        this.db.exec(`
          ALTER TABLE escalations ADD COLUMN ref INTEGER;
          UPDATE escalations SET ref = n.ref
            FROM (SELECT rowid AS rid, ROW_NUMBER() OVER (ORDER BY rowid) AS ref FROM escalations) AS n
            WHERE escalations.rowid = n.rid;
          CREATE UNIQUE INDEX escalations_ref ON escalations(ref);
          ALTER TABLE escalations ADD COLUMN withdrawn_by TEXT;
          ALTER TABLE push_tokens ADD COLUMN user_id TEXT;
          -- Tokens from before accounts were recorded can only be matched to a person by name.
          ALTER TABLE push_tokens ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0;
          UPDATE push_tokens SET legacy = 1;
        `);
      }
      if (version < 6) this.migrateV6();
      if (version < 7) {
        // Product requirements: owner decisions, searchable (full-text index kept in step by triggers).
        this.db.exec(`
          CREATE TABLE requirements (
            num INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT,
            requirement TEXT NOT NULL,
            justification TEXT NOT NULL,
            tags TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL,
            superseded_by INTEGER,
            decided_by TEXT NOT NULL,
            source_escalation_id TEXT,
            recorded_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX requirements_group ON requirements(group_id, status);
          -- Two indexes: stemmed (whole words in any form: "retries" finds "retry") and plain
          -- (prefixes as you type: "deploy" finds "deployments"). Searches use both.
          CREATE VIRTUAL TABLE requirements_fts USING fts5(
            requirement, justification, tags, content='requirements', content_rowid='num', tokenize='porter unicode61'
          );
          CREATE VIRTUAL TABLE requirements_fts_plain USING fts5(
            requirement, justification, tags, content='requirements', content_rowid='num', tokenize='unicode61'
          );
          CREATE TRIGGER requirements_ai AFTER INSERT ON requirements BEGIN
            INSERT INTO requirements_fts(rowid, requirement, justification, tags)
              VALUES (new.num, new.requirement, new.justification, new.tags);
            INSERT INTO requirements_fts_plain(rowid, requirement, justification, tags)
              VALUES (new.num, new.requirement, new.justification, new.tags);
          END;
          CREATE TRIGGER requirements_au AFTER UPDATE ON requirements BEGIN
            INSERT INTO requirements_fts(requirements_fts, rowid, requirement, justification, tags)
              VALUES ('delete', old.num, old.requirement, old.justification, old.tags);
            INSERT INTO requirements_fts(rowid, requirement, justification, tags)
              VALUES (new.num, new.requirement, new.justification, new.tags);
            INSERT INTO requirements_fts_plain(requirements_fts_plain, rowid, requirement, justification, tags)
              VALUES ('delete', old.num, old.requirement, old.justification, old.tags);
            INSERT INTO requirements_fts_plain(rowid, requirement, justification, tags)
              VALUES (new.num, new.requirement, new.justification, new.tags);
          END;
        `);
      }
      if (version < 8) this.migrateV8();
      // v9: who raised each escalation (the owning account, or a config token), so only they acknowledge it.
      if (version < 9 && !this.hasColumn('escalations', 'raised_by_owner')) {
        this.db.exec('ALTER TABLE escalations ADD COLUMN raised_by_owner TEXT');
      }
      // v10: Accept / Reject answers with what each means, and files attached to escalations (kept in the database).
      if (version < 10 && !this.hasColumn('escalations', 'accept_means')) {
        this.db.exec(`
          ALTER TABLE escalations ADD COLUMN accept_means TEXT;
          ALTER TABLE escalations ADD COLUMN reject_means TEXT;
          ALTER TABLE escalations ADD COLUMN allow_reject INTEGER NOT NULL DEFAULT 1;
        `);
      }
      if (version < 10) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS attachments (
            id TEXT PRIMARY KEY,
            escalation_id TEXT REFERENCES escalations(id),
            position INTEGER,
            owner TEXT NOT NULL,
            uploaded_by TEXT NOT NULL,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            size INTEGER NOT NULL,
            data BLOB NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS attachments_escalation ON attachments(escalation_id, position);
          CREATE INDEX IF NOT EXISTS attachments_pending ON attachments(owner, created_at) WHERE escalation_id IS NULL;
        `);
      }
      // v11: conversations on escalations (the owner's Other, the agent's replies) and whose turn it is.
      if (version < 11 && !this.hasColumn('escalations', 'turn')) {
        this.db.exec(`
          ALTER TABLE escalations ADD COLUMN turn TEXT NOT NULL DEFAULT 'owner';
          ALTER TABLE attachments ADD COLUMN message_id INTEGER;
        `);
      }
      if (version < 11) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            escalation_id TEXT NOT NULL REFERENCES escalations(id),
            author_kind TEXT NOT NULL,
            author TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS messages_escalation ON messages(escalation_id, id);
          CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_id) WHERE message_id IS NOT NULL;
        `);
      }
      if (version < 12) {
        // v12: each project's TRMNL screen (the webhook LaneSignal pushes to, and what its card shows).
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS trmnl_setups (
            project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
            webhook_url TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            include_notifications INTEGER NOT NULL DEFAULT 0,
            card TEXT,
            last_push_at TEXT,
            last_error TEXT,
            last_error_at TEXT,
            updated_at TEXT NOT NULL
          );
        `);
      }
      if (version < 13) {
        // v13: a conversation on each lane (the agent's notices, now with files, and the owner's notes
        // back), and how far the agent has read. Earlier notices become its first messages.
        const fresh = !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lane_messages'").get();
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS lane_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lane_id TEXT NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
            author_kind TEXT NOT NULL,
            author TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS lane_messages_lane ON lane_messages(lane_id, id);
        `);
        if (!this.hasColumn('attachments', 'lane_message_id')) this.db.exec('ALTER TABLE attachments ADD COLUMN lane_message_id INTEGER');
        this.db.exec('CREATE INDEX IF NOT EXISTS attachments_lane_message ON attachments(lane_message_id) WHERE lane_message_id IS NOT NULL');
        if (!this.hasColumn('lanes', 'agent_read_id')) this.db.exec('ALTER TABLE lanes ADD COLUMN agent_read_id INTEGER NOT NULL DEFAULT 0');
        if (fresh) {
          this.db.exec(`
            INSERT INTO lane_messages (lane_id, author_kind, author, body, created_at)
              SELECT lane_id, 'agent', COALESCE(actor, 'agent'), message, at FROM lane_events WHERE kind = 'notice' ORDER BY id;
          `);
        }
      }
      if (version < 14) {
        // v14: whether a TRMNL screen's account has TRMNL+, which allows more pushes per hour.
        if (!this.hasColumn('trmnl_setups', 'plus')) this.db.exec('ALTER TABLE trmnl_setups ADD COLUMN plus INTEGER NOT NULL DEFAULT 0');
      }
      if (version < 15) {
        // v15: requirements wait for a person's approval. Those in force so far were recorded without one.
        this.db.exec("UPDATE requirements SET status = 'pending' WHERE status = 'active'");
      }
      if (version < 16) this.migrateV16();
      // v17: finding the lane a ticket last left reads only its ticket events.
      if (version < 17) this.db.exec("CREATE INDEX IF NOT EXISTS lane_events_ticket_switch ON lane_events(ticket_id, id) WHERE kind = 'ticket'");
      if (version < 18) this.migrateV18();
      // v19: rejecting a pending requirement says why.
      // The requirements a rejected replacement was to replace, so restoring it can link them again.
      if (version < 19 && !this.hasColumn('requirements', 'rejection_reason')) {
        this.db.exec('ALTER TABLE requirements ADD COLUMN rejection_reason TEXT; ALTER TABLE requirements ADD COLUMN rejected_replacing TEXT');
      }
      if (version < 20) this.migrateV20();
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(SCHEMA_VERSION));
    });
  }

  /**
   * Tickets: each lane's ticket becomes a record that owns its escalations and status history, so a
   * lane can set it aside and pick it up again (or another lane can). Lanes that share a ticket share
   * one record; a live lane holds it (the most recently updated one, if several did). Completed lanes
   * leave the dashboard, their tickets done.
   */
  private migrateV16() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        num INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        ref TEXT NOT NULL,
        display_ref TEXT NOT NULL,
        code_ref TEXT NOT NULL,
        next_seq INTEGER NOT NULL DEFAULT 1,
        group_id TEXT,
        lane_id TEXT,
        state TEXT NOT NULL,
        park_reason TEXT,
        waiting_on TEXT,
        status TEXT NOT NULL,
        status_since TEXT NOT NULL,
        blocked_since TEXT,
        blocked_total_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS tickets_ref ON tickets(project_id, ref);
      CREATE UNIQUE INDEX IF NOT EXISTS tickets_code ON tickets(project_id, code_ref COLLATE NOCASE);
      CREATE UNIQUE INDEX IF NOT EXISTS tickets_lane ON tickets(lane_id) WHERE lane_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS tickets_group ON tickets(group_id, state);
    `);
    if (!this.hasColumn('lanes', 'ticket_id')) this.db.exec('ALTER TABLE lanes ADD COLUMN ticket_id INTEGER');
    if (!this.hasColumn('escalations', 'ticket_id')) {
      this.db.exec(`
        ALTER TABLE escalations ADD COLUMN ticket_id INTEGER;
        ALTER TABLE escalations ADD COLUMN code TEXT;
        ALTER TABLE escalations ADD COLUMN legacy_ref TEXT;
      `);
      // Codes from before tickets (A12, or the global number before lane codes): kept, and resolving, forever.
      for (const r of this.db.prepare('SELECT rowid AS rid, ref, letter_index, seq FROM escalations').all() as Row[]) {
        this.db.prepare('UPDATE escalations SET legacy_ref = ? WHERE rowid = ?').run(this.codeOf(r), Number(r.rid));
      }
    }
    if (!this.hasColumn('lane_events', 'ticket_id')) this.db.exec('ALTER TABLE lane_events ADD COLUMN ticket_id INTEGER');
    // Who registered the group (its overseer's key, as escalations record their raiser).
    if (!this.hasColumn('groups', 'owner')) this.db.exec('ALTER TABLE groups ADD COLUMN owner TEXT');
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS escalations_ticket_code ON escalations(project_id, code COLLATE NOCASE) WHERE code IS NOT NULL;
      CREATE INDEX IF NOT EXISTS escalations_ticket ON escalations(ticket_id) WHERE ticket_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS lane_events_ticket ON lane_events(ticket_id, id) WHERE ticket_id IS NOT NULL;
    `);
    const at = this.now().toISOString();
    // What blocked each live lane before: its own open blocking questions.
    const blockedBefore = new Map(
      (
        this.db
          .prepare(
            `SELECT l.id, (SELECT COUNT(*) FROM escalations e WHERE e.lane_id = l.id AND e.state = 'open' AND e.blocking = 1
               AND e.turn = 'owner') AS n FROM lanes l WHERE l.archived_at IS NULL AND l.status <> 'completed'`,
          )
          .all() as Row[]
      ).map((r) => [r.id as string, Number(r.n)]),
    );
    // Live lanes first, most recently updated first, so a ticket two live lanes shared goes to the newer.
    const lanes = this.db
      .prepare(
        `SELECT id, project_id, group_id, ticket, status, status_since, blocked_since, blocked_total_ms, created_at,
           (archived_at IS NULL AND status <> 'completed') AS live
         FROM lanes WHERE ticket IS NOT NULL AND trim(ticket) <> '' AND ticket_id IS NULL
         ORDER BY live DESC, updated_at DESC`,
      )
      .all() as Row[];
    for (const l of lanes) {
      const laneId = l.id as string;
      const project = l.project_id as string;
      const raw = (l.ticket as string).trim();
      const ref = this.refs.canonical(raw);
      const live = Number(l.live) === 1;
      const held = this.db.prepare('SELECT num, lane_id FROM tickets WHERE project_id = ? AND ref = ?').get(project, ref) as Row | undefined;
      if (held && live && held.lane_id) {
        // Lanes that share a ref share one ticket, and a ticket is in one lane: the newer lane holds it.
        this.db.prepare('UPDATE lanes SET ticket = NULL WHERE id = ?').run(laneId);
        this.addEvent(laneId, at, 'ticket', `${this.refs.display(ref)} is held by lane "${localId(held.lane_id as string)}"`, null, null);
      }
      const num = held
        ? Number(held.num)
        : this.insertTicket(project, ref, raw, {
            group: (l.group_id as string | null) ?? null,
            lane: live ? laneId : null,
            state: live ? 'in_lane' : 'done',
            status: l.status as LaneStatus,
            statusSince: l.status_since as string,
            blockedSince: live ? ((l.blocked_since as string | null) ?? null) : null,
            blockedTotalMs: Number(l.blocked_total_ms),
            at: (l.created_at as string) ?? at,
            closedAt: live ? null : at,
          });
      if (live && !held) this.db.prepare('UPDATE lanes SET ticket_id = ? WHERE id = ?').run(num, laneId);
      this.db.prepare('UPDATE escalations SET ticket_id = ? WHERE lane_id = ? AND ticket_id IS NULL').run(num, laneId);
      this.db.prepare('UPDATE lane_events SET ticket_id = ? WHERE lane_id = ? AND ticket_id IS NULL').run(num, laneId);
    }
    // Questions now count where their ticket is: a lane that gained a blocking one shows blocked, and one
    // that lost them all (a twin whose ticket another lane holds) waits on its agent, as after an answer.
    for (const [laneId, before] of blockedBefore) {
      const lane = this.getLane(laneId);
      if (!lane) continue;
      const now = this.openBlockingCount(laneId);
      if (now > 0 && lane.status !== 'blocked_human') this.applyLaneUpdate(lane, { status: 'blocked_human' }, null, at);
      else if (now === 0 && before > 0 && lane.status === 'blocked_human') this.applyLaneUpdate(lane, { status: 'awaiting_agent' }, null, at);
    }
    // Completed lanes leave the dashboard; their tickets are done, so they don't come back as idle slots.
    const done = this.db.prepare(`SELECT id FROM lanes WHERE archived_at IS NULL AND status = 'completed'`).all() as Row[];
    for (const r of done) {
      this.db.prepare('UPDATE lanes SET archived_at = ?, letter_index = NULL WHERE id = ?').run(at, r.id as string);
      this.addEvent(r.id as string, at, 'status', 'Lane removed (completed, on upgrade)', null);
    }
  }

  /**
   * Escalation codes like "A12": a letter per active lane, numbered per letter.
   * Lanes that are active or still have unresolved escalations get letters in
   * creation order; earlier escalations of finished lanes get letters past
   * those, so every code stays unique.
   */
  private migrateV6() {
    this.db.exec(`
      ALTER TABLE lanes ADD COLUMN letter_index INTEGER;
      CREATE UNIQUE INDEX lanes_letter ON lanes(letter_index) WHERE letter_index IS NOT NULL;
      ALTER TABLE escalations ADD COLUMN letter_index INTEGER;
      ALTER TABLE escalations ADD COLUMN seq INTEGER;
      CREATE UNIQUE INDEX escalations_code ON escalations(letter_index, seq) WHERE letter_index IS NOT NULL;
    `);
    const lanes = this.db
      .prepare(
        `SELECT l.id, (l.archived_at IS NULL AND l.status <> 'completed') AS active,
           (SELECT COUNT(*) FROM escalations e WHERE e.lane_id = l.id AND e.state IN ('open', 'decided')) AS unresolved
         FROM lanes l ORDER BY l.rowid`,
      )
      .all() as Row[];
    const letters = new Map<string, number>();
    let next = 0;
    for (const l of lanes) {
      if (Number(l.active) || Number(l.unresolved)) {
        letters.set(l.id as string, next);
        this.db.prepare('UPDATE lanes SET letter_index = ? WHERE id = ?').run(next++, l.id as string);
      }
    }
    const seqs = new Map<number, number>();
    const rows = this.db.prepare('SELECT rowid AS rid, lane_id FROM escalations ORDER BY rowid').all() as Row[];
    for (const e of rows) {
      const laneId = e.lane_id as string;
      if (!letters.has(laneId)) letters.set(laneId, next++);
      const index = letters.get(laneId)!;
      const seq = (seqs.get(index) ?? 0) + 1;
      seqs.set(index, seq);
      this.db.prepare('UPDATE escalations SET letter_index = ?, seq = ? WHERE rowid = ?').run(index, seq, Number(e.rid));
    }
  }

  /**
   * Projects: independent applications, each with its own groups, lanes,
   * escalations and requirements. Lane and group ids become qualified with
   * their project ("default/auth-rework"), so ids only need to be unique
   * within a project; `project_id` is derived from them. Existing data moves
   * into the first project.
   */
  private migrateV8() {
    const at = this.now().toISOString();
    this.db.exec('PRAGMA defer_foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE project_members (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        notify INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (project_id, user_id)
      );
      -- Push choices of people who see a project without being a member (instance admins).
      CREATE TABLE project_notify (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        notify INTEGER NOT NULL,
        PRIMARY KEY (project_id, user_id)
      );
      UPDATE groups SET id = '${DEFAULT_PROJECT}/' || id;
      UPDATE lanes SET id = '${DEFAULT_PROJECT}/' || id,
        group_id = CASE WHEN group_id IS NULL THEN NULL ELSE '${DEFAULT_PROJECT}/' || group_id END;
      UPDATE escalations SET lane_id = '${DEFAULT_PROJECT}/' || lane_id;
      UPDATE lane_events SET lane_id = '${DEFAULT_PROJECT}/' || lane_id;
      UPDATE requirements SET group_id = '${DEFAULT_PROJECT}/' || group_id WHERE group_id IS NOT NULL;
      ALTER TABLE groups ADD COLUMN project_id TEXT GENERATED ALWAYS AS (substr(id, 1, instr(id, '/') - 1)) VIRTUAL;
      ALTER TABLE lanes ADD COLUMN project_id TEXT GENERATED ALWAYS AS (substr(id, 1, instr(id, '/') - 1)) VIRTUAL;
      ALTER TABLE escalations ADD COLUMN project_id TEXT GENERATED ALWAYS AS (substr(lane_id, 1, instr(lane_id, '/') - 1)) VIRTUAL;
      ALTER TABLE requirements ADD COLUMN project_id TEXT;
      UPDATE requirements SET project_id = '${DEFAULT_PROJECT}';
      DROP INDEX lanes_letter;
      CREATE UNIQUE INDEX lanes_letter ON lanes(project_id, letter_index) WHERE letter_index IS NOT NULL;
      DROP INDEX escalations_code;
      CREATE UNIQUE INDEX escalations_code ON escalations(project_id, letter_index, seq) WHERE letter_index IS NOT NULL;
      CREATE INDEX lanes_project ON lanes(project_id);
      CREATE INDEX escalations_project ON escalations(project_id, state);
    `);
    this.db
      .prepare('INSERT INTO projects (id, key, name, created_at) VALUES (?, ?, ?, ?)')
      .run(DEFAULT_PROJECT, 'MAIN', 'Main', at);
  }

  /**
   * v20: products within a project, and an explicit scope on every requirement (global, project-wide,
   * or products). Requirements in force from before are flagged for a person to regroup: they keep
   * counting as project-wide (or global) meanwhile, so none drop out of what agents see.
   */
  private migrateV20() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS products (
        project_id TEXT NOT NULL REFERENCES projects(id),
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        color TEXT,
        locked INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, id)
      );
      CREATE TABLE IF NOT EXISTS requirement_products (
        requirement_num INTEGER NOT NULL REFERENCES requirements(num),
        project_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        PRIMARY KEY (requirement_num, product_id),
        FOREIGN KEY (project_id, product_id) REFERENCES products(project_id, id)
      );
      CREATE INDEX IF NOT EXISTS requirement_products_product ON requirement_products(project_id, product_id);
      CREATE TABLE IF NOT EXISTS requirement_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        requirement_num INTEGER NOT NULL REFERENCES requirements(num),
        kind TEXT NOT NULL,
        actor TEXT NOT NULL,
        from_value TEXT NOT NULL,
        to_value TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS requirement_changes_requirement ON requirement_changes(requirement_num, id);
    `);
    if (!this.hasColumn('requirements', 'scope')) {
      this.db.exec(`
        ALTER TABLE requirements ADD COLUMN scope TEXT NOT NULL DEFAULT 'project';
        ALTER TABLE requirements ADD COLUMN needs_regrouping INTEGER NOT NULL DEFAULT 0;
        UPDATE requirements SET scope = CASE WHEN project_id IS NULL THEN 'global' ELSE 'project' END;
        UPDATE requirements SET needs_regrouping = 1 WHERE status IN ('pending', 'active');
      `);
    }
  }

  private hasColumn(table: string, column: string) {
    return (this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some((c) => c.name === column);
  }

  private hasTable(table: string) {
    return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  }

  /**
   * Epics: every group gets one (its ticket's, or the group standing in), each question raised on a
   * lane holding no ticket moves to its group's epic (keeping its code), and those lanes show idle.
   * Lanes in no group get a per-project "Ungrouped" group, so they have an epic too.
   */
  private migrateV18() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS epics (
        num INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        ref TEXT,
        display_ref TEXT,
        code_ref TEXT NOT NULL,
        next_seq INTEGER NOT NULL DEFAULT 1,
        name TEXT NOT NULL,
        links TEXT NOT NULL DEFAULT '[]',
        status_line TEXT,
        state TEXT NOT NULL,
        stand_in INTEGER NOT NULL DEFAULT 0,
        close_reason TEXT,
        close_requested_by TEXT,
        agent_read_id INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS epics_ref ON epics(project_id, ref) WHERE ref IS NOT NULL;
      CREATE INDEX IF NOT EXISTS epics_group ON epics(group_id, state);
      CREATE TABLE IF NOT EXISTS epic_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        epic_id INTEGER NOT NULL REFERENCES epics(num) ON DELETE CASCADE,
        author_kind TEXT NOT NULL,
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS epic_messages_epic ON epic_messages(epic_id, id);
    `);
    if (!this.hasColumn('attachments', 'epic_message_id')) this.db.exec('ALTER TABLE attachments ADD COLUMN epic_message_id INTEGER');
    this.db.exec('CREATE INDEX IF NOT EXISTS attachments_epic_message ON attachments(epic_message_id) WHERE epic_message_id IS NOT NULL');
    if (!this.hasColumn('tickets', 'epic_id')) this.db.exec('ALTER TABLE tickets ADD COLUMN epic_id INTEGER');
    if (!this.hasColumn('escalations', 'epic_id')) {
      this.db.exec('ALTER TABLE escalations ADD COLUMN epic_id INTEGER; CREATE INDEX IF NOT EXISTS escalations_epic ON escalations(epic_id) WHERE epic_id IS NOT NULL;');
    }
    const at = this.now().toISOString();
    for (const g of this.db.prepare('SELECT * FROM groups ORDER BY rowid').all() as Row[]) {
      if (this.db.prepare('SELECT 1 FROM epics WHERE group_id = ?').get(g.id as string)) continue;
      const project = g.project_id as string;
      const ticket = (g.ticket as string | null)?.trim();
      // A group with a ticket gets a real epic for it; the others stand in as their own. An epic has
      // one group, so a second group with the same ticket (a train and the one that replaced it) stands in.
      const ref = ticket ? this.refs.canonical(ticket) : null;
      const taken = ref && this.db.prepare('SELECT 1 FROM epics WHERE project_id = ? AND ref = ?').get(project, ref);
      this.insertEpic(project, g.id as string, {
        ref: taken ? null : ref,
        displayRef: taken ? null : ticket || null,
        name: g.name as string,
        links: g.links as string,
        at,
      });
    }
    // Lanes in no group join their project's "Ungrouped" group, so every lane has an epic.
    for (const r of this.db.prepare(`SELECT id, project_id FROM lanes WHERE group_id IS NULL AND instr(id, '/~') = 0`).all() as Row[]) {
      this.db.prepare('UPDATE lanes SET group_id = ? WHERE id = ?').run(this.ungroupedGroup(r.project_id as string, at), r.id as string);
    }
    // Questions raised on a lane holding no ticket belong to its group's epic.
    const loose = this.db
      .prepare(
        `SELECT e.rowid AS rid, l.id AS lane_id, l.group_id, l.project_id FROM escalations e JOIN lanes l ON l.id = e.lane_id
         WHERE e.ticket_id IS NULL AND e.epic_id IS NULL`,
      )
      .all() as Row[];
    for (const r of loose) {
      const groupId = (r.group_id as string | null) ?? this.ungroupedGroup(r.project_id as string, at);
      const epic = this.openEpicsOf(groupId)[0];
      this.db.prepare('UPDATE escalations SET epic_id = ? WHERE rowid = ?').run(Number(epic.num), Number(r.rid));
    }
    // A lane holding a ticket that its own questions no longer block (they were raised before it took
    // the ticket, and are the epic's now) stops showing blocked.
    for (const r of this.db
      .prepare(
        `SELECT l.id FROM lanes l WHERE l.archived_at IS NULL AND l.ticket_id IS NOT NULL AND l.status = 'blocked_human'
           AND EXISTS (SELECT 1 FROM escalations e WHERE e.lane_id = l.id AND e.ticket_id IS NULL AND e.state = 'open'
                         AND e.blocking = 1 AND e.turn = 'owner')`,
      )
      .all() as Row[]) {
      const lane = this.getLane(r.id as string);
      if (lane && this.openBlockingCount(lane.id) === 0) this.applyLaneUpdate(lane, { status: 'awaiting_agent' }, null, at);
    }
    // A lane with no ticket shows idle.
    for (const r of this.db
      .prepare(`SELECT id FROM lanes WHERE archived_at IS NULL AND ticket_id IS NULL AND status <> 'idle' AND instr(id, '/~') = 0`)
      .all() as Row[]) {
      const lane = this.getLane(r.id as string);
      if (lane) this.setLaneStatus(lane, 'idle', 0, null, at);
    }
  }

  private migrateV1() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        ticket TEXT,
        links TEXT NOT NULL DEFAULT '[]',
        agent TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lanes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        ticket TEXT,
        activity TEXT,
        links TEXT NOT NULL DEFAULT '[]',
        agent TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status_since TEXT NOT NULL,
        blocked_since TEXT,
        blocked_total_ms INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS escalations (
        id TEXT PRIMARY KEY,
        lane_id TEXT NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
        question TEXT NOT NULL,
        context TEXT,
        recommendation TEXT,
        recommended_option TEXT,
        positions TEXT NOT NULL DEFAULT '[]',
        options TEXT NOT NULL DEFAULT '[]',
        links TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        decision TEXT,
        decision_note TEXT,
        decided_by TEXT,
        decided_at TEXT,
        acknowledged_at TEXT,
        resolution TEXT
      );
      CREATE INDEX IF NOT EXISTS escalations_state ON escalations(state);
      CREATE INDEX IF NOT EXISTS escalations_lane ON escalations(lane_id);
      CREATE TABLE IF NOT EXISTS lane_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lane_id TEXT NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        actor TEXT
      );
      CREATE INDEX IF NOT EXISTS lane_events_lane ON lane_events(lane_id, id);
      CREATE TABLE IF NOT EXISTS push_tokens (
        token TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        owner TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private emit(event: StreamEvent) {
    // An epic's internal lane is never shown.
    if (event.type === 'lane' && Store.isEpicLane(event.lane.id)) return;
    this.events.emit('change', event);
    // An epic's card counts its questions.
    if (event.type === 'escalation' && event.escalation.epicId !== null) this.emitEpic(event.escalation.epicId);
  }

  // ---- groups ------------------------------------------------------------

  private groupFromRow(r: Row): Group {
    const ticket = (r.ticket as string | null) ?? null;
    return {
      id: r.id as string,
      project: r.project_id as string,
      name: r.name as string,
      ticket,
      ticketUrl: ticket ? this.resolveTicketUrl(ticket) : null,
      links: JSON.parse(r.links as string) as Link[],
      agent: (r.agent as string | null) ?? null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  }

  /** `AND project_id IN (...)` for an optional project list (undefined = every project). */
  private inProjects(projects: string[] | undefined, column = 'project_id') {
    if (!projects) return { sql: '', params: [] as string[] };
    if (!projects.length) return { sql: ' AND 0', params: [] as string[] };
    return { sql: ` AND ${column} IN (${projects.map(() => '?').join(',')})`, params: projects };
  }

  /** Active groups (archived ones are kept for export but hidden), optionally of some projects only. */
  listGroups(projects?: string[]): Group[] {
    const p = this.inProjects(projects);
    return (
      this.db.prepare(`SELECT * FROM groups WHERE archived_at IS NULL${p.sql} ORDER BY name`).all(...p.params) as Row[]
    ).map((r) => this.groupFromRow(r));
  }

  /** Whether the group exists, archived or not (publishing to an archived one restores it). */
  groupExists(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM groups WHERE id = ?').get(id);
  }

  /** Whether the lane exists, archived or not (publishing to a removed one restores it). */
  laneExists(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM lanes WHERE id = ?').get(id);
  }

  getGroup(id: string): Group | null {
    const r = this.db.prepare('SELECT * FROM groups WHERE id = ? AND archived_at IS NULL').get(id) as Row | undefined;
    return r ? this.groupFromRow(r) : null;
  }

  /**
   * Must run inside a transaction. Publishing to an archived group brings it
   * back; returns true in that case so callers re-emit its lanes, which clients
   * have been showing as ungrouped. A group's `ticket` is read-only (its epic has it now):
   * `patch.ticket` is ignored.
   */
  private writeGroup(id: string, patch: GroupPatch, actor: string | null, at: string, owner?: string): boolean {
    const restored =
      this.db.prepare('UPDATE groups SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL').run(id).changes > 0;
    const existing = this.getGroup(id);
    if (!existing) {
      this.db
        .prepare('INSERT INTO groups (id, name, links, agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, patch.name ?? localId(id), JSON.stringify(patch.links ?? []), actor, at, at);
      if (owner) this.db.prepare('UPDATE groups SET owner = ? WHERE id = ?').run(owner, id);
      // Every group has an epic: a new one starts with its stand-in.
      this.ensureEpic(id, at);
      return false;
    }
    if (owner) this.db.prepare('UPDATE groups SET owner = ? WHERE id = ?').run(owner, id);
    if (patch.name === undefined && patch.links === undefined) return restored;
    this.db
      .prepare('UPDATE groups SET name = ?, links = ?, agent = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.name ?? existing.name,
        JSON.stringify(patch.links ?? existing.links),
        actor ?? existing.agent,
        at,
        id,
      );
    return restored;
  }

  /** Re-sends a restored group's lanes, which clients have been showing as ungrouped. */
  private emitGroupLanes(groupId: string, exceptLaneId?: string) {
    for (const lane of this.listLanes()) {
      if (lane.group === groupId && lane.id !== exceptLaneId) this.emit({ type: 'lane', lane });
    }
  }

  /** `owner`: the registering key ("user:<account>:<key name>"), recorded as the group's overseer. */
  upsertGroup(id: string, patch: GroupPatch, actor: string | null, owner?: string): Group {
    projectOf(id);
    const { group, restored } = this.tx(() => {
      const restored = this.writeGroup(id, patch, actor, this.now().toISOString(), owner);
      return { group: this.getGroup(id)!, restored };
    });
    this.emit({ type: 'group', group });
    this.emitGroupEpics(id);
    if (restored) this.emitGroupLanes(id);
    return group;
  }

  /**
   * Archives the group: it disappears from the dashboard and its lanes show as
   * ungrouped, but lanes keep their group id so exports still attribute them.
   */
  deleteGroup(id: string, actor: string | null = null) {
    const lanes = this.tx(() => {
      const affected = this.listLanes()
        .filter((l) => l.group === id)
        .map((l) => l.id);
      const at = this.now().toISOString();
      const res = this.db.prepare('UPDATE groups SET archived_at = ? WHERE id = ? AND archived_at IS NULL').run(at, id);
      if (res.changes === 0) throw new NotFoundError(`Group "${localId(id)}" not found`);
      for (const laneId of affected) this.addEvent(laneId, at, 'status', `Group "${localId(id)}" removed`, actor);
      return affected.map((laneId) => this.requireLane(laneId));
    });
    this.emit({ type: 'group_deleted', id, project: projectOf(id) });
    for (const lane of lanes) this.emit({ type: 'lane', lane });
  }

  // ---- lanes -------------------------------------------------------------

  private laneFromRow(r: Row): Lane {
    // The ticket it holds, as first written. lanes.ticket is read-only (text from before tickets, for export).
    const ticket = (r.ticket_ref as string | null) ?? null;
    return {
      id: r.id as string,
      project: r.project_id as string,
      letter: r.letter_index == null ? null : letterOf(Number(r.letter_index)),
      name: r.name as string,
      // A lane in an archived group shows as ungrouped; the raw group_id is kept for exports.
      group: r.group_archived ? null : ((r.group_id as string | null) ?? null),
      status: r.status as LaneStatus,
      ticket,
      // From the canonical ref, as the ticket's own record resolves it.
      ticketUrl: r.ticket_canonical
        ? (this.resolveTicketUrl(r.ticket_canonical as string) ?? (/^https?:\/\//i.test(r.ticket_canonical as string) ? (r.ticket_canonical as string) : null))
        : null,
      ticketId: r.ticket_id == null ? null : Number(r.ticket_id),
      waitingOn: r.ticket_waiting_on ? this.refs.display(r.ticket_waiting_on as string) : null,
      activity: (r.activity as string | null) ?? null,
      links: JSON.parse(r.links as string) as Link[],
      agent: (r.agent as string | null) ?? null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      statusSince: r.status_since as string,
      blockedSince: (r.blocked_since as string | null) ?? null,
      blockedTotalMs: Number(r.blocked_total_ms),
      openEscalations: Number(r.open_escalations ?? 0),
      blockingEscalations: Number(r.open_blocking ?? 0),
      agentWaiting: (this.waiting.get(r.id as string) ?? 0) > 0,
      lastMessageId: r.last_message_id == null ? null : Number(r.last_message_id),
      lastAgentMessageId: r.last_agent_message_id == null ? null : Number(r.last_agent_message_id),
      unreadByAgent: Number(r.unread_by_agent ?? 0),
    };
  }

  private static LANE_SELECT = `
    SELECT l.*,
      (SELECT COUNT(*) FROM escalations e WHERE e.state = 'open' AND e.ticket_id = l.ticket_id) AS open_escalations,
      (SELECT COUNT(*) FROM escalations e WHERE e.state = 'open' AND e.blocking = 1 AND e.turn = 'owner'
         AND e.ticket_id = l.ticket_id) AS open_blocking,
      (SELECT t.waiting_on FROM tickets t WHERE t.num = l.ticket_id) AS ticket_waiting_on,
      (SELECT t.display_ref FROM tickets t WHERE t.num = l.ticket_id) AS ticket_ref,
      (SELECT t.ref FROM tickets t WHERE t.num = l.ticket_id) AS ticket_canonical,
      (SELECT g.archived_at IS NOT NULL FROM groups g WHERE g.id = l.group_id) AS group_archived,
      (SELECT MAX(m.id) FROM lane_messages m WHERE m.lane_id = l.id) AS last_message_id,
      (SELECT MAX(m.id) FROM lane_messages m WHERE m.lane_id = l.id AND m.author_kind = 'agent') AS last_agent_message_id,
      (SELECT COUNT(*) FROM lane_messages m WHERE m.lane_id = l.id AND m.author_kind = 'owner' AND m.id > l.agent_read_id) AS unread_by_agent
    FROM lanes l`;

  /** Active lanes (archived ones are kept for export but hidden; epics' internal lanes are never listed). */
  listLanes(projects?: string[]): Lane[] {
    const p = this.inProjects(projects, 'l.project_id');
    return (
      this.db
        .prepare(`${Store.LANE_SELECT} WHERE l.archived_at IS NULL AND instr(l.id, '/~') = 0${p.sql} ORDER BY l.updated_at DESC`)
        .all(...p.params) as Row[]
    ).map((r) => this.laneFromRow(r));
  }

  getLane(id: string): Lane | null {
    const r = this.db.prepare(`${Store.LANE_SELECT} WHERE l.id = ? AND l.archived_at IS NULL`).get(id) as Row | undefined;
    return r ? this.laneFromRow(r) : null;
  }

  /** Any lane, archived or not, for steps that must still work after a lane is removed. */
  private laneIncludingArchived(id: string): { lane: Lane; archived: boolean } | null {
    const r = this.db.prepare(`${Store.LANE_SELECT} WHERE l.id = ?`).get(id) as Row | undefined;
    return r ? { lane: this.laneFromRow(r), archived: r.archived_at != null } : null;
  }

  /** Must run inside a transaction: publishing to an archived lane brings it back, history intact. Returns whether it did. */
  private restoreLane(id: string, actor: string | null, at: string): boolean {
    const res = this.db.prepare('UPDATE lanes SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL').run(id);
    if (res.changes > 0) this.addEvent(id, at, 'status', 'Lane restored', actor);
    return res.changes > 0;
  }

  /**
   * Must run inside a transaction. A lane holds a letter while it's active
   * (not completed or removed) or still has unresolved escalations; then the
   * letter is freed for the next lane. `hold` assigns one regardless, for a
   * lane that's about to get an escalation.
   */
  private syncLetter(laneId: string, hold = false) {
    if (Store.isEpicLane(laneId)) return;
    const r = this.db
      .prepare(
        `SELECT letter_index, (archived_at IS NULL AND status <> 'completed') AS active,
           (SELECT COUNT(*) FROM escalations e WHERE e.lane_id = lanes.id AND e.state IN ('open', 'decided')) AS unresolved
         FROM lanes WHERE id = ?`,
      )
      .get(laneId) as Row | undefined;
    if (!r) return;
    const needs = hold || Number(r.active) === 1 || Number(r.unresolved) > 0;
    if (needs && r.letter_index == null) {
      const used = new Set(
        (
          this.db
            .prepare('SELECT letter_index FROM lanes WHERE letter_index IS NOT NULL AND project_id = ?')
            .all(projectOf(laneId)) as Row[]
        ).map((x) => Number(x.letter_index)),
      );
      let index = 0;
      while (used.has(index)) index++;
      this.db.prepare('UPDATE lanes SET letter_index = ? WHERE id = ?').run(index, laneId);
    } else if (!needs && r.letter_index != null) {
      this.db.prepare('UPDATE lanes SET letter_index = NULL WHERE id = ?').run(laneId);
    }
  }

  private requireLane(id: string): Lane {
    const lane = this.getLane(id);
    if (!lane) throw new NotFoundError(`Lane "${localId(id)}" not found`);
    return lane;
  }

  /**
   * Publishes a lane, creating it on first use. A `ticket` different from the one it holds switches
   * tickets: the held one is parked, done or dropped (`fill.previous`), and the new one moves in with
   * its escalations and status, created on first use. Status `completed` finishes the held ticket and
   * empties the lane.
   */
  upsertLane(id: string, patch: LanePatch, actor: string | null, fill: LaneFill = {}): Lane & { warning?: string } {
    projectOf(id);
    if (patch.group && projectOf(patch.group) !== projectOf(id)) throw new Error('internal: a lane\'s group must be in its project');
    if (patch.status && !LANE_STATUSES.includes(patch.status)) throw new Error(`Invalid status "${patch.status}"`);
    // A typo would otherwise put a lane in a new group nobody waits on.
    if (patch.group && !this.groupExists(patch.group)) {
      throw new NotFoundError(`Group "${localId(patch.group)}" not found: register it first (update_group, or PUT /api/groups/:id)`);
    }
    let createdGroup: Group | null = null;
    let groupRestored = false;
    let previous: LaneStatus | null = null;
    const touched: Touched = { escalations: new Set(), lanes: new Set(), tickets: new Set() };
    let warning: string | undefined;
    let finished = false;
    const lane = this.tx(() => {
      const at = this.now().toISOString();
      this.restoreLane(id, actor, at);
      previous = this.getLane(id)?.status ?? null;
      if (patch.group && !this.getGroup(patch.group)) {
        groupRestored = this.writeGroup(patch.group, {}, actor, at);
        createdGroup = this.getGroup(patch.group);
      }
      const { ticket, ...rest } = patch;
      let existing = this.getLane(id);
      // Every lane is in a group, so a question it raises without a ticket has an epic to go to.
      if ((!existing && !rest.group) || rest.group === null) {
        const ungrouped = qualify(projectOf(id), 'ungrouped');
        const isNew = !this.getGroup(ungrouped);
        rest.group = this.ungroupedGroup(projectOf(id), at);
        if (isNew) createdGroup = this.getGroup(ungrouped);
      }
      if (!existing) {
        // A lane with no ticket shows idle.
        const status = ticket?.trim() ? (rest.status ?? 'active') : 'idle';
        this.db
          .prepare(
            `INSERT INTO lanes (id, name, group_id, status, activity, links, agent, created_at, updated_at, status_since, blocked_since)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            rest.name ?? localId(id),
            rest.group ?? null,
            status,
            rest.activity ?? null,
            JSON.stringify(rest.links ?? []),
            actor,
            at,
            at,
            at,
            status === 'blocked_human' ? at : null,
          );
        this.addEvent(id, at, 'status', `Lane created (${status})`, actor, null);
        if (rest.activity) this.addEvent(id, at, 'activity', rest.activity, actor, null);
        existing = this.requireLane(id);
      }
      // The group first, so a ticket moving in is recorded in the lane's new group.
      if (rest.group !== undefined) this.db.prepare('UPDATE lanes SET group_id = ? WHERE id = ?').run(rest.group, id);
      if (ticket !== undefined) warning = this.switchTicket(this.requireLane(id), ticket, rest.status, fill, actor, at, touched);
      this.applyLaneUpdate(this.requireLane(id), rest, actor, at);
      // Completed finishes the ticket: the lane lets it go and waits for the next.
      const after = this.requireLane(id);
      if (after.status === 'completed' && after.ticketId !== null) {
        this.releaseTicket(after, 'done', fill.reason ?? null, actor, at, touched);
        this.emptyLane(this.requireLane(id), actor, at);
        finished = true;
      }
      // A lane with no ticket shows idle, whatever status was asked for.
      const empty = this.requireLane(id);
      if (empty.ticketId === null && empty.status !== 'idle') {
        this.setLaneStatus(empty, 'idle', 0, actor, at);
      }
      if (empty.ticketId === null && rest.status && rest.status !== 'idle' && rest.status !== 'completed') {
        warning = [warning, `Lane "${localId(id)}" holds no ticket, so it shows idle: fill it with a ticket (fill_lane) to show it working.`]
          .filter(Boolean)
          .join(' ');
      }
      if (fill.waitingOn !== undefined) {
        const holding = this.requireLane(id).ticketId;
        if (holding !== null) touched.tickets.add(holding);
        const note = this.setWaitingOn(this.requireLane(id), fill.waitingOn, at);
        if (note) warning = [warning, note].filter(Boolean).join(' ');
      }
      if (fill.epic !== undefined) {
        const note = this.setTicketEpic(this.requireLane(id), fill.epic, at, touched);
        if (note) warning = [warning, note].filter(Boolean).join(' ');
      }
      this.db.prepare('UPDATE tickets SET group_id = (SELECT group_id FROM lanes WHERE id = ?) WHERE lane_id = ?').run(id, id);
      this.syncLetter(id);
      for (const other of touched.lanes) if (other !== id) this.syncLetter(other);
      return this.requireLane(id);
    });
    if (createdGroup) {
      this.emit({ type: 'group', group: createdGroup });
      this.emitGroupEpics((createdGroup as Group).id);
    }
    if (groupRestored && patch.group) this.emitGroupLanes(patch.group, id);
    this.emitTouched(touched, id);
    this.emit({ type: 'lane', lane, statusChanged: previous !== lane.status || finished, ...(finished ? { completed: true } : {}) });
    return warning ? { ...lane, warning } : lane;
  }

  /** Must run inside a transaction. */
  private applyLaneUpdate(existing: Lane, patch: LanePatch, actor: string | null, at: string) {
    // A lane stays blocked while a blocking question is still open, so the dashboard keeps showing it.
    const stillBlocked = existing.status === 'blocked_human' && this.openBlockingCount(existing.id) > 0;
    const status = stillBlocked ? 'blocked_human' : (patch.status ?? existing.status);
    let statusSince = existing.statusSince;
    let blockedSince = existing.blockedSince;
    let blockedTotalMs = existing.blockedTotalMs;
    if (status !== existing.status) {
      statusSince = at;
      if (existing.status === 'blocked_human' && blockedSince) {
        blockedTotalMs += Date.parse(at) - Date.parse(blockedSince);
        blockedSince = null;
      }
      if (status === 'blocked_human') blockedSince = at;
      this.addEvent(existing.id, at, 'status', `${existing.status} → ${status}`, actor);
    }
    if (patch.activity !== undefined && patch.activity && patch.activity !== existing.activity) {
      this.addEvent(existing.id, at, 'activity', patch.activity, actor);
    }
    this.db
      .prepare(
        `UPDATE lanes SET name = ?, group_id = CASE WHEN ? THEN ? ELSE group_id END, status = ?, activity = ?, links = ?, agent = ?,
           updated_at = ?, status_since = ?, blocked_since = ?, blocked_total_ms = ? WHERE id = ?`,
      )
      .run(
        patch.name ?? existing.name,
        // Only touch group_id when the patch sets it: a lane in an archived group reads as
        // ungrouped but keeps its group_id for exports.
        patch.group !== undefined ? 1 : 0,
        patch.group ?? null,
        status,
        patch.activity !== undefined ? patch.activity : existing.activity,
        JSON.stringify(patch.links ?? existing.links),
        actor ?? existing.agent,
        at,
        statusSince,
        blockedSince,
        blockedTotalMs,
        existing.id,
      );
  }

  /**
   * Archives the lane: it leaves the dashboard and everything stays in the database for export.
   * Its ticket is let go as `previous` says (parked by default) and keeps its questions; those raised
   * while the lane held no ticket stay with their epic. Publishing to the same lane id later restores it.
   */
  deleteLane(id: string, actor: string | null = null, release: { previous?: TicketRelease; reason?: string | null } = {}) {
    const touched: Touched = { escalations: new Set(), lanes: new Set(), tickets: new Set() };
    this.tx(() => {
      const lane = Store.isEpicLane(id) ? null : this.getLane(id);
      if (!lane) throw new NotFoundError(`Lane "${localId(id)}" not found`);
      const at = this.now().toISOString();
      if (lane.ticketId !== null) {
        const how = release.previous ?? (lane.status === 'completed' ? 'done' : 'park');
        this.releaseTicket(lane, how, release.reason?.trim() || (how === 'park' ? 'Lane removed' : null), actor, at, touched);
      }
      // Questions raised here stay with their ticket or epic.
      // End any blocked spell now, so archived time isn't counted as blocked.
      const now = this.requireLane(id);
      if (now.status === 'blocked_human') this.applyLaneUpdate(now, { status: 'idle' }, actor, at);
      this.db.prepare('UPDATE lanes SET ticket_id = NULL, archived_at = ?, updated_at = ? WHERE id = ?').run(at, at, id);
      this.addEvent(id, at, 'status', 'Lane removed', actor, null);
      this.syncLetter(id);
    });
    this.emitTouched(touched, id);
    this.emit({ type: 'lane_deleted', id, project: projectOf(id) });
  }

  /** `ticketId`: the ticket it concerns; by default the one the lane holds. */
  private addEvent(laneId: string, at: string, kind: LaneEvent['kind'], message: string, actor: string | null, ticketId?: number | null) {
    this.db
      .prepare(
        `INSERT INTO lane_events (lane_id, at, kind, message, actor, ticket_id)
         VALUES (?, ?, ?, ?, ?, ${ticketId === undefined ? '(SELECT ticket_id FROM lanes WHERE id = ?)' : '?'})`,
      )
      .run(laneId, at, kind, message, actor, ticketId === undefined ? laneId : ticketId);
    // Only routine activity text is capped; status changes and escalation history are kept for analysis.
    if (kind === 'activity') {
      this.db
        .prepare(
          `DELETE FROM lane_events WHERE lane_id = ? AND kind = 'activity' AND id NOT IN
             (SELECT id FROM lane_events WHERE lane_id = ? AND kind = 'activity' ORDER BY id DESC LIMIT ?)`,
        )
        .run(laneId, laneId, this.retention);
    }
  }

  /** A lane's history, latest first. `withMessages: false` leaves out its conversation (shown on its own). */
  laneEvents(laneId: string, limit = 50, withMessages = true): LaneEvent[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM lane_events WHERE lane_id = ?${withMessages ? '' : " AND kind NOT IN ('notice', 'message')"} ORDER BY id DESC LIMIT ?`,
        )
        .all(laneId, limit) as Row[]
    ).map((r) => this.laneEventFromRow(r));
  }

  private laneEventFromRow(r: Row): LaneEvent {
    return {
      id: Number(r.id),
      laneId: r.lane_id as string,
      at: r.at as string,
      kind: r.kind as LaneEvent['kind'],
      message: r.message as string,
      actor: (r.actor as string | null) ?? null,
      ticketId: r.ticket_id == null ? null : Number(r.ticket_id),
    };
  }

  // ---- epics --------------------------------------------------------------

  /**
   * Questions raised on an epic directly are filed on its internal lane, never listed or shown:
   * "<project>/~epic-<n>". Escalations need a lane they were raised in; this is that lane for them.
   */
  static epicLaneId = (project: string, num: number) => `${project}/~epic-${num}`;
  static isEpicLane = (laneId: string) => laneId.includes('/~epic-');

  /** Whether a code prefix is in use in the project, by a ticket or an epic (other than the ones named). */
  private codeRefTaken(project: string, code: string, except: { ticket?: number; epic?: number } = {}) {
    if (this.db.prepare('SELECT 1 FROM tickets WHERE project_id = ? AND code_ref = ? COLLATE NOCASE AND num <> ?').get(project, code, except.ticket ?? -1)) {
      return true;
    }
    return (
      this.hasTable('epics') &&
      !!this.db.prepare('SELECT 1 FROM epics WHERE project_id = ? AND code_ref = ? COLLATE NOCASE AND num <> ?').get(project, code, except.epic ?? -1)
    );
  }

  /**
   * Must run inside a transaction. The next escalation code for a prefix: one letter sequence per
   * prefix, shared by a ticket and an epic with the same ref, skipping any code already taken.
   */
  private allocCode(project: string, codeRef: string): string {
    const rows = [
      ...(this.db.prepare('SELECT next_seq FROM tickets WHERE project_id = ? AND code_ref = ? COLLATE NOCASE').all(project, codeRef) as Row[]),
      ...(this.hasTable('epics')
        ? (this.db.prepare('SELECT next_seq FROM epics WHERE project_id = ? AND code_ref = ? COLLATE NOCASE').all(project, codeRef) as Row[])
        : []),
    ];
    let seq = Math.max(1, ...rows.map((r) => Number(r.next_seq)));
    const taken = (code: string) => !!this.db.prepare('SELECT 1 FROM escalations WHERE project_id = ? AND code = ? COLLATE NOCASE').get(project, code);
    while (taken(`${codeRef}${letterOf(seq - 1)}`)) seq++;
    this.db.prepare('UPDATE tickets SET next_seq = ? WHERE project_id = ? AND code_ref = ? COLLATE NOCASE').run(seq + 1, project, codeRef);
    if (this.hasTable('epics')) {
      this.db.prepare('UPDATE epics SET next_seq = ? WHERE project_id = ? AND code_ref = ? COLLATE NOCASE').run(seq + 1, project, codeRef);
    }
    return `${codeRef}${letterOf(seq - 1)}`;
  }

  /**
   * Must run inside a transaction. Creates an epic, with its internal board lane. `ref` null makes
   * the group's stand-in epic, coded with the group's id.
   */
  private insertEpic(
    project: string,
    groupId: string,
    e: { ref: string | null; displayRef: string | null; name: string; links?: string; at: string },
  ): number {
    const num = Number(
      this.db
        .prepare(
          `INSERT INTO epics (project_id, group_id, ref, display_ref, code_ref, name, links, state, stand_in, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
        )
        .run(project, groupId, e.ref, e.displayRef, `pending:${randomUUID()}`, e.name, e.links ?? '[]', e.ref ? 0 : 1, e.at, e.at).lastInsertRowid,
    );
    // A ref that's also a ticket shares the ticket's codes: one letter sequence per ref.
    const ticket = e.ref
      ? (this.db.prepare('SELECT code_ref FROM tickets WHERE project_id = ? AND ref = ?').get(project, e.ref) as Row | undefined)
      : undefined;
    const taken = (c: string) => this.codeRefTaken(project, c, { epic: num });
    const usable = (c: string | null | undefined): c is string => !!c && CODE_REF.test(c) && /\d$/.test(c) && !taken(c);
    let code: string;
    if (ticket) code = ticket.code_ref as string;
    else if (e.ref) {
      const short = this.refs.display(e.ref);
      code = usable(short) ? short : `E${num}`;
    } else {
      // A stand-in uses its group's ticket ("680A"), or the group's id when it has none.
      const groupTicket = (this.db.prepare('SELECT ticket FROM groups WHERE id = ?').get(groupId) as Row | undefined)?.ticket as string | null;
      const short = groupTicket?.trim() ? this.refs.display(this.refs.canonical(groupTicket)) : null;
      code = usable(short) ? short : localId(groupId);
    }
    const base = code;
    for (let n = 2; !ticket && taken(code); n++) code = e.ref ? `E${num}-${n}` : `${base}-${n}`;
    this.db.prepare('UPDATE epics SET code_ref = ? WHERE num = ?').run(code, num);
    this.db
      .prepare(
        `INSERT INTO lanes (id, name, group_id, status, links, created_at, updated_at, status_since)
         VALUES (?, ?, ?, 'idle', '[]', ?, ?, ?)`,
      )
      .run(Store.epicLaneId(project, num), e.name, groupId, e.at, e.at, e.at);
    return num;
  }

  /** Must run inside a transaction. The project's "Ungrouped" group, created with its stand-in epic if need be. */
  private ungroupedGroup(project: string, at: string): string {
    const id = qualify(project, 'ungrouped');
    // Removed from the dashboard earlier: lanes joining it bring it back.
    this.db.prepare('UPDATE groups SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL').run(id);
    if (!this.db.prepare('SELECT 1 FROM groups WHERE id = ?').get(id)) {
      this.db
        .prepare("INSERT INTO groups (id, name, links, agent, created_at, updated_at) VALUES (?, 'Ungrouped', '[]', NULL, ?, ?)")
        .run(id, at, at);
    }
    this.ensureEpic(id, at);
    return id;
  }

  /** The group's epics that aren't closed, real ones first (oldest first). */
  private openEpicsOf(groupId: string): Row[] {
    return this.db
      .prepare("SELECT * FROM epics WHERE group_id = ? AND state <> 'closed' ORDER BY stand_in, num")
      .all(groupId) as Row[];
  }

  /** Must run inside a transaction. Every group has an epic: with none open, its stand-in comes (back). */
  private ensureEpic(groupId: string, at: string) {
    if (this.openEpicsOf(groupId).length) return;
    const standIn = this.db.prepare('SELECT num FROM epics WHERE group_id = ? AND stand_in = 1 ORDER BY num DESC LIMIT 1').get(groupId) as
      | Row
      | undefined;
    if (standIn) {
      this.db
        .prepare("UPDATE epics SET state = 'open', closed_at = NULL, close_reason = NULL, close_requested_by = NULL, updated_at = ? WHERE num = ?")
        .run(at, Number(standIn.num));
      return;
    }
    const g = this.db.prepare('SELECT name FROM groups WHERE id = ?').get(groupId) as Row | undefined;
    this.insertEpic(projectOf(groupId), groupId, { ref: null, displayRef: null, name: (g?.name as string) ?? localId(groupId), at });
  }

  private epicFromRow(r: Row): Epic {
    const num = Number(r.num);
    const counts = this.db
      .prepare(
        `SELECT COUNT(*) AS open, SUM(blocking = 1 AND turn = 'owner') AS blocking FROM escalations WHERE epic_id = ? AND state = 'open'`,
      )
      .get(num) as Row;
    const msgs = this.db
      .prepare(
        `SELECT (SELECT MAX(id) FROM epic_messages WHERE epic_id = ?) AS last,
           (SELECT MAX(id) FROM epic_messages WHERE epic_id = ? AND author_kind = 'agent') AS last_agent,
           (SELECT COUNT(*) FROM epic_messages WHERE epic_id = ? AND author_kind = 'owner' AND id > ?) AS unread`,
      )
      .get(num, num, num, Number(r.agent_read_id)) as Row;
    const ref = (r.ref as string | null) ?? null;
    return {
      id: num,
      project: r.project_id as string,
      group: r.group_id as string,
      ref,
      displayRef: (r.display_ref as string | null) ?? null,
      url: ref ? (this.resolveTicketUrl(ref) ?? (/^https?:\/\//i.test(ref) ? ref : null)) : null,
      code: r.code_ref as string,
      name: r.name as string,
      links: JSON.parse(r.links as string) as Link[],
      statusLine: (r.status_line as string | null) ?? null,
      state: r.state as EpicState,
      standIn: Number(r.stand_in) === 1,
      closeReason: (r.close_reason as string | null) ?? null,
      closeRequestedBy: (r.close_requested_by as string | null) ?? null,
      openEscalations: Number(counts.open ?? 0),
      blockingEscalations: Number(counts.blocking ?? 0),
      lastMessageId: msgs.last == null ? null : Number(msgs.last),
      lastAgentMessageId: msgs.last_agent == null ? null : Number(msgs.last_agent),
      unreadByAgent: Number(msgs.unread ?? 0),
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      closedAt: (r.closed_at as string | null) ?? null,
    };
  }

  private epicRow(num: number): Row {
    const r = this.db.prepare('SELECT * FROM epics WHERE num = ?').get(num) as Row | undefined;
    if (!r) throw new NotFoundError(`Epic ${num} not found`);
    return r;
  }

  getEpic(num: number): Epic | null {
    const r = this.db.prepare('SELECT * FROM epics WHERE num = ?').get(num) as Row | undefined;
    return r ? this.epicFromRow(r) : null;
  }

  /** Epics in some projects (or a group): open and close-requested ones by default, in groups that aren't removed. */
  listEpics(filter: { projects?: string[]; groupId?: string; states?: EpicState[] } = {}): Epic[] {
    const states = filter.states?.length ? filter.states : (['open', 'close_requested'] as EpicState[]);
    const where = [`e.state IN (${states.map(() => '?').join(',')})`];
    const params: string[] = [...states];
    if (filter.groupId) {
      where.push('e.group_id = ?');
      params.push(filter.groupId);
    } else {
      where.push('e.group_id IN (SELECT id FROM groups WHERE archived_at IS NULL)');
    }
    const p = this.inProjects(filter.projects, 'e.project_id');
    params.push(...p.params);
    return (
      this.db.prepare(`SELECT e.* FROM epics e WHERE ${where.join(' AND ')}${p.sql} ORDER BY e.stand_in, e.num`).all(...params) as Row[]
    ).map((r) => this.epicFromRow(r));
  }

  /**
   * An epic named the way agents do: any form of its ref, or a group's id for that group's epic (its
   * stand-in, or its only open epic; a group with several says to name one).
   */
  findEpic(project: string, name: string): Epic | null {
    const byRef = this.db.prepare('SELECT * FROM epics WHERE project_id = ? AND ref = ?').get(project, this.refs.canonical(name)) as
      | Row
      | undefined;
    if (byRef) return this.epicFromRow(byRef);
    if (!/^[A-Za-z0-9._:-]{1,100}$/.test(name.trim())) return null;
    const open = this.openEpicsOf(qualify(project, name.trim()));
    if (open.length > 1) {
      throw new ValidationError(
        `Group "${name.trim()}" has ${open.length} epics: name one by its ref (${open.map((r) => `"${this.refs.display(r.ref as string)}"`).join(', ')})`,
      );
    }
    return open.length ? this.epicFromRow(open[0]) : null;
  }

  /**
   * Creates or updates an epic. A ref no epic has yet creates a real epic in `groupId`; the group's
   * stand-in then retires, its questions and board moving to the new epic (keeping their codes).
   */
  upsertEpic(
    project: string,
    input: { epic?: number; groupId?: string; ref?: string | null; name?: string; links?: Link[]; statusLine?: string | null },
    actor: string | null,
  ): Epic {
    const touched: number[] = [];
    // Questions whose epic or epic name changes, re-sent so clients follow.
    const moved: string[] = [];
    const unresolved = (epic: number) =>
      (this.db.prepare("SELECT id FROM escalations WHERE epic_id = ? AND state IN ('open', 'decided')").all(epic) as Row[]).map((r) => r.id as string);
    const num = this.tx(() => {
      const at = this.now().toISOString();
      let num = input.epic;
      if (num === undefined) {
        const ref = input.ref?.trim() ? this.refs.canonical(input.ref) : null;
        const existing = ref
          ? (this.db.prepare('SELECT num, group_id, display_ref FROM epics WHERE project_id = ? AND ref = ?').get(project, ref) as Row | undefined)
          : undefined;
        if (existing && input.groupId && existing.group_id !== input.groupId) {
          throw new ConflictError(`Epic ${existing.display_ref as string} is in group "${localId(existing.group_id as string)}": an epic belongs to one group`);
        }
        if (existing) num = Number(existing.num);
        else {
          if (!ref) throw new ValidationError('Name the epic by its ticket ref (ref), or a group for its epic');
          if (!input.groupId || !this.getGroup(input.groupId)) {
            throw new NotFoundError(`Group "${input.groupId ? localId(input.groupId) : ''}" not found: say which group the epic belongs to (group)`);
          }
          const standIn = this.openEpicsOf(input.groupId).find((r) => Number(r.stand_in) === 1);
          num = this.insertEpic(project, input.groupId, {
            ref,
            displayRef: input.ref!.trim(),
            name: input.name ?? this.refs.display(ref),
            links: JSON.stringify(input.links ?? []),
            at,
          });
          if (standIn) {
            // The first real epic retires the stand-in: its questions and board move here, codes and all.
            const from = Number(standIn.num);
            moved.push(...unresolved(from));
            this.db.prepare('UPDATE escalations SET epic_id = ? WHERE epic_id = ?').run(num, from);
            this.db.prepare('UPDATE epic_messages SET epic_id = ? WHERE epic_id = ?').run(num, from);
            this.db.prepare('UPDATE epics SET agent_read_id = ? WHERE num = ?').run(Number(standIn.agent_read_id), num);
            this.db.prepare('UPDATE epics SET status_line = ? WHERE num = ?').run((standIn.status_line as string | null) ?? null, num);
            this.db.prepare("UPDATE epics SET state = 'closed', closed_at = ?, updated_at = ? WHERE num = ?").run(at, at, from);
            touched.push(from);
          }
          if (input.statusLine !== undefined) {
            this.db.prepare('UPDATE epics SET status_line = ? WHERE num = ?').run(input.statusLine?.trim() || null, num);
          }
          return num;
        }
      }
      const r = this.epicRow(num);
      if (r.state === 'closed') throw new ConflictError(`Epic ${(r.display_ref as string | null) ?? r.name} is closed`);
      const ref = input.ref === undefined ? (r.ref as string | null) : input.ref?.trim() ? this.refs.canonical(input.ref) : null;
      if (ref !== r.ref && Number(r.stand_in) === 1) {
        throw new ValidationError("A group's stand-in epic has no ref: create the real epic with update_epic and its ref instead");
      }
      if (ref === null && Number(r.stand_in) === 0) throw new ValidationError('An epic keeps its ticket ref: give it another, or ask to close it');
      if (ref !== r.ref && this.db.prepare('SELECT 1 FROM epics WHERE project_id = ? AND ref = ? AND num <> ?').get(project, ref, num)) {
        throw new ConflictError(`${this.refs.display(ref!)} is another epic already`);
      }
      if (input.name && input.name !== r.name) moved.push(...unresolved(num));
      this.db
        .prepare(
          'UPDATE epics SET ref = ?, display_ref = ?, name = ?, links = ?, status_line = ?, updated_at = ? WHERE num = ?',
        )
        .run(
          ref,
          input.ref?.trim() ? input.ref.trim() : (r.display_ref as string | null),
          input.name ?? (r.name as string),
          input.links ? JSON.stringify(input.links) : (r.links as string),
          input.statusLine !== undefined ? (input.statusLine?.trim() || null) : ((r.status_line as string | null) ?? null),
          at,
          num,
        );
      if (input.name) this.db.prepare('UPDATE lanes SET name = ? WHERE id = ?').run(input.name, Store.epicLaneId(project, num));
      return num;
    });
    // Stamped as changed, so clients take the new copy (and it doesn't read as a new question).
    const stamp = this.now().toISOString();
    for (const id of moved) this.db.prepare('UPDATE escalations SET updated_at = ? WHERE id = ?').run(stamp, id);
    for (const n of touched) this.emitEpic(n);
    for (const id of moved) {
      const e = this.getEscalation(id);
      if (e) this.events.emit('change', { type: 'escalation', escalation: e });
    }
    return this.emitEpic(num)!;
  }

  /** An overseer asks to close an epic; a person approves or declines. Refused while questions on it are unresolved. */
  requestEpicClose(num: number, reason: string, actor: string): Epic {
    this.tx(() => {
      const r = this.epicRow(num);
      if (Number(r.stand_in) === 1) throw new ValidationError("A group's stand-in epic isn't closed: it steps aside when a real epic is added");
      if (r.state === 'closed') throw new ConflictError('This epic is closed already');
      this.refuseWhileUnresolved(num);
      const at = this.now().toISOString();
      this.db
        .prepare("UPDATE epics SET state = 'close_requested', close_reason = ?, close_requested_by = ?, updated_at = ? WHERE num = ?")
        .run(reason.trim(), actor, at, num);
    });
    return this.emitEpic(num)!;
  }

  /** A person's answer to a close request. Closing the group's last real epic brings its stand-in back. */
  decideEpicClose(num: number, approve: boolean, by: string): Epic {
    const back = this.tx(() => {
      const r = this.epicRow(num);
      if (r.state !== 'close_requested') throw new ConflictError('Nobody has asked to close this epic');
      const at = this.now().toISOString();
      if (!approve) {
        this.db.prepare("UPDATE epics SET state = 'open', close_reason = NULL, close_requested_by = NULL, updated_at = ? WHERE num = ?").run(at, num);
        return null;
      }
      this.refuseWhileUnresolved(num);
      this.db.prepare("UPDATE epics SET state = 'closed', closed_at = ?, updated_at = ? WHERE num = ?").run(at, at, num);
      this.ensureEpic(r.group_id as string, at);
      const standIn = this.openEpicsOf(r.group_id as string).find((e) => Number(e.stand_in) === 1);
      return standIn ? Number(standIn.num) : null;
    });
    if (back !== null) this.emitEpic(back);
    void by;
    return this.emitEpic(num)!;
  }

  /** Live decisions are never withdrawn: an epic with open or decided-but-unacknowledged questions stays open. */
  private refuseWhileUnresolved(num: number) {
    const n = Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM escalations WHERE epic_id = ? AND state IN ('open', 'decided')").get(num) as Row).n,
    );
    if (n) throw new ConflictError(`This epic has ${n} question(s) still open or awaiting acknowledgement: settle them first`);
  }

  /**
   * The lanes an epic's card lists: those whose ticket names it, or for a stand-in, the rest of its
   * group's lanes. Its sheet shows their combined feed.
   */
  epicLanes(num: number): string[] {
    const r = this.epicRow(num);
    const rows =
      Number(r.stand_in) === 1
        ? (this.db
            .prepare(
              `SELECT l.id FROM lanes l LEFT JOIN tickets t ON t.num = l.ticket_id
               WHERE l.group_id = ? AND l.archived_at IS NULL AND instr(l.id, '/~') = 0
                 AND (t.epic_id IS NULL OR t.epic_id NOT IN (SELECT num FROM epics WHERE state <> 'closed' AND group_id = l.group_id))`,
            )
            .all(r.group_id as string) as Row[])
        : (this.db
            .prepare(
              `SELECT l.id FROM lanes l JOIN tickets t ON t.num = l.ticket_id
               WHERE t.epic_id = ? AND l.group_id = ? AND l.archived_at IS NULL`,
            )
            .all(num, r.group_id as string) as Row[]);
    return rows.map((x) => x.id as string);
  }

  /** The combined feed of an epic's lanes: status changes, activity and ticket switches, latest first. */
  epicFeed(num: number, limit = 100): LaneEvent[] {
    const lanes = this.epicLanes(num);
    if (!lanes.length) return [];
    return (
      this.db
        .prepare(
          `SELECT * FROM lane_events WHERE lane_id IN (${lanes.map(() => '?').join(',')}) AND kind IN ('status', 'activity', 'ticket')
           ORDER BY id DESC LIMIT ?`,
        )
        .all(...lanes, limit) as Row[]
    ).map((r) => this.laneEventFromRow(r));
  }

  /** Sends a group's epics that aren't closed to clients. */
  private emitGroupEpics(groupId: string) {
    for (const r of this.openEpicsOf(groupId)) this.emitEpic(Number(r.num));
  }

  /** Sends an epic's current state to clients; returns it. */
  private emitEpic(num: number, messaged?: 'owner' | 'agent'): Epic | null {
    const epic = this.getEpic(num);
    if (epic) this.events.emit('change', { type: 'epic', epic, ...(messaged ? { messaged } : {}) });
    return epic;
  }

  // ---- epic message boards ---------------------------------------------------

  private epicReadId(num: number): number {
    return Number((this.db.prepare('SELECT agent_read_id FROM epics WHERE num = ?').get(num) as Row | undefined)?.agent_read_id ?? 0);
  }

  /** An epic's board, oldest first: its latest `limit` messages. */
  epicMessages(num: number, limit = 100): LaneMessage[] {
    const readId = this.epicReadId(num);
    return (this.db.prepare('SELECT * FROM epic_messages WHERE epic_id = ? ORDER BY id DESC LIMIT ?').all(num, limit) as Row[])
      .reverse()
      .map((r) => this.laneMessageFromRow(r, readId, 'epic_message_id'));
  }

  /** People's notes on an epic's board its overseer hasn't been handed, plus (with `since`) those written at or after it. */
  private unreadEpicByAgent(num: number, since?: string, onlySince = false): LaneMessage[] {
    return (
      this.db
        .prepare(
          `SELECT m.* FROM epic_messages m JOIN epics e ON e.num = m.epic_id
           WHERE m.epic_id = ? AND m.author_kind = 'owner' AND ((? = 0 AND m.id > e.agent_read_id) OR m.created_at >= ?) ORDER BY m.id`,
        )
        .all(num, onlySince ? 1 : 0, since ?? '\uffff') as Row[]
    ).map((r) => this.laneMessageFromRow(r, undefined, 'epic_message_id'));
  }

  /** Hands people's unread notes on an epic's board to its overseer: returns them and marks them seen. */
  takeUnreadEpicForAgent(num: number): LaneMessage[] {
    const unread = this.unreadEpicByAgent(num);
    if (unread.length) {
      const upTo = unread.at(-1)!.id;
      if (this.db.prepare('UPDATE epics SET agent_read_id = ? WHERE num = ? AND agent_read_id < ?').run(upTo, num, upTo).changes > 0) {
        this.emitEpic(num);
      }
    }
    return unread;
  }

  /**
   * Writes on an epic's board, with the same rules as a lane's conversation: the overseer's post is
   * pushed quietly, one per epic per minute; a person's note waits for the overseer. Not on closed epics.
   * A retry (same author, same text, within the minute) returns the message already sent.
   */
  postEpicMessage(
    num: number,
    message: { from: 'owner' | 'agent'; author: string; body: string; attachments?: string[] },
    owner: string,
  ): LaneMessage {
    const max = message.from === 'agent' ? AGENT_MESSAGE_MAX : OWNER_MESSAGE_MAX;
    const body = message.body.trim();
    if (!body) throw new ValidationError('The message is empty');
    if (body.length > max) {
      throw new ValidationError(
        message.from === 'agent'
          ? `Keep messages under ${max} characters: attach a file (POST /api/attachments) for anything longer`
          : `Messages are limited to ${max} characters`,
      );
    }
    const epic = this.epicRow(num);
    if (epic.state === 'closed') throw new ConflictError(`Epic ${(epic.display_ref as string | null) ?? epic.name} is closed: its board is read-only`);
    const at = this.now();
    const { posted, duplicate } = this.tx(() => {
      const recent = this.db
        .prepare('SELECT * FROM epic_messages WHERE epic_id = ? AND author_kind = ? ORDER BY id DESC LIMIT 1')
        .get(num, message.from) as Row | undefined;
      const fresh = recent && at.getTime() - Date.parse(recent.created_at as string) < 60_000;
      const retry =
        fresh &&
        recent.author === message.author &&
        recent.body === body &&
        (message.from === 'agent' || Number(recent.id) > this.epicReadId(num));
      if (retry) return { posted: this.laneMessageFromRow(recent, this.epicReadId(num), 'epic_message_id'), duplicate: true };
      if (message.from === 'agent' && fresh) throw new ConflictError('One message per epic per minute: put everything in one message');
      const id = Number(
        this.db
          .prepare('INSERT INTO epic_messages (epic_id, author_kind, author, body, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(num, message.from, message.author, body, at.toISOString()).lastInsertRowid,
      );
      if (message.attachments?.length) this.linkLaneAttachments(id, message.attachments, owner, 'epic_message_id');
      if (message.from === 'agent') this.db.prepare('UPDATE epics SET updated_at = ? WHERE num = ?').run(at.toISOString(), num);
      const row = this.db.prepare('SELECT * FROM epic_messages WHERE id = ?').get(id) as Row;
      return { posted: this.laneMessageFromRow(row, this.epicReadId(num), 'epic_message_id'), duplicate: false };
    });
    if (duplicate) return posted;
    this.emitEpic(num, message.from);
    if (message.from === 'agent') {
      const project = epic.project_id as string;
      this.events.emit('notice', {
        project,
        laneId: Store.epicLaneId(project, num),
        epicId: num,
        message: body,
        by: message.author,
        attachments: posted.attachments,
      });
    }
    return posted;
  }

  // ---- tickets -------------------------------------------------------------

  /** Must run inside a transaction. Creates a ticket record and gives it a code prefix nobody else in the project has. */
  private insertTicket(
    project: string,
    ref: string,
    displayRef: string,
    t: {
      group: string | null;
      lane: string | null;
      state: TicketState;
      status: LaneStatus;
      statusSince: string;
      blockedSince: string | null;
      blockedTotalMs: number;
      at: string;
      closedAt: string | null;
    },
  ): number {
    const num = Number(
      this.db
        .prepare(
          `INSERT INTO tickets (project_id, ref, display_ref, code_ref, group_id, lane_id, state, status, status_since, blocked_since,
             blocked_total_ms, created_at, updated_at, closed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(project, ref, displayRef, `pending:${randomUUID()}`, t.group, t.lane, t.state, t.status, t.statusSince, t.blockedSince,
          t.blockedTotalMs, t.at, t.at, t.closedAt).lastInsertRowid,
    );
    // A ref that's also an epic shares the epic's codes: one letter sequence per ref.
    const epic = this.hasTable('epics')
      ? (this.db.prepare('SELECT code_ref FROM epics WHERE project_id = ? AND ref = ?').get(project, ref) as Row | undefined)
      : undefined;
    const taken = (code: string) => this.codeRefTaken(project, code, { ticket: num });
    const short = this.refs.display(ref);
    let code = epic ? (epic.code_ref as string) : CODE_REF.test(short) && /\d$/.test(short) && !taken(short) ? short : `T${num}`;
    for (let n = 2; !epic && taken(code); n++) code = `T${num}-${n}`;
    this.db.prepare('UPDATE tickets SET code_ref = ? WHERE num = ?').run(code, num);
    return num;
  }

  private ticketRow(num: number): Row {
    const r = this.db.prepare('SELECT * FROM tickets WHERE num = ?').get(num) as Row | undefined;
    if (!r) throw new NotFoundError(`Ticket ${num} not found`);
    return r;
  }

  private ticketFromRow(r: Row): Ticket {
    // While a lane holds it, its status is the lane's.
    const lane = r.lane_id
      ? (this.db.prepare('SELECT status, status_since, blocked_since, blocked_total_ms FROM lanes WHERE id = ?').get(r.lane_id as string) as
          | Row
          | undefined)
      : undefined;
    const s = lane ?? r;
    const ref = r.ref as string;
    return {
      id: Number(r.num),
      project: r.project_id as string,
      ref,
      displayRef: r.display_ref as string,
      code: r.code_ref as string,
      url: this.resolveTicketUrl(ref) ?? (/^https?:\/\//i.test(ref) ? ref : null),
      // A ticket in a removed group shows as ungrouped, like that group's lanes.
      group:
        r.group_id && !(this.db.prepare('SELECT archived_at FROM groups WHERE id = ?').get(r.group_id as string) as Row | undefined)?.archived_at
          ? (r.group_id as string)
          : null,
      lane: (r.lane_id as string | null) ?? null,
      lastLane:
        (r.lane_id as string | null) ??
        ((this.db.prepare("SELECT lane_id FROM lane_events WHERE ticket_id = ? AND kind = 'ticket' ORDER BY id DESC LIMIT 1").get(Number(r.num)) as
          | Row
          | undefined)?.lane_id as string | null) ??
        null,
      state: r.state as TicketState,
      parkReason: (r.park_reason as string | null) ?? null,
      waitingOn: (r.waiting_on as string | null) ?? null,
      epicId: r.epic_id == null ? null : Number(r.epic_id),
      status: s.status as LaneStatus,
      statusSince: s.status_since as string,
      blockedSince: (s.blocked_since as string | null) ?? null,
      blockedTotalMs: Number(s.blocked_total_ms),
      openEscalations: Number(
        (this.db.prepare("SELECT COUNT(*) AS n FROM escalations WHERE ticket_id = ? AND state = 'open'").get(Number(r.num)) as Row).n,
      ),
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      closedAt: (r.closed_at as string | null) ?? null,
    };
  }

  /** The short form of a ticket for messages: "967", "gh:632". */
  private ticketName(r: Row) {
    return this.refs.display(r.ref as string);
  }

  /** Tickets in a project (or group), held and parked ones by default, most recently changed first. */
  listTickets(filter: { projects?: string[]; groupId?: string; states?: TicketState[]; limit?: number } = {}): Ticket[] {
    const states = filter.states?.length ? filter.states : (['in_lane', 'parked'] as TicketState[]);
    const where = [`state IN (${states.map(() => '?').join(',')})`];
    const params: string[] = [...states];
    if (filter.groupId) {
      where.push('group_id = ?');
      params.push(filter.groupId);
    }
    const p = this.inProjects(filter.projects);
    params.push(...p.params);
    return (
      this.db
        .prepare(`SELECT * FROM tickets WHERE ${where.join(' AND ')}${p.sql} ORDER BY updated_at DESC, num DESC LIMIT ?`)
        .all(...params, filter.limit ?? 500) as Row[]
    ).map((r) => this.ticketFromRow(r));
  }

  /** The tickets clients keep: held and parked ones, and any an unresolved escalation belongs to. */
  snapshotTickets(projects?: string[]): Ticket[] {
    const p = this.inProjects(projects);
    return (
      this.db
        .prepare(
          `SELECT * FROM tickets WHERE (state IN ('in_lane', 'parked')
             OR num IN (SELECT ticket_id FROM escalations WHERE state IN ('open', 'decided') AND ticket_id IS NOT NULL))${p.sql}
           ORDER BY num`,
        )
        .all(...p.params) as Row[]
    ).map((r) => this.ticketFromRow(r));
  }

  /** A ticket by its number or any form of its ref ("967", "#967", "redmine:967", its URL), in a project. */
  getTicket(project: string, refOrId: string | number): Ticket | null {
    const r =
      typeof refOrId === 'number'
        ? (this.db.prepare('SELECT * FROM tickets WHERE num = ? AND project_id = ?').get(refOrId, project) as Row | undefined)
        : (this.db.prepare('SELECT * FROM tickets WHERE project_id = ? AND ref = ?').get(project, this.refs.canonical(refOrId)) as
            | Row
            | undefined);
    return r ? this.ticketFromRow(r) : null;
  }

  /** A ticket's history, latest first: status changes, escalation steps and lane switches, from every lane it was in. */
  ticketEvents(ticketId: number, limit = 100): LaneEvent[] {
    return (
      this.db
        .prepare(`SELECT * FROM lane_events WHERE ticket_id = ? AND kind NOT IN ('notice', 'message', 'activity') ORDER BY id DESC LIMIT ?`)
        .all(ticketId, limit) as Row[]
    ).map((r) => this.laneEventFromRow(r));
  }

  /** The lanes a ticket has been in, first to last. */
  ticketLanes(ticketId: number): string[] {
    return (
      this.db
        .prepare('SELECT lane_id, MIN(id) AS first FROM lane_events WHERE ticket_id = ? GROUP BY lane_id ORDER BY first')
        .all(ticketId) as Row[]
    ).map((r) => r.lane_id as string);
  }

  /**
   * Must run inside a transaction. Moves the lane to the ticket `raw` names (or to none): the ticket it
   * holds is let go as `fill.previous` says, the new one is found or created and brings its
   * escalations and status. Returns a warning for the agent, if any.
   */
  private switchTicket(
    lane: Lane,
    raw: string | null,
    status: LaneStatus | undefined,
    fill: LaneFill,
    actor: string | null,
    at: string,
    touched: Touched,
  ): string | undefined {
    const written = raw?.trim() || null;
    const ref = written ? this.refs.canonical(written) : null;
    const held = lane.ticketId !== null ? this.ticketRow(lane.ticketId) : null;
    // The ticket it holds already: a plain update (the ref may be written another way this time, or the
    // ticket systems may have changed since it was stored).
    if (held && (ref === held.ref || ref === this.refs.canonical(held.display_ref as string))) return undefined;
    if (!held && !ref) return undefined;
    const project = projectOf(lane.id);
    let target = ref ? (this.db.prepare('SELECT * FROM tickets WHERE project_id = ? AND ref = ?').get(project, ref) as Row | undefined) : undefined;
    if (target?.lane_id && target.lane_id !== lane.id) {
      throw new ConflictError(
        `${this.ticketName(target)} is in lane "${localId(target.lane_id as string)}"; a ticket is in one lane at a time (a worker and a reviewer share one)`,
      );
    }
    let how = fill.previous;
    let reason = fill.reason?.trim() || null;
    let warning: string | undefined;
    if (held && !how) {
      if (fill.strict) {
        throw new ValidationError(
          `Lane "${localId(lane.id)}" holds ${this.ticketName(held)}: say what happens to it with previous (park, done or drop)`,
        );
      }
      // The plan's default for both calls: done if the lane was completed, otherwise parked, which loses nothing.
      how = lane.status === 'completed' ? 'done' : 'park';
      if (how === 'park') reason ??= 'switched (legacy call)';
    }
    if (held && how === 'park' && !reason) throw new ValidationError(`Say why ${this.ticketName(held)} is parked (reason)`);
    const system = (r: string) => (/^https?:\/\//i.test(r) ? null : r.includes(':') ? r.slice(0, r.indexOf(':')) : null);
    if (held && ref && system(ref) === 'gh' && system(held.ref as string) !== 'gh') {
      warning = `Switched from ${this.ticketName(held)} to ${this.refs.display(ref)}: PRs go in links, never ticket.`;
    }
    if (held) this.releaseTicket(lane, how!, reason, actor, at, touched);
    if (!ref) {
      this.emptyLane(this.requireLane(lane.id), actor, at);
      return warning;
    }
    const fresh = !target;
    if (!target) {
      const num = this.insertTicket(project, ref, written!, {
        group: null,
        lane: null,
        state: 'parked',
        status: status ?? 'active',
        statusSince: at,
        blockedSince: null,
        blockedTotalMs: 0,
        at,
        closedAt: null,
      });
      target = this.ticketRow(num);
    }
    this.takeTicket(this.requireLane(lane.id), target, written!, fresh, actor, at, touched);
    return warning;
  }

  /** Must run inside a transaction. The lane lets its ticket go: parked with its status kept, or done or dropped. */
  private releaseTicket(lane: Lane, how: TicketRelease, reason: string | null, actor: string | null, at: string, touched: Touched) {
    if (lane.ticketId === null) return;
    const t = this.ticketRow(lane.ticketId);
    const name = this.ticketName(t);
    // A blocked spell ends here: time parked isn't counted as blocked.
    const blockedTotalMs = lane.blockedTotalMs + (lane.blockedSince ? Date.parse(at) - Date.parse(lane.blockedSince) : 0);
    touched.tickets.add(lane.ticketId);
    const state: TicketState = how === 'park' ? 'parked' : how === 'done' ? 'done' : 'dropped';
    this.db
      .prepare(
        `UPDATE tickets SET lane_id = NULL, state = ?, park_reason = ?, status = ?, status_since = ?, blocked_since = NULL,
           blocked_total_ms = ?, updated_at = ?, closed_at = ? WHERE num = ?`,
      )
      .run(state, how === 'park' ? reason : null, lane.status, lane.statusSince, blockedTotalMs, at, how === 'park' ? null : at, lane.ticketId);
    this.db.prepare('UPDATE lanes SET ticket_id = NULL WHERE id = ?').run(lane.id);
    const label =
      how === 'park' ? `Parked ${name}: ${reason}` : how === 'done' ? `${name} done${reason ? `: ${reason}` : ''}` : `Dropped ${name}${reason ? `: ${reason}` : ''}`;
    this.addEvent(lane.id, at, 'ticket', label, actor, lane.ticketId);
    if (how === 'park') return;
    // Its open questions stay as they are: in the inbox, answered as ever. Nothing waits on a ticket that's over; the lanes holding those that did show it.
    const waiting = this.db
      .prepare('SELECT lane_id FROM tickets WHERE project_id = ? AND waiting_on = ? AND lane_id IS NOT NULL')
      .all(projectOf(lane.id), t.ref as string) as Row[];
    for (const w of waiting) touched.lanes.add(w.lane_id as string);
    for (const r of this.db.prepare('SELECT num FROM tickets WHERE project_id = ? AND waiting_on = ?').all(projectOf(lane.id), t.ref as string) as Row[]) {
      touched.tickets.add(Number(r.num));
    }
    this.db.prepare('UPDATE tickets SET waiting_on = NULL WHERE project_id = ? AND waiting_on = ?').run(projectOf(lane.id), t.ref as string);
  }

  /** Must run inside a transaction. A lane with no ticket: idle, unless a question of its own still blocks it. */
  private emptyLane(lane: Lane, actor: string | null, at: string) {
    this.db.prepare('UPDATE lanes SET ticket_id = NULL WHERE id = ?').run(lane.id);
    const status: LaneStatus = this.openBlockingCount(lane.id) > 0 ? 'blocked_human' : 'idle';
    this.setLaneStatus(lane, status, 0, actor, at);
  }

  /**
   * Must run inside a transaction. The lane takes the ticket: its escalations follow it here, and it
   * brings its status (blocked while a blocking question of its own is open; waiting on the agent if
   * one was answered while it was parked).
   */
  private takeTicket(lane: Lane, t: Row, written: string, fresh: boolean, actor: string | null, at: string, touched: Touched) {
    const num = Number(t.num);
    touched.tickets.add(num);
    // Its escalations keep the lane they were raised in (lane_id, for history); they count where the ticket is.
    this.db.prepare('UPDATE lanes SET ticket_id = ? WHERE id = ?').run(num, lane.id);
    // Blocked by the ticket's questions.
    const blocking = this.openBlockingCount(lane.id) > 0;
    const was = t.status as LaneStatus;
    const status: LaneStatus = blocking
      ? 'blocked_human'
      : fresh
        ? was
        : was === 'blocked_human'
          ? 'awaiting_agent'
          : was === 'completed' || was === 'idle'
            ? 'active'
            : was;
    const reopened = t.state === 'done' || t.state === 'dropped';
    this.db
      .prepare(
        `UPDATE tickets SET lane_id = ?, state = 'in_lane', park_reason = NULL, closed_at = NULL, group_id = ?, updated_at = ? WHERE num = ?`,
      )
      .run(lane.id, (this.db.prepare('SELECT group_id FROM lanes WHERE id = ?').get(lane.id) as Row).group_id as string | null, at, num);
    this.addEvent(lane.id, at, 'ticket', `Filled with ${this.ticketName(t)}${reopened ? ' (reopened)' : ''}`, actor, num);
    this.setLaneStatus(this.requireLane(lane.id), status, Number(t.blocked_total_ms), actor, at);
  }

  /** Must run inside a transaction. Sets a lane's status on a ticket switch, with the blocked time carried by the ticket. */
  private setLaneStatus(lane: Lane, status: LaneStatus, blockedTotalMs: number, actor: string | null, at: string) {
    if (status !== lane.status) this.addEvent(lane.id, at, 'status', `${lane.status} → ${status}`, actor);
    // A new ticket starts its own spell, whatever the lane showed before.
    this.db
      .prepare('UPDATE lanes SET status = ?, status_since = ?, blocked_since = ?, blocked_total_ms = ? WHERE id = ?')
      .run(status, at, status === 'blocked_human' ? at : null, blockedTotalMs, lane.id);
  }

  /**
   * Must run inside a transaction. The epic the lane's ticket is for, in the lane's group (a stand-in
   * or null: none). Returns a warning, if any.
   */
  private setTicketEpic(lane: Lane, epic: number | null, at: string, touched: Touched): string | undefined {
    if (lane.ticketId === null) {
      return epic !== null ? `Lane "${localId(lane.id)}" holds no ticket now, so epic was left out.` : undefined;
    }
    // A closed epic's tickets keep their link, read-only.
    const held = this.ticketRow(lane.ticketId);
    const current = held.epic_id == null ? undefined : (this.db.prepare('SELECT state, display_ref, name FROM epics WHERE num = ?').get(Number(held.epic_id)) as Row | undefined);
    if (current?.state === 'closed' && Number(held.epic_id) === epic) return undefined;
    if (current?.state === 'closed' && Number(held.epic_id) !== epic) {
      return `${this.refs.display(held.ref as string)} is linked to epic ${(current.display_ref as string | null) ?? current.name}, which is closed: the link stays, so epic was left out.`;
    }
    let num: number | null = null;
    if (epic !== null) {
      const e = this.epicRow(epic);
      const name = (e.display_ref as string | null) ?? (e.name as string);
      if (e.state === 'closed') throw new ConflictError(`Epic ${name} is closed`);
      const groupId = (this.db.prepare('SELECT group_id FROM lanes WHERE id = ?').get(lane.id) as Row).group_id as string | null;
      if (e.group_id !== groupId) {
        throw new ValidationError(`Epic ${name} is in group "${localId(e.group_id as string)}": a lane's ticket names an epic of the lane's group`);
      }
      num = Number(e.stand_in) === 1 ? null : epic;
    }
    const was = this.ticketRow(lane.ticketId).epic_id;
    if ((was == null ? null : Number(was)) === num) return undefined;
    this.db.prepare('UPDATE tickets SET epic_id = ?, updated_at = ? WHERE num = ?').run(num, at, lane.ticketId);
    touched.tickets.add(lane.ticketId);
    return undefined;
  }

  /** Must run inside a transaction. What the lane's ticket waits on (another ticket), or nothing. Returns a warning, if any. */
  private setWaitingOn(lane: Lane, waitingOn: string | null, at: string): string | undefined {
    if (lane.ticketId === null) {
      return waitingOn ? `Lane "${localId(lane.id)}" holds no ticket now, so waiting_on was left out.` : undefined;
    }
    const ref = waitingOn?.trim() ? this.refs.canonical(waitingOn) : null;
    const own = this.ticketRow(lane.ticketId);
    if (ref && ref === own.ref) throw new ValidationError('A ticket can\'t wait on itself');
    // Waiting on a ticket that's over would never clear.
    const named = ref ? (this.db.prepare('SELECT state FROM tickets WHERE project_id = ? AND ref = ?').get(projectOf(lane.id), ref) as Row | undefined) : undefined;
    if (named && (named.state === 'done' || named.state === 'dropped')) {
      return `${this.refs.display(ref!)} is ${named.state as string} already, so waiting_on was left out.`;
    }
    if ((own.waiting_on ?? null) === ref) return undefined;
    this.db.prepare('UPDATE tickets SET waiting_on = ?, updated_at = ? WHERE num = ?').run(ref, at, lane.ticketId);
    this.addEvent(lane.id, at, 'ticket', ref ? `${this.ticketName(own)} waits on ${this.refs.display(ref)}` : `${this.ticketName(own)} no longer waits`, null);
    return undefined;
  }

  /**
   * Must run inside a transaction. A ticket no lane holds keeps its own status: blocked while a
   * blocking question of its waits on the owner, then waiting on its agent. Returns whether it changed.
   */
  private syncLooseTicket(ticketId: number | null, at: string): boolean {
    if (ticketId === null) return false;
    const t = this.ticketRow(ticketId);
    if (t.lane_id) return false;
    const blocking = Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM escalations WHERE ticket_id = ? AND state = 'open' AND blocking = 1 AND turn = 'owner'")
          .get(ticketId) as Row
      ).n,
    );
    const was = t.status as LaneStatus;
    const status: LaneStatus = blocking ? 'blocked_human' : was === 'blocked_human' ? 'awaiting_agent' : was;
    if (status === was) return false;
    this.db.prepare('UPDATE tickets SET status = ?, status_since = ?, updated_at = ? WHERE num = ?').run(status, at, at, ticketId);
    return true;
  }

  private emitTicket(ticketId: number | null) {
    if (ticketId === null) return;
    const r = this.db.prepare('SELECT * FROM tickets WHERE num = ?').get(ticketId) as Row | undefined;
    if (r) this.emit({ type: 'ticket', ticket: this.ticketFromRow(r) });
  }

  /** After a ticket switch commits: escalations withdrawn or moved, and lanes they left. */
  private emitTouched(touched: Touched, exceptLane?: string) {
    for (const id of touched.escalations) {
      const e = this.getEscalation(id);
      if (e) this.emit({ type: 'escalation', escalation: e });
    }
    for (const id of touched.lanes) {
      if (id === exceptLane) continue;
      const l = this.getLane(id);
      if (l) this.emit({ type: 'lane', lane: l });
    }
    for (const num of touched.tickets) {
      const r = this.db.prepare('SELECT * FROM tickets WHERE num = ?').get(num) as Row | undefined;
      if (r) this.emit({ type: 'ticket', ticket: this.ticketFromRow(r) });
    }
  }

  // ---- escalations -------------------------------------------------------

  private escalationFromRow(r: Row): StoredEscalation {
    return {
      id: r.id as string,
      ref: (r.code as string | null) ?? (r.letter_index == null ? String(r.ref) : `${letterOf(Number(r.letter_index))}${Number(r.seq)}`),
      ticketId: r.ticket_id == null ? null : Number(r.ticket_id),
      ticketRef:
        r.ticket_id == null
          ? null
          : (() => {
              const t = this.db.prepare('SELECT ref FROM tickets WHERE num = ?').get(Number(r.ticket_id)) as Row | undefined;
              return t ? this.refs.display(t.ref as string) : null;
            })(),
      epicId: r.epic_id == null ? null : Number(r.epic_id),
      epicName:
        r.epic_id == null
          ? null
          : (((this.db.prepare('SELECT name FROM epics WHERE num = ?').get(Number(r.epic_id)) as Row | undefined)?.name as string | undefined) ?? null),
      project: r.project_id as string,
      projectKey: this.projectKeyOf(r.project_id as string),
      laneId: r.lane_id as string,
      question: r.question as string,
      context: (r.context as string | null) ?? null,
      recommendation: (r.recommendation as string | null) ?? null,
      recommendedOption: (r.recommended_option as string | null) ?? null,
      cost: (r.cost as string | null) ?? null,
      alternatives: JSON.parse(r.alternatives as string) as string[],
      ticket: (r.ticket as string | null) ?? null,
      ticketUrl: r.ticket ? this.resolveTicketUrl(r.ticket as string) : null,
      positions: JSON.parse(r.positions as string) as Position[],
      options: JSON.parse(r.options as string) as string[],
      acceptMeans: (r.accept_means as string | null) ?? null,
      rejectMeans: (r.reject_means as string | null) ?? null,
      allowReject: Number(r.allow_reject ?? 1) === 1,
      attachments: this.attachmentsOf(r.id as string),
      turn: r.turn === 'agent' ? 'agent' : 'owner',
      ...this.threadSummary(r.id as string),
      links: JSON.parse(r.links as string) as Link[],
      blocking: Number(r.blocking ?? 1) === 1,
      state: r.state as EscalationState,
      createdBy: r.created_by as string,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      decision: (r.decision as string | null) ?? null,
      decisionNote: (r.decision_note as string | null) ?? null,
      decidedBy: (r.decided_by as string | null) ?? null,
      decidedAt: (r.decided_at as string | null) ?? null,
      acknowledgedAt: (r.acknowledged_at as string | null) ?? null,
      resolution: (r.resolution as string | null) ?? null,
    };
  }

  /**
   * The newest `limit` matches, returned oldest first. Default states:
   * everything not yet closed (open + decided-but-unacknowledged).
   */
  listEscalations(
    filter: {
      states?: EscalationState[];
      laneId?: string;
      groupId?: string;
      ticketId?: number;
      epicId?: number;
      projects?: string[];
      limit?: number;
    } = {},
  ): StoredEscalation[] {
    const states = filter.states ?? ['open', 'decided'];
    const where = [`state IN (${states.map(() => '?').join(',')})`];
    const params: (string | number)[] = [...states];
    if (filter.ticketId !== undefined) {
      where.push('ticket_id = ?');
      params.push(filter.ticketId);
    }
    if (filter.epicId !== undefined) {
      where.push('epic_id = ?');
      params.push(filter.epicId);
    }
    if (filter.laneId) {
      where.push('lane_id = ?');
      params.push(filter.laneId);
    }
    if (filter.groupId) {
      where.push('(lane_id IN (SELECT id FROM lanes WHERE group_id = ?) OR epic_id IN (SELECT num FROM epics WHERE group_id = ?))');
      params.push(filter.groupId, filter.groupId);
    }
    const p = this.inProjects(filter.projects);
    params.push(...p.params);
    return (
      this.db
        .prepare(`SELECT * FROM escalations WHERE ${where.join(' AND ')}${p.sql} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
        .all(...params, filter.limit ?? 1000) as Row[]
    )
      .reverse()
      .map((r) => this.escalationFromRow(r));
  }

  /**
   * Closed escalations (acknowledged or dismissed), latest first, for the History view. `query`
   * matches the code, the question, context, decision, notes and the conversation. Pages with
   * `before` (the last result's `updatedAt` and `id`, from `next`).
   */
  historyEscalations(filter: {
    projects?: string[];
    query?: string;
    groupId?: string;
    states?: ('acknowledged' | 'withdrawn')[];
    /** Leave out escalations whose ticket no lane holds. */
    activeTickets?: boolean;
    before?: { at: string; id: string };
    limit?: number;
  }): { items: Escalation[]; next: { at: string; id: string } | null } {
    const states = filter.states?.length ? filter.states : ['acknowledged', 'withdrawn'];
    const where = [`state IN (${states.map(() => '?').join(',')})`];
    const params: (string | number)[] = [...states];
    if (filter.groupId) {
      where.push('(lane_id IN (SELECT id FROM lanes WHERE group_id = ?) OR epic_id IN (SELECT num FROM epics WHERE group_id = ?))');
      params.push(filter.groupId, filter.groupId);
    }
    if (filter.activeTickets) where.push('(ticket_id IS NULL OR ticket_id IN (SELECT num FROM tickets WHERE lane_id IS NOT NULL))');
    const text = filter.query?.trim();
    if (text) {
      const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const fields = ['question', 'context', 'decision', 'decision_note', 'resolution', 'recommendation'];
      const code = /^([A-Za-z]{1,4})(\d{1,9})$/.exec(text.replace(/^#/, ''));
      where.push(
        `(${fields.map((f) => `${f} LIKE ? ESCAPE '\\'`).join(' OR ')}
          OR EXISTS (SELECT 1 FROM messages m WHERE m.escalation_id = escalations.id AND m.body LIKE ? ESCAPE '\\')
          OR code = ? COLLATE NOCASE OR ticket_id IN (SELECT num FROM tickets WHERE ref = ?)
          OR epic_id IN (SELECT num FROM epics WHERE ref = ?)${code ? ' OR (letter_index = ? AND seq = ?)' : ''})`,
      );
      // A ticket's or epic's ref in any form ("967", "#967", "redmine:967", its URL) finds its escalations.
      params.push(...fields.map(() => like), like, text.replace(/^#/, ''), this.refs.canonical(text), this.refs.canonical(text));
      if (code) params.push(indexOfLetter(code[1].toUpperCase()), Number(code[2]));
    }
    if (filter.before) {
      where.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
      params.push(filter.before.at, filter.before.at, filter.before.id);
    }
    const p = this.inProjects(filter.projects);
    params.push(...p.params);
    const limit = Math.min(filter.limit ?? 50, 200);
    const rows = this.db
      .prepare(`SELECT * FROM escalations WHERE ${where.join(' AND ')}${p.sql} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...params, limit + 1) as Row[];
    const items = rows.slice(0, limit).map((r) => this.escalationFromRow(r));
    const last = items[items.length - 1];
    return { items, next: rows.length > limit && last ? { at: last.updatedAt, id: last.id } : null };
  }

  /**
   * By id, or by its code: a ticket's ("967A", "gh:632B") or a lane letter's ("A12"), within
   * `project`, or with the project's key in front ("KEY·967A", "KEY-A12"; also "KEY:A12") in any
   * project (case-insensitive, a leading # is ignored). Without a project, a bare code resolves only
   * if one project has it. Plain numbers ("42") are the global numbers used before lane codes, still
   * accepted.
   */
  getEscalation(id: string, project?: string): StoredEscalation | null {
    const text = id.trim().replace(/^#/, '');
    if (UUID.test(text)) {
      const r = this.db.prepare('SELECT * FROM escalations WHERE id = ?').get(text) as Row | undefined;
      return r ? this.escalationFromRow(r) : null;
    }
    // Ticket and epic codes end in letters ("967A", "paymentsB"); a project key may come first.
    if (/[A-Za-z]$/.test(text)) {
      const byCode = (code: string, inProject?: string) => {
        const p = this.inProjects(inProject ? [inProject] : undefined);
        const rows = this.db.prepare(`SELECT * FROM escalations WHERE code = ? COLLATE NOCASE${p.sql} LIMIT 2`).all(code, ...p.params) as Row[];
        return rows.length === 1 ? this.escalationFromRow(rows[0]) : null;
      };
      const found = byCode(text, project);
      if (found) return found;
      const keyedTicket = /^([A-Za-z][A-Za-z0-9]{1,9})[·.-](.+)$/.exec(text);
      const inProject = keyedTicket ? this.projectByKey(keyedTicket[1])?.id : undefined;
      if (inProject) {
        const keyed = byCode(keyedTicket![2], inProject);
        if (keyed) return keyed;
      }
    }
    const keyed = /^([A-Za-z0-9]{1,10})[·:.-]([A-Za-z]{1,4})(\d{1,9})$/.exec(text);
    const code = keyed ? [keyed[0], keyed[2], keyed[3]] : /^([A-Za-z]{1,4})(\d{1,9})$/.exec(text);
    let rows: Row[];
    if (code) {
      const inProject = keyed ? this.projectByKey(keyed[1])?.id : project;
      if (keyed && !inProject) return null;
      const p = this.inProjects(inProject ? [inProject] : undefined);
      rows = this.db
        .prepare(`SELECT * FROM escalations WHERE letter_index = ? AND seq = ?${p.sql} LIMIT 2`)
        .all(indexOfLetter(code[1]), Number(code[2]), ...p.params) as Row[];
      if (rows.length !== 1) return null;
    } else if (/^\d{1,15}$/.test(text)) {
      rows = this.db.prepare('SELECT * FROM escalations WHERE ref = ?').all(Number(text)) as Row[];
    } else {
      rows = this.db.prepare('SELECT * FROM escalations WHERE id = ?').all(id) as Row[];
    }
    return rows[0] ? this.escalationFromRow(rows[0]) : null;
  }

  /** Who raised it ("user:<id>" or "token:<name>"); null for escalations from before this was recorded. */
  // ---- attachments ------------------------------------------------------

  /** The files on an escalation, in the order the agent gave them. */
  private attachmentsOf(escalationId: string): AttachmentMeta[] {
    return (
      this.db
        .prepare('SELECT id, name, type, size FROM attachments WHERE escalation_id = ? AND message_id IS NULL ORDER BY position')
        .all(escalationId) as Row[]
    ).map((r) => ({ id: r.id as string, name: r.name as string, type: r.type as AttachmentType, size: Number(r.size) }));
  }

  // ---- conversations ----------------------------------------------------

  private messageFromRow(r: Row): Message {
    const attachments = (
      this.db.prepare('SELECT id, name, type, size FROM attachments WHERE message_id = ? ORDER BY position').all(Number(r.id)) as Row[]
    ).map((a) => ({ id: a.id as string, name: a.name as string, type: a.type as AttachmentType, size: Number(a.size) }));
    return {
      id: Number(r.id),
      from: r.author_kind === 'agent' ? 'agent' : 'owner',
      author: r.author as string,
      body: r.body as string,
      at: r.created_at as string,
      attachments,
    };
  }

  /** How many messages an escalation has, and the latest. */
  private threadSummary(escalationId: string): { messageCount: number; lastMessage: Message | null } {
    const n = Number((this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE escalation_id = ?').get(escalationId) as Row).n);
    if (!n) return { messageCount: 0, lastMessage: null };
    const last = this.db.prepare('SELECT * FROM messages WHERE escalation_id = ? ORDER BY id DESC LIMIT 1').get(escalationId) as Row;
    return { messageCount: n, lastMessage: this.messageFromRow(last) };
  }

  /** The conversation, oldest first. */
  messagesOf(escalationId: string): Message[] {
    return (this.db.prepare('SELECT * FROM messages WHERE escalation_id = ? ORDER BY id').all(escalationId) as Row[]).map((r) =>
      this.messageFromRow(r),
    );
  }

  /**
   * Adds a message to an open escalation's conversation.
   * - The owner's (an answer of Other, or a follow-up) hands the turn to the agent: a blocking
   *   escalation stops holding its lane, which shows the agent working.
   * - The agent's reply hands it back, blocking the lane again and notifying the owner. The agent
   *   may also post a short update while it's the owner's turn.
   */
  postMessage(
    id: string,
    message: { from: 'owner' | 'agent'; author: string; body: string; attachments?: string[] },
    owner: string,
  ): Escalation {
    const max = message.from === 'agent' ? AGENT_MESSAGE_MAX : OWNER_MESSAGE_MAX;
    const body = message.body.trim();
    if (!body) throw new ValidationError('The message is empty');
    if (body.length > max) {
      throw new ValidationError(
        message.from === 'agent'
          ? `Keep messages under ${max} characters: attach a file (POST /api/attachments) for anything longer`
          : `Messages are limited to ${max} characters`,
      );
    }
    let loose = false;
    const { escalation, lane, statusChanged, duplicate, reply } = this.tx(() => {
      const current = this.requireEscalation(id);
      if (current.state !== 'open') {
        throw new ConflictError(`Escalation ${current.ref} is ${current.state}: the conversation is closed`);
      }
      const at = this.now().toISOString();
      const recent = this.db
        .prepare('SELECT author, body, created_at FROM messages WHERE escalation_id = ? ORDER BY id DESC LIMIT 1')
        .get(current.id) as Row | undefined;
      const fresh = recent && Date.parse(at) - Date.parse(recent.created_at as string) < 60_000;
      // A retried call (same author, same text, just now) returns the message already sent.
      if (fresh && recent.author === message.author && recent.body === body) {
        return { escalation: current, lane: null, statusChanged: false, duplicate: true, reply: false };
      }
      // Updates while it's the owner's turn: at most one a minute, so a loop can't page the phone.
      if (message.from === 'agent' && current.turn === 'owner' && current.lastMessage?.from === 'agent' && fresh) {
        throw new ConflictError('One update a minute while the owner decides: put everything in one message');
      }
      const turn = message.from === 'owner' ? 'agent' : 'owner';
      const messageId = Number(
        this.db
          .prepare('INSERT INTO messages (escalation_id, author_kind, author, body, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(current.id, message.from, message.author, body, at).lastInsertRowid,
      );
      this.linkAttachments(current.id, message.attachments ?? [], owner, messageId);
      this.db.prepare('UPDATE escalations SET turn = ?, updated_at = ? WHERE id = ?').run(turn, at, current.id);
      this.addEvent(
        current.laneId,
        at,
        'escalation',
        `${message.from === 'owner' ? `${message.author} on ${current.ref}` : `Reply on ${current.ref}`}: ${body}`,
        message.author,
        current.ticketId,
      );
      const holder = this.holderOf(current);
      const found = holder ? this.laneIncludingArchived(holder) : null;
      let statusChanged = false;
      if (!found) {
        this.syncLooseTicket(current.ticketId, at);
        loose = current.ticketId !== null;
      }
      if (found && !found.archived && current.blocking) {
        const lane = found.lane;
        if (turn === 'agent' && lane.status === 'blocked_human' && this.openBlockingCount(lane.id) === 0) {
          this.applyLaneUpdate(lane, { status: 'awaiting_agent' }, null, at);
          statusChanged = true;
        } else if (turn === 'owner' && current.turn === 'agent' && lane.status !== 'blocked_human') {
          this.applyLaneUpdate(lane, { status: 'blocked_human' }, null, at);
          statusChanged = true;
        }
      }
      return {
        escalation: this.requireEscalation(current.id),
        lane: found && !found.archived ? this.requireLane(found.lane.id) : null,
        statusChanged,
        duplicate: false,
        reply: current.turn === 'agent',
      };
    });
    if (duplicate) return escalation;
    // A reply to the owner's Other is their move; an update while they decide is quieter.
    this.emit({ type: 'escalation', escalation, ...(message.from === 'agent' ? { replied: reply ? 'reply' : 'update' } : {}) });
    if (loose) this.emitTicket(escalation.ticketId);
    if (lane) this.emit({ type: 'lane', lane, statusChanged });
    return escalation;
  }

  /**
   * Keeps an upload until an escalation references it. `owner` is the uploader (as in `raised_by_owner`):
   * only they can attach it. Uploads nothing referenced within a day are deleted.
   */
  addAttachment(file: { name: string; type: AttachmentType; data: Uint8Array }, owner: string, uploadedBy: string): AttachmentMeta {
    const now = this.now();
    this.db
      .prepare('DELETE FROM attachments WHERE escalation_id IS NULL AND lane_message_id IS NULL AND epic_message_id IS NULL AND created_at < ?')
      .run(new Date(now.getTime() - UNREFERENCED_TTL_MS).toISOString());
    this.checkUploadRoom(owner);
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO attachments (id, owner, uploaded_by, name, type, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, owner, uploadedBy, file.name, file.type, file.data.byteLength, file.data, now.toISOString());
    return { id, name: file.name, type: file.type, size: file.data.byteLength };
  }

  /** Throws when the uploader already has the most uploads waiting to be attached (checked before reading a body). */
  checkUploadRoom(owner: string) {
    const pending = Number(
      (
        this.db
          .prepare('SELECT COUNT(*) AS n FROM attachments WHERE escalation_id IS NULL AND lane_message_id IS NULL AND epic_message_id IS NULL AND owner = ?')
          .get(owner) as Row
      ).n,
    );
    if (pending >= MAX_PENDING_UPLOADS) {
      throw new ConflictError(`${MAX_PENDING_UPLOADS} uploads are waiting to be attached; attach them or wait a day`);
    }
  }

  /**
   * Attaches uploads to an escalation, or to one of its messages (inside a transaction). Each must be the
   * uploader's and not attached elsewhere yet.
   */
  private linkAttachments(escalationId: string, ids: string[], owner: string, messageId: number | null = null) {
    if (!ids.length) return;
    let have = messageId === null ? this.attachmentsOf(escalationId).length : 0;
    for (const id of new Set(ids)) {
      const r = this.db.prepare('SELECT owner, escalation_id, lane_message_id, epic_message_id FROM attachments WHERE id = ?').get(id) as Row | undefined;
      if (!r || r.owner !== owner) {
        throw new NotFoundError(`Attachment ${id} not found: upload it first (POST /api/attachments), with the same key`);
      }
      // Already here (a retry sending the same ids): nothing to add.
      if (r.escalation_id === escalationId && messageId === null) continue;
      if (r.escalation_id || r.lane_message_id != null || r.epic_message_id != null) throw new ConflictError(`Attachment ${id} is already attached; upload it again`);
      if (have >= this.attachmentsPerItem) {
        throw new ValidationError(`At most ${this.attachmentsPerItem} attachments per ${messageId === null ? 'escalation' : 'message'}`);
      }
      this.db
        .prepare('UPDATE attachments SET escalation_id = ?, message_id = ?, position = ? WHERE id = ?')
        .run(escalationId, messageId, have++, id);
    }
  }

  /** Attaches uploads to a lane or epic message (inside a transaction): each the uploader's, not attached elsewhere. */
  private linkLaneAttachments(laneMessageId: number, ids: string[], owner: string, column: 'lane_message_id' | 'epic_message_id' = 'lane_message_id') {
    let have = 0;
    for (const id of new Set(ids)) {
      const r = this.db.prepare('SELECT owner, escalation_id, lane_message_id, epic_message_id FROM attachments WHERE id = ?').get(id) as Row | undefined;
      if (!r || r.owner !== owner) {
        throw new NotFoundError(`Attachment ${id} not found: upload it first (POST /api/attachments), with the same key`);
      }
      if (r.escalation_id || r.lane_message_id != null || r.epic_message_id != null) throw new ConflictError(`Attachment ${id} is already attached; upload it again`);
      if (have >= this.attachmentsPerItem) throw new ValidationError(`At most ${this.attachmentsPerItem} attachments per message`);
      this.db.prepare(`UPDATE attachments SET ${column} = ?, position = ? WHERE id = ?`).run(laneMessageId, have++, id);
    }
  }

  /**
   * An attachment's file, and the escalation, lane or epic it's on (all null while unreferenced, when only
   * its uploader may read it). Callers check that the reader can see that escalation, lane or epic.
   */
  getAttachment(
    id: string,
  ): (AttachmentMeta & { data: Uint8Array; escalationId: string | null; laneId: string | null; epicId: number | null; owner: string }) | null {
    const r = this.db
      .prepare(
        `SELECT a.*, m.lane_id AS message_lane_id, em.epic_id AS message_epic_id FROM attachments a
         LEFT JOIN lane_messages m ON m.id = a.lane_message_id LEFT JOIN epic_messages em ON em.id = a.epic_message_id WHERE a.id = ?`,
      )
      .get(id) as Row | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      name: r.name as string,
      type: r.type as AttachmentType,
      size: Number(r.size),
      data: r.data as Uint8Array,
      escalationId: (r.escalation_id as string | null) ?? null,
      laneId: (r.message_lane_id as string | null) ?? null,
      epicId: r.message_epic_id == null ? null : Number(r.message_epic_id),
      owner: r.owner as string,
    };
  }

  /** Whether a code names its project ("SH·967A"): ticket codes and project keys can look alike ("PROJ-12A"). */
  isKeyedCode(text: string): boolean {
    const t = text.trim().replace(/^#/, '');
    const m = /^([A-Za-z][A-Za-z0-9]{1,9})[·.-](.+[A-Za-z])$/.exec(t);
    if (!m) return false;
    const project = this.projectByKey(m[1]);
    return !!project && !!this.db.prepare('SELECT 1 FROM escalations WHERE code = ? COLLATE NOCASE AND project_id = ?').get(m[2], project.id);
  }

  /** The key that registered the group a ticket is in now ("user:<account>:<key name>"): its overseer. */
  ticketOverseer(ticketId: number): string | null {
    const r = this.db
      .prepare('SELECT g.owner FROM tickets t JOIN groups g ON g.id = t.group_id WHERE t.num = ? AND g.archived_at IS NULL')
      .get(ticketId) as Row | undefined;
    return (r?.owner as string | null) ?? null;
  }

  /** The overseer of an epic's group (see ticketOverseer). */
  epicOverseer(epicId: number): string | null {
    const r = this.db
      .prepare('SELECT g.owner FROM epics e JOIN groups g ON g.id = e.group_id WHERE e.num = ? AND g.archived_at IS NULL')
      .get(epicId) as Row | undefined;
    return (r?.owner as string | null) ?? null;
  }

  escalationOwner(id: string): string | null {
    const r = this.db.prepare('SELECT raised_by_owner FROM escalations WHERE id = ?').get(id) as Row | undefined;
    return (r?.raised_by_owner as string | null) ?? null;
  }

  private requireEscalation(id: string): StoredEscalation {
    const e = this.getEscalation(id);
    if (!e) throw new NotFoundError(`Escalation "${id}" not found`);
    return e;
  }

  /**
   * Raising the same question again on the same lane while the first is still
   * open (e.g. a retried call) returns the existing escalation with
   * `duplicate: true` instead of creating a second one. `owner` identifies who may later
   * dismiss or acknowledge it: the raising key ("user:<account>:<key name>") or config token
   * ("token:<name>").
   */
  createEscalation(
    input: EscalationInput,
    actor: string,
    owner: string | null = null,
  ): Escalation & { duplicate?: boolean; upgraded?: boolean } {
    projectOf(input.laneId);
    // A typo would otherwise create a new lane outside the group, which the overseer's wait never sees.
    if (!this.laneExists(input.laneId)) {
      throw new NotFoundError(
        `Lane "${localId(input.laneId)}" not found: publish it first (update_lane with its group, or PUT /api/lanes/:id)`,
      );
    }
    const home = this.homeOf(input.laneId, input.epic);
    // The same question again (ignoring spacing and case) on the same ticket or epic is a retry.
    const norm = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase();
    const existing = (
      this.db
        .prepare(
          `SELECT id, question FROM escalations WHERE state = 'open' AND ${home.ticketId !== null ? 'ticket_id' : 'epic_id'} = ?
             AND ${owner ? 'raised_by_owner = ?' : 'created_by = ?'}`,
        )
        .all(home.ticketId ?? home.epicId!, owner ?? actor) as Row[]
    ).find((r) => norm(r.question as string) === norm(input.question));
    if (existing) {
      const id = existing.id as string;
      // Raising an open FYI again as blocking (the default) makes it need the owner now (same code).
      if (input.blocking !== false && !this.requireEscalation(id).blocking) {
        return { ...this.makeBlocking(id, input, actor, owner), duplicate: true, upgraded: true };
      }
      if (this.requireEscalation(id).turn === 'agent') {
        throw new ConflictError(
          `${this.requireEscalation(id).ref} is open and the owner answered Other: reply with reply_to_escalation, or acknowledge it`,
        );
      }
      // A retry may bring files the first call didn't: attach them rather than leave them unused.
      if (input.attachments?.length) {
        const before = this.attachmentsOf(id).length;
        this.tx(() => this.linkAttachments(id, input.attachments!, owner ?? actor));
        if (this.attachmentsOf(id).length !== before) this.emit({ type: 'escalation', escalation: this.requireEscalation(id) });
      }
      return { ...this.requireEscalation(id), duplicate: true };
    }
    const { escalation, lane, blocks } = this.tx(() => {
      const at = this.now().toISOString();
      if (!Store.isEpicLane(input.laneId)) this.restoreLane(input.laneId, actor, at);
      const lane = this.laneIncludingArchived(input.laneId)!.lane;
      const id = randomUUID();
      const ref = Number((this.db.prepare('SELECT COALESCE(MAX(ref), 0) + 1 AS n FROM escalations').get() as Row).n);
      // The ticket's or epic's code and its next letter ("967A", "680A").
      const code = this.allocCode(projectOf(input.laneId), home.codeRef);
      if (home.ticketId !== null) this.db.prepare('UPDATE tickets SET updated_at = ? WHERE num = ?').run(at, home.ticketId);
      else this.db.prepare('UPDATE epics SET updated_at = ? WHERE num = ?').run(at, home.epicId);
      this.db
        .prepare(
          `INSERT INTO escalations (id, ref, letter_index, seq, ticket_id, epic_id, code, lane_id, question, context, recommendation, recommended_option, cost,
             alternatives, ticket, positions, options, links, blocking, state, created_by, created_at, updated_at, raised_by_owner,
             accept_means, reject_means, allow_reject)
           VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          ref,
          home.ticketId,
          home.epicId,
          code,
          input.laneId,
          input.question,
          input.context ?? null,
          input.recommendation ?? null,
          input.recommendedOption ?? null,
          input.cost ?? null,
          JSON.stringify(input.alternatives ?? []),
          input.ticket?.trim() ? this.refs.canonical(input.ticket) : null,
          JSON.stringify(
            (input.positions ?? []).map((p) => ({ agent: p.agent, stance: p.stance, note: p.note ?? null, at })),
          ),
          JSON.stringify(input.options ?? []),
          JSON.stringify(input.links ?? []),
          input.blocking === false ? 0 : 1,
          actor,
          at,
          at,
          owner,
          input.acceptMeans ?? null,
          input.allowReject === false ? null : (input.rejectMeans ?? null),
          input.allowReject === false ? 0 : 1,
        );
      this.linkAttachments(id, input.attachments ?? [], owner ?? actor);
      this.addEvent(input.laneId, at, 'escalation', `Escalated ${code}: ${input.question}`, actor, home.ticketId);
      // A ticket's blocking question blocks its lane; an epic's shows on the epic's card and blocks no lane.
      const blocks = home.ticketId !== null && input.blocking !== false && lane.status !== 'blocked_human';
      if (blocks) {
        this.applyLaneUpdate(lane, { status: 'blocked_human' }, actor, at);
      } else if (!Store.isEpicLane(input.laneId)) {
        this.db.prepare('UPDATE lanes SET updated_at = ? WHERE id = ?').run(at, input.laneId);
      }
      return { escalation: this.requireEscalation(id), lane: Store.isEpicLane(input.laneId) ? null : this.requireLane(input.laneId), blocks };
    });
    this.emit({ type: 'escalation', escalation });
    if (lane) this.emit({ type: 'lane', lane, statusChanged: blocks });
    return escalation;
  }

  /**
   * Where a new question belongs: the ticket its lane holds, or an epic (named, the one whose
   * internal lane it is, or the lane's group's epic when the lane holds no ticket).
   */
  private homeOf(laneId: string, epic: number | undefined): { ticketId: number | null; epicId: number | null; codeRef: string } {
    const internal = /\/~epic-(\d+)$/.exec(laneId);
    const named = epic ?? (internal ? Number(internal[1]) : undefined);
    if (named !== undefined) {
      const r = this.db.prepare('SELECT * FROM epics WHERE num = ?').get(named) as Row | undefined;
      if (!r || r.project_id !== projectOf(laneId)) throw new NotFoundError(`Epic ${named} not found`);
      // Raised from a lane: an epic of the lane's group.
      const laneGroup = internal ? null : ((this.db.prepare('SELECT group_id FROM lanes WHERE id = ?').get(laneId) as Row | undefined)?.group_id as string | null);
      if (laneGroup && r.group_id !== laneGroup) {
        throw new ValidationError(
          `Epic ${(r.display_ref as string | null) ?? r.name} is in group "${localId(r.group_id as string)}", not this lane's: leave lane_id out to raise it on the epic`,
        );
      }
      if (r.state === 'closed') {
        throw new ConflictError(`Epic ${(r.display_ref as string | null) ?? r.name} is closed: raise it on an open epic (list_epics)`);
      }
      return { ticketId: null, epicId: named, codeRef: r.code_ref as string };
    }
    const lane = this.db.prepare('SELECT ticket_id, group_id FROM lanes WHERE id = ?').get(laneId) as Row;
    if (lane.ticket_id != null) {
      const t = this.ticketRow(Number(lane.ticket_id));
      return { ticketId: Number(lane.ticket_id), epicId: null, codeRef: t.code_ref as string };
    }
    const open = lane.group_id ? this.openEpicsOf(lane.group_id as string) : [];
    const real = open.filter((r) => Number(r.stand_in) === 0);
    if (real.length > 1) {
      throw new ValidationError(
        `Lane "${localId(laneId)}" holds no ticket and its group has ${real.length} epics: say which (epic: ${real
          .map((r) => `"${this.refs.display(r.ref as string)}"`)
          .join(' or ')}), or fill the lane with its ticket first`,
      );
    }
    const r = real[0] ?? open[0];
    if (!r) throw new Error(`internal: lane ${laneId} has no group epic`);
    return { ticketId: null, epicId: Number(r.num), codeRef: r.code_ref as string };
  }

  /**
   * An open FYI becomes blocking: the lane blocks, and the owner is notified as for a new question.
   * Fields given again (context, recommendation, options, ...) replace the FYI's, so the owner has
   * what they need to answer.
   */
  private makeBlocking(id: string, input: EscalationInput, actor: string, owner: string | null): Escalation {
    let loose = false;
    const { escalation, lane, blocks } = this.tx(() => {
      const at = this.now().toISOString();
      const before = this.requireEscalation(id);
      const given = (v: unknown) => (v === undefined || v === null || (Array.isArray(v) && v.length === 0) ? null : v);
      const list = (v: unknown[] | undefined) => (given(v) ? JSON.stringify(v) : null);
      // Options and the recommended one go together, so new options also replace the recommended one.
      const newOptions = given(input.options) !== null;
      this.db
        .prepare(
          `UPDATE escalations SET blocking = 1, turn = 'owner', updated_at = ?,
             context = COALESCE(?, context), recommendation = COALESCE(?, recommendation), cost = COALESCE(?, cost),
             ticket = COALESCE(?, ticket), alternatives = COALESCE(?, alternatives), links = COALESCE(?, links),
             options = COALESCE(?, options), recommended_option = CASE WHEN ? THEN ? ELSE COALESCE(?, recommended_option) END,
             accept_means = COALESCE(?, accept_means), reject_means = COALESCE(?, reject_means),
             allow_reject = COALESCE(?, allow_reject)
           WHERE id = ?`,
        )
        .run(
          at,
          given(input.context) as string | null,
          given(input.recommendation) as string | null,
          given(input.cost) as string | null,
          input.ticket?.trim() ? this.refs.canonical(input.ticket) : null,
          list(input.alternatives),
          list(input.links),
          list(input.options),
          newOptions ? 1 : 0,
          input.recommendedOption ?? null,
          given(input.recommendedOption) as string | null,
          given(input.acceptMeans) as string | null,
          given(input.rejectMeans) as string | null,
          input.allowReject === undefined ? null : input.allowReject ? 1 : 0,
          id,
        );
      // Reject withdrawn: what it meant no longer applies.
      if (input.allowReject === false) this.db.prepare('UPDATE escalations SET reject_means = NULL WHERE id = ?').run(id);
      this.linkAttachments(id, input.attachments ?? [], owner ?? actor);
      this.addEvent(before.laneId, at, 'escalation', `${before.ref} now needs you: ${before.question}`, actor, before.ticketId);
      // It blocks the lane holding its ticket (or, with no ticket, the lane it was raised in); none while parked.
      const holder = this.holderOf(before);
      const lane = holder ? this.getLane(holder) : null;
      if (!lane) {
        this.syncLooseTicket(before.ticketId, at);
        loose = before.ticketId !== null;
      }
      const blocks = !!lane && lane.status !== 'blocked_human';
      if (lane && blocks) this.applyLaneUpdate(lane, { status: 'blocked_human' }, actor, at);
      return { escalation: this.requireEscalation(id), lane: lane ? this.requireLane(lane.id) : null, blocks };
    });
    this.emit({ type: 'escalation', escalation, raised: true });
    if (loose) this.emitTicket(escalation.ticketId);
    if (lane) this.emit({ type: 'lane', lane, statusChanged: blocks });
    return escalation;
  }

  // ---- lane conversations ----------------------------------------------

  private laneMessageFromRow(r: Row, readId?: number, column: 'lane_message_id' | 'epic_message_id' = 'lane_message_id'): LaneMessage {
    const attachments = (
      this.db.prepare(`SELECT id, name, type, size FROM attachments WHERE ${column} = ? ORDER BY position`).all(Number(r.id)) as Row[]
    ).map((a) => ({ id: a.id as string, name: a.name as string, type: a.type as AttachmentType, size: Number(a.size) }));
    const from = r.author_kind === 'agent' ? 'agent' : 'owner';
    return {
      id: Number(r.id),
      from,
      author: r.author as string,
      body: r.body as string,
      at: r.created_at as string,
      attachments,
      ...(from === 'owner' && readId !== undefined ? { seen: Number(r.id) <= readId } : {}),
    };
  }

  private agentReadId(laneId: string): number {
    return Number((this.db.prepare('SELECT agent_read_id FROM lanes WHERE id = ?').get(laneId) as Row | undefined)?.agent_read_id ?? 0);
  }

  /** A lane's conversation, oldest first: its latest `limit` messages. */
  laneMessages(laneId: string, limit = 100): LaneMessage[] {
    const readId = this.agentReadId(laneId);
    return (
      this.db.prepare('SELECT * FROM lane_messages WHERE lane_id = ? ORDER BY id DESC LIMIT ?').all(laneId, limit) as Row[]
    )
      .reverse()
      .map((r) => this.laneMessageFromRow(r, readId));
  }

  /**
   * The owner's messages on a lane that its agent hasn't been handed yet, oldest first, plus (with
   * `since`) those written at or after it, handed over or not. `onlySince`: just those since `since`
   * (a wait's digest, which depends on `since` alone).
   */
  private unreadByAgent(laneId: string, since?: string, onlySince = false): LaneMessage[] {
    return (
      this.db
        .prepare(
          `SELECT m.* FROM lane_messages m JOIN lanes l ON l.id = m.lane_id
           WHERE m.lane_id = ? AND m.author_kind = 'owner' AND ((? = 0 AND m.id > l.agent_read_id) OR m.created_at >= ?) ORDER BY m.id`,
        )
        .all(laneId, onlySince ? 1 : 0, since ?? '\uffff') as Row[]
    ).map((r) => this.laneMessageFromRow(r));
  }

  /**
   * Hands the owner's unread messages on a lane to its agent: returns them and marks them seen.
   * Called wherever an agent hears back (publishing the lane, writing on it, a wait that returns).
   */
  takeUnreadForAgent(laneId: string): LaneMessage[] {
    const unread = this.unreadByAgent(laneId);
    if (unread.length) this.markSeenByAgent(laneId, unread.at(-1)!.id);
    return unread;
  }

  private markSeenByAgent(laneId: string, upTo: number) {
    const res = this.db.prepare('UPDATE lanes SET agent_read_id = ? WHERE id = ? AND agent_read_id < ?').run(upTo, laneId, upTo);
    if (res.changes > 0) {
      const lane = this.getLane(laneId);
      if (lane) this.emit({ type: 'lane', lane });
    }
  }

  /**
   * Writes in a lane's conversation. Nothing here blocks the lane or changes its status.
   * - The agent's message (a milestone, with any files) is kept in the lane's history and pushed
   *   quietly; one per lane per minute, so a looping agent can't flood a phone.
   * - The owner's waits for the agent, which gets it the next time it publishes the lane, writes on
   *   it, or waits on it. Not on removed lanes.
   * A retry (same author, same text, within the minute) returns the message already sent.
   */
  postLaneMessage(
    laneId: string,
    message: { from: 'owner' | 'agent'; author: string; body: string; attachments?: string[] },
    owner: string,
  ): LaneMessage {
    const max = message.from === 'agent' ? AGENT_MESSAGE_MAX : OWNER_MESSAGE_MAX;
    const body = message.body.trim();
    if (!body) throw new ValidationError('The message is empty');
    if (body.length > max) {
      throw new ValidationError(
        message.from === 'agent'
          ? `Keep messages under ${max} characters: attach a file (POST /api/attachments) for anything longer`
          : `Messages are limited to ${max} characters`,
      );
    }
    const found = Store.isEpicLane(laneId) ? null : this.laneIncludingArchived(laneId);
    if (!found) throw new NotFoundError(`Lane "${localId(laneId)}" not found: publish it first (update_lane with its group)`);
    if (message.from === 'owner' && found.archived) {
      throw new ConflictError(`Lane "${localId(laneId)}" was removed from the dashboard: its conversation is closed`);
    }
    const at = this.now();
    const { posted, duplicate } = this.tx(() => {
      const recent = this.db
        .prepare('SELECT * FROM lane_messages WHERE lane_id = ? AND author_kind = ? ORDER BY id DESC LIMIT 1')
        .get(laneId, message.from) as Row | undefined;
      const fresh = recent && at.getTime() - Date.parse(recent.created_at as string) < 60_000;
      // A retry returns the message already sent; the owner saying the same again after the agent read it is new.
      const retry =
        fresh &&
        recent.author === message.author &&
        recent.body === body &&
        (message.from === 'agent' || Number(recent.id) > this.agentReadId(laneId));
      if (retry) return { posted: this.laneMessageFromRow(recent, this.agentReadId(laneId)), duplicate: true };
      if (message.from === 'agent' && fresh) {
        throw new ConflictError('One message per lane per minute: put everything in one message');
      }
      const id = Number(
        this.db
          .prepare('INSERT INTO lane_messages (lane_id, author_kind, author, body, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(laneId, message.from, message.author, body, at.toISOString()).lastInsertRowid,
      );
      if (message.attachments?.length) this.linkLaneAttachments(id, message.attachments, owner);
      this.addEvent(laneId, at.toISOString(), message.from === 'agent' ? 'notice' : 'message', body, message.author);
      // The agent writing is the agent being alive; the owner's note says nothing about the lane's freshness.
      if (message.from === 'agent') this.db.prepare('UPDATE lanes SET updated_at = ? WHERE id = ?').run(at.toISOString(), laneId);
      const row = this.db.prepare('SELECT * FROM lane_messages WHERE id = ?').get(id) as Row;
      return { posted: this.laneMessageFromRow(row, this.agentReadId(laneId)), duplicate: false };
    });
    if (duplicate) return posted;
    const lane = this.getLane(laneId);
    if (lane) this.emit({ type: 'lane', lane, messaged: message.from });
    if (message.from === 'agent') {
      this.events.emit('notice', {
        project: projectOf(laneId),
        laneId,
        message: body,
        by: message.author,
        attachments: posted.attachments,
      });
    }
    return posted;
  }

  /** The agent's message on a lane, as notify_owner sends it. */
  postNotice(laneId: string, message: string, actor: string, attachments: string[] = [], owner = actor): { laneId: string; message: string; at: string } {
    const m = this.postLaneMessage(laneId, { from: 'agent', author: actor, body: message, attachments }, owner);
    return { laneId, message: m.body, at: m.at };
  }

  /**
   * Records the human answer. With `change`, replaces the answer on an
   * escalation that's decided but not yet acknowledged (a mis-tap); without
   * it, a second decision is a conflict, so two people can't overwrite each other.
   */
  decideEscalation(id: string, decision: string, note: string | null, by: string, change = false): Escalation {
    // The answer bar's choices: Accept, Reject (where the agent offered it) or Other with instructions.
    // People answering from their own Claude session may still write a free-text answer, and older
    // escalations with options take any of them.
    const target = this.requireEscalation(id);
    const choice = decision.trim().toLowerCase();
    if (!target.options.length && (choice === 'accept' || choice === 'reject' || choice === 'other')) {
      if (choice === 'reject' && !target.allowReject) throw new ValidationError("The agent didn't offer Reject on this escalation");
      if (choice === 'other' && !note?.trim()) throw new ValidationError('Other needs instructions for the agent');
      decision = choice[0].toUpperCase() + choice.slice(1);
      // Other opens a conversation: the instructions go to the agent, which acts on them or replies.
      if (choice === 'other' && target.state === 'open') {
        return this.postMessage(target.id, { from: 'owner', author: by, body: note!, attachments: [] }, by);
      }
    }
    if (change) {
      const current = this.requireEscalation(id);
      if (current.state === 'acknowledged') {
        throw new ConflictError('The agent has already acknowledged this decision, so it can no longer be changed');
      }
      if (current.state === 'decided') {
        return this.closeHumanStep(
          current.id,
          ['decided'],
          (at) => {
            this.db
              .prepare(`UPDATE escalations SET decision = ?, decision_note = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?`)
              .run(decision, note, by, at, at, current.id);
            return `Decision changed by ${by}: ${decision} (was ${current.decision} by ${current.decidedBy})`;
          },
          by,
          false,
        );
      }
    }
    return this.closeHumanStep(
      id,
      ['open'],
      (at, eid) => {
        this.db
          .prepare(
            `UPDATE escalations SET state = 'decided', decision = ?, decision_note = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?`,
          )
          .run(decision, note, by, at, at, eid);
        return `Decided by ${by}: ${decision}`;
      },
      by,
      true,
    );
  }

  /**
   * Closes a decided escalation; the result carries the decision to act on.
   * Acknowledging again is a no-op that returns the same result, so retries are
   * safe. `lane` optionally publishes what the agent does next in the same call;
   * otherwise lane status is left alone.
   */
  acknowledgeEscalation(
    id: string,
    note: string | null,
    actor: string,
    lane?: Pick<LanePatch, 'status' | 'activity'>,
  ): Escalation {
    const current = this.requireEscalation(id);
    const close = () =>
      this.closeHumanStep(
        current.id,
        ['decided'],
        (at, eid) => {
          this.db
            .prepare(
              `UPDATE escalations SET state = 'acknowledged', acknowledged_at = ?, resolution = COALESCE(?, resolution), updated_at = ? WHERE id = ?`,
            )
            .run(at, note, at, eid);
          return `Decision ${current.ref} acknowledged`;
        },
        actor,
        false,
      );
    // A repeated acknowledgement changes nothing, so a late retry can't roll the lane back.
    if (current.state === 'acknowledged') return current;
    // The owner answered Other: acknowledging takes their instructions as the decision. That holds
    // after the agent replied too (it's the owner's turn again), so an agent that replied and then
    // decided to act isn't left with a conversation it can only dismiss.
    const thread = current.state === 'open' ? this.messagesOf(current.id) : [];
    const lastOwner = thread.findLastIndex((m) => m.from === 'owner');
    // On the owner's turn, only after the agent's reply: an FYI re-raised as blocking also hands the
    // turn back, and its old notes mustn't answer the new question.
    if (lastOwner >= 0 && (current.turn === 'agent' || thread[thread.length - 1].from === 'agent')) {
      // The owner's latest run of messages, so earlier instructions in it aren't lost.
      const pending = thread.slice(thread.slice(0, lastOwner).findLastIndex((m) => m.from === 'agent') + 1, lastOwner + 1);
      const last = pending[pending.length - 1];
      const escalation = this.closeHumanStep(
        current.id,
        ['open'],
        (at, eid) => {
          this.db
            .prepare(
              `UPDATE escalations SET state = 'acknowledged', decision = 'Other', decision_note = ?, decided_by = ?, decided_at = ?,
                 acknowledged_at = ?, resolution = COALESCE(?, resolution), updated_at = ? WHERE id = ?`,
            )
            .run(pending.map((m) => m.body).join('\n\n'), last.author, last.at, at, note, at, eid);
          return `Instructions on ${current.ref} acknowledged`;
        },
        actor,
        // After the agent's reply the escalation holds its lane blocked again; acknowledging releases it.
        current.turn === 'owner',
      );
      this.publishAfterClose(escalation, lane, actor);
      return escalation;
    }
    const escalation = close();
    this.publishAfterClose(escalation, lane, actor);
    return escalation;
  }

  /**
   * The lane's next state, given with an acknowledgement: published to the lane the escalation counts
   * on (its ticket's lane), only while that lane is on the dashboard (publishing would restore a removed
   * one), and not at all while its ticket is parked.
   */
  private publishAfterClose(escalation: Escalation, lane: Pick<LanePatch, 'status' | 'activity'> | undefined, actor: string) {
    if (!lane || (!lane.status && lane.activity === undefined)) return;
    const holder = this.holderOf(escalation);
    if (holder && this.getLane(holder)) this.upsertLane(holder, lane, actor);
  }

  /** Agent (or human) closes an escalation without a dashboard decision, e.g. it was answered in Remote Control. */
  withdrawEscalation(id: string, resolution: string | null, actor: string): Escalation {
    return this.closeHumanStep(
      id,
      ['open', 'decided'],
      (at, eid) => {
        this.db
          .prepare(`UPDATE escalations SET state = 'withdrawn', resolution = ?, withdrawn_by = ?, updated_at = ? WHERE id = ?`)
          .run(resolution, actor, at, eid);
        return `Escalation closed${resolution ? `: ${resolution}` : ''}`;
      },
      actor,
      true,
    );
  }

  /**
   * Closes an alert that's been dealt with (the owner answered in the agent's session, or it became moot),
   * with the justification, and publishes the lane's next state. A lane this unblocks goes back to
   * `active` unless a status is given.
   */
  dismissEscalation(
    id: string,
    justification: string | null,
    actor: string,
    lane: Pick<LanePatch, 'status' | 'activity'> = {},
    /** A person dismissing a stale alert leaves the lane waiting on its agent instead of showing it working. */
    byAgent = true,
  ): Escalation {
    const before = this.requireEscalation(id);
    const holder = this.holderOf(before);
    const laneBefore = holder ? this.getLane(holder)?.status : undefined;
    // A lane showing the agent working on the owner's Other counts as unblocked by the dismissal too.
    const wasBlocked = laneBefore === 'blocked_human' || (before.state === 'open' && before.turn === 'agent' && laneBefore === 'awaiting_agent');
    const escalation = this.withdrawEscalation(id, justification, actor);
    // The lane it counted on: its ticket's (none while parked), or where it was raised.
    const after = holder ? this.getLane(holder) : null;
    if (!after) return escalation;
    const status = lane.status ?? (byAgent && wasBlocked && after.status === 'awaiting_agent' ? 'active' : undefined);
    if (status || lane.activity !== undefined) this.upsertLane(after.id, { status, activity: lane.activity }, actor);
    return escalation;
  }

  /**
   * Open blocking escalations holding the lane, waiting on the owner (not ones where the agent is
   * replying): its ticket's. A parked ticket's don't block the lane, and an epic's never do.
   */
  private openBlockingCount(laneId: string) {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM escalations e
         WHERE e.state = 'open' AND e.blocking = 1 AND e.turn = 'owner' AND e.ticket_id = (SELECT ticket_id FROM lanes WHERE id = ?)`,
      )
      .get(laneId) as Row;
    return Number(r.n);
  }

  /**
   * The lane an escalation counts on: the lane holding its ticket (none while the ticket is parked or
   * over, and none for an epic's). Its `laneId` stays where it was raised.
   */
  private holderOf(e: Escalation): string | null {
    if (e.ticketId === null) return null;
    return ((this.db.prepare('SELECT lane_id FROM tickets WHERE num = ?').get(e.ticketId) as Row | undefined)?.lane_id as string | null) ?? null;
  }

  /**
   * Shared state transition. When `mayUnblock` and an open blocking
   * escalation just closed, a blocked_human lane with no open blocking
   * escalations left moves to awaiting_agent, so the blocked timer stops
   * while the agent picks up the answer. Lanes the agent blocked by hand,
   * and FYI escalations, never unblock it.
   */
  private closeHumanStep(
    id: string,
    from: EscalationState[],
    apply: (at: string, id: string) => string,
    actor: string,
    mayUnblock: boolean,
  ): Escalation {
    let loose = false;
    const { escalation, lane, unblocked } = this.tx(() => {
      const current = this.requireEscalation(id);
      if (!from.includes(current.state)) {
        throw new ConflictError(`Escalation ${current.ref} is ${current.state}; expected ${from.join(' or ')}`);
      }
      const at = this.now().toISOString();
      const message = apply(at, current.id);
      this.addEvent(current.laneId, at, 'escalation', message, actor, current.ticketId);
      // A finished lane gives its letter back once nothing is left for anyone to answer or pick up.
      this.syncLetter(current.laneId);
      // The lane it counts on: its ticket's (none while parked), or where it was raised.
      const holder = this.holderOf(current);
      const found = holder ? this.laneIncludingArchived(holder) : null;
      if (!found) {
        // A ticket no lane holds: its status may change, and its open count does.
        this.syncLooseTicket(current.ticketId, at);
        loose = current.ticketId !== null;
        return { escalation: this.requireEscalation(current.id), lane: null, unblocked: false };
      }
      const { lane, archived } = found;
      const unblocked =
        !archived &&
        mayUnblock &&
        current.state === 'open' &&
        current.blocking &&
        lane.status === 'blocked_human' &&
        this.openBlockingCount(lane.id) === 0;
      if (unblocked) this.applyLaneUpdate(lane, { status: 'awaiting_agent' }, null, at);
      return { escalation: this.requireEscalation(current.id), lane: archived ? null : this.requireLane(lane.id), unblocked };
    });
    this.emit({ type: 'escalation', escalation });
    // Emitted either way (the open-escalation count changed), except for archived lanes,
    // which clients don't show.
    if (loose) this.emitTicket(escalation.ticketId);
    if (lane) this.emit({ type: 'lane', lane, statusChanged: unblocked });
    return escalation;
  }

  /** Records (or replaces) one agent's stance on an open escalation's recommendation. */
  addPosition(id: string, position: { agent: string; stance: Stance; note?: string | null }, actor: string): Escalation {
    const escalation = this.tx(() => {
      const current = this.requireEscalation(id);
      if (current.state !== 'open') throw new ConflictError(`Escalation ${current.ref} is ${current.state}; positions close once decided`);
      const at = this.now().toISOString();
      const positions = current.positions.filter((p) => p.agent !== position.agent);
      if (positions.length >= MAX_POSITIONS) throw new ConflictError(`At most ${MAX_POSITIONS} agents can take a position`);
      positions.push({ agent: position.agent, stance: position.stance, note: position.note ?? null, at });
      this.db
        .prepare('UPDATE escalations SET positions = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(positions), at, current.id);
      const verb = { agree: 'agrees', disagree: 'disagrees', neutral: 'is neutral' }[position.stance];
      this.addEvent(current.laneId, at, 'escalation', `${position.agent} ${verb}${position.note ? `: ${position.note}` : ''}`, actor, current.ticketId);
      return this.requireEscalation(current.id);
    });
    this.emit({ type: 'escalation', escalation });
    return escalation;
  }

  // ---- waiting agents ------------------------------------------------------

  /** Marks lanes as having a waiting agent; returns the release function. */
  private holdWaiting(laneIds: Iterable<string>) {
    const ids = [...new Set(laneIds)];
    for (const id of ids) {
      const n = this.waiting.get(id) ?? 0;
      this.waiting.set(id, n + 1);
      if (n === 0) this.emitLaneIfShown(id);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const timer = setTimeout(() => {
        this.graceTimers.delete(timer);
        for (const id of ids) {
          const n = (this.waiting.get(id) ?? 1) - 1;
          if (n > 0) this.waiting.set(id, n);
          else {
            this.waiting.delete(id);
            this.emitLaneIfShown(id);
          }
        }
      }, this.waitGraceMs);
      timer.unref?.();
      this.graceTimers.add(timer);
    };
  }

  private emitLaneIfShown(id: string) {
    try {
      const lane = this.getLane(id);
      if (lane) this.emit({ type: 'lane', lane });
    } catch {
      // The database is closing.
    }
  }

  /** Resolves when the escalation leaves `open`, or with the current value on timeout. */
  waitForDecision(id: string, timeoutMs: number, signal?: AbortSignal): Promise<Escalation> {
    const current = this.requireEscalation(id);
    // The agent's turn (the owner answered Other) needs the agent as much as a decision does.
    if (current.state !== 'open' || current.turn === 'agent' || timeoutMs <= 0) return Promise.resolve(current);
    id = current.id;
    const release = this.holdWaiting([current.laneId]);
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.events.off('change', onChange);
        signal?.removeEventListener('abort', done);
        release();
        const latest = this.getEscalation(id);
        // The lane (and with it the escalation) was deleted while waiting.
        if (latest) resolve(latest);
        else reject(new NotFoundError(`Escalation "${id}" no longer exists`));
      };
      const onChange = (e: StreamEvent) => {
        if (e.type === 'escalation' && e.escalation.id === id && (e.escalation.state !== 'open' || e.escalation.turn === 'agent')) done();
        if (e.type === 'lane_deleted' && e.id === current.laneId) done();
      };
      const timer = setTimeout(done, timeoutMs);
      this.events.on('change', onChange);
      signal?.addEventListener('abort', done);
    });
  }

  /** Where things stand for a wait scope right now. Unknown groups and lanes are errors (likely typos). */
  decisionsFor(scope: WaitScope): WaitResult {
    // A millisecond past everything this result can include, and nothing written later is stamped
    // earlier: a wait from this `since` neither repeats what it returns nor misses what comes next.
    const checkedMs = this.now().getTime() + 1;
    this.floorMs = Math.max(this.floorMs, checkedMs);
    const checkedAt = new Date(checkedMs).toISOString();
    const digest = scope.mode !== 'full';
    // A wait's digest depends on `since` alone; get_updates (no mode) also hands over what the agent hasn't had.
    const onlySince = scope.mode === 'digest' && !!scope.since && scope.givenSince !== false;
    const named = (scope.ids ?? []).map((id) => this.requireEscalation(id));
    const byId = new Map<string, StoredEscalation>(named.map((e) => [e.id, e]));
    const laneIds = new Set<string>();
    for (const id of scope.laneIds ?? []) {
      if (!this.db.prepare('SELECT 1 FROM lanes WHERE id = ?').get(id)) throw new NotFoundError(`Lane "${localId(id)}" not found`);
      laneIds.add(id);
    }
    if (scope.groupId) {
      if (!this.db.prepare('SELECT 1 FROM groups WHERE id = ?').get(scope.groupId)) {
        throw new NotFoundError(`Group "${localId(scope.groupId)}" not found`);
      }
      const rows = this.db.prepare('SELECT id FROM lanes WHERE group_id = ?').all(scope.groupId) as Row[];
      for (const r of rows) laneIds.add(r.id as string);
    }
    const closedById = new Map<string, StoredEscalation>();
    for (const e of named) {
      if (e.state !== 'acknowledged' && e.state !== 'withdrawn') continue;
      // A digest reports a named one once, and only when someone else withdrew it: the agent's own
      // acknowledgement would otherwise wake every later wait at once.
      if (digest) {
        const by = (this.db.prepare('SELECT withdrawn_by FROM escalations WHERE id = ?').get(e.id) as Row).withdrawn_by;
        if (e.state !== 'withdrawn' || !scope.since || e.updatedAt < scope.since || (by ?? '') === (scope.viewer ?? '')) continue;
      }
      closedById.set(e.id, e);
    }
    const removedLanes: WaitResult['removedLanes'] = [];
    // The owner's notes on every lane in scope, the lanes of escalations named in `ids` included.
    const laneMessages: WaitResult['laneMessages'] = [];
    for (const laneId of new Set([...laneIds, ...named.map((e) => e.laneId)])) {
      const unread = this.unreadByAgent(laneId, digest ? scope.since : undefined, onlySince);
      if (unread.length && this.getLane(laneId)) laneMessages.push({ laneId, messages: unread });
    }
    for (const laneId of laneIds) {
      if (scope.since) {
        // Covers lanes removed with nothing open on them, which leave no withdrawn escalation behind.
        const removed = this.db
          .prepare(
            `SELECT e.at, e.actor FROM lane_events e JOIN lanes l ON l.id = e.lane_id
             WHERE e.lane_id = ? AND l.archived_at IS NOT NULL AND e.kind = 'status' AND e.message = 'Lane removed'
               AND e.at >= ? AND COALESCE(e.actor, '') <> ? ORDER BY e.id DESC LIMIT 1`,
          )
          .get(laneId, scope.since, scope.viewer ?? '') as Row | undefined;
        if (removed) removedLanes.push({ laneId, removedBy: (removed.actor as string | null) ?? null, at: removed.at as string });
      }
      for (const e of this.listEscalations({ laneId, states: ['open', 'decided'] })) byId.set(e.id, e);
      if (scope.since) {
        const rows = this.db
          .prepare(
            `SELECT * FROM escalations WHERE lane_id = ? AND state = 'withdrawn' AND updated_at >= ?
               AND COALESCE(withdrawn_by, '') <> ?`,
          )
          .all(laneId, scope.since, scope.viewer ?? '') as Row[];
        for (const r of rows) closedById.set(r.id as string, this.escalationFromRow(r));
      }
    }
    // Questions also count where their ticket is: those of tickets the lanes hold, and a group's parked ones.
    const ticketIds = new Set<number>();
    for (const laneId of laneIds) {
      const held = (this.db.prepare('SELECT ticket_id FROM lanes WHERE id = ?').get(laneId) as Row | undefined)?.ticket_id;
      if (held != null) ticketIds.add(Number(held));
    }
    if (scope.groupId) {
      for (const r of this.db.prepare("SELECT num FROM tickets WHERE group_id = ? AND state = 'parked'").all(scope.groupId) as Row[]) {
        ticketIds.add(Number(r.num));
      }
    }
    for (const ticketId of ticketIds) {
      for (const e of this.listEscalations({ ticketId, states: ['open', 'decided'] })) byId.set(e.id, e);
      if (scope.since) {
        const rows = this.db
          .prepare(
            `SELECT * FROM escalations WHERE ticket_id = ? AND state = 'withdrawn' AND updated_at >= ?
               AND COALESCE(withdrawn_by, '') <> ?`,
          )
          .all(ticketId, scope.since, scope.viewer ?? '') as Row[];
        for (const r of rows) closedById.set(r.id as string, this.escalationFromRow(r));
      }
    }
    // A group's epics: their questions, and people's notes on their boards.
    const boardMessages: WaitResult['boardMessages'] = [];
    if (scope.groupId) {
      for (const r of this.db.prepare('SELECT * FROM epics WHERE group_id = ? ORDER BY num').all(scope.groupId) as Row[]) {
        const epicId = Number(r.num);
        for (const e of this.listEscalations({ epicId, states: ['open', 'decided'] })) byId.set(e.id, e);
        if (scope.since) {
          const rows = this.db
            .prepare(
              `SELECT * FROM escalations WHERE epic_id = ? AND state = 'withdrawn' AND updated_at >= ?
                 AND COALESCE(withdrawn_by, '') <> ?`,
            )
            .all(epicId, scope.since, scope.viewer ?? '') as Row[];
          for (const row of rows) closedById.set(row.id as string, this.escalationFromRow(row));
        }
        const unread = this.unreadEpicByAgent(epicId, digest ? scope.since : undefined, onlySince);
        if (unread.length) {
          // Named as tools take it: its ref, or the group's id for a stand-in.
          boardMessages.push({ project: r.project_id as string, epicId, epic: (r.display_ref as string | null) ?? localId(r.group_id as string), messages: unread });
        }
      }
    }
    // Tickets from these lanes that a lane outside them took since `since`.
    const movedTickets: WaitResult['movedTickets'] = [];
    if (digest && scope.since && laneIds.size) {
      const inScope = [...laneIds];
      const marks = inScope.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT f.ticket_id, f.lane_id, f.actor, f.at, t.ref FROM lane_events f JOIN tickets t ON t.num = f.ticket_id
           WHERE f.kind = 'ticket' AND f.message LIKE 'Filled with %' AND f.at >= ? AND COALESCE(f.actor, '') <> ?
             AND f.lane_id NOT IN (${marks})
             AND EXISTS (SELECT 1 FROM lane_events p WHERE p.ticket_id = f.ticket_id AND p.lane_id IN (${marks}) AND p.id < f.id)
           ORDER BY f.id`,
        )
        .all(scope.since, scope.viewer ?? '', ...inScope, ...inScope) as Row[];
      for (const r of rows) {
        movedTickets.push({
          ticket: this.refs.display(r.ref as string),
          ticketId: Number(r.ticket_id),
          laneId: r.lane_id as string,
          by: (r.actor as string | null) ?? null,
          at: r.at as string,
        });
      }
    }
    // Creation order; the internal global number breaks ties within a millisecond.
    const seqOf = (e: Escalation) => Number((this.db.prepare('SELECT ref FROM escalations WHERE id = ?').get(e.id) as Row).ref);
    const byAge = (a: Escalation, b: Escalation) => a.createdAt.localeCompare(b.createdAt) || seqOf(a) - seqOf(b);
    const all = [...byId.values()].sort(byAge);
    const decided = all.filter((e) => e.state === 'decided');
    const closed = [...closedById.values()].sort(byAge);
    const open = all
      .filter((e) => e.state === 'open' && e.turn === 'owner')
      .map((e) => ({ id: e.id, ref: e.ref, laneId: e.laneId, ...(e.epicName ? { epicName: e.epicName } : {}), question: e.question }));
    const replies = all
      .filter((e) => e.state === 'open' && e.turn === 'agent')
      .map((e) => {
        const thread = this.messagesOf(e.id);
        const lastAgent = thread.findLastIndex((m) => m.from === 'agent');
        return {
          id: e.id,
          ref: e.ref,
          projectKey: e.projectKey,
          laneId: e.laneId,
          ...(e.epicName ? { epicName: e.epicName } : {}),
          question: e.question,
          messages: thread.slice(lastAgent + 1),
        };
      });
    return {
      ready:
        decided.length > 0 ||
        replies.length > 0 ||
        laneMessages.length > 0 ||
        boardMessages.length > 0 ||
        closed.length > 0 ||
        removedLanes.length > 0 ||
        movedTickets.length > 0 ||
        // The full format also returns when nothing is left to wait for; a digest waits for a change.
        (!digest && open.length === 0),
      decided,
      replies,
      closed,
      open,
      removedLanes,
      laneMessages,
      movedTickets,
      boardMessages,
      checkedAt,
    };
  }

  /**
   * Marks the lane messages in a wait result as handed to the agent. Callers do this only once the
   * result is going back to it (credential still valid), and only for the projects it still sees.
   */
  handOver(w: WaitResult, projects?: string[]): WaitResult {
    for (const l of w.laneMessages) {
      if (!projects || projects.includes(projectOf(l.laneId))) this.markSeenByAgent(l.laneId, l.messages.at(-1)!.id);
    }
    for (const b of w.boardMessages) {
      if (projects && !projects.includes(b.project)) continue;
      const upTo = b.messages.at(-1)!.id;
      if (this.db.prepare('UPDATE epics SET agent_read_id = ? WHERE num = ? AND agent_read_id < ?').run(upTo, b.epicId, upTo).changes > 0) {
        this.emitEpic(b.epicId);
      }
    }
    return w;
  }

  /**
   * Waits until anything in scope needs the agent: an escalation was decided
   * (and isn't acknowledged yet) or answered Other, one was closed by someone
   * else, a lane was removed, or the owner wrote on a lane (in the full format,
   * also when nothing is left open). Returns at once if that's already so. While it waits, the
   * lanes it covers show that an agent is listening, including lanes that get
   * a new question during the wait.
   */
  waitForDecisions(scope: WaitScope, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
    // Without a `since` of its own, the wait still hands over notes the agent hasn't had.
    scope = { ...scope, since: scope.since ?? this.now().toISOString(), givenSince: scope.givenSince ?? !!scope.since };
    const first = this.decisionsFor(scope);
    if (first.ready || timeoutMs <= 0 || signal?.aborted) return Promise.resolve(first);
    const held = new Set<string>();
    const releases: (() => void)[] = [];
    const hold = (laneIds: Iterable<string | null>) => {
      const fresh = [...laneIds].filter((id): id is string => id !== null && !held.has(id));
      if (!fresh.length) return;
      for (const id of fresh) held.add(id);
      releases.push(this.holdWaiting(fresh));
    };
    hold([...first.open.map((e) => e.laneId), ...(scope.laneIds ?? [])]);
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.events.off('change', onChange);
        signal?.removeEventListener('abort', finish);
        for (const release of releases) release();
        try {
          resolve(this.decisionsFor(scope));
        } catch (err) {
          reject(err);
        }
      };
      const onChange = (e: StreamEvent) => {
        const note = (e.type === 'lane' || e.type === 'epic') && e.messaged === 'owner';
        if (e.type !== 'escalation' && e.type !== 'lane_deleted' && e.type !== 'ticket' && !note) return;
        try {
          const now = this.decisionsFor(scope);
          if (now.ready) finish();
          else hold(now.open.map((o) => o.laneId));
        } catch {
          finish();
        }
      };
      const timer = setTimeout(finish, timeoutMs);
      this.events.on('change', onChange);
      signal?.addEventListener('abort', finish);
    });
  }

  // ---- export --------------------------------------------------------------

  /**
   * Flat rows for analysis, including archived lanes and groups and closed
   * escalations. `from`/`to` (ISO timestamps) filter escalations and
   * positions by creation time and events by time; lanes and groups are
   * always complete.
   */
  exportRows(dataset: ExportDataset, filter: ExportFilter = {}): Record<string, unknown>[] {
    return this.exportPage(dataset, filter, 0, -1).rows;
  }

  /**
   * One keyset page of export rows: rows after row id `after`, at most `limit`
   * (-1 = all). `last` is the row id to continue from, null when done. Big
   * exports page through this and yield to the event loop between pages.
   */
  exportPage(
    dataset: ExportDataset,
    filter: ExportFilter,
    after: number,
    limit: number,
  ): { rows: Record<string, unknown>[]; last: number | null } {
    type Out = Record<string, unknown>;
    const page = (raw: Row[], map: (r: Row) => Out | Out[]): { rows: Out[]; last: number | null } => ({
      rows: raw.flatMap((r): Out[] => {
        const mapped = map(r);
        return Array.isArray(mapped) ? mapped : [mapped];
      }),
      last: limit > 0 && raw.length === limit ? Number(raw[raw.length - 1]._rid) : null,
    });
    const nowMs = this.now().getTime();
    const seconds = (from: unknown, to: unknown) =>
      typeof from === 'string' && typeof to === 'string' ? Math.round((Date.parse(to) - Date.parse(from)) / 1000) : null;
    /** WHERE clause: keyset position, optional time range on `timeCol`, optional lane. */
    const local = (v: unknown) => (typeof v === 'string' ? localId(v) : v);
    // An epic's internal lane (where its own questions are raised) isn't a lane anyone knows.
    const laneOut = (v: unknown) => (typeof v === 'string' && Store.isEpicLane(v) ? null : local(v));
    const where = (
      ridCol: string,
      laneCol: string | null,
      timeCol?: string,
      projectCol = `substr(${laneCol}, 1, instr(${laneCol}, '/') - 1)`,
    ) => {
      const parts = [`${ridCol} > ?`];
      const params: (string | number)[] = [after];
      if (filter.projects) {
        parts.push(filter.projects.length ? `${projectCol} IN (${filter.projects.map(() => '?').join(',')})` : '0');
        params.push(...filter.projects);
      }
      if (timeCol && filter.from) (parts.push(`${timeCol} >= ?`), params.push(filter.from));
      if (timeCol && filter.to) (parts.push(`${timeCol} < ?`), params.push(filter.to));
      if (filter.laneId && laneCol) (parts.push(`${laneCol} = ?`), params.push(filter.laneId));
      return { sql: `WHERE ${parts.join(' AND ')} ORDER BY ${ridCol} LIMIT ?`, params: [...params, limit] };
    };

    if (dataset === 'requirements') {
      const parts = ['num > ?'];
      const params: (string | number)[] = [after];
      if (filter.projects) {
        parts.push(
          `(project_id IS NULL${filter.projects.length ? ` OR project_id IN (${filter.projects.map(() => '?').join(',')})` : ''})`,
        );
        params.push(...filter.projects);
      }
      if (filter.from) (parts.push('created_at >= ?'), params.push(filter.from));
      if (filter.to) (parts.push('created_at < ?'), params.push(filter.to));
      if (!filter.includeRejected) parts.push("status <> 'rejected'");
      const raw = this.db
        .prepare(`SELECT num AS _rid, * FROM requirements WHERE ${parts.join(' AND ')} ORDER BY num LIMIT ?`)
        .all(...params, limit) as Row[];
      return page(raw, (r) => {
        const req = this.requirementFromRow(r);
        return {
          id: req.id,
          project: req.project,
          group_id: req.group && localId(req.group),
          requirement: req.requirement,
          justification: req.justification,
          tags: req.tags.join(' | '),
          status: req.status,
          superseded_by: req.supersededBy,
          decided_by: req.decidedBy,
          source_escalation: req.sourceEscalation,
          recorded_by: req.recordedBy,
          created_at: req.createdAt,
          updated_at: req.updatedAt,
          rejection_reason: req.rejectionReason,
          scope: req.scope,
          products: req.products.join(' | '),
          needs_regrouping: req.needsRegrouping,
        };
      });
    }

    if (dataset === 'products') {
      // Complete (within the projects), archived ones too, like groups.
      const parts = ['p.rowid > ?'];
      const params: (string | number)[] = [after];
      if (filter.projects) {
        parts.push(filter.projects.length ? `p.project_id IN (${filter.projects.map(() => '?').join(',')})` : '0');
        params.push(...filter.projects);
      }
      const raw = this.db
        .prepare(`SELECT p.rowid AS _rid, x.* FROM products p JOIN (${Store.PRODUCT_SELECT}) x ON x.project_id = p.project_id AND x.id = p.id
          WHERE ${parts.join(' AND ')} ORDER BY p.rowid LIMIT ?`)
        .all(...params, limit) as Row[];
      return page(raw, (r) => {
        const p = this.productFromRow(r);
        return {
          project: p.project,
          id: p.id,
          name: p.name,
          color: p.color,
          locked: p.locked,
          archived: p.archived,
          requirements: p.requirements,
          created_by: p.createdBy,
          created_at: p.createdAt,
          updated_at: p.updatedAt,
        };
      });
    }

    if (dataset === 'requirement_changes') {
      // Changes to the requirements the export includes: by the requirement's project now, rejected ones only when asked for.
      const parts = ['c.id > ?'];
      const params: (string | number)[] = [after];
      if (filter.projects) {
        parts.push(`(r.project_id IS NULL${filter.projects.length ? ` OR r.project_id IN (${filter.projects.map(() => '?').join(',')})` : ''})`);
        params.push(...filter.projects);
      }
      if (filter.from) (parts.push('c.at >= ?'), params.push(filter.from));
      if (filter.to) (parts.push('c.at < ?'), params.push(filter.to));
      if (!filter.includeRejected) parts.push("r.status <> 'rejected'");
      const raw = this.db
        .prepare(`SELECT c.id AS _rid, c.* FROM requirement_changes c JOIN requirements r ON r.num = c.requirement_num
          WHERE ${parts.join(' AND ')} ORDER BY c.id LIMIT ?`)
        .all(...params, limit) as Row[];
      return page(raw, (r) => {
        const c = this.requirementChangeFromRow(r);
        return {
          id: c.id,
          requirement: c.requirement,
          kind: c.kind,
          actor: c.actor,
          from_scope: c.from.scope,
          from_project: c.from.project,
          from_products: c.from.products.join(' | '),
          to_scope: c.to.scope,
          to_project: c.to.project,
          to_products: c.to.products.join(' | '),
          at: c.at,
        };
      });
    }

    if (dataset === 'groups') {
      // Groups are always complete (within the projects), like lanes, so filtered rows can be joined to them.
      const w = where('rowid', null, undefined, 'project_id');
      const raw = this.db.prepare(`SELECT rowid AS _rid, * FROM groups ${w.sql}`).all(...w.params) as Row[];
      return page(raw, (r) => ({
        id: local(r.id),
        project: r.project_id,
        name: r.name,
        ticket: r.ticket,
        ticket_url: r.ticket ? this.resolveTicketUrl(r.ticket as string) : null,
        links: r.links,
        last_published_by: r.agent,
        created_at: r.created_at,
        updated_at: r.updated_at,
        archived_at: r.archived_at,
      }));
    }

    if (dataset === 'lanes') {
      const w = where('l.rowid', 'l.id');
      const raw = this.db
        .prepare(
          `SELECT l.rowid AS _rid, l.*, g.name AS group_name,
             (SELECT t.display_ref FROM tickets t WHERE t.num = l.ticket_id) AS ticket_ref,
             (SELECT t.ref FROM tickets t WHERE t.num = l.ticket_id) AS ticket_canonical,
             (SELECT COUNT(*) FROM escalations e WHERE e.lane_id = l.id) AS escalations_total,
             (SELECT COUNT(*) FROM escalations e WHERE e.lane_id = l.id AND e.state = 'open') AS escalations_open
           FROM lanes l LEFT JOIN groups g ON g.id = l.group_id ${w.sql.replace('WHERE ', "WHERE instr(l.id, '/~') = 0 AND ")}`,
        )
        .all(...w.params) as Row[];
      return page(raw, (r) => ({
        id: local(r.id),
        project: r.project_id,
        name: r.name,
        group_id: local(r.group_id),
        group_name: r.group_name,
        status: r.status,
        // The ticket it holds now; a lane holding none (removed, or idle) shows none.
        ticket: r.ticket_ref ?? null,
        ticket_url: r.ticket_canonical ? this.resolveTicketUrl(r.ticket_canonical as string) : null,
        activity: r.activity,
        last_published_by: r.agent,
        created_at: r.created_at,
        updated_at: r.updated_at,
        status_since: r.status_since,
        blocked_seconds_total: Math.round(
          (Number(r.blocked_total_ms) +
            (r.blocked_since && !r.archived_at ? nowMs - Date.parse(r.blocked_since as string) : 0)) /
            1000,
        ),
        blocked_since: r.blocked_since,
        escalations_total: r.escalations_total,
        escalations_open: r.escalations_open,
        links: r.links,
        archived_at: r.archived_at,
        ticket_id: r.ticket_id,
      }));
    }

    if (dataset === 'events') {
      const w = where('id', 'lane_id', 'at');
      const raw = this.db.prepare(`SELECT id AS _rid, * FROM lane_events ${w.sql}`).all(...w.params) as Row[];
      return page(raw, (r) => ({
        id: r.id,
        project: projectOf(r.lane_id as string),
        lane_id: laneOut(r.lane_id),
        at: r.at,
        kind: r.kind,
        message: r.message,
        actor: r.actor,
        ticket_id: r.ticket_id,
      }));
    }

    if (dataset === 'tickets') {
      // Tickets are always complete (within the projects), like lanes, so filtered rows can be joined to them.
      const w = where('t.num', null, undefined, 't.project_id');
      const raw = this.db
        .prepare(
          `SELECT t.num AS _rid, t.*,
             (SELECT COUNT(*) FROM escalations e WHERE e.ticket_id = t.num) AS escalations_total,
             (SELECT COUNT(*) FROM escalations e WHERE e.ticket_id = t.num AND e.state = 'open') AS escalations_open
           FROM tickets t ${w.sql}`,
        )
        .all(...w.params) as Row[];
      return page(raw, (r) => {
        const t = this.ticketFromRow(r);
        return {
          id: t.id,
          project: t.project,
          ref: t.ref,
          display_ref: t.displayRef,
          code: t.code,
          ticket_url: t.url,
          group_id: local(t.group),
          lane_id: local(t.lane),
          state: t.state,
          park_reason: t.parkReason,
          waiting_on: t.waitingOn,
          status: t.status,
          blocked_seconds_total: Math.round((t.blockedTotalMs + (t.blockedSince ? nowMs - Date.parse(t.blockedSince) : 0)) / 1000),
          escalations_total: r.escalations_total,
          escalations_open: r.escalations_open,
          created_at: t.createdAt,
          updated_at: t.updatedAt,
          closed_at: t.closedAt,
        };
      });
    }

    if (dataset === 'messages') {
      const w = where('m.id', 'e.lane_id', 'm.created_at', "substr(e.lane_id, 1, instr(e.lane_id, '/') - 1)");
      const raw = this.db
        .prepare(
          `SELECT m.id AS _rid, m.*, e.lane_id, e.ref, e.letter_index, e.seq, e.code FROM messages m JOIN escalations e ON e.id = m.escalation_id ${w.sql}`,
        )
        .all(...w.params) as Row[];
      return page(raw, (r) => {
        const m = this.messageFromRow(r);
        return {
          id: m.id,
          escalation_id: r.escalation_id,
          escalation_ref: this.codeOf(r),
          project: projectOf(r.lane_id as string),
          lane_id: laneOut(r.lane_id),
          from: m.from,
          author: m.author,
          body: m.body,
          attachments: m.attachments.map((f) => `${f.name} (${f.type}, ${f.size} bytes)`).join(' | '),
          at: m.at,
        };
      });
    }

    if (dataset === 'epics') {
      // Epics are always complete (within the projects), like lanes, so filtered rows can be joined to them.
      const w = where('e.num', null, undefined, 'e.project_id');
      const raw = this.db
        .prepare(
          `SELECT e.num AS _rid, e.*,
             (SELECT COUNT(*) FROM escalations x WHERE x.epic_id = e.num) AS escalations_total,
             (SELECT COUNT(*) FROM escalations x WHERE x.epic_id = e.num AND x.state = 'open') AS escalations_open
           FROM epics e ${w.sql}`,
        )
        .all(...w.params) as Row[];
      return page(raw, (r) => {
        const e = this.epicFromRow(r);
        return {
          id: e.id,
          project: e.project,
          group_id: local(e.group),
          ref: e.ref,
          display_ref: e.displayRef,
          code: e.code,
          name: e.name,
          ticket_url: e.url,
          stand_in: e.standIn,
          state: e.state,
          status_line: e.statusLine,
          links: r.links,
          close_reason: e.closeReason,
          close_requested_by: e.closeRequestedBy,
          escalations_total: r.escalations_total,
          escalations_open: r.escalations_open,
          created_at: e.createdAt,
          updated_at: e.updatedAt,
          closed_at: e.closedAt,
        };
      });
    }

    if (dataset === 'epic_messages') {
      const w = where('m.id', null, 'm.created_at', 'e.project_id');
      const raw = this.db
        .prepare(`SELECT m.id AS _rid, m.*, e.project_id FROM epic_messages m JOIN epics e ON e.num = m.epic_id ${w.sql}`)
        .all(...w.params) as Row[];
      return page(raw, (r) => {
        const m = this.laneMessageFromRow(r, undefined, 'epic_message_id');
        return {
          id: m.id,
          project: r.project_id,
          epic_id: Number(r.epic_id),
          from: m.from,
          author: m.author,
          body: m.body,
          attachments: m.attachments.map((f) => `${f.name} (${f.type}, ${f.size} bytes)`).join(' | '),
          at: m.at,
        };
      });
    }

    if (dataset === 'lane_messages') {
      const w = where('id', 'lane_id', 'created_at');
      const raw = this.db.prepare(`SELECT id AS _rid, * FROM lane_messages ${w.sql}`).all(...w.params) as Row[];
      return page(raw, (r) => {
        const m = this.laneMessageFromRow(r);
        return {
          id: m.id,
          project: projectOf(r.lane_id as string),
          lane_id: local(r.lane_id),
          from: m.from,
          author: m.author,
          body: m.body,
          attachments: m.attachments.map((f) => `${f.name} (${f.type}, ${f.size} bytes)`).join(' | '),
          at: m.at,
        };
      });
    }

    if (dataset === 'positions') {
      // Filtered by when each position was taken; only the columns needed are read.
      const w = where('rowid', 'lane_id');
      const raw = this.db
        .prepare(`SELECT rowid AS _rid, id, ref, letter_index, seq, code, lane_id, question, positions FROM escalations ${w.sql}`)
        .all(...w.params) as Row[];
      return page(raw, (e) =>
        (JSON.parse(e.positions as string) as Position[])
          .filter((p) => (!filter.from || p.at >= filter.from) && (!filter.to || p.at < filter.to))
          .map((p) => ({
            escalation_id: e.id,
            escalation_ref: this.codeOf(e),
            project: projectOf(e.lane_id as string),
            lane_id: laneOut(e.lane_id),
            question: e.question,
            agent: p.agent,
            stance: p.stance,
            note: p.note,
            at: p.at,
          })),
      );
    }

    const w = where('e.rowid', 'e.lane_id', 'e.created_at');
    const raw = this.db
      .prepare(
        `SELECT e.rowid AS _rid, e.*, l.name AS lane_name, l.group_id AS group_id, g.name AS group_name
         FROM escalations e JOIN lanes l ON l.id = e.lane_id LEFT JOIN groups g ON g.id = l.group_id ${w.sql}`,
      )
      .all(...w.params) as Row[];

    return page(raw, (e) => {
      const positions = JSON.parse(e.positions as string) as Position[];
      const count = (stance: Stance) => positions.filter((p) => p.stance === stance).length;
      const closedAt = e.state === 'acknowledged' ? e.acknowledged_at : e.state === 'withdrawn' ? e.updated_at : null;
      return {
        id: e.id,
        ref: this.codeOf(e),
        project: projectOf(e.lane_id as string),
        lane_id: laneOut(e.lane_id),
        lane_name: Store.isEpicLane(e.lane_id as string) ? null : e.lane_name,
        group_id: local(e.group_id),
        group_name: e.group_name,
        ticket: e.ticket,
        ticket_url: e.ticket ? this.resolveTicketUrl(e.ticket as string) : null,
        question: e.question,
        context: e.context,
        recommendation: e.recommendation,
        recommended_option: e.recommended_option,
        cost: e.cost,
        alternatives: (JSON.parse(e.alternatives as string) as string[]).join(' | '),
        options: (JSON.parse(e.options as string) as string[]).join(' | '),
        accept_means: e.accept_means,
        reject_means: e.reject_means,
        allow_reject: Number(e.allow_reject ?? 1) === 1,
        // Names only: exports never carry the files.
        attachments: this.attachmentsOf(e.id as string)
          .map((f) => `${f.name} (${f.type}, ${f.size} bytes)`)
          .join(' | '),
        blocking: Number(e.blocking) === 1,
        state: e.state,
        created_by: e.created_by,
        created_at: e.created_at,
        decided_by: e.decided_by,
        decided_at: e.decided_at,
        decision: e.decision,
        decision_note: e.decision_note,
        followed_recommendation:
          e.decision && e.recommended_option ? e.decision === e.recommended_option : null,
        acknowledged_at: e.acknowledged_at,
        resolution: e.resolution,
        closed_at: closedAt,
        seconds_to_decision: seconds(e.created_at, e.decided_at),
        seconds_to_acknowledge: seconds(e.decided_at, e.acknowledged_at),
        seconds_open: seconds(e.created_at, e.decided_at ?? closedAt ?? new Date(nowMs).toISOString()),
        positions_agree: count('agree'),
        positions_disagree: count('disagree'),
        positions_neutral: count('neutral'),
        links: e.links,
        ticket_id: e.ticket_id,
        legacy_ref: e.legacy_ref,
        epic_id: e.epic_id,
      };
    });
  }

  private codeOf(r: Row) {
    if (r.code) return r.code as string;
    return r.letter_index == null ? String(r.ref) : `${letterOf(Number(r.letter_index))}${Number(r.seq)}`;
  }

  // ---- projects ----------------------------------------------------------------

  private projectKeys: Map<string, string> | null = null;

  private projectFromRow(r: Row): Project {
    return { id: r.id as string, key: r.key as string, name: r.name as string, createdAt: r.created_at as string };
  }

  listProjects(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY name').all() as Row[]).map((r) => this.projectFromRow(r));
  }

  getProject(id: string): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return r ? this.projectFromRow(r) : null;
  }

  /** By id or key, case-insensitively. */
  projectByKey(key: string): Project | null {
    const r = this.db
      .prepare('SELECT * FROM projects WHERE lower(key) = lower(?) OR lower(id) = lower(?) ORDER BY lower(id) = lower(?) DESC LIMIT 1')
      .get(key, key, key) as Row | undefined;
    return r ? this.projectFromRow(r) : null;
  }

  private projectKeyOf(id: string): string {
    if (!this.projectKeys) {
      this.projectKeys = new Map(
        (this.db.prepare('SELECT id, key FROM projects').all() as Row[]).map((r) => [r.id as string, r.key as string]),
      );
    }
    return this.projectKeys.get(id) ?? id;
  }

  /** Creates a project; its creator (if a person) becomes its admin. */
  createProject(input: { id: string; key: string; name: string }, creatorUserId: string | null): Project {
    const project = this.tx(() => {
      if (this.getProject(input.id)) throw new ConflictError(`Project "${input.id}" already exists`);
      // Ids and keys share one namespace, since either names a project.
      if (this.projectByKey(input.id)) throw new ConflictError(`"${input.id}" is already another project's key`);
      if (this.projectByKey(input.key)) throw new ConflictError(`Key "${input.key}" is already used by another project`);
      this.db
        .prepare('INSERT INTO projects (id, key, name, created_at) VALUES (?, ?, ?, ?)')
        .run(input.id, input.key.toUpperCase(), input.name, this.now().toISOString());
      if (creatorUserId) this.setMember(input.id, creatorUserId, 'admin');
      return this.getProject(input.id)!;
    });
    this.projectKeys = null;
    return project;
  }

  updateProject(id: string, patch: { name?: string; key?: string }): Project {
    const project = this.tx(() => {
      const current = this.getProject(id);
      if (!current) throw new NotFoundError(`Project "${id}" not found`);
      if (patch.key) {
        const other = this.projectByKey(patch.key);
        if (other && other.id !== id) throw new ConflictError(`Key "${patch.key}" is already used by another project`);
      }
      this.db
        .prepare('UPDATE projects SET name = ?, key = ? WHERE id = ?')
        .run(patch.name ?? current.name, (patch.key ?? current.key).toUpperCase(), id);
      return this.getProject(id)!;
    });
    this.projectKeys = null;
    return project;
  }

  /** The caller's memberships: project id -> role and notification choice. */
  membershipsOf(userId: string): Map<string, { role: ProjectRole; notify: boolean }> {
    const rows = this.db.prepare('SELECT project_id, role, notify FROM project_members WHERE user_id = ?').all(userId) as Row[];
    return new Map(rows.map((r) => [r.project_id as string, { role: r.role as ProjectRole, notify: Number(r.notify) === 1 }]));
  }

  projectMembers(project: string): { userId: string; role: ProjectRole; notify: boolean }[] {
    return (
      this.db.prepare('SELECT user_id, role, notify FROM project_members WHERE project_id = ?').all(project) as Row[]
    ).map((r) => ({ userId: r.user_id as string, role: r.role as ProjectRole, notify: Number(r.notify) === 1 }));
  }

  /** Adds a member or changes their role (keeping their notification choice). */
  setMember(project: string, userId: string, role: ProjectRole) {
    if (!this.getProject(project)) throw new NotFoundError(`Project "${project}" not found`);
    this.db
      .prepare(
        `INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)
         ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role`,
      )
      .run(project, userId, role);
  }

  removeMember(project: string, userId: string) {
    this.db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(project, userId);
  }

  /** Removes someone from every project (their account was removed). */
  removeUserEverywhere(userId: string) {
    this.db.prepare('DELETE FROM project_members WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM project_notify WHERE user_id = ?').run(userId);
  }

  /**
   * Turns push for one project on or off for a person. For someone who sees it without
   * being a member (an instance admin), the choice is kept apart, granting nothing.
   */
  setNotify(project: string, userId: string, notify: boolean) {
    if (!this.getProject(project)) throw new NotFoundError(`Project "${project}" not found`);
    const member = this.db
      .prepare('UPDATE project_members SET notify = ? WHERE project_id = ? AND user_id = ?')
      .run(notify ? 1 : 0, project, userId);
    if (Number(member.changes) > 0) return;
    this.db
      .prepare(
        `INSERT INTO project_notify (project_id, user_id, notify) VALUES (?, ?, ?)
         ON CONFLICT(project_id, user_id) DO UPDATE SET notify = excluded.notify`,
      )
      .run(project, userId, notify ? 1 : 0);
  }

  /** A non-member's push choice for a project, if they made one. */
  notifyChoice(project: string, userId: string): boolean | undefined {
    const r = this.db.prepare('SELECT notify FROM project_notify WHERE project_id = ? AND user_id = ?').get(project, userId) as
      | Row
      | undefined;
    return r ? Number(r.notify) === 1 : undefined;
  }

  /**
   * Once, when projects arrive: everyone who had access before becomes a member of the
   * first project (admins as admin), so nobody loses sight of existing data.
   */
  seedDefaultMembers(users: { id: string; admin: boolean }[]) {
    const done = this.db.prepare("SELECT 1 FROM meta WHERE key = 'members_seeded'").get();
    if (done) return;
    this.tx(() => {
      for (const u of users) {
        this.db
          .prepare('INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)')
          .run(DEFAULT_PROJECT, u.id, u.admin ? 'admin' : 'member');
      }
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('members_seeded', '1')").run();
    });
  }

  // ---- requirements ----------------------------------------------------------

  private requirementFromRow(r: Row): Requirement {
    const source = r.source_escalation_id ? this.getEscalation(r.source_escalation_id as string) : null;
    return {
      id: `R${Number(r.num)}`,
      project: (r.project_id as string | null) ?? null,
      group: (r.group_id as string | null) ?? null,
      scope: r.scope as RequirementScope,
      products: this.requirementProducts(Number(r.num)),
      needsRegrouping: !!r.needs_regrouping,
      requirement: r.requirement as string,
      justification: r.justification as string,
      tags: JSON.parse(r.tags as string) as string[],
      status: r.status as RequirementStatus,
      supersededBy: r.superseded_by == null ? null : `R${Number(r.superseded_by)}`,
      rejectionReason: (r.rejection_reason as string | null) ?? null,
      decidedBy: r.decided_by as string,
      // Within a project its code is enough; an all-projects requirement names the project too.
      sourceEscalation: source ? (r.project_id ? source.ref : `${source.projectKey}-${source.ref}`) : null,
      recordedBy: r.recorded_by as string,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  }

  private requirementProducts(num: number): string[] {
    return (
      this.db.prepare('SELECT product_id FROM requirement_products WHERE requirement_num = ? ORDER BY product_id').all(num) as Row[]
    ).map((r) => r.product_id as string);
  }

  /** "R14", "r14" or "14". */
  private requirementNum(id: string): number | null {
    const m = /^R?(\d{1,15})$/i.exec(id.trim());
    return m ? Number(m[1]) : null;
  }

  getRequirement(id: string): Requirement | null {
    const num = this.requirementNum(id);
    if (num === null) return null;
    const r = this.db.prepare('SELECT * FROM requirements WHERE num = ?').get(num) as Row | undefined;
    return r ? this.requirementFromRow(r) : null;
  }

  private requireRequirement(id: string): Requirement {
    const req = this.getRequirement(id);
    if (!req) throw new NotFoundError(`Requirement "${id}" not found`);
    return req;
  }

  /**
   * Free text as a ranked full-text match: any word, in any form (stemmed index) or as a
   * prefix (plain index). Returns null when the text has no searchable words. Words are
   * quoted, so FTS syntax in the text is inert.
   */
  private ftsMatch(text: string): { cte: string; params: string[] } | null {
    const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 30);
    if (!words.length) return null;
    return {
      cte: `WITH hits(num, score) AS (
          SELECT rowid, bm25(requirements_fts) FROM requirements_fts WHERE requirements_fts MATCH ?
          UNION ALL
          SELECT rowid, bm25(requirements_fts_plain) FROM requirements_fts_plain WHERE requirements_fts_plain MATCH ?
        ), best AS (SELECT num, MIN(score) AS score FROM hits GROUP BY num)`,
      params: [words.map((w) => `"${w}"`).join(' OR '), words.map((w) => `"${w}"*`).join(' OR ')],
    };
  }

  /**
   * Search: `query` is free text (ranked full-text match); `tags` must all be
   * present; `group` limits to that group plus product-wide ones (unless
   * `includeProductWide` is false). In force (pending or active) unless `statuses` says otherwise.
   */
  findRequirements(filter: {
    query?: string;
    tags?: string[];
    group?: string;
    includeProductWide?: boolean;
    /** Projects to search; requirements for all projects always match. Undefined = every project. */
    projects?: string[];
    statuses?: RequirementStatus[];
    /**
     * Any of: requirements scoped to one of these products (of `project`), project-wide ones, global
     * ones. Undefined = every scope.
     */
    scope?: { project?: string; products?: string[]; projectWide?: boolean; global?: boolean };
    /** Only those waiting for a person to choose their scope (true), or only those that aren't (false). */
    needsRegrouping?: boolean;
    limit?: number;
  } = {}): Requirement[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.projects) {
      where.push(
        filter.projects.length
          ? `(r.project_id IS NULL OR r.project_id IN (${filter.projects.map(() => '?').join(',')}))`
          : 'r.project_id IS NULL',
      );
      params.push(...filter.projects);
    }
    const statuses = filter.statuses ?? IN_FORCE;
    where.push(`r.status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
    if (filter.group !== undefined) {
      where.push(filter.includeProductWide === false ? 'r.group_id = ?' : '(r.group_id = ? OR r.group_id IS NULL)');
      params.push(filter.group);
    }
    for (const tag of filter.tags ?? []) {
      where.push('EXISTS (SELECT 1 FROM json_each(r.tags) WHERE value = ?)');
      params.push(tag.toLowerCase());
    }
    if (filter.scope) {
      const any: string[] = [];
      const { project, products, projectWide, global } = filter.scope;
      if (products?.length) {
        if (!project) throw new ValidationError('Say which project the products are in');
        any.push(
          `EXISTS (SELECT 1 FROM requirement_products rp WHERE rp.requirement_num = r.num AND rp.project_id = ? AND rp.product_id IN (${products.map(() => '?').join(',')}))`,
        );
        params.push(project, ...products);
      }
      if (projectWide) {
        any.push(project ? "(r.scope = 'project' AND r.project_id = ?)" : "r.scope = 'project'");
        if (project) params.push(project);
      }
      if (global) any.push("r.scope = 'global'");
      where.push(any.length ? `(${any.join(' OR ')})` : '0');
    }
    if (filter.needsRegrouping !== undefined) where.push(filter.needsRegrouping ? 'r.needs_regrouping = 1' : 'r.needs_regrouping = 0');
    // An id ("R14") finds that requirement, whatever its status, except a rejected one unless asked for.
    if (filter.query && this.requirementNum(filter.query) !== null && /^r/i.test(filter.query.trim())) {
      const one = this.getRequirement(filter.query);
      return one &&
        (one.status !== 'rejected' || statuses.includes('rejected')) &&
        (!filter.projects || one.project === null || filter.projects.includes(one.project))
        ? this.withPendingChanges([one], filter.projects)
        : [];
    }
    const limit = filter.limit ?? 50;
    const match = filter.query?.trim() ? this.ftsMatch(filter.query) : undefined;
    // Text with nothing searchable in it ("?") matches nothing rather than everything.
    if (match === null) return [];
    const rows = match
      ? (this.db
          .prepare(
            `${match.cte} SELECT r.* FROM best JOIN requirements r ON r.num = best.num
             WHERE ${where.join(' AND ')} ORDER BY best.score, r.num DESC LIMIT ?`,
          )
          .all(...match.params, ...params, limit) as Row[])
      : (this.db
          .prepare(`SELECT r.* FROM requirements r WHERE ${where.join(' AND ')} ORDER BY r.num DESC LIMIT ?`)
          .all(...params, limit) as Row[]);
    return this.withPendingChanges(
      rows.map((r) => this.requirementFromRow(r)),
      filter.projects,
    );
  }

  /**
   * A change waiting for approval comes with what it changes, whichever of the two was found:
   * the requirement in force, then its pending replacement, so an agent reading either knows
   * the decision may be about to change. Pairs are added whatever the other filters say, so
   * a result can run past `limit` by the partners it brings. Changes never chain (see
   * supersedeRequirement), so one step each way finds the whole pair.
   */
  private withPendingChanges(found: Requirement[], projects?: string[]): Requirement[] {
    const visible = (r: Requirement) => !projects || r.project === null || projects.includes(r.project);
    const out: Requirement[] = [];
    const ids = new Set<string>();
    const add = (r: Requirement) => {
      if (!ids.has(r.id)) (ids.add(r.id), out.push(r));
    };
    for (const req of found) {
      if (req.status === 'pending') {
        for (const num of this.replacedBy(this.requirementNum(req.id)!)) {
          const old = this.requireRequirement(String(num));
          if (visible(old)) add(old);
        }
      }
      add(req);
      if (inForce(req) && req.supersededBy) {
        const next = this.getRequirement(req.supersededBy);
        if (next && next.status === 'pending' && visible(next)) add(next);
      }
    }
    return out;
  }

  /** SQL limiting requirements (as `r`) to these projects plus the all-projects ones; every project when omitted. */
  private inRequirementScope(projects?: string[]): { sql: string; params: string[] } {
    if (!projects) return { sql: '', params: [] };
    return projects.length
      ? { sql: ` AND (r.project_id IS NULL OR r.project_id IN (${projects.map(() => '?').join(',')}))`, params: projects }
      : { sql: ' AND r.project_id IS NULL', params: [] };
  }

  /** Tags in use on requirements in force (of these projects plus all-project ones), most used first. */
  requirementTags(group?: string, projects?: string[]): { tag: string; count: number }[] {
    const p = this.inRequirementScope(projects);
    const rows = this.db
      .prepare(
        `SELECT j.value AS tag, COUNT(*) AS n FROM requirements r, json_each(r.tags) j
         WHERE r.status IN ('pending', 'active') ${group !== undefined ? 'AND (r.group_id = ? OR r.group_id IS NULL)' : ''}${p.sql}
         GROUP BY j.value ORDER BY n DESC, j.value`,
      )
      .all(...(group !== undefined ? [group] : []), ...p.params) as Row[];
    return rows.map((r) => ({ tag: r.tag as string, count: Number(r.n) }));
  }

  /** Lowercases, de-duplicates and checks tags; throws on overbroad ones. */
  private cleanTags(tags: string[]): string[] {
    const clean = [...new Set(tags.map((t) => t.trim().toLowerCase()))];
    const broad = clean.filter((t) => this.broadTags.has(t));
    if (broad.length) {
      throw new ValidationError(
        `Tag${broad.length > 1 ? 's' : ''} ${broad.map((t) => `"${t}"`).join(', ')} too broad to help anyone find this. ` +
          'Name the capability instead, e.g. "payout-retries" or "sso-login".',
      );
    }
    return clean;
  }

  /**
   * Must run inside a transaction. Works out who decided, from the escalation or the given
   * name. An agent can only cite an escalation it raised itself, or one from a lane in the
   * requirement's own group, so an unrelated answer can't be passed off as the source.
   */
  private decisionSource(
    input: RequirementInput,
    actor: string,
    actorIsHuman: boolean,
    actorOwner: string | null,
  ): { decidedBy: string; escalationId: string | null } {
    if (input.sourceEscalation) {
      const esc = this.requireEscalation(input.sourceEscalation);
      // Decided in LaneSignal: the escalation names its decider. Otherwise (the owner answered in the
      // agent's session and the alert was dismissed) it stays linked, and decided_by says who decided.
      const decidedHere = !!esc.decidedBy && (esc.state === 'decided' || esc.state === 'acknowledged');
      if (decidedHere && input.decidedBy) {
        throw new ValidationError('Give either source_escalation or decided_by, not both: the escalation names its decider.');
      }
      if (!decidedHere && !input.decidedBy?.trim()) {
        throw new ConflictError(
          `Escalation ${esc.ref} hasn't been decided in LaneSignal; say who decided with decided_by (the escalation stays linked)`,
        );
      }
      const laneGroup = (this.db.prepare('SELECT group_id FROM lanes WHERE id = ?').get(esc.laneId) as Row | undefined)?.group_id;
      // Raised by this agent: the same key identity as for dismissing (or the name, for old rows).
      const raiser = this.escalationOwner(esc.id);
      const mine = raiser && actorOwner ? raiser === actorOwner : esc.createdBy === actor;
      const related = mine || (input.group != null && laneGroup === input.group);
      if (!actorIsHuman && !related) {
        throw new ConflictError(
          `Escalation ${esc.ref} was raised by ${esc.createdBy} in another ${laneGroup ? `group (${laneGroup})` : 'context'}; ` +
            'cite an escalation you raised or one from this group, or name who decided with decided_by.',
        );
      }
      return { decidedBy: decidedHere ? esc.decidedBy! : input.decidedBy!.trim(), escalationId: esc.id };
    }
    const decidedBy = input.decidedBy?.trim();
    if (!decidedBy) {
      throw new ValidationError(
        'Say whose decision this is: source_escalation (an answered escalation, e.g. "A12") or decided_by (the person, e.g. "Sam").',
      );
    }
    return { decidedBy, escalationId: null };
  }

  private similarTo(req: Requirement): Requirement[] {
    const match = this.ftsMatch(req.requirement);
    if (!match) return [];
    const rows = this.db
      .prepare(
        `${match.cte} SELECT r.* FROM best JOIN requirements r ON r.num = best.num
         WHERE r.status IN ('pending', 'active') AND r.num <> ? AND (r.group_id IS ? OR r.group_id IS NULL OR ? IS NULL)
           AND (r.project_id IS ? OR r.project_id IS NULL OR ? IS NULL)
         ORDER BY best.score LIMIT 3`,
      )
      .all(...match.params, this.requirementNum(req.id)!, req.group, req.group, req.project, req.project) as Row[];
    return rows.map((r) => this.requirementFromRow(r));
  }

  /** Counted over what the requirement's project sees: its own requirements and the all-projects ones. */
  private tagWarnings(tags: string[], project: string | null): string[] {
    const projects = project ? [project] : [];
    const p = this.inRequirementScope(projects);
    const total = Number(
      (this.db.prepare(`SELECT COUNT(*) AS n FROM requirements r WHERE r.status IN ('pending', 'active')${p.sql}`).get(...p.params) as Row).n,
    );
    const counts = new Map(this.requirementTags(undefined, projects).map((t) => [t.tag, t.count]));
    // "payout-retry" next to an existing "payout-retries" splits searches in two.
    const forms = (t: string) =>
      new Set([t + 's', t + 'es', t.replace(/y$/, 'ies'), t.replace(/ies$/, 'y'), t.replace(/es$/, ''), t.replace(/s$/, '')]);
    const near = tags.flatMap((t) => {
      // Short words ("bu"/"bus", "new"/"news") differ by more than a plural.
      const other = [...counts.keys()].find((c) => c !== t && !tags.includes(c) && Math.min(c.length, t.length) >= 5 && forms(t).has(c));
      return other ? [`Tag "${t}" is close to the existing tag "${other}"; use that one if it means the same.`] : [];
    });
    if (total < 10) return near;
    return [
      ...near,
      ...tags
        .filter((t) => (counts.get(t) ?? 0) / total > 0.4)
        .map((t) => `Tag "${t}" is on ${counts.get(t)} of ${total} active requirements; a narrower tag would find this faster.`),
    ];
  }

  /**
   * Checks a scope and its products. `byPerson`: a signed-in person, whom locks don't stop. Must
   * run inside a transaction when its result is written.
   */
  private checkScope(
    target: { scope: RequirementScope; project: string | null; products?: string[] },
    byPerson: boolean,
  ): { scope: RequirementScope; project: string | null; products: string[] } {
    const products = [...new Set((target.products ?? []).map((p) => p.trim().toLowerCase()))];
    if (target.scope === 'global') {
      if (target.project !== null) throw new ValidationError('A global requirement applies to every project, not to one');
      if (products.length) throw new ValidationError('A global requirement names no products');
      return { scope: 'global', project: null, products: [] };
    }
    if (target.project === null) throw new ValidationError(`Say which project a ${target.scope === 'project' ? 'project-wide' : 'product'} requirement is in`);
    if (target.scope === 'project') {
      if (products.length) throw new ValidationError('A project-wide requirement names no products; scope it to products instead');
      return { scope: 'project', project: target.project, products: [] };
    }
    if (!products.length) throw new ValidationError('Name at least one product (or scope the requirement project-wide or global)');
    const known = this.listProducts([target.project]);
    for (const id of products) {
      const product = known.find((p) => p.id === id);
      if (!product) {
        const names = known.map((p) => p.id);
        throw new NotFoundError(
          `Product "${id}" not found in ${target.project}` +
            (names.length ? ` (products: ${names.join(', ')})` : ' (it has no products yet; a person adds them on the Requirements page)'),
        );
      }
      if (!byPerson && product.locked) {
        throw new ForbiddenError(`Product "${id}" is locked: only a signed-in person changes its requirements`);
      }
    }
    return { scope: 'products', project: target.project, products: products.sort() };
  }

  /** Must run inside a transaction. */
  private setRequirementProducts(num: number, project: string | null, products: string[]) {
    this.db.prepare('DELETE FROM requirement_products WHERE requirement_num = ?').run(num);
    for (const id of products) {
      this.db.prepare('INSERT INTO requirement_products (requirement_num, project_id, product_id) VALUES (?, ?, ?)').run(num, project, id);
    }
  }

  /** Throws unless agents may change this requirement: none of its products is locked. */
  private checkUnlocked(req: Requirement) {
    if (req.scope !== 'products' || !req.project) return;
    const locked = this.listProducts([req.project]).filter((p) => p.locked && req.products.includes(p.id));
    if (locked.length) {
      throw new ForbiddenError(
        `${req.id} is in locked product${locked.length > 1 ? 's' : ''} ${locked.map((p) => `"${p.id}"`).join(', ')}: only a signed-in person changes it`,
      );
    }
  }

  /** Must run inside a transaction. */
  private insertRequirement(
    input: RequirementInput,
    actor: string,
    actorIsHuman: boolean,
    at: string,
    actorOwner: string | null,
    approved: boolean,
  ): number {
    if (input.group && !this.getGroup(input.group)) throw new NotFoundError(`Group "${localId(input.group)}" not found`);
    if (input.group && input.project !== projectOf(input.group)) {
      throw new ValidationError('A requirement for a group applies to that group\'s project, not to all projects');
    }
    if (input.project && !this.getProject(input.project)) throw new NotFoundError(`Project "${input.project}" not found`);
    const tags = this.cleanTags(input.tags);
    // Without a scope (as before products), it's global or project-wide by its project, and a person regroups it.
    const regroup = input.scope === undefined;
    const scope = this.checkScope(
      { scope: input.scope ?? (input.project ? 'project' : 'global'), project: input.project ?? null, products: input.products },
      approved,
    );
    const { decidedBy, escalationId } = this.decisionSource(input, actor, actorIsHuman, actorOwner);
    const res = this.db
      .prepare(
        `INSERT INTO requirements (project_id, group_id, scope, needs_regrouping, requirement, justification, tags, status, decided_by,
           source_escalation_id, recorded_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.project ?? null,
        input.group ?? null,
        scope.scope,
        regroup ? 1 : 0,
        input.requirement.trim(),
        input.justification.trim(),
        JSON.stringify(tags),
        // A person recording it is the approval; an agent's record waits for one.
        approved ? 'active' : 'pending',
        decidedBy,
        escalationId,
        actor,
        at,
        at,
      );
    const num = Number(res.lastInsertRowid);
    this.setRequirementProducts(num, scope.project, scope.products);
    return num;
  }

  /**
   * Records an owner decision: active when `approved` (a person recorded it), otherwise pending.
   * Returns it with similar requirements in force, so duplicates get noticed.
   */
  recordRequirement(
    input: RequirementInput,
    actor: string,
    actorIsHuman = false,
    actorOwner: string | null = null,
    approved = actorIsHuman,
  ): RecordResult {
    // A retry (the same requirement from the same escalation) returns the first instead of a copy.
    // A second decision from the same answer is stored; `similar` shows the first.
    if (input.sourceEscalation) {
      const norm = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase();
      const same = (
        this.db
          .prepare("SELECT num, requirement FROM requirements WHERE source_escalation_id = ? AND status IN ('pending', 'active') AND project_id IS ?")
          .all(input.sourceEscalation, input.project ?? null) as Row[]
      ).find((row) => norm(row.requirement as string) === norm(input.requirement));
      if (same) return { requirement: this.requireRequirement(String(same.num)), similar: [], warnings: [], duplicate: true };
    }
    const requirement = this.tx(() => {
      const num = this.insertRequirement(input, actor, actorIsHuman, this.now().toISOString(), actorOwner, approved);
      return this.requireRequirement(String(num));
    });
    this.emit({ type: 'requirement', requirement });
    return { requirement, similar: this.similarTo(requirement), warnings: this.tagWarnings(requirement.tags, requirement.project) };
  }

  /**
   * Replaces a requirement in force with a new one (the owner changed direction).
   * The old one stays, marked superseded, so the history of why is kept. Group
   * defaults to the old one's. A pending replacement (an agent's) only names itself
   * in the old one's `supersededBy`: the old one stays in force until a person
   * approves the replacement, and comes clear again if they reject it. Superseding a
   * pending replacement swaps it for the new one: it's superseded at once, and what it
   * was to replace waits on the new one instead, so changes never chain.
   */
  supersedeRequirement(
    id: string,
    input: RequirementInput,
    actor: string,
    actorIsHuman = false,
    actorOwner: string | null = null,
    approved = actorIsHuman,
  ): RecordResult {
    const { requirement, old, earlier } = this.tx(() => {
      const current = this.requireRequirement(id);
      if (!inForce(current)) throw new ConflictError(`${current.id} is ${current.status}; only pending or active requirements can be superseded`);
      if (current.supersededBy) {
        throw new ConflictError(
          `${current.id} already has a replacement waiting for approval (${current.supersededBy}); supersede that one to change the proposal`,
        );
      }
      // A locked product's requirements change only by a person's hand.
      if (!approved) this.checkUnlocked(current);
      const at = this.now().toISOString();
      const project = input.project === undefined ? current.project : input.project;
      // No scope given and the same project: the old one's scope (still to regroup, if it was).
      const inherit = input.scope === undefined && project === current.project;
      const num = this.insertRequirement(
        {
          ...input,
          group: input.group === undefined ? current.group : input.group,
          project,
          ...(inherit && !current.needsRegrouping ? { scope: current.scope, products: current.products } : {}),
        },
        actor,
        actorIsHuman,
        at,
        actorOwner,
        approved,
      );
      // What `current` was to replace, if it's a pending replacement itself.
      const earlier = this.replacedBy(this.requirementNum(current.id)!);
      this.db
        .prepare('UPDATE requirements SET status = ?, superseded_by = ?, updated_at = ? WHERE num = ?')
        .run(approved || earlier.length ? 'superseded' : current.status, num, at, this.requirementNum(current.id)!);
      for (const e of earlier) {
        // Approved: the whole line is replaced. Pending: it waits on the new change instead.
        if (approved) this.db.prepare("UPDATE requirements SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE num = ?").run(num, at, e);
        else this.db.prepare('UPDATE requirements SET superseded_by = ?, updated_at = ? WHERE num = ?').run(num, at, e);
      }
      return {
        requirement: this.requireRequirement(String(num)),
        old: this.requireRequirement(current.id),
        earlier: earlier.map((e) => this.requireRequirement(String(e))),
      };
    });
    for (const e of earlier) this.emit({ type: 'requirement', requirement: e });
    this.emit({ type: 'requirement', requirement: old });
    this.emit({ type: 'requirement', requirement });
    return { requirement, similar: this.similarTo(requirement).filter((r) => r.id !== old.id), warnings: this.tagWarnings(requirement.tags, requirement.project) };
  }

  /** Corrections that keep the meaning (wording, tags). Changing the decision is a supersede. */
  editRequirement(id: string, patch: { requirement?: string; justification?: string; tags?: string[] }): Requirement {
    const requirement = this.tx(() => {
      const current = this.requireRequirement(id);
      if (!inForce(current)) throw new ConflictError(`${current.id} is ${current.status}; only pending or active requirements can be edited`);
      const tags = patch.tags ? this.cleanTags(patch.tags) : current.tags;
      this.db
        .prepare('UPDATE requirements SET requirement = ?, justification = ?, tags = ?, updated_at = ? WHERE num = ?')
        .run(
          patch.requirement?.trim() ?? current.requirement,
          patch.justification?.trim() ?? current.justification,
          JSON.stringify(tags),
          this.now().toISOString(),
          this.requirementNum(current.id)!,
        );
      return this.requireRequirement(current.id);
    });
    this.emit({ type: 'requirement', requirement });
    return requirement;
  }

  /** Requirements still in force that name this one as their replacement waiting for approval. */
  private replacedBy(num: number): number[] {
    return (
      this.db.prepare("SELECT num FROM requirements WHERE superseded_by = ? AND status IN ('pending', 'active')").all(num) as Row[]
    ).map((r) => Number(r.num));
  }

  /**
   * A person confirms an agent's record of their decision: pending becomes active. If it
   * replaces another requirement, that one is superseded now.
   */
  approveRequirement(id: string, rescope?: { target: ScopeTarget; actor: string }): Requirement {
    const { requirement, replaced } = this.tx(() => {
      const current = this.requireRequirement(id);
      if (current.status !== 'pending') throw new ConflictError(`${current.id} is ${current.status}; only pending requirements can be approved`);
      // Approving with a different scope chosen: both in one step.
      if (rescope) this.applyScope(current, rescope.target, rescope.actor);
      const at = this.now().toISOString();
      const num = this.requirementNum(current.id)!;
      this.db.prepare("UPDATE requirements SET status = 'active', updated_at = ? WHERE num = ?").run(at, num);
      const replaced = this.replacedBy(num);
      for (const old of replaced) {
        this.db.prepare("UPDATE requirements SET status = 'superseded', updated_at = ? WHERE num = ?").run(at, old);
      }
      return { requirement: this.requireRequirement(current.id), replaced: replaced.map((n) => this.requireRequirement(String(n))) };
    });
    for (const old of replaced) this.emit({ type: 'requirement', requirement: old });
    this.emit({ type: 'requirement', requirement });
    return requirement;
  }

  /**
   * Undoes a retire or a rejection (e.g. a mis-tap). A retired requirement is active (approved)
   * again; a rejected one goes back to waiting for approval, its reason cleared, and is again the
   * pending replacement of what it was to replace (409 if that has changed since).
   */
  restoreRequirement(id: string): Requirement {
    const { requirement, relinked } = this.tx(() => {
      const current = this.requireRequirement(id);
      if (current.status !== 'retired' && current.status !== 'rejected') {
        throw new ConflictError(`${current.id} is ${current.status}; only retired or rejected requirements can be restored`);
      }
      const num = this.requirementNum(current.id)!;
      const at = this.now().toISOString();
      const replacing =
        current.status === 'rejected'
          ? (JSON.parse(((this.db.prepare('SELECT rejected_replacing FROM requirements WHERE num = ?').get(num) as Row).rejected_replacing as string | null) ?? '[]') as number[])
          : [];
      for (const old of replacing) {
        const req = this.requireRequirement(String(old));
        // Still waiting on it (in force), or a proposal it was swapped in for (superseded): link it again.
        if ((!inForce(req) && req.status !== 'superseded') || req.supersededBy) {
          throw new ConflictError(
            `${current.id} was to replace ${req.id}, which has ${req.supersededBy ? `another replacement (${req.supersededBy})` : `become ${req.status}`} since; record the change again instead`,
          );
        }
        this.db.prepare('UPDATE requirements SET superseded_by = ?, updated_at = ? WHERE num = ?').run(num, at, old);
      }
      // Its own replacement (only on records withdrawn before that was refused) counts while it's a
      // lone pending change; anything else means the line moved on, and it isn't brought back beside it.
      const next = current.supersededBy ? this.getRequirement(current.supersededBy) : null;
      if (next && (next.status !== 'pending' || next.supersededBy)) {
        throw new ConflictError(`${current.id} was replaced by ${next.id} since; it can't be restored beside it`);
      }
      this.db
        .prepare(
          'UPDATE requirements SET status = ?, superseded_by = ?, rejection_reason = NULL, rejected_replacing = NULL, updated_at = ? WHERE num = ?',
        )
        .run(
          current.status === 'rejected' ? 'pending' : 'active',
          next ? this.requirementNum(next.id)! : null,
          at,
          num,
        );
      return { requirement: this.requireRequirement(current.id), relinked: replacing.map((n) => this.requireRequirement(String(n))) };
    });
    for (const old of relinked) this.emit({ type: 'requirement', requirement: old });
    this.emit({ type: 'requirement', requirement });
    return requirement;
  }

  /**
   * Takes a requirement out of force: retired (an active one no longer applies, nothing replaces
   * it) or rejected (a pending record a person turned down, with their reason). A requirement it
   * was to replace no longer has a replacement waiting. Nothing points at a rejected one any more
   * (not even a proposal it was swapped in for); it remembers what did, so a restore links them again.
   */
  private withdrawRequirement(current: Requirement, status: 'retired' | 'rejected', reason: string | null): Requirement {
    // A change to it is waiting: that's decided first, so a withdrawn requirement never names a replacement.
    if (current.supersededBy) {
      throw new ConflictError(`${current.id} has a replacement waiting for approval (${current.supersededBy}); approve or reject that first`);
    }
    const { requirement, kept } = this.tx(() => {
      const at = this.now().toISOString();
      const num = this.requirementNum(current.id)!;
      const kept = this.replacedBy(num);
      const pointing =
        status === 'rejected'
          ? (this.db.prepare('SELECT num, status FROM requirements WHERE superseded_by = ?').all(num) as Row[])
          : kept.map((n) => ({ num: n, status: 'active' }));
      for (const old of pointing) this.db.prepare('UPDATE requirements SET superseded_by = NULL, updated_at = ? WHERE num = ?').run(at, Number(old.num));
      // Restore links back only what it can: requirements in force, and proposals it was swapped in for.
      const relink = pointing.filter((r) => ['pending', 'active', 'superseded'].includes(r.status as string)).map((r) => Number(r.num));
      this.db
        .prepare('UPDATE requirements SET status = ?, rejection_reason = ?, rejected_replacing = ?, updated_at = ? WHERE num = ?')
        .run(status, reason, status === 'rejected' && relink.length ? JSON.stringify(relink) : null, at, num);
      return { requirement: this.requireRequirement(current.id), kept: pointing.map((r) => this.requireRequirement(String(r.num))) };
    });
    for (const old of kept) this.emit({ type: 'requirement', requirement: old });
    this.emit({ type: 'requirement', requirement });
    return requirement;
  }

  /** Withdraws an active requirement with no replacement: the decision no longer applies. A pending one is rejected instead. */
  retireRequirement(id: string): Requirement {
    const current = this.requireRequirement(id);
    if (current.status === 'pending') throw new ConflictError(`${current.id} is pending; reject it with a reason instead of retiring it`);
    if (current.status !== 'active') throw new ConflictError(`${current.id} is already ${current.status}`);
    return this.withdrawRequirement(current, 'retired', null);
  }

  /** A person turns down a pending record, saying why. Agents no longer see it. */
  rejectRequirement(id: string, reason: string): Requirement {
    const current = this.requireRequirement(id);
    if (current.status !== 'pending') throw new ConflictError(`${current.id} is ${current.status}; only pending requirements can be rejected`);
    if (!reason.trim()) throw new ValidationError('Say why the requirement is rejected');
    return this.withdrawRequirement(current, 'rejected', reason.trim());
  }

  /**
   * Must run inside a transaction. A person sets a requirement's scope: it keeps its id and status,
   * the change is logged, and it no longer needs regrouping. Moving it to another project (or to
   * global) drops its group, which belonged to the old project.
   */
  private applyScope(current: Requirement, target: ScopeTarget, actor: string) {
    if (!inForce(current)) throw new ConflictError(`${current.id} is ${current.status}; only pending or active requirements can be rescoped`);
    const next = this.checkScope(target, true);
    if (next.project !== null) {
      if (!this.getProject(next.project)) throw new NotFoundError(`Project "${next.project}" not found`);
      const row = this.db.prepare('SELECT source_escalation_id FROM requirements WHERE num = ?').get(this.requirementNum(current.id)!) as Row;
      const source = row.source_escalation_id ? this.getEscalation(row.source_escalation_id as string) : null;
      if (source && source.project !== next.project) {
        throw new ValidationError(`${current.id} cites ${source.projectKey}-${source.ref}, from another project; it can only move to that project or to global`);
      }
    }
    const num = this.requirementNum(current.id)!;
    const same =
      next.scope === current.scope && next.project === current.project && next.products.join(',') === current.products.join(',');
    // Saving the scope it already has changes nothing, unless it confirms one still to regroup.
    if (same && !current.needsRegrouping) return;
    const at = this.now().toISOString();
    const group = next.project === current.project ? current.group : null;
    this.db
      .prepare('UPDATE requirements SET project_id = ?, group_id = ?, scope = ?, needs_regrouping = 0, updated_at = ? WHERE num = ?')
      .run(next.project, group, next.scope, at, num);
    this.setRequirementProducts(num, next.project, next.products);
    this.db
      .prepare('INSERT INTO requirement_changes (requirement_num, kind, actor, from_value, to_value, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        num,
        'scope',
        actor,
        JSON.stringify({ scope: current.scope, project: current.project, products: current.products }),
        JSON.stringify(next),
        at,
      );
  }

  /** A person changes where a requirement applies (no re-approval: the same decision, scoped differently). */
  setRequirementScope(id: string, target: ScopeTarget, actor: string): Requirement {
    const requirement = this.tx(() => {
      const current = this.requireRequirement(id);
      this.applyScope(current, target, actor);
      return this.requireRequirement(current.id);
    });
    this.emit({ type: 'requirement', requirement });
    return requirement;
  }

  /** Scope changes on a requirement, oldest first. */
  requirementChanges(id: string): RequirementChange[] {
    const req = this.requireRequirement(id);
    const rows = this.db
      .prepare('SELECT * FROM requirement_changes WHERE requirement_num = ? ORDER BY id')
      .all(this.requirementNum(req.id)!) as Row[];
    return rows.map((r) => this.requirementChangeFromRow(r));
  }

  private requirementChangeFromRow(r: Row): RequirementChange {
    return {
      id: Number(r.id),
      requirement: `R${Number(r.requirement_num)}`,
      kind: r.kind as 'scope',
      actor: r.actor as string,
      from: JSON.parse(r.from_value as string) as RequirementChange['from'],
      to: JSON.parse(r.to_value as string) as RequirementChange['to'],
      at: r.at as string,
    };
  }

  // ---- products ----------------------------------------------------------------

  private productFromRow(r: Row): Product {
    return {
      project: r.project_id as string,
      id: r.id as string,
      name: r.name as string,
      color: (r.color as string | null) ?? null,
      locked: !!r.locked,
      archived: r.archived_at != null,
      createdBy: r.created_by as string,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      requirements: Number(r.n ?? 0),
    };
  }

  private static readonly PRODUCT_SELECT = `SELECT p.*, (
      SELECT COUNT(*) FROM requirement_products rp JOIN requirements r ON r.num = rp.requirement_num
      WHERE rp.project_id = p.project_id AND rp.product_id = p.id AND r.status IN ('pending', 'active')
    ) AS n FROM products p`;

  /** Products of these projects (every project when omitted), by name; archived ones only when asked for. */
  listProducts(projects?: string[], includeArchived = false): Product[] {
    const where: string[] = [];
    if (projects) where.push(projects.length ? `p.project_id IN (${projects.map(() => '?').join(',')})` : '0');
    if (!includeArchived) where.push('p.archived_at IS NULL');
    const rows = this.db
      .prepare(`${Store.PRODUCT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.project_id, p.name COLLATE NOCASE, p.id`)
      .all(...(projects ?? [])) as Row[];
    return rows.map((r) => this.productFromRow(r));
  }

  getProduct(project: string, id: string): Product | null {
    const r = this.db.prepare(`${Store.PRODUCT_SELECT} WHERE p.project_id = ? AND p.id = ?`).get(project, id.trim().toLowerCase()) as Row | undefined;
    return r ? this.productFromRow(r) : null;
  }

  private requireProduct(project: string, id: string): Product {
    const p = this.getProduct(project, id);
    if (!p) throw new NotFoundError(`Product "${id}" not found`);
    return p;
  }

  /** A person adds a product to a project. Agents never create products. */
  createProduct(project: string, input: { id: string; name: string; color?: string | null }, actor: string): Product {
    const product = this.tx(() => {
      if (!this.getProject(project)) throw new NotFoundError(`Project "${project}" not found`);
      const id = input.id.trim().toLowerCase();
      if (this.getProduct(project, id)) throw new ConflictError(`Product "${id}" already exists in ${project}`);
      const at = this.now().toISOString();
      this.db
        .prepare('INSERT INTO products (project_id, id, name, color, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(project, id, input.name.trim(), input.color ?? null, actor, at, at);
      return this.requireProduct(project, id);
    });
    this.emit({ type: 'product', product });
    return product;
  }

  /**
   * Renames, recolours, locks or unlocks, archives or unarchives a product. A product with
   * requirements in force isn't archived: they'd drop out of what agents see. Move them first.
   */
  updateProduct(project: string, id: string, patch: { name?: string; color?: string | null; locked?: boolean; archived?: boolean }): Product {
    const product = this.tx(() => {
      const current = this.requireProduct(project, id);
      if (patch.archived && !current.archived && current.requirements > 0) {
        throw new ConflictError(
          `Product "${current.id}" has ${current.requirements} requirement${current.requirements > 1 ? 's' : ''} in force; rescope ${current.requirements > 1 ? 'them' : 'it'} before archiving`,
        );
      }
      const at = this.now().toISOString();
      this.db
        .prepare('UPDATE products SET name = ?, color = ?, locked = ?, archived_at = ?, updated_at = ? WHERE project_id = ? AND id = ?')
        .run(
          patch.name?.trim() ?? current.name,
          patch.color === undefined ? current.color : patch.color,
          (patch.locked ?? current.locked) ? 1 : 0,
          // Archiving again keeps when it was first archived.
          patch.archived === undefined || patch.archived === current.archived
            ? ((this.db.prepare('SELECT archived_at FROM products WHERE project_id = ? AND id = ?').get(project, current.id) as Row).archived_at as string | null)
            : patch.archived
              ? at
              : null,
          at,
          project,
          current.id,
        );
      return this.requireProduct(project, current.id);
    });
    this.emit({ type: 'product', product });
    return product;
  }

  // ---- push tokens -------------------------------------------------------

  /** `userId` is the owning account (absent for static config tokens). */
  addPushToken(token: string, platform: string, owner: string, userId: string | null = null) {
    this.db
      .prepare(
        `INSERT INTO push_tokens (token, platform, owner, user_id, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(token) DO UPDATE SET owner = excluded.owner, platform = excluded.platform, user_id = excluded.user_id`,
      )
      .run(token, platform, owner, userId, this.now().toISOString());
  }

  /**
   * Drops a person's phones: tokens registered by their account, and tokens from
   * before accounts were recorded under their name. Static config tokens' phones
   * (no account, not legacy) are never matched by name.
   */
  removePushTokensOf(userId: string, name: string | null) {
    this.db
      .prepare('DELETE FROM push_tokens WHERE user_id = ? OR (legacy = 1 AND user_id IS NULL AND owner = ?)')
      .run(userId, name ?? '');
  }

  removePushToken(token: string) {
    this.db.prepare('DELETE FROM push_tokens WHERE token = ?').run(token);
  }

  /** Alerts go out as regular notifications rather than high priority (an instance setting). */
  quietAlerts(): boolean {
    return !!this.db.prepare("SELECT 1 FROM meta WHERE key = 'quiet_alerts' AND value = '1'").get();
  }

  setQuietAlerts(on: boolean) {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES ('quiet_alerts', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(on ? '1' : '0');
  }

  listPushTokens(): { token: string; platform: string; owner: string; userId: string | null }[] {
    return this.db.prepare('SELECT token, platform, owner, user_id AS userId FROM push_tokens').all() as {
      token: string;
      platform: string;
      owner: string;
      userId: string | null;
    }[];
  }
  // ---- TRMNL screens (one per project) --------------------------------------------

  private trmnlFromRow(r: Row): TrmnlSetup {
    return {
      project: r.project_id as string,
      webhookUrl: r.webhook_url as string,
      enabled: Number(r.enabled) === 1,
      includeNotifications: Number(r.include_notifications) === 1,
      plus: Number(r.plus) === 1,
      card: r.card ? (JSON.parse(r.card as string) as TrmnlCard) : null,
      lastPushAt: (r.last_push_at as string | null) ?? null,
      lastError: (r.last_error as string | null) ?? null,
      lastErrorAt: (r.last_error_at as string | null) ?? null,
      updatedAt: r.updated_at as string,
    };
  }

  trmnlSetup(project: string): TrmnlSetup | null {
    const r = this.db.prepare('SELECT * FROM trmnl_setups WHERE project_id = ?').get(project) as Row | undefined;
    return r ? this.trmnlFromRow(r) : null;
  }

  listTrmnlSetups(): TrmnlSetup[] {
    return (this.db.prepare('SELECT * FROM trmnl_setups').all() as Row[]).map((r) => this.trmnlFromRow(r));
  }

  /** Creates or changes a project's TRMNL setup; a new one needs the webhook URL. Leaving `plus` out keeps it. */
  saveTrmnlSetup(
    project: string,
    input: { webhookUrl?: string; enabled: boolean; includeNotifications: boolean; plus?: boolean },
  ): TrmnlSetup {
    if (!this.getProject(project)) throw new NotFoundError(`Project "${project}" not found`);
    const current = this.trmnlSetup(project);
    const url = input.webhookUrl ?? current?.webhookUrl;
    if (!url) throw new ValidationError('webhookUrl is required');
    const now = this.now().toISOString();
    // A new URL is a new plugin: its last push and error belong to the old one.
    const fresh = !current || url !== current.webhookUrl;
    // Switching lane updates on or off: an update kept from before shouldn't come back.
    const dropCard = !!current && current.includeNotifications !== input.includeNotifications;
    this.db
      .prepare(
        `INSERT INTO trmnl_setups (project_id, webhook_url, enabled, include_notifications, plus, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET webhook_url = excluded.webhook_url, enabled = excluded.enabled,
           include_notifications = excluded.include_notifications, plus = excluded.plus, updated_at = excluded.updated_at
           ${fresh ? ', last_push_at = NULL, last_error = NULL, last_error_at = NULL' : ''}${dropCard ? ', card = NULL' : ''}`,
      )
      .run(project, url, input.enabled ? 1 : 0, input.includeNotifications ? 1 : 0, (input.plus ?? current?.plus) ? 1 : 0, now);
    return this.trmnlSetup(project)!;
  }

  deleteTrmnlSetup(project: string) {
    this.db.prepare('DELETE FROM trmnl_setups WHERE project_id = ?').run(project);
  }

  setTrmnlCard(project: string, card: TrmnlCard | null) {
    this.db.prepare('UPDATE trmnl_setups SET card = ? WHERE project_id = ?').run(card ? JSON.stringify(card) : null, project);
  }

  /** The outcome of a push: success clears the error. */
  recordTrmnlPush(project: string, at: Date, error: string | null) {
    if (error === null) {
      this.db
        .prepare('UPDATE trmnl_setups SET last_push_at = ?, last_error = NULL, last_error_at = NULL WHERE project_id = ?')
        .run(at.toISOString(), project);
    } else {
      this.db
        .prepare('UPDATE trmnl_setups SET last_error = ?, last_error_at = ? WHERE project_id = ?')
        .run(error, at.toISOString(), project);
    }
  }
}
