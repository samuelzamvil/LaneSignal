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

LaneSignal tracks when each lane last published, how long it has been in its current status, and total **time blocked**. A lane that is `active`, `pending_ci` or `awaiting_agent` and goes quiet for `LANESIGNAL_STALE_MINUTES` is flagged *stale*.

Its history keeps every status change and escalation step. Routine activity text is capped at the last `LANESIGNAL_EVENT_RETENTION` entries.

**Removing** a lane or group from the dashboard archives it rather than deleting it, so its escalations and history stay available for [export](export.md). People remove lanes in the app; overseers remove theirs with `remove_lane` when the work stream is over.

### Lane letters and escalation codes

Each active lane gets a letter, shown on its card: A, B, … Z, then AA, AB. Letters and codes are per [project](projects.md); where projects mix, codes carry the project key (**SH·A1**). Its escalations are coded with it: **A1**, **A2**, then B1 for lane B, so two overseers' questions never share a code.

- A lane keeps its letter while it's active, and after that while any of its escalations is unanswered or not yet acknowledged.
- Once a lane is completed or removed and nothing is pending, its letter goes back to the pool. The next new lane takes the smallest free letter, so letters stay short.
- Numbers keep counting per letter. If A1–A5 belonged to a lane that finished, the next lane to get A starts at **A6**, so a code always means one escalation, in exports too.

## Escalations

An escalation is a question for humans, attached to a lane. Only `question` is required. The rest follows a loose structure:

| Field | Meaning |
|---|---|
| `ref` | Set by the server: a code like **A12** (the lane's letter and a number) that people and agents can use to refer to the escalation. Every tool and endpoint accepts it in place of the id |
| `context` | What you need to know to decide; the inbox card shows its first lines |
| `question` | The decision being asked for. It's also the headline |
| `recommendation` | What the agent would do and why |
| `recommendedOption` | Which of `options` is the recommended one; it gets a "Recommended" badge |
| `cost` | What following the recommendation costs: dependencies, time, risk |
| `alternatives` | Other paths considered, one per entry, each with its tradeoff |
| `ticket` | What the question is about, such as the plan `gh:921`, when it differs from the lane's ticket |
| `options` | Up to 10 short answers (one-tap buttons when answering on the dashboard is on) |
| `positions` | Other agents' views on the recommendation: `{agent, stance: agree / disagree / neutral, note}`, one per agent |
| `links` | Anything else worth opening |

### Many questions per lane

A lane can have any number of open escalations. A plan with four questions raises four escalations:

- The inbox lists them together, in order, as "Question 1 of 4 from this lane".
- The detail view has **Previous** and **Next** for stepping through them.

### Lifecycle (default: alerts)

By default LaneSignal only **alerts** (`LANESIGNAL_DECISIONS=false`):

```
open ──(the agent dismisses it, saying what was decided)──► dismissed
```

1. The agent raises the escalation. Your phone is notified, and the lane shows as blocked.
2. You answer **in the agent's own session** (e.g. Remote Control), quoting the code ("A12: drop it"). The conversation and the decision stay in one place; the alert card links to the session when the overseer published it.
3. The agent dismisses the alert with a justification ("Sam: drop it, in session") and usually its next status. The justification is the record on the dashboard and in exports.

- The dashboard is read-only, apart from **Dismiss** for a stale alert whose session ended.
- Only the agent that raised an alert (any key of the same account) dismisses it, so an overseer can't close another's by reusing a code.
- Raising the same question again on the same lane while it's still open (ignoring spacing and case) returns the existing escalation, so agent retries don't create duplicates.
- A lane stays **blocked** while any of its blocking escalations is open, whatever status its agent publishes. Dismissing the last one puts the lane back to `active`, unless the agent says otherwise.

### Answering on the dashboard (optional)

With `LANESIGNAL_DECISIONS=true`, people can also answer on the dashboard, and agents wait for the answer:

```
open ──(human decides)──► decided ──(agent acknowledges)──► acknowledged
  └──────(dismissed: answered in the session / moot)──────► dismissed
```

- Escalations get one-tap answer buttons. Decided ones stay under *Decided · awaiting agent* until the agent acknowledges; one that waits longer than `LANESIGNAL_STALE_MINUTES` is flagged.
- If two humans answer at once, the second gets `409 Conflict`. **Change decision** replaces the answer until the agent acknowledges, e.g. after a mis-tap. Agents acknowledge before acting, and the acknowledgement returns the final answer.
- Only the agent that raised an escalation acknowledges it; a person can on its behalf.
- When a lane's last open blocking escalation is decided, the lane moves to `awaiting_agent`, which stops the blocked timer while the agent picks up the answer.
- While an agent waits for answers on a lane, the lane shows **agent waiting**. Waiting lanes aren't flagged stale. The flag clears about 30 seconds after the agent stops waiting.

### Blocking

- An escalation is **blocking** by default: creating it sets the lane to `blocked_human`.
- `blocking: false` marks an FYI that never holds the lane blocked. FYIs are listed separately in the inbox, aren't counted in the "Needs you" badge, don't make a lane look urgent, and notify quietly.
- Nothing else changes a lane the agent set to `blocked_human` itself. The agent publishes what it does next.

## Tickets

References become links through URL templates (`LANESIGNAL_TICKET_TEMPLATES`):

| Reference | Becomes |
|---|---|
| `redmine:1234` | That system's template with `{id}=1234` |
| `#1234` or `1234` | The default system's template |
| `https://…` | Used as-is |

LaneSignal links to tickets but never syncs or edits them.

## Notifications

By default, push notifications go out only when an escalation is **created**: urgent for blocking questions, quiet for FYIs. The title carries its code (`Needs you A12 · …`). Agreements, decisions and routine lane updates never page anyone. Add `blocked` or `completed` to `LANESIGNAL_NOTIFY_ON` to also be told when a lane becomes blocked without an escalation, or when it completes. See [Android and push](android.md).
