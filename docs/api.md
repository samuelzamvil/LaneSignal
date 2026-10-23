# HTTP API

Everything the MCP tools do is also available over plain HTTP, for scripts, CI jobs and agents without MCP.

- **Auth:** every request (except `/healthz` and `/api/setup`) sends `Authorization: Bearer <credential>`. A credential is an agent key (`ls_…`), an account session token, or a static config token.
- **Errors:** responses are JSON. Errors look like `{"error": "…"}` with a 4xx status:
  - `400` validation (with `issues`)
  - `401` no or invalid credential
  - `403` wrong role
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

# wait for the answer (up to 300s per call; repeat while state is "open")
curl -s "$URL/api/escalations/$ID?wait=300" -H "authorization: Bearer $KEY" | jq '{state,decision,decisionNote}'

# confirm you're acting on it
curl -s -X POST $URL/api/escalations/$ID/ack -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"note":"dropping in migration 0042"}'
```

## Endpoints

| Method and path | Role | Notes |
|---|---|---|
| `GET /healthz` | public | `{"ok":true}` when the database answers. Used by the container health check |
| `GET /api/setup` | public | `{"needsSetup": bool}` |
| `POST /api/setup` | public + code | First admin account: `{email, name, password, code}`. The code isn't needed when sending a static human token |
| `GET /api/me` | any | Who the credential is: `{name, role, admin?, email?, userId?}` |
| `GET /api/config` | any | Group label, statuses, ticket systems, push availability |
| `GET /api/snapshot` | any | Groups, lanes and unresolved escalations |
| `GET /api/events` | any | Server-Sent Events: `group`, `group_deleted`, `lane`, `lane_deleted`, `escalation`. Heartbeat every 25s. `?access_token=` is accepted here only, for clients that can't set headers |
| `GET /api/groups` | any | |
| `PUT /api/groups/:id` | agent | Create or update `{name?, ticket?, links?}` |
| `DELETE /api/groups/:id` | human | Its lanes become ungrouped |
| `GET /api/lanes` | any | |
| `GET /api/lanes/:id` | any | Lane, its recent escalations and the last 100 activity entries |
| `PUT /api/lanes/:id` | agent | Create or update `{name?, group?, status?, ticket?, activity?, links?}` |
| `DELETE /api/lanes/:id` | human | Removes the lane and its history |
| `GET /api/escalations?state=open,decided&lane=<id>` | any | Defaults to unresolved (open and decided) |
| `POST /api/escalations` | agent | See the [fields](concepts.md#escalations). `blocking: false` for FYI questions |
| `GET /api/escalations/:id?wait=<s>` | any | `wait` (up to 300) holds the request until it's no longer open |
| `POST /api/escalations/:id/positions` | agent | `{stance, note?, agent?}`. Open escalations only; at most 20 agents |
| `POST /api/escalations/:id/decide` | human | `{decision, note?}` |
| `POST /api/escalations/:id/ack` | agent | `{note?}` |
| `POST /api/escalations/:id/withdraw` | any | `{note?}` |
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
