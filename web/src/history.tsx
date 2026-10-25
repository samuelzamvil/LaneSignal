import { useEffect, useRef, useState } from 'react';
import type { Client, Escalation, Group, Lane, ProjectAccess } from './api.ts';
import { absolute, ago } from './format.ts';
import { keyOf } from './merge.ts';
import { openItem } from './nav.ts';
import { useStored } from './components.tsx';
import { hasLane, laneKeyOf } from './epic-views.tsx';

type Outcome = '' | 'answered' | 'dismissed';

/** One closed escalation: its code, question and how it ended. */
function HistoryRow({
  esc,
  lane,
  now,
  showProject,
  selected,
}: {
  esc: Escalation;
  lane: Lane | undefined;
  now: number;
  showProject: boolean;
  selected: boolean;
}) {
  const answered = { label: esc.decision ?? 'Answered', text: esc.decisionNote, tone: esc.decision === 'Reject' ? 'reject' : esc.decision === 'Accept' ? 'accept' : 'other' };
  // Answered, then dismissed by the agent instead of acknowledged: the answer still matters.
  const outcome =
    esc.state === 'withdrawn'
      ? esc.decision
        ? { ...answered, text: [esc.decisionNote, `then dismissed${esc.resolution ? `: ${esc.resolution}` : ''}`].filter(Boolean).join(' · ') }
        : { label: 'Dismissed', text: esc.resolution, tone: 'muted' }
      : answered;
  const href = `#/history/${encodeURIComponent(esc.id)}`;
  return (
    <a
      className={`history-row${selected ? ' selected' : ''}`}
      href={href}
      aria-current={selected ? 'page' : undefined}
      onClick={(e) => {
        e.preventDefault();
        openItem(href);
      }}
    >
      <span className="ref">{showProject ? `${esc.projectKey}·${esc.ref}` : esc.ref}</span>
      <span className="history-main">
        <span className="history-question">{esc.question}</span>
        <span className="history-meta">
          <span className={`outcome tone-${outcome.tone}`}>{outcome.label}</span>
          {outcome.text && <span className="history-note"> {outcome.text}</span>}
        </span>
        <span className="muted history-where">
          {hasLane(esc.laneId) ? (lane?.name ?? esc.laneId) : `◆ ${esc.epicName ?? 'epic'}`}
          {esc.ticketRef && ` · ticket ${esc.ticketRef}`}
          {hasLane(esc.laneId) && esc.epicName && ` · ◆ ${esc.epicName}`}
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
  selectedId,
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
  /** Changes when escalations close, to refresh. */
  version: string;
  /** The escalation open beside the list. */
  selectedId?: string;
}) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [outcome, setOutcome] = useState<Outcome>('');
  const [ticketFilter, setTicketFilter] = useStored<'all' | 'active'>('lanesignal.history.tickets', ['all', 'active'], 'all');
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
    activeTickets: ticketFilter === 'active' || undefined,
  };
  const filterKey = JSON.stringify(filter);
  /** The filter the list shows; a response for another one is dropped. */
  const shown = useRef('');
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    client
      .history(filter)
      .then((r) => {
        if (cancelled) return;
        if (shown.current === filterKey) {
          // Same filter, something closed: put the newest first and keep the older pages already loaded.
          setItems((cur) => [...r.items, ...(cur ?? []).filter((e) => !r.items.some((n) => n.id === e.id))]);
        } else {
          setItems(r.items);
          setNext(r.next);
        }
        shown.current = filterKey;
        setError(null);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, filterKey, version]);

  async function more() {
    if (!next || loadingMore) return;
    const key = filterKey;
    setLoadingMore(true);
    try {
      const r = await client.history({ ...filter, before: next });
      if (shown.current !== key) return;
      setItems((cur) => [...(cur ?? []), ...r.items.filter((e) => !(cur ?? []).some((c) => c.id === e.id))]);
      setNext(r.next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section className="pane history" aria-label="History">
      <h2>History</h2>
      <div className="filters">
        <input type="search" placeholder="Search questions, answers, conversations and tickets…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="filter-row">
          <label>
            Outcome
            <select value={outcome} onChange={(e) => setOutcome(e.target.value as Outcome)}>
              <option value="">All</option>
              <option value="answered">Answered</option>
              <option value="dismissed">Dismissed</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={ticketFilter === 'active'} onChange={(e) => setTicketFilter(e.target.checked ? 'active' : 'all')} />
            Active tickets only
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
      {items && items.length === 0 && (
        <p className="empty">{debounced || outcome || group || ticketFilter === 'active' ? 'Nothing matches.' : 'Nothing closed yet.'}</p>
      )}
      <div className="history-list">
        {items?.map((e) => (
          <HistoryRow
            key={e.id}
            esc={e}
            lane={lanes.get(laneKeyOf(e))}
            now={now}
            showProject={multiProject}
            selected={selectedId === e.id}
          />
        ))}
      </div>
      {next && (
        <button className="ghost load-more" disabled={loadingMore} onClick={() => void more()}>
          {loadingMore ? 'Loading…' : 'Show older'}
        </button>
      )}
    </section>
  );
}
