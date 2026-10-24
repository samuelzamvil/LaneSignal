import { useEffect, useState } from 'react';
import type { Client, Escalation, Group, Lane, ProjectAccess } from './api.ts';
import { absolute, ago } from './format.ts';
import { keyOf } from './merge.ts';

type Outcome = '' | 'answered' | 'dismissed';

/** One closed escalation: its code, question and how it ended. */
function HistoryRow({ esc, lane, now, showProject }: { esc: Escalation; lane: Lane | undefined; now: number; showProject: boolean }) {
  const outcome =
    esc.state === 'withdrawn'
      ? { label: 'Dismissed', text: esc.resolution, tone: 'muted' }
      : { label: esc.decision ?? 'Answered', text: esc.decisionNote, tone: esc.decision === 'Reject' ? 'reject' : esc.decision === 'Accept' ? 'accept' : 'other' };
  return (
    <a className="history-row" href={`#/history/${encodeURIComponent(esc.id)}`}>
      <span className="ref">{showProject ? `${esc.projectKey}·${esc.ref}` : esc.ref}</span>
      <span className="history-main">
        <span className="history-question">{esc.question}</span>
        <span className="history-meta">
          <span className={`outcome tone-${outcome.tone}`}>{outcome.label}</span>
          {outcome.text && <span className="history-note"> {outcome.text}</span>}
        </span>
        <span className="muted history-where">
          {lane?.name ?? esc.laneId}
          {esc.messageCount > 0 && ` · ${esc.messageCount} message${esc.messageCount > 1 ? 's' : ''}`} ·{' '}
          <span title={absolute(esc.updatedAt)}>{ago(esc.updatedAt, now)}</span>
        </span>
      </span>
    </a>
  );
}

/** Closed escalations: what was decided or dismissed, with search and filters. */
export function HistoryPane({
  client,
  groups,
  lanes,
  projects,
  project,
  groupLabel,
  now,
  version,
}: {
  client: Client;
  /** Keyed by keyOf(project, id). */
  groups: Map<string, Group>;
  lanes: Map<string, Lane>;
  projects: ProjectAccess[];
  /** The project being viewed, or '' for all of them. */
  project: string;
  groupLabel: string;
  now: number;
  /** Changes when escalations change, to refetch. */
  version: string;
}) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [outcome, setOutcome] = useState<Outcome>('');
  /** keyOf(project, group), or ''. */
  const [group, setGroup] = useState('');
  const [items, setItems] = useState<Escalation[] | null>(null);
  const [next, setNext] = useState<{ at: string; id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const multiProject = projects.length > 1;
  const groupOptions = [...groups.entries()].filter(([, g]) => !project || g.project === project);
  const chosen = groups.get(group);
  useEffect(() => {
    if (group && (!chosen || (project && chosen.project !== project))) setGroup('');
  }, [project, group, chosen?.project]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const filter = {
    q: debounced || undefined,
    project: chosen?.project ?? (project || undefined),
    group: chosen?.id,
    outcome: outcome || undefined,
  };

  useEffect(() => {
    let cancelled = false;
    client
      .history(filter)
      .then((r) => !cancelled && (setItems(r.items), setNext(r.next), setError(null)))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, debounced, chosen?.project, chosen?.id, project, outcome, version]);

  async function more() {
    if (!next) return;
    try {
      const r = await client.history({ ...filter, before: next });
      setItems((cur) => [...(cur ?? []), ...r.items]);
      setNext(r.next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="pane history" aria-label="History">
      <h2>History</h2>
      <div className="filters">
        <input type="search" placeholder="Search questions, answers and conversations…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="filter-row">
          <label>
            Outcome
            <select value={outcome} onChange={(e) => setOutcome(e.target.value as Outcome)}>
              <option value="">All</option>
              <option value="answered">Answered</option>
              <option value="dismissed">Dismissed</option>
            </select>
          </label>
          <label>
            {groupLabel}
            <select value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="">All</option>
              {groupOptions.map(([k, g]) => (
                <option key={k} value={k}>
                  {multiProject && !project ? `${projects.find((p) => p.id === g.project)?.key ?? g.project} · ${g.name}` : g.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {items && items.length === 0 && <p className="empty">{debounced || outcome || group ? 'Nothing matches.' : 'Nothing closed yet.'}</p>}
      <div className="history-list">
        {items?.map((e) => (
          <HistoryRow key={e.id} esc={e} lane={lanes.get(keyOf(e.project, e.laneId))} now={now} showProject={multiProject} />
        ))}
      </div>
      {next && (
        <button className="ghost load-more" onClick={() => void more()}>
          Show older
        </button>
      )}
    </section>
  );
}
