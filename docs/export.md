# Exporting data for analysis

LaneSignal keeps everything needed for analysis:

- every escalation, including decided, acknowledged and withdrawn ones
- every requirement, including superseded and retired ones
- every agent position
- every conversation, on escalations and on lanes
- every lane and group, including ones that were removed from the dashboard (they're archived, not deleted)
- each lane's full status and escalation history

Only routine activity text is capped, at the last `LANESIGNAL_EVENT_RETENTION` entries per lane.

## Three ways to get it

| Where | How |
|---|---|
| **Web app** | Settings → **Export data**: an optional date range, then **Download everything (.zip)** or a single CSV. The Android app points you to the web app or the API, because WebView downloads need an extra plugin |
| **HTTP API** | `GET /api/export` for a zip of every CSV plus a README. `GET /api/export/<dataset>.csv` or `.json` for a single dataset |
| **MCP** | The `export_data` tool (for people's own Claude sessions: a personal key; agent keys don't get it) returns CSV (or JSON) in pages, so you can analyse it directly. A page is 100 rows by default (up to 1000), and is cut short to stay under about 60 KB. The first line says which rows you got and the `offset` for the next page |

Any signed-in person, agent key or static token can export over HTTP. The server builds one export at a time; a second request in the meantime gets `429` with `Retry-After`. Large exports are built in pages, so the server stays responsive while they run.

```bash
curl -fsS -H "authorization: Bearer $KEY" -o lanesignal.zip https://lanesignal.example.com/api/export
curl -fsS -H "authorization: Bearer $KEY" "https://lanesignal.example.com/api/export/escalations.csv?from=2026-10-01&to=2026-11-01" -o october.csv
```

## Filters

| Parameter | Applies to | Format |
|---|---|---|
| `from` | escalations (by creation time), positions (by when each was taken), messages and lane_messages (by when each was written), events (by time), requirements (by creation time) | `YYYY-MM-DD` (midnight UTC), or an ISO timestamp with a zone such as `2026-10-01T09:00:00Z` or `…+02:00`. Inclusive |
| `to` | same | same, exclusive. Must be after `from` |
| `project` | everything | a project id or key. Without it, every project you can see. Requirements for all projects are always included |
| `lane` (`lane_id` in MCP) | escalations, positions, messages, lane_messages, events, lanes | a lane id (with `project`, if you can see several) |

Unknown parameters, timestamps without a zone, and impossible dates (`2026-02-30`) are rejected with `400`, rather than silently ignored or reinterpreted.

Lanes and groups are always exported in full (within the project filter), so filtered escalations can still be joined to them.

Every dataset has a `project` column (the project id; empty in `requirements.csv` for requirements that apply to all projects). Lane, group and escalation codes are unique only within a project, so join on `project` plus the id. See [Projects](projects.md).

## Datasets and columns

Timestamps are UTC ISO 8601. Durations are whole seconds. List fields (options, alternatives) are joined with ` | `. Links are JSON.

Text that a spreadsheet would read as a formula (starting with `=`, `+`, `-`, `@`) gets a leading `'`. Agent-supplied text ends up in these files, so this stops it running as a formula when opened.

### `escalations.csv` (one row per escalation)

| Column | Meaning |
|---|---|
| `id`, `ref` | The escalation's id and its code (`967A`, or `A12` for one raised on a lane holding no ticket) |
| `lane_id`, `lane_name`, `group_id`, `group_name` | What it belongs to (the group as the lane has it now, even if the group was archived) |
| `ticket`, `ticket_url` | The escalation's own reference, e.g. the plan PR |
| `question`, `context`, `recommendation`, `recommended_option`, `cost`, `alternatives`, `options` | The question as asked |
| `accept_means`, `reject_means`, `allow_reject` | What Accept and Reject meant, and whether Reject was offered |
| `attachments` | The attached files as `name (type, size)`, joined with ` \| `. Exports never include the files themselves |
| `blocking` | `false` for FYI questions |
| `state` | `open`, `decided`, `acknowledged` or `withdrawn` |
| `created_by`, `created_at` | Which agent asked, and when |
| `decided_by`, `decided_at`, `decision`, `decision_note` | The human answer |
| `followed_recommendation` | `true` or `false` when there was a recommended option and a decision; empty otherwise |
| `acknowledged_at`, `resolution` | The agent's acknowledgement, or why it was withdrawn |
| `closed_at` | When it was acknowledged or withdrawn |
| `seconds_to_decision` | `decided_at − created_at` |
| `seconds_to_acknowledge` | `acknowledged_at − decided_at` |
| `seconds_open` | Time until decided or closed, or until now if still open |
| `positions_agree`, `positions_disagree`, `positions_neutral` | Counts of agent positions |
| `links` | JSON |
| `ticket_id` | The [ticket](#ticketscsv-every-ticket-lanes-have-held) it belongs to; empty for one raised on a lane holding no ticket |
| `legacy_ref` | Its code from before tickets (`A12`), for escalations raised before the upgrade; it still resolves |

### `positions.csv` (one row per agent position)

`escalation_id`, `escalation_ref`, `lane_id`, `question`, `agent`, `stance` (`agree`, `disagree` or `neutral`), `note`, `at`.

### `lanes.csv` (every lane, including archived ones)

| Column | Meaning |
|---|---|
| `id`, `name`, `group_id`, `group_name`, `status`, `ticket`, `ticket_url`, `activity` | Current state |
| `last_published_by` | Agent key or token name that last updated it |
| `created_at`, `updated_at`, `status_since` | Timing |
| `blocked_seconds_total` | Total time in `blocked_human`, including the current spell |
| `blocked_since` | Set while blocked |
| `escalations_total`, `escalations_open` | Counts |
| `links` | JSON |
| `archived_at` | Set if the lane was removed from the dashboard |
| `ticket_id` | The ticket it holds now; empty when it holds none |

Blocked time and status history belong to a lane's ticket: when a lane moves to another ticket, its blocked total starts again from that ticket's. Use `tickets.csv` for blocked time per ticket.

### `groups.csv` (every group, including archived ones)

`id`, `name`, `ticket`, `ticket_url`, `links`, `last_published_by`, `created_at`, `updated_at`, `archived_at`.

### `tickets.csv` (every ticket lanes have held)

| Column | Meaning |
|---|---|
| `id` | The ticket's number (escalations and events refer to it as `ticket_id`) |
| `ref`, `display_ref` | Its canonical reference (`redmine:967`) and how it was first written (`#967`) |
| `code` | What its escalation codes start with (`967`, `gh:632`, or `T42` when the ref can't be one) |
| `ticket_url` | From the ticket templates |
| `group_id`, `lane_id` | The group it was last worked in, and the lane holding it (empty unless held) |
| `state` | `in_lane`, `parked`, `done` or `dropped`: whether a lane holds it, and how the last one let it go. Not the ticket's status in its tracker |
| `park_reason`, `waiting_on` | Why it's parked, and the ticket it waits on |
| `status` | Its lane status: the holding lane's, or as it was when let go |
| `blocked_seconds_total` | Time blocked while in lanes |
| `escalations_total`, `escalations_open` | Counts |
| `created_at`, `updated_at`, `closed_at` | Timing (`closed_at` once done or dropped) |

### `requirements.csv` (the owner's product decisions)

`id` (`R14`), `group_id` (empty for product-wide), `requirement`, `justification`, `tags`, `status` (`pending`, `active`, `superseded`, `retired`), `superseded_by`, `decided_by`, `source_escalation`, `recorded_by`, `created_at`, `updated_at`. Every requirement is included, whatever its status; `from`/`to` filter by creation time. See [Requirements](requirements.md).

### `messages.csv` (conversations)

`id`, `escalation_id`, `escalation_ref`, `project`, `lane_id`, `from` (`owner` or `agent`), `author`, `body`, `attachments` (names, types and sizes), `at`. One row per message, oldest first.

### `lane_messages.csv` (lane conversations)

`id`, `project`, `lane_id`, `from` (`owner` or `agent`), `author`, `body`, `attachments` (names, types and sizes), `at`. One row per message in a lane's conversation (the agent's notices and the owner's notes), oldest first.

### `events.csv` (lane history)

`id`, `lane_id`, `at`, `kind`, `message`, `actor`, `ticket_id` (the ticket it concerns). The `kind` column is one of:

- **`status`:** every status change, plus lane created, removed and restored
- **`escalation`:** asked, positions, decided, acknowledged, withdrawn
- **`activity`:** the agent's activity lines, only the most recent ones per lane
- **`notice`:** the agent's messages in the lane's conversation (`notify_owner`, "Merged PR #311")
- **`message`:** the owner's notes in the lane's conversation
- **`ticket`:** a lane filled with a ticket, parking or letting one go ("Parked 500: waiting on the vendor"), and what a ticket waits on

To rebuild blocked time per lane over a period, pair the status changes in `status` rows.

## Removing vs keeping

**Removing a lane**, in the app or by its overseer (`remove_lane`):

- hides it from the dashboard
- lets its ticket go: done if the lane was completed, otherwise parked (`remove_lane` takes `previous` to say otherwise). The ticket keeps its questions, open ones included
- withdraws the **unanswered** escalations raised while it held no ticket, so waiting agents get an answer ("Lane removed by …"). Each withdrawal is recorded in the history
- leaves **decided** escalations as they are, so an agent already acting on an answer can still acknowledge it
- ends a blocked spell: a lane removed while `blocked_human` is set to `idle`, so archived time isn't counted as blocked
- keeps the lane, its escalations and its history

If an agent publishes to the same lane id again, the lane comes back with its history.

**Removing a group** hides it. Its lanes show as ungrouped, but they keep their group in exports. Publishing to the group again restores it.

There's no hard-delete in the app. To erase data, delete or restore the database file ([Operations](operations.md)).
