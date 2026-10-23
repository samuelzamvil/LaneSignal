import { useEffect, useState } from 'react';
import type { Client, Group, ProjectAccess, Requirement } from './api.ts';
import { RichText } from './components.tsx';
import { absolute } from './format.ts';
import { keyOf } from './merge.ts';

const STATUS_LABEL: Record<Requirement['status'], string> = {
  active: 'Active',
  superseded: 'Superseded',
  retired: 'Retired',
};

/** Wording, justification and tags; a change of meaning is a supersede, which agents record. */
function EditForm({ req, client, onDone }: { req: Requirement; client: Client; onDone: () => void }) {
  const [text, setText] = useState(req.requirement);
  const [why, setWhy] = useState(req.justification);
  const [tags, setTags] = useState(req.tags.join(', '));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await client.editRequirement(req.id, {
        requirement: text,
        justification: why,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="stack" onSubmit={save} onClick={(e) => e.stopPropagation()}>
      <textarea value={text} rows={3} onChange={(e) => setText(e.target.value)} aria-label="Requirement" required />
      <textarea value={why} rows={3} onChange={(e) => setWhy(e.target.value)} aria-label="Justification" required />
      <input value={tags} onChange={(e) => setTags(e.target.value)} aria-label="Tags, comma separated" />
      <p className="hint">Fix wording here. If the decision itself changed, the owner's new decision supersedes this one.</p>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button className="primary" disabled={busy}>
          Save
        </button>
        <button type="button" className="ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function RequirementCard({
  req,
  scopeName,
  sourceCode,
  client,
  canEdit,
  onTag,
  onOpen,
}: {
  req: Requirement;
  /** Where it applies: a group, a project, or every project. */
  scopeName: string;
  /** The cited escalation's code with its project key, so the link opens the right one. */
  sourceCode: string | null;
  client: Client;
  canEdit: boolean;
  onTag: (tag: string) => void;
  onOpen: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <article className={`req-card ${req.status}`}>
      <header className="esc-head">
        <span className="ref">{req.id}</span>
        <span className={`tag${req.project === null ? ' all-projects' : ''}`}>{scopeName}</span>
        {req.status !== 'active' && (
          <span className="pill tone-muted">
            {STATUS_LABEL[req.status]}
            {req.supersededBy && (
              <>
                {' by '}
                <button className="link" onClick={() => onOpen(req.supersededBy!)}>
                  {req.supersededBy}
                </button>
              </>
            )}
          </span>
        )}
      </header>
      {editing ? (
        <EditForm req={req} client={client} onDone={() => setEditing(false)} />
      ) : (
        <>
          <h3>{req.requirement}</h3>
          <RichText text={req.justification} />
          <div className="req-tags">
            {req.tags.map((t) => (
              <button key={t} className="chip-tag" onClick={() => onTag(t)}>
                {t}
              </button>
            ))}
          </div>
          <p className="muted small">
            Decided by {req.decidedBy}
            {req.sourceEscalation && (
              <>
                {' in '}
                <a href={`#/esc/${encodeURIComponent(sourceCode ?? req.sourceEscalation)}`}>{req.sourceEscalation}</a>
              </>
            )}{' '}
            · recorded by {req.recordedBy} · {absolute(req.createdAt)}
          </p>
          {canEdit && req.status === 'active' && (
            <div className="actions">
              <button className="ghost" onClick={() => setEditing(true)}>
                Edit wording
              </button>
              <button
                className="ghost danger"
                onClick={() => {
                  if (confirm(`Retire ${req.id}? It no longer applies, and nothing replaces it.`)) {
                    client.retireRequirement(req.id).catch((e: Error) => setError(e.message));
                  }
                }}
              >
                Retire
              </button>
            </div>
          )}
          {error && <p className="error">{error}</p>}
        </>
      )}
    </article>
  );
}

const LIMIT = 200;

/** The owner's product decisions: search, filter by train/epic and tag. */
export function RequirementsPane({
  client,
  groups,
  projects,
  project,
  groupLabel,
  canEdit,
  version,
}: {
  client: Client;
  /** Keyed by keyOf(project, id). */
  groups: Map<string, Group>;
  projects: ProjectAccess[];
  /** The project being viewed, or '' for all of them. */
  project: string;
  groupLabel: string;
  canEdit: boolean;
  /** Changes when a requirement changes, to refetch. */
  version: number;
}) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  /** keyOf(project, group), or ''. */
  const [group, setGroup] = useState('');
  const multiProject = projects.length > 1;
  const groupOptions = [...groups.entries()].filter(([, g]) => !project || g.project === project);
  const chosen = groups.get(group);
  // Switching projects drops a group filter from another project.
  useEffect(() => {
    if (group && (!chosen || (project && chosen.project !== project))) setGroup('');
  }, [project, group, chosen?.project]);
  const [tags, setTags] = useState<string[]>([]);
  const [showOld, setShowOld] = useState(false);
  const [items, setItems] = useState<Requirement[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    client
      .requirements({
        q: debounced || undefined,
        tags,
        project: chosen?.project ?? (project || undefined),
        group: chosen?.id,
        statuses: showOld ? ['active', 'superseded', 'retired'] : ['active'],
      })
      .then((r) => !cancelled && (setItems(r), setError(null)))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [client, debounced, chosen?.project, chosen?.id, project, tags, showOld, version]);

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const scopeOf = (r: Requirement) => {
    if (r.project === null) return 'All projects';
    const where = multiProject && !project ? `${projectName(r.project)} · ` : '';
    return r.group ? where + (groups.get(keyOf(r.project, r.group))?.name ?? r.group) : multiProject ? projectName(r.project) : 'Product-wide';
  };

  const open = (id: string) => {
    setQuery(id);
    setShowOld(true);
  };

  return (
    <section className="pane requirements" aria-label="Requirements">
      <h2>
        Requirements <span className="count">{items ? (items.length >= LIMIT ? `${LIMIT}+` : items.length) : '…'}</span>
      </h2>
      <p className="hint">Product decisions made by the owner, recorded by agents with the reasoning behind them.</p>
      <div className="filters">
        <input type="search" placeholder="Search decisions…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="filter-row">
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
          <label className="check">
            <input type="checkbox" checked={showOld} onChange={(e) => setShowOld(e.target.checked)} />
            Superseded &amp; retired
          </label>
        </div>
        {tags.length > 0 && (
          <div className="req-tags">
            {tags.map((t) => (
              <button key={t} className="chip-tag on" onClick={() => setTags(tags.filter((x) => x !== t))} aria-label={`Remove tag ${t}`}>
                {t} ✕
              </button>
            ))}
          </div>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {items && items.length === 0 && <p className="empty">No requirements match.</p>}
      {items && items.length >= LIMIT && (
        <p className="hint">Showing the first {LIMIT}. Search or filter to narrow it down.</p>
      )}
      {items?.map((r) => (
        <RequirementCard
          key={r.id}
          req={r}
          scopeName={scopeOf(r)}
          sourceCode={
            r.sourceEscalation && r.project && !/[·:-]/.test(r.sourceEscalation)
              ? `${projects.find((p) => p.id === r.project)?.key ?? r.project}-${r.sourceEscalation}`
              : r.sourceEscalation
          }
          client={client}
          canEdit={canEdit}
          onTag={(t) => setTags(tags.includes(t) ? tags : [...tags, t])}
          onOpen={open}
        />
      ))}
    </section>
  );
}
