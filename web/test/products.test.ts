import assert from 'node:assert/strict';
import { test } from 'node:test';
import { productIdProblem, productSlug } from '../src/products.ts';

test('a slug never ends in a hyphen left by the 40-character cut', () => {
  const slug = productSlug(`${'a'.repeat(39)} b`);
  assert.equal(slug, 'a'.repeat(39));
  assert.match(slug, /^[a-z0-9]+(-[a-z0-9]+)*$/);
});

test('a slug is kebab-case', () => {
  assert.equal(productSlug('  SplitCloud: the API! '), 'splitcloud-the-api');
});

const products = [
  { id: 'splitbands', name: 'SplitBands-Vector', archived: false },
  { id: 'old', name: 'Old one', archived: true },
];

test('a name whose id is held names the product holding it', () => {
  assert.match(productIdProblem('SplitBands', '', products)!, /"SplitBands-Vector"/);
});

test('a typed id is what counts, in any case', () => {
  assert.equal(productIdProblem('SplitBands', 'splitbands-suite', products), null);
  assert.match(productIdProblem('Anything', ' SPLITBANDS ', products)!, /"SplitBands-Vector"/);
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
