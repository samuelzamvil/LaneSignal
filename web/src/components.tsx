import { useEffect, useState, type ReactNode } from 'react';
import type { Client, Escalation, Lane, LaneEvent, LaneStatus, Link, PublicConfig } from './api.ts';
import { ago, absolute, blockedMs, duration, isStale, needsHuman, STATUS_META } from './format.ts';

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
function RichText({ text }: { text: string }) {
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

export function LaneCard({
  lane,
  now,
  config,
  onOpen,
}: {
  lane: Lane;
  now: number;
  config: PublicConfig;
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
        <h3>{lane.name}</h3>
        <StatusPill status={lane.status} />
      </header>
      <div className="meta">
        {lane.category && <span className="tag">{lane.category}</span>}
        <TicketLink lane={lane} />
        {lane.openEscalations > 0 && (
          <span className="esc-count">
            ⚑ {lane.openEscalations} decision{lane.openEscalations > 1 ? 's' : ''}
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

export function EscalationCard({
  esc,
  lane,
  now,
  client,
  focused,
  onOpenLane,
}: {
  esc: Escalation;
  lane: Lane | undefined;
  now: number;
  client: Client;
  focused?: boolean;
  onOpenLane: () => void;
}) {
  const [choice, setChoice] = useState<string>('');
  const [custom, setCustom] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decision = custom.trim() || choice;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const head = (
    <div className="esc-head">
      <button className="lane-ref" onClick={onOpenLane}>
        {lane?.name ?? esc.laneId}
      </button>
      {lane?.category && <span className="tag">{lane.category}</span>}
      {lane && <TicketLink lane={lane} />}
      <span className="when" title={absolute(esc.createdAt)}>
        {ago(esc.createdAt, now)}
      </span>
    </div>
  );

  if (esc.state === 'decided') {
    return (
      <article className="esc-card decided" id={`esc-${esc.id}`}>
        {head}
        <h3>{esc.title}</h3>
        <p className="decision">
          <strong>{esc.decision}</strong> — {esc.decidedBy}, {esc.decidedAt && ago(esc.decidedAt, now)}
        </p>
        {esc.decisionNote && <p className="note">{esc.decisionNote}</p>}
        <p className="hint">Waiting for the agent to acknowledge.</p>
      </article>
    );
  }

  return (
    <article className={`esc-card open${focused ? ' focused' : ''}`} id={`esc-${esc.id}`}>
      {head}
      <h3>{esc.title}</h3>
      {esc.body && <RichText text={esc.body} />}
      <Links links={esc.links} />
      {esc.options.length > 0 && (
        <div className="options" role="radiogroup">
          {esc.options.map((o) => (
            <button
              key={o}
              role="radio"
              aria-checked={choice === o && !custom}
              className={choice === o && !custom ? 'selected' : ''}
              onClick={() => {
                setChoice(o);
                setCustom('');
              }}
            >
              {o}
            </button>
          ))}
        </div>
      )}
      <input
        className="custom"
        placeholder={esc.options.length ? 'Or type another answer…' : 'Your decision…'}
        value={custom}
        onChange={(e) => setCustom(e.target.value)}
      />
      {decision && (
        <textarea placeholder="Optional note for the agent" value={note} rows={2} onChange={(e) => setNote(e.target.value)} />
      )}
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button
          className="primary"
          disabled={!decision || busy}
          onClick={() => run(() => client.decide(esc.id, decision, note))}
        >
          {busy ? 'Sending…' : 'Send decision'}
        </button>
        <button
          className="ghost"
          disabled={busy}
          onClick={() => {
            const why = prompt('Dismiss without a decision? Optional reason:');
            if (why !== null) void run(() => client.withdraw(esc.id, why));
          }}
        >
          Dismiss
        </button>
      </div>
    </article>
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
  client,
  version,
  now,
  canDelete,
  onClose,
}: {
  laneId: string;
  client: Client;
  version: string;
  now: number;
  canDelete: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<{ lane: Lane; escalations: Escalation[]; events: LaneEvent[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .laneDetail(laneId)
      .then((d) => !cancelled && (setData(d), setError(null)))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [client, laneId, version]);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section className="sheet" onClick={(e) => e.stopPropagation()} aria-label="Lane details">
        <header className="sheet-head">
          <button className="back" onClick={onClose} aria-label="Close">
            ←
          </button>
          <h2>{data?.lane.name ?? laneId}</h2>
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
              {data.lane.category && (
                <>
                  <dt>Category</dt>
                  <dd>{data.lane.category}</dd>
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

            {data.escalations.length > 0 && (
              <>
                <h4>Escalations</h4>
                <ul className="esc-history">
                  {data.escalations.map((e) => (
                    <li key={e.id} className={`state-${e.state}`}>
                      <span className="state">{e.state}</span> {e.title}
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
              </>
            )}

            <h4>Recent activity</h4>
            <ol className="timeline">
              {data.events.map((ev) => (
                <li key={ev.id} className={`kind-${ev.kind}`}>
                  <time title={absolute(ev.at)}>{ago(ev.at, now)}</time>
                  <span>{ev.message}</span>
                  {ev.actor && <span className="actor">{ev.actor}</span>}
                </li>
              ))}
            </ol>
            {canDelete && (
              <button
                className="ghost danger"
                onClick={() => {
                  if (confirm(`Remove lane "${data.lane.name}" and its history?`)) {
                    void client.deleteLane(data.lane.id).then(onClose);
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
