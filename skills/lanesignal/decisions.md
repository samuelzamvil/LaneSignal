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
