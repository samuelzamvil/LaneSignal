# Design: overseer presence

Status: accepted. It's built in five pull requests, listed below.

## Goal

When a person looks at a group, they should be able to see whether its overseer is connected right now. That tells them whether a message or an answer will reach it at once.

Today only lanes show **agent waiting**, and only while a wait holds them. That leaves four gaps:

- **An idle overseer looks absent.** A group wait with nothing open marks no lane, and this is the most common case.
- **Epic questions always say nobody is waiting.** They live on the epic's internal lane, which the app can't look up, so they always say "No agent is waiting".
- **Waits are attributed to keys,** and several sessions can share one key.
- **A busy overseer drops out between waits.** The skill's background wait exits on every event.

## Decisions

- **Presence is per session, not per key.** The agent names its session (`session`) once per agent session, and reuses that name when it reconnects. Internally a session is keyed by the overseer's full key and its name, so the same name under two accounts never collides.

- **Only the group's overseer counts.** That's the key in the `groups.owner` column: the key that last registered the group with `update_group` or `PUT /api/groups/:id`. `Store.groupOwner(id)` reads it. `Group.overseer` is only the key's name, so it isn't used for this.
  - **Groups with no owner** count any agent key. These are groups created by publishing a lane, and groups from before v23. This matches who may acknowledge their messages.
  - **Workers don't touch groups.**
  - **Several sessions on one key** are tracked separately.
  - **Takeover:** when another key takes the group over, the previous overseer's sessions end at once.

- **Two transports, one record.** Both register sessions in the same presence record:
  - **The new path:** a WebSocket at `GET /api/agent/socket`.
  - **The fallback:** today's waits, `wait_for_decisions` with `group_id` and `GET /api/wait?group=`.

  MCP is otherwise unchanged. `wait_for_decisions` and `/api/wait` gain an optional `session`.

- **Offline means the connection or heartbeat is gone.**
  - **On the socket,** the server sends protocol pings, which the client's WebSocket stack answers by itself. It also sends application `ping` frames, so the relay can detect a dead server.
  - **On a wait,** the session is connected while the wait is open. Every wait call touches its session, including one that returns at once.

- **Timers.** These apply to both transports.
  - When a session's last connection ends, it stays **listening** for `LANESIGNAL_PRESENCE_QUIET_SECONDS` (default 60). That way an ordinary re-wait or reconnect doesn't flicker.
  - After that it shows **reconnecting**, until `LANESIGNAL_PRESENCE_OFFLINE_MINUTES` (default 10) after the connection ended.
  - Then it shows **disconnected**, and the session's record is dropped. The group keeps the time in `since`.
  - The quiet window must be shorter than the offline window, or the configuration is refused.
  - Lanes' **agent waiting** uses the same quiet window (it was a fixed 30 seconds).

- **Lanes while the overseer is on the socket.** While a socket session is listening, it holds **agent waiting** on its group's lanes the way a group wait does: the lanes with open questions, plus lanes that get one later. This keeps lane chips, "An agent is waiting for this answer" and the stale check working for overseers that no longer run waits.

- **Not responding.** A socket session whose relay reports that nothing is reading its events (no Monitor armed) for longer than the offline window.

- **Client: a relay.** A small Node script, using built-ins only, holds the socket for the whole agent session.
  - **Credential:** it sends `LANESIGNAL_KEY` from its environment as a header, so the key never enters the conversation.
  - **Delivery:** Claude Code's Monitor tool follows the relay's local output and wakes the agent for each item.
  - **When it exits:** when the process passed as `--parent` is gone, or after `LANESIGNAL_RELAY_IDLE_MINUTES` (default 30) with nothing reading its events.

- **The socket takes its credential from the `Authorization` header only.**
  - The only client is the relay, which sends headers.
  - A key in the URL ends up in proxy access logs, and a key in `Sec-WebSocket-Protocol` would too.
  - Monitor holding the socket directly would need short-lived connection tickets. That isn't in this version.

- **One auth path.** HTTP middleware and the socket upgrade use the same `authenticate()`.
  - The socket requires an agent credential.
  - It refuses a Cloudflare Access identity on its own, because browsers attach the Access cookie to cross-site upgrades.

- **Delivery over the socket doesn't mark group notes as handed over.**
  - "Sent to the relay" doesn't mean the agent read it.
  - A note sent over the socket still wakes a fallback wait, and still comes back until acknowledged, as now.

- **Disconnect alerts are opt-in.** They're on when `disconnected` is in `LANESIGNAL_NOTIFY_ON`.
  - They're sent quietly, and only when the group has questions waiting on a person.
  - They're never sent for a takeover.

- **With answering in LaneSignal off** (`LANESIGNAL_DECISIONS=false`), waits and the socket don't exist. Groups then carry no presence, and the app shows no chip.

