import type { Product } from './api.ts';

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
