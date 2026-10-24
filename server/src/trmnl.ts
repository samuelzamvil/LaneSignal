import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TRMNL_HOSTS } from './config.ts';
import { zipFiles } from './export.ts';
import { log } from './log.ts';
import { localId, ValidationError, type Store } from './store.ts';
import type { Escalation, StreamEvent, TrmnlCard, TrmnlPushResult, TrmnlSetup } from './types.ts';

/**
 * A project's TRMNL screen: LaneSignal pushes the screen's data to a TRMNL private plugin's
 * webhook, so TRMNL never has to reach LaneSignal. The screen shows the latest notification as a
 * card, and the project's other pending escalations beside it.
 */

/** TRMNL's free tier takes 12 pushes per plugin per hour: one every 5 minutes, with some slack. */
const MIN_GAP_MS = 310_000;
/** Bursts (an escalation and its lane change) become one push. */
const DEBOUNCE_MS = 2_000;
/** Pushes again after an hour of no changes, so the screen's "updated" time shows LaneSignal is alive. */
const HEARTBEAT_MS = 3_600_000;
/** TRMNL's limit is 5 KB of stored data; stay well under it. */
const MAX_BYTES = 4_500;
const MAX_ROWS = 12;

const clip = (s: string | null | undefined, max: number) => {
  if (!s) return null;
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const epoch = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** Checks a webhook URL: TRMNL's own servers over HTTPS, or a self-hosted TRMNL server listed in the config. */
export function checkWebhookUrl(raw: string, hosts: string[]): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ValidationError('The webhook URL is not a valid URL');
  }
  const host = url.hostname.toLowerCase();
  const own = TRMNL_HOSTS.includes(host);
  if (!hosts.includes(host)) {
    throw new ValidationError(
      `The webhook URL must point at TRMNL (${TRMNL_HOSTS.join(' or ')}); add other servers to LANESIGNAL_TRMNL_HOSTS`,
    );
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !own)) throw new ValidationError('The webhook URL must use https');
  if (url.username || url.password) throw new ValidationError('The webhook URL must not contain a user name or password');
  return url.toString();
}

/** The webhook URL with its secret part (the plugin's UUID) hidden, for showing in settings. */
export function maskWebhookUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const parts = url.pathname.split('/');
    const last = parts.pop() ?? '';
    parts.push(last.length > 4 ? `…${last.slice(-4)}` : '…');
    return `${url.origin}${parts.join('/')}`;
  } catch {
    return '…';
  }
}

interface CardData {
  type: 'escalation' | 'notice' | 'completed' | 'blocked';
  label: string;
  code: string | null;
  where: string;
  title: string;
  context: string | null;
  message: string | null;
  recommendation: string | null;
  accept: string | null;
  reject: string | null;
  files: number;
  at: number;
}

interface Row {
  code: string;
  q: string;
  lane: string;
  at: number;
  fyi: boolean;
  agent: boolean;
}

export interface TrmnlPayload {
  project: string;
  card: CardData | null;
  pending: Row[];
  /** Pending escalations beyond `pending`'s rows. */
  more: number;
  /** When LaneSignal sent it (epoch seconds); the screen shows how long ago. */
  asOf: number;
}

function where(store: Store, laneId: string) {
  const lane = store.getLane(laneId);
  const group = lane?.group ? store.getGroup(lane.group) : null;
  return [group?.name, lane?.name ?? localId(laneId)].filter(Boolean).join(' / ');
}

/** Inbox order: blocking questions waiting on you, then the agent's turn, then FYIs; oldest first within each. */
function rank(e: Escalation) {
  if (e.turn === 'agent') return 1;
  return e.blocking ? 0 : 2;
}

