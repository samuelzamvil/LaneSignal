# LaneSignal wiki

LaneSignal is a self-hosted dashboard for autonomous coding-agent **lanes** and the **escalations** that need you. Agents publish over MCP or HTTP, and your phone is notified. You see lane progress and blockers in the browser or the Android app and answer there; the agent waits for your answer, acknowledges it and carries on. [Features](configuration.md#features) switch LaneSignal to alerts only (you answer in the agent's session), or turn off the requirements register.

## Set up

| Page | For |
|---|---|
| [Install with Dockge](install-dockge.md) | The quickest path: paste a stack into Dockge |
| [Install with Docker Compose](install-docker.md) | Plain `docker compose`, or building from source |
| [First run: accounts and agent keys](accounts.md) | Setup code, adding people, creating keys, recovery |
| [Reverse proxy and remote access](reverse-proxy.md) | HTTPS, Caddy, nginx, Tailscale, the client-IP setting |
| [Sign in with Cloudflare Access (beta)](cloudflare-access.md) | Google sign-in through Cloudflare Access, in the browser and the Android app |
| [Configuration reference](configuration.md) | Every environment variable |

## Use

| Page | For |
|---|---|
| [Lanes, groups, tickets, epics and escalations](concepts.md) | How the model works: statuses, tickets, epics, blocking, batches of questions |
| [Projects](projects.md) | Several independent apps on one server: members, admins, per-project notifications |
| [Requirements](requirements.md) | The owner's product decisions: recorded by agents, searchable, never lost |
| [Connecting agents (MCP)](agents.md) | Wiring Claude Code to LaneSignal, plus the MCP tool list |
| [Agent policy template](agent-instructions.md) | What's specific to one overseer: paste into its `CLAUDE.md`. The tools say how LaneSignal works; the [skill's usage](agents.md#the-skill-is-one-way-to-use-lanesignal) says when, and you can write your own |
| [HTTP API](api.md) | REST and SSE endpoints for scripts and non-MCP agents |
| [Android app and push notifications](android.md) | Installing the APK, FCM, ntfy |
| [TRMNL screen](trmnl.md) | A project's latest notification and pending escalations on a TRMNL e-ink display |
| [Exporting data for analysis](export.md) | CSV and zip downloads, the MCP export tool, the column reference |

## Run

| Page | For |
|---|---|
| [Operations](operations.md) | Upgrades, backups, logs, health, troubleshooting |
| [Security model](security.md) | What protects what, and what's by design |
| [Development](development.md) | Working on LaneSignal itself |
