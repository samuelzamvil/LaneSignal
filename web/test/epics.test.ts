import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeFromAppLink } from '../src/deeplink.ts';
import { epicsOnScreen, groupLayout, laneEpic } from '../src/epics.ts';
import { labelFor, nextEntry } from '../src/nav.ts';
import { epic, lane, ticket } from './fixtures.ts';

test("a group shows its epics, oldest first, or none", () => {
  assert.deepEqual(epicsOnScreen('p/g1', []), []);
  const real = [epic({ id: 9 }), epic({ id: 7 })];
  assert.deepEqual(epicsOnScreen('p/g1', real).map((e) => e.id), [7, 9]);
  assert.deepEqual(epicsOnScreen('p/other', real), []);
  assert.deepEqual(epicsOnScreen(null, real), []);
});

test("each lane is listed once: under its ticket's epic, or under the group", () => {
  const onScreen = [epic({ id: 7 }), epic({ id: 8 })];
  const tickets = new Map([
    ['1', ticket({ id: 1, epicId: 7 })],
    ['2', ticket({ id: 2, epicId: null })],
    // An epic that's closed (no longer on screen), or another group's.
    ['3', ticket({ id: 3, epicId: 99 })],
  ]);
  assert.equal(laneEpic(lane({ ticketId: 1 }), onScreen, tickets)?.id, 7);
  assert.equal(laneEpic(lane({ ticketId: 2 }), onScreen, tickets), undefined);
  assert.equal(laneEpic(lane({ ticketId: 3 }), onScreen, tickets), undefined);
  assert.equal(laneEpic(lane({ ticketId: null }), onScreen, tickets), undefined);
});

test('epic links open its sheet, and closing it goes back to Lanes', () => {
  assert.equal(routeFromAppLink('lanesignal://epic/default/7'), '#/epic/default/7');
  const opened = nextEntry({ hash: '#/lanes', inApp: true, from: '#/' }, false);
  assert.equal(labelFor(opened, '#/lanes'), 'Lanes');
  assert.equal(labelFor({ inApp: true, from: '#/epic/default/7' }, '#/lanes'), 'Epic');
});

test('inside a group box: each lane in one place, lanes with no epic apart, quiet ones folded', () => {
  const onScreen = [epic({ id: 7 }), epic({ id: 8 })];
  const tickets = new Map([
    ['1', ticket({ id: 1, epicId: 7 })],
    ['2', ticket({ id: 2, epicId: null })],
  ]);
  const working = lane({ id: 'working', ticketId: 1 });
  // An idle lane its epic holds stays under the epic: only lanes with no epic fold away.
  const idleUnder = lane({ id: 'idle-under', ticketId: 1, status: 'idle' });
  const loose = lane({ id: 'loose', ticketId: 2 });
  const empty = lane({ id: 'empty', status: 'idle' });
  const asked = lane({ id: 'asked', status: 'idle', openEscalations: 1 });
  const all = [working, idleUnder, loose, empty, asked];
  const isQuiet = (l: typeof empty) => l.status === 'idle' && l.openEscalations === 0;

  const layout = groupLayout(all, onScreen, tickets, { showEmptyEpics: true, isQuiet });
  assert.deepEqual(layout.epics.map((e) => [e.epic.id, e.lanes.map((l) => l.id)]), [[7, ['working', 'idle-under']], [8, []]]);
  assert.deepEqual(layout.noEpic.map((l) => l.id), ['loose', 'asked']);
  assert.deepEqual(layout.quiet.map((l) => l.id), ['empty']);
  const placed = [...layout.epics.flatMap((e) => e.lanes), ...layout.noEpic, ...layout.quiet];
  assert.equal(placed.length, all.length);
  assert.equal(new Set(placed).size, all.length);
});

test('a filter picking lanes leaves out epics with none of them', () => {
  const tickets = new Map([['1', ticket({ id: 1, epicId: 7 })]]);
  const layout = groupLayout([lane({ ticketId: 1 })], [epic({ id: 7 }), epic({ id: 8 })], tickets, { showEmptyEpics: false, isQuiet: () => false });
  assert.deepEqual(layout.epics.map((e) => e.epic.id), [7]);
});

test('a group with no epics holds its lanes directly in the box', () => {
  const tickets = new Map([['1', ticket({ id: 1, epicId: null })]]);
  const layout = groupLayout([lane({ ticketId: 1 })], [], tickets, { showEmptyEpics: true, isQuiet: () => false });
  assert.deepEqual(layout.epics, []);
  assert.equal(layout.noEpic.length, 1);
});
