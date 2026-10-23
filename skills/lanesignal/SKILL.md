---
name: lanesignal
description: How to report to LaneSignal through its MCP tools (the `lanesignal` server): publishing lane and group state, raising escalations for human decisions, waiting for and acting on answers (including waits of many hours), recovering after a restart, and finding or recording the owner's product requirements. Use whenever you publish to LaneSignal, need a human decision, or have a product or scope question.
---

# Using LaneSignal

LaneSignal is the owner's dashboard for agent work. You publish what your lanes are doing, ask the owner for decisions you can't make, and pick up their answers. This skill covers **how** to use the tools. **When** to use them (what deserves an escalation, which lanes to run, whether to record requirements) is the project owner's policy, usually in `CLAUDE.md`. Follow that policy where it says more than this.

Vocabulary:
- A **group** is your epic or train (one overseer runs one group).
- A **lane** is one ticket or work stream in it.
- An **escalation** is a question for the owner.
- A **requirement** is a product decision the owner made, kept for later.

## Projects

A server can host several independent projects (apps), each with its own groups, lanes and codes. If your key is bound to one project, or reaches only one, ignore this section. Otherwise:

- `list_projects` shows the ones you can reach. Use the project your owner's policy names (the same value as `LANESIGNAL_PROJECT` below).
- Pass `project` (its id or key) on every call. Without it, an existing lane or group id is found in whichever of your projects has it, but a new id, or one in several projects, fails with "Say which project".
- Refer to escalations by their keyed code (`SH-A12`): bare codes like `A12` repeat across projects.

## Publishing state

- **Start of a session:** call `update_group` once, with your `group_id` (the one your owner's policy gives you; the same value as `LANESIGNAL_GROUP` below), your epic/train `name`, its `ticket`, and your Remote Control session URL in `links` (`{label: "Overseer session", url: …, kind: "session"}`). Do this before waiting on the group: waiting on a group that doesn't exist yet is an error.
- **Lane ids:** give each lane a stable `lane_id`, and pass `group` on its first `update_lane`. Publish a lane before raising escalations on it; unknown lanes and groups are errors, so a typo can't create a lane your wait never sees.
- **Blocked lanes:** a lane with an open blocking escalation stays `blocked_human` whatever status you publish, until the owner answers.
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

## Before you ask: check the requirements

If your project keeps requirements, then for product or scope questions call `find_requirements` first (`query` is free text; pass your `group_id`). If an active requirement answers the question, follow it and cite its id ("per R14") instead of asking again.

## Raising an escalation

Call `create_escalation` once per decision. Four questions in a plan means four escalations; they appear together, in order. Write it so the owner can answer from a phone without opening your session:

| Field | What to put in it |
|---|---|
| `context` | What you're doing, what you found, the tradeoffs and risks |
| `question` | The specific decision, as a question |
| `recommendation` | What you'd do and why |
| `cost` | What following the recommendation costs |
| `alternatives` | Other paths, one per entry, each with its tradeoff |
| `options` + `recommended_option` | 2–4 short answers for one-tap replies, when it's a choice |
| `ticket` | What it's about (e.g. the PR), if it's not the lane's ticket |
| `positions` | Other agents' agree/disagree, if known |
| `blocking: false` | For an FYI that shouldn't stop the lane |

- **Codes:** each escalation gets a code, its `ref`, like **A12** (the lane's letter and a number). Use it when you talk to the owner ("A12 is waiting on you"). Every tool accepts it in place of the id.
- **Retries are safe:** re-sending the same open question on the same lane returns the existing escalation (`duplicate: true`).
- **Other lanes' questions:** if one affects your work, `add_position` with `agree`, `disagree` or `neutral` and a one-line reason, while it's still open.
- **Answered another way:** if a question is answered elsewhere (e.g. in Remote Control) or stops mattering, `withdraw_escalation` with the reason in `resolution`.

## Waiting for answers

Answers can take minutes or a day.

- **Waiting on your group:** call `wait_for_decisions` with your `group_id`. It returns as soon as anything needs you:
  - `decided`: answered. Handle each one (next section).
  - `closed`: withdrawn by someone else. "Lane removed by …" means the lane was taken off the dashboard.
  - `removedLanes`: lanes someone else took off the dashboard (including ones with nothing open). Stop work on them and don't publish to them again; publishing brings a lane back.
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

## Acting on a decision

1. **Acknowledge first, then act:** call `acknowledge_escalation` as soon as an escalation is decided. It returns the final `decision` and `decisionNote` (the owner may correct a mis-tap until you acknowledge). Act on what it returns. Only the agent that raised an escalation can acknowledge it.
2. **Publish the next state in the same call:** pass `status` and `activity`, e.g. `status: "active", activity: "Dropping the column (A12)"`.
3. **Repeats are harmless:** repeating an acknowledgement changes nothing.

## Recording the owner's decisions as requirements

If your owner's policy asks you to keep product decisions (or you're told to record one):

- **Owner decisions only.** Record only what a person decided, never your own design choices. Every requirement names its source: `source_escalation: "A12"` (its decider is recorded), or `decided_by` (e.g. `"Sam (Remote Control, 2026-10-23)"`).
- **One decision per requirement**, written as one normative statement ("Payout jobs retry at most 5 times, then go to the dead-letter queue."), with the reasoning in `justification`.
- **Tags:** 1–3 specific kebab-case tags naming the capability (`payout-retries`, not `backend`). Check `list_requirement_tags` and reuse existing tags.
- **Scope:** set `group_id` for your train/epic, or leave it out for decisions about the whole project. Pass `all_projects: true` only when the owner said the decision covers all their projects.
- **Search first:** `find_requirements` with the decision's key words before recording, so it isn't recorded twice. Recording the same `source_escalation` again returns the existing requirement (`duplicate: true`).
- **Check the reply:** `similar` lists active requirements that read alike, and `warnings` flags tags close to existing ones (reuse those). If a similar one is the same decision, tell the owner (only people retire requirements). If the owner changed an earlier decision, use `supersede_requirement` on the old one instead of recording a new one.

## After a restart

Before raising new questions:

1. Call `update_group` (as at any session start).
2. Call `wait_for_decisions` with your `group_id`, `wait_seconds: 0` and the `checkedAt` saved in `.claude/lanesignal-since` (if the file exists) as `since`. Handle anything decided while you were away.
3. Call `list_lanes` with your `group`. A lane you were running that's missing was removed: stop work on it.
