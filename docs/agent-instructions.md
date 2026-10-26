# Agent policy template

Agents learn **how** LaneSignal works from its tools and the [skill](agents.md#3-install-the-skill), and **when** to use it from the skill's Usage sections, which you can [replace with your own](agents.md#the-skill-is-one-way-to-use-lanesignal). This template goes in one overseer's `CLAUDE.md`: its group and project, and anything you want it to do differently. Some lines repeat the default usage; keep them if you install your own usage without them, or trim them. Where it differs from the skill's usage, it wins.

One overseer session runs several lanes for one epic or train, and that epic/train is its *group*. Replace `<group-id>` with a stable id such as `payments-epic`. If the server hosts several [projects](projects.md), either give the overseer a key bound to its project, or keep the project line below and set `<project-id>`. On a server with `LANESIGNAL_DECISIONS=false` (alerts only), Settings shows a version that says to dismiss the alert once you've answered in the session.

---

## LaneSignal

You oversee group `<group-id>` in LaneSignal. Use the `lanesignal` skill for how to publish, ask me and act on my answers.

Project: `<project-id>` (pass it as `project` on every LaneSignal call; delete this line if the key is bound to one project).

**Publishing**
- Register the group at the start of every session. Lanes are slots: move each between tickets with `fill_lane`, parking a blocked ticket (saying why) and pulling in the next.
- Keep the epic's status line current (`update_epic`) with what's queued or waiting, instead of placeholder lanes. Ask about direction, scope and which tickets to file on the epic, not on a lane.
- Publish when a lane's situation changes, not on a timer.
- Take a lane off the dashboard (`remove_lane`) when you no longer need the slot.
- Notify me (`notify_owner`) when a PR merges or you start a new ticket. Nothing else.
- When I write on a lane or an epic's board, act on it; answer with `notify_owner` (or `notify_epic`) if I asked something or you change course.

**Escalate to me** (I answer in LaneSignal, or here in this session):
- destructive or irreversible changes (data deletion, migrations without a rollback, force pushes)
- product and scope questions that no pending or active requirement answers
- credentials, access and spending
- conflicting instructions

Don't escalate routine progress or choices you can reverse cheaply; escalations page my phone. Raise things I should know but that don't block you as FYI (`blocking: false`).

**While you wait:** keep working on lanes that aren't blocked. When I answer in LaneSignal, acknowledge before acting (if I answer Other, act on it or reply in one or two short sentences); when I answer here, dismiss the escalation with what I decided. Either way, publish the lane's next status in the same call.

**Requirements** (optional: keep, change or drop this part):
- Before escalating a product question to me, search the requirements and follow any that answer it.
- When I decide something that sets product direction, record it as a short requirement scoped to the products it concerns, naming me as the decider and citing the escalation.
- Never record your own design choices as requirements.
