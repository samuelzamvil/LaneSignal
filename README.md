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

## Quick start

**Dockge:** paste [`deploy/dockge/compose.yaml`](deploy/dockge/compose.yaml) and [`.env.example`](deploy/dockge/.env.example) into a new stack and deploy. The full walkthrough is [Install with Dockge](docs/install-dockge.md).

**Docker Compose:**

```bash
curl -fsSLO https://raw.githubusercontent.com/samuelzamvil/LaneSignal/main/deploy/dockge/compose.yaml
curl -fsSL https://raw.githubusercontent.com/samuelzamvil/LaneSignal/main/deploy/dockge/.env.example -o .env
docker compose up -d
docker compose logs lanesignal | grep setupCode
```

Open `http://<host>:8080` and create the admin account with that one-time setup code. Then:

1. Create an agent key per overseer in **Settings → Agent keys**.
2. Connect Claude Code with the `claude mcp add …` command Settings shows.
3. Paste the [agent instructions](docs/agent-instructions.md) into the overseer's `CLAUDE.md`.

## Documentation

The wiki lives in [`docs/`](docs/README.md):

- **Setup:** [Dockge](docs/install-dockge.md) · [Docker Compose](docs/install-docker.md) · [Accounts and agent keys](docs/accounts.md) · [Reverse proxy](docs/reverse-proxy.md) · [Configuration](docs/configuration.md)
- **Use:** [Concepts](docs/concepts.md) · [Connecting agents](docs/agents.md) · [Agent instructions](docs/agent-instructions.md) · [HTTP API](docs/api.md) · [Android and push](docs/android.md)
- **Run:** [Operations](docs/operations.md) · [Security](docs/security.md) · [Development](docs/development.md)

## Build vs. adopt: what was evaluated

| Candidate | What it is | Fit | Decision |
|---|---|---|---|
| **[Better Auth](https://github.com/better-auth/better-auth)** (MIT) | TypeScript auth library | Runs on our `node:sqlite` database and mounts on Express. Its bearer, admin and API-key plugins cover accounts, people management and account-owned agent keys. | **Adopted** for accounts and agent keys. |
| **[Agent Inbox](https://github.com/langchain-ai/agent-inbox)** (LangChain) | Next.js UI for LangGraph `interrupt()`s | Has no backend of its own. It reads LangGraph Platform deployments, needs a LangSmith key, and keeps its config in browser localStorage. Its notion of an escalation is tied to LangGraph threads, and it has no lanes, push or Android support. | **Not adopted.** We borrowed its interaction model: an inbox of interrupts with accept/respond actions. |
| **[Kanbrawl](https://github.com/sinedied/kanbrawl)** (MIT) | Minimal live kanban for agents: Express 5 + MCP SDK (Streamable HTTP) + SSE + a JSON-file store, with a Lit UI | Its architecture is close to what we need. Its data model (tasks in columns), lack of authentication, single-writer JSON file and Lit frontend all needed replacing. Extending it would have meant rewriting nearly everything except the wiring. | **Architecture adopted, code not forked.** The same stack and patterns, with a lane/escalation model, token auth and SQLite. |

The server is a small TypeScript app on Node's built-in `node:sqlite`, so there are no native modules and no external services to run.

## Scope

**Built:**

- lanes grouped by epic/train (one overseer, many lanes)
- structured escalations with batches, positions and an acknowledgement lifecycle
- live updates in the browser and the Android app
- push for decisions only
- accounts with account-owned agent keys
- one container

**Deliberately not built:**

- ticket sync or editing
- agent execution or orchestration
- analytics
- deep hierarchies

**Possible later:**

- Web Push for desktop browsers
- per-person notification preferences
- pruning old acknowledged escalations
- SSO via OIDC

## License

[MIT](LICENSE)
