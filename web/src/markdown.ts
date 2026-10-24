// A small Markdown parser for attached plans: the common syntax, as plain data. Raw HTML stays
// text, and links only open web or mail addresses, so a file can't run anything in the app.

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'code'; text: string }
  | { t: 'strong' | 'em' | 'del'; children: Inline[] }
  | { t: 'link'; href: string; children: Inline[] };

export type ListItem = { checked: boolean | null; children: Block[] };

export type Block =
  | { t: 'heading'; level: number; children: Inline[] }
  | { t: 'paragraph'; children: Inline[] }
  | { t: 'code'; lang: string; text: string }
  | { t: 'quote'; children: Block[] }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { t: 'rule' };

/** Only web and mail links; anything else (javascript:, data:, relative paths) is shown as text. */
export function safeHref(href: string): string | null {
  const h = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(h) ? h : null;
}

/** Delimited spans, longest delimiter first. */
const SPANS: { open: string; t: 'code' | 'strong' | 'del' | 'em' }[] = [
  { open: '`', t: 'code' },
  { open: '**', t: 'strong' },
  { open: '__', t: 'strong' },
  { open: '~~', t: 'del' },
  { open: '*', t: 'em' },
  { open: '_', t: 'em' },
];
const BARE_URL = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/;
const isWord = (c: string | undefined) => !!c && /[A-Za-z0-9]/.test(c);

/**
 * Inline formatting: code, bold, italics, strikethrough, links. Each opener looks for its closer
 * once (and a delimiter with no closer left is remembered), so long or hostile text stays linear.
 */
export function inline(text: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  const noCloser = new Set<string>();
  let plain = '';
  let i = 0;
  const flush = () => {
    if (plain) out.push({ t: 'text', text: plain });
    plain = '';
  };
  while (i < text.length) {
    const c = text[i];
    if (c === '\\' && /[\\`*_[\]()~#>|-]/.test(text[i + 1] ?? '')) {
      plain += text[i + 1];
      i += 2;
      continue;
    }
    let matched = false;
    if (depth < 8) {
      for (const { open, t } of SPANS) {
        if (!text.startsWith(open, i) || noCloser.has(open)) continue;
        // Underscores inside words (snake_case) aren't formatting.
        if (open[0] === '_' && isWord(text[i - 1])) continue;
        const from = i + open.length;
        if (t !== 'code' && (from >= text.length || /\s/.test(text[from]))) continue;
        const close = text.indexOf(open, from);
        if (close === -1) {
          noCloser.add(open);
          continue;
        }
        const body = text.slice(from, close);
        if (!body || (t !== 'code' && /\s/.test(body[body.length - 1]))) continue;
        if (open[0] === '_' && isWord(text[close + open.length])) continue;
        flush();
        out.push(t === 'code' ? { t, text: body } : { t, children: inline(body, depth + 1) });
        i = close + open.length;
        matched = true;
        break;
      }
    }
    if (!matched && c === '[' && !noCloser.has(']')) {
      const close = text.indexOf('](', i + 1);
      if (close === -1) noCloser.add(']');
      else {
        const end = text.indexOf(')', close + 2);
        const label = text.slice(i + 1, close);
        const href = end === -1 ? null : text.slice(close + 2, end).trim().split(/\s+/)[0];
        if (href !== null && label && !label.includes('\n') && !label.includes('[')) {
          flush();
          const safe = safeHref(href);
          out.push(safe ? { t: 'link', href: safe, children: inline(label, depth + 1) } : { t: 'text', text: label });
          i = end + 1;
          matched = true;
        }
      }
    }
    if (!matched && c === 'h' && !isWord(text[i - 1])) {
      const m = BARE_URL.exec(text.slice(i, i + 2048));
      if (m) {
        flush();
        out.push({ t: 'link', href: m[0], children: [{ t: 'text', text: m[0] }] });
        i += m[0].length;
        matched = true;
      }
    }
    if (!matched) {
      plain += c;
      i += 1;
    }
  }
  flush();
  return out;
}

const indentOf = (line: string) => line.match(/^ */)![0].length;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const isRule = (l: string) => /^ {0,3}([-*_])( *\1){2,} *$/.test(l);
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const isFence = (l: string) => FENCE.test(l);
const isHeading = (l: string) => /^ {0,3}#{1,6}(\s|$)/.test(l);
const isQuote = (l: string) => /^ {0,3}>/.test(l);
const isTableRow = (l: string) => {
  const t = l.trim();
  return t.length > 1 && t.startsWith('|') && t.endsWith('|');
};
const isTableSep = (l: string) => {
  const t = l.trim();
  if (!t.includes('-') || !/^[|:\- ]+$/.test(t)) return false;
  return t
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .every((c) => /^:?-{2,}:?$/.test(c.trim()));
};
const startsTable = (lines: string[], i: number) => isTableRow(lines[i]) && i + 1 < lines.length && isTableSep(lines[i + 1]);
const cells = (l: string) =>
  l
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => inline(c.trim()));

/** Lists and quotes nested deeper than this are shown as text, so no file can exhaust the stack. */
const MAX_DEPTH = 12;

/** Markdown text to blocks. */
export function parseMarkdown(text: string): Block[] {
  return blocks(text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'), 0);
}

/** The next non-blank line at or after `i` (lines.length if none). */
function nextNonBlank(lines: string[], i: number) {
  while (i < lines.length && !lines[i].trim()) i++;
  return i;
}

function blocks(lines: string[], depth: number): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const [, marks, lang] = fence;
      const closer = new RegExp(`^ {0,3}${marks[0] === '`' ? '`' : '~'}{${marks.length},}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !closer.test(lines[i])) body.push(lines[i++]);
      i++; // the closing fence
      out.push({ t: 'code', lang: lang.trim(), text: body.join('\n') });
      continue;
    }
    if (isHeading(line)) {
      const m = /^ {0,3}(#{1,6})\s*(.*?)\s*#*\s*$/.exec(line)!;
      out.push({ t: 'heading', level: m[1].length, children: inline(m[2]) });
      i++;
      continue;
    }
    if (isRule(line)) {
      out.push({ t: 'rule' });
      i++;
      continue;
    }
    if (isQuote(line) && depth < MAX_DEPTH) {
      const body: string[] = [];
      while (i < lines.length && isQuote(lines[i])) body.push(lines[i++].replace(/^ {0,3}> ?/, ''));
      out.push({ t: 'quote', children: blocks(body, depth + 1) });
      continue;
    }
    if (startsTable(lines, i)) {
      const head = cells(line);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      out.push({ t: 'table', head, rows });
      continue;
    }
    if (LIST_ITEM.test(line) && depth < MAX_DEPTH) {
      const [list, next] = parseList(lines, i, depth);
      out.push(list);
      i = next;
      continue;
    }
    // A paragraph runs until a blank line or the start of another block.
    const body: string[] = [lines[i++].trim()];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isFence(lines[i]) &&
      !isHeading(lines[i]) &&
      !isRule(lines[i]) &&
      !isQuote(lines[i]) &&
      !startsTable(lines, i) &&
      !LIST_ITEM.test(lines[i])
    ) {
      body.push(lines[i++].trim());
    }
    out.push({ t: 'paragraph', children: inline(body.join('\n')) });
  }
  return out;
}

