# Connecting agents (MCP)

Agents talk to LaneSignal over MCP: a stateless Streamable HTTP endpoint at `POST /mcp`. Plain HTTP works too; see the [HTTP API](api.md).

## 1. Create a key

In LaneSignal, go to **Settings → Keys** and create one **agent key** per overseer, named after it (e.g. `payments-overseer`). That name is shown as the agent on its lanes. See [Agent keys](accounts.md#agent-keys).

To answer escalations from your own Claude session, create a **personal key** there instead and add it the same way. It acts as you: it gets `decide_escalation`, and decisions show your name.

## 2. Add the MCP server

### Claude Code

```bash
claude mcp add --transport http lanesignal https://lanesignal.example.com/mcp \
  --header "Authorization: Bearer ls_…"
```

Settings shows this command with your key already filled in. It registers the server for you only (local scope).

To share the server through the repository's `.mcp.json`, don't add `--scope project` to that command, because it would write the key itself into a committed file. Write `.mcp.json` with an environment variable instead, and set `LANESIGNAL_KEY` on each machine:

```json
{
  "mcpServers": {
    "lanesignal": {
      "type": "http",
      "url": "https://lanesignal.example.com/mcp",
      "headers": { "Authorization": "Bearer ${LANESIGNAL_KEY}" }
    }
  }
}
```

### Other MCP clients

Any client that supports Streamable HTTP with custom headers works. Point it at `https://<host>/mcp` and send the header `Authorization: Bearer ls_…`.

## 3. Install the skill (how to use LaneSignal)

LaneSignal ships a Claude Code skill that teaches agents **how** to use the tools:
- publishing state, and structuring an alert (escalation)
- waiting for and acknowledging decisions, or dismissing an escalation you answered in the session
- recovering after a restart
- finding and recording the owner's requirements (when they're on)

