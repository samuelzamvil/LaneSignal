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
  type Stance,
  type StreamEvent,
} from './types.ts';

export class NotFoundError extends Error {}

const MAX_POSITIONS = 20;
export class ConflictError extends Error {}

export const EXPORT_DATASETS = ['escalations', 'positions', 'lanes', 'groups', 'events'] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];

/** Fixed column order per dataset, so a CSV's header never depends on whether it has rows. */
export const EXPORT_COLUMNS: Record<ExportDataset, readonly string[]> = {
  escalations: [
    'id', 'lane_id', 'lane_name', 'group_id', 'group_name', 'ticket', 'ticket_url', 'question', 'context',
    'recommendation', 'recommended_option', 'cost', 'alternatives', 'options', 'blocking', 'state', 'created_by',
    'created_at', 'decided_by', 'decided_at', 'decision', 'decision_note', 'followed_recommendation',
    'acknowledged_at', 'resolution', 'closed_at', 'seconds_to_decision', 'seconds_to_acknowledge', 'seconds_open',
    'positions_agree', 'positions_disagree', 'positions_neutral', 'links',
  ],
  positions: ['escalation_id', 'lane_id', 'question', 'agent', 'stance', 'note', 'at'],
  lanes: [
    'id', 'name', 'group_id', 'group_name', 'status', 'ticket', 'ticket_url', 'activity', 'last_published_by',
    'created_at', 'updated_at', 'status_since', 'blocked_seconds_total', 'blocked_since', 'escalations_total',
    'escalations_open', 'links', 'archived_at',
  ],
  groups: ['id', 'name', 'ticket', 'ticket_url', 'links', 'last_published_by', 'created_at', 'updated_at', 'archived_at'],
  events: ['id', 'lane_id', 'at', 'kind', 'message', 'actor'],
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
}

const SCHEMA_VERSION = 4;

type Row = Record<string, unknown>;

/**
 * SQLite-backed store. Every mutation emits a StreamEvent on `events`, which
 * feeds SSE clients, long-polling agents, and push notifications.
 */
export class Store {
  readonly events = new EventEmitter<{ change: [StreamEvent] }>();
  private db: DatabaseSync;
  private resolveTicketUrl: (ticket: string) => string | null;
  private retention: number;
  private now: () => Date;

  constructor(opts: StoreOptions) {
    this.db = new DatabaseSync(opts.path);
    this.resolveTicketUrl = opts.resolveTicketUrl;
    this.retention = opts.eventRetention ?? 200;
    this.now = opts.now ?? (() => new Date());
    this.events.setMaxListeners(0);
    this.migrate();
  }