## States

| State | Meaning | Shown as |
|---|---|---|
| `listening` | A session is connected (socket or wait), or its connection ended less than the quiet window ago | ● listening |
| `not_responding` | A socket session is connected, but nothing has read its events for longer than the offline window | ■ not responding |
| `reconnecting` | The last connection ended more than the quiet window ago and less than the offline window ago | ◌ reconnecting |
| `disconnected` | No session is connected or reconnecting. `since` is when the last one went, or null when none has connected since the server started | ┆ disconnected |

A group takes the state of its best session, in this order: `listening`, then `not_responding`, then `reconnecting`, then `disconnected`.

Presence is kept in memory, like lanes' **agent waiting**. After a restart every group is `disconnected` (with `since` null) until its overseer reconnects. Agents that reconnect promptly come back within the quiet window, so the restart barely shows.

A group's sessions are capped at 20. When a new one would go over the cap, the session that ended longest ago is dropped. When every session is connected, the new one isn't tracked (its wait still works), so live sessions never push each other out.

## Socket close codes

The server accepts the upgrade from any agent key, then closes with an application code when it refuses or ends a session. Node's WebSocket client can't see an HTTP status on a refused upgrade, so the codes carry the reason. WebSocket upgrades on any other path are answered with 404, and their socket is destroyed. Other upgrades (`h2c`) are served as plain requests.

| Code | Meaning | Relay |
|---|---|---|
| 4400 | The query is malformed (a client bug) | Writes a final line, exits |
| 4401 | Not authorized, or the credential was revoked | Writes a final line, exits |
| 4403 | Not the group's overseer, or the wrong role | Writes a final line, exits |
| 4404 | Unknown or removed group | Writes a final line, exits |
| 4409 | Another overseer took the group over | Writes a final line, exits |
| 4100 | The key's access changed (projects) | Reconnects at once |
| 1012 | The server is restarting | Reconnects |
| 1006, other | The connection was lost | Reconnects with backoff. After 10 minutes of failures, writes a line saying so (so the agent falls back to the background wait) and exits |

## Pull requests

Each one is reviewed adversarially and fixed before it merges, and CI on `main` is checked after. Each one leaves `main` working on its own.

### 1. Shared authentication

- **The refactor** (`server/src/auth.ts`):
  - Move the body of `require()` into `authenticate(req: IncomingMessage, opts)`. It works on a plain Node request: it parses `req.url` itself instead of using `req.query` or `req.originalUrl`.
  - It returns `{ principal, stillValid, watchRevocation }`, or `{ status, error }`.
  - `require()` becomes a thin Express wrapper, and every HTTP behaviour stays as it is. For example, the `access_token` query parameter is still accepted only on `/api/events`.
  - Options: `roles`, and `credentialRequired`, which refuses an identity from Cloudflare Access alone. The socket needs both.
- **Tests:** the existing suites pass unchanged. New unit tests call `authenticate()` with a raw `IncomingMessage`:
  - a header credential;
  - the query token, accepted only on `/api/events`;
  - an Access-only identity, refused when a credential is required;
  - roles;
  - revocation.
- **Docs:** this design document.

### 2. Presence over the existing waits

- **The presence record** (`server/src/presence.ts`):
  - One record per group, holding its sessions, keyed by owner key and session name.
  - `attach(group, owner, session, transport)` returns a release function. It counts connections per attach, using a per-attach token, so a release is a no-op once its session has ended.
  - `touch(...)`, for a wait that returns at once. It starts the quiet window.
  - `setArmed(...)`, used in PR 3.
  - `endOwner(group, newOwner)`, for a takeover.
  - `remove(group)`.
  - The timers above, cleared by `close()`.
  - The cap and pruning above.
  - A change callback that reports the group-level transition `{ from, to, reason }`.
- **The store:**
  - It owns one presence record.
  - It emits `{ type: 'group', group, presence: { from, to, reason } }` when a group's state changes, and a plain `group` event when only its session list changes.
  - It removes a group's presence on `group_deleted`.
  - `Store.close()` also closes presence.
  - Timer callbacks tolerate a closing database, as `emitLaneIfShown` does.
- **`Group.presence`** in `server/src/types.ts` and `web/src/api.ts`:
  - Its shape: `{ state, since, sessions: { id, transport: 'socket' | 'wait', state, since }[] }`.
  - It's absent when decisions are off.
  - Session ids that are http(s) URLs, such as a Remote Control link, are shown as links.
- **Waits:**
  - A single helper, `presenceForWait`, is called by the MCP tool (`mcp.ts`) and `GET /api/wait` (`app.ts`) before they check whether the result is ready.
  - It applies to a wait with a group from a writer whose key is the group's overseer, or any agent key for a group with no owner.
  - It touches the session, then holds it for as long as the wait waits.
  - Its id is `session`, or `wait:<key name>` without one.
  - `get_updates` doesn't count.
