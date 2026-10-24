import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inline, parseMarkdown, safeHref } from '../src/markdown.ts';

test('a typical plan', () => {
  const doc = parseMarkdown(
    [
      '# Plan: drop legacy_role',
      '',
      'We **drop** the column in `0042`.',
      '',
      '1. Back up',
      '2. Migrate',
      '   - check reads',
      '   - [x] staging done',
      '',
      '| Step | Risk |',
      '|---|---|',
      '| Drop | low |',
      '',
      '```sql',
      'ALTER TABLE users DROP COLUMN legacy_role;',
      '```',
      '> Rollback needs a restore.',
      '---',
    ].join('\n'),
  );
  assert.deepEqual(
    doc.map((b) => b.t),
    ['heading', 'paragraph', 'list', 'table', 'code', 'quote', 'rule'],
  );
  const list = doc[2] as Extract<(typeof doc)[number], { t: 'list' }>;
  assert.equal(list.ordered, true);
  assert.equal(list.items.length, 2);
  const nested = list.items[1].children[1] as Extract<(typeof doc)[number], { t: 'list' }>;
  assert.equal(nested.t, 'list');
  assert.equal(nested.items[1].checked, true);
  assert.deepEqual((doc[4] as { lang: string }).lang, 'sql');
});

test('inline formatting', () => {
  assert.deepEqual(inline('a **b** *c* `d` ~~e~~'), [
    { t: 'text', text: 'a ' },
    { t: 'strong', children: [{ t: 'text', text: 'b' }] },
    { t: 'text', text: ' ' },
    { t: 'em', children: [{ t: 'text', text: 'c' }] },
    { t: 'text', text: ' ' },
    { t: 'code', text: 'd' },
    { t: 'text', text: ' ' },
    { t: 'del', children: [{ t: 'text', text: 'e' }] },
  ]);
  // snake_case words stay words
  assert.deepEqual(inline('legacy_role_id'), [{ t: 'text', text: 'legacy_role_id' }]);
});

test("links only go to web and mail addresses; HTML stays text", () => {
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('data:text/html,x'), null);
  assert.deepEqual(inline('[x](javascript:alert(1))')[0], { t: 'text', text: 'x' });
  assert.deepEqual(inline('[PR](https://github.com/o/r/pull/1)')[0], {
    t: 'link',
    href: 'https://github.com/o/r/pull/1',
    children: [{ t: 'text', text: 'PR' }],
  });
  const html = parseMarkdown('<script>alert(1)</script>');
  assert.deepEqual(html, [{ t: 'paragraph', children: [{ t: 'text', text: '<script>alert(1)</script>' }] }]);
});

test('large or hostile files parse quickly and never nest without limit', () => {
  const inputs = [
    '*a '.repeat(100_000),
    '**a '.repeat(50_000),
    '[a '.repeat(100_000),
    '- a\n\n'.repeat(50_000),
    `| a |\n${' '.repeat(100_000)}x`,
    '>'.repeat(20_000),
    `${'- '.repeat(20_000)}x`,
    `${'  '.repeat(5000)}- x`,
    `_${'a_'.repeat(50_000)}`,
    '\n'.repeat(500_000),
  ];
  for (const text of inputs) {
    const started = performance.now();
    parseMarkdown(text);
    const ms = performance.now() - started;
    assert.ok(ms < 1500, `${JSON.stringify(text.slice(0, 12))}… took ${Math.round(ms)} ms`);
  }
});

test('lists, fences and tables in common shapes', () => {
  const ol = parseMarkdown('1. a\n\n2. b');
  assert.equal(ol.length, 1);
  assert.equal((ol[0] as { items: unknown[] }).items.length, 2);
  const fence = parseMarkdown('````\n```js\ncode\n```\n````');
  assert.deepEqual(fence, [{ t: 'code', lang: '', text: '```js\ncode\n```' }]);
  const table = parseMarkdown('Plan:\n| a | b |\n|---|---|\n| 1 | 2 |');
  assert.deepEqual(table.map((b) => b.t), ['paragraph', 'table']);
});
