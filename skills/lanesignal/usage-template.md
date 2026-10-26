## Usage: how we use LaneSignal

Replace each TODO with how your agents should work; each example is the default skill's choice. Delete lines you don't need, and the sections that don't apply on your server.

### Publishing

- **Session start:** TODO (e.g. "`update_group` once, before publishing lanes")
- **Lanes:** TODO (e.g. "stable slot ids, `slot-1` … `slot-5`, not one per ticket; a worker and a reviewer on one ticket share a lane")
- **How often to publish:** TODO (e.g. "changes, not heartbeats; the epic's `status_line` for what's queued; never placeholder lanes")
- **Activity text:** TODO (e.g. "one line, written for a phone")
- **Parking:** TODO (e.g. "dismiss a parked ticket's questions that no longer matter")

### Asking the owner

- **What deserves an escalation:** TODO (the default leaves this to each overseer's policy)
- **How to split questions:** TODO (e.g. "one decision per escalation; questions that steer the group go on the epic")
- **Long material:** TODO (e.g. "attach a plan or preview instead of pasting it into `context`")

### Telling the owner

- **`notify_owner`:** TODO (e.g. "milestones only: a PR merged, a ticket started; never routine progress or questions; several things in one message")

### Acting on answers (when people answer in LaneSignal)

- **Waiting:** TODO (e.g. "keep a wait running on the group even when nothing is open; keep working on unblocked lanes")
- **Acknowledging:** TODO (e.g. "as soon as an escalation is decided, before acting; publish the lane's next status in the same call")
- **Other answers:** TODO (e.g. "acknowledge to act on what they wrote")
- **Replying:** TODO (e.g. "only to ask back or object; updates while they decide only when something changed")
- **Moot escalations:** TODO (e.g. "dismiss them, saying why")
- **Other lanes' questions:** TODO (e.g. "`add_position` when one affects your work")
- **The owner's notes:** TODO (e.g. "instructions: act on them, answering with `notify_owner` or `notify_epic` if useful")

### Acting on answers (when the owner answers in the session)

- **Dismissing:** TODO (e.g. "as soon as the owner answers here, saying what was decided; publish the lane's next status in the same call; moot ones too, saying why")

### Requirements (when they're on)

- **Looking them up:** TODO (e.g. "before escalating a product or scope question, with the products your work touches; follow and cite what applies, pending ones too")
- **What to record:** TODO (e.g. "only what a person decided, never your own design choices; one decision each, naming who decided")
- **Before recording:** TODO (e.g. "search first; supersede an earlier decision the owner changed; tell the owner about a `similar` one that's the same")
- **Scope:** TODO (e.g. "the narrowest true one; global only when the owner says so; ask rather than stretch a product")
