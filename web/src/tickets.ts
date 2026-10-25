// Ticket refs written in free text (messages, questions, justifications) become links, using the
// server's ticket templates: "#1234" goes to the default system, "redmine#1234" or "redmine:1234"
// to that system. Bare web addresses are linked too.

export type TicketLinks = { templates: Record<string, string>; defaultSystem: string | null };

export type TextPart = { t: 'text'; text: string } | { t: 'link'; href: string; text: string };

/**
 * One pass over the text, left to right:
 *  1. a web address (so "#12" inside a URL stays part of it);
 *  2. "system#id" or "system:id" (the id may be a key like PROJ-12);
 *  3. "#digits" at the start of a word ("PR#5", "a/#5" and "&#38;" are left alone).
 */
const PATTERN = /(https?:\/\/[^\s)]+)|\b([A-Za-z][\w-]*)[#:]([A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)*)\b|(?<![\w&/#])#(\d+)\b/g;

function ticketUrl(template: string, id: string): string | null {
  const url = template.replaceAll('{id}', encodeURIComponent(id));
  return /^https?:\/\//i.test(url) ? url : null;
}

/** Text split into plain runs and links. With no templates configured, only web addresses link. */
export function linkTickets(text: string, links: TicketLinks | null): TextPart[] {
  const systems = new Map(Object.entries(links?.templates ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const fallback = links?.defaultSystem ? systems.get(links.defaultSystem.toLowerCase()) : undefined;
  const out: TextPart[] = [];
  let plain = '';
  let last = 0;
  for (const m of text.matchAll(PATTERN)) {
    const [whole, url, system, id, bare] = m;
    let href: string | null = null;
    if (url) href = url;
    else if (system) {
      const template = systems.get(system.toLowerCase());
      href = template ? ticketUrl(template, id) : null;
    } else if (fallback) href = ticketUrl(fallback, bare);
    if (!href) continue;
    plain += text.slice(last, m.index);
    if (plain) out.push({ t: 'text', text: plain });
    plain = '';
    out.push({ t: 'link', href, text: whole });
    last = m.index + whole.length;
  }
  plain += text.slice(last);
  if (plain) out.push({ t: 'text', text: plain });
  return out;
}
