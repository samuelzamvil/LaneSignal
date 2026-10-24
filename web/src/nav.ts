// In-app history. Entries created inside the app are tagged, so closing a sheet only goes "back"
// when back stays in the app (not to whatever site linked here), and each entry remembers the
// screen it was opened from, so a back button can say where it goes.

export type Entry = { inApp: boolean; from?: string };

/** What kind of screen a hash is. */
const kindOf = (hash: string) => hash.replace(/^#\/?/, '').split('/')[0] || 'inbox';

const NAMES: Record<string, string> = {
  inbox: 'Needs you',
  lanes: 'Lanes',
  lane: 'Lane',
  esc: 'Escalation',
  reqs: 'Requirements',
  history: 'History',
  settings: 'Settings',
};

/**
 * The entry for a new history entry. A step (the next question of a batch, which replaces the
 * current entry) keeps where the first one came from, and whether back stays in the app; anything
 * else was opened from the current screen.
 */
export function nextEntry(current: { hash: string } & Entry, stepping: boolean): Entry {
  return stepping ? { inApp: current.inApp, from: current.from } : { inApp: true, from: current.hash };
}

/** The name of the screen closing goes to: back in the app, or `fallback`. */
export function labelFor(entry: Entry | null, fallback: string) {
  if (!entry?.inApp) return NAMES[kindOf(fallback)] ?? 'Back';
  // An entry from before entries remembered where they came from.
  if (entry.from === undefined) return 'Back';
  return NAMES[kindOf(entry.from)] ?? 'Back';
}

let current: { hash: string } & Entry = { hash: '', inApp: false };
let stepping = false;
if (typeof history !== 'undefined') {
  if (history.state === null) history.replaceState({ inApp: false } satisfies Entry, '');
  current = { hash: location.hash, ...(history.state as Entry) };
}

/** Call on every hashchange: tags new entries, and keeps track of the current one. */
export function trackEntry() {
  if (history.state === null) history.replaceState(nextEntry(current, stepping), '');
  stepping = false;
  current = { hash: location.hash, ...(history.state as Entry) };
}

/** Whether an escalation or lane is open (a sheet, or the right pane on desktop). */
const sheetOpen = () => /^#\/(esc|lane)\//.test(location.hash) || /^#\/history\/[^/]+/.test(location.hash);

/**
 * Opens an escalation or lane. With one already open (picking another from the list beside it on
 * desktop), it takes that one's place, so back and close still return to the list.
 */
export function openItem(hash: string) {
  if (sheetOpen()) stepTo(hash);
  else location.hash = hash;
}

/** Move to a sibling screen (e.g. the next question) in place of this one. */
export function stepTo(hash: string) {
  if (hash === location.hash) return; // no hashchange would clear the flag
  stepping = true;
  location.replace(hash);
}

/** Close functions of open overlays (the attachment viewer), newest last: back closes these first. */
const overlays: (() => void)[] = [];

/** Registers an open overlay; returns the function that unregisters it. */
export function pushOverlay(close: () => void) {
  overlays.push(close);
  return () => {
    const i = overlays.lastIndexOf(close);
    if (i !== -1) overlays.splice(i, 1);
  };
}

/** Closes the newest overlay; false when none is open. */
export function closeOverlay() {
  const close = overlays.pop();
  close?.();
  return !!close;
}

/** Close a sheet: step back if we navigated here in-app, otherwise go to `fallback`. */
export function closeTo(fallback: string) {
  if ((history.state as Entry | null)?.inApp) history.back();
  else location.replace(fallback);
}

/** The name of the screen `closeTo(fallback)` goes to, for the back button. */
export const backLabel = (fallback: string) => labelFor(history.state as Entry | null, fallback);