- **`session`:**
  - Up to 512 characters.
  - Added to the strict `waitQuery` schema, `session=`.
  - Added to `wait_for_decisions` only, not to the input shared with `get_updates`.
- **Takeover:** `upsertGroup` compares the owner before and after its transaction, and calls `presence.endOwner` after it commits. That covers both MCP `update_group` and `PUT /api/groups/:id`. Ended sessions go straight to `disconnected`, with reason `taken_over`.
- **Config:**
  - `LANESIGNAL_PRESENCE_QUIET_SECONDS` (60) and `LANESIGNAL_PRESENCE_OFFLINE_MINUTES` (10), validated as quiet < offline.
  - The store's lane wait grace comes from the quiet window.
  - Tests keep short timers through store options.
- **Web:**
  - A presence chip in the group header (`GroupHeader`, `web/src/epic-views.tsx`).
  - A line under the group conversation's box: "The overseer is listening: it gets this now", or "It gets this when it reconnects".
  - `AgentPresence`, on a question with no listed lane (an epic's), uses its group's presence.
  - Nothing is shown when presence is absent.
- **Docs:**
  - `concepts.md` (groups, and the "agent waiting" grace),
  - `agents.md` (waiting, `session`),
  - `api.md` (`Group.presence`, `session`),
  - `configuration.md`.
- **Tests.** They register groups with `PUT /api/groups/:id` first.
  - An idle group wait shows listening.
  - A wait that returns ready at once still touches its session.
  - The quiet window, then reconnecting, then disconnected.
  - Two sessions on one key.
  - The same session name under two keys.
  - A non-overseer key's wait doesn't count, and neither does an observer's.
  - A no-owner group counts an agent key.
  - Takeover ends sessions, and a stale release after it is a no-op.
  - The cap.
  - `group` events and their `presence` transition.
  - Presence is absent with decisions off.
  - Timers stop on close.

### 3. The WebSocket endpoint

- **Dependencies:** `ws`, and `@types/ws` as a dev dependency (the server is type-checked strictly).
- **The endpoint** (`server/src/socket.ts`):
  - `createApp` exposes an upgrade handler (`app.locals.upgrade`). It's attached to the HTTP server in `index.ts` and in the test helper.
  - Path: `/api/agent/socket?group=G&session=S[&project=P][&since=T]`.
  - It's absent (404) when answering in LaneSignal is off.
  - Any other WebSocket upgrade path gets 404 and a destroyed socket. Non-WebSocket upgrades (`Upgrade: h2c`) go back to the app as plain requests.
- **Auth:**
  - Through `authenticate()`, with `Authorization` only.
  - It must be an agent key. Observer keys, human credentials and an Access identity alone are refused.
  - Refusals happen after the upgrade, with the close codes above.
- **Server to client** (one JSON object per text frame):
  - `{ "type": "hello", "group", "session", "checkedAt", "pingSeconds", "missedPings" }`, once. The relay takes the server for dead after `pingSeconds × missedPings` without a frame.
  - `{ "type": "items", "items": [...], "counts", "checkedAt" }`. These are the digest items `wait_for_decisions` returns.
    - On connect it sends what's pending, from `since`.
    - After that it sends each item once per connection as it appears. Kinds listed until handled (decisions, replies, notes) are remembered per connection: a reply by the owner's last message, so the same words again are a new reply. Kinds reported once per `since` (`closed`, `lane_removed`, `ticket_moved`, `reopen_*`) aren't, so they come each time they happen.
    - Acknowledging stays on MCP (`acknowledge_escalation`, `ack`).
    - Notes aren't marked as handed over (see Decisions).
  - `{ "type": "ping" }` every `LANESIGNAL_AGENT_PING_SECONDS` (default 20). The relay reconnects after two intervals without any frame.
- **Client to server:** `{ "type": "armed", "armed": boolean }`, from the relay, right after every connect and on each change. Armed is per connection: a new socket resets the session to armed. A connection that never sends it counts as armed.
- **Heartbeat:**
  - A protocol ping every `LANESIGNAL_AGENT_PING_SECONDS`.
  - The server closes the socket after `LANESIGNAL_AGENT_MISSED_PINGS` (default 2) without a pong.
  - Each ping also re-checks the credential.
- **Presence:**
  - The connection is attached as a `socket` session.
  - While it's listening, it holds its group's lanes (see Decisions).
  - When it closes, the session is released.
- **Closes:**
  - On revocation (4401) and takeover (4409), and when the group is removed (4404).
  - On a membership change (4100), as `/api/events` does, so access is worked out again.
  - On shutdown (1012). `index.ts` closes every socket in `shutdown()`, because `closeAllConnections()` doesn't reach upgraded sockets.
- **Docs:**
  - `api.md`, `agents.md`, `configuration.md`.
  - `reverse-proxy.md`: nginx needs the standard upgrade mapping, `map $http_upgrade $connection_upgrade { default upgrade; '' close; }`, with `proxy_set_header Upgrade $http_upgrade;` and `proxy_set_header Connection $connection_upgrade;`.
  - `cloudflare-access.md`: the socket path needs the same way through Access as `/mcp`.
- **Tests:**
  - The header credential.
  - Observer, human and non-overseer keys refused with their close codes, and an unknown group too.
  - Pending items on connect, then new ones as they come, each once per connection.
  - `ping` frames.
  - A client that stops answering pings is dropped.
  - A reconnect inside the quiet window shows no change.
  - `armed: false` leads to not responding.
  - Lanes held while listening.
  - The takeover, revocation, membership and shutdown close codes.
  - A wrong upgrade path gets 404.

### 4. The relay and the skill

- **The relay** (`skills/lanesignal/relay.mjs`): Node 22.13+ built-ins only, using the global `WebSocket` with its `headers` option.
  - **`node relay.mjs serve --session <id> --parent <pid>`**
    - It reads `LANESIGNAL_URL`, `LANESIGNAL_KEY`, `LANESIGNAL_GROUP` and `LANESIGNAL_PROJECT`, plus optional `LANESIGNAL_CF_ACCESS_CLIENT_ID` and `LANESIGNAL_CF_ACCESS_CLIENT_SECRET`, which it sends as Access service-token headers.
    - It keeps its state under `.claude/lanesignal/<group>/<hash of session>/`: `events.jsonl`, the follower's offset, the follower's pid, its last `checkedAt` and its own pid.
    - It appends each item as one line, and reconnects from its `checkedAt`.
    - It handles the close codes as tabled above.
    - It reconnects after two ping intervals without a frame.
    - It reports `armed` whenever that changes.
    - It exits when `--parent` is gone, or after the idle timeout.
    - Only one `serve` runs per state folder: a second one exits if the first one's pid is alive.
  - **`node relay.mjs follow --session <id>`**: the Monitor command.
    - It records its pid. The newest follower wins and an older one exits. The relay checks the pid with `process.kill(pid, 0)`.
    - It prints lines from the saved offset, then waits for new ones.
    - It saves the offset only after a line is written out (at least once: acknowledging goes through MCP, so a repeated item is harmless).
- **How the agent starts it:** the skill tells the agent to start `serve` with `--parent $PPID` from its shell, which is the agent's own process. For `--session`, the agent uses its Remote Control URL, or else an id it generates once and keeps for the session.
- **Shipping:**
  - The server serves it from the skill folder at the fixed route `/api/skill/relay.mjs`, as JavaScript.
  - `scripts/build-plugin-skill.mjs` also copies it into the plugin (and checks it with `--check`), the plugin test compares it, and the plugin's version goes up.
- **The skill** (`skills/lanesignal/decisions.md`): a new "Staying connected" section.
  - Get `relay.mjs`. Use the one next to this skill (plugin), or else download it from `/api/skill/relay.mjs`.
  - Start it once, arm Monitor with `follow`, and re-arm on expiry without investigating.
  - Handle and acknowledge items as today.
  - **Fall back to the background wait** without Monitor or Node, when the relay reports it can't connect (for example through an HTTPS proxy, which Node's WebSocket doesn't use), or on a server without the socket. The fallback loop sends `session` only when `LANESIGNAL_SESSION` is set, so it keeps working against older servers.
- **Docs:** `agents.md`.
- **Tests:** the relay run against a test server.
  - Items reach `events.jsonl`.
  - `follow` prints from its offset.
  - A stopped follower reports `armed: false`.
  - A dropped socket reconnects.
  - A terminal close code writes a final line and exits.
  - A second `serve` exits.
  - The served route, and the plugin copy check.

### 5. Disconnect alerts

- **What's sent:** `disconnected` in `LANESIGNAL_NOTIFY_ON` (off by default; it's added to the setting's allowed values in `config.ts`). When a `group` event reports a transition to `disconnected`, other than for a takeover, while the group has questions waiting on a person, a quiet push goes out: "Acme's overseer disconnected · 2 decisions waiting". It opens the group. Nothing is sent at startup.
- **Docs:** `configuration.md`, and `concepts.md` (notifications).
- **Tests** (`notify.test.ts`):
  - It's sent only on the transition.
  - Not on other `group` events.
  - Not for a takeover.
  - Not without waiting questions.
  - Not when the setting is off.
