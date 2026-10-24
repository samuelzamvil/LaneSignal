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

# register the group once per session, then publish lane state (creates the lane on first call)
curl -X PUT $URL/api/groups/payments-epic -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"name":"Payments epic"}'
curl -X PUT $URL/api/lanes/auth-rework -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"name":"Auth rework","group":"payments-epic","status":"pending_ci","ticket":"redmine:4812",
       "activity":"Waiting on CI for PR #311",
       "links":[{"label":"PR #311","url":"https://github.com/o/r/pull/311","kind":"pr"}]}'

# ask the owner (their phone is notified)
ID=$(curl -s -X POST $URL/api/escalations -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"laneId":"auth-rework",
       "context":"legacy_role has had no reads for 90 days; rollback needs a backup restore.",
       "question":"Drop the legacy_role column?",
       "recommendation":"Drop it; the auth rework is simpler without it.",
       "cost":"A restore from backup if we were wrong.",
       "alternatives":["Rename it to legacy_role_deprecated for one release."],
       "acceptMeans":"Drop it in migration 0042","rejectMeans":"Keep it for one more release",
       "attachments":["<id from POST /api/attachments>"]}' | jq -r .id)

# wait for answers on any of the group's lanes (up to 24h per call; repeat while ready is false)
curl -s "$URL/api/wait?group=payments-epic&timeout=86400" -H "authorization: Bearer $KEY" | jq '.decided[] | {ref,decision,decisionNote}'

# acknowledge first: returns the final decision, and publishes the lane's next state
curl -s -X POST $URL/api/escalations/$ID/ack -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"note":"dropping in migration 0042","status":"active","activity":"Dropping legacy_role"}'

