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
  type Requirement,
  type RequirementStatus,
  type TrmnlCard,
  type TrmnlSetup,
  type Stance,
  type StreamEvent,
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
  /** Escalation (id or code) the owner decided this in; its decider becomes `decidedBy`. */
  sourceEscalation?: string | null;
  /** The person who decided, when there's no escalation (e.g. said in Remote Control). */
  decidedBy?: string | null;
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
export interface WaitScope {
  ids?: string[];
  laneIds?: string[];
  groupId?: string;
  /**
   * Report escalations in the lanes/group that someone else withdrew at or after
   * this time (e.g. a human removed the lane). Defaults to when the wait starts;
   * a loop passes the previous result's `checkedAt` so nothing slips between calls.
   */
  since?: string;
  /** Who is waiting: their own withdrawals aren't reported back to them. */
  viewer?: string;
  /**
   * `digest` (the default): ready only when there's something to handle, and the owner's lane notes
   * since `since` come back again, so a crashed wait that repeats its `since` loses nothing. `full`:
   * the older behaviour, ready at once when nothing is open, notes handed over once.
   */
  mode?: 'digest' | 'full';
}

export interface WaitResult {
  /** True when there's something to act on, or nothing left to wait for. */
  ready: boolean;
  /** Answered and waiting for the agent's acknowledgement. */
  decided: Escalation[];
  /**
   * Escalations named in `ids` that were closed (withdrawn or already acknowledged), and ones in
   * the lanes/group that someone else withdrew since `since` ("Lane removed by …" means stop that lane).
   */
  closed: Escalation[];
  /**
   * The owner answered Other: their messages since the agent last wrote. Act on them and acknowledge,
   * or reply (reply_to_escalation).
   */
  replies: { id: string; ref: string; projectKey: string; laneId: string; question: string; messages: Message[] }[];
  /** Still waiting on a human. */
  open: { id: string; ref: string; laneId: string; question: string }[];
  /** Lanes in scope that someone else took off the dashboard since `since`: stop work on them. */
  removedLanes: { laneId: string; removedBy: string | null; at: string }[];
  /** The owner wrote on lanes in scope (not about an escalation): their messages the agent hasn't seen. */
  laneMessages: { laneId: string; messages: LaneMessage[] }[];
  /** Server time of this result; pass it as `since` on the next wait. */
  checkedAt: string;
}

export const EXPORT_DATASETS = ['escalations', 'positions', 'messages', 'lane_messages', 'lanes', 'groups', 'tickets', 'events', 'requirements'] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];

