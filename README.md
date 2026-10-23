# LaneSignal

*Internal codename: VNATS (Vault Network Activity & Triage System)*

A small, self-hosted dashboard for watching autonomous coding-agent **lanes** and handling the **escalations** that need a human decision. It's built mobile-first, and the same React code runs in the browser and in an Android app.

- Agents **publish** lane state and escalations over **MCP** or a plain **HTTP API**. Nobody has to poll sessions.
- Humans see **open decisions first**, kept apart from routine status. They answer with one tap, and every connected browser and phone updates live over SSE.
- Escalations **persist** until a human decides and the agent acknowledges.
- Android **push notifications** fire only for human-required escalations by default.
- It runs as **one Docker container** (API, MCP, SSE and the web app) with a SQLite file on a volume.

LaneSignal is an observability and intervention surface, not an orchestrator. Claude Remote Control stays the conversational interface. LaneSignal tells you *which* lane needs you and links straight to its session, ticket, PR and CI run.

```
 agents ──MCP /mcp──┐                         ┌── browser (React)
 agents ──HTTP /api─┼─► LaneSignal server ──SSE┼── Android app (same React build, Capacitor)
                    │   Express + SQLite      └── FCM / ntfy push (escalations only)
                    └─► /data/lanesignal.db (volume)
```

## Build vs. adopt: what was evaluated

