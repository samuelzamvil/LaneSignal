import { useEffect, useState } from 'react';
import type { Client, Escalation, Lane, Position } from './api.ts';
import { Links, RichText, TicketLink } from './components.tsx';
import { absolute, ago } from './format.ts';

const STANCE_META: Record<Position['stance'], { icon: string; label: string }> = {
  agree: { icon: '✓', label: 'Agrees' },
  disagree: { icon: '✗', label: 'Disagrees' },
  neutral: { icon: '–', label: 'Neutral' },
};

/** "✓ 2  ✗ 1" summary of agent positions. */
function StanceSummary({ positions }: { positions: Position[] }) {
  if (!positions.length) return null;
  const count = (s: Position['stance']) => positions.filter((p) => p.stance === s).length;
  return (
    <span className="stance-summary" aria-label="Agent positions">
      {(['agree', 'disagree', 'neutral'] as const).map(
        (s) =>
          count(s) > 0 && (
            <span key={s} className={`stance stance-${s}`} title={STANCE_META[s].label}>
              {STANCE_META[s].icon} {count(s)}
            </span>
          ),
      )}
    </span>
  );
}

/**
 * Option buttons, free-text answer and note. `compact` (inbox cards) shows
 * only the option buttons and Send; the full form lives in the detail sheet.
 */
function DecisionForm({
  esc,
  client,
  compact,
  onMore,
}: {
  esc: Escalation;
  client: Client;
  compact?: boolean;
  onMore?: () => void;
}) {
  const [choice, setChoice] = useState('');
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

  return (
    <div className="decision-form" onClick={(e) => e.stopPropagation()}>
      {esc.options.length > 0 && (
        <div className="options" role="radiogroup" aria-label="Answers">
          {esc.options.map((o) => (
            <button
              key={o}
              role="radio"
              aria-checked={choice === o && !custom}
              className={`${choice === o && !custom ? 'selected' : ''}${o === esc.recommendedOption ? ' recommended' : ''}`}
              onClick={() => {
                setChoice(o);
                setCustom('');
              }}
            >
              {o}
              {o === esc.recommendedOption && <span className="rec-badge">Recommended</span>}
            </button>
          ))}
        </div>
      )}
      {!compact && (
        <>
          <input
            className="custom"
            placeholder={esc.options.length ? 'Or type another answer…' : 'Your decision…'}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
          <textarea
            placeholder="Optional note for the agent"
            value={note}
            rows={2}
            onChange={(e) => setNote(e.target.value)}
          />
        </>
      )}
      {error && <p className="error">{error}</p>}
      <div className="actions">
        {compact && !esc.options.length ? (
          <button className="primary" onClick={onMore}>
            Review &amp; answer
          </button>
        ) : (
          <button
            className="primary"
            disabled={!decision || busy}
            onClick={() => run(() => client.decide(esc.id, decision, note))}
          >
            {busy ? 'Sending…' : 'Send decision'}
          </button>
        )}
        {compact ? (
          <button className="ghost" onClick={onMore}>
            Details
          </button>
        ) : (
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
        )}
      </div>
    </div>
  );
}

function EscHead({ esc, lane, now }: { esc: Escalation; lane: Lane | undefined; now: number }) {
  return (
    <div className="esc-head">
      <a
        className="lane-ref"
        href={`#/lane/${encodeURIComponent(esc.laneId)}`}
        onClick={(e) => e.stopPropagation()}
      >
        {lane?.name ?? esc.laneId}
      </a>
      {lane?.category && <span className="tag">{lane.category}</span>}
      {lane && <TicketLink lane={lane} />}
      <span className="when" title={absolute(esc.createdAt)}>
        {ago(esc.createdAt, now)}
      </span>
    </div>
  );
}

/** Compact inbox card; tapping it opens the detail sheet. */
export function EscalationCard({
  esc,
  lane,
  now,
  client,
}: {
  esc: Escalation;
  lane: Lane | undefined;
  now: number;
  client: Client;
}) {
  const open = () => (location.hash = `#/esc/${esc.id}`);
  return (
    <article
      className={`esc-card ${esc.state}`}
      onClick={open}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.target === e.currentTarget && e.key === 'Enter' && open()}
    >
      <EscHead esc={esc} lane={lane} now={now} />
      <h3>{esc.question}</h3>
      {esc.state === 'decided' ? (
        <>
          <p className="decision">
            <strong>{esc.decision}</strong> — {esc.decidedBy}, {esc.decidedAt && ago(esc.decidedAt, now)}
          </p>
          <p className="hint">Waiting for the agent to acknowledge.</p>
        </>
      ) : (
        <>
          {esc.recommendation && (
            <p className="rec-line">
              <span className="label">Recommends</span> {esc.recommendation}
            </p>
          )}
          {esc.positions.length > 0 && (
            <p className="positions-line">
              Agents <StanceSummary positions={esc.positions} />
            </p>
          )}
          <DecisionForm esc={esc} client={client} compact onMore={open} />
        </>
      )}
    </article>
  );
}

