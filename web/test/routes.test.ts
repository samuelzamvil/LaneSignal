import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeFromAppLink } from '../src/deeplink.ts';
import { labelFor, nextEntry } from '../src/nav.ts';

test('History links open in the app, and closing goes back to History', () => {
  assert.equal(routeFromAppLink('lanesignal://history/abc'), '#/history/abc');
  const opened = nextEntry({ hash: '#/history', inApp: true, from: '#/' }, false);
  assert.equal(labelFor(opened, '#/history'), 'History');
  // Picking another item beside the open one replaces it: back still goes to History.
  assert.equal(labelFor(nextEntry({ hash: '#/history/abc', ...opened }, true), '#/history'), 'History');
});
