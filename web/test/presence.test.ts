import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Group, GroupPresence } from '../src/api.ts';
import { applyEvent, type Entities } from '../src/merge.ts';
import { deliveryLine, overseerListening, presenceTitle, sessionHref } from '../src/presence.ts';

const presence = (state: GroupPresence['state'], sessions: GroupPresence['sessions'] = []): GroupPresence => ({
  state,
  since: state === 'disconnected' && !sessions.length ? null : '2026-11-05T10:00:00Z',
  sessions,
});

test('session ids that are web addresses are links; other names are not', () => {
  assert.equal(sessionHref('https://claude.ai/code/session_1'), 'https://claude.ai/code/session_1');
  assert.equal(sessionHref('HTTP://host/x'), 'http://host/x');
  assert.equal(sessionHref('wait:overseer'), null);
  assert.equal(sessionHref('javascript:alert(1)'), null);
  assert.equal(sessionHref('https://'), null);
});

test('whether what a person writes reaches the overseer now', () => {
  const owned = (state: GroupPresence['state']) => ({ overseer: 'overseer', presence: presence(state) });
  assert.equal(deliveryLine(undefined), null, 'nothing without presence');
  assert.match(deliveryLine(owned('listening'))!, /listening: it gets this now/);
  assert.match(deliveryLine(owned('reconnecting'))!, /when it reconnects/);
  assert.match(deliveryLine(owned('disconnected'))!, /when it reconnects/);
  assert.match(deliveryLine(owned('not_responding'))!, /isn't reading/);
});

test('a group nobody registered says nothing about an overseer while nobody is connected', () => {
  assert.equal(deliveryLine({ overseer: null, presence: presence('disconnected') }), null);
  assert.equal(overseerListening({ overseer: null, presence: presence('disconnected') }), undefined);
  // An agent waiting on it still shows.
  assert.equal(overseerListening({ overseer: null, presence: presence('listening') }), true);
});

test("an epic's question goes by its group's presence, and nothing is said without one", () => {
  assert.equal(overseerListening(undefined), undefined);
  assert.equal(overseerListening({ overseer: 'o' }), undefined);
  assert.equal(overseerListening({ overseer: 'o', presence: presence('listening') }), true);
  assert.equal(overseerListening({ overseer: 'o', presence: presence('reconnecting') }), false);
});

test('the chip tooltip lists the sessions', () => {
  const title = presenceTitle(
    presence('listening', [{ id: 'a', transport: 'wait', state: 'listening', since: '2026-11-05T10:00:00Z' }]),
    () => 'then',
  );
  assert.equal(title, 'Overseer listening since then\na (wait): listening');
  assert.equal(presenceTitle(presence('disconnected'), () => 'then'), 'Overseer disconnected');
});

test("a presence change applies though the group's updatedAt is the same", () => {
  const group: Group = {
    id: 'g',
    project: 'default',
    name: 'g',
    ticket: null,
    ticketUrl: null,
    links: [],
    products: [],
    agent: null,
    overseer: 'overseer',
    overseerSince: null,
    lastMessageId: null,
    lastAgentMessageId: null,
    overseerReadId: 0,
    statusLine: null,
    code: 'g',
    openEscalations: 0,
    blockingEscalations: 0,
    createdAt: '2026-11-05T09:00:00Z',
    updatedAt: '2026-11-05T09:00:00Z',
    presence: presence('disconnected'),
  };
  const empty: Entities = { groups: new Map(), lanes: new Map(), escalations: new Map(), tickets: new Map(), epics: new Map() };
  let s = applyEvent(empty, { type: 'group', group });
  s = applyEvent(s, {
    type: 'group',
    group: { ...group, presence: presence('listening') },
    presence: { from: 'disconnected', to: 'listening', reason: 'connected' },
  });
  assert.equal(s.groups.get('default/g')!.presence!.state, 'listening');
});