const STATE_LABEL: Record<Escalation['state'], string> = {
  open: 'Needs decision',
  decided: 'Decided · awaiting agent',
  acknowledged: 'Closed · acknowledged',
  withdrawn: 'Closed · withdrawn',
};

/** Full-screen (mobile) / side (desktop) sheet with every section of an escalation. */
export function EscalationDetail({
  id,
  client,
  lanes,
  version,
  now,
  onClose,
}: {
  id: string;
  client: Client;
  lanes: Map<string, Lane>;
  /** Changes whenever the escalation changes, to trigger a refetch. */
  version: string;
  now: number;
  onClose: () => void;
}) {
  const [esc, setEsc] = useState<Escalation | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .escalation(id)
      .then((e) => !cancelled && (setEsc(e), setError(null)))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [client, id, version]);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section className="sheet" onClick={(e) => e.stopPropagation()} aria-label="Escalation details">
        <header className="sheet-head">
          <button className="back" onClick={onClose} aria-label="Close">
            ←
          </button>
          <h2>Escalation</h2>
          {esc && <span className={`pill ${esc.state === 'open' ? 'tone-danger' : 'tone-muted'}`}>{STATE_LABEL[esc.state]}</span>}
        </header>
        {error && <p className="error sheet-body">{error}</p>}
        {esc && (
          <div className="sheet-body esc-detail">
            <EscHead esc={esc} lane={lanes.get(esc.laneId)} now={now} />
            <p className="byline">
              Raised by {esc.createdBy} · {absolute(esc.createdAt)}
            </p>

            {esc.context && (
              <section className="esc-section">
                <h4>Context</h4>
                <RichText text={esc.context} />
              </section>
            )}

            <section className="esc-section question">
              <h4>Question</h4>
              <p className="question-text">{esc.question}</p>
            </section>

            {(esc.recommendation || esc.recommendedOption) && (
              <section className="esc-section recommendation">
                <h4>Recommendation</h4>
                {esc.recommendedOption && (
                  <p>
                    <strong>{esc.recommendedOption}</strong>
                  </p>
                )}
                {esc.recommendation && <RichText text={esc.recommendation} />}
              </section>
            )}

            {esc.positions.length > 0 && (
              <section className="esc-section">
                <h4>
                  Agent positions <StanceSummary positions={esc.positions} />
                </h4>
                <ul className="positions">
                  {esc.positions.map((p) => (
                    <li key={p.agent} className={`stance-${p.stance}`}>
                      <span className="stance-icon" aria-hidden>
                        {STANCE_META[p.stance].icon}
                      </span>
                      <div>
                        <div>
                          <strong>{p.agent}</strong> <span className="muted">{STANCE_META[p.stance].label.toLowerCase()}</span>
                          <span className="muted" title={absolute(p.at)}>
                            {' '}
                            · {ago(p.at, now)}
                          </span>
                        </div>
                        {p.note && <RichText text={p.note} />}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {esc.links.length > 0 && (
              <section className="esc-section">
                <h4>Links</h4>
                <Links links={esc.links} />
              </section>
            )}

            {esc.state === 'open' ? (
              <section className="esc-section answer">
                <h4>Your decision</h4>
                <DecisionForm esc={esc} client={client} />
              </section>
            ) : (
              <section className="esc-section outcome">
                <h4>Outcome</h4>
                {esc.decision && (
                  <p>
                    <strong>{esc.decision}</strong> — {esc.decidedBy}
                    {esc.decidedAt && <span className="muted"> · {absolute(esc.decidedAt)}</span>}
                  </p>
                )}
                {esc.decisionNote && <p className="note">{esc.decisionNote}</p>}
                {esc.state === 'decided' && <p className="hint">Waiting for the agent to acknowledge.</p>}
                {esc.resolution && (
                  <p className="note">
                    {esc.state === 'withdrawn' ? 'Withdrawn: ' : 'Agent: '}
                    {esc.resolution}
                  </p>
                )}
              </section>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
