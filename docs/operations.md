# Operations

## What's in the data volume

| File | What it is |
|---|---|
| `lanesignal.db` (+ `-wal`, `-shm`) | SQLite in WAL mode: groups, lanes, escalations, activity, accounts, sessions, agent keys, push registrations |
| `auth-secret` | Signs sessions. Generated when `LANESIGNAL_AUTH_SECRET` is unset; losing it signs everyone out |
| `setup-code` | Exists only until the first account is created |
| `generated-tokens.json` | Only on installs from before accounts existed. Its tokens still work, alongside any configured ones |

## Upgrades

- **Dockge:** open the stack and click **Update**.
- **Compose:** `docker compose pull && docker compose up -d`.

Schema migrations run automatically at startup and are versioned, so restarts and upgrades keep your data. A database from a pre-release build that can't be upgraded is refused with a clear message, rather than half-working.

When upgrading from a version before accounts existed: your static tokens keep working, and the log shows a setup code for creating the first admin account.

## Backups

Back up the whole data directory with the container stopped, or use SQLite's online backup while it runs:

```bash
docker compose exec lanesignal sh -c "rm -f /tmp/backup.db && node --disable-warning=ExperimentalWarning -e \"
  new (require('node:sqlite').DatabaseSync)('/data/lanesignal.db').exec(\\\"VACUUM INTO '/tmp/backup.db'\\\");
\""
docker compose cp lanesignal:/tmp/backup.db ./lanesignal-$(date +%F).db
docker compose exec lanesignal rm -f /tmp/backup.db
```

The copy is written to `/tmp` inside the container, so it never ends up in the data volume or in later backups, and the command can be re-run.

Keep `auth-secret` with the backup if you don't set `LANESIGNAL_AUTH_SECRET`.

## Logs

The server logs one JSON object per line: requests (method, path, status, duration, who), startup, notifications and warnings. Nothing secret is logged: no tokens, no keys and no passwords. The only exception is the one-time setup code, which is logged until it's used.

```bash
docker compose logs -f lanesignal
docker compose logs lanesignal | grep '"level":"error"'
```

Set `LOG_LEVEL=debug` for more detail, such as why a credential was rejected.

## Health

`GET /healthz` returns `{"ok":true}` when the database answers. The image's `HEALTHCHECK` calls it every 30s, so Docker and Dockge show *healthy* or *unhealthy*.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| The app says "Token rejected" | The session expired or was revoked (password changed elsewhere, removed, banned). Sign in again |
| The connection dot stays grey, or turns red ("offline") | The proxy is buffering or timing out `/api/events`. See [Reverse proxy](reverse-proxy.md) |
| Agents' `wait_seconds: 300` calls fail after about 60s | The proxy read timeout is too low. Set it to 310s, or use shorter waits |
| "Too many requests" on sign-in | 5 attempts per minute per IP by default. Behind a proxy, set `LANESIGNAL_TRUST_PROXY` (usually `1`) or everyone shares the proxy's IP ([details](reverse-proxy.md#three-settings-to-get-right)) |
| Container exits with "LANESIGNAL_TRUST_PROXY must be …" | Use `false`, a hop count like `1`, or addresses/subnets |
| Container exits with "… must be an integer between …" | An invalid number in the config. The message names the variable |
| Container exits with `unable to open database file` on a bind mount | The container runs as uid 1000: `sudo chown 1000:1000 ./data` |
| Image pull is denied from GHCR | The package is private. Run `docker login ghcr.io` or make it public ([details](install-dockge.md#1-make-the-image-pullable)) |
| No push notifications | Check the Push line in Settings. ntfy needs `LANESIGNAL_NTFY_URL`. FCM needs both the server key and an APK built with `GOOGLE_SERVICES_JSON` |
