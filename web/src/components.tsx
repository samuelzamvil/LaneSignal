import { useEffect, useState, type ReactNode } from 'react';
import type { Client, Escalation, Group, Lane, LaneEvent, LaneMessage, LaneStatus, Link, PublicConfig } from './api.ts';
import { AttachmentList } from './attachments.tsx';
import { ago, absolute, blockedMs, duration, isStale, needsHuman, STATUS_META } from './format.ts';
import { hasNewMessage, markMessagesSeen } from './seen.ts';
import { toast } from './toast.tsx';

/** A choice from `allowed`, remembered on this device; `fallback` when nothing (valid) is stored. */
export function useStored<T extends string>(key: string, allowed: readonly T[], fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const v = localStorage.getItem(key) as T | null;
      return v && allowed.includes(v) ? v : fallback;
    } catch {
      return fallback;
    }
  });
  return [
    value,
    (v) => {
      setValue(v);
      try {
        localStorage.setItem(key, v);
      } catch {
        /* storage unavailable: keep it for this visit */
      }
    },
  ];
}

export type Layout = 'cards' | 'list';

/** Cards or a compact list, for the inbox, the lanes or the requirements; remembered on this device. */
export const useLayout = (key: string) => useStored<Layout>(key, ['cards', 'list'], 'cards');

/** A row of buttons, one of them on: e.g. Cards / List. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <span className="layout-toggle" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} className={value === o.value ? 'on' : ''} aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </span>
  );
}

/** The Cards / List switch in a pane's heading. */
export function LayoutToggle({ layout, onChange }: { layout: Layout; onChange: (l: Layout) => void }) {
  return (
    <Segmented
      label="Show as"
      value={layout}
      onChange={onChange}
      options={[
        { value: 'cards', label: 'Cards' },
        { value: 'list', label: 'List' },
      ]}
    />
  );
}

/**
 * A part of the lane sheet that folds away under its heading. Open or folded is remembered on
 * this device for every lane, so a part you don't read stays out of the way.
 */
function SheetSection({
  title,
  count,
  badge,
  open,
  onToggle,
  children,
}: {
  title: string;
  count?: number;
  /** Shown beside the heading, e.g. that there's something new inside. */
  badge?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className={`sheet-section${open ? '' : ' folded'}`}>
      <h4>
        <button className="section-toggle" aria-expanded={open} onClick={onToggle}>
          <span className="chevron" aria-hidden="true">
            ▸
          </span>
          {title}
          {count !== undefined && <span className="count">{count}</span>}
          {badge}
        </button>
      </h4>
      {open && children}
    </section>
  );
}

type Fold = 'open' | 'folded';
const FOLD: readonly Fold[] = ['open', 'folded'];
/** Unresolved: still open, or answered and not yet picked up by the agent. */
const ACTIVE_STATES: readonly Escalation['state'][] = ['open', 'decided'];
type EscFilter = 'active' | 'history' | 'all';

export function StatusPill({ status }: { status: LaneStatus }) {
  const meta = STATUS_META[status];
  return <span className={`pill tone-${meta.tone}`}>{meta.label}</span>;
}

