# Requirements: the owner's product decisions

Product direction tends to get buried in tickets and agent sessions, and finding it again later takes an investigation. The **requirements** register keeps each decision in one place outside the repository, searchable by any agent, with the reasoning behind it. It's on by default; `LANESIGNAL_REQUIREMENTS=false` turns it off (tools, page, API and export).

- **The decisions are the owner's.** Agents record them, but only decisions a person made: an answered escalation, or something the owner said (e.g. in Remote Control). An agent's own design choices don't belong here. An agent can cite only an escalation it raised, or one from a lane in the same train/epic.
- **One decision per requirement**, so it can be found, cited and replaced on its own.
- **Short.** The requirement is at most 300 characters and the justification at most 800, so agents can read many of them cheaply.
- **A person approves.** What an agent records starts **pending** and stays pending until a person approves it on the Requirements page; a requirement a person records is approved as it's recorded. Pending requirements still turn up in every search, marked `pending`, so agents follow them, but the owner hasn't yet confirmed the agent wrote the decision down right. Requirements recorded before approvals existed are pending too. Records made with a [personal key](accounts.md#personal-keys) (Claude in your own session) are pending as well, and approving takes a signed-in person, not a key.
- **Nothing is deleted.** When the owner changes direction, the new requirement *supersedes* the old one, which stays (marked) so the history of why is kept. A requirement retired by mistake can be restored.
- **Retries don't duplicate.** Recording the same requirement again from the same escalation returns the first (`duplicate: true`). A second, different decision from the same answer is stored, and `similar` shows the first.

## A requirement

| Field | Meaning |
|---|---|
| `id` | `R14`: unique across all projects, never reused |
| `requirement` | One normative statement: "Payout jobs retry at most 5 times, then go to the dead-letter queue." |
| `justification` | Why the owner decided it, and where |
| `tags` | 1–3 specific kebab-case tags naming the capability (`payout-retries`) |
| `project` | The [project](projects.md) it belongs to, or none (`null`) when it applies to **all projects**: "all our apps store money as integers". Set with `allProjects: true` (`all_projects` in MCP) |
| `group` | The train/epic it belongs to, or none for **product-wide** (the whole project) |
| `decidedBy` | The person who decided, e.g. "Sam (Remote Control, 2026-10-23)". Taken from the escalation when it was answered on the dashboard |
| `sourceEscalation` | The alert the decision answered (e.g. `A12`; `SH-A12` on an all-projects requirement), if any. It must be in the requirement's project. When the owner answered in the agent's session, the agent cites it together with `decidedBy` |
| `status` | `pending` (recorded, waiting for a person's approval), `active` (approved), `superseded` (with `supersededBy`) or `retired` (no longer applies, nothing replaces it; also how a pending one is rejected) |
| `recordedBy` | The agent key or person that wrote it down |

### Tags

Tags exist to find things, so they must be specific:

- 1–3 per requirement, kebab-case (`sso-login`, `payout-retries`).
- Broad tags are rejected: `backend`, `frontend`, `ui`, `ux`, `api`, `misc`, `general`, `feature`, `bug` and similar. Set your own list with `LANESIGNAL_BROAD_TAGS`.
- Once there are 10+ requirements, recording one with a tag that's already on more than 40% of them returns a warning.
- `list_requirement_tags` shows the tags in use with counts, so agents reuse them instead of inventing synonyms.
- A tag that differs from an existing one only by a plural (`payout-retry` next to `payout-retries`) returns a warning.

## How agents use it

| Tool | Use |
|---|---|
| `find_requirements` | Before escalating a product or scope question, search here. If a requirement answers it, follow it and cite its id. Pending and active requirements are returned unless `statuses` says otherwise; a pending one is marked `status: "pending"`. A requirement with a replacement waiting for approval always comes back together with it (the current one, then the pending change), whichever of the two matched and whatever the filters, so an agent knows the decision may be about to change. Free-text search ranks the best matches first, matches word forms ("retries" finds "retry") and prefixes ("deploy" finds "deployments"); an id like `R14` finds that requirement whatever its status or filters; `group_id` covers that train/epic plus product-wide requirements |
| `record_requirement` | After the owner decides something that sets direction, record it with `source_escalation` (e.g. `"A12"`) or `decided_by` (e.g. `"Sam (Remote Control, 2026-10-23)"`). The requirement starts `pending`. The result lists `similar` pending or active requirements, so a duplicate is noticed straight away |
| `supersede_requirement` | The owner changed their mind: record the new decision and mark the old one superseded. From an agent the new one is pending, and the old one stays in force (its `supersededBy` names the replacement) until a person approves the replacement; rejecting it leaves the old one as it was. Superseding a pending replacement swaps the proposal: it's marked superseded and the old requirement waits on the new one, so changes never chain. Searches return the pair together, which can take a result a little past `limit` |
| `get_requirement`, `list_requirement_tags` | Read one; see tags in use |

The service doesn't decide *when* agents record requirements; that's the project owner's policy, in the overseer's instructions.

## In the app

**Requirements** (bottom bar on phones, top bar on desktop) lists pending and active requirements, newest first, with search, a group filter, and tag filters (tap a tag). Pending ones carry a **Pending approval** badge, and one with a replacement waiting shows **Replacement R… pending**; tick **Pending approval only** to work through them (it lists only pending ones, not the approved requirements they would replace). Tick **Superseded & retired** to see the history. **Cards / List** switches between full cards and one line per requirement (tap a line to open its card); the choice is remembered on the device.

People **approve** a pending requirement (or **reject** it, which retires it), **edit wording** (fix phrasing, justification or tags without changing the meaning) and **retire** a requirement. Restoring a retired one makes it active again. A change of decision is a supersede, recorded like any other decision.

Requirements are part of the [export](export.md) (`requirements.csv`).
