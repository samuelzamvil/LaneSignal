import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parentChoices, productIdProblem, productSlug, productTree } from '../src/products.ts';

test('a slug never ends in a hyphen left by the 40-character cut', () => {
  const slug = productSlug(`${'a'.repeat(39)} b`);
  assert.equal(slug, 'a'.repeat(39));
  assert.match(slug, /^[a-z0-9]+(-[a-z0-9]+)*$/);
});

test('a slug is kebab-case', () => {
  assert.equal(productSlug('  Globex: the API! '), 'Globex-the-api');
});

const products = [
  { id: 'Acme', name: 'Acme-Web', archived: false },
  { id: 'old', name: 'Old one', archived: true },
];

test('a name whose id is held names the product holding it', () => {
  assert.match(productIdProblem('Acme', '', products)!, /"Acme-Web"/);
});

test('a typed id is what counts, in any case', () => {
  assert.equal(productIdProblem('Acme', 'Acme-suite', products), null);
  assert.match(productIdProblem('Anything', ' Acme ', products)!, /"Acme-Web"/);
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
  { id: 'gone', name: 'Gone', parent: null, archived: true },
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
