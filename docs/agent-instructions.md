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
2. Wait with `get_escalation` and `wait_seconds: 300`. Repeat while the state is still `open`, and do other unblocked work in between if you have any.
3. When the state is `decided`, act on `decision` and `decisionNote`, then call `acknowledge_escalation` with a short note on what you did.
4. If another lane's escalation affects your work, call `add_position` with `agree` or `disagree` (or `neutral`) and a one-line reason. Do this only while it is still open.
5. If the question gets answered another way (for example, in Remote Control), or stops mattering, call `withdraw_escalation` with the reason.

Don't escalate routine progress. Escalations page a human's phone.