export function TicketLink({ lane }: { lane: Pick<Lane, 'ticket' | 'ticketUrl'> }) {
  if (!lane.ticket) return null;
  return lane.ticketUrl ? (
    <a className="ticket" href={lane.ticketUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
      {lane.ticket}
    </a>
  ) : (
    <span className="ticket">{lane.ticket}</span>
  );
}

const LINK_ICON: Record<string, string> = { pr: '⇄', ci: '⚙', session: '💬', doc: '📄' };

export function Links({ links }: { links: Link[] }) {
  if (!links.length) return null;
  return (
    <div className="links">
      {links.map((l) => (
        <a key={l.url + l.label} href={l.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
          {LINK_ICON[l.kind ?? ''] ?? '↗'} {l.label}
        </a>
      ))}
    </div>
  );
}

/** Plain text with bare URLs made clickable. */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  return (
    <p className="rich">
      {parts.map((p, i) =>
        i % 2 ? (
          <a key={i} href={p} target="_blank" rel="noreferrer">
            {p}
          </a>
        ) : (
          p
        ),
      )}
    </p>
  );
}

/** The lanes' list layout: one line per lane; tapping opens it. */
export function LaneRow({ lane, now, onOpen }: { lane: Lane; now: number; onOpen: () => void }) {
  return (
    <button className={`lane-row${needsHuman(lane) ? ' needs-human' : ''}`} onClick={onOpen}>
      <span className="ref">{lane.letter ?? ''}</span>
      <span className="lane-row-main">
        <span className="lane-row-name">{lane.name}</span>
        <span className="muted lane-row-activity">{lane.activity ?? lane.id}</span>
      </span>
      {hasNewMessage(lane) && (
        <span className="new-message" title="The agent wrote on this lane">
          💬
        </span>
      )}
      <StatusPill status={lane.status} />
      <span className="muted lane-row-when">{ago(lane.updatedAt, now)}</span>
    </button>
  );
}

export function LaneCard({
  lane,
  now,
  config,
  groupName,
  onOpen,
}: {
  lane: Lane;
  now: number;
  config: PublicConfig;
  /** Shown as a tag; null when the lane already sits under its group header. */
  groupName?: string | null;
  onOpen: () => void;
}) {
  const human = needsHuman(lane);
  const stale = isStale(lane, now, config.staleMinutes);
  const blocked = blockedMs(lane, now);
  return (
    <article
      className={`lane-card${human ? ' needs-human' : ''}${lane.status === 'completed' ? ' done' : ''}`}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
    >
      <header>
        <h3>
          {lane.letter && (
            <span className="lane-letter" title={`Lane ${lane.letter}: its questions are coded ${lane.letter} and a number`}>
              {lane.letter}
            </span>
          )}
          {lane.name}
        </h3>
        <StatusPill status={lane.status} />
      </header>
      <div className="meta">
        {groupName && <span className="tag">{groupName}</span>}
        <TicketLink lane={lane} />
        {lane.blockingEscalations > 0 && (
          <span className="esc-count">
            ⚑ {lane.blockingEscalations} decision{lane.blockingEscalations > 1 ? 's' : ''}
          </span>
        )}
        {lane.openEscalations > lane.blockingEscalations && (
          <span className="fyi-count">ⓘ {lane.openEscalations - lane.blockingEscalations} FYI</span>
        )}
        {lane.agentWaiting && (
          <span className="listening" title="An agent is waiting on this lane's escalations">
            ● agent waiting
          </span>
        )}
        {hasNewMessage(lane) && (
          <span className="new-message" title="The agent wrote on this lane: open it to read">
            💬 new message
          </span>
        )}
      </div>
      {lane.activity && <p className="activity">{lane.activity}</p>}
      <Links links={lane.links} />
      <footer>
        <span className={stale ? 'stale' : ''} title={absolute(lane.updatedAt)}>
          {stale ? '⚠ ' : ''}updated {ago(lane.updatedAt, now)}
        </span>
        {lane.status === 'blocked_human' ? (
          <span className="blocked">blocked {duration(blocked)}</span>
        ) : blocked > 0 ? (
          <span>blocked {duration(blocked)} total</span>
        ) : null}
      </footer>
    </article>
  );
}

/**
 * Writing to a lane's agent. Nothing blocks: the agent gets the note the next time it publishes the
 * lane, writes on it or waits on it.
 */
function LaneComposer({ onSend }: { onSend: (body: string) => Promise<void> }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await onSend(body.trim());
      setBody('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lane-composer">
      <textarea
        placeholder="Write to the agent (it reads this next time it reports in)"
        value={body}
        maxLength={2000}
        rows={2}
        onChange={(e) => setBody(e.target.value)}
      />
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button className="primary" disabled={busy || !body.trim()} onClick={() => void send()}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

/** Header for one epic/train/overseer: its ticket, overseer session link and how many lanes need you. */
export function GroupHeader({ group, name, lanes }: { group: Group | undefined; name: string; lanes: Lane[] }) {
  const waiting = lanes.filter(needsHuman).length;
  return (
    <header className="group-head">
      <div className="group-title">
        <h3>{name}</h3>
        <span className="count">{lanes.length}</span>
        {waiting > 0 && <span className="esc-count">⚑ {waiting} need you</span>}
        {group && <TicketLink lane={group} />}
      </div>
      {group && <Links links={group.links} />}
    </header>
  );
}

export function Chips<T extends string>({
  options,
  selected,
  onToggle,
  label,
  render,
}: {
  options: T[];
  selected: Set<T>;
  onToggle: (v: T) => void;
  label: string;
  render?: (v: T) => ReactNode;
}) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o} aria-pressed={selected.has(o)} className={selected.has(o) ? 'on' : ''} onClick={() => onToggle(o)}>
          {render ? render(o) : o}
        </button>
      ))}
    </div>
  );
}

