# Development

```bash
npm ci
npm run dev:server        # API on :8080 with data in server/.data; the setup code is printed in the log
npm run dev:web           # Vite on :5173, proxying /api and /mcp to :8080
npm test                  # server tests (node:test): API, lifecycle, accounts, SSE, MCP, notifications
npm run typecheck && npm run build
```

To fill the UI with demo data, create an agent key in Settings, then:

```bash
LANESIGNAL_URL=http://localhost:8080 LANESIGNAL_TOKEN=ls_… node scripts/seed-demo.mjs
```

## Layout

| Path | What |
|---|---|
| `server/src/app.ts` | Express app: routes, SSE, CORS, error handling |
| `server/src/store.ts` | SQLite store and migrations for groups, lanes, escalations and activity |
| `server/src/accounts.ts` | Better Auth setup: accounts, sessions, agent keys, first-run setup |
| `server/src/auth.ts` | Resolves a bearer credential to a principal and role |
| `server/src/mcp.ts` | MCP tools |
| `server/src/notify.ts` | FCM and ntfy push |
| `server/src/types.ts` | API types, shared with the web client |
| `web/src/` | React app: `App.tsx` (layout, routing, filters), `escalations.tsx`, `components.tsx`, `live.ts` (snapshot + SSE), `login.tsx`, `settings.tsx` |
| `web/android/` | Capacitor Android project |
| `deploy/dockge/` | Example Dockge / Compose stack |

## CI

`.github/workflows/ci.yml` runs on pull requests and on pushes to `main`:

- **test:** typecheck, tests and build
- **docker:** builds the image, and pushes `ghcr.io/<owner>/lanesignal:main` and `:sha-<commit>` from `main`
- **android:** builds the debug APK, plus a signed release when the secrets exist
- **release:** publishes that APK to the Releases page from `main` (the rolling "latest" pre-release, only for main's current head) and from `v*` tags (`scripts/release-apk.sh`). It's the only job with write access

## Design notes

- **Adopt before building.** Agent Inbox and Kanbrawl were evaluated first, and Kanbrawl's architecture was reused. Better Auth was adopted for accounts. The README has the comparison.
- **Out of scope:** ticket sync, agent orchestration, analytics, deep hierarchies. LaneSignal shows state and collects decisions; Claude Remote Control stays the place for conversation.
