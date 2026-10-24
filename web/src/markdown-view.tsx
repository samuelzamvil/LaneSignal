import type { ReactNode } from 'react';
import { parseMarkdown, type Block, type Inline } from './markdown.ts';

function inlines(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text':
        return n.text.split('\n').flatMap((part, j) => (j ? [<br key={`${i}-${j}`} />, part] : [part]));
      case 'code':
        return <code key={i}>{n.text}</code>;
      case 'strong':
        return <strong key={i}>{inlines(n.children)}</strong>;
      case 'em':
        return <em key={i}>{inlines(n.children)}</em>;
      case 'del':
        return <del key={i}>{inlines(n.children)}</del>;
      case 'link':
        return (
          <a key={i} href={n.href} target="_blank" rel="noreferrer noopener">
            {inlines(n.children)}
          </a>
        );
    }
  });
}

function blocks(nodes: Block[]): ReactNode[] {
  return nodes.map((b, i) => {
    switch (b.t) {
      case 'heading': {
        const H = `h${Math.min(b.level + 1, 6)}` as 'h2';
        return <H key={i}>{inlines(b.children)}</H>;
      }
      case 'paragraph':
        return <p key={i}>{inlines(b.children)}</p>;
      case 'code':
        return (
          <pre key={i}>
            <code>{b.text}</code>
          </pre>
        );
      case 'quote':
        return <blockquote key={i}>{blocks(b.children)}</blockquote>;
      case 'rule':
        return <hr key={i} />;
      case 'table':
        return (
          <div key={i} className="md-table">
            <table>
              <thead>
                <tr>
                  {b.head.map((c, j) => (
                    <th key={j}>{inlines(c)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>
                    {r.map((c, k) => (
                      <td key={k}>{inlines(c)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case 'list': {
        const items = b.items.map((it, j) => (
          <li key={j} className={it.checked === null ? undefined : 'task'}>
            {it.checked !== null && <input type="checkbox" checked={it.checked} readOnly disabled />}
            {blocks(it.children)}
          </li>
        ));
        return b.ordered ? (
          <ol key={i} start={b.start}>
            {items}
          </ol>
        ) : (
          <ul key={i}>{items}</ul>
        );
      }
    }
  });
}

/** Markdown rendered as React elements: no HTML from the file ever reaches the page. */
export function MarkdownView({ text }: { text: string }) {
  return <div className="markdown">{blocks(parseMarkdown(text))}</div>;
}
