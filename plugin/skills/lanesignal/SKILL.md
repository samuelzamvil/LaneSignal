---
name: lanesignal
description: How to report to LaneSignal through its MCP tools (the `lanesignal` server): publishing lane, group and epic state, asking the owner for a decision, acting on their answer, and telling them about milestones (merged, started a ticket). Use whenever you publish to LaneSignal, need the owner's decision, have a product or scope question, or reach a milestone.
---

# Using LaneSignal

LaneSignal is the owner's dashboard for agent work: you publish what your lanes are doing and raise an *escalation* when you need the owner, who answers from their phone. The tool descriptions say what each tool does and takes; this skill covers how they fit together. **When** to use them (what deserves an escalation, which lanes to run, whether to record requirements) is the owner's policy, usually in `CLAUDE.md`; follow it where it says more.

Vocabulary: a **group** is your epic or train (one overseer per group). A **lane** is a slot work goes through, one ticket at a time. A **ticket** is what a lane works on; it owns its escalations and moves between lanes (*parked* when set aside). An **epic** is a long-lived ticket the group steers by, with its own questions and board; until you add one, the group stands in as its epic. An **escalation** is a question for the owner, or something they must know.

## Publishing state

- **Session start:** `update_group` once, with the `group_id` your owner's policy gives you and your Remote Control session in `links`, before publishing lanes.
- **Your epic:** the ticket the owner gave you goes to `update_epic` (its ref as `epic`, plus `group`) once. Use the epic's `status_line` for what's queued or waiting; never publish placeholder lanes.
- **Lanes are slots:** stable ids (`slot-1` … `slot-5`), not one per ticket. A worker and a reviewer on one ticket share a lane. Change tickets with `fill_lane`, parking (with a reason) what's blocked; its questions stay open, so dismiss ones that no longer matter.
- **Publish changes, not heartbeats.** A lane holding no ticket shows `idle`, and one with an open blocking escalation shows `blocked_human`, whatever you publish.
- **Write for a phone:** one-line `activity`. In any text, `#1234` links to the default ticket system and `redmine:1234` to that one; in `ticket` fields use `system:id`. PRs and CI runs go in `links`.

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

Questions that steer the whole group (direction, scope, which tickets to file) go on the epic (`epic`, no `lane_id`). The owner answers by code ("967A: drop it"); use the codes too.

### Attachments

Attach a plan or preview instead of pasting it into `context`. Upload over HTTP (needs `LANESIGNAL_URL` and `LANESIGNAL_KEY`), then pass the returned ids:

```bash
base=${LANESIGNAL_URL%/}; base=${base%/mcp}
curl -fsS -H "Authorization: Bearer $LANESIGNAL_KEY" -F file=@plan.md "$base/api/attachments"
```

Markdown, text, PNG, JPEG, WebP or GIF only; at most 5 MB each and 5 per escalation or message. Attach an upload once, from the key that uploaded it; unattached uploads are deleted after a day.

## Milestones and boards

- `notify_owner`: milestones only (a PR merged, a ticket started) unless your owner's policy names others. First line written for a lock screen; put several things in one message.
- `notify_epic`: the longer conversation about direction and what comes next.
- The owner's notes come back as `ownerMessages` from `update_lane`, `notify_owner`, `update_epic` and `notify_epic`: act on them like instructions.

## When the owner answers

The owner answers on the dashboard with Accept, Reject or Other. Say what Accept and Reject mean when you raise it (`accept_means`, `reject_means`).

1. **Wait** on your whole group (below), and keep working on lanes that aren't blocked.
2. **`decided`:** `acknowledge_escalation` first, then act on the `decision` it returns (with any instructions after it, e.g. "Accept: ship it Friday"), publishing the lane's next `status` and `activity` in the same call.
3. **`reply` (Other):** to act on what they wrote, acknowledge it; reply (`reply_to_escalation`, short) only to ask back or object, since every message pages the owner. Longer material goes in an attachment.
4. **Answered here instead** ("A12: drop it"): `dismiss_escalation` saying what was decided and where. Dismiss moot ones the same way, saying why.
5. **Another lane's question** affects your work: `add_position` while it's open.

## Waiting for answers

`wait_for_decisions` with your `group_id` returns as soon as anything needs you. What to do with each kind of item:

- `decided`, `reply`: as above. They repeat until handled.
- `closed`: someone else withdrew it.
- `lane_removed`: stop work on that lane and don't publish to it (publishing brings it back).
- `ticket_moved`: another group's lane took one of your tickets; don't fill a lane with it again.
- `lane_note`, `board_note`: the owner's notes; act on them like instructions, answering with `notify_owner` or `notify_epic` if useful.
- A file the owner attached reads "[attached: plan.md (id …)]": fetch it with `curl -H "Authorization: Bearer $LANESIGNAL_KEY" "$base/api/attachments/<id>"`.

**Keeping your place:** pass each result's `checkedAt` as `since` on the next wait. Once you've handled a result's items, save its `checkedAt` to `.claude/lanesignal-since` (overwrite it), so a restart starts there; save only after handling. If `counts` show something you can't find (e.g. after a compaction), `get_updates` returns everything in scope. A failed call is safe to repeat.

**Don't hold your session:** a waiting call keeps your session busy, and the owner can't reach you through Remote Control. Use `wait_seconds: 0` for a quick check; if your client cuts calls off early (some stop at 60 seconds), wait less and call again. For long waits in Claude Code, run the HTTP wait as a background shell command; Claude Code tells you when it exits. It needs `LANESIGNAL_URL`, `LANESIGNAL_KEY` and `LANESIGNAL_GROUP` (plus `LANESIGNAL_PROJECT` if your key reaches several projects):

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

## Requirements: rules every agent on a project follows

The owner's durable product decisions are kept as **requirements**, each scoped to chosen **products** of a project, the whole **project**, or (rarely) **global**. `find_requirements` with the products your work touches returns everything that applies; follow it and cite ids ("per R14") instead of asking again.

If your owner's policy asks you to keep product decisions (or you're told to record one):

- **Owner decisions only:** what a person decided, never your own design choices, naming who decided (`decided_by`, and `source_escalation` when it answered one).
- **One decision each,** as one normative statement ("Payout jobs retry at most 5 times, then go to the dead-letter queue."), with the reasoning in `justification`.
- **Narrowest true scope:** the products it concerns (several if it spans them); `project` only when it holds for every product; `global` only when the owner said it covers all their projects. Only the owner adds products: if none fits, ask rather than stretching the scope. A locked product refuses your changes: tell the owner instead.
- **Search first** (`query`) so it isn't recorded twice. If the owner changed an earlier decision, `supersede_requirement` the old one rather than recording a new one; if a `similar` one is the same decision, tell the owner (only people retire requirements).
