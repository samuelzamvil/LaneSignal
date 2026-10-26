import { useEffect, useState } from 'react';
import type { Client, Group, Product, ProjectAccess, Requirement, RequirementChange, ScopeChoice } from './api.ts';
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

/** Products keyed by keyOf(project, id). */
type Products = Map<string, Product>;

/** Where a requirement applies, as chips: Global, Project-wide, or each product (in its colour, with a lock when locked). */
function ScopeChips({ req, products, projectName }: { req: Requirement; products: Products; projectName?: string }) {
  return (
    <>
      {req.scope === 'global' && <span className="tag all-projects">Global</span>}
      {req.scope === 'project' && <span className="tag">{projectName ? `${projectName} · ` : ''}Project-wide</span>}
      {req.scope === 'products' &&
        req.products.map((id) => {
          const p = products.get(keyOf(req.project ?? '', id));
          return (
            <span key={id} className="tag product-tag" style={p?.color ? { borderColor: p.color, color: p.color } : undefined}>
              {projectName ? `${projectName} · ` : ''}
              {p?.name ?? id}
              {p?.locked && <span aria-label="locked"> 🔒</span>}
            </span>
          );
        })}
      {req.needsRegrouping && <span className="pill tone-info">Needs scope</span>}
    </>
  );
}

/** Words for a scope, for a row or a history line. */
function scopeWords(scope: { scope: Requirement['scope']; products: string[] }, products: Products, project: string | null) {
  if (scope.scope === 'global') return 'Global';
  if (scope.scope === 'project') return 'Project-wide';
  return scope.products.map((id) => products.get(keyOf(project ?? '', id))?.name ?? id).join(', ');
}

/**
 * Global, Project-wide, or Products (then which ones). A global requirement moving into a project,
 * with several to choose from, says which.
 */