function escalationCard(store: Store, e: Escalation): CardData {
  const agentSpoke = e.lastMessage?.from === 'agent';
  const label = e.turn === 'agent' ? "Agent's turn" : agentSpoke ? 'Reply' : e.blocking ? 'Needs you' : 'FYI';
  return {
    type: 'escalation',
    label,
    code: e.ref,
    where: clip(where(store, e.laneId), 60) ?? '',
    title: clip(e.question, 200) ?? '',
    context: clip(e.context, 360),
    message: e.lastMessage ? clip(`${e.lastMessage.from === 'agent' ? 'Agent' : 'You'}: ${e.lastMessage.body}`, 300) : null,
    recommendation: clip(e.recommendation, 240),
    accept: clip(e.acceptMeans, 120),
    reject: e.allowReject ? clip(e.rejectMeans, 120) : null,
    files: e.attachments.length,
    at: epoch(e.lastMessage?.at ?? e.createdAt),
  };
}

/** What the screen shows for a project right now. */
export function buildPayload(store: Store, setup: TrmnlSetup, now: Date): TrmnlPayload {
  const project = store.getProject(setup.project);
  const open = store
    .listEscalations({ states: ['open'], projects: [setup.project] })
    .sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt));

  // The card: the latest notification while it still matters, else the newest open question.
  let card: CardData | null = null;
  let cardId: string | null = null;
  const stored = setup.card;
  if (stored?.kind === 'escalation') {
    const e = open.find((x) => x.id === stored.id);
    if (e) [card, cardId] = [escalationCard(store, e), e.id];
  } else if (stored && setup.includeNotifications) {
    const label = stored.kind === 'completed' ? 'Completed' : stored.kind === 'blocked' ? 'Blocked' : 'Update';
    card = {
      type: stored.kind,
      label,
      code: null,
      where: clip(stored.title, 60) ?? '',
      title: clip(stored.body, 200) ?? '',
      context: null,
      message: null,
      recommendation: null,
      accept: null,
      reject: null,
      files: 0,
      at: epoch(stored.at),
    };
  }
  if (!card && open.length) {
    const newest = open.reduce((a, b) => ((b.lastMessage?.at ?? b.createdAt) > (a.lastMessage?.at ?? a.createdAt) ? b : a));
    [card, cardId] = [escalationCard(store, newest), newest.id];
  }

  const rest = open.filter((e) => e.id !== cardId);
  const rows: Row[] = rest.slice(0, MAX_ROWS).map((e) => ({
    code: e.ref,
    q: clip(e.question, 100) ?? '',
    lane: clip(store.getLane(e.laneId)?.name ?? localId(e.laneId), 30) ?? '',
    at: epoch(e.createdAt),
    fyi: !e.blocking,
    agent: e.turn === 'agent',
  }));
  const payload: TrmnlPayload = {
    project: project?.name ?? setup.project,
    card,
    pending: rows,
    more: rest.length - rows.length,
    asOf: Math.floor(now.getTime() / 1000),
  };

  // Fit TRMNL's size limit: drop list rows first (they're counted in "more"), then trim the card.
  const size = () => Buffer.byteLength(JSON.stringify(payload));
  while (size() > MAX_BYTES && payload.pending.length) {
    payload.pending.pop();
    payload.more++;
  }
  if (size() > MAX_BYTES && payload.card) {
    payload.card.context = clip(payload.card.context, 120);
    payload.card.message = clip(payload.card.message, 120);
    payload.card.recommendation = clip(payload.card.recommendation, 120);
  }
  return payload;
}

/** The card a change puts on the screen, if any. */
function cardFor(e: StreamEvent, includeNotifications: boolean): TrmnlCard | null {
  if (e.type === 'escalation') {
    const esc = e.escalation;
    const created = e.raised || esc.createdAt === esc.updatedAt;
    if (esc.state === 'open' && (created || e.replied)) return { kind: 'escalation', id: esc.id, at: esc.updatedAt };
    return null;
  }
  if (e.type === 'lane' && e.statusChanged && includeNotifications) {
    const lane = e.lane;
    const title = lane.name;
    if (lane.status === 'completed') {
      return { kind: 'completed', laneId: lane.id, title, body: lane.activity ?? 'Lane completed', at: lane.updatedAt };
    }
    if (lane.status === 'blocked_human' && lane.openEscalations === 0) {
      return { kind: 'blocked', laneId: lane.id, title, body: lane.activity ?? 'Blocked on a human decision', at: lane.updatedAt };
    }
  }
  return null;
}

