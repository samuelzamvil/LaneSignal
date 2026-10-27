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

## 3. Install the skill

LaneSignal ships a Claude Code skill that shows agents how the tools fit together, and (in its Usage sections) when to use them:
- publishing state, and structuring an alert (escalation)
- waiting for and acknowledging decisions, or dismissing an escalation you answered in the session
- recovering after a restart
- finding and recording the owner's requirements (when they're on)

Claude Code loads it whenever an agent works with LaneSignal. Your LaneSignal server hands it out, matching its [features](configuration.md#features):

```bash
mkdir -p .claude/skills/lanesignal
curl -fsS https://lanesignal.example.com/api/skill -o .claude/skills/lanesignal/SKILL.md
```

Use `~/.claude/skills/lanesignal/` instead to install it for every project on that machine.

**As a plugin.** This repository is also a Claude Code plugin marketplace, so you can subscribe once and get skill updates with the plugin:

```
/plugin marketplace add samuelzamvil/LaneSignal
/plugin install lanesignal@lanesignal
```

The plugin carries the skill for a server with the default features (answering in LaneSignal and requirements on). If your server turns either off, install the skill from the server instead, as above, since that copy matches its configuration. Update with `/plugin marketplace update lanesignal`.

**Codex** reads skills in the same `SKILL.md` format. Install it from your server into Codex's skills folder: `mkdir -p ~/.codex/skills/lanesignal && curl -fsS https://lanesignal.example.com/api/skill -o ~/.codex/skills/lanesignal/SKILL.md`, and re-run that after upgrading LaneSignal. The source is [`skills/lanesignal/`](../skills/lanesignal/): `SKILL.md`, then `decisions.md` (answering on the dashboard, the default) or `alerts.md` (`LANESIGNAL_DECISIONS=false`), then `requirements.md` when requirements are on. The server joins them. Each part has its Usage section (left out with `?usage=none`); `usage-template.md` is the template for your own. Re-run the command after upgrading LaneSignal or changing its features.

Everything the skill does goes through MCP except long waits, which it runs in the background over HTTP. Those need `LANESIGNAL_URL`, `LANESIGNAL_KEY` and `LANESIGNAL_GROUP` (plus `LANESIGNAL_PROJECT` if the key reaches several projects) in the session's environment, for example in the `env` block of `.claude/settings.local.json` (not committed, since it holds the key).

### The skill is one way to use LaneSignal

LaneSignal is split in two on purpose:

- **The tools say how.** Every agent reads the tool definitions and the server's MCP instructions when it connects. They say what each tool does and takes, and what happens when you call it, never when to call it.
- **The skill says when and why**, in its **Usage** sections: when to publish, what deserves an escalation, when to acknowledge, when to check requirements. The default skill's usage is written for the way LaneSignal's author runs it: one owner, a few overseers, a phone in hand. It's a starting point, not a rule.

If your agents should work differently, write your own usage instead of forking LaneSignal. A skill is easier to keep than a fork, and you keep getting LaneSignal's updates:

1. Get the template: `curl -fsS https://lanesignal.example.com/api/skill/usage-template -o usage.md` (or [`skills/lanesignal/usage-template.md`](../skills/lanesignal/usage-template.md)). Fill in each TODO (each example is the default's choice), and delete its first paragraph and any lines or sections you don't need.
2. Install the skill without the default usage, plus yours:

   ```bash
   mkdir -p .claude/skills/lanesignal
   curl -fsS "https://lanesignal.example.com/api/skill?usage=none" -o .claude/skills/lanesignal/SKILL.md
   cat usage.md >> .claude/skills/lanesignal/SKILL.md
   ```

3. Re-run step 2 after upgrading LaneSignal; your `usage.md` stays yours.

The plugin always carries the default usage, so install from the server this way instead of the plugin.

## 4. Set your policy (per project)

Whichever usage you install, each overseer's `CLAUDE.md` says what's specific to it. Paste the [policy template](agent-instructions.md) there and edit it: its group, what deserves an escalation in this project, and whether to record requirements. The policy overrides the skill's usage where they differ.

## Tools

Which tools a client sees depends on its credential (agent keys get the agent tools, personal keys and human sessions the human ones) and on the server's [features](configuration.md#features): the waiting and answering tools exist only with `LANESIGNAL_DECISIONS=true`, the requirement tools only with `LANESIGNAL_REQUIREMENTS` on (the default).

Results are compact JSON with empty fields left out (a lane's `project`, too, when the key reaches one project). The server's MCP instructions carry the conventions every tool shares (`project`, escalation codes, `group`/`group_id`), once per session, and the advertised schemas leave out limits that are only validation; every argument is still checked in full. Escalations come back in brief (code, question, state, and the decision or justification once there is one), lanes as where they stand (status, letter, counts), and `update_lane` and `update_group` don't echo what you sent. `get_escalation` has an escalation in full. Tools that take a group accept `group_id` and `group` alike. Unknown groups, lanes and attachments are errors, so a typo never looks like an empty result or creates a lane nobody waits on. Wherever a tool takes an escalation id, it also accepts its code, e.g. `"A12"`.

Every tool takes an optional `project` (id or key). A key bound to one [project](projects.md) never needs it. A key that reaches several must pass it to write, and its listings cover all its projects.

| Tool | Who | Purpose |
|---|---|---|
| `list_projects` | any | The projects the credential reaches (id, key, name) |
| `update_group` | agent | Name the group and link the overseer's Remote Control session. Its epic's ticket goes in `update_epic`: a `ticket` passed here is ignored, with a `warning` saying so |
| `update_lane` | agent | Create or update a lane: status, group, ticket, activity, links, `waiting_on`. Omitted fields stay unchanged. The group must be registered with `update_group` first; a new lane published without one joins the project's "Ungrouped" group. A lane holding no ticket shows `idle` whatever status is published (the result says so in `warning`). While a blocking escalation is open, the lane stays `blocked_human`. `completed` finishes the lane's ticket and empties the lane; a different `ticket` parks the one it held (use `fill_lane` instead). The owner's notes on the lane the agent hasn't seen come back in `ownerMessages` ([lane conversations](concepts.md#lane-conversations)) |
| `fill_lane` | agent | Move a lane to another [ticket](concepts.md#tickets) in one call: `previous` says what happens to the one it holds (`park` with a `reason`, `done` or `drop`), `ticket` moves in (created on first use; a parked one comes back with its questions). `epic` names the [epic](concepts.md#epics) the ticket is for (its ref, or the group's id; `null` clears it), so the lane is listed under that epic's card. Also takes `update_lane`'s fields |
| `remove_lane` | agent | Take a lane off the dashboard (archived; history kept). Its ticket is done if the lane was completed, otherwise parked, unless `previous` says otherwise; it keeps its questions |
| `list_tickets` / `get_ticket` | any | The tickets lanes hold and the parked ones (`state` for others); one ticket by any form of its ref, with its escalations, history and the lanes it passed through |
| `create_escalation` | agent | Ask the owner (see the [fields](concepts.md#escalations)). Raised on a lane holding a ticket, it's the ticket's and blocks that lane; on a lane holding no ticket, it goes to the group's epic (`epic` says which when the group has several). With `epic` and no `lane_id`, it's raised on the epic directly, for durable questions (direction, scope, which tickets to file). An epic's questions block no lane. With answering on, `accept_means` / `reject_means` / `allow_reject` say what the answers mean; `attachments` lists uploaded files. The lane must be published first. The same open question on the same ticket or epic (ignoring spacing and case) returns the existing one (`duplicate: true`), so retries are safe; the same question as an open FYI, raised without `blocking: false`, makes it blocking and notifies the owner (`upgraded: true`; fields given replace the FYI's, and new attachments are added). Returns the escalation in brief |
| `notify_owner` | agent | Write to the owner in the lane's conversation: a milestone ("Merged PR #311", "Starting gh:42"), with any files in `attachments`. A quiet push that opens the lane. At most 500 characters, one per lane per minute (a retry of the same text returns the first). Stored even when `LANESIGNAL_NOTIFY_ON` leaves notices out or no push is set up. Returns the owner's unseen notes on the lane in `ownerMessages` |
| `list_epics` | any | The groups' [epics](concepts.md#epics): status line, open questions, unread notes on the board. `epic` in each is how to name it in other tools (its ref, or the group's id for a group standing in as its epic) |
| `update_epic` | agent | Set an epic's `status_line` (one line on its card, instead of placeholder lanes), `name`, `ref` or `links`. A ref no epic has yet, with `group`, adds that epic to the group (so does giving a group's stand-in a `ref`). Returns the epic, with the owner's unseen board notes in `ownerMessages` |
| `notify_epic` | agent | Write on an epic's message board, with any files in `attachments`: a quiet push that opens the epic. At most 500 characters, one per epic per minute. Returns the owner's unseen board notes in `ownerMessages` |
| `request_epic_close` | agent | Ask a person to close an epic whose work is over, with a `reason`; they approve or decline in the app. Refused while it has open questions, or answered ones not yet acknowledged |
| `dismiss_escalation` | agent | Close an alert once it's dealt with (the owner answered in the session, or it's moot), with a required `justification` saying what was decided. `status` and `activity` publish the lane's next state. Only the agent that raised it can dismiss it, or the overseer of the group its ticket (or epic) is in now |
| `get_escalation` | any | Read one escalation in full |
| `upload_attachment` | any | Upload a file to attach: `name`, `type` and `content` (the text of a Markdown or text file, an image in base64). The same checks as `POST /api/attachments` (type recognised by content, `LANESIGNAL_ATTACHMENT_MAX_MB`); returns the same `{id, name, type, size}`. Pass the id in `attachments` within a day, from the same key |
| `get_attachment` | any | Read a file by id: `name`, `type`, `size` and, for a Markdown or text file, its `content`. An image comes back as an MCP image block beside that, so the model sees it; one too large for a model (over 3.75 MB or 8000 px a side) comes back as a `note` instead. Readable by the same callers as `GET /api/attachments/:id` |
| `add_position` | agent | Decisions on: agree, disagree or stay neutral on an open escalation's recommendation, with a reason |
| `wait_for_decisions` | any | Decisions on: wait on a group, lanes or escalations. Returns a digest of what needs you (decisions, the owner's Other answers, lane and epic board notes, withdrawals, removed lanes) as soon as there is any, with counts of the rest. `wait_seconds` up to 3600; `format: "full"` for the older shape |
| `get_updates` | any | Decisions on: everything in scope that involves you, without waiting (open, decided, replies, unread lane and board notes). For after a restart, or when you've lost track |
| `reply_to_escalation` | agent | Decisions on: write in an open escalation's conversation, at most 500 characters (attach files for more): a reply after the owner's Other, or a short update while they decide. Notifies the owner. Only the agent that raised it, or the overseer of the group its ticket (or epic) is in now |
| `acknowledge_escalation` | agent | Decisions on: closes a decided escalation (or one the owner answered Other, taking their latest messages as the decision; acknowledge instead of replying when you'll act on them, though it still works after a reply) and returns the final decision; `status` and `activity` publish the lane's next state. Only the agent that raised it can acknowledge it, or the overseer of the group its ticket (or epic) is in now |
| `list_lanes` / `list_groups` / `list_escalations` | any | Read state. `list_escalations` returns escalations in brief, filtered by `group_id` or `lane_id`, latest 50 by default (`limit` up to 500) |
| `find_requirements` / `get_requirement` / `list_products` | any | Everything that applies to the products you name (plus project-wide and global ones) in one call, without justification; one requirement with its justification on request; the products. See [Requirements](requirements.md) |
| `record_requirement` / `supersede_requirement` | any | Record a decision the owner made (citing the escalation or the person) with its scope (`products`, `project` or `global`), or replace one they changed |
| `export_data` | human | All data for analysis (escalations, positions, escalation and lane conversations, lanes, groups, tickets, epics and their boards, history, requirements) as CSV or JSON, paged. See [Export](export.md) |
| `decide_escalation` | human | Decisions on: answer from your own Claude session. `change: true` corrects a decision the agent hasn't acknowledged yet |
| `dismiss_escalation` | human | Dismiss an alert that no longer needs an answer, e.g. its session ended |

## Waiting for decisions

This section applies with answering on the dashboard on (the default). With `LANESIGNAL_DECISIONS=false` you answer in the agent's session and nothing waits.

Answers can take minutes or a day. An overseer waits on its whole group with one call:

- `wait_for_decisions` with `group_id` returns a **digest** as soon as anything in the group needs the agent. It waits for a change even when nothing is open, so one loop covers the whole session:
  - `items`, one per thing to handle, `{code, kind, text}` for an escalation (`code` with its project key when the key reaches several projects) or `{kind, id, text}` for the lane, ticket or epic an item is about, and `text` the owner's words in full (the agent's own text is left out). Kinds:
    - `decided`: answered; `text` is the answer and any instructions ("Accept: ship it Friday")
    - `reply`: the owner answered Other; `text` is what they wrote since the agent last did
    - `closed`: withdrawn by someone else; `text` says how
    - `lane_removed`: a lane someone else took off the dashboard, even with nothing open (`id` is the lane)
    - `lane_note`: the owner wrote on a lane in scope, outside any escalation (`id` is the lane)
    - `ticket_moved`: a lane outside the scope (usually another overseer's) took a ticket from one of these lanes (`id` is the ticket)
    - `board_note`: on a group wait, someone wrote on one of the group's epics' boards (`id` names the epic)
  - Files the owner attached are named in `text` with their id ("[attached: plan.md (id …)]"): read one with `get_attachment` (or `GET /api/attachments/:id`).
  - `decided` and `reply` come back on every wait until the agent acknowledges or replies. The others come back once per `since`, and again if the agent repeats a `since`, so a wait that crashed before acting loses nothing. With a `since`, the digest depends on nothing else (whether a note was handed over doesn't matter).
  - `counts`: `open` (waiting on the owner), `decidedUnacknowledged` and `waitingOnYou` (replies); left out when all are zero.
- `ready: true` means there are items. `ready: false` means the wait ran out with nothing new: call again.
- A group wait also covers the group's [epics](concepts.md#epics): their questions, and people's notes on their boards.
- `get_updates` returns the whole picture without waiting: open escalations, decided ones, replies, unread notes (`laneMessages`, and on a group, `boardMessages`). Use it after a restart, or if `counts` show something the digest doesn't.
- `format: "full"` returns the older shape (`decided`, `replies`, `closed`, `open`, `removedLanes`, `laneMessages`, plus `boardMessages`), which also returns at once when nothing is open. It's kept for agents written against it.
- While an agent waits, its lanes show **agent waiting** on the dashboard. A person answering at hour 20 can see whether the answer reaches someone now.
- During a wait the server sends a notification every 20 seconds (progress, if the client asked for it), so proxies and clients see that the call is alive. Clients that cut calls off after a fixed time (the MCP SDK's default is 60 seconds unless progress resets it) should pass a `wait_seconds` below that and call again.
- Pass the previous result's `checkedAt` as `since`, so what changed between two calls is still reported.
- An unknown `group_id` or lane is an error, so a typo doesn't look like "nothing to wait for".

**Long waits.** Most MCP clients give up on a call after a while, and a waiting call keeps a Claude Code session busy, so you can't talk to it through Remote Control. For waits that may last hours, the [skill](#3-install-the-skill) runs the HTTP version, `GET /api/wait`, as a background shell command. It waits up to 24 hours per request, sending a space every 20 seconds so proxies (Cloudflare included) keep the connection open.

If the key is revoked while the agent is waiting, the call fails.
