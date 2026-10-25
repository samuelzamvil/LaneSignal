import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkTickets, type TicketLinks } from '../src/tickets.ts';

const links: TicketLinks = {
  ticketTemplates: { redmine: 'https://redmine.example/issues/{id}', jira: 'https://jira.example/browse/{id}' },
  defaultTicketSystem: 'redmine',
};
/** Links only, as [text, href]. */
const hrefs = (text: string, l: TicketLinks | null = links) =>
  linkTickets(text, l).flatMap((p) => (p.t === 'link' ? [[p.text, p.href]] : []));

test('"#1234" links to the default system, "system#id" and "system:id" to that system', () => {
  assert.deepEqual(linkTickets('Fixed in #1234, see redmine#7 and Jira:PROJ-12.', links), [
    { t: 'text', text: 'Fixed in ' },
    { t: 'link', href: 'https://redmine.example/issues/1234', text: '#1234' },
    { t: 'text', text: ', see ' },
    { t: 'link', href: 'https://redmine.example/issues/7', text: 'redmine#7' },
    { t: 'text', text: ' and ' },
    { t: 'link', href: 'https://jira.example/browse/PROJ-12', text: 'Jira:PROJ-12' },
    { t: 'text', text: '.' },
  ]);
});

test('web addresses still link, and a "#12" inside one stays part of it', () => {
  assert.deepEqual(hrefs('see https://x.example/a#12 now'), [['https://x.example/a#12', 'https://x.example/a#12']]);
});

test('things that only look like refs stay text', () => {
  for (const text of [
    'PR#5',
    'a/#5',
    '&#38;',
    '#fff',
    '# heading',
    'note:5',
    'gh#12',
    '10:30',
    'ab##12',
    '#',
    'our #1 priority',
    'color #000',
    'version #12.5',
    'café#12',
  ]) {
    assert.deepEqual(hrefs(text), [], text);
  }
});

test('a web address right after "word:" still links, even when the word is a system', () => {
  assert.deepEqual(hrefs('see:https://x.example/a redmine:https://x.example/b'), [
    ['https://x.example/a', 'https://x.example/a'],
    ['https://x.example/b', 'https://x.example/b'],
  ]);
});

test('a sentence that runs on after an id does not join it', () => {
  assert.deepEqual(hrefs('redmine:1234.Then'), [['redmine:1234', 'https://redmine.example/issues/1234']]);
});

test('one-digit refs link when the system is named', () => {
  assert.deepEqual(hrefs('redmine#5'), [['redmine#5', 'https://redmine.example/issues/5']]);
});

test('refs at the start, end and next to brackets', () => {
  assert.deepEqual(hrefs('#10 (#20) [redmine:3]'), [
    ['#10', 'https://redmine.example/issues/10'],
    ['#20', 'https://redmine.example/issues/20'],
    ['redmine:3', 'https://redmine.example/issues/3'],
  ]);
});

test('with no templates, or none for the default system, plain refs stay text', () => {
  assert.deepEqual(hrefs('#12 redmine#3', null), []);
  assert.deepEqual(hrefs('#12 redmine#3', {}), []);
  assert.deepEqual(hrefs('#12 redmine#3', { ...links, defaultTicketSystem: 'missing' }), [
    ['redmine#3', 'https://redmine.example/issues/3'],
  ]);
});

test('a template that is not a web address never makes a link', () => {
  assert.deepEqual(hrefs('#12', { ticketTemplates: { x: 'javascript:alert({id})' }, defaultTicketSystem: 'x' }), []);
});

test('text without refs comes back whole', () => {
  assert.deepEqual(linkTickets('nothing here', links), [{ t: 'text', text: 'nothing here' }]);
  assert.deepEqual(linkTickets('', links), []);
});
