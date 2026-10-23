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
  type Position,
  type Requirement,
  type RequirementStatus,
  type Stance,
  type StreamEvent,
} from './types.ts';

export class NotFoundError extends Error {}

const MAX_POSITIONS = 20;
export class ConflictError extends Error {}
/** Input that's well-formed but not acceptable (e.g. an overbroad tag); a 400. */
export class ValidationError extends Error {}

/** Tags too broad to help anyone find a requirement; overridable with LANESIGNAL_BROAD_TAGS. */
export const DEFAULT_BROAD_TAGS = [
  'backend', 'frontend', 'ui', 'ux', 'api', 'misc', 'general', 'other', 'product', 'feature', 'features',
  'requirement', 'requirements', 'decision', 'decisions', 'important', 'todo', 'bug', 'bugs', 'code', 'app',
];

export interface RequirementInput {
  requirement: string;
  justification: string;
  tags: string[];
  /** Group id; null or absent for product-wide. */
  group?: string | null;
  /** Escalation (id or code) the owner decided this in; its decider becomes `decidedBy`. */
  sourceEscalation?: string | null;
  /** The person who decided, when there's no escalation (e.g. said in Remote Control). */
  decidedBy?: string | null;
}

export interface RecordResult {
  requirement: Requirement;
  /** Active requirements that read alike: check these aren't the same decision. */
  similar: Requirement[];
  /** Advice, e.g. a tag already on most requirements. */
  warnings: string[];
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
  /** Still waiting on a human. */
  open: { id: string; ref: string; laneId: string; question: string }[];
  /** Lanes in scope that someone else took off the dashboard since `since`: stop work on them. */
  removedLanes: { laneId: string; removedBy: string | null; at: string }[];
  /** Server time of this result; pass it as `since` on the next wait. */
  checkedAt: string;
}

export const EXPORT_DATASETS = ['escalations', 'positions', 'lanes', 'groups', 'events', 'requirements'] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];

/** Fixed column order per dataset, so a CSV's header never depends on whether it has rows. */
export const EXPORT_COLUMNS: Record<ExportDataset, readonly string[]> = {
  escalations: [
    'id', 'ref', 'lane_id', 'lane_name', 'group_id', 'group_name', 'ticket', 'ticket_url', 'question', 'context',
    'recommendation', 'recommended_option', 'cost', 'alternatives', 'options', 'blocking', 'state', 'created_by',
    'created_at', 'decided_by', 'decided_at', 'decision', 'decision_note', 'followed_recommendation',
    'acknowledged_at', 'resolution', 'closed_at', 'seconds_to_decision', 'seconds_to_acknowledge', 'seconds_open',
    'positions_agree', 'positions_disagree', 'positions_neutral', 'links',
  ],
  positions: ['escalation_id', 'escalation_ref', 'lane_id', 'question', 'agent', 'stance', 'note', 'at'],
  lanes: [
    'id', 'name', 'group_id', 'group_name', 'status', 'ticket', 'ticket_url', 'activity', 'last_published_by',
    'created_at', 'updated_at', 'status_since', 'blocked_seconds_total', 'blocked_since', 'escalations_total',
    'escalations_open', 'links', 'archived_at',
  ],
  groups: ['id', 'name', 'ticket', 'ticket_url', 'links', 'last_published_by', 'created_at', 'updated_at', 'archived_at'],
  events: ['id', 'lane_id', 'at', 'kind', 'message', 'actor'],
  requirements: [
    'id', 'group_id', 'requirement', 'justification', 'tags', 'status', 'superseded_by', 'decided_by',
    'source_escalation', 'recorded_by', 'created_at', 'updated_at',
  ],
};
export interface ExportFilter {
  from?: string;
  to?: string;
  laneId?: string;
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
  ticket?: string | null;
  activity?: string | null;
  links?: Link[];
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
  links?: Link[];
  /** Marks the lane blocked_human until the escalation is decided. Default true. */
  blocking?: boolean;
}

export interface StoreOptions {
  path: string;
  resolveTicketUrl: (ticket: string) => string | null;
  eventRetention?: number;
  now?: () => Date;
  /** How long a lane keeps showing "agent waiting" after a wait ends (default 30s). */
  waitGraceMs?: number;
  /** Tags rejected as too broad (lowercase). */
  broadTags?: string[];
}

