import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Client, Epic, Escalation, Group, LaneEvent } from './api.ts';
import { FOLD, Links, SheetSection, TicketLink, useStored, type Fold } from './components.tsx';
import { absolute, ago } from './format.ts';
import { hasNewMessage } from './seen.ts';
import { toast } from './toast.tsx';

/** Open epics (and ones waiting for close approval), by number. */
export const EpicsContext = createContext<Map<string, Epic>>(new Map());

/** An epic's sheet. */
export const epicRoute = (project: string, id: number) => `#/epic/${encodeURIComponent(project)}/${id}`;

/**
 * Whether a question was raised on a lane anyone can open. One raised on an epic directly has none
 * (`laneId` null; servers from before this change sent its internal lane, "~epic-<n>").
 */
export const hasLane = (laneId: string | null): laneId is string => laneId !== null && !/^~epic-\d+$/.test(laneId);

/** A question's lane key, or its epic's for one raised on the epic: questions are grouped by it. */
export const laneKeyOf = (e: Pick<Escalation, 'project' | 'laneId' | 'epicId'>) =>
  `${e.project}/${hasLane(e.laneId) ? e.laneId : `~epic-${e.epicId}`}`;


/** The overseer's Remote Control session, from its group's links. */
const sessionLink = (group: Group | undefined) => group?.links.find((l) => l.kind === 'session');

/** The epic a question belongs to, linking to its sheet. */
export function EpicChip({ esc }: { esc: Pick<Escalation, 'project' | 'epicId' | 'epicName'> }) {
  if (!esc.epicId) return null;
  return (
    <a className="epic-ref" href={epicRoute(esc.project, esc.epicId)} title={`Epic: ${esc.epicName ?? ''}`} onClick={(e) => e.stopPropagation()}>
      ◆ {esc.epicName}
    </a>
  );
}

