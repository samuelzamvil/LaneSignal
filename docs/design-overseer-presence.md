# Design: overseer presence

Status: accepted, being built in five pull requests (below).

## Goal

A person looking at a group should be able to see whether its overseer is connected right now, and so whether a message or an answer reaches it at once. Today only lanes show **agent waiting**, and only while a wait holds them:

- A group wait with nothing open marks no lane, so an idle overseer, the common case, looks absent.
- Questions raised on an epic live on its internal lane, which the app can't look up, so they always say "No agent is waiting".
- Waits are attributed to keys, and keys can be shared by several sessions.
- The skill's background wait exits on every event, so a busy overseer drops out between waits.

## Decisions

- **Presence is per session**, not per key. A session is named by the client (`session`), once per agent session, and reused when it reconnects.
- **Only the group's overseer counts**: the key that last registered the group with `update_group`. Workers don't touch groups. Several sessions on that key are tracked separately. When another key takes the group over, the previous overseer's sessions end at once.
- **Two transports, one record.** A WebSocket (`GET /api/agent/socket`, the new path) and today's waits (`wait_for_decisions` with `group_id`, `GET /api/wait?group=`, the fallback) both register sessions in the same presence record. MCP is otherwise unchanged; the waits gain an optional `session`.
- **Offline means the connection or heartbeat is gone.** The socket's heartbeat is protocol ping/pong. A wait's connection is open while it waits.
- **Timers** (both transports):
  - when a session's last connection ends, it stays **listening** for `LANESIGNAL_PRESENCE_QUIET_SECONDS` (default 60), so an ordinary re-wait or reconnect doesn't flicker;
  - then **reconnecting**, until `LANESIGNAL_PRESENCE_OFFLINE_MINUTES` (default 10) after the connection ended;
  - then **disconnected**.
  Lanes' **agent waiting** uses the same quiet window (it was a fixed 30 seconds).
- **Not responding**: a socket session whose relay reports that nothing is reading its events (no Monitor armed) for longer than the offline window.
- **Client: a relay.** A small Node script (built-ins only) holds the socket for the whole agent session, reconnects by itself and sends `LANESIGNAL_KEY` from its environment as a header, so the key never enters the conversation. Claude Code's Monitor tool follows the relay's local output and wakes the agent per item. The relay exits when the process that started it is gone, or after `LANESIGNAL_RELAY_IDLE_MINUTES` (default 30) with nothing reading its events.
- **No connection tickets** in this version. They're only needed if Monitor holds the socket directly, which needs no Node but puts the credential in the transcript.
- **One auth path.** HTTP middleware and the socket upgrade use the same `authenticate()`. The socket refuses a Cloudflare Access identity on its own (browsers attach the Access cookie to cross-site upgrades) and requires an agent credential.
- **Disconnect alerts are opt-in**: `disconnected` in `LANESIGNAL_NOTIFY_ON`, sent quietly, only when the group has questions waiting on a person.

## States

| State | Meaning | Shown as |
|---|---|---|
| `listening` | A session is connected (socket or wait), or its connection ended less than the quiet window ago | ● listening |
| `not_responding` | A socket session is connected, but nothing has read its events for longer than the offline window | ■ not responding |
| `reconnecting` | The last connection ended more than the quiet window ago, less than the offline window ago | ◌ reconnecting |
| `disconnected` | No session is connected or reconnecting. `since` is when the last one went, null when none has connected since the server started | ┆ disconnected |

A group's state is its best session's: `listening` › `not_responding` › `reconnecting` › `disconnected`. Presence is kept in memory, like lanes' **agent waiting**: after a restart every group is `disconnected` (since null) until its overseer reconnects, which the quiet window hides for agents that reconnect promptly.

## Pull requests

Each one is reviewed adversarially and fixed before it merges, and CI on `main` is checked after.

### 1. Shared authentication

- `server/src/auth.ts`: move the body of `require()` into `authenticate(req: IncomingMessage, opts)` that works on a plain Node request (parses `req.url` itself, no `req.query`/`req.originalUrl`) and returns `{ principal, stillValid, watchRevocation }` or `{ status, error }`. `require()` becomes a thin Express wrapper; every HTTP behaviour stays as it is (the `access_token` query parameter still only on `/api/events`).
- Options the socket will need: `roles`, `credentialRequired` (refuse an Access-only identity), `tokenSources` (header, `lanesignal.bearer.<credential>` subprotocol, `access_token` query) for a given path.
- Tests: the existing suites unchanged; unit tests that call `authenticate()` with a raw `IncomingMessage` (header, subprotocol, query, Access-only refused when a credential is required, roles).
- This design document.

### 2. Presence over the existing waits