# or, if the owner answered in the agent's session (and always with LANESIGNAL_DECISIONS=false):
# dismiss it, saying what was decided, and publish the next state
curl -s -X POST $URL/api/escalations/$ID/withdraw -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"note":"Sam: drop it (in session)","status":"active","activity":"Dropping legacy_role"}'
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
| `GET /api/projects/:id/members` | human | `[{userId, name, email, role, notify, instanceAdmin?}]`. Account admins are listed too (`instanceAdmin: true`): they see every project |
| `PUT /api/projects/:id/members/:userId` | project admin | `{role: "admin" \| "member"}`: add a person or change their role |
| `DELETE /api/projects/:id/members/:userId` | project admin | Remove a member |
| `PUT /api/projects/:id/notifications` | person | `{enabled}`: push for this project on your own devices |
| `GET /api/projects/:id/trmnl` | project admin | The project's [TRMNL screen](trmnl.md): `{configured: false}`, or `{configured: true, webhookUrl, enabled, includeNotifications, lastPushAt, lastError, lastErrorAt, updatedAt}` with the webhook URL's plugin id hidden |
| `PUT /api/projects/:id/trmnl` | project admin | `{webhookUrl?, enabled, includeNotifications}`. `webhookUrl` is needed the first time; leave it out to keep the saved one. It must be `https://trmnl.com/…` (or a host in `LANESIGNAL_TRMNL_HOSTS`) |
| `DELETE /api/projects/:id/trmnl` | project admin | Stops pushing and forgets the URL |
| `POST /api/projects/:id/trmnl/send` | project admin | Pushes now: `{ok, status?, error?, setup}` with TRMNL's answer |
| `GET /api/projects/:id/trmnl/preview` | project admin | `{merge_variables}`: the data the next push sends |
| `GET /api/projects/:id/trmnl/plugin.zip` | project admin | The private plugin to import into TRMNL, named after the project |
| `PUT /api/settings/push` | instance admin | `{quietAlerts}`: send alerts as regular notifications instead of high priority (shown in `GET /api/config`) |
| `GET /api/people` | project admin | Everyone with an account, for adding members |
| `GET /api/events` | any | Server-Sent Events: `group`, `group_deleted`, `lane`, `lane_deleted`, `escalation`. Only your projects' events. The stream ends when memberships or projects change; reconnect and re-snapshot. Heartbeat every 25s. `?access_token=` is accepted here only, for clients that can't set headers |
| `GET /api/groups` | any | |
| `PUT /api/groups/:id` | agent | Create or update `{name?, ticket?, links?}` |
| `DELETE /api/groups/:id` | human | Archives it. Its lanes show as ungrouped, and exports keep the link |
| `GET /api/lanes` | any | |
| `GET /api/lanes/:id` | any | Lane, its recent escalations, the last 100 activity entries (its conversation left out), and its conversation (`messages`, the latest 100; the owner's carry `seen`: whether the agent has had them) |
| `PUT /api/lanes/:id` | agent | Create or update `{name?, group?, status?, ticket?, activity?, links?}`. The group must be registered first (`404` otherwise, so a typo can't create a stray group). While a blocking escalation is open the lane stays `blocked_human`. When the owner wrote on the lane since the agent last heard, the reply adds `ownerMessages` (handed over once) |
| `DELETE /api/lanes/:id` | any | Archives the lane and withdraws its unanswered escalations; decided ones keep their answer. Its history stays for export, and republishing restores it |
| `GET /api/escalations?state=open,decided&lane=<id>` | any | Defaults to unresolved (open and decided) |
| `POST /api/escalations` | agent | See the [fields](concepts.md#escalations). `blocking: false` for FYI questions. The lane must be published first (`404` otherwise). `201` when created; `200` with `duplicate: true` when the same question (ignoring spacing and case) is already open on that lane from the same agent. If that one is an FYI and this request isn't (`blocking` left out or `true`), it becomes blocking and notifies the owner: `200` with `upgraded: true`, and fields given here replace the FYI's (new `attachments` are added). A retry's new `attachments` are added too |
| `GET /api/history?q=&outcome=answered\|dismissed&group=&project=&limit=&before_at=&before_id=` | any | Closed escalations (acknowledged or dismissed), latest first: `{items, next}`. `q` searches the question, context, answers, notes and conversation, or a code. Pass `next` back as `before_at` / `before_id` for older ones. `limit` defaults to 50 (max 200) |
| `POST /api/escalations/:id/messages` | any | Decisions on. `{body, attachments?}`. From a person: an answer of Other (the turn goes to the agent). From the agent that raised it: a reply or update, at most 500 characters (people: 2,000). `409` once the escalation is closed |
| `GET /api/escalations/:id?wait=<s>` | any | The escalation in full, with its conversation in `messages`. With answering on the dashboard on, `wait` (up to 300) holds the request until it's no longer open or the owner answered Other (`turn: "agent"`) |
| `POST /api/attachments` | any | Multipart upload with the file in the `file` field (`curl -F file=@plan.md`). Markdown or text (`.md`, `.txt`, UTF-8) or a PNG, JPEG, WebP or GIF image, recognised by content; at most `LANESIGNAL_ATTACHMENT_MAX_MB`. Returns `201 {id, name, type, size}`. List the id in an escalation's `attachments` within a day |
| `GET /api/attachments/:id` | any | The file, to callers who can see its escalation (or its uploader, before it's attached) |
| `POST /api/lanes/:id/messages` | any | `{body, attachments?}`: write in the lane's [conversation](concepts.md#lane-conversations). From an agent: a milestone, at most 500 characters, pushed quietly (as `/notices`). From a person (answering in LaneSignal on, `404` otherwise): a note, at most 2,000 characters, that the agent gets the next time it publishes, writes on or waits on the lane; `409` on a removed lane. Nothing changes the lane's status. An agent's reply carries the owner's unseen notes in `ownerMessages` |
| `POST /api/lanes/:id/notices` | agent | `{message, attachments?}` (at most 500 characters): the agent's message in the lane's conversation, as `notify_owner` sends it: pushed quietly, kept in the lane's history (`kind: "notice"`). `404` for an unknown lane; `409` for a second one on the lane within a minute (the limit is per lane; the same text again returns the first). Carries `ownerMessages` like `/messages` |
| `GET /api/wait?group=&lane=a,b&ids=1,2&timeout=<s>` | any | Decisions on (`404` otherwise). Waits until something in scope needs the agent; give at least one of `group`, `lane`, `ids`. Returns `{ready, decided, replies, closed, open, removedLanes, laneMessages, checkedAt}` (`replies`: escalations the owner answered Other, with their messages since the agent last wrote; `laneMessages`: the owner's notes on lanes in scope, including the lanes of escalations named in `ids`, each returned once) ([details](agents.md#waiting-for-decisions)), with escalations in brief (no context; `GET /api/escalations/:id` has everything); pass `checkedAt` back as `since`. Unknown groups, lanes or ids are `404`. `timeout` defaults to 300, max 86400. If it has to wait, it sends `200` at once and a space every 20s until the JSON follows, so proxies keep it open |
| `POST /api/escalations/:id/positions` | agent | Decisions on. `{stance, note?, agent?}`. Open escalations only; at most 20 agents |
| `POST /api/escalations/:id/decide` | human | Decisions on. `{decision, note?, change?}`: the app sends `Accept`, `Reject` or `Other`. `Reject` is `400` where the agent set `allowReject: false`, and `Other` needs a `note` (at most 2,000 characters). On an open escalation, `Other` opens a conversation instead of deciding (see `/messages`); with `change: true` on a decided one, it replaces the decision. A second decision is `409`, unless `change: true` and the agent hasn't acknowledged yet |
| `POST /api/escalations/:id/ack` | any | Decisions on. `{note?, status?, activity?}`. Only the agent that raised it, or a person, can acknowledge (`403` for other agents). Returns the escalation with the final decision; `status`/`activity` update the lane. Repeating it returns the same result |
| `POST /api/escalations/:id/withdraw` | any | Dismiss: `{note, status?, activity?}`. Agents must give `note`, the justification (what was decided and where); only the agent that raised it can dismiss it (`403` otherwise), and people may dismiss stale ones. `status`/`activity` publish the lane's next state; a lane this unblocks goes back to `active` |
| `GET /api/export` | any | Zip of every dataset as CSV plus a README. `?from=&to=&lane=&project=` filter. One export at a time (`429` while another runs). See [Export](export.md) |
| `GET /api/export/<dataset>.csv` / `.json` | any | `escalations`, `positions`, `lanes`, `groups`, `events` or `requirements`. Same filters |
| `GET /api/requirements?q=&tag=a,b&group=&status=active,superseded&limit=` | any | Search [requirements](requirements.md). All `/api/requirements` routes are `404` when `LANESIGNAL_REQUIREMENTS=false`. Active only by default; `q` is free text, or an id like `R14`. Includes requirements for all projects |
| `GET /api/requirements/tags?group=` | any | Tags in use, with counts |
| `GET /api/requirements/:id` | any | One requirement |
| `POST /api/requirements` | any | `{requirement, justification, tags, group?, sourceEscalation?, decidedBy?, allProjects?}`. `requirement` is at most 300 characters and `justification` at most 800. Recording the same requirement again from the same escalation returns the first with `duplicate: true` (`200`). `allProjects: true` makes it apply to every project. Agents must say who decided: `decidedBy`, or a `sourceEscalation` decided on the dashboard (an alert answered in the session is cited together with `decidedBy`); a person recording one is the decider by default. Returns `{requirement, similar, warnings}` |
| `POST /api/requirements/:id/supersede` | any | Same body; marks the old one superseded |
| `PATCH /api/requirements/:id` | human | Fix `requirement`, `justification` or `tags` wording |
| `POST /api/requirements/:id/retire` | human | It no longer applies; nothing replaces it |
| `POST /api/requirements/:id/restore` | human | Undo a retire |
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
