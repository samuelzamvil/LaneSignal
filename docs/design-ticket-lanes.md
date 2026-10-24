# Plan: tickets, epics and explicit lane filling

Status: **proposal for review**. Nothing here is built yet. It ships over three PRs (see [Delivery](#delivery)).

## Why

1. **A lane loses a ticket's history when it switches.** A lane's ticket is a single column, overwritten on each switch. When lane A parks ticket 500 to fix bug 501:
   - 500's escalations, status history and blocked time get mixed into 501's.
   - Nothing brings 500 back afterwards.
2. **Overseers have nowhere to put group-level conversation and status.** Today they invent lanes for it, like "Free lanes (0 of 5 open)". The group header only shows a name, a ticket link and a session link.

## The model in one paragraph

A **ticket** owns its escalations and its status history, and moves between lanes. A **lane** is a slot that holds at most one ticket and keeps its own activity feed and messages. An **epic** is a long-lived ticket attached to one group. It has its own card, message board and questions, and it steers the work rather than being worked in a lane. Every group has at least one epic: if none was given, the group stands in as its epic.

## Tickets

New `tickets` table, one row per (project, ref):

| Column | Meaning |
|---|---|
| `id`, `project_id`, `ref` | `ref` as agents write it today (`500`, `gh:500`, a URL) |
| `group_id` | The group the ticket was last worked in |
| `lane_id` | The lane that holds it, or null |
| `state` | `in_lane`, `parked`, `done`, `dropped` |
| `park_reason` | Why it was parked |
| `status`, `status_since`, `blocked_since`, `blocked_total_ms` | The status fields that move off the lane |
| `next_seq` | For escalation codes |
| `created_at`, `updated_at`, `closed_at` | |

Rules:

- **Created on first use.** Filling a lane with an unknown ref creates the ticket. There's no separate call.
- **At most one lane per ticket.** Filling a lane with a ticket another lane holds is refused with `409`, naming that lane.
- **Any lane can take a parked ticket.** The ticket keeps its escalations and status history when it moves.
- **Closed tickets can come back.** Filling a lane with a `done` or `dropped` ticket reopens it, history intact.
- **Status history goes to the ticket.** Status changes and escalation steps are recorded against the ticket, and the lane's feed shows a one-line copy.

## Lanes

- A lane keeps its id, name, letter, group, agent, links, **activity feed** and **messages**.
- `lanes.ticket_id` points at its ticket, or null.
- **A lane with no ticket is allowed and shows `idle`.**
- A lane holding a ticket shows that ticket's status.
- Lane letters (A, B …) stay as card labels, and no longer feed escalation codes.

## Filling lanes (agents)

New MCP tool and endpoint, one call per switch:

```
fill_lane(lane, ticket?, previous?: "park" | "done" | "drop", reason?, status?, activity?, name?, group?, links?)
PUT /api/lanes/:id/fill
```

- `previous` decides what happens to the ticket the lane holds now. It's required when the lane holds one, and `park` requires a `reason`.
- `ticket` is what moves in. Leaving it out empties the lane, so it goes `idle`.
- It creates the lane if it doesn't exist, as `update_lane` does today.
- It's one transaction, and it emits one lane event and one ticket event per ticket touched.
- `remove_lane` gains `previous`, defaulting to `park` with the reason "Lane removed". This keeps escalations on the ticket rather than withdrawing them (see [Escalations](#escalations)).

**Compatibility:**

- `update_lane` with a different `ticket` behaves like `fill_lane` with `previous: "done"`.
- `update_lane` with `ticket: null` empties the lane the same way.

Agents written for today's model keep working, and the skill and agent instructions move to `fill_lane`.

New read tools:

- `list_tickets(group?, state?)`: parked tickets are what overseers look for
- `get_ticket(ref)`: escalations, status history, and the lanes the ticket passed through

## Escalations

- **Every escalation belongs to exactly one ticket or epic:**
  - raised on a lane that holds a ticket → that ticket
  - raised on a lane with no ticket → the group's epic (`epic` names one when the group has several, and it's optional when there's one)
  - raised on an epic directly → that epic

  `escalations.lane_id` stays as the lane it was raised in, for history and export.
- **Codes are the ref plus a letter**, numbered per ticket or epic: **500A**, **500B** … **500Z**, **500AA**.
  - Refs from a non-default system keep their prefix: **gh:500A**.
  - A group standing in as its epic uses the group's ticket (**680A**), or its id when it has none (**product-trainA**).
  - Codes are matched case-insensitively.
  - Within a project, a ref can't be both an epic and a ticket.
- **Old codes keep working.** Existing escalations keep their codes (A12, SH·A1) as aliases, and every tool and endpoint still accepts them.
- **Behaviour is unchanged:** open questions stay in the inbox, and they block, notify and get answered as today, whether or not their ticket is in a lane.
- **Blocking moves to the ticket.**
  - A blocking escalation holds its *ticket* in `blocked_human`. A lane shows blocked only while its current ticket is blocked.
  - An escalation on an epic blocks nothing. It counts in the epic card's "needs you".
  - Today's rule "a lane stays blocked while any blocking escalation is open" becomes the same rule for tickets.
- **New filter:** **Active tickets only**, on the inbox and History, hides escalations whose ticket isn't in a lane. It's off by default, and remembered per device.

## Epics

New `epics` table:

| Column | Meaning |
|---|---|
| `id`, `project_id`, `group_id` | One group per epic. A group can have several |
| `ref` | The epic's ticket, or null for the group's stand-in epic |
| `name`, `links` | |
| `status_line` | One line the overseer sets, e.g. "3 of 5 lanes busy; next up #966" |
| `state` | `open`, `close_requested`, `closed` |
| `next_seq`, `agent_read_id` | Codes, and how far the overseer has read the board |
| `created_at`, `updated_at`, `closed_at` | |

Rules:

- **Every group has an epic.** Creating a group creates its stand-in epic.
  - Adding the first real epic retires the stand-in. Its escalations move to the real epic and keep their codes.
  - Closing the last real epic brings the stand-in back.
- **Message board:** `epic_messages`, with the same rules as lane messages: 500 characters for agents and 2,000 for people, attachments allowed, at most one agent post per minute, and a quiet push on each agent post. People's notes go to the group's overseer, whichever key last published the group.
- **Questions:** agents raise escalations on an epic (`create_escalation` with `epic`). They're for durable conversations: direction, scope, and which tickets to create.
- **Closing:** an overseer calls `request_epic_close(epic, reason)`, and a person approves or declines in the app, as with requirements. On close, the epic's open escalations are withdrawn, as when a lane is removed.
- **Lanes:** every lane in the group shows on each of the group's epic cards. Tickets aren't linked to epics.
- **Requirements** stay separate from epics.

Agent tools:

- `update_epic(epic, name?, ref?, links?, status_line?)`
- `notify_epic(epic, message, attachments?)`
- `request_epic_close(epic, reason)`
- `list_epics(group?)`

REST equivalents live under `/api/epics`.

## Dashboard

**Lanes page**

- **Epic card in place of the group header.** It shows the name, ticket link, overseer session, status line and "needs you" count, plus 💬 for unread board posts. Tapping it opens the epic sheet, and the group's lanes stay listed below.
- **Lane cards and rows:** a lane shows its current ticket, and **Idle · no ticket** when empty.
- **Parked tickets:** a collapsible **Parked (n)** row under each group lists each ticket with its reason, open question count, and the lane it left.

**Sheets**

- **Epic sheet:** the epic's escalations, its message board, and a combined feed of its group's lanes (status changes and activity across lanes, latest first).
- **Ticket sheet** (opened from a lane, a parked row, or an escalation's ticket): its escalations, status history and the lanes it passed through.
- **Lane sheet:** its feed and messages as now, plus a marker at each switch ("Parked 500: blocked on vendor API · filled with 501").

**Inbox and History**

- Codes and the epic or ticket they belong to show on each item.
- The **Active tickets only** filter.
- History search also matches ticket refs.

**Close approval:** an epic waiting for close approval shows **Close requested** on its card, with Approve and Decline.

## Export

| File | Change |
|---|---|
| `tickets.csv` | New: one row per ticket |
| `epics.csv` | New: one row per epic |
| `epic_messages.csv` | New: each epic's message board |
| `escalations.csv` | Adds `ticket_id`, `epic_id`, `legacy_ref` |
| `events.csv` | Adds `ticket_id` |
| `lanes.csv` | Adds `ticket_id` |

## Migration (schema v16)

All in one transaction at startup:

1. Each group gets a stand-in epic. A group with a `ticket` gets a real epic for it instead (its ref, the group's name and links).
2. Each lane with a ticket gets a ticket record:
   - state `in_lane` if the lane is live, else `done`
   - the lane's status fields
   - the lane's escalations and status and escalation events
3. A lane without a ticket has its escalations moved to its group's epic (or a stand-in epic for an ungrouped lane), and it's set to `idle`.
4. Existing codes move to `legacy_ref`. New codes start at A for each ticket and epic.
5. The `groups.ticket` and `lanes.ticket` columns stay, read-only, for one release, then are dropped.

Ungrouped lanes are allowed today. They get a per-project stand-in group, named "Ungrouped", so every lane has an epic.

## Delivery

Each PR is shippable on its own, with tests, wiki updates and an adversarial review before it opens.

1. **Tickets (server):**
   - the `tickets` table, migration and codes
   - `fill_lane`, `list_tickets` and `get_ticket`, plus the `update_lane` and `remove_lane` compatibility
   - blocking moved to the ticket
   - export
   - minimal web changes so nothing breaks: codes, and **Idle · no ticket**
2. **Tickets (app):** the Parked row, ticket sheet, switch markers in the lane sheet, the **Active tickets only** filter, and the Android check.
3. **Epics:**
   - the table and migration, with stand-in epics
   - epic escalations and the message board
   - close requests and approval
   - the epic card and sheet
   - the agent tools
   - skill and agent-instruction updates, so overseers use the status line instead of placeholder lanes

## Risks

- **Codes change for new escalations.** People used to typing "A3" will type "500A". Old codes keep resolving, and push titles carry the new code.
- **Migration on live data.** Escalations re-home to tickets and epics. The step runs in one transaction, and tests cover it with a copy of a seeded v15 database.
- **Agents that ignore `fill_lane`.** The compatibility path treats every ticket change as `done`, so parked work isn't recorded until the overseer's instructions are updated.
