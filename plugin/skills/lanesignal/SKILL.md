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

## When the owner answers

The owner answers on the LaneSignal dashboard or phone app with one of three buttons, then you wait for the decision, acknowledge it and act on it.

- **Say what each answer means** when you raise it: `accept_means` (one line: what you do on Accept) and `reject_means` (what you do on Reject). Pass `allow_reject: false` when rejecting makes no sense (e.g. "Rotate the leaked key?").
- **Accept or Reject** arrive as a decision (a `decided` item in the wait), with any instructions after the answer in its `text` ("Accept: ship it Friday"): follow them.
- **Other opens a conversation.** The escalation stays open and the wait returns it as a `reply` item, with the owner's new messages in `text`. Then either:
  - **act on it:** `acknowledge_escalation` takes their latest message as the decision (`Other`), then do what it says. Don't reply first: a reply pages the owner; or
  - **reply:** `reply_to_escalation` with a short question back or what you'll do. The owner answers again with Accept, Reject or another message.
- **Keep messages short:** at most 500 characters, plain, no preamble or recap. Anything longer (a revised plan, a diff summary, a screenshot) goes in an attachment.
- **Updates while they decide:** you may `reply_to_escalation` with a one-line update when something changed that affects the answer (e.g. "CI found a second failure"). Never to chat or repeat yourself: every message notifies their phone, and updates are limited to one a minute. Retrying the same message is harmless.

1. **Wait** for answers on your whole group (next section). Keep working on lanes that aren't blocked meanwhile.
2. **Acknowledge first, then act:** call `acknowledge_escalation` as soon as an escalation is decided. It returns the final `decision` and `decisionNote` (the owner may correct a mis-tap until you acknowledge). Act on what it returns. Only the agent that raised an escalation can acknowledge it (or the overseer of the group its ticket or epic is in now); repeating an acknowledgement changes nothing.
3. **Publish the next state in the same call:** pass `status` and `activity`, e.g. `status: "active", activity: "Dropping the column (A12)"`.
4. **Answered in this session instead?** If the owner answers you here ("A12: drop it"), close it with `dismiss_escalation`: `justification` says what was decided and where, e.g. `"Sam: drop the column (in session, 2026-10-23)"`, plus `status` and `activity` as above. Dismiss moot escalations the same way, saying why ("Superseded by A14"). Only you (or your group's overseer) can dismiss yours; the owner may also dismiss a stale one from the dashboard.
5. **Other lanes' questions:** if one affects your work, `add_position` with `agree`, `disagree` or `neutral` and a one-line reason, while it's still open.

## Waiting for answers

Answers can take minutes or a day.

- **Waiting on your group:** call `wait_for_decisions` with your `group_id`. It returns a digest as soon as anything needs you, even when nothing is open: `items`, one per thing to handle, `{code, kind, id, text}`. `code` is the escalation's; `id` is its id, or the lane, ticket or epic the item is about; `text` is the owner's words (a file they attached reads "[attached: plan.md (id …)]": fetch it with `curl -H "Authorization: Bearer $LANESIGNAL_KEY" "$base/api/attachments/<id>"`). Kinds:
  - `decided`: answered. Acknowledge and act on each one (above).
  - `reply`: the owner answered Other; `text` is what they wrote since you last did. Acknowledge and act, or reply (above).
  - `closed`: withdrawn by someone else (a person dismissed it).
  - `lane_removed`: a lane someone else took off the dashboard (including ones with nothing open). Stop work on it and don't publish to it again; publishing brings a lane back.
  - `ticket_moved`: a lane outside your group took one of your group's tickets (another overseer picked up one you parked). Don't fill a lane with it again.
  - `lane_note`: the owner's notes on a lane in scope, outside any escalation. Act on them like the owner's instructions; answer with `notify_owner` if useful. They also come back as `ownerMessages` from your next `update_lane` or `notify_owner` on that lane.
  - `board_note`: the owner wrote on one of your group's epics' boards (`id` names the epic). Act on it like a `lane_note`; answer with `notify_epic` if useful.
- **What repeats:** `decided` and `reply` come back on every wait until you acknowledge or reply. The rest come back once per `since`.
- **`counts`** says how many are `open` (waiting on the owner), `decidedUnacknowledged` and `waitingOnYou`. If they show something you can't find in `items` (e.g. after a compaction), call `get_updates`: it returns everything in scope.
- **`ready: false`:** the wait ran out with nothing new. Call again. With nothing open, the wait keeps waiting for the owner's notes, so keep it running in the background (below).
- **Pass `checkedAt` back:** pass the last result's `checkedAt` as `since` on your next wait, so nothing in between is missed. Once you've handled a result's items, also save its `checkedAt` to the file `.claude/lanesignal-since` (overwrite it), so a restart starts from there. Save it only after handling: if you crash first, the older `since` brings the same items back. The loop below saves it itself while there's nothing to handle.
- **Don't hold your session:** a `wait_for_decisions` call holds your session for its whole `wait_seconds`, and the owner can't reach you through Remote Control meanwhile. When nothing is open, or the wait may be long, use the background loop below; for a quick check, pass `wait_seconds: 0`.
- **How long:** `wait_seconds` defaults to 300 (up to 3600). If your MCP client cuts calls off sooner (some stop at 60 seconds), pass a shorter wait and call again.
- **Failed calls:** if a call fails (timeout, dropped connection, server restart), just call again. Decided escalations wait for you until you acknowledge them.
- **Long waits in Claude Code:** a waiting tool call keeps your session busy, so the owner can't talk to you through Remote Control. For waits that may take hours, run the HTTP wait as a background shell command instead. Claude Code tells you when it exits. It needs `LANESIGNAL_URL` (the server's base URL; a trailing `/mcp` is tolerated), `LANESIGNAL_KEY` and `LANESIGNAL_GROUP` (your group id) in the environment:

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

  If your key reaches several projects, also set `LANESIGNAL_PROJECT`. It starts from the `checkedAt` saved in `.claude/lanesignal-since` (or `LANESIGNAL_SINCE`, if set), saves each new one there while nothing needs you, prints the same JSON as `wait_for_decisions` when something does, and gives up after about 10 minutes of failures. After handling the items, run `mv .claude/lanesignal-since.next .claude/lanesignal-since`, then start the loop again.

