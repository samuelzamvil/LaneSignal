import { useEffect, useState } from 'react';
import type { Client, Group, ProjectAccess, Requirement } from './api.ts';
import { LayoutToggle, RichText, useLayout } from './components.tsx';
import { LinkedText } from './linked-text.tsx';
import { absolute } from './format.ts';
import { keyOf } from './merge.ts';

const STATUS_LABEL: Record<Requirement['status'], string> = {
  pending: 'Pending approval',
  active: 'Active',
  superseded: 'Superseded',
  retired: 'Retired',
  rejected: 'Rejected',
};

/** Still applies: approved, or waiting for a person's approval. */
const inForce = (r: Requirement) => r.status === 'pending' || r.status === 'active';

/**
 * Pending, superseded, retired or rejected (nothing for active, the usual case), and a replacement
 * waiting for approval: a requirement in force that names its successor.
 */
function StatusBadge({ req, onOpen }: { req: Requirement; onOpen?: (id: string) => void }) {
  const ref = (id: string) =>
    onOpen ? (
      <button className="link" onClick={() => onOpen(id)}>
        {id}
      </button>
    ) : (
      id
    );
  return (
    <>
      {req.status !== 'active' && (
        <span className={`pill ${req.status === 'pending' ? 'tone-info' : 'tone-muted'}`}>
          {STATUS_LABEL[req.status]}
          {req.status === 'superseded' && req.supersededBy && <> by {ref(req.supersededBy)}</>}
        </span>
      )}
      {inForce(req) && req.supersededBy && (
        <span className="pill tone-info">Replacement {ref(req.supersededBy)} pending</span>
      )}
    </>
  );
}

/** One line per requirement in the list layout; tapping it opens the full card in place. */
function RequirementRow({ req, scopeName, onToggle }: { req: Requirement; scopeName: string; onToggle: () => void }) {
  return (
    <button className={`req-row ${req.status}`} onClick={onToggle}>
      <span className="ref">{req.id}</span>
      <span className="req-row-main">
        <span className="req-row-text">{req.requirement}</span>
        <span className="muted req-row-scope">{scopeName}</span>
      </span>
      <StatusBadge req={req} />
    </button>
  );
}