- `server/src/presence.ts`: the session record per group (`Map<groupId, Map<sessionId, Session>>`), with the timers above, `attach(group, session, owner, transport)` returning a release function, `setArmed()`, `endOwner(group, keepOwner)` (takeover), and a change callback. The store owns one and emits a `group` event when a group's state or sessions change.
- `Group.presence`: `{ state, since, sessions: { id, transport: 'socket' | 'wait', state, since }[] }` in `server/src/types.ts` and `web/src/api.ts`. Session ids that are http(s) URLs (a Remote Control link) are shown as links.
- `waitForDecisions`: with a `groupId` and a writer whose key is the group's overseer (`viewerKey` equals the group's owner), attach a `wait` session for the wait's duration. Its id is the `session` argument, or `wait:<key name>` without one.
- `session` (optional, up to 512 characters) on `wait_for_decisions` (MCP) and `GET /api/wait`.
- `update_group` by another key ends the previous overseer's sessions.
- Config: `LANESIGNAL_PRESENCE_QUIET_SECONDS` (60), `LANESIGNAL_PRESENCE_OFFLINE_MINUTES` (10); the store's wait grace for lanes comes from the quiet window. Tests keep short timers through store options.
- Web: a presence chip in the group header (`GroupHeader`, `web/src/epic-views.tsx`); a line under the group conversation's box ("The overseer is listening: it gets this now" / "It gets this when it reconnects"); `AgentPresence` on a question with no listed lane (an epic's) uses its group's presence.
- Docs: `concepts.md` (groups), `agents.md` (waiting), `api.md` (`Group.presence`, `session`), `configuration.md`.
- Tests: an idle group wait shows listening; quiet window, reconnecting, disconnected; two sessions on one key; a non-overseer key's wait and an observer's don't count; takeover ends sessions; the `group` events.

### 3. The WebSocket endpoint

- Dependency: `ws` (server).
- `server/src/socket.ts`: `createApp` exposes an upgrade handler (`app.locals.upgrade`), attached to the HTTP server in `index.ts` and the test helper. Path `/api/agent/socket?group=G&session=S[&project=P][&since=T]`; 404 when answering in LaneSignal is off.
- Auth through `authenticate()`: an agent key (not observer, not human, not an Access identity alone), from the `Authorization` header, a `lanesignal.bearer.<credential>` subprotocol, or `access_token`. When the client offers `lanesignal.v1`, the server echoes it (a client drops the connection if the server doesn't echo one of its protocols). Refused with an HTTP status before upgrading: 401, 403 (not the group's overseer, wrong role), 404 (unknown group).
- Messages, server to client, one JSON object per text frame:
  - `{ "type": "hello", "group", "session", "checkedAt" }` once;
  - `{ "type": "items", "items": [...], "counts", "checkedAt" }` with the same digest items `wait_for_decisions` returns. On connect it sends what's pending (from `since`); then each item once per connection as it appears. Acknowledging stays on MCP (`acknowledge_escalation`, `ack`). Group notes handed over are marked delivered, as waits do.
- Client to server: `{ "type": "armed", "armed": boolean }` from the relay. A session that never sends it counts as armed.
- Heartbeat: a ping every `LANESIGNAL_AGENT_PING_SECONDS` (20); the server closes after `LANESIGNAL_AGENT_MISSED_PINGS` (2) without a pong. Each ping also re-checks the credential.
- Closes: 4401 credential revoked, 4409 group taken over by another overseer, 4404 group removed, 1012 server shutting down (`index.ts` closes every socket in `shutdown()`: `closeAllConnections()` doesn't reach upgraded sockets).
- Docs: `api.md`, `agents.md`, `configuration.md`, and `reverse-proxy.md`: nginx needs `proxy_set_header Upgrade $http_upgrade;` and `proxy_set_header Connection "upgrade";`.
- Tests: auth by each source; observer, human, Access-only and non-overseer keys refused; pending items on connect and new ones as they come; each item once per connection; a client that stops answering pings is dropped; reconnect inside the quiet window shows no change; armed=false leads to not responding; takeover, revocation and shutdown close codes.

### 4. The relay and the skill

- `skills/lanesignal/relay.mjs`, Node 22.13+ built-ins only (the global `WebSocket`, which takes a `headers` option):
  - `node relay.mjs serve`: holds the socket (`LANESIGNAL_URL`, `LANESIGNAL_KEY`, `LANESIGNAL_GROUP`, `LANESIGNAL_PROJECT`, `LANESIGNAL_SESSION`), reconnects with backoff, appends each item as one line to `.claude/lanesignal/events.jsonl`, keeps the last `checkedAt` to reconnect from, and reports `armed` from whether a follower is running. Exits when its parent process is gone or after `LANESIGNAL_RELAY_IDLE_MINUTES` with no follower. One relay per session: a second `serve` exits if one is running.
  - `node relay.mjs follow`: the Monitor command. Prints lines from where the last follower stopped (a saved offset), so nothing is skipped between Monitor watches, and records that a follower is running.
- Served by the server like the skill (`/api/skill/relay.mjs`) and shipped in the plugin.
- `skills/lanesignal/decisions.md`: "Staying connected" (start the relay once, arm Monitor with `follow`, re-arm on expiry without investigating, handle and acknowledge items as today) with the background wait kept as the fallback for clients without Monitor or Node.
- Docs: `agents.md`.
- Tests: the relay against a test server: items reach `events.jsonl`, `follow` prints from its offset, a stopped follower reports armed=false, a dropped socket reconnects, a second `serve` exits.

### 5. Disconnect alerts

- `disconnected` in `LANESIGNAL_NOTIFY_ON` (off by default): when a group goes `disconnected` while it has questions waiting on a person, a quiet push ("Acme's overseer disconnected · 2 decisions waiting") that opens the group. Not sent for groups that were already disconnected at startup.
- Docs: `configuration.md`, `concepts.md` (notifications).
- Tests in `notify.test.ts`.