  close() {
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
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(SCHEMA_VERSION));
    });
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
          `UPDATE escalations SET state = 'withdrawn', resolution = COALESCE(resolution, ?), updated_at = ?
           WHERE lane_id = ? AND state = 'open'`,
        )
        .run(resolution, at, id);
      for (let i = 0; i < pending.length; i++) this.addEvent(id, at, 'escalation', `Escalation closed: ${resolution}`, actor);
      // End any blocked spell now, so archived time isn't counted as blocked.
      if (lane.status === 'blocked_human') this.applyLaneUpdate(lane, { status: 'idle' }, actor, at);
      this.db.prepare('UPDATE lanes SET archived_at = ?, updated_at = ? WHERE id = ?').run(at, at, id);
      this.addEvent(id, at, 'status', 'Lane removed', actor);
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

  getEscalation(id: string): Escalation | null {
    const r = this.db.prepare('SELECT * FROM escalations WHERE id = ?').get(id) as Row | undefined;
    return r ? this.escalationFromRow(r) : null;
  }

  private requireEscalation(id: string): Escalation {
    const e = this.getEscalation(id);
    if (!e) throw new NotFoundError(`Escalation "${id}" not found`);
    return e;
  }

  createEscalation(input: EscalationInput, actor: string): Escalation {
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
      this.db
        .prepare(
          `INSERT INTO escalations (id, lane_id, question, context, recommendation, recommended_option, cost,
             alternatives, ticket, positions, options, links, blocking, state, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
        )
        .run(
          id,
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
      this.addEvent(input.laneId, at, 'escalation', `Escalated: ${input.question}`, actor);
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

  decideEscalation(id: string, decision: string, note: string | null, by: string): Escalation {
    return this.closeHumanStep(
      id,
      ['open'],
      (at) => {
        this.db
          .prepare(
            `UPDATE escalations SET state = 'decided', decision = ?, decision_note = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?`,
          )
          .run(decision, note, by, at, at, id);
        return `Decided by ${by}: ${decision}`;
      },
      by,
      true,
    );
  }

  /** Acknowledging never changes lane status: the agent publishes what it does next. */
  acknowledgeEscalation(id: string, note: string | null, actor: string): Escalation {
    return this.closeHumanStep(
      id,
      ['decided'],
      (at) => {
        this.db
          .prepare(
            `UPDATE escalations SET state = 'acknowledged', acknowledged_at = ?, resolution = COALESCE(?, resolution), updated_at = ? WHERE id = ?`,
          )
          .run(at, note, at, id);
        return 'Decision acknowledged';
      },
      actor,
      false,
    );
  }

  /** Agent (or human) closes an escalation without a dashboard decision, e.g. it was answered in Remote Control. */
  withdrawEscalation(id: string, resolution: string | null, actor: string): Escalation {
    return this.closeHumanStep(
      id,
      ['open', 'decided'],
      (at) => {
        this.db
          .prepare(`UPDATE escalations SET state = 'withdrawn', resolution = ?, updated_at = ? WHERE id = ?`)
          .run(resolution, at, id);
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
    apply: (at: string) => string,
    actor: string,
    mayUnblock: boolean,
  ): Escalation {
    const { escalation, lane, unblocked } = this.tx(() => {
      const current = this.requireEscalation(id);
      if (!from.includes(current.state)) {
        throw new ConflictError(`Escalation is ${current.state}; expected ${from.join(' or ')}`);
      }
      const at = this.now().toISOString();
      const message = apply(at);
      this.addEvent(current.laneId, at, 'escalation', message, actor);
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
      return { escalation: this.requireEscalation(id), lane: archived ? null : this.requireLane(current.laneId), unblocked };
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
      if (current.state !== 'open') throw new ConflictError(`Escalation is ${current.state}; positions close once decided`);
      const at = this.now().toISOString();
      const positions = current.positions.filter((p) => p.agent !== position.agent);
      if (positions.length >= MAX_POSITIONS) throw new ConflictError(`At most ${MAX_POSITIONS} agents can take a position`);
      positions.push({ agent: position.agent, stance: position.stance, note: position.note ?? null, at });
      this.db
        .prepare('UPDATE escalations SET positions = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(positions), at, id);
      const verb = { agree: 'agrees', disagree: 'disagrees', neutral: 'is neutral' }[position.stance];
      this.addEvent(current.laneId, at, 'escalation', `${position.agent} ${verb}${position.note ? `: ${position.note}` : ''}`, actor);
      return this.requireEscalation(id);
    });
    this.emit({ type: 'escalation', escalation });
    return escalation;
  }

  /** Resolves when the escalation leaves `open`, or with the current value on timeout. */
  waitForDecision(id: string, timeoutMs: number, signal?: AbortSignal): Promise<Escalation> {
    const current = this.requireEscalation(id);
    if (current.state !== 'open' || timeoutMs <= 0) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.events.off('change', onChange);
        signal?.removeEventListener('abort', done);
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
        .prepare(`SELECT rowid AS _rid, id, lane_id, question, positions FROM escalations ${w.sql}`)
        .all(...w.params) as Row[];
      return page(raw, (e) =>
        (JSON.parse(e.positions as string) as Position[])
          .filter((p) => (!filter.from || p.at >= filter.from) && (!filter.to || p.at < filter.to))
          .map((p) => ({
            escalation_id: e.id,
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

  // ---- push tokens -------------------------------------------------------

  addPushToken(token: string, platform: string, owner: string) {
    this.db
      .prepare(
        `INSERT INTO push_tokens (token, platform, owner, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(token) DO UPDATE SET owner = excluded.owner, platform = excluded.platform`,
      )
      .run(token, platform, owner, this.now().toISOString());
  }

  removePushToken(token: string) {
    this.db.prepare('DELETE FROM push_tokens WHERE token = ?').run(token);
  }

  listPushTokens(): { token: string; platform: string; owner: string }[] {
    return this.db.prepare('SELECT token, platform, owner FROM push_tokens').all() as {
      token: string;
      platform: string;
      owner: string;
    }[];
  }
}