/** Rejecting a pending record needs the reason, which is kept with it. */
function RejectForm({ req, client, onDone }: { req: Requirement; client: Client; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function reject(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.rejectRequirement(req.id, reason);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="stack" onSubmit={reject} onClick={(e) => e.stopPropagation()}>
      <textarea
        value={reason}
        rows={3}
        maxLength={2000}
        onChange={(e) => setReason(e.target.value)}
        aria-label="Why it is rejected"
        placeholder="Why is this rejected? (required)"
        required
        autoFocus
      />
      <p className="hint">Kept with {req.id} for history. Agents stop seeing it.</p>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button className="danger" disabled={busy || !reason.trim()}>
          Reject
        </button>
        <button type="button" className="ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

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
  replaces,
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
  /** The requirement in force that this pending change would replace, if any. */
  replaces?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <article className={`req-card ${req.status}`}>
      <header className="esc-head">
        <span className="ref">{req.id}</span>
        <span className={`tag${req.project === null ? ' all-projects' : ''}`}>{scopeName}</span>
        <StatusBadge req={req} onOpen={onOpen} />
        {replaces && (
          <span className="pill tone-info">
            Replaces{' '}
            <button className="link" onClick={() => onOpen(replaces)}>
              {replaces}
            </button>
          </span>
        )}
      </header>
      {editing ? (
        <EditForm req={req} client={client} onDone={() => setEditing(false)} />
      ) : (
        <>
          <h3>
            <LinkedText text={req.requirement} />
          </h3>
          <RichText text={req.justification} />
          {req.status === 'rejected' && req.rejectionReason && (
            <div className="req-rejection">
              <strong>Rejected:</strong> <LinkedText text={req.rejectionReason} />
            </div>
          )}
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
          {rejecting && <RejectForm req={req} client={client} onDone={() => setRejecting(false)} />}
          {canEdit && inForce(req) && !rejecting && (
            <div className="actions">
              {req.status === 'pending' && (
                <button className="primary" onClick={() => client.approveRequirement(req.id).catch((e: Error) => setError(e.message))}>
                  Approve
                </button>
              )}
              <button className="ghost" onClick={() => setEditing(true)}>
                Edit wording
              </button>
              {req.status === 'pending' ? (
                <button className="ghost danger" onClick={() => setRejecting(true)}>
                  Reject
                </button>
              ) : (
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
              )}
            </div>
          )}
          {canEdit && (req.status === 'retired' || req.status === 'rejected') && (
            <div className="actions">
              <button className="ghost" onClick={() => client.restoreRequirement(req.id).catch((e: Error) => setError(e.message))}>
                Restore
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
  const [pendingOnly, setPendingOnly] = useState(false);
  const [layout, setLayout] = useLayout('lanesignal.requirementsLayout');
  /** The row opened into a full card, in the list layout. */
  const [expanded, setExpanded] = useState<string | null>(null);
  const [items, setItems] = useState<Requirement[] | null>(null);
  /** Pending change id → the requirement in force it would replace, so approving shows what goes. */
  const [replaces, setReplaces] = useState<Map<string, string>>(new Map());
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
        statuses: pendingOnly ? ['pending'] : showOld ? ['pending', 'active', 'superseded', 'retired', 'rejected'] : ['pending', 'active'],
      })
      // The server pairs a pending change with the requirement it would replace; this filter shows the pending side only.
      .then((r) => {
        if (cancelled) return;
        setReplaces(new Map(r.filter((x) => x.supersededBy && (x.status === 'pending' || x.status === 'active')).map((x) => [x.supersededBy!, x.id])));
        setItems(pendingOnly ? r.filter((x) => x.status === 'pending') : r);
        setError(null);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [client, debounced, chosen?.project, chosen?.id, project, tags, showOld, pendingOnly, version]);

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const scopeOf = (r: Requirement) => {
    if (r.project === null) return 'All projects';
    const where = multiProject && !project ? `${projectName(r.project)} · ` : '';
    return r.group ? where + (groups.get(keyOf(r.project, r.group))?.name ?? r.group) : multiProject ? projectName(r.project) : 'Product-wide';
  };

  const open = (id: string) => {
    setQuery(id);
    setShowOld(true);
    setPendingOnly(false);
    setExpanded(id);
  };

  return (
    <section className="pane requirements" aria-label="Requirements">
      <div className="pane-head">
        <h2>
          Requirements <span className="count">{items ? (items.length >= LIMIT ? `${LIMIT}+` : items.length) : '…'}</span>
        </h2>
        <LayoutToggle layout={layout} onChange={setLayout} />
      </div>
      <p className="hint">
        Product decisions made by the owner, recorded by agents with the reasoning behind them. An agent's record stays
        pending until a person approves it.
      </p>
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
            <input
              type="checkbox"
              checked={showOld}
              onChange={(e) => (setShowOld(e.target.checked), e.target.checked && setPendingOnly(false))}
            />
            Superseded, retired &amp; rejected
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={pendingOnly}
              onChange={(e) => (setPendingOnly(e.target.checked), e.target.checked && setShowOld(false))}
            />
            Pending approval only
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
      <div className={layout === 'list' ? 'req-list' : undefined}>
        {items?.map((r) => {
          const card = (
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
              replaces={replaces.get(r.id)}
            />
          );
          if (layout === 'cards') return card;
          return (
            <div key={r.id}>
              <RequirementRow req={r} scopeName={scopeOf(r)} onToggle={() => setExpanded(expanded === r.id ? null : r.id)} />
              {expanded === r.id && card}
            </div>
          );
        })}
      </div>
    </section>
  );
}
