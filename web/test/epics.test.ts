import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeFromAppLink } from '../src/deeplink.ts';
import { epicShows, epicsOnScreen, groupLayout, laneEpic } from '../src/epics.ts';
import { labelFor, nextEntry } from '../src/nav.ts';
import { epic, lane, ticket } from './fixtures.ts';

const standIn = epic({ id: 1, ref: null, displayRef: null, code: 'g1', name: 'Group 1', standIn: true });

test("a group shows its stand-in until it has epics of its own, then those (oldest first)", () => {
  assert.deepEqual(epicsOnScreen('p/g1', [standIn]).map((e) => e.id), [1]);
  const real = [epic({ id: 9 }), epic({ id: 7 })];
  assert.deepEqual(epicsOnScreen('p/g1', [standIn, ...real]).map((e) => e.id), [7, 9]);
  assert.deepEqual(epicsOnScreen('p/other', [standIn, ...real]), []);
  assert.deepEqual(epicsOnScreen(null, [standIn]), []);
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
  // A stand-in's card holds the whole group; no lane is placed under it by ticket.
  assert.equal(laneEpic(lane({ ticketId: 1 }), [epic({ id: 7, standIn: true })], tickets), undefined);
});

test('an epic card shows without lanes when it has something to say', () => {
  assert.equal(epicShows(epic()), true);
  assert.equal(epicShows(standIn), false);
  assert.equal(epicShows({ ...standIn, statusLine: '2 of 3 lanes busy' }), true);
  assert.equal(epicShows({ ...standIn, openEscalations: 1 }), true);
  assert.equal(epicShows({ ...standIn, lastMessageId: 4 }), true);
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

test('a stand-in holds no lanes of its own: they sit directly in the box', () => {
  const tickets = new Map([['1', ticket({ id: 1, epicId: 1 })]]);
  const layout = groupLayout([lane({ ticketId: 1 })], [standIn], tickets, { showEmptyEpics: true, isQuiet: () => false });
  assert.deepEqual(layout.epics, []);
  assert.equal(layout.noEpic.length, 1);
});
