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

test('crafted links only ever reach the home screen', () => {
  assert.equal(routeFromAppLink('lanesignal://lane/%E0'), '#/');
  assert.equal(routeFromAppLink('lanesignal://esc/<script>'), '#/');
  assert.equal(routeFromAppLink('lanesignal://esc/a b'), '#/');
  assert.equal(routeFromAppLink('lanesignal://lane/default/a%20b'), '#/lane/default/a%20b');
});

test('the Cloudflare Access sign-in callback is left to the sign-in screen', () => {
  assert.equal(routeFromAppLink('lanesignal://oauth/callback?code=x&state=y'), null);
});
