
## Requirements: the owner's past decisions

LaneSignal keeps the owner's product decisions as **requirements**, outside the repository, so any agent can find them later.

**Before you ask:** for product or scope questions, call `find_requirements` first (`query` is free text; pass your `group_id`). If a requirement answers the question, follow it and cite its id ("per R14") instead of asking again.

If your owner's policy asks you to keep product decisions (or you're told to record one):

- **Owner decisions only.** Record only what a person decided, never your own design choices. Every requirement names who decided: `decided_by` (e.g. `"Sam (Remote Control, 2026-10-23)"`), plus `source_escalation: "A12"` when it came from an escalation. (Where the owner answers in LaneSignal itself, the escalation alone names the decider.)
- **Short and single:** one decision per requirement, written as one normative statement ("Payout jobs retry at most 5 times, then go to the dead-letter queue."): at most 300 characters, with the reasoning in `justification` (at most 800).
- **Tags:** 1–3 specific kebab-case tags naming the capability (`payout-retries`, not `backend`). Check `list_requirement_tags` and reuse existing tags.
- **Scope:** set `group_id` for your train/epic, or leave it out for decisions about the whole project. Pass `all_projects: true` only when the owner said the decision covers all their projects.
- **Search first:** `find_requirements` with the decision's key words before recording, so it isn't recorded twice. Recording the same requirement from the same `source_escalation` again returns the existing one (`duplicate: true`).
- **Pending until approved:** what you record is `pending` until the owner approves it in LaneSignal. Pending requirements still come back from `find_requirements` (marked `status: "pending"`); follow them like active ones. When you supersede, the old requirement stays in force (its `supersededBy` names yours) until the owner approves the replacement.
- **Check the reply:** `similar` lists pending or active requirements that read alike, and `warnings` flags tags close to existing ones (reuse those). If a similar one is the same decision, tell the owner (only people retire requirements). If the owner changed an earlier decision, use `supersede_requirement` on the old one instead of recording a new one.