## After a restart

1. Call `update_group` (as at any session start).
2. Call `get_updates` with your `group_id` and the `checkedAt` saved in `.claude/lanesignal-since` (if the file exists) as `since`. Handle anything in `decided` or `replies`, and the owner's `laneMessages` and `boardMessages`, from while you were away, then save its `checkedAt` to `.claude/lanesignal-since` (otherwise the next wait returns the same notes again). Dismiss any `open` ones whose answer you can see in this conversation; the rest are still waiting on the owner, so never raise them again.
3. Call `list_lanes` with your `group_id`. A lane you were running that's missing was removed: stop work on it.
4. Call `list_tickets` with your `group_id`. A ticket still `in_lane` that nobody is working now was left behind by the crash: pick it up again or `fill_lane` its lane with what's next (parking it). Parked ones are waiting for a free slot.

## Requirements: rules every agent on a project follows

LaneSignal keeps the owner's durable product decisions as **requirements**, outside the repository. Each one is a short rule scoped to where it applies: chosen **products** of a project, the whole **project**, or (rarely) **global**, every project.

**Finding what applies:** `find_requirements` with the products your work touches (`products: ["…"]`; `list_products` shows them) returns those products' requirements plus the project-wide and global ones in one call, and names the scope it used. Check it before escalating a product or scope question. For work not tied to a product, pass `project_only: true`. Follow what comes back and cite ids ("per R14") instead of asking again. Justification isn't included; `get_requirement` with `include_justification: true` has it when you need the reasoning.

If your owner's policy asks you to keep product decisions (or you're told to record one):

- **Owner decisions only.** Record only what a person decided, never your own design choices. Every requirement names who decided: `decided_by` (e.g. `"Sam (Remote Control, 2026-10-23)"`), plus `source_escalation: "A12"` when it came from an escalation. (Where the owner answers in LaneSignal itself, the escalation alone names the decider.)
- **Short and single:** one decision per requirement, written as one normative statement ("Payout jobs retry at most 5 times, then go to the dead-letter queue."): at most 300 characters, with the reasoning in `justification` (at most 800).
- **Scope is required:** `scope: "products"` with the `products` it concerns (several if it spans them), `"project"` only when it truly holds for every product in the project, `"global"` only when the owner said it covers all their projects. Recording without a scope is refused. Only the owner adds products: if none fits, ask rather than stretching the scope.
- **Locked products:** a locked product refuses new requirements and changes to its requirements from agents. Tell the owner instead.
- **Search first:** `find_requirements` with `query` set to the decision's key words (and the products concerned, or `project_only`) before recording, so it isn't recorded twice; `similar` in the reply also catches look-alikes elsewhere in the project. Recording the same requirement from the same `source_escalation` again returns the existing one (`duplicate: true`).
- **Pending until approved:** what you record is `pending` until the owner approves it in LaneSignal, whatever its scope. Pending requirements still come back from `find_requirements` (marked `status: "pending"`); follow them like active ones. When you supersede, the old requirement stays in force (its `supersededBy` names yours) until the owner approves the replacement. Searches return such a pair together, the current requirement then the pending change: follow the current one, but know it may be about to change.
- **Check the reply:** `similar` lists pending or active requirements that read alike. If a similar one is the same decision, tell the owner (only people retire requirements). If the owner changed an earlier decision, use `supersede_requirement` on the old one instead of recording a new one (it keeps the old one's scope unless you give another).
