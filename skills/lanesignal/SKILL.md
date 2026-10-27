---
name: lanesignal
description: How to use LaneSignal through its MCP tools (the `lanesignal` server): publishing lane, group and epic state, asking the owner for a decision, acting on their answer, and writing to them. Use whenever you work with LaneSignal.
---

# Using LaneSignal

LaneSignal is the owner's dashboard for agent work: you publish what your lanes are doing and raise an *escalation* when you need the owner (how they answer is below). The tool descriptions say what each tool does and takes; this skill covers how they fit together. The **Usage** sections say when and why to use them on this server; the owner's policy (usually in `CLAUDE.md`) overrides them.

Vocabulary: a **group** is your epic or train (one overseer per group). A **lane** is a slot work goes through, one ticket at a time. A **ticket** is what a lane works on; it owns its escalations and moves between lanes (*parked* when set aside). An **epic** is a long-lived ticket the group steers by, with its own questions and board; until you add one, the group stands in as its epic. An **escalation** is a question for the owner, or something they must know.

## Publishing state

- **Your group:** `update_group` with the `group_id` your owner's policy gives you and your Remote Control session in `links`; a group must exist before lanes are published in it.
- **Your epic:** the ticket the owner gave you goes to `update_epic` (its ref as `epic`, plus `group`), once. Its `status_line` is one line on the epic's card.
- **Lanes:** a lane holds one ticket at a time, and a ticket is in one lane at a time. `fill_lane` changes tickets, parking (with a reason) the one it held; a parked ticket's questions stay open.
- A lane holding no ticket shows `idle`, and one with an open blocking escalation shows `blocked_human`, whatever you publish.
- **Ticket refs:** in any text, `#1234` links to the default ticket system and `redmine:1234` to that one; in `ticket` fields use `system:id`.

## Raising an escalation

The owner reads it from a phone notification and the dashboard:

| Field | What to put in it |
|---|---|
| `context` | What you're doing, what you found, the tradeoffs and risks |
| `question` | The specific decision, as a question |
| `recommendation` | What you'd do and why |
| `cost` | What following the recommendation costs |
| `alternatives` | Other paths, one per entry, each with its tradeoff |
| `attachments` | A plan or notes (`.md`, `.txt`) or a screenshot (PNG, JPEG, WebP, GIF) the owner should see |
| `ticket` | What it's about (e.g. the PR), if not the lane's ticket |

### Attachments

Markdown, text, PNG, JPEG, WebP or GIF only; at most 5 MB each and 5 per escalation or message. Attach an upload once, from the key that uploaded it; unattached uploads are deleted after a day.

`notify_owner`'s first line is what the phone's notification shows.

<!-- usage -->
## Usage: publishing and asking

- **Session start:** `update_group` once, before publishing lanes.
- **Lanes are slots:** stable ids (`slot-1` … `slot-5`), not one per ticket. A worker and a reviewer on one ticket share a lane.
- **Publish changes, not heartbeats.** Use the epic's `status_line` for what's queued or waiting; never publish placeholder lanes. Keep `activity` to one line, written for a phone.
- **Parking:** dismiss a parked ticket's questions that no longer matter.
- **One decision per escalation:** four questions in a plan are four escalations. Questions that steer the whole group (direction, scope, which tickets to file) go on the epic (`epic`, no `lane_id`). Attach a plan or preview instead of pasting it into `context`.
- **`notify_owner` for milestones only:** a PR merged, a ticket started. Never routine progress, never questions. Put several things in one message.
<!-- /usage -->
