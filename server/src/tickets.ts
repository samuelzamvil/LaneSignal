/**
 * Turns a ticket reference into a URL using configured templates.
 *
 *   "redmine:1234" -> templates.redmine with {id}=1234
 *   "#42" / "42"   -> default system's template
 *   "https://..."  -> used as-is
 */
export function ticketResolver(templates: Record<string, string>, defaultSystem: string | null) {
  return (ticket: string): string | null => {
    const ref = ticket.trim();
    if (/^https?:\/\//i.test(ref)) return ref;
    const i = ref.indexOf(':');
    let system = defaultSystem;
    let id = ref;
    if (i > 0 && templates[ref.slice(0, i)]) {
      system = ref.slice(0, i);
      id = ref.slice(i + 1);
    }
    const template = system ? templates[system] : undefined;
    if (!template) return null;
    id = id.replace(/^#/, '');
    return template.replaceAll('{id}', encodeURIComponent(id));
  };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One canonical form per ticket, so the forms agents mix ("967", "#967", "redmine:967", the
 * issue's URL) are one ticket:
 *
 *   "967" / "#967"                  -> "<default system>:967" (just "967" with no default system)
 *   "Redmine:#967"                  -> "redmine:967" (a configured system keeps its configured case)
 *   a URL one template produces     -> "<system>:<id>"
 *   any other URL                   -> unchanged
 *
 * `display` turns a canonical ref back into its short form: the default system's refs lose
 * their prefix ("967"), others keep it ("gh:632").
 */
export function ticketRefs(templates: Record<string, string>, defaultSystem: string | null) {
  const systems = new Map(Object.keys(templates).map((k) => [k.toLowerCase(), k]));
  const patterns = Object.entries(templates).flatMap(([system, template]) => {
    const i = template.indexOf('{id}');
    if (i < 0) return [];
    const re = new RegExp(`^${escapeRegExp(template.slice(0, i))}([^/?#]+)${escapeRegExp(template.slice(i + 4))}$`, 'i');
    return [{ system, re }];
  });
  const canonical = (raw: string): string => {
    const ref = raw.trim();
    if (/^https?:\/\//i.test(ref)) {
      for (const { system, re } of patterns) {
        const m = re.exec(ref);
        if (!m) continue;
        try {
          return `${system}:${decodeURIComponent(m[1])}`;
        } catch {
          return `${system}:${m[1]}`;
        }
      }
      return ref;
    }
    const i = ref.indexOf(':');
    if (i > 0) {
      const name = ref.slice(0, i).trim();
      const system = systems.get(name.toLowerCase()) ?? name.toLowerCase();
      return `${system}:${ref.slice(i + 1).trim().replace(/^#/, '')}`;
    }
    const id = ref.replace(/^#/, '');
    return defaultSystem ? `${defaultSystem}:${id}` : id;
  };
  const display = (ref: string): string =>
    defaultSystem && ref.startsWith(`${defaultSystem}:`) ? ref.slice(defaultSystem.length + 1) : ref;
  return { canonical, display };
}

export type TicketRefs = ReturnType<typeof ticketRefs>;
