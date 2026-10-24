# Design: tickets, parking and filling lanes

Status: **proposal**, for review before any schema change.

## Problem

Today a lane's ticket is just a column. When an overseer moves lane A from ticket 500 to bug fix 501, the column is overwritten. 500's escalations, status history and blocked time then read as 501's, and nothing can bring 500 back once 501 is done.

## Model

**Ticket** (new `tickets` table): one row per ticket ref per project. It carries:

- its escalations, coded with the ticket ref: **500A**, **500B** … **500Z**, **500AA**
- its status, status history and blocked time
- its state: `in_lane`, `parked` (with a reason), `done` or `dropped`
- which lane holds it, if any

**Lane**: a slot on the dashboard. It keeps its id, name, group and agent, its **activity feed** and its **messages** (`notify_owner` and the owner's notes). It holds at most one ticket. Its status is its ticket's status, or `idle` when it holds none.

Filling a lane is always explicit. Nothing is recalled automatically.

## Agent API

A new tool, `fill_lane`, does the whole switch in one call:

```
fill_lane(lane, ticket, previous: "park" | "done" | "drop", reason?, status?, activity?)
```

- Whatever ticket the lane holds leaves it as `parked` (`reason` required), `done` or `dropped`.
- `ticket` moves into the lane. It's created on first use, so there's no separate call. It can be a parked ticket from **any** lane, and it comes back with its escalations and history.
- Filling with a ticket another lane holds is refused (`409`).
- `remove_lane` also takes `previous`, so the agent can clear a lane and decide its ticket's fate in one call.

Example: lane A holds 500 and hits a blocker. The agent calls `fill_lane(A, 501, previous: park, reason: "blocked on vendor API")`. When 501 merges, it calls `fill_lane(A, 500, previous: done)`.

Compatibility: `update_lane` with a different ticket behaves like `fill_lane` with `previous: done`, so agents written for today's model keep working.

## Escalations

- They behave the same whether their ticket is in a lane or parked: they stay in the inbox, and they block, notify and get answered as now.
- **Change:** a blocking escalation holds its *ticket* blocked. A lane shows blocked only while its current ticket is blocked. Without this, a parked blocker would mark lane A blocked while it's working 501.
- A new inbox and History filter, **Active tickets only**, hides escalations whose ticket isn't in a lane.

## Codes

- New codes are the ticket ref plus a letter per ticket: 500A, 500B … 500Z, 500AA. A code never changes when its ticket moves lanes.
- Every tool and endpoint keeps accepting the code, case-insensitively, wherever it accepts an id today.
- Existing escalations keep their old codes (A12, SH·A1) as aliases, so exports and past conversations still resolve.
- Lanes keep their letters as card labels, but the letters no longer feed codes.

## Migration

Each existing lane with a ticket gets a ticket record that holds:

- its escalations
- its status history, and its blocked time
- a state of `in_lane`, or `done` if the lane is completed or archived

The lane keeps its activity feed and messages. Past ticket switches were never recorded, so legacy history can't be split by ticket.

## Dashboard

- The lane card shows its ticket, and the ticket's escalations as now.
- A **Parked** list per group shows each parked ticket with its reason, open questions and the lane it left.
- Opening a ticket shows its escalations and status history across every lane it passed through.
- The lane sheet shows the lane's feed and messages, with a marker at each switch ("Parked 500: blocked on vendor API · filled with 501").

## Export

- A new `tickets.csv`.
- A ticket column on `escalations.csv` and `lane_events.csv`.

## Settled

- **Lanes with no ticket** are allowed and show `idle`: work is often blocked, or can't run in parallel.
- **Refs from different systems** keep their prefix in codes when they have one (**gh:500A**). The default system's refs use the bare number (**500A**).

## Epics

A group can be linked to one or more epic tickets. Epics are long-lived and aren't worked in a lane, so they get their own table and rules.

- **`epics` table:** ref, name, state and links, linked many-to-many with groups.
- **Epic card:** sits alongside the lane cards. It shows the combined status updates of the lanes under it, and has its own message board, separate from any lane's messages.

## Open questions

1. **Escalations on a lane with no ticket.** Proposal: they attach to the group's epic and take the epic's code (**900A**). A group with no epic would fall back to the lane's letter, as today.
2. **A URL used as a ticket ref.** Linking is unaffected. The issue is the code text: the code is the ref plus a letter, so the ref `https://github.com/o/r/issues/500` would give a code ending `…/issues/500A`.
3. **Which lanes feed an epic's card**, when a group has several epics.
4. **What makes an epic "not worked the same"**: its states, its blocking rules, and whether questions can be raised on it.
5. **Whether an epic can span groups.**

## Delivery

1. **Tickets:** schema, migration, ticket codes, `fill_lane`, filters, export. Server and agent tools first, with the dashboard following.
2. **Dashboard for tickets:** the Parked list, the ticket view and switch markers.
3. **Epics:** the table, group links, the epic card and its message board.
