---
name: lanesignal
description: How to report to LaneSignal through its MCP tools (the `lanesignal` server): publishing lane and group state, asking the owner for a decision, and acting on their answer. Use whenever you publish to LaneSignal, need the owner's decision, or have a product or scope question.
---

# Using LaneSignal

LaneSignal is the owner's dashboard for agent work. You publish what your lanes are doing and raise an *escalation* when you need the owner. Their phone is notified, the dashboard shows the lane as blocked, and they answer (see [When the owner answers](#when-the-owner-answers)).

This skill covers **how** to use the tools. **When** to use them (what deserves an escalation, which lanes to run, whether to record requirements) is the project owner's policy, usually in `CLAUDE.md`. Follow that policy where it says more than this.

Vocabulary:
- A **group** is your epic or train (one overseer runs one group).
- A **lane** is one ticket or work stream in it.
- An **escalation** is a question for the owner, or something they must know.

## Projects

A server can host several independent projects (apps), each with its own groups, lanes and codes. If your key is bound to one project, or reaches only one, ignore this section. Otherwise:

- `list_projects` shows the ones you can reach. Use the project your owner's policy names.
- Pass `project` (its id or key) on every call. Without it, an existing lane or group id is found in whichever of your projects has it, but a new id, or one in several projects, fails with "Say which project".
- Refer to escalations by their keyed code (`SH-A12`): bare codes like `A12` repeat across projects.

## Publishing state

- **Start of a session:** call `update_group` once, with your `group_id` (the one your owner's policy gives you), your epic/train `name`, its `ticket`, and your Remote Control session URL in `links` (`{label: "Overseer session", url: …, kind: "session"}`). Register it before publishing lanes in it.
- **Lane ids:** give each lane a stable `lane_id`, and pass `group` on its first `update_lane`. Publish a lane before raising escalations on it; unknown lanes and groups are errors, so a typo can't create a stray lane.
- **Blocked lanes:** a lane with an open blocking escalation stays `blocked_human` whatever status you publish, until the escalation is closed.
- **Status:** publish *changes*, not heartbeats.

  | Status | When |
  |---|---|
  | `active` | working on it, with `ticket` and a one-line `activity` |
  | `pending_ci` | pushed and waiting; put the PR and CI run in `links` |
  | `awaiting_agent` | waiting on another lane; name it in `activity` |
  | `idle` | nothing to do right now |
  | `completed` | done |

- **Removing:** when a lane's work stream is over for good, `remove_lane` takes it off the dashboard. Its history is kept.
- **Writing for a phone:** keep `activity` to one line. Use ticket references like `gh:42` or `redmine:1234`.

## Raising an escalation

Call `create_escalation` once per decision. Four questions in a plan means four escalations; they appear together, in order. Write it so the owner understands it from a phone notification and the dashboard:

| Field | What to put in it |
|---|---|
| `context` | What you're doing, what you found, the tradeoffs and risks |
| `question` | The specific decision, as a question |
| `recommendation` | What you'd do and why |
| `cost` | What following the recommendation costs |
| `alternatives` | Other paths, one per entry, each with its tradeoff |
| `options` + `recommended_option` | 2–4 short answers, when it's a choice |
| `ticket` | What it's about (e.g. the PR), if it's not the lane's ticket |
| `blocking: false` | For an FYI that shouldn't stop the lane |

- **Codes:** each escalation gets a code, its `ref`, like **A12** (the lane's letter and a number). The owner uses it when they answer you ("A12: drop it"); use it too. Every tool accepts it in place of the id.
- **Retries are safe:** re-sending the same open question on the same lane returns the existing escalation (`duplicate: true`).