export function LaneDetail({
  laneId,
  project,
  client,
  version,
  now,
  canDelete,
  canWrite,
  group,
  groupLabel,
  onClose,
  backTo,
}: {
  laneId: string;
  project: string;
  client: Client;
  group: Group | undefined;
  groupLabel: string;
  version: string;
  now: number;
  canDelete: boolean;
  /** May write to the lane's agent (a person, with answering in LaneSignal on). */
  canWrite: boolean;
  onClose: () => void;
  /** Where closing goes, named on the back button. */
  backTo: string;
}) {
  const [data, setData] = useState<{ lane: Lane; escalations: Escalation[]; events: LaneEvent[]; messages: LaneMessage[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(0);
  const [escFold, setEscFold] = useStored<Fold>('lanesignal.lane.escalations', FOLD, 'open');
  const [talkFold, setTalkFold] = useStored<Fold>('lanesignal.lane.conversation', FOLD, 'open');
  const [eventsFold, setEventsFold] = useStored<Fold>('lanesignal.lane.activity', FOLD, 'open');
  const [escFilter, setEscFilter] = useStored<EscFilter>('lanesignal.lane.escalationFilter', ['active', 'history', 'all'], 'active');

  useEffect(() => {
    let cancelled = false;
    client
      .laneDetail(project, laneId)
      .then((d) => {
        if (cancelled) return;
        // A server from before lane conversations sends none.
        setData({ ...d, messages: d.messages ?? [] });
        setError(null);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [client, project, laneId, version, sent]);

  // The agent's messages are read once the conversation is showing, not while it's folded away.
  useEffect(() => {
    if (data && talkFold === 'open') markMessagesSeen(data.lane, data.lane.lastAgentMessageId);
  }, [data, talkFold]);

  const activeEscs = data?.escalations.filter((e) => ACTIVE_STATES.includes(e.state)) ?? [];
  const shownEscs =
    escFilter === 'all'
      ? (data?.escalations ?? [])
      : escFilter === 'active'
        ? activeEscs
        : (data?.escalations ?? []).filter((e) => !ACTIVE_STATES.includes(e.state));

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section className="sheet sheet-lane" onClick={(e) => e.stopPropagation()} aria-label="Lane details">
        <header className="sheet-head">
          <button className="back" onClick={onClose} aria-label={`Back to ${backTo}`}>
            ← {backTo}
          </button>
          <div className="sheet-title">
            <span className="sheet-kind">Lane{data?.lane.letter ? ` ${data.lane.letter}` : ''}</span>
            <h2>{data?.lane.name ?? laneId}</h2>
          </div>
          {data && <StatusPill status={data.lane.status} />}
        </header>
        {error && <p className="error">{error}</p>}
        {data && (
          <div className="sheet-body">
            <dl className="facts">
              <dt>Lane</dt>
              <dd>
                <code>{data.lane.id}</code>
              </dd>
              {data.lane.group && (
                <>
                  <dt>{groupLabel}</dt>
                  <dd>
                    {group?.name ?? data.lane.group}
                    {group?.ticket && (
                      <>
                        {' · '}
                        <TicketLink lane={group} />
                      </>
                    )}
                  </dd>
                </>
              )}
              {data.lane.ticket && (
                <>
                  <dt>Ticket</dt>
                  <dd>
                    <TicketLink lane={data.lane} />
                  </dd>
                </>
              )}
              <dt>Agent</dt>
              <dd>{data.lane.agent ?? '—'}</dd>
              <dt>Updated</dt>
              <dd title={absolute(data.lane.updatedAt)}>{ago(data.lane.updatedAt, now)}</dd>
              <dt>In status</dt>
              <dd>{duration(now - Date.parse(data.lane.statusSince))}</dd>
              <dt>Blocked</dt>
              <dd>{duration(blockedMs(data.lane, now))} total</dd>
            </dl>
            {data.lane.activity && <p className="activity full">{data.lane.activity}</p>}
            <Links links={data.lane.links} />
            {group && group.links.length > 0 && (
              <>
                <h4>
                  {groupLabel}: {group.name}
                </h4>
                <Links links={group.links} />
              </>
            )}

            {data.escalations.length > 0 && (
              <SheetSection
                title="Escalations"
                count={activeEscs.length}
                open={escFold === 'open'}
                onToggle={() => setEscFold(escFold === 'open' ? 'folded' : 'open')}
              >
                <Segmented
                  label="Show escalations"
                  value={escFilter}
                  onChange={setEscFilter}
                  options={[
                    { value: 'active', label: `Active ${activeEscs.length}` },
                    { value: 'history', label: `Historical ${data.escalations.length - activeEscs.length}` },
                    { value: 'all', label: `All ${data.escalations.length}` },
                  ]}
                />
                {shownEscs.length === 0 && (
                  <p className="hint">{escFilter === 'active' ? 'Nothing open on this lane.' : 'No earlier escalations.'}</p>
                )}
                <ul className="esc-history">
                  {shownEscs.map((e) => (
                    <li key={e.id} className={`state-${e.state}`}>
                      <a href={`#/esc/${e.id}`} className="esc-row">
                        <span className="state">{e.state}</span> {e.question}
                      </a>
                      {e.decision && (
                        <span className="decision">
                          {' '}
                          → <strong>{e.decision}</strong> ({e.decidedBy})
                        </span>
                      )}
                      {e.resolution && <span className="note"> · {e.resolution}</span>}
                    </li>
                  ))}
                </ul>
              </SheetSection>
            )}

            {(data.messages.length > 0 || canWrite) && (
              <SheetSection
                title="Conversation"
                count={data.messages.length}
                badge={
                  talkFold === 'folded' &&
                  hasNewMessage(data.lane) && (
                    <span className="new-message" title="The agent wrote on this lane">
                      💬 new
                    </span>
                  )
                }
                open={talkFold === 'open'}
                onToggle={() => setTalkFold(talkFold === 'open' ? 'folded' : 'open')}
              >
                {data.messages.length > 0 ? (
                  <ol className="thread">
                    {data.messages.map((m) => (
                      <li key={m.id} className={`msg from-${m.from}`}>
                        <div className="msg-meta">
                          {m.author} <span title={absolute(m.at)}>· {ago(m.at, now)}</span>
                          {m.from === 'owner' && <span className="msg-seen">{m.seen ? ' · seen by the agent' : ' · not seen yet'}</span>}
                        </div>
                        <RichText text={m.body} />
                        {m.attachments.length > 0 && <AttachmentList client={client} files={m.attachments} />}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="hint">The agent's milestones on this lane show here, and you can write to it.</p>
                )}
                {canWrite && (
                  <LaneComposer
                    key={data.lane.id}
                    onSend={async (body) => {
                      await client.laneMessage(data.lane.project, data.lane.id, body);
                      toast({ text: `Sent to the agent on ${data.lane.name}` });
                      setSent((n) => n + 1);
                    }}
                  />
                )}
              </SheetSection>
            )}

            <SheetSection
              title="Recent activity"
              count={data.events.length}
              open={eventsFold === 'open'}
              onToggle={() => setEventsFold(eventsFold === 'open' ? 'folded' : 'open')}
            >
              <ol className="timeline">
                {data.events.map((ev) => (
                  <li key={ev.id} className={`kind-${ev.kind}`}>
                    <time title={absolute(ev.at)}>{ago(ev.at, now)}</time>
                    <span>{ev.message}</span>
                    {ev.actor && <span className="actor">{ev.actor}</span>}
                  </li>
                ))}
              </ol>
            </SheetSection>
            {canDelete && (
              <button
                className="ghost danger"
                onClick={() => {
                  if (confirm(`Remove "${data.lane.name}" from the dashboard? Its open questions are withdrawn; its history stays available in exports.`)) {
                    client
                      .deleteLane(data.lane.project, data.lane.id)
                      .then(onClose)
                      .catch((err: Error) => alert(`Could not remove the lane: ${err.message}`));
                  }
                }}
              >
                Remove lane
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
