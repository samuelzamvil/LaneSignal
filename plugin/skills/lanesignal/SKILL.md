---
name: lanesignal
description: How to use LaneSignal through its MCP tools (the `lanesignal` server): publishing lane, group and epic state, asking the owner for a decision, acting on their answer, and writing to them. Use whenever you work with LaneSignal.
---

# Using LaneSignal

LaneSignal is the owner's dashboard for agent work: you publish what your lanes are doing and raise an *escalation* when you need the owner (how they answer is below). The tool descriptions say what each tool does and takes; this skill covers how they fit together. The **Usage** sections say when and why to use them on this server; the owner's policy (usually in `CLAUDE.md`) overrides them.

Vocabulary: a **group** is your epic or train (one overseer per group). A **lane** is a slot work goes through, one ticket at a time. A **ticket** is what a lane works on; it owns its escalations and moves between lanes (*parked* when set aside). An **epic** is a long-lived ticket the group steers by, with its own questions; until you add one, the group stands in as its epic. An **escalation** is a question for the owner, or something they must know.

## Publishing state

- **Your group:** `update_group` with the `group_id` your owner's policy gives you, your Remote Control session in `links`, and the `products` you work on when this server has them (`list_products`), the narrowest that cover your work; the dashboard titles your group from them. A group must exist before lanes are published in it. Every lane is in a group: publishing one without its group fails. Registering a group takes control of it: you become its overseer, replacing any earlier one (the change is recorded).
- **Your epic:** the ticket the owner gave you goes to `update_epic` (its ref as `epic`, plus `group`), once. Its `status_line` is one line on the epic's card.
- **Lanes:** a lane holds one ticket at a time, and a ticket is in one lane at a time. `fill_lane` changes tickets, parking (with a reason) the one it held; a parked ticket's questions stay open. When your group has epics, name the ticket's with `epic`, so its lane sits under that epic's card on the dashboard.
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

**An FYI that now needs the owner:** pass its code as `upgrade` (with any fields to replace, the question too) rather than asking again in new words. When you raise a blocking question, `openFyis` lists the open FYIs in your group you can upgrade: upgrade or dismiss any it repeats.

### Attachments

Markdown, text, PNG, JPEG, WebP or GIF only; at most 5 MB each and 5 per escalation or message. Attach an upload once, from the key that uploaded it; unattached uploads are deleted after a day.

`notify_owner`'s first line is what the phone's notification shows.

**Your group's conversation:** `post_to_group` writes in it (what changed, what you need that isn't a decision); `read_conversation` reads it back, newest first, with your group's escalations where their threads start.

## Usage: publishing and asking

- **Session start:** `update_group` once, before publishing lanes.
- **Lanes are slots:** stable ids (`slot-1` … `slot-5`), not one per ticket. `remove_lane` a slot you no longer need.
- **Only the overseer writes to LaneSignal.** Workers (subagents you start) never publish lanes, status, messages, notices or escalations: they report to you, and you publish.
- **Finished tickets are `done`,** not parked: parked ones wait on the dashboard to be picked up again.
- **Publish changes, not heartbeats.** Use the epic's `status_line` for what's queued or waiting; never publish placeholder lanes. Keep `activity` to one line, written for a phone.
- **Parking:** dismiss a parked ticket's questions that no longer matter.
- **One decision per escalation:** four questions in a plan are four escalations. Questions that steer the whole group (direction, scope, which tickets to file) go on the epic (`epic`, no `lane_id`). Attach a plan or preview instead of pasting it into `context`.
- **`notify_owner` for milestones only:** a PR merged, a ticket started. Never routine progress, never questions. Put several things in one message.

## When the owner answers

The owner answers on the dashboard with Accept, Reject or Other, quoting codes when they write ("967A: drop it"). A `decided` escalation, or a `reply` (Other), closes with `acknowledge_escalation`, which returns the final `decision` and `decisionNote`. One answered in this session instead closes with `dismiss_escalation`, saying what was decided and where. The owner's messages to your group come back in your group wait as `group_note` until you acknowledge them.

### Usage: acting on answers

1. **Stay connected** to your whole group (below), even when nothing is open: the owner's notes arrive that way. Keep working on lanes that aren't blocked meanwhile.
2. **Acknowledge as soon as an escalation is decided, before acting,** then act on what it returns, publishing the lane's next `status` and `activity` in the same call.
3. **On Other, acknowledge to act on what they wrote.** Every reply pages the owner: reply only to ask back or object, and send an update while they decide only when something changed.
4. **Dismiss** moot escalations too, saying why.
5. **Another lane's open question** that affects your work: `add_position`.
6. **The owner's messages to your group** (`group_note`) are instructions: act on them, answering with `post_to_group` if useful, then acknowledge them (`ack`).

## Waiting for answers

`wait_for_decisions` with your `group_id` returns as soon as anything needs you. What each kind of item means:

- `decided`, `reply`: as above.
- `closed`: someone else withdrew it.
- `lane_removed`: someone took the lane off the dashboard; publishing to it brings it back.
- `ticket_moved`: another group's lane took one of your tickets; it's now that lane's.
- `group_note`: someone wrote to your group; its `id` is the message's. It comes back on every wait until you acknowledge it: once handled, pass the last id as `ack` (to `wait_for_decisions` or `get_updates`); the result's `acked` confirms it. `since` doesn't clear notes: one you had before `since` comes back with `seen: true` and doesn't end the wait on its own. `seen: true` doesn't mean handled: act on it and acknowledge it like any other. Only the group's overseer can acknowledge; another key's `ack` is refused.
- A file the owner attached reads "[attached: plan.md (id …)]": read it with `get_attachment`.

