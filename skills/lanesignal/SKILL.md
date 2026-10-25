---
name: lanesignal
description: How to report to LaneSignal through its MCP tools (the `lanesignal` server): publishing lane, group and epic state, asking the owner for a decision, acting on their answer, and telling them about milestones (merged, started a ticket). Use whenever you publish to LaneSignal, need the owner's decision, have a product or scope question, or reach a milestone.
---

# Using LaneSignal

LaneSignal is the owner's dashboard for agent work. You publish what your lanes are doing and raise an *escalation* when you need the owner. Their phone is notified, the dashboard shows the lane as blocked, and they answer (see [When the owner answers](#when-the-owner-answers)).

This skill covers **how** to use the tools. **When** to use them (what deserves an escalation, which lanes to run, whether to record requirements) is the project owner's policy, usually in `CLAUDE.md`. Follow that policy where it says more than this.

Vocabulary:
- A **group** is your epic or train (one overseer runs one group).
- A **lane** is a slot your work goes through, one ticket at a time (`slot-1`, `slot-2` …, or one per work stream).
- A **ticket** is what a lane works on. It owns its escalations and history, and moves between lanes: set aside (*parked*) when it's blocked, picked up again later by any lane.
- An **epic** is a long-lived ticket your group steers its work by, with a card on the dashboard, its own questions and a message board. Every group has one: until you add one, the group stands in as its epic (named by your `group_id`).
- An **escalation** is a question for the owner, or something they must know.

## Projects

A server can host several independent projects (apps), each with its own groups, lanes and codes. If your key is bound to one project, or reaches only one, ignore this section. Otherwise:

- `list_projects` shows the ones you can reach. Use the project your owner's policy names.
- Pass `project` (its id or key) on every call. Without it, an existing lane or group id is found in whichever of your projects has it, but a new id, or one in several projects, fails with "Say which project".
- Refer to escalations by their keyed code (`SH-967A`, `SH-A12`): bare codes repeat across projects.

## Publishing state