function projectOfEvent(e: StreamEvent): string | null {
  switch (e.type) {
    case 'group':
      return e.group.project;
    case 'lane':
      return e.lane.project;
    case 'escalation':
      return e.escalation.project;
    case 'group_deleted':
    case 'lane_deleted':
      return e.project;
    default:
      return null;
  }
}

export type PushResult = TrmnlPushResult;

interface State {
  timer: NodeJS.Timeout | null;
  /** When the last push was attempted (successful or not), for spacing them out. */
  lastAttempt: number;
  /** The last data TRMNL accepted (without its time), to skip pushes that change nothing. */
  lastBody: string | null;
  lastSuccess: number;
  sending: boolean;
  /** A change arrived while sending. */
  dirty: boolean;
}

export interface TrmnlOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  minGapMs?: number;
  debounceMs?: number;
  heartbeatMs?: number;
}

/** Pushes each configured project's screen to TRMNL when its data changes, within TRMNL's rate limit. */
export class TrmnlPusher {
  private states = new Map<string, State>();
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;
  private readonly minGap: number;
  private readonly debounce: number;
  private readonly heartbeatMs: number;
  private readonly onChange = (e: StreamEvent) => this.change(e);
  private readonly onNotice = (n: { project: string; laneId: string; message: string }) => this.notice(n);

  private readonly store: Store;

  constructor(store: Store, opts: TrmnlOptions = {}) {
    this.store = store;
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? (() => new Date());
    this.minGap = opts.minGapMs ?? MIN_GAP_MS;
    this.debounce = opts.debounceMs ?? DEBOUNCE_MS;
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  }

  start() {
    this.store.events.on('change', this.onChange);
    this.store.events.on('notice', this.onNotice);
    // Bring every screen up to date after a restart, then keep them fresh.
    for (const s of this.store.listTrmnlSetups()) this.touch(s.project);
    this.heartbeat = setInterval(() => {
      for (const s of this.store.listTrmnlSetups()) {
        const st = this.states.get(s.project);
        if (s.enabled && (!st || this.now().getTime() - st.lastSuccess >= this.heartbeatMs)) this.touch(s.project);
      }
    }, Math.min(this.heartbeatMs, 300_000));
    this.heartbeat.unref();
    return this;
  }

