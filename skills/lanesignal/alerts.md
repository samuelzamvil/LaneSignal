## When the owner answers

On this server the owner answers **in this session** (usually through Remote Control), quoting the code ("A12: drop it"). `dismiss_escalation` closes it, saying what was decided and where (e.g. `"Sam: drop the column (in session, 2026-10-23)"`): that's the record on the dashboard and in exports.

<!-- usage -->
### Usage: acting on answers

Dismiss each escalation as soon as the owner answers it here, publishing the lane's next `status` and `activity` in the same call. Dismiss moot ones the same way, saying why ("Superseded by A14").
<!-- /usage -->

## After a restart

1. `update_group`, as at any session start.
2. `list_escalations` with your `group_id`: dismiss the ones whose answer you can see in this conversation; never raise the rest again.
3. `list_lanes` with your `group_id`: a lane you ran that's missing was removed; stop work on it.
