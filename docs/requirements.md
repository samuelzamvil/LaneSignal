# Requirements: the owner's product decisions

Product direction tends to get buried in tickets and escalation threads, and finding it again later takes an investigation. The **requirements** register keeps each decision in one place, searchable, with the reasoning behind it.

- **The decisions are the owner's.** Agents record them, but only decisions a person made: an answered escalation, or something the owner said (e.g. in Remote Control). An agent's own design choices don't belong here.
- **One decision per requirement**, so it can be found, cited and replaced on its own.
- **Nothing is deleted.** When the owner changes direction, the new requirement *supersedes* the old one, which stays (marked) so the history of why is kept.

## A requirement

| Field | Meaning |
|---|---|
| `id` | `R14`: global, never reused |
| `requirement` | One normative statement: "Payout jobs retry at most 5 times, then go to the dead-letter queue." |
| `justification` | Why the owner decided it, and where |
| `tags` | 1–3 specific kebab-case tags naming the capability (`payout-retries`) |
| `group` | The train/epic it belongs to, or none for **product-wide** |
| `decidedBy` | The person who decided. Taken from the escalation when one is cited |
| `sourceEscalation` | The escalation the decision was made in (e.g. `A12`), if any |
| `status` | `active`, `superseded` (with `supersededBy`) or `retired` (no longer applies, nothing replaces it) |
| `recordedBy` | The agent key or person that wrote it down |

### Tags

Tags exist to find things, so they must be specific:

- 1–3 per requirement, kebab-case (`sso-login`, `payout-retries`).
- Broad tags are rejected: `backend`, `frontend`, `ui`, `ux`, `api`, `misc`, `general`, `feature`, `bug` and similar. Set your own list with `LANESIGNAL_BROAD_TAGS`.
- Once there are 10+ requirements, recording one with a tag that's already on more than 40% of them returns a warning.
- `list_requirement_tags` shows the tags in use with counts, so agents reuse them instead of inventing synonyms.

## How agents use it

| Tool | Use |
|---|---|
| `find_requirements` | Before escalating a product or scope question, search here. If a requirement answers it, follow it and cite its id. Free-text search ranks the best matches first and matches word forms ("retries" finds "retry"); `group_id` covers that train/epic plus product-wide requirements |
| `record_requirement` | After the owner decides something that sets direction, record it with `source_escalation` (e.g. `"A12"`) or `decided_by` (e.g. `"Sam (Remote Control, 2026-10-23)"`). The result lists `similar` active requirements, so a duplicate is noticed straight away |
| `supersede_requirement` | The owner changed their mind: record the new decision and mark the old one superseded |
| `get_requirement`, `list_requirement_tags` | Read one; see tags in use |

The service doesn't decide *when* agents record requirements; that's the project owner's policy, in the overseer's instructions.

## In the app

**Requirements** (bottom bar on phones, top bar on desktop) lists active requirements, newest first, with search, a train/epic filter, and tag filters (tap a tag). Tick **Superseded & retired** to see the history.

People can **edit wording** (fix phrasing, justification or tags without changing the meaning) and **retire** a requirement. A change of decision is a supersede, recorded like any other decision.

Requirements are part of the [export](export.md) (`requirements.csv`).
