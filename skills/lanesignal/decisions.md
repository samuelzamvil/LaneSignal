
## Answering in LaneSignal (turned on for this server)

This server also lets the owner answer escalations on the dashboard. Then you wait for the decision and acknowledge it, instead of being answered in your session. Answers in your session still work: dismiss those alerts as above.

- **Other lanes' questions:** if one affects your work, `add_position` with `agree`, `disagree` or `neutral` and a one-line reason, while it's still open.

### Waiting for answers

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

### Acting on a decision

1. **Acknowledge first, then act:** call `acknowledge_escalation` as soon as an escalation is decided. It returns the final `decision` and `decisionNote` (the owner may correct a mis-tap until you acknowledge). Act on what it returns. Only the agent that raised an escalation can acknowledge it.
2. **Publish the next state in the same call:** pass `status` and `activity`, e.g. `status: "active", activity: "Dropping the column (A12)"`.
3. **Repeats are harmless:** repeating an acknowledgement changes nothing.


After a restart, also call `wait_for_decisions` with your `group_id`, `wait_seconds: 0` and the `checkedAt` saved in `.claude/lanesignal-since` (if the file exists) as `since`, and handle anything decided while you were away.