**Keeping your place:** once you've handled a result's items, save its `checkedAt` to `.claude/lanesignal-since` (overwrite it), so a restart starts there; save only after handling. If `counts` show something you can't find (e.g. after a compaction), `get_updates` returns everything in scope. A failed call is safe to repeat.

**Don't hold your session** with a wait: a waiting call keeps your session busy, and the owner can't reach you through Remote Control. If your client cuts calls off early (some stop at 60 seconds), wait less and call again.

## Staying connected

In Claude Code, a relay holds your group's socket for the whole session and Monitor wakes you for each item, as a wait would return it; the dashboard shows you listening all along. It runs outside MCP, so the key comes from your environment (never put it in a command): `LANESIGNAL_URL` (a trailing `/mcp` is fine), `LANESIGNAL_KEY` and `LANESIGNAL_GROUP`, plus `LANESIGNAL_PROJECT` if your key reaches several projects, and `LANESIGNAL_CF_ACCESS_CLIENT_ID` and `LANESIGNAL_CF_ACCESS_CLIENT_SECRET` behind Cloudflare Access. It needs Node 22.13 or later. Run its commands from the project's root: it keeps its state in `.claude/lanesignal/`.

1. **Get `relay.mjs`:** the one next to this skill when it's installed as a plugin, or else `base=${LANESIGNAL_URL%/}; base=${base%/mcp}; mkdir -p .claude/lanesignal && curl -fsS "$base/api/skill/relay.mjs" -o .claude/lanesignal/relay.mjs`.
2. **Name your session** once: your Remote Control URL if you know it, or else an id you generate now and keep for the whole session (the same one after a compaction).
3. **Start it once,** as a background shell command: `node <relay.mjs> serve --session <id> --parent $PPID` (with its path). It reconnects by itself and exits when you do. Starting it again for the same session does nothing.
4. **Arm Monitor** with `node <relay.mjs> follow --session <id>` and the maximum timeout. Each line is one item (one may come twice): handle and acknowledge it as above. When the monitor expires, arm it again with the same command, without investigating.
5. **A `relay_stopped` line** means it stopped; act on its `reason`: `taken_over`, another overseer has your group, so stop overseeing it; `unauthorized`, `forbidden` or `not_found`, tell the person; `not_running`, start it again (3), then re-arm (4); `unreachable`, use the background wait below.

The relay keeps its own place. **Use the background wait** instead without Monitor or Node 22.13+, when the relay reports `unreachable` (for example behind an HTTPS proxy, which Node's WebSocket doesn't use), or on a server without the socket. Run it as a background shell command; Claude Code tells you when it exits. `LANESIGNAL_SINCE` overrides the saved place, and `LANESIGNAL_SESSION`, when set, names your session:

```bash
: "${LANESIGNAL_URL:?set LANESIGNAL_URL}" "${LANESIGNAL_KEY:?set LANESIGNAL_KEY}" "${LANESIGNAL_GROUP:?set LANESIGNAL_GROUP}"
base=${LANESIGNAL_URL%/}; base=${base%/mcp}; sincefile=.claude/lanesignal-since
out=$(mktemp); since="${LANESIGNAL_SINCE:-$(cat "$sincefile" 2>/dev/null)}"; fails=0
while :; do
  code=$(curl -sS -o "$out" -w '%{http_code}' -H "Authorization: Bearer $LANESIGNAL_KEY" \
    "$base/api/wait?group=$LANESIGNAL_GROUP&timeout=86400${since:+&since=$since}${LANESIGNAL_PROJECT:+&project=$LANESIGNAL_PROJECT}${LANESIGNAL_SESSION:+&session=$LANESIGNAL_SESSION}" 2>/dev/null)
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

1. `update_group` (a group must exist before its lanes are published).
2. `get_updates` with your `group_id` and the saved `.claude/lanesignal-since` as `since`. Handle `decided`, `replies` and `groupMessages` (acknowledging those with `ack`), then save its `checkedAt`. Dismiss `open` ones whose answer you can see in this conversation; never raise the rest again.
3. `list_lanes` with your `group_id`: a lane you ran that's missing was removed; stop work on it.
4. `list_tickets` with your `group_id`: a ticket still `in_lane` that nobody is working was left by the crash; pick it up or `fill_lane` its lane with what's next.

## Requirements

The owner's durable product decisions are kept as requirements, scoped to products, the whole project, or every project. Only people retire requirements.

### Usage: requirements

- **Read them once:** `find_requirements` with the narrowest products your work touches (`project_only` if none), at session start and after a compaction or restart. When work reaches a product you haven't read, read only that one with `only_named`, naming its parent too if you haven't read that. Otherwise read again only when you're told a requirement changed, or to search before recording one.
- **Workers read requirements only:** a subagent may call `find_requirements` for its work, and nothing else in LaneSignal.
- **Before escalating a product or scope question,** check what you've read. If a requirement answers it, follow it and cite its id ("per R14") instead of asking again; a `pending` one too.

If your owner's policy asks you to record decisions (or you're told to):

- **Only what a person decided,** never your own design choices, naming who decided. One decision each, as one normative statement ("Payout jobs retry at most 5 times, then go to the dead-letter queue.").
- **Search first** (`query`), so it isn't recorded twice. If the owner changed an earlier decision, `supersede_requirement` the old one; if a `similar` one is the same decision, tell the owner.
- **Narrowest true scope:** the products it concerns (a rule for all of a product's subprojects goes on the product); `project` only when it holds for every product; `global` only when the owner said it covers all their projects. If no product fits, ask the owner rather than stretching the scope.
