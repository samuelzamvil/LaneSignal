# Configuration reference

Every setting can be an environment variable. Most can also go in an optional JSON file (`LANESIGNAL_CONFIG`, default `/config/lanesignal.json`; see [`config/lanesignal.example.json`](../config/lanesignal.example.json)). Environment variables win over the file. Invalid numbers stop the server at startup with a message naming the variable.

## Features

Set these in the stack's environment (Compose / `.env`); there's no switch in the app.

| Env var | Default | Notes |
|---|---|---|
| `LANESIGNAL_DECISIONS` | `true` | Answering in LaneSignal. On (the default), escalations get answer buttons on the dashboard and phone app, and agents wait for and acknowledge the decision. `false` makes LaneSignal alerts only: you answer in the agent's own session (e.g. Remote Control) and the agent dismisses the alert with a justification; the dashboard is read-only apart from dismissing stale alerts. See [Lanes, groups and escalations](concepts.md#escalations) |
| `LANESIGNAL_REQUIREMENTS` | `true` | The [requirements](requirements.md) register: a durable, searchable record of the owner's decisions outside the repository. `false` removes its tools, page, API and export |
| `LANESIGNAL_CLOUDFLARE_ACCESS` | `false` | Beta. [Sign in with Cloudflare Access](cloudflare-access.md): people Access lets in are signed in as the account with their email, in the browser and (through Access's Managed OAuth) in the Android app. Needs the settings under [Cloudflare Access](#cloudflare-access) |

## Server

| Env var | JSON key | Default | Notes |
|---|---|---|---|
| `PORT` / `HOST` | | `8080` / `0.0.0.0` | Inside the container; map the host port in Compose |
| `LANESIGNAL_NAME` | `name` | `LaneSignal` | Title shown in the app |
| `LANESIGNAL_PUBLIC_URL` | `publicUrl` | | URL people use. Trusted origin for sign-in, and the base for notification links |
| `LANESIGNAL_TRUST_PROXY` | | `false` | `false`, a hop count (`1` behind one proxy that is the only way in), or addresses/subnets. Never `true`. See [Reverse proxy](reverse-proxy.md) |
| `LANESIGNAL_CORS_ORIGINS` | `corsOrigins` | Capacitor origins | Comma-separated. The defaults cover the Android app; add an origin only if another web origin hosts the UI |
| `LANESIGNAL_DATA_DIR` | | `/data` | Database, auth secret and setup code |
| `LANESIGNAL_CONFIG` | | `/config/lanesignal.json` | Optional JSON file |
| `LOG_LEVEL` | | `info` | `debug`, `info`, `warn` or `error`. Logs are JSON lines on stdout/stderr |

## Accounts and access

| Env var | JSON key | Default | Notes |
|---|---|---|---|
| `LANESIGNAL_AUTH_SECRET` | | generated | Signs sessions, at least 32 characters. Generated once into `/data/auth-secret` when unset. Changing it signs everyone out |
| `LANESIGNAL_SIGNIN_RATE_MAX` | | `5` | Sign-in attempts per client IP per window |
| `LANESIGNAL_SIGNIN_RATE_WINDOW` | | `60` | Window in seconds |
| `LANESIGNAL_SESSION_DAYS` | | `90` | Days a sign-in lasts without being used. Each use, at most daily, extends it |
| `LANESIGNAL_SKILL_FILE` | | bundled | Path of the agent skill served at `/api/skill` |
| `LANESIGNAL_TRMNL_DIR` | | bundled | Folder with the TRMNL plugin files (`integrations/trmnl`) served as `/api/projects/:id/trmnl/plugin.zip` |
| `LANESIGNAL_HUMAN_TOKENS` | `tokens[]` | | Optional static human tokens, `name:token,…` (16+ chars each), for break-glass and scripts. `LANESIGNAL_OVERSEER_TOKENS` is the old name and still works |
| `LANESIGNAL_AGENT_TOKENS` | `tokens[]` | | Optional static agent tokens. Prefer [agent keys](accounts.md#agent-keys) |

In the JSON file, `tokens` is a list of `{ "name", "role": "human" | "agent", "token" }`.

## Cloudflare Access

Only read with `LANESIGNAL_CLOUDFLARE_ACCESS=true`. See [Sign in with Cloudflare Access](cloudflare-access.md) for the Cloudflare side.

| Env var | Default | Notes |
|---|---|---|
| `LANESIGNAL_CF_ACCESS_TEAM_DOMAIN` | | Required: `myteam.cloudflareaccess.com`. The tokens' issuer, and where their signing keys are published |
| `LANESIGNAL_CF_ACCESS_AUD` | | Required: the Access application's Application Audience (AUD) tag; comma-separated for several |
| `LANESIGNAL_CF_ACCESS_CREATE_ACCOUNTS` | `false` | `true` gives every email Access lets in an account (not an admin) on first sign-in. Off, they need an account an admin added |
| `LANESIGNAL_ANDROID_CERT_SHA256` | | The Android app's signing-certificate SHA-256 fingerprints (comma-separated), served as `/.well-known/assetlinks.json` so the sign-in callback opens the app directly. Read whether or not the flag is on |

## Lanes and tickets

| Env var | JSON key | Default | Notes |
|---|---|---|---|
| `LANESIGNAL_GROUP_LABEL` | `groupLabel` | `Group` | What a group (one overseer session's lanes) is called in the app, e.g. `Train` |
| `LANESIGNAL_TICKET_TEMPLATES` | `ticketTemplates` | | `key=url-with-{id},…`, e.g. `redmine=https://redmine/issues/{id},gh=https://github.com/o/r/issues/{id}`. In JSON, an object |
| `LANESIGNAL_TICKET_DEFAULT` | `defaultTicketSystem` | first template | Used for plain refs like `1234` or `#1234`. System names are lower-case wherever they appear (`Redmine` configures `redmine`) |
| `LANESIGNAL_ATTACHMENT_MAX_MB` | | `5` | Largest file that can be attached to an escalation or a message (1–50) |
| `LANESIGNAL_ATTACHMENTS_PER_ITEM` | | `5` | Most files on one escalation or one message (1–20) |
| `LANESIGNAL_STALE_MINUTES` | `staleMinutes` | `30` | A lane that is `active`, `pending_ci` or `awaiting_agent` and hasn't published for this long is flagged stale. `0` turns this off |
| `LANESIGNAL_EVENT_RETENTION` | `eventRetention` | `200` | Routine activity lines kept per lane. Status changes and escalation history are always kept |

## Notifications

| Env var | JSON key | Default | Notes |
|---|---|---|---|
| `LANESIGNAL_NOTIFY_ON` | `notifyOn` | `escalation,notice` | Comma-separated: `escalation` (new questions, and FYIs that become blocking), `notice` (milestones overseers send with `notify_owner`), `blocked`, `completed`. A list set before notices existed (e.g. `escalation` alone) leaves them out: add `notice` |
| `LANESIGNAL_NTFY_URL` | `ntfyUrl` | | `https://ntfy.example.com/<topic>` |
| `LANESIGNAL_NTFY_TOKEN` | `ntfyToken` | | If your ntfy topic needs auth |
| `LANESIGNAL_NTFY_OPEN` | | `app` | What tapping an ntfy notification opens: `app`, the LaneSignal Android app (with an **Open in browser** button when `LANESIGNAL_PUBLIC_URL` is set), or `browser`, the web app at `LANESIGNAL_PUBLIC_URL` |
| `LANESIGNAL_FCM_SERVICE_ACCOUNT_FILE` | `fcmServiceAccountFile` | | Path to a Firebase service-account JSON, e.g. `/config/fcm-service-account.json` |

See [Android and push](android.md).

## TRMNL screen

| Env var | JSON key | Default | Notes |
|---|---|---|---|
| `LANESIGNAL_TRMNL_HOSTS` | | | Extra hosts a project's [TRMNL screen](trmnl.md) webhook may point at, comma-separated host names without a port (IPv6 in brackets), for a self-hosted TRMNL server. `trmnl.com` and `usetrmnl.com` (HTTPS only) are always allowed |
