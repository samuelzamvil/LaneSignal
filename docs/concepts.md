# Lanes, groups and escalations

## Groups: one overseer, many lanes

An overseer agent session runs several lanes for a body of tickets, an epic or a train, and the group is named after it. Overseer, epic/train and group are the same thing. `LANESIGNAL_GROUP_LABEL` only sets what the UI calls it.

A group has:

- a name
- the epic/train ticket
- links, most usefully the overseer's Remote Control session, so a decision is one tap from the conversation that owns it

A lane that references an unknown group creates it. The overseer fills in the details with `update_group`. The lane list is arranged by group by default, and groups with lanes that need you sort first.

## Lanes

A lane is one work stream with a stable id the agent picks (`auth-rework`, `e2e-stabilize`). It carries:

- **status:**

  | Status | Meaning |
  |---|---|
  | `active` | working |
  | `pending_ci` | waiting on CI |
  | `awaiting_agent` | waiting on another agent or lane |
  | `blocked_human` | needs a human decision |
  | `idle` | nothing to do right now |
  | `completed` | done |

- **group:** which epic/train it belongs to
- **ticket:** its *current* ticket. When a lane moves to the next ticket, the overseer publishes the new one under the same lane id
- **activity:** one line, readable on a phone
- **links:** PRs, CI runs, sessions. URLs must be http(s)

LaneSignal tracks when each lane last published, how long it has been in its current status, and total **time blocked**. A lane that is `active`, `pending_ci` or `awaiting_agent` and goes quiet for `LANESIGNAL_STALE_MINUTES` is flagged *stale*. Its activity history keeps the last `LANESIGNAL_EVENT_RETENTION` entries.

## Escalations

An escalation is a question for humans, attached to a lane. Only `question` is required. The rest follows a loose structure:

| Field | Meaning |
|---|---|
| `context` | What a human needs to know to answer without opening the agent's session |
| `question` | The decision being asked for. It's also the headline |
| `recommendation` | What the agent would do and why |
| `recommendedOption` | Which of `options` is the recommended one; it gets a "Recommended" badge |
| `cost` | What following the recommendation costs: dependencies, time, risk |
| `alternatives` | Other paths considered, one per entry, each with its tradeoff |
| `ticket` | What the question is about, such as the plan `gh:921`, when it differs from the lane's ticket |
| `options` | Up to 10 short answers, shown as one-tap buttons |
| `positions` | Other agents' views on the recommendation: `{agent, stance: agree / disagree / neutral, note}`, one per agent, added at creation or later |
| `links` | Anything else worth opening |

### Many questions per lane

A lane can have any number of open escalations. A plan with four questions raises four escalations:

- The inbox lists them together, in order, as "Question 1 of 4 from this lane".
- The detail view has **Previous** and **Next** for stepping through them.

### Lifecycle

```
open ──(human decides)──► decided ──(agent acknowledges)──► acknowledged
  └──────(agent or human withdraws: answered elsewhere / moot)──────► withdrawn
```

- Decided escalations stay on the dashboard under *Decided · awaiting agent* until the agent acknowledges.
- If two humans answer at once, the second gets `409 Conflict`.
- **Withdraw** is for questions that were answered elsewhere, for example in Remote Control, or that stopped mattering.

### Blocking

- An escalation is **blocking** by default: creating it sets the lane to `blocked_human`.
- `blocking: false` marks an FYI question that never holds the lane blocked.
- When a lane's **last open blocking** escalation is decided (or withdrawn while still open), the lane moves to `awaiting_agent`. That stops the blocked timer while the agent picks up the answer.
- Acknowledging never changes a lane's status. Neither does anything else on a lane the agent set to `blocked_human` itself. The agent publishes what it does next.

## Tickets

References become links through URL templates (`LANESIGNAL_TICKET_TEMPLATES`):

| Reference | Becomes |
|---|---|
| `redmine:1234` | That system's template with `{id}=1234` |
| `#1234` or `1234` | The default system's template |
| `https://…` | Used as-is |

LaneSignal links to tickets but never syncs or edits them.

## Notifications

By default, push notifications go out only when an escalation is **created**. Agreements, decisions and routine lane updates never page anyone. Add `blocked` or `completed` to `LANESIGNAL_NOTIFY_ON` to also be told when a lane becomes blocked without an escalation, or when it completes. See [Android and push](android.md).
