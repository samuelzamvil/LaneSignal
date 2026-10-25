import { createContext, useContext, useEffect, useState } from 'react';
import { TicketLinksContext } from './linked-text.tsx';
import type { Client, Escalation, LaneEvent, Ticket } from './api.ts';
import { FOLD, SheetSection, StatusPill, useStored, type Fold } from './components.tsx';
import { absolute, ago, duration } from './format.ts';

/** The tickets the client keeps (held and parked ones, and any an open question belongs to), by number. */
export const TicketsContext = createContext<Map<string, Ticket>>(new Map());

/** A ticket's sheet. Any form of its ref finds it; the server puts it in canonical form. */
export const ticketRoute = (project: string, ref: string) => `#/ticket/${encodeURIComponent(project)}/${encodeURIComponent(ref)}`;

const STATE_LABEL: Record<Ticket['state'], string> = {
  in_lane: 'In a lane',
  parked: 'Parked',
  done: 'Done',
  dropped: 'Dropped',
};

/**
 * The ticket an escalation belongs to, linking to the ticket's sheet. It says so when no lane
 * holds the ticket (parked, done or dropped), since then the question blocks no lane.
 */
export function TicketChip({ esc }: { esc: Pick<Escalation, 'project' | 'ticketId' | 'ticketRef'> }) {
  const tickets = useContext(TicketsContext);
  if (esc.ticketId === null || !esc.ticketRef) return null;
  const t = tickets.get(String(esc.ticketId));
  const away = t && t.state !== 'in_lane';
  return (
    <a
      className={`ticket-ref${away ? ' away' : ''}`}
      href={ticketRoute(esc.project, esc.ticketRef)}
      title={away ? `Ticket ${esc.ticketRef}: ${STATE_LABEL[t.state].toLowerCase()}` : `Ticket ${esc.ticketRef}`}
      onClick={(e) => e.stopPropagation()}
    >
      🎫 {esc.ticketRef}
      {away && <span className="ticket-state"> · {STATE_LABEL[t.state].toLowerCase()}</span>}
    </a>
  );
}

/**
 * Whether a question's own `ticket` names something other than the ticket it belongs to (e.g. a PR),
 * so it's worth showing too. Both are compared in short form ("redmine:500" is "500" for the default system).
 */
export function useSeparateTicket(esc: Pick<Escalation, 'ticket' | 'ticketRef'>) {
  const { defaultTicketSystem } = useContext(TicketLinksContext) ?? {};
  if (!esc.ticket) return false;
  const short = defaultTicketSystem && esc.ticket.startsWith(`${defaultTicketSystem}:`) ? esc.ticket.slice(defaultTicketSystem.length + 1) : esc.ticket;
  return short !== esc.ticketRef;
}

/** A question's ticket in words, for one-line rows: "500", or "500 (parked)" when no lane holds it. */
export function useTicketLabel(esc: Pick<Escalation, 'ticketId' | 'ticketRef'>) {
  const tickets = useContext(TicketsContext);
  if (esc.ticketId === null || !esc.ticketRef) return null;
  const t = tickets.get(String(esc.ticketId));
  return t && t.state !== 'in_lane' ? `${esc.ticketRef} (${STATE_LABEL[t.state].toLowerCase()})` : esc.ticketRef;
}

/** Whether an escalation's ticket is in a lane (or it has none): what "Active tickets only" keeps. */
export function onActiveTicket(esc: Pick<Escalation, 'ticketId'>, tickets: Map<string, Ticket>) {
  if (esc.ticketId === null) return true;
  const t = tickets.get(String(esc.ticketId));
  // A ticket the client hasn't heard of yet counts as active, so nothing disappears by mistake.
  return !t || t.state === 'in_lane';
}

/**
 * Under a group on the Lanes page: its parked tickets, with why, how many questions are open on
 * each, and the lane each left. Folded or open is remembered on this device.
 */
