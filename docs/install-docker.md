# Install with Docker Compose

## Using the published image

The Dockge stack is plain Compose, so it works anywhere:

```bash
mkdir -p ~/lanesignal && cd ~/lanesignal
curl -fsSLO https://raw.githubusercontent.com/samuelzamvil/LaneSignal/main/deploy/dockge/compose.yaml
curl -fsSL https://raw.githubusercontent.com/samuelzamvil/LaneSignal/main/deploy/dockge/.env.example -o .env
$EDITOR .env
docker compose up -d
docker compose logs lanesignal | grep setupCode     # one-time code for the admin account
```

If the GHCR package is private, run `docker login ghcr.io` first (see [Install with Dockge](install-dockge.md#1-make-the-image-pullable)).

## Building from source

The repository's [`docker-compose.yml`](../docker-compose.yml) builds the image locally. It binds to `127.0.0.1` only, expecting a reverse proxy on the host, so `LANESIGNAL_TRUST_PROXY` defaults to `1`. Set it to `false` in `.env` if you expose the port another way.

```bash
git clone https://github.com/samuelzamvil/LaneSignal && cd LaneSignal
cp .env.example .env && $EDITOR .env
docker compose up -d --build
curl localhost:8080/healthz          # {"ok":true}
docker compose logs lanesignal | grep setupCode
```

It also mounts `./config` read-only at `/config`. That's where the optional `config/lanesignal.json` (see [`config/lanesignal.example.json`](../config/lanesignal.example.json)) and an FCM service-account key go.

If Docker Hub rate-limits the build, use a mirror for the base image:

```bash
docker compose build --build-arg NODE_IMAGE=mirror.gcr.io/library/node:22-bookworm-slim
```

## Without Docker

You need Node.js 22.13 or later (`node:sqlite` is built in):

```bash
npm ci && npm run build
LANESIGNAL_DATA_DIR=$PWD/data PORT=8080 npm start -w server     # data/ is git-ignored
```

The server serves the compiled web app from `web/dist`.

## Next

1. Create the admin account with the setup code: [accounts](accounts.md).
2. Put HTTPS in front: [reverse proxy](reverse-proxy.md).
3. Connect your overseers: [agents](agents.md).
