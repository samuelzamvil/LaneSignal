import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockedMs, compareLanes, duration, isStale, needsHuman } from '../src/format.ts';
import { lane } from './fixtures.ts';

test('duration reads naturally from seconds to days', () => {
  assert.equal(duration(5_000), '5s');
  assert.equal(duration(5 * 60_000), '5m');
  assert.equal(duration(90 * 60_000), '1h 30m');
  assert.equal(duration(26 * 3_600_000), '1d 2h');
  assert.equal(duration(-1), '0s');
});

test('lanes needing a human sort first, then by status, then most recent', () => {
  const lanes = [
    lane({ id: 'idle', status: 'idle' }),
    lane({ id: 'active-old', status: 'active', updatedAt: '2026-10-01T00:00:00Z' }),
    lane({ id: 'active-new', status: 'active', updatedAt: '2026-10-02T00:00:00Z' }),
    lane({ id: 'blocked', status: 'blocked_human' }),
  ];
  assert.deepEqual(lanes.sort(compareLanes).map((l) => l.id), ['blocked', 'active-new', 'active-old', 'idle']);
});

test('a lane with an open escalation needs a human', () => {
  assert.equal(needsHuman(lane({ status: 'awaiting_agent', openEscalations: 1 })), true);
  assert.equal(needsHuman(lane()), false);
});

test('blocked time adds the current spell to earlier ones', () => {
  const now = Date.parse('2026-10-01T01:00:00Z');
  assert.equal(blockedMs(lane({ blockedTotalMs: 1000, blockedSince: '2026-10-01T00:00:00Z' }), now), 1000 + 3_600_000);
  assert.equal(blockedMs(lane({ blockedTotalMs: 1000 }), now), 1000);
});

test('working lanes go stale after the threshold; idle and blocked lanes do not', () => {
  const now = Date.parse('2026-10-01T01:00:00Z');
  assert.equal(isStale(lane({ status: 'active' }), now, 30), true);
  assert.equal(isStale(lane({ status: 'active' }), now, 120), false);
  assert.equal(isStale(lane({ status: 'idle' }), now, 30), false);
  assert.equal(isStale(lane({ status: 'active' }), now, 0), false);
});
