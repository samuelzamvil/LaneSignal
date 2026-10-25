import { createContext, useContext } from 'react';
import { linkTickets, type TicketLinks } from './tickets.ts';

/** The server's ticket templates, for linking refs like "#1234" in free text. */
export const TicketLinksContext = createContext<TicketLinks | null>(null);

/** Text with web addresses and ticket refs ("#1234", "redmine#1234") made clickable. */
export function LinkedText({ text }: { text: string }) {
  const links = useContext(TicketLinksContext);
  return linkTickets(text, links).map((p, i) =>
    p.t === 'link' ? (
      <a key={i} href={p.href} target="_blank" rel="noreferrer">
        {p.text}
      </a>
    ) : (
      p.text
    ),
  );
}
