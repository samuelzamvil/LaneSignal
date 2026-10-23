# LaneSignal instructions for agents

Paste this into the overseer's `CLAUDE.md` (or system prompt). One overseer session runs several lanes for one epic or train, and that epic/train is the overseer's *group*. Replace `<group-id>` with a stable id such as `payments-epic`.

---

## Reporting to LaneSignal

You oversee group `<group-id>` and publish for each lane you run. Use the `lanesignal` MCP tools to keep humans informed. **Publish state changes, not heartbeats.**

- Once, at the start: call `update_group` with your epic/train `name`, its `ticket`, and your Remote Control session URL in `links` (`kind: "session"`).
- Give each lane a stable `lane_id` (one per ticket or work stream) and pass `group: "<group-id>"` on its first `update_lane`.
- Call `update_lane` when a lane's situation actually changes:
  - when you start a ticket (`status: "active"`, `ticket`, a short `activity`)
  - when you push and wait on CI (`status: "pending_ci"`, add the PR and CI run to `links`)
  - when you wait on another lane (`status: "awaiting_agent"`, and name that lane in `activity`)
  - when you're idle (`status: "idle"`) and when you're done (`status: "completed"`)
- Keep `activity` to one line a human can read on a phone.
- Use ticket references like `redmine:1234` or `gh:42`.

When you need a human decision you cannot make yourself (destructive or irreversible changes, product and scope questions, credentials, conflicting instructions):

1. Call `create_escalation` once per decision. If a plan has four questions, raise four escalations. They show up together, numbered, in the order you raise them. Fields:
   - `context`: what a human needs to know to answer from a phone, without opening your session (what you're doing, what you found, the tradeoffs and risks).
   - `question`: the specific decision, phrased as a question.
   - `recommendation`: what you would do and why.
   - `cost`: what following the recommendation costs.
   - `alternatives`: the other paths, one string each, with their tradeoffs.
   - `ticket`: what the question is about (e.g. `gh:921`), if that differs from the lane's ticket.
   - `options`: 2–4 short answers when the answer is a choice, with `recommended_option` set to the one you recommend.
   - `positions`: other agents' agreement or disagreement, if you already know it (e.g. the reviewer's view).
   - `blocking: false` for an FYI the human should see but that doesn't stop the lane. Leave it out when the lane must wait.

   Each escalation gets a short number, its `ref` (shown as **#42**). Use it when you mention the question to the human, for example in Remote Control ("#42 is waiting on you"). The tools accept `"#42"` wherever they take an id. Retrying the same question on the same lane while it's open returns the first escalation (`duplicate: true`), so a retry after a network error is safe.
2. Wait for answers with `wait_for_decisions`, scoped to your whole group (`group_id: "<group-id>"`), so one call covers every lane. It returns as soon as anything needs you:
   - `decided`: answered. Handle each one (step 3).
   - `closed`: an escalation you named by id was withdrawn. "Lane removed by …" means a human stopped that lane: stop work on it.
   - `open`: still waiting.
   - `ready: false`: the wait ran out with nothing new. Call it again.

   Answers can take hours. If the call fails (a timeout, a dropped connection, a server restart), call it again: nothing is lost, because decided escalations wait for you until you acknowledge them. Keep working on unblocked lanes between waits.
3. For each decided escalation, call `acknowledge_escalation` first, then act. The acknowledgement returns the final `decision` and `decisionNote` (a human may correct a mis-tap until you acknowledge). Pass `status` and `activity` in the same call to publish what the lane does next, e.g. `status: "active", activity: "Dropping the column (#42)"`. Repeating an acknowledgement is safe.
4. If another lane's escalation affects your work, call `add_position` with `agree` or `disagree` (or `neutral`) and a one-line reason. Do this only while it is still open.
5. If the question gets answered another way (for example, in Remote Control), or stops mattering, call `withdraw_escalation` with the reason.

**When you start or restart** (a new session, or after a crash), call `list_escalations` with `states: ["decided"]` and handle anything decided while you were away before you raise new questions.

**Long waits in Claude Code.** A waiting tool call keeps your session busy, so the human can't talk to you through Remote Control in the meantime. For waits that may take hours, run the HTTP wait as a background shell command instead. Claude Code tells you when it exits, and your session stays free:

```bash
out=$(mktemp); while :; do
  code=$(curl -sS -o "$out" -w '%{http_code}' -H "Authorization: Bearer $LANESIGNAL_KEY" \
    "$LANESIGNAL_URL/api/wait?group=<group-id>&timeout=86400")
  case "$code" in
    200) grep -q '"ready":true' "$out" && { cat "$out"; echo; break; } ;;
    400|401|403|404) cat "$out"; echo; exit 1 ;;
  esac
  sleep 15
done
```

Each request waits up to 24 hours. The loop retries after network errors and server restarts, stops with an error if the key is rejected, and prints the same JSON as `wait_for_decisions`. Then handle the decisions as in step 3.

Don't escalate routine progress. Escalations page a human's phone.
