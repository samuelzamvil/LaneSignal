import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeFromAppLink } from '../src/deeplink.ts';

test('app links open the screen they name', () => {
  assert.equal(routeFromAppLink('lanesignal://esc/abc-123'), '#/esc/abc-123');
  assert.equal(routeFromAppLink('lanesignal://lane/default/auth'), '#/lane/default/auth');
  assert.equal(routeFromAppLink('lanesignal:///esc/abc'), '#/esc/abc');
  assert.equal(routeFromAppLink('lanesignal://somewhere-else'), '#/');
  assert.equal(routeFromAppLink('https://ls.example/#/esc/abc'), null);
});
