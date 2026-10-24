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

const INLINE = [
  { re: /^`([^`]+)`/, make: (m: RegExpExecArray): Inline => ({ t: 'code', text: m[1] }) },
  { re: /^\*\*(?=\S)([\s\S]*?\S)\*\*/, make: (m: RegExpExecArray): Inline => ({ t: 'strong', children: inline(m[1]) }) },
  { re: /^__(?=\S)([\s\S]*?\S)__/, make: (m: RegExpExecArray): Inline => ({ t: 'strong', children: inline(m[1]) }) },
  { re: /^~~(?=\S)([\s\S]*?\S)~~/, make: (m: RegExpExecArray): Inline => ({ t: 'del', children: inline(m[1]) }) },
  { re: /^\*(?=\S)([\s\S]*?\S)\*/, make: (m: RegExpExecArray): Inline => ({ t: 'em', children: inline(m[1]) }) },
  { re: /^_(?=\S)([\s\S]*?\S)_(?![A-Za-z0-9])/, make: (m: RegExpExecArray): Inline => ({ t: 'em', children: inline(m[1]) }) },
  {
    re: /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/,
    make: (m: RegExpExecArray): Inline => {
      const href = safeHref(m[2]);
      return href ? { t: 'link', href, children: inline(m[1]) } : { t: 'text', text: m[1] };
    },
  },
  { re: /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/, make: (m: RegExpExecArray): Inline => ({ t: 'link', href: m[0], children: [{ t: 'text', text: m[0] }] }) },
];

/** Inline formatting: code, bold, italics, strikethrough, links. */
export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  let plain = '';
  let i = 0;
  // Formatting starts at the beginning, after a non-word character, or anywhere for code and links.
  while (i < text.length) {
    const rest = text.slice(i);
    const prev = text[i - 1] ?? ' ';
    let matched = false;
    if (text[i] === '\\' && /[\\`*_[\]()~#>|-]/.test(text[i + 1] ?? '')) {
      plain += text[i + 1];
      i += 2;
      continue;
    }
    for (const { re, make } of INLINE) {
      const intraword = /[A-Za-z0-9]/.test(prev);
      if (intraword && (re.source.startsWith('^_') || re.source.startsWith('^__'))) continue;
      const m = re.exec(rest);
      if (m) {
        if (plain) out.push({ t: 'text', text: plain });
        plain = '';
        out.push(make(m));
        i += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      plain += text[i];
      i += 1;
    }
  }
  if (plain) out.push({ t: 'text', text: plain });
  return out;
}

const indentOf = (line: string) => line.match(/^ */)![0].length;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const isRule = (l: string) => /^ {0,3}([-*_])( *\1){2,} *$/.test(l);
const isFence = (l: string) => /^ {0,3}(```|~~~)/.test(l);
const isHeading = (l: string) => /^ {0,3}#{1,6}(\s|$)/.test(l);
const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l: string) =>
  l
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => inline(c.trim()));

/** Markdown text to blocks. */
export function parseMarkdown(text: string): Block[] {
  return blocks(text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
}

function blocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (isFence(line)) {
      const fence = line.trim().slice(0, 3);
      const lang = line.trim().slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
      i++; // the closing fence
      out.push({ t: 'code', lang, text: body.join('\n') });
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
    if (/^ {0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^ {0,3}> ?/, ''));
      out.push({ t: 'quote', children: blocks(body) });
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(line);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      out.push({ t: 'table', head, rows });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const [list, next] = parseList(lines, i);
      out.push(list);
      i = next;
      continue;
    }
    // A paragraph runs until a blank line or the start of another block.
    const body: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isFence(lines[i]) &&
      !isHeading(lines[i]) &&
      !isRule(lines[i]) &&
      !/^ {0,3}>/.test(lines[i]) &&
      !LIST_ITEM.exec(lines[i])
    ) {
      body.push(lines[i++].trim());
    }
    out.push({ t: 'paragraph', children: inline(body.join('\n')) });
  }
  return out;
}

/** A list starting at line `start`; items are the lines indented under each marker. */
function parseList(lines: string[], start: number): [Block, number] {
  const first = LIST_ITEM.exec(lines[start])!;
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: ListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST_ITEM.exec(lines[i]);
    if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
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
        const nextLine = lines.slice(i + 1).find((x) => x.trim());
        if (nextLine && indentOf(nextLine) > indent) {
          body.push('');
          i++;
          continue;
        }
        break;
      }
      if (indentOf(l) > indent) {
        body.push(l.slice(Math.min(indentOf(l), contentIndent)));
        i++;
        continue;
      }
      // A lazy continuation of the item's text.
      if (!LIST_ITEM.exec(l) && !isFence(l) && !isHeading(l) && !isRule(l) && body.length === 1) {
        body[0] += `\n${l.trim()}`;
        i++;
        continue;
      }
      break;
    }
    items.push({ checked, children: blocks(body) });
  }
  return [{ t: 'list', ordered, start: ordered ? parseInt(first[2], 10) : 1, items }, i];
}
