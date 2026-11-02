import type { Group, Product } from './api.ts';
import { keyOf } from './merge.ts';

/** The id a product's name suggests: kebab-case, within the server's 40 characters. */
export const productSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');

/**
 * What stops a new product being added, before asking the server: the id it would take (the typed
 * one, or what its name suggests) is held by another product, or the name suggests no usable id.
 */
export function productIdProblem(name: string, id: string, products: Pick<Product, 'id' | 'name' | 'archived'>[]): string | null {
  const typed = id.trim().toLowerCase();
  const wanted = typed || productSlug(name);
  if (!name.trim()) return null;
  if (wanted.length < 2) return 'This name doesn\'t make an id: type one, like "billing".';
  const holder = products.find((p) => p.id === wanted);
  if (!holder) return null;
  return holder.archived
    ? `The id "${wanted}" belongs to the archived product "${holder.name}": unarchive it or type another id.`
    : `The id "${wanted}" belongs to "${holder.name}": ids stay the same when a product is renamed, so type another id.`;
}

/** Products as a tree: top-level ones by name, each with its subprojects by name. A subproject whose parent isn't listed sits at the top. */
export function productTree<P extends Pick<Product, 'id' | 'name' | 'parent'>>(products: P[]): { product: P; subprojects: P[] }[] {
  const byName = (a: P, b: P) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  const ids = new Set(products.map((p) => p.id));
  return products
    .filter((p) => p.parent === null || !ids.has(p.parent))
    .sort(byName)
    .map((product) => ({ product, subprojects: products.filter((p) => p.parent === product.id).sort(byName) }));
}

/** What a product can go under: live top-level products other than itself. `null` for a product being added. */
export function parentChoices<P extends Pick<Product, 'id' | 'parent' | 'archived'>>(product: Pick<Product, 'id'> | null, products: P[]): P[] {
  return products.filter((p) => p.parent === null && !p.archived && p.id !== product?.id);
}

/** A subproject's name without its product's: "Globex-Accounts" under Globex reads "Accounts". */
const shortName = (name: string, parent: string) => {
  if (!name.toLowerCase().startsWith(parent.toLowerCase())) return name;
  const rest = name.slice(parent.length);
  // Only at a word's end: "Cloudy" under "Cloud" stays whole.
  return /^[\s\-:·]+\S/.test(rest) ? rest.replace(/^[\s\-:·]+/, '') : name;
};

type Titled = Pick<Product, 'id' | 'name' | 'parent' | 'archived' | 'project'>;
type Grouped = Pick<Group, 'id' | 'project' | 'name' | 'products'>;

/** A project's catch-all for lanes with no group: no overseer picks products for it, so it keeps its name. */
export const isCatchAll = (g: Pick<Group, 'id'>) => g.id === 'ungrouped';

/**
 * A group's title from its products: "Acme", "Globex › Accounts, Licensing", or both joined
 * by " · ". A product it names itself covers its subprojects. Null when it names no live product.
 */
export function groupTitle(linked: string[], products: Titled[]): string | null {
  const live = products.filter((p) => linked.includes(p.id) && !p.archived);
  const whole = live.filter((p) => !p.parent || !live.some((o) => o.id === p.parent));
  const branches = new Map<string, string[]>();
  for (const p of whole) {
    const parent = p.parent ? products.find((o) => o.id === p.parent) : undefined;
    const top = parent?.name ?? p.name;
    const subs = branches.get(top) ?? [];
    if (parent) subs.push(shortName(p.name, parent.name));
    branches.set(top, subs);
  }
  if (!branches.size) return null;
  return [...branches]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .map(([top, subs]) => (subs.length ? `${top} › ${[...subs].sort().join(', ')}` : top))
    .join(' · ');
}

/**
 * What each group is called on the dashboard. Its products' title, with its overseer's own name added
 * when another group has the same title, or "No product" when it has none. Where a project has no
 * products at all, the overseer's name stands.
 */
export function groupTitles<G extends Grouped>(groups: G[], products: Titled[]): Map<G, string> {
  const titled = groups.map((g) => {
    const own = products.filter((p) => p.project === g.project);
    // An older server sends no products.
    return { g, title: groupTitle(g.products ?? [], own), hasProducts: !isCatchAll(g) && own.some((p) => !p.archived) };
  });
  const count = (project: string, title: string | null) => titled.filter((t) => t.g.project === project && t.title === title).length;
  return new Map(
    titled.map(({ g, title, hasProducts }) => [
      g,
      !hasProducts ? g.name : title === null ? `No product · ${g.name}` : count(g.project, title) > 1 ? `${title} · ${g.name}` : title,
    ]),
  );
}

/**
 * Filter chips for a product shared by several boxes: its name and the groups under it (linked to it
 * or to its subprojects). A product with one box needs no chip of its own: that box's chip does it.
 */
export function productGroups<G extends Grouped>(groups: G[], products: Titled[]): Map<string, { name: string; project: string; keys: string[] }> {
  const found = new Map<string, { name: string; project: string; keys: string[] }>();
  for (const g of groups) {
    const own = products.filter((p) => p.project === g.project && !p.archived);
    const linked = g.products ?? [];
    const tops = new Set(own.filter((p) => linked.includes(p.id)).map((p) => (p.parent ? own.find((o) => o.id === p.parent)?.name : p.name)));
    for (const top of tops) {
      if (!top) continue;
      const key = keyOf(g.project, top);
      const chip = found.get(key) ?? { name: top, project: g.project, keys: [] };
      chip.keys.push(keyOf(g.project, g.id));
      found.set(key, chip);
    }
  }
  return new Map([...found].filter(([, chip]) => chip.keys.length > 1));
}