/** The epic's ticket (for a group standing in as its epic, the group's), a link to its tracker when there's one. */
function EpicTicket({ epic, group }: { epic: Epic; group?: Group }) {
  const ref = epic.displayRef;
  const url = epic.displayRef ? epic.url : (group?.ticketUrl ?? null);
  if (!ref) return null;
  return url ? (
    <a className="ticket" href={url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
      {ref}
    </a>
  ) : (
    <span className="ticket">{ref}</span>
  );
}

/** Approve or decline an overseer's request to close the epic. */
function CloseRequest({ epic, client, canApprove }: { epic: Epic; client: Client; canApprove: boolean }) {
  const [busy, setBusy] = useState(false);
  if (epic.state !== 'close_requested') return null;
  const decide = (approve: boolean) => {
    setBusy(true);
    client
      .decideEpicClose(epic.id, approve)
      .then(() => toast({ text: approve ? `Closed ${epic.name}` : `Kept ${epic.name} open` }))
      .catch((err: Error) => alert(`Could not ${approve ? 'close' : 'decline'}: ${err.message}`))
      .finally(() => setBusy(false));
  };
  return (
    <div className="close-request" onClick={(e) => e.stopPropagation()}>
      <span className="pill tone-info">Close requested</span>
      {epic.closeReason && <span className="close-reason">{epic.closeReason}</span>}
      {epic.closeRequestedBy && <span className="muted"> · {epic.closeRequestedBy}</span>}
      {canApprove && (
        <span className="actions">
          <button className="primary" disabled={busy} onClick={() => decide(true)}>
            Approve
          </button>
          <button className="ghost" disabled={busy} onClick={() => decide(false)}>
            Decline
          </button>
        </span>
      )}
    </div>
  );
}

/**
 * A card's title, as the one thing on it that opens its sheet from the keyboard. A card holds links
 * and buttons of its own, so the card itself can't be a button; a tap anywhere else on it still opens.
 */
function TitleButton({ name, onOpen }: { name: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="title-open"
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      {name}
    </button>
  );
}

/**
 * The head of a group's box on the Lanes page: whose lanes these are, the overseer's session, and how
 * many need you. The group's own status line shows here, it reads Waiting on you while one of its
 * own questions blocks it, and tapping it (or Chat) opens the group's conversation.
 */
export function GroupHeader({
  group,
  name,
  lanes,
  waiting,
  blocking,
  showTicket,
  onChat,
}: {
  group: Group | undefined;
  name: string;
  /** How many lanes are in the box. */
  lanes: number;
  /** Lanes and epics in the box waiting on a person. */
  waiting: number;
  /** The group's own questions that block it, waiting on a person. */
  blocking: number;
  /** The group's own ticket from before epics: not shown once its epics carry theirs. */
  showTicket: boolean;
  /** Opens the group's conversation. */
  onChat?: () => void;
}) {
  const session = sessionLink(group);
  const others = group?.links.filter((l) => l !== session) ?? [];
  const blocked = blocking > 0;
  return (
    <header className={`group-head${onChat ? ' opens' : ''}${blocked ? ' needs-human' : ''}`} onClick={onChat}>
      <div className="group-head-main">
      <div className="group-title">
        <h3>{onChat ? <TitleButton name={name} onOpen={onChat} /> : name}</h3>
        <span className="count">{lanes}</span>
        {waiting > 0 && <span className="esc-count">⚑ {waiting} need you</span>}
        {blocked && <span className="pill tone-danger">Waiting on you</span>}
        {showTicket && group && <TicketLink lane={group} />}
        {session && (
          <a className="session-link" href={session.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
            💬 {session.label}
          </a>
        )}
      </div>
      {group?.statusLine && <p className="status-line">{group.statusLine}</p>}
      {others.length > 0 && (
        <div onClick={(e) => e.stopPropagation()}>
          <Links links={others} />
        </div>
      )}
      </div>
      {group && onChat && (
        <button
          className="chat-button"
          onClick={(e) => {
            e.stopPropagation();
            onChat();
          }}
          aria-label={`Chat with ${name}'s overseer${hasNewMessage(group) ? ' (new messages)' : ''}`}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
          </svg>
          Chat
          {hasNewMessage(group) && <span className="chat-new" aria-hidden="true" />}
        </button>
      )}
    </header>
  );
}

/** Quiet lanes in a group's box, folded into one row until asked for. */
export function QuietLanes({ count, children }: { count: number; children: ReactNode }) {
  const [fold, setFold] = useStored<Fold>('lanesignal.lanes.idle', FOLD, 'folded');
  if (!count) return null;
  const open = fold === 'open';
  return (
    <div className={`parked${open ? '' : ' folded'}`}>
      <button className="section-toggle" aria-expanded={open} onClick={() => setFold(open ? 'folded' : 'open')}>
        <span className="chevron" aria-hidden="true">
          ▸
        </span>
        Idle <span className="count">{count}</span>
      </button>
      {open && children}
    </div>
  );
}

/**
 * An epic inside its group's box: its name and ticket, its status line, how many need you, and
 * whether one of its own questions waits on you. With no lanes and nothing to act on, it's one line.
 */
export function EpicCard({
  epic,
  group,
  name,
  lanes,
  needYou,
  client,
  canApprove,
  onOpen,
}: {
  epic: Epic;
  group: Group | undefined;
  /** As the page names it (with the project key when several are on screen). */
  name: string;
  /** How many lanes are listed under it. */
  lanes: number;
  /** Its lanes waiting on a person. */
  needYou: number;
  client: Client;
  canApprove: boolean;
  onOpen: () => void;
}) {
  const waiting = needYou + epic.blockingEscalations;
  const compact = lanes === 0 && waiting === 0 && epic.state === 'open';
  return (
    <header
      className={`epic-card${compact ? ' compact' : ''}${epic.blockingEscalations > 0 ? ' needs-human' : ''}`}
      onClick={onOpen}
    >
      <div className="group-title">
        <span className="epic-mark" aria-hidden="true">
          ◆
        </span>
        <h3>
          <TitleButton name={name} onOpen={onOpen} />
        </h3>
        {!compact && <span className="count">{lanes}</span>}
        {waiting > 0 && <span className="esc-count">⚑ {waiting} need you</span>}
        {epic.blockingEscalations > 0 && <span className="pill tone-danger">Waiting on you</span>}
        <EpicTicket epic={epic} group={group} />
      </div>
      {epic.statusLine && <p className="status-line">{epic.statusLine}</p>}
      <CloseRequest epic={epic} client={client} canApprove={canApprove} />
    </header>
  );
}

/** Full-screen (mobile) / side (desktop) sheet for one epic: its questions, its board, and its lanes' combined feed. */
export function EpicDetail({
  id,
  client,
  version,
  now,
  group,
  groupLabel,
  canApprove,
  laneName,
  onClose,
  backTo,
}: {
  id: number;
  client: Client;
  /** Changes when something about the epic changed, to refetch. */
  version: string;
  now: number;
  group: Group | undefined;
  groupLabel: string;
  canApprove: boolean;
  /** A lane's name from its id in the epic's project; null for one the client doesn't have. */
  laneName: (project: string, laneId: string) => string | null;
  onClose: () => void;
  backTo: string;
}) {
  const live = useContext(EpicsContext).get(String(id));
  const [data, setData] = useState<{ epic: Epic; escalations: Escalation[]; lanes: string[]; feed: LaneEvent[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [escFold, setEscFold] = useStored<Fold>('lanesignal.epic.escalations', FOLD, 'open');
  const [feedFold, setFeedFold] = useStored<Fold>('lanesignal.epic.feed', FOLD, 'open');

  useEffect(() => {
    let cancelled = false;
    client
      .epicDetail(id)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [client, id, version]);

  // The live copy is newer than the fetched one between refetches.
  const epic = live ?? data?.epic;

  const lane = (laneId: string): ReactNode => {
    const name = epic ? laneName(epic.project, laneId) : null;
    return name && epic ? <a href={`#/lane/${encodeURIComponent(epic.project)}/${encodeURIComponent(laneId)}`}>{name}</a> : laneId;
  };
  const closed = epic?.state === 'closed';

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section className="sheet sheet-epic" onClick={(e) => e.stopPropagation()} aria-label="Epic details">
        <header className="sheet-head">
          <button className="back" onClick={onClose} aria-label={`Back to ${backTo}`}>
            ← {backTo}
          </button>
          <div className="sheet-title">
            <span className="sheet-kind">Epic{closed ? ' · Closed' : ''}</span>
            <h2>{epic?.name ?? '…'}</h2>
          </div>
          {epic && epic.blockingEscalations > 0 && <span className="pill tone-danger">Waiting on you</span>}
        </header>
        {error && <p className="error">{error}</p>}
        {epic && data && (
          <div className="sheet-body">
            <dl className="facts">
              {epic.displayRef && (
                <>
                  <dt>Ticket</dt>
                  <dd>
                    <EpicTicket epic={epic} group={group} />
                  </dd>
                </>
              )}
              <dt>{groupLabel}</dt>
              <dd>{group?.name ?? epic.group}</dd>
              <dt>Codes</dt>
              <dd>
                <code>{epic.code}</code>A, <code>{epic.code}</code>B …
              </dd>
              <dt>Updated</dt>
              <dd title={absolute(epic.updatedAt)}>{ago(epic.updatedAt, now)}</dd>
            </dl>
            {epic.statusLine && <p className="status-line full">{epic.statusLine}</p>}
            <CloseRequest epic={epic} client={client} canApprove={canApprove} />
            <Links links={epic.links} />
            {group && sessionLink(group) && <Links links={[sessionLink(group)!]} />}

            <SheetSection
              title="Escalations"
              count={data.escalations.length}
              open={escFold === 'open'}
              onToggle={() => setEscFold(escFold === 'open' ? 'folded' : 'open')}
            >
              {data.escalations.length === 0 && <p className="hint">No questions on this epic.</p>}
              <ul className="esc-history">
                {data.escalations.map((e) => (
                  <li key={e.id} className={`state-${e.state}`}>
                    <a href={`#/esc/${e.id}`} className="esc-row">
                      <span className="state">{e.ref}</span> {e.question}
                    </a>
                    {hasLane(e.laneId) && <span className="muted"> · from {lane(e.laneId)}</span>}
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
              title="Lanes"
              count={data.lanes.length}
              open={feedFold === 'open'}
              onToggle={() => setFeedFold(feedFold === 'open' ? 'folded' : 'open')}
            >
              {data.lanes.length > 0 ? (
                <p className="ticket-lanes">
                  {data.lanes.map((l, i) => (
                    <span key={l}>
                      {i > 0 && ' · '}
                      {lane(l)}
                    </span>
                  ))}
                </p>
              ) : (
                <p className="hint">No lane is working a ticket of this epic.</p>
              )}
              <ol className="timeline">
                {data.feed.map((ev) => (
                  <li key={ev.id} className={`kind-${ev.kind}`}>
                    <time title={absolute(ev.at)}>{ago(ev.at, now)}</time>
                    <span>
                      {ev.message}
                      <span className="muted"> · {laneName(epic.project, ev.laneId) ?? ev.laneId}</span>
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
