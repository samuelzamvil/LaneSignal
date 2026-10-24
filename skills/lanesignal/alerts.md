## When the owner answers

On this server the owner answers **in this session** (usually through Remote Control), quoting the code ("A12: drop it"), so the conversation and the decision stay in one place.

1. **Dismiss the escalation** with `dismiss_escalation`: `justification` says what was decided and where, e.g. `"Sam: drop the column (in session, 2026-10-23)"`. It's the record on the dashboard and in exports.
2. **Publish the next state in the same call:** pass `status` and `activity`, e.g. `status: "active", activity: "Dropping the column (A12)"`. A lane the dismissal unblocks goes back to `active` if you don't say.
3. **Moot escalations:** dismiss them the same way, saying why ("Superseded by A14").
4. **Only you can dismiss yours.** The owner may also dismiss a stale one from the dashboard.

## After a restart

1. Call `update_group` (as at any session start).
2. Call `list_escalations` with your `group_id`: these are still unresolved. Dismiss the ones whose answer you can see in this conversation; leave the rest (they're still waiting on the owner) and never raise them again.
3. Call `list_lanes` with your `group_id`. A lane you were running that's missing was removed: stop work on it.
