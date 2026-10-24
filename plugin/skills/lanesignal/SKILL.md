---
name: lanesignal
description: How to report to LaneSignal through its MCP tools (the `lanesignal` server): publishing lane and group state, asking the owner for a decision, acting on their answer, and telling them about milestones (merged, started a ticket). Use whenever you publish to LaneSignal, need the owner's decision, have a product or scope question, or reach a milestone.
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
| `attachments` | Files the owner should read or see: a plan (`.md`), notes (`.txt`), a UI screenshot (PNG, JPEG, WebP, GIF). See below |
| `ticket` | What it's about (e.g. the PR), if it's not the lane's ticket |
| `blocking: false` | For an FYI that shouldn't stop the lane |

- **Codes:** each escalation gets a code, its `ref`, like **A12** (the lane's letter and a number). The owner uses it when they answer you ("A12: drop it"); use it too. Every tool accepts it in place of the id.
- **Retries are safe:** re-sending the same open question on the same lane returns the existing escalation (`duplicate: true`).
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

## When the owner answers

The owner answers on the LaneSignal dashboard or phone app with one of three buttons, then you wait for the decision, acknowledge it and act on it.

- **Say what each answer means** when you raise it: `accept_means` (one line: what you do on Accept) and `reject_means` (what you do on Reject). Pass `allow_reject: false` when rejecting makes no sense (e.g. "Rotate the leaked key?").
- **Accept or Reject** arrive as a decision (`decided` in the wait), with any instructions in `decisionNote`: follow them.
- **Other opens a conversation.** The escalation stays open and the wait returns it in `replies`, with the owner's new messages. Then either:
  - **act on it:** `acknowledge_escalation` takes their latest message as the decision (`Other`), then do what it says; or
  - **reply:** `reply_to_escalation` with a short question back or what you'll do. The owner answers again with Accept, Reject or another message.
- **Keep messages short:** at most 500 characters, plain, no preamble or recap. Anything longer (a revised plan, a diff summary, a screenshot) goes in an attachment.
- **Updates while they decide:** you may `reply_to_escalation` with a one-line update when something changed that affects the answer (e.g. "CI found a second failure"). Never to chat or repeat yourself: every message notifies their phone, and updates are limited to one a minute. Retrying the same message is harmless.

1. **Wait** for answers on your whole group (next section). Keep working on lanes that aren't blocked meanwhile.
2. **Acknowledge first, then act:** call `acknowledge_escalation` as soon as an escalation is decided. It returns the final `decision` and `decisionNote` (the owner may correct a mis-tap until you acknowledge). Act on what it returns. Only the agent that raised an escalation can acknowledge it; repeating an acknowledgement changes nothing.
3. **Publish the next state in the same call:** pass `status` and `activity`, e.g. `status: "active", activity: "Dropping the column (A12)"`.
4. **Answered in this session instead?** If the owner answers you here ("A12: drop it"), close it with `dismiss_escalation`: `justification` says what was decided and where, e.g. `"Sam: drop the column (in session, 2026-10-23)"`, plus `status` and `activity` as above. Dismiss moot escalations the same way, saying why ("Superseded by A14"). Only you can dismiss yours; the owner may also dismiss a stale one from the dashboard.
5. **Other lanes' questions:** if one affects your work, `add_position` with `agree`, `disagree` or `neutral` and a one-line reason, while it's still open.

## Waiting for answers

Answers can take minutes or a day.

- **Waiting on your group:** call `wait_for_decisions` with your `group_id`. It returns as soon as anything needs you:
  - `decided`: answered. Acknowledge and act on each one (above).
  - `replies`: the owner answered Other; `messages` are theirs since you last wrote. Acknowledge and act, or reply (above). They come back on every wait until you do.
  - `closed`: withdrawn by someone else. "Lane removed by …" means the lane was taken off the dashboard.
  - `removedLanes`: lanes someone else took off the dashboard (including ones with nothing open). Stop work on them and don't publish to them again; publishing brings a lane back.
  - `laneMessages`: the owner's notes on lanes in scope, outside any escalation. Each note comes back once: here, or as `ownerMessages` from your next `update_lane` or `notify_owner` on that lane. Act on them like the owner's instructions; answer with `notify_owner` if useful.
  - `open`: still waiting.
  - `ready: false`: the wait ran out. Call again.
  - `ready: true` with everything empty: nothing is waiting on the owner. Stop waiting.
- **Pass `checkedAt` back:** always pass the last result's `checkedAt` as `since` on your next wait, including after handling decisions, so a removal in between still reaches you. Also save it to the file `.claude/lanesignal-since` (overwrite it after every wait), so it survives a restart; the loop below does this itself.
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
           if [ -n "$s" ]; then since=$s; fails=0; mkdir -p .claude && echo "$s" > "$sincefile"; else fails=$((fails + 1)); fi
           grep -q '"ready":true' "$out" && { cat "$out"; echo; break; } ;;
      400|401|403|404) cat "$out"; echo; exit 1 ;;
      *) fails=$((fails + 1)) ;;
    esac
    [ "$fails" -ge 40 ] && { echo "LaneSignal unreachable or failing (last status $code)"; exit 1; }
    sleep 15
  done
  ```

  If your key reaches several projects, also set `LANESIGNAL_PROJECT`. It starts from the `checkedAt` saved in `.claude/lanesignal-since` (or `LANESIGNAL_SINCE`, if set), saves each new one there, prints the same JSON as `wait_for_decisions`, and gives up after about 10 minutes of failures.

## After a restart

1. Call `update_group` (as at any session start).
2. Call `wait_for_decisions` with your `group_id`, `wait_seconds: 0` and the `checkedAt` saved in `.claude/lanesignal-since` (if the file exists) as `since`. Handle anything decided or in `replies` while you were away. Dismiss any `open` ones whose answer you can see in this conversation; the rest are still waiting on the owner, so never raise them again.
3. Call `list_lanes` with your `group_id`. A lane you were running that's missing was removed: stop work on it.


## Requirements: the owner's past decisions

LaneSignal keeps the owner's product decisions as **requirements**, outside the repository, so any agent can find them later.

**Before you ask:** for product or scope questions, call `find_requirements` first (`query` is free text; pass your `group_id`). If an active requirement answers the question, follow it and cite its id ("per R14") instead of asking again.

If your owner's policy asks you to keep product decisions (or you're told to record one):

- **Owner decisions only.** Record only what a person decided, never your own design choices. Every requirement names who decided: `decided_by` (e.g. `"Sam (Remote Control, 2026-10-23)"`), plus `source_escalation: "A12"` when it came from an escalation. (Where the owner answers in LaneSignal itself, the escalation alone names the decider.)
- **Short and single:** one decision per requirement, written as one normative statement ("Payout jobs retry at most 5 times, then go to the dead-letter queue."): at most 300 characters, with the reasoning in `justification` (at most 800).
- **Tags:** 1–3 specific kebab-case tags naming the capability (`payout-retries`, not `backend`). Check `list_requirement_tags` and reuse existing tags.
- **Scope:** set `group_id` for your train/epic, or leave it out for decisions about the whole project. Pass `all_projects: true` only when the owner said the decision covers all their projects.
- **Search first:** `find_requirements` with the decision's key words before recording, so it isn't recorded twice. Recording the same requirement from the same `source_escalation` again returns the existing one (`duplicate: true`).
- **Check the reply:** `similar` lists active requirements that read alike, and `warnings` flags tags close to existing ones (reuse those). If a similar one is the same decision, tell the owner (only people retire requirements). If the owner changed an earlier decision, use `supersede_requirement` on the old one instead of recording a new one.
