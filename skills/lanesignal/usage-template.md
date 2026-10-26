## Usage: how we use LaneSignal

<!--
A template for the "when and why" part of the LaneSignal skill. The tools and the rest of the
skill say how LaneSignal works; this part says how your agents should use it. Fill in each TODO
(the examples show the default skill's choices), delete what you don't need, and add this
section to the skill you install:

  curl -fsS "https://your-server/api/skill?usage=none" > SKILL.md   # how, without our usage
  cat usage.md >> SKILL.md                                           # your usage, from this file

Re-run after upgrading LaneSignal; your usage file stays yours.
-->

### Publishing

- **Session start:** TODO (e.g. "call `update_group` once, before publishing lanes")
- **How often to publish:** TODO (e.g. "publish changes, not heartbeats; never publish placeholder lanes")
- **Lanes:** TODO (e.g. "at most five slots; park a blocked ticket and take the next")

### Asking the owner

- **What deserves an escalation:** TODO (e.g. "product, scope and spending decisions; not implementation choices")
- **How to split questions:** TODO (e.g. "one decision per escalation; questions that steer the group go on the epic")
- **Blocking or FYI:** TODO (e.g. "`blocking: false` for anything the lane can work around")

### Telling the owner

- **`notify_owner`:** TODO (e.g. "milestones only: a PR merged, a ticket started; never routine progress")
- **The epic's board:** TODO (e.g. "post a summary when a ticket closes")

### Acting on answers

<!-- Answering in LaneSignal (the default). With LANESIGNAL_DECISIONS=false, see the alerts note below instead. -->
- **Waiting:** TODO (e.g. "keep a wait running on the group even when nothing is open; keep working on unblocked lanes")
- **Acknowledging:** TODO (e.g. "acknowledge as soon as an escalation is decided, before acting")
- **Replying:** TODO (e.g. "reply only to ask back or object; every reply pages the owner")
- **The owner's notes:** TODO (e.g. "treat them as instructions")

<!-- Answers in the session (LANESIGNAL_DECISIONS=false): -->
- **Dismissing:** TODO (e.g. "dismiss each escalation as soon as the owner answers it here, saying what was decided")

### Requirements

<!-- Only if requirements are on (the default). -->
- **Looking them up:** TODO (e.g. "before escalating a product or scope question, check `find_requirements` and follow what applies")
- **Recording:** TODO (e.g. "only decisions a person made, after searching for an existing one")
- **Scope:** TODO (e.g. "the narrowest true scope; global only when the owner says so")