Claude Code loads it whenever an agent works with LaneSignal. Your LaneSignal server hands it out, matching its [features](configuration.md#features):

```bash
mkdir -p .claude/skills/lanesignal
curl -fsS https://lanesignal.example.com/api/skill -o .claude/skills/lanesignal/SKILL.md
```

Use `~/.claude/skills/lanesignal/` instead to install it for every project on that machine. The source is [`skills/lanesignal/`](../skills/lanesignal/): `SKILL.md`, then `decisions.md` (answering on the dashboard, the default) or `alerts.md` (`LANESIGNAL_DECISIONS=false`), then `requirements.md` when requirements are on. The server joins them. Re-run the command after upgrading LaneSignal or changing its features.

The skill runs long waits in the background over HTTP, and uploads attachments with `curl`. It needs `LANESIGNAL_URL`, `LANESIGNAL_KEY` and `LANESIGNAL_GROUP` (plus `LANESIGNAL_PROJECT` if the key reaches several projects) in the session's environment, for example in the `env` block of `.claude/settings.local.json` (not committed, since it holds the key).

## 4. Set your policy (when to use it)

The skill covers how; **when** is yours to decide. Paste the [policy template](agent-instructions.md) into the overseer's `CLAUDE.md` and edit it: its group, what deserves an escalation, and whether to record requirements.

## Tools

Which tools a client sees depends on its credential (agent keys get the agent tools, personal keys and human sessions the human ones) and on the server's [features](configuration.md#features): the waiting and answering tools exist only with `LANESIGNAL_DECISIONS=true`, the requirement tools only with `LANESIGNAL_REQUIREMENTS` on (the default).

Results are compact JSON with empty fields left out. Escalations come back in brief (code, question, state, and the decision or justification once there is one), lanes as where they stand (status, letter, counts), and `update_lane` and `update_group` don't echo what you sent. `get_escalation` has an escalation in full. Tools that take a group accept `group_id` and `group` alike. Unknown groups and lanes are errors, so a typo never looks like an empty result or creates a lane nobody waits on. Wherever a tool takes an escalation id, it also accepts its code, e.g. `"A12"`.

Every tool takes an optional `project` (id or key). A key bound to one [project](projects.md) never needs it. A key that reaches several must pass it to write, and its listings cover all its projects.

| Tool | Who | Purpose |
|---|---|---|
| `list_projects` | any | The projects the credential reaches (id, key, name) |
| `update_group` | agent | Name the epic/train, set its ticket, link the overseer's Remote Control session |
| `update_lane` | agent | Create or update a lane: status, group, ticket, activity, links. Omitted fields stay unchanged. The group must be registered with `update_group` first. While a blocking escalation is open, the lane stays `blocked_human` |
| `remove_lane` | agent | Take a finished lane off the dashboard (archived; open questions withdrawn; history kept) |
| `create_escalation` | agent | Ask the owner (see the [fields](concepts.md#escalations)): with answering on, `accept_means` / `reject_means` / `allow_reject` say what the answers mean; `attachments` lists uploaded files. The lane must be published first. The same open question on the same lane (ignoring spacing and case) returns the existing one (`duplicate: true`), so retries are safe; the same question as an open FYI, raised without `blocking: false`, makes it blocking and notifies the owner (`upgraded: true`; fields given replace the FYI's). Returns the escalation in brief |
| `notify_owner` | agent | A milestone for the owner ("Merged PR #311", "Starting gh:42"): a quiet push, kept in the lane's history. One line (140 characters), one per lane per minute. Stored even when `LANESIGNAL_NOTIFY_ON` leaves notices out or no push is set up |
| `dismiss_escalation` | agent | Close an alert once it's dealt with (the owner answered in the session, or it's moot), with a required `justification` saying what was decided. `status` and `activity` publish the lane's next state. Only the agent that raised it can dismiss it |
| `get_escalation` | any | Read one escalation in full |
| `add_position` | agent | Decisions on: agree, disagree or stay neutral on an open escalation's recommendation, with a reason |
| `wait_for_decisions` | any | Decisions on: wait on a group, lanes or escalations; returns as soon as one is decided. `wait_seconds` up to 3600 |
| `acknowledge_escalation` | agent | Decisions on: closes a decided escalation and returns the final decision; `status` and `activity` publish the lane's next state. Only the agent that raised it can acknowledge it |
| `list_lanes` / `list_groups` / `list_escalations` | any | Read state. `list_escalations` returns escalations in brief, filtered by `group_id` or `lane_id`, latest 50 by default (`limit` up to 500) |
| `find_requirements` / `get_requirement` / `list_requirement_tags` | any | Search the owner's product decisions before asking again. See [Requirements](requirements.md) |
| `record_requirement` / `supersede_requirement` | any | Record a decision the owner made (citing the escalation or the person), or replace one they changed. `all_projects: true` for decisions that cover every project |
| `export_data` | human | All data for analysis (escalations, positions, lanes, groups, history) as CSV or JSON, paged. See [Export](export.md) |
| `decide_escalation` | human | Decisions on: answer from your own Claude session. `change: true` corrects a decision the agent hasn't acknowledged yet |
| `dismiss_escalation` | human | Dismiss an alert that no longer needs an answer, e.g. its session ended |

## Waiting for decisions

This section applies with answering on the dashboard on (the default). With `LANESIGNAL_DECISIONS=false` you answer in the agent's session and nothing waits.

Answers can take minutes or a day. An overseer waits on its whole group with one call:

- `wait_for_decisions` with `group_id` returns as soon as any escalation in the group is decided, or straight away if one already is. Its result lists `decided` (act on these), `closed` (withdrawn by someone else, e.g. because a human removed the lane), `removedLanes` (lanes someone else took off the dashboard, even with nothing open) and `open`.
- `ready: false` means the wait ran out with nothing new; call again. Decided escalations stay decided until acknowledged, so a dropped call or a server restart loses nothing: call again.
- While an agent waits, its lanes show **agent waiting** on the dashboard. A person answering at hour 20 can see whether the answer reaches someone now.
- During a wait the server sends a notification every 20 seconds (progress, if the client asked for it), so proxies and clients see that the call is alive. Clients that cut calls off after a fixed time (the MCP SDK's default is 60 seconds unless progress resets it) should pass a `wait_seconds` below that and call again.
- Pass the previous result's `checkedAt` as `since`, so a lane removed between two calls is still reported.
- An unknown `group_id` or lane is an error, so a typo doesn't look like "nothing to wait for".

**Long waits.** Most MCP clients give up on a call after a while, and a waiting call keeps a Claude Code session busy, so you can't talk to it through Remote Control. For waits that may last hours, the [skill](#3-install-the-skill-how-to-use-lanesignal) runs the HTTP version, `GET /api/wait`, as a background shell command. It waits up to 24 hours per request, sending a space every 20 seconds so proxies (Cloudflare included) keep the connection open.

If the key is revoked while the agent is waiting, the call fails.
