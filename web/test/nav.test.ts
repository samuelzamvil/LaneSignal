import assert from 'node:assert/strict';
import { test } from 'node:test';
import { labelFor, nextEntry } from '../src/nav.ts';

test('a screen opened in the app goes back to, and names, the screen it was opened from', () => {
  const esc = nextEntry({ hash: '#/', inApp: false }, false);
  assert.deepEqual(esc, { inApp: true, from: '#/' });
  assert.equal(labelFor(esc, '#/'), 'Needs you');
  const lane = nextEntry({ hash: '#/esc/A1', ...esc }, false);
  assert.equal(labelFor(lane, '#/lanes'), 'Escalation');
});

test('stepping to the next question keeps where the first came from', () => {
  const first = { hash: '#/esc/A1', inApp: true, from: '#/lanes' };
  assert.equal(labelFor(nextEntry(first, true), '#/'), 'Lanes');
  // A deep-linked question stays out of the app's history, so closing it goes to the fallback.
  const linked = nextEntry({ hash: '#/esc/A1', inApp: false }, true);
  assert.equal(linked.inApp, false);
  assert.equal(labelFor(linked, '#/'), 'Needs you');
});

test('a notification opening another escalation goes back to the open one', () => {
  const open = { hash: '#/esc/A1', inApp: true, from: '#/' };
  assert.equal(labelFor(nextEntry(open, false), '#/'), 'Escalation');
});

test("an entry that doesn't say where it came from is just Back", () => {
  assert.equal(labelFor({ inApp: true }, '#/lanes'), 'Back');
  assert.equal(labelFor(null, '#/lanes'), 'Lanes');
});

test('a ticket opened from a lane goes back to the lane', () => {
  const fromLane = nextEntry({ hash: '#/lane/p/slot-1', inApp: true, from: '#/lanes' }, false);
  assert.equal(labelFor(fromLane, '#/lanes'), 'Lane');
  const fromTicket = nextEntry({ hash: '#/ticket/p/redmine%3A500', inApp: true, from: '#/lane/p/slot-1' }, false);
  assert.equal(labelFor(fromTicket, '#/lanes'), 'Ticket');
});
