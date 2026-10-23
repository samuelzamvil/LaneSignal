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