export function ParkedRow({ tickets, now, laneName }: { tickets: Ticket[]; now: number; laneName: (t: Ticket) => string | null }) {
  const [fold, setFold] = useStored<Fold>('lanesignal.lanes.parked', FOLD, 'folded');
  if (!tickets.length) return null;
  const open = fold === 'open';
  return (
    <div className={`parked${open ? '' : ' folded'}`}>
      <button className="section-toggle" aria-expanded={open} onClick={() => setFold(open ? 'folded' : 'open')}>
        <span className="chevron" aria-hidden="true">
          ▸
        </span>
        Parked <span className="count">{tickets.length}</span>
        {!open && tickets.some((t) => t.openEscalations > 0) && (
          <span className="esc-count">⚑ {tickets.reduce((n, t) => n + t.openEscalations, 0)} open</span>
        )}
      </button>
      {open && (
        <ul className="parked-list">
          {tickets.map((t) => {
            const left = laneName(t);
            return (
              <li key={t.id}>
                <a href={ticketRoute(t.project, t.ref)} className="parked-item">
                  <span className="parked-ref">{t.displayRef}</span>
                  <span className="parked-main">
                    <span className="parked-reason">{t.parkReason ?? 'Parked'}</span>
                    <span className="muted">
                      {left ? `left ${left}` : 'no lane yet'} · <span title={absolute(t.updatedAt)}>{ago(t.updatedAt, now)}</span>
                    </span>
                  </span>
                  {t.openEscalations > 0 && <span className="esc-count">⚑ {t.openEscalations}</span>}
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Full-screen (mobile) / side (desktop) sheet for one ticket: where it is, its questions, and its history across lanes. */
export function TicketDetail({
  project,
  ticketRef,
  client,
  stamp,
  now,
  laneName,
  onClose,
  backTo,
}: {
  project: string;
  ticketRef: string;
  client: Client;
  /** For a ticket's number: changes when something about it changed, to refetch. */
  stamp: (ticketId: number) => string;
  now: number;
  /** A lane's name from its id; null for a lane the client doesn't have (removed). */
  laneName: (laneId: string) => string | null;
  onClose: () => void;
  backTo: string;
}) {
  const [data, setData] = useState<{ ticket: Ticket; escalations: Escalation[]; events: LaneEvent[]; lanes: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [escFold, setEscFold] = useStored<Fold>('lanesignal.ticket.escalations', FOLD, 'open');
  const [historyFold, setHistoryFold] = useStored<Fold>('lanesignal.ticket.history', FOLD, 'open');
  // Known once loaded: whatever form the route wrote the ref in, the ticket's number follows it live.
  const version = data ? stamp(data.ticket.id) : '';

  useEffect(() => {
    let cancelled = false;
    client
      .ticketDetail(project, ticketRef)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [client, project, ticketRef, version]);

  const t = data?.ticket;
  const laneLink = (id: string) => {
    const name = laneName(id);
    // A removed lane has no sheet to open.
    return name ? <a href={`#/lane/${encodeURIComponent(project)}/${encodeURIComponent(id)}`}>{name}</a> : <span>{id} (removed)</span>;
  };
  const blocked = t ? t.blockedTotalMs + (t.blockedSince ? now - Date.parse(t.blockedSince) : 0) : 0;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section className="sheet sheet-ticket" onClick={(e) => e.stopPropagation()} aria-label="Ticket details">
        <header className="sheet-head">
          <button className="back" onClick={onClose} aria-label={`Back to ${backTo}`}>
            ← {backTo}
          </button>
          <div className="sheet-title">
            <span className="sheet-kind">Ticket{t ? ` · ${STATE_LABEL[t.state]}` : ''}</span>
            <h2>{t?.displayRef ?? ticketRef}</h2>
          </div>
          {t && <StatusPill status={t.status} />}
        </header>
        {error && <p className="error">{error}</p>}
        {t && data && (
          <div className="sheet-body">
            <dl className="facts">
              <dt>Ticket</dt>
              <dd>
                {t.url ? (
                  <a className="ticket" href={t.url} target="_blank" rel="noreferrer">
                    {t.ref}
                  </a>
                ) : (
                  <code>{t.ref}</code>
                )}
              </dd>
              <dt>Where</dt>
              <dd>
                {t.lane ? (
                  <>In lane {laneLink(t.lane)}</>
                ) : (
                  <>
                    {STATE_LABEL[t.state]}
                    {t.parkReason && `: ${t.parkReason}`}
                    {t.lastLane && <> · left {laneLink(t.lastLane)}</>}
                  </>
                )}
              </dd>
              {t.waitingOn && (
                <>
                  <dt>Waiting on</dt>
                  <dd>
                    <a href={ticketRoute(project, t.waitingOn)}>{t.waitingOn}</a>
                  </dd>
                </>
              )}
              <dt>Blocked</dt>
              <dd>{duration(blocked)} total</dd>
              <dt>Updated</dt>
              <dd title={absolute(t.updatedAt)}>{ago(t.updatedAt, now)}</dd>
            </dl>
            <p className="hint">Not a tracker: this is where the ticket is in LaneSignal, not its status in its ticket system.</p>

            {data.lanes.length > 0 && (
              <p className="ticket-lanes">
                Lanes it passed through:{' '}
                {data.lanes.map((id, i) => (
                  <span key={id}>
                    {i > 0 && ' → '}
                    {laneLink(id)}
                  </span>
                ))}
              </p>
            )}

            <SheetSection
              title="Escalations"
              count={data.escalations.length}
              open={escFold === 'open'}
              onToggle={() => setEscFold(escFold === 'open' ? 'folded' : 'open')}
            >
              {data.escalations.length === 0 && <p className="hint">No questions on this ticket.</p>}
              <ul className="esc-history">
                {data.escalations.map((e) => (
                  <li key={e.id} className={`state-${e.state}`}>
                    <a href={`#/esc/${e.id}`} className="esc-row">
                      <span className="state">{e.ref}</span> {e.question}
                    </a>
                    {e.decision && (
                      <span className="decision">
                        {' '}
                        → <strong>{e.decision}</strong> ({e.decidedBy})
                      </span>
                    )}
                    {e.state === 'open' && <span className="note"> · open</span>}
                    {e.resolution && <span className="note"> · {e.resolution}</span>}
                  </li>
                ))}
              </ul>
            </SheetSection>

            <SheetSection
              title="History"
              count={data.events.length}
              open={historyFold === 'open'}
              onToggle={() => setHistoryFold(historyFold === 'open' ? 'folded' : 'open')}
            >
              <ol className="timeline">
                {data.events.map((ev) => (
                  <li key={ev.id} className={`kind-${ev.kind}`}>
                    <time title={absolute(ev.at)}>{ago(ev.at, now)}</time>
                    <span>
                      {ev.message}
                      <span className="muted"> · {laneName(ev.laneId) ?? ev.laneId}</span>
                    </span>
                    {ev.actor && <span className="actor">{ev.actor}</span>}
                  </li>
                ))}
              </ol>
            </SheetSection>
          </div>
        )}
      </section>
    </div>
  );
}
