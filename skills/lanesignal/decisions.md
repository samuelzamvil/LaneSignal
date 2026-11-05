## When the owner answers

The owner answers on the dashboard with Accept, Reject or Other, quoting codes when they write ("967A: drop it"). A `decided` escalation, or a `reply` (Other), closes with `acknowledge_escalation`, which returns the final `decision` and `decisionNote`. One answered in this session instead closes with `dismiss_escalation`, saying what was decided and where. The owner's messages to your group come back in your group wait as `group_note` until you acknowledge them.

<!-- usage -->
### Usage: acting on answers

1. **Stay connected** to your whole group (below), even when nothing is open: the owner's notes arrive that way. Keep working on lanes that aren't blocked meanwhile.
2. **Acknowledge as soon as an escalation is decided, before acting,** then act on what it returns, publishing the lane's next `status` and `activity` in the same call.
3. **On Other, acknowledge to act on what they wrote.** Every reply pages the owner: reply only to ask back or object, and send an update while they decide only when something changed.
4. **Dismiss** moot escalations too, saying why.
5. **Another lane's open question** that affects your work: `add_position`.
6. **The owner's messages to your group** (`group_note`) are instructions: act on them, answering with `post_to_group` if useful, then acknowledge them (`ack`).
<!-- /usage -->

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
