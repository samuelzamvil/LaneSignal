import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Client, Epic, Escalation, Group, LaneEvent, LaneMessage } from './api.ts';
import { AttachmentList } from './attachments.tsx';
import { FOLD, LaneComposer, Links, RichText, SheetSection, useStored, type Fold } from './components.tsx';
import { absolute, ago } from './format.ts';
import { hasNewMessage, markMessagesSeen } from './seen.ts';
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

/** An epic's board, as the per-device "new message" marker keys it. */
const board = (e: Epic) => ({ project: e.project, id: `~epic-${e.id}`, lastAgentMessageId: e.lastAgentMessageId });

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

/** The epic's ticket: a link to its tracker when there's one. */
function EpicTicket({ epic }: { epic: Epic }) {
  if (!epic.displayRef) return null;
  return epic.url ? (
    <a className="ticket" href={epic.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
      {epic.displayRef}
    </a>
  ) : (
    <span className="ticket">{epic.displayRef}</span>
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
 * On the Lanes page, in place of the group header: the epic's name and ticket, the overseer's
 * session, its status line, how many need you, and whether one of its own questions waits on you.
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
  const session = sessionLink(group);
  const waiting = needYou + epic.blockingEscalations;
  return (
    <header
      className={`epic-card${epic.blockingEscalations > 0 ? ' needs-human' : ''}`}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
    >
      <div className="group-title">
        <span className="epic-mark" aria-hidden="true">
          ◆
        </span>
        <h3>{name}</h3>
        <span className="count">{lanes}</span>
        {waiting > 0 && <span className="esc-count">⚑ {waiting} need you</span>}
        {epic.blockingEscalations > 0 && <span className="pill tone-danger">Waiting on you</span>}
        <EpicTicket epic={epic} />
        {hasNewMessage(board(epic)) && (
          <span className="new-message" title="The overseer wrote on this epic's board: open it to read">
            💬
          </span>
        )}
        {session && (
          <a className="session-link" href={session.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
            💬 {session.label}
          </a>
        )}
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
  canWrite,
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
  /** May write on the board (a person, with answering in LaneSignal on). */
  canWrite: boolean;
  canApprove: boolean;
  /** A lane's name from its id in the epic's project; null for one the client doesn't have. */
  laneName: (project: string, laneId: string) => string | null;
  onClose: () => void;
  backTo: string;
}) {
  const live = useContext(EpicsContext).get(String(id));
  const [data, setData] = useState<{ epic: Epic; escalations: Escalation[]; messages: LaneMessage[]; lanes: string[]; feed: LaneEvent[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(0);
  const [escFold, setEscFold] = useStored<Fold>('lanesignal.epic.escalations', FOLD, 'open');
  const [boardFold, setBoardFold] = useStored<Fold>('lanesignal.epic.board', FOLD, 'open');
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
  }, [client, id, version, sent]);

  // The live copy is newer than the fetched one between refetches.
  const epic = live ?? data?.epic;
  // The overseer's posts are read once the board is showing, not while it's folded away.
  useEffect(() => {
    if (epic && boardFold === 'open') markMessagesSeen(board(epic), epic.lastAgentMessageId);
  }, [epic, boardFold]);

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
            <span className="sheet-kind">Epic{epic?.standIn ? ` · ${groupLabel} as its epic` : ''}{closed ? ' · Closed' : ''}</span>
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
                    <EpicTicket epic={epic} />
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
              title="Board"
              count={data.messages.length}
              badge={
                boardFold === 'folded' &&
                hasNewMessage(board(epic)) && (
                  <span className="new-message" title="The overseer wrote on the board">
                    💬 new
                  </span>
                )
              }
              open={boardFold === 'open'}
              onToggle={() => setBoardFold(boardFold === 'open' ? 'folded' : 'open')}
            >
              {data.messages.length > 0 ? (
                <ol className="thread">
                  {data.messages.map((m) => (
                    <li key={m.id} className={`msg from-${m.from}`}>
                      <div className="msg-meta">
                        {m.author} <span title={absolute(m.at)}>· {ago(m.at, now)}</span>
                        {m.from === 'owner' && <span className="msg-seen">{m.seen ? ' · seen by the overseer' : ' · not seen yet'}</span>}
                      </div>
                      <RichText text={m.body} />
                      {m.attachments.length > 0 && <AttachmentList client={client} files={m.attachments} />}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="hint">The longer conversation that steers this epic: direction, scope, which tickets come next.</p>
              )}
              {canWrite && !closed && (
                <LaneComposer
                  key={epic.id}
                  placeholder="Write to the overseer (it reads this on its next wait)"
                  onSend={async (body) => {
                    await client.epicMessage(epic.id, body);
                    toast({ text: `Posted on ${epic.name}` });
                    setSent((n) => n + 1);
                  }}
                />
              )}
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