  stop() {
    this.store.events.off('change', this.onChange);
    this.store.events.off('notice', this.onNotice);
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const st of this.states.values()) if (st.timer) clearTimeout(st.timer);
    this.states.clear();
  }

  /** The setup changed (new URL, switched on): forget what was sent and push soon. */
  reset(project: string) {
    const st = this.states.get(project);
    if (st) {
      st.lastBody = null;
      st.lastSuccess = 0;
    }
    this.touch(project);
  }

  private state(project: string): State {
    let st = this.states.get(project);
    if (!st) {
      st = { timer: null, lastAttempt: 0, lastBody: null, lastSuccess: 0, sending: false, dirty: false };
      this.states.set(project, st);
    }
    return st;
  }

  private change(e: StreamEvent) {
    const project = projectOfEvent(e);
    if (!project) return;
    const setup = this.store.trmnlSetup(project);
    if (!setup) return;
    const card = cardFor(e, setup.includeNotifications);
    if (card) this.store.setTrmnlCard(project, card);
    this.touch(project);
  }

  private notice(n: { project: string; laneId: string; message: string }) {
    const setup = this.store.trmnlSetup(n.project);
    if (!setup?.includeNotifications) return;
    this.store.setTrmnlCard(n.project, {
      kind: 'notice',
      laneId: n.laneId,
      title: where(this.store, n.laneId),
      body: n.message,
      at: this.now().toISOString(),
    });
    this.touch(n.project);
  }

  /** Schedules a push for the project: soon, but no sooner than TRMNL's rate limit allows. */
  private touch(project: string) {
    const st = this.state(project);
    if (st.sending) {
      st.dirty = true;
      return;
    }
    if (st.timer) return;
    const wait = Math.max(this.debounce, st.lastAttempt + this.minGap - this.now().getTime());
    st.timer = setTimeout(() => void this.flush(project), wait);
    st.timer.unref();
  }

  private async flush(project: string) {
    const st = this.state(project);
    st.timer = null;
    const setup = this.store.trmnlSetup(project);
    if (!setup?.enabled) return;
    const payload = buildPayload(this.store, setup, this.now());
    const body = JSON.stringify({ ...payload, asOf: 0 });
    const due = this.now().getTime() - st.lastSuccess >= this.heartbeatMs;
    if (body === st.lastBody && !due) return;
    await this.send(setup, payload, body);
  }

  /** Pushes right away, whatever was sent before (Settings → Send now). */
  async sendNow(project: string): Promise<PushResult> {
    const setup = this.store.trmnlSetup(project);
    if (!setup) throw new ValidationError('This project has no TRMNL screen set up');
    const st = this.state(project);
    if (st.timer) clearTimeout(st.timer);
    st.timer = null;
    const payload = buildPayload(this.store, setup, this.now());
    return this.send(setup, payload, JSON.stringify({ ...payload, asOf: 0 }));
  }

  private async send(setup: TrmnlSetup, payload: TrmnlPayload, body: string): Promise<PushResult> {
    const st = this.state(setup.project);
    st.sending = true;
    st.dirty = false;
    st.lastAttempt = this.now().getTime();
    let result: PushResult;
    let retry = false;
    try {
      const res = await this.fetch(setup.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ merge_variables: payload }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        result = { ok: true, status: res.status };
      } else {
        const raw = await res.text().catch(() => '');
        let text: string | null;
        try {
          text = clip((JSON.parse(raw) as { message?: string }).message ?? raw, 200);
        } catch {
          text = clip(raw, 200);
        }
        const error =
          res.status === 429
            ? 'TRMNL says too many pushes (429); LaneSignal tries again in a few minutes'
            : `TRMNL answered ${res.status}${text ? `: ${text}` : ''}`;
        result = { ok: false, status: res.status, error };
        // Rate limits and server trouble pass; other answers (wrong URL or strategy) need a fix first.
        retry = res.status === 429 || res.status >= 500;
      }
    } catch (err) {
      // fetch's own message ("fetch failed") hides the reason, which is in its cause.
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : null;
      result = { ok: false, error: `Couldn't reach TRMNL: ${cause ?? (err instanceof Error ? err.message : String(err))}` };
      retry = true;
    } finally {
      st.sending = false;
    }
    const at = this.now();
    // The setup may have been removed while the push was out.
    if (this.store.trmnlSetup(setup.project)) this.store.recordTrmnlPush(setup.project, at, result.ok ? null : result.error!);
    if (result.ok) {
      st.lastBody = body;
      st.lastSuccess = at.getTime();
    } else {
      log.warn('trmnl push failed', { project: setup.project, error: result.error });
      // Not retried: the same data is skipped until it changes or the setup is fixed.
      if (!retry) st.lastBody = body;
    }
    if (st.dirty || retry) this.touch(setup.project);
    return result;
  }
}

/** The plugin to import into TRMNL, named after the project. */
export function pluginZip(dir: string, projectName: string, generatedAt: Date): Promise<Buffer> {
  const read = (name: string) => readFileSync(path.join(dir, name), 'utf8');
  // A single-quoted YAML string: only ' needs escaping (doubled).
  const name = `LaneSignal · ${projectName}`.replace(/[\r\n]/g, ' ').replace(/'/g, "''");
  const settings = read('settings.yml').replace(/^name: .*$/m, () => `name: '${name}'`);
  return zipFiles(
    [
      { name: 'settings.yml', data: Buffer.from(settings, 'utf8') },
      { name: 'shared.liquid', data: Buffer.from(read('shared.liquid'), 'utf8') },
      { name: 'full.liquid', data: Buffer.from(read('full.liquid'), 'utf8') },
    ],
    generatedAt,
  );
}