| Candidate | What it is | Fit | Decision |
|---|---|---|---|
| **[Agent Inbox](https://github.com/langchain-ai/agent-inbox)** (LangChain) | Next.js UI for LangGraph `interrupt()`s | Has no backend of its own. It reads LangGraph Platform deployments, needs a LangSmith key, and keeps its config in browser localStorage. Its notion of an escalation is tied to LangGraph threads, and it has no lanes, push or Android support. | **Not adopted.** We borrowed its interaction model: an inbox of interrupts with accept/respond actions. |
| **[Kanbrawl](https://github.com/sinedied/kanbrawl)** (MIT) | Minimal live kanban for agents: Express 5 + MCP SDK (Streamable HTTP) + SSE + a JSON-file store, with a Lit UI | Its architecture is close to what we need. Its data model (tasks in columns), lack of authentication, single-writer JSON file and Lit frontend all needed replacing. Extending it would have meant rewriting nearly everything except the wiring. | **Architecture adopted, code not forked.** The same stack and patterns, with a lane/escalation model, token auth and SQLite. |

The resulting server is about 1,500 lines of TypeScript with three runtime dependencies (`express`, `@modelcontextprotocol/sdk`, `zod`). It uses Node's built-in `node:sqlite`, so there are no native modules and no external services.

## Quick start (Docker)

```bash
cp .env.example .env          # set tokens, ticket templates, group label
docker compose up -d --build
curl localhost:8080/healthz   # {"ok":true}
```

Open `http://localhost:8080` and sign in with a **human** token.

If you set no tokens at all, the server generates one human token and one agent token on first start and stores them in the data volume:

```bash
docker compose exec lanesignal cat /data/generated-tokens.json
```

Data lives in the `lanesignal-data` volume (`/data/lanesignal.db`, SQLite in WAL mode). Restarts and image upgrades keep it, and schema migrations run on startup. Configuration can come from environment variables or `config/lanesignal.json`, which is mounted read-only at `/config`.

For remote access, keep the port bound to localhost (the default in `docker-compose.yml`) and put a TLS reverse proxy in front of it: Caddy, Traefik, nginx or `tailscale serve`. SSE needs proxy buffering off. LaneSignal already sends `X-Accel-Buffering: no` for nginx. If you're behind Docker Hub rate limits, build with `--build-arg NODE_IMAGE=mirror.gcr.io/library/node:22-bookworm-slim`.

## Concepts

**Group** (the epic, train or overseer): one overseer agent session runs many lanes for a body of tickets, and the group is named after it. That makes overseer = epic/train = group, one concept. `LANESIGNAL_GROUP_LABEL` only sets what the UI calls it (Epic, Train, Overseer…). The group names themselves come from the overseers. A group has:

- a name
- the epic/train ticket
- links, most usefully the overseer's Remote Control session, so you can go straight to the conversation that owns a decision

A lane that references an unknown group creates it. The overseer fills in the details with `update_group`. Lanes are arranged by group by default, and groups with lanes that need you sort first.

**Lane**: one long-running agent work stream, identified by a stable id the agent picks (`auth-rework`, `train-42`). A lane has:

- a **status**: `active`, `pending_ci`, `awaiting_agent`, `blocked_human`, `idle` or `completed`
- an optional **group**: the id of the epic/train it belongs to. There is no deeper hierarchy
- a **ticket** reference, a one-line **activity**, and **links** (PRs, CI runs, the Remote Control session)

The server tracks `updatedAt`, time in the current status, and cumulative **time blocked**. The UI flags lanes as *stale* when an active lane hasn't published in `staleMinutes`.

**Escalation**: a question for humans, attached to a lane. Only `question` is required. The other fields follow a loose structure:

| Field | Meaning |
|---|---|
| `context` | What a human needs to know to answer without opening the agent's session |
| `question` | The decision being asked for (also the headline) |
| `recommendation` | What the escalating agent would do and why. `recommendedOption` marks one of `options` as recommended |
| `cost` | What following the recommendation costs (dependencies, image size, time, risk) |
| `alternatives` | Other paths considered, one string each, with its tradeoff |
| `ticket` | What the question is about (e.g. the plan `gh:921`) when it differs from the lane's ticket |
| `positions` | Other agents' agreement or disagreement with the recommendation: `{agent, stance: agree\|disagree\|neutral, note}`. Positions can be given at creation or added later, one per agent |

A lane can have any number of open escalations. A plan with four questions raises four escalations, and the lane stays `blocked_human` until the last one is decided. The inbox lists each lane's questions together, in order, labelled "Question 1 of 4 from this lane". The detail sheet has Previous and Next buttons for stepping through the batch.

Inbox cards stay compact: the question, a one-line recommendation, the agree/disagree counts and one-tap options. Tapping a card opens the full detail sheet with every section, a free-text answer and a note. Push notifications and rows in a lane's history open the same sheet.

Its lifecycle:

```
open ──(human decides)──► decided ──(agent acknowledges)──► acknowledged
  └────────(agent or human withdraws: answered elsewhere / moot)────► withdrawn
```

Creating an escalation sets the lane to `blocked_human` unless `blocking: false` is passed. Once a lane's last open escalation is decided, the lane moves to `awaiting_agent`, so the blocked timer stops while the agent picks the decision up. When two humans race, the second one gets `409 Conflict`. Decided-but-unacknowledged escalations stay on the dashboard under "awaiting agent" until the agent confirms.

**Ticket references** are resolved with URL templates. With `redmine=https://redmine/issues/{id}` configured:

- `redmine:1234` → that system's URL
- `#1234` or `1234` → the default system's URL
- `https://…` → used as-is

LaneSignal never syncs tickets. It only links to them.

## Connecting agents

### MCP (recommended)

The endpoint is Streamable HTTP and stateless, at `POST /mcp`, using an **agent** token:

```bash
claude mcp add --transport http lanesignal https://lanesignal.example.com/mcp \
  --header "Authorization: Bearer $LANESIGNAL_AGENT_TOKEN"
```

| Tool | Role | Purpose |
|---|---|---|
| `update_group` | agent | Overseers: name the epic/train, set its ticket and the overseer session link |
| `update_lane` | agent | Create or patch the lane's status, ticket, activity, links and `group` |
| `create_escalation` | agent | Ask for a decision (`options` render as one-tap buttons) |
| `add_position` | agent | Agree or disagree with an open escalation's recommendation (one per agent; `agent` names you on a shared token) |
| `get_escalation` | any | Read one escalation. `wait_seconds` (≤300) long-polls until it is decided |
| `acknowledge_escalation` | agent | Confirm the decision was received; closes the escalation |
| `withdraw_escalation` | agent | Close it without a dashboard decision (answered in Remote Control, or moot) |
| `list_lanes`, `list_escalations` | any | Read state |
| `list_groups` | any | Read the groups |
| `decide_escalation` | human | Lets a human's own Claude session answer from the conversation |

A snippet to paste into an agent's `CLAUDE.md` is in [`docs/agent-instructions.md`](docs/agent-instructions.md).

### HTTP API

All endpoints take `Authorization: Bearer <token>`.

```bash
# publish lane state (creates the lane on first call; omitted fields stay unchanged)
curl -X PUT $URL/api/lanes/auth-rework -H "authorization: Bearer $AGENT" -H 'content-type: application/json' \
  -d '{"name":"Auth rework","group":"payments-epic","status":"pending_ci","ticket":"redmine:4812",
       "activity":"Waiting on CI for PR #311",
       "links":[{"label":"PR #311","url":"https://github.com/o/r/pull/311","kind":"pr"}]}'

# escalate, then block until a human answers (long-poll, no busy polling)
ID=$(curl -s -X POST $URL/api/escalations -H "authorization: Bearer $AGENT" -H 'content-type: application/json' \
  -d '{"laneId":"auth-rework",
       "context":"legacy_role has had no reads for 90 days; rollback needs a backup restore.",
       "question":"Drop legacy_role column?",
       "recommendation":"Drop it; the auth rework is simpler without it.",
       "options":["Drop","Keep"],"recommendedOption":"Drop"}' | jq -r .id)

# another agent weighs in
curl -s -X POST $URL/api/escalations/$ID/positions -H "authorization: Bearer $AGENT" -H 'content-type: application/json' \
  -d '{"agent":"billing-export","stance":"disagree","note":"Billing job reads it via raw SQL"}'

curl -s "$URL/api/escalations/$ID?wait=300" -H "authorization: Bearer $AGENT" | jq '{state,decision,decisionNote}'
curl -s -X POST $URL/api/escalations/$ID/ack -H "authorization: Bearer $AGENT" -H 'content-type: application/json' -d '{"note":"dropping"}'
```

| Method & path | Role | |
|---|---|---|
| `GET /healthz` | public | Liveness and DB check |
| `GET /api/snapshot` | any | All lanes plus unresolved escalations |
| `GET /api/events` | any | SSE stream of `lane`, `lane_deleted` and `escalation` events |
| `GET /api/groups` | any | |
| `PUT /api/groups/:id` | agent | Upsert `{name?, ticket?, links?}` |
| `DELETE /api/groups/:id` | human | Its lanes become ungrouped |
| `GET /api/lanes`, `GET /api/lanes/:id` | any | Lane detail includes escalation history and the last 100 events |
| `PUT /api/lanes/:id` | agent | Upsert |
| `DELETE /api/lanes/:id` | human | Remove a lane and its history |
| `GET /api/escalations[?state=open,decided&lane=]` | any | |
| `POST /api/escalations` | agent | |
| `GET /api/escalations/:id[?wait=s]` | any | Long-poll |
| `POST /api/escalations/:id/positions` | agent | `{stance, note?, agent?}`, open escalations only |
| `POST /api/escalations/:id/decide` | human | `{decision, note?}` |
| `POST /api/escalations/:id/ack` | agent | `{note?}` |
| `POST /api/escalations/:id/withdraw` | any | `{note?}` |
| `POST /api/push/register` / `unregister` | human | Used by the Android app |

`scripts/seed-demo.mjs` publishes sample lanes if you want to try the UI.

## Android app

The Android app is the same `web/` React build wrapped with **Capacitor 8**, so there is no second frontend. It talks to the same server, tokens and database as the browser.

**Getting an APK:** CI (`.github/workflows/ci.yml`, job `android`) builds `app-debug.apk` on every push and uploads it as the `lanesignal-apk` artifact. That APK is installable directly: enable *Install unknown apps* on the phone. To build locally you need JDK 21 and the Android SDK:

```bash
npm ci
cd web && npm run android:apk      # → web/android/app/build/outputs/apk/debug/app-debug.apk
```

On first launch, enter the server URL and a human token. The server must be reachable over **HTTPS**. For LAN-only testing over plain HTTP, sync with `LANESIGNAL_ALLOW_HTTP=1 npm run android:sync`.

**Signed release APK:** add the repository secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`. CI then also builds `app-release.apk`.

### Push notifications

By default, push fires only when an escalation is created. Add `blocked` or `completed` to `LANESIGNAL_NOTIFY_ON` if you want those too. Tapping a notification opens the escalation. There are two backends, and you can use either or both:

1. **Firebase Cloud Messaging** (native Android push):
   - Create a Firebase project and add an Android app with id `dev.lanesignal.app`.
   - Store its `google-services.json` as the repository secret `GOOGLE_SERVICES_JSON`. CI compiles push support in only when this secret exists.
   - Put a service-account key at `config/fcm-service-account.json` and set `LANESIGNAL_FCM_SERVICE_ACCOUNT_FILE=/config/fcm-service-account.json`.
   - The server calls the FCM HTTP v1 API directly, without the firebase-admin SDK.
2. **[ntfy](https://ntfy.sh)** (no Google dependency, self-hostable): set `LANESIGNAL_NTFY_URL=https://ntfy.example.com/<secret-topic>` (and `LANESIGNAL_NTFY_TOKEN` if needed). Then subscribe to the topic in the ntfy Android app. Notifications deep-link to `LANESIGNAL_PUBLIC_URL`.

## Configuration

| Env var | JSON key | Default | |
|---|---|---|---|
| `PORT` / `HOST` | | `8080` / `0.0.0.0` | |
| `LANESIGNAL_DATA_DIR` | | `/data` | SQLite and generated tokens |
| `LANESIGNAL_CONFIG` | | `/config/lanesignal.json` | Optional JSON config file |
| `LANESIGNAL_HUMAN_TOKENS` | `tokens[]` | | `name:token,…` (≥16 chars each). The former name `LANESIGNAL_OVERSEER_TOKENS` still works |
| `LANESIGNAL_AGENT_TOKENS` | `tokens[]` | | `name:token,…` |
| `LANESIGNAL_GROUP_LABEL` | `groupLabel` | `Epic` | What groups are called in the UI (Epic, Train, Overseer…) |
| `LANESIGNAL_TICKET_TEMPLATES` | `ticketTemplates` | | `key=url-with-{id},…` |
| `LANESIGNAL_TICKET_DEFAULT` | `defaultTicketSystem` | first template | |
| `LANESIGNAL_STALE_MINUTES` | `staleMinutes` | `30` | `0` disables the stale flag |
| `LANESIGNAL_NOTIFY_ON` | `notifyOn` | `escalation` | Also `blocked`, `completed` |
| `LANESIGNAL_FCM_SERVICE_ACCOUNT_FILE` | `fcmServiceAccountFile` | | |
| `LANESIGNAL_NTFY_URL` / `_TOKEN` | `ntfyUrl` / `ntfyToken` | | |
| `LANESIGNAL_PUBLIC_URL` | `publicUrl` | | Used for notification links |
| `LANESIGNAL_CORS_ORIGINS` | `corsOrigins` | Capacitor origins | Add an origin only if another web origin hosts the UI |
| `LANESIGNAL_TRUST_PROXY` | | `false` | Set it behind a reverse proxy |
| `LANESIGNAL_EVENT_RETENTION` | `eventRetention` | `200` | Activity events kept per lane |
| `LOG_LEVEL` | | `info` | Logs are JSON lines on stdout |

## Security model

- Bearer tokens have two roles:
  - **agent**: publish lanes, create, acknowledge and withdraw escalations.
  - **human**: decide escalations, delete lanes and groups, register for push. Overseer *agents* use agent tokens.
- Tokens are compared in constant time against SHA-256 digests.
- Agents can't decide their own escalations, and humans can't spoof lane state.
- Link URLs must be `http(s)`, and all input is validated with zod.
- The SSE endpoint is the only place a token is accepted as a query parameter (`?access_token=`), for clients that can't set headers. The bundled client sends a header.
- TLS is terminated by your reverse proxy. Keep the container port off the public internet.

## Development

```bash
npm ci
npm run dev:server        # :8080, data in server/.data, generated tokens printed to the log
npm run dev:web           # Vite on :5173, proxies /api to :8080
npm test                  # server API, lifecycle, SSE and MCP tests (node:test)
npm run typecheck && npm run build
```

Layout:

- `server/`: Express API, MCP, SSE and SQLite store.
- `web/`: React UI and the Capacitor Android project.
- `server/src/types.ts`: API types, shared with the web client.

## Scope: essential vs. optional

**Built (essential):**

- Lane and escalation model, MCP and HTTP publishing
- Persistent escalation lifecycle with acknowledgement
- Live multi-client updates
- Lanes grouped by epic/train (one overseer, many lanes), with group and status filters and human-needed lanes first
- Blocked-time tracking
- Ticket URL templates and contextual links
- Mobile-first shared UI, Android APK, escalation-only push
- Single container with volumes, health check, JSON logs and token auth

**Deliberately not built:**

- Ticket sync or editing
- Agent execution or orchestration
- Analytics or reporting
- User management beyond static tokens
- Hierarchical taxonomies

**Possible later, if they prove useful:**

- Web Push for desktop browsers
- Per-human notification preferences
- Pruning of old acknowledged escalations
- An OIDC front door: today you can put the server behind an authenticating proxy such as oauth2-proxy and keep tokens for agents

## License

[MIT](LICENSE)
