import { useCallback, useEffect, useRef, useState } from 'react';
import type { Client, Product, ProjectAccess } from './api.ts';
import { parentChoices, productIdProblem, productSlug, productTree } from './products.ts';

/** Saves a colour a moment after the picker stops moving, so dragging it doesn't send every step. */
function ColorInput({ label, value, onCommit }: { label: string; value: string; onCommit: (color: string) => Promise<boolean> }) {
  const [color, setColor] = useState(value);
  useEffect(() => setColor(value), [value]);
  // What leaving the page must still save, and what a refused colour goes back to.
  const latest = useRef({ color, value, onCommit });
  latest.current = { color, value, onCommit };
  const save = () => {
    const { color: picked, value: saved, onCommit: commit } = latest.current;
    if (picked.toLowerCase() === saved.toLowerCase()) return;
    void commit(picked).then((ok) => {
      if (!ok) setColor(latest.current.value);
    });
  };
  useEffect(() => {
    const t = setTimeout(save, 600);
    return () => clearTimeout(t);
  }, [color]);
  useEffect(() => save, []);
  return <input type="color" aria-label={label} value={color} onChange={(e) => setColor(e.target.value)} />;
}

function ProductRow({
  product: p,
  products,
  hasSubprojects,
  child,
  act,
  client,
  project,
}: {
  product: Product;
  products: Product[];
  hasSubprojects: boolean;
  child: boolean;
  act: (fn: () => Promise<unknown>) => Promise<boolean>;
  client: Client;
  project: string;
}) {
  // Its current parent stays on the list even when it couldn't be chosen now (it's archived).
  const parents = parentChoices(p, products);
  const current = products.find((o) => o.id === p.parent);
  if (current && !parents.includes(current)) parents.push(current);
  return (
    <div className={`product-row${child ? ' child' : ''}${p.archived ? ' archived' : ''}`}>
      <ColorInput
        label={`Colour of ${p.name}`}
        value={p.color ?? '#888888'}
        onCommit={(color) => act(() => client.updateProduct(project, p.id, { color }))}
      />
      <span className="product-name">
        <strong>{p.name}</strong> <span className="muted small">{p.id}</span>
        <span className="muted small">
          {' '}
          · {p.requirements} in force{p.archived ? ' · archived' : ''}
        </span>
      </span>
      <label className="product-parent">
        <span className="muted small">Under</span>
        <select
          aria-label={`Product ${p.name} is under`}
          value={p.parent ?? ''}
          disabled={hasSubprojects}
          title={hasSubprojects ? 'It has subprojects: move them first' : undefined}
          onChange={(e) => act(() => client.updateProduct(project, p.id, { parent: e.target.value || null }))}
        >
          <option value="">Nothing (top level)</option>
          {parents.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
              {o.archived ? ' (archived)' : ''}
            </option>
          ))}
        </select>
      </label>
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
  );
}

/** One project's product tree: products with their subprojects under them, to add, move, rename, recolour, lock and archive. */
function ProductTree({ client, project, version }: { client: Client; project: string; version: number }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [parent, setParent] = useState('');
  const [color, setColor] = useState('#3b82f6');
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      client
        .products(project, true)
        .then((list) => {
          setProducts(list);
          setLoadError(null);
        })
        .catch((e: Error) => setLoadError(e.message)),
    [client, project],
  );
  useEffect(() => {
    void load();
  }, [load, version]);

  const act = (fn: () => Promise<unknown>) => {
    setError(null);
    return fn()
      .then(() => true)
      .catch((e: Error) => {
        setError(e.message);
        return false;
      })
      .finally(() => void load());
  };
  const idProblem = productIdProblem(name, id, products);
  const newParents = parentChoices(null, products);
  // A parent picked before it moved or was archived is no longer on offer: don't send it unseen.
  const newParent = newParents.some((o) => o.id === parent) ? parent : '';

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.createProduct(project, { id: id.trim() || productSlug(name), name, color, ...(newParent ? { parent: newParent } : {}) });
      setName('');
      setId('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const row = (p: Product, child: boolean, hasSubprojects: boolean) => (
    <ProductRow key={p.id} product={p} products={products} hasSubprojects={hasSubprojects} child={child} act={act} client={client} project={project} />
  );
  return (
    <div className="products-panel">
      {productTree(products).map(({ product, subprojects }) => (
        <div key={product.id} className="product-branch">
          {row(product, false, subprojects.length > 0)}
          {subprojects.map((sub) => row(sub, true, false))}
        </div>
      ))}
      <form className="product-add inline-form" onSubmit={add}>
        <input type="color" aria-label="Colour" value={color} onChange={(e) => setColor(e.target.value)} />
        <input placeholder="Product name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} required />
        <input placeholder={productSlug(name) || 'id'} value={id} maxLength={40} onChange={(e) => setId(e.target.value)} aria-label="Product id" />
        <select aria-label="New product is under" value={newParent} onChange={(e) => setParent(e.target.value)}>
          <option value="">Top level</option>
          {newParents.map((o) => (
            <option key={o.id} value={o.id}>
              Under {o.name}
            </option>
          ))}
        </select>
        <button className="primary" disabled={busy || !name.trim() || !!idProblem}>
          Add
        </button>
      </form>
      {idProblem && <p className="hint">{idProblem}</p>}
      {error && <p className="error">{error}</p>}
      {loadError && <p className="error">{loadError}</p>}
    </div>
  );
}

/** Settings: the products requirements are scoped to, as a tree, for people who approve requirements. */
export function ProductsSection({ client, projects, version }: { client: Client; projects: ProjectAccess[]; version: number }) {
  const [chosen, setChosen] = useState('');
  const project = projects.find((p) => p.id === chosen)?.id ?? projects[0]?.id;
  if (!project) return null;
  return (
    <section className="settings-block">
      <h3>Products</h3>
      <p className="hint">
        Requirements apply globally, project-wide, or to the products you add here. A product can hold subprojects, one level
        deep. Agents can't add products. Lock one and agents can't add, change or move its requirements; you still can.
      </p>
      {projects.length > 1 && (
        <label className="product-project">
          Project{' '}
          <select value={project} onChange={(e) => setChosen(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <ProductTree key={project} client={client} project={project} version={version} />
    </section>
  );
}
