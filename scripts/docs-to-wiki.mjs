// Converts docs/ into GitHub wiki pages: README.md becomes Home.md, page links lose their .md,
// and links out of docs/ point at the repository on GitHub.
// Usage: node scripts/docs-to-wiki.mjs <docs dir> <wiki checkout> <repo URL, e.g. https://github.com/owner/repo>
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [src, out, repo] = process.argv.slice(2);
if (!src || !out || !repo) throw new Error('usage: docs-to-wiki.mjs <docs dir> <wiki checkout> <repo URL>');

const pageName = (file) => (file === 'README.md' ? 'Home' : file.replace(/\.md$/, ''));

function convert(text) {
  return text.replace(/\]\(([^)\s]+)\)/g, (whole, target) => {
    if (/^([a-z]+:|#)/i.test(target)) return whole;
    if (target.startsWith('../')) return `](${repo}/blob/main/${target.slice(3)})`;
    const page = target.match(/^([\w-]+)\.md(#.*)?$/);
    if (page) return `](${pageName(page[1] + '.md')}${page[2] ?? ''})`;
    return whole;
  });
}

for (const file of readdirSync(src).filter((f) => f.endsWith('.md'))) {
  writeFileSync(join(out, pageName(file) + '.md'), convert(readFileSync(join(src, file), 'utf8')));
}
writeFileSync(
  join(out, '_Footer.md'),
  `Published from [\`docs/\`](${repo}/tree/main/docs). Edit it there: changes made here are overwritten.\n`,
);
