# Plan: tickets, epics and explicit lane filling

Status: **signed off by both overseers, revision 3**. Nothing here is built yet. It ships over several PRs (see [Delivery](#delivery)).

## Why

1. **A lane loses a ticket's history when it switches.** A lane's ticket is a single column, overwritten on each switch. When lane A parks ticket 500 to fix bug 501:
   - 500's escalations, status history and blocked time get mixed into 501's.
   - Nothing brings 500 back afterwards.
2. **Overseers have nowhere to put group-level conversation and status.** Today they invent lanes for it, like "Free lanes (0 of 5 open)". The group header only shows a name, a ticket link and a session link.

## The model in one paragraph

A **ticket** owns its escalations and its status history, and moves between lanes. A **lane** is a slot that holds at most one ticket and keeps its own activity feed and messages. An **epic** is a long-lived ticket attached to one group. It has its own card, message board and questions, and it steers the work rather than being worked in a lane. Every group has at least one epic: if none was given, the group stands in as its epic.

**LaneSignal is not a ticket tracker.** A ticket's state here only says whether a lane is holding it. The ticket's real status lives in Redmine, GitHub or wherever the ticket lives, and LaneSignal never syncs it.

## Ticket refs

Every ref is put into one **canonical form** per project before it's looked up or stored, so `967`, `#967`, `redmine:967` and the Redmine issue URL are all one ticket:

| Written as | Canonical form |
|---|---|
| `967`, `#967` | `<default system>:967` |
| `redmine:967` | `redmine:967` (the system name is lower-cased) |
| A URL that matches a `LANESIGNAL_TICKET_TEMPLATES` entry | `<system>:<id>` |
| Any other URL | Kept as the URL |

- The ref as first written is kept for display.
- Escalations' own `ticket` field and epic refs are normalized the same way.

## Tickets

New `tickets` table, one row per (project, canonical ref):

| Column | Meaning |
|---|---|
| `id`, `project_id`, `ref`, `display_ref` | |
| `group_id` | The group the ticket was last worked in |
| `epic_id` | Optional: the epic this ticket belongs to (see [Epics](#epics)) |
| `lane_id` | The lane that holds it, or null |
| `state` | `in_lane`, `parked`, `done`, `dropped` |
| `park_reason` | Why it was parked |
| `waiting_on` | Optional: another ticket ref this one waits on ("#946 waits on #945's carrier") |
| `status`, `status_since`, `blocked_since`, `blocked_total_ms` | The status fields that move off the lane |
| `created_at`, `updated_at`, `closed_at` | |

What `state` means:

| State | Meaning |
|---|---|
| `in_lane` | A lane holds it |
| `parked` | Set aside, to be picked up again |
| `done` | The lane finished with it |
| `dropped` | The lane let it go without finishing |

None of these claim anything about the ticket's real status.

Rules:

- **Created on first use.** Filling a lane with an unknown ref creates the ticket. There's no separate call.
- **PRs go in `links`, never `ticket`.** The skill says so. The server warns when a lane's ticket switches from a ticket-system ref to a `gh:` ref. Otherwise the compatibility path would park the real ticket and create a ticket for the PR.
- **`waiting_on` clears itself** when the ticket it names becomes `done` or `dropped`.
- **At most one lane per ticket.** Filling a lane with a ticket another lane holds is refused with `409`, naming that lane. Lanes are slots, not seats: a worker and a reviewer on the same ticket share one lane.
- **Any lane can take a parked ticket.** The ticket keeps its escalations and status history when it moves.
- **Closed tickets can come back.** Filling a lane with a `done` or `dropped` ticket reopens it, history intact.
- **Status history goes to the ticket.** Status changes and escalation steps are recorded against the ticket, and the lane's feed shows a one-line copy.

## Lanes

- A lane keeps its id, name, letter, group, agent, links, **activity feed** and **messages**.
- `lanes.ticket_id` points at its ticket, or null.
- **A lane with no ticket is allowed and shows `idle`.**
- A lane holding a ticket shows that ticket's status.
- **Status `completed` is the source of truth for finishing.** Publishing `completed` marks the ticket `done` and empties the lane, so it goes `idle`.
- Lane letters (A, B …) stay as card labels, and no longer feed escalation codes.
- **The skill says lanes are slots** (`slot-1` to `slot-5`), not one lane per ticket. Overseers who keep a lane per ticket and remove it after the merge still work.

## Filling lanes (agents)

New MCP tool and endpoint, one call per switch:

```
fill_lane(lane, ticket?, previous?: "park" | "done" | "drop", reason?, waiting_on?, epic?, status?, activity?, name?, group?, links?)
PUT /api/lanes/:id/fill
```

- `previous` decides what happens to the ticket the lane holds now. It's required when that ticket changes, and `park` requires a `reason`.
- `ticket` is what moves in. Leaving it out empties the lane, so it goes `idle`.
- **Filling a lane with the ticket it already holds** is a plain status update, and needs no `previous`.
- It creates the lane if it doesn't exist, as `update_lane` does today.
- It's one transaction, and it emits one lane event and one ticket event per ticket touched.

**Defaults when `previous` isn't given.** The rule is the same for both calls: if the lane's status is `completed`, the ticket becomes `done`; otherwise it's parked, which loses nothing.

| Call | Lane `completed` | Otherwise |
|---|---|---|
| `remove_lane` | Ticket `done` | Ticket parked, reason "Lane removed" |
| `update_lane` with a different `ticket` (compatibility) | Ticket `done` | Ticket parked, reason "switched (legacy call)" |

`update_lane` with `ticket: null` empties the lane under the same rule.

New read tools:

- `list_tickets(group?, state?)`: for finding parked tickets. It's also part of the skill's **After a restart** steps, so an overseer finds `in_lane` tickets nobody is working after a crash or compaction.
- `get_ticket(ref)`: escalations, status history, and the lanes the ticket passed through

## Escalations

**Every escalation belongs to exactly one ticket or epic:**

- raised on a lane that holds a ticket → that ticket
- raised on a lane with no ticket → the group's epic (`epic` names one when the group has several, and it's optional when there's one)
- raised on an epic directly → that epic

`escalations.lane_id` stays as the lane it was raised in, for history and export.

### Codes

- **Format:** a code is the canonical ref, then a letter, numbered per ref: **500A**, **500B** … **500Z**, **500AA**.
  - Refs from a non-default system keep their prefix: **gh:500A**.
  - A group standing in as its epic uses the group's ticket (**680A**), or its id when it has none.
  - **URL refs** that match no template use the ticket's short id instead (**T42A**).
  - Codes are matched case-insensitively. Where projects mix, the project key comes first, as today (**SH·500A**).
- **One letter sequence per ref.** A ref can be both an epic and a ticket (a Redmine epic worked directly, e.g. grooming or an audit). The two share the sequence, so codes stay unique.
- **Old codes resolve forever.** Existing escalations keep their codes (A12, SH·A1, I1) as permanent aliases. Redmine journals and requirements' `source_escalation` quote them.

### Behaviour

- **Unchanged:** open questions stay in the inbox, and they block, notify and get answered as today, whether or not their ticket is in a lane.
- **Blocking moves to the ticket.** A blocking escalation holds its *ticket* in `blocked_human`, and a lane shows blocked only while its current ticket is blocked. So a parked ticket waiting on you frees its slot.
- **Epic escalations can block.** A blocking question on an epic ("which tickets do we file?") shows on the epic card as **Waiting on you**, and counts in "needs you". It doesn't change any lane's status.
- **Who can acknowledge:**
  - Today, only the agent that raised an escalation can acknowledge or dismiss it (any key of the same account with the same key name), or a person on its behalf.
  - Under this plan, the overseer of the ticket's *current* group can too. So when product takes over an L&A ticket, product's overseer can close out its decided questions.
  - `wait_for_decisions` follows the same rule.
  - Overseers sharing one agent key count as the same agent, so this rule doesn't keep them apart. Group-scoped waits do that.
- **Acknowledging after a reply.** If the owner answered **Other** and the agent then replied, acknowledging accepts the owner's latest instruction. Today it fails with "open; expected decided". This is a bug in today's code, fixed in PR 0.
- **New filter:** **Active tickets only**, on the inbox and History, hides escalations whose ticket isn't in a lane. It's off by default, and remembered per device.

## Waiting

**What changes:** `wait_for_decisions` returns a **digest**: what changed since the `since` the agent passes. This keeps the call agents make most cheap in tokens.

**What it returns today, every call:**

- each decided-but-unacknowledged escalation, in brief, repeated until acknowledged
- the whole `open` list

**What the digest returns:**

- **Items, one per thing to handle:** `{code, kind, id, text}`.
  - `decided` and `reply` **repeat on every wait until handled**: acknowledged, or replied to. A wait killed mid-way or a context compaction can't lose a decision.
  - Everything else is reported once per `since`: `lane_note`, `board_note`, `closed`, `lane_removed`, `ticket_moved`.
- **The owner's words in full.** That text is the change, and fetching it in a second call would cost more. Agent text and unchanged fields are left out.
- **Counts:** `open`, `decidedUnacknowledged` and `waitingOnYou`, so the agent knows what's pending without the list.
- **Computed from `since`, not from a server-side "delivered" mark.** Calling again with the same `since` returns the same items, so a crashed wait loses nothing. The "seen by the agent" mark on notes is display-only.
- **`ready` and `checkedAt` keep their meaning:**
  - `ready: true` when there's at least one item
  - `checkedAt` always present, to pass as the next `since`

  Today's background loops keep working unchanged.
- **No early return when nothing is open.** It returns as soon as there's an item, or at its timeout.

**Full state, on demand:** a new `get_updates(scope, since?)` returns everything in scope, as `wait_for_decisions` does today: open escalations, decided ones awaiting acknowledgement, unread notes. Agents call it after a restart or when they've lost track. `get_escalation`, `get_ticket` and `list_*` still return single records in full.

**Compatibility:** `GET /api/wait` and the MCP tool take `format: "full"` for one release, for agents written against today's shape.

**Skill updates, in the same PR:**

- The sample background loop, checked against the digest.
- **When nothing is open, wait in the background,** or pass `wait_seconds: 0` for a quick check. A tool-call wait now holds the session for its whole `wait_seconds`, and Remote Control can't reach a session while it's held.
- **If the counts show something pending and the digest has nothing to act on, call `get_updates`.**

**Phone pushes are separate from waits:** each agent post on an epic board still sends a quiet push, as lane milestones do.

## Epics

New `epics` table:

| Column | Meaning |
|---|---|
| `id`, `project_id`, `group_id` | One group per epic. A group can have several |
| `ref`, `display_ref` | The epic's ticket (canonical), or null for the group's stand-in epic |
| `name`, `links` | |
| `status_line` | One line the overseer sets, e.g. "3 of 5 lanes busy; next up #966". It replaces placeholder lanes |
| `state` | `open`, `close_requested`, `closed` |
| `agent_read_id` | How far the overseer has read the board |
| `created_at`, `updated_at`, `closed_at` | |

Rules:

- **Every group has an epic.** Creating a group creates its stand-in epic.
  - Adding the first real epic retires the stand-in. Its escalations move to the real epic and keep their codes.
  - Closing the last real epic brings the stand-in back.
- **Tickets can name an epic** (`fill_lane(..., epic)`). It's optional. On the Lanes page, each lane is listed **once**:
  - under its current ticket's epic, or
  - under the group's general section, when the ticket names no epic or the lane is idle
- **Message board:** `epic_messages`, with the same rules as lane messages: 500 characters for agents and 2,000 for people, attachments allowed, at most one agent post per minute, and a quiet push on each agent post. People's notes go to the group's overseer and come back through `wait_for_decisions`.
- **Questions:** agents raise escalations on an epic (`create_escalation` with `epic`). They're for durable conversations: direction, scope, and which tickets to create.
- **Closing:**
  - An overseer calls `request_epic_close(epic, reason)`, and a person approves or declines in the app, as with requirements.
  - A close is refused while the epic has open or decided-but-unacknowledged escalations, so live decisions are never withdrawn.
  - On close, tickets that name the epic keep their link, read-only.
- **Requirements** stay separate from epics.

Agent tools:

- `update_epic(epic, name?, ref?, links?, status_line?)`
- `notify_epic(epic, message, attachments?)`
- `request_epic_close(epic, reason)`
- `list_epics(group?)`

REST equivalents live under `/api/epics`.

## Dashboard

**Lanes page**

- **Epic cards in place of the group header.**
  - Each card shows the name, ticket link, overseer session, status line, "needs you" count, and **Waiting on you** when a blocking epic question is open, plus 💬 for unread board posts.
  - The lanes whose ticket names that epic are listed under its card. The rest are listed under the group.
  - Tapping a card opens the epic sheet.
- **Lane cards and rows:**
  - a lane shows its current ticket, and **Idle · no ticket** when empty
  - when the ticket waits on another, it reads **waiting on #945**
- **Parked tickets:** a collapsible **Parked (n)** row under each group lists each ticket with its reason, open question count, and the lane it left.

**Sheets**

- **Epic sheet:** the epic's escalations, its message board, and a combined feed of its lanes (status changes and activity across lanes, latest first).
- **Ticket sheet** (opened from a lane, a parked row, or an escalation's ticket): its escalations, status history and the lanes it passed through.
- **Lane sheet:** its feed and messages as now, plus a marker at each switch ("Parked 500: blocked on vendor API · filled with 501").

**Inbox and History**

- Codes and the epic or ticket they belong to show on each item.
- The **Active tickets only** filter.
- History search also matches ticket refs, in any form.

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

1. Each group gets a stand-in epic. A group with a `ticket` gets a real epic for it instead (its canonical ref, the group's name and links).
2. Each lane with a ticket gets a ticket record (canonical ref; lanes that share a ref share one ticket). It holds:
   - state `in_lane` if the lane is live, else `done`
   - the lane's status fields
   - the lane's escalations and status and escalation events
3. A lane without a ticket has its escalations moved to its group's epic (or a stand-in epic for an ungrouped lane), and it's set to `idle`.
4. **Completed lanes are archived** (removed from the dashboard, kept for export). Their tickets are marked `done`, so they don't come back as idle slots.
5. Existing codes move to `legacy_ref` and resolve forever. New codes start at A for each ref.
6. The `groups.ticket` and `lanes.ticket` columns stay, read-only, for one release, then are dropped. Legacy codes don't depend on them.

Ungrouped lanes are allowed today. They get a per-project stand-in group, named "Ungrouped", so every lane has an epic.

## Delivery

Each PR is shippable on its own, with tests, wiki updates and an adversarial review before it opens.

0. **Fix: acknowledge after a reply.** A small, separate fix to today's code.
1. **Wait digest:** `wait_for_decisions` returns only changes; `get_updates` returns everything. Separate from tickets, so it lands first and cuts token use now.
2. **Tickets (server):**
   - ref normalization
   - the `tickets` table, migration and codes
   - `fill_lane`, `list_tickets` and `get_ticket`, plus the compatibility defaults
   - blocking moved to the ticket
   - acknowledgement by the ticket's current group
   - `waiting_on`
   - export
   - minimal web changes so nothing breaks: codes, **Idle · no ticket**, and **waiting on**
3. **Tickets (app):** the Parked row, ticket sheet, switch markers in the lane sheet, the **Active tickets only** filter, and the Android check. The skill and agent instructions move to slots and `fill_lane`.
4. **Epics:**
   - the table and migration, with stand-in epics
   - the optional ticket → epic link
   - epic escalations (including blocking ones) and the message board
   - board notes in the wait digest
   - close requests and approval
   - the epic card and sheet
   - the agent tools
   - the skill update, so overseers use the status line instead of placeholder lanes

## As built

**PR 2 (tickets, server)** follows this plan. Where the plan is silent, these filled the gap:

- **Held over to PR 4 with epics:** stand-in epics, the "Ungrouped" stand-in group, `epic_id` and `fill_lane`'s `epic`.
- **Until epics (owner's decision):** a question raised on a lane holding no ticket keeps today's behaviour: it blocks that lane and gets a lane-letter code (A12). A lane goes `idle` when it lets its ticket go without taking another; the migration leaves ticketless lanes' status as it is (step 3's "set to idle" comes with epics).
- **Two live lanes on one ticket at upgrade:** they share the ticket record, and the more recently updated lane holds it. The other lane's history says which lane holds it.
- **The overseer of a ticket's group** is the key that last published the group with `update_group` (as the plan's "whichever key last published the group"), compared like a raiser (account and key name).
- **Changing the ticket systems later** (e.g. adding a default) re-derives tickets' canonical refs at startup from how each was first written; codes don't change.
- **Notifications:** completing a lane still sends the "completed" notification and TRMNL card, though the lane shows `idle` afterwards.
- **`waiting_on` alongside `completed`** in one call: the lane ends up holding no ticket, so `waiting_on` is left out with a warning rather than failing the whole call.

**PR 3 (tickets, app)** follows the plan. Where the plan is silent:

- **The Parked row is folded by default** (remembered per device), and parked tickets aren't listed while a status filter is on, since that filter picks lanes by status. When lanes are arranged by priority or status, the parked tickets sit in one Parked row at the end.
- **"Active tickets only" doesn't change counts:** the "Needs you" badge and banner still count questions on parked tickets; the filter only hides them from the lists.
- **A lane's sheet** lists the questions raised on it and those of the ticket it holds, each naming its ticket.

## Risks

- **Codes change for new escalations.** People used to typing "A3" will type "500A". Old codes keep resolving, and push titles carry the new code.
- **Migration on live data.** Escalations re-home to tickets and epics. The step runs in one transaction, and tests cover it with a copy of a seeded v15 database.
- **Agents that ignore `fill_lane`.** The compatibility path parks the old ticket rather than finishing it, so nothing is lost, but parked lists fill up until the overseer's instructions are updated.
