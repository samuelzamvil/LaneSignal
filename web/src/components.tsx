import { useEffect, useState, type ReactNode } from 'react';
import type { Client, Escalation, Group, Lane, LaneEvent, LaneStatus, Link, PublicConfig } from './api.ts';
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
        <h3>{lane.name}</h3>
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
  client,
  version,
  now,
  canDelete,
  group,
  groupLabel,
  onClose,
}: {
  laneId: string;
  client: Client;
  group: Group | undefined;
  groupLabel: string;
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
              <>
                <h4>Escalations</h4>
                <ul className="esc-history">
                  {data.escalations.map((e) => (
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
                  if (confirm(`Remove "${data.lane.name}" from the dashboard? Its open questions are withdrawn; its history stays available in exports.`)) {
                    client
                      .deleteLane(data.lane.id)
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
