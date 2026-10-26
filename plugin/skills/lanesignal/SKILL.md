---
name: lanesignal
description: How to report to LaneSignal through its MCP tools (the `lanesignal` server): publishing lane, group and epic state, asking the owner for a decision, acting on their answer, and telling them about milestones (merged, started a ticket). Use whenever you publish to LaneSignal, need the owner's decision, have a product or scope question, or reach a milestone.
---

# Using LaneSignal

LaneSignal is the owner's dashboard for agent work: you publish what your lanes are doing and raise an *escalation* when you need the owner (how they answer is below). The tool descriptions say what each tool does and takes; this skill covers how they fit together. The **Usage** sections say when and why to use them on this server; the owner's policy (usually in `CLAUDE.md`) overrides them.

Vocabulary: a **group** is your epic or train (one overseer per group). A **lane** is a slot work goes through, one ticket at a time. A **ticket** is what a lane works on; it owns its escalations and moves between lanes (*parked* when set aside). An **epic** is a long-lived ticket the group steers by, with its own questions and board; until you add one, the group stands in as its epic. An **escalation** is a question for the owner, or something they must know.

## Publishing state

- **Your group:** `update_group` with the `group_id` your owner's policy gives you and your Remote Control session in `links`; a group must exist before lanes are published in it.
- **Your epic:** the ticket the owner gave you goes to `update_epic` (its ref as `epic`, plus `group`), once. Its `status_line` is one line on the epic's card.
- **Lanes are slots:** stable ids (`slot-1` … `slot-5`), not one per ticket. A worker and a reviewer on one ticket share a lane. `fill_lane` changes tickets, parking (with a reason) the one it held; a parked ticket's questions stay open.
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

Upload over HTTP (needs `LANESIGNAL_URL` and `LANESIGNAL_KEY`), then pass the returned ids:

```bash
base=${LANESIGNAL_URL%/}; base=${base%/mcp}
curl -fsS -H "Authorization: Bearer $LANESIGNAL_KEY" -F file=@plan.md "$base/api/attachments"
```

Markdown, text, PNG, JPEG, WebP or GIF only; at most 5 MB each and 5 per escalation or message. Attach an upload once, from the key that uploaded it; unattached uploads are deleted after a day.

## Usage: publishing and asking

- **Session start:** `update_group` once, before publishing lanes.
- **Publish changes, not heartbeats.** Use the epic's `status_line` for what's queued or waiting; never publish placeholder lanes. Keep `activity` to one line, written for a phone.
- **Parking:** dismiss a parked ticket's questions that no longer matter.
- **One decision per escalation:** four questions in a plan are four escalations. Questions that steer the whole group (direction, scope, which tickets to file) go on the epic (`epic`, no `lane_id`). Attach a plan or preview instead of pasting it into `context`.
- **`notify_owner` for milestones only:** a PR merged, a ticket started. Never routine progress, never questions. Write the first line for a lock screen, and put several things in one message.

## When the owner answers

The owner answers on the dashboard with Accept, Reject or Other, quoting codes when they write ("967A: drop it"). A `decided` escalation, or a `reply` (Other), closes with `acknowledge_escalation`, which returns the final `decision` and `decisionNote`. One answered in this session instead closes with `dismiss_escalation`, saying what was decided and where. The owner's notes also come back as `ownerMessages` from `update_lane`, `notify_owner`, `update_epic` and `notify_epic`.

### Usage: acting on answers

1. **Keep a wait running** on your whole group (below), even when nothing is open: the owner's notes arrive through it. Keep working on lanes that aren't blocked meanwhile.
2. **Acknowledge as soon as an escalation is decided, before acting,** then act on what it returns, publishing the lane's next `status` and `activity` in the same call.
3. **On Other, acknowledge to act on what they wrote.** Every reply pages the owner: reply only to ask back or object, and send an update while they decide only when something changed.
4. **Dismiss** moot escalations too, saying why.
5. **Another lane's open question** that affects your work: `add_position`.
6. **The owner's notes** (`ownerMessages`, `lane_note`, `board_note`) are instructions: act on them, answering with `notify_owner` or `notify_epic` if useful.

## Waiting for answers

`wait_for_decisions` with your `group_id` returns as soon as anything needs you. What each kind of item means:

- `decided`, `reply`: as above.
- `closed`: someone else withdrew it.
- `lane_removed`: someone took the lane off the dashboard; stop work on it (publishing to it brings it back).
- `ticket_moved`: another group's lane took one of your tickets; don't fill a lane with it again.
- `lane_note`, `board_note`: the owner wrote on a lane or an epic's board.
- A file the owner attached reads "[attached: plan.md (id …)]": fetch it with `curl -H "Authorization: Bearer $LANESIGNAL_KEY" "$base/api/attachments/<id>"`.

