# Requirements: the owner's product decisions

Product direction tends to get buried in tickets and agent sessions, and finding it again later takes an investigation. The **requirements** register keeps each decision in one place outside the repository, searchable by any agent, with the reasoning behind it. It's on by default; `LANESIGNAL_REQUIREMENTS=false` turns it off (tools, page, API and export).

- **The decisions are the owner's.** Agents record them, but only decisions a person made: an answered escalation, or something the owner said (e.g. in Remote Control). An agent's own design choices don't belong here. An agent can cite only an escalation it raised, or one from a lane in the same train/epic.
- **One decision per requirement**, so it can be found, cited and replaced on its own.
- **Short.** The requirement is at most 300 characters and the justification at most 800, so agents can read many of them cheaply.
- **A person approves.** What an agent records starts **pending** and stays pending until a person approves it on the Requirements page; a requirement a person records is approved as it's recorded. Pending requirements still turn up in every search, marked `pending`, so agents follow them, but the owner hasn't yet confirmed the agent wrote the decision down right. Requirements recorded before approvals existed are pending too. Records made with a [personal key](accounts.md#personal-keys) (Claude in your own session) are pending as well, and approving takes a signed-in person, not a key.
- **Nothing is deleted.** When the owner changes direction, the new requirement *supersedes* the old one, which stays (marked) so the history of why is kept. A requirement retired or rejected by mistake can be restored.
- **Retries don't duplicate.** Recording the same requirement again from the same escalation returns the first (`duplicate: true`). A second, different decision from the same answer is stored, and `similar` shows the first.

## A requirement

| Field | Meaning |
|---|---|
| `id` | `R14`: unique across all projects, never reused |
| `requirement` | One normative statement: "Payout jobs retry at most 5 times, then go to the dead-letter queue." |
| `justification` | Why the owner decided it, and where |
| `tags` | Retired (see [Tags](#tags-retired)); only on older requirements |
| `project` | The [project](projects.md) it belongs to, or none (`null`) when it applies to **all projects**: "all our apps store money as integers". Set with `scope: "global"` (or `allProjects: true` over HTTP) |
| `scope` | Where it applies: `global` (every project), `project` (every product in its project) or `products` (only those in `products`). See [Scope](#scope) |
| `products` | Product ids in its project, when `scope` is `products` |
| `needsRegrouping` | Recorded before products existed (or a replacement of one, scoped as it was): it counts as project-wide (or global) until a person chooses its scope |
| `group` | The train/epic it was recorded for, from before products; kept, but scope is what says where it applies |
| `decidedBy` | The person who decided, e.g. "Sam (Remote Control, 2026-10-23)". Taken from the escalation when it was answered on the dashboard |
| `sourceEscalation` | The alert the decision answered (e.g. `A12`; `SH-A12` on an all-projects requirement), if any. It must be in the requirement's project. When the owner answered in the agent's session, the agent cites it together with `decidedBy` |
| `status` | `pending` (recorded, waiting for a person's approval), `active` (approved), `superseded` (with `supersededBy`), `retired` (an approved one that no longer applies, nothing replaces it) or `rejected` (a pending record a person turned down) |
| `rejectionReason` | Why a person rejected it; required when rejecting, set only on `rejected` ones |
| `recordedBy` | The agent key or person that wrote it down |

## Scope

Every requirement says where it applies, and there's no default:

| Scope | Applies to |
|---|---|
| **Global** | Every project |
| **Project-wide** | Every product in one project |
| **Products** | One or more products of one project |

**Products** are named parts of a project (a project can hold several). Only a signed-in person adds them, on the Requirements page (or `POST /api/products`); agents can't. A requirement scoped to an unknown product is refused, and the error lists the project's products.

**Locks.** A person can lock a product. Agents and personal keys then can't record a requirement in it, or supersede, edit, retire or restore one of its requirements. Only signed-in people move requirements between scopes anyway. People still can do all of it. Locks apply only to products.

**Changing the scope.** A person changes a requirement's scope at any time from its card (**Change scope**), or picks one while approving (**Save & approve**). It keeps its id and status, so no re-approval, and the change is logged with who made it and when (shown on the card, `GET /api/requirements/:id/changes`, and `requirement_changes.csv` in the export). Moving a requirement to global keeps its escalation citation, qualified with its project (`LS-A12`).

**Requirements from before products** are flagged **Needs scope** (so is a replacement of one that keeps its scope). They keep counting as project-wide (or global, if they were for all projects) so none drop out of what agents see. Tick **Needs scope only** on the Requirements page to work through them.

**Archiving** a product hides it from pickers. It's refused while requirements in force are scoped to it: rescope them first. A retired requirement on an archived product can't be restored until the product is unarchived.

### Tags (retired)

Requirements used to carry 1–3 free-form tags. Products replaced them: agents no longer send tags, and `list_requirement_tags` is gone. Older requirements keep theirs in the export (`tags` column), and full-text search still finds them by those words.

## How agents use it

| Tool | Use |
|---|---|
| `find_requirements` | Everything that applies, in one call: `products: ["product-a", "product-b"]` returns those products' requirements plus the project-wide and global ones, each once. Work not tied to a product passes `project_only: true` (project-wide and global only). One of the two is required, and an unknown product is an error listing the project's products. The response names the scope it used (`{scope, requirements}`). Each requirement comes back as its id, text, `scope`, `products` and `status`, without justification (`get_requirement` has it). `query` narrows by free text: it ranks the best matches first, matches word forms ("retries" finds "retry") and prefixes ("deploy" finds "deployments"), and an id like `R14` finds that requirement whatever its status or filters. Pending and active requirements are returned unless `statuses` says otherwise; a pending one is marked `status: "pending"`. A requirement with a replacement waiting for approval always comes back together with it (the current one, then the pending change), so an agent knows the decision may be about to change; that partner can be scoped elsewhere (each result says its scope). Up to 200 come back; `truncated: true` means there are more, so narrow with `query`. Several projects: say which with `project`. `needsRegrouping: true` marks one the owner hasn't scoped yet (it counts as project-wide) |
| `record_requirement` | After the owner decides something that sets direction, record it with its `scope` (required: `products` with the product ids, `project`, or `global`) and `source_escalation` (e.g. `"A12"`) or `decided_by` (e.g. `"Sam (Remote Control, 2026-10-23)"`). A locked product refuses it. The requirement starts `pending`, whatever its scope. The result lists `similar` pending or active requirements, so a duplicate is noticed straight away. `group_id` (optional) names the train/epic it was decided in, so the agent can cite an escalation from that group's lanes; it doesn't change where the requirement applies |
| `supersede_requirement` | The owner changed their mind: record the new decision and mark the old one superseded. Without a `scope`, the new one keeps the old one's; refused for a requirement in a locked product. From an agent the new one is pending, and the old one stays in force (its `supersededBy` names the replacement) until a person approves the replacement; rejecting it leaves the old one as it was. Superseding a pending replacement swaps the proposal: it's marked superseded and the old requirement waits on the new one, so changes never chain. Searches return the pair together, which can take a result a little past `limit` |
| `get_requirement` | Read one: its text, scope and status; `include_justification: true` adds why, who decided and where |
| `list_products` | The products, with whether each is locked and how many requirements it has |

**Rejected requirements are hidden from agents.** No MCP tool returns them (`find_requirements` doesn't accept `rejected` in `statuses`, not even an id finds one, and `get_requirement` says it's not found), they never show up as `similar`, and the REST API and exports leave them out for agent and personal keys too; on the event stream those keys get a `requirement_removed` event with just the id. Requirements rejected before reasons existed were stored as `retired` and stay that way. An agent can record the same decision again; it starts pending like any other.

The service doesn't decide *when* agents record requirements; that's the project owner's policy, in the overseer's instructions.

## In the app

**Requirements** (bottom bar on phones, top bar on desktop) lists pending and active requirements, newest first, with search, a group filter, a scope filter (Global, Project-wide, or a product), and **Needs scope only**. Each card shows its scope: Global, Project-wide, or its products in their colours (🔒 when locked). People who approve requirements also get **Products** at the top, to add, rename, recolour, lock and archive the project's products (with several projects, pick one first). Pending ones carry a **Pending approval** badge, and one with a replacement waiting shows **Replacement R… pending**; tick **Pending approval only** to work through them (it lists only pending ones, not the approved requirements they would replace). Tick **Superseded, retired & rejected** to see the history; a rejected one shows why. **Cards / List** switches between full cards and one line per requirement (tap a line to open its card); the choice is remembered on the device.

People **approve** a pending requirement (optionally choosing its scope in the same step), **change scope**, or **reject** it, saying why (the reason is required and kept with it), **edit wording** (fix phrasing or justification without changing the meaning) and **retire** an approved requirement. Restoring a retired one makes it active again; restoring a rejected one puts it back up for approval, its reason cleared; if it was a replacement, it's the pending replacement again (refused if the requirement it replaced has changed since). Rejecting, and restoring a rejected one, take a signed-in person, like approving; a personal key can't. A requirement with a replacement waiting for approval is neither rejected nor retired until that replacement is approved or rejected, and a requirement whose replacement was approved since can't be restored beside it. A change of decision is a supersede, recorded like any other decision.

Requirements are part of the [export](export.md) (`requirements.csv`, with `products.csv` and `requirement_changes.csv`).
