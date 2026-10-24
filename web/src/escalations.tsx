import { useEffect, useRef, useState } from 'react';
import type { Client, Escalation, Group, Lane, Position } from './api.ts';
import { Links, RichText, TicketLink } from './components.tsx';
import { absolute, ago } from './format.ts';
import { keyOf } from './merge.ts';
import { toast } from './toast.tsx';

/** Whether `code` names the escalation: "A12", or across projects "LS-A12" / "LS·A12" / "LS:A12". */
export function isCodeOf(e: Escalation, code: string) {
  const c = decodeURIComponent(code).trim().toLowerCase().replace(/^#/, '');
  const ref = e.ref.toLowerCase();
  return c === ref || ['-', '·', ':'].some((sep) => c === `${e.projectKey.toLowerCase()}${sep}${ref}`);
}

/**
 * Whether the answer will reach an agent now. Open: is an agent waiting on it?
 * Decided: has the agent picked it up, or is it overdue (older than the stale threshold)?
 */
function AgentPresence({ esc, lane, now, staleMinutes }: { esc: Escalation; lane: Lane | undefined; now: number; staleMinutes: number }) {
  if (esc.state === 'open') {
    return lane?.agentWaiting ? (
      <p className="agent-presence on">● An agent is waiting for this answer.</p>
    ) : (
      <p className="agent-presence">No agent is waiting right now; it gets your answer when it next checks in.</p>
    );
  }
  if (esc.state !== 'decided') return null;
  const late = staleMinutes > 0 && esc.decidedAt && now - Date.parse(esc.decidedAt) > staleMinutes * 60_000;
  return late ? (
    <p className="agent-presence late">
      ⚠ Decided {ago(esc.decidedAt!, now)}; the agent hasn't picked it up yet.
      {lane?.agentWaiting ? '' : ' No agent is waiting on this lane.'}
    </p>
  ) : (
    <p className="hint">Waiting for the agent to acknowledge.</p>
  );
}

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
  change,
  onDone,
}: {
  esc: Escalation;
  client: Client;
  compact?: boolean;
  onMore?: () => void;
  /** Replaces the answer on a decided escalation. */
  change?: boolean;
  onDone?: () => void;
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
            onClick={() =>
              run(async () => {
                await client.decide(esc.id, decision, note, change);
                // The card disappears at once; say what was sent, with a way back to fix a mis-tap.
                toast({ text: `Sent “${decision}” to ${esc.ref}`, action: { label: 'Change', href: `#/esc/${esc.id}` } });
                onDone?.();
              })
            }
          >
            {busy ? 'Sending…' : change ? 'Change decision' : 'Send decision'}
          </button>
        )}
        {change ? (
          <button className="ghost" disabled={busy} onClick={onDone}>
            Cancel
          </button>
        ) : compact ? (
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

function EscHead({
  esc,
  lane,
  group,
  now,
  showProject,
}: {
  esc: Escalation;
  lane: Lane | undefined;
  group: Group | undefined;
  now: number;
  /** Prefix the code with the project key, when several projects are on screen. */
  showProject: boolean;
}) {
  return (
    <div className="esc-head">
      <span className="ref" title="Use this code when talking to the agent about it">
        {showProject ? `${esc.projectKey}·${esc.ref}` : esc.ref}
      </span>
      <a
        className="lane-ref"
        href={`#/lane/${encodeURIComponent(esc.project)}/${encodeURIComponent(esc.laneId)}`}
        onClick={(e) => e.stopPropagation()}
      >
        {lane?.name ?? esc.laneId}
      </a>
      {(group || lane?.group) && <span className="tag">{group?.name ?? lane?.group}</span>}
      {esc.ticket ? <TicketLink lane={esc} /> : lane && <TicketLink lane={lane} />}
      <span className="when" title={absolute(esc.createdAt)}>
        {ago(esc.createdAt, now)}
      </span>
    </div>
  );
}

/** The overseer's Remote Control session, from its group's links. */
const sessionLink = (group: Group | undefined) => group?.links.find((l) => l.kind === 'session');

/**
 * Alerts are answered in the agent's own session, so the decision and the conversation stay
 * in one place. The card shows the choices and links straight to that session.
 */
function AlertActions({ esc, group, onMore }: { esc: Escalation; group: Group | undefined; onMore: () => void }) {
  const session = sessionLink(group);
  return (
    <div onClick={(e) => e.stopPropagation()}>
      {esc.options.length > 0 && (
        <p className="options-line">
          {esc.options.map((o, i) => (
            <span key={o}>
              {i > 0 && ' · '}
              <span className={o === esc.recommendedOption ? 'recommended' : undefined}>{o}</span>
            </span>
          ))}
        </p>
      )}
      <div className="actions">
        {session ? (
          <a className="button primary" href={session.url} target="_blank" rel="noreferrer">
            Answer in session ↗
          </a>
        ) : (
          <span className="hint">Answer {esc.ref} in the agent's session.</span>
        )}
        <button className="ghost" onClick={onMore}>
          Details
        </button>
      </div>
    </div>
  );
}

/** Compact inbox card; tapping it opens the detail sheet. */
export function EscalationCard({
  esc,
  lane,
  group,
  now,
  client,
  seq,
  staleMinutes,
  showProject,
  decisions,
}: {
  esc: Escalation;
  lane: Lane | undefined;
  group: Group | undefined;
  now: number;
  client: Client;
  /** Position among the lane's open escalations, when it has more than one. */
  seq?: { index: number; total: number };
  staleMinutes: number;
  showProject: boolean;
  /** People answer in LaneSignal; otherwise the card only tells them, and they answer in the agent's session. */
  decisions: boolean;
}) {
  const open = () => (location.hash = `#/esc/${esc.id}`);
  return (
    <article
      className={`esc-card ${esc.state}${esc.blocking ? '' : ' fyi'}`}
      onClick={open}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.target === e.currentTarget && e.key === 'Enter' && open()}
    >
      <EscHead esc={esc} lane={lane} group={group} now={now} showProject={showProject} />
      {seq && (
        <p className="seq">
          Question {seq.index + 1} of {seq.total} from this lane
        </p>
      )}
      <h3>{esc.question}</h3>
      {esc.state === 'open' && esc.context && <p className="context-line">{esc.context}</p>}
      {esc.state === 'decided' ? (
        <>
          <p className="decision">
            <strong>{esc.decision}</strong> — {esc.decidedBy}, {esc.decidedAt && ago(esc.decidedAt, now)}
          </p>
          <AgentPresence esc={esc} lane={lane} now={now} staleMinutes={staleMinutes} />
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
          {decisions ? (
            <DecisionForm esc={esc} client={client} compact onMore={open} />
          ) : (
            <AlertActions esc={esc} group={group} onMore={open} />
          )}
        </>
      )}
    </article>
  );
}

const STATE_LABEL: Record<Escalation['state'], string> = {
  open: 'Needs decision',
  decided: 'Decided · awaiting agent',
  acknowledged: 'Closed · acknowledged',
  withdrawn: 'Closed · dismissed',
};

/** Full-screen (mobile) / side (desktop) sheet with every section of an escalation. */
export function EscalationDetail({
  id,
  client,
  lanes,
  groups,
  laneOpenIds,
  version,
  now,
  staleMinutes,
  onClose,
  currentId,
  showProject,
  decisions,
  backTo,
}: {
  id: string;
  /** The escalation's id when the route names it by number. */
  currentId?: string;
  client: Client;
  lanes: Map<string, Lane>;
  groups: Map<string, Group>;
  /** Open escalation ids of this escalation's lane, oldest first. */
  laneOpenIds: string[];
  /** Changes whenever the escalation changes, to trigger a refetch. */
  version: string;
  now: number;
  staleMinutes: number;
  onClose: () => void;
  showProject: boolean;
  decisions: boolean;
  /** Where closing goes, named on the back button. */
  backTo: string;
}) {
  const [loaded, setLoaded] = useState<Escalation | null>(null);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sheet = useRef<HTMLElement>(null);
  // While stepping to another question, never show (or answer) the previous one.
  // `id` may be the escalation's code (#/esc/A12) as well as its id.
  // Fetch by id when the live data already resolved the code: a bare code is ambiguous across projects.
  const target = currentId ?? id;
  const esc = loaded && (loaded.id === target || isCodeOf(loaded, id)) ? loaded : null;
  const lane = esc ? lanes.get(keyOf(esc.project, esc.laneId)) : undefined;

  useEffect(() => {
    sheet.current?.scrollTo(0, 0);
    setChanging(false);
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    client
      .escalation(target)
      .then((e) => !cancelled && (setLoaded(e), setError(null)))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [client, target, version]);

  // Step through a lane's batch of questions without going back to the inbox.
  const idx = laneOpenIds.indexOf(currentId ?? id);
  const prev = idx > 0 ? laneOpenIds[idx - 1] : undefined;
  const next = idx >= 0 ? laneOpenIds[idx + 1] : laneOpenIds[0];
  const go = (target: string) => location.replace(`#/esc/${target}`);
  const nav =
    prev || next ? (
      <nav className="esc-nav" aria-label="Other questions from this lane">
        <button className="ghost" disabled={!prev} onClick={() => prev && go(prev)}>
          ← Previous
        </button>
        <span className="muted">
          {idx >= 0 ? `Question ${idx + 1} of ${laneOpenIds.length}` : `${laneOpenIds.length} more open from this lane`}
        </span>
        <button className={idx < 0 ? 'primary' : 'ghost'} disabled={!next} onClick={() => next && go(next)}>
          Next →
        </button>
      </nav>
    ) : null;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section
        ref={sheet}
        className={`sheet sheet-esc ${!esc || esc.state !== 'open' ? 'is-closed' : esc.blocking ? 'is-blocking' : 'is-fyi'}`}
        onClick={(e) => e.stopPropagation()}
        aria-label="Escalation details"
      >
        <header className="sheet-head">
          <button className="back" onClick={onClose} aria-label={`Back to ${backTo}`}>
            ← {backTo}
          </button>
          <div className="sheet-title">
            <span className="sheet-kind">{esc && !esc.blocking ? 'FYI' : 'Escalation'}</span>
            <h2>{esc ? (showProject ? `${esc.projectKey}·${esc.ref}` : esc.ref) : 'Loading…'}</h2>
          </div>
          {esc &&
            (esc.state === 'open' && !esc.blocking ? (
              <span className="pill tone-info">FYI · lane keeps working</span>
            ) : (
              <span className={`pill ${esc.state === 'open' ? 'tone-danger' : 'tone-muted'}`}>{esc.state === 'open' && !decisions ? 'Needs you' : STATE_LABEL[esc.state]}</span>
            ))}
        </header>
        {error && <p className="error sheet-body">{error}</p>}
        {esc && (
          <div className="sheet-body esc-detail">
            <EscHead
              esc={esc}
              lane={lane}
              group={lane?.group ? groups.get(keyOf(lane.project, lane.group)) : undefined}
              now={now}
              showProject={showProject}
            />
            <p className="byline">
              Raised by {esc.createdBy} · {absolute(esc.createdAt)}
            </p>
            {nav}

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

            {(esc.recommendation || esc.recommendedOption || esc.cost) && (
              <section className="esc-section recommendation">
                <h4>Recommendation</h4>
                {esc.recommendedOption && (
                  <p>
                    <strong>{esc.recommendedOption}</strong>
                  </p>
                )}
                {esc.recommendation && <RichText text={esc.recommendation} />}
                {esc.cost && (
                  <div className="cost">
                    <h5>Cost</h5>
                    <RichText text={esc.cost} />
                  </div>
                )}
              </section>
            )}

            {esc.alternatives.length > 0 && (
              <section className="esc-section">
                <h4>{esc.alternatives.length > 1 ? 'Alternatives' : 'Alternative'}</h4>
                <ul className="alternatives">
                  {esc.alternatives.map((a, i) => (
                    <li key={i}>
                      <RichText text={a} />
                    </li>
                  ))}
                </ul>
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

            {esc.state === 'open' && !decisions ? (
              <section className="esc-section answer">
                <h4>Answer</h4>
                {(() => {
                  const group = lane?.group ? groups.get(keyOf(lane.project, lane.group)) : undefined;
                  const session = sessionLink(group);
                  return (
                    <p className="hint">
                      Answer {showProject ? `${esc.projectKey}·${esc.ref}` : esc.ref} in the agent's session
                      {session ? (
                        <>
                          {': '}
                          <a href={session.url} target="_blank" rel="noreferrer">
                            open it ↗
                          </a>
                        </>
                      ) : (
                        '.'
                      )}{' '}
                      The agent dismisses this alert once it's dealt with.
                    </p>
                  );
                })()}
                <div className="actions">
                  <button
                    className="ghost danger"
                    onClick={() => {
                      const why = prompt('Dismiss this alert (e.g. its session ended)? Optional reason:');
                      if (why !== null) client.withdraw(esc.id, why).catch((e: Error) => setError(e.message));
                    }}
                  >
                    Dismiss
                  </button>
                </div>
              </section>
            ) : esc.state === 'open' ? (
              <section className="esc-section answer">
                <h4>{esc.blocking ? 'Your decision' : 'Your reply (optional)'}</h4>
                <AgentPresence esc={esc} lane={lane} now={now} staleMinutes={staleMinutes} />
                <DecisionForm key={esc.id} esc={esc} client={client} />
              </section>
            ) : esc.state === 'decided' && changing ? (
              <section className="esc-section answer">
                <h4>Change decision</h4>
                <p className="hint">
                  Currently <strong>{esc.decision}</strong>. The agent acts on the new answer if it hasn't acknowledged yet.
                </p>
                <DecisionForm key={`${esc.id}-change`} esc={esc} client={client} change onDone={() => setChanging(false)} />
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
                {esc.state === 'decided' && (
                  <>
                    <AgentPresence esc={esc} lane={lane} now={now} staleMinutes={staleMinutes} />
                    <div className="actions">
                      {decisions && (
                        <button className="ghost" onClick={() => setChanging(true)}>
                          Change decision
                        </button>
                      )}
                      {/* For an answer no agent will pick up (its session ended): clear it from the list. */}
                      <button
                        className="ghost danger"
                        onClick={() => {
                          const why = prompt('Close this without the agent picking it up? Optional reason:');
                          if (why !== null) client.withdraw(esc.id, why).catch((e: Error) => setError(e.message));
                        }}
                      >
                        Dismiss
                      </button>
                    </div>
                  </>
                )}
                {esc.resolution && (
                  <p className="note">
                    {esc.state === 'withdrawn' ? 'Dismissed: ' : 'Agent: '}
                    {esc.resolution}
                  </p>
                )}
              </section>
            )}
            {nav}
          </div>
        )}
      </section>
    </div>
  );
}
