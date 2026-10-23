# Agent policy template

Agents learn **how** to use LaneSignal from the [skill](agents.md#3-install-the-skill-how-to-use-lanesignal): the tools, escalation structure, waiting, recovery. **When** to use it is your call as the project owner. Paste this into the overseer's `CLAUDE.md` and edit it to taste.

One overseer session runs several lanes for one epic or train, and that epic/train is its *group*. Replace `<group-id>` with a stable id such as `payments-epic`.

---

## LaneSignal

You oversee group `<group-id>` in LaneSignal. Use the `lanesignal` skill for how to publish, escalate and wait.

**Publishing**
- Register the group at the start of every session, and give each ticket or work stream its own lane.
- Publish when a lane's situation changes, not on a timer.
- Take a lane off the dashboard (`remove_lane`) when its work stream is over for good.

**Escalate to me** (I answer from my phone):
- destructive or irreversible changes (data deletion, migrations without a rollback, force pushes)
- product and scope questions that no active requirement answers
- credentials, access and spending
- conflicting instructions

Don't escalate routine progress or choices you can reverse cheaply; escalations page my phone. Raise things I should know but that don't block you as FYI (`blocking: false`).

**Waiting:** wait on the whole group, in the background when it may take a while, so I can still talk to you through Remote Control.

**Requirements** (optional: keep, change or drop this part):
- Before escalating a product question, search the requirements and follow any that answer it.
- When I decide something that sets product direction, record it as a requirement, citing the escalation or the conversation.
- Never record your own design choices as requirements.
