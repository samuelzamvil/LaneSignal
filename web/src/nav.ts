// In-app history. Entries created inside the app are tagged, so closing a sheet only goes "back"
// when back stays in the app (not to whatever site linked here), and each entry remembers the
// screen it was opened from, so a back button can say where it goes.

type Entry = { inApp: boolean; from?: string };

/** What kind of screen a hash is: stepping between two of the same kind keeps the original "from". */
const kindOf = (hash: string) => hash.replace(/^#\/?/, '').split('/')[0] || 'inbox';

const NAMES: Record<string, string> = {
  inbox: 'Inbox',
  lanes: 'Lanes',
  lane: 'Lane',
  esc: 'Escalation',
  reqs: 'Requirements',
  settings: 'Settings',
};

let current: { hash: string } & Entry = { hash: location.hash, inApp: false };
if (history.state === null) history.replaceState({ inApp: false } satisfies Entry, '');
else current = { hash: location.hash, ...(history.state as Entry) };

/** Call on every hashchange: tags new entries, and keeps track of the current one. */
export function trackEntry() {
  if (history.state === null) {
    // A new entry. Stepping to another screen of the same kind (the next question of a batch, which
    // replaces the entry) keeps where the first one came from.
    const entry: Entry =
      kindOf(current.hash) === kindOf(location.hash) ? { inApp: current.inApp, from: current.from } : { inApp: true, from: current.hash };
    history.replaceState(entry, '');
  }
  current = { hash: location.hash, ...(history.state as Entry) };
}

/** Close a sheet: step back if we navigated here in-app, otherwise go to `fallback`. */
export function closeTo(fallback: string) {
  if ((history.state as Entry | null)?.inApp) history.back();
  else location.replace(fallback);
}

/** The name of the screen `closeTo(fallback)` goes to, for the back button. */
export function backLabel(fallback: string) {
  const entry = history.state as Entry | null;
  const target = entry?.inApp && entry.from !== undefined ? entry.from : fallback;
  return NAMES[kindOf(target)] ?? 'Back';
}
