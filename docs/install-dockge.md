# Install with Dockge

[Dockge](https://github.com/louislam/dockge) manages Compose stacks from a web UI and keeps each one in `/opt/stacks/<name>/`. LaneSignal ships a ready-made stack in [`deploy/dockge/`](../deploy/dockge/).

## 1. Make the image pullable

CI publishes `ghcr.io/samuelzamvil/lanesignal:main` on every merge to `main`. New GHCR packages are private, so do **one** of these:

- **Make it public:** GitHub → your profile → *Packages* → `lanesignal` → *Package settings* → *Change visibility*.
- **Keep it private:** log the Docker host in once:

  ```bash
  echo "$GITHUB_PAT" | docker login ghcr.io -u <github-user> --password-stdin   # PAT with read:packages
  ```

## 2. Create the stack

1. In Dockge, click **+ Compose** and name the stack `lanesignal`.
2. Paste [`deploy/dockge/compose.yaml`](../deploy/dockge/compose.yaml) into the compose editor.
3. Paste [`deploy/dockge/.env.example`](../deploy/dockge/.env.example) into the **.env** editor below it, and adjust it:
   - `LANESIGNAL_PUBLIC_URL`: the URL people and phones will use.
   - `LANESIGNAL_TRUST_PROXY`: leave it at `false` while people connect straight to the port. Set it to `1` only once a reverse proxy is the only way in. See [Reverse proxy](reverse-proxy.md).
   - `LANESIGNAL_TICKET_TEMPLATES`: how ticket references become links.
   - `LANESIGNAL_NTFY_URL`: optional, for push to the ntfy app.
4. Click **Deploy**. The status turns *healthy* after a few seconds. The image has its own `/healthz` health check.

## 3. Create the admin account

On first start the server has no accounts. It prints a one-time **setup code** in the stack's log (a line containing `setupCode`) and also writes it to `/data/setup-code` inside the container.

1. In Dockge, open the stack and look at the log for `setupCode`. Or open a shell in the container (Dockge's container terminal) and run `cat /data/setup-code`. From a host shell in the stack folder, the command is `docker compose exec lanesignal cat /data/setup-code`.
2. Open LaneSignal (`http://<host>:8080`, or your public URL). It shows **Create admin account**.
3. Enter the setup code, your name, email and a password of 10 or more characters.

The code is deleted once the account exists. Then continue with [accounts and agent keys](accounts.md).

## Choices in the stack file

| Setting | Default | Change it when |
|---|---|---|
| `image` | `:main` (latest merge) | You want to pin a build: use `:sha-<commit>` from the package page |
| `ports` | `8080:8080` on all interfaces | A proxy installed on the host (Caddy, nginx, `tailscale serve`) fronts it: use `127.0.0.1:8080:8080` and `LANESIGNAL_TRUST_PROXY=1`. Containerised proxies use the network option below instead |
| `volumes` | Named volume `lanesignal-data` | You want the files in the stack folder: use `./data:/data` after `mkdir data && sudo chown 1000:1000 data`. The container runs as uid 1000, so a root-owned folder won't work |
| `LANESIGNAL_DECISIONS` | `false` | You want to answer on the dashboard too, with agents waiting for the answer. Off, you answer in the agent's session and it dismisses the alert. Set it in the `.env` editor; see [Features](configuration.md#features) |
| `LANESIGNAL_REQUIREMENTS` | `true` | You don't want the requirements register: `false` removes its tools, page and export |
| Proxy network | Commented out | Your reverse proxy (Nginx Proxy Manager, Traefik, Caddy) runs in Docker. Uncomment the `networks` lines with the proxy's network name, remove `ports:`, set `LANESIGNAL_TRUST_PROXY=1`, and point the proxy at `http://lanesignal:8080` |

## Updating

In Dockge, open the stack and click **Update** (pull and recreate). Data and accounts live in the volume, and migrations run on start. See [Operations](operations.md) for backups first.
