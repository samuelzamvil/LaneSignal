## When the owner answers

The owner answers on the LaneSignal dashboard or phone app with one of three buttons, then you wait for the decision, acknowledge it and act on it.

- **Say what each answer means** when you raise it: `accept_means` (one line: what you do on Accept) and `reject_means` (what you do on Reject). Pass `allow_reject: false` when rejecting makes no sense (e.g. "Rotate the leaked key?").
- **Accept or Reject** arrive as a decision (a `decided` item in the wait), with any instructions in `note`: follow them.
- **Other opens a conversation.** The escalation stays open and the wait returns it as a `reply` item, with the owner's new messages. Then either:
  - **act on it:** `acknowledge_escalation` takes their latest message as the decision (`Other`), then do what it says. Don't reply first: a reply pages the owner; or
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

- **Waiting on your group:** call `wait_for_decisions` with your `group_id`. It returns a digest as soon as anything needs you, even when nothing is open: `items`, one per thing to handle, each with a `kind`:
  - `decided`: answered. Acknowledge and act on each one (above).
  - `reply`: the owner answered Other; `messages` are theirs since you last wrote. Acknowledge and act, or reply (above).
  - `closed`: withdrawn by someone else. "Lane removed by …" means the lane was taken off the dashboard.
  - `lane_removed`: a lane someone else took off the dashboard (including ones with nothing open). Stop work on it and don't publish to it again; publishing brings a lane back.
  - `lane_note`: the owner's notes on a lane in scope, outside any escalation. Act on them like the owner's instructions; answer with `notify_owner` if useful. They also come back as `ownerMessages` from your next `update_lane` or `notify_owner` on that lane.
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
           # Something to handle: print it and stop, leaving the saved since alone until the agent has handled it.
           grep -q '"ready":true' "$out" && { cat "$out"; echo; break; }
           s=$(grep -o '"checkedAt":"[^"]*"' "$out" | cut -d'"' -f4)
           if [ -n "$s" ]; then since=$s; fails=0; mkdir -p .claude && echo "$s" > "$sincefile"; else fails=$((fails + 1)); fi ;;
      400|401|403|404) cat "$out"; echo; exit 1 ;;
      *) fails=$((fails + 1)) ;;
    esac
    [ "$fails" -ge 40 ] && { echo "LaneSignal unreachable or failing (last status $code)"; exit 1; }
    sleep 15
  done
  ```

  If your key reaches several projects, also set `LANESIGNAL_PROJECT`. It starts from the `checkedAt` saved in `.claude/lanesignal-since` (or `LANESIGNAL_SINCE`, if set), saves each new one there while nothing needs you, prints the same JSON as `wait_for_decisions` when something does, and gives up after about 10 minutes of failures. After handling the items, save that result's `checkedAt` to `.claude/lanesignal-since`, then start the loop again.

## After a restart

1. Call `update_group` (as at any session start).
2. Call `get_updates` with your `group_id` and the `checkedAt` saved in `.claude/lanesignal-since` (if the file exists) as `since`. Handle anything in `decided` or `replies`, and the owner's `laneMessages`, from while you were away. Dismiss any `open` ones whose answer you can see in this conversation; the rest are still waiting on the owner, so never raise them again.
3. Call `list_lanes` with your `group_id`. A lane you were running that's missing was removed: stop work on it.
