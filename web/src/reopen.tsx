import { useState } from 'react';
import type { Client, Epic, ReopenRequest, Ticket } from './api.ts';
import { absolute, ago } from './format.ts';
import { toast } from './toast.tsx';
import { ticketRoute } from './ticket-views.tsx';

/**
 * Reopening a done or dropped ticket, or a closed epic: an agent's request waiting for a person, with
 * Approve and Decline; or, with none waiting, Reopen for a person to do it directly. Nothing for
 * something still open, or for someone who can't approve (an agent's or a personal key).
 */
export function ReopenControls({
  name,
  request,
  closed,
  canApprove,
  decide,
}: {
  /** What a toast calls it: "ticket 967", "epic Checkout v2". */
  name: string;
  request: ReopenRequest | null;
  /** Done, dropped or closed: something a person could reopen. */
  closed: boolean;
  canApprove: boolean;
  decide: (approve: boolean) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  if (!closed || (!request && !canApprove)) return null;
  const run = (approve: boolean) => {
    setBusy(true);
    decide(approve)
      .then(() => toast({ text: approve ? `Reopened ${name}` : `Kept ${name} closed` }))
      .catch((err: Error) => alert(`Could not ${approve ? 'reopen' : 'decline'}: ${err.message}`))
      .finally(() => setBusy(false));
  };
  if (!request) {
    return (
      <div className="close-request" onClick={(e) => e.stopPropagation()}>
        <button className="ghost" disabled={busy} onClick={() => run(true)}>
          Reopen
        </button>
      </div>
    );
  }
  return (
    <div className="close-request" onClick={(e) => e.stopPropagation()}>
      <span className="pill tone-info">Reopen requested</span>
      <span className="close-reason">{request.reason}</span>
      <span className="muted"> · {request.by}</span>
      {canApprove && (
        <span className="actions">
          <button className="primary" disabled={busy} onClick={() => run(true)}>
            Approve
          </button>
          <button className="ghost" disabled={busy} onClick={() => run(false)}>
            Decline
          </button>
        </span>
      )}
    </div>
  );
}

/** Tickets and epics an agent asked to reopen, under their group on the Lanes page: never folded, since they wait on a person. */
export function ReopenRow({
  tickets,
  epics,
  client,
  canApprove,
  now,
}: {
  tickets: Ticket[];
  epics: Epic[];
  client: Client;
  canApprove: boolean;
  now: number;
}) {
  if (!tickets.length && !epics.length) return null;
  return (
    <div className="parked reopen-requests">
      <h4 className="group-rest">
        Reopen requested <span className="count">{tickets.length + epics.length}</span>
      </h4>
      <ul className="parked-list">
        {epics.map((e) => (
          <li key={`e${e.id}`} className="reopen-item">
            <a href={`#/epic/${encodeURIComponent(e.project)}/${e.id}`} className="parked-item">
              <span className="parked-ref">◆ {e.displayRef ?? e.name}</span>
              <span className="parked-main">
                <span>{e.name}</span>
                <span className="muted" title={absolute(e.reopenRequest!.at)}>
                  epic, closed · asked {ago(e.reopenRequest!.at, now)}
                </span>
              </span>
            </a>
            <ReopenControls
              name={`epic ${e.name}`}
              request={e.reopenRequest}
              closed
              canApprove={canApprove}
              decide={(approve) => client.decideEpicReopen(e.id, approve)}
            />
          </li>
        ))}
        {tickets.map((t) => (
          <li key={`t${t.id}`} className="reopen-item">
            <a href={ticketRoute(t.project, t.ref)} className="parked-item">
              <span className="parked-ref">{t.displayRef}</span>
              <span className="parked-main">
                <span className="muted" title={absolute(t.reopenRequest!.at)}>
                  {t.state} · asked {ago(t.reopenRequest!.at, now)}
                </span>
              </span>
              {t.openEscalations > 0 && <span className="esc-count">⚑ {t.openEscalations}</span>}
            </a>
            <ReopenControls
              name={`ticket ${t.displayRef}`}
              request={t.reopenRequest}
              closed
              canApprove={canApprove}
              decide={(approve) => client.decideTicketReopen(t.project, t.ref, approve)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
