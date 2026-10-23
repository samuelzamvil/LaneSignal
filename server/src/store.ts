import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import {
  LANE_STATUSES,
  type Escalation,
  type EscalationState,
  type Lane,
  type LaneEvent,
  type LaneStatus,
  type Link,
  type Position,
  type Stance,
  type StreamEvent,
} from './types.ts';

export class NotFoundError extends Error {}
export class ConflictError extends Error {}

export interface LanePatch {
  name?: string;
  category?: string | null;
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

const SCHEMA_VERSION = 1;

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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lanes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT,
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
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(SCHEMA_VERSION));
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

  // ---- lanes -------------------------------------------------------------

  private laneFromRow(r: Row): Lane {
    const ticket = (r.ticket as string | null) ?? null;
    return {
      id: r.id as string,
      name: r.name as string,
      category: (r.category as string | null) ?? null,
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
    SELECT l.*, (SELECT COUNT(*) FROM escalations e WHERE e.lane_id = l.id AND e.state = 'open') AS open_escalations
    FROM lanes l`;

  listLanes(): Lane[] {
    return (this.db.prepare(`${Store.LANE_SELECT} ORDER BY l.updated_at DESC`).all() as Row[]).map((r) =>
      this.laneFromRow(r),
    );
  }

  getLane(id: string): Lane | null {
    const r = this.db.prepare(`${Store.LANE_SELECT} WHERE l.id = ?`).get(id) as Row | undefined;
    return r ? this.laneFromRow(r) : null;
  }

  private requireLane(id: string): Lane {
    const lane = this.getLane(id);
    if (!lane) throw new NotFoundError(`Lane "${id}" not found`);
    return lane;
  }

  upsertLane(id: string, patch: LanePatch, actor: string | null): Lane {
    if (patch.status && !LANE_STATUSES.includes(patch.status)) throw new Error(`Invalid status "${patch.status}"`);
    const lane = this.tx(() => {
      const at = this.now().toISOString();
      const existing = this.getLane(id);
      if (!existing) {
        const status = patch.status ?? 'active';
        this.db
          .prepare(
            `INSERT INTO lanes (id, name, category, status, ticket, activity, links, agent, created_at, updated_at, status_since, blocked_since)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            patch.name ?? id,
            patch.category ?? null,
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
    this.emit({ type: 'lane', lane });
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
        `UPDATE lanes SET name = ?, category = ?, status = ?, ticket = ?, activity = ?, links = ?, agent = ?,
           updated_at = ?, status_since = ?, blocked_since = ?, blocked_total_ms = ? WHERE id = ?`,
      )
      .run(
        patch.name ?? existing.name,
        patch.category !== undefined ? patch.category : existing.category,
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

  deleteLane(id: string) {
    const res = this.db.prepare('DELETE FROM lanes WHERE id = ?').run(id);
    if (res.changes === 0) throw new NotFoundError(`Lane "${id}" not found`);
    this.emit({ type: 'lane_deleted', id });
  }

  private addEvent(laneId: string, at: string, kind: LaneEvent['kind'], message: string, actor: string | null) {
    this.db
      .prepare('INSERT INTO lane_events (lane_id, at, kind, message, actor) VALUES (?, ?, ?, ?, ?)')
      .run(laneId, at, kind, message, actor);
    this.db
      .prepare(
        `DELETE FROM lane_events WHERE lane_id = ? AND id NOT IN
           (SELECT id FROM lane_events WHERE lane_id = ? ORDER BY id DESC LIMIT ?)`,
      )
      .run(laneId, laneId, this.retention);
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
      positions: JSON.parse(r.positions as string) as Position[],
      options: JSON.parse(r.options as string) as string[],
      links: JSON.parse(r.links as string) as Link[],
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

  /** Default: everything not yet closed (open + decided-but-unacknowledged). */
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
        .prepare(`SELECT * FROM escalations WHERE ${where.join(' AND ')} ORDER BY created_at ASC LIMIT ?`)
        .all(...params, filter.limit ?? 500) as Row[]
    ).map((r) => this.escalationFromRow(r));
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
    const { escalation, lane } = this.tx(() => {
      const at = this.now().toISOString();
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
          `INSERT INTO escalations (id, lane_id, question, context, recommendation, recommended_option, positions,
             options, links, state, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
        )
        .run(
          id,
          input.laneId,
          input.question,
          input.context ?? null,
          input.recommendation ?? null,
          input.recommendedOption ?? null,
          JSON.stringify(
            (input.positions ?? []).map((p) => ({ agent: p.agent, stance: p.stance, note: p.note ?? null, at })),
          ),
          JSON.stringify(input.options ?? []),
          JSON.stringify(input.links ?? []),
          actor,
          at,
          at,
        );
      this.addEvent(input.laneId, at, 'escalation', `Escalated: ${input.question}`, actor);
      if (input.blocking !== false && lane.status !== 'blocked_human') {
        this.applyLaneUpdate(lane, { status: 'blocked_human' }, actor, at);
      } else {
        this.db.prepare('UPDATE lanes SET updated_at = ? WHERE id = ?').run(at, input.laneId);
      }
      return { escalation: this.requireEscalation(id), lane: this.requireLane(input.laneId) };
    });
    this.emit({ type: 'escalation', escalation });
    this.emit({ type: 'lane', lane });
    return escalation;
  }

  decideEscalation(id: string, decision: string, note: string | null, by: string): Escalation {
    return this.closeHumanStep(id, ['open'], (at) => {
      this.db
        .prepare(
          `UPDATE escalations SET state = 'decided', decision = ?, decision_note = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(decision, note, by, at, at, id);
      return `Decided by ${by}: ${decision}`;
    }, by);
  }

  acknowledgeEscalation(id: string, note: string | null, actor: string): Escalation {
    return this.closeHumanStep(id, ['decided'], (at) => {
      this.db
        .prepare(
          `UPDATE escalations SET state = 'acknowledged', acknowledged_at = ?, resolution = COALESCE(?, resolution), updated_at = ? WHERE id = ?`,
        )
        .run(at, note, at, id);
      return 'Decision acknowledged';
    }, actor);
  }

  /** Agent (or overseer) closes an escalation without a dashboard decision, e.g. it was answered in Remote Control. */
  withdrawEscalation(id: string, resolution: string | null, actor: string): Escalation {
    return this.closeHumanStep(id, ['open', 'decided'], (at) => {
      this.db
        .prepare(`UPDATE escalations SET state = 'withdrawn', resolution = ?, updated_at = ? WHERE id = ?`)
        .run(resolution, at, id);
      return `Escalation closed${resolution ? `: ${resolution}` : ''}`;
    }, actor);
  }

  /**
   * Shared state transition. Once a lane has no open escalations left, a
   * blocked_human lane moves to awaiting_agent so the blocked timer stops
   * while the agent picks up the decision.
   */
  private closeHumanStep(
    id: string,
    from: EscalationState[],
    apply: (at: string) => string,
    actor: string,
  ): Escalation {
    const { escalation, lane } = this.tx(() => {
      const current = this.requireEscalation(id);
      if (!from.includes(current.state)) {
        throw new ConflictError(`Escalation is ${current.state}; expected ${from.join(' or ')}`);
      }
      const at = this.now().toISOString();
      const message = apply(at);
      this.addEvent(current.laneId, at, 'escalation', message, actor);
      const lane = this.requireLane(current.laneId);
      if (lane.openEscalations === 0 && lane.status === 'blocked_human') {
        this.applyLaneUpdate(lane, { status: 'awaiting_agent' }, null, at);
      }
      return { escalation: this.requireEscalation(id), lane: this.requireLane(current.laneId) };
    });
    this.emit({ type: 'escalation', escalation });
    this.emit({ type: 'lane', lane });
    return escalation;
  }

  /** Records (or replaces) one agent's stance on an open escalation's recommendation. */
  addPosition(id: string, position: { agent: string; stance: Stance; note?: string | null }, actor: string): Escalation {
    const escalation = this.tx(() => {
      const current = this.requireEscalation(id);
      if (current.state !== 'open') throw new ConflictError(`Escalation is ${current.state}; positions close once decided`);
      const at = this.now().toISOString();
      const positions = current.positions.filter((p) => p.agent !== position.agent);
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
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.events.off('change', onChange);
        signal?.removeEventListener('abort', done);
        resolve(this.getEscalation(id) ?? current);
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