- **Start of a session:** call `update_group` once, with your `group_id` (the one your owner's policy gives you), its `name`, and your Remote Control session URL in `links` (`{label: "Overseer session", url: …, kind: "session"}`). Register it before publishing lanes in it.
- **Epics:** `update_epic` with `epic` (its ticket ref, or your `group_id` for the group's own epic):
  - Your epic's ticket (the one the owner gave you): pass its ref as `epic` plus `group`, once. The group's earlier epic questions and board move to it.
  - `status_line`: one line on the epic's card, e.g. "3 of 5 lanes busy; next up #966". Use it for what's queued or waiting; never publish placeholder lanes.
  - `list_epics` shows your group's epics.
- **Lanes are slots:** give each a stable `lane_id` (`slot-1` … `slot-5`, not one per ticket), and pass `group` on its first call. Publish a lane before raising escalations on it; unknown lanes and groups are errors, so a typo can't create a stray lane.
- **Moving to another ticket:** `fill_lane` with the next `ticket` and, in `previous`, what happens to the one the lane holds: `park` with a `reason` ("blocked on the vendor API") to pick it up later, `done`, or `drop` (unfinished). Its open questions stay in the owner's inbox either way, and block only the lane holding the ticket; dismiss ones that no longer matter.

  A parked (or done) ticket comes back in any lane with its questions and history. Leave `ticket` out to empty the lane. A ticket is in one lane at a time, so a worker and a reviewer on one ticket share a lane. Pass `epic` when the ticket belongs to one of your group's epics, so the lane shows under its card.
- **Empty lanes show idle:** a lane holding no ticket shows `idle` whatever status you publish.
- **Tickets, not PRs:** `ticket` is the work item (`redmine:1234`, `967`, `#967` and its URL all name the same one). PRs and CI runs go in `links`.
- **Waiting on another ticket:** pass `waiting_on` (e.g. `"945"`) with the lane's status; it clears itself once that ticket is done.
- `list_tickets` shows the tickets your lanes hold and the parked ones; `get_ticket` shows one with its questions and history.
- **Blocked lanes:** a lane with an open blocking escalation stays `blocked_human` whatever status you publish, until the escalation is closed.
- **Status:** publish *changes*, not heartbeats.

  | Status | When |
  |---|---|
  | `active` | working on its ticket, with a one-line `activity` |
  | `pending_ci` | pushed and waiting; put the PR and CI run in `links` |
  | `awaiting_agent` | waiting on another lane; name it in `activity` |
  | `idle` | nothing to do right now |
  | `completed` | its ticket is done: the ticket closes and the lane empties (idle), ready for the next |

- **Removing:** when you no longer need a slot, `remove_lane` takes it off the dashboard. Its ticket is done if the lane is completed, otherwise parked, unless you pass `previous`. Its history is kept.
- **Writing for a phone:** keep `activity` to one line. Use ticket references like `gh:42` or `redmine:1234`.
- **Ticket refs link:** in messages, escalation questions and fields, notes and requirements, `#1234` links to the default ticket system and `redmine:1234` to that one (use the system name for one-digit ids). Write refs that way rather than pasting ticket URLs. In `ticket` fields, always use the `system:id` form.

## Raising an escalation

Call `create_escalation` once per decision. Four questions in a plan means four escalations; they appear together, in order. Write it so the owner understands it from a phone notification and the dashboard:

| Field | What to put in it |
|---|---|
| `context` | What you're doing, what you found, the tradeoffs and risks |
| `question` | The specific decision, as a question |
| `recommendation` | What you'd do and why |
| `cost` | What following the recommendation costs |
| `alternatives` | Other paths, one per entry, each with its tradeoff |
| `attachments` | Files the owner should read or see: a plan (`.md`), notes (`.txt`), a UI screenshot (PNG, JPEG, WebP, GIF). See below |
| `ticket` | What it's about (e.g. the PR), if it's not the lane's ticket |
| `blocking: false` | For an FYI that shouldn't stop the lane |

- **Where it goes:** raised on a lane, it's the lane's ticket's and blocks that lane. Durable questions that steer the work (direction, scope, which tickets to file) go on the epic: `create_escalation` with `epic` and no `lane_id`. They block no lane; the epic's card shows them. A question from a lane holding no ticket also goes to the group's epic (pass `epic` when the group has several).
- **Codes:** each escalation gets a code, its `ref`: its ticket's or epic's code and a letter, like **967A**, **967B**, **680A**. The owner uses it when they answer you ("967A: drop it"); use it too. Every tool accepts it in place of the id, and older codes (A12) keep working.
- **Retries are safe:** re-sending the same open question on the same ticket or epic returns the existing escalation (`duplicate: true`).
- **An FYI that now blocks you:** call `create_escalation` again with the FYI's exact `question` and without `blocking: false`. It keeps its code, blocks the lane and notifies the owner as a new question (`upgraded: true`). Fields you give (`context`, `recommendation`, …) replace the FYI's, and new `attachments` are added, so give the owner what they need to answer.

### Attachments

When the owner needs to read a plan or see a UI preview to decide, attach it instead of pasting it into `context`. Upload each file over HTTP (it needs `LANESIGNAL_URL` and `LANESIGNAL_KEY`, as for the wait loop), then pass the ids in `attachments`:

```bash
base=${LANESIGNAL_URL%/}; base=${base%/mcp}
curl -fsS -H "Authorization: Bearer $LANESIGNAL_KEY" -F file=@plan.md "$base/api/attachments"
# {"id":"…","name":"plan.md","type":"text/markdown","size":2140}
```

- Markdown (`.md`) and text (`.txt`) files, and PNG, JPEG, WebP or GIF images. Nothing else (no SVG, HTML or PDF).
- At most 5 MB each and 5 per escalation or message (the server may set other limits; its error says).
- Attach an upload once, from the key that uploaded it. Uploads not attached within a day are deleted.

## The lane's conversation: milestones, and the owner's notes

`notify_owner` writes to the owner in the lane's conversation, with a quiet phone notification that opens the lane, e.g. `"Merged PR #311"` or `"Starting gh:42"`.

- **Milestones only:** a PR merged, or a new ticket started, unless your owner's policy names others. Never for routine progress, and never to ask something (that's an escalation).
- **Short:** at most 500 characters, first line written for a lock screen. Detail or screenshots go in `attachments` (uploaded as for escalations, with the same limits). One per lane per minute: put several things in one message.

## The epic's board

`notify_epic` writes on an epic's message board, for the longer conversation about direction, scope and which tickets come next. Same limits as `notify_owner` (one per epic per minute), and a quiet notification. The owner's notes on the board come back as `ownerMessages` from your next `update_epic` or `notify_epic`.

**Closing:** when an epic's work is over, `request_epic_close` with a `reason`; a person approves it. Settle its open questions first: a close is refused while any is open or answered but not acknowledged.
