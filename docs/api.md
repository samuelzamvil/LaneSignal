# HTTP API

Everything the MCP tools do is also available over plain HTTP, for scripts, CI jobs and agents without MCP.

- **Auth:** every request (except `/healthz` and `/api/setup`) sends `Authorization: Bearer <credential>`. A credential is an agent key or personal key (`ls_…`), an account session token, or a static config token.
- **Projects:** every endpoint takes `?project=<id or key>`. It's needed only when your credential reaches several [projects](projects.md): writes then fail with `400 Say which project: …` without it, and listings cover every project you can see. Lane and group ids in paths and bodies are per project.
- **Escalation ids:** wherever a path or field takes an escalation id, its code works too, e.g. `A12` (case doesn't matter), or `SH-A12` to name the project. Plain numbers from before lane codes (`42`) still resolve.
- **Errors:** responses are JSON. Errors look like `{"error": "…"}` with a 4xx status:
  - `400` validation (with `issues`)
  - `401` no or invalid credential
  - `403` wrong role, or not a project admin
  - `404` not found
  - `409` a state conflict, such as deciding an already-decided escalation

## Example: an agent's whole loop

```bash
URL=https://lanesignal.example.com
KEY=ls_…

# publish lane state (creates the lane on first call)
curl -X PUT $URL/api/lanes/auth-rework -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"name":"Auth rework","group":"payments-epic","status":"pending_ci","ticket":"redmine:4812",
       "activity":"Waiting on CI for PR #311",
       "links":[{"label":"PR #311","url":"https://github.com/o/r/pull/311","kind":"pr"}]}'

# ask a question
ID=$(curl -s -X POST $URL/api/escalations -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"laneId":"auth-rework",
       "context":"legacy_role has had no reads for 90 days; rollback needs a backup restore.",
       "question":"Drop the legacy_role column?",
       "recommendation":"Drop it; the auth rework is simpler without it.",
       "cost":"A restore from backup if we were wrong.",
       "alternatives":["Rename it to legacy_role_deprecated for one release."],
       "options":["Drop","Keep"],"recommendedOption":"Drop"}' | jq -r .id)

# wait for answers on any of the group's lanes (up to 24h per call; repeat while ready is false)
curl -s "$URL/api/wait?group=payments-epic&timeout=86400" -H "authorization: Bearer $KEY" | jq '.decided[] | {ref,decision,decisionNote}'

# acknowledge first: returns the final decision, and publishes the lane's next state
curl -s -X POST $URL/api/escalations/$ID/ack -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"note":"dropping in migration 0042","status":"active","activity":"Dropping legacy_role"}'
```

## Endpoints

| Method and path | Role | Notes |
|---|---|---|
| `GET /healthz` | public | `{"ok":true}` when the database answers. Used by the container health check |
| `GET /api/skill` | public | The Claude Code skill for agents (`SKILL.md`) |
| `GET /api/setup` | public | `{"needsSetup": bool}` |
| `POST /api/setup` | public + code | First admin account: `{email, name, password, code}`. The code isn't needed when sending a static human token |
| `GET /api/me` | any | Who the credential is: `{name, role, admin?, superuser?, project?, email?, userId?}` |
| `GET /api/config` | any | Group label, statuses, ticket systems, push availability |
| `GET /api/snapshot` | any | Projects, groups, lanes and unresolved escalations |
| `GET /api/projects` | any | Projects the credential reaches, with your `role` and `notify` setting |
| `POST /api/projects` | instance admin | `{id, key, name}`. The creator becomes its admin |
| `PATCH /api/projects/:id` | project admin | `{name?, key?}` |
| `GET /api/projects/:id/members` | human | `[{userId, name, email, role, notify}]` |
| `PUT /api/projects/:id/members/:userId` | project admin | `{role: "admin" \| "member"}`: add a person or change their role |
| `DELETE /api/projects/:id/members/:userId` | project admin | Remove a member |
| `PUT /api/projects/:id/notifications` | person | `{enabled}`: push for this project on your own devices |
| `GET /api/people` | project admin | Everyone with an account, for adding members |
| `GET /api/events` | any | Server-Sent Events: `group`, `group_deleted`, `lane`, `lane_deleted`, `escalation`. Only your projects' events. The stream ends when memberships or projects change; reconnect and re-snapshot. Heartbeat every 25s. `?access_token=` is accepted here only, for clients that can't set headers |
| `GET /api/groups` | any | |
| `PUT /api/groups/:id` | agent | Create or update `{name?, ticket?, links?}` |
| `DELETE /api/groups/:id` | human | Archives it. Its lanes show as ungrouped, and exports keep the link |
| `GET /api/lanes` | any | |
| `GET /api/lanes/:id` | any | Lane, its recent escalations and the last 100 activity entries |
| `PUT /api/lanes/:id` | agent | Create or update `{name?, group?, status?, ticket?, activity?, links?}` |
| `DELETE /api/lanes/:id` | any | Archives the lane and withdraws its unanswered escalations; decided ones keep their answer. Its history stays for export, and republishing restores it |
| `GET /api/escalations?state=open,decided&lane=<id>` | any | Defaults to unresolved (open and decided) |
| `POST /api/escalations` | agent | See the [fields](concepts.md#escalations). `blocking: false` for FYI questions. `201` when created; `200` with `duplicate: true` when the same question is already open on that lane |
| `GET /api/escalations/:id?wait=<s>` | any | `wait` (up to 300) holds the request until it's no longer open |
| `GET /api/wait?group=&lane=a,b&ids=1,2&timeout=<s>` | any | Waits until something in scope needs the agent; give at least one of `group`, `lane`, `ids`. Returns `{ready, decided, closed, open, removedLanes, checkedAt}` ([details](agents.md#waiting-for-decisions)); pass `checkedAt` back as `since`. Unknown groups, lanes or ids are `404`. `timeout` defaults to 300, max 86400. If it has to wait, it sends `200` at once and a space every 20s until the JSON follows, so proxies keep it open |
| `POST /api/escalations/:id/positions` | agent | `{stance, note?, agent?}`. Open escalations only; at most 20 agents |
| `POST /api/escalations/:id/decide` | human | `{decision, note?, change?}`. A second decision is `409`, unless `change: true` and the agent hasn't acknowledged yet |
| `POST /api/escalations/:id/ack` | agent | `{note?, status?, activity?}`. Returns the escalation with the final decision; `status`/`activity` update the lane. Repeating it returns the same result |
| `POST /api/escalations/:id/withdraw` | any | `{note?}` |
| `GET /api/export` | any | Zip of every dataset as CSV plus a README. `?from=&to=&lane=&project=` filter. One export at a time (`429` while another runs). See [Export](export.md) |
| `GET /api/export/<dataset>.csv` / `.json` | any | `escalations`, `positions`, `lanes`, `groups`, `events` or `requirements`. Same filters |
| `GET /api/requirements?q=&tag=a,b&group=&status=active,superseded&limit=` | any | Search [requirements](requirements.md). Active only by default; `q` is free text, or an id like `R14`. Includes requirements for all projects |
| `GET /api/requirements/tags?group=` | any | Tags in use, with counts |
| `GET /api/requirements/:id` | any | One requirement |
| `POST /api/requirements` | any | `{requirement, justification, tags, group?, sourceEscalation?, decidedBy?, allProjects?}`. `allProjects: true` makes it apply to every project. Agents must give `sourceEscalation` or `decidedBy`; a person recording one is the decider by default. Returns `{requirement, similar, warnings}` |
| `POST /api/requirements/:id/supersede` | any | Same body; marks the old one superseded |
| `PATCH /api/requirements/:id` | human | Fix `requirement`, `justification` or `tags` wording |
| `POST /api/requirements/:id/retire` | human | It no longer applies; nothing replaces it |
| `POST /api/push/register`, `/unregister` | human | Used by the Android app |
| `POST /api/admin/people` | static human token | Break-glass: add a person `{email, name, password, admin?}` |
| `POST /api/admin/people/password` | static human token | Break-glass: `{email, password}`, which also signs them out |
| `/api/auth/*` | | Better Auth: sign-in, sign-out, password change, agent keys (`/api-key/*`), admin (`/admin/*`). The web app uses these |
| `POST /mcp` | any | MCP Streamable HTTP. See [agents](agents.md) |

## Demo data

[`scripts/seed-demo.mjs`](../scripts/seed-demo.mjs) publishes sample groups, lanes and escalations, including a batch of four questions, so you can try the UI:

```bash
LANESIGNAL_URL=http://localhost:8080 LANESIGNAL_TOKEN=ls_… node scripts/seed-demo.mjs
```
