import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEvent, type Entities } from '../src/merge.ts';
import { escalation, lane } from './fixtures.ts';

const empty = (): Entities => ({ groups: new Map(), lanes: new Map(), escalations: new Map() });

test('lane events add and update lanes, but an older copy never wins', () => {
  let s = applyEvent(empty(), { type: 'lane', lane: lane({ updatedAt: '2026-10-01T00:00:02Z', activity: 'new' }) });
  s = applyEvent(s, { type: 'lane', lane: lane({ updatedAt: '2026-10-01T00:00:01Z', activity: 'old' }) });
  assert.equal(s.lanes.get('l1')?.activity, 'new');
  s = applyEvent(s, { type: 'lane', lane: lane({ updatedAt: '2026-10-01T00:00:02Z', activity: 'same time' }) });
  assert.equal(s.lanes.get('l1')?.activity, 'same time');
});

test('escalations stay while open or decided and leave once closed', () => {
  let s = applyEvent(empty(), { type: 'escalation', escalation: escalation() });
  assert.ok(s.escalations.has('e1'));
  s = applyEvent(s, { type: 'escalation', escalation: escalation({ state: 'decided', updatedAt: '2026-10-01T00:00:01Z' }) });
  assert.equal(s.escalations.get('e1')?.state, 'decided');
  s = applyEvent(s, { type: 'escalation', escalation: escalation({ state: 'acknowledged', updatedAt: '2026-10-01T00:00:02Z' }) });
  assert.ok(!s.escalations.has('e1'));
});

test('removing a lane drops it and its escalations', () => {
  let s = applyEvent(empty(), { type: 'lane', lane: lane() });
  s = applyEvent(s, { type: 'escalation', escalation: escalation() });
  s = applyEvent(s, { type: 'escalation', escalation: escalation({ id: 'e2', laneId: 'other' }) });
  s = applyEvent(s, { type: 'lane_deleted', id: 'l1' });
  assert.ok(!s.lanes.has('l1'));
  assert.deepEqual([...s.escalations.keys()], ['e2']);
});

test('group events add and remove groups', () => {
  const group = { id: 'g', name: 'G', ticket: null, ticketUrl: null, links: [], agent: null, createdAt: 'x', updatedAt: 'x' };
  let s = applyEvent(empty(), { type: 'group', group });
  assert.ok(s.groups.has('g'));
  s = applyEvent(s, { type: 'group_deleted', id: 'g' });
  assert.ok(!s.groups.has('g'));
});

test('applying an event does not mutate the previous state', () => {
  const before = empty();
  applyEvent(before, { type: 'lane', lane: lane() });
  assert.equal(before.lanes.size, 0);
});
