---
name: lanesignal
description: How to report to LaneSignal through its MCP tools (the `lanesignal` server): publishing lane, group and epic state, asking the owner for a decision, acting on their answer, and telling them about milestones (merged, started a ticket). Use whenever you publish to LaneSignal, need the owner's decision, have a product or scope question, or reach a milestone.
---

# Using LaneSignal

LaneSignal is the owner's dashboard for agent work: you publish what your lanes are doing and raise an *escalation* when you need the owner (how they answer is below). The tool descriptions say what each tool does and takes; this skill covers how they fit together. **When** to use them (what deserves an escalation, which lanes to run, whether to record requirements) is the owner's policy, usually in `CLAUDE.md`; follow it where it says more.

Vocabulary: a **group** is your epic or train (one overseer per group). A **lane** is a slot work goes through, one ticket at a time. A **ticket** is what a lane works on; it owns its escalations and moves between lanes (*parked* when set aside). An **epic** is a long-lived ticket the group steers by, with its own questions and board; until you add one, the group stands in as its epic. An **escalation** is a question for the owner, or something they must know.

## Publishing state

- **Session start:** `update_group` once, with the `group_id` your owner's policy gives you and your Remote Control session in `links`, before publishing lanes.
- **Your epic:** the ticket the owner gave you goes to `update_epic` (its ref as `epic`, plus `group`) once. Use the epic's `status_line` for what's queued or waiting; never publish placeholder lanes.
- **Lanes are slots:** stable ids (`slot-1` … `slot-5`), not one per ticket. A worker and a reviewer on one ticket share a lane. Change tickets with `fill_lane`, parking (with a reason) what's blocked; its questions stay open, so dismiss ones that no longer matter.
- **Publish changes, not heartbeats.** A lane holding no ticket shows `idle`, and one with an open blocking escalation shows `blocked_human`, whatever you publish.
- **Write for a phone:** one-line `activity`. In any text, `#1234` links to the default ticket system and `redmine:1234` to that one; in `ticket` fields use `system:id`.

## Raising an escalation

One decision per `create_escalation`: four questions in a plan are four escalations. Write it so the owner can answer from a notification:

| Field | What to put in it |
|---|---|
| `context` | What you're doing, what you found, the tradeoffs and risks |
| `question` | The specific decision, as a question |
| `recommendation` | What you'd do and why |
| `cost` | What following the recommendation costs |
| `alternatives` | Other paths, one per entry, each with its tradeoff |
| `attachments` | A plan or notes (`.md`, `.txt`) or a screenshot (PNG, JPEG, WebP, GIF) the owner should see |
| `ticket` | What it's about (e.g. the PR), if not the lane's ticket |

Questions that steer the whole group (direction, scope, which tickets to file) go on the epic (`epic`, no `lane_id`).

### Attachments

Attach a plan or preview instead of pasting it into `context`. Upload over HTTP (needs `LANESIGNAL_URL` and `LANESIGNAL_KEY`), then pass the returned ids:

```bash
base=${LANESIGNAL_URL%/}; base=${base%/mcp}
curl -fsS -H "Authorization: Bearer $LANESIGNAL_KEY" -F file=@plan.md "$base/api/attachments"
```

Markdown, text, PNG, JPEG, WebP or GIF only; at most 5 MB each and 5 per escalation or message. Attach an upload once, from the key that uploaded it; unattached uploads are deleted after a day.

## Milestones

`notify_owner` is for milestones unless your owner's policy names others. Write the first line for a lock screen, and put several things in one message.
