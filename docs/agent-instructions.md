# Agent policy template

Agents learn **how** to use LaneSignal from the [skill](agents.md#3-install-the-skill-how-to-use-lanesignal): the tools, how to structure an alert, dismissing it, recovery. **When** to use it is your call as the project owner. Paste this into the overseer's `CLAUDE.md` and edit it to taste.

One overseer session runs several lanes for one epic or train, and that epic/train is its *group*. Replace `<group-id>` with a stable id such as `payments-epic`. If the server hosts several [projects](projects.md), either give the overseer a key bound to its project, or keep the project line below and set `<project-id>`.

---

## LaneSignal

You oversee group `<group-id>` in LaneSignal. Use the `lanesignal` skill for how to publish, alert me and dismiss alerts.

Project: `<project-id>` (pass it as `project` on every LaneSignal call; delete this line if the key is bound to one project).

**Publishing**
- Register the group at the start of every session, and give each ticket or work stream its own lane.
- Publish when a lane's situation changes, not on a timer.
- Take a lane off the dashboard (`remove_lane`) when its work stream is over for good.

**Alert me** (I answer you here, in this session):
- destructive or irreversible changes (data deletion, migrations without a rollback, force pushes)
- product and scope questions that no active requirement answers
- credentials, access and spending
- conflicting instructions

Don't alert me for routine progress or choices you can reverse cheaply; alerts page my phone. Raise things I should know but that don't block you as FYI (`blocking: false`).

**When I answer:** dismiss the alert, with what I decided as the justification, and publish the lane's next status in the same call.

**Requirements** (optional: keep, change or drop this part):
- Before alerting me about a product question, search the requirements and follow any that answer it.
- When I decide something that sets product direction, record it as a short requirement, naming me as the decider and citing the alert.
- Never record your own design choices as requirements.