function ScopePicker({
  req,
  products,
  projects,
  defaultProject,
  client,
  onDone,
}: {
  req: Requirement;
  products: Products;
  projects: ProjectAccess[];
  /** The project being viewed, if one. */
  defaultProject: string;
  client: Client;
  onDone: () => void;
}) {
  const [scope, setScope] = useState<Requirement['scope']>(req.scope);
  const [project, setProject] = useState(req.project ?? (defaultProject || (projects.length === 1 ? projects[0].id : '')));
  const [chosen, setChosen] = useState<string[]>(req.products);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const options = [...products.values()].filter((p) => p.project === project && !p.archived);
  const choice = (): ScopeChoice => ({
    scope,
    ...(scope === 'products' ? { products: chosen } : {}),
    ...(scope !== 'global' && project !== req.project ? { project } : {}),
  });
  const ready = scope === 'global' || (!!project && (scope === 'project' || chosen.length > 0));
  async function send(approve: boolean) {
    setBusy(true);
    setError(null);
    try {
      if (approve) await client.approveRequirement(req.id, choice());
      else await client.setRequirementScope(req.id, choice());
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="scope-picker stack" onClick={(e) => e.stopPropagation()}>
      <label>
        Applies to
        <select value={scope} onChange={(e) => setScope(e.target.value as Requirement['scope'])}>
          <option value="global">Global (every project)</option>
          <option value="project">Project-wide</option>
          <option value="products">Products…</option>
        </select>
      </label>
      {scope !== 'global' && projects.length > 1 && req.project === null && (
        <label>
          Project
          <select value={project} onChange={(e) => (setProject(e.target.value), setChosen([]))}>
            <option value="">Choose…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {scope === 'products' && (
        <div className="scope-products">
          {options.length === 0 && <p className="hint">This project has no products yet. Add them under Products above.</p>}
          {options.map((p) => (
            <label key={p.id} className="check">
              <input
                type="checkbox"
                checked={chosen.includes(p.id)}
                onChange={(e) => setChosen(e.target.checked ? [...chosen, p.id] : chosen.filter((x) => x !== p.id))}
              />
              <span style={p.color ? { color: p.color } : undefined}>{p.name}</span>
              {p.locked && <span aria-label="locked"> 🔒</span>}
            </label>
          ))}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <div className="actions">
        {req.status === 'pending' && (
          <button className="primary" disabled={busy || !ready} onClick={() => void send(true)}>
            Save &amp; approve
          </button>
        )}
        <button className={req.status === 'pending' ? 'ghost' : 'primary'} disabled={busy || !ready} onClick={() => void send(false)}>
          Save scope
        </button>
        <button className="ghost" disabled={busy} onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Who moved a requirement where, for audits. */
function ScopeHistory({ req, client, products, version }: { req: Requirement; client: Client; products: Products; version: number }) {
  const [changes, setChanges] = useState<RequirementChange[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    client
      .requirementChanges(req.id)
      .then((c) => !cancelled && setChanges(c))
      .catch(() => !cancelled && setChanges([]));
    return () => {
      cancelled = true;
    };
  }, [client, req.id, version]);
  if (!changes?.length) return null;
  return (
    <ul className="scope-history muted small">
      {changes.map((c) => (
        <li key={c.id}>
          Scope changed from {scopeWords(c.from, products, c.from.project)} to {scopeWords(c.to, products, c.to.project)} by {c.actor} ·{' '}
          {absolute(c.at)}
        </li>
      ))}
    </ul>
  );
}

/**
 * The products requirements are scoped to, for a person to add, rename, recolour, lock and archive.
 * A locked product refuses agents' changes to its requirements.
 */
function ProductsPanel({ client, project, products }: { client: Client; project: string; products: Product[] }) {
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [color, setColor] = useState('#3b82f6');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const slug = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
  const act = (fn: () => Promise<unknown>) => {
    setError(null);
    fn().catch((e: Error) => setError(e.message));
  };
  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.createProduct(project, { id: id || slug(name), name, color });
      setName('');
      setId('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="products-panel">
      <summary>
        Products <span className="count">{products.length}</span>
      </summary>
      <p className="hint">
        Requirements apply globally, project-wide, or to the products you add here. Agents can't add products. Lock one
        and agents can't add, change or move its requirements; you still can.
      </p>
      {products.map((p) => (
        <div key={p.id} className={`product-row${p.archived ? ' archived' : ''}`}>
          <input
            type="color"
            aria-label={`Colour of ${p.name}`}
            value={p.color ?? '#888888'}
            onChange={(e) => act(() => client.updateProduct(project, p.id, { color: e.target.value }))}
          />
          <span className="product-name">
            <strong>{p.name}</strong> <span className="muted small">{p.id}</span>
            <span className="muted small">
              {' '}
              · {p.requirements} in force{p.archived ? ' · archived' : ''}
            </span>
          </span>
          <div className="actions">
            <button
              className="ghost"
              onClick={() => {
                const next = prompt('Rename product', p.name)?.trim();
                if (next && next !== p.name) act(() => client.updateProduct(project, p.id, { name: next }));
              }}
            >
              Rename
            </button>
            <button className={p.locked ? 'primary' : 'ghost'} onClick={() => act(() => client.updateProduct(project, p.id, { locked: !p.locked }))}>
              {p.locked ? '🔒 Locked' : 'Lock'}
            </button>
            <button className="ghost" onClick={() => act(() => client.updateProduct(project, p.id, { archived: !p.archived }))}>
              {p.archived ? 'Unarchive' : 'Archive'}
            </button>
          </div>
        </div>
      ))}
      <form className="product-add inline-form" onSubmit={add}>
        <input type="color" aria-label="Colour" value={color} onChange={(e) => setColor(e.target.value)} />
        <input placeholder="Product name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} required />
        <input placeholder={slug(name) || 'id'} value={id} maxLength={40} onChange={(e) => setId(e.target.value)} aria-label="Product id" />
        <button className="primary" disabled={busy || !name.trim()}>
          Add
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </details>
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

/**
 * Rejecting a pending record asks for confirmation with the reason, which is required and kept
 * with it: the same confirmation as answering an escalation.
 */
function RejectConfirm({ req, client, onDone }: { req: Requirement; client: Client; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function send() {
    setBusy(true);
    setError(null);
    try {
      await client.rejectRequirement(req.id, reason.trim());
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="answer-confirm tone-reject" onClick={(e) => e.stopPropagation()}>
      <p>
        Reject <strong>{req.id}</strong>?
        <span className="answer-means"> It's kept for history, and agents stop seeing it.</span>
      </p>
      <textarea
        autoFocus
        placeholder="Why it's rejected (required)"
        value={reason}
        maxLength={2000}
        rows={3}
        onChange={(e) => setReason(e.target.value)}
      />
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button className="primary" disabled={busy || !reason.trim()} onClick={() => void send()}>
          {busy ? 'Sending…' : `Reject ${req.id}`}
        </button>
        <button className="ghost" disabled={busy} onClick={onDone}>
          Back
        </button>
      </div>
    </div>
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
  canApprove,
  products,
  projects,
  project,
  projectName,
  version,
  onTag,
  onOpen,
  replaces,
}: {
  req: Requirement;
  /** Its train/epic, if it has one (from before products). */
  scopeName: string | null;
  canApprove: boolean;
  products: Products;
  projects: ProjectAccess[];
  /** The project being viewed, or ''. */
  project: string;
  /** Its project's name, where projects mix. */
  projectName?: string;
  version: number;
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
  const [scoping, setScoping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <article className={`req-card ${req.status}`}>
      <header className="esc-head">
        <span className="ref">{req.id}</span>
        <ScopeChips req={req} products={products} projectName={projectName} />
        {scopeName && <span className="tag">{scopeName}</span>}
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
            <p className="note">
              Rejected: <LinkedText text={req.rejectionReason} />
            </p>
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
          <ScopeHistory req={req} client={client} products={products} version={version} />
          {rejecting && <RejectConfirm req={req} client={client} onDone={() => setRejecting(false)} />}
          {scoping && (
            <ScopePicker req={req} products={products} projects={projects} defaultProject={project} client={client} onDone={() => setScoping(false)} />
          )}
          {canEdit && inForce(req) && !rejecting && !scoping && (
            <div className="actions">
              {req.status === 'pending' && (
                <button className="primary" onClick={() => client.approveRequirement(req.id).catch((e: Error) => setError(e.message))}>
                  Approve
                </button>
              )}
              {canApprove && (
                <button className="ghost" onClick={() => setScoping(true)}>
                  Change scope
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
  canApprove,
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
  /** Signed in (not a personal key): approves, rejects, rescopes, and manages products. */
  canApprove: boolean;
  /** Changes when a requirement or product changes, to refetch. */
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
  /** '', 'global', 'project', or 'product:<id>' (of the project being viewed). */
  const [scopeFilter, setScopeFilter] = useState('');
  const [regroupOnly, setRegroupOnly] = useState(false);
  const [productList, setProductList] = useState<Product[]>([]);
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

  // Archived ones too, so requirements' history still names them; pickers leave them out.
  useEffect(() => {
    let cancelled = false;
    client
      .products(undefined, true)
      .then((p) => !cancelled && setProductList(p))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, version]);
  const products: Products = new Map(productList.map((p) => [keyOf(p.project, p.id), p]));
  // Product filters and management need one project: the one being viewed, or the only one.
  const scopeProject = project || (projects.length === 1 ? projects[0].id : '');
  const projectProducts = productList.filter((p) => p.project === scopeProject);
  useEffect(() => {
    if (scopeFilter.startsWith('product:') && !projectProducts.some((p) => `product:${p.id}` === scopeFilter)) setScopeFilter('');
  }, [scopeProject, scopeFilter, productList]);

  useEffect(() => {
    let cancelled = false;
    client
      .requirements({
        q: debounced || undefined,
        tags,
        project: chosen?.project ?? (project || undefined),
        group: chosen?.id,
        scope: scopeFilter === 'global' || scopeFilter === 'project' ? scopeFilter : undefined,
        product: scopeFilter.startsWith('product:') ? scopeFilter.slice('product:'.length) : undefined,
        regroup: regroupOnly || undefined,
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
  }, [client, debounced, chosen?.project, chosen?.id, project, tags, showOld, pendingOnly, scopeFilter, regroupOnly, version]);

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  /** Its project's name, shown where projects mix. */
  const whereOf = (r: Requirement) => (r.project !== null && multiProject && !project ? projectName(r.project) : undefined);
  /** Its train/epic, kept from before products. */
  const groupOf = (r: Requirement) => (r.project && r.group ? (groups.get(keyOf(r.project, r.group))?.name ?? r.group) : null);
  const scopeLine = (r: Requirement) =>
    [whereOf(r), scopeWords(r, products, r.project), groupOf(r), r.needsRegrouping ? 'needs scope' : null].filter(Boolean).join(' · ');

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
        Rules every agent working on a project or product must follow, recorded with the owner's reasoning. Each applies
        globally, project-wide, or to chosen products. An agent's record stays pending until a person approves it.
      </p>
      {canApprove && scopeProject && <ProductsPanel client={client} project={scopeProject} products={projectProducts} />}
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
          <label>
            Scope
            <select value={scopeFilter} onChange={(e) => setScopeFilter(e.target.value)}>
              <option value="">All</option>
              <option value="global">Global</option>
              <option value="project">Project-wide</option>
              {projectProducts
                .filter((p) => !p.archived)
                .map((p) => (
                  <option key={p.id} value={`product:${p.id}`}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={regroupOnly} onChange={(e) => setRegroupOnly(e.target.checked)} />
            Needs scope only
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
              scopeName={groupOf(r)}
              sourceCode={
                r.sourceEscalation && r.project && !/[·:-]/.test(r.sourceEscalation)
                  ? `${projects.find((p) => p.id === r.project)?.key ?? r.project}-${r.sourceEscalation}`
                  : r.sourceEscalation
              }
              client={client}
              canEdit={canEdit}
              canApprove={canApprove}
              products={products}
              projects={projects}
              project={project}
              projectName={whereOf(r)}
              version={version}
              onTag={(t) => setTags(tags.includes(t) ? tags : [...tags, t])}
              onOpen={open}
              replaces={replaces.get(r.id)}
            />
          );
          if (layout === 'cards') return card;
          return (
            <div key={r.id}>
              <RequirementRow req={r} scopeName={scopeLine(r)} onToggle={() => setExpanded(expanded === r.id ? null : r.id)} />
              {expanded === r.id && card}
            </div>
          );
        })}
      </div>
    </section>
  );
}