/** Fixed column order per dataset, so a CSV's header never depends on whether it has rows. */
export const EXPORT_COLUMNS: Record<ExportDataset, readonly string[]> = {
  escalations: [
    'id', 'ref', 'project', 'lane_id', 'lane_name', 'group_id', 'group_name', 'ticket', 'ticket_url', 'question', 'context',
    'recommendation', 'recommended_option', 'cost', 'alternatives', 'options', 'accept_means', 'reject_means',
    'allow_reject', 'attachments', 'blocking', 'state', 'created_by',
    'created_at', 'decided_by', 'decided_at', 'decision', 'decision_note', 'followed_recommendation',
    'acknowledged_at', 'resolution', 'closed_at', 'seconds_to_decision', 'seconds_to_acknowledge', 'seconds_open',
    'positions_agree', 'positions_disagree', 'positions_neutral', 'links', 'ticket_id', 'legacy_ref',
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
  events: ['id', 'project', 'lane_id', 'at', 'kind', 'message', 'actor', 'ticket_id'],
  messages: ['id', 'escalation_id', 'escalation_ref', 'project', 'lane_id', 'from', 'author', 'body', 'attachments', 'at'],
  lane_messages: ['id', 'project', 'lane_id', 'from', 'author', 'body', 'attachments', 'at'],
  requirements: [
    'id', 'project', 'group_id', 'requirement', 'justification', 'tags', 'status', 'superseded_by', 'decided_by',
    'source_escalation', 'recorded_by', 'created_at', 'updated_at',
  ],
};
export interface ExportFilter {
  from?: string;
  to?: string;
  /** Qualified lane id. */
  laneId?: string;
  /** Projects to include (requirements for all projects are always included); undefined = every project. */
  projects?: string[];
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

const SCHEMA_VERSION = 16;

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
   * Tickets are stored by their canonical ref, which depends on the configured ticket systems: after
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
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(SCHEMA_VERSION));
    });
  }

  /**
   * Tickets: each lane's ticket becomes a record that owns its escalations and status history, so a
   * lane can set it aside and pick it up again (or another lane can). Lanes that share a ticket share
   * one record; a live lane holds it (the most recently updated one, if several did). Completed lanes
   * with nothing left to answer leave the dashboard, their tickets done.
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

  private hasColumn(table: string, column: string) {
    return (this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some((c) => c.name === column);
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
    this.events.emit('change', event);
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
   * have been showing as ungrouped.
   */
  private writeGroup(id: string, patch: GroupPatch, actor: string | null, at: string, owner?: string): boolean {
    const restored =
      this.db.prepare('UPDATE groups SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL').run(id).changes > 0;
    const existing = this.getGroup(id);
    if (!existing) {
      this.db
        .prepare('INSERT INTO groups (id, name, ticket, links, agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, patch.name ?? localId(id), patch.ticket ?? null, JSON.stringify(patch.links ?? []), actor, at, at);
      if (owner) this.db.prepare('UPDATE groups SET owner = ? WHERE id = ?').run(owner, id);
      return false;
    }
    if (owner) this.db.prepare('UPDATE groups SET owner = ? WHERE id = ?').run(owner, id);
    if (patch.name === undefined && patch.ticket === undefined && patch.links === undefined) return restored;
    this.db
      .prepare('UPDATE groups SET name = ?, ticket = ?, links = ?, agent = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.name ?? existing.name,
        patch.ticket !== undefined ? patch.ticket : existing.ticket,
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
    const ticket = (r.ticket as string | null) ?? null;
    return {
      id: r.id as string,
      project: r.project_id as string,
      letter: r.letter_index == null ? null : letterOf(Number(r.letter_index)),
      name: r.name as string,
      // A lane in an archived group shows as ungrouped; the raw group_id is kept for exports.
      group: r.group_archived ? null : ((r.group_id as string | null) ?? null),
      status: r.status as LaneStatus,
      ticket,
      ticketUrl: ticket ? this.resolveTicketUrl(ticket) : null,
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
      (SELECT COUNT(*) FROM escalations e WHERE e.state = 'open'
         AND ((e.ticket_id IS NULL AND e.lane_id = l.id) OR e.ticket_id = l.ticket_id)) AS open_escalations,
      (SELECT COUNT(*) FROM escalations e WHERE e.state = 'open' AND e.blocking = 1 AND e.turn = 'owner'
         AND ((e.ticket_id IS NULL AND e.lane_id = l.id) OR e.ticket_id = l.ticket_id)) AS open_blocking,
      (SELECT t.waiting_on FROM tickets t WHERE t.num = l.ticket_id) AS ticket_waiting_on,
      (SELECT g.archived_at IS NOT NULL FROM groups g WHERE g.id = l.group_id) AS group_archived,
      (SELECT MAX(m.id) FROM lane_messages m WHERE m.lane_id = l.id) AS last_message_id,
      (SELECT MAX(m.id) FROM lane_messages m WHERE m.lane_id = l.id AND m.author_kind = 'agent') AS last_agent_message_id,
      (SELECT COUNT(*) FROM lane_messages m WHERE m.lane_id = l.id AND m.author_kind = 'owner' AND m.id > l.agent_read_id) AS unread_by_agent
    FROM lanes l`;

  /** Active lanes (archived ones are kept for export but hidden). */
  listLanes(projects?: string[]): Lane[] {
    const p = this.inProjects(projects, 'l.project_id');
    return (
      this.db
        .prepare(`${Store.LANE_SELECT} WHERE l.archived_at IS NULL${p.sql} ORDER BY l.updated_at DESC`)
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
      if (!existing) {
        const status = rest.status ?? 'active';
        this.db
          .prepare(
            `INSERT INTO lanes (id, name, group_id, status, ticket, activity, links, agent, created_at, updated_at, status_since, blocked_since)
             VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
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
      if (fill.waitingOn !== undefined) {
        const holding = this.requireLane(id).ticketId;
        if (holding !== null) touched.tickets.add(holding);
        const note = this.setWaitingOn(this.requireLane(id), fill.waitingOn, at);
        if (note) warning = [warning, note].filter(Boolean).join(' ');
      }
      this.db.prepare('UPDATE tickets SET group_id = (SELECT group_id FROM lanes WHERE id = ?) WHERE lane_id = ?').run(id, id);
      this.syncLetter(id);
      for (const other of touched.lanes) if (other !== id) this.syncLetter(other);
      return this.requireLane(id);
    });
    if (createdGroup) this.emit({ type: 'group', group: createdGroup });
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
        `UPDATE lanes SET name = ?, group_id = CASE WHEN ? THEN ? ELSE group_id END, status = ?, ticket = ?, activity = ?, links = ?, agent = ?,
           updated_at = ?, status_since = ?, blocked_since = ?, blocked_total_ms = ? WHERE id = ?`,
      )
      .run(
        patch.name ?? existing.name,
        // Only touch group_id when the patch sets it: a lane in an archived group reads as
        // ungrouped but keeps its group_id for exports.
        patch.group !== undefined ? 1 : 0,
        patch.group ?? null,
        status,
        patch.ticket !== undefined ? patch.ticket : existing.ticket,
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
   * Its ticket is let go as `previous` says (parked by default): a
   * parked ticket keeps its questions open, a finished one's unanswered questions are withdrawn, as
   * are those raised while the lane held no ticket. Publishing to the same lane id later restores it.
   */
  deleteLane(id: string, actor: string | null = null, release: { previous?: TicketRelease; reason?: string | null } = {}) {
    const touched: Touched = { escalations: new Set(), lanes: new Set(), tickets: new Set() };
    this.tx(() => {
      const lane = this.getLane(id);
      if (!lane) throw new NotFoundError(`Lane "${localId(id)}" not found`);
      const at = this.now().toISOString();
      if (lane.ticketId !== null) {
        const how = release.previous ?? (lane.status === 'completed' ? 'done' : 'park');
        this.releaseTicket(lane, how, release.reason?.trim() || (how === 'park' ? 'Lane removed' : null), actor, at, touched);
      }
      // Only unanswered questions are withdrawn. Decided ones keep their answer and
      // can still be acknowledged by an agent that's acting on it.
      // The lane's own questions (raised while it held no ticket); a ticket's stay with the ticket.
      const own = `lane_id = ? AND state = 'open' AND ticket_id IS NULL`;
      const pending = (this.db.prepare(`SELECT id FROM escalations WHERE ${own}`).all(id) as Row[]).map((r) => r.id as string);
      const resolution = `Lane removed${actor ? ` by ${actor}` : ''}`;
      this.db
        .prepare(`UPDATE escalations SET state = 'withdrawn', resolution = COALESCE(resolution, ?), withdrawn_by = ?, updated_at = ? WHERE ${own}`)
        .run(resolution, actor ?? '', at, id);
      for (const eid of pending) {
        this.addEvent(id, at, 'escalation', `Escalation closed: ${resolution}`, actor, null);
        touched.escalations.add(eid);
      }
      // End any blocked spell now, so archived time isn't counted as blocked.
      const now = this.requireLane(id);
      if (now.status === 'blocked_human') this.applyLaneUpdate(now, { status: 'idle' }, actor, at);
      this.db.prepare('UPDATE lanes SET ticket = NULL, ticket_id = NULL, archived_at = ?, updated_at = ? WHERE id = ?').run(at, at, id);
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
    const taken = (code: string) =>
      !!this.db.prepare('SELECT 1 FROM tickets WHERE project_id = ? AND code_ref = ? COLLATE NOCASE AND num <> ?').get(project, code, num);
    const short = this.refs.display(ref);
    let code = CODE_REF.test(short) && /\d$/.test(short) && !taken(short) ? short : `T${num}`;
    for (let n = 2; taken(code); n++) code = `T${num}-${n}`;
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
      group: (r.group_id as string | null) ?? null,
      lane: (r.lane_id as string | null) ?? null,
      state: r.state as TicketState,
      parkReason: (r.park_reason as string | null) ?? null,
      waitingOn: (r.waiting_on as string | null) ?? null,
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
    if (held && (ref === held.ref || ref === this.refs.canonical(held.display_ref as string))) {
      this.db.prepare('UPDATE lanes SET ticket = ? WHERE id = ?').run(written, lane.id);
      return undefined;
    }
    if (!held && !ref) {
      this.db.prepare('UPDATE lanes SET ticket = NULL WHERE id = ?').run(lane.id);
      return undefined;
    }
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
    this.db.prepare('UPDATE lanes SET ticket = NULL, ticket_id = NULL WHERE id = ?').run(lane.id);
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
    this.db.prepare('UPDATE lanes SET ticket = ?, ticket_id = ? WHERE id = ?').run(written, num, lane.id);
    // Blocked by the ticket's questions, or by ones the lane raised while it held none.
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

  /** Must run inside a transaction. What the lane's ticket waits on (another ticket), or nothing. Returns a warning, if any. */
  private setWaitingOn(lane: Lane, waitingOn: string | null, at: string): string | undefined {
    if (lane.ticketId === null) {
      return waitingOn ? `Lane "${localId(lane.id)}" holds no ticket now, so waiting_on was left out.` : undefined;
    }
    const ref = waitingOn?.trim() ? this.refs.canonical(waitingOn) : null;
    const own = this.ticketRow(lane.ticketId);
    if (ref && ref === own.ref) throw new ValidationError('A ticket can\'t wait on itself');
    if ((own.waiting_on ?? null) === ref) return undefined;
    this.db.prepare('UPDATE tickets SET waiting_on = ?, updated_at = ? WHERE num = ?').run(ref, at, lane.ticketId);
    this.addEvent(lane.id, at, 'ticket', ref ? `${this.ticketName(own)} waits on ${this.refs.display(ref)}` : `${this.ticketName(own)} no longer waits`, null);
    return undefined;
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

  private escalationFromRow(r: Row): Escalation {
    return {
      id: r.id as string,
      ref: (r.code as string | null) ?? (r.letter_index == null ? String(r.ref) : `${letterOf(Number(r.letter_index))}${Number(r.seq)}`),
      ticketId: r.ticket_id == null ? null : Number(r.ticket_id),
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
    filter: { states?: EscalationState[]; laneId?: string; groupId?: string; ticketId?: number; projects?: string[]; limit?: number } = {},
  ): Escalation[] {
    const states = filter.states ?? ['open', 'decided'];
    const where = [`state IN (${states.map(() => '?').join(',')})`];
    const params: (string | number)[] = [...states];
    if (filter.ticketId !== undefined) {
      where.push('ticket_id = ?');
      params.push(filter.ticketId);
    }
    if (filter.laneId) {
      where.push('lane_id = ?');
      params.push(filter.laneId);
    }
    if (filter.groupId) {
      where.push('lane_id IN (SELECT id FROM lanes WHERE group_id = ?)');
      params.push(filter.groupId);
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
    before?: { at: string; id: string };
    limit?: number;
  }): { items: Escalation[]; next: { at: string; id: string } | null } {
    const states = filter.states?.length ? filter.states : ['acknowledged', 'withdrawn'];
    const where = [`state IN (${states.map(() => '?').join(',')})`];
    const params: (string | number)[] = [...states];
    if (filter.groupId) {
      where.push('lane_id IN (SELECT id FROM lanes WHERE group_id = ?)');
      params.push(filter.groupId);
    }
    const text = filter.query?.trim();
    if (text) {
      const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const fields = ['question', 'context', 'decision', 'decision_note', 'resolution', 'recommendation'];
      const code = /^([A-Za-z]{1,4})(\d{1,9})$/.exec(text.replace(/^#/, ''));
      where.push(
        `(${fields.map((f) => `${f} LIKE ? ESCAPE '\\'`).join(' OR ')}
          OR EXISTS (SELECT 1 FROM messages m WHERE m.escalation_id = escalations.id AND m.body LIKE ? ESCAPE '\\')
          OR code = ? COLLATE NOCASE${code ? ' OR (letter_index = ? AND seq = ?)' : ''})`,
      );
      params.push(...fields.map(() => like), like, text.replace(/^#/, ''));
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
  getEscalation(id: string, project?: string): Escalation | null {
    const text = id.trim().replace(/^#/, '');
    if (UUID.test(text)) {
      const r = this.db.prepare('SELECT * FROM escalations WHERE id = ?').get(text) as Row | undefined;
      return r ? this.escalationFromRow(r) : null;
    }
    // Ticket codes end in a digit and letters ("967A"); a project key may come first.
    if (/\d[A-Za-z]{1,4}$/.test(text)) {
      const byCode = (code: string, inProject?: string) => {
        const p = this.inProjects(inProject ? [inProject] : undefined);
        const rows = this.db.prepare(`SELECT * FROM escalations WHERE code = ? COLLATE NOCASE${p.sql} LIMIT 2`).all(code, ...p.params) as Row[];
        return rows.length === 1 ? this.escalationFromRow(rows[0]) : null;
      };
      const found = byCode(text, project);
      if (found) return found;
      const keyedTicket = /^([A-Za-z][A-Za-z0-9]{1,9})[·.-](.+)$/.exec(text);
      if (keyedTicket) {
        const inProject = this.projectByKey(keyedTicket[1])?.id;
        if (inProject) return byCode(keyedTicket[2], inProject);
      }
      return null;
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
      .prepare('DELETE FROM attachments WHERE escalation_id IS NULL AND lane_message_id IS NULL AND created_at < ?')
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
          .prepare('SELECT COUNT(*) AS n FROM attachments WHERE escalation_id IS NULL AND lane_message_id IS NULL AND owner = ?')
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
      const r = this.db.prepare('SELECT owner, escalation_id, lane_message_id FROM attachments WHERE id = ?').get(id) as Row | undefined;
      if (!r || r.owner !== owner) {
        throw new NotFoundError(`Attachment ${id} not found: upload it first (POST /api/attachments), with the same key`);
      }
      // Already here (a retry sending the same ids): nothing to add.
      if (r.escalation_id === escalationId && messageId === null) continue;
      if (r.escalation_id || r.lane_message_id != null) throw new ConflictError(`Attachment ${id} is already attached; upload it again`);
      if (have >= this.attachmentsPerItem) {
        throw new ValidationError(`At most ${this.attachmentsPerItem} attachments per ${messageId === null ? 'escalation' : 'message'}`);
      }
      this.db
        .prepare('UPDATE attachments SET escalation_id = ?, message_id = ?, position = ? WHERE id = ?')
        .run(escalationId, messageId, have++, id);
    }
  }

  /** Attaches uploads to a lane message (inside a transaction): each the uploader's, not attached elsewhere. */
  private linkLaneAttachments(laneMessageId: number, ids: string[], owner: string) {
    let have = 0;
    for (const id of new Set(ids)) {
      const r = this.db.prepare('SELECT owner, escalation_id, lane_message_id FROM attachments WHERE id = ?').get(id) as Row | undefined;
      if (!r || r.owner !== owner) {
        throw new NotFoundError(`Attachment ${id} not found: upload it first (POST /api/attachments), with the same key`);
      }
      if (r.escalation_id || r.lane_message_id != null) throw new ConflictError(`Attachment ${id} is already attached; upload it again`);
      if (have >= this.attachmentsPerItem) throw new ValidationError(`At most ${this.attachmentsPerItem} attachments per message`);
      this.db.prepare('UPDATE attachments SET lane_message_id = ?, position = ? WHERE id = ?').run(laneMessageId, have++, id);
    }
  }

  /**
   * An attachment's file, and the escalation or lane it's on (both null while unreferenced, when only
   * its uploader may read it). Callers check that the reader can see that escalation or lane.
   */
  getAttachment(
    id: string,
  ): (AttachmentMeta & { data: Uint8Array; escalationId: string | null; laneId: string | null; owner: string }) | null {
    const r = this.db
      .prepare('SELECT a.*, m.lane_id AS message_lane_id FROM attachments a LEFT JOIN lane_messages m ON m.id = a.lane_message_id WHERE a.id = ?')
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
      owner: r.owner as string,
    };
  }

  /** Whether a code names its project ("SH·967A"): ticket codes and project keys can look alike ("PROJ-12A"). */
  isKeyedCode(text: string): boolean {
    const t = text.trim().replace(/^#/, '');
    const m = /^([A-Za-z][A-Za-z0-9]{1,9})[·.-](.+\d[A-Za-z]{1,4})$/.exec(t);
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

  escalationOwner(id: string): string | null {
    const r = this.db.prepare('SELECT raised_by_owner FROM escalations WHERE id = ?').get(id) as Row | undefined;
    return (r?.raised_by_owner as string | null) ?? null;
  }

  private requireEscalation(id: string): Escalation {
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
    // The same question again (ignoring spacing and case) is a retry.
    const norm = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase();
    const existing = (
      this.db
        .prepare(
          `SELECT id, question FROM escalations WHERE state = 'open'
             AND ((ticket_id IS NULL AND lane_id = ?) OR ticket_id = (SELECT ticket_id FROM lanes WHERE id = ?))
             AND ${owner ? 'raised_by_owner = ?' : 'created_by = ?'}`,
        )
        .all(input.laneId, input.laneId, owner ?? actor) as Row[]
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
      this.restoreLane(input.laneId, actor, at);
      const lane = this.requireLane(input.laneId);
      const id = randomUUID();
      const ref = Number((this.db.prepare('SELECT COALESCE(MAX(ref), 0) + 1 AS n FROM escalations').get() as Row).n);
      this.syncLetter(input.laneId, true);
      // On a lane holding a ticket: the ticket's code and its next letter ("967A"). Otherwise the lane's letter and a number.
      let letterIndex: number | null = null;
      let seq: number | null = null;
      let code: string;
      if (lane.ticketId !== null) {
        const t = this.ticketRow(lane.ticketId);
        code = `${t.code_ref as string}${letterOf(Number(t.next_seq) - 1)}`;
        this.db.prepare('UPDATE tickets SET next_seq = next_seq + 1, updated_at = ? WHERE num = ?').run(at, lane.ticketId);
      } else {
        letterIndex = Number((this.db.prepare('SELECT letter_index FROM lanes WHERE id = ?').get(input.laneId) as Row).letter_index);
        seq = Number(
          (
            this.db
              .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM escalations WHERE letter_index = ? AND project_id = ?')
              .get(letterIndex, projectOf(input.laneId)) as Row
          ).n,
        );
        code = `${letterOf(letterIndex)}${seq}`;
      }
      this.db
        .prepare(
          `INSERT INTO escalations (id, ref, letter_index, seq, ticket_id, code, lane_id, question, context, recommendation, recommended_option, cost,
             alternatives, ticket, positions, options, links, blocking, state, created_by, created_at, updated_at, raised_by_owner,
             accept_means, reject_means, allow_reject)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          ref,
          letterIndex,
          seq,
          lane.ticketId,
          lane.ticketId !== null ? code : null,
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
      this.addEvent(input.laneId, at, 'escalation', `Escalated ${code}: ${input.question}`, actor);
      const blocks = input.blocking !== false && lane.status !== 'blocked_human';
      if (blocks) {
        this.applyLaneUpdate(lane, { status: 'blocked_human' }, actor, at);
      } else {
        this.db.prepare('UPDATE lanes SET updated_at = ? WHERE id = ?').run(at, input.laneId);
      }
      return { escalation: this.requireEscalation(id), lane: this.requireLane(input.laneId), blocks };
    });
    this.emit({ type: 'escalation', escalation });
    this.emit({ type: 'lane', lane, statusChanged: blocks });
    return escalation;
  }

  /**
   * An open FYI becomes blocking: the lane blocks, and the owner is notified as for a new question.
   * Fields given again (context, recommendation, options, ...) replace the FYI's, so the owner has
   * what they need to answer.
   */
  private makeBlocking(id: string, input: EscalationInput, actor: string, owner: string | null): Escalation {
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
      const blocks = !!lane && lane.status !== 'blocked_human';
      if (lane && blocks) this.applyLaneUpdate(lane, { status: 'blocked_human' }, actor, at);
      return { escalation: this.requireEscalation(id), lane: lane ? this.requireLane(lane.id) : null, blocks };
    });
    this.emit({ type: 'escalation', escalation, raised: true });
    if (lane) this.emit({ type: 'lane', lane, statusChanged: blocks });
    return escalation;
  }

  // ---- lane conversations ----------------------------------------------

  private laneMessageFromRow(r: Row, readId?: number): LaneMessage {
    const attachments = (
      this.db.prepare('SELECT id, name, type, size FROM attachments WHERE lane_message_id = ? ORDER BY position').all(Number(r.id)) as Row[]
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
   * `since`) those written at or after it, handed over or not.
   */
  private unreadByAgent(laneId: string, since?: string): LaneMessage[] {
    return (
      this.db
        .prepare(
          `SELECT m.* FROM lane_messages m JOIN lanes l ON l.id = m.lane_id
           WHERE m.lane_id = ? AND m.author_kind = 'owner' AND (m.id > l.agent_read_id OR m.created_at >= ?) ORDER BY m.id`,
        )
        .all(laneId, since ?? '\uffff') as Row[]
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
    const found = this.laneIncludingArchived(laneId);
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
   * replying): its ticket's, and ones raised while it held none. A parked ticket's don't block the lane.
   */
  private openBlockingCount(laneId: string) {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM escalations e
         WHERE e.state = 'open' AND e.blocking = 1 AND e.turn = 'owner'
           AND ((e.ticket_id IS NULL AND e.lane_id = ?) OR e.ticket_id = (SELECT ticket_id FROM lanes WHERE id = ?))`,
      )
      .get(laneId, laneId) as Row;
    return Number(r.n);
  }

  /** Whether an escalation counts on a lane: raised there with no ticket, or its ticket is the one the lane holds. */
  private ofLane(e: Escalation, lane: Lane) {
    return e.ticketId === null ? e.laneId === lane.id : e.ticketId === lane.ticketId;
  }

  /**
   * The lane an escalation counts on: where it was raised if it has no ticket, else the lane holding
   * its ticket (none while the ticket is parked or over). Its `laneId` stays where it was raised.
   */
  private holderOf(e: Escalation): string | null {
    if (e.ticketId === null) return e.laneId;
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
      if (!found) return { escalation: this.requireEscalation(current.id), lane: null, unblocked: false };
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
      this.addEvent(current.laneId, at, 'escalation', `${position.agent} ${verb}${position.note ? `: ${position.note}` : ''}`, actor);
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
    const named = (scope.ids ?? []).map((id) => this.requireEscalation(id));
    const byId = new Map<string, Escalation>(named.map((e) => [e.id, e]));
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
    const closedById = new Map<string, Escalation>();
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
      const unread = this.unreadByAgent(laneId, digest ? scope.since : undefined);
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
    // Creation order; the internal global number breaks ties within a millisecond.
    const seqOf = (e: Escalation) => Number((this.db.prepare('SELECT ref FROM escalations WHERE id = ?').get(e.id) as Row).ref);
    const byAge = (a: Escalation, b: Escalation) => a.createdAt.localeCompare(b.createdAt) || seqOf(a) - seqOf(b);
    const all = [...byId.values()].sort(byAge);
    const decided = all.filter((e) => e.state === 'decided');
    const closed = [...closedById.values()].sort(byAge);
    const open = all
      .filter((e) => e.state === 'open' && e.turn === 'owner')
      .map((e) => ({ id: e.id, ref: e.ref, laneId: e.laneId, question: e.question }));
    const replies = all
      .filter((e) => e.state === 'open' && e.turn === 'agent')
      .map((e) => {
        const thread = this.messagesOf(e.id);
        const lastAgent = thread.findLastIndex((m) => m.from === 'agent');
        return { id: e.id, ref: e.ref, projectKey: e.projectKey, laneId: e.laneId, question: e.question, messages: thread.slice(lastAgent + 1) };
      });
    return {
      ready:
        decided.length > 0 ||
        replies.length > 0 ||
        laneMessages.length > 0 ||
        closed.length > 0 ||
        removedLanes.length > 0 ||
        // The full format also returns when nothing is left to wait for; a digest waits for a change.
        (!digest && open.length === 0),
      decided,
      replies,
      closed,
      open,
      removedLanes,
      laneMessages,
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
    scope = { ...scope, since: scope.since ?? this.now().toISOString() };
    const first = this.decisionsFor(scope);
    if (first.ready || timeoutMs <= 0 || signal?.aborted) return Promise.resolve(first);
    const held = new Set<string>();
    const releases: (() => void)[] = [];
    const hold = (laneIds: Iterable<string>) => {
      const fresh = [...laneIds].filter((id) => !held.has(id));
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
        if (e.type !== 'escalation' && e.type !== 'lane_deleted' && !(e.type === 'lane' && e.messaged === 'owner')) return;
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
             (SELECT COUNT(*) FROM escalations e WHERE e.lane_id = l.id) AS escalations_total,
             (SELECT COUNT(*) FROM escalations e WHERE e.lane_id = l.id AND e.state = 'open') AS escalations_open
           FROM lanes l LEFT JOIN groups g ON g.id = l.group_id ${w.sql}`,
        )
        .all(...w.params) as Row[];
      return page(raw, (r) => ({
        id: local(r.id),
        project: r.project_id,
        name: r.name,
        group_id: local(r.group_id),
        group_name: r.group_name,
        status: r.status,
        ticket: r.ticket,
        ticket_url: r.ticket ? this.resolveTicketUrl(r.ticket as string) : null,
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
        lane_id: local(r.lane_id),
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
          lane_id: local(r.lane_id),
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
            lane_id: local(e.lane_id),
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
        lane_id: local(e.lane_id),
        lane_name: e.lane_name,
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
      requirement: r.requirement as string,
      justification: r.justification as string,
      tags: JSON.parse(r.tags as string) as string[],
      status: r.status as RequirementStatus,
      supersededBy: r.superseded_by == null ? null : `R${Number(r.superseded_by)}`,
      decidedBy: r.decided_by as string,
      // Within a project its code is enough; an all-projects requirement names the project too.
      sourceEscalation: source ? (r.project_id ? source.ref : `${source.projectKey}-${source.ref}`) : null,
      recordedBy: r.recorded_by as string,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
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
    // An id ("R14") finds that requirement, whatever its status.
    if (filter.query && this.requirementNum(filter.query) !== null && /^r/i.test(filter.query.trim())) {
      const one = this.getRequirement(filter.query);
      return one && (!filter.projects || one.project === null || filter.projects.includes(one.project))
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
    const { decidedBy, escalationId } = this.decisionSource(input, actor, actorIsHuman, actorOwner);
    const res = this.db
      .prepare(
        `INSERT INTO requirements (project_id, group_id, requirement, justification, tags, status, decided_by,
           source_escalation_id, recorded_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.project ?? null,
        input.group ?? null,
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
    return Number(res.lastInsertRowid);
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
      const at = this.now().toISOString();
      const num = this.insertRequirement(
        {
          ...input,
          group: input.group === undefined ? current.group : input.group,
          project: input.project === undefined ? current.project : input.project,
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
  approveRequirement(id: string): Requirement {
    const { requirement, replaced } = this.tx(() => {
      const current = this.requireRequirement(id);
      if (current.status !== 'pending') throw new ConflictError(`${current.id} is ${current.status}; only pending requirements can be approved`);
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

  /** Undoes a retire (e.g. a mis-tap): a person restores it, so it is active (approved) again. */
  restoreRequirement(id: string): Requirement {
    const requirement = this.tx(() => {
      const current = this.requireRequirement(id);
      if (current.status !== 'retired') throw new ConflictError(`${current.id} is ${current.status}; only retired requirements can be restored`);
      this.db
        .prepare("UPDATE requirements SET status = 'active', updated_at = ? WHERE num = ?")
        .run(this.now().toISOString(), this.requirementNum(current.id)!);
      return this.requireRequirement(current.id);
    });
    this.emit({ type: 'requirement', requirement });
    return requirement;
  }

  /**
   * Withdraws a requirement with no replacement (the decision no longer applies), or rejects a
   * pending one. A requirement it was to replace no longer has a replacement waiting.
   */
  retireRequirement(id: string): Requirement {
    const { requirement, kept } = this.tx(() => {
      const current = this.requireRequirement(id);
      if (!inForce(current)) throw new ConflictError(`${current.id} is already ${current.status}`);
      const at = this.now().toISOString();
      const num = this.requirementNum(current.id)!;
      this.db.prepare("UPDATE requirements SET status = 'retired', updated_at = ? WHERE num = ?").run(at, num);
      const kept = this.replacedBy(num);
      for (const old of kept) this.db.prepare('UPDATE requirements SET superseded_by = NULL, updated_at = ? WHERE num = ?').run(at, old);
      return { requirement: this.requireRequirement(current.id), kept: kept.map((n) => this.requireRequirement(String(n))) };
    });
    for (const old of kept) this.emit({ type: 'requirement', requirement: old });
    this.emit({ type: 'requirement', requirement });
    return requirement;
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