**Keeping your place:** once you've handled a result's items, save its `checkedAt` to `.claude/lanesignal-since` (overwrite it), so a restart starts there; save only after handling. If `counts` show something you can't find (e.g. after a compaction), `get_updates` returns everything in scope. A failed call is safe to repeat.

**Don't hold your session** with a wait: a waiting call keeps your session busy, and the owner can't reach you through Remote Control. If your client cuts calls off early (some stop at 60 seconds), wait less and call again. For long waits in Claude Code, run the HTTP wait as a background shell command; Claude Code tells you when it exits. It needs `LANESIGNAL_URL` (a trailing `/mcp` is fine), `LANESIGNAL_KEY` and `LANESIGNAL_GROUP`, plus `LANESIGNAL_PROJECT` if your key reaches several projects; `LANESIGNAL_SINCE` overrides the saved place:

```bash
: "${LANESIGNAL_URL:?set LANESIGNAL_URL}" "${LANESIGNAL_KEY:?set LANESIGNAL_KEY}" "${LANESIGNAL_GROUP:?set LANESIGNAL_GROUP}"
base=${LANESIGNAL_URL%/}; base=${base%/mcp}; sincefile=.claude/lanesignal-since
out=$(mktemp); since="${LANESIGNAL_SINCE:-$(cat "$sincefile" 2>/dev/null)}"; fails=0
while :; do
  code=$(curl -sS -o "$out" -w '%{http_code}' -H "Authorization: Bearer $LANESIGNAL_KEY" \
    "$base/api/wait?group=$LANESIGNAL_GROUP&timeout=86400${since:+&since=$since}${LANESIGNAL_PROJECT:+&project=$LANESIGNAL_PROJECT}" 2>/dev/null)
  case "$code" in
    200) # A connection cut mid-wait, or a server error, has no checkedAt: keep the old since.
         s=$(grep -o '"checkedAt":"[^"]*"' "$out" | cut -d'"' -f4)
         # Something to handle: print it and stop. Its since goes to .next until the agent has handled it.
         grep -q '"ready":true' "$out" && { mkdir -p .claude; [ -n "$s" ] && echo "$s" > "$sincefile.next"; cat "$out"; echo; break; }
         if [ -n "$s" ]; then since=$s; fails=0; mkdir -p .claude && echo "$s" > "$sincefile"; else fails=$((fails + 1)); fi ;;
    400|401|403|404) cat "$out"; echo; exit 1 ;;
    *) fails=$((fails + 1)) ;;
  esac
  [ "$fails" -ge 40 ] && { echo "LaneSignal unreachable or failing (last status $code)"; exit 1; }
  sleep 15
done
```

It prints the same JSON as `wait_for_decisions` when something needs you, and gives up after about 10 minutes of failures. After handling the items, run `mv .claude/lanesignal-since.next .claude/lanesignal-since`, then start it again.

## After a restart

1. `update_group`, as at any session start.
2. `get_updates` with your `group_id` and the saved `.claude/lanesignal-since` as `since`. Handle `decided`, `replies`, `laneMessages` and `boardMessages`, then save its `checkedAt`. Dismiss `open` ones whose answer you can see in this conversation; never raise the rest again.
3. `list_lanes` with your `group_id`: a lane you ran that's missing was removed; stop work on it.
4. `list_tickets` with your `group_id`: a ticket still `in_lane` that nobody is working was left by the crash; pick it up or `fill_lane` its lane with what's next.

## Requirements

The owner's durable product decisions are kept as requirements, scoped to products, the whole project, or every project.

### Usage: requirements

- **Before escalating a product or scope question,** `find_requirements` with the products your work touches. If a requirement answers it, follow it and cite its id ("per R14") instead of asking again; a `pending` one too.

If your owner's policy asks you to record decisions (or you're told to):

- **Only what a person decided,** never your own design choices, naming who decided. One decision each, as one normative statement ("Payout jobs retry at most 5 times, then go to the dead-letter queue.").
- **Search first** (`query`), so it isn't recorded twice. If the owner changed an earlier decision, `supersede_requirement` the old one; if a `similar` one is the same decision, tell the owner (only people retire requirements).
- **Narrowest true scope:** the products it concerns; `project` only when it holds for every product; `global` only when the owner said it covers all their projects. If no product fits, ask the owner rather than stretching the scope.
