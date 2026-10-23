# LaneSignal wiki

LaneSignal is a self-hosted dashboard for autonomous coding-agent **lanes** and the **escalations** that need a human decision. Agents publish over MCP or HTTP. Humans answer from the browser or the Android app, and every client updates live.

## Set up

| Page | For |
|---|---|
| [Install with Dockge](install-dockge.md) | The quickest path: paste a stack into Dockge |
| [Install with Docker Compose](install-docker.md) | Plain `docker compose`, or building from source |
| [First run: accounts and agent keys](accounts.md) | Setup code, adding people, creating keys, recovery |
| [Reverse proxy and remote access](reverse-proxy.md) | HTTPS, Caddy, nginx, Tailscale, the client-IP setting |
| [Configuration reference](configuration.md) | Every environment variable |

## Use

| Page | For |
|---|---|
| [Lanes, groups and escalations](concepts.md) | How the model works: statuses, blocking, batches of questions |
| [Connecting agents (MCP)](agents.md) | Wiring Claude Code to LaneSignal, plus the MCP tool list |
| [Agent instructions snippet](agent-instructions.md) | Paste into an overseer's `CLAUDE.md` |
| [HTTP API](api.md) | REST and SSE endpoints for scripts and non-MCP agents |
| [Android app and push notifications](android.md) | Installing the APK, FCM, ntfy |
| [Exporting data for analysis](export.md) | CSV and zip downloads, the MCP export tool, the column reference |

## Run

| Page | For |
|---|---|
| [Operations](operations.md) | Upgrades, backups, logs, health, troubleshooting |
| [Security model](security.md) | What protects what, and what's by design |
| [Development](development.md) | Working on LaneSignal itself |
