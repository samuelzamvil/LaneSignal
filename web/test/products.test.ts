import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupTitle, groupTitles, parentChoices, productGroups, productIdProblem, productSlug, productTree } from '../src/products.ts';

test('a slug never ends in a hyphen left by the 40-character cut', () => {
  const slug = productSlug(`${'a'.repeat(39)} b`);
  assert.equal(slug, 'a'.repeat(39));
  assert.match(slug, /^[a-z0-9]+(-[a-z0-9]+)*$/);
});

test('a slug is kebab-case', () => {
  assert.equal(productSlug('  Globex: the API! '), 'globex-the-api');
});

const products = [
  { id: 'acme', name: 'Acme-Web', archived: false },
  { id: 'old', name: 'Old one', archived: true },
];

test('a name whose id is held names the product holding it', () => {
  assert.match(productIdProblem('Acme', '', products)!, /"Acme-Web"/);
});

test('a typed id is what counts, in any case', () => {
  assert.equal(productIdProblem('Acme', 'acme-suite', products), null);
  assert.match(productIdProblem('Anything', ' ACME ', products)!, /"Acme-Web"/);
});

test('an archived holder can be unarchived', () => {
  assert.match(productIdProblem('Old', '', products)!, /unarchive/);
});

test('a name with no usable id asks for one; an empty form says nothing', () => {
  assert.match(productIdProblem('日本語', '', products)!, /type one/);
  assert.match(productIdProblem('A', '', products)!, /type one/);
  assert.equal(productIdProblem('日本語', 'japanese', products), null);
  assert.equal(productIdProblem('', '', products), null);
});

const tree = [
  { id: 'cloud-sdk', name: 'SDK', parent: 'cloud', archived: false },
  { id: 'bands', name: 'Acme', parent: null, archived: false },
  { id: 'cloud', name: 'Globex', parent: null, archived: false },
  { id: 'cloud-api', name: 'API', parent: 'cloud', archived: false },
  { id: 'gone', name: 'Abandoned', parent: null, archived: true },
];

test('the tree lists top-level products by name, each with its subprojects by name', () => {
  assert.deepEqual(
    productTree(tree).map((b) => [b.product.id, b.subprojects.map((p) => p.id)]),
    [['gone', []], ['bands', []], ['cloud', ['cloud-api', 'cloud-sdk']]],
  );
});

test('a subproject whose parent is missing still shows', () => {
  assert.deepEqual(productTree([{ id: 'x', name: 'X', parent: 'nope' }]).map((b) => b.product.id), ['x']);
});

test('a product can go under live top-level products, never itself or a subproject', () => {
  assert.deepEqual(parentChoices({ id: 'bands' }, tree).map((p) => p.id), ['cloud']);
  assert.deepEqual(parentChoices(null, tree).map((p) => p.id), ['bands', 'cloud']);
});

const shelf = [
  { id: 'bands', name: 'Acme', parent: null, archived: false, project: 'p' },
  { id: 'cloud', name: 'Globex', parent: null, archived: false, project: 'p' },
  { id: 'accounts', name: 'Globex-Accounts', parent: 'cloud', archived: false, project: 'p' },
  { id: 'licensing', name: 'Globex-Licensing', parent: 'cloud', archived: false, project: 'p' },
  { id: 'demo', name: 'Demo site', parent: 'cloud', archived: false, project: 'p' },
  { id: 'old', name: 'Old', parent: null, archived: true, project: 'p' },
];

test('a title reads from the tree', () => {
  assert.equal(groupTitle(['bands'], shelf), 'Acme');
  assert.equal(groupTitle(['licensing', 'accounts'], shelf), 'Globex › Accounts, Licensing');
  assert.equal(groupTitle(['demo'], shelf), 'Globex › Demo site', 'a name without the prefix stays whole');
  assert.equal(groupTitle(['cloud', 'accounts'], shelf), 'Globex', 'a product covers its subprojects');
  assert.equal(groupTitle(['cloud', 'bands'], shelf), 'Acme · Globex');
  assert.equal(groupTitle(['old'], shelf), null);
  assert.equal(groupTitle([], shelf), null);
});

test('a group is called by its products, and by its own name only to tell it apart', () => {
  const g = (name: string, products: string[], project = 'p') => ({ id: name, name, products, project });
  const one = g('Main train', ['bands']);
  const two = g('Print', ['cloud']);
  const three = g('Deletion', ['cloud']);
  const none = g('Loose', []);
  const elsewhere = g('Theirs', [], 'q');
  const titles = groupTitles([one, two, three, none, elsewhere], shelf);
  assert.equal(titles.get(one), 'Acme');
  assert.equal(titles.get(two), 'Globex · Print');
  assert.equal(titles.get(three), 'Globex · Deletion');
  assert.equal(titles.get(none), 'No product · Loose');
  assert.equal(titles.get(elsewhere), 'Theirs', 'a project with no products keeps the overseer\'s name');
});

test('a filter chip for a product with several boxes, counting its subprojects', () => {
  const g = (id: string, products: string[]) => ({ id, name: id, products, project: 'p' });
  const chips = productGroups([g('a', ['accounts']), g('b', ['cloud']), g('c', ['bands']), g('d', [])], shelf);
  assert.deepEqual([...chips.values()], [{ name: 'Globex', project: 'p', keys: ['p/a', 'p/b'] }]);
});

test('a catch-all group and a server without products keep their names', () => {
  const catchAll = { id: 'ungrouped', name: 'Ungrouped', products: [], project: 'p' };
  const older = { id: 'older', name: 'Older', project: 'p' } as unknown as typeof catchAll;
  const titles = groupTitles([catchAll, older], shelf);
  assert.equal(titles.get(catchAll), 'Ungrouped');
  assert.equal(titles.get(older), 'No product · Older');
  assert.deepEqual([...productGroups([older], shelf)], []);
});

test('a name only shortens at a word end', () => {
  const words = [
    { id: 'cloud', name: 'Cloud', parent: null, archived: false, project: 'p' },
    { id: 'cloudy', name: 'Cloudy', parent: 'cloud', archived: false, project: 'p' },
    { id: 'same', name: 'Cloud', parent: 'cloud', archived: false, project: 'p' },
  ];
  assert.equal(groupTitle(['cloudy'], words), 'Cloud › Cloudy');
  assert.equal(groupTitle(['same'], words), 'Cloud › Cloud');
});