const SCHEMA_VERSION = 7;

type Row = Record<string, unknown>;

/**
 * SQLite-backed store. Every mutation emits a StreamEvent on `events`, which
 * feeds SSE clients, long-polling agents, and push notifications.
 */
export class Store {
  readonly events = new EventEmitter<{ change: [StreamEvent] }>();
  private db: DatabaseSync;
  private resolveTicketUrl: (ticket: string) => string | null;
  private broadTags: Set<string>;
  private retention: number;
  private now: () => Date;
  /** Lanes with an agent currently waiting on their escalations (in memory: waits don't survive restarts). */
  private waiting = new Map<string, number>();
  private graceTimers = new Set<ReturnType<typeof setTimeout>>();
  private waitGraceMs: number;

  constructor(opts: StoreOptions) {
    this.db = new DatabaseSync(opts.path);
    this.resolveTicketUrl = opts.resolveTicketUrl;
    this.retention = opts.eventRetention ?? 200;
    this.now = opts.now ?? (() => new Date());
    this.waitGraceMs = opts.waitGraceMs ?? WAIT_GRACE_MS;
    this.broadTags = new Set((opts.broadTags ?? DEFAULT_BROAD_TAGS).map((t) => t.toLowerCase()));
    this.events.setMaxListeners(0);
    this.migrate();
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
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(SCHEMA_VERSION));
    });
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
      name: r.name as string,
      ticket,
      ticketUrl: ticket ? this.resolveTicketUrl(ticket) : null,
      links: JSON.parse(r.links as string) as Link[],
      agent: (r.agent as string | null) ?? null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  }

  /** Active groups (archived ones are kept for export but hidden). */
  listGroups(): Group[] {
    return (this.db.prepare('SELECT * FROM groups WHERE archived_at IS NULL ORDER BY name').all() as Row[]).map((r) =>
      this.groupFromRow(r),
    );
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
  private writeGroup(id: string, patch: GroupPatch, actor: string | null, at: string): boolean {
    const restored =
      this.db.prepare('UPDATE groups SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL').run(id).changes > 0;
    const existing = this.getGroup(id);
    if (!existing) {
      this.db
        .prepare('INSERT INTO groups (id, name, ticket, links, agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, patch.name ?? id, patch.ticket ?? null, JSON.stringify(patch.links ?? []), actor, at, at);
      return false;
    }
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

  upsertGroup(id: string, patch: GroupPatch, actor: string | null): Group {
    const { group, restored } = this.tx(() => {
      const restored = this.writeGroup(id, patch, actor, this.now().toISOString());
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
      if (res.changes === 0) throw new NotFoundError(`Group "${id}" not found`);
      for (const laneId of affected) this.addEvent(laneId, at, 'status', `Group "${id}" removed`, actor);
      return affected.map((laneId) => this.requireLane(laneId));
    });
    this.emit({ type: 'group_deleted', id });
    for (const lane of lanes) this.emit({ type: 'lane', lane });
  }

  // ---- lanes -------------------------------------------------------------

  private laneFromRow(r: Row): Lane {
    const ticket = (r.ticket as string | null) ?? null;
    return {
      id: r.id as string,
      letter: r.letter_index == null ? null : letterOf(Number(r.letter_index)),
      name: r.name as string,
      // A lane in an archived group shows as ungrouped; the raw group_id is kept for exports.
      group: r.group_archived ? null : ((r.group_id as string | null) ?? null),
      status: r.status as LaneStatus,
      ticket,
      ticketUrl: ticket ? this.resolveTicketUrl(ticket) : null,
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
    };
  }

  private static LANE_SELECT = `
    SELECT l.*,
      (SELECT COUNT(*) FROM escalations e WHERE e.lane_id = l.id AND e.state = 'open') AS open_escalations,
      (SELECT COUNT(*) FROM escalations e WHERE e.lane_id = l.id AND e.state = 'open' AND e.blocking = 1) AS open_blocking,
      (SELECT g.archived_at IS NOT NULL FROM groups g WHERE g.id = l.group_id) AS group_archived
    FROM lanes l`;

  /** Active lanes (archived ones are kept for export but hidden). */
  listLanes(): Lane[] {
    return (
      this.db.prepare(`${Store.LANE_SELECT} WHERE l.archived_at IS NULL ORDER BY l.updated_at DESC`).all() as Row[]
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

  /** Must run inside a transaction: publishing to an archived lane brings it back, history intact. */
  private restoreLane(id: string, actor: string | null, at: string) {
    const res = this.db.prepare('UPDATE lanes SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL').run(id);
    if (res.changes > 0) this.addEvent(id, at, 'status', 'Lane restored', actor);
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
        (this.db.prepare('SELECT letter_index FROM lanes WHERE letter_index IS NOT NULL').all() as Row[]).map((x) =>
          Number(x.letter_index),
        ),
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
    if (!lane) throw new NotFoundError(`Lane "${id}" not found`);
    return lane;
  }

  upsertLane(id: string, patch: LanePatch, actor: string | null): Lane {
    if (patch.status && !LANE_STATUSES.includes(patch.status)) throw new Error(`Invalid status "${patch.status}"`);
    let createdGroup: Group | null = null;
    let groupRestored = false;
    let previous: LaneStatus | null = null;
    const lane = this.tx(() => {
      const at = this.now().toISOString();
      this.restoreLane(id, actor, at);
      previous = this.getLane(id)?.status ?? null;
      if (patch.group && !this.getGroup(patch.group)) {
        groupRestored = this.writeGroup(patch.group, {}, actor, at);
        createdGroup = this.getGroup(patch.group);
      }
      const existing = this.getLane(id);
      if (!existing) {
        const status = patch.status ?? 'active';
        this.db
          .prepare(
            `INSERT INTO lanes (id, name, group_id, status, ticket, activity, links, agent, created_at, updated_at, status_since, blocked_since)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            patch.name ?? id,
            patch.group ?? null,
            status,
            patch.ticket ?? null,
            patch.activity ?? null,
            JSON.stringify(patch.links ?? []),
            actor,
            at,
            at,
            at,
            status === 'blocked_human' ? at : null,
          );
        this.addEvent(id, at, 'status', `Lane created (${status})`, actor);
        if (patch.activity) this.addEvent(id, at, 'activity', patch.activity, actor);
      } else {
        this.applyLaneUpdate(existing, patch, actor, at);
      }
      this.syncLetter(id);
      return this.requireLane(id);
    });
    if (createdGroup) this.emit({ type: 'group', group: createdGroup });
    if (groupRestored && patch.group) this.emitGroupLanes(patch.group, id);
    this.emit({ type: 'lane', lane, statusChanged: previous !== lane.status });
    return lane;
  }

  /** Must run inside a transaction. */
  private applyLaneUpdate(existing: Lane, patch: LanePatch, actor: string | null, at: string) {
    const status = patch.status ?? existing.status;
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
   * Archives the lane: it leaves the dashboard, its unresolved escalations are
   * withdrawn, and everything stays in the database for export. Publishing to
   * the same lane id later restores it.
   */
  deleteLane(id: string, actor: string | null = null) {
    const withdrawn = this.tx(() => {
      const lane = this.getLane(id);
      if (!lane) throw new NotFoundError(`Lane "${id}" not found`);
      const at = this.now().toISOString();
      // Only unanswered questions are withdrawn. Decided ones keep their answer and
      // can still be acknowledged by an agent that's acting on it.
      const pending = this.listEscalations({ laneId: id, states: ['open'] }).map((e) => e.id);
      const resolution = `Lane removed${actor ? ` by ${actor}` : ''}`;
      this.db
        .prepare(
          `UPDATE escalations SET state = 'withdrawn', resolution = COALESCE(resolution, ?), withdrawn_by = ?, updated_at = ?
           WHERE lane_id = ? AND state = 'open'`,
        )
        .run(resolution, actor ?? '', at, id);
      for (let i = 0; i < pending.length; i++) this.addEvent(id, at, 'escalation', `Escalation closed: ${resolution}`, actor);
      // End any blocked spell now, so archived time isn't counted as blocked.
      if (lane.status === 'blocked_human') this.applyLaneUpdate(lane, { status: 'idle' }, actor, at);
      this.db.prepare('UPDATE lanes SET archived_at = ?, updated_at = ? WHERE id = ?').run(at, at, id);
      this.addEvent(id, at, 'status', 'Lane removed', actor);
      this.syncLetter(id);
      return pending.map((eid) => this.requireEscalation(eid));
    });
    for (const escalation of withdrawn) this.emit({ type: 'escalation', escalation });
    this.emit({ type: 'lane_deleted', id });
  }

  private addEvent(laneId: string, at: string, kind: LaneEvent['kind'], message: string, actor: string | null) {
    this.db
      .prepare('INSERT INTO lane_events (lane_id, at, kind, message, actor) VALUES (?, ?, ?, ?, ?)')
      .run(laneId, at, kind, message, actor);
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

  laneEvents(laneId: string, limit = 50): LaneEvent[] {
    return (
      this.db
        .prepare('SELECT * FROM lane_events WHERE lane_id = ? ORDER BY id DESC LIMIT ?')
        .all(laneId, limit) as Row[]
    ).map((r) => ({
      id: Number(r.id),
      laneId: r.lane_id as string,
      at: r.at as string,
      kind: r.kind as LaneEvent['kind'],
      message: r.message as string,
      actor: (r.actor as string | null) ?? null,
    }));
  }

  // ---- escalations -------------------------------------------------------

  private escalationFromRow(r: Row): Escalation {
    return {
      id: r.id as string,
      ref: r.letter_index == null ? String(r.ref) : `${letterOf(Number(r.letter_index))}${Number(r.seq)}`,
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
  listEscalations(filter: { states?: EscalationState[]; laneId?: string; limit?: number } = {}): Escalation[] {
    const states = filter.states ?? ['open', 'decided'];
    const where = [`state IN (${states.map(() => '?').join(',')})`];
    const params: string[] = [...states];
    if (filter.laneId) {
      where.push('lane_id = ?');
      params.push(filter.laneId);
    }
    return (
      this.db
        .prepare(`SELECT * FROM escalations WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
        .all(...params, filter.limit ?? 1000) as Row[]
    )
      .reverse()
      .map((r) => this.escalationFromRow(r));
  }

  /**
   * By id, or by its code: "A12" (case-insensitive, an optional leading # is ignored).
   * Plain numbers ("42", "#42") are the global numbers used before lane codes, still accepted.
   */
  getEscalation(id: string): Escalation | null {
    const code = /^#?([A-Za-z]{1,4})(\d{1,9})$/.exec(id.trim());
    const legacy = /^#?(\d{1,15})$/.exec(id.trim());
    const r = (
      code
        ? this.db
            .prepare('SELECT * FROM escalations WHERE letter_index = ? AND seq = ?')
            .get(indexOfLetter(code[1]), Number(code[2]))
        : legacy
          ? this.db.prepare('SELECT * FROM escalations WHERE ref = ?').get(Number(legacy[1]))
          : this.db.prepare('SELECT * FROM escalations WHERE id = ?').get(id)
    ) as Row | undefined;
    return r ? this.escalationFromRow(r) : null;
  }

  private requireEscalation(id: string): Escalation {
    const e = this.getEscalation(id);
    if (!e) throw new NotFoundError(`Escalation "${id}" not found`);
    return e;
  }

  /**
   * Raising the same question again on the same lane while the first is still
   * open (e.g. a retried call) returns the existing escalation with
   * `duplicate: true` instead of creating a second one.
   */
  createEscalation(input: EscalationInput, actor: string): Escalation & { duplicate?: boolean } {
    const existing = this.db
      .prepare("SELECT id FROM escalations WHERE lane_id = ? AND question = ? AND created_by = ? AND state = 'open'")
      .get(input.laneId, input.question, actor) as Row | undefined;
    if (existing) return { ...this.requireEscalation(existing.id as string), duplicate: true };
    const { escalation, lane, blocks } = this.tx(() => {
      const at = this.now().toISOString();
      this.restoreLane(input.laneId, actor, at);
      let lane = this.getLane(input.laneId);
      if (!lane) {
        // Agents may escalate before ever publishing lane state.
        this.db
          .prepare(
            `INSERT INTO lanes (id, name, status, agent, created_at, updated_at, status_since) VALUES (?, ?, 'active', ?, ?, ?, ?)`,
          )
          .run(input.laneId, input.laneId, actor, at, at, at);
        lane = this.requireLane(input.laneId);
      }
      const id = randomUUID();
      const ref = Number((this.db.prepare('SELECT COALESCE(MAX(ref), 0) + 1 AS n FROM escalations').get() as Row).n);
      this.syncLetter(input.laneId, true);
      const letterIndex = Number((this.db.prepare('SELECT letter_index FROM lanes WHERE id = ?').get(input.laneId) as Row).letter_index);
      const seq = Number(
        (this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM escalations WHERE letter_index = ?').get(letterIndex) as Row).n,
      );
      const code = `${letterOf(letterIndex)}${seq}`;
      this.db
        .prepare(
          `INSERT INTO escalations (id, ref, letter_index, seq, lane_id, question, context, recommendation, recommended_option, cost,
             alternatives, ticket, positions, options, links, blocking, state, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
        )
        .run(
          id,
          ref,
          letterIndex,
          seq,
          input.laneId,
          input.question,
          input.context ?? null,
          input.recommendation ?? null,
          input.recommendedOption ?? null,
          input.cost ?? null,
          JSON.stringify(input.alternatives ?? []),
          input.ticket ?? null,
          JSON.stringify(
            (input.positions ?? []).map((p) => ({ agent: p.agent, stance: p.stance, note: p.note ?? null, at })),
          ),
          JSON.stringify(input.options ?? []),
          JSON.stringify(input.links ?? []),
          input.blocking === false ? 0 : 1,
          actor,
          at,
          at,
        );
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
   * Records the human answer. With `change`, replaces the answer on an
   * escalation that's decided but not yet acknowledged (a mis-tap); without
   * it, a second decision is a conflict, so two people can't overwrite each other.
   */
  decideEscalation(id: string, decision: string, note: string | null, by: string, change = false): Escalation {
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
    const escalation = close();
    // Only for lanes still on the dashboard: publishing would otherwise restore a removed lane.
    if (lane && (lane.status || lane.activity !== undefined) && this.getLane(escalation.laneId)) {
      this.upsertLane(escalation.laneId, lane, actor);
    }
    return escalation;
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

  private openBlockingCount(laneId: string) {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM escalations WHERE lane_id = ? AND state = 'open' AND blocking = 1")
      .get(laneId) as Row;
    return Number(r.n);
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
      this.addEvent(current.laneId, at, 'escalation', message, actor);
      // A finished lane gives its letter back once nothing is left for anyone to answer or pick up.
      this.syncLetter(current.laneId);
      const found = this.laneIncludingArchived(current.laneId);
      if (!found) throw new NotFoundError(`Lane "${current.laneId}" not found`);
      const { lane, archived } = found;
      const unblocked =
        !archived &&
        mayUnblock &&
        current.state === 'open' &&
        current.blocking &&
        lane.status === 'blocked_human' &&
        this.openBlockingCount(lane.id) === 0;
      if (unblocked) this.applyLaneUpdate(lane, { status: 'awaiting_agent' }, null, at);
      return { escalation: this.requireEscalation(current.id), lane: archived ? null : this.requireLane(current.laneId), unblocked };
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
    if (current.state !== 'open' || timeoutMs <= 0) return Promise.resolve(current);
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
        if (e.type === 'escalation' && e.escalation.id === id && e.escalation.state !== 'open') done();
        if (e.type === 'lane_deleted' && e.id === current.laneId) done();
      };
      const timer = setTimeout(done, timeoutMs);
      this.events.on('change', onChange);
      signal?.addEventListener('abort', done);
    });
  }

  /** Where things stand for a wait scope right now. Unknown groups and lanes are errors (likely typos). */
  decisionsFor(scope: WaitScope): WaitResult {
    const checkedAt = this.now().toISOString();
    const named = (scope.ids ?? []).map((id) => this.requireEscalation(id));
    const byId = new Map<string, Escalation>(named.map((e) => [e.id, e]));
    const laneIds = new Set<string>();
    for (const id of scope.laneIds ?? []) {
      if (!this.db.prepare('SELECT 1 FROM lanes WHERE id = ?').get(id)) throw new NotFoundError(`Lane "${id}" not found`);
      laneIds.add(id);
    }
    if (scope.groupId) {
      if (!this.db.prepare('SELECT 1 FROM groups WHERE id = ?').get(scope.groupId)) {
        throw new NotFoundError(`Group "${scope.groupId}" not found`);
      }
      const rows = this.db.prepare('SELECT id FROM lanes WHERE group_id = ?').all(scope.groupId) as Row[];
      for (const r of rows) laneIds.add(r.id as string);
    }
    const closedById = new Map<string, Escalation>();
    for (const e of named) if (e.state === 'acknowledged' || e.state === 'withdrawn') closedById.set(e.id, e);
    const removedLanes: WaitResult['removedLanes'] = [];
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
    // Creation order; the internal global number breaks ties within a millisecond.
    const seqOf = (e: Escalation) => Number((this.db.prepare('SELECT ref FROM escalations WHERE id = ?').get(e.id) as Row).ref);
    const byAge = (a: Escalation, b: Escalation) => a.createdAt.localeCompare(b.createdAt) || seqOf(a) - seqOf(b);
    const all = [...byId.values()].sort(byAge);
    const decided = all.filter((e) => e.state === 'decided');
    const closed = [...closedById.values()].sort(byAge);
    const open = all
      .filter((e) => e.state === 'open')
      .map((e) => ({ id: e.id, ref: e.ref, laneId: e.laneId, question: e.question }));
    return {
      ready: decided.length > 0 || closed.length > 0 || removedLanes.length > 0 || open.length === 0,
      decided,
      closed,
      open,
      removedLanes,
      checkedAt,
    };
  }

  /**
   * Waits until anything in scope needs the agent: an escalation was decided
   * (and isn't acknowledged yet), one was closed by someone else, or nothing
   * is left open. Returns at once if that's already so. While it waits, the
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
        if (e.type !== 'escalation' && e.type !== 'lane_deleted') return;
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
    const where = (ridCol: string, laneCol: string, timeCol?: string) => {
      const parts = [`${ridCol} > ?`];
      const params: (string | number)[] = [after];
      if (timeCol && filter.from) (parts.push(`${timeCol} >= ?`), params.push(filter.from));
      if (timeCol && filter.to) (parts.push(`${timeCol} < ?`), params.push(filter.to));
      if (filter.laneId) (parts.push(`${laneCol} = ?`), params.push(filter.laneId));
      return { sql: `WHERE ${parts.join(' AND ')} ORDER BY ${ridCol} LIMIT ?`, params: [...params, limit] };
    };

    if (dataset === 'requirements') {
      const parts = ['num > ?'];
      const params: (string | number)[] = [after];
      if (filter.from) (parts.push('created_at >= ?'), params.push(filter.from));
      if (filter.to) (parts.push('created_at < ?'), params.push(filter.to));
      const raw = this.db
        .prepare(`SELECT num AS _rid, * FROM requirements WHERE ${parts.join(' AND ')} ORDER BY num LIMIT ?`)
        .all(...params, limit) as Row[];
      return page(raw, (r) => {
        const req = this.requirementFromRow(r);
        return {
          id: req.id,
          group_id: req.group,
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
      const raw = this.db
        .prepare('SELECT rowid AS _rid, * FROM groups WHERE rowid > ? ORDER BY rowid LIMIT ?')
        .all(after, limit) as Row[];
      return page(raw, (r) => ({
        id: r.id,
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
        id: r.id,
        name: r.name,
        group_id: r.group_id,
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
      }));
    }

    if (dataset === 'events') {
      const w = where('id', 'lane_id', 'at');
      const raw = this.db.prepare(`SELECT id AS _rid, * FROM lane_events ${w.sql}`).all(...w.params) as Row[];
      return page(raw, (r) => ({
        id: r.id,
        lane_id: r.lane_id,
        at: r.at,
        kind: r.kind,
        message: r.message,
        actor: r.actor,
      }));
    }

    if (dataset === 'positions') {
      // Filtered by when each position was taken; only the columns needed are read.
      const w = where('rowid', 'lane_id');
      const raw = this.db
        .prepare(`SELECT rowid AS _rid, id, ref, letter_index, seq, lane_id, question, positions FROM escalations ${w.sql}`)
        .all(...w.params) as Row[];
      return page(raw, (e) =>
        (JSON.parse(e.positions as string) as Position[])
          .filter((p) => (!filter.from || p.at >= filter.from) && (!filter.to || p.at < filter.to))
          .map((p) => ({
            escalation_id: e.id,
            escalation_ref: this.codeOf(e),
            lane_id: e.lane_id,
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
        lane_id: e.lane_id,
        lane_name: e.lane_name,
        group_id: e.group_id,
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
      };
    });
  }

  private codeOf(r: Row) {
    return r.letter_index == null ? String(r.ref) : `${letterOf(Number(r.letter_index))}${Number(r.seq)}`;
  }

  // ---- requirements ----------------------------------------------------------

  private requirementFromRow(r: Row): Requirement {
    const source = r.source_escalation_id ? this.getEscalation(r.source_escalation_id as string) : null;
    return {
      id: `R${Number(r.num)}`,
      group: (r.group_id as string | null) ?? null,
      requirement: r.requirement as string,
      justification: r.justification as string,
      tags: JSON.parse(r.tags as string) as string[],
      status: r.status as RequirementStatus,
      supersededBy: r.superseded_by == null ? null : `R${Number(r.superseded_by)}`,
      decidedBy: r.decided_by as string,
      sourceEscalation: source?.ref ?? null,
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
   * `includeProductWide` is false). Active only unless `statuses` says otherwise.
   */
  findRequirements(filter: {
    query?: string;
    tags?: string[];
    group?: string;
    includeProductWide?: boolean;
    statuses?: RequirementStatus[];
    limit?: number;
  } = {}): Requirement[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    const statuses = filter.statuses ?? ['active'];
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
      return one ? [one] : [];
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
    return rows.map((r) => this.requirementFromRow(r));
  }

  /** Tags in use on active requirements, most used first. */
  requirementTags(group?: string): { tag: string; count: number }[] {
    const rows = this.db
      .prepare(
        `SELECT j.value AS tag, COUNT(*) AS n FROM requirements r, json_each(r.tags) j
         WHERE r.status = 'active' ${group !== undefined ? 'AND (r.group_id = ? OR r.group_id IS NULL)' : ''}
         GROUP BY j.value ORDER BY n DESC, j.value`,
      )
      .all(...(group !== undefined ? [group] : [])) as Row[];
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
  ): { decidedBy: string; escalationId: string | null } {
    if (input.sourceEscalation && input.decidedBy) {
      throw new ValidationError('Give either source_escalation or decided_by, not both: the escalation names its decider.');
    }
    if (input.sourceEscalation) {
      const esc = this.requireEscalation(input.sourceEscalation);
      if (!esc.decidedBy || (esc.state !== 'decided' && esc.state !== 'acknowledged')) {
        throw new ConflictError(`Escalation ${esc.ref} hasn't been decided by a person, so it can't be the source`);
      }
      const laneGroup = (this.db.prepare('SELECT group_id FROM lanes WHERE id = ?').get(esc.laneId) as Row | undefined)?.group_id;
      const related = esc.createdBy === actor || (input.group != null && laneGroup === input.group);
      if (!actorIsHuman && !related) {
        throw new ConflictError(
          `Escalation ${esc.ref} was raised by ${esc.createdBy} in another ${laneGroup ? `group (${laneGroup})` : 'context'}; ` +
            'cite an escalation you raised or one from this group, or name who decided with decided_by.',
        );
      }
      return { decidedBy: esc.decidedBy, escalationId: esc.id };
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
         WHERE r.status = 'active' AND r.num <> ? AND (r.group_id IS ? OR r.group_id IS NULL OR ? IS NULL)
         ORDER BY best.score LIMIT 3`,
      )
      .all(...match.params, this.requirementNum(req.id)!, req.group, req.group) as Row[];
    return rows.map((r) => this.requirementFromRow(r));
  }

  private tagWarnings(tags: string[]): string[] {
    const total = Number((this.db.prepare("SELECT COUNT(*) AS n FROM requirements WHERE status = 'active'").get() as Row).n);
    if (total < 10) return [];
    const counts = new Map(this.requirementTags().map((t) => [t.tag, t.count]));
    return tags
      .filter((t) => (counts.get(t) ?? 0) / total > 0.4)
      .map((t) => `Tag "${t}" is on ${counts.get(t)} of ${total} active requirements; a narrower tag would find this faster.`);
  }

  /** Must run inside a transaction. */
  private insertRequirement(input: RequirementInput, actor: string, actorIsHuman: boolean, at: string): number {
    if (input.group && !this.getGroup(input.group)) throw new NotFoundError(`Group "${input.group}" not found`);
    const tags = this.cleanTags(input.tags);
    const { decidedBy, escalationId } = this.decisionSource(input, actor, actorIsHuman);
    const res = this.db
      .prepare(
        `INSERT INTO requirements (group_id, requirement, justification, tags, status, decided_by, source_escalation_id,
           recorded_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      )
      .run(input.group ?? null, input.requirement.trim(), input.justification.trim(), JSON.stringify(tags), decidedBy, escalationId, actor, at, at);
    return Number(res.lastInsertRowid);
  }

  /** Records an owner decision. Returns it with similar active requirements, so duplicates get noticed. */
  recordRequirement(input: RequirementInput, actor: string, actorIsHuman = false): RecordResult {
    const requirement = this.tx(() => {
      const num = this.insertRequirement(input, actor, actorIsHuman, this.now().toISOString());
      return this.requireRequirement(String(num));
    });
    this.emit({ type: 'requirement', requirement });
    return { requirement, similar: this.similarTo(requirement), warnings: this.tagWarnings(requirement.tags) };
  }

  /**
   * Replaces an active requirement with a new one (the owner changed direction).
   * The old one stays, marked superseded, so the history of why is kept. Group
   * defaults to the old one's.
   */
  supersedeRequirement(id: string, input: RequirementInput, actor: string, actorIsHuman = false): RecordResult {
    const { requirement, old } = this.tx(() => {
      const current = this.requireRequirement(id);
      if (current.status !== 'active') throw new ConflictError(`${current.id} is ${current.status}; only active requirements can be superseded`);
      const at = this.now().toISOString();
      const num = this.insertRequirement(
        { ...input, group: input.group === undefined ? current.group : input.group },
        actor,
        actorIsHuman,
        at,
      );
      this.db
        .prepare("UPDATE requirements SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE num = ?")
        .run(num, at, this.requirementNum(current.id)!);
      return { requirement: this.requireRequirement(String(num)), old: this.requireRequirement(current.id) };
    });
    this.emit({ type: 'requirement', requirement: old });
    this.emit({ type: 'requirement', requirement });
    return { requirement, similar: this.similarTo(requirement).filter((r) => r.id !== old.id), warnings: this.tagWarnings(requirement.tags) };
  }

  /** Corrections that keep the meaning (wording, tags). Changing the decision is a supersede. */
  editRequirement(id: string, patch: { requirement?: string; justification?: string; tags?: string[] }): Requirement {
    const requirement = this.tx(() => {
      const current = this.requireRequirement(id);
      if (current.status !== 'active') throw new ConflictError(`${current.id} is ${current.status}; only active requirements can be edited`);
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

  /** Withdraws a requirement with no replacement (the decision no longer applies). */
  retireRequirement(id: string): Requirement {
    const requirement = this.tx(() => {
      const current = this.requireRequirement(id);
      if (current.status !== 'active') throw new ConflictError(`${current.id} is already ${current.status}`);
      this.db
        .prepare("UPDATE requirements SET status = 'retired', updated_at = ? WHERE num = ?")
        .run(this.now().toISOString(), this.requirementNum(current.id)!);
      return this.requireRequirement(current.id);
    });
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

  listPushTokens(): { token: string; platform: string; owner: string; userId: string | null }[] {
    return this.db.prepare('SELECT token, platform, owner, user_id AS userId FROM push_tokens').all() as {
      token: string;
      platform: string;
      owner: string;
      userId: string | null;
    }[];
  }
}
