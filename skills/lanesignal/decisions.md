## When the owner answers

The owner answers on the dashboard with Accept, Reject or Other, quoting codes when they write ("967A: drop it").

1. **Wait** on your whole group (below), and keep working on lanes that aren't blocked.
2. **`decided`**, or **`reply`** you'll act on: `acknowledge_escalation`, then act on the `decision` and `decisionNote` it returns. Every reply pages the owner, so reply only to ask back or object.
3. **Answered here instead:** `dismiss_escalation`, saying what was decided and where. Dismiss moot ones the same way, saying why.
4. **Another lane's open question** that affects your work: `add_position`.
5. **The owner's notes** come back as `ownerMessages` from `update_lane`, `notify_owner`, `update_epic` and `notify_epic`: act on them like instructions.

## Waiting for answers

`wait_for_decisions` with your `group_id` returns as soon as anything needs you. What to do with each kind of item:

- `decided`, `reply`: as above.
- `closed`: someone else withdrew it.
- `lane_removed`: stop work on that lane and don't publish to it (publishing brings it back).
- `ticket_moved`: another group's lane took one of your tickets; don't fill a lane with it again.
- `lane_note`, `board_note`: the owner's notes; act on them like instructions, answering with `notify_owner` or `notify_epic` if useful.
- A file the owner attached reads "[attached: plan.md (id …)]": fetch it with `curl -H "Authorization: Bearer $LANESIGNAL_KEY" "$base/api/attachments/<id>"`.

**Keeping your place:** once you've handled a result's items, save its `checkedAt` to `.claude/lanesignal-since` (overwrite it), so a restart starts there; save only after handling. If `counts` show something you can't find (e.g. after a compaction), `get_updates` returns everything in scope. A failed call is safe to repeat.

**Keep a wait running even when nothing is open:** the owner's notes arrive through it. **Don't hold your session** with it, though: a waiting call keeps your session busy, and the owner can't reach you through Remote Control. If your client cuts calls off early (some stop at 60 seconds), wait less and call again. For long waits in Claude Code, run the HTTP wait as a background shell command; Claude Code tells you when it exits. It needs `LANESIGNAL_URL` (a trailing `/mcp` is fine), `LANESIGNAL_KEY` and `LANESIGNAL_GROUP`, plus `LANESIGNAL_PROJECT` if your key reaches several projects; `LANESIGNAL_SINCE` overrides the saved place:

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