/** A list starting at line `start`; items are the lines indented under each marker. */
function parseList(lines: string[], start: number, depth: number): [Block, number] {
  const first = LIST_ITEM.exec(lines[start])!;
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: ListItem[] = [];
  const sibling = (l: string | undefined) => {
    const m = l === undefined ? null : LIST_ITEM.exec(l);
    return !!m && m[1].length === indent && /\d/.test(m[2]) === ordered;
  };
  let i = start;
  while (i < lines.length && sibling(lines[i])) {
    const m = LIST_ITEM.exec(lines[i])!;
    let content = m[3];
    let checked: boolean | null = null;
    const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
    if (task) {
      checked = task[1] !== ' ';
      content = task[2];
    }
    const body = [content];
    const contentIndent = indent + m[2].length + 1;
    i++;
    // Continuation lines and nested lists: indented past the marker, or blank lines inside the item.
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        const j = nextNonBlank(lines, i);
        if (j < lines.length && indentOf(lines[j]) > indent) {
          for (; i < j; i++) body.push('');
          continue;
        }
        // Blank lines between items keep one list ("1. a", blank, "2. b").
        if (sibling(lines[j])) i = j;
        break;
      }
      if (indentOf(l) > indent) {
        body.push(l.slice(Math.min(indentOf(l), contentIndent)));
        i++;
        continue;
      }
      // A lazy continuation of the item's text.
      if (!LIST_ITEM.test(l) && !isFence(l) && !isHeading(l) && !isRule(l) && body.length === 1) {
        body[0] += `\n${l.trim()}`;
        i++;
        continue;
      }
      break;
    }
    items.push({ checked, children: blocks(body, depth + 1) });
  }
  return [{ t: 'list', ordered, start: ordered ? parseInt(first[2], 10) : 1, items }, i];
}
