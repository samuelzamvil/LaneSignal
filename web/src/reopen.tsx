import { useState } from 'react';
import type { Client, Epic, ReopenRequest } from './api.ts';
import { absolute, ago } from './format.ts';
import { toast } from './toast.tsx';

/**
 * Reopening a closed epic: the overseer's request waiting for a person, with Approve and Decline; or,
 * with none waiting, Reopen for a person to do it directly. Nothing for an open epic, or for someone
 * who can't approve (an agent's or a personal key).
 */
export function ReopenControls({
  name,
  request,
  closed,
  canApprove,
  decide,
}: {
  /** What a toast calls it: "epic Checkout v2". */
  name: string;
  request: ReopenRequest | null;
  /** Closed: something a person could reopen. */
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

/** Closed epics their overseer asked to reopen, under their group on the Lanes page: never folded, since they wait on a person. */
export function ReopenRow({
  epics,
  client,
  canApprove,
  now,
}: {
  epics: Epic[];
  client: Client;
  canApprove: boolean;
  now: number;
}) {
  if (!epics.length) return null;
  return (
    <div className="parked reopen-requests">
      <h4 className="group-rest">
        Reopen requested <span className="count">{epics.length}</span>
      </h4>
      <ul className="parked-list">
        {epics.map((e) => (
          <li key={e.id} className="reopen-item">
            <a href={`#/epic/${encodeURIComponent(e.project)}/${e.id}`} className="parked-item">
              <span className="parked-ref">◆ {e.displayRef ?? e.name}</span>
              <span className="parked-main">
                <span>{e.name}</span>
                <span className="muted" title={absolute(e.reopenRequest!.at)}>
                  closed · asked {ago(e.reopenRequest!.at, now)}
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
      </ul>
    </div>
  );
}
