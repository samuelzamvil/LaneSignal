import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LaneEvent } from '../src/api.ts';
import { withSwitchMarkers } from '../src/switches.ts';

const ev = (id: number, kind: LaneEvent['kind'], message: string, at = '2026-10-01T00:00:00.000Z'): LaneEvent => ({
  id,
  laneId: 'l1',
  at,
  kind,
  message,
  actor: 'bot',
});

test('a ticket let go and the next taken read as one marker', () => {
  // Latest first, as the server sends them.
  const items = withSwitchMarkers([
    ev(4, 'status', 'blocked_human → active'),
    ev(3, 'ticket', 'Filled with 501'),
    ev(2, 'ticket', 'Parked 500: blocked on the vendor API'),
    ev(1, 'activity', 'Writing tests', '2026-09-30T00:00:00.000Z'),
  ]);
  assert.deepEqual(
    items.map((i) => (i.kind === 'switch' ? `switch: ${i.text}` : i.event.message)),
    ['blocked_human → active', 'switch: Parked 500: blocked on the vendor API · filled with 501', 'Writing tests'],
  );
});

test('a lone fill, release or wait is a marker of its own', () => {
  const items = withSwitchMarkers([
    ev(3, 'ticket', '946 waits on 945'),
    ev(2, 'ticket', 'Filled with 946', '2026-10-01T00:00:01.000Z'),
    ev(1, 'ticket', '945 done'),
  ]);
  assert.deepEqual(
    items.map((i) => (i.kind === 'switch' ? i.text : null)),
    ['946 waits on 945', 'Filled with 946', '945 done'],
  );
});
